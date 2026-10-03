import { randomBytes } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { hasControlCharacters, normalizePrincipalEmail } from '../../gws-ea/validation.js';
import { getGwsEaProfile, listVerifiedPrincipalUsers } from '../gws-ea-profile/db.js';
import {
  createFingerprintKey,
  fingerprintKeyFile,
  identityFingerprint,
  identityMatchKey,
  readFingerprintKey,
} from './fingerprint.js';

/** The fixed set of levels, closest first (R13). Anyone without a record is `unknown`, which is never stored. */
export const PERSON_LEVELS = ['inner-circle', 'close', 'active', 'known'] as const;
export type PersonLevel = (typeof PERSON_LEVELS)[number];

/** The levels learning may set: a learned level stops at active (R15). */
export const LEARNED_LEVELS: readonly PersonLevel[] = ['active', 'known'];

/** Who makes a change: the principal, or the assistant on what it learned. */
export const CHANGE_SOURCES = ['principal', 'learned'] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

/** Where an identity came from: the principal, the Workspace directory, or calendar history. */
export const IDENTITY_SOURCES = ['principal', 'directory', 'calendar'] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export interface PersonIdentity {
  /** A channel-qualified handle in NanoClaw's user-id form, such as `email:sam@example.com`. */
  readonly handle: string;
  readonly source: IdentitySource;
  readonly added_at: string;
}

export interface PersonInstruction {
  readonly id: string;
  readonly text: string;
  readonly created_at: string;
}

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly organization: string | null;
  readonly notes: string | null;
  readonly level: PersonLevel;
  readonly level_source: ChangeSource;
  /** A short account of why the person has this level. */
  readonly level_basis: string;
  readonly level_set_at: string;
  readonly identities: readonly PersonIdentity[];
  /** Names the principal taught for this person, each meaning only them. */
  readonly remembered_names: readonly string[];
  /** The principal's standing instructions for this person. */
  readonly instructions: readonly PersonInstruction[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PersonSummary {
  readonly id: string;
  readonly name: string;
  readonly organization: string | null;
  readonly level: PersonLevel;
  readonly identities: readonly string[];
}

export type FindMatch = 'identity' | 'remembered-name' | 'name' | 'name-prefix';

export interface FindPeopleResult {
  /** How the people were found, or null when nobody matched. */
  readonly matched_by: FindMatch | null;
  readonly people: readonly PersonSummary[];
}

/** Unvalidated caller input: the store checks every field. */
export interface AddPersonInput {
  readonly name: string;
  readonly level: string;
  /** `principal` when the principal said so; `learned` when the assistant derived it. */
  readonly source: string;
  /**
   * Who chose the level, when it differs from `source`: `learned` when the
   * principal gave the person but not where they stand, so the level stays
   * the assistant's judgment and learning may revise it. Defaults to `source`.
   */
  readonly levelSource?: string;
  readonly basis: string;
  readonly organization?: string;
  readonly notes?: string;
  readonly identity?: string;
  /** Where the identity came from; `principal` by default on the principal's word, required when learned. */
  readonly identitySource?: string;
  readonly rememberedName?: string;
}

/** Unvalidated caller input. An empty organization or notes clears it. */
export interface UpdatePersonInput {
  readonly id: string;
  readonly source: string;
  readonly name?: string;
  readonly organization?: string;
  readonly notes?: string;
  readonly addIdentity?: string;
  readonly identitySource?: string;
  readonly removeIdentity?: string;
  readonly addRememberedName?: string;
  readonly removeRememberedName?: string;
}

export interface SetPersonLevelInput {
  readonly id: string;
  readonly level: string;
  readonly source: string;
  readonly basis: string;
}

export interface PersonInstructionInput {
  /** The person the instruction is for. */
  readonly id: string;
  readonly text: string;
  readonly source: string;
}

export interface RemoveInstructionInput {
  /** The instruction's own ID. */
  readonly id: string;
  readonly source: string;
}

export interface ForgetPersonInput {
  readonly id: string;
  readonly source: string;
}

/** What a forget hook learns of the person being forgotten: enough to find its own data, nothing more. */
export interface ForgottenPerson {
  readonly id: string;
  readonly handles: readonly string[];
}

export type PersonForgetHook = (person: ForgottenPerson) => Promise<void>;

const NAME_MAX_LENGTH = 120;
const ORGANIZATION_MAX_LENGTH = 120;
const BASIS_MAX_LENGTH = 280;
const INSTRUCTION_MAX_LENGTH = 500;
const NOTES_MAX_LENGTH = 2_000;
const QUERY_MAX_LENGTH = 320;
const HANDLE_MAX_LENGTH = 256;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const HOOK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/u;

const LEVEL_LABELS: Readonly<Record<PersonLevel, string>> = {
  'inner-circle': 'the inner circle',
  close: 'close',
  active: 'active',
  known: 'known',
};

// ---------------------------------------------------------------------------
// Forget hooks: other modules purge their own data for a forgotten person.
// ---------------------------------------------------------------------------

const forgetHooks = new Map<string, PersonForgetHook>();

/**
 * Register a module's purge of its own data for a forgotten person (its
 * meetings, inbox routes, timers, holds, thread sessions). Hooks run in
 * registration order before the record is deleted, so a failed hook leaves
 * the person to be forgotten again; each must therefore be idempotent.
 */
export function registerPersonForgetHook(id: string, hook: PersonForgetHook): void {
  if (!HOOK_ID_PATTERN.test(id)) throw new Error(`Person forget hook "${id}" must use "<module-id>:<hook-id>"`);
  if (forgetHooks.has(id)) throw new Error(`Person forget hook "${id}" is already registered`);
  forgetHooks.set(id, hook);
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

function parseLine(value: string, label: string, maxLength: number): string {
  const text = value.trim();
  if (!text || text.length > maxLength || hasControlCharacters(text)) {
    throw new Error(`${label} must be one line of 1 to ${maxLength} characters`);
  }
  return text;
}

function parseOptionalLine(value: string, label: string, maxLength: number): string | null {
  return value.trim() === '' ? null : parseLine(value, label, maxLength);
}

/** Notes may run to several lines; any other control character is refused. */
function parseNotes(value: string): string | null {
  const text = value.trim();
  if (text === '') return null;
  if (
    text.length > NOTES_MAX_LENGTH ||
    [...text].some((character) => character !== '\n' && hasControlCharacters(character))
  ) {
    throw new Error(`Notes must be text of up to ${NOTES_MAX_LENGTH} characters`);
  }
  return text;
}

/** A name as it is compared: accents dropped, lowercased, whitespace collapsed. */
function nameKey(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function nameTokens(key: string): string[] {
  return key.split(/[^\p{L}\p{N}]+/u).filter((token) => token !== '');
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

/** A learned level stops at active, and never replaces one the principal set (R15). */
function assertLevelWritable(
  existing: { readonly name: string; readonly level_source: ChangeSource } | undefined,
  author: ChangeSource,
  level: PersonLevel,
): void {
  if (author === 'learned' && !LEARNED_LEVELS.includes(level)) {
    throw new Error(`Only the principal places someone in ${LEVEL_LABELS[level]}; a learned level stops at active`);
  }
  if (author === 'learned' && existing?.level_source === 'principal') {
    throw new Error(`${existing.name}'s level was set by the principal, so a learned level cannot replace it`);
  }
}

function newId(prefix: 'p' | 'i'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

function noPerson(id: string): Error {
  return new Error(`No person ${JSON.stringify(id)} exists`);
}

// ---------------------------------------------------------------------------
// The fingerprint key: the store runs without one only while it holds no fingerprints.
// ---------------------------------------------------------------------------

function stoppedError(file: string | undefined): Error {
  const where =
    file === undefined ? 'has no place on this host (no instance secrets directory)' : `is missing at ${file}`;
  return new Error(
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
// Identities, remembered names, and reads
// ---------------------------------------------------------------------------

interface IdentityToAdmit {
  readonly handle: string;
  readonly source: IdentitySource;
}

/** An identity to add, checked before any write: its handle, and a source its author may give. */
function identityToAdmit(author: ChangeSource, value: string, source: string | undefined): IdentityToAdmit {
  return { handle: parseIdentity(value), source: identitySourceFor(author, source) };
}

/** Why `handle` cannot be a person's: it is the principal's or the assistant's own, in any spelling. */
async function reservedIdentity(handle: string): Promise<string | undefined> {
  const key = identityMatchKey(handle);
  const profile = await getGwsEaProfile();
  if (profile.assistant_workspace_email !== null) {
    if (identityMatchKey(`email:${profile.assistant_workspace_email}`) === key) {
      return `${handle} is the assistant's own address, not a person's`;
    }
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
 * Give `personId` an identity, inside the caller's transaction. A forgotten
 * identity is refused to learning; the principal adding it back clears its
 * fingerprint. Without a key the store holds no fingerprints, which is
 * checked again here.
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

async function rememberName(personId: string, name: string, now: string): Promise<void> {
  const db = getDb();
  const key = nameKey(name);
  const holder = await db.get<{ readonly person_id: string; readonly name: string; readonly person_name: string }>(
    `SELECT n.person_id, n.name, p.name AS person_name
       FROM gws_ea_people_names n
       JOIN gws_ea_people p ON p.id = n.person_id
      WHERE n.name_key = ?`,
    key,
  );
  if (holder) throw new Error(`${holder.name} already means ${holder.person_name} (${holder.person_id})`);
  await db.run(
    'INSERT INTO gws_ea_people_names (name_key, name, person_id, added_at) VALUES (?, ?, ?, ?)',
    key,
    name,
    personId,
    now,
  );
}

interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly organization: string | null;
  readonly notes: string | null;
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
  readonly organization: string | null;
  readonly level: PersonLevel;
}

const SUMMARY_COLUMNS = 'id, name, organization, level';

/** One person's whole record, for `main` and the host only. */
export async function getPerson(id: string): Promise<Person | undefined> {
  const db = getDb();
  const row = await db.get<PersonRow>(
    `SELECT id, name, organization, notes, level, level_source, level_basis, level_set_at, created_at, updated_at
       FROM gws_ea_people
      WHERE id = ?`,
    id.trim(),
  );
  if (!row) return undefined;
  const identities = await db.all<PersonIdentity>(
    'SELECT handle, source, added_at FROM gws_ea_people_identities WHERE person_id = ? ORDER BY handle',
    row.id,
  );
  const names = await db.all<{ readonly name: string }>(
    'SELECT name FROM gws_ea_people_names WHERE person_id = ? ORDER BY name_key',
    row.id,
  );
  const instructions = await db.all<PersonInstruction>(
    'SELECT id, text, created_at FROM gws_ea_people_instructions WHERE person_id = ? ORDER BY created_at, id',
    row.id,
  );
  return { ...row, identities, remembered_names: names.map((entry) => entry.name), instructions };
}

async function requirePerson(id: string): Promise<Person> {
  const person = await getPerson(id);
  if (!person) throw noPerson(id);
  return person;
}

async function requirePersonRow(id: string): Promise<{ readonly name: string; readonly level_source: ChangeSource }> {
  const row = await getDb().get<{ readonly name: string; readonly level_source: ChangeSource }>(
    'SELECT name, level_source FROM gws_ea_people WHERE id = ?',
    id,
  );
  if (!row) throw noPerson(id);
  return row;
}

/** Summaries in the order given, each with its identities. */
async function summarize(rows: readonly SummaryRow[]): Promise<PersonSummary[]> {
  if (rows.length === 0) return [];
  const handles = new Map<string, string[]>(rows.map((row) => [row.id, []]));
  const identities = await getDb().all<{ readonly person_id: string; readonly handle: string }>(
    'SELECT person_id, handle FROM gws_ea_people_identities ORDER BY handle',
  );
  for (const { person_id, handle } of identities) handles.get(person_id)?.push(handle);
  return rows.map((row) => ({ ...row, identities: handles.get(row.id) ?? [] }));
}

/** The named people, by name. */
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
 * Find people by an identity, or by a name: an exact remembered name first,
 * then an exact name, then names whose words start with every word of the
 * query. The first rule that matches anyone decides.
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
  const remembered = await db.all<{ readonly person_id: string }>(
    'SELECT person_id FROM gws_ea_people_names WHERE name_key = ?',
    key,
  );
  const named = await db.all<{ readonly id: string }>('SELECT id FROM gws_ea_people WHERE name_key = ?', key);
  const queryTokens = nameTokens(key);
  const prefixed = async (): Promise<string[]> => {
    if (queryTokens.length === 0) return [];
    const names = await db.all<{ readonly person_id: string; readonly name_key: string }>(
      `SELECT id AS person_id, name_key FROM gws_ea_people
       UNION ALL
       SELECT person_id, name_key FROM gws_ea_people_names`,
    );
    return names
      .filter((entry) => {
        const tokens = nameTokens(entry.name_key);
        return queryTokens.every((wanted) => tokens.some((token) => token.startsWith(wanted)));
      })
      .map((entry) => entry.person_id);
  };
  return (
    (await found(
      'remembered-name',
      remembered.map((row) => row.person_id),
    )) ??
    (await found(
      'name',
      named.map((row) => row.id),
    )) ??
    (await found('name-prefix', await prefixed())) ?? { matched_by: null, people: [] }
  );
}

/**
 * The level of the person an identity belongs to, or `unknown` when nobody
 * with a record holds it (R13). The only people fact that leaves the store
 * for the host: never a name, a note, or an instruction.
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

/** Keep a new person, with exactly one level. */
export async function addPerson(input: AddPersonInput): Promise<Person> {
  const author = parseChangeSource(input.source);
  const levelSource = input.levelSource === undefined ? author : parseChangeSource(input.levelSource);
  if (levelSource === 'principal') assertPrincipal(author, 'Only the principal sets a level as theirs');
  const name = parseLine(input.name, 'Name', NAME_MAX_LENGTH);
  const level = parseLevel(input.level);
  const basis = parseLine(input.basis, 'Basis', BASIS_MAX_LENGTH);
  const organization =
    input.organization === undefined
      ? null
      : parseOptionalLine(input.organization, 'Organization', ORGANIZATION_MAX_LENGTH);
  const notes = input.notes === undefined ? null : parseNotes(input.notes);
  if (input.identity === undefined && input.identitySource !== undefined) {
    throw new Error('An identity source applies only with an identity');
  }
  const identity =
    input.identity === undefined ? undefined : identityToAdmit(author, input.identity, input.identitySource);
  const rememberedName =
    input.rememberedName === undefined ? undefined : parseLine(input.rememberedName, 'Name', NAME_MAX_LENGTH);
  if (rememberedName !== undefined) assertPrincipal(author, 'Only the principal teaches a name to remember');
  assertLevelWritable(undefined, levelSource, level);

  const key = await loadFingerprintKey();
  const id = newId('p');
  const now = new Date().toISOString();
  const db = getDb();
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO gws_ea_people
         (id, name, name_key, organization, notes, level, level_source, level_basis, level_set_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name,
      nameKey(name),
      organization,
      notes,
      level,
      levelSource,
      basis,
      now,
      now,
      now,
    );
    if (identity !== undefined) await admitIdentity(identity, key, author, id, now);
    if (rememberedName !== undefined) await rememberName(id, rememberedName, now);
  });
  return requirePerson(id);
}

/** Change a person's name, organization, notes, identities, or remembered names, in one transaction. */
export async function updatePerson(input: UpdatePersonInput): Promise<Person> {
  const author = parseChangeSource(input.source);
  const id = input.id.trim();
  const name = input.name === undefined ? undefined : parseLine(input.name, 'Name', NAME_MAX_LENGTH);
  const organization =
    input.organization === undefined
      ? undefined
      : parseOptionalLine(input.organization, 'Organization', ORGANIZATION_MAX_LENGTH);
  const notes = input.notes === undefined ? undefined : parseNotes(input.notes);
  if (input.addIdentity === undefined && input.identitySource !== undefined) {
    throw new Error('An identity source applies only with an identity to add');
  }
  const addIdentity =
    input.addIdentity === undefined ? undefined : identityToAdmit(author, input.addIdentity, input.identitySource);
  const removeIdentity = input.removeIdentity === undefined ? undefined : parseIdentity(input.removeIdentity);
  const addName =
    input.addRememberedName === undefined ? undefined : parseLine(input.addRememberedName, 'Name', NAME_MAX_LENGTH);
  const removeName =
    input.removeRememberedName === undefined
      ? undefined
      : parseLine(input.removeRememberedName, 'Name', NAME_MAX_LENGTH);
  if (addName !== undefined || removeName !== undefined) {
    assertPrincipal(author, 'Only the principal teaches or takes back a name to remember');
  }
  const changes = [name, organization, notes, addIdentity, removeIdentity, addName, removeName];
  if (changes.every((change) => change === undefined)) {
    throw new Error('Nothing to change: give a name, organization, notes, an identity, or a remembered name');
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
    if (removeName !== undefined) {
      const removed = await db.run(
        'DELETE FROM gws_ea_people_names WHERE person_id = ? AND name_key = ?',
        id,
        nameKey(removeName),
      );
      if (removed.changes === 0) {
        throw new Error(`${person.name} has no remembered name ${JSON.stringify(removeName)}`);
      }
    }
    if (addIdentity !== undefined) await admitIdentity(addIdentity, key, author, id, now);
    if (addName !== undefined) await rememberName(id, addName, now);
    if (name !== undefined) {
      await db.run('UPDATE gws_ea_people SET name = ?, name_key = ? WHERE id = ?', name, nameKey(name), id);
    }
    if (organization !== undefined) {
      await db.run('UPDATE gws_ea_people SET organization = ? WHERE id = ?', organization, id);
    }
    if (notes !== undefined) await db.run('UPDATE gws_ea_people SET notes = ? WHERE id = ?', notes, id);
    await db.run('UPDATE gws_ea_people SET updated_at = ? WHERE id = ?', now, id);
  });
  return requirePerson(id);
}

/** Set a person's one level. A learned level stops at active and never replaces the principal's. */
export async function setPersonLevel(input: SetPersonLevelInput): Promise<Person> {
  const author = parseChangeSource(input.source);
  const level = parseLevel(input.level);
  const basis = parseLine(input.basis, 'Basis', BASIS_MAX_LENGTH);
  const id = input.id.trim();
  await loadFingerprintKey();
  const now = new Date().toISOString();
  const db = getDb();
  await db.transaction(async () => {
    assertLevelWritable(await requirePersonRow(id), author, level);
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

/** Keep one of the principal's standing instructions for a person. */
export async function addPersonInstruction(
  input: PersonInstructionInput,
): Promise<PersonInstruction & { readonly person_id: string }> {
  assertPrincipal(parseChangeSource(input.source), 'Only the principal gives a standing instruction for a person');
  const text = parseLine(input.text, 'Instruction', INSTRUCTION_MAX_LENGTH);
  const personId = input.id.trim();
  await loadFingerprintKey();
  const id = newId('i');
  const now = new Date().toISOString();
  const db = getDb();
  await db.transaction(async () => {
    await requirePersonRow(personId);
    await db.run(
      `INSERT INTO gws_ea_people_instructions (id, person_id, text, source, created_at)
       VALUES (?, ?, ?, 'principal', ?)`,
      id,
      personId,
      text,
      now,
    );
    await db.run('UPDATE gws_ea_people SET updated_at = ? WHERE id = ?', now, personId);
  });
  return { id, person_id: personId, text, created_at: now };
}

/** Take back one of the principal's standing instructions. */
export async function removePersonInstruction(
  input: RemoveInstructionInput,
): Promise<{ readonly id: string; readonly person_id: string }> {
  assertPrincipal(parseChangeSource(input.source), 'Only the principal takes back a standing instruction');
  const id = input.id.trim();
  await loadFingerprintKey();
  const now = new Date().toISOString();
  const db = getDb();
  return db.transaction(async () => {
    const row = await db.get<{ readonly person_id: string }>(
      'SELECT person_id FROM gws_ea_people_instructions WHERE id = ?',
      id,
    );
    if (!row) throw new Error(`No instruction ${JSON.stringify(id)} exists`);
    await db.run('DELETE FROM gws_ea_people_instructions WHERE id = ?', id);
    await db.run('UPDATE gws_ea_people SET updated_at = ? WHERE id = ?', now, row.person_id);
    return { id, person_id: row.person_id };
  });
}

/**
 * An `email:` user that NanoClaw grants access to is the operator's to
 * revoke; forgetting never removes a role or a membership on its own.
 */
async function assertNoGrantedAccess(userIds: readonly string[]): Promise<void> {
  const db = getDb();
  for (const userId of userIds) {
    const role = await db.get(
      'SELECT 1 AS present FROM user_roles WHERE user_id = ? OR granted_by = ? LIMIT 1',
      userId,
      userId,
    );
    const member = await db.get(
      'SELECT 1 AS present FROM agent_group_members WHERE user_id = ? OR added_by = ? LIMIT 1',
      userId,
      userId,
    );
    if (role || member) {
      throw new Error(
        `${userId} holds access in NanoClaw (a role or an agent-group membership); remove that access before forgetting this person`,
      );
    }
  }
}

/**
 * Forget a person on the principal's word (R18): every registered hook purges
 * its module's data, then the record, its identities, names, and
 * instructions are deleted with the core `users` and dropped-message rows of
 * its `email:` identities. Only a keyed fingerprint of each identity is kept,
 * so learning cannot bring the person back (KTD8).
 */
export async function forgetPerson(
  input: ForgetPersonInput,
): Promise<{ readonly forgotten: string; readonly identities: number }> {
  assertPrincipal(parseChangeSource(input.source), 'Only the principal can have someone forgotten');
  const id = input.id.trim();
  await loadFingerprintKey();
  const person = await requirePerson(id);
  const handles = person.identities.map((identity) => identity.handle);
  await assertNoGrantedAccess(handles.filter((handle) => handle.startsWith('email:')));
  const key = await forgetKey();

  for (const hook of forgetHooks.values()) await hook({ id, handles });

  const db = getDb();
  return db.transaction(async () => {
    await requirePersonRow(id);
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
    await db.run('DELETE FROM gws_ea_people_instructions WHERE person_id = ?', id);
    await db.run('DELETE FROM gws_ea_people_names WHERE person_id = ?', id);
    await db.run('DELETE FROM gws_ea_people_identities WHERE person_id = ?', id);
    await db.run('DELETE FROM gws_ea_people WHERE id = ?', id);
    for (const userId of forgotten.filter((handle) => handle.startsWith('email:'))) {
      await db.run('DELETE FROM user_dms WHERE user_id = ?', userId);
      await db.run('DELETE FROM unregistered_senders WHERE user_id = ?', userId);
      await db.run('DELETE FROM users WHERE id = ?', userId);
    }
    return { forgotten: id, identities: forgotten.length };
  });
}
