import { afterEach, expect, it, vi } from 'vitest';
import type { ElementHandle, Page } from 'playwright-core';
import * as nativeAuthentication from './authentication-submit.js';
afterEach(() => vi.restoreAllMocks());
import {
  activateControl,
  classifyControlFacts,
  classifyNavigationUrl,
  registerReviewedMerchantFlow,
} from './commit-classifier.js';

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

it('submits positively identified native authentication forms without invoking arbitrary page callbacks', async () => {
  registerReviewedMerchantFlow({
    id: 'test-unhandled-auth-flow',
    matches: (url) => url.hostname === 'auth-dispatch.example',
    classifyControl: async () => 'unsupported_merchant',
    classifyNavigation: () => 'unsupported_merchant',
  });
  const native = vi.fn();
  const frame = { url: () => 'https://auth-dispatch.example/login' };
  const form = {
    action: 'https://auth-dispatch.example/login',
    method: 'post',
    target: '',
    elements: [
      { name: 'username', type: 'text', getAttribute: () => 'username' },
      { name: 'password', type: 'password', getAttribute: () => 'current-password' },
    ],
    querySelector: () => true,
  };
  const node = {
    tagName: 'BUTTON',
    type: 'submit',
    textContent: 'Sign in',
    form,
    getAttribute: (name: string) => (name === 'type' ? 'submit' : null),
    ownerDocument: {
      location: { origin: 'https://auth-dispatch.example' },
      defaultView: { HTMLFormElement: { prototype: { submit: native } } },
    },
  };
  const element = {
    ownerFrame: async () => frame,
    evaluate: async (fn: (node: unknown, argument: unknown) => unknown, argument: unknown) => fn(node, argument),
  } as unknown as ElementHandle;
  const page = {
    url: () => frame.url(),
    locator: () => ({ innerText: async () => '' }),
    waitForEvent: async () => undefined,
    once: () => undefined,
    context: () => ({ newCDPSession: async () => ({ on: () => undefined, send: async () => undefined }) }),
  } as unknown as Page;
  // This unit mocks only the native Chrome object binding. Native-world integrity has its own real-renderer suite.
  vi.spyOn(nativeAuthentication, 'inspectNativeAuthenticationControl').mockResolvedValue({
    facts: {
      origin: 'https://auth-dispatch.example',
      action: form.action,
      method: 'post',
      submit: true,
      fields: [
        { name: 'username', type: 'text', autocomplete: 'username' },
        { name: 'password', type: 'password', autocomplete: 'current-password' },
      ],
    },
  } as unknown as NonNullable<Awaited<ReturnType<typeof nativeAuthentication.inspectNativeAuthenticationControl>>>);
  vi.spyOn(nativeAuthentication, 'submitNativeAuthenticationForm').mockImplementation(async () => {
    native();
    return true;
  });
  const arbitraryCallback = vi.fn(async () => undefined);
  await activateControl(page, element, arbitraryCallback);
  expect(native).toHaveBeenCalledTimes(1);
  expect(arbitraryCallback).not.toHaveBeenCalled();
  form.action = 'https://auth-dispatch.example/place-order';
  await expect(activateControl(page, element, arbitraryCallback)).rejects.toMatchObject({ reason: 'purchase_control' });
  expect(arbitraryCallback).not.toHaveBeenCalled();
});

it('recognizes the reviewed read-only Amazon review URL and refuses unknown activating/security paths', () => {
  expect(classifyNavigationUrl('https://www.amazon.com/gp/buy/spc/handlers/display.html')).toBe('ordinary');
  expect(classifyNavigationUrl('https://www.amazon.com/gp/buy/spc/handlers/static-submit-decoupled.html')).toBe(
    'purchase_control',
  );
  expect(classifyNavigationUrl('https://www.amazon.com/gp/buy/spc/handlers/display.html?action=buy')).toBe(
    'purchase_control',
  );
  expect(classifyNavigationUrl('https://www.amazon.com/unknown-oneclick')).toBe('purchase_control');
  for (const [name, reason] of [
    ['Write a review', 'speaks_as_principal'],
    ['Message the restaurant', 'speaks_as_principal'],
    ['Change sign-in email', 'account_security'],
    ['Update phone', 'account_security'],
    ['Manage two-factor', 'account_security'],
    ['Update payment method', 'account_security'],
  ])
    expect(
      classifyControlFacts({ name, tag: 'button', type: 'submit', role: 'button', href: null, transaction: true }),
    ).toBe(reason);
});
