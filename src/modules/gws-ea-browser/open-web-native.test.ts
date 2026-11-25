import fs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { root } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: join(tmpdir(), 'nanoclaw-open-web-native-tests') };
});
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: root,
  GROUPS_DIR: `${root}/groups`,
}));
vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  registerSessionAdmissionPolicy: vi.fn(),
  setAutoGroupImageRefresh: vi.fn(),
  wakeContainer: vi.fn(async () => true),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { useFakeGateway } from '../gws-ea-sealed-gateway/testing/fake-gateway.js';
import * as loginStoreModule from './login-store.js';
import { openWebFixture, type OpenWebFixture } from './open-web-native-fixture.js';
import { useAvailableBrowser } from './testing/browser-runtime.js';
import { testLoginStore } from './testing/login-store.js';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { Locator, Page } from 'playwright-core';
import type { SqliteDriver } from '../../db/drivers/sqlite.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { readPageControlFacts } from './control-facts.js';
import { classifyActivation, type ActivationIntent } from './commit-classifier.js';
import { recordConsentGrant, runConsentPass, type ConsentPassResult } from './consent.js';
import { executeBrowserBatch } from './executor.js';
import type { BrowserAction } from './actions.js';
import {
  CONSENT,
  COOKIE_BANNERS,
  OPEN_WEB,
  PERSONAL_DATA,
  refIn,
  type OpenWebRequest,
} from './open-web-native-fixture.js';
import { createLoginsPageHandler } from './logins-page.js';
import { observePage, type BrowserSnapshotObservation } from './observe.js';
import { deliverAction } from './testing/delivery-answer.js';
import { siteWordingPattern } from './testing/site-wording.js';
import {
  errandRequest,
  jobContext,
  jobDb,
  startErrandHost,
  stopErrandHost,
  withElement,
  type ErrandHost,
} from './testing/open-web-native-helpers.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;

/** The one fixture every suite here drives: each test starts from its shared pages, with no request seen. */
let fixture: OpenWebFixture;
let defaultLogins: ReturnType<typeof testLoginStore>;
beforeAll(async () => {
  if (chromePath) fixture = await openWebFixture(chromePath);
}, 30_000);
afterAll(async () => {
  await fixture?.close();
});
beforeEach(() => {
  // Each job's queue reconciles the browser group's gateway identity.
  useFakeGateway();
  useAvailableBrowser();
  fixture?.reset();
  fs.rmSync(`${root}/browser`, { recursive: true, force: true });
  defaultLogins = testLoginStore(`${root}/browser`);
  vi.spyOn(loginStoreModule, 'getLoginStore').mockResolvedValue(defaultLogins.store);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.skipIf(!chromePath)('open-web classification in native Chrome', { timeout: 30_000 }, () => {
  let page: Page;

  beforeEach(async () => {
    page = await fixture.newPage();
  });
  afterEach(async () => {
    await page?.context().close();
  });

  async function visit(url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'load' });
  }
  const classify = (target: Locator, kind?: ActivationIntent['kind']): Promise<string> =>
    withElement(target, (element) => classifyActivation(page, element, kind));
  const facts = (target: Locator) => withElement(target, (element) => readPageControlFacts(page, element));

  it('keeps preparation on a transaction page ordinary and refuses its commits', async () => {
    await visit(OPEN_WEB.payment);
    expect(await facts(page.locator('#continue'))).toMatchObject({ transaction: true, region: { transaction: true } });
    // A coupon and a quantity change on a checkout with a total and a saved card run as ordinary clicks.
    await page.locator('#coupon').fill('AUTUMN10');
    for (const id of ['#apply', '#decrease', '#increase', '#remove', '#summary', '#edit', '#back'])
      expect(await classify(page.locator(id))).toBe('ordinary');
    expect(await classify(page.locator('#coupon'))).toBe('ordinary');
    expect(await classify(page.locator('#place'))).toBe('purchase_control');
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
    // A delivery note rides with the order: the commit stays a purchase, never speaking.
    await page.locator('#note').fill('Leave it with the porter');
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
    expect(await classify(page.locator('#note'), 'submit')).toBe('purchase_control');
  });

  it('leaves Continue ordinary where there is no payment, or the total and card sit in different forms', async () => {
    await visit(OPEN_WEB.shipping);
    expect(await facts(page.locator('#continue'))).toMatchObject({ transaction: false });
    expect(await classify(page.locator('#continue'))).toBe('ordinary');
    expect(await classify(page.locator('input[value="express"]'))).toBe('ordinary');
    await visit(OPEN_WEB.split);
    expect(await facts(page.locator('#wallet-continue'))).toMatchObject({ transaction: false });
    expect(await classify(page.locator('#totals-continue'))).toBe('ordinary');
    expect(await classify(page.locator('#wallet-continue'))).toBe('ordinary');
    await visit(OPEN_WEB.cart);
    expect(await classify(page.locator('#proceed'))).toBe('ordinary');
    expect(await classify(page.locator('button[name="apply"]'))).toBe('ordinary');
  });

  it('treats Confirm in a modal on a transaction page, and a nested confirmation, as purchases', async () => {
    await visit(OPEN_WEB.confirm);
    await page.locator('#review').click();
    await expect
      .poll(() => page.locator('#confirm').evaluate((dialog) => (dialog as unknown as { open: boolean }).open))
      .toBe(true);
    expect(await facts(page.locator('#confirm-yes'))).toMatchObject({
      transaction: true,
      region: { dialog: true, modalOrder: true },
    });
    expect(await classify(page.locator('#confirm-yes'))).toBe('purchase_control');
    expect(await classify(page.locator('#confirm-no'))).toBe('ordinary');
    await page.locator('#details').click();
    expect(await classify(page.locator('#nested-yes'))).toBe('purchase_control');
  });

  it('classifies in an isolated world, whatever the page rewrites in its own', async () => {
    await visit(OPEN_WEB.rewritten);
    // The page's own world now reports every control as a search outside any form.
    expect(await page.locator('#place').evaluate((node) => node.textContent)).toBe('Search');
    expect(await facts(page.locator('#place'))).toMatchObject({
      name: 'Place order',
      formAction: 'https://shop.example/checkout/complete',
      transaction: true,
      region: { transaction: true },
    });
    expect(await classify(page.locator('#place'))).toBe('purchase_control');
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
  });

  it('follows a payment platform redirect and refuses the platform’s own commits', async () => {
    await visit(OPEN_WEB.redirect);
    expect(page.url()).toBe(OPEN_WEB.platform);
    expect(await classify(page.locator('#pay'))).toBe('purchase_control');
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
    expect(await classify(page.locator('#back'))).toBe('ordinary');
  });

  it('counts a visible hosted card frame as the payment method, and refuses Pay inside a payment frame', async () => {
    await visit(OPEN_WEB.hostedCard);
    await page.frameLocator('#card-frame').locator('input[name="cardnumber"]').waitFor();
    expect(await facts(page.locator('#continue'))).toMatchObject({ transaction: true, region: { transaction: true } });
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
    expect(await classify(page.locator('#apply'))).toBe('ordinary');
    await visit(OPEN_WEB.embeddedPay);
    const frame = page.frameLocator('#pay-frame');
    expect(await classify(frame.locator('#pay'))).toBe('purchase_control');
    // A card frame no processor list names is known by the card fields it holds.
    await visit(OPEN_WEB.ownCardFrame);
    await page.frameLocator('#card-frame').locator('input[name="cardnumber"]').waitFor();
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
  });

  it('counts no hidden processor frame or Pay Later message as a payment method beside a total', async () => {
    await visit(OPEN_WEB.pending);
    await page.frameLocator('#pay-later').locator('text=Pay in 4').waitFor();
    expect(page.frames().filter((frame) => frame.url().includes('elements-inner-card'))).toHaveLength(1);
    expect(await facts(page.locator('#continue'))).toMatchObject({
      transaction: false,
      region: { transaction: false },
    });
    expect(await classify(page.locator('#continue'))).toBe('ordinary');
  });

  it('keeps Add to cart, a size and Continue ordinary beside hidden processor frames, Pay Later and express pay', async () => {
    await visit(OPEN_WEB.product);
    await page.frameLocator('#pay-later').locator('text=Pay in 4').waitFor();
    expect(page.frames().map((frame) => new URL(frame.url()).host)).toEqual(
      expect.arrayContaining(['js.stripe.com', 'www.paypal.com']),
    );
    expect(await facts(page.locator('#continue'))).toMatchObject({ transaction: false });
    expect(await classify(page.locator('#add-to-cart'))).toBe('ordinary');
    expect(await classify(page.locator('#size'), 'select')).toBe('ordinary');
    expect(await classify(page.locator('#continue'))).toBe('ordinary');
  });

  it('lets a booking note ride along, and refuses a reservation that a card guarantees for a fee', async () => {
    await visit(OPEN_WEB.restaurant);
    const free = page.frameLocator('#booking');
    await free.locator('#requests').fill('One guest is allergic to peanuts');
    expect(await classify(free.locator('#reserve'))).toBe('ordinary');
    expect(await classify(free.locator('#slot-1830'))).toBe('ordinary');
    await visit(OPEN_WEB.feeRestaurant);
    expect(await classify(page.frameLocator('#booking').locator('#reserve'))).toBe('purchase_control');
  });

  it('treats cancelling or changing a booking whose page shows a fee as a purchase', async () => {
    await visit(OPEN_WEB.reservation);
    expect(await classify(page.locator('#cancel'))).toBe('purchase_control');
    expect(await classify(page.locator('#modify'))).toBe('purchase_control');
    expect(await classify(page.locator('#venue'))).toBe('ordinary');
  });

  it('refuses speaking: a contact form, a comment box, a formless chat and a chat widget frame', async () => {
    await visit(OPEN_WEB.contact);
    await page.locator('input[name="name"]').fill('Morgan Ellery');
    await page.locator('input[name="email"]').fill('morgan.ellery@example.test');
    expect(await classify(page.locator('#send'))).toBe('ordinary');
    await page.locator('#message').fill('Do you ship to Canada?');
    expect(await classify(page.locator('#send'))).toBe('speaks_as_principal');
    await visit(OPEN_WEB.article);
    await page.locator('#comment-box').fill('Cannot wait to try the new menu.');
    expect(await classify(page.locator('#comment-box'))).toBe('ordinary');
    expect(await classify(page.locator('#comment-box'), 'submit')).toBe('speaks_as_principal');
    await visit(OPEN_WEB.help);
    await page.locator('#help-search').fill('returns');
    await page.locator('#chat-input').fill('Where is my order?');
    expect(await classify(page.locator('#help-search'), 'submit')).toBe('ordinary');
    expect(await classify(page.locator('#help-search-go'))).toBe('ordinary');
    expect(await classify(page.locator('#chat-input'), 'submit')).toBe('speaks_as_principal');
    expect(await classify(page.locator('#chat-send'))).toBe('speaks_as_principal');
    const chat = page.frameLocator('#chat-frame');
    await chat.locator('#chat-message').fill('Hello');
    expect(await facts(chat.locator('#chat-message'))).toMatchObject({ chatFrame: true });
    expect(await classify(chat.locator('#chat-message'), 'submit')).toBe('speaks_as_principal');
    expect(await classify(chat.locator('#chat-submit'))).toBe('speaks_as_principal');
  });

  it('refuses saving contact or password fields on a signed-in account page, but not a display preference', async () => {
    await visit(OPEN_WEB.account);
    expect(await facts(page.locator('#save-contact'))).toMatchObject({
      accountPage: true,
      region: { accountFields: true },
    });
    expect(await classify(page.locator('#save-contact'))).toBe('account_security');
    expect(await classify(page.locator('#update-password'))).toBe('account_security');
    expect(await classify(page.locator('input[name="phone"]'), 'submit')).toBe('account_security');
    expect(await classify(page.locator('#theme'), 'select')).toBe('ordinary');
    expect(await classify(page.locator('#save-display'))).toBe('ordinary');
  });

  it('stops a formless chat Enter as speaking through the executor', async () => {
    const db = await jobDb('job-1');
    try {
      // The page loads before the job's navigation guard, which refuses documents between operations.
      await visit(OPEN_WEB.help);
      await page.locator('#chat-input').fill('Where is my order?');
      const result = await executeBrowserBatch(
        jobContext(db, page, 'job-1'),
        { actions: [{ kind: 'key', ...refIn(await observePage(page), 'Type a message'), key: 'Enter' }] },
        { record: false },
      );
      expect(result).toMatchObject({
        status: 'stopped',
        reason: 'speaks_as_principal',
        actions: [{ status: 'stopped', reason: 'speaks_as_principal' }],
      });
      expect(fixture.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!chromePath)('the consent engine in native Chrome', { timeout: 30_000 }, () => {
  let page: Page;
  let db: SqliteDriver;
  const JOB = 'job-consent';

  beforeEach(async () => {
    page = await fixture.newPage();
    db = await jobDb(JOB);
  });
  afterEach(async () => {
    await page?.context().close();
    await db?.close();
  });

  const scope = () => ({ jobId: JOB, db });
  /** A fresh page: a job's navigation guard, once installed, refuses a document loaded between its operations. */
  const visit = async (url: string): Promise<void> => {
    await page.context().close();
    page = await fixture.newPage();
    await page.goto(url, { waitUntil: 'load' });
  };
  /** The host's one check before a press of `target`, as every submission path runs it. */
  const pass = (target: Locator, purchase = false): Promise<ConsentPassResult> =>
    withElement(target, (element) => runConsentPass(page, element, { scope: scope(), purchase }));
  const classify = (target: Locator): Promise<string> =>
    withElement(target, (element) => classifyActivation(page, element));
  const checked = (selector: string): Promise<boolean> =>
    page.locator(selector).evaluate((node) => (node as unknown as { checked: boolean }).checked);
  /** One batch through the executor, as the browser agent sends it, aimed by each control's accessible name. */
  async function act(...steps: Array<[kind: 'click' | 'key', name: string]>): Promise<Record<string, unknown>> {
    const observation = await observePage(page);
    const actions = steps.map(([kind, name]): BrowserAction =>
      kind === 'key' ? { kind, ...refIn(observation, name), key: 'Enter' } : { kind, ...refIn(observation, name) },
    );
    return executeBrowserBatch(jobContext(db, page, JOB), { actions }, { record: false });
  }
  /** The query of the one request that reached `path`, or undefined when the form never submitted. */
  const submitted = (path: string): URLSearchParams | undefined => {
    const request = fixture.requests.find((candidate) => new URL(candidate.url).pathname === path);
    return request && new URL(request.url).searchParams;
  };
  const stops = () =>
    db.all<{ id: string; site: string; origin: string; wording: string; kind: string; status: string }>(
      'SELECT id,site,origin,wording,kind,status FROM gws_ea_browser_consent_stops ORDER BY created_at',
    );

  it('unticks a pre-ticked offers box on a free booking with a real click on its label', async () => {
    await visit(CONSENT.offers);
    expect(await checked('#offers')).toBe(true);
    expect(await pass(page.locator('#reserve'))).toEqual({ status: 'ready', agreements: [], addOns: [] });
    expect(await checked('#offers')).toBe(false);
    // The box changed under a trusted click on its styled label, never a dispatched one.
    expect(await page.locator('body').getAttribute('data-trusted')).toBe('true');
    expect(await stops()).toEqual([]);
  });

  it('ticks an inverted newsletter box, which opts out, before the form submits', async () => {
    await visit(CONSENT.inverted);
    await page.locator('input[name="email"]').fill('morgan.ellery@example.test');
    expect(await act(['click', 'Sign up'])).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(submitted('/newsletter/joined')?.get('no_newsletter')).toBe('on');
  });

  it('moves a Yes/No offers question to No', async () => {
    await visit(CONSENT.radio);
    await act(['click', 'Continue']);
    expect(submitted('/offers-question/joined')?.get('offers')).toBe('no');
  });

  it('turns an SMS switch off with a real click and verifies it', async () => {
    await visit(CONSENT.sms);
    expect(await pass(page.locator('#join-button'))).toMatchObject({ status: 'ready' });
    expect(await page.locator('#sms').getAttribute('aria-checked')).toBe('false');
    expect(await page.locator('#sms-value').inputValue()).toBe('off');
  });

  it('stops for a box the site ticks again, caught by the check before the press', async () => {
    await visit(CONSENT.reticking);
    const result = await pass(page.locator('#join-button'));
    const [stop] = await stops();
    expect(result).toEqual({
      status: 'consent_required',
      stops: [{ stop_id: stop.id, site: 'join.example', wording: 'Send me offers' }],
      // The host unticked the box before the site ticked it again.
      hostChanged: true,
    });
    expect(stop).toMatchObject({ origin: 'https://join.example', kind: 'marketing', status: 'open' });
    expect(await checked('#offers')).toBe(true);
  });

  it('stops for a required opt-in, and after the principal agrees ticks only that box, until the wording changes or the grant is withdrawn', async () => {
    await visit(CONSENT.required);
    const stopped = await act(['click', 'Join']);
    const [stop] = await stops();
    expect(stopped).toMatchObject({
      status: 'stopped',
      reason: 'consent_required',
      // The browser reads the site's wording as text the site wrote.
      consent: [
        {
          stop_id: stop.id,
          site: 'join.example',
          wording: expect.stringMatching(siteWordingPattern('I agree to receive marketing', 'join.example')),
        },
      ],
      actions: [{ status: 'stopped', reason: 'consent_required' }],
    });
    expect(submitted('/required-marketing/joined')).toBeUndefined();
    await recordConsentGrant(db, {
      site: 'join.example',
      origin: 'https://join.example',
      wording: 'I agree to receive marketing',
      approvalId: 'approval-1',
      principalUserId: 'gchat:users/principal',
    });
    await act(['click', 'Join']);
    expect(Object.fromEntries(submitted('/required-marketing/joined') ?? [])).toEqual({ email: '', marketing: 'on' });
    // A later submission with the same wording needs no new card; changed wording asks again.
    await visit(CONSENT.required);
    expect(await pass(page.locator('#join-button'))).toMatchObject({ status: 'ready' });
    await visit(CONSENT.required);
    await page
      .locator('input[name="marketing"]')
      .evaluate(
        (node) =>
          ((node as unknown as { nextSibling: { textContent: string } }).nextSibling.textContent =
            ' I agree to receive marketing texts'),
      );
    expect(await pass(page.locator('#join-button'))).toMatchObject({
      status: 'consent_required',
      stops: [{ wording: 'I agree to receive marketing texts' }],
    });
    await db.run("UPDATE gws_ea_browser_consent_grants SET withdrawn_at = '2026-10-17T00:00:00.000Z'");
    await visit(CONSENT.required);
    expect(await pass(page.locator('#join-button'))).toMatchObject({
      status: 'consent_required',
      stops: [{ wording: 'I agree to receive marketing' }],
    });
  });

  it('stops for a bundled box and another company’s terms, naming each, and ticks neither', async () => {
    for (const [url, wording] of [
      [CONSENT.bundled, 'I agree to the Terms and to receive marketing emails'],
      [CONSENT.namedTerms, "I agree to Klarna's Terms of Service"],
    ] as const) {
      await visit(url);
      // Stopped on its first read, before the host set any choice.
      expect(await pass(page.locator('#join-button'))).toMatchObject({
        status: 'consent_required',
        stops: [{ wording }],
        hostChanged: false,
      });
      expect(
        await page
          .locator('input[type="checkbox"]')
          .evaluate((node) => (node as unknown as { checked: boolean }).checked),
      ).toBe(false);
    }
    expect((await stops()).map((stop) => stop.kind)).toEqual(['bundled', 'agreement']);
  });

  it('stops for terms linked to another site from a box’s label or its description, and not for terms linked within the site', async () => {
    await visit(CONSENT.linkedTerms);
    expect(await pass(page.locator('#join-button'))).toMatchObject({
      status: 'consent_required',
      stops: [
        { site: 'join.example', wording: 'I accept the User Agreement' },
        { site: 'join.example', wording: 'I accept the Privacy Policy' },
      ],
    });
    expect((await stops()).map(({ origin, kind }) => ({ origin, kind }))).toEqual([
      { origin: 'https://join.example', kind: 'agreement' },
      { origin: 'https://join.example', kind: 'agreement' },
    ]);
    for (const name of ['terms', 'wallet', 'privacy']) expect(await checked(`input[name="${name}"]`)).toBe(false);
  });

  it('stops for a box naming its own company inside a cross-site frame, another company’s terms to the page’s site', async () => {
    await visit(CONSENT.framedTerms);
    const frame = page.frameLocator('#pay-later');
    expect(await pass(frame.locator('#continue'))).toMatchObject({
      status: 'consent_required',
      stops: [{ site: 'shop.example', wording: "I agree to Klarna's Terms of Service" }],
    });
    // The stop is the page's site's to approve, keyed with the frame it was found in.
    expect(await stops()).toMatchObject([
      { site: 'shop.example', origin: 'https://js.klarna.example', kind: 'agreement', status: 'open' },
    ]);
    expect(
      await frame
        .locator('input[name="pay_later_terms"]')
        .evaluate((node) => (node as unknown as { checked: boolean }).checked),
    ).toBe(false);
  });

  it('unticks a pre-ticked round-up, and refuses as a purchase a press the site would keep it ticked for', async () => {
    await visit(CONSENT.donation);
    await act(['click', 'Continue']);
    expect(submitted('/checkout/round-up/next')?.has('round_up')).toBe(false);
    await visit(CONSENT.redonation);
    expect(await act(['click', 'Continue'])).toMatchObject({ status: 'stopped', reason: 'purchase_control' });
    expect(submitted('/checkout/round-up-again/next')).toBeUndefined();
    // Inside a purchase the kept extra is a charge for the card instead.
    await visit(CONSENT.redonation);
    expect(await pass(page.locator('#next'), true)).toEqual({
      status: 'ready',
      agreements: [],
      addOns: ['Round up for charity ($0.58)'],
    });
  });

  it('refuses the agent’s own click on a marketing box, its label, its words or its styled wrapper, but not on a functional box', async () => {
    await visit(CONSENT.address);
    for (const selector of ['#offers', '#offers-label', '#offers-words', '#sms-wrapper', '#slider'])
      expect(await classify(page.locator(selector))).toBe('consent_control');
    expect(await classify(page.locator('#same'))).toBe('ordinary');
    expect(await act(['click', 'Email me offers and news'])).toMatchObject({
      status: 'stopped',
      reason: 'consent_control',
    });
    expect(await checked('#offers')).toBe(false);
  });

  it('refuses a click on an auto-saving preference toggle, which saves with no later submission', async () => {
    await visit(CONSENT.preferences);
    expect(await classify(page.locator('#news'))).toBe('consent_control');
    expect(await classify(page.locator('#dark'))).toBe('ordinary');
    expect(await act(['click', 'Email me product news'])).toMatchObject({
      status: 'stopped',
      reason: 'consent_control',
    });
    expect(await page.locator('#news').getAttribute('aria-checked')).toBe('false');
    expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('runs the consent pass before a form Enter submits', async () => {
    await visit(CONSENT.classes);
    await page.locator('#q').fill('yoga');
    expect(await act(['key', 'Class'])).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(Object.fromEntries(submitted('/classes') ?? [])).toEqual({ q: 'yoga' });
  });
});

describe.skipIf(!chromePath)('cookie banners in native Chrome', { timeout: 30_000 }, () => {
  let page: Page;
  let db: SqliteDriver;
  const JOB = 'job-banners';

  beforeEach(async () => {
    page = await fixture.newPage();
    db = await jobDb(JOB);
  });
  afterEach(async () => {
    await page?.context().close();
    await db?.close();
  });

  /** A fresh page: a job's navigation guard, once installed, refuses a document loaded between its operations. */
  const visit = async (url: string): Promise<void> => {
    await page.context().close();
    page = await fixture.newPage();
    await page.goto(url, { waitUntil: 'load' });
  };
  /** One batch through the executor, which settles cookie banners before the observation it returns. */
  async function batch(
    ...actions: BrowserAction[]
  ): Promise<{ result: Record<string, unknown>; seen: BrowserSnapshotObservation }> {
    const result = await executeBrowserBatch(jobContext(db, page, JOB), { actions }, { record: false });
    return { result, seen: result.observation as BrowserSnapshotObservation };
  }
  const observe = () => batch({ kind: 'observe' });
  /** What the page's banner received: its choice, whether a real click made it, and how many presses it took. */
  const received = () =>
    page
      .locator('body')
      .evaluate((body) => ({ ...(body as unknown as { dataset: Record<string, string | undefined> }).dataset }));

  it('rejects a OneTrust banner with a real click, and it is not in the next observation', async () => {
    // The OneTrust page loads inside the job's own operation; its banner fades before it leaves the page.
    const loaded = await batch({ kind: 'navigate', url: COOKIE_BANNERS.oneTrust });
    expect(loaded.result).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(loaded.seen.cookie_banner).toEqual({ status: 'rejected' });
    expect(loaded.seen.snapshot).toContain('Autumn menus open this week');
    expect(loaded.seen.snapshot).not.toContain('We use cookies');
    expect(await received()).toEqual({ choice: 'reject', trusted: 'true', presses: '1' });
    const next = (await observe()).seen;
    expect(next.cookie_banner).toBeUndefined();
    expect(next.snapshot).not.toContain('We use cookies');
  });

  it('rejects a banner inside a shadow root, and one inside a cross-site consent frame', async () => {
    await visit(COOKIE_BANNERS.shadow);
    const shadow = (await observe()).seen;
    expect(shadow.cookie_banner).toEqual({ status: 'rejected' });
    expect(shadow.snapshot).not.toContain('similar technologies');
    expect(await received()).toEqual({ choice: 'reject', trusted: 'true', presses: '1' });

    for (const url of [COOKIE_BANNERS.frame, COOKIE_BANNERS.sourcepoint]) {
      await visit(url);
      expect(page.frames().some((frame) => new URL(frame.url()).host !== 'bistro.example')).toBe(true);
      const framed = (await observe()).seen;
      expect(framed.cookie_banner).toEqual({ status: 'rejected' });
      expect(framed.snapshot).not.toContain('cookies');
      expect(await received()).toEqual({ choice: 'reject', trusted: 'true', presses: '1' });
    }
  });

  it('rejects through a second layer: a preference centre and a "Manage options" panel', async () => {
    for (const [url, words] of [
      [COOKIE_BANNERS.oneTrustSettings, 'Privacy Preference Center'],
      [COOKIE_BANNERS.layered, 'Cookie preferences'],
    ] as const) {
      await visit(url);
      const seen = (await observe()).seen;
      expect(seen.cookie_banner).toEqual({ status: 'rejected' });
      expect(seen.snapshot).not.toContain(words);
      expect(await received()).toEqual({ choice: 'reject', trusted: 'true', presses: '1' });
    }
  });

  it('reports a banner that offers only Accept, and presses nothing', async () => {
    await visit(COOKIE_BANNERS.acceptOnly);
    for (let observation = 0; observation < 2; observation++) {
      const seen = (await observe()).seen;
      expect(seen.cookie_banner).toEqual({ status: 'no_reject_option' });
      expect(seen.snapshot).toContain('By continuing you accept our use of cookies');
    }
    expect(await received()).toEqual({});
  });

  it('reports a banner that comes back after its reject, and presses it again only on a new page load', async () => {
    await visit(COOKIE_BANNERS.reappearing);
    expect((await observe()).seen.cookie_banner).toEqual({ status: 'rejected' });
    await page.evaluate('window.showCookieBar()');
    for (let observation = 0; observation < 2; observation++) {
      const seen = (await observe()).seen;
      expect(seen.cookie_banner).toEqual({ status: 'reappeared' });
      expect(seen.snapshot).toContain('This site uses cookies');
    }
    expect(await received()).toEqual({ choice: 'reject', trusted: 'true', presses: '1' });
    const reloaded = await batch({ kind: 'navigate', url: COOKIE_BANNERS.reappearing });
    expect(reloaded.seen.cookie_banner).toEqual({ status: 'rejected' });
    expect(await received()).toEqual({ choice: 'reject', trusted: 'true', presses: '1' });
  });

  it('never presses a reject that submits a form outside its banner, or one the classifier refuses', async () => {
    for (const url of [COOKIE_BANNERS.foreignForm, COOKIE_BANNERS.spoofed]) {
      await visit(url);
      const seen = (await observe()).seen;
      expect(seen.cookie_banner).toEqual({ status: 'no_reject_option' });
      expect(seen.snapshot).toContain('We use cookies');
      expect(await received()).toEqual({});
    }
    expect(fixture.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });
});

describe.skipIf(!chromePath)('personal data in native Chrome', { timeout: 60_000 }, () => {
  const MOBILE = '+1 415 555 0134';
  const HOME = '123 Main Street, Springfield';
  let host: ErrandHost;
  let page: Page;
  let mobile: string;
  const posts = (): OpenWebRequest[] => fixture.requests.filter((request) => request.method !== 'GET');

  beforeEach(async () => {
    host = await startErrandHost(root, fixture, 'system:a2a:main-p:dinner');
    ({ page } = host);
    mobile = (await addPrivateValue({ label: 'Mobile', kind: 'phone', value: MOBILE })).id;
    await addPrivateValue({ label: 'Home', kind: 'address', value: HOME });
  });
  afterEach(() => stopErrandHost(root, host));

  /** One request through the queue, as the errand's browser agent sends it; its answer's data, without the queue's timing. */
  const request = (id: string, action: string, content: Record<string, unknown>) =>
    errandRequest(host, id, action, content);
  const run = (id: string, actions: BrowserAction[]) => request(id, 'browser', { actions });
  /** Opens `url` and answers with the observation the navigation returned. */
  async function open(url: string): Promise<BrowserSnapshotObservation> {
    const opened = await run(`open-${randomUUID()}`, [{ kind: 'navigate', url }]);
    expect(opened).toMatchObject({ status: 'stopped', reason: 'navigated' });
    return opened.observation as BrowserSnapshotObservation;
  }
  /** Main's disclosure of the mobile number to `site` for this errand, sent as its tool sends it; the host's answer. */
  async function disclose(site: string): Promise<unknown> {
    const frame = await deliverAction(host.main, 'record_disclosure', {
      thread: host.errand.thread_id,
      site,
      value_id: mobile,
    });
    if (!frame.ok) throw new Error(frame.error.message);
    return frame.data;
  }
  const refusedBeforeTyping = { status: 'stopped', reason: 'personal_data', repeat_safe: true };

  it('fills the mobile number main disclosed for the restaurant its brief names, and the booking goes through', async () => {
    expect(await disclose('https://osteria.example/')).toMatchObject({ status: 'recorded', site: 'osteria.example' });
    const form = await open(PERSONAL_DATA.booking);
    expect(
      await run('book', [
        {
          kind: 'form_input',
          fields: [
            { ...refIn(form, 'Name'), value: 'Morgan Ellery' },
            { ...refIn(form, 'Mobile'), value: '(415) 555-0134' },
          ],
          submit: refIn(form, 'Reserve'),
        },
      ]),
    ).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(await page.locator('h1').textContent()).toBe('Your table is reserved');
    const [booked] = posts();
    expect(booked?.url).toBe(PERSONAL_DATA.booked);
    expect(new URLSearchParams(booked?.body).get('mobile')).toBe('(415) 555-0134');
  });

  it('refuses the mobile number on an injected page on another site, before anything is typed', async () => {
    await disclose('osteria.example');
    const form = await open(PERSONAL_DATA.claim);
    expect(
      await run('claim', [
        {
          kind: 'form_input',
          fields: [{ ...refIn(form, 'Mobile'), value: '415-555-0134' }],
          submit: refIn(form, 'Claim upgrade'),
        },
      ]),
    ).toEqual(refusedBeforeTyping);
    expect(await page.locator('input[name="mobile"]').inputValue()).toBe('');
    expect(posts()).toEqual([]);
  });

  it('refuses the disclosed mobile number in another site’s frame on the restaurant’s page, and fills the restaurant’s own field', async () => {
    await disclose('osteria.example');
    await open(PERSONAL_DATA.events);
    const offers = page.frameLocator('#offers').locator('input[name="mobile"]');
    await offers.waitFor();
    expect(
      await run('offers', [
        { kind: 'type', ...refIn(await observePage(page), 'Mobile for offers'), text: '(415) 555-0134' },
      ]),
    ).toEqual(refusedBeforeTyping);
    expect(await offers.inputValue()).toBe('');
    expect(
      await run('enquiry', [
        { kind: 'type', ...refIn(await observePage(page), 'Contact number'), text: '(415) 555-0134' },
      ]),
    ).toMatchObject({ status: 'completed' });
    expect(await page.locator('input[name="phone"]').inputValue()).toBe('(415) 555-0134');
    expect(posts()).toEqual([]);
  });

  it('refuses an address that carries the home address in its query, before the request leaves', async () => {
    await open(PERSONAL_DATA.booking);
    const directions = `${PERSONAL_DATA.directions}?from=${encodeURIComponent(HOME)}&to=Osteria%20del%20Ponte`;
    expect(await run('directions', [{ kind: 'navigate', url: directions }])).toEqual(refusedBeforeTyping);
    expect(fixture.requests.filter((sent) => sent.url.startsWith('https://maps.example'))).toEqual([]);
    expect(page.url()).toBe(PERSONAL_DATA.booking);
  });

  it('fills a login added on the page in the next errand and refuses its username in a newsletter field', async () => {
    const logins = testLoginStore(`${root}/browser`);
    const server = createServer(
      createLoginsPageHandler({
        hostname: 'aya.example.test',
        identity: async () => 'morgan@example.test',
        store: logins.store,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No page fixture port');
      const added = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const submission = httpRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/logins/add',
            method: 'POST',
            headers: {
              host: 'aya.example.test',
              origin: 'https://aya.example.test',
              'content-type': 'application/json',
            },
          },
          (response) => {
            let body = '';
            response.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        submission.on('error', reject);
        submission.end(
          JSON.stringify({
            site: PERSONAL_DATA.signIn,
            username: 'morgan@example.test',
            title: 'Osteria',
            password: 'native-sign-in-secret',
          }),
        );
      });
      expect(added.status).toBe(200);
      expect(added.body).toContain('Login added.');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    const [item] = await logins.store.all();
    const store = vi.spyOn(loginStoreModule, 'getLoginStore').mockResolvedValue(logins.store);
    try {
      const signIn = await open(PERSONAL_DATA.signIn);
      expect(
        await request('sign-in', 'fill_secret', {
          item_handle: item.id,
          username: refIn(signIn, 'Email'),
          submit: refIn(signIn, 'Continue'),
        }),
      ).toMatchObject({ status: 'submitted' });
      // The host's sign-in submission runs the consent pass first: the site's pre-ticked offers box goes unticked.
      expect(posts().map((sent) => [sent.url, Object.fromEntries(new URLSearchParams(sent.body))])).toEqual([
        [PERSONAL_DATA.signIn, { email: 'morgan@example.test' }],
      ]);
      expect(await page.locator('h1').textContent()).toBe('Welcome back');
    } finally {
      store.mockResolvedValue(defaultLogins.store);
    }
    const newsletter = await open(PERSONAL_DATA.newsletter);
    for (const text of ['morgan@example.test', 'Morgan+offers@example.test'])
      expect(await run(`newsletter-${text}`, [{ kind: 'type', ...refIn(newsletter, 'Email'), text }]), text).toEqual(
        refusedBeforeTyping,
      );
    expect(await page.locator('input[name="email"]').inputValue()).toBe('');
    expect(posts()).toHaveLength(1);
  });
});
