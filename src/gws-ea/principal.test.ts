import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../channels/adapter.js';
import { CONTROL_PLANE_ROOT } from './paths.js';
import {
  principalWelcomeEventId,
  reconcilePrincipalDm,
  type PrincipalCandidate,
  type PrincipalDiscoveryDependencies,
} from './principal.js';
import type { InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { verifyPrincipalBinding } from './verify.js';

// Waking main starts its container; these tests stop at the session's inbound queue.
vi.mock('../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

const STARTED_AT = '2026-09-18T18:00:00.000Z';
/** Binding order: bind, then the host's records and main's DM wiring, then the welcome. */
const BIND_ORDER = ['user', 'bind', 'role:owner', 'member', 'wiring', 'bootstrap'] as const;

function runtimeConfig(overrides: Partial<InstanceRuntimeConfig> = {}): InstanceRuntimeConfig {
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
    ...overrides,
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
    const flag = (name: string) => args[args.indexOf(name) + 1];
    if (operation === 'users create') {
      order.push('user');
      return { id: flag('--id'), kind: flag('--kind') };
    }
    if (operation === 'gws-ea-profile bind-principal') {
      order.push('bind');
      return {
        user_id: flag('--user-id'),
        verified_at: flag('--verified-at'),
        messaging_group_id: flag('--messaging-group-id'),
      };
    }
    if (operation === 'roles grant') {
      order.push(`role:${flag('--role')}`);
      return { user_id: flag('--user'), role: flag('--role'), agent_group_id: null };
    }
    if (operation === 'members add') {
      order.push('member');
      return { user_id: flag('--user'), agent_group_id: flag('--group') };
    }
    if (operation === 'wirings create') {
      order.push('wiring');
      return {
        messaging_group_id: flag('--messaging-group-id'),
        agent_group_id: flag('--agent-group-id'),
        sender_scope: flag('--sender-scope'),
        session_mode: flag('--session-mode'),
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

  it('waits with zero candidates, persists and binds one, and requires exact selection with multiple', async () => {
    const empty = harness([]);
    await expect(
      reconcilePrincipalDm(
        runtimeConfig(),
        { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT },
        empty.dependencies,
      ),
    ).resolves.toEqual({ status: 'waiting' });

    const sole = harness([row()]);
    const persistSelection = vi.fn(
      async (candidate: Parameters<NonNullable<PrincipalDiscoveryDependencies['persistSelection']>>[0]) => {
        sole.order.push('persist');
        return candidate;
      },
    );
    await expect(
      reconcilePrincipalDm(
        runtimeConfig(),
        { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT },
        { ...sole.dependencies, persistSelection },
      ),
    ).resolves.toMatchObject({ status: 'bound', candidate: { userId: 'gchat:users/1' } });
    expect(persistSelection).toHaveBeenCalledWith(expect.objectContaining({ messagingGroupId: 'mg-1' }));
    expect(sole.order).toEqual(['persist', ...BIND_ORDER]);

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
      { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT, messagingGroupId: 'mg-1' },
      h.dependencies,
    );
    expect(result).toMatchObject({ status: 'bound', candidate: { messagingGroupId: 'mg-1' } });
    expect(h.order).toEqual(BIND_ORDER);
  });

  it('binds, then makes the host records and wiring, then bootstraps with one deterministic event ID', async () => {
    const h = harness([row()]);
    const dependencies = {
      ...h.dependencies,
      persistSelection: async (
        candidate: Parameters<NonNullable<PrincipalDiscoveryDependencies['persistSelection']>>[0],
      ) => {
        h.order.push('persist');
        return candidate;
      },
    };
    const input = {
      adapterInstance: 'gchat-assistant',
      provisioningStartedAt: STARTED_AT,
      messagingGroupId: 'mg-1',
    } as const;
    const first = await reconcilePrincipalDm(runtimeConfig(), input, dependencies);
    const second = await reconcilePrincipalDm(runtimeConfig(), input, dependencies);
    expect(first).toEqual(second);
    expect(h.order).toEqual(['persist', ...BIND_ORDER, 'persist', ...BIND_ORDER]);
    const wiring = h.runNcl.mock.calls.find((call) => call[1][0] === 'wirings')?.[1] as readonly string[];
    expect(wiring).toEqual([
      'wirings',
      'create',
      '--messaging-group-id',
      'mg-1',
      '--agent-group-id',
      'ag-main',
      '--sender-scope',
      'known',
      '--session-mode',
      'agent-shared',
    ]);
    expect(h.runBootstrap.mock.calls[0]?.[1]).toEqual([
      '--channel',
      'gchat',
      '--user-id',
      'gchat:users/1',
      '--platform-id',
      'gchat:spaces/dm-1',
      '--display-name',
      'Taslim',
      '--agent-group-id',
      'ag-main',
      '--role',
      'owner',
      '--instance',
      'gchat-assistant',
      '--event-id',
      (first as { eventId: string }).eventId,
    ]);
  });

  it('fails without bootstrapping when the host does not confirm the principal wiring', async () => {
    const h = harness([row()]);
    const hostNcl = h.dependencies.runNcl!;
    const runNcl = async (config: InstanceRuntimeConfig, args: readonly string[]): Promise<unknown> =>
      args[0] === 'wirings'
        ? { messaging_group_id: 'mg-1', agent_group_id: 'ag-main', sender_scope: 'all', session_mode: 'shared' }
        : hostNcl(config, args);
    await expect(
      reconcilePrincipalDm(
        runtimeConfig(),
        { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT, messagingGroupId: 'mg-1' },
        { ...h.dependencies, runNcl },
      ),
    ).rejects.toThrow(/wiring was not confirmed/);
    expect(h.runBootstrap).not.toHaveBeenCalled();
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
      { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT, messagingGroupId: 'mg-1' },
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

  it('keeps one welcome identity when later messages replace discovery evidence', () => {
    const first = {
      messagingGroupId: 'mg-1',
      platformId: 'gchat:spaces/dm-1',
      userId: 'gchat:users/1',
      senderName: 'Taslim',
      authenticatedMessageId: 'spaces/dm-1/messages/1',
      authenticatedMessageAt: '2026-09-18T18:01:00.000Z',
    };
    expect(
      principalWelcomeEventId(runtimeConfig(), 'ag-main', {
        ...first,
        authenticatedMessageId: 'spaces/dm-1/messages/2',
        authenticatedMessageAt: '2026-09-18T18:02:00.000Z',
      }),
    ).toBe(principalWelcomeEventId(runtimeConfig(), 'ag-main', first));
  });

  it('executes the checked-out bootstrap script with the allowlisted instance environment', async () => {
    const h = harness([row()]);
    const runCommand = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await reconcilePrincipalDm(
      runtimeConfig(),
      { adapterInstance: 'gchat-assistant', provisioningStartedAt: STARTED_AT, messagingGroupId: 'mg-1' },
      { runNcl: h.dependencies.runNcl, runCommand },
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/usr/bin/node',
        cwd: '/opt/gws-ea/instances/one/nanoclaw',
        args: expect.arrayContaining(['/opt/gws-ea/instances/one/nanoclaw/scripts/init-first-agent.ts', '--event-id']),
        env: expect.objectContaining({ NANOCLAW_INSTALL_ID: runtimeConfig().install_id }),
      }),
    );
  });
});

/**
 * The binding on real NanoClaw code: the principal's DM is routed by
 * the router into a checkout's central DB built by core migrations, every
 * `ncl` call goes through the host's dispatch, and the checkout's own
 * `scripts/init-first-agent.ts` runs as a child process and hands its welcome
 * to the host's CLI socket.
 */
describe('verified principal binding on a real instance', () => {
  const originalCwd = process.cwd();
  const cleanups: Array<() => Promise<void>> = [];
  const PLATFORM = 'gchat:spaces/principal-dm';
  const USER = 'gchat:users/principal';

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    process.chdir(originalCwd);
  });

  /** A checkout whose host is running: the host's composition, its CLI socket, and canonical main. */
  async function runningInstance() {
    const checkout = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-bind-')));
    cleanups.push(() => rm(checkout, { recursive: true, force: true }));
    await mkdir(path.join(checkout, 'data'));
    // The checkout's own script and loader, as `defaultRunBootstrap` runs them.
    await symlink(path.join(CONTROL_PLANE_ROOT, 'scripts'), path.join(checkout, 'scripts'));
    await symlink(path.join(CONTROL_PLANE_ROOT, 'node_modules'), path.join(checkout, 'node_modules'));
    process.chdir(checkout);
    vi.resetModules();
    await import('../modules/index.js');
    await import('../cli/commands/index.js');
    await import('../channels/index.js');
    const { CENTRAL_DB_PATH } = await import('../config.js');
    const { closeDb, initDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    const { createAgentGroup } = await import('../db/agent-groups.js');
    const { ensureContainerConfig } = await import('../db/container-configs.js');
    const { initChannelAdapters, teardownChannelAdapters } = await import('../channels/channel-registry.js');
    const { routeInbound } = await import('../router.js');
    const { dispatch } = await import('../cli/dispatch.js');
    const { parseArgv } = await import('../cli/parse-argv.js');
    await runMigrations(await initDb(CENTRAL_DB_PATH));
    cleanups.push(closeDb);

    const routed: Promise<void>[] = [];
    // The host's inbound wiring for admin transports (src/index.ts).
    await initChannelAdapters((adapter) => ({
      onInbound() {},
      onInboundEvent(event: InboundEvent) {
        routed.push(
          routeInbound({
            ...event,
            message: {
              ...event.message,
              authenticatedSender: undefined,
              deduplicate: adapter.channelType === 'cli' ? event.message.deduplicate : undefined,
            },
          }),
        );
      },
      onMetadata() {},
      onAction() {},
    }));
    cleanups.push(teardownChannelAdapters);

    /** `ncl` on the host, failing as `runInstanceNclJson` does when the frame is not ok. */
    const runNcl = async (_config: InstanceRuntimeConfig, argv: readonly string[]): Promise<unknown> => {
      const { command, args } = parseArgv([...argv]);
      const frame = await dispatch({ id: 'bind-test', command, args }, { caller: 'host' });
      if (frame.ok) return frame.data;
      throw new GwsEaError('ncl_failed', `ncl ${argv.join(' ')} failed: ${frame.error.message}`);
    };

    await createAgentGroup({
      id: 'ag-main',
      name: 'main',
      folder: 'main',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig('ag-main');

    const config = runtimeConfig({
      checkout_realpath: checkout,
      node_path: process.execPath,
      home_directory: os.homedir(),
    });
    const provisioningStartedAt = new Date(Date.now() - 1_000).toISOString();
    const database = () => new Database(path.join(checkout, 'data', 'v2.db'), { readonly: true });
    return {
      checkout,
      config,
      provisioningStartedAt,
      runNcl,
      /** Canonical main is published only once its identity is verified. */
      publishMain: () =>
        runNcl(config, [
          'gws-ea-profile',
          'reconcile',
          '--assistant-display-name',
          'Aya',
          '--assistant-workspace-email',
          'aya@example.com',
          '--principal-display-name',
          'Principal',
          '--principal-timezone',
          'UTC',
          '--main-agent-group-id',
          'ag-main',
        ]),
      /** The principal's first message, authenticated by the Google Chat adapter. */
      principalMessage: (options: { readonly platformId?: string; readonly isGroup?: boolean } = {}) =>
        routeInbound({
          channelType: 'gchat',
          instance: 'gchat',
          platformId: options.platformId ?? PLATFORM,
          threadId: null,
          message: {
            id: `${options.platformId ?? PLATFORM}/messages/first`,
            kind: 'chat-sdk',
            content: JSON.stringify({
              text: 'hello',
              senderId: 'users/principal',
              author: { userId: 'users/principal' },
            }),
            timestamp: new Date().toISOString(),
            // The Chat SDK bridge marks a direct message as addressing the bot.
            isMention: true,
            isGroup: options.isGroup ?? false,
            authenticatedSender: { userId: 'users/principal', displayName: 'Principal', kind: 'human' },
          },
        }),
      reconcile: (dependencies: PrincipalDiscoveryDependencies = {}) =>
        reconcilePrincipalDm(config, { adapterInstance: 'gchat', provisioningStartedAt }, { runNcl, ...dependencies }),
      /** Once the host has received `count` welcomes, every one of them has been routed. */
      settled: async (count: number) => {
        await vi.waitFor(() => expect(routed).toHaveLength(count));
        await Promise.all(routed);
      },
      rows: <T>(sql: string, ...params: unknown[]): T[] => {
        const db = database();
        try {
          return db.prepare(sql).all(...params) as T[];
        } finally {
          db.close();
        }
      },
      /** Every message queued in main's sessions. */
      mainInbound: (): string[] => {
        const db = database();
        let sessions: Array<{ id: string }>;
        try {
          sessions = db.prepare("SELECT id FROM sessions WHERE agent_group_id = 'ag-main'").all() as Array<{
            id: string;
          }>;
        } finally {
          db.close();
        }
        return sessions.flatMap(({ id }) => {
          const inbound = new Database(path.join(checkout, 'data', 'v2-sessions', 'ag-main', id, 'inbound.db'), {
            readonly: true,
          });
          try {
            return (inbound.prepare('SELECT id FROM messages_in ORDER BY seq').all() as Array<{ id: string }>).map(
              (row) => row.id,
            );
          } finally {
            inbound.close();
          }
        });
      },
    };
  }

  it('binds a routed DM through the host, welcomes it once, and verify finds the binding', async () => {
    const instance = await runningInstance();
    await instance.publishMain();
    await instance.principalMessage();

    const result = await instance.reconcile();
    await instance.settled(1);

    expect(result).toMatchObject({ status: 'bound', agentGroupId: 'ag-main', candidate: { userId: USER } });
    const { candidate, eventId } = result as { candidate: PrincipalCandidate; eventId: string };
    expect(instance.rows('SELECT user_id, messaging_group_id FROM user_dms')).toEqual([
      { user_id: USER, messaging_group_id: candidate.messagingGroupId },
    ]);
    expect(instance.rows('SELECT user_id, role, agent_group_id FROM user_roles')).toEqual([
      { user_id: USER, role: 'owner', agent_group_id: null },
    ]);
    expect(instance.rows('SELECT user_id, agent_group_id FROM agent_group_members')).toEqual([
      { user_id: USER, agent_group_id: 'ag-main' },
    ]);
    expect(
      instance.rows(
        'SELECT messaging_group_id, agent_group_id, sender_scope, session_mode FROM messaging_group_agents',
      ),
    ).toEqual([
      {
        messaging_group_id: candidate.messagingGroupId,
        agent_group_id: 'ag-main',
        sender_scope: 'known',
        session_mode: 'agent-shared',
      },
    ]);
    expect(instance.mainInbound()).toEqual([`${eventId}:ag-main`]);
    expect(
      verifyPrincipalBinding({
        runtime: instance.config,
        adapterInstance: 'gchat',
        provisioningStartedAt: instance.provisioningStartedAt,
        selectedCandidate: candidate,
      }),
    ).toEqual({ status: 'matched', agentGroupId: 'ag-main', candidate, welcomeEventId: eventId });
  }, 60_000);

  it('completes with one welcome after a crash between the profile bind and init-first-agent', async () => {
    const instance = await runningInstance();
    await instance.publishMain();
    await instance.principalMessage();
    const crashAfterBind = async (config: InstanceRuntimeConfig, argv: readonly string[]): Promise<unknown> => {
      const data = await instance.runNcl(config, argv);
      if (argv[1] === 'bind-principal') throw new Error('The process died after binding the principal');
      return data;
    };

    await expect(instance.reconcile({ runNcl: crashAfterBind })).rejects.toThrow('died after binding');
    expect(instance.rows('SELECT user_id FROM gws_ea_principal_users')).toEqual([{ user_id: USER }]);
    expect(instance.mainInbound()).toEqual([]);

    const retried = await instance.reconcile();
    await instance.settled(1);
    // A second crash after the welcome was handed over, before the step recorded it.
    const again = await instance.reconcile();
    await instance.settled(2);

    expect(again).toEqual(retried);
    expect(instance.rows('SELECT id FROM messaging_group_agents')).toHaveLength(1);
    expect(instance.mainInbound()).toEqual([`${(retried as { eventId: string }).eventId}:ag-main`]);
  }, 90_000);

  it("fails the step when main's DM wiring has sender scope all, which canonical-main admission rejects", async () => {
    const instance = await runningInstance();
    await instance.principalMessage();
    const [dm] = instance.rows<{ id: string }>('SELECT id FROM messaging_groups WHERE platform_id = ?', PLATFORM);
    // Wired before canonical main was published, so admission had nothing to hold it to.
    await instance.runNcl(instance.config, [
      'wirings',
      'create',
      '--messaging-group-id',
      dm!.id,
      '--agent-group-id',
      'ag-main',
      '--sender-scope',
      'all',
      '--session-mode',
      'agent-shared',
    ]);
    await instance.publishMain();

    await expect(instance.reconcile()).rejects.toMatchObject({
      code: 'ncl_failed',
      message: expect.stringContaining("Canonical main wiring rejected: sender_scope must be 'known'"),
    });
    expect(instance.rows('SELECT sender_scope FROM messaging_group_agents')).toEqual([{ sender_scope: 'all' }]);
    expect(instance.mainInbound()).toEqual([]);
  }, 60_000);

  it('fails the step without wiring main when the principal conversation is not a direct message', async () => {
    const instance = await runningInstance();
    await instance.publishMain();
    await instance.principalMessage();
    const discovered = (await instance.runNcl(instance.config, [
      'dropped-messages',
      'list',
      '--channel-type',
      'gchat',
    ])) as Array<{ messaging_group_id: string }>;
    const conversation = discovered[0]!.messaging_group_id;
    // The recorded conversation is a group space, whatever the drop recorded.
    const db = new Database(path.join(instance.checkout, 'data', 'v2.db'));
    try {
      db.prepare('UPDATE messaging_groups SET is_group = 1 WHERE id = ?').run(conversation);
    } finally {
      db.close();
    }

    await expect(instance.reconcile()).rejects.toMatchObject({
      code: 'ncl_failed',
      message: expect.stringContaining('requires a direct conversation'),
    });
    await expect(
      instance.runNcl(instance.config, [
        'wirings',
        'create',
        '--messaging-group-id',
        conversation,
        '--agent-group-id',
        'ag-main',
        '--sender-scope',
        'known',
        '--session-mode',
        'agent-shared',
      ]),
    ).rejects.toThrow('Canonical main wiring rejected: only direct messages are allowed');
    expect(instance.rows('SELECT id FROM messaging_group_agents')).toEqual([]);
    expect(instance.mainInbound()).toEqual([]);
  }, 60_000);
});
