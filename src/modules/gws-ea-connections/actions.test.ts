import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/connections-actions-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
  GROUPS_DIR: `${ROOT}/groups`,
}));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { createSession, getPendingApprovalsByAction, transitionPendingApprovalStatus } from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { PendingApproval, Session } from '../../types.js';
import '../approvals/index.js';
import { finalizeReject } from '../approvals/finalize.js';
import { getApprovalHandler } from '../approvals/primitive.js';
import { resumeApprovedApprovals } from '../approvals/response-handler.js';
import { MAIN, mainSession, seedMain } from '../gws-ea-matters/testing/main-conversation.js';
import '../gws-ea-profile/index.js';
import '../self-mod/index.js';
import { ADD_APP_ACTION, APP_TOOL_ASK_ACTION, DELETE_APP_ACTION, registerAppActions } from './actions.js';
import { normalizeToolDefinition } from './canonical.js';
import type { AdmissionDependencies } from './admit.js';
import { applyMainServers, appRelayServerEntry, mainOperatorServers } from './apply.js';
import { ConnectionOperations } from './operations.js';
import type { ConnectionsStore } from './store.js';
import { FakeMcpApp, startFakeEndpoints, type FakeEndpoints, type FakeHandler } from './testing/oauth-server.js';
import { testConnectionsStore } from './testing/store.js';

const HOST = 'juno.example.test';
const PRINCIPAL = 'gchat:users/morgan';
const LEDGERLY = 'https://app.ledgerly.example.test/mcp';
const RECIPES = 'https://recipes.example.test/mcp';
const BOOKS = 'https://bücher.example.test/mcp';
const BOOKS_HOST = 'xn--bcher-kva.example.test';
const LARDER = 'https://mcp.larder.example.test/mcp';
const SENTINEL_SECRET = 'sentinel-client-secret-H2v6';

/** Answers without sign-in and advertises its name. */
function openServer(host: string, name: string): FakeHandler {
  return (incoming) =>
    incoming.host === host && incoming.method === 'POST'
      ? { status: 200, body: { jsonrpc: '2.0', id: 1, result: { serverInfo: { name, version: '1' } } } }
      : undefined;
}

/** Ledgerly as it publishes itself: OAuth on its own authorization server, a client registered by hand. */
function ledgerly(): FakeMcpApp {
  return new FakeMcpApp({
    appUrl: LEDGERLY,
    issuer: 'https://auth.example.test',
    client: {
      id: 'juno-ledgerly',
      secret: SENTINEL_SECRET,
      redirectUri: `https://${HOST}/connections/callback/app.ledgerly.example.test`,
    },
  });
}

/** The gateway seam as admission sees it: credentials listed by exact host. */
class FakeGateway {
  readonly held = new Map<string, { readonly id: string; readonly host: string }>();
  async listForHost(host: string): Promise<{ id: string; name: string }[]> {
    return [...this.held].filter(([, held]) => held.host === host).map(([name, held]) => ({ id: held.id, name }));
  }
}

let endpoints: FakeEndpoints;
let store: ConnectionsStore;
let gateway: FakeGateway;
let session: Session;
let cards: { title: string; question: string }[];
let documentsServed: boolean;

beforeAll(async () => {
  endpoints = await startFakeEndpoints([
    'app.ledgerly.example.test',
    'auth.example.test',
    'recipes.example.test',
    BOOKS_HOST,
    'mcp.larder.example.test',
  ]);
  registerAppActions({
    context: async () => {
      const admission: AdmissionDependencies = {
        appByHost: (host) => store.byHost(host),
        operatorServers: mainOperatorServers,
        gatewayCredentials: (host) => gateway.listForHost(host),
        protectedHosts: async () => new Set([HOST]),
      };
      const oauth = { assistantHost: HOST, fetches: endpoints.fetches };
      return {
        store,
        admission,
        oauth,
        operations: new ConnectionOperations({
          store,
          webHostname: HOST,
          fetches: endpoints.fetches,
          admission,
          applyMain: applyMainServers,
          clientDocumentsServed: () => documentsServed,
        }),
      };
    },
  });
});
afterAll(async () => {
  await endpoints.close();
});

beforeEach(async () => {
  endpoints.reset();
  documentsServed = true;
  for (const handler of [
    ledgerly().handle,
    openServer('recipes.example.test', 'Recipes'),
    openServer(BOOKS_HOST, 'Books'),
  ])
    endpoints.use(handler);
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  ({ store } = testConnectionsStore(path.join(ROOT, 'connections')));
  gateway = new FakeGateway();
  await runMigrations(await initTestDb());
  await seedMain('UTC');
  session = await mainSession();
  cards = [];
  setDeliveryAdapter({
    deliver: async (_channelType, _platformId, _threadId, _kind, content) => {
      const card = JSON.parse(content) as { title: string; question: string };
      cards.push({ title: card.title, question: card.question });
      return `card-${cards.length}`;
    },
  });
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

interface Row {
  readonly id: string;
  readonly trigger: number;
  readonly content: string;
}

function inbound(target: Session = session): Row[] {
  const file = inboundDbPath(target.agent_group_id, target.id);
  if (!fs.existsSync(file)) return [];
  const db = new Database(file);
  try {
    return db.prepare('SELECT id, trigger, content FROM messages_in ORDER BY seq').all() as Row[];
  } finally {
    db.close();
  }
}

function answerTo(requestId: string, target: Session = session): unknown {
  const row = inbound(target).find(({ id }) => id === `action-resp-${requestId}`);
  return row && (JSON.parse(row.content) as { frame: unknown }).frame;
}

function notes(prefix: string): Row[] {
  return inbound().filter(({ id }) => id.startsWith(prefix));
}

async function send(
  action: string,
  fields: Record<string, unknown>,
  target: Session = session,
): Promise<{ requestId: string; answer: unknown }> {
  const requestId = `act-${randomUUID()}`;
  const run = getDeliveryAction(action);
  if (!run) throw new Error(`${action} is not registered`);
  await run({ action, requestId, ...fields }, target);
  return { requestId, answer: answerTo(requestId, target) };
}

async function onlyApproval(action: string): Promise<PendingApproval> {
  const rows = await getPendingApprovalsByAction(action);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function approve(action: string): Promise<void> {
  const row = await onlyApproval(action);
  expect(await transitionPendingApprovalStatus(row.approval_id, 'pending', 'approved')).toBe(true);
  await resumeApprovedApprovals();
}

function everything(): string {
  return JSON.stringify({ cards, inbound: inbound() });
}

describe('add_app', () => {
  it("holds Ledgerly for the principal's card, then lists it Not connected and asks main to send the link", async () => {
    const { answer } = await send(ADD_APP_ACTION, { url: LEDGERLY, name: 'Ledgerly' });

    expect(answer).toMatchObject({ ok: true, data: { status: 'awaiting_principal' } });
    expect(await store.apps()).toEqual([]);
    expect((await onlyApproval(ADD_APP_ACTION)).approver_user_id).toBe(PRINCIPAL);
    expect(cards).toEqual([
      {
        title: 'Add this app?',
        question: [
          "I'd like to add an app at app.ledgerly.example.test.",
          'You would sign in at auth.example.test.',
          'The name I gave it: "Ledgerly"',
          "Your operator hasn't reviewed this server, and I'll send it information when I use it.",
        ].join('\n'),
      },
    ]);

    await approve(ADD_APP_ACTION);

    const [app, ...others] = await store.apps();
    expect(others).toEqual([]);
    expect(app).toMatchObject({
      name: 'Ledgerly',
      host: 'app.ledgerly.example.test',
      status: 'not_connected',
      auth: 'oauth',
    });
    expect(app.serverKey.startsWith('app_')).toBe(true);
    const [note] = notes('connection-add:');
    expect(note.trigger).toBe(1);
    expect(JSON.parse(note.content)).toMatchObject({
      text: expect.stringContaining('Send them the Connections link from principal_page'),
    });
    expect(everything()).not.toContain(SENTINEL_SECRET);
    expect(await getPendingApprovalsByAction(ADD_APP_ACTION)).toEqual([]);
  });

  it('adds an app whose server takes only client documents ready to connect, with no client details', async () => {
    endpoints.use(
      new FakeMcpApp({
        appUrl: LARDER,
        issuer: 'https://mcp.larder.example.test',
        tokenAuthMethods: ['none'],
        issParameter: true,
        fetchClientDocument: async () => ({ status: 404 }),
      }).handle,
    );
    await send(ADD_APP_ACTION, { url: LARDER, name: 'Larder' });
    expect(cards[0].question).toContain('You would sign in at mcp.larder.example.test.');

    await approve(ADD_APP_ACTION);

    expect(await store.apps()).toEqual([
      expect.objectContaining({ name: 'Larder', status: 'not_connected', hasClient: true, clientEntered: false }),
    ]);
    const { text } = JSON.parse(notes('connection-add:')[0].content) as { text: string };
    expect(text).toContain(
      'not connected yet. Send them the Connections link from principal_page; they sign in to it there.',
    );
    expect(text).not.toContain('client details');
    expect(endpoints.requests.filter(({ path: route }) => route.startsWith('/oauth/'))).toEqual([]);
  });

  it('tells main an approved add could not happen while client documents are not served, and stores nothing', async () => {
    documentsServed = false;
    endpoints.use(
      new FakeMcpApp({
        appUrl: LARDER,
        issuer: 'https://mcp.larder.example.test',
        tokenAuthMethods: ['none'],
        issParameter: true,
        fetchClientDocument: async () => ({ status: 404 }),
      }).handle,
    );
    await send(ADD_APP_ACTION, { url: LARDER, name: 'Larder' });

    await approve(ADD_APP_ACTION);

    expect(await store.apps()).toEqual([]);
    const { text } = JSON.parse(notes('connection-add:')[0].content) as { text: string };
    expect(text).toContain(
      'but it could not be added: The assistant cannot sign in to this app right now, so it was not added. Try again later.',
    );
    expect(endpoints.requests.filter(({ path: route }) => route.startsWith('/oauth/'))).toEqual([]);
  });

  it('shows an internationalized host in plain letters on the card', async () => {
    await send(ADD_APP_ACTION, { url: BOOKS, name: 'Books' });

    expect(cards[0].question).toContain(`I'd like to add an app at ${BOOKS_HOST}.`);
    expect(cards[0].question).toContain('It asks for no sign-in.');
    expect(cards[0].question).not.toContain('bücher');
  });

  it('connects a server without sign-in on approval and asks for main to restart', async () => {
    await send(ADD_APP_ACTION, { url: RECIPES, name: 'Recipes' });
    await approve(ADD_APP_ACTION);

    const [app] = await store.apps();
    expect(app).toMatchObject({ name: 'Recipes', status: 'connected' });
    const servers = JSON.parse((await getContainerConfig(MAIN))?.mcp_servers ?? '{}') as Record<string, unknown>;
    expect(servers[app.serverKey]).toEqual(appRelayServerEntry(app.serverKey));
    expect(await store.pendingRestart()).toBeDefined();
    expect(JSON.parse(notes('connection-add:')[0].content)).toMatchObject({
      text: expect.stringContaining('connected; its tools reach you by their next message'),
    });
  });

  it('refuses a credential in the address or beside it, or a host an operator server uses, before any card exists', async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { ledgerly: { type: 'http', url: LEDGERLY } });

    const inUrl = await send(ADD_APP_ACTION, { url: `${RECIPES}?api_key=sentinel-url-key-Z1`, name: 'Recipes' });
    const beside = await send(ADD_APP_ACTION, { url: RECIPES, name: 'Recipes', clientSecret: SENTINEL_SECRET });
    const operatorHost = await send(ADD_APP_ACTION, { url: LEDGERLY, name: 'Ledgerly' });

    expect(inUrl.answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('query') } });
    expect(beside.answer).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(operatorHost.answer).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("one of the operator's servers") },
    });
    expect(await getPendingApprovalsByAction(ADD_APP_ACTION)).toEqual([]);
    expect(cards).toEqual([]);
    expect(endpoints.requests).toEqual([]);
    expect(await store.apps()).toEqual([]);
    expect(everything()).not.toContain(SENTINEL_SECRET);
  });

  it('creates nothing when the principal declines, and tells main so', async () => {
    await send(ADD_APP_ACTION, { url: RECIPES, name: 'Recipes' });

    expect(await finalizeReject(await onlyApproval(ADD_APP_ACTION), PRINCIPAL)).toBe(true);

    expect(await store.apps()).toEqual([]);
    expect(notes('connection-add:')).toEqual([]);
    expect(inbound().some(({ content }) => content.includes('declined adding the app at recipes.example.test'))).toBe(
      true,
    );
  });

  it('finishes an approved add once when a restart replays it after the app was stored', async () => {
    await send(ADD_APP_ACTION, { url: RECIPES, name: 'Recipes' });
    const row = await onlyApproval(ADD_APP_ACTION);
    await transitionPendingApprovalStatus(row.approval_id, 'pending', 'approved');
    // The first run stored the app, then the host stopped before connecting it or telling main.
    await store.create({ name: 'Recipes', url: RECIPES, auth: 'none' });

    await resumeApprovedApprovals();
    const handler = getApprovalHandler(ADD_APP_ACTION);
    if (!handler) throw new Error('add_app has no approval handler');
    await handler({
      session,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      approval: { ...row, status: 'approved' },
      userId: PRINCIPAL,
      notify: async () => undefined,
    });

    const [app, ...others] = await store.apps();
    expect(others).toEqual([]);
    expect(app.status).toBe('connected');
    const added = notes('connection-add:');
    expect(added).toHaveLength(1);
    expect(JSON.parse(added[0].content)).toMatchObject({
      text: expect.stringContaining('connected; its tools reach you by their next message'),
    });
    expect(await getPendingApprovalsByAction(ADD_APP_ACTION)).toEqual([]);
  });

  it('is refused for any group but canonical main', async () => {
    const now = new Date().toISOString();
    await createAgentGroup({
      id: 'ag-other',
      name: 'other',
      folder: 'ag-other',
      agent_provider: null,
      created_at: now,
    });
    await ensureContainerConfig('ag-other');
    const other: Session = { ...session, id: 'sess-other', agent_group_id: 'ag-other', messaging_group_id: null };
    await createSession(other);

    const { answer } = await send(ADD_APP_ACTION, { url: RECIPES, name: 'Recipes' }, other);

    expect(answer).toMatchObject({ ok: false, error: { code: 'forbidden', message: 'Only main may add an app.' } });
    expect(await getPendingApprovalsByAction(ADD_APP_ACTION)).toEqual([]);
  });
});

describe('delete_app', () => {
  it("refuses an operator's server before any card exists", async () => {
    await updateContainerConfigJson(MAIN, 'mcp_servers', { ledgerly: { type: 'http', url: LEDGERLY } });

    const { answer } = await send(DELETE_APP_ACTION, { app: 'app_000000000000' });
    const operator = await send(DELETE_APP_ACTION, { app: 'ledgerly' });

    expect(answer).toMatchObject({ ok: false, error: { message: expect.stringContaining('No app the principal') } });
    expect(operator.answer).toMatchObject({ ok: false, error: { message: expect.stringContaining("operator's") } });
    expect(await getPendingApprovalsByAction(DELETE_APP_ACTION)).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("deletes a principal's app once they approve, with a note that does not wake main", async () => {
    const created = await store.create({ name: 'Recipes', url: RECIPES, auth: 'none' });
    await store.connect(created.id, created.version, { kind: 'none' });
    await applyMainServers(store);

    const { answer } = await send(DELETE_APP_ACTION, { app: created.serverKey });
    expect(answer).toMatchObject({ ok: true, data: { status: 'awaiting_principal' } });
    expect(cards[0]).toEqual({
      title: 'Delete this app?',
      question:
        'I\'d like to delete your app at recipes.example.test, named "Recipes".\nIt would be disconnected and removed from your Connections page.',
    });

    await approve(DELETE_APP_ACTION);

    expect(await store.apps()).toEqual([]);
    const servers = JSON.parse((await getContainerConfig(MAIN))?.mcp_servers ?? '{}') as Record<string, unknown>;
    expect(servers[created.serverKey]).toBeUndefined();
    const [note] = notes('connection-delete:');
    expect(note.trigger).toBe(0);
    expect(JSON.parse(note.content)).toMatchObject({ text: expect.stringContaining('It is deleted') });
  });
});

describe('app_tool_ask', () => {
  it('holds a card in both directions, updates the label only on approval, and refuses if the definition changed', async () => {
    const created = await store.create({ name: 'Food', url: RECIPES, auth: 'token' });
    await store.connect(created.id, created.version, { kind: 'token', token: 'tok-abc' });
    const v1 = normalizeToolDefinition({
      name: 'confirm_checkout',
      description: 'Place the food order.',
      inputSchema: { type: 'object', properties: {} },
    });
    const pinned = await store.pinTools(created.id, { instructions: null, tools: [v1] });
    await store.applyToolLabels(created.id, [
      {
        name: 'confirm_checkout',
        definitionHash: pinned.tools[0]!.definitionHash,
        label: 'ask_first',
        source: 'floor',
        reason: 'Places order',
      },
    ]);

    // Direction 1: ask_first -> just_do (approved)
    const lower = await send(APP_TOOL_ASK_ACTION, {
      app: created.serverKey,
      tool: 'confirm_checkout',
      ask_first: false,
      reason: 'Principal asked to run without asking',
    });
    expect(lower.answer).toMatchObject({ ok: true, data: { status: 'awaiting_principal' } });
    expect((await store.getTool(created.id, 'confirm_checkout'))?.label).toBe('ask_first');
    await approve(APP_TOOL_ASK_ACTION);
    expect((await store.getTool(created.id, 'confirm_checkout'))?.label).toBe('just_do');

    // Direction 2: just_do -> ask_first, but definition changes before approval -> refused!
    const raise = await send(APP_TOOL_ASK_ACTION, {
      app: created.serverKey,
      tool: 'confirm_checkout',
      ask_first: true,
    });
    expect(raise.answer).toMatchObject({ ok: true, data: { status: 'awaiting_principal' } });
    const v2 = normalizeToolDefinition({
      name: 'confirm_checkout',
      description: 'Place the food order with tip.',
      inputSchema: { type: 'object', properties: {} },
    });
    await store.pinTools(created.id, { instructions: null, tools: [v2] });
    await approve(APP_TOOL_ASK_ACTION);
    // Tool stayed unsorted (label null) because definition changed before 👍!
    expect((await store.getTool(created.id, 'confirm_checkout'))?.label).toBeNull();
    const changeNote = notes('connection-tool-ask:').at(-1);
    expect(JSON.parse(changeNote!.content)).toMatchObject({
      text: expect.stringContaining('definition changed'),
    });
  });
});

describe("main's self-modification path", () => {
  it('refuses an add_mcp_server action main writes before any approval row exists', async () => {
    const run = getDeliveryAction('add_mcp_server');
    if (!run) throw new Error('add_mcp_server is not registered');

    await run({ action: 'add_mcp_server', name: 'ledgerly', url: LEDGERLY }, session);

    expect(await getPendingApprovalsByAction('add_mcp_server')).toEqual([]);
    expect(cards).toEqual([]);
    expect(inbound().some(({ content }) => content.includes('use add_app or delete_app'))).toBe(true);
    expect(JSON.parse((await getContainerConfig(MAIN))?.mcp_servers ?? '{}')).toEqual({});
  });
});
