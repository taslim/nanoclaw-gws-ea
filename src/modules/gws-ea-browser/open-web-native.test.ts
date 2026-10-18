/** The open rule against native Chrome: unreviewed sites, cross-site frames, dialogs and hostile page script. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import Database from 'better-sqlite3';
import type { Locator, Page } from 'playwright-core';
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
  wakeContainer: vi.fn(async () => true),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import type { OutboundFile } from '../../channels/adapter.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { configureBrowserCancellation, readBrowserJob } from './cancel.js';
import {
  activateControl,
  classifyActivation,
  classifyNavigationUrl,
  ensureBrowserNavigationGuard,
  readControlFacts,
  withBrowserJobNavigation,
  type ActivationIntent,
} from './commit-classifier.js';
import { recordConsentGrant, runConsentPass, type ConsentPassResult } from './consent.js';
import { BrowserStore } from './db.js';
import { recordDisclosureRequest } from './disclosures.js';
import { executeBrowserBatch, type BrowserAction } from './executor.js';
import { setBrowserAdmissionReady } from './group.js';
import { prepareMerchantPage, readMerchantPurchase } from './merchant-signatures.js';
import { browserConsentMigration, browserRecipesMigration, browserSiteLeasesMigration } from './migration.js';
import {
  CONSENT,
  COOKIE_BANNERS,
  GENERIC,
  OPEN_WEB,
  PERSONAL_DATA,
  PROCESSOR,
  checkoutPage,
  feeTablePage,
  genericCheckoutPages,
  openWebFixture,
  orderConfirmationPage,
  placedPage,
  type OpenWebFixture,
  type OpenWebRequest,
} from './open-web-native-fixture.js';
import { browserVault } from './onepassword.js';
import {
  bindPageSecretDocuments,
  observePage,
  registerPageSecret,
  releasePageSecret,
  type BrowserObservation,
  type BrowserRef,
} from './observe.js';
import { registerBrowserPurchaseDelivery, resumeBrowserPurchaseCommits } from './purchase.js';
import { notifyPendingUnconfirmed, recordPurchaseOutcome } from './purchase-outcome.js';
import { BrowserQueue, type BrowserExecutionContext } from './queue.js';
import { executeRecipe, saveBrowserRecipe } from './recipes.js';
import { registerReservationGuaranteeDelivery } from './reservation-guarantee.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;

describe.skipIf(!chromePath)('open-web classification in native Chrome', { timeout: 30_000 }, () => {
  let fixture: OpenWebFixture;
  let page: Page;

  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    page = await fixture.newPage();
  });
  afterEach(async () => {
    await page?.context().close();
  });

  async function visit(url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'load' });
  }
  async function classify(target: Locator, kind?: ActivationIntent['kind']): Promise<string> {
    const element = await target.elementHandle();
    if (!element) throw new Error('Fixture control missing');
    try {
      return await classifyActivation(page, element, kind);
    } finally {
      await element.dispose();
    }
  }
  async function facts(target: Locator) {
    const element = await target.elementHandle();
    if (!element) throw new Error('Fixture control missing');
    try {
      return await readControlFacts(page, element);
    } finally {
      await element.dispose();
    }
  }

  it('reads a dated article, an about page and a booking step as ordinary', async () => {
    for (const url of [OPEN_WEB.article, OPEN_WEB.about, OPEN_WEB.restaurant])
      expect(classifyNavigationUrl(url)).toBe('ordinary');
    await visit(OPEN_WEB.article);
    expect(await classify(page.locator('#about'))).toBe('ordinary');
    expect(await classify(page.locator('#more'))).toBe('ordinary');
    expect(await classify(page.locator('#share'))).toBe('ordinary');
    await visit(OPEN_WEB.restaurant);
    const widget = page.frameLocator('#booking');
    expect(await classify(widget.locator('#slot-1900'))).toBe('ordinary');
    expect(await classify(widget.locator('#party'), 'select')).toBe('ordinary');
  });

  it('keeps preparation on a transaction page ordinary and refuses its commits', async () => {
    await visit(OPEN_WEB.payment);
    expect(await facts(page.locator('#continue'))).toMatchObject({ transaction: true, region: { transaction: true } });
    // AE1: a coupon and a quantity change on a checkout with a total and a saved card run as ordinary clicks.
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
    expect(classifyNavigationUrl(OPEN_WEB.redirect)).toBe('ordinary');
    expect(classifyNavigationUrl(OPEN_WEB.platform)).toBe('ordinary');
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

  it('refuses speaking: contact forms, a review, a comment box, a formless chat and a chat widget frame', async () => {
    for (const url of [OPEN_WEB.contact, OPEN_WEB.support]) {
      await visit(url);
      await page.locator('input[name="name"]').fill('Morgan Ellery');
      await page.locator('input[name="email"]').fill('morgan.ellery@example.test');
      expect(await classify(page.locator('#send'))).toBe('ordinary');
      await page.locator('#message').fill('Do you ship to Canada?');
      expect(await classify(page.locator('#send'))).toBe('speaks_as_principal');
    }
    await visit(OPEN_WEB.review);
    await page.locator('#review-text').fill('Lovely apron, sturdy pockets.');
    expect(await classify(page.locator('#post'))).toBe('speaks_as_principal');
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
    const db = new SqliteDriver(new Database(':memory:'));
    try {
      await db.exec(
        "CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('job-1');",
      );
      await browserSiteLeasesMigration.up(db);
      const context = {
        job: { id: 'job-1' },
        request: { id: 'request-1' },
        session: {},
        store: new BrowserStore(db),
        page: async () => page,
        assertActive: async () => undefined,
        wakeWaiters: async () => undefined,
        remaining: () => 15_000,
        signal: new AbortController().signal,
      } as unknown as BrowserExecutionContext;
      // The page loads before the job's navigation guard, which refuses documents between operations.
      await visit(OPEN_WEB.help);
      await page.locator('#chat-input').fill('Where is my order?');
      const observation = await observePage(page);
      const line = observation.snapshot.split('\n').find((candidate) => candidate.includes('Type a message'));
      const ref = line && /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1];
      if (!ref) throw new Error(`Missing chat input in ${observation.snapshot}`);
      const result = await executeBrowserBatch(
        context,
        { actions: [{ kind: 'key', ref, generation: observation.generation, key: 'Enter' }] },
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
  let fixture: OpenWebFixture;
  let page: Page;
  let db: SqliteDriver;
  const JOB = 'job-consent';

  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    page = await fixture.newPage();
    db = new SqliteDriver(new Database(':memory:'));
    await db.exec(
      `CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('${JOB}');`,
    );
    await browserSiteLeasesMigration.up(db);
    await browserConsentMigration.up(db);
    fixture.requests.length = 0;
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
  async function pass(target: Locator, purchase = false): Promise<ConsentPassResult> {
    const element = await target.elementHandle();
    if (!element) throw new Error('Fixture control missing');
    try {
      return await runConsentPass(page, element, { scope: scope(), purchase });
    } finally {
      await element.dispose();
    }
  }
  async function classify(target: Locator): Promise<string> {
    const element = await target.elementHandle();
    if (!element) throw new Error('Fixture control missing');
    try {
      return await classifyActivation(page, element);
    } finally {
      await element.dispose();
    }
  }
  const checked = (selector: string): Promise<boolean> =>
    page.locator(selector).evaluate((node) => (node as unknown as { checked: boolean }).checked);
  /** One batch through the executor, as the browser agent sends it, aimed by each control's accessible name. */
  async function act(...steps: Array<[kind: 'click' | 'key', name: string]>): Promise<Record<string, unknown>> {
    const observation = await observePage(page);
    const actions = steps.map(([kind, name]): BrowserAction => {
      const line = observation.snapshot.split('\n').find((candidate) => candidate.includes(`"${name}"`));
      const ref = line && /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1];
      if (!ref) throw new Error(`Missing ${name} in ${observation.snapshot}`);
      return kind === 'key'
        ? { kind, ref, generation: observation.generation, key: 'Enter' }
        : { kind, ref, generation: observation.generation };
    });
    const context = {
      job: { id: JOB },
      request: { id: `request-${Math.random()}` },
      session: {},
      store: new BrowserStore(db),
      page: async () => page,
      assertActive: async () => undefined,
      wakeWaiters: async () => undefined,
      remaining: () => 15_000,
      signal: new AbortController().signal,
    } as unknown as BrowserExecutionContext;
    return executeBrowserBatch(context, { actions }, { record: false });
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

  it('unticks a pre-ticked offers box on a free booking with a real click on its label (AE2)', async () => {
    await visit(CONSENT.offers);
    expect(await checked('#offers')).toBe(true);
    expect(await pass(page.locator('#reserve'))).toEqual({ status: 'ready', agreements: [], addOns: [] });
    expect(await checked('#offers')).toBe(false);
    // The box changed under a trusted click on its styled label, never a dispatched one.
    expect(await page.locator('body').getAttribute('data-trusted')).toBe('true');
    // The host's own press, which free commits run next, submits the booking without the offers.
    await Promise.all([page.waitForURL('**/confirm'), page.locator('#reserve').click()]);
    const booking = fixture.requests.find((request) => request.method === 'POST');
    expect(new URLSearchParams(booking?.body)).toEqual(new URLSearchParams({ party: '2' }));
    expect(await stops()).toEqual([]);
  });

  it('ticks an inverted newsletter box, which opts out, before the form submits (AE5)', async () => {
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
    });
    expect(stop).toMatchObject({ origin: 'https://join.example', kind: 'marketing', status: 'open' });
    expect(await checked('#offers')).toBe(true);
  });

  it('stops for a required opt-in, and after the principal agrees ticks only that box, until the wording changes or the grant is withdrawn (AE6)', async () => {
    await visit(CONSENT.required);
    const stopped = await act(['click', 'Join']);
    const [stop] = await stops();
    expect(stopped).toMatchObject({
      status: 'stopped',
      reason: 'consent_required',
      consent: [{ stop_id: stop.id, site: 'join.example', wording: 'I agree to receive marketing' }],
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

  it('stops for a bundled box, a waiver and an age attestation, naming each, and ticks none', async () => {
    for (const [url, control, wording] of [
      [CONSENT.bundled, '#join-button', 'I agree to the Terms and to receive marketing emails'],
      [CONSENT.waiver, '#climb-button', 'I have read and accept the liability waiver'],
      [CONSENT.attestation, '#enter', 'I confirm I am 21 or older'],
    ] as const) {
      await visit(url);
      expect(await pass(page.locator(control))).toMatchObject({ status: 'consent_required', stops: [{ wording }] });
      expect(
        await page
          .locator('input[type="checkbox"]')
          .evaluate((node) => (node as unknown as { checked: boolean }).checked),
      ).toBe(false);
    }
    expect((await stops()).map((stop) => stop.kind)).toEqual(['bundled', 'agreement', 'agreement']);
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

/** A PNG's width and height, as its header states them. */
function pngSize(data: Buffer): { width: number; height: number } {
  expect(data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** The aria ref of the one control named `name` in an observation, with its generation. */
function refIn(observation: { snapshot: string; generation: number }, name: string): BrowserRef {
  const line = observation.snapshot.split('\n').find((candidate) => candidate.includes(`"${name}"`));
  const ref = line && /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1];
  if (!ref) throw new Error(`Missing ${name} in ${observation.snapshot}`);
  return { ref, generation: observation.generation };
}

describe.skipIf(!chromePath)('ordinary actions in native Chrome', { timeout: 60_000 }, () => {
  let fixture: OpenWebFixture;
  let db: SqliteDriver;
  let pages: Page[];

  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    pages = [];
    db = new SqliteDriver(new Database(':memory:'));
    await db.exec(
      "CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('job-a'),('job-b');",
    );
    await browserSiteLeasesMigration.up(db);
    await browserConsentMigration.up(db);
    await browserRecipesMigration.up(db);
    fixture.requests.length = 0;
  });
  afterEach(async () => {
    for (const page of pages) await page.context().close();
    await db?.close();
  });

  const open = async (): Promise<Page> => {
    const page = await fixture.newPage();
    pages.push(page);
    return page;
  };
  /** A job's request context over the fixture's page, as the queue builds one. */
  const context = (page: Page, job = 'job-a'): BrowserExecutionContext =>
    ({
      job: { id: job, thread_id: job },
      request: { id: `request-${randomUUID()}` },
      session: {},
      store: new BrowserStore(db),
      page: async () => page,
      assertActive: async () => undefined,
      wakeWaiters: async () => undefined,
      remaining: () => 30_000,
      signal: new AbortController().signal,
    }) as unknown as BrowserExecutionContext;
  const batch = (page: Page, actions: BrowserAction[], job = 'job-a'): Promise<Record<string, unknown>> =>
    executeBrowserBatch(context(page, job), { actions }, { record: false });
  const go = (page: Page, url: string, job = 'job-a'): Promise<Record<string, unknown>> =>
    batch(page, [{ kind: 'navigate', url }], job);
  /** A click on each named control, in one batch, aimed from one fresh observation. */
  const click = async (page: Page, ...names: string[]): Promise<Record<string, unknown>> => {
    const observation = await observePage(page);
    return batch(
      page,
      names.map((name) => ({ kind: 'click', ...refIn(observation, name) })),
    );
  };
  const posts = (): string[] =>
    fixture.requests.filter((request) => request.method !== 'GET').map((request) => request.url);

  it('runs a script button, a box, a radio choice and a select as real actions', async () => {
    const page = await open();
    expect(await go(page, OPEN_WEB.faq)).toMatchObject({ status: 'stopped', reason: 'navigated' });
    const observation = await observePage(page);
    expect(
      await batch(page, [
        { kind: 'click', ...refIn(observation, 'Show delivery times') },
        { kind: 'click', ...refIn(observation, 'This is a gift') },
        { kind: 'click', ...refIn(observation, 'Cloth') },
        { kind: 'select', ...refIn(observation, 'Country'), value: 'Canada' },
      ]),
    ).toMatchObject({ status: 'completed' });
    expect(await page.locator('#times').isVisible()).toBe(true);
    expect(await page.locator('#toggle').getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#gift').isChecked()).toBe(true);
    expect(await page.locator('#cloth').isChecked()).toBe(true);
    expect(await page.locator('#country').inputValue()).toBe('Canada');
    expect(posts()).toEqual([]);
  });

  it('fails a click on a control an overlay covers, instead of pressing the overlay', async () => {
    const page = await open();
    await go(page, OPEN_WEB.overlay);
    expect(await click(page, 'Search')).toMatchObject({
      status: 'stopped',
      reason: 'not_actionable',
      actions: [{ status: 'stopped', reason: 'not_actionable' }],
    });
    expect(posts()).toEqual([]);
    expect(page.url()).toBe(OPEN_WEB.overlay);
  });

  it('refuses a page timer that posts after the batch, follows its GET on the leased site, and refuses one to another site', async () => {
    const page = await open();
    const guard = await ensureBrowserNavigationGuard(page);
    /** A refused load ends on Chrome's own error page. */
    const refused = async (): Promise<void> => {
      await expect.poll(() => guard.reason(), { timeout: 10_000 }).toBe('blocked_address');
      await expect.poll(() => page.url(), { timeout: 10_000 }).toMatch(/^chrome-error:/u);
    };
    await go(page, OPEN_WEB.timers);
    expect(await click(page, 'Save for later')).toMatchObject({ status: 'completed' });
    await refused();
    expect(posts()).toEqual([]);
    // The next operation navigates again.
    expect(await go(page, OPEN_WEB.timers)).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(await click(page, 'Refresh deals')).toMatchObject({ status: 'completed' });
    await page.waitForURL('https://shop.example/deals/today', { timeout: 10_000 });
    expect(guard.reason()).toBeUndefined();
    await go(page, OPEN_WEB.timers);
    expect(await click(page, 'See partner offer')).toMatchObject({ status: 'completed' });
    await refused();
    expect(fixture.requests.filter((request) => request.url.startsWith('https://partner.example'))).toEqual([]);
    expect(await go(page, OPEN_WEB.timers)).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(page.url()).toBe(OPEN_WEB.timers);
  });

  it('refuses script posts to a payment processor or a checkout route during an ordinary click, from the page and its payment frame', async () => {
    const page = await open();
    await go(page, OPEN_WEB.scripted);
    const frame = page.frames().find((candidate) => candidate.url() === PROCESSOR.frame);
    if (!frame) throw new Error('The payment frame did not load');
    // The payment frame runs out of process: its requests leave from its own target.
    await (await page.context().newCDPSession(frame)).detach();
    for (const name of ['Show delivery estimate', 'Check stock', 'Update cart', 'Show wallet options'])
      expect(await click(page, name)).toMatchObject({ status: 'completed' });
    expect(posts()).toEqual([]);
    // The awaited GET went out; only the post after it was refused.
    expect(fixture.requests.map((request) => request.url)).toContain('https://shop.example/api/stock');
    expect(await page.locator('#status').textContent()).toBe('refused');
    // Once the last action's window has closed nothing is paused: the page's own post reaches the processor.
    await (await ensureBrowserNavigationGuard(page)).actionsSettled();
    await page.evaluate(`fetch('${PROCESSOR.confirm}', { method: 'POST', mode: 'no-cors', body: 'outside' })`);
    await expect.poll(posts).toEqual([PROCESSOR.confirm]);
  });

  it('returns an ordinary click well before its window closes, and still refuses the payment post its page sends later', async () => {
    const page = await open();
    await go(page, OPEN_WEB.scripted);
    // Page script that posts to the payment processor 700 ms after the click, inside the old one-second hold.
    await page.evaluate(`(() => {
  const later = document.createElement('button');
  later.type = 'button';
  later.textContent = 'Show estimate later';
  later.addEventListener('click', () => {
    window.clickedAt = performance.now();
    setTimeout(() => { window.posted = true; void post('${PROCESSOR.confirm}', 'after=delay'); }, 700);
  });
  document.body.append(later);
})()`);
    const element = await page.getByRole('button', { name: 'Show estimate later' }).elementHandle();
    if (!element) throw new Error('Fixture control missing');
    try {
      // The activation boundary alone, inside the job's operation: a batch goes on to observe the page.
      const pressed = await withBrowserJobNavigation(context(page), page, () =>
        activateControl(page, element, () => element.click({ noWaitAfter: true })),
      );
      expect(pressed).toEqual({ ordinaryPress: true });
    } finally {
      await element.dispose();
    }
    const returned = (await page.evaluate(
      '({ elapsed: performance.now() - window.clickedAt, posted: window.posted === true })',
    )) as { elapsed: number; posted: boolean };
    // The click returned before its page posted, not a second after it.
    expect(returned.posted).toBe(false);
    expect(returned.elapsed).toBeLessThan(700);
    // The post still fell inside the click's window.
    await expect.poll(() => page.locator('#status').textContent()).toBe('refused');
    expect(posts()).toEqual([]);
  });

  it('never slows a widget polling with GETs, during an action or after it', async () => {
    const page = await open();
    await go(page, OPEN_WEB.live);
    const clock = (): Promise<number> => page.evaluate(() => performance.now());
    const started = await clock();
    expect(await click(page, 'Show more')).toMatchObject({ status: 'completed' });
    const ended = await clock();
    await page.waitForTimeout(1_000);
    const polls = (await page.evaluate('window.polls')) as Array<{ at: number; ok: boolean; ms: number }>;
    expect(polls.every((poll) => poll.ok)).toBe(true);
    expect(Math.max(...polls.map((poll) => poll.ms))).toBeLessThan(250);
    // The widget kept its pace through the action's window and after it.
    expect(polls.filter((poll) => poll.at >= started && poll.at <= ended).length).toBeGreaterThanOrEqual(
      Math.floor((ended - started) / 200),
    );
    expect(polls.filter((poll) => poll.at > ended).length).toBeGreaterThanOrEqual(5);
    expect(await page.locator('#extra').isVisible()).toBe(true);
  });

  it('replays a read-only recipe along GET links on an unreviewed site, and refuses its POST', async () => {
    const page = await open();
    const recording = context(page);
    const record = (actions: BrowserAction[]) => executeBrowserBatch(recording, { actions });
    await record([{ kind: 'navigate', url: OPEN_WEB.article }]);
    await record([{ kind: 'click', ...refIn(await observePage(page), 'About us') }]);
    const about = await saveBrowserRecipe(recording, {
      name: 'About',
      first_action: 0,
      last_action: 1,
      parameters: [],
    });
    expect(about).toMatchObject({ status: 'saved', read_only: true });
    expect(
      await executeRecipe(
        context(page),
        { recipe_id: about.recipe_id, parameters: {} },
        { page, readOnly: true, record: false },
      ),
    ).toMatchObject({ status: 'completed' });
    expect(page.url()).toBe(OPEN_WEB.about);
    await record([{ kind: 'navigate', url: OPEN_WEB.availability }]);
    await record([{ kind: 'click', ...refIn(await observePage(page), 'Refresh availability') }]);
    expect(posts()).toEqual(['https://bistro.example/availability/hold']);
    const hold = await saveBrowserRecipe(recording, {
      name: 'Tables',
      first_action: 2,
      last_action: 3,
      parameters: [],
    });
    expect(hold).toMatchObject({ status: 'saved', read_only: true });
    expect(
      await executeRecipe(
        context(page),
        { recipe_id: hold.recipe_id, parameters: {} },
        { page, readOnly: true, record: false },
      ),
    ).toMatchObject({ status: 'checkpoint_failed', step: 1, found: { reason: 'read_only' } });
    expect(posts()).toEqual(['https://bistro.example/availability/hold']);
  });

  it('stops typing into a card field with card_field, on the page and inside a processor frame', async () => {
    const page = await open();
    await go(page, OPEN_WEB.platform);
    const typed = async (name: string): Promise<unknown> =>
      batch(page, [{ kind: 'type', ...refIn(await observePage(page), name), text: '4242 4242 4242 4242' }]);
    expect(await typed('Card number')).toMatchObject({ status: 'stopped', reason: 'card_field' });
    expect(await typed('Expiry')).toMatchObject({ status: 'stopped', reason: 'card_field' });
    expect(await page.locator('input[name="cardnumber"]').inputValue()).toBe('');
    // A gift card's number is no card entry: the secret rule keeps it out of ordinary typing.
    expect(await typed('Gift card number')).toMatchObject({ status: 'stopped', reason: 'secret_field' });
    await go(page, OPEN_WEB.hostedCard);
    await page.frameLocator('#card-frame').locator('input[name="cardnumber"]').waitFor();
    for (const name of ['Card number', 'CVC']) expect(await typed(name)).toMatchObject({ reason: 'card_field' });
    expect(await page.frameLocator('#card-frame').locator('input[name="cardnumber"]').inputValue()).toBe('');
  });

  it('lets two jobs whose pages embed the same third-party frame each load it: a frame takes no lease', async () => {
    const [first, second] = [await open(), await open()];
    expect(await go(first, OPEN_WEB.product, 'job-a')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    await first.frameLocator('#pay-later').locator('text=Pay in 4').waitFor();
    expect(await go(second, OPEN_WEB.giftCards, 'job-b')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    await second.frameLocator('#pay-later').locator('text=Pay in 4').waitFor();
    expect(await db.all('SELECT site, job_id FROM gws_ea_browser_site_leases ORDER BY site')).toEqual([
      { site: 'bistro.example', job_id: 'job-b' },
      { site: 'shop.example', job_id: 'job-a' },
    ]);
  });
});

describe.skipIf(!chromePath)('ordinary presses that buy, in native Chrome', { timeout: 60_000 }, () => {
  const PRINCIPAL = 'gchat:users/principal';
  let fixture: OpenWebFixture;
  let page: Page;
  let queue: BrowserQueue;
  let session: Session;
  let main: Session;
  let closed: number;
  const posts = (): string[] =>
    fixture.requests.filter((request) => request.method !== 'GET').map((request) => request.url);

  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    fs.mkdirSync(`${root}/browser`, { recursive: true });
    fs.writeFileSync(`${root}/browser/policy.json`, JSON.stringify({ schemaVersion: 1, enabled: true }), {
      mode: 0o600,
    });
    process.env.GWS_EA_BROWSER_POLICY_FILE = `${root}/browser/policy.json`;
    await runMigrations(await initTestDb());
    for (const id of ['main-p', 'browser-p'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await createMessagingGroup({
      id: 'mg-principal',
      channel_type: 'gchat',
      platform_id: 'spaces/principal',
      name: 'principal',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Morgan',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: 'main-p',
      principalEmails: ['morgan@example.test'],
    });
    await getDb().run('UPDATE gws_ea_profile SET browser_agent_group_id = ? WHERE singleton = 1', 'browser-p');
    await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: new Date().toISOString() });
    await upsertUserDm({
      user_id: PRINCIPAL,
      channel_type: 'gchat',
      messaging_group_id: 'mg-principal',
      resolved_at: new Date().toISOString(),
    });
    await bindVerifiedPrincipalUser(PRINCIPAL, new Date().toISOString());
    main = (await resolveSession('main-p', 'mg-principal', null, 'agent-shared')).session;
    session = (await resolveSystemSession('browser-p', 'system:a2a:main-p:reorder')).session;
    page = await fixture.newPage();
    closed = 0;
    queue = new BrowserQueue(new BrowserStore(), {
      pageForJob: async () => page,
      connection: async (): Promise<never> => {
        throw new Error('Not used');
      },
      closeJob: async () => {
        closed++;
      },
      onDisconnected: () => () => undefined,
    });
    configureBrowserCancellation(queue);
    await queue.start();
    setBrowserAdmissionReady(true);
    fixture.requests.length = 0;
    vi.mocked(requestWake).mockClear();
  });
  afterEach(async () => {
    setBrowserAdmissionReady(false);
    await queue?.stop();
    await page?.context().close();
    delete process.env.GWS_EA_BROWSER_POLICY_FILE;
    await closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** One browser request through the queue, as the browser agent sends it; its answer's data. */
  async function run(id: string, actions: BrowserAction[]): Promise<Record<string, unknown>> {
    await queue.accept('browser', { actions }, session, id);
    await queue.idle();
    const row = await getDb().get<{ answer_json: string }>(
      'SELECT answer_json FROM gws_ea_browser_requests WHERE session_id = ? AND request_id = ?',
      session.id,
      id,
    );
    if (!row) throw new Error(`No answer for ${id}`);
    return (JSON.parse(row.answer_json) as { data: Record<string, unknown> }).data;
  }
  /** Opens `url`, then presses the control named `name` from the observation the navigation answered with. */
  async function press(url: string, name: string): Promise<Record<string, unknown>> {
    const opened = await run(`open-${name}`, [{ kind: 'navigate', url }]);
    const observation = opened.observation as { snapshot: string; generation: number };
    return run(`press-${name}`, [{ kind: 'click', ...refIn(observation, name) }]);
  }
  const incidents = () =>
    getDb().all<{ kind: string; site: string; job_id: string; attempt_id: string | null; notified_at: string | null }>(
      'SELECT kind, site, job_id, attempt_id, notified_at FROM gws_ea_browser_incidents',
    );
  /** What the host wrote in main's conversation. */
  const mainNotes = (): Promise<string[]> =>
    withExistingMailboxSession('main-p', main.id, (mailbox) =>
      mailbox.getInboundHistory(20).map((message) => message.content),
    ).then((contents) => contents ?? []);

  it('stops the job, records an incident and tells main at once when an ordinary Submit lands on a paid order confirmation', async () => {
    const answer = await press(OPEN_WEB.reorder, 'Submit');
    expect(answer).toMatchObject({
      status: 'stopped',
      reason: 'unapproved_commit',
      incident: { site: 'shop.example', reference: 'SO-48213', charged: '$42.00' },
      actions: [{ status: 'stopped', reason: 'unapproved_commit' }],
      repeat_safe: false,
    });
    expect(posts()).toEqual(['https://shop.example/reorder/submit']);
    const [incident] = await incidents();
    expect(incident).toMatchObject({
      kind: 'unapproved_commit',
      site: 'shop.example',
      job_id: session.thread_id,
      attempt_id: null,
      notified_at: expect.any(String),
    });
    expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', session.thread_id)).toEqual({
      cancelled: 1,
    });
    expect(closed).toBeGreaterThan(0);
    const notes = await mainNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('SO-48213');
    expect(notes[0]).toContain('$42.00');
    expect(notes[0]).toContain(String(session.thread_id));
    expect(vi.mocked(requestWake).mock.calls.some(([woken]) => woken.id === main.id)).toBe(true);
    // The job is over: its next request is refused before it runs.
    await expect(run('after', [{ kind: 'observe' }])).rejects.toThrow();
  });

  it('waits out a press whose script posts to the merchant’s own API and then loads a paid confirmation, and stops the job', async () => {
    const quick = 'https://shop.example/quick-reorder';
    fixture.serve(
      quick,
      `<!doctype html><html><head><title>Quick reorder</title></head><body><h1>Reorder your last items</h1>
<button type="button" id="reorder">Reorder</button>
<script>document.getElementById('reorder').addEventListener('click', async () => {
  await fetch('/api/quick-reorder', { method: 'POST', body: 'item=apron' });
  location.assign('/orders/placed');
});</script></body></html>`,
    );
    fixture.serve('https://shop.example/api/quick-reorder', () => ({
      headers: { 'content-type': 'application/json' },
      body: '{"status":"accepted"}',
    }));
    fixture.serve('https://shop.example/orders/placed', orderConfirmationPage());
    // The merchant's API answers 400 ms after the press, as a server charging a saved card might: the fetch is held
    // at the network layer, so the page navigates only once it returns.
    const slow = await page.context().newCDPSession(page);
    slow.on('Fetch.requestPaused', (event) => {
      setTimeout(() => {
        void slow.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined);
      }, 400);
    });
    await slow.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/quick-reorder', requestStage: 'Request' }] });
    try {
      const answer = await press(quick, 'Reorder');
      expect(answer).toMatchObject({
        status: 'stopped',
        reason: 'unapproved_commit',
        incident: { site: 'shop.example', reference: 'SO-48213', charged: '$42.00' },
        actions: [{ status: 'stopped', reason: 'unapproved_commit' }],
      });
      // The press waited for the navigation its script started, and read the confirmation on the new page.
      expect(page.url()).toBe('https://shop.example/orders/placed');
      expect(posts()).toEqual(['https://shop.example/api/quick-reorder']);
      expect(await incidents()).toMatchObject([{ kind: 'unapproved_commit', site: 'shop.example' }]);
    } finally {
      await slow.detach().catch(() => undefined);
    }
  });

  it('raises nothing for a waitlist number or a $0.00 registration', async () => {
    expect(await press(OPEN_WEB.waitlist, 'Join')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(await page.locator('h1').textContent()).toBe("You're on the waitlist");
    expect(await press(OPEN_WEB.rsvp, 'RSVP')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(await page.locator('h1').textContent()).toBe('Registration confirmed');
    expect(await incidents()).toEqual([]);
    expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', session.thread_id)).toEqual({
      cancelled: 0,
    });
    expect(await mainNotes()).toEqual([]);
  });
});

describe.skipIf(!chromePath)('cookie banners in native Chrome', { timeout: 30_000 }, () => {
  let fixture: OpenWebFixture;
  let page: Page;
  let db: SqliteDriver;
  const JOB = 'job-banners';

  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    page = await fixture.newPage();
    db = new SqliteDriver(new Database(':memory:'));
    await db.exec(
      `CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('${JOB}');`,
    );
    await browserSiteLeasesMigration.up(db);
    fixture.requests.length = 0;
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
  ): Promise<{ result: Record<string, unknown>; seen: BrowserObservation }> {
    const context = {
      job: { id: JOB },
      request: { id: `request-${Math.random()}` },
      session: {},
      store: new BrowserStore(db),
      page: async () => page,
      assertActive: async () => undefined,
      wakeWaiters: async () => undefined,
      remaining: () => 15_000,
      signal: new AbortController().signal,
    } as unknown as BrowserExecutionContext;
    const result = await executeBrowserBatch(context, { actions }, { record: false });
    return { result, seen: result.observation as BrowserObservation };
  }
  const observe = () => batch({ kind: 'observe' });
  /** What the page's banner received: its choice, whether a real click made it, and how many presses it took. */
  const received = () =>
    page
      .locator('body')
      .evaluate((body) => ({ ...(body as unknown as { dataset: Record<string, string | undefined> }).dataset }));

  it('rejects a OneTrust and a Cookiebot banner with a real click, and neither is in the next observation', async () => {
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

    await visit(COOKIE_BANNERS.cookiebot);
    const rejected = (await observe()).seen;
    expect(rejected.cookie_banner).toEqual({ status: 'rejected' });
    expect(rejected.snapshot).not.toContain('This website uses cookies');
    expect(await received()).toEqual({ choice: 'reject', trusted: 'true', presses: '1' });
    expect((await observe()).seen.cookie_banner).toBeUndefined();
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

describe.skipIf(!chromePath)('personal data in native Chrome (KTD19, R34)', { timeout: 60_000 }, () => {
  const MOBILE = '+1 415 555 0134';
  const HOME = '123 Main Street, Springfield';
  let fixture: OpenWebFixture;
  let page: Page;
  let queue: BrowserQueue;
  let main: Session;
  let errand: Session;
  let mobile: string;
  const posts = (): OpenWebRequest[] => fixture.requests.filter((request) => request.method !== 'GET');
  const policy = (content: Record<string, unknown>): void =>
    fs.writeFileSync(`${root}/browser/policy.json`, JSON.stringify(content), { mode: 0o600 });

  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    fs.mkdirSync(`${root}/browser`, { recursive: true });
    policy({ schemaVersion: 1, enabled: true });
    process.env.GWS_EA_BROWSER_POLICY_FILE = `${root}/browser/policy.json`;
    await runMigrations(await initTestDb());
    for (const id of ['main-p', 'browser-p'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Juno',
      assistantWorkspaceEmail: 'juno@assistant.example',
      principalDisplayName: 'Morgan',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: 'main-p',
      principalEmails: ['morgan@example.test'],
    });
    await getDb().run('UPDATE gws_ea_profile SET browser_agent_group_id = ? WHERE singleton = 1', 'browser-p');
    main = (await resolveSystemSession('main-p', 'system:test:main')).session;
    errand = (await resolveSystemSession('browser-p', 'system:a2a:main-p:dinner')).session;
    mobile = (await addPrivateValue({ label: 'Mobile', kind: 'phone', value: MOBILE })).id;
    await addPrivateValue({ label: 'Home', kind: 'address', value: HOME });
    page = await fixture.newPage();
    queue = new BrowserQueue(new BrowserStore(), {
      pageForJob: async () => page,
      connection: async (): Promise<never> => {
        throw new Error('Not used');
      },
      closeJob: async () => undefined,
      onDisconnected: () => () => undefined,
    });
    configureBrowserCancellation(queue);
    await queue.start();
    setBrowserAdmissionReady(true);
    fixture.requests.length = 0;
  });
  afterEach(async () => {
    setBrowserAdmissionReady(false);
    await queue?.stop();
    await page?.context().close();
    delete process.env.GWS_EA_BROWSER_POLICY_FILE;
    await closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** One request through the queue, as the errand's browser agent sends it; its answer's data, without the queue's timing. */
  async function request(
    id: string,
    action: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await queue.accept(action, content, errand, id);
    await queue.idle();
    const row = await getDb().get<{ answer_json: string }>(
      'SELECT answer_json FROM gws_ea_browser_requests WHERE session_id = ? AND request_id = ?',
      errand.id,
      id,
    );
    if (!row) throw new Error(`No answer for ${id}`);
    const { timing: _timing, ...data } = (JSON.parse(row.answer_json) as { data: Record<string, unknown> }).data;
    return data;
  }
  const run = (id: string, actions: BrowserAction[]) => request(id, 'browser', { actions });
  /** Opens `url` and answers with the observation the navigation returned. */
  async function open(url: string): Promise<BrowserObservation> {
    const opened = await run(`open-${randomUUID()}`, [{ kind: 'navigate', url }]);
    expect(opened).toMatchObject({ status: 'stopped', reason: 'navigated' });
    return opened.observation as BrowserObservation;
  }
  const disclose = (site: string) =>
    recordDisclosureRequest({ thread: errand.thread_id, site, value_id: mobile }, main);
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

  it('refuses a mobile number split across area-code, exchange and line fields on a site no disclosure covers', async () => {
    await disclose('osteria.example');
    const form = await open(PERSONAL_DATA.callback);
    expect(
      await run('callback', [
        {
          kind: 'form_input',
          fields: [
            { ...refIn(form, 'Area code'), value: '415' },
            { ...refIn(form, 'Exchange'), value: '555' },
            { ...refIn(form, 'Line'), value: '0134' },
          ],
          submit: refIn(form, 'Call me'),
        },
      ]),
    ).toEqual(refusedBeforeTyping);
    for (const name of ['area', 'exchange', 'line'])
      expect(await page.locator(`input[name="${name}"]`).inputValue()).toBe('');
    expect(posts()).toEqual([]);
  });

  it('refuses a stored value main never disclosed on every site, the restaurant main named included', async () => {
    await disclose('osteria.example');
    const booking = await open(PERSONAL_DATA.booking);
    expect(await run('booking-address', [{ kind: 'type', ...refIn(booking, 'Name'), text: '123 Main St' }])).toEqual(
      refusedBeforeTyping,
    );
    const claim = await open(PERSONAL_DATA.claim);
    expect(
      await run('claim-address', [
        { kind: 'type', ...refIn(claim, 'Home address'), text: '123 Main Street, Springfield' },
      ]),
    ).toEqual(refusedBeforeTyping);
    expect(await page.locator('input[name="address"]').inputValue()).toBe('');
    expect(posts()).toEqual([]);
  });

  it('refuses an address that carries the home address in its query, before the request leaves', async () => {
    await open(PERSONAL_DATA.booking);
    const directions = `${PERSONAL_DATA.directions}?from=${encodeURIComponent(HOME)}&to=Osteria%20del%20Ponte`;
    expect(await run('directions', [{ kind: 'navigate', url: directions }])).toEqual(refusedBeforeTyping);
    expect(fixture.requests.filter((sent) => sent.url.startsWith('https://maps.example'))).toEqual([]);
    expect(page.url()).toBe(PERSONAL_DATA.booking);
  });

  it('signs the principal in to their own account with their address from 1Password, and refuses that address in a newsletter field', async () => {
    const resolve = vi.spyOn(browserVault, 'resolve').mockResolvedValue('morgan@example.test');
    try {
      const signIn = await open(PERSONAL_DATA.signIn);
      expect(
        await request('sign-in', 'fill_secret', {
          item_handle: 'vault_osteria',
          field: 'username',
          target: refIn(signIn, 'Email'),
          submit: refIn(signIn, 'Continue'),
        }),
      ).toEqual({ status: 'submitted' });
      expect(resolve).toHaveBeenCalledWith(
        'vault_osteria',
        'username',
        'https://osteria.example',
        expect.any(Function),
      );
      // The host's sign-in submission runs the consent pass first: the site's pre-ticked offers box goes unticked.
      expect(posts().map((sent) => [sent.url, Object.fromEntries(new URLSearchParams(sent.body))])).toEqual([
        [PERSONAL_DATA.signIn, { email: 'morgan@example.test' }],
      ]);
      expect(await page.locator('h1').textContent()).toBe('Welcome back');
    } finally {
      resolve.mockRestore();
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

describe.skipIf(!chromePath)('purchases on unreviewed sites in native Chrome', { timeout: 60_000 }, () => {
  const PRINCIPAL = 'gchat:users/principal';
  const ALIAS = 'aya.web@example.test';
  let fixture: OpenWebFixture;
  let page: Page;
  let queue: BrowserQueue;
  let session: Session;
  let main: Session;
  let sent: string[];
  /** The files each delivery carried, beside its content in `sent`. */
  let attached: Array<readonly OutboundFile[] | undefined>;
  const posts = (): string[] =>
    fixture.requests.filter((request) => request.method !== 'GET').map((request) => request.url);
  /** Each card posted: how many pictures it names, and the files that went with it. */
  const cards = (): Array<{ pictures: unknown; files: readonly OutboundFile[] | undefined }> =>
    sent.flatMap((content, index) => {
      const card = JSON.parse(content) as { type?: string; pictures?: unknown };
      return card.type === 'ask_question' ? [{ pictures: card.pictures, files: attached[index] }] : [];
    });

  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(`${root}/browser`, { recursive: true });
    fs.writeFileSync(`${root}/browser/policy.json`, JSON.stringify({ schemaVersion: 1, enabled: true }), {
      mode: 0o600,
    });
    process.env.GWS_EA_BROWSER_POLICY_FILE = `${root}/browser/policy.json`;
    await runMigrations(await initTestDb());
    for (const id of ['main-p', 'browser-p'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await createMessagingGroup({
      id: 'mg-principal',
      channel_type: 'gchat',
      platform_id: 'spaces/principal',
      name: 'principal',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Morgan',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: 'main-p',
      principalEmails: ['morgan@example.test'],
    });
    await getDb().run(
      'UPDATE gws_ea_profile SET browser_agent_group_id = ?, assistant_alias = ? WHERE singleton = 1',
      'browser-p',
      ALIAS,
    );
    await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: new Date().toISOString() });
    await upsertUserDm({
      user_id: PRINCIPAL,
      channel_type: 'gchat',
      messaging_group_id: 'mg-principal',
      resolved_at: new Date().toISOString(),
    });
    await bindVerifiedPrincipalUser(PRINCIPAL, new Date().toISOString());
    main = (await resolveSession('main-p', 'mg-principal', null, 'agent-shared')).session;
    session = (await resolveSystemSession('browser-p', 'system:a2a:main-p:checkout')).session;
    sent = [];
    attached = [];
    setDeliveryAdapter({
      async deliver(_type, _platformId, _thread, _kind, content, files) {
        sent.push(content);
        attached.push(files);
        return `message-${sent.length}`;
      },
    });
    page = await fixture.newPage();
    await prepareMerchantPage(page);
    queue = new BrowserQueue(new BrowserStore(), {
      pageForJob: async () => page,
      connection: async (): Promise<never> => {
        throw new Error('Not used');
      },
      closeJob: async () => undefined,
      onDisconnected: () => () => undefined,
    });
    configureBrowserCancellation(queue);
    registerBrowserPurchaseDelivery(() => queue);
    if (!getDeliveryAction('reservation_bounds')) registerReservationGuaranteeDelivery();
    await queue.start();
    await resumeBrowserPurchaseCommits(queue);
    setBrowserAdmissionReady(true);
    fixture.requests.length = 0;
  });
  afterEach(async () => {
    setBrowserAdmissionReady(false);
    await queue?.stop();
    await page?.context().close();
    delete process.env.GWS_EA_BROWSER_POLICY_FILE;
    await closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** One browser request through the queue, as the browser agent sends it; its answer's data. */
  async function answer(id: string): Promise<Record<string, unknown>> {
    const row = await getDb().get<{ answer_json: string }>(
      'SELECT answer_json FROM gws_ea_browser_requests WHERE session_id = ? AND request_id = ?',
      session.id,
      id,
    );
    if (!row) throw new Error(`No answer for ${id}`);
    return (JSON.parse(row.answer_json) as { data: Record<string, unknown> }).data;
  }
  async function run(id: string, actions: BrowserAction[]): Promise<Record<string, unknown>> {
    await queue.accept('browser', { actions }, session, id);
    await queue.idle();
    return answer(id);
  }
  const open = (url: string): Promise<Record<string, unknown>> =>
    run(`open-${randomUUID()}`, [{ kind: 'navigate', url }]);
  /** The agent's purchase of the control named `name`, aimed from a fresh observation. */
  async function purchase(name: string, id = `purchase-${randomUUID()}`): Promise<Record<string, unknown>> {
    const handler = getDeliveryAction('purchase');
    if (!handler) throw new Error('purchase delivery missing');
    await handler({ action: 'purchase', requestId: id, target: refIn(await observePage(page), name) }, session);
    await queue.idle();
    return answer(id);
  }
  const approvals = (): Promise<PendingApproval[]> =>
    getDb().all<PendingApproval>('SELECT * FROM pending_approvals ORDER BY created_at');
  async function approve(approval: PendingApproval): Promise<void> {
    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value: 'approve',
      userId: PRINCIPAL,
      channelType: 'gchat',
      platformId: 'spaces/principal',
      threadId: null,
    });
    await queue.idle();
  }
  const authorities = () =>
    getDb().all<{ state: string; facts_json: string; outcome_json: string | null }>(
      'SELECT state,facts_json,outcome_json FROM gws_ea_browser_authorities ORDER BY created_at',
    );
  const attempts = () =>
    getDb().all<{
      site: string;
      platform: string | null;
      account_key: string | null;
      resolution: string | null;
      merchant_record_id: string | null;
    }>(
      'SELECT site,platform,account_key,resolution,merchant_record_id FROM gws_ea_browser_purchase_attempts ORDER BY attempted_at',
    );
  const blocks = () => getDb().all<{ site: string }>('SELECT site FROM gws_ea_browser_purchase_blocks ORDER BY site');
  /** What the host wrote into a session's conversation, oldest first. */
  async function texts(into: Session): Promise<string[]> {
    return (
      (await withExistingMailboxSession(into.agent_group_id, into.id, (mailbox) =>
        mailbox
          .getInboundHistory(100)
          .map((message) => (JSON.parse(message.content) as { text?: string }).text ?? '')
          .reverse(),
      )) ?? []
    );
  }
  /** Main's notes that an attempt is unconfirmed. */
  const unconfirmedNotes = async (): Promise<string[]> =>
    (await texts(main)).filter((text) => text.includes('so it is unconfirmed'));
  /** Main's recorded bounds for this errand's table, and the principal's standing guarantee up to $100. */
  async function standingGuarantee(): Promise<void> {
    const bounds = getDeliveryAction('reservation_bounds');
    if (!bounds) throw new Error('reservation_bounds delivery missing');
    await bounds(
      {
        action: 'reservation_bounds',
        requestId: 'bounds',
        thread: session.thread_id!,
        venue_id: 'Trattoria Remy',
        party_size: 2,
        window_start: '2026-10-24T18:00:00-07:00',
        window_end: '2026-10-24T21:00:00-07:00',
      },
      main,
    );
    await getDb().run(
      'INSERT INTO gws_ea_browser_reservation_guarantees(id,approval_id,principal_user_id,currency,max_total_minor,created_at) VALUES(?,?,?,?,?,?)',
      'standing',
      'principal-approved',
      PRINCIPAL,
      'USD',
      10_000,
      new Date().toISOString(),
    );
  }
  const read = async (selector: string, frame?: string) => {
    const scope = frame ? page.frameLocator(frame) : page;
    const element = await scope.locator(selector).elementHandle();
    if (!element) throw new Error(`Fixture control missing: ${selector}`);
    const result = await readMerchantPurchase(page, element);
    if ('element' in result) await result.element.dispose();
    return result;
  };

  it('reads an unreviewed shop’s checkout into one card, and after approval re-reads, presses and reports placed (AE3)', async () => {
    await open(GENERIC.review);
    await run('note', [
      { kind: 'type', ...refIn(await observePage(page), 'Delivery instructions'), text: 'Leave it with the porter' },
    ]);
    expect(await purchase('Place order', 'ae3')).toMatchObject({ status: 'awaiting_principal' });
    expect(posts()).toEqual([]);
    const [approval] = await approvals();
    expect(sent).toHaveLength(1);
    // One picture goes with it: the clip of the total and the commit control, and nothing else of the page (KTD6).
    const [card] = cards();
    expect(card.pictures).toBe(1);
    expect(card.files).toHaveLength(1);
    expect(card.files![0]).toMatchObject({ filename: 'checkout.png', mimeType: 'image/png' });
    const boxes = await Promise.all(
      [page.locator('#checkout p').filter({ hasText: /^Order total/u }), page.locator('#commit')].map(
        async (target) => {
          const box = await target.boundingBox();
          if (!box) throw new Error('Fixture checkout box missing');
          return box;
        },
      ),
    );
    const left = Math.floor(Math.min(...boxes.map((box) => box.x)));
    const top = Math.floor(Math.min(...boxes.map((box) => box.y)));
    expect(pngSize(card.files![0].data)).toEqual({
      width: Math.ceil(Math.max(...boxes.map((box) => box.x + box.width))) - left,
      height: Math.ceil(Math.max(...boxes.map((box) => box.y + box.height))) - top,
    });
    for (const line of [
      'Site: pottery.example',
      'Account: guest checkout',
      "Contact email: your assistant's email",
      'Item: "Celadon mug × 2"',
      'Item: "Ash glaze bowl × 1"',
      'Total: $42.00 (USD)',
      'Due now: $42.00',
      'Payment: "Visa ending in 4242"',
      'Note: "Leave it with the porter"',
    ])
      expect(approval.question).toContain(line);
    expect(approval.question).not.toContain(ALIAS);
    expect(approval.question).not.toMatch(/attempt-|card-|authority-/u);
    await approve(approval);
    expect(posts()).toEqual([GENERIC.placed]);
    const [authority] = await authorities();
    expect(authority.state).toBe('committed');
    expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'placed', order_number: 'HP-1042' });
    expect(await attempts()).toEqual([
      {
        site: 'pottery.example',
        platform: null,
        account_key: ALIAS,
        resolution: 'committed',
        merchant_record_id: 'HP-1042',
      },
    ]);
    // The confirmation page resolved it, from the page, with no block and nothing for main to settle.
    expect(await getDb().get('SELECT resolution_source FROM gws_ea_browser_purchase_attempts')).toEqual({
      resolution_source: 'page',
    });
    expect(await blocks()).toEqual([]);
    expect(await unconfirmedNotes()).toEqual([]);
  });

  it('never resolves a second attempt from an order number its contact email already used', async () => {
    await open(GENERIC.review);
    await purchase('Place order');
    await approve((await approvals())[0]);
    // The merchant shows the same order number again after a second order.
    await open(GENERIC.review);
    expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
    await approve((await approvals())[0]);
    expect(posts()).toEqual([GENERIC.placed, GENERIC.placed]);
    const [first, second] = await authorities();
    expect(JSON.parse(first.outcome_json!)).toMatchObject({ status: 'placed', order_number: 'HP-1042' });
    expect(JSON.parse(second.outcome_json!)).toMatchObject({ status: 'unconfirmed' });
    expect(second.state).toBe('unknown');
    expect(await attempts()).toMatchObject([
      { resolution: 'committed', merchant_record_id: 'HP-1042' },
      { resolution: null, merchant_record_id: null },
    ]);
    expect(await blocks()).toEqual([{ site: 'pottery.example' }]);
  });

  it("keeps the picture's bytes out of the card's rows, the approval row, the databases and the logs", async () => {
    const logged: unknown[][] = [];
    const levels = (['debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) =>
      vi.spyOn(log, level).mockImplementation((...args) => {
        logged.push(args);
      }),
    );
    try {
      await open(GENERIC.review);
      expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
    } finally {
      for (const spy of levels) spy.mockRestore();
    }
    const picture = cards()[0]?.files?.[0]?.data;
    if (!picture) throw new Error('The card carried no picture');
    const written = [
      picture.toString('base64'),
      picture.toString('base64url'),
      picture.toString('hex'),
      picture.toString('latin1'),
    ];
    const seen = new WeakSet<object>();
    /** Whether a value holds the picture: in any written form, or as bytes. */
    const holds = (value: unknown): boolean => {
      if (typeof value === 'string') return written.some((form) => value.includes(form));
      if (typeof value !== 'object' || value === null || seen.has(value)) return false;
      seen.add(value);
      if (value instanceof Uint8Array) return Buffer.from(value).includes(picture.subarray(8, 64));
      return Object.values(value).some(holds);
    };
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_cards')).toHaveLength(1);
    expect(await approvals()).toHaveLength(1);
    for (const { name } of await getDb().all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'"))
      expect(holds(await getDb().all(`SELECT * FROM "${name}"`)), name).toBe(false);
    for (const held of [session, main])
      expect(
        holds(
          await withExistingMailboxSession(held.agent_group_id, held.id, (mailbox) => mailbox.getInboundHistory(100)),
        ),
      ).toBe(false);
    expect(logged.length).toBeGreaterThan(0);
    expect(holds(logged)).toBe(false);
  });

  it('refuses the picture on a document where the host inserted a secret, and takes it on the next one', async () => {
    const code = 'fixture-sign-in-code-4417';
    await open(GENERIC.review);
    // What the host's own fills do on inserting a value: the document holds it until it is replaced.
    registerPageSecret(page, code);
    await bindPageSecretDocuments(page, code);
    releasePageSecret(page, code);
    expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
    // A card that names a picture with none beside it says the picture is unavailable (the bridge's line).
    expect(cards()).toEqual([{ pictures: 1, files: undefined }]);
    await open(GENERIC.review);
    expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
    expect(cards()[1]).toMatchObject({ pictures: 1, files: [{ mimeType: 'image/png' }] });
  });

  it('refuses the picture when a field in an open or a closed shadow root holds a secret, and only then', async () => {
    const shadowed = (mode: 'open' | 'closed', field: string, value: string): string =>
      checkoutPage({
        action: '/checkout/placed',
        commit: 'Place order',
        items: ['Celadon mug × 2'],
        total: '$42.00',
        payment: 'Visa ending in 4242',
        email: ALIAS,
        outside: `<account-panel></account-panel><script>const root = document.querySelector('account-panel').attachShadow({ mode: '${mode}' }); root.innerHTML = '${field}'; root.querySelector('input').value = '${value}';</script>`,
      });
    const password = '<label>Password <input type="password" name="pw"></label>';
    const code = '<label>Code <input type="text" autocomplete="one-time-code"></label>';
    for (const [index, [mode, field, value, pictured]] of (
      [
        ['open', password, 'fixture-pass-7731', false],
        ['closed', code, '552913', false],
        ['open', password, '', true],
      ] as const
    ).entries()) {
      const address = `https://pottery.example/checkout/account-${index}`;
      fixture.serve(address, shadowed(mode, field, value));
      await open(address);
      expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
      expect(cards().at(-1), `${mode} root, ${value ? 'filled' : 'empty'}`).toMatchObject(
        pictured ? { pictures: 1, files: [{ mimeType: 'image/png' }] } : { pictures: 1, files: undefined },
      );
      // The agent's own screenshot meets the same scan: a secret in a shadow root never reaches it either.
      const shot = await run(`shot-${index}`, [{ kind: 'screenshot' }]);
      expect(shot, `${mode} root screenshot`).toMatchObject(
        pictured ? { status: 'completed' } : { status: 'stopped', reason: 'secret_field' },
      );
    }
  });

  it('posts the card when the capture fails, naming the picture it lacks', async () => {
    await open(GENERIC.review);
    const capture = vi.spyOn(page, 'screenshot').mockRejectedValueOnce(new Error('The capture failed'));
    try {
      expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      capture.mockRestore();
    }
    expect(cards()).toEqual([{ pictures: 1, files: undefined }]);
    expect(await approvals()).toHaveLength(1);
  });

  it('presses a free table itself with no card, unticking the offers box, and records a money-less attempt (AE2)', async () => {
    fixture.serve('https://table.example/book/r-7/confirm', placedPage('T-7731', '$0.00'));
    await open(CONSENT.offers);
    expect(await purchase('Reserve now')).toMatchObject({ status: 'booked', order_number: 'T-7731' });
    expect(await approvals()).toEqual([]);
    expect(sent).toEqual([]);
    const booking = fixture.requests.find((request) => request.method === 'POST');
    expect(new URLSearchParams(booking?.body)).toEqual(new URLSearchParams({ party: '2' }));
    expect(await getDb().all('SELECT site,resolution,merchant_record_id FROM gws_ea_browser_free_attempts')).toEqual([
      { site: 'table.example', resolution: 'committed', merchant_record_id: 'T-7731' },
    ]);
    expect(await attempts()).toEqual([]);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_blocks')).toEqual([]);
  });

  it('stops the job, records an incident and tells main once when a free booking’s confirmation shows a charge', async () => {
    fixture.serve(GENERIC.booked, placedPage('T-2210', '$25.00'));
    try {
      await open(GENERIC.freeTable);
      expect(await purchase('Reserve now')).toMatchObject({
        status: 'stopped',
        reason: 'unapproved_commit',
        incident: { site: 'table.example', reference: 'T-2210', charged: '$25.00' },
        repeat_safe: false,
      });
      expect(await getDb().all('SELECT kind,site,job_id FROM gws_ea_browser_incidents')).toEqual([
        { kind: 'unapproved_commit', site: 'table.example', job_id: session.thread_id },
      ]);
      expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', session.thread_id)).toEqual({
        cancelled: 1,
      });
      expect((await texts(main)).filter((text) => text.includes('Nobody approved this purchase'))).toEqual([
        expect.stringContaining('$25.00, reference T-2210'),
      ]);
    } finally {
      fixture.serve(GENERIC.booked, genericCheckoutPages()[GENERIC.booked]);
    }
  });

  it('keeps a booking free past "No credit card required" and a Gift cards link outside its form, but not beside Google Pay or a saved card', async () => {
    await open(GENERIC.freeTable);
    expect(await read('#reserve')).toMatchObject({ status: 'free' });
    await open(GENERIC.walletTable);
    expect(await read('#reserve')).toMatchObject({ status: 'card_needed' });
    await open(GENERIC.cardTable);
    expect((await read('#reserve')).status).not.toBe('free');
    expect(posts()).toEqual([]);
  });

  it('answers card_needed with the site, account, items and total when no payment method is saved', async () => {
    await open(GENERIC.guest);
    expect(await purchase('Place order')).toMatchObject({
      status: 'card_needed',
      site: 'pottery.example',
      account: 'guest checkout',
      items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
      total: '$42.00',
      repeat_safe: true,
    });
    expect(await approvals()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it('puts readable recurring terms on the card, and stops naming an unreadable frequency', async () => {
    await open(GENERIC.club);
    const club = await read('#commit');
    expect(club).toMatchObject({
      status: 'ready',
      facts: { totalMinor: 1200, commitments: [{ kind: 'subscription', amountMinor: 1200, frequency: 'monthly' }] },
    });
    await page
      .locator('#checkout p:not(.item)')
      .filter({ hasText: 'Membership' })
      .evaluate((node) => {
        (node as unknown as { textContent: string }).textContent =
          'Membership: $12.00, renews automatically until you cancel.';
      });
    expect(await purchase('Subscribe')).toMatchObject({
      status: 'facts_incomplete',
      missing: ['the recurring frequency'],
      repeat_safe: true,
    });
    expect(await approvals()).toEqual([]);
    // The page as the site serves it again: its readable terms reach the principal's card.
    await open(GENERIC.club);
    expect(await purchase('Subscribe')).toMatchObject({ status: 'awaiting_principal' });
    const [approval] = await approvals();
    for (const line of [
      'Financial commitment: subscription; "Membership: $12.00/month, renews automatically until you cancel."',
      'Recurring frequency: "monthly"',
    ])
      expect(approval.question).toContain(line);
  });

  it('presses Continue then Place order under one card, as one attempt', async () => {
    expect(classifyNavigationUrl(GENERIC.placeOrder)).toBe('purchase_control');
    await open(GENERIC.steps);
    expect(await purchase('Continue')).toMatchObject({ status: 'awaiting_principal' });
    await approve((await approvals())[0]);
    // The approved press loads its own checkout's purchase route, which the open rule refuses otherwise.
    expect(posts()).toEqual([GENERIC.stepsNext, GENERIC.placeOrder]);
    expect(sent).toHaveLength(1);
    expect(await attempts()).toMatchObject([{ resolution: 'committed', merchant_record_id: 'HP-1043' }]);
  });

  it('presses at most three steps under one approval, and leaves a checkout that keeps asking unconfirmed', async () => {
    // Each step names a new commit and posts to the next, with the same items, total and card: nothing to ask again.
    // From the fifth on, the same step comes back, so a press past the cap shows as a post rather than a hang.
    let step = 1;
    fixture.serve(GENERIC.stepsNext, () => {
      step += 1;
      return {
        body: checkoutPage({
          title: 'Review your order',
          action: `/checkout/steps/next?step=${step + 1}`,
          commit: `Continue to step ${Math.min(step, 5)}`,
          items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
          total: '$42.00',
          payment: 'Visa ending in 4242',
          email: ALIAS,
        }),
      };
    });
    try {
      await open(GENERIC.steps);
      expect(await purchase('Continue')).toMatchObject({ status: 'awaiting_principal' });
      await approve((await approvals())[0]);
      expect(posts()).toEqual([GENERIC.stepsNext, `${GENERIC.stepsNext}?step=3`, `${GENERIC.stepsNext}?step=4`]);
      expect(sent).toHaveLength(1);
      const [authority] = await authorities();
      expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'unconfirmed' });
      expect(await attempts()).toMatchObject([{ resolution: null }]);
      expect(await blocks()).toEqual([{ site: 'pottery.example' }]);
    } finally {
      fixture.serve(GENERIC.stepsNext, genericCheckoutPages()[GENERIC.stepsNext]);
    }
  });

  it('sends a new card when the total rises between steps, and stops the job at the fourth change', async () => {
    // Each step posts to the next one's own address and names its own commit, and each shows a higher total.
    let total = 42;
    fixture.serve(GENERIC.stepsNext, () => {
      total += 1;
      return {
        body: checkoutPage({
          title: 'Review your order',
          action: `/checkout/steps/next?step=${total - 41}`,
          commit: `Continue to step ${total - 41}`,
          items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
          total: `$${total}.00`,
          payment: 'Visa ending in 4242',
          email: ALIAS,
        }),
      };
    });
    try {
      await open(GENERIC.steps);
      expect(await purchase('Continue')).toMatchObject({ status: 'awaiting_principal' });
      for (let change = 1; change <= 3; change++) {
        await approve((await approvals())[0]);
        const [card] = await approvals();
        expect(card.question).toContain(`The total rose to $${42 + change}.00`);
      }
      await approve((await approvals())[0]);
      expect(await approvals()).toEqual([]);
      expect(sent).toHaveLength(4);
      const notices = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox.getInboundHistory(100).map((message) => message.content),
      );
      expect(notices?.some((content) => content.includes('checkout_changing'))).toBe(true);
      expect(await attempts()).toMatchObject(Array(4).fill({ resolution: 'not_committed' }));
      expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', session.thread_id)).toEqual({
        cancelled: 1,
      });
    } finally {
      fixture.serve(GENERIC.stepsNext, genericCheckoutPages()[GENERIC.stepsNext]);
    }
  });

  it('presses Place order once when the same step comes back, and leaves the attempt unconfirmed', async () => {
    fixture.serve(GENERIC.placed, () => ({
      body: checkoutPage({
        action: '/checkout/placed',
        commit: 'Place order',
        items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
        total: '$42.00',
        payment: 'Visa ending in 4242',
        email: ALIAS,
      }),
    }));
    await open(GENERIC.review);
    await purchase('Place order');
    await approve((await approvals())[0]);
    expect(posts()).toEqual([GENERIC.placed]);
    const [authority] = await authorities();
    expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'unconfirmed' });
    expect(await attempts()).toMatchObject([{ resolution: null }]);
    expect(await blocks()).toEqual([{ site: 'pottery.example' }]);
    // Main hears once, and reads the attempt id from the job's state, in the principal's time.
    const view = await readBrowserJob(session.thread_id!);
    expect(view?.unconfirmed).toEqual([
      {
        attempt_id: expect.stringMatching(/^attempt-/u),
        what: 'purchase on pottery.example',
        total: '$42.00',
        pressed: expect.stringMatching(/ Los Angeles time$/u),
      },
    ]);
    const told = await unconfirmedNotes();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(`(attempt ${view!.unconfirmed![0].attempt_id})`);
    await notifyPendingUnconfirmed();
    expect(await unconfirmedNotes()).toHaveLength(1);
  });

  it('resolves a press the merchant declines as not placed, from its step, with nothing left to wait on', async () => {
    fixture.serve(
      GENERIC.placed,
      checkoutPage({
        action: '/checkout/placed',
        commit: 'Place order',
        items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
        total: '$42.00',
        payment: 'Visa ending in 4242',
        email: ALIAS,
        lines: ['Your card was declined. Try another card.'],
      }),
    );
    try {
      await open(GENERIC.review);
      await purchase('Place order');
      await approve((await approvals())[0]);
      expect(posts()).toEqual([GENERIC.placed]);
      const [authority] = await authorities();
      expect(authority.state).toBe('revoked');
      expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'not_placed', reason: 'declined' });
      expect(
        await getDb().all('SELECT resolution,resolution_source,evidence_json FROM gws_ea_browser_purchase_attempts'),
      ).toEqual([
        {
          resolution: 'not_committed',
          resolution_source: 'step',
          evidence_json: expect.stringContaining('Your card was declined'),
        },
      ]);
      expect(await blocks()).toEqual([]);
      expect(await unconfirmedNotes()).toEqual([]);
      // The next purchase there needs no answer from the principal.
      await open(GENERIC.review);
      expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
    } finally {
      fixture.serve(GENERIC.placed, placedPage('HP-1042', '$42.00'));
    }
  });

  it('leaves a free booking with no confirmation unconfirmed, and makes the next booking there wait until main records it', async () => {
    fixture.serve(GENERIC.booked, '<!doctype html><title>Processing</title><p>Processing your request</p>');
    await open(GENERIC.freeTable);
    const pressed = await purchase('Reserve now');
    expect(pressed).toMatchObject({ status: 'unconfirmed', attempt_id: expect.stringMatching(/^free-attempt-/u) });
    const attemptId = String(pressed.attempt_id);
    expect(await getDb().all('SELECT resolution FROM gws_ea_browser_free_attempts')).toEqual([{ resolution: null }]);
    expect(await blocks()).toEqual([{ site: 'table.example' }]);
    const told = await unconfirmedNotes();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(`free booking on table.example`);
    expect(told[0]).toContain(attemptId);
    // Browsing the site goes on; another booking there waits.
    await open(GENERIC.freeTable);
    expect(await purchase('Reserve now')).toMatchObject({ status: 'waiting_on_earlier', site: 'table.example' });
    expect(posts()).toEqual([GENERIC.booked]);
    fixture.serve(GENERIC.booked, genericCheckoutPages()[GENERIC.booked]);
    expect(
      await recordPurchaseOutcome(
        { thread: session.thread_id!, attempt_id: attemptId, outcome: 'not_placed', source: 'principal' },
        main,
        () => queue,
      ),
    ).toMatchObject({ status: 'recorded', outcome: 'not_placed', source: 'principal' });
    expect(await blocks()).toEqual([]);
    expect((await texts(session)).filter((text) => text.includes('"site":"table.example"'))).toHaveLength(1);
    await open(GENERIC.freeTable);
    expect(await purchase('Reserve now')).toMatchObject({ status: 'booked', order_number: 'T-2210' });
    expect(posts()).toEqual([GENERIC.booked, GENERIC.booked]);
  });

  it('keeps the merchant’s lease and block through a payment platform’s own page, binding the platform origin', async () => {
    await open(GENERIC.toPlatform);
    expect(page.url()).toBe(GENERIC.platform);
    expect(await purchase('Pay $42.00')).toMatchObject({ status: 'awaiting_principal' });
    const [approval] = await approvals();
    expect(approval.question).toContain('Site: pottery.example');
    expect(approval.question).toContain('Checkout on: pay.example');
    expect(
      await getDb().all('SELECT site,state FROM gws_ea_browser_site_leases WHERE job_id = ?', session.thread_id),
    ).toEqual([{ site: 'pottery.example', state: 'purchase' }]);
    await approve(approval);
    const [authority] = await authorities();
    expect(JSON.parse(authority.facts_json)).toMatchObject({ site: 'pottery.example', origin: 'https://pay.example' });
    expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'placed', order_number: 'PX-77' });
    expect(await attempts()).toMatchObject([{ site: 'pottery.example', platform: 'pay.example' }]);
  });

  it('blocks the merchant, not the payment platform, when a platform press has no page proof', async () => {
    fixture.serve(GENERIC.platformPaid, '<!doctype html><title>Processing</title><p>Processing your payment</p>');
    await open(GENERIC.toPlatform);
    await purchase('Pay $42.00');
    await approve((await approvals())[0]);
    expect(posts()).toEqual([GENERIC.platformPaid]);
    expect(await attempts()).toMatchObject([{ site: 'pottery.example', platform: 'pay.example', resolution: null }]);
    expect(await getDb().all('SELECT site FROM gws_ea_browser_purchase_blocks')).toEqual([{ site: 'pottery.example' }]);
  });

  it('ignores a hold countdown that changes between the card and the press', async () => {
    await open(GENERIC.held);
    await purchase('Place order');
    await page
      .locator('#checkout p')
      .filter({ hasText: 'holding' })
      .evaluate((node) => {
        (node as unknown as { textContent: string }).textContent = 'We are holding your items for 7:42';
      });
    await approve((await approvals())[0]);
    expect(sent).toHaveLength(1);
    expect(posts()).toEqual([GENERIC.placed]);
  });

  it('reads a per-person no-show fee as a commitment, and books under the standing guarantee with no card when every booking fact is read', async () => {
    await open(GENERIC.feeTable);
    const fee = await read('#reserve');
    expect(fee).toMatchObject({
      status: 'ready',
      facts: {
        totalMinor: 0,
        dueNowMinor: 0,
        commitments: [{ kind: 'conditional_fee', conditionalTrigger: 'no_show', amountMinor: 2500, perPerson: true }],
      },
    });
    await standingGuarantee();
    expect(await purchase('Reserve now')).toMatchObject({ status: 'booked', order_number: 'TR-5531' });
    expect(await approvals()).toEqual([]);
    expect(await authorities()).toMatchObject([{ state: 'committed' }]);
  });

  it('sends a card for a fee booking whose party size it cannot read, whatever the guarantee covers', async () => {
    fixture.serve(GENERIC.feeTable, feeTablePage(false));
    await open(GENERIC.feeTable);
    await standingGuarantee();
    expect(await purchase('Reserve now')).toMatchObject({ status: 'awaiting_principal' });
    const [approval] = await approvals();
    expect(approval.question).toContain('No-show fee: $25 per person');
    expect(posts()).toEqual([]);
  });

  it('records an embedded booking frame’s domain as the attempt’s platform for a deposit', async () => {
    await open(GENERIC.depositHost);
    await page.frameLocator('#booking').locator('#book-now').waitFor();
    expect(await read('#book-now', '#booking')).toMatchObject({
      status: 'ready',
      facts: { site: 'osteria.example', origin: 'https://tables.example', dueNowMinor: 5000 },
    });
    expect(await purchase('Book now')).toMatchObject({ status: 'awaiting_principal' });
    await approve((await approvals())[0]);
    expect(await attempts()).toMatchObject([
      { site: 'osteria.example', platform: 'tables.example', resolution: 'committed', merchant_record_id: 'OJ-818' },
    ]);
  });
});
