/**
 * The exactly-once send every email from the assistant shares (KTD5).
 *
 * `sendExactlyOnce` stores a pending send with a Message-ID allocated for it
 * (`newMessageId`) before Gmail is called, on the thread's side of the send
 * ledger (thread-map.ts). A retry of the same send finds that record, and
 * asks Gmail whether it already holds the message (`findSent`): under that
 * Message-ID, or under X-Google-Original-Message-ID when Gmail replaced it.
 * It asks before the send is checked and built again, so a check that would
 * refuse it now never reports an email Gmail took as unsent.
 * Gmail errors back off a few seconds within one attempt, checking Gmail for
 * the message before each retry (`sendWithBackoff`); anything longer goes
 * back to the caller's own retries. Once Gmail holds it, the Message-ID
 * replies will answer is read back from Gmail and the send becomes the
 * thread's message (`completeSend`).
 *
 * Two sends are the same send when they are the same words on the same side
 * of a thread, or the same `email_send` request (`sendKey`).
 */
import { createHash, randomUUID } from 'node:crypto';

import { log } from '../../log.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import { GoogleApiError, RECONCILIATION_HEADERS, type GmailApi } from './gmail-api.js';
import { domainOf, headerValues, messageIdsOf, newMessageId, type Mailbox } from './mime.js';
import type { InboxRuntime } from './runtime.js';
import { findSend, getThread, insertPendingSend, recordSent, type NewSend, type SendScope } from './thread-map.js';

/** How long to wait before each retry of a Gmail send that failed on Gmail's side. */
const SEND_BACKOFF_MS: readonly number[] = [1_000, 3_000];
/** The most Message-IDs an email's References names. */
export const MAX_REFERENCES = 20;
/** Recently sent messages checked when Gmail search cannot find a pre-allocated ID. */
const RECENT_SENT_CHECKED = 10;

/** What an email says: an agent's words, and the `email_send` request that asked for it, if one did. */
export interface EmailWords {
  readonly text: string;
  /** The request's id: each request is its own send, whatever its words. */
  readonly request?: string;
}

/** The words of an email as a row carries them; undefined for anything email cannot carry. */
export function emailWords(content: unknown): EmailWords | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const { text, request } = content as { text?: unknown; request?: unknown };
  if (typeof text !== 'string' || (request !== undefined && typeof request !== 'string')) return undefined;
  return request === undefined ? { text } : { text, request };
}

/** What makes two sends on one side of a thread the same send: their words, or the request that asked for them. */
export function sendKey(threadKey: string, words: EmailWords): string {
  const hash = createHash('sha256').update(threadKey).update('\u0000').update(words.text);
  if (words.request !== undefined) hash.update('\u0000').update(words.request);
  return hash.digest('hex');
}

/** The assistant as every email it sends names it. */
export async function assistantMailbox(runtime: InboxRuntime): Promise<Mailbox> {
  const profile = await getGwsEaProfile();
  return {
    address: await runtime.gmailAddress(),
    ...(profile.assistant_display_name ? { displayName: profile.assistant_display_name } : {}),
  };
}

/** Whether a message's headers carry `rfcMessageId`, as its Message-ID or the one Gmail replaced. */
export function carriesMessageId(headers: readonly { name: string; value: string }[], rfcMessageId: string): boolean {
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
    const found = inThread.find((message) => carriesMessageId(message.payload?.headers ?? [], rfcMessageId));
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
    if (message && carriesMessageId(message.payload?.headers ?? [], rfcMessageId)) {
      return { id: message.id, threadId: message.threadId };
    }
  }
  return undefined;
}

/**
 * Send `raw`, retrying Gmail's own failures briefly, and never twice once
 * Gmail holds it. Only Gmail refusing the email says it was not sent; after
 * any other failure, the last included, Gmail is checked for it before the
 * send counts as failed.
 */
async function sendWithBackoff(
  runtime: InboxRuntime,
  raw: string,
  rfcMessageId: string,
  gmailThreadId: string | null,
): Promise<{ readonly id: string; readonly threadId: string }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runtime.gmail.send({ raw, ...(gmailThreadId === null ? {} : { threadId: gmailThreadId }) });
    } catch (error) {
      if (error instanceof GoogleApiError && !error.retryable) throw error;
      const delay = SEND_BACKOFF_MS[attempt];
      log.warn('Gmail may not have taken an email; checking for it', {
        ...(error instanceof GoogleApiError ? { status: error.status } : {}),
        attempt,
      });
      if (delay !== undefined) await runtime.sleep(delay);
      const found = await findSent(runtime.gmail, rfcMessageId, gmailThreadId);
      if (found) return found;
      if (!(error instanceof GoogleApiError) || delay === undefined) throw error;
    }
  }
}

/**
 * The Message-IDs Gmail holds for a sent message, its Message-ID first: the
 * ones replies will answer. Empty when Gmail cannot be read back now.
 */
async function readBackMessageIds(gmail: GmailApi, gmailMessageId: string): Promise<string[]> {
  const copy = await gmail.getMessage(gmailMessageId, 'metadata').catch((error: unknown) => {
    log.warn('Could not read back a sent email to learn its Message-ID', { error });
    return undefined;
  });
  return RECONCILIATION_HEADERS.flatMap((name) =>
    headerValues(copy?.payload?.headers ?? [], name).flatMap((value) => messageIdsOf(value)),
  );
}

/** Gmail holds the send: record it as the thread's on its side, by the Message-ID replies will answer. */
async function completeSend(
  runtime: InboxRuntime,
  send: NewSend,
  sent: { readonly id: string; readonly threadId: string },
  at: string,
): Promise<string> {
  const [held] = await readBackMessageIds(runtime.gmail, sent.id);
  await recordSent(
    send,
    { gmailMessageId: sent.id, gmailThreadId: sent.threadId, rfcMessageId: held ?? send.rfcMessageId },
    at,
  );
  log.info('Email sent', { threadKey: send.scope.threadKey, side: send.scope.side, gmailMessageId: sent.id });
  return sent.id;
}

/** An email ready to go: the Gmail thread it joins, and its raw form under the Message-ID it is sent with. */
export interface PreparedSend {
  readonly gmailThreadId: string | null;
  raw(rfcMessageId: string): Promise<string>;
}

/**
 * Send one email on one side of a thread, exactly once; returns Gmail's id
 * for it. `prepare` checks and builds it, and runs only when Gmail does not
 * already hold it as this send; whatever it throws, nothing is sent.
 */
export async function sendExactlyOnce(
  runtime: InboxRuntime,
  scope: SendScope,
  key: string,
  prepare: () => Promise<PreparedSend>,
): Promise<string> {
  const existing = await findSend(scope, key);
  // Gmail took this send, but its delivery was never recorded: answer from the record.
  if (existing?.state === 'sent') return existing.gmailMessageId;
  // A pending send Gmail may hold already, if a stop came between Gmail taking it and its record.
  if (existing !== undefined) {
    const gmailThreadId = (await getThread(scope.threadKey))?.gmailThreadId ?? null;
    const found = await findSent(runtime.gmail, existing.rfcMessageId, gmailThreadId);
    if (found) return completeSend(runtime, existing, found, runtime.now().toISOString());
  }
  const prepared = await prepare();
  const at = runtime.now().toISOString();
  let send: NewSend;
  if (existing === undefined) {
    send = {
      id: randomUUID(),
      scope,
      contentHash: key,
      rfcMessageId: newMessageId(domainOf(await runtime.gmailAddress())),
    };
    await insertPendingSend(send, at);
  } else send = existing;
  const raw = await prepared.raw(send.rfcMessageId);
  return completeSend(
    runtime,
    send,
    await sendWithBackoff(runtime, raw, send.rfcMessageId, prepared.gmailThreadId),
    at,
  );
}
