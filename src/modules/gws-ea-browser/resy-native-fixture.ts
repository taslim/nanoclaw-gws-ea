/** Local TLS fixture: no request can reach a real merchant. Component attributes are source-grounded. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { prepareAuthenticationIsolation } from './authentication-submit.js';
export interface ResyFixtureState {
  inventory: Record<string, unknown>;
  details: Record<string, unknown>;
  policy: string[];
  doubleConfirmation?: boolean;
  dueNow?: number;
  partyLabel?: string;
  dateLabel?: string;
  extraTerms?: string;
  bookToken?: string;
  responseToken?: string;
  /** The saved card the checkout selects; `null` when the diner has no card on file, so none shows or is booked. */
  selectedPayment?: number | null;
}
/** A free bar-counter table at L'Artusi, as Resy's own API answers it. */
export function freeResyTable(): ResyFixtureState {
  return {
    inventory: {
      query: { day: '2026-10-17', party_size: 2 },
      results: {
        venues: [
          {
            venue: {
              id: { resy: 25973 },
              name: "L'Artusi",
              currency: { code: 'USD' },
              location: { time_zone: 'EST5EDT' },
            },
            slots: [
              {
                config: { id: 1442725, token: 'opaque-native-slot-token', type: 'Bar Counter' },
                date: { start: '2026-10-17 11:00:00', end: '2026-10-17 12:00:00' },
                size: { min: 2, max: 2 },
                time: { turn: { actual: 3600 } },
                payment: { is_paid: false, cancellation_fee: null, deposit_fee: null, is_add_on_required: false },
                has_add_ons: false,
              },
            ],
          },
        ],
      },
    },
    policy: [],
    details: {
      venue: { id: 25973 },
      user: { id: 72, payment_methods: [{ id: 101, display: '4242' }] },
      config: { double_confirmation: false, add_ons: [] },
      payment: { amounts: { total: 0, items: [] } },
      cancellation: { fee: null, display: { policy: [] } },
      book_token: { value: 'secret-book-token' },
    },
  };
}
export async function resyFixture(
  chromePath: string,
  state: ResyFixtureState,
): Promise<{ browser: Browser; page: Page; submitted: () => number; close: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), 'nanoclaw-resy-fixture-'));
  const sockets = new Set<Socket>();
  let submitted = 0;
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
      '/CN=resy.com',
    ],
    { stdio: 'ignore' },
  );
  const api = httpsServer(
    { key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) },
    (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (request.method === 'OPTIONS') {
        request.resume();
        response.writeHead(204);
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'https://resy.com');
      if (request.headers.host === 'api.resy.com') {
        request.resume();
        response.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/4/find') response.end(JSON.stringify(state.inventory));
        else if (url.pathname === '/3/details') response.end(JSON.stringify(state.details));
        else if (url.pathname === '/2/user') response.end(JSON.stringify({ id: 72 }));
        else if (url.pathname === '/3/book') {
          submitted++;
          response.end(
            JSON.stringify({ reservation_id: 90123, resy_token: state.responseToken ?? 'secret-reservation-bearer' }),
          );
        } else {
          response.writeHead(404);
          response.end('{}');
        }
        return;
      }
      request.resume();
      // The page retries a failed API call once. Chrome on Linux sometimes cancels a CORS-preflighted request
      // while any DevTools Fetch session is enabled, as the host's document gate always is; the retry rides on
      // the preflight Chrome just cached, so every reader test sees Resy's calls arrive.
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><body><div class="SummaryPage"><div class="SummaryPage__ScrollView"><h2 class="ReservationSummary__title">L'Artusi</h2><span class="ReservationSummary__time-slot">${state.dateLabel ?? 'Sat, Oct 17, 2026 11:00 AM'}</span><span class="ReservationSummary__row-text">${state.partyLabel ?? '2 Guests, Bar Counter'}</span><div class="SummaryPage__cancellation"><ul>${state.policy.map((value) => `<li>${value}</li>`).join('')}</ul></div>${state.extraTerms ?? ''}${state.selectedPayment === null ? '' : `<select name="payment_method"><option value="${state.selectedPayment ?? 101}" selected>Credit card ending in 4242</option></select>`}</div><button data-test-id="order_summary_page-button-book">Reserve Now</button><button data-testid="reservation-button-opaque-native-slot-token">11:00 AM Bar Counter</button><button id="unknown">Continue</button></div><script>
(async()=>{const call=(url,init)=>fetch(url,init).catch(()=>fetch(url,init));const post=(path,data)=>call('https://api.resy.com'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(r=>r.json());await post('/4/find',{venue_id:25973,day:'2026-10-17',party_size:2});await call('https://api.resy.com/2/user');await post('/3/details',{commit:1,config_id:'opaque-native-slot-token',day:'2026-10-17',party_size:2});document.body.dataset.ready='yes';document.querySelector('[data-test-id="order_summary_page-button-book"]').onclick=async()=>{const form=new URLSearchParams({book_token:${JSON.stringify(state.bookToken ?? 'secret-book-token')}${state.selectedPayment === null ? '' : `,struct_payment_method:JSON.stringify({id:${state.selectedPayment ?? 101}})`}});const optIn=document.querySelector('input[name="venue_marketing_opt_in"]');if(optIn)form.set('venue_marketing_opt_in',optIn.checked?'1':'0');await fetch('https://api.resy.com/3/book',{method:'POST',body:form});document.body.innerHTML='<div class="ConfirmationPage"><div class="ConfirmationPage__header">Reservation Booked.</div><button data-test-id="confirmation_summary_page-button-done">Done</button></div>';};})();
</script></body></html>`);
    },
  );
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('No fixture TLS address');
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
    if (!['resy.com:443', 'widgets.resy.com:443', 'api.resy.com:443'].includes(request.url ?? '')) {
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
  const page = await browser.newPage();
  // Classification reads each control in an isolated world, through the handoff a job context registers.
  await prepareAuthenticationIsolation(page.context(), true);
  return {
    browser,
    page,
    submitted: () => submitted,
    async close() {
      await browser.close();
      for (const socket of sockets) socket.destroy();
      api.closeAllConnections();
      proxy.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => api.close(() => resolve())),
        new Promise<void>((resolve) => proxy.close(() => resolve())),
      ]);
      rmSync(root, { force: true, recursive: true });
    },
  };
}
