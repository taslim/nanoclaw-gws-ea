import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import type { GatewayCredentialRemoval } from '../../gateway-providers/credential-connection.js';
import '../gws-ea-profile/index.js';
import { appCredentialName } from './admit.js';
import { applyMainServers, appRelayServerEntry } from './apply.js';
import { withAppLock } from './locks.js';
import { appRedirectUri, type ConnectionFetches } from './oauth.js';
import {
  createConnectionsRefresher,
  REFRESH_TICK_MS,
  startConnectionsRefresher,
  stopConnectionsRefresher,
  type AppGateway,
  type ConnectionsRefresherDependencies,
  type RefusedApp,
  type RefresherLog,
} from './refresher.js';
import {
  ConnectionsStoreError,
  type ClientRegistration,
  type ConnectionApp,
  type ConnectionsStore,
  type LiveGrant,
} from './store.js';
import {
  FakeMcpApp,
  startFakeEndpoints,
  type FakeAppOptions,
  type FakeEndpoints,
  type FakeHandler,
  type FakeReply,
} from './testing/oauth-server.js';
import { testConnectionsStore } from './testing/store.js';

const MAIN = 'ag-main';
const ASSISTANT = 'juno.example.test';
const PRINCIPAL = 'gchat:users/morgan-ellery';
const LEDGERLY = 'https://app.ledgerly.example.test/mcp';
const LEDGER = 'https://mcp.ledger.example.test/mcp';
const NOTES = 'https://notes.example.test/mcp';
const CLIENT_SECRET = 'sentinel-client-secret-7Hk2';
const PASTED_TOKEN = 'sentinel-pasted-token-Q4v8';
const START = Date.parse('2026-11-14T12:00:00.000Z');
const MINUTE = 60_000;

interface Held {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  value: string;
}

/** The gateway's sweep surface: credentials listed and removed by exact host, never written by the refresher. */
class FakeGateway implements AppGateway {
  readonly held = new Map<string, Held>();
  readonly failingRemovals = new Set<string>();
  private next = 1;

  readonly listForHost = async (host: string) =>
    [...this.held.values()].filter((held) => held.host === host).map(({ id, name }) => ({ id, name }));

  readonly removeById = async (ids: readonly string[]): Promise<GatewayCredentialRemoval[]> =>
    ids.map((id) => {
      if (this.failingRemovals.has(id)) return { id, outcome: 'failed' };
      return { id, outcome: this.held.delete(id) ? 'removed' : 'gone' };
    });

  put(name: string, host: string, value: string): Held {
    const held = { id: `secret-${this.next++}`, name, host, value };
    this.held.set(held.id, held);
    return held;
  }

  byName(name: string): Held | undefined {
    return [...this.held.values()].find((held) => held.name === name);
  }
}

/** A token endpoint that rotates refresh tokens and can be told to refuse, fail or answer without `expires_in`. */
class TokenEndpoint {
  readonly presented: string[] = [];
  readonly queued: FakeReply[] = [];
  expiresIn: number | undefined = 3600;
  issued = 0;
  /** Runs while a token request is in flight, before the reply. */
  onRequest: (() => void) | undefined;

  constructor(readonly host: string) {}

  readonly handle: FakeHandler = (request) => {
    if (request.host !== this.host || request.method !== 'POST' || request.path !== '/oauth/token') return undefined;
    this.onRequest?.();
    this.presented.push(new URLSearchParams(request.body).get('refresh_token') ?? '');
    const queued = this.queued.shift();
    if (queued) return queued;
    this.issued += 1;
    return {
      status: 200,
      body: {
        access_token: `sentinel-access-${this.issued}`,
        token_type: 'Bearer',
        refresh_token: `sentinel-refresh-${this.issued}`,
        ...(this.expiresIn === undefined ? {} : { expires_in: this.expiresIn }),
      },
    };
  };
}

interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: Record<string, unknown> | undefined;
}

let endpoints: FakeEndpoints;
let directory: string;
let store: ConnectionsStore;
let gateway: FakeGateway;
let clock: number;
let lines: LogLine[];
let refused: RefusedApp[];
let applied: boolean[];
let documentsServed: boolean;

const testLog: RefresherLog = {
  info: (message, fields) => lines.push({ level: 'info', message, fields }),
  warn: (message, fields) => lines.push({ level: 'warn', message, fields }),
  error: (message, fields) => lines.push({ level: 'error', message, fields }),
};

function dependencies(overrides: Partial<ConnectionsRefresherDependencies> = {}): ConnectionsRefresherDependencies {
  return {
    store,
    gateway,
    fetches: endpoints.fetches,
    assistantHost: async () => ASSISTANT,
    now: () => clock,
    log: testLog,
    apply: async (target) => {
      const changed = await applyMainServers(target);
      applied.push(changed);
      return changed;
    },
    onRefused: (app) => {
      refused.push(app);
    },
    clientDocumentsServed: () => documentsServed,
    ...overrides,
  };
}

beforeAll(async () => {
  endpoints = await startFakeEndpoints(['app.ledgerly.example.test', 'mcp.ledger.example.test', 'notes.example.test']);
});
afterAll(async () => {
  await endpoints.close();
});

beforeEach(async () => {
  endpoints.reset();
  directory = await mkdtemp(path.join(os.tmpdir(), 'connections-refresher-'));
  ({ store } = testConnectionsStore(path.join(directory, 'connections')));
  gateway = new FakeGateway();
  clock = START;
  lines = [];
  refused = [];
  applied = [];
  documentsServed = true;
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
});

afterEach(async () => {
  await stopConnectionsRefresher();
  // Every line names an app and a code, never a token, a client secret or a server's words.
  const written = JSON.stringify(lines);
  expect(written).not.toContain('sentinel');
  for (const line of lines) for (const key of Object.keys(line.fields ?? {})) expect(['appId', 'code']).toContain(key);
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

function serveApp(appUrl: string, options: Partial<FakeAppOptions> = {}): TokenEndpoint {
  const host = new URL(appUrl).hostname;
  const tokens = new TokenEndpoint(host);
  const app = new FakeMcpApp({ appUrl, issuer: `https://${host}`, ...options });
  endpoints.use(tokens.handle);
  endpoints.use(app.handle);
  return tokens;
}

interface OAuthGrantSpec {
  readonly refreshToken?: string;
  readonly accessToken?: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** An app signed in through the store's own sign-in path, as the page leaves it. */
async function oauthApp(
  name: string,
  appUrl: string,
  grant: OAuthGrantSpec,
  client: (app: ConnectionApp) => ClientRegistration = (app) => ({
    clientId: `${app.host}-client`,
    clientSecret: CLIENT_SECRET,
  }),
): Promise<ConnectionApp> {
  const host = new URL(appUrl).hostname;
  const issuer = `https://${host}/`;
  const created = await store.create({ name, url: appUrl, auth: 'oauth', issuer });
  const sealed = client(created);
  const withClient = await store.setClient(created.id, created.version, {
    issuer,
    client: sealed,
    entered: sealed.kind !== 'document',
  });
  const { state } = await store.startSignIn(withClient.id, withClient.version, {
    principalId: PRINCIPAL,
    verifier: 'verifier-'.padEnd(48, 'x'),
    issuer,
    redirectUri: appRedirectUri(ASSISTANT, host),
    resource: appUrl,
  });
  const claim = await store.claimSignIn(state, { host, principalId: PRINCIPAL });
  if (!claim) throw new Error('The sign-in was not claimed');
  const done = await store.completeSignIn(claim, {
    kind: 'oauth',
    ...(grant.refreshToken === undefined ? {} : { refreshToken: grant.refreshToken }),
    ...(grant.accessToken === undefined ? {} : { accessToken: grant.accessToken }),
    accessIssuedAt: new Date(grant.issuedAt).toISOString(),
    accessExpiresAt: new Date(grant.expiresAt).toISOString(),
  });
  if (done.status !== 'connected') throw new Error('The sign-in did not connect');
  return done.app;
}

/** As a connect leaves it: the grant and sealed access token stored in the host store, nothing in the gateway. */
async function storedOAuthApp(
  name: string,
  appUrl: string,
  grant: Omit<OAuthGrantSpec, 'accessToken'>,
  client?: (app: ConnectionApp) => ClientRegistration,
): Promise<ConnectionApp> {
  return oauthApp(name, appUrl, { ...grant, accessToken: 'sentinel-access-at-sign-in' }, client);
}

async function tokenApp(name: string, appUrl: string): Promise<ConnectionApp> {
  const created = await store.create({ name, url: appUrl, auth: 'token' });
  const { app } = await store.connect(created.id, created.version, { kind: 'token', token: PASTED_TOKEN });
  return app;
}

async function grantOf(app: Pick<ConnectionApp, 'id'>): Promise<LiveGrant | undefined> {
  return store.currentGrant(app.id);
}

async function storedTokenOf(app: Pick<ConnectionApp, 'id'>, generation = 1): Promise<string | undefined> {
  return (await store.readAccessToken(app.id, generation))?.token;
}

async function mainServers(): Promise<Record<string, unknown>> {
  const row = await getContainerConfig(MAIN);
  if (!row) throw new Error('Main has no container config');
  return JSON.parse(row.mcp_servers) as Record<string, unknown>;
}

describe('renewal timing', () => {
  it('renews a token ten minutes from expiry into the store and skips one forty minutes away', async () => {
    const homeTokens = serveApp(LEDGERLY);
    const ledgerTokens = serveApp(LEDGER);
    const home = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 50 * MINUTE,
      expiresAt: START + 10 * MINUTE,
    });
    const ledger = await storedOAuthApp('Ledger', LEDGER, {
      refreshToken: 'sentinel-refresh-ledger',
      issuedAt: START - 20 * MINUTE,
      expiresAt: START + 40 * MINUTE,
    });

    await createConnectionsRefresher(dependencies()).tick();

    expect(homeTokens.presented).toEqual(['sentinel-refresh-home']);
    expect(await storedTokenOf(home)).toBe('sentinel-access-1');
    expect(await grantOf(home)).toMatchObject({
      hasAccessToken: true,
      accessIssuedAt: new Date(START).toISOString(),
      accessExpiresAt: new Date(START + 60 * MINUTE).toISOString(),
    });
    expect(ledgerTokens.presented).toEqual([]);
    expect(await storedTokenOf(ledger)).toBe('sentinel-access-at-sign-in');
    expect(gateway.held.size).toBe(0);
  });

  it('renews a five-minute token at about half its lifetime, not on every tick', async () => {
    const tokens = serveApp(LEDGERLY);
    tokens.expiresIn = 300;
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START,
      expiresAt: START + 5 * MINUTE,
    });
    const refresher = createConnectionsRefresher(dependencies());
    const renewedAt: number[] = [];
    for (let minute = 0; minute <= 9; minute += 1) {
      clock = START + minute * MINUTE;
      const before = tokens.presented.length;
      await refresher.tick();
      if (tokens.presented.length > before) renewedAt.push(minute);
    }

    // Each token is renewed once less than 2.5 of its 5 minutes would remain at the next tick: every other minute.
    expect(renewedAt).toEqual([2, 4, 6, 8]);
    expect(await storedTokenOf(app)).toBe('sentinel-access-4');
    expect(await grantOf(app)).toMatchObject({ accessExpiresAt: new Date(START + 13 * MINUTE).toISOString() });
    expect(gateway.held.size).toBe(0);
  });

  it('renews a token issued without expires_in after about 45 minutes', async () => {
    const tokens = serveApp(LEDGERLY);
    tokens.expiresIn = undefined;
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 59 * MINUTE,
      expiresAt: START + MINUTE,
    });
    const refresher = createConnectionsRefresher(dependencies());

    await refresher.tick();
    expect(tokens.presented).toHaveLength(1);
    expect(await grantOf(app)).toMatchObject({ accessExpiresAt: new Date(START + 60 * MINUTE).toISOString() });

    clock = START + 44 * MINUTE;
    await refresher.tick();
    expect(tokens.presented).toHaveLength(1);

    clock = START + 46 * MINUTE;
    await refresher.tick();
    expect(tokens.presented).toEqual(['sentinel-refresh-home', 'sentinel-refresh-1']);
    expect(await storedTokenOf(app)).toBe('sentinel-access-2');
  });

  it('keeps a short-lived grant working until the next tick, signed in between ticks and with ticks running late', async () => {
    const tokens = serveApp(LEDGERLY);
    tokens.expiresIn = 120;
    // Signed in 58 seconds before the first tick, so its renewal point falls between that tick and the next.
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 58_000,
      expiresAt: START + 62_000,
    });
    const refresher = createConnectionsRefresher(dependencies());
    const period = REFRESH_TICK_MS + 5_000;
    for (let tick = 0; tick <= 10; tick += 1) {
      clock = START + tick * period;
      await refresher.tick();
      const grant = await grantOf(app);
      if (grant?.kind !== 'oauth') throw new Error('The grant ended');
      expect(Date.parse(grant.accessExpiresAt)).toBeGreaterThan(clock + period);
    }
    expect(await storedTokenOf(app)).toBe(`sentinel-access-${tokens.issued}`);
  });
});

/** A server that takes client documents from `none` clients. */
const documentServer: Partial<FakeAppOptions> = {
  tokenAuthMethods: ['none'],
  fetchClientDocument: async () => ({ status: 404 }),
};
const documentClient = (app: ConnectionApp): ClientRegistration => ({
  clientId: `https://${ASSISTANT}/oauth-client/${app.id}`,
  tokenEndpointAuthMethod: 'none',
  kind: 'document',
});

describe('durable rotation and missing tokens', () => {
  it('renews a document client with its client ID and resource, no secret, and stores both rotated tokens', async () => {
    const tokens = serveApp(LEDGERLY, documentServer);
    const app = await storedOAuthApp(
      'Ledgerly',
      LEDGERLY,
      { refreshToken: 'sentinel-refresh-home', issuedAt: START - 55 * MINUTE, expiresAt: START + 5 * MINUTE },
      documentClient,
    );
    const refresher = createConnectionsRefresher(dependencies());

    await refresher.tick();

    const [renewal] = endpoints.requests.filter(({ path: route }) => route === '/oauth/token');
    const sent = new URLSearchParams(renewal.body);
    expect(sent.get('client_id')).toBe(documentClient(app).clientId);
    expect(sent.get('resource')).toBe(LEDGERLY);
    expect(sent.has('client_secret')).toBe(false);
    expect(renewal.headers.authorization).toBeUndefined();
    expect(await storedTokenOf(app)).toBe('sentinel-access-1');
    expect(gateway.held.size).toBe(0);

    clock = START + 50 * MINUTE;
    await refresher.tick();
    expect(tokens.presented).toEqual(['sentinel-refresh-home', 'sentinel-refresh-1']);
  });

  it('holds a rotation that could not be stored, and stores both tokens next instead of renewing again', async () => {
    const tokens = serveApp(LEDGERLY);
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 55 * MINUTE,
      expiresAt: START + 5 * MINUTE,
    });
    vi.spyOn(store, 'rotateGrant').mockRejectedValueOnce(new ConnectionsStoreError('store_unavailable'));
    const refresher = createConnectionsRefresher(dependencies());

    await refresher.tick();

    expect(await storedTokenOf(app)).toBe('sentinel-access-at-sign-in');
    expect(lines).toContainEqual({
      level: 'warn',
      message: 'Could not renew app access; retrying',
      fields: { appId: app.id, code: 'store_unavailable' },
    });

    // The server rotated the refresh token, so it now refuses the one it replaced.
    tokens.queued.push({ status: 400, body: { error: 'invalid_grant' } });
    clock = START + MINUTE;
    await refresher.tick();

    expect(tokens.presented).toEqual(['sentinel-refresh-home']);
    expect(await store.readGrant(app.id, (await grantOf(app))?.generation ?? -1)).toMatchObject({
      refreshToken: 'sentinel-refresh-1',
    });
    expect(await storedTokenOf(app)).toBe('sentinel-access-1');
    expect((await store.apps())[0]).toMatchObject({ status: 'connected' });
  });

  it('renews a pre-release grant with no stored access token into the store', async () => {
    const tokens = serveApp(LEDGERLY);
    const app = await oauthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START,
      expiresAt: START + 60 * MINUTE,
    });
    expect(await grantOf(app)).toMatchObject({ hasAccessToken: false });

    await createConnectionsRefresher(dependencies()).tick();

    expect(tokens.presented).toEqual(['sentinel-refresh-home']);
    expect(await storedTokenOf(app)).toBe('sentinel-access-1');
    expect(await grantOf(app)).toMatchObject({ hasAccessToken: true });
    expect(gateway.held.size).toBe(0);
  });

  it('marks a pre-release grant without a refresh token or stored access token Needs reconnecting', async () => {
    serveApp(LEDGERLY);
    const app = await oauthApp('Ledgerly', LEDGERLY, { issuedAt: START, expiresAt: START + 60 * MINUTE });

    await createConnectionsRefresher(dependencies()).tick();

    expect((await store.get(app.id)).status).toBe('needs_reconnecting');
    expect(refused).toEqual([{ appId: app.id, generation: 1 }]);
    expect(endpoints.requests.filter(({ path: route }) => route === '/oauth/token')).toEqual([]);
  });
});

describe('on-demand renewal', () => {
  it('returns a valid stored token without renewing, and renews on demand when missing or expired', async () => {
    const tokens = serveApp(LEDGERLY);
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START,
      expiresAt: START + 30 * MINUTE,
    });
    const refresher = createConnectionsRefresher(dependencies());

    expect(await refresher.ensureToken(app.id)).toEqual({ generation: 1, token: 'sentinel-access-at-sign-in' });
    expect(tokens.presented).toEqual([]);

    // Once expired, ensureToken renews into the store immediately.
    clock = START + 31 * MINUTE;
    expect(await refresher.ensureToken(app.id)).toEqual({ generation: 1, token: 'sentinel-access-1' });
    expect(tokens.presented).toEqual(['sentinel-refresh-home']);
    expect(await storedTokenOf(app)).toBe('sentinel-access-1');
    expect(gateway.held.size).toBe(0);
  });

  it('returns a pasted token directly from the store without calling the gateway or any endpoint', async () => {
    const app = await tokenApp('Notes', NOTES);
    const refresher = createConnectionsRefresher(dependencies());

    expect(await refresher.ensureToken(app.id)).toEqual({ generation: 1, token: PASTED_TOKEN });
    expect(gateway.held.size).toBe(0);
    expect(endpoints.requests).toEqual([]);
  });

  it('marks an expired non-renewable grant Needs reconnecting on demand', async () => {
    serveApp(LEDGERLY);
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      issuedAt: START - 60 * MINUTE,
      expiresAt: START - MINUTE,
    });
    const refresher = createConnectionsRefresher(dependencies());

    expect(await refresher.ensureToken(app.id)).toBeUndefined();
    expect((await store.get(app.id)).status).toBe('needs_reconnecting');
    expect(refused).toEqual([{ appId: app.id, generation: 1 }]);
  });
});

describe('pasted tokens and no-auth apps', () => {
  it('keeps a pasted token working with no gateway credential and sweeps any rollback gateway copy', async () => {
    const app = await tokenApp('Notes', NOTES);
    gateway.put(appCredentialName(app.id), app.host, PASTED_TOKEN);
    const refresher = createConnectionsRefresher(dependencies());

    await refresher.tick();

    expect(gateway.held.size).toBe(0);
    expect(await store.readGrant(app.id, 1)).toEqual({ kind: 'token', generation: 1, token: PASTED_TOKEN });
    expect(endpoints.requests).toEqual([]);
  });

  it('publishes nothing for an app without sign-in', async () => {
    const created = await store.create({ name: 'Weather', url: 'https://notes.example.test/weather', auth: 'none' });
    await store.connect(created.id, created.version, { kind: 'none' });

    await createConnectionsRefresher(dependencies()).tick();

    expect(gateway.held.size).toBe(0);
    expect(Object.keys(await mainServers())).toEqual([created.serverKey]);
  });
});

describe('refusals', () => {
  it('ends a grant the server keeps refusing once, and drops it from main once', async () => {
    const tokens = serveApp(LEDGERLY);
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 55 * MINUTE,
      expiresAt: START + 5 * MINUTE,
    });
    await applyMainServers(store);
    expect(Object.keys(await mainServers())).toContain(app.serverKey);
    const marked = vi.spyOn(store, 'markRefused');
    const refresher = createConnectionsRefresher(dependencies());

    for (let attempt = 0; attempt < 3; attempt += 1) {
      tokens.queued.push({ status: 400, body: { error: 'invalid_grant', error_description: 'sentinel words' } });
      clock = START + attempt * MINUTE;
      await refresher.tick();
    }

    expect(marked).toHaveBeenCalledTimes(1);
    expect(refused).toEqual([{ appId: app.id, generation: 1 }]);
    expect(applied.filter(Boolean)).toHaveLength(1);
    expect(Object.keys(await mainServers())).not.toContain(app.serverKey);
    expect(await storedTokenOf(app)).toBeUndefined();
    expect((await store.get(app.id)).status).toBe('needs_reconnecting');
    expect(lines.filter(({ message }) => message === 'App needs reconnecting')).toEqual([
      { level: 'warn', message: 'App needs reconnecting', fields: { appId: app.id, code: 'grant_refused' } },
    ]);
  });

  it.each([true, false])(
    'ends a grant whose client the server refuses, with client documents served: %s',
    async (served) => {
      const tokens = serveApp(LEDGERLY);
      const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
        refreshToken: 'sentinel-refresh-home',
        issuedAt: START - 55 * MINUTE,
        expiresAt: START + 5 * MINUTE,
      });
      documentsServed = served;
      tokens.queued.push({ status: 401, body: { error: 'invalid_client' } });

      await createConnectionsRefresher(dependencies()).tick();

      expect((await store.get(app.id)).status).toBe('needs_reconnecting');
      expect(refused).toEqual([{ appId: app.id, generation: 1 }]);
    },
  );

  it('keeps the grant live and Connected through a 503', async () => {
    const tokens = serveApp(LEDGERLY);
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 55 * MINUTE,
      expiresAt: START + 5 * MINUTE,
    });
    tokens.queued.push({ status: 503, body: 'sentinel outage page' });

    await createConnectionsRefresher(dependencies()).tick();

    expect((await store.get(app.id)).status).toBe('connected');
    expect(await grantOf(app)).toMatchObject({ generation: 1, renewable: true });
    expect(await storedTokenOf(app)).toBe('sentinel-access-at-sign-in');
    expect(refused).toEqual([]);
    expect(lines).toContainEqual({
      level: 'warn',
      message: 'Could not renew app access; retrying',
      fields: { appId: app.id, code: 'unreachable' },
    });
  });

  it('keeps a document client’s refused renewal while documents are not served, and ends it once they are', async () => {
    const tokens = serveApp(LEDGERLY, documentServer);
    const app = await storedOAuthApp(
      'Ledgerly',
      LEDGERLY,
      { refreshToken: 'sentinel-refresh-home', issuedAt: START - 55 * MINUTE, expiresAt: START + 5 * MINUTE },
      documentClient,
    );
    const refresher = createConnectionsRefresher(dependencies());
    documentsServed = false;
    tokens.queued.push({ status: 401, body: { error: 'invalid_client' } });

    await refresher.tick();

    expect((await store.get(app.id)).status).toBe('connected');
    expect(await storedTokenOf(app)).toBe('sentinel-access-at-sign-in');
    expect(refused).toEqual([]);
    expect(lines).toContainEqual({
      level: 'warn',
      message: 'Could not renew app access; retrying',
      fields: { appId: app.id, code: 'client_refused' },
    });

    documentsServed = true;
    tokens.queued.push({ status: 401, body: { error: 'invalid_client' } });
    clock = START + MINUTE;
    await refresher.tick();

    expect((await store.get(app.id)).status).toBe('needs_reconnecting');
    expect(refused).toEqual([{ appId: app.id, generation: 1 }]);
  });

  it('keeps a document client’s refused renewal when documents come back while the request is in flight', async () => {
    const tokens = serveApp(LEDGERLY, documentServer);
    const app = await storedOAuthApp(
      'Ledgerly',
      LEDGERLY,
      { refreshToken: 'sentinel-refresh-home', issuedAt: START - 55 * MINUTE, expiresAt: START + 5 * MINUTE },
      documentClient,
    );
    const refresher = createConnectionsRefresher(dependencies());
    documentsServed = false;
    tokens.onRequest = () => {
      documentsServed = true;
    };
    tokens.queued.push({ status: 401, body: { error: 'invalid_client' } });

    await refresher.tick();

    expect((await store.get(app.id)).status).toBe('connected');
    expect(await storedTokenOf(app)).toBe('sentinel-access-at-sign-in');
    expect(refused).toEqual([]);
  });

  it('marks a grant without a refresh token Needs reconnecting once its access lapses', async () => {
    serveApp(LEDGERLY);
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      issuedAt: START - 50 * MINUTE,
      expiresAt: START + 10 * MINUTE,
    });
    const refresher = createConnectionsRefresher(dependencies());

    await refresher.tick();
    expect((await store.get(app.id)).status).toBe('connected');

    clock = START + 10 * MINUTE;
    await refresher.tick();

    expect((await store.get(app.id)).status).toBe('needs_reconnecting');
    expect(await storedTokenOf(app)).toBeUndefined();
    expect(refused).toEqual([{ appId: app.id, generation: 1 }]);
    expect(endpoints.requests.filter(({ path: route }) => route === '/oauth/token')).toEqual([]);
  });
});

describe('locks, rollback sweep and drift', () => {
  it('discards a renewal that waited behind a disconnect', async () => {
    const tokens = serveApp(LEDGERLY);
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 55 * MINUTE,
      expiresAt: START + 5 * MINUTE,
    });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disconnecting = withAppLock(app.id, async () => {
      await gate;
      await store.disconnect(app.id, app.version);
    });
    const ticking = createConnectionsRefresher(dependencies()).tick();
    // Let the tick read the live grant and queue behind the disconnect's lock.
    await sleep(50);
    release();
    await Promise.all([disconnecting, ticking]);

    expect(tokens.presented).toEqual([]);
    expect(await storedTokenOf(app)).toBeUndefined();
    expect((await store.get(app.id)).status).toBe('not_connected');
  });

  it('keeps a grant without a refresh token whose sign-in completed after the tick began', async () => {
    serveApp(LEDGERLY);
    const host = new URL(LEDGERLY).hostname;
    const issuer = `https://${host}/`;
    const created = await store.create({ name: 'Ledgerly', url: LEDGERLY, auth: 'oauth', issuer });
    const withClient = await store.setClient(created.id, created.version, {
      issuer,
      client: { clientId: `${host}-client`, clientSecret: CLIENT_SECRET },
      entered: true,
    });
    const { state } = await store.startSignIn(withClient.id, withClient.version, {
      principalId: PRINCIPAL,
      verifier: 'verifier-'.padEnd(48, 'x'),
      issuer,
      redirectUri: appRedirectUri(ASSISTANT, host),
      resource: LEDGERLY,
    });
    const claim = await store.claimSignIn(state, { host, principalId: PRINCIPAL });
    if (!claim) throw new Error('The sign-in was not claimed');
    const expiresAt = new Date(START + 60 * MINUTE).toISOString();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finishing = withAppLock(created.id, async () => {
      await gate;
      await store.completeSignIn(claim, {
        kind: 'oauth',
        accessToken: 'sentinel-access-at-sign-in',
        accessIssuedAt: new Date(START).toISOString(),
        accessExpiresAt: expiresAt,
      });
    });
    const ticking = createConnectionsRefresher(dependencies()).tick();
    await sleep(50);
    release();
    await Promise.all([finishing, ticking]);

    expect((await store.get(created.id)).status).toBe('connected');
    expect(await storedTokenOf(created)).toBe('sentinel-access-at-sign-in');
    expect(refused).toEqual([]);
  });

  it('removes every gws-ea-app-* gateway credential on a tick, including one a rollback republished, keeping operator keys', async () => {
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START,
      expiresAt: START + 60 * MINUTE,
    });
    gateway.put(appCredentialName(app.id), app.host, 'sentinel-republished-by-rollback');
    gateway.put(appCredentialName('5d0c1e2f-forgotten'), app.host, 'sentinel-old-token');
    const operator = gateway.put('ledgerly-operator-key', app.host, 'sentinel-operator-key');

    await createConnectionsRefresher(dependencies()).tick();

    expect([...gateway.held.values()].map(({ name }) => name)).toEqual([operator.name]);
    expect(await storedTokenOf(app)).toBe('sentinel-access-at-sign-in');
  });

  it('retries a failed gateway sweep on the next tick', async () => {
    const app = await tokenApp('Notes', NOTES);
    const held = gateway.put(appCredentialName(app.id), app.host, PASTED_TOKEN);
    gateway.failingRemovals.add(held.id);
    const refresher = createConnectionsRefresher(dependencies());

    await refresher.tick();
    expect(gateway.byName(appCredentialName(app.id))).toBeDefined();
    expect(lines).toContainEqual({
      level: 'warn',
      message: 'Could not remove a gateway app credential; retrying',
      fields: { appId: app.id, code: 'remove_failed' },
    });

    gateway.failingRemovals.clear();
    await refresher.tick();
    expect(gateway.held.size).toBe(0);
  });

  it('re-adds a connected app missing from main after a rollback when the host starts', async () => {
    const app = await tokenApp('Notes', NOTES);
    await applyMainServers(store);
    await updateContainerConfigJson(MAIN, 'mcp_servers', {});

    const controller = new AbortController();
    startConnectionsRefresher(store, controller.signal, dependencies());

    await vi.waitFor(async () => {
      expect(await mainServers()).toEqual({ [app.serverKey]: appRelayServerEntry(app.serverKey) });
    });
    controller.abort();
  });
});

describe('shutdown', () => {
  function gatedFetches(): { fetches: ConnectionFetches; entered: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    let enter = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    return {
      fetches: {
        ...endpoints.fetches,
        token: async (input, init) => {
          enter();
          await gate;
          return endpoints.fetches.token(input, init);
        },
      },
      entered,
      release,
    };
  }

  it('waits for a renewal in flight to store its rotation and access token', async () => {
    serveApp(LEDGERLY);
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 55 * MINUTE,
      expiresAt: START + 5 * MINUTE,
    });
    const gated = gatedFetches();
    const controller = new AbortController();
    startConnectionsRefresher(store, controller.signal, dependencies({ fetches: gated.fetches }));
    await gated.entered;

    controller.abort();
    let stopped = false;
    const stopping = stopConnectionsRefresher().then(() => {
      stopped = true;
    });
    await sleep(50);
    expect(stopped).toBe(false);
    gated.release();
    await stopping;

    const grant = await store.readGrant(app.id, 1);
    expect(grant?.kind === 'oauth' ? grant.refreshToken : undefined).toBe('sentinel-refresh-1');
    expect(await storedTokenOf(app)).toBe('sentinel-access-1');
  });

  it('starts no token request once shutdown begins', async () => {
    const tokens = serveApp(LEDGERLY);
    const app = await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 55 * MINUTE,
      expiresAt: START + 5 * MINUTE,
    });
    let release = (): void => undefined;
    let enter = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const fetches: ConnectionFetches = {
      ...endpoints.fetches,
      metadata: async (input, init) => {
        enter();
        await gate;
        return endpoints.fetches.metadata(input, init);
      },
    };
    const controller = new AbortController();
    startConnectionsRefresher(store, controller.signal, dependencies({ fetches }));
    await entered;

    const stopping = stopConnectionsRefresher();
    release();
    await stopping;

    expect(tokens.presented).toEqual([]);
    expect(await grantOf(app)).toMatchObject({
      generation: 1,
      accessExpiresAt: new Date(START + 5 * MINUTE).toISOString(),
    });
    expect(await storedTokenOf(app)).toBe('sentinel-access-at-sign-in');
    controller.abort();
  });

  it('stops waiting at its bound', async () => {
    serveApp(LEDGERLY);
    await storedOAuthApp('Ledgerly', LEDGERLY, {
      refreshToken: 'sentinel-refresh-home',
      issuedAt: START - 55 * MINUTE,
      expiresAt: START + 5 * MINUTE,
    });
    const gated = gatedFetches();
    const controller = new AbortController();
    startConnectionsRefresher(store, controller.signal, dependencies({ fetches: gated.fetches }));
    await gated.entered;

    controller.abort();
    const began = Date.now();
    await stopConnectionsRefresher(100);
    expect(Date.now() - began).toBeLessThan(2_000);

    // Let the abandoned renewal finish before the store's directory is removed.
    gated.release();
    await vi.waitFor(async () => {
      const grant = await store.readGrant((await store.apps())[0]?.id ?? '', 1);
      expect(grant?.kind === 'oauth' ? grant.refreshToken : undefined).toBe('sentinel-refresh-1');
    });
  });
});
