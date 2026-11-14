import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lookup } from '../../cli/registry.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import '../gws-ea-profile/index.js';
import { connectionsHealth } from './index.js';
import { ConnectionsStoreError, type ConnectionsStore } from './store.js';
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
    homeboard: { type: 'http', url: `https://homeboard.nownow.ai/mcp?key=${OPERATOR_KEY}` },
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
        { name: 'homeboard', host: 'homeboard.nownow.ai', origin: 'operator', status: 'connected' },
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
      ['homeboard', 'connected'],
    ]);
  });

  it('reports the store unavailable and still lists operator servers when the store cannot be opened', async () => {
    const health = await connectionsHealth(async () => {
      throw new ConnectionsStoreError('store_unavailable');
    });

    expect(health).toEqual({
      schemaVersion: 1,
      store: { available: false, reason: 'keychain_unavailable' },
      apps: [{ name: 'homeboard', host: 'homeboard.nownow.ai', origin: 'operator', status: 'connected' }],
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
