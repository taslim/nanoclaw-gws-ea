import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import type { GatewayCredentialRemoval, GatewayHostCredential } from '../../gateway-providers/credential-connection.js';
import { log } from '../../log.js';
import '../gws-ea-profile/index.js';
import { appCredentialName } from './admit.js';
import { disconnectOperatorServer, type OperatorCredentials, type OperatorDisconnectDependencies } from './operator.js';
import type { ConnectionsStore } from './store.js';
import { testConnectionsStore } from './testing/store.js';

const MAIN = 'ag-main';
const HOMEBOARD_HOST = 'homeboard.nownow.ai';
const HOMEBOARD = { type: 'http', url: `https://${HOMEBOARD_HOST}/mcp` };
const MODEL_HOST = 'api.anthropic.com';
const SENTINEL_NAME = 'sentinel-credential-name-H6p1';
const SENTINEL_FAILURE = 'sentinel-gateway-failure-Z9w3';

interface Held {
  readonly name: string;
  readonly host: string;
}

/** The gateway's by-host seam over an in-memory set of credentials. */
class FakeCredentials implements OperatorCredentials {
  readonly held = new Map<string, Held>();
  readonly listed: string[] = [];
  readonly failing = new Set<string>();
  listFails = false;

  hold(id: string, name: string, host: string): void {
    this.held.set(id, { name, host });
  }

  async listForHost(host: string): Promise<readonly GatewayHostCredential[]> {
    this.listed.push(host);
    if (this.listFails) throw new Error(SENTINEL_FAILURE);
    return [...this.held].filter(([, held]) => held.host === host).map(([id, { name }]) => ({ id, name }));
  }

  async removeById(ids: readonly string[]): Promise<readonly GatewayCredentialRemoval[]> {
    return ids.map((id) => {
      if (!this.held.has(id)) return { id, outcome: 'gone' };
      if (this.failing.has(id)) return { id, outcome: 'failed' };
      this.held.delete(id);
      return { id, outcome: 'removed' };
    });
  }
}

let directory: string;
let store: ConnectionsStore;
let credentials: FakeCredentials;
let logged: string[];

function dependencies(overrides: Partial<OperatorDisconnectDependencies> = {}): OperatorDisconnectDependencies {
  return { credentials, protectedHosts: async () => new Set([MODEL_HOST, 'www.googleapis.com']), ...overrides };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'connections-operator-'));
  ({ store } = testConnectionsStore(path.join(directory, 'connections')));
  credentials = new FakeCredentials();
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
});
afterEach(async () => {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function mainServers(): Promise<Record<string, unknown>> {
  const row = await getContainerConfig(MAIN);
  if (!row) throw new Error('Main has no container config');
  return JSON.parse(row.mcp_servers) as Record<string, unknown>;
}

function assertNoSentinels(): void {
  for (const line of logged) {
    expect(line).not.toContain(SENTINEL_NAME);
    expect(line).not.toContain(SENTINEL_FAILURE);
  }
}

describe('disconnectOperatorServer', () => {
  it('removes a hand-wired server and its Bearer credential, leaving other hosts’ credentials, and restarts main', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { homeboard: HOMEBOARD, calendar: { command: 'cal-mcp' } });
    credentials.hold('secret-homeboard', 'homeboard', HOMEBOARD_HOST);
    credentials.hold('secret-ledger', 'ledger', 'mcp.ledger.example.test');

    expect(await disconnectOperatorServer(store, { key: 'homeboard', host: HOMEBOARD_HOST }, dependencies())).toBe(
      'disconnected',
    );

    expect(await mainServers()).toEqual({ calendar: { command: 'cal-mcp' } });
    expect([...credentials.held.keys()]).toEqual(['secret-ledger']);
    expect(await store.pendingRestart()).toBeDefined();
  });

  it('never removes the assistant’s own credentials on the host: app, Google or model', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', {
      homeboard: HOMEBOARD,
      models: { type: 'http', url: `https://${MODEL_HOST}/mcp` },
    });
    credentials.hold('secret-homeboard', SENTINEL_NAME, HOMEBOARD_HOST);
    credentials.hold('secret-app', appCredentialName('5b0d7f3e-2c4a-4e8b-9f61-7a3c2e1d0b9f'), HOMEBOARD_HOST);
    credentials.hold('secret-google', 'google-calendar', HOMEBOARD_HOST);
    credentials.hold('secret-model', 'Anthropic', MODEL_HOST);

    expect(await disconnectOperatorServer(store, { key: 'homeboard', host: HOMEBOARD_HOST }, dependencies())).toBe(
      'disconnected',
    );
    expect(await disconnectOperatorServer(store, { key: 'models', host: MODEL_HOST }, dependencies())).toBe(
      'disconnected',
    );

    expect(await mainServers()).toEqual({});
    expect([...credentials.held.keys()].sort()).toEqual(['secret-app', 'secret-google', 'secret-model']);
    expect(credentials.listed).toEqual([HOMEBOARD_HOST]);
    assertNoSentinels();
  });

  it('keeps the host’s credentials while another operator server in main still uses that host', async () => {
    const boards = { type: 'http', url: `https://${HOMEBOARD_HOST}/boards/mcp` };
    await updateContainerConfigJson(MAIN, 'mcp_servers', { homeboard: HOMEBOARD, boards });
    credentials.hold('secret-bearer', 'homeboard', HOMEBOARD_HOST);

    expect(await disconnectOperatorServer(store, { key: 'homeboard', host: HOMEBOARD_HOST }, dependencies())).toBe(
      'disconnected',
    );
    expect(await mainServers()).toEqual({ boards });
    expect([...credentials.held.keys()]).toEqual(['secret-bearer']);
    expect(await store.pendingRestart()).toBeDefined();

    // The last server on the host takes the host's credentials with it.
    expect(await disconnectOperatorServer(store, { key: 'boards', host: HOMEBOARD_HOST }, dependencies())).toBe(
      'disconnected',
    );
    expect(await mainServers()).toEqual({});
    expect(credentials.held.size).toBe(0);
  });

  it('removes the host’s credentials once when two servers on it are disconnected together', async () => {
    const boards = { type: 'http', url: `https://${HOMEBOARD_HOST}/boards/mcp` };
    await updateContainerConfigJson(MAIN, 'mcp_servers', { homeboard: HOMEBOARD, boards });
    credentials.hold('secret-bearer', 'homeboard', HOMEBOARD_HOST);

    expect(
      await Promise.all([
        disconnectOperatorServer(store, { key: 'homeboard', host: HOMEBOARD_HOST }, dependencies()),
        disconnectOperatorServer(store, { key: 'boards', host: HOMEBOARD_HOST }, dependencies()),
      ]),
    ).toEqual(['disconnected', 'disconnected']);
    expect(await mainServers()).toEqual({});
    expect(credentials.held.size).toBe(0);
  });

  it('keeps the server when a credential stays, and the next try removes the rest and the server', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { homeboard: HOMEBOARD });
    credentials.hold('secret-bearer', SENTINEL_NAME, HOMEBOARD_HOST);
    credentials.hold('secret-workspace', 'homeboard-workspace', HOMEBOARD_HOST);
    credentials.failing.add('secret-workspace');
    const request = { key: 'homeboard', host: HOMEBOARD_HOST };

    expect(await disconnectOperatorServer(store, request, dependencies())).toBe('credentials_kept');
    expect(await mainServers()).toEqual({ homeboard: HOMEBOARD });
    expect([...credentials.held.keys()]).toEqual(['secret-workspace']);
    expect(await store.pendingRestart()).toBeUndefined();

    credentials.failing.clear();
    expect(await disconnectOperatorServer(store, request, dependencies())).toBe('disconnected');
    expect(await mainServers()).toEqual({});
    expect(credentials.held.size).toBe(0);
    assertNoSentinels();
  });

  it('keeps the server when the gateway cannot list the host’s credentials', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { homeboard: HOMEBOARD });
    credentials.hold('secret-bearer', 'homeboard', HOMEBOARD_HOST);
    credentials.listFails = true;

    expect(await disconnectOperatorServer(store, { key: 'homeboard', host: HOMEBOARD_HOST }, dependencies())).toBe(
      'credentials_kept',
    );
    expect(await mainServers()).toEqual({ homeboard: HOMEBOARD });
    expect(credentials.held.size).toBe(1);
    assertNoSentinels();
  });

  it('refuses a key that is not an operator http entry, touching nothing', async () => {
    const servers = {
      app_5b0d7f3e: { type: 'http', url: 'https://notes.example.test/mcp' },
      calendar: { command: 'cal-mcp' },
      travel: { type: 'http', url: 'https://travel.example.test/mcp', plugin: 'travel-kit' },
    };
    await updateContainerConfigJson(MAIN, 'mcp_servers', servers);
    credentials.hold('secret-notes', 'notes', 'notes.example.test');
    credentials.hold('secret-travel', 'travel', 'travel.example.test');

    for (const [key, host] of [
      ['app_5b0d7f3e', 'notes.example.test'],
      ['calendar', ''],
      ['travel', 'travel.example.test'],
      ['homeboard', HOMEBOARD_HOST],
    ] as const)
      expect(await disconnectOperatorServer(store, { key, host }, dependencies())).toBe('not_found');

    expect(await mainServers()).toEqual(servers);
    expect(credentials.held.size).toBe(2);
    expect(credentials.listed).toEqual([]);
  });

  it('refuses when the entry now points at another host than the one confirmed', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', {
      homeboard: { type: 'http', url: 'https://boards.example.test/mcp' },
    });
    credentials.hold('secret-boards', 'boards', 'boards.example.test');

    expect(await disconnectOperatorServer(store, { key: 'homeboard', host: HOMEBOARD_HOST }, dependencies())).toBe(
      'changed',
    );
    expect(Object.keys(await mainServers())).toEqual(['homeboard']);
    expect(credentials.held.size).toBe(1);
  });

  it('is unavailable on a gateway that cannot list and remove credentials by host', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { homeboard: HOMEBOARD });

    expect(
      await disconnectOperatorServer(
        store,
        { key: 'homeboard', host: HOMEBOARD_HOST },
        dependencies({ credentials: undefined }),
      ),
    ).toBe('unavailable');
    expect(await mainServers()).toEqual({ homeboard: HOMEBOARD });
  });
});
