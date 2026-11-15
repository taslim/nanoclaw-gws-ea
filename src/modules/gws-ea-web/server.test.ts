import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestListener,
  type Server,
} from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DENY, defineGuardedAction } from '../../guard/index.js';
import { createWebIdentity } from './access.js';
import type { WebMount } from './mounts.js';
import type { WebPolicyFile } from './policy.js';
import { createWebHandler, principalGate, type WebRoute } from './server.js';

vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../gws-ea-profile/db.js', () => ({
  listPrincipalAddresses: async () => [{ email: 'morgan@example.com', added_at: '2026-11-01T00:00:00.000Z' }],
}));

const HOST = 'aya.example.com';
const SANDBOX = "default-src 'none'; frame-ancestors 'self'; sandbox allow-scripts";
const linkGuard = defineGuardedAction({ action: 'test.web-server-link', decide: () => DENY('test') });
let root: string;
let server: Server | undefined;
let verified: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'web-server-'));
  const config: WebPolicyFile = {
    schemaVersion: 1,
    enabled: true,
    hostname: HOST,
    listenPort: 8443,
    accessIssuer: 'https://team.cloudflareaccess.com',
    accessAud: 'aud',
    cloudflare: { accountId: 'account', applicationId: 'app', operatorConfigFile: path.join(root, 'config.json') },
  };
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify(config), { mode: 0o600 });
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', path.join(root, 'policy.json'));
  verified = [];
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function mount(overrides: Partial<WebMount> & Pick<WebMount, 'name' | 'audience' | 'path'>): WebMount {
  const handler = (): RequestListener => () => undefined;
  return overrides.audience === 'principal'
    ? {
        methods: ['GET', 'HEAD', 'POST'],
        title: 'Page',
        status: async () => 'ready',
        linkGuard,
        handler,
        ...overrides,
        audience: 'principal',
      }
    : {
        methods: ['GET', 'HEAD'],
        handler,
        admissionEmails: async () => [],
        authoredContent: (pathname: string) => pathname.endsWith('/frame'),
        ...overrides,
        audience: 'artifact-readers',
      };
}

async function fixture(
  artifact: RequestListener = (_request, response) => response.end('artifact'),
  principalPage: RequestListener = (_request, response) => response.end('logins'),
) {
  const artifacts = vi.fn<RequestListener>(artifact);
  const logins = vi.fn<RequestListener>(principalPage);
  const home = vi.fn<RequestListener>((_request, response) => response.end('home'));
  const routes: WebRoute[] = [
    { mount: mount({ name: 'artifacts', audience: 'artifact-readers', path: '/artifacts' }), listener: artifacts },
    { mount: mount({ name: 'logins', audience: 'principal', path: '/logins' }), listener: logins },
    { mount: mount({ name: 'home', audience: 'principal', path: '/' }), listener: home },
  ];
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'policy.json'), 'utf8')) as WebPolicyFile;
  const identity = createWebIdentity(policy, async (token) => {
    if (token) verified.push(token);
    if (token === 'broken') throw new Error('Access keys unreachable');
    return token === 'principal' ? 'morgan@example.com' : token === 'reader' ? 'juno@example.com' : undefined;
  });
  server = createServer(createWebHandler(HOST, routes, principalGate(identity)));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const request = (
    route: string,
    options: { method?: string; host?: string; as?: string } = {},
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: string } | { reset: true }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          method: options.method ?? 'GET',
          path: route,
          headers: { host: options.host ?? HOST, ...(options.as ? { 'cf-access-jwt-assertion': options.as } : {}) },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
          res.on('error', (error: NodeJS.ErrnoException) =>
            error.code === 'ECONNRESET' ? resolve({ reset: true }) : reject(error),
          );
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) =>
        error.code === 'ECONNRESET' ? resolve({ reset: true }) : reject(error),
      );
      req.end();
    });
  const status = async (...args: Parameters<typeof request>): Promise<number | 'reset'> => {
    const response = await request(...args);
    return 'reset' in response ? 'reset' : response.status;
  };
  return { artifacts, logins, home, request, status };
}

it('admits only the verified principal to a principal mount; an invited reader gets not-found unseen', async () => {
  const { logins, home, request, status } = await fixture();
  for (const as of ['reader', 'unverifiable', undefined]) {
    expect(await status('/logins', { as }), as).toBe(404);
    expect(await status('/logins/add', { method: 'POST', as }), as).toBe(404);
    expect(await status('/', { as }), as).toBe(404);
  }
  expect(logins).not.toHaveBeenCalled();
  expect(home).not.toHaveBeenCalled();
  expect(await request('/logins', { as: 'principal' })).toMatchObject({ status: 200, body: 'logins' });
  expect(await request('/logins/add', { method: 'POST', as: 'principal' })).toMatchObject({ body: 'logins' });
  expect(await request('/', { as: 'principal' })).toMatchObject({ status: 200, body: 'home' });
  expect(logins).toHaveBeenCalledTimes(2);
});

it('answers not-found without reaching the page when the identity check itself fails', async () => {
  const { logins, home, status } = await fixture();
  expect(await status('/logins', { as: 'broken' })).toBe(404);
  expect(await status('/', { as: 'broken' })).toBe(404);
  expect(verified).toEqual(['broken', 'broken']);
  expect(logins).not.toHaveBeenCalled();
  expect(home).not.toHaveBeenCalled();
});

it('ends the request when a verified principal page throws, resetting it once headers went out', async () => {
  const cases: readonly [RequestListener, number | 'reset'][] = [
    [
      () => {
        throw new Error('page failed before answering');
      },
      404,
    ],
    [
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('partial');
        throw new Error('page failed mid-answer');
      },
      'reset',
    ],
  ];
  for (const [page, expected] of cases) {
    const { logins, status } = await fixture(undefined, page);
    expect(await status('/logins', { as: 'principal' }), page.toString()).toBe(expected);
    expect(logins).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

it('refuses encoded slashes and dot segments before any handler or identity check', async () => {
  const { artifacts, logins, home, status } = await fixture();
  for (const route of [
    '/logins/%2e%2e/x',
    '/logins/%2E%2E/x',
    '/logins%2Fx',
    '/logins%2fx',
    '/artifacts/../logins',
    '/artifacts/./id',
    '/artifacts/%2e/id',
    '/artifacts%5c..%5clogins',
    '/artifacts\\..\\logins',
    '/artifacts//id',
    '/logins/',
  ])
    expect(await status(route, { as: 'principal' }), route).toBe(404);
  expect(artifacts).not.toHaveBeenCalled();
  expect(logins).not.toHaveBeenCalled();
  expect(home).not.toHaveBeenCalled();
  expect(verified).toEqual([]);
});

it('answers unregistered paths with closed not-found headers and disallowed methods with 405', async () => {
  const { artifacts, logins, request, status } = await fixture();
  for (const route of [
    '/artifact',
    '/artifactsx',
    '/other',
    '/%61rtifacts/id',
    '//artifacts/id',
    '/loginsx',
    '/%6cogins',
  ]) {
    const response = await request(route, { as: 'principal' });
    if ('reset' in response) throw new Error(`${route} was reset`);
    expect(response.status, route).toBe(404);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS'])
    expect(await status('/artifacts/id', { method })).toBe(405);
  for (const method of ['PUT', 'DELETE']) {
    expect(await status('/logins', { method, as: 'principal' })).toBe(405);
    expect(await status('/logins', { method, as: 'reader' })).toBe(404);
  }
  expect(artifacts).not.toHaveBeenCalled();
  expect(logins).not.toHaveBeenCalled();
  expect(await request('/artifacts/id')).toMatchObject({ status: 200, body: 'artifact' });
  expect(await request('/artifacts/id', { method: 'HEAD' })).toMatchObject({ status: 200, body: '' });
});

it('refuses a wrong Host header before any mount or identity check runs', async () => {
  const { artifacts, logins, status } = await fixture();
  for (const host of ['juno.example.com', `${HOST}:443`, `${HOST}.`, 'AYA.example.com']) {
    expect(await status('/artifacts/id', { host })).toBe(404);
    expect(await status('/logins', { host, as: 'principal' })).toBe(404);
  }
  expect(artifacts).not.toHaveBeenCalled();
  expect(logins).not.toHaveBeenCalled();
  expect(verified).toEqual([]);
});

it('drops an authored-content response of any status unless every policy it sends has an opaque-origin sandbox', async () => {
  const cases: readonly [string, RequestListener, number | 'reset'][] = [
    [
      '/artifacts/id/frame',
      (_request, response) => response.writeHead(200, { 'content-security-policy': SANDBOX }).end('x'),
      200,
    ],
    ['/artifacts/id/frame', (_request, response) => response.writeHead(200).end('x'), 'reset'],
    [
      '/artifacts/id/frame',
      (_request, response) =>
        response.writeHead(200, { 'content-security-policy': `${SANDBOX} allow-same-origin` }).end('x'),
      'reset',
    ],
    [
      '/artifacts/id/frame',
      (_request, response) => {
        response.setHeader('content-security-policy', "default-src 'none'");
        response.end('x');
      },
      'reset',
    ],
    [
      '/artifacts/id/frame',
      (_request, response) => {
        response.setHeader('content-security-policy', SANDBOX);
        response.end('x');
      },
      200,
    ],
    [
      '/artifacts/id/frame',
      (_request, response) => {
        response.setHeader('content-security-policy', SANDBOX);
        response.writeHead(200, { 'content-security-policy': "default-src 'self' 'unsafe-inline'" }).end('x');
      },
      'reset',
    ],
    [
      '/artifacts/id/frame',
      (_request, response) =>
        response
          .writeHead(200, { 'content-security-policy': "default-src 'none'; sandbox\u00a0allow-scripts" })
          .end('x'),
      'reset',
    ],
    [
      '/artifacts/id/frame',
      (_request, response) =>
        response.writeHead(200, { 'content-security-policy': `default-src *, ${SANDBOX}` }).end('x'),
      'reset',
    ],
    [
      '/artifacts/id/frame',
      (_request, response) =>
        response
          .writeHead(200, { 'content-security-policy': `sandbox allow-same-origin allow-scripts; ${SANDBOX}` })
          .end('x'),
      'reset',
    ],
    [
      '/artifacts/id/frame',
      (_request, response) => response.writeHead(404, 'Not Found', { 'content-security-policy': SANDBOX }).end(),
      404,
    ],
    [
      '/artifacts/id/frame',
      (_request, response) =>
        response.writeHead(404, { 'content-type': 'text/html' }).end('<script>parent.postMessage(1, "*")</script>'),
      'reset',
    ],
    ['/artifacts/id/frame', (_request, response) => response.writeHead(503).end(), 'reset'],
    [
      '/artifacts/id',
      (_request, response) => response.writeHead(200, { 'content-security-policy': "default-src 'none'" }).end('shell'),
      200,
    ],
  ];
  for (const [route, listener, expected] of cases) {
    const { status } = await fixture(listener);
    expect(await status(route), `${route} ${listener.toString()}`).toBe(expected);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
