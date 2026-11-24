import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createPendingApproval,
  createSession,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { getDeliveryAdapter, setDeliveryAdapter } from '../../delivery.js';
import type { GatewayCredentialRemoval } from '../../gateway-providers/credential-connection.js';
import { log } from '../../log.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { createWebHandler } from '../gws-ea-web/server.js';
import { upsertUser } from '../permissions/db/users.js';
import type { AdmissionDependencies } from './admit.js';
import { applyMainServers, appRelayServerEntry, mainOperatorServers } from './apply.js';
import { createClientDocumentHandler } from './client-document.js';
import { clientDocumentsWebMount, connectionsLinkFacts, connectionsStatus } from './connections-mount.js';
import { canonicalArgsHash } from './canonical.js';
import {
  HELD_APP_CALL_ACTION,
  registerHeldAppCallHandlers,
  type HeldAppCallPayload,
  type PendingHeldCallItem,
} from './held-calls.js';
import { ConnectionOperations, type ConnectionsListing } from './operations.js';
import type { OperatorCredentials } from './operator.js';
import { createConnectionsPageHandler } from './page.js';
import type { AppRelay } from './relay.js';
import type { ConnectionApp, ConnectionsStore } from './store.js';
import {
  FakeMcpApp,
  startFakeEndpoints,
  type FakeEndpoints,
  type FakeHandler,
  type FakeReply,
} from './testing/oauth-server.js';
import { testConnectionsStore, type TestKeychain } from './testing/store.js';

const HOST = 'juno.example.test';
const PRINCIPAL = 'morgan@example.test';
const READER = 'remy@example.test';
const MAIN = 'ag-main';
const LEDGERLY = 'https://app.ledgerly.example.test/mcp';
const LEDGERLY_REDIRECT = `https://${HOST}/connections/callback/app.ledgerly.example.test`;
const LEDGER = 'https://mcp.ledger.example.test/mcp';
const NOTES = 'https://notes.example.test/mcp';
/** Takes only client documents: `none` clients, no registration endpoint, `iss` sent back. */
const LARDER = 'https://mcp.larder.example.test/mcp';
const LARDER_REDIRECT = `https://${HOST}/connections/callback/mcp.larder.example.test`;
const RECIPES = 'https://recipes.example.test/mcp';
const CLIENT_ID = 'juno-ledgerly-client';
const SENTINEL_SECRET = 'sentinel-client-secret-V7k2';
const SENTINEL_TOKEN = 'sentinel-pasted-token-R4m9';
const SENTINEL_QUERY = 'sentinel-url-key-T3c8';
/** A token or client secret the principal enters that is refused. */
const SENTINEL_REFUSED = 'sentinel-refused-value-N2d6';
const postHeaders = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface HeldCredential {
  readonly id: string;
  readonly host: string;
  readonly path: string | undefined;
  readonly value: string;
}

class FakeGateway implements OperatorCredentials {
  readonly held = new Map<string, HeldCredential>();
  readonly events: string[] = [];
  readonly failingIds = new Set<string>();
  /** A credential written into the gateway directly, as an operator does. */
  hold(name: string, host: string): string {
    const id = randomUUID();
    this.held.set(name, { id, host, path: undefined, value: 'operator-written-token' });
    return id;
  }
  async listForHost(host: string): Promise<{ id: string; name: string }[]> {
    return [...this.held].filter(([, held]) => held.host === host).map(([name, held]) => ({ id: held.id, name }));
  }
  async removeById(ids: readonly string[]): Promise<GatewayCredentialRemoval[]> {
    return ids.map((id) => {
      const name = [...this.held].find(([, held]) => held.id === id)?.[0];
      if (name === undefined) return { id, outcome: 'gone' };
      if (this.failingIds.has(id)) return { id, outcome: 'failed' };
      this.held.delete(name);
      return { id, outcome: 'removed' };
    });
  }
}

let endpoints: FakeEndpoints;
let directory: string;
let store: ConnectionsStore;
let keychain: TestKeychain;
let raw: ReturnType<typeof testConnectionsStore>['raw'];
let gateway: FakeGateway;
let operatorCredentialsAvailable: boolean;
let server: Server;
let port: number;
let replies: Reply[];
let logged: string[];
let documentsServed: boolean;
let documentServer: Server;
let documentPort: number;

beforeAll(async () => {
  endpoints = await startFakeEndpoints([
    'app.ledgerly.example.test',
    'mcp.ledger.example.test',
    'auth.example.test',
    'notes.example.test',
    'recipes.example.test',
    'down.example.test',
    'mcp.larder.example.test',
  ]);
});
afterAll(async () => {
  await endpoints.close();
});

function operations(): ConnectionOperations {
  const admission: AdmissionDependencies = {
    appByHost: (host) => store.byHost(host),
    operatorServers: mainOperatorServers,
    gatewayCredentials: (host) => gateway.listForHost(host),
    protectedHosts: async () => new Set([HOST, 'api.anthropic.com']),
  };
  return new ConnectionOperations({
    store,
    webHostname: HOST,
    fetches: endpoints.fetches,
    admission,
    applyMain: async (applied) => {
      const changed = await applyMainServers(applied);
      gateway.events.push('apply');
      return changed;
    },
    clientDocumentsServed: () => documentsServed,
  });
}

async function listen(target: Server): Promise<number> {
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const address = target.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  return address.port;
}

beforeEach(async () => {
  endpoints.reset();
  directory = await mkdtemp(path.join(os.tmpdir(), 'connections-page-'));
  ({ store, keychain, raw } = testConnectionsStore(path.join(directory, 'connections')));
  gateway = new FakeGateway();
  operatorCredentialsAvailable = true;
  documentsServed = true;
  replies = [];
  logged = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const)
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: MAIN,
    name: 'Main',
    folder: 'main',
    agent_provider: null,
    created_at: '2026-11-14T00:00:00.000Z',
  });
  await ensureContainerConfig(MAIN);
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name = 'Juno', principal_first_name = 'Morgan', main_agent_group_id = ? WHERE singleton = 1",
    MAIN,
  );
  await getDb().run(
    'INSERT INTO gws_ea_principal_addresses(email, added_at) VALUES (?, ?)',
    PRINCIPAL,
    new Date().toISOString(),
  );
  const handler = createConnectionsPageHandler({
    hostname: HOST,
    identity: async (incoming) => {
      const identity = incoming.headers['cf-access-jwt-assertion'];
      return typeof identity === 'string' && identity ? identity : undefined;
    },
    operations: async () => operations(),
    operatorDependencies: () => ({
      credentials: operatorCredentialsAvailable ? gateway : undefined,
      protectedHosts: async () => new Set([HOST, 'api.anthropic.com']),
    }),
  });
  server = createServer(handler);
  port = await listen(server);
  // The assistant's web origin as an authorization server reaches it: only the public client-document mount.
  documentServer = createServer(
    createWebHandler(
      HOST,
      [
        {
          mount: clientDocumentsWebMount,
          listener: createClientDocumentHandler({ hostname: HOST, openStore: async () => store }),
        },
      ],
      async () => {
        throw new Error('A client document never consults the principal gate');
      },
    ),
  );
  documentPort = await listen(documentServer);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  documentServer.closeAllConnections();
  await new Promise<void>((resolve) => documentServer.close(() => resolve()));
  await closeDb();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function request(
  route: string,
  method = 'GET',
  headers: Readonly<Record<string, string>> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: route,
        headers: { host: HOST, 'cf-access-jwt-assertion': PRINCIPAL, ...headers },
      },
      (incoming) => {
        let text = '';
        incoming.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        incoming.on('end', () => {
          const reply = { status: incoming.statusCode ?? 0, headers: incoming.headers, body: text };
          replies.push(reply);
          resolve(reply);
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

const post = (route: string, data: unknown, headers: Readonly<Record<string, string>> = {}): Promise<Reply> =>
  request(route, 'POST', { ...postHeaders, ...headers }, JSON.stringify(data));

function serve(...handlers: FakeHandler[]): void {
  for (const handler of handlers) endpoints.use(handler);
}

function fakeLedgerly(): FakeMcpApp {
  return new FakeMcpApp({
    appUrl: LEDGERLY,
    issuer: 'https://app.ledgerly.example.test',
    client: { id: CLIENT_ID, secret: SENTINEL_SECRET, redirectUri: LEDGERLY_REDIRECT },
  });
}

/** What an authorization server reads at a client document's address on the assistant's hostname. */
function fetchClientDocument(url: string): Promise<FakeReply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { hostname: '127.0.0.1', port: documentPort, path: target.pathname, headers: { host: target.host } },
      (incoming) => {
        let text = '';
        incoming.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        incoming.on('end', () => {
          const json = incoming.headers['content-type'] === 'application/json';
          resolve({ status: incoming.statusCode ?? 0, body: json ? (JSON.parse(text) as unknown) : text });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function fakeLarder(): FakeMcpApp {
  return new FakeMcpApp({
    appUrl: LARDER,
    issuer: 'https://mcp.larder.example.test',
    tokenAuthMethods: ['none'],
    issParameter: true,
    fetchClientDocument,
  });
}

/** Ledger's authorization server, which registers clients and also takes client documents. */
function fakeLedgerWithDocuments(): FakeMcpApp {
  return new FakeMcpApp({
    appUrl: LEDGER,
    issuer: 'https://auth.example.test',
    registration: true,
    tokenAuthMethods: ['client_secret_basic', 'none'],
    fetchClientDocument,
  });
}

function documentUrl(app: Pick<ConnectionApp, 'id'>): string {
  return `https://${HOST}/oauth-client/${app.id}`;
}

function clientIdOf(authorizationUrl: string): string | null {
  return new URL(authorizationUrl).searchParams.get('client_id');
}

function tokenRequests(): FakeEndpoints['requests'] {
  return endpoints.requests.filter((incoming) => incoming.path === '/oauth/token');
}

function registrationRequests(): FakeEndpoints['requests'] {
  return endpoints.requests.filter((incoming) => incoming.path === '/oauth/register');
}

/** Takes a pasted token and nothing else, publishing no sign-in metadata. */
const notesServer: FakeHandler = (incoming) => {
  if (incoming.host !== 'notes.example.test' || incoming.method !== 'POST') return undefined;
  if (incoming.headers.authorization !== `Bearer ${SENTINEL_TOKEN}`)
    return { status: 401, body: { error: 'unauthorized' } };
  return { status: 200, body: { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Notes', version: '1' } } } };
};

/** Answers without sign-in and advertises its name. */
const recipesServer: FakeHandler = (incoming) =>
  incoming.host === 'recipes.example.test' && incoming.method === 'POST'
    ? { status: 200, body: { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'Recipes', version: '1' } } } }
    : undefined;

async function mainServers(): Promise<Record<string, unknown>> {
  const row = await getContainerConfig(MAIN);
  if (!row) throw new Error('Main has no container config');
  return JSON.parse(row.mcp_servers) as Record<string, unknown>;
}

async function onlyApp(): Promise<ConnectionApp> {
  const apps = await store.apps();
  expect(apps).toHaveLength(1);
  return apps[0];
}

function signInRow(appId: string): { claimed_at: string | null } | undefined {
  return raw(
    (db) =>
      db.prepare('SELECT claimed_at FROM sign_ins WHERE app_id = ?').get(appId) as
        | { claimed_at: string | null }
        | undefined,
  );
}

async function startSignIn(app: ConnectionApp, client?: Record<string, string>): Promise<string> {
  const reply = await post('/connections/sign-in', { id: app.id, version: String(app.version), ...client });
  expect(reply.status).toBe(200);
  const { authorizationUrl } = JSON.parse(reply.body) as { authorizationUrl: string };
  return authorizationUrl;
}

function callback(host: string, query: URLSearchParams, identity = PRINCIPAL): Promise<Reply> {
  return request(`/connections/callback/${host}?${query.toString()}`, 'GET', { 'cf-access-jwt-assertion': identity });
}

function toolsReturn(app: Pick<ConnectionApp, 'id'>): string {
  return `/connections/app/${app.id}/tools?outcome=connected`;
}

/** Ledgerly added from the page and signed in, as F1 runs it. */
async function connectedLedgerly(app = fakeLedgerly()): Promise<ConnectionApp> {
  serve(app.handle);
  expect((await post('/connections/add', { url: LEDGERLY, name: '' })).status).toBe(200);
  const stored = await onlyApp();
  const url = await startSignIn(stored, { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET });
  const reply = await callback('app.ledgerly.example.test', app.approve(url).query);
  expect(reply.headers.location).toBe(toolsReturn(stored));
  return onlyApp();
}

function assertNoSentinels(): void {
  for (const sentinel of [SENTINEL_SECRET, SENTINEL_TOKEN, SENTINEL_QUERY, SENTINEL_REFUSED]) {
    for (const reply of replies) {
      expect(reply.body).not.toContain(sentinel);
      expect(JSON.stringify(reply.headers)).not.toContain(sentinel);
    }
    for (const line of logged) expect(line).not.toContain(sentinel);
  }
}

describe('adding and connecting an OAuth app that needs a client', () => {
  it('runs F1 end to end: client fields, sign-in, Connected, credential published before main’s entry', async () => {
    const app = fakeLedgerly();
    serve(app.handle);

    const added = await post('/connections/add', { url: LEDGERLY, name: '' });
    expect(added.status).toBe(200);
    expect(added.headers['x-page-saved']).toBe('true');
    const stored = await onlyApp();
    expect(stored).toMatchObject({ status: 'not_connected', auth: 'oauth', hasClient: false });
    expect(added.headers['x-page-location']).toBe(`/connections/app/${stored.id}/connect`);
    for (const body of [added.body, (await request(`/connections/app/${stored.id}/connect`)).body]) {
      expect(body).toContain(LEDGERLY_REDIRECT);
      expect(body).toContain('name="clientId"');
      expect(body).toContain('name="clientSecret"');
      expect(body).toContain('Your operator hasn’t reviewed app.ledgerly.example.test');
      expect(body).toContain('data-copy-from="redirect-uri"');
    }

    const authorizationUrl = new URL(await startSignIn(stored, { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET }));
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('resource')).toBe(LEDGERLY);
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(LEDGERLY_REDIRECT);
    expect(authorizationUrl.searchParams.get('state')?.length).toBeGreaterThanOrEqual(22);

    const returned = await callback('app.ledgerly.example.test', app.approve(authorizationUrl.href).query);
    expect(returned.status).toBe(302);
    expect(returned.headers.location).toBe(toolsReturn(stored));

    const connected = await onlyApp();
    expect(connected.status).toBe('connected');
    expect(gateway.held.size).toBe(0);
    const storedToken = await store.readAccessToken(connected.id, 1);
    expect(storedToken && app.accessTokens.has(storedToken.token)).toBe(true);
    expect(gateway.events).toEqual(['apply']);
    expect(await mainServers()).toEqual({ [connected.serverKey]: appRelayServerEntry(connected.serverKey) });
    expect(await store.pendingRestart()).toBeDefined();
    expect(signInRow(connected.id)).toBeUndefined();

    const list = await request('/connections?outcome=connected');
    expect(list.body).toContain('App connected. Ready from your next message.');
    expect(list.body).toContain('Connected');
    assertNoSentinels();
  });

  it('connects a chat-added app, Not connected, through the same sign-in route with client details', async () => {
    const app = fakeLedgerly();
    serve(app.handle);
    const added = await operations().add({ url: LEDGERLY, name: 'Ledgerly' });
    if (added.status !== 'added') throw new Error(added.reason);
    expect(added.app.status).toBe('not_connected');

    const url = await startSignIn(added.app, { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET });
    expect((await callback('app.ledgerly.example.test', app.approve(url).query)).headers.location).toBe(
      toolsReturn(added.app),
    );
    expect((await onlyApp()).status).toBe('connected');
    assertNoSentinels();
  });

  it('goes straight to sign-in for a server that registers clients itself, with no client fields', async () => {
    const ledger = new FakeMcpApp({ appUrl: LEDGER, issuer: 'https://auth.example.test', registration: true });
    serve(ledger.handle);
    const added = await post('/connections/add', { url: LEDGER, name: 'Ledger' });
    expect(added.status).toBe(200);
    expect(added.body).not.toContain('name="clientId"');
    expect(added.body).toContain('>Continue to auth.example.test</button>');
    expect(ledger.registrations).toHaveLength(1);
    expect(ledger.registrations[0]).toMatchObject({
      redirect_uris: [`https://${HOST}/connections/callback/mcp.ledger.example.test`],
    });

    const stored = await onlyApp();
    const url = await startSignIn(stored);
    expect((await callback('mcp.ledger.example.test', ledger.approve(url).query)).headers.location).toBe(
      toolsReturn(stored),
    );
    expect((await onlyApp()).status).toBe('connected');
    expect(ledger.registrations).toHaveLength(1);
  });
});

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
/** Hop-by-hop and length headers the test server sent for its own connection, not for the page. */
const CONNECTION_HEADERS = new Set(['connection', 'content-length', 'keep-alive', 'transfer-encoding']);

describe('sign-in in Chrome', () => {
  it.skipIf(!chromePath)(
    'sends the app and the client details entered with it, then opens the server’s sign-in',
    async () => {
      const app = fakeLedgerly();
      serve(app.handle);
      expect((await post('/connections/add', { url: LEDGERLY, name: '' })).status).toBe(200);
      const added = await onlyApp();
      const browser = await chromium.launch({ executablePath: chromePath, headless: true });
      try {
        const context = await browser.newContext();
        const started: unknown[] = [];
        await context.route(`https://${HOST}/**`, async (route) => {
          const sent = route.request();
          const url = new URL(sent.url());
          const body = sent.postData() ?? undefined;
          if (url.pathname === '/connections/sign-in') started.push(JSON.parse(body ?? 'null'));
          const headers = await sent.allHeaders();
          const forwarded = Object.fromEntries(
            ['content-type', 'origin', 'sec-fetch-site'].flatMap((name) =>
              headers[name] ? [[name, headers[name]]] : [],
            ),
          );
          const reply = await request(`${url.pathname}${url.search}`, sent.method(), forwarded, body);
          await route.fulfill({
            status: reply.status,
            headers: Object.fromEntries(
              Object.entries(reply.headers).flatMap(([name, value]) =>
                CONNECTION_HEADERS.has(name) || value === undefined
                  ? []
                  : [[name, Array.isArray(value) ? value.join(', ') : value]],
              ),
            ),
            body: reply.body,
          });
        });
        await context.route('https://app.ledgerly.example.test/**', (route) =>
          route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Sign in</title>' }),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        await page.goto(`https://${HOST}/connections/app/${added.id}/connect`);
        await page.getByLabel('Client ID').fill(CLIENT_ID);
        await page.getByLabel(/Client secret/u).fill(SENTINEL_SECRET);
        await page.getByRole('button', { name: 'Continue to app.ledgerly.example.test' }).click();
        await page.waitForURL('https://app.ledgerly.example.test/**');

        expect(started).toEqual([
          { id: added.id, version: String(added.version), clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET },
        ]);
        expect(signInRow(added.id)).toEqual({ claimed_at: null });
        await context.close();
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});

describe('client details the server refuses', () => {
  it('forgets entered details the server refused at the exchange, so Connect asks for them again', async () => {
    const app = fakeLedgerly();
    serve(app.handle);
    await post('/connections/add', { url: LEDGERLY, name: '' });
    const added = await onlyApp();
    const unusable = await post('/connections/sign-in', {
      id: added.id,
      version: String(added.version),
      clientId: CLIENT_ID,
      clientSecret: `${SENTINEL_REFUSED} pasted twice`,
    });
    expect(unusable.status).toBe(400);
    expect(unusable.body).toContain('Enter the client ID and secret exactly');
    expect(await onlyApp()).toMatchObject({ hasClient: false });
    const url = await startSignIn(await onlyApp(), { clientId: CLIENT_ID, clientSecret: SENTINEL_REFUSED });

    expect((await callback('app.ledgerly.example.test', app.approve(url).query)).headers.location).toBe(
      '/connections?outcome=client_refused',
    );
    const cleared = await onlyApp();
    expect(cleared).toMatchObject({ status: 'not_connected', hasClient: false });
    expect((await request(`/connections/app/${cleared.id}/connect`)).body).toContain('name="clientId"');
    expect(gateway.held.size).toBe(0);

    const retry = await startSignIn(cleared, { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET });
    expect((await callback('app.ledgerly.example.test', app.approve(retry).query)).headers.location).toBe(
      toolsReturn(cleared),
    );
    assertNoSentinels();
  });

  it('registers a new client when the server refuses the one it registered, so Connect signs in again', async () => {
    const ledger = new FakeMcpApp({ appUrl: LEDGER, issuer: 'https://auth.example.test', registration: true });
    serve(ledger.handle);
    await post('/connections/add', { url: LEDGER, name: 'Ledger' });
    const [[clientId, registered]] = [...ledger.clients];
    // The server expired the registration's secret.
    ledger.clients.set(clientId, { ...registered, secret: 'expired-secret' });
    const url = await startSignIn(await onlyApp());

    expect((await callback('mcp.ledger.example.test', ledger.approve(url).query)).headers.location).toBe(
      '/connections?outcome=assistant_client_refused',
    );
    expect(ledger.registrations).toHaveLength(2);
    const replaced = await onlyApp();
    expect(replaced).toMatchObject({ status: 'not_connected', hasClient: true });
    expect((await request(`/connections/app/${replaced.id}/connect`)).body).not.toContain('name="clientId"');

    const again = await startSignIn(replaced);
    expect((await callback('mcp.ledger.example.test', ledger.approve(again).query)).headers.location).toBe(
      toolsReturn(replaced),
    );
  });

  it('sends no client details to an authorization server other than the one Connect named', async () => {
    const app = fakeLedgerly();
    serve(app.handle);
    await post('/connections/add', { url: LEDGERLY, name: '' });
    const added = await onlyApp();
    expect((await request(`/connections/app/${added.id}/connect`)).body).toContain(
      '>Continue to app.ledgerly.example.test</button>',
    );

    // Between the view and the submit, the app starts naming another authorization server.
    const moved = new FakeMcpApp({ appUrl: LEDGERLY, issuer: 'https://auth.example.test', registration: true });
    endpoints.reset();
    serve(moved.handle);
    const reply = await post('/connections/sign-in', {
      id: added.id,
      version: String(added.version),
      clientId: CLIENT_ID,
      clientSecret: SENTINEL_SECRET,
    });

    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body)).toEqual({
      error: 'This app now signs in differently. Delete it, then add it again.',
    });
    expect(await onlyApp()).toEqual(added);
    expect(signInRow(added.id)).toBeUndefined();
    expect(moved.registrations).toEqual([]);
    expect(
      endpoints.requests.some((incoming) => incoming.host === 'auth.example.test' && incoming.method === 'POST'),
    ).toBe(false);
    assertNoSentinels();
  });

  it('runs the refused-client recovery when the server answers the sign-in with unauthorized_client', async () => {
    const app = fakeLedgerly();
    serve(app.handle);
    await post('/connections/add', { url: LEDGERLY, name: '' });
    const url = await startSignIn(await onlyApp(), { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET });
    const state = new URL(url).searchParams.get('state') ?? '';

    const returned = await callback(
      'app.ledgerly.example.test',
      new URLSearchParams({ error: 'unauthorized_client', state }),
    );

    expect(returned.headers.location).toBe('/connections?outcome=client_refused');
    const cleared = await onlyApp();
    expect(cleared).toMatchObject({ status: 'not_connected', hasClient: false });
    expect((await request(`/connections/app/${cleared.id}/connect`)).body).toContain('name="clientId"');
  });

  it('lets the principal change client details the server rejected on its own page', async () => {
    const app = fakeLedgerly();
    serve(app.handle);
    await post('/connections/add', { url: LEDGERLY, name: '' });
    // The server rejects this client on its sign-in page, so no return ever reaches the host.
    await startSignIn(await onlyApp(), { clientId: 'mistyped-client', clientSecret: SENTINEL_REFUSED });
    const stored = await onlyApp();
    expect(stored).toMatchObject({ hasClient: true, clientEntered: true });
    const view = (await request(`/connections/app/${stored.id}/connect`)).body;
    expect(view).toContain('action="/connections/change-client"');
    expect(view).not.toContain('name="clientId"');

    const stale = await post('/connections/change-client', { id: stored.id, version: String(stored.version - 1) });
    expect(stale.status).toBe(409);
    expect(await onlyApp()).toEqual(stored);

    const changed = await post('/connections/change-client', { id: stored.id, version: String(stored.version) });
    expect(changed.status).toBe(200);
    expect(changed.headers['x-page-location']).toBe(`/connections/app/${stored.id}/connect`);
    expect(changed.body).toContain('Client details cleared. Enter new ones to sign in.');
    expect(changed.body).toContain('name="clientId"');
    expect(await onlyApp()).toMatchObject({ hasClient: false, clientEntered: false });
    expect(signInRow(stored.id)).toBeUndefined();

    const retry = await startSignIn(await onlyApp(), { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET });
    expect((await callback('app.ledgerly.example.test', app.approve(retry).query)).headers.location).toBe(
      toolsReturn(stored),
    );
    assertNoSentinels();
  });

  it('offers no client change for a client registered for the app, and refuses one', async () => {
    const ledger = new FakeMcpApp({ appUrl: LEDGER, issuer: 'https://auth.example.test', registration: true });
    serve(ledger.handle);
    await post('/connections/add', { url: LEDGER, name: 'Ledger' });
    const stored = await onlyApp();
    expect(stored).toMatchObject({ hasClient: true, clientEntered: false });
    expect((await request(`/connections/app/${stored.id}/connect`)).body).not.toContain(
      'action="/connections/change-client"',
    );

    const reply = await post('/connections/change-client', { id: stored.id, version: String(stored.version) });
    expect(reply.status).toBe(409);
    expect(await onlyApp()).toEqual(stored);
  });
});

describe('apps whose server takes client documents', () => {
  const unavailable = 'Can’t sign in to this app right now. Try again in a few minutes.';
  const assistantRefused = 'The sign-in service didn’t accept your assistant’s client. Connect again to continue.';

  /** The server expires a registration's secret, so it refuses that client at the exchange. */
  function expireSecret(app: FakeMcpApp, clientId: string): void {
    const registered = app.clients.get(clientId);
    if (!registered) throw new Error('No such registration');
    app.clients.set(clientId, { ...registered, secret: 'expired-secret' });
  }

  /** Approves at the server, which fetches the client document, and returns to the assistant. */
  async function signInWithDocument(app: FakeMcpApp, host: string, authorizationUrl: string): Promise<Reply> {
    return callback(host, (await app.approveWithDocument(authorizationUrl)).query);
  }

  it('adds and connects a server that takes only client documents, with no client form and no secret', async () => {
    const larder = fakeLarder();
    serve(larder.handle);
    const added = await post('/connections/add', { url: LARDER, name: '' });
    expect(added.status).toBe(200);
    const stored = await onlyApp();
    expect(stored).toMatchObject({ auth: 'oauth', hasClient: true, clientEntered: false });
    for (const body of [added.body, (await request(`/connections/app/${stored.id}/connect`)).body]) {
      expect(body).toContain('>Continue to mcp.larder.example.test</button>');
      expect(body).not.toContain('name="clientId"');
    }
    expect(registrationRequests()).toEqual([]);

    const url = await startSignIn(stored);
    expect(clientIdOf(url)).toBe(documentUrl(stored));
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(LARDER_REDIRECT);
    const returned = await signInWithDocument(larder, 'mcp.larder.example.test', url);

    expect(returned.headers.location).toBe(toolsReturn(stored));
    expect(larder.documents).toEqual([
      expect.objectContaining({
        client_id: documentUrl(stored),
        client_name: 'Juno',
        redirect_uris: [LARDER_REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    ]);
    const [exchange, ...others] = tokenRequests();
    expect(others).toEqual([]);
    const sent = new URLSearchParams(exchange.body);
    expect(sent.get('client_id')).toBe(documentUrl(stored));
    expect(sent.get('resource')).toBe(LARDER);
    expect(sent.has('client_secret')).toBe(false);
    expect(exchange.headers.authorization).toBeUndefined();
    const connected = await onlyApp();
    expect(connected.status).toBe('connected');
    expect(gateway.held.size).toBe(0);
    const storedToken = await store.readAccessToken(connected.id, 1);
    expect(storedToken && larder.accessTokens.has(storedToken.token)).toBe(true);
    expect(await mainServers()).toEqual({ [connected.serverKey]: appRelayServerEntry(connected.serverKey) });
  });

  it('gives a server that also registers clients a document client, with no registration request', async () => {
    const ledger = fakeLedgerWithDocuments();
    serve(ledger.handle);
    expect((await post('/connections/add', { url: LEDGER, name: 'Ledger' })).status).toBe(200);
    const stored = await onlyApp();

    const url = await startSignIn(stored);
    expect(clientIdOf(url)).toBe(documentUrl(stored));
    expect((await signInWithDocument(ledger, 'mcp.ledger.example.test', url)).headers.location).toBe(
      toolsReturn(stored),
    );
    expect(registrationRequests()).toEqual([]);
  });

  it.each([
    ['only client_secret_basic', ['client_secret_basic']],
    ['no token endpoint auth methods, which means client_secret_basic', []],
  ])('registers with a server advertising documents but %s', async (_case, methods) => {
    const ledger = new FakeMcpApp({
      appUrl: LEDGER,
      issuer: 'https://auth.example.test',
      registration: true,
      tokenAuthMethods: methods,
      fetchClientDocument,
    });
    serve(ledger.handle);
    await post('/connections/add', { url: LEDGER, name: 'Ledger' });

    expect(ledger.registrations).toHaveLength(1);
    const stored = await onlyApp();
    const url = await startSignIn(stored);
    expect(clientIdOf(url)).toBe([...ledger.clients.keys()][0]);
    expect((await callback('mcp.ledger.example.test', ledger.approve(url).query)).headers.location).toBe(
      toolsReturn(stored),
    );
    expect(ledger.documents).toEqual([]);
  });

  describe('while client documents are not served', () => {
    it('refuses to add a server that takes only documents, storing nothing', async () => {
      serve(fakeLarder().handle);
      documentsServed = false;
      const reply = await post('/connections/add', { url: LARDER, name: '' });
      expect(reply.status).toBe(400);
      expect(reply.body).toContain(unavailable);
      expect(await store.apps()).toEqual([]);
    });

    it('registers with a server that also registers clients', async () => {
      const ledger = fakeLedgerWithDocuments();
      serve(ledger.handle);
      documentsServed = false;
      await post('/connections/add', { url: LEDGER, name: 'Ledger' });
      expect(ledger.registrations).toHaveLength(1);
      expect(await onlyApp()).toMatchObject({ hasClient: true, clientEntered: false });
    });

    it('refuses a sign-in with a stored document client until they are served again', async () => {
      const larder = fakeLarder();
      serve(larder.handle);
      await post('/connections/add', { url: LARDER, name: '' });
      const stored = await onlyApp();
      documentsServed = false;

      const reply = await post('/connections/sign-in', { id: stored.id, version: String(stored.version) });
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({ error: unavailable });
      expect(await onlyApp()).toEqual(stored);
      expect(signInRow(stored.id)).toBeUndefined();

      documentsServed = true;
      expect(clientIdOf(await startSignIn(stored))).toBe(documentUrl(stored));
    });
  });

  describe('a stored document client that no longer fits', () => {
    async function withStaleDocumentClient(appUrl: string, issuer: string): Promise<ConnectionApp> {
      expect((await post('/connections/add', { url: appUrl, name: '' })).status).toBe(200);
      const added = await onlyApp();
      return store.setClient(added.id, added.version, {
        issuer,
        client: {
          clientId: `https://old-name.example.test/oauth-client/${added.id}`,
          tokenEndpointAuthMethod: 'none',
          kind: 'document',
        },
        entered: false,
      });
    }

    it('is replaced by the document at the current address when it names another hostname', async () => {
      const larder = fakeLarder();
      serve(larder.handle);
      const stale = await withStaleDocumentClient(LARDER, 'https://mcp.larder.example.test/');

      const url = await startSignIn(stale);
      expect(clientIdOf(url)).toBe(documentUrl(stale));
      expect((await signInWithDocument(larder, 'mcp.larder.example.test', url)).headers.location).toBe(
        toolsReturn(stale),
      );
    });

    it('is replaced by a registration once the server stops advertising documents', async () => {
      const ledger = fakeLedgerWithDocuments();
      serve(ledger.handle);
      await post('/connections/add', { url: LEDGER, name: 'Ledger' });
      expect(await onlyApp()).toMatchObject({ hasClient: true });
      expect(ledger.registrations).toEqual([]);
      delete ledger.serverMetadata.client_id_metadata_document_supported;

      const stored = await onlyApp();
      const url = await startSignIn(stored);
      expect(ledger.registrations).toHaveLength(1);
      expect(clientIdOf(url)).toBe([...ledger.clients.keys()][0]);
      expect((await callback('mcp.ledger.example.test', ledger.approve(url).query)).headers.location).toBe(
        toolsReturn(stored),
      );
    });

    it('is forgotten, and client details asked for, when the assistant can provide no other client', async () => {
      const larder = fakeLarder();
      serve(larder.handle);
      await post('/connections/add', { url: LARDER, name: '' });
      const stored = await onlyApp();
      expect(stored).toMatchObject({ hasClient: true });
      delete larder.serverMetadata.client_id_metadata_document_supported;

      const reply = await post('/connections/sign-in', { id: stored.id, version: String(stored.version) });
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({
        error: 'This app now needs client details. Reload the page to enter them.',
      });
      const cleared = await onlyApp();
      expect(cleared).toMatchObject({ hasClient: false, clientEntered: false });
      expect((await request(`/connections/app/${cleared.id}/connect`)).body).toContain('name="clientId"');
    });
  });

  describe('a client the server refuses at the exchange', () => {
    it('replaces a refused client with the other kind, never one of its own kind', async () => {
      const ledger = fakeLedgerWithDocuments();
      serve(ledger.handle);
      await post('/connections/add', { url: LEDGER, name: 'Ledger' });
      const added = await onlyApp();
      const url = await startSignIn(added);
      const { query } = await ledger.approveWithDocument(url);
      // The server stops accepting the document between the sign-in page and the exchange.
      ledger.clients.delete(documentUrl(added));

      const returned = await callback('mcp.ledger.example.test', query);
      expect(returned.headers.location).toBe('/connections?outcome=assistant_client_refused');
      const list = (await request('/connections?outcome=assistant_client_refused')).body;
      expect(list).toContain(assistantRefused);
      expect(list).not.toContain('enter new ones');
      expect(ledger.registrations).toHaveLength(1);
      const replaced = await onlyApp();
      expect(replaced).toMatchObject({ status: 'not_connected', hasClient: true, clientEntered: false });
      expect((await store.readClient(replaced.id)).client).not.toHaveProperty('kind');

      // That registration is refused too: the document takes its place, not another registration.
      const second = await startSignIn(replaced);
      const [registeredId] = [...ledger.clients.keys()].filter((id) => id !== documentUrl(added));
      expect(clientIdOf(second)).toBe(registeredId);
      expireSecret(ledger, registeredId);
      expect((await callback('mcp.ledger.example.test', ledger.approve(second).query)).headers.location).toBe(
        '/connections?outcome=assistant_client_refused',
      );
      expect(ledger.registrations).toHaveLength(1);
      expect((await store.readClient((await onlyApp()).id)).client).toEqual({
        clientId: documentUrl(added),
        tokenEndpointAuthMethod: 'none',
        kind: 'document',
      });
    });

    it('falls to client details on a server that only takes documents, and never picks the document again', async () => {
      const larder = fakeLarder();
      serve(larder.handle);
      await post('/connections/add', { url: LARDER, name: '' });
      const added = await onlyApp();
      const url = await startSignIn(added);
      const { query } = await larder.approveWithDocument(url);
      larder.clients.delete(documentUrl(added));

      expect((await callback('mcp.larder.example.test', query)).headers.location).toBe(
        '/connections?outcome=assistant_client_refused',
      );
      const cleared = await onlyApp();
      expect(cleared).toMatchObject({ status: 'not_connected', hasClient: false });
      expect((await request(`/connections/app/${cleared.id}/connect`)).body).toContain('name="clientId"');

      const withoutDetails = await post('/connections/sign-in', { id: cleared.id, version: String(cleared.version) });
      expect(withoutDetails.status).toBe(400);
      expect(signInRow(cleared.id)).toBeUndefined();
      larder.clients.set('larder-entered-client', { secret: SENTINEL_SECRET, redirectUris: [LARDER_REDIRECT] });
      const entered = await startSignIn(cleared, { clientId: 'larder-entered-client', clientSecret: SENTINEL_SECRET });
      expect(clientIdOf(entered)).toBe('larder-entered-client');
      expect(larder.documents).toHaveLength(1);
      assertNoSentinels();
    });

    it('replaces a refused registration with the document on a server that takes both', async () => {
      const ledger = fakeLedgerWithDocuments();
      serve(ledger.handle);
      documentsServed = false;
      await post('/connections/add', { url: LEDGER, name: 'Ledger' });
      documentsServed = true;
      const registered = await onlyApp();

      // An app that holds a working client keeps it.
      const url = await startSignIn(registered);
      const [registeredId] = [...ledger.clients.keys()];
      expect(clientIdOf(url)).toBe(registeredId);
      expireSecret(ledger, registeredId);
      expect((await callback('mcp.ledger.example.test', ledger.approve(url).query)).headers.location).toBe(
        '/connections?outcome=assistant_client_refused',
      );

      expect(ledger.registrations).toHaveLength(1);
      const replaced = await onlyApp();
      const next = await startSignIn(replaced);
      expect(clientIdOf(next)).toBe(documentUrl(replaced));
      expect((await signInWithDocument(ledger, 'mcp.ledger.example.test', next)).headers.location).toBe(
        toolsReturn(replaced),
      );
    });
  });

  it('signs in with a client sealed before documents existed as the registration it is', async () => {
    const ledger = fakeLedgerWithDocuments();
    serve(ledger.handle);
    ledger.clients.set('juno-ledger-client', {
      secret: SENTINEL_SECRET,
      redirectUris: [`https://${HOST}/connections/callback/mcp.ledger.example.test`],
    });
    const created = await store.create({
      name: 'Ledger',
      url: LEDGER,
      auth: 'oauth',
      issuer: 'https://auth.example.test/',
    });
    const sealed = await store.setClient(created.id, created.version, {
      issuer: 'https://auth.example.test/',
      client: {
        clientId: 'juno-ledger-client',
        clientSecret: SENTINEL_SECRET,
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
      entered: false,
    });

    const url = await startSignIn(sealed);
    expect(clientIdOf(url)).toBe('juno-ledger-client');
    expect((await callback('mcp.ledger.example.test', ledger.approve(url).query)).headers.location).toBe(
      toolsReturn(sealed),
    );
    expect(ledger.documents).toEqual([]);
    expect(ledger.registrations).toEqual([]);
  });

  it('refuses a return whose iss names another issuer before any token request', async () => {
    const larder = fakeLarder();
    serve(larder.handle);
    await post('/connections/add', { url: LARDER, name: '' });
    const url = await startSignIn(await onlyApp());
    const { query } = await larder.approveWithDocument(url);
    query.set('iss', 'https://auth.example.test/');

    expect((await callback('mcp.larder.example.test', query)).headers.location).toBe('/connections?outcome=failed');
    expect(tokenRequests()).toEqual([]);
    expect(logged.some((line) => line.includes('"code":"issuer_mismatch"'))).toBe(true);
    expect(await onlyApp()).toMatchObject({ status: 'not_connected', hasClient: true });
  });

  it('logs no sign-in code, state or callback query, for an unknown state or a valid one that fails', async () => {
    const larder = fakeLarder();
    serve(larder.handle);
    await post('/connections/add', { url: LARDER, name: '' });
    const url = await startSignIn(await onlyApp());
    const { query } = await larder.approveWithDocument(url);
    const state = query.get('state') ?? '';
    const unknown = new URLSearchParams({ code: 'sentinel-code-U8f1', state: 'sentinel-state-K3n7', iss: 'x' });
    query.set('code', 'sentinel-code-W5p2');
    // Everything each call carries, deeper than the logger prints it: an error's message and stack included.
    const carried: string[] = [];
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const)
      vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
        carried.push(inspect(args, { depth: null, breakLength: Infinity }));
      });

    expect((await callback('mcp.larder.example.test', unknown)).headers.location).toBe('/connections?outcome=expired');
    expect((await callback('mcp.larder.example.test', query)).headers.location).toBe('/connections?outcome=failed');

    expect(carried.length).toBeGreaterThan(0);
    for (const line of carried)
      for (const value of [
        'sentinel-code-U8f1',
        'sentinel-state-K3n7',
        'sentinel-code-W5p2',
        state,
        unknown.toString(),
        query.toString(),
      ])
        expect(line).not.toContain(value);
  });
});

describe('pasted tokens and servers without sign-in', () => {
  it('connects a token app, disconnects it, and connects it again through the token field', async () => {
    serve(notesServer);
    const added = await post('/connections/add', { url: NOTES, name: '' });
    expect(added.body).toContain('name="token"');
    let app = await onlyApp();
    expect(app).toMatchObject({ auth: 'token', name: 'notes.example.test' });

    const wrong = await post('/connections/connect', {
      id: app.id,
      version: String(app.version),
      token: SENTINEL_REFUSED,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toContain('The app didn’t accept that token.');
    expect((await onlyApp()).status).toBe('not_connected');
    expect(gateway.held.size).toBe(0);

    const connected = await post('/connections/connect', {
      id: app.id,
      version: String(app.version),
      token: ` ${SENTINEL_TOKEN} `,
    });
    expect(connected.status).toBe(200);
    app = await onlyApp();
    expect(app.status).toBe('connected');
    expect(gateway.held.size).toBe(0);
    expect(await store.readGrant(app.id, 1)).toEqual({ kind: 'token', generation: 1, token: SENTINEL_TOKEN });

    expect((await post('/connections/disconnect', { id: app.id, version: String(app.version) })).status).toBe(200);
    app = await onlyApp();
    expect(app.status).toBe('not_connected');
    expect(gateway.held.size).toBe(0);
    expect(await store.readGrant(app.id, 1)).toBeUndefined();
    expect((await request(`/connections/app/${app.id}/connect`)).body).toContain('name="token"');

    await post('/connections/connect', { id: app.id, version: String(app.version), token: SENTINEL_TOKEN });
    expect((await onlyApp()).status).toBe('connected');
    assertNoSentinels();
  });

  it('connects a server without sign-in on confirm, with no OAuth step', async () => {
    serve(recipesServer);
    const added = await post('/connections/add', { url: RECIPES, name: '' });
    // Connect asks for nothing: no token field and no sign-in.
    expect(added.body).toContain('action="/connections/connect"');
    expect(added.body).not.toContain('name="token"');
    expect(added.body).not.toContain('action="/connections/sign-in"');
    let app = await onlyApp();
    expect(app).toMatchObject({ name: 'Recipes', auth: 'none' });

    expect((await post('/connections/connect', { id: app.id, version: String(app.version) })).status).toBe(200);
    app = await onlyApp();
    expect(app.status).toBe('connected');
    expect(gateway.held.size).toBe(0);
    expect(await mainServers()).toEqual({ [app.serverKey]: appRelayServerEntry(app.serverKey) });
    expect(endpoints.requests.every((incoming) => !incoming.path.includes('oauth'))).toBe(true);
  });
});

describe('sign-in returns', () => {
  it('renders each outcome’s constant message once, and the script strips it from the address', async () => {
    const messages = {
      connected: 'App connected.',
      cancelled: 'Sign-in cancelled. Nothing changed.',
      expired: 'Sign-in expired. Connect again to start over.',
      failed: 'Sign-in didn’t finish. Try connecting again.',
      client_refused: 'Client details were rejected and cleared. Connect again to enter new ones.',
      assistant_client_refused: 'The sign-in service didn’t accept your assistant’s client. Connect again to continue.',
    };
    for (const [code, message] of Object.entries(messages)) {
      const reply = await request(`/connections?outcome=${code}`);
      expect(reply.status).toBe(200);
      expect(reply.body.split(message)).toHaveLength(2);
      expect(reply.body).toContain("history.replaceState(null, '', location.pathname)");
    }
    const plain = await request('/connections');
    for (const message of Object.values(messages)) expect(plain.body).not.toContain(message);
    expect((await request('/connections?outcome=other')).status).toBe(404);
  });

  it('refuses an invited reader’s return with not-found and leaves the pending sign-in untouched', async () => {
    const app = fakeLedgerly();
    serve(app.handle);
    await post('/connections/add', { url: LEDGERLY, name: '' });
    const stored = await onlyApp();
    const url = await startSignIn(stored, { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET });

    const reply = await callback('app.ledgerly.example.test', app.approve(url).query, READER);
    expect(reply.status).toBe(404);
    expect(reply.body).toBe('');
    expect(signInRow(stored.id)).toEqual({ claimed_at: null });
    expect((await request('/connections', 'GET', { 'cf-access-jwt-assertion': READER })).status).toBe(404);
  });

  it('answers a return on another app’s path, and unknown, consumed or replaced states, with the same expired outcome', async () => {
    const app = fakeLedgerly();
    serve(app.handle, recipesServer);
    await post('/connections/add', { url: RECIPES, name: '' });
    await post('/connections/add', { url: LEDGERLY, name: '' });
    const stored = (await store.apps()).find((entry) => entry.host === 'app.ledgerly.example.test');
    if (!stored) throw new Error('Ledgerly was not added');

    const first = await startSignIn(stored, { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET });
    const firstQuery = app.approve(first).query;
    const elsewhere = await callback('recipes.example.test', firstQuery);
    expect(elsewhere.headers.location).toBe('/connections?outcome=expired');
    expect(signInRow(stored.id)).toEqual({ claimed_at: null });

    // A second start in another tab replaces the first, so the first tab's return reads as expired.
    const second = await startSignIn(await store.get(stored.id));
    expect((await callback('app.ledgerly.example.test', firstQuery)).headers.location).toBe(
      '/connections?outcome=expired',
    );
    const unknown = new URLSearchParams({ code: 'whatever', state: 'never-issued' });
    expect((await callback('app.ledgerly.example.test', unknown)).headers.location).toBe(
      '/connections?outcome=expired',
    );

    const secondQuery = app.approve(second).query;
    expect((await callback('app.ledgerly.example.test', secondQuery)).headers.location).toBe(toolsReturn(stored));
    expect((await callback('app.ledgerly.example.test', secondQuery)).headers.location).toBe(
      '/connections?outcome=expired',
    );
  });

  it('leaves the app as it was after a failed exchange, with the claimed sign-in unusable', async () => {
    const app = fakeLedgerly();
    serve(app.handle);
    await post('/connections/add', { url: LEDGERLY, name: '' });
    const stored = await onlyApp();
    const url = await startSignIn(stored, { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET });
    const query = app.approve(url).query;
    query.set('code', 'tampered-code');

    expect((await callback('app.ledgerly.example.test', query)).headers.location).toBe('/connections?outcome=failed');
    expect(await onlyApp()).toMatchObject({ status: 'not_connected' });
    expect(signInRow(stored.id)).toBeUndefined();
    expect((await callback('app.ledgerly.example.test', query)).headers.location).toBe('/connections?outcome=expired');
    expect(gateway.held.size).toBe(0);
    assertNoSentinels();
  });

  it('clears the sign-in and leaves the app as it was when the principal cancels at the server', async () => {
    const app = fakeLedgerly();
    serve(app.handle);
    await post('/connections/add', { url: LEDGERLY, name: '' });
    const stored = await onlyApp();
    const url = new URL(await startSignIn(stored, { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET }));
    const query = new URLSearchParams({
      error: 'access_denied',
      error_description: 'Morgan declined',
      state: url.searchParams.get('state') ?? '',
    });

    expect((await callback('app.ledgerly.example.test', query)).headers.location).toBe(
      '/connections?outcome=cancelled',
    );
    expect(await onlyApp()).toMatchObject({ status: 'not_connected' });
    expect(signInRow(stored.id)).toBeUndefined();
    expect(logged.join('\n')).not.toContain('Morgan declined');
  });

  it('refuses a cross-site sign-in start and leaves the pending sign-in as it was', async () => {
    const app = fakeLedgerly();
    serve(app.handle);
    await post('/connections/add', { url: LEDGERLY, name: '' });
    const stored = await onlyApp();
    await startSignIn(stored, { clientId: CLIENT_ID, clientSecret: SENTINEL_SECRET });
    const before = raw((db) => db.prepare('SELECT state_hash FROM sign_ins').all());

    const current = await store.get(stored.id);
    const reply = await post(
      '/connections/sign-in',
      { id: current.id, version: String(current.version) },
      { 'sec-fetch-site': 'cross-site' },
    );
    expect(reply.status).toBe(404);
    expect(raw((db) => db.prepare('SELECT state_hash FROM sign_ins').all())).toEqual(before);
  });
});

describe('managing apps', () => {
  it('disconnects at once: grant ended, credential gone, access revoked, pending sign-in cleared, restart requested', async () => {
    const ledgerly = fakeLedgerly();
    const connected = await connectedLedgerly(ledgerly);
    const grant = await store.readGrant(connected.id, 1);
    if (grant?.kind !== 'oauth' || !grant.refreshToken) throw new Error('Ledgerly issues refresh tokens');
    await store.startSignIn(connected.id, connected.version, {
      principalId: PRINCIPAL,
      verifier: 'pending-verifier-abcdefghijklmnopqrstuvwxyz0123456789',
      issuer: 'https://app.ledgerly.example.test/',
      redirectUri: LEDGERLY_REDIRECT,
      resource: LEDGERLY,
    });
    const app = await onlyApp();
    await store.clearRestart((await store.pendingRestart()) ?? '');

    const reply = await post('/connections/disconnect', { id: app.id, version: String(app.version) });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('App disconnected.');
    expect(await onlyApp()).toMatchObject({ status: 'not_connected' });
    expect(gateway.held.size).toBe(0);
    expect(await store.readAccessToken(app.id, 1)).toBeUndefined();
    expect(signInRow(app.id)).toBeUndefined();
    expect(ledgerly.revoked).toEqual([grant.refreshToken]);
    expect(await mainServers()).toEqual({});
    expect(await store.pendingRestart()).toBeDefined();
  });

  it('deletes a connected app even when the server refuses revocation', async () => {
    const ledgerly = fakeLedgerly();
    serve((incoming) => (incoming.path === '/oauth/revoke' ? { status: 503 } : undefined));
    const app = await connectedLedgerly(ledgerly);

    const reply = await post('/connections/delete', { id: app.id, version: String(app.version) });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('App deleted.');
    // Revocation was asked for and refused, and the delete went ahead.
    expect(endpoints.requests.filter((incoming) => incoming.path === '/oauth/revoke')).toHaveLength(1);
    expect(ledgerly.revoked).toEqual([]);
    expect(await store.apps()).toEqual([]);
    expect(gateway.held.size).toBe(0);
    expect(await mainServers()).toEqual({});
  });

  it('deletes an app that needs reconnecting', async () => {
    const app = await connectedLedgerly();
    const grant = await store.currentGrant(app.id);
    await store.markRefused(app.id, grant?.generation ?? 0);
    const refused = await onlyApp();
    expect(refused.status).toBe('needs_reconnecting');
    expect((await request('/connections')).body).toContain('Needs reconnecting');

    expect((await post('/connections/delete', { id: refused.id, version: String(refused.version) })).status).toBe(200);
    expect(await store.apps()).toEqual([]);
  });

  it('asks before Delete, which also forgets entered client details, and not before Disconnect', async () => {
    serve(recipesServer);
    await post('/connections/add', { url: RECIPES, name: '' });
    const list = (await request('/connections')).body;
    expect(list).toContain(
      'action="/connections/delete" data-send data-confirm-title="Delete Recipes?" data-confirm-action="Delete" data-confirm-message="Your assistant will lose access, and saved sign-in and client details will be removed. You can add it again anytime."',
    );
    expect(list).not.toMatch(/action="\/connections\/disconnect" data-send data-confirm/u);
  });

  it('renames the label only: the server key and main’s entry stay', async () => {
    serve(recipesServer);
    await post('/connections/add', { url: RECIPES, name: '' });
    let app = await onlyApp();
    await post('/connections/connect', { id: app.id, version: String(app.version) });
    app = await onlyApp();
    const before = await mainServers();

    const reply = await post('/connections/rename', { id: app.id, version: String(app.version), name: 'Family meals' });
    expect(reply.status).toBe(200);
    const renamed = await onlyApp();
    expect(renamed).toMatchObject({ name: 'Family meals', serverKey: app.serverKey, status: 'connected' });
    expect(await mainServers()).toEqual(before);
  });

  it('refuses every action carrying an old version and changes nothing', async () => {
    serve(recipesServer);
    await post('/connections/add', { url: RECIPES, name: '' });
    const stale = await onlyApp();
    await store.rename(stale.id, stale.version, 'Meals');
    const reference = { id: stale.id, version: String(stale.version) };

    for (const [route, data] of [
      ['/connections/connect', reference],
      ['/connections/disconnect', reference],
      ['/connections/delete', reference],
      ['/connections/rename', { ...reference, name: 'Dinners' }],
    ] as const) {
      const reply = await post(route, data);
      expect(reply.status).toBe(409);
      expect(reply.body).toContain('This app changed in another tab.');
    }
    const signIn = await post('/connections/sign-in', reference);
    expect(signIn.status).toBe(409);
    expect(await onlyApp()).toMatchObject({ name: 'Meals', status: 'not_connected' });
  });
});

describe('the add dialog', () => {
  it.each([
    [
      'credentials in the URL',
      `https://notes.example.test/mcp?api_key=${SENTINEL_QUERY}`,
      'Leave sign-in details and query text out of the address.',
    ],
    ['not https', 'http://notes.example.test/mcp', 'The address needs to start with https://.'],
    ['an unparseable address', 'notes', 'Enter the app’s full server address'],
    ['one of the assistant’s own services', 'https://api.anthropic.com/mcp', 'That address belongs to your assistant'],
    ['an operator server’s host', 'https://tasks.example.test/other', 'already uses this address'],
    ['a server that does not answer', 'https://down.example.test/mcp', 'The app didn’t respond.'],
    ['a server whose sign-in is unusable', 'https://recipes.example.test/mcp', 'sign-in method isn’t supported'],
  ])('refuses %s with a constant message and stores nothing', async (_case, url, message) => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', {
      tasks: { type: 'http', url: `https://tasks.example.test/mcp?key=${SENTINEL_QUERY}` },
    });
    serve(
      (incoming) => (incoming.host === 'down.example.test' ? { status: 503 } : undefined),
      (incoming) => (incoming.host === 'recipes.example.test' ? { status: 200, body: 'not json-rpc' } : undefined),
    );
    const reply = await post('/connections/add', { url, name: 'Notes' });
    expect(reply.status).toBe(400);
    expect(reply.body).toContain(message);
    expect(reply.body).toContain('value="Notes"');
    expect(await store.apps()).toEqual([]);
    assertNoSentinels();
  });

  it('refuses a host another app already uses', async () => {
    serve(recipesServer);
    await post('/connections/add', { url: RECIPES, name: '' });
    const reply = await post('/connections/add', { url: 'https://recipes.example.test/other', name: '' });
    expect(reply.status).toBe(400);
    expect(reply.body).toContain('already uses this address');
    expect(await store.apps()).toHaveLength(1);
  });

  it('refuses a name another app has, ignoring case', async () => {
    serve(recipesServer, notesServer);
    await post('/connections/add', { url: RECIPES, name: 'Kitchen' });
    const reply = await post('/connections/add', { url: NOTES, name: 'kitchen' });
    expect(reply.status).toBe(400);
    expect(reply.body).toContain('Another app already has that name.');
    expect(await store.apps()).toHaveLength(1);
  });
});

describe('page states', () => {
  it('shows an empty state and Add when there are no apps', async () => {
    const reply = await request('/connections');
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('<h2>No apps yet</h2>');
    expect(reply.body).toContain('href="/connections/new"');
    expect(reply.body).not.toContain('Your apps');
  });

  it('lists operator servers by host only, without a Your apps section, offering only Disconnect', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', {
      ledgerly: { type: 'http', url: `https://app.ledgerly.example.test/mcp?key=${SENTINEL_QUERY}` },
      calendar: { command: 'calendar-mcp' },
    });
    const reply = await request('/connections');
    expect(reply.body).toContain('Added by your operator');
    expect(reply.body).toContain('app.ledgerly.example.test');
    expect(reply.body).not.toContain('Your apps');
    expect(reply.body).not.toContain('calendar');
    expect(reply.body.match(/<(?:a|button)[^>]*role="menuitem"[^>]*>([^<]*)</gu)).toEqual([
      '<button type="submit" role="menuitem" tabindex="-1" data-pending-label="Disconnecting…" data-danger>Disconnect<',
      // The phone sheet's own Cancel, which a desktop dropdown does not show.
      '<button class="sheet-cancel" type="button" role="menuitem" tabindex="-1" data-menu-close>Cancel<',
    ]);
    expect(reply.body).toContain('action="/connections/disconnect-operator"');
    assertNoSentinels();
  });

  it('lists existing apps but hides Add and Connect with an unreadable Keychain', async () => {
    serve(recipesServer);
    await post('/connections/add', { url: RECIPES, name: '' });
    const app = await onlyApp();
    keychain.unavailable = true;
    const list = await request('/connections');
    expect(list.body).toContain('Recipes');
    expect(list.body).toContain('Apps can’t be added or connected right now. Ask your operator.');
    expect(list.body).not.toContain('href="/connections/new"');
    expect(list.body).not.toContain('/connect"');
    expect(list.body).toContain('Delete');
    expect((await request(`/connections/app/${app.id}/connect`)).body).not.toContain('action="/connections/connect"');
    expect((await request('/connections/new')).body).not.toContain('action="/connections/add"');
  });

  it('refuses unknown routes, other methods and non-principal identities with an empty not-found', async () => {
    for (const [route, method, headers] of [
      ['/connections/unknown', 'GET', {}],
      ['/connections/new?x=1', 'GET', {}],
      ['/connections/add', 'GET', {}],
      ['/connections/callback/app.ledgerly.example.test', 'HEAD', {}],
      ['/connections', 'GET', { 'cf-access-jwt-assertion': '' }],
      ['/connections', 'GET', { host: `${HOST}:443` }],
    ] as const) {
      const reply = await request(route, method, headers);
      expect(reply.status).toBe(404);
      expect(reply.body).toBe('');
    }
    expect((await post('/connections/add', { url: RECIPES, extra: 'x' })).status).toBe(404);
  });
});

describe('operator servers', () => {
  const ledgerlyEntry = { type: 'http', url: LEDGERLY };
  const confirmation =
    'data-confirm-title="Disconnect ledgerly?" data-confirm-action="Disconnect" data-confirm-message="Your assistant will stop using it and saved access to app.ledgerly.example.test will be removed. Your operator can add it back."';
  const disconnectLedgerly = () =>
    post('/connections/disconnect-operator', { key: 'ledgerly', host: 'app.ledgerly.example.test' });

  it('disconnects a hand-wired server after a confirmation naming it and its host: entry and credential gone', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { ledgerly: ledgerlyEntry });
    gateway.hold('ledgerly-bearer', 'app.ledgerly.example.test');
    gateway.hold('ledger-bearer', 'mcp.ledger.example.test');

    const page = await request('/connections');
    expect(page.body).toContain(confirmation);
    expect(page.body).not.toContain('ledgerly-bearer');

    const reply = await disconnectLedgerly();
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('App disconnected.');
    expect(reply.body).not.toContain('Added by your operator');
    expect(await mainServers()).toEqual({});
    expect([...gateway.held.keys()]).toEqual(['ledger-bearer']);
    expect(await store.pendingRestart()).toBeDefined();
    expect((await request('/connections')).body).not.toContain('app.ledgerly.example.test');
    assertNoSentinels();
  });

  it('keeps the server listed with Try again when a credential stays, and Try again completes the disconnect', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { ledgerly: ledgerlyEntry });
    gateway.hold('ledgerly-bearer', 'app.ledgerly.example.test');
    gateway.failingIds.add(gateway.hold('ledgerly-workspace', 'app.ledgerly.example.test'));

    const failed = await disconnectLedgerly();
    expect(failed.status).toBe(200);
    expect(failed.body).toContain('data-error="true"');
    expect(failed.body).toContain('so it’s still connected. Try again.');
    expect(failed.body).toContain('Added by your operator');
    expect(failed.body).toMatch(/action="\/connections\/disconnect-operator" data-send>.*>Try again<\/button>/u);
    expect(failed.body).not.toContain('ledgerly-workspace');
    expect(await mainServers()).toEqual({ ledgerly: ledgerlyEntry });
    expect([...gateway.held.keys()]).toEqual(['ledgerly-workspace']);

    gateway.failingIds.clear();
    const retried = await disconnectLedgerly();
    expect(retried.body).toContain('App disconnected.');
    expect(await mainServers()).toEqual({});
    expect(gateway.held.size).toBe(0);
  });

  it('asks again instead of offering Try again when the entry moved to another host while the disconnect stopped', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { ledgerly: ledgerlyEntry });
    gateway.failingIds.add(gateway.hold('ledgerly-workspace', 'app.ledgerly.example.test'));
    const removeById = gateway.removeById.bind(gateway);
    vi.spyOn(gateway, 'removeById').mockImplementation(async (ids) => {
      await updateContainerConfigJson(MAIN, 'mcp_servers', { ledgerly: { type: 'http', url: LEDGER } });
      return removeById(ids);
    });

    const failed = await disconnectLedgerly();
    expect(failed.body).toContain('so it’s still connected. Try again.');
    expect(failed.body).not.toContain('>Try again</button>');
    expect(failed.body).toContain('saved access to mcp.ledger.example.test will be removed.');
  });

  it('shows Can’t disconnect on a gateway that cannot list and remove credentials by host', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { ledgerly: ledgerlyEntry });
    gateway.hold('ledgerly-bearer', 'app.ledgerly.example.test');
    operatorCredentialsAvailable = false;

    const page = await request('/connections');
    expect(page.body).toContain('Can’t disconnect');
    expect(page.body).not.toContain('action="/connections/disconnect-operator"');
    expect((await disconnectLedgerly()).status).toBe(503);
    expect(await mainServers()).toEqual({ ledgerly: ledgerlyEntry });
    expect(gateway.held.size).toBe(1);
  });

  it('refuses a key that is not an operator http entry, or a host the entry no longer has, changing nothing', async () => {
    const connected = await connectedLedgerly();
    serve(recipesServer);
    const servers = { ...(await mainServers()), calendar: { command: 'calendar-mcp' } };
    await updateContainerConfigJson(MAIN, 'mcp_servers', {
      ...servers,
      recipes: { type: 'http', url: RECIPES },
    });
    gateway.hold('recipes-bearer', 'recipes.example.test');
    const held = [...gateway.held.keys()];

    for (const submission of [
      { key: connected.serverKey, host: 'app.ledgerly.example.test' },
      { key: 'calendar', host: '' },
      { key: 'recipes', host: 'app.ledgerly.example.test' },
    ]) {
      const reply = await post('/connections/disconnect-operator', submission);
      expect(reply.status).toBe(409);
      expect(reply.body).toContain('This app changed in another tab.');
    }
    expect(await mainServers()).toEqual({ ...servers, recipes: { type: 'http', url: RECIPES } });
    expect([...gateway.held.keys()]).toEqual(held);
    expect((await post('/connections/disconnect-operator', { key: 'recipes' })).status).toBe(404);
  });
});

describe('home status and link facts', () => {
  const listing = (overrides: Partial<ConnectionsListing>): (() => Promise<ConnectionsListing>) => {
    return async () => ({ listed: true, canChange: true, apps: [], operators: [], ...overrides });
  };
  const app = (status: ConnectionApp['status'], name: string): ConnectionApp => ({
    id: randomUUID(),
    serverKey: `app_${name.toLowerCase()}`,
    name,
    url: `https://${name.toLowerCase()}.example.test/mcp`,
    host: `${name.toLowerCase()}.example.test`,
    auth: 'token',
    issuer: null,
    hasClient: false,
    clientEntered: false,
    status,
    version: 1,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  });

  it('summarizes unavailable, then pending approvals, then reconnecting, then review needed, then connected apps, then none yet', async () => {
    const operator = { key: 'ledgerly', url: 'https://app.ledgerly.example.test/mcp' };
    const recipes = app('connected', 'Recipes');
    const pendingStub = (viewId: string): PendingHeldCallItem => ({
      viewId,
      approval: {
        approval_id: `appr-${viewId}`,
        session_id: 'sess-1',
        request_id: 'req-1',
        action: HELD_APP_CALL_ACTION,
        payload: '{}',
        title: 'Allow Recipes?',
        question: 'Allow?',
        options_json: '[]',
        status: 'pending',
        created_at: '2026-11-24T00:00:00.000Z',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        approver_user_id: 'gchat:users/morgan',
        agent_group_id: MAIN,
        channel_type: 'gchat',
        platform_id: 'spaces/dm',
        instance: null,
        platform_message_id: null,
      },
      payload: {
        viewId,
        invocationId: `inv-${viewId}`,
        appId: recipes.id,
        appName: 'Recipes',
        appHost: recipes.host,
        grantGeneration: 1,
        toolName: 'order_groceries',
        definitionHash: 'def-1',
        canonicalArgs: '{}',
        argsHash: 'args-1',
        summary: 'Place grocery order',
        appContext: null,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    expect(
      await connectionsStatus(
        listing({
          canChange: false,
          apps: [app('needs_reconnecting', 'Notes')],
          pendingApprovals: [pendingStub('h1')],
        }),
      ),
    ).toBe('Unavailable');
    expect(
      await connectionsStatus(
        listing({
          apps: [app('needs_reconnecting', 'Notes'), recipes],
          pendingApprovals: [pendingStub('h1')],
        }),
      ),
    ).toBe('1 approval waiting');
    expect(
      await connectionsStatus(
        listing({
          apps: [recipes],
          pendingApprovals: [pendingStub('h1'), pendingStub('h2')],
        }),
      ),
    ).toBe('2 approvals waiting');
    expect(await connectionsStatus(listing({ apps: [app('needs_reconnecting', 'Notes'), recipes] }))).toBe(
      '1 app needs reconnecting',
    );
    expect(
      await connectionsStatus(
        listing({
          apps: [recipes],
          pins: {
            [recipes.id]: {
              appId: recipes.id,
              instructions: null,
              listHash: 'hash-1',
              pinnedAt: '2026-11-23T12:00:00.000Z',
              confirmedAt: '2026-11-23T12:00:00.000Z',
              reviewedListHash: null,
              reviewedAt: null,
              needsReview: true,
            },
          },
        }),
      ),
    ).toBe('1 app needs review');
    expect(await connectionsStatus(listing({ apps: [recipes], operators: [operator] }))).toBe('2 apps connected');
    expect(await connectionsStatus(listing({ apps: [app('not_connected', 'Notes')] }))).toBe('No apps yet');
  });

  it('gives main each app’s name, key, host, origin and status, never an address', async () => {
    const facts = await connectionsLinkFacts(
      listing({
        apps: [app('connected', 'Recipes')],
        operators: [{ key: 'ledgerly', url: `https://app.ledgerly.example.test/mcp?key=${SENTINEL_QUERY}` }],
      }),
    );
    expect(facts).toEqual({
      apps: [
        { name: 'Recipes', key: 'app_recipes', host: 'recipes.example.test', origin: 'principal', status: 'connected' },
        {
          name: 'ledgerly',
          key: 'ledgerly',
          host: 'app.ledgerly.example.test',
          origin: 'operator',
          status: 'connected',
        },
      ],
    });
    expect(JSON.stringify(facts)).not.toContain('https://');
  });

  it('includes needsReview state in main link facts for pinned principal apps', async () => {
    const recipes = app('connected', 'Recipes');
    const needsReview = await connectionsLinkFacts(
      listing({
        apps: [recipes],
        pins: {
          [recipes.id]: {
            appId: recipes.id,
            instructions: null,
            listHash: 'hash-1',
            pinnedAt: '2026-11-23T12:00:00.000Z',
            confirmedAt: '2026-11-23T12:00:00.000Z',
            reviewedListHash: null,
            reviewedAt: null,
            needsReview: true,
          },
        },
      }),
    );
    expect(needsReview.apps).toEqual([
      {
        name: 'Recipes',
        key: 'app_recipes',
        host: 'recipes.example.test',
        origin: 'principal',
        status: 'connected',
        needsReview: true,
      },
    ]);
    const reviewed = await connectionsLinkFacts(
      listing({
        apps: [recipes],
        pins: {
          [recipes.id]: {
            appId: recipes.id,
            instructions: null,
            listHash: 'hash-1',
            pinnedAt: '2026-11-23T12:00:00.000Z',
            confirmedAt: '2026-11-23T12:00:00.000Z',
            reviewedListHash: 'hash-1',
            reviewedAt: '2026-11-23T12:05:00.000Z',
            needsReview: false,
          },
        },
      }),
    );
    expect(reviewed.apps[0]?.needsReview).toBe(false);
  });
});

describe('tool approvals review and held-call details', () => {
  it('leads to the review view after connecting, serves live tools-status, flips switches immediately, clears and restores review marker', async () => {
    serve(recipesServer);
    await post('/connections/add', { url: RECIPES, name: '' });
    let app = await onlyApp();
    const connectReply = await post('/connections/connect', { id: app.id, version: String(app.version) });
    expect(connectReply.status).toBe(200);
    expect(connectReply.headers['x-page-location']).toBe(`/connections/app/${app.id}/tools`);
    expect(connectReply.body).toContain('<h1>Recipes</h1>');
    expect(connectReply.body).toContain('data-tools-polling="true"');

    // Before pinning, tools-status reports pinned=false and refuses non-principal readers.
    const unpinnedStatus = await request(`/connections/app/${app.id}/tools-status`);
    expect(unpinnedStatus.status).toBe(200);
    expect(JSON.parse(unpinnedStatus.body)).toMatchObject({
      appId: app.id,
      pinned: false,
      hasUnsorted: true,
      tools: [],
    });
    expect(
      (await request(`/connections/app/${app.id}/tools-status`, 'GET', { 'cf-access-jwt-assertion': READER })).status,
    ).toBe(404);

    app = await onlyApp();
    const pinned = await store.pinTools(app.id, {
      instructions: null,
      tools: [
        { name: 'search_recipes', description: 'Search recipes', inputSchema: { type: 'object', properties: {} } },
        {
          name: 'order_groceries',
          description: 'Place grocery order',
          inputSchema: { type: 'object', properties: {} },
        },
        { name: 'sync_pantry', description: 'Sync pantry items', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    const hashes = new Map(pinned.tools.map((t) => [t.name, t.definitionHash]));
    await store.applyToolLabels(app.id, [
      {
        name: 'search_recipes',
        definitionHash: hashes.get('search_recipes')!,
        label: 'just_do',
        source: 'sorter',
        summary: 'Search recipes by keyword',
        reason: 'Read-only search',
      },
      {
        name: 'order_groceries',
        definitionHash: hashes.get('order_groceries')!,
        label: 'ask_first',
        source: 'floor',
        summary: 'Place a paid grocery order',
        reason: 'Places an order',
      },
    ]);

    const listBefore = await request('/connections');
    expect(listBefore.body).toContain('Checking…');
    expect(listBefore.body).toContain(`/connections/app/${app.id}/tools`);
    const factsBefore = await connectionsLinkFacts(() => operations().listing());
    expect(factsBefore.apps[0]?.needsReview).toBe(true);
    expect(factsBefore.apps[0]?.tools).toEqual([
      { name: 'order_groceries', label: 'ask_first', summary: 'Place a paid grocery order', reason: 'Places an order' },
      { name: 'search_recipes', label: 'just_do', summary: 'Search recipes by keyword', reason: 'Read-only search' },
      { name: 'sync_pantry', label: 'unsorted', reason: null },
    ]);

    const reviewWhileUnsorted = await request(`/connections/app/${app.id}/tools?outcome=connected`);
    expect(reviewWhileUnsorted.status).toBe(200);
    expect(reviewWhileUnsorted.body).toContain('<h1>Recipes</h1>');
    expect(reviewWhileUnsorted.body).toContain('Search recipes by keyword');
    expect(reviewWhileUnsorted.body).toContain('Place a paid grocery order');
    expect(reviewWhileUnsorted.body).toContain('Checking…');
    expect(reviewWhileUnsorted.body).toContain('data-tools-polling="true"');
    expect(reviewWhileUnsorted.body).toContain('data-review-form hidden');
    expect((await post('/connections/review-tools', { id: app.id, listHash: pinned.pin.listHash })).status).toBe(409);

    const staleToggle = await post('/connections/tool-label', {
      id: app.id,
      tool: 'order_groceries',
      label: 'just_do',
      definitionHash: 'stale-definition-hash',
    });
    expect(staleToggle.status).toBe(409);

    // JSON toggle returns a lightweight JSON payload and preserves the sharp tool summary.
    const flipDownJson = await post(
      '/connections/tool-label',
      {
        id: app.id,
        tool: 'order_groceries',
        label: 'just_do',
        definitionHash: hashes.get('order_groceries')!,
      },
      { accept: 'application/json' },
    );
    expect(flipDownJson.status).toBe(200);
    expect(JSON.parse(flipDownJson.body)).toEqual({
      ok: true,
      tool: 'order_groceries',
      label: 'just_do',
      definitionHash: hashes.get('order_groceries')!,
    });
    expect(await store.getTool(app.id, 'order_groceries')).toMatchObject({
      label: 'just_do',
      labelSource: 'principal',
      summary: 'Place a paid grocery order',
    });

    const flipUp = await post('/connections/tool-label', {
      id: app.id,
      tool: 'search_recipes',
      label: 'ask_first',
      definitionHash: hashes.get('search_recipes')!,
    });
    expect(flipUp.status).toBe(200);
    expect(flipUp.headers['x-page-saved']).toBe('true');
    expect(await store.getTool(app.id, 'search_recipes')).toMatchObject({
      label: 'ask_first',
      labelSource: 'principal',
      summary: 'Search recipes by keyword',
    });

    // Once the remaining unsorted tool receives a label, Confirm becomes visible and tools-status settles.
    await store.applyToolLabels(app.id, [
      {
        name: 'sync_pantry',
        definitionHash: hashes.get('sync_pantry')!,
        label: 'just_do',
        source: 'sorter',
        summary: 'Sync your pantry inventory',
        reason: 'Syncs pantry list',
      },
    ]);
    const settledStatus = await request(`/connections/app/${app.id}/tools-status`);
    expect(settledStatus.status).toBe(200);
    expect(JSON.parse(settledStatus.body)).toMatchObject({
      pinned: true,
      needsReview: true,
      hasUnsorted: false,
      listHash: pinned.pin.listHash,
    });
    const listReady = await request('/connections');
    expect(listReady.body).toContain('Needs review');

    const reviewReady = await request(`/connections/app/${app.id}/tools`);
    expect(reviewReady.status).toBe(200);
    expect(reviewReady.body).toContain('data-tools-polling="false"');
    expect(reviewReady.body).toContain('>Confirm</button>');
    expect(reviewReady.body).not.toContain('data-review-form hidden');

    const staleReview = await post('/connections/review-tools', { id: app.id, listHash: 'stale-hash' });
    expect(staleReview.status).toBe(409);

    const confirmed = await post('/connections/review-tools', { id: app.id, listHash: pinned.pin.listHash });
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers['x-page-location']).toBe('/connections');
    expect(confirmed.body.split('<script')[0]).not.toContain('Needs review');
    expect((await connectionsLinkFacts(() => operations().listing())).apps[0]?.needsReview).toBe(false);

    await store.pinTools(app.id, {
      instructions: null,
      tools: [
        {
          name: 'search_recipes',
          description: 'Search and bookmark recipes',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'order_groceries',
          description: 'Place grocery order',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    const listAfterChange = await request('/connections');
    expect(listAfterChange.body).toContain('Checking…');
    expect((await connectionsLinkFacts(() => operations().listing())).apps[0]?.needsReview).toBe(true);
  });

  it('shows full untruncated arguments and app words on /connections/held/<id> only to the principal', async () => {
    const approvalId = 'appr-held-detail-test';
    const viewId = 'held-detail-view-1';
    const longNotes = 'Special delivery instructions '.repeat(120);
    const payload: HeldAppCallPayload = {
      viewId,
      invocationId: 'sess-1:req-1',
      appId: randomUUID(),
      appName: 'Bistro',
      appHost: 'mcp.bistro.example.test',
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: 'defhash-1',
      canonicalArgs: JSON.stringify({
        checkout_id: 'chk_\u200B999',
        delivery_notes: longNotes,
      }),
      argsHash: 'argshash-1',
      summary: 'Confirm lunch order for Morgan',
      appContext: {
        toolName: 'prepare_checkout',
        text: 'Prepared checkout chk_999: 1x Grain Bowl, total $18.50.',
      },
      expiresAt: '2026-11-24T12:00:00.000Z',
    };
    await createPendingApproval({
      approval_id: approvalId,
      session_id: null,
      request_id: 'req-1',
      action: HELD_APP_CALL_ACTION,
      payload: JSON.stringify(payload),
      title: 'Allow Bistro to run confirm_checkout?',
      question: 'Truncated preview',
      options_json: JSON.stringify([{ value: 'approve', label: 'Approve' }]),
      status: 'pending',
      created_at: '2026-11-23T12:00:00.000Z',
      expires_at: payload.expiresAt,
    });

    const view = await request(`/connections/held/${viewId}`);
    expect(view.status).toBe(200);
    expect(view.body).toContain('<h1>Confirm checkout</h1>');
    expect(view.body).toContain('Bistro');
    expect(view.body).toContain('confirm_checkout');
    expect(view.body).toContain('Confirm lunch order for Morgan');
    expect(view.body).toContain('[U+200B]');
    expect(view.body).toContain(longNotes);
    expect(view.body).toContain('Prepared checkout chk_999: 1x Grain Bowl, total $18.50.');

    const readerView = await request(`/connections/held/${viewId}`, 'GET', {
      'cf-access-jwt-assertion': READER,
    });
    expect(readerView.status).toBe(404);
    expect(readerView.body).toBe('');

    const unknownView = await request('/connections/held/appr-does-not-exist');
    expect(unknownView.status).toBe(404);
    expect(unknownView.body).toBe('');
  });

  it('surfaces pending approvals on /connections and lets the principal Approve or Decline directly via POST /connections/held-decision', async () => {
    const principalUser = 'gchat:users/morgan';
    await upsertUser({
      id: principalUser,
      kind: 'human',
      display_name: 'Morgan',
      created_at: '2026-11-24T00:00:00.000Z',
    });
    await bindVerifiedPrincipalUser(principalUser, '2026-11-24T00:00:00.000Z');
    await createMessagingGroup({
      id: 'mg-dm',
      channel_type: 'gchat',
      platform_id: 'spaces/dm-morgan',
      name: 'Morgan DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: '2026-11-24T00:00:00.000Z',
    });
    await createSession({
      id: 'sess-main-web',
      agent_group_id: MAIN,
      messaging_group_id: 'mg-dm',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      created_at: '2026-11-24T00:00:00.000Z',
      last_active: '2026-11-24T00:00:00.000Z',
    });

    const previousAdapter = getDeliveryAdapter();
    const editedCards: string[] = [];
    setDeliveryAdapter({
      deliver: async (_channelType, _platformId, _threadId, _format, content) => {
        editedCards.push(content);
        return undefined;
      },
    });
    const executedCalls: string[] = [];
    const writtenNotes: string[] = [];
    const executeApprovedCall: AppRelay['executeApprovedCall'] = async (input) => {
      executedCalls.push(`${input.toolName}:${JSON.stringify(input.args)}`);
      return {
        status: 'completed',
        result: { content: [{ type: 'text', text: 'Order placed #8841' }] },
      };
    };
    registerHeldAppCallHandlers({
      relay: () => ({ executeApprovedCall }) as AppRelay,
      writeNote: async (note) => {
        writtenNotes.push(note.text);
        return 'written';
      },
    });

    const insertHeld = async (viewId: string, summary: string, expiresAt: string) => {
      const args = { checkout_id: `chk_${viewId}` };
      const { canonical, hash } = canonicalArgsHash(args);
      const payload: HeldAppCallPayload = {
        viewId,
        invocationId: `sess-main-web:req-${viewId}`,
        appId: randomUUID(),
        appName: 'Bistro',
        appHost: 'mcp.bistro.example.test',
        grantGeneration: 1,
        toolName: 'confirm_checkout',
        definitionHash: 'defhash-1',
        canonicalArgs: canonical,
        argsHash: hash,
        summary,
        appContext: null,
        expiresAt,
      };
      await createPendingApproval({
        approval_id: `appr-${viewId}`,
        session_id: 'sess-main-web',
        request_id: `req-${viewId}`,
        action: HELD_APP_CALL_ACTION,
        payload: JSON.stringify(payload),
        title: 'Allow Bistro to run confirm_checkout?',
        question: 'Order details',
        options_json: JSON.stringify([
          { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
          { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
        ]),
        status: 'pending',
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        approver_user_id: principalUser,
        channel_type: 'gchat',
        platform_id: 'spaces/dm-morgan',
        platform_message_id: `msg-${viewId}`,
      });
    };

    const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await insertHeld('held-live-approve', 'Place lunch order', futureExpiry);
    await insertHeld('held-live-decline', 'Place extra drink order', futureExpiry);
    await insertHeld('held-already-expired', 'Stale expired order', pastExpiry);

    try {
      // Connections list surfaces pending unexpired approvals at top and omits expired ones.
      const list = await request('/connections');
      expect(list.status).toBe(200);
      expect(list.body).toContain('Waiting for approval');
      expect(list.body).toContain('/connections/held/held-live-approve');
      expect(list.body).toContain('Place lunch order');
      expect(list.body).toContain('/connections/held/held-live-decline');
      expect(list.body).not.toContain('Stale expired order');

      // Pending detail page renders direct Approve & Decline forms with no chat bounce-back notice.
      const detail = await request('/connections/held/held-live-approve');
      expect(detail.status).toBe(200);
      expect(detail.body).toContain('action="/connections/held-decision"');
      expect(detail.body).toContain('>Approve</button>');
      expect(detail.body).toContain('>Decline</button>');
      expect(detail.body).not.toContain('Reply 👍 or 👎 in chat');

      // Expired detail page renders Expired state without Approve/Decline buttons.
      const expiredDetail = await request('/connections/held/held-already-expired');
      expect(expiredDetail.status).toBe(200);
      expect(expiredDetail.body).toContain('Expired');
      expect(expiredDetail.body).not.toContain('action="/connections/held-decision"');

      // Non-principal reader and cross-site POST are refused with empty 404.
      const readerPost = await request(
        '/connections/held-decision',
        'POST',
        { ...postHeaders, 'cf-access-jwt-assertion': READER },
        JSON.stringify({ viewId: 'held-live-approve', decision: 'approve' }),
      );
      expect(readerPost.status).toBe(404);
      expect(readerPost.body).toBe('');
      const crossSite = await request(
        '/connections/held-decision',
        'POST',
        { ...postHeaders, 'sec-fetch-site': 'cross-site' },
        JSON.stringify({ viewId: 'held-live-approve', decision: 'approve' }),
      );
      expect(crossSite.status).toBe(404);
      expect(executedCalls).toEqual([]);

      // Invalid decision is refused with empty 404 (kit InvalidSubmission).
      const invalidDecision = await post('/connections/held-decision', {
        viewId: 'held-live-approve',
        decision: 'maybe',
      });
      expect(invalidDecision.status).toBe(404);
      expect(invalidDecision.body).toBe('');
      expect(executedCalls).toEqual([]);

      // Approve from web executes once, edits chat card in place, and returns terminal Approved page.
      const approved = await post('/connections/held-decision', {
        viewId: 'held-live-approve',
        decision: 'approve',
      });
      expect(approved.status).toBe(200);
      expect(approved.headers['x-page-saved']).toBe('true');
      expect(approved.body).toContain('Approved. Your assistant has the result in chat.');
      expect(approved.body).not.toContain('action="/connections/held-decision"');
      expect(executedCalls).toEqual(['confirm_checkout:{"checkout_id":"chk_held-live-approve"}']);
      expect(editedCards.some((entry) => entry.includes('Approved'))).toBe(true);
      expect(writtenNotes.some((note) => note.includes('Order placed #8841'))).toBe(true);

      // Re-submitting the already-answered request does not re-execute and navigates cleanly to /connections.
      const replay = await post('/connections/held-decision', {
        viewId: 'held-live-approve',
        decision: 'approve',
      });
      expect(replay.status).toBe(200);
      expect(replay.headers['x-page-saved']).toBeUndefined();
      expect(replay.headers['x-page-location']).toBe('/connections');
      expect(replay.body).toContain('This request is no longer pending.');
      expect(executedCalls).toHaveLength(1);

      // Decline from web does not execute, edits chat card in place, and returns terminal Declined page.
      const declined = await post('/connections/held-decision', {
        viewId: 'held-live-decline',
        decision: 'reject',
      });
      expect(declined.status).toBe(200);
      expect(declined.headers['x-page-saved']).toBe('true');
      expect(declined.body).toContain('Declined. Nothing was sent.');
      expect(declined.body).not.toContain('action="/connections/held-decision"');
      expect(executedCalls).toHaveLength(1);
      expect(editedCards.some((entry) => entry.includes('Rejected'))).toBe(true);

      // Pending approvals section disappears once all pending approvals are answered.
      const listAfter = await request('/connections');
      expect(listAfter.body).not.toContain('Waiting for approval');
    } finally {
      if (previousAdapter) setDeliveryAdapter(previousAdapter);
      registerHeldAppCallHandlers();
    }
  });

  it.skipIf(!chromePath).each([
    { label: 'mobile', width: 375, height: 812 },
    { label: 'desktop', width: 1280, height: 800 },
  ])(
    'live-polls unsorted tools to ready, toggles in place without re-sorting, and renders native $label layout in Chrome',
    async ({ label, width, height }) => {
      serve(recipesServer);
      await post('/connections/add', { url: RECIPES, name: 'Bistro' });
      let app = await onlyApp();
      await post('/connections/connect', { id: app.id, version: String(app.version) });
      app = await onlyApp();
      const pinned = await store.pinTools(app.id, {
        instructions: null,
        tools: [
          {
            name: 'confirm_checkout',
            description: 'Place the order and charge the card.',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'create_cart',
            description: 'Create a temporary draft cart.',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: false },
          },
        ],
      });
      const hashes = new Map(pinned.tools.map((t) => [t.name, t.definitionHash]));

      const browser = await chromium.launch({ executablePath: chromePath, headless: true });
      try {
        const context = await browser.newContext({ viewport: { width, height } });
        await context.route(`https://${HOST}/**`, async (route) => {
          const sent = route.request();
          const url = new URL(sent.url());
          const body = sent.postData() ?? undefined;
          const headers = await sent.allHeaders();
          const forwarded = Object.fromEntries(
            ['accept', 'content-type', 'origin', 'sec-fetch-site'].flatMap((name) =>
              headers[name] ? [[name, headers[name]]] : [],
            ),
          );
          const reply = await request(`${url.pathname}${url.search}`, sent.method(), forwarded, body);
          await route.fulfill({
            status: reply.status,
            headers: Object.fromEntries(
              Object.entries(reply.headers).flatMap(([name, value]) =>
                CONNECTION_HEADERS.has(name) || value === undefined
                  ? []
                  : [[name, Array.isArray(value) ? value.join(', ') : value]],
              ),
            ),
            body: reply.body,
          });
        });

        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(`https://${HOST}/connections/app/${app.id}/tools`);

        // Initially unsorted: shows Checking shimmer and hides Confirm.
        expect(await page.locator('[data-tools-app]').getAttribute('data-tools-polling')).toBe('true');
        expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

        // Backend sorter finishes asynchronously: UI updates live without a manual reload!
        await store.applyToolLabels(app.id, [
          {
            name: 'confirm_checkout',
            definitionHash: hashes.get('confirm_checkout')!,
            label: 'ask_first',
            source: 'floor',
            summary: 'Place order and charge card',
            reason: 'Charges saved card',
          },
          {
            name: 'create_cart',
            definitionHash: hashes.get('create_cart')!,
            label: 'just_do',
            source: 'sorter',
            summary: 'Start a draft order cart',
            reason: 'Reversible draft cart step',
          },
        ]);

        await expect
          .poll(() => page.locator('[data-tools-app]').getAttribute('data-tools-polling'), { timeout: 5000 })
          .toBe('false');
        await expect
          .poll(() => page.locator('[data-tool-row="create_cart"] [data-tool-desc]').textContent(), { timeout: 5000 })
          .toBe('Start a draft order cart');
        await expect
          .poll(() => page.locator('[data-tool-row="confirm_checkout"] [data-tool-desc]').textContent(), {
            timeout: 5000,
          })
          .toBe('Place order and charge card');
        expect(pageErrors).toEqual([]);

        // Mobile vs Desktop native layout invariants.
        const isMobile = label === 'mobile';
        expect(await page.locator('.tools-card-head').isVisible()).toBe(!isMobile);
        expect(await page.locator('.tools-mobile-strip').isVisible()).toBe(isMobile);
        expect(await page.locator('.review-header-form button').isVisible()).toBe(!isMobile);
        expect(await page.locator('.review-dock button').isVisible()).toBe(isMobile);
        expect(await page.locator('[data-tool-row="create_cart"] .tool-slug').isVisible()).toBe(!isMobile);
        expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

        // Touch target check: all visible buttons/switches are >= 44px on mobile.
        if (isMobile) {
          const undersized = await page.evaluate<string[]>(
            `[...document.querySelectorAll('button, a.app-link')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); }).map(el => el.getAttribute('aria-label') || el.textContent)`,
          );
          expect(undersized).toEqual([]);
        }

        // Optimistic in-place switch toggle: flips without reordering rows or showing an #outcome jump banner.
        const orderBefore = await page
          .locator('[data-tool-row]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-tool-row')));
        const cartSwitch = page.locator('button[data-switch-name="create_cart"]');
        expect(await cartSwitch.getAttribute('aria-checked')).toBe('false');
        await cartSwitch.click();
        await expect.poll(() => cartSwitch.getAttribute('aria-checked')).toBe('true');
        await expect.poll(async () => (await store.getTool(app.id, 'create_cart'))?.label).toBe('ask_first');
        const orderAfter = await page
          .locator('[data-tool-row]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-tool-row')));
        expect(orderAfter).toEqual(orderBefore);
        expect(await page.locator('#outcome').isVisible()).toBe(false);

        // Confirm review works via the viewport-appropriate Confirm button.
        const confirmBtn = isMobile ? page.locator('.review-dock button') : page.locator('.review-header-form button');
        await confirmBtn.click();
        await page.waitForURL(`https://${HOST}/connections`);
        expect((await store.getPin(app.id))?.needsReview).toBe(false);
        expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

        // Held call approval surfaced on /connections and directly approvable in Chrome on both mobile & desktop.
        const principalUser = 'gchat:users/morgan';
        await upsertUser({
          id: principalUser,
          kind: 'human',
          display_name: 'Morgan',
          created_at: '2026-11-24T00:00:00.000Z',
        });
        await bindVerifiedPrincipalUser(principalUser, '2026-11-24T00:00:00.000Z');
        await createMessagingGroup({
          id: `mg-dm-${label}`,
          channel_type: 'gchat',
          platform_id: 'spaces/dm-morgan',
          name: 'Morgan DM',
          is_group: 0,
          unknown_sender_policy: 'strict',
          created_at: '2026-11-24T00:00:00.000Z',
        });
        await createSession({
          id: `sess-chrome-${label}`,
          agent_group_id: MAIN,
          messaging_group_id: `mg-dm-${label}`,
          thread_id: null,
          agent_provider: null,
          status: 'active',
          container_status: 'stopped',
          created_at: '2026-11-24T00:00:00.000Z',
          last_active: '2026-11-24T00:00:00.000Z',
        });
        const chromeExecuted: string[] = [];
        const chromeExecuteApproved: AppRelay['executeApprovedCall'] = async (input) => {
          chromeExecuted.push(input.toolName);
          return { status: 'completed', result: { content: [{ type: 'text', text: 'Done' }] } };
        };
        registerHeldAppCallHandlers({
          relay: () => ({ executeApprovedCall: chromeExecuteApproved }) as AppRelay,
          writeNote: async () => 'written',
        });
        const heldViewId = `held-chrome-${label}`;
        const { canonical, hash } = canonicalArgsHash({ checkout_id: 'chk_chrome' });
        const heldPayload: HeldAppCallPayload = {
          viewId: heldViewId,
          invocationId: `sess-chrome-${label}:req-1`,
          appId: app.id,
          appName: 'Bistro',
          appHost: app.host,
          grantGeneration: 1,
          toolName: 'confirm_checkout',
          definitionHash: hashes.get('confirm_checkout')!,
          canonicalArgs: canonical,
          argsHash: hash,
          summary: 'Place lunch order from Corner Kitchen',
          appContext: null,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        };
        await createPendingApproval({
          approval_id: `appr-${heldViewId}`,
          session_id: `sess-chrome-${label}`,
          request_id: 'req-1',
          action: HELD_APP_CALL_ACTION,
          payload: JSON.stringify(heldPayload),
          title: 'Allow Bistro to run confirm_checkout?',
          question: 'Order details',
          options_json: JSON.stringify([{ label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' }]),
          status: 'pending',
          created_at: new Date().toISOString(),
          expires_at: heldPayload.expiresAt,
          approver_user_id: principalUser,
          channel_type: 'gchat',
          platform_id: 'spaces/dm-morgan',
        });

        try {
          await page.goto(`https://${HOST}/connections`);
          expect(await page.locator('#pending-approvals-heading').isVisible()).toBe(true);
          expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
          await page.locator(`a.approval-link[href="/connections/held/${heldViewId}"]`).click();
          await page.waitForURL(`https://${HOST}/connections/held/${heldViewId}`);
          expect(await page.locator('.held-actions-header').isVisible()).toBe(!isMobile);
          expect(await page.locator('.held-dock').isVisible()).toBe(isMobile);
          expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
          if (isMobile) {
            const undersizedHeld = await page.evaluate<string[]>(
              `[...document.querySelectorAll('button, a.back-link')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); }).map(el => el.getAttribute('aria-label') || el.textContent)`,
            );
            expect(undersizedHeld).toEqual([]);
          }
          const approveBtn = isMobile
            ? page.locator('.held-dock button.button-primary')
            : page.locator('.held-actions-header button.button-primary');
          await approveBtn.click();
          await expect
            .poll(() => page.locator('#outcome').textContent(), { timeout: 5000 })
            .toContain('Approved. Your assistant has the result in chat.');
          expect(await page.locator('.held-dock').count()).toBe(0);
          expect(await page.locator('.held-actions-header').count()).toBe(0);
          expect(chromeExecuted).toEqual(['confirm_checkout']);
          expect(pageErrors).toEqual([]);
        } finally {
          registerHeldAppCallHandlers();
        }

        await context.close();
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
