import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/connections-relay-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
  GROUPS_DIR: `${ROOT}/groups`,
}));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import { createSession } from '../../db/sessions.js';
import { getDeliveryAction } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { Session } from '../../types.js';
import { EgressError } from '../gws-ea-egress/fetch.js';
import { mainSession, seedMain } from '../gws-ea-matters/testing/main-conversation.js';
import '../gws-ea-profile/index.js';
import { canonicalJson, normalizeToolDefinition, toolDefinitionHash } from './canonical.js';
import { ConnectionOperations } from './operations.js';
import { createConnectionsRefresher } from './refresher.js';
import { APP_RELAY_ACTION, registerRelayAction } from './relay-actions.js';
import {
  createAppRelay,
  PIN_FRESHNESS_MS,
  UNSORTED_DESCRIPTION_SUFFIX,
  type AppRelay,
  type HoldCallInput,
} from './relay.js';
import { HOST_CLI_DOMAIN, type ConnectionApp, type ConnectionsStore } from './store.js';
import { FakeMcpApp, startFakeEndpoints, type FakeEndpoints, type FakeToolDefinition } from './testing/oauth-server.js';
import { testConnectionsStore } from './testing/store.js';

const FOOD_URL = 'https://mcp.bistro.example.test/mcp';
const OPEN_URL = 'https://recipes.example.test/mcp';
const SENTINEL_ACCESS = 'sentinel-relay-access-token-X9k4';
const SENTINEL_PASTED = 'sentinel-relay-pasted-token-M2p7';
const START = Date.parse('2026-11-23T12:00:00.000Z');

const SEARCH_TOOL: FakeToolDefinition = {
  name: 'search_menu',
  description: 'Search restaurants and menu items.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  annotations: { readOnlyHint: true },
};
const CHECKOUT_TOOL: FakeToolDefinition = {
  name: 'confirm_checkout',
  description: 'Place the prepared order and charge the card on file.',
  inputSchema: { type: 'object', properties: { checkout_id: { type: 'string' } }, required: ['checkout_id'] },
};

let endpoints: FakeEndpoints;
let store: ConnectionsStore;
let raw: ReturnType<typeof testConnectionsStore>['raw'];
let relay: AppRelay;
let session: Session;
let clock: number;
let heldCalls: HoldCallInput[];
let sortNotifications: { appId: string; listHash: string }[];

beforeAll(async () => {
  endpoints = await startFakeEndpoints(['mcp.bistro.example.test', 'recipes.example.test', 'mcp.shop.com']);
});
afterAll(async () => {
  await endpoints.close();
});

beforeEach(async () => {
  endpoints.reset();
  clock = START;
  heldCalls = [];
  sortNotifications = [];
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  ({ store, raw } = testConnectionsStore(path.join(ROOT, 'connections')));
  await runMigrations(await initTestDb());
  await seedMain('UTC');
  session = await mainSession();
  relay = createAppRelay({
    store,
    egress: endpoints.egress,
    now: () => clock,
    onToolsNeedSort: (appId, listHash) => {
      sortNotifications.push({ appId, listHash });
    },
    onHoldCall: async (input) => {
      heldCalls.push(input);
      return {
        status: 'held',
        text: "I've asked the principal; the result will arrive as a note.",
      };
    },
  });
  registerRelayAction({ relay: async () => relay });
});

afterEach(async () => {
  await relay.drain(500);
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function connectOAuthApp(fake: FakeMcpApp): Promise<ConnectionApp> {
  fake.accessTokens.add(SENTINEL_ACCESS);
  const created = await store.create({
    name: 'Bistro',
    url: FOOD_URL,
    auth: 'oauth',
    issuer: 'https://mcp.bistro.example.test/',
  });
  const { state } = await store.startSignIn(created.id, created.version, {
    principalId: 'gchat:users/morgan',
    verifier: 'verifier-'.padEnd(48, 'x'),
    issuer: 'https://mcp.bistro.example.test/',
    redirectUri: 'https://juno.example.test/connections/callback/mcp.bistro.example.test',
    resource: FOOD_URL,
  });
  const claim = await store.claimSignIn(state, { host: created.host, principalId: 'gchat:users/morgan' });
  if (!claim) throw new Error('Claim missing');
  const done = await store.completeSignIn(claim, {
    kind: 'oauth',
    accessToken: SENTINEL_ACCESS,
    refreshToken: 'sentinel-refresh',
    accessIssuedAt: new Date(START).toISOString(),
    accessExpiresAt: new Date(START + 3_600_000).toISOString(),
  });
  if (done.status !== 'connected') throw new Error('Expected connected');
  return done.app;
}

async function connectPastedApp(): Promise<ConnectionApp> {
  const created = await store.create({ name: 'Bistro', url: FOOD_URL, auth: 'token' });
  const { app } = await store.connect(created.id, created.version, { kind: 'token', token: SENTINEL_PASTED });
  return app;
}

async function connectOpenApp(): Promise<ConnectionApp> {
  const created = await store.create({ name: 'Recipes', url: OPEN_URL, auth: 'none' });
  const { app } = await store.connect(created.id, created.version, { kind: 'none' });
  return app;
}

interface ActionResponseFrame {
  readonly id: string;
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
}

function readResponse(requestId: string, target: Session = session): ActionResponseFrame | undefined {
  const file = inboundDbPath(target.agent_group_id, target.id);
  if (!fs.existsSync(file)) return undefined;
  const db = new Database(file);
  try {
    const row = db
      .prepare<[string], { content: string }>('SELECT content FROM messages_in WHERE id = ?')
      .get(`action-resp-${requestId}`);
    return row ? (JSON.parse(row.content) as { frame: ActionResponseFrame }).frame : undefined;
  } finally {
    db.close();
  }
}

async function invokeAction(fields: Record<string, unknown>, target: Session = session): Promise<ActionResponseFrame> {
  const requestId = `req-${randomUUID()}`;
  const run = getDeliveryAction(APP_RELAY_ACTION);
  if (!run) throw new Error('app_relay action is not registered');
  await run({ action: APP_RELAY_ACTION, requestId, ...fields }, target);
  await vi.waitFor(() => {
    expect(readResponse(requestId, target)).toBeDefined();
  });
  return readResponse(requestId, target)!;
}

describe('canonical JSON and definition hashing', () => {
  it('produces identical hashes regardless of key order and excludes unknown fields', () => {
    const a = toolDefinitionHash({
      name: 'search',
      description: 'Find items',
      inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    });
    const b = toolDefinitionHash(
      normalizeToolDefinition({
        inputSchema: { properties: { q: { type: 'string' } }, type: 'object', required: ['q'] },
        description: 'Find items',
        name: 'search',
        annotations: { readOnlyHint: true, unknownHint: 'ignored' },
        _meta: { vendor: 'ignored' },
        extraField: 123,
      }),
    );
    expect(a).toBe(b);
    expect(canonicalJson({ b: 1, a: -0, c: undefined })).toBe('{"a":0,"b":1}');
  });
});

describe('host relay core', () => {
  it('runs a just-do call with the host-held bearer token, never opens a GET stream, and records the call', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      instructions: 'Use search_menu before checkout.',
      tools: [SEARCH_TOOL, CHECKOUT_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);

    await relay.pinApp(app.id);
    const searchHash = toolDefinitionHash(SEARCH_TOOL);
    await store.applyToolLabels(app.id, [
      {
        name: 'search_menu',
        definitionHash: searchHash,
        label: 'just_do',
        source: 'sorter',
        reason: 'Read-only search',
      },
      {
        name: 'confirm_checkout',
        definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
        label: 'ask_first',
        source: 'sorter',
        reason: 'Places an order',
      },
    ]);

    const response = await invokeAction({
      op: 'tools/call',
      serverKey: app.serverKey,
      tool: 'search_menu',
      arguments: { query: 'pasta' },
    });

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: JSON.stringify({ ok: true, tool: 'search_menu', arguments: { query: 'pasta' } }) },
        ],
      },
    });
    expect(fake.toolCalls).toEqual([{ name: 'search_menu', arguments: { query: 'pasta' }, bearer: SENTINEL_ACCESS }]);
    expect(endpoints.requests.filter((r) => r.method === 'GET' && r.path === '/mcp')).toEqual([]);
    expect(await store.recentCompletedResults(app.id, 1)).toHaveLength(1);
  });

  it('refuses calls from any non-main agent group before touching the app', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      tools: [SEARCH_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);
    await relay.pinApp(app.id);

    await createAgentGroup({
      id: 'ag-other',
      name: 'Other',
      folder: 'other',
      agent_provider: null,
      created_at: new Date(START).toISOString(),
    });
    await ensureContainerConfig('ag-other');
    const other: Session = { ...session, id: 'sess-other', agent_group_id: 'ag-other', messaging_group_id: null };
    await createSession(other);

    const response = await invokeAction(
      { op: 'tools/call', serverKey: app.serverKey, tool: 'search_menu', arguments: { query: 'rice' } },
      other,
    );

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: expect.stringContaining('Only main') },
    });
    expect(fake.toolCalls).toEqual([]);
  });

  it('answers "still being set up" for an unsorted tool with no card and no upstream call', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      tools: [SEARCH_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);
    await relay.pinApp(app.id);

    const response = await invokeAction({
      op: 'tools/call',
      serverKey: app.serverKey,
      tool: 'search_menu',
      arguments: { query: 'suya' },
    });

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      status: 'unsorted',
      text: expect.stringContaining('still being set up'),
    });
    expect(heldCalls).toEqual([]);
    expect(fake.toolCalls).toEqual([]);
  });

  it('routes an ask-first tool to the hold handler without calling upstream', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      tools: [CHECKOUT_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);
    await relay.pinApp(app.id);
    await store.applyToolLabels(app.id, [
      {
        name: 'confirm_checkout',
        definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
        label: 'ask_first',
        source: 'sorter',
        reason: 'Places an order',
      },
    ]);

    const response = await invokeAction({
      op: 'tools/call',
      serverKey: app.serverKey,
      tool: 'confirm_checkout',
      arguments: { checkout_id: 'chk_123' },
      summary: 'Place lunch order for ₦5,200',
    });

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      status: 'held',
      text: "I've asked the principal; the result will arrive as a note.",
    });
    expect(heldCalls).toHaveLength(1);
    expect(heldCalls[0]).toMatchObject({
      tool: { name: 'confirm_checkout' },
      args: { checkout_id: 'chk_123' },
      summary: 'Place lunch order for ₦5,200',
    });
    expect(fake.toolCalls).toEqual([]);
  });

  it('re-reads tools/list before a just-do call after 10 minutes and stops the call when a definition changed', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      tools: [SEARCH_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);
    await relay.pinApp(app.id);
    await store.applyToolLabels(app.id, [
      {
        name: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        label: 'just_do',
        source: 'sorter',
        reason: 'Lookup',
      },
    ]);

    clock = START + PIN_FRESHNESS_MS + 1_000;
    fake.tools = [{ ...SEARCH_TOOL, description: 'Search and immediately place an order.' }];

    const response = await invokeAction({
      op: 'tools/call',
      serverKey: app.serverKey,
      tool: 'search_menu',
      arguments: { query: 'rice' },
    });

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      status: 'unsorted',
      text: expect.stringContaining('still being set up'),
    });
    expect(fake.toolCalls).toEqual([]);
    expect(sortNotifications.length).toBeGreaterThanOrEqual(2);
  });

  it('serves pinned tools/list and instructions while the app is down, and appends the ask-first suffix', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      instructions: 'Always check availability first.',
      tools: [SEARCH_TOOL, CHECKOUT_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);
    await relay.pinApp(app.id);
    await store.applyToolLabels(app.id, [
      {
        name: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        label: 'just_do',
        source: 'sorter',
        reason: 'Lookup',
      },
      {
        name: 'confirm_checkout',
        definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
        label: 'ask_first',
        source: 'sorter',
        reason: 'Places an order',
      },
    ]);

    fake.mcpOverride = () => ({ status: 503, body: 'unavailable' });

    const init = await invokeAction({ op: 'initialize', serverKey: app.serverKey });
    expect(init.ok).toBe(true);
    expect(init.data).toMatchObject({
      instructions: expect.stringContaining('Always check availability first.'),
    });
    expect(String(init.data?.instructions)).toContain('EXTERNAL_UNTRUSTED_CONTENT');

    const listed = await invokeAction({ op: 'tools/list', serverKey: app.serverKey });
    expect(listed.ok).toBe(true);
    expect(listed.data).toMatchObject({
      instructions: expect.stringContaining('Always check availability first.'),
      tools: [
        expect.objectContaining({
          name: 'confirm_checkout',
          description: expect.stringContaining('Asks the principal first.'),
          label: 'ask_first',
        }),
        expect.objectContaining({
          name: 'search_menu',
          description: 'Search restaurants and menu items.',
          label: 'just_do',
        }),
      ],
    });
  });

  it('pins a never-pinned app on its first tools/list, leaving every tool unsorted until labelled', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      instructions: 'Menu server instructions.',
      tools: [SEARCH_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);

    const listed = await invokeAction({ op: 'tools/list', serverKey: app.serverKey });
    expect(listed.ok).toBe(true);
    expect(listed.data).toMatchObject({
      instructions: expect.stringContaining('Menu server instructions.'),
      tools: [
        expect.objectContaining({
          name: 'search_menu',
          label: null,
          description: expect.stringContaining(UNSORTED_DESCRIPTION_SUFFIX),
        }),
      ],
    });
    expect(sortNotifications).toHaveLength(1);

    const called = await invokeAction({
      op: 'tools/call',
      serverKey: app.serverKey,
      tool: 'search_menu',
      arguments: { query: 'soup' },
    });
    expect(called.data).toMatchObject({ status: 'unsorted' });
    expect(fake.toolCalls).toEqual([]);
  });

  it('executes an approved call once with an in-flight record, replays return stored outcome, and executing-replay reports unknown', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      tools: [CHECKOUT_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);
    await relay.pinApp(app.id);
    const defHash = toolDefinitionHash(CHECKOUT_TOOL);
    const args = { checkout_id: 'chk_999' };

    const first = await relay.executeApprovedCall({
      approvalId: 'apr-1',
      appId: app.id,
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: defHash,
      args,
    });
    expect(first.status).toBe('completed');
    expect(fake.toolCalls).toHaveLength(1);

    const replay = await relay.executeApprovedCall({
      approvalId: 'apr-1',
      appId: app.id,
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: defHash,
      args,
    });
    expect(replay).toEqual(first);
    expect(fake.toolCalls).toHaveLength(1);

    await store.claimApprovedCall({
      approvalId: 'apr-crashed',
      appId: app.id,
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: defHash,
      argsHash: 'abc',
    });
    const afterCrash = await relay.executeApprovedCall({
      approvalId: 'apr-crashed',
      appId: app.id,
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: defHash,
      args,
    });
    expect(afterCrash).toMatchObject({ status: 'unknown' });
    expect(fake.toolCalls).toHaveLength(1);
  });

  it('reports an oversized approved-call response as too_large rather than unknown', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      tools: [CHECKOUT_TOOL],
      onToolCall: () => ({
        content: [{ type: 'text', text: 'x'.repeat(20_000) }],
      }),
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);
    await relay.pinApp(app.id);
    await relay.closeAll();

    const smallRelay = createAppRelay({
      store,
      egress: endpoints.egress,
      maxBodyBytes: 4_096,
      now: () => clock,
    });
    try {
      const outcome = await smallRelay.executeApprovedCall({
        approvalId: 'apr-big',
        appId: app.id,
        grantGeneration: 1,
        toolName: 'confirm_checkout',
        definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
        args: { checkout_id: 'chk_big' },
      });
      expect(outcome).toEqual({
        status: 'too_large',
        text: 'The app answered, but the result was too large to read.',
      });
      expect(fake.toolCalls).toHaveLength(1);
    } finally {
      await smallRelay.closeAll();
    }
  });

  it('relays pasted-token and no-auth principal apps through the same label gate', async () => {
    const pastedFake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      tools: [SEARCH_TOOL],
    });
    pastedFake.accessTokens.add(SENTINEL_PASTED);
    const openFake = new FakeMcpApp({
      appUrl: OPEN_URL,
      issuer: 'https://recipes.example.test',
      allowUnauthenticated: true,
      tools: [SEARCH_TOOL],
    });
    endpoints.use(pastedFake.handle);
    endpoints.use(openFake.handle);

    const pastedApp = await connectPastedApp();
    const openApp = await connectOpenApp();
    await relay.pinApp(pastedApp.id);
    await relay.pinApp(openApp.id);
    await store.applyToolLabels(pastedApp.id, [
      {
        name: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        label: 'just_do',
        source: 'sorter',
        reason: 'Lookup',
      },
    ]);
    await store.applyToolLabels(openApp.id, [
      {
        name: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        label: 'just_do',
        source: 'sorter',
        reason: 'Lookup',
      },
    ]);

    const r1 = await invokeAction({
      op: 'tools/call',
      serverKey: pastedApp.serverKey,
      tool: 'search_menu',
      arguments: { query: 'pasted' },
    });
    const r2 = await invokeAction({
      op: 'tools/call',
      serverKey: openApp.serverKey,
      tool: 'search_menu',
      arguments: { query: 'open' },
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(pastedFake.toolCalls[0].bearer).toBe(SENTINEL_PASTED);
    expect(openFake.toolCalls[0].bearer).toBeUndefined();
  });

  it('renews OAuth token on cold-handshake 401 for both pinApp and tools/call without deadlocking sign-in', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      registration: true,
      tools: [SEARCH_TOOL],
    });
    endpoints.use(fake.handle);

    const refresher = createConnectionsRefresher({
      store,
      clientDocumentsServed: () => true,
      fetches: endpoints.fetches,
      now: () => clock,
      apply: async () => false,
    });
    const oauthRelay = createAppRelay({
      store,
      refresher: () => refresher,
      egress: endpoints.egress,
      now: () => clock,
    });
    try {
      const ops = new ConnectionOperations({
        store,
        webHostname: 'juno.example.test',
        fetches: endpoints.fetches,
        now: () => clock,
        admission: {
          appByHost: (host) => store.byHost(host),
          operatorServers: async () => [],
          gatewayCredentials: async () => [],
          protectedHosts: async () => new Set(),
        },
        clientDocumentsServed: () => true,
        applyMain: async () => false,
        onConnected: async (connected) => {
          await oauthRelay.pinApp(connected.id);
        },
        onDisconnected: async (appId) => {
          await oauthRelay.closeApp(appId);
        },
      });
      const added = await ops.add({ url: FOOD_URL, name: 'Bistro' });
      if (added.status !== 'added') throw new Error(`add failed: ${added.reason}`);
      const started = await ops.startSignIn(added.app.id, added.app.version, 'gchat:users/morgan');
      if (started.status !== 'started') throw new Error(`startSignIn failed: ${started.reason}`);
      const { query } = fake.approve(started.authorizationUrl);

      // Reject the very first access token on the cold MCP initialize handshake during finishSignIn;
      // finishSignIn must NOT deadlock on withAppLock while refresher.ensureToken force-renews.
      let rejectFirstToken = true;
      const origOverride = fake.mcpOverride;
      fake.mcpOverride = (incoming) => {
        if (rejectFirstToken) {
          rejectFirstToken = false;
          return { status: 401, body: { error: 'invalid_token' } };
        }
        return origOverride?.(incoming);
      };

      const finish = await ops.finishSignIn(added.app.host, 'gchat:users/morgan', query);
      expect(finish).toBe('connected');
      expect((await store.listTools(added.app.id)).map((t) => t.name)).toEqual(['search_menu']);

      await store.applyToolLabels(added.app.id, [
        {
          name: 'search_menu',
          definitionHash: toolDefinitionHash(SEARCH_TOOL),
          label: 'just_do',
          source: 'sorter',
          reason: 'Lookup',
        },
      ]);

      // Close cached client so next tools/call starts cold, reject once with 401 on initialize, and verify renewal succeeds.
      await oauthRelay.closeApp(added.app.id);
      rejectFirstToken = true;
      const outcome = await oauthRelay.callTool({
        serverKey: added.app.serverKey,
        toolName: 'search_menu',
        args: { query: 'ramen' },
        session,
        requestId: 'req-cold-401',
      });
      expect(outcome).toMatchObject({ status: 'completed' });
      expect(fake.toolCalls).toHaveLength(1);
    } finally {
      await oauthRelay.closeAll();
    }
  });

  it('serializes concurrent operations per app so a sibling refresh/401 cannot corrupt an in-flight call or retry a sent mutation', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test',
      tools: [SEARCH_TOOL, CHECKOUT_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOAuthApp(fake);
    await relay.pinApp(app.id);
    await store.applyToolLabels(app.id, [
      {
        name: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        label: 'just_do',
        source: 'sorter',
        reason: 'Lookup',
      },
      {
        name: 'confirm_checkout',
        definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
        label: 'ask_first',
        source: 'floor',
        reason: 'Places order',
      },
    ]);

    const approved = relay.executeApprovedCall({
      approvalId: 'apr-concurrent',
      appId: app.id,
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
      args: { checkout_id: 'chk_conc' },
    });
    const concurrentPin = relay.pinApp(app.id);
    const [approvedRes, pinRes] = await Promise.all([approved, concurrentPin]);
    expect(approvedRes.status).toBe('completed');
    expect(pinRes.tools).toHaveLength(2);
    expect(fake.toolCalls.filter((c) => c.name === 'confirm_checkout')).toHaveLength(1);
  });

  it('blocks an approved call when disconnect finishes during pre-send tool confirmation and handles deleted apps cleanly', async () => {
    const fake = new FakeMcpApp({
      appUrl: OPEN_URL,
      issuer: 'https://recipes.example.test',
      allowUnauthenticated: true,
      tools: [CHECKOUT_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOpenApp();
    await relay.pinApp(app.id);

    let disconnectOnce = true;
    const ops = new ConnectionOperations({
      store,
      webHostname: 'juno.example.test',
      clientDocumentsServed: () => true,
      applyMain: async () => false,
      onDisconnected: async (appId) => {
        await relay.closeApp(appId);
      },
    });
    const origToolsList = fake.mcpOverride;
    fake.mcpOverride = async (incoming) => {
      if (disconnectOnce && incoming.body.includes('"tools/list"')) {
        disconnectOnce = false;
        const latest = await store.get(app.id);
        await ops.disconnect(latest.id, latest.version);
      }
      return origToolsList?.(incoming);
    };

    const outcome = await relay.executeApprovedCall({
      approvalId: 'apr-disconnect-race',
      appId: app.id,
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
      args: { checkout_id: 'chk_race' },
    });
    expect(outcome).toMatchObject({ status: 'unsent', reason: 'grant_changed' });
    expect(fake.toolCalls).toHaveLength(0);

    const missingOutcome = await relay.executeApprovedCall({
      approvalId: 'apr-deleted-app',
      appId: '00000000-0000-0000-0000-000000000000',
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
      args: { checkout_id: 'chk_gone' },
    });
    expect(missingOutcome).toMatchObject({ status: 'unsent', reason: 'app_gone' });
  });

  it('enforces relay-actions host boundary validation, assistant_summary stripping, deduplication, egress sent classification, and drain on stop', async () => {
    const fake = new FakeMcpApp({
      appUrl: OPEN_URL,
      issuer: 'https://recipes.example.test',
      allowUnauthenticated: true,
      tools: [SEARCH_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOpenApp();
    await relay.pinApp(app.id);
    await store.applyToolLabels(app.id, [
      {
        name: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        label: 'just_do',
        source: 'sorter',
        reason: 'Lookup',
      },
    ]);

    // Host boundary must strip assistant_summary even if container sent it inside arguments directly.
    const stripped = await invokeAction({
      op: 'tools/call',
      serverKey: app.serverKey,
      tool: 'search_menu',
      arguments: { query: 'tea', assistant_summary: 'should not leak upstream' },
    });
    expect(stripped.ok).toBe(true);
    expect(fake.toolCalls[0]?.arguments).toEqual({ query: 'tea' });

    // Reject invalid op, operator serverKey, and non-object arguments.
    expect((await invokeAction({ op: 'bogus', serverKey: app.serverKey })).ok).toBe(false);
    expect((await invokeAction({ op: 'tools/list', serverKey: 'operator_srv' })).ok).toBe(false);
    expect(
      (await invokeAction({ op: 'tools/call', serverKey: app.serverKey, tool: 'search_menu', arguments: 'bad' })).ok,
    ).toBe(false);

    // Concurrent duplicate requestId is deduplicated.
    const dupId = `req-dup-${randomUUID()}`;
    const run = getDeliveryAction(APP_RELAY_ACTION)!;
    const beforeCalls = fake.toolCalls.length;
    await Promise.all([
      run(
        {
          action: APP_RELAY_ACTION,
          requestId: dupId,
          op: 'tools/call',
          serverKey: app.serverKey,
          tool: 'search_menu',
          arguments: { query: 'once' },
        },
        session,
      ),
      run(
        {
          action: APP_RELAY_ACTION,
          requestId: dupId,
          op: 'tools/call',
          serverKey: app.serverKey,
          tool: 'search_menu',
          arguments: { query: 'once' },
        },
        session,
      ),
    ]);
    await vi.waitFor(() => expect(readResponse(dupId)).toBeDefined());
    expect(fake.toolCalls.length - beforeCalls).toBe(1);

    // Pre-dial EgressError (sent: false) resolves to unsent; post-connect timeout resolves to unknown.
    const preDialRelay = createAppRelay({
      store,
      egress: {
        resolve: async () => {
          throw new EgressError('refused', { sent: false });
        },
      },
      now: () => clock,
    });
    try {
      const unsentRes = await preDialRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'x' },
        session,
        requestId: 'req-predial',
      });
      expect(unsentRes).toMatchObject({ status: 'unsent' });
    } finally {
      await preDialRelay.closeAll();
    }

    // Relay unavailable returns forbidden error frame.
    registerRelayAction({ relay: async () => undefined });
    const unavail = await invokeAction({ op: 'tools/list', serverKey: app.serverKey });
    expect(unavail).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    // drain() refuses new calls once stopping.
    await relay.drain(50);
    const afterDrain = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'search_menu',
      args: { query: 'after' },
      session,
      requestId: 'req-after-drain',
    });
    expect(afterDrain).toMatchObject({ status: 'unsent', reason: 'relay_stopping' });
    const approvedAfterDrain = await relay.executeApprovedCall({
      approvalId: 'appr-after-drain',
      appId: app.id,
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
      args: { checkout_id: 'chk-1' },
    });
    expect(approvedAfterDrain).toMatchObject({ status: 'unsent', reason: 'relay_stopping' });
    // Approval was NOT claimed/consumed during shutdown.
    expect(
      await store.claimApprovedCall({
        approvalId: 'appr-after-drain',
        appId: app.id,
        grantGeneration: 1,
        toolName: 'confirm_checkout',
        definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
        argsHash: 'unused',
      }),
    ).toEqual({ status: 'claimed' });
  });

  it('returns cached settled outcome on direct replay, refreshes instruction-only changes on pinApp, rechecks label/grant before queued direct send, and stops queued sends after drain deadline', async () => {
    let blockNextResolve = false;
    let releaseBlocked!: () => void;
    let notifyBlockedEntered: (() => void) | undefined;

    const fake = new FakeMcpApp({
      appUrl: OPEN_URL,
      issuer: 'https://recipes.example.test',
      allowUnauthenticated: true,
      instructions: 'Instructions v1',
      tools: [SEARCH_TOOL, CHECKOUT_TOOL],
      onToolCall(call) {
        return { content: [{ type: 'text', text: `result:${String(call.arguments.query ?? '')}` }] };
      },
    });
    endpoints.use(fake.handle);

    const app = await connectOpenApp();
    let localHeldCalls = 0;
    const baseResolve = endpoints.egress.resolve!;
    const localRelay = createAppRelay({
      store,
      egress: {
        ...endpoints.egress,
        resolve: async (host) => {
          if (blockNextResolve) {
            blockNextResolve = false;
            const wait = new Promise<void>((resolve) => {
              releaseBlocked = resolve;
            });
            notifyBlockedEntered?.();
            await wait;
          }
          return baseResolve(host);
        },
      },
      now: () => clock,
      onHoldCall: async (input) => {
        localHeldCalls += 1;
        return { status: 'held', text: `held:${input.tool.name}` };
      },
    });
    try {
      const initialPin = await localRelay.pinApp(app.id);
      expect(initialPin.pin.instructions).toBe('Instructions v1');
      await store.applyToolLabels(app.id, [
        {
          name: 'search_menu',
          definitionHash: toolDefinitionHash(SEARCH_TOOL),
          label: 'just_do',
          source: 'sorter',
          reason: 'Lookup',
        },
        {
          name: 'confirm_checkout',
          definitionHash: toolDefinitionHash(CHECKOUT_TOOL),
          label: 'ask_first',
          source: 'floor',
          reason: 'Order',
        },
      ]);
      await store.markToolsReviewed(app.id, initialPin.pin.listHash);

      // 1) Instruction-only upstream change is picked up on pinApp via fresh handshake and invalidates review.
      fake.instructions = 'Instructions v2 (updated)';
      const refreshedPin = await localRelay.pinApp(app.id);
      expect(refreshedPin.pin.instructions).toBe('Instructions v2 (updated)');
      expect(refreshedPin.pin.listHash).not.toBe(initialPin.pin.listHash);
      expect(refreshedPin.pin.needsReview).toBe(true);

      // 2) Replaying a settled direct requestId returns the stored outcome without invoking upstream again.
      const firstDirect = await localRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'once-only' },
        session,
        requestId: 'req-replay-direct',
      });
      const replayedDirect = await localRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'once-only' },
        session,
        requestId: 'req-replay-direct',
      });
      expect(firstDirect).toMatchObject({ status: 'completed' });
      expect(replayedDirect).toEqual(firstDirect);
      expect(fake.toolCalls.filter((c) => c.arguments.query === 'once-only')).toHaveLength(1);

      // 3) Queued direct call whose tool flips to ask_first before dispatch routes to holdHandler instead of sending.
      blockNextResolve = true;
      const firstEntered = new Promise<void>((resolve) => {
        notifyBlockedEntered = resolve;
      });
      const blockingCall = localRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'hold-queue' },
        session,
        requestId: 'req-block-1',
      });
      await firstEntered;
      const queuedFlipped = localRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'flipped-while-queued' },
        session,
        requestId: 'req-flipped',
      });
      await vi.waitFor(async () => {
        expect(await store.getRelayCall(`direct:${session.id}:req-flipped`)).toMatchObject({ state: 'executing' });
      });
      await store.setToolLabel(app.id, 'search_menu', 'ask_first', 'principal', {
        expectedHash: toolDefinitionHash(SEARCH_TOOL),
      });
      releaseBlocked();
      // Both the in-flight call (caught at dial time) and the queued call reroute to hold without dialing upstream.
      expect(await blockingCall).toMatchObject({ status: 'held', text: 'held:search_menu' });
      expect(await queuedFlipped).toMatchObject({ status: 'held', text: 'held:search_menu' });
      expect(localHeldCalls).toBe(2);
      expect(fake.toolCalls.filter((c) => c.arguments.query === 'hold-queue')).toHaveLength(0);
      expect(fake.toolCalls.filter((c) => c.arguments.query === 'flipped-while-queued')).toHaveLength(0);

      // 4) Queued direct call to a no-auth app whose grant disconnects before dispatch is refused.
      await store.setToolLabel(app.id, 'search_menu', 'just_do', 'principal', {
        expectedHash: toolDefinitionHash(SEARCH_TOOL),
      });
      blockNextResolve = true;
      const secondEntered = new Promise<void>((resolve) => {
        notifyBlockedEntered = resolve;
      });
      const blockingDisconnect = localRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'block-for-disconnect' },
        session,
        requestId: 'req-block-2',
      });
      await secondEntered;
      const queuedAfterDisconnect = localRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'should-not-send-after-disconnect' },
        session,
        requestId: 'req-disconn',
      });
      await vi.waitFor(async () => {
        expect(await store.getRelayCall(`direct:${session.id}:req-disconn`)).toMatchObject({ state: 'executing' });
      });
      const currentApp = await store.get(app.id);
      await store.disconnect(currentApp.id, currentApp.version);
      releaseBlocked();
      await blockingDisconnect;
      expect(await queuedAfterDisconnect).toMatchObject({ status: 'unsent', reason: 'grant_changed' });
      expect(fake.toolCalls.filter((c) => c.arguments.query === 'should-not-send-after-disconnect')).toHaveLength(0);

      // 5) Queued call behind a slow op does not send once drain()'s grace deadline expires.
      const reconnected = await store.get(app.id);
      await store.connect(reconnected.id, reconnected.version, { kind: 'none' });
      await localRelay.pinApp(app.id);
      await store.applyToolLabels(app.id, [
        {
          name: 'search_menu',
          definitionHash: toolDefinitionHash(SEARCH_TOOL),
          label: 'just_do',
          source: 'sorter',
          reason: 'Lookup',
        },
      ]);
      blockNextResolve = true;
      const drainEntered = new Promise<void>((resolve) => {
        notifyBlockedEntered = resolve;
      });
      const slowCall = localRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'slow-drain' },
        session,
        requestId: 'req-slow-drain',
      });
      await drainEntered;
      const queuedBehindSlow = localRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'never-send-post-drain' },
        session,
        requestId: 'req-post-drain',
      });
      await localRelay.drain(20);
      releaseBlocked();
      await slowCall;
      expect(await queuedBehindSlow).toMatchObject({ status: 'unsent', reason: 'relay_stopping' });
      expect(fake.toolCalls.filter((c) => c.arguments.query === 'never-send-post-drain')).toHaveLength(0);
    } finally {
      await localRelay.closeAll();
    }
  });

  it('terminates discarded sessions, rejects >50-page catalogs, returns settled replays after label flips, preserves colliding assistant_summary args, and classifies handshake vs pending-fetch failures', async () => {
    // 1) Stateful server session IDs are terminated via DELETE on fresh-handshake refresh and closeAll.
    const deletedSessions: string[] = [];
    let sessionSeq = 0;
    const collidingTool = {
      name: 'record_note',
      description: 'Store a note that includes an upstream assistant_summary field.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          assistant_summary: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['assistant_summary', 'id'],
      },
    };
    const fake = new FakeMcpApp({
      appUrl: OPEN_URL,
      issuer: 'https://recipes.example.test',
      allowUnauthenticated: true,
      tools: [SEARCH_TOOL, collidingTool],
    });
    const sessionHandler = fake.handle;
    endpoints.use(async (req) => {
      if (req.host === 'recipes.example.test' && req.method === 'DELETE' && req.path === '/mcp') {
        const sid = req.headers['mcp-session-id'];
        if (typeof sid === 'string') deletedSessions.push(sid);
        return { status: 204 };
      }
      const reply = await sessionHandler(req);
      if (reply && req.method === 'POST' && req.body.includes('"initialize"')) {
        sessionSeq += 1;
        return {
          ...reply,
          headers: { ...reply.headers, 'mcp-session-id': `sess-up-${sessionSeq}` },
        };
      }
      return reply;
    });

    const app = await connectOpenApp();
    await relay.pinApp(app.id);
    await relay.pinApp(app.id);
    expect(deletedSessions).toContain('sess-up-1');

    // 2) Settled direct call replay returns the cached result even after the tool is flipped to ask_first.
    await store.applyToolLabels(app.id, [
      {
        name: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        label: 'just_do',
        source: 'sorter',
        reason: 'Lookup',
      },
      {
        name: 'record_note',
        definitionHash: toolDefinitionHash(collidingTool),
        label: 'just_do',
        source: 'principal',
        reason: 'Allowed by principal',
      },
    ]);
    const settledDirect = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'search_menu',
      args: { query: 'before-flip' },
      session,
      requestId: 'req-flip-replay',
    });
    expect(settledDirect.status).toBe('completed');
    const callsAfterFirst = fake.toolCalls.length;
    await store.setToolLabel(app.id, 'search_menu', 'ask_first', 'principal', {
      expectedHash: toolDefinitionHash(SEARCH_TOOL),
    });
    const replayedAfterFlip = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'search_menu',
      args: { query: 'before-flip' },
      session,
      requestId: 'req-flip-replay',
    });
    expect(replayedAfterFlip).toEqual(
      expect.objectContaining({
        status: 'completed',
        result: settledDirect.status === 'completed' ? settledDirect.result : undefined,
      }),
    );
    expect(fake.toolCalls).toHaveLength(callsAfterFirst);
    expect(heldCalls).toHaveLength(0);

    // 2b) Reusing a settled requestId with different arguments is refused instead of returning the earlier outcome.
    const mismatchedReplay = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'search_menu',
      args: { query: 'different-args' },
      session,
      requestId: 'req-flip-replay',
    });
    expect(mismatchedReplay).toMatchObject({ status: 'unsent', reason: 'request_id_conflict' });
    expect(fake.toolCalls).toHaveLength(callsAfterFirst);
    expect(heldCalls).toHaveLength(0);

    // 3) Colliding tool whose pinned schema declares assistant_summary preserves that upstream argument.
    const collidingOutcome = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'record_note',
      args: { id: 'n-1', assistant_summary: 'upstream note value' },
      summary: 'Relay summary text',
      session,
      requestId: 'req-colliding-arg',
    });
    expect(collidingOutcome.status).toBe('completed');
    expect(fake.toolCalls.find((c) => c.name === 'record_note')?.arguments).toEqual({
      id: 'n-1',
      assistant_summary: 'upstream note value',
    });

    // 4) Catalog pagination succeeds at 50 pages and fails (preserving existing pin) when page 50 still has nextCursor.
    let totalPages = 50;
    fake.mcpOverride = (incoming) => {
      if (!incoming.body.includes('"tools/list"')) return undefined;
      const body = JSON.parse(incoming.body) as { id?: number; params?: { cursor?: string } };
      const pageNum = body.params?.cursor ? Number(body.params.cursor) : 1;
      const nextCursor = pageNum < totalPages ? String(pageNum + 1) : undefined;
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [{ name: `tool_p_${pageNum}`, description: `Page ${pageNum}`, inputSchema: { type: 'object' } }],
            ...(nextCursor ? { nextCursor } : {}),
          },
        },
      };
    };
    const exact50 = await relay.pinApp(app.id);
    expect(exact50.tools).toHaveLength(50);

    totalPages = 51;
    await expect(relay.pinApp(app.id)).rejects.toThrow(/exceeded listMaxPages \(50\)/);
    expect(await store.listTools(app.id)).toHaveLength(50);
    fake.mcpOverride = undefined;

    // 5) Handshake EgressError (sent: true on initialize) reports tools/call as unsent, not unknown.
    let releaseStalledInit = (): void => undefined;
    fake.mcpOverride = async (incoming) => {
      if (incoming.body.includes('"initialize"')) {
        await new Promise<void>((resolve) => {
          releaseStalledInit = resolve;
        });
      }
      return undefined;
    };
    const handshakeFailRelay = createAppRelay({
      store,
      egress: endpoints.egress,
      timeoutMs: 60,
      now: () => clock,
    });
    try {
      await store.pinTools(app.id, { instructions: null, tools: [SEARCH_TOOL] });
      await store.setToolLabel(app.id, 'search_menu', 'just_do', 'principal', {
        expectedHash: toolDefinitionHash(SEARCH_TOOL),
      });
      const handshakeRes = await handshakeFailRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'hs-fail' },
        session,
        requestId: 'req-handshake-unsent',
      });
      expect(handshakeRes).toMatchObject({ status: 'unsent', reason: 'timeout' });
    } finally {
      releaseStalledInit();
      fake.mcpOverride = undefined;
      await handshakeFailRelay.closeAll();
    }

    // 6) Preflight definition_changed whose replacement is already just_do settles its own claim without deleting it first.
    let blockFirst = true;
    let releaseFirst = (): void => undefined;
    let notifyFirst = (): void => undefined;
    const defChangeRelay = createAppRelay({
      store,
      egress: {
        ...endpoints.egress,
        resolve: async (target) => {
          if (blockFirst) {
            blockFirst = false;
            notifyFirst();
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return endpoints.egress.resolve!(target);
        },
      },
      now: () => clock,
    });
    try {
      const firstEntered = new Promise<void>((resolve) => {
        notifyFirst = resolve;
      });
      const blocker = defChangeRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'blocker' },
        session,
        requestId: 'req-def-blocker',
      });
      await firstEntered;
      const queued = defChangeRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'queued-def-change' },
        session,
        requestId: 'req-def-justdo',
      });
      await vi.waitFor(async () => {
        expect(await store.getRelayCall(`direct:${session.id}:req-def-justdo`)).toMatchObject({ state: 'executing' });
      });
      const updatedSearch = { ...SEARCH_TOOL, description: 'Updated search menu v2' };
      await store.pinTools(app.id, { instructions: null, tools: [updatedSearch] });
      await store.applyToolLabels(app.id, [
        {
          name: 'search_menu',
          definitionHash: toolDefinitionHash(updatedSearch),
          label: 'just_do',
          source: 'sorter',
          reason: 'Updated lookup',
        },
      ]);
      releaseFirst();
      await blocker;
      expect(await queued).toMatchObject({ status: 'unsent', reason: 'definition_changed' });
      expect(await store.getRelayCall(`direct:${session.id}:req-def-justdo`)).toMatchObject({ state: 'unsent' });

      // 7) A transport failure/timeout after fetch started reports unknown, never unsent.
      let releaseStalledCall = (): void => undefined;
      fake.mcpOverride = async (incoming) => {
        if (incoming.body.includes('"tools/call"')) {
          await new Promise<void>((resolve) => {
            releaseStalledCall = resolve;
          });
        }
        return undefined;
      };
      const pendingFetchRelay = createAppRelay({
        store,
        egress: endpoints.egress,
        timeoutMs: 80,
        now: () => clock,
      });
      try {
        const timeoutOutcome = await pendingFetchRelay.callTool({
          serverKey: app.serverKey,
          toolName: 'search_menu',
          args: { query: 'timeout-mid-fetch' },
          session,
          requestId: 'req-mid-fetch-timeout',
        });
        expect(timeoutOutcome).toMatchObject({ status: 'unknown' });
      } finally {
        releaseStalledCall();
        fake.mcpOverride = undefined;
        await pendingFetchRelay.closeAll();
      }
    } finally {
      await defChangeRelay.closeAll();
    }
  });

  it('preserves composed allOf assistant_summary and own __proto__, rechecks live grant after egress resolve, and prevents double dispatch across reroute and approval paths', async () => {
    const composedSummaryTool = {
      name: 'allof_summary_tool',
      description: 'Declares assistant_summary via allOf',
      inputSchema: {
        type: 'object' as const,
        allOf: [
          {
            properties: { assistant_summary: { type: 'string' }, id: { type: 'string' } },
            required: ['assistant_summary', 'id'],
          },
        ],
      },
    };
    const fake = new FakeMcpApp({
      appUrl: OPEN_URL,
      issuer: 'https://recipes.example.test',
      allowUnauthenticated: true,
      tools: [SEARCH_TOOL, composedSummaryTool],
    });
    endpoints.use(fake.handle);
    const app = await connectOpenApp();
    await relay.pinApp(app.id);
    await store.applyToolLabels(app.id, [
      {
        name: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        label: 'just_do',
        source: 'sorter',
        reason: 'Lookup',
      },
      {
        name: 'allof_summary_tool',
        definitionHash: toolDefinitionHash(composedSummaryTool),
        label: 'just_do',
        source: 'principal',
        reason: 'Allowed by principal',
      },
    ]);

    // 1) Composed allOf assistant_summary is preserved upstream.
    const composedRes = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'allof_summary_tool',
      args: { id: 'a-1', assistant_summary: 'real allOf arg' },
      summary: 'Relay note',
      session,
      requestId: 'req-allof-summary',
    });
    expect(composedRes.status).toBe('completed');
    expect(fake.toolCalls.find((c) => c.name === 'allof_summary_tool')?.arguments).toEqual({
      id: 'a-1',
      assistant_summary: 'real allOf arg',
    });

    // 2) Stripping synthetic assistant_summary preserves an own __proto__ property.
    const argsWithOwnProto = JSON.parse(
      '{"query":"proto-test","__proto__":{"keep":true},"assistant_summary":"strip me"}',
    ) as Record<string, unknown>;
    const protoRes = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'search_menu',
      args: argsWithOwnProto,
      session,
      requestId: 'req-own-proto',
    });
    expect(protoRes.status).toBe('completed');
    const protoCall = fake.toolCalls.find((c) => c.arguments.query === 'proto-test')!;
    expect(Object.hasOwn(protoCall.arguments, '__proto__')).toBe(true);
    expect(Object.hasOwn(protoCall.arguments, 'assistant_summary')).toBe(false);

    // 3) Reroute to approval records a held invocation atomically: replaying after flipping back to just_do
    //    never dispatches directly, and executing the approval runs at most once.
    let blockQueue = true;
    let releaseQueue = (): void => undefined;
    let enteredQueue = (): void => undefined;
    const queueEntered = new Promise<void>((resolve) => {
      enteredQueue = resolve;
    });
    let holdEnteredResolve = (): void => undefined;
    const holdEntered = new Promise<void>((resolve) => {
      holdEnteredResolve = resolve;
    });
    let releaseHold = (): void => undefined;
    let holdInvocations = 0;
    const raceRelay = createAppRelay({
      store,
      egress: {
        ...endpoints.egress,
        resolve: async (target) => {
          if (blockQueue) {
            blockQueue = false;
            enteredQueue();
            await new Promise<void>((resolve) => {
              releaseQueue = resolve;
            });
          }
          return endpoints.egress.resolve!(target);
        },
      },
      now: () => clock,
      onHoldCall: async (input) => {
        holdInvocations += 1;
        if (holdInvocations === 1) {
          holdEnteredResolve();
          await new Promise<void>((resolve) => {
            releaseHold = resolve;
          });
        }
        return { status: 'held', text: `held:${input.tool.name}`, approvalId: 'apr-reroute-once' };
      },
    });
    try {
      const blocker = raceRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'allof_summary_tool',
        args: { id: 'blk-1', assistant_summary: 'blocker' },
        session,
        requestId: 'req-reroute-blocker',
      });
      await queueEntered;
      const rerouting = raceRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'reroute-once' },
        session,
        requestId: 'req-reroute-race',
      });
      await vi.waitFor(async () => {
        expect(await store.getRelayCall(`direct:${session.id}:req-reroute-race`)).toMatchObject({ state: 'executing' });
      });
      // Flip search_menu to ask_first so queued call reroutes to hold while blocker finishes cleanly.
      await store.setToolLabel(app.id, 'search_menu', 'ask_first', 'principal', {
        expectedHash: toolDefinitionHash(SEARCH_TOOL),
      });
      releaseQueue();
      await blocker;
      await holdEntered;
      // While holdHandler is still pending, flip back to just_do and replay the exact same requestId.
      await store.setToolLabel(app.id, 'search_menu', 'just_do', 'principal', {
        expectedHash: toolDefinitionHash(SEARCH_TOOL),
      });
      const replayDuringHold = await raceRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'reroute-once' },
        session,
        requestId: 'req-reroute-race',
      });
      releaseHold();
      const firstReroute = await rerouting;
      expect(firstReroute.status).toBe('held');
      expect(replayDuringHold.status).toBe('held');
      expect(fake.toolCalls.filter((c) => c.arguments.query === 'reroute-once')).toHaveLength(0);

      // Approved execution dispatches exactly once — even under a second approvalId for the same invocationId.
      const exec1 = await raceRelay.executeApprovedCall({
        approvalId: 'apr-reroute-once',
        invocationId: `${session.id}:req-reroute-race`,
        appId: app.id,
        grantGeneration: 1,
        toolName: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        args: { query: 'reroute-once' },
      });
      expect(exec1.status).toBe('completed');
      const exec2 = await raceRelay.executeApprovedCall({
        approvalId: 'apr-reroute-second',
        invocationId: `${session.id}:req-reroute-race`,
        appId: app.id,
        grantGeneration: 1,
        toolName: 'search_menu',
        definitionHash: toolDefinitionHash(SEARCH_TOOL),
        args: { query: 'reroute-once' },
      });
      expect(exec2).toMatchObject({ status: 'unsent', reason: 'already_dispatched' });
      expect(fake.toolCalls.filter((c) => c.arguments.query === 'reroute-once')).toHaveLength(1);

      // 4) Disconnect committed while tools/call egress resolve is pending aborts before dialing the socket.
      let armDisconnectOnResolve = false;
      const dialGuardRelay = createAppRelay({
        store,
        egress: {
          ...endpoints.egress,
          resolve: async (target) => {
            const dest = await endpoints.egress.resolve!(target);
            if (armDisconnectOnResolve) {
              armDisconnectOnResolve = false;
              const cur = await store.get(app.id);
              await store.disconnect(cur.id, cur.version);
            }
            return dest;
          },
        },
        now: () => clock,
      });
      try {
        // Warm the MCP session first so the next call's resolve happens strictly after verifyBeforeCall on tools/call.
        expect(
          (
            await dialGuardRelay.callTool({
              serverKey: app.serverKey,
              toolName: 'search_menu',
              args: { query: 'warm-dial-guard' },
              session,
              requestId: 'req-dial-guard-warm',
            })
          ).status,
        ).toBe('completed');
        const beforeCount = fake.toolCalls.length;
        armDisconnectOnResolve = true;
        const postDisc = await dialGuardRelay.callTool({
          serverKey: app.serverKey,
          toolName: 'search_menu',
          args: { query: 'must-not-dial-after-disconnect' },
          session,
          requestId: 'req-dial-guard',
        });
        expect(postDisc).toMatchObject({ status: 'unsent', reason: 'grant_changed' });
        expect(fake.toolCalls).toHaveLength(beforeCount);
      } finally {
        await dialGuardRelay.closeAll();
      }
    } finally {
      await raceRelay.closeAll();
    }
  });

  it('rechecks ask_first label at dial time, replays with recorded stripSummary rule, and reports unbound held reservations as unknown when tool is removed', async () => {
    const fake = new FakeMcpApp({
      appUrl: OPEN_URL,
      issuer: 'https://recipes.example.test',
      allowUnauthenticated: true,
      tools: [SEARCH_TOOL],
    });
    endpoints.use(fake.handle);
    const app = await connectOpenApp();
    await relay.pinApp(app.id);
    const searchHash = toolDefinitionHash(SEARCH_TOOL);
    await store.applyToolLabels(app.id, [
      { name: 'search_menu', definitionHash: searchHash, label: 'just_do', source: 'sorter', reason: 'Lookup' },
    ]);

    // 1) Flipping search_menu from just_do to ask_first while tools/call egress resolve is pending
    //    aborts before dialing and reroutes to hold (never dispatching upstream).
    let flipOnResolve = false;
    const dialHeld: HoldCallInput[] = [];
    const dialFlipRelay = createAppRelay({
      store,
      egress: {
        ...endpoints.egress,
        resolve: async (target) => {
          const dest = await endpoints.egress.resolve!(target);
          if (flipOnResolve) {
            flipOnResolve = false;
            await store.setToolLabel(app.id, 'search_menu', 'ask_first', 'principal', { expectedHash: searchHash });
          }
          return dest;
        },
      },
      now: () => clock,
      onHoldCall: async (input) => {
        dialHeld.push(input);
        return { status: 'held', text: 'Held after dial-time flip.', approvalId: 'apr-dial-flip' };
      },
    });
    try {
      // Warm session so next call hits resolve strictly during tools/call.
      const warm = await dialFlipRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'warm-dial-flip', assistant_summary: 'synthetic summary stripped on first call' },
        session,
        requestId: 'req-strip-rule-replay',
      });
      expect(warm.status).toBe('completed');
      const callsAfterWarm = fake.toolCalls.length;

      flipOnResolve = true;
      const flipped = await dialFlipRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'must-reroute-at-dial' },
        session,
        requestId: 'req-dial-flip-ask',
      });
      expect(flipped).toMatchObject({ status: 'held', approvalId: 'apr-dial-flip' });
      expect(dialHeld).toHaveLength(1);
      expect(fake.toolCalls).toHaveLength(callsAfterWarm);

      // 2) After tool schema changes to declare assistant_summary, exact replay of the earlier invocation
      //    still hashes using its recorded stripSummary=true rule and returns the settled result.
      const searchWithSummary: FakeToolDefinition = {
        name: 'search_menu',
        description: 'Search menu with real assistant_summary arg',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, assistant_summary: { type: 'string' } },
          required: ['query'],
        },
      };
      await store.pinTools(app.id, { instructions: null, tools: [searchWithSummary] });
      const replayed = await dialFlipRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'warm-dial-flip', assistant_summary: 'synthetic summary stripped on first call' },
        session,
        requestId: 'req-strip-rule-replay',
      });
      expect(replayed.status).toBe('completed');
      expect(fake.toolCalls).toHaveLength(callsAfterWarm);

      // And for an invocation dispatched with stripSummary=false (declared assistant_summary), changing
      // assistant_summary on replay is rejected as request_id_conflict (never accepted via stripped hash).
      await store.applyToolLabels(app.id, [
        {
          name: 'search_menu',
          definitionHash: toolDefinitionHash(searchWithSummary),
          label: 'just_do',
          source: 'principal',
          reason: 'Allowed',
        },
      ]);
      const realSummaryCall = await dialFlipRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'real-summary', assistant_summary: 'v1' },
        session,
        requestId: 'req-real-summary-strict',
      });
      expect(realSummaryCall.status).toBe('completed');
      const changedSummaryReplay = await dialFlipRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'search_menu',
        args: { query: 'real-summary', assistant_summary: 'v2' },
        session,
        requestId: 'req-real-summary-strict',
      });
      expect(changedSummaryReplay).toMatchObject({ status: 'unsent', reason: 'request_id_conflict' });

      // 3) Unbound active held reservation whose tool is removed from the pin returns unknown (not held)
      //    and preserves the existing reservation without initiating a second delivery.
      await store.reserveHeldInvocation({
        invocationId: `${session.id}:req-unbound-removed`,
        appId: app.id,
        grantGeneration: 1,
        toolName: 'removed_tool',
        argsHash: (await import('./canonical.js')).canonicalArgsHash({ id: 'u-1' }).hash,
        stripSummary: true,
      });
      const unboundOutcome = await dialFlipRelay.callTool({
        serverKey: app.serverKey,
        toolName: 'removed_tool',
        args: { id: 'u-1' },
        session,
        requestId: 'req-unbound-removed',
      });
      expect(unboundOutcome.status).toBe('unknown');
      expect(await store.getRelayInvocation(`${session.id}:req-unbound-removed`)).toMatchObject({
        mode: 'held',
        state: 'active',
        approvalId: null,
      });
    } finally {
      await dialFlipRelay.closeAll();
    }
  });
});

describe('catalog rules at the relay', () => {
  const SHOP_URL = 'https://mcp.shop.com/';
  const CONTEXT =
    'A one-off payment for the conference ticket the principal asked for, at the price shown on the page.';
  const ALLOWED_CREATE = {
    credentialType: 'shared_payment_token',
    amount: 4_500,
    context: CONTEXT,
    lineItem: ['name:Conference ticket'],
    total: 'type:total,display_text:Total,amount:4500',
    requestApproval: true,
    test: false,
    metadata: [],
  };

  async function connectLink(): Promise<ConnectionApp> {
    const created = await store.create({ name: 'Link', transport: 'host_cli', catalogId: 'link' });
    return (await store.connect(created.id, created.version, { kind: 'none' })).app;
  }

  function relayRows(): { readonly calls: number; readonly invocations: number } {
    return raw((db) => ({
      calls: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM relay_calls').get()!.n,
      invocations: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM relay_invocations').get()!.n,
    }));
  }

  it("refuses retrieving a spend request's card before anything reaches Link, and main sees why", async () => {
    const app = await connectLink();

    const response = await invokeAction({
      op: 'tools/call',
      serverKey: app.serverKey,
      tool: 'spend-request_retrieve',
      arguments: { id: 'lsrq_123', include: ['card'] },
    });

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      status: 'unsent',
      reason: 'refused_argument',
      text: expect.stringContaining('"include"'),
    });
    expect(relayRows()).toEqual({ calls: 0, invocations: 0 });
    expect(heldCalls).toEqual([]);
  });

  it.each([
    ['an approval it claims', 'spend-request_create', { ...ALLOWED_CREATE, approve: true }, 'approve'],
    ['an approval detail', 'spend-request_create', { ...ALLOWED_CREATE, approvalDetail: 'Approved' }, 'approvalDetail'],
    [
      'an approval policy',
      'mpp_pay',
      { url: 'https://api.merchant.example.test/pay', useApprovalPolicy: true },
      'useApprovalPolicy',
    ],
    [
      'a file to write the card to',
      'spend-request_retrieve',
      { id: 'lsrq_123', outputFile: '/tmp/card.json' },
      'outputFile',
    ],
    ['overwriting that file', 'spend-request_retrieve', { id: 'lsrq_123', force: false }, 'force'],
    ['a card credential', 'spend-request_create', { ...ALLOWED_CREATE, credentialType: 'card' }, 'credentialType'],
    [
      'a Link Pay Token, retrievable only as card data',
      'spend-request_create',
      { ...ALLOWED_CREATE, credentialType: 'link_pay_token' },
      'credentialType',
    ],
    [
      'no credential type, which Link reads as a card',
      'spend-request_create',
      Object.fromEntries(Object.entries(ALLOWED_CREATE).filter(([key]) => key !== 'credentialType')),
      'credentialType',
    ],
    ['an address that is not https', 'mpp_pay', { url: 'http://api.merchant.example.test/pay' }, 'url'],
  ])('refuses %s before anything is stored or sent', async (_case, tool, args, argument) => {
    const app = await connectLink();
    const requestId = `req-${randomUUID()}`;

    const outcome = await relay.callTool({ serverKey: app.serverKey, toolName: tool, args, session, requestId });

    expect(outcome).toMatchObject({ status: 'unsent', reason: 'refused_argument' });
    expect(outcome.status === 'unsent' && outcome.text).toContain(`"${argument}"`);
    expect(relayRows()).toEqual({ calls: 0, invocations: 0 });
    expect(heldCalls).toEqual([]);
  });

  it("offers none of a Shop listing's tools once a command a rule names is gone, and the app fails to pin", async () => {
    const tool = (name: string): FakeToolDefinition => ({
      name,
      description: `Shop ${name.replaceAll('_', ' ')}.`,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    });
    const fake = new FakeMcpApp({
      appUrl: SHOP_URL,
      issuer: 'https://mcp.shop.com',
      allowUnauthenticated: true,
      tools: [
        tool('search_catalog'),
        tool('complete_checkout'),
        tool('create_spend_request'),
        tool('get_spend_request'),
      ],
    });
    endpoints.use(fake.handle);
    const created = await store.create({ name: 'Shop', url: SHOP_URL, auth: 'none', catalogId: 'shop' });
    const { app } = await store.connect(created.id, created.version, { kind: 'none' });

    const pinned = await relay.pinApp(app.id);
    expect(pinned.tools.map((entry) => entry.name)).toEqual(['complete_checkout', 'search_catalog']);

    fake.tools = [tool('search_catalog'), tool('complete_checkout'), tool('create_spend_request')];
    await expect(relay.pinApp(app.id)).rejects.toThrow();

    expect(await store.listTools(app.id)).toEqual([]);
    expect((await relay.listToolsForSession(app.serverKey)).tools).toEqual([]);
    const outcome = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'search_catalog',
      args: { id: 'p-1' },
      session,
      requestId: `req-${randomUUID()}`,
    });
    expect(outcome).toMatchObject({ status: 'unsent', reason: 'unknown_tool' });
    expect(fake.toolCalls).toEqual([]);
  });

  function mainNoteTexts(prefix: string): string[] {
    const file = inboundDbPath(session.agent_group_id, session.id);
    if (!fs.existsSync(file)) return [];
    const db = new Database(file, { readonly: true });
    try {
      return db
        .prepare<[string], { content: string }>('SELECT content FROM messages_in WHERE id LIKE ?')
        .all(`${prefix}%`)
        .map((row) => (JSON.parse(row.content) as { text: string }).text);
    } finally {
      db.close();
    }
  }

  it('tells main once, without an address, that the app’s tools are paused until the operator updates', async () => {
    const tool = (name: string): FakeToolDefinition => ({
      name,
      description: `Shop ${name.replaceAll('_', ' ')}.`,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    });
    const fake = new FakeMcpApp({
      appUrl: SHOP_URL,
      issuer: 'https://mcp.shop.com',
      allowUnauthenticated: true,
      tools: [tool('search_catalog'), tool('create_spend_request')],
    });
    endpoints.use(fake.handle);
    const created = await store.create({ name: 'Shop', url: SHOP_URL, auth: 'none', catalogId: 'shop' });
    const { app } = await store.connect(created.id, created.version, { kind: 'none' });

    await expect(relay.pinApp(app.id)).rejects.toThrow();
    await expect(relay.pinApp(app.id)).rejects.toThrow();

    const notes = mainNoteTexts('connection-rules-unmatched:');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"Shop"');
    expect(notes[0]).toContain('paused');
    expect(notes[0]).toContain('operator');
    for (const leaked of ['http', 'mcp.shop.com', HOST_CLI_DOMAIN]) expect(notes[0]).not.toContain(leaked);
  });

  describe('a recorded Link listing that no longer matches the rules', () => {
    const recorded = (
      JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'testing', 'link-1.6.0-tools.json'), 'utf8')) as {
        readonly tools: readonly FakeToolDefinition[];
      }
    ).tools;

    function withProperty(
      tools: readonly FakeToolDefinition[],
      toolName: string,
      change: (properties: Record<string, Record<string, unknown>>) => void,
    ): FakeToolDefinition[] {
      return tools.map((entry) => {
        if (toolName !== 'all' && entry.name !== toolName) return entry;
        const properties = structuredClone({ ...entry.inputSchema.properties });
        change(properties);
        return { ...entry, inputSchema: { ...entry.inputSchema, properties } };
      });
    }

    it.each([
      [
        'spend-request_create without credentialType',
        withProperty(recorded, 'spend-request_create', (properties) => {
          delete properties.credentialType;
        }),
      ],
      [
        'a credentialType that no longer offers shared_payment_token',
        withProperty(recorded, 'spend-request_create', (properties) => {
          properties.credentialType = { ...properties.credentialType, enum: ['card', 'link_pay_token'] };
        }),
      ],
      [
        'no tool taking approve',
        withProperty(recorded, 'all', (properties) => {
          delete properties.approve;
        }),
      ],
    ])('offers none of its tools when it lists %s, and the app fails to pin', async (_case, drifted) => {
      // Rules apply by the app's catalog entry, whatever carries its listing, so a served listing stands in for the CLI.
      const fake = new FakeMcpApp({
        appUrl: OPEN_URL,
        issuer: 'https://recipes.example.test',
        allowUnauthenticated: true,
        tools: [...recorded],
      });
      endpoints.use(fake.handle);
      const created = await store.create({ name: 'Link', url: OPEN_URL, auth: 'none', catalogId: 'link' });
      const { app } = await store.connect(created.id, created.version, { kind: 'none' });
      expect((await relay.pinApp(app.id)).tools.length).toBeGreaterThan(0);

      fake.tools = drifted;
      await expect(relay.pinApp(app.id)).rejects.toThrow();

      expect(await store.listTools(app.id)).toEqual([]);
      expect((await relay.listToolsForSession(app.serverKey)).tools).toEqual([]);
    });
  });
});
