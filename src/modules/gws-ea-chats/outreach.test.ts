import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/gws-ea-chat-outreach-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
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
import { resolveSession, writeOutboundDirect } from '../../session-manager.js';
import type { Session } from '../../types.js';
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

it('creates a group with the principal and sends only Morgan’s per-person invitation when their settings refuse the add', async () => {
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
  const result = accepted(await request({ ...fields, group: 'Coffee next week' }));
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
