import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EgressError, publicFetch, type EgressDependencies, type PublicFetchOptions } from './fetch.js';

const dnsBoundary = vi.hoisted(() => ({
  lookup:
    vi.fn<
      (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>
    >(),
}));
vi.mock('node:dns/promises', async () => {
  const actual = await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises');
  return { ...actual, default: { ...actual, lookup: dnsBoundary.lookup } };
});

const HOST = 'mcp.example.test';
const SENTINEL = 'sentinel-body-7f3a';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let certificate: string;
let server: https.Server;
let port: number;
let handler: (request: http.IncomingMessage, response: http.ServerResponse) => void;
const seen: Seen[] = [];
const resolved: string[] = [];
const dialed: string[] = [];

beforeAll(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${HOST}`,
        '-addext',
        `subjectAltName=DNS:${HOST}`,
        '-keyout',
        path.join(directory, 'key.pem'),
        '-out',
        path.join(directory, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    certificate = fs.readFileSync(path.join(directory, 'cert.pem'), 'utf8');
    const key = fs.readFileSync(path.join(directory, 'key.pem'), 'utf8');
    server = https.createServer({ key, cert: certificate }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        handler(request, response);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  server.closeAllConnections();
  seen.length = 0;
  resolved.length = 0;
  dialed.length = 0;
  dnsBoundary.lookup.mockReset();
  vi.unstubAllEnvs();
});

/** The fixture stands in for the public address: the resolver pins it, and TLS is still checked against the hostname. */
const connectLoopback: EgressDependencies['connect'] = ({ address, port: pinnedPort, servername }) => {
  dialed.push(`${servername}@${address}:${pinnedPort}`);
  return tls.connect({ host: '127.0.0.1', port, servername, ca: certificate });
};
const loopback: Partial<EgressDependencies> = {
  resolve: async (target) => {
    resolved.push(target.hostname);
    return { address: '127.0.0.1', family: 4, port: 443 };
  },
  connect: connectLoopback,
};

function client(options: PublicFetchOptions, overrides: Partial<EgressDependencies> = {}) {
  return publicFetch(options, { ...loopback, ...overrides });
}

async function failure(promise: Promise<unknown>): Promise<EgressError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof EgressError)) throw new Error('Expected an egress error');
  return error;
}

function reply(status: number, headers: http.OutgoingHttpHeaders, body = ''): typeof handler {
  return (_request, response) => {
    response.writeHead(status, headers);
    response.end(body);
  };
}

describe('public fetch', () => {
  it('sends a token-shaped request to the pinned address and returns a standard response', async () => {
    handler = reply(200, { 'content-type': 'application/json' }, '{"access_token":"issued"}');
    const response = await client({ redirect: 'none' })(`https://${HOST}/token?x=1`, {
      method: 'POST',
      headers: { authorization: 'Basic Y2xpZW50OnNlY3JldA==', host: 'elsewhere.example.test' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ access_token: 'issued' });
    expect(dialed).toEqual([`${HOST}@127.0.0.1:443`]);
    expect(seen).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/token?x=1',
        body: 'grant_type=authorization_code&code=abc',
        headers: expect.objectContaining({
          host: HOST,
          authorization: 'Basic Y2xpZW50OnNlY3JldA==',
          'accept-encoding': 'identity',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        }),
      }),
    ]);
  });

  it('refuses a name the public policy refuses, without dialing', async () => {
    dnsBoundary.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const fetch = publicFetch({ redirect: 'none' }, { connect: connectLoopback });
    expect((await failure(fetch(`https://${HOST}/mcp`))).code).toBe('refused');
    expect(dialed).toEqual([]);
  });

  it.each(['https://0x7f000001/token', 'https://0177.0.0.1/token', 'https://2130706433/token'])(
    'refuses the private literal %s without a lookup',
    async (url) => {
      const fetch = publicFetch({ redirect: 'none' }, { connect: connectLoopback });
      expect((await failure(fetch(url))).code).toBe('refused');
      expect(dnsBoundary.lookup).not.toHaveBeenCalled();
      expect(dialed).toEqual([]);
    },
  );

  it.each([`http://${HOST}/token`, `https://${HOST}:8443/token`, `https://juno:hale@${HOST}/token`])(
    'refuses %s before resolving',
    async (url) => {
      expect((await failure(client({ redirect: 'same-host' })(url))).code).toBe('refused');
      expect(resolved).toEqual([]);
    },
  );

  it('verifies TLS against the original hostname', async () => {
    handler = reply(200, {}, 'ok');
    const fetch = client(
      { redirect: 'none' },
      { connect: (endpoint) => connectLoopback({ ...endpoint, servername: 'other.example.test' }) },
    );
    expect((await failure(fetch(`https://${HOST}/mcp`))).code).toBe('failed');
    expect(seen).toEqual([]);
  });

  it('refuses a 307 on a token request without following it', async () => {
    handler = (request, response) => {
      if (request.url === '/token') {
        response.writeHead(307, { location: `https://${HOST}/elsewhere` });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end('{}');
    };
    const fetch = client({ redirect: 'none' });
    const error = await failure(fetch(`https://${HOST}/token`, { method: 'POST', body: 'code=abc' }));
    expect(error.code).toBe('refused');
    expect((await failure(fetch(`https://${HOST}/token`))).code).toBe('refused');
    expect(seen.map(({ url }) => url)).toEqual(['/token', '/token']);
  });

  it('refuses a metadata redirect to another host', async () => {
    handler = reply(302, { location: 'https://issuer.example.test/.well-known/oauth-authorization-server' });
    const fetch = client({ redirect: 'same-host', json: true });
    expect((await failure(fetch(`https://${HOST}/.well-known/oauth-protected-resource`))).code).toBe('refused');
    expect(resolved).toEqual([HOST]);
  });

  it('follows a same-host metadata redirect, checks it again and drops Authorization', async () => {
    handler = (request, response) => {
      if (request.url === '/.well-known/oauth-protected-resource') {
        response.writeHead(301, { location: '/.well-known/oauth-protected-resource/mcp' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(`{"resource":"https://${HOST}/mcp"}`);
    };
    const fetch = client({ redirect: 'same-host', json: true });
    const response = await fetch(`https://${HOST}/.well-known/oauth-protected-resource`, {
      headers: { authorization: 'Bearer never-forwarded', 'mcp-protocol-version': '2025-06-18' },
    });
    await expect(response.json()).resolves.toEqual({ resource: `https://${HOST}/mcp` });
    expect(resolved).toEqual([HOST, HOST]);
    expect(seen.map(({ url }) => url)).toEqual([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]);
    expect(seen[0].headers.authorization).toBe('Bearer never-forwarded');
    expect(seen[1].headers.authorization).toBeUndefined();
    expect(seen[1].headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('refuses a same-host redirect to http', async () => {
    handler = reply(302, { location: `http://${HOST}/.well-known/oauth-protected-resource` });
    const fetch = client({ redirect: 'same-host', json: true });
    expect((await failure(fetch(`https://${HOST}/.well-known/oauth-protected-resource`))).code).toBe('refused');
    expect(resolved).toEqual([HOST]);
  });

  it('reads metadata only as JSON, and still hands back a failed lookup', async () => {
    handler = reply(200, { 'content-type': 'text/html' }, `<p>${SENTINEL}</p>`);
    const fetch = client({ redirect: 'same-host', json: true });
    const error = await failure(fetch(`https://${HOST}/.well-known/oauth-authorization-server`));
    expect(error.code).toBe('refused');
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
    expect(error.message).not.toContain(SENTINEL);

    handler = reply(200, { 'content-type': 'application/json' }, `{"issuer": ${SENTINEL}`);
    const malformed = await failure(fetch(`https://${HOST}/.well-known/oauth-authorization-server`));
    expect(malformed.code).toBe('refused');
    expect(malformed.message).not.toContain(SENTINEL);
    expect(malformed.cause).toBeUndefined();

    handler = reply(200, { 'content-type': 'text/plain' }, '{"issuer":"https://mcp.example.test"}');
    expect((await failure(fetch(`https://${HOST}/.well-known/oauth-authorization-server`))).code).toBe('refused');

    handler = reply(404, { 'content-type': 'text/html' }, 'not here');
    expect((await fetch(`https://${HOST}/.well-known/openid-configuration`)).status).toBe(404);
  });

  it('does not route through a proxy named in the environment', async () => {
    const proxyHits: string[] = [];
    const proxy = http.createServer((request, response) => {
      proxyHits.push(request.url ?? '');
      response.writeHead(502);
      response.end();
    });
    proxy.on('connect', (request: http.IncomingMessage, socket: Duplex) => {
      proxyHits.push(request.url ?? '');
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    vi.stubEnv('HTTPS_PROXY', proxyUrl);
    vi.stubEnv('https_proxy', proxyUrl);
    vi.stubEnv('ALL_PROXY', proxyUrl);
    try {
      handler = reply(200, {}, 'direct');
      const response = await client({ redirect: 'none' })(`https://${HOST}/mcp`, { method: 'POST', body: '{}' });
      await expect(response.text()).resolves.toBe('direct');
      expect(proxyHits).toEqual([]);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it.each([
    ['a declared length', true],
    ['a streamed body', false],
  ])('refuses an oversized body with %s and never surfaces it', async (_label, declared) => {
    const body = SENTINEL.repeat(Math.ceil((1024 * 1024 + 1) / SENTINEL.length));
    handler = (_request, response) => {
      response.writeHead(200, declared ? { 'content-length': Buffer.byteLength(body) } : {});
      response.end(body);
    };
    const error = await failure(client({ redirect: 'none' })(`https://${HOST}/token`, { method: 'POST' }));
    expect(error.code).toBe('refused');
    expect(error.message).not.toContain(SENTINEL);
    expect(error.cause).toBeUndefined();
  });

  it('refuses an encoded body it could not cap before decoding', async () => {
    handler = reply(200, { 'content-encoding': 'gzip' }, 'compressed');
    expect((await failure(client({ redirect: 'none' })(`https://${HOST}/token`))).code).toBe('refused');
  });

  it('ends a slow server with a timeout', async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      response.write(SENTINEL);
    };
    const error = await failure(client({ redirect: 'none' }, { timeoutMs: 150 })(`https://${HOST}/token`));
    expect(error.code).toBe('timeout');
    expect(error.message).not.toContain(SENTINEL);
  });

  it('ends a server that never answers with a timeout', async () => {
    handler = () => undefined;
    const error = await failure(client({ redirect: 'none' }, { timeoutMs: 150 })(`https://${HOST}/token`));
    expect(error.code).toBe('timeout');
  });

  it('stops when the caller aborts', async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const pending = client({ redirect: 'none' })(`https://${HOST}/token`, { signal: controller.signal });
    controller.abort();
    expect((await failure(pending)).code).toBe('failed');
  });
});
