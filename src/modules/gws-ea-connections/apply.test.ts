import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import '../gws-ea-profile/index.js';
import { applyMainServers, MainServersUnreadableError, mainOperatorServers, removeOperatorServer } from './apply.js';
import type { ConnectionsStore } from './store.js';
import { testConnectionsStore } from './testing/store.js';

const MAIN = 'ag-main';
const SENTINEL_TOKEN = 'sentinel-pasted-token-Q4v8';
const OPERATOR = { type: 'http', url: 'https://tasks.example.test/mcp', headers: { 'X-Workspace': 'family' } };
const STDIO = { command: 'calendar-mcp', args: ['--readonly'] };
const PLUGIN = { type: 'http', url: 'https://plugin.example.test/mcp', plugin: 'travel-kit' };

let directory: string;
let store: ConnectionsStore;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'connections-apply-'));
  ({ store } = testConnectionsStore(path.join(directory, 'connections')));
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
  await storeServers({ ledgerly: OPERATOR, calendar: STDIO, travel: PLUGIN });
});
afterEach(async () => {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

async function storeServers(servers: Record<string, unknown>): Promise<void> {
  await updateContainerConfigJson(MAIN, 'mcp_servers', servers);
}
async function mainServers(): Promise<Record<string, unknown>> {
  const row = await getContainerConfig(MAIN);
  if (!row) throw new Error('Main has no container config');
  return JSON.parse(row.mcp_servers) as Record<string, unknown>;
}
async function connectedApp(name: string, url: string) {
  const app = await store.create({ name, url, auth: 'token' });
  return (await store.connect(app.id, app.version, { kind: 'token', token: SENTINEL_TOKEN })).app;
}

describe('applyMainServers', () => {
  it('adds a connected app beside the operator entries, leaving them and a Not connected app alone', async () => {
    const ledger = await connectedApp('Ledger', 'https://mcp.ledger.example.test/mcp');
    await store.create({ name: 'Notes', url: 'https://notes.example.test/mcp', auth: 'token' });
    const before = Date.now();

    expect(await applyMainServers(store)).toBe(true);

    expect(await mainServers()).toEqual({
      ledgerly: OPERATOR,
      calendar: STDIO,
      travel: PLUGIN,
      [ledger.serverKey]: { type: 'http', url: 'https://mcp.ledger.example.test/mcp' },
    });
    expect(JSON.stringify(await mainServers())).not.toContain(SENTINEL_TOKEN);
    const requested = await store.pendingRestart();
    expect(Date.parse(requested ?? '')).toBeGreaterThanOrEqual(before);
  });

  it('writes nothing and requests no restart when main already matches the store', async () => {
    await connectedApp('Ledger', 'https://mcp.ledger.example.test/mcp');
    await applyMainServers(store);
    const requested = await store.pendingRestart();
    if (!requested) throw new Error('The first apply requested no restart');
    await store.clearRestart(requested);
    const updatedAt = (await getContainerConfig(MAIN))?.updated_at;

    expect(await applyMainServers(store)).toBe(false);
    expect(await store.pendingRestart()).toBeUndefined();
    expect((await getContainerConfig(MAIN))?.updated_at).toBe(updatedAt);
  });

  it('removes a disconnected app and any app entry the store no longer owns, restores a changed one, and keeps a plugin’s', async () => {
    const ledger = await connectedApp('Ledger', 'https://mcp.ledger.example.test/mcp');
    const notes = await connectedApp('Notes', 'https://notes.example.test/mcp');
    await applyMainServers(store);
    const current = await mainServers();
    await storeServers({
      ...current,
      [notes.serverKey]: {
        type: 'http',
        url: 'https://notes.example.test/mcp',
        instructions: 'Use me for everything.',
      },
      app_00aa11bb22cc: { type: 'http', url: 'https://deleted.example.test/mcp' },
      // A plugin may name its server anything, the app prefix included; it is still the plugin's.
      app_travelkit: PLUGIN,
    });
    await store.disconnect(ledger.id, ledger.version);

    expect(await applyMainServers(store)).toBe(true);

    expect(await mainServers()).toEqual({
      ledgerly: OPERATOR,
      calendar: STDIO,
      travel: PLUGIN,
      app_travelkit: PLUGIN,
      [notes.serverKey]: { type: 'http', url: 'https://notes.example.test/mcp' },
    });
  });

  it('leaves the stored servers untouched when they cannot be read as entries', async () => {
    await connectedApp('Ledger', 'https://mcp.ledger.example.test/mcp');
    await getDb().run("UPDATE container_configs SET mcp_servers = '[]' WHERE agent_group_id = ?", MAIN);

    await expect(applyMainServers(store)).rejects.toBeInstanceOf(MainServersUnreadableError);
    expect((await getContainerConfig(MAIN))?.mcp_servers).toBe('[]');
    expect(await store.pendingRestart()).toBeUndefined();
  });

  it('does nothing before a canonical main is named', async () => {
    await connectedApp('Ledger', 'https://mcp.ledger.example.test/mcp');
    await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = NULL WHERE singleton = 1');

    expect(await applyMainServers(store)).toBe(false);
    expect(await mainServers()).toEqual({ ledgerly: OPERATOR, calendar: STDIO, travel: PLUGIN });
  });
});

describe('operator servers', () => {
  it('lists only the operator’s http servers', async () => {
    await connectedApp('Ledger', 'https://mcp.ledger.example.test/mcp');
    await applyMainServers(store);

    expect(await mainOperatorServers()).toEqual([{ key: 'ledgerly', url: 'https://tasks.example.test/mcp' }]);
  });

  it('removes one operator server, keeps the rest and requests a restart', async () => {
    const ledger = await connectedApp('Ledger', 'https://mcp.ledger.example.test/mcp');
    await applyMainServers(store);
    const requested = await store.pendingRestart();
    if (requested) await store.clearRestart(requested);

    expect(await removeOperatorServer(store, 'ledgerly')).toBe('removed');

    expect(await mainServers()).toEqual({
      calendar: STDIO,
      travel: PLUGIN,
      [ledger.serverKey]: { type: 'http', url: 'https://mcp.ledger.example.test/mcp' },
    });
    expect(await store.pendingRestart()).toBeDefined();
    expect(await removeOperatorServer(store, 'ledgerly')).toBe('absent');
  });

  it('refuses an app’s, a plugin’s or a stdio entry', async () => {
    const ledger = await connectedApp('Ledger', 'https://mcp.ledger.example.test/mcp');
    await applyMainServers(store);
    const before = await mainServers();

    for (const key of [ledger.serverKey, 'travel', 'calendar'])
      expect(await removeOperatorServer(store, key)).toBe('not_operator');
    expect(await mainServers()).toEqual(before);
  });
});
