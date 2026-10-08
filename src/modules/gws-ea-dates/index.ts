/**
 * GWS-EA's outgoing date check: nothing the assistant sends says a weekday
 * beside a date it does not fall on (`weekday-check.ts`).
 *
 * - An outbound guard at the delivery adapter reads every send before the
 *   channel does: main's replies to the principal in Chat or email,
 *   external-email's emails and `email_send`, cards, and host notices. A
 *   refused reply is never delivered, and its agent is told why and woken to
 *   send it again; a refused `email_send` fails the tool with the reason.
 *   The quote an email reply carries is added after the guard, so only the
 *   assistant's own words are read.
 * - `weekdayRefusal` gives the same check to writes that never pass a
 *   channel: the text of an invitation the assistant writes.
 *
 * A date without a year is read from today on the principal's clock. The
 * refusal names the pair and the weekday each reading falls on, so the
 * agent can correct it in one step.
 */
import { registerOutboundGuard, type OutboundGuardDecision, type OutboundSend } from '../../delivery.js';
import { weekdayRefusal } from './refusal.js';

export { weekdayRefusal } from './refusal.js';

export const WEEKDAY_GUARD_ID = 'gws-ea-dates:weekday';

/** Every string in the serialized message, in order, whatever its shape. */
function stringsOf(value: unknown, into: string[]): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, into);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) stringsOf(item, into);
  return into;
}

function parsed(content: string): unknown {
  /* eslint-disable no-catch-all/no-catch-all -- content that is not JSON is read as the plain text it is */
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** The outbound guard: refuses a send whose words pair a weekday with a date it does not fall on. Files are not read. */
export async function judgeDates(send: OutboundSend): Promise<OutboundGuardDecision> {
  const reason = await weekdayRefusal(stringsOf(parsed(send.content), []));
  return reason === undefined ? { effect: 'allow' } : { effect: 'refuse', reason };
}

registerOutboundGuard(WEEKDAY_GUARD_ID, judgeDates);
