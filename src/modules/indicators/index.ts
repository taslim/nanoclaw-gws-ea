/**
 * Per-message status indicators.
 *
 * Lightweight feedback loop the host orchestrates so users see "I saw your
 * message" before the agent has finished thinking. Distinct from the typing
 * module: typing is fire-and-forget refresh ticks for platform-native typing
 * dots; indicators are stateful add/remove pairs that channels translate
 * into reactions, status emoji, or whatever fits.
 *
 * Lifecycle (mirrors v1's sendReaction orchestration):
 *   - markReceived  — router engages a session for this inbound message
 *   - clearReceived — agent's user-facing response delivers
 *   - markError     — delivery permanently fails or session crashes
 *
 * Channels implement the three methods on ChannelAdapter; this module owns
 * the cross-message state so a single delivery clears every pending
 * indicator for the session at once.
 */
import { log } from '../../log.js';

interface IndicatorAdapter {
  markReceived?(channelType: string, platformId: string, threadId: string | null, messageId: string): Promise<void>;
  clearReceived?(channelType: string, platformId: string, threadId: string | null, messageId: string): Promise<void>;
  markError?(channelType: string, platformId: string, threadId: string | null, messageId: string): Promise<void>;
}

interface PendingIndicator {
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
}

let adapter: IndicatorAdapter | null = null;
const pendingBySession = new Map<string, PendingIndicator[]>();

export function setIndicatorAdapter(a: IndicatorAdapter): void {
  adapter = a;
}

/**
 * Record that an inbound message engaged this session. Best-effort — if the
 * channel's markReceived throws, log and move on. The pending entry is
 * tracked unconditionally so subsequent clear/error calls still find it.
 */
export function indicateReceived(
  sessionId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  messageId: string,
): void {
  const list = pendingBySession.get(sessionId);
  const entry: PendingIndicator = { channelType, platformId, threadId, messageId };
  if (list) {
    list.push(entry);
  } else {
    pendingBySession.set(sessionId, [entry]);
  }
  void adapter?.markReceived?.(channelType, platformId, threadId, messageId).catch((err) => {
    log.debug('markReceived failed', { channelType, messageId, err });
  });
}

/** Clear every pending indicator for the session — fired when a user-facing
 *  response delivers. No-op when no indicators are tracked. */
export function clearIndicatorsForSession(sessionId: string): void {
  const list = pendingBySession.get(sessionId);
  if (!list?.length) return;
  pendingBySession.delete(sessionId);
  for (const ind of list) fireClearReceived(ind);
}

export function pendingIndicatorMessageIdsForSession(sessionId: string): string[] {
  const list = pendingBySession.get(sessionId);
  if (!list?.length) return [];
  return list.map((ind) => ind.messageId);
}

/** Mark the most recent pending indicator as errored, clear the rest. v1
 *  behavior: avoid a wall of ❌ on a burst — one error indicator per chat is
 *  enough signal. */
export function markIndicatorErrorForSession(sessionId: string): void {
  const list = pendingBySession.get(sessionId);
  if (!list?.length) return;
  pendingBySession.delete(sessionId);
  const last = list[list.length - 1] as PendingIndicator;
  for (let i = 0; i < list.length - 1; i++) fireClearReceived(list[i] as PendingIndicator);
  void adapter?.markError?.(last.channelType, last.platformId, last.threadId, last.messageId).catch((err) => {
    log.debug('markError failed', { channelType: last.channelType, messageId: last.messageId, err });
  });
}

function fireClearReceived(ind: PendingIndicator): void {
  void adapter?.clearReceived?.(ind.channelType, ind.platformId, ind.threadId, ind.messageId).catch((err) => {
    log.debug('clearReceived failed', { channelType: ind.channelType, messageId: ind.messageId, err });
  });
}
