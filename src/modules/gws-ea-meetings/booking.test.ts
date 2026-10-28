import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/booking-reads-${process.pid}`);
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import '../gws-ea-inbox/index.js';
import '../gws-ea-preferences/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { addPrincipalAddress, recordExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { replacePrincipalCalendars } from '../gws-ea-inbox/db.js';
import { createThread, recordThreadAddresses } from '../gws-ea-inbox/thread-map.js';
import { cleanChatDelivery, platformMembers, seedChatDelivery } from '../gws-ea-chats/testing/chat-delivery-fixture.js';
import { setChatMemberEmail } from '../gws-ea-chats/roster.js';
import { setChatCalendar } from '../gws-ea-chats/handoffs.js';
import { placeInMatter } from '../gws-ea-matters/db.js';
import { FakeCalendar } from './testing/fake-calendar.js';
import { setThreadBookingCalendar } from './thread-calendar.js';
import { createBookingReads } from './booking.js';
import { bookingSurfaceFor, resolveBookingSurface } from './booking-surface.js';

const PRINCIPAL = 'juno@example.com';
const ASSISTANT = 'avery@example.com';
const MIRA = 'mira@example.com';
const TEAM = 'visits@group.calendar.google.com';
const RANGE = { from: '2026-10-20T09:00:00Z', to: '2026-10-20T17:00:00Z', minutes: 30, timezone: 'Europe/Paris' };
let calendar: FakeCalendar;
let thread: string;
let chat: string;
let matterId: string;
let emailSession: Session;
let chatSession: Session;
let reads: ReturnType<typeof createBookingReads>;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-10-18T12:00:00Z'), toFake: ['Date'] });
  const seeded = await seedChatDelivery();
  chatSession = seeded.session;
  matterId = seeded.matter.id;
  chat = chatSession.messaging_group_id ?? '';
  await createAgentGroup({
    id: 'email',
    name: 'email',
    folder: 'email',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createMessagingGroup({
    id: 'mail',
    channel_type: 'email',
    platform_id: 'mail',
    name: 'Mail',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  await recordExternalEmailAgentGroupId('email');
  await addPrincipalAddress(PRINCIPAL);
  await getDb().run('UPDATE gws_ea_profile SET assistant_workspace_email=? WHERE singleton=1', ASSISTANT);
  await replacePrincipalCalendars([PRINCIPAL], new Date().toISOString());
  ({ threadKey: thread } = await createThread(null, new Date().toISOString()));
  await recordThreadAddresses(thread, [PRINCIPAL, ASSISTANT, MIRA], 'message', new Date().toISOString());
  emailSession = (await resolveSession('email', 'mail', thread, 'per-thread')).session;
  await setThreadBookingCalendar(thread, TEAM);
  await setChatCalendar(chat, TEAM);
  await setChatMemberEmail(chat, 'whatsapp:22', MIRA, 'main');
  await setChatMemberEmail(chat, 'whatsapp:11', PRINCIPAL, 'main');
  calendar = new FakeCalendar();
  calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer' });
  calendar.calendars.set(TEAM, { id: TEAM, dataOwner: PRINCIPAL, accessRole: 'writer' });
  reads = createBookingReads({ calendar: () => calendar });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanChatDelivery(ROOT);
});

it('offers the same windows in text with both-zone labels from either real surface, including the booking calendar', async () => {
  calendar.put({
    calendarId: PRINCIPAL,
    id: 'private-principal',
    summary: 'Private therapy',
    start: { dateTime: '2026-10-20T12:00:00Z' },
    end: { dateTime: '2026-10-20T13:00:00Z' },
  });
  calendar.put({
    calendarId: TEAM,
    id: 'private-booking-calendar',
    summary: 'Private review',
    start: { dateTime: '2026-10-20T14:00:00Z' },
    end: { dateTime: '2026-10-20T15:00:00Z' },
  });
  const details = vi.spyOn(calendar, 'listEventDetails');
  const email = await reads.freeTime(RANGE, emailSession, 'email-free');
  const spoken = await reads.freeTime(RANGE, chatSession, 'chat-free');
  expect(email).toEqual(spoken);
  expect(email.windows).toEqual([
    {
      start: '2026-10-20T09:00:00.000Z',
      end: '2026-10-20T12:00:00.000Z',
      principal_time: 'Tuesday, Oct 20, 9:00 AM–12:00 PM UTC',
      their_time: 'Tuesday, Oct 20, 11:00 AM–2:00 PM CEST',
      fit: 'acceptable',
    },
    {
      start: '2026-10-20T13:00:00.000Z',
      end: '2026-10-20T14:00:00.000Z',
      principal_time: 'Tuesday, Oct 20, 1:00–2:00 PM UTC',
      their_time: 'Tuesday, Oct 20, 3:00–4:00 PM CEST',
      fit: 'acceptable',
    },
    {
      start: '2026-10-20T15:00:00.000Z',
      end: '2026-10-20T17:00:00.000Z',
      principal_time: 'Tuesday, Oct 20, 3:00–5:00 PM UTC',
      their_time: 'Tuesday, Oct 20, 5:00–7:00 PM CEST',
      fit: 'acceptable',
    },
  ]);
  expect(email.message).toContain("Free for 30 minutes: any start that ends by a window's end.");
  expect(email.message).toContain('for them, Tuesday, Oct 20, 11:00 AM–2:00 PM CEST');
  expect(JSON.stringify(email)).not.toMatch(
    /Private therapy|Private review|private-principal|private-booking-calendar/,
  );
  expect(details).not.toHaveBeenCalled();
});

it('refuses a missing booking calendar on both surfaces before making any Calendar call', async () => {
  await getDb().run('UPDATE gws_ea_threads SET booking_calendar_id=NULL WHERE thread_key=?', thread);
  await getDb().run('UPDATE gws_ea_chats SET calendar_id=NULL WHERE messaging_group_id=?', chat);
  for (const session of [emailSession, chatSession])
    await expect(reads.freeTime(RANGE, session, 'missing')).rejects.toThrow(
      'wake main once with tell_main to ask which calendar to book on, and offer no time until it answers',
    );
  expect(calendar.calls).toBe(0);
});

it('refuses a booking calendar that is no longer bookable separately from an unset calendar', async () => {
  calendar.calendars.set(TEAM, { id: TEAM, dataOwner: PRINCIPAL, accessRole: 'reader' });
  const listing = vi.spyOn(calendar, 'listEvents');
  for (const session of [emailSession, chatSession])
    await expect(reads.freeTime(RANGE, session, 'unbookable')).rejects.toThrow(
      'no longer one the assistant can book on',
    );
  expect(listing).not.toHaveBeenCalled();
});

it('reads a principal calendar and the same booking calendar in another case only once', async () => {
  await replacePrincipalCalendars([PRINCIPAL.toUpperCase()], new Date().toISOString());
  await setThreadBookingCalendar(thread, PRINCIPAL);
  await setChatCalendar(chat, PRINCIPAL);
  const listing = vi.spyOn(calendar, 'listEvents');
  for (const session of [emailSession, chatSession]) {
    listing.mockClear();
    await reads.freeTime(RANGE, session, 'dedupe');
    expect(listing).toHaveBeenCalledTimes(1);
    expect(listing.mock.calls[0][0].toLowerCase()).toBe(PRINCIPAL);
  }
});

it('refuses caller-supplied source fields on both surfaces before any Calendar call', async () => {
  for (const session of [emailSession, chatSession])
    await expect(reads.freeTime({ ...RANGE, owner: 'another-owner' }, session, 'foreign-field')).rejects.toThrow(
      'Unknown field owner',
    );
  expect(calendar.calls).toBe(0);
});

describe.each([
  ['to before from', { ...RANGE, to: '2026-10-20T08:00:00Z' }, 'to must come after from'],
  ['more than sixty days', { ...RANGE, to: '2026-12-20T17:00:00Z' }, 'The range may span at most 60 days'],
  [
    'past range',
    { ...RANGE, from: '2026-10-15T09:00:00Z', to: '2026-10-15T17:00:00Z' },
    'That range has already passed: ask for one in the future.',
  ],
] as const)('%s', (_name, range, message) => {
  it('has its own refusal on both surfaces without a Calendar read', async () => {
    for (const session of [emailSession, chatSession])
      await expect(reads.freeTime(range, session, 'range')).rejects.toThrow(message);
    expect(calendar.calls).toBe(0);
  });
});

it('requires the actual stored serving session and refuses a fabricated thread binding or an old chat owner', async () => {
  await expect(resolveBookingSurface({ ...emailSession, thread_id: 'another-thread' })).rejects.toThrow();
  await expect(resolveBookingSurface({ ...chatSession, agent_group_id: 'peer' })).rejects.toThrow('serving');
  await getDb().run("UPDATE sessions SET status='closed' WHERE id=?", emailSession.id);
  await expect(resolveBookingSurface(emailSession)).rejects.toThrow();
  await getDb().run("UPDATE gws_ea_chats SET serving_agent_group_id='peer' WHERE messaging_group_id=?", chat);
  await expect(resolveBookingSurface(chatSession)).rejects.toThrow('serving');
});

it('keeps owner-bound calendars and linked conversations available after its session disappears', async () => {
  await placeInMatter(matterId, [{ kind: 'thread', reference: thread }]);
  const email = bookingSurfaceFor({ kind: 'thread', key: thread });
  const spoken = bookingSurfaceFor({ kind: 'chat', key: chat });
  await getDb().run('DELETE FROM sessions WHERE id IN (?,?)', emailSession.id, chatSession.id);
  expect(await email.calendarId()).toBe(TEAM);
  expect(await spoken.calendarId()).toBe(TEAM);
  expect(await email.openMatters()).toEqual([{ id: matterId, conversations: [{ kind: 'chat', key: chat }] }]);
  expect(await spoken.openMatters()).toEqual([{ id: matterId, conversations: [{ kind: 'thread', key: thread }] }]);
  expect(await email.stillServing(emailSession)).toBe(false);
  expect(await spoken.stillServing(chatSession)).toBe(false);
});

it('uses job privacy and supplies chat clearances only for recipients who are all current members with email', async () => {
  await createAgentGroup({
    id: 'job',
    name: 'job',
    folder: 'job',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await getDb().run(
    "INSERT INTO gws_ea_job_agents(agent_group_id,messaging_group_id,state,created_at,updated_at) VALUES('job',?,'active',?,?)",
    chat,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  await getDb().run(
    "UPDATE gws_ea_chats SET state='job',serving_agent_group_id='job' WHERE messaging_group_id=?",
    chat,
  );
  const session = (await resolveSession('job', chat, null, 'shared')).session;
  const { surface, writer } = await resolveBookingSurface(session);
  expect(writer).toBe('job');
  expect(await surface.privacyFor([MIRA], writer)).toEqual({ writer: 'job', chatId: chat });
  expect(await surface.privacyFor([MIRA, 'guest@outside.example'], writer)).toEqual({ writer: 'job' });
  platformMembers([{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }]);
  await surface.beforeWrite();
  expect(await surface.privacyFor([MIRA], writer)).toEqual({ writer: 'job' });
});

it('uses each surface’s invitation authority and excludes the principal and assistant from the shared invitees', async () => {
  const onlyWritten = 'remy@friends.example';
  await recordThreadAddresses(thread, [onlyWritten], 'written', new Date().toISOString());
  const email = await reads.viewOf(emailSession);
  const spoken = await reads.viewOf(chatSession);
  expect(await reads.inviteesOf(undefined, email)).toEqual([MIRA]);
  expect(await reads.inviteesOf(undefined, spoken)).toEqual([MIRA]);
  expect(await reads.inviteesOf([onlyWritten], email)).toEqual([onlyWritten]);
  await expect(reads.inviteesOf([onlyWritten], spoken)).rejects.toThrow('current members');
  await expect(reads.inviteesOf(['nobody@outside.example'], email)).rejects.toThrow('is not on this thread');
});

it('names every taken time without exposing the events in the shared availability refusal', async () => {
  calendar.put({
    calendarId: PRINCIPAL,
    id: 'personal-busy',
    summary: 'Private therapy',
    start: { dateTime: '2026-10-20T12:00:00Z' },
    end: { dateTime: '2026-10-20T13:00:00Z' },
  });
  calendar.put({
    calendarId: TEAM,
    id: 'booking-busy',
    summary: 'Private review',
    start: { dateTime: '2026-10-20T14:00:00Z' },
    end: { dateTime: '2026-10-20T15:00:00Z' },
  });
  const spans = [
    { start: Date.parse('2026-10-20T12:00:00Z'), end: Date.parse('2026-10-20T12:30:00Z') },
    { start: Date.parse('2026-10-20T14:00:00Z'), end: Date.parse('2026-10-20T14:30:00Z') },
  ];
  for (const session of [emailSession, chatSession]) {
    const view = await reads.viewOf(session);
    await expect(reads.assertAvailable(view, TEAM, spans, new Set())).rejects.toThrow(
      'Tuesday, Oct 20, 12:00–12:30 PM UTC; Tuesday, Oct 20, 2:00–2:30 PM UTC: no longer free. Call free_time for times to offer instead.',
    );
    await expect(
      reads.assertAvailable(view, TEAM, spans, new Set(['personal-busy', 'booking-busy'])),
    ).resolves.toBeUndefined();
  }
});

it('refreshes the platform roster before entering the chat wrapper and authorizing a write', async () => {
  platformMembers([{ key: 'whatsapp:11', name: 'Juno', isPrincipal: true }]);
  const action = reads.bound(
    async (_content, _session, _requestId, view) => ({ invitees: await reads.inviteesOf([MIRA], view) }),
    [],
    true,
  );
  await expect(action({}, chatSession, 'refresh-first')).rejects.toThrow('current members');
  expect(calendar.calls).toBe(0);
});
