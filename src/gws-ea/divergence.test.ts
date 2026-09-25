/**
 * Guards for gws-ea's recorded differences from upstream NanoClaw (KTD9, R13).
 *
 * Each guard drives the real upstream-owned module through the behavior gws-ea
 * depends on, so a skill refresh or upstream update that drops a recorded
 * divergence fails this suite, not a live assistant. Only effects outside the
 * guarded modules are replaced: container wake-up, and Google's certificate
 * check and the OneCLI servers behind `fetch`.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRegistration, InboundEvent } from '../channels/adapter.js';
import type { GatewayApprovalRequest, GatewaySessionInput } from '../gateway-providers/gateway-provider-registry.js';
import { deriveWorkspaceAddOnIdentity } from './gcp-identity.js';
import { CONTROL_PLANE_ROOT } from './paths.js';

const external = vi.hoisted(() => ({ requestWake: vi.fn(async () => true) }));

// Recording pass-throughs: the real modules run; the guards read what they were given.
vi.mock('@chat-adapter/gchat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chat-adapter/gchat')>();
  return { ...actual, createGoogleChatAdapter: vi.fn(actual.createGoogleChatAdapter) };
});
vi.mock('../channels/channel-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channels/channel-registry.js')>();
  return { ...actual, registerChannelAdapter: vi.fn(actual.registerChannelAdapter) };
});
// Waking an agent starts a container; the welcome guard stops at the session's inbound queue.
vi.mock('../request-wake.js', () => ({ requestWake: external.requestWake }));

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];

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

  /** OneCLI's API and gateway behind `fetch`, recording every agent creation and approval decision. */
  function onecliServers(pending: readonly Record<string, unknown>[] = []) {
    const createdAgents: unknown[] = [];
    const decisions: Array<{ id: string; decision: unknown }> = [];
    let polled = false;
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
        if (!polled) {
          polled = true;
          return Response.json({ requests: pending, timeoutSeconds: 30 });
        }
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

  it('decides only the approvals of groups this install owns', async () => {
    const provider = await installedProvider();
    const servers = onecliServers([approval('foreign', 'other-install-group'), approval('owned', 'owned-group')]);
    const decide = vi.fn(async (_request: GatewayApprovalRequest) => 'approve' as const);

    await subscribeUntil(provider, decide, () =>
      expect(servers.decisions).toEqual([{ id: 'owned', decision: 'approve' }]),
    );
    expect(decide).toHaveBeenCalledOnce();
  });

  it('leaves an approval pending when no decision is available', async () => {
    const provider = await installedProvider();
    const servers = onecliServers([approval('undecided', 'owned-group')]);
    const decide = vi.fn(async (_request: GatewayApprovalRequest) => 'unavailable' as const);

    await subscribeUntil(provider, decide, () => expect(decide).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 50));
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

describe('recorded divergence: a repeated welcome event ID is delivered once', () => {
  const tsxLoader = path.join(CONTROL_PLANE_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const initFirstAgent = path.join(CONTROL_PLANE_ROOT, 'scripts', 'init-first-agent.ts');

  function welcome(cwd: string): Promise<{ readonly status: number | null; readonly stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          tsxLoader,
          initFirstAgent,
          '--channel',
          'gchat',
          '--user-id',
          'gchat:users/principal',
          '--platform-id',
          'gchat:spaces/principal-dm',
          '--display-name',
          'Principal',
          '--event-id',
          'gws-ea-welcome:divergence-guard',
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

  it('queues one welcome when init-first-agent retries with the same --event-id', async () => {
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
    await initChannelAdapters(() => ({
      onInbound() {},
      onInboundEvent(event: InboundEvent) {
        database ??= initDb(CENTRAL_DB_PATH);
        routed.push(
          database.then(() =>
            routeInbound({ ...event, message: { ...event.message, authenticatedSender: undefined } }),
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
      expect(inbound.prepare('SELECT id FROM messages_in').all()).toEqual([
        { id: `gws-ea-welcome:divergence-guard:${sessions[0]!.agent_group_id}` },
      ]);
    } finally {
      inbound.close();
    }
  });
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
