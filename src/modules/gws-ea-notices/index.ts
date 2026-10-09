/**
 * GWS-EA failure notices (R38): when the assistant cannot finish something,
 * whoever should know hears of it once, and a counterpart never does.
 *
 * Core reports three causes, and this module decides who hears and in what
 * words:
 *
 *   - a message the host gave up delivering (registerDeliveryFailedHook);
 *     only a message a person would have read counts;
 *   - an inbound message the host gave up processing (registerInboundFailedHook);
 *   - a turn the agent runner reports as failed (the `turn_failed` delivery action).
 *
 * Who hears depends on whose conversation it was (`ownerOf`):
 *
 *   - one of the principal's own, a session of `main` with a person: the
 *     principal, one plain sentence in their direct message, never in the
 *     conversation the failure came from. A failure in that direct message
 *     keeps its thread there; any other goes to the top of it. A failed turn
 *     whose provider recognized an outage only whoever runs the assistant can
 *     fix (a rejected credential, a spent balance) gets a sentence that does
 *     not ask for a resend, since every resend fails the same way. The notice
 *     is one direct send through the delivery adapter, so it passes the
 *     outbound guard; it is never queued or retried, so a failing channel
 *     cannot turn one notice into a stream of them. Why it failed goes to the
 *     host log only.
 *   - an outside email thread, a session of `external-email`: main, which
 *     knows why the thread exists and decides what the principal needs to
 *     hear. It gets one fact in its session, which wakes it: what failed, in
 *     the conversation with whom, then the thread's key, never what anyone
 *     wrote. The principal asked for nothing there.
 *
 * Host notes and agent-to-agent traffic ride the `agent` channel, and a task
 * session serves no conversation: neither is anyone's to hear of.
 *
 * Delivery reports a give-up before recording it, so a stop in between never
 * loses the report, and the report may come again: the principal's notices
 * record each failed reply they told of, and main's facts carry ids derived
 * from what failed, so each is heard once.
 *
 * Other GWS-EA modules that own a sentence of their own (the inbox, for mail
 * it set aside or an inbox it cannot reach) send it through
 * `sendPrincipalNotice`, to the same audience by the same path.
 */
import { createHash } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getDeliveryAdapter, registerDeliveryAction, registerDeliveryFailedHook } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { registerInboundFailedHook } from '../../reconcile-session.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { conversationPeople } from '../gws-ea-inbox/runtime.js';
import { getExternalEmailAgentGroupId, getMainAgentGroupId, principalContact } from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { gwsEaNoticesMigration } from './migration.js';

registerMigration(gwsEaNoticesMigration);

/** The one plain sentence the principal sees whenever the assistant could not finish. */
const FAILURE_NOTICE_TEXT = "Something went wrong on my side and I couldn't finish that. Please send it again.";

/** What the principal sees when the assistant cannot work until whoever runs it fixes something. */
const OUTAGE_NOTICE_TEXT =
  "I can't do anything at the moment: something on my side needs fixing first, and it isn't anything you need to do. Please send this again later.";

/** The longest provider error the host log keeps from one report; the container writes the row. */
const REPORTED_ERROR_LIMIT = 2000;

type Cause = 'delivery-failed' | 'inbound-failed' | 'turn-failed';

/** The conversation and thread a failed message or turn belonged to. */
export interface Route {
  readonly channelType: string | null;
  readonly platformId: string | null;
  readonly threadId: string | null;
}

/** A conversation with a person, not a host note or another agent. */
function isPersonRoute(route: Route): boolean {
  return route.channelType !== null && route.platformId !== null && route.channelType !== 'agent';
}

/** What a notice's log lines name it by. */
interface NoticeLog {
  readonly label: 'Failure notice' | 'Notice';
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Send `text` to the principal's direct message as one direct send, in
 * `route`'s thread when the route is that direct message. Best effort: the
 * work it reports is already recorded, so a failure is logged, never retried,
 * and never thrown. Returns whether it was delivered.
 */
async function deliverToPrincipal(text: string, route: Route | undefined, notice: NoticeLog): Promise<boolean> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return false;
  /* eslint-disable no-catch-all/no-catch-all -- the notice is best effort; its failure is logged, never retried */
  try {
    const dm = (await principalContact())?.directMessage;
    if (!dm || dm.detached_at) {
      log.info(`${notice.label} not sent: no reachable principal direct message`, notice.fields);
      return false;
    }
    const inDm = route !== undefined && route.channelType === dm.channel_type && route.platformId === dm.platform_id;
    await adapter.deliver(
      dm.channel_type,
      dm.platform_id,
      inDm ? route.threadId : null,
      'chat',
      JSON.stringify({ text }),
      undefined,
      dm.instance,
    );
    log.info(`${notice.label} delivered`, notice.fields);
    return true;
  } catch (err) {
    log.error(`${notice.label} could not be delivered`, { ...notice.fields, err });
    return false;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * Who hears of a failure in a session's conversation: the principal for one
 * of `main`'s, main for an outside email thread of `external-email`'s, and no
 * one for any other session.
 */
async function ownerOf(session: Session): Promise<'principal' | { readonly thread: string } | undefined> {
  if (session.messaging_group_id === null) return undefined;
  if (session.agent_group_id === (await getMainAgentGroupId())) return 'principal';
  if (session.thread_id === null || session.agent_group_id !== (await getExternalEmailAgentGroupId())) return undefined;
  return { thread: session.thread_id };
}

async function tellPrincipal(
  cause: Cause,
  session: Session,
  route: Route,
  text: string = FAILURE_NOTICE_TEXT,
): Promise<void> {
  await deliverToPrincipal(text, route, {
    label: 'Failure notice',
    fields: { cause, sessionId: session.id },
  });
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

/** Tell main of `failed` in an outside thread; the same failures told again write nothing. */
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

/**
 * One plain sentence to the principal, at the top of their direct message,
 * for a module that owns its own wording (such as the inbox reporting a
 * message it set aside). It passes the outbound guard like any send, and is
 * never queued or retried. Returns whether it was delivered.
 */
export async function sendPrincipalNotice(text: string, cause: string): Promise<boolean> {
  return deliverToPrincipal(text, undefined, { label: 'Notice', fields: { cause } });
}

/** A row a person would have seen as a message; a reaction the agent placed is decoration, not a reply. */
function isPersonFacingPost(msg: OutboundMessage): boolean {
  if (msg.kind === 'system' || msg.kind === 'task_log' || !isPersonRoute(msg)) return false;
  let content: unknown;
  /* eslint-disable no-catch-all/no-catch-all -- an unreadable row was still meant for the channel */
  try {
    content = JSON.parse(msg.content);
  } catch {
    return true;
  }
  /* eslint-enable no-catch-all/no-catch-all */
  return (content as { operation?: unknown } | null)?.operation !== 'reaction';
}

/** The failed replies among `ids` the principal has not been told of. */
async function unreported(ids: readonly string[]): Promise<Set<string>> {
  const rows = await getDb().all<{ message_id: string }>(
    `SELECT message_id FROM gws_ea_notices_reported WHERE message_id IN (${ids.map(() => '?').join(', ')})`,
    ...ids,
  );
  const reported = new Set(rows.map((row) => row.message_id));
  return new Set(ids.filter((id) => !reported.has(id)));
}

async function recordReported(ids: readonly string[]): Promise<void> {
  const at = new Date().toISOString();
  for (const id of ids) {
    await getDb().run(
      'INSERT INTO gws_ea_notices_reported (message_id, reported_at) VALUES (?, ?) ON CONFLICT (message_id) DO NOTHING',
      id,
      at,
    );
  }
}

// Delivery may report a give-up again after a stop: whoever hears of a failed message hears of it once.
registerDeliveryFailedHook(async (failed, session) => {
  const posts = failed.filter(isPersonFacingPost);
  const owner = posts.length === 0 ? undefined : await ownerOf(session);
  if (owner === undefined) return;
  if (owner !== 'principal') {
    await tellMain(
      'delivery-failed',
      owner.thread,
      posts.map((post) => post.id),
    );
    return;
  }
  const fresh = await unreported(posts.map((post) => post.id));
  const post = posts.find((candidate) => fresh.has(candidate.id));
  if (!post) return;
  await tellPrincipal('delivery-failed', session, post);
  await recordReported([...fresh]);
});

registerInboundFailedHook(async (failed, session) => {
  const owner = await ownerOf(session);
  const fromPerson = failed.find(isPersonRoute);
  if (owner === 'principal' && fromPerson) await tellPrincipal('inbound-failed', session, fromPerson);
  else if (owner !== undefined && owner !== 'principal') {
    await tellMain(
      'inbound-failed',
      owner.thread,
      failed.map((message) => message.id),
    );
  }
});

/** The route a `turn_failed` report carries; a missing or malformed field counts as none. */
function reportedRoute(content: Record<string, unknown>): Route {
  const field = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
  return {
    channelType: field(content.channelType),
    platformId: field(content.platformId),
    threadId: field(content.threadId),
  };
}

/** The newest message in the session, which a failed turn answered or followed; empty when there is none. */
async function newestMessage(session: Session): Promise<string> {
  const [newest] =
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.getInboundHistory(1))) ??
    [];
  return newest === undefined ? '' : [newest.timestamp, newest.kind, newest.content].join('\n');
}

/** A cause the runner's provider recognized as one only whoever runs the assistant can fix. */
function reportedOutage(content: Record<string, unknown>): 'credentials' | 'billing' | undefined {
  return content.failure === 'credentials' || content.failure === 'billing' ? content.failure : undefined;
}

registerDeliveryAction(
  'turn_failed',
  async (content, session) => {
    const route = reportedRoute(content);
    const outage = reportedOutage(content);
    log.warn('Agent turn failed', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      channelType: route.channelType,
      failure: outage,
      error: typeof content.error === 'string' ? content.error.slice(0, REPORTED_ERROR_LIMIT) : undefined,
    });
    const owner = isPersonRoute(route) ? await ownerOf(session) : undefined;
    if (owner === 'principal') {
      await tellPrincipal('turn-failed', session, route, outage ? OUTAGE_NOTICE_TEXT : FAILURE_NOTICE_TEXT);
    }
    // A failed turn names no message: it is told once for each newest message in the thread's session.
    else if (owner !== undefined) await tellMain('turn-failed', owner.thread, [await newestMessage(session)]);
  },
  unguarded("reports a failure to the principal or main only; the principal's notice passes the outbound guard"),
);
