import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = `/tmp/nanoclaw-gws-ea-held-calls-test-${process.pid}`;

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: `/tmp/nanoclaw-gws-ea-held-calls-test-${process.pid}/groups`,
  DATA_DIR: `/tmp/nanoclaw-gws-ea-held-calls-test-${process.pid}/data`,
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../request-wake.js', () => ({
  requestWake: vi.fn(async () => true),
}));

import { MAX_CARD_QUESTION_LENGTH } from '../../channels/ask-question.js';
import {
  closeDb,
  createMessagingGroup,
  createSession,
  deleteSession,
  getDb,
  getPendingApprovalsByAction,
  initTestDb,
  runMigrations,
  transitionPendingApprovalStatus,
} from '../../db/index.js';
import { markApprovalAwaitingReason } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { sessionDir } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { expireApproval } from '../approvals/lifecycle.js';
import { requestApproval } from '../approvals/primitive.js';
import { handleApprovalsResponse, resumeApprovedApprovals } from '../approvals/response-handler.js';
import '../gws-ea-artifacts/index.js';
import { MAIN, mainSession as getMainSession, seedMain } from '../gws-ea-matters/testing/main-conversation.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { principalPages, registerWebMount } from '../gws-ea-web/mounts.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import { APP_TOOL_ASK_ACTION } from './actions.js';
import { connectionsWebMount } from './connections-mount.js';
import {
  createHoldCallHandler,
  getPendingHeldCallApproval,
  HELD_APP_CALL_ACTION,
  HELD_CALL_ANSWER,
  listPendingHeldCallApprovals,
  registerHeldAppCallHandlers,
  renderCompactArgs,
  resolveDetailsHostname,
  resolveHeldCallFromWeb,
  withdrawHeldAppCalls,
} from './held-calls.js';
import { ConnectionOperations } from './operations.js';
import { startAppRelay, stopAppRelay, type AppRelay } from './relay.js';
import type { ConnectionsStore } from './store.js';
import { FakeMcpApp, startFakeEndpoints, type FakeEndpoints, type FakeToolDefinition } from './testing/oauth-server.js';
import { testConnectionsStore } from './testing/store.js';

const PRINCIPAL_USER = 'gchat:users/morgan';
const FOOD_URL = 'https://mcp.food.example.test/mcp';
const HOSTNAME = 'juno.example.test';

const PREPARE_TOOL: FakeToolDefinition = {
  name: 'prepare_checkout',
  description: 'Prepare a cart checkout preview.',
  inputSchema: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
};

const CONFIRM_TOOL: FakeToolDefinition = {
  name: 'confirm_checkout',
  description: 'Confirm and place the food order.',
  inputSchema: { type: 'object', properties: { checkout_id: { type: 'string' } }, required: ['checkout_id'] },
};

interface DeliveredCard {
  readonly questionId: string;
  readonly title: string;
  readonly question: string;
  readonly options: readonly { readonly value: string }[];
}

let endpoints: FakeEndpoints;
let directory: string;
let store: ConnectionsStore;
let relay: AppRelay | undefined;
let mainSession: Session;
let deliveredCards: DeliveredCard[];
let editedCards: Array<{ messageId: string; text: string }>;
let nextMsgId: number;

beforeAll(async () => {
  endpoints = await startFakeEndpoints(['mcp.food.example.test']);
});

afterAll(async () => {
  await endpoints.close();
});

function readMainMessages(): Array<{ id: string; content: Record<string, unknown>; trigger: number }> {
  const file = path.join(sessionDir(mainSession.agent_group_id, mainSession.id), 'inbound.db');
  if (!fs.existsSync(file)) return [];
  const db = new Database(file);
  try {
    return db
      .prepare<[], { id: string; content: string; trigger: number }>(
        'SELECT id, content, trigger FROM messages_in ORDER BY seq',
      )
      .all()
      .map((row) => ({
        id: row.id,
        content: JSON.parse(row.content) as Record<string, unknown>,
        trigger: row.trigger,
      }));
  } finally {
    db.close();
  }
}

async function setupFoodApp(tools: readonly FakeToolDefinition[] = [PREPARE_TOOL, CONFIRM_TOOL]) {
  const fake = new FakeMcpApp({
    appUrl: FOOD_URL,
    issuer: 'https://mcp.food.example.test',
    tools: [...tools],
    onToolCall(call) {
      if (call.name === 'prepare_checkout') {
        return {
          content: [
            {
              type: 'text',
              text: 'Prepared checkout chk_order_7788: 1x Grain Bowl from Corner Kitchen, total $18.50.',
            },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: `Order confirmed for ${String(call.arguments.checkout_id ?? 'unknown')}` }],
      };
    },
  });
  fake.accessTokens.add('food-secret-token');
  endpoints.use(fake.handle);

  const created = await store.create({ name: 'Bistro', url: FOOD_URL, auth: 'token' });
  const connected = await store.connect(created.id, created.version, { kind: 'token', token: 'food-secret-token' });

  const holdHandler = createHoldCallHandler({
    store,
    webHostname: async () => HOSTNAME,
  });
  relay = startAppRelay({
    store,
    egress: endpoints.egress,
    onHoldCall: holdHandler,
  });
  registerHeldAppCallHandlers({
    relay: () => relay,
  });

  const pinned = await relay.pinApp(connected.app.id);
  const byName = new Map(pinned.tools.map((t) => [t.name, t.definitionHash]));
  await store.applyToolLabels(connected.app.id, [
    ...(byName.has('prepare_checkout')
      ? [
          {
            name: 'prepare_checkout',
            definitionHash: byName.get('prepare_checkout')!,
            label: 'just_do' as const,
            source: 'sorter' as const,
            reason: 'Prepares preview only',
          },
        ]
      : []),
    ...(byName.has('confirm_checkout')
      ? [
          {
            name: 'confirm_checkout',
            definitionHash: byName.get('confirm_checkout')!,
            label: 'ask_first' as const,
            source: 'floor' as const,
            reason: 'Places order',
          },
        ]
      : []),
  ]);

  return { app: connected.app, fake };
}

async function respondToCard(approvalId: string, value: 'approve' | 'reject', reason?: string): Promise<void> {
  await handleApprovalsResponse({
    questionId: approvalId,
    value,
    userId: PRINCIPAL_USER,
    channelType: 'gchat',
    platformId: 'gchat:spaces/morgan',
    threadId: null,
    ...(reason === undefined ? {} : { reason }),
  });
}

beforeEach(async () => {
  endpoints.reset();
  directory = await mkdtemp(path.join(os.tmpdir(), 'connections-held-calls-'));
  ({ store } = testConnectionsStore(path.join(directory, 'connections')));
  deliveredCards = [];
  editedCards = [];
  nextMsgId = 1;
  await runMigrations(await initTestDb());
  await seedMain('America/Los_Angeles');
  mainSession = await getMainSession();

  setDeliveryAdapter({
    deliver: async (_channel, _platformId, _threadId, kind, content) => {
      if (kind === 'chat-sdk') {
        const parsed = JSON.parse(content) as DeliveredCard & { operation?: string; messageId?: string; text?: string };
        if (parsed.operation === 'edit') {
          editedCards.push({ messageId: parsed.messageId ?? '', text: parsed.text ?? '' });
        } else {
          deliveredCards.push(parsed);
        }
      }
      return `msg-${nextMsgId++}`;
    },
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await stopAppRelay();
  relay = undefined;
  await closeDb();
  await rm(directory, { recursive: true, force: true });
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe('held ask-first calls', () => {
  it('holds an ask-first call with one card showing app, tool, args, expiry, earlier app words and assistant summary, then runs once on approve', async () => {
    const { app, fake } = await setupFoodApp();

    const prepared = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'prepare_checkout',
      args: { item: 'Grain Bowl' },
      session: mainSession,
      requestId: 'req-prep-1',
    });
    expect(prepared.status).toBe('completed');
    expect(deliveredCards).toHaveLength(0);

    const held = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_order_7788' },
      summary: 'Place Grain Bowl order for $18.50',
      session: mainSession,
      requestId: 'req-confirm-1',
    });
    expect(held.status).toBe('held');
    if (held.status !== 'held') throw new Error('Expected held');
    expect(held.text).toBe(HELD_CALL_ANSWER);
    expect(fake.toolCalls.map((c) => c.name)).toEqual(['prepare_checkout']);

    expect(deliveredCards).toHaveLength(1);
    const card = deliveredCards[0]!;
    expect(card.title).toContain('Bistro');
    expect(card.title).toContain('confirm_checkout');
    expect(card.question).toContain('chk_order_7788');
    expect(card.question).toContain(
      'Prepared checkout chk_order_7788: 1x Grain Bowl from Corner Kitchen, total $18.50.',
    );
    expect(card.question).toContain("Assistant's description:");
    expect(card.question).toContain('Place Grain Bowl order for $18.50');
    expect(card.question).toContain('Expires:');

    await respondToCard(card.questionId, 'approve');

    expect(fake.toolCalls).toHaveLength(2);
    expect(fake.toolCalls[1]).toMatchObject({
      name: 'confirm_checkout',
      arguments: { checkout_id: 'chk_order_7788' },
      bearer: 'food-secret-token',
    });

    const notes = readMainMessages().filter((m) => m.id.startsWith('app-call-outcome:'));
    expect(notes).toHaveLength(1);
    const noteText = String(notes[0]!.content.text);
    expect(noteText).toContain('Order confirmed for chk_order_7788');
    expect(noteText).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT');
    expect(notes[0]!.trigger).toBe(1);
  });

  it('dedupes replay of the same request, creates separate cards for separate identical calls, and allows retry after decline', async () => {
    const { app } = await setupFoodApp();

    const first = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_1' },
      session: mainSession,
      requestId: 'req-same',
    });
    const replay = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_1' },
      session: mainSession,
      requestId: 'req-same',
    });
    expect(first.status).toBe('held');
    expect(replay.status).toBe('held');
    expect(deliveredCards).toHaveLength(1);
    expect(deliveredCards[0]!.question).toContain('no summary given');

    const second = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_1' },
      session: mainSession,
      requestId: 'req-second',
    });
    expect(second.status).toBe('held');
    expect(deliveredCards).toHaveLength(2);

    await respondToCard(deliveredCards[0]!.questionId, 'reject', 'Too expensive');
    const rejectNote = readMainMessages().find((m) => m.id.startsWith('appr-reject-'));
    expect(String(rejectNote?.content.text)).toContain('declined');
    expect(String(rejectNote?.content.text)).toContain('Too expensive');

    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_1' },
      session: mainSession,
      requestId: 'req-after-decline',
    });
    expect(deliveredCards).toHaveLength(3);
  });

  it('delivers approved outcome to main shared session even when the originating task session was deleted', async () => {
    const { app, fake } = await setupFoodApp();
    const taskSession: Session = {
      id: 'sess-task-ephemeral',
      agent_group_id: MAIN,
      messaging_group_id: null,
      thread_id: 'system:tasks:t1',
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: '2026-11-23T12:00:00.000Z',
    };
    await createSession(taskSession);

    const held = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_task_1' },
      summary: 'Confirm scheduled order',
      session: taskSession,
      requestId: 'req-task-1',
    });
    expect(held.status).toBe('held');
    expect(deliveredCards).toHaveLength(1);

    await deleteSession(taskSession.id);

    await respondToCard(deliveredCards[0]!.questionId, 'approve');
    expect(fake.toolCalls.map((c) => c.name)).toEqual(['confirm_checkout']);
    const notes = readMainMessages().filter((m) => m.id.startsWith('app-call-outcome:'));
    expect(notes).toHaveLength(1);
    expect(String(notes[0]!.content.text)).toContain('Order confirmed for chk_task_1');
  });

  it('writes a quiet note on 24h expiry, refuses on definition change or reconnect, and withdraws on remove', async () => {
    const { app, fake } = await setupFoodApp();

    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_exp' },
      session: mainSession,
      requestId: 'req-exp',
    });
    const expId = deliveredCards[0]!.questionId;
    const future = new Date(Date.now() + 25 * 60 * 60_000).toISOString();
    expect(await expireApproval(expId, future)).toBe(true);
    const expiredNote = readMainMessages().find((m) => m.id === `app-call-expired:${expId}`);
    expect(expiredNote).toBeDefined();
    expect(expiredNote!.trigger).toBe(0);
    expect(String(expiredNote!.content.text)).toContain('expired');

    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_changed' },
      session: mainSession,
      requestId: 'req-changed',
    });
    const changedId = deliveredCards[1]!.questionId;
    fake.tools = [
      PREPARE_TOOL,
      {
        ...CONFIRM_TOOL,
        description: 'Confirm and ALSO subscribe to annual plan.',
      },
    ];
    await respondToCard(changedId, 'approve');
    expect(fake.toolCalls).toHaveLength(0);
    const changedNote = readMainMessages().find((m) => m.id === `app-call-outcome:${changedId}`);
    expect(String(changedNote?.content.text)).toContain('nothing was sent');

    const repinned = await relay!.pinApp(app.id);
    await store.applyToolLabels(app.id, [
      {
        name: 'confirm_checkout',
        definitionHash: repinned.tools.find((t) => t.name === 'confirm_checkout')!.definitionHash,
        label: 'ask_first',
        source: 'floor',
        reason: 'Places order',
      },
    ]);

    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_reconn' },
      session: mainSession,
      requestId: 'req-reconn',
    });
    const reconnId = deliveredCards[2]!.questionId;
    const beforeReconn = await store.get(app.id);
    await store.connect(beforeReconn.id, beforeReconn.version, { kind: 'token', token: 'food-secret-token' });
    await respondToCard(reconnId, 'approve');
    expect(fake.toolCalls).toHaveLength(0);
    const reconnNote = readMainMessages().find((m) => m.id === `app-call-outcome:${reconnId}`);
    expect(String(reconnNote?.content.text)).toContain('disconnected or reconnected');
    expect(String(reconnNote?.content.text)).toContain('nothing was sent');

    // Reconnect cleared the old pin and labels; pin and label again before opening the withdrawal test card.
    const postReconnPin = await relay!.pinApp(app.id);
    await store.applyToolLabels(app.id, [
      {
        name: 'confirm_checkout',
        definitionHash: postReconnPin.tools.find((t) => t.name === 'confirm_checkout')!.definitionHash,
        label: 'ask_first',
        source: 'floor',
        reason: 'Places order',
      },
    ]);

    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_withdraw' },
      session: mainSession,
      requestId: 'req-withdraw',
    });
    const withdrawId = deliveredCards[3]!.questionId;
    expect((await getPendingApprovalsByAction(HELD_APP_CALL_ACTION)).map((r) => r.approval_id)).toContain(withdrawId);

    const retiredIds: string[] = [];
    const ops = new ConnectionOperations({
      store,
      webHostname: HOSTNAME,
      clientDocumentsServed: () => true,
      applyMain: async () => false,
      gateway: {
        listForHost: async () => [
          { id: 'gw-app-1', name: 'gws-ea-app-old' },
          { id: 'gw-other', name: 'operator-cred' },
        ],
        removeById: async (ids) => {
          retiredIds.push(...ids);
          return ids.map((id) => ({ id, outcome: 'removed' as const }));
        },
      },
    });
    const editsBeforeRemove = editedCards.length;
    const latest = await store.get(app.id);
    await ops.remove(latest.id, latest.version);

    expect(retiredIds).toEqual(['gw-app-1']);
    expect(await getPendingApprovalsByAction(HELD_APP_CALL_ACTION)).toEqual([]);
    expect(editedCards.length).toBeGreaterThan(editsBeforeRemove);
  });

  it('produces an outcome-unknown note on host restart after executing was claimed without calling upstream again', async () => {
    const { app, fake } = await setupFoodApp();

    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_crash' },
      session: mainSession,
      requestId: 'req-crash',
    });
    const approvalId = deliveredCards[0]!.questionId;
    const pending: PendingApproval = (await getPendingApprovalsByAction(HELD_APP_CALL_ACTION))[0]!;
    const tool = (await store.getTool(app.id, 'confirm_checkout'))!;

    await transitionPendingApprovalStatus(approvalId, 'pending', 'approved');
    await store.claimApprovedCall({
      approvalId,
      appId: app.id,
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: tool.definitionHash,
      argsHash: 'hash',
    });

    await resumeApprovedApprovals();

    expect(fake.toolCalls).toHaveLength(0);
    const note = readMainMessages().find((m) => m.id === `app-call-outcome:${pending.approval_id}`);
    expect(String(note?.content.text)).toContain('outcome is unknown');
    expect(String(note?.content.text)).toContain('Do not retry automatically');
  });

  it('links to the held-call view when arguments exceed the 2,000-character card limit and flags invisible characters', async () => {
    const { app } = await setupFoodApp();

    const longNotes = 'delivery instructions '.repeat(120);
    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_long', delivery_notes: longNotes },
      summary: 'Confirm big catering order',
      session: mainSession,
      requestId: 'req-long',
    });
    const longCard = deliveredCards[0]!;
    expect(longCard.title.length + longCard.question.length).toBeLessThanOrEqual(MAX_CARD_QUESTION_LENGTH);
    const linkMatch = new RegExp(
      `https://${HOSTNAME.replace(/\./g, '\\.')}/connections/held/(held-[A-Za-z0-9-]+)`,
    ).exec(longCard.question);
    expect(linkMatch).not.toBeNull();
    const resolvedHeld = await getPendingHeldCallApproval(linkMatch![1]!);
    expect(resolvedHeld?.approval.approval_id).toBe(longCard.questionId);
    expect(longCard.question).toContain('chk_long');
    expect(longCard.question).toContain('too long');

    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_\u200Bhidden\u202E123' },
      summary: 'Confirm order',
      session: mainSession,
      requestId: 'req-invis',
    });
    const invisCard = deliveredCards[1]!;
    expect(invisCard.question).toContain('[U+200B]');
    expect(invisCard.question).toContain('[U+202E]');
    expect(invisCard.question.toLowerCase()).toContain('invisible');
  });

  it('escapes invisible characters in appContext and summary, keeps worst-case cards under 2000 chars, rejects former principals, and supports lazy async relay startup', async () => {
    const { app, fake } = await setupFoodApp();

    // Seed a direct result containing bidi override characters that will be matched into appContext.
    fake.onToolCall = (call) => {
      if (call.name === 'prepare_checkout') {
        return {
          content: [{ type: 'text', text: 'Prepared chk_spoof \u202E001$ total\u200B' }],
        };
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    };
    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'prepare_checkout',
      args: { items: ['soup'] },
      session: mainSession,
      requestId: 'req-prep-spoof',
    });

    // Trigger held call with invisible characters in summary + matched appContext + long values.
    await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_spoof', huge: 'x'.repeat(2500) },
      summary: 'Approve \u200Border '.repeat(30),
      session: mainSession,
      requestId: 'req-spoof-card',
    });
    const spoofCard = deliveredCards[0]!;
    expect(spoofCard.title.length + spoofCard.question.length).toBeLessThanOrEqual(MAX_CARD_QUESTION_LENGTH);
    expect(spoofCard.question).toContain('[U+200B]');
    expect(spoofCard.question).toContain('[U+202E]');
    expect(spoofCard.question).not.toContain('\u202E');
    expect(spoofCard.question.toLowerCase()).toContain('invisible');

    // Former principal cannot execute a held call after the assistant's principal changes.
    await getDb().run('DELETE FROM gws_ea_principal_users');
    await upsertUser({
      id: 'gchat:users/new-principal',
      kind: 'gchat',
      display_name: 'New Principal',
      created_at: '2026-11-23T12:05:00.000Z',
    });
    await createMessagingGroup({
      id: 'mg-dm-new',
      channel_type: 'gchat',
      platform_id: 'gchat:spaces/new-principal',
      name: 'New Principal',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: '2026-11-23T12:05:00.000Z',
    });
    await upsertUserDm({
      user_id: 'gchat:users/new-principal',
      channel_type: 'gchat',
      messaging_group_id: 'mg-dm-new',
      resolved_at: '2026-11-23T12:05:00.000Z',
    });
    await bindVerifiedPrincipalUser('gchat:users/new-principal', '2026-11-23T12:05:00.000Z');
    await respondToCard(spoofCard.questionId, 'approve');
    expect(fake.toolCalls.filter((c) => c.name === 'confirm_checkout')).toHaveLength(0);
    const principalChangedNote = readMainMessages().find((m) => m.id === `app-call-outcome:${spoofCard.questionId}`);
    expect(String(principalChangedNote?.content.text)).toContain('principal changed');

    // Restore principal and verify an async lazy relay resolver (startup replay path) executes cleanly.
    await getDb().run('DELETE FROM gws_ea_principal_users');
    await bindVerifiedPrincipalUser(PRINCIPAL_USER, '2026-11-23T12:06:00.000Z');
    const capturedRelay = relay!;
    let lazyCalls = 0;
    registerHeldAppCallHandlers({
      relay: async () => {
        lazyCalls += 1;
        return capturedRelay;
      },
    });
    await capturedRelay.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_lazy' },
      summary: 'Confirm lazy order',
      session: mainSession,
      requestId: 'req-lazy',
    });
    await respondToCard(deliveredCards[1]!.questionId, 'approve');
    expect(lazyCalls).toBe(1);
    expect(fake.toolCalls.filter((c) => c.name === 'confirm_checkout')).toHaveLength(1);
  });

  it('preserves argument boundaries in compact rendering and withholds truncated cards when web hostname is unavailable', async () => {
    const injected = renderCompactArgs({ note: 'Leave at reception\nquantity: 50' });
    const separate = renderCompactArgs({ note: 'Leave at reception', quantity: 50 });
    expect(injected.text).not.toBe(separate.text);
    expect(injected.text).toContain('note: "Leave at reception\\nquantity: 50"');
    expect(separate.text).toContain('note: "Leave at reception"\nquantity: 50');

    const { app } = await setupFoodApp();
    await stopAppRelay();
    const noWebHold = createHoldCallHandler({
      store,
      webHostname: async () => undefined,
    });
    relay = startAppRelay({
      store,
      egress: endpoints.egress,
      onHoldCall: noWebHold,
    });

    const outcome = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_noweb', delivery_notes: 'very long notes '.repeat(160) },
      summary: 'Confirm big order without web page',
      session: mainSession,
      requestId: 'req-noweb-long',
    });
    expect(outcome).toMatchObject({ status: 'unsent', reason: 'details_unavailable' });
    expect(deliveredCards).toHaveLength(0);
  });

  it('deduplicates concurrent holds for the same invocationId and caps over-long tool names within card limits', async () => {
    const longToolName = `confirm_${'very_long_segment_'.repeat(160)}`;
    const confirmTool: FakeToolDefinition = {
      name: 'confirm_checkout',
      description: 'Place the food order.',
      inputSchema: { type: 'object', properties: { checkout_id: { type: 'string' } }, required: ['checkout_id'] },
    };
    const longTool: FakeToolDefinition = {
      name: longToolName,
      description: 'Place an order with a huge tool name',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    };
    const fake = new FakeMcpApp({
      appUrl: FOOD_URL,
      issuer: 'https://mcp.bistro.example.test/',
      allowUnauthenticated: true,
      tools: [confirmTool, longTool],
    });
    endpoints.use(fake.handle);
    const created = await store.create({ name: 'Bistro', url: FOOD_URL, auth: 'none' });
    await store.connect(created.id, created.version, { kind: 'none' });
    const pinned = await store.pinTools(created.id, {
      instructions: null,
      tools: [confirmTool, longTool],
    });
    await store.applyToolLabels(
      created.id,
      pinned.tools.map((tool) => ({
        name: tool.name,
        definitionHash: tool.definitionHash,
        label: 'ask_first',
        source: 'floor',
        reason: 'Places order',
      })),
    );
    const app = await store.get(created.id);
    relay = startAppRelay({
      store,
      egress: endpoints.egress,
      onHoldCall: createHoldCallHandler({ store, webHostname: async () => HOSTNAME }),
    });

    // 1) Two concurrent calls with the same invocationId produce a single pending approval and return the same ID.
    const [first, second] = await Promise.all([
      relay!.callTool({
        serverKey: app.serverKey,
        toolName: 'confirm_checkout',
        args: { checkout_id: 'chk_concurrent' },
        summary: 'Place concurrent order',
        session: mainSession,
        requestId: 'req-concurrent-same',
      }),
      relay!.callTool({
        serverKey: app.serverKey,
        toolName: 'confirm_checkout',
        args: { checkout_id: 'chk_concurrent' },
        summary: 'Place concurrent order',
        session: mainSession,
        requestId: 'req-concurrent-same',
      }),
    ]);
    expect(first.status).toBe('held');
    expect(second.status).toBe('held');
    expect(deliveredCards).toHaveLength(1);
    const deliveredId = deliveredCards[0]!.questionId;
    expect(deliveredId).toBeTruthy();
    expect(first.status === 'held' ? first.approvalId : undefined).toBe(deliveredId);
    expect(second.status === 'held' ? second.approvalId : undefined).toBe(deliveredId);

    // 2) An over-long tool name is capped on the card so title + question never exceed MAX_CARD_QUESTION_LENGTH.
    const longOutcome = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: longToolName,
      args: { id: 'o-long-tool', extra: 'x'.repeat(2500) },
      summary: 'Run long-named tool',
      session: mainSession,
      requestId: 'req-overlong-tool',
    });
    expect(longOutcome.status).toBe('held');
    expect(deliveredCards).toHaveLength(2);
    const longCard = deliveredCards[1]!;
    expect(longCard.title.length + longCard.question.length).toBeLessThanOrEqual(MAX_CARD_QUESTION_LENGTH);

    // 3) Truncated tool name with short arguments still forces a details link (and withholds when hostname is absent).
    const shortArgsLongName = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: longToolName,
      args: { id: 'tiny' },
      summary: 'Run long tool with short args',
      session: mainSession,
      requestId: 'req-long-tool-short-args',
    });
    expect(shortArgsLongName.status).toBe('held');
    expect(deliveredCards).toHaveLength(3);
    expect(deliveredCards[2]!.question).toContain(`https://${HOSTNAME}/connections/held/`);

    const noWebRelay = startAppRelay({
      store,
      egress: endpoints.egress,
      onHoldCall: createHoldCallHandler({ store, webHostname: async () => undefined }),
    });
    try {
      const withheld = await noWebRelay.callTool({
        serverKey: app.serverKey,
        toolName: longToolName,
        args: { id: 'tiny' },
        summary: 'No details page available',
        session: mainSession,
        requestId: 'req-long-tool-no-web',
      });
      expect(withheld).toMatchObject({ status: 'unsent', reason: 'details_unavailable' });
      expect(deliveredCards).toHaveLength(3);
    } finally {
      await noWebRelay.closeAll();
    }

    // 4) Emoji-heavy arguments respect the UTF-16 budget without exceeding MAX_CARD_QUESTION_LENGTH or splitting surrogates.
    relay = startAppRelay({
      store,
      egress: endpoints.egress,
      onHoldCall: createHoldCallHandler({ store, webHostname: async () => HOSTNAME }),
    });
    const emojiOutcome = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { note: '😀'.repeat(1800) },
      summary: 'Emoji order',
      session: mainSession,
      requestId: 'req-emoji-budget',
    });
    expect(emojiOutcome.status).toBe('held');
    const emojiCard = deliveredCards.at(-1)!;
    expect(emojiCard.title.length + emojiCard.question.length).toBeLessThanOrEqual(MAX_CARD_QUESTION_LENGTH);
    // Ensure no unpaired surrogate code unit was created by truncation.
    const hasLoneSurrogate = (text: string): boolean => {
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
          if (next < 0xdc00 || next > 0xdfff) return true;
          i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return true;
        }
      }
      return false;
    };
    expect(hasLoneSurrogate(emojiCard.title)).toBe(false);
    expect(hasLoneSurrogate(emojiCard.question)).toBe(false);
  });

  it('never posts a second approval card or re-dispatches when retrying a held invocation after leaving pending', async () => {
    const { fake, app } = await setupFoodApp();

    // 1) After approval completes (and pending_approvals row is deleted), retry returns the settled outcome without posting a new card or dispatching again.
    const heldApprove = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_once' },
      summary: 'Approve once',
      session: mainSession,
      requestId: 'req-retry-after-approve',
    });
    expect(heldApprove.status).toBe('held');
    const approveCardId = deliveredCards.at(-1)!.questionId;
    await handleApprovalsResponse({
      questionId: approveCardId,
      value: 'approve',
      userId: PRINCIPAL_USER,
      channelType: 'gchat',
      platformId: 'spaces/principal-dm',
      threadId: null,
    });
    expect(fake.toolCalls).toHaveLength(1);
    const cardsAfterApprove = deliveredCards.length;
    const retryAfterApprove = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_once' },
      summary: 'Approve once',
      session: mainSession,
      requestId: 'req-retry-after-approve',
    });
    expect(retryAfterApprove.status).toBe('completed');
    expect(deliveredCards).toHaveLength(cardsAfterApprove);
    expect(fake.toolCalls).toHaveLength(1);

    // 2) While awaiting_reason, retry returns unsent/rejected without posting a second card.
    const heldAwait = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_await' },
      summary: 'Await reason',
      session: mainSession,
      requestId: 'req-retry-awaiting-reason',
    });
    expect(heldAwait.status).toBe('held');
    const awaitCardId = deliveredCards.at(-1)!.questionId;
    expect(await markApprovalAwaitingReason(awaitCardId, '2099-01-01T00:00:00.000Z')).toBe(true);
    const cardsAfterAwait = deliveredCards.length;
    expect(
      await relay!.callTool({
        serverKey: app.serverKey,
        toolName: 'confirm_checkout',
        args: { checkout_id: 'chk_await' },
        summary: 'Await reason',
        session: mainSession,
        requestId: 'req-retry-awaiting-reason',
      }),
    ).toMatchObject({ status: 'unsent', reason: 'rejected' });
    expect(deliveredCards).toHaveLength(cardsAfterAwait);

    // 3) After rejection completes (and row is deleted), retry returns unsent/rejected without posting a second card.
    const heldReject = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_rej' },
      summary: 'Reject once',
      session: mainSession,
      requestId: 'req-retry-after-reject',
    });
    expect(heldReject.status).toBe('held');
    const rejectCardId = deliveredCards.at(-1)!.questionId;
    await handleApprovalsResponse({
      questionId: rejectCardId,
      value: 'reject',
      userId: PRINCIPAL_USER,
      channelType: 'gchat',
      platformId: 'spaces/principal-dm',
      threadId: null,
    });
    const cardsAfterReject = deliveredCards.length;
    expect(
      await relay!.callTool({
        serverKey: app.serverKey,
        toolName: 'confirm_checkout',
        args: { checkout_id: 'chk_rej' },
        summary: 'Reject once',
        session: mainSession,
        requestId: 'req-retry-after-reject',
      }),
    ).toMatchObject({ status: 'unsent', reason: 'rejected' });
    expect(deliveredCards).toHaveLength(cardsAfterReject);

    // 4) After expiry (and row deletion), retry returns unsent/expired without posting a second card.
    const heldExpire = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_exp' },
      summary: 'Expire once',
      session: mainSession,
      requestId: 'req-retry-after-expire',
    });
    expect(heldExpire.status).toBe('held');
    const expireCardId = deliveredCards.at(-1)!.questionId;
    expect(await expireApproval(expireCardId, '2099-01-01T00:00:00.000Z')).toBe(true);
    const cardsAfterExpire = deliveredCards.length;
    expect(
      await relay!.callTool({
        serverKey: app.serverKey,
        toolName: 'confirm_checkout',
        args: { checkout_id: 'chk_exp' },
        summary: 'Expire once',
        session: mainSession,
        requestId: 'req-retry-after-expire',
      }),
    ).toMatchObject({ status: 'unsent', reason: 'expired' });
    expect(deliveredCards).toHaveLength(cardsAfterExpire);

    // 5) After withdrawal (and row deletion), retry returns unsent/withdrawn without posting a second card.
    const heldWithdraw = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_wd' },
      summary: 'Withdraw once',
      session: mainSession,
      requestId: 'req-retry-after-withdraw',
    });
    expect(heldWithdraw.status).toBe('held');
    expect(await withdrawHeldAppCalls(app.id)).toBe(1);
    const cardsAfterWithdraw = deliveredCards.length;
    expect(
      await relay!.callTool({
        serverKey: app.serverKey,
        toolName: 'confirm_checkout',
        args: { checkout_id: 'chk_wd' },
        summary: 'Withdraw once',
        session: mainSession,
        requestId: 'req-retry-after-withdraw',
      }),
    ).toMatchObject({ status: 'unsent', reason: 'withdrawn' });
    expect(deliveredCards).toHaveLength(cardsAfterWithdraw);
    expect(fake.toolCalls).toHaveLength(1);
  });

  it('checks web publication readiness for oversized details links, reconciles orphaned bound invocations, and withdraws tool-ask cards even when closeApp throws', async () => {
    const enabledPolicy = async () => ({
      status: 'enabled' as const,
      enabled: true as const,
      config: {
        schemaVersion: 1 as const,
        enabled: true,
        hostname: HOSTNAME,
        listenPort: 4100,
        accessIssuer: 'https://team.cloudflareaccess.com',
        accessAud: 'aud-test',
        cloudflare: {
          accountId: 'acct-1',
          applicationId: 'app-1',
          operatorConfigFile: '/tmp/web-operator.json',
        },
      },
    });
    expect(await resolveDetailsHostname(enabledPolicy, { publicationReady: async () => false })).toBeUndefined();
    expect(await resolveDetailsHostname(enabledPolicy, { publicationReady: async () => true })).toBe(HOSTNAME);

    const { app } = await setupFoodApp();
    await stopAppRelay();
    relay = startAppRelay({
      store,
      egress: endpoints.egress,
      onHoldCall: createHoldCallHandler({
        store,
        webHostname: () => resolveDetailsHostname(enabledPolicy, { publicationReady: async () => false }),
      }),
    });

    // 1) Oversized card is withheld when web policy is enabled but publication is not ready.
    const withheld = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_not_ready', note: 'long details '.repeat(200) },
      summary: 'Oversized call when web runtime is not serving',
      session: mainSession,
      requestId: 'req-web-not-ready',
    });
    expect(withheld).toMatchObject({ status: 'unsent', reason: 'details_unavailable' });
    expect(deliveredCards).toHaveLength(0);

    // 2) Orphaned bound active invocation (pending_approvals row gone without markHeldInvocationResolved)
    //    reconciles to withdrawn on retry instead of returning held forever.
    const held = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_orphan' },
      summary: 'Will become orphaned',
      session: mainSession,
      requestId: 'req-orphaned-bound',
    });
    expect(held.status).toBe('held');
    const orphanCardId = deliveredCards.at(-1)!.questionId;
    await getDb().run('DELETE FROM pending_approvals WHERE approval_id = ?', orphanCardId);
    const cardsBeforeOrphanRetry = deliveredCards.length;
    const orphanRetry = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_orphan' },
      summary: 'Will become orphaned',
      session: mainSession,
      requestId: 'req-orphaned-bound',
    });
    expect(orphanRetry).toMatchObject({ status: 'unsent', reason: 'withdrawn' });
    expect(deliveredCards).toHaveLength(cardsBeforeOrphanRetry);
    expect((await store.getRelayInvocation(`${mainSession.id}:req-orphaned-bound`))?.state).toBe('withdrawn');

    // 3) Even if relay.closeApp fails during disconnect, pending held-call AND app_tool_ask approvals are withdrawn.
    const heldBeforeDisc = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_disc_cleanup' },
      summary: 'Pending during failing closeApp',
      session: mainSession,
      requestId: 'req-disc-cleanup',
    });
    expect(heldBeforeDisc.status).toBe('held');
    const toolAskApprovalId = await requestApproval({
      session: mainSession,
      agentName: 'Assistant',
      action: APP_TOOL_ASK_ACTION,
      payload: { id: app.id, app: app.serverKey, tool: 'confirm_checkout', ask_first: false },
      title: 'Stop asking before Bistro runs confirm_checkout?',
      question: 'Allow confirm_checkout without asking?',
      details: { facts: { app: app.name, tool: 'confirm_checkout' } },
      approverUserId: PRINCIPAL_USER,
    });
    expect(toolAskApprovalId).toBeTruthy();
    const closeSpy = vi.spyOn(relay, 'closeApp').mockRejectedValueOnce(new Error('close failure'));
    const ops = new ConnectionOperations({
      store,
      webHostname: HOSTNAME,
      fetches: endpoints.fetches,
      clientDocumentsServed: () => true,
      applyMain: async () => true,
    });
    const current = await store.get(app.id);
    await ops.disconnect(current.id, current.version);
    expect(closeSpy).toHaveBeenCalledWith(app.id);
    expect(
      (await getPendingApprovalsByAction(HELD_APP_CALL_ACTION)).filter((r) => r.status === 'pending'),
    ).toHaveLength(0);
    expect((await getPendingApprovalsByAction(APP_TOOL_ASK_ACTION)).filter((r) => r.status === 'pending')).toHaveLength(
      0,
    );
  });

  it('lists pending held calls for the principal and resolves Approve and Decline directly from web', async () => {
    const { app, fake } = await setupFoodApp();

    const held1 = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_web_approve' },
      summary: 'Place dinner order',
      session: mainSession,
      requestId: 'req-web-approve',
    });
    const held2 = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_web_decline' },
      summary: 'Place duplicate order',
      session: mainSession,
      requestId: 'req-web-decline',
    });
    expect(held1.status).toBe('held');
    expect(held2.status).toBe('held');

    const listed = await listPendingHeldCallApprovals();
    expect(listed).toHaveLength(2);
    const approveItem = listed.find((item) => item.payload.summary === 'Place dinner order')!;
    const declineItem = listed.find((item) => item.payload.summary === 'Place duplicate order')!;
    expect(approveItem).toBeDefined();
    expect(declineItem).toBeDefined();

    // Approve directly from web: executes once, edits chat card in place, writes main note.
    const approved = await resolveHeldCallFromWeb(approveItem.viewId, 'approve');
    expect(approved.status).toBe('approved');
    expect(fake.toolCalls.filter((call) => call.name === 'confirm_checkout')).toHaveLength(1);
    expect(editedCards.some((card) => card.text.includes('Approved'))).toBe(true);
    expect(readMainMessages().some((msg) => JSON.stringify(msg.content).includes('chk_web_approve'))).toBe(true);
    expect((await listPendingHeldCallApprovals()).map((item) => item.viewId)).toEqual([declineItem.viewId]);

    // A second web click or late chat response cannot execute the call a second time.
    expect(await resolveHeldCallFromWeb(approveItem.viewId, 'approve')).toEqual({ status: 'not_found' });
    await handleApprovalsResponse({
      questionId: approveItem.approval.approval_id,
      value: 'approve',
      userId: PRINCIPAL_USER,
      channelType: 'gchat',
      platformId: 'spaces/dm-morgan',
      threadId: null,
    });
    expect(fake.toolCalls.filter((call) => call.name === 'confirm_checkout')).toHaveLength(1);

    // Decline directly from web: does not execute, edits chat card in place, writes decline note.
    const declined = await resolveHeldCallFromWeb(declineItem.viewId, 'reject');
    expect(declined.status).toBe('declined');
    expect(fake.toolCalls.filter((call) => call.name === 'confirm_checkout')).toHaveLength(1);
    expect(editedCards.some((card) => card.text.includes('Rejected'))).toBe(true);
    expect(readMainMessages().some((msg) => JSON.stringify(msg.content).includes('declined'))).toBe(true);
    expect(await listPendingHeldCallApprovals()).toHaveLength(0);
  });

  it('refuses expired and unauthorized web decisions without executing the held call', async () => {
    const { app, fake } = await setupFoodApp();

    const heldExpired = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_web_expired' },
      summary: 'Expired order',
      session: mainSession,
      requestId: 'req-web-expired',
    });
    expect(heldExpired.status).toBe('held');
    const [expiredItem] = await listPendingHeldCallApprovals();
    expect(expiredItem).toBeDefined();

    const afterExpiry = Date.now() + 25 * 60 * 60_000;
    registerHeldAppCallHandlers({ relay: () => relay, store: () => store, now: () => afterExpiry });
    expect(await listPendingHeldCallApprovals(() => afterExpiry)).toHaveLength(0);
    expect((await getPendingHeldCallApproval(expiredItem!.viewId, () => afterExpiry))?.expired).toBe(true);

    const expiredResult = await resolveHeldCallFromWeb(expiredItem!.viewId, 'approve');
    expect(expiredResult.status).toBe('expired');
    expect(fake.toolCalls).toHaveLength(0);

    // Restore normal clock, hold a new call, then rotate verified principal so old approval is unauthorized.
    registerHeldAppCallHandlers({ relay: () => relay, store: () => store });
    const heldAuth = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_web_unauth' },
      summary: 'Order before principal change',
      session: mainSession,
      requestId: 'req-web-unauth',
    });
    expect(heldAuth.status).toBe('held');
    const [authItem] = await listPendingHeldCallApprovals();
    expect(authItem).toBeDefined();

    await getDb().run('DELETE FROM gws_ea_principal_users WHERE user_id = ?', PRINCIPAL_USER);
    await upsertUser({
      id: 'gchat:users/other',
      kind: 'human',
      display_name: 'Other Principal',
      created_at: new Date().toISOString(),
    });
    await bindVerifiedPrincipalUser('gchat:users/other', new Date().toISOString());
    expect(await listPendingHeldCallApprovals()).toHaveLength(0);
    expect(await resolveHeldCallFromWeb(authItem!.viewId, 'approve')).toEqual({ status: 'unauthorized' });
    expect(fake.toolCalls).toHaveLength(0);
  });

  it('delivers and edits long held-call approval cards through the real gws-ea-artifacts:link-access outbound guard', async () => {
    if (!principalPages().some((page) => page.name === 'connections')) {
      registerWebMount(connectionsWebMount);
    }
    const policyFile = path.join(directory, 'web-policy.json');
    fs.writeFileSync(
      policyFile,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        hostname: HOSTNAME,
        listenPort: 9123,
        accessIssuer: 'https://team.cloudflareaccess.com',
        accessAud: 'aud',
        cloudflare: { accountId: 'a', applicationId: 'b', operatorConfigFile: '/private/tmp/cf.json' },
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('GWS_EA_WEB_POLICY_FILE', policyFile);
    await getDb().run(
      'INSERT OR IGNORE INTO gws_ea_principal_addresses(email, added_at) VALUES (?, ?)',
      'morgan@example.test',
      new Date().toISOString(),
    );

    const { app, fake } = await setupFoodApp();
    registerHeldAppCallHandlers({ relay: () => relay, store: () => store });
    const longNotes = 'delivery instructions '.repeat(120);

    // 1) Long held call delivers cleanly through gws-ea-artifacts:link-access and approves with card edit.
    const approveHold = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_guard_approve', delivery_notes: longNotes },
      summary: 'Confirm guarded checkout order',
      session: mainSession,
      requestId: 'req-guard-approve',
    });
    expect(approveHold.status).toBe('held');
    expect(deliveredCards).toHaveLength(1);
    expect(deliveredCards[0]!.question).toContain(`https://${HOSTNAME}/connections/held/`);

    const [approveItem] = await listPendingHeldCallApprovals();
    expect(approveItem).toBeDefined();
    const approved = await resolveHeldCallFromWeb(approveItem!.viewId, 'approve');
    expect(approved.status).toBe('approved');
    expect(fake.toolCalls.filter((call) => call.name === 'confirm_checkout')).toHaveLength(1);
    expect(editedCards.some((card) => card.text.includes('Approved'))).toBe(true);

    // 2) Second long held call declines from web and still edits the chat card cleanly after row deletion.
    const declineHold = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_guard_decline', delivery_notes: longNotes },
      summary: 'Confirm second guarded order',
      session: mainSession,
      requestId: 'req-guard-decline',
    });
    expect(declineHold.status).toBe('held');
    expect(deliveredCards).toHaveLength(2);
    const [declineItem] = await listPendingHeldCallApprovals();
    expect(declineItem).toBeDefined();
    const declined = await resolveHeldCallFromWeb(declineItem!.viewId, 'reject');
    expect(declined.status).toBe('declined');
    expect(editedCards.some((card) => card.text.includes('Rejected'))).toBe(true);

    // 3) Third long held call expires and edits the chat card cleanly through the guard.
    const expireHold = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_guard_expire', delivery_notes: longNotes },
      summary: 'Confirm expiring guarded order',
      session: mainSession,
      requestId: 'req-guard-expire',
    });
    expect(expireHold.status).toBe('held');
    const [expireItem] = await listPendingHeldCallApprovals();
    expect(expireItem).toBeDefined();
    expect(
      await expireApproval(expireItem!.approval.approval_id, new Date(Date.now() + 25 * 60 * 60_000).toISOString()),
    ).toBe(true);
    expect(editedCards.some((card) => card.text.includes('Timed out'))).toBe(true);
  });

  it('distills opaque tokens and verbose checkout JSON on the card while keeping full raw payload for web review and execution', async () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiJ1c2VyXzQ5MjEiLCJjYXJ0X2lkIjo5OTM4MiwidmVuZG9yX2lkIjoyMzc4NywiaWF0IjoxNzMyNDU5MjAwLCJleHAiOjE3MzI0NjI4MDB9.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const fingerprint = '58dc5a4fb1840d8c7b6a9123ef450987654321abcdef0123456789abcdef6275';
    const rawPreviewJson = JSON.stringify({
      ok: true,
      data: {
        checkout_id: jwt,
        fingerprint,
        vendor_id: 23787,
        vendor_name: 'Corner Kitchen',
        address_id: 2847953,
        destination: { address_id: 2847953, label: 'Office', address: '21 Park Ave, Midtown' },
        items: [
          {
            item_id: 412,
            pack_id: 9,
            menu_group_id: null,
            name: 'Grain Bowl',
            quantity: 1,
            unit_price: 1850,
            containers: '[]',
          },
        ],
        currency: 'USD',
        amounts: {
          items: 1850,
          delivery: 350,
          service: 120,
          small_order: 0,
          containers: 0,
          bags: 0,
          safety: 0,
          tip: 0,
          promo_discount: 0,
          voucher: 0,
          total: 2320,
        },
        payment: { method: 'wallet', label: 'Wallet balance' },
        summary: '1x Grain Bowl from Corner Kitchen to Office — $23.20 via Wallet',
        expires_at: '2026-11-24T12:30:00Z',
      },
    });

    const { app, fake } = await setupFoodApp();
    fake.onToolCall = (call) => {
      if (call.name === 'prepare_checkout') {
        return { content: [{ type: 'text', text: rawPreviewJson }] };
      }
      return { content: [{ type: 'text', text: 'Order confirmed: ORD-9910' }] };
    };

    const prep = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'prepare_checkout',
      args: { item: 'Grain Bowl' },
      session: mainSession,
      requestId: 'req-distill-prep',
    });
    expect(prep.status).toBe('completed');

    const held = await relay!.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: jwt, confirmed: true, fingerprint },
      summary: 'Place Grain Bowl lunch order from Corner Kitchen to Office',
      session: mainSession,
      requestId: 'req-distill-confirm',
    });
    expect(held.status).toBe('held');
    expect(deliveredCards).toHaveLength(1);
    const card = deliveredCards[0]!;
    expect(card.title.length + card.question.length).toBeLessThanOrEqual(MAX_CARD_QUESTION_LENGTH);

    // Chat card is compact, scannable, and links to full untruncated details on web.
    expect(card.question).toContain('checkout_id: "eyJhbG…sw5c"');
    expect(card.question).toContain('fingerprint: "58dc5a…6275"');
    expect(card.question).not.toContain(jwt);
    expect(card.question).not.toContain(fingerprint);
    expect(card.question).toContain('Summary: 1x Grain Bowl from Corner Kitchen to Office — $23.20 via Wallet');
    expect(card.question).toContain('Vendor name: Corner Kitchen');
    expect(card.question).toContain('Items: 1x Grain Bowl (unit price: 1850)');
    expect(card.question).toContain('Destination: address: 21 Park Ave, Midtown, label: Office');
    expect(card.question).toContain('Amounts: items: 1850, total: 2320, delivery: 350, service: 120');
    expect(card.question).toContain('Payment: method: wallet, label: Wallet balance');
    expect(card.question).not.toContain('small order');
    expect(card.question).not.toContain('voucher');
    expect(card.question).toContain(`Full details: https://${HOSTNAME}/connections/held/`);

    // Stored payload preserves the complete raw arguments and raw app context for web review and execution.
    const [pending] = await listPendingHeldCallApprovals();
    expect(pending?.payload.canonicalArgs).toContain(jwt);
    expect(pending?.payload.canonicalArgs).toContain(fingerprint);
    expect(pending?.payload.appContext?.text).toBe(rawPreviewJson);

    // Approving executes upstream with the complete unmodified arguments.
    await respondToCard(card.questionId, 'approve');
    const confirmCall = fake.toolCalls.find((call) => call.name === 'confirm_checkout');
    expect(confirmCall?.arguments).toEqual({ checkout_id: jwt, confirmed: true, fingerprint });

    // Without web hostname, a small JSON call falls back to raw verbatim text while an oversized one still withholds.
    await stopAppRelay();
    relay = startAppRelay({
      store,
      egress: endpoints.egress,
      onHoldCall: createHoldCallHandler({ store, webHostname: async () => undefined }),
    });
    const smallNoWeb = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: jwt, confirmed: true },
      summary: 'Small token call without web',
      session: mainSession,
      requestId: 'req-distill-noweb-small',
    });
    expect(smallNoWeb.status).toBe('held');
    expect(deliveredCards[1]!.question).toContain(jwt);
    expect(deliveredCards[1]!.question).not.toContain('/connections/held/');

    const oversizedRawJson = JSON.stringify({
      ok: true,
      data: { checkout_id: 'chk_big_noweb', summary: 'Order', padding: 'note '.repeat(400) },
    });
    fake.onToolCall = () => ({ content: [{ type: 'text', text: oversizedRawJson }] });
    await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'prepare_checkout',
      args: { item: 'Big order' },
      session: mainSession,
      requestId: 'req-distill-noweb-big-prep',
    });
    const bigNoWeb = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'confirm_checkout',
      args: { checkout_id: 'chk_big_noweb' },
      summary: 'Oversized JSON without web',
      session: mainSession,
      requestId: 'req-distill-noweb-big',
    });
    expect(bigNoWeb).toMatchObject({ status: 'unsent', reason: 'details_unavailable' });
  });
});
