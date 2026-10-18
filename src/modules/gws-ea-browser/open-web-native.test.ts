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

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { configureBrowserCancellation } from './cancel.js';
import {
  classifyActivation,
  classifyNavigationUrl,
  ensureBrowserNavigationGuard,
  readControlFacts,
  type ActivationIntent,
} from './commit-classifier.js';
import { recordConsentGrant, runConsentPass, type ConsentPassResult } from './consent.js';
import { BrowserStore } from './db.js';
import { executeBrowserBatch, type BrowserAction } from './executor.js';
import { setBrowserAdmissionReady } from './group.js';
import { browserConsentMigration, browserRecipesMigration, browserSiteLeasesMigration } from './migration.js';
import {
  CONSENT,
  COOKIE_BANNERS,
  OPEN_WEB,
  PROCESSOR,
  openWebFixture,
  type OpenWebFixture,
} from './open-web-native-fixture.js';
import { observePage, type BrowserObservation, type BrowserRef } from './observe.js';
import { BrowserQueue, type BrowserExecutionContext } from './queue.js';
import { executeRecipe, saveBrowserRecipe } from './recipes.js';

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

  it('reads the control under an overlay by its own facts', async () => {
    await visit(OPEN_WEB.overlay);
    const covered = await page.locator('#search').evaluate((button) => {
      const node = button as unknown as {
        getBoundingClientRect(): { x: number; y: number; width: number; height: number };
        ownerDocument: { elementFromPoint(x: number, y: number): { id: string } | null };
      };
      const box = node.getBoundingClientRect();
      return node.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.id;
    });
    // The trick is live: the layer, not the search, sits under the pointer.
    expect(covered).toBe('overlay');
    expect(await classify(page.locator('#search'))).toBe('ordinary');
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

  it('ticks a terms box that carries no required attribute on a signup', async () => {
    await visit(CONSENT.terms);
    await act(['click', 'Create account']);
    expect(submitted('/terms/joined')?.get('terms')).toBe('on');
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
    // Outside an action nothing is paused: the page's own post reaches the processor.
    await page.evaluate(`fetch('${PROCESSOR.confirm}', { method: 'POST', mode: 'no-cors', body: 'outside' })`);
    await expect.poll(posts).toEqual([PROCESSOR.confirm]);
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
