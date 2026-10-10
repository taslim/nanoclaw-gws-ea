import { describe, expect, it, vi } from 'vitest';

import { reconcileMainIdentity, type MainIdentityDependencies } from './identity.js';
import { createOnecliAdmin } from './onecli-admin.js';
import type { InstanceRuntimeConfig } from './service.js';

const GROUP_ID = 'ag-11111111-1111-4111-8111-111111111111';
const ADMIN_KEY = `oc_${'a'.repeat(64)}`;

function runtimeConfig(): InstanceRuntimeConfig {
  const instanceId = '11111111-1111-4111-8111-111111111111';
  const root = '/opt/gws-ea/11111111';
  const secrets = `${root}/secrets`;
  const project = `gws-ea-${instanceId.replaceAll('-', '')}`;
  return {
    schema_version: 2,
    instance_id: instanceId,
    install_id: instanceId.replaceAll('-', ''),
    instance_root: root,
    checkout_root: `${root}/nanoclaw`,
    state_root: `${root}/state`,
    node_path: '/usr/bin/node',
    home_directory: '/Users/operator',
    allocated_ports: { nanoclaw_webhook: 31_001, onecli_app: 31_002, onecli_gateway: 31_003 },
    agent_egress_network: `${project}-agent-egress`,
    onecli_project: project,
    onecli_app_url: 'http://127.0.0.1:31002',
    onecli_gateway_url: 'http://127.0.0.1:31003',
    onecli_gateway_container: `${project}-gateway-1`,
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
  /** Every `groups config update` main's reconcile ran. */
  configWriteArgs: Array<readonly string[]>;
  /** Main's container timezone as its container config holds it; null follows the install's. */
  timezone: string | null;
  profileWrites: number;
  profileWriteArgs: Array<readonly string[]>;
  /** The principal's name and timezone as the profile holds them. */
  principalDisplayName: string | null;
  principalTimezone: string | null;
  /** The principal's addresses as the profile holds them. */
  principalEmails: readonly string[];
  /** The agents OneCLI holds; one without a secret mode is as a OneCLI from 1.43 on lists it. */
  agents: Array<{ id: string; identifier: string; name: string; secretMode?: 'all' | 'selective' }>;
  secretModeWrites: number;
  /** Main's shared skills as its container config holds them. */
  skills: readonly string[] | 'all';
  /** Every ncl call, in order, by its first two words. */
  calls: string[];
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function harness(
  options: {
    failAfterSecretModeOnce?: boolean;
    neverApplySecretMode?: boolean;
    /** A NanoClaw whose config update leaves the provider as it was. */
    ignoreProvider?: boolean;
    /** A release whose main reconcile leaves main on every shared skill. */
    ignoreSkills?: boolean;
    /** OneCLI's list does not yet show main's agent, which a create then finds there (409). */
    listLagsCreate?: boolean;
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
    configWriteArgs: [],
    timezone: null,
    profileWrites: 0,
    profileWriteArgs: [],
    principalDisplayName: null,
    principalTimezone: null,
    principalEmails: [],
    agents: [],
    secretModeWrites: 0,
    skills: 'all',
    calls: [],
  };
  let failed = false;
  const runNcl = vi.fn(async (_config: InstanceRuntimeConfig, args: readonly string[]) => {
    state.calls.push(`${args[0]} ${args[1]}`);
    if (args[0] === 'gws-ea-main' && args[1] === 'reconcile') {
      if (!options.ignoreSkills) state.skills = ['agent-browser'];
      return { agent_group_id: flagValue(args, '--agent-group-id'), skills: state.skills };
    }
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
      state.configWriteArgs.push(args);
      if (!options.ignoreProvider) state.provider = flagValue(args, '--provider') ?? state.provider;
      state.timezone = flagValue(args, '--timezone') ?? state.timezone;
      return { agent_group_id: GROUP_ID, provider: state.provider, timezone: state.timezone };
    }
    if (args[0] === 'gws-ea-profile' && args[1] === 'reconcile') {
      state.profileWrites += 1;
      state.profileWriteArgs.push(args);
      state.principalDisplayName = flagValue(args, '--principal-display-name') ?? state.principalDisplayName;
      state.principalTimezone = flagValue(args, '--principal-timezone') ?? state.principalTimezone;
      const declared = flagValue(args, '--principal-emails');
      if (declared !== undefined) state.principalEmails = JSON.parse(declared) as string[];
      // As the host does: main's container runs in the timezone the profile holds.
      state.timezone = state.principalTimezone;
      return {
        main_agent_group_id: GROUP_ID,
        principal_display_name: state.principalDisplayName,
        principal_timezone: state.principalTimezone,
        principal_emails: state.principalEmails,
      };
    }
    throw new Error(`Unexpected ncl call: ${args.join(' ')}`);
  });
  let listed = !options.listLagsCreate;
  /** The instance's OneCLI app behind `fetch`, administered by the real client. */
  const onecli = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.pathname === '/v1/agents' && method === 'GET') {
      return json(listed ? state.agents : state.agents.filter((agent) => agent.identifier !== GROUP_ID));
    }
    if (url.pathname === '/v1/agents' && method === 'POST') {
      listed = true;
      if (state.agents.some((agent) => agent.identifier === body.identifier)) {
        return json({ error: 'An agent with this identifier already exists' }, 409);
      }
      const agent = { id: 'oc-main', identifier: GROUP_ID, name: 'main', secretMode: 'all' as const };
      state.agents.push(agent);
      return json(agent, 201);
    }
    if (url.pathname === '/v1/agents/oc-main/secret-mode' && method === 'PATCH' && body.mode === 'all') {
      state.secretModeWrites += 1;
      if (!options.neverApplySecretMode) {
        state.agents = state.agents.map((agent) =>
          agent.id === 'oc-main' ? { ...agent, secretMode: 'all' as const } : agent,
        );
      }
      if (options.failAfterSecretModeOnce && !failed) {
        failed = true;
        throw new TypeError('fetch failed: connection reset after the secret-mode side effect');
      }
      return json({ success: true });
    }
    throw new Error(`Unexpected OneCLI call: ${method} ${url.pathname} ${JSON.stringify(body)}`);
  });
  const onecliAdmin = async (config: InstanceRuntimeConfig) =>
    createOnecliAdmin(config.onecli_app_url, ADMIN_KEY, { fetch: onecli as unknown as typeof globalThis.fetch });
  return { state, dependencies: { runNcl, onecliAdmin } };
}

/** Main once it is published: the profile holds the principal, and a reconcile names none. */
const input = {
  assistantDisplayName: 'Aya',
  assistantWorkspaceEmail: 'aya@example.test',
};

/** Who the principal is, as create declared them. */
const seed = { displayName: 'Morgan', timezone: 'America/Los_Angeles', emails: ['morgan@example.test'] };

/** Main's first publication, which seeds the profile with the principal. */
const create = { ...input, principal: seed };

describe('main identity reconciliation', () => {
  it('rejects invalid profile input before mutating NanoClaw or OneCLI', async () => {
    const { state, dependencies } = harness();

    await expect(
      reconcileMainIdentity(
        runtimeConfig(),
        { ...input, assistantWorkspaceEmail: 'not-an-email', principal: { ...seed, timezone: 'Not/A-Timezone' } },
        dependencies,
      ),
    ).rejects.toThrow(/email/i);

    expect(state).toMatchObject({ groupCreated: 0, provider: null, profileWrites: 0, agents: [] });
  });

  it('stamps one main group, selects its provider, verifies all secret mode, then publishes the profile', async () => {
    const { state, dependencies } = harness();

    const result = await reconcileMainIdentity(runtimeConfig(), create, dependencies);
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
    await reconcileMainIdentity(runtimeConfig(), create, dependencies);
    state.persona = 'edited by the principal';

    // A resume that finds the profile different repairs the identity.
    const repaired = await reconcileMainIdentity(
      runtimeConfig(),
      { ...input, assistantDisplayName: 'Aya Renamed' },
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
    await reconcileMainIdentity(runtimeConfig(), create, dependencies);
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

    await expect(reconcileMainIdentity(runtimeConfig(), create, dependencies)).rejects.toMatchObject({
      code: 'onecli_request_failed',
    });
    await expect(reconcileMainIdentity(runtimeConfig(), create, dependencies)).resolves.toMatchObject({
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

  it("creates main's agent when OneCLI's list does not show it, reading it from the list when the create answers 409", async () => {
    const { state, dependencies } = harness({ listLagsCreate: true });
    state.agents.push({ id: 'oc-main', identifier: GROUP_ID, name: 'main', secretMode: 'all' });

    await expect(reconcileMainIdentity(runtimeConfig(), create, dependencies)).resolves.toEqual({
      agentGroupId: GROUP_ID,
      onecliAgentId: 'oc-main',
    });
    expect(state.agents).toHaveLength(1);
    expect(state.profileWrites).toBe(1);
  });

  it("reads main's agent without a secret mode as all, OneCLI's default, and leaves it", async () => {
    const { state, dependencies } = harness();
    state.agents.push({ id: 'oc-main', identifier: GROUP_ID, name: 'main' });

    await expect(reconcileMainIdentity(runtimeConfig(), create, dependencies)).resolves.toMatchObject({
      onecliAgentId: 'oc-main',
    });
    expect(state.secretModeWrites).toBe(0);
    expect(state.profileWrites).toBe(1);
  });

  it('fails closed before publishing canonical main when all secret mode cannot be verified', async () => {
    const { state, dependencies } = harness({ neverApplySecretMode: true });
    state.agents.push({ id: 'oc-main', identifier: GROUP_ID, name: 'main', secretMode: 'selective' });

    await expect(reconcileMainIdentity(runtimeConfig(), create, dependencies)).rejects.toThrow(/all secret mode/i);
    expect(state.profileWrites).toBe(0);
  });

  it('rejects a pre-existing OneCLI identity collision instead of adopting it', async () => {
    const { state, dependencies } = harness();
    state.agents.push({ id: 'oc-other', identifier: 'ag-other', name: 'main', secretMode: 'selective' });

    await expect(reconcileMainIdentity(runtimeConfig(), create, dependencies)).rejects.toThrow(/collision/i);
    expect(state.profileWrites).toBe(0);
  });

  it("seeds the profile with the principal's name, timezone and addresses when it first publishes main", async () => {
    const { state, dependencies } = harness();

    await reconcileMainIdentity(
      runtimeConfig(),
      { ...input, principal: { ...seed, timezone: 'Africa/Lagos' } },
      dependencies,
    );

    const [published] = state.profileWriteArgs;
    expect(flagValue(published!, '--principal-display-name')).toBe('Morgan');
    expect(flagValue(published!, '--principal-timezone')).toBe('Africa/Lagos');
    expect(flagValue(published!, '--principal-emails')).toBe(JSON.stringify(['morgan@example.test']));
  });

  it("writes none of the principal's profile once main is published, and leaves main's container timezone to the host", async () => {
    const { state, dependencies } = harness();
    await reconcileMainIdentity(runtimeConfig(), create, dependencies);
    // The principal changed their name and timezone through main since.
    state.principalDisplayName = 'Juno Hale';
    state.principalTimezone = 'Europe/London';
    state.timezone = 'Europe/London';

    await reconcileMainIdentity(runtimeConfig(), input, dependencies);

    const updated = state.profileWriteArgs.at(-1)!;
    for (const flag of ['--principal-display-name', '--principal-timezone', '--principal-emails']) {
      expect(updated, flag).not.toContain(flag);
    }
    expect(state).toMatchObject({
      principalDisplayName: 'Juno Hale',
      principalTimezone: 'Europe/London',
      timezone: 'Europe/London',
    });
    // The host derives main's container timezone from the profile; the control plane never sets it.
    expect(state.configWriteArgs).toHaveLength(2);
    for (const args of state.configWriteArgs) expect(args).not.toContain('--timezone');
  });

  it("fails before publishing the profile when main's provider does not persist", async () => {
    const { state, dependencies } = harness({ ignoreProvider: true });

    await expect(reconcileMainIdentity(runtimeConfig(), create, dependencies)).rejects.toThrow(/did not persist/i);
    expect(state.profileWrites).toBe(0);
  });

  it("gives main the release's skills before the profile publishes it", async () => {
    const { state, dependencies } = harness();

    await reconcileMainIdentity(runtimeConfig(), create, dependencies);

    expect(state.skills).toEqual(['agent-browser']);
    expect(state.calls.indexOf('gws-ea-main reconcile')).toBeGreaterThan(state.calls.indexOf('groups create'));
    expect(state.calls.indexOf('gws-ea-main reconcile')).toBeLessThan(state.calls.indexOf('gws-ea-profile reconcile'));
  });

  it("fails before publishing the profile when main's skills stay NanoClaw's full set", async () => {
    const { state, dependencies } = harness({ ignoreSkills: true });

    await expect(reconcileMainIdentity(runtimeConfig(), create, dependencies)).rejects.toThrow(/skills/i);
    expect(state.profileWrites).toBe(0);
  });

  it("publishes the principal's declared addresses with the profile, lowercased and each once", async () => {
    const { state, dependencies } = harness();

    await reconcileMainIdentity(
      runtimeConfig(),
      {
        ...input,
        principal: { ...seed, emails: ['Morgan@Example.test', 'morgan@work.example.test', 'morgan@example.test'] },
      },
      dependencies,
    );

    expect(flagValue(state.profileWriteArgs[0]!, '--principal-emails')).toBe(
      JSON.stringify(['morgan@example.test', 'morgan@work.example.test']),
    );
    expect(state.principalEmails).toEqual(['morgan@example.test', 'morgan@work.example.test']);
  });

  it("leaves the principal's addresses to the profile when a reconcile declares no principal", async () => {
    const { state, dependencies } = harness();
    state.principalEmails = ['added-by-the-principal@example.test'];

    await reconcileMainIdentity(runtimeConfig(), input, dependencies);

    expect(state.profileWriteArgs[0]).not.toContain('--principal-emails');
    expect(state.principalEmails).toEqual(['added-by-the-principal@example.test']);
  });

  it.each([
    ['a malformed address', ['morgan@example.test', 'not-an-email']],
    ['no address', []],
    ["the assistant's own address", ['morgan@example.test', 'AYA@example.test']],
    ["a plus-addressed spelling of the assistant's own", ['morgan@example.test', 'aya+x@example.test']],
    ['two spellings of one Gmail address', ['morganellery@gmail.com', 'Morgan.Ellery@gmail.com']],
  ])('rejects principal addresses with %s before mutating NanoClaw or OneCLI', async (_case, principalEmails) => {
    const { state, dependencies } = harness();

    await expect(
      reconcileMainIdentity(
        runtimeConfig(),
        { ...input, principal: { ...seed, emails: principalEmails } },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
    expect(state).toMatchObject({ groupCreated: 0, provider: null, timezone: null, profileWrites: 0, agents: [] });
  });

  it("names the conflict: a dotted spelling of the assistant's Gmail, or the listed spelling another repeats", async () => {
    const { dependencies } = harness();
    const gmailAssistant = { ...input, assistantWorkspaceEmail: 'ayaassistant@gmail.com' };

    await expect(
      reconcileMainIdentity(
        runtimeConfig(),
        { ...gmailAssistant, principal: { ...seed, emails: ['Aya.Assistant@gmail.com'] } },
        dependencies,
      ),
    ).rejects.toMatchObject({
      code: 'invalid_identity',
      message: "aya.assistant@gmail.com is the assistant's own address, not one of the principal's",
    });
    await expect(
      reconcileMainIdentity(
        runtimeConfig(),
        { ...input, principal: { ...seed, emails: ['morganellery@gmail.com', 'Morgan.Ellery@gmail.com'] } },
        dependencies,
      ),
    ).rejects.toMatchObject({
      message:
        "morgan.ellery@gmail.com is another spelling of morganellery@gmail.com, already one of the principal's addresses",
    });
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

    await expect(reconcileMainIdentity(runtimeConfig(), create, forgetful)).rejects.toMatchObject({
      code: 'profile_mismatch',
    });
  });
});
