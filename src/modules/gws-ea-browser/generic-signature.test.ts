/** The generic signature's decisions and fact floor, from host reads shaped as the isolated-world reader returns them. */
import { describe, expect, it } from 'vitest';

import type { CheckoutField, CheckoutFrame, CheckoutRead } from './control-facts.js';
import {
  authorizablePurchaseFacts,
  completePurchaseFacts,
  genericAccountKey,
  GENERIC_FLOW_ID,
  guaranteeCoversReservation,
  materialPurchaseChange,
  validReviewPurchaseFacts,
  type PurchaseFacts,
} from './fingerprint.js';
import { decideGenericCheckout, pressRefusal, type GenericDecision } from './generic-signature.js';
import { evidenceMatchesAttempt } from './reconciliation.js';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const locator = {
  role: 'button' as const,
  name: 'Place order',
  ordinal: 0,
  count: 1,
  framePath: [],
  frameUrls: ['https://pottery.example/checkout/review'],
};
const field = (overrides: Partial<CheckoutField>): CheckoutField => ({
  tag: 'input',
  type: 'text',
  name: '',
  autocomplete: '',
  label: '',
  value: '',
  card: false,
  secret: false,
  checked: null,
  ...overrides,
});
const email = (value: string): CheckoutField => field({ type: 'email', name: 'email', label: 'Email', value });
const frame = (overrides: Partial<CheckoutFrame> = {}): CheckoutFrame => ({
  url: 'https://pottery.example/checkout/review',
  top: true,
  lines: [],
  expressPay: [],
  paymentEntry: false,
  signedIn: false,
  heading: 'Checkout',
  structured: [],
  ...overrides,
});

interface Shown {
  lines: string[];
  fields?: CheckoutField[];
  frames?: CheckoutFrame[];
  frameUrl?: string;
  label?: string;
  times?: Array<{ datetime: string; text: string }>;
}
/** A read of one checkout: its region's lines (line `n` sits 20 pixels below line `n - 1`) and its frames. */
function read(shown: Shown): CheckoutRead {
  const frameUrl = shown.frameUrl ?? 'https://pottery.example/checkout/review';
  return {
    facts: {
      name: shown.label ?? 'Place order',
      role: '',
      tag: 'button',
      type: 'submit',
      href: null,
      transaction: true,
    },
    region: {
      kind: 'form',
      label: shown.label ?? 'Place order',
      controlBox: { x: 10, y: 400, width: 120, height: 30 },
      lines: shown.lines.map((text, index) => ({ text, box: { x: 10, y: 20 * index, width: 300, height: 18 } })),
      fields: shown.fields ?? [],
      times: shown.times ?? [],
    },
    frameUrl,
    frames: shown.frames ?? [frame({ url: frameUrl, lines: shown.lines })],
  };
}
const decide = (shown: Shown, merchant = 'pottery.example', now = NOW): GenericDecision =>
  decideGenericCheckout(read(shown), { merchant, locator, controlBox: { x: 60, y: 450, width: 120, height: 30 } }, now);
const ready = (decision: GenericDecision): PurchaseFacts => {
  if (decision.status !== 'ready') throw new Error(`Expected a card's facts, got ${JSON.stringify(decision)}`);
  return decision.facts;
};

const shop: Shown = {
  lines: [
    'Your order',
    'Celadon mug × 2',
    'Ash glaze bowl × 1',
    'Payment',
    'Visa ending in 4242',
    'Order total $42.00',
  ],
  fields: [email('Aya.Web@Example.TEST')],
};

describe('the generic fact floor', () => {
  it('reads an unreviewed checkout into the generic floor, with the picture’s regions on the main frame', () => {
    const decision = decide(shop);
    const facts = ready(decision);
    expect(facts).toMatchObject({
      flowId: 'generic-checkout-v1',
      site: 'pottery.example',
      origin: 'https://pottery.example',
      control: { label: 'Place order', locator },
      account: 'guest checkout',
      currency: 'USD',
      totalMinor: 4200,
      dueNowMinor: 4200,
      cardEnding: '4242',
      commitments: [],
      generic: {
        guest: true,
        contactEmail: 'aya.web@example.test',
        items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
        payment: 'Visa ending in 4242',
      },
    });
    expect(facts.generic?.platform).toBeUndefined();
    expect(completePurchaseFacts(facts)).toBe(true);
    // The control sits 50 right and 50 down on the main frame: the total's line moves with it.
    expect(decision.status === 'ready' && decision.regions).toEqual({
      control: { x: 60, y: 450, width: 120, height: 30 },
      total: { x: 60, y: 150, width: 300, height: 18 },
    });
  });

  it('names a signed-in account, and a payment platform’s domain apart from the merchant', () => {
    const signedIn = ready(
      decide({ ...shop, frames: [frame({ lines: ['Signed in as Morgan Ellery'], signedIn: true })] }),
    );
    expect(signedIn).toMatchObject({ account: 'Morgan Ellery', generic: { guest: false } });
    const platform = ready(decide({ ...shop, frameUrl: 'https://pay.example/c/pottery-42' }));
    expect(platform).toMatchObject({
      site: 'pottery.example',
      origin: 'https://pay.example',
      generic: { platform: 'pay.example' },
    });
  });

  it('answers card_needed for a paid checkout with no saved payment method, reporting what it read', () => {
    expect(decide({ ...shop, lines: shop.lines.filter((line) => !line.includes('Visa')) })).toEqual({
      status: 'card_needed',
      needed: {
        site: 'pottery.example',
        account: 'guest checkout',
        items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
        total: '$42.00',
      },
    });
  });

  it('falls back to screenshot-backed review facts when a financial checkout has unread details, and locks its visible lines', () => {
    const ambiguousEmail = ready(
      decide({ ...shop, fields: [email('aya.web@example.test'), email('morgan@example.test')] }),
    );
    expect(ambiguousEmail.generic?.review?.missing).toEqual(['the contact email']);
    expect(completePurchaseFacts(ambiguousEmail)).toBe(false);
    expect(validReviewPurchaseFacts(ambiguousEmail)).toBe(true);
    expect(authorizablePurchaseFacts(ambiguousEmail, 'checkout')).toBe(true);
    expect(authorizablePurchaseFacts(ambiguousEmail, 'watch')).toBe(false);
    expect(authorizablePurchaseFacts(ambiguousEmail, 'reservation_guarantee')).toBe(false);

    const noItems = ready(decide({ ...shop, lines: ['Visa ending in 4242', 'Order total $42.00'] }));
    expect(noItems.generic?.review?.missing).toEqual(['the items']);

    const unpricedHold = ready(
      decide({ ...shop, lines: [...shop.lines, 'A hold may be placed on your card', 'Pre-authorization applies'] }),
    );
    expect(unpricedHold.generic?.review?.missing).toEqual(['the hold amount']);
    // Volatile countdown ticks stay ignored even on a review card, while real line edits trigger a fresh card.
    const withTimer = ready(
      decide({
        ...shop,
        lines: [...shop.lines, 'A hold may be placed on your card', 'We are holding your items for 9:59'],
      }),
    );
    const timerTicked = ready(
      decide({
        ...shop,
        lines: [...shop.lines, 'A hold may be placed on your card', 'We are holding your items for 7:42'],
      }),
    );
    expect(materialPurchaseChange(withTimer, timerTicked, {})).toBeUndefined();
    const wordingChanged = ready(
      decide({
        ...shop,
        lines: [...shop.lines, 'A refundable hold may be placed on your card', 'Pre-authorization applies'],
      }),
    );
    expect(materialPurchaseChange(unpricedHold, wordingChanged, {})).toBe('The checkout page changed.');
  });

  it('reads recurring and trial terms, and flags an unreadable frequency or end date for screenshot review', () => {
    const club = ready(
      decide({ ...shop, lines: [...shop.lines, 'Membership: $12.00/month, renews automatically until you cancel.'] }),
    );
    expect(club.commitments).toEqual([
      {
        kind: 'subscription',
        terms: 'Membership: $12.00/month, renews automatically until you cancel.',
        amountMinor: 1200,
        frequency: 'monthly',
      },
    ]);
    const trial = ready(
      decide({ ...shop, lines: [...shop.lines, 'Your free trial ends on November 17, 2026, then $12.00/month.'] }),
    );
    expect(trial.commitments).toEqual([
      {
        kind: 'trial',
        terms: 'Your free trial ends on November 17, 2026, then $12.00/month.',
        amountMinor: 1200,
        conversionAt: '2026-11-17T12:00:00.000Z',
        frequency: 'monthly',
      },
    ]);
    const unreadTrial = ready(
      decide({ ...shop, lines: [...shop.lines, 'Start your free trial today, then $12.00/month.'] }),
    );
    expect(unreadTrial.generic?.review?.missing).toEqual(['the date the trial ends']);
    expect(completePurchaseFacts(unreadTrial)).toBe(false);
    const unreadRecurring = ready(
      decide({ ...shop, lines: [...shop.lines, 'Membership $12.00, renews automatically.'] }),
    );
    expect(unreadRecurring.generic?.review?.missing).toEqual(['the recurring frequency']);
    expect(completePurchaseFacts(unreadRecurring)).toBe(false);
  });

  it('makes no term of a membership named as an item, or of a newsletter’s frequency', () => {
    const facts = ready(
      decide({
        ...shop,
        lines: ['Clay club membership × 1', ...shop.lines.slice(3), 'Send me the weekly newsletter'],
      }),
    );
    expect(facts.commitments).toEqual([]);
    expect(facts.generic?.items).toEqual(['Clay club membership × 1']);
  });

  it('keeps a hold countdown out of every fact, so a changing one is never material', () => {
    const before = ready(decide({ ...shop, lines: [...shop.lines, 'We are holding your items for 9:59'] }));
    const after = ready(decide({ ...shop, lines: [...shop.lines, 'We are holding your items for 7:42'] }));
    expect(before.commitments).toEqual([]);
    expect(materialPurchaseChange(before, after, {})).toBeUndefined();
  });

  it('names a total rise, a new currency, item, payment method, term, email or note, and a moved checkout as material', () => {
    const approved = ready(decide(shop));
    const changed = (lines: string[], fields = shop.fields, frameUrl?: string): string | undefined =>
      materialPurchaseChange(approved, ready(decide({ lines, fields, ...(frameUrl ? { frameUrl } : {}) })), {});
    expect(changed(shop.lines.map((line) => line.replace('$42.00', '$43.00')))).toBe(
      'The total rose to $43.00, from $42.00.',
    );
    expect(changed(shop.lines.map((line) => line.replace('$42.00', '$41.00')))).toBeUndefined();
    expect(changed(shop.lines.map((line) => line.replace('$42.00', '€42.00')))).toBe('The currency changed.');
    expect(changed([...shop.lines.slice(0, 3), 'Teapot × 1', ...shop.lines.slice(3)])).toBe('The items changed.');
    expect(changed(shop.lines.map((line) => line.replace('4242', '1881')))).toBe('The payment method changed.');
    expect(changed([...shop.lines, 'Membership: $12.00/month, renews automatically until you cancel.'])).toBe(
      'The financial terms changed.',
    );
    expect(changed(shop.lines, [email('morgan@example.test')])).toBe('The contact email changed.');
    const note = field({
      tag: 'textarea',
      name: 'note',
      label: 'Delivery instructions',
      value: 'Leave it at the door',
    });
    expect(changed(shop.lines, [...(shop.fields ?? []), note])).toBe('The note changed.');
    expect(changed(shop.lines, shop.fields, 'https://pay.example/c/pottery-42')).toBe('The checkout page changed.');
    // A next step's own commit label is no change.
    expect(
      materialPurchaseChange(approved, { ...approved, control: { ...approved.control, label: 'Continue' } }, {}),
    ).toBeUndefined();
  });
});

describe('the free-commit test', () => {
  const party = field({ tag: 'select', type: 'select-one', name: 'party', label: 'Party size', value: '2' });
  const table: Shown = {
    label: 'Reserve now',
    lines: ['Party size 2', 'No payment is needed to reserve.'],
    fields: [party],
    frameUrl: 'https://table.example/book/r-8',
  };

  it('frees a booking that states no money and offers no way to pay, whatever the page says outside its form', () => {
    const decision = decide(
      {
        ...table,
        frames: [
          frame({
            url: 'https://table.example/book/r-8',
            heading: 'Bistro Juno',
            lines: ['Bistro Juno', 'No credit card required to browse our menus.', 'Gift cards'],
          }),
        ],
      },
      'table.example',
    );
    expect(decision).toEqual({
      status: 'free',
      facts: {
        flowId: 'generic-checkout-v1',
        site: 'table.example',
        origin: 'https://table.example',
        control: { label: 'Reserve now', locator },
        account: 'guest checkout',
        guest: true,
        items: ['Party size 2'],
        booking: { venue: 'Bistro Juno', partySize: 2 },
      },
    });
  });

  it.each([
    ['a no-show fee', { lines: [...table.lines, 'No-show fee: $25 per person'] }],
    ['fee wording that is no denial', { lines: [...table.lines, 'A no show fee applies to missed tables.'] }],
    ['a fee beside a denial', { lines: [...table.lines, 'No deposit needed; a no-show fee applies.'] }],
    ['a card field', { fields: [party, field({ name: 'cardnumber', card: true, value: null })] }],
    ['an express-pay button on the page', { frames: [frame({ expressPay: ['Google Pay'] })] }],
    ['a saved card on the page', { frames: [frame({ lines: ['Saved card: Visa ending in 4242'] })] }],
    ['a payment frame on the page', { frames: [frame({ paymentEntry: true })] }],
  ])('never frees a booking beside %s', (_name, shown) => {
    expect(decide({ ...table, ...shown }, 'table.example').status).not.toBe('free');
  });

  it('reads a booking’s fee, venue, party size and time for the standing guarantee', () => {
    const fee = ready(
      decide(
        {
          label: 'Reserve now',
          lines: [
            'Party size 2',
            'Dinner on Saturday, October 24, 7:00 PM',
            'Cancellation fee',
            '$25 per person for cancellations within 24 hours',
            'Card on file: Visa ending in 4242',
          ],
          fields: [party, email('aya.web@example.test')],
          times: [{ datetime: '2026-10-24T19:00:00-07:00', text: 'Saturday, October 24, 7:00 PM' }],
          frameUrl: 'https://trattoria.example/book',
          frames: [frame({ url: 'https://trattoria.example/book', heading: 'Trattoria Remy' })],
        },
        'trattoria.example',
      ),
    );
    expect(fee).toMatchObject({
      totalMinor: 0,
      dueNowMinor: 0,
      commitments: [
        {
          kind: 'conditional_fee',
          terms: 'Cancellation fee: $25 per person for cancellations within 24 hours',
          amountMinor: 2500,
          conditionalTrigger: 'cancellation',
          perPerson: true,
          cancellationDeadline: '2026-10-24T02:00:00.000Z',
        },
      ],
      generic: {
        booking: {
          venue: 'Trattoria Remy',
          partySize: 2,
          at: '2026-10-25T02:00:00.000Z',
          timeZone: '-07:00',
          timeText: 'Saturday, October 24, 7:00 PM',
        },
      },
    });
  });

  it('keeps preliminary entry pages and step controls out of free state while preserving real free appointments and waitlists', () => {
    expect(
      decide(
        {
          label: 'Book now',
          lines: ['Choose a location', 'Downtown studio', 'Uptown studio'],
          fields: [],
          frameUrl: 'https://salon.example/providers/cedar',
          frames: [frame({ url: 'https://salon.example/providers/cedar', heading: 'Cedar Studio' })],
        },
        'salon.example',
      ),
    ).toEqual({
      status: 'facts_incomplete',
      missing: ['the items'],
    });
    expect(decide({ ...table, label: 'Continue to details' }, 'table.example')).toEqual({
      status: 'facts_incomplete',
      missing: ['the final confirmation button'],
    });
    expect(
      decide(
        {
          label: 'Join waitlist',
          lines: ['Party of 2'],
          fields: [],
          frameUrl: 'https://table.example/waitlist',
        },
        'table.example',
      ),
    ).toMatchObject({
      status: 'free',
      facts: { control: { label: 'Join waitlist' }, items: ['Party of 2'], booking: { partySize: 2 } },
    });
    expect(
      decide(
        {
          label: 'Book appointment',
          lines: ['No payment is needed to book.'],
          times: [{ datetime: '2026-11-20T14:00:00-08:00', text: 'Friday, November 20 at 2:00 PM' }],
          frameUrl: 'https://salon.example/book/confirm',
          frames: [frame({ url: 'https://salon.example/book/confirm', heading: 'Cedar Studio' })],
        },
        'salon.example',
      ),
    ).toMatchObject({
      status: 'free',
      facts: {
        items: ['Cedar Studio, Friday, November 20 at 2:00 PM'],
        booking: { venue: 'Cedar Studio', timeText: 'Friday, November 20 at 2:00 PM' },
      },
    });
  });

  it('returns card_needed when a card is required without a saved method, supports explicit pay-at-property terms, and avoids false fee warnings', () => {
    const cardInput = field({ name: 'cardnumber', card: true, value: null });
    expect(
      decide(
        {
          ...table,
          lines: ['Party size 2', 'No-show fee applies to missed reservations.'],
          fields: [party, cardInput, email('aya.web@example.test')],
        },
        'table.example',
      ),
    ).toEqual({
      status: 'card_needed',
      needed: { site: 'table.example', account: 'guest checkout', items: ['Party size 2'] },
    });
    const unpricedSurcharge = ready(
      decide(
        {
          ...table,
          lines: ['Party size 2', 'A booking surcharge applies.'],
          fields: [party],
        },
        'table.example',
      ),
    );
    expect(unpricedSurcharge.generic?.review?.missing).toContain('the fee amount');
    expect(completePurchaseFacts(unpricedSurcharge)).toBe(false);
    expect(
      guaranteeCoversReservation({ currency: 'USD', max_total_minor: 10000, revoked_at: null }, unpricedSurcharge, {
        reservation: {
          venueId: 'table.example',
          partySize: 2,
          windowStart: '2026-10-20T00:00:00.000Z',
          windowEnd: '2026-10-30T00:00:00.000Z',
        },
      }),
    ).toBe(false);
    expect(
      decide(
        {
          ...table,
          lines: ['Party size 2', 'A card is required to hold this table.'],
          fields: [party],
        },
        'table.example',
      ),
    ).toEqual({
      status: 'card_needed',
      needed: { site: 'table.example', account: 'guest checkout', items: ['Party size 2'] },
    });
    const salonUnpriced = ready(
      decide(
        {
          label: 'Confirm appointment',
          lines: [
            'Due now: $0.00',
            'No-show fee: $25.00 if you miss your appointment.',
            'A booking surcharge applies.',
            'No credit card is required — pay at the salon.',
          ],
          fields: [email('aya.web@example.test')],
          times: [{ datetime: '2026-11-20T14:00:00-08:00', text: 'Friday, November 20 at 2:00 PM' }],
          frameUrl: 'https://salon.example/book/confirm',
          frames: [frame({ url: 'https://salon.example/book/confirm', heading: 'Cedar Studio' })],
        },
        'salon.example',
      ),
    );
    expect(salonUnpriced.generic?.review?.missing).toEqual(['the fee amount']);
    expect(completePurchaseFacts(salonUnpriced)).toBe(false);
    expect(
      decide(
        {
          ...table,
          lines: ['Party size 2', 'A card is required to hold this table.', 'No-show fee: $25 per person.'],
          fields: [party, email('aya.web@example.test')],
        },
        'table.example',
      ),
    ).toMatchObject({
      status: 'card_needed',
      needed: { site: 'table.example', items: ['Party size 2'], total: '$0.00' },
    });
    const missingPaymentTerms = ready(
      decide(
        {
          ...table,
          lines: ['Party size 2', 'No-show fee: $25 per person.'],
          fields: [party, email('aya.web@example.test')],
        },
        'table.example',
      ),
    );
    expect(missingPaymentTerms.generic?.review?.missing).toEqual(['the payment terms']);

    const venuePaid = ready(
      decide(
        {
          label: 'Confirm appointment',
          lines: [
            'Due now: $0.00',
            'No-show fee: $25.00 if you miss your appointment.',
            'No credit card is required — pay at the salon.',
          ],
          fields: [email('aya.web@example.test')],
          times: [{ datetime: '2026-11-20T14:00:00-08:00', text: 'Friday, November 20 at 2:00 PM' }],
          frameUrl: 'https://salon.example/book/confirm',
          frames: [frame({ url: 'https://salon.example/book/confirm', heading: 'Cedar Studio' })],
        },
        'salon.example',
      ),
    );
    expect(completePurchaseFacts(venuePaid)).toBe(true);
    expect(venuePaid).toMatchObject({
      totalMinor: 0,
      dueNowMinor: 0,
      cardEnding: null,
      commitments: [{ kind: 'conditional_fee', conditionalTrigger: 'no_show', amountMinor: 2500 }],
      generic: {
        items: ['Cedar Studio, Friday, November 20 at 2:00 PM'],
        payment: 'No credit card is required — pay at the salon.',
      },
    });
    const switchedToSavedCard = ready(
      decide(
        {
          label: 'Confirm appointment',
          lines: [
            'Due now: $0.00',
            'No-show fee: $25.00 if you miss your appointment.',
            'Saved card: Visa ending in 4242',
          ],
          fields: [email('aya.web@example.test')],
          times: [{ datetime: '2026-11-20T14:00:00-08:00', text: 'Friday, November 20 at 2:00 PM' }],
          frameUrl: 'https://salon.example/book/confirm',
          frames: [frame({ url: 'https://salon.example/book/confirm', heading: 'Cedar Studio' })],
        },
        'salon.example',
      ),
    );
    expect(materialPurchaseChange(venuePaid, switchedToSavedCard, {})).toBe('The payment method changed.');

    // "Includes taxes and fees" and verb "charge you" are not unpriced fees, and "No prepayment needed" + "Pay with the property" resolves cleanly.
    const payAtPropertyComplete = ready(
      decide(
        {
          label: 'Complete booking',
          lines: [
            'Your booking',
            'Deluxe Room × 1',
            'Total US$86.13',
            'Includes taxes and fees',
            'Price information',
            'Includes $12.30 in taxes and fees',
            'No prepayment needed',
            'Pay with the property',
            'The property will handle payment. The date they charge you will depend on your booking conditions.',
          ],
          fields: [email('aya.web@example.test')],
          frameUrl: 'https://booking.example/book.html',
          frames: [frame({ url: 'https://booking.example/book.html', heading: 'Monty Suites Calabar' })],
        },
        'booking.example',
      ),
    );
    expect(completePurchaseFacts(payAtPropertyComplete)).toBe(true);
    expect(payAtPropertyComplete).toMatchObject({
      currency: 'USD',
      totalMinor: 8613,
      dueNowMinor: 0,
      cardEnding: null,
      generic: { payment: 'Pay with the property' },
    });

    // An extra unpriced fee on the same line as "Includes taxes and fees" is still flagged,
    // and negated inclusion wording ("Not all fees are included") is never stripped.
    const includedPlusExtraFee = ready(
      decide({
        ...shop,
        lines: [...shop.lines, 'Includes taxes and fees. A resort fee applies at check-in.'],
      }),
    );
    expect(includedPlusExtraFee.generic?.review?.missing).toEqual(['the fee amount']);
    const notAllFeesIncluded = ready(
      decide({
        ...shop,
        lines: [...shop.lines, 'Not all fees are included.'],
      }),
    );
    expect(notAllFeesIncluded.generic?.review?.missing).toEqual(['the fee amount']);
    const notAllTaxesAndFeesIncluded = ready(
      decide({
        ...shop,
        lines: [...shop.lines, 'Not all taxes and fees are included.'],
      }),
    );
    expect(notAllTaxesAndFeesIncluded.generic?.review?.missing).toEqual(['the fee amount']);

    // An unpriced deposit beside a priced cancellation fee must not invent a verified $0.00 total.
    const unpricedDeposit = ready(
      decide({
        label: 'Confirm reservation',
        lines: ['Table for 2', 'A deposit is required.', 'Cancellation fee: $25.00.'],
        fields: [email('aya.web@example.test')],
        frameUrl: 'https://table.example/book',
        frames: [frame({ url: 'https://table.example/book', lines: ['Visa ending in 4242'] })],
      }),
    );
    expect(unpricedDeposit.generic?.review?.missing).toContain('the deposit amount');
    expect(unpricedDeposit.generic?.review?.missing).toContain('the total');

    // A pay-at-property checkout with a saved card on file must not infer the full total is due now.
    const payLaterWithSavedCard = ready(
      decide(
        {
          label: 'Complete booking',
          lines: ['Deluxe Room × 1', 'Total US$86.13', 'Pay with the property', 'Visa ending in 4242'],
          fields: [email('aya.web@example.test')],
          frameUrl: 'https://booking.example/book.html',
          frames: [frame({ url: 'https://booking.example/book.html', heading: 'Monty Suites Calabar' })],
        },
        'booking.example',
      ),
    );
    expect(payLaterWithSavedCard.generic?.review?.missing).toEqual(['the amount due now']);

    // Relative trial durations stay stable across rereads within the same day.
    const trialFirst = ready(
      decide(
        {
          ...shop,
          lines: ['Pro plan × 1', 'Total $0.00', '7-day free trial, then $12.00/month', 'Visa ending in 4242'],
          fields: [],
        },
        'pottery.example',
        NOW,
      ),
    );
    const trialLater = ready(
      decide(
        {
          ...shop,
          lines: ['Pro plan × 1', 'Total $0.00', '7-day free trial, then $12.00/month', 'Visa ending in 4242'],
          fields: [],
        },
        'pottery.example',
        NOW + 120_000,
      ),
    );
    expect(materialPurchaseChange(trialFirst, trialLater, {})).toBeUndefined();

    // Header signed-in account changes require a new approval even when contact email and snapshot stay identical.
    const signedInMorgan = ready(
      decide({
        ...shop,
        frames: [frame({ url: 'https://pottery.example/checkout/review', lines: ['Signed in as Morgan'] })],
      }),
    );
    const signedInTaylor = ready(
      decide({
        ...shop,
        frames: [frame({ url: 'https://pottery.example/checkout/review', lines: ['Signed in as Taylor'] })],
      }),
    );
    expect(materialPurchaseChange(signedInMorgan, signedInTaylor, {})).toBe('The account changed.');

    // Booking.com Step 3 without email or "No prepayment needed": not card_needed and not a false fee failure,
    // routed to screenshot-backed review with total and payment method preserved.
    const bookingStep3 = ready(
      decide(
        {
          label: 'Complete booking',
          lines: [
            'Monty Suites Calabar',
            'Total US$86.13',
            'Includes taxes and fees',
            'Price information',
            'Includes $12.30 in taxes and fees',
            'Pay with the property',
            'The property will handle payment. The date they charge you will depend on your booking conditions.',
          ],
          fields: [],
          frameUrl: 'https://booking.example/book.html',
          frames: [frame({ url: 'https://booking.example/book.html', heading: 'Monty Suites Calabar' })],
        },
        'booking.example',
      ),
    );
    expect(bookingStep3).toMatchObject({
      currency: 'USD',
      totalMinor: 8613,
      generic: { payment: 'Pay with the property' },
    });
    expect(bookingStep3.generic?.review?.missing).not.toContain('the fee amount');
    expect(bookingStep3.generic?.review?.missing).toContain('the contact email');
    expect(bookingStep3.generic?.review?.missing).toContain('the amount due now');

    // If a card entry field IS present on a pay-at-property step with no saved card, it still returns card_needed.
    expect(
      decide(
        {
          label: 'Complete booking',
          lines: ['Monty Suites Calabar', 'Total US$86.13', 'Pay with the property'],
          fields: [cardInput],
          frameUrl: 'https://booking.example/book.html',
          frames: [frame({ url: 'https://booking.example/book.html', heading: 'Monty Suites Calabar' })],
        },
        'booking.example',
      ),
    ).toMatchObject({ status: 'card_needed', needed: { site: 'booking.example', total: '$86.13' } });
  });

  it('binds ambiguous contact-email candidates to review approvals and ignores secret/card email values', () => {
    const ambiguous = ready(
      decide({
        ...shop,
        fields: [
          email('Aya.Web@example.test'),
          field({ type: 'email', name: 'recipient_email', label: 'Recipient email', value: 'morgan@example.test' }),
          field({ type: 'email', name: 'secret_email', label: 'Email', value: 'secret@example.test', secret: true }),
          field({ type: 'email', name: 'card_email', label: 'Card email', value: 'card@example.test', card: true }),
        ],
      }),
    );
    expect(ambiguous.generic?.contactEmail).toBeUndefined();
    expect(ambiguous.generic?.review?.missing).toEqual(['the contact email']);
    expect(ambiguous.generic?.review?.contactEmails).toEqual(['aya.web@example.test', 'morgan@example.test']);
    expect(validReviewPurchaseFacts(ambiguous)).toBe(true);
    expect(authorizablePurchaseFacts(ambiguous, 'checkout')).toBe(true);
    expect(authorizablePurchaseFacts(ambiguous, 'watch')).toBe(false);
    expect(authorizablePurchaseFacts(ambiguous, 'reservation_guarantee')).toBe(false);

    const mutated = ready(
      decide({
        ...shop,
        fields: [
          email('aya.web@example.test'),
          field({ type: 'email', name: 'recipient_email', label: 'Recipient email', value: 'attacker@example.test' }),
        ],
      }),
    );
    expect(materialPurchaseChange(ambiguous, mutated, {})).toBe('The contact email changed.');

    const swapped = ready(
      decide({
        ...shop,
        fields: [
          email('morgan@example.test'),
          field({ type: 'email', name: 'recipient_email', label: 'Recipient email', value: 'aya.web@example.test' }),
        ],
      }),
    );
    expect(materialPurchaseChange(ambiguous, swapped, {})).toBe('The contact email changed.');

    expect(
      validReviewPurchaseFacts({
        ...ambiguous,
        generic: {
          ...ambiguous.generic!,
          review: { ...ambiguous.generic!.review!, contactEmails: ['aya.web@example.test'] },
        },
      }),
    ).toBe(false);
    expect(
      validReviewPurchaseFacts({
        ...ambiguous,
        generic: {
          ...ambiguous.generic!,
          contactEmail: 'aya.web@example.test',
        },
      }),
    ).toBe(false);
  });

  it('refuses generic evidence matching via shared guest or unnamed-account strings', () => {
    const guestReview = ready(
      decide(
        {
          label: 'Complete booking',
          lines: ['Monty Suites Calabar', 'Total US$86.13', 'Pay with the property'],
          fields: [],
          frameUrl: 'https://booking.example/book.html',
          frames: [frame({ url: 'https://booking.example/book.html', heading: 'Monty Suites Calabar' })],
        },
        'booking.example',
      ),
    );
    expect(genericAccountKey(guestReview)).toBeUndefined();
    const guestEvidence = {
      flowId: GENERIC_FLOW_ID,
      source: 'https://booking.example/book/confirmed',
      recordId: 'BK-9021',
      orderedAt: new Date(NOW).toISOString(),
      resolution: 'committed' as const,
      account: 'guest checkout',
      items: [],
      totalMinor: 8613,
      currency: 'USD',
      cardEnding: null,
      address: null,
    };
    expect(
      evidenceMatchesAttempt(guestEvidence, {
        facts_json: JSON.stringify(guestReview),
        attempted_at: new Date(NOW).toISOString(),
      }),
    ).toBe(false);

    const unnamedSignedIn = ready(
      decide(
        {
          label: 'Complete booking',
          lines: ['Monty Suites Calabar', 'Total US$86.13', 'Pay with the property'],
          fields: [],
          frameUrl: 'https://booking.example/book.html',
          frames: [
            frame({ url: 'https://booking.example/book.html', heading: 'Monty Suites Calabar', signedIn: true }),
          ],
        },
        'booking.example',
      ),
    );
    expect(genericAccountKey(unnamedSignedIn)).toBeUndefined();
    expect(
      evidenceMatchesAttempt(
        { ...guestEvidence, account: 'the signed-in account' },
        { facts_json: JSON.stringify(unnamedSignedIn), attempted_at: new Date(NOW).toISOString() },
      ),
    ).toBe(false);

    const namedSignedInNoEmail = ready(
      decide(
        {
          label: 'Complete booking',
          lines: ['Monty Suites Calabar', 'Total US$86.13', 'Pay with the property'],
          fields: [],
          frameUrl: 'https://booking.example/book.html',
          frames: [
            frame({
              url: 'https://booking.example/book.html',
              heading: 'Monty Suites Calabar',
              lines: ['Signed in as Morgan'],
            }),
          ],
        },
        'booking.example',
      ),
    );
    expect(genericAccountKey(namedSignedInNoEmail)).toBeUndefined();
    expect(
      evidenceMatchesAttempt(
        { ...guestEvidence, account: 'Morgan' },
        { facts_json: JSON.stringify(namedSignedInNoEmail), attempted_at: new Date(NOW).toISOString() },
      ),
    ).toBe(false);

    const emailBound = ready(decide(shop));
    expect(genericAccountKey(emailBound)).toBe('aya.web@example.test');
    expect(
      evidenceMatchesAttempt(
        { ...guestEvidence, account: 'aya.web@example.test' },
        { facts_json: JSON.stringify(emailBound), attempted_at: new Date(NOW).toISOString() },
      ),
    ).toBe(true);
  });
});

it('tells a decline on the page from another failure', () => {
  expect(pressRefusal(['Your card was declined. Try another card.'])).toBe('declined');
  expect(pressRefusal(['Something went wrong. Please try again.'])).toBe('failed');
  expect(pressRefusal(['If your card is ever refused, call your bank.'])).toBeUndefined();
});
