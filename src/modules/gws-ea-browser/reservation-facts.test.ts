import { expect, it } from 'vitest';
import {
  amountMinor,
  completePurchaseFacts,
  currencyExponent,
  formatMoney,
  type PurchaseFacts,
} from './fingerprint.js';

const free: PurchaseFacts = {
  flowId: 'reviewed-free-reservation',
  site: 'restaurant.example',
  origin: 'https://restaurant.example',
  control: { selector: '#confirm', label: 'Reserve', formAction: 'https://restaurant.example/book' },
  account: 'guest-1',
  items: [{ id: 'venue-1', title: 'Dinner for two', quantity: 1 }],
  currency: 'USD',
  totalMinor: 0,
  dueNowMinor: 0,
  cardEnding: null,
  address: null,
  commitments: [],
  noCommitmentTerms: 'No charge, deposit, hold or cancellation/no-show fee.',
  reservation: {
    venueId: 'venue-1',
    venueName: 'Bistro',
    partySize: 2,
    at: '2026-10-20T19:00:00.000Z',
    endAt: '2026-10-20T20:30:00.000Z',
    timeZone: 'UTC',
  },
};

it('accepts explicit truly free reservation facts without inventing a payment card or address', () => {
  expect(completePurchaseFacts(free)).toBe(true);
  expect(completePurchaseFacts({ ...free, noCommitmentTerms: undefined })).toBe(false);
  expect(completePurchaseFacts({ ...free, totalMinor: 100 })).toBe(false);
  expect(completePurchaseFacts({ ...free, reservation: undefined })).toBe(false);
  expect(completePurchaseFacts({ ...free, reservation: { ...free.reservation!, endAt: free.reservation!.at } })).toBe(
    false,
  );
  expect(completePurchaseFacts({ ...free, reservation: { ...free.reservation!, timeZone: 'invented/zone' } })).toBe(
    false,
  );
});

it('uses each currency exponent and refuses hidden precision instead of rounding financial authority', () => {
  expect(currencyExponent('JPY')).toBe(0);
  expect(currencyExponent('KWD')).toBe(3);
  expect(amountMinor('100', 'JPY')).toBe(100);
  expect(amountMinor('1.234', 'KWD')).toBe(1234);
  expect(amountMinor(25.5, 'USD')).toBe(2550);
  expect(amountMinor('0.001', 'USD')).toBeUndefined();
  expect(amountMinor('0.1', 'JPY')).toBeUndefined();
  expect(amountMinor('1', 'ZZZ')).toBeUndefined();
  expect(formatMoney(1234, 'KWD')).toContain('1.234');
});

it('shows the exact reservation and explicit no-commitment terms on its approval card', async () => {
  const { renderPurchaseCard } = await import('./cards.js');
  const card = renderPurchaseCard(free, {}, [], 'UTC');
  expect(card).toContain('Bistro');
  expect(card).toContain('Party size: 2');
  expect(card).toContain('Reservation time: Oct 20, 2026, 7:00 PM through 8:30 PM UTC\n');
  expect(card).toContain(free.noCommitmentTerms);
  expect(card).not.toContain('One-time retail purchase');
});

it("shows a Tokyo dinner on the venue's clock with the principal's alongside, and its deadline on theirs", async () => {
  const { renderPurchaseCard } = await import('./cards.js');
  const dinner: PurchaseFacts = {
    ...free,
    currency: 'JPY',
    noCommitmentTerms: undefined,
    commitments: [
      {
        kind: 'conditional_fee',
        terms: '¥5,000 per guest for cancellation within 24 hours',
        amountMinor: 5000,
        perPerson: true,
        trigger: 'Late cancellation',
        conditionalTrigger: 'cancellation',
        cancellationDeadline: '2026-10-19T10:00:00.000Z',
        cancellationTerms: 'Cancel at least 24 hours before arrival',
      },
    ],
    reservation: {
      ...free.reservation!,
      at: '2026-10-20T10:00:00.000Z',
      endAt: '2026-10-20T11:30:00.000Z',
      timeZone: 'Asia/Tokyo',
    },
  };
  const card = renderPurchaseCard(dinner, {}, [], 'America/Los_Angeles');
  expect(card).toContain(
    'Reservation time: Oct 20, 2026, 7:00 PM through 8:30 PM Tokyo time (Oct 20, 2026, 3:00 AM through 4:30 AM Los Angeles time)',
  );
  expect(card).toContain('Cancellation deadline: Oct 19, 2026, 3:00 AM Los Angeles time');
  // A principal on the venue's clock reads it once.
  expect(renderPurchaseCard(dinner, {}, [], 'Asia/Tokyo')).toContain(
    'Reservation time: Oct 20, 2026, 7:00 PM through 8:30 PM Tokyo time\n',
  );
});

it('shows a needed-by deadline and a trial conversion on the principal’s clock, labelled', async () => {
  const { renderPurchaseCard } = await import('./cards.js');
  const trial: PurchaseFacts = {
    ...free,
    reservation: undefined,
    noCommitmentTerms: undefined,
    totalMinor: 0,
    commitments: [
      {
        kind: 'trial',
        terms: 'Free for 30 days, then $9.99 monthly',
        amountMinor: 999,
        conversionAt: '2026-11-15T08:00:00.000Z',
        frequency: 'monthly',
        cancellationTerms: 'Cancel before the trial ends',
      },
    ],
  };
  const card = renderPurchaseCard(
    trial,
    { neededBy: '2026-10-21T06:59:59.999Z', principalTimeZone: 'America/Los_Angeles' },
    [],
    'America/Los_Angeles',
  );
  expect(card).toContain('Needed by: Oct 20, 2026, 11:59 PM Los Angeles time');
  expect(card).toContain('Trial conversion: Nov 15, 2026, 12:00 AM Los Angeles time');
});
