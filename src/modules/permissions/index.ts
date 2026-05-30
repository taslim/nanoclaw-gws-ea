/**
 * Permissions module — sender resolution + access gate.
 *
 * Registers two hooks into the core router:
 *   1. setSenderResolver — runs before agent resolution. Parses the payload,
 *      derives a namespaced user id, and upserts the `users` row on first
 *      sight. Returns null when the payload doesn't carry enough to identify
 *      a sender.
 *   2. setAccessGate — runs after agent resolution. Enforces the
 *      unknown_sender_policy (strict/request_approval/public) and the
 *      owner/global-admin/scoped-admin/member access hierarchy. Records its
 *      own `dropped_messages` row on refusal (structural drops are recorded
 *      by core).
 *
 * Without this module: sender resolution is a no-op (userId=null); the
 * access gate is not registered and core defaults to allow-all.
 */
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { registerDeliveryAction } from '../../delivery.js';
import {
  createMessagingGroupAgent,
  setMessagingGroupDeniedAt,
  updateMessagingGroup,
} from '../../db/messaging-groups.js';
import {
  routeInbound,
  setAccessGate,
  setChannelRequestGate,
  setMessageInterceptor,
  setSenderResolver,
  setSenderScopeGate,
  type AccessGateResult,
} from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent, SenderScope } from '../../types.js';
import { canAccessAgentGroup } from './access.js';
import {
  buildAgentSelectionOptions,
  CHOOSE_EXISTING_VALUE,
  CONNECT_PREFIX,
  createNewAgentGroup,
  NEW_AGENT_VALUE,
  PEER_EA_VALUE,
  REJECT_VALUE,
  requestChannelApproval,
} from './channel-approval.js';
import { addMember } from './db/agent-group-members.js';
import {
  deletePendingChannelApproval,
  getPendingChannelApproval,
  updatePendingChannelApprovalCard,
} from './db/pending-channel-approvals.js';
import { deletePendingSenderApproval, getPendingSenderApproval } from './db/pending-sender-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';
import { getUser, upsertUser } from './db/users.js';
import {
  applySetupPeerEa,
  createPeerEaAgentGroup,
  parseHandshake,
  peerEaPromptCopy,
  wirePeerEaDestinations,
} from './peer-ea.js';
import { requestSenderApproval } from './sender-approval.js';
import { ensureUserDm } from './user-dm.js';

// Tracks approvers waiting for a text reply with the agent name. Keyed
// by namespaced userId. Cleared on receipt or restart. The peer-EA path
// pre-extracts what the handshake + sender pinned so the interceptor
// doesn't have to re-parse the original event; the prompt collapses to
// 1, 2, or 3 fields based on how many slots remain.
interface PendingNameInput {
  channelMgId: string;
  dmChannelType: string;
  dmPlatformId: string;
  mode?: 'peer-ea';
  peerNameFromSender?: string | null;
  peerPrincipalFromSignature?: string | null;
}
const awaitingNameInput = new Map<string, PendingNameInput>();

function extractSenderName(event: InboundEvent): string | null {
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    const direct =
      typeof parsed.senderName === 'string'
        ? parsed.senderName
        : typeof parsed.sender === 'string'
          ? parsed.sender
          : undefined;
    if (direct && direct.trim()) return direct.trim();
    const author =
      typeof parsed.author === 'object' && parsed.author !== null
        ? (parsed.author as Record<string, unknown>)
        : undefined;
    const fromAuthor =
      (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
      (typeof author?.userName === 'string' ? (author.userName as string) : undefined);
    return fromAuthor && fromAuthor.trim() ? fromAuthor.trim() : null;
  } catch {
    return null;
  }
}

function splitFields(text: string): string[] {
  const sep = text.includes('|') ? '|' : ',';
  return text
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function extractAndUpsertUser(event: InboundEvent): string | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }

  // chat-sdk-bridge serializes author info as a nested `author.userId` and
  // does NOT populate top-level `senderId`. Older adapters (v1, native) put
  // `senderId` or `sender` directly at the top level. Check all three.
  const senderIdField = typeof content.senderId === 'string' ? content.senderId : undefined;
  const senderField = typeof content.sender === 'string' ? content.sender : undefined;
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const authorUserId = typeof author?.userId === 'string' ? (author.userId as string) : undefined;
  const senderName =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
    (typeof author?.userName === 'string' ? (author.userName as string) : undefined);

  const rawHandle = senderIdField ?? senderField ?? authorUserId;
  if (!rawHandle) return null;

  const userId = rawHandle.includes(':') ? rawHandle : `${event.channelType}:${rawHandle}`;
  if (!getUser(userId)) {
    upsertUser({
      id: userId,
      kind: event.channelType,
      display_name: senderName ?? null,
      created_at: new Date().toISOString(),
    });
  }
  return userId;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

function handleUnknownSender(
  mg: MessagingGroup,
  userId: string | null,
  agentGroupId: string,
  accessReason: string,
  event: InboundEvent,
): void {
  const parsed = safeParseContent(event.message.content);
  const senderName = parsed.sender ?? null;
  const dropRecord = {
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: userId,
    sender_name: senderName,
    reason: `unknown_sender_${mg.unknown_sender_policy}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
  };

  if (mg.unknown_sender_policy === 'strict') {
    log.info('MESSAGE DROPPED — unknown sender (strict policy)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    return;
  }

  if (mg.unknown_sender_policy === 'request_approval') {
    log.info('MESSAGE DROPPED — unknown sender (approval requested)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    // Fire-and-forget; pick-approver + delivery + row-insert are all async.
    // If it fails it logs internally — the user's message still stays dropped
    // either way. Requires a resolved userId (senderResolver populates users
    // row before the gate fires); if we got here without one, there's nothing
    // to identify for approval and we just stay in the "silent strict" branch.
    if (userId) {
      requestSenderApproval({
        messagingGroupId: mg.id,
        agentGroupId,
        senderIdentity: userId,
        senderName,
        event,
      }).catch((err) => log.error('Sender-approval flow threw', { err }));
    }
    return;
  }

  // 'public' should have been handled before the gate; fall through silently.
}

setSenderResolver(extractAndUpsertUser);

setAccessGate((event, userId, mg, agentGroupId): AccessGateResult => {
  // Public channels skip the access check entirely.
  if (mg.unknown_sender_policy === 'public') {
    return { allowed: true };
  }

  if (!userId) {
    handleUnknownSender(mg, null, agentGroupId, 'unknown_user', event);
    return { allowed: false, reason: 'unknown_user' };
  }

  const decision = canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) {
    return { allowed: true };
  }

  handleUnknownSender(mg, userId, agentGroupId, decision.reason, event);
  return { allowed: false, reason: decision.reason };
});

/**
 * Per-wiring sender-scope enforcement. Stricter than the messaging-group
 * `unknown_sender_policy` — a wiring can require `sender_scope='known'`
 * (explicit owner / admin / member) even on a 'public' messaging group.
 *
 * 'all' is a no-op; any sender passes. 'known' requires a userId that
 * canAccessAgentGroup accepts (owner, admin, or group member).
 */
setSenderScopeGate(
  (_event: InboundEvent, userId: string | null, _mg: MessagingGroup, agent: MessagingGroupAgent): AccessGateResult => {
    if (agent.sender_scope === 'all') return { allowed: true };
    if (!userId) return { allowed: false, reason: 'unknown_user_scope' };
    const decision = canAccessAgentGroup(userId, agent.agent_group_id);
    if (decision.allowed) return { allowed: true };
    return { allowed: false, reason: `sender_scope_${decision.reason}` };
  },
);

/**
 * Response handler for the unknown-sender approval card.
 *
 * Claim rule: questionId matches a row in pending_sender_approvals. If no
 * such row, return false so the next handler (approvals module, OneCLI,
 * interactive) gets a shot.
 *
 * Approve: add the sender to agent_group_members + re-invoke routeInbound
 * with the stored event. The second routing attempt clears the gate because
 * the user is now a member.
 *
 * Deny: delete the row (no "deny list" — a future message re-triggers a
 * fresh card per ACTION-ITEMS item 5 "no denial persistence").
 */
async function handleSenderApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingSenderApproval(payload.questionId);
  if (!row) return false;

  // payload.userId is the raw platform userId (e.g. "6037840640"); namespace it
  // with the channel type so it matches users(id) format. Some platforms
  // (e.g. Teams "29:xxx") already include a colon — mirror resolveOrCreateUser
  // logic and only prefix when the raw id has no colon.
  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const isAuthorized =
    clickerId !== null && (clickerId === row.approver_user_id || hasAdminPrivilege(clickerId, row.agent_group_id));
  if (!isAuthorized) {
    log.warn('Unknown-sender approval click rejected — unauthorized clicker', {
      approvalId: row.id,
      clickerId,
      expectedApprover: row.approver_user_id,
    });
    return true; // claim the response so it's not unclaimed-logged, but do nothing
  }
  const approverId = clickerId;
  const approved = payload.value === 'approve';

  if (approved) {
    addMember({
      user_id: row.sender_identity,
      agent_group_id: row.agent_group_id,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
    log.info('Unknown sender approved — member added', {
      approvalId: row.id,
      senderIdentity: row.sender_identity,
      agentGroupId: row.agent_group_id,
      approverId,
    });

    // Clear the pending row BEFORE re-routing so the gate check on the
    // second attempt doesn't see the in-flight row and short-circuit.
    deletePendingSenderApproval(row.id);

    try {
      const event = JSON.parse(row.original_message) as InboundEvent;
      await routeInbound(event);
    } catch (err) {
      log.error('Failed to replay message after sender approval', { approvalId: row.id, err });
    }
    return true;
  }

  log.info('Unknown sender denied', {
    approvalId: row.id,
    senderIdentity: row.sender_identity,
    agentGroupId: row.agent_group_id,
    approverId,
  });
  deletePendingSenderApproval(row.id);
  return true;
}

registerResponseHandler(handleSenderApprovalResponse);

// ── Unknown-channel registration flow ──

setChannelRequestGate(async (mg, event) => {
  await requestChannelApproval({ messagingGroupId: mg.id, event });
});

registerDeliveryAction('setup_peer_ea', async (content, session) => {
  await applySetupPeerEa(content, session);
});

/**
 * Response handler for the unknown-channel registration card.
 *
 * Claim rule: questionId matches a pending_channel_approvals row (keyed
 * by messaging_group_id). If no such row, return false so downstream
 * handlers get a shot.
 *
 * Value dispatch:
 *   connect:<id>    — wire to an existing agent group, replay the message
 *   choose_existing — send a follow-up card listing all agents
 *   new_agent       — prompt for a free-text agent name (interceptor
 *                     captures the reply and creates immediately)
 *   reject          — set denied_at, delete pending row
 */
async function handleChannelApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingChannelApproval(payload.questionId);
  if (!row) return false;

  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const isAuthorized =
    clickerId !== null && (clickerId === row.approver_user_id || hasAdminPrivilege(clickerId, row.agent_group_id));
  if (!isAuthorized) {
    log.warn('Channel registration click rejected — unauthorized clicker', {
      messagingGroupId: row.messaging_group_id,
      clickerId,
      expectedApprover: row.approver_user_id,
    });
    return true;
  }
  const approverId = clickerId;

  // ── Reject / Cancel ──
  if (payload.value === REJECT_VALUE) {
    setMessagingGroupDeniedAt(row.messaging_group_id, new Date().toISOString());
    deletePendingChannelApproval(row.messaging_group_id);
    log.info('Channel registration denied', {
      messagingGroupId: row.messaging_group_id,
      approverId,
    });
    return true;
  }

  // ── Choose existing agent — send agent-selection follow-up card ──
  if (payload.value === CHOOSE_EXISTING_VALUE) {
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) return true;

    const agentGroups = getAllAgentGroups();
    const options = buildAgentSelectionOptions(agentGroups, approverId);
    const title = '📋 Choose an agent';
    updatePendingChannelApprovalCard(row.messaging_group_id, title, JSON.stringify(options));

    try {
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: row.messaging_group_id,
          title,
          question: 'Which agent should handle this channel?',
          options,
        }),
      );
    } catch (err) {
      log.error('Channel registration: agent-selection card delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
    }
    return true;
  }

  // ── Create new agent — prompt for free-text name ──
  if (payload.value === NEW_AGENT_VALUE) {
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.error('Channel registration: no delivery adapter for name prompt', {
        messagingGroupId: row.messaging_group_id,
      });
      return true;
    }

    awaitingNameInput.set(row.approver_user_id, {
      channelMgId: row.messaging_group_id,
      dmChannelType: approverDm.channel_type,
      dmPlatformId: approverDm.platform_id,
    });

    try {
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({ text: 'Reply with the name for your new agent:' }),
      );
    } catch (err) {
      log.error('Channel registration: name prompt delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
      awaitingNameInput.delete(row.approver_user_id);
    }
    return true;
  }

  if (payload.value === PEER_EA_VALUE) {
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.error('Channel registration: no delivery adapter for peer-EA prompt', {
        messagingGroupId: row.messaging_group_id,
      });
      return true;
    }

    let originalEvent: InboundEvent | null = null;
    let bodyText: string | null = null;
    try {
      originalEvent = JSON.parse(row.original_message) as InboundEvent;
      const parsed = JSON.parse(originalEvent.message.content) as Record<string, unknown>;
      if (typeof parsed.text === 'string') bodyText = parsed.text;
    } catch {
      /* fall through — extracted fields stay null */
    }
    const peerNameFromSender = originalEvent ? extractSenderName(originalEvent) : null;
    const peerPrincipalFromSignature = bodyText ? (parseHandshake(bodyText)?.principal ?? null) : null;

    awaitingNameInput.set(row.approver_user_id, {
      channelMgId: row.messaging_group_id,
      dmChannelType: approverDm.channel_type,
      dmPlatformId: approverDm.platform_id,
      mode: 'peer-ea',
      peerNameFromSender,
      peerPrincipalFromSignature,
    });

    const { initial: promptText } = peerEaPromptCopy({ peerNameFromSender, peerPrincipalFromSignature });

    try {
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({ text: promptText }),
      );
    } catch (err) {
      log.error('Channel registration: peer-EA prompt delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
      awaitingNameInput.delete(row.approver_user_id);
    }
    return true;
  }

  // ── Resolve target agent group (connect to existing or create new) ──
  let targetAgentGroupId: string;

  if (payload.value.startsWith(CONNECT_PREFIX)) {
    targetAgentGroupId = payload.value.slice(CONNECT_PREFIX.length);
    const ag = getAgentGroup(targetAgentGroupId);
    if (!ag) {
      log.error('Channel registration: target agent group no longer exists', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
      });
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    if (!hasAdminPrivilege(approverId, targetAgentGroupId)) {
      log.warn('Channel registration: target agent group rejected for unauthorized approver', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
        approverId,
      });
      return true;
    }
  } else {
    log.warn('Channel registration: unknown response value', {
      messagingGroupId: row.messaging_group_id,
      value: payload.value,
    });
    return true;
  }

  // ── Wire + replay (shared path for connect and create) ──
  let event: InboundEvent;
  try {
    event = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    log.error('Channel registration: failed to parse stored event', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    deletePendingChannelApproval(row.messaging_group_id);
    return true;
  }

  const isGroup = event.threadId !== null;
  const engageMode: MessagingGroupAgent['engage_mode'] = isGroup ? 'mention-sticky' : 'pattern';
  const engagePattern = isGroup ? null : '.';

  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createMessagingGroupAgent({
    id: mgaId,
    messaging_group_id: row.messaging_group_id,
    agent_group_id: targetAgentGroupId,
    engage_mode: engageMode,
    engage_pattern: engagePattern,
    sender_scope: 'known',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('Channel registration approved — wiring created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: targetAgentGroupId,
    mgaId,
    engageMode,
    approverId,
  });

  const senderUserId = extractAndUpsertUser(event);
  if (senderUserId) {
    addMember({
      user_id: senderUserId,
      agent_group_id: targetAgentGroupId,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
  }

  deletePendingChannelApproval(row.messaging_group_id);

  try {
    await routeInbound(event);
  } catch (err) {
    log.error('Failed to replay message after channel approval', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }
  return true;
}

registerResponseHandler(handleChannelApprovalResponse);

// ── Free-text name interceptor ──
// Captures the next DM from an approver who clicked "Create new agent",
// creates the agent immediately, wires the channel, and replays.

setMessageInterceptor(async (event: InboundEvent): Promise<boolean> => {
  const userId = extractAndUpsertUser(event);
  if (!userId) return false;

  const pending = awaitingNameInput.get(userId);
  if (!pending) return false;
  if (event.channelType !== pending.dmChannelType || event.platformId !== pending.dmPlatformId) return false;

  awaitingNameInput.delete(userId);

  let text: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    text = (typeof parsed.text === 'string' ? parsed.text : undefined)?.trim();
  } catch {
    /* fall through */
  }

  if (!text) {
    log.warn('Channel registration: empty name reply, ignoring', { userId });
    return true;
  }

  const row = getPendingChannelApproval(pending.channelMgId);
  if (!row) return true;

  let originalEvent: InboundEvent;
  try {
    originalEvent = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    log.error('Channel registration: failed to parse stored event', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    deletePendingChannelApproval(row.messaging_group_id);
    return true;
  }

  let ag: AgentGroup;
  let senderScope: SenderScope;
  let isPeerEa = false;

  if (pending.mode === 'peer-ea') {
    isPeerEa = true;
    const fields = splitFields(text);
    const peerNameFromSender = pending.peerNameFromSender;
    const peerPrincipalFromSignature = pending.peerPrincipalFromSignature;

    let peerName: string;
    let peerPrincipal: string;
    let relationship: string;

    if (peerNameFromSender && peerPrincipalFromSignature && fields.length === 1) {
      peerName = peerNameFromSender;
      peerPrincipal = peerPrincipalFromSignature;
      relationship = fields[0];
    } else if (peerNameFromSender && fields.length === 2) {
      peerName = peerNameFromSender;
      peerPrincipal = fields[0];
      relationship = fields[1];
    } else if (fields.length === 3) {
      peerName = fields[0];
      peerPrincipal = fields[1];
      relationship = fields[2];
    } else {
      // Re-prompt; pending row stays so the next reply hits this interceptor.
      const adapter = getDeliveryAdapter();
      const { expectedFormat: expected } = peerEaPromptCopy({ peerNameFromSender, peerPrincipalFromSignature });
      if (adapter) {
        adapter
          .deliver(
            pending.dmChannelType,
            pending.dmPlatformId,
            null,
            'chat-sdk',
            JSON.stringify({ text: `Couldn't parse — try again with: ${expected}` }),
          )
          .catch(() => {});
      }
      awaitingNameInput.set(userId, pending);
      return true;
    }

    ag = createPeerEaAgentGroup({ peerName, peerPrincipal, relationship });
    log.info('Channel registration: peer-EA agent group created', {
      messagingGroupId: row.messaging_group_id,
      agentGroupId: ag.id,
      agentName: ag.name,
      folder: ag.folder,
      peerName,
      peerPrincipal,
      relationship,
    });
    senderScope = 'all';

    // 'strict' so a third party in the peer space drops silently rather
    // than triggering an unknown-sender approval cascade.
    updateMessagingGroup(row.messaging_group_id, { unknown_sender_policy: 'strict' });
  } else {
    ag = createNewAgentGroup(text);
    log.info('Channel registration: new agent group created', {
      messagingGroupId: row.messaging_group_id,
      agentGroupId: ag.id,
      agentName: ag.name,
      folder: ag.folder,
    });
    senderScope = 'known';
  }

  const isGroup = originalEvent.threadId !== null;
  const engageMode: MessagingGroupAgent['engage_mode'] = isGroup ? 'mention-sticky' : 'pattern';
  const engagePattern = isGroup ? null : '.';

  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createMessagingGroupAgent({
    id: mgaId,
    messaging_group_id: row.messaging_group_id,
    agent_group_id: ag.id,
    engage_mode: engageMode,
    engage_pattern: engagePattern,
    sender_scope: senderScope,
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('Channel registration approved — wiring created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: ag.id,
    mgaId,
    engageMode,
    senderScope,
    isPeerEa,
    approverId: userId,
  });

  const senderUserId = extractAndUpsertUser(originalEvent);
  if (senderUserId) {
    addMember({
      user_id: senderUserId,
      agent_group_id: ag.id,
      added_by: userId,
      added_at: new Date().toISOString(),
    });
  }

  deletePendingChannelApproval(row.messaging_group_id);

  // Best-effort — destination wiring failure doesn't roll back the
  // agent group; it's recoverable later via `ncl destinations add`.
  if (isPeerEa) {
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (approverDm) {
      try {
        wirePeerEaDestinations(ag, approverDm);
      } catch (err) {
        log.error('Peer-EA: destination wiring failed', { agentGroupId: ag.id, err });
      }
    } else {
      log.warn('Peer-EA: approver DM unresolvable, destinations not registered', {
        agentGroupId: ag.id,
        approverUserId: row.approver_user_id,
      });
    }
  }

  try {
    await routeInbound(originalEvent);
  } catch (err) {
    log.error('Failed to replay message after channel approval', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }

  const adapter = getDeliveryAdapter();
  if (adapter) {
    const dm = await ensureUserDm(row.approver_user_id);
    if (dm) {
      const confirmText = isPeerEa
        ? `✅ Peer-EA agent "${ag.name}" connected. main can now \`send_message(to="${ag.folder}")\`.`
        : `✅ Agent "${ag.name}" created and connected.`;
      adapter
        .deliver(dm.channel_type, dm.platform_id, null, 'chat-sdk', JSON.stringify({ text: confirmText }))
        .catch(() => {});
    }
  }
  return true;
});
