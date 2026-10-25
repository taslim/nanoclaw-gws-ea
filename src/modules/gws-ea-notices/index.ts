/**
 * GWS-EA failure notices: when the assistant cannot finish something, whoever
 * should know hears of it once, and a counterpart never does.
 *
 * Core reports three causes, and this module decides who hears and in what
 * words:
 *
 *   - a message the host gave up delivering (registerDeliveryFailedHook):
 *     one a person would have read, or a browser's report to the agent that
 *     delegated its errand;
 *   - an inbound message the host gave up processing (registerInboundFailedHook);
 *   - a turn the agent runner reports as failed (the `turn_failed` delivery action).
 *
 * The runner names the messages a turn answered on its report and beside
 * every message the turn wrote to a person, so each failure comes with the
 * inbound messages it concerns. Who hears depends on whose conversation it
 * was (`conversationOf`), and in main's, on whose those messages were:
 *
 *   - one of main's own, where the principal sent one of them, a chat from a
 *     verified principal user or mail on their own email conversation: the
 *     principal, one plain sentence in their direct message, never in the
 *     conversation the failure came from. A failure in that direct message
 *     keeps its thread there; any other goes to the top of it. A failed turn
 *     whose provider recognized an outage only whoever runs the assistant can
 *     fix (a rejected credential, a spent balance) gets a sentence saying the
 *     fix is not theirs and to send it again later, since a resend now fails
 *     the same way. The notice is one direct send through the delivery
 *     adapter, so it passes the outbound guard; it is never queued or retried,
 *     so a failing channel cannot turn one notice into a stream of them. Why
 *     it failed goes to the host log only.
 *   - one of main's own, for everything else it concerned (a note from the
 *     host, a look, the daily sync, another agent's message): main, since the
 *     principal sent none of it and has nothing to send again. It gets one
 *     fact in its conversation, what failed and the pieces it concerned, with
 *     their matters; a reply that did not go out also brings the matter of
 *     the look it came from. The fact wakes nothing and rides on main's next
 *     turn, at the latest the daily sync: waking main to try again over a
 *     channel that just failed would only repeat the failure. A look lost
 *     with a failed turn comes back through the matters loop instead.
 *   - an outside email thread, a session of `external-email`: main, which
 *     knows why the thread exists and decides what the principal needs to
 *     hear. It gets one fact in its session, which wakes it: what failed, in
 *     the conversation with whom, then the thread's key, never what anyone
 *     wrote. The principal asked for nothing there. A turn that answered
 *     another agent rather than the thread is no one's to hear of, so a
 *     failure never answers a failure.
 *   - a browser errand: the agent that delegated it, woken by a fact naming
 *     the job (`tellDelegator`).
 *
 * Any other session, a task session included, serves no conversation: its
 * failures are no one's to hear of.
 *
 * Delivery reports a give-up before recording it, so a stop in between never
 * loses the report, and any report may come again: the principal's notices
 * record each of their messages they were told of, and every fact carries an
 * id derived from what failed, so each is heard once.
 *
 * A GWS-EA module with a sentence of its own for the principal sends it
 * through `sendPrincipalNotice`, to the same audience by the same path.
 */
import { createHash } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getDeliveryAdapter, registerDeliveryAction, registerDeliveryFailedHook } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import type { InboundOrigin, OutboundMessage } from '../../mailbox/index.js';
import { registerInboundFailedHook } from '../../reconcile-session.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { errandSource, hasBrowserAccess } from '../gws-ea-browser/access.js';
import { tellDelegator, type BrowserErrand } from '../gws-ea-browser/notices.js';
import { conversationPeople, EMAIL_CHANNEL_TYPE, PRINCIPAL_PLATFORM_ID } from '../gws-ea-inbox/runtime.js';
import { markLookFailed } from '../gws-ea-matters/db.js';
import { lookSeries } from '../gws-ea-matters/looks.js';
import {
  getExternalEmailAgentGroupId,
  getBrowserAgentGroupId,
  getMainAgentGroupId,
  isVerifiedPrincipalUser,
  principalContact,
} from '../gws-ea-profile/db.js';
import { noteNames, writeNoteForMain, type NoteNames, type NotePiece } from '../gws-ea-profile/main-note.js';
import { gwsEaNoticesMigration } from './migration.js';
import './whatsapp.js';

registerMigration(gwsEaNoticesMigration);

const FAILURE_NOTICE_TEXT = "Something went wrong on my side and I couldn't finish that. Please send it again.";

const OUTAGE_NOTICE_TEXT =
  "I can't do anything at the moment: something on my side needs fixing first, and it isn't anything you need to do. Please send this again later.";

/** Characters of a provider error the host log keeps; the container writes the report, so the host bounds it. */
const REPORTED_ERROR_LIMIT = 2000;

type Cause = 'delivery-failed' | 'inbound-failed' | 'turn-failed';

export interface Route {
  readonly channelType: string | null;
  readonly platformId: string | null;
  readonly threadId: string | null;
}

function isPersonRoute(route: Route): boolean {
  return route.channelType !== null && route.platformId !== null && route.channelType !== 'agent';
}

interface NoticeLog {
  readonly label: 'Failure notice' | 'Notice';
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * In `route`'s thread only when `route` is the principal's direct message
 * itself. Best effort: a failure is logged, never retried or thrown. Returns
 * whether it was delivered.
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
 * Whose conversation a session's is: one of `main`'s, an outside email thread
 * of `external-email`'s, a browser errand of an agent with browser access,
 * or no one's (any other session, a task session included).
 */
async function conversationOf(
  session: Session,
): Promise<'main' | { readonly thread: string } | BrowserErrand | undefined> {
  const source =
    session.messaging_group_id === null && session.agent_group_id === (await getBrowserAgentGroupId())
      ? errandSource(session.thread_id)
      : undefined;
  if (source !== undefined && session.thread_id !== null && (await hasBrowserAccess(source)))
    return { job: session.thread_id, session, source };
  if (session.messaging_group_id === null) return undefined;
  if (session.agent_group_id === (await getMainAgentGroupId())) return 'main';
  if (session.thread_id === null || session.agent_group_id !== (await getExternalEmailAgentGroupId())) return undefined;
  return { thread: session.thread_id };
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
    : [];
}

function contentOf(raw: string): Readonly<Record<string, unknown>> | undefined {
  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return isRecord(content) ? content : undefined;
}

/** None once the session is gone. */
async function messagesOf(session: Session, ids: readonly string[]): Promise<InboundOrigin[]> {
  if (ids.length === 0) return [];
  const messages = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getInboundMessages(ids),
  );
  return messages ?? [];
}

const CHAT_KINDS: ReadonlySet<string> = new Set(['chat', 'chat-sdk']);

/** The sender's user id, named as the router names users: a handle without a channel takes the message's own. */
function senderUserId(message: InboundOrigin): string | undefined {
  const sender = contentOf(message.content)?.authenticatedSender;
  if (!isRecord(sender) || sender.kind !== 'human') return undefined;
  const senderId = sender.userId;
  if (typeof senderId !== 'string' || senderId === '') return undefined;
  return senderId.includes(':') ? senderId : `${message.channelType ?? ''}:${senderId}`;
}

/**
 * Whether `message` is the principal's own: mail on their own email
 * conversation, which only Gmail-verified mail from them reaches, or a chat a
 * verified principal user sent. A note from the host is sent by `system`, and
 * another agent's message rides the `agent` channel, so neither is.
 */
async function isPrincipals(message: InboundOrigin): Promise<boolean> {
  if (message.channelType === EMAIL_CHANNEL_TYPE && message.platformId === PRINCIPAL_PLATFORM_ID) return true;
  if (!isPersonRoute(message) || !CHAT_KINDS.has(message.kind)) return false;
  const sender = senderUserId(message);
  return sender !== undefined && (await isVerifiedPrincipalUser(sender));
}

async function whose(
  messages: readonly InboundOrigin[],
): Promise<{ readonly principal: InboundOrigin[]; readonly rest: InboundOrigin[] }> {
  const principal: InboundOrigin[] = [];
  const rest: InboundOrigin[] = [];
  for (const message of messages) ((await isPrincipals(message)) ? principal : rest).push(message);
  return { principal, rest };
}

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

/**
 * Silent when every one of `own` was told of before. They are recorded as told
 * even when the send fails, since a notice is never retried.
 */
async function tellPrincipal(
  cause: Cause,
  session: Session,
  own: readonly InboundOrigin[],
  route: Route,
  text: string = FAILURE_NOTICE_TEXT,
): Promise<void> {
  const fresh = await unreported(own.map((message) => message.id));
  if (fresh.size === 0) return;
  await deliverToPrincipal(text, route, { label: 'Failure notice', fields: { cause, sessionId: session.id } });
  await recordReported([...fresh]);
}

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** A fact's id, derived from what failed, so the same failure told again writes nothing. */
function factId(prefix: string, parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`;
}

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

/** Wakes main, and the thread piece brings the thread's open matter with it. */
async function tellMain(cause: Cause, threadKey: string, failed: readonly string[]): Promise<void> {
  const result = await writeNoteForMain({
    id: factId(`external-email-${cause}`, [threadKey, ...[...failed].sort()]),
    timestamp: new Date().toISOString(),
    text: whatFailed(cause, threadKey, await conversationPeople(threadKey)),
    wake: true,
    pieces: [{ kind: 'thread', reference: threadKey }],
  });
  if (result === 'no-main' || result === 'no-principal') {
    log.warn('Nobody to tell of an external-email failure', { threadKey, cause, result });
  }
}

/** Whom it reaches, and where, is `tellDelegator`'s routing. */
async function tellOfBrowserJob(cause: Cause, errand: BrowserErrand, failed: readonly string[]): Promise<void> {
  const words: Record<Cause, string> = {
    'delivery-failed': 'its report could not be delivered, even after retrying.',
    'inbound-failed': 'a delegated message could not be processed, even after retrying.',
    'turn-failed': 'its turn failed before it finished, so the errand may be left undone.',
  };
  const thread = errand.job;
  const result = await tellDelegator(errand, {
    id: factId(`browser-${cause}`, [thread, ...[...failed].sort()]),
    timestamp: new Date().toISOString(),
    text: `Browser job ${thread}: ${words[cause]}`,
  });
  if (result === 'no-main' || result === 'no-principal' || result === 'no-delegating-session')
    log.warn('Nobody to tell of a browser job failure', { thread, cause, result });
}

/** What main reads of a failure in its own conversation that the principal has nothing to resend for. */
function whatYouLeft(cause: Cause): string {
  switch (cause) {
    case 'delivery-failed':
      return "A message you wrote didn't go out, even after retrying.";
    case 'inbound-failed':
      return "Something that came to you couldn't be processed, even after retrying.";
    case 'turn-failed':
      return 'Your turn failed before it finished, so what it was handling may be left undone.';
    default: {
      const unreachable: never = cause;
      throw new Error(`Unknown failure: ${String(unreachable)}`);
    }
  }
}

const PIECE_WORDS: Readonly<Record<NotePiece['kind'], string>> = {
  thread: 'thread',
  event: 'event',
  file: 'file',
  job: 'job',
};

/**
 * What `messages` carried for main: the pieces and matters each note named,
 * each once, and with `looks`, the matter each look was for.
 */
function carriedBy(messages: readonly InboundOrigin[], looks: boolean): NoteNames {
  const pieces = new Map<string, NotePiece>();
  const matters = new Set<string>();
  for (const message of messages) {
    if (message.kind === 'task') {
      const look = looks ? lookSeries(message.seriesId ?? message.id) : undefined;
      if (look !== undefined) matters.add(look.matterId);
      continue;
    }
    const named = noteNames(message.content);
    for (const piece of named.pieces) {
      const key = `${piece.kind}\u0000${piece.reference}`;
      if (!pieces.has(key)) pieces.set(key, piece);
    }
    for (const id of named.matters) matters.add(id);
  }
  return { pieces: [...pieces.values()], matters: [...matters] };
}

async function tellMainOfItsOwn(cause: Cause, failed: readonly string[], carried: NoteNames): Promise<void> {
  const pieces = carried.pieces.map((piece) => `${PIECE_WORDS[piece.kind]} ${piece.reference}`);
  const result = await writeNoteForMain({
    id: factId(`main-${cause}`, [...failed].sort()),
    timestamp: new Date().toISOString(),
    text: pieces.length === 0 ? whatYouLeft(cause) : `${whatYouLeft(cause)} It was about ${LIST.format(pieces)}.`,
    wake: false,
    pieces: carried.pieces,
    matters: carried.matters,
  });
  if (result === 'no-main' || result === 'no-principal') {
    log.warn("Nobody to tell of a failure in main's conversation", { cause, result });
  }
}

/**
 * For a module with wording of its own: at the top of the principal's direct
 * message, through the outbound guard, never queued or retried. Returns
 * whether it was delivered.
 */
export async function sendPrincipalNotice(text: string, cause: string): Promise<boolean> {
  return deliverToPrincipal(text, undefined, { label: 'Notice', fields: { cause } });
}

/** A row a person would have seen as a message; a reaction the agent placed is decoration, not a reply. */
function isPersonFacingPost(msg: OutboundMessage): boolean {
  if (msg.kind === 'system' || msg.kind === 'task_log' || !isPersonRoute(msg)) return false;
  // An unreadable row was still meant for the channel.
  return contentOf(msg.content)?.operation !== 'reaction';
}

/** The inbound messages a reply answered, as the runner named them beside its words. */
function answeredBy(post: OutboundMessage): string[] {
  return idsOf(contentOf(post.content)?.batch);
}

registerDeliveryFailedHook(async (failed, session) => {
  const route = await conversationOf(session);
  if (route !== undefined && route !== 'main' && 'job' in route) {
    const reports = failed.filter(
      (post) =>
        post.channelType === 'agent' &&
        post.kind !== 'system' &&
        post.kind !== 'task_log' &&
        contentOf(post.content)?.operation !== 'reaction',
    );
    if (reports.length > 0)
      await tellOfBrowserJob(
        'delivery-failed',
        route,
        reports.map((post) => post.id),
      );
    return;
  }
  const posts = failed.filter(isPersonFacingPost);
  const conversation = posts.length === 0 ? undefined : route;
  if (conversation === undefined) return;
  if (conversation !== 'main') {
    if ('job' in conversation) return;
    await tellMain(
      'delivery-failed',
      conversation.thread,
      posts.map((post) => post.id),
    );
    return;
  }
  const { principal, rest } = await whose(await messagesOf(session, [...new Set(posts.flatMap(answeredBy))]));
  const own = new Set(principal.map((message) => message.id));
  const toPrincipal = posts.find((post) => answeredBy(post).some((id) => own.has(id)));
  if (toPrincipal !== undefined) await tellPrincipal('delivery-failed', session, principal, toPrincipal);
  // What else the replies answered is main's to hear of, as is a reply answering nothing of the principal's.
  if (toPrincipal === undefined || rest.length > 0) {
    await tellMainOfItsOwn(
      'delivery-failed',
      posts.map((post) => post.id),
      carriedBy(rest, true),
    );
  }
});

registerInboundFailedHook(async (failed, session) => {
  const conversation = await conversationOf(session);
  if (conversation === undefined) return;
  const ids = failed.map((message) => message.id);
  if (conversation !== 'main') {
    if ('job' in conversation) {
      await tellOfBrowserJob('inbound-failed', conversation, ids);
      return;
    }
    await tellMain('inbound-failed', conversation.thread, ids);
    return;
  }
  const { principal, rest } = await whose(await messagesOf(session, ids));
  const [first] = principal;
  if (first !== undefined) await tellPrincipal('inbound-failed', session, principal, first);
  // No look mark here: a look given up shows as a failed run, which the matters loop reads.
  if (rest.length > 0) {
    await tellMainOfItsOwn(
      'inbound-failed',
      rest.map((message) => message.id),
      carriedBy(rest, false),
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
    const conversation = await conversationOf(session);
    if (conversation === undefined) return;
    const batch = idsOf(content.batch);
    if (conversation !== 'main') {
      if ('job' in conversation) {
        await tellOfBrowserJob('turn-failed', conversation, batch);
        return;
      }
      // A turn answering another agent is no one's to hear of: a failure never answers a failure.
      if (isPersonRoute(route)) await tellMain('turn-failed', conversation.thread, batch);
      return;
    }
    const { principal, rest } = await whose(await messagesOf(session, batch));
    // A look the turn lost comes back through the matters loop, which hears of it here because the runner
    // settles a failed turn's rows as done. The mark comes first, so it never waits on anyone being told.
    for (const message of rest) {
      const look = message.kind === 'task' ? lookSeries(message.seriesId ?? message.id) : undefined;
      if (look !== undefined) await markLookFailed(look.matterId, new Date().toISOString());
    }
    const [first] = principal;
    if (first !== undefined) {
      await tellPrincipal('turn-failed', session, principal, first, outage ? OUTAGE_NOTICE_TEXT : FAILURE_NOTICE_TEXT);
    }
    // A turn the principal started only partly, or not at all.
    if (first === undefined || rest.length > 0) await tellMainOfItsOwn('turn-failed', batch, carriedBy(rest, false));
  },
  unguarded(
    "reports a failure to the principal, main, or a browser errand's delegating group only; the principal's notice passes the outbound guard",
  ),
);
