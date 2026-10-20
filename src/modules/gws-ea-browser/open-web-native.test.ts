import { BrowserLocatorError, resolveLocator } from './locators.js';
import { classifyNavigationUrl } from './control-policy.js';
import { readCheckoutRegion, readPageControlFacts } from './control-facts.js';
import { createBrowserQueue } from './index.js';
/** The open rule against native Chrome: unreviewed sites, cross-site frames, dialogs and hostile page script. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import Database from 'better-sqlite3';
import type { ElementHandle, Locator, Page } from 'playwright-core';
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
import { resolveSession, resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { configureBrowserCancellation } from './cancel.js';
import {
  activateControl,
  classifyActivation,
  ensureBrowserNavigationGuard,
  withBrowserJobNavigation,
  type ActivationIntent,
} from './commit-classifier.js';
import { recordConsentGrant, runConsentPass, type ConsentPassResult } from './consent.js';
import { BrowserStore } from './db.js';
import { BrowserDiagnosticAttempt } from './diagnostics.js';
import * as actionTargets from './action-targets.js';
import * as nativeControlFacts from './control-facts.js';
import { executeBrowserBatch } from './executor.js';
import { type BrowserAction } from './actions.js';
import { setBrowserAdmissionReady } from './group.js';
import { prepareMerchantPage, readMerchantPurchase } from './merchant-read.js';
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
  htmlPage,
  openWebFixture,
  orderConfirmationPage,
  placedPage,
  refIn,
  type OpenWebFixture,
  type OpenWebRequest,
} from './open-web-native-fixture.js';
import { browserVault } from './onepassword.js';
import { observePage, type BrowserObservation } from './observe.js';
import { registerBrowserPurchaseDelivery, resumeBrowserPurchaseCommits } from './purchase.js';
import { recordPurchaseOutcome } from './purchase-outcome.js';
import { type BrowserQueue } from './queue.js';
import type { BrowserExecutionContext, BrowserWatchExecutionContext } from './actions.js';
import { executeRecipe, saveBrowserRecipe } from './recipes.js';

import { registerReservationGuaranteeDelivery } from './reservation-guarantee.js';
import { deliverAction } from './testing/delivery-answer.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;

/** The one fixture every suite here drives: each test starts from its shared pages, with no request seen. */
let fixture: OpenWebFixture;
beforeAll(async () => {
  if (chromePath) fixture = await openWebFixture(chromePath);
}, 30_000);
afterAll(async () => {
  await fixture?.close();
});
beforeEach(() => {
  fixture?.reset();
});

/** A PNG's width and height, as its header states them. */
function pngSize(data: Buffer): { width: number; height: number } {
  expect(data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Runs `read` on the element `target` names, then lets its handle go. */
async function withElement<T>(target: Locator, read: (element: ElementHandle) => Promise<T>): Promise<T> {
  const element = await target.elementHandle();
  if (!element) throw new Error('Fixture control missing');
  try {
    return await read(element);
  } finally {
    await element.dispose();
  }
}

/** An in-memory browser database holding the jobs `jobs`, with the tables an executor batch reads and writes. */
async function jobDb(...jobs: string[]): Promise<SqliteDriver> {
  const db = new SqliteDriver(new Database(':memory:'));
  await db.exec('CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY)');
  for (const job of jobs) await db.run('INSERT INTO gws_ea_browser_jobs VALUES(?)', job);
  for (const migration of [browserSiteLeasesMigration, browserConsentMigration, browserRecipesMigration])
    await migration.up(db);
  await db.exec('CREATE TABLE gws_ea_browser_requests(answer_json TEXT,job_id TEXT,started_at TEXT,action TEXT)');
  return db;
}

/** Job `job`'s request context over `page`, as the queue builds one. */
function jobContext(db: SqliteDriver, page: Page, job: string): BrowserExecutionContext {
  return {
    job: { id: job, thread_id: job },
    request: { id: `request-${randomUUID()}` },
    session: {},
    store: new BrowserStore(db),
    page: async () => page,
    assertActive: async () => undefined,
    wakeWaiters: async () => undefined,
    remaining: () => 30_000,
    signal: new AbortController().signal,
  } as unknown as BrowserExecutionContext;
}

const PRINCIPAL = 'gchat:users/principal';
const ALIAS = 'aya.web@example.test';

/** The host as one errand of main's meets it: the central database, a queue over one fixture page, what it sent. */
interface ErrandHost {
  readonly page: Page;
  readonly queue: BrowserQueue;
  readonly main: Session;
  readonly errand: Session;
  /** Each delivery's content, in order. */
  readonly sent: string[];
  /** The files each delivery carried, beside its content in `sent`. */
  readonly attached: Array<readonly OutboundFile[] | undefined>;
  /** How often the queue closed the errand's page. */
  closed: number;
}

/**
 * Starts the host for main's errand on `thread`: browser access for main, a browser group, the assistant's alias,
 * the principal reachable in their DM, and every delivery captured. The page is prepared as the host prepares a job's.
 */
async function startErrandHost(thread: string): Promise<ErrandHost> {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(`${root}/browser`, { recursive: true });
  fs.writeFileSync(`${root}/browser/policy.json`, JSON.stringify({ schemaVersion: 1, enabled: true }), {
    mode: 0o600,
  });
  process.env.GWS_EA_BROWSER_POLICY_FILE = `${root}/browser/policy.json`;
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  for (const id of ['main-p', 'browser-p'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
  await createMessagingGroup({
    id: 'mg-principal',
    channel_type: 'gchat',
    platform_id: 'spaces/principal',
    name: 'principal',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
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
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: now });
  await upsertUserDm({
    user_id: PRINCIPAL,
    channel_type: 'gchat',
    messaging_group_id: 'mg-principal',
    resolved_at: now,
  });
  await bindVerifiedPrincipalUser(PRINCIPAL, now);
  const main = (await resolveSession('main-p', 'mg-principal', null, 'agent-shared')).session;
  const errand = (await resolveSystemSession('browser-p', thread)).session;
  const page = await fixture.newPage();
  await prepareMerchantPage(page);
  const host: ErrandHost = {
    page,
    main,
    errand,
    sent: [],
    attached: [],
    closed: 0,
    queue: createBrowserQueue(new BrowserStore(), {
      pageForJob: async () => page,
      connection: async (): Promise<never> => {
        throw new Error('Not used');
      },
      closeJob: async () => {
        host.closed++;
      },
      onDisconnected: () => () => undefined,
    }),
  };
  setDeliveryAdapter({
    async deliver(_type, _platformId, _thread, _kind, content, files) {
      host.sent.push(content);
      host.attached.push(files);
      return `message-${host.sent.length}`;
    },
  });
  configureBrowserCancellation(host.queue);
  registerBrowserPurchaseDelivery(() => host.queue);
  if (!getDeliveryAction('reservation_bounds')) registerReservationGuaranteeDelivery();
  await host.queue.start();
  await resumeBrowserPurchaseCommits(host.queue);
  setBrowserAdmissionReady(true);
  return host;
}

/** Stops what `startErrandHost` started, and removes its data. */
async function stopErrandHost(host: ErrandHost | undefined): Promise<void> {
  setBrowserAdmissionReady(false);
  await host?.queue.stop();
  await host?.page.context().close();
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}

/** The data of the queue's answer to the errand's request `id`, without the queue's timing. */
async function answerOf(host: ErrandHost, id: string): Promise<Record<string, unknown>> {
  const row = await getDb().get<{ answer_json: string }>(
    'SELECT answer_json FROM gws_ea_browser_requests WHERE session_id = ? AND request_id = ?',
    host.errand.id,
    id,
  );
  if (!row) throw new Error(`No answer for ${id}`);
  const { timing: _timing, ...data } = (JSON.parse(row.answer_json) as { data: Record<string, unknown> }).data;
  return data;
}

/** One request through the queue, as the errand's browser agent sends it; its answer's data. */
async function errandRequest(
  host: ErrandHost,
  id: string,
  action: string,
  content: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await host.queue.accept(action, content, host.errand, id);
  await host.queue.idle();
  return answerOf(host, id);
}

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
    const actions = steps.map(
      ([kind, name]): BrowserAction =>
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

  it('unticks a pre-ticked offers box on a free booking with a real click on its label (AE2)', async () => {
    await visit(CONSENT.offers);
    expect(await checked('#offers')).toBe(true);
    expect(await pass(page.locator('#reserve'))).toEqual({ status: 'ready', agreements: [], addOns: [] });
    expect(await checked('#offers')).toBe(false);
    // The box changed under a trusted click on its styled label, never a dispatched one.
    expect(await page.locator('body').getAttribute('data-trusted')).toBe('true');
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
      // The host unticked the box before the site ticked it again.
      hostChanged: true,
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

describe.skipIf(!chromePath)('ordinary actions in native Chrome', { timeout: 60_000 }, () => {
  let db: SqliteDriver;
  let pages: Page[];

  beforeEach(async () => {
    pages = [];
    db = await jobDb('job-a', 'job-b');
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
  const context = (page: Page, job = 'job-a'): BrowserExecutionContext => jobContext(db, page, job);
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

  it('leaves a secret-query page even when its recording checkpoint is unavailable', async () => {
    const page = await open();
    await page.goto(`${OPEN_WEB.article}?token=fixture-private-bearer`);
    expect((await observePage(page)).url).toBe('[redacted URL]');
    const result = await executeBrowserBatch(context(page), { actions: [{ kind: 'navigate', url: OPEN_WEB.faq }] });
    expect(result).toMatchObject({
      reason: 'navigated',
      actions: [{ status: 'completed' }],
      recording: { status: 'unavailable' },
    });
    expect(page.url()).toBe(OPEN_WEB.faq);
    expect(JSON.stringify(result)).not.toContain('fixture-private-bearer');
    const traces = await db.all('SELECT step_json FROM gws_ea_browser_action_trace');
    expect(JSON.stringify(traces)).not.toContain('fixture-private-bearer');
    expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
    expect(await page.locator('#times').isVisible()).toBe(true);
  });

  it.each([403, 200])(
    'reports a fixture HTTP %i denial ahead of the navigation boundary, then permits another action',
    async (status) => {
      const denied = 'https://news.example/denied';
      fixture.serve(denied, () => ({
        status,
        body: htmlPage('Denied', '<h1>Access Denied</h1><p>Request refused.</p>'),
      }));
      const page = await open();
      const diagnostic = new BrowserDiagnosticAttempt({ jobId: 'job-a', requestId: 'denial', action: 'browser' });
      diagnostic.observe(page);
      expect(await go(page, denied)).toMatchObject({
        reason: 'challenge',
        actions: [{ status: 'completed' }],
        observation: { url: denied, snapshot: expect.stringContaining('Access Denied') },
      });
      expect(diagnostic.finish().events).toContainEqual(
        expect.objectContaining({ source: 'http_response', status, resource: 'document', action_index: 0 }),
      );
      expect(page.url()).toBe(denied);
      expect(await go(page, OPEN_WEB.faq)).toMatchObject({ reason: 'navigated', actions: [{ status: 'completed' }] });
      expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
      expect(await page.locator('#times').isVisible()).toBe(true);
    },
  );

  it('reports a host-blocked destination without borrowing the previous page response', async () => {
    const page = await open();
    await go(page, OPEN_WEB.faq);
    const diagnostic = new BrowserDiagnosticAttempt({ jobId: 'job-a', requestId: 'blocked', action: 'browser' });
    diagnostic.observe(page);
    const result = await go(page, 'file:///private-fixture');
    expect(result).toMatchObject({ reason: 'blocked_address', observation: { url: OPEN_WEB.faq } });
    const events = diagnostic.finish().events;
    expect(events).toContainEqual(
      expect.objectContaining({
        source: 'host_refusal',
        category: 'address',
        rule: 'blocked_address',
        action_index: 0,
      }),
    );
    expect(events.some((event) => event.source === 'http_response')).toBe(false);
    expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
  });

  it('reports a failed transport without inventing an HTTP response and permits a later navigation', async () => {
    const page = await open();
    await page.route('https://news.example/transport-failure', (route) => route.abort('namenotresolved'));
    const diagnostic = new BrowserDiagnosticAttempt({ jobId: 'job-a', requestId: 'transport', action: 'browser' });
    diagnostic.observe(page);
    expect(await go(page, 'https://news.example/transport-failure')).toMatchObject({ reason: 'navigation_failed' });
    const events = diagnostic.finish().events;
    expect(events).toContainEqual(
      expect.objectContaining({ source: 'transport_failure', category: 'dns', action_index: 0 }),
    );
    expect(events.some((event) => event.source === 'http_response')).toBe(false);
    expect(await go(page, OPEN_WEB.faq)).toMatchObject({ reason: 'navigated' });
    expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
  });

  it.each(['reservation', 'preparation', 'completion'] as const)(
    'runs an action once when recording %s fails',
    async (phase) => {
      const url = 'https://news.example/recording-failure';
      fixture.serve(
        url,
        htmlPage(
          'Details',
          '<h1>Details</h1><button type="button" onclick="window.presses=(window.presses||0)+1">Show details</button>',
        ),
      );
      const page = await open();
      await go(page, url);
      const target = refIn(await observePage(page), 'Show details');
      const get = db.get.bind(db);
      const reservation = vi.spyOn(db, 'get').mockImplementation(async (sql, ...parameters) => {
        if (phase === 'reservation' && sql.startsWith('INSERT INTO gws_ea_browser_action_trace'))
          throw new Error('private-storage-sentinel');
        return get(sql, ...parameters);
      });
      const run = db.run.bind(db);
      const storage = vi.spyOn(db, 'run').mockImplementation(async (sql, ...parameters) => {
        if (phase === 'completion' && sql.startsWith('UPDATE gws_ea_browser_action_trace'))
          throw new Error('private-storage-sentinel');
        return run(sql, ...parameters);
      });
      const preparation =
        phase === 'preparation'
          ? vi.spyOn(actionTargets, 'prepareBrowserActionFacts').mockImplementation(() => {
              throw new TypeError('private-preparation-sentinel');
            })
          : undefined;
      try {
        const result = await executeBrowserBatch(context(page), { actions: [{ kind: 'click', ...target }] });
        expect(result).toMatchObject({
          status: 'completed',
          actions: [{ status: 'completed' }],
          recording: { status: 'unavailable' },
        });
        expect(await page.evaluate('window.presses')).toBe(1);
        expect(JSON.stringify(result)).not.toContain('sentinel');
        const rows = await db.all<{ step_json: string }>('SELECT step_json FROM gws_ea_browser_action_trace');
        expect(rows).toHaveLength(phase === 'reservation' ? 0 : 1);
        for (const row of rows) expect(JSON.parse(row.step_json)).toMatchObject({ saveError: 'Recording incomplete.' });
        expect((result.actions as Array<{ trace_index?: number }>)[0].trace_index).toBe(
          phase === 'reservation' ? undefined : 0,
        );
      } finally {
        storage.mockRestore();
        reservation.mockRestore();
        preparation?.mockRestore();
      }
      expect(await click(page, 'Show details')).toMatchObject({ status: 'completed' });
      expect(await page.evaluate('window.presses')).toBe(2);
    },
  );

  it('records existing native control facts without another control inspection or snapshot generation', async () => {
    const page = await open();
    await go(page, OPEN_WEB.faq);
    const before = await observePage(page);
    const read = vi.spyOn(nativeControlFacts, 'readPageControlFacts');
    try {
      const result = await executeBrowserBatch(context(page), {
        actions: [{ kind: 'click', ...refIn(before, 'Show delivery times') }],
      });
      expect(result).toMatchObject({
        status: 'completed',
        recording: { status: 'complete' },
        observation: { generation: before.generation + 1 },
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(await page.locator('#times').isVisible()).toBe(true);
    } finally {
      read.mockRestore();
    }
  });

  it.each(['reservation', 'completion'] as const)(
    'answers a completed action before a stalled recording %s finishes',
    async (phase) => {
      const page = await open();
      await go(page, OPEN_WEB.faq);
      const target = refIn(await observePage(page), 'Show delivery times');
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending: Promise<unknown>[] = [];
      const get = db.get.bind(db);
      const reservation = vi.spyOn(db, 'get').mockImplementation((sql, ...parameters) => {
        if (phase === 'reservation' && sql.startsWith('INSERT INTO gws_ea_browser_action_trace')) {
          const work = held.then(() => get(sql, ...parameters));
          pending.push(work);
          return work;
        }
        return get(sql, ...parameters);
      });
      const run = db.run.bind(db);
      const storage = vi.spyOn(db, 'run').mockImplementation((sql, ...parameters) => {
        if (phase === 'completion' && sql.startsWith('UPDATE gws_ea_browser_action_trace')) {
          const work = held.then(() => run(sql, ...parameters));
          pending.push(work);
          return work;
        }
        return run(sql, ...parameters);
      });
      try {
        const result = await executeBrowserBatch(context(page), { actions: [{ kind: 'click', ...target }] });
        expect(result).toMatchObject({
          status: 'completed',
          recording: { status: 'unavailable' },
          actions: [{ status: 'completed' }],
        });
        expect(await page.locator('#times').isVisible()).toBe(true);
        expect((result.actions as Array<{ trace_index?: number }>)[0].trace_index).toBe(
          phase === 'reservation' ? undefined : 0,
        );
      } finally {
        release?.();
        await Promise.all(pending);
        storage.mockRestore();
        reservation.mockRestore();
      }
      const rows = await db.all<{ step_json: string }>('SELECT step_json FROM gws_ea_browser_action_trace');
      expect(rows).toHaveLength(1);
      if (phase === 'reservation')
        expect(JSON.parse(rows[0].step_json)).toMatchObject({ saveError: 'Recording incomplete.' });
    },
  );

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

  it('ends a batch on a same-URL reload and invalidates targets from the replaced document', async () => {
    const url = 'https://news.example/reload';
    fixture.serve(
      url,
      htmlPage(
        'Reload',
        '<h1>Reload</h1><button type="button" onclick="location.reload()">Reload page</button><input aria-label="Search term">',
      ),
    );
    const page = await open();
    await go(page, url);
    const observation = await observePage(page);
    const old = refIn(observation, 'Search term');
    const result = await batch(page, [
      { kind: 'click', ...refIn(observation, 'Reload page') },
      { kind: 'type', ...old, text: 'must not run' },
    ]);
    expect(result).toMatchObject({
      reason: 'navigated',
      actions: [{ status: 'completed' }, { status: 'not_executed' }],
    });
    expect(page.url()).toBe(url);
    expect(await page.getByRole('textbox', { name: 'Search term' }).inputValue()).toBe('');
    expect(await batch(page, [{ kind: 'type', ...old, text: 'stale' }])).toMatchObject({ reason: 'stale_ref' });
    const fresh = refIn(await observePage(page), 'Search term');
    expect(await batch(page, [{ kind: 'type', ...fresh, text: 'current' }])).toMatchObject({ status: 'completed' });
    expect(await page.getByRole('textbox', { name: 'Search term' }).inputValue()).toBe('current');
  });

  it('does not turn an internal TypeError into an actionability refusal', async () => {
    const page = await open();
    await go(page, OPEN_WEB.faq);
    const wheel = vi.spyOn(page.mouse, 'wheel').mockRejectedValue(new TypeError('private-runtime-sentinel'));
    try {
      await expect(batch(page, [{ kind: 'scroll', direction: 'down' }])).rejects.toThrow(
        'The browser action failed unexpectedly.',
      );
    } finally {
      wheel.mockRestore();
    }
    expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
  });

  it('reports a pinned target detached by an earlier action without pressing a replacement', async () => {
    const url = 'https://news.example/detached';
    fixture.serve(
      url,
      htmlPage(
        'Controls',
        '<h1>Controls</h1><button type="button" onclick="document.getElementById(\'old\').remove()">Remove old control</button><button type="button" id="old" onclick="window.oldPresses=(window.oldPresses||0)+1">Old control</button>',
      ),
    );
    const page = await open();
    await go(page, url);
    const before = await observePage(page);
    expect(
      await batch(page, [
        { kind: 'click', ...refIn(before, 'Remove old control') },
        { kind: 'click', ...refIn(before, 'Old control') },
      ]),
    ).toMatchObject({
      reason: 'not_actionable',
      actions: [{ status: 'completed' }, { status: 'stopped', reason: 'not_actionable' }],
    });
    expect(await page.evaluate('window.oldPresses || 0')).toBe(0);
    expect(await page.getByRole('button', { name: 'Old control', exact: true }).count()).toBe(0);
    expect(await batch(page, [{ kind: 'observe' }])).toMatchObject({ status: 'completed' });
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
        activateControl(page, element, () => element.click({ noWaitAfter: true }), undefined, {
          kind: 'click',
          scope: { jobId: context(page).job.id, db },
          assertActive: context(page).assertActive,
          remaining: context(page).remaining,
        }),
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

  it('refuses the payment post and the checkout submit that page script sends as a field is typed into', async () => {
    const page = await open();
    await go(page, OPEN_WEB.typedPosts);
    const guard = await ensureBrowserNavigationGuard(page);
    /** Types as `actions` says, aimed from a fresh observation, once every earlier window has closed. */
    const typed = async (actions: (observation: BrowserObservation) => BrowserAction[]): Promise<void> => {
      await guard.actionsSettled();
      await page.evaluate(`document.getElementById('status').textContent = 'Ready'`);
      expect(await batch(page, actions(await observePage(page)))).toMatchObject({ status: 'completed' });
      await expect.poll(() => page.locator('#status').textContent()).toBe('refused');
    };
    await typed((seen) => [{ kind: 'type', ...refIn(seen, 'Gift message'), text: 'Happy birthday' }]);
    await typed((seen) => [
      { kind: 'form_input', fields: [{ ...refIn(seen, 'Delivery notes'), value: 'Leave it with the porter' }] },
    ]);
    // A key that edits the field is typing too.
    await typed((seen) => [
      { kind: 'key', ...refIn(seen, 'Gift message'), key: 'End' },
      { kind: 'key', ...refIn(seen, 'Gift message'), key: 'Backspace' },
    ]);
    // The typing itself went through.
    expect(await page.locator('input[name="gift"]').inputValue()).toBe('Happy birthda');
    expect(await page.locator('input[name="notes"]').inputValue()).toBe('Leave it with the porter');
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

  it.each([
    { source: 'autocomplete', label: 'Display value', attributes: 'autocomplete="new-password"' },
    { source: 'label', label: 'Password', attributes: '' },
  ])(
    'refuses ordinary typing and editing of a secret field even when page script hides its attributes ($source)',
    async ({ label, attributes }) => {
      const page = await open();
      const url = 'https://shop.example/secret-entry';
      fixture.serve(
        url,
        htmlPage(
          'Profile',
          `<form method="post" action="${url}/submitted"><label>${label} <input id="entry" name="value" type="text" ${attributes}></label><button>Continue</button></form>`,
          `
      const read = HTMLInputElement.prototype.getAttribute;
      HTMLInputElement.prototype.getAttribute = function(name) {
        return this.id === 'entry' && ['type', 'autocomplete'].includes(name) ? null : read.call(this, name);
      };
    `,
        ),
      );
      fixture.serve(`${url}/submitted`, htmlPage('Submitted', 'Done'));
      await page.goto(url);
      const secret = 'Synthetic-"credential\\U3-42';
      await page.locator('#entry').fill(secret);
      const checkout = await withElement(page.locator('button'), (element) => readCheckoutRegion(page, element));
      expect.soft(checkout.region.fields).toMatchObject([{ secret: true, value: null }]);
      const observation = await observePage(page);
      for (const text of [observation.snapshot, JSON.stringify(observation)])
        for (const encoded of [secret, JSON.stringify(secret).slice(1, -1)]) expect(text).not.toContain(encoded);
      await page.locator('#entry').fill('');
      for (const kind of ['type', 'key', 'form_input'] as const) {
        const field = refIn(await observePage(page), label);
        const action: BrowserAction =
          kind === 'type'
            ? { kind, ...field, text: 'ordinary-text' }
            : kind === 'key'
              ? { kind, ...field, key: 'Backspace' }
              : { kind, fields: [{ ...field, value: 'ordinary-text' }] };
        const result = await batch(page, [action]);
        expect(result).toMatchObject({ status: 'stopped', reason: 'secret_field' });
        expect(await page.locator('#entry').inputValue()).toBe('');
      }
      await page.locator('#entry').fill(secret);
      const submitted = await batch(page, [{ kind: 'click', ...refIn(await observePage(page), 'Continue') }]);
      expect.soft(submitted).toMatchObject({ status: 'stopped', reason: 'secret_field' });
      expect(fixture.requests.some((request) => request.url === `${url}/submitted`)).toBe(false);
    },
  );

  it('stops a watch batch at a download without running later actions', async () => {
    const page = await open();
    const url = 'https://shop.example/watch-download';
    fixture.serve(
      url,
      htmlPage(
        'Receipt',
        '<a href="/receipt.txt" download>Download receipt</a><button onclick="this.textContent=\'Ran later action\'">Continue</button>',
      ),
    );
    await page.goto(url);
    const observation = await observePage(page);
    const watch: BrowserWatchExecutionContext = {
      ...context(page),
      kind: 'watch_check',
      check: { id: 'check-download' },
    };
    const result = await executeBrowserBatch(
      watch,
      {
        actions: [
          { kind: 'download', ...refIn(observation, 'Download receipt') },
          { kind: 'click', ...refIn(observation, 'Continue') },
        ],
      },
      { record: false },
    );
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'read_only',
      actions: [
        { index: 0, status: 'stopped', reason: 'read_only' },
        { index: 1, status: 'not_executed' },
      ],
    });
    expect(await page.locator('button').textContent()).toBe('Continue');
    expect(fixture.requests.some((request) => request.url === 'https://shop.example/receipt.txt')).toBe(false);
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
  let host: ErrandHost;
  let page: Page;
  let session: Session;
  const posts = (): string[] =>
    fixture.requests.filter((request) => request.method !== 'GET').map((request) => request.url);

  beforeEach(async () => {
    host = await startErrandHost('system:a2a:main-p:reorder');
    ({ page, errand: session } = host);
  });
  afterEach(() => stopErrandHost(host));

  /** One browser request through the queue, as the browser agent sends it; its answer's data. */
  const run = (id: string, actions: BrowserAction[]) => errandRequest(host, id, 'browser', { actions });
  /** Opens `url`, then presses the control named `name` from the observation the navigation answered with. */
  async function press(url: string, name: string): Promise<Record<string, unknown>> {
    const opened = await run(`open-${name}`, [{ kind: 'navigate', url }]);
    const observation = opened.observation as { snapshot: string; generation: number };
    return run(`press-${name}`, [{ kind: 'click', ...refIn(observation, name) }]);
  }
  const incidents = () =>
    getDb().all<{ kind: string; site: string; job_id: string }>(
      'SELECT kind, site, job_id FROM gws_ea_browser_incidents',
    );

  it.each(['catalog', 'vault'] as const)(
    'keeps completed navigation and the next action usable when %s metadata does not answer',
    async (source) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const all = getDb().all.bind(getDb());
      const catalog = vi.spyOn(getDb(), 'all').mockImplementation(async (sql, ...parameters) => {
        if (source === 'catalog' && sql.includes('SELECT r.* FROM gws_ea_browser_recipes')) await held;
        return all(sql, ...parameters);
      });
      const vault = vi.spyOn(browserVault, 'itemsForOrigin').mockImplementation(async () => {
        if (source === 'vault') await held;
        // A useful first inventory may take longer than the recorder's allowance.
        else await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return [{ item_handle: 'vault_after-retry', title: 'Fixture login' }];
      });
      // Release even on the old implementation, whose queue must settle its timed-out operation before answering.
      const timer = setTimeout(release, 5_000);
      try {
        const result = await errandRequest(host, 'held-catalog', 'browser', {
          actions: [{ kind: 'navigate', url: OPEN_WEB.faq }],
          budget_ms: 3_000,
        });
        expect(result).toMatchObject({ reason: 'navigated', actions: [{ status: 'completed' }] });
        expect((result.observation as BrowserObservation).site).toMatchObject(
          source === 'catalog'
            ? { recipes_status: 'unavailable', vault_items: [{ item_handle: 'vault_after-retry' }] }
            : { recipes: [], vault_status: 'vault_unavailable' },
        );
        release();
        catalog.mockRestore();
        const retried = await observePage(page);
        expect(retried.site).toMatchObject({ recipes: [], vault_items: [{ item_handle: 'vault_after-retry' }] });
        expect(
          await run('after-held-catalog', [
            { kind: 'click', ...refIn(await observePage(page), 'Show delivery times') },
          ]),
        ).toMatchObject({ status: 'completed' });
      } finally {
        release();
        clearTimeout(timer);
        catalog.mockRestore();
        vault.mockRestore();
      }
    },
  );

  it('stops the job with an incident when an ordinary Submit lands on a paid order confirmation', async () => {
    const answer = await press(OPEN_WEB.reorder, 'Submit');
    expect(answer).toMatchObject({
      status: 'stopped',
      reason: 'unapproved_commit',
      incident: { site: 'shop.example', reference: 'SO-48213', charged: '$42.00' },
      actions: [{ status: 'stopped', reason: 'unapproved_commit' }],
      repeat_safe: false,
    });
    expect(posts()).toEqual(['https://shop.example/reorder/submit']);
    expect(await incidents()).toEqual([{ kind: 'unapproved_commit', site: 'shop.example', job_id: session.thread_id }]);
    expect(host.closed).toBeGreaterThan(0);
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

  it('runs Add to calendar on an order page showing its confirmation, charge and card, and raises nothing', async () => {
    expect(await press(OPEN_WEB.thanks, 'Add to calendar')).toMatchObject({
      status: 'completed',
      actions: [{ status: 'completed' }],
    });
    expect(await page.locator('#added').isVisible()).toBe(true);
    expect(await incidents()).toEqual([]);
  });

  it('raises nothing when Track order opens another page showing the same order and charge', async () => {
    expect(await press(OPEN_WEB.thanks, 'Track order')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(page.url()).toBe(OPEN_WEB.tracking);
    expect(await incidents()).toEqual([]);
  });

  it('stops the job when a press on that order page confirms a new charge in a frame beside the old confirmation', async () => {
    await run('open-thanks', [{ kind: 'navigate', url: OPEN_WEB.thanks }]);
    await page.frameLocator('#perks').locator('#accept').waitFor();
    expect(await run('accept', [{ kind: 'click', ...refIn(await observePage(page), 'Yes, add it') }])).toMatchObject({
      status: 'stopped',
      reason: 'unapproved_commit',
      incident: { site: 'shop.example', reference: 'PK-7731', charged: '$19.00' },
    });
    expect(await incidents()).toMatchObject([{ kind: 'unapproved_commit', site: 'shop.example' }]);
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
  ): Promise<{ result: Record<string, unknown>; seen: BrowserObservation }> {
    const result = await executeBrowserBatch(jobContext(db, page, JOB), { actions }, { record: false });
    return { result, seen: result.observation as BrowserObservation };
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

describe.skipIf(!chromePath)('personal data in native Chrome (KTD19, R34)', { timeout: 60_000 }, () => {
  const MOBILE = '+1 415 555 0134';
  const HOME = '123 Main Street, Springfield';
  let host: ErrandHost;
  let page: Page;
  let mobile: string;
  const posts = (): OpenWebRequest[] => fixture.requests.filter((request) => request.method !== 'GET');

  beforeEach(async () => {
    host = await startErrandHost('system:a2a:main-p:dinner');
    ({ page } = host);
    mobile = (await addPrivateValue({ label: 'Mobile', kind: 'phone', value: MOBILE })).id;
    await addPrivateValue({ label: 'Home', kind: 'address', value: HOME });
  });
  afterEach(() => stopErrandHost(host));

  /** One request through the queue, as the errand's browser agent sends it; its answer's data, without the queue's timing. */
  const request = (id: string, action: string, content: Record<string, unknown>) =>
    errandRequest(host, id, action, content);
  const run = (id: string, actions: BrowserAction[]) => request(id, 'browser', { actions });
  /** Opens `url` and answers with the observation the navigation returned. */
  async function open(url: string): Promise<BrowserObservation> {
    const opened = await run(`open-${randomUUID()}`, [{ kind: 'navigate', url }]);
    expect(opened).toMatchObject({ status: 'stopped', reason: 'navigated' });
    return opened.observation as BrowserObservation;
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
      ).toMatchObject({ status: 'submitted' });
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
  let host: ErrandHost;
  let page: Page;
  let queue: BrowserQueue;
  let session: Session;
  let main: Session;
  let sent: string[];
  /** The files each delivery carried, beside its content in `sent`. */
  let attached: ErrandHost['attached'];
  const posts = (): string[] =>
    fixture.requests.filter((request) => request.method !== 'GET').map((request) => request.url);
  /** Each card posted: how many pictures it names, and the files that went with it. */
  const cards = (): Array<{ pictures: unknown; files: readonly OutboundFile[] | undefined }> =>
    sent.flatMap((content, index) => {
      const card = JSON.parse(content) as { type?: string; pictures?: unknown };
      return card.type === 'ask_question' ? [{ pictures: card.pictures, files: attached[index] }] : [];
    });

  beforeEach(async () => {
    host = await startErrandHost('system:a2a:main-p:checkout');
    ({ page, queue, main, errand: session, sent, attached } = host);
  });
  afterEach(() => stopErrandHost(host));

  const answer = (id: string): Promise<Record<string, unknown>> => answerOf(host, id);
  /** One browser request through the queue, as the browser agent sends it; its answer's data. */
  const run = (id: string, actions: BrowserAction[]) => errandRequest(host, id, 'browser', { actions });
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

  it('reads an unreviewed shop’s checkout into one card, and after approval re-reads, presses and reports placed without recipe storage (AE3)', async () => {
    await open(GENERIC.review);
    await getDb().exec('DROP TABLE gws_ea_browser_action_trace; DROP TABLE gws_ea_browser_recipes;');
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

  it('raises nothing when a press shows the approved order again for its total, and stops the job when it shows more', async () => {
    fixture.serve(
      'https://pottery.example/orders',
      htmlPage(
        'Your orders',
        '<h1>Your orders</h1><button type="button" id="view">View order</button> <button type="button" id="updated">View updated order</button>',
        `document.getElementById('view').addEventListener('click', () => location.assign('/orders/HP-1042'));
document.getElementById('updated').addEventListener('click', () => location.assign('/orders/HP-1042/updated'));`,
      ),
    );
    fixture.serve('https://pottery.example/orders/HP-1042', placedPage('HP-1042', '$42.00'));
    // A gift box added to the same order: its number again, for more than the principal approved.
    fixture.serve('https://pottery.example/orders/HP-1042/updated', placedPage('HP-1042', '$61.00'));
    await open(GENERIC.review);
    await purchase('Place order');
    await approve((await approvals())[0]);
    expect(page.url()).toBe(GENERIC.placed);
    const view = async (name: string): Promise<Record<string, unknown>> => {
      await open('https://pottery.example/orders');
      return run(`view-${name}`, [{ kind: 'click', ...refIn(await observePage(page), name) }]);
    };
    expect(await view('View order')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(await getDb().all('SELECT kind FROM gws_ea_browser_incidents')).toEqual([]);
    expect(await view('View updated order')).toMatchObject({
      status: 'stopped',
      reason: 'unapproved_commit',
      incident: { site: 'pottery.example', reference: 'HP-1042', charged: '$61.00' },
    });
    expect(await getDb().all('SELECT kind FROM gws_ea_browser_incidents')).toEqual([{ kind: 'unapproved_commit' }]);
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

  it('stops the job with an incident when a free booking’s confirmation shows a charge', async () => {
    fixture.serve(GENERIC.booked, placedPage('T-2210', '$25.00'));
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
  });

  it('keeps a booking free past "No credit card required" and a Gift cards link outside its form, but not beside Google Pay or a saved card', async () => {
    await open(GENERIC.freeTable);
    expect(await read('#reserve')).toMatchObject({ status: 'free' });
    await open(GENERIC.walletTable);
    expect(await read('#reserve')).toMatchObject({ status: 'card_needed' });
    await open(GENERIC.cardTable);
    // The saved card beside the form is the payment: the booking reads as a paid checkout missing its other facts.
    expect(await read('#reserve')).toEqual({ status: 'facts_incomplete', missing: ['the total', 'the contact email'] });
    expect(posts()).toEqual([]);
  });

  it('answers card_needed with the site, account, items and total when no payment method is saved', async () => {
    await open(GENERIC.guest);
    const seen = await observePage(page);
    const handler = getDeliveryAction('purchase');
    if (!handler) throw new Error('purchase delivery missing');
    await handler({ action: 'purchase', requestId: 'card-needed', target: refIn(seen, 'Place order') }, session);
    await queue.idle();
    expect(await answer('card-needed')).toMatchObject({
      status: 'card_needed',
      site: 'pottery.example',
      account: 'guest checkout',
      items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
      total: '$42.00',
      repeat_safe: true,
    });
    expect(await approvals()).toEqual([]);
    expect(posts()).toEqual([]);
    const edit = await run('edit-after-card-needed', [
      { kind: 'type', ...refIn(seen, 'Email'), text: 'other@example.com' },
    ]);
    expect(edit.reason).toBeUndefined();
    expect(edit).toMatchObject({
      status: 'completed',
      actions: [{ status: 'completed' }],
    });
    expect(await page.locator('[name="email"]').inputValue()).toBe('other@example.com');
  });

  it('keeps a generic control locator exact across duplicate labels and refuses unnamed controls', async () => {
    await open(GENERIC.review);
    await observePage(page);
    await page.locator('#commit').evaluate((button) => {
      const duplicate = button.cloneNode(true) as typeof button;
      duplicate.id = 'duplicate-commit';
      button.parentElement!.append(duplicate);
    });
    const element = await page.locator('#commit').elementHandle();
    if (!element) throw new Error('Fixture commit control missing');
    const result = await readMerchantPurchase(page, element);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready' || !result.facts.control.locator) throw new Error('No generic locator');
    const locator = result.facts.control.locator;
    expect(locator).toMatchObject({ name: 'Place order', ordinal: 0, count: 2 });
    const resolved = await resolveLocator(page, locator);
    expect(await resolved.getAttribute('id')).toBe('commit');
    await resolved.dispose();
    await page.locator('#duplicate-commit').evaluate((button) => button.remove());
    await expect(resolveLocator(page, locator)).rejects.toBeInstanceOf(BrowserLocatorError);
    await result.element.dispose();
    await page.locator('#commit').evaluate((button) => {
      button.textContent = '';
    });
    expect(await read('#commit')).toMatchObject({
      status: 'facts_incomplete',
      missing: ['a commit control the host can find again'],
    });
    expect(posts()).toEqual([]);
  });

  it('puts readable recurring terms on the card, and stops naming an unreadable frequency', async () => {
    await open(GENERIC.club);
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
    await open(GENERIC.steps);
    expect(await purchase('Continue')).toMatchObject({ status: 'awaiting_principal' });
    await approve((await approvals())[0]);
    expect(posts()).toEqual([GENERIC.stepsNext, `${GENERIC.stepsNext}?step=3`, `${GENERIC.stepsNext}?step=4`]);
    expect(sent).toHaveLength(1);
    const [authority] = await authorities();
    expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'unconfirmed' });
    expect(await attempts()).toMatchObject([{ resolution: null }]);
    expect(await blocks()).toEqual([{ site: 'pottery.example' }]);
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
    const changing = notices
      ?.map((content) => JSON.parse(content) as { text?: string })
      .filter((content) => content.text?.includes('"browser_purchase_outcome"'))
      .map((content) => JSON.parse(content.text ?? '') as Record<string, unknown>)
      .find((notice) => notice.status === 'checkout_changing');
    // The browser reads what changed in the sentence it reports from.
    expect(changing?.message).toContain(
      'The checkout changed again after three changed cards (The total rose to $46.00, from $45.00.), so the host stopped this errand',
    );
    expect(await attempts()).toMatchObject(Array(4).fill({ resolution: 'not_committed' }));
    expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', session.thread_id)).toEqual({
      cancelled: 1,
    });
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
