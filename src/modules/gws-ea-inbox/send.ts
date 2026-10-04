/**
 * The exactly-once send every email from the assistant shares (KTD5).
 *
 * Before Gmail is called, the caller stores a pending send with a
 * Message-ID allocated for it (`newMessageId`). A retry of the same send
 * finds that record, and asks Gmail whether it already holds the message
 * (`findSent`): under that Message-ID, or under X-Google-Original-Message-ID
 * when Gmail replaced it. Gmail errors back off a few seconds within one
 * attempt, checking Gmail for the message before each retry
 * (`sendWithBackoff`); anything longer goes back to delivery's own retries.
 * Once Gmail holds it, the IDs replies will answer are read back from Gmail
 * (`readBackMessageIds`).
 */
import { createHash } from 'node:crypto';

import { log } from '../../log.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import { GoogleApiError, RECONCILIATION_HEADERS, type GmailApi } from './gmail-api.js';
import { headerValues, messageIdsOf, type Mailbox } from './mime.js';
import type { InboxRuntime } from './runtime.js';

/** How long to wait before each retry of a Gmail send that failed on Gmail's side. */
export const SEND_BACKOFF_MS: readonly number[] = [1_000, 3_000];
/** The most Message-IDs an email's References names. */
export const MAX_REFERENCES = 20;
/** Recently sent messages checked when Gmail search cannot find a pre-allocated ID. */
const RECENT_SENT_CHECKED = 10;

/** The text of an email as the agent wrote it; anything else is not something email can carry. */
export function replyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (typeof content === 'object' && content !== null && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text;
  }
  throw new Error('The email channel sends text replies only');
}

/** What makes two sends in one thread the same send: their words. */
export function contentHash(threadKey: string, text: string): string {
  return createHash('sha256').update(threadKey).update('\u0000').update(text).digest('hex');
}

/** The assistant as every email it sends names it. */
export async function assistantMailbox(runtime: InboxRuntime): Promise<Mailbox> {
  const profile = await getGwsEaProfile();
  return {
    address: await runtime.gmailAddress(),
    ...(profile.assistant_display_name ? { displayName: profile.assistant_display_name } : {}),
  };
}

function holdsId(headers: readonly { name: string; value: string }[], rfcMessageId: string): boolean {
  return RECONCILIATION_HEADERS.some((name) =>
    headerValues(headers, name).some((value) => messageIdsOf(value).includes(rfcMessageId)),
  );
}

/** The sent message carrying `rfcMessageId`, under either header, or undefined. */
export async function findSent(
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

/** Send `raw`, retrying Gmail's own failures briefly, and never twice once Gmail holds it. */
export async function sendWithBackoff(
  runtime: InboxRuntime,
  raw: string,
  rfcMessageId: string,
  gmailThreadId: string | null,
): Promise<{ readonly id: string; readonly threadId: string }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runtime.gmail.send({ raw, ...(gmailThreadId === null ? {} : { threadId: gmailThreadId }) });
    } catch (error) {
      const delay = SEND_BACKOFF_MS[attempt];
      if (!(error instanceof GoogleApiError) || !error.retryable || delay === undefined) throw error;
      log.warn('Gmail did not take an email; checking for it, then retrying', { status: error.status, attempt });
      await runtime.sleep(delay);
      const found = await findSent(runtime.gmail, rfcMessageId, gmailThreadId);
      if (found) return found;
    }
  }
}

/**
 * The Message-IDs Gmail holds for a sent message, its Message-ID first: the
 * ones replies will answer. Empty when Gmail cannot be read back now.
 */
export async function readBackMessageIds(gmail: GmailApi, gmailMessageId: string): Promise<string[]> {
  const copy = await gmail.getMessage(gmailMessageId, 'metadata').catch((error: unknown) => {
    log.warn('Could not read back a sent email to learn its Message-ID', { error });
    return undefined;
  });
  return RECONCILIATION_HEADERS.flatMap((name) =>
    headerValues(copy?.payload?.headers ?? [], name).flatMap((value) => messageIdsOf(value)),
  );
}
