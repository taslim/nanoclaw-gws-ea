import { zonedInstant } from './iso-time.js';
import type { StructuredBrowserLocator } from './locators.js';

/** The generic signature's flow (KTD4): any checkout no reviewed signature reads. */
export const GENERIC_FLOW_ID = 'generic-checkout-v1';

export interface FinancialCommitment {
  kind: 'retail' | 'hold' | 'deposit' | 'prepayment' | 'conditional_fee' | 'trial' | 'subscription';
  terms: string;
  amountMinor?: number;
  trigger?: string;
  /** Host signature classification, independent of seller wording. Only these fees qualify for standing permission. */
  conditionalTrigger?: 'cancellation' | 'no_show';
  cancellationDeadline?: string;
  cancellationTerms?: string;
  conversionAt?: string;
  frequency?: string;
  /** A per-person fee is multiplied by the host-read party size. */
  perPerson?: boolean;
}
export interface ReservationFacts {
  venueId: string;
  venueName: string;
  partySize: number;
  at: string;
  endAt: string;
  timeZone: string;
}
/** A booking as an unreviewed page states it (KTD21): each fact only when the host read it. */
export interface GenericBookingFacts {
  /** The venue's name as the page shows it. */
  venue?: string;
  partySize?: number;
  /** The booking's start, when the page states it with its zone or UTC offset. */
  at?: string;
  /** The venue's clock: an IANA zone or a UTC offset. */
  timeZone?: string;
  /** The time as the page words it. */
  timeText?: string;
}
/** The generic floor's own facts (KTD5). */
export interface GenericCheckoutFacts {
  /** The checkout origin's registrable domain where it is not the merchant's: a payment platform or booking frame (KTD7). */
  platform?: string;
  /** No account is signed in. */
  guest: boolean;
  /** The contact email, lowercased: also the account key an order number is unique within. */
  contactEmail: string;
  /** The items, as the page shows them. */
  items: string[];
  /** The saved payment method, as the page shows it. */
  payment: string;
  /** A note that rides along with the order or booking (R4). */
  note?: string;
  booking?: GenericBookingFacts;
}
/** What the host read of a free commit (KTD3): a booking or sign-up that states no money. */
export interface FreeCommitFacts {
  flowId: string;
  /** The merchant (KTD7). */
  site: string;
  /** The checkout origin. */
  origin: string;
  platform?: string;
  control: { label: string; locator: StructuredBrowserLocator };
  /** The account as the page names it, or `guest checkout`. */
  account: string;
  guest: boolean;
  items: string[];
  contactEmail?: string;
  note?: string;
  booking?: GenericBookingFacts;
}
export interface PurchaseFacts {
  flowId: string;
  /** The merchant: the registrable domain of the top-level page the job entered checkout from (KTD7). */
  site: string;
  /** The checkout origin: the origin of the document the commit control is in. */
  origin: string;
  /** A reviewed flow's control by selector and form action; a generic one's by its structured locator. */
  control: { selector?: string; label: string; formAction?: string; locator?: StructuredBrowserLocator };
  account: string;
  items: Array<{ id: string; title: string; quantity: number }>;
  currency: string;
  totalMinor: number;
  dueNowMinor: number;
  cardEnding: string | null;
  address: string | null;
  delivery?: { date: string; text: string };
  commitments: FinancialCommitment[];
  checkoutReference?: string;
  reservation?: ReservationFacts;
  /** Explicit merchant evidence that a reservation has no financial commitment. Absence proves nothing. */
  noCommitmentTerms?: string;
  /**
   * Agreements beyond the site's own terms that the checkout's form carries, each by its frame origin and exact
   * wording: approving the card agrees to each, standing on the site (KTD11). Absent when there are none.
   */
  agreements?: Array<{ origin: string; wording: string }>;
  /** Paid extras the site keeps selected after the host unticked them: charges the card names. Absent when none. */
  addOns?: string[];
  /** The generic floor's own facts; present only on an unreviewed checkout. */
  generic?: GenericCheckoutFacts;
}
export interface PurchaseBounds {
  reservation?: { venueId: string; partySize: number; windowStart: string; windowEnd: string };
  deliveryWindow?: { start: string; end: string };
  neededBy?: string;
  /** The principal's clock when the needed-by was set: a quoted delivery date is a day on it. */
  principalTimeZone?: string;
}

const currencies = new Set(Intl.supportedValuesOf('currency'));
const currencyPrecisions = new Map<string, number>();
export function currencyExponent(currency: string): number | undefined {
  if (!currencies.has(currency)) return undefined;
  let precision = currencyPrecisions.get(currency);
  if (precision === undefined) {
    precision = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    if (precision === undefined) return undefined;
    currencyPrecisions.set(currency, precision);
  }
  return precision;
}

/** Convert exact major units without rounding a financial permission. */
export function amountMinor(value: string | number, currency: string): number | undefined {
  const precision = currencyExponent(currency);
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(String(value).trim());
  if (precision === undefined || !match) return undefined;
  const fraction = match[2] ?? '';
  if (/[^0]/u.test(fraction.slice(precision))) return undefined;
  const minor = Number(match[1]) * 10 ** precision + Number(fraction.slice(0, precision).padEnd(precision, '0'));
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : undefined;
}

export function moneyMinor(value: string): number | undefined {
  const match = /^(?:USD\s*|\$)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)$/u.exec(value.trim());
  if (!match) return undefined;
  return amountMinor(match[1].replaceAll(',', ''), 'USD');
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A venue as a delegated bound and a page both name it: case, spacing and apostrophes aside. */
export function venueKey(venue: string): string {
  return venue.normalize('NFKC').replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * The reservation a purchase books, for the delegated bounds and the standing guarantee (KTD21): a reviewed
 * signature's, or a generic booking whose venue, party size and time the host read. Undefined otherwise.
 */
export function bookedReservation(
  facts: PurchaseFacts,
): { venueId: string; partySize: number; at: string } | undefined {
  if (facts.reservation) return facts.reservation;
  const booking = facts.generic?.booking;
  return booking?.venue && booking.partySize !== undefined && booking.at
    ? { venueId: booking.venue, partySize: booking.partySize, at: booking.at }
    : undefined;
}

/** Whether a booked reservation falls within main's recorded bounds. */
export function withinReservationBounds(
  reservation: { venueId: string; partySize: number; at: string } | undefined,
  bounds: NonNullable<PurchaseBounds['reservation']>,
): boolean {
  return Boolean(
    reservation &&
    venueKey(reservation.venueId) === venueKey(bounds.venueId) &&
    reservation.partySize === bounds.partySize &&
    Date.parse(reservation.at) >= Date.parse(bounds.windowStart) &&
    Date.parse(reservation.at) <= Date.parse(bounds.windowEnd),
  );
}

/**
 * The generic floor's material change (KTD5): a total or due-now increase, the currency, the items, the payment
 * method, the terms, the contact email, the note, the checkout origin, the booking and the consent facts. The
 * commit label is not one: a checkout's next step names its own. Volatile text never reaches these facts.
 */
function genericMaterialChange(
  approved: PurchaseFacts,
  current: PurchaseFacts,
  bounds: PurchaseBounds,
): string | undefined {
  if (approved.flowId !== current.flowId || !approved.generic || !current.generic) return 'The merchant flow changed.';
  if (approved.currency !== current.currency) return 'The currency changed.';
  if (current.totalMinor > approved.totalMinor)
    return `The total rose to ${formatMoney(current.totalMinor, current.currency)}, from ${formatMoney(approved.totalMinor, approved.currency)}.`;
  if (current.dueNowMinor > approved.dueNowMinor)
    return `The amount due now rose to ${formatMoney(current.dueNowMinor, current.currency)}, from ${formatMoney(approved.dueNowMinor, approved.currency)}.`;
  for (const [changed, label] of [
    [approved.site !== current.site, 'site'],
    [approved.origin !== current.origin, 'checkout origin'],
    [!same(approved.generic.items, current.generic.items), 'items'],
    [
      approved.generic.payment !== current.generic.payment || approved.cardEnding !== current.cardEnding,
      'payment method',
    ],
    [!same(approved.commitments, current.commitments), 'financial terms'],
    [approved.generic.contactEmail !== current.generic.contactEmail, 'contact email'],
    [approved.generic.note !== current.generic.note, 'note'],
    [!same(approved.agreements, current.agreements), 'agreements'],
    [!same(approved.addOns, current.addOns), 'extra charges'],
  ] as const)
    if (changed) return `The ${label} changed.`;
  if (bounds.reservation) {
    if (!withinReservationBounds(bookedReservation(current), bounds.reservation))
      return 'The reservation is outside the delegated bounds.';
  } else if (!same(approved.generic.booking, current.generic.booking)) return 'The booking changed.';
  return undefined;
}

/** Compare material facts, never a byte hash: ordinary retail due-now tracks a falling total. */
export function materialPurchaseChange(
  approved: PurchaseFacts,
  current: PurchaseFacts,
  bounds: PurchaseBounds,
): string | undefined {
  if (approved.flowId === GENERIC_FLOW_ID || current.flowId === GENERIC_FLOW_ID)
    return genericMaterialChange(approved, current, bounds);
  if (approved.currency !== current.currency) return 'The currency changed.';
  if (current.totalMinor > approved.totalMinor)
    return `The total rose to ${formatMoney(current.totalMinor, current.currency)}, from ${formatMoney(approved.totalMinor, approved.currency)}.`;
  for (const [key, label] of [
    ['flowId', 'merchant flow'],
    ['site', 'site'],
    ['origin', 'frame origin'],
    ['control', 'commit control'],
    ['account', 'account'],
    ['items', 'items or quantities'],
    ['cardEnding', 'card'],
    ['address', 'address'],
    ['commitments', 'financial terms'],
    ['noCommitmentTerms', 'financial terms'],
    ['agreements', 'agreements'],
    ['addOns', 'extra charges'],
  ] as const)
    if (!same(approved[key], current[key])) return `The ${label} changed.`;
  if (bounds.reservation) {
    const reservation = current.reservation;
    if (
      !reservation ||
      reservation.venueId !== bounds.reservation.venueId ||
      reservation.partySize !== bounds.reservation.partySize ||
      reservation.at < bounds.reservation.windowStart ||
      reservation.at > bounds.reservation.windowEnd
    )
      return 'The reservation is outside the delegated bounds.';
  } else if (!same(approved.reservation, current.reservation)) return 'The reservation changed.';
  const retail = approved.commitments.length === 1 && approved.commitments[0].kind === 'retail';
  if (
    retail
      ? current.dueNowMinor !== current.totalMinor || approved.dueNowMinor !== approved.totalMinor
      : approved.dueNowMinor !== current.dueNowMinor
  )
    return 'The amount due now changed.';
  if (approved.delivery && !current.delivery) return 'The delivery date is unavailable.';
  if (current.delivery) {
    const date = current.delivery.date;
    if (bounds.deliveryWindow) {
      if (date < bounds.deliveryWindow.start.slice(0, 10) || date > bounds.deliveryWindow.end.slice(0, 10))
        return 'The delivery date is outside the approved window.';
    } else if (!bounds.neededBy && approved.delivery && date > approved.delivery.date)
      return 'The delivery date is later than the approved date.';
    if (
      bounds.neededBy &&
      !(zonedInstant(`${date}T23:59:59.999`, bounds.principalTimeZone ?? 'UTC') <= Date.parse(bounds.neededBy))
    )
      return 'Delivery misses the approved needed-by deadline.';
  } else if (bounds.deliveryWindow || bounds.neededBy) return 'The delivery date is unavailable.';
  return undefined;
}
export function formatMoney(minor: number, currency: string): string {
  const precision = currencyExponent(currency);
  if (precision === undefined) throw new RangeError('Unsupported currency');
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 10 ** precision);
}

export function validReservationFacts(reservation: ReservationFacts): boolean {
  if (
    !reservation.venueId ||
    !reservation.venueName ||
    !Number.isSafeInteger(reservation.partySize) ||
    reservation.partySize < 1
  )
    return false;
  const start = Date.parse(reservation.at);
  const end = Date.parse(reservation.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: reservation.timeZone });
    return Boolean(reservation.timeZone);
  } catch {
    return false;
  }
}

export function isFreeReservation(facts: PurchaseFacts): boolean {
  return Boolean(
    facts.reservation &&
    validReservationFacts(facts.reservation) &&
    facts.totalMinor === 0 &&
    facts.dueNowMinor === 0 &&
    facts.commitments.length === 0 &&
    !facts.addOns?.length &&
    facts.cardEnding === null &&
    facts.noCommitmentTerms?.trim(),
  );
}

/** An email address, whole. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * The generic floor (KTD5): the merchant and checkout origin, the commit label and locator, the total, currency
 * and amount due now, the saved payment method, the contact email, the items, and every term readable. No
 * address, item id or form action is required.
 */
function completeGenericFacts(facts: PurchaseFacts): boolean {
  const generic = facts.generic;
  if (!generic || !facts.site || !facts.origin || !facts.account || !facts.control.label || !facts.control.locator)
    return false;
  if (!generic.items.length || !generic.items.every((item) => item.trim()) || !generic.payment.trim()) return false;
  if (!EMAIL.test(generic.contactEmail) || generic.contactEmail !== generic.contactEmail.toLowerCase()) return false;
  if (currencyExponent(facts.currency) === undefined) return false;
  if (![facts.totalMinor, facts.dueNowMinor].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  if (facts.cardEnding !== null && !/^\d{4}$/u.test(facts.cardEnding)) return false;
  return facts.commitments.every(
    (term) =>
      term.terms.trim() &&
      term.amountMinor !== undefined &&
      Number.isSafeInteger(term.amountMinor) &&
      term.amountMinor >= 0 &&
      ((term.kind !== 'subscription' && term.kind !== 'trial') || Boolean(term.frequency)) &&
      (term.kind !== 'trial' || (term.conversionAt !== undefined && Number.isFinite(Date.parse(term.conversionAt)))),
  );
}

/** Complete host facts are mandatory even for a zero-due-now commitment. Each signature has its own floor. */
export function completePurchaseFacts(facts: PurchaseFacts): boolean {
  if (facts.flowId === GENERIC_FLOW_ID) return completeGenericFacts(facts);
  if (!facts.items.length || !facts.account || currencyExponent(facts.currency) === undefined) return false;
  if (![facts.totalMinor, facts.dueNowMinor].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  if (!facts.control.label || !facts.control.selector || !facts.control.formAction) return false;
  if (!facts.items.every((item) => item.id && item.title && Number.isSafeInteger(item.quantity) && item.quantity > 0))
    return false;
  if (facts.reservation && !validReservationFacts(facts.reservation)) return false;
  if (isFreeReservation(facts)) return true;
  if (
    (!facts.reservation && !facts.address) ||
    typeof facts.cardEnding !== 'string' ||
    !/^\d{4}$/u.test(facts.cardEnding) ||
    !facts.commitments.length ||
    facts.noCommitmentTerms !== undefined
  )
    return false;
  return facts.commitments.every((term) => {
    if (!term.terms.trim()) return false;
    if (term.kind === 'retail') return true;
    if (
      term.amountMinor === undefined ||
      !Number.isSafeInteger(term.amountMinor) ||
      term.amountMinor < 0 ||
      !term.cancellationTerms
    )
      return false;
    if (
      term.kind === 'conditional_fee' ||
      term.kind === 'hold' ||
      term.kind === 'deposit' ||
      term.kind === 'prepayment'
    )
      return Boolean(
        term.trigger && term.cancellationDeadline && Number.isFinite(Date.parse(term.cancellationDeadline)),
      );
    return Boolean(
      term.frequency &&
      (term.kind !== 'trial' || (term.conversionAt && Number.isFinite(Date.parse(term.conversionAt)))),
    );
  });
}

/** A commit label that books rather than buys. */
export const BOOKING_CONTROL = /\b(?:reserve|reservation|book(?:ing)?|table|rsvp|wait\s*list|waitlist)\b/iu;

/** Whether the host-read free commit books rather than orders. */
export function freeCommitBooks(facts: FreeCommitFacts): boolean {
  return Boolean(facts.booking) || BOOKING_CONTROL.test(facts.control.label);
}

/**
 * Whether the standing guarantee covers a booking (R38, KTD21): its venue, party size and time read and within
 * main's recorded bounds, nothing due now, and only cancellation or no-show fees whose whole exposure is within
 * the guarantee's limit. An unreviewed booking must also state its fee terms.
 */
export function guaranteeCoversReservation(
  grant:
    | { readonly currency: string; readonly max_total_minor: number; readonly revoked_at: string | null }
    | undefined,
  facts: PurchaseFacts,
  bounds: PurchaseBounds,
): boolean {
  const reservation = bookedReservation(facts);
  const delegated = bounds.reservation;
  if (
    !grant ||
    grant.revoked_at ||
    !reservation ||
    !delegated ||
    facts.addOns?.length ||
    facts.dueNowMinor !== 0 ||
    facts.currency !== grant.currency ||
    (facts.generic && !facts.commitments.length) ||
    !completePurchaseFacts(facts)
  )
    return false;
  if (!withinReservationBounds(reservation, delegated)) return false;
  if (
    !facts.commitments.every(
      (term) =>
        term.kind === 'conditional_fee' &&
        (term.conditionalTrigger === 'cancellation' || term.conditionalTrigger === 'no_show'),
    )
  )
    return false;
  // Distinct conditional fees can both apply; the ceiling covers total exposure, never one person's amount.
  const exposure = facts.commitments.reduce(
    (sum, term) => sum + (term.amountMinor ?? Infinity) * (term.perPerson ? reservation.partySize : 1),
    0,
  );
  return Number.isSafeInteger(exposure) && exposure <= grant.max_total_minor;
}
