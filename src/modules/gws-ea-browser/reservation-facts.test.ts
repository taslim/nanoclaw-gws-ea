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
  const card = renderPurchaseCard(free, {}, []);
  expect(card).toContain('Bistro');
  expect(card).toContain('Party size: 2');
  expect(card).toContain('Reservation time:');
  expect(card).toContain('Venue timezone: "UTC"');
  expect(card).toContain(free.noCommitmentTerms);
  expect(card).not.toContain('One-time retail purchase');
});
