/** Real Chrome carries principal cookies; denied requests must never arrive at the TLS server. */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { deriveGcpClaims } from '../../gws-ea/gcp-identity.js';
import { writeWebOperatorConfig } from '../../gws-ea/web-cloudflare.js';
import { documentGate } from './document-gate.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
const INSTANCE = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
describe.skipIf(!chromePath)('native saved-login browser exclusion', { timeout: 30_000 }, () => {
  let root: string;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let sites: HttpsServer;
  let proxy: HttpServer;
  const sockets = new Set<Socket>();
  const requests: Array<{ method: string; url: string; cookie: string }> = [];

  beforeAll(async () => {
    if (!chromePath) throw new Error('Native Chrome path required');
    root = await mkdtemp(join(tmpdir(), 'browser-management-native-'));
    vi.stubEnv('GWS_EA_CONFIG_ROOT', root);
    const policyFile = join(root, 'web-policy.json');
    vi.stubEnv('GWS_EA_WEB_POLICY_FILE', policyFile);
    await writeFile(
      policyFile,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        hostname: 'aya.example.com',
        listenPort: 41234,
        accessIssuer: 'https://team.cloudflareaccess.com',
        accessAud: 'aud',
        cloudflare: {
          accountId: 'account',
          applicationId: 'app',
          operatorConfigFile: join(root, 'web', 'config.json'),
        },
      }),
      { mode: 0o600 },
    );
    await mkdir(join(root, 'web'), { mode: 0o700 });
    await writeWebOperatorConfig(join(root, 'web', 'config.json'), {
      schemaVersion: 1,
      accountId: 'account',
      zoneId: 'zone',
      zoneApex: 'example.com',
      teamName: 'team',
      credentialFile: join(root, 'web', 'management-token'),
      cloudflaredPath: '/usr/local/bin/cloudflared',
      dns: {},
      assistants: { [INSTANCE]: { enabled: false, claim: { hostname: 'sage.example.com', listen_port: 41238 } } },
    });
    await writeFile(
      join(root, 'instances.json'),
      JSON.stringify({
        schema_version: 3,
        instances: {
          [INSTANCE]: {
            instance_id: INSTANCE,
            release_track: 'test',
            source_remote: 'https://github.com/example/nanoclaw',
            deployed_commit: 'a'.repeat(40),
            allocated_ports: { onecli_app: 41235, onecli_gateway: 41236 },
            exclusive_resource_claims: {
              ...deriveGcpClaims(INSTANCE),
              gcp_account: 'operator@example.com',
              workspace_email: 'juno@example.com',
              onecli_project: 'juno',
              web: { hostname: 'juno.example.com', listen_port: 41237 },
            },
          },
        },
      }),
      { mode: 0o600 },
    );
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
        '/CN=aya.example.com',
      ],
      { stdio: 'ignore' },
    );
    sites = createHttpsServer(
      { key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) },
      (request, response) => {
        const url = `https://${request.headers.host ?? ''}${request.url ?? '/'}`;
        requests.push({ method: request.method ?? 'GET', url, cookie: request.headers.cookie ?? '' });
        if (request.url === '/redirect') {
          response.writeHead(302, { location: 'https://aya.example.com/logins/item/id/reveal' }).end();
        } else if (request.url === '/worker.js') {
          response
            .writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
            .end(
              "fetch('/logins/item/id/reveal', {credentials:'include'}).then(() => postMessage('reached'), () => postMessage('blocked'));",
            );
        } else {
          response
            .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
            .end('<h1>Public fixture</h1>');
        }
      },
    );
    await new Promise<void>((resolve) => sites.listen(0, '127.0.0.1', resolve));
    const address = sites.address();
    if (!address || typeof address === 'string') throw new Error('TLS fixture did not bind');
    proxy = createHttpServer((_request, response) => response.writeHead(403).end());
    proxy.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    proxy.on('connect', (request, socket, head) => {
      if (
        !['aya.example.com:443', 'juno.example.com:443', 'sage.example.com:443', 'shop.example:443'].includes(
          request.url ?? '',
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
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Proxy fixture did not bind');
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      proxy: { server: `http://127.0.0.1:${proxyAddress.port}` },
      args: ['--ignore-certificate-errors'],
    });
    await documentGate(browser);
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies(
      ['aya.example.com', 'juno.example.com', 'sage.example.com'].map((domain) => ({
        name: 'CF_Authorization',
        value: 'principal-native-fixture-cookie',
        domain,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax' as const,
      })),
    );
    page = await context.newPage();
  });
  afterAll(async () => {
    await browser?.close();
    for (const socket of sockets) socket.destroy();
    sites?.closeAllConnections();
    proxy?.closeAllConnections();
    await Promise.all([
      sites ? new Promise<void>((resolve) => sites.close(() => resolve())) : undefined,
      proxy ? new Promise<void>((resolve) => proxy.close(() => resolve())) : undefined,
    ]);
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('stops navigation, redirect, popup, frame, fetch, XHR and worker requests before cookies reach the login mount', async () => {
    for (const hostname of ['aya.example.com', 'juno.example.com', 'sage.example.com']) {
      const denied = await context.newPage();
      await expect(denied.goto(`https://${hostname}/logins/item/id/reveal`)).rejects.toThrow('ERR_BLOCKED_BY_CLIENT');
      await denied.close();
      await page.goto(`https://${hostname}/artifacts/allowed`);
    }
    await page.goto('https://aya.example.com/public');
    expect(
      await page.evaluate(
        `Promise.all(['GET','HEAD','POST','PUT'].map(method => fetch('/logins/item/id/reveal', {method, credentials:'include', headers:{'X-Principal':'true'}}).then(() => 'reached', () => 'blocked')))`,
      ),
    ).toEqual(['blocked', 'blocked', 'blocked', 'blocked']);
    expect(
      await page.evaluate(
        `new Promise(resolve => { const request = new XMLHttpRequest(); request.open('POST', '/logins/item/id/reveal'); request.onload = () => resolve('reached'); request.onerror = () => resolve('blocked'); request.send(); })`,
      ),
    ).toBe('blocked');
    expect(
      await page.evaluate(
        `new Promise(resolve => { const worker = new Worker('/worker.js'); worker.onmessage = event => { worker.terminate(); resolve(event.data); }; worker.onerror = () => { worker.terminate(); resolve('worker-error'); }; })`,
      ),
    ).toBe('blocked');
    const frameFailed = context.waitForEvent('requestfailed', {
      predicate: (request) => request.url().includes('/logins?frame'),
      timeout: 5_000,
    });
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend', '<iframe src="/logins?frame"></iframe>')`);
    await frameFailed;
    const popupFailed = context.waitForEvent('requestfailed', {
      predicate: (request) => request.url().includes('/logins?popup'),
      timeout: 5_000,
    });
    await page.evaluate(`window.open('/logins?popup', '_blank') !== null`);
    await popupFailed;
    const redirected = await context.newPage();
    await expect(redirected.goto('https://shop.example/redirect')).rejects.toThrow('ERR_BLOCKED_BY_CLIENT');
    await redirected.close();
    await page.goto('https://shop.example/logins');
    expect(requests.filter(({ url }) => /https:\/\/(?:aya|juno|sage)\.example\.com\/logins/u.test(url))).toEqual([]);
    for (const hostname of ['aya.example.com', 'juno.example.com', 'sage.example.com'])
      expect(requests).toContainEqual({
        method: 'GET',
        url: `https://${hostname}/artifacts/allowed`,
        cookie: 'CF_Authorization=principal-native-fixture-cookie',
      });
    expect(requests.some(({ url }) => url === 'https://shop.example/logins')).toBe(true);
  });
});
