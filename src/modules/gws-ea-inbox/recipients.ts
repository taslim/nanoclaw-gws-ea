/**
 * Who a reply goes to (KTD4). The allowed recipients are a ceiling, not a
 * send list: the meeting's counterparts, the senders Gmail authenticated in
 * the thread, and a principal address only when a verified message already
 * put it on the thread. The host never adds one, so a thread `arrange` or
 * `ask_organizer` opened never copies the principal. Each send goes to the
 * thread's current participants inside the ceiling, all on To: there is no Cc
 * and no Bcc, and an address that only a Cc or Reply-To line named is never
 * a recipient unless it is already inside the ceiling.
 *
 * The audience check (KTD7) resolves its audience through `recipientsForSend`,
 * and the adapter sends to the same list, so the check sees exactly who the
 * message reaches.
 */
import type { InboxThread } from './db.js';
import { getThread, uniqueAddresses } from './db.js';

/** The ceiling: every address a reply in this thread may ever go to. */
export function allowedRecipientsOf(thread: InboxThread, assistant: ReadonlySet<string>): string[] {
  return uniqueAddresses([...thread.counterparts, ...thread.authenticatedSenders, ...thread.principalAddresses]).filter(
    (address) => !assistant.has(address),
  );
}

/** The send list: the thread's current participants that fall inside its ceiling. */
export function sendListOf(thread: InboxThread, assistant: ReadonlySet<string>): string[] {
  const ceiling = new Set(allowedRecipientsOf(thread, assistant));
  return thread.participants.filter((address) => ceiling.has(address));
}

/**
 * The participants after a message whose addresses are `seen`: they replace
 * the current ones when any of them falls inside the ceiling, and otherwise
 * stay, so mail from outside the ceiling can neither add recipients nor
 * strand the thread with none.
 */
export function nextParticipants(
  thread: InboxThread,
  seen: readonly string[],
  assistant: ReadonlySet<string>,
): string[] {
  const candidates = uniqueAddresses(seen).filter((address) => !assistant.has(address));
  const ceiling = new Set(allowedRecipientsOf(thread, assistant));
  return candidates.some((address) => ceiling.has(address)) ? candidates : [...thread.participants];
}

/** The exact addresses a send in `threadKey` goes to; empty for anything that is not an open inbox thread. */
export async function recipientsForThread(threadKey: string, assistant: ReadonlySet<string>): Promise<string[]> {
  const thread = await getThread(threadKey);
  if (!thread || (thread.state !== 'authorized' && thread.state !== 'open')) return [];
  return sendListOf(thread, assistant);
}
