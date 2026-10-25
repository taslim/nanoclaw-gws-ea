/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Anchors: each conversation a turn is engaged from keeps its anchor, the
 * platform's id for the message the turn works on there. Pulses to that
 * conversation carry it, and `endTyping` fires once for it when that work
 * ends: a send to the conversation, a newer message there, or the end of the
 * turn (idle, a failed wake, an exited container). An adapter that marks the
 * message while the turn works (the Google Chat assistant's 👀) takes the
 * mark off then; adapters without `endTyping` see only the pulses.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;

interface TypingAdapter {
  setTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance?: string,
    status?: string,
    statusKind?: 'auto' | 'agent',
    anchor?: string,
  ): Promise<void>;
  endTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    anchor: string,
    instance?: string,
  ): Promise<void>;
}

interface TypingConversation {
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  /** Platform id of the message the turn works on here; undefined once that work ends. */
  anchor?: string;
}

interface TypingTarget {
  agentGroupId: string;
  /** Every conversation the turn was engaged from, by conversationKey. */
  conversations: Map<string, TypingConversation>;
  /** Where the pulse goes: the conversation engaged most recently. */
  current: TypingConversation;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

/** A conversation as the adapter registry resolves it: the owning instance, the chat, and its thread. */
function conversationKey(channelType: string, platformId: string, threadId: string | null, instance?: string): string {
  return JSON.stringify([instance ?? channelType, platformId, threadId]);
}

async function triggerTyping(conversation: TypingConversation): Promise<void> {
  const { channelType, platformId, threadId, instance, anchor } = conversation;
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId, instance, undefined, undefined, anchor);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
  }
}

async function triggerEnd(conversation: TypingConversation, anchor: string): Promise<void> {
  const { channelType, platformId, threadId, instance } = conversation;
  try {
    await adapter?.endTyping?.(channelType, platformId, threadId, anchor, instance);
    /* eslint-disable-next-line no-catch-all/no-catch-all -- an end never fails the send or stop that fired it */
  } catch {
    // Best-effort, as typing is — an adapter clears what is left on its next start.
  }
}

function endAnchor(conversation: TypingConversation): void {
  const { anchor } = conversation;
  if (anchor === undefined) return;
  conversation.anchor = undefined;
  triggerEnd(conversation, anchor).catch(() => {});
}

function finishTyping(sessionId: string, entry: TypingTarget): void {
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
  for (const conversation of entry.conversations.values()) endAnchor(conversation);
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

/**
 * `anchor` is the platform's id for the message that engaged the turn; a
 * newer anchor in the same conversation ends the older one, and none (a turn
 * engaged by something no one wrote) leaves a live one in place.
 */
export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
  anchor?: string,
): void {
  const key = conversationKey(channelType, platformId, threadId, instance);
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    //
    // The pulse moves to this conversation as a whole: a re-trigger can
    // arrive from a different chat address (agent-shared sessions span
    // messaging groups, possibly on different platforms/instances), and a
    // torn target (old address + new instance) would hand e.g. a telegram
    // platformId to a Slack instance's setTyping on the next interval tick.
    // Other conversations keep their anchors until their own work ends.
    let conversation = existing.conversations.get(key);
    if (!conversation) {
      conversation = { channelType, platformId, threadId, instance };
      existing.conversations.set(key, conversation);
    }
    if (anchor !== undefined && anchor !== conversation.anchor) {
      endAnchor(conversation);
      conversation.anchor = anchor;
    }
    existing.current = conversation;
    triggerTyping(conversation).catch(() => {});
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    return;
  }

  // Immediate tick + periodic refresh.
  const conversation: TypingConversation = { channelType, platformId, threadId, instance, anchor };
  triggerTyping(conversation).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      triggerTyping(entry.current).catch(() => {});
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    finishTyping(sessionId, entry);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    conversations: new Map([[key, conversation]]),
    current: conversation,
    interval,
    startedAt,
    pausedUntil: 0,
  });
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

/**
 * Call after every send to the conversation, the agent's or the host's: it
 * ends each turn's anchor there, and pulses go on.
 */
export function endTypingInConversation(
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): void {
  const key = conversationKey(channelType, platformId, threadId, instance);
  for (const entry of typingRefreshers.values()) {
    const conversation = entry.conversations.get(key);
    if (conversation) endAnchor(conversation);
  }
}

/** Ends the turn's anchors as well as its pulse. */
export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  finishTyping(sessionId, entry);
}
