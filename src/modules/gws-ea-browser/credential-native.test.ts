/**
 * Real owned Chrome, background windows and TLS origins for authorized signup
 * and password changes; all traffic terminates in this fixture, and 1Password
 * is the SDK fake. Generated passwords are read back only from that fake.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@1password/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@1password/sdk')>()),
  createClient: sdk.create,
}));
const dataRoot = await vi.hoisted(async () => {
  const { tmpdir: temporary } = await import('node:os');
  const { join: joined } = await import('node:path');
  return joined(temporary(), 'browser-credential-native-data');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: dataRoot,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
/** When set, a click that ran is reported as the renderer would after losing its answer. */
const clicks = vi.hoisted(() => ({ lostAnswer: false }));
vi.mock('./authentication-submit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./authentication-submit.js')>();
  return {
    ...actual,
    activateNativeCredentialControl: async (
      ...args: Parameters<typeof actual.activateNativeCredentialControl>
    ): ReturnType<typeof actual.activateNativeCredentialControl> => {
      const activation = await actual.activateNativeCredentialControl(...args);
      return clicks.lostAnswer && activation === 'activated' ? 'uncertain' : activation;
    },
  };
});

import { closeDb, getDb, initSqliteTestDb } from '../../db/connection.js';
import { createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import '../gws-ea-profile/index.js';
import { routeSignInMail } from '../gws-ea-inbox/route-mail.js';
import { parseGmailMessage } from '../gws-ea-inbox/mime.js';
import { gwsEaInboxMigration } from '../gws-ea-inbox/migration.js';
import { setActiveInbox, type InboxRuntime } from '../gws-ea-inbox/runtime.js';
import { prepareAuthenticationIsolation } from './authentication-submit.js';
import { ensureBrowserNavigationGuard } from './commit-classifier.js';
import { prepareChromeProfile, spawnChrome } from './chrome.js';
import { connectChrome, type ChromeConnection } from './connection.js';
import { CredentialAttempts, type CredentialAttempt } from './credential-attempts.js';
import { executeCredentialForm, recoverCredentialAttempts } from './credential-operations.js';
import { recordConsentGrant } from './consent.js';
import { executeBrowserBatch } from './executor.js';

import './index.js';
import {
  browserConsentMigration,
  browserCredentialAttemptsMigration,
  browserCredentialConsentHoldMigration,
  browserCredentialUncertaintyMigration,
  browserSiteLeasesMigration,
} from './migration.js';
import { observePage, type BrowserRef } from './observe.js';
import { BrowserVault } from './onepassword.js';
import {
  FakeOnePassword,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_SIGN_IN_ADDRESS,
  writeVaultFixture,
} from './onepassword-fixture.js';
import { writeOnePasswordHostPolicy } from './onepassword-policy.js';
import { browserPaths } from './paths.js';
import type { BrowserExecutionContext } from './actions.js';
import { answerSignInReply, recoverBrowserSignInMail } from './sign-in-mail.js';
import { siteWordingPattern } from './testing/site-wording.js';

registerMigration(gwsEaInboxMigration);

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
const JOB = 'system:a2a:main:native-credential-job';
const SITE = 'https://accounts.shop.example';
const USERNAME = 'morgan.ellery@example.com';

const field = (label: string, name: string, type: string, autocomplete: string): string =>
  `<label>${label} <input type="${type}" name="${name}" autocomplete="${autocomplete}"></label>`;
const signupFields = `${field('Email', 'email', 'email', 'email')}${field('Password', 'password', 'password', 'new-password')}${field('Confirm password', 'password_confirmation', 'password', 'new-password')}`;
const nativeForm = (action: string, button = 'Create account', extra = ''): string =>
  `<h1>Join</h1><form method="post" action="${action}">${signupFields}${extra}<button type="submit">${button}</button></form><p>Password must be at least 12 characters.</p>`;
const checkbox = (name: string, label: string, required: string): string =>
  `<label><input type="checkbox" name="${name}"${required}> ${label}</label>`;
const WAIVER = 'I have read and accept the liability waiver';
/**
 * A form's own reaction to the password reaching it: `run` with `box(name, label)`, which adds an unticked box
 * with that label before the submit control, or finds and unticks the one added before.
 */
const onFill = (run: string): string => `<script>
  const form = document.querySelector('form');
  const box = (name, label) => {
    let input = form.querySelector('[name=' + name + ']');
    if (!input) {
      const wrapper = document.createElement('label');
      input = document.createElement('input');
      input.type = 'checkbox';
      input.name = name;
      wrapper.append(input, ' ' + label);
      form.insertBefore(wrapper, form.querySelector('button'));
    }
    input.checked = false;
    return input;
  };
  form.querySelector('[name=password]').addEventListener('input', (event) => { if (event.target.value) { ${run} } });
</script>`;
/** A React-like controlled form: state changes only on input events whose value its own tracker has not seen. */
const controlled = (submit: string, endpoint = '/api/signup'): string => `<div id="result"></div><script>
  const state = {};
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const go = document.getElementById('go');
  for (const input of document.querySelectorAll('input')) {
    let tracked = '';
    Object.defineProperty(input, 'value', { configurable: true,
      get() { return proto.get.call(this); }, set(value) { tracked = value; proto.set.call(this, value); } });
    input.addEventListener('input', () => {
      window.credentialCallback && window.credentialCallback();
      const current = proto.get.call(input);
      if (current === tracked) return;
      tracked = current;
      state[input.name] = current;
      setTimeout(() => { go.disabled = !(state.email && state.password); go.setAttribute('aria-disabled', String(go.disabled)); }, 150);
    });
  }
  const send = () => fetch('${endpoint}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) })
    .then((response) => response.text()).then((html) => { document.getElementById('result').innerHTML = html; });
  ${submit}
</script>`;
const noFormSignup = `<h1>Join</h1><div>${field('Email', 'email', 'email', 'email')}${field('Password', 'password', 'password', 'new-password')}<div role="button" tabindex="0" id="go">Create account</div></div>${controlled(
  "go.addEventListener('click', () => { if (go.getAttribute('aria-disabled') !== 'true') send(); });",
)}`;
/** A formless page's own handler that sends every field on it, as a whole-page save does. */
const sendsEveryField = (endpoint: string): string => `<div id="result"></div><script>
  document.getElementById('go').addEventListener('click', () => {
    const body = Object.fromEntries(Array.from(document.querySelectorAll('input'), (input) => [input.name, input.value]));
    fetch('${endpoint}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((response) => response.text()).then((html) => { document.getElementById('result').innerHTML = html; });
  });
</script>`;
const noFormChange = (extra = ''): string =>
  `<h1>Security</h1><div>${field('Current password', 'current_password', 'password', 'current-password')}${field('New password', 'new_password', 'password', 'new-password')}${extra}<div role="button" tabindex="0" id="go">Change password</div></div>${sendsEveryField('/api/change-password')}`;
const PAGES: Record<string, string> = {
  '/native-signup': nativeForm('/signup'),
  '/js-signup': `<h1>Join</h1><form id="join">${signupFields}<button id="go" type="submit" disabled>Create account</button></form>${controlled(
    "document.getElementById('join').addEventListener('submit', (event) => { event.preventDefault(); send(); });",
  )}`,
  '/no-form-signup': noFormSignup,
  '/no-form-join': `<h1>Join</h1><div>${field('Email', 'email', 'email', 'email')}${field('Password', 'password', 'password', 'new-password')}<div role="button" tabindex="0" id="go">Create account</div></div>${sendsEveryField('/api/signup')}`,
  '/checkout/join': noFormSignup,
  '/multi-step': `<h1>Join</h1><form method="post" action="/signup/email">${field('Email', 'email', 'email', 'username')}<button type="submit">Continue</button></form>`,
  '/masking': `<h1>Join</h1><form id="join">${signupFields}<button id="go" type="submit">Create account</button></form><input name="notes" aria-label="Notes"><div id="echo"></div>${controlled(
    `document.querySelector('[name=password]').addEventListener('input', (event) => {
      event.target.type = 'text';
      document.getElementById('echo').textContent = 'You typed ' + event.target.value;
      document.querySelector('[name=notes]').value = event.target.value;
    });
    document.getElementById('join').addEventListener('submit', (event) => { event.preventDefault(); send(); });`,
  )}`,
  '/prefilled': `<h1>Join</h1><label>Confirm password <input type="text" name="confirm_password" value="page-chosen-secret-value"></label>`,
  '/change': `<h1>Security</h1><form method="post" action="/account/change-password">${field('Current password', 'current_password', 'password', 'current-password')}${field('New password', 'new_password', 'password', 'new-password')}${field('Confirm new password', 'confirm_password', 'password', 'new-password')}<button type="submit">Change password</button></form>`,
  '/change-shown-account': `<h1>Security</h1><form method="post" action="/account/change-password"><label>Account <input type="email" name="email" autocomplete="username" value="${USERNAME}" readonly></label>${field('Current password', 'current_password', 'password', 'current-password')}${field('New password', 'new_password', 'password', 'new-password')}${field('Confirm new password', 'confirm_password', 'password', 'new-password')}<button type="submit">Change password</button></form>`,
  '/change-with-email': `<h1>Security</h1><form method="post" action="/account/change-password">${field('Current password', 'current_password', 'password', 'current-password')}${field('New password', 'new_password', 'password', 'new-password')}${field('Recovery email', 'recovery_email', 'email', 'email')}<button type="submit">Change password</button></form>`,
  '/no-form-change': noFormChange(),
  '/no-form-change-with-email': noFormChange(field('Recovery email', 'recovery_email', 'email', 'email')),
  '/change-email': `<h1>Security</h1><form method="post" action="/account/change-password">${field('Current password', 'current_password', 'password', 'current-password')}${field('New password', 'new_password', 'password', 'new-password')}<button type="submit">Update email</button></form>`,
  '/offsite-action': nativeForm('https://collector.example/signup'),
  '/http-action': nativeForm('http://accounts.shop.example/signup'),
  '/checkout-action': nativeForm('/checkout/subscribe'),
  '/trial': nativeForm('/signup', 'Start free trial'),
  '/order-total': `${nativeForm('/signup')}<p>Order total $10.00 due today, charged to your Visa card ending 4242.</p>`,
  '/ambiguous': nativeForm('/signup', 'Go'),
  '/get-signup': nativeForm('/signup').replace('method="post"', 'method="get"'),
  '/marketing-terms': nativeForm(
    '/signup',
    'Create account',
    checkbox('consent', 'I agree to the Terms and to receive marketing emails', ' required'),
  ),
  '/offers-signup': nativeForm(
    '/signup',
    'Create account',
    `${checkbox('terms', 'I agree to the Terms of Service', ' required')}${checkbox('news', 'Send me news and special offers', ' checked')}`,
  ),
  '/js-terms': `<h1>Join</h1><form id="join">${signupFields}${checkbox('terms', 'I agree to the Terms of Service', ' aria-required="true"')}<button id="go" type="submit" disabled>Create account</button></form><div id="result"></div><script>
    const state = {};
    const go = document.getElementById('go');
    const refresh = () => setTimeout(() => { go.disabled = !(state.email && state.password && state.terms); }, 100);
    for (const input of document.querySelectorAll('input:not([type=checkbox])'))
      input.addEventListener('input', () => { state[input.name] = input.value; refresh(); });
    const terms = document.querySelector('[name=terms]');
    terms.addEventListener('change', () => { state.terms = terms.checked; refresh(); });
    document.getElementById('join').addEventListener('submit', (event) => {
      event.preventDefault();
      fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) })
        .then((response) => response.text()).then((html) => { document.getElementById('result').innerHTML = html; });
    });
  </script>`,
  '/agree-signup': nativeForm('/signup', 'Agree and create account'),
  // Each fill resets a box only the principal can agree to: the form shows it, unticked, once a password is typed.
  '/waiver-on-fill': `${nativeForm('/signup')}${onFill(`box('waiver', '${WAIVER}');`)}`,
  // The fill also moves the page to a new address, as a single-page app's router does.
  '/waiver-and-submit-on-fill': `${nativeForm('/signup')}${onFill(`box('waiver', '${WAIVER}'); window.callbackSubmission = fetch('/api/signup', { method: 'POST', body: new URLSearchParams(new FormData(form)) }).catch(() => {}); window.submitFilledForm = () => fetch('/api/signup', { method: 'POST', body: new URLSearchParams(new FormData(form)) }).catch(() => {});`)}`,
  '/waiver-and-get-on-fill': `${nativeForm('/signup')}${onFill(`box('waiver', '${WAIVER}'); const send = () => fetch('/callback-signup?data=' + encodeURIComponent(new URLSearchParams(new FormData(form)).toString())).catch(() => {}); window.callbackSubmission = send(); window.submitFilledForm = send;`)}`,
  '/waiver-document-submit-on-fill': `${nativeForm('/signup')}${onFill(`box('waiver', '${WAIVER}'); form.requestSubmit();`)}`,
  '/waiver-and-route-on-fill': `${nativeForm('/signup')}${onFill(`box('waiver', '${WAIVER}'); history.pushState({}, '', '/join/password');`)}`,
  // After the fill the page ticks an offers box again whenever the host unticks it.
  '/offers-on-fill': `${nativeForm('/signup')}${onFill(`const offers = box('offers', 'Send me news and special offers'); offers.checked = true; offers.addEventListener('change', () => { if (!offers.checked) setTimeout(() => { offers.checked = true; }, 20); });`)}`,
  // After the fill the page adds a paid extra it keeps.
  '/donation-on-fill': `${nativeForm('/signup')}${onFill(`const gift = box('donation', 'Add a $1 donation to the Food Bank'); gift.required = true; gift.checked = true;`)}`,
  '/agree-money': `${nativeForm('/signup', 'Agree and create account')}<p>Premium is $9.99 per month after you join.</p>`,
  '/agree-outside': `<h1>Join</h1><form method="post" action="/signup">${signupFields}</form><div role="button" tabindex="0" id="go">Agree and create account</div><script>
    document.getElementById('go').addEventListener('click', () => document.querySelector('form').requestSubmit());
  </script>`,
  '/slow-js-signup': `<h1>Join</h1><form id="join">${signupFields}<button id="go" type="submit" disabled>Create account</button></form>${controlled(
    "document.getElementById('join').addEventListener('submit', (event) => { event.preventDefault(); send(); });",
    '/api/slow-signup',
  )}`,
  '/verify-email': '<h1>Your email has been verified.</h1><p>Your account is ready.</p>',
  '/verify-email-quiet': '<h1>Shop</h1><p>Browse the catalogue.</p>',
};

describe.skipIf(!chromePath)('native authorized signup and password change', { timeout: 30_000 }, () => {
  let root: string;
  let proxy: HttpServer;
  let server: HttpsServer;
  let connection: ChromeConnection;
  let page: Page;
  let certificateSession: CDPSession;
  let fake: FakeOnePassword;
  let attempts: CredentialAttempts;
  let vault: BrowserVault;
  let onePasswordPolicyFile: string;
  let remaining = 20_000;
  const sockets = new Set<Socket>();
  const posts: Array<{ host: string; path: string; body: string }> = [];
  const addresses: string[] = [];
  const responses = new Map<string, string>();
  /** Answers to `/api/slow-*`, held until the test releases them: a response that arrives after the host stopped waiting. */
  const held: Array<() => void> = [];
  const answerSlow = (): void => {
    for (const answer of held.splice(0)) answer();
  };
  let accountPassword: string | undefined;
  let callbackPhases: Array<string | undefined>;

  beforeAll(async () => {
    if (!chromePath) throw new Error('Native Chrome path required');
    root = await realpath(await mkdtemp(join(tmpdir(), 'browser-credential-native-')));
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
        '/CN=accounts.shop.example',
      ],
      { stdio: 'ignore' },
    );
    server = createHttpsServer(
      { key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) },
      (request, response) => {
        const host = request.headers.host ?? '';
        const path = new URL(request.url ?? '/', `https://${host}`).pathname;
        const html = (body: string): void => {
          response.writeHead(200, { 'content-type': 'text/html' }).end(body);
        };
        // This site's signup endpoint mutates on GET, so HTTP method alone cannot prove a read.
        if (path === '/callback-signup') {
          posts.push({
            host,
            path,
            body: new URL(request.url ?? '/', `https://${host}`).searchParams.get('data') ?? '',
          });
          html('<h1>Account created</h1>');
          return;
        }
        if (request.method !== 'POST') {
          addresses.push(`${host}${request.url ?? ''}`);
          if (path === '/verify-away') {
            response.writeHead(302, { location: 'https://collector.example/landing' }).end();
            return;
          }
          if (host === 'parent.example')
            html(
              `<input id="untrusted" aria-label="Untrusted"><iframe src="${SITE}${({ '/get': '/get-signup', '/waiver': '/waiver-on-fill', '/waiver-submit': '/waiver-and-submit-on-fill' } as Record<string, string>)[path] ?? '/native-signup'}"></iframe><script>document.querySelector('input').addEventListener('input', e => { document.body.dataset.captured = e.target.value; });addEventListener('message', e => { if (e.data === 'steal-focus') { document.querySelector('input').focus(); document.body.dataset.stolen = 'yes'; } });</script>`,
            );
          else html(PAGES[path] ?? '<h1>Not found</h1>');
          return;
        }
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on('end', () => {
          posts.push({ host, path, body });
          if (path.startsWith('/api/slow-')) held.push(() => html(responses.get(path) ?? '<h1>Account created</h1>'));
          else if (path === '/signup/email')
            html(
              `<h1>Choose a password</h1><form method="post" action="/signup/password">${field('Password', 'password', 'password', 'new-password')}${field('Confirm password', 'confirm', 'password', 'new-password')}<button type="submit">Create account</button></form>`,
            );
          else if (path === '/account/change-password' || path === '/api/change-password') {
            const native = path === '/account/change-password';
            const sent = new URLSearchParams(native ? body : (JSON.parse(body) as Record<string, string>));
            if (sent.get('current_password') !== accountPassword)
              html(`<p>Current password is incorrect.</p>${native ? PAGES['/change'] : ''}`);
            else {
              accountPassword = sent.get('new_password') ?? undefined;
              html(responses.get(path) ?? '<h1>Your password has been changed.</h1>');
            }
          } else html(responses.get(path) ?? '<h1>Account created</h1><a href="/logout">Sign out</a>');
        });
      },
    );
    server.on('upgrade', (request, socket) => {
      const key = request.headers['sec-websocket-key'];
      if (request.url !== '/socket-signup' || typeof key !== 'string') {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const answer = (text: string): void => {
        socket.write(Buffer.concat([Buffer.from([0x81, Buffer.byteLength(text)]), Buffer.from(text)]));
      };
      // This fixture speaks only short, masked text frames; Chrome may split their bytes across packets.
      let buffered: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 2) {
          const length = buffered[1] & 0x7f;
          if (buffered[0] !== 0x81 || !(buffered[1] & 0x80) || length > 125) {
            socket.destroy();
            return;
          }
          if (buffered.length < length + 6) return;
          const mask = buffered.subarray(2, 6);
          const body = Buffer.from(buffered.subarray(6, length + 6));
          for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
          buffered = buffered.subarray(length + 6);
          posts.push({ host: request.headers.host ?? '', path: '/socket-signup', body: body.toString() });
          answer('recorded');
          held.push(() => answer('created'));
        }
      });
      socket.on('error', () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TLS fixture did not bind');
    proxy = createHttpServer((_request, response) => {
      response.writeHead(403).end();
    });
    proxy.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    proxy.on('connect', (request, socket, head) => {
      if (!['accounts.shop.example:443', 'parent.example:443', 'collector.example:443'].includes(request.url ?? '')) {
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
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Proxy fixture did not bind');
    const paths = browserPaths(join(root, 'browser', 'policy.json'));
    await prepareChromeProfile(paths);
    connection = await connectChrome(
      await spawnChrome({ chromePath, paths, proxyUrl: `http://127.0.0.1:${proxyAddress.port}` }),
      paths,
    );
    await prepareAuthenticationIsolation(connection.context);
  }, 30_000);

  beforeEach(async () => {
    const db = await initSqliteTestDb();
    await browserSiteLeasesMigration.up(db);
    await browserCredentialAttemptsMigration.up(db);
    await browserCredentialConsentHoldMigration.up(db);
    await browserCredentialUncertaintyMigration.up(db);
    // Consent stops name their job; this suite's job needs no other row.
    await db.exec(
      `CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('${JOB}');`,
    );
    await browserConsentMigration.up(db);
    const directory = await realpath(await mkdtemp(join(root, 'vault-')));
    const files = await writeVaultFixture(directory);
    onePasswordPolicyFile = files.onePasswordPolicyFile;
    vault = new BrowserVault(files);
    fake = new FakeOnePassword();
    sdk.create.mockReset();
    sdk.create.mockImplementation(async () => fake.client());
    attempts = new CredentialAttempts({ db: getDb(), vault });
    posts.length = 0;
    addresses.length = 0;
    responses.clear();
    accountPassword = undefined;
    remaining = 20_000;
    callbackPhases = [];
    clicks.lostAnswer = false;
    const appeared = connection.context.waitForEvent('page');
    await connection.session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
    page = await appeared;
    certificateSession = await connection.context.newCDPSession(page);
    await certificateSession.send('Security.setIgnoreCertificateErrors', { ignore: true });
  });
  afterEach(async () => {
    answerSlow();
    vi.restoreAllMocks();
    // A step that closed the job's window took its session with it.
    if (!page?.isClosed()) await certificateSession?.detach();
    await page?.close();
    await closeDb();
  });
  afterAll(async () => {
    await connection?.close();
    for (const socket of sockets) socket.destroy();
    server?.closeAllConnections();
    proxy?.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server?.close(() => resolve())),
      new Promise<void>((resolve) => proxy?.close(() => resolve())),
    ]);
    if (root) await rm(root, { recursive: true, force: true });
  });

  function context(): BrowserExecutionContext {
    return {
      page: async () => page,
      assertActive: async () => undefined,
      runtime: { closeJob: async () => page.close() },
      job: { id: JOB },
      request: { id: 'native-credential-request' },
      store: { db: getDb() },
      signal: new AbortController().signal,
      remaining: () => remaining,
      wakeWaiters: async () => undefined,
    } as unknown as BrowserExecutionContext;
  }

  /** The current observation's refs for these accessible names, as the browser agent would read them. */
  async function refs(names: Record<string, string>): Promise<Record<string, BrowserRef>> {
    const { snapshot, generation } = await observePage(page);
    return Object.fromEntries(
      Object.entries(names).map(([key, name]) => {
        const line = snapshot
          .split('\n')
          .find((candidate) => candidate.includes(`"${name}"`) && candidate.includes('[ref='));
        const ref = line?.match(/\[ref=([a-z0-9]+)\]/u)?.[1];
        if (!ref) throw new Error(`No ref for ${name} in:\n${snapshot}`);
        return [key, { ref, generation }];
      }),
    );
  }

  async function signupAuthority(): Promise<CredentialAttempt> {
    const prepared = await attempts.prepareSignup({ jobId: JOB, origin: SITE, username: USERNAME });
    if (prepared.status !== 'prepared') throw new Error(prepared.status);
    return prepared.attempt;
  }

  const fill = (authority: CredentialAttempt, fields: Record<string, BrowserRef>) =>
    executeCredentialForm(context(), { authority: authority.id, ...fields }, { attempts });

  /** The generated password the vault holds for an attempt: the only place the test may read it. */
  async function candidatePassword(id: string): Promise<string> {
    const attempt = await attempts.get(id);
    const password = attempt?.candidate_item_id ? fake.value(attempt.candidate_item_id, 'password') : undefined;
    if (!password) throw new Error('no candidate');
    return password;
  }

  async function signUp(path: string, names: Record<string, string>) {
    await page.goto(`${SITE}${path}`);
    const authority = await signupAuthority();
    const result = await fill(authority, await refs(names));
    return { authority, result, password: await candidatePassword(authority.id).catch(() => undefined) };
  }

  const SIGNUP = {
    username: 'Email',
    new_password: 'Password',
    confirmation: 'Confirm password',
    activate: 'Create account',
  };

  describe('signing up', () => {
    it('saves first, then fills one candidate into a native form and submits it natively', async () => {
      const { authority, result, password } = await signUp('/native-signup', SIGNUP);
      expect(result).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts).toEqual([
        {
          host: 'accounts.shop.example',
          path: '/signup',
          body: new URLSearchParams({
            email: USERNAME,
            password: password!,
            password_confirmation: password!,
          }).toString(),
        },
      ]);
      const finalized = await attempts.get(authority.id);
      expect(finalized).toMatchObject({ phase: 'finalized', owned_item_id: finalized?.candidate_item_id });
      expect(JSON.stringify(result)).not.toContain(password);
      expect(JSON.stringify(finalized)).not.toContain(password);
    }, 30_000);

    it('drives a controlled JS form through its own input callbacks, recording exposure before the first one', async () => {
      await page.exposeFunction('credentialCallback', async () => {
        const [attempt] = await attempts.unresolved();
        callbackPhases.push(attempt?.phase);
      });
      const { result, password } = await signUp('/js-signup', SIGNUP);
      expect(result).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts).toEqual([
        {
          host: 'accounts.shop.example',
          path: '/api/signup',
          body: JSON.stringify({ email: USERNAME, password, password_confirmation: password }),
        },
      ]);
      expect(callbackPhases.length).toBeGreaterThan(0);
      expect(callbackPhases.every((phase) => phase === 'exposed' || phase === 'awaiting_verification')).toBe(true);
    }, 30_000);

    it('activates a no-form JS control by its own node', async () => {
      const { result, password } = await signUp('/no-form-signup', {
        username: 'Email',
        new_password: 'Password',
        activate: 'Create account',
      });
      expect(result).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts).toEqual([
        { host: 'accounts.shop.example', path: '/api/signup', body: JSON.stringify({ email: USERNAME, password }) },
      ]);
    }, 30_000);

    for (const [held, what] of [
      ['', 'nothing'],
      [USERNAME.toUpperCase(), "the account's address"],
    ] as const)
      it(`signs up on a formless page whose unbound email field holds ${what}`, async () => {
        await page.goto(`${SITE}/no-form-join`);
        await page.locator('[name=email]').fill(held);
        const authority = await signupAuthority();
        expect(await fill(authority, await refs({ new_password: 'Password', activate: 'Create account' }))).toEqual({
          status: 'account_created',
          vault: 'saved',
        });
        const password = await candidatePassword(authority.id);
        expect(posts).toEqual([
          { host: 'accounts.shop.example', path: '/api/signup', body: JSON.stringify({ email: held, password }) },
        ]);
      }, 30_000);

    it('completes a multi-step signup with fresh refs per step and one candidate disclosed once', async () => {
      await page.goto(`${SITE}/multi-step`);
      const authority = await signupAuthority();
      expect(await fill(authority, await refs({ username: 'Email', activate: 'Continue' }))).toEqual({
        status: 'continued',
      });
      // Nothing was generated or disclosed for the username step.
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'preparing', candidate_item_id: null });
      expect(fake.calls).not.toContain('create');
      expect(
        await fill(
          authority,
          await refs({ new_password: 'Password', confirmation: 'Confirm password', activate: 'Create account' }),
        ),
      ).toEqual({ status: 'account_created', vault: 'saved' });
      const password = await candidatePassword(authority.id);
      expect(posts.map((post) => [post.path, post.body])).toEqual([
        ['/signup/email', new URLSearchParams({ email: USERNAME }).toString()],
        ['/signup/password', new URLSearchParams({ password, confirm: password }).toString()],
      ]);
      expect(fake.calls.filter((call) => call === 'create')).toHaveLength(1);
    }, 30_000);
  });

  describe('changing a password', () => {
    /** A Login the host saved through a finished signup, and the site holding its password. */
    async function ownedAccount(): Promise<{ itemId: string; handle: string }> {
      const signup = await signupAuthority();
      await attempts.save(signup.id);
      await attempts.disclose(signup.id, { jobId: JOB, origin: SITE });
      await attempts.markAwaitingVerification(signup.id);
      await attempts.markConfirmed(signup.id, { signal: 'fixture' });
      const finalized = await attempts.finalize(signup.id);
      if (finalized.status !== 'finalized' || !finalized.attempt.owned_item_id) throw new Error('not owned');
      const itemId = finalized.attempt.owned_item_id;
      accountPassword = fake.value(itemId, 'password');
      const found = await attempts.ownedHandle(SITE, USERNAME);
      if (found.status !== 'found') throw new Error(found.status);
      return { itemId, handle: found.itemHandle };
    }
    async function changeAuthority(handle: string): Promise<CredentialAttempt> {
      const prepared = await attempts.prepareRotation({ jobId: JOB, origin: SITE, itemHandle: handle });
      if (prepared.status !== 'prepared') throw new Error(prepared.status);
      return prepared.attempt;
    }
    const CHANGE = {
      current_password: 'Current password',
      new_password: 'New password',
      confirmation: 'Confirm new password',
      activate: 'Change password',
    };
    const NO_FORM_CHANGE = {
      current_password: 'Current password',
      new_password: 'New password',
      activate: 'Change password',
    };

    it('fills current, new and confirmation from one saved candidate and writes the new password into the login', async () => {
      const { itemId, handle } = await ownedAccount();
      const original = accountPassword;
      const authority = await changeAuthority(handle);
      await page.goto(`${SITE}/change`);
      const result = await fill(authority, await refs(CHANGE));
      expect(result).toEqual({ status: 'password_changed', vault: 'updated' });
      const next = fake.value(itemId, 'password');
      if (next === undefined) throw new Error('no password');
      expect(posts).toEqual([
        {
          host: 'accounts.shop.example',
          path: '/account/change-password',
          body: new URLSearchParams({
            current_password: original!,
            new_password: next,
            confirm_password: next,
          }).toString(),
        },
      ]);
      expect(accountPassword).toBe(next);
      // One login holds the site's new password; the candidate and the old password are gone, and neither reaches a tool result.
      expect(next).not.toBe(original);
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'finalized', owned_item_id: itemId });
      expect([...fake.items.keys()]).toEqual([itemId]);
      expect(fake.concealed()).toEqual([next]);
      for (const value of [original!, next]) expect(JSON.stringify(result)).not.toContain(value);
    }, 30_000);

    it('accepts a change form that only displays the account read-only, and never writes to it', async () => {
      const { itemId, handle } = await ownedAccount();
      const authority = await changeAuthority(handle);
      await page.goto(`${SITE}/change-shown-account`);
      expect(await fill(authority, await refs(CHANGE))).toEqual({ status: 'password_changed', vault: 'updated' });
      expect(new URLSearchParams(posts[0]?.body).get('email')).toBe(USERNAME);
      expect(accountPassword).toBe(fake.value(itemId, 'password'));
    }, 30_000);

    it('covers AE7 at the page: a Login edited after delegation is refused before any insertion', async () => {
      const { itemId, handle } = await ownedAccount();
      const authority = await changeAuthority(handle);
      fake.edit(itemId, (item) => ({
        ...item,
        fields: item.fields.map((entry) =>
          entry.id === 'username' ? { ...entry, value: 'remy.vance@example.com' } : entry,
        ),
      }));
      await page.goto(`${SITE}/change`);
      expect(await fill(authority, await refs(CHANGE))).toEqual({ status: 'not_owned' });
      expect(posts).toEqual([]);
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'rejected', exposed_at: null });
      expect(await page.locator('input[name=current_password]').inputValue()).toBe('');
    }, 30_000);

    for (const modification of ['password edit', 'removal'] as const)
      it(`keeps an exposed change uncertain after source Login ${modification} without deleting its candidate`, async () => {
        const { itemId, handle } = await ownedAccount();
        const authority = await changeAuthority(handle);
        await page.goto(`${SITE}/change`);
        await page.evaluate(`(() => {
          const label = ${JSON.stringify(WAIVER)};
          document.querySelector('[name=new_password]')?.addEventListener('input', () => {
            if (document.querySelector('[name=waiver]')) return;
            const wrapper = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.name = 'waiver';
            wrapper.append(input, label);
            document.querySelector('form')?.append(wrapper);
          });
        })()`);
        expect(await fill(authority, await refs(CHANGE))).toMatchObject({ reason: 'consent_required' });
        const held = await attempts.get(authority.id);
        expect(held?.phase).toBe('unknown');
        const stop = await getDb().get<{ site: string; origin: string; wording: string }>(
          'SELECT site, origin, wording FROM gws_ea_browser_consent_stops WHERE job_id = ?',
          JOB,
        );
        if (!stop || !held?.candidate_item_id) throw new Error('Missing held credential evidence');
        await recordConsentGrant(getDb(), {
          ...stop,
          approvalId: 'approval-rotation',
          principalUserId: 'gchat:users/principal',
        });
        if (modification === 'removal') fake.items.delete(itemId);
        else
          fake.edit(itemId, (item) => ({
            ...item,
            fields: item.fields.map((entry) =>
              entry.id === 'password' ? { ...entry, value: 'principal-new-password' } : entry,
            ),
          }));
        expect(await fill(authority, await refs(CHANGE))).toEqual({ status: 'outcome_unknown' });
        expect(await attempts.get(authority.id)).toMatchObject({
          phase: 'unknown',
          candidate_item_id: held.candidate_item_id,
        });
        expect(fake.items.has(held.candidate_item_id)).toBe(true);
        expect(posts).toEqual([]);
      }, 30_000);

    it('reports a rejected current password as rejected, never as a change', async () => {
      const { handle } = await ownedAccount();
      const authority = await changeAuthority(handle);
      accountPassword = 'the-site-holds-something-else';
      await page.goto(`${SITE}/change`);
      expect(await fill(authority, await refs(CHANGE))).toEqual({ status: 'current_password_rejected' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'rejected' });
    }, 30_000);

    it('changes the password on a formless page whose only editable fields are the bound ones', async () => {
      const { itemId, handle } = await ownedAccount();
      const original = accountPassword;
      const authority = await changeAuthority(handle);
      await page.goto(`${SITE}/no-form-change`);
      expect(await fill(authority, await refs(NO_FORM_CHANGE))).toEqual({
        status: 'password_changed',
        vault: 'updated',
      });
      const next = fake.value(itemId, 'password');
      expect(posts).toEqual([
        {
          host: 'accounts.shop.example',
          path: '/api/change-password',
          body: JSON.stringify({ current_password: original, new_password: next }),
        },
      ]);
      expect(accountPassword).toBe(next);
    }, 30_000);

    it('reports a change the site confirms beside its notice that it emailed the account', async () => {
      const { handle } = await ownedAccount();
      const authority = await changeAuthority(handle);
      responses.set(
        '/account/change-password',
        '<h1>Your password has been changed.</h1><p>We sent you an email to let you know.</p>',
      );
      await page.goto(`${SITE}/change`);
      expect(await fill(authority, await refs(CHANGE))).toEqual({ status: 'password_changed', vault: 'updated' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'finalized' });
    }, 30_000);

    for (const [path, names] of [
      [
        '/change-with-email',
        { current_password: 'Current password', new_password: 'New password', activate: 'Change password' },
      ],
      ['/no-form-change-with-email', NO_FORM_CHANGE],
      [
        '/change-email',
        { current_password: 'Current password', new_password: 'New password', activate: 'Update email' },
      ],
    ] as const)
      it(`refuses ${path}: sign-in email and other security changes stay refused on an assistant-owned account`, async () => {
        const { handle } = await ownedAccount();
        const authority = await changeAuthority(handle);
        await page.goto(`${SITE}${path}`);
        expect(await fill(authority, await refs(names))).toEqual({ status: 'refused', reason: 'account_security' });
        expect(posts).toEqual([]);
        expect(await attempts.get(authority.id)).toMatchObject({ phase: 'preparing', exposed_at: null });
      }, 30_000);
  });

  describe('refusing before disclosure', () => {
    const unexposed = async (authority: CredentialAttempt): Promise<void> => {
      expect(posts).toEqual([]);
      expect(await attempts.get(authority.id)).toMatchObject({ exposed_at: null });
    };

    for (const [path, reason] of [
      ['/offsite-action', 'unsupported_form'],
      ['/http-action', 'blocked_address'],
      ['/checkout-action', 'purchase_control'],
      ['/trial', 'purchase_control'],
      ['/order-total', 'unsupported_control'],
      ['/ambiguous', 'unsupported_control'],
    ] as const)
      it(`refuses ${path} as ${reason}`, async () => {
        await page.goto(`${SITE}${path}`);
        const authority = await signupAuthority();
        const activate = path === '/trial' ? 'Start free trial' : path === '/ambiguous' ? 'Go' : 'Create account';
        expect(await fill(authority, await refs({ ...SIGNUP, activate }))).toEqual({ status: 'refused', reason });
        await unexposed(authority);
        expect(fake.calls).not.toContain('create');
      }, 30_000);

    it('refuses a signup whose account field is left unbound, since the Login would name another account', async () => {
      await page.goto(`${SITE}/native-signup`);
      const authority = await signupAuthority();
      const { username: _unbound, ...withoutUsername } = SIGNUP;
      expect(await fill(authority, await refs(withoutUsername))).toEqual({
        status: 'refused',
        reason: 'unsupported_form',
      });
      await unexposed(authority);
      expect(fake.calls).not.toContain('create');
    }, 30_000);

    it('refuses a formless signup whose unbound email field holds another address, since its handler would send it', async () => {
      await page.goto(`${SITE}/no-form-join`);
      await page.locator('[name=email]').fill('remy.vance@example.com');
      const authority = await signupAuthority();
      expect(await fill(authority, await refs({ new_password: 'Password', activate: 'Create account' }))).toEqual({
        status: 'refused',
        reason: 'unsupported_form',
      });
      await unexposed(authority);
      expect(fake.calls).not.toContain('create');
    }, 30_000);

    it("refuses a formless page whose own address is the site's checkout", async () => {
      await page.goto(`${SITE}/checkout/join`);
      const authority = await signupAuthority();
      expect(
        await fill(authority, await refs({ username: 'Email', new_password: 'Password', activate: 'Create account' })),
      ).toEqual({ status: 'refused', reason: 'purchase_control' });
      await unexposed(authority);
      expect(fake.calls).not.toContain('create');
    }, 30_000);

    it('refuses a form on another site, even with an authority for this one', async () => {
      await page.goto('https://collector.example/native-signup');
      const authority = await signupAuthority();
      expect(await fill(authority, await refs(SIGNUP))).toEqual({ status: 'refused', reason: 'origin_mismatch' });
      await unexposed(authority);
    }, 30_000);

    it('inserts nothing when the operator disables 1Password between the disclosure and the fill', async () => {
      await page.goto(`${SITE}/native-signup`);
      const authority = await signupAuthority();
      const disclose = attempts.disclose.bind(attempts);
      vi.spyOn(attempts, 'disclose').mockImplementation(async (...args) => {
        const disclosed = await disclose(...args);
        await writeOnePasswordHostPolicy(onePasswordPolicyFile, {
          schemaVersion: 2,
          enabled: false,
          accountId: FIXTURE_ACCOUNT_ID,
          signInAddress: FIXTURE_SIGN_IN_ADDRESS,
          cliPath: '/opt/homebrew/bin/op',
          managementServiceAccountId: null,
        });
        return disclosed;
      });
      expect(await fill(authority, await refs(SIGNUP))).toEqual({ status: 'vault_unavailable' });
      expect(posts).toEqual([]);
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'rejected', exposed_at: expect.any(String) });
      expect(await page.locator('input[name=password]').inputValue()).toBe('');
    }, 30_000);

    it('refuses a form whose node was replaced while the candidate was being saved', async () => {
      await page.goto(`${SITE}/native-signup`);
      const authority = await signupAuthority();
      const chosen = await refs(SIGNUP);
      fake.afterCreate = async () => {
        await page.evaluate(`(() => {
          const form = document.querySelector('form');
          const replacement = form.cloneNode(true);
          form.replaceWith(replacement);
        })()`);
      };
      expect(await fill(authority, chosen)).toEqual({ status: 'refused', reason: 'form_changed' });
      await unexposed(authority);
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'saved' });
    }, 30_000);

    it('never lets a cross-origin parent take a value when it steals focus at the insertion boundary', async () => {
      await page.goto('https://parent.example/');
      const frame = page.frames().find((candidate) => candidate.url() === `${SITE}/native-signup`);
      if (!frame) throw new Error('Authentication frame missing');
      await page.locator('#untrusted').focus();
      const authority = await signupAuthority();
      const chosen = await refs(SIGNUP);
      fake.afterCreate = async () => {
        await frame.evaluate("parent.postMessage('steal-focus', 'https://parent.example')");
        await page.locator('body[data-stolen="yes"]').waitFor();
      };
      expect(await fill(authority, chosen)).toEqual({ status: 'account_created', vault: 'saved' });
      expect(await page.locator('body').getAttribute('data-captured')).toBeNull();
      expect(posts.map((post) => post.host)).toEqual(['accounts.shop.example']);
    }, 30_000);
  });

  describe('never sending a credential in an address', () => {
    for (const where of ['the page', 'an out-of-process frame'] as const)
      it(`stops a native GET submission in ${where}`, async () => {
        await page.goto(where === 'the page' ? `${SITE}/get-signup` : 'https://parent.example/get');
        const authority = await signupAuthority();
        remaining = 5_000;
        const password = await (async () => {
          expect(await fill(authority, await refs(SIGNUP))).toEqual({ status: 'outcome_unknown' });
          return candidatePassword(authority.id);
        })();
        expect(addresses.filter((address) => address.includes('/signup?'))).toEqual([]);
        expect(addresses.some((address) => address.includes(encodeURIComponent(password)))).toBe(false);
        expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
      }, 30_000);
  });

  describe('website outcomes', () => {
    for (const [response, status, phase] of [
      ['<p>An account with this email already exists.</p>', 'account_exists', 'rejected'],
      [`<p>Password is too weak.</p>${PAGES['/native-signup']}`, 'password_rejected', 'rejected'],
      ['<p>Check your email to verify your account.</p>', 'verification_requested', 'awaiting_verification'],
      ['<h1>Thanks!</h1>', 'outcome_unknown', 'unknown'],
    ] as const)
      it(`keeps ${status} as ${phase}`, async () => {
        responses.set('/signup', response);
        remaining = 6_000;
        const { authority, result } = await signUp('/native-signup', SIGNUP);
        expect(result).toEqual({ status });
        expect(await attempts.get(authority.id)).toMatchObject({ phase });
        // A repeat reports the recorded outcome and never needs the page again, let alone submits it.
        expect(await fill(authority, SETTLED_REFS)).toEqual(
          status === 'outcome_unknown' || status === 'verification_requested'
            ? { status }
            : { status: 'refused', reason: 'no_authority' },
        );
        expect(posts).toHaveLength(1);
      }, 30_000);
  });

  describe('keeping values out of every agent surface', () => {
    it('redacts old toggled, copied and cleared values and refuses screenshots of the tainted document', async () => {
      responses.set('/api/signup', '<p>Check your email to verify your account.</p>');
      const { result, password } = await signUp('/masking', SIGNUP);
      expect(result).toEqual({ status: 'verification_requested' });
      if (!password) throw new Error('no candidate');
      expect(await page.locator('[name=password]').getAttribute('type')).toBe('text');
      // Every input holding the value is cleared; the echoed text stays only in the page.
      expect(await page.locator('[name=notes]').inputValue()).toBe('');
      expect(await page.locator('#echo').textContent()).toContain(password);
      const observation = await observePage(page);
      expect(JSON.stringify(observation)).not.toContain(password);
      const shot = await executeBrowserBatch(context(), { actions: [{ kind: 'screenshot' }] }, { record: false });
      expect(shot).toMatchObject({ status: 'stopped', reason: 'secret_field' });
      expect(JSON.stringify(shot)).not.toContain(password);
    }, 30_000);

    it('treats a page-filled text-type confirmation field as secret', async () => {
      await page.goto(`${SITE}/prefilled`);
      expect(JSON.stringify(await observePage(page))).not.toContain('page-chosen-secret-value');
      const shot = await executeBrowserBatch(context(), { actions: [{ kind: 'screenshot' }] }, { record: false });
      expect(shot).toMatchObject({ status: 'stopped', reason: 'secret_field' });
    }, 30_000);

    it('keeps generic typing, keys and clicks out of the credential scope', async () => {
      await page.goto(`${SITE}/masking`);
      await page.evaluate("document.querySelector('[name=password_confirmation]').type = 'text'");
      // Each action stops its batch and its observation renews the refs, so every step reads fresh ones.
      const batch = async (action: (chosen: Record<string, BrowserRef>) => Record<string, unknown>) => {
        const chosen = await refs({
          password: 'Password',
          confirmation: 'Confirm password',
          email: 'Email',
          activate: 'Create account',
        });
        return (await executeBrowserBatch(context(), { actions: [action(chosen)] }, { record: false })).actions;
      };
      const stopped = (reason: string) => [{ index: 0, status: 'stopped', reason }];
      expect(
        await batch(({ confirmation }) => ({ kind: 'type', ...confirmation, text: 'model-chosen-password' })),
      ).toEqual(stopped('secret_field'));
      expect(
        await batch(({ password }) => ({
          kind: 'form_input',
          fields: [{ ...password, value: 'model-chosen-password' }],
        })),
      ).toEqual(stopped('secret_field'));
      expect(await batch(({ password }) => ({ kind: 'key', ...password, key: 'Enter' }))).toEqual(
        stopped('secret_field'),
      );
      // A form that holds password fields is submitted only by the credential operation itself.
      expect(await batch(({ activate }) => ({ kind: 'click', ...activate }))).toEqual(stopped('secret_field'));
      expect(await batch(({ email }) => ({ kind: 'key', ...email, key: 'Enter' }))).toEqual(stopped('secret_field'));
      expect(posts).toEqual([]);
    }, 30_000);
  });

  describe('the consent engine during signup', () => {
    const anyChecked = async (): Promise<unknown> =>
      page.evaluate("Array.from(document.querySelectorAll('input[type=checkbox]')).some((box) => box.checked)");

    it('ticks the terms box of the bound form and unticks its pre-ticked offers box before the activation', async () => {
      const { result, password } = await signUp('/offers-signup', SIGNUP);
      expect(result).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts).toEqual([
        {
          host: 'accounts.shop.example',
          path: '/signup',
          body: new URLSearchParams({
            email: USERNAME,
            password: password!,
            password_confirmation: password!,
            terms: 'on',
          }).toString(),
        },
      ]);
    }, 30_000);

    it('ticks it in a controlled JS form whose submit control waits for it, through the form’s own handlers', async () => {
      const { result, password } = await signUp('/js-terms', SIGNUP);
      expect(result).toEqual({ status: 'account_created', vault: 'saved' });
      // The tick reached the controlled form's own state, which is what it posts; the stop test below proves the
      // engine decides before anything is disclosed.
      expect(posts.map(({ host, path, body }) => ({ host, path, body: JSON.parse(body) as unknown }))).toEqual([
        {
          host: 'accounts.shop.example',
          path: '/api/signup',
          body: { email: USERNAME, password, password_confirmation: password, terms: true },
        },
      ]);
    }, 30_000);

    // Which wordings stop is the consent engine's own decision (consent.test.ts); this is the signup's path to it.
    it('stops for a terms box bundled with marketing with a stop for the principal, before anything is saved or disclosed', async () => {
      const label = 'I agree to the Terms and to receive marketing emails';
      await page.goto(`${SITE}/marketing-terms`);
      const authority = await signupAuthority();
      const result = await fill(authority, await refs(SIGNUP));
      const stops = await getDb().all<{ id: string; job_id: string; site: string; wording: string }>(
        'SELECT id,job_id,site,wording FROM gws_ea_browser_consent_stops',
      );
      expect(stops).toEqual([{ id: expect.any(String), job_id: JOB, site: 'shop.example', wording: label }]);
      expect(result).toEqual({
        status: 'refused',
        reason: 'consent_required',
        consent: [
          {
            stop_id: stops[0].id,
            site: 'shop.example',
            wording: expect.stringMatching(siteWordingPattern(label, 'shop.example')),
          },
        ],
      });
      expect(posts).toEqual([]);
      expect(fake.calls).not.toContain('create');
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'preparing', exposed_at: null });
      expect(await anyChecked()).toBe(false);
    }, 30_000);

    it("takes a signup form's own agree-and-create control as its activation", async () => {
      const { result } = await signUp('/agree-signup', { ...SIGNUP, activate: 'Agree and create account' });
      expect(result).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts.map((post) => post.path)).toEqual(['/signup']);
    }, 30_000);

    for (const path of ['/agree-money', '/agree-outside'] as const)
      it(`refuses the agree-and-create control on ${path} before disclosure`, async () => {
        await page.goto(`${SITE}${path}`);
        const authority = await signupAuthority();
        expect(await fill(authority, await refs({ ...SIGNUP, activate: 'Agree and create account' }))).toEqual({
          status: 'refused',
          reason: 'unsupported_control',
        });
        expect(posts).toEqual([]);
        expect(await attempts.get(authority.id)).toMatchObject({ exposed_at: null });
      }, 30_000);
  });

  it.each([false, true])(
    'releases only its own uninserted hold (another authority held: %s)',
    async (otherHeld) => {
      await page.goto(`${SITE}/native-signup`);
      const guard = await ensureBrowserNavigationGuard(page);
      if (otherHeld) guard.holdSubmissions('other-authority');
      const authority = await signupAuthority();
      let changed = false;
      const active = context();
      const result = await executeCredentialForm(
        {
          ...active,
          assertActive: async () => {
            await active.assertActive();
            if (!changed && (await attempts.get(authority.id))?.phase === 'exposed') {
              changed = true;
              await page.evaluate("document.querySelector('[name=password_confirmation]').remove()");
            }
          },
        },
        { authority: authority.id, ...(await refs(SIGNUP)) },
        { attempts },
      );
      expect(result).toEqual({ status: 'refused', reason: 'form_changed' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'rejected' });
      expect(posts).toEqual([]);
      expect(await page.locator('input[name=password]').inputValue()).toBe('');
      if (otherHeld) {
        await page.evaluate("fetch('/ordinary-save', { method: 'POST', body: 'blocked=other' }).catch(() => {})");
        expect(posts).toEqual([]);
        guard.allowSubmissions('other-authority');
      }
      await page.evaluate(
        "fetch('/ordinary-save', { method: 'POST', body: 'safe=ordinary' }).then(response => response.text())",
      );
      expect(posts.map((post) => [post.path, post.body])).toEqual([['/ordinary-save', 'safe=ordinary']]);
    },
    30_000,
  );

  describe('a box only the principal can agree to, which the form resets on every fill (KTD11)', () => {
    const stops = () =>
      getDb().all<{ id: string; site: string; origin: string; wording: string }>(
        'SELECT id,site,origin,wording FROM gws_ea_browser_consent_stops ORDER BY created_at',
      );
    /** The principal's yes on the card for the form's stop, as the consent card's approval records it. */
    async function grant(): Promise<void> {
      const [stop] = await stops();
      await recordConsentGrant(getDb(), {
        site: stop.site,
        origin: stop.origin,
        wording: stop.wording,
        approvalId: 'approval-waiver',
        principalUserId: 'gchat:users/principal',
      });
      await getDb().run("UPDATE gws_ea_browser_consent_stops SET status = 'approved' WHERE id = ?", stop.id);
    }
    /** What the page's fields hold and what an observation shows, where the password must not be. */
    const pageText = async (): Promise<string> =>
      `${JSON.stringify(await page.evaluate("Array.from(document.querySelectorAll('input'), (input) => input.value)"))}${(await observePage(page)).snapshot}`;

    it('reconciles an existing socket submission without filling or submitting again after consent', async () => {
      await page.goto(`${SITE}/waiver-on-fill`);
      await page.evaluate(`(() => {
        window.socketMessages = [];
        window.socketReady = new Promise(resolve => {
          const socket = new WebSocket('wss://accounts.shop.example/socket-signup');
          socket.addEventListener('open', () => resolve());
          socket.addEventListener('message', ({ data }) => {
            window.socketMessages.push(data);
            if (data === 'created') document.querySelector('h1').textContent = 'Account created';
          });
          document.querySelector('[name=password]').addEventListener('input', ({ target }) => {
            if (target.value) socket.send('signup');
          });
        });
      })()`);
      await page.evaluate('window.socketReady');
      const authority = await signupAuthority();
      const controls = await refs(SIGNUP);
      expect(await fill(authority, controls)).toMatchObject({ status: 'outcome_unknown', reason: 'consent_required' });
      await page.waitForFunction("window.socketMessages.includes('recorded')");
      expect(posts.map((post) => post.path)).toEqual(['/socket-signup']);
      const uncertain = await attempts.get(authority.id);
      expect(uncertain).toMatchObject({ phase: 'unknown', candidate_item_id: expect.any(String) });
      await grant();
      expect(await fill(authority, controls)).toEqual({ status: 'outcome_unknown' });
      expect(posts.map((post) => post.path)).toEqual(['/socket-signup']);
      expect((await attempts.get(authority.id))?.candidate_item_id).toBe(uncertain?.candidate_item_id);
      // Queue history includes the consent card request and the refused no-op refill: neither interacted
      // with the page, so the response remains attributable to this attempt's one disclosure.
      await getDb().exec(
        'CREATE TABLE gws_ea_browser_requests(id TEXT PRIMARY KEY,job_id TEXT,action TEXT,payload_json TEXT,started_at TEXT)',
      );
      for (const [id, action, payload] of [
        ['socket-consent', 'request_consent', { stop_id: (await stops())[0].id }],
        ['socket-no-refill', 'credential_form', { authority: authority.id, ...controls }],
      ] as const)
        await getDb().run(
          'INSERT INTO gws_ea_browser_requests VALUES(?,?,?,?,?)',
          id,
          JOB,
          action,
          JSON.stringify(payload),
          new Date().toISOString(),
        );
      answerSlow();
      await page.waitForFunction("window.socketMessages.includes('created')");
      expect(
        await executeCredentialForm(context(), { authority: authority.id, operation: 'reconcile' }, { attempts }),
      ).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts.map((post) => post.path)).toEqual(['/socket-signup']);
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'finalized' });
      await page.goto(`${SITE}/native-signup`);
      expect(await page.locator('h1').textContent()).toBe('Join');
    }, 30_000);

    it('keeps a post-fill consent stop uncertain and refuses refills before and after the grant', async () => {
      await page.goto(`${SITE}/waiver-on-fill`);
      const authority = await signupAuthority();
      const held = await fill(authority, await refs(SIGNUP));
      const [stop] = await stops();
      expect(held).toEqual({
        status: 'outcome_unknown',
        reason: 'consent_required',
        consent: [
          {
            stop_id: stop.id,
            site: 'shop.example',
            wording: expect.stringMatching(siteWordingPattern(WAIVER, 'shop.example')),
          },
        ],
      });
      expect(posts).toEqual([]);
      expect(await attempts.get(authority.id)).toMatchObject({
        phase: 'unknown',
        exposed_at: expect.any(String),
      });
      const password = await candidatePassword(authority.id);
      expect(await pageText()).not.toContain(password);
      const pending = await fill(authority, await refs(SIGNUP));
      expect(pending).toEqual({ status: 'outcome_unknown' });
      expect(posts).toEqual([]);
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
      await grant();
      const done = await fill(authority, await refs(SIGNUP));
      expect(done).toEqual({ status: 'outcome_unknown' });
      expect(posts).toEqual([]);
      // One candidate, one disclosure's value, and no answer that carries it.
      expect(fake.calls.filter((call) => call === 'create')).toHaveLength(1);
      expect(JSON.stringify([held, pending, done])).not.toContain(password);
    }, 30_000);

    for (const address of [
      `${SITE}/waiver-and-submit-on-fill`,
      `${SITE}/waiver-and-get-on-fill`,
      'https://parent.example/waiver-submit',
    ])
      it(`blocks HTTP callback submissions before consent, including while uncertain, on ${address}`, async () => {
        await page.goto(address);
        const authority = await signupAuthority();
        expect(await fill(authority, await refs(SIGNUP))).toMatchObject({ reason: 'consent_required' });
        expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
        const formFrame = page.frames().find((frame) => frame.url().startsWith(SITE));
        if (!formFrame) throw new Error('Missing credential frame');
        await formFrame.evaluate('window.callbackSubmission');
        expect(posts).toEqual([]);
        await formFrame.evaluate('window.submitFilledForm()');
        expect(posts).toEqual([]);
        const newFrame = page.waitForEvent('framenavigated', {
          predicate: (frame) => frame.url() === 'about:srcdoc',
        });
        await formFrame.evaluate(`(() => {
          const child = document.createElement('iframe');
          // Start the real callback later so this also covers completion after the first poll.
          child.srcdoc = "<body><script>setTimeout(() => { fetch('https://parent.example/callback-signup?data=frame').catch(() => {}).finally(() => { document.body.dataset.finished = 'yes'; }); }, 100);</script></body>";
          document.body.append(child);
        })()`);
        const child = await newFrame;
        // A child clipped outside its parent's viewport may receive no animation frames.
        await child.waitForFunction("document.body.dataset.finished === 'yes'", undefined, { polling: 50 });
        expect(posts).toEqual([]);
        await grant();
        expect(await fill(authority, await refs(SIGNUP))).toEqual({ status: 'outcome_unknown' });
        expect(posts).toEqual([]);
      }, 30_000);

    it('blocks a native document POST requested by an input callback', async () => {
      await page.goto(`${SITE}/waiver-document-submit-on-fill`);
      const authority = await signupAuthority();
      const controls = await refs(SIGNUP);
      expect(await fill(authority, controls)).toMatchObject({ status: 'outcome_unknown' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
      expect(posts).toEqual([]);
      expect(await fill(authority, controls)).toMatchObject({ status: 'outcome_unknown' });
      expect(posts).toEqual([]);
    }, 30_000);

    it('keeps a framed credential attempt uncertain while its consent stop names the page', async () => {
      await page.goto('https://parent.example/waiver');
      const authority = await signupAuthority();
      expect(await fill(authority, await refs(SIGNUP))).toMatchObject({
        status: 'outcome_unknown',
        reason: 'consent_required',
      });
      const [stop] = await stops();
      expect(stop).toMatchObject({ site: 'parent.example', origin: SITE });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown', site: 'shop.example' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
      expect(posts).toEqual([]);
    }, 30_000);

    it('keeps uncertainty across a host restart and never refills after a grant', async () => {
      await page.goto(`${SITE}/waiver-on-fill`);
      const authority = await signupAuthority();
      expect(await fill(authority, await refs(SIGNUP))).toMatchObject({ reason: 'consent_required' });
      // A fresh process knows only the durable record and 1Password.
      const restarted = new CredentialAttempts({ db: getDb(), vault });
      await recoverCredentialAttempts(restarted);
      expect(await restarted.get(authority.id)).toMatchObject({ phase: 'unknown' });
      await grant();
      expect(
        await executeCredentialForm(
          context(),
          { authority: authority.id, ...(await refs(SIGNUP)) },
          { attempts: restarted },
        ),
      ).toEqual({ status: 'outcome_unknown' });
      expect(posts).toEqual([]);
      expect(
        await executeCredentialForm(
          context(),
          { authority: authority.id, operation: 'reconcile' },
          { attempts: restarted },
        ),
      ).toEqual({ status: 'inconclusive' });
    }, 30_000);

    for (const [path, outcome, why] of [
      [
        '/offers-on-fill',
        { status: 'outcome_unknown', reason: 'consent_required' },
        'a page that undoes a choice the host set after the fill',
      ],
      ['/waiver-and-route-on-fill', { status: 'outcome_unknown', reason: 'consent_required' }, 'a fill that navigated'],
      ['/donation-on-fill', { status: 'outcome_unknown', reason: 'purchase_control' }, 'a paid extra after the fill'],
    ] as const)
      it(`leaves the attempt unknown after ${why}`, async () => {
        await page.goto(`${SITE}${path}`);
        const authority = await signupAuthority();
        expect(await fill(authority, await refs(SIGNUP))).toMatchObject(outcome);
        expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
        expect(posts).toEqual([]);
      }, 30_000);
  });

  describe('recovering a cut-off disclosure', () => {
    it('covers AE3: a crash in the first input callback leaves the same candidate unknown, and a retry after restart never submits', async () => {
      let crashed = false;
      await page.exposeFunction('credentialCallback', () => {
        crashed = true;
      });
      await page.goto(`${SITE}/js-signup`);
      const authority = await signupAuthority();
      const crashing = {
        ...context(),
        assertActive: async () => {
          if (crashed) throw new Error('The host stopped');
        },
      } as BrowserExecutionContext;
      expect(
        await executeCredentialForm(crashing, { authority: authority.id, ...(await refs(SIGNUP)) }, { attempts }),
      ).toEqual({ status: 'outcome_unknown' });
      const unknown = await attempts.get(authority.id);
      expect(unknown).toMatchObject({ phase: 'unknown', exposed_at: expect.any(String) });
      const password = await candidatePassword(authority.id);

      // A fresh process knows only the durable record and 1Password.
      const restarted = new CredentialAttempts({ db: getDb(), vault });
      expect(
        await executeCredentialForm(
          context(),
          { authority: authority.id, ...(await refs(SIGNUP)) },
          { attempts: restarted },
        ),
      ).toEqual({ status: 'outcome_unknown' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(posts).toEqual([]);
      expect(fake.calls.filter((call) => call === 'create')).toHaveLength(1);
      expect(await attempts.get(authority.id)).toMatchObject({
        phase: 'unknown',
        candidate_item_id: unknown?.candidate_item_id,
      });
      expect(await candidatePassword(authority.id)).toBe(password);
    }, 30_000);

    for (const [response, expected, phase] of [
      ['<h1>Account created</h1>', { status: 'account_created', vault: 'saved' }, 'finalized'],
      ['<p>An account with this email already exists.</p>', { status: 'account_exists' }, 'rejected'],
      ['<h1>Thanks!</h1>', { status: 'inconclusive' }, 'unknown'],
    ] as const)
      it(`reconciles a late response read-only to ${expected.status}`, async () => {
        responses.set('/api/slow-signup', response);
        remaining = 4_000;
        const { authority, result } = await signUp('/slow-js-signup', SIGNUP);
        expect(result).toEqual({ status: 'outcome_unknown' });
        answerSlow();
        await page.locator('#result > *').waitFor();
        remaining = 20_000;
        const reconcile = () =>
          executeCredentialForm(context(), { authority: authority.id, operation: 'reconcile' }, { attempts });
        expect(await reconcile()).toEqual(expected);
        expect(await attempts.get(authority.id)).toMatchObject({ phase });
        expect(posts).toHaveLength(1);
      }, 30_000);
  });

  describe('verifying a new account by email', () => {
    let delivered = 0;
    beforeEach(async () => {
      await runMigrations(await initTestDb());
      attempts = new CredentialAttempts({ db: getDb(), vault });
      await createAgentGroup({
        id: 'external-email',
        name: 'external-email',
        folder: 'external-email',
        agent_provider: null,
        created_at: new Date().toISOString(),
      });
      await getDb().run(
        'UPDATE gws_ea_profile SET external_email_agent_group_id = ?, assistant_workspace_email = ? WHERE singleton = 1',
        'external-email',
        USERNAME,
      );
      setActiveInbox({
        gmailAddress: async () => USERNAME,
        knownGmailAddress: () => USERNAME,
        wakeSignIn: () => undefined,
      } as unknown as InboxRuntime);
    });
    afterEach(async () => {
      await recoverBrowserSignInMail();
      setActiveInbox(undefined);
    });

    /** The site's email reaches the assistant inbox, and the isolated interpreter answers its host task. */
    async function deliver(reply: { kind: 'code' | 'link'; value: string }): Promise<void> {
      delivered++;
      const mail = parseGmailMessage({
        id: `verification-${delivered}`,
        threadId: `verification-${delivered}`,
        labelIds: ['INBOX'],
        internalDate: String(Date.now()),
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.d=shop.example' },
            { name: 'From', value: 'accounts@shop.example' },
            { name: 'To', value: USERNAME },
            { name: 'Subject', value: 'Verify your email' },
          ],
          body: { data: Buffer.from(`Verify your email: ${reply.value}`).toString('base64url') },
        },
      });
      expect(await routeSignInMail(mail, new Date())).toBe(true);
      const [interpreter] = await getSessionsByAgentGroup('external-email');
      expect(await answerSignInReply({ ...reply }, interpreter)).toEqual({ status: 'accepted' });
    }
    const verify = (authority: CredentialAttempt, fields: Record<string, BrowserRef> = {}) =>
      executeCredentialForm(context(), { authority: authority.id, operation: 'verify', ...fields }, { attempts });

    it('opens the bound verification link through the host, then saves the confirmed account', async () => {
      responses.set('/signup', '<p>Check your email to verify your account.</p>');
      const { authority, result } = await signUp('/native-signup', SIGNUP);
      expect(result).toEqual({ status: 'verification_requested' });
      const token = 'verification-bearer-5519';
      await deliver({ kind: 'link', value: `${SITE}/verify-email?token=${token}` });
      const verified = await verify(authority);
      expect(verified).toEqual({ status: 'account_created', vault: 'saved' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'finalized' });
      expect(page.url()).toBe(`${SITE}/`);
      expect(addresses).toContain(`accounts.shop.example/verify-email?token=${token}`);
      for (const record of [verified, await attempts.get(authority.id), await observePage(page)])
        expect(JSON.stringify(record)).not.toContain(token);
    }, 30_000);

    it('enters the bound verification code in the fields the browser names', async () => {
      responses.set(
        '/signup',
        '<p>Check your email to verify your account.</p><form method="post" action="/verify-code"><label>Verification code <input name="code" autocomplete="one-time-code"></label><button type="submit">Verify</button></form>',
      );
      responses.set('/verify-code', '<h1>Your email has been verified.</h1>');
      const { authority, result } = await signUp('/native-signup', SIGNUP);
      expect(result).toEqual({ status: 'verification_requested' });
      await deliver({ kind: 'code', value: '482913' });
      // A code needs its field: the answer waits for a step that names it.
      expect(await verify(authority)).toEqual({ status: 'refused', reason: 'code_field_needed' });
      const verified = await verify(authority, await refs({ code_field: 'Verification code', activate: 'Verify' }));
      expect(verified).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts.at(-1)).toEqual({ host: 'accounts.shop.example', path: '/verify-code', body: 'code=482913' });
      expect(JSON.stringify(verified)).not.toContain('482913');
      expect(JSON.stringify(await observePage(page))).not.toContain('482913');
    }, 30_000);

    it('leaves a code the site may have taken unknown when the step is cut off, then reconciles its late confirmation', async () => {
      responses.set(
        '/signup',
        `<p>Check your email to verify your account.</p><form id="verify"><label>Verification code <input name="code" autocomplete="one-time-code"></label><button type="submit">Verify</button></form><div id="result"></div><script>
          document.getElementById('verify').addEventListener('submit', (event) => {
            event.preventDefault();
            fetch('/api/slow-verify', { method: 'POST', body: document.querySelector('[name=code]').value })
              .then((response) => response.text()).then((html) => { document.getElementById('result').innerHTML = html; });
          });
        </script>`,
      );
      responses.set('/api/slow-verify', '<h1>Your email has been verified.</h1>');
      const { authority, result } = await signUp('/native-signup', SIGNUP);
      expect(result).toEqual({ status: 'verification_requested' });
      await deliver({ kind: 'code', value: '730165' });
      // The host stops once the site has the code, before its answer arrives.
      const cutOff = {
        ...context(),
        assertActive: async () => {
          if (posts.some((post) => post.path === '/api/slow-verify')) throw new Error('The host stopped');
        },
      } as BrowserExecutionContext;
      const chosen = await refs({ code_field: 'Verification code', activate: 'Verify' });
      expect(
        await executeCredentialForm(cutOff, { authority: authority.id, operation: 'verify', ...chosen }, { attempts }),
      ).toEqual({ status: 'outcome_unknown' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });

      answerSlow();
      await page.locator('#result > *').waitFor();
      expect(
        await executeCredentialForm(context(), { authority: authority.id, operation: 'reconcile' }, { attempts }),
      ).toEqual({ status: 'account_created', vault: 'saved' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'finalized' });
      expect(posts.filter((post) => post.path === '/api/slow-verify')).toEqual([
        { host: 'accounts.shop.example', path: '/api/slow-verify', body: '730165' },
      ]);
    }, 30_000);

    it('leaves a code activation it cannot see through unknown, then reconciles the confirmation the site showed', async () => {
      responses.set(
        '/signup',
        `<p>Check your email to verify your account.</p><form id="verify"><label>Verification code <input name="code" autocomplete="one-time-code"></label><button type="submit">Verify</button></form><div id="result"></div><script>
          document.getElementById('verify').addEventListener('submit', (event) => {
            event.preventDefault();
            fetch('/api/verify-code', { method: 'POST', body: document.querySelector('[name=code]').value })
              .then((response) => response.text()).then((html) => { document.getElementById('result').innerHTML = html; });
          });
        </script>`,
      );
      responses.set('/api/verify-code', '<h1>Your email has been verified.</h1>');
      const { authority, result } = await signUp('/native-signup', SIGNUP);
      expect(result).toEqual({ status: 'verification_requested' });
      await deliver({ kind: 'code', value: '518204' });
      clicks.lostAnswer = true;
      expect(await verify(authority, await refs({ code_field: 'Verification code', activate: 'Verify' }))).toEqual({
        status: 'outcome_unknown',
      });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });

      await page.locator('#result > *').waitFor();
      expect(
        await executeCredentialForm(context(), { authority: authority.id, operation: 'reconcile' }, { attempts }),
      ).toEqual({ status: 'account_created', vault: 'saved' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'finalized' });
      expect(posts.filter((post) => post.path === '/api/verify-code')).toEqual([
        { host: 'accounts.shop.example', path: '/api/verify-code', body: '518204' },
      ]);
    }, 30_000);

    /** A signup the site asked to confirm, its emailed answer delivered and its wait still open. */
    async function awaitingConfirmation(signupPage: string, reply: { kind: 'code' | 'link'; value: string }) {
      responses.set('/signup', signupPage);
      const { authority, result } = await signUp('/native-signup', SIGNUP);
      expect(result).toEqual({ status: 'verification_requested' });
      await deliver(reply);
      return authority;
    }
    const claimStates = () => getDb().all<{ state: string }>('SELECT state FROM gws_ea_browser_sign_in_claims');

    it('leaves a signup unknown when the opened link lands without the site confirming it, never asking to verify again', async () => {
      const authority = await awaitingConfirmation('<p>Check your email to verify your account.</p>', {
        kind: 'link',
        value: `${SITE}/verify-email-quiet?token=verification-bearer-6610`,
      });
      expect(await verify(authority)).toEqual({ status: 'outcome_unknown' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
      expect(await claimStates()).toEqual([{ state: 'finished' }]);
      // The spent link is never opened again; the cleared page leaves nothing to read, so the principal decides.
      expect(await verify(authority)).toEqual({ status: 'outcome_unknown' });
      expect(
        await executeCredentialForm(context(), { authority: authority.id, operation: 'reconcile' }, { attempts }),
      ).toEqual({ status: 'inconclusive' });
      expect(addresses.filter((address) => address.includes('verify-email-quiet'))).toHaveLength(1);
    }, 30_000);

    it('leaves a signup unknown when opening its link fails part way', async () => {
      const authority = await awaitingConfirmation('<p>Check your email to verify your account.</p>', {
        kind: 'link',
        value: `${SITE}/verify-away?token=verification-bearer-6611`,
      });
      expect(await verify(authority)).toEqual({ status: 'outcome_unknown' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
      expect(JSON.parse((await attempts.get(authority.id))!.evidence_json!)).toMatchObject({ via: 'link' });
      expect(await claimStates()).toEqual([{ state: 'finished' }]);
    }, 30_000);

    it('leaves an entered code unknown when the site confirms after the wait, then reconciles its confirmation', async () => {
      const authority = await awaitingConfirmation(
        `<p>Check your email to verify your account.</p><form id="verify"><label>Verification code <input name="code" autocomplete="one-time-code"></label><button type="submit">Verify</button></form><div id="result"></div><script>
          document.getElementById('verify').addEventListener('submit', (event) => {
            event.preventDefault();
            fetch('/api/slow-verify', { method: 'POST', body: document.querySelector('[name=code]').value })
              .then((response) => response.text()).then((html) => { document.getElementById('result').innerHTML = html; });
          });
        </script>`,
        { kind: 'code', value: '640372' },
      );
      responses.set('/api/slow-verify', '<h1>Your email has been verified.</h1>');
      remaining = 4_000;
      expect(await verify(authority, await refs({ code_field: 'Verification code', activate: 'Verify' }))).toEqual({
        status: 'outcome_unknown',
      });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
      remaining = 20_000;
      answerSlow();
      await page.locator('#result > *').waitFor();
      expect(
        await executeCredentialForm(context(), { authority: authority.id, operation: 'reconcile' }, { attempts }),
      ).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts.filter((post) => post.path === '/api/slow-verify')).toHaveLength(1);
    }, 30_000);

    it('reads the site after a code its field submitted by itself, though the control never enabled', async () => {
      const authority = await awaitingConfirmation(
        `<p>Check your email to verify your account.</p><form id="verify"><label>Verification code <input name="code" autocomplete="one-time-code"></label><button type="submit" disabled>Verify</button></form><div id="result"></div><script>
          document.querySelector('[name=code]').addEventListener('input', (event) => {
            if (event.target.value.length < 6) return;
            fetch('/api/verify-code', { method: 'POST', body: event.target.value })
              .then((response) => response.text()).then((html) => { document.getElementById('result').innerHTML = html; });
          });
        </script>`,
        { kind: 'code', value: '271828' },
      );
      responses.set('/api/verify-code', '<h1>Your email has been verified.</h1>');
      expect(await verify(authority, await refs({ code_field: 'Verification code', activate: 'Verify' }))).toEqual({
        status: 'account_created',
        vault: 'saved',
      });
      expect(posts.filter((post) => post.path === '/api/verify-code')).toEqual([
        { host: 'accounts.shop.example', path: '/api/verify-code', body: '271828' },
      ]);
      expect(await claimStates()).toEqual([{ state: 'finished' }]);
    }, 30_000);

    it('reports a signup the site already confirmed without waiting for mail', async () => {
      const { authority } = await signUp('/native-signup', SIGNUP);
      expect(await verify(authority)).toEqual({ status: 'account_created', vault: 'saved' });
      expect(await getSessionsByAgentGroup('external-email')).toEqual([]);
      // The wait opened before activation closed with the site's own confirmation.
      expect(await getDb().all('SELECT state FROM gws_ea_browser_sign_in_claims')).toEqual([{ state: 'finished' }]);
    }, 30_000);
  });
});

/** Refs that resolve to nothing: a repeat on a settled attempt must not need the page at all. */
const SETTLED_REFS: Record<string, BrowserRef> = {
  username: { ref: 'e1', generation: 1 },
  new_password: { ref: 'e2', generation: 1 },
  confirmation: { ref: 'e3', generation: 1 },
  activate: { ref: 'e4', generation: 1 },
};
