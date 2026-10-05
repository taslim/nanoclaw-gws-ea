/**
 * Human pace (KTD3, R62): an outside thread is worked 3 to 6 minutes after
 * its first message not yet answered, and all at once.
 *
 * A row written into an outside thread's session, `external-email`'s session
 * for a thread in the inbox (`email:inbox`), waits until the session's
 * pending deadline when it has one, and otherwise until a random 3 to 6
 * minutes from now. Core's `process_after` holds it: the agent runner never
 * reads a row before it is due, and the host sweep wakes the session once it
 * is, so everything that arrived meanwhile reaches the agent in one turn.
 * The router asks for the deadline as it writes each email, the principal's
 * included (index.ts); `main`'s handoffs ask as they are written.
 *
 * A deadline is pending only while it is ahead and pace set it: a reminder
 * keeps its own time, and a retried message waits out its backoff, so
 * neither holds new mail. Once the agent has a batch, the next row starts a
 * new wait. No other session is delayed: the principal's own email and every
 * note to `main` are worked as they come.
 */
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { isReminderId } from '../gws-ea-reminders/index.js';
import { emailMessagingGroupIds } from './db.js';

/** The shortest wait for an outside thread's first unanswered message. */
const PACE_MIN_MS = 3 * 60_000;
/** The longest. */
const PACE_MAX_MS = 6 * 60_000;

/**
 * When a row written now into `session` is to be read: the outside thread's
 * pending deadline, or a new one. Null for every other session.
 */
export async function paceDeadline(session: Session): Promise<string | null> {
  const { inbox } = await emailMessagingGroupIds();
  if (inbox === null || session.messaging_group_id !== inbox || session.thread_id === null) return null;
  const waiting = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getWaitingMessages(),
  );
  const pending = waiting?.find((message) => message.tries === 0 && !isReminderId(message.id));
  return (
    pending?.processAfter ??
    new Date(Date.now() + PACE_MIN_MS + Math.random() * (PACE_MAX_MS - PACE_MIN_MS)).toISOString()
  );
}
