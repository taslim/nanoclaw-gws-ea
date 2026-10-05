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
 * The private-values guard reads every send before the adapter does, for
 * every address it reaches (`outsideRecipients`), and checks what the
 * assistant wrote: its words, subject, and link targets. The send then goes
 * to the people that check saw. The quote is added after the check, because
 * it shows only a message its readers already received.
 *
 * For `main`, `email_send` writes to the principal in the thread it names,
 * by the rules of its replies there (principal-reply.ts): only to the address
 * Gmail verified wrote the thread's latest principal-only message, and never
 * in a thread that has none.
 *
 * Each request is answered once, a refusal or failure included:
 *
 *   email_send (external-email) { text, subject?, to?, cc?, files? } → { thread_key, message }
 *   email_send (main)           { thread_key, text }                  → { thread_key, message }
 *
 * `files` names the files the tool staged in the request's outbox. A replay
 * of a request sends nothing twice: its send is keyed by the request.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { OutboundFile, OutboundMessage } from '../../channels/adapter.js';
import { ActionRefusal, answeredGuard, answeringAction, type ActionAnswer } from '../../cli/delivery-action.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter, OutboundRefusedError, type OutboundSend } from '../../delivery.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { clearOutbox, readOutboxFiles } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-external-email/index.js';
import { getGwsEaProfile, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { buildMime, encodeRaw, normalizeAddress, parseGmailMessage, type ParsedMail } from './mime.js';
import { replyAll, threadRecipients, type Recipients } from './recipients.js';
import { emailSignature, renderEmail } from './render.js';
import {
  activeInbox,
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
// Who it reaches, as the private-values check sees it
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

/** The plans the private-values check saw, by send, for the send that follows each check. */
const checkedPlans = new Map<string, Plan>();
const MAX_CHECKED_PLANS = 200;

/**
 * The audience check's recipients for a send on `email:inbox`: everyone it
 * reaches. The send that follows goes to exactly these people.
 */
export async function outsideRecipients(send: OutboundSend): Promise<readonly string[]> {
  const runtime = activeInbox();
  if (!runtime || send.platformId !== INBOX_PLATFORM_ID || send.threadId === null) return [];
  let email: OutsideEmail;
  /* eslint-disable no-catch-all/no-catch-all -- content the send cannot carry still resolves; the send itself refuses it */
  try {
    email = outsideEmailOf(JSON.parse(send.content));
  } catch {
    return [];
  }
  /* eslint-enable no-catch-all/no-catch-all */
  const plan = await planSend(runtime, send.threadId, email);
  if (checkedPlans.size >= MAX_CHECKED_PLANS) checkedPlans.delete(checkedPlans.keys().next().value ?? '');
  checkedPlans.set(sendKey(send.threadId, email), plan);
  return [...plan.recipients.to, ...plan.recipients.cc];
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
  const key = sendKey(threadKey, email);
  const checked = checkedPlans.get(key);
  checkedPlans.delete(key);
  return sendExactlyOnce(runtime, { threadKey, side: 'outside' }, key, async () => {
    const { anchor, recipients } = checked ?? (await planSend(runtime, threadKey, email));
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
    const body = renderEmail({
      markdown: email.text,
      signature: emailSignature(await getGwsEaProfile()),
      ...(anchor?.from === undefined
        ? {}
        : { quote: { from: anchor.from, sentAt: anchor.receivedAt ?? runtime.now(), text: anchor.text } }),
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

const invalid = (message: string): ActionRefusal => new ActionRefusal('invalid-args', message);

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

function fileNamesOf(value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.length <= MAX_FILES) {
    const names = value.filter((name: unknown): name is string => typeof name === 'string');
    if (names.length === value.length) return names;
  }
  throw invalid(`files must name up to ${MAX_FILES} files you staged with this request`);
}

/** `main` writes to the principal in one of their threads, as its replies there go. */
async function toPrincipal(content: Record<string, unknown>, requestId: string): Promise<Record<string, unknown>> {
  const threadKey = content.thread_key;
  if (typeof threadKey !== 'string' || !THREAD_KEY.test(threadKey)) {
    throw invalid('thread_key must be the mail-… key of the principal’s thread, as its note gave it');
  }
  for (const field of ['subject', 'to', 'cc', 'files'] as const) {
    if (content[field] !== undefined) {
      throw invalid(`An email to the principal goes to them alone, in their thread: leave out ${field}.`);
    }
  }
  const words = emailWords({ text: content.text, request: requestId });
  if (words === undefined || words.text.trim() === '') throw invalid('text must be the words of your email');
  await deliverEmail(PRINCIPAL_PLATFORM_ID, threadKey, words, undefined);
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
    throw new ActionRefusal('forbidden', 'You write only in your own thread: leave out thread_key.');
  }
  const threadKey = session.thread_id;
  if (threadKey === null) throw new Error(`Session ${session.id} has no thread`);
  const names = fileNamesOf(content.files);
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
    throw error instanceof OutboundRefusedError ? invalid(error.reason) : error;
  }
  const files = names.length === 0 ? undefined : readOutboxFiles(session.agent_group_id, session.id, requestId, names);
  try {
    if (files !== undefined && files.length !== names.length) {
      throw invalid('files must name files you staged with this request; some were not found');
    }
    await deliverEmail(INBOX_PLATFORM_ID, threadKey, email, files);
  } finally {
    if (names.length > 0) clearOutbox(session.agent_group_id, session.id, requestId);
  }
  return { thread_key: threadKey, message: 'Your email is sent.' };
}

/** `email_send`, from `main` to the principal or from `external-email` in its own thread. */
const emailSend: ActionAnswer = async (content, session, requestId) => {
  try {
    return session.agent_group_id === (await getMainAgentGroupId())
      ? await toPrincipal(content, requestId)
      : await inThread(content, session, requestId);
  } catch (error) {
    // An outbound guard refused the email as written.
    throw error instanceof OutboundRefusedError
      ? new ActionRefusal('forbidden', `Your email was not sent: ${error.reason}`)
      : error;
  }
};

export const emailSendHandler = answeringAction(EMAIL_SEND_ACTION, emailSend);

/** The guard `email_send` passes. */
export const EMAIL_SEND_GUARD = answeredGuard(emailSendAction);
