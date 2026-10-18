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
  const { renderPurchaseCard, NO_EARLIER_PURCHASES } = await import('./cards.js');
  const card = renderPurchaseCard(free, {}, NO_EARLIER_PURCHASES, 'UTC');
  expect(card).toContain('Bistro');
  expect(card).toContain('Party size: 2');
  expect(card).toContain('Reservation time: Oct 20, 2026, 7:00 PM through 8:30 PM UTC\n');
  expect(card).toContain(free.noCommitmentTerms);
  expect(card).not.toContain('One-time retail purchase');
});

it("shows a Tokyo dinner on the venue's clock with the principal's alongside, and its deadline on theirs", async () => {
  const { renderPurchaseCard, NO_EARLIER_PURCHASES } = await import('./cards.js');
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
  const card = renderPurchaseCard(dinner, {}, NO_EARLIER_PURCHASES, 'America/Los_Angeles');
  expect(card).toContain(
    'Reservation time: Oct 20, 2026, 7:00 PM through 8:30 PM Tokyo time (Oct 20, 2026, 3:00 AM through 4:30 AM Los Angeles time)',
  );
  expect(card).toContain('Cancellation deadline: Oct 19, 2026, 3:00 AM Los Angeles time');
  // A principal on the venue's clock reads it once.
  expect(renderPurchaseCard(dinner, {}, NO_EARLIER_PURCHASES, 'Asia/Tokyo')).toContain(
    'Reservation time: Oct 20, 2026, 7:00 PM through 8:30 PM Tokyo time\n',
  );
});

it('shows a needed-by deadline and a trial conversion on the principal’s clock, labelled', async () => {
  const { renderPurchaseCard, NO_EARLIER_PURCHASES } = await import('./cards.js');
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
    NO_EARLIER_PURCHASES,
    'America/Los_Angeles',
  );
  expect(card).toContain('Needed by: Oct 20, 2026, 11:59 PM Los Angeles time');
  expect(card).toContain('Trial conversion: Nov 15, 2026, 12:00 AM Los Angeles time');
});

/** An unreviewed venue's own booking with a no-show fee, as the generic signature reads it. */
const booking: PurchaseFacts = {
  flowId: 'generic-checkout-v1',
  site: 'trattoria.example',
  origin: 'https://trattoria.example',
  control: {
    label: 'Reserve now',
    locator: {
      role: 'button',
      name: 'Reserve now',
      ordinal: 0,
      count: 1,
      framePath: [],
      frameUrls: ['https://trattoria.example/book'],
    },
  },
  account: 'guest checkout',
  items: [],
  currency: 'USD',
  totalMinor: 0,
  dueNowMinor: 0,
  cardEnding: '4242',
  address: null,
  commitments: [
    {
      kind: 'conditional_fee',
      terms: 'No-show fee: $25 per person, charged if you miss your reservation.',
      amountMinor: 2500,
      trigger: 'No-show fee: $25 per person, charged if you miss your reservation.',
      conditionalTrigger: 'no_show',
      cancellationTerms: 'No-show fee: $25 per person, charged if you miss your reservation.',
      perPerson: true,
    },
  ],
  generic: {
    guest: true,
    contactEmail: 'aya.web@example.test',
    items: ['Party size 2'],
    payment: 'Card on file: Visa ending in 4242',
    note: 'One guest is allergic to peanuts',
    booking: {
      venue: 'Trattoria Remy',
      partySize: 2,
      at: '2026-10-25T02:00:00.000Z',
      timeZone: '-07:00',
      timeText: 'Saturday, October 24, 7:00 PM',
    },
  },
};

it("shows an unreviewed booking's account, quoted items, note and time, naming the assistant's address and no internal id", async () => {
  const { renderPurchaseCard, NO_EARLIER_PURCHASES } = await import('./cards.js');
  const card = renderPurchaseCard(
    booking,
    {},
    { unresolved: 1, recordedNotPlaced: [] },
    'America/New_York',
    undefined,
    {
      alias: 'Aya.Web@example.test',
    },
  );
  for (const line of [
    'Site: trattoria.example',
    'Account: guest checkout',
    "Contact email: your assistant's email",
    'Item: "Party size 2"',
    'Total: $0.00 (USD)',
    'Due now: $0.00',
    'Payment: "Card on file: Visa ending in 4242"',
    'Note: "One guest is allergic to peanuts"',
    'Venue: "Trattoria Remy"',
    'Party size: 2',
    'Time: Oct 24, 2026, 7:00 PM GMT-7 (Oct 24, 2026, 10:00 PM New York time)',
    'Amount due later/exposure: $25.00 per person × 2',
    'Possible duplicate: An earlier purchase on this site has no recorded outcome.',
  ])
    expect(card).toContain(line);
  expect(card).not.toMatch(/attempt-|authority-/u);
  expect(card).not.toContain('aya.web@example.test');
  const signedIn = renderPurchaseCard(
    { ...booking, account: 'aya.web+tables@example.test', generic: { ...booking.generic!, guest: false } },
    {},
    NO_EARLIER_PURCHASES,
    'America/New_York',
    undefined,
    { alias: 'aya.web@example.test' },
  );
  expect(signedIn).toContain("Account: your assistant's account");
  expect(
    renderPurchaseCard(
      { ...booking, account: 'Morgan Ellery', generic: { ...booking.generic!, guest: false } },
      {},
      NO_EARLIER_PURCHASES,
      'America/New_York',
    ),
  ).toContain('Account: "Morgan Ellery"');
});

it("names earlier purchases on a reviewed card by count and time, never by id, and the assistant's own account as its", async () => {
  const { renderPurchaseCard, NO_EARLIER_PURCHASES } = await import('./cards.js');
  const card = renderPurchaseCard(
    free,
    {},
    {
      unresolved: 2,
      recordedNotPlaced: [
        { attemptedAt: '2026-10-17T22:04:00.000Z', source: 'principal' },
        { attemptedAt: '2026-10-16T17:30:00.000Z', source: 'email' },
      ],
    },
    'America/Los_Angeles',
  );
  for (const line of [
    'Earlier purchase here, tried Oct 17, 2026, 3:04 PM Los Angeles time: I recorded it as not placed, from what you told me.',
    "Earlier purchase here, tried Oct 16, 2026, 10:30 AM Los Angeles time: I recorded it as not placed, from the merchant's email.",
    'Possible duplicate: 2 earlier purchases on this site have no recorded outcome. Approving permits exactly one new attempt and may buy the same thing twice.',
  ])
    expect(card).toContain(line);
  expect(card).not.toMatch(/attempt-|authority-/u);
  expect(renderPurchaseCard(free, {}, NO_EARLIER_PURCHASES, 'UTC')).not.toMatch(/Earlier purchase|Possible duplicate/u);
  const own = renderPurchaseCard(
    { ...free, account: 'Aya.Web@example.test' },
    {},
    NO_EARLIER_PURCHASES,
    'UTC',
    undefined,
    {
      alias: 'aya.web@example.test',
    },
  );
  expect(own).toContain("Account: your assistant's account");
  expect(own).not.toContain('aya.web@example.test');
});

it('covers an unreviewed booking under the standing guarantee only when its venue, party size, time and fee are read within bounds', async () => {
  const { guaranteeCoversReservation } = await import('./reservation-guarantee.js');
  const grant = { currency: 'USD', max_total_minor: 5000, revoked_at: null };
  const bounds = {
    reservation: {
      venueId: 'trattoria remy',
      partySize: 2,
      windowStart: '2026-10-25T01:00:00.000Z',
      windowEnd: '2026-10-25T04:00:00.000Z',
    },
  };
  expect(completePurchaseFacts(booking)).toBe(true);
  expect(guaranteeCoversReservation(grant, booking, bounds)).toBe(true);
  const without = (key: 'venue' | 'partySize' | 'at'): PurchaseFacts => {
    const { [key]: _omitted, ...rest } = booking.generic!.booking!;
    return { ...booking, generic: { ...booking.generic!, booking: rest } };
  };
  for (const key of ['venue', 'partySize', 'at'] as const)
    expect(guaranteeCoversReservation(grant, without(key), bounds)).toBe(false);
  expect(guaranteeCoversReservation({ ...grant, max_total_minor: 4999 }, booking, bounds)).toBe(false);
  expect(guaranteeCoversReservation(grant, { ...booking, commitments: [] }, bounds)).toBe(false);
  expect(
    guaranteeCoversReservation(grant, booking, {
      reservation: { ...bounds.reservation, venueId: 'Trattoria Juno' },
    }),
  ).toBe(false);
});
