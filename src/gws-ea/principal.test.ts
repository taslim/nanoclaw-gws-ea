import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../channels/adapter.js';
import { ASSISTANT_SUB, CHAT_TOKEN } from '../modules/gws-ea-chat/testing/fake-chat-api.js';
import { FakeChatDirectMessages } from '../modules/gws-ea-chat/testing/fake-chat-dm.js';
import type { InstanceNclOptions } from './ncl.js';
import { CONTROL_PLANE_ROOT } from './paths.js';
import {
  bindPrincipal,
  GWS_EA_WELCOME_INSTRUCTION,
  principalWelcomeEventId,
  type PrincipalBindingDependencies,
  type PrincipalBindingResult,
} from './principal.js';
import type { InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { verifyPrincipalBinding } from './verify.js';

// Waking main starts its container; these tests stop at the session's inbound queue.
vi.mock('../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
// The assistant's Chat token, as the host mints it from the assistant's sign-in.
vi.mock('../modules/gws-ea-google/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/gws-ea-google/index.js')>()),
  hostGoogleAccessToken: vi.fn(async () => CHAT_TOKEN),
  assistantGoogleAccount: vi.fn(async () => ({ account: 'aya@example.com', sub: ASSISTANT_SUB })),
}));

const CHAT_EMAIL = 'juno.hale@northwind.example';
const VERIFIED_AT = '2026-09-18T18:05:00.000Z';
const OPENED = {
  status: 'opened',
  user_id: 'gchat:users/2001',
  platform_id: 'gchat:spaces/dm-2001',
  messaging_group_id: 'mg-principal',
} as const;
/** Binding order: open the DM, bind, then the host's records and main's DM wiring, then the welcome. */
const BIND_ORDER = ['open-dm', 'user', 'bind', 'role:owner', 'member', 'wiring', 'bootstrap'] as const;

function runtimeConfig(overrides: Partial<InstanceRuntimeConfig> = {}): InstanceRuntimeConfig {
  const instanceId = '11111111-1111-4111-8111-111111111111';
  const root = '/opt/gws-ea/11111111';
  const secrets = `${root}/secrets`;
  const project = `gws-ea-${instanceId.replaceAll('-', '')}`;
  return {
    schema_version: 3,
    instance_id: instanceId,
    install_id: instanceId.replaceAll('-', ''),
    instance_root: root,
    checkout_root: `${root}/nanoclaw`,
    state_root: `${root}/state`,
    node_path: '/usr/bin/node',
    home_directory: '/Users/operator',
    allocated_ports: { onecli_app: 31_002, onecli_gateway: 31_003 },
    agent_egress_network: `${project}-agent-egress`,
    onecli_project: project,
    onecli_app_url: 'http://127.0.0.1:31002',
    onecli_gateway_url: 'http://127.0.0.1:31003',
    onecli_gateway_container: `${project}-gateway-1`,
    selected_provider: 'claude',
    docker_endpoint: 'unix:///var/run/docker.sock',
    secret_files: {
      gchat_subscriber_key: `${secrets}/gchat-subscriber-key.json`,
      onecli_runtime_api_key: `${secrets}/onecli-runtime-api-key`,
      onecli_admin_api_key: `${secrets}/onecli-admin-api-key`,
    },
    ...overrides,
  };
}

const INPUT = { adapterInstance: 'gchat-assistant', chatEmail: CHAT_EMAIL, verifiedAt: VERIFIED_AT } as const;

function harness(
  dm: unknown = OPENED,
  mainAgentGroupId: string | null = 'ag-main',
): {
  order: string[];
  dependencies: PrincipalBindingDependencies;
  runNcl: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
} {
  const order: string[] = [];
  const runNcl = vi.fn(
    async (_config: InstanceRuntimeConfig, args: readonly string[], _options?: InstanceNclOptions) => {
      const operation = `${args[0]} ${args[1]}`;
      if (operation === 'gws-ea-profile get') {
        return {
          main_agent_group_id: mainAgentGroupId,
          principal_display_name: 'Juno Hale',
        };
      }
      const flag = (name: string) => args[args.indexOf(name) + 1];
      if (operation === 'gws-ea-chat open-principal-dm') {
        order.push('open-dm');
        return dm;
      }
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
    },
  );
  // The checkout's `init-first-agent` script, run as a child process.
  const runCommand = vi.fn(async () => {
    order.push('bootstrap');
    return { stdout: '', stderr: '' };
  });
  return { order, dependencies: { runNcl, runCommand }, runNcl, runCommand };
}

function nclArgs(runNcl: ReturnType<typeof vi.fn>, operation: string): readonly string[] {
  const call = runNcl.mock.calls.find((candidate) => `${candidate[1][0]} ${candidate[1][1]}` === operation);
  if (!call) throw new Error(`No ncl ${operation}`);
  return call[1] as readonly string[];
}

describe('binding the principal through the DM the assistant opens', () => {
  it('requires canonical main to be published before opening any DM', async () => {
    const h = harness(OPENED, null);
    await expect(bindPrincipal(runtimeConfig(), INPUT, h.dependencies)).rejects.toThrow(/canonical main/i);
    expect(h.order).toEqual([]);
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  it('opens the named address and binds the person Google resolved, then wires main and welcomes them there', async () => {
    const h = harness();

    const result = await bindPrincipal(runtimeConfig(), INPUT, h.dependencies);

    expect(result).toEqual({
      status: 'bound',
      agentGroupId: 'ag-main',
      principal: {
        userId: 'gchat:users/2001',
        messagingGroupId: 'mg-principal',
        platformId: 'gchat:spaces/dm-2001',
        boundAt: VERIFIED_AT,
      },
      eventId: principalWelcomeEventId(runtimeConfig(), 'ag-main', { messagingGroupId: 'mg-principal' }),
    });
    expect(h.order).toEqual(BIND_ORDER);
    // One address, the one create named, with the time Google may take to answer.
    expect(h.runNcl.mock.calls.filter((call) => call[1][0] === 'gws-ea-chat')).toEqual([
      [runtimeConfig(), ['gws-ea-chat', 'open-principal-dm', '--email', CHAT_EMAIL], { timeoutMs: expect.any(Number) }],
    ]);
    expect(nclArgs(h.runNcl, 'users create')).toEqual([
      'users',
      'create',
      '--id',
      'gchat:users/2001',
      '--kind',
      'gchat',
      '--display-name',
      'Juno Hale',
    ]);
    expect(nclArgs(h.runNcl, 'gws-ea-profile bind-principal')).toEqual([
      'gws-ea-profile',
      'bind-principal',
      '--user-id',
      'gchat:users/2001',
      '--verified-at',
      VERIFIED_AT,
      '--messaging-group-id',
      'mg-principal',
    ]);
    expect(nclArgs(h.runNcl, 'wirings create')).toEqual([
      'wirings',
      'create',
      '--messaging-group-id',
      'mg-principal',
      '--agent-group-id',
      'ag-main',
      '--sender-scope',
      'known',
      '--session-mode',
      'agent-shared',
    ]);
    expect(h.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          '--import',
          '/opt/gws-ea/11111111/nanoclaw/node_modules/tsx/dist/loader.mjs',
          '/opt/gws-ea/11111111/nanoclaw/scripts/init-first-agent.ts',
          '--channel',
          'gchat',
          '--user-id',
          'gchat:users/2001',
          '--platform-id',
          'gchat:spaces/dm-2001',
          '--display-name',
          'Juno Hale',
          '--agent-group-id',
          'ag-main',
          '--role',
          'owner',
          '--instance',
          'gchat-assistant',
          '--event-id',
          (result as Extract<PrincipalBindingResult, { status: 'bound' }>).eventId,
          '--welcome',
          GWS_EA_WELCOME_INSTRUCTION,
        ],
      }),
    );
  });

  it.each([
    ['a request the principal must accept', { status: 'awaiting_acceptance', space: 'spaces/dm-2001' }],
    ['Google unavailable', { status: 'unavailable', reason: 'Google refused /v1/spaces:setup: Backend error' }],
  ] as const)('reports %s, binding nothing', async (_label, answer) => {
    const h = harness(answer);

    await expect(bindPrincipal(runtimeConfig(), INPUT, h.dependencies)).resolves.toEqual(answer);
    expect(h.order).toEqual(['open-dm']);
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  it('stops, binding nothing, when the host cannot open the DM with the address', async () => {
    const h = harness();
    const hostNcl = h.dependencies.runNcl!;
    const runNcl: NonNullable<PrincipalBindingDependencies['runNcl']> = async (config, args, options) => {
      if (args[0] === 'gws-ea-chat') {
        throw new GwsEaError(
          'ncl_failed',
          `ncl ${args.join(' ')} failed: Google Chat cannot open a direct message with ${CHAT_EMAIL}: not found`,
        );
      }
      return hostNcl(config, args, options);
    };

    await expect(bindPrincipal(runtimeConfig(), INPUT, { ...h.dependencies, runNcl })).rejects.toThrow(CHAT_EMAIL);
    expect(h.order).toEqual([]);
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['names the address rather than the numeric ID', { ...OPENED, user_id: `gchat:users/${CHAT_EMAIL}` }],
    ['is in another channel', { ...OPENED, platform_id: 'slack:D123' }],
    ['carries no conversation', { status: 'opened', user_id: 'gchat:users/2001', platform_id: 'gchat:spaces/dm-2001' }],
  ])('refuses an opened DM that %s, binding nothing', async (_label, answer) => {
    const h = harness(answer);

    await expect(bindPrincipal(runtimeConfig(), INPUT, h.dependencies)).rejects.toMatchObject({
      code: 'invalid_child_output',
    });
    expect(h.order).toEqual(['open-dm']);
  });

  it('fails without bootstrapping when the host does not confirm the principal wiring', async () => {
    const h = harness();
    const hostNcl = h.dependencies.runNcl!;
    const runNcl: NonNullable<PrincipalBindingDependencies['runNcl']> = async (config, args, options) =>
      args[0] === 'wirings'
        ? { messaging_group_id: 'mg-principal', agent_group_id: 'ag-main', sender_scope: 'all', session_mode: 'shared' }
        : hostNcl(config, args, options);
    await expect(bindPrincipal(runtimeConfig(), INPUT, { ...h.dependencies, runNcl })).rejects.toThrow(
      /wiring was not confirmed/,
    );
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  it("runs main's own welcome for the principal, never NanoClaw's channel addendum", () => {
    expect(GWS_EA_WELCOME_INSTRUCTION).toContain('run /welcome ');
    expect(GWS_EA_WELCOME_INSTRUCTION).toContain('the principal');
    expect(GWS_EA_WELCOME_INSTRUCTION).not.toMatch(/addend|\/app\/skills/u);
  });

  it('keeps one welcome identity per assistant, main, and conversation', () => {
    const welcome = principalWelcomeEventId(runtimeConfig(), 'ag-main', { messagingGroupId: 'mg-principal' });
    expect(principalWelcomeEventId(runtimeConfig(), 'ag-main', { messagingGroupId: 'mg-principal' })).toBe(welcome);
    expect(principalWelcomeEventId(runtimeConfig(), 'ag-main', { messagingGroupId: 'mg-other' })).not.toBe(welcome);
  });

  it('executes the checked-out bootstrap script with the allowlisted instance environment', async () => {
    const h = harness();
    await bindPrincipal(runtimeConfig(), INPUT, h.dependencies);
    expect(h.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/usr/bin/node',
        cwd: '/opt/gws-ea/11111111/nanoclaw',
        args: expect.arrayContaining(['/opt/gws-ea/11111111/nanoclaw/scripts/init-first-agent.ts', '--event-id']),
        env: expect.objectContaining({ NANOCLAW_INSTALL_ID: runtimeConfig().install_id }),
      }),
    );
  });
});

/**
 * The binding on real NanoClaw code: the host opens the principal's DM
 * through its own `ncl` command against Google Chat faked at `fetch`, every
 * `ncl` call goes through the host's dispatch into a checkout's central DB
 * built by core migrations, and the checkout's own
 * `scripts/init-first-agent.ts` runs as a child process and hands its welcome
 * to the host's CLI socket.
 */
describe('binding the principal on a real instance', () => {
  const originalCwd = process.cwd();
  const cleanups: Array<() => Promise<void>> = [];
  const PRINCIPAL_ID = '2001';
  const USER = `gchat:users/${PRINCIPAL_ID}`;
  const COLLEAGUE = 'users/3003';

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
  });

  /**
   * An assistant whose host is running: the host's composition, its CLI
   * socket, and canonical main. Its release reaches the state through its
   * `data` link, as every release does.
   */
  async function runningInstance() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-bind-')));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const checkout = path.join(root, 'nanoclaw');
    await mkdir(path.join(root, 'state', 'data'), { recursive: true });
    await mkdir(checkout);
    await symlink(path.join('..', 'state', 'data'), path.join(checkout, 'data'));
    // The checkout's own script and loader, as `bindPrincipal` runs them.
    await symlink(path.join(CONTROL_PLANE_ROOT, 'scripts'), path.join(checkout, 'scripts'));
    await symlink(path.join(CONTROL_PLANE_ROOT, 'node_modules'), path.join(checkout, 'node_modules'));
    process.chdir(checkout);
    // Google Chat, as the host's DM command reaches it.
    const chat = new FakeChatDirectMessages();
    chat.people.set(CHAT_EMAIL, { id: PRINCIPAL_ID });
    vi.stubGlobal('fetch', chat.fetch);
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
      instance_root: root,
      checkout_root: checkout,
      state_root: path.join(root, 'state'),
      node_path: process.execPath,
      home_directory: os.homedir(),
    });
    const provisioningStartedAt = new Date(Date.now() - 2_000).toISOString();
    const verifiedAt = new Date(Date.now() - 1_000).toISOString();
    const database = () => new Database(path.join(checkout, 'data', 'v2.db'), { readonly: true });
    /** A message in Google Chat, as the assistant's adapter routes it. */
    const chatMessage = (platformId: string, sender: string, id: string) =>
      routeInbound({
        channelType: 'gchat',
        instance: 'gchat',
        platformId,
        threadId: null,
        message: {
          id: `${platformId}/messages/${id}`,
          kind: 'chat-sdk',
          content: JSON.stringify({ text: 'hello', senderId: sender, author: { userId: sender } }),
          timestamp: new Date().toISOString(),
          // The Chat SDK bridge marks a direct message as addressing the assistant.
          isMention: true,
          isGroup: false,
          authenticatedSender: { userId: sender, displayName: 'Someone', kind: 'human' },
        },
      });
    return {
      chat,
      checkout,
      config,
      provisioningStartedAt,
      runNcl,
      chatMessage,
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
          'Juno Hale',
          '--principal-timezone',
          'UTC',
          '--main-agent-group-id',
          'ag-main',
        ]),
      bind: (dependencies: PrincipalBindingDependencies = {}) =>
        bindPrincipal(
          config,
          { adapterInstance: 'gchat', chatEmail: CHAT_EMAIL, verifiedAt },
          { runNcl, ...dependencies },
        ),
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

  it('binds only the person behind the named address, welcomes them first in the DM the assistant opened, and routes their next message to main (AE7)', async () => {
    const instance = await runningInstance();
    await instance.publishMain();
    // A colleague writes to the assistant while it is being created.
    await instance.chatMessage('gchat:spaces/dm-colleague', COLLEAGUE, 'colleague');

    const result = await instance.bind();
    await instance.settled(1);

    expect(result).toMatchObject({ status: 'bound', agentGroupId: 'ag-main', principal: { userId: USER } });
    const { principal, eventId } = result as Extract<PrincipalBindingResult, { status: 'bound' }>;
    expect(instance.chat.setups()).toEqual([`users/${CHAT_EMAIL}`]);
    expect(principal.platformId).toBe(`gchat:spaces/dm-${PRINCIPAL_ID}`);
    expect(instance.rows('SELECT user_id FROM gws_ea_principal_users')).toEqual([{ user_id: USER }]);
    expect(instance.rows('SELECT user_id, messaging_group_id FROM user_dms')).toEqual([
      { user_id: USER, messaging_group_id: principal.messagingGroupId },
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
        messaging_group_id: principal.messagingGroupId,
        agent_group_id: 'ag-main',
        sender_scope: 'known',
        session_mode: 'agent-shared',
      },
    ]);
    // The welcome is the first message main has, in the conversation the assistant opened.
    expect(instance.mainInbound()).toEqual([`${eventId}:ag-main`]);
    expect(
      verifyPrincipalBinding({
        runtime: instance.config,
        adapterInstance: 'gchat',
        provisioningStartedAt: instance.provisioningStartedAt,
      }),
    ).toEqual({ status: 'matched', agentGroupId: 'ag-main', principal, welcomeEventId: eventId });

    // The principal's next message reaches main through its wiring, raising no approval.
    await instance.chatMessage(principal.platformId, `users/${PRINCIPAL_ID}`, 'reply');
    expect(instance.mainInbound()).toEqual([`${eventId}:ag-main`, `${principal.platformId}/messages/reply:ag-main`]);
    expect(instance.rows('SELECT * FROM pending_channel_approvals')).toEqual([]);
    expect(instance.rows('SELECT * FROM pending_sender_approvals')).toEqual([]);
  }, 60_000);

  it('completes with one welcome after a crash between the profile bind and init-first-agent', async () => {
    const instance = await runningInstance();
    await instance.publishMain();
    const crashAfterBind = async (config: InstanceRuntimeConfig, argv: readonly string[]): Promise<unknown> => {
      const data = await instance.runNcl(config, argv);
      if (argv[1] === 'bind-principal') throw new Error('The process died after binding the principal');
      return data;
    };

    await expect(instance.bind({ runNcl: crashAfterBind })).rejects.toThrow('died after binding');
    expect(instance.rows('SELECT user_id FROM gws_ea_principal_users')).toEqual([{ user_id: USER }]);
    expect(instance.mainInbound()).toEqual([]);

    const retried = await instance.bind();
    await instance.settled(1);
    // A second crash after the welcome was handed over, before the step recorded it.
    const again = await instance.bind();
    await instance.settled(2);

    expect(again).toEqual(retried);
    expect(instance.rows('SELECT id FROM messaging_group_agents')).toHaveLength(1);
    expect(instance.mainInbound()).toEqual([`${(retried as { eventId: string }).eventId}:ag-main`]);
  }, 90_000);

  it("fails the step when main's DM wiring has sender scope all, which canonical-main admission rejects", async () => {
    const instance = await runningInstance();
    const opened = (await instance.runNcl(instance.config, [
      'gws-ea-chat',
      'open-principal-dm',
      '--email',
      CHAT_EMAIL,
    ])) as { messaging_group_id: string };
    // Wired before canonical main was published, so admission had nothing to hold it to.
    await instance.runNcl(instance.config, [
      'wirings',
      'create',
      '--messaging-group-id',
      opened.messaging_group_id,
      '--agent-group-id',
      'ag-main',
      '--sender-scope',
      'all',
      '--session-mode',
      'agent-shared',
    ]);
    await instance.publishMain();

    await expect(instance.bind()).rejects.toMatchObject({
      code: 'ncl_failed',
      message: expect.stringContaining("Canonical main wiring rejected: sender_scope must be 'known'"),
    });
    expect(instance.rows('SELECT sender_scope FROM messaging_group_agents')).toEqual([{ sender_scope: 'all' }]);
    expect(instance.mainInbound()).toEqual([]);
  }, 60_000);

  it('pauses without binding while a principal outside the organization has not accepted the DM', async () => {
    const instance = await runningInstance();
    instance.chat.people.set(CHAT_EMAIL, { id: PRINCIPAL_ID, external: true });
    await instance.publishMain();

    await expect(instance.bind()).resolves.toEqual({
      status: 'awaiting_acceptance',
      space: `spaces/dm-${PRINCIPAL_ID}`,
    });
    expect(instance.rows('SELECT user_id FROM gws_ea_principal_users')).toEqual([]);
    expect(instance.rows('SELECT id FROM messaging_group_agents')).toEqual([]);

    instance.chat.accepted.add(PRINCIPAL_ID);
    const bound = await instance.bind();
    await instance.settled(1);
    expect(bound).toMatchObject({ status: 'bound', principal: { userId: USER } });
    expect(instance.mainInbound()).toEqual([`${(bound as { eventId: string }).eventId}:ag-main`]);
  }, 60_000);
});
