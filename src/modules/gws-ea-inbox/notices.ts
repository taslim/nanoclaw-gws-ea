/**
 * The inbox's plain sentences to the principal. Each goes once, through
 * gws-ea-notices, to the principal's direct message only: an email set
 * aside, an inbox it cannot reach, and mail in their name Gmail could not
 * confirm is theirs.
 */
import { formatLocalTime } from '../../timezone.js';
import { sendPrincipalNotice } from '../gws-ea-notices/index.js';
import type { PrincipalRefusal } from './authentication.js';
import { domainOf, oneLine, type ParsedMail } from './mime.js';

const SET_ASIDE_NOTICE = "I couldn't process an email in my inbox, so I set it aside and kept going with the rest.";

const UNHEALTHY_NOTICE = "I can't reach my email inbox right now, so new email waits until it's back.";

/** Enough of a sender's name, or a subject, to recognize the email by. */
const SENDER_LIMIT = 60;
const SUBJECT_LIMIT = 80;

function short(text: string, limit: number): string {
  const characters = Array.from(oneLine(text));
  return characters.length <= limit
    ? characters.join('')
    : `${characters
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`;
}

/** The one email set aside, by who it says sent it and its subject, as written; otherwise "an email". */
function setAsideNotice(emails: readonly (Pick<ParsedMail, 'from' | 'subject'> | undefined)[]): string {
  const [email, ...more] = emails;
  if (email === undefined || more.length > 0 || email.from === undefined) return SET_ASIDE_NOTICE;
  const sender = short(email.from.displayName ?? '', SENDER_LIMIT) || email.from.address;
  const subject = short(email.subject, SUBJECT_LIMIT);
  if (subject === '') return SET_ASIDE_NOTICE;
  return `I couldn't process the email from ${sender} about "${subject}", so I set it aside and kept going with the rest.`;
}

/** One notice for however many messages one pass set aside, each as it was read, or undefined when it never was. */
export async function noticeSetAside(
  emails: readonly (Pick<ParsedMail, 'from' | 'subject'> | undefined)[],
): Promise<void> {
  await sendPrincipalNotice(setAsideNotice(emails), 'inbox-set-aside');
}

/** Once per unhealthy spell. */
export async function noticeUnhealthy(): Promise<void> {
  await sendPrincipalNotice(UNHEALTHY_NOTICE, 'inbox-unhealthy');
}

/** What the principal changes, if they sent the email, so Gmail can confirm their mail is theirs. */
function unsignedFix(reason: PrincipalRefusal, domain: string): string {
  switch (reason) {
    case 'no-own-dkim':
      return `your email provider needs to sign mail for ${domain} (DKIM) so I can tell it's yours.`;
    case 'no-dmarc':
      return `whoever runs email for ${domain} needs to publish a DMARC policy for it so I can tell it's yours.`;
    case 'sender-differs':
      return 'send it straight from that address rather than through a service that sends it for you.';
    case 'mailing-list':
      return 'send it to me straight from that address rather than through a mailing list.';
    case 'no-gmail-results':
      return 'send it to me straight from that address rather than forwarding it.';
    default: {
      const unreachable: never = reason;
      throw new Error(`Unknown refusal: ${String(unreachable)}`);
    }
  }
}

/**
 * An email showing one of the principal's addresses that Gmail could not
 * confirm is theirs: the address as they listed it, when Gmail received it,
 * and the fix if they sent it, never anything its sender wrote. Once per
 * address and reason, as the inbox records it. Returns whether it was
 * delivered.
 */
export async function noticeUnsignedMail(input: {
  readonly address: string;
  readonly reason: PrincipalRefusal;
  readonly receivedAt: Date;
  readonly timezone: string;
}): Promise<boolean> {
  const time = formatLocalTime(input.receivedAt.toISOString(), input.timezone);
  return sendPrincipalNotice(
    `An email I received on ${time} shows ${input.address} as the sender, but Gmail couldn't confirm it's from you, ` +
      "so I'm treating it like mail from someone I don't know. " +
      `If you sent it, ${unsignedFix(input.reason, domainOf(input.address))}`,
    'inbox-unsigned-mail',
  );
}
