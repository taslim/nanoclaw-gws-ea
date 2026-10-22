import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/gws-ea-chat-outreach-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../gws-ea-chat-agents/gateway.js', () => ({
  retireChatGateway: vi.fn(async () => undefined),
}));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

import '../permissions/index.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-privacy/index.js';
import '../gws-ea-matters/index.js';
import '../gws-ea-chat-agents/index.js';
import './index.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { deliverSessionMessages, getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession, writeOutboundDirect, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { retireChatGateway } from '../gws-ea-chat-agents/gateway.js';
import { addPerson, getPerson, getPersonLevel } from '../gws-ea-people/db.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import type { WhatsAppAdapter } from '../gws-ea-whatsapp/adapter.js';
import { WHATSAPP_DIRECTORY_ENV } from '../gws-ea-whatsapp/paths.js';
import { transportHarness, type TransportHarness } from '../gws-ea-whatsapp/testing/harness.js';
import { getChat } from './db.js';
import { decideChatEngagement } from './engage.js';

let h: TransportHarness;
let adapter: WhatsAppAdapter;
let main: Session;
let sequence = 0;
registerChannelAdapter('whatsapp', {
  factory: () => ({ ...adapter, setup: async () => {}, teardown: async () => {} }),
});
function inbox(session: Session): { id: string; content: { text?: string; frame?: ResponseFrame } }[] {
  const file = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(file)) return [];
  const database = new Database(file, { readonly: true });
  try {
    return (
      database.prepare('SELECT id,content FROM messages_in ORDER BY seq').all() as { id: string; content: string }[]
    ).map((row) => ({ id: row.id, content: JSON.parse(row.content) as { text?: string; frame?: ResponseFrame } }));
  } finally {
    database.close();
  }
}
async function mark(id: string, text = 'Message Morgan on WhatsApp and set up coffee next week.') {
  await getDb().run(
    'INSERT INTO gws_ea_principal_messages(message_id,messaging_group_id,user_id,timestamp,text) VALUES(?,?,?,?,?)',
    id,
    'principal-dm',
    'whatsapp:11000',
    new Date().toISOString(),
    text,
  );
}
async function request(
  fields: Record<string, unknown>,
  caller = main,
  id = `outreach-${++sequence}`,
): Promise<ResponseFrame> {
  const handler = getDeliveryAction('chat_reach_out');
  if (!handler) throw new Error('chat_reach_out is not registered');
  await handler({ action: 'chat_reach_out', requestId: id, ...fields }, caller);
  const frame = inbox(caller).find((row) => row.id === `action-resp-${id}`)?.content.frame;
  if (!frame) throw new Error('No outreach response');
  return frame;
}
function accepted(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(frame.error.message);
  return frame.data as Record<string, unknown>;
}
const people = [{ name: 'Morgan Ellery', number: '+15551112222' }];
const fields = {
  people,
  message: 'Introduce yourself as my assistant and arrange coffee next week.',
  principal_message: 'principal-outreach',
};

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  h = await transportHarness();
  vi.stubEnv(WHATSAPP_DIRECTORY_ENV, h.directory);
  const now = new Date().toISOString();
  await h.writeLink({ schema_version: 1, state: 'connected', principal: { lid: '11000' }, principalVerifiedAt: now });
  for (const id of ['main', 'external', 'peer'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
  await getDb().run(
    "UPDATE gws_ea_profile SET main_agent_group_id='main',external_chat_agent_group_id='external' WHERE singleton=1",
  );
  await getDb().run(
    "INSERT INTO users(id,kind,display_name,created_at) VALUES('whatsapp:11000','whatsapp','Juno',?)",
    now,
  );
  await getDb().run("INSERT INTO gws_ea_principal_users(user_id,verified_at) VALUES('whatsapp:11000',?)", now);
  await createMessagingGroup({
    id: 'principal-dm',
    channel_type: 'whatsapp',
    platform_id: '11000@lid',
    name: 'Juno',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO user_dms(user_id,channel_type,messaging_group_id,resolved_at) VALUES('whatsapp:11000','whatsapp','principal-dm',?)",
    now,
  );
  main = (await resolveSession('main', 'principal-dm', null, 'agent-shared')).session;
  adapter = await h.start();
  h.socket().usync.set('15551112222@s.whatsapp.net', '12000@lid');
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  setDeliveryAdapter({
    deliver: async (_channel, platform, _thread, kind, content, files, _instance, id, timestamp) =>
      adapter.deliver(
        platform,
        null,
        { kind, content: JSON.parse(content) as Record<string, unknown>, files, timestamp },
        id,
      ),
  });
});
afterEach(async () => {
  await teardownChannelAdapters();
  await h.close();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('opens and connects the DM on the principal’s request, hands the job to its serving session and lets that session send the first message and answer Morgan', async () => {
  await mark('principal-outreach');
  const result = accepted(await request(fields, main, 'same-outreach'));
  const chatId = result.chat;
  if (typeof chatId !== 'string') throw new Error('Missing chat id');
  expect(await request(fields, main, 'same-outreach')).toMatchObject({ ok: true, data: result });
  expect(await getChat(chatId)).toMatchObject({ state: 'connected', serving_agent_group_id: 'external' });
  expect(await getPersonLevel('whatsapp:12000')).toBe('known');
  expect(h.socket().sends).toEqual([]);
  const session = await findSessionForAgent('external', chatId, null);
  if (!session) throw new Error('No serving session');
  expect(
    inbox(session).filter((row) => row.id.startsWith('chat-outreach-') && row.content.text?.includes('arrange coffee')),
  ).toHaveLength(1);
  await writeOutboundDirect('external', session.id, {
    id: 'external-first',
    kind: 'chat',
    platformId: '12000@lid',
    channelType: 'whatsapp',
    threadId: null,
    content: JSON.stringify({ text: 'Hi Morgan, I’m Juno’s assistant. Would Tuesday work for coffee?' }),
  });
  await deliverSessionMessages(session);
  expect(h.socket().sends).toEqual([
    expect.objectContaining({
      jid: '12000@lid',
      content: expect.objectContaining({ text: expect.stringContaining('Tuesday') }),
    }),
  ]);
  const group = await getMessagingGroup(chatId);
  if (!group) throw new Error('No chat group');
  expect(
    await decideChatEngagement({
      messagingGroup: group,
      session,
      wiring: (await getMessagingGroupAgents(chatId))[0],
      event: {
        channelType: 'whatsapp',
        platformId: '12000@lid',
        threadId: null,
        message: {
          id: 'morgan-reply',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ text: 'Tuesday works.' }),
          authenticatedSender: { kind: 'human', userId: '12000' },
        },
      },
    }),
  ).toBe(true);
  await writeOutboundDirect('external', session.id, {
    id: 'external-reply',
    kind: 'chat',
    platformId: '12000@lid',
    channelType: 'whatsapp',
    threadId: null,
    content: JSON.stringify({ text: 'Great, I’ll arrange it.' }),
  });
  await deliverSessionMessages(session);
  expect(h.socket().sends.at(-1)).toMatchObject({ jid: '12000@lid', content: { text: 'Great, I’ll arrange it.' } });
  expect(inbox(main).filter((row) => row.content.text?.includes('Tuesday works'))).toEqual([]);
});

it('refuses missing principal evidence and non-main callers before any lookup or send', async () => {
  const peer = (await resolveSession('peer', null, null, 'agent-shared')).session;
  expect(await request({ ...fields, principal_message: 'missing' })).toMatchObject({ ok: false });
  await mark('principal-outreach');
  expect(await request(fields, peer)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('Only main') },
  });
  expect(h.socket().numberQueries).toEqual([]);
  expect(h.socket().sends).toEqual([]);
});

it('refuses a sixth new person before any send or chat handoff and tells main through the existing durable note', async () => {
  await mark('principal-outreach');
  for (let person = 1; person <= 5; person++)
    await adapter.deliver(`${person}@lid`, null, { kind: 'chat', content: { text: 'Hello' } }, `first-${person}`);
  expect(await request(fields)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('contact-cap') },
  });
  expect(h.socket().sends).toHaveLength(5);
  expect(await getDb().all("SELECT * FROM messaging_groups WHERE platform_id='12000@lid'")).toEqual([]);
  expect(inbox(main).some((row) => row.content.text?.includes('contact-cap'))).toBe(true);
});

it('reports every mixed group outcome through the tool and request_status, and sends only the offered per-person invitation', async () => {
  await mark('principal-outreach', 'Make a coffee group with Morgan and me.');
  h.socket().addResults.set('12000@lid', {
    jid: '12000@lid',
    status: '403',
    content: {
      tag: 'participant',
      attrs: { jid: '12000@lid' },
      content: [
        {
          tag: 'add_request',
          attrs: { code: 'morgan-only', expiration: String(Math.floor(h.now.value / 1000) + 3600) },
        },
      ],
    },
  });
  h.socket().usync.set('15551113333@s.whatsapp.net', '13000@lid');
  h.socket().usync.set('15551114444@s.whatsapp.net', '14000@lid');
  h.socket().addResults.set('13000@lid', {
    jid: '13000@lid',
    status: '404',
    content: { tag: 'participant', attrs: {} },
  });
  const update = h.socket().groupParticipantsUpdate.bind(h.socket());
  vi.spyOn(h.socket(), 'groupParticipantsUpdate').mockImplementation(async (platform, members, action) => {
    if (members.includes('14000@lid')) throw new Error('Participant add transport interrupted');
    return update(platform, members, action);
  });
  const frame = await request({
    ...fields,
    group: 'Coffee next week',
    people: [...people, { name: 'Casey', number: '+15551113333' }, { name: 'Taylor', number: '+15551114444' }],
  });
  const result = accepted(frame);
  expect(h.socket().createdGroups).toEqual([{ subject: 'Coffee next week', participants: ['11000@lid'] }]);
  expect(h.socket().sends).toEqual([
    expect.objectContaining({
      jid: '12000@lid',
      content: expect.objectContaining({ groupInvite: expect.objectContaining({ inviteCode: 'morgan-only' }) }),
    }),
  ]);
  expect(result.participants).toEqual(
    expect.arrayContaining([expect.objectContaining({ person: 'whatsapp:12000', outcome: 'invited' })]),
  );
  expect(await getChat(String(result.chat))).toMatchObject({ state: 'connected', serving_agent_group_id: 'external' });
  expect(result.participants).toEqual([
    { person: 'whatsapp:11000', outcome: 'added' },
    { person: 'whatsapp:12000', outcome: 'invited' },
    {
      person: 'whatsapp:13000',
      outcome: 'refused',
      reason: expect.stringContaining('gws-ea-whatsapp:add-refused'),
    },
    { person: 'whatsapp:14000', outcome: 'unconfirmed', reason: 'Participant add transport interrupted' },
  ]);
  const runner = new URL('../../../container/agent-runner/src/', import.meta.url).href;
  const script = `
    await import(${JSON.stringify(`${runner}modules/index.ts`)});
    const { initTestSessionDb, getInboundDb, closeSessionDb } = await import(${JSON.stringify(`${runner}mailbox/sqlite/connection.ts`)});
    const { getUndeliveredMessages } = await import(${JSON.stringify(`${runner}db/messages-out.ts`)});
    const { chatReachOut } = await import(${JSON.stringify(`${runner}mcp-tools/gws-ea-chat-outreach.ts`)});
    const { requestStatus } = await import(${JSON.stringify(`${runner}mcp-tools/request-status.ts`)});
    const frame = await Bun.stdin.json();
    initTestSessionDb();
    try {
      const waiting = chatReachOut.handler({ people: [], message: 'Handoff', principal_message: 'principal-outreach' });
      while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
      const request = getUndeliveredMessages()[0];
      getInboundDb().prepare('INSERT INTO messages_in(id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)').run(
        'action-resp-' + request.id, 'system', new Date().toISOString(),
        JSON.stringify({ type: 'action_response', requestId: request.id, frame })
      );
      const tool = await waiting;
      const status = await requestStatus.handler({ request_id: request.id });
      console.log(JSON.stringify({ tool, status }));
    } finally { closeSessionDb(); }
  `;
  const rendered = JSON.parse(
    execFileSync('bun', ['--eval', script], {
      input: JSON.stringify(frame),
      encoding: 'utf8',
      timeout: 5000,
    }),
  ) as { tool: { content: { text: string }[] }; status: unknown };
  expect(JSON.parse(rendered.tool.content[0].text)).toEqual(result);
  expect(rendered.status).toEqual(rendered.tool);
});

it('binds the native resolved identity to Morgan’s existing record without lowering their level or handing private people context to the chat', async () => {
  await mark('principal-outreach');
  const person = await addPerson({
    name: 'Morgan Ellery',
    level: 'close',
    source: 'principal',
    basis: 'Private history with the principal',
    identity: 'email:morgan@example.com',
  });
  const result = accepted(await request({ ...fields, people: [{ ...people[0], person: person.id }] }));
  expect(await getPersonLevel('whatsapp:12000')).toBe('close');
  expect((await getPerson(person.id))?.identities.map(({ handle }) => handle)).toContain('whatsapp:12000');
  const session = await findSessionForAgent('external', String(result.chat), null);
  if (!session) throw new Error('No serving session');
  expect(JSON.stringify(inbox(session))).not.toContain('Private history');
  expect(JSON.stringify(inbox(session))).not.toContain('morgan@example.com');
});

it('does not turn the principal’s outreach citation into private-detail clearance for the new chat', async () => {
  await mark('principal-outreach');
  await addPrivateValue({ kind: 'address', label: 'Home', value: '123 Hidden Street' });
  expect(await request({ ...fields, message: 'Meet the principal at 123 Hidden Street.' })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('private address') },
  });
  expect(h.socket().numberQueries).toEqual([]);
  expect(h.socket().sends).toEqual([]);
  expect(await getDb().all('SELECT * FROM gws_ea_chat_clearances')).toEqual([]);
});

it('keeps the principal’s own DM out of external-chat even when a supplied number resolves to the principal', async () => {
  await mark('principal-outreach');
  h.socket().usync.set('15551112222@s.whatsapp.net', '11000@lid');
  expect(await request(fields)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("principal's own identity") },
  });
  expect(await getChat('principal-dm')).toBeUndefined();
  expect(h.socket().sends).toEqual([]);
});

it('brings an actual first-message 463 to main once and leaves the refused outbound row closed', async () => {
  await mark('principal-outreach');
  const result = accepted(await request(fields));
  const session = await findSessionForAgent('external', String(result.chat), null);
  if (!session) throw new Error('No serving session');
  h.socket().sendError = Object.assign(new Error('refused'), { output: { statusCode: 463 } });
  await writeOutboundDirect('external', session.id, {
    id: 'external-refused-first',
    kind: 'chat',
    platformId: '12000@lid',
    channelType: 'whatsapp',
    threadId: null,
    content: JSON.stringify({ text: 'Hi Morgan, I’m Juno’s assistant.' }),
  });
  await deliverSessionMessages(session);
  h.socket().sendError = undefined;
  await deliverSessionMessages(session);
  expect(h.socket().sends).toHaveLength(1);
  expect(inbox(main).filter((row) => row.content.text?.includes('WhatsApp error 463'))).toHaveLength(1);
  expect(inbox(main).find((row) => row.content.text?.includes('WhatsApp error 463'))?.content.text).toContain(
    'Use email or tell the principal',
  );
});

it.each([false, true])(
  'starts a fresh private-chat lifetime after the promoted job leaves, including interrupted cleanup (%s)',
  async (interrupted) => {
    await mark('principal-outreach');
    const first = accepted(await request(fields));
    const chatId = String(first.chat);
    const previous = await getChat(chatId);
    const oldSession = await findSessionForAgent('external', chatId, null);
    if (!previous || !oldSession) throw new Error('Missing original chat');
    const now = new Date().toISOString();
    await getDb().run(
      "INSERT INTO gws_ea_job_agents(agent_group_id,messaging_group_id,state,created_at,updated_at) VALUES('peer',?,'active',?,?)",
      chatId,
      now,
      now,
    );
    const job = (await resolveSession('peer', chatId, null, 'shared')).session;
    await writeSessionMessage('peer', job.id, {
      id: 'old-job-held',
      kind: 'chat',
      timestamp: now,
      platformId: '12000@lid',
      channelType: 'whatsapp',
      threadId: null,
      content: JSON.stringify({ text: 'Old private-chat work' }),
      trigger: true,
      status: 'held',
    });
    await getDb().run(
      "UPDATE gws_ea_chats SET state='job',serving_agent_group_id='peer',asking_notified_at=?,move_source_session_id=?,move_request_id='old-move',move_pending_reminder_ids_json='[\"old-reminder\"]',move_failed=1 WHERE messaging_group_id=?",
      now,
      oldSession.id,
      chatId,
    );
    const secret = await addPrivateValue({ kind: 'other', label: 'Fixture', value: 'Old cleared fixture value' });
    await getDb().run(
      'INSERT INTO gws_ea_chat_clearances(messaging_group_id,private_value_id,principal_message_id,cleared_at) VALUES(?,?,?,?)',
      chatId,
      secret.id,
      'principal-outreach',
      now,
    );
    const leave = getDeliveryAction('chat_leave');
    if (!leave) throw new Error('Missing chat_leave action');
    if (interrupted) vi.mocked(retireChatGateway).mockRejectedValueOnce(new Error('Retirement gateway interrupted'));
    await leave({ action: 'chat_leave', requestId: 'leave-job-chat', chat: chatId }, main);
    expect(inbox(main).find((row) => row.id === 'action-resp-leave-job-chat')?.content.frame).toMatchObject({
      ok: true,
    });
    expect(await getDb().get('SELECT state FROM gws_ea_job_agents WHERE agent_group_id=?', 'peer')).toEqual({
      state: interrupted ? 'retiring' : 'retired',
    });
    await mark('principal-followup', 'Contact Morgan again to arrange coffee.');
    if (interrupted) {
      vi.mocked(retireChatGateway).mockRejectedValueOnce(new Error('Retirement still unavailable'));
      expect(await request({ ...fields, principal_message: 'principal-followup' })).toMatchObject({ ok: false });
      expect(await getChat(chatId)).toMatchObject({ state: 'detached', serving_agent_group_id: 'peer' });
    }
    const reopened = accepted(await request({ ...fields, principal_message: 'principal-followup' }));
    expect(reopened.chat).toBe(chatId);
    expect(await getChat(chatId)).toMatchObject({
      state: 'connected',
      serving_agent_group_id: 'external',
      asking_notified_at: null,
    });
    expect(Date.parse((await getChat(chatId))!.created_at)).toBeGreaterThan(Date.parse(previous.created_at));
    expect(
      await getDb().get(
        'SELECT move_source_session_id,move_request_id,move_pending_reminder_ids_json,move_failed,settled_at,calendar_id,placed_nowhere FROM gws_ea_chats WHERE messaging_group_id=?',
        chatId,
      ),
    ).toEqual({
      move_source_session_id: null,
      move_request_id: null,
      move_pending_reminder_ids_json: '[]',
      move_failed: 0,
      settled_at: null,
      calendar_id: null,
      placed_nowhere: 1,
    });
    expect(await getDb().all('SELECT * FROM gws_ea_chat_clearances WHERE messaging_group_id=?', chatId)).toEqual([]);
    expect(await getMessagingGroup(chatId)).toMatchObject({ detached_at: null, denied_at: null });
    expect(await getDb().get('SELECT status FROM sessions WHERE id=?', job.id)).toEqual({ status: 'closed' });
    const oldMailbox = new Database(inboundDbPath('peer', job.id), { readonly: true });
    try {
      expect(oldMailbox.prepare('SELECT status FROM messages_in WHERE id=?').get('old-job-held')).toEqual({
        status: 'completed',
      });
    } finally {
      oldMailbox.close();
    }
    const current = await findSessionForAgent('external', chatId, null);
    expect(current?.id).not.toBe(oldSession.id);
    expect(current && inbox(current).filter((row) => row.id.startsWith('chat-outreach-'))).toHaveLength(1);
  },
);

it.each(['job', 'moving'] as const)('does not take outreach ownership from an active %s chat', async (state) => {
  await mark('principal-outreach');
  const first = accepted(await request(fields));
  await getDb().run(
    'UPDATE gws_ea_chats SET state=?,serving_agent_group_id=? WHERE messaging_group_id=?',
    state,
    'peer',
    String(first.chat),
  );
  await mark('principal-followup');
  expect(await request({ ...fields, principal_message: 'principal-followup' })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('another assistant session') },
  });
  expect(await getChat(String(first.chat))).toMatchObject({ state, serving_agent_group_id: 'peer' });
});
