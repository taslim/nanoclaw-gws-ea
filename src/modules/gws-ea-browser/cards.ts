import { MAX_CARD_QUESTION_LENGTH } from '../../channels/ask-question.js';
import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { writeBrowserNotice } from './notices.js';
import { requestWake } from '../../request-wake.js';
import { formatLocalTime, formatLocalTimeWithZone, timeZoneLabel } from '../../timezone.js';
import { detachApproval, finishApprovalWithdrawal } from '../approvals/index.js';
import type { PendingApproval } from '../../types.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import {
  bookedReservation,
  currencyExponent,
  formatMoney,
  hasPurchaseDueNow,
  hasPurchaseTotal,
  type PurchaseBounds,
  type PurchaseFacts,
} from './fingerprint.js';
import { quoted } from '../approvals/request-text.js';
import { purchaseCardTitle } from './purchase-wording.js';
import type { PrincipalClock } from './watch-policy.js';

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
/**
 * Where a browser errand's card (purchase, consent or watch) says it comes from: the errand, in words the
 * principal knows, never its internal thread.
 */
export const ERRAND_ORIGIN_LINE = "From a website errand I'm working on for you.";
/** The longest seller-controlled string a card quotes without a bound of its own; each is quoted (`quoted`). */
export const SELLER_TEXT_LIMIT = 360;

/**
 * Character budget left for a browser approval card's question body so
 * `title.length + question.length + originLine <= MAX_CARD_QUESTION_LENGTH`.
 */
export function browserCardBudget(title: string, originLine = ERRAND_ORIGIN_LINE): number {
  return Math.max(0, MAX_CARD_QUESTION_LENGTH - title.length - (originLine ? originLine.length + 2 : 0));
}

/**
 * Quote untrusted text with `quoted` while guaranteeing the final escaped
 * string (including surrounding quotes and any `\uXXXX` escapes) fits within
 * `maxLength` characters.
 */
export function fitQuoted(text: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (maxLength <= 2) return '""'.slice(0, maxLength);
  const direct = quoted(text, maxLength);
  if (direct.length <= maxLength) return direct;
  let lo = 1;
  let hi = maxLength;
  let best = '""';
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = quoted(text, mid);
    if (candidate.length <= maxLength) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Last-resort clamp that preserves whole UTF-16 code points when even minimal caps exceed the card budget. */
export function clampBrowserCardText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, Math.max(0, maxLength));
  const cut = text.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/u, '');
  return `${cut}…`;
}

interface PurchaseCardCaps {
  readonly quote: (text: string, limit: number) => string;
  readonly seller: number;
  readonly note: number;
  readonly term: number;
  readonly agreement: number;
  readonly noCommitment: number;
  readonly maxItems: number;
  readonly maxAddOns: number;
  readonly maxAgreements: number;
  readonly maxCommitments: number;
  readonly maxRecorded: number;
  readonly maxEmails: number;
}

const PURCHASE_CARD_PROFILES: readonly PurchaseCardCaps[] = [
  {
    quote: quoted,
    seller: SELLER_TEXT_LIMIT,
    note: 700,
    term: 700,
    agreement: 2000,
    noCommitment: 1200,
    maxItems: Infinity,
    maxAddOns: Infinity,
    maxAgreements: Infinity,
    maxCommitments: Infinity,
    maxRecorded: Infinity,
    maxEmails: Infinity,
  },
  {
    quote: fitQuoted,
    seller: 240,
    note: 240,
    term: 240,
    agreement: 400,
    noCommitment: 360,
    maxItems: 6,
    maxAddOns: 4,
    maxAgreements: 3,
    maxCommitments: 4,
    maxRecorded: 3,
    maxEmails: 4,
  },
  {
    quote: fitQuoted,
    seller: 140,
    note: 120,
    term: 140,
    agreement: 200,
    noCommitment: 180,
    maxItems: 3,
    maxAddOns: 2,
    maxAgreements: 2,
    maxCommitments: 2,
    maxRecorded: 1,
    maxEmails: 2,
  },
  {
    quote: fitQuoted,
    seller: 72,
    note: 72,
    term: 72,
    agreement: 100,
    noCommitment: 100,
    maxItems: 2,
    maxAddOns: 1,
    maxAgreements: 1,
    maxCommitments: 2,
    maxRecorded: 1,
    maxEmails: 1,
  },
  {
    quote: fitQuoted,
    seller: 36,
    note: 36,
    term: 36,
    agreement: 48,
    noCommitment: 48,
    maxItems: 1,
    maxAddOns: 1,
    maxAgreements: 1,
    maxCommitments: 1,
    maxRecorded: 0,
    maxEmails: 1,
  },
];

function fitCardProfiles(budget: number, render: (caps: PurchaseCardCaps) => string): string {
  let rendered = '';
  for (const profile of PURCHASE_CARD_PROFILES) {
    rendered = render(profile);
    if (rendered.length <= budget) return rendered;
  }
  return clampBrowserCardText(rendered, budget);
}
function cardSpan(start: string, end: string, startZone: string, endZone: string): string {
  if (startZone !== endZone)
    return `${formatLocalTimeWithZone(start, startZone)} through ${formatLocalTimeWithZone(end, endZone)}`;
  const from = formatLocalTime(start, startZone),
    to = formatLocalTime(end, endZone);
  const day = from.slice(0, from.lastIndexOf(', ') + 2);
  return `${from} through ${to.startsWith(day) ? to.slice(day.length) : to} ${timeZoneLabel(startZone, start)}`;
}
/**
 * An event's span on the venue's clock, where it happens, with the principal's equivalent
 * alongside when their clocks read differently: a 7 PM dinner in Tokyo never reads as 3 AM.
 */
export function cardEventSpan(start: string, end: string, venueTimeZone: string, clock: PrincipalClock): string {
  const venue = cardSpan(start, end, venueTimeZone, venueTimeZone);
  const sameClock = [start, end].every((at) => formatLocalTime(at, venueTimeZone) === formatLocalTime(at, clock(at)));
  return sameClock ? venue : `${venue} (${cardSpan(start, end, clock(start), clock(end))})`;
}
/**
 * A moment on the venue's clock, where it happens, with the principal's equivalent alongside when their clocks
 * read differently.
 */
export function cardEventTime(at: string, venueTimeZone: string, clock: PrincipalClock): string {
  const principalTimeZone = clock(at);
  const venue = formatLocalTimeWithZone(at, venueTimeZone);
  return formatLocalTime(at, venueTimeZone) === formatLocalTime(at, principalTimeZone)
    ? venue
    : `${venue} (${formatLocalTimeWithZone(at, principalTimeZone)})`;
}
/** An earlier purchase on the site recorded as not placed, from the merchant's email or the principal. */
export interface RecordedNotPlaced {
  readonly attemptedAt: string;
  readonly source: 'email' | 'principal';
}
/**
 * What a card says of earlier purchases on its site, never by id, which means nothing to the principal: how many
 * have no recorded outcome (the card's one-attempt exception), and each recorded as not placed since the site's
 * last card.
 */
export interface EarlierPurchases {
  readonly unresolved: number;
  readonly recordedNotPlaced: readonly RecordedNotPlaced[];
}
export const NO_EARLIER_PURCHASES: EarlierPurchases = { unresolved: 0, recordedNotPlaced: [] };
function earlierLines(earlier: EarlierPurchases, clock: PrincipalClock, maxRecorded: number): string[] {
  const shown =
    earlier.recordedNotPlaced.length > maxRecorded
      ? earlier.recordedNotPlaced.slice(earlier.recordedNotPlaced.length - maxRecorded)
      : earlier.recordedNotPlaced;
  const omitted = earlier.recordedNotPlaced.length - shown.length;
  const lines = shown.map(
    (recorded) =>
      `Earlier purchase here, tried ${formatLocalTimeWithZone(recorded.attemptedAt, clock(recorded.attemptedAt))}: I recorded it as not placed, from ${recorded.source === 'email' ? "the merchant's email" : 'what you told me'}.`,
  );
  if (omitted > 0) {
    lines.unshift(
      `Earlier not-placed attempts on this site: ${omitted} older ${omitted === 1 ? 'record' : 'records'} omitted.`,
    );
  }
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
function isAssistantAddress(address: string, identity: CardIdentity): boolean {
  return (
    Boolean(identity.alias) && identityMatchKey(`email:${address}`) === identityMatchKey(`email:${identity.alias}`)
  );
}
function termLines(
  facts: PurchaseFacts,
  partySize: number | undefined,
  money: ((amount: number) => string) | undefined,
  clock: PrincipalClock,
  caps: PurchaseCardCaps,
): string[] {
  const lines: string[] = [];
  const shown = facts.commitments.slice(0, caps.maxCommitments);
  for (const term of shown) {
    lines.push(`Financial commitment: ${term.kind}; ${caps.quote(term.terms, caps.term)}`);
    if (term.amountMinor !== undefined && money)
      lines.push(
        `Amount due later/exposure: ${money(term.amountMinor)}${term.perPerson ? ` per person × ${partySize ?? 'unknown party size'}` : ' total'}`,
      );
    if (term.trigger) lines.push(`Trigger: ${caps.quote(term.trigger, caps.seller)}`);
    if (term.cancellationDeadline)
      lines.push(
        `Cancellation deadline: ${formatLocalTimeWithZone(term.cancellationDeadline, clock(term.cancellationDeadline))}`,
      );
    if (term.cancellationTerms) lines.push(`Cancellation terms: ${caps.quote(term.cancellationTerms, caps.term)}`);
    if (term.conversionAt)
      lines.push(`Trial conversion: ${formatLocalTimeWithZone(term.conversionAt, clock(term.conversionAt))}`);
    if (term.frequency) lines.push(`Recurring frequency: ${caps.quote(term.frequency, caps.seller)}`);
  }
  const omitted = facts.commitments.length - shown.length;
  if (omitted > 0) {
    lines.push(
      `More financial commitments: ${omitted} additional ${omitted === 1 ? 'commitment' : 'commitments'} on this checkout.`,
    );
  }
  return lines;
}
function choiceLines(facts: PurchaseFacts, caps: PurchaseCardCaps): string[] {
  const addOns = facts.addOns ?? [];
  const shownAddOns = addOns.slice(0, caps.maxAddOns);
  const omittedAddOns = addOns.length - shownAddOns.length;
  const agreements = facts.agreements ?? [];
  const shownAgreements = agreements.slice(0, caps.maxAgreements);
  const omittedAgreements = agreements.length - shownAgreements.length;
  return [
    ...shownAddOns.map((addOn) => `Extra charge the site keeps selected: ${caps.quote(addOn, caps.seller)}`),
    ...(omittedAddOns > 0
      ? [
          `More extra charges: ${omittedAddOns} additional extra ${omittedAddOns === 1 ? 'charge' : 'charges'} selected.`,
        ]
      : []),
    ...shownAgreements.map(
      (agreement) =>
        `Agreement: ${caps.quote(agreement.wording, caps.agreement)}. Approving agrees to it, here and whenever this exact wording appears on ${facts.site} again, until you withdraw it.`,
    ),
    ...(omittedAgreements > 0
      ? [
          `More agreements: ${omittedAgreements} additional site ${omittedAgreements === 1 ? 'agreement' : 'agreements'} on this checkout.`,
        ]
      : []),
  ];
}
/** An unreviewed checkout's card. The assistant's own web address reads as the assistant's; no internal id appears. */
function renderGenericCard(
  facts: PurchaseFacts,
  earlier: EarlierPurchases,
  clock: PrincipalClock,
  change: string | undefined,
  identity: CardIdentity,
  budget: number,
): string {
  const generic = facts.generic;
  if (!generic) throw new Error('A generic card needs the generic facts');
  const review = generic.review;
  const hasCurrency = currencyExponent(facts.currency) !== undefined;
  const money = hasCurrency ? (amount: number): string => formatMoney(amount, facts.currency) : undefined;
  const hasTotal = hasPurchaseTotal(facts);
  const hasDueNow = hasPurchaseDueNow(facts);
  const assistant = (address: string): boolean => isAssistantAddress(address, identity);
  const booking = generic.booking;
  return fitCardProfiles(budget, (caps) => {
    const accountText = generic.guest
      ? 'guest checkout'
      : assistant(facts.account)
        ? "your assistant's account"
        : review?.missing.includes('the account the purchase signs in with')
          ? facts.account
          : caps.quote(facts.account, caps.seller);
    const shownItems = generic.items.slice(0, caps.maxItems);
    const omittedItems = generic.items.length - shownItems.length;
    const shownEmails = review?.contactEmails ? review.contactEmails.slice(0, caps.maxEmails) : [];
    const omittedEmails = (review?.contactEmails?.length ?? 0) - shownEmails.length;
    const lines = [
      review
        ? "I'd like to place this purchase, but I couldn't read every detail automatically. Check the attached screenshot before approving."
        : "I'd like to place this purchase using the facts I read from the checkout.",
      ...(change ? [change] : []),
      ...earlierLines(earlier, clock, caps.maxRecorded),
      `Site: ${facts.site}`,
      ...(generic.platform ? [`Checkout on: ${generic.platform} (for ${facts.site})`] : []),
      ...(review ? [`Button I'll press: ${caps.quote(facts.control.label, caps.seller)}`] : []),
      `Account: ${accountText}`,
      ...(generic.contactEmail
        ? [
            `Contact email: ${assistant(generic.contactEmail) ? "your assistant's email" : caps.quote(generic.contactEmail, caps.seller)}`,
          ]
        : shownEmails.length
          ? [
              `Contact emails shown: ${shownEmails
                .map((address) => (assistant(address) ? "your assistant's email" : caps.quote(address, caps.seller)))
                .join(', ')}${omittedEmails > 0 ? ` (+${omittedEmails} more)` : ''}`,
            ]
          : []),
      ...shownItems.map((item) => `Item: ${caps.quote(item, caps.seller)}`),
      ...(omittedItems > 0
        ? [`More items: ${omittedItems} additional ${omittedItems === 1 ? 'item' : 'items'} in this checkout.`]
        : []),
      ...(hasTotal && money ? [`Total: ${money(facts.totalMinor)} (${facts.currency})`] : []),
      ...(hasDueNow && money ? [`Due now: ${money(facts.dueNowMinor)}`] : []),
      ...(generic.payment ? [`Payment: ${caps.quote(generic.payment, caps.seller)}`] : []),
      ...(generic.note ? [`Note: ${caps.quote(generic.note, caps.note)}`] : []),
      ...(booking?.venue ? [`Venue: ${caps.quote(booking.venue, caps.seller)}`] : []),
      ...(booking?.partySize !== undefined ? [`Party size: ${booking.partySize}`] : []),
      ...(booking?.at && booking.timeZone
        ? [`Time: ${cardEventTime(booking.at, booking.timeZone, clock)}`]
        : booking?.timeText
          ? [`Time as the page shows it: ${caps.quote(booking.timeText, caps.seller)}`]
          : []),
      ...choiceLines(facts, caps),
      ...termLines(facts, bookedReservation(facts)?.partySize ?? booking?.partySize, money, clock, caps),
      ...(review ? [`Could not verify automatically: ${review.missing.join(', ')}.`] : []),
    ];
    if (!review && !facts.commitments.length)
      lines.push('Due later: none shown. The checkout states no hold, deposit, fee, trial or subscription.');
    return lines.join('\n');
  });
}
/** Deadlines, charge dates and conversions read on the principal's clock; events on the venue's. */
export function renderPurchaseCard(
  facts: PurchaseFacts,
  bounds: PurchaseBounds,
  earlier: EarlierPurchases,
  clock: PrincipalClock,
  change?: string,
  identity: CardIdentity = {},
): string {
  const budget = browserCardBudget(purchaseCardTitle());
  if (facts.generic) return renderGenericCard(facts, earlier, clock, change, identity, budget);
  const money = (amount: number): string => formatMoney(amount, facts.currency);
  return fitCardProfiles(budget, (caps) => {
    const shownItems = facts.items.slice(0, caps.maxItems);
    const omittedItems = facts.items.length - shownItems.length;
    const lines = [
      "I'd like to place this purchase using the facts I read from the merchant's review page.",
      ...(change ? [change] : []),
      ...earlierLines(earlier, clock, caps.maxRecorded),
      `Site: ${caps.quote(facts.origin, caps.seller)}`,
      `Account: ${isAssistantAddress(facts.account, identity) ? "your assistant's account" : caps.quote(facts.account, caps.seller)}`,
      `Button I'll press: ${caps.quote(facts.control.label, caps.seller)}`,
      ...shownItems.map((item) => `Item: ${caps.quote(item.title, caps.seller)}; quantity ${item.quantity}`),
      ...(omittedItems > 0
        ? [`More items: ${omittedItems} additional ${omittedItems === 1 ? 'item' : 'items'} in this checkout.`]
        : []),
      `Total: ${money(facts.totalMinor)} (${facts.currency})`,
      `Due now: ${money(facts.dueNowMinor)}`,
      ...(facts.reservation
        ? [
            `Venue: ${caps.quote(facts.reservation.venueName, caps.seller)}`,
            `Party size: ${facts.reservation.partySize}`,
            `Reservation time: ${cardEventSpan(facts.reservation.at, facts.reservation.endAt, facts.reservation.timeZone, clock)}`,
          ]
        : []),
      facts.cardEnding === null ? 'Payment card: not required' : `Card ending: ${facts.cardEnding}`,
      facts.address === null ? 'Address: not applicable' : `Address: ${caps.quote(facts.address, caps.seller)}`,
      `Delivery: ${facts.delivery ? caps.quote(facts.delivery.text, caps.seller) : 'Not applicable'}`,
      ...(bounds.deliveryWindow
        ? [
            `Approved delivery window: ${caps.quote(bounds.deliveryWindow.start, caps.seller)} through ${caps.quote(bounds.deliveryWindow.end, caps.seller)}`,
          ]
        : []),
      ...(bounds.neededBy ? [`Needed by: ${formatLocalTimeWithZone(bounds.neededBy, clock(bounds.neededBy))}`] : []),
      ...choiceLines(facts, caps),
      ...termLines(facts, facts.reservation?.partySize, money, clock, caps),
    ];
    if (facts.noCommitmentTerms)
      lines.push(`No financial commitment: ${caps.quote(facts.noCommitmentTerms, caps.noCommitment)}`);
    if (facts.commitments.length && facts.commitments.every((term) => term.kind === 'retail'))
      lines.push(
        'Due later: none. One-time retail purchase; no hold, deposit, conditional fee, trial or subscription.',
      );
    return lines.join('\n');
  });
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
export async function notifyPurchaseCard(cardId: string, outcome: string, reason?: string): Promise<void> {
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
          ? {
              message: `The principal declined${reason ? `: "${reason}"` : ''}. Remove the cart items you added; do not try another purchase path.`,
            }
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
