/**
 * Local TLS fixture for unreviewed sites: no request can reach a real site. One HTTPS server answers every
 * fixture host through a proxy that admits only hosts the fixture serves, so processor and chat hosts are
 * local stand-ins too. Suites extend it with `serve`; the page builders below are the shared open-web pages.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

import { prepareAuthenticationIsolation } from './authentication-submit.js';

export interface OpenWebRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}
export interface OpenWebResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}
/** A page's HTML, or a handler for every request to its address. */
export type OpenWebRoute = string | ((request: OpenWebRequest) => OpenWebResponse);

export interface OpenWebFixture {
  readonly browser: Browser;
  /** Every request the fixture's sites received, in order. */
  readonly requests: OpenWebRequest[];
  /** Serves `route` at an HTTPS address (its query is ignored), replacing what was there; its host becomes reachable. */
  serve(url: string, route: OpenWebRoute): void;
  /** A fresh page in its own context, prepared for isolated-world reads. */
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

/** Where the shared open-web pages live. */
export const OPEN_WEB = {
  article: 'https://news.example/2026/10/17/autumn-menus-open-this-week',
  about: 'https://news.example/about',
  product: 'https://shop.example/products/linen-apron',
  cart: 'https://shop.example/cart',
  shipping: 'https://shop.example/checkout/shipping',
  payment: 'https://shop.example/checkout/payment',
  split: 'https://shop.example/checkout/split',
  confirm: 'https://shop.example/checkout/confirm',
  rewritten: 'https://shop.example/checkout/rewritten',
  redirect: 'https://shop.example/checkout/redirect',
  platform: 'https://pay.example/session/cs_fixture_42',
  hostedCard: 'https://shop.example/checkout/card',
  ownCardFrame: 'https://shop.example/checkout/own-card',
  pending: 'https://shop.example/checkout/pending',
  embeddedPay: 'https://shop.example/checkout/embedded',
  restaurant: 'https://bistro.example/',
  feeRestaurant: 'https://bistro.example/private-dining',
  reservation: 'https://book.example/reservations/r-123',
  contact: 'https://shop.example/contact',
  support: 'https://shop.example/support',
  review: 'https://shop.example/products/linen-apron/reviews/new',
  help: 'https://shop.example/help',
  account: 'https://shop.example/account/settings',
  overlay: 'https://shop.example/deals',
} as const;

const document = (title: string, body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
const shopHeader = '<header><a href="/">Linen &amp; Co</a> <a href="/cart">Cart</a> <a href="/help">Help</a></header>';

/** A dated article with ordinary links and a formless comment box. */
export function articlePage(): string {
  return document(
    'Autumn menus open this week',
    `<article><h1>Autumn menus open this week</h1><p><time datetime="2026-10-17">October 17, 2026</time> · By Juno Hale</p>
<p>Three kitchens change their menus for the season.</p>
<a id="about" href="/about">About us</a> <a id="more" href="/food">More food news</a> <button type="button" id="share">Share</button></article>
<section id="comments"><h2>Comments</h2><div id="comment-box" contenteditable="true" role="textbox" aria-label="Your comment"></div>
<button type="button" id="post-comment">Comment</button></section>`,
  );
}

export function aboutPage(): string {
  return document('About', '<h1>About the paper</h1><p>Local news since 1998.</p><a href="/">Front page</a>');
}

/**
 * A product page that loads Stripe.js's hidden metrics frame, shows a PayPal Pay Later message and offers
 * express-pay buttons, with no total anywhere.
 */
export function productPage(): string {
  return document(
    'Linen apron',
    `${shopHeader}<main><h1>Linen apron</h1><p class="price">$39.00</p>
<form id="add" method="post" action="/cart/add"><label>Size <select id="size" name="size"><option>S</option><option selected>M</option><option>L</option></select></label>
<button type="submit" id="add-to-cart">Add to cart</button> <button type="button" id="continue">Continue</button></form>
<div class="express"><button type="button" id="apple-pay">Apple Pay</button> <button type="button" id="google-pay">Google Pay</button></div>
<iframe id="pay-later" title="PayPal Pay Later message" src="https://www.paypal.com/credit-presentment/smart/message?amount=39.00" style="width:320px;height:40px;border:0"></iframe>
<iframe name="__privateStripeMetricsController0" src="https://js.stripe.com/v3/m-outer-fixture.html" aria-hidden="true" tabindex="-1" style="visibility:hidden;position:fixed;width:1px;height:1px;border:0"></iframe></main>`,
  );
}

export function payLaterMessage(): string {
  return document('Pay Later', '<p>Pay in 4 interest-free payments of $9.75. <a href="#">Learn more</a></p>');
}

/** A cart: quantity, removal and a coupon around a subtotal, with an express-pay button. */
export function cartPage(): string {
  return document(
    'Cart',
    `${shopHeader}<h1>Your cart</h1><form id="cart" method="post" action="/cart/update">
<div class="line">Linen apron, M <button type="button" aria-label="Decrease quantity">−</button><input name="qty" type="number" value="1" aria-label="Quantity"><button type="button" aria-label="Increase quantity">+</button>
<button type="submit" name="remove" value="apron">Remove</button></div><p>Subtotal $39.00</p>
<label>Coupon code <input name="coupon"></label> <button type="submit" name="apply">Apply</button>
<button type="submit" id="proceed" formaction="/checkout/shipping" formmethod="get">Proceed to checkout</button></form>
<div><button type="button">Shop Pay</button></div>`,
  );
}

/** The first checkout step: a total and delivery options, no payment method yet. */
export function shippingPage(): string {
  return document(
    'Checkout: delivery',
    `${shopHeader}<h1>Delivery</h1><form id="shipping" method="get" action="/checkout/payment">
<label>Name <input name="name" autocomplete="name"></label> <label>Email <input name="email" type="email" autocomplete="email"></label>
<label>Address <input name="address" autocomplete="street-address"></label>
<fieldset><legend>Delivery option</legend><label><input type="radio" name="delivery" value="standard" checked> Standard delivery, free</label>
<label><input type="radio" name="delivery" value="express"> Express delivery, $8.00</label></fieldset>
<button type="button" id="summary">Show order summary</button><p>Order total <strong>$42.00</strong></p>
<button type="submit" id="continue">Continue</button></form>`,
  );
}

/** The transaction step: a saved card and a total in one form, with every preparation control beside the commits. */
export function paymentPage(): string {
  return document(
    'Checkout: payment',
    `${shopHeader}<h1>Checkout</h1><form id="checkout" method="post" action="/checkout/complete">
<section><h2>Delivery</h2><p>Morgan Ellery, 10 Main St</p><button type="button" id="edit">Edit</button></section>
<section><h2>Payment</h2><p>Visa ending in 4242</p></section>
<section><h2>Items</h2><p>Linen apron × 1</p><button type="button" id="decrease" aria-label="Decrease quantity">−</button>
<button type="button" id="increase" aria-label="Increase quantity">+</button> <button type="button" id="remove">Remove</button></section>
<label>Coupon code <input id="coupon" name="coupon"></label> <button type="button" id="apply">Apply</button>
<button type="button" id="summary">Show order summary</button><p>Order total <strong>$42.00</strong></p>
<label>Delivery instructions <textarea id="note" name="note"></textarea></label>
<button type="button" id="back">Back</button> <button type="submit" id="continue">Continue</button> <button type="submit" id="place">Place order</button></form>`,
  );
}

/** A total in one form and the saved card in another: neither form is a transaction. */
export function splitPage(): string {
  return document(
    'Checkout',
    `<form id="totals" method="post" action="/checkout/totals"><p>Order total</p><p>$42.00</p><button type="submit" id="totals-continue">Continue</button></form>
<form id="wallet" method="post" action="/checkout/wallet"><p>Visa ending in 4242</p><button type="submit" id="wallet-continue">Continue</button></form>`,
  );
}

/** A transaction page whose review opens a confirmation modal, with a nested confirmation inside it. */
export function confirmPage(): string {
  return document(
    'Checkout: review',
    `<form id="checkout" method="post" action="/checkout/complete"><p>Visa ending in 4242</p><p>Order total $42.00</p>
<button type="button" id="review">Review order</button></form>
<dialog id="confirm"><p>Confirm your order of $42.00?</p><button type="button" id="confirm-yes">Confirm</button>
<button type="button" id="confirm-no">Cancel</button> <button type="button" id="details">Details</button>
<div id="nested" role="dialog" aria-modal="true" hidden><p>Charge $42.00 now?</p><button type="button" id="nested-yes">Yes</button></div></dialog>`,
    `document.getElementById('review').addEventListener('click', () => document.getElementById('confirm').showModal());
document.getElementById('confirm-no').addEventListener('click', () => document.getElementById('confirm').close());
document.getElementById('details').addEventListener('click', () => { document.getElementById('nested').hidden = false; });`,
  );
}

/** A transaction page whose script rewrites, in the page's own world, what every control and form reports. */
export function rewrittenPage(): string {
  return document(
    'Checkout',
    `<form id="checkout" method="post" action="/checkout/complete"><p>Visa ending in 4242</p><p>Order total $42.00</p>
<button type="submit" id="place">Place order</button> <button type="button" id="continue">Continue</button></form>`,
    `for (const [prototype, name] of [[Node.prototype, 'textContent'], [HTMLElement.prototype, 'innerText'], [HTMLInputElement.prototype, 'value']])
  Object.defineProperty(prototype, name, { configurable: true, get() { return 'Search'; } });
Element.prototype.getAttribute = function (name) { return name === 'aria-label' ? 'Search' : null; };
Element.prototype.matches = () => false;
Element.prototype.closest = () => null;
Object.defineProperty(HTMLButtonElement.prototype, 'form', { configurable: true, get() { return null; } });
Object.defineProperty(HTMLElement.prototype, 'isConnected', { configurable: true, get() { return false; } });`,
  );
}

/** A payment platform's own hosted checkout, reached by a redirect from the merchant. */
export function platformPage(): string {
  return document(
    'Pay Linen & Co',
    `<h1>Pay Linen &amp; Co</h1><form method="post" action="/session/cs_fixture_42/confirm"><p>Total due</p><p>$42.00</p>
<label>Card number <input name="cardnumber" autocomplete="cc-number"></label> <label>Expiry <input name="exp" autocomplete="cc-exp"></label>
<label>CVC <input name="cvc" autocomplete="cc-csc"></label><button type="submit" id="pay">Pay $42.00</button> <button type="button" id="continue">Continue</button></form>
<a id="back" href="https://shop.example/cart">Back to Linen &amp; Co</a>`,
  );
}

/** A merchant form whose payment method is a hosted processor card frame. */
export function hostedCardPage(): string {
  return document(
    'Checkout: card',
    `<form id="checkout" method="post" action="/checkout/complete"><p>Order total</p><p>$42.00</p>
<iframe id="card-frame" title="Secure card payment input frame" src="https://js.stripe.com/v3/elements-inner-card-fixture.html" style="width:360px;height:48px;border:0"></iframe>
<label>Coupon code <input name="coupon"></label> <button type="button" id="apply">Apply</button> <button type="submit" id="continue">Continue</button></form>`,
  );
}

/** A merchant form whose payment method is a card frame on its own secure subdomain, known by its fields alone. */
export function ownCardFramePage(): string {
  return document(
    'Checkout: card',
    `<form id="checkout" method="post" action="/checkout/complete"><p>Order total</p><p>$42.00</p>
<iframe id="card-frame" title="Card details" src="https://secure.shop.example/card" style="width:360px;height:48px;border:0"></iframe>
<button type="submit" id="continue">Continue</button></form>`,
  );
}

/**
 * A total beside processor frames that take no payment: a hidden card frame, Stripe.js's metrics frame and a
 * Pay Later message. None is a payment method.
 */
export function pendingPage(): string {
  return document(
    'Checkout',
    `<form id="checkout" method="post" action="/checkout/complete"><p>Order total</p><p>$42.00</p>
<iframe id="hidden-card" src="https://js.stripe.com/v3/elements-inner-card-fixture.html" style="visibility:hidden;width:360px;height:48px;border:0"></iframe>
<iframe name="__privateStripeMetricsController0" src="https://js.stripe.com/v3/m-outer-fixture.html" aria-hidden="true" tabindex="-1" style="visibility:hidden;position:fixed;width:1px;height:1px;border:0"></iframe>
<iframe id="pay-later" title="PayPal Pay Later message" src="https://www.paypal.com/credit-presentment/smart/message?amount=42.00" style="width:320px;height:40px;border:0"></iframe>
<button type="submit" id="continue">Continue</button></form>`,
  );
}

export function processorCardFrame(): string {
  return document(
    'Card',
    '<input name="cardnumber" autocomplete="cc-number" placeholder="Card number"><input name="exp-date" autocomplete="cc-exp" placeholder="MM / YY"><input name="cvc" autocomplete="cc-csc" placeholder="CVC">',
  );
}

/** A merchant page embedding a payment platform's checkout frame, which holds its own total, card fields and Pay. */
export function embeddedPayPage(): string {
  return document(
    'Checkout',
    `<h1>Checkout</h1><iframe id="pay-frame" title="Payment" src="https://pay.example/embedded/cs_fixture_42" style="width:420px;height:260px;border:0"></iframe>`,
  );
}

export function embeddedPayFrame(): string {
  return document(
    'Payment',
    `<form method="post" action="/embedded/cs_fixture_42/confirm"><p>Total due $42.00</p><input name="cardnumber" autocomplete="cc-number">
<input name="exp" autocomplete="cc-exp"><input name="cvc" autocomplete="cc-csc"><button type="submit" id="pay">Pay</button></form>`,
  );
}

/** A restaurant's site embedding a booking provider's widget; `widget` selects the free or fee-bearing one. */
export function restaurantPage(widget: string): string {
  return document(
    'Bistro Juno',
    `<h1>Bistro Juno</h1><p>Seasonal plates in the old mill.</p><iframe id="booking" title="Reservations" src="${widget}" style="width:420px;height:420px;border:0"></iframe>`,
  );
}

/** A booking step: party size, a time, a note for the venue and a reservation. With `fee`, a card guarantees a stated fee. */
export function bookingWidget(fee: boolean): string {
  return document(
    'Reserve a table',
    `<form id="booking" method="post" action="/widget/book"><label>Party size <select id="party" name="party"><option>2</option><option>4</option></select></label>
<div role="group" aria-label="Times"><button type="button" id="slot-1830">6:30 PM</button> <button type="button" id="slot-1900">7:00 PM</button></div>
<label>Special requests <textarea id="requests" name="requests"></textarea></label>
${fee ? '<p>Cancellation fee</p><p>$25 per person for cancellations within 24 hours</p><p>Card on file: Visa ending in 4242</p>' : '<p>No payment is needed to reserve.</p>'}
<button type="submit" id="reserve">Reserve</button></form>`,
  );
}

/** A booking's own page, where cancelling or changing it costs a stated fee. */
export function reservationPage(): string {
  return document(
    'Your reservation',
    `<h1>Your reservation</h1><p>Table for 2, Saturday 7:00 PM</p><p>Cancellation fee: $25 per person within 24 hours of your reservation.</p>
<button type="button" id="modify">Modify reservation</button> <button type="button" id="cancel">Cancel reservation</button>
<a id="venue" href="https://bistro.example/">Back to Bistro Juno</a>`,
  );
}

/** A contact form: name, email and a message, pressed with `label`. */
export function contactPage(label: string): string {
  return document(
    'Contact us',
    `${shopHeader}<h1>Contact us</h1><form id="contact" method="post" action="/contact/send"><label>Name <input name="name" autocomplete="name"></label>
<label>Email <input name="email" type="email" autocomplete="email"></label><label>Message <textarea id="message" name="message"></textarea></label>
<button type="submit" id="send">${label}</button></form>`,
  );
}

export function reviewPage(): string {
  return document(
    'Write a review',
    `${shopHeader}<h1>Linen apron</h1><form id="review" method="post" action="/products/linen-apron/reviews">
<fieldset><legend>Rating</legend><label><input type="radio" name="rating" value="5"> 5 stars</label><label><input type="radio" name="rating" value="4"> 4 stars</label></fieldset>
<label>Your review <textarea id="review-text" name="body"></textarea></label><button type="submit" id="post">Post</button></form>`,
  );
}

/** A help page: a formless search, a formless inline chat, and a third-party chat widget frame. */
export function helpPage(): string {
  return document(
    'Help',
    `${shopHeader}<h1>Help centre</h1><div class="search"><input type="search" id="help-search" aria-label="Search help"><button type="button" id="help-search-go">Search</button></div>
<div id="inline-chat"><div role="log">Hi! How can we help?</div><input type="text" id="chat-input" placeholder="Type a message"><button type="button" id="chat-send">Send</button></div>
<iframe id="chat-frame" title="Live chat" src="https://chat.example/widget" style="width:320px;height:200px;border:0"></iframe>`,
  );
}

export function chatWidget(): string {
  return document(
    'Chat',
    `<div role="log">Agent: Hello, ask us anything.</div><form id="chat"><input id="chat-message" name="message" aria-label="Message" autocomplete="off"><button type="submit" id="chat-submit">Send</button></form>`,
  );
}

/** A signed-in account page: contact details, password and display preferences, each its own form. */
export function accountPage(): string {
  return document(
    'Account settings',
    `${shopHeader.replace('</header>', ' <a href="/account/sign-out">Sign out</a></header>')}<h1>Account settings</h1>
<form id="contact" method="post" action="/account/contact"><h2>Contact details</h2><label>Email <input type="email" name="email" value="morgan.ellery@example.test"></label>
<label>Phone <input type="tel" name="phone" value="+1 555 0100"></label><button type="submit" id="save-contact">Save</button></form>
<form id="password" method="post" action="/account/password"><h2>Password</h2><label>Current password <input type="password" name="current" autocomplete="current-password"></label>
<label>New password <input type="password" name="new" autocomplete="new-password"></label><button type="submit" id="update-password">Update</button></form>
<form id="display" method="post" action="/account/display"><h2>Display</h2><label>Theme <select id="theme" name="theme"><option>Light</option><option>Dark</option></select></label>
<button type="submit" id="save-display">Save preferences</button></form>`,
  );
}

/** An overlay trick: an invisible layer over an ordinary search whose own click posts an order. */
export function overlayPage(): string {
  return document(
    'Deals',
    `${shopHeader}<h1>Deals</h1><form method="get" action="/search"><input type="search" name="q" aria-label="Search deals"><button id="search">Search</button></form>
<form id="buy" method="post" action="/checkout/complete"><input type="hidden" name="sku" value="apron"></form>
<div id="overlay" onclick="document.getElementById('buy').submit()" style="position:fixed;inset:0;opacity:0.01;z-index:10"></div>`,
  );
}

/** The shared open-web pages, by address. */
export function openWebPages(): Record<string, OpenWebRoute> {
  return {
    [OPEN_WEB.article]: articlePage(),
    [OPEN_WEB.about]: aboutPage(),
    [OPEN_WEB.product]: productPage(),
    'https://www.paypal.com/credit-presentment/smart/message': payLaterMessage(),
    'https://js.stripe.com/v3/m-outer-fixture.html': document('', ''),
    [OPEN_WEB.cart]: cartPage(),
    [OPEN_WEB.shipping]: shippingPage(),
    [OPEN_WEB.payment]: paymentPage(),
    [OPEN_WEB.split]: splitPage(),
    [OPEN_WEB.confirm]: confirmPage(),
    [OPEN_WEB.rewritten]: rewrittenPage(),
    [OPEN_WEB.redirect]: () => ({ status: 302, headers: { location: OPEN_WEB.platform } }),
    [OPEN_WEB.platform]: platformPage(),
    [OPEN_WEB.hostedCard]: hostedCardPage(),
    'https://js.stripe.com/v3/elements-inner-card-fixture.html': processorCardFrame(),
    [OPEN_WEB.ownCardFrame]: ownCardFramePage(),
    'https://secure.shop.example/card': processorCardFrame(),
    [OPEN_WEB.pending]: pendingPage(),
    [OPEN_WEB.embeddedPay]: embeddedPayPage(),
    'https://pay.example/embedded/cs_fixture_42': embeddedPayFrame(),
    [OPEN_WEB.restaurant]: restaurantPage('https://book.example/widget/venue-7'),
    [OPEN_WEB.feeRestaurant]: restaurantPage('https://book.example/widget/venue-8'),
    'https://book.example/widget/venue-7': bookingWidget(false),
    'https://book.example/widget/venue-8': bookingWidget(true),
    [OPEN_WEB.reservation]: reservationPage(),
    [OPEN_WEB.contact]: contactPage('Send'),
    [OPEN_WEB.support]: contactPage('Submit'),
    [OPEN_WEB.review]: reviewPage(),
    [OPEN_WEB.help]: helpPage(),
    'https://chat.example/widget': chatWidget(),
    [OPEN_WEB.account]: accountPage(),
    [OPEN_WEB.overlay]: overlayPage(),
  };
}

/** Starts the fixture's sites, its proxy and a headless Chrome that reaches only them. */
export async function openWebFixture(chromePath: string): Promise<OpenWebFixture> {
  const root = mkdtempSync(join(tmpdir(), 'nanoclaw-open-web-fixture-'));
  const sockets = new Set<Socket>();
  const routes = new Map<string, OpenWebRoute>();
  const requests: OpenWebRequest[] = [];
  const key = (raw: string): string => {
    const url = new URL(raw);
    if (url.protocol !== 'https:') throw new Error('The open-web fixture serves HTTPS addresses only');
    return `${url.host}${url.pathname}`;
  };
  const serve = (url: string, route: OpenWebRoute): void => {
    routes.set(key(url), route);
  };
  for (const [url, route] of Object.entries(openWebPages())) serve(url, route);
  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=shop.example',
    ],
    { stdio: 'ignore' },
  );
  const sites = httpsServer(
    { key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) },
    (incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const request: OpenWebRequest = {
          method: incoming.method ?? 'GET',
          url: `https://${incoming.headers.host ?? ''}${incoming.url ?? '/'}`,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(request);
        const route = routes.get(key(request.url));
        const answer: OpenWebResponse =
          route === undefined
            ? { status: 404, body: '<!doctype html><title>Not found</title><p>Not found</p>' }
            : typeof route === 'string'
              ? { body: route }
              : route(request);
        response.writeHead(answer.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...answer.headers });
        response.end(answer.body ?? '');
      });
    },
  );
  await new Promise<void>((resolve) => sites.listen(0, '127.0.0.1', resolve));
  const address = sites.address();
  if (!address || typeof address === 'string') throw new Error('No fixture TLS address');
  const hosts = (): Set<string> =>
    new Set([...routes.keys()].map((route) => `${route.slice(0, route.indexOf('/'))}:443`));
  const proxy = httpServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  // CONNECT upgrades leave closeAllConnections; retain both ends for teardown.
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  proxy.on('connect', (request, socket, head) => {
    if (!hosts().has(request.url ?? '')) {
      socket.destroy();
      return;
    }
    const upstream = connect(address.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('No fixture proxy address');
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    proxy: { server: `http://127.0.0.1:${proxyAddress.port}` },
    args: ['--ignore-certificate-errors'],
  });
  return {
    browser,
    requests,
    serve,
    async newPage() {
      const page = await browser.newPage();
      // The exact-node handoff must be registered before the page's first document.
      await prepareAuthenticationIsolation(page.context(), true);
      return page;
    },
    async close() {
      await browser.close();
      for (const socket of sockets) socket.destroy();
      sites.closeAllConnections();
      proxy.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => sites.close(() => resolve())),
        new Promise<void>((resolve) => proxy.close(() => resolve())),
      ]);
      rmSync(root, { force: true, recursive: true });
    },
  };
}
