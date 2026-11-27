import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { checkPastedToken, probeApp } from './probe.js';
import {
  FakeMcpApp,
  legacyMcpReply,
  startFakeEndpoints,
  type FakeEndpoints,
  type FakeHandler,
} from './testing/oauth-server.js';

const LEDGERLY = 'https://app.ledgerly.example.test/mcp';
const LEDGER = 'https://mcp.ledger.example.test/mcp';
const SHOP = 'https://mcp.shop.com/';

let endpoints: FakeEndpoints;

beforeAll(async () => {
  endpoints = await startFakeEndpoints([
    'app.ledgerly.example.test',
    'mcp.ledger.example.test',
    'auth.example.test',
    'mcp.shop.com',
    'accounts.shop.app',
  ]);
});
afterAll(async () => {
  await endpoints.close();
});
beforeEach(() => {
  endpoints.reset();
});

function serve(...handlers: FakeHandler[]): void {
  for (const handler of handlers) endpoints.use(handler);
}

function ledgerly(): FakeMcpApp {
  return new FakeMcpApp({
    appUrl: LEDGERLY,
    issuer: 'https://app.ledgerly.example.test',
    tokenAuthMethods: ['client_secret_basic'],
    scopes: ['ledgerly.read', 'ledgerly.write'],
  });
}

/** A 2025 server without sign-in, answering in JSON or as an event stream. */
const legacy =
  (serverInfo: { readonly name: string; readonly version: string }, stream = false): FakeHandler =>
  (request) => {
    if (request.method !== 'POST') return undefined;
    const reply = legacyMcpReply(request, serverInfo);
    return stream && reply.body !== undefined
      ? {
          status: reply.status,
          headers: { 'content-type': 'text/event-stream' },
          body: `event: message\ndata: ${JSON.stringify(reply.body)}\n\n`,
        }
      : reply;
  };

describe('probeApp', () => {
  it('classifies a server that answers without sign-in, keeping the name it advertises', async () => {
    serve(legacy({ name: 'Ledger', version: '2' }));
    expect(await probeApp(LEDGER, { fetches: endpoints.fetches })).toEqual({
      status: 'ok',
      method: { kind: 'none' },
      advertisedName: 'Ledger',
    });
    expect(endpoints.requests.every((request) => request.headers.authorization === undefined)).toBe(true);
    expect(endpoints.requests.map((request) => (JSON.parse(request.body) as { method: string }).method)).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
    ]);
  });

  it('reads an event-stream answer and drops an advertised name unfit to show', async () => {
    serve(legacy({ name: 'Led\u0007ger', version: '2' }, true));
    expect(await probeApp(LEDGER, { fetches: endpoints.fetches })).toEqual({
      status: 'ok',
      method: { kind: 'none' },
      advertisedName: undefined,
    });
  });

  it('classifies a 401 without protected-resource metadata as a pasted token', async () => {
    serve((request) => (request.method === 'POST' ? { status: 401, body: { error: 'unauthorized' } } : undefined));
    expect(await probeApp(LEDGER, { fetches: endpoints.fetches })).toEqual({
      status: 'ok',
      method: { kind: 'token' },
      advertisedName: undefined,
    });
  });

  it('classifies a Ledgerly-shaped server as OAuth that needs client details', async () => {
    serve(ledgerly().handle);
    const outcome = await probeApp(LEDGERLY, { fetches: endpoints.fetches, assistantHost: 'juno.example.test' });
    expect(outcome).toMatchObject({
      status: 'ok',
      method: {
        kind: 'oauth',
        issuer: 'https://app.ledgerly.example.test/',
        dynamicRegistration: false,
        clientAuthMethods: ['client_secret_basic'],
        scope: 'ledgerly.read ledgerly.write',
      },
    });
  });

  it('classifies a server whose metadata offers registration as automatic registration, with the scope its 401 asks for', async () => {
    const ledger = new FakeMcpApp({ appUrl: LEDGER, issuer: 'https://auth.example.test', registration: true });
    serve((request) =>
      request.method === 'POST' && request.host === 'mcp.ledger.example.test'
        ? {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${ledger.resourceMetadataUrl}", scope="ledger:read"`,
            },
          }
        : undefined,
    );
    serve(ledger.handle);
    expect(await probeApp(LEDGER, { fetches: endpoints.fetches })).toMatchObject({
      status: 'ok',
      method: { kind: 'oauth', issuer: 'https://auth.example.test/', dynamicRegistration: true, scope: 'ledger:read' },
    });
  });

  it('classifies a Shop-shaped 2026-07-28 server, which lists its tools before sign-in, as OAuth from its metadata', async () => {
    const shop = new FakeMcpApp({
      appUrl: SHOP,
      resource: 'https://mcp.shop.com',
      issuer: 'https://accounts.shop.app',
      scopes: ['personal_agent'],
      protocol: '2026-07-28',
      tools: [{ name: 'search_products', inputSchema: { type: 'object' } }],
    });
    serve(shop.handle);
    expect(await probeApp(SHOP, { fetches: endpoints.fetches })).toMatchObject({
      status: 'ok',
      method: {
        kind: 'oauth',
        issuer: 'https://accounts.shop.app/',
        scope: 'personal_agent',
        signIn: { resource: 'https://mcp.shop.com' },
      },
      advertisedName: undefined,
    });
    const mcp = endpoints.requests.filter((request) => request.method === 'POST');
    expect(mcp.map((request) => [request.headers['mcp-protocol-version'], request.headers['mcp-method']])).toEqual([
      ['2026-07-28', 'server/discover'],
      ['2026-07-28', 'tools/list'],
    ]);
    expect(endpoints.requests.every((request) => request.headers.authorization === undefined)).toBe(true);
  });

  it.each([
    ['lists none', ['none'], true],
    ['takes only client_secret_basic', ['client_secret_basic'], false],
    ['names no token endpoint auth method, which means client_secret_basic', [], false],
  ])(
    'reads client documents as supported only when a server advertising them %s',
    async (_case, methods, documents) => {
      const app = new FakeMcpApp({
        appUrl: LEDGERLY,
        issuer: 'https://app.ledgerly.example.test',
        tokenAuthMethods: methods,
        fetchClientDocument: async () => ({ status: 404 }),
      });
      serve(app.handle);
      expect(await probeApp(LEDGERLY, { fetches: endpoints.fetches })).toMatchObject({
        status: 'ok',
        method: { kind: 'oauth', dynamicRegistration: false, clientDocuments: documents },
      });
    },
  );

  it('refuses OAuth whose protected resource names another address', async () => {
    const app = ledgerly();
    app.resourceMetadata.resource = 'https://app.ledgerly.example.test/';
    serve(app.handle);
    expect(await probeApp(LEDGERLY, { fetches: endpoints.fetches })).toEqual({ status: 'unsupported' });
  });

  it.each([
    [403, 'unsupported'],
    [404, 'unsupported'],
    [429, 'unreachable'],
    [503, 'unreachable'],
  ] as const)('answers a %i as %s', async (status, outcome) => {
    serve(() => ({ status, body: { error: 'nope' } }));
    expect(await probeApp(LEDGER, { fetches: endpoints.fetches })).toEqual({ status: outcome });
  });

  it('answers a redirect, which the probe never follows, as unreachable', async () => {
    serve(() => ({ status: 307, headers: { location: 'https://auth.example.test/mcp' } }));
    expect(await probeApp(LEDGER, { fetches: endpoints.fetches })).toEqual({ status: 'unreachable' });
    expect(endpoints.requests.map((request) => request.host)).toEqual(['mcp.ledger.example.test']);
  });
});

describe('checkPastedToken', () => {
  it('refuses a token the server answers with 401, and accepts one it serves', async () => {
    const app = ledgerly();
    app.accessTokens.add('pasted-token-good');
    serve(app.handle);
    expect(await checkPastedToken(LEDGERLY, 'pasted-token-stale', { fetches: endpoints.fetches })).toBe('refused');
    expect(await checkPastedToken(LEDGERLY, 'pasted-token-good', { fetches: endpoints.fetches })).toBe('valid');
    expect(new Set(endpoints.requests.map((request) => request.headers.authorization))).toEqual(
      new Set(['Bearer pasted-token-stale', 'Bearer pasted-token-good']),
    );
    expect(app.toolCalls).toEqual([]);
  });

  it('refuses a token no header could carry without sending it', async () => {
    expect(await checkPastedToken(LEDGERLY, 'two words', { fetches: endpoints.fetches })).toBe('refused');
    expect(endpoints.requests).toEqual([]);
  });
});
