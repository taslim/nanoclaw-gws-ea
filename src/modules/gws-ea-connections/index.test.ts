import { mkdtemp, rm } from 'node:fs/promises';
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
import { applyMainServers, MainServersUnreadableError } from './apply.js';
import { CONNECTIONS_ROOT_ENV } from './config.js';
import { connectionsHealth } from './index.js';
import { ConnectionsStoreError, getConnectionsStore, type ConnectionsStore } from './store.js';
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
