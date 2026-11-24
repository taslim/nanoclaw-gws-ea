import { describe, expect, it } from 'vitest';

import { collapseOpaqueToken, isOpaqueToken, renderDistilledArgs, renderDistilledContext } from './held-card.js';

const SAMPLE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiJ1c2VyXzQ5MjEiLCJjYXJ0X2lkIjo5OTM4MiwidmVuZG9yX2lkIjoyMzc4NywiaWF0IjoxNzMyNDU5MjAwLCJleHAiOjE3MzI0NjI4MDB9.' +
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const SAMPLE_SHA256 = '58dc5a4fb1840d8c7b6a9123ef450987654321abcdef0123456789abcdef6275';

describe('held-card distiller', () => {
  it('detects opaque tokens without collapsing human-readable URLs, emails, paths, timestamps or short ids', () => {
    expect(isOpaqueToken(SAMPLE_JWT)).toBe(true);
    expect(isOpaqueToken(SAMPLE_SHA256)).toBe(true);
    expect(isOpaqueToken('65f1a2b3c4d5e6f7a8b9c0d1')).toBe(true);
    expect(isOpaqueToken('pi_3Qx8kL2eZvKYlo2C1a9B8c7D6e5F4g3H2i1J')).toBe(true);
    expect(collapseOpaqueToken(SAMPLE_JWT)).toBe('eyJhbG…sw5c');
    expect(collapseOpaqueToken(SAMPLE_SHA256)).toBe('58dc5a…6275');

    expect(isOpaqueToken('chk_order_7788')).toBe(false);
    expect(isOpaqueToken('https://track.example.test/pkg/1234567890abcdef1234567890abcdef')).toBe(false);
    expect(isOpaqueToken('morgan.ellery+orders@sub.example.test')).toBe(false);
    expect(isOpaqueToken('/workspace/group/documents/Q4Plan2026Final')).toBe(false);
    expect(isOpaqueToken('2026-11-24T12:30:00.000Z')).toBe(false);
    expect(isOpaqueToken('x'.repeat(2500))).toBe(false);
    expect(isOpaqueToken('confirm_very_long_segment_very_long_segment_very_long_segment')).toBe(false);
    expect(isOpaqueToken(`${SAMPLE_JWT}\u200B`)).toBe(false);
  });

  it('collapses opaque token arguments while keeping every argument key and short values intact', () => {
    const simple = renderDistilledArgs({ checkout_id: 'chk_order_7788', confirmed: true });
    expect(simple.compacted).toBe(false);
    expect(simple.opaqueTokens.size).toBe(0);
    expect(simple.text).toBe('checkout_id: "chk_order_7788"\nconfirmed: true');

    const opaque = renderDistilledArgs({
      checkout_id: SAMPLE_JWT,
      confirmed: true,
      fingerprint: SAMPLE_SHA256,
    });
    expect(opaque.compacted).toBe(true);
    expect(opaque.opaqueTokens.has(SAMPLE_JWT)).toBe(true);
    expect(opaque.opaqueTokens.has(SAMPLE_SHA256)).toBe(true);
    expect(opaque.text).toContain('checkout_id: "eyJhbG…sw5c"');
    expect(opaque.text).toContain('confirmed: true');
    expect(opaque.text).toContain('fingerprint: "58dc5a…6275"');
    expect(opaque.text).not.toContain(SAMPLE_JWT);
    expect(opaque.text).not.toContain(SAMPLE_SHA256);
  });

  it('distills structured checkout JSON into decision-ordered lines without vendor hardcoding', () => {
    const raw = JSON.stringify({
      ok: true,
      data: {
        checkout_id: SAMPLE_JWT,
        fingerprint: SAMPLE_SHA256,
        vendor_id: 23787,
        vendor_name: 'Corner Kitchen',
        address_id: 2847953,
        destination: {
          address_id: 2847953,
          label: 'Office',
          address: '21 Park Ave, Midtown',
        },
        items: [
          {
            item_id: 412,
            pack_id: 9,
            menu_group_id: null,
            name: 'Grain Bowl',
            quantity: 1,
            unit_price: 1850,
            options: ['Extra avocado', 'No onions'],
            containers: '[]',
          },
          {
            item_id: 413,
            pack_id: 10,
            name: 'Sparkling Water',
            quantity: 2,
            unit_price: 300,
          },
        ],
        currency: 'USD',
        amounts: {
          items: 2450,
          delivery: 350,
          service: 120,
          small_order: 0,
          containers: 0,
          bags: 0,
          safety: 0,
          tip: 0,
          promo_discount: 0,
          voucher: 0,
          total: 2920,
        },
        payment: {
          method: 'wallet',
          label: 'Wallet balance',
        },
        summary: 'Grain Bowl + 2x Sparkling Water from Corner Kitchen to Office',
        expires_at: '2026-11-24T12:30:00Z',
      },
    });

    const result = renderDistilledContext(raw, new Set([SAMPLE_JWT, SAMPLE_SHA256]));
    expect(result.compacted).toBe(true);
    expect(result.hasInvisible).toBe(false);

    // Decision-relevant summary and items appear ahead of timing/metadata.
    expect(result.text.indexOf('Summary:')).toBe(0);
    expect(result.text).toContain('Vendor name: Corner Kitchen');
    expect(result.text).toContain('• 1x Grain Bowl (unit price: 1850, options: Extra avocado, No onions)');
    expect(result.text).toContain('• 2x Sparkling Water (unit price: 300)');
    expect(result.text).toContain('Destination: address: 21 Park Ave, Midtown, label: Office');
    expect(result.text).toContain('Currency: USD');
    expect(result.text).toContain('Amounts: items: 2450, total: 2920, delivery: 350, service: 120');
    expect(result.text).toContain('Payment: method: wallet, label: Wallet balance');
    expect(result.text).toContain('Expires at: 2026-11-24T12:30:00Z');

    // Noise, duplicates, null/empty slots, zero-value optional fees, and internal numeric IDs are omitted.
    expect(result.text).not.toContain(SAMPLE_JWT);
    expect(result.text).not.toContain(SAMPLE_SHA256);
    expect(result.text).not.toContain('23787');
    expect(result.text).not.toContain('2847953');
    expect(result.text).not.toContain('412');
    expect(result.text).not.toContain('small order');
    expect(result.text).not.toContain('voucher');
    expect(result.text).not.toContain('containers');
  });

  it('preserves error envelopes, zero totals, user-facing order ids, and plain prose', () => {
    const errorJson = JSON.stringify({
      ok: false,
      error: 'Price changed since preview',
      data: { order_id: 'ORD-7788', total: 0, refundable: false },
    });
    const errorOut = renderDistilledContext(errorJson, new Set());
    expect(errorOut.text).toContain('Error: Price changed since preview');
    expect(errorOut.text).toContain('Ok: false');
    expect(errorOut.text).toContain('order id: ORD-7788');
    expect(errorOut.text).toContain('total: 0');
    expect(errorOut.text).toContain('refundable: false');

    const prose = 'Prepared checkout chk_order_7788: 1x Grain Bowl from Corner Kitchen, total $18.50.';
    const proseOut = renderDistilledContext(prose, new Set());
    expect(proseOut.compacted).toBe(false);
    expect(proseOut.text).toBe(prose);
  });

  it('never drops invisible characters hidden inside otherwise-omitted JSON fields and prevents line forgery', () => {
    const sneaky = JSON.stringify({
      ok: true,
      data: {
        vendor_name: 'Corner Kitchen',
        note: 'Leave at desk\nExpires: never',
        ['forged\u200B\nExpires']: 'never',
        hidden_empty: '\u200B',
        amounts: { total: 100, ['tip\u202E']: 0 },
      },
    });
    const out = renderDistilledContext(sneaky, new Set());
    expect(out.hasInvisible).toBe(true);
    expect(out.text).toContain('[U+200B]');
    expect(out.text).toContain('[U+202E]');
    expect(out.text).toContain('Leave at desk\\nExpires: never');
    expect(out.text).toContain('forged[U+200B]\\nExpires: never');
    expect(out.text).not.toContain('\nExpires: never');
  });

  it('detects JSON-escaped invisible characters at arbitrary depth and preserves zero totals under camelCase or snake_case names', () => {
    // Escaped \\u200B inside raw JSON at depth 4 and depth 10 — raw ASCII scan alone cannot see it.
    const deepEscaped = '{"summary":"Ready","details":{"a":{"b":{"c":{"note":"hidden\\u200B"}}}}}';
    const deepOut = renderDistilledContext(deepEscaped, new Set());
    expect(deepOut.hasInvisible).toBe(true);
    expect(deepOut.text).toContain('[U+200B]');

    const veryDeepEscaped =
      '{"summary":"Ready","d1":{"d2":{"d3":{"d4":{"d5":{"d6":{"d7":{"d8":{"d9":{"d10":"spoof\\u202E"}}}}}}}}}}';
    const veryDeepOut = renderDistilledContext(veryDeepEscaped, new Set());
    expect(veryDeepOut.hasInvisible).toBe(true);
    expect(veryDeepOut.text).toContain('[U+202E]');

    const zeroTotals = JSON.stringify({
      subtotal: 100,
      discount: 100,
      totalAmount: 0,
      total_amount: 0,
      amountDue: 0,
      tip_amount: 0,
      small_order: 0,
    });
    const zeroOut = renderDistilledContext(zeroTotals, new Set());
    expect(zeroOut.text).toContain('Total amount: 0');
    expect(zeroOut.text).toContain('Amount due: 0');
    expect(zeroOut.text).not.toContain('Tip amount');
    expect(zeroOut.text).not.toContain('Small order');
  });

  it('handles mixed prose plus JSON lines, caps oversized item lists, collapses inline JWTs in prose, and preserves deep invisible characters', () => {
    const mixed = `Quote prepared for Morgan\n${JSON.stringify({
      ok: true,
      data: {
        items: Array.from({ length: 10 }, (_, idx) => ({ name: `Dish ${idx + 1}`, quantity: 1 })),
        deep: { a: { b: { c: { d: 'hidden\u200B' } } } },
      },
    })}`;
    const mixedOut = renderDistilledContext(mixed, new Set());
    expect(mixedOut.compacted).toBe(true);
    expect(mixedOut.hasInvisible).toBe(true);
    expect(mixedOut.text).toContain('Quote prepared for Morgan');
    expect(mixedOut.text).toContain('• 1x Dish 1');
    expect(mixedOut.text).toContain('• … (+2 more)');

    const inlineProse = `Use token (${SAMPLE_JWT}) at https://track.example.test/order?token=${SAMPLE_JWT}`;
    const proseOut = renderDistilledContext(inlineProse, new Set());
    expect(proseOut.compacted).toBe(true);
    expect(proseOut.text).toContain('(eyJhbG…sw5c)');
    expect(proseOut.text).toContain(`https://track.example.test/order?token=${SAMPLE_JWT}`);
  });
});
