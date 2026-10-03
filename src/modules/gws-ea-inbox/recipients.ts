/**
 * Who a reply goes to (KTD16, R40): everyone on the thread, placed the way a
 * person replying to all would place them, and rearranged only by judgment.
 *
 * - A thread's people come from its latest message: its From and To go on
 *   To, its Cc on Cc, and the assistant on neither. Every message in the
 *   thread replaces them, whoever sent it, the way a person reads a thread.
 *   A Reply-To is never read.
 * - A thread the assistant starts begins with the people `main` named, and
 *   the principal on Cc only when `main` asks.
 * - Only `main` adds someone (`withAdded`). `external-email` may move the
 *   people already on the thread between To, Cc, and Bcc, or leave someone
 *   off (`arranged`), but never name anyone new. An arrangement holds for
 *   every send until the next message replaces the people.
 *
 * The audience check (KTD7) resolves every address a send reaches, Bcc
 * included, through `recipientsForThread`, and the adapter sends to the same
 * people, so the check sees exactly who the message reaches.
 */
import { getThread, uniqueAddresses, type ThreadPeople } from './db.js';
import { normalizeAddress, type ParsedMail } from './mime.js';

export type Placement = 'to' | 'cc';

/** Everyone a send to these people reaches, Bcc included, each once. */
export function everyone(people: ThreadPeople): string[] {
  return uniqueAddresses([...people.to, ...people.cc, ...people.bcc]);
}

/** The people on a message as a reply to all places them: From and To on To, Cc on Cc, never the assistant. */
export function peopleOnMessage(mail: ParsedMail, assistant: ReadonlySet<string>): ThreadPeople {
  const others = (addresses: readonly string[]) => uniqueAddresses(addresses).filter((a) => !assistant.has(a));
  const to = others([...(mail.from ? [mail.from.address] : []), ...mail.to.map((mailbox) => mailbox.address)]);
  const cc = others(mail.cc.map((mailbox) => mailbox.address)).filter((address) => !to.includes(address));
  return { to, cc, bcc: [] };
}

/** An address as given, normalized; throws for anything that is not one or is the assistant's. */
export function requireAddress(value: string, assistant: ReadonlySet<string>): string {
  const address = normalizeAddress(value);
  if (address === undefined) throw new Error(`Not an email address: ${JSON.stringify(value)}`);
  if (assistant.has(address)) throw new Error('The assistant is never one of its own recipients');
  return address;
}

/**
 * The thread's people as `wanted` places them. Only people already on the
 * thread may be placed, each once, and someone must be on To; anyone left out
 * is off the thread until a message or `main` puts them back.
 */
export function arranged(current: ThreadPeople, wanted: ThreadPeople, assistant: ReadonlySet<string>): ThreadPeople {
  const onThread = new Set(everyone(current));
  const seen = new Set<string>();
  const place = (values: readonly string[]): string[] =>
    values.map((value) => {
      const address = requireAddress(value, assistant);
      if (!onThread.has(address)) throw new Error(`${address} is not on the thread: only main adds someone new`);
      if (seen.has(address)) throw new Error(`${address} can be placed only once`);
      seen.add(address);
      return address;
    });
  const people = { to: place(wanted.to), cc: place(wanted.cc), bcc: place(wanted.bcc) };
  if (people.to.length === 0) throw new Error('A reply needs someone on To');
  return people;
}

/** The thread's people with `addresses` placed in `placement`; someone already there moves to it. */
export function withAdded(
  current: ThreadPeople,
  addresses: readonly string[],
  placement: Placement,
  assistant: ReadonlySet<string>,
): ThreadPeople {
  const added = uniqueAddresses(addresses.map((value) => requireAddress(value, assistant)));
  if (added.length === 0) throw new Error('Name at least one address to add');
  const moved = new Set(added);
  const kept = (values: readonly string[]) => values.filter((address) => !moved.has(address));
  return {
    to: placement === 'to' ? [...kept(current.to), ...added] : kept(current.to),
    cc: placement === 'cc' ? [...kept(current.cc), ...added] : kept(current.cc),
    bcc: kept(current.bcc),
  };
}

/** The people a send reaches: the thread's, never the assistant, whose Gmail address the host may learn late. */
export function sendPeople(people: ThreadPeople, assistant: ReadonlySet<string>): ThreadPeople {
  const others = (values: readonly string[]) => values.filter((address) => !assistant.has(address));
  return { to: others(people.to), cc: others(people.cc), bcc: others(people.bcc) };
}

/** The people a send in `threadKey` goes to; undefined for anything that is not an open inbox thread. */
export async function recipientsForThread(
  threadKey: string,
  assistant: ReadonlySet<string>,
): Promise<ThreadPeople | undefined> {
  const thread = await getThread(threadKey);
  if (!thread || (thread.state !== 'authorized' && thread.state !== 'open')) return undefined;
  return sendPeople(thread.people, assistant);
}
