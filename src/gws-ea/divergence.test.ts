/**
 * Guards for gws-ea's recorded differences from upstream NanoClaw.
 *
 * Each guard drives the real upstream-owned module through the behavior gws-ea
 * depends on, so a skill refresh or upstream update that drops a recorded
 * divergence fails this suite, not a live assistant. Only effects outside the
 * guarded modules are replaced: container wake-up, launchd and Docker behind
 * the update helpers' command runner, and the OneCLI servers behind `fetch`.
 * Modules outside `src/` (scripts and the agent
 * runner) load by path, since the host's build covers only `src/`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GoogleChatAdapter } from '@chat-adapter/gchat';
import Database from 'better-sqlite3';
import { Message, parseMarkdown, type Adapter, type ChatInstance } from 'chat';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent, InboundMessage } from '../channels/adapter.js';
import type { ContainerConfig } from '../container-config.js';
import type { GatewayApprovalRequest, GatewaySessionInput } from '../gateway-providers/gateway-provider-registry.js';
import type { ProviderStateVolume } from '../provider-contracts/registry.js';
import type { AgentGroup, PendingApproval, Session } from '../types.js';
import { CONTROL_PLANE_ROOT } from './paths.js';
import type { NanoclawCommandRunner, NanoclawServiceEnvironment, NanoclawServiceHelpers } from './service-control.js';

const external = vi.hoisted(() => ({ requestWake: vi.fn(async () => true) }));

// Recording pass-throughs: the real modules run; the guards read what they were given.
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

describe('recorded divergence: the installed OneCLI adapter', () => {
  it('is exactly what add-onecli installs: every file it copies equals its payload source', async () => {
    const skill = path.join(originalCwd, '.claude/skills/add-onecli');
    const fence = /^```nc:copy\n([\s\S]*?)^```$/mu.exec(await readFile(path.join(skill, 'SKILL.md'), 'utf8'))?.[1];
    const copies = (fence ?? '')
      .split('\n')
      .map((line) => /^(\S+) -> (\S+)$/u.exec(line.trim()))
      .filter((match) => match !== null);

    expect(copies.map(([, , installed]) => installed)).toEqual(
      expect.arrayContaining(['src/gateway-providers/onecli.ts', 'src/gateway-providers/onecli-credentials.ts']),
    );
    for (const [, source, installed] of copies) {
      expect(await readFile(path.join(originalCwd, installed!), 'utf8'), installed).toBe(
        await readFile(path.join(skill, source!), 'utf8'),
      );
    }
  });

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

describe('recorded divergence: the Chat SDK bridge names the message a reply quotes, and marks a redelivered platform retry-safe', () => {
  it("hands the agent the reply hook's message id, and marks each inbound of a platform that redelivers", async () => {
    await freshInstall();
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    const { createChatSdkBridge } = await import('../channels/chat-sdk-bridge.js');
    // A polling adapter, so the bridge binds no webhook port; every thread is a DM.
    const adapter = {
      name: 'stubchat',
      userName: 'morgan',
      runtimeMode: 'polling',
      initialize: async () => undefined,
      isDM: () => true,
      channelIdFromThreadId: (threadId: string) => threadId.replace(/:dm$/u, ''),
    } as unknown as Adapter;
    const routed: InboundMessage[] = [];
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      redelivers: true,
      extractReplyContext: (raw) => ({ id: String(raw.quoted), sender: 'Morgan Ellery', text: 'Lunch at 1?' }),
    });
    await bridge.setup({
      onInbound: async (_platformId, _threadId, message) => {
        routed.push(message);
      },
      onInboundEvent: () => undefined,
      onMetadata: () => undefined,
      onAction: () => undefined,
    });
    cleanups.push(() => bridge.teardown());

    await (bridge as unknown as { _chat: ChatInstance })._chat.processMessage(
      adapter,
      'stubchat:dm-1:dm',
      new Message({
        id: 'reply-2',
        threadId: 'stubchat:dm-1:dm',
        text: 'yes',
        formatted: parseMarkdown('yes'),
        raw: { quoted: 'question-1' },
        author: { userId: 'u-1', userName: 'Juno Hale', fullName: 'Juno Hale', isBot: false, isMe: false },
        metadata: { dateSent: new Date(), edited: false },
        attachments: [],
      }),
    );

    expect(routed).toEqual([expect.objectContaining({ id: 'reply-2', deduplicate: true })]);
    expect((routed[0]!.content as { replyTo?: unknown }).replyTo).toEqual({
      id: 'question-1',
      sender: 'Morgan Ellery',
      text: 'Lunch at 1?',
    });
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
  it('rechecks a mailbox source session after guards await, while direct host sends remain available', async () => {
    await freshInstall();
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    await db.createAgentGroup({
      id: 'source',
      name: 'Source',
      folder: 'source',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const { createSession, updateSession } = await import('../db/sessions.js');
    await createSession({
      id: 'old-conversation',
      agent_group_id: 'source',
      messaging_group_id: null,
      thread_id: 'system:proof',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
    const delivery = await import('../delivery.js');
    delivery.registerOutboundGuard('divergence:close-source', async () => {
      await updateSession('old-conversation', { status: 'closed' });
      return { effect: 'allow' };
    });
    const sent = vi.fn(async () => 'posted');
    const guarded = delivery.setDeliveryAdapter({ deliver: sent });
    await expect(
      guarded.deliver(
        'gchat',
        'spaces/chat',
        null,
        'chat',
        '{"text":"old"}',
        undefined,
        undefined,
        'old-row',
        new Date().toISOString(),
        'old-conversation',
      ),
    ).rejects.toBeInstanceOf(delivery.OutboundRefusedError);
    expect(sent).not.toHaveBeenCalled();
    await guarded.deliver('gchat', 'spaces/chat', null, 'chat', '{"text":"host notice"}');
    expect(sent).toHaveBeenCalledTimes(1);
  });
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

  it('reports a failed turn from the agent runner as a typed action, and never as a chat notice', async () => {
    const pollLoop = await readFile(path.join(originalCwd, 'container/agent-runner/src/poll-loop.ts'), 'utf8');

    expect(pollLoop).toContain("action: 'turn_failed'");
    // Upstream's runner writes its failure notice to the turn's route, which for
    // external-email is the counterpart's email thread (#3908, #3994).
    expect(pollLoop).not.toContain('deliverErrorResult');
    expect(pollLoop).not.toContain('FAILURE_NOTICE_FIELD');
    // GWS-EA: the report, and each message the turn writes to a person, name the batch it answered (Slice 5 KTD12).
    expect(pollLoop).toContain('...(routing.batch === undefined ? {} : { batch: routing.batch })');
    const messagesOut = await readFile(path.join(originalCwd, 'container/agent-runner/src/db/messages-out.ts'), 'utf8');
    expect(messagesOut).toContain('mergeEntries(msg.content, { batch })');
  });
});

describe('recorded divergence: a module can read the inbound messages a failure names', () => {
  it('reads each named message, whatever its status, with its kind, series, route and content', async () => {
    const { INBOUND_SCHEMA } = await import('../mailbox/sqlite/schema.js');
    const { wrapSqliteInbound } = await import('../mailbox/sqlite/index.js');
    const db = new Database(':memory:');
    cleanups.push(async () => {
      db.close();
    });
    db.exec(INBOUND_SCHEMA);
    const inbound = wrapSqliteInbound(db);
    const content = '{"senderId":"users/morgan","text":"Is Thursday still on?"}';
    await inbound.insertMessage({
      id: 'in-1',
      kind: 'chat-sdk',
      timestamp: '2026-10-10T09:00:00.000Z',
      platformId: 'gchat:spaces/dm',
      channelType: 'gchat',
      threadId: null,
      content,
      processAfter: null,
      recurrence: null,
    });
    inbound.markMessageFailed('in-1');

    expect(inbound.getInboundMessages(['in-1', 'in-gone'])).toEqual([
      {
        id: 'in-1',
        kind: 'chat-sdk',
        seriesId: 'in-1',
        channelType: 'gchat',
        platformId: 'gchat:spaces/dm',
        threadId: null,
        content,
      },
    ]);
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

describe('recorded divergence: disconnected adapters keep durable sends pending', () => {
  it('spends no attempt while disconnected and passes the same row id into the native adapter after recovery', async () => {
    await freshInstall();
    await import('../mailbox/compose.js');
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    const created_at = new Date().toISOString();
    await db.createAgentGroup({ id: 'ag-1', name: 'Robin', folder: 'main', agent_provider: null, created_at });
    await db.createMessagingGroup({
      id: 'mg-1',
      channel_type: 'whatsapp',
      platform_id: 'principal-dm',
      name: 'Principal',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at,
    });
    const manager = await import('../session-manager.js');
    const { session } = await manager.resolveSession('ag-1', 'mg-1', null, 'shared');
    await manager.writeOutboundDirect('ag-1', session.id, {
      id: 'durable-send',
      kind: 'chat',
      platformId: 'principal-dm',
      channelType: 'whatsapp',
      threadId: null,
      content: JSON.stringify({ text: 'Thursday works.' }),
    });
    const delivery = await import('../delivery.js');
    const { ChannelNotConnectedError } = await import('../channels/adapter.js');
    delivery.setDeliveryAdapter({
      async deliver() {
        throw new ChannelNotConnectedError();
      },
    });
    await delivery.deliverSessionMessages(session);
    expect(
      await db.getDb().get('SELECT 1 FROM delivery_attempts WHERE message_id = ?', 'durable-send'),
    ).toBeUndefined();
    expect(await manager.withMailboxSession('ag-1', session.id, (mailbox) => mailbox.getDeliveredIds())).toEqual(
      new Set(),
    );

    const registry = await import('../channels/channel-registry.js');
    const sent: Array<{ id?: string; timestamp?: string }> = [];
    registry.registerChannelAdapter('whatsapp', {
      factory: () => ({
        name: 'whatsapp',
        channelType: 'whatsapp',
        supportsThreads: false,
        async setup() {},
        async teardown() {},
        isConnected: () => true,
        async deliver(_platform, _thread, message, messageId) {
          sent.push({ id: messageId, timestamp: message.timestamp });
          return 'platform-send';
        },
      }),
    });
    await registry.initChannelAdapters(() => ({ onInbound() {}, onInboundEvent() {}, onMetadata() {}, onAction() {} }));
    cleanups.push(() => registry.teardownChannelAdapters());
    delivery.setDeliveryAdapter(registry.createChannelDeliveryAdapter());
    await delivery.deliverSessionMessages(session);
    await delivery.deliverSessionMessages(session);
    expect(sent).toEqual([{ id: 'durable-send', timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u) }]);
  });
  it('keeps a spent task session open while its reply waits for the channel', async () => {
    await freshInstall();
    await import('../mailbox/compose.js');
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    const created_at = new Date().toISOString();
    await db.createAgentGroup({ id: 'ag-1', name: 'Robin', folder: 'main', agent_provider: null, created_at });
    await db.createMessagingGroup({
      id: 'mg-1',
      channel_type: 'whatsapp',
      platform_id: 'principal-dm',
      name: 'Principal',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at,
    });
    const manager = await import('../session-manager.js');
    const { session } = await manager.resolveSession('ag-1', 'mg-1', 'system:tasks:reminder', 'per-thread');
    await manager.writeOutboundDirect('ag-1', session.id, {
      id: 'task-reply',
      kind: 'chat',
      platformId: 'principal-dm',
      channelType: 'whatsapp',
      threadId: null,
      content: JSON.stringify({ text: 'Your cabin choice is due today.' }),
    });
    const delivery = await import('../delivery.js');
    const { ChannelNotConnectedError } = await import('../channels/adapter.js');
    delivery.setDeliveryAdapter({
      async deliver() {
        throw new ChannelNotConnectedError();
      },
    });
    await delivery.deliverSessionMessages(session);
    const { reconcileSession } = await import('../reconcile-session.js');
    const { getSession } = await import('../db/sessions.js');
    await reconcileSession(session.id);
    expect((await getSession(session.id))?.status).toBe('active');
  });
});

describe('recorded divergence: request-addressed conversation reminders', () => {
  it('keeps one native task when an interrupted request is replayed and retains random identities for other callers', async () => {
    await freshInstall();
    await import('../mailbox/compose.js');
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    const created_at = new Date().toISOString();
    await db.createAgentGroup({
      id: 'reminder-agent',
      name: 'Robin',
      folder: 'reminder-agent',
      agent_provider: null,
      created_at,
    });
    await db.createMessagingGroup({
      id: 'reminder-chat',
      channel_type: 'whatsapp',
      platform_id: 'trip@g.us',
      name: 'Trip',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at,
    });
    const manager = await import('../session-manager.js');
    const { session } = await manager.resolveSession('reminder-agent', 'reminder-chat', null, 'shared');
    const { createScheduledTask } = await import('../modules/scheduling/create.js');
    const task = {
      prompt: 'Remind the group to choose a cabin.',
      recurrence: null,
      script: null,
      processAfter: new Date(Date.now() + 60_000).toISOString(),
    };
    const first = await createScheduledTask('reminder-agent', task, { session, id: 'chat-reminder-request-1' });
    const replay = await createScheduledTask('reminder-agent', task, { session, id: 'chat-reminder-request-1' });
    expect(first.row.id).toBe('chat-reminder-request-1');
    expect(replay.row.id).toBe(first.row.id);
    await manager.withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      expect(mailbox.listLiveTasks()).toHaveLength(1);
      expect(mailbox.listLiveTasks()[0]?.content).toContain('"inConversation":true');
    });
    const ordinary = await createScheduledTask('reminder-agent', task, { session });
    const another = await createScheduledTask('reminder-agent', task, { session });
    expect(ordinary.row.id).not.toBe(another.row.id);
    await manager.withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      expect(mailbox.listLiveTasks()).toHaveLength(3);
    });
  });
});

describe('recorded divergence: prepared module engagement and destination-free chat wirings', () => {
  it('keeps silent context, wakes only on the module decision, and orders host work in the conversation tail', async () => {
    await freshInstall();
    await import('../mailbox/compose.js');
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    const created_at = new Date().toISOString();
    await db.createAgentGroup({ id: 'ag-1', name: 'Robin', folder: 'main', agent_provider: null, created_at });
    await db.createMessagingGroup({
      id: 'mg-1',
      channel_type: 'whatsapp',
      platform_id: 'trip',
      name: 'Lake trip',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at,
    });
    await db.createMessagingGroupAgent(
      {
        id: 'wiring',
        messaging_group_id: 'mg-1',
        agent_group_id: 'ag-1',
        engage_mode: 'module',
        engage_pattern: null,
        sender_scope: 'all',
        ignored_message_policy: 'accumulate',
        session_mode: 'shared',
        priority: 0,
        created_at,
      },
      { companionDestination: false },
    );
    expect(await db.getDb().all('SELECT * FROM agent_destinations')).toEqual([]);
    const router = await import('../router.js');
    const preparation = await import('../inbound-preparation.js');
    preparation.registerInboundPreparer(({ content }) => Promise.resolve(content.replace('voice', 'Robin')));
    const order: string[] = [];
    router.registerEngagementDecider('whatsapp', ({ event }) => {
      order.push(event.message.id);
      return event.message.content.includes('Robin');
    });
    const event = (id: string, text: string): InboundEvent => ({
      channelType: 'whatsapp',
      platformId: 'trip',
      threadId: null,
      message: {
        id,
        kind: 'chat',
        content: JSON.stringify({ text }),
        timestamp: created_at,
        isGroup: true,
        deduplicate: true,
      },
    });
    external.requestWake.mockClear();
    await Promise.all([
      router.routeInbound(event('banter', 'Funny video.')),
      router.runInConversationTail({ channelType: 'whatsapp', platformId: 'trip' }, async () => {
        order.push('cutover');
      }),
      router.routeInbound(event('addressed', 'voice, check Thursday.')),
    ]);
    expect(order).toEqual(['banter', 'cutover', 'addressed']);
    expect(external.requestWake).toHaveBeenCalledTimes(1);
    await router.routeInbound(event('addressed', 'voice, check Thursday.'));
    expect(order).toEqual(['banter', 'cutover', 'addressed']);
    expect(external.requestWake).toHaveBeenCalledTimes(1);
    const session = await db.getDb().get<{ id: string }>('SELECT id FROM sessions WHERE agent_group_id = ?', 'ag-1');
    const { inboundDbPath } = await import('../mailbox/sqlite/paths.js');
    const inbound = new Database(inboundDbPath('ag-1', session!.id), { readonly: true });
    try {
      expect(inbound.prepare('SELECT id, trigger FROM messages_in ORDER BY seq').all()).toEqual([
        { id: 'banter:ag-1', trigger: 0 },
        { id: 'addressed:ag-1', trigger: 1 },
      ]);
    } finally {
      inbound.close();
    }
  });
});

describe('recorded divergence: a module can hold an inbound message until it releases or settles it', () => {
  it('can release held chat context without making ambient messages wake the assistant', async () => {
    await freshInstall();
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    const createdAt = new Date().toISOString();
    await db.createAgentGroup({
      id: 'chat-agent',
      name: 'Chat',
      folder: 'chat-agent',
      agent_provider: null,
      created_at: createdAt,
    });
    await db.createMessagingGroup({
      id: 'trip',
      channel_type: 'whatsapp',
      platform_id: 'trip@g.us',
      is_group: 1,
      name: 'Trip',
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    await db.createMessagingGroupAgent(
      {
        id: 'chat-wiring',
        messaging_group_id: 'trip',
        agent_group_id: 'chat-agent',
        engage_mode: 'module',
        engage_pattern: null,
        sender_scope: 'all',
        ignored_message_policy: 'accumulate',
        session_mode: 'shared',
        priority: 0,
        created_at: createdAt,
      },
      { companionDestination: false },
    );
    await import('../mailbox/compose.js');
    const router = await import('../router.js');
    const { findSessionForAgent } = await import('../db/sessions.js');
    const { withExistingMailboxSession } = await import('../session-manager.js');
    router.registerEngagementDecider('whatsapp', ({ event }) => event.message.isMention === true);
    router.registerInboundDelay(() => router.HOLD_UNTIL_RELEASED);
    external.requestWake.mockClear();
    const receive = (id: string, isMention: boolean) =>
      router.routeInbound({
        channelType: 'whatsapp',
        platformId: 'trip@g.us',
        threadId: null,
        message: {
          id,
          kind: 'chat',
          content: JSON.stringify({ text: id }),
          timestamp: createdAt,
          isGroup: true,
          isMention,
        },
      });

    await receive('ambient', false);
    const sessionId = (await findSessionForAgent('chat-agent', 'trip', null))?.id ?? '';
    expect(
      await withExistingMailboxSession('chat-agent', sessionId, (mailbox) => {
        expect(mailbox.releaseHeldMessages(null, { preserveTriggers: true })).toBe(1);
        return mailbox.countDueMessages();
      }),
    ).toBe(0);
    await receive('addressed', true);
    expect(external.requestWake).not.toHaveBeenCalled();
    expect(
      await withExistingMailboxSession('chat-agent', sessionId, (mailbox) => {
        expect(mailbox.releaseHeldMessages(null, { preserveTriggers: true })).toBe(1);
        return mailbox.countDueMessages();
      }),
    ).toBe(1);
  });

  it('writes a held row that nothing counts or wakes for, whatever time another delay names, and releases it due at the time named, or settles it unread', async () => {
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
    const later = new Date(Date.now() + 4 * 60_000).toISOString();
    router.registerInboundDelay((event) => (event.message.id.startsWith('held') ? router.HOLD_UNTIL_RELEASED : null));
    router.registerInboundDelay((event) => (event.message.id.startsWith('held') ? later : null));
    external.requestWake.mockClear();

    await router.routeInbound({
      channelType: 'gchat',
      platformId: 'gchat:spaces/dm',
      threadId: null,
      message: {
        id: 'held',
        kind: 'chat',
        content: '{"text":"hello"}',
        timestamp: createdAt,
        isMention: true,
        isGroup: false,
      },
    });
    expect(external.requestWake).not.toHaveBeenCalled();

    const sessionId = (await findSessionForAgent('ag-1', 'mg-1', null))?.id ?? '';
    expect(
      await withExistingMailboxSession('ag-1', sessionId, (mailbox) => [
        mailbox.countDueMessages(),
        mailbox.getWaitingMessages(),
      ]),
    ).toEqual([0, []]);
    expect(await withExistingMailboxSession('ag-1', sessionId, (mailbox) => mailbox.releaseHeldMessages(later))).toBe(
      1,
    );
    expect(await withExistingMailboxSession('ag-1', sessionId, (mailbox) => mailbox.getWaitingMessages())).toEqual([
      { id: 'held:ag-1', tries: 0, processAfter: later },
    ]);

    await router.routeInbound({
      channelType: 'gchat',
      platformId: 'gchat:spaces/dm',
      threadId: null,
      message: {
        id: 'held-again',
        kind: 'chat',
        content: '{"text":"hello again"}',
        timestamp: createdAt,
        isMention: true,
        isGroup: false,
      },
    });
    expect(await withExistingMailboxSession('ag-1', sessionId, (mailbox) => mailbox.settleHeldMessages())).toBe(1);
    expect(
      await withExistingMailboxSession('ag-1', sessionId, (mailbox) => [
        mailbox.releaseHeldMessages(null),
        mailbox.countDueMessages(),
      ]),
    ).toEqual([0, 0]);
  });

  it("keeps held rows out of the runner's pending read", async () => {
    const operations = await readFile(
      path.join(originalCwd, 'container/agent-runner/src/mailbox/sqlite/operations.ts'),
      'utf8',
    );
    // The runner's other reads of pending rows (question and CLI answers) must not stand in for its batch read.
    const pendingRead = /export function sqliteGetPendingMessages\([\s\S]*?\n\}\n/u.exec(operations)?.[0] ?? '';
    expect(pendingRead).toMatch(/SELECT \* FROM messages_in\s+WHERE status = 'pending'\s/u);
  });
});

describe('recorded divergence: a scheduled task can come back as a turn of the conversation that created it', () => {
  it('lands an --in-conversation task in the calling session marked to come back, lists it, and refuses one from a task session', async () => {
    await freshInstall();
    const db = await import('../db/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    const now = new Date().toISOString();
    await db.createAgentGroup({ id: 'ag-1', name: 'Main', folder: 'main', agent_provider: null, created_at: now });
    const { createSession } = await import('../db/sessions.js');
    await createSession({
      id: 'chat-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now,
    });
    await import('../mailbox/compose.js');
    const { initSessionFolder, withExistingMailboxSession } = await import('../session-manager.js');
    initSessionFolder('ag-1', 'chat-1');
    await import('../cli/resources/tasks.js');
    const { dispatch } = await import('../cli/dispatch.js');
    const ctx = { caller: 'agent', agentGroupId: 'ag-1', sessionId: 'chat-1', messagingGroupId: 'mg-1' } as const;
    const args = { prompt: 'Check whether the venue confirmed', process_after: '2999-01-01T09:00:00Z' };
    const storedContent = async (created: Awaited<ReturnType<typeof dispatch>>): Promise<unknown> => {
      if (!created.ok) throw new Error(created.error.message);
      const { session_id, series_id } = created.data as { session_id: string; series_id: string };
      const task = await withExistingMailboxSession('ag-1', session_id, (mailbox) => mailbox.getTask(series_id));
      return JSON.parse(task?.content ?? 'null');
    };

    const conversation = await dispatch(
      { id: 'c', command: 'tasks-create', args: { ...args, in_conversation: true } },
      ctx,
    );
    expect(conversation).toMatchObject({ ok: true, data: { session_id: 'chat-1' } });
    const listed = await dispatch({ id: 'l', command: 'tasks-list', args: {} }, ctx);
    expect(listed.ok && (listed.data as Array<{ session_id: string }>).map((row) => row.session_id)).toEqual([
      'chat-1',
    ]);

    const isolated = await dispatch({ id: 'i', command: 'tasks-create', args }, ctx);
    // The runner answers a task as a turn by this marker, never by the session it sits in.
    expect(await storedContent(conversation)).toMatchObject({ inConversation: true });
    expect(await storedContent(isolated)).not.toHaveProperty('inConversation');
    const taskSession = isolated.ok ? (isolated.data as { session_id: string }).session_id : '';
    const refused = await dispatch(
      { id: 'r', command: 'tasks-create', args: { ...args, in_conversation: true } },
      { ...ctx, sessionId: taskSession },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('no conversation to come back to');
  });

  it("runs a task as a turn only when it is marked to come back, keeps a quiet task's prose unsent, and escapes script output", async () => {
    const runner = path.join(originalCwd, 'container/agent-runner/src');
    const formatter = await readFile(path.join(runner, 'formatter.ts'), 'utf8');
    const pollLoop = await readFile(path.join(runner, 'poll-loop.ts'), 'utf8');
    const destinations = await readFile(path.join(runner, 'destinations.ts'), 'utf8');

    // A v1-ported task shares a conversation's session unmarked, so the marker, not the session, decides.
    expect(formatter).toContain("const IN_CONVERSATION_FIELD = 'inConversation';");
    expect(formatter).toContain(
      "taskRun: tasksOnly && !messages.filter((m) => m.kind === 'task').every(isConversationTask),",
    );
    expect(formatter).toContain('escapeXml(JSON.stringify(content.scriptOutput, null, 2))');
    // A conversation turn of only tasks keeps its prose as scratchpad; a missed block still asks for a re-send.
    expect(pollLoop).toContain('(missed > 0 || (routing.tasksOnly !== true && replied === 0 && !!scratchpad))');
    expect(destinations).toContain('- `<task>` — a scheduled task you set to come back to this conversation');
  });
});

describe("recorded divergence: the runner's tool barrel loads GWS-EA's tools", () => {
  it("loads the runner's email and request-status tools, which name their own capability keys, and no reminder tools", async () => {
    const tools = await readFile(path.join(originalCwd, 'container/agent-runner/src/mcp-tools/index.ts'), 'utf8');
    for (const module of ['gws-ea-email', 'request-status']) {
      expect(tools).toContain(`await import('./${module}.js');`);
    }
    expect(tools).not.toContain('gws-ea-meetings');
    // Slice 5 R15: no tool times a conversation's own follow-through; a matter's look in main's conversation does.
    expect(tools).not.toContain("'./reminders.js'");
  });
});

describe('recorded divergence: each agent group has a capability list', () => {
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
    const db = await import('../db/index.js');
    // The capability column and the profile, which names main, as the host's module barrel registers them.
    await import('../modules/capabilities/index.js');
    await import('../modules/gws-ea-profile/index.js');
    await db.runMigrations(await db.initTestDb());
    cleanups.push(() => db.closeDb());
    const { resolveCapabilities } = await import('../capabilities.js');
    await import('../modules/gws-ea-google/index.js');
    const { WORKSPACE_GOG_COMMANDS } = await import('../modules/gws-ea-google/workspace-commands.js');
    const { composeSessionSpec } = await import('../container-runner.js');
    const { reconcileGwsEaProfile } = await import('../modules/gws-ea-profile/db.js');
    for (const id of ['ag-main', 'ag-research']) await db.createAgentGroup(agentGroup(id));
    await reconcileGwsEaProfile({
      assistantName: { firstName: 'Juno', lastName: null },
      assistantWorkspaceEmail: 'juno@northwind.example',
      principalName: { firstName: 'Morgan', lastName: 'Ellery' },
      principalTimezone: 'Europe/London',
      mainAgentGroupId: 'ag-main',
    });
    const spawnEnv = (agentGroupId: string, capabilities: readonly string[]) =>
      composeSessionSpec({
        agentGroup: agentGroup(agentGroupId),
        session: { id: 'session-1', agent_group_id: agentGroupId } as never,
        containerName: `nanoclaw-v2-${agentGroupId}-1700000000000`,
        mounts: [],
        containerConfig: { capabilities: [...capabilities] } as never,
        mailboxEnvironment: {},
        contribution: {},
        gateway: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } },
      }).containers[0].contributedEnv ?? {};

    const main = spawnEnv('ag-main', resolveCapabilities('all', 'main'));
    // Calendar without gog's create, its conflict check, or its answer: main
    // creates events, checks overlaps and answers through the host. Gmail read-only,
    // the directory's search, and the whole of Drive, Docs, Sheets, Slides and Forms.
    const services = [
      'calendar.calendars',
      'calendar.subscribe',
      'calendar.unsubscribe',
      'calendar.events',
      'calendar.event',
      'calendar.freebusy',
      'calendar.update',
      'calendar.delete',
      'gmail.search',
      'gmail.messages.search',
      'gmail.thread.get',
      'gmail.get',
      'people.search',
    ];
    expect(main.GOG_ENABLE_COMMANDS_EXACT?.split(',')).toEqual([...services, ...WORKSPACE_GOG_COMMANDS]);
    expect(main).toMatchObject({ GOG_ACCESS_TOKEN: 'gateway-managed', GOG_GMAIL_NO_SEND: '1' });
    expect(
      spawnEnv('ag-research', resolveCapabilities('all', 'research')).GOG_ENABLE_COMMANDS_EXACT?.split(','),
    ).toEqual(services);
    expect(Object.keys(spawnEnv('ag-main', ['reply', 'shell'])).filter((key) => key.startsWith('GOG_'))).toEqual([]);
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
    // Before either kind of create fetches or writes: the template's download, and the group's row.
    for (const create of ['ensureTemplateLocal(template)', 'await createAgentGroup(newGroup)']) {
      expect(createAgent.indexOf('destinationRefusal({ proposed })'), create).toBeLessThan(createAgent.indexOf(create));
    }
    // A template is stamped under the id whose destinations were judged.
    expect(createAgent).toMatch(/createAgentFromTemplate\(template, \{\s+id: wiring\.toParent\.agent_group_id,/u);
    expect(await read('src/templates/create-agent.ts')).toContain('const id = opts?.id ?? `ag-${randomUUID()}`;');
    expect(cli).toContain('await createDestination({');
    expect(cli).not.toContain('INSERT INTO agent_destinations');
  });
});

describe('recorded divergence: instructions follow the capabilities that use them', () => {
  it('lets a reply-only group select WhatsApp formatting without granting shell or other skills', async () => {
    await freshInstall();
    const { skillsWithinCapabilities } = await import('../capabilities.js');

    expect(
      skillsWithinCapabilities(['whatsapp-formatting', 'agent-browser', 'unclassified-command'], new Set(['reply'])),
    ).toEqual(['whatsapp-formatting']);
    expect(skillsWithinCapabilities(['whatsapp-formatting'], new Set())).toEqual([]);
  });

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

describe('recorded divergence: a bridge adapter can make a text delivery retry idempotent', () => {
  it('passes the same row and part key through repeated file-free text deliveries', async () => {
    const { createChatSdkBridge } = await import('../channels/chat-sdk-bridge.js');
    const keys: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: {
        name: 'durable-text',
        postTextOnce: async (threadId: string, _text: string, key: string) => {
          keys.push(key);
          return { id: key, threadId, raw: {} };
        },
      } as unknown as Adapter,
      supportsThreads: false,
    });
    const message = { kind: 'chat', content: { text: 'One outage notice' } };
    expect(await bridge.deliver('principal', null, message, 'one-notice')).toBe('one-notice:0');
    expect(await bridge.deliver('principal', null, message, 'one-notice')).toBe('one-notice:0');
    expect(keys).toEqual(['one-notice:0', 'one-notice:0']);
  });
});

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
      run: (command, args) => {
        commands.push([command, ...args].join(' '));
        return '';
      },
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
      'docker ps --filter label=nanoclaw-install=gwsguard --format {{.ID}}|{{.Label "nanoclaw-session"}}|{{.Label "nanoclaw-role"}}',
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

describe("recorded divergence: the host's own sends pass the outbound guards, and only a channel asserts a sender", () => {
  it('hands the guarded delivery adapter to the approval coordinator and the host modules', async () => {
    const host = await readFile(path.join(originalCwd, 'src/index.ts'), 'utf8');

    expect(host).toContain('const guardedDelivery = setDeliveryAdapter(deliveryAdapter);');
    expect(host).toMatch(/startGatewayApprovalCoordinator\(gatewayProvider, guardedDelivery,/u);
    expect(host).toContain('startHostModules({ db, deliveryAdapter: guardedDelivery,');
  });

  it("forwards a channel's authenticated sender and retry-safe mark, and drops a sender an admin transport's routed event carries", async () => {
    const host = await readFile(path.join(originalCwd, 'src/index.ts'), 'utf8');
    const onInbound = host.slice(host.indexOf('onInbound(platformId, threadId, message) {'));
    const channelMessage = onInbound.slice(0, onInbound.indexOf('onInboundEvent('));
    const adminEvent = onInbound.slice(onInbound.indexOf('onInboundEvent('), onInbound.indexOf('onMetadata('));

    expect(channelMessage).toContain('authenticatedSender: message.authenticatedSender,');
    expect(channelMessage).toContain('deduplicate: message.deduplicate,');
    expect(adminEvent).toContain('authenticatedSender: undefined,');
    expect(adminEvent).toContain("deduplicate: adapter.channelType === 'cli' ? event.message.deduplicate : undefined,");
  });
});

describe('recorded divergence: WhatsApp is an instance-owned module channel', () => {
  it('can replace its linked transport without stopping another channel', async () => {
    await freshInstall();
    const registry = await import('../channels/channel-registry.js');
    const setups: string[] = [];
    const stops: string[] = [];
    let generation = 0;
    const adapter = (channelType: string, identity: string) => ({
      name: channelType,
      channelType,
      supportsThreads: false,
      setup: async () => {
        setups.push(identity);
      },
      teardown: async () => {
        stops.push(identity);
      },
      isConnected: () => !stops.includes(identity),
      deliver: async () => identity,
    });
    registry.registerChannelAdapter('whatsapp', { factory: () => adapter('whatsapp', `wa-${++generation}`) });
    registry.registerChannelAdapter('gchat', { factory: () => adapter('gchat', 'gchat') });
    registry.registerChannelAdapter('unlinked', { factory: async () => null });
    await registry.initChannelAdapters(() => ({
      onInbound() {},
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    }));
    cleanups.push(() => registry.teardownChannelAdapters());

    await expect(registry.stopChannelAdapter('whatsapp')).resolves.toBe('stopped');
    expect(stops).toEqual(['wa-1']);
    expect(registry.getChannelAdapterExact('whatsapp')).toBeUndefined();
    expect(registry.getChannelAdapterExact('gchat')?.isConnected()).toBe(true);
    await expect(registry.startChannelAdapter('whatsapp')).resolves.toBe('started');
    expect(setups).toEqual(['wa-1', 'gchat', 'wa-2']);
    expect(registry.getChannelAdapterExact('whatsapp')?.isConnected()).toBe(true);
    await expect(registry.startChannelAdapter('unlinked')).resolves.toBe('no-credentials');
    expect(registry.getChannelAdapterExact('unlinked')).toBeUndefined();
    expect(registry.getChannelAdapterExact('gchat')?.isConnected()).toBe(true);
  });

  it('registers once from the module barrel and stays inert without a link record', async () => {
    await freshInstall();
    const registry = await import('../channels/channel-registry.js');
    vi.mocked(registry.registerChannelAdapter).mockClear();

    await import('../channels/index.js');
    const whatsapp = () =>
      vi.mocked(registry.registerChannelAdapter).mock.calls.filter(([name]) => name === 'whatsapp');
    expect(whatsapp()).toHaveLength(0);

    await import('../modules/index.js');
    expect(whatsapp()).toHaveLength(1);
    expect(await whatsapp()[0]![1].factory()).toBeNull();
  });
});

describe("recorded divergence: Google Chat is the assistant's own channel, on the pinned SDK", () => {
  /** The slice of `scripts/skill-directives.ts` this guard drives. */
  interface SkillDirectives {
    parseDirectives(markdown: string): ReadonlyArray<{ readonly kind: string; readonly body: readonly string[] }>;
  }

  it('pins the Chat SDK core to the Google Chat adapter, and add-gchat would install that same version', async () => {
    const read = (file: string) => readFile(path.join(originalCwd, file), 'utf8');
    const manifest = JSON.parse(await read('package.json')) as { dependencies: Record<string, string> };
    const adapterVersion = manifest.dependencies['@chat-adapter/gchat'];
    const { parseDirectives } = (await import(
      path.join(originalCwd, 'scripts/skill-directives.ts')
    )) as SkillDirectives;
    const skill = parseDirectives(await read('.claude/skills/add-gchat/SKILL.md'));

    expect(adapterVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(manifest.dependencies.chat).toBe(adapterVersion);
    expect(skill.filter((directive) => directive.kind === 'dep').flatMap((directive) => directive.body)).toEqual([
      `@chat-adapter/gchat@${adapterVersion}`,
    ]);
  });

  it('registers gchat once, from the gws-ea-chat module and never from the channel barrel', async () => {
    await freshInstall();
    const barrel = await readFile(path.join(originalCwd, 'src/channels/index.ts'), 'utf8');
    const registry = await import('../channels/channel-registry.js');
    const registered = () =>
      vi.mocked(registry.registerChannelAdapter).mock.calls.filter(([name]) => name === 'gchat').length;
    vi.mocked(registry.registerChannelAdapter).mockClear();

    expect(barrel).not.toMatch(/gchat/u);
    await import('../channels/index.js');
    expect(registered()).toBe(0);
    await import('../modules/index.js');
    expect(registered()).toBe(1);
  });

  it("still has every SDK method the assistant's adapter overrides or calls, so an SDK upgrade cannot drop one silently", async () => {
    const { AssistantChatAdapter } = await import('../modules/gws-ea-chat/adapter.js');
    const sdk = GoogleChatAdapter.prototype as unknown as Record<string, unknown>;
    const own = (prototype: object, method: string) => Object.prototype.hasOwnProperty.call(prototype, method);
    const overridden = [
      'initialize',
      'handleWebhook',
      'handlePubSubMessageEvent',
      'normalizeBotMentions',
      'editMessage',
    ];
    const called = ['parsePubSubMessage', 'encodeThreadId', 'fetchAttachmentData'];

    for (const method of [...overridden, ...called]) expect(typeof sdk[method], method).toBe('function');
    expect(overridden.filter((method) => !own(AssistantChatAdapter.prototype, method))).toEqual([]);
    expect(called.filter((method) => own(AssistantChatAdapter.prototype, method))).toEqual([]);
  });
});

describe('recorded divergence: upstream sync 2026-10-19 re-applied these on upstream code', () => {
  const read = (file: string) => readFile(path.join(originalCwd, file), 'utf8');

  it("the result door's repeat check reads a row's text beside its batch, and a sent email is quoted in the nudge", async () => {
    const pollLoop = await read('container/agent-runner/src/poll-loop.ts');

    // Without it, every Claude turn whose result re-emits a streamed block draws a nudge.
    expect(pollLoop).toContain('isDoorText(message.content, body)');
    expect(pollLoop).toContain('const sentThisTurn = sentSince(turnStartSeq);');
    expect(pollLoop).toContain("row.kind === 'system'\n      ? 'email'");
  });

  it("seeds a sealed session's own provider files through upstream's anchored initializeFile", async () => {
    const runner = await read('src/container-runner.ts');
    const realize = await read('src/provider-contracts/realize.ts');

    expect(runner).toContain('initializeFile(provider, file, volumes, agentGroupId, [], sessionDirectory);');
    expect(runner).not.toContain('reconcileSessionFile');
    expect(realize).toMatch(/export function initializeFile\([^)]*sessionDirectory\?: string,\n\): void/u);
  });

  it('decides a protected group on the canonical args, so no spelling of a group flag slips past', async () => {
    const guard = await read('src/cli/guard.ts');

    expect(guard.indexOf('args = normalizeArgs(input.payload);')).toBeGreaterThan(-1);
    expect(guard.indexOf('args = normalizeArgs(input.payload);')).toBeLessThan(
      guard.indexOf('await namedGroups(cmd, args)'),
    );
  });

  it('keeps a Chat attachment folder named by hash, reusing only the identical file a retry staged', async () => {
    const sessions = await read('src/session-manager.ts');

    expect(sessions).toContain("AnchoredDir.open(sessionDir(agentGroupId, sessionId), ['inbox', inboxFolder], true)");
    expect(sessions).toContain('if (!holdsStagedOriginal(inbox, filename, bytes)) {');
  });

  it("draws gws-ea's prompts where it asks for them, and its context note follows the card's thread", async () => {
    const select = await read('setup/lib/bright-select.ts');
    const primitive = await read('src/modules/approvals/primitive.ts');

    expect(select).toContain('output?: Writable;');
    expect(select).toContain('output: opts.output,');
    expect(primitive).toContain('threadId: approvalCardThread(session, target.messagingGroup),');
  });

  it("keeps GWS-EA's own templates tracked while library templates stay install state", async () => {
    const ignored = (file: string) =>
      new Promise<boolean>((resolve, reject) => {
        const check = spawn('git', ['check-ignore', '--no-index', '-q', file], { cwd: originalCwd });
        check.on('error', reject);
        check.on('close', (code) => resolve(code === 0));
      });

    expect(await ignored('templates/gws-ea/main/new-file.md')).toBe(false);
    expect(await ignored('templates/sales/sdr/plugin.json')).toBe(true);
  });
});

describe('recorded divergence: the agent runner words delivery for the tools the agent holds', () => {
  it('teaches send_message and pacing only with reply, gives every chat agent the quiet ending, and leaves signing to its guidance', async () => {
    const runner = path.join(originalCwd, 'container/agent-runner/src');
    const destinations = await readFile(path.join(runner, 'destinations.ts'), 'utf8');
    const compaction = await readFile(path.join(runner, 'compact-instructions.ts'), 'utf8');
    const pollLoop = await readFile(path.join(runner, 'poll-loop.ts'), 'utf8');
    const index = await readFile(path.join(runner, 'index.ts'), 'utf8');

    expect(destinations).toContain(
      'sections.push(buildDestinationsSection(mode, capabilities.has(REPLY_CAPABILITY)));',
    );
    expect(destinations).toContain('Sign only where your guidance asks for it.');
    expect(destinations).not.toContain('when signing any message');
    expect(destinations).toContain('When a turn has nothing to send, end it with only `<internal>…</internal>`');
    expect(index).toContain("taskId ? { kind: 'task', taskId } : { kind: 'chat' },\n    config.capabilities,\n  );");
    expect(compaction).toContain('const canReply = capabilities.has(REPLY_CAPABILITY);');
    expect(compaction).toContain("'A turn with nothing to send ends with only <internal>...</internal>.'");
    expect(compaction).toContain('console.log(buildCompactInstructions(names, taskId, loadConfig().capabilities));');
    expect(compaction).toContain('taskId: getTaskSeriesId(),');
    expect(pollLoop).not.toContain('Please re-send your reply');
    expect(pollLoop).toContain(
      'If the turn had nothing to send, respond with only <internal>done</internal> and nothing will be sent.',
    );
    expect(pollLoop).toContain('or that text was only a note to yourself, respond with only <internal>done</internal>');
  });
});

describe('recorded divergence: compaction keeps the relationship and the work in flight', () => {
  it('asks the summary for corrections from whoever may direct the agent, promises, pending cards and open ids, and to restate no standing rule', async () => {
    const compaction = await readFile(
      path.join(originalCwd, 'container/agent-runner/src/compact-instructions.ts'),
      'utf8',
    );

    for (const line of [
      'corrections and preferences they gave in this session, in their own words, and who gave each;',
      'promises made and not yet kept;',
      'decisions and approval cards still waiting on an answer;',
      'open threads and errands, each with its host id exactly as written.',
      'The people you serve are whoever your own instructions say may direct you.',
      '4. Leave out standing instructions and memory: both are loaded again after the summary',
      'never a rule to follow from now on.',
      'Leave out how to use tools and commands too: the skills and tool',
      'descriptions carry that, and a command remembered from a summary is not the skill that teaches it.',
    ]) {
      expect(compaction).toContain(line);
    }
  });
});

describe('recorded divergence: an unheard recording carries a status line for its reader', () => {
  it("names the operator only in the principal's own private conversation", async () => {
    const formatter = await readFile(path.join(originalCwd, 'container/agent-runner/src/formatter.ts'), 'utf8');

    expect(formatter).toContain('const principals = speech.inPrincipalPrivateConversation === true;');
    expect(formatter).toContain('const NOT_LISTENED_ELSEWHERE =');
    expect(formatter).toContain(
      `"You can't listen to this recording here. Its sender expects you heard it, so if it bears on the thread, say you couldn't listen to it and ask them to put it in writing, without saying why; handle the rest of the message as usual."`,
    );
    expect(formatter).toContain(
      'They expect you heard it, so tell them so in a line of your reply, ask them to ${ask}, and handle the rest of their message as usual.',
    );
    expect(formatter).toContain(
      'Its sender expects you heard it, so if it bears on the thread, tell them so and ask them to ${ask}; handle the rest of the message as usual.',
    );
    expect(formatter).toContain('`\\n<speech status="${status}"${sourceAttrs}>${speechStatusLine(speech)}</speech>`');
  });
});

describe('recorded divergence: memory rules come from the release, within one budget, on every session start', () => {
  const runner = (file: string) => path.join(originalCwd, 'container/agent-runner/src/memory', file);
  async function memoryTree(index: string): Promise<string> {
    const base = await mkdtemp(path.join(os.tmpdir(), 'divergence-memory-'));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    await mkdir(path.join(base, 'memory'), { recursive: true });
    await writeFile(path.join(base, 'memory', 'index.md'), index);
    return base;
  }

  it("renders the release's definition, never a copy in the agent's tree, in 10,000 characters with only the index cut", async () => {
    const memory = (await import(runner('context.ts'))) as RunnerMemoryContextModule;
    const core = '- 2026-10-19: Morgan keeps mornings free.';
    const base = await memoryTree(
      `# Memory Index\n\n## Core Memory\n\n${core}\n\n## Map\n\n${'- [Matter](matters/matter.md) - a matter to recall\n'.repeat(500)}`,
    );
    await mkdir(path.join(base, 'memory', 'system'));
    await writeFile(path.join(base, 'memory', 'system', 'definition.md'), 'agent-edited doctrine\n');

    const section = memory.renderMemorySection(base);

    expect(section.length).toBeLessThanOrEqual(10_000);
    expect(section).toContain((await readFile(memory.RELEASE_MEMORY_DEFINITION.file, 'utf8')).trim());
    expect(section).not.toContain('agent-edited doctrine');
    expect(section).toContain(core);
    expect(section).toContain(memory.MEMORY_TRUNCATION_NOTICE);
  });

  it('injects on resume only when the section changed since it was last delivered to that session', async () => {
    const hook = (await import(runner('session-hook.ts'))) as RunnerMemorySessionHookModule;
    const base = await memoryTree('# Memory Index\n');
    const session = { id: 'session-a', stateDir: path.join(base, 'state') };
    const deliver = (source: 'startup' | 'resume' | 'clear' | 'compact') => {
      const context = hook.memoryContextForSessionStart(source, base, session);
      if (context) hook.recordMemoryDelivered(session, context);
      return context;
    };

    expect(hook.MEMORY_SESSION_HOOK.sources).toEqual(['startup', 'resume', 'clear', 'compact']);
    expect(deliver('resume')).toContain('## Memory');
    expect(deliver('resume')).toBeUndefined();
    expect(deliver('compact')).toContain('## Memory');
    await writeFile(path.join(base, 'memory', 'index.md'), '# Memory Index\n\n- 2026-10-19: a new correction\n');
    expect(deliver('resume')).toContain('a new correction');
  });

  it('records a section only after the hook prints it, so one that never arrives is offered again', async () => {
    const hook = (await import(runner('session-hook.ts'))) as RunnerMemorySessionHookModule;
    const script = await readFile(runner('hook.ts'), 'utf8');
    const base = await memoryTree('# Memory Index\n');
    const session = { id: 'session-a', stateDir: path.join(base, 'state') };

    expect(hook.memoryContextForSessionStart('resume', base, session)).toContain('## Memory');
    expect(hook.memoryContextForSessionStart('resume', base, session)).toContain('## Memory');
    const printed = script.indexOf('writeStdout(');
    expect(printed).toBeGreaterThan(-1);
    expect(printed).toBeLessThan(script.indexOf('recordMemoryDelivered(session, context)'));
  });

  it("seeds only the index, whose Map names the release's definition, and leaves upstream's template unseeded", async () => {
    const scaffold = (await import(runner('scaffold.ts'))) as RunnerMemoryScaffoldModule;
    const base = await mkdtemp(path.join(os.tmpdir(), 'divergence-memory-'));
    cleanups.push(() => rm(base, { recursive: true, force: true }));

    scaffold.ensureMemoryScaffold(base);

    expect(await readdir(path.join(base, 'memory'))).toEqual(['index.md']);
    expect(await readFile(path.join(base, 'memory', 'index.md'), 'utf8')).toContain(
      '](/app/src/memory/gws-ea-definition.md)',
    );
    expect(existsSync(runner('templates/system/definition.md'))).toBe(true);
  });

  it("tells every memory-keeping agent that what it is taught belongs in memory, and that the persona file is the operator's", async () => {
    const instructions = await readFile(
      path.join(originalCwd, 'container/agent-runner/src/mcp-tools/memory.instructions.md'),
      'utf8',
    );

    expect(instructions).toContain("the release's memory definition");
    expect(instructions).toContain("is your operator's persona file");
    expect(instructions).not.toContain('take effect after the group container restarts');
  });
});

/** The slices of the runner's memory modules (`container/agent-runner/src/memory/`) the memory guards drive. */
interface RunnerMemoryContextModule {
  renderMemorySection(baseDir?: string): string;
  readonly RELEASE_MEMORY_DEFINITION: { readonly file: string; readonly path: string };
  readonly MEMORY_TRUNCATION_NOTICE: string;
}
interface RunnerMemorySessionHookModule {
  readonly MEMORY_SESSION_HOOK: { readonly sources: readonly string[] };
  memoryContextForSessionStart(
    source: 'startup' | 'resume' | 'clear' | 'compact',
    baseDir?: string,
    session?: { id: string; stateDir?: string },
  ): string | undefined;
  recordMemoryDelivered(session: { id: string; stateDir?: string }, section: string): void;
}
interface RunnerMemoryScaffoldModule {
  ensureMemoryScaffold(baseDir?: string): void;
}

describe('recorded divergence: an approval module can word its own rejection', () => {
  it("relays the action's registered note in place of the generic one, none for a null note, before the wake", async () => {
    const primitive = await import('../modules/approvals/primitive.js');
    const finalize = await readFile(path.join(originalCwd, 'src/modules/approvals/finalize.ts'), 'utf8');
    primitive.registerApprovalHandler('divergence:worded-reject', async () => undefined, {
      rejectionNote: (approval, reason) => `The principal declined ${approval.title}: "${reason ?? ''}"`,
    });

    const note = primitive.getApprovalRejectionNote('divergence:worded-reject');
    expect(await note?.({ title: 'the trip' } as PendingApproval, 'not now')).toBe(
      'The principal declined the trip: "not now"',
    );
    expect(primitive.getApprovalRejectionNote('divergence:unregistered')).toBeUndefined();
    // Rejections keep their durable claim until required settlement, notes, and wake all succeed.
    expect(finalize).toContain("SET status = 'rejected', rejection_user_id = ?, rejection_reason = ?, rejected_at = ?");
    expect(finalize).toContain('if (text !== null)');
    expect(finalize.indexOf('await getApprovalRejectionFinalizer(approval.action)?.(event)')).toBeLessThan(
      finalize.indexOf('const rejectionNote = getApprovalRejectionNote(approval.action)'),
    );
    expect(finalize.indexOf('await notifyApprovalResolved(event)')).toBeLessThan(
      finalize.indexOf("await requestWake(session, 'approval-response')"),
    );
    expect(finalize.indexOf("await requestWake(session, 'approval-response')")).toBeLessThan(
      finalize.lastIndexOf('await deletePendingApproval(approvalId)'),
    );
  });
});

/** The slice of the runner's Claude config module (`container/agent-runner/src/providers/claude-config.ts`) the skills guard drives. */
interface ClaudeConfigModule {
  resolveClaudeExecutionPolicy(): { disallowedTools: string[]; settings: Record<string, unknown> };
}

describe('recorded divergence: an agent sees only the skills NanoClaw mounts for it', () => {
  const read = (file: string) => readFile(path.join(originalCwd, file), 'utf8');

  it('switches off the skills Claude Code ships, and its reminder and push tools, for every Claude agent', async () => {
    const config = (await import(
      path.join(originalCwd, 'container/agent-runner/src/providers/claude-config.ts')
    )) as ClaudeConfigModule;
    const policy = config.resolveClaudeExecutionPolicy();

    expect(policy.settings).toMatchObject({
      disableBundledSkills: true,
      enabledPlugins: { 'plugin-authoring@builtin': false },
      skillOverrides: { design: 'off', doctor: 'off' },
    });
    expect(policy.disallowedTools).toEqual(expect.arrayContaining(['RemoteTrigger', 'PushNotification']));
  });

  it('composes the document from the selection the skills are mounted from', async () => {
    const runner = await read('src/container-runner.ts');

    expect(runner).toContain('composeGroupProjectDoc(agentGroup, context.groupDir, spec, context.selectedSkills)');
  });

  it("lets a module withhold the gateway's agent skills, and GWS-EA withholds them from every agent", async () => {
    vi.resetModules();
    const gateway = await import('../gateway-providers/index.js');
    gateway.resetGatewayProvider({ ...gateway.getGatewayProvider(), agentSkills: ['gateway-skill'] });
    expect(gateway.selectGatewayAgentSkills(['welcome'], true)).toEqual(['welcome', 'gateway-skill']);

    await import('../modules/gws-ea-google/index.js');

    expect(gateway.selectGatewayAgentSkills(['welcome'], true)).toEqual(['welcome']);
  });
});

describe('recorded divergence: the PreCompact hook composes the mailbox it reads', () => {
  it('imports the mailbox composition slot and starts the mailbox from the session context before reading', async () => {
    const compaction = await readFile(
      path.join(originalCwd, 'container/agent-runner/src/compact-instructions.ts'),
      'utf8',
    );

    expect(compaction).toContain("import './mailbox/compose.js';");
    expect(compaction).toContain('await mailbox.start(await readMailboxContext());');
    expect(compaction).toContain('await mailbox.run(() => ({');
    expect(compaction).toContain('await mailbox.stop();');
  });
});
