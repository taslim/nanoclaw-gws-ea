/**
 * Replies leave through ordinary delivery (KTD4). The channel adapter's
 * `deliver` sends one plain-text message in the thread's Gmail thread to the
 * thread's send list, the same list the audience check resolved (KTD7).
 *
 * A send never happens twice. Before Gmail is called, the host stores a
 * pending send with a pre-allocated Message-ID. A retry of the same reply
 * (same thread, same text) finds that record: if Gmail already holds a
 * message with that Message-ID, or holds it under X-Google-Original-Message-ID
 * because it replaced the ID, the send is recorded and not repeated. A reply
 * Gmail accepted whose delivery was not yet recorded is answered from the
 * record. The record is deleted once delivery records the reply, so the same
 * words sent again later are a new send.
 *
 * Gmail errors back off a few seconds within one attempt, checking Gmail for
 * the message before each retry; anything longer goes back to delivery's own
 * retries.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { OutboundMessage } from '../../channels/adapter.js';
import { OutboundRefusedError, type OutboundSend } from '../../delivery.js';
import { log } from '../../log.js';
import { audienceForAddresses, checkOutbound } from '../gws-ea-privacy/index.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import {
  addThreadMessageIds,
  findSend,
  findThreadByGmailId,
  getThread,
  insertPendingSend,
  markSendSent,
  threadMessageIds,
  updateThread,
  type InboxThread,
  type SendRecord,
} from './db.js';
import { GoogleApiError, RECONCILIATION_HEADERS, type GmailApi } from './gmail-api.js';
import { buildOutboundMime, domainOf, encodeRaw, headerValues, messageIdsOf, newMessageId } from './mime.js';
import { recipientsForThread, sendListOf } from './recipients.js';
import { assistantAddresses, INBOX_PLATFORM_ID, type InboxRuntime } from './runtime.js';

/** How long to wait before each retry of a Gmail send that failed on Gmail's side. */
export const SEND_BACKOFF_MS: readonly number[] = [1_000, 3_000];
/** The most Message-IDs a reply's References names. */
const MAX_REFERENCES = 20;
/** Recently sent messages checked when Gmail search cannot find a pre-allocated ID. */
const RECENT_SENT_CHECKED = 10;

/** The text of a reply as the agent wrote it; anything else is not something email can carry. */
export function replyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (typeof content === 'object' && content !== null && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  throw new Error('The email channel sends text replies only');
}

export function contentHash(threadKey: string, text: string): string {
  return createHash('sha256').update(threadKey).update('\u0000').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// The audience check and the send read one list
// ---------------------------------------------------------------------------

const resolvedLists = new Map<string, readonly string[]>();
const MAX_RESOLVED = 200;

function listKey(threadKey: string, hash: string): string {
  return `${threadKey}\u0000${hash}`;
}

/**
 * The recipient resolver the audience check uses for every email send: the
 * exact addresses the send goes to. The list is kept for the send that
 * follows, which refuses to go out if the thread's recipients changed in
 * between.
 */
export async function resolveRecipients(send: OutboundSend): Promise<readonly string[]> {
  if (send.platformId !== INBOX_PLATFORM_ID || send.threadId === null) return [];
  const list = await recipientsForThread(send.threadId, await assistantAddresses());
  let text: string;
  /* eslint-disable no-catch-all/no-catch-all -- content the send cannot carry still resolves; the send itself refuses it */
  try {
    text = replyText(JSON.parse(send.content));
  } catch {
    return list;
  }
  /* eslint-enable no-catch-all/no-catch-all */
  if (resolvedLists.size >= MAX_RESOLVED) resolvedLists.delete(resolvedLists.keys().next().value ?? '');
  resolvedLists.set(listKey(send.threadId, contentHash(send.threadId, text)), list);
  return list;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((address, index) => address === [...b].sort()[index]);
}

// ---------------------------------------------------------------------------
// Finding a send Gmail may already hold
// ---------------------------------------------------------------------------

function holdsId(headers: readonly { name: string; value: string }[], rfcMessageId: string): boolean {
  return RECONCILIATION_HEADERS.some((name) =>
    headerValues(headers, name).some((value) => messageIdsOf(value).includes(rfcMessageId)),
  );
}

/** The sent message carrying `rfcMessageId`, under either header, or undefined. */
async function findSent(
  gmail: GmailApi,
  rfcMessageId: string,
  gmailThreadId: string | null,
): Promise<{ readonly id: string; readonly threadId: string } | undefined> {
  if (gmailThreadId !== null) {
    const inThread = (await gmail.getThread(gmailThreadId)) ?? [];
    const found = inThread.find((message) => holdsId(message.payload?.headers ?? [], rfcMessageId));
    if (found) return { id: found.id, threadId: found.threadId };
  }
  const bare = rfcMessageId.slice(1, -1);
  const candidates = [
    ...(await gmail.listMessages({ q: `rfc822msgid:${bare}`, maxResults: 5 })),
    ...(await gmail.listMessages({ labelIds: ['SENT'], maxResults: RECENT_SENT_CHECKED })),
  ];
  const checked = new Set<string>();
  for (const candidate of candidates) {
    if (checked.has(candidate.id)) continue;
    checked.add(candidate.id);
    const message = await gmail.getMessage(candidate.id, 'metadata');
    if (message && holdsId(message.payload?.headers ?? [], rfcMessageId)) {
      return { id: message.id, threadId: message.threadId };
    }
  }
  return undefined;
}

async function sendWithBackoff(
  gmail: GmailApi,
  raw: string,
  record: SendRecord,
  gmailThreadId: string | null,
  sleep: (ms: number) => Promise<void>,
): Promise<{ readonly id: string; readonly threadId: string }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await gmail.send({ raw, ...(gmailThreadId === null ? {} : { threadId: gmailThreadId }) });
    } catch (error) {
      const delay = SEND_BACKOFF_MS[attempt];
      if (!(error instanceof GoogleApiError) || !error.retryable || delay === undefined) throw error;
      log.warn('Gmail did not take a reply; checking for it, then retrying', { status: error.status, attempt });
      await sleep(delay);
      const found = await findSent(gmail, record.rfcMessageId, gmailThreadId);
      if (found) return found;
    }
  }
}

/** Record what Gmail holds for a send: the IDs replies will answer, and the thread it joined. */
async function completeSend(
  gmail: GmailApi,
  record: SendRecord,
  sent: { readonly id: string; readonly threadId: string },
  thread: InboxThread,
  recipients: readonly string[],
  at: string,
): Promise<string> {
  await markSendSent(record.id, sent.id, at);
  const copy = await gmail.getMessage(sent.id, 'metadata').catch((error: unknown) => {
    log.warn('Could not read back a sent reply to learn its Message-ID', { error });
    return undefined;
  });
  const ids = RECONCILIATION_HEADERS.flatMap((name) =>
    headerValues(copy?.payload?.headers ?? [], name).flatMap((value) => messageIdsOf(value)),
  );
  await addThreadMessageIds(thread.threadKey, ids, at);
  const claim = thread.gmailThreadId === null && (await findThreadByGmailId(sent.threadId)) === undefined;
  await updateThread(
    thread.threadKey,
    { participants: recipients, ...(claim ? { gmailThreadId: sent.threadId } : {}) },
    at,
  );
  log.info('Reply sent from the inbox', { threadKey: thread.threadKey, gmailMessageId: sent.id });
  return sent.id;
}

function replySubject(subject: string): string {
  return subject === '' || /^re:/iu.test(subject) ? subject : `Re: ${subject}`;
}

/** The channel adapter's `deliver`: send one reply in its thread, exactly once. */
export async function sendReply(
  runtime: InboxRuntime,
  platformId: string,
  threadKey: string | null,
  message: OutboundMessage,
  sleep: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  if (platformId !== INBOX_PLATFORM_ID || threadKey === null) {
    throw new Error('The email channel sends only within an inbox thread');
  }
  if ((message.files?.length ?? 0) > 0) throw new Error('The email channel sends no files');
  const text = replyText(message.content);
  const thread = await getThread(threadKey);
  if (!thread || (thread.state !== 'authorized' && thread.state !== 'open')) {
    throw new Error(`Thread ${threadKey} is not open for replies`);
  }
  const hash = contentHash(threadKey, text);
  const checked = resolvedLists.get(listKey(threadKey, hash));
  resolvedLists.delete(listKey(threadKey, hash));
  let record = await findSend(threadKey, hash);
  // Gmail took this reply, but its delivery was never recorded: answer from the record.
  if (record?.state === 'sent') return record.gmailMessageId ?? undefined;

  const recipients = sendListOf(thread, await assistantAddresses());
  if (checked !== undefined && !sameList(checked, recipients)) {
    throw new Error("The thread's recipients changed after the reply was checked; it is checked and sent again");
  }
  if (recipients.length === 0) throw new Error(`Thread ${threadKey} has no one its reply may go to`);
  const subjectCheck = await checkOutbound(thread.subject, await audienceForAddresses(recipients));
  if (!subjectCheck.allowed) throw new OutboundRefusedError('gws-ea-inbox:subject', subjectCheck.reason);

  const at = runtime.now().toISOString();
  if (record?.state === 'pending') {
    const found = await findSent(runtime.gmail, record.rfcMessageId, thread.gmailThreadId);
    if (found) return completeSend(runtime.gmail, record, found, thread, recipients, at);
  } else {
    const from = await runtime.gmailAddress();
    record = {
      id: randomUUID(),
      threadKey,
      contentHash: hash,
      rfcMessageId: newMessageId(domainOf(from)),
      state: 'pending',
      gmailMessageId: null,
    };
    await insertPendingSend(record, at);
  }

  const prior = (await threadMessageIds(threadKey)).filter((id) => id !== record.rfcMessageId);
  const profile = await getGwsEaProfile();
  const raw = encodeRaw(
    buildOutboundMime({
      from: {
        address: await runtime.gmailAddress(),
        ...(profile.assistant_display_name ? { displayName: profile.assistant_display_name } : {}),
      },
      to: recipients,
      subject: prior.length === 0 ? thread.subject : replySubject(thread.subject),
      messageId: record.rfcMessageId,
      ...(prior.length === 0 ? {} : { inReplyTo: prior[prior.length - 1] }),
      references: prior.slice(-MAX_REFERENCES),
      text,
      date: runtime.now(),
    }),
  );
  const sent = await sendWithBackoff(runtime.gmail, raw, record, thread.gmailThreadId, sleep);
  return completeSend(runtime.gmail, record, sent, thread, recipients, at);
}
