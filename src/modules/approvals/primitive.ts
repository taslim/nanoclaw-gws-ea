/**
 * Approvals primitive — the public API that other modules call.
 *
 * Two surfaces:
 *   - `requestApproval()` — queue an approval request, deliver the card to
 *     the right admin DM, record the pending_approvals row. Used by any
 *     module that needs admin confirmation before doing something sensitive.
 *   - `registerApprovalHandler(action, handler)` — called at module import
 *     time. When the admin approves a pending row with matching `action`,
 *     the response handler dispatches into the registered callback. Optional
 *     modules (self-mod, future module gates) register here.
 *
 * Approver picking lives here too — it used to sit in src/access.ts and got
 * folded in with the PR #7 re-tier. The picks functions walk user_roles
 * (owner, global admin, scoped admin) and resolve to a reachable DM via the
 * permissions module's user-dm helper.
 *
 * Tier: default module. Permissions is an optional module, so importing from
 * it here is technically a tier inversion — but the host bundles both with
 * main, and the alternative (a third "permissions-primitive" default module
 * exposing just user-roles/user-dms) is more churn than it's worth. Revisit
 * if either module becomes genuinely optional (see REFACTOR_PLAN open q #3).
 */
import type { OutboundFile } from '../../channels/adapter.js';
import {
  APPROVE_OPTION,
  CardTooLongError,
  cardQuestionTooLong,
  normalizeOptions,
  REJECT_OPTION,
  REJECT_WITH_REASON_OPTION,
  type NormalizedOption,
  type RawOption,
} from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import {
  bindPendingApprovalMessage,
  createPendingApproval,
  deletePendingApproval,
  getSession,
} from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { requestWake } from '../../request-wake.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, PendingApproval, Session } from '../../types.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import { combineDetails, recordRequestOutcome, recordRequestPosted, type RequestDetails } from './request-context.js';
import { requestOrigin } from './request-text.js';
import { detachApproval, finishApprovalWithdrawal } from './lifecycle.js';

/**
 * Three-button approval UI. Plain Reject is the instant fast path; "Reject with
 * reason…" opts into the reason-capture flow, which holds the row and captures
 * the approver's next DM as a one-line reason relayed to the requesting agent
 * (reason-capture.ts). Where requests are text, the reason follows the no.
 * Shared by every module approval (create_agent, install_packages,
 * add_mcp_server). Gateway approvals use the core gateway coordinator's
 * two-button decision flow.
 */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: APPROVE_OPTION, style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: REJECT_OPTION, style: 'danger' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: REJECT_WITH_REASON_OPTION },
];

// ── Approval handler registry ──
// Modules that want to be called back when an admin approves a pending row
// register here at import time, keyed by the `action` string they used in
// their `requestApproval()` calls.

export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  /**
   * The verified approval row — the grant an approved continuation carries
   * when it re-enters its guarded entry point. Still live here; resolution
   * deletes it after the handler returns, so a grant executes exactly once.
   */
  approval: PendingApproval;
  /** User ID of the admin who approved. Empty string if unknown. */
  userId: string;
  /** Send a system chat message to the requesting agent's session. */
  notify: (text: string) => Promise<void>;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

/**
 * What the requesting agent reads when its request is rejected, given the
 * rejected row and the approver's reason, if any (already clamped). `null`
 * writes no note: the module tells the agent itself, from an approval-resolved
 * callback, which runs before the rejection wakes the agent.
 */
export type ApprovalRejectionNote = (
  approval: PendingApproval,
  reason: string | undefined,
) => string | null | Promise<string | null>;

export interface ApprovalHandlerOptions {
  /** The handler is idempotent and may resume an approved row after a host restart. */
  restartSafe?: boolean;
  /** Words the rejection for this action; without it the agent reads the generic note (finalize.ts). */
  rejectionNote?: ApprovalRejectionNote;
}

interface ApprovalHandlerRegistration {
  handler: ApprovalHandler;
  restartSafe: boolean;
  rejectionNote?: ApprovalRejectionNote;
}

const approvalHandlers = new Map<string, ApprovalHandlerRegistration>();

export function registerApprovalHandler(
  action: string,
  handler: ApprovalHandler,
  options: ApprovalHandlerOptions = {},
): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, {
    handler,
    restartSafe: options.restartSafe === true,
    rejectionNote: options.rejectionNote,
  });
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action)?.handler;
}

export function getApprovalRejectionNote(action: string): ApprovalRejectionNote | undefined {
  return approvalHandlers.get(action)?.rejectionNote;
}

export function getRegisteredApprovalActions(): readonly string[] {
  return [...approvalHandlers.keys()];
}

export function getRestartSafeApprovalActions(): readonly string[] {
  return [...approvalHandlers].filter(([, registration]) => registration.restartSafe).map(([action]) => action);
}

// ── Approval-resolved callbacks ──
// Modules that want to observe approval resolution (any action, approve or
// reject) register here at import time. The response handler fires every
// registered callback after the admin's decision is applied — e.g. a module
// clearing an "awaiting approval" status indicator it set when the card went
// out. Callback errors are logged and isolated; they never block resolution.
//
// Only authorized clicks resolve an approval (the response handler's
// isAuthorizedApprovalClick gate runs first), so callbacks never fire for
// unauthorized responses.

export interface ApprovalResolvedEvent {
  approval: PendingApproval;
  session: Session;
  outcome: 'approve' | 'reject' | 'expired' | 'withdrawn';
  /** Namespaced user ID (`<channel>:<handle>`) of the resolving admin. Empty string if unknown. */
  userId: string;
  /** The reason given with a rejection. */
  reason?: string;
}

export type ApprovalResolvedHandler = (event: ApprovalResolvedEvent) => Promise<void> | void;

const approvalResolvedHandlers: ApprovalResolvedHandler[] = [];

export function registerApprovalResolvedHandler(handler: ApprovalResolvedHandler): void {
  approvalResolvedHandlers.push(handler);
}

/**
 * Note the outcome in the conversation the request was posted in
 * (request-context.ts), then fire every registered approval-resolved
 * callback. Called by the response handler and finalizeReject.
 */
export async function notifyApprovalResolved(event: ApprovalResolvedEvent): Promise<void> {
  await recordApprovalOutcome(event);
  for (const handler of approvalResolvedHandlers) {
    try {
      await handler(event);
      // eslint-disable-next-line no-catch-all/no-catch-all -- isolation is the contract: one bad callback must not block resolution or other callbacks
    } catch (err) {
      log.error('Approval-resolved handler threw', {
        approvalId: event.approval.approval_id,
        action: event.approval.action,
        outcome: event.outcome,
        err,
      });
    }
  }
}

async function recordApprovalOutcome({ approval, outcome, reason }: ApprovalResolvedEvent): Promise<void> {
  if (!approval.channel_type || !approval.platform_id) return;
  const options = JSON.parse(approval.options_json) as NormalizedOption[];
  await recordRequestOutcome(
    {
      channelType: approval.channel_type,
      platformId: approval.platform_id,
      instance: approval.instance,
      threadId: null,
    },
    {
      id: approval.approval_id,
      about: approval.action,
      title: approval.title,
      outcome: options.find((option) => option.value === outcome)?.selectedLabel ?? outcome,
      reason,
    },
  );
}

// ── Approver picking ──

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 */
export async function pickApprover(agentGroupId: string | null): Promise<string[]> {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of await getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of await getGlobalAdmins()) add(r.user_id);
  for (const r of await getOwners()) add(r.user_id);

  return approvers;
}

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break: prefer approvers reachable on the same channel kind as the
 * origin; else first in list. A same-channel origin resolves through its
 * exact adapter instance.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
  originInstance?: string,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId, originInstance === undefined ? undefined : { instance: originInstance });
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  for (const userId of approvers) {
    if (originChannelType && channelTypeOf(userId) === originChannelType) continue;
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}

/**
 * A card joins the requester's thread only when it lands in the requester's own
 * chat; a thread id from any other chat means nothing in the approver's DM.
 */
export function approvalCardThread(session: Session, target: MessagingGroup): string | null {
  return session.messaging_group_id === target.id ? session.thread_id : null;
}

// ── Request API ──

/** Send a system chat to the agent's session. Used by callers and by the response handler. */
export async function notifyAgent(session: Session, text: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'inbound-message');
}

export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  /** Free-form action identifier. Must match the key the consumer registered via registerApprovalHandler. */
  action: string;
  /** JSON-serializable opaque payload. Carried on the pending_approvals row, handed to the handler on approve. */
  payload: Record<string, unknown>;
  /** Card title shown to the admin, in the assistant's voice (request-text.ts). */
  title: string;
  /**
   * Card body shown to the admin, in the assistant's voice: what the host
   * holds first, anything someone else supplied quoted (request-text.ts).
   * A request from an agent that does not work in the approver's
   * conversation ends with where it comes from.
   */
  question: string;
  /**
   * What the agent in the approver's conversation reads about the request
   * besides its title and answers (request-context.ts). Never the payload,
   * which may hold secrets.
   */
  details?: RequestDetails;
  /** Deliver the card to this specific user instead of all of the session group's admins. */
  approverUserId?: string;
  /** ISO-8601 UTC deadline for answering this request. */
  expiresAt?: string;
  /** Host-authored context replacing the inferred conversation origin. */
  originLine?: string;
  /**
   * Pictures that go with the card (KTD6), such as a checkout's total and
   * its commit control, posted on the card's own message where the channel
   * attaches files. Their bytes live only for this one posting: never in the
   * approval row, the database or the logs. `null` is a picture meant for
   * the card that could not be taken. A card whose pictures do not all reach
   * its message, as one posted from anything kept after a restart, says
   * they are unavailable.
   */
  pictures?: readonly (RequestPicture | null)[];
}

/** A picture that goes with a card: PNG bytes held only in memory (RequestApprovalOptions.pictures). */
export interface RequestPicture extends OutboundFile {
  mimeType: 'image/png';
}

/**
 * Queue an approval request. Picks an approver, delivers the card to their
 * DM, and records the pending_approvals row. Fire-and-forget from the
 * caller's perspective beyond the returned durable id (or null on delivery
 * failure) — the admin's response kicks off the registered
 * approval handler for this action via the response dispatcher.
 */
export async function requestApproval(opts: RequestApprovalOptions): Promise<string | null> {
  const { session, action, payload, title, agentName, approverUserId } = opts;

  // The approver must see the whole request: refuse what a card can't show in full.
  const tooLong = cardQuestionTooLong(title, opts.question);
  if (tooLong) {
    await notifyAgent(session, `${action} failed: ${tooLong}. Shorten the request and try again.`);
    return null;
  }

  const approvers = approverUserId ? [approverUserId] : await pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    await notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return null;
  }

  const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const originChannelType = origin?.channel_type ?? '';

  const target = await pickApprovalDelivery(approvers, originChannelType, origin?.instance);
  if (!target) {
    await notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
    return null;
  }

  const asking = await requestOrigin(session.agent_group_id, origin, target.messagingGroup, opts.originLine);
  const question = asking ? `${opts.question}\n\n${asking.line}` : opts.question;
  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);
  const approver = approverUserId ?? target.userId;
  await createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    channel_type: target.messagingGroup.channel_type,
    platform_id: target.messagingGroup.platform_id,
    instance: target.messagingGroup.instance ?? null,
    title,
    question,
    options_json: JSON.stringify(normalizedOptions),
    // The DM'd approver is the identity this card was routed to; recording it
    // makes resolution exact — only that user may decide the row.
    approver_user_id: approver,
    expires_at: opts.expiresAt ?? null,
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    // The card names its pictures; their bytes ride beside it for this one delivery.
    const pictures = opts.pictures ?? [];
    const taken = pictures.filter((picture): picture is RequestPicture => picture !== null);
    let messageId: string | void;
    try {
      messageId = await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        approvalCardThread(session, target.messagingGroup),
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options: APPROVAL_OPTIONS,
          ...(pictures.length === 0 ? {} : { pictures: pictures.length }),
        }),
        taken.length === 0 ? undefined : taken,
        target.messagingGroup.instance,
      );
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      // The single delivery target never saw the card — remove the row so it
      // can't linger as a pending approval nobody can act on.
      await deletePendingApproval(approvalId);
      // A card the channel refused as too long says why, so the agent can shorten it.
      const reason =
        err instanceof CardTooLongError
          ? `${err.message}. Shorten the request and try again.`
          : `could not deliver approval request to ${target.userId}.`;
      await notifyAgent(session, `${action} failed: ${reason}`);
      return null;
    }
    if (messageId) {
      try {
        await bindPendingApprovalMessage(approvalId, messageId);
        // eslint-disable-next-line no-catch-all/no-catch-all -- binding is idempotent; retry a persistence failure once
      } catch (err) {
        log.warn('Retrying approval card binding', { action, approvalId, err });
        try {
          await bindPendingApprovalMessage(approvalId, messageId);
          // eslint-disable-next-line no-catch-all/no-catch-all -- retire the unanswered card if its durable binding cannot be saved
        } catch (err) {
          log.error('Failed to bind delivered approval card', { action, approvalId, err });
          const approval = await detachApproval(approvalId);
          // A response may already have claimed the row; its decision stands.
          if (!approval) return approvalId;
          await finishApprovalWithdrawal(
            { ...approval, platform_message_id: messageId },
            '⚠️ Canceled — approval request could not be recorded',
          );
          await notifyAgent(session, `${action} failed: could not record the delivered approval request.`);
          return null;
        }
      }
    }
    await recordRequestPosted(
      {
        channelType: target.messagingGroup.channel_type,
        platformId: target.messagingGroup.platform_id,
        instance: target.messagingGroup.instance,
        threadId: approvalCardThread(session, target.messagingGroup),
      },
      {
        id: approvalId,
        about: action,
        title,
        options: normalizedOptions,
        answerFrom: approver,
        details: combineDetails(opts.details, asking?.details),
      },
    );
  } else {
    await deletePendingApproval(approvalId);
    await notifyAgent(session, `${action} failed: no delivery adapter is available.`);
    return null;
  }

  log.info('Approval requested', { action, approvalId, agentName, approver: target.userId });
  return approvalId;
}
