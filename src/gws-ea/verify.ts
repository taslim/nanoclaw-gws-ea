import Database from 'better-sqlite3';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { chmod, open } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { isErrno } from '../community-portal/errors.js';
import type { ForgottenFingerprint } from '../modules/gws-ea-people/forget-handoff.js';
import type { SnapshotManifest } from './operation.js';
import { principalWelcomeEventId, type PrincipalCandidate } from './principal.js';
import { redact } from './redact.js';
import { hostLogFiles, type InstanceRuntimeConfig } from './service.js';
import { GCHAT_CHANNEL_TYPE, GwsEaError } from './types.js';
import { hasControlCharacters, requireCanonicalTimestamp } from './validation.js';

/** How much of the error log's end is read, and how many of its lines are shown. */
const ERROR_LOG_TAIL_BYTES = 64 * 1024;
const ERROR_LOG_TAIL_LINES = 20;
const ERROR_LOG_LINE_CHARACTERS = 300;
/** NanoClaw's log stamp: the host's local time of day, without a date. */
const LOG_STAMP = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\] /u;

export interface ConversationVerificationInput {
  /** The assistant's physical `state/`, which holds NanoClaw's `data`. */
  readonly stateRoot: string;
  readonly mainAgentGroupId: string;
  readonly messagingGroupId: string;
  readonly principalUserId: string;
  readonly adapterInstance: string;
  readonly boundAt: string;
  readonly welcomeEventId: string;
}

export type ConversationNotReadyReason =
  | 'binding_not_ready'
  | 'session_not_ready'
  | 'welcome_not_delivered'
  | 'later_principal_message_missing'
  | 'reply_not_delivered';

export type ConversationVerificationResult =
  | { readonly ready: false; readonly reason: ConversationNotReadyReason }
  | {
      readonly ready: true;
      readonly sessionId: string;
      readonly welcomeInboundId: string;
      readonly welcomeOutboundId: string;
      readonly laterInboundId: string;
      readonly laterOutboundId: string;
      readonly deliveredAt: string;
    };

interface BindingRow {
  readonly main_agent_group_id: string;
  readonly verified_at: string;
  readonly platform_id: string;
}

interface SessionRow {
  readonly id: string;
}

interface InboundRow {
  readonly id: string;
  readonly timestamp: string;
  readonly content: string;
}

interface OutboundRow {
  readonly id: string;
  readonly timestamp: string;
  readonly in_reply_to: string;
}

interface DeliveryRow {
  readonly message_out_id: string;
  readonly status: string;
  readonly delivered_at: string;
}

interface PrincipalBindingRow {
  readonly main_agent_group_id: string;
  readonly user_id: string;
  readonly verified_at: string;
  readonly messaging_group_id: string;
  readonly platform_id: string;
}

export interface PrincipalBindingVerificationInput {
  readonly runtime: Pick<InstanceRuntimeConfig, 'state_root' | 'instance_id'>;
  readonly adapterInstance: string;
  readonly provisioningStartedAt: string;
  readonly selectedMessagingGroupId?: string;
  readonly selectedCandidate?: PrincipalCandidate;
}

export type PrincipalBindingVerificationResult =
  | { readonly status: 'absent' }
  | {
      readonly status: 'matched';
      readonly agentGroupId: string;
      readonly candidate: PrincipalCandidate;
      readonly welcomeEventId: string;
    };

function timestamp(value: string, label: string): string {
  return requireCanonicalTimestamp(value, 'invalid_verification_input', `${label} is not a canonical timestamp`);
}

function safeIdentifier(value: string, label: string): string {
  if (value.length === 0 || value.length > 512 || hasControlCharacters(value)) {
    throw new GwsEaError('invalid_verification_input', `${label} is invalid`);
  }
  return value;
}

/**
 * `main`'s conversation session as core's agent-shared routing finds it
 * (`findSessionByAgentGroup`): the newest active session that is not a system
 * thread, whatever messaging group it was created for.
 */
function mainSessionId(central: Database.Database, agentGroupId: string): string | undefined {
  const session = central
    .prepare(
      `SELECT id FROM sessions
        WHERE agent_group_id = ?
          AND status = 'active'
          AND NOT (messaging_group_id IS NULL AND thread_id IS NOT NULL AND thread_id LIKE 'system:%')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(agentGroupId) as SessionRow | undefined;
  return session?.id;
}

/** SQLite's largest backup step: every remaining page at once. */
const SINGLE_STEP_PAGES = 0x7fffffff;

/** Where SQLite's file header records its write and read format versions: 2 for WAL, 1 for a rollback journal. */
const FORMAT_VERSION_OFFSETS = [18, 19] as const;
const WAL_FORMAT = 2;
const ROLLBACK_FORMAT = 1;

/** A WAL database no connection has open: its writer closed it, so no `-wal` file remains. */
function isClosedWalDatabase(file: string): boolean {
  if (existsSync(`${file}-wal`)) return false;
  const header = Buffer.alloc(FORMAT_VERSION_OFFSETS[1] + 1);
  const descriptor = openSync(file, 'r');
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  return FORMAT_VERSION_OFFSETS.every((offset) => header[offset] === WAL_FORMAT);
}

/**
 * Open a database read-only without creating anything beside it. SQLite
 * opens a WAL database by creating its `-wal` and `-shm` files, even for a
 * read-only connection, and leaves them behind. A WAL database no connection
 * has open holds every committed page in its main file, so it is read from an
 * in-memory copy marked as a rollback-journal database, which SQLite reads
 * without side files. One a writer has open already has its side files, and
 * is read in place. So is one a writer opened while it was copied: that
 * writer's `-wal` holds commits the copied main file may lack.
 */
function openReadonly(file: string): Database.Database {
  try {
    if (isClosedWalDatabase(file)) {
      const contents = readFileSync(file);
      if (!existsSync(`${file}-wal`)) {
        for (const offset of FORMAT_VERSION_OFFSETS) contents[offset] = ROLLBACK_FORMAT;
        return new Database(contents, { readonly: true });
      }
    }
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    throw new GwsEaError('verification_state_missing', 'Required instance message state is missing');
  }
}

/**
 * Read the authoritative principal binding and queued bootstrap welcome without
 * invoking the mutating bootstrap command. This is the bind phase postcondition.
 */
export function verifyPrincipalBinding(input: PrincipalBindingVerificationInput): PrincipalBindingVerificationResult {
  const adapterInstance = safeIdentifier(input.adapterInstance, 'adapter instance');
  const provisioningStartedAt = timestamp(input.provisioningStartedAt, 'provisioning timestamp');
  const candidate = input.selectedCandidate;
  if (!candidate || candidate.authenticatedMessageAt < provisioningStartedAt) return { status: 'absent' };
  const selectedMessagingGroupId = input.selectedMessagingGroupId;
  if (selectedMessagingGroupId !== undefined) safeIdentifier(selectedMessagingGroupId, 'messaging group ID');
  if (selectedMessagingGroupId !== undefined && selectedMessagingGroupId !== candidate.messagingGroupId) {
    throw new GwsEaError(
      'principal_selection_mismatch',
      'Principal selection does not match the requested conversation',
    );
  }
  const stateRoot = path.resolve(input.runtime.state_root);
  const central = openReadonly(path.join(stateRoot, 'data', 'v2.db'));
  let row: PrincipalBindingRow | undefined;
  let sessionId: string | undefined;
  try {
    const rows = central
      .prepare(
        `SELECT p.main_agent_group_id,
                pu.user_id,
                pu.verified_at,
                mg.id AS messaging_group_id,
                mg.platform_id
           FROM gws_ea_profile p
           JOIN gws_ea_principal_users pu ON pu.user_id = ?
           JOIN user_dms ud ON ud.user_id = pu.user_id AND ud.channel_type = ?
           JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
           JOIN messaging_group_agents mga
             ON mga.messaging_group_id = mg.id AND mga.agent_group_id = p.main_agent_group_id
           JOIN agent_group_members member
             ON member.user_id = pu.user_id AND member.agent_group_id = p.main_agent_group_id
          WHERE p.singleton = 1
            -- A global role's NULL group escapes the key, so a retried grant can repeat the owner row.
            AND EXISTS (
              SELECT 1 FROM user_roles owner
               WHERE owner.user_id = pu.user_id AND owner.role = 'owner' AND owner.agent_group_id IS NULL
            )
            AND p.main_agent_group_id IS NOT NULL
            AND mg.channel_type = ?
            AND mg.instance = ?
            AND mg.id = ?
            AND mg.platform_id = ?
            AND mg.is_group = 0
            AND mga.sender_scope = 'known'
            AND mga.session_mode = 'agent-shared'
            AND pu.verified_at = ?`,
      )
      .all(
        candidate.userId,
        GCHAT_CHANNEL_TYPE,
        GCHAT_CHANNEL_TYPE,
        adapterInstance,
        candidate.messagingGroupId,
        candidate.platformId,
        candidate.authenticatedMessageAt,
      ) as PrincipalBindingRow[];
    if (rows.length !== 1) return { status: 'absent' };
    [row] = rows;
    sessionId = mainSessionId(central, row.main_agent_group_id);
  } finally {
    central.close();
  }

  if (!row || !sessionId) return { status: 'absent' };
  const welcomeEventId = principalWelcomeEventId(input.runtime, row.main_agent_group_id, candidate);
  const inbound = openReadonly(
    path.join(stateRoot, 'data', 'v2-sessions', row.main_agent_group_id, sessionId, 'inbound.db'),
  );
  try {
    const welcome = inbound
      .prepare(
        `SELECT id FROM messages_in
          WHERE id = ? AND timestamp >= ? AND channel_type = ? AND platform_id = ?
            AND kind IN ('chat', 'chat-sdk') AND trigger = 1`,
      )
      .get(
        `${welcomeEventId}:${row.main_agent_group_id}`,
        candidate.authenticatedMessageAt,
        GCHAT_CHANNEL_TYPE,
        row.platform_id,
      );
    if (!welcome) return { status: 'absent' };
  } finally {
    inbound.close();
  }
  return { status: 'matched', agentGroupId: row.main_agent_group_id, candidate, welcomeEventId };
}

function exactDeliveredReply(
  inbound: Database.Database,
  outbound: Database.Database,
  inReplyTo: string,
  platformId: string,
): { outbound: OutboundRow; delivery: DeliveryRow } | undefined {
  const outputs = outbound
    .prepare(
      `SELECT id, timestamp, in_reply_to
         FROM messages_out
        WHERE in_reply_to = ? AND channel_type = ? AND platform_id = ?
          AND kind NOT IN ('system', 'task_log')
        ORDER BY timestamp, id`,
    )
    .iterate(inReplyTo, GCHAT_CHANNEL_TYPE, platformId) as IterableIterator<OutboundRow>;
  for (const output of outputs) {
    const delivery = inbound
      .prepare(
        `SELECT message_out_id, status, delivered_at
           FROM delivered
          WHERE message_out_id = ? AND status = 'delivered'`,
      )
      .get(output.id) as DeliveryRow | undefined;
    if (delivery && delivery.delivered_at >= output.timestamp) return { outbound: output, delivery };
  }
  return undefined;
}

function isAuthenticatedPrincipalChatSdkMessage(content: string, principalUserId: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
    /* eslint-disable-next-line no-catch-all/no-catch-all -- Malformed untrusted message content is not principal evidence. */
  } catch {
    return false;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const rawPrincipalId = principalUserId.startsWith(`${GCHAT_CHANNEL_TYPE}:`)
    ? principalUserId.slice(`${GCHAT_CHANNEL_TYPE}:`.length)
    : principalUserId;
  const author =
    message.author !== null && typeof message.author === 'object' && !Array.isArray(message.author)
      ? (message.author as Record<string, unknown>)
      : undefined;
  return message.senderId === rawPrincipalId && author?.userId === rawPrincipalId;
}

/**
 * Correlate authoritative central and mailbox state. No process-health or
 * queued-message shortcut can return ready: both the welcome and a later
 * principal turn need an assistant output marked delivered.
 */
export function verifyTalkableConversation(input: ConversationVerificationInput): ConversationVerificationResult {
  const stateRoot = path.resolve(input.stateRoot);
  const mainAgentGroupId = safeIdentifier(input.mainAgentGroupId, 'main agent group ID');
  const messagingGroupId = safeIdentifier(input.messagingGroupId, 'messaging group ID');
  const principalUserId = safeIdentifier(input.principalUserId, 'principal user ID');
  const adapterInstance = safeIdentifier(input.adapterInstance, 'adapter instance');
  const boundAt = timestamp(input.boundAt, 'binding timestamp');
  const welcomeEventId = safeIdentifier(input.welcomeEventId, 'welcome event ID');
  const central = openReadonly(path.join(stateRoot, 'data', 'v2.db'));

  let sessionId: string;
  let platformId: string;
  try {
    const binding = central
      .prepare(
        `SELECT p.main_agent_group_id, pu.verified_at, mg.platform_id
           FROM gws_ea_profile p
           JOIN gws_ea_principal_users pu ON pu.user_id = ?
           JOIN user_dms ud
             ON ud.user_id = pu.user_id AND ud.channel_type = ?
           JOIN messaging_groups mg
             ON mg.id = ud.messaging_group_id
           JOIN messaging_group_agents mga
             ON mga.messaging_group_id = mg.id AND mga.agent_group_id = p.main_agent_group_id
          WHERE p.singleton = 1
            AND p.main_agent_group_id = ?
            AND mg.id = ?
            AND mg.channel_type = ?
            AND mg.instance = ?
            AND mg.is_group = 0
            AND mga.sender_scope = 'known'
            AND mga.session_mode = 'agent-shared'`,
      )
      .get(
        principalUserId,
        GCHAT_CHANNEL_TYPE,
        mainAgentGroupId,
        messagingGroupId,
        GCHAT_CHANNEL_TYPE,
        adapterInstance,
      ) as BindingRow | undefined;
    if (!binding || binding.verified_at > boundAt) return { ready: false, reason: 'binding_not_ready' };
    platformId = binding.platform_id;

    const session = mainSessionId(central, mainAgentGroupId);
    if (!session) return { ready: false, reason: 'session_not_ready' };
    sessionId = session;
  } finally {
    central.close();
  }

  const mailboxRoot = path.join(stateRoot, 'data', 'v2-sessions', mainAgentGroupId, sessionId);
  const inbound = openReadonly(path.join(mailboxRoot, 'inbound.db'));
  let outbound: Database.Database | undefined;
  try {
    outbound = openReadonly(path.join(mailboxRoot, 'outbound.db'));
    const welcomeInboundId = `${welcomeEventId}:${mainAgentGroupId}`;
    const welcome = inbound
      .prepare(
        `SELECT id, timestamp, content
           FROM messages_in
          WHERE id = ? AND timestamp >= ? AND channel_type = ? AND platform_id = ?
            AND kind IN ('chat', 'chat-sdk') AND trigger = 1`,
      )
      .get(welcomeInboundId, boundAt, GCHAT_CHANNEL_TYPE, platformId) as InboundRow | undefined;
    if (!welcome) return { ready: false, reason: 'welcome_not_delivered' };
    const welcomeReply = exactDeliveredReply(inbound, outbound, welcome.id, platformId);
    if (!welcomeReply) return { ready: false, reason: 'welcome_not_delivered' };

    const laterMessages = inbound
      .prepare(
        `SELECT id, timestamp, content
           FROM messages_in
          WHERE id <> ? AND timestamp > ? AND channel_type = ? AND platform_id = ?
            AND kind = 'chat-sdk' AND trigger = 1
          ORDER BY timestamp, id`,
      )
      .iterate(
        welcome.id,
        welcomeReply.delivery.delivered_at,
        GCHAT_CHANNEL_TYPE,
        platformId,
      ) as IterableIterator<InboundRow>;
    let foundPrincipalMessage = false;
    for (const later of laterMessages) {
      if (!isAuthenticatedPrincipalChatSdkMessage(later.content, principalUserId)) continue;
      foundPrincipalMessage = true;
      const reply = exactDeliveredReply(inbound, outbound, later.id, platformId);
      if (!reply || reply.outbound.timestamp < later.timestamp) continue;
      return {
        ready: true,
        sessionId,
        welcomeInboundId: welcome.id,
        welcomeOutboundId: welcomeReply.outbound.id,
        laterInboundId: later.id,
        laterOutboundId: reply.outbound.id,
        deliveredAt: reply.delivery.delivered_at,
      };
    }
    return {
      ready: false,
      reason: foundPrincipalMessage ? 'reply_not_delivered' : 'later_principal_message_missing',
    };
  } finally {
    outbound?.close();
    inbound.close();
  }
}

function centralDatabaseFile(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), 'data', 'v2.db');
}

function hasTable(database: Database.Database, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** Each session database under `stateRoot`'s `data`, keyed by its mailbox side: `inbound` or `outbound`. */
function sessionDatabases(stateRoot: string): Array<{ readonly side: string; readonly file: string }> {
  const directories = (directory: string): string[] => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(directory, entry.name));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }
  };
  const found: Array<{ side: string; file: string }> = [];
  for (const group of directories(path.join(path.resolve(stateRoot), 'data', 'v2-sessions'))) {
    for (const session of directories(group)) {
      for (const entry of readdirSync(session, { withFileTypes: true })) {
        const side = entry.isFile() ? /^(inbound|outbound)\.db$/u.exec(entry.name)?.[1] : undefined;
        if (side) found.push({ side, file: path.join(session, entry.name) });
      }
    }
  }
  return found;
}

/**
 * The schema the databases under `stateRoot`'s `data` record (KTD5): the central migrations
 * applied, in the order they ran, and every session table with its columns,
 * keyed `<side>.<table>` and merged across sessions. Only read, never changed.
 */
export function readSchemaManifest(stateRoot: string): SnapshotManifest {
  const migrations = readCentralMigrations(stateRoot);
  const tables = new Map<string, Set<string>>();
  for (const { side, file } of sessionDatabases(stateRoot)) {
    const session = openReadonly(file);
    try {
      const names = session
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      for (const { name } of names) {
        const columns = tables.get(`${side}.${name}`) ?? new Set<string>();
        for (const column of session.prepare('SELECT name FROM pragma_table_info(?)').all(name) as Array<{
          name: string;
        }>) {
          columns.add(column.name);
        }
        tables.set(`${side}.${name}`, columns);
      }
    } finally {
      session.close();
    }
  }
  return {
    central_migrations: migrations,
    session_tables: Object.fromEntries(
      [...tables.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([table, columns]) => [table, [...columns].sort()]),
    ),
  };
}

/** The central migrations the database under `stateRoot`'s `data` records, in the order they ran. Only read, never changed. */
export function readCentralMigrations(stateRoot: string): string[] {
  const central = openReadonly(centralDatabaseFile(stateRoot));
  try {
    if (!hasTable(central, 'schema_version')) {
      throw new GwsEaError('schema_unrecorded', 'The central database records no migrations');
    }
    return (central.prepare('SELECT name FROM schema_version ORDER BY version').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    central.close();
  }
}

/**
 * Whether a host left the central database under `stateRoot`'s `data` with
 * its claim lease still live at `now`: a host stopped gracefully marks its row
 * stopped, and one that was killed leaves it to expire, which delays the next
 * host's claims. A release without leases has none. Only read.
 */
export function hostLeaseLive(stateRoot: string, now: string): boolean {
  const central = openReadonly(centralDatabaseFile(stateRoot));
  try {
    if (!hasTable(central, 'host_instances')) return false;
    return (
      central
        .prepare('SELECT 1 FROM host_instances WHERE stopped_at IS NULL AND lease_expires_at > ? LIMIT 1')
        .get(now) !== undefined
    );
  } finally {
    central.close();
  }
}

/**
 * The identities forgotten in the central database under `stateRoot`'s
 * `data`, as `gws_ea_people_fingerprints` keeps them (KTD8); none when it has
 * no such table. Only read.
 */
export function readForgottenFingerprints(stateRoot: string): ForgottenFingerprint[] {
  const central = openReadonly(centralDatabaseFile(stateRoot));
  try {
    if (!hasTable(central, 'gws_ea_people_fingerprints')) return [];
    return central
      .prepare('SELECT fingerprint, forgotten_at FROM gws_ea_people_fingerprints ORDER BY fingerprint')
      .all() as ForgottenFingerprint[];
  } finally {
    central.close();
  }
}

/** An agent group whose container runs its own image, built on the base from its saved package lists. */
export interface DerivedImageGroup {
  readonly id: string;
  readonly name: string;
}

/**
 * The agent groups running a per-group image (`<imageBase>:<agent group ID>`,
 * NanoClaw's `buildAgentGroupImage` tag), by name. Only read, never changed.
 */
export function readDerivedImageGroups(stateRoot: string, imageBase: string): DerivedImageGroup[] {
  const central = openReadonly(centralDatabaseFile(stateRoot));
  try {
    if (!hasTable(central, 'container_configs')) return [];
    const rows = central
      .prepare(
        `SELECT g.id, g.name, c.image_tag
           FROM container_configs c JOIN agent_groups g ON g.id = c.agent_group_id
          WHERE c.image_tag IS NOT NULL
          ORDER BY g.name, g.id`,
      )
      .all() as Array<{ id: string; name: string; image_tag: string }>;
    return rows.filter((row) => row.image_tag === `${imageBase}:${row.id}`).map(({ id, name }) => ({ id, name }));
  } finally {
    central.close();
  }
}

/**
 * Copy the central database under `stateRoot`'s `data` to `destination` as one consistent
 * snapshot: an online backup whose every page moves in a single step, so a
 * write the running host makes meanwhile restarts the copy rather than
 * mixing into it. The live database is only read. The copy is owner-only.
 */
export async function backupCentralDatabase(stateRoot: string, destination: string): Promise<void> {
  const central = openReadonly(centralDatabaseFile(stateRoot));
  try {
    await central.backup(destination, { progress: () => SINGLE_STEP_PAGES });
  } finally {
    central.close();
  }
  await chmod(destination, 0o600);
}

/** Main's latest delivery result, as its conversation's mailbox and the host's retry bookkeeping record it. */
export interface LatestDelivery {
  readonly mainAgentGroupId: string;
  /** Main's conversation session, once it has one. */
  readonly sessionId: string | undefined;
  /** The newest result in that session's `delivered` table: `delivered` or `failed`. */
  readonly last: { readonly messageOutId: string; readonly status: string; readonly at: string } | undefined;
  /** That session's replies the host is still retrying (`delivery_attempts`), and the newest error it saw. */
  readonly retrying: number;
  readonly lastError: string | undefined;
}

/** Main's latest delivery result, or undefined until main is published. Only read, never changed. */
export function readLatestDelivery(stateRoot: string): LatestDelivery | undefined {
  const root = path.resolve(stateRoot);
  const central = openReadonly(centralDatabaseFile(root));
  let mainAgentGroupId: string;
  let sessionId: string | undefined;
  let retrying = 0;
  let lastError: string | undefined;
  try {
    if (!hasTable(central, 'gws_ea_profile')) return undefined;
    const profile = central.prepare('SELECT main_agent_group_id FROM gws_ea_profile WHERE singleton = 1').get() as
      | { main_agent_group_id: string | null }
      | undefined;
    if (!profile?.main_agent_group_id) return undefined;
    mainAgentGroupId = profile.main_agent_group_id;
    sessionId = mainSessionId(central, mainAgentGroupId);
    if (sessionId && hasTable(central, 'delivery_attempts')) {
      const attempts = central
        .prepare(
          `SELECT COUNT(*) AS retrying,
                  (SELECT last_error FROM delivery_attempts
                    WHERE session_id = ? AND last_error IS NOT NULL
                    ORDER BY last_attempt_at DESC LIMIT 1) AS last_error
             FROM delivery_attempts WHERE session_id = ?`,
        )
        .get(sessionId, sessionId) as { retrying: number; last_error: string | null };
      retrying = attempts.retrying;
      lastError = attempts.last_error === null ? undefined : printableLogLine(attempts.last_error);
    }
  } finally {
    central.close();
  }
  if (!sessionId) return { mainAgentGroupId, sessionId, last: undefined, retrying, lastError };
  const inbound = openReadonly(path.join(root, 'data', 'v2-sessions', mainAgentGroupId, sessionId, 'inbound.db'));
  let row: DeliveryRow | undefined;
  try {
    row = inbound
      .prepare(
        `SELECT message_out_id, status, delivered_at FROM delivered
          ORDER BY delivered_at DESC, message_out_id DESC LIMIT 1`,
      )
      .get() as DeliveryRow | undefined;
  } finally {
    inbound.close();
  }
  return {
    mainAgentGroupId,
    sessionId,
    last: row ? { messageOutId: row.message_out_id, status: row.status, at: row.delivered_at } : undefined,
    retrying,
    lastError,
  };
}

export interface InstanceErrorLog {
  readonly file: string;
  /** The last lines of the entries logged at or after the given instant, oldest first, redacted. */
  readonly lines: readonly string[];
}

function millisecondOfDay(hours: number, minutes: number, seconds: number, milliseconds: number): number {
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

/**
 * A name an agent can choose (a file in its folder, a group, a task, a
 * message ID in its outbound mailbox), made safe to print on the operator's
 * terminal. Every control and format character, which could move the cursor,
 * erase or rewrite a line, reach the clipboard, or reorder text, is shown as
 * its JSON escape, and so is a backslash, so what is shown reads back as
 * exactly one name. Unlike a log line, nothing is dropped: the operator sees
 * the name the file really has. JSON output keeps the raw name.
 */
export function printableName(name: string): string {
  return name.replace(/[\p{Cc}\p{Cf}\\]/gu, (character) => {
    switch (character) {
      case '\\':
        return '\\\\';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        // One escape per UTF-16 unit, as JSON writes a character outside the Basic Multilingual Plane.
        return Array.from(
          { length: character.length },
          (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`,
        ).join('');
    }
  });
}

function printableLogLine(line: string): string {
  const text = [...stripVTControlCharacters(line)]
    .map((character) => (hasControlCharacters(character) ? ' ' : character))
    .join('')
    .trimEnd();
  return redact(text).slice(0, ERROR_LOG_LINE_CHARACTERS);
}

/**
 * What the host of the assistant at `instanceRoot` logged as warnings and
 * errors since `since`, from the end of its physical `logs/nanoclaw.error.log`,
 * which is there whether or not a release is live. NanoClaw stamps each entry with
 * its local time of day only, so each entry's date is recovered walking back
 * from the file's last write, one day earlier at each rollover; lines without
 * a stamp (stack traces) belong to the entry above them.
 */
export async function instanceErrorsSince(instanceRoot: string, since: string): Promise<InstanceErrorLog> {
  const file = hostLogFiles(path.resolve(instanceRoot)).errors;
  const sinceMs = new Date(timestamp(since, 'error log start')).getTime();
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { file, lines: [] };
    throw error;
  }
  try {
    const { size, mtime } = await handle.stat();
    if (mtime.getTime() < sinceMs) return { file, lines: [] };
    const length = Math.min(size, ERROR_LOG_TAIL_BYTES);
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // A window that starts inside the file starts inside a line.
    if (length < size) lines.shift();

    const kept: string[] = [];
    let entry: string[] = [];
    let daysBack = 0;
    let laterOfDay = millisecondOfDay(
      mtime.getHours(),
      mtime.getMinutes(),
      mtime.getSeconds(),
      mtime.getMilliseconds(),
    );
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      const stamp = LOG_STAMP.exec(line);
      if (!stamp) {
        if (line.trim()) entry.unshift(line);
        continue;
      }
      const [hours, minutes, seconds, milliseconds] = stamp.slice(1).map(Number) as [number, number, number, number];
      const ofDay = millisecondOfDay(hours, minutes, seconds, milliseconds);
      if (ofDay > laterOfDay) daysBack += 1;
      laterOfDay = ofDay;
      const at = new Date(
        mtime.getFullYear(),
        mtime.getMonth(),
        mtime.getDate() - daysBack,
        hours,
        minutes,
        seconds,
        milliseconds,
      );
      if (at.getTime() < sinceMs) break;
      kept.unshift(line, ...entry);
      entry = [];
    }
    return { file, lines: kept.slice(-ERROR_LOG_TAIL_LINES).map(printableLogLine) };
  } finally {
    await handle.close();
  }
}
