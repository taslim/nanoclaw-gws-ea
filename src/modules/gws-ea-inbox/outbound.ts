/**
 * Replies leave through ordinary delivery (KTD4). The channel adapter's
 * `deliver` sends one plain-text message in the thread's Gmail thread to the
 * thread's people, in To, Cc, and Bcc as placed: every one of them is an
 * address the audience check resolved (KTD7, KTD16).
 *
 * The principal's own email is answered apart from any thread
 * (`sendPrincipalReply`, R41): to the principal's verified address that
 * wrote it, alone, in its Gmail thread.
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
import { getGwsEaProfile, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import {
  addThreadMessageIds,
  findSend,
  findThreadByGmailId,
  getPrincipalMessage,
  getThread,
  insertPendingSend,
  markSendSent,
  threadMessageIds,
  updateThread,
  type InboxThread,
  type SendRecord,
} from './db.js';
import { GoogleApiError, RECONCILIATION_HEADERS, type GmailApi } from './gmail-api.js';
import {
  buildOutboundMime,
  domainOf,
  encodeRaw,
  headerValues,
  messageIdsOf,
  newMessageId,
  type Mailbox,
} from './mime.js';
import { everyone, recipientsForThread, sendPeople } from './recipients.js';
import { activeInbox, assistantAddresses, INBOX_PLATFORM_ID, type InboxRuntime } from './runtime.js';

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
 * The recipient resolver the audience check uses for every email send: every
 * address the send reaches, Bcc included. The list is kept for the send that
 * follows, which refuses to go out if the thread's recipients changed in
 * between.
 */
export async function resolveRecipients(send: OutboundSend): Promise<readonly string[]> {
  if (send.platformId !== INBOX_PLATFORM_ID || send.threadId === null) return [];
  const people = await recipientsForThread(send.threadId, await assistantAddresses());
  const list = people === undefined ? [] : everyone(people);
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
  runtime: InboxRuntime,
  raw: string,
  record: SendRecord,
  gmailThreadId: string | null,
): Promise<{ readonly id: string; readonly threadId: string }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runtime.gmail.send({ raw, ...(gmailThreadId === null ? {} : { threadId: gmailThreadId }) });
    } catch (error) {
      const delay = SEND_BACKOFF_MS[attempt];
      if (!(error instanceof GoogleApiError) || !error.retryable || delay === undefined) throw error;
      log.warn('Gmail did not take a reply; checking for it, then retrying', { status: error.status, attempt });
      await runtime.sleep(delay);
      const found = await findSent(runtime.gmail, record.rfcMessageId, gmailThreadId);
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
  if (thread.gmailThreadId === null && (await findThreadByGmailId(sent.threadId)) === undefined) {
    await updateThread(thread.threadKey, { gmailThreadId: sent.threadId }, at);
  }
  log.info('Reply sent from the inbox', { threadKey: thread.threadKey, gmailMessageId: sent.id });
  return sent.id;
}

function replySubject(subject: string): string {
  return subject === '' || /^re:/iu.test(subject) ? subject : `Re: ${subject}`;
}

/** The assistant as every email it sends names it. */
async function assistantMailbox(runtime: InboxRuntime): Promise<Mailbox> {
  const profile = await getGwsEaProfile();
  return {
    address: await runtime.gmailAddress(),
    ...(profile.assistant_display_name ? { displayName: profile.assistant_display_name } : {}),
  };
}

/** The channel adapter's `deliver`: send one reply in its thread, exactly once. */
export async function sendReply(
  runtime: InboxRuntime,
  platformId: string,
  threadKey: string | null,
  message: OutboundMessage,
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
  let record = await findSend({ threadKey }, hash);
  // Gmail took this reply, but its delivery was never recorded: answer from the record.
  if (record?.state === 'sent') return record.gmailMessageId ?? undefined;

  const people = sendPeople(thread.people, await assistantAddresses());
  const recipients = everyone(people);
  if (checked !== undefined && !sameList(checked, recipients)) {
    throw new Error("The thread's recipients changed after the reply was checked; it is checked and sent again");
  }
  if (recipients.length === 0) throw new Error(`Thread ${threadKey} has no one its reply may go to`);
  const subjectCheck = await checkOutbound(thread.subject, await audienceForAddresses(recipients));
  if (!subjectCheck.allowed) throw new OutboundRefusedError('gws-ea-inbox:subject', subjectCheck.reason);

  const at = runtime.now().toISOString();
  if (record?.state === 'pending') {
    const found = await findSent(runtime.gmail, record.rfcMessageId, thread.gmailThreadId);
    if (found) return completeSend(runtime.gmail, record, found, thread, at);
  } else {
    record = {
      id: randomUUID(),
      scope: { threadKey },
      contentHash: hash,
      rfcMessageId: newMessageId(domainOf(await runtime.gmailAddress())),
      state: 'pending',
      gmailMessageId: null,
    };
    await insertPendingSend(record, at);
  }

  const prior = (await threadMessageIds(threadKey)).filter((id) => id !== record.rfcMessageId);
  const raw = encodeRaw(
    buildOutboundMime({
      from: await assistantMailbox(runtime),
      ...people,
      subject: prior.length === 0 ? thread.subject : replySubject(thread.subject),
      messageId: record.rfcMessageId,
      ...(prior.length === 0 ? {} : { inReplyTo: prior[prior.length - 1] }),
      references: prior.slice(-MAX_REFERENCES),
      text,
      date: runtime.now(),
    }),
  );
  const sent = await sendWithBackoff(runtime, raw, record, thread.gmailThreadId);
  return completeSend(runtime.gmail, record, sent, thread, at);
}

// ---------------------------------------------------------------------------
// The principal's email, answered by email (R41)
// ---------------------------------------------------------------------------

export interface PrincipalReply {
  /** The principal's message being answered, by its Gmail message id, as their note gave it. */
  readonly gmailMessageId: string;
  /** Plain text, sent as written. */
  readonly text: string;
  /** The request this answers: a replay of it sends nothing again. */
  readonly requestId: string;
}

/**
 * Answer one of the principal's messages by email: only to the principal's
 * address that wrote it, as Gmail verified it, in its Gmail thread, from the
 * assistant, in plain text. A replay of the same request returns the message
 * Gmail already holds. Throws for a message the inbox did not record as the
 * principal's, or whose address is no longer theirs. Returns Gmail's id for
 * the reply.
 */
export async function sendPrincipalReply(input: PrincipalReply): Promise<string> {
  const runtime = activeInbox();
  if (!runtime) throw new Error('The inbox is not running, so no email can be sent');
  const message = await getPrincipalMessage(input.gmailMessageId);
  if (!message) throw new Error(`Gmail message ${input.gmailMessageId} is not an email from the principal`);
  const principal = new Set((await listPrincipalAddresses()).map((address) => address.email));
  if (!principal.has(message.address)) {
    throw new Error(`${message.address} is no longer one of the principal's addresses`);
  }
  if (input.text.trim() === '') throw new Error('A reply needs text');

  const scope = { principalMessageId: message.gmailMessageId };
  const hash = createHash('sha256').update('principal-reply').update('\u0000').update(input.requestId).digest('hex');
  let record = await findSend(scope, hash);
  if (record?.state === 'sent' && record.gmailMessageId !== null) return record.gmailMessageId;
  const at = runtime.now().toISOString();
  if (record?.state === 'pending') {
    const found = await findSent(runtime.gmail, record.rfcMessageId, message.gmailThreadId);
    if (found) {
      await markSendSent(record.id, found.id, at);
      return found.id;
    }
  } else {
    record = {
      id: randomUUID(),
      scope,
      contentHash: hash,
      rfcMessageId: newMessageId(domainOf(await runtime.gmailAddress())),
      state: 'pending',
      gmailMessageId: null,
    };
    await insertPendingSend(record, at);
  }

  const answered = message.rfcMessageId === null ? [] : [message.rfcMessageId];
  const raw = encodeRaw(
    buildOutboundMime({
      from: await assistantMailbox(runtime),
      to: [message.address],
      cc: [],
      bcc: [],
      subject: replySubject(message.subject),
      messageId: record.rfcMessageId,
      ...(message.rfcMessageId === null ? {} : { inReplyTo: message.rfcMessageId }),
      references: [...message.referenceIds, ...answered].slice(-MAX_REFERENCES),
      text: input.text,
      date: runtime.now(),
    }),
  );
  const sent = await sendWithBackoff(runtime, raw, record, message.gmailThreadId);
  await markSendSent(record.id, sent.id, at);
  log.info("Replied to the principal's email", { gmailMessageId: message.gmailMessageId, replyId: sent.id });
  return sent.id;
}
