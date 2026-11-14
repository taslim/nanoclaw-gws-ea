import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { admitAppUrl, type AdmissionDependencies } from './admit.js';
import {
  appRedirectUri,
  clientForSignIn,
  completeAuthorization,
  ConnectionOAuthError,
  prepareAuthorization,
  readProtectedResource,
  refreshAccess,
  revokeGrant,
  signInServer,
  type ConnectionOAuthCode,
  type ConnectionOAuthOptions,
  type SignInServer,
} from './oauth.js';
import { probeApp } from './probe.js';
import type { ClientRegistration } from './store.js';
import { FakeMcpApp, startFakeEndpoints, type FakeEndpoints, type FakeHandler } from './testing/oauth-server.js';
import { testConnectionsStore } from './testing/store.js';

const ASSISTANT = 'juno.example.test';
const HOMEBOARD = 'https://homeboard.nownow.ai/mcp';
const HOMEBOARD_ISSUER = 'https://homeboard.nownow.ai/';
const LEDGER = 'https://mcp.ledger.example.test/mcp';
const NOTES = 'https://notes.example.test/mcp';
const SHARED_ISSUER = 'https://auth.example.test/';
const HOMEBOARD_REDIRECT = appRedirectUri(ASSISTANT, 'homeboard.nownow.ai');
const HOMEBOARD_CLIENT: ClientRegistration = { clientId: 'remy-homeboard-client', clientSecret: 'remy-client-secret' };
const SENTINEL = 'sentinel-token-9Zq4';

let endpoints: FakeEndpoints;
let options: ConnectionOAuthOptions;

beforeAll(async () => {
  endpoints = await startFakeEndpoints([
    'homeboard.nownow.ai',
    'mcp.ledger.example.test',
    'notes.example.test',
    'auth.example.test',
    ASSISTANT,
  ]);
});
afterAll(async () => {
  await endpoints.close();
});
beforeEach(() => {
  endpoints.reset();
  options = { fetches: endpoints.fetches, assistantHost: ASSISTANT, now: () => Date.parse('2026-11-14T12:00:00.000Z') };
});

function serve(...handlers: FakeHandler[]): void {
  for (const handler of handlers) endpoints.use(handler);
}

function homeBoard(overrides: { issParameter?: boolean } = {}): FakeMcpApp {
  return new FakeMcpApp({
    appUrl: HOMEBOARD,
    issuer: 'https://homeboard.nownow.ai',
    tokenAuthMethods: ['client_secret_basic', 'client_secret_post'],
    client: {
      id: HOMEBOARD_CLIENT.clientId,
      secret: HOMEBOARD_CLIENT.clientSecret ?? '',
      redirectUri: HOMEBOARD_REDIRECT,
    },
    ...overrides,
  });
}

async function codeOf(work: Promise<unknown>): Promise<ConnectionOAuthCode> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ConnectionOAuthError)) throw new Error('Expected a typed OAuth refusal');
  return error.code;
}

async function homeBoardSignIn(): Promise<SignInServer> {
  const resource = await readProtectedResource(HOMEBOARD, options);
  if (!resource) throw new Error('HomeBoard publishes resource metadata');
  return signInServer(resource, undefined, options);
}

/** Starts a sign-in and approves it at the fake server, returning what the redirect URI receives. */
async function approvedReturn(app: FakeMcpApp, client = HOMEBOARD_CLIENT) {
  const prepared = await prepareAuthorization(await homeBoardSignIn(), client, HOMEBOARD_REDIRECT);
  const { query } = app.approve(prepared.authorizationUrl('state-for-test'));
  return {
    query,
    pending: {
      issuer: HOMEBOARD_ISSUER,
      verifier: prepared.verifier,
      redirectUri: HOMEBOARD_REDIRECT,
      resource: HOMEBOARD,
    },
  };
}

function tokenRequests(): number {
  return endpoints.requests.filter((request) => request.path === '/oauth/token').length;
}

describe('discovery checks', () => {
  it.each([
    [
      'metadata whose issuer differs from its discovery URL',
      (app: FakeMcpApp) => (app.serverMetadata.issuer = 'https://auth.example.test'),
    ],
    [
      'an http token endpoint',
      (app: FakeMcpApp) => (app.serverMetadata.token_endpoint = 'http://homeboard.nownow.ai/oauth/token'),
    ],
    [
      "an authorization endpoint on the assistant's hostname",
      (app: FakeMcpApp) => (app.serverMetadata.authorization_endpoint = `https://${ASSISTANT}/connections/callback/x`),
    ],
    ['metadata without S256', (app: FakeMcpApp) => (app.serverMetadata.code_challenge_methods_supported = ['plain'])],
    [
      'metadata naming no challenge method',
      (app: FakeMcpApp) => delete app.serverMetadata.code_challenge_methods_supported,
    ],
  ])('refuses %s', async (_case, change) => {
    const app = homeBoard();
    change(app);
    serve(app.handle);
    const resource = await readProtectedResource(HOMEBOARD, options);
    if (!resource) throw new Error('HomeBoard publishes resource metadata');
    expect(await codeOf(signInServer(resource, undefined, options))).toBe('unsupported');
  });

  it('refuses a protected resource that names another address than the app', async () => {
    const app = homeBoard();
    app.resourceMetadata.resource = 'https://homeboard.nownow.ai/other';
    serve(app.handle);
    expect(await codeOf(readProtectedResource(HOMEBOARD, options))).toBe('resource_mismatch');
  });

  it('answers a discovery 503 as unreachable', async () => {
    serve(() => ({ status: 503, body: 'down' }));
    expect(await codeOf(readProtectedResource(HOMEBOARD, options))).toBe('unreachable');
  });
});

describe('clients', () => {
  it('registers automatically for this app alone: a web client with its redirect URI and host', async () => {
    const ledger = new FakeMcpApp({ appUrl: LEDGER, issuer: 'https://auth.example.test', registration: true });
    serve(ledger.handle);
    const probe = await probeApp(LEDGER, options);
    if (probe.status !== 'ok' || probe.method.kind !== 'oauth') throw new Error('Ledger signs in with OAuth');
    const redirectUri = appRedirectUri(ASSISTANT, 'mcp.ledger.example.test');
    const { client, registered } = await clientForSignIn(
      probe.method.signIn,
      { issuer: null, client: undefined },
      { host: 'mcp.ledger.example.test', redirectUri },
      options,
    );
    expect(registered).toBe(true);
    expect(ledger.registrations).toEqual([
      expect.objectContaining({
        application_type: 'web',
        redirect_uris: [redirectUri],
        client_name: expect.stringContaining('mcp.ledger.example.test') as string,
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    ]);
    expect(ledger.clients.get(client.clientId)?.secret).toBe(client.clientSecret);
  });

  it("never reuses another app's client, even when its metadata names that app's issuer", async () => {
    const ledger = new FakeMcpApp({ appUrl: LEDGER, issuer: 'https://auth.example.test', registration: true });
    const notes = new FakeMcpApp({ appUrl: NOTES, issuer: 'https://auth.example.test', registration: true });
    serve(ledger.handle, notes.handle);
    const ledgerClient = { clientId: 'ledger-client', clientSecret: 'ledger-secret' };
    const ledgerProbe = await probeApp(LEDGER, options);
    const notesProbe = await probeApp(NOTES, options);
    if (ledgerProbe.status !== 'ok' || ledgerProbe.method.kind !== 'oauth') throw new Error('OAuth expected');
    if (notesProbe.status !== 'ok' || notesProbe.method.kind !== 'oauth') throw new Error('OAuth expected');
    expect(notesProbe.method.issuer).toBe(ledgerProbe.method.issuer);

    const forLedger = await clientForSignIn(
      ledgerProbe.method.signIn,
      { issuer: SHARED_ISSUER, client: ledgerClient },
      { host: 'mcp.ledger.example.test', redirectUri: appRedirectUri(ASSISTANT, 'mcp.ledger.example.test') },
      options,
    );
    const forNotes = await clientForSignIn(
      notesProbe.method.signIn,
      { issuer: null, client: undefined },
      { host: 'notes.example.test', redirectUri: appRedirectUri(ASSISTANT, 'notes.example.test') },
      options,
    );
    expect(forLedger).toEqual({ client: ledgerClient, registered: false });
    expect(forNotes.registered).toBe(true);
    expect(forNotes.client.clientId).not.toBe(ledgerClient.clientId);
    // Both apps name one authorization server, which the first fake plays.
    expect(ledger.registrations).toEqual([
      expect.objectContaining({ redirect_uris: [appRedirectUri(ASSISTANT, 'notes.example.test')] }),
    ]);
  });

  it('asks for client details when the server cannot register one, and drops a client bound to another issuer', async () => {
    serve(homeBoard().handle);
    const signIn = await homeBoardSignIn();
    const app = { host: 'homeboard.nownow.ai', redirectUri: HOMEBOARD_REDIRECT };
    expect(await codeOf(clientForSignIn(signIn, { issuer: null, client: undefined }, app, options))).toBe(
      'needs_client',
    );
    expect(
      await codeOf(clientForSignIn(signIn, { issuer: SHARED_ISSUER, client: HOMEBOARD_CLIENT }, app, options)),
    ).toBe('needs_client');
    expect(await clientForSignIn(signIn, { issuer: HOMEBOARD_ISSUER, client: HOMEBOARD_CLIENT }, app, options)).toEqual(
      {
        client: HOMEBOARD_CLIENT,
        registered: false,
      },
    );
  });
});

describe('authorization', () => {
  it('builds the sign-in URL with S256, state, resource, scope and this app’s redirect URI', async () => {
    const app = homeBoard();
    app.resourceMetadata.scopes_supported = ['homeboard.read'];
    serve(app.handle);
    const prepared = await prepareAuthorization(await homeBoardSignIn(), HOMEBOARD_CLIENT, HOMEBOARD_REDIRECT);
    const url = new URL(prepared.authorizationUrl('state-1'));
    expect(url.origin + url.pathname).toBe('https://homeboard.nownow.ai/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: HOMEBOARD_CLIENT.clientId,
      code_challenge_method: 'S256',
      redirect_uri: HOMEBOARD_REDIRECT,
      resource: HOMEBOARD,
      scope: 'homeboard.read',
      state: 'state-1',
    });
    expect(prepared.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('refuses a return whose iss differs from the recorded issuer before any token request', async () => {
    const app = homeBoard({ issParameter: true });
    serve(app.handle);
    const { query, pending } = await approvedReturn(app);
    query.set('iss', SHARED_ISSUER);
    expect(await codeOf(completeAuthorization(query, pending, HOMEBOARD_CLIENT, options))).toBe('issuer_mismatch');
    expect(tokenRequests()).toBe(0);
  });

  it('refuses a return without iss from a server that promised it', async () => {
    const app = homeBoard({ issParameter: true });
    serve(app.handle);
    const { query, pending } = await approvedReturn(app);
    query.delete('iss');
    expect(await codeOf(completeAuthorization(query, pending, HOMEBOARD_CLIENT, options))).toBe('issuer_mismatch');
    expect(tokenRequests()).toBe(0);
  });

  it('reads a declined sign-in from its error code alone, without any request', async () => {
    const query = new URLSearchParams({ error: 'access_denied', error_description: SENTINEL, state: 'state-1' });
    const pending = {
      issuer: HOMEBOARD_ISSUER,
      verifier: 'v'.repeat(43),
      redirectUri: HOMEBOARD_REDIRECT,
      resource: HOMEBOARD,
    };
    expect(await codeOf(completeAuthorization(query, pending, HOMEBOARD_CLIENT, options))).toBe('cancelled');
    query.set('error', 'server_error');
    expect(await codeOf(completeAuthorization(query, pending, HOMEBOARD_CLIENT, options))).toBe('failed');
    expect(endpoints.requests).toEqual([]);
  });
});

describe('refresh', () => {
  async function connected(app: FakeMcpApp): Promise<string> {
    const { query, pending } = await approvedReturn(app);
    const tokens = await completeAuthorization(query, pending, HOMEBOARD_CLIENT, options);
    if (!tokens.refreshToken) throw new Error('HomeBoard issues refresh tokens');
    return tokens.refreshToken;
  }
  const grant = (refreshToken: string) => ({ refreshToken, client: HOMEBOARD_CLIENT });
  const homeBoardApp = { url: HOMEBOARD, issuer: HOMEBOARD_ISSUER };

  it('returns the new access token and the rotated refresh token, sending resource', async () => {
    const app = homeBoard();
    serve(app.handle);
    const first = await connected(app);
    const renewed = await refreshAccess(homeBoardApp, grant(first), options);
    expect(renewed.refreshToken).toMatch(/^refresh-/u);
    expect(renewed.refreshToken).not.toBe(first);
    expect(app.accessTokens.has(renewed.accessToken)).toBe(true);
    expect(renewed).toMatchObject({
      accessIssuedAt: '2026-11-14T12:00:00.000Z',
      accessExpiresAt: '2026-11-14T13:00:00.000Z',
    });
    const sent = new URLSearchParams(
      endpoints.requests.filter((request) => request.path === '/oauth/token').at(-1)?.body,
    );
    expect(sent.get('resource')).toBe(HOMEBOARD);
  });

  it('omits a refresh token the server kept, and assumes an hour when expires_in is absent', async () => {
    serve(
      (request) =>
        request.path === '/oauth/token'
          ? { status: 200, body: { access_token: 'access-kept', token_type: 'bearer' } }
          : undefined,
      homeBoard().handle,
    );
    const renewed = await refreshAccess(homeBoardApp, grant('refresh-kept'), options);
    expect(renewed).toEqual({
      accessToken: 'access-kept',
      accessIssuedAt: '2026-11-14T12:00:00.000Z',
      accessExpiresAt: '2026-11-14T13:00:00.000Z',
    });
  });

  it.each([
    [{ status: 400, body: { error: 'invalid_grant' } }, 'grant_refused'],
    [{ status: 503, body: 'Service Unavailable' }, 'unreachable'],
    [{ status: 429, body: { error: 'slow_down' } }, 'unreachable'],
    [{ status: 401, body: { error: 'invalid_client' } }, 'client_refused'],
  ] as const)('answers %j as %s', async (reply, code) => {
    serve((request) => (request.path === '/oauth/token' ? reply : undefined), homeBoard().handle);
    expect(await codeOf(refreshAccess(homeBoardApp, grant('refresh-old'), options))).toBe(code);
  });

  it('refuses renewal once the resource names another authorization server', async () => {
    const app = homeBoard();
    app.resourceMetadata.authorization_servers = ['https://auth.example.test'];
    serve(app.handle);
    expect(await codeOf(refreshAccess(homeBoardApp, grant('refresh-old'), options))).toBe('issuer_changed');
    expect(tokenRequests()).toBe(0);
  });
});

describe('revocation', () => {
  const released = { kind: 'oauth', generation: 1, refreshToken: 'refresh-ended', client: HOMEBOARD_CLIENT } as const;

  it('does not fail the caller when the endpoint answers 500', async () => {
    serve(
      (request) => (request.path === '/oauth/revoke' ? { status: 500, body: 'boom' } : undefined),
      homeBoard().handle,
    );
    expect(await revokeGrant(HOMEBOARD_ISSUER, released, options)).toBe('failed');
  });

  it('answers unreachable discovery and grants with nothing to revoke without throwing', async () => {
    serve(() => ({ status: 503 }));
    expect(await revokeGrant(HOMEBOARD_ISSUER, released, options)).toBe('failed');
    expect(await revokeGrant(HOMEBOARD_ISSUER, { kind: 'token', generation: 1, token: SENTINEL }, options)).toBe(
      'nothing',
    );
    expect(await revokeGrant(null, released, options)).toBe('nothing');
  });
});

describe('what crosses the boundary', () => {
  it("keeps a server's error_description out of every log line and returned value", async () => {
    const written: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) =>
        written.push(values.map(String).join(' ')),
      );
    const ledger = new FakeMcpApp({ appUrl: LEDGER, issuer: 'https://auth.example.test', registration: true });
    serve(
      (request) =>
        request.path === '/oauth/token' && request.body.includes('refresh-json')
          ? { status: 400, body: { error: 'invalid_request', error_description: `refused ${SENTINEL}` } }
          : undefined,
      (request) =>
        request.path === '/oauth/token' || request.path === '/oauth/register'
          ? { status: 400, body: `<html>Bad request for ${SENTINEL}</html>` }
          : undefined,
      (request) =>
        request.path === '/oauth/revoke'
          ? { status: 400, body: { error: 'x', error_description: SENTINEL } }
          : undefined,
      homeBoard().handle,
      ledger.handle,
    );

    const outcomes: unknown[] = [];
    const settle = async (work: Promise<unknown>): Promise<void> => {
      outcomes.push(
        await work.then(
          (value) => value,
          (error: unknown) => error,
        ),
      );
    };
    const homeBoardApp = { url: HOMEBOARD, issuer: HOMEBOARD_ISSUER };
    await settle(refreshAccess(homeBoardApp, { refreshToken: 'refresh-json', client: HOMEBOARD_CLIENT }, options));
    await settle(refreshAccess(homeBoardApp, { refreshToken: 'refresh-html', client: HOMEBOARD_CLIENT }, options));
    const pending = {
      issuer: HOMEBOARD_ISSUER,
      verifier: 'v'.repeat(43),
      redirectUri: HOMEBOARD_REDIRECT,
      resource: HOMEBOARD,
    };
    await settle(completeAuthorization(new URLSearchParams({ code: 'code-1' }), pending, HOMEBOARD_CLIENT, options));
    await settle(
      completeAuthorization(
        new URLSearchParams({ error: 'invalid_scope', error_description: SENTINEL }),
        pending,
        HOMEBOARD_CLIENT,
        options,
      ),
    );
    const probe = await probeApp(LEDGER, options);
    if (probe.status !== 'ok' || probe.method.kind !== 'oauth') throw new Error('Ledger signs in with OAuth');
    await settle(
      clientForSignIn(
        probe.method.signIn,
        { issuer: null, client: undefined },
        { host: 'mcp.ledger.example.test', redirectUri: LEDGER },
        options,
      ),
    );
    await settle(
      revokeGrant(
        HOMEBOARD_ISSUER,
        { kind: 'oauth', generation: 1, refreshToken: 'refresh-x', client: HOMEBOARD_CLIENT },
        options,
      ),
    );

    expect(outcomes.map((outcome) => (outcome instanceof ConnectionOAuthError ? outcome.code : outcome))).toEqual([
      'failed',
      'failed',
      'failed',
      'failed',
      'client_refused',
      'failed',
    ]);
    for (const outcome of outcomes) {
      const seen =
        outcome instanceof Error
          ? [outcome.message, outcome.stack, String(outcome.cause), JSON.stringify(outcome)]
          : [JSON.stringify(outcome)];
      expect(seen.join('\n')).not.toContain(SENTINEL);
    }
    expect(written.join('\n')).not.toContain(SENTINEL);
  });
});

describe('a HomeBoard-shaped server end to end', () => {
  let directory: string;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('admits, probes, takes client details, signs in, exchanges, refreshes and revokes', async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'connections-oauth-'));
    const { store } = testConnectionsStore(path.join(directory, 'connections'));
    const fake = homeBoard({ issParameter: true });
    serve(fake.handle);
    const admission: AdmissionDependencies = {
      appByHost: (host) => store.byHost(host),
      operatorServers: async () => [],
      gatewayCredentials: async () => [],
      protectedHosts: async () => new Set([ASSISTANT]),
    };

    const admitted = await admitAppUrl(HOMEBOARD, admission);
    if (!admitted.admitted) throw new Error('HomeBoard is admitted');
    const probe = await probeApp(admitted.url, options);
    if (probe.status !== 'ok' || probe.method.kind !== 'oauth') throw new Error('HomeBoard signs in with OAuth');
    expect(probe.method.dynamicRegistration).toBe(false);
    const created = await store.create({
      name: 'HomeBoard',
      url: admitted.url,
      auth: 'oauth',
      issuer: probe.method.issuer,
    });
    const app = await store.setClient(created.id, created.version, {
      issuer: probe.method.issuer,
      client: HOMEBOARD_CLIENT,
    });

    const again = await probeApp(app.url, options);
    if (again.status !== 'ok' || again.method.kind !== 'oauth') throw new Error('The probe re-runs at connect');
    const signIn = again.method.signIn;
    const { client } = await clientForSignIn(
      signIn,
      { issuer: app.issuer, client: HOMEBOARD_CLIENT },
      { host: app.host, redirectUri: HOMEBOARD_REDIRECT },
      options,
    );
    const prepared = await prepareAuthorization(signIn, client, HOMEBOARD_REDIRECT);
    const { state } = await store.startSignIn(app.id, app.version, {
      principalId: 'gchat:morgan',
      verifier: prepared.verifier,
      issuer: signIn.server.issuer,
      redirectUri: HOMEBOARD_REDIRECT,
      resource: signIn.resource,
    });
    const { redirectUri, query } = fake.approve(prepared.authorizationUrl(state));
    expect(redirectUri).toBe(HOMEBOARD_REDIRECT);

    const claim = await store.claimSignIn(query.get('state') ?? '', { host: app.host, principalId: 'gchat:morgan' });
    if (!claim) throw new Error('The return claims its sign-in');
    const tokens = await completeAuthorization(query, claim, client, options);
    const completion = await store.completeSignIn(claim, {
      kind: 'oauth',
      refreshToken: tokens.refreshToken,
      accessIssuedAt: tokens.accessIssuedAt,
      accessExpiresAt: tokens.accessExpiresAt,
    });
    if (completion.status !== 'connected') throw new Error('The sign-in completes');
    expect(completion.app.status).toBe('connected');
    expect(fake.accessTokens.has(tokens.accessToken)).toBe(true);

    const held = await store.readGrant(app.id, completion.generation);
    if (held?.kind !== 'oauth' || !held.refreshToken) throw new Error('The grant holds a refresh token');
    const renewed = await refreshAccess(
      { url: app.url, issuer: probe.method.issuer },
      { refreshToken: held.refreshToken, client: held.client },
      options,
    );
    expect(await store.rotateGrant(app.id, completion.generation, renewed)).toBe(true);
    expect(fake.accessTokens.has(renewed.accessToken)).toBe(true);

    const { released } = await store.disconnect(app.id, completion.app.version);
    expect(await revokeGrant(probe.method.issuer, released, options)).toBe('revoked');
    expect(fake.revoked).toEqual([renewed.refreshToken]);
  });
});
