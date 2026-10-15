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
export interface PurchaseFacts {
  flowId: string;
  site: string;
  origin: string;
  control: { selector: string; label: string; formAction: string };
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
}
export interface PurchaseBounds {
  reservation?: { venueId: string; partySize: number; windowStart: string; windowEnd: string };
  deliveryWindow?: { start: string; end: string };
  neededBy?: string;
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
/** Compare material facts, never a byte hash: ordinary retail due-now tracks a falling total. */
export function materialPurchaseChange(
  approved: PurchaseFacts,
  current: PurchaseFacts,
  bounds: PurchaseBounds,
): string | undefined {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
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
    if (bounds.neededBy && `${date}T23:59:59.999Z` > bounds.neededBy)
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
    facts.cardEnding === null &&
    facts.noCommitmentTerms?.trim(),
  );
}

/** Complete host facts are mandatory even for a zero-due-now commitment. */
export function completePurchaseFacts(facts: PurchaseFacts): boolean {
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
