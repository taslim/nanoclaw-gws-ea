/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import { createHash } from 'crypto';

import { AnchoredDir, copyRegularFile } from '../../anchored-dir.js';
import { fenceForCard } from '../../card-text.js';
import { MAX_CARD_QUESTION_LENGTH } from '../../channels/ask-question.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { isUniqueViolation } from '../../db/errors.js';
import { OutboundRefusedError } from '../../delivery.js';
import { findSystemSession, getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { GuardDenyError, guard } from '../../guard/index.js';
import { log } from '../../log.js';
import {
  resolveSession,
  resolveSystemSession,
  sessionDir,
  withExistingMailboxSession,
  writeSessionMessage,
} from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { NAME_LIMIT, quoted } from '../approvals/request-text.js';
import { getDestinationByTarget } from './db/agent-destinations.js';
import { A2A_MESSAGE_GATE_ACTION, a2aSend } from './guard.js';

export { isSafeAttachmentName };
export { A2A_MESSAGE_GATE_ACTION } from './guard.js';

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  if (!isSafeAttachmentName(source.messageId)) {
    log.warn('agent-route: rejecting unsafe source outbox message id', { sourceMsgId: source.messageId });
    return [];
  }

  // Both agents can write their own session folders, so either could turn
  // `outbox`, `inbox` or a message dir into a symlink at any time. Each side is
  // opened as an AnchoredDir (symlinks refused) and used only through it, the
  // same way as the channel-inbound path (#2828, CWE-59).
  let sourceDir: AnchoredDir | null;
  try {
    sourceDir = AnchoredDir.open(sessionDir(source.agentGroupId, source.sessionId), ['outbox', source.messageId]);
  } catch (err) {
    log.warn('agent-route: rejecting unsafe source outbox dir', { sourceMsgId: source.messageId, err });
    return [];
  }
  if (!sourceDir) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', { sourceMsgId: source.messageId });
    return [];
  }

  let targetDir: AnchoredDir | null = null;
  try {
    targetDir = AnchoredDir.open(sessionDir(target.agentGroupId, target.sessionId), ['inbox', target.messageId], true);
  } catch (err) {
    log.warn('agent-route: rejecting unsafe target inbox dir', {
      targetGroup: target.agentGroupId,
      targetSession: target.sessionId,
      targetMsgId: target.messageId,
      err,
    });
  }

  const attachments: ForwardedAttachment[] = [];
  try {
    if (!targetDir) return [];
    for (const filename of source.filenames) {
      if (!isSafeAttachmentName(filename)) {
        log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
          sourceMsgId: source.messageId,
          filename,
        });
        continue;
      }
      try {
        // Stream source → target through both descriptors. Exclusive create on
        // the target never follows or overwrites a pre-placed entry; neither
        // side is addressed by path after its dir was opened.
        copyRegularFile(sourceDir, filename, targetDir, filename);
      } catch (err) {
        log.warn('agent-route: skipped forwarding file (missing, unsafe, or already present)', {
          sourceMsgId: source.messageId,
          targetMsgId: target.messageId,
          filename,
          err,
        });
        continue;
      }
      attachments.push({
        name: filename,
        filename,
        type: 'file',
        localPath: `inbox/${target.messageId}/${filename}`,
      });
    }
  } finally {
    sourceDir.close();
    targetDir?.close();
  }
  return attachments;
}

type InboundFraming = (content: string, context: { sourceAgentGroupId: string; targetAgentGroupId: string }) => string;
let inboundFraming: InboundFraming | undefined;

/** Register product-owned source framing without coupling A2A to that product. */
export function registerA2aInboundFraming(framing: InboundFraming): void {
  if (inboundFraming) throw new Error('A2A inbound framing is already registered');
  inboundFraming = framing;
}

/**
 * A product's rule on where one of its sessions may send, beyond its group's
 * destination rows: a tool agent's errand, say, answers only the agent that
 * opened it. A reason refuses the send, as an unknown thread is refused.
 */
type A2aRoutePolicy = (input: {
  readonly session: Session;
  readonly targetAgentGroupId: string;
}) => Promise<string | undefined>;
const routePolicies = new Map<string, A2aRoutePolicy>();

/** Register a route policy. IDs take the `module:name` form, as a refusal names its policy. */
export function registerA2aRoutePolicy(id: string, policy: A2aRoutePolicy): void {
  if (routePolicies.has(id)) throw new Error(`A2A route policy already registered: ${id}`);
  routePolicies.set(id, policy);
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  thread_id?: string | null;
  content: string;
  /**
   * For replies, the id of the inbound message being replied to. The
   * container's formatter sets this from the first inbound in the batch
   * (`container/agent-runner/src/formatter.ts`). Used here to route the
   * reply back to the originating session — see `resolveTargetSession`.
   */
  in_reply_to: string | null;
}

/**
 * Pick which session of `targetAgentGroupId` should receive this a2a message.
 *
 * Three layers, highest-fidelity first:
 *
 * 1. **Direct return-path** (in_reply_to lookup): if the message is a reply
 *    (`in_reply_to` set), open the source agent's inbound DB and read the
 *    triggering row's `source_session_id`. That column was stamped when the
 *    original outbound was routed — it's the session that started the
 *    conversation, and replies should land there even when the target has
 *    multiple active sessions.
 *
 * 2. **Peer-affinity fallback**: if (1) misses (in_reply_to is null or the
 *    referenced row isn't an a2a inbound), look up the most recent a2a
 *    inbound *from the target agent group* in source's inbound and use its
 *    `source_session_id`. The intuition: the last time this peer talked to
 *    me, which target session was driving? Route the reply there, since
 *    that's the session most plausibly in active conversation.
 *
 * 3. **Newest active session**: legacy heuristic. Used when no prior a2a
 *    has been recorded with `source_session_id` (e.g. fresh installs,
 *    pre-migration data).
 */
async function resolveTargetSession(
  msg: RoutableAgentMessage,
  sourceSession: Session,
  targetAgentGroupId: string,
): Promise<Session> {
  const destination = await getDestinationByTarget(sourceSession.agent_group_id, 'agent', targetAgentGroupId);
  if (destination?.session_mode === 'per-thread') {
    const prefix = `system:a2a:${sourceSession.agent_group_id}:`;
    if (msg.thread_id === 'new') {
      const thread = `${prefix}${msg.id}`;
      const { session } = await resolveSystemSession(targetAgentGroupId, thread, { includeClosed: true });
      if (session.status === 'closed')
        throw new OutboundRefusedError('agent-to-agent:thread', 'Thread is closed. Open a new thread.');
      return session;
    }
    if (!msg.thread_id?.startsWith(prefix))
      throw new OutboundRefusedError(
        'agent-to-agent:thread',
        'An explicit thread owned by the source agent is required.',
      );
    const target = await findSystemSession(targetAgentGroupId, msg.thread_id, true);
    if (!target || target.status !== 'active')
      throw new OutboundRefusedError('agent-to-agent:thread', 'Unknown or closed thread. Open a new thread.');
    return target;
  }
  const originSessionId = await withExistingMailboxSession(sourceSession.agent_group_id, sourceSession.id, (srcDb) => {
    let origin: string | null = null;
    if (msg.in_reply_to) {
      origin = srcDb.getInboundSourceSessionId(msg.in_reply_to);
    }
    if (!origin) {
      // Peer-affinity fallback — covers the case where the container's
      // outbound write didn't carry in_reply_to (e.g. legacy MCP send_message
      // path, container running pre-fix code).
      origin = srcDb.getMostRecentPeerSourceSessionId(targetAgentGroupId);
    }
    return origin;
  });
  if (originSessionId) {
    const candidate = await getSession(originSessionId);
    if (candidate && candidate.agent_group_id === targetAgentGroupId && candidate.status === 'active') {
      return candidate;
    }
  }
  return (await resolveSession(targetAgentGroupId, null, null, 'agent-shared')).session;
}

export async function routeAgentMessage(
  msg: RoutableAgentMessage,
  session: Session,
  opts: { grant?: PendingApproval } = {},
): Promise<void> {
  const sourceAgentGroupId = session.agent_group_id;
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  for (const [id, policy] of routePolicies) {
    const refusal = await policy({ session, targetAgentGroupId });
    if (refusal !== undefined) throw new OutboundRefusedError(id, refusal);
  }

  // The a2a.send decision (guard.ts) carries the checks verbatim in their
  // original order: destination ACL deny, target-exists deny, self-send
  // allow, agent_message_policies hold. An approved replay carries the
  // grant — the hold is satisfied but the structure is re-checked live, so
  // revoking a destination between hold and approve blocks delivery.
  const decision = await guard(a2aSend, {
    actor: { kind: 'agent', agentGroupId: sourceAgentGroupId, sessionId: session.id },
    resource: { from: sourceAgentGroupId, to: targetAgentGroupId },
    payload: {
      id: msg.id,
      platform_id: targetAgentGroupId,
      content: msg.content,
      in_reply_to: msg.in_reply_to,
      thread_id: msg.thread_id ?? null,
    },
    grant: opts.grant ?? null,
  });

  if (decision.effect === 'deny') {
    throw new GuardDenyError(decision.reason);
  }

  // Gated edge: hold the message and return (not throw) so the delivery loop
  // consumes the outbound row; `applyA2aMessageGate` re-enters here with the
  // grant on approve.
  if (decision.effect === 'hold') {
    const sourceName = (await getAgentGroup(sourceAgentGroupId))?.name ?? sourceAgentGroupId;
    const targetName = (await getAgentGroup(targetAgentGroupId))?.name ?? targetAgentGroupId;
    await requestApproval({
      session,
      agentName: sourceName,
      action: A2A_MESSAGE_GATE_ACTION,
      approverUserId: decision.approverUserId,
      title: GATE_CARD_TITLE,
      question: buildGateQuestion(sourceName, targetName, msg.content),
      payload: {
        id: msg.id,
        platform_id: targetAgentGroupId,
        content: msg.content,
        in_reply_to: msg.in_reply_to,
        thread_id: msg.thread_id ?? null,
      },
    });
    log.info('Agent message held for approval', {
      from: sourceAgentGroupId,
      to: targetAgentGroupId,
      msgId: msg.id,
    });
    return;
  }

  await performAgentRoute(msg, session, targetAgentGroupId);
}

const GATE_CARD_BODY_MAX = 1500;
const GATE_CARD_TITLE = 'Message approval';

function parseMessageContent(contentStr: string): { text: string; files: string[] } {
  try {
    const parsed = JSON.parse(contentStr) as { text?: unknown; files?: unknown };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      files: Array.isArray(parsed.files) ? parsed.files.filter((f): f is string => typeof f === 'string') : [],
    };
  } catch {
    return { text: contentStr, files: [] };
  }
}

/**
 * The request for a held message, in the assistant's voice (KTD14): which of
 * its agents it passes between first, each as one quoted line, then what the
 * sending agent wrote, in a fence sized to what the card limit leaves, and
 * what it attached. Exported for tests.
 */
export function buildGateQuestion(sourceName: string, targetName: string, contentStr: string): string {
  const { text, files } = parseMessageContent(contentStr);
  const head = `From: ${quoted(sourceName, NAME_LIMIT)}\nTo: ${quoted(targetName, NAME_LIMIT)}\nMessage:\n`;
  const tailLines =
    files.length > 0 ? [`Attachments: ${files.map((file) => quoted(file, NAME_LIMIT)).join(', ')}`] : [];
  tailLines.push("I'd like to pass this message between my agents.");
  const tail = `\n${tailLines.join('\n')}`;
  // The body gets whatever the card limit leaves once title, frame and fence
  // count; escaping can grow text several times, so the cap is on escaped text.
  const room = MAX_CARD_QUESTION_LENGTH - GATE_CARD_TITLE.length - head.length - tail.length - fenceForCard('').length;
  const budget = Math.max(0, Math.min(GATE_CARD_BODY_MAX, room));
  return head + fenceForCard(text, budget) + tail;
}

/**
 * Cross-session route: pick the target session, forward files, write to its
 * inbound DB, wake it. Module-private — the only door is routeAgentMessage's
 * guard decision (the approve continuation re-enters with a grant rather
 * than calling this directly).
 */
async function performAgentRoute(
  msg: RoutableAgentMessage,
  session: Session,
  targetAgentGroupId: string,
): Promise<void> {
  const targetSession = await resolveTargetSession(msg, session, targetAgentGroupId);
  const a2aMsgId = `a2a-${createHash('sha256')
    .update(JSON.stringify([session.id, msg.id]))
    .digest('hex')}`;

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  const inboundPolicy = await getDestinationByTarget(targetAgentGroupId, 'agent', session.agent_group_id);
  if (inboundPolicy?.inbound_untrusted === 1 && !inboundFraming) {
    throw new OutboundRefusedError('agent-to-agent:framing', 'Untrusted inbound framing is not registered.');
  }
  const content =
    inboundPolicy?.inbound_untrusted === 1 && inboundFraming
      ? inboundFraming(forwardedContent, { sourceAgentGroupId: session.agent_group_id, targetAgentGroupId })
      : forwardedContent;
  try {
    await writeSessionMessage(targetAgentGroupId, targetSession.id, {
      id: a2aMsgId,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: targetSession.thread_id?.startsWith('system:a2a:') ? targetSession.thread_id : (msg.thread_id ?? null),
      content,
      sourceSessionId: session.id,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const origin = await withExistingMailboxSession(targetAgentGroupId, targetSession.id, (db) =>
      db.getInboundSourceSessionId(a2aMsgId),
    );
    if (origin !== session.id) throw error;
  }
  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });
  const fresh = await getSession(targetSession.id);
  if (fresh) await requestWake(fresh, 'inbound-message');
  // A held row is consumed without a receipt; only the actual route can complete it.
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.markDelivered(msg.id, a2aMsgId),
  );
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
