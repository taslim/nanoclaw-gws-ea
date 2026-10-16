/** Real delivery, approval, central DB, mailbox and native DOM. Only the container wake is mocked. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const { root } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: join(tmpdir(), 'nanoclaw-browser-purchase-tests') };
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
import { createPendingApproval } from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { resolveSession, resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { handleApprovalsResponse, resumeApprovedApprovals } from '../approvals/response-handler.js';
import { sweepExpiredApprovals } from '../approvals/index.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore, browserRequestId } from './db.js';
import { BrowserQueue } from './queue.js';
import { readMerchantPurchase, AMAZON_RETAIL } from './merchant-signatures.js';
import { observePage } from './observe.js';
import { PurchaseAuthorityStore, notifyPurchaseOutcome, type SpendingAuthority } from './authority.js';
import { registerBrowserPurchaseDelivery, resumeBrowserPurchaseCommits, validatePurchaseRequest } from './purchase.js';
import { cancelBrowserJob, readBrowserJob } from './cancel.js';
import { registerReservationGuaranteeDelivery, reservationGuaranteeRequest } from './reservation-guarantee.js';
import { setBrowserAdmissionReady } from './group.js';

const PRINCIPAL = 'gchat:users/principal';
const OPERATOR = 'gchat:users/operator';
const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
let browser: Browser;
let fixtureServer: HttpsServer;
let fixtureProxy: HttpServer;
let certificateRoot: string;
const transportSockets = new Set<Socket>();
let page: Page;
let session: Session;
let main: Session;
let queue: BrowserQueue;
let submitted: number;
let cartAdded: number;
let total = '85.00';
let confirmation = true;
let cardDuringDelivery: (() => Promise<void>) | undefined;
let sent: Array<{ platformId: string; content: string }>;
let orderedAt: string;
let holdPost: Promise<void> | undefined;
let sawPost: (() => void) | undefined;

function reviewHtml(): string {
  return `<html><body><a id="nav-link-accountList"><span class="nav-line-1">Hello, Morgan</span></a>
<form id="spc-form" method="post" action="${AMAZON_RETAIL.origin}${AMAZON_RETAIL.submitPath}"><input type="hidden" name="purchaseId" value="checkout-1">
<div id="payment-information">Visa ending in 4242</div><div id="displayAddressDiv">Morgan, 10 Main St, Seattle WA 98101</div>
<table id="subtotals-marketplace-table"><tr><td>Order total:</td><td>$${total}</td></tr></table>
<div class="shipment"><div class="delivery-promise">Arriving Tuesday, October 20, 2026</div><div class="item-row" data-asin="B012345678"><a class="a-link-normal" href="/dp/B012345678">Tea kettle</a><span class="quantity">Qty: 1</span></div></div>
<div id="purchase-legal-text">By placing your order, you agree to Amazon's privacy notice and conditions of use.</div>
<div id="placeYourOrder"><input type="submit" name="placeYourOrder1" value="Place your order"></div><button type="button">Continue</button></form></body></html>`;
}
function productHtml(): string {
  return `<html><body><form id="addToCart" method="post" action="https://www.amazon.com/gp/product/handle-buy-box/ref=dp_start-bbf_1_glance"><input type="hidden" name="ASIN" value="B012345678"><select name="quantity"><option value="1" selected>1</option></select><input id="add-to-cart-button" type="submit" name="submit.add-to-cart" value="Add to Cart"><input id="buy-now-button" type="submit" name="submit.buy-now" value="Buy Now"><button type="button">Continue</button></form></body></html>`;
}
function cartHtml(): string {
  return `<html><body><form id="activeCartViewForm" method="post" action="https://www.amazon.com/gp/cart/desktop/go-to-checkout.html"><input type="submit" name="proceedToRetailCheckout" value="Proceed to checkout"></form></body></html>`;
}
function detailHtml(status = 'Order placed'): string {
  return `<html><body><a id="nav-link-accountList"><span class="nav-line-1">Hello, Morgan</span></a><div id="orderDetails"><span class="order-number">Order # 123-1234567-1234567</span><time class="order-date" datetime="${orderedAt}">October 15, 2026</time><span class="grand-total">Grand total: $${total}</span><div class="payment-method">Visa ending in 4242</div><div class="shipping-address">Morgan, 10 Main St, Seattle WA 98101</div><span class="order-status">${status}</span><input type="hidden" name="purchaseId" value="checkout-1"><div class="shipment"><div class="item-row" data-asin="B012345678"><a class="a-link-normal" href="/dp/B012345678">Tea kettle</a><span class="quantity">Qty: 1</span></div></div></div></body></html>`;
}
async function approvals(): Promise<PendingApproval[]> {
  return getDb().all('SELECT * FROM pending_approvals ORDER BY created_at');
}
async function click(approval: PendingApproval, value = 'approve', userId = PRINCIPAL): Promise<void> {
  await handleApprovalsResponse({
    questionId: approval.approval_id,
    value,
    userId,
    channelType: 'gchat',
    platformId: 'spaces/principal',
    threadId: null,
  });
}
async function request(id: string): Promise<Record<string, unknown> | undefined> {
  const row = await queue.store.request(browserRequestId(session.id, id));
  if (!row?.answer_json) return undefined;
  return (JSON.parse(row.answer_json) as { data: Record<string, unknown> }).data;
}
async function buy(id = 'buy'): Promise<void> {
  const observation = await observePage(page);
  const match =
    /- button "Place your order" \[ref=((?:f\d+)?e\d+)\]/u.exec(observation.snapshot) ??
    /\[ref=((?:f\d+)?e\d+)\].*Place your order/u.exec(observation.snapshot);
  if (!match) throw new Error(`Missing native purchase ref: ${observation.snapshot}`);
  const handler = getDeliveryAction('purchase');
  if (!handler) throw new Error('purchase delivery missing');
  await handler(
    { action: 'purchase', requestId: id, target: { ref: match[1], generation: observation.generation } },
    session,
  );
  await queue.idle();
}
async function navigate(url: string, id: string): Promise<void> {
  await queue.accept('browser', { actions: [{ kind: 'navigate', url }] }, session, id);
  await queue.idle();
}
async function reconcile(attemptId: string, id: string): Promise<Record<string, unknown> | undefined> {
  const observation = await observePage(page);
  const ref = /\[ref=((?:f\d+)?e\d+)\]/u.exec(observation.snapshot)?.[1];
  if (!ref) throw new Error('Reconciliation fixture has no native ref');
  await queue.accept(
    'purchase',
    { operation: 'reconcile', attempt_id: attemptId, target: { ref, generation: observation.generation } },
    session,
    id,
  );
  await queue.idle();
  return request(id);
}
async function grant(): Promise<SpendingAuthority> {
  const rows = await getDb().all<SpendingAuthority>('SELECT * FROM gws_ea_browser_authorities');
  if (!rows[0]) throw new Error('Authority missing');
  return rows[0];
}

it('accepts delivery bounds with UTC offsets, keeping window dates as written and the deadline in UTC', () => {
  const target = { ref: 'e1', generation: 1 };
  expect(
    validatePurchaseRequest({
      target,
      delivery_window: { start: '2026-10-12T00:00:00-07:00', end: '2026-10-14T23:59:59-07:00' },
      needed_by: '2026-10-14T17:00:00-07:00',
    }),
  ).toMatchObject({
    delivery_window: { start: '2026-10-12', end: '2026-10-14' },
    needed_by: '2026-10-15T00:00:00.000Z',
  });
  expect(validatePurchaseRequest({ target, needed_by: '2026-10-14' })).toMatchObject({ needed_by: '2026-10-14' });
  expect(validatePurchaseRequest({ target, needed_by: '2026-10-14T17:00:00Z' })).toMatchObject({
    needed_by: '2026-10-14T17:00:00.000Z',
  });
  for (const needed_by of ['2026-10-14T17:00:00', '2026-10-14T17:00-07:00', 'next friday'])
    expect(() => validatePurchaseRequest({ target, needed_by })).toThrow('UTC offset');
  expect(() =>
    validatePurchaseRequest({
      target,
      delivery_window: { start: '2026-10-14T00:00:00Z', end: '2026-10-12T00:00:00Z' },
    }),
  ).toThrow('ordered');
});

describe.skipIf(!chromePath)('reviewed merchant purchases through native host delivery', () => {
  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the native merchant fixture.');
    certificateRoot = fs.mkdtempSync(`${root}-tls-`);
    execFileSync(
      '/usr/bin/openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${certificateRoot}/key.pem`,
        '-out',
        `${certificateRoot}/cert.pem`,
        '-days',
        '1',
        '-subj',
        '/CN=www.amazon.com',
      ],
      { stdio: 'ignore' },
    );
    fixtureServer = createHttpsServer(
      { key: fs.readFileSync(`${certificateRoot}/key.pem`), cert: fs.readFileSync(`${certificateRoot}/cert.pem`) },
      (request, response) => {
        const url = new URL(request.url ?? '/', AMAZON_RETAIL.origin);
        request.resume();
        if (request.method === 'POST' && url.pathname.startsWith('/gp/product/handle-buy-box')) {
          cartAdded++;
          response.writeHead(302, { location: `${AMAZON_RETAIL.origin}/gp/cart/view.html` });
          response.end();
        } else if (request.method === 'POST' && url.pathname === '/gp/cart/desktop/go-to-checkout.html') {
          response.writeHead(302, { location: `${AMAZON_RETAIL.origin}${AMAZON_RETAIL.reviewPath}` });
          response.end();
        } else if (request.method === 'POST') {
          submitted++;
          sawPost?.();
          const finish = () => {
            response.writeHead(302, {
              location: `${AMAZON_RETAIL.origin}${confirmation ? '/gp/your-account/order-details?orderID=123-1234567-1234567' : AMAZON_RETAIL.confirmationPath}`,
            });
            response.end();
          };
          if (holdPost) void holdPost.then(finish);
          else finish();
        } else {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            url.pathname === '/dp/B012345678'
              ? productHtml()
              : url.pathname === '/gp/cart/view.html'
                ? cartHtml()
                : url.pathname === AMAZON_RETAIL.reviewPath
                  ? reviewHtml()
                  : url.pathname === '/gp/your-account/order-details'
                    ? detailHtml()
                    : '<html><body>Processing your order</body></html>',
          );
        }
      },
    );
    await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    const address = fixtureServer.address();
    if (!address || typeof address === 'string') throw new Error('Fixture TLS port missing');
    fixtureProxy = createHttpServer((_request, response) => {
      response.writeHead(403);
      response.end();
    });
    // CONNECT upgrades leave closeAllConnections; retain both ends for teardown.
    fixtureProxy.on('connection', (socket) => {
      transportSockets.add(socket);
      socket.once('close', () => transportSockets.delete(socket));
    });
    fixtureProxy.on('connect', (request, socket, head) => {
      if (request.url !== 'www.amazon.com:443') {
        socket.destroy();
        return;
      }
      const upstream = connect(address.port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      transportSockets.add(upstream);
      upstream.once('close', () => transportSockets.delete(upstream));
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => fixtureProxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = fixtureProxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Fixture proxy port missing');
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      proxy: { server: `http://127.0.0.1:${proxyAddress.port}` },
      args: ['--ignore-certificate-errors'],
    });
  });
  afterAll(async () => {
    await browser?.close();
    for (const socket of transportSockets) socket.destroy();
    fixtureServer?.closeAllConnections();
    fixtureProxy?.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => fixtureServer?.close(() => resolve())),
      new Promise<void>((resolve) => fixtureProxy?.close(() => resolve())),
    ]);
    if (certificateRoot) fs.rmSync(certificateRoot, { recursive: true, force: true });
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
    for (const who of ['principal', 'operator'])
      await createMessagingGroup({
        id: `mg-${who}`,
        channel_type: 'gchat',
        platform_id: `spaces/${who}`,
        name: who,
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
    for (const [id, who] of [
      [PRINCIPAL, 'principal'],
      [OPERATOR, 'operator'],
    ]) {
      await upsertUser({ id, kind: 'gchat', display_name: who, created_at: new Date().toISOString() });
      await upsertUserDm({
        user_id: id,
        channel_type: 'gchat',
        messaging_group_id: `mg-${who}`,
        resolved_at: new Date().toISOString(),
      });
    }
    await bindVerifiedPrincipalUser(PRINCIPAL, new Date().toISOString());
    main = (await resolveSession('main-p', 'mg-principal', null, 'agent-shared')).session;
    session = (await resolveSystemSession('browser-p', 'system:a2a:main-p:purchase')).session;
    submitted = 0;
    cartAdded = 0;
    total = '85.00';
    confirmation = true;
    cardDuringDelivery = undefined;
    holdPost = undefined;
    sawPost = undefined;
    sent = [];
    orderedAt = new Date().toISOString();
    setDeliveryAdapter({
      async deliver(_type, platformId, _thread, _kind, content) {
        sent.push({ platformId, content });
        if (cardDuringDelivery) await cardDuringDelivery();
        return `message-${sent.length}`;
      },
    });
    page = await browser.newPage();
    await page.goto(`${AMAZON_RETAIL.origin}${AMAZON_RETAIL.reviewPath}`);
    queue = new BrowserQueue(new BrowserStore(), {
      pageForJob: async () => page,
      connection: async (): Promise<never> => {
        throw new Error('Not used');
      },
      closeJob: async () => undefined,
      onDisconnected: () => () => undefined,
    });
    registerBrowserPurchaseDelivery(() => queue);
    if (!getDeliveryAction('reservation_guarantee')) registerReservationGuaranteeDelivery();
    await queue.start();
    await resumeBrowserPurchaseCommits(queue);
    setBrowserAdmissionReady(true);
  });
  afterEach(async () => {
    setBrowserAdmissionReady(false);
    await queue?.stop();
    await page?.context().close();
    delete process.env.GWS_EA_BROWSER_POLICY_FILE;
    await closeDb();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prepares a standard retail cart through reviewed native controls without a financial commit or approval', async () => {
    const activate = async (label: string, id: string) => {
      const observation = await observePage(page);
      const line = observation.snapshot.split('\n').find((line) => line.includes(`button "${label}"`));
      const ref = line ? /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1] : undefined;
      if (!ref) throw new Error(`Native fixture control missing: ${label}`);
      await queue.accept(
        'browser',
        { actions: [{ kind: 'click', ref, generation: observation.generation }] },
        session,
        id,
      );
      await queue.idle();
      await page.waitForLoadState('domcontentloaded');
      return request(id);
    };
    await navigate(`${AMAZON_RETAIL.origin}/dp/B012345678`, 'product');
    expect(await activate('Buy Now', 'no-oneclick')).toMatchObject({ status: 'stopped', reason: 'purchase_control' });
    expect(await activate('Continue', 'unknown-prep')).toMatchObject({
      status: 'stopped',
      reason: 'unsupported_merchant',
    });
    await page.locator('input[name="ASIN"]').evaluate((node) => {
      (node as unknown as { value: string }).value = 'B099999999';
    });
    expect(await activate('Add to Cart', 'mismatched-product')).toMatchObject({
      status: 'stopped',
      reason: 'unsupported_merchant',
    });
    expect(cartAdded).toBe(0);
    expect(submitted).toBe(0);
    await page.locator('input[name="ASIN"]').evaluate((node) => {
      (node as unknown as { value: string }).value = 'B012345678';
    });
    await activate('Add to Cart', 'add-cart');
    expect(page.url()).toContain('/gp/cart/view.html');
    expect(cartAdded).toBe(1);
    expect(submitted).toBe(0);
    expect(await approvals()).toHaveLength(0);
    await activate('Proceed to checkout', 'review-cart');
    expect(page.url()).toContain(AMAZON_RETAIL.reviewPath);
    expect((await readMerchantPurchase(page)).status).toBe('ready');
    expect(submitted).toBe(0);
    expect(await approvals()).toHaveLength(0);
  });
  it('reads a complete standard retail checkout and refuses drift/unreadable financial terms', async () => {
    const read = await readMerchantPurchase(page);
    expect(read.status).toBe('ready');
    if (read.status === 'ready') {
      expect(read.facts).toMatchObject({
        currency: 'USD',
        totalMinor: 8500,
        dueNowMinor: 8500,
        cardEnding: '4242',
        items: [{ id: 'B012345678', quantity: 1 }],
      });
      await read.element.dispose();
    }
    await page.locator('#purchase-legal-text').evaluate((node) => {
      (node as unknown as { textContent: string }).textContent = 'Start free trial';
    });
    expect(await readMerchantPurchase(page)).toEqual({ status: 'terms_unavailable' });
    expect(submitted).toBe(0);
  });
  it('posts exactly one card to the principal, keeps the site and commits once on its worker after approval', async () => {
    await buy();
    expect(await request('buy')).toMatchObject({ status: 'awaiting_principal' });
    expect(submitted).toBe(0);
    await buy('buy');
    expect(await approvals()).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].platformId).toBe('spaces/principal');
    const [approval] = await approvals();
    expect(approval.question).toMatch(/Place your order/);
    expect(approval.question).toMatch(/Due now: \$85.00/);
    expect(approval.question).toMatch(/Due later: none/);
    expect(await readBrowserJob(session.thread_id!)).toMatchObject({
      state: 'awaiting_principal',
      held_sites: ['amazon.com'],
    });
    await click(approval, 'approve', OPERATOR);
    expect(submitted).toBe(0);
    expect(await approvals()).toHaveLength(1);
    await click(approval);
    await queue.idle();
    expect(submitted).toBe(1);
    expect(page.url()).toContain('/gp/your-account/order-details');
    expect(await page.content()).toContain('orderDetails');
    expect((await grant()).state).toBe('committed');
    expect(JSON.parse((await grant()).outcome_json!)).toMatchObject({
      status: 'placed',
      order_number: '123-1234567-1234567',
    });
    await click(approval);
    await queue.idle();
    expect(submitted).toBe(1);
  });
  it('keeps another job off a checkout while its principal card holds the site', async () => {
    await buy();
    const original = session;
    session = (await resolveSystemSession('browser-p', 'system:a2a:main-p:second-purchase')).session;
    await buy('busy');
    expect(await request('busy')).toMatchObject({ status: 'site_purchase_blocked', reason: 'site_busy' });
    expect(submitted).toBe(0);
    expect(await approvals()).toHaveLength(1);
    session = original;
  });
  it('replays an approval after a completed commit without recreating pending work or spending again', async () => {
    await buy();
    const [row] = await approvals();
    await click(row);
    await queue.idle();
    expect(submitted).toBe(1);
    expect((await grant()).state).toBe('committed');
    await createPendingApproval({ ...row, status: 'approved' });
    await resumeApprovedApprovals();
    await queue.idle();
    expect(submitted).toBe(1);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_pending_commits')).toHaveLength(0);
  });
  it('accepts a lower total but asks again for a higher total and ignores the withdrawn card', async () => {
    await buy();
    const [approval] = await approvals();
    total = '84.50';
    await page
      .locator('#subtotals-marketplace-table tr td')
      .nth(1)
      .evaluate((node) => {
        (node as unknown as { textContent: string }).textContent = '$84.50';
      });
    await click(approval);
    await queue.idle();
    expect(submitted).toBe(1);
    expect((await grant()).state).toBe('committed');
  });
  it('replaces a card on material change and leaves an old approval inert', async () => {
    await buy();
    const [old] = await approvals();
    total = '86.00';
    await page
      .locator('#subtotals-marketplace-table tr td')
      .nth(1)
      .evaluate((node) => {
        (node as unknown as { textContent: string }).textContent = '$86.00';
      });
    await click(old);
    await queue.idle();
    expect(submitted).toBe(0);
    const [fresh] = await approvals();
    expect(fresh.approval_id).not.toBe(old.approval_id);
    expect(fresh.question).toMatch(/rose to \$86.00, from \$85.00/);
    expect((await grant()).state).toBe('revoked');
    await click(old);
    expect(submitted).toBe(0);
    await click(fresh);
    await queue.idle();
    expect(submitted).toBe(1);
  });
  it('supports a principal click delivered before requestApproval returns its id', async () => {
    cardDuringDelivery = async () => {
      cardDuringDelivery = undefined;
      const [row] = await approvals();
      await click(row);
    };
    await buy();
    await queue.idle();
    expect(submitted).toBe(1);
    expect((await grant()).state).toBe('committed');
  });
  it.each([
    ['lapsed checkout', false, 'checkout_lapsed'],
    ['closed idle page', true, 'unsupported_merchant'],
  ] as const)(
    'resumes approval after restart with a %s and revalidates the rebuilt checkout',
    async (_name, closePage, status) => {
      await buy();
      const [row] = await approvals();
      await queue.accept(
        'browser',
        { actions: [{ kind: 'navigate', url: `${AMAZON_RETAIL.origin}/s?k=kettle` }] },
        session,
        'leave-review',
      );
      await queue.idle();
      await queue.stop();
      await queue.start();
      await resumeBrowserPurchaseCommits(queue);
      if (closePage) {
        await page.close();
        page = await browser.newPage();
      }
      await click(row);
      await queue.idle();
      expect(submitted).toBe(0);
      const authority = await grant();
      expect(authority.state).toBe('live');
      const notices = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox
          .getInboundHistory(100)
          .filter((message) =>
            (JSON.parse(message.content) as { text?: string }).text?.includes('"authority_unspent"'),
          ),
      );
      expect(notices).toHaveLength(1);
      const notice = notices?.[0];
      if (!notice) throw new Error('Expected native purchase continuation');
      expect(notice).toMatchObject({ kind: 'chat' });
      const envelope = JSON.parse(notice.content) as { text: string };
      expect(JSON.parse(envelope.text)).toMatchObject({
        type: 'browser_purchase_outcome',
        status,
        authority_id: authority.id,
        authority_unspent: true,
        safe_to_rebuild: true,
      });
      await queue.retryAnswers();
      expect(
        await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
          mailbox
            .getInboundHistory(100)
            .filter((message) =>
              (JSON.parse(message.content) as { text?: string }).text?.includes('"authority_unspent"'),
            ),
        ),
      ).toHaveLength(1);
      await queue.accept(
        'browser',
        { actions: [{ kind: 'navigate', url: `${AMAZON_RETAIL.origin}${AMAZON_RETAIL.reviewPath}` }] },
        session,
        'rebuild-review',
      );
      await queue.idle();
      await buy('rebuilt');
      expect(submitted).toBe(1);
      expect(sent).toHaveLength(1);
      expect((await grant()).state).toBe('committed');
    },
  );
  it('cancels an open card atomically and expires unanswered cards through the native lifecycle', async () => {
    await buy();
    const [row] = await approvals();
    await cancelBrowserJob(session.thread_id!);
    await click(row);
    await queue.idle();
    expect(submitted).toBe(0);
    expect(await approvals()).toHaveLength(0);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_authorities')).toEqual([]);
  });
  it('releases a superseded card site while keeping the replacement card site held', async () => {
    await buy('old-card');
    const card = await getDb().get<{ id: string; facts_json: string }>(
      "SELECT id,facts_json FROM gws_ea_browser_purchase_cards WHERE status = 'open'",
    );
    if (!card) throw new Error('Missing initial card');
    // Seed the durable state of a card prepared on another supported site.
    await getDb().run(
      'UPDATE gws_ea_browser_purchase_cards SET facts_json = ? WHERE id = ?',
      JSON.stringify({ ...JSON.parse(card.facts_json), site: 'resy.com', origin: 'https://resy.com' }),
      card.id,
    );
    await getDb().run("UPDATE gws_ea_browser_site_leases SET site = 'resy.com' WHERE site = 'amazon.com'");
    const waiting = (await resolveSystemSession('browser-p', 'system:a2a:main-p:waiting-purchase')).session;
    const waitingJob = await queue.store.jobForSession(waiting);
    if (!waitingJob) throw new Error('Missing waiting job');
    expect(await queue.leases.acquire(waitingJob.id, 'https://resy.com/')).toMatchObject({ acquired: false });
    await buy('replacement-card');
    expect(await queue.leases.owned(session.thread_id!, 'resy.com')).toBe(false);
    expect(await queue.leases.owned(session.thread_id!, 'amazon.com')).toBe(true);
    const available = await withExistingMailboxSession(waiting.agent_group_id, waiting.id, (mailbox) =>
      mailbox
        .getInboundHistory(100)
        .filter((message) =>
          (JSON.parse(message.content) as { text?: string }).text?.includes('browser_site_available'),
        ),
    );
    expect(available).toHaveLength(1);
    expect(await queue.leases.acquire(waitingJob.id, 'https://resy.com/')).toMatchObject({ acquired: true });
    await click((await approvals())[0], 'reject');
    expect(await queue.leases.owned(session.thread_id!, 'amazon.com')).toBe(false);
    expect(submitted).toBe(0);
  });
  it('records unknown once, retains its block after cancellation, and never repeats its consumed authority', async () => {
    confirmation = false;
    await buy();
    await click((await approvals())[0]);
    await queue.idle();
    expect(submitted).toBe(1);
    const authority = await grant();
    expect(authority.state).toBe('unknown');
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_blocks')).toMatchObject([{ site: 'amazon.com' }]);
    await cancelBrowserJob(session.thread_id!);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_blocks')).toHaveLength(1);
    await notifyPurchaseOutcome(authority.id);
    await notifyPurchaseOutcome(authority.id);
    const notes = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox
        .getInboundHistory(100)
        .filter(
          (message) =>
            (JSON.parse(message.content) as { text?: string }).text?.includes('"browser_purchase_outcome"') &&
            (JSON.parse(message.content) as { text?: string }).text?.includes(authority.attempt_id),
        ),
    );
    expect(notes).toHaveLength(1);
  });
  it('replays an early approved row as durable work and starts it after queue recovery only', async () => {
    await buy();
    const [row] = await approvals();
    await queue.stop();
    await getDb().run("UPDATE pending_approvals SET status = 'approved' WHERE approval_id = ?", row.approval_id);
    await resumeApprovedApprovals();
    expect(submitted).toBe(0);
    await queue.start();
    await resumeBrowserPurchaseCommits(queue);
    await queue.idle();
    expect(submitted).toBe(1);
  });
  it('requires explicit main proposals and principal approval for any standing guarantee', async () => {
    const handler = getDeliveryAction('reservation_guarantee')!;
    await handler({ action: 'reservation_guarantee', requestId: 'grant-read', operation: 'read' }, main);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_reservation_guarantees')).toEqual([]);
    await handler(
      {
        action: 'reservation_guarantee',
        requestId: 'grant-propose',
        operation: 'propose',
        currency: 'USD',
        max_total: '100.00',
      },
      main,
    );
    const [row] = await approvals();
    expect(row.approver_user_id).toBe(PRINCIPAL);
    await click(row, 'approve', OPERATOR);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_reservation_guarantees')).toEqual([]);
    await click(row);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_reservation_guarantees')).toMatchObject([
      { currency: 'USD', max_total_minor: 10000, revoked_at: null },
    ]);
    await handler({ action: 'reservation_guarantee', requestId: 'grant-revoke', operation: 'revoke' }, main);
    expect(
      (await getDb().get<{ revoked_at: string }>('SELECT revoked_at FROM gws_ea_browser_reservation_guarantees'))
        ?.revoked_at,
    ).toBeTruthy();
  });
  it('expires a waiting card through native approvals and reports the rejection/expiry once', async () => {
    await buy();
    const [row] = await approvals();
    await getDb().run(
      'UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?',
      new Date(Date.now() - 1).toISOString(),
      row.approval_id,
    );
    await sweepExpiredApprovals();
    expect(await approvals()).toHaveLength(0);
    expect(submitted).toBe(0);
    expect(await readBrowserJob(session.thread_id!)).toMatchObject({ state: 'idle' });
    expect(await getDb().get('SELECT status FROM gws_ea_browser_purchase_cards')).toEqual({ status: 'expired' });
  });
  it.each([
    ['JPY', '100', 100],
    ['KWD', '1.234', 1234],
  ] as const)(
    'preserves a principal-confirmed %s guarantee in its currency units',
    async (currency, maximum, minor) => {
      const handler = getDeliveryAction('reservation_guarantee')!;
      await handler(
        {
          action: 'reservation_guarantee',
          requestId: 'currency-proposal',
          operation: 'propose',
          currency,
          max_total: maximum,
        },
        main,
      );
      const [row] = await approvals();
      expect(row).toBeDefined();
      await click(row);
      expect(await getDb().get('SELECT currency,max_total_minor FROM gws_ea_browser_reservation_guarantees')).toEqual({
        currency,
        max_total_minor: minor,
      });
      expect(await reservationGuaranteeRequest({ operation: 'read' }, main, 'currency-read')).toMatchObject({
        status: 'active',
        currency,
        max_total: maximum,
      });
    },
  );
  it('returns in_progress for cancellation during the native press and completes cancellation after its verified outcome', async () => {
    let release!: () => void;
    holdPost = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted = new Promise<void>((resolve) => {
      sawPost = resolve;
    });
    await buy();
    await queue.leases.acquire(session.thread_id!, 'https://resy.com/');
    await queue.leases.holdForPurchase(session.thread_id!, 'resy.com');
    await click((await approvals())[0]);
    await posted;
    expect((await grant()).state).toBe('committing');
    expect(await cancelBrowserJob(session.thread_id!)).toMatchObject({ status: 'in_progress' });
    expect((await queue.store.getJob(session.thread_id!))?.cancelled).toBe(0);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_site_leases')).toHaveLength(2);
    release();
    await queue.idle();
    expect((await grant()).state).toBe('committed');
    expect((await queue.store.getJob(session.thread_id!))?.cancelled).toBe(1);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_site_leases')).toHaveLength(0);
    expect(submitted).toBe(1);
  });
  it('recovers the marker-to-press gap as unknown before admission and frees only its lease, retaining the site purchase block', async () => {
    await buy('marker-card');
    const [approval] = await approvals();
    await queue.stop();
    await click(approval);
    const store = new PurchaseAuthorityStore();
    const authority = await grant();
    const requestRow = (await queue.store.pending(session.thread_id!))[0];
    if (!requestRow) throw new Error('Approved commit was not durably queued');
    const id = requestRow.id;
    await queue.store.start(id);
    const context = (await queue.contextForRequest(id))!;
    await store.begin(
      context,
      authority.id,
      JSON.parse(authority.facts_json) as import('./fingerprint.js').PurchaseFacts,
    );
    expect((await queue.store.request(id))?.commit_started_at).toBeTruthy();
    expect(submitted).toBe(0);
    await queue.stop();
    await queue.start();
    await resumeBrowserPurchaseCommits(queue);
    await queue.idle();
    expect((await store.get(authority.id))?.state).toBe('unknown');
    expect(JSON.parse((await queue.store.request(id))!.answer_json!)).toMatchObject({
      data: { reason: 'outcome_unknown' },
    });
    expect(submitted).toBe(0);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_blocks')).toHaveLength(1);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_site_leases')).toHaveLength(0);
  });
  it('keeps stale history inconclusive and clears a block only for complete matching host merchant evidence', async () => {
    confirmation = false;
    await buy();
    await click((await approvals())[0]);
    await queue.idle();
    const authority = await grant();
    expect(await reconcile(authority.attempt_id, 'inconclusive')).toMatchObject({
      status: 'inconclusive',
      purchase_blocked: true,
    });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_blocks')).toHaveLength(1);
    await navigate(`${AMAZON_RETAIL.origin}/gp/your-account/order-details?orderID=123-1234567-1234567`, 'read-history');
    expect(await reconcile(authority.attempt_id, 'verified')).toMatchObject({
      status: 'confirmed_placed',
      order_number: '123-1234567-1234567',
    });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_blocks')).toHaveLength(0);
    expect((await grant()).state).toBe('unknown');
    expect(submitted).toBe(1);
    await navigate(`${AMAZON_RETAIL.origin}${AMAZON_RETAIL.reviewPath}`, 'another-cart');
    await buy('another-purchase');
    await click((await approvals())[0]);
    await queue.idle();
    const later = await getDb().get<SpendingAuthority>(
      'SELECT * FROM gws_ea_browser_authorities WHERE id <> ?',
      authority.id,
    );
    if (!later) throw new Error('A new authority was not persisted');
    await navigate(`${AMAZON_RETAIL.origin}/gp/your-account/order-details?orderID=123-1234567-1234567`, 'same-record');
    expect(await reconcile(later.attempt_id, 'record-already-used')).toMatchObject({
      status: 'inconclusive',
      purchase_blocked: true,
    });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_blocks')).toHaveLength(1);
  });
  it('warns about a possible duplicate and grants only one new attempt without erasing the unresolved earlier purchase', async () => {
    confirmation = false;
    await buy();
    await click((await approvals())[0]);
    await queue.idle();
    const original = await grant();
    await navigate(`${AMAZON_RETAIL.origin}${AMAZON_RETAIL.reviewPath}`, 'new-cart');
    await buy('possible-duplicate');
    const [approval] = await approvals();
    expect(approval.question).toContain('Possible duplicate');
    expect(approval.question).toContain(original.attempt_id);
    await click(approval);
    await queue.idle();
    expect(submitted).toBe(2);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_attempts WHERE resolution IS NULL')).toHaveLength(
      2,
    );
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_blocks')).toHaveLength(1);
    await click(approval);
    expect(submitted).toBe(2);
  });
});
