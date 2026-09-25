import Database from 'better-sqlite3';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { isErrno } from '../community-portal/errors.js';
import { principalWelcomeEventId, type PrincipalCandidate } from './principal.js';
import { redact } from './redact.js';
import type { InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { hasControlCharacters } from './validation.js';

const CHANNEL_TYPE = 'gchat';

/** How much of the error log's end is read, and how many of its lines are shown. */
const ERROR_LOG_TAIL_BYTES = 64 * 1024;
const ERROR_LOG_TAIL_LINES = 20;
const ERROR_LOG_LINE_CHARACTERS = 300;
/** NanoClaw's log stamp: the host's local time of day, without a date. */
const LOG_STAMP = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\] /u;

export interface ConversationVerificationInput {
  readonly checkoutRoot: string;
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
  readonly runtime: Pick<InstanceRuntimeConfig, 'checkout_realpath' | 'instance_id'>;
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

function canonicalTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new GwsEaError('invalid_verification_input', `${label} is not a canonical timestamp`);
  }
  return value;
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

function openReadonly(file: string): Database.Database {
  try {
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
  const provisioningStartedAt = canonicalTimestamp(input.provisioningStartedAt, 'provisioning timestamp');
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
  const checkoutRoot = path.resolve(input.runtime.checkout_realpath);
  const central = openReadonly(path.join(checkoutRoot, 'data', 'v2.db'));
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
           JOIN user_roles owner
             ON owner.user_id = pu.user_id AND owner.role = 'owner' AND owner.agent_group_id IS NULL
          WHERE p.singleton = 1
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
        CHANNEL_TYPE,
        CHANNEL_TYPE,
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
    path.join(checkoutRoot, 'data', 'v2-sessions', row.main_agent_group_id, sessionId, 'inbound.db'),
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
        CHANNEL_TYPE,
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
    .iterate(inReplyTo, CHANNEL_TYPE, platformId) as IterableIterator<OutboundRow>;
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
  const rawPrincipalId = principalUserId.startsWith(`${CHANNEL_TYPE}:`)
    ? principalUserId.slice(`${CHANNEL_TYPE}:`.length)
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
  const checkoutRoot = path.resolve(input.checkoutRoot);
  const mainAgentGroupId = safeIdentifier(input.mainAgentGroupId, 'main agent group ID');
  const messagingGroupId = safeIdentifier(input.messagingGroupId, 'messaging group ID');
  const principalUserId = safeIdentifier(input.principalUserId, 'principal user ID');
  const adapterInstance = safeIdentifier(input.adapterInstance, 'adapter instance');
  const boundAt = canonicalTimestamp(input.boundAt, 'binding timestamp');
  const welcomeEventId = safeIdentifier(input.welcomeEventId, 'welcome event ID');
  const central = openReadonly(path.join(checkoutRoot, 'data', 'v2.db'));

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
      .get(principalUserId, CHANNEL_TYPE, mainAgentGroupId, messagingGroupId, CHANNEL_TYPE, adapterInstance) as
      | BindingRow
      | undefined;
    if (!binding || binding.verified_at > boundAt) return { ready: false, reason: 'binding_not_ready' };
    platformId = binding.platform_id;

    const session = mainSessionId(central, mainAgentGroupId);
    if (!session) return { ready: false, reason: 'session_not_ready' };
    sessionId = session;
  } finally {
    central.close();
  }

  const mailboxRoot = path.join(checkoutRoot, 'data', 'v2-sessions', mainAgentGroupId, sessionId);
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
      .get(welcomeInboundId, boundAt, CHANNEL_TYPE, platformId) as InboundRow | undefined;
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
        CHANNEL_TYPE,
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

export interface InstanceErrorLog {
  readonly file: string;
  /** The last lines of the entries logged at or after the given instant, oldest first, redacted. */
  readonly lines: readonly string[];
}

function millisecondOfDay(hours: number, minutes: number, seconds: number, milliseconds: number): number {
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

function printableLogLine(line: string): string {
  const text = [...stripVTControlCharacters(line)]
    .map((character) => (hasControlCharacters(character) ? ' ' : character))
    .join('')
    .trimEnd();
  return redact(text).slice(0, ERROR_LOG_LINE_CHARACTERS);
}

/**
 * What the instance's host logged as warnings and errors since `since`, from
 * the end of its `logs/nanoclaw.error.log`. NanoClaw stamps each entry with
 * its local time of day only, so each entry's date is recovered walking back
 * from the file's last write, one day earlier at each rollover; lines without
 * a stamp (stack traces) belong to the entry above them.
 */
export async function instanceErrorsSince(checkoutRoot: string, since: string): Promise<InstanceErrorLog> {
  const file = path.join(path.resolve(checkoutRoot), 'logs', 'nanoclaw.error.log');
  const sinceMs = new Date(canonicalTimestamp(since, 'error log start')).getTime();
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
