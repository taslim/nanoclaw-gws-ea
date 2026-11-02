import * as loginStores from './login-store.js';
import { testLoginStore } from './testing/login-store.js';
import { useAvailableBrowser } from './testing/browser-runtime.js';
/** Real owned Chrome, background windows and TLS origins; all traffic terminates in this fixture. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession, Frame, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initSqliteTestDb } from '../../db/connection.js';
import { prepareAuthenticationIsolation } from './authentication-submit.js';
import { prepareChromeProfile, spawnChrome } from './chrome.js';
import { connectChrome, type ChromeConnection } from './connection.js';
import { executeBrowserBatch } from './executor.js';
import { classifyActivation } from './commit-classifier.js';
import { readPageControlFacts } from './control-facts.js';

import { bindBrowserSecretFields, executeFillSecret, fillBoundBrowserSecrets } from './fill.js';
import './merchant-signatures.js';
import { browserConsentMigration, browserSiteLeasesMigration } from './migration.js';
import { browserSignInMigration } from './sign-in-migration.js';
import { recoverBrowserSignInMail, executeSignInCode } from './sign-in-mail.js';
import { getSignInClaim } from '../gws-ea-inbox/claims.js';
import type { BrowserSecretField } from './authentication-signatures.js';
import { observePage, type BrowserRef, type PinnedBrowserRef } from './observe.js';
import { browserPaths } from './paths.js';
import type { BrowserExecutionContext } from './actions.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
const secret = 'host-only-cross-origin-fixture-value';
describe.skipIf(!chromePath)('native host secret fill', { timeout: 30_000 }, () => {
  let root: string;
  let proxy: HttpServer;
  let server: HttpsServer;
  let connection: ChromeConnection;
  let page: Page;
  let certificateSession: CDPSession;
  let logins: ReturnType<typeof testLoginStore>;
  const sockets = new Set<Socket>();
  const posts: Array<{ host: string; body: string }> = [];
  const parentDocuments: string[] = [];

  beforeAll(async () => {
    if (!chromePath) throw new Error('Native Chrome path required');
    root = await mkdtemp(join(tmpdir(), 'browser-fill-native-'));
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
        '/CN=auth.example',
      ],
      { stdio: 'ignore' },
    );
    server = createHttpsServer(
      { key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) },
      (request, response) => {
        const host = request.headers.host ?? '';
        if (request.method === 'POST') {
          let body = '';
          request.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          request.on('end', () => {
            posts.push({ host, body });
            // The session form's document survives its submission, so its mirror of the value stays on screen.
            if (request.url === '/step/email')
              response
                .writeHead(200, { 'content-type': 'text/html' })
                .end(
                  '<h1>Password step</h1><form method="post" action="/step/password"><input name="username" type="hidden" value="principal@example.test"><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Continue</button></form>',
                );
            else if (request.url === '/session' || request.url === '/send-code') response.writeHead(204).end();
            else response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Signed in</h1>');
          });
        } else if (request.url === '/otp-send' || request.url === '/otp-send-button') {
          const scripted = request.url === '/otp-send-button';
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              `<form method="post" action="/send-code"><label>Code<input name="code" type="text" autocomplete="one-time-code"></label><button id="send" type="${scripted ? 'button' : 'submit'}">Send code</button><button type="submit" formaction="/verify-code">Verify</button></form>${scripted ? '<script>document.getElementById("send").addEventListener("click", () => fetch("/send-code", {method:"POST"}));</script>' : ''}`,
            );
        } else if (request.url === '/csrf') {
          setTimeout(() => response.writeHead(200).end('fixture-token'), 1500);
        } else if (request.url === '/signed-in') {
          response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Signed in</h1>');
        } else if (request.url === '/u/login' || request.url === '/formless') {
          const fields =
            '<label>Email<input name="username" type="email" autocomplete="email webauthn" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button id="go" type="submit" disabled>Log in</button>';
          response.writeHead(200, { 'content-type': 'text/html' }).end(
            `${request.url === '/formless' ? fields : `<form>${fields}</form>`}<script>
              const state = {};
              for (const input of document.querySelectorAll('input')) input.addEventListener('input', () => {
                state[input.name] = input.value;
                document.getElementById('go').disabled = !(state.username && state.password);
              });
              document.getElementById('go').addEventListener('click', async event => {
                event.preventDefault();
                await fetch('/sessions/create', { method:'POST', body:new URLSearchParams(state) });
                location.href = '/signed-in';
              });
            </script>`,
          );
        } else if (request.url === '/step/email') {
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              '<h1>Email step</h1><form method="post" action="/step/email"><label>Email<input name="username" type="email" autocomplete="username" required></label><button type="submit">Next</button></form>',
            );
        } else if (request.url === '/native-get') {
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              '<form><label>Password<input name="password" type="password" autocomplete="current-password"></label><button type="submit">Log in</button></form>',
            );
        } else if (
          host === 'parent.example' &&
          (request.url?.startsWith('/help/') || request.url === '/checkout/placeorder')
        ) {
          parentDocuments.push(request.url ?? '');
          // Speculation rules ask to fetch and render a purchase before anyone navigates there.
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              request.url === '/help/speculate'
                ? '<h1>Help</h1><script type="speculationrules">{"prefetch":[{"source":"list","urls":["/checkout/placeorder"]}],"prerender":[{"source":"list","urls":["/checkout/placeorder"]}]}</script>'
                : '<h1>Order</h1>',
            );
        } else if (host === 'parent.example') {
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              request.url === '/mirror'
                ? '<h1>Account</h1><iframe src="https://auth.example/session"></iframe>'
                : `<input id="untrusted"><iframe src="https://auth.example/login"></iframe><script>document.querySelector('input').addEventListener('input', e => { document.body.dataset.captured = e.target.value; });addEventListener('message', e => { if (e.data === 'steal-focus') { document.querySelector('input').focus(); document.body.dataset.stolen = 'yes'; } });</script>`,
            );
        } else {
          const action = host === 'www.amazon.com' ? '/ap/signin' : request.url === '/session' ? '/session' : '/login';
          // A page script may copy a typed value anywhere in its own document.
          const mirror =
            request.url === '/session'
              ? `<p id="mirror"></p><script>setInterval(() => { const value = document.querySelector('input').value; if (value) document.getElementById('mirror').textContent = value; }, 5);</script>`
              : '';
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              `<form id="chosen" method="post" action="${action}"><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>${mirror}${host === 'www.amazon.com' ? "<script>Object.defineProperty(HTMLInputElement.prototype, 'value', { set() { throw new Error('page setter must not run'); } });</script>" : ''}`,
            );
        }
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TLS fixture did not bind');
    proxy = createHttpServer((_request, response) => {
      response.writeHead(403).end();
    });
    // CONNECT upgrades leave closeAllConnections; retain both ends for teardown.
    proxy.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    proxy.on('connect', (request, socket, head) => {
      if (!['auth.example:443', 'parent.example:443', 'www.amazon.com:443'].includes(request.url ?? '')) {
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
    const paths = browserPaths(join(root, 'browser'));
    await prepareChromeProfile(paths);
    connection = await connectChrome(
      await spawnChrome({ chromePath, paths, proxyUrl: `http://127.0.0.1:${proxyAddress.port}` }),
      paths,
    );
    await prepareAuthenticationIsolation(connection.context);
  }, 30_000);

  beforeEach(async () => {
    logins = testLoginStore(join(root, 'browser'));
    for (const login of await logins.store.all()) await logins.store.remove(login.id, login.version);
    vi.spyOn(loginStores, 'getLoginStore').mockResolvedValue(logins.store);
    useAvailableBrowser();
    vi.stubEnv('GWS_EA_BROWSER_ROOT', join(root, 'browser'));
    await browserSiteLeasesMigration.up(await initSqliteTestDb());
    await browserSignInMigration.up(getDb());
    await getDb().exec(
      "CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('native-fill-job')",
    );
    await browserConsentMigration.up(getDb());
    posts.length = 0;
    parentDocuments.length = 0;
    const appeared = connection.context.waitForEvent('page');
    await connection.session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
    page = await appeared;
    certificateSession = await connection.context.newCDPSession(page);
    await certificateSession.send('Security.setIgnoreCertificateErrors', { ignore: true });
  });
  afterEach(async () => {
    await recoverBrowserSignInMail();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await certificateSession?.detach();
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
      job: { id: 'native-fill-job' },
      request: { id: 'native-fill-request' },
      store: { db: getDb() },
      signal: new AbortController().signal,
      remaining: () => 10_000,
      wakeWaiters: async () => undefined,
    } as unknown as BrowserExecutionContext;
  }
  async function savedFill(item: string, fields: readonly ('username' | 'password')[]) {
    const observation = await observePage(page);
    const reference = (label: string): BrowserRef => {
      const line = observation.snapshot.split('\n').find((line) => line.includes(`"${label}"`));
      const ref = line?.match(/\[ref=([^\]]+)\]/u)?.[1];
      if (!ref) throw new Error(`Missing ${label} reference`);
      return { ref, generation: observation.generation };
    };
    return executeFillSecret(context(), {
      item_handle: item,
      ...Object.fromEntries(fields.map((field) => [field, reference(field === 'username' ? 'Email' : 'Password')])),
      submit: reference(
        fields.length === 1 && fields[0] === 'username'
          ? 'Next'
          : fields.length === 1 && page.url().endsWith('/step/email')
            ? 'Continue'
            : 'Log in',
      ),
    });
  }

  for (const path of ['/u/login', '/formless']) {
    it(`signs in through a controlled ${path} page with both saved fields and its own callbacks`, async () => {
      const item = await logins.store.create({
        site: 'auth.example',
        title: 'Saved login',
        username: 'principal@example.test',
        password: secret,
      });
      await page.goto(`https://auth.example${path}`);
      const result = await savedFill(item.id, ['username', 'password']);
      await expect.poll(() => posts.length).toBe(1);
      expect(Object.fromEntries(new URLSearchParams(posts[0].body))).toEqual({
        username: 'principal@example.test',
        password: secret,
      });
      await expect.poll(() => page.locator('h1').textContent()).toBe('Signed in');
      expect(['submitted', 'cleared_after_submit']).toContain(result.status);
      expect(JSON.stringify({ result, observation: await observePage(page) })).not.toContain(secret);
    });
  }

  for (const transition of ['navigation', 'same-document'] as const) {
    it(`uses fresh references for email then password steps after ${transition}`, async () => {
      const item = await logins.store.create({
        site: 'auth.example',
        title: 'Saved login',
        username: 'principal@example.test',
        password: secret,
      });
      await page.goto('https://auth.example/step/email');
      if (transition === 'same-document')
        await page.evaluate(`
        document.querySelector('form').addEventListener('submit', async event => {
          event.preventDefault();
          const response = await fetch('/step/email', {
            method: 'POST', body: new URLSearchParams(new FormData(event.target))
          });
          document.body.innerHTML = await response.text();
          const account = document.querySelector('input[name=username]');
          account.type = 'email';
          account.readOnly = true;
        });
      `);
      expect(await savedFill(item.id, ['username'])).toMatchObject({
        status: transition === 'navigation' ? 'submitted' : 'cleared_after_submit',
      });
      await expect.poll(() => page.locator('h1').textContent()).toBe('Password step');
      expect(JSON.stringify(await observePage(page))).not.toContain('principal@example.test');
      expect(await savedFill(item.id, ['password'])).toMatchObject({ status: 'submitted' });
      expect(posts.map((post) => Object.fromEntries(new URLSearchParams(post.body)))).toEqual([
        { username: 'principal@example.test' },
        { username: 'principal@example.test', password: secret },
      ]);
      expect(await page.locator('h1').textContent()).toBe('Signed in');
    });
  }

  it('never submits a saved password in a native GET address', async () => {
    const item = await logins.store.create({
      site: 'auth.example',
      title: 'Saved login',
      username: 'principal@example.test',
      password: secret,
    });
    await page.goto('https://auth.example/native-get');
    await savedFill(item.id, ['password']);
    expect(page.url()).toBe('https://auth.example/native-get');
    expect(posts).toEqual([]);
    expect(await page.locator('input').inputValue()).toBe('');
  });

  it('refuses a saved login edited between resolving its grouped fields', async () => {
    const item = await logins.store.create({
      site: 'auth.example',
      title: 'Saved login',
      username: 'principal@example.test',
      password: secret,
    });
    const read = logins.store.secret.bind(logins.store);
    vi.spyOn(logins.store, 'secret').mockImplementation(async (...args) => {
      const value = await read(...args);
      if (args[1] === 'username')
        await logins.store.update(item.id, item.version, {
          username: 'changed@example.test',
          password: 'changed-fixture-password',
        });
      return value;
    });
    await page.goto('https://auth.example/u/login');
    expect(await savedFill(item.id, ['username', 'password'])).toEqual({ status: 'origin_mismatch' });
    expect(posts).toEqual([]);
    expect(await page.locator('input[name=username]').inputValue()).toBe('');
    expect(await page.locator('input[name=password]').inputValue()).toBe('');
  });

  it('reclassifies a sign-in control that turns into a purchase during input callbacks', async () => {
    const item = await logins.store.create({
      site: 'auth.example',
      title: 'Saved login',
      username: 'principal@example.test',
      password: secret,
    });
    await page.goto('https://auth.example/u/login');
    await page.evaluate(`
      document.querySelector('input[name=password]').addEventListener('input', () => {
        document.getElementById('go').textContent = 'Pay now';
        const username = document.querySelector('input[name=username]').value;
        const mirror = document.createElement('p');
        mirror.textContent = username;
        document.body.append(mirror);
        const copy = document.createElement('input');
        copy.type = 'hidden';
        copy.name = 'copied-account';
        copy.value = username;
        document.body.append(copy);
      });
    `);
    await expect(savedFill(item.id, ['username', 'password'])).rejects.toMatchObject({ code: 'forbidden' });
    expect(posts).toEqual([]);
    expect(await page.locator('input[name=username]').inputValue()).toBe('');
    expect(await page.locator('input[name=copied-account]').inputValue()).toBe('');
    expect(await page.locator('input[name=password]').inputValue()).toBe('');
    expect(await page.locator('p').textContent()).toBe('principal@example.test');
    expect(JSON.stringify(await observePage(page))).not.toContain('principal@example.test');
    expect(
      await executeBrowserBatch(context(), { actions: [{ kind: 'screenshot' }] }, { record: false }),
    ).toMatchObject({
      status: 'stopped',
      reason: 'secret_field',
    });
  });

  it('clears the account identifier when an input callback invalidates a filled credential group', async () => {
    const item = await logins.store.create({
      site: 'auth.example',
      title: 'Saved login',
      username: 'principal@example.test',
      password: secret,
    });
    await page.goto('https://auth.example/u/login');
    await page.evaluate(
      "document.querySelector('input[name=password]').addEventListener('input', event => { event.target.value = ''; });",
    );
    await expect(savedFill(item.id, ['username', 'password'])).rejects.toMatchObject({ code: 'forbidden' });
    expect(posts).toEqual([]);
    expect(await page.locator('input[name=username]').inputValue()).toBe('');
    expect(await page.locator('input[name=password]').inputValue()).toBe('');
  });

  it('reclassifies after a consent callback changes the sign-in control', async () => {
    const item = await logins.store.create({
      site: 'auth.example',
      title: 'Login',
      username: 'principal@example.test',
      password: secret,
    });
    await page.goto('https://auth.example/u/login');
    await page.evaluate(`
      document.querySelector('form').insertAdjacentHTML('beforeend', '<label><input id="terms" type="checkbox" required>I accept the Terms of Service</label>');
      let choices = 0;
      document.getElementById('terms').addEventListener('change', event => {
        if (event.target.checked && ++choices === 2) document.getElementById('go').textContent = 'Pay now';
      });
      document.querySelector('input[name=password]').addEventListener('input', () => { document.getElementById('terms').checked = false; });
    `);
    await expect(savedFill(item.id, ['username', 'password'])).rejects.toMatchObject({ code: 'forbidden' });
    expect(await page.locator('#go').textContent()).toBe('Pay now');
    expect(posts).toEqual([]);
    expect(await page.locator('input[name=password]').inputValue()).toBe('');
  });

  it('returns a recorded consent stop before reading saved credentials', async () => {
    const item = await logins.store.create({
      site: 'auth.example',
      title: 'Login',
      username: 'principal@example.test',
      password: secret,
    });
    const read = vi.spyOn(logins.store, 'secret');
    await page.goto('https://auth.example/u/login');
    await page.evaluate(
      `document.querySelector('form').insertAdjacentHTML('beforeend', '<label><input type="checkbox" required>I agree to binding arbitration</label>');`,
    );
    const result = await savedFill(item.id, ['username', 'password']);
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'consent_required',
      consent: [{ stop_id: expect.any(String), site: 'auth.example' }],
    });
    const stops = await getDb().all<{ id: string }>('SELECT id FROM gws_ea_browser_consent_stops');
    expect(result.consent).toMatchObject([{ stop_id: stops[0]?.id }]);
    expect(read).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('uses the submitter POST override while still cancelling an effective GET', async () => {
    const item = await logins.store.create({
      site: 'auth.example',
      title: 'Login',
      username: 'principal@example.test',
      password: secret,
    });
    await page.goto('https://auth.example/native-get');
    await page.locator('button').evaluate((node) => node.setAttribute('formmethod', 'post'));
    await savedFill(item.id, ['password']);
    expect(posts.map((post) => Object.fromEntries(new URLSearchParams(post.body)))).toEqual([{ password: secret }]);
    await page.goto('https://auth.example/native-get');
    await page.locator('form').evaluate((node) => node.setAttribute('method', 'post'));
    await page.locator('button').evaluate((node) => node.setAttribute('formmethod', 'get'));
    await savedFill(item.id, ['password']);
    expect(posts).toHaveLength(1);
    expect(page.url()).toBe('https://auth.example/native-get');
  });

  it('keeps an OTP binding usable while Send code is disabled for cooldown', async () => {
    await page.goto('https://auth.example/otp-send-button');
    const target = await page.locator('input').elementHandle();
    const submit = await page.locator('button[type=submit]').elementHandle();
    if (!target || !submit) throw new Error('Missing OTP controls');
    const bound = await bindBrowserSecretFields(
      page,
      [{ field: 'otp', target: { element: target, frame: page.mainFrame() } as PinnedBrowserRef }],
      { element: submit, frame: page.mainFrame() } as PinnedBrowserRef,
    );
    await page.locator('#send').evaluate((node) => {
      (node as unknown as { disabled: boolean }).disabled = true;
    });
    expect(await fillBoundBrowserSecrets(context(), bound, async () => ['123456'])).toEqual({ status: 'submitted' });
    expect(posts.map((post) => Object.fromEntries(new URLSearchParams(post.body)))).toEqual([{ code: '123456' }]);
  });

  it('lets a slow token callback read the filled form before cleanup', async () => {
    const item = await logins.store.create({
      site: 'auth.example',
      title: 'Login',
      username: 'principal@example.test',
      password: secret,
    });
    await page.goto('https://auth.example/u/login');
    await page.evaluate(`
      const old = document.getElementById('go');
      old.replaceWith(old.cloneNode(true));
      document.getElementById('go').addEventListener('click', async event => {
        event.preventDefault();
        await fetch('/csrf');
        await fetch('/sessions/create', {method:'POST', body:new URLSearchParams(new FormData(document.querySelector('form')))});
        location.href = '/signed-in';
      });
    `);
    await savedFill(item.id, ['username', 'password']);
    await expect.poll(() => posts.length).toBe(1);
    expect(Object.fromEntries(new URLSearchParams(posts[0].body))).toEqual({
      username: 'principal@example.test',
      password: secret,
    });
    await expect.poll(() => page.locator('h1').textContent()).toBe('Signed in');
  });

  it('allows a login beside a separate checkout and still refuses its purchase', async () => {
    const item = await logins.store.create({
      site: 'auth.example',
      title: 'Login',
      username: 'principal@example.test',
      password: secret,
    });
    await page.goto('https://auth.example/u/login');
    await page.evaluate(
      `document.body.insertAdjacentHTML('beforeend', '<form id="checkout"><p>Total: $42.00</p><p>Visa ending in 4242</p><button type="submit">Place order</button></form>');`,
    );
    const login = await page.locator('#go').elementHandle();
    const purchase = await page.locator('#checkout button').elementHandle();
    if (!login || !purchase) throw new Error('Missing controls');
    expect(await readPageControlFacts(page, login)).toMatchObject({
      transaction: true,
      region: { transaction: false },
    });
    expect(await classifyActivation(page, purchase)).toBe('purchase_control');
    await savedFill(item.id, ['username', 'password']);
    expect(posts).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(posts[0].body))).toEqual({
      username: 'principal@example.test',
      password: secret,
    });
  });

  for (const enabled of [true, false]) {
    it(`handles a control that ${enabled ? 'enables after validation' : 'stays disabled'} without repeated submission`, async () => {
      const item = await logins.store.create({
        site: 'auth.example',
        title: 'Login',
        username: 'principal@example.test',
        password: secret,
      });
      await page.goto('https://auth.example/u/login');
      await page.evaluate(
        `document.querySelector('input[name=password]').addEventListener('input', () => { document.getElementById('go').disabled = true; ${enabled ? "setTimeout(() => document.getElementById('go').disabled = false, 400);" : ''} });`,
      );
      if (enabled) {
        await savedFill(item.id, ['username', 'password']);
        expect(posts).toHaveLength(1);
      } else {
        await expect(savedFill(item.id, ['username', 'password'])).rejects.toMatchObject({ code: 'forbidden' });
        expect(posts).toEqual([]);
        expect(await page.locator('input[name=username]').inputValue()).toBe('');
        expect(await page.locator('input[name=password]').inputValue()).toBe('');
      }
    });
  }

  for (const path of ['/otp-send', '/otp-send-button']) {
    it(`opens the principal code wait after its ${path} control runs on a real code form`, async () => {
      await page.goto(`https://auth.example${path}`);
      const observation = await observePage(page);
      const ref = (label: string): BrowserRef => {
        const line = observation.snapshot.split('\n').find((line) => line.includes(`"${label}"`));
        const found = line?.match(/\[ref=([^\]]+)\]/u)?.[1];
        if (!found) throw new Error(`Missing ${label} reference`);
        return { ref: found, generation: observation.generation };
      };
      expect(
        await executeSignInCode(context(), {
          from: 'principal',
          target: ref('Code'),
          send: ref('Send code'),
          submit: ref('Verify'),
        }),
      ).toEqual({ status: 'awaiting_code', site: 'auth.example', origin: 'https://auth.example' });
      expect(posts).toHaveLength(1);
      expect(Object.fromEntries(new URLSearchParams(posts[0].body))).toEqual(path === '/otp-send' ? { code: '' } : {});
      expect(await getSignInClaim('signin-native-fill-request')).toMatchObject({
        source: 'principal',
        state: 'waiting',
        origin: 'https://auth.example',
      });
      expect(await page.locator('input[name=code]').inputValue()).toBe('');
    });
  }
  async function binding(frame: Frame, kind: BrowserSecretField = 'password') {
    const target = await frame.locator('#chosen input').elementHandle();
    const submit = await frame.locator('#chosen button').elementHandle();
    if (!target || !submit) throw new Error('Native authentication controls missing');
    return bindBrowserSecretFields(
      page,
      [{ field: kind, target: { ref: 'e1', generation: 1, element: target, frame } as PinnedBrowserRef }],
      { ref: 'e2', generation: 1, element: submit, frame } as PinnedBrowserRef,
    );
  }

  it('fills the exact cross-origin field without ambient keyboard insertion or disclosure to the focused parent', async () => {
    await page.goto('https://parent.example/login');
    const frame = page.frames().find((candidate) => candidate.url() === 'https://auth.example/login');
    if (!frame) throw new Error('Cross-origin authentication frame missing');
    const childSession = await connection.context.newCDPSession(frame);
    await childSession.detach();
    await page.locator('#untrusted').focus();
    const bound = await binding(frame);
    const nativeInsert = page.keyboard.insertText.bind(page.keyboard);
    const ambientInsert = vi.spyOn(page.keyboard, 'insertText').mockImplementation(async (value) => {
      // A regression to ambient insertion lets the page steal focus before Chrome receives the value.
      await frame.evaluate("parent.postMessage('steal-focus', 'https://parent.example')");
      await page.locator('body[data-stolen="yes"]').waitFor();
      await nativeInsert(value);
    });
    expect(await fillBoundBrowserSecrets(context(), bound, async () => [secret])).toEqual({ status: 'submitted' });
    expect(ambientInsert).not.toHaveBeenCalled();
    expect(await page.locator('body').getAttribute('data-captured')).toBeNull();
    expect(posts).toEqual([{ host: 'auth.example', body: `password=${secret}` }]);
  });

  for (const kind of ['username', 'otp'] as const) {
    it(`fills and submits a positively identified ${kind} field through the same native boundary`, async () => {
      await page.goto('https://auth.example/login');
      await page.evaluate(
        `(() => { const field = document.querySelector('input'); field.type = 'text'; field.name = ${JSON.stringify(kind)}; field.autocomplete = ${JSON.stringify(kind === 'otp' ? 'one-time-code' : 'username')}; })()`,
      );
      const bound = await binding(page.mainFrame(), kind);
      expect(await fillBoundBrowserSecrets(context(), bound, async () => [secret])).toEqual({ status: 'submitted' });
      expect(posts).toEqual([{ host: 'auth.example', body: `${kind}=${secret}` }]);
    });
  }

  for (const drift of ['field', 'form', 'action', 'readonly', 'disabled', 'document'] as const) {
    it(`refuses ${drift} drift after resolving without inserting or submitting the value`, async () => {
      await page.goto('https://auth.example/login');
      const bound = await binding(page.mainFrame());
      const filling = fillBoundBrowserSecrets(context(), bound, async () => {
        if (drift === 'document') await page.reload();
        else
          await page.evaluate(`(() => {
          const field = document.querySelector('input');
          const form = document.querySelector('form');
          const drift = ${JSON.stringify(drift)};
          if (drift === 'field') field.autocomplete = 'cc-number';
          else if (drift === 'action') form.action = '/checkout';
          else if (drift === 'readonly') field.readOnly = true;
          else if (drift === 'disabled') field.disabled = true;
          else { const replacement = form.cloneNode(false); form.replaceWith(replacement); replacement.append(...form.childNodes); }
        })()`);
        return [secret];
      });
      if (drift === 'document')
        await expect(filling).rejects.toMatchObject({
          code: 'forbidden',
          message: 'The host could not safely complete this sign-in. Take a fresh observation.',
        });
      else expect(await filling).toEqual({ status: 'origin_mismatch' });
      expect(await page.locator('input').inputValue()).toBe('');
      expect(posts).toEqual([]);
    });
  }

  it('navigates a fresh assistant page to the reviewed Amazon sign-in endpoint and submits the origin-bound native form', async () => {
    expect(page.url()).toBe('about:blank');
    const result = await executeBrowserBatch(
      context(),
      { actions: [{ kind: 'navigate', url: 'https://www.amazon.com/ap/signin' }] },
      { record: false },
    );
    expect(result).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(page.url()).toBe('https://www.amazon.com/ap/signin');
    const bound = await binding(page.mainFrame());
    expect(await fillBoundBrowserSecrets(context(), bound, async () => [secret])).toEqual({ status: 'submitted' });
    await expect.poll(() => posts.length).toBe(1);
    expect(posts).toEqual([{ host: 'www.amazon.com', body: `password=${secret}` }]);
  });

  // Pins existing taint behaviour, not frame coverage: the hosting main document carries the taint
  // for every frame under it, so a cross-site frame needs no taint entry of its own.
  it('keeps screenshots refused after a secret enters a cross-site frame, until the hosting document is gone', async () => {
    await page.goto('https://parent.example/mirror');
    const frame = page.frames().find((candidate) => candidate.url() === 'https://auth.example/session');
    if (!frame) throw new Error('Cross-origin session frame missing');
    // Playwright opens a session only for a frame Chrome runs as its own out-of-process target.
    await (await connection.context.newCDPSession(frame)).detach();
    expect(await fillBoundBrowserSecrets(context(), await binding(frame), async () => [secret])).toEqual({
      status: 'cleared_after_submit',
    });
    await expect.poll(() => frame.locator('#mirror').textContent()).toBe(secret);
    const refused = await executeBrowserBatch(context(), { actions: [{ kind: 'screenshot' }] }, { record: false });
    expect(refused).toMatchObject({ status: 'stopped', reason: 'secret_field' });
    expect(JSON.stringify(refused)).not.toContain(secret);
    // Leaving the hosting document ends its taint, together with every frame document under it.
    await executeBrowserBatch(
      context(),
      { actions: [{ kind: 'navigate', url: 'https://parent.example/login' }] },
      { record: false },
    );
    expect(
      await executeBrowserBatch(context(), { actions: [{ kind: 'screenshot' }] }, { record: false }),
    ).toMatchObject({ status: 'completed', images: [{ mime_type: 'image/png' }] });
  });

  it('loads nothing speculatively, so every page is a request the document gate decides', async () => {
    await executeBrowserBatch(
      context(),
      { actions: [{ kind: 'navigate', url: 'https://parent.example/help/speculate' }] },
      { record: false },
    );
    await page.waitForTimeout(1_500);
    expect(parentDocuments).toEqual(['/help/speculate']);
  });
});
