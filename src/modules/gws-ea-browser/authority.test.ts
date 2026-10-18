import { describe, expect, it } from 'vitest';
import { materialPurchaseChange, type PurchaseFacts } from './fingerprint.js';

export const retailFacts: PurchaseFacts = {
  flowId: 'amazon-us-retail-v1',
  site: 'amazon.com',
  origin: 'https://www.amazon.com',
  control: {
    selector: '#placeYourOrder input[name="placeYourOrder1"]',
    label: 'Place your order',
    formAction: 'https://www.amazon.com/gp/buy/spc/handlers/static-submit-decoupled.html',
  },
  account: 'Hello, Morgan',
  items: [{ id: 'B012345678', title: 'Tea kettle', quantity: 1 }],
  currency: 'USD',
  totalMinor: 8500,
  dueNowMinor: 8500,
  cardEnding: '4242',
  address: 'Morgan, 10 Main St, Seattle WA 98101',
  delivery: { date: '2026-10-20', text: 'Arriving Tuesday, October 20, 2026' },
  commitments: [{ kind: 'retail', terms: 'One-time retail order. No recurring commitment.' }],
};

describe('principal-approved material purchase bounds', () => {
  it('permits a lower retail total, whose due-now amount falls with it', () => {
    expect(
      materialPurchaseChange(retailFacts, { ...retailFacts, totalMinor: 8450, dueNowMinor: 8450 }, {}),
    ).toBeUndefined();
  });
  it.each([
    ['higher total', { totalMinor: 8512, dueNowMinor: 8512 }],
    ['card', { cardEnding: '1234' }],
    ['address', { address: 'Another address' }],
    ['account', { account: 'Hello, Sam' }],
    ['origin', { origin: 'https://smile.amazon.com' }],
    ['quantity', { items: [{ ...retailFacts.items[0], quantity: 2 }] }],
    ['later date', { delivery: { date: '2026-10-21', text: 'October 21' } }],
    [
      'subscription',
      {
        totalMinor: 8400,
        dueNowMinor: 8400,
        commitments: [
          {
            kind: 'subscription' as const,
            amountMinor: 8400,
            frequency: 'monthly',
            cancellationTerms: 'Cancel anytime',
            terms: 'Renews monthly',
          },
        ],
      },
    ],
  ])('requires a fresh card for %s', (_name, change) => {
    expect(materialPurchaseChange(retailFacts, { ...retailFacts, ...change }, {})).toBeTypeOf('string');
  });
  it('honours an explicit delivery window or needed-by deadline on a rebuilt checkout', () => {
    const later = { ...retailFacts, delivery: { date: '2026-10-22', text: 'October 22' } };
    expect(
      materialPurchaseChange(retailFacts, later, { deliveryWindow: { start: '2026-10-20', end: '2026-10-23' } }),
    ).toBeUndefined();
    expect(materialPurchaseChange(retailFacts, later, { neededBy: '2026-10-22T23:59:59.999Z' })).toBeUndefined();
    expect(materialPurchaseChange(retailFacts, later, { neededBy: '2026-10-21T23:59:59.999Z' })).toBeTypeOf('string');
  });
  it('reads a delivery date as a day on the principal’s clock against their needed-by deadline', () => {
    const later = { ...retailFacts, delivery: { date: '2026-10-22', text: 'October 22' } };
    // The end of 22 October in Tokyo.
    const endOfDay = { neededBy: '2026-10-22T14:59:59.999Z', principalTimeZone: 'Asia/Tokyo' };
    expect(materialPurchaseChange(retailFacts, later, endOfDay)).toBeUndefined();
    expect(
      materialPurchaseChange(retailFacts, { ...later, delivery: { date: '2026-10-23', text: 'October 23' } }, endOfDay),
    ).toBeTypeOf('string');
    // Noon that day is missed by a delivery that may come any time that day.
    expect(
      materialPurchaseChange(retailFacts, later, {
        neededBy: '2026-10-22T03:00:00.000Z',
        principalTimeZone: 'Asia/Tokyo',
      }),
    ).toBeTypeOf('string');
    expect(
      materialPurchaseChange(retailFacts, { ...later, delivery: { date: 'soon', text: 'Soon' } }, endOfDay),
    ).toBeTypeOf('string');
  });
  it('never treats a cheaper recurring conversion as unchanged financial terms', () => {
    const approved: PurchaseFacts = {
      ...retailFacts,
      dueNowMinor: 0,
      commitments: [
        {
          kind: 'trial',
          amountMinor: 9900,
          conversionAt: '2026-11-01T00:00:00.000Z',
          frequency: 'yearly',
          cancellationTerms: 'Cancel before conversion',
          terms: 'Converts annually',
        },
      ],
    };
    expect(
      materialPurchaseChange(
        approved,
        { ...approved, commitments: [{ ...approved.commitments[0], amountMinor: 8900 }] },
        {},
      ),
    ).toBeTypeOf('string');
  });
});
