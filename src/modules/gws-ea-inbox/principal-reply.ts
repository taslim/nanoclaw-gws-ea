/**
 * `main`'s email to the principal (KTD1, R64): its reply in a thread only the
 * principal and the assistant can read, which ordinary delivery hands the
 * adapter for `email:principal`.
 *
 * It answers the thread's anchor: the latest message on the principal's side
 * that the principal wrote, which Gmail must still verify as theirs now. It
 * goes to that message's From address alone, never to its Reply-To, To, or
 * Cc, nor to the principal's other addresses, in that message's Gmail
 * thread, quoting it, and signed by the host (render.ts). A thread with no
 * such message refuses it.
 *
 * The audience check resolves the same address (`principalRecipients`), so a
 * send clears the private-values check only because every recipient is one
 * of the principal's addresses. It is sent exactly once (send.ts), on the
 * thread's principal side of the send ledger.
 */
import { randomUUID } from 'node:crypto';

import type { OutboundMessage } from '../../channels/adapter.js';
import { OutboundRefusedError, type OutboundSend } from '../../delivery.js';
import { log } from '../../log.js';
import { getGwsEaProfile, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { authenticateSender } from './authentication.js';
import {
  buildMime,
  domainOf,
  encodeRaw,
  newMessageId,
  parseGmailMessage,
  type Mailbox,
  type ParsedMail,
} from './mime.js';
import { emailSignature, renderEmail } from './render.js';
import { activeInbox, assistantAddresses, type InboxRuntime } from './runtime.js';
import {
  assistantMailbox,
  contentHash,
  findSent,
  MAX_REFERENCES,
  readBackMessageIds,
  replyText,
  sendWithBackoff,
} from './send.js';
import {
  findSend,
  insertPendingSend,
  recordSent,
  threadMessages,
  visibleMessageIds,
  type NewSend,
  type SendScope,
} from './thread-map.js';

const REFUSED_BY = 'gws-ea-inbox:principal-thread';

/** The message a reply to the principal answers, and the address Gmail verified wrote it. */
interface Anchor {
  readonly mail: ParsedMail;
  readonly from: Mailbox;
}

/**
 * The latest message on the thread's principal side that the principal
 * wrote, skipping the assistant's own replies; undefined when there is none,
 * or when Gmail no longer verifies it as the principal's.
 */
async function principalAnchor(runtime: InboxRuntime, threadKey: string): Promise<Anchor | undefined> {
  await runtime.gmailAddress();
  const assistant = await assistantAddresses();
  const auth = { principalAddresses: new Set((await listPrincipalAddresses()).map((address) => address.email)) };
  for (const message of (await threadMessages(threadKey, 'principal')).reverse()) {
    if (message.gmailMessageId === null) continue;
    const found = await runtime.gmail.getMessage(message.gmailMessageId, 'full');
    if (!found) continue;
    const mail = parseGmailMessage(found);
    if (mail.from !== undefined && assistant.has(mail.from.address)) continue;
    const verdict = authenticateSender(mail.headers, auth);
    return verdict.kind === 'principal' ? { mail, from: mail.from ?? { address: verdict.address } } : undefined;
  }
  return undefined;
}

/** The audience check's recipients for a send on `email:principal`: the anchor's From address, or no one. */
export async function principalRecipients(send: OutboundSend): Promise<readonly string[]> {
  const runtime = activeInbox();
  if (!runtime || send.threadId === null) return [];
  const anchor = await principalAnchor(runtime, send.threadId);
  return anchor === undefined ? [] : [anchor.from.address];
}

/** Gmail holds the send: record it as the thread's, by the Message-ID replies will answer. */
async function recordDelivered(
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
  log.info('Emailed the principal in their thread', { threadKey: send.scope.threadKey, gmailMessageId: sent.id });
  return sent.id;
}

/** The channel adapter's `deliver` for `email:principal`: send `main`'s reply, exactly once. */
export async function sendToPrincipal(
  runtime: InboxRuntime,
  threadKey: string | null,
  message: OutboundMessage,
): Promise<string> {
  if (threadKey === null) {
    throw new OutboundRefusedError(
      REFUSED_BY,
      'An email to the principal goes in one of their threads, and this named none.',
    );
  }
  if ((message.files?.length ?? 0) > 0) {
    throw new OutboundRefusedError(
      REFUSED_BY,
      'An email to the principal carries no files; send them in chat instead.',
    );
  }
  const text = replyText(message.content);
  const scope: SendScope = { threadKey, side: 'principal' };
  const hash = contentHash(threadKey, text);
  const existing = await findSend(scope, hash);
  // Gmail took this reply, but its delivery was never recorded: answer from the record.
  if (existing?.state === 'sent') return existing.gmailMessageId;

  const anchor = await principalAnchor(runtime, threadKey);
  if (anchor === undefined) {
    throw new OutboundRefusedError(REFUSED_BY, `Thread ${threadKey} has no email from the principal to answer.`);
  }
  const at = runtime.now().toISOString();
  let send: NewSend;
  if (existing === undefined) {
    send = {
      id: randomUUID(),
      scope,
      contentHash: hash,
      rfcMessageId: newMessageId(domainOf(await runtime.gmailAddress())),
    };
    await insertPendingSend(send, at);
  } else {
    const found = await findSent(runtime.gmail, existing.rfcMessageId, anchor.mail.threadId);
    if (found) return recordDelivered(runtime, existing, found, at);
    send = existing;
  }

  const references = (await visibleMessageIds(threadKey, 'principal')).filter((id) => id !== send.rfcMessageId);
  const body = renderEmail({
    markdown: text,
    signature: emailSignature(await getGwsEaProfile()),
    quote: { from: anchor.from, sentAt: anchor.mail.receivedAt ?? runtime.now(), text: anchor.mail.text },
  });
  const raw = encodeRaw(
    buildMime({
      from: await assistantMailbox(runtime),
      to: [anchor.from.address],
      cc: [],
      bcc: [],
      subject: anchor.mail.subject,
      messageId: send.rfcMessageId,
      ...(anchor.mail.rfcMessageId === undefined ? {} : { inReplyTo: anchor.mail.rfcMessageId }),
      references: references.slice(-MAX_REFERENCES),
      ...body,
      date: runtime.now(),
    }),
  );
  const sent = await sendWithBackoff(runtime, raw, send.rfcMessageId, anchor.mail.threadId);
  return recordDelivered(runtime, send, sent, at);
}
