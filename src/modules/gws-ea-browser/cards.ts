import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { writeBrowserNotice } from './notices.js';
import { requestWake } from '../../request-wake.js';
import { formatLocalTime, resolveTimezone } from '../../timezone.js';
import { detachApproval, finishApprovalWithdrawal } from '../approvals/index.js';
import type { PendingApproval } from '../../types.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import { bookedReservation, formatMoney, type PurchaseBounds, type PurchaseFacts } from './fingerprint.js';

export interface PurchaseCard {
  id: string;
  job_id: string;
  request_id: string;
  approval_id: string | null;
  approval_json: string | null;
  status: 'open' | 'approved' | 'rejected' | 'expired' | 'withdrawn' | 'superseded';
  facts_json: string;
  bounds_json: string;
  exception_ids_json: string;
  expires_at: string;
  created_at: string;
  notified_at: string | null;
}
/** Seller-controlled strings are visibly quoted and bounded individually. */
export function quotePurchaseText(text: string, limit = 360): string {
  const clean = Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  return JSON.stringify(clean.length > limit ? `${clean.slice(0, limit)}…` : clean);
}
/** A zone named as people say it: its city, or the zone's own short name at `at` when it has none. */
function zoneLabel(timeZone: string, at: string): string {
  const zone = resolveTimezone(timeZone);
  const city = /^(?!Etc\/)[A-Za-z]+\/(?:[^/]+\/)?([^/]+)$/u.exec(zone)?.[1];
  return city
    ? `${city.replaceAll('_', ' ')} time`
    : (new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(new Date(at))
        .find((part) => part.type === 'timeZoneName')?.value ?? zone);
}
/** A moment on the clock of `timeZone`, labelled with it. */
export function cardTime(at: string, timeZone: string): string {
  return `${formatLocalTime(at, timeZone)} ${zoneLabel(timeZone, at)}`;
}
function cardSpan(start: string, end: string, timeZone: string): string {
  const from = formatLocalTime(start, timeZone),
    to = formatLocalTime(end, timeZone);
  const day = from.slice(0, from.lastIndexOf(', ') + 2);
  return `${from} through ${to.startsWith(day) ? to.slice(day.length) : to} ${zoneLabel(timeZone, start)}`;
}
/**
 * An event's span on the venue's clock, where it happens, with the principal's equivalent
 * alongside when their clocks read differently: a 7 PM dinner in Tokyo never reads as 3 AM.
 */
export function cardEventSpan(start: string, end: string, venueTimeZone: string, principalTimeZone: string): string {
  const venue = cardSpan(start, end, venueTimeZone);
  const sameClock = [start, end].every(
    (at) => formatLocalTime(at, venueTimeZone) === formatLocalTime(at, principalTimeZone),
  );
  return sameClock ? venue : `${venue} (${cardSpan(start, end, principalTimeZone)})`;
}
/**
 * A moment on the venue's clock, where it happens, with the principal's equivalent alongside when their clocks
 * read differently.
 */
export function cardEventTime(at: string, venueTimeZone: string, principalTimeZone: string): string {
  const venue = cardTime(at, venueTimeZone);
  return formatLocalTime(at, venueTimeZone) === formatLocalTime(at, principalTimeZone)
    ? venue
    : `${venue} (${cardTime(at, principalTimeZone)})`;
}
/** An earlier purchase on the site main recorded as not placed, from the merchant's email or the principal (KTD9). */
export interface RecordedNotPlaced {
  readonly attemptedAt: string;
  readonly source: 'email' | 'principal';
}
/**
 * What a card says of earlier purchases on its site, never by id, which means nothing to the principal: how many
 * have no recorded outcome (the card's one-attempt exception), and each that main recorded as not placed since
 * the site's last card.
 */
export interface EarlierPurchases {
  readonly unresolved: number;
  readonly recordedNotPlaced: readonly RecordedNotPlaced[];
}
export const NO_EARLIER_PURCHASES: EarlierPurchases = { unresolved: 0, recordedNotPlaced: [] };
function earlierLines(earlier: EarlierPurchases, principalTimeZone: string): string[] {
  const lines = earlier.recordedNotPlaced.map(
    (recorded) =>
      `Earlier purchase here, tried ${cardTime(recorded.attemptedAt, principalTimeZone)}: I recorded it as not placed, from ${recorded.source === 'email' ? "the merchant's email" : 'what you told me'}.`,
  );
  if (!earlier.unresolved) return lines;
  const count =
    earlier.unresolved > 1
      ? `${earlier.unresolved} earlier purchases on this site have`
      : 'An earlier purchase on this site has';
  return [
    ...lines,
    `Possible duplicate: ${count} no recorded outcome. Approving permits exactly one new attempt and may buy the same thing twice.`,
  ];
}
/** Who the card shows for the assistant's web address: the principal knows it as their assistant's. */
export interface CardIdentity {
  readonly alias?: string | null;
}
/** Whether `address` is the assistant's own web address. */
function isAssistantAddress(address: string, identity: CardIdentity): boolean {
  return (
    Boolean(identity.alias) && identityMatchKey(`email:${address}`) === identityMatchKey(`email:${identity.alias}`)
  );
}
/** The terms a card lists, each with its amounts, trigger and dates. */
function termLines(
  facts: PurchaseFacts,
  partySize: number | undefined,
  money: (amount: number) => string,
  principalTimeZone: string,
): string[] {
  const lines: string[] = [];
  for (const term of facts.commitments) {
    lines.push(`Financial commitment: ${term.kind}; ${quotePurchaseText(term.terms, 700)}`);
    if (term.amountMinor !== undefined)
      lines.push(
        `Amount due later/exposure: ${money(term.amountMinor)}${term.perPerson ? ` per person × ${partySize ?? 'unknown party size'}` : ' total'}`,
      );
    if (term.trigger) lines.push(`Trigger: ${quotePurchaseText(term.trigger)}`);
    if (term.cancellationDeadline)
      lines.push(`Cancellation deadline: ${cardTime(term.cancellationDeadline, principalTimeZone)}`);
    if (term.cancellationTerms) lines.push(`Cancellation terms: ${quotePurchaseText(term.cancellationTerms, 700)}`);
    if (term.conversionAt) lines.push(`Trial conversion: ${cardTime(term.conversionAt, principalTimeZone)}`);
    if (term.frequency) lines.push(`Recurring frequency: ${quotePurchaseText(term.frequency)}`);
  }
  return lines;
}
/**
 * An unreviewed checkout's card (KTD5, R8): the site and any payment platform, the account or that it is a guest
 * checkout, the items quoted as shown, the money, the saved payment method, the contact email and any note.
 * The assistant's own web address reads as the assistant's; no internal id appears.
 */
function renderGenericCard(
  facts: PurchaseFacts,
  earlier: EarlierPurchases,
  principalTimeZone: string,
  change: string | undefined,
  identity: CardIdentity,
): string {
  const generic = facts.generic;
  if (!generic) throw new Error('A generic card needs the generic facts');
  const money = (amount: number): string => formatMoney(amount, facts.currency);
  const assistant = (address: string): boolean => isAssistantAddress(address, identity);
  const booking = generic.booking;
  const lines = [
    "I'd like to place this purchase using the facts I read from the checkout.",
    ...(change ? [change] : []),
    ...earlierLines(earlier, principalTimeZone),
    `Site: ${facts.site}`,
    ...(generic.platform ? [`Checkout on: ${generic.platform} (for ${facts.site})`] : []),
    `Account: ${generic.guest ? 'guest checkout' : assistant(facts.account) ? "your assistant's account" : quotePurchaseText(facts.account)}`,
    `Contact email: ${assistant(generic.contactEmail) ? "your assistant's email" : quotePurchaseText(generic.contactEmail)}`,
    ...generic.items.map((item) => `Item: ${quotePurchaseText(item)}`),
    `Total: ${money(facts.totalMinor)} (${facts.currency})`,
    `Due now: ${money(facts.dueNowMinor)}`,
    `Payment: ${quotePurchaseText(generic.payment)}`,
    ...(generic.note ? [`Note: ${quotePurchaseText(generic.note, 700)}`] : []),
    ...(booking?.venue ? [`Venue: ${quotePurchaseText(booking.venue)}`] : []),
    ...(booking?.partySize !== undefined ? [`Party size: ${booking.partySize}`] : []),
    ...(booking?.at && booking.timeZone
      ? [`Time: ${cardEventTime(booking.at, booking.timeZone, principalTimeZone)}`]
      : booking?.timeText
        ? [`Time as the page shows it: ${quotePurchaseText(booking.timeText)}`]
        : []),
    ...(facts.addOns ?? []).map((addOn) => `Extra charge the site keeps selected: ${quotePurchaseText(addOn)}`),
    ...(facts.agreements ?? []).map(
      (agreement) =>
        `Agreement: ${quotePurchaseText(agreement.wording, 2000)}. Approving agrees to it, here and whenever this exact wording appears on ${facts.site} again, until you withdraw it.`,
    ),
    ...termLines(facts, bookedReservation(facts)?.partySize ?? booking?.partySize, money, principalTimeZone),
  ];
  if (!facts.commitments.length)
    lines.push('Due later: none shown. The checkout states no hold, deposit, fee, trial or subscription.');
  return lines.join('\n');
}
/** Deadlines, charge dates and conversions read on the principal's clock; events on the venue's. */
export function renderPurchaseCard(
  facts: PurchaseFacts,
  bounds: PurchaseBounds,
  earlier: EarlierPurchases,
  principalTimeZone: string,
  change?: string,
  identity: CardIdentity = {},
): string {
  if (facts.generic) return renderGenericCard(facts, earlier, principalTimeZone, change, identity);
  const money = (amount: number): string => formatMoney(amount, facts.currency);
  const lines = [
    "I'd like to place this purchase using the facts I read from the merchant's review page.",
    ...(change ? [change] : []),
    ...earlierLines(earlier, principalTimeZone),
    `Site: ${quotePurchaseText(facts.origin)}`,
    `Account: ${isAssistantAddress(facts.account, identity) ? "your assistant's account" : quotePurchaseText(facts.account)}`,
    `Commit control: ${quotePurchaseText(facts.control.label)}`,
    ...facts.items.map(
      (item) =>
        `Item: ${quotePurchaseText(item.title)}; quantity ${item.quantity}; merchant id ${quotePurchaseText(item.id)}`,
    ),
    `Total: ${money(facts.totalMinor)} (${facts.currency})`,
    `Due now: ${money(facts.dueNowMinor)}`,
    ...(facts.reservation
      ? [
          `Venue: ${quotePurchaseText(facts.reservation.venueName)}; merchant id ${quotePurchaseText(facts.reservation.venueId)}`,
          `Party size: ${facts.reservation.partySize}`,
          `Reservation time: ${cardEventSpan(facts.reservation.at, facts.reservation.endAt, facts.reservation.timeZone, principalTimeZone)}`,
        ]
      : []),
    facts.cardEnding === null ? 'Payment card: not required' : `Card ending: ${facts.cardEnding}`,
    facts.address === null ? 'Address: not applicable' : `Address: ${quotePurchaseText(facts.address)}`,
    `Delivery: ${facts.delivery ? quotePurchaseText(facts.delivery.text) : 'Not applicable'}`,
    ...(bounds.deliveryWindow
      ? [
          `Approved delivery window: ${quotePurchaseText(bounds.deliveryWindow.start)} through ${quotePurchaseText(bounds.deliveryWindow.end)}`,
        ]
      : []),
    ...(bounds.neededBy ? [`Needed by: ${cardTime(bounds.neededBy, principalTimeZone)}`] : []),
    ...(facts.addOns ?? []).map((addOn) => `Extra charge the site keeps selected: ${quotePurchaseText(addOn)}`),
    ...(facts.agreements ?? []).map(
      (agreement) =>
        `Agreement: ${quotePurchaseText(agreement.wording, 2000)}. Approving agrees to it, here and whenever this exact wording appears on ${facts.site} again, until you withdraw it.`,
    ),
    ...termLines(facts, facts.reservation?.partySize, money, principalTimeZone),
  ];
  if (facts.noCommitmentTerms)
    lines.push(`No financial commitment: ${quotePurchaseText(facts.noCommitmentTerms, 1200)}`);
  if (facts.commitments.length && facts.commitments.every((term) => term.kind === 'retail'))
    lines.push('Due later: none. One-time retail purchase; no hold, deposit, conditional fee, trial or subscription.');
  return lines.join('\n');
}

/** DB-only half. Includes cards whose approval id is still being returned by delivery. */
export async function detachPurchaseCards(jobId: string, reason: PurchaseCard['status']): Promise<PendingApproval[]> {
  const db = getDb();
  const cards = await db.all<PurchaseCard>(
    "SELECT * FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND (status = 'open' OR (status = 'approved' AND EXISTS (SELECT 1 FROM gws_ea_browser_authorities WHERE card_id = gws_ea_browser_purchase_cards.id AND state = 'live')))",
    jobId,
  );
  const detached: PendingApproval[] = [];
  for (const card of cards) {
    // During adapter.deliver the late approval_id link can still be null. Payload identifies this pre-existing card.
    const approvals = await db.all<PendingApproval>(
      "SELECT * FROM pending_approvals WHERE action = 'browser_purchase' AND session_id = (SELECT browser_session_id FROM gws_ea_browser_jobs WHERE id = ?)",
      jobId,
    );
    let found = false;
    for (const approval of approvals) {
      const payload = JSON.parse(approval.payload) as { cardId?: string };
      if (payload.cardId === card.id) {
        const row = await detachApproval(approval.approval_id);
        if (row) {
          detached.push(row);
          found = true;
        }
      }
    }
    if (!found && card.approval_json) detached.push(JSON.parse(card.approval_json) as PendingApproval);
    await db.run('UPDATE gws_ea_browser_purchase_cards SET status = ? WHERE id = ?', reason, card.id);
  }
  await db.run("UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE job_id = ? AND state = 'live'", jobId);
  await db.run(
    "DELETE FROM gws_ea_browser_pending_commits WHERE authority_id IN (SELECT id FROM gws_ea_browser_authorities WHERE job_id = ? AND state = 'revoked')",
    jobId,
  );
  return detached;
}
export async function finishPurchaseCardWithdrawals(cards: readonly PendingApproval[], message: string): Promise<void> {
  for (const card of cards) await finishApprovalWithdrawal(card, message);
}
export async function notifyPurchaseCard(cardId: string, outcome: string): Promise<void> {
  const db = getDb();
  const card = await db.get<PurchaseCard>('SELECT * FROM gws_ea_browser_purchase_cards WHERE id = ?', cardId);
  if (!card || card.notified_at) return;
  const job = await db.get<{ browser_session_id: string }>(
    'SELECT browser_session_id FROM gws_ea_browser_jobs WHERE id = ?',
    card.job_id,
  );
  const session = job ? await getSession(job.browser_session_id) : undefined;
  if (!session) return;
  try {
    await writeBrowserNotice(
      session,
      `browser-card-${card.id}-${outcome}`,
      JSON.stringify({
        type: 'browser_purchase_outcome',
        job: card.job_id,
        card_id: card.id,
        status: outcome,
        ...(outcome === 'rejected'
          ? { message: 'The principal declined. Remove the cart items you added; do not try another purchase path.' }
          : {}),
      }),
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  await db.run(
    'UPDATE gws_ea_browser_purchase_cards SET notified_at = ? WHERE id = ?',
    new Date().toISOString(),
    card.id,
  );
  void requestWake(session, 'browser-purchase-card').catch(() => undefined);
}
