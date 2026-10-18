import { describe, expect, it } from 'vitest';

import { confirmationEvidence, showsCharge } from './confirmation.js';

const PAGE = 'https://shop.example/orders/thanks?token=secret#top';
const lines = (...text: string[]): string => text.join('\n');
const order = (data: Record<string, unknown>): string => JSON.stringify({ '@context': 'https://schema.org', ...data });

describe('the confirmation reader', () => {
  it('reads a thank-you page with an order number and a charged total, leaving out the address query', () => {
    const evidence = confirmationEvidence(
      PAGE,
      lines(
        'Thank you for your order!',
        'Order number: SO-48213',
        'Order total\t$42.00',
        'Charged to Visa ending in 4242.',
      ),
      [],
    );
    expect(evidence).toEqual({
      source: 'https://shop.example/orders/thanks',
      reference: 'SO-48213',
      charged: { amountMinor: 4200, currency: 'USD' },
      structured: false,
    });
    expect(evidence && showsCharge(evidence)).toBe(true);
  });

  it('takes an amount alone on the line after a short label, and the largest of several charges', () => {
    expect(
      confirmationEvidence(
        PAGE,
        lines(
          'Booking confirmed',
          'Reservation #R-2041',
          'Deposit',
          '$25.00',
          'Total',
          '$1,240.50',
          'Subtotal $9,999.00',
        ),
        [],
      ),
    ).toMatchObject({ reference: 'R-2041', charged: { amountMinor: 124050, currency: 'USD' } });
    expect(confirmationEvidence(PAGE, lines('Thank you', 'Order 4711-22', 'You paid 42,00 €'), [])).toMatchObject({
      charged: { amountMinor: 4200, currency: 'EUR' },
    });
  });

  it('raises no charge for a waitlist number or a $0.00 registration', () => {
    const waitlist = confirmationEvidence(
      PAGE,
      lines("You're on the waitlist", 'Confirmation #W123', "We'll text you when your table is ready."),
      [],
    );
    expect(waitlist).toMatchObject({ reference: 'W123' });
    expect(waitlist?.charged).toBeUndefined();
    const free = confirmationEvidence(
      PAGE,
      lines('Registration confirmed', 'Confirmation number EV-2026-118', 'Total: $0.00'),
      [],
    );
    expect(free).toMatchObject({ reference: 'EV-2026-118', charged: { amountMinor: 0 } });
    for (const evidence of [waitlist, free]) expect(evidence && showsCharge(evidence)).toBe(false);
  });

  it('reads nothing without a labelled number, or a number without thank-you or confirmation wording', () => {
    expect(confirmationEvidence(PAGE, lines('Thank you for visiting', 'Total $42.00'), [])).toBeUndefined();
    expect(confirmationEvidence(PAGE, lines('Track your parcel', 'Order 4711-22', 'Total $42.00'), [])).toBeUndefined();
    // A word after the label is no number.
    expect(confirmationEvidence(PAGE, lines('Thank you', 'Your order is on its way'), [])).toBeUndefined();
  });

  it('reads schema.org Order and Reservation data, which stands for the wording and the number', () => {
    expect(
      confirmationEvidence(PAGE, 'Your receipt', [
        order({ '@type': 'Order', orderNumber: 'A-1009', priceCurrency: 'USD', price: '18.50' }),
      ]),
    ).toEqual({
      source: 'https://shop.example/orders/thanks',
      reference: 'A-1009',
      charged: { amountMinor: 1850, currency: 'USD' },
      structured: true,
    });
    expect(
      confirmationEvidence(PAGE, '', [
        'not json',
        order({
          '@graph': [
            {
              '@type': 'FoodEstablishmentReservation',
              reservationNumber: 'TBL-77',
              totalPrice: { '@type': 'PriceSpecification', price: 0, priceCurrency: 'USD' },
            },
          ],
        }),
      ]),
    ).toMatchObject({ reference: 'TBL-77', charged: { amountMinor: 0 }, structured: true });
    // Other structured data says nothing of an order.
    expect(confirmationEvidence(PAGE, '', [order({ '@type': 'Product', price: '42.00' })])).toBeUndefined();
  });
});
