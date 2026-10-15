import { createHash } from 'node:crypto';

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
  cardEnding: string;
  address: string;
  delivery?: { date: string; text: string };
  commitments: FinancialCommitment[];
  checkoutReference?: string;
  reservation?: { venueId: string; partySize: number; at: string };
}
export interface PurchaseBounds {
  reservation?: { venueId: string; partySize: number; windowStart: string; windowEnd: string };
  deliveryWindow?: { start: string; end: string };
  neededBy?: string;
}

export function moneyMinor(value: string): number | undefined {
  const match = /^(?:USD\s*|\$)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)$/u.exec(value.trim());
  if (!match) return undefined;
  const [whole, fraction = '00'] = match[1].replaceAll(',', '').split('.');
  const amount = Number(whole) * 100 + Number(fraction);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}
export function purchaseFingerprint(facts: PurchaseFacts): string {
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
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
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

/** Complete host facts are mandatory even for a zero-due-now commitment. */
export function completePurchaseFacts(facts: PurchaseFacts): boolean {
  if (
    !facts.items.length ||
    !facts.account ||
    !facts.address ||
    !/^\d{4}$/u.test(facts.cardEnding) ||
    !/^[A-Z]{3}$/u.test(facts.currency)
  )
    return false;
  if (![facts.totalMinor, facts.dueNowMinor].every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  if (!facts.control.label || !facts.control.selector || !facts.control.formAction || !facts.commitments.length)
    return false;
  if (!facts.items.every((item) => item.id && item.title && Number.isSafeInteger(item.quantity) && item.quantity > 0))
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
