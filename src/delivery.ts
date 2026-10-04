/**
 * Poll outbound mailboxes and deliver undelivered messages through channel adapters.
 * SQLite reads runner-owned outbound state read-only and records delivery in
 * host-owned inbound state; other implementations preserve that ownership.
 *
 * Two poll loops share one body (`deliverToSessions`): the active poll every
 * ~1s over sessions with a running/idle container, the sweep poll every ~60s
 * over every active session. Each visits up to DELIVERY_CONCURRENCY sessions
 * at once and re-arms at a fixed rate measured from the tick's START, so a
 * slow tick (remote mailbox, many sessions) neither serializes every
 * session's latency nor adds a full interval of dead time after it.
 */
import {
  getRunningSessions,
  getActiveSessions,
  getSession,
  createPendingQuestion,
  isTaskThread,
  TASKS_SYSTEM_THREAD_ID,
} from './db/sessions.js';
import { appendRunLog } from './modules/scheduling/run-log.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import {
  getMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupForOwnDestination,
} from './db/messaging-groups.js';
import { clearDeliveryAttempt, listExhaustedDeliveryAttempts, recordDeliveryAttempt } from './db/coordination.js';
import { runGuarded, type DeliveryGuardSpec, type GuardedDeliveryHandler } from './delivery-guard.js';
import { isUnguarded, type Unguarded } from './guard/index.js';
import { mapConcurrent } from './concurrency.js';
import { fanOutboundMessage } from './modules/cross-session-context/index.js';
import { log } from './log.js';
import { normalizeOptions } from './channels/ask-question.js';
import { requestWake } from './request-wake.js';
import { clearOutbox, readOutboxFiles, withExistingMailboxSession, writeSessionMessage } from './session-manager.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import type { OutboundFile } from './channels/adapter.js';
import type { PendingApproval, Session } from './types.js';
import type { OutboundMessage } from './mailbox/index.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;
/**
 * Sessions drained in parallel per poll tick. A visit is one mailbox round
 * trip (read the queue) plus the channel sends; serially, a tick scaled as
 * sessions × mailbox latency, so ~12 running sessions on a 40 ms/hop remote
 * mailbox already overran the 1 s active interval. Sessions are independent
 * (per-session re-entry is guarded by `inflightDeliveries`; the two polls
 * already interleave across sessions), and message order WITHIN a session is
 * unchanged — drainSession still delivers its rows one by one.
 */
const DELIVERY_CONCURRENCY = 8;

/**
 * Attempt counts live in the `delivery_attempts` table, so they survive a
 * host restart: a poison message gets MAX_DELIVERY_ATTEMPTS total, not
 * MAX_DELIVERY_ATTEMPTS per process lifetime (the old in-memory counter
 * reset on every restart, so a crash-looping host retried it forever).
 * Bookkeeping failures must never break delivery: a failed record skips the
 * give-up decision for this tick (the message just retries next poll), and a
 * failed clear leaves a stale row the next lifecycle of the same id clears.
 */
async function recordAttemptRow(messageId: string, sessionId: string, err: unknown): Promise<number | null> {
  /* eslint-disable no-catch-all/no-catch-all -- attempt bookkeeping must never break delivery */
  try {
    return await recordDeliveryAttempt({
      messageId,
      sessionId,
      now: new Date().toISOString(),
      nextAttemptAt: null,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch (recordErr) {
    log.error('Failed to record delivery attempt — retrying next poll without a count', {
      messageId,
      sessionId,
      err: recordErr,
    });
    return null;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Messages given up on whose failure is not recorded yet; none when the bookkeeping cannot be read. */
async function exhaustedAttempts(sessionId: string): Promise<Set<string>> {
  /* eslint-disable no-catch-all/no-catch-all -- attempt bookkeeping must never break delivery */
  try {
    return await listExhaustedDeliveryAttempts(sessionId, MAX_DELIVERY_ATTEMPTS);
  } catch (err) {
    log.error('Failed to read spent delivery attempts — retrying them as usual this poll', { sessionId, err });
    return new Set();
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

async function clearAttemptRow(messageId: string): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- attempt bookkeeping must never break delivery */
  try {
    await clearDeliveryAttempt(messageId);
  } catch (err) {
    log.warn('Failed to clear delivery attempt row', { messageId, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * Sessions whose outbound queue is currently being drained, each with the
 * pass's completion, so a stop can wait for it (`stopDeliveryPolls`).
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Map<string, Promise<void>>();

/** How long a stop waits for delivery passes under way, so one is not cut between a send and its record. */
const STOP_WAIT_MS = 10_000;

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
    /** Delivering adapter instance (defaults to channelType downstream).
     *  Host-internal only — containers never see instance. */
    instance?: string,
  ): Promise<string | undefined>;
  setTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance?: string,
    status?: string,
    statusKind?: 'auto' | 'agent',
  ): Promise<void>;
}

/**
 * Outbound guards.
 *
 * Every send through the delivery adapter (an agent's reply, an approval
 * card, a host notice) passes each registered guard, in registration order,
 * before the channel sees it. The check lives in the adapter that
 * setDeliveryAdapter installs, so a module sending through
 * getDeliveryAdapter() cannot route around it.
 *
 * A guard allows the send or refuses it with a reason the sender may read.
 * A refusal throws OutboundRefusedError and nothing reaches the channel; the
 * delivery poll closes such a row as a third outcome beside delivered and
 * failed (see closeRefused). A guard that throws fails closed: the send
 * fails into the caller's normal failure path and the error is logged. With
 * no guard registered, every send goes straight to the adapter.
 */
export interface OutboundSend {
  readonly channelType: string;
  readonly platformId: string;
  readonly threadId: string | null;
  /** Delivering adapter instance; undefined means the channel type's default. */
  readonly instance: string | undefined;
  readonly kind: string;
  /** The serialized message, exactly as the adapter receives it. */
  readonly content: string;
  readonly files: readonly OutboundFile[] | undefined;
}

export type OutboundGuardDecision =
  | { readonly effect: 'allow' }
  | {
      readonly effect: 'refuse';
      /** Shown to the sender. Says why without repeating what was refused. */
      readonly reason: string;
    };

export type OutboundGuard = (send: OutboundSend) => OutboundGuardDecision | Promise<OutboundGuardDecision>;

/** A guard refused the send; nothing reached the channel. */
export class OutboundRefusedError extends Error {
  constructor(
    readonly guardId: string,
    readonly reason: string,
  ) {
    super(`Outbound send refused by ${guardId}`);
    this.name = 'OutboundRefusedError';
  }
}

const outboundGuards = new Map<string, OutboundGuard>();
const OUTBOUND_GUARD_ID = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/u;

/** Register a check every outbound send must pass. IDs take the `module:name` form. */
export function registerOutboundGuard(id: string, guard: OutboundGuard): void {
  if (!OUTBOUND_GUARD_ID.test(id)) throw new Error(`Invalid outbound guard ID: ${id}`);
  if (outboundGuards.has(id)) throw new Error(`Outbound guard already registered: ${id}`);
  outboundGuards.set(id, guard);
}

/** Only an explicit allow from every guard lets a send through. */
async function assertOutboundAllowed(send: OutboundSend): Promise<void> {
  for (const [id, guard] of outboundGuards) {
    let decision: OutboundGuardDecision;
    try {
      decision = await guard(send);
    } catch (err) {
      log.error('Outbound guard threw — the send fails closed', { guardId: id, channelType: send.channelType, err });
      throw new Error(`Outbound guard ${id} failed; nothing was sent`, { cause: err });
    }
    if (decision.effect === 'allow') continue;
    throw new OutboundRefusedError(id, decision.reason);
  }
}

function guardAdapter(adapter: ChannelDeliveryAdapter): ChannelDeliveryAdapter {
  return {
    async deliver(channelType, platformId, threadId, kind, content, files, instance) {
      await assertOutboundAllowed({ channelType, platformId, threadId, instance, kind, content, files });
      return adapter.deliver(channelType, platformId, threadId, kind, content, files, instance);
    },
    ...(adapter.setTyping && { setTyping: adapter.setTyping.bind(adapter) }),
  };
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * gateway approval handlers) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady.
 *  Its sends pass the outbound guards. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/**
 * Install the channel adapter and return its guarded form, which every host
 * caller should use so its sends pass the registered outbound guards too.
 */
export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): ChannelDeliveryAdapter {
  const guarded = guardAdapter(adapter);
  deliveryAdapter = guarded;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(guarded))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
  return guarded;
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  void pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  void pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;
  const startedAt = Date.now();

  try {
    await deliverToSessions(await getRunningSessions());
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  if (!activePolling) return;
  setTimeout(() => void pollActive(), nextTickDelay(startedAt, ACTIVE_POLL_MS));
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;
  const startedAt = Date.now();

  try {
    await deliverToSessions(await getActiveSessions());
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  if (!sweepPolling) return;
  setTimeout(() => void pollSweep(), nextTickDelay(startedAt, SWEEP_POLL_MS));
}

/**
 * Fixed-rate cadence: the next tick starts `intervalMs` after this one
 * STARTED, never before this one ended (ticks don't overlap — the same
 * promise chain arms the next). A tick that overran its interval re-arms
 * after a short breather (a tenth of the interval) rather than spinning.
 */
function nextTickDelay(startedAt: number, intervalMs: number): number {
  return Math.max(Math.floor(intervalMs / 10), intervalMs - (Date.now() - startedAt));
}

/**
 * One poll tick's body: drain every listed session, DELIVERY_CONCURRENCY at a
 * time. A session whose drain throws (central lookup failed, mailbox
 * unavailable) is logged and skipped; it never costs the other sessions
 * their turn this tick.
 */
export async function deliverToSessions(sessions: readonly Session[]): Promise<void> {
  const results = await mapConcurrent(sessions, DELIVERY_CONCURRENCY, (session) => deliverSessionMessages(session));
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      log.error('Session delivery failed', { sessionId: sessions[i].id, err: result.reason });
    }
  });
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  let finished: () => void = () => undefined;
  inflightDeliveries.set(
    session.id,
    new Promise<void>((resolve) => {
      finished = resolve;
    }),
  );

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
    finished();
  }
}

async function drainSession(session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  // Read the queue in one short mailbox session, then deliver with NO
  // session held open: delivery handlers (agent-to-agent routing, approval
  // notifications, cli_request → dispatch) open their own sessions on this
  // same key, and implementations may serialize session() per key — holding
  // the session across delivery would deadlock them. Same re-entry class the
  // reconciler avoids around requestWake (see reconcile-session.ts).
  let delivered: Set<string>;
  let pending: OutboundMessage[];
  try {
    const existing = await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => {
      const delivered = mailbox.getDeliveredIds();
      return {
        delivered,
        pending: mailbox.getDueMessages(delivered).filter((candidate) => !delivered.has(candidate.id)),
      };
    });
    if (!existing) return;
    ({ delivered, pending } = existing);
  } catch (err) {
    log.error('Session mailbox delivery failed', {
      agentGroupId: agentGroup.id,
      sessionId: session.id,
      err,
    });
    return;
  }

  for (const hook of batchPreviewHooks) {
    try {
      await hook(
        pending.map(({ kind, content }) => ({ kind, content })),
        session,
      );
    } catch (err) {
      log.warn('Delivery batch-preview hook failed', { sessionId: session.id, err });
    }
  }

  // Rows given up on before a stop cut their report short: reported below, never sent again.
  const exhausted = pending.length > 0 ? await exhaustedAttempts(session.id) : new Set<string>();
  const givenUp: OutboundMessage[] = [];
  for (const msg of pending) {
    if (exhausted.has(msg.id)) {
      givenUp.push(msg);
      continue;
    }
    try {
      const platformMsgId = await deliverMessage(msg, session);
      await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) =>
        mailbox.markDelivered(msg.id, platformMsgId ?? null),
      );
      const firstDelivery = delivered.size === 0;
      delivered.add(msg.id);
      await clearAttemptRow(msg.id);
      if (msg.kind !== 'system' && msg.channelType !== 'agent') {
        pauseTypingRefreshAfterDelivery(session.id);
        if (msg.kind !== 'task_log') {
          // Cross-session context: echo the delivered reply into the
          // conversation's recently active sibling sessions. Unawaited — the
          // next part of a multi-part reply must not wait on ambient writes.
          void fanOutboundMessage(
            {
              id: msg.id,
              kind: msg.kind,
              platform_id: msg.platformId,
              channel_type: msg.channelType,
              content: msg.content,
            },
            session,
            agentGroup,
          );
          for (const hook of postDeliveryHooks) {
            try {
              await hook(msg, session, { firstDelivery });
            } catch (err) {
              log.warn('Post-delivery hook failed', { messageId: msg.id, sessionId: session.id, err });
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof OutboundRefusedError) {
        await closeRefused(msg, session, agentGroup.id, err);
        continue;
      }
      const attempts = await recordAttemptRow(msg.id, session.id, err);
      if (attempts !== null && attempts >= MAX_DELIVERY_ATTEMPTS) {
        log.error('Message delivery failed permanently, giving up', {
          messageId: msg.id,
          sessionId: session.id,
          attempts,
          err,
        });
        givenUp.push(msg);
      } else {
        log.warn('Message delivery failed, will retry', {
          messageId: msg.id,
          sessionId: session.id,
          // null: the bookkeeping write itself failed; count unknown this tick.
          attempt: attempts,
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
          err,
        });
      }
    }
  }

  // Once per pass, after it: one report however many rows gave up together.
  // The report comes before the failure is recorded: a stop between them
  // leaves the rows pending with their attempts spent, and the next pass
  // reports them again instead of losing the report.
  if (givenUp.length > 0) {
    for (const hook of deliveryFailedHooks) {
      /* eslint-disable no-catch-all/no-catch-all -- a failing hook must never affect the recorded failure or other hooks */
      try {
        await hook(givenUp, session);
      } catch (err) {
        log.warn('Delivery-failed hook failed', { sessionId: session.id, err });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
    for (const msg of givenUp) {
      try {
        await withExistingMailboxSession(agentGroup.id, session.id, (mailbox) => mailbox.markDeliveryFailed(msg.id));
        await clearAttemptRow(msg.id);
      } catch (markErr) {
        log.error('Failed to record permanent delivery failure', {
          messageId: msg.id,
          sessionId: session.id,
          err: markErr,
        });
      }
    }
  }
}

/**
 * Close a row a guard refused. It is recorded as not delivered (the
 * mailbox's terminal `failed` status), so it is never retried, and the agent
 * that wrote it is told why. Nothing else follows: no cross-session copy and
 * no post-delivery or delivery-failed hook, because nothing was sent and
 * nothing failed. A row that cannot be recorded stays queued; the guard
 * judges it again on the next poll, and the agent is told then.
 */
async function closeRefused(
  msg: OutboundMessage,
  session: Session,
  agentGroupId: string,
  refusal: OutboundRefusedError,
): Promise<void> {
  log.warn('Outbound message refused', { messageId: msg.id, sessionId: session.id, guardId: refusal.guardId });
  /* eslint-disable no-catch-all/no-catch-all -- a refusal's bookkeeping must never break delivery of the rows after it */
  try {
    await withExistingMailboxSession(agentGroupId, session.id, (mailbox) => mailbox.markDeliveryFailed(msg.id));
  } catch (err) {
    log.error('Failed to record a refused delivery — it is judged again next poll', {
      messageId: msg.id,
      sessionId: session.id,
      err,
    });
    return;
  }
  await clearAttemptRow(msg.id);
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `refused-${msg.id}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `Your message was not sent: ${refusal.reason}`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = await getSession(session.id);
    if (fresh) await requestWake(fresh, 'inbound-message');
  } catch (err) {
    log.error('Could not tell the agent its message was refused', { messageId: msg.id, sessionId: session.id, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    inReplyTo: string | null;
  },
  session: Session,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (cli_request, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session);
    return;
  }

  // Task-run log: the runner mirrors a run's final text here (one-door
  // delivery — final text never reaches a channel; the send_message tool is
  // the only delivery path from a task session). Append to the series log,
  // never deliver. The caller marks it delivered so it isn't retried.
  if (msg.kind === 'task_log') {
    if (session.messaging_group_id === null && isTaskThread(session.thread_id) && session.thread_id) {
      const series = session.thread_id.slice(`${TASKS_SYSTEM_THREAD_ID}:`.length);
      try {
        await appendRunLog(session.agent_group_id, series, typeof content.text === 'string' ? content.text : '');
      } catch (err) {
        log.warn('Failed to append task run log', { id: msg.id, sessionId: session.id, err });
      }
    } else {
      log.warn('task_log row outside a task session — ignoring', { id: msg.id, sessionId: session.id });
    }
    return;
  }

  // Agent-to-agent — route to target session via the agent-to-agent module.
  // Guarded by the channel_type check. If the module isn't installed the
  // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
  // check will throw, which falls into the normal retry → mark-failed path.
  if (msg.channelType === 'agent') {
    if (!(await hasTable(getDb(), 'agent_destinations'))) {
      throw new Error(`agent-to-agent module not installed — cannot route message ${msg.id}`);
    }
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    await routeAgentMessage(
      {
        id: msg.id,
        platform_id: msg.platformId,
        content: msg.content,
        in_reply_to: msg.inReplyTo,
      },
      session,
    );
    return;
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  let deliverInstance: string | undefined;
  if (msg.channelType && msg.platformId) {
    // Resolve the messaging group ORIGIN-SESSION-FIRST: when the message
    // targets the session's own chat address, the origin row wins even if
    // sibling instances share the same (channel_type, platform_id) — so the
    // reply goes out through the instance the message came in on. Otherwise
    // prefer the sender's own destination-mapped instance (correct even when
    // sibling instances share the same channel address), falling back to the
    // by-platform lookup (default-instance-first) when the sender has no
    // matching destination.
    const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    const mg =
      originMg && originMg.channel_type === msg.channelType && originMg.platform_id === msg.platformId
        ? originMg
        : ((await getMessagingGroupForOwnDestination(session.agent_group_id, msg.channelType, msg.platformId)) ??
          (await getMessagingGroupByPlatform(msg.channelType, msg.platformId)));
    if (!mg) {
      throw new Error(`unknown messaging group for ${msg.channelType}/${msg.platformId} (message ${msg.id})`);
    }
    if (mg.detached_at) {
      // The bot was removed from this conversation (a channel membership
      // module stamps detached_at when the bot leaves). Fail into the retry
      // path rather than sending into a channel that will reject us; rejoin
      // clears the stamp.
      throw new Error(
        `messaging group ${mg.id} is detached (bot removed from ${mg.channel_type}/${mg.platform_id} at ${mg.detached_at})`,
      );
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless). Inlined SQL instead
    // of importing `hasDestination` so core doesn't depend on the module.
    if (!isOriginChat && (await hasTable(getDb(), 'agent_destinations'))) {
      const row = await getDb().get(
        'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        session.agent_group_id,
        'channel',
        mg.id,
      );
      if (!row) {
        throw new Error(
          `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
        );
      }
    }
    deliverInstance = mg.instance;
  }

  // Track pending questions for ask_user_question flow.
  // Guarded: without the interactive module, `pending_questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && (await hasTable(getDb(), 'pending_questions'))) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      const inserted = await createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platformId,
        channel_type: msg.channelType,
        thread_id: msg.threadId,
        title,
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
      }
    }
  }

  // Channel delivery
  if (!msg.channelType || !msg.platformId) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channelType,
    msg.platformId,
    msg.threadId,
    msg.kind,
    msg.content,
    files,
    deliverInstance,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channelType,
    platformId: msg.platformId,
    platformMsgId,
    fileCount: files?.length,
  });

  clearOutbox(session.agent_group_id, session.id, msg.id);

  return platformMsgId;
}

/**
 * Post-delivery hooks.
 *
 * Registered modules observe each successfully delivered user-facing
 * message (non-system, non-agent, non-task_log) right after it is marked
 * delivered, with a first-delivery flag. This gives channel modules a
 * supported seam for one-time follow-through on a session's first outbound
 * message (e.g. onboarding affordances) without hardcoding platform
 * behavior in the delivery core.
 *
 * Hooks are decoration only: each invocation is wrapped in try/catch, so a
 * failing hook can never affect delivery, markDelivered, or retries.
 */
export interface PostDeliveryInfo {
  /**
   * True when this is the first message ever marked delivered in this
   * session — exactly one row per session carries it. Every delivered row
   * counts toward the flag (including system rows the hook itself never
   * fires for); the hook only ever observes user-facing rows.
   */
  firstDelivery: boolean;
}

export type PostDeliveryHook = (msg: OutboundMessage, session: Session, info: PostDeliveryInfo) => void | Promise<void>;

const postDeliveryHooks: PostDeliveryHook[] = [];

export function registerPostDeliveryHook(hook: PostDeliveryHook): void {
  postDeliveryHooks.push(hook);
}

/**
 * Delivery-failed hooks.
 *
 * Registered modules hear, once per delivery pass, about every row that pass
 * gave up on after MAX_DELIVERY_ATTEMPTS, of any kind, so the hook decides
 * which failures matter and who hears about them. A refused row never
 * reaches them: a refusal is an outcome the sending agent is told about, not
 * a failure.
 *
 * They hear before the failure is recorded, so a stop in between never loses
 * the report: the next pass reports those rows again. A hook may therefore
 * hear a row more than once, and must be safe to repeat.
 *
 * Like post-delivery hooks, each invocation is isolated: a failing hook can
 * never affect delivery, the recorded failure, or the hooks after it.
 */
export type DeliveryFailedHook = (failed: readonly OutboundMessage[], session: Session) => void | Promise<void>;

const deliveryFailedHooks: DeliveryFailedHook[] = [];

export function registerDeliveryFailedHook(hook: DeliveryFailedHook): void {
  deliveryFailedHooks.push(hook);
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Unknown actions log "Unknown system action".
 *
 * Privileged delivery actions (create_agent, install_packages,
 * add_mcp_server) register with a guard spec: every path to the handler body
 * — dispatch, approved replay, test lookup — goes through the guard consult
 * (allow / hold / deny), so there is no unguarded route to it. On approve,
 * the continuation re-enters the same entry carrying the approval row as its
 * grant (`reenterGuardedDeliveryAction`), so the structural checks are
 * re-run live. Plain actions (the cli_request bridge — its inner
 * commands are guarded at dispatch) register with an
 * explicit `unguarded(<reason>)` declaration instead of a spec — omission is
 * not representable, so the decision to run unguarded is visible, and
 * justified, at the registration site.
 */
/**
 * Handlers run with NO mailbox session held — they (and anything they call,
 * e.g. writeSessionMessage or dispatch) open their own sessions. Never
 * accept or capture an open MailboxSession here: implementations may
 * serialize session() per key, and a held session would deadlock them.
 */
export type DeliveryActionHandler = (content: Record<string, unknown>, session: Session) => Promise<void>;

type DeliveryEntry =
  | { guard: Unguarded; handler: DeliveryActionHandler }
  | { guard: DeliveryGuardSpec; handler: GuardedDeliveryHandler };

const deliveryActions = new Map<string, DeliveryEntry>();

function isUnguardedEntry(entry: DeliveryEntry): entry is Extract<DeliveryEntry, { guard: Unguarded }> {
  return isUnguarded(entry.guard);
}

/** See the batch-preview invocation in the delivery poll for semantics. */
type DeliveryBatchPreviewHook = (
  batch: Array<{ kind: string; content: string }>,
  session: Session,
) => void | Promise<void>;
const batchPreviewHooks: DeliveryBatchPreviewHook[] = [];
export function registerDeliveryBatchPreview(hook: DeliveryBatchPreviewHook): void {
  batchPreviewHooks.push(hook);
}

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler, unguardedDecl: Unguarded): void;
export function registerDeliveryAction(action: string, handler: GuardedDeliveryHandler, spec: DeliveryGuardSpec): void;
export function registerDeliveryAction(
  action: string,
  handler: DeliveryActionHandler | GuardedDeliveryHandler,
  guardDecl: DeliveryGuardSpec | Unguarded,
): void {
  const existing = deliveryActions.get(action);
  if (existing) {
    // Replacing a guard-wrapped action with an unguarded handler would
    // disarm the guard while its catalog entry still exists — refuse. A
    // skill that wants to extend a guarded action must compose at the
    // module's exported functions instead, or re-register with a guard spec
    // of its own.
    if (isUnguarded(guardDecl) && !isUnguardedEntry(existing)) {
      throw new Error(
        `delivery action "${action}" is guard-wrapped; re-registering it without a guard spec would disarm the guard`,
      );
    }
    log.warn('Delivery action handler overwritten', { action });
  }
  // The overloads pair each handler shape with its declaration; the merged
  // implementation signature erases that pairing, hence the one cast.
  deliveryActions.set(action, { guard: guardDecl, handler } as DeliveryEntry);
}

/**
 * Approve continuation for a guard-wrapped delivery action: re-enter the
 * entry with the approval row as the grant. The guard treats the grant as
 * hold-satisfied but re-runs the structural checks, so approve-then-revoke
 * does not execute. Domains register this as their approval handler in the
 * same line that registers the action.
 */
export function reenterGuardedDeliveryAction(action: string) {
  return async (ctx: { session: Session; payload: Record<string, unknown>; approval: PendingApproval }) => {
    const entry = deliveryActions.get(action);
    if (!entry || isUnguardedEntry(entry)) {
      log.warn('Approved replay for an action that is not guard-wrapped — dropping', { action });
      return;
    }
    await runGuarded(action, entry.guard, entry.handler, ctx.payload, ctx.session, ctx.approval);
  };
}

/**
 * The invocable for a registered action — the raw handler for unguarded
 * entries, the guard-consulting path for guarded ones. Dispatch and tests
 * both come through here; there is no route around the guard.
 */
export function getDeliveryAction(action: string): DeliveryActionHandler | undefined {
  const entry = deliveryActions.get(action);
  if (!entry) return undefined;
  if (isUnguardedEntry(entry)) return entry.handler;
  return (content, session) => runGuarded(action, entry.guard, entry.handler, content, session, null);
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(content: Record<string, unknown>, session: Session): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = getDeliveryAction(action);
  if (registered) {
    await registered(content, session);
    return;
  }

  log.warn('Unknown system action', { action });
}

/**
 * Stop both polls, then wait up to `maxWaitMs` for delivery passes already
 * under way: the host closes the DB next, and a pass cut short would lose
 * what it was about to record.
 */
export async function stopDeliveryPolls(maxWaitMs = STOP_WAIT_MS): Promise<void> {
  activePolling = false;
  sweepPolling = false;
  const running = [...inflightDeliveries.values()];
  if (running.length === 0) return;
  let bound: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(running),
    new Promise<void>((resolve) => {
      bound = setTimeout(resolve, maxWaitMs);
    }),
  ]);
  clearTimeout(bound);
}
