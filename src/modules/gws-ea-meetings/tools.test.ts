/**
 * external-email's scheduling tools (KTD7; R69, R70, R71; AE67, AE68):
 * `free_time`, `hold`, `book`, `change_booking` and `cancel_booking`, each
 * bound to the email thread whose session calls it, and the timer that
 * releases lapsed holds.
 *
 * Drives the real delivery actions, guard, thread map, preferences, privacy
 * check and session DBs against an in-memory Google Calendar. Only the
 * container runtime and its wake are mocked, and the clock is fixed so
 * weekdays are known.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-scheduling-tools';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-scheduling-tools',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-scheduling-tools/groups',
  };
});

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

const google = vi.hoisted(() => ({ calendar: undefined as unknown }));
vi.mock('./calendar-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./calendar-api.js')>();
  const { delegatingCalendarApi } = await import('./testing/fake-calendar.js');
  return {
    ...actual,
    createMeetingsCalendarApi: () =>
      delegatingCalendarApi(() => google.calendar as import('./calendar-api.js').MeetingsCalendarApi),
  };
});

import type { ResponseFrame } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { sqliteRaw } from '../../db/drivers/sqlite.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDeliveryAction } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../permissions/index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import '../gws-ea-profile/index.js';
import {
  addPrincipalAddress,
  bindVerifiedPrincipalUser,
  recordExternalEmailAgentGroupId,
} from '../gws-ea-profile/db.js';
import '../gws-ea-preferences/index.js';
import { setSchedulingPreference } from '../gws-ea-preferences/db.js';
import '../gws-ea-privacy/index.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import '../gws-ea-people/index.js';
import { addPerson, forgetPerson } from '../gws-ea-people/db.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { getSession } from '../../db/sessions.js';
import '../gws-ea-inbox/index.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { replacePrincipalCalendars } from '../gws-ea-inbox/db.js';
import { createThread, recordThreadAddresses, threadAddresses } from '../gws-ea-inbox/thread-map.js';
import { releaseExpiredHolds } from './index.js';
import { FITS } from './slots.js';
import { FakeCalendar, type StoredEvent } from './testing/fake-calendar.js';
import { deleteThreadHold, listThreadHolds, recordThreadHold, setThreadBookingCalendar } from './thread-calendar.js';

const JUNO = 'juno@northwind.example';
const PRINCIPAL = 'pat@northwind.example';
/** Another of the principal's calendars, which the assistant reads but never books on. */
const PERSONAL = 'pat.personal@northwind.example';
const TEAM = 'team@group.calendar.google.com';
const PRINCIPAL_USER = 'gchat:users/pat';
const REMY = 'remy@friends.example';
const JANE = 'jane@friends.example';
const STRANGER = 'someone@else.example';
const LONDON = 'Europe/London';
/** main's own zone, an hour ahead of the principal's: main reads its booking facts in it. */
const PARIS = 'Europe/Paris';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Monday 5 October 2026, 08:00 in London (BST, UTC+1). */
const NOW = new Date('2026-10-05T07:00:00.000Z');
/** Tuesday 6 October 00:00 to the end of Thursday 8 October, London. */
const RANGE = { from: '2026-10-06T00:00:00+01:00', to: '2026-10-09T00:00:00+01:00' };
const TUESDAY_10AM = '2026-10-06T09:00:00.000Z';
const WEDNESDAY_10AM = '2026-10-07T09:00:00.000Z';
const THURSDAY_10AM = '2026-10-08T09:00:00.000Z';
const THURSDAY_2PM = '2026-10-08T13:00:00.000Z';
/** Tuesday 15:00 to 17:00 in London, which the principal protects. */
const PROTECTED = { start: Date.parse('2026-10-06T14:00:00.000Z'), end: Date.parse('2026-10-06T16:00:00.000Z') };
const PROTECTED_REASON = 'Therapy with Dr Reyes';

let calendar: FakeCalendar;
let main: Session;
let threadA: string;
let threadB: string;
let sessionA: Session;
let sessionB: Session;

function now(): string {
  return new Date().toISOString();
}

let requests = 0;

/** Send one request as the runner's tool would, and read the host's one answer. */
async function send(
  session: Session,
  action: string,
  fields: Record<string, unknown>,
  requestId = `act-test-${++requests}`,
): Promise<ResponseFrame> {
  const handler = getDeliveryAction(action);
  if (!handler) throw new Error(`${action} is not a registered delivery action`);
  await handler({ ...fields, action, requestId }, session);
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const rows = db.prepare('SELECT content FROM messages_in WHERE id = ?').all(`action-resp-${requestId}`) as Array<{
    content: string;
  }>;
  db.close();
  expect(rows).toHaveLength(1);
  return (JSON.parse(rows[0].content) as { frame: ResponseFrame }).frame;
}

function data(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(`refused: ${frame.error.message}`);
  return frame.data as Record<string, unknown>;
}

function refusal(frame: ResponseFrame): string {
  if (frame.ok) throw new Error(`accepted: ${JSON.stringify(frame.data)}`);
  return frame.error.message;
}

interface Free {
  readonly start: string;
  readonly end: string;
  readonly principal_time: string;
  readonly their_time?: string;
  readonly fit: string;
}

/** What main heard, in order: here, only the facts of bookings. */
function mainHeard(): string[] {
  const db = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
  const rows = db.prepare('SELECT content FROM messages_in ORDER BY seq').all() as Array<{ content: string }>;
  db.close();
  return rows.map((row) => (JSON.parse(row.content) as { text: string }).text);
}

function live(role: 'hold' | 'booking'): StoredEvent[] {
  return calendar.live(PRINCIPAL).filter((event) => event.tags?.gwsEaRole === role);
}

/** The principal on an event of theirs, as Google lists the organizer of an event they made themselves. */
const PRINCIPAL_GUEST = { email: PRINCIPAL, responseStatus: 'accepted', organizer: true };

/** Who an event invites: every guest but its organizer, the principal. */
function invited(event: StoredEvent | undefined): string[] | undefined {
  return event?.attendees?.flatMap((attendee) =>
    attendee.organizer === true || attendee.email === undefined ? [] : [attendee.email],
  );
}

/** The principal's own meeting, with text the other side must never see. */
function busy(id: string, start: string, end: string): StoredEvent {
  return {
    calendarId: PRINCIPAL,
    id,
    status: 'confirmed',
    summary: 'Board review: acquisition of Contoso',
    organizer: { email: PRINCIPAL },
    start: { dateTime: start },
    end: { dateTime: end },
  };
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}

/** An email thread with these people on it, and external-email's session for it. */
async function thread(addresses: readonly string[]): Promise<{ key: string; session: Session }> {
  const { threadKey } = await createThread(null, now());
  await recordThreadAddresses(threadKey, addresses, 'message', now());
  const { session } = await resolveSession('ag-external', 'mg-inbox', threadKey, 'per-thread');
  return { key: threadKey, session };
}

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());

  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
  }
  await ensureContainerConfig('ag-main');
  await updateContainerConfigScalars('ag-main', { timezone: PARIS });
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: 'gchat',
    platform_id: 'spaces/dm',
    name: 'dm',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-inbox',
    channel_type: 'email',
    platform_id: 'email:inbox',
    name: 'Inbox',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await upsertUser({ id: PRINCIPAL_USER, kind: 'gchat', display_name: 'Pat', created_at: now() });
  await bindVerifiedPrincipalUser(PRINCIPAL_USER, now());
  await upsertUserDm({
    user_id: PRINCIPAL_USER,
    channel_type: 'gchat',
    messaging_group_id: 'mg-dm',
    resolved_at: now(),
  });
  await getDb().run(
    `UPDATE gws_ea_profile
        SET main_agent_group_id = 'ag-main', assistant_display_name = 'Juno', assistant_workspace_email = ?,
            principal_display_name = 'Pat Doe', principal_timezone = ?
      WHERE singleton = 1`,
    JUNO,
    LONDON,
  );
  await recordExternalEmailAgentGroupId('ag-external');
  await addPrincipalAddress(PRINCIPAL);
  await setSchedulingPreference({
    kind: 'protected-window',
    weekdays: ['tue'],
    start: '15:00',
    end: '17:00',
    reason: PROTECTED_REASON,
    source: 'principal',
    basis: 'said so',
  });
  await setSchedulingPreference({
    kind: 'preferred-time',
    meetingKind: 'default',
    weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    start: '09:00',
    end: '12:00',
    source: 'principal',
    basis: 'mornings are best for Pat',
  });

  calendar = new FakeCalendar();
  google.calendar = calendar;
  calendar.calendars.set(PRINCIPAL, {
    id: PRINCIPAL,
    accessRole: 'writer',
    summary: PRINCIPAL,
    conferenceTypes: ['hangoutsMeet'],
  });

  main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
  ({ key: threadA, session: sessionA } = await thread([REMY, JANE, PRINCIPAL, JUNO]));
  ({ key: threadB, session: sessionB } = await thread([JANE]));
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('the scheduling tools', () => {
  it('answer only external-email, from an email thread’s own session', async () => {
    const fromMain = await send(main, 'free_time', { ...RANGE, minutes: 30 });
    expect(fromMain.ok).toBe(false);
    expect(refusal(fromMain)).toMatch(/Only external-email/u);

    const { session: noThread } = await resolveSession('ag-external', 'mg-inbox', 'mail-not-a-thread', 'per-thread');
    expect(refusal(await send(noThread, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }))).toMatch(
      /not an email thread/u,
    );
    expect(live('hold')).toEqual([]);
  });
});

describe('free_time', () => {
  it("lists free windows in date order, inside both sides' waking day, labeled in both zones with a fixed fit note", async () => {
    // The principal is busy Wednesday 12:00 to 14:00 London.
    const taken = { start: Date.parse('2026-10-07T11:00:00Z'), end: Date.parse('2026-10-07T13:00:00Z') };
    calendar.put(busy('evt-wed', '2026-10-07T11:00:00Z', '2026-10-07T13:00:00Z'));

    const frame = await send(sessionA, 'free_time', { ...RANGE, minutes: 30, timezone: 'America/New_York' });
    const { windows, windows_not_listed, message } = data(frame) as {
      windows: Free[];
      windows_not_listed: number;
      message: string;
    };

    // New York wakes at 12:00 London, and Tuesday's protected afternoon and Wednesday's meeting are gone.
    expect(windows.map((free) => [free.principal_time, free.their_time, free.fit])).toEqual([
      ['Tuesday 6 Oct, 12:00–15:00 BST', 'Tuesday 6 Oct, 07:00–10:00 EDT', 'acceptable'],
      ['Tuesday 6 Oct, 17:00–22:00 BST', 'Tuesday 6 Oct, 12:00–17:00 EDT', 'outside usual hours'],
      ['Wednesday 7 Oct, 14:00–17:00 BST', 'Wednesday 7 Oct, 09:00–12:00 EDT', 'acceptable'],
      ['Wednesday 7 Oct, 17:00–22:00 BST', 'Wednesday 7 Oct, 12:00–17:00 EDT', 'outside usual hours'],
      ['Thursday 8 Oct, 12:00–17:00 BST', 'Thursday 8 Oct, 07:00–12:00 EDT', 'acceptable'],
      ['Thursday 8 Oct, 17:00–22:00 BST', 'Thursday 8 Oct, 12:00–17:00 EDT', 'outside usual hours'],
    ]);
    expect(windows_not_listed).toBe(0);
    for (const free of windows) {
      const span = { start: Date.parse(free.start), end: Date.parse(free.end) };
      expect(overlaps(span, PROTECTED), free.start).toBe(false);
      expect(overlaps(span, taken), free.start).toBe(false);
      expect(FITS).toContain(free.fit);
    }
    // Each line leads with the window on the principal's clock, with its offset, which the tools take back.
    expect(message.split('\n').slice(0, 2)).toEqual([
      "Free for 30 minutes: any start that ends by a window's end.",
      '- 2026-10-06T12:00+01:00 to 2026-10-06T15:00+01:00: Tuesday 6 Oct, 12:00–15:00 BST; for them, Tuesday 6 Oct, 07:00–10:00 EDT (acceptable)',
    ]);
    const [, firstLine] = message.split('\n');
    const firstStart = firstLine.slice('- '.length, firstLine.indexOf(' to '));
    const booked = data(
      await send(sessionA, 'book', { start: firstStart, minutes: 30, title: 'Catch-up', invitees: [REMY] }),
    );
    expect(booked.start).toBe(windows[0].start);

    // Free/busy only: neither the principal's event nor their preferences' words reach the thread.
    const answer = JSON.stringify(frame);
    for (const secret of ['Board review', 'Contoso', 'Therapy', 'Reyes', 'mornings are best']) {
      expect(answer).not.toContain(secret);
    }
  });

  it('lists a Pacific principal and a counterpart in Berlin the mornings they share', async () => {
    await getDb().run("UPDATE gws_ea_profile SET principal_timezone = 'America/Los_Angeles' WHERE singleton = 1");
    const { windows, windows_not_listed } = data(
      await send(sessionA, 'free_time', {
        from: '2026-10-05T00:00:00-07:00',
        to: '2026-10-13T00:00:00-07:00',
        minutes: 30,
        timezone: 'Europe/Berlin',
      }),
    ) as { windows: Free[]; windows_not_listed: number };
    // Berlin is nine hours ahead: its waking day ends at 13:00 in Los Angeles.
    const shown = windows.map((free) => [free.principal_time, free.their_time, free.fit]);
    expect(shown.slice(0, 3)).toEqual([
      ['Monday 5 Oct, 07:00–09:00 PDT', 'Monday 5 Oct, 16:00–18:00 CEST', 'outside usual hours'],
      ['Monday 5 Oct, 09:00–12:00 PDT', 'Monday 5 Oct, 18:00–21:00 CEST', 'preferred'],
      ['Monday 5 Oct, 12:00–13:00 PDT', 'Monday 5 Oct, 21:00–22:00 CEST', 'acceptable'],
    ]);
    expect(shown).toContainEqual([
      'Saturday 10 Oct, 07:00–13:00 PDT',
      'Saturday 10 Oct, 16:00–22:00 CEST',
      'outside usual hours',
    ]);
    expect(windows).toHaveLength(20);
    expect(windows_not_listed).toBe(0);
  });

  it('lists nothing inside protected time, even when the range asks only for that afternoon', async () => {
    const { windows } = data(
      await send(sessionA, 'free_time', {
        from: '2026-10-06T14:00:00+01:00',
        to: '2026-10-06T18:00:00+01:00',
        minutes: 30,
      }),
    ) as { windows: Free[] };
    expect(windows.map((free) => [free.principal_time, free.fit])).toEqual([
      ['Tuesday 6 Oct, 14:00–15:00 BST', 'acceptable'],
      ['Tuesday 6 Oct, 17:00–18:00 BST', 'outside usual hours'],
    ]);
  });

  it('says a weekend day is outside usual hours, and lists nothing at night', async () => {
    const { windows } = data(
      await send(sessionA, 'free_time', {
        from: '2026-10-10T00:00:00+01:00',
        to: '2026-10-11T00:00:00+01:00',
        minutes: 60,
      }),
    ) as { windows: Free[] };
    expect(windows).toEqual([
      {
        start: '2026-10-10T06:00:00.000Z',
        end: '2026-10-10T21:00:00.000Z',
        principal_time: 'Saturday 10 Oct, 07:00–22:00 BST',
        fit: 'outside usual hours',
      },
    ]);
  });

  it('lists time from now on, none already past and no notice asked beyond that', async () => {
    const { windows } = data(
      await send(sessionA, 'free_time', {
        from: '2026-10-05T00:00:00+01:00',
        to: '2026-10-05T10:00:00+01:00',
        minutes: 30,
      }),
    ) as { windows: Free[] };
    // It is 08:00 in London: 07:00 has passed.
    expect(windows.map((free) => [free.principal_time, free.fit])).toEqual([
      ['Monday 5 Oct, 08:00–09:00 BST', 'outside usual hours'],
      ['Monday 5 Oct, 09:00–10:00 BST', 'preferred'],
    ]);
  });

  it('lists about a week of windows from a long range, and says how many more there are', async () => {
    const { windows, windows_not_listed, message } = data(
      await send(sessionA, 'free_time', {
        from: '2026-10-06T00:00:00+01:00',
        to: '2026-11-05T00:00:00Z',
        minutes: 30,
      }),
    ) as { windows: Free[]; windows_not_listed: number; message: string };
    expect(windows).toHaveLength(24);
    expect(windows_not_listed).toBeGreaterThan(0);
    expect(message.split('\n').at(-1)).toBe(
      `${windows_not_listed} later windows are not listed: ask from the last one on for more.`,
    );
  });
});

describe('busy time on the principal’s other calendars', () => {
  it.each([
    { on: 'their primary calendar', bookingCalendar: null },
    { on: 'a calendar main named', bookingCalendar: TEAM },
  ])('is neither offered nor booked when the thread books on $on', async ({ bookingCalendar }) => {
    calendar.calendars.set(TEAM, { id: TEAM, accessRole: 'owner', dataOwner: PRINCIPAL, summary: 'Pat – work' });
    await setThreadBookingCalendar(threadA, bookingCalendar);
    await replacePrincipalCalendars([PRINCIPAL, PERSONAL], now());
    calendar.put({ ...busy('evt-personal', WEDNESDAY_10AM, '2026-10-07T09:30:00.000Z'), calendarId: PERSONAL });
    const taken = { start: Date.parse(WEDNESDAY_10AM), end: Date.parse('2026-10-07T09:30:00.000Z') };

    const { windows } = data(
      await send(sessionA, 'free_time', {
        from: '2026-10-07T09:00:00+01:00',
        to: '2026-10-07T12:00:00+01:00',
        minutes: 30,
      }),
    ) as { windows: Free[] };
    expect(windows.map((free) => free.principal_time)).toEqual([
      'Wednesday 7 Oct, 09:00–10:00 BST',
      'Wednesday 7 Oct, 10:30–12:00 BST',
    ]);
    for (const free of windows) {
      expect(overlaps({ start: Date.parse(free.start), end: Date.parse(free.end) }, taken), free.start).toBe(false);
    }
    expect(
      refusal(
        await send(sessionA, 'book', { start: WEDNESDAY_10AM, minutes: 30, title: 'Catch-up', invitees: [REMY] }),
      ),
    ).toMatch(/no longer free/u);
    expect(live('booking')).toEqual([]);
    expect(calendar.live(TEAM)).toEqual([]);
  });
});

describe('hold', () => {
  it('holds times as private busy events that lapse in three days, and holding new times releases the old', async () => {
    const held = data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM, WEDNESDAY_10AM], minutes: 30 }));
    expect(held.held).toHaveLength(2);
    expect(String(held.message).split('\n').slice(0, 3)).toEqual([
      'This thread now holds:',
      '- 2026-10-06T10:00+01:00: Tuesday 6 Oct, 10:00–10:30 BST',
      '- 2026-10-07T10:00+01:00: Wednesday 7 Oct, 10:00–10:30 BST',
    ]);
    expect(
      live('hold')
        .map((event) => event.start?.dateTime)
        .sort(),
    ).toEqual([TUESDAY_10AM, WEDNESDAY_10AM]);
    for (const event of live('hold')) {
      expect(event).toMatchObject({ visibility: 'private', transparency: 'opaque', reminders: 'none' });
      // The principal alone, accepted: Google lists them as the hold's organizer.
      expect(event.attendees).toEqual([PRINCIPAL_GUEST]);
      expect(event.tags).toEqual({ gwsEaRole: 'hold', gwsEaThread: threadA });
    }
    expect((await listThreadHolds(threadA)).map((hold) => hold.expiresAt)).toEqual([
      new Date(NOW.getTime() + 3 * DAY).toISOString(),
      new Date(NOW.getTime() + 3 * DAY).toISOString(),
    ]);
    expect(
      calendar.writes.filter((write) => write.op === 'insert').every((write) => write.sendUpdates === 'none'),
    ).toBe(true);

    data(await send(sessionA, 'hold', { starts: [THURSDAY_10AM], minutes: 30 }));
    expect(live('hold').map((event) => event.start?.dateTime)).toEqual([THURSDAY_10AM]);
    expect((await listThreadHolds(threadA)).map((hold) => hold.startAt)).toEqual([THURSDAY_10AM]);

    data(await send(sessionA, 'hold', { starts: [] }));
    expect(live('hold')).toEqual([]);
    expect(await listThreadHolds(threadA)).toEqual([]);
  });

  it('holds a time again without rewriting it, but lists the principal, accepted, on a hold that lacks them', async () => {
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }));
    const [first] = live('hold');
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }));
    expect(calendar.writes.filter((write) => write.op === 'patch')).toEqual([]);

    // A hold an earlier release placed lists nobody: holding its time again adds the principal.
    calendar.put({ ...first, attendees: undefined });
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }));
    expect(calendar.event(PRINCIPAL, first.id)?.attendees).toEqual([PRINCIPAL_GUEST]);
    expect(calendar.writes.at(-1)).toMatchObject({ op: 'patch', eventId: first.id, sendUpdates: 'none' });

    // One that lists them awaiting an answer gets theirs, accepted.
    calendar.put({ ...first, attendees: [{ ...PRINCIPAL_GUEST, responseStatus: 'needsAction' }] });
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }));
    expect(calendar.event(PRINCIPAL, first.id)?.attendees).toEqual([PRINCIPAL_GUEST]);
  });

  it('refuses a time that just became busy, or that another thread holds, and the refusal changes nothing', async () => {
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }));
    calendar.put(busy('evt-new', WEDNESDAY_10AM, '2026-10-07T10:00:00.000Z'));

    expect(refusal(await send(sessionA, 'hold', { starts: [WEDNESDAY_10AM], minutes: 30 }))).toMatch(/no longer free/u);
    expect(refusal(await send(sessionB, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }))).toMatch(/no longer free/u);
    expect(live('hold').map((event) => event.start?.dateTime)).toEqual([TUESDAY_10AM]);
    expect((await listThreadHolds(threadA)).map((hold) => hold.startAt)).toEqual([TUESDAY_10AM]);

    // Holding its own time again is not a conflict with itself, and never lets the time go free on the way.
    const [held] = live('hold');
    const writes = calendar.writes.length;
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }));
    expect(live('hold').map((event) => event.id)).toEqual([held.id]);
    expect(calendar.writes.slice(writes).filter((write) => write.op === 'delete')).toEqual([]);
  });

  it('refuses a protected time, and more than three', async () => {
    expect(refusal(await send(sessionA, 'hold', { starts: ['2026-10-06T14:30:00.000Z'], minutes: 30 }))).toMatch(
      /protected/u,
    );
    expect(
      refusal(
        await send(sessionA, 'hold', {
          starts: [TUESDAY_10AM, WEDNESDAY_10AM, THURSDAY_10AM, THURSDAY_2PM],
          minutes: 30,
        }),
      ),
    ).toMatch(/up to 3/u);
    expect(live('hold')).toEqual([]);
  });
});

describe('a hold lapses (AE68)', () => {
  it('is deleted three days after it was last held, while one held again lasts three days from then', async () => {
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }));
    data(await send(sessionB, 'hold', { starts: [WEDNESDAY_10AM], minutes: 30 }));

    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }));

    vi.setSystemTime(new Date(NOW.getTime() + 3 * DAY - 60_000));
    await releaseExpiredHolds();
    expect(live('hold')).toHaveLength(2);

    vi.setSystemTime(new Date(NOW.getTime() + 3 * DAY + 60_000));
    await releaseExpiredHolds();
    expect(live('hold').map((event) => event.tags?.gwsEaThread)).toEqual([threadA]);
    expect(await listThreadHolds(threadB)).toEqual([]);

    vi.setSystemTime(new Date(NOW.getTime() + 4 * DAY + 60_000));
    await releaseExpiredHolds();
    expect(live('hold')).toEqual([]);
    expect(await listThreadHolds(threadA)).toEqual([]);
    expect(
      calendar.writes.filter((write) => write.op === 'delete').every((write) => write.sendUpdates === 'none'),
    ).toBe(true);
  });

  it('takes its turn with the calendar writes, so a hold its thread holds again as it lapses is never released from under it', async () => {
    const nextMonday = '2026-10-12T09:00:00.000Z';
    data(await send(sessionA, 'hold', { starts: [nextMonday], minutes: 30 }));
    vi.setSystemTime(new Date(NOW.getTime() + 3 * DAY + 60_000));
    // The sweep has read the lapsed hold and is waiting on Google when the thread holds the time again.
    let arrived = (): void => undefined;
    let open = (): void => undefined;
    const atGoogle = new Promise<void>((resolve) => (arrived = resolve));
    const opened = new Promise<void>((resolve) => (open = resolve));
    const getEvent = calendar.getEvent.bind(calendar);
    vi.spyOn(calendar, 'getEvent').mockImplementationOnce(async (calendarId, eventId) => {
      arrived();
      await opened;
      return getEvent(calendarId, eventId);
    });
    const sweeping = releaseExpiredHolds();
    await atGoogle;
    const holding = send(sessionA, 'hold', { starts: [nextMonday], minutes: 30 });
    // Time enough for the hold to finish, were it not waiting for the sweep's turn to end.
    await Promise.race([holding, new Promise((resolve) => setTimeout(resolve, 250))]);
    open();
    await sweeping;
    data(await holding);

    expect(live('hold').map((event) => event.start?.dateTime)).toEqual([nextMonday]);
    expect((await listThreadHolds(threadA)).map((hold) => hold.expiresAt)).toEqual([
      new Date(NOW.getTime() + 6 * DAY + 60_000).toISOString(),
    ]);
  });

  it('forgets a lapsed hold’s record only while it is still lapsed', async () => {
    const lapses = '2026-10-08T07:00:00.000Z';
    await recordThreadHold({
      threadKey: threadA,
      calendarId: PRINCIPAL,
      eventId: 'held-again',
      startAt: TUESDAY_10AM,
      endAt: '2026-10-06T09:30:00.000Z',
      expiresAt: lapses,
    });
    await deleteThreadHold(PRINCIPAL, 'held-again', '2026-10-08T06:59:00.000Z');
    expect((await listThreadHolds(threadA)).map((hold) => hold.eventId)).toEqual(['held-again']);
    await deleteThreadHold(PRINCIPAL, 'held-again', lapses);
    expect(await listThreadHolds(threadA)).toEqual([]);
  });

  it('releases a hold converted from an earlier release by its record and role tag, and leaves an event that lost the tag', async () => {
    calendar.put({
      calendarId: PRINCIPAL,
      id: 'slice2hold',
      status: 'confirmed',
      start: { dateTime: TUESDAY_10AM },
      end: { dateTime: '2026-10-06T09:30:00.000Z' },
      tags: {
        gwsEaMeeting: 'mtg-00000000-0000-0000-0000-000000000001',
        gwsEaRole: 'hold',
        gwsEaSlot: 'slot-0123456789ab',
      },
    });
    calendar.put(busy('retagged', WEDNESDAY_10AM, '2026-10-07T09:30:00.000Z'));
    for (const eventId of ['slice2hold', 'retagged']) {
      await getDb().run(
        `INSERT INTO gws_ea_thread_holds (thread_key, calendar_id, event_id, start_at, end_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        threadA,
        PRINCIPAL,
        eventId,
        TUESDAY_10AM,
        '2026-10-06T09:30:00.000Z',
        new Date(NOW.getTime() - 60_000).toISOString(),
      );
    }

    await releaseExpiredHolds();
    expect(calendar.event(PRINCIPAL, 'slice2hold')?.status).toBe('cancelled');
    expect(calendar.event(PRINCIPAL, 'retagged')?.status).toBe('confirmed');
    expect(await listThreadHolds(threadA)).toEqual([]);
  });
});

describe('book', () => {
  it('creates the event inviting only people on the thread, releases the thread’s holds, and tells main', async () => {
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM, WEDNESDAY_10AM], minutes: 30 }));

    const booked = data(
      await send(sessionA, 'book', {
        start: TUESDAY_10AM,
        minutes: 30,
        title: 'Coffee: Pat and Remy',
        notes: 'At the usual place.',
        video_call: true,
        invitees: [REMY],
      }),
    );

    const [event] = live('booking');
    expect(event).toMatchObject({
      summary: 'Coffee: Pat and Remy',
      description: 'At the usual place.',
      start: { dateTime: TUESDAY_10AM },
      end: { dateTime: '2026-10-06T09:30:00.000Z' },
      tags: { gwsEaRole: 'booking', gwsEaThread: threadA },
    });
    // The principal first, accepted, as its organizer; the invitee awaits their own answer.
    expect(event.attendees).toEqual([PRINCIPAL_GUEST, { email: REMY, responseStatus: 'needsAction' }]);
    expect(event.conference?.status).toBe('success');
    expect(booked.booking).toBe(event.id);
    expect(booked.message).toMatch(
      new RegExp(
        `This thread's holds are released\\. main hears of it\\. To change or cancel it, give booking ${event.id}\\.$`,
        'u',
      ),
    );
    expect(calendar.writes.find((write) => write.eventId === event.id)?.sendUpdates).toBe('all');
    expect(live('hold')).toEqual([]);
    expect(await listThreadHolds(threadA)).toEqual([]);

    const [fact] = mainHeard();
    expect(
      fact.startsWith(
        `Booked a meeting with ${REMY} for Tuesday 6 Oct, 11:00–11:30 CEST (30 minutes), by video call. ` +
          'Google sent them the invitation. Its title, as written in the thread:\n<<<EXTERNAL_UNTRUSTED_CONTENT',
      ),
      fact,
    ).toBe(true);
    // The title external-email wrote reaches main only inside the untrusted frame; the ids main acts on come last.
    expect(fact.indexOf('Coffee: Pat and Remy')).toBeGreaterThan(fact.indexOf('<<<EXTERNAL_UNTRUSTED_CONTENT'));
    expect(fact).toMatch(
      new RegExp(
        `\\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>\\n\\(thread ${threadA}; event ${event.id} on calendar ${PRINCIPAL}\\)$`,
        'u',
      ),
    );
  });

  it('answers with the time ready to write in both zones, and refuses notes whose weekday and date disagree, writing nothing', async () => {
    const booked = data(
      await send(sessionA, 'book', {
        start: TUESDAY_10AM,
        minutes: 30,
        title: 'Catch-up',
        invitees: [REMY],
        timezone: 'America/New_York',
      }),
    );
    expect(booked.message).toMatch(
      /^Booked: Tuesday 6 Oct, 10:00–10:30 BST; for them, Tuesday 6 Oct, 05:00–05:30 EDT\. /u,
    );

    const misdated = await send(sessionB, 'book', {
      start: THURSDAY_2PM,
      minutes: 30,
      title: 'Catch-up',
      notes: 'See you Friday 8 October.',
      invitees: [JANE],
    });
    expect(refusal(misdated)).toBe(
      'The booking was not made: it says "Friday 8 October", but 8 October 2026 is a Thursday. Work the day out with the time tools and write it again; give the year when you mean another one, and put words you quote from someone else in quotation marks.',
    );
    expect(live('booking')).toHaveLength(1);
  });

  it('invites everyone on the thread but the principal and the assistant when it names nobody', async () => {
    data(await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Catch-up' }));
    expect(invited(live('booking')[0])?.sort()).toEqual([JANE, REMY]);
    // Without a Meet link, main hears of no video call.
    expect(mainHeard()[0]).toMatch(
      new RegExp(
        `^Booked a meeting with ${JANE} and ${REMY} for Tuesday 6 Oct, 11:00–11:30 CEST \\(30 minutes\\)\\. Google sent them the invitation\\. Its title`,
        'u',
      ),
    );
  });

  it('invites, when it names nobody, only the people in the conversation, not someone a sender only wrote about', async () => {
    const mentioned = 'sam@acme.example';
    const { key, session } = await thread([REMY]);
    await recordThreadAddresses(key, [mentioned], 'written', now());

    const unnamed = data(await send(session, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Catch-up' }));
    expect(invited(calendar.event(PRINCIPAL, String(unnamed.booking)))).toEqual([REMY]);
    // Someone written about is still on the thread: the agent may invite them by name.
    const named = data(
      await send(session, 'book', { start: WEDNESDAY_10AM, minutes: 30, title: 'Catch-up', invitees: [mentioned] }),
    );
    expect(invited(calendar.event(PRINCIPAL, String(named.booking)))).toEqual([mentioned]);
  });

  it('refuses an invitee who is not on the thread', async () => {
    expect(
      refusal(
        await send(sessionA, 'book', {
          start: TUESDAY_10AM,
          minutes: 30,
          title: 'Catch-up',
          invitees: [REMY, STRANGER],
        }),
      ),
    ).toMatch(new RegExp(`${STRANGER} is not on this thread`, 'u'));
    expect(live('booking')).toEqual([]);
  });

  it('refuses a time neither free nor held by this thread', async () => {
    data(await send(sessionB, 'hold', { starts: [TUESDAY_10AM], minutes: 30 }));
    calendar.put(busy('evt-wed', WEDNESDAY_10AM, '2026-10-07T10:00:00.000Z'));

    for (const start of [TUESDAY_10AM, WEDNESDAY_10AM]) {
      expect(
        refusal(await send(sessionA, 'book', { start, minutes: 30, title: 'Catch-up', invitees: [REMY] })),
      ).toMatch(/no longer free/u);
    }
    expect(live('booking')).toEqual([]);
  });

  it('refuses a protected time a counterpart proposed, though free/busy shows it free', async () => {
    expect(
      refusal(
        await send(sessionA, 'book', {
          start: '2026-10-06T15:00:00.000Z',
          minutes: 30,
          title: 'Catch-up',
          invitees: [REMY],
        }),
      ),
    ).toMatch(/protected/u);
    expect(live('booking')).toEqual([]);
  });

  it.each([
    { carrier: 'title', fields: { title: 'Catch-up at 12 Rosewood Lane' } },
    { carrier: 'notes', fields: { notes: 'Come round to 12 Rosewood Lane.' } },
    { carrier: 'place', fields: { location: '12 Rosewood Lane' } },
    { carrier: 'calendar name', fields: {}, calendarName: 'Pat – 12 Rosewood Lane' },
  ])(
    'refuses an invitation whose $carrier carries a private value, writing nothing',
    async ({ fields, calendarName }) => {
      await addPrivateValue({ label: 'Home', kind: 'address', value: '12 Rosewood Lane' });
      // Invitees see the name of the calendar the event is on.
      if (calendarName !== undefined) {
        calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer', summary: calendarName });
      }
      const answer = refusal(
        await send(sessionA, 'book', {
          start: TUESDAY_10AM,
          minutes: 30,
          title: 'Catch-up',
          invitees: [REMY],
          ...fields,
        }),
      );
      expect(answer).toMatch(/private details \(address\)/u);
      expect(answer).not.toContain('Rosewood');
      expect(calendar.writes).toEqual([]);
    },
  );

  it('leaves no half-made event when Google fails, and the agent sees the failure', async () => {
    calendar.failNext({ op: 'insert', error: new GoogleApiError(503, 'Backend Error'), afterApplying: true });

    const frame = await send(sessionA, 'book', {
      start: TUESDAY_10AM,
      minutes: 30,
      title: 'Catch-up',
      invitees: [REMY],
    });
    expect(frame).toMatchObject({ ok: false, error: { code: 'handler-error' } });
    expect(refusal(frame)).toMatch(/Backend Error/u);
    expect(live('booking')).toEqual([]);
    expect(await getDb().get('SELECT 1 FROM gws_ea_thread_bookings')).toBeUndefined();
    expect(mainHeard()).toEqual([]);
  });

  it('withdraws a booking whose record cannot be written, so no event is left that its thread cannot change', async () => {
    const raw = sqliteRaw(getDb());
    raw.exec(
      `CREATE TEMP TRIGGER no_booking_record BEFORE INSERT ON gws_ea_thread_bookings
       BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    const frame = await send(sessionA, 'book', {
      start: TUESDAY_10AM,
      minutes: 30,
      title: 'Catch-up',
      invitees: [REMY],
    });
    raw.exec('DROP TRIGGER no_booking_record');

    expect(frame).toMatchObject({ ok: false, error: { code: 'handler-error' } });
    expect(refusal(frame)).toMatch(/database is locked/u);
    expect(live('booking')).toEqual([]);
    expect(mainHeard()).toEqual([]);
  });

  it('books a time once when two threads ask for it at the same moment', async () => {
    const answers = await Promise.all([
      send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Catch-up', invitees: [REMY] }),
      send(sessionB, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Catch-up', invitees: [JANE] }),
    ]);

    expect(answers.filter((frame) => frame.ok)).toHaveLength(1);
    const refused = answers.flatMap((frame) => (frame.ok ? [] : [frame.error.message]));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/no longer free/u);
    expect(calendar.live(PRINCIPAL).filter((event) => event.start?.dateTime === TUESDAY_10AM)).toHaveLength(1);
  });

  it('books once when the same request is delivered again, answering the replay as it did the first', async () => {
    const request = { start: TUESDAY_10AM, minutes: 30, title: 'Catch-up', invitees: [REMY] };
    const first = data(await send(sessionA, 'book', request, 'act-replayed'));
    // The host keeps a request's first answer, so the replay's own is read only once that one is gone.
    const inbound = new Database(inboundDbPath(sessionA.agent_group_id, sessionA.id));
    inbound.prepare('DELETE FROM messages_in WHERE id = ?').run('action-resp-act-replayed');
    inbound.close();

    expect(data(await send(sessionA, 'book', request, 'act-replayed'))).toEqual(first);
    expect(live('booking').map((event) => event.id)).toEqual([first.booking]);
    expect(mainHeard()).toHaveLength(1);
  });

  it('goes on the calendar main named for the thread, and refuses one the assistant cannot write to', async () => {
    calendar.calendars.set(TEAM, { id: TEAM, accessRole: 'owner', dataOwner: PRINCIPAL, summary: 'Pat – work' });
    await setThreadBookingCalendar(threadA, TEAM);
    data(await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Catch-up', invitees: [REMY] }));
    expect(calendar.live(TEAM)).toHaveLength(1);

    calendar.calendars.set('shared@group.calendar.google.com', {
      id: 'shared@group.calendar.google.com',
      accessRole: 'reader',
      dataOwner: PRINCIPAL,
    });
    await setThreadBookingCalendar(threadA, 'shared@group.calendar.google.com');
    expect(
      refusal(
        await send(sessionA, 'book', { start: WEDNESDAY_10AM, minutes: 30, title: 'Catch-up', invitees: [REMY] }),
      ),
    ).toMatch(/cannot write to the calendar main named/u);
  });

  it('goes on the principal’s primary calendar alone: refused, never placed on another of theirs, when it cannot be written to', async () => {
    // A second address, given later: its calendar is the principal's, but not their primary one.
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await addPrincipalAddress(PERSONAL);
    calendar.calendars.set(PERSONAL, { id: PERSONAL, accessRole: 'owner', summary: PERSONAL });
    calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'reader', summary: PRINCIPAL });

    for (const [action, fields] of [
      ['hold', { starts: [TUESDAY_10AM], minutes: 30 }],
      ['book', { start: TUESDAY_10AM, minutes: 30, title: 'Catch-up', invitees: [REMY] }],
    ] as const) {
      expect(refusal(await send(sessionA, action, fields))).toMatch(
        /cannot write to the principal's primary calendar/u,
      );
    }
    expect(calendar.writes).toEqual([]);
  });
});

describe('a booking changes and is cancelled only by its own thread (AE67)', () => {
  it('moves at their request, in place, and main hears; a second meeting weeks later is a new event', async () => {
    const first = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 45, title: 'Intro', invitees: [REMY] }),
    );

    const moved = data(await send(sessionA, 'change_booking', { booking: first.booking, start: THURSDAY_2PM }));
    expect(moved).toMatchObject({ booking: first.booking, start: THURSDAY_2PM, end: '2026-10-08T13:45:00.000Z' });
    expect(moved.message).toBe(
      'Changed: Thursday 8 Oct, 14:00–14:45 BST. Google sends the invitees the update, and main hears of it.',
    );
    expect(calendar.event(PRINCIPAL, String(first.booking))).toMatchObject({
      start: { dateTime: THURSDAY_2PM },
      end: { dateTime: '2026-10-08T13:45:00.000Z' },
      summary: 'Intro',
    });
    expect(calendar.writes.at(-1)).toMatchObject({ op: 'patch', eventId: first.booking, sendUpdates: 'all' });
    // The principal stays on it, accepted; main hears of the invitee alone.
    expect(calendar.event(PRINCIPAL, String(first.booking))?.attendees).toEqual([
      PRINCIPAL_GUEST,
      { email: REMY, responseStatus: 'needsAction' },
    ]);
    expect(mainHeard().at(-1)).toBe(
      `Rescheduled the meeting with ${REMY} to Thursday 8 Oct, 15:00–15:45 CEST (45 minutes), from Tuesday 6 Oct, 11:00–11:45 CEST. ` +
        `Google sent them the update. (thread ${threadA}; event ${String(first.booking)} on calendar ${PRINCIPAL})`,
    );

    vi.setSystemTime(new Date(NOW.getTime() + 21 * DAY));
    const second = data(
      await send(sessionA, 'book', {
        start: '2026-10-27T10:00:00.000Z',
        minutes: 30,
        title: 'Follow-up',
        invitees: [REMY],
      }),
    );
    expect(second.booking).not.toBe(first.booking);
    expect(
      live('booking')
        .map((event) => event.summary)
        .sort(),
    ).toEqual(['Follow-up', 'Intro']);
  });

  it('changes what the invitation says and adds a Meet link, keeping its time, and main reads the new title as untrusted', async () => {
    const booked = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] }),
    );

    const changed = data(
      await send(sessionA, 'change_booking', {
        booking: booked.booking,
        title: 'Intro: Pat and Remy',
        location: 'Their office',
        notes: 'Bring the pilot plan.',
        video_call: true,
      }),
    );
    const event = calendar.event(PRINCIPAL, String(booked.booking));
    expect(event).toMatchObject({
      summary: 'Intro: Pat and Remy',
      location: 'Their office',
      description: 'Bring the pilot plan.',
      start: { dateTime: TUESDAY_10AM },
      conference: { status: 'success' },
    });
    expect(changed.message).toMatch(/^Changed: Tuesday 6 Oct, 10:00–10:30 BST, with a Google Meet link \(https:/u);
    const [patch] = calendar.writes.filter((write) => write.op === 'patch');
    expect(patch).toMatchObject({ eventId: booked.booking, sendUpdates: 'all' });
    expect(patch.fields?.start).toBeUndefined();

    const fact = mainHeard().at(-1) ?? '';
    expect(
      fact.startsWith(
        `Changed the meeting with ${REMY} on Tuesday 6 Oct, 11:00–11:30 CEST: a new title, place, notes, and Google Meet link. ` +
          'Google sent them the update. Its new title, as written in the thread:\n<<<EXTERNAL_UNTRUSTED_CONTENT',
      ),
      fact,
    ).toBe(true);
    expect(fact.indexOf('Intro: Pat and Remy')).toBeGreaterThan(fact.indexOf('<<<EXTERNAL_UNTRUSTED_CONTENT'));
    expect(fact.endsWith(`>>>\n(thread ${threadA}; event ${String(booked.booking)} on calendar ${PRINCIPAL})`)).toBe(
      true,
    );
  });

  it('refuses new text carrying a private value, as the invitees would see it, and a Meet link the calendar does not allow, writing nothing', async () => {
    const booked = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] }),
    );
    await addPrivateValue({ label: 'Home', kind: 'address', value: '12 Rosewood Lane' });
    const writes = calendar.writes.length;

    for (const fields of [{ location: '12 Rosewood Lane' }, { notes: 'Come round to 12 Rosewood Lane.' }]) {
      const answer = refusal(await send(sessionA, 'change_booking', { booking: booked.booking, ...fields }));
      expect(answer).toMatch(/^The booking was not changed: .*private details \(address\)/u);
      expect(answer).not.toContain('Rosewood');
    }
    // Invitees see the name of the calendar the event is on, beside the new title.
    calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer', summary: 'Pat – 12 Rosewood Lane' });
    expect(refusal(await send(sessionA, 'change_booking', { booking: booked.booking, title: 'Catch-up' }))).toMatch(
      /private details \(address\)/u,
    );
    expect(refusal(await send(sessionA, 'change_booking', { booking: booked.booking, video_call: true }))).toMatch(
      /does not allow Google Meet links/u,
    );
    expect(calendar.writes).toHaveLength(writes);
    expect(calendar.event(PRINCIPAL, String(booked.booking))).toMatchObject({ summary: 'Intro' });
    expect(mainHeard()).toHaveLength(1);
  });

  it('asks for a change, and writes nothing when the booking already says it', async () => {
    const booked = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] }),
    );
    const writes = calendar.writes.length;

    expect(refusal(await send(sessionA, 'change_booking', { booking: booked.booking }))).toMatch(
      /at least one change/u,
    );
    expect(data(await send(sessionA, 'change_booking', { booking: booked.booking, start: TUESDAY_10AM })).message).toBe(
      'The booking already stands at Tuesday 6 Oct, 10:00–10:30 BST: nothing changed.',
    );
    expect(calendar.writes).toHaveLength(writes);
    expect(mainHeard()).toHaveLength(1);
  });

  it('keeps the thread’s holds, but for one the booking now sits on', async () => {
    const booked = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] }),
    );
    data(await send(sessionA, 'hold', { starts: [WEDNESDAY_10AM, THURSDAY_10AM], minutes: 30 }));

    data(await send(sessionA, 'change_booking', { booking: booked.booking, start: WEDNESDAY_10AM }));
    expect(calendar.event(PRINCIPAL, String(booked.booking))?.start).toEqual({ dateTime: WEDNESDAY_10AM });
    expect(live('hold').map((event) => event.start?.dateTime)).toEqual([THURSDAY_10AM]);
    expect((await listThreadHolds(threadA)).map((hold) => hold.startAt)).toEqual([THURSDAY_10AM]);

    // A change that keeps its time leaves every hold where it is.
    data(await send(sessionA, 'change_booking', { booking: booked.booking, title: 'Intro, moved' }));
    expect(live('hold').map((event) => event.start?.dateTime)).toEqual([THURSDAY_10AM]);
  });

  it('refuses another thread’s booking, for a change and for a cancellation', async () => {
    const booked = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] }),
    );

    expect(refusal(await send(sessionB, 'change_booking', { booking: booked.booking, start: THURSDAY_2PM }))).toMatch(
      /This thread has no booking/u,
    );
    expect(refusal(await send(sessionB, 'cancel_booking', { booking: booked.booking }))).toMatch(
      /This thread has no booking/u,
    );
    expect(calendar.event(PRINCIPAL, String(booked.booking))).toMatchObject({
      status: 'confirmed',
      start: { dateTime: TUESDAY_10AM },
    });
  });

  it('refuses an event that lost its booking tag, for a change and for a cancellation', async () => {
    const booked = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] }),
    );
    const [event] = live('booking');
    calendar.put({ ...event, tags: { gwsEaThread: threadA } });
    const writes = calendar.writes.length;

    for (const [action, fields] of [
      ['change_booking', { booking: booked.booking, start: THURSDAY_2PM }],
      ['cancel_booking', { booking: booked.booking }],
    ] as const) {
      expect(refusal(await send(sessionA, action, fields))).toMatch(/no longer a booking this thread may change/u);
    }
    expect(calendar.writes).toHaveLength(writes);
    expect(calendar.event(PRINCIPAL, event.id)).toMatchObject({
      status: 'confirmed',
      start: { dateTime: TUESDAY_10AM },
    });
  });

  it('forgets a booking whose event was deleted from the calendar, refusing to change it', async () => {
    const booked = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] }),
    );
    const [event] = live('booking');
    calendar.put({ ...event, status: 'cancelled' });

    expect(refusal(await send(sessionA, 'change_booking', { booking: booked.booking, start: THURSDAY_2PM }))).toMatch(
      /no longer on the principal/u,
    );
    expect(await getDb().get('SELECT 1 FROM gws_ea_thread_bookings')).toBeUndefined();
  });

  it('refuses to move or lengthen it into protected or busy time', async () => {
    const booked = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] }),
    );
    calendar.put(busy('evt-thu', THURSDAY_2PM, '2026-10-08T14:00:00.000Z'));
    calendar.put(busy('evt-tue', '2026-10-06T09:45:00.000Z', '2026-10-06T10:15:00.000Z'));

    expect(
      refusal(await send(sessionA, 'change_booking', { booking: booked.booking, start: '2026-10-06T14:00:00.000Z' })),
    ).toMatch(/protected/u);
    expect(refusal(await send(sessionA, 'change_booking', { booking: booked.booking, start: THURSDAY_2PM }))).toMatch(
      /no longer free/u,
    );
    expect(refusal(await send(sessionA, 'change_booking', { booking: booked.booking, minutes: 60 }))).toMatch(
      /no longer free/u,
    );
    expect(calendar.event(PRINCIPAL, String(booked.booking))).toMatchObject({
      start: { dateTime: TUESDAY_10AM },
      end: { dateTime: '2026-10-06T09:30:00.000Z' },
    });
  });

  it('cancels with Google’s notice to the invitees, tells main, and forgets the booking', async () => {
    const booked = data(
      await send(sessionA, 'book', { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] }),
    );

    expect(data(await send(sessionA, 'cancel_booking', { booking: booked.booking })).message).toBe(
      'Cancelled: Tuesday 6 Oct, 10:00–10:30 BST. Google sends the invitees the cancellation, and main hears of it.',
    );
    expect(calendar.event(PRINCIPAL, String(booked.booking))?.status).toBe('cancelled');
    expect(calendar.writes.at(-1)).toMatchObject({ op: 'delete', sendUpdates: 'all' });
    expect(mainHeard()).toEqual([
      expect.stringMatching(/^Booked a meeting /u),
      `Cancelled the meeting with ${REMY} on Tuesday 6 Oct, 11:00–11:30 CEST. Google sent them the cancellation. ` +
        `(thread ${threadA}; event ${String(booked.booking)} on calendar ${PRINCIPAL})`,
    ]);
    expect(refusal(await send(sessionA, 'cancel_booking', { booking: booked.booking }))).toMatch(
      /This thread has no booking/u,
    );
  });

  it('books the same time again, after a cancellation, as a new event', async () => {
    const request = { start: TUESDAY_10AM, minutes: 30, title: 'Intro', invitees: [REMY] };
    const first = data(await send(sessionA, 'book', request));
    data(await send(sessionA, 'cancel_booking', { booking: first.booking }));

    const second = data(await send(sessionA, 'book', request));
    // Google keeps the cancelled event under its id: the new booking must not bring it back.
    expect(second.booking).not.toBe(first.booking);
    expect(calendar.events.map((event) => [event.id, event.status])).toEqual([
      [first.booking, 'cancelled'],
      [second.booking, 'confirmed'],
    ]);
  });
});

describe('forgetting a person', () => {
  /** The privacy check's record of a thread, as a refusal leaves it. */
  async function privacyRecord(threadKey: string): Promise<void> {
    await getDb().run(
      `INSERT INTO gws_ea_privacy_threads (channel_type, platform_id, thread_id, recent, refusals, stopped_at, updated_at)
       VALUES ('email', 'email:inbox', ?, '[]', 1, NULL, ?)`,
      threadKey,
      now(),
    );
  }

  async function privacyRecords(): Promise<string[]> {
    const rows = await getDb().all<{ thread_id: string }>(
      'SELECT thread_id FROM gws_ea_privacy_threads ORDER BY thread_id',
    );
    return rows.map((row) => row.thread_id);
  }

  async function addressesOf(threadKey: string): Promise<string[]> {
    return (await threadAddresses(threadKey)).map((entry) => entry.address).sort();
  }

  it("releases their threads' holds first, then purges those threads' sessions and privacy records, then their addresses", async () => {
    const secrets = path.join(TEST_DIR, 'secrets');
    fs.mkdirSync(secrets, { mode: 0o700 });
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(secrets, 'google-grant.json'));
    data(await send(sessionA, 'hold', { starts: [TUESDAY_10AM, WEDNESDAY_10AM], minutes: 30 }));
    data(await send(sessionB, 'hold', { starts: [THURSDAY_10AM], minutes: 30 }));
    await privacyRecord(threadA);
    await privacyRecord(threadB);
    const remy = await addPerson({
      name: 'Remy',
      level: 'close',
      source: 'principal',
      basis: 'a friend',
      identity: `email:${REMY}`,
    });

    // Holds go first: one that cannot go yet stops the forget, and nothing of theirs has gone.
    calendar.failure = new GoogleApiError(503, 'Calendar is unavailable');
    await expect(forgetPerson({ id: remy.id, source: 'principal' })).rejects.toThrow(/could not be released/u);
    calendar.failure = undefined;
    expect(await listThreadHolds(threadA)).toHaveLength(2);
    expect(await getSession(sessionA.id)).toBeDefined();
    expect(await privacyRecords()).toEqual([threadA, threadB].sort());
    expect(await addressesOf(threadA)).toContain(REMY);

    await forgetPerson({ id: remy.id, source: 'principal' });

    expect(await listThreadHolds(threadA)).toEqual([]);
    expect(live('hold').map((event) => event.start?.dateTime)).toEqual([THURSDAY_10AM]);
    expect(await getSession(sessionA.id)).toBeUndefined();
    expect(fs.existsSync(path.dirname(inboundDbPath(sessionA.agent_group_id, sessionA.id)))).toBe(false);
    expect(await getSession(sessionB.id)).toBeDefined();
    expect(await privacyRecords()).toEqual([threadB]);
    expect(await addressesOf(threadA)).toEqual([JANE, PRINCIPAL, JUNO].sort());
    expect(await addressesOf(threadB)).toEqual([JANE]);
    vi.unstubAllEnvs();
  });
});
