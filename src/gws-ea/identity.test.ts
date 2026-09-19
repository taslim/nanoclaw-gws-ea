import { describe, expect, it, vi } from 'vitest';

import { reconcileMainIdentity, type MainIdentityDependencies } from './identity.js';
import type { InstanceRuntimeConfig } from './service.js';

const GROUP_ID = 'ag-11111111-1111-4111-8111-111111111111';

function runtimeConfig(): InstanceRuntimeConfig {
  const instanceId = '11111111-1111-4111-8111-111111111111';
  const checkout = '/opt/gws-ea/instances/one/nanoclaw';
  const project = `gws-ea-${instanceId.replaceAll('-', '')}`;
  return {
    schema_version: 1,
    instance_id: instanceId,
    install_id: instanceId.replaceAll('-', ''),
    deployed_commit: 'a'.repeat(40),
    checkout_realpath: checkout,
    node_path: '/usr/bin/node',
    home_directory: '/Users/operator',
    allocated_ports: { nanoclaw_webhook: 31_001, onecli_app: 31_002, onecli_gateway: 31_003 },
    agent_egress_network: `${project}-agent-egress`,
    onecli_project: project,
    onecli_app_url: 'http://127.0.0.1:31002',
    onecli_gateway_url: 'http://127.0.0.1:31003',
    onecli_gateway_container: `${project}-gateway-1`,
    onecli_cli_path: '/opt/onecli',
    selected_provider: 'claude',
    endpoint_url: 'https://aya.example.test/webhook/gchat',
    secret_files: {
      gchat_credentials: `${checkout}/data/gws-ea/secrets/gchat-service-account.json`,
      onecli_runtime_api_key: `${checkout}/data/gws-ea/secrets/onecli-runtime-api-key`,
      onecli_admin_api_key: `${checkout}/data/gws-ea/secrets/onecli-admin-api-key`,
    },
  };
}

interface FakeState {
  groupCreated: number;
  provider: string | null;
  profileWrites: number;
  agents: Array<{ id: string; identifier: string; name: string; secretMode: 'all' | 'selective' }>;
  grants: Map<string, string[]>;
}

function harness(options: { failAfterGrantOnce?: boolean; neverApplyGrant?: boolean } = {}): {
  state: FakeState;
  dependencies: MainIdentityDependencies;
} {
  const state: FakeState = {
    groupCreated: 0,
    provider: null,
    profileWrites: 0,
    agents: [],
    grants: new Map(),
  };
  let failed = false;
  const runNcl = vi.fn(async (_config: InstanceRuntimeConfig, args: readonly string[]) => {
    if (args[0] === 'groups' && args[1] === 'create') {
      const group = { id: GROUP_ID, name: 'main', folder: 'main', agent_provider: null, created_at: 'now' };
      if (state.groupCreated === 0) {
        state.groupCreated += 1;
        return group;
      }
      return { group, plugin: 'gws-ea-main', applied: true, changes: [], report: [], note: 'applied' };
    }
    if (args[0] === 'groups' && args[1] === 'config') {
      state.provider = args[args.indexOf('--provider') + 1] ?? null;
      return { agent_group_id: GROUP_ID, provider: state.provider };
    }
    if (args[0] === 'gws-ea-profile' && args[1] === 'reconcile') {
      state.profileWrites += 1;
      return { main_agent_group_id: GROUP_ID };
    }
    throw new Error(`Unexpected ncl call: ${args.join(' ')}`);
  });
  const runOnecliAdmin = vi.fn(async (_config: InstanceRuntimeConfig, args: readonly string[]) => {
    if (args[0] === 'agents' && args[1] === 'list') return state.agents;
    if (args[0] === 'agents' && args[1] === 'create') {
      const agent = { id: 'oc-main', identifier: GROUP_ID, name: 'main', secretMode: 'all' as const };
      state.agents.push(agent);
      return { id: agent.id };
    }
    if (args[0] === 'agents' && args[1] === 'set-secrets') {
      if (!options.neverApplyGrant) {
        state.agents = state.agents.map((agent) =>
          agent.id === 'oc-main' ? { ...agent, secretMode: 'selective' as const } : agent,
        );
        state.grants.set('oc-main', [args[args.indexOf('--secret-ids') + 1]!]);
      }
      if (options.failAfterGrantOnce && !failed) {
        failed = true;
        throw new Error('simulated crash after grant side effect');
      }
      return { status: 'updated' };
    }
    if (args[0] === 'agents' && args[1] === 'secrets') return state.grants.get('oc-main') ?? [];
    throw new Error(`Unexpected OneCLI call: ${args.join(' ')}`);
  });
  return { state, dependencies: { runNcl, runOnecliAdmin } };
}

const input = {
  assistantDisplayName: 'Aya',
  assistantWorkspaceEmail: 'aya@example.test',
  principalDisplayName: 'Taslim',
  principalTimezone: 'America/Los_Angeles',
  providerSecretId: 'sec-claude',
};

describe('main identity reconciliation', () => {
  it('rejects invalid profile input before mutating NanoClaw or OneCLI', async () => {
    const { state, dependencies } = harness();

    await expect(
      reconcileMainIdentity(
        runtimeConfig(),
        { ...input, assistantWorkspaceEmail: 'not-an-email', principalTimezone: 'Not/A-Timezone' },
        dependencies,
      ),
    ).rejects.toThrow(/email/i);

    expect(state).toMatchObject({ groupCreated: 0, provider: null, profileWrites: 0, agents: [] });
  });

  it('stamps one main group, selects its provider, verifies one selective grant, then publishes the profile', async () => {
    const { state, dependencies } = harness();

    const result = await reconcileMainIdentity(runtimeConfig(), input, dependencies);
    await reconcileMainIdentity(runtimeConfig(), { ...input, assistantDisplayName: 'Aya Renamed' }, dependencies);

    expect(result).toEqual({ agentGroupId: GROUP_ID, onecliAgentId: 'oc-main', providerSecretId: 'sec-claude' });
    expect(state.groupCreated).toBe(1);
    expect(state.agents).toHaveLength(1);
    expect(state.provider).toBe('claude');
    expect(state.grants.get('oc-main')).toEqual(['sec-claude']);
    expect(state.profileWrites).toBe(2);
  });

  it('resumes after an ambiguous grant side effect without duplicating main or its OneCLI agent', async () => {
    const { state, dependencies } = harness({ failAfterGrantOnce: true });

    await expect(reconcileMainIdentity(runtimeConfig(), input, dependencies)).rejects.toThrow(/simulated crash/i);
    await expect(reconcileMainIdentity(runtimeConfig(), input, dependencies)).resolves.toMatchObject({
      agentGroupId: GROUP_ID,
      onecliAgentId: 'oc-main',
    });

    expect(state.groupCreated).toBe(1);
    expect(state.agents).toHaveLength(1);
    expect(state.profileWrites).toBe(1);
    expect(state.grants.get('oc-main')).toEqual(['sec-claude']);
  });

  it('fails closed before publishing canonical main when the selective grant cannot be verified', async () => {
    const { state, dependencies } = harness({ neverApplyGrant: true });

    await expect(reconcileMainIdentity(runtimeConfig(), input, dependencies)).rejects.toThrow(/selective grant/i);
    expect(state.profileWrites).toBe(0);
  });

  it('rejects a pre-existing OneCLI identity collision instead of adopting it', async () => {
    const { state, dependencies } = harness();
    state.agents.push({ id: 'oc-other', identifier: 'ag-other', name: 'main', secretMode: 'selective' });

    await expect(reconcileMainIdentity(runtimeConfig(), input, dependencies)).rejects.toThrow(/collision/i);
    expect(state.profileWrites).toBe(0);
  });
});
