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
import type { ConnectionApp, ConnectionsStore } from './store.js';
import { FakeMcpApp, startFakeEndpoints, type FakeEndpoints, type FakeToolDefinition } from './testing/oauth-server.js';
import { testConnectionsStore } from './testing/store.js';

const FOOD_URL = 'https://mcp.chow.example.test/mcp';
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
let relay: AppRelay;
let session: Session;
let clock: number;
let heldCalls: HoldCallInput[];
let sortNotifications: { appId: string; listHash: string }[];

beforeAll(async () => {
  endpoints = await startFakeEndpoints(['mcp.chow.example.test', 'recipes.example.test']);
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
  ({ store } = testConnectionsStore(path.join(ROOT, 'connections')));
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
  await relay.closeAll();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function connectOAuthApp(fake: FakeMcpApp): Promise<ConnectionApp> {
  fake.accessTokens.add(SENTINEL_ACCESS);
  const created = await store.create({
    name: 'Chow',
    url: FOOD_URL,
    auth: 'oauth',
    issuer: 'https://mcp.chow.example.test/',
  });
  const { state } = await store.startSignIn(created.id, created.version, {
    principalId: 'gchat:users/morgan',
    verifier: 'verifier-'.padEnd(48, 'x'),
    issuer: 'https://mcp.chow.example.test/',
    redirectUri: 'https://juno.example.test/connections/callback/mcp.chow.example.test',
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
  const created = await store.create({ name: 'Chow', url: FOOD_URL, auth: 'token' });
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
      issuer: 'https://mcp.chow.example.test',
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
      arguments: { query: 'jollof' },
    });

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: JSON.stringify({ ok: true, tool: 'search_menu', arguments: { query: 'jollof' } }) },
        ],
      },
    });
    expect(fake.toolCalls).toEqual([{ name: 'search_menu', arguments: { query: 'jollof' }, bearer: SENTINEL_ACCESS }]);
    expect(endpoints.requests.filter((r) => r.method === 'GET' && r.path === '/mcp')).toEqual([]);
    expect(await store.recentCompletedResults(app.id, 1)).toHaveLength(1);
  });

  it('refuses calls from any non-main agent group before touching the app', async () => {
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.chow.example.test',
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
      issuer: 'https://mcp.chow.example.test',
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
      issuer: 'https://mcp.chow.example.test',
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
      issuer: 'https://mcp.chow.example.test',
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
      issuer: 'https://mcp.chow.example.test',
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
      issuer: 'https://mcp.chow.example.test',
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
      issuer: 'https://mcp.chow.example.test',
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
      issuer: 'https://mcp.chow.example.test',
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
      issuer: 'https://mcp.chow.example.test',
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
      issuer: 'https://mcp.chow.example.test',
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
      const added = await ops.add({ url: FOOD_URL, name: 'Chow' });
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
      issuer: 'https://mcp.chow.example.test',
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
    fake.mcpOverride = (incoming) => {
      if (disconnectOnce && incoming.body.includes('"tools/list"')) {
        disconnectOnce = false;
        void store.get(app.id).then((latest) => ops.disconnect(latest.id, latest.version));
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
  });
});
