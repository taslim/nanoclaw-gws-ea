/**
 * The inbox's threads, as the meeting handoff (U11) drives them (KTD4, KTD5).
 *
 * A thread is authorized only when `arrange` or `ask_organizer` opens it, or
 * when the principal's verified message copied the assistant in. Its mail is
 * held until its `external-email` session is open and has its brief:
 *
 * 1. `mintThreadKey()` names a new thread for a meeting.
 * 2. `authorizeThread(...)` authorizes it: a new thread to the meeting's
 *    counterparts, or a copied-in thread whose counterparts the principal's
 *    own message named.
 * 3. `openThreadSession(threadKey)` opens the thread's session, with the
 *    address the brief and every reply use.
 * 4. The handoff writes the brief into that session.
 * 5. `releaseHeldMail(threadKey)` opens the thread to its mail and hands the
 *    session whatever arrived before, in order.
 *
 * `allowedRecipients` and `getThreadParticipants` read a thread;
 * `closeThread` ends it, after which its mail reaches `main` as a note.
 * `handBackCopiedInThread` returns a copied-in thread whose arrange failed
 * to waiting for arrange, its held mail kept.
 */
import { randomUUID } from 'node:crypto';

import type { DeliveryAddress } from '../../channels/adapter.js';
import { log } from '../../log.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-external-email/index.js';
import { audienceForAddresses, checkOutbound } from '../gws-ea-privacy/index.js';
import { listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { authenticateSender } from './authentication.js';
import {
  dropHeldMessage,
  getInboxState,
  recordFailedAttempt,
  getThread,
  heldMessages,
  insertThread,
  uniqueAddresses,
  updateThread,
  type InboxThread,
  type ThreadState,
} from './db.js';
import { GoogleApiError } from './gmail-api.js';
import { normalizeAddress, parseGmailMessage } from './mime.js';
import { noticeSetAside } from './notices.js';
import { allowedRecipientsOf } from './recipients.js';
import { deliverToSession, loadRoutingContext } from './routing.js';
import { activeInbox, assistantAddresses, EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID } from './runtime.js';

const THREAD_KEY = /^mail-[A-Za-z0-9-]{1,80}$/u;
const SUBJECT_MAX_LENGTH = 200;

/** What a thread looks like to the handoff. */
export interface ThreadView {
  readonly threadKey: string;
  readonly state: ThreadState;
  readonly origin: InboxThread['origin'];
  readonly subject: string;
  readonly gmailThreadId: string | null;
  /** The meeting's counterparts: the base of the thread's allowed recipients. */
  readonly counterparts: readonly string[];
  /** Who the next reply goes to: the current participants inside the ceiling. */
  readonly participants: readonly string[];
  /** The principal's addresses a verified message put on the thread. */
  readonly principalAddresses: readonly string[];
  /** Senders Gmail authenticated in the thread. */
  readonly authenticatedSenders: readonly string[];
  readonly sessionId: string | null;
}

function view(thread: InboxThread): ThreadView {
  return {
    threadKey: thread.threadKey,
    state: thread.state,
    origin: thread.origin,
    subject: thread.subject,
    gmailThreadId: thread.gmailThreadId,
    counterparts: thread.counterparts,
    participants: thread.participants,
    principalAddresses: thread.principalAddresses,
    authenticatedSenders: thread.authenticatedSenders,
    sessionId: thread.sessionId,
  };
}

function requireKey(threadKey: string): string {
  if (!THREAD_KEY.test(threadKey)) throw new Error(`Not an inbox thread key: ${JSON.stringify(threadKey)}`);
  return threadKey;
}

async function requireThread(threadKey: string): Promise<InboxThread> {
  const thread = await getThread(requireKey(threadKey));
  if (!thread) throw new Error(`No inbox thread ${threadKey}`);
  return thread;
}

/** A fresh key for one meeting's email thread. */
export function mintThreadKey(): string {
  return `mail-${randomUUID()}`;
}

/** Where a thread's brief is written and its replies go. */
export function threadAddress(threadKey: string): DeliveryAddress {
  return { channelType: EMAIL_CHANNEL_TYPE, platformId: INBOX_PLATFORM_ID, threadId: requireKey(threadKey) };
}

export type AuthorizeThreadInput =
  | {
      /** A thread `arrange` or `ask_organizer` opens: it starts with the host's first email. */
      readonly kind: 'new';
      readonly threadKey: string;
      readonly opener: 'arrange' | 'ask_organizer';
      /** The first email's subject; checked like anything else sent to the counterparts. */
      readonly subject: string;
      /** The addresses the host took from the people store or from Google, never from mail. */
      readonly counterparts: readonly string[];
    }
  | {
      /** A thread the principal copied the assistant into, as its copy-in note named it. */
      readonly kind: 'copy-in';
      readonly threadKey: string;
    };

/**
 * Authorize a thread for `external-email`. Repeating the same authorization
 * returns the thread as it is, so a replayed request opens nothing twice.
 */
export async function authorizeThread(input: AuthorizeThreadInput): Promise<ThreadView> {
  const threadKey = requireKey(input.threadKey);
  const existing = await getThread(threadKey);
  const at = new Date().toISOString();

  if (input.kind === 'copy-in') {
    if (!existing || existing.origin !== 'copy-in') throw new Error(`No copied-in thread ${threadKey}`);
    if (existing.state === 'closed') throw new Error(`Thread ${threadKey} is closed`);
    if (existing.state === 'awaiting-arrange') {
      await updateThread(threadKey, { state: 'authorized' }, at);
      return view({ ...existing, state: 'authorized' });
    }
    return view(existing);
  }

  const assistant = await assistantAddresses();
  const principal = new Set((await listPrincipalAddresses()).map((address) => address.email));
  const counterparts = uniqueAddresses(
    input.counterparts.map((address) => {
      const normalized = normalizeAddress(address);
      if (normalized === undefined) throw new Error(`Not an email address: ${JSON.stringify(address)}`);
      if (assistant.has(normalized)) throw new Error('The assistant is never its own counterpart');
      if (principal.has(normalized)) throw new Error('A thread the assistant opens never copies the principal');
      return normalized;
    }),
  );
  if (counterparts.length === 0) throw new Error('A thread needs at least one counterpart');
  const subject = input.subject.replace(/\s+/gu, ' ').trim();
  if (subject === '' || subject.length > SUBJECT_MAX_LENGTH) {
    throw new Error(`A thread's subject must be one line of 1 to ${SUBJECT_MAX_LENGTH} characters`);
  }
  if (existing) {
    const same =
      existing.origin === input.opener &&
      existing.subject === subject &&
      existing.counterparts.length === counterparts.length &&
      existing.counterparts.every((address) => counterparts.includes(address));
    if (!same) throw new Error(`Thread ${threadKey} is already authorized for something else`);
    return view(existing);
  }
  const check = await checkOutbound(subject, await audienceForAddresses(counterparts));
  if (!check.allowed) throw new Error(`The subject was refused: ${check.reason}`);
  await insertThread(
    {
      threadKey,
      origin: input.opener,
      state: 'authorized',
      gmailThreadId: null,
      subject,
      counterparts,
      participants: counterparts,
      authenticatedSenders: [],
      principalAddresses: [],
    },
    at,
  );
  return view(await requireThread(threadKey));
}

/**
 * Open the thread's `external-email` session (one per thread), or return the
 * one already open. Mail stays held until `releaseHeldMail`, so the brief is
 * the session's first message.
 */
export async function openThreadSession(
  threadKey: string,
): Promise<{ readonly session: Session; readonly address: DeliveryAddress }> {
  const thread = await requireThread(threadKey);
  if (thread.state !== 'authorized' && thread.state !== 'open') {
    throw new Error(`Thread ${threadKey} is not authorized`);
  }
  const externalEmail = await getExternalEmailAgentGroupId();
  const inbox = (await getInboxState()).messaging_group_id;
  if (externalEmail === null || inbox === null) throw new Error('The inbox or external-email does not exist yet');
  const { session } = await resolveSession(externalEmail, inbox, threadKey, 'per-thread');
  if (thread.sessionId !== session.id)
    await updateThread(threadKey, { sessionId: session.id }, new Date().toISOString());
  return { session, address: threadAddress(threadKey) };
}

/** Failed attempts to hand one held message over before it is set aside. */
export const MAX_RELEASE_ATTEMPTS = 5;

/**
 * Hand the thread's held mail to its session, oldest first. Without a running
 * inbox the mail stays held, and the next poll hands it over. A message that
 * keeps failing is set aside after `MAX_RELEASE_ATTEMPTS`; Gmail being
 * unreachable is not the message's failure and throws.
 */
export async function deliverHeldMail(
  threadKey: string,
): Promise<{ readonly released: number; readonly setAside: number }> {
  const runtime = activeInbox();
  if (!runtime?.setup()) return { released: 0, setAside: 0 };
  const thread = await requireThread(threadKey);
  if (thread.state !== 'open') return { released: 0, setAside: 0 };
  const context = await loadRoutingContext(await assistantAddresses(), runtime.now());
  let released = 0;
  let setAside = 0;
  for (const gmailMessageId of await heldMessages(threadKey)) {
    const message = await runtime.gmail.getMessage(gmailMessageId, 'full');
    if (!message) {
      log.warn('Held mail no longer exists in Gmail', { threadKey, gmailMessageId });
      await dropHeldMessage(gmailMessageId);
      continue;
    }
    try {
      const mail = parseGmailMessage(message);
      await deliverToSession(thread, mail, authenticateSender(mail.headers, context.auth), runtime, context.at);
    } catch (error) {
      if (error instanceof GoogleApiError) throw error;
      const attempts = await recordFailedAttempt(gmailMessageId, context.at.toISOString());
      log.error('Held mail could not be handed to its session', { threadKey, gmailMessageId, attempts, error });
      if (attempts < MAX_RELEASE_ATTEMPTS) break;
      await dropHeldMessage(gmailMessageId);
      setAside += 1;
      continue;
    }
    await dropHeldMessage(gmailMessageId);
    released += 1;
  }
  return { released, setAside };
}

/**
 * Open the thread to its mail, once the brief is written, and hand over what
 * was held. Returns how many held messages reached the session now.
 */
export async function releaseHeldMail(threadKey: string): Promise<{ readonly released: number }> {
  const thread = await requireThread(threadKey);
  if (thread.state === 'awaiting-arrange' || thread.state === 'closed') {
    throw new Error(`Thread ${threadKey} is not authorized`);
  }
  if (thread.sessionId === null) throw new Error(`Thread ${threadKey} has no open session yet`);
  if (thread.state === 'authorized') await updateThread(threadKey, { state: 'open' }, new Date().toISOString());
  const { released, setAside } = await deliverHeldMail(threadKey);
  if (setAside > 0) await noticeSetAside();
  return { released };
}

/** The ceiling of who any reply in the thread may go to. */
export async function allowedRecipients(threadKey: string): Promise<readonly string[]> {
  return allowedRecipientsOf(await requireThread(threadKey), await assistantAddresses());
}

/** The thread as the inbox holds it, or undefined. */
export async function getThreadParticipants(threadKey: string): Promise<ThreadView | undefined> {
  const thread = await getThread(requireKey(threadKey));
  return thread ? view(thread) : undefined;
}

/**
 * Hand a copied-in thread whose arrange failed back to the principal: it
 * waits for arrange again, its mail held as before. Closing the session it
 * had is the caller's; the next arrange opens a new one.
 */
export async function handBackCopiedInThread(threadKey: string): Promise<void> {
  const thread = await requireThread(threadKey);
  if (thread.origin !== 'copy-in') throw new Error(`Thread ${threadKey} was not copied in`);
  if (thread.state === 'awaiting-arrange' || thread.state === 'closed') return;
  await updateThread(threadKey, { state: 'awaiting-arrange' }, new Date().toISOString());
}

/** End a thread: nothing more is held or delivered to its session, and later mail reaches `main` as a note. */
export async function closeThread(threadKey: string): Promise<void> {
  await requireThread(threadKey);
  for (const gmailMessageId of await heldMessages(threadKey)) await dropHeldMessage(gmailMessageId);
  await updateThread(threadKey, { state: 'closed' }, new Date().toISOString());
}
