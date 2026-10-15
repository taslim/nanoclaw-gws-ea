import { expect, it } from 'vitest';
import { classifyControlFacts, classifyNavigationUrl } from './commit-classifier.js';

it('fails closed for unknown one-click controls without requiring visible money', () => {
  expect(
    classifyControlFacts({
      name: 'Get it instantly',
      role: 'button',
      tag: 'button',
      type: 'button',
      href: null,
      transaction: false,
    }),
  ).toBe('unsupported_merchant');
  for (const name of ['Buy now', 'Place order', 'Confirm reservation', 'Start free trial'])
    expect(
      classifyControlFacts({ name, role: 'button', tag: 'button', type: 'submit', href: null, transaction: false }),
    ).toBe('purchase_control');
  expect(
    classifyControlFacts({
      name: 'Search',
      role: 'button',
      tag: 'button',
      type: 'submit',
      href: null,
      transaction: true,
    }),
  ).toBe('unsupported_merchant');
  expect(
    classifyControlFacts({
      name: 'Search',
      role: 'button',
      tag: 'button',
      type: 'submit',
      href: null,
      transaction: false,
      formMethod: 'get',
      formAction: 'https://example.com/search',
    }),
  ).toBe('ordinary');
  expect(
    classifyControlFacts({
      name: 'Search',
      role: 'button',
      tag: 'button',
      type: 'submit',
      href: null,
      transaction: false,
    }),
  ).toBe('unsupported_merchant');
  expect(
    classifyControlFacts({
      name: 'Search',
      visibleLabel: 'Place order',
      role: 'button',
      tag: 'button',
      type: 'submit',
      href: null,
      transaction: false,
    }),
  ).toBe('purchase_control');
  expect(
    classifyControlFacts({ name: 'Choose', role: 'combobox', tag: 'select', type: '', href: null, transaction: false }),
  ).toBe('unsupported_merchant');
});

it('blocks commit URLs and external protocols before navigation', () => {
  expect(classifyNavigationUrl('https://shop.example/buy?oneclick=1')).toBe('purchase_control');
  expect(classifyNavigationUrl('https://shop.example/unknown-action')).toBe('unsupported_merchant');
  expect(classifyNavigationUrl('https://shop.example/search?q=restaurant')).toBe('ordinary');
  expect(classifyNavigationUrl('file:///etc/passwd')).toBe('blocked_address');
});
