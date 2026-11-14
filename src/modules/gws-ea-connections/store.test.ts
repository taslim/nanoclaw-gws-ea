import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsStoreError, SIGN_IN_TTL_MS, type ConnectionApp, type ConnectionsStore } from './store.js';
import { testConnectionsStore, type TestKeychain } from './testing/store.js';

const HOMEBOARD = { name: 'HomeBoard', url: 'https://homeboard.nownow.ai/mcp', auth: 'token' } as const;
const ISSUER = 'https://auth.ledger.example/';
const LEDGER = { name: 'Ledger', url: 'https://mcp.ledger.example/mcp', auth: 'oauth', issuer: ISSUER } as const;
const PRINCIPAL = 'gchat:users/morgan-ellery';
const SENTINELS = {
  token: 'sentinel-pasted-token-7Qx9',
  refresh: 'sentinel-refresh-token-K2m4',
  rotated: 'sentinel-rotated-token-Z8p1',
  clientSecret: 'sentinel-client-secret-W5r3',
  verifier: 'sentinel-pkce-verifier-H6n2-abcdefghijklmnopqrstuvwxyz0123',
};

let directory: string;
let root: string;
let store: ConnectionsStore;
let keychain: TestKeychain;
let raw: ReturnType<typeof testConnectionsStore>['raw'];

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'connections-store-'));
  root = path.join(directory, 'connections');
  ({ store, keychain, raw } = testConnectionsStore(root));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

const oauthGrant = (refreshToken?: string) => ({
  kind: 'oauth' as const,
  ...(refreshToken === undefined ? {} : { refreshToken }),
  accessIssuedAt: '2026-11-14T10:00:00.000Z',
  accessExpiresAt: '2026-11-14T11:00:00.000Z',
});
const signIn = (app: ConnectionApp) => ({
  principalId: PRINCIPAL,
  verifier: SENTINELS.verifier,
  issuer: ISSUER,
  redirectUri: `https://robin.assistants.example/connections/callback/${app.host}`,
  resource: app.url,
});
async function connectedOauth(): Promise<{ app: ConnectionApp; state: string }> {
  const added = await store.create(LEDGER);
  const withClient = await store.setClient(added.id, added.version, {
    issuer: ISSUER,
    client: { clientId: 'ledger-client', clientSecret: SENTINELS.clientSecret },
  });
  const { state } = await store.startSignIn(withClient.id, withClient.version, signIn(withClient));
  const claim = await store.claimSignIn(state, { host: withClient.host, principalId: PRINCIPAL });
  if (!claim) throw new Error('Fixture sign-in was not claimed');
  const done = await store.completeSignIn(claim, oauthGrant(SENTINELS.refresh));
  if (done.status !== 'connected') throw new Error('Fixture sign-in did not complete');
  return { app: done.app, state };
}

describe('apps', () => {
  it('adds an app Not connected with a fixed server key that a rename keeps', async () => {
    const app = await store.create(HOMEBOARD);
    expect(app).toMatchObject({
      name: 'HomeBoard',
      url: 'https://homeboard.nownow.ai/mcp',
      host: 'homeboard.nownow.ai',
      auth: 'token',
      issuer: null,
      hasClient: false,
      status: 'not_connected',
      version: 1,
    });
    expect(app.serverKey).toMatch(/^app_[0-9a-f]{12}$/u);
    const renamed = await store.rename(app.id, app.version, 'Home board');
    expect(renamed).toMatchObject({ name: 'Home board', serverKey: app.serverKey, version: 2 });
    expect(await store.apps()).toEqual([renamed]);
  });

  it('refuses a name that differs only by case, and a host another app uses', async () => {
    const existing = await store.create({ ...HOMEBOARD, name: 'homeboard' });
    await expect(store.create({ ...HOMEBOARD, url: 'https://boards.example.test/mcp' })).rejects.toMatchObject({
      reason: 'duplicate_name',
    });
    await expect(
      store.create({ ...HOMEBOARD, name: 'Boards', url: 'https://HomeBoard.NowNow.ai/other' }),
    ).rejects.toMatchObject({ reason: 'duplicate_host' });
    const other = await store.create(LEDGER);
    await expect(store.rename(other.id, other.version, 'HOMEBOARD')).rejects.toMatchObject({
      reason: 'duplicate_name',
    });
    expect(await store.rename(existing.id, existing.version, 'HomeBoard')).toMatchObject({ name: 'HomeBoard' });
    expect((await store.apps()).map(({ name }) => name)).toEqual(['HomeBoard', 'Ledger']);
  });

  it.each([
    'http://homeboard.nownow.ai/mcp',
    'https://juno:pass@homeboard.nownow.ai/mcp',
    'https://juno@homeboard.nownow.ai/mcp',
    'not a url',
  ])('refuses %s and stores nothing', async (url) => {
    await expect(store.create({ ...HOMEBOARD, url })).rejects.toMatchObject({ reason: 'invalid_details' });
    expect(await store.apps()).toEqual([]);
  });

  it('refuses every mutation that carries an old version, before reading Keychain', async () => {
    const app = await store.create(LEDGER);
    const current = await store.rename(app.id, app.version, 'Ledger books');
    const reads = keychain.calls.length;
    const stale = app.version;
    const mutations = [
      () => store.rename(app.id, stale, 'Ledger two'),
      () => store.setClient(app.id, stale, { issuer: ISSUER, client: { clientId: 'x' } }),
      () => store.clearClient(app.id, stale),
      () => store.connect(app.id, stale, { kind: 'token', token: SENTINELS.token }),
      () => store.startSignIn(app.id, stale, signIn(app)),
      () => store.disconnect(app.id, stale),
      () => store.remove(app.id, stale),
    ];
    for (const mutate of mutations) {
      const error = await mutate().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ConnectionsStoreError);
      expect(error).toMatchObject({ reason: 'app_changed' });
    }
    expect(keychain.calls).toHaveLength(reads);
    expect(await store.get(app.id)).toEqual(current);
    await expect(store.get('missing')).rejects.toMatchObject({ reason: 'app_not_found' });
  });

  it('keeps the file owner-only and serves the same apps, grants and restart request after a host restart', async () => {
    const app = await store.create(HOMEBOARD);
    const connected = await store.connect(app.id, app.version, { kind: 'token', token: SENTINELS.token });
    await store.requestRestart('2026-11-14T10:00:00.000Z');
    expect((await stat(path.join(root, 'apps.db'))).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);

    const restarted = testConnectionsStore(root);
    restarted.keychain.key = keychain.key;
    expect(await restarted.store.apps()).toEqual([connected.app]);
    expect(await restarted.store.pendingRestart()).toBe('2026-11-14T10:00:00.000Z');
    expect(await restarted.store.readGrant(app.id, 1)).toEqual({
      kind: 'token',
      generation: 1,
      token: SENTINELS.token,
    });
  });
});

describe('grants', () => {
  it('moves through Connected, Needs reconnecting and Not connected with increasing generations', async () => {
    const app = await store.create(HOMEBOARD);
    const first = await store.connect(app.id, app.version, { kind: 'token', token: SENTINELS.token });
    expect(first).toMatchObject({ generation: 1, replaced: undefined, app: { status: 'connected', version: 2 } });
    expect(await store.liveGrants()).toEqual([
      {
        appId: app.id,
        serverKey: app.serverKey,
        host: app.host,
        url: app.url,
        generation: 1,
        kind: 'token',
      },
    ]);

    expect(await store.markRefused(app.id, 1)).toBe(true);
    expect(await store.markRefused(app.id, 1)).toBe(false);
    const refused = await store.get(app.id);
    expect(refused).toMatchObject({ status: 'needs_reconnecting', version: 3 });
    expect(await store.liveGrants()).toEqual([]);
    expect(await store.readGrant(app.id, 1)).toBeUndefined();

    const second = await store.connect(app.id, refused.version, { kind: 'token', token: 'second-token' });
    expect(second).toMatchObject({ generation: 2, replaced: undefined, app: { status: 'connected' } });
    expect(await store.markRefused(app.id, 1)).toBe(false);

    const ended = await store.disconnect(app.id, second.app.version);
    expect(ended).toMatchObject({
      app: { status: 'not_connected' },
      released: { kind: 'token', generation: 2, token: 'second-token' },
    });
    expect(raw((db) => db.prepare('SELECT state, secret FROM grants').all())).toEqual([
      { state: 'disconnected', secret: null },
    ]);
  });

  it('hands back the grant a reconnect replaced, for revocation once the new one is in place', async () => {
    const { app } = await connectedOauth();
    const { state } = await store.startSignIn(app.id, app.version, signIn(app));
    const claim = await store.claimSignIn(state, { host: app.host, principalId: PRINCIPAL });
    if (!claim) throw new Error('Expected a claim');
    expect(await store.completeSignIn(claim, oauthGrant('next-refresh'))).toMatchObject({
      status: 'connected',
      generation: 2,
      replaced: {
        kind: 'oauth',
        generation: 1,
        refreshToken: SENTINELS.refresh,
        client: { clientId: 'ledger-client', clientSecret: SENTINELS.clientSecret },
      },
    });
    expect(await store.readGrant(app.id, 1)).toBeUndefined();
    expect(await store.readGrant(app.id, 2)).toMatchObject({ refreshToken: 'next-refresh' });
  });

  it('persists a rotation only while the grant is live at the same generation', async () => {
    const { app } = await connectedOauth();
    const rotation = {
      refreshToken: SENTINELS.rotated,
      accessIssuedAt: '2026-11-14T11:00:00.000Z',
      accessExpiresAt: '2026-11-14T12:00:00.000Z',
    };
    expect(await store.rotateGrant(app.id, 1, rotation)).toBe(true);
    expect(await store.readGrant(app.id, 1)).toMatchObject({ refreshToken: SENTINELS.rotated });
    expect(await store.liveGrants()).toEqual([
      expect.objectContaining({
        kind: 'oauth',
        renewable: true,
        accessIssuedAt: rotation.accessIssuedAt,
        accessExpiresAt: rotation.accessExpiresAt,
      }),
    ]);
    const kept = { accessIssuedAt: '2026-11-14T12:00:00.000Z', accessExpiresAt: '2026-11-14T13:00:00.000Z' };
    expect(await store.rotateGrant(app.id, 1, kept)).toBe(true);
    expect(await store.readGrant(app.id, 1)).toMatchObject({ refreshToken: SENTINELS.rotated });
    expect(await store.rotateGrant(app.id, 2, kept)).toBe(false);
    await store.disconnect(app.id, (await store.get(app.id)).version);
    expect(await store.rotateGrant(app.id, 1, kept)).toBe(false);
  });

  it('connects a server without sign-in with no Keychain key', async () => {
    const app = await store.create({ ...HOMEBOARD, auth: 'none' });
    expect(await store.connect(app.id, app.version, { kind: 'none' })).toMatchObject({
      generation: 1,
      app: { status: 'connected' },
    });
    expect(await store.readGrant(app.id, 1)).toEqual({ kind: 'none', generation: 1 });
    expect(keychain.calls).toEqual([]);
  });

  it("reads an unconnected app's client for sign-in, version-checked when a version is given", async () => {
    const added = await store.create(LEDGER);
    expect(await store.readClient(added.id, added.version)).toEqual({ issuer: ISSUER, client: undefined });
    expect(keychain.calls).toEqual([]);
    const client = { clientId: 'ledger-client', clientSecret: SENTINELS.clientSecret };
    const withClient = await store.setClient(added.id, added.version, { issuer: ISSUER, client });
    expect(await store.readClient(withClient.id, withClient.version)).toEqual({ issuer: ISSUER, client });
    expect(await store.readClient(withClient.id)).toEqual({ issuer: ISSUER, client });
    await expect(store.readClient(withClient.id, added.version)).rejects.toMatchObject({ reason: 'app_changed' });
    await expect(store.readClient('no-such-app')).rejects.toMatchObject({ reason: 'app_not_found' });
  });

  it('forgets the app, its client, grant and sign-in on delete', async () => {
    const { app } = await connectedOauth();
    await store.startSignIn(app.id, app.version, signIn(app));
    expect(await store.remove(app.id, app.version)).toMatchObject({
      released: { kind: 'oauth', refreshToken: SENTINELS.refresh, client: { clientId: 'ledger-client' } },
    });
    expect(await store.apps()).toEqual([]);
    expect(
      raw((db) =>
        ['apps', 'grants', 'sign_ins'].map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()),
      ),
    ).toEqual([{ n: 0 }, { n: 0 }, { n: 0 }]);
  });

  it('keeps client secrets, tokens and verifiers unreadable in the raw file', async () => {
    const { app } = await connectedOauth();
    await store.startSignIn(app.id, app.version, signIn(app));
    const token = await store.create(HOMEBOARD);
    await store.connect(token.id, token.version, { kind: 'token', token: SENTINELS.token });
    const file = await readFile(path.join(root, 'apps.db'));
    for (const sentinel of [
      SENTINELS.token,
      SENTINELS.refresh,
      SENTINELS.clientSecret,
      SENTINELS.verifier,
      'ledger-client',
    ])
      expect(file.includes(sentinel)).toBe(false);
    expect(await store.get(app.id)).toMatchObject({ hasClient: true, issuer: ISSUER });
  });
});

describe('sign-ins', () => {
  it('stores only a hash of the state and lets it be claimed once', async () => {
    const app = await store.create(LEDGER);
    const { state, expiresAt } = await store.startSignIn(app.id, app.version, signIn(app));
    expect(Buffer.from(state, 'base64url')).toHaveLength(32);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(SIGN_IN_TTL_MS - 5_000);
    const stored = raw((db) => db.prepare<[], { state_hash: string }>('SELECT state_hash FROM sign_ins').get());
    expect(stored?.state_hash).toBe(createHash('sha256').update(state).digest('hex'));
    expect((await readFile(path.join(root, 'apps.db'))).includes(state)).toBe(false);

    const match = { host: app.host, principalId: PRINCIPAL };
    expect(await store.claimSignIn(state, match)).toEqual({
      ...signIn(app),
      appId: app.id,
      stateHash: stored?.state_hash,
    });
    expect(await store.claimSignIn(state, match)).toBeUndefined();
  });

  it("answers another principal's or another app's claim with nothing and leaves the row usable", async () => {
    const app = await store.create(LEDGER);
    await store.create(HOMEBOARD);
    const { state } = await store.startSignIn(app.id, app.version, signIn(app));
    expect(await store.claimSignIn(state, { host: app.host, principalId: 'gchat:users/juno-hale' })).toBeUndefined();
    expect(await store.claimSignIn(state, { host: 'homeboard.nownow.ai', principalId: PRINCIPAL })).toBeUndefined();
    expect(await store.claimSignIn('unknown-state', { host: app.host, principalId: PRINCIPAL })).toBeUndefined();
    expect(await store.claimSignIn(state, { host: app.host, principalId: PRINCIPAL })).toMatchObject({ appId: app.id });
  });

  it('replaces an earlier start, so its state reads as expired', async () => {
    const app = await store.create(LEDGER);
    const first = await store.startSignIn(app.id, app.version, signIn(app));
    const second = await store.startSignIn(app.id, app.version, signIn(app));
    const match = { host: app.host, principalId: PRINCIPAL };
    expect(await store.claimSignIn(first.state, match)).toBeUndefined();
    expect(await store.claimSignIn(second.state, match)).toMatchObject({ appId: app.id });
  });

  it('refuses an expired state and sweeps rows older than ten minutes at start', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-14T10:00:00.000Z'));
    const ledger = await store.create(LEDGER);
    const home = await store.create({ ...HOMEBOARD, auth: 'oauth', issuer: ISSUER });
    const old = await store.startSignIn(ledger.id, ledger.version, signIn(ledger));
    vi.setSystemTime(new Date('2026-11-14T10:05:00.000Z'));
    const recent = await store.startSignIn(home.id, home.version, signIn(home));
    vi.setSystemTime(new Date('2026-11-14T10:10:00.000Z'));
    expect(await store.claimSignIn(old.state, { host: ledger.host, principalId: PRINCIPAL })).toBeUndefined();
    expect(await store.sweepExpiredSignIns()).toBe(0);
    vi.setSystemTime(new Date('2026-11-14T10:15:00.000Z'));
    expect(await store.sweepExpiredSignIns()).toBe(1);
    expect(raw((db) => db.prepare('SELECT COUNT(*) AS n FROM sign_ins').get())).toEqual({ n: 0 });
    expect(await store.claimSignIn(recent.state, { host: home.host, principalId: PRINCIPAL })).toBeUndefined();
  });

  it('completes into a grant and drops the claimed row together; a cleared row means expired', async () => {
    const app = await store.create(LEDGER);
    const { state } = await store.startSignIn(app.id, app.version, signIn(app));
    const claim = await store.claimSignIn(state, { host: app.host, principalId: PRINCIPAL });
    if (!claim) throw new Error('Expected a claim');
    await store.disconnect(app.id, app.version);
    expect(await store.completeSignIn(claim, oauthGrant(SENTINELS.refresh))).toEqual({ status: 'expired' });
    expect(await store.get(app.id)).toMatchObject({ status: 'not_connected' });

    const current = await store.get(app.id);
    const again = await store.startSignIn(current.id, current.version, signIn(current));
    const next = await store.claimSignIn(again.state, { host: app.host, principalId: PRINCIPAL });
    if (!next) throw new Error('Expected a claim');
    expect(await store.completeSignIn(next, oauthGrant())).toMatchObject({
      status: 'connected',
      generation: 1,
      app: { status: 'connected', auth: 'oauth', issuer: ISSUER },
    });
    expect(await store.liveGrants()).toEqual([expect.objectContaining({ kind: 'oauth', renewable: false })]);
    expect(raw((db) => db.prepare('SELECT COUNT(*) AS n FROM sign_ins').get())).toEqual({ n: 0 });
  });

  it('discards a cancelled sign-in and leaves the app as it was', async () => {
    const { app } = await connectedOauth();
    const { state } = await store.startSignIn(app.id, app.version, signIn(app));
    const claim = await store.claimSignIn(state, { host: app.host, principalId: PRINCIPAL });
    if (!claim) throw new Error('Expected a claim');
    await store.discardSignIn(claim);
    expect(await store.get(app.id)).toEqual(app);
    expect(await store.readGrant(app.id, 1)).toMatchObject({ refreshToken: SENTINELS.refresh });
  });
});

describe('restart request', () => {
  it('keeps the latest apply time and clears only the request it served', async () => {
    expect(await store.pendingRestart()).toBeUndefined();
    await store.requestRestart('2026-11-14T10:00:05.000Z');
    await store.requestRestart('2026-11-14T10:00:01.000Z');
    expect(await store.pendingRestart()).toBe('2026-11-14T10:00:05.000Z');
    expect(await store.clearRestart('2026-11-14T10:00:01.000Z')).toBe(false);
    expect(await store.pendingRestart()).toBe('2026-11-14T10:00:05.000Z');
    expect(await store.clearRestart('2026-11-14T10:00:05.000Z')).toBe(true);
    expect(await store.pendingRestart()).toBeUndefined();
    await expect(store.requestRestart('2026-11-14 10:00')).rejects.toMatchObject({ reason: 'invalid_details' });
  });
});

describe('availability', () => {
  it('reports a missing key while secrets exist, and never creates a replacement', async () => {
    const app = await store.create(HOMEBOARD);
    await store.connect(app.id, app.version, { kind: 'token', token: SENTINELS.token });
    keychain.key = undefined;
    keychain.calls.length = 0;
    expect(await store.availability()).toEqual({ available: false, reason: 'key_missing' });
    await expect(store.readGrant(app.id, 1)).rejects.toMatchObject({ reason: 'store_unavailable' });
    const other = await store.create(LEDGER);
    await expect(
      store.setClient(other.id, other.version, { issuer: ISSUER, client: { clientId: 'ledger-client' } }),
    ).rejects.toMatchObject({ reason: 'store_unavailable' });
    expect(keychain.calls.some((call) => call.args[0] === '-i')).toBe(false);
    expect(keychain.key).toBeUndefined();

    // Metadata and ending a grant stay available; the unreadable grant is forgotten unread.
    expect(await store.apps()).toHaveLength(2);
    const current = await store.get(app.id);
    expect(await store.disconnect(app.id, current.version)).toMatchObject({
      released: undefined,
      app: { status: 'not_connected' },
    });
  });

  it('reports a different key as a mismatch and an unreachable Keychain as unavailable', async () => {
    const app = await store.create(HOMEBOARD);
    await store.connect(app.id, app.version, { kind: 'token', token: SENTINELS.token });
    keychain.key = 'ab'.repeat(32);
    expect(await store.availability()).toEqual({ available: false, reason: 'key_mismatch' });
    await expect(store.readGrant(app.id, 1)).rejects.toMatchObject({ reason: 'store_unavailable' });
    keychain.unavailable = true;
    expect(await store.availability()).toEqual({ available: false, reason: 'keychain_unavailable' });
  });

  it('uses the connections Keychain service under this assistant', async () => {
    const app = await store.create(HOMEBOARD);
    await store.connect(app.id, app.version, { kind: 'token', token: SENTINELS.token });
    expect(keychain.calls[0]?.args.slice(0, 5)).toEqual([
      'find-generic-password',
      '-s',
      'gws-ea.connections',
      '-a',
      'c4f1d2a8-5b3e-4e7a-9a61-0d2f8b7c6e15',
    ]);
    expect(await store.availability()).toEqual({ available: true });
  });
});
