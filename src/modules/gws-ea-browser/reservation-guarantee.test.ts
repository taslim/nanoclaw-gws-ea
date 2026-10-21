import { describe, expect, it } from 'vitest';
import { guaranteeCoversReservation } from './fingerprint.js';
import type { PurchaseBounds, PurchaseFacts } from './fingerprint.js';
const bounds: PurchaseBounds = {
  reservation: {
    venueId: 'bistro-123',
    partySize: 4,
    windowStart: '2026-10-20T18:00:00.000Z',
    windowEnd: '2026-10-20T21:00:00.000Z',
  },
};
const facts: PurchaseFacts = {
  flowId: 'reviewed-reservation',
  site: 'restaurant.example',
  origin: 'https://restaurant.example',
  control: { selector: '#confirm', label: 'Confirm reservation', formAction: 'https://restaurant.example/confirm' },
  account: 'Morgan',
  items: [{ id: 'bistro-123', title: 'Dinner for four', quantity: 1 }],
  currency: 'USD',
  totalMinor: 7500,
  dueNowMinor: 0,
  cardEnding: '4242',
  address: 'Morgan',
  reservation: {
    venueId: 'bistro-123',
    venueName: 'Bistro',
    partySize: 4,
    at: '2026-10-20T19:30:00.000Z',
    endAt: '2026-10-20T21:00:00.000Z',
    timeZone: 'UTC',
  },
  commitments: [
    {
      kind: 'conditional_fee',
      amountMinor: 7500,
      trigger: 'No-show',
      conditionalTrigger: 'no_show',
      cancellationDeadline: '2026-10-19T19:30:00.000Z',
      cancellationTerms: 'Cancel before the deadline for no fee',
      terms: '$75 total if you do not attend',
    },
  ],
};
describe('standing reservation guarantee coverage', () => {
  it('covers only an explicit total ceiling and delegated reservation bounds', () => {
    expect(
      guaranteeCoversReservation({ currency: 'USD', max_total_minor: 10000, revoked_at: null }, facts, bounds),
    ).toBe(true);
    expect(guaranteeCoversReservation(undefined, facts, bounds)).toBe(false);
    expect(guaranteeCoversReservation({ currency: 'USD', max_total_minor: 10000, revoked_at: null }, facts, {})).toBe(
      false,
    );
  });
  it.each(['hold', 'deposit', 'prepayment', 'trial', 'subscription'] as const)(
    'requires separate approval for %s',
    (kind) => {
      expect(
        guaranteeCoversReservation(
          { currency: 'USD', max_total_minor: 10000, revoked_at: null },
          { ...facts, commitments: [{ ...facts.commitments[0], kind }] },
          bounds,
        ),
      ).toBe(false);
    },
  );
  it('does not cover another conditional trigger merely because seller prose mentions no-shows', () => {
    expect(
      guaranteeCoversReservation(
        { currency: 'USD', max_total_minor: 10000, revoked_at: null },
        {
          ...facts,
          commitments: [
            { ...facts.commitments[0], trigger: 'Damage, cancellation or no-show', conditionalTrigger: undefined },
          ],
        },
        bounds,
      ),
    ).toBe(false);
  });
  it('multiplies a per-person fee and rejects currency, unreadable terms, immediate payment and revoked permission', () => {
    const grant = { currency: 'USD', max_total_minor: 10000, revoked_at: null };
    expect(
      guaranteeCoversReservation(
        grant,
        { ...facts, commitments: [{ ...facts.commitments[0], amountMinor: 5000, perPerson: true }] },
        bounds,
      ),
    ).toBe(false);
    expect(guaranteeCoversReservation(grant, { ...facts, currency: 'EUR' }, bounds)).toBe(false);
    expect(guaranteeCoversReservation(grant, { ...facts, dueNowMinor: 1 }, bounds)).toBe(false);
    expect(
      guaranteeCoversReservation(
        grant,
        { ...facts, commitments: [{ ...facts.commitments[0], cancellationDeadline: undefined }] },
        bounds,
      ),
    ).toBe(false);
    expect(guaranteeCoversReservation({ ...grant, revoked_at: '2026-10-19T00:00:00.000Z' }, facts, bounds)).toBe(false);
  });
});
