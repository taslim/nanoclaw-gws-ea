/**
 * GWS-EA's outgoing date check: nothing the assistant sends says a weekday
 * beside a date it does not fall on (`weekday-check.ts`).
 *
 * - An outbound guard reads every send through the delivery adapter,
 *   `email_send` included, before the channel does. A refused reply is never
 *   delivered, and its agent is told why and woken to send it again; a
 *   refused `email_send` fails the tool with the reason. The quote an email
 *   reply carries is added after the guard, so only the assistant's own words
 *   are read.
 * - `weekdayRefusal` gives the same check to writes that never pass a
 *   channel, such as the text of an invitation the assistant writes.
 *
 * A date without a year is read from today on the principal's clock. The
 * refusal names the pair and the weekday each reading falls on, so the
 * agent can correct it in one step.
 */
import { registerOutboundGuard, type OutboundGuardDecision, type OutboundSend } from '../../delivery.js';
import '../gws-ea-whereabouts/index.js';
import { messageStrings } from '../gws-ea-privacy/index.js';
import { weekdayRefusal } from './refusal.js';

export { weekdayRefusal } from './refusal.js';

export const WEEKDAY_GUARD_ID = 'gws-ea-dates:weekday';

/** Reads the message's words only; attached files are not read. */
export async function judgeDates(send: OutboundSend): Promise<OutboundGuardDecision> {
  const reason = await weekdayRefusal(messageStrings(send.content));
  return reason === undefined ? { effect: 'allow' } : { effect: 'refuse', reason };
}

registerOutboundGuard(WEEKDAY_GUARD_ID, judgeDates);
