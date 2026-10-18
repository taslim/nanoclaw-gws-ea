import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElementHandle, Page } from 'playwright-core';
import * as nativeAuthentication from './authentication-submit.js';
import * as isolatedFacts from './control-facts.js';
import * as consentEngine from './consent.js';
afterEach(() => vi.restoreAllMocks());
import {
  activateControl,
  classifyActivation,
  classifyControlFacts,
  classifyCredentialControlFacts,
  classifyCredentialNavigation,
  classifyNavigationUrl,
  ensureBrowserNavigationGuard,
  refusedScriptRequest,
  registerReviewedMerchantFlow,
  type ActionClass,
  type ActivationIntent,
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
  secretFields: false,
  ...changes,
});

const box = (label: string, changes: Partial<ControlFacts> = {}): ControlFacts =>
  button(label, { tag: 'label', type: '', toggles: { kind: 'checkbox', label }, ...changes });
const link = (name: string, href: string, changes: Partial<ControlFacts> = {}): ControlFacts =>
  button(name, { tag: 'a', type: '', href, ...changes });

/** One control, its class under the open rule, and the action on it when that is not a click. */
type ClassCase = readonly [facts: ControlFacts, expected: ActionClass, kind?: ActivationIntent['kind']];
function expectClasses(cases: readonly ClassCase[]): void {
  cases.forEach(([facts, expected, kind], row) =>
    expect(classifyControlFacts(facts, kind), `row ${row}: "${facts.name}" (${kind ?? 'click'})`).toBe(expected),
  );
}
const each = (names: readonly string[], facts: (name: string) => ControlFacts, expected: ActionClass): ClassCase[] =>
  names.map((name) => [facts(name), expected]);

describe('the open rule', () => {
  it('lets an unknown control on any site run as an ordinary action', () => {
    expectClasses([
      [button('Get it instantly', { type: 'button' }), 'ordinary'],
      // A transaction elsewhere on the page says nothing about a control outside its form or dialog.
      [button('Search', { transaction: true, region: region() }), 'ordinary'],
      [button('Choose', { tag: 'select', role: 'combobox', type: 'select-one' }), 'ordinary'],
      [link('Autumn menus open', 'https://news.example/2026/10/17/autumn-menus'), 'ordinary'],
    ]);
  });

  it('refuses today’s purchase words and the widened ones, and paid registration', () => {
    const words = [
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
    ];
    expectClasses([
      ...each(words, (name) => button(name), 'purchase_control'),
      [button('Search', { visibleLabel: 'Place order' }), 'purchase_control'],
      [link('Purchase history', 'https://shop.example/orders'), 'ordinary'],
      [button('Register', { moneyTerms: true }), 'purchase_control'],
      [button('Register'), 'ordinary'],
      [link('Register', 'https://events.example/signup', { moneyTerms: true }), 'ordinary'],
    ]);
  });

  it('refuses a click on a choice the consent engine owns, by the choice it would toggle (step 4)', () => {
    const owned = [
      'Send me offers',
      'Tick here if you do NOT want our newsletter',
      'I agree to the Terms of Service',
      'I confirm I am 21 or older',
      'Round up for charity ($0.58)',
    ];
    expectClasses([
      ...each(owned, (label) => box(label), 'consent_control'),
      [
        button('', { tag: 'div', role: 'switch', toggles: { kind: 'switch', label: 'Text me deals' } }),
        'consent_control',
      ],
      [
        button('Marketing', {
          tag: 'select',
          type: 'select-one',
          toggles: { kind: 'select', label: 'Marketing emails', options: ['Yes', 'No'] },
        }),
        'consent_control',
        'select',
      ],
      // Functional choices stay the agent's, a priced delivery option among them.
      [box('Same as billing address'), 'ordinary'],
      [
        button('Express delivery, $8.00', {
          tag: 'input',
          type: 'radio',
          toggles: { kind: 'radio', label: 'Express delivery, $8.00', group: 'Delivery option' },
        }),
        'ordinary',
      ],
    ]);
  });

  it('treats a commit on a transaction page as a purchase and named preparation there as ordinary', () => {
    const checkout = { region: region({ transaction: true }), transaction: true };
    const preparation = [
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
    ] as const;
    const modal = { region: region({ dialog: true, modalOrder: true }) };
    expectClasses([
      [button('Continue', checkout), 'purchase_control'],
      [button('Continue', { region: region() }), 'ordinary'],
      // An unnamed press in a transaction form is no preparation the host can name.
      [button('', checkout), 'purchase_control'],
      ...preparation.map(
        ([name, visibleLabel]): ClassCase => [button(name, { ...checkout, visibleLabel }), 'ordinary'],
      ),
      [button('Increase quantity', { ...checkout, visibleLabel: 'Pay' }), 'purchase_control'],
      // Choices and fields are never a commit; a link is decided by its route.
      [button('Quantity', { ...checkout, tag: 'select', type: 'select-one' }), 'ordinary'],
      [button('Leave at door', { ...checkout, tag: 'input', type: 'checkbox' }), 'ordinary'],
      [button('Promo code', { ...checkout, tag: 'input', type: 'text' }), 'ordinary'],
      [link('Terms of sale', 'https://shop.example/terms', checkout), 'ordinary'],
      [button('Continue', { ...checkout, tag: 'a', type: '', scripted: true }), 'purchase_control'],
      // A modal that speaks of the order commits on a transaction page; dismissing it does not.
      [button('Confirm', { ...modal, transaction: true }), 'purchase_control'],
      [button('Confirm', modal), 'ordinary'],
      [button('Cancel', { ...modal, transaction: true }), 'ordinary'],
    ]);
  });

  it('lets an order page’s view controls run beside its charge and card, but no change, cancellation or payment', () => {
    const confirmation = { region: region({ transaction: true }), transaction: true };
    const views = [
      'Add to calendar',
      'View receipt',
      'Print receipt',
      'Download receipt',
      'Download invoice',
      'View your booking',
      'Track order',
      'Track your package',
      'Manage booking',
      'Manage my reservation',
    ];
    expectClasses([
      ...each(views, (name) => button(name, confirmation), 'ordinary'),
      // No view name covers changing or cancelling a booking, or a payment: each stays a commit on this page.
      [button('Change booking', confirmation), 'purchase_control'],
      [button('Cancel reservation', confirmation), 'purchase_control'],
      [button('Modify order', confirmation), 'purchase_control'],
      [button('View receipt', { ...confirmation, visibleLabel: 'Pay now' }), 'purchase_control'],
      [button('Add to calendar and pay', confirmation), 'purchase_control'],
      [button('Get tickets', confirmation), 'purchase_control'],
    ]);
  });

  it('refuses speaking: by label, in a chat widget and when a press sends free text outside a booking', () => {
    const speaking = [
      'Post',
      'Reply',
      'Write a review',
      'Leave a tip',
      'Message the host',
      'Message the restaurant',
      'Submit feedback',
      'Send message',
    ];
    const field = { tag: 'input', type: 'text', role: '' };
    const freeText = { region: region({ freeText: true }) };
    const typed = { ...field, ...freeText };
    expectClasses([
      ...each(speaking, (name) => button(name), 'speaks_as_principal'),
      [button('Send', freeText), 'speaks_as_principal'],
      [button('Submit', freeText), 'speaks_as_principal'],
      [button('Send', { region: region() }), 'ordinary'],
      // A note inside a booking or order rides along with it.
      [button('Reserve', { region: region({ freeText: true, commits: true }) }), 'ordinary'],
      [button('Start chat', { chatFrame: true }), 'speaks_as_principal'],
      [button('Message', { ...field, chatFrame: true }), 'ordinary'],
      [button('Message', { ...field, chatFrame: true }), 'speaks_as_principal', 'submit'],
      [button('Comment', typed), 'speaks_as_principal', 'submit'],
      [button('Comment', typed), 'ordinary'],
    ]);
  });

  it('refuses account-security changes by label, route and the fields a signed-in account form holds', () => {
    const labels = ['Change sign-in email', 'Update phone', 'Manage two-factor', 'Update payment method'];
    const account = { accountPage: true, region: region({ accountFields: true }) };
    const email = { ...account, tag: 'input', type: 'email' };
    expectClasses([
      ...each(labels, (name) => button(name), 'account_security'),
      [button('Save', account), 'account_security'],
      [button('Email address', email), 'account_security', 'submit'],
      [button('Email address', email), 'ordinary'],
      [button('Save preferences', { accountPage: true, region: region() }), 'ordinary'],
      // Contact fields on a checkout are no account page.
      [button('Save', { region: region({ accountFields: true }) }), 'ordinary'],
      [button('Save', { formAction: 'https://shop.example/account/change-password' }), 'account_security'],
    ]);
  });

  it('treats cancelling or changing a booking whose page shows a fee as a purchase', () => {
    const cancelling = ['Cancel reservation', 'Modify booking', 'Yes, cancel', 'Cancel'];
    expectClasses([
      ...each(cancelling, (name) => button(name, { feeTerms: true, region: region() }), 'purchase_control'),
      [button('Cancel reservation', { region: region() }), 'ordinary'],
      // A bare Cancel in a dialog closes the dialog.
      [button('Cancel', { feeTerms: true, region: region({ dialog: true }) }), 'ordinary'],
    ]);
  });

  it('decides blocked address, account security, speaking, consent, then purchases, in that order', () => {
    expectClasses([
      [link('Change password', 'file:///etc/passwd'), 'blocked_address'],
      [
        button('Save', { chatFrame: true, accountPage: true, region: region({ accountFields: true }) }),
        'account_security',
      ],
      [button('Buy now', { chatFrame: true }), 'speaks_as_principal'],
      [button('Place order', { formAction: 'https://shop.example/account/change-password' }), 'account_security'],
      // A press that sends a message speaks, whatever it toggles.
      [box('Send me offers', { tag: 'button', type: 'submit', name: 'Send message' }), 'speaks_as_principal'],
      // A choice the consent engine owns is the engine's, whatever purchase words it carries.
      [box('Subscribe to our newsletter'), 'consent_control'],
      [button('Send', { region: region({ freeText: true, transaction: true, commits: true }) }), 'purchase_control'],
    ]);
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
  vi.spyOn(consentEngine, 'runConsentPass').mockResolvedValue({ status: 'ready', agreements: [], addOns: [] });
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

/** A reviewed flow on `host` that reads every control and route as a purchase it verifies, so an approval presses it. */
function registerApprovingFlow(id: string, host: string): void {
  registerReviewedMerchantFlow({
    id,
    matches: (url) => url.hostname === host,
    classifyControl: async () => 'purchase_control',
    classifyNavigation: () => 'purchase_control',
    verifyPurchaseControl: async () => true,
  });
}

it('decides a document under the purchase press that was approved when it paused', async () => {
  registerApprovingFlow('approved-press-fixture', 'press.example');
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

it('lets a document no operation asked for load only as a GET on the leased site, judging a frame by its page', async () => {
  const fixture = guardedPageFixture('https://shop.example/deals', {
    frame: { id: 'fixture-page' },
    childFrames: [{ frame: { id: 'widget-frame' } }],
  });
  const guard = await ensureBrowserNavigationGuard(fixture.page);
  let next = 0;
  const pause = async (url: string, method = 'GET', frameId = 'fixture-page'): Promise<string | undefined> => {
    const requestId = `document-${next++}`;
    fixture.gateEvents.get('Fetch.requestPaused')?.({
      requestId,
      frameId,
      resourceType: 'Document',
      request: { url, method, headers: {} },
    });
    await vi.waitFor(() => expect(fixture.answers.has(requestId)).toBe(true));
    return fixture.answers.get(requestId);
  };
  // Until a job's lease admitted the page to a site, nothing loads between operations.
  expect(await pause('https://shop.example/deals/today')).toBe('refused');
  await guard.runWithPolicy({ leasedSite: 'shop.example' }, async () => undefined);
  expect(await pause('https://shop.example/deals/today')).toBe('continued');
  expect(await pause('https://shop.example/deals/saved', 'POST')).toBe('refused');
  expect(guard.reason()).toBe('blocked_address');
  expect(await pause('https://partner.example/offer')).toBe('refused');
  expect(await pause('https://shop.example/checkout/placeorder')).toBe('refused');
  expect(guard.reason()).toBe('purchase_control');
  // A frame's document is judged by its page's site, whatever its own.
  expect(await pause('https://widgets.example/poll', 'GET', 'widget-frame')).toBe('continued');
  expect(await pause('https://widgets.example/vote', 'POST', 'widget-frame')).toBe('refused');
});

describe("an ordinary action's script-request window", () => {
  afterEach(() => vi.useRealTimers());

  /** A guarded page whose page events are real, so the window's listeners can be seen coming and going. */
  async function windowFixture(host: string) {
    const fixture = guardedPageFixture(`https://${host}/`, { frame: { id: 'fixture-page' } });
    const events = new EventEmitter();
    let closed = false;
    type Listener = (...args: unknown[]) => void;
    Object.assign(fixture.page, {
      on: (name: string, listener: Listener) => events.on(name, listener),
      once: (name: string, listener: Listener) => events.once(name, listener),
      off: (name: string, listener: Listener) => events.off(name, listener),
      isClosed: () => closed,
    });
    const guard = await ensureBrowserNavigationGuard(fixture.page);
    return {
      ...fixture,
      guard,
      events,
      /** What the script-request setting was told, in order. */
      armed: () =>
        fixture.sends.map((send) => send.method).filter((method) => /^Fetch\.(?:enable|disable)$/u.test(method)),
      /** The request listeners a window still holds on the page. */
      listening: () =>
        ['request', 'requestfailed', 'requestfinished'].reduce((count, name) => count + events.listenerCount(name), 0),
      close() {
        closed = true;
        events.emit('close');
      },
    };
  }

  it('returns an action that sends no requests at 250 ms, before its window closes, and keeps the window armed into the next action without a gap', async () => {
    const window = await windowFixture('settle.example');
    vi.useFakeTimers();
    const returned: string[] = [];
    const first = window.guard.duringAction(10_000, async () => 'first').then((value) => returned.push(value));
    // A quiet page holds the caller only for a navigation to begin.
    await vi.advanceTimersByTimeAsync(249);
    expect(returned).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(returned).toEqual(['first']);
    expect(window.armed()).toEqual(['Fetch.enable']);
    // A second action inside the first one's settle: the first window closes inside the second, with no gap.
    await vi.advanceTimersByTimeAsync(350);
    const second = window.guard.duringAction(10_000, async () => 'second').then((value) => returned.push(value));
    await vi.advanceTimersByTimeAsync(250);
    await second;
    await vi.advanceTimersByTimeAsync(749);
    expect(window.armed()).toEqual(['Fetch.enable']);
    // The second window closes a full settle after its own action.
    await vi.advanceTimersByTimeAsync(1);
    await window.guard.actionsSettled();
    expect(returned).toEqual(['first', 'second']);
    expect(window.armed()).toEqual(['Fetch.enable', 'Fetch.disable']);
    expect(window.listening()).toBe(0);
  });

  it('holds the caller while the action’s requests are in flight and a moment after the last, never past the settle', async () => {
    const window = await windowFixture('quiet.example');
    vi.useFakeTimers();
    const submit = { isNavigationRequest: () => false };
    let returned = false;
    const pressed = window.guard
      .duringAction(10_000, async () => {
        window.events.emit('request', submit);
      })
      .then(() => {
        returned = true;
      });
    // A script submit in flight: its response may navigate the page.
    await vi.advanceTimersByTimeAsync(300);
    expect(returned).toBe(false);
    window.events.emit('requestfinished', submit);
    await vi.advanceTimersByTimeAsync(249);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pressed;
    expect(returned).toBe(true);

    // A stream that never ends holds the caller only until the settle ends.
    returned = false;
    const streaming = window.guard
      .duringAction(10_000, async () => {
        window.events.emit('request', { isNavigationRequest: () => false });
      })
      .then(() => {
        returned = true;
      });
    await vi.advanceTimersByTimeAsync(999);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await streaming;
    expect(returned).toBe(true);
    await window.guard.actionsSettled();
    expect(window.armed()).toEqual(['Fetch.enable', 'Fetch.disable']);
    expect(window.listening()).toBe(0);
  });

  it('holds the caller until a navigation the action started commits, and ends a window at once when its action throws or its page closes', async () => {
    const window = await windowFixture('navigate.example');
    const frame = window.page.mainFrame();
    vi.useFakeTimers();
    let returned = false;
    const pressed = window.guard
      .duringAction(10_000, async () => {
        window.events.emit('request', { isNavigationRequest: () => true, frame: () => frame });
      })
      .then(() => {
        returned = true;
      });
    // A navigation that has not committed holds the caller, and keeps the window open past its settle.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(returned).toBe(false);
    expect(window.armed()).toEqual(['Fetch.enable']);
    window.events.emit('framenavigated', frame);
    await vi.advanceTimersByTimeAsync(50);
    await pressed;
    await window.guard.actionsSettled();
    expect(window.armed()).toEqual(['Fetch.enable', 'Fetch.disable']);
    expect(window.listening()).toBe(0);

    // An action that throws closes its window before its error reaches the caller, with no settle.
    await expect(
      window.guard.duringAction(10_000, async () => {
        throw new Error('not actionable');
      }),
    ).rejects.toThrow('not actionable');
    expect(window.armed()).toEqual(['Fetch.enable', 'Fetch.disable', 'Fetch.enable', 'Fetch.disable']);
    expect(window.listening()).toBe(0);

    // A page that closes ends the window its action outlasted, well inside the settle.
    const last = window.guard.duringAction(10_000, async () => undefined);
    await vi.advanceTimersByTimeAsync(250);
    await last;
    window.close();
    let settled = false;
    void window.guard.actionsSettled().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(true);
    expect(window.armed()).toHaveLength(6);
    expect(window.listening()).toBe(0);
  });

  it('starts an approved press only once every ordinary window on its page has closed', async () => {
    registerApprovingFlow('settled-press-fixture', 'settled-press.example');
    const window = await windowFixture('settled-press.example');
    const element = { ownerFrame: async () => window.page.mainFrame() } as unknown as ElementHandle;
    vi.spyOn(isolatedFacts, 'readPageControlFacts').mockResolvedValue(button('Place order'));
    vi.useFakeTimers();
    const ordinary = window.guard.duringAction(10_000, async () => undefined);
    await vi.advanceTimersByTimeAsync(250);
    await ordinary;
    let armedAtCommit: string[] | undefined;
    const press = vi.fn(async () => undefined);
    const approved = activateControl(window.page, element, press, {
      commitStarted: async () => {
        armedAtCommit = window.armed();
      },
    });
    await vi.advanceTimersByTimeAsync(749);
    expect(armedAtCommit).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await approved).toEqual({ ordinaryPress: false });
    // The ordinary window closed before the commit marker, so the press's own payment requests go out.
    expect(armedAtCommit).toEqual(['Fetch.enable', 'Fetch.disable']);
    expect(press).toHaveBeenCalledTimes(1);
  });
});

it('refuses only script requests that are no GET, to a payment processor or a purchase route', () => {
  for (const [method, url] of [
    ['POST', 'https://api.stripe.com/v1/payment_intents/pi_1/confirm'],
    ['POST', 'https://www.paypal.com/smart/api/order'],
    ['PUT', 'https://checkoutshopper-live.adyen.com/checkoutshopper/v1/payments'],
    ['POST', 'https://pay.shopify.com/session'],
    ['POST', 'https://shop.example/api/checkout/submit'],
  ])
    expect(refusedScriptRequest({ method, url })).toBe(true);
  for (const [method, url] of [
    ['GET', 'https://api.stripe.com/v1/elements/sessions'],
    ['POST', 'https://shop.example/api/cart/add'],
    ['POST', 'https://notstripe.com/collect'],
    ['POST', 'https://www.google.com/recaptcha/api2/reload'],
  ])
    expect(refusedScriptRequest({ method, url })).toBe(false);
});
