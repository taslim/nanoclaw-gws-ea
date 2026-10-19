import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const { ROOT, google } = vi.hoisted(() => ({
  ROOT: `/tmp/chat-calendar-u11-${process.pid}`,
  google: { calendar: undefined as unknown },
}));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('./calendar-api.js', async (original) => {
  const actual = await original<typeof import('./calendar-api.js')>();
  const { delegatingCalendarApi } = await import('./testing/fake-calendar.js');
  return {
    ...actual,
    createMeetingsCalendarApi: () =>
      delegatingCalendarApi(() => google.calendar as import('./calendar-api.js').MeetingsCalendarApi),
  };
});
import '../gws-ea-inbox/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-privacy/index.js';
import './index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAction } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { sweepChatLifecycle } from '../gws-ea-chats/lifecycle.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import { replacePrincipalCalendars } from '../gws-ea-inbox/db.js';
import {
  cleanU11,
  dataU11,
  refusalU11,
  seedU11,
  sendU11,
  platformMembers,
} from '../gws-ea-chats/testing/u11-fixture.js';
import { setChatMemberEmail } from '../gws-ea-chats/roster.js';
import { setChatCalendar } from '../gws-ea-chats/handoffs.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { recordChatClearances } from '../gws-ea-privacy/clearance.js';
import { FakeCalendar } from './testing/fake-calendar.js';
import { createChatSchedulingTools, TAG_CHAT } from './chat-calendar.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { TAG_ROLE } from './calendar-actions.js';
const PRINCIPAL = 'juno@example.com';
const MIRA = 'mira@example.com';
const START = '2026-10-20T12:00:00Z';
const LATER = '2026-10-21T12:00:00Z';
let calendar: FakeCalendar;
let session: Session;
let chatId: string;
let main: Session;
beforeEach(async () => {
  ({ session } = await seedU11());
  chatId = session.messaging_group_id ?? '';
  calendar = new FakeCalendar();
  google.calendar = calendar;
  calendar.calendars.set(PRINCIPAL, {
    id: PRINCIPAL,
    accessRole: 'writer',
    summary: 'Meetings',
    conferenceTypes: ['hangoutsMeet'],
  });
  await addPrincipalAddress(PRINCIPAL);
  await replacePrincipalCalendars([PRINCIPAL], new Date().toISOString());
  await setChatCalendar(chatId, PRINCIPAL);
  await setChatMemberEmail(chatId, 'whatsapp:22', MIRA, 'main');
  await setChatMemberEmail(chatId, 'whatsapp:11', PRINCIPAL, 'main');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
  main = await calendarMain();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanU11(ROOT);
});
const fields = { start: START, minutes: 30, title: 'Venue visit' };
it('refuses an unset calendar, a foreign session, an outsider address and caller-supplied source fields', async () => {
  await getDb().run('UPDATE gws_ea_chats SET calendar_id=NULL WHERE messaging_group_id=?', chatId);
  expect(refusalU11(await sendU11(session, 'chat_book', fields))).toMatch(/No calendar/);
  await setChatCalendar(chatId, PRINCIPAL);
  const foreign = (await resolveSession('peer', chatId, null, 'shared')).session;
  expect(refusalU11(await sendU11(foreign, 'chat_book', fields))).toContain('serving');
  expect(refusalU11(await sendU11(session, 'chat_book', { ...fields, invitees: ['outsider@example.com'] }))).toContain(
    'current members',
  );
  expect(refusalU11(await sendU11(session, 'chat_book', { ...fields, chat: 'another' }))).toContain('Unknown field');
  expect(calendar.writes).toEqual([]);
});
it('books only current roster members with email, replays once, and changes/cancels only its own chat booking', async () => {
  const booked = dataU11(await sendU11(session, 'chat_book', fields, 'book-once'));
  expect(dataU11(await sendU11(session, 'chat_book', fields, 'book-once'))).toEqual(booked);
  expect(calendar.writes).toHaveLength(1);
  const event = calendar.live()[0];
  expect(event).toMatchObject({
    calendarId: PRINCIPAL,
    summary: 'Venue visit',
    tags: { [TAG_CHAT]: chatId, [TAG_ROLE]: 'booking' },
    attendees: [{ email: PRINCIPAL, responseStatus: 'accepted', organizer: true }, { email: MIRA }],
  });
  expect(await getDb().all('SELECT messaging_group_id FROM gws_ea_chat_bookings')).toEqual([
    { messaging_group_id: chatId },
  ]);
  expect(await getDb().all('SELECT * FROM gws_ea_threads')).toEqual([]);
  const peer = (await resolveSession('peer', chatId, null, 'shared')).session;
  expect(refusalU11(await sendU11(peer, 'chat_cancel_booking', { booking: booked.booking }))).toContain('serving');
  dataU11(
    await sendU11(session, 'chat_change_booking', { booking: booked.booking, start: LATER, title: 'Venue walk' }),
  );
  expect(calendar.event(PRINCIPAL, String(booked.booking))).toMatchObject({
    summary: 'Venue walk',
    start: { dateTime: '2026-10-21T12:00:00.000Z' },
  });
  dataU11(await sendU11(session, 'chat_cancel_booking', { booking: booked.booking }));
  expect(calendar.live()).toEqual([]);
  expect(calendar.writes.map((write) => write.sendUpdates)).toEqual(['all', 'all', 'all']);
});
it('leaves a new booking for main to place when its chat belongs to more than one open matter', async () => {
  const { openMatter } = await import('../gws-ea-matters/db.js');
  await openMatter({
    title: 'Cabin preparations',
    openLoop: 'Choose a cabin',
    links: [{ kind: 'chat', reference: chatId }],
  });
  const booked = dataU11(await sendU11(session, 'chat_book', fields));
  expect(calendar.live()).toHaveLength(1);
  expect(
    await getDb().all(
      "SELECT matter_id FROM gws_ea_matter_links WHERE kind='chat' AND reference=? AND matter_open=1",
      chatId,
    ),
  ).toHaveLength(2);
  expect(
    await getDb().all(
      "SELECT matter_id FROM gws_ea_matter_links WHERE kind='event' AND reference=? AND matter_open=1",
      `${PRINCIPAL}/${String(booked.booking)}`,
    ),
  ).toEqual([]);
});
it('refreshes the actual platform roster before authorizing an invitation or update', async () => {
  const first = dataU11(await sendU11(session, 'chat_book', fields));
  platformMembers([{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }]);
  expect(refusalU11(await sendU11(session, 'chat_book', { ...fields, start: LATER, invitees: [MIRA] }))).toContain(
    'current members',
  );
  expect(
    refusalU11(
      await sendU11(session, 'chat_change_booking', { booking: first.booking, title: 'Changed after departure' }),
    ),
  ).toContain('current members');
  expect(calendar.writes).toHaveLength(1);
});
it('keeps booking ownership on the chat through a serving-agent promotion and rejects the old session', async () => {
  const booked = dataU11(await sendU11(session, 'chat_book', fields));
  await createAgentGroup({
    id: 'job',
    name: 'Job',
    folder: 'job',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await getDb().run(
    "INSERT INTO gws_ea_job_agents(agent_group_id,messaging_group_id,state,created_at,updated_at) VALUES('job',?,'active',?,?)",
    chatId,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  await getDb().run(
    "UPDATE gws_ea_chats SET state='job',serving_agent_group_id='job' WHERE messaging_group_id=?",
    chatId,
  );
  const job = (await resolveSession('job', chatId, null, 'shared')).session;
  expect(refusalU11(await sendU11(session, 'chat_cancel_booking', { booking: booked.booking }))).toContain('serving');
  dataU11(await sendU11(job, 'chat_change_booking', { booking: booked.booking, location: 'Venue entrance' }));
  dataU11(await sendU11(job, 'chat_cancel_booking', { booking: booked.booking }));
  expect(calendar.live()).toEqual([]);
});
it('returns free windows only and refuses a now-busy booking without exposing calendar details', async () => {
  calendar.put({
    id: 'private-event',
    calendarId: PRINCIPAL,
    summary: 'Private therapy',
    description: 'Private treatment',
    start: { dateTime: START },
    end: { dateTime: '2026-10-20T13:00:00Z' },
  });
  const detailRead = vi.spyOn(calendar, 'listEventDetails');
  const free = dataU11(
    await sendU11(session, 'chat_free_time', { from: '2026-10-20T09:00:00Z', to: '2026-10-20T17:00:00Z', minutes: 30 }),
  );
  expect(free.windows).toEqual(expect.any(Array));
  const windows = free.windows as { start: string; end: string }[];
  expect(windows.length).toBeGreaterThan(0);
  for (const window of windows)
    expect(
      Date.parse(window.end) <= Date.parse(START) || Date.parse(window.start) >= Date.parse('2026-10-20T13:00:00Z'),
    ).toBe(true);
  expect(JSON.stringify(free)).not.toMatch(/Private therapy|Private treatment|private-event|juno@example/);
  expect(detailRead).not.toHaveBeenCalled();
  expect(refusalU11(await sendU11(session, 'chat_book', fields))).toContain('no longer free');
  expect(calendar.writes).toEqual([]);
});
it('honors an exact-chat principal clearance on invitation text without granting another chat clearance', async () => {
  const value = await addPrivateValue({ kind: 'phone', label: 'Private phone', value: '+14155550123' });
  expect(refusalU11(await sendU11(session, 'chat_book', { ...fields, notes: '+14155550123' }))).toContain('private');
  await getDb().run(
    "INSERT INTO users(id,kind,display_name,created_at) VALUES('whatsapp:11','whatsapp','Juno',?)",
    new Date().toISOString(),
  );
  await getDb().run(
    "INSERT INTO gws_ea_principal_users(user_id,verified_at) VALUES('whatsapp:11',?)",
    new Date().toISOString(),
  );
  await getDb().run(
    "INSERT INTO gws_ea_principal_messages(message_id,messaging_group_id,user_id,timestamp,text) VALUES('stored-principal',?,'whatsapp:11',?,'Share my phone number for this meeting.')",
    chatId,
    new Date().toISOString(),
  );
  await recordChatClearances({ messagingGroupId: chatId, principalMessageId: 'stored-principal', values: [value] });
  dataU11(await sendU11(session, 'chat_book', { ...fields, notes: '+14155550123' }));
  expect(calendar.live()[0].description).toBe('+14155550123');
});
it('refuses a booking whose Google ownership tag changed', async () => {
  const booked = dataU11(await sendU11(session, 'chat_book', fields));
  const event = calendar.live()[0];
  calendar.put({ ...event, tags: { [TAG_ROLE]: 'booking', [TAG_CHAT]: 'another-chat' } });
  expect(refusalU11(await sendU11(session, 'chat_cancel_booking', { booking: booked.booking }))).toContain('belongs');
  expect(calendar.live()).toHaveLength(1);
});
it('never lets another chat of the same shared agent change or cancel its booking', async () => {
  const booked = dataU11(await sendU11(session, 'chat_book', fields));
  const { decideJoin } = await import('../gws-ea-chats/join.js');
  await decideJoin({
    channelType: 'whatsapp',
    platformId: 'other@g.us',
    name: 'Other',
    isGroup: true,
    members: [
      { key: 'whatsapp:11', name: 'Juno', isPrincipal: true },
      { key: 'whatsapp:22', name: 'Mira', isPrincipal: false },
    ],
  });
  const other = await getDb().get<{ messaging_group_id: string }>(
    'SELECT c.messaging_group_id FROM gws_ea_chats c JOIN messaging_groups m ON m.id=c.messaging_group_id WHERE m.platform_id=?',
    'other@g.us',
  );
  if (!other) throw new Error('No second chat');
  await setChatCalendar(other.messaging_group_id, PRINCIPAL);
  const caller = (await resolveSession('external', other.messaging_group_id, null, 'shared')).session;
  expect(
    refusalU11(await sendU11(caller, 'chat_change_booking', { booking: booked.booking, title: 'Stolen booking' })),
  ).toContain('no such booking');
  expect(refusalU11(await sendU11(caller, 'chat_cancel_booking', { booking: booked.booking }))).toContain(
    'no such booking',
  );
  expect(calendar.live()[0].summary).toBe('Venue visit');
  expect(calendar.writes).toHaveLength(1);
});
it('withdraws its own partially applied booking when the calendar reports failure', async () => {
  calendar.failNext({ op: 'insert', error: new Error('calendar connection lost'), afterApplying: true });
  expect(refusalU11(await sendU11(session, 'chat_book', fields))).toContain('calendar connection lost');
  expect(calendar.live()).toEqual([]);
  expect(await getDb().all('SELECT * FROM gws_ea_chat_bookings')).toEqual([]);
});
it('serializes real email and chat bookings so only one can take the same free slot', async () => {
  vi.useRealTimers();
  const insert = calendar.insertEvent.bind(calendar);
  vi.spyOn(calendar, 'insertEvent').mockImplementation(async (...args) => {
    // Google has not applied the first write yet while another source checks availability.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return insert(...args);
  });
  const { createMessagingGroup } = await import('../../db/messaging-groups.js');
  const { createThread, recordThreadAddresses } = await import('../gws-ea-inbox/thread-map.js');
  const { recordExternalEmailAgentGroupId } = await import('../gws-ea-profile/db.js');
  const { setThreadBookingCalendar } = await import('./thread-calendar.js');
  await createAgentGroup({
    id: 'email-worker',
    name: 'Email',
    folder: 'email-worker',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await recordExternalEmailAgentGroupId('email-worker');
  await createMessagingGroup({
    id: 'email-inbox',
    channel_type: 'email',
    platform_id: 'email:inbox',
    name: 'Inbox',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  const thread = await createThread(null, new Date().toISOString());
  await recordThreadAddresses(thread.threadKey, [MIRA], 'message', new Date().toISOString());
  await setThreadBookingCalendar(thread.threadKey, PRINCIPAL);
  const emailSession = (await resolveSession('email-worker', 'email-inbox', thread.threadKey, 'per-thread')).session;
  const results = await Promise.all([sendU11(session, 'chat_book', fields), sendU11(emailSession, 'book', fields)]);
  expect(results.filter((frame) => frame.ok)).toHaveLength(1);
  const denied = results.find((frame) => !frame.ok);
  if (!denied) throw new Error('Both sources booked one slot');
  expect(refusalU11(denied)).toContain('no longer free');
  expect(calendar.live()).toHaveLength(1);
});

async function calendarMain(): Promise<Session> {
  const now = new Date().toISOString();
  await getDb().run("INSERT INTO users(id,kind,display_name,created_at) VALUES('gchat:juno','gchat','Juno',?)", now);
  await getDb().run("INSERT INTO gws_ea_principal_users(user_id,verified_at) VALUES('gchat:juno',?)", now);
  await createMessagingGroup({
    id: 'calendar-principal-dm',
    channel_type: 'gchat',
    platform_id: 'spaces/juno',
    name: 'Juno',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO user_dms(user_id,channel_type,messaging_group_id,resolved_at) VALUES('gchat:juno','gchat','calendar-principal-dm',?)",
    now,
  );
  return (await resolveSession('main', 'calendar-principal-dm', null, 'agent-shared')).session;
}
function calendarNotes(main: Session, kind: string): { id: string; content: string }[] {
  const db = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
  try {
    return db.prepare('SELECT id,content FROM messages_in WHERE id LIKE ?').all(`chat-booking-%-${kind}-%`) as {
      id: string;
      content: string;
    }[];
  } finally {
    db.close();
  }
}
it('renders actual host availability and booking answers with their usable windows and booking ID', async () => {
  const free = await sendU11(session, 'chat_free_time', {
    from: '2026-10-20T09:00:00Z',
    to: '2026-10-20T17:00:00Z',
    minutes: 30,
  });
  const booked = await sendU11(session, 'chat_book', fields);
  const renderer = fileURLToPath(new URL('../../../container/agent-runner/src/action-request.ts', import.meta.url));
  const output = execFileSync(
    'bun',
    [
      '--eval',
      `import { answerResult } from ${JSON.stringify(renderer)}; process.stdout.write(JSON.stringify((await Bun.stdin.json()).map(answerResult)));`,
    ],
    { input: JSON.stringify([free, booked]), encoding: 'utf8' },
  );
  const rendered = JSON.parse(output) as { content: { type: string; text: string }[] }[];
  const freeData = dataU11(free);
  expect(JSON.parse(rendered[0].content[0].text)).toMatchObject({
    windows: freeData.windows,
    windows_not_listed: freeData.windows_not_listed,
  });
  expect(rendered[1].content[0].text).toContain(String(dataU11(booked).booking));
});
it.each(['patch', 'delete'] as const)(
  'confirms a remotely applied %s with a lost acknowledgment and tells main once',
  async (op) => {
    const booked = dataU11(await sendU11(session, 'chat_book', fields));
    const action = op === 'patch' ? 'chat_change_booking' : 'chat_cancel_booking';
    const request = { booking: booked.booking, ...(op === 'patch' ? { start: LATER } : {}) };
    const id = `lost-${op}`;
    calendar.failNext({ op, error: new Error('calendar answer lost'), afterApplying: true });
    const first = await sendU11(session, action, request, id);
    expect(first.ok).toBe(true);
    expect(await sendU11(session, action, request, id)).toEqual(first);
    expect(calendar.writes.filter((write) => write.op === op)).toHaveLength(1);
    const kind = op === 'patch' ? 'changed' : 'cancelled';
    expect(calendarNotes(main, kind)).toHaveLength(1);
    expect(calendarNotes(main, kind)[0].content).toContain(String(booked.booking));
    expect(calendarNotes(main, kind)[0].content).toContain(op === 'patch' ? 'Wednesday 21 Oct' : 'Tuesday 20 Oct');
    expect(await getDb().all('SELECT event_id FROM gws_ea_chat_bookings')).toHaveLength(op === 'patch' ? 1 : 0);
    expect(calendar.event(PRINCIPAL, String(booked.booking))).toMatchObject(
      op === 'patch' ? { start: { dateTime: '2026-10-21T12:00:00.000Z' } } : { status: 'cancelled' },
    );
  },
);
it.each(['patch', 'delete'] as const)(
  'resumes a %s whose Google read-back was unavailable without repeating the mutation',
  async (op) => {
    const booked = dataU11(await sendU11(session, 'chat_book', fields));
    const action = op === 'patch' ? 'chat_change_booking' : 'chat_cancel_booking';
    const request = { booking: booked.booking, ...(op === 'patch' ? { start: LATER } : {}) };
    const id = `read-back-${op}`;
    const read = calendar.getEvent.bind(calendar);
    vi.spyOn(calendar, 'getEvent').mockImplementation(async (...args) => {
      if (calendar.writes.some((write) => write.op === op)) throw new Error('Google read-back disconnected');
      return read(...args);
    });
    calendar.failNext({ op, error: new Error('calendar answer lost'), afterApplying: true });
    const handler = getDeliveryAction(action);
    if (!handler) throw new Error('No calendar action');
    await handler({ ...request, action, requestId: id }, session);
    const inbox = new Database(inboundDbPath(session.agent_group_id, session.id));
    try {
      expect(inbox.prepare('SELECT id FROM messages_in WHERE id=?').get(`action-resp-${id}`)).toBeUndefined();
      expect(calendarNotes(main, op === 'patch' ? 'changed' : 'cancelled')).toEqual([]);
      vi.mocked(calendar.getEvent).mockRestore();
      await sweepChatLifecycle();
      const recovered = await sendU11(session, action, request, id);
      expect(recovered.ok).toBe(true);
      expect(calendar.writes.filter((write) => write.op === op)).toHaveLength(1);
      expect(calendarNotes(main, op === 'patch' ? 'changed' : 'cancelled')).toHaveLength(1);
    } finally {
      inbox.close();
    }
  },
);

it.each(['patch', 'delete'] as const)(
  'replays a confirmed %s after its action-response write was interrupted',
  async (op) => {
    const booked = dataU11(await sendU11(session, 'chat_book', fields));
    const action = op === 'patch' ? 'chat_change_booking' : 'chat_cancel_booking';
    const request = { booking: booked.booking, ...(op === 'patch' ? { start: LATER } : {}) };
    const id = `answer-write-${op}`;
    const host = await import('../../session-manager.js');
    const write = host.writeSessionMessage;
    const interrupted = vi.spyOn(host, 'writeSessionMessage').mockImplementation(async (...args) => {
      if (args[2].id === `action-resp-${id}`) throw new Error('host stopped before writing the answer');
      return write(...args);
    });
    const handler = getDeliveryAction(action);
    if (!handler) throw new Error('No calendar action');
    await expect(handler({ ...request, action, requestId: id }, session)).rejects.toThrow('host stopped');
    interrupted.mockRestore();
    await createChatSchedulingTools({ calendar: () => calendar }).resumePending();
    expect((await sendU11(session, action, request, id)).ok).toBe(true);
    expect(calendar.writes.filter((record) => record.op === op)).toHaveLength(1);
    expect(calendarNotes(main, op === 'patch' ? 'changed' : 'cancelled')).toHaveLength(1);
  },
);
it('keeps a confirmed mutation pending until main receives its one durable note', async () => {
  const booked = dataU11(await sendU11(session, 'chat_book', fields));
  const request = { booking: booked.booking, start: LATER };
  const host = await import('../../session-manager.js');
  const write = host.writeSessionMessage;
  const interrupted = vi.spyOn(host, 'writeSessionMessage').mockImplementation(async (...args) => {
    if (args[2].id.includes('-changed-')) throw new Error('main mailbox temporarily unavailable');
    return write(...args);
  });
  const handler = getDeliveryAction('chat_change_booking');
  if (!handler) throw new Error('No calendar action');
  await handler({ ...request, action: 'chat_change_booking', requestId: 'main-note-lost' }, session);
  expect(calendarNotes(main, 'changed')).toEqual([]);
  interrupted.mockRestore();
  await createChatSchedulingTools({ calendar: () => calendar }).resumePending();
  expect((await sendU11(session, 'chat_change_booking', request, 'main-note-lost')).ok).toBe(true);
  expect(calendar.writes.filter((record) => record.op === 'patch')).toHaveLength(1);
  expect(calendarNotes(main, 'changed')).toHaveLength(1);
});
it('rechecks current membership and private text before retrying an unapplied change', async () => {
  const booked = dataU11(await sendU11(session, 'chat_book', fields));
  const request = { booking: booked.booking, notes: '+14155550123' };
  calendar.failNext({ op: 'patch', error: new Error('request disconnected before Google applied it') });
  const handler = getDeliveryAction('chat_change_booking');
  if (!handler) throw new Error('No calendar action');
  await handler({ ...request, action: 'chat_change_booking', requestId: 'permission-retry' }, session);
  platformMembers([{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }]);
  await createChatSchedulingTools({ calendar: () => calendar }).resumePending();
  expect(calendar.writes.filter((record) => record.op === 'patch')).toEqual([]);
  platformMembers([
    { key: 'whatsapp:11', name: 'Juno', isPrincipal: true },
    { key: 'whatsapp:22', name: 'Mira', isPrincipal: false },
  ]);
  await addPrivateValue({ kind: 'phone', label: 'Private phone', value: '+14155550123' });
  await createChatSchedulingTools({ calendar: () => calendar }).resumePending();
  expect(calendar.writes.filter((record) => record.op === 'patch')).toEqual([]);
  expect(calendarNotes(main, 'changed')).toEqual([]);
});
it.each(['patch', 'delete'] as const)(
  'answers a definite Google %s refusal instead of retrying it as an uncertain write',
  async (op) => {
    const booked = dataU11(await sendU11(session, 'chat_book', fields));
    calendar.failNext({ op, error: new GoogleApiError(403, 'Calendar permission refused') });
    const request = { booking: booked.booking, ...(op === 'patch' ? { start: LATER } : {}) };
    expect(
      refusalU11(
        await sendU11(
          session,
          op === 'patch' ? 'chat_change_booking' : 'chat_cancel_booking',
          request,
          `refused-${op}`,
        ),
      ),
    ).toContain('permission refused');
    expect(await getDb().all('SELECT request_id FROM gws_ea_chat_booking_requests')).toEqual([]);
    expect(calendarNotes(main, op === 'patch' ? 'changed' : 'cancelled')).toEqual([]);
  },
);

it('reports an unconfirmed request to main once when its serving session closes, without another Google write or a chat reply', async () => {
  const booked = dataU11(await sendU11(session, 'chat_book', fields));
  const request = { booking: booked.booking, start: LATER };
  calendar.failNext({ op: 'patch', error: new Error('request disconnected') });
  const handler = getDeliveryAction('chat_change_booking');
  if (!handler) throw new Error('No calendar action');
  await handler({ ...request, action: 'chat_change_booking', requestId: 'closed-intent' }, session);
  await getDb().run("UPDATE sessions SET status='closed' WHERE id=?", session.id);
  const recovered = createChatSchedulingTools({ calendar: () => calendar });
  await recovered.resumePending();
  await recovered.resumePending();
  const inbox = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
  const chat = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    const notices = inbox
      .prepare("SELECT content FROM messages_in WHERE id LIKE 'chat-booking-unconfirmed-%'")
      .all() as { content: string }[];
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain(String(booked.booking));
    expect(notices[0].content).toContain('may already have changed');
    expect(chat.prepare("SELECT id FROM messages_in WHERE id='action-resp-closed-intent'").get()).toBeUndefined();
    expect(calendar.writes.filter((write) => write.op === 'patch')).toEqual([]);
  } finally {
    inbox.close();
    chat.close();
  }
});
it('does not later resume an unapplied mutation after its tool received a terminal refusal', async () => {
  const booked = dataU11(await sendU11(session, 'chat_book', fields));
  const request = { booking: booked.booking, notes: '+14155550123' };
  calendar.failNext({ op: 'patch', error: new Error('request disconnected') });
  const handler = getDeliveryAction('chat_change_booking');
  if (!handler) throw new Error('No calendar action');
  await handler({ ...request, action: 'chat_change_booking', requestId: 'terminal-intent' }, session);
  const secret = await addPrivateValue({ kind: 'phone', label: 'Private phone', value: '+14155550123' });
  expect(refusalU11(await sendU11(session, 'chat_change_booking', request, 'terminal-intent'))).toContain('private');
  await getDb().run('DELETE FROM gws_ea_private_values WHERE id=?', secret.id);
  await createChatSchedulingTools({ calendar: () => calendar }).resumePending();
  expect(calendar.writes.filter((write) => write.op === 'patch')).toEqual([]);
  expect(calendarNotes(main, 'changed')).toEqual([]);
});
