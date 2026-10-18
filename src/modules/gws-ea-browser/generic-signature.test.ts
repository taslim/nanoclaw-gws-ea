/** The generic signature's decisions and fact floor, from host reads shaped as the isolated-world reader returns them. */
import { describe, expect, it } from 'vitest';

import type { CheckoutField, CheckoutFrame, CheckoutRead } from './control-facts.js';
import { completePurchaseFacts, materialPurchaseChange, type PurchaseFacts } from './fingerprint.js';
import { decideGenericCheckout, pressRefusal, type GenericDecision } from './generic-signature.js';

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
const decide = (shown: Shown, merchant = 'pottery.example'): GenericDecision =>
  decideGenericCheckout(read(shown), { merchant, locator, controlBox: { x: 60, y: 450, width: 120, height: 30 } }, NOW);
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

  it('stops naming what it cannot read', () => {
    expect(decide({ ...shop, fields: [email('aya.web@example.test'), email('morgan@example.test')] })).toEqual({
      status: 'facts_incomplete',
      missing: ['the contact email'],
    });
    expect(decide({ ...shop, lines: ['Visa ending in 4242', 'Order total $42.00'] })).toEqual({
      status: 'facts_incomplete',
      missing: ['the items'],
    });
    expect(
      decide({ ...shop, lines: [...shop.lines, 'A hold may be placed on your card', 'Pre-authorization applies'] }),
    ).toEqual({
      status: 'facts_incomplete',
      missing: ['the hold amount'],
    });
  });

  it('reads recurring and trial terms, and names an unreadable frequency or end date', () => {
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
    expect(decide({ ...shop, lines: [...shop.lines, 'Start your free trial today, then $12.00/month.'] })).toEqual({
      status: 'facts_incomplete',
      missing: ['the date the trial ends'],
    });
    expect(decide({ ...shop, lines: [...shop.lines, 'Membership $12.00, renews automatically.'] })).toEqual({
      status: 'facts_incomplete',
      missing: ['the recurring frequency'],
    });
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

  it('names a total rise, a new item, a new payment method, a changed email and a moved checkout as material', () => {
    const approved = ready(decide(shop));
    const changed = (lines: string[], fields = shop.fields, frameUrl?: string): string | undefined =>
      materialPurchaseChange(approved, ready(decide({ lines, fields, ...(frameUrl ? { frameUrl } : {}) })), {});
    expect(changed(shop.lines.map((line) => line.replace('$42.00', '$43.00')))).toBe(
      'The total rose to $43.00, from $42.00.',
    );
    expect(changed(shop.lines.map((line) => line.replace('$42.00', '$41.00')))).toBeUndefined();
    expect(changed([...shop.lines.slice(0, 3), 'Teapot × 1', ...shop.lines.slice(3)])).toBe('The items changed.');
    expect(changed(shop.lines.map((line) => line.replace('4242', '1881')))).toBe('The payment method changed.');
    expect(changed(shop.lines, [email('morgan@example.test')])).toBe('The contact email changed.');
    expect(changed(shop.lines, shop.fields, 'https://pay.example/c/pottery-42')).toBe('The checkout origin changed.');
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
});

it('tells a decline on the page from another failure', () => {
  expect(pressRefusal(['Your card was declined. Try another card.'])).toBe('declined');
  expect(pressRefusal(['Something went wrong. Please try again.'])).toBe('failed');
  expect(pressRefusal(['If your card is ever refused, call your bank.'])).toBeUndefined();
});
