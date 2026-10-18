import type { CallerContext } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import {
  EMAIL_PATTERN,
  hasControlCharacters,
  identityMatchKey,
  normalizePrincipalEmail,
  principalAddressConflict,
  principalAddressesConflict,
  resolvePrincipalAddress,
} from '../../gws-ea/validation.js';
import { ianaTimezone } from '../../timezone.js';
import type { MessagingGroup } from '../../types.js';
import { removeMatchingIdentities } from '../gws-ea-people/db.js';
import { addMember, getMembers, removeMember } from '../permissions/db/agent-group-members.js';
import { upsertUser } from '../permissions/db/users.js';

export interface GwsEaProfile {
  readonly assistant_display_name: string | null;
  readonly assistant_workspace_email: string | null;
  /** The assistant's verified web alias, one of its own addresses (KTD14), or null until one is recorded. */
  readonly assistant_alias: string | null;
  readonly principal_display_name: string | null;
  readonly principal_timezone: string | null;
  readonly main_agent_group_id: string | null;
  /** The agent group the host created for `external-email`, or null until it has. */
  readonly external_email_agent_group_id: string | null;
  readonly browser_agent_group_id: string | null;
  readonly updated_at: string | null;
  /** The principal's email addresses, sorted. */
  readonly principal_emails: readonly string[];
}

/**
 * Who a project document is written for (KTD14): `main` reads live pointers,
 * `external-email` gets nothing but names and its guidance, `browser` gives
 * the assistant's web alias to websites, and any other group what its
 * capabilities allow.
 */
export type ProjectDocAudience = 'main' | 'external-email' | 'browser' | 'other';

export interface ReconcileGwsEaProfileInput {
  readonly assistantDisplayName: string;
  readonly assistantWorkspaceEmail: string;
  /**
   * The principal's name and timezone as create declared them, which seed
   * the profile. Absent once main is published: the principal then changes
   * them through main (`setPrincipalNameAndTimezone`), and a reconcile keeps
   * what the profile holds.
   */
  readonly principalDisplayName?: string;
  readonly principalTimezone?: string;
  readonly mainAgentGroupId: string;
  /**
   * The principal's addresses as create declared them; the profile then holds
   * exactly these. Absent once main is published, when the principal and the
   * operator change them one at a time.
   */
  readonly principalEmails?: readonly string[];
}

export interface VerifiedPrincipalUser {
  readonly user_id: string;
  readonly verified_at: string;
}

export interface PrincipalAddress {
  readonly email: string;
  readonly added_at: string;
}

/** The principal's name and home timezone, as the profile holds them; null until create seeds them. */
export interface PrincipalNameAndTimezone {
  readonly name: string | null;
  readonly timezone: string | null;
}

/** The principal's name and home timezone once main is published, when the profile holds both. */
export interface PublishedNameAndTimezone {
  readonly name: string;
  readonly timezone: string;
}

/**
 * The principal's addresses as every comparison with them reads them (R1,
 * R2): an address is theirs when it reaches one they listed
 * (`principalMatchKey`), and identity and bookkeeping use the spelling they
 * listed, never the one a message or a calendar wrote.
 */
export interface PrincipalRecognizer {
  /** The listed spelling `address` reaches under R1, or undefined when it is none of the principal's. */
  resolve(address: string | undefined): string | undefined;
  /** Whether `address` reaches one of the principal's listed addresses under R1. */
  has(address: string | undefined): boolean;
  /** The listed addresses, sorted, as the profile holds them. */
  readonly listed: readonly string[];
}

function displayName(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120 || hasControlCharacters(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

/**
 * The longest name `main` may set for the principal. A name with titles and
 * a suffix fits well within it, and it keeps a sentence of instructions out
 * of every signature the name reaches.
 */
const PRINCIPAL_NAME_MAX_LENGTH = 80;

/**
 * Why `name` could not be a person's name, or undefined when it could
 * (KTD9). The name reaches every outgoing signature and external-email's
 * instructions, so it carries no address, link or markup: a dot directly
 * before two letters is a domain, which mail clients turn into a link.
 */
function personalNameProblem(name: string): string | undefined {
  if (!name) return 'it is empty';
  if (name.length > PRINCIPAL_NAME_MAX_LENGTH) return `it is longer than ${PRINCIPAL_NAME_MAX_LENGTH} characters`;
  if (hasControlCharacters(name)) return 'it holds a control character';
  if (/@|:\/\/|www\.|\//iu.test(name)) return 'it holds an address or a link';
  if (/[<>`]/u.test(name)) return 'it holds markup';
  if (/\.\p{L}{2}/u.test(name)) return 'it holds a domain name, which mail turns into a link';
  return undefined;
}

function personalName(value: string): string {
  const name = value.trim();
  const problem = personalNameProblem(name);
  if (problem !== undefined) throw new Error(`${JSON.stringify(value)} cannot be a person's name: ${problem}`);
  return name;
}

/**
 * `value` as the principal changes it through main, held as main's container
 * runs in it (`ianaTimezone`): an IANA zone, correctly cased. Refused when it
 * is no zone or a UTC offset.
 */
function principalTimezone(value: string): string {
  const zone = ianaTimezone(value);
  if (zone === undefined) {
    throw new Error(`Principal timezone is not an IANA time zone such as Europe/London: ${JSON.stringify(value)}`);
  }
  return zone;
}

function identifier(value: string, label: string): string {
  if (!value || value.length > 256 || /\s/u.test(value) || hasControlCharacters(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/** A principal address as the profile stores it (`normalizePrincipalEmail`); anything else is refused. */
function principalEmail(value: string): string {
  const email = normalizePrincipalEmail(value);
  if (email === undefined) throw new Error(`Principal email address is invalid: ${JSON.stringify(value)}`);
  return email;
}

/**
 * The assistant and the principal are separate people, so no address is
 * both, and an address is listed in one spelling (R3).
 */
function assertMayList(email: string, listed: readonly string[], assistant: readonly string[]): void {
  const conflict = principalAddressConflict(email, listed, assistant);
  if (conflict !== undefined) throw new Error(conflict);
}

function principalEmails(values: readonly string[], assistantWorkspaceEmail: string): readonly string[] {
  const emails = [...new Set(values.map(principalEmail))];
  if (emails.length === 0) throw new Error('The principal needs at least one email address');
  const conflict = principalAddressesConflict(emails, [assistantWorkspaceEmail]);
  if (conflict !== undefined) throw new Error(conflict);
  return emails;
}

export function validateGwsEaProfileInput(input: ReconcileGwsEaProfileInput): ReconcileGwsEaProfileInput {
  const assistantWorkspaceEmail = input.assistantWorkspaceEmail.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(assistantWorkspaceEmail) || assistantWorkspaceEmail.length > 254) {
    throw new Error('Assistant Workspace email is invalid');
  }
  // The seed is held as main's container runs in it, as a change through main is (`principalTimezone`).
  const seedTimezone = input.principalTimezone === undefined ? undefined : ianaTimezone(input.principalTimezone);
  if (input.principalTimezone !== undefined && seedTimezone === undefined) {
    throw new Error('Principal timezone is invalid');
  }
  return {
    assistantDisplayName: displayName(input.assistantDisplayName, 'Assistant display name'),
    assistantWorkspaceEmail,
    ...(input.principalDisplayName === undefined
      ? {}
      : { principalDisplayName: displayName(input.principalDisplayName, 'Principal display name') }),
    ...(seedTimezone === undefined ? {} : { principalTimezone: seedTimezone }),
    mainAgentGroupId: identifier(input.mainAgentGroupId, 'Main agent group ID'),
    ...(input.principalEmails === undefined
      ? {}
      : { principalEmails: principalEmails(input.principalEmails, assistantWorkspaceEmail) }),
  };
}

export async function listPrincipalAddresses(db: DbDriver = getDb()): Promise<PrincipalAddress[]> {
  return db.all<PrincipalAddress>('SELECT email, added_at FROM gws_ea_principal_addresses ORDER BY email');
}

/** The addresses the profile holds, as listed and sorted. */
async function heldAddresses(): Promise<string[]> {
  return (await listPrincipalAddresses()).map((address) => address.email);
}

/** The recognizer for the principal's `listed` addresses: one value every comparison with them goes through. */
export function principalRecognizer(listed: readonly string[]): PrincipalRecognizer {
  const addresses = [...listed].sort();
  const resolve = (address: string | undefined): string | undefined =>
    address === undefined ? undefined : resolvePrincipalAddress(address, addresses);
  return { resolve, has: (address) => resolve(address) !== undefined, listed: addresses };
}

/** The recognizer for the addresses the profile holds now; before its table exists, it recognizes no one. */
export async function loadPrincipalRecognizer(): Promise<PrincipalRecognizer> {
  if (!(await getDb().hasTable('gws_ea_principal_addresses'))) return principalRecognizer([]);
  return principalRecognizer(await heldAddresses());
}

/** The canonical main's agent group, or null until setup names one. */
export async function getMainAgentGroupId(): Promise<string | null> {
  const row = await getDb().get<{ main_agent_group_id: string | null }>(
    'SELECT main_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
  );
  return row?.main_agent_group_id ?? null;
}

/**
 * main's agent group as this host last read or named it, for code that must
 * answer synchronously, such as a container's environment at spawn (KTD2):
 * read as the host starts (`loadMainAgentGroupId`) and by any spawn that
 * comes first (`ensureMainAgentGroupIdLoaded`), and set when the profile
 * names main (`reconcileGwsEaProfile`), so a main named after the host
 * started is known on its next spawn. Undefined until this host reads it.
 * Main is never rebound, so it cannot go stale.
 */
let knownMainAgentGroup: string | null | undefined;

/** main's agent group as this host knows it, or null before the profile names one. */
export function knownMainAgentGroupId(): string | null {
  return knownMainAgentGroup ?? null;
}

async function readMainAgentGroupId(): Promise<string | null> {
  return (await getDb().hasTable('gws_ea_profile')) ? getMainAgentGroupId() : null;
}

/** Read main's agent group from the profile into `knownMainAgentGroupId`, as the host starts. */
export async function loadMainAgentGroupId(): Promise<void> {
  knownMainAgentGroup = await readMainAgentGroupId();
}

/**
 * Read main's agent group only if this host has not yet, as a spawn does
 * before its environment is composed. What the host's start read or the
 * profile named while this read ran stands.
 */
export async function ensureMainAgentGroupIdLoaded(): Promise<void> {
  if (knownMainAgentGroup !== undefined) return;
  const read = await readMainAgentGroupId();
  knownMainAgentGroup ??= read;
}

/**
 * Refuse every caller but the host and the canonical main. A resource's
 * guard admits any agent whose CLI scope reaches it, so a resource that is
 * main's alone checks here; `resource` names it in the refusal.
 */
export async function assertMainCaller(ctx: CallerContext, resource: string): Promise<void> {
  if (ctx.caller === 'host') return;
  const mainAgentGroupId = await getMainAgentGroupId();
  if (mainAgentGroupId === null || ctx.agentGroupId !== mainAgentGroupId) {
    throw new Error(`The principal's ${resource} are available only to main`);
  }
}

/** `external-email`'s agent group, or null until the host creates it. */
export async function getExternalEmailAgentGroupId(): Promise<string | null> {
  const row = await getDb().get<{ external_email_agent_group_id: string | null }>(
    'SELECT external_email_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
  );
  return row?.external_email_agent_group_id ?? null;
}

/** The host-stamped, sealed browser group. A caller cannot choose this identity. */
export async function getBrowserAgentGroupId(): Promise<string | null> {
  const row = await getDb().get<{ browser_agent_group_id: string | null }>(
    'SELECT browser_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
  );
  return row?.browser_agent_group_id ?? null;
}

export async function setBrowserAgentGroupId(agentGroupId: string): Promise<void> {
  identifier(agentGroupId, 'browser agent group ID');
  const db = getDb();
  await db.transaction(async () => {
    const current = await getBrowserAgentGroupId();
    if (current === agentGroupId) return;
    if (current !== null) throw new Error('browser is already bound to an agent group');
    await db.run('UPDATE gws_ea_profile SET browser_agent_group_id = ? WHERE singleton = 1', agentGroupId);
  });
}

/**
 * Record the agent group the host created for `external-email`. Recording the
 * same group again changes nothing; the pointer never moves to another one.
 */
export async function recordExternalEmailAgentGroupId(agentGroupId: string): Promise<void> {
  identifier(agentGroupId, 'external-email agent group ID');
  const db = getDb();
  await db.transaction(async () => {
    const current = await getExternalEmailAgentGroupId();
    if (current === agentGroupId) return;
    if (current !== null) throw new Error(`external-email is already bound to ${current}`);
    await db.run('UPDATE gws_ea_profile SET external_email_agent_group_id = ? WHERE singleton = 1', agentGroupId);
  });
}

/** Whom `agentGroupId`'s project document is written for. Without a profile every group is `other`. */
export async function projectDocAudience(agentGroupId: string): Promise<ProjectDocAudience> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return 'other';
  const row = await getDb().get<
    Pick<GwsEaProfile, 'main_agent_group_id' | 'external_email_agent_group_id' | 'browser_agent_group_id'>
  >(
    'SELECT main_agent_group_id, external_email_agent_group_id, browser_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
  );
  if (row?.main_agent_group_id === agentGroupId) return 'main';
  if (row?.external_email_agent_group_id === agentGroupId) return 'external-email';
  if (row?.browser_agent_group_id === agentGroupId) return 'browser';
  return 'other';
}

export async function getGwsEaProfile(): Promise<GwsEaProfile> {
  const profile = await getDb().get<Omit<GwsEaProfile, 'principal_emails'>>(
    `SELECT assistant_display_name, assistant_workspace_email, assistant_alias, principal_display_name,
            principal_timezone, main_agent_group_id, external_email_agent_group_id, browser_agent_group_id, updated_at
       FROM gws_ea_profile
      WHERE singleton = 1`,
  );
  if (!profile) throw new Error('GWS-EA profile singleton is missing');
  return { ...profile, principal_emails: await heldAddresses() };
}

/**
 * The addresses the profile names as the assistant's own (KTD14): its
 * Workspace email and, once verified, its web alias.
 */
export function assistantOwnAddresses(
  profile: Pick<GwsEaProfile, 'assistant_workspace_email' | 'assistant_alias'> | undefined,
): string[] {
  return [profile?.assistant_workspace_email, profile?.assistant_alias].filter(
    (address): address is string => typeof address === 'string' && address !== '',
  );
}

/** Mail from an address speaks as the identity `email:<address>`, as the inbox names every sender. */
const EMAIL_IDENTITY = 'email:';

function emailIdentity(email: string): string {
  return `${EMAIL_IDENTITY}${email}`;
}

/**
 * Hold `email` as one of the principal's addresses; holding it already
 * changes nothing. What is the principal's is no person's (KTD8), so a
 * person identity matching the address in any spelling leaves its record in
 * the same transaction. True when the address is new.
 */
async function holdPrincipalAddress(email: string, addedAt: string): Promise<boolean> {
  const db = getDb();
  const result = await db.run(
    'INSERT INTO gws_ea_principal_addresses (email, added_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING',
    email,
    addedAt,
  );
  await removeMatchingIdentities(emailIdentity(email));
  return result.changes > 0;
}

/**
 * Keep `main`'s members in step with the principal's addresses (KTD1): each
 * address's email identity is a member, so the principal's own email reaches
 * `main`, and an email identity no longer theirs is not. A member only, never
 * an owner or admin: no email identity holds a privilege. Safe to repeat;
 * nothing to do until `main` exists.
 */
export async function syncPrincipalMembers(): Promise<void> {
  const mainAgentGroupId = await getMainAgentGroupId();
  if (mainAgentGroupId === null) return;
  const at = new Date().toISOString();
  const db = getDb();
  await db.transaction(async () => {
    const wanted = new Set((await listPrincipalAddresses()).map(({ email }) => emailIdentity(email)));
    for (const userId of wanted) {
      await upsertUser({ id: userId, kind: 'email', display_name: null, created_at: at });
      await addMember({ user_id: userId, agent_group_id: mainAgentGroupId, added_by: null, added_at: at });
    }
    for (const { user_id: userId } of await getMembers(mainAgentGroupId)) {
      if (userId.startsWith(EMAIL_IDENTITY) && !wanted.has(userId)) await removeMember(userId, mainAgentGroupId);
    }
  });
}

/**
 * Main's container runs in the principal's home timezone (KTD7), which the
 * profile holds: its container config's copy is derived here, whenever the
 * profile is reconciled or the principal changes it, so after either the two
 * agree. Written only when it differs, so a reconcile that changes nothing
 * leaves main's config as it was.
 */
async function keepMainInPrincipalTimezone(mainAgentGroupId: string, timezone: string): Promise<void> {
  const config = await getContainerConfig(mainAgentGroupId);
  if (config !== undefined && config.timezone !== timezone) {
    await updateContainerConfigScalars(mainAgentGroupId, { timezone });
  }
}

/** The principal's name and home timezone, as the profile holds them. */
export async function principalNameAndTimezone(): Promise<PrincipalNameAndTimezone> {
  const row = await getDb().get<{ principal_display_name: string | null; principal_timezone: string | null }>(
    'SELECT principal_display_name, principal_timezone FROM gws_ea_profile WHERE singleton = 1',
  );
  if (!row) throw new Error('GWS-EA profile singleton is missing');
  return { name: row.principal_display_name, timezone: row.principal_timezone };
}

/** Make the profile hold exactly `emails`, keeping when each one it already held was added. */
async function replacePrincipalAddresses(emails: readonly string[], addedAt: string): Promise<void> {
  const db = getDb();
  const wanted = new Set(emails);
  for (const { email } of await listPrincipalAddresses()) {
    if (!wanted.has(email)) await db.run('DELETE FROM gws_ea_principal_addresses WHERE email = ?', email);
  }
  for (const email of emails) await holdPrincipalAddress(email, addedAt);
}

export async function reconcileGwsEaProfile(input: ReconcileGwsEaProfileInput): Promise<GwsEaProfile> {
  const validated = validateGwsEaProfileInput(input);
  const db = getDb();
  await db.transaction(async () => {
    const profile = await db.get<{ main_agent_group_id: string | null }>(
      'SELECT main_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
    );
    const group = await db.get<{ id: string }>('SELECT id FROM agent_groups WHERE id = ?', validated.mainAgentGroupId);
    if (!profile) throw new Error('GWS-EA profile singleton is missing');
    if (!group) throw new Error(`Canonical main agent group does not exist: ${validated.mainAgentGroupId}`);
    if (profile.main_agent_group_id !== null && profile.main_agent_group_id !== validated.mainAgentGroupId) {
      throw new Error(`Canonical main is already bound to ${profile.main_agent_group_id}`);
    }
    const now = new Date().toISOString();
    await db.run(
      `UPDATE gws_ea_profile
          SET assistant_display_name = ?,
              assistant_workspace_email = ?,
              principal_display_name = COALESCE(?, principal_display_name),
              principal_timezone = COALESCE(?, principal_timezone),
              main_agent_group_id = ?,
              updated_at = ?
        WHERE singleton = 1`,
      validated.assistantDisplayName,
      validated.assistantWorkspaceEmail,
      validated.principalDisplayName ?? null,
      validated.principalTimezone ?? null,
      validated.mainAgentGroupId,
      now,
    );
    const principal = await principalNameAndTimezone();
    if (principal.name === null || principal.timezone === null) {
      throw new Error("A profile that names main needs the principal's name and timezone");
    }
    await keepMainInPrincipalTimezone(validated.mainAgentGroupId, principal.timezone);
    if (validated.principalEmails) await replacePrincipalAddresses(validated.principalEmails, now);
    await syncPrincipalMembers();
  });
  knownMainAgentGroup = validated.mainAgentGroupId;
  return getGwsEaProfile();
}

/**
 * Change the principal's name, home timezone, or both, on the principal's
 * word (R16). The profile is their one source: main's container timezone is
 * derived from it in the same transaction. A name must be one a person could
 * have (`personalNameProblem`). What the profile already holds is not
 * written again. Returns the values before and after.
 */
export async function setPrincipalNameAndTimezone(change: {
  readonly name?: string;
  readonly timezone?: string;
}): Promise<{ readonly before: PublishedNameAndTimezone; readonly after: PublishedNameAndTimezone }> {
  const name = change.name === undefined ? undefined : personalName(change.name);
  const timezone = change.timezone === undefined ? undefined : principalTimezone(change.timezone);
  const db = getDb();
  return db.transaction(async () => {
    const mainAgentGroupId = await getMainAgentGroupId();
    const held = await principalNameAndTimezone();
    // A profile that names main holds both (`reconcileGwsEaProfile`).
    if (mainAgentGroupId === null || held.name === null || held.timezone === null) {
      throw new Error("Main is not published yet, so the principal's name and timezone are not set");
    }
    const before = { name: held.name, timezone: held.timezone };
    const after = { name: name ?? before.name, timezone: timezone ?? before.timezone };
    if (after.name !== before.name || after.timezone !== before.timezone) {
      await db.run(
        `UPDATE gws_ea_profile
            SET principal_display_name = ?,
                principal_timezone = ?,
                updated_at = ?
          WHERE singleton = 1`,
        after.name,
        after.timezone,
        new Date().toISOString(),
      );
    }
    await keepMainInPrincipalTimezone(mainAgentGroupId, after.timezone);
    return { before, after };
  });
}

async function assistantWorkspaceEmail(): Promise<string | null> {
  const profile = await getDb().get<{ assistant_workspace_email: string | null }>(
    'SELECT assistant_workspace_email FROM gws_ea_profile WHERE singleton = 1',
  );
  return profile?.assistant_workspace_email ?? null;
}

/** The assistant's own addresses as the profile holds them now (`assistantOwnAddresses`). */
async function heldAssistantAddresses(): Promise<string[]> {
  return assistantOwnAddresses(
    await getDb().get<Pick<GwsEaProfile, 'assistant_workspace_email' | 'assistant_alias'>>(
      'SELECT assistant_workspace_email, assistant_alias FROM gws_ea_profile WHERE singleton = 1',
    ),
  );
}

/**
 * `value` as the profile would hold it, refused when it is malformed, the
 * assistant's own address, or another spelling of one the profile holds;
 * `held` says whether the profile holds it already.
 */
export async function proposedPrincipalAddress(
  value: string,
): Promise<{ readonly email: string; readonly held: boolean }> {
  const email = principalEmail(value);
  const held = await heldAddresses();
  assertMayList(email, held, await heldAssistantAddresses());
  return { email, held: held.includes(email) };
}

// ---------------------------------------------------------------------------
// The web alias (KTD13)
// ---------------------------------------------------------------------------

/**
 * The assistant's web alias as its setup stands: the alias once a probe
 * verified it, and until then the address the operator was asked to add and
 * the Message-ID of the latest probe sent to it.
 */
export interface AliasSetup {
  readonly alias: string | null;
  readonly candidate: string | null;
  readonly probe_message_id: string | null;
}

export async function getAliasSetup(): Promise<AliasSetup> {
  const row = await getDb().get<AliasSetup>(
    `SELECT assistant_alias AS alias, alias_candidate AS candidate, alias_probe_message_id AS probe_message_id
       FROM gws_ea_profile
      WHERE singleton = 1`,
  );
  if (!row) throw new Error('GWS-EA profile singleton is missing');
  return row;
}

/**
 * Make `address` the alias the operator is asked to add, or ask for none.
 * A new candidate forgets the previous one's probe, so that probe can never
 * record it; the same candidate keeps its probe. Refused once an alias is
 * verified, and for the assistant's own address or one of the principal's,
 * which no probe may reach.
 */
export async function proposeAliasCandidate(address: string | null): Promise<AliasSetup> {
  const candidate = address === null ? null : normalizePrincipalEmail(address);
  if (candidate === undefined) throw new Error(`The web alias is not an email address: ${JSON.stringify(address)}`);
  const db = getDb();
  return db.transaction(async () => {
    const setup = await getAliasSetup();
    if (setup.alias !== null) throw new Error(`The assistant's web alias is already ${setup.alias}`);
    if (candidate !== null) {
      const own = await assistantWorkspaceEmail();
      if (own !== null && identityMatchKey(`email:${candidate}`) === identityMatchKey(`email:${own}`)) {
        throw new Error(`${candidate} is the assistant's own address, not an alias`);
      }
      if (principalRecognizer(await heldAddresses()).has(candidate)) {
        throw new Error(`${candidate} is the principal's address, not the assistant's`);
      }
    }
    if (setup.candidate === candidate) return setup;
    await db.run(
      `UPDATE gws_ea_profile
          SET alias_candidate = ?, alias_probe_message_id = NULL, updated_at = ?
        WHERE singleton = 1`,
      candidate,
      new Date().toISOString(),
    );
    return getAliasSetup();
  });
}

/** Record the probe sent to `candidate`, only while it is still the candidate. True when recorded. */
export async function recordAliasProbe(candidate: string, messageId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE gws_ea_profile
        SET alias_probe_message_id = ?
      WHERE singleton = 1 AND assistant_alias IS NULL AND alias_candidate = ?`,
    messageId,
    candidate,
  );
  return result.changes > 0;
}

/**
 * Record `candidate` as the assistant's alias once probe `messageId` reached
 * it: in one compare-and-set, only while it is still the candidate and that
 * is still its probe, so a late probe for an earlier candidate records
 * nothing. True when recorded.
 */
export async function recordVerifiedAlias(candidate: string, messageId: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE gws_ea_profile
        SET assistant_alias = alias_candidate,
            alias_candidate = NULL,
            alias_probe_message_id = NULL,
            updated_at = ?
      WHERE singleton = 1 AND assistant_alias IS NULL AND alias_candidate = ? AND alias_probe_message_id = ?`,
    new Date().toISOString(),
    candidate,
    messageId,
  );
  return result.changes > 0;
}

/** A verified principal identity and its direct message with the assistant. */
export interface PrincipalContact {
  readonly userId: string;
  readonly directMessage: MessagingGroup;
}

/**
 * Where the principal is reached: the most recently verified principal
 * identity whose direct message the assistant is still in. While every such
 * message is detached, the most recent one, so a note for main keeps its
 * route; whoever sends to it checks `detached_at` first. Undefined until a
 * principal is bound with a direct message.
 */
export async function principalContact(): Promise<PrincipalContact | undefined> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_principal_users'))) return undefined;
  const row = await db.get<{ user_id: string; messaging_group_id: string }>(
    `SELECT principal.user_id, dm.messaging_group_id
       FROM gws_ea_principal_users principal
       JOIN user_dms dm ON dm.user_id = principal.user_id
       JOIN messaging_groups direct ON direct.id = dm.messaging_group_id
      ORDER BY CASE WHEN direct.detached_at IS NULL OR direct.detached_at = '' THEN 0 ELSE 1 END,
               principal.verified_at DESC, dm.resolved_at DESC
      LIMIT 1`,
  );
  if (!row) return undefined;
  const directMessage = await getMessagingGroup(row.messaging_group_id);
  return directMessage ? { userId: row.user_id, directMessage } : undefined;
}

/**
 * The verified principal user who confirms a change on a card: the one
 * `principalContact` names, while the card can reach their direct message.
 * Undefined until a principal is bound, or while every direct message of
 * theirs is detached.
 */
export async function principalApproverUserId(): Promise<string | undefined> {
  const contact = await principalContact();
  return contact && !contact.directMessage.detached_at ? contact.userId : undefined;
}

/** Add one of the principal's addresses; adding one the profile already holds changes nothing. */
export async function addPrincipalAddress(value: string): Promise<{ readonly email: string; readonly added: boolean }> {
  const email = principalEmail(value);
  const db = getDb();
  return db.transaction(async () => {
    assertMayList(email, await heldAddresses(), await heldAssistantAddresses());
    const added = await holdPrincipalAddress(email, new Date().toISOString());
    await syncPrincipalMembers();
    return { email, added };
  });
}

/** Remove one of the principal's addresses. The principal always keeps at least one. */
export async function removePrincipalAddress(
  value: string,
): Promise<{ readonly email: string; readonly removed: true }> {
  const email = principalEmail(value);
  const db = getDb();
  return db.transaction(async () => {
    const held = await heldAddresses();
    if (!held.includes(email)) throw new Error(`${email} is not one of the principal's addresses`);
    if (held.length === 1) {
      throw new Error(`${email} is the principal's last address; add another before removing it`);
    }
    await db.run('DELETE FROM gws_ea_principal_addresses WHERE email = ?', email);
    await syncPrincipalMembers();
    return { email, removed: true };
  });
}

export async function bindVerifiedPrincipalUser(userId: string, verifiedAt: string): Promise<void> {
  identifier(userId, 'Principal user ID');
  const parsed = new Date(verifiedAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== verifiedAt) {
    throw new Error('Principal verification timestamp is invalid');
  }
  await getDb().run(
    `INSERT INTO gws_ea_principal_users (user_id, verified_at)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET verified_at = excluded.verified_at`,
    userId,
    verifiedAt,
  );
}

export async function listVerifiedPrincipalUsers(): Promise<VerifiedPrincipalUser[]> {
  return getDb().all<VerifiedPrincipalUser>(
    'SELECT user_id, verified_at FROM gws_ea_principal_users ORDER BY verified_at, user_id',
  );
}

export async function isVerifiedPrincipalUser(userId: string): Promise<boolean> {
  return (
    (await getDb().get<{ present: number }>(
      'SELECT 1 AS present FROM gws_ea_principal_users WHERE user_id = ? LIMIT 1',
      userId,
    )) !== undefined
  );
}
