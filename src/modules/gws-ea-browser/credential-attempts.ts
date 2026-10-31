import { randomInt, randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isUniqueViolation } from '../../db/errors.js';
import { EMAIL_PATTERN, hasControlCharacters, isRecord } from '../../gws-ea/validation.js';
import { httpsOrigin } from './authentication-signatures.js';
import { getLoginStore, LoginStoreError, registrableDomain, type LoginStore, type SavedLogin } from './login-store.js';
import { isAssistantAccount } from './web-address.js';

export type CredentialAttemptKind = 'signup' | 'rotation';
export type CredentialAttemptPhase =
  | 'saved'
  | 'exposed'
  | 'awaiting_verification'
  | 'unknown'
  | 'finalized'
  | 'rejected';
export const RELEASABLE_PHASES: readonly CredentialAttemptPhase[] = ['unknown', 'awaiting_verification'];
interface CredentialAttemptRecord {
  readonly id: string;
  readonly job_id: string;
  readonly origin: string;
  readonly site: string;
  readonly username: string;
  readonly phase: CredentialAttemptPhase;
  readonly evidence_json: string | null;
  readonly owned_login_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly exposed_at: string | null;
  readonly finalized_at: string | null;
}
export type CredentialAttempt = CredentialAttemptRecord &
  (
    | { readonly kind: 'signup'; readonly source_login_id: null; readonly source_version: null }
    | { readonly kind: 'rotation'; readonly source_login_id: string; readonly source_version: number }
  );
export type CredentialEvidence = Readonly<Record<string, string | number | boolean | null>>;
export interface DisclosedCredential {
  readonly username: string;
  readonly password: string;
  readonly currentPassword?: string;
}
type StoreFailure = { readonly status: 'vault_unavailable' };
type Refused<Reason extends string> = { readonly status: 'refused'; readonly reason: Reason };
export type CredentialPrepareResult =
  | { readonly status: 'prepared'; readonly attempt: CredentialAttempt }
  | { readonly status: 'not_owned' | 'busy' }
  | StoreFailure;
export type CredentialDisclosure =
  | { readonly status: 'disclosed'; readonly credential: DisclosedCredential }
  | Refused<'not_saved' | 'wrong_job' | 'origin_mismatch' | 'not_owned' | 'source_changed'>
  | StoreFailure;
export type CredentialConfirmResult = { readonly status: 'finalized'; readonly attempt: CredentialAttempt };
export type CredentialReleaseResult = {
  readonly status: 'released';
  readonly from: CredentialAttemptPhase;
  readonly attempt: CredentialAttempt;
};
export class CredentialAttemptError extends Error {
  constructor(readonly reason: 'not_found' | 'invalid_phase' | 'invalid_request') {
    super(reason);
  }
}
const TABLE = 'gws_ea_browser_credential_attempts';
export const MAX_USERNAME = 256;
const now = (): string => new Date().toISOString();
const active = async (): Promise<void> => undefined;
const refused = <Reason extends string>(reason: Reason): Refused<Reason> => ({ status: 'refused', reason });
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+?';
const DIGITS = '23456789';
const SYMBOLS = '!#$%&*+?';
function generatePassword(): string {
  const values = Array.from({ length: 18 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  values.push(DIGITS[randomInt(DIGITS.length)], SYMBOLS[randomInt(SYMBOLS.length)]);
  for (let index = values.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values.join('');
}
export function line(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !hasControlCharacters(value)
  );
}
function evidenceJson(evidence: CredentialEvidence): string {
  if (
    !isRecord(evidence) ||
    Object.keys(evidence).length > 16 ||
    Object.entries(evidence).some(
      ([key, value]) =>
        !/^[a-z][a-z0-9_]{0,63}$/u.test(key) ||
        /password|secret|token|credential|page_text/iu.test(key) ||
        !(
          value === null ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && /^[a-z0-9][a-z0-9_:-]{0,199}$/iu.test(value))
        ),
    )
  )
    throw new CredentialAttemptError('invalid_request');
  return JSON.stringify(evidence);
}
export interface CredentialAttemptsOptions {
  readonly db?: DbDriver;
  readonly store?: LoginStore;
}
export class CredentialAttempts {
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(private readonly options: CredentialAttemptsOptions = {}) {}
  private get db(): DbDriver {
    return this.options.db ?? getDb();
  }
  private store(): Promise<LoginStore> {
    return this.options.store ? Promise.resolve(this.options.store) : getLoginStore();
  }
  get(id: string): Promise<CredentialAttempt | undefined> {
    return this.db.get(`SELECT * FROM ${TABLE} WHERE id = ?`, id);
  }
  private async require(id: string): Promise<CredentialAttempt> {
    const attempt = await this.get(id);
    if (!attempt) throw new CredentialAttemptError('not_found');
    return attempt;
  }
  unresolved(): Promise<CredentialAttempt[]> {
    return this.db.all(`SELECT * FROM ${TABLE} WHERE phase NOT IN ('rejected','finalized') ORDER BY created_at, id`);
  }
  async accountForLogin(login: SavedLogin, site?: string): Promise<'assistant' | 'principal'> {
    if (site !== undefined && login.domain !== site) return 'principal';
    if (await isAssistantAccount(login.username)) return 'assistant';
    if (EMAIL_PATTERN.test(login.username)) return 'principal';
    const signup = await this.db.get<{ id: string }>(
      `SELECT id FROM ${TABLE} WHERE kind = 'signup' AND phase = 'finalized' AND site = ? AND username = ? LIMIT 1`,
      login.domain,
      login.username,
    );
    return signup ? 'assistant' : 'principal';
  }
  async ownedHandle(
    origin: string,
    username: string,
    assertActive = active,
  ): Promise<
    { readonly status: 'found'; readonly itemHandle: string } | { readonly status: 'not_owned' } | StoreFailure
  > {
    try {
      await assertActive();
      for (const login of await (await this.store()).forOrigin(origin))
        if (login.username === username && (await this.accountForLogin(login)) === 'assistant')
          return { status: 'found', itemHandle: login.id };
      return { status: 'not_owned' };
    } catch (error) {
      if (!(error instanceof LoginStoreError)) throw error;
      return { status: 'vault_unavailable' };
    }
  }
  private target(jobId: string, origin: string): { readonly origin: string; readonly site: string } {
    const url = httpsOrigin(origin);
    const site = url && registrableDomain(url.origin);
    if (!line(jobId, 512) || !url || !site) throw new CredentialAttemptError('invalid_request');
    return { origin: url.origin, site };
  }
  private async prepare(
    kind: CredentialAttemptKind,
    input: { jobId: string; origin: string; username: string },
    source?: SavedLogin,
  ): Promise<CredentialPrepareResult> {
    const target = this.target(input.jobId, input.origin);
    if (!line(input.username, MAX_USERNAME)) throw new CredentialAttemptError('invalid_request');
    const store = await this.store();
    const id = randomUUID();
    await store.savePending(id, generatePassword());
    const at = now();
    try {
      await this.db.run(
        `INSERT INTO ${TABLE}(id,kind,job_id,origin,site,username,source_login_id,source_version,phase,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,'saved',?,?)`,
        id,
        kind,
        input.jobId,
        target.origin,
        target.site,
        input.username,
        source?.id ?? null,
        source?.version ?? null,
        at,
        at,
      );
    } catch (error) {
      await store.deletePending(id);
      if (isUniqueViolation(error)) return { status: 'busy' };
      throw error;
    }
    return { status: 'prepared', attempt: await this.require(id) };
  }
  async prepareSignup(input: {
    readonly jobId: string;
    readonly origin: string;
    readonly username: string;
  }): Promise<CredentialPrepareResult> {
    try {
      return await this.prepare('signup', input);
    } catch (error) {
      if (!(error instanceof LoginStoreError)) throw error;
      return { status: 'vault_unavailable' };
    }
  }
  async prepareRotation(
    input: { readonly jobId: string; readonly origin: string; readonly username: string; readonly itemHandle: string },
    assertActive = active,
  ): Promise<CredentialPrepareResult> {
    const target = this.target(input.jobId, input.origin);
    try {
      await assertActive();
      const source = await (await this.store()).get(input.itemHandle);
      if (source.username !== input.username || (await this.accountForLogin(source, target.site)) !== 'assistant')
        return { status: 'not_owned' };
      const open = await this.db.get<CredentialAttempt>(
        `SELECT * FROM ${TABLE} WHERE source_login_id = ? AND phase NOT IN ('rejected','finalized')`,
        source.id,
      );
      if (open) {
        if (open.job_id === input.jobId || open.phase !== 'saved' || !(await this.undisclosed(open.id)))
          return { status: 'busy' };
        await (await this.store()).deletePending(open.id);
      }
      return await this.prepare('rotation', input, source);
    } catch (error) {
      if (!(error instanceof LoginStoreError)) throw error;
      return { status: error.reason === 'no_item_for_site' ? 'not_owned' : 'vault_unavailable' };
    }
  }
  async disclose(
    id: string,
    binding: { readonly jobId: string; readonly origin: string },
    assertActive = active,
  ): Promise<CredentialDisclosure> {
    const attempt = await this.require(id);
    if (attempt.job_id !== binding.jobId) return refused('wrong_job');
    if (attempt.phase !== 'saved') return refused('not_saved');
    if (registrableDomain(binding.origin) !== attempt.site) return refused('origin_mismatch');
    try {
      const store = await this.store();
      let currentPassword: string | undefined;
      if (attempt.kind === 'rotation') {
        if (attempt.source_login_id === null) return refused('not_owned');
        const login = await store.get(attempt.source_login_id);
        if (login.username !== attempt.username || (await this.accountForLogin(login, attempt.site)) !== 'assistant')
          return refused('not_owned');
        if (login.version !== attempt.source_version) return refused('source_changed');
        currentPassword = await store.secret(login.id, 'password', binding.origin);
      }
      const password = await store.disclosePending(id);
      await assertActive();
      const at = now();
      const changed = await this.db.run(
        `UPDATE ${TABLE} SET phase = 'exposed', exposed_at = ?, updated_at = ? WHERE id = ? AND job_id = ? AND phase = 'saved'`,
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
          password,
          ...(currentPassword === undefined ? {} : { currentPassword }),
        },
      };
    } catch (error) {
      if (!(error instanceof LoginStoreError)) throw error;
      return error.reason === 'no_item_for_site' ? refused('not_owned') : { status: 'vault_unavailable' };
    }
  }
  private async move(
    id: string,
    from: readonly CredentialAttemptPhase[],
    to: CredentialAttemptPhase,
    evidence?: CredentialEvidence,
  ): Promise<CredentialAttempt> {
    const json = evidence === undefined ? null : evidenceJson(evidence);
    const changed = await this.db.run(
      `UPDATE ${TABLE} SET phase = ?, evidence_json = COALESCE(?, evidence_json), updated_at = ? WHERE id = ? AND phase IN (${from.map(() => '?').join(',')})`,
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
    return this.require(id);
  }
  markAwaitingVerification(id: string): Promise<CredentialAttempt> {
    return this.move(id, ['exposed'], 'awaiting_verification');
  }
  markVerificationRequested(id: string, evidence: CredentialEvidence): Promise<CredentialAttempt> {
    return this.move(id, ['unknown'], 'awaiting_verification', evidence);
  }
  markUnknown(id: string, evidence?: CredentialEvidence): Promise<CredentialAttempt> {
    return this.move(id, ['exposed', 'awaiting_verification'], 'unknown', evidence);
  }
  async markRejected(id: string, evidence?: CredentialEvidence): Promise<CredentialAttempt> {
    return this.exclusive(id, async () => {
      const attempt = await this.move(id, ['awaiting_verification', 'unknown'], 'rejected', evidence);
      await (await this.store()).deletePending(id);
      return attempt;
    });
  }
  async abandon(id: string, assertActive = active): Promise<CredentialAttempt> {
    await assertActive();
    const attempt = await this.move(id, ['saved'], 'rejected');
    await (await this.store()).deletePending(id);
    return attempt;
  }
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (this.running.get(id) ?? Promise.resolve()).then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.running.set(id, settled);
    try {
      return await run;
    } finally {
      if (this.running.get(id) === settled) this.running.delete(id);
    }
  }
  release(id: string, approvalId: string): Promise<CredentialReleaseResult> {
    return this.exclusive(id, async () => {
      const current = await this.require(id);
      const recorded: unknown = current.evidence_json === null ? {} : JSON.parse(current.evidence_json);
      const attempt = await this.move(id, RELEASABLE_PHASES, 'rejected', {
        ...(isRecord(recorded) ? (recorded as CredentialEvidence) : {}),
        release: 'principal',
        approval: approvalId,
        released_from: current.phase,
      });
      await (await this.store()).deletePending(id);
      return { status: 'released', from: current.phase, attempt };
    });
  }
  async abandonForJob(jobId: string): Promise<CredentialAttempt[]> {
    const abandoned: CredentialAttempt[] = [];
    for (const { id } of await this.db.all<{ id: string }>(
      `SELECT id FROM ${TABLE} WHERE job_id = ? AND phase = 'saved' ORDER BY created_at, id`,
      jobId,
    )) {
      const attempt = await this.undisclosed(id);
      if (attempt) abandoned.push(attempt);
    }
    return abandoned;
  }
  private async undisclosed(id: string, evidence?: CredentialEvidence): Promise<CredentialAttempt | undefined> {
    try {
      return await this.move(id, ['saved'], 'rejected', evidence);
    } catch (error) {
      if (!(error instanceof CredentialAttemptError)) throw error;
      return undefined;
    }
  }
  async retirePending(abandoned: readonly CredentialAttempt[]): Promise<void> {
    if (!abandoned.length) return;
    const store = await this.store();
    for (const attempt of abandoned) await store.deletePending(attempt.id);
  }
  async giveWayForLogin(loginId: string): Promise<'ready' | 'login_busy'> {
    const open = await this.db.get<CredentialAttempt>(
      `SELECT * FROM ${TABLE} WHERE source_login_id = ? AND phase NOT IN ('rejected','finalized')`,
      loginId,
    );
    if (!open) return 'ready';
    if (open.phase !== 'saved') return 'login_busy';
    const ended = await this.undisclosed(open.id, { reason: 'login_edited' });
    if (!ended) return 'login_busy';
    await (await this.store()).deletePending(open.id);
    return 'ready';
  }
  private async finish(
    attempt: CredentialAttempt,
    login: SavedLogin | undefined,
    evidence?: CredentialEvidence,
  ): Promise<CredentialConfirmResult> {
    const at = now();
    const json = evidence === undefined ? null : evidenceJson(evidence);
    const changed = await this.db.run(
      `UPDATE ${TABLE} SET phase = 'finalized', owned_login_id = ?, evidence_json = COALESCE(?, evidence_json), finalized_at = ?, updated_at = ? WHERE id = ? AND phase IN ('saved','exposed','awaiting_verification','unknown')`,
      login?.id ?? null,
      json,
      at,
      at,
      attempt.id,
    );
    if (!changed.changes) throw new CredentialAttemptError('invalid_phase');
    return { status: 'finalized', attempt: await this.require(attempt.id) };
  }
  async confirm(id: string, evidence: CredentialEvidence): Promise<CredentialConfirmResult> {
    evidenceJson(evidence);
    return this.exclusive(id, async () => {
      const attempt = await this.require(id);
      if (attempt.phase === 'finalized') return { status: 'finalized', attempt };
      if (!['exposed', 'awaiting_verification', 'unknown'].includes(attempt.phase))
        throw new CredentialAttemptError('invalid_phase');
      const store = await this.store();
      const login = await store.confirmPending(
        id,
        attempt.kind === 'signup'
          ? { kind: 'signup', details: { site: attempt.origin, username: attempt.username, title: attempt.site } }
          : { kind: 'rotation', loginId: attempt.source_login_id, version: attempt.source_version },
      );
      return this.finish(attempt, login ?? (await this.resultingLogin(store, attempt)), evidence);
    });
  }
  private async resultingLogin(store: LoginStore, attempt: CredentialAttempt): Promise<SavedLogin | undefined> {
    return (await store.forOrigin(attempt.origin)).find((login) =>
      attempt.kind === 'rotation' ? login.id === attempt.source_login_id : login.username === attempt.username,
    );
  }
  async recover(): Promise<void> {
    const store = await this.store();
    for (const id of await store.pendingIds()) {
      const attempt = await this.get(id);
      if (!attempt || attempt.phase === 'rejected' || attempt.phase === 'finalized') await store.deletePending(id);
    }
    for (const attempt of await this.unresolved()) {
      if (!(await store.hasPending(attempt.id))) await this.finish(attempt, await this.resultingLogin(store, attempt));
      else if (attempt.phase === 'exposed') await this.markUnknown(attempt.id, { signal: 'interrupted' });
    }
  }
}
export const credentialAttempts = new CredentialAttempts();
