/**
 * Email to anyone but the principal (KTD5, KTD9; R61, R68, R75, R76), and
 * `email_send` for both agents.
 *
 * Ordinary delivery hands the channel adapter every send on `email:inbox`
 * (`sendToOutside`): `external-email`'s final text, and its `email_send`
 * requests. Each goes out exactly once (send.ts), on the thread's outside
 * side of the send ledger:
 *
 * - A reply answers the latest message on the thread's outside side that
 *   Gmail still holds, the assistant's own included: to everyone it placed
 *   (recipients.ts), quoting it, under its subject, in its Gmail thread, and
 *   referencing only Message-IDs the outside side has seen. A principal-only
 *   note in the same Gmail thread is never quoted, referenced, or addressed.
 * - `email_send` may name who it goes to, carry files, and write a thread's
 *   first email, which takes a subject and goes to everyone `main` named
 *   unless it names others. Final text in a thread with no message yet is
 *   refused with a reason that names `email_send`.
 * - Every recipient passes the recipient guard (recipients.ts).
 * - A file goes only when `main` handed it over for this thread: its SHA-256
 *   must be recorded with the thread, and the host's copy is what is sent.
 *
 * The private-values check runs here, as the email is built, on the email
 * that goes and the people it goes to; the privacy module's outbound guard
 * leaves these sends to it. What the assistant wrote is checked for everyone
 * the email reaches: its words as written and as both parts show them, its
 * link targets, its subject, the addresses it names, and the host's copies of
 * the files that go. What a reply carries over from the message it answers
 * (its subject, its people, and the quote under its attribution) shows its
 * readers what they already received, so it is checked only for anyone new
 * to the thread (`carriedOver`): the quote goes without them when it would
 * show them a private value, and the email does not go at all when its
 * subject or people would.
 *
 * Then the link check (gws-ea-workspace's `checkLinksOpenable`, Slice 6
 * KTD4): every Google link in what the assistant wrote, its subject, words
 * and text files, must open for everyone the email reaches but the
 * principal. The quote is never read: its links are other people's. A
 * refusal tells external-email only who cannot open a link, and to tell
 * main. When Google is briefly unavailable, a reply waits for delivery's own
 * retry, and `email_send` answers that it can be tried again shortly.
 *
 * A send Gmail already took is answered from Gmail before anything is
 * checked again (send.ts), so a check that would refuse it now never reports
 * a sent email as unsent.
 *
 * For `main`, `email_send` writes to the principal in the thread it names,
 * by the rules of its replies there (principal-reply.ts): only to the address
 * Gmail verified wrote the thread's latest principal-only message, and never
 * in a thread that has none. It may carry any file `main` staged: the
 * principal may receive anything.
 *
 * Each request is answered once, a refusal or failure included:
 *
 *   email_send (external-email) { text, subject?, to?, cc?, files? } → { thread_key, message }
 *   email_send (main)           { thread_key, text, files? }          → { thread_key, message }
 *
 * `files` names the files the tool staged in the request's outbox. A replay
 * of a request sends nothing twice: its send is keyed by the request.
 */
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { OutboundFile, OutboundMessage } from '../../channels/adapter.js';
import {
  answeredGuard,
  answeringAction,
  forbidden,
  invalidArgs,
  type ActionAnswer,
} from '../../cli/delivery-action.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter, OutboundRefusedError } from '../../delivery.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { readOutboxFiles } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-external-email/index.js';
import { audienceForAddresses, checkOutbound, PRIVACY_GUARD_ID } from '../gws-ea-privacy/index.js';
import { getGwsEaProfile, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import {
  checkLinksOpenable,
  LINK_ACCESS_REFUSER,
  LinkCheckUnavailableError,
  LINKS_UNCHECKED,
} from '../gws-ea-workspace/link-access.js';
import { buildMime, encodeRaw, normalizeAddress, parseGmailMessage, type ParsedMail } from './mime.js';
import { replyAll, threadRecipients, type Recipients } from './recipients.js';
import { emailSignature, quotedBy, renderEmail, type QuotedMessage } from './render.js';
import {
  assistantAddresses,
  EMAIL_CHANNEL_TYPE,
  INBOX_PLATFORM_ID,
  PRINCIPAL_PLATFORM_ID,
  type InboxRuntime,
} from './runtime.js';
import type { GmailMessage } from './gmail-api.js';
import {
  assistantMailbox,
  carriesMessageId,
  emailWords,
  MAX_REFERENCES,
  sendExactlyOnce,
  sendKey,
  type EmailWords,
} from './send.js';
import {
  findThreadFile,
  getThread,
  threadAddresses,
  threadMessages,
  visibleMessageIds,
  type ThreadMessage,
} from './thread-map.js';

const REFUSED_BY = 'gws-ea-inbox:outside-email';
const SUBJECT_MAX = 200;

function refused(reason: string): OutboundRefusedError {
  return new OutboundRefusedError(REFUSED_BY, reason);
}

// ---------------------------------------------------------------------------
// What a send asks for
// ---------------------------------------------------------------------------

/** An email to a thread's outside side, as a reply or `email_send` asks for it. */
interface OutsideEmail extends EmailWords {
  /** A thread's first email's; a reply keeps its thread's. */
  readonly subject?: string;
  /** Who it goes to, when it names them rather than replying to all. */
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
}

function addressesOf(value: unknown, field: 'to' | 'cc'): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw refused(`${field} must list email addresses.`);
  return value.map((entry: unknown) => {
    const address = typeof entry === 'string' ? normalizeAddress(entry) : undefined;
    if (address === undefined) {
      throw refused(`${field} must list email addresses; ${JSON.stringify(entry)} is not one.`);
    }
    return address;
  });
}

/** The email a send's content asks for; refuses anything email cannot carry. */
function outsideEmailOf(content: unknown): OutsideEmail {
  const words = emailWords(content);
  if (words === undefined || words.text.trim() === '') throw refused('An email carries words, as text.');
  const fields = content as { subject?: unknown; to?: unknown; cc?: unknown };
  const subject = typeof fields.subject === 'string' ? fields.subject.replace(/\s+/gu, ' ').trim() : fields.subject;
  if (
    subject !== undefined &&
    (typeof subject !== 'string' || subject === '' || subject.length > SUBJECT_MAX || hasControlCharacters(subject))
  ) {
    throw refused(`A subject is one line of 1 to ${SUBJECT_MAX} characters.`);
  }
  const to = addressesOf(fields.to, 'to');
  const cc = addressesOf(fields.cc, 'cc');
  return {
    ...words,
    ...(subject === undefined ? {} : { subject }),
    ...(to === undefined ? {} : { to }),
    ...(cc === undefined ? {} : { cc }),
  };
}

// ---------------------------------------------------------------------------
// Who it reaches
// ---------------------------------------------------------------------------

/** What a send answers, and who it reaches. */
interface Plan {
  /** The message it answers; undefined for a thread's first email. */
  readonly anchor: ParsedMail | undefined;
  readonly recipients: Recipients;
}

/**
 * The latest message on the thread's outside side that Gmail still holds. A
 * message the thread knows only by its Message-ID is found by it in the
 * thread's Gmail thread.
 */
async function outsideAnchor(runtime: InboxRuntime, threadKey: string): Promise<ParsedMail | undefined> {
  let inGmailThread: readonly GmailMessage[] | undefined;
  const gmailIdOf = async ({ gmailMessageId, rfcMessageId }: ThreadMessage): Promise<string | undefined> => {
    if (gmailMessageId !== null) return gmailMessageId;
    if (rfcMessageId === null) return undefined;
    if (inGmailThread === undefined) {
      const gmailThreadId = (await getThread(threadKey))?.gmailThreadId ?? null;
      inGmailThread = gmailThreadId === null ? [] : ((await runtime.gmail.getThread(gmailThreadId)) ?? []);
    }
    return inGmailThread.find((held) => carriesMessageId(held.payload?.headers ?? [], rfcMessageId))?.id;
  };
  for (const message of (await threadMessages(threadKey, 'outside')).reverse()) {
    const gmailMessageId = await gmailIdOf(message);
    if (gmailMessageId === undefined) continue;
    const found = await runtime.gmail.getMessage(gmailMessageId, 'full');
    if (found) return parseGmailMessage(found);
  }
  return undefined;
}

async function planSend(runtime: InboxRuntime, threadKey: string, email: OutsideEmail): Promise<Plan> {
  // The assistant's own Gmail address is never one of the people a reply goes to.
  await runtime.gmailAddress();
  const anchor = await outsideAnchor(runtime, threadKey);
  if (email.to !== undefined || email.cc !== undefined) {
    return { anchor, recipients: { to: email.to ?? [], cc: email.cc ?? [] } };
  }
  if (anchor !== undefined) return { anchor, recipients: replyAll(anchor, await assistantAddresses()) };
  const named = (await threadAddresses(threadKey)).filter((entry) => entry.source === 'main');
  return { anchor, recipients: { to: [...new Set(named.map((entry) => entry.address))], cc: [] } };
}

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The host's copy of each file, each of which `main` must have handed over for this thread. */
async function handedFiles(threadKey: string, files: readonly OutboundFile[]): Promise<OutboundFile[]> {
  const attachments: OutboundFile[] = [];
  for (const file of files) {
    const hash = sha256(file.data);
    const handed = await findThreadFile(threadKey, hash);
    if (handed === undefined) {
      throw refused(`${file.filename} is not a file main handed over for this thread, so it cannot go out.`);
    }
    const copy = await readFile(handed.hostPath);
    if (sha256(copy) !== hash) {
      throw new Error(`The host's copy of ${handed.fileName} changed after main handed it over`);
    }
    attachments.push({ filename: handed.fileName, data: copy });
  }
  return attachments;
}

/** The text of the files that go, as the host holds them: each one's name, and its contents when they are text. */
function filesText(files: readonly OutboundFile[]): string[] {
  return files.flatMap((file) => [file.filename, ...(isUtf8(file.data) ? [file.data.toString('utf8')] : [])]);
}

/**
 * What a reply carries over from the message it answers: its subject, its
 * people, and the quote under its attribution. Its readers received them;
 * anyone new to the thread sees them only when they hold no private value
 * for them. Otherwise the quote goes without them, and a subject or people
 * that would show them one refuse the email. Returns the quote that goes.
 */
async function carriedOver(
  anchor: ParsedMail,
  placed: Recipients,
  runtime: InboxRuntime,
): Promise<QuotedMessage | undefined> {
  const quote: QuotedMessage | undefined =
    anchor.from === undefined
      ? undefined
      : { from: anchor.from, sentAt: anchor.receivedAt ?? runtime.now(), text: anchor.text };
  const readers = new Set(
    [...(anchor.from === undefined ? [] : [anchor.from]), ...anchor.to, ...anchor.cc].flatMap(
      ({ address }) => normalizeAddress(address) ?? [],
    ),
  );
  const people = [...placed.to, ...placed.cc];
  const newcomers = people.filter((address) => !readers.has(address));
  if (newcomers.length === 0) return quote;
  const audience = await audienceForAddresses(newcomers);
  if (!(await checkOutbound([anchor.subject ?? '', ...people], audience)).allowed) {
    throw new OutboundRefusedError(
      PRIVACY_GUARD_ID,
      "the thread's subject or the people on this email would show someone new to the thread the principal's private details. Send it without the people new to the thread, or tell main.",
    );
  }
  if (quote === undefined) return undefined;
  return (await checkOutbound([quotedBy(quote), quote.text], audience)).allowed ? quote : undefined;
}

/** The channel adapter's `deliver` for `email:inbox`: send one email in its thread, exactly once. */
export async function sendToOutside(
  runtime: InboxRuntime,
  platformId: string,
  threadKey: string | null,
  message: OutboundMessage,
): Promise<string> {
  if (platformId !== INBOX_PLATFORM_ID || threadKey === null || (await getThread(threadKey)) === undefined) {
    throw refused("An email to anyone but the principal goes in one of the inbox's threads, and this named none.");
  }
  const email = outsideEmailOf(message.content);
  return sendExactlyOnce(runtime, { threadKey, side: 'outside' }, sendKey(threadKey, email), async () => {
    const { anchor, recipients } = await planSend(runtime, threadKey, email);
    if (anchor === undefined && email.subject === undefined) {
      throw refused(
        `Thread ${threadKey} has no email yet, so there is nothing to reply to: write its first email with email_send, giving it a subject.`,
      );
    }
    if (anchor !== undefined && email.subject !== undefined) {
      throw refused("A reply keeps its thread's subject: only a thread's first email takes one.");
    }
    const placed = await threadRecipients(threadKey, recipients, await assistantAddresses());
    const attachments = await handedFiles(threadKey, message.files ?? []);
    // What the assistant wrote, for everyone the email reaches: both parts show only its words and its links.
    const written = await checkOutbound(
      [email.subject ?? '', email.text, ...(email.to ?? []), ...(email.cc ?? []), ...filesText(attachments)],
      await audienceForAddresses([...placed.to, ...placed.cc]),
    );
    if (!written.allowed) throw new OutboundRefusedError(PRIVACY_GUARD_ID, written.reason);
    const quote = anchor === undefined ? undefined : await carriedOver(anchor, placed, runtime);
    // Every Google link it wrote opens for everyone it reaches; the quote's links are its writer's.
    const links = await checkLinksOpenable({
      texts: [email.subject ?? '', email.text, ...filesText(attachments)],
      recipients: [...placed.to, ...placed.cc],
      writer: 'external-email',
    });
    if (!links.allowed) throw new OutboundRefusedError(LINK_ACCESS_REFUSER, links.reason);
    const body = renderEmail({
      markdown: email.text,
      signature: emailSignature(await getGwsEaProfile()),
      ...(quote === undefined ? {} : { quote }),
    });
    const from = await assistantMailbox(runtime);
    const visible = anchor === undefined ? [] : await visibleMessageIds(threadKey, 'outside');
    return {
      gmailThreadId: anchor?.threadId ?? null,
      raw: async (rfcMessageId) =>
        encodeRaw(
          buildMime({
            from,
            ...placed,
            bcc: [],
            subject: anchor?.subject ?? email.subject ?? '',
            messageId: rfcMessageId,
            ...(anchor?.rfcMessageId === undefined ? {} : { inReplyTo: anchor.rfcMessageId }),
            references: visible.filter((id) => id !== rfcMessageId).slice(-MAX_REFERENCES),
            ...body,
            attachments,
            date: runtime.now(),
          }),
        ),
    };
  });
}

// ---------------------------------------------------------------------------
// email_send
// ---------------------------------------------------------------------------

/** The delivery action both agents send email with; the runner's tool of the same name sends it. */
export const EMAIL_SEND_ACTION = 'email_send';

const THREAD_KEY = /^mail-[A-Za-z0-9-]{1,80}$/u;
const MAX_FILES = 10;

/** `main`, to the principal; and `external-email`, from the session of one email thread, in that thread alone. */
const emailSendAction = defineGuardedAction({
  action: 'gws_ea_inbox.email_send',
  decide: async ({ actor }) => {
    if (actor.kind !== 'agent') return DENY('Only main and external-email send email.');
    if (actor.agentGroupId === (await getMainAgentGroupId())) return ALLOW("main, by the profile's pointer");
    if (actor.agentGroupId !== (await getExternalEmailAgentGroupId()) || actor.sessionId === undefined) {
      return DENY('Only main and external-email send email.');
    }
    const session = await getSession(actor.sessionId);
    const threadKey = session?.agent_group_id === actor.agentGroupId ? session.thread_id : null;
    if (threadKey === null || (await getThread(threadKey)) === undefined) {
      return DENY('This conversation is not an email thread, so it has no one to email.');
    }
    return ALLOW("external-email, from its email thread's own session");
  },
});

/** Hand an email to delivery, past every outbound guard, as any send on the channel goes. */
async function deliverEmail(
  platformId: string,
  threadKey: string,
  email: EmailWords,
  files: OutboundFile[] | undefined,
): Promise<void> {
  const delivery = getDeliveryAdapter();
  if (!delivery) throw new Error('Delivery is not running yet');
  await delivery.deliver(EMAIL_CHANNEL_TYPE, platformId, threadKey, 'chat', JSON.stringify(email), files);
}

/** The files a request names, read from its own outbox; refused unless each one is there. */
function stagedFiles(session: Session, requestId: string, value: unknown): OutboundFile[] | undefined {
  if (value === undefined) return undefined;
  const names = Array.isArray(value) ? value.filter((name: unknown): name is string => typeof name === 'string') : [];
  if (!Array.isArray(value) || value.length > MAX_FILES || names.length !== value.length) {
    throw invalidArgs(`files must name up to ${MAX_FILES} files you staged with this request`);
  }
  if (names.length === 0) return undefined;
  const files = readOutboxFiles(session.agent_group_id, session.id, requestId, names);
  if (files?.length !== names.length) {
    throw invalidArgs('files must name files you staged with this request; some were not found');
  }
  return files;
}

/** `main` writes to the principal in one of their threads, as its replies there go, with any files it staged. */
async function toPrincipal(
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
): Promise<Record<string, unknown>> {
  const threadKey = content.thread_key;
  if (typeof threadKey !== 'string' || !THREAD_KEY.test(threadKey)) {
    throw invalidArgs('thread_key must be the mail-… key of the principal’s thread, as its note gave it');
  }
  for (const field of ['subject', 'to', 'cc'] as const) {
    if (content[field] !== undefined) {
      throw invalidArgs(`An email to the principal goes to them alone, in their thread: leave out ${field}.`);
    }
  }
  const files = stagedFiles(session, requestId, content.files);
  const words = emailWords({ text: content.text, request: requestId });
  if (words === undefined || words.text.trim() === '') throw invalidArgs('text must be the words of your email');
  await deliverEmail(PRINCIPAL_PLATFORM_ID, threadKey, words, files);
  return {
    thread_key: threadKey,
    message: 'Your email went to the principal, in their thread. Do not repeat it here.',
  };
}

/** `external-email` writes in its own thread: a first email, a reply to whom it names, or one with files. */
async function inThread(
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
): Promise<Record<string, unknown>> {
  if (content.thread_key !== undefined) {
    throw forbidden('You write only in your own thread: leave out thread_key.');
  }
  const threadKey = session.thread_id;
  if (threadKey === null) throw new Error(`Session ${session.id} has no thread`);
  let email: OutsideEmail;
  try {
    email = outsideEmailOf({
      text: content.text,
      subject: content.subject,
      to: content.to,
      cc: content.cc,
      request: requestId,
    });
  } catch (error) {
    throw error instanceof OutboundRefusedError ? invalidArgs(error.reason) : error;
  }
  const files = stagedFiles(session, requestId, content.files);
  await deliverEmail(INBOX_PLATFORM_ID, threadKey, email, files);
  return { thread_key: threadKey, message: 'Your email is sent.' };
}

/** `email_send`, from `main` to the principal or from `external-email` in its own thread. */
const emailSend: ActionAnswer = async (content, session, requestId) => {
  try {
    return session.agent_group_id === (await getMainAgentGroupId())
      ? await toPrincipal(content, session, requestId)
      : await inThread(content, session, requestId);
  } catch (error) {
    // An outbound guard refused the email as written, or Google was too briefly unavailable to check its links.
    if (error instanceof OutboundRefusedError) throw forbidden(`Your email was not sent: ${error.reason}`);
    if (error instanceof LinkCheckUnavailableError) throw forbidden(`Your email was not sent: ${LINKS_UNCHECKED}`);
    throw error;
  }
};

export const emailSendHandler = answeringAction(EMAIL_SEND_ACTION, emailSend);

/** The guard `email_send` passes. */
export const EMAIL_SEND_GUARD = answeredGuard(emailSendAction);
