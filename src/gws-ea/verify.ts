import Database from 'better-sqlite3';
import path from 'node:path';

import { principalWelcomeEventId, type PrincipalCandidate } from './principal.js';
import type { InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';

const CHANNEL_TYPE = 'gchat';

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
  readonly sender_name: string | null;
  readonly authenticated_message_id: string;
  readonly authenticated_message_at: string;
}

export interface PrincipalBindingVerificationInput {
  readonly runtime: Pick<InstanceRuntimeConfig, 'checkout_realpath' | 'instance_id'>;
  readonly adapterInstance: string;
  readonly provisioningStartedAt: string;
  readonly selectedMessagingGroupId?: string;
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
  if (
    value.length === 0 ||
    value.length > 512 ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  ) {
    throw new GwsEaError('invalid_verification_input', `${label} is invalid`);
  }
  return value;
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
  const selectedMessagingGroupId = input.selectedMessagingGroupId;
  if (selectedMessagingGroupId !== undefined) safeIdentifier(selectedMessagingGroupId, 'messaging group ID');
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
                mg.platform_id,
                dropped.sender_name,
                dropped.authenticated_message_id,
                dropped.authenticated_message_at
           FROM gws_ea_profile p
           JOIN gws_ea_principal_users pu ON 1 = 1
           JOIN user_dms ud ON ud.user_id = pu.user_id AND ud.channel_type = ?
           JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
           JOIN messaging_group_agents mga
             ON mga.messaging_group_id = mg.id AND mga.agent_group_id = p.main_agent_group_id
           JOIN agent_group_members member
             ON member.user_id = pu.user_id AND member.agent_group_id = p.main_agent_group_id
           JOIN user_roles owner
             ON owner.user_id = pu.user_id AND owner.role = 'owner' AND owner.agent_group_id IS NULL
           JOIN unregistered_senders dropped
             ON dropped.channel_type = mg.channel_type
            AND dropped.platform_id = mg.platform_id
            AND dropped.instance = mg.instance
            AND dropped.user_id = pu.user_id
            AND dropped.messaging_group_id = mg.id
          WHERE p.singleton = 1
            AND p.main_agent_group_id IS NOT NULL
            AND mg.channel_type = ?
            AND mg.instance = ?
            AND mg.is_group = 0
            AND mga.sender_scope = 'known'
            AND mga.session_mode = 'agent-shared'
            AND dropped.reason = 'no_agent_wired'
            AND dropped.sender_authenticated = 1
            AND dropped.sender_kind = 'human'
            AND dropped.is_group = 0
            AND dropped.authenticated_message_id IS NOT NULL
            AND dropped.authenticated_message_at >= ?
            AND (? IS NULL OR mg.id = ?)
          ORDER BY dropped.authenticated_message_at, mg.id`,
      )
      .all(
        CHANNEL_TYPE,
        CHANNEL_TYPE,
        adapterInstance,
        provisioningStartedAt,
        selectedMessagingGroupId ?? null,
        selectedMessagingGroupId ?? null,
      ) as PrincipalBindingRow[];
    if (rows.length !== 1) return { status: 'absent' };
    [row] = rows;
    if (!row || row.verified_at !== row.authenticated_message_at) return { status: 'absent' };
    const sessions = central
      .prepare(
        `SELECT id FROM sessions
          WHERE agent_group_id = ? AND messaging_group_id IS NULL
            AND thread_id IS NULL AND status = 'active'
          ORDER BY id`,
      )
      .all(row.main_agent_group_id) as SessionRow[];
    if (sessions.length !== 1) return { status: 'absent' };
    sessionId = sessions[0]!.id;
  } finally {
    central.close();
  }

  if (!row || !sessionId) return { status: 'absent' };
  const candidate: PrincipalCandidate = {
    messagingGroupId: row.messaging_group_id,
    platformId: row.platform_id,
    userId: row.user_id,
    senderName: row.sender_name,
    authenticatedMessageId: row.authenticated_message_id,
    authenticatedMessageAt: row.authenticated_message_at,
  };
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
      .get(`${welcomeEventId}:${row.main_agent_group_id}`, row.authenticated_message_at, CHANNEL_TYPE, row.platform_id);
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
    .all(inReplyTo, CHANNEL_TYPE, platformId) as OutboundRow[];
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

    const sessions = central
      .prepare(
        `SELECT id
           FROM sessions
          WHERE agent_group_id = ?
            AND messaging_group_id IS NULL
            AND thread_id IS NULL
            AND status = 'active'
          ORDER BY id`,
      )
      .all(mainAgentGroupId) as SessionRow[];
    if (sessions.length !== 1) return { ready: false, reason: 'session_not_ready' };
    sessionId = sessions[0]!.id;
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
      .all(welcome.id, welcomeReply.delivery.delivered_at, CHANNEL_TYPE, platformId) as InboundRow[];
    const principalMessages = laterMessages.filter((message) =>
      isAuthenticatedPrincipalChatSdkMessage(message.content, principalUserId),
    );
    if (principalMessages.length === 0) return { ready: false, reason: 'later_principal_message_missing' };

    for (const later of principalMessages) {
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
    return { ready: false, reason: 'reply_not_delivered' };
  } finally {
    outbound?.close();
    inbound.close();
  }
}
