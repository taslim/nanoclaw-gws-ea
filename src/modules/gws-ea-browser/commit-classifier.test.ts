import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElementHandle, Page } from 'playwright-core';
import * as nativeAuthentication from './authentication-submit.js';
import * as isolatedFacts from './control-facts.js';
afterEach(() => vi.restoreAllMocks());
import {
  activateControl,
  classifyActivation,
  classifyControlFacts,
  classifyCredentialControlFacts,
  termsConsentLabel,
  classifyCredentialNavigation,
  classifyNavigationUrl,
  ensureBrowserNavigationGuard,
  registerReviewedMerchantFlow,
  type ActionClass,
  type ControlFacts,
  type ControlRegion,
} from './commit-classifier.js';

const button = (name: string, changes: Partial<ControlFacts> = {}): ControlFacts => ({
  name,
  visibleLabel: name,
  role: '',
  tag: 'button',
  type: 'submit',
  href: null,
  transaction: false,
  ...changes,
});
const region = (changes: Partial<ControlRegion> = {}): ControlRegion => ({
  dialog: false,
  transaction: false,
  modalOrder: false,
  freeText: false,
  commits: false,
  accountFields: false,
  ...changes,
});

describe('the open rule', () => {
  it('lets an unknown control on any site run as an ordinary action', () => {
    expect(classifyControlFacts(button('Get it instantly', { type: 'button' }))).toBe('ordinary');
    // A transaction elsewhere on the page says nothing about a control outside its form or dialog.
    expect(classifyControlFacts(button('Search', { transaction: true, region: region() }))).toBe('ordinary');
    expect(classifyControlFacts(button('Choose', { tag: 'select', role: 'combobox', type: 'select-one' }))).toBe(
      'ordinary',
    );
    expect(
      classifyControlFacts(
        button('Autumn menus open', { tag: 'a', type: '', href: 'https://news.example/2026/10/17/autumn-menus' }),
      ),
    ).toBe('ordinary');
  });

  it('refuses today’s purchase words and the widened ones, and paid registration', () => {
    for (const name of [
      'Buy now',
      'Place order',
      'Confirm reservation',
      'Start free trial',
      'Purchase',
      'Order now',
      'Upgrade to Pro',
      'Renew membership',
      'Place bid',
      'Complete reservation',
    ])
      expect(classifyControlFacts(button(name))).toBe('purchase_control');
    expect(classifyControlFacts(button('Search', { visibleLabel: 'Place order' }))).toBe('purchase_control');
    expect(
      classifyControlFacts(button('Purchase history', { tag: 'a', type: '', href: 'https://shop.example/orders' })),
    ).toBe('ordinary');
    expect(classifyControlFacts(button('Register', { moneyTerms: true }))).toBe('purchase_control');
    expect(classifyControlFacts(button('Register'))).toBe('ordinary');
    expect(
      classifyControlFacts(
        button('Register', { tag: 'a', type: '', href: 'https://events.example/signup', moneyTerms: true }),
      ),
    ).toBe('ordinary');
  });

  it('treats a commit on a transaction page as a purchase and named preparation there as ordinary', () => {
    const checkout = { region: region({ transaction: true }), transaction: true };
    expect(classifyControlFacts(button('Continue', checkout))).toBe('purchase_control');
    expect(classifyControlFacts(button('Continue', { region: region() }))).toBe('ordinary');
    // An unnamed press in a transaction form is no preparation the host can name.
    expect(classifyControlFacts(button('', checkout))).toBe('purchase_control');
    for (const [name, visibleLabel] of [
      ['Apply', 'Apply'],
      ['Apply coupon', 'Apply'],
      ['Remove', 'Remove'],
      ['Increase quantity', '+'],
      ['Decrease quantity', '−'],
      ['Show order summary', 'Show order summary'],
      ['Edit', 'Edit'],
      ['Change delivery option', 'Change delivery option'],
      ['Use this address', 'Use this address'],
      ['Back', 'Back'],
      ['Continue shopping', 'Continue shopping'],
      ['Add to cart', 'Add to cart'],
      ['Proceed to checkout', 'Proceed to checkout'],
      ['Cancel', 'Cancel'],
    ])
      expect(classifyControlFacts(button(name, { ...checkout, visibleLabel }))).toBe('ordinary');
    expect(classifyControlFacts(button('Increase quantity', { ...checkout, visibleLabel: 'Pay' }))).toBe(
      'purchase_control',
    );
    // Choices and fields are never a commit; a link is decided by its route.
    expect(classifyControlFacts(button('Quantity', { ...checkout, tag: 'select', type: 'select-one' }))).toBe(
      'ordinary',
    );
    expect(classifyControlFacts(button('Leave at door', { ...checkout, tag: 'input', type: 'checkbox' }))).toBe(
      'ordinary',
    );
    expect(classifyControlFacts(button('Promo code', { ...checkout, tag: 'input', type: 'text' }))).toBe('ordinary');
    expect(
      classifyControlFacts(
        button('Terms of sale', { ...checkout, tag: 'a', type: '', href: 'https://shop.example/terms' }),
      ),
    ).toBe('ordinary');
    expect(classifyControlFacts(button('Continue', { ...checkout, tag: 'a', type: '', scripted: true }))).toBe(
      'purchase_control',
    );
    // A modal that speaks of the order commits on a transaction page; dismissing it does not.
    const modal = { region: region({ dialog: true, modalOrder: true }) };
    expect(classifyControlFacts(button('Confirm', { ...modal, transaction: true }))).toBe('purchase_control');
    expect(classifyControlFacts(button('Confirm', modal))).toBe('ordinary');
    expect(classifyControlFacts(button('Cancel', { ...modal, transaction: true }))).toBe('ordinary');
  });

  it('refuses speaking: by label, in a chat widget and when a press sends free text outside a booking', () => {
    for (const name of [
      'Post',
      'Reply',
      'Write a review',
      'Leave a tip',
      'Message the host',
      'Submit feedback',
      'Send message',
    ])
      expect(classifyControlFacts(button(name))).toBe('speaks_as_principal');
    for (const name of ['Send', 'Submit'])
      expect(classifyControlFacts(button(name, { region: region({ freeText: true }) }))).toBe('speaks_as_principal');
    expect(classifyControlFacts(button('Send', { region: region() }))).toBe('ordinary');
    // A note inside a booking or order rides along with it.
    expect(classifyControlFacts(button('Reserve', { region: region({ freeText: true, commits: true }) }))).toBe(
      'ordinary',
    );
    const field = { tag: 'input', type: 'text', role: '' };
    expect(classifyControlFacts(button('Start chat', { chatFrame: true }))).toBe('speaks_as_principal');
    expect(classifyControlFacts(button('Message', { ...field, chatFrame: true }))).toBe('ordinary');
    expect(classifyControlFacts(button('Message', { ...field, chatFrame: true }), 'submit')).toBe(
      'speaks_as_principal',
    );
    const typed = { ...field, region: region({ freeText: true }) };
    expect(classifyControlFacts(button('Comment', typed), 'submit')).toBe('speaks_as_principal');
    expect(classifyControlFacts(button('Comment', typed))).toBe('ordinary');
  });

  it('refuses account-security changes by label, route and the fields a signed-in account form holds', () => {
    const account = { accountPage: true, region: region({ accountFields: true }) };
    expect(classifyControlFacts(button('Save', account))).toBe('account_security');
    expect(classifyControlFacts(button('Email address', { ...account, tag: 'input', type: 'email' }), 'submit')).toBe(
      'account_security',
    );
    expect(classifyControlFacts(button('Email address', { ...account, tag: 'input', type: 'email' }))).toBe('ordinary');
    expect(classifyControlFacts(button('Save preferences', { accountPage: true, region: region() }))).toBe('ordinary');
    // Contact fields on a checkout are no account page.
    expect(classifyControlFacts(button('Save', { region: region({ accountFields: true }) }))).toBe('ordinary');
    expect(classifyControlFacts(button('Save', { formAction: 'https://shop.example/account/change-password' }))).toBe(
      'account_security',
    );
  });

  it('treats cancelling or changing a booking whose page shows a fee as a purchase', () => {
    for (const name of ['Cancel reservation', 'Modify booking', 'Yes, cancel', 'Cancel'])
      expect(classifyControlFacts(button(name, { feeTerms: true, region: region() }))).toBe('purchase_control');
    expect(classifyControlFacts(button('Cancel reservation', { region: region() }))).toBe('ordinary');
    // A bare Cancel in a dialog closes the dialog.
    expect(classifyControlFacts(button('Cancel', { feeTerms: true, region: region({ dialog: true }) }))).toBe(
      'ordinary',
    );
  });

  it('decides blocked address, account security, speaking, then purchases, in that order', () => {
    expect(classifyControlFacts(button('Change password', { tag: 'a', type: '', href: 'file:///etc/passwd' }))).toBe(
      'blocked_address',
    );
    expect(
      classifyControlFacts(
        button('Save', { chatFrame: true, accountPage: true, region: region({ accountFields: true }) }),
      ),
    ).toBe('account_security');
    expect(classifyControlFacts(button('Buy now', { chatFrame: true }))).toBe('speaks_as_principal');
    expect(
      classifyControlFacts(button('Place order', { formAction: 'https://shop.example/account/change-password' })),
    ).toBe('account_security');
    expect(
      classifyControlFacts(button('Send', { region: region({ freeText: true, transaction: true, commits: true }) })),
    ).toBe('purchase_control');
  });
});

it('opens any public page and refuses only blocked and commit-class routes', () => {
  for (const url of [
    'https://shop.example/unknown-action',
    'https://shop.example/about',
    'https://news.example/2026/10/17/autumn-menus-open-this-week',
    // An article's slug is prose, not a route that acts.
    'https://news.example/guides/the-best-time-to-buy-a-kettle',
    'https://book.example/venues/42/book?party=2&time=19%3A00',
    'https://shop.example/search?q=restaurant',
  ])
    expect(classifyNavigationUrl(url)).toBe('ordinary');
  expect(classifyNavigationUrl('https://shop.example/buy?oneclick=1')).toBe('purchase_control');
  expect(classifyNavigationUrl('https://shop.example/checkout/place-order')).toBe('purchase_control');
  expect(classifyNavigationUrl('https://shop.example/checkout/submit')).toBe('purchase_control');
  expect(classifyNavigationUrl('https://shop.example/account/change-password')).toBe('account_security');
  expect(classifyNavigationUrl('https://shop.example/reviews/new?action=post-review')).toBe('speaks_as_principal');
  for (const url of ['file:///etc/passwd', 'https://user:secret@shop.example/', 'javascript:alert(1)', 'not a url'])
    expect(classifyNavigationUrl(url)).toBe('blocked_address');
});

it('keeps reviewed Amazon authentication routes precise and leaves its other routes to the open rule', () => {
  for (const path of ['/ap/signin', '/ap/mfa', '/ap/cvf'])
    expect(classifyNavigationUrl(`https://www.amazon.com${path}`)).toBe('ordinary');
  expect(classifyNavigationUrl('https://www.amazon.com/ap/signin?action=purchase')).toBe('purchase_control');
  expect(classifyNavigationUrl('https://www.amazon.com/ap/signin?operation=change-password')).toBe('account_security');
  expect(classifyNavigationUrl('https://www.amazon.com/ap/unknown')).toBe('ordinary');
  expect(classifyNavigationUrl('http://www.amazon.com/ap/signin')).toBe('ordinary');
});

it('submits positively identified native authentication forms without invoking arbitrary page callbacks', async () => {
  registerReviewedMerchantFlow({
    id: 'test-unhandled-auth-flow',
    matches: (url) => url.hostname === 'auth-dispatch.example',
    classifyControl: async () => undefined,
    classifyNavigation: () => undefined,
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
  // This unit doubles the isolated-world reads and the native Chrome object binding. Both have real-renderer suites.
  vi.spyOn(isolatedFacts, 'readPageControlFacts').mockImplementation(async () => ({
    name: 'Sign in',
    visibleLabel: 'Sign in',
    role: '',
    tag: 'button',
    type: 'submit',
    href: null,
    formMethod: form.method,
    formAction: form.action,
    transaction: false,
  }));
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

it('lets a reviewed flow decide only what the open rule leaves ordinary', async () => {
  let reviewed: ActionClass | undefined;
  registerReviewedMerchantFlow({
    id: 'test-reviewed-precision',
    matches: (url) => url.hostname === 'reviewed.example',
    classifyControl: async () => reviewed,
    classifyNavigation: () => undefined,
  });
  const page = { url: () => 'https://reviewed.example/item' } as unknown as Page;
  const element = {} as ElementHandle;
  const read = vi
    .spyOn(isolatedFacts, 'readPageControlFacts')
    .mockResolvedValue(button('Continue', { type: 'button' }));
  // A control the flow does not know falls to the open rule instead of being refused.
  expect(await classifyActivation(page, element)).toBe('ordinary');
  reviewed = 'purchase_control';
  expect(await classifyActivation(page, element)).toBe('purchase_control');
  reviewed = 'ordinary';
  read.mockResolvedValue(button('Buy now'));
  expect(await classifyActivation(page, element)).toBe('purchase_control');
  read.mockResolvedValue(button('Message', { tag: 'input', type: 'text', chatFrame: true }));
  expect(await classifyActivation(page, element)).toBe('ordinary');
  expect(await classifyActivation(page, element, 'submit')).toBe('speaks_as_principal');
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
      [control('Create account', { transaction: true }), 'unsupported_control'],
      [control('Change email'), 'account_security'],
      [control('Update password and phone', { visibleLabel: 'Update phone' }), 'account_security'],
      [control('Manage two-factor'), 'account_security'],
      [control('Delete account'), 'account_security'],
      [control('Post review'), 'speaks_as_principal'],
      [control('Do it'), 'unsupported_control'],
      [control('Create account', { visibleLabel: 'Buy now' }), 'purchase_control'],
      [control('Create account', { formAction: 'https://collector.example/signup' }), 'unsupported_control'],
      [control('Create account', { formAction: 'http://accounts.shop.example/signup' }), 'blocked_address'],
      [control('Create account', { formAction: 'https://www.shop.example/checkout/subscribe' }), 'purchase_control'],
      [control('Create account', { tag: 'a', href: 'https://www.shop.example/signup' }), 'unsupported_control'],
    ];
    for (const [facts, reason] of refusals)
      expect(
        classifyCredentialControlFacts(facts, facts.name.includes('password') ? 'rotation' : 'signup', 'shop.example'),
      ).toBe(reason);
  });

  it('takes a signup form’s own agree-and-create control as its activation, and refuses those words in every other credential scope', () => {
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
      expect(classifyCredentialControlFacts(control(name), 'signup', 'shop.example')).toBe('unsupported_control');
      expect(
        classifyCredentialControlFacts(
          control(name, { formAction: 'https://www.shop.example/account/change-password' }),
          'rotation',
          'shop.example',
          { formControl: true },
        ),
      ).toBe('unsupported_control');
      // Outside every credential scope the open rule decides: these words name no commit.
      expect(classifyControlFacts(control(name))).toBe('ordinary');
    }
    const inForm = { formControl: true } as const;
    expect(
      classifyCredentialControlFacts(
        control('Agree and create account', { moneyTerms: true }),
        'signup',
        'shop.example',
        inForm,
      ),
    ).toBe('unsupported_control');
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
  const element = { ownerFrame: async () => fixture.page.mainFrame() } as unknown as ElementHandle;
  vi.spyOn(isolatedFacts, 'readPageControlFacts').mockResolvedValue(button('Place order'));
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
