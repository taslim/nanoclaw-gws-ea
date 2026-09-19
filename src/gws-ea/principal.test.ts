import { describe, expect, it, vi } from 'vitest';

import { reconcilePrincipalDm, type PrincipalDiscoveryDependencies } from './principal.js';
import type { InstanceRuntimeConfig } from './service.js';

const STARTED_AT = '2026-09-18T18:00:00.000Z';

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
    gchat_bot_user_id: 'users/123',
    secret_files: {
      gchat_credentials: `${checkout}/data/gws-ea/secrets/gchat-service-account.json`,
      onecli_runtime_api_key: `${checkout}/data/gws-ea/secrets/onecli-runtime-api-key`,
      onecli_admin_api_key: `${checkout}/data/gws-ea/secrets/onecli-admin-api-key`,
    },
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel_type: 'gchat',
    platform_id: 'gchat:spaces/dm-1',
    instance: 'gchat-assistant',
    user_id: 'gchat:users/1',
    sender_name: 'Taslim',
    sender_authenticated: 1,
    sender_kind: 'human',
    is_group: 0,
    authenticated_message_id: 'spaces/dm-1/messages/1',
    authenticated_message_at: '2026-09-18T18:01:00.000Z',
    reason: 'no_agent_wired',
    messaging_group_id: 'mg-1',
    ...overrides,
  };
}

function harness(
  rows: readonly unknown[],
  mainAgentGroupId: string | null = 'ag-main',
): {
  order: string[];
  dependencies: PrincipalDiscoveryDependencies;
  runNcl: ReturnType<typeof vi.fn>;
  runBootstrap: ReturnType<typeof vi.fn>;
} {
  const order: string[] = [];
  const runNcl = vi.fn(async (_config: InstanceRuntimeConfig, args: readonly string[]) => {
    const operation = `${args[0]} ${args[1]}`;
    if (operation === 'gws-ea-profile get') {
      return {
        main_agent_group_id: mainAgentGroupId,
        principal_display_name: 'Taslim',
      };
    }
    if (operation === 'dropped-messages list') return rows;
    if (operation === 'gws-ea-profile bind-principal') {
      order.push('bind');
      return {
        user_id: args[args.indexOf('--user-id') + 1],
        verified_at: args[args.indexOf('--verified-at') + 1],
      };
    }
    throw new Error(`Unexpected ncl call: ${args.join(' ')}`);
  });
  const runBootstrap = vi.fn(async () => {
    order.push('bootstrap');
  });
  return { order, dependencies: { runNcl, runBootstrap }, runNcl, runBootstrap };
}

describe('verified principal first-DM reconciliation', () => {
  it('requires canonical main to be published before reading or binding candidates', async () => {
    const h = harness([row()], null);
    await expect(
      reconcilePrincipalDm(
        runtimeConfig(),
        { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT },
        h.dependencies,
      ),
    ).rejects.toThrow(/canonical main/i);
    expect(h.runNcl).toHaveBeenCalledTimes(1);
    expect(h.runBootstrap).not.toHaveBeenCalled();
  });

  it('waits with zero candidates and requires exact selection with multiple candidates', async () => {
    const empty = harness([]);
    await expect(
      reconcilePrincipalDm(
        runtimeConfig(),
        { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT },
        empty.dependencies,
      ),
    ).resolves.toEqual({ status: 'waiting' });

    const multiple = harness([
      row(),
      row({ messaging_group_id: 'mg-2', platform_id: 'gchat:spaces/dm-2', user_id: 'gchat:users/2' }),
    ]);
    const result = await reconcilePrincipalDm(
      runtimeConfig(),
      { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT },
      multiple.dependencies,
    );
    expect(result).toMatchObject({
      status: 'selection-required',
      candidates: [{ messagingGroupId: 'mg-1' }, { messagingGroupId: 'mg-2' }],
    });
    expect(multiple.order).toEqual([]);

    await expect(
      reconcilePrincipalDm(
        runtimeConfig(),
        {
          adapterInstance: 'gchat-assistant',
          provisioningStartedAt: STARTED_AT,
          messagingGroupId: 'mg-not-present',
        },
        multiple.dependencies,
      ),
    ).rejects.toThrow(/not eligible/i);
  });

  it('filters group, bot, wrong-instance, stale, unverified, and malformed transport evidence', async () => {
    const h = harness([
      row({ messaging_group_id: 'mg-group', is_group: 1 }),
      row({ messaging_group_id: 'mg-bot', sender_kind: 'bot' }),
      row({ messaging_group_id: 'mg-wrong-instance', instance: 'gchat-other' }),
      row({ messaging_group_id: 'mg-stale', authenticated_message_at: '2026-09-18T17:59:59.999Z' }),
      row({ messaging_group_id: 'mg-unverified', sender_authenticated: 0 }),
      row({ messaging_group_id: 'mg-content-only', authenticated_message_id: null }),
      row({ messaging_group_id: 'mg-malformed-time', authenticated_message_at: '2026-09-18 18:01:00' }),
      row(),
    ]);
    const result = await reconcilePrincipalDm(
      runtimeConfig(),
      { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT },
      h.dependencies,
    );
    expect(result).toMatchObject({ status: 'bound', candidate: { messagingGroupId: 'mg-1' } });
    expect(h.order).toEqual(['bind', 'bootstrap']);
  });

  it('binds before exact-checkout bootstrap and reuses one deterministic event ID', async () => {
    const h = harness([row()]);
    const input = { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT } as const;
    const first = await reconcilePrincipalDm(runtimeConfig(), input, h.dependencies);
    const second = await reconcilePrincipalDm(runtimeConfig(), input, h.dependencies);
    expect(first).toEqual(second);
    expect(h.order).toEqual(['bind', 'bootstrap', 'bind', 'bootstrap']);
    const args = h.runBootstrap.mock.calls[0]?.[1] as readonly string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '--verified-principal',
        '--agent-group-id',
        'ag-main',
        '--sender-scope',
        'known',
        '--session-mode',
        'agent-shared',
        '--event-id',
        (first as { eventId: string }).eventId,
      ]),
    );
  });

  it('uses the latest authenticated event when a second DM arrives after a binding crash', async () => {
    const first = row();
    const second = row({
      authenticated_message_id: 'spaces/dm-1/messages/2',
      authenticated_message_at: '2026-09-18T18:02:00.000Z',
    });
    const h = harness([first, second]);

    const result = await reconcilePrincipalDm(
      runtimeConfig(),
      { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT },
      h.dependencies,
    );

    expect(result).toMatchObject({
      status: 'bound',
      candidate: {
        messagingGroupId: 'mg-1',
        authenticatedMessageId: 'spaces/dm-1/messages/2',
        authenticatedMessageAt: '2026-09-18T18:02:00.000Z',
      },
    });
    const bindArgs = h.runNcl.mock.calls.find((call) => call[1][1] === 'bind-principal')?.[1] as readonly string[];
    expect(bindArgs[bindArgs.indexOf('--verified-at') + 1]).toBe('2026-09-18T18:02:00.000Z');
    expect(h.runBootstrap).toHaveBeenCalledTimes(1);
  });

  it('executes the checked-out bootstrap script with the allowlisted instance environment', async () => {
    const h = harness([row()]);
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await reconcilePrincipalDm(
      runtimeConfig(),
      { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT },
      { runNcl: h.dependencies.runNcl, runCommand },
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/usr/bin/node',
        cwd: '/opt/gws-ea/instances/one/nanoclaw',
        args: expect.arrayContaining([
          '/opt/gws-ea/instances/one/nanoclaw/scripts/init-first-agent.ts',
          '--verified-principal',
        ]),
        env: expect.objectContaining({ NANOCLAW_INSTALL_ID: runtimeConfig().install_id }),
      }),
    );
  });
});
