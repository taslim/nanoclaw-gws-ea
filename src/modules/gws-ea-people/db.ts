import { randomBytes } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { hasControlCharacters, identityMatchKey, normalizePrincipalEmail, parseLine } from '../../gws-ea/validation.js';
import { assistantOwnAddresses, getGwsEaProfile, listVerifiedPrincipalUsers } from '../gws-ea-profile/db.js';
import { createFingerprintKey, fingerprintKeyFile, identityFingerprint, readFingerprintKey } from './fingerprint.js';
import type { ForgottenFingerprint } from './forget-handoff.js';

/** Closest first. Anyone without a record is `unknown`, which is never stored. */
export const PERSON_LEVELS = ['inner-circle', 'close', 'active', 'known'] as const;
export type PersonLevel = (typeof PERSON_LEVELS)[number];

/** Who makes a change: the principal, or the assistant on what it learned. */
export const CHANGE_SOURCES = ['principal', 'learned'] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

/** `directory` is the Workspace directory; `calendar`, calendar history. */
export const IDENTITY_SOURCES = ['principal', 'directory', 'calendar'] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export interface PersonIdentity {
  /** A channel-qualified handle in NanoClaw's user-id form, such as `email:sam@example.com`. */
  readonly handle: string;
  readonly source: IdentitySource;
  readonly added_at: string;
}

/**
 * Only what the host enforces: identities and one level. What `main` knows of
 * the person lives in its own memory, one file per person naming this
 * record's ID.
 */
export interface Person {
  readonly id: string;
  readonly name: string;
  readonly level: PersonLevel;
  readonly level_source: ChangeSource;
  readonly level_basis: string;
  readonly level_set_at: string;
  readonly identities: readonly PersonIdentity[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PersonSummary {
  readonly id: string;
  readonly name: string;
  readonly level: PersonLevel;
  readonly identities: readonly string[];
}

export type FindMatch = 'identity' | 'name' | 'name-prefix';

export interface FindPeopleResult {
  /** Null when nobody matched. */
  readonly matched_by: FindMatch | null;
  readonly people: readonly PersonSummary[];
}

/** Unvalidated caller input: the store checks every field. */
export interface AddPersonInput {
  readonly name: string;
  readonly level: string;
  readonly source: string;
  /**
   * Who chose the level, when it differs from `source`: `learned` when the
   * principal gave the person but not where they stand. Defaults to `source`.
   */
  readonly levelSource?: string;
  readonly basis: string;
  readonly identity?: string;
  /** Defaults to `principal` on the principal's word; required when learned. */
  readonly identitySource?: string;
}

/** Unvalidated caller input. */
export interface UpdatePersonInput {
  readonly id: string;
  readonly source: string;
  readonly name?: string;
  readonly addIdentity?: string;
  readonly identitySource?: string;
  readonly removeIdentity?: string;
}

export interface SetPersonLevelInput {
  readonly id: string;
  readonly level: string;
  readonly source: string;
  readonly basis: string;
}

export interface ForgetPersonInput {
  readonly id: string;
}

/** What a forget hook learns of the person being forgotten: enough to find its own data, nothing more. */
export interface ForgottenPerson {
  readonly id: string;
  readonly handles: readonly string[];
}

export type PersonForgetHook = (person: ForgottenPerson) => Promise<void>;

/** What a forget review reads of the person, while their record still stands: their name too. */
export interface PersonToForget extends ForgottenPerson {
  readonly name: string;
}

/**
 * What a module puts to main for a person being forgotten: each record of
 * its own whose words main wrote and that may name them, by kind and id
 * (`matter m-…`), for main to rewrite, since only main can.
 */
export type PersonForgetReview = (person: PersonToForget) => Promise<readonly string[]>;

export interface ForgetAnswer {
  readonly forgotten: string;
  readonly name: string;
  /** Every identity forgotten, for main to clear from its memory with the name. */
  readonly identities: readonly string[];
  /** What the reviews put to main to rewrite, each once. */
  readonly rewrite: readonly string[];
}

const NAME_MAX_LENGTH = 120;
const BASIS_MAX_LENGTH = 280;
const QUERY_MAX_LENGTH = 320;
const HANDLE_MAX_LENGTH = 256;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const HOOK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/u;

// ---------------------------------------------------------------------------
// Forget hooks and reviews
// ---------------------------------------------------------------------------

const forgetHooks = new Map<string, PersonForgetHook>();
const forgetReviews = new Map<string, PersonForgetReview>();

function registerOnce<T>(registry: Map<string, T>, what: string, id: string, entry: T): void {
  if (!HOOK_ID_PATTERN.test(id)) throw new Error(`${what} "${id}" must use "<module-id>:<hook-id>"`);
  if (registry.has(id)) throw new Error(`${what} "${id}" is already registered`);
  registry.set(id, entry);
}

/**
 * Hooks run in registration order, after every review and before the record
 * is deleted, so a failed hook leaves the person to be forgotten again: each
 * must be idempotent.
 */
export function registerPersonForgetHook(id: string, hook: PersonForgetHook): void {
  registerOnce(forgetHooks, 'Person forget hook', id, hook);
}

/**
 * What a module puts to main to rewrite for a forgotten person. Reviews only
 * read, and all run before any hook, so no module's purge hides from another
 * what led to the person.
 */
export function registerPersonForgetReview(id: string, review: PersonForgetReview): void {
  registerOnce(forgetReviews, 'Person forget review', id, review);
}

// ---------------------------------------------------------------------------
// Parsing: every value is checked here before it reaches the schema's checks.
// ---------------------------------------------------------------------------

function parseLevel(value: string): PersonLevel {
  const level = PERSON_LEVELS.find((candidate) => candidate === value);
  if (!level) throw new Error(`Level ${JSON.stringify(value)} is invalid: use ${PERSON_LEVELS.join(', ')}`);
  return level;
}

function parseChangeSource(value: string): ChangeSource {
  const source = CHANGE_SOURCES.find((candidate) => candidate === value);
  if (!source) throw new Error(`Source ${JSON.stringify(value)} is invalid: use principal or learned`);
  return source;
}

/** A name as it is compared: accents dropped, lowercased, whitespace collapsed. */
function nameKey(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function nameTokens(key: string): string[] {
  return key.split(/[^\p{L}\p{N}]+/u).filter((token) => token !== '');
}

/**
 * Whether `text` may name the person: a word of their name, compared as names
 * are and a lone initial aside, or one of their email addresses. Generous on
 * purpose: it picks out what main should reread, never what is deleted.
 */
export function mayNamePerson(person: Pick<PersonToForget, 'name' | 'handles'>, text: string): boolean {
  const words = new Set(nameTokens(nameKey(person.name)).filter((word) => word.length > 1));
  if (nameTokens(nameKey(text)).some((word) => words.has(word))) return true;
  const lowered = text.toLowerCase();
  return person.handles.some(
    (handle) =>
      handle.toLowerCase().startsWith('email:') && lowered.includes(handle.slice('email:'.length).toLowerCase()),
  );
}

/**
 * An identity as the store holds it: `<channel>:<handle>` in NanoClaw's
 * user-id form, an email address lowercased. A bare address is an email
 * identity. Undefined when `value` cannot be one.
 */
function canonicalIdentity(value: string): string | undefined {
  const text = value.trim();
  const colon = text.indexOf(':');
  if (colon < 0) {
    const email = normalizePrincipalEmail(text);
    return email === undefined ? undefined : `email:${email}`;
  }
  const channel = text.slice(0, colon).toLowerCase();
  const handle = text.slice(colon + 1);
  if (!CHANNEL_PATTERN.test(channel)) return undefined;
  if (channel === 'email') {
    const email = normalizePrincipalEmail(handle);
    return email === undefined ? undefined : `email:${email}`;
  }
  const valid =
    handle.length > 0 &&
    handle.length <= HANDLE_MAX_LENGTH &&
    !/\s/u.test(handle) &&
    !handle.includes('`') &&
    !hasControlCharacters(handle);
  return valid ? `${channel}:${handle}` : undefined;
}

function parseIdentity(value: string): string {
  const handle = canonicalIdentity(value);
  if (handle === undefined) {
    throw new Error(
      `Identity ${JSON.stringify(value)} is invalid: use a channel-qualified handle such as email:name@example.com`,
    );
  }
  return handle;
}

/** The principal may give an identity of any source; learning gives one it found in the directory or calendar. */
function identitySourceFor(author: ChangeSource, value: string | undefined): IdentitySource {
  if (value === undefined) {
    if (author === 'principal') return 'principal';
    throw new Error('A learned identity needs its source, directory or calendar: where it was found');
  }
  const source = IDENTITY_SOURCES.find((candidate) => candidate === value);
  if (!source)
    throw new Error(`Identity source ${JSON.stringify(value)} is invalid: use ${IDENTITY_SOURCES.join(', ')}`);
  if (author === 'learned' && source === 'principal') {
    throw new Error("A learned identity's source is directory or calendar; only the principal gives one as theirs");
  }
  return source;
}

function assertPrincipal(author: ChangeSource, refusal: string): void {
  if (author !== 'principal') throw new Error(refusal);
}

function newPersonId(): string {
  return `p-${randomBytes(6).toString('hex')}`;
}

function noPerson(id: string): Error {
  return new Error(`No person ${JSON.stringify(id)} exists`);
}

// ---------------------------------------------------------------------------
// The fingerprint key: the store runs without one only while it holds no fingerprints.
// ---------------------------------------------------------------------------

/** The store's refusal while it cannot honor a forget. Its words, and the key's path, are for the operator. */
export class PeopleStoreStoppedError extends Error {}

function stoppedError(file: string | undefined): PeopleStoreStoppedError {
  const where =
    file === undefined ? 'has no place on this host (no instance secrets directory)' : `is missing at ${file}`;
  return new PeopleStoreStoppedError(
    `The people store is stopped: it holds forgotten identities, but its fingerprint key ${where}. ` +
      "Restore the key from the instance's backup; a new key would let forgotten people be learned again.",
  );
}

async function hasFingerprints(): Promise<boolean> {
  return (await getDb().get('SELECT 1 AS present FROM gws_ea_people_fingerprints LIMIT 1')) !== undefined;
}

async function loadFingerprintKey(): Promise<Buffer | undefined> {
  const file = fingerprintKeyFile();
  const key = file === undefined ? undefined : await readFingerprintKey(file);
  if (key === undefined && (await hasFingerprints())) throw stoppedError(file);
  return key;
}

/**
 * Refuse while the store cannot honor a forget: it holds fingerprints but
 * its key is missing or unsafe. It never issues a new key over fingerprints.
 */
export async function assertPeopleStoreRunning(): Promise<void> {
  await loadFingerprintKey();
}

/** The key a forget fingerprints with; the first forget creates it. */
async function forgetKey(): Promise<Buffer> {
  const key = await loadFingerprintKey();
  if (key !== undefined) return key;
  const file = fingerprintKeyFile();
  if (file === undefined) {
    throw new Error(
      'Forgetting someone keeps a keyed fingerprint of each identity, and this host has no instance secrets directory to keep the key in',
    );
  }
  return createFingerprintKey(file);
}

// ---------------------------------------------------------------------------
// Identities and reads
// ---------------------------------------------------------------------------

interface IdentityToAdmit {
  readonly handle: string;
  readonly source: IdentitySource;
}

function identityToAdmit(author: ChangeSource, value: string, source: string | undefined): IdentityToAdmit {
  return { handle: parseIdentity(value), source: identitySourceFor(author, source) };
}

/**
 * Why `handle` cannot be a person's: it is the principal's or the
 * assistant's own (its web alias included), in any spelling.
 */
async function reservedIdentity(handle: string): Promise<string | undefined> {
  const key = identityMatchKey(handle);
  const profile = await getGwsEaProfile();
  if (assistantOwnAddresses(profile).some((email) => identityMatchKey(`email:${email}`) === key)) {
    return `${handle} is the assistant's own address, not a person's`;
  }
  if (profile.principal_emails.some((email) => identityMatchKey(`email:${email}`) === key)) {
    return `${handle} is the principal's own address, not a person's`;
  }
  if ((await listVerifiedPrincipalUsers()).some((user) => identityMatchKey(user.user_id) === key)) {
    return `${handle} is the principal's own identity, not a person's`;
  }
  return undefined;
}

/**
 * Inside the caller's transaction. A forgotten identity is refused to
 * learning; the principal adding it back clears its fingerprint. Without a key
 * the store must hold no fingerprints, which is checked again here.
 */
async function admitIdentity(
  identity: IdentityToAdmit,
  key: Buffer | undefined,
  author: ChangeSource,
  personId: string,
  now: string,
): Promise<void> {
  const db = getDb();
  const reserved = await reservedIdentity(identity.handle);
  if (reserved !== undefined) throw new Error(reserved);
  if (key === undefined) {
    if (await hasFingerprints()) throw stoppedError(fingerprintKeyFile());
  } else {
    const fingerprint = identityFingerprint(key, identity.handle);
    if (await db.get('SELECT 1 AS present FROM gws_ea_people_fingerprints WHERE fingerprint = ?', fingerprint)) {
      if (author === 'learned') {
        throw new Error(
          `${identity.handle} was forgotten at the principal's request; only the principal can add it back`,
        );
      }
      await db.run('DELETE FROM gws_ea_people_fingerprints WHERE fingerprint = ?', fingerprint);
    }
  }
  const holder = await db.get<{ readonly person_id: string; readonly name: string }>(
    `SELECT i.person_id, p.name
       FROM gws_ea_people_identities i
       JOIN gws_ea_people p ON p.id = i.person_id
      WHERE i.handle = ?`,
    identity.handle,
  );
  if (holder) throw new Error(`${identity.handle} already belongs to ${holder.name} (${holder.person_id})`);
  await db.run(
    `INSERT INTO gws_ea_people_identities (handle, match_key, person_id, source, added_at)
     VALUES (?, ?, ?, ?, ?)`,
    identity.handle,
    identityMatchKey(identity.handle),
    personId,
    identity.source,
    now,
  );
}

/**
 * Take `handle`, in every spelling that reaches the same mailbox, from
 * whichever person holds it, inside the caller's transaction. Not a forget:
 * no hook runs and no fingerprint is kept.
 */
export async function removeMatchingIdentities(handle: string): Promise<void> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_people_identities'))) return;
  await db.run('DELETE FROM gws_ea_people_identities WHERE match_key = ?', identityMatchKey(handle));
}

interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly level: PersonLevel;
  readonly level_source: ChangeSource;
  readonly level_basis: string;
  readonly level_set_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SummaryRow {
  readonly id: string;
  readonly name: string;
  readonly level: PersonLevel;
}

const SUMMARY_COLUMNS = 'id, name, level';

/** One person's whole record, for `main` and the host only. */
export async function getPerson(id: string): Promise<Person | undefined> {
  const db = getDb();
  const row = await db.get<PersonRow>(
    `SELECT id, name, level, level_source, level_basis, level_set_at, created_at, updated_at
       FROM gws_ea_people
      WHERE id = ?`,
    id.trim(),
  );
  if (!row) return undefined;
  const identities = await db.all<PersonIdentity>(
    'SELECT handle, source, added_at FROM gws_ea_people_identities WHERE person_id = ? ORDER BY handle',
    row.id,
  );
  return { ...row, identities };
}

async function requirePerson(id: string): Promise<Person> {
  const person = await getPerson(id);
  if (!person) throw noPerson(id);
  return person;
}

async function requirePersonRow(id: string): Promise<{ readonly name: string }> {
  const row = await getDb().get<{ readonly name: string }>('SELECT name FROM gws_ea_people WHERE id = ?', id);
  if (!row) throw noPerson(id);
  return row;
}

/** Summaries in the order given, each with its identities. */
async function summarize(rows: readonly SummaryRow[]): Promise<PersonSummary[]> {
  if (rows.length === 0) return [];
  const handles = new Map<string, string[]>(rows.map((row) => [row.id, []]));
  const placeholders = [...handles.keys()].map(() => '?').join(', ');
  const identities = await getDb().all<{ readonly person_id: string; readonly handle: string }>(
    `SELECT person_id, handle FROM gws_ea_people_identities WHERE person_id IN (${placeholders}) ORDER BY handle`,
    ...handles.keys(),
  );
  for (const { person_id, handle } of identities) handles.get(person_id)?.push(handle);
  return rows.map((row) => ({ ...row, identities: handles.get(row.id) ?? [] }));
}

/** Ordered by name. */
async function summariesOf(ids: ReadonlySet<string>): Promise<PersonSummary[]> {
  if (ids.size === 0) return [];
  const placeholders = [...ids].map(() => '?').join(', ');
  return summarize(
    await getDb().all<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM gws_ea_people WHERE id IN (${placeholders}) ORDER BY name_key, id`,
      ...ids,
    ),
  );
}

/** Everyone with a record, closest level first and then by name; or only those at `level`. */
export async function listPeople(level?: string): Promise<PersonSummary[]> {
  const only = level === undefined ? undefined : parseLevel(level);
  const rows = await getDb().all<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM gws_ea_people${only === undefined ? '' : ' WHERE level = ?'} ORDER BY name_key, id`,
    ...(only === undefined ? [] : [only]),
  );
  const rank = (row: SummaryRow) => PERSON_LEVELS.indexOf(row.level);
  return summarize([...rows].sort((left, right) => rank(left) - rank(right)));
}

/**
 * Find people by an identity, or by a name: an exact name first, then names
 * whose words start with every word of the query. The first rule that
 * matches anyone decides.
 */
export async function findPeople(query: string): Promise<FindPeopleResult> {
  const text = query.trim();
  if (!text || text.length > QUERY_MAX_LENGTH || hasControlCharacters(text)) {
    throw new Error('A find query is one line: a name or an identity');
  }
  const db = getDb();
  const found = async (matchedBy: FindMatch, ids: Iterable<string>): Promise<FindPeopleResult | undefined> => {
    const people = await summariesOf(new Set(ids));
    return people.length === 0 ? undefined : { matched_by: matchedBy, people };
  };

  const handle = canonicalIdentity(text);
  if (handle !== undefined) {
    const holders = await db.all<{ readonly person_id: string }>(
      'SELECT person_id FROM gws_ea_people_identities WHERE handle = ?',
      handle,
    );
    return (
      (await found(
        'identity',
        holders.map((row) => row.person_id),
      )) ?? { matched_by: null, people: [] }
    );
  }

  const key = nameKey(text);
  const named = await db.all<{ readonly id: string }>('SELECT id FROM gws_ea_people WHERE name_key = ?', key);
  const queryTokens = nameTokens(key);
  const prefixed = async (): Promise<string[]> => {
    if (queryTokens.length === 0) return [];
    const names = await db.all<{ readonly id: string; readonly name_key: string }>(
      'SELECT id, name_key FROM gws_ea_people',
    );
    return names
      .filter((entry) => {
        const tokens = nameTokens(entry.name_key);
        return queryTokens.every((wanted) => tokens.some((token) => token.startsWith(wanted)));
      })
      .map((entry) => entry.id);
  };
  return (
    (await found(
      'name',
      named.map((row) => row.id),
    )) ??
    (await found('name-prefix', await prefixed())) ?? { matched_by: null, people: [] }
  );
}

/**
 * `unknown` when nobody with a record holds the identity. Never a name, so it
 * is what a reader other than main may learn of a person.
 */
export async function getPersonLevel(identity: string): Promise<PersonLevel | 'unknown'> {
  const handle = canonicalIdentity(identity);
  if (handle === undefined) return 'unknown';
  const row = await getDb().get<{ readonly level: PersonLevel }>(
    `SELECT p.level
       FROM gws_ea_people_identities i
       JOIN gws_ea_people p ON p.id = i.person_id
      WHERE i.handle = ?`,
    handle,
  );
  return row?.level ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function addPerson(input: AddPersonInput): Promise<Person> {
  const author = parseChangeSource(input.source);
  const levelSource = input.levelSource === undefined ? author : parseChangeSource(input.levelSource);
  if (levelSource === 'principal') assertPrincipal(author, 'Only the principal sets a level as theirs');
  const name = parseLine(input.name, 'Name', NAME_MAX_LENGTH);
  const level = parseLevel(input.level);
  const basis = parseLine(input.basis, 'Basis', BASIS_MAX_LENGTH);
  if (input.identity === undefined && input.identitySource !== undefined) {
    throw new Error('An identity source applies only with an identity');
  }
  const identity =
    input.identity === undefined ? undefined : identityToAdmit(author, input.identity, input.identitySource);

  const key = await loadFingerprintKey();
  const id = newPersonId();
  const now = new Date().toISOString();
  const db = getDb();
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO gws_ea_people
         (id, name, name_key, level, level_source, level_basis, level_set_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      nameKey(name),
      level,
      levelSource,
      basis,
      now,
      now,
      now,
    );
    if (identity !== undefined) await admitIdentity(identity, key, author, id, now);
  });
  return requirePerson(id);
}

export async function updatePerson(input: UpdatePersonInput): Promise<Person> {
  const author = parseChangeSource(input.source);
  const id = input.id.trim();
  const name = input.name === undefined ? undefined : parseLine(input.name, 'Name', NAME_MAX_LENGTH);
  if (input.addIdentity === undefined && input.identitySource !== undefined) {
    throw new Error('An identity source applies only with an identity to add');
  }
  const addIdentity =
    input.addIdentity === undefined ? undefined : identityToAdmit(author, input.addIdentity, input.identitySource);
  const removeIdentity = input.removeIdentity === undefined ? undefined : parseIdentity(input.removeIdentity);
  if (name === undefined && addIdentity === undefined && removeIdentity === undefined) {
    throw new Error('Nothing to change: give a name, or an identity to add or remove');
  }

  const key = await loadFingerprintKey();
  const now = new Date().toISOString();
  const db = getDb();
  await db.transaction(async () => {
    const person = await requirePersonRow(id);
    if (removeIdentity !== undefined) {
      const held = await db.get<{ readonly source: IdentitySource }>(
        'SELECT source FROM gws_ea_people_identities WHERE handle = ? AND person_id = ?',
        removeIdentity,
        id,
      );
      if (!held) throw new Error(`${person.name} does not hold ${removeIdentity}`);
      if (held.source === 'principal' && author === 'learned') {
        throw new Error(`${removeIdentity} was given by the principal, so learning cannot remove it`);
      }
      await db.run('DELETE FROM gws_ea_people_identities WHERE handle = ?', removeIdentity);
    }
    if (addIdentity !== undefined) await admitIdentity(addIdentity, key, author, id, now);
    if (name !== undefined) {
      await db.run('UPDATE gws_ea_people SET name = ?, name_key = ? WHERE id = ?', name, nameKey(name), id);
    }
    await db.run('UPDATE gws_ea_people SET updated_at = ? WHERE id = ?', now, id);
  });
  return requirePerson(id);
}

/** Not checked against the current level's source: which level fits is main's judgment. */
export async function setPersonLevel(input: SetPersonLevelInput): Promise<Person> {
  const author = parseChangeSource(input.source);
  const level = parseLevel(input.level);
  const basis = parseLine(input.basis, 'Basis', BASIS_MAX_LENGTH);
  const id = input.id.trim();
  await loadFingerprintKey();
  const now = new Date().toISOString();
  const db = getDb();
  await db.transaction(async () => {
    await requirePersonRow(id);
    await db.run(
      `UPDATE gws_ea_people
          SET level = ?, level_source = ?, level_basis = ?, level_set_at = ?, updated_at = ?
        WHERE id = ?`,
      level,
      author,
      basis,
      now,
      now,
      id,
    );
  });
  return requirePerson(id);
}

/**
 * An `email:` user who holds or gave a role or a membership is the operator's
 * to change; forgetting never removes one on its own.
 */
async function assertNoGrantedAccess(name: string, userIds: readonly string[]): Promise<void> {
  const db = getDb();
  for (const userId of userIds) {
    const holds = await db.get(
      `SELECT 1 AS present FROM user_roles WHERE user_id = ?
       UNION ALL SELECT 1 FROM agent_group_members WHERE user_id = ? LIMIT 1`,
      userId,
      userId,
    );
    const granted = await db.get(
      `SELECT 1 AS present FROM user_roles WHERE granted_by = ?
       UNION ALL SELECT 1 FROM agent_group_members WHERE added_by = ? LIMIT 1`,
      userId,
      userId,
    );
    if (holds || granted) {
      // main relays this to the principal, whose operator alone changes who may use the assistant.
      const address = userId.slice('email:'.length);
      throw new Error(
        `${name} ${holds ? 'has' : 'gave someone'} access to the assistant as ${address}, which only the principal's operator can remove: ` +
          'tell the principal their operator must remove that access before you can forget them.',
      );
    }
  }
}

/**
 * Every review runs, then every hook, then one transaction deletes the record
 * and its identities with the core `users`, `user_dms` and dropped-message
 * rows of its `email:` identities. Only a keyed fingerprint of each identity
 * is kept, so learning cannot bring the person back. What `main` knows of
 * them is in its memory, which the host never reads: the answer names them
 * and their identities so `main` can clear it, with what else it wrote that
 * may name them.
 */
export async function forgetPerson(input: ForgetPersonInput): Promise<ForgetAnswer> {
  const id = input.id.trim();
  await loadFingerprintKey();
  const person = await requirePerson(id);
  const handles = person.identities.map((identity) => identity.handle);
  await assertNoGrantedAccess(
    person.name,
    handles.filter((handle) => handle.startsWith('email:')),
  );
  const key = await forgetKey();

  const rewrite = new Set<string>();
  for (const review of forgetReviews.values()) {
    for (const entry of await review({ id, name: person.name, handles })) rewrite.add(entry);
  }
  for (const hook of forgetHooks.values()) await hook({ id, handles });

  const db = getDb();
  return db.transaction(async () => {
    const record = await requirePersonRow(id);
    const current = await db.all<{ readonly handle: string }>(
      'SELECT handle FROM gws_ea_people_identities WHERE person_id = ?',
      id,
    );
    const forgotten = [...new Set([...handles, ...current.map((row) => row.handle)])];
    const now = new Date().toISOString();
    for (const handle of forgotten) {
      await db.run(
        `INSERT INTO gws_ea_people_fingerprints (fingerprint, forgotten_at) VALUES (?, ?)
         ON CONFLICT (fingerprint) DO NOTHING`,
        identityFingerprint(key, handle),
        now,
      );
    }
    await db.run('DELETE FROM gws_ea_people_identities WHERE person_id = ?', id);
    await db.run('DELETE FROM gws_ea_people WHERE id = ?', id);
    for (const userId of forgotten.filter((handle) => handle.startsWith('email:'))) {
      await db.run('DELETE FROM user_dms WHERE user_id = ?', userId);
      await db.run('DELETE FROM unregistered_senders WHERE user_id = ?', userId);
      await db.run('DELETE FROM users WHERE id = ?', userId);
    }
    return { forgotten: id, name: record.name, identities: forgotten, rewrite: [...rewrite] };
  });
}

// ---------------------------------------------------------------------------
// After a snapshot restore: the forgets the restored state predates
// ---------------------------------------------------------------------------

/**
 * Records the fingerprints the state a snapshot restore replaced held and the
 * restored state lacks. One already recorded keeps its own time.
 */
export async function recordForgottenFingerprints(rows: readonly ForgottenFingerprint[]): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    for (const { fingerprint, forgotten_at } of rows) {
      await db.run(
        `INSERT INTO gws_ea_people_fingerprints (fingerprint, forgotten_at) VALUES (?, ?)
         ON CONFLICT (fingerprint) DO NOTHING`,
        fingerprint,
        forgotten_at,
      );
    }
  });
}

/**
 * A test of whether an identity was forgotten, in any spelling that reaches
 * the same mailbox, against the fingerprints recorded when it loads: a later
 * forget is not seen. Without a key the store holds no fingerprints.
 */
export async function loadForgottenMatcher(): Promise<(handle: string) => boolean> {
  const key = await loadFingerprintKey();
  if (key === undefined) return () => false;
  const recorded = new Set(
    (await getDb().all<{ readonly fingerprint: string }>('SELECT fingerprint FROM gws_ea_people_fingerprints')).map(
      (row) => row.fingerprint,
    ),
  );
  return (handle) => recorded.size > 0 && recorded.has(identityFingerprint(key, handle));
}

/**
 * Everyone holding an identity whose fingerprint is recorded, by name. A
 * principal adding an identity back clears its fingerprint, so only a
 * snapshot restore leaves anyone here.
 */
export async function listForgottenPeople(): Promise<Array<{ readonly id: string; readonly name: string }>> {
  const isForgotten = await loadForgottenMatcher();
  const identities = await getDb().all<{ readonly id: string; readonly name: string; readonly handle: string }>(
    `SELECT p.id, p.name, i.handle
       FROM gws_ea_people_identities i
       JOIN gws_ea_people p ON p.id = i.person_id
      ORDER BY p.name_key, p.id`,
  );
  const people = new Map<string, string>();
  for (const { id, name, handle } of identities) {
    if (isForgotten(handle)) people.set(id, name);
  }
  return [...people].map(([id, name]) => ({ id, name }));
}
