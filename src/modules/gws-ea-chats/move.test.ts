import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/chat-move-u12-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
  GROUPS_DIR: `${ROOT}/groups`,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../env.js', async (original) => ({
  ...(await original<typeof import('../../env.js')>()),
  readEnvFile: () => ({}),
}));
const runtime = vi.hoisted(() => ({
  running: false,
  kill: vi.fn((_id: string, _why: string, exit?: () => void) => {
    runtime.running = false;
    exit?.();
  }),
}));
vi.mock('../../container-runner.js', async (original) => ({
  ...(await original<typeof import('../../container-runner.js')>()),
  isContainerRunning: () => runtime.running,
  killContainer: runtime.kill,
}));
import type { Session } from '../../types.js';
import type { ResponseFrame } from '../../cli/frame.js';
import type { ChannelAdapter } from '../../channels/adapter.js';
import type { MailboxSession } from '../../mailbox/types.js';
import { requestWake } from '../../request-wake.js';
import { pruneEchoBacklog } from '../cross-session-context/prune.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';

const deliveredU11 = vi.fn<ChannelAdapter['deliver']>(async () => undefined);
async function freshHost() {
  vi.resetModules();
  vi.doMock('../../container-runner.js', async (original) => ({
    ...(await original<typeof import('../../container-runner.js')>()),
    isContainerRunning: () => runtime.running,
    killContainer: runtime.kill,
  }));
  await import('../../mailbox/compose.js');
  await import('../permissions/index.js');
  await import('../gws-ea-profile/index.js');
  await import('../gws-ea-people/index.js');
  await import('../gws-ea-matters/index.js');
  await import('../gws-ea-chat-agents/index.js');
  await import('./index.js');
  const channels = await import('../../channels/channel-registry.js');
  channels.registerChannelAdapter('whatsapp', {
    factory: () => ({
      name: 'whatsapp',
      channelType: 'whatsapp',
      supportsThreads: false,
      setup: async () => {},
      teardown: async () => {},
      isConnected: () => true,
      deliver: deliveredU11,
      fetchGroupMembers: async (platformId: string) => ({
        platformId,
        name: 'Trip',
        members: [
          { key: 'whatsapp:11', name: 'Juno', isPrincipal: true },
          { key: 'whatsapp:22', name: 'Mira', isPrincipal: false },
        ],
      }),
    }),
  });
  const host = {
    channels,
    db: await import('../../db/connection.js'),
    migrations: await import('../../db/migrations/index.js'),
    groups: await import('../../db/agent-groups.js'),
    session: await import('../../session-manager.js'),
    chat: await import('./db.js'),
    join: await import('./join.js'),
    handoffs: await import('./handoffs.js'),
    messaging: await import('../../db/messaging-groups.js'),
    sessions: await import('../../db/sessions.js'),
    move: await import('./move.js'),
    jobs: await import('../gws-ea-chat-agents/jobs.js'),
    router: await import('../../router.js'),
    remind: await import('./remind.js'),
    reconcile: await import('../../reconcile-session.js'),
    delivery: await import('../../delivery.js'),
    container: await import('../../container-runner.js'),
    bridge: await import('./bridge.js'),
    lifecycle: await import('./lifecycle.js'),
    hostLifecycle: await import('../../host-lifecycle.js'),
    agents: await import('../gws-ea-chat-agents/index.js'),
    hold: await import('./hold.js'),
    matter: await import('../gws-ea-matters/db.js'),
    config: await import('../../db/container-configs.js'),
  };
  return host;
}
let host: Awaited<ReturnType<typeof freshHost>>;
let requestSequence = 0;
async function sendU11(
  session: Session,
  action: string,
  fields: Record<string, unknown>,
  id = `move-${++requestSequence}`,
): Promise<ResponseFrame> {
  const handler = host.delivery.getDeliveryAction(action);
  if (!handler) throw new Error(`No action ${action}`);
  await handler({ ...fields, action, requestId: id }, session);
  const answer = (await read(session)).find((row) => row.id === `action-resp-${id}`);
  if (!answer) throw new Error('No action response');
  return (JSON.parse(answer.content) as { frame: ResponseFrame }).frame;
}
function dataU11(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(frame.error.message);
  return frame.data as Record<string, unknown>;
}

const agents = new Map<
  string,
  { id: string; identifier: string; name: string; secretMode: string; secrets: string[] }
>();
let gatewayFails = false;
let retirementFails = false;

let main: Session;
let old: Session;
let chatId: string;
beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  host = await freshHost();
  gatewayFails = false;
  retirementFails = false;
  runtime.running = false;
  runtime.kill.mockClear();
  vi.mocked(requestWake).mockClear();
  agents.clear();
  vi.stubEnv('ONECLI_URL', 'http://gateway.test');
  vi.stubEnv('ONECLI_API_KEY', `oc_${'k'.repeat(32)}`);
  vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', `${ROOT}/browser/policy.json`);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname === '/v1/secrets')
        return Response.json([
          { id: 'model', hostPattern: 'api.anthropic.com' },
          { id: 'google', hostPattern: 'www.googleapis.com' },
        ]);
      if (url.pathname === '/v1/agents' && init?.method === 'POST') {
        if (gatewayFails) throw new Error('Gateway unavailable');
        const agent = body as { name: string; identifier: string };
        agents.set(agent.identifier, { ...agent, id: `oc-${agents.size + 1}`, secretMode: 'all', secrets: [] });
        return Response.json({}, { status: 201 });
      }
      if (url.pathname === '/v1/agents') {
        if (retirementFails) throw new Error('Retirement interrupted at the gateway');
        return Response.json([...agents.values()]);
      }
      const match = /^\/v1\/agents\/([^/]+)\/(secret-mode|secrets)$/u.exec(url.pathname);
      const agent = [...agents.values()].find((entry) => entry.id === match?.[1]);
      if (!agent) throw new Error(`Unexpected gateway request ${url.pathname}`);
      if (match?.[2] === 'secret-mode') agent.secretMode = (body as { mode: string }).mode;
      else if (init?.method === 'PUT') agent.secrets = (body as { secretIds: string[] }).secretIds;
      else return Response.json(agent.secrets);
      return Response.json({ success: true });
    }),
  );
  await host.migrations.runMigrations(await host.db.initDb(`${ROOT}/central.db`, { role: 'test' }));
  for (const id of ['main', 'external'])
    await host.groups.createAgentGroup({
      id,
      name: id,
      folder: id,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  await host.db
    .getDb()
    .run(
      "UPDATE gws_ea_profile SET main_agent_group_id='main',external_chat_agent_group_id='external',assistant_display_name='Robin' WHERE singleton=1",
    );
  await host.channels.initChannelAdapters(() => ({
    onInbound() {},
    onInboundEvent() {},
    onMetadata() {},
    onAction() {},
  }));
  host.delivery.setDeliveryAdapter(host.channels.createChannelDeliveryAdapter());
  deliveredU11.mockClear();
  await host.join.decideJoin({
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    name: 'Lake trip',
    isGroup: true,
    members: [
      { key: 'whatsapp:11', name: 'Juno', isPrincipal: true },
      { key: 'whatsapp:22', name: 'Mira', isPrincipal: false },
    ],
  });
  chatId = (await host.chat.listChats())[0].messaging_group_id;
  old = (await host.session.resolveSession('external', chatId, null, 'shared')).session;
  const at = new Date().toISOString();
  await host.db.getDb().run("UPDATE messaging_groups SET unknown_sender_policy='public' WHERE id=?", chatId);
  await host.db
    .getDb()
    .run("INSERT INTO users(id,kind,display_name,created_at) VALUES('gchat:juno','gchat','Juno',?)", at);
  await host.db.getDb().run("INSERT INTO gws_ea_principal_users(user_id,verified_at) VALUES('gchat:juno',?)", at);
  await host.messaging.createMessagingGroup({
    id: 'principal-dm',
    channel_type: 'gchat',
    platform_id: 'spaces/principal',
    name: 'Juno',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: at,
  });
  await host.db
    .getDb()
    .run(
      "INSERT INTO user_dms(user_id,channel_type,messaging_group_id,resolved_at) VALUES('gchat:juno','gchat','principal-dm',?)",
      at,
    );
  main = (await host.session.resolveSession('main', 'principal-dm', null, 'agent-shared')).session;
});
afterEach(async () => {
  await host.channels.teardownChannelAdapters();
  await host.db.closeDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function promote() {
  return dataU11(
    await sendU11(
      main,
      'chat_handoff',
      { chat: chatId, message: 'Plan the lake trip.', matter: 'nowhere', job: true },
      'promote',
    ),
  );
}
async function jobSession(): Promise<Session> {
  const job = await host.jobs.getJobAgentForChat(chatId);
  if (!job) throw new Error('No job agent');
  const session = await host.db
    .getDb()
    .get<Session>('SELECT * FROM sessions WHERE agent_group_id=? AND messaging_group_id=?', job.agent_group_id, chatId);
  if (!session) throw new Error('No job session');
  return session;
}
async function inbound(id: string, text: string) {
  await host.router.routeInbound({
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    threadId: null,
    message: {
      id,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text, sender: 'Mira' }),
      isMention: true,
      isGroup: true,
      deduplicate: true,
      authenticatedSender: { kind: 'human', userId: '22' },
    },
  });
}
async function read(session: Session) {
  return (
    (await host.session.withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.getInboundRecords(),
    )) ?? []
  );
}
async function restart() {
  await host.channels.teardownChannelAdapters();
  await host.db.closeDb();
  host = await freshHost();
  await host.channels.initChannelAdapters(() => ({
    onInbound() {},
    onInboundEvent() {},
    onMetadata() {},
    onAction() {},
  }));
  host.delivery.setDeliveryAdapter(host.channels.createChannelDeliveryAdapter());
  await host.db.initDb(`${ROOT}/central.db`, { role: 'test' });
}

it('moves the actual chat wiring, recent member and delivered assistant conversation, held inbound and main’s queued words exactly once', async () => {
  const now = Date.now();
  await host.db
    .getDb()
    .run(
      'UPDATE gws_ea_chats SET connected_at=? WHERE messaging_group_id=?',
      new Date(now - 20 * 86400_000).toISOString(),
      chatId,
    );
  for (const [id, days, text] of [
    ['ancient', 15, 'Too old'],
    ['recent', 13, 'The cabin is by the west shore.'],
  ] as const) {
    await host.session.writeSessionMessage(old.agent_group_id, old.id, {
      id,
      kind: 'chat',
      timestamp: new Date(now - days * 86400_000).toISOString(),
      channelType: 'whatsapp',
      platformId: 'trip@g.us',
      content: JSON.stringify({
        sender: 'Mira',
        text,
        ...(id === 'recent'
          ? { attachments: [{ name: 'cabin.txt', size: 12, data: Buffer.from('Cabin notes.').toString('base64') }] }
          : {}),
      }),
      trigger: false,
    });
    await host.session.withMailboxSession(old.agent_group_id, old.id, (mailbox) =>
      mailbox.applyProcessingAcks([
        {
          messageId: id,
          status: 'completed',
          statusChanged: new Date().toISOString() as import('../../mailbox/types.js').IsoTimestamp,
        },
      ]),
    );
  }
  await host.session.writeOutboundDirect(old.agent_group_id, old.id, {
    id: 'assistant-delivered',
    kind: 'chat',
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    threadId: null,
    content: '{"text":"I will check that shore."}',
  });
  await host.session.withMailboxSession(old.agent_group_id, old.id, (mailbox) =>
    mailbox.markDelivered('assistant-delivered', 'platform-own'),
  );
  await host.session.writeOutboundDirect(old.agent_group_id, old.id, {
    id: 'assistant-failed',
    kind: 'chat',
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    threadId: null,
    content: '{"text":"This was never sent."}',
  });
  await host.session.withMailboxSession(old.agent_group_id, old.id, (mailbox) =>
    mailbox.markDeliveryFailed('assistant-failed'),
  );
  await promote();
  await inbound('during', 'Robin, can we meet Friday?');
  dataU11(
    await sendU11(main, 'chat_handoff', { chat: chatId, message: 'The principal prefers Friday.' }, 'during-main'),
  );
  expect((await read(old)).find((row) => row.id === 'during:external')).toMatchObject({
    status: 'held',
    trigger: true,
  });
  runtime.running = true;
  await host.move.moveChat(chatId);
  const target = await jobSession();
  expect(await host.chat.getChat(chatId)).toMatchObject({
    state: 'job',
    serving_agent_group_id: target.agent_group_id,
  });
  expect(await host.sessions.getSession(old.id)).toMatchObject({ status: 'closed' });
  expect(runtime.kill).toHaveBeenCalledWith(old.id, 'chat-move', expect.any(Function));
  expect(
    await host.db.getDb().all('SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id=?', chatId),
  ).toEqual([{ agent_group_id: target.agent_group_id }]);
  const rows = await read(target);
  expect(rows.filter((row) => row.channelType === 'chat-seed')).toHaveLength(2);
  expect(rows.map((row) => row.content).join('\n')).toContain('The cabin is by the west shore.');
  const recent = JSON.parse(
    rows.find((row) => row.content.includes('The cabin is by the west shore.'))?.content ?? '{}',
  ) as { attachments: { localPath: string }[] };
  expect(
    fs.readFileSync(
      `${host.session.sessionDir(target.agent_group_id, target.id)}/${recent.attachments[0].localPath}`,
      'utf8',
    ),
  ).toBe('Cabin notes.');
  expect(rows.map((row) => row.content).join('\n')).toContain('I will check that shore.');
  expect(
    JSON.parse(rows.find((row) => row.content.includes('I will check that shore.'))?.content ?? '{}'),
  ).toMatchObject({ sender: 'Robin', self: true });
  expect(rows.map((row) => row.content).join('\n')).not.toMatch(/Too old|This was never sent/);
  expect(rows.filter((row) => row.id === `during:${target.agent_group_id}`)).toMatchObject([
    { status: 'pending', trigger: true },
  ]);
  expect((await read(old)).find((row) => row.id === 'during:external')?.status).toBe('completed');
  expect(rows.some((row) => row.content.includes('The principal prefers Friday.'))).toBe(true);
  await host.session.withMailboxSession(target.agent_group_id, target.id, (mailbox) => pruneEchoBacklog(mailbox));
  expect((await read(target)).filter((row) => row.channelType === 'chat-seed')).toHaveLength(2);
  await inbound('during', 'Robin, can we meet Friday?');
  await inbound('next', 'Robin, what about Saturday?');
  expect((await read(target)).filter((row) => row.id === `during:${target.agent_group_id}`)).toHaveLength(1);
  expect((await read(target)).filter((row) => row.id === `next:${target.agent_group_id}`)).toHaveLength(1);
  expect((await read(old)).some((row) => row.id === 'next:external')).toBe(false);
  dataU11(await sendU11(main, 'chat_handoff', { chat: chatId, message: 'Another job here.', job: true }, 'second-job'));
  await host.move.resumeChatMoves();
  expect(await host.jobs.listJobAgents()).toHaveLength(1);
  expect((await host.chat.getChat(chatId))?.serving_agent_group_id).toBe(target.agent_group_id);
});

it('pauses native reminders immediately, moves live task rows once and preserves an originally paused reminder', async () => {
  const pending = dataU11(
    await sendU11(
      old,
      'remind',
      { at: new Date(Date.now() + 3600_000).toISOString(), note: 'Choose the cabin.' },
      'cabin',
    ),
  );
  await host.session.withMailboxSession(old.agent_group_id, old.id, (mailbox) =>
    mailbox.insertTask({
      id: 'already-paused',
      seriesId: 'already-paused',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      content: '{"prompt":"Wait for approval","inConversation":true}',
      status: 'paused',
    }),
  );
  await promote();
  await host.session.withMailboxSession(old.agent_group_id, old.id, (mailbox) => {
    expect(mailbox.listLiveTasks()).toMatchObject([{ status: 'paused' }, { status: 'paused' }]);
    // Cross the actual SQLite clock while moving, after admission paused it.
    mailbox.updateTask(String(pending.reminder), { processAfter: '2020-01-01T00:00:00.000Z' });
  });
  vi.mocked(requestWake).mockClear();
  await host.reconcile.reconcileSession(old.id);
  expect(requestWake).not.toHaveBeenCalled();
  await restart();
  await host.move.moveChat(chatId);
  const target = await jobSession();
  const id = host.remind.movedReminderId(old.id, String(pending.reminder));
  expect((await read(old)).filter((row) => row.kind === 'task')).toMatchObject([
    { status: 'cancelled' },
    { status: 'cancelled' },
  ]);
  expect((await read(target)).filter((row) => row.kind === 'task')).toMatchObject([
    { id, status: 'pending', processAfter: '2020-01-01T00:00:00.000Z' },
    { id: host.remind.movedReminderId(old.id, 'already-paused'), status: 'paused' },
  ]);
  await host.move.resumeChatMoves();
  expect((await read(target)).filter((row) => row.kind === 'task')).toHaveLength(2);
  const out = new Database(outboundDbPath(target.agent_group_id, target.id));
  out
    .prepare('INSERT INTO processing_ack(message_id,status,status_changed) VALUES(?,?,?)')
    .run(id, 'completed', new Date().toISOString());
  out.close();
  await host.session.writeOutboundDirect(target.agent_group_id, target.id, {
    id: 'reminder-answer',
    kind: 'chat',
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    threadId: null,
    content: '{"text":"Choose the cabin today."}',
  });
  await host.delivery.deliverSessionMessages(target);
  await host.delivery.deliverSessionMessages(target);
  expect(deliveredU11.mock.calls.filter(([, , , messageId]) => messageId === 'reminder-answer')).toHaveLength(1);
});

it('waits for a claimed reminder and its actual outbound delivery before stopping the old container', async () => {
  await host.session.withMailboxSession(old.agent_group_id, old.id, (mailbox) =>
    mailbox.insertTask({
      id: 'claimed-reminder',
      seriesId: 'claimed-reminder',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      content: '{"prompt":"Already running","inConversation":true}',
    }),
  );
  const out = new Database(outboundDbPath(old.agent_group_id, old.id));
  out
    .prepare('INSERT INTO processing_ack(message_id,status,status_changed) VALUES(?,?,?)')
    .run('claimed-reminder', 'processing', new Date().toISOString());
  await promote();
  runtime.running = true;
  await host.move.moveChat(chatId);
  expect(runtime.kill).not.toHaveBeenCalled();
  expect((await host.chat.getChat(chatId))?.state).toBe('moving');
  out.prepare("UPDATE processing_ack SET status='completed' WHERE message_id='claimed-reminder'").run();
  out.close();
  await host.session.writeOutboundDirect(old.agent_group_id, old.id, {
    id: 'already-answering',
    kind: 'chat',
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    threadId: null,
    content: '{"text":"The reminder already in progress."}',
  });
  await host.move.moveChat(chatId);
  expect(runtime.kill).not.toHaveBeenCalled();
  await host.delivery.deliverSessionMessages(old);
  await host.move.moveChat(chatId);
  expect(runtime.kill).toHaveBeenCalledOnce();
  expect((await read(await jobSession())).filter((row) => row.kind === 'task')).toEqual([]);
  expect(deliveredU11).toHaveBeenCalledOnce();
});

it('carries an admitted move through on the running host without waiting for the sweep', async () => {
  const out = new Database(outboundDbPath(old.agent_group_id, old.id));
  out
    .prepare('INSERT INTO processing_ack(message_id,status,status_changed) VALUES(?,?,?)')
    .run('answering-now', 'processing', new Date().toISOString());
  const abort = new AbortController();
  await host.hostLifecycle.startHostModules({
    db: host.db.getDb(),
    deliveryAdapter: host.channels.createChannelDeliveryAdapter(),
    signal: abort.signal,
  });
  try {
    await promote();
    await vi.waitFor(() => expect(requestWake).toHaveBeenCalledWith(old, 'due-message'));
    expect((await host.chat.getChat(chatId))?.state).toBe('moving');
    out.prepare("UPDATE processing_ack SET status='completed' WHERE message_id='answering-now'").run();
    await vi.waitFor(async () => expect((await host.chat.getChat(chatId))?.state).toBe('job'), { timeout: 5_000 });
    expect(await host.handoffs.listChatHandoffs(chatId, true)).toEqual([]);
  } finally {
    out.close();
    abort.abort();
    await host.hostLifecycle.stopHostModules();
  }
});

it('undoes a gateway creation failure, releases the intact old session and names the chat to main', async () => {
  const pending = dataU11(
    await sendU11(
      old,
      'remind',
      { at: new Date(Date.now() + 3600_000).toISOString(), note: 'Keep this reminder.' },
      'rollback-reminder',
    ),
  );
  await host.session.withMailboxSession(old.agent_group_id, old.id, (mailbox) =>
    mailbox.insertTask({
      id: 'stay-paused',
      seriesId: 'stay-paused',
      processAfter: null,
      recurrence: null,
      content: '{"prompt":"Paused"}',
      status: 'paused',
    }),
  );
  await promote();
  await inbound('failure-held', 'Robin, keep helping us.');
  gatewayFails = true;
  await host.move.moveChat(chatId);
  expect(await host.chat.getChat(chatId)).toMatchObject({ state: 'connected', serving_agent_group_id: 'external' });
  expect(await host.sessions.getSession(old.id)).toMatchObject({ status: 'active' });
  expect((await host.jobs.listJobAgents()).map((row) => row.state)).toEqual(['retired']);
  expect((await read(old)).find((row) => row.id === 'failure-held:external')).toMatchObject({
    status: 'pending',
    trigger: true,
  });
  expect((await read(old)).find((row) => row.id === pending.reminder)?.status).toBe('pending');
  expect((await read(old)).find((row) => row.id === 'stay-paused')?.status).toBe('paused');
  const notes = (await read(main)).filter((row) => row.id.startsWith('chat-move-failed-'));
  expect(notes).toHaveLength(1);
  expect(notes[0].content).toContain('Lake trip');
  dataU11(
    await sendU11(main, 'chat_handoff', { chat: chatId, message: 'Try this separately.', job: true }, 'new-attempt'),
  );
  await host.move.moveChat(chatId);
  expect((await read(main)).filter((row) => row.id.startsWith('chat-move-failed-'))).toHaveLength(2);
});

it('records job admission and the checked handoff durably without doing the move in main’s delivery', async () => {
  const db = host.db.getDb();
  const transact = db.transaction.bind(db);
  let centralTransaction = false;
  vi.spyOn(db, 'transaction').mockImplementation(
    async <T>(work: () => Promise<T>): Promise<T> =>
      transact(async () => {
        centralTransaction = true;
        try {
          return await work();
        } finally {
          centralTransaction = false;
        }
      }),
  );
  const mailbox = host.session.withExistingMailboxSession;
  vi.spyOn(host.session, 'withExistingMailboxSession').mockImplementation(
    <T>(group: string, id: string, action: (mailbox: MailboxSession) => T | Promise<T>) => {
      expect(centralTransaction).toBe(false);
      return mailbox(group, id, action);
    },
  );
  const answer = dataU11(
    await sendU11(
      main,
      'chat_handoff',
      {
        chat: chatId,
        message: 'Plan the lake trip over the next weeks.',
        matter: 'nowhere',
        job: true,
      },
      'promote',
    ),
  );
  expect(answer).toEqual({ chat: chatId, message: 'Your words are kept for this chat.' });
  expect(await host.chat.getChat(chatId)).toMatchObject({
    state: 'moving',
    serving_agent_group_id: old.agent_group_id,
  });
  expect(await host.db.getDb().all('SELECT * FROM gws_ea_job_agents')).toEqual([]);
  expect(await host.handoffs.listChatHandoffs(chatId, true)).toHaveLength(1);
});

it('carries delayed owed input with its native deadline and engagement instead of silently turning it into seed context', async () => {
  await host.session.writeSessionMessage(old.agent_group_id, old.id, {
    id: 'delayed:external',
    kind: 'chat',
    timestamp: new Date().toISOString(),
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    content: '{"text":"Robin, reply after the backoff."}',
    trigger: true,
    processAfter: '2999-01-01T00:00:00.000Z',
  });
  await promote();
  await host.move.moveChat(chatId);
  const target = await jobSession();
  expect((await read(target)).find((row) => row.id === `delayed:${target.agent_group_id}`)).toMatchObject({
    channelType: 'whatsapp',
    trigger: true,
    processAfter: '2999-01-01T00:00:00.000Z',
    status: 'pending',
  });
  expect((await read(old)).find((row) => row.id === 'delayed:external')?.status).toBe('completed');
});

function barrier() {
  let hit!: () => void;
  const reached = new Promise<void>((resolve) => {
    hit = resolve;
  });
  return {
    reached,
    stop<T>(): Promise<T> {
      hit();
      return new Promise<T>(() => {});
    },
  };
}

it.each([
  'group-created',
  'source-stopped',
  'seed-partial',
  'reminders-copied',
  'swapped',
  'held-copied',
  'old-closed',
  'reminders-resumed',
  'state-job',
  'handoffs-flushed',
] as const)(
  'reopens durable stores after interruption at %s and completes one cutover with native admission held until context is ready',
  async (step) => {
    await host.db
      .getDb()
      .run('UPDATE gws_ea_chats SET connected_at=? WHERE messaging_group_id=?', '2020-01-01T00:00:00.000Z', chatId);
    for (const id of ['seed-one', 'seed-two'])
      await host.session.writeSessionMessage(old.agent_group_id, old.id, {
        id: `${id}:external`,
        kind: 'chat',
        timestamp: new Date(Date.now() - 13 * 86400_000).toISOString(),
        channelType: 'whatsapp',
        platformId: 'trip@g.us',
        content: JSON.stringify({ sender: 'Mira', text: id }),
        trigger: false,
      });
    await host.session.withMailboxSession(old.agent_group_id, old.id, (mailbox) =>
      mailbox.applyProcessingAcks(
        ['seed-one:external', 'seed-two:external'].map((messageId) => ({
          messageId,
          status: 'completed',
          statusChanged: new Date().toISOString() as import('../../mailbox/types.js').IsoTimestamp,
        })),
      ),
    );
    const reminder = dataU11(
      await sendU11(
        old,
        'remind',
        { at: new Date(Date.now() + 3600_000).toISOString(), note: 'Move this once.' },
        'move-once',
      ),
    );
    await promote();
    await inbound('held-once', 'Robin, Friday?');
    const interruption = barrier();
    if (step === 'group-created') {
      const create = host.jobs.createJobAgent;
      vi.spyOn(host.jobs, 'createJobAgent').mockImplementationOnce(async (id) => {
        await create(id);
        return interruption.stop();
      });
    } else if (step === 'source-stopped') {
      runtime.running = true;
      const open = host.session.withExistingMailboxSession;
      vi.spyOn(host.session, 'withExistingMailboxSession').mockImplementation(
        async <T>(
          group: string,
          id: string,
          action: (mailbox: MailboxSession) => T | Promise<T>,
        ): Promise<T | undefined> => {
          const result = await open(group, id, action);
          if (id === old.id && result === true && runtime.kill.mock.calls.length > 0) return interruption.stop<T>();
          return result;
        },
      );
    } else if (step === 'seed-partial') {
      const write = host.session.writeSessionMessage;
      vi.spyOn(host.session, 'writeSessionMessage').mockImplementation(async (group, id, message) => {
        await write(group, id, message);
        if (message.channelType === 'chat-seed') return interruption.stop();
      });
    } else if (step === 'reminders-copied' || step === 'reminders-resumed') {
      const open = host.session.withMailboxSession;
      vi.spyOn(host.session, 'withMailboxSession').mockImplementation(
        async <T>(group: string, id: string, action: (mailbox: MailboxSession) => T | Promise<T>): Promise<T> => {
          const result = await open(group, id, action);
          if (group !== old.agent_group_id) {
            const tasks = await host.session.withExistingMailboxSession(group, id, (mailbox) =>
              mailbox.listLiveTasks(),
            );
            const status = step === 'reminders-copied' ? 'paused' : 'pending';
            if (
              tasks?.some(
                (row) =>
                  row.id === host.remind.movedReminderId(old.id, String(reminder.reminder)) && row.status === status,
              )
            )
              return interruption.stop<T>();
          }
          return result;
        },
      );
    } else if (step === 'swapped') {
      const db = host.db.getDb();
      const transact = db.transaction.bind(db);
      let depth = 0;
      vi.spyOn(db, 'transaction').mockImplementation(async <T>(work: () => Promise<T>): Promise<T> => {
        depth += 1;
        const result = await transact(work);
        depth -= 1;
        if (depth === 0 && (await host.jobs.getJobAgentForChat(chatId))?.state === 'active')
          return interruption.stop<T>();
        return result;
      });
    } else if (step === 'held-copied') {
      const open = host.session.withExistingMailboxSession;
      vi.spyOn(host.session, 'withExistingMailboxSession').mockImplementation(
        async <T>(
          group: string,
          id: string,
          action: (mailbox: MailboxSession) => T | Promise<T>,
        ): Promise<T | undefined> => {
          const result = await open(group, id, action);
          if (
            id === old.id &&
            result === 1 &&
            (await open(group, id, (mailbox) => mailbox.getInboundRecords({ status: 'held' }).length)) === 0
          )
            return interruption.stop<T>();
          return result;
        },
      );
    } else if (step === 'old-closed') {
      const update = host.sessions.updateSession;
      vi.spyOn(host.sessions, 'updateSession').mockImplementation(async (id, fields) => {
        await update(id, fields);
        if (id === old.id && fields.status === 'closed') return interruption.stop();
      });
    } else if (step === 'state-job') {
      const db = host.db.getDb();
      const run = db.run.bind(db);
      vi.spyOn(db, 'run').mockImplementation(async (sql, ...params) => {
        const result = await run(sql, ...params);
        if (sql.includes("SET state='job'")) return interruption.stop();
        return result;
      });
    } else {
      const flush = host.bridge.flushChatHandoffs;
      vi.spyOn(host.bridge, 'flushChatHandoffs').mockImplementation(async (chat, options) => {
        await flush(chat, options);
        if (options?.wake === false) return interruption.stop();
      });
    }
    // Leave this host unreachable at a completed native write, exactly as a terminated process is.
    // No rejected promise reaches the move's rollback handler.
    void host.move.moveChat(chatId);
    await interruption.reached;
    const before = await host.jobs.getJobAgentForChat(chatId);
    if (before?.state === 'active') {
      const target = await jobSession();
      await expect(
        host.container.assertSessionAdmitted({
          disposition: 'create',
          key: { installSlug: 'test', agentGroupId: target.agent_group_id, sessionId: target.id },
        }),
      ).rejects.toThrow('move has not finished');
    }
    vi.restoreAllMocks();
    await restart();
    if (step === 'swapped') await inbound('after-swap', 'Robin, I arrived after the swap.');
    await host.move.resumeChatMoves();
    const target = await jobSession();
    await expect(
      host.container.assertSessionAdmitted({
        disposition: 'create',
        key: { installSlug: 'test', agentGroupId: target.agent_group_id, sessionId: target.id },
      }),
    ).resolves.toBeUndefined();
    expect((await host.jobs.listJobAgents()).map((row) => row.agent_group_id)).toEqual([before?.agent_group_id]);
    expect(await host.chat.getChat(chatId)).toMatchObject({
      state: 'job',
      serving_agent_group_id: target.agent_group_id,
    });
    const rows = await read(target);
    expect(
      rows
        .filter((row) => row.channelType === 'chat-seed')
        .map((row) => JSON.parse(row.content) as { text: string })
        .map((row) => row.text),
    ).toEqual(['seed-one', 'seed-two']);
    expect(rows.filter((row) => row.id === `held-once:${target.agent_group_id}`)).toMatchObject([
      { status: 'pending', trigger: true },
    ]);
    expect(rows.filter((row) => row.kind === 'task')).toMatchObject([
      { id: host.remind.movedReminderId(old.id, String(reminder.reminder)), status: 'pending' },
    ]);
    expect(rows.filter((row) => row.id.startsWith('chat-handoff-'))).toHaveLength(1);
    expect((await read(old)).filter((row) => row.status === 'held')).toEqual([]);
    if (step === 'swapped') {
      expect(rows.filter((row) => row.id === `after-swap:${target.agent_group_id}`)).toMatchObject([
        { status: 'pending', trigger: true },
      ]);
      expect((await read(old)).some((row) => row.id.startsWith('after-swap:'))).toBe(false);
    }
    expect(await host.sessions.getSession(old.id)).toMatchObject({ status: 'closed' });
  },
);

it('serializes a route that already read the old wiring with the swap and carries its held write exactly once', async () => {
  await promote();
  let unblock!: () => void;
  const released = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const routing = barrier();
  const queued = barrier();
  const write = host.session.writeSessionMessage;
  vi.spyOn(host.session, 'writeSessionMessage').mockImplementation(async (group, id, message) => {
    if (message.id === 'racing:external') {
      void routing.stop();
      await released;
    }
    return write(group, id, message);
  });
  const route = inbound('racing', 'Robin, an input racing the move.');
  await routing.reached;
  const tail = host.router.runInConversationTail;
  vi.spyOn(host.router, 'runInConversationTail').mockImplementation((address, work) => {
    void queued.stop();
    return tail(address, work);
  });
  const move = host.move.moveChat(chatId);
  await queued.reached;
  expect((await host.chat.getChat(chatId))?.serving_agent_group_id).toBe('external');
  unblock();
  await Promise.all([route, move]);
  const target = await jobSession();
  expect((await read(target)).filter((row) => row.id === `racing:${target.agent_group_id}`)).toMatchObject([
    { status: 'pending', trigger: true },
  ]);
  expect((await read(old)).find((row) => row.id === 'racing:external')?.status).toBe('completed');
});

it('resumes an interrupted undo after the retired row and connected state, retaining reminder recovery until restoration finishes', async () => {
  const reminder = dataU11(
    await sendU11(
      old,
      'remind',
      { at: new Date(Date.now() + 3600_000).toISOString(), note: 'Restore me.' },
      'restore-me',
    ),
  );
  await promote();
  gatewayFails = true;
  const interrupted = barrier();
  const db = host.db.getDb();
  const run = db.run.bind(db);
  vi.spyOn(db, 'run').mockImplementation(async (sql, ...params) => {
    const result = await run(sql, ...params);
    if (sql.includes("SET state='connected'")) return interrupted.stop();
    return result;
  });
  void host.move.moveChat(chatId);
  await interrupted.reached;
  expect((await host.jobs.listJobAgents()).map((row) => row.state)).toEqual(['retired']);
  expect((await read(old)).find((row) => row.id === reminder.reminder)?.status).toBe('paused');
  vi.restoreAllMocks();
  await restart();
  await host.move.resumeChatMoves();
  expect((await read(old)).find((row) => row.id === reminder.reminder)?.status).toBe('pending');
  expect((await host.jobs.listJobAgents()).map((row) => row.state)).toEqual(['retired']);
  expect((await read(main)).filter((row) => row.id.startsWith('chat-move-failed-'))).toHaveLength(1);
});

it('retires a move detached before the swap, then treats a genuine rejoin as a fresh epoch without reviving old reminders', async () => {
  await host.session.writeSessionMessage(old.agent_group_id, old.id, {
    id: 'old-delayed:external',
    kind: 'chat',
    timestamp: new Date().toISOString(),
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    content: '{"text":"An old epoch owed reply."}',
    processAfter: '2999-01-01T00:00:00.000Z',
    trigger: true,
  });
  const reminder = dataU11(
    await sendU11(
      old,
      'remind',
      { at: new Date(Date.now() + 3600_000).toISOString(), note: 'Old epoch.' },
      'old-epoch',
    ),
  );
  await host.join.decideJoin({
    channelType: 'whatsapp',
    platformId: 'other@g.us',
    name: 'Other chat',
    isGroup: true,
    members: [{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }],
  });
  const otherChat = await host.db
    .getDb()
    .get<{ id: string }>("SELECT id FROM messaging_groups WHERE platform_id='other@g.us'");
  if (!otherChat) throw new Error('No other chat');
  const other = (await host.session.resolveSession('external', otherChat.id, null, 'shared')).session;
  await host.session.withMailboxSession(other.agent_group_id, other.id, (mailbox) =>
    mailbox.insertTask({
      id: 'other-reminder',
      seriesId: 'other-reminder',
      content: '{"prompt":"Another chat"}',
      processAfter: null,
      recurrence: null,
    }),
  );
  await promote();
  const created = barrier();
  let release!: () => void;
  const continueCreating = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = host.jobs.createJobAgent;
  vi.spyOn(host.jobs, 'createJobAgent').mockImplementationOnce(async (id) => {
    const job = await create(id);
    void created.stop();
    await continueCreating;
    return job;
  });
  const work = host.move.moveChat(chatId);
  await created.reached;
  const previous = await host.jobs.getJobAgentForChat(chatId);
  await host.hold.detachChat(chatId);
  expect((await read(old)).find((row) => row.id === 'old-delayed:external')?.status).toBe('completed');
  expect((await host.jobs.listJobAgents()).find((job) => job.agent_group_id === previous?.agent_group_id)?.state).toBe(
    'retired',
  );
  await host.join.decideJoin({
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    name: 'New lake trip',
    isGroup: true,
    joined: true,
    members: [{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }],
  });
  dataU11(
    await sendU11(
      main,
      'chat_handoff',
      { chat: chatId, message: 'A new job in the rejoined chat.', matter: 'nowhere', job: true },
      'rejoined-job',
    ),
  );
  await host.move.moveChat(chatId);
  const epoch = await host.chat.getChat(chatId);
  const fresh = await host.jobs.getJobAgentForChat(chatId);
  release();
  await work;
  expect(await host.chat.getChat(chatId)).toEqual(epoch);
  expect(epoch).toMatchObject({ state: 'job', serving_agent_group_id: fresh?.agent_group_id });
  expect((await read(await jobSession())).some((row) => row.content.includes('An old epoch owed reply.'))).toBe(false);
  expect((await read(old)).find((row) => row.id === reminder.reminder)?.status).toBe('cancelled');
  expect((await read(other)).find((row) => row.id === 'other-reminder')?.status).toBe('pending');
  await host.agents.resumeRetiringJobAgents();
  expect((await host.jobs.listJobAgents()).map((row) => row.state)).toEqual(['retired', 'active']);
});

it('marks the job retiring in the detach transaction and resumes cleanup after a rapid rejoin interrupted external cleanup', async () => {
  await promote();
  await host.move.moveChat(chatId);
  const previous = await jobSession();
  retirementFails = true;
  await expect(host.hold.detachChat(chatId)).resolves.toBeUndefined();
  retirementFails = false;
  expect((await host.jobs.getJobAgentForChat(chatId))?.state).toBe('retiring');
  await host.join.decideJoin({
    channelType: 'whatsapp',
    platformId: 'trip@g.us',
    name: 'Rejoined',
    isGroup: true,
    joined: true,
    members: [{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }],
  });
  await restart();
  await host.lifecycle.sweepChatLifecycle();
  expect((await host.jobs.listJobAgents()).find((row) => row.agent_group_id === previous.agent_group_id)?.state).toBe(
    'retired',
  );
  expect(await host.sessions.getSession(previous.id)).toMatchObject({ status: 'closed' });
  expect((await host.chat.getChat(chatId))?.serving_agent_group_id).toBe('external');
});

it('repairs the current release shape of a creating moving job before the recovered move activates it', async () => {
  await promote();
  const job = await host.jobs.createJobAgent(chatId);
  await host.config.updateContainerConfigJson(job.agent_group_id, 'capabilities', []);
  await host.agents.reconcileChatAgents();
  const config = await host.config.getContainerConfig(job.agent_group_id);
  expect(JSON.parse(config?.capabilities ?? '[]')).toContain('gws-ea-chat-documents');
  await host.move.moveChat(chatId);
  const target = await jobSession();
  await expect(
    host.container.assertSessionAdmitted({
      disposition: 'create',
      key: { installSlug: 'test', agentGroupId: target.agent_group_id, sessionId: target.id },
    }),
  ).resolves.toBeUndefined();
});

it('swaps the open matter’s native chat handler with the serving wiring', async () => {
  const { matter } = await host.matter.openMatter({
    title: 'Lake trip',
    openLoop: 'Choose dates',
    links: [{ kind: 'chat', reference: chatId }],
  });
  dataU11(
    await sendU11(
      main,
      'chat_handoff',
      { chat: chatId, message: 'Work on this trip.', matter: matter.id, job: true },
      'matter-job',
    ),
  );
  expect((await host.matter.getMatter(matter.id))?.links.find((link) => link.kind === 'chat')?.handler).toBe(
    'external',
  );
  await host.move.moveChat(chatId);
  const target = await jobSession();
  expect((await host.matter.getMatter(matter.id))?.links.find((link) => link.kind === 'chat')?.handler).toBe(
    target.agent_group_id,
  );
});
