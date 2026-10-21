import { createBrowserQueue, recoverAndStartBrowserQueue } from './index.js';
import { holdBrowserRequest, stopHeldBrowserRequests } from './testing/held-request.js';
/** Real delivery, approval, central DB, mailbox and native DOM. Only the container wake is mocked. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { chromium, errors, type Browser, type Frame, type Page } from 'playwright-core';
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
import type { OutboundFile } from '../../channels/adapter.js';
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
import {
  purchaseBounds,
  registerBrowserPurchaseDelivery,
  resumeBrowserPurchaseCommits,
  validatePurchaseRequest,
} from './purchase.js';
import { cancelBrowserJob, readBrowserJob } from './cancel.js';
import { ERRAND_ORIGIN_LINE } from './cards.js';
import { notes } from './principal-fixture.js';
import { recordPurchaseOutcome } from './purchase-outcome.js';
import { ensureBrowserNavigationGuard } from './commit-classifier.js';
import { secureJobPage } from './connection.js';
import { prepareAuthenticationIsolation } from './authentication-submit.js';
import { coverPageTargets } from './page-targets.js';
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
let sent: Array<{ platformId: string; content: string; files?: readonly OutboundFile[] }>;
let orderedAt: string;
let holdPost: Promise<void> | undefined;
let sawPost: (() => void) | undefined;
let widgetRequests: string[];
let signInReferers: Array<[string, string | undefined]>;
let offerRequests: string[];
let merchantDocuments: string[];
/** Choices the review form also holds, for the consent engine's checkout cases. */
let reviewChoices: string;
/** Each order submission's body, as the merchant received it. */
let orderBodies: string[];
const WIDGET_ORIGIN = 'https://pay.example';
const OFFERS_ORIGIN = 'https://offers.example';

function reviewHtml(): string {
  return `<html><body><a id="nav-link-accountList"><span class="nav-line-1">Hello, Morgan</span></a>
<form id="spc-form" method="post" action="${AMAZON_RETAIL.origin}${AMAZON_RETAIL.submitPath}"><input type="hidden" name="purchaseId" value="checkout-1">
<div id="payment-information">Visa ending in 4242</div><div id="displayAddressDiv">Morgan, 10 Main St, Seattle WA 98101</div>
<table id="subtotals-marketplace-table"><tr><td>Order total:</td><td>$${total}</td></tr></table>
<div class="shipment"><div class="delivery-promise">Arriving Tuesday, October 20, 2026</div><div class="item-row" data-asin="B012345678"><a class="a-link-normal" href="/dp/B012345678">Tea kettle</a><span class="quantity">Qty: 1</span></div></div>
<div id="purchase-legal-text">By placing your order, you agree to Amazon's privacy notice and conditions of use.</div>${reviewChoices}
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
// A chooser that reaches the browser returns to its input as a change or cancel event.
const statement = `<input type="file" id="statement" aria-label="Statement" oncancel="this.dataset.chooser = 'returned'" onchange="this.dataset.chooser = 'returned'">`;
/** A cross-site widget whose own script navigates its frame, as embedded payment widgets do. */
function widgetHtml(): string {
  const link = (id: string, label: string, destination: string) =>
    `<a id="${id}" href="${AMAZON_RETAIL.origin}/dp/B012345678" onclick="event.preventDefault(); location.assign('${destination}')">${label}</a>`;
  // An ordinary link navigates the frame itself back to the hosting page's site.
  const back = `<a id="back" href="${AMAZON_RETAIL.origin}/dp/B012345678">Kettle details</a>`;
  return `<html><body><h1>Payment plans</h1>${link('plans', 'Compare plans', '/checkout/placeorder')}${link('help', 'Plan help', '/help')}${back}${statement}</body></html>`;
}
/** The element reference the first `[ref=…]` in `text` names. */
const refIn = (text: string): string | undefined => /\[ref=((?:f\d+)?e\d+)\]/u.exec(text)?.[1];
function fixturePage(pathname: string): string {
  switch (pathname) {
    case '/dp/B012345678':
      return productHtml();
    case '/dp/B0PAYFRAME':
      return widgetHostHtml(`${WIDGET_ORIGIN}/`);
    case '/dp/B0OFFERS01':
      return offersHostHtml();
    case '/dp/B0WORKER01':
      return `<html><body><h1>Tea kettle</h1><script>navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => { document.body.dataset.worker = 'registered'; }, () => { document.body.dataset.worker = 'refused'; });</script></body></html>`;
    case '/dp/B0PAYLATER':
      return widgetHostHtml();
    case '/gp/cart/view.html':
      return cartHtml();
    case AMAZON_RETAIL.reviewPath:
      return reviewHtml();
    case '/gp/your-account/order-details':
      return detailHtml();
    default:
      return '<html><body>Processing your order</body></html>';
  }
}
/** Frame documents that report to the top page, then navigate themselves to a purchase. */
function offerDocument(url: URL): string | undefined {
  const purchase = `top.postMessage('redirecting', '*'); location.replace('/checkout/placeorder');`;
  // A brand-new frame that navigates itself while it loads.
  if (url.searchParams.has('redirect')) return `<html><body><script>${purchase}</script></body></html>`;
  // A widget hosting one same-site child, in its own process, and one cross-site child, in another.
  if (url.searchParams.has('nest'))
    return `<html><body><iframe src="/?child=same"></iframe><iframe src="${OFFERS_ORIGIN}/?child=cross"></iframe></body></html>`;
  // A brand-new widget whose same-site child navigates itself while both are still loading.
  if (url.searchParams.has('nestnow'))
    return `<html><body><iframe src="/?redirect=${url.searchParams.get('nestnow')}"></iframe></body></html>`;
  // A nested child that navigates itself only when the top page asks.
  if (url.searchParams.has('child'))
    return `<html><body><script>top.postMessage('ready', '*'); addEventListener('message', (event) => { if (event.data === 'go') { ${purchase} } });</script></body></html>`;
  return undefined;
}
function offersHostHtml(): string {
  const control = (label: string, script: string) =>
    `<a href="${AMAZON_RETAIL.origin}/dp/B012345678" onclick="event.preventDefault(); ${script}">${label}</a>`;
  const count = `let ready = 0; let redirected = 0; addEventListener('message', (event) => { if (event.data === 'ready') document.getElementById('ready').textContent = 'Ready ' + ++ready; if (event.data === 'redirecting') document.getElementById('redirected').textContent = 'Redirected ' + ++redirected; });`;
  const insert = (query: string) =>
    `const offer = document.createElement('iframe'); offer.src = '${WIDGET_ORIGIN}/?' + ${query}; document.body.append(offer);`;
  return `<html><body><h1>Tea kettle</h1>${control('Load offers', insert("'redirect=' + document.querySelectorAll('iframe').length"))}${control('Load nested offers', insert("'nest=1'"))}${control('Start offers', "const widget = frames[frames.length - 1]; for (let i = 0; i < widget.length; i++) widget[i].postMessage('go', '*');")}${control('Load nested now', insert("'nestnow=' + document.querySelectorAll('iframe').length"))}${control('Load checkout frame', "const frame = document.createElement('iframe'); frame.src = '/checkout/placeorder?frame=' + document.querySelectorAll('iframe').length; document.body.append(frame);")}<a href="${AMAZON_RETAIL.origin}/dp/B0POPUP001" target="_blank">Open deals</a>${control('Open deals window', `window.open('${AMAZON_RETAIL.origin}/dp/B0POPUP001?window')`)}<p id="ready"></p><p id="redirected"></p><script>${count}</script></body></html>`;
}
function widgetHostHtml(widgetSrc?: string): string {
  // The later host loads its widget only once a postcode is typed, from inside a job batch.
  const load = `const widget = document.getElementById('widget'); widget.onload = () => { document.getElementById('status').textContent = 'Plans loaded'; }; widget.src = '${WIDGET_ORIGIN}/';`;
  // Host controls that remove the widget or load it again, each without leaving the page.
  const control = (label: string, script: string) =>
    `<a href="${AMAZON_RETAIL.origin}/dp/B012345678" onclick="event.preventDefault(); ${script}">${label}</a>`;
  return widgetSrc
    ? `<html><body><h1>Tea kettle</h1>${statement}${control('Hide plans', "document.getElementById('widget').remove();")}${control('Show plans', load)}<p id="status"></p><iframe id="widget" title="Payment plans" src="${widgetSrc}"></iframe></body></html>`
    : `<html><body><h1>Tea kettle</h1><input aria-label="Postcode" oninput="${load}"><p id="status"></p><iframe id="widget" title="Payment plans"></iframe></body></html>`;
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
async function nativeRef(control: string): Promise<{ ref: string; generation: number }> {
  const observation = await observePage(page);
  const line = observation.snapshot.split('\n').find((candidate) => candidate.includes(control));
  const ref = line ? refIn(line) : undefined;
  if (!ref) throw new Error(`Missing native ref for ${control}: ${observation.snapshot}`);
  return { ref, generation: observation.generation };
}
async function widgetFrame(): Promise<Frame> {
  const element = await page.locator('#widget').elementHandle();
  const frame = await element?.contentFrame();
  await element?.dispose();
  if (!frame) throw new Error('Widget frame missing');
  return frame;
}
/** Playwright opens a session only for a frame Chrome runs as its own out-of-process target. */
async function assertOutOfProcess(frame: Frame): Promise<void> {
  await frame.locator('#plans').waitFor();
  await (await page.context().newCDPSession(frame)).detach();
}
async function reconcile(attemptId: string, id: string): Promise<Record<string, unknown> | undefined> {
  const observation = await observePage(page);
  const ref = refIn(observation.snapshot);
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
/** Main records what it learned of `attemptId`, as its tool does. */
function record(attemptId: string, outcome: 'placed' | 'not_placed', source: 'email' | 'principal') {
  return recordPurchaseOutcome(
    { thread: session.thread_id!, attempt_id: attemptId, outcome, source },
    main,
    () => queue,
  );
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

it('reads a date-only needed-by as the end of that day on the principal’s clock', () => {
  expect(purchaseBounds({ needed_by: '2026-10-20' }, 'America/Los_Angeles')).toEqual({
    neededBy: '2026-10-21T06:59:59.999Z',
    principalTimeZone: 'America/Los_Angeles',
  });
  expect(purchaseBounds({ needed_by: '2026-10-20' }, 'Asia/Tokyo')).toEqual({
    neededBy: '2026-10-20T14:59:59.999Z',
    principalTimeZone: 'Asia/Tokyo',
  });
  expect(purchaseBounds({ needed_by: '2026-10-14T17:00:00.000Z' }, 'Asia/Tokyo')).toEqual({
    neededBy: '2026-10-14T17:00:00.000Z',
    principalTimeZone: 'Asia/Tokyo',
  });
  expect(purchaseBounds({ delivery_window: { start: '2026-10-12', end: '2026-10-14' } }, 'Asia/Tokyo')).toEqual({
    deliveryWindow: { start: '2026-10-12', end: '2026-10-14' },
  });
});

describe.skipIf(!chromePath)('reviewed merchant purchases through native host delivery', { timeout: 30_000 }, () => {
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
        if (request.headers.host === new URL(OFFERS_ORIGIN).host) {
          offerRequests.push(url.pathname);
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(offerDocument(url) ?? '<html><body>Offer details</body></html>');
        } else if (request.headers.host === new URL(WIDGET_ORIGIN).host && offerDocument(url)) {
          widgetRequests.push(url.pathname);
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(offerDocument(url));
        } else if (request.headers.host === new URL(WIDGET_ORIGIN).host) {
          widgetRequests.push(url.pathname);
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(url.pathname === '/' ? widgetHtml() : '<html><body>Plan details</body></html>');
        } else if (request.method === 'POST' && url.pathname.startsWith('/gp/product/handle-buy-box')) {
          cartAdded++;
          response.writeHead(302, { location: `${AMAZON_RETAIL.origin}/gp/cart/view.html` });
          response.end();
        } else if (request.method === 'POST' && url.pathname === '/gp/cart/desktop/go-to-checkout.html') {
          response.writeHead(302, { location: `${AMAZON_RETAIL.origin}${AMAZON_RETAIL.reviewPath}` });
          response.end();
        } else if (request.method === 'POST') {
          submitted++;
          sawPost?.();
          let body = '';
          request.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          request.on('end', () => orderBodies.push(body));
          const finish = () => {
            response.writeHead(302, {
              location: `${AMAZON_RETAIL.origin}${confirmation ? '/gp/your-account/order-details?orderID=123-1234567-1234567' : AMAZON_RETAIL.confirmationPath}`,
            });
            response.end();
          };
          if (holdPost) void holdPost.then(finish);
          else finish();
        } else if (url.pathname === '/sw.js') {
          // A worker that answers a purchase navigation itself, without the network.
          response.writeHead(200, { 'content-type': 'text/javascript' });
          response.end(
            `self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (event) => event.waitUntil(clients.claim())); self.addEventListener('fetch', (event) => { if (event.request.mode === 'navigate' && new URL(event.request.url).pathname === '/checkout/placeorder') event.respondWith(new Response('<html><body>served by worker</body></html>', { headers: { 'content-type': 'text/html' } })); });`,
          );
        } else if (url.pathname === '/ap/signin/landing') {
          // A sign-in landing page whose image would carry the page's address as its Referer.
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            '<html><body><img src="/ap/signin/pixel.png"><a id="next" href="/ap/signin/next">Next</a></body></html>',
          );
        } else if (url.pathname === '/ap/signin/pixel.png' || url.pathname === '/ap/signin/next') {
          signInReferers.push([url.pathname, request.headers.referer]);
          response.writeHead(200, { 'content-type': url.pathname.endsWith('.png') ? 'image/png' : 'text/html' });
          response.end();
        } else if (url.pathname === '/dp/B0POPUP001') {
          // An ordinary product address that redirects its window to a purchase.
          response.writeHead(302, { location: `${WIDGET_ORIGIN}/checkout/placeorder` });
          response.end();
        } else {
          merchantDocuments.push(url.pathname);
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(fixturePage(url.pathname));
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
      if (
        ![AMAZON_RETAIL.origin, WIDGET_ORIGIN, OFFERS_ORIGIN].some(
          (origin) => request.url === `${new URL(origin).host}:443`,
        )
      ) {
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
    widgetRequests = [];
    signInReferers = [];
    offerRequests = [];
    merchantDocuments = [];
    reviewChoices = '';
    orderBodies = [];
    sent = [];
    orderedAt = new Date().toISOString();
    setDeliveryAdapter({
      async deliver(_type, platformId, _thread, _kind, content, files) {
        sent.push({ platformId, content, files });
        if (cardDuringDelivery) await cardDuringDelivery();
        return `message-${sent.length}`;
      },
    });
    page = await browser.newPage();
    // Classification reads each control in an isolated world, through the handoff a job context registers.
    await prepareAuthenticationIsolation(page.context(), true);
    await page.goto(`${AMAZON_RETAIL.origin}${AMAZON_RETAIL.reviewPath}`);
    queue = createBrowserQueue(new BrowserStore(), {
      pageForJob: async () => page,
      connection: async (): Promise<never> => {
        throw new Error('Not used');
      },
      closeJob: async () => undefined,
      onDisconnected: () => () => undefined,
    });
    registerBrowserPurchaseDelivery(() => queue);
    if (!getDeliveryAction('reservation_guarantee')) registerReservationGuaranteeDelivery();
    await recoverAndStartBrowserQueue(queue);
    await resumeBrowserPurchaseCommits(queue);
    setBrowserAdmissionReady(true);
  });
  afterEach(async () => {
    await stopHeldBrowserRequests();
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
      const ref = line ? refIn(line) : undefined;
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
    // A control the reviewed flow does not know is left to the open rule: an ordinary, real click, which here
    // presses a script-less button and submits nothing.
    expect(await activate('Continue', 'unknown-prep')).toMatchObject({ status: 'completed' });
    expect(cartAdded).toBe(0);
    expect(submitted).toBe(0);
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
  it('fails closed on an Amazon review page its signature no longer matches, never reading it as an unreviewed checkout', async () => {
    await page.locator('#placeYourOrder input').evaluate((node) => {
      (node as unknown as { name: string }).name = 'placeYourOrder2';
    });
    await buy();
    expect(await request('buy')).toMatchObject({
      status: 'facts_incomplete',
      missing: ["the site's reviewed checkout"],
    });
    expect(await approvals()).toHaveLength(0);
    expect(sent).toHaveLength(0);
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
    // The card names the errand in the principal's words, never its internal thread (KTD18).
    expect(approval.question.endsWith(`\n\n${ERRAND_ORIGIN_LINE}`)).toBe(true);
    expect(approval.question).not.toContain(session.thread_id!);
    // The reviewed reader places its order total and commit control: the card's one picture is clipped to both.
    expect(JSON.parse(sent[0].content)).toMatchObject({ pictures: 1 });
    expect(sent[0].files).toHaveLength(1);
    const boxes = await Promise.all(
      [page.locator(AMAZON_RETAIL.total).filter({ hasText: 'Order total:' }), page.locator(AMAZON_RETAIL.control)].map(
        async (locator) => {
          const box = await locator.boundingBox();
          if (!box) throw new Error('Fixture checkout box missing');
          return box;
        },
      ),
    );
    const picture = sent[0].files![0].data;
    expect(picture.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const left = Math.floor(Math.min(...boxes.map((box) => box.x)));
    const top = Math.floor(Math.min(...boxes.map((box) => box.y)));
    expect({ width: picture.readUInt32BE(16), height: picture.readUInt32BE(20) }).toEqual({
      width: Math.ceil(Math.max(...boxes.map((box) => box.x + box.width))) - left,
      height: Math.ceil(Math.max(...boxes.map((box) => box.y + box.height))) - top,
    });
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
  it('puts an age attestation on the purchase card itself; approving it ticks the box and stands as a grant, with no second card', async () => {
    reviewChoices = '<label><input type="checkbox" name="age" required> I confirm I am 21 or older</label>';
    await page.reload();
    await buy();
    const [approval] = await approvals();
    expect(approval.question).toContain(
      'Agreement: "I confirm I am 21 or older". Approving agrees to it, here and whenever this exact wording appears on amazon.com again, until you withdraw it.',
    );
    // Nothing is agreed before the principal decides.
    expect(await page.locator('input[name="age"]').isChecked()).toBe(false);
    await click(approval);
    await queue.idle();
    expect(submitted).toBe(1);
    expect(new URLSearchParams(orderBodies[0]).get('age')).toBe('on');
    expect(sent).toHaveLength(1);
    expect(
      await getDb().all('SELECT site,origin,wording,approval_id,withdrawn_at FROM gws_ea_browser_consent_grants'),
    ).toEqual([
      {
        site: 'amazon.com',
        origin: AMAZON_RETAIL.origin,
        wording: 'I confirm I am 21 or older',
        approval_id: approval.approval_id,
        withdrawn_at: null,
      },
    ]);
  });
  it('asks again before the commit when main withdrew an agreement the card approved', async () => {
    reviewChoices = '<label><input type="checkbox" name="age" required> I confirm I am 21 or older</label>';
    await page.reload();
    await buy();
    const [approval] = await approvals();
    // Withdrawn between the approval and the commit: the grant check inside begin() refuses the press.
    cardDuringDelivery = undefined;
    await getDb().run(
      "CREATE TRIGGER withdraw_after_grant AFTER INSERT ON gws_ea_browser_consent_grants BEGIN UPDATE gws_ea_browser_consent_grants SET withdrawn_at = '2026-10-17T00:00:00.000Z' WHERE id = NEW.id; END",
    );
    await click(approval);
    await queue.idle();
    expect(submitted).toBe(0);
    const [fresh] = await approvals();
    expect(fresh.approval_id).not.toBe(approval.approval_id);
    expect(fresh.question).toContain('An agreement on this checkout is no longer approved.');
    expect(fresh.question).toContain('Agreement: "I confirm I am 21 or older"');
  });
  const roundUp = (again: boolean): string =>
    `<label><input type="checkbox" id="round-up" name="round_up" checked> Round up for charity ($0.58)</label>${
      again
        ? `<script>const box = document.getElementById('round-up'); box.addEventListener('change', () => { if (!box.checked) setTimeout(() => { box.checked = true; }, 50); });</script>`
        : ''
    }`;
  it.each([
    ['unticks a pre-ticked round-up before the card, which names no charge for it', false],
    ['names a round-up the site keeps ticking as a charge on the card, which its approval covers', true],
  ] as const)('%s', async (_name, kept) => {
    reviewChoices = roundUp(kept);
    await page.reload();
    await buy();
    const [approval] = await approvals();
    // Only a round-up the site keeps ticked is on the card, as the charge the approval covers.
    expect(approval.question.includes('Round up')).toBe(kept);
    expect(approval.question.includes('Extra charge the site keeps selected: "Round up for charity ($0.58)"')).toBe(
      kept,
    );
    expect(await page.locator('#round-up').isChecked()).toBe(kept);
    await click(approval);
    await queue.idle();
    expect(submitted).toBe(1);
    expect(new URLSearchParams(orderBodies[0]).get('round_up')).toBe(kept ? 'on' : null);
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
    ['closed idle page', true, 'checkout_lapsed'],
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
      await recoverAndStartBrowserQueue(queue);
      await resumeBrowserPurchaseCommits(queue);
      if (closePage) {
        await page.close();
        page = await browser.newPage();
        await prepareAuthenticationIsolation(page.context(), true);
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
    await recoverAndStartBrowserQueue(queue);
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
    const held = await holdBrowserRequest(queue.store, queue.runtime, 'browser_purchase_commit');
    const context = held.context;
    await store.begin(
      context,
      authority.id,
      JSON.parse(authority.facts_json) as import('./fingerprint.js').PurchaseFacts,
    );
    expect((await queue.store.request(id))?.commit_started_at).toBeTruthy();
    expect(submitted).toBe(0);
    const stoppedHost = vi.spyOn(held.queue, 'finish').mockRejectedValue(new Error('Host stopped before answer'));
    await expect(held.queue.stop()).rejects.toThrow('Host stopped before answer');
    stoppedHost.mockRestore();
    expect((await store.get(authority.id))?.state).toBe('committing');
    expect((await queue.store.request(id))?.answered_at).toBeNull();
    await queue.stop();
    await recoverAndStartBrowserQueue(queue);
    await resumeBrowserPurchaseCommits(queue);
    await queue.idle();
    expect((await store.get(authority.id))?.state).toBe('unknown');
    expect(JSON.parse((await queue.store.request(id))!.answer_json!)).toMatchObject({
      data: { reason: 'unconfirmed' },
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
    // The page's record resolves the attempt and its authority alike, from the page.
    expect((await grant()).state).toBe('committed');
    expect(
      await getDb().get(
        'SELECT resolution,resolution_source FROM gws_ea_browser_purchase_attempts WHERE id = ?',
        authority.attempt_id,
      ),
    ).toEqual({ resolution: 'committed', resolution_source: 'page' });
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
  it('makes another purchase on the site wait on an unconfirmed one while browsing it goes on, until main records the order email (AE4)', async () => {
    confirmation = false;
    await buy();
    await click((await approvals())[0]);
    await queue.idle();
    const original = await grant();
    expect(JSON.parse(original.outcome_json!)).toMatchObject({
      status: 'unconfirmed',
      attempt_id: original.attempt_id,
    });
    await navigate(`${AMAZON_RETAIL.origin}/dp/B012345678`, 'browse-product');
    expect(await request('browse-product')).toMatchObject({ actions: [{ status: 'completed' }] });
    expect(page.url()).toBe(`${AMAZON_RETAIL.origin}/dp/B012345678`);
    await navigate(`${AMAZON_RETAIL.origin}${AMAZON_RETAIL.reviewPath}`, 'new-cart');
    await buy('second-purchase');
    expect(await request('second-purchase')).toMatchObject({ status: 'waiting_on_earlier', site: 'amazon.com' });
    expect(await getDb().all('SELECT id FROM gws_ea_browser_purchase_cards')).toHaveLength(1);
    expect(submitted).toBe(1);
    expect(await record(original.attempt_id, 'placed', 'email')).toMatchObject({ status: 'recorded' });
    expect((await grant()).state).toBe('committed');
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_blocks')).toEqual([]);
    // The waiting errand is woken once, naming the site.
    const woken = (await notes(session)).filter(
      (text) => text.includes('browser_site_available') && text.includes('"site":"amazon.com"'),
    );
    expect(woken).toHaveLength(1);
    await buy('after-the-answer');
    expect(await request('after-the-answer')).toMatchObject({ status: 'awaiting_principal' });
    const [card] = await approvals();
    expect(card.question).not.toMatch(/Possible duplicate|Earlier purchase/u);
    expect(submitted).toBe(1);
    // Main reads the open card's facts from the job's state, on the principal's clock.
    expect(await readBrowserJob(session.thread_id!)).toMatchObject({
      state: 'awaiting_principal',
      open_card: {
        site: 'amazon.com',
        total: '$85.00',
        due_now: '$85.00',
        expires: expect.stringMatching(/ Los Angeles time$/u),
      },
    });
  });
  it('puts main’s recorded "not placed" on the next card for the site, once, and never an attempt id', async () => {
    confirmation = false;
    await buy();
    await click((await approvals())[0]);
    await queue.idle();
    const original = await grant();
    expect(await record(original.attempt_id, 'not_placed', 'principal')).toMatchObject({ status: 'recorded' });
    expect((await grant()).state).toBe('revoked');
    await navigate(`${AMAZON_RETAIL.origin}${AMAZON_RETAIL.reviewPath}`, 'retry-cart');
    await buy('retry');
    const [card] = await approvals();
    expect(card.question).toMatch(
      /Earlier purchase here, tried .+ Los Angeles time: I recorded it as not placed, from what you told me\./u,
    );
    expect(card.question).not.toMatch(/attempt-|authority-|Possible duplicate/u);
    await click(card, 'reject');
    await buy('retry-again');
    const [next] = await approvals();
    expect(next.question).not.toContain('recorded it as not placed');
    expect(submitted).toBe(1);
  });
  it('refuses a purchase navigation inside an out-of-process widget frame before the widget receives it', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0PAYFRAME`, 'widget-page');
    const frame = await widgetFrame();
    await assertOutOfProcess(frame);
    await queue.accept(
      'browser',
      { actions: [{ kind: 'click', ...(await nativeRef('link "Compare plans"')) }] },
      session,
      'widget-plans',
    );
    await queue.idle();
    expect(widgetRequests).toEqual(['/']);
    expect(await request('widget-plans')).toMatchObject({ status: 'stopped', reason: 'purchase_control' });
  }, 30_000);
  it('lets an ordinary navigation inside the out-of-process widget frame proceed', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0PAYFRAME`, 'widget-page');
    const frame = await widgetFrame();
    await assertOutOfProcess(frame);
    await queue.accept(
      'browser',
      { actions: [{ kind: 'click', ...(await nativeRef('link "Plan help"')) }] },
      session,
      'widget-help',
    );
    await queue.idle();
    expect(await request('widget-help')).toMatchObject({ status: 'completed' });
    await expect.poll(() => frame.url()).toBe(`${WIDGET_ORIGIN}/help`);
    expect(widgetRequests).toEqual(['/', '/help']);
  }, 30_000);
  it('guards a frame that turns out-of-process after the guard installed', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0PAYLATER`, 'later-page');
    const guard = await ensureBrowserNavigationGuard(page);
    const frame = await widgetFrame();
    await expect(page.context().newCDPSession(frame)).rejects.toThrow('does not have a separate CDP session');
    // The batch's pre-operation pass still sees a same-process frame; only the swap during the batch creates its target.
    await queue.accept(
      'browser',
      {
        actions: [
          { kind: 'type', ...(await nativeRef('textbox "Postcode"')), text: '98101' },
          { kind: 'wait_for', text: 'Plans loaded' },
        ],
      },
      session,
      'later-load',
    );
    await queue.idle();
    expect(await request('later-load')).toMatchObject({ status: 'completed' });
    expect(frame.url()).toBe(`${WIDGET_ORIGIN}/`);
    await assertOutOfProcess(frame);
    // Outside any job batch the guard still decides this frame's documents: a purchase route is refused.
    await frame.locator('#plans').click();
    await expect.poll(() => guard.reason()).toBe('purchase_control');
    expect(widgetRequests).toEqual(['/']);
  }, 30_000);
  it('holds file choosers opened in the page and in an out-of-process frame instead of showing them', async () => {
    await secureJobPage(page);
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0PAYFRAME`, 'widget-page');
    const frame = await widgetFrame();
    await assertOutOfProcess(frame);
    const targets = [page.mainFrame(), frame];
    for (const target of targets) await target.locator('#statement').click();
    // Headless Chrome cancels a chooser nobody intercepted; headed Chrome would show the operator a native panel.
    const outcomes = await Promise.all(
      targets.map((target) =>
        target
          .locator('#statement[data-chooser]')
          .waitFor({ timeout: 1_000 })
          .then(
            () => 'returned',
            (error: unknown) => (error instanceof errors.TimeoutError ? 'held' : error),
          ),
      ),
    );
    expect(outcomes).toEqual(['held', 'held']);
  }, 30_000);
  it.each(['browser', 'purchase'] as const)(
    'refuses to start a %s request while a page-target setting cannot reach an out-of-process frame',
    async (action) => {
      await navigate(`${AMAZON_RETAIL.origin}/dp/B0PAYFRAME`, 'widget-page');
      await assertOutOfProcess(await widgetFrame());
      let pageTarget = true;
      // A setting that reaches the page target but can never be set up on a frame target.
      await coverPageTargets(page, async () => {
        if (!pageTarget) throw new Error('Fixture frame setup refused');
        pageTarget = false;
      });
      const payload =
        action === 'browser' ? { actions: [{ kind: 'observe' }] } : { target: await nativeRef('link "Hide plans"') };
      await queue.accept(action, payload, session, 'uncovered-frame');
      await queue.idle();
      const result = await request('uncovered-frame');
      expect(result).toMatchObject({ status: 'stopped', reason: 'blocked_address', repeat_safe: true });
      expect(result?.actions).toBeUndefined();
      expect(await approvals()).toEqual([]);
    },
    30_000,
  );
  it('completes a batch whose widget frame navigates back to the hosting page site', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0PAYFRAME`, 'widget-page');
    const frame = await widgetFrame();
    await assertOutOfProcess(frame);
    await queue.accept(
      'browser',
      { actions: [{ kind: 'click', ...(await nativeRef('link "Kettle details"')) }] },
      session,
      'widget-back',
    );
    await queue.idle();
    expect(await request('widget-back')).toMatchObject({ status: 'completed' });
    expect(frame.url()).toBe(`${AMAZON_RETAIL.origin}/dp/B012345678`);
    await expect(page.context().newCDPSession(frame)).rejects.toThrow('does not have a separate CDP session');
  }, 30_000);
  it('completes a batch that removes its out-of-process widget frame', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0PAYFRAME`, 'widget-page');
    const frame = await widgetFrame();
    await assertOutOfProcess(frame);
    await queue.accept(
      'browser',
      { actions: [{ kind: 'click', ...(await nativeRef('link "Hide plans"')) }] },
      session,
      'widget-hide',
    );
    await queue.idle();
    expect(await request('widget-hide')).toMatchObject({ status: 'completed' });
    expect(frame.isDetached()).toBe(true);
  }, 30_000);
  it('does not report a refusal for a paused request whose frame was removed before its decision', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0PAYFRAME`, 'widget-page');
    const guard = await ensureBrowserNavigationGuard(page);
    const frame = await widgetFrame();
    await assertOutOfProcess(frame);
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const decided = new Promise<void>((resolve) => {
      release = resolve;
    });
    await guard.runWithPolicy(
      {
        async beforeNavigate() {
          reached();
          await decided;
          return 'ordinary';
        },
      },
      async () => {
        // The widget's own navigation waits on this decision while the page removes the widget.
        await frame.evaluate("location.assign('/help')");
        await paused;
        await page.evaluate("document.getElementById('widget').remove()");
        await expect.poll(() => frame.isDetached()).toBe(true);
        release();
        // A later round trip on the same connection orders after the dead request's continue.
        await page.evaluate('0');
        expect(guard.reason()).toBeUndefined();
      },
    );
    expect(widgetRequests).toEqual(['/']);
  }, 30_000);
  it('guards a widget frame again after it swapped back in-process and then cross-site', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0PAYFRAME`, 'widget-page');
    const guard = await ensureBrowserNavigationGuard(page);
    const frame = await widgetFrame();
    await assertOutOfProcess(frame);
    await queue.accept(
      'browser',
      { actions: [{ kind: 'click', ...(await nativeRef('link "Kettle details"')) }] },
      session,
      'widget-back',
    );
    await queue.idle();
    expect(await request('widget-back')).toMatchObject({ status: 'completed' });
    await expect(page.context().newCDPSession(frame)).rejects.toThrow('does not have a separate CDP session');
    await queue.accept(
      'browser',
      {
        actions: [
          { kind: 'click', ...(await nativeRef('link "Show plans"')) },
          { kind: 'wait_for', text: 'Plans loaded' },
        ],
      },
      session,
      'widget-again',
    );
    await queue.idle();
    expect(await request('widget-again')).toMatchObject({ status: 'completed' });
    await assertOutOfProcess(frame);
    // No readiness pass ran after the second swap: ending the first target let the swap's own event cover it.
    guard.clearReason();
    await frame.locator('#plans').click();
    await expect.poll(() => guard.reason()).toBe('purchase_control');
    expect(widgetRequests).toEqual(['/', '/']);
  }, 30_000);
  it('strips the Referer from what a sign-in scope loads, documents and subresources alike', async () => {
    const guard = await ensureBrowserNavigationGuard(page);
    const landing = `${AMAZON_RETAIL.origin}/ap/signin/landing`;
    const visit = async (scope: { stripReferrer?: boolean }) =>
      guard.runWithPolicy({ ...scope, classify: () => 'ordinary' }, async () => {
        await page.goto(landing, { waitUntil: 'load' });
        await Promise.all([page.waitForURL('**/ap/signin/next'), page.click('#next')]);
      });
    await visit({ stripReferrer: true });
    expect(guard.reason()).toBeUndefined();
    expect(signInReferers).toEqual([
      ['/ap/signin/pixel.png', undefined],
      ['/ap/signin/next', undefined],
    ]);
    // Outside the scope the same page's loads carry its Referer as usual.
    signInReferers = [];
    await visit({});
    expect(signInReferers).toEqual([
      ['/ap/signin/pixel.png', landing],
      ['/ap/signin/next', landing],
    ]);
  }, 30_000);
  it('still refuses but does not report a decision that lands after its operation ended', async () => {
    const guard = await ensureBrowserNavigationGuard(page);
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const decided = new Promise<void>((resolve) => {
      release = resolve;
    });
    let leaving: Promise<unknown> = Promise.resolve();
    await guard.runWithPolicy(
      {
        async beforeNavigate() {
          reached();
          await decided;
          return 'site_busy';
        },
      },
      async () => {
        leaving = page.goto(`${AMAZON_RETAIL.origin}/dp/B012345678`).catch((error: unknown) => error);
        await paused;
      },
    );
    await guard.runWithPolicy({}, async () => {
      release();
      expect(String(await leaving)).toContain('ERR_BLOCKED_BY_CLIENT');
      expect(guard.reason()).toBeUndefined();
    });
  }, 30_000);
  it('refuses brand-new cross-site frames that navigate themselves to a purchase as they load', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0OFFERS01`, 'offers-page');
    const reasons: unknown[] = [];
    for (let trial = 1; trial <= 20; trial++) {
      await queue.accept(
        'browser',
        {
          actions: [
            { kind: 'click', ...(await nativeRef('link "Load offers"')) },
            { kind: 'wait_for', text: `Redirected ${trial}`, timeout_ms: 5_000 },
          ],
        },
        session,
        `offers-${trial}`,
      );
      await queue.idle();
      reasons.push((await request(`offers-${trial}`))?.reason);
    }
    expect(widgetRequests.filter((path) => path === '/checkout/placeorder')).toHaveLength(0);
    expect(reasons).toEqual(Array<string>(20).fill('purchase_control'));
  }, 120_000);
  it('places nested same-site and cross-site frames with the page that hosts their widget', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0OFFERS01`, 'offers-page');
    await queue.accept(
      'browser',
      {
        actions: [
          { kind: 'click', ...(await nativeRef('link "Load nested offers"')) },
          { kind: 'wait_for', text: 'Ready 2', timeout_ms: 5_000 },
        ],
      },
      session,
      'nested-load',
    );
    await queue.idle();
    // Both children loaded, so the gate placed each first document with this page.
    expect(await request('nested-load')).toMatchObject({ status: 'completed' });
    const child = (url: string) => {
      const frame = page.frames().find((candidate) => candidate.url() === url);
      if (!frame) throw new Error(`Nested frame missing: ${url}`);
      return frame;
    };
    // The cross-site child is its own target, found through its parent; the same-site child is not a
    // target at all, found only in its widget's frame tree.
    await (await page.context().newCDPSession(child(`${OFFERS_ORIGIN}/?child=cross`))).detach();
    await expect(page.context().newCDPSession(child(`${WIDGET_ORIGIN}/?child=same`))).rejects.toThrow(
      'does not have a separate CDP session',
    );
    await queue.accept(
      'browser',
      {
        actions: [
          { kind: 'click', ...(await nativeRef('link "Start offers"')) },
          { kind: 'wait_for', text: 'Redirected 2', timeout_ms: 5_000 },
        ],
      },
      session,
      'nested-go',
    );
    await queue.idle();
    expect(await request('nested-go')).toMatchObject({ status: 'stopped', reason: 'purchase_control' });
    expect(widgetRequests).not.toContain('/checkout/placeorder');
    expect(offerRequests).not.toContain('/checkout/placeorder');
  }, 30_000);
  it('refuses brand-new same-site frames inside a brand-new widget that navigate themselves as they load', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0OFFERS01`, 'offers-page');
    for (let trial = 1; trial <= 20; trial++) {
      await queue.accept(
        'browser',
        {
          actions: [
            { kind: 'click', ...(await nativeRef('link "Load nested now"')) },
            { kind: 'wait_for', text: `Redirected ${trial}`, timeout_ms: 5_000 },
          ],
        },
        session,
        `nested-now-${trial}`,
      );
      await queue.idle();
    }
    expect(widgetRequests.filter((path) => path === '/checkout/placeorder')).toHaveLength(0);
  }, 120_000);
  it.each(['Open deals', 'Open deals window'])(
    'decides the documents of a window the page opens under the page guard (%s)',
    async (link) => {
      await navigate(`${AMAZON_RETAIL.origin}/dp/B0OFFERS01`, 'offers-page');
      const opened = page.context().waitForEvent('page');
      await queue.accept(
        'browser',
        { actions: [{ kind: 'click', ...(await nativeRef(`link "${link}"`)) }] },
        session,
        'deals',
      );
      await queue.idle();
      const window = await opened;
      // The window's ordinary first address is allowed; its redirect to a purchase is refused.
      await expect.poll(() => window.url(), { timeout: 5_000 }).toMatch(/^chrome-error:|placeorder/);
      expect(widgetRequests).not.toContain('/checkout/placeorder');
    },
    30_000,
  );
  it('decides under the page policy a same-process frame whose very first document is a purchase', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0OFFERS01`, 'offers-page');
    const reasons: unknown[] = [];
    for (let trial = 1; trial <= 20; trial++) {
      await queue.accept(
        'browser',
        { actions: [{ kind: 'click', ...(await nativeRef('link "Load checkout frame"')) }] },
        session,
        `checkout-frame-${trial}`,
      );
      await queue.idle();
      reasons.push((await request(`checkout-frame-${trial}`))?.reason);
    }
    expect(merchantDocuments).not.toContain('/checkout/placeorder');
    expect(reasons).toEqual(Array<string>(20).fill('purchase_control'));
  }, 120_000);
  it('never lets a service worker answer a navigation the document gate has not decided', async () => {
    await navigate(`${AMAZON_RETAIL.origin}/dp/B0WORKER01`, 'worker-page');
    const guard = await ensureBrowserNavigationGuard(page);
    await page.locator('body[data-worker]').waitFor({ timeout: 10_000 });
    expect(await page.locator('body').getAttribute('data-worker')).toBe('refused');
    // With no worker registered, the purchase navigation reaches the gate, which refuses it outside any errand.
    await page.evaluate("location.assign('/checkout/placeorder')");
    await expect.poll(() => guard.reason(), { timeout: 5_000 }).toBe('purchase_control');
    // The refused navigation ends on Chrome's error page; read the page once that has committed.
    await expect.poll(() => page.url(), { timeout: 5_000 }).toMatch(/^chrome-error:/u);
    await page.waitForLoadState('domcontentloaded');
    expect(await page.content()).not.toContain('served by worker');
  }, 30_000);
});
