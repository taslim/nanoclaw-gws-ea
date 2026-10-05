/**
 * Guards for gws-ea's recorded differences from upstream NanoClaw.
 *
 * Each guard drives the real upstream-owned module through the behavior gws-ea
 * depends on, so a skill refresh or upstream update that drops a recorded
 * divergence fails this suite, not a live assistant. Only effects outside the
 * guarded modules are replaced: container wake-up, launchd and Docker behind
 * the update helpers' command runner, and Google's certificate check and the
 * OneCLI servers behind `fetch`. Modules outside `src/` (scripts and the agent
 * runner) load by path, since the host's build covers only `src/`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRegistration, InboundEvent } from '../channels/adapter.js';
import type { ContainerConfig } from '../container-config.js';
import type { GatewayApprovalRequest, GatewaySessionInput } from '../gateway-providers/gateway-provider-registry.js';
import type { ProviderStateVolume } from '../provider-contracts/registry.js';
import type { AgentGroup, Session } from '../types.js';
import { deriveWorkspaceAddOnIdentity } from './gcp-identity.js';
import { CONTROL_PLANE_ROOT } from './paths.js';
import type { NanoclawCommandRunner, NanoclawServiceEnvironment, NanoclawServiceHelpers } from './service-control.js';

const external = vi.hoisted(() => ({ requestWake: vi.fn(async () => true) }));

// Recording pass-throughs: the real modules run; the guards read what they were given.
vi.mock('@chat-adapter/gchat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chat-adapter/gchat')>();
  return { ...actual, createGoogleChatAdapter: vi.fn(actual.createGoogleChatAdapter) };
});
vi.mock('../channels/chat-sdk-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channels/chat-sdk-bridge.js')>();
  return { ...actual, createChatSdkBridge: vi.fn(actual.createChatSdkBridge) };
});
vi.mock('../channels/channel-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channels/channel-registry.js')>();
  return { ...actual, registerChannelAdapter: vi.fn(actual.registerChannelAdapter) };
});
// Waking an agent starts a container; the welcome guard stops at the session's inbound queue.
vi.mock('../request-wake.js', () => ({ requestWake: external.requestWake }));

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];
/** Runs a NanoClaw script the way its package scripts do, outside this test's module graph. */
const TSX_LOADER = path.join(CONTROL_PLANE_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A fresh NanoClaw install directory as the working directory, with fresh
 * module instances: NanoClaw resolves `data/`, `.env`, and its adapters'
 * configuration from the cwd when a module loads.
 */
async function freshInstall(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-divergence-')));
  await mkdir(path.join(directory, 'data'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  process.chdir(directory);
  vi.resetModules();
  return directory;
}

describe('recorded divergence: Google Chat receives the Workspace Add-on identity', () => {
  it('passes the add-on identity from the host environment to the adapter, which then accepts its requests', async () => {
    await freshInstall();
    const endpointUrl = 'https://assistant.example.test/webhook/gchat';
    const addOnIdentity = deriveWorkspaceAddOnIdentity('441811502258');
    // What gws-ea's instance launcher puts in the host environment.
    vi.stubEnv('GCHAT_CREDENTIALS', JSON.stringify({ client_email: 'bot@example.test', private_key: 'unused' }));
    vi.stubEnv('GCHAT_ENDPOINT_URL', endpointUrl);
    vi.stubEnv('GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL', addOnIdentity);
    const registry = await import('../channels/channel-registry.js');
    const sdk = await import('@chat-adapter/gchat');
    await import('../channels/gchat.js');

    const registration = vi
      .mocked(registry.registerChannelAdapter)
      .mock.calls.find(([name]) => name === 'gchat')?.[1] as ChannelRegistration | undefined;
    expect(await registration?.factory()).toBeTruthy();
    const adapter = vi.mocked(sdk.createGoogleChatAdapter).mock.results.at(-1)?.value as
      | ReturnType<typeof sdk.createGoogleChatAdapter>
      | undefined;
    expect(adapter).toBeDefined();
    const internals = adapter as unknown as {
      oauth2Client: { verifyIdToken(options: { idToken: string; audience: string }): Promise<unknown> };
      handleMessageEvent(event: unknown, options: unknown): void;
    };
    // Google's signature check needs its certificates; the identity claims are what the adapter decides on.
    vi.spyOn(internals.oauth2Client, 'verifyIdToken').mockImplementation(async ({ audience }) => ({
      getPayload: () => ({
        aud: audience,
        email: addOnIdentity,
        email_verified: true,
        iss: 'https://accounts.google.com',
      }),
    }));
    const handled = vi.spyOn(internals, 'handleMessageEvent').mockImplementation(() => undefined);

    const response = await adapter!.handleWebhook(
      new Request(endpointUrl, {
        method: 'POST',
        headers: { authorization: 'Bearer add-on-signed', 'content-type': 'application/json' },
        body: JSON.stringify({
          chat: {
            messagePayload: {
              message: {
                name: 'spaces/dm/messages/one',
                sender: { displayName: 'Principal', name: 'users/principal', type: 'HUMAN' },
                text: 'hello',
              },
              space: { name: 'spaces/dm', type: 'DM' },
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(handled).toHaveBeenCalledOnce();
  });
});

describe('recorded divergence: the installed OneCLI adapter', () => {
  const onecliUrl = 'http://onecli.divergence.test';
  const gatewayUrl = 'http://gateway.divergence.test';

  /**
   * OneCLI's API and gateway behind `fetch`, recording every agent creation and
   * approval decision. Like the gateway, a poll answers with the pending
   * requests it does not exclude, and otherwise holds until stopped.
   */
  function onecliServers(pending: readonly Record<string, unknown>[] = []) {
    const createdAgents: unknown[] = [];
    const decisions: Array<{ id: string; decision: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === onecliUrl && url.pathname === '/v1/agents' && init?.method === 'POST') {
        createdAgents.push(JSON.parse(String(init.body)));
        return Response.json({ id: 'agent' }, { status: 201 });
      }
      if (url.origin === onecliUrl && url.pathname === '/v1/container-config') {
        return Response.json({
          env: { HTTPS_PROXY: 'http://host.docker.internal:10255' },
          caCertificate: '-----BEGIN CERTIFICATE-----\nguard\n-----END CERTIFICATE-----\n',
          caCertificateContainerPath: '/tmp/onecli-ca.pem',
        });
      }
      if (url.origin === gatewayUrl && url.pathname.endsWith('/decision')) {
        decisions.push({ id: decodeURIComponent(url.pathname.split('/')[3]!), ...JSON.parse(String(init?.body)) });
        return Response.json({});
      }
      if (url.origin === gatewayUrl && url.pathname === '/v1/approvals/pending') {
        const excluded = new Set(url.searchParams.get('exclude')?.split(',') ?? []);
        const requests = pending.filter((request) => !excluded.has(String(request.id)));
        if (requests.length > 0) return Response.json({ requests, timeoutSeconds: 30 });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        });
      }
      return new Response('not found', { status: 404 });
    });
    return { createdAgents, decisions };
  }

  async function installedProvider() {
    await freshInstall();
    vi.stubEnv('ONECLI_URL', onecliUrl);
    vi.stubEnv('ONECLI_API_KEY', 'divergence-guard-key');
    vi.stubEnv('ONECLI_GATEWAY_URL', gatewayUrl);
    const registry = await import('../gateway-providers/gateway-provider-registry.js');
    await import('../gateway-providers/onecli.js');
    const provider = registry.getGatewayProviderRegistration('onecli');
    if (!provider) throw new Error('The installed OneCLI adapter did not register');
    return provider;
  }

  const session = (disposition: 'create' | 'adopt'): GatewaySessionInput => ({
    key: { installSlug: 'install', agentGroupId: 'owned-group', sessionId: `session-${disposition}` },
    disposition,
    runtimeIdentity: `install/owned-group/session-${disposition}`,
    groupName: 'main',
    containerName: 'agent',
    capabilities: {} as GatewaySessionInput['capabilities'],
    credentialScope: { kind: 'all' },
  });

  it('never creates a OneCLI agent when adopting a surviving session', async () => {
    const provider = await installedProvider();
    const servers = onecliServers();
    const lease = new AbortController();
    cleanups.push(async () => lease.abort());

    await provider.sessions.ensure(session('adopt'), lease.signal);
    expect(servers.createdAgents).toEqual([]);

    await provider.sessions.ensure(session('create'), lease.signal);
    expect(servers.createdAgents).toEqual([{ name: 'main', identifier: 'owned-group' }]);
  });

  it("narrows a restricted agent to exactly its capabilities' secrets and the model's before it can run", async () => {
    const provider = await installedProvider();
    expect(provider.sessions.enforcesCredentialScope).toBe(true);
    expect(typeof provider.credentials?.connection).toBe('function');

    const calls: string[] = [];
    let assigned: string[] = ['secret-calendar'];
    let mode = 'all';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const call = `${method} ${url.origin === gatewayUrl ? 'gateway' : 'onecli'}${url.pathname}`;
      calls.push(call);
      const body = () => JSON.parse(String(init?.body)) as Record<string, unknown>;
      switch (call) {
        case 'GET onecli/v1/agents':
          return Response.json([{ id: 'agent-1', identifier: 'owned-group', secretMode: mode }]);
        case 'GET onecli/v1/secrets':
          return Response.json([
            { id: 'secret-mail', name: 'google-gmail-read', hostPattern: 'gmail.googleapis.com' },
            { id: 'secret-calendar', name: 'google-calendar', hostPattern: 'www.googleapis.com' },
            { id: 'secret-model', name: 'Anthropic', hostPattern: 'api.anthropic.com' },
          ]);
        case 'GET onecli/v1/agents/agent-1/secrets':
          return Response.json(assigned);
        case 'PUT onecli/v1/agents/agent-1/secrets':
          assigned = body().secretIds as string[];
          return Response.json({ success: true });
        case 'PATCH onecli/v1/agents/agent-1/secret-mode':
          mode = body().mode as string;
          return Response.json({ success: true });
        case 'POST gateway/v1/cache/invalidate':
          return Response.json({});
        case 'GET onecli/v1/container-config':
          return Response.json({
            env: { HTTPS_PROXY: 'http://host.docker.internal:10255' },
            caCertificate: '-----BEGIN CERTIFICATE-----\nguard\n-----END CERTIFICATE-----\n',
            caCertificateContainerPath: '/tmp/onecli-ca.pem',
          });
        default:
          return new Response('not found', { status: 404 });
      }
    });
    const lease = new AbortController();
    cleanups.push(async () => lease.abort());

    await provider.sessions.ensure(
      {
        ...session('adopt'),
        credentialScope: { kind: 'only', credentials: ['google-gmail-read'], modelDomains: ['anthropic.com'] },
      },
      lease.signal,
    );

    expect([...assigned].sort()).toEqual(['secret-mail', 'secret-model']);
    expect(mode).toBe('selective');
    const configRead = calls.indexOf('GET onecli/v1/container-config');
    for (const write of [
      'PUT onecli/v1/agents/agent-1/secrets',
      'PATCH onecli/v1/agents/agent-1/secret-mode',
      'POST gateway/v1/cache/invalidate',
    ]) {
      expect(calls.indexOf(write)).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf(write)).toBeLessThan(configRead);
    }
  });

  const approval = (id: string, group: string) => ({
    id,
    createdAt: new Date(Date.now() + 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    method: 'POST',
    host: 'api.example.test',
    path: '/resource',
    agent: { name: group, externalId: group },
  });

  /** Subscribe with this install owning `owned-group`, until `settled` holds. */
  async function subscribeUntil(
    provider: Awaited<ReturnType<typeof installedProvider>>,
    decide: (request: GatewayApprovalRequest) => Promise<'approve' | 'deny' | 'unavailable'>,
    settled: () => void,
  ): Promise<void> {
    const subscription = new AbortController();
    const running = provider.approvals.subscribe(decide, subscription.signal, undefined, {
      ownsAgentGroup: async (agentGroupId) => agentGroupId === 'owned-group',
    });
    try {
      await vi.waitFor(settled);
    } finally {
      subscription.abort();
      await running.catch(() => undefined);
    }
  }

  it('leaves an approval pending when no decision is available, without asking again at once', async () => {
    const provider = await installedProvider();
    const servers = onecliServers([approval('undecided', 'owned-group')]);
    let firstAskedAt: number | undefined;
    const decide = vi.fn(async (_request: GatewayApprovalRequest) => {
      firstAskedAt ??= Date.now();
      return 'unavailable' as const;
    });

    // Still subscribed a while after the first answer: the gateway would hand a pending request
    // straight back, so it is not polled or decided again at once.
    await subscribeUntil(provider, decide, () =>
      expect(Date.now() - (firstAskedAt ?? Date.now())).toBeGreaterThan(100),
    );
    expect(decide).toHaveBeenCalledOnce();
    expect(servers.decisions).toEqual([]);
  });
});

describe('recorded divergence: the webhook server honors a loopback WEBHOOK_HOST', () => {
  it('binds 127.0.0.1 when the instance sets WEBHOOK_HOST to loopback', async () => {
    await freshInstall();
    const port = await freePort();
    vi.stubEnv('WEBHOOK_HOST', '127.0.0.1');
    vi.stubEnv('WEBHOOK_PORT', String(port));
    const listen = vi.spyOn(net.Server.prototype, 'listen');
    const webhooks = await import('../webhook-server.js');
    cleanups.push(() => webhooks.stopWebhookServer());

    webhooks.registerWebhookHandler('divergence-guard', (_request, response) => {
      response.end('ok');
    });

    const server = listen.mock.contexts.find((context) => context instanceof net.Server) as net.Server | undefined;
    expect(server).toBeDefined();
    await vi.waitFor(() => expect(server!.listening).toBe(true));
    expect(server!.address()).toMatchObject({ address: '127.0.0.1', port } satisfies Partial<AddressInfo>);
  });
});

describe('recorded divergence: init-first-agent takes an optional welcome event ID', () => {
  const initFirstAgent = path.join(CONTROL_PLANE_ROOT, 'scripts', 'init-first-agent.ts');

  function welcome(cwd: string): Promise<{ readonly status: number | null; readonly stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          TSX_LOADER,
          initFirstAgent,
          '--channel',
          'gchat',
          '--user-id',
          'gchat:users/principal',
          '--platform-id',
          'gchat:spaces/principal-dm',
          '--display-name',
          'Principal',
        ],
        { cwd, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', (status) => resolve({ status, stderr }));
    });
  }

  /** Run init-first-agent twice against a host's CLI transport; the ids of main's queued messages. */
  async function welcomeTwice(): Promise<unknown[]> {
    const install = await freshInstall();
    const { CENTRAL_DB_PATH, DATA_DIR } = await import('../config.js');
    const { closeDb, getDb, initDb } = await import('../db/connection.js');
    const { initChannelAdapters, teardownChannelAdapters } = await import('../channels/channel-registry.js');
    const { routeInbound } = await import('../router.js');
    // The host's composition: the session mailbox and the CLI admin transport.
    await import('../mailbox/compose.js');
    await import('../channels/cli.js');
    let database: Promise<unknown> | undefined;
    const routed: Promise<void>[] = [];
    // The host's wiring for the CLI admin transport (src/index.ts).
    await initChannelAdapters((adapter) => ({
      onInbound() {},
      onInboundEvent(event: InboundEvent) {
        database ??= initDb(CENTRAL_DB_PATH);
        routed.push(
          database.then(() =>
            routeInbound({
              ...event,
              message: {
                ...event.message,
                authenticatedSender: undefined,
                deduplicate: adapter.channelType === 'cli' ? event.message.deduplicate : undefined,
              },
            }),
          ),
        );
      },
      onMetadata() {},
      onAction() {},
    }));
    cleanups.push(async () => {
      await teardownChannelAdapters();
      if (database) await closeDb();
    });

    for (const attempt of [1, 2]) {
      const run = await welcome(install);
      expect(run, `attempt ${attempt}: ${run.stderr}`).toMatchObject({ status: 0 });
      await vi.waitFor(() => expect(routed).toHaveLength(attempt));
      await Promise.all(routed);
    }

    const sessions = await getDb().all<{ id: string; agent_group_id: string }>(
      'SELECT id, agent_group_id FROM sessions',
    );
    expect(sessions).toHaveLength(1);
    const inbound = new Database(
      path.join(DATA_DIR, 'v2-sessions', sessions[0]!.agent_group_id, sessions[0]!.id, 'inbound.db'),
      { readonly: true },
    );
    try {
      return inbound.prepare('SELECT id FROM messages_in ORDER BY seq').all();
    } finally {
      inbound.close();
    }
  }

  it("leaves upstream's welcome unchanged without --event-id: every run queues a fresh one", async () => {
    const queued = await welcomeTwice();
    expect(queued).toHaveLength(2);
    expect(queued).not.toContainEqual({ id: expect.stringContaining('gws-ea-welcome') });
  });
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('recorded divergence: Google Chat gives the agent the message a principal quotes', () => {
  it('hands the registered bridge a reply-context hook that reads the quoted snapshot', async () => {
    await freshInstall();
    vi.stubEnv('GCHAT_CREDENTIALS', JSON.stringify({ client_email: 'bot@example.test', private_key: 'secret' }));
    vi.stubEnv('GCHAT_ENDPOINT_URL', 'https://assistant.example.test/webhook/gchat');
    const bridge = await import('../channels/chat-sdk-bridge.js');
    await import('../channels/gchat.js');
    const registry = await import('../channels/channel-registry.js');
    const registration = vi
      .mocked(registry.registerChannelAdapter)
      .mock.calls.find(([name]) => name === 'gchat')?.[1] as ChannelRegistration | undefined;

    await registration!.factory();

    const hook = vi.mocked(bridge.createChatSdkBridge).mock.calls[0]?.[0].extractReplyContext;
    expect(
      hook?.({
        chat: {
          messagePayload: {
            message: { quotedMessageMetadata: { quotedMessageSnapshot: { sender: 'Juno', text: 'Lunch at 1?' } } },
          },
        },
      }),
    ).toEqual({ sender: 'Juno', text: 'Lunch at 1?' });
  });
});

describe('recorded divergence: a Google Chat message keeps its attachments', () => {
  it('saves an attachment from a message whose ID holds slashes', async () => {
    const directory = await freshInstall();
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    await db.createAgentGroup({
      id: 'ag-1',
      name: 'Main',
      folder: 'main',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await db.createMessagingGroup({
      id: 'mg-1',
      channel_type: 'gchat',
      platform_id: 'gchat:spaces/dm',
      name: 'Principal',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    await mkdir(path.join(directory, 'groups'), { recursive: true });
    await import('../mailbox/compose.js');
    const { resolveSession, sessionDir, writeSessionMessage } = await import('../session-manager.js');
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    await writeSessionMessage('ag-1', session.id, {
      id: 'spaces/dm/messages/abc.abc',
      kind: 'chat-sdk',
      timestamp: new Date().toISOString(),
      platformId: 'gchat:spaces/dm',
      channelType: 'gchat',
      threadId: null,
      content: JSON.stringify({ text: 'agenda', attachments: [{ name: 'agenda.txt', data: 'YWdlbmRh' }] }),
    });

    const inbox = path.join(sessionDir('ag-1', session.id), 'inbox');
    const [folder] = await readdir(inbox);
    expect(await readFile(path.join(inbox, folder!, 'agenda.txt'), 'utf8')).toBe('agenda');
  });
});

describe('recorded divergence: delivery consults outbound guards, and the runner reports a failed turn', () => {
  it('refuses a send that a registered outbound guard refuses, before the channel adapter sees it', async () => {
    await freshInstall();
    const delivery = await import('../delivery.js');
    const sent: string[] = [];
    delivery.registerOutboundGuard('divergence:refuse', () => ({
      effect: 'refuse',
      reason: 'it names a private value',
    }));
    const guarded = delivery.setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        sent.push(content);
        return 'sent';
      },
    });

    await expect(
      guarded.deliver('gchat', 'gchat:spaces/dm', null, 'chat', JSON.stringify({ text: 'x' })),
    ).rejects.toBeInstanceOf(delivery.OutboundRefusedError);
    expect(sent).toEqual([]);
  });

  it('reports a failed turn from the agent runner as a typed action', async () => {
    const pollLoop = await readFile(path.join(originalCwd, 'container/agent-runner/src/poll-loop.ts'), 'utf8');

    expect(pollLoop).toContain("action: 'turn_failed'");
  });
});

describe('recorded divergence: an adapter learns whether its inbound message was routed', () => {
  it("returns the host's routing promise from onInbound, rejecting when routing fails", async () => {
    const host = await readFile(path.join(originalCwd, 'src/index.ts'), 'utf8');
    const onInbound = host.slice(host.indexOf('onInbound(platformId, threadId, message) {'));
    const body = onInbound.slice(0, onInbound.indexOf('onInboundEvent('));

    expect(body).toContain('return inboundReady');
    expect(body).toContain("log.error('Failed to route inbound message'");
    expect(body).toMatch(/log\.error\('Failed to route inbound message'[^;]*;\s*throw err;/);
  });
});

describe('recorded divergence: a module can hold an inbound message until a time it names', () => {
  it("writes the time as the row's process_after, leaves its wake to the sweep, and reads back what waits", async () => {
    await freshInstall();
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    const createdAt = new Date().toISOString();
    await db.createAgentGroup({
      id: 'ag-1',
      name: 'Main',
      folder: 'main',
      agent_provider: null,
      created_at: createdAt,
    });
    await db.createMessagingGroup({
      id: 'mg-1',
      channel_type: 'gchat',
      platform_id: 'gchat:spaces/dm',
      name: 'Principal',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    await db.createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: createdAt,
    });
    await import('../mailbox/compose.js');
    const router = await import('../router.js');
    const { findSessionForAgent } = await import('../db/sessions.js');
    const { withExistingMailboxSession } = await import('../session-manager.js');
    const until = new Date(Date.now() + 4 * 60_000).toISOString();
    router.registerInboundDelay((event) => (event.message.id === 'held' ? until : null));
    const inbound = (id: string): InboundEvent => ({
      channelType: 'gchat',
      platformId: 'gchat:spaces/dm',
      threadId: null,
      message: { id, kind: 'chat', content: '{"text":"hello"}', timestamp: createdAt, isMention: true, isGroup: false },
    });
    external.requestWake.mockClear();

    await router.routeInbound(inbound('held'));
    expect(external.requestWake).not.toHaveBeenCalled();
    await router.routeInbound(inbound('due'));
    expect(external.requestWake).toHaveBeenCalledOnce();

    const session = await findSessionForAgent('ag-1', 'mg-1', null);
    expect(
      await withExistingMailboxSession('ag-1', session?.id ?? '', (mailbox) => mailbox.getWaitingMessages()),
    ).toEqual([{ id: 'held:ag-1', tries: 0, processAfter: until }]);
  });
});

describe("recorded divergence: the runner's tool barrel loads GWS-EA's tools", () => {
  it("loads the runner's email, reminder and request-status tools, which name their own capability keys", async () => {
    const tools = await readFile(path.join(originalCwd, 'container/agent-runner/src/mcp-tools/index.ts'), 'utf8');
    for (const module of ['gws-ea-email', 'reminders', 'request-status']) {
      expect(tools).toContain(`await import('./${module}.js');`);
    }
    expect(tools).not.toContain('gws-ea-meetings');
  });
});

describe('recorded divergence: each agent group has a capability list', () => {
  it('refuses a restricted agent behind a gateway that cannot narrow its credentials, at every spawn and adoption', async () => {
    await freshInstall();
    const registry = await import('../gateway-providers/gateway-provider-registry.js');
    const runner = await readFile(path.join(originalCwd, 'src/container-runner.ts'), 'utf8');

    const input = (credentialScope: GatewaySessionInput['credentialScope']): GatewaySessionInput => ({
      key: { installSlug: 'install', agentGroupId: 'g', sessionId: 's' },
      runtimeIdentity: 'install/g/s',
      groupName: 'g',
      containerName: 'agent',
      capabilities: {} as GatewaySessionInput['capabilities'],
      credentialScope,
    });
    const unscoped = {
      kind: 'unscoped',
      agentSkills: [],
      sessions: { ensure: vi.fn() },
      approvals: { subscribe: vi.fn() },
    } as unknown as Parameters<typeof registry.assertCredentialScopeEnforced>[0];
    expect(() =>
      registry.assertCredentialScopeEnforced(unscoped, input({ kind: 'only', credentials: [], modelDomains: [] })),
    ).toThrow(/does not enforce credential scopes/);
    expect(() => registry.assertCredentialScopeEnforced(unscoped, input({ kind: 'all' }))).not.toThrow();
    expect(runner).toContain('assertCredentialScopeEnforced(');
    expect(runner.split('credentialScope: await credentialScopeFor(').length - 1).toBe(3);
  });

  it('keeps send_file staging and cross-session context tied to capabilities in upstream files', async () => {
    const read = (file: string) => readFile(path.join(originalCwd, file), 'utf8');
    const core = await read('container/agent-runner/src/mcp-tools/core.ts');
    const fan = await read('src/modules/cross-session-context/fan.ts');
    const backfill = await read('src/modules/cross-session-context/backfill.ts');

    expect(core).toContain('outboxFilename(');
    for (const module of [fan, backfill]) expect(module).toContain('CONVERSATION_CONTEXT_CAPABILITY');
  });

  it("writes the group's explicit list into its container config, with its configured MCP servers only under mcp-servers", async () => {
    const { db } = await migratedInstall();
    const configs = await import('../db/container-configs.js');
    const { configFromDb } = await import('../container-config.js');
    const { resolveCapabilities } = await import('../capabilities.js');
    const group = agentGroup('ag-config');
    await db.createAgentGroup(group);
    await configs.ensureContainerConfig(group.id);
    await configs.updateContainerConfigJson(group.id, 'mcp_servers', { tools: { command: 'tools-server' } });
    const config = async () => configFromDb((await configs.getContainerConfig(group.id))!, group);

    const all = await config();
    expect(all.capabilities).toEqual(resolveCapabilities('all', group.name));
    expect(all.mcpServers).toEqual({ tools: expect.objectContaining({ command: 'tools-server' }) });
    await configs.updateContainerConfigJson(group.id, 'capabilities', ['reply']);
    const replyOnly = await config();
    expect(replyOnly.capabilities).toEqual(['reply']);
    expect(replyOnly.mcpServers).toEqual({});
  });

  it("changes a list only through ncl groups config update, refusing unknown keys and an agent naming another group's", async () => {
    const { db } = await migratedInstall();
    const { ensureContainerConfig, getContainerConfig } = await import('../db/container-configs.js');
    const { dispatch } = await import('../cli/dispatch.js');
    const { lookup } = await import('../cli/registry.js');
    await import('../cli/resources/index.js');
    for (const id of ['ag-own', 'ag-other']) {
      await db.createAgentGroup(agentGroup(id));
      await ensureContainerConfig(id);
    }
    const update = (capabilities: string) =>
      dispatch(
        { id: 'capabilities', command: 'groups-config-update', args: { id: 'ag-own', capabilities } },
        { caller: 'host' },
      );
    const stored = async (id: string): Promise<unknown> => JSON.parse((await getContainerConfig(id))!.capabilities!);

    expect(await update('reply,teleport')).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/unknown capability "teleport"/u) },
    });
    expect(await stored('ag-own')).toBe('all');
    expect(await update('time, reply')).toMatchObject({ ok: true });
    expect(await stored('ag-own')).toEqual(['reply', 'time']);
    // Even an approved request from an agent of any CLI scope.
    await expect(
      lookup('groups-config-update')!.handler(
        { id: 'ag-other', capabilities: 'reply' },
        { caller: 'agent', agentGroupId: 'ag-own', sessionId: 'session-1', messagingGroupId: 'mg-own' },
      ),
    ).rejects.toThrow(/only its own capabilities/u);
    expect(await stored('ag-other')).toBe('all');
  });

  it('gives the runner nothing for a missing list or a bare `all`, and reads a list of keys as given', async () => {
    // The runner reports a missing list on stderr; this guard reads the outcome.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The runner's own module, loaded by path: the host's build covers only `src/`.
    const config = (await import(path.join(originalCwd, 'container/agent-runner/src/config.ts'))) as RunnerConfigModule;

    expect([...config.runnerConfigFromRaw({}).capabilities]).toEqual([]);
    expect([...config.runnerConfigFromRaw({ capabilities: 'all' }).capabilities]).toEqual([]);
    expect([...config.runnerConfigFromRaw({ capabilities: ['reply'] }).capabilities]).toEqual(['reply']);
  });
});

/** The slice of the runner's config module (`container/agent-runner/src/config.ts`) the capability guard drives. */
interface RunnerConfigModule {
  runnerConfigFromRaw(raw: Record<string, unknown>): { readonly capabilities: ReadonlySet<string> };
}

describe('recorded divergence: the agent runner describes delivery so a sent reply is not followed by a note', () => {
  it('says a sent reply ends the turn, and never asks for every line to be wrapped, in the prompt, the nudge, or compaction', async () => {
    const runner = path.join(originalCwd, 'container/agent-runner/src');
    const destinations = await readFile(path.join(runner, 'destinations.ts'), 'utf8');
    const compaction = await readFile(path.join(runner, 'compact-instructions.ts'), 'utf8');
    const pollLoop = await readFile(path.join(runner, 'poll-loop.ts'), 'utf8');

    expect(destinations).toContain(
      'Wrap every reply in a `<message to="name">…</message>` block: text outside a block is not delivered',
    );
    expect(destinations).toContain(
      'When `send_message` has already delivered your reply, end the turn without another block',
    );
    expect(compaction).not.toContain('You MUST wrap all responses');
    expect(pollLoop).not.toContain('All output must be wrapped');
  });
});

describe('recorded divergence: a subagent cannot message the conversation', () => {
  it("refuses the delivery tools inside a subagent, in the Claude provider's tool hook", async () => {
    const provider = await readFile(path.join(originalCwd, 'container/agent-runner/src/providers/claude.ts'), 'utf8');

    expect(provider).toContain('if (i.agent_id !== undefined && SUBAGENT_DENIED_TOOLS.has(toolName)) {');
    for (const tool of [
      'send_message',
      'send_file',
      'edit_message',
      'add_reaction',
      'send_card',
      'ask_user_question',
    ]) {
      expect(provider).toContain(`'${tool}'`);
    }
  });
});

describe('recorded divergence: the agent image carries the pinned Google tool', () => {
  /** The Dockerfile with line continuations joined, so each instruction is one line. */
  async function dockerfileInstructions(): Promise<string[]> {
    const source = await readFile(path.join(originalCwd, 'container/Dockerfile'), 'utf8');
    return source.replace(/\\\n\s*/g, ' ').split('\n');
  }

  it("installs gog v0.43.0, checked against the release's SHA-256 for each architecture", async () => {
    const instructions = await dockerfileInstructions();
    const arg = (name: string) => instructions.find((line) => line.startsWith(`ARG ${name}=`))?.split('=')[1];

    expect(arg('GOGCLI_VERSION')).toBe('0.43.0');
    // From v0.43.0's checksums.txt, equal to the GitHub release's asset digests.
    expect(arg('GOGCLI_SHA256_AMD64')).toBe('a16d4b8b917e36b96b09b30ecb7a5049d06ff1e88b856a101eec12b86b33fe05');
    expect(arg('GOGCLI_SHA256_ARM64')).toBe('f66e3c9ab7664b7633d57d2d5303e0db75deb4045e1b32c3493c0d8ba68a70f7');
    const install = instructions.find((line) => line.startsWith('RUN') && line.includes('gogcli'));
    expect(install).toContain(
      'releases/download/v${GOGCLI_VERSION}/gogcli_${GOGCLI_VERSION}_linux_${TARGETARCH}.tar.gz',
    );
    expect(install).toMatch(/sha256sum -c - && .*install -m 0755 \/tmp\/gog \/usr\/local\/bin\/gog/);
  });

  it("sets none of gog's settings in the image; each spawn gives main its exact commands, with Gmail sending off", async () => {
    expect((await dockerfileInstructions()).filter((line) => /^ENV\b.*\bGOG_/u.test(line))).toEqual([]);

    await freshInstall();
    const { resolveCapabilities } = await import('../capabilities.js');
    await import('../modules/gws-ea-google/index.js');
    const { composeSessionSpec } = await import('../container-runner.js');
    const spawnEnv = (capabilities: readonly string[]) =>
      composeSessionSpec({
        agentGroup: { id: 'ag-main', name: 'main', folder: 'main', agent_provider: null, created_at: '' },
        session: { id: 'session-1', agent_group_id: 'ag-main' } as never,
        containerName: 'nanoclaw-v2-main-1700000000000',
        mounts: [],
        containerConfig: { capabilities: [...capabilities] } as never,
        mailboxEnvironment: {},
        contribution: {},
        gateway: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } },
      }).containers[0].contributedEnv ?? {};

    const main = spawnEnv(resolveCapabilities('all', 'main'));
    const commands = main.GOG_ENABLE_COMMANDS_EXACT?.split(',');
    expect(commands).toEqual(
      expect.arrayContaining([
        'calendar.events',
        'calendar.create',
        'calendar.update',
        'calendar.delete',
        'calendar.respond',
        'gmail.search',
        'gmail.thread.get',
        'people.search',
      ]),
    );
    for (const off of ['calendar.conflicts', 'gmail.send', 'gmail.thread.modify', 'gmail.drafts.create']) {
      expect(commands).not.toContain(off);
    }
    expect(main).toMatchObject({ GOG_ACCESS_TOKEN: 'gateway-managed', GOG_GMAIL_NO_SEND: '1' });
    expect(Object.keys(spawnEnv(['reply', 'shell'])).filter((key) => key.startsWith('GOG_'))).toEqual([]);
  });
});

/** A fresh install with a migrated central DB, which the guard closes when it ends. */
async function migratedInstall(): Promise<{ readonly install: string; readonly db: typeof import('../db/index.js') }> {
  const install = await freshInstall();
  const db = await import('../db/index.js');
  // The capability column, as the host's module barrel registers it.
  await import('../modules/capabilities/index.js');
  await db.runMigrations(await db.initTestDb());
  cleanups.push(() => db.closeDb());
  return { install, db };
}

function agentGroup(id: string): AgentGroup {
  return { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() };
}

describe('recorded divergence: a module can refuse a session before it starts', () => {
  it('runs every registered session admission policy before the gateway is asked to start a session', async () => {
    await freshInstall();
    const runner = await import('../container-runner.js');
    const source = await readFile(path.join(originalCwd, 'src/container-runner.ts'), 'utf8');
    runner.registerSessionAdmissionPolicy('divergence:refuse', ({ key }) => {
      if (key.agentGroupId === 'drifted-group') throw new Error('its configuration drifted');
    });
    const session = (agentGroupId: string): Parameters<typeof runner.assertSessionAdmitted>[0] => ({
      disposition: 'adopt',
      key: { installSlug: 'install', agentGroupId, sessionId: 'session-1' },
      credentialScope: { kind: 'all' },
    });

    await expect(runner.assertSessionAdmitted(session('drifted-group'))).rejects.toThrow('its configuration drifted');
    await expect(runner.assertSessionAdmitted(session('other-group'))).resolves.toBeUndefined();
    // Spawn and adoption both start their gateway session here; admission runs before the gateway is asked.
    const ensure = source.slice(source.indexOf('async function ensureGatewaySession('));
    expect(ensure.slice(0, ensure.indexOf('const controller = new AbortController();'))).toContain(
      'await assertSessionAdmitted({',
    );
  });
});

describe('recorded divergence: a group without conversation-context keeps its sessions sealed', () => {
  it("declares Claude's home as conversation state, which a sealed session holds on its own", async () => {
    await freshInstall();
    const registry = await import('../provider-contracts/registry.js');
    await import('../provider-contracts/index.js');
    const claude = registry.getProviderHostContract('claude')!;
    const home = (contract: typeof claude) => contract.stateVolumes.find((volume) => volume.id === 'claude-home');

    expect(home(claude)).toMatchObject({ scope: 'group', sealedScope: 'session' });
    const sealed = registry.sealedSessionContract(claude);
    expect(home(sealed)).toMatchObject({ scope: 'session' });
    expect(home(sealed)).not.toHaveProperty('sealedScope');
    expect(sealed.skillBackings.find((backing) => backing.id === 'claude-skills')).toMatchObject({
      templateCopies: 'copy',
    });

    const withHome = (volume: Partial<ProviderStateVolume>) => ({
      ...claude,
      stateVolumes: claude.stateVolumes.map((candidate) =>
        candidate.id === 'claude-home' ? { ...candidate, ...volume } : candidate,
      ),
    });
    expect(() => registry.assertProviderHostContractShape('claude', claude)).not.toThrow();
    expect(() => registry.assertProviderHostContractShape('claude', withHome({ scope: 'session' }))).toThrow(
      /sealedScope applies only to a group volume/,
    );
    expect(() =>
      registry.assertProviderHostContractShape(
        'claude',
        withHome({ sealedScope: 'group' as unknown as ProviderStateVolume['sealedScope'] }),
      ),
    ).toThrow(/sealedScope/);
  });

  it("mounts each sealed session its own Claude home, seeded with settings, and a shared group's sessions one home", async () => {
    const { install, db } = await migratedInstall();
    const { ensureContainerConfig } = await import('../db/container-configs.js');
    const { initGroupFilesystem } = await import('../group-init.js');
    const { resolveCapabilities } = await import('../capabilities.js');
    const { buildMounts } = await import('../container-runner.js');
    const group = agentGroup('ag-sealed');
    await db.createAgentGroup(group);
    await ensureContainerConfig(group.id);
    await initGroupFilesystem(group, {});
    const claudeHome = async (capabilities: readonly string[], sessionId: string) => {
      const config: ContainerConfig = {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: [],
        capabilities: [...capabilities],
      };
      const session = { id: sessionId, agent_group_id: group.id } as Session;
      const mounts = await buildMounts(group, session, config, 'claude', {});
      return mounts.find((mount) => mount.containerPath === '/home/node/.claude')?.hostPath;
    };
    const sessions = path.join(install, 'data', 'v2-sessions', group.id);

    expect(await claudeHome(['reply'], 'thread-1')).toBe(path.join(sessions, 'thread-1', '.claude-shared'));
    expect(await claudeHome(['reply'], 'thread-2')).toBe(path.join(sessions, 'thread-2', '.claude-shared'));
    expect(existsSync(path.join(sessions, 'thread-1', '.claude-shared', 'settings.json'))).toBe(true);
    const all = resolveCapabilities('all', 'divergence');
    expect(await claudeHome(all, 'thread-1')).toBe(path.join(sessions, '.claude-shared'));
    expect(await claudeHome(all, 'thread-2')).toBe(path.join(sessions, '.claude-shared'));
    // The provider contribution is realized from the same sealed contract as the mounts.
    const runner = await readFile(path.join(originalCwd, 'src/container-runner.ts'), 'utf8');
    expect(runner.split('sessionHostContract(provider, containerConfig.capabilities)').length - 1).toBe(2);
  });

  it("keeps a sealed session's runner from scaffolding memory, installing its hook, or archiving its conversation", async () => {
    const read = (file: string) => readFile(path.join(originalCwd, 'container/agent-runner/src', file), 'utf8');
    const entry = await read('index.ts');
    const contract = await read('provider-contracts/claude.ts');
    const hook = await read('memory/session-hook.ts');

    expect(entry).toContain('prepareSessionMemory(sealed)');
    expect(entry).toContain('if (sealed) delete provider.onExchangeComplete;');
    expect(contract).toContain('if (hook.sources.length > 0)');
    expect(hook).toMatch(
      /export const SEALED_MEMORY_SESSION_HOOK: MemorySessionHookRegistration = \{[^}]*sources: \[\],/u,
    );
  });
});

describe('recorded divergence: a module can refuse a destination on every write path', () => {
  it('refuses a destination a registered policy refuses, writing no row, and writes the ones it admits', async () => {
    const { db } = await migratedInstall();
    const admission = await import('../db/wiring-admission.js');
    const { createDestination } = await import('../modules/agent-to-agent/db/agent-destinations.js');
    for (const id of ['ag-a', 'ag-protected']) await db.createAgentGroup(agentGroup(id));
    admission.registerDestinationAdmissionPolicy('divergence:protected', ({ proposed }) =>
      proposed.target_id === 'ag-protected' ? 'nothing reaches the protected group' : undefined,
    );
    const destination = (localName: string, targetId: string) => ({
      agent_group_id: 'ag-a',
      local_name: localName,
      target_type: 'agent' as const,
      target_id: targetId,
      created_at: new Date().toISOString(),
    });

    await expect(createDestination(destination('protected', 'ag-protected'))).rejects.toBeInstanceOf(
      admission.DestinationRefusedError,
    );
    await createDestination(destination('self', 'ag-a'));
    expect(await db.getDb().all('SELECT local_name FROM agent_destinations')).toEqual([{ local_name: 'self' }]);
  });

  it('judges the destinations ncl destinations add and create_agent write, through the same seam', async () => {
    const read = (file: string) => readFile(path.join(originalCwd, file), 'utf8');
    const writer = await read('src/modules/agent-to-agent/db/agent-destinations.ts');
    const createAgent = await read('src/modules/agent-to-agent/create-agent.ts');
    const cli = await read('src/cli/resources/destinations.ts');

    expect(writer).toContain('await assertDestinationAdmitted({ proposed: row });');
    // create_agent judges both of its rows before it writes the group, so a refusal leaves nothing behind.
    expect(createAgent).toContain('destinationRefusal({ proposed })');
    expect(createAgent.indexOf('destinationRefusal({ proposed })')).toBeLessThan(
      createAgent.indexOf('const newGroup: AgentGroup = {'),
    );
    expect(cli).toContain('await createDestination({');
    expect(cli).not.toContain('INSERT INTO agent_destinations');
  });
});

describe('recorded divergence: instructions follow the capabilities that use them', () => {
  it("keeps memory, conversation history, account connection, and ncl out of the base instructions, and the file tools out of reply's", async () => {
    const read = (file: string) => readFile(path.join(originalCwd, file), 'utf8');
    const base = await read('container/CLAUDE.md');
    const core = await read('container/agent-runner/src/mcp-tools/core.instructions.md');

    for (const heading of ['## Memory', '## Conversation history', '## Connecting external accounts']) {
      expect(base).not.toContain(heading);
    }
    expect(base).not.toMatch(/\bncl\b/u);
    for (const tool of ['send_file', 'add_reaction', 'edit_message']) expect(core, tool).not.toContain(tool);
    expect(await read('container/agent-runner/src/mcp-tools/connect.instructions.md')).toContain(
      '## Connecting external accounts',
    );
    expect(await read('container/agent-runner/src/mcp-tools/memory.instructions.md')).toContain('## Memory');
    expect(await read('src/project-doc-compose.ts')).toContain(
      'renderBaseInstructions(instructions, spec.instructions)',
    );
  });

  it("composes a reply-only group's document with no ncl, file tools, account connection, or memory, and an `all` group's with each", async () => {
    const { install, db } = await migratedInstall();
    await mkdir(path.join(install, 'container'));
    for (const entry of ['CLAUDE.md', 'agent-runner']) {
      await symlink(path.join(originalCwd, 'container', entry), path.join(install, 'container', entry));
    }
    const configs = await import('../db/container-configs.js');
    const { composeGroupProjectDoc } = await import('../project-doc-compose.js');
    const compose = async (id: string, capabilities: readonly string[] | 'all') => {
      const group = agentGroup(id);
      await db.createAgentGroup(group);
      await configs.ensureContainerConfig(id);
      await configs.updateContainerConfigJson(id, 'capabilities', capabilities);
      const directory = path.join(install, 'groups', id);
      await composeGroupProjectDoc(group, directory, { fileName: 'CLAUDE.md' });
      const doc = await readFile(path.join(directory, 'CLAUDE.md'), 'utf8');
      // The composed-at-spawn header is an operator's marker, not instruction.
      return doc.slice(doc.indexOf('\n'));
    };

    const reply = await compose('ag-reply', ['reply']);
    expect(reply).not.toMatch(/\bncl\b/u);
    expect(reply).not.toContain('send_file');
    expect(reply).not.toContain('## Memory');
    expect(reply).not.toContain('## Connecting external accounts');
    const all = await compose('ag-all', 'all');
    expect(all).toMatch(/\bncl\b/u);
    expect(all).toContain('send_file');
    expect(all).toContain('## Memory');
    expect(all).toContain('## Connecting external accounts');
  });
});

describe("recorded divergence: a protected agent group is the host's alone", () => {
  it('denies its self-modification requests rather than carding them for approval', async () => {
    await freshInstall();
    const { guard } = await import('../guard/index.js');
    const { registerProtectedGroupPolicy } = await import('../cli/guard.js');
    const drivers = await import('../drivers/index.js');
    const { DockerSessionDriver } = await import('../drivers/docker-driver.js');
    const { FIXTURE_POLICY } = await import('../drivers/spec-fixture.js');
    const { selfModAddMcpServer, selfModInstallPackages } = await import('../modules/self-mod/guard.js');
    // A runtime that can rebuild images, so install_packages reaches the group check.
    drivers.resetSessionDriver(new DockerSessionDriver(FIXTURE_POLICY));
    cleanups.push(async () => drivers.resetSessionDriver(null));
    registerProtectedGroupPolicy('divergence:protected', (agentGroupId) =>
      agentGroupId === 'g' ? 'it is the host’s alone' : undefined,
    );
    const actor = (agentGroupId: string) => ({ kind: 'agent', agentGroupId, sessionId: 'session-1' }) as const;

    for (const action of [selfModInstallPackages, selfModAddMcpServer]) {
      const payload = { apt: ['jq'], name: 'tools' };
      expect(await guard(action, { actor: actor('g'), payload }), action.action).toMatchObject({ effect: 'deny' });
      expect(await guard(action, { actor: actor('ag-other'), payload }), action.action).toMatchObject({
        effect: 'hold',
      });
    }
  });
});

describe('recorded divergence: a module can refuse a role grant', () => {
  it('refuses a grant a registered policy refuses, on the module writer and the ncl roles grant path', async () => {
    const { db } = await migratedInstall();
    const roles = await import('../modules/permissions/db/user-roles.js');
    const { upsertUser } = await import('../modules/permissions/db/users.js');
    const now = new Date().toISOString();
    for (const id of ['email:sam@example.test', 'gchat:users/principal']) {
      await upsertUser({ id, kind: id.split(':')[0]!, display_name: id, created_at: now });
    }
    roles.registerRoleGrantPolicy('divergence:no-email-privilege', (grant) =>
      grant.user_id.startsWith('email:') ? 'an email identity never holds a role' : undefined,
    );
    const grant = (userId: string) => ({
      user_id: userId,
      role: 'owner' as const,
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });

    await expect(roles.grantRole(grant('email:sam@example.test'))).rejects.toThrow(
      'an email identity never holds a role',
    );
    await roles.grantRole(grant('gchat:users/principal'));
    expect(await db.getDb().all('SELECT user_id FROM user_roles')).toEqual([{ user_id: 'gchat:users/principal' }]);
    const cli = await readFile(path.join(originalCwd, 'src/cli/resources/roles.ts'), 'utf8');
    expect(cli).toContain('assertRoleGrantAdmitted({');
    expect(cli.indexOf('assertRoleGrantAdmitted({')).toBeLessThan(cli.indexOf('INSERT INTO user_roles'));
  });
});

/** Run a program to completion with its output collected. */
function runProgram(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe("recorded divergence: NanoClaw's update helpers act on the install they are given", () => {
  type UpdateHelpers = Pick<NanoclawServiceHelpers, 'createCommandRunner' | 'detectService' | 'drainContainers'>;

  /** `scripts/update/service.ts`, loaded by path: the host's build covers only `src/`. */
  async function updateHelpers(): Promise<UpdateHelpers> {
    return (await import(path.join(originalCwd, 'scripts/update/service.ts'))) as UpdateHelpers;
  }

  it("detects and drains the named install's service and containers, not those the checkout derives", async () => {
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-divergence-home-')));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const label = 'com.nanoclaw-v2-gwsguard';
    await mkdir(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(path.join(home, 'Library', 'LaunchAgents', `${label}.plist`), '');
    const commands: string[] = [];
    const runner: NanoclawCommandRunner = {
      run: () => '',
      tryRun: (command, args) => {
        commands.push([command, ...args].join(' '));
        return { ok: true, stdout: '' };
      },
    };
    const env: NanoclawServiceEnvironment = {
      platform: 'darwin',
      home,
      uid: 501,
      runner,
      installSlug: 'gwsguard',
      sleep: async () => undefined,
    };
    // What the checkout alone would name: this process's install ID.
    vi.stubEnv('NANOCLAW_INSTALL_ID', 'another-install');
    vi.stubEnv('CONTAINER_RUNTIME', 'docker');
    const helpers = await updateHelpers();

    expect(helpers.detectService(path.join(home, 'checkout'), env)).toMatchObject({
      mode: 'launchd',
      name: label,
      active: true,
    });
    await helpers.drainContainers(path.join(home, 'checkout'), env);
    expect(commands).toEqual([
      `launchctl print gui/501/${label}`,
      'docker ps -q --filter label=nanoclaw-install=gwsguard',
    ]);
  });

  it('runs every command with the environment it was given, and only that', async () => {
    vi.stubEnv('GWS_EA_DIVERGENCE_AMBIENT', 'ambient');
    const helpers = await updateHelpers();
    const runner = helpers.createCommandRunner({ env: { GWS_EA_DIVERGENCE_GIVEN: 'given' } });

    expect(
      runner.run(process.execPath, [
        '-e',
        'process.stdout.write(String(process.env.GWS_EA_DIVERGENCE_GIVEN) + "/" + String(process.env.GWS_EA_DIVERGENCE_AMBIENT))',
      ]),
    ).toBe('given/undefined');
  });

  it('snapshots the mutable paths NanoClaw declares in src/, the list gws-ea carries at cutover', async () => {
    const transaction = await readFile(path.join(originalCwd, 'scripts/update/transaction.ts'), 'utf8');

    expect(transaction).toContain("import { MUTABLE_PATHS } from '../../src/mutable-paths.js';");
    expect(transaction).not.toMatch(/\bconst MUTABLE_PATHS\b/u);
  });

  it("names the install's service and image from NANOCLAW_INSTALL_ID in the shell helpers, as the TS helper does", async () => {
    const { getInstallScopedNames } = await import('../install-slug.js');
    const names = (installId: string) =>
      runProgram(
        'bash',
        [
          '-c',
          '. "$1" && container_image_base && printf "\\n" && launchd_label',
          'install-slug',
          path.join(originalCwd, 'setup/lib/install-slug.sh'),
        ],
        { cwd: os.tmpdir(), env: { PATH: process.env.PATH, NANOCLAW_INSTALL_ID: installId } },
      );

    const expected = getInstallScopedNames('gwsguard');
    expect(await names('gwsguard')).toMatchObject({
      status: 0,
      stdout: `${expected.containerImageBase}\n${expected.launchdLabel}`,
    });
    expect(await names('Not An ID')).toMatchObject({ status: 1, stdout: '' });
  });
});

describe('recorded divergence: the migration script applies module migrations', () => {
  it('records the capabilities and gws-ea module migrations in a fresh central database', async () => {
    const install = await freshInstall();
    const run = await runProgram(
      process.execPath,
      ['--import', TSX_LOADER, path.join(originalCwd, 'scripts/migrate.ts')],
      {
        cwd: install,
        env: process.env,
      },
    );
    expect(run, run.stderr).toMatchObject({ status: 0 });

    const central = new Database(path.join(install, 'data', 'v2.db'), { readonly: true });
    try {
      const applied = central.prepare('SELECT name FROM schema_version').all() as Array<{ name: string }>;
      expect(applied.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          'module:capabilities:container-config-capabilities',
          'module:gws-ea-profile:create-profile',
        ]),
      );
    } finally {
      central.close();
    }
  });
});

describe("recorded divergence: the host's own sends pass the outbound guards, and only a channel asserts a sender", () => {
  it('hands the guarded delivery adapter to the approval coordinator and the host modules', async () => {
    const host = await readFile(path.join(originalCwd, 'src/index.ts'), 'utf8');

    expect(host).toContain('const guardedDelivery = setDeliveryAdapter(deliveryAdapter);');
    expect(host).toMatch(/startGatewayApprovalCoordinator\(gatewayProvider, guardedDelivery,/u);
    expect(host).toContain('startHostModules({ db, deliveryAdapter: guardedDelivery,');
  });

  it("forwards a channel's authenticated sender, and drops one an admin transport's routed event carries", async () => {
    const host = await readFile(path.join(originalCwd, 'src/index.ts'), 'utf8');
    const onInbound = host.slice(host.indexOf('onInbound(platformId, threadId, message) {'));
    const channelMessage = onInbound.slice(0, onInbound.indexOf('onInboundEvent('));
    const adminEvent = onInbound.slice(onInbound.indexOf('onInboundEvent('), onInbound.indexOf('onMetadata('));

    expect(channelMessage).toContain('authenticatedSender: message.authenticatedSender,');
    expect(adminEvent).toContain('authenticatedSender: undefined,');
    expect(adminEvent).toContain("deduplicate: adapter.channelType === 'cli' ? event.message.deduplicate : undefined,");
  });
});

describe('recorded divergence: the base checkout composes the secured Google Chat channel', () => {
  /** The slice of `scripts/skill-directives.ts` this guard drives. */
  interface SkillDirectives {
    parseDirectives(markdown: string): ReadonlyArray<{ readonly kind: string; readonly body: readonly string[] }>;
  }

  it('pins the Chat SDK core to the Google Chat adapter, and add-gchat neither copies over nor removes the adapter', async () => {
    const read = (file: string) => readFile(path.join(originalCwd, file), 'utf8');
    const manifest = JSON.parse(await read('package.json')) as { dependencies: Record<string, string> };
    const adapterVersion = manifest.dependencies['@chat-adapter/gchat'];
    const { parseDirectives } = (await import(
      path.join(originalCwd, 'scripts/skill-directives.ts')
    )) as SkillDirectives;
    const skill = parseDirectives(await read('.claude/skills/add-gchat/SKILL.md'));

    expect(adapterVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(manifest.dependencies.chat).toBe(adapterVersion);
    expect(skill.filter((directive) => directive.kind === 'copy').flatMap((directive) => directive.body)).toEqual([
      'src/channels/gchat-registration.test.ts',
    ]);
    expect(skill.filter((directive) => directive.kind === 'dep').flatMap((directive) => directive.body)).toEqual([
      `@chat-adapter/gchat@${adapterVersion}`,
    ]);
    expect(await read('.claude/skills/add-gchat/REMOVE.md')).not.toMatch(/\brm\b[^\n]*src\/channels\/gchat\.ts/u);
  });
});
