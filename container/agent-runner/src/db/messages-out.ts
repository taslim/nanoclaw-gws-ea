/**
 * Legacy runner-facing outbound API, backed by the registered mailbox.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { getAgentMailbox } from '../mailbox/index.js';
import type { OutboundMessage } from '../mailbox/types.js';
import { getCurrentReplyRoute } from './session-state.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
  /**
   * The inbound messages this row answers. A message to a person names them,
   * by default the batch of the turn being answered (the reply stamp), so the
   * host can tell whether a send that fails was the principal's to hear of.
   */
  batch?: readonly string[];
}

/**
 * Extra entries merged into system-action payloads for the duration of a
 * call, without the writing handler knowing about them. This is the seam
 * `extendTool` (../mcp-tools/server.ts) uses so an installed module can
 * add params to a base tool and have them land in the tool's outbound
 * payload while the base tool's source stays untouched.
 *
 * Scope is deliberately narrow: only `kind: 'system'` messages whose
 * content parses to a JSON object are decorated, and entries never
 * overwrite keys the handler wrote itself. No other row receives them.
 * With no active context (the default), this is a no-op.
 */
const outboundPassthrough = new AsyncLocalStorage<Record<string, unknown>>();

/** Run `fn` with `entries` merged into system-action payloads it writes. */
export function withOutboundPassthrough<T>(entries: Record<string, unknown>, fn: () => T): T {
  return outboundPassthrough.run(entries, fn);
}

/** `content` with `entries` merged in when it is a JSON object, never overwriting a key it has. */
function mergeEntries(content: string, entries: Record<string, unknown>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return content;

  const payload = parsed as Record<string, unknown>;
  let changed = false;
  for (const [key, value] of Object.entries(entries)) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      payload[key] = value;
      changed = true;
    }
  }
  return changed ? JSON.stringify(payload) : content;
}

/**
 * Apply any active passthrough entries to a system-action JSON payload, and
 * name the batch a message to a person answers. A message to another agent
 * reaches it as written, so it names none.
 */
function decorateContent(msg: WriteMessageOut): string {
  if (msg.kind === 'system') {
    const entries = outboundPassthrough.getStore();
    return entries ? mergeEntries(msg.content, entries) : msg.content;
  }
  if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && msg.channel_type !== 'agent') {
    const batch = msg.batch ?? getCurrentReplyRoute()?.batch ?? [];
    return batch.length > 0 ? mergeEntries(msg.content, { batch }) : msg.content;
  }
  return msg.content;
}

function messageRow(message: OutboundMessage): MessageOutRow {
  return {
    id: message.id,
    seq: message.sequence,
    in_reply_to: message.inReplyTo,
    timestamp: message.timestamp,
    deliver_after: message.deliverAfter,
    recurrence: message.recurrence,
    kind: message.kind,
    platform_id: message.platformId,
    channel_type: message.channelType,
    thread_id: message.threadId,
    content: message.content,
  };
}

export function writeMessageOut(msg: WriteMessageOut): Promise<number> {
  return getAgentMailbox().operations.writeMessageOut({
    id: msg.id,
    inReplyTo: msg.in_reply_to,
    deliverAfter: msg.deliver_after,
    recurrence: msg.recurrence,
    kind: msg.kind,
    platformId: msg.platform_id,
    channelType: msg.channel_type,
    threadId: msg.thread_id,
    content: decorateContent(msg),
  });
}

export function getMessageIdBySeq(seq: number): string | null {
  return getAgentMailbox().operations.getMessageIdBySeq(seq);
}

export function getRoutingBySeq(
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const routing = getAgentMailbox().operations.getRoutingBySeq(seq);
  return (
    routing && {
      channel_type: routing.channelType,
      platform_id: routing.platformId,
      thread_id: routing.threadId,
    }
  );
}

export function getUndeliveredMessages(): MessageOutRow[] {
  return getAgentMailbox().operations.getUndeliveredMessages().map(messageRow);
}

/** Null until the host delivers the message or gives up on it, and on mailboxes that do not report it. */
export function getDeliveryStatus(messageOutId: string): 'delivered' | 'failed' | null {
  return getAgentMailbox().operations.getDeliveryStatus?.(messageOutId) ?? null;
}
