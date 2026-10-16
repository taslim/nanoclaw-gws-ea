/** Real Chrome pipe, background windows and TLS origins; all traffic terminates in this fixture. */
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
import { connectChromePipe, type ChromeConnection } from './connection.js';
import { executeBrowserBatch } from './executor.js';
import { bindBrowserSecretField, fillBoundBrowserSecret } from './fill.js';
import './merchant-signatures.js';
import { browserSiteLeasesMigration } from './migration.js';
import type { BrowserSecretField } from './authentication-signatures.js';
import type { PinnedBrowserRef } from './observe.js';
import { browserPaths } from './paths.js';
import type { BrowserExecutionContext } from './queue.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
const secret = 'host-only-cross-origin-fixture-value';
describe.skipIf(!chromePath)('native host secret fill', () => {
  let root: string;
  let proxy: HttpServer;
  let server: HttpsServer;
  let connection: ChromeConnection;
  let page: Page;
  let certificateSession: CDPSession;
  const sockets = new Set<Socket>();
  const posts: Array<{ host: string; body: string }> = [];

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
            response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Signed in</h1>');
          });
        } else if (host === 'parent.example') {
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              `<input id="untrusted"><iframe src="https://auth.example/login"></iframe><script>document.querySelector('input').addEventListener('input', e => { document.body.dataset.captured = e.target.value; });addEventListener('message', e => { if (e.data === 'steal-focus') { document.querySelector('input').focus(); document.body.dataset.stolen = 'yes'; } });</script>`,
            );
        } else {
          const action = host === 'www.amazon.com' ? '/ap/signin' : '/login';
          response
            .writeHead(200, { 'content-type': 'text/html' })
            .end(
              `<form id="chosen" method="post" action="${action}"><input name="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>${host === 'www.amazon.com' ? "<script>Object.defineProperty(HTMLInputElement.prototype, 'value', { set() { throw new Error('page setter must not run'); } });</script>" : ''}`,
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
    const paths = browserPaths(join(root, 'browser', 'policy.json'));
    await prepareChromeProfile(paths);
    connection = await connectChromePipe(
      spawnChrome({ chromePath, paths, proxyUrl: `http://127.0.0.1:${proxyAddress.port}` }),
      paths,
    );
    await prepareAuthenticationIsolation(connection.context);
  }, 30_000);

  beforeEach(async () => {
    vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', join(root, 'browser', 'policy.json'));
    await browserSiteLeasesMigration.up(await initSqliteTestDb());
    posts.length = 0;
    const appeared = connection.context.waitForEvent('page');
    await connection.session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
    page = await appeared;
    certificateSession = await connection.context.newCDPSession(page);
    await certificateSession.send('Security.setIgnoreCertificateErrors', { ignore: true });
  });
  afterEach(async () => {
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
  async function binding(frame: Frame, kind: BrowserSecretField = 'password') {
    const target = await frame.locator('#chosen input').elementHandle();
    const submit = await frame.locator('#chosen button').elementHandle();
    if (!target || !submit) throw new Error('Native authentication controls missing');
    return bindBrowserSecretField(
      page,
      { ref: 'e1', generation: 1, element: target, frame } as PinnedBrowserRef,
      { ref: 'e2', generation: 1, element: submit, frame } as PinnedBrowserRef,
      kind,
    );
  }

  it('never sends a secret to the cross-origin parent when focus is stolen at the native insertion boundary', async () => {
    await page.goto('https://parent.example/login');
    const frame = page.frames().find((candidate) => candidate.url() === 'https://auth.example/login');
    if (!frame) throw new Error('Cross-origin authentication frame missing');
    const childSession = await connection.context.newCDPSession(frame);
    await childSession.detach();
    await page.locator('#untrusted').focus();
    const bound = await binding(frame);
    const nativeInsert = page.keyboard.insertText.bind(page.keyboard);
    vi.spyOn(page.keyboard, 'insertText').mockImplementation(async (value) => {
      // Deterministically schedule the renderer's focus theft after all host checks,
      // before Chrome processes ambient insertion. No secret is supplied to page JS.
      await frame.evaluate("parent.postMessage('steal-focus', 'https://parent.example')");
      await page.locator('body[data-stolen="yes"]').waitFor();
      await nativeInsert(value);
    });
    await fillBoundBrowserSecret(context(), bound, async () => secret).catch(() => undefined);
    expect(await page.locator('body').getAttribute('data-captured')).toBeNull();
    expect(posts.every((post) => post.host === 'auth.example')).toBe(true);
    expect(posts).toEqual([{ host: 'auth.example', body: `password=${secret}` }]);
  });

  for (const kind of ['username', 'otp'] as const) {
    it(`fills and submits a positively identified ${kind} field through the same native boundary`, async () => {
      await page.goto('https://auth.example/login');
      await page.evaluate(
        `(() => { const field = document.querySelector('input'); field.type = 'text'; field.name = ${JSON.stringify(kind)}; field.autocomplete = ${JSON.stringify(kind === 'otp' ? 'one-time-code' : 'username')}; })()`,
      );
      const bound = await binding(page.mainFrame(), kind);
      expect(await fillBoundBrowserSecret(context(), bound, async () => secret)).toEqual({ status: 'submitted' });
      expect(posts).toEqual([{ host: 'auth.example', body: `${kind}=${secret}` }]);
    });
  }

  for (const drift of ['field', 'form', 'action', 'readonly', 'disabled', 'document'] as const) {
    it(`refuses ${drift} drift after resolving without inserting or submitting the value`, async () => {
      await page.goto('https://auth.example/login');
      const bound = await binding(page.mainFrame());
      const filling = fillBoundBrowserSecret(context(), bound, async () => {
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
        return secret;
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
    expect(await fillBoundBrowserSecret(context(), bound, async () => secret)).toEqual({ status: 'submitted' });
    await expect.poll(() => posts.length).toBe(1);
    expect(posts).toEqual([{ host: 'www.amazon.com', body: `password=${secret}` }]);
  });
});
