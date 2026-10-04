/**
 * external-email cannot drift into more reach: before any session of it
 * starts or is adopted, the host refuses one whose list, configuration, or
 * gateway scope differs from what the host stamped, and status names each.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupervisedHandle, SupervisedSnapshot } from '../../drivers/session-events.js';
import type { GatewayCredentialScope } from '../../gateway-providers/index.js';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-external-email-admission-test';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-gws-ea-external-email-admission-test/groups',
  DATA_DIR: '/tmp/nanoclaw-gws-ea-external-email-admission-test/data',
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const snapshots: SupervisedSnapshot[] = [];
vi.mock('../../drivers/index.js', () => ({
  getSessionDriver: () => ({ listSessions: async () => snapshots, capabilities: () => ({}) }),
  isSessionEventsDriver: () => false,
}));

import {
  _resetAdoptionRetryStateForTesting,
  adoptRunningSessions,
  assertSessionAdmitted,
  isContainerRunning,
  killContainer,
} from '../../container-runner.js';
import {
  ensureContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import {
  closeDb,
  createAgentGroup,
  createSession,
  getAgentGroup,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { resetGatewayProvider } from '../../gateway-providers/index.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import type { AgentGroup } from '../../types.js';
import { externalEmailHealth, getExternalEmailAgentGroupId } from './index.js';
import '../gws-ea-profile/index.js';

const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const SESSION = 'sess-ee';
/** What core asks the gateway for, for a group whose keys name no credential: only the model provider's. */
const MODEL_ONLY: GatewayCredentialScope = { kind: 'only', credentials: [], modelDomains: ['anthropic.com'] };

const ensure = vi.fn(async () => ({
  contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' as const } } },
}));

async function startHost(): Promise<void> {
  const signal = new AbortController().signal;
  const deliveryAdapter = { deliver: async () => undefined };
  for (const start of getHostStartCallbacks()) await start({ db: getDb(), deliveryAdapter, signal });
}

async function externalEmail(): Promise<AgentGroup> {
  const id = await getExternalEmailAgentGroupId();
  const found = id === null ? undefined : await getAgentGroup(id);
  if (!found) throw new Error('external-email was not created');
  return found;
}

function admit(agentGroupId: string, credentialScope: GatewayCredentialScope = MODEL_ONLY): Promise<void> {
  return assertSessionAdmitted({
    disposition: 'create',
    key: { installSlug: 'test-install', agentGroupId, sessionId: SESSION },
    credentialScope,
  });
}

function fakeHandle(agentGroupId: string): { handle: SupervisedHandle; stopped: string[] } {
  const stopped: string[] = [];
  const terminal: Array<(failure?: unknown) => void> = [];
  const handle = {
    key: { installSlug: 'test-install', agentGroupId, sessionId: SESSION },
    name: 'container-ee',
    async start() {},
    async stop(reason: string) {
      stopped.push(reason);
      for (const callback of terminal) callback(undefined);
    },
    async status() {
      return { phase: 'running' };
    },
    onTerminal(callback: (failure?: unknown) => void) {
      terminal.push(callback);
    },
  } as unknown as SupervisedHandle;
  return { handle, stopped };
}

/** One way the stamped group can drift, applied by the host or by hand, and the refusal it earns. */
const DRIFTS: ReadonlyArray<readonly [string, (group: AgentGroup) => Promise<void>, RegExp]> = [
  ['a list of every key', (g) => updateContainerConfigJson(g.id, 'capabilities', 'all'), /capabilities/],
  [
    'a key added to its pair',
    (g) => updateContainerConfigJson(g.id, 'capabilities', ['reply', 'web', 'gws-ea-meetings-external']),
    /capabilities/,
  ],
  [
    'an MCP server',
    (g) => updateContainerConfigJson(g.id, 'mcp_servers', { tools: { command: 'x', args: [], env: {} } }),
    /MCP servers/,
  ],
  ['an apt package', (g) => updateContainerConfigJson(g.id, 'packages_apt', ['curl']), /packages/],
  ['an npm package', (g) => updateContainerConfigJson(g.id, 'packages_npm', ['left-pad']), /packages/],
  [
    'an extra mount',
    (g) =>
      updateContainerConfigJson(g.id, 'additional_mounts', [
        { hostPath: '/srv', containerPath: 'srv', readonly: true },
      ]),
    /mounts/,
  ],
  ['a CLI scope', (g) => updateContainerConfigScalars(g.id, { cli_scope: 'global' }), /CLI/],
  ['a shared skill', (g) => updateContainerConfigJson(g.id, 'skills', ['welcome']), /skills/],
  [
    'another stamped plugin',
    async (g) => {
      fs.mkdirSync(path.join(GROUPS_DIR, g.folder, 'plugins', 'other-plugin'), { recursive: true });
    },
    /plugins/,
  ],
  [
    'a template skill',
    async (g) => {
      fs.mkdirSync(path.join(DATA_DIR, 'v2-sessions', g.id, '.claude-shared', 'skills', 'widget'), { recursive: true });
    },
    /plugins/,
  ],
];

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  snapshots.length = 0;
  ensure.mockClear();
  _resetAdoptionRetryStateForTesting();
  resetGatewayProvider({
    kind: 'scoping-fixture',
    agentSkills: [],
    sessions: { ensure, enforcesCredentialScope: true },
    approvals: { subscribe: async () => {} },
  });
  await runMigrations(await initTestDb());
  await startHost();
});

afterEach(async () => {
  if (isContainerRunning(SESSION)) {
    killContainer(SESSION, 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning(SESSION)).toBe(false));
  }
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('the session admission external-email registers', () => {
  it('admits external-email as the host stamped it, with only the model secret', async () => {
    await expect(admit((await externalEmail()).id)).resolves.toBeUndefined();
    expect((await externalEmailHealth()).problems).toEqual([]);
  });

  it.each(DRIFTS)('refuses it with %s, and status names why', async (_label, drift, reason) => {
    const ee = await externalEmail();
    await drift(ee);

    await expect(admit(ee.id)).rejects.toThrow(reason);
    const health = await externalEmailHealth();
    expect(health.agent_group_id).toBe(ee.id);
    expect(health.problems.join('\n')).toMatch(reason);
  });

  it('refuses a gateway identity that is not exactly selective with the model secret', async () => {
    const ee = await externalEmail();

    await expect(admit(ee.id, { kind: 'all' })).rejects.toThrow(/gateway/);
    await expect(
      admit(ee.id, { kind: 'only', credentials: ['google-calendar'], modelDomains: ['anthropic.com'] }),
    ).rejects.toThrow(/gateway/);
    await expect(admit(ee.id, { kind: 'only', credentials: [], modelDomains: [] })).rejects.toThrow(/gateway/);
  });

  it('leaves every other group to its own configuration', async () => {
    const other: AgentGroup = {
      id: 'ag-other',
      name: 'other',
      folder: 'other',
      agent_provider: null,
      created_at: new Date().toISOString(),
    };
    await createAgentGroup(other);
    await ensureContainerConfig(other.id);
    for (const [, drift] of DRIFTS) await drift(other);

    await expect(admit(other.id, { kind: 'all' })).resolves.toBeUndefined();
  });

  it('stops a drifted running external-email at adoption without asking the gateway, and adopts one as stamped', async () => {
    const ee = await externalEmail();
    await createSession({
      id: SESSION,
      agent_group_id: ee.id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
    await updateContainerConfigJson(ee.id, 'packages_apt', ['curl']);
    const drifted = fakeHandle(ee.id);
    snapshots.push({ handle: drifted.handle, phase: 'running' } as SupervisedSnapshot);

    expect(await adoptRunningSessions()).toEqual({ adopted: 0, stopped: 1 });
    expect(drifted.stopped).toHaveLength(1);
    expect(ensure).not.toHaveBeenCalled();

    await updateContainerConfigJson(ee.id, 'packages_apt', []);
    snapshots.length = 0;
    const stamped = fakeHandle(ee.id);
    snapshots.push({ handle: stamped.handle, phase: 'running' } as SupervisedSnapshot);

    expect(await adoptRunningSessions()).toEqual({ adopted: 1, stopped: 0 });
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ credentialScope: MODEL_ONLY, disposition: 'adopt' }),
      expect.anything(),
    );
  });

  it('reports a missing group as unhealthy', async () => {
    await getDb().run('UPDATE gws_ea_profile SET external_email_agent_group_id = NULL');

    expect(await externalEmailHealth()).toEqual({
      agent_group_id: null,
      problems: ['external-email has not been created; the host creates it when it starts'],
    });
  });
});
