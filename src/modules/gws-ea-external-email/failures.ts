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
 * Each report is one fact in main's session, which wakes it: what failed,
 * in the conversation with whom, then the thread's key; never what anyone
 * wrote. Its id is derived from what
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
import { conversationPeople } from '../gws-ea-inbox/runtime.js';
import { isPersonFacingPost, registerTurnFailedHook } from '../gws-ea-notices/index.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';

type Cause = 'delivery-failed' | 'inbound-failed' | 'turn-failed';

/** The email thread a session of external-email works; undefined for every other session. */
async function threadOf(session: Session): Promise<string | undefined> {
  if (session.messaging_group_id === null || session.thread_id === null) return undefined;
  return session.agent_group_id === (await getExternalEmailAgentGroupId()) ? session.thread_id : undefined;
}

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

function whatFailed(cause: Cause, threadKey: string, people: readonly string[]): string {
  const conversation = people.length === 0 ? 'an email conversation' : `the conversation with ${LIST.format(people)}`;
  const thread = `(thread ${threadKey})`;
  switch (cause) {
    case 'delivery-failed':
      return `An email external-email wrote in ${conversation} didn't go out, even after retrying. ${thread}`;
    case 'inbound-failed':
      return `external-email hasn't answered something that arrived in ${conversation}: it couldn't be processed, even after retrying. ${thread}`;
    case 'turn-failed':
      return `${conversation.charAt(0).toUpperCase()}${conversation.slice(1)} may be left unanswered: external-email's work on it failed before it finished. ${thread}`;
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
    text: whatFailed(cause, threadKey, await conversationPeople(threadKey)),
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
