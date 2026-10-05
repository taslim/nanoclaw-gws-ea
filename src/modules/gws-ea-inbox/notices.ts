/**
 * The inbox's plain sentences to the principal. Each goes once, through
 * gws-ea-notices, to the principal's direct message only.
 */
import { sendPrincipalNotice } from '../gws-ea-notices/index.js';
import { oneLine, type ParsedMail } from './mime.js';

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
