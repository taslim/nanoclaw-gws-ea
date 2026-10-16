/**
 * Host-generated credentials, made durable before any website sees them
 * (KTD6). One row per operation holds its binding (browser job, assistant
 * instance, 1Password account and vault, website origin, registrable site and
 * username), a password change's source Login and version, the candidate
 * saved for it, and the phase it reached:
 *
 *   preparing → saved → exposed → awaiting_verification → confirmed → finalized
 *   exposed | awaiting_verification → unknown → confirmed | rejected
 *   unknown → awaiting_verification, when the site's late response asks for email verification
 *   awaiting_verification → rejected;  confirmed → conflict → finalized
 *   preparing | saved → rejected, when abandoned before any disclosure
 *   unknown | awaiting_verification | conflict → rejected, when the principal releases it
 *
 * Passwords live only in 1Password and this process's memory: rows, results,
 * errors and logs carry identifiers and constant reasons. Each operation
 * issues at most one create, tagged with its own marker; a lost response is
 * reconciled by that marker, never by creating again. A finalized row is the
 * ownership record R18 relies on. Provider calls never run inside a DB
 * transaction, and every phase moves by compare-and-set.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isUniqueViolation } from '../../db/errors.js';
import { hasControlCharacters, isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { httpsOrigin } from './authentication-signatures.js';
import {
  active,
  browserVault,
  BrowserVaultError,
  credentialCandidateTag,
  generateCandidatePassword,
  registrableDomain,
  type BrowserVault,
  type BrowserVaultBinding,
  type BrowserVaultReason,
  type VaultCandidateSpec,
  type VaultItemRead,
  vaultFailureStatus,
} from './onepassword.js';

/**
 * Whether a confirmed password change updates the original Login itself.
 * Off until live acceptance shows 1Password refuses a stale versioned write
 * (KTD8): until then a confirmed change stops at a `promotion_disabled`
 * conflict that keeps both credentials, and finalizes once the original holds
 * the new password.
 */
export const ONEPASSWORD_AUTOMATIC_PROMOTION = false;

export type CredentialAttemptKind = 'signup' | 'rotation';
export type CredentialAttemptPhase =
  | 'preparing'
  | 'saved'
  | 'exposed'
  | 'awaiting_verification'
  | 'unknown'
  | 'rejected'
  | 'confirmed'
  | 'finalized'
  | 'conflict';
export type CredentialConflictReason =
  | 'ownership_mismatch'
  | 'password_changed'
  | 'concurrent_edit'
  | 'promotion_disabled';

/**
 * The phases only the principal's informed decision can end once the host
 * cannot settle them: whether the website took the credential is unknown, its
 * email verification never completed, or the vault could not take over a
 * change the website confirmed.
 */
export const RELEASABLE_PHASES: readonly CredentialAttemptPhase[] = ['unknown', 'awaiting_verification', 'conflict'];

/** One operation's durable record: identifiers, references and phase, never a value. */
export interface CredentialAttempt {
  readonly id: string;
  readonly kind: CredentialAttemptKind;
  readonly job_id: string;
  readonly instance_id: string;
  readonly account_id: string;
  readonly vault_id: string;
  /** The exact HTTPS origin the operation was delegated for. */
  readonly origin: string;
  /** Its registrable domain: the site the account, and any ownership record, belong to. */
  readonly site: string;
  readonly username: string;
  /** A password change's original Login, and its version when the candidate was saved. */
  readonly source_item_id: string | null;
  readonly source_version: number | null;
  readonly candidate_item_id: string | null;
  readonly candidate_version: number | null;
  readonly phase: CredentialAttemptPhase;
  /** When the one create this operation may issue was sent; it is never sent again. */
  readonly save_started_at: string | null;
  readonly conflict_reason: CredentialConflictReason | null;
  readonly evidence_json: string | null;
  /** Set on finalizing: the Login the host saved, owned while its username and site still match this row. */
  readonly owned_item_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly exposed_at: string | null;
  readonly finalized_at: string | null;
}

/** What the browser job verified, flat and bounded: never page text, never a value. */
export type CredentialEvidence = Readonly<Record<string, string | number | boolean | null>>;

/** Values for one disclosure, in host memory only: never a tool result, row or log. */
export interface CandidateCredential {
  readonly username: string;
  readonly password: string;
  /** For a password change, the original Login's current password, read fresh. */
  readonly currentPassword?: string;
}

type VaultFailure = { readonly status: 'vault_unavailable' } | { readonly status: 'rate_limited' };
type Refused<Reason extends string> = { readonly status: 'refused'; readonly reason: Reason };
type Saved = { readonly status: 'saved'; readonly attempt: CredentialAttempt };

export type CredentialPrepareResult =
  | { readonly status: 'prepared'; readonly attempt: CredentialAttempt }
  | { readonly status: 'not_owned' }
  | { readonly status: 'busy' }
  | { readonly status: BrowserVaultReason };
export type CredentialSaveResult =
  | Saved
  | { readonly status: 'outcome_unknown' }
  | { readonly status: 'not_owned' }
  | Refused<'not_preparing' | 'reconcile_first' | 'candidate_mismatch'>
  | VaultFailure;
export type CredentialReconcileResult =
  | Saved
  | { readonly status: 'absent' }
  | { readonly status: 'ambiguous' }
  | Refused<'not_preparing' | 'candidate_mismatch'>
  | VaultFailure;
export type CredentialDisclosure =
  | { readonly status: 'disclosed'; readonly credential: CandidateCredential }
  | Refused<'not_saved' | 'wrong_job' | 'origin_mismatch' | 'not_owned' | 'source_changed' | 'candidate_mismatch'>
  | VaultFailure;
export type CredentialFinalizeResult =
  | { readonly status: 'finalized'; readonly attempt: CredentialAttempt }
  | { readonly status: 'conflict'; readonly reason: CredentialConflictReason; readonly attempt: CredentialAttempt }
  | Refused<'not_confirmed' | 'candidate_mismatch'>
  | VaultFailure;
export type CredentialOwnership =
  | { readonly status: 'owned' }
  | { readonly status: 'not_owned'; readonly reason: 'no_record' | 'changed' }
  | { readonly status: BrowserVaultReason };

export class CredentialAttemptError extends Error {
  constructor(readonly reason: 'not_found' | 'invalid_phase' | 'invalid_request') {
    super(reason);
  }
}

interface CandidateSecret {
  readonly password: string;
  readonly previousPassword: string | undefined;
}

const TABLE = 'gws_ea_browser_credential_attempts';
const EVIDENCE_KEY = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_EVIDENCE_ENTRIES = 16;
const MAX_EVIDENCE_TEXT = 200;
const MAX_JOB_ID = 512;
export const MAX_USERNAME = 256;
const now = (): string => new Date().toISOString();
const refused = <Reason extends string>(reason: Reason): Refused<Reason> => ({ status: 'refused', reason });

/** A provider step's value, or its bounded failure; any other error is the caller's own and passes through. */
async function provider<T>(step: Promise<T>): Promise<{ readonly value: T } | VaultFailure> {
  try {
    return { value: await step };
  } catch (error) {
    if (!(error instanceof BrowserVaultError)) throw error;
    return { status: vaultFailureStatus(error) };
  }
}

/** One plain line: non-empty, bounded, with no surrounding whitespace or control characters. */
export function line(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !hasControlCharacters(value)
  );
}

/** R18: the Login still names the account and the site its record saved. */
function ownershipHolds(record: Pick<CredentialAttempt, 'username' | 'site'>, read: VaultItemRead): boolean {
  return read.category === 'login' && read.username === record.username && read.domains.includes(record.site);
}

/** The candidate's values, if the item still is what this attempt saved: its kind, account and site. */
function candidateSecret(attempt: CredentialAttempt, read: VaultItemRead): CandidateSecret | undefined {
  const { password, previousPassword } = read;
  if (password === undefined || read.username !== attempt.username) return undefined;
  if (attempt.kind === 'signup')
    return read.category === 'login' && read.domains.includes(attempt.site)
      ? { password, previousPassword: undefined }
      : undefined;
  return read.category === 'password' && previousPassword !== undefined ? { password, previousPassword } : undefined;
}

export interface CredentialAttemptsOptions {
  readonly db?: DbDriver;
  readonly vault?: BrowserVault;
  /** Defaults to `ONEPASSWORD_AUTOMATIC_PROMOTION`. */
  readonly automaticPromotion?: boolean;
}

/**
 * The host's credential attempts. One instance holds this process's memory of
 * generated values; a new instance, like a restart, recovers them from the
 * candidates in 1Password.
 */
export class CredentialAttempts {
  private readonly secrets = new Map<string, CandidateSecret>();
  private readonly vault: BrowserVault;
  private readonly automaticPromotion: boolean;

  constructor(private readonly options: CredentialAttemptsOptions = {}) {
    this.vault = options.vault ?? browserVault;
    this.automaticPromotion = options.automaticPromotion ?? ONEPASSWORD_AUTOMATIC_PROMOTION;
  }

  private get db(): DbDriver {
    return this.options.db ?? getDb();
  }

  get(id: string): Promise<CredentialAttempt | undefined> {
    return this.db.get<CredentialAttempt>(`SELECT * FROM ${TABLE} WHERE id = ?`, id);
  }

  private async require(id: string): Promise<CredentialAttempt> {
    const attempt = await this.get(id);
    if (!attempt) throw new CredentialAttemptError('not_found');
    return attempt;
  }

  /** Every attempt not yet rejected or finalized, oldest first: what recovery resumes after a restart. */
  unresolved(): Promise<CredentialAttempt[]> {
    return this.db.all<CredentialAttempt>(
      `SELECT * FROM ${TABLE} WHERE phase NOT IN ('rejected','finalized') ORDER BY created_at, id`,
    );
  }

  /** An item's ownership record: the latest finalized attempt that saved it. Edits in 1Password never touch it. */
  private record(vaultId: string, itemId: string): Promise<CredentialAttempt | undefined> {
    return this.db.get<CredentialAttempt>(
      `SELECT * FROM ${TABLE} WHERE vault_id = ? AND owned_item_id = ? AND phase = 'finalized'
       ORDER BY finalized_at DESC, id DESC LIMIT 1`,
      vaultId,
      itemId,
    );
  }

  private async listedItem(
    itemHandle: string,
    origin: string,
    assertActive: () => Promise<void>,
  ): Promise<{ readonly vaultId: string; readonly itemId: string } | { readonly status: BrowserVaultReason }> {
    try {
      return await this.vault.itemForHandle(itemHandle, origin, assertActive);
    } catch (error) {
      if (!(error instanceof BrowserVaultError)) throw error;
      return { status: error.reason };
    }
  }

  /**
   * R18: whether the Login behind a listed handle is one this host saved, and
   * still has the username and site it saved for this origin's site. Without a
   * record it spends no provider request; with one, a single fresh read.
   */
  async ownership(itemHandle: string, origin: string, assertActive = active): Promise<CredentialOwnership> {
    const item = await this.listedItem(itemHandle, origin, assertActive);
    if ('status' in item) return item;
    const record = await this.record(item.vaultId, item.itemId);
    if (!record || record.site !== registrableDomain(origin)) return { status: 'not_owned', reason: 'no_record' };
    const read = await provider(this.vault.readItem(item.vaultId, item.itemId, assertActive));
    if (!('value' in read)) return read;
    return ownershipHolds(record, read.value) ? { status: 'owned' } : { status: 'not_owned', reason: 'changed' };
  }

  /**
   * Main's delegation names an account, not a handle: the listed Login this
   * host saved for the origin's site under that username, found from the
   * listing and local records alone. `ownership` then checks it fresh.
   */
  async ownedHandle(
    origin: string,
    username: string,
    assertActive = active,
  ): Promise<
    { readonly status: 'found'; readonly itemHandle: string } | { readonly status: 'not_owned' } | VaultFailure
  > {
    const site = registrableDomain(origin);
    if (!site) return { status: 'not_owned' };
    const listed = await provider(this.vault.itemsForOrigin(origin, assertActive));
    if (!('value' in listed)) return listed;
    for (const { item_handle: itemHandle } of listed.value) {
      const item = await this.listedItem(itemHandle, origin, assertActive);
      if ('status' in item) continue;
      const record = await this.record(item.vaultId, item.itemId);
      if (record?.site === site && record.username === username) return { status: 'found', itemHandle };
    }
    return { status: 'not_owned' };
  }

  private target(jobId: string, origin: string): { readonly origin: string; readonly site: string } {
    const url = httpsOrigin(origin);
    const site = url && registrableDomain(url.origin);
    if (!line(jobId, MAX_JOB_ID) || !url || !site) throw new CredentialAttemptError('invalid_request');
    return { origin: url.origin, site };
  }

  private async insert(
    kind: CredentialAttemptKind,
    jobId: string,
    binding: BrowserVaultBinding,
    target: { readonly origin: string; readonly site: string },
    username: string,
    sourceItemId: string | null,
  ): Promise<CredentialAttempt> {
    const id = randomUUID();
    const at = now();
    await this.db.run(
      `INSERT INTO ${TABLE}(id,kind,job_id,instance_id,account_id,vault_id,origin,site,username,source_item_id,phase,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,'preparing',?,?)`,
      id,
      kind,
      jobId,
      binding.instanceId,
      binding.accountId,
      binding.vaultId,
      target.origin,
      target.site,
      username,
      sourceItemId,
      at,
      at,
    );
    return this.require(id);
  }

  /** Records an authorized signup's binding. Nothing is generated or saved yet, and no provider request is spent. */
  async prepareSignup(input: {
    readonly jobId: string;
    readonly origin: string;
    readonly username: string;
  }): Promise<{ readonly status: 'prepared'; readonly attempt: CredentialAttempt } | VaultFailure> {
    const target = this.target(input.jobId, input.origin);
    if (!line(input.username, MAX_USERNAME)) throw new CredentialAttemptError('invalid_request');
    const availability = await this.vault.availability();
    if (availability.status !== 'available') return { status: 'vault_unavailable' };
    return {
      status: 'prepared',
      attempt: await this.insert('signup', input.jobId, availability.binding, target, input.username, null),
    };
  }

  /**
   * Records an authorized change of a listed Login's password, which needs an
   * ownership record for this origin's site (R18). One change per Login is
   * open at a time: another job's change that disclosed nothing gives way and
   * its candidate is retired, while one that may have reached the site keeps
   * the Login busy. The Login's current state is checked fresh when the
   * candidate is saved and again right before disclosure.
   */
  async prepareRotation(
    input: { readonly jobId: string; readonly origin: string; readonly itemHandle: string },
    assertActive = active,
  ): Promise<CredentialPrepareResult> {
    const target = this.target(input.jobId, input.origin);
    const availability = await this.vault.availability();
    if (availability.status !== 'available') return { status: 'vault_unavailable' };
    const item = await this.listedItem(input.itemHandle, target.origin, assertActive);
    if ('status' in item) return item;
    if (item.vaultId !== availability.binding.vaultId) return { status: 'vault_unavailable' };
    const record = await this.record(item.vaultId, item.itemId);
    if (!record || record.site !== target.site) return { status: 'not_owned' };
    const open = await this.db.get<CredentialAttempt>(
      `SELECT * FROM ${TABLE} WHERE vault_id = ? AND source_item_id = ? AND phase NOT IN ('rejected','finalized')`,
      item.vaultId,
      item.itemId,
    );
    if (open) {
      // An idle job's unused authority would otherwise hold the Login forever: the sweep never abandons it.
      const abandoned =
        open.job_id !== input.jobId && (open.phase === 'preparing' || open.phase === 'saved')
          ? await this.undisclosed(open.id)
          : undefined;
      if (!abandoned) return { status: 'busy' };
      log.info('Credential change gave way to a later job', { attemptId: open.id });
      await this.retire(abandoned, assertActive);
    }
    try {
      return {
        status: 'prepared',
        attempt: await this.insert('rotation', input.jobId, availability.binding, target, record.username, item.itemId),
      };
    } catch (error) {
      if (isUniqueViolation(error)) return { status: 'busy' };
      throw error;
    }
  }

  /** A change's original Login, read fresh, while it still matches its ownership record. */
  private async ownedSource(
    attempt: CredentialAttempt,
    assertActive: () => Promise<void>,
  ): Promise<
    | { readonly status: 'owned'; readonly read: VaultItemRead; readonly password: string }
    | { readonly status: 'not_owned' }
    | VaultFailure
  > {
    if (attempt.source_item_id === null) return { status: 'not_owned' };
    const record = await this.record(attempt.vault_id, attempt.source_item_id);
    if (!record || record.username !== attempt.username || record.site !== attempt.site) return { status: 'not_owned' };
    const read = await provider(this.vault.readItem(attempt.vault_id, attempt.source_item_id, assertActive));
    if (!('value' in read)) return read;
    const { password } = read.value;
    return ownershipHolds(record, read.value) && password !== undefined
      ? { status: 'owned', read: read.value, password }
      : { status: 'not_owned' };
  }

  /**
   * Generates the password and saves the candidate, then proves it can be read
   * back with exactly that value. Only a proven candidate can ever be
   * disclosed. Once the create may have been sent, any failure leaves the
   * attempt to `reconcileSave`: it is never sent again.
   */
  async save(id: string, assertActive = active): Promise<CredentialSaveResult> {
    const attempt = await this.require(id);
    if (attempt.phase !== 'preparing') return refused('not_preparing');
    if (attempt.save_started_at !== null) return refused('reconcile_first');
    let source: { readonly version: number; readonly password: string } | undefined;
    if (attempt.kind === 'rotation') {
      const owned = await this.ownedSource(attempt, assertActive);
      if (owned.status !== 'owned') return owned;
      source = { version: owned.read.version, password: owned.password };
    }
    const password = await generateCandidatePassword();
    const common = {
      vaultId: attempt.vault_id,
      operationId: attempt.id,
      site: attempt.site,
      username: attempt.username,
      password,
    };
    const spec: VaultCandidateSpec = source
      ? { ...common, kind: 'rotation', previousPassword: source.password }
      : { ...common, kind: 'signup', origin: attempt.origin };
    let issued = false;
    const claim = async (): Promise<void> => {
      const at = now();
      const changed = await this.db.run(
        `UPDATE ${TABLE} SET save_started_at = ?, source_version = ?, updated_at = ?
         WHERE id = ? AND phase = 'preparing' AND save_started_at IS NULL`,
        at,
        source?.version ?? null,
        at,
        id,
      );
      if (!changed.changes) throw new CredentialAttemptError('invalid_phase');
      issued = true;
      this.secrets.set(id, { password, previousPassword: source?.password });
    };
    let created: { readonly itemId: string; readonly version: number };
    try {
      created = await this.vault.createCandidate(spec, claim, assertActive);
    } catch (error) {
      if (!(error instanceof BrowserVaultError)) throw error;
      const status = vaultFailureStatus(error);
      if (!issued) return { status };
      log.warn('Credential candidate save has an unknown outcome', { attemptId: id, reason: status });
      return status === 'rate_limited' ? { status } : { status: 'outcome_unknown' };
    }
    await this.db.run(
      `UPDATE ${TABLE} SET candidate_item_id = ?, candidate_version = ?, updated_at = ?
       WHERE id = ? AND phase = 'preparing' AND candidate_item_id IS NULL`,
      created.itemId,
      created.version,
      now(),
      id,
    );
    return this.verify(id, created.itemId, assertActive);
  }

  /**
   * Settles a save whose outcome was not proven: the recorded candidate is
   * read back, or the vault is searched for this operation's exact marker.
   * `absent` means nothing carries it now; `ambiguous` means several items do.
   * Neither ever creates another item.
   */
  async reconcileSave(id: string, assertActive = active): Promise<CredentialReconcileResult> {
    const attempt = await this.require(id);
    if (attempt.phase === 'saved') return { status: 'saved', attempt };
    if (attempt.phase !== 'preparing') return refused('not_preparing');
    if (attempt.save_started_at === null) return { status: 'absent' };
    if (attempt.candidate_item_id !== null) return this.verify(id, attempt.candidate_item_id, assertActive);
    const found = await provider(this.vault.findCandidates(attempt.vault_id, id, assertActive));
    if (!('value' in found)) return found;
    if (found.value.length === 0) return { status: 'absent' };
    if (found.value.length > 1) {
      log.warn('Several vault items carry one credential attempt marker', { attemptId: id, count: found.value.length });
      return { status: 'ambiguous' };
    }
    const [itemId] = found.value;
    await this.db.run(
      `UPDATE ${TABLE} SET candidate_item_id = ?, updated_at = ? WHERE id = ? AND phase = 'preparing' AND candidate_item_id IS NULL`,
      itemId,
      now(),
      id,
    );
    return this.verify(id, itemId, assertActive);
  }

  private async verify(
    id: string,
    itemId: string,
    assertActive: () => Promise<void>,
  ): Promise<Saved | Refused<'candidate_mismatch'> | VaultFailure> {
    const attempt = await this.require(id);
    const read = await provider(this.vault.readItem(attempt.vault_id, itemId, assertActive));
    if (!('value' in read)) return read;
    const secret = candidateSecret(attempt, read.value);
    const generated = this.secrets.get(id);
    if (
      !secret ||
      !read.value.tags.includes(credentialCandidateTag(id)) ||
      (generated && (generated.password !== secret.password || generated.previousPassword !== secret.previousPassword))
    ) {
      log.warn('Credential candidate does not match its attempt', { attemptId: id });
      return refused('candidate_mismatch');
    }
    const changed = await this.db.run(
      `UPDATE ${TABLE} SET phase = 'saved', candidate_item_id = ?, candidate_version = ?, updated_at = ?
       WHERE id = ? AND phase = 'preparing' AND (candidate_item_id IS NULL OR candidate_item_id = ?)`,
      itemId,
      read.value.version,
      now(),
      id,
      itemId,
    );
    if (!changed.changes) throw new CredentialAttemptError('invalid_phase');
    this.secrets.set(id, secret);
    return { status: 'saved', attempt: await this.require(id) };
  }

  /** The candidate's values: from this process's memory, or else one read of the recorded candidate. */
  private async candidate(
    attempt: CredentialAttempt,
    assertActive: () => Promise<void>,
  ): Promise<{ readonly secret: CandidateSecret } | { readonly status: 'mismatch' } | VaultFailure> {
    const remembered = this.secrets.get(attempt.id);
    if (remembered) return { secret: remembered };
    if (attempt.candidate_item_id === null) return { status: 'mismatch' };
    const read = await provider(this.vault.readItem(attempt.vault_id, attempt.candidate_item_id, assertActive));
    if (!('value' in read)) return read;
    const secret = candidateSecret(attempt, read.value);
    if (!secret) return { status: 'mismatch' };
    this.secrets.set(attempt.id, secret);
    return { secret };
  }

  /**
   * The only way to obtain a saved candidate's value. It records possible
   * disclosure (`exposed`) before returning anything, so the caller may insert
   * the value only after this resolves. A change also returns the original
   * Login's current password, read fresh and refused if it no longer matches
   * its ownership record or the password the candidate replaces. While the
   * operator has 1Password disabled nothing is disclosed: the attempt stays
   * saved, its candidate kept for when it is enabled again.
   */
  async disclose(
    id: string,
    binding: { readonly jobId: string; readonly origin: string },
    assertActive = active,
  ): Promise<CredentialDisclosure> {
    const attempt = await this.require(id);
    if (attempt.job_id !== binding.jobId) return refused('wrong_job');
    if (attempt.phase !== 'saved' && attempt.phase !== 'exposed') return refused('not_saved');
    if (registrableDomain(binding.origin) !== attempt.site) return refused('origin_mismatch');
    const candidate = await this.candidate(attempt, assertActive);
    if (!('secret' in candidate)) return candidate.status === 'mismatch' ? refused('candidate_mismatch') : candidate;
    let currentPassword: string | undefined;
    if (attempt.kind === 'rotation') {
      const owned = await this.ownedSource(attempt, assertActive);
      if (owned.status === 'not_owned') return refused('not_owned');
      if (owned.status !== 'owned') return owned;
      if (owned.password !== candidate.secret.previousPassword) return refused('source_changed');
      currentPassword = owned.password;
    }
    // A remembered value needs no provider request, so only the operator's published disable can stop it here.
    const availability = await this.vault.availability();
    if (
      availability.status !== 'available' ||
      availability.binding.vaultId !== attempt.vault_id ||
      availability.binding.accountId !== attempt.account_id
    )
      return { status: 'vault_unavailable' };
    await assertActive();
    const at = now();
    const changed = await this.db.run(
      `UPDATE ${TABLE} SET phase = 'exposed', exposed_at = COALESCE(exposed_at, ?), updated_at = ?
       WHERE id = ? AND job_id = ? AND phase IN ('saved','exposed')`,
      at,
      at,
      id,
      binding.jobId,
    );
    if (!changed.changes) return refused('not_saved');
    return {
      status: 'disclosed',
      credential: {
        username: attempt.username,
        password: candidate.secret.password,
        ...(currentPassword === undefined ? {} : { currentPassword }),
      },
    };
  }

  private evidenceJson(id: string, evidence: CredentialEvidence): string {
    const secret = this.secrets.get(id);
    const known = secret ? [secret.password, secret.previousPassword].filter((value) => value !== undefined) : [];
    const entries = isRecord(evidence) ? Object.entries(evidence) : [];
    const acceptable = (value: unknown): boolean =>
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' &&
        value.length <= MAX_EVIDENCE_TEXT &&
        !hasControlCharacters(value) &&
        !known.some((password) => value.includes(password)));
    if (
      !isRecord(evidence) ||
      entries.length > MAX_EVIDENCE_ENTRIES ||
      entries.some(([key, value]) => !EVIDENCE_KEY.test(key) || !acceptable(value))
    )
      throw new CredentialAttemptError('invalid_request');
    return JSON.stringify(evidence);
  }

  private async move(
    id: string,
    from: readonly CredentialAttemptPhase[],
    to: CredentialAttemptPhase,
    evidence?: CredentialEvidence,
  ): Promise<CredentialAttempt> {
    const json = evidence === undefined ? null : this.evidenceJson(id, evidence);
    const changed = await this.db.run(
      `UPDATE ${TABLE} SET phase = ?, evidence_json = COALESCE(?, evidence_json), updated_at = ?
       WHERE id = ? AND phase IN (${from.map(() => '?').join(',')})`,
      to,
      json,
      now(),
      id,
      ...from,
    );
    if (!changed.changes) {
      await this.require(id);
      throw new CredentialAttemptError('invalid_phase');
    }
    if (to === 'rejected') this.secrets.delete(id);
    return this.require(id);
  }

  /** The bounded activation ran after disclosure; its outcome is not yet verified. */
  markAwaitingVerification(id: string): Promise<CredentialAttempt> {
    return this.move(id, ['exposed'], 'awaiting_verification');
  }

  /** Reconciliation read the site's late response to an unknown signup: it asks for email verification. */
  markVerificationRequested(id: string, evidence: CredentialEvidence): Promise<CredentialAttempt> {
    return this.move(id, ['unknown'], 'awaiting_verification', evidence);
  }

  /** A crash, cancellation, timeout or inconclusive evidence: only reconciliation may resolve it. */
  markUnknown(id: string, evidence?: CredentialEvidence): Promise<CredentialAttempt> {
    return this.move(id, ['exposed', 'awaiting_verification'], 'unknown', evidence);
  }

  /** The website definitively refused, or reconciliation proved no change happened. */
  markRejected(id: string, evidence?: CredentialEvidence): Promise<CredentialAttempt> {
    return this.move(id, ['awaiting_verification', 'unknown'], 'rejected', evidence);
  }

  /** Host-verified account or response evidence shows the website accepted the credential. */
  markConfirmed(id: string, evidence: CredentialEvidence): Promise<CredentialAttempt> {
    return this.move(id, ['awaiting_verification', 'unknown'], 'confirmed', evidence);
  }

  /** Retires a candidate the vault no longer needs, best effort: a failure only leaves it in place. */
  private async retire(attempt: CredentialAttempt, assertActive: () => Promise<void>): Promise<void> {
    if (attempt.candidate_item_id === null) return;
    const archived = await provider(this.vault.archiveItem(attempt.vault_id, attempt.candidate_item_id, assertActive));
    if (!('value' in archived))
      log.info('Credential candidate stays in the vault', { attemptId: attempt.id, reason: archived.status });
  }

  /**
   * Ends an attempt before anything was disclosed, so no website can hold its
   * value; its unused candidate is archived. A create still in doubt
   * (`reconcileSave` not yet settled) can land later as an orphan candidate,
   * which ordinary suggestions never list.
   */
  async abandon(id: string, assertActive = active): Promise<CredentialAttempt> {
    const attempt = await this.move(id, ['preparing', 'saved'], 'rejected');
    await this.retire(attempt, assertActive);
    return attempt;
  }

  /**
   * Ends an attempt the principal released on their approval card: it becomes
   * rejected, with the release and the approval added to its evidence. It
   * never touches 1Password: no candidate is archived, published or promoted,
   * and no ownership is recorded, so both credentials stay where the principal
   * can see them.
   */
  async release(id: string, approvalId: string): Promise<CredentialAttempt> {
    const attempt = await this.require(id);
    const recorded: unknown = attempt.evidence_json === null ? {} : JSON.parse(attempt.evidence_json);
    const evidence = Object.fromEntries(
      Object.entries(isRecord(recorded) ? recorded : {}).filter(
        (entry): entry is [string, string | number | boolean | null] =>
          entry[1] === null || ['string', 'number', 'boolean'].includes(typeof entry[1]),
      ),
    );
    return this.move(id, RELEASABLE_PHASES, 'rejected', { ...evidence, release: 'principal', approval: approvalId });
  }

  /**
   * A cancelled job's half of `abandon`, DB-only so it joins the cancellation
   * transaction: every attempt of the job that disclosed nothing ends.
   * `retireCandidates` archives their candidates once that commits.
   */
  async abandonForJob(jobId: string): Promise<CredentialAttempt[]> {
    const abandoned: CredentialAttempt[] = [];
    for (const { id } of await this.db.all<{ id: string }>(
      `SELECT id FROM ${TABLE} WHERE job_id = ? AND phase IN ('preparing','saved') ORDER BY created_at, id`,
      jobId,
    )) {
      const attempt = await this.undisclosed(id);
      if (attempt) abandoned.push(attempt);
    }
    return abandoned;
  }

  /** Ends one attempt that disclosed nothing, DB-only; undefined when it no longer can. */
  private async undisclosed(id: string): Promise<CredentialAttempt | undefined> {
    try {
      return await this.move(id, ['preparing', 'saved'], 'rejected');
    } catch (error) {
      // Its disclosure won the race: it is settled through its job like any other disclosed attempt.
      if (!(error instanceof CredentialAttemptError)) throw error;
      return undefined;
    }
  }

  /** Archives abandoned attempts' unused candidates, outside any transaction; a failure leaves them hidden. */
  async retireCandidates(abandoned: readonly CredentialAttempt[], assertActive = active): Promise<void> {
    for (const attempt of abandoned) await this.retire(attempt, assertActive);
  }

  /**
   * The explicit reconciliation of every conflict, run when main refreshes
   * the vault after the principal's edits: each is re-read fresh and
   * finalizes once its original Login holds the new password. A spent
   * request budget or an unusable vault stops it; nothing is retried.
   */
  async reconcileConflicts(assertActive = active): Promise<{ readonly finalized: number }> {
    let finalized = 0;
    for (const { id } of await this.db.all<{ id: string }>(
      `SELECT id FROM ${TABLE} WHERE phase = 'conflict' ORDER BY updated_at, id`,
    )) {
      const result = await this.finalize(id, assertActive);
      if (result.status === 'finalized') finalized++;
      if (result.status === 'rate_limited' || result.status === 'vault_unavailable') break;
    }
    return { finalized };
  }

  /**
   * Publishes a confirmed signup's Login, or promotes a confirmed change into
   * the original Login (KTD8), and records ownership. Called again on a
   * conflict, it is the explicit reconciliation: everything is re-read fresh.
   */
  async finalize(id: string, assertActive = active): Promise<CredentialFinalizeResult> {
    const attempt = await this.require(id);
    if (attempt.phase !== 'confirmed' && attempt.phase !== 'conflict') return refused('not_confirmed');
    return attempt.kind === 'signup' ? this.publish(attempt, assertActive) : this.promote(attempt, assertActive);
  }

  private async publish(
    attempt: CredentialAttempt,
    assertActive: () => Promise<void>,
  ): Promise<CredentialFinalizeResult> {
    if (attempt.candidate_item_id === null) return refused('candidate_mismatch');
    const read = await provider(this.vault.readItem(attempt.vault_id, attempt.candidate_item_id, assertActive));
    if (!('value' in read)) return read;
    const secret = candidateSecret(attempt, read.value);
    if (!secret) return this.conflict(attempt, 'ownership_mismatch');
    const remembered = this.secrets.get(attempt.id);
    if (remembered && remembered.password !== secret.password) return this.conflict(attempt, 'password_changed');
    if (read.value.pending) {
      const published = await provider(this.vault.publishCandidate(read.value, assertActive));
      if (!('value' in published)) return published;
    }
    return this.finish(attempt, attempt.candidate_item_id, assertActive);
  }

  /**
   * Fresh-reads the original, re-checks it against its ownership record, and
   * writes only its password, keeping every other edit, under the read's
   * version. A changed password, a racing edit or a disabled update keeps both
   * credentials and reports a conflict.
   */
  private async promote(
    attempt: CredentialAttempt,
    assertActive: () => Promise<void>,
  ): Promise<CredentialFinalizeResult> {
    const sourceId = attempt.source_item_id;
    if (sourceId === null) return refused('candidate_mismatch');
    const owned = await this.ownedSource(attempt, assertActive);
    if (owned.status === 'not_owned') return this.conflict(attempt, 'ownership_mismatch');
    if (owned.status !== 'owned') return owned;
    const candidate = await this.candidate(attempt, assertActive);
    if (!('secret' in candidate)) return candidate.status === 'mismatch' ? refused('candidate_mismatch') : candidate;
    const { password, previousPassword } = candidate.secret;
    if (owned.password === password) return this.finish(attempt, sourceId, assertActive);
    if (owned.password !== previousPassword) return this.conflict(attempt, 'password_changed');
    if (!this.automaticPromotion) return this.conflict(attempt, 'promotion_disabled');
    const updated = await provider(this.vault.replacePassword(owned.read, password, assertActive));
    if ('value' in updated)
      return updated.value.password === password
        ? this.finish(attempt, sourceId, assertActive)
        : { status: 'vault_unavailable' };
    if (updated.status === 'rate_limited') return updated;
    // The write may have landed, or the provider refused a stale version: one read says which.
    const again = await provider(this.vault.readItem(attempt.vault_id, sourceId, assertActive));
    if (!('value' in again)) return again;
    if (again.value.password === password) return this.finish(attempt, sourceId, assertActive);
    if (again.value.password !== previousPassword) return this.conflict(attempt, 'password_changed');
    if (again.value.version !== owned.read.version) return this.conflict(attempt, 'concurrent_edit');
    return updated;
  }

  private async conflict(
    attempt: CredentialAttempt,
    reason: CredentialConflictReason,
  ): Promise<CredentialFinalizeResult> {
    const changed = await this.db.run(
      `UPDATE ${TABLE} SET phase = 'conflict', conflict_reason = ?, updated_at = ? WHERE id = ? AND phase IN ('confirmed','conflict')`,
      reason,
      now(),
      attempt.id,
    );
    if (!changed.changes) throw new CredentialAttemptError('invalid_phase');
    log.warn('Credential attempt kept both credentials after a conflict', { attemptId: attempt.id, reason });
    return { status: 'conflict', reason, attempt: await this.require(attempt.id) };
  }

  private async finish(
    attempt: CredentialAttempt,
    ownedItemId: string,
    assertActive: () => Promise<void>,
  ): Promise<CredentialFinalizeResult> {
    const at = now();
    const changed = await this.db.run(
      `UPDATE ${TABLE} SET phase = 'finalized', owned_item_id = ?, conflict_reason = NULL, finalized_at = ?, updated_at = ?
       WHERE id = ? AND phase IN ('confirmed','conflict')`,
      ownedItemId,
      at,
      at,
      attempt.id,
    );
    if (!changed.changes) throw new CredentialAttemptError('invalid_phase');
    this.secrets.delete(attempt.id);
    // The original now holds the new password, and 1Password keeps the old one in its history.
    if (attempt.kind === 'rotation') await this.retire(attempt, assertActive);
    log.info('Credential attempt finalized', { attemptId: attempt.id, kind: attempt.kind });
    return { status: 'finalized', attempt: await this.require(attempt.id) };
  }
}

export const credentialAttempts = new CredentialAttempts();
