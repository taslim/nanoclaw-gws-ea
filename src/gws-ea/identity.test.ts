import { describe, expect, it, vi } from 'vitest';

import { reconcileMainIdentity, type MainIdentityDependencies } from './identity.js';
import type { InstanceRuntimeConfig } from './service.js';

const GROUP_ID = 'ag-11111111-1111-4111-8111-111111111111';

function runtimeConfig(): InstanceRuntimeConfig {
  const instanceId = '11111111-1111-4111-8111-111111111111';
  const checkout = '/opt/gws-ea/instances/one/nanoclaw';
  const secrets = '/opt/gws-ea/instances/one/secrets';
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
    docker_endpoint: 'unix:///var/run/docker.sock',
    secret_files: {
      gchat_credentials: `${secrets}/gchat-service-account.json`,
      onecli_runtime_api_key: `${secrets}/onecli-runtime-api-key`,
      onecli_admin_api_key: `${secrets}/onecli-admin-api-key`,
    },
  };
}

interface FakeState {
  groupCreated: number;
  /** Main's persona as NanoClaw holds it: stamped from the template, or edited since. */
  persona: string;
  groupCreateArgs: Array<readonly string[]>;
  provider: string | null;
  /** Main's container timezone as its container config holds it; null follows the install's. */
  timezone: string | null;
  profileWrites: number;
  profileWriteArgs: Array<readonly string[]>;
  /** The principal's addresses as the profile holds them. */
  principalEmails: readonly string[];
  agents: Array<{ id: string; identifier: string; name: string; secretMode: 'all' | 'selective' }>;
  secretModeWrites: number;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function harness(
  options: {
    failAfterSecretModeOnce?: boolean;
    neverApplySecretMode?: boolean;
    /** A NanoClaw whose config update leaves the timezone as it was. */
    ignoreTimezone?: boolean;
  } = {},
): {
  state: FakeState;
  dependencies: MainIdentityDependencies;
} {
  const state: FakeState = {
    groupCreated: 0,
    persona: 'stamped from the template',
    groupCreateArgs: [],
    provider: null,
    timezone: null,
    profileWrites: 0,
    profileWriteArgs: [],
    principalEmails: [],
    agents: [],
    secretModeWrites: 0,
  };
  let failed = false;
  const runNcl = vi.fn(async (_config: InstanceRuntimeConfig, args: readonly string[]) => {
    if (args[0] === 'groups' && args[1] === 'create') {
      state.groupCreateArgs.push(args);
      const group = { id: GROUP_ID, name: 'main', folder: 'main', agent_provider: null, created_at: 'now' };
      if (state.groupCreated === 0) {
        state.groupCreated += 1;
        return group;
      }
      // As NanoClaw does: a group already carrying the plugin is restamped with --yes, and only planned without.
      const apply = args.includes('--yes');
      const customized = state.persona !== 'stamped from the template';
      if (apply) state.persona = 'stamped from the template';
      const changes = customized
        ? [{ surface: 'persona', name: 'instructions.prepend.md', action: 'update', customized }]
        : [];
      return { group, plugin: 'gws-ea-main', applied: apply, changes, report: [], note: apply ? 'applied' : 'DRY RUN' };
    }
    if (args[0] === 'groups' && args[1] === 'config') {
      state.provider = flagValue(args, '--provider') ?? state.provider;
      if (!options.ignoreTimezone) state.timezone = flagValue(args, '--timezone') ?? state.timezone;
      return { agent_group_id: GROUP_ID, provider: state.provider, timezone: state.timezone };
    }
    if (args[0] === 'gws-ea-profile' && args[1] === 'reconcile') {
      state.profileWrites += 1;
      state.profileWriteArgs.push(args);
      const declared = flagValue(args, '--principal-emails');
      if (declared !== undefined) state.principalEmails = JSON.parse(declared) as string[];
      return {
        main_agent_group_id: GROUP_ID,
        principal_timezone: flagValue(args, '--principal-timezone'),
        principal_emails: state.principalEmails,
      };
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
    if (args[0] === 'agents' && args[1] === 'set-secret-mode') {
      if (args[args.indexOf('--id') + 1] !== 'oc-main' || args[args.indexOf('--mode') + 1] !== 'all') {
        throw new Error(`Unexpected OneCLI secret-mode update: ${args.join(' ')}`);
      }
      state.secretModeWrites += 1;
      if (!options.neverApplySecretMode) {
        state.agents = state.agents.map((agent) =>
          agent.id === 'oc-main' ? { ...agent, secretMode: 'all' as const } : agent,
        );
      }
      if (options.failAfterSecretModeOnce && !failed) {
        failed = true;
        throw new Error('simulated crash after secret-mode side effect');
      }
      return { status: 'updated' };
    }
    throw new Error(`Unexpected OneCLI call: ${args.join(' ')}`);
  });
  return { state, dependencies: { runNcl, runOnecliAdmin } };
}

const input = {
  assistantDisplayName: 'Aya',
  assistantWorkspaceEmail: 'aya@example.test',
  principalDisplayName: 'Taslim',
  principalTimezone: 'America/Los_Angeles',
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

  it('stamps one main group, selects its provider, verifies all secret mode, then publishes the profile', async () => {
    const { state, dependencies } = harness();

    const result = await reconcileMainIdentity(runtimeConfig(), input, dependencies);
    await reconcileMainIdentity(runtimeConfig(), { ...input, assistantDisplayName: 'Aya Renamed' }, dependencies);

    expect(result).toEqual({ agentGroupId: GROUP_ID, onecliAgentId: 'oc-main' });
    expect(state.groupCreated).toBe(1);
    expect(state.agents).toHaveLength(1);
    expect(state.provider).toBe('claude');
    expect(state.secretModeWrites).toBe(0);
    expect(state.profileWrites).toBe(2);
  });

  it('never restamps an existing main, so repairing a changed profile keeps its edited persona', async () => {
    const { state, dependencies } = harness();
    await reconcileMainIdentity(runtimeConfig(), input, dependencies);
    state.persona = 'edited by the principal';

    // A resume that finds the profile different repairs the identity.
    const repaired = await reconcileMainIdentity(
      runtimeConfig(),
      { ...input, principalTimezone: 'Europe/London' },
      dependencies,
    );

    expect(repaired.agentGroupId).toBe(GROUP_ID);
    expect(state.persona).toBe('edited by the principal');
    expect(state.groupCreated).toBe(1);
    expect(state.groupCreateArgs).toEqual([
      ['groups', 'create', '--template', 'gws-ea/main', '--name', 'main'],
      ['groups', 'create', '--template', 'gws-ea/main', '--name', 'main'],
    ]);
    expect(state.profileWrites).toBe(2);
  });

  it('refuses an answer that says the existing main was restamped', async () => {
    const { state, dependencies } = harness();
    await reconcileMainIdentity(runtimeConfig(), input, dependencies);
    const runNcl = dependencies.runNcl!;
    const restamping: MainIdentityDependencies = {
      ...dependencies,
      runNcl: (config, args) => runNcl(config, args[1] === 'create' ? [...args, '--yes'] : args),
    };

    await expect(reconcileMainIdentity(runtimeConfig(), input, restamping)).rejects.toThrow(/existing main group/u);
    expect(state.profileWrites).toBe(1);
  });

  it('resumes after an ambiguous all-mode side effect without duplicating main or its OneCLI agent', async () => {
    const { state, dependencies } = harness({ failAfterSecretModeOnce: true });
    state.agents.push({ id: 'oc-main', identifier: GROUP_ID, name: 'main', secretMode: 'selective' });
    state.agents.push({ id: 'oc-other', identifier: 'ag-other', name: 'other', secretMode: 'selective' });

    await expect(reconcileMainIdentity(runtimeConfig(), input, dependencies)).rejects.toThrow(
      /secret-mode side effect/i,
    );
    await expect(reconcileMainIdentity(runtimeConfig(), input, dependencies)).resolves.toMatchObject({
      agentGroupId: GROUP_ID,
      onecliAgentId: 'oc-main',
    });

    expect(state.groupCreated).toBe(1);
    expect(state.agents).toHaveLength(2);
    expect(state.profileWrites).toBe(1);
    expect(state.agents).toContainEqual({ id: 'oc-main', identifier: GROUP_ID, name: 'main', secretMode: 'all' });
    expect(state.agents).toContainEqual({
      id: 'oc-other',
      identifier: 'ag-other',
      name: 'other',
      secretMode: 'selective',
    });
    expect(state.secretModeWrites).toBe(1);
  });

  it('fails closed before publishing canonical main when all secret mode cannot be verified', async () => {
    const { state, dependencies } = harness({ neverApplySecretMode: true });
    state.agents.push({ id: 'oc-main', identifier: GROUP_ID, name: 'main', secretMode: 'selective' });

    await expect(reconcileMainIdentity(runtimeConfig(), input, dependencies)).rejects.toThrow(/all secret mode/i);
    expect(state.profileWrites).toBe(0);
  });

  it('rejects a pre-existing OneCLI identity collision instead of adopting it', async () => {
    const { state, dependencies } = harness();
    state.agents.push({ id: 'oc-other', identifier: 'ag-other', name: 'main', secretMode: 'selective' });

    await expect(reconcileMainIdentity(runtimeConfig(), input, dependencies)).rejects.toThrow(/collision/i);
    expect(state.profileWrites).toBe(0);
  });

  it("sets main's container timezone to the profile's, and changes it when the profile changes", async () => {
    const { state, dependencies } = harness();

    await reconcileMainIdentity(runtimeConfig(), { ...input, principalTimezone: 'Africa/Lagos' }, dependencies);
    expect(state.timezone).toBe('Africa/Lagos');
    expect(flagValue(state.profileWriteArgs.at(-1)!, '--principal-timezone')).toBe('Africa/Lagos');

    await reconcileMainIdentity(runtimeConfig(), { ...input, principalTimezone: 'America/New_York' }, dependencies);
    expect(state.timezone).toBe('America/New_York');
    expect(flagValue(state.profileWriteArgs.at(-1)!, '--principal-timezone')).toBe('America/New_York');
  });

  it("fails before publishing the profile when main's container timezone does not persist", async () => {
    const { state, dependencies } = harness({ ignoreTimezone: true });

    await expect(reconcileMainIdentity(runtimeConfig(), input, dependencies)).rejects.toThrow(/did not persist/i);
    expect(state.profileWrites).toBe(0);
  });

  it("publishes the principal's declared addresses with the profile, lowercased and each once", async () => {
    const { state, dependencies } = harness();

    await reconcileMainIdentity(
      runtimeConfig(),
      { ...input, principalEmails: ['Taslim@Example.test', 'taslim@work.example.test', 'taslim@example.test'] },
      dependencies,
    );

    expect(flagValue(state.profileWriteArgs[0]!, '--principal-emails')).toBe(
      JSON.stringify(['taslim@example.test', 'taslim@work.example.test']),
    );
    expect(state.principalEmails).toEqual(['taslim@example.test', 'taslim@work.example.test']);
  });

  it("leaves the principal's addresses to the profile when a reconcile declares none", async () => {
    const { state, dependencies } = harness();
    state.principalEmails = ['added-by-the-principal@example.test'];

    await reconcileMainIdentity(runtimeConfig(), input, dependencies);

    expect(state.profileWriteArgs[0]).not.toContain('--principal-emails');
    expect(state.principalEmails).toEqual(['added-by-the-principal@example.test']);
  });

  it.each([
    ['a malformed address', ['taslim@example.test', 'not-an-email']],
    ['no address', []],
    ["the assistant's own address", ['taslim@example.test', 'AYA@example.test']],
  ])('rejects principal addresses with %s before mutating NanoClaw or OneCLI', async (_case, principalEmails) => {
    const { state, dependencies } = harness();

    await expect(
      reconcileMainIdentity(runtimeConfig(), { ...input, principalEmails }, dependencies),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
    expect(state).toMatchObject({ groupCreated: 0, provider: null, timezone: null, profileWrites: 0, agents: [] });
  });

  it("fails when the profile does not hold the principal's declared addresses", async () => {
    const { dependencies } = harness();
    const runNcl = dependencies.runNcl!;
    const forgetful: MainIdentityDependencies = {
      ...dependencies,
      runNcl: async (config, args) => {
        const result = await runNcl(config, args);
        return args[0] === 'gws-ea-profile' ? { main_agent_group_id: GROUP_ID, principal_emails: [] } : result;
      },
    };

    await expect(
      reconcileMainIdentity(runtimeConfig(), { ...input, principalEmails: ['taslim@example.test'] }, forgetful),
    ).rejects.toMatchObject({ code: 'profile_mismatch' });
  });
});
