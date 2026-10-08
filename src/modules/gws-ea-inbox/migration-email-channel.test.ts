/**
 * The email channel's migration (KTD10, R77): the inbox registers it after
 * every earlier inbox and meetings table exists, it is portable like every
 * migration written after the async boundary, and it moves an earlier
 * release's in-flight work into the email channel's own records once, then
 * drops every earlier table.
 *
 * The conversion runs on a database the earlier release wrote, then the
 * converted work is driven through the real thread map, send ledger and
 * inbox poll against an in-memory Gmail and Calendar. Only the container
 * runtime and its wake are mocked.
 */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-email-channel-migration';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-email-channel-migration',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-email-channel-migration/groups',
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
vi.mock('../gws-ea-meetings/calendar-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gws-ea-meetings/calendar-api.js')>();
  const { delegatingCalendarApi } = await import('../gws-ea-meetings/testing/fake-calendar.js');
  return {
    ...actual,
    createMeetingsCalendarApi: () =>
      delegatingCalendarApi(() => google.calendar as import('../gws-ea-meetings/calendar-api.js').MeetingsCalendarApi),
  };
});

import type { ChannelSetup, InboundMessage } from '../../channels/adapter.js';
import { dispatch } from '../../cli/dispatch.js';
import { getDb } from '../../db/connection.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import type { DbDriver } from '../../db/driver.js';
import { sqliteRaw } from '../../db/drivers/sqlite.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb } from '../../db/index.js';
import { getRegisteredMigrations, runMigrations } from '../../db/migrations/index.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import { EXTERNAL_EMAIL_CAPABILITIES } from '../gws-ea-external-email/index.js';
import { FakeCalendar } from '../gws-ea-meetings/testing/fake-calendar.js';
import {
  addPrincipalAddress,
  bindVerifiedPrincipalUser,
  recordExternalEmailAgentGroupId,
} from '../gws-ea-profile/db.js';
import { createInbox, getInboxHealth, INBOX_PLATFORM_ID, type GmailApi, type GmailMessage } from './index.js';
import { gwsEaInboxEmailChannelMigration, MOVED_EXTERNAL_EMAIL_CAPABILITIES } from './migration-email-channel.js';
import { sendToOutside } from './outbound.js';
import type { InboxRuntime } from './runtime.js';
import { sendExactlyOnce, sendKey } from './send.js';
import { findThreadFor, threadMessages } from './thread-map.js';

/** The banned constructs of `src/db/migrations/portability.test.ts`, which covers built-in migrations only. */
const BANNED_PORTABLE_SQL = [
  /\bPRAGMA\b/i,
  /\bsqlite_master\b/i,
  /\bINSERT\s+OR\b/i,
  /\browid\b/i,
  /\bdatetime\s*\(/i,
  /\bstrftime\s*\(/i,
  /\bIS\s+\?/i,
];

const EMAIL_CHANNEL = 'module:gws-ea-inbox:email-channel';

const THREAD_TABLES = [
  'gws_ea_threads',
  'gws_ea_thread_messages',
  'gws_ea_thread_addresses',
  'gws_ea_thread_files',
  'gws_ea_thread_sends',
  'gws_ea_thread_holds',
  'gws_ea_thread_bookings',
];

/** What the inbox keeps from the earlier release: its state, the messages it saw, the senders' counts, the calendars. */
const KEPT_TABLES = [
  'gws_ea_inbox_state',
  'gws_ea_inbox_messages',
  'gws_ea_inbox_sender_counts',
  'gws_ea_inbox_calendars',
];

/** Every table of the earlier release's threads and meetings. */
const EARLIER_TABLES = [
  'gws_ea_inbox_threads',
  'gws_ea_inbox_thread_messages',
  'gws_ea_inbox_held',
  'gws_ea_inbox_principal_messages',
  'gws_ea_inbox_sends',
  'gws_ea_meetings',
  'gws_ea_meeting_counterparts',
  'gws_ea_meeting_requests',
  'gws_ea_meeting_outcomes',
  'gws_ea_meeting_slots',
  'gws_ea_meeting_bookings',
  'gws_ea_meeting_holds',
  'gws_ea_meeting_rooms',
];

const JUNO = 'juno@northwind.example';
const PRINCIPAL = 'pat@northwind.example';
const PRINCIPAL_USER = 'gchat:users/pat';
const REMY = 'remy@friends.example';
const SAM = 'sam@acme.example';
const LONDON = 'Europe/London';

/** Monday 5 October 2026, 08:00 in London. */
const NOW = new Date('2026-10-05T07:00:00.000Z');
const THREE_DAYS_ON = '2026-10-08T07:00:00.000Z';
/** Tuesday 6 October, 10:00 to 10:30 in London: a time the earlier release held for Remy. */
const HELD_START = '2026-10-06T09:00:00.000Z';
const HELD_END = '2026-10-06T09:30:00.000Z';

const OFFERED = 'mail-offered-a';
const BOOKED = 'mail-booked-b';
const MOVED = 'mail-reschedule-r';
const GONE = 'mail-gone-g';
const INBOUND = 'mail-inbound-c';
const COPY_IN = 'mail-copy-d';
const TAKEN = 'mail-copy-taken-e';

// ---------------------------------------------------------------------------
// A database the earlier release wrote
// ---------------------------------------------------------------------------

/** Every migration up to, and not including, the email channel's: the earlier release's schema. */
async function earlierRelease(): Promise<DbDriver> {
  const db = await initTestDb();
  await runMigrations(
    db,
    getRegisteredMigrations().filter((migration) => migration.name !== EMAIL_CHANNEL),
  );
  return db;
}

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await getDb().run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ...columns.map((column) => row[column]),
  );
}

async function earlierThread(
  threadKey: string,
  fields: {
    readonly origin: 'arrange' | 'ask_organizer' | 'copy-in' | 'inbound';
    readonly state: 'awaiting-arrange' | 'authorized' | 'open' | 'closed';
    readonly gmailThreadId: string;
    readonly to: readonly string[];
    readonly cc?: readonly string[];
    readonly vouched?: readonly string[];
    readonly messageIds?: readonly string[];
  },
): Promise<void> {
  const at = '2026-10-01T10:00:00.000Z';
  await insert('gws_ea_inbox_threads', {
    thread_key: threadKey,
    origin: fields.origin,
    state: fields.state,
    gmail_thread_id: fields.gmailThreadId,
    subject: 'Coffee',
    people_to: JSON.stringify(fields.to),
    people_cc: JSON.stringify(fields.cc ?? []),
    people_bcc: '[]',
    vouched_people: JSON.stringify(fields.vouched ?? []),
    session_id: null,
    created_at: at,
    updated_at: at,
  });
  for (const [index, rfcMessageId] of (fields.messageIds ?? []).entries()) {
    await insert('gws_ea_inbox_thread_messages', {
      rfc_message_id: rfcMessageId,
      thread_key: threadKey,
      position: index + 1,
      added_at: `2026-10-0${index + 1}T12:00:00.000Z`,
    });
  }
}

async function earlierMeeting(
  id: string,
  threadKey: string,
  kind: 'arrange' | 'reschedule',
  state: 'active' | 'booked',
): Promise<void> {
  const at = '2026-10-01T10:00:00.000Z';
  await insert('gws_ea_meetings', {
    id,
    kind,
    requested_by_session: 'sess-main',
    request_id: `req-${id}`,
    state,
    level: 'known',
    booking_calendar_id: PRINCIPAL,
    event_calendar_id: kind === 'reschedule' ? PRINCIPAL : null,
    event_id: kind === 'reschedule' ? 'principal-own-event' : null,
    length_minutes: 30,
    window_start: '2026-10-05T00:00:00.000Z',
    window_end: '2026-10-16T00:00:00.000Z',
    purpose: 'Coffee',
    thread_key: threadKey,
    brief_version: 0,
    created_at: at,
    updated_at: at,
  });
}

async function earlierHold(meetingId: string, eventId: string, start: string, end: string): Promise<void> {
  await insert('gws_ea_meeting_holds', {
    meeting_id: meetingId,
    slot_id: `slot-${eventId.slice(-12).padStart(12, '0')}`,
    calendar_id: PRINCIPAL,
    event_id: eventId,
    start_at: start,
    end_at: end,
    held_at: '2026-10-02T09:00:00.000Z',
  });
  calendar.put({
    calendarId: PRINCIPAL,
    id: eventId,
    status: 'confirmed',
    summary: 'Hold: coffee with Remy',
    transparency: 'opaque',
    start: { dateTime: start },
    end: { dateTime: end },
    tags: { gwsEaMeeting: meetingId, gwsEaRole: 'hold' },
  });
}

async function earlierBooking(meetingId: string, eventId: string): Promise<void> {
  await insert('gws_ea_meeting_bookings', {
    meeting_id: meetingId,
    calendar_id: PRINCIPAL,
    event_id: eventId,
    start_at: '2026-10-09T09:00:00.000Z',
    end_at: '2026-10-09T09:30:00.000Z',
    booked_at: '2026-10-03T09:00:00.000Z',
    invitation: null,
  });
}

/** The words of two of the assistant's emails in the offered thread: one Gmail took, one in flight. */
const SENT_WORDS = { text: 'Tuesday at ten works for Pat.' };
const PENDING_WORDS = { text: 'Shall I send an invitation?' };

/**
 * An earlier release's in-flight work: a thread offering held times, a booked
 * one, a reschedule of the principal's own event, holds for a thread its
 * inbox no longer has, an inbound thread with mail held for `main`, a
 * thread the principal copied the assistant into that `main` has not taken
 * over yet, and one it has.
 */
async function seedEarlierWork(): Promise<void> {
  await earlierThread(OFFERED, {
    origin: 'arrange',
    state: 'open',
    gmailThreadId: 'gt-a',
    to: [REMY],
    cc: [PRINCIPAL],
    vouched: [REMY, PRINCIPAL],
    messageIds: ['<a1@northwind.example>', '<a2@friends.example>', '<a3@northwind.example>', '<a4@northwind.example>'],
  });
  await earlierMeeting('mtg-a', OFFERED, 'arrange', 'active');
  await earlierHold('mtg-a', 'hold-a1', HELD_START, HELD_END);
  await earlierHold('mtg-a', 'hold-a2', '2026-10-07T09:00:00.000Z', '2026-10-07T09:30:00.000Z');
  await insert('gws_ea_meeting_slots', {
    meeting_id: 'mtg-a',
    slot_id: 'slot-000000000001',
    start_at: HELD_START,
    end_at: HELD_END,
    offered_at: '2026-10-02T09:00:00.000Z',
  });
  await insert('gws_ea_inbox_sends', {
    id: 'send-sent',
    thread_key: OFFERED,
    principal_message_id: null,
    content_hash: sendKey(OFFERED, SENT_WORDS),
    rfc_message_id: '<a3@northwind.example>',
    state: 'sent',
    gmail_message_id: 'g-a3',
    created_at: '2026-10-03T09:00:00.000Z',
    updated_at: '2026-10-03T09:00:01.000Z',
  });
  await insert('gws_ea_inbox_sends', {
    id: 'send-pending',
    thread_key: OFFERED,
    principal_message_id: null,
    content_hash: sendKey(OFFERED, PENDING_WORDS),
    rfc_message_id: '<a4@northwind.example>',
    state: 'pending',
    gmail_message_id: null,
    created_at: '2026-10-04T09:00:00.000Z',
    updated_at: '2026-10-04T09:00:00.000Z',
  });
  // A reply the earlier release sent to the principal alone: its action goes with the update.
  await insert('gws_ea_inbox_principal_messages', {
    gmail_message_id: 'g-p1',
    address: PRINCIPAL,
    gmail_thread_id: 'gt-p',
    rfc_message_id: '<p1@northwind.example>',
    reference_ids: '[]',
    subject: 'Lunch?',
    received_at: '2026-10-04T08:00:00.000Z',
  });
  await insert('gws_ea_inbox_sends', {
    id: 'send-principal',
    thread_key: null,
    principal_message_id: 'g-p1',
    content_hash: 'principal-reply-hash',
    rfc_message_id: '<pr1@northwind.example>',
    state: 'sent',
    gmail_message_id: 'g-p1-reply',
    created_at: '2026-10-04T08:01:00.000Z',
    updated_at: '2026-10-04T08:01:01.000Z',
  });

  await earlierThread(BOOKED, { origin: 'arrange', state: 'open', gmailThreadId: 'gt-b', to: [REMY] });
  await earlierMeeting('mtg-b', BOOKED, 'arrange', 'booked');
  await earlierBooking('mtg-b', 'booked-event-b');

  await earlierThread(MOVED, { origin: 'arrange', state: 'open', gmailThreadId: 'gt-r', to: [SAM] });
  await earlierMeeting('mtg-r', MOVED, 'reschedule', 'booked');
  await earlierBooking('mtg-r', 'principal-own-event');

  await earlierMeeting('mtg-g', GONE, 'arrange', 'active');
  await earlierHold('mtg-g', 'hold-g1', '2026-10-08T13:00:00.000Z', '2026-10-08T13:30:00.000Z');

  await earlierThread(INBOUND, {
    origin: 'inbound',
    state: 'awaiting-arrange',
    gmailThreadId: 'gt-c',
    to: [SAM],
    messageIds: ['<c1@acme.example>'],
  });
  await insert('gws_ea_inbox_held', {
    gmail_message_id: 'g-c1',
    thread_key: INBOUND,
    sender: SAM,
    held_at: '2026-10-04T20:00:00.000Z',
  });
  await insert('gws_ea_inbox_messages', {
    gmail_message_id: 'g-c1',
    outcome: 'inbound',
    attempts: 0,
    first_seen_at: '2026-10-04T20:00:00.000Z',
    settled_at: '2026-10-04T20:00:00.000Z',
  });

  await earlierThread(COPY_IN, {
    origin: 'copy-in',
    state: 'awaiting-arrange',
    gmailThreadId: 'gt-d',
    to: [REMY],
    cc: [PRINCIPAL],
    vouched: [REMY, PRINCIPAL],
    messageIds: ['<d1@northwind.example>'],
  });
  await insert('gws_ea_inbox_principal_messages', {
    gmail_message_id: 'g-d1',
    address: PRINCIPAL,
    gmail_thread_id: 'gt-d',
    rfc_message_id: '<d1@northwind.example>',
    reference_ids: '[]',
    subject: 'Meet Remy',
    received_at: '2026-10-04T21:00:00.000Z',
  });
  await insert('gws_ea_inbox_messages', {
    gmail_message_id: 'g-d1',
    outcome: 'copy-in',
    attempts: 0,
    first_seen_at: '2026-10-04T21:00:00.000Z',
    settled_at: '2026-10-04T21:00:00.000Z',
  });

  // A copy-in main already took over: the principal's message there was handled, and stays settled.
  await earlierThread(TAKEN, {
    origin: 'copy-in',
    state: 'open',
    gmailThreadId: 'gt-e',
    to: [' Remy@Friends.example '],
    cc: [PRINCIPAL],
  });
  await insert('gws_ea_inbox_principal_messages', {
    gmail_message_id: 'g-e1',
    address: PRINCIPAL,
    gmail_thread_id: 'gt-e',
    rfc_message_id: '<e1@northwind.example>',
    reference_ids: '[]',
    subject: 'Remy, meet Juno',
    received_at: '2026-10-03T21:00:00.000Z',
  });
  await insert('gws_ea_inbox_messages', {
    gmail_message_id: 'g-e1',
    outcome: 'copy-in',
    attempts: 0,
    first_seen_at: '2026-10-03T21:00:00.000Z',
    settled_at: '2026-10-03T21:00:00.000Z',
  });
}

// ---------------------------------------------------------------------------
// The assistant around it
// ---------------------------------------------------------------------------

let calendar: FakeCalendar;

function now(): string {
  return new Date().toISOString();
}

/** The groups, profile and calendar an earlier release's assistant had. */
async function seedAssistant(): Promise<void> {
  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
  }
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
    platform_id: INBOX_PLATFORM_ID,
    name: 'Inbox',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await getDb().run("UPDATE gws_ea_inbox_state SET messaging_group_id = 'mg-inbox', history_id = '100'");
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
  await ensureContainerConfig('ag-external');
  await getDb().run(
    "UPDATE container_configs SET capabilities = ?, cli_scope = 'disabled' WHERE agent_group_id = 'ag-external'",
    JSON.stringify(['reply', 'time', 'request-status', 'gws-ea-meetings-external']),
  );
  await addPrincipalAddress(PRINCIPAL);
  calendar = new FakeCalendar();
  google.calendar = calendar;
  calendar.calendars.set(PRINCIPAL, {
    id: PRINCIPAL,
    accessRole: 'writer',
    summary: PRINCIPAL,
    conferenceTypes: ['hangoutsMeet'],
  });
  // main's conversation with the principal, where the host's notes for it land.
  await resolveSession('ag-main', 'mg-dm', null, 'agent-shared');
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Registration, portability, and a fresh install
// ---------------------------------------------------------------------------

describe('the email channel migration', () => {
  it('is registered by the inbox after its own store and the three meetings migrations, in that order', () => {
    const names = getRegisteredMigrations().map((migration) => migration.name);
    const expected = [
      'module:gws-ea-inbox:create-inbox',
      'module:gws-ea-meetings:create-meetings',
      'module:gws-ea-meetings:calendar-actions',
      'module:gws-ea-meetings:rooms',
      EMAIL_CHANNEL,
    ];
    const start = names.indexOf(expected[0]!);
    expect(names.slice(start, start + expected.length)).toEqual(expected);
    expect(names.filter((name) => /^module:gws-ea-(inbox|meetings):/u.test(name))).toEqual(expected);
  });

  it('is async and its source carries none of the banned constructs', () => {
    expect(gwsEaInboxEmailChannelMigration.up.constructor.name).toBe('AsyncFunction');
    const source = fs.readFileSync(new URL('./migration-email-channel.ts', import.meta.url), 'utf8');
    for (const banned of BANNED_PORTABLE_SQL) expect(source, String(banned)).not.toMatch(banned);
  });

  it('moves external-email to exactly the list this release stamps it with', () => {
    expect([...MOVED_EXTERNAL_EMAIL_CAPABILITIES].sort()).toEqual([...EXTERNAL_EMAIL_CAPABILITIES].sort());
  });

  describe('on a fresh install', () => {
    beforeEach(async () => {
      await runMigrations(await initTestDb());
    });

    it('runs every migration, creates every thread table, and leaves no earlier table behind', async () => {
      const db = getDb();
      expect(await db.get('SELECT name FROM schema_version WHERE name = ?', EMAIL_CHANNEL)).toBeDefined();
      for (const table of [...THREAD_TABLES, ...KEPT_TABLES]) expect(await db.hasTable(table), table).toBe(true);
      for (const table of EARLIER_TABLES) expect(await db.hasTable(table), table).toBe(false);
    });

    it('gives a thread no booking calendar until main names one', async () => {
      const db = getDb();
      await db.run(
        'INSERT INTO gws_ea_threads (thread_key, gmail_thread_id, created_at) VALUES (?, NULL, ?)',
        'mail-a',
        now(),
      );
      expect(await db.get('SELECT booking_calendar_id FROM gws_ea_threads WHERE thread_key = ?', 'mail-a')).toEqual({
        booking_calendar_id: null,
      });
      await expect(
        db.run("UPDATE gws_ea_threads SET booking_calendar_id = '' WHERE thread_key = ?", 'mail-a'),
      ).rejects.toThrow(/CHECK/i);
    });

    it('keeps a hold recorded while its thread is: the record is how its event is released', async () => {
      const db = getDb();
      await db.run(
        'INSERT INTO gws_ea_threads (thread_key, gmail_thread_id, created_at) VALUES (?, NULL, ?)',
        'mail-a',
        now(),
      );
      await db.run(
        `INSERT INTO gws_ea_thread_holds (thread_key, calendar_id, event_id, start_at, end_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'mail-a',
        PRINCIPAL,
        'hold1',
        HELD_START,
        HELD_END,
        THREE_DAYS_ON,
      );
      await expect(db.run('DELETE FROM gws_ea_threads WHERE thread_key = ?', 'mail-a')).rejects.toThrow(/FOREIGN KEY/i);
      await expect(
        db.run(
          'INSERT INTO gws_ea_threads (thread_key, gmail_thread_id, created_at) VALUES (?, NULL, ?)',
          'thread-b',
          now(),
        ),
      ).rejects.toThrow(/CHECK/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Moving an earlier release's work
// ---------------------------------------------------------------------------

describe("moving an earlier release's work", () => {
  let offered: Session;

  beforeEach(async () => {
    await earlierRelease();
    await seedAssistant();
    await seedEarlierWork();
    // The offered thread's conversation, as the earlier release left it.
    offered = (await resolveSession('ag-external', 'mg-inbox', OFFERED, 'per-thread')).session;
    await runMigrations(getDb());
  });

  it('converts every thread in place, keeping its key, its Gmail thread, its message ids and its addresses', async () => {
    const db = getDb();
    expect(
      await db.all('SELECT thread_key, gmail_thread_id, booking_calendar_id FROM gws_ea_threads ORDER BY thread_key'),
    ).toEqual([
      { thread_key: BOOKED, gmail_thread_id: 'gt-b', booking_calendar_id: PRINCIPAL },
      { thread_key: COPY_IN, gmail_thread_id: 'gt-d', booking_calendar_id: null },
      { thread_key: TAKEN, gmail_thread_id: 'gt-e', booking_calendar_id: null },
      // Holds whose thread the earlier inbox no longer had keep a bare thread, so the sweep still finds them.
      { thread_key: GONE, gmail_thread_id: null, booking_calendar_id: PRINCIPAL },
      { thread_key: INBOUND, gmail_thread_id: 'gt-c', booking_calendar_id: null },
      { thread_key: OFFERED, gmail_thread_id: 'gt-a', booking_calendar_id: PRINCIPAL },
      // A reschedule moved the principal's own event: its thread books nothing of its own.
      { thread_key: MOVED, gmail_thread_id: 'gt-r', booking_calendar_id: null },
    ]);
    expect(
      await db.all(
        'SELECT position, side, gmail_message_id, rfc_message_id FROM gws_ea_thread_messages WHERE thread_key = ? ORDER BY position',
        OFFERED,
      ),
    ).toEqual([
      { position: 1, side: 'outside', gmail_message_id: null, rfc_message_id: '<a1@northwind.example>' },
      { position: 2, side: 'outside', gmail_message_id: null, rfc_message_id: '<a2@friends.example>' },
      // The assistant's email Gmail took keeps Gmail's id, so a reply can answer it.
      { position: 3, side: 'outside', gmail_message_id: 'g-a3', rfc_message_id: '<a3@northwind.example>' },
      // The send still in flight is known by its send's record alone, as a new send is.
    ]);
    // main named the people of a thread it started; everyone else came on a message.
    expect(
      await db.all('SELECT thread_key, address, source FROM gws_ea_thread_addresses ORDER BY thread_key, address'),
    ).toEqual([
      { thread_key: BOOKED, address: REMY, source: 'main' },
      { thread_key: COPY_IN, address: PRINCIPAL, source: 'message' },
      { thread_key: COPY_IN, address: REMY, source: 'message' },
      // An address as the earlier inbox stored it, written once in the form every check compares.
      { thread_key: TAKEN, address: PRINCIPAL, source: 'message' },
      { thread_key: TAKEN, address: REMY, source: 'message' },
      { thread_key: INBOUND, address: SAM, source: 'message' },
      { thread_key: OFFERED, address: PRINCIPAL, source: 'main' },
      { thread_key: OFFERED, address: REMY, source: 'main' },
      { thread_key: MOVED, address: SAM, source: 'main' },
    ]);
  });

  it("carries every hold over to lapse three days on, and every booking but a reschedule's", async () => {
    const db = getDb();
    expect(
      await db.all(
        'SELECT thread_key, calendar_id, event_id, start_at, end_at, expires_at FROM gws_ea_thread_holds ORDER BY event_id',
      ),
    ).toEqual([
      {
        thread_key: OFFERED,
        calendar_id: PRINCIPAL,
        event_id: 'hold-a1',
        start_at: HELD_START,
        end_at: HELD_END,
        expires_at: THREE_DAYS_ON,
      },
      {
        thread_key: OFFERED,
        calendar_id: PRINCIPAL,
        event_id: 'hold-a2',
        start_at: '2026-10-07T09:00:00.000Z',
        end_at: '2026-10-07T09:30:00.000Z',
        expires_at: THREE_DAYS_ON,
      },
      {
        thread_key: GONE,
        calendar_id: PRINCIPAL,
        event_id: 'hold-g1',
        start_at: '2026-10-08T13:00:00.000Z',
        end_at: '2026-10-08T13:30:00.000Z',
        expires_at: THREE_DAYS_ON,
      },
    ]);
    // The principal's own event, which a reschedule moved, never becomes a booking a thread may cancel.
    expect(await db.all('SELECT thread_key, calendar_id, event_id FROM gws_ea_thread_bookings')).toEqual([
      { thread_key: BOOKED, calendar_id: PRINCIPAL, event_id: 'booked-event-b' },
    ]);
  });

  it("carries the thread's pending and sent ledger rows over unchanged, and drops replies to the principal", async () => {
    expect(
      await getDb().all(
        'SELECT id, thread_key, side, content_hash, rfc_message_id, state, gmail_message_id FROM gws_ea_thread_sends ORDER BY id',
      ),
    ).toEqual([
      {
        id: 'send-pending',
        thread_key: OFFERED,
        side: 'outside',
        content_hash: sendKey(OFFERED, PENDING_WORDS),
        rfc_message_id: '<a4@northwind.example>',
        state: 'pending',
        gmail_message_id: null,
      },
      {
        id: 'send-sent',
        thread_key: OFFERED,
        side: 'outside',
        content_hash: sendKey(OFFERED, SENT_WORDS),
        rfc_message_id: '<a3@northwind.example>',
        state: 'sent',
        gmail_message_id: 'g-a3',
      },
    ]);
  });

  it("leaves held mail, and the principal's copy-in main had not taken over, to route again", async () => {
    expect(
      await getDb().all(
        'SELECT gmail_message_id, outcome, attempts, first_seen_at, settled_at FROM gws_ea_inbox_messages WHERE settled_at IS NULL ORDER BY first_seen_at',
      ),
    ).toEqual([
      {
        gmail_message_id: 'g-c1',
        outcome: null,
        attempts: 0,
        first_seen_at: '2026-10-04T20:00:00.000Z',
        settled_at: null,
      },
      {
        gmail_message_id: 'g-d1',
        outcome: null,
        attempts: 0,
        first_seen_at: '2026-10-04T21:00:00.000Z',
        settled_at: null,
      },
    ]);
  });

  it("moves external-email's capabilities from the list an earlier release stamped to this release's", async () => {
    expect(JSON.parse((await getContainerConfig('ag-external'))?.capabilities ?? 'null')).toEqual([
      ...MOVED_EXTERNAL_EMAIL_CAPABILITIES,
    ]);
  });

  it('leaves no earlier table behind, and keeps the inbox’s own', async () => {
    const db = getDb();
    for (const table of EARLIER_TABLES) expect(await db.hasTable(table), table).toBe(false);
    for (const table of [...THREAD_TABLES, ...KEPT_TABLES]) expect(await db.hasTable(table), table).toBe(true);
  });

  it('resolves a later reply to the same thread and session, under a changed subject too', async () => {
    expect((await findThreadFor({ gmailThreadId: 'gt-a', inReplyTo: [], references: [] }))?.threadKey).toBe(OFFERED);
    expect(
      (await findThreadFor({ gmailThreadId: 'gt-new', inReplyTo: ['<a3@northwind.example>'], references: [] }))
        ?.threadKey,
    ).toBe(OFFERED);
    // A reply to the send still in flight resolves by the send's record.
    expect(
      (await findThreadFor({ gmailThreadId: 'gt-new', inReplyTo: ['<a4@northwind.example>'], references: [] }))
        ?.threadKey,
    ).toBe(OFFERED);
    const { session, created } = await resolveSession('ag-external', 'mg-inbox', OFFERED, 'per-thread');
    expect({ id: session.id, created }).toEqual({ id: offered.id, created: false });
  });

  it('reconciles a send Gmail already holds instead of sending it twice', async () => {
    const sent: string[] = [];
    const gmail = fakeGmail({
      threads: {
        'gt-a': [
          {
            id: 'g-a4',
            threadId: 'gt-a',
            payload: { headers: [{ name: 'Message-ID', value: '<a4@northwind.example>' }] },
          },
        ],
      },
      onSend: (raw) => sent.push(raw),
    });
    const runtime = inboxRuntime(gmail);
    const prepare = vi.fn(async () => ({ gmailThreadId: 'gt-a', raw: async () => 'raw' }));
    const scope = { threadKey: OFFERED, side: 'outside' } as const;

    expect(await sendExactlyOnce(runtime, scope, sendKey(OFFERED, SENT_WORDS), prepare)).toBe('g-a3');
    expect(prepare).not.toHaveBeenCalled();
    expect(await sendExactlyOnce(runtime, scope, sendKey(OFFERED, PENDING_WORDS), prepare)).toBe('g-a4');
    expect(sent).toEqual([]);
    // Recorded once, now that Gmail holds it.
    expect(
      (await threadMessages(OFFERED, 'outside')).filter((message) => message.rfcMessageId === '<a4@northwind.example>'),
    ).toEqual([
      { threadKey: OFFERED, side: 'outside', gmailMessageId: 'g-a4', rfcMessageId: '<a4@northwind.example>' },
    ]);
  });

  it('answers a converted thread’s latest message, known only by its Message-ID, in its Gmail thread', async () => {
    const sent: Array<{ raw: string; threadId?: string }> = [];
    const gmail = fakeGmail({
      threads: {
        'gt-c': [
          { id: 'g-c1', threadId: 'gt-c', payload: { headers: [{ name: 'Message-ID', value: '<c1@acme.example>' }] } },
        ],
      },
      messages: { 'g-c1': incoming('g-c1', 'gt-c', SAM, [JUNO], 'Partnership', '<c1@acme.example>', 'none') },
      send: (input) => {
        sent.push(input);
        return { id: 'g-reply', threadId: 'gt-c' };
      },
    });

    expect(
      await sendToOutside(inboxRuntime(gmail), INBOX_PLATFORM_ID, INBOUND, {
        kind: 'chat',
        content: { text: 'Thanks, Sam. Pat would be glad to talk.' },
      }),
    ).toBe('g-reply');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.threadId).toBe('gt-c');
    const headers = Buffer.from(sent[0]!.raw, 'base64url').toString('utf8').split('\r\n\r\n')[0]!;
    expect(headers).toMatch(/^In-Reply-To: <c1@acme\.example>$/mu);
    expect(headers).toMatch(/^To: sam@acme\.example$/mu);
    expect(headers).toMatch(/^Subject: Re: Partnership$/mu);
  });

  it("routes held mail and the principal's copy-in exactly once, to their threads, after the update", async () => {
    const routed: Array<{ platformId: string; threadId: string | null; id: string }> = [];
    const gmail = fakeGmail({
      messages: {
        'g-c1': incoming('g-c1', 'gt-c', SAM, [JUNO], 'Partnership', '<c1@acme.example>', 'none'),
        'g-d1': incoming('g-d1', 'gt-d', PRINCIPAL, [REMY, JUNO], 'Meet Remy', '<d1@northwind.example>', 'principal'),
      },
    });
    const inbox = createInbox({ gmail, calendar: { list: async () => [], patchNotifications: async () => undefined } });
    await inbox.adapter.setup(recordingSetup(routed));

    await inbox.tick();
    await inbox.tick();

    expect(routed).toEqual([
      { platformId: INBOX_PLATFORM_ID, threadId: INBOUND, id: 'g-c1' },
      { platformId: INBOX_PLATFORM_ID, threadId: COPY_IN, id: 'g-d1' },
    ]);
    expect(await getDb().all('SELECT gmail_message_id FROM gws_ea_inbox_messages WHERE settled_at IS NULL')).toEqual(
      [],
    );
    await inbox.adapter.teardown?.();
  });

  it("reports the inbox's health and external-email's in the shapes status reads", async () => {
    expect(await dispatch({ id: 'h', command: 'gws-ea-inbox-health', args: {} }, { caller: 'host' })).toEqual({
      id: 'h',
      ok: true,
      data: await getInboxHealth(),
    });
    expect(await getInboxHealth()).toEqual({
      state: 'healthy',
      reason: null,
      since: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      calendarNotifications: { state: 'unknown', reason: null },
    });
    const external = await dispatch({ id: 'e', command: 'gws-ea-external-email-health', args: {} }, { caller: 'host' });
    expect(external).toMatchObject({
      id: 'e',
      ok: true,
      data: { agent_group_id: 'ag-external', problems: expect.any(Array) },
    });
    const problems = (external as { data: { problems: string[] } }).data.problems;
    expect(problems.filter((problem) => problem.startsWith('its capabilities'))).toEqual([]);
  });
});

describe("the conversion's guards", () => {
  beforeEach(async () => {
    await earlierRelease();
    await seedAssistant();
  });

  it('leaves a capability list no earlier release stamped for the drift check', async () => {
    const handEdited = ['reply', 'time', 'request-status', 'gws-ea-meetings-external', 'web'];
    await getDb().run(
      "UPDATE container_configs SET capabilities = ? WHERE agent_group_id = 'ag-external'",
      JSON.stringify(handEdited),
    );
    await runMigrations(getDb());
    expect(JSON.parse((await getContainerConfig('ag-external'))?.capabilities ?? 'null')).toEqual(handEdited);
  });

  it('moves the first list an earlier release stamped, in any order', async () => {
    await getDb().run(
      "UPDATE container_configs SET capabilities = ? WHERE agent_group_id = 'ag-external'",
      JSON.stringify(['gws-ea-meetings-external', 'reply']),
    );
    await runMigrations(getDb());
    expect(JSON.parse((await getContainerConfig('ag-external'))?.capabilities ?? 'null')).toEqual([
      ...MOVED_EXTERNAL_EMAIL_CAPABILITIES,
    ]);
  });

  it.each<[string, string, Record<string, unknown>, RegExp]>([
    [
      'a message',
      'gws_ea_inbox_thread_messages',
      {
        rfc_message_id: '<orphan@acme.example>',
        thread_key: 'mail-vanished',
        position: 1,
        added_at: '2026-10-02T12:00:00.000Z',
      },
      /thread messages/u,
    ],
    [
      'a hold',
      'gws_ea_meeting_holds',
      {
        meeting_id: 'mtg-vanished',
        slot_id: 'slot-00000000000f',
        calendar_id: PRINCIPAL,
        event_id: 'hold-vanished',
        start_at: HELD_START,
        end_at: HELD_END,
        held_at: '2026-10-02T09:00:00.000Z',
      },
      /holds/u,
    ],
    [
      'a booking',
      'gws_ea_meeting_bookings',
      {
        meeting_id: 'mtg-vanished',
        calendar_id: PRINCIPAL,
        event_id: 'booked-vanished',
        start_at: '2026-10-09T09:00:00.000Z',
        end_at: '2026-10-09T09:30:00.000Z',
        booked_at: '2026-10-03T09:00:00.000Z',
        invitation: null,
      },
      /bookings/u,
    ],
    [
      'a send in flight',
      'gws_ea_inbox_sends',
      {
        id: 'send-vanished',
        thread_key: 'mail-vanished',
        principal_message_id: null,
        content_hash: 'vanished-hash',
        rfc_message_id: '<vanished@northwind.example>',
        state: 'pending',
        gmail_message_id: null,
        created_at: '2026-10-04T09:00:00.000Z',
        updated_at: '2026-10-04T09:00:00.000Z',
      },
      /sends in flight/u,
    ],
  ])('throws on %s it cannot carry over, and changes nothing', async (_what, table, orphan, reason) => {
    await seedEarlierWork();
    // A row whose thread or meeting is gone: a live database can carry such an orphan.
    const raw = sqliteRaw(getDb());
    raw.pragma('foreign_keys = OFF');
    await insert(table, orphan);
    raw.pragma('foreign_keys = ON');

    await expect(runMigrations(getDb())).rejects.toThrow(reason);

    const db = getDb();
    expect(await db.get('SELECT name FROM schema_version WHERE name = ?', EMAIL_CHANNEL)).toBeUndefined();
    for (const table of THREAD_TABLES) expect(await db.hasTable(table), table).toBe(false);
    for (const table of EARLIER_TABLES) expect(await db.hasTable(table), table).toBe(true);
    expect(await db.get('SELECT COUNT(*) AS count FROM gws_ea_inbox_sends')).toEqual({
      count: table === 'gws_ea_inbox_sends' ? 4 : 3,
    });
    expect(JSON.parse((await getContainerConfig('ag-external'))?.capabilities ?? 'null')).toEqual([
      'reply',
      'time',
      'request-status',
      'gws-ea-meetings-external',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** An email as Gmail holds it in INBOX. `principal` passes Gmail's checks for the principal's domain. */
function incoming(
  id: string,
  threadId: string,
  from: string,
  to: readonly string[],
  subject: string,
  messageId: string,
  auth: 'principal' | 'none',
): GmailMessage {
  const domain = from.slice(from.lastIndexOf('@') + 1);
  const results =
    auth === 'principal'
      ? `mx.google.com;\r\n dkim=pass header.i=@${domain} header.s=google header.b=a;\r\n dmarc=pass (p=REJECT) header.from=${domain}`
      : `mx.google.com;\r\n spf=softfail smtp.mailfrom=${domain};\r\n dmarc=bestguesspass header.from=${domain}`;
  return {
    id,
    threadId,
    labelIds: ['INBOX'],
    internalDate: String(Date.parse('2026-10-04T19:00:00.000Z')),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to.join(', ') },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: messageId },
        { name: 'Authentication-Results', value: results },
      ],
      body: { data: b64(`Hello from ${from}.`) },
    },
  };
}

function fakeGmail(input: {
  readonly messages?: Readonly<Record<string, GmailMessage>>;
  readonly threads?: Readonly<Record<string, GmailMessage[]>>;
  readonly onSend?: (raw: string) => void;
  readonly send?: (input: { raw: string; threadId?: string }) => { id: string; threadId: string };
}): GmailApi {
  return {
    getProfile: async () => ({ emailAddress: JUNO, historyId: '101' }),
    listHistory: async () => ({ history: [], historyId: '101' }),
    getMessage: async (id) =>
      input.messages?.[id] ??
      Object.values(input.threads ?? {})
        .flat()
        .find((m) => m.id === id),
    listMessages: async () => [],
    getThread: async (id) => input.threads?.[id],
    getAttachment: async () => undefined,
    send: async ({ raw, threadId }) => {
      input.onSend?.(raw);
      if (!input.send) throw new Error('This Gmail takes no send');
      return input.send({ raw, ...(threadId === undefined ? {} : { threadId }) });
    },
  };
}

function inboxRuntime(gmail: GmailApi): InboxRuntime {
  return {
    gmail,
    setup: () => undefined,
    gmailAddress: async () => JUNO,
    knownGmailAddress: () => JUNO,
    now: () => new Date(),
    sleep: async () => undefined,
  };
}

function recordingSetup(routed: Array<{ platformId: string; threadId: string | null; id: string }>): ChannelSetup {
  return {
    onInbound: (platformId: string, threadId: string | null, message: InboundMessage) => {
      routed.push({ platformId, threadId, id: message.id });
    },
    onInboundEvent: () => undefined,
    onMetadata: () => undefined,
    onAction: () => undefined,
  };
}
