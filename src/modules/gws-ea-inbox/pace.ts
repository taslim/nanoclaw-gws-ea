/**
 * Human pace: an outside thread is worked 3 to 6 minutes after its first
 * message not yet answered, and all at once.
 *
 * A row written into an outside thread's session, `external-email`'s session
 * for a thread in the inbox (`email:inbox`), waits until the session's
 * pending deadline when it has one, and otherwise until a random 3 to 6
 * minutes from now. Core's `process_after` holds it: the agent runner never
 * reads a row before it is due, and the host sweep wakes the session once it
 * is, so everything that arrived meanwhile reaches the agent in one turn.
 * The router asks for the deadline as it writes each email, the principal's
 * on an outside thread included (index.ts). `main`'s handoff starts no wait
 * of its own: it joins the pending deadline when there is one, so it is
 * worked with the mail already waiting, and is otherwise due as written
 * (`pendingDeadline`).
 *
 * A deadline is pending only while it is ahead and pace set it: a retried
 * message waits out its backoff, which holds no new mail. Once the agent has
 * a batch, the next row starts a new wait. No other session is delayed.
 *
 * Pace starts once `main` has handed the thread over. Until then every row
 * the router writes into the thread's session is held: no turn reads it and
 * nothing waits on it or wakes for it. The handoff releases what is held to
 * the thread's pending deadline, with main's words.
 */
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { emailMessagingGroupIds } from './db.js';
import { threadPlacement } from './thread-map.js';

const PACE_MIN_MS = 3 * 60_000;
const PACE_MAX_MS = 6 * 60_000;

async function isOutsideThread(session: Session): Promise<boolean> {
  const { inbox } = await emailMessagingGroupIds();
  return inbox !== null && session.messaging_group_id === inbox && session.thread_id !== null;
}

/** Only a row never tried holds a deadline pace set: a retried one waits out its backoff. */
async function waitingDeadline(session: Session): Promise<string | null> {
  const waiting = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getWaitingMessages(),
  );
  return waiting?.find((message) => message.tries === 0)?.processAfter ?? null;
}

async function outsideDeadline(session: Session): Promise<string> {
  return (
    (await waitingDeadline(session)) ??
    new Date(Date.now() + PACE_MIN_MS + Math.random() * (PACE_MAX_MS - PACE_MIN_MS)).toISOString()
  );
}

/** Null for every session but an outside thread's. */
export async function paceDeadline(session: Session): Promise<string | null> {
  return (await isOutsideThread(session)) ? outsideDeadline(session) : null;
}

export interface InboundPace {
  readonly deadline: string;
  /**
   * Held for main, which wins over the deadline: an outside thread's mail is
   * read only once main has handed the thread over, however the thread began.
   */
  readonly held: boolean;
}

/** Undefined for every session but an outside thread's. */
export async function inboundPace(session: Session): Promise<InboundPace | undefined> {
  const threadKey = session.thread_id;
  if (threadKey === null || !(await isOutsideThread(session))) return undefined;
  const deadline = await outsideDeadline(session);
  return { deadline, held: (await threadPlacement(threadKey))?.released !== true };
}

/** The deadline a row written now joins; null when none is ahead, and for every session but an outside thread's. */
export async function pendingDeadline(session: Session): Promise<string | null> {
  return (await isOutsideThread(session)) ? waitingDeadline(session) : null;
}
