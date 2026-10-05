/**
 * external-email's failures, told to main (R38): quiet never hides a
 * problem, and the principal hears of one from the assistant first.
 *
 * The principal asked for nothing in an outside thread, so the notices
 * module never tells them of a failure there. main hears instead: it knows
 * why the thread exists, and decides what the principal needs to hear. For a
 * session of `external-email`, by the profile's pointer, working one email
 * thread, three causes are reported:
 *
 *   - an email it wrote that delivery gave up on (registerDeliveryFailedHook);
 *     only a message a person would have read counts, as for the principal;
 *   - what arrived in the thread that the host gave up processing
 *     (registerInboundFailedHook);
 *   - its work on the thread failing (the notices module's turn-failed hook).
 *
 * Each report is one fact in main's session, which wakes it: the thread's
 * key and what failed, never what anyone wrote. Its id is derived from what
 * failed, so a report heard again writes nothing twice: delivery reports a
 * give-up again after a stop, and a failed turn's report may be delivered
 * again. A failed turn names no message, so it is told once for each newest
 * message in the thread's session.
 */
import { createHash } from 'node:crypto';

import { registerDeliveryFailedHook } from '../../delivery.js';
import { log } from '../../log.js';
import { registerInboundFailedHook } from '../../reconcile-session.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { isPersonFacingPost, registerTurnFailedHook } from '../gws-ea-notices/index.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';

type Cause = 'delivery-failed' | 'inbound-failed' | 'turn-failed';

/** The email thread a session of external-email works; undefined for every other session. */
async function threadOf(session: Session): Promise<string | undefined> {
  if (session.messaging_group_id === null || session.thread_id === null) return undefined;
  return session.agent_group_id === (await getExternalEmailAgentGroupId()) ? session.thread_id : undefined;
}

function whatFailed(cause: Cause, threadKey: string): string {
  switch (cause) {
    case 'delivery-failed':
      return `What external-email wrote in email thread ${threadKey} could not be sent, even after retrying.`;
    case 'inbound-failed':
      return `What arrived in email thread ${threadKey} could not be processed, even after retrying, so external-email has not answered it.`;
    case 'turn-failed':
      return `external-email's work in email thread ${threadKey} failed before it finished, so the thread may be left unanswered.`;
    default: {
      const unreachable: never = cause;
      throw new Error(`Unknown failure: ${String(unreachable)}`);
    }
  }
}

/** Tell main of `failed` in the thread; the same failures told again write nothing. */
async function tellMain(cause: Cause, threadKey: string, failed: readonly string[]): Promise<void> {
  const digest = createHash('sha256')
    .update([threadKey, ...[...failed].sort()].join('\n'))
    .digest('hex')
    .slice(0, 32);
  const result = await writeNoteForMain({
    id: `external-email-${cause}-${digest}`,
    timestamp: new Date().toISOString(),
    text: whatFailed(cause, threadKey),
    wake: true,
  });
  if (result === 'no-main' || result === 'no-principal') {
    log.warn('Nobody to tell of an external-email failure', { threadKey, cause, result });
  }
}

/** The newest message in the session, which a failed turn answered or followed; empty when there is none. */
async function newestMessage(session: Session): Promise<string> {
  const [newest] =
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.getInboundHistory(1))) ??
    [];
  return newest === undefined ? '' : [newest.timestamp, newest.kind, newest.content].join('\n');
}

registerDeliveryFailedHook(async (failed, session) => {
  const emails = failed.filter(isPersonFacingPost).map((email) => email.id);
  const threadKey = emails.length === 0 ? undefined : await threadOf(session);
  if (threadKey !== undefined) await tellMain('delivery-failed', threadKey, emails);
});

registerInboundFailedHook(async (failed, session) => {
  const threadKey = await threadOf(session);
  const messages = failed.map((message) => message.id);
  if (threadKey !== undefined) await tellMain('inbound-failed', threadKey, messages);
});

registerTurnFailedHook('gws-ea-external-email:failed', async (_route, session) => {
  const threadKey = await threadOf(session);
  if (threadKey !== undefined) await tellMain('turn-failed', threadKey, [await newestMessage(session)]);
});
