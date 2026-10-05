/**
 * Who an email to a thread's outside side goes to (KTD5, R68).
 *
 * - A reply goes to everyone on the message it answers, placed the way a
 *   person replying to all would place them: its From and To on To, its Cc
 *   on Cc, and the assistant on neither (`replyAll`). A Reply-To is never
 *   read. When the message it answers is the assistant's own, that is its To
 *   and Cc.
 * - `external-email` may trim them or name others by judgment, but every
 *   recipient must be one of the thread's addresses: on one of its messages,
 *   or named by `main` (`threadRecipients`, the recipient guard). That one
 *   rule lets it loop in someone a participant put on the thread, who could
 *   have forwarded it to them anyway, and keeps it from writing to anyone
 *   new: only `main` brings someone in.
 */
import { OutboundRefusedError } from '../../delivery.js';
import type { ParsedMail } from './mime.js';
import { threadAddresses } from './thread-map.js';

const REFUSED_BY = 'gws-ea-inbox:recipients';

/** An email's recipients, each address once. */
export interface Recipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
}

/** Everyone on a message, as a reply to all places them. */
export function replyAll(mail: ParsedMail, assistant: ReadonlySet<string>): Recipients {
  const others = (addresses: readonly string[]) => [...new Set(addresses)].filter((a) => !assistant.has(a));
  const to = others([...(mail.from ? [mail.from.address] : []), ...mail.to.map((mailbox) => mailbox.address)]);
  const cc = others(mail.cc.map((mailbox) => mailbox.address)).filter((address) => !to.includes(address));
  return { to, cc };
}

/**
 * The recipient guard: the recipients as sent, each once where it is first
 * placed. Refuses the assistant, anyone the thread never had, and an email
 * with no one on To.
 */
export async function threadRecipients(
  threadKey: string,
  wanted: Recipients,
  assistant: ReadonlySet<string>,
): Promise<Recipients> {
  const known = new Set((await threadAddresses(threadKey)).map((entry) => entry.address));
  const to = [...new Set(wanted.to)];
  const cc = [...new Set(wanted.cc)].filter((address) => !to.includes(address));
  for (const address of [...to, ...cc]) {
    if (assistant.has(address)) {
      throw new OutboundRefusedError(REFUSED_BY, 'The assistant is never one of its own recipients.');
    }
    if (!known.has(address)) {
      throw new OutboundRefusedError(
        REFUSED_BY,
        `${address} has not been on this thread, and main did not name them: only main brings someone new in.`,
      );
    }
  }
  if (to.length === 0) throw new OutboundRefusedError(REFUSED_BY, 'An email needs someone on To.');
  return { to, cc };
}
