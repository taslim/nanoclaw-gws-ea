import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The host-start hook this module registers, and the order its starts ran in. */
const host = vi.hoisted(() => ({
  start: undefined as ((context: { readonly signal: AbortSignal }) => Promise<void>) | undefined,
  started: [] as string[],
}));
vi.mock('../../host-lifecycle.js', async (original) => ({
  ...(await original<typeof import('../../host-lifecycle.js')>()),
  onHostStart: (callback: (context: { readonly signal: AbortSignal }) => Promise<void>) => {
    host.start = callback;
  },
}));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../gws-ea-profile/main-note.js', async (original) => ({
  ...(await original<typeof import('../gws-ea-profile/main-note.js')>()),
  writeNoteForMain: vi.fn(async () => 'written'),
}));
vi.mock('./store.js', async (original) => ({
  ...(await original<typeof import('./store.js')>()),
  getConnectionsStore: vi.fn(),
}));
vi.mock('./idle-restart.js', async (original) => ({
  ...(await original<typeof import('./idle-restart.js')>()),
  startRestartChecks: vi.fn(() => host.started.push('restart checks')),
}));
vi.mock('./note.js', async (original) => ({
  ...(await original<typeof import('./note.js')>()),
  startReconnectNotes: vi.fn(async () => {
    host.started.push('reconnect notes');
  }),
}));
vi.mock('./refresher.js', async (original) => ({
  ...(await original<typeof import('./refresher.js')>()),
  startConnectionsRefresher: vi.fn(() => host.started.push('refresher')),
}));
vi.mock('./relay.js', async (original) => ({
  ...(await original<typeof import('./relay.js')>()),
  startAppRelay: vi.fn(() => {
    host.started.push('relay');
    return { pinUnpinnedApps: vi.fn(async () => undefined) };
  }),
}));
vi.mock('./sorter.js', async (original) => ({
  ...(await original<typeof import('./sorter.js')>()),
  startAppToolSorter: vi.fn(() => {
    host.started.push('sorter');
    return { enqueue: vi.fn(async () => undefined), enqueuePending: vi.fn(async () => undefined) };
  }),
}));
vi.mock('./apply.js', async (original) => ({
  ...(await original<typeof import('./apply.js')>()),
  applyMainServers: vi.fn(async () => {
    host.started.push('apply');
    return true;
  }),
}));

import { lookup } from '../../cli/registry.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { log } from '../../log.js';
import '../gws-ea-profile/index.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { applyMainServers, MainServersUnreadableError } from './apply.js';
import { CATALOG_RETIRE_COMMAND } from './catalog-retire.js';
import { CATALOG_POLICY_FILE_ENV, CONNECTIONS_ROOT_ENV } from './config.js';
import { connectionsHealth } from './index.js';
import { ConnectionsStoreError, getConnectionsStore, type ConnectionApp, type ConnectionsStore } from './store.js';
import { testConnectionsStore, type TestKeychain } from './testing/store.js';

const MAIN = 'ag-main';
const SENTINEL_TOKEN = 'sentinel-pasted-token-P3w7';
const OPERATOR_KEY = 'sentinel-operator-key-L9d2';

let directory: string;
let store: ConnectionsStore;
let keychain: TestKeychain;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'connections-health-'));
  ({ store, keychain } = testConnectionsStore(path.join(directory, 'connections')));
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
  await updateContainerConfigJson(MAIN, 'mcp_servers', {
    ledgerly: { type: 'http', url: `https://app.ledgerly.example.test/mcp?key=${OPERATOR_KEY}` },
    calendar: { command: 'calendar-mcp', args: ['--readonly'] },
    travel: { type: 'http', url: 'https://plugin.example.test/mcp', plugin: 'travel-kit' },
    broken: { type: 'http', url: 'not a url' },
  });
});
afterEach(async () => {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

async function tokenApp(name: string, url: string) {
  const app = await store.create({ name, url, auth: 'token' });
  return store.connect(app.id, app.version, { kind: 'token', token: SENTINEL_TOKEN });
}

describe('connectionsHealth', () => {
  it('lists each app by name, host, origin and status only, with no URL or credential', async () => {
    await tokenApp('Ledger', 'https://mcp.ledger.example.test/mcp?workspace=family');
    const refused = await tokenApp('Notes', 'https://notes.example.test/mcp');
    await store.markRefused(refused.app.id, refused.generation);
    await store.create({ name: 'Recipes', url: 'https://recipes.example.test/mcp', auth: 'none' });

    const health = await connectionsHealth(async () => store);

    // An operator server is shown as connected: its entry in main's config is all the host knows of it.
    expect(health).toEqual({
      schemaVersion: 1,
      store: { available: true },
      apps: [
        { name: 'Ledger', host: 'mcp.ledger.example.test', origin: 'principal', status: 'connected' },
        { name: 'Notes', host: 'notes.example.test', origin: 'principal', status: 'needs_reconnecting' },
        { name: 'Recipes', host: 'recipes.example.test', origin: 'principal', status: 'not_connected' },
        { name: 'ledgerly', host: 'app.ledgerly.example.test', origin: 'operator', status: 'connected' },
      ],
    });
    const text = JSON.stringify(health);
    for (const leaked of [SENTINEL_TOKEN, OPERATOR_KEY, '/mcp', 'workspace=', 'client'])
      expect(text).not.toContain(leaked);
  });

  const lockKeychain = (chain: TestKeychain): void => {
    chain.unavailable = true;
  };
  const loseKey = (chain: TestKeychain): void => {
    chain.key = undefined;
  };
  it.each([
    ['keychain_unavailable', lockKeychain],
    ['key_missing', loseKey],
  ] as const)('reports %s while still listing the apps', async (reason, breakKeychain) => {
    await tokenApp('Ledger', 'https://mcp.ledger.example.test/mcp');
    breakKeychain(keychain);

    const health = await connectionsHealth(async () => store);

    expect(health.store).toEqual({ available: false, reason });
    expect(health.apps.map(({ name, status }) => [name, status])).toEqual([
      ['Ledger', 'connected'],
      ['ledgerly', 'connected'],
    ]);
  });

  it('reports the store unavailable and still lists operator servers when the store cannot be opened', async () => {
    const health = await connectionsHealth(async () => {
      throw new ConnectionsStoreError('store_unavailable');
    });

    expect(health).toEqual({
      schemaVersion: 1,
      store: { available: false, reason: 'keychain_unavailable' },
      apps: [{ name: 'ledgerly', host: 'app.ledgerly.example.test', origin: 'operator', status: 'connected' }],
    });
  });
});

describe('gws-ea-connections-health', () => {
  it('is a hidden host-only command that takes no arguments', () => {
    const command = lookup('gws-ea-connections-health');

    expect(command).toMatchObject({ access: 'hidden', hostOnly: true });
    expect(command?.parseArgs({})).toBeUndefined();
    expect(() => command?.parseArgs({ id: 'app_1' })).toThrow('takes no arguments');
  });
});

describe('the host-start hook', () => {
  const start = async (): Promise<void> => {
    if (!host.start) throw new Error('the connections module registered no host-start hook');
    await host.start({ signal: new AbortController().signal });
  };

  beforeEach(() => {
    process.env[CONNECTIONS_ROOT_ENV] = path.join(directory, 'connections');
    host.started.length = 0;
    vi.mocked(getConnectionsStore).mockResolvedValue(store);
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.error).mockClear();
  });
  afterEach(() => {
    delete process.env[CONNECTIONS_ROOT_ENV];
  });

  it('sweeps expired sign-ins, then arms restart checks before the first apply', async () => {
    const sweep = vi.spyOn(store, 'sweepExpiredSignIns').mockImplementation(async () => {
      host.started.push('sweep');
      return 0;
    });

    await start();

    expect(sweep).toHaveBeenCalledOnce();
    expect(host.started).toEqual([
      'sweep',
      'restart checks',
      'reconnect notes',
      'sorter',
      'refresher',
      'relay',
      'apply',
    ]);
  });

  it('still arms everything and applies when the sign-in sweep finds the store unavailable', async () => {
    vi.spyOn(store, 'sweepExpiredSignIns').mockRejectedValue(new ConnectionsStoreError('store_unavailable'));

    await start();

    expect(host.started).toEqual(['restart checks', 'reconnect notes', 'sorter', 'refresher', 'relay', 'apply']);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { reason: 'store_unavailable' });
  });

  it('logs an unavailable store or unreadable main servers from the apply, and rethrows anything else', async () => {
    vi.mocked(applyMainServers).mockRejectedValueOnce(new ConnectionsStoreError('store_unavailable'));
    await expect(start()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('Connections store unavailable', { reason: 'store_unavailable' });

    vi.mocked(applyMainServers).mockRejectedValueOnce(new MainServersUnreadableError());
    await expect(start()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('Main apps not applied', {
      reason: new MainServersUnreadableError().message,
    });

    const defect = new TypeError('a programming error');
    vi.mocked(applyMainServers).mockRejectedValueOnce(defect);
    await expect(start()).rejects.toBe(defect);
  });
});

describe('retiring catalog apps the operator turned off', () => {
  const linkAuth = (): string => path.join(directory, 'connections', 'link', 'auth.json');

  async function connectedLink(): Promise<void> {
    const created = await store.create({ name: 'Link', transport: 'host_cli', catalogId: 'link' });
    await store.connect(created.id, created.version, { kind: 'none' });
    await mkdir(path.dirname(linkAuth()), { recursive: true, mode: 0o700 });
    await writeFile(linkAuth(), JSON.stringify({ auth: { access_token: SENTINEL_TOKEN } }), { mode: 0o600 });
  }

  async function writePolicy(link: { readonly enabled: boolean; readonly version: string }): Promise<void> {
    const file = path.join(directory, 'catalog.json');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        link: {
          enabled: link.enabled,
          versions: { [link.version]: { installationDir: path.join(directory, 'gone') } },
        },
        shop: null,
      }),
      { mode: 0o600 },
    );
    process.env[CATALOG_POLICY_FILE_ENV] = file;
  }

  const linkStatus = async (): Promise<string | undefined> =>
    (await store.apps()).find((app) => app.catalogId === 'link')?.status;

  beforeEach(() => {
    process.env[CONNECTIONS_ROOT_ENV] = path.join(directory, 'connections');
    vi.mocked(getConnectionsStore).mockResolvedValue(store);
    vi.mocked(writeNoteForMain).mockClear();
  });
  afterEach(() => {
    delete process.env[CONNECTIONS_ROOT_ENV];
    delete process.env[CATALOG_POLICY_FILE_ENV];
  });

  it('is a hidden host-only command that takes one retirable entry', () => {
    const command = lookup(CATALOG_RETIRE_COMMAND);

    expect(command).toMatchObject({ access: 'hidden', hostOnly: true });
    expect(command?.parseArgs({ entry: 'link' })).toEqual({ entry: 'link' });
    expect(() => command?.parseArgs({ entry: 'notion' })).toThrow('--entry');
  });

  it('disconnects a running assistant’s Link when asked, and answers that none remain', async () => {
    await connectedLink();
    await writePolicy({ enabled: true, version: '1.6.0' });
    if (!host.start) throw new Error('the connections module registered no host-start hook');
    await host.start({ signal: new AbortController().signal });
    expect(await linkStatus()).toBe('connected');
    // The operator's uninstall disables the entry first, then asks.
    await writePolicy({ enabled: false, version: '1.6.0' });
    const command = lookup(CATALOG_RETIRE_COMMAND);
    if (!command) throw new Error('the retire command is not registered');

    const reply = await command.handler(command.parseArgs({ entry: 'link' }), { caller: 'host' });

    expect(reply).toEqual({ schemaVersion: 1, entry: 'link', retired: 1, remaining: 0 });
    expect(await linkStatus()).toBe('not_connected');
    expect(existsSync(linkAuth())).toBe(false);
    expect(writeNoteForMain).toHaveBeenCalledWith(expect.objectContaining({ wake: false }));
  });

  it('disconnects Link at the next start of an assistant that was stopped when the operator disabled it', async () => {
    await connectedLink();
    await writePolicy({ enabled: false, version: '1.6.0' });
    if (!host.start) throw new Error('the connections module registered no host-start hook');

    await host.start({ signal: new AbortController().signal });

    expect(await linkStatus()).toBe('not_connected');
    expect(existsSync(linkAuth())).toBe(false);
    expect(writeNoteForMain).toHaveBeenCalledOnce();
    expect(writeNoteForMain).toHaveBeenCalledWith(expect.objectContaining({ wake: false }));
  });

  it('retires nothing at start when Link is enabled but this release’s pinned version is not installed', async () => {
    await connectedLink();
    await writePolicy({ enabled: true, version: '0.0.1' });
    if (!host.start) throw new Error('the connections module registered no host-start hook');

    await host.start({ signal: new AbortController().signal });

    expect(await linkStatus()).toBe('connected');
    expect(existsSync(linkAuth())).toBe(true);
    expect(writeNoteForMain).not.toHaveBeenCalled();
  });

  describe('a Shop app the principal added by address', () => {
    const SHOP_URL = 'https://mcp.shop.com/';
    const PRINCIPAL = 'morgan@example.test';
    const OPERATOR_CLIENT = { clientId: 'gws-ea-shop-client', clientSecret: 'sentinel-operator-shop-secret' };

    /** Signed in with the operator's client, or with one the principal entered; no refresh token, so nothing is revoked. */
    async function connectedShop(client: 'operator' | 'entered'): Promise<ConnectionApp> {
      const issuer = 'https://mcp.shop.com/';
      const created = await store.create({ name: 'My Shop', url: SHOP_URL, auth: 'oauth', issuer });
      expect(created.catalogId).toBeNull();
      const withClient = await store.setClient(created.id, created.version, {
        issuer,
        client: client === 'operator' ? OPERATOR_CLIENT : { clientId: 'shop-client-juno-hale' },
        entered: client === 'entered',
      });
      const { state } = await store.startSignIn(withClient.id, withClient.version, {
        principalId: PRINCIPAL,
        verifier: 'verifier-'.padEnd(48, 'x'),
        issuer,
        redirectUri: 'https://juno.example.test/connections/callback/mcp.shop.com',
        resource: SHOP_URL,
      });
      const claim = await store.claimSignIn(state, { host: withClient.host, principalId: PRINCIPAL });
      if (!claim) throw new Error('The sign-in was not claimed');
      const done = await store.completeSignIn(claim, {
        kind: 'oauth',
        accessToken: SENTINEL_TOKEN,
        accessIssuedAt: new Date().toISOString(),
        accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      if (done.status !== 'connected') throw new Error('The sign-in did not connect');
      return done.app;
    }

    async function writeShopPolicy(offered: boolean): Promise<void> {
      const file = path.join(directory, 'catalog.json');
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          link: null,
          shop: offered ? { clientId: OPERATOR_CLIENT.clientId, clientSecretFile: null } : null,
        }),
        { mode: 0o600 },
      );
      process.env[CATALOG_POLICY_FILE_ENV] = file;
    }

    const shopStatus = async (): Promise<string | undefined> =>
      (await store.apps()).find((app) => app.host === 'mcp.shop.com')?.status;

    const retireShop = async (): Promise<unknown> => {
      const command = lookup(CATALOG_RETIRE_COMMAND);
      if (!command) throw new Error('the retire command is not registered');
      return command.handler(command.parseArgs({ entry: 'shop' }), { caller: 'host' });
    };

    const start = async (): Promise<void> => {
      if (!host.start) throw new Error('the connections module registered no host-start hook');
      await host.start({ signal: new AbortController().signal });
    };

    it('is disconnected, noted and counted when the operator turns Shop off on a running assistant', async () => {
      const app = await connectedShop('operator');
      await writeShopPolicy(true);
      await start();
      expect(await shopStatus()).toBe('connected');
      await writeShopPolicy(false);

      const reply = await retireShop();

      expect(reply).toEqual({ schemaVersion: 1, entry: 'shop', retired: 1, remaining: 0 });
      expect(await shopStatus()).toBe('not_connected');
      expect(writeNoteForMain).toHaveBeenCalledOnce();
      expect(writeNoteForMain).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `connection-retired:${app.id}:${app.version}`,
          text: expect.stringContaining('turned Shop off'),
          wake: false,
        }),
      );
    });

    it('is disconnected and noted at the next start of an assistant that was stopped when Shop was turned off', async () => {
      const app = await connectedShop('operator');
      await writeShopPolicy(false);

      await start();

      expect(await shopStatus()).toBe('not_connected');
      expect(writeNoteForMain).toHaveBeenCalledOnce();
      expect(writeNoteForMain).toHaveBeenCalledWith(
        expect.objectContaining({ id: `connection-retired:${app.id}:${app.version}`, wake: false }),
      );
    });

    it('cannot finish a sign-in, claimed or not, that was pending when the operator turned Shop off', async () => {
      const issuer = 'https://mcp.shop.com/';
      const created = await store.create({ name: 'My Shop', url: SHOP_URL, auth: 'oauth', issuer });
      const app = await store.setClient(created.id, created.version, {
        issuer,
        client: OPERATOR_CLIENT,
        entered: false,
      });
      const signIn = () =>
        store.startSignIn(app.id, app.version, {
          principalId: PRINCIPAL,
          verifier: 'verifier-'.padEnd(48, 'x'),
          issuer,
          redirectUri: 'https://juno.example.test/connections/callback/mcp.shop.com',
          resource: SHOP_URL,
        });
      const match = { host: app.host, principalId: PRINCIPAL };
      await writeShopPolicy(false);
      await start();

      const unclaimed = await signIn();
      expect(await retireShop()).toEqual({ schemaVersion: 1, entry: 'shop', retired: 0, remaining: 0 });
      expect(await store.claimSignIn(unclaimed.state, match)).toBeUndefined();

      const claim = await store.claimSignIn((await signIn()).state, match);
      if (!claim) throw new Error('The sign-in was not claimed');
      await retireShop();
      const completion = await store.completeSignIn(claim, {
        kind: 'oauth',
        accessToken: SENTINEL_TOKEN,
        accessIssuedAt: new Date().toISOString(),
        accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });

      expect(completion).toEqual({ status: 'expired' });
      expect(await shopStatus()).toBe('not_connected');
    });

    it('stays connected, and does not hold up the uninstall, when it signed in with a client the principal entered', async () => {
      await connectedShop('entered');
      await writeShopPolicy(false);

      await start();
      const reply = await retireShop();

      expect(reply).toEqual({ schemaVersion: 1, entry: 'shop', retired: 0, remaining: 0 });
      expect(await shopStatus()).toBe('connected');
      expect(writeNoteForMain).not.toHaveBeenCalled();
    });
  });
});
