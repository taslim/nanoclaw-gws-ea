import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElementHandle, Page } from 'playwright-core';
import * as nativeAuthentication from './authentication-submit.js';
afterEach(() => vi.restoreAllMocks());
import {
  activateControl,
  classifyControlFacts,
  classifyCredentialControlFacts,
  termsConsentLabel,
  classifyCredentialNavigation,
  classifyNavigationUrl,
  ensureBrowserNavigationGuard,
  registerReviewedMerchantFlow,
  type ControlFacts,
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

it('allows positively reviewed Amazon authentication routes while retaining financial and security denials', () => {
  for (const path of ['/ap/signin', '/ap/mfa', '/ap/cvf'])
    expect(classifyNavigationUrl(`https://www.amazon.com${path}`)).toBe('ordinary');
  expect(classifyNavigationUrl('https://www.amazon.com/ap/signin?action=purchase')).toBe('purchase_control');
  expect(classifyNavigationUrl('https://www.amazon.com/ap/signin?operation=change-password')).toBe('account_security');
  expect(classifyNavigationUrl('https://www.amazon.com/ap/unknown')).toBe('unsupported_merchant');
  expect(classifyNavigationUrl('http://www.amazon.com/ap/signin')).toBe('unsupported_merchant');
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
    frames: () => [frame],
    mainFrame: () => frame,
    locator: () => ({ innerText: async () => '' }),
    waitForEvent: async () => undefined,
    on: () => undefined,
    once: () => undefined,
    context: () => ({
      newCDPSession: async () => ({ on: () => undefined, send: async () => ({ targetInfo: { targetId: 'page' } }) }),
      browser: () => ({
        once: () => undefined,
        newBrowserCDPSession: async () => ({ on: () => undefined, send: async () => undefined }),
      }),
    }),
  } as unknown as Page;
  // This unit mocks only the native Chrome object binding. Native-world integrity has its own real-renderer suite.
  vi.spyOn(nativeAuthentication, 'inspectNativeAuthenticationControl').mockResolvedValue({
    facts: {
      control: { tag: 'BUTTON', name: '', type: 'submit', autocomplete: '' },
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

describe('the credential activation scope', () => {
  const control = (name: string, changes: Partial<ControlFacts> = {}): ControlFacts => ({
    name,
    visibleLabel: name,
    role: 'button',
    tag: 'button',
    type: 'submit',
    href: null,
    transaction: false,
    formMethod: 'post',
    formAction: 'https://accounts.shop.example/signup',
    ...changes,
  });

  it('activates only a positively named signup or password-change control on the operation’s own site', () => {
    for (const name of ['Create account', 'Sign up', 'Continue', 'Register', 'Next'])
      expect(classifyCredentialControlFacts(control(name), 'signup', 'shop.example')).toBe('ordinary');
    for (const name of ['Change password', 'Update password', 'Save changes', 'Save new password'])
      expect(
        classifyCredentialControlFacts(
          control(name, { formAction: 'https://www.shop.example/account/change-password' }),
          'rotation',
          'shop.example',
        ),
      ).toBe('ordinary');
    // The same password-change control is still account security outside its own authorized scope.
    expect(classifyCredentialControlFacts(control('Change password'), 'signup', 'shop.example')).toBe(
      'account_security',
    );
    expect(classifyControlFacts(control('Change password'))).toBe('account_security');
  });

  it('refuses financial, unrelated security, speaking, ambiguous and off-site activation even when authorized', () => {
    const refusals: Array<[ControlFacts, string]> = [
      [control('Start free trial'), 'purchase_control'],
      [control('Subscribe'), 'purchase_control'],
      [control('Create account', { transaction: true }), 'unsupported_merchant'],
      [control('Change email'), 'account_security'],
      [control('Update password and phone', { visibleLabel: 'Update phone' }), 'account_security'],
      [control('Manage two-factor'), 'account_security'],
      [control('Delete account'), 'account_security'],
      [control('Post review'), 'speaks_as_principal'],
      [control('Do it'), 'unsupported_merchant'],
      [control('Create account', { visibleLabel: 'Buy now' }), 'purchase_control'],
      [control('Create account', { formAction: 'https://collector.example/signup' }), 'unsupported_merchant'],
      [control('Create account', { formAction: 'http://accounts.shop.example/signup' }), 'blocked_address'],
      [control('Create account', { formAction: 'https://www.shop.example/checkout/subscribe' }), 'purchase_control'],
      [control('Create account', { tag: 'a', href: 'https://www.shop.example/signup' }), 'unsupported_merchant'],
    ];
    for (const [facts, reason] of refusals)
      expect(
        classifyCredentialControlFacts(facts, facts.name.includes('password') ? 'rotation' : 'signup', 'shop.example'),
      ).toBe(reason);
  });

  it('takes a signup form’s own agree-and-create control as its activation, and refuses those words everywhere else', () => {
    const agreeing = [
      'Agree and create account',
      'Accept and sign up',
      'Agree & continue',
      'I agree and continue',
      'Agree & Join',
    ];
    for (const name of agreeing) {
      expect(classifyCredentialControlFacts(control(name), 'signup', 'shop.example', { formControl: true })).toBe(
        'ordinary',
      );
      expect(classifyCredentialControlFacts(control(name), 'signup', 'shop.example')).toBe('unsupported_merchant');
      expect(
        classifyCredentialControlFacts(
          control(name, { formAction: 'https://www.shop.example/account/change-password' }),
          'rotation',
          'shop.example',
          { formControl: true },
        ),
      ).toBe('unsupported_merchant');
      expect(classifyControlFacts(control(name))).toBe('unsupported_merchant');
    }
    const inForm = { formControl: true } as const;
    expect(
      classifyCredentialControlFacts(
        control('Agree and create account', { moneyTerms: true }),
        'signup',
        'shop.example',
        inForm,
      ),
    ).toBe('unsupported_merchant');
    expect(classifyCredentialControlFacts(control('Agree and subscribe'), 'signup', 'shop.example', inForm)).toBe(
      'purchase_control',
    );
    expect(
      classifyCredentialControlFacts(control('Agree and start free trial'), 'signup', 'shop.example', inForm),
    ).toBe('purchase_control');
    expect(classifyCredentialControlFacts(control('Agree and pay'), 'signup', 'shop.example', inForm)).toBe(
      'purchase_control',
    );
  });

  it('accepts a checkbox named only for the site’s terms, never for marketing, data sharing or money', () => {
    for (const label of [
      'I agree to the Terms of Service',
      'I accept the Terms and Conditions and the Privacy Policy',
      'I have read and agree to the User Agreement',
      'I agree to the Terms & Conditions',
      'I agree to the terms of use',
    ])
      expect(termsConsentLabel(label)).toBe(true);
    for (const label of [
      'Send me marketing emails',
      'I agree to the Terms of Service and to receive newsletters',
      'I agree to the Terms and to special offers',
      'Share my data with partners',
      'I agree to the Privacy Policy and data sharing with third parties',
      'I agree to the subscription terms',
      'I agree to the Terms and authorize recurring billing',
      'I accept the membership terms',
      'I agree to the payment terms',
      'I agree to the Terms of Service and the free trial',
      'I agree to the Terms; my plan renews automatically at $10/month',
      'Remember me',
      'Keep me signed in',
      '',
    ])
      expect(termsConsentLabel(label)).toBe(false);
  });

  it('activates a signup’s verification code only through a verification control', () => {
    const verification = { step: 'verification' } as const;
    for (const name of ['Verify', 'Verify email', 'Confirm', 'Submit code', 'Continue', 'Activate account'])
      expect(classifyCredentialControlFacts(control(name), 'signup', 'shop.example', verification)).toBe('ordinary');
    for (const name of ['Create account', 'Resend code', 'Change email', 'Subscribe'])
      expect(classifyCredentialControlFacts(control(name), 'signup', 'shop.example', verification)).not.toBe(
        'ordinary',
      );
  });

  it('lets a change navigate only to its own site’s password routes, never to other security or financial routes', () => {
    expect(
      classifyCredentialNavigation('https://www.shop.example/account/change-password', 'rotation', 'shop.example'),
    ).toBe('ordinary');
    expect(classifyCredentialNavigation('https://www.shop.example/welcome', 'signup', 'shop.example')).toBe('ordinary');
    expect(classifyNavigationUrl('https://www.shop.example/account/change-password')).toBe('account_security');
    for (const [url, reason] of [
      ['https://www.shop.example/account/change-password', 'account_security'],
      ['https://www.shop.example/account/change-email', 'account_security'],
      ['https://www.shop.example/account/delete-account', 'account_security'],
      ['https://www.shop.example/checkout', 'purchase_control'],
      ['http://www.shop.example/welcome', 'blocked_address'],
    ] as const)
      expect(
        classifyCredentialNavigation(url, url.includes('change-password') ? 'signup' : 'rotation', 'shop.example'),
      ).toBe(reason);
    // Another site keeps the generic rules: the scope says nothing about it.
    expect(classifyCredentialNavigation('https://collector.example/welcome', 'signup', 'shop.example')).toBeUndefined();
  });
});

/** A page whose sessions and browser record what the guard sends; the gate's pauses are driven by hand. */
function guardedPageFixture(url: string, frameTree: unknown, lookup?: () => Promise<never>) {
  const sends: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const pageEvents = new Map<string, (event: unknown) => void>();
  const gateEvents = new Map<string, (event: unknown) => void>();
  const answers = new Map<string, string>();
  const frame = { isDetached: () => false, url: () => url };
  const pageSession = {
    on: (name: string, handler: (event: unknown) => void) => pageEvents.set(name, handler),
    once: () => undefined,
    detach: async () => undefined,
    send: async (method: string, params?: Record<string, unknown>) => {
      sends.push({ method, params });
      if (method === 'Fetch.continueRequest') throw new Error('Invalid InterceptionId.');
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'fixture-page' } };
      if (method === 'Page.getFrameTree') return { frameTree };
      return {};
    },
  };
  const gateSession = {
    on: (name: string, handler: (event: unknown) => void) => gateEvents.set(name, handler),
    send: async (method: string, params?: { requestId?: string }) => {
      if (method === 'Target.getTargetInfo') {
        if (lookup) return lookup();
        throw new Error('Protocol error (Target.getTargetInfo): No target with given id found');
      }
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'fixture-page', type: 'page' }] };
      if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest')
        answers.set(String(params?.requestId), method === 'Fetch.continueRequest' ? 'continued' : 'refused');
      return {};
    },
  };
  const page = {
    url: () => url,
    frames: () => [frame],
    mainFrame: () => frame,
    isClosed: () => false,
    locator: () => ({ innerText: async () => '' }),
    on: () => undefined,
    once: () => undefined,
    off: () => undefined,
  } as unknown as Page;
  const browser = {
    once: () => undefined,
    contexts: () => [{ pages: () => [page] }],
    newBrowserCDPSession: async () => gateSession,
  };
  Object.assign(page, { context: () => ({ newCDPSession: async () => pageSession, browser: () => browser }) });
  return { page, sends, pageEvents, gateEvents, answers };
}

it('strips Referer only from subresources, once across nested sign-in scopes, and fails what it cannot continue', async () => {
  const fixture = guardedPageFixture('https://sign-in.example/', { frame: { id: 'fixture-page' } });
  const guard = await ensureBrowserNavigationGuard(fixture.page);
  const fetch = () => fixture.sends.filter((send) => send.method.startsWith('Fetch.'));
  await guard.runWithPolicy({ stripReferrer: true }, async () => {
    await guard.runWithPolicy({ stripReferrer: true }, async () => undefined);
    // The inner scope's end leaves the outer one stripping.
    expect(fetch().map((send) => send.method)).toEqual(['Fetch.enable']);
    fixture.pageEvents.get('Fetch.requestPaused')?.({ requestId: 'image', request: { headers: { Referer: 'x' } } });
    await vi.waitFor(() => expect(fetch().map((send) => send.method)).toContain('Fetch.failRequest'));
  });
  expect(fetch().map((send) => send.method)).toEqual([
    'Fetch.enable',
    'Fetch.continueRequest',
    'Fetch.failRequest',
    'Fetch.disable',
  ]);
  // Documents are the gate's alone: the page session never pauses one.
  const patterns = fetch()[0].params?.patterns as Array<{ resourceType?: string }>;
  expect(patterns.length).toBeGreaterThan(0);
  expect(patterns.every((pattern) => pattern.resourceType && pattern.resourceType !== 'Document')).toBe(true);
});

it('decides a document under the purchase press that was approved when it paused', async () => {
  registerReviewedMerchantFlow({
    id: 'approved-press-fixture',
    matches: (url) => url.hostname === 'press.example',
    classifyControl: async () => 'purchase_control',
    classifyNavigation: () => 'purchase_control',
    verifyPurchaseControl: async () => true,
  });
  let place!: () => void;
  const placed = new Promise<never>((_resolve, reject) => {
    place = () => reject(new Error('Protocol error (Target.getTargetInfo): No target with given id found'));
  });
  // The receipt's frame is placed only after the press has ended.
  const fixture = guardedPageFixture(
    'https://press.example/checkout',
    { frame: { id: 'fixture-page' }, childFrames: [{ frame: { id: 'receipt-frame' } }] },
    () => placed,
  );
  await ensureBrowserNavigationGuard(fixture.page);
  const element = {
    ownerFrame: async () => fixture.page.mainFrame(),
    evaluate: async () => ({
      name: 'Place order',
      visibleLabel: 'Place order',
      role: '',
      tag: 'button',
      type: 'submit',
      href: null,
    }),
  } as unknown as ElementHandle;
  await activateControl(
    fixture.page,
    element,
    async () => {
      fixture.gateEvents.get('Fetch.requestPaused')?.({
        requestId: 'receipt',
        frameId: 'receipt-frame',
        resourceType: 'Document',
        request: { url: 'https://press.example/receipt', headers: {} },
      });
    },
    { commitStarted: async () => undefined },
  );
  place();
  await vi.waitFor(() => expect(fixture.answers.get('receipt')).toBe('continued'));
});
