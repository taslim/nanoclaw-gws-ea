/**
 * `main`'s email to the principal (KTD1, R64): its reply in a thread only the
 * principal and the assistant can read, which ordinary delivery hands the
 * adapter for `email:principal`.
 *
 * It answers the thread's anchor: the latest message on the principal's side
 * that the principal wrote, which Gmail must still verify as theirs now. It
 * goes to that message's From address alone, never to its Reply-To, To, or
 * Cc, nor to the principal's other addresses, in that message's Gmail
 * thread, quoting it, and signed by the host (render.ts), with any files
 * `main` sent: the principal may receive anything. A thread with no such
 * message refuses it.
 *
 * The audience check resolves the same address (`principalRecipients`), so a
 * send clears the private-values check only because every recipient is one
 * of the principal's addresses. It is sent exactly once (send.ts), on the
 * thread's principal side of the send ledger. `main`'s `email_send` writes
 * here too, by thread key, so the same rules hold for it (outbound.ts).
 */
import type { OutboundMessage } from '../../channels/adapter.js';
import { OutboundRefusedError, type OutboundSend } from '../../delivery.js';
import { getGwsEaProfile, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { authenticateSender } from './authentication.js';
import { buildMime, encodeRaw, parseGmailMessage, type Mailbox, type ParsedMail } from './mime.js';
import { emailSignature, renderEmail } from './render.js';
import { activeInbox, assistantAddresses, type InboxRuntime } from './runtime.js';
import { assistantMailbox, emailWords, MAX_REFERENCES, sendExactlyOnce, sendKey } from './send.js';
import { threadMessages, visibleMessageIds } from './thread-map.js';

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
  const words = emailWords(message.content);
  if (words === undefined)
    throw new OutboundRefusedError(REFUSED_BY, 'An email to the principal carries words, as text.');
  return sendExactlyOnce(runtime, { threadKey, side: 'principal' }, sendKey(threadKey, words), async () => {
    const anchor = await principalAnchor(runtime, threadKey);
    if (anchor === undefined) {
      throw new OutboundRefusedError(REFUSED_BY, `Thread ${threadKey} has no email from the principal to answer.`);
    }
    const body = renderEmail({
      markdown: words.text,
      signature: emailSignature(await getGwsEaProfile()),
      quote: { from: anchor.from, sentAt: anchor.mail.receivedAt ?? runtime.now(), text: anchor.mail.text },
    });
    const from = await assistantMailbox(runtime);
    const visible = await visibleMessageIds(threadKey, 'principal');
    return {
      gmailThreadId: anchor.mail.threadId,
      raw: async (rfcMessageId) =>
        encodeRaw(
          buildMime({
            from,
            to: [anchor.from.address],
            cc: [],
            bcc: [],
            subject: anchor.mail.subject,
            messageId: rfcMessageId,
            ...(anchor.mail.rfcMessageId === undefined ? {} : { inReplyTo: anchor.mail.rfcMessageId }),
            references: visible.filter((id) => id !== rfcMessageId).slice(-MAX_REFERENCES),
            ...body,
            attachments: message.files ?? [],
            date: runtime.now(),
          }),
        ),
    };
  });
}
