/**
 * external-email's calendar actions (KTD11; R4, R5, R6, R11, R20, R24):
 * `meeting_free_time`, `meeting_hold` and `meeting_book`, and the colleague path
 * where `arrange` books directly.
 *
 * Drives the real delivery actions, guards, meeting store, handoff, people
 * store, preferences, privacy check and session DBs against an in-memory
 * Google Calendar. Only the container runtime and its wake are mocked, and
 * the clock is fixed so weekdays and the clock change are known.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-calendar-actions';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-calendar-actions',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-calendar-actions/groups',
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

import { getDb } from '../../db/connection.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
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
import '../gws-ea-people/index.js';
import { addPerson, forgetPerson, type Person } from '../gws-ea-people/db.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-privacy/index.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import '../gws-ea-external-email/index.js';
import { consumeOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { ensureInbox, GoogleApiError } from '../gws-ea-inbox/index.js';
import { getBooking, listOfferedSlots } from './index.js';
import { FakeCalendar, type StoredEvent } from './testing/fake-calendar.js';
import { ask, data, meeting, meetingSession, notes, refusal, slotsOf, type OfferedSlot } from './testing/scheduling.js';

const ROBIN = 'robin@northwind.example';
const PRINCIPAL = 'pat@northwind.example';
const PRINCIPAL_USER = 'gchat:users/pat';
const ACME = 'sales@acme.example';
const SAM = 'sam@acme.example';
const DANA = 'dana@friends.example';
const KIM = 'kim@northwind.example';
const LEE = 'lee@northwind.example';
const LONDON = 'Europe/London';

/** Monday 5 October 2026, 08:00 in London (BST, UTC+1). */
const NOW = new Date('2026-10-05T07:00:00.000Z');
/** Tuesday 6 October 00:00 to the end of Thursday 8 October, London. */
const WINDOW = { window_start: '2026-10-06T00:00:00+01:00', window_end: '2026-10-09T00:00:00+01:00' };

const TUESDAY_2PM = '2026-10-06T13:00:00.000Z';
const WEDNESDAY_10AM = '2026-10-07T09:00:00.000Z';
const THURSDAY_3PM = '2026-10-08T14:00:00.000Z';

let calendar: FakeCalendar;
let main: Session;
let acme: Person;
let sam: Person;
let dana: Person;
let kim: Person;
let lee: Person;

function now(): string {
  return new Date().toISOString();
}

async function count(table: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

/** The principal's own meeting, with a title, a description and a guest the counterpart must never see. */
function busy(id: string, start: string, end: string): StoredEvent {
  return {
    calendarId: PRINCIPAL,
    id,
    iCalUID: `${id}@google.com`,
    status: 'confirmed',
    summary: 'Board review: acquisition of Contoso',
    description: 'Confidential agenda',
    organizer: { email: PRINCIPAL },
    attendees: [
      { email: PRINCIPAL, organizer: true, responseStatus: 'accepted' },
      { email: 'ceo@northwind.example', responseStatus: 'accepted' },
    ],
    start: { dateTime: start },
    end: { dateTime: end },
  };
}

/** Tuesday busy until 14:00, Wednesday until 10:00, Thursday until 15:00 (London). */
function fillTheMornings(): void {
  calendar.put(busy('evt-tue', '2026-10-06T08:00:00Z', '2026-10-06T13:00:00Z'));
  calendar.put(busy('evt-wed', '2026-10-07T08:00:00Z', '2026-10-07T09:00:00Z'));
  calendar.put(busy('evt-thu', '2026-10-08T08:00:00Z', '2026-10-08T14:00:00Z'));
}

function arrangeWith(person: Person, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    people: [{ person_id: person.id }],
    calendar_id: PRINCIPAL,
    length_minutes: 30,
    ...WINDOW,
    purpose: 'Partnership intro',
    constraints: 'Mornings suit the principal best.',
    ...extra,
  };
}

/** main arranges a meeting; returns it with the external-email session it is bound to. */
async function arranged(person: Person, extra: Record<string, unknown> = {}) {
  const answer = data(await ask(main, 'meeting_arrange', arrangeWith(person, extra)));
  const stored = await meeting(answer.meeting_id);
  return { meeting: stored, session: await meetingSession(stored.id), answer };
}

function holds(): StoredEvent[] {
  return calendar.live(PRINCIPAL).filter((event) => event.tags?.gwsEaRole === 'hold');
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
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: 'gchat',
    platform_id: 'spaces/dm',
    name: 'dm',
    is_group: 0,
    unknown_sender_policy: 'strict',
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
        SET main_agent_group_id = 'ag-main', assistant_display_name = 'Robin', assistant_workspace_email = ?,
            principal_display_name = 'Pat Doe', principal_timezone = ?
      WHERE singleton = 1`,
    ROBIN,
    LONDON,
  );
  await recordExternalEmailAgentGroupId('ag-external');
  await addPrincipalAddress(PRINCIPAL);

  const person = (name: string, level: 'close' | 'active' | 'known', address: string) =>
    addPerson({ name, level, source: 'principal', basis: 'a contact', identity: `email:${address}` });
  acme = await person('Acme Sales', 'known', ACME);
  sam = await person('Sam Lee', 'active', SAM);
  dana = await person('Dana Fox', 'close', DANA);
  kim = await person('Kim Park', 'active', KIM);
  lee = await person('Lee Chan', 'known', LEE);

  calendar = new FakeCalendar();
  google.calendar = calendar;
  calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer', primary: false });

  await ensureInbox('ag-external');
  main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// AE1, end to end
// ---------------------------------------------------------------------------

describe('AE1: three offered times become holds, and the one picked becomes the meeting', () => {
  it('holds Tuesday 2pm, Wednesday 10am and Thursday 3pm, then books Wednesday with Acme and releases the rest', async () => {
    fillTheMornings();
    const { meeting: stored, session } = await arranged(acme);

    const offered = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    expect(offered.slice(0, 3).map((slot) => slot.start)).toEqual([TUESDAY_2PM, WEDNESDAY_10AM, THURSDAY_3PM]);
    const [tuesday, wednesday, thursday] = offered;

    data(
      await ask(session, 'meeting_hold', {
        meeting_id: stored.id,
        slot_ids: [tuesday.slot_id, wednesday.slot_id, thursday.slot_id],
      }),
    );
    expect(
      holds()
        .map((hold) => hold.start?.dateTime)
        .sort(),
    ).toEqual([TUESDAY_2PM, WEDNESDAY_10AM, THURSDAY_3PM]);
    for (const hold of holds()) {
      expect(hold).toMatchObject({ visibility: 'private', transparency: 'opaque', reminders: 'none' });
      expect(hold.attendees ?? []).toEqual([]);
      expect(hold.tags).toMatchObject({ gwsEaMeeting: stored.id, gwsEaRole: 'hold' });
      expect(consumeOwnCalendarChange(PRINCIPAL, hold.id, new Date())).toBe(true);
    }

    const booked = data(
      await ask(session, 'meeting_book', {
        meeting_id: stored.id,
        slot_id: wednesday.slot_id,
        invitation: { title: 'Partnership intro' },
      }),
    );
    expect(booked).toMatchObject({ booking: { start: WEDNESDAY_10AM } });

    expect(holds()).toEqual([]);
    const atWednesday = calendar.live(PRINCIPAL).filter((event) => event.start?.dateTime === WEDNESDAY_10AM);
    expect(atWednesday).toHaveLength(1);
    const [event] = atWednesday;
    expect(event.attendees?.map((attendee) => attendee.email)).toEqual([ACME]);
    expect(event.organizer?.email).toBe(PRINCIPAL);
    expect(calendar.writes.find((write) => write.op === 'insert' && write.eventId === event.id)?.sendUpdates).toBe(
      'all',
    );
    expect(calendar.writes.filter((write) => write.op === 'delete').map((write) => write.sendUpdates)).toEqual([
      'none',
      'none',
      'none',
    ]);

    expect(await getBooking(stored.id)).toMatchObject({
      calendar_id: PRINCIPAL,
      event_id: event.id,
      start_at: WEDNESDAY_10AM,
    });
    expect((await meeting(stored.id)).state).toBe('booked');
  });
});

// ---------------------------------------------------------------------------
// free_time
// ---------------------------------------------------------------------------

describe('free_time', () => {
  it('returns candidate start times with slot ids only: never free intervals, titles, attendees or descriptions', async () => {
    fillTheMornings();
    const { meeting: stored, session } = await arranged(acme);
    const frame = await ask(session, 'meeting_free_time', { meeting_id: stored.id });
    const answer = data(frame);

    expect(Object.keys(answer).sort()).toEqual(['meeting_id', 'message', 'slots']);
    const slots = slotsOf(frame);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(5);
    for (const slot of slots) {
      expect(Object.keys(slot).sort()).toEqual(['end', 'held', 'slot_id', 'start']);
      expect(Date.parse(slot.end) - Date.parse(slot.start)).toBe(30 * 60_000);
      expect(String(answer.message)).toContain(slot.slot_id);
    }
    const everything = JSON.stringify(frame);
    for (const hidden of ['Board review', 'Contoso', 'Confidential', 'ceo@northwind.example', 'evt-tue']) {
      expect(everything).not.toContain(hidden);
    }
    expect((await listOfferedSlots(stored.id)).map((slot) => slot.slot_id).sort()).toEqual(
      slots.map((slot) => slot.slot_id).sort(),
    );
  });

  it('is capped: after ten answers for one meeting it refuses, and records nothing more', async () => {
    const { meeting: stored, session } = await arranged(acme);
    for (let call = 0; call < 10; call++) data(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    const callsBefore = calendar.calls;
    expect(refusal(await ask(session, 'meeting_free_time', { meeting_id: stored.id }))).toMatch(/free_time/);
    expect(calendar.calls).toBe(callsBefore);
  });

  it("checks a proposed day and time in the counterpart's own timezone, with no arithmetic left to the agent (R4)", async () => {
    const { meeting: stored, session } = await arranged(acme);
    // 15:00 in New York is 20:00 in London: after the principal's working day.
    const late = data(
      await ask(session, 'meeting_free_time', {
        meeting_id: stored.id,
        date: '2026-10-07',
        time: '15:00',
        timezone: 'America/New_York',
      }),
    );
    expect(String(late.message)).toMatch(/not open/i);
    for (const slot of late.slots as OfferedSlot[]) expect(slot.start.startsWith('2026-10-07')).toBe(true);
    expect(String(late.message)).toContain('America/New_York');

    // 05:00 in New York is 10:00 in London: open.
    const early = data(
      await ask(session, 'meeting_free_time', {
        meeting_id: stored.id,
        date: '2026-10-07',
        time: '05:00',
        timezone: 'America/New_York',
      }),
    );
    expect((early.slots as OfferedSlot[]).map((slot) => slot.start)).toEqual([WEDNESDAY_10AM]);
  });

  it('is refused from main, and from a conversation bound to another meeting', async () => {
    const first = await arranged(acme);
    const second = await arranged(sam);
    expect(refusal(await ask(main, 'meeting_free_time', { meeting_id: first.meeting.id }))).toMatch(/external-email/);
    expect(refusal(await ask(second.session, 'meeting_free_time', { meeting_id: first.meeting.id }))).toMatch(
      /Use only the meeting your brief names/,
    );
    expect(await listOfferedSlots(first.meeting.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hold
// ---------------------------------------------------------------------------

describe('hold', () => {
  it('refuses a slot that was not offered, one no longer free, and more than three', async () => {
    const { meeting: stored, session } = await arranged(acme);
    const offered = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));

    expect(
      refusal(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: ['slot-000000000000'] })),
    ).toMatch(/offered/);

    // Someone books the principal over the first offered time.
    calendar.put(busy('evt-new', offered[0].start, offered[0].end));
    expect(
      refusal(
        await ask(session, 'meeting_hold', {
          meeting_id: stored.id,
          slot_ids: [offered[0].slot_id, offered[1].slot_id],
        }),
      ),
    ).toMatch(/no longer open/);
    expect(holds()).toEqual([]);

    const three = [offered[1].slot_id, offered[2].slot_id, offered[3].slot_id];
    data(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: three }));
    expect(
      refusal(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [...three, offered[4].slot_id] })),
    ).toMatch(/up to 3/);
    expect(holds()).toHaveLength(3);
    // Holding the times already held changes nothing.
    data(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: three }));
    expect(holds()).toHaveLength(3);
    expect(calendar.writes.filter((write) => write.op === 'insert')).toHaveLength(3);
  });

  it('holds exactly the times named: the others go, and an empty list releases them all', async () => {
    const { meeting: stored, session } = await arranged(acme);
    const [a, b, c, d] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    data(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [a.slot_id, b.slot_id, c.slot_id] }));
    const held = data(
      await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [b.slot_id, c.slot_id, d.slot_id] }),
    );
    expect(held.message).toMatch(/Any other time it held is released/);
    expect(
      holds()
        .map((hold) => hold.start?.dateTime)
        .sort(),
    ).toEqual([b.start, c.start, d.start].sort());

    // A time no longer open refuses the whole call, and every hold stays.
    calendar.put(busy('evt-new', a.start, a.end));
    expect(refusal(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [a.slot_id] }))).toMatch(
      /no longer open/,
    );
    expect(holds()).toHaveLength(3);

    expect(data(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [] })).message).toMatch(
      /holds no times now/,
    );
    expect(holds()).toEqual([]);
    expect(await getDb().all('SELECT slot_id FROM gws_ea_meeting_holds WHERE meeting_id = ?', stored.id)).toEqual([]);
  });

  it('creates no duplicate when retried after Google applied it but the answer was lost', async () => {
    const { meeting: stored, session } = await arranged(acme);
    const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    calendar.failNext({
      op: 'insert',
      error: new GoogleApiError(0, 'Google could not be reached'),
      afterApplying: true,
    });
    expect((await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [slot.slot_id] })).ok).toBe(false);
    data(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [slot.slot_id] }));
    expect(holds()).toHaveLength(1);
    expect(calendar.writes.filter((write) => write.op === 'insert')).toHaveLength(1);
  });

  it('is refused for a meeting that asks an organizer to move their own invitation', async () => {
    calendar.put({
      ...busy('evt-invite', '2026-10-07T09:00:00Z', '2026-10-07T10:00:00Z'),
      organizer: { email: ACME },
      attendees: [
        { email: ACME, organizer: true, responseStatus: 'accepted' },
        { email: PRINCIPAL, responseStatus: 'needsAction' },
      ],
    });
    const asked = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-invite',
        ...WINDOW,
        purpose: 'Your Wednesday invitation',
      }),
    );
    const session = await meetingSession(asked.meeting_id);
    const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: asked.meeting_id }));
    expect(
      refusal(await ask(session, 'meeting_hold', { meeting_id: asked.meeting_id, slot_ids: [slot.slot_id] })),
    ).toMatch(/organizer/);
    expect(
      refusal(await ask(session, 'meeting_book', { meeting_id: asked.meeting_id, slot_id: slot.slot_id })),
    ).toMatch(/organizer/);
  });
});

describe('releasing holds', () => {
  it("touches only that meeting's holds that the assistant created", async () => {
    const first = await arranged(acme);
    const second = await arranged(sam);
    const [a1, a2] = slotsOf(await ask(first.session, 'meeting_free_time', { meeting_id: first.meeting.id }));
    data(
      await ask(first.session, 'meeting_hold', { meeting_id: first.meeting.id, slot_ids: [a1.slot_id, a2.slot_id] }),
    );
    // The first meeting's holds are busy time for the second.
    const [b1] = slotsOf(await ask(second.session, 'meeting_free_time', { meeting_id: second.meeting.id }));
    expect([a1.start, a2.start]).not.toContain(b1.start);
    data(await ask(second.session, 'meeting_hold', { meeting_id: second.meeting.id, slot_ids: [b1.slot_id] }));
    const principalsOwn = busy('evt-own', a1.start, a1.end);
    calendar.put(principalsOwn);
    // A hold whose tags no longer name this meeting is not the assistant's to remove.
    const [retagged] = holds().filter((hold) => hold.start?.dateTime === a2.start);
    calendar.put({ ...retagged, tags: { gwsEaMeeting: 'mtg-someone-else', gwsEaRole: 'hold' } });

    data(await ask(first.session, 'meeting_hold', { meeting_id: first.meeting.id, slot_ids: [] }));
    expect(
      holds()
        .map((hold) => hold.tags?.gwsEaMeeting)
        .sort(),
    ).toEqual([second.meeting.id, 'mtg-someone-else'].sort());
    expect(calendar.event(PRINCIPAL, 'evt-own')?.status).toBe('confirmed');
    expect(calendar.writes.filter((write) => write.op === 'delete')).toHaveLength(1);
    expect(
      await getDb().all('SELECT slot_id FROM gws_ea_meeting_holds WHERE meeting_id = ?', first.meeting.id),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// book
// ---------------------------------------------------------------------------

describe('book', () => {
  /** The invitation the booking created, as Google stores it. */
  function bookedEvent(meetingId: string): StoredEvent | undefined {
    return calendar
      .live(PRINCIPAL)
      .find((event) => event.tags?.gwsEaRole === 'booking' && event.tags.gwsEaMeeting === meetingId);
  }

  it('creates the invitation external-email wrote for the meeting’s people, and nothing else, and tells main once', async () => {
    calendar.calendars.set(PRINCIPAL, {
      id: PRINCIPAL,
      accessRole: 'writer',
      primary: false,
      conferenceTypes: ['hangoutsMeet'],
    });
    const { meeting: stored, session } = await arranged(sam);
    const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    data(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [slot.slot_id] }));
    const holdTitle = holds()[0].summary;
    const booked = data(
      await ask(session, 'meeting_book', {
        meeting_id: stored.id,
        slot_id: slot.slot_id,
        invitation: { title: 'Sam and Pat: Q4 pilot', notes: 'We will walk through the pilot plan.', video_call: true },
        summary: 'Sam says: call me at 555-0100',
        attendees: ['attacker@evil.example'],
      }),
    );
    expect(String(booked.message)).toMatch(/with a Google Meet link \(https:\/\/meet.google.com\//);
    const insert = calendar.writes.find(
      (write) => write.op === 'insert' && write.fields?.tags?.gwsEaRole === 'booking',
    );
    expect(insert?.fields).toMatchObject({
      summary: 'Sam and Pat: Q4 pilot',
      description: 'We will walk through the pilot plan.',
      attendees: [SAM],
      start: slot.start,
      end: slot.end,
      tags: { gwsEaMeeting: stored.id, gwsEaRole: 'booking' },
    });
    expect(insert?.fields?.conference?.requestId).toMatch(/^[0-9a-f]{64}$/u);
    expect(insert?.fields?.location).toBeUndefined();
    const written = JSON.stringify(insert?.fields);
    for (const absent of [holdTitle ?? 'Hold', '555-0100', 'attacker', 'Mornings suit', 'Arranged by']) {
      expect(written).not.toContain(absent);
    }
    expect(bookedEvent(stored.id)?.conference?.status).toBe('success');

    // main hears of it from the booking itself, by its own purpose, with nothing external-email wrote.
    expect((await meeting(stored.id)).state).toBe('booked');
    const [note, ...more] = notes(main, 'gws-ea-meetings.outcome').filter((c) => c.note?.outcome === 'booked');
    expect(more).toEqual([]);
    expect(note.note).toMatchObject({ meeting_id: stored.id, video_call: true });
    expect(note.text).toContain('"Partnership intro"');
    expect(note.text).toContain('with a Google Meet link');
    expect(note.text).not.toContain('Q4 pilot');
    // A repeat changes nothing, and tells main nothing twice.
    data(await ask(session, 'meeting_book', { meeting_id: stored.id, slot_id: slot.slot_id }));
    expect(notes(main, 'gws-ea-meetings.outcome').filter((c) => c.note?.outcome === 'booked')).toHaveLength(1);
    expect(
      calendar.writes.filter((write) => write.op === 'insert' && write.fields?.tags?.gwsEaRole === 'booking'),
    ).toHaveLength(1);
    expect(refusal(await ask(session, 'meeting_outcome', { meeting_id: stored.id, outcome: 'booked' }))).toMatch(
      /outcome must be one of/,
    );
  });

  it("puts the other side's own link in the place, with the join details in the notes, and adds no Meet link", async () => {
    const { meeting: stored, session } = await arranged(sam);
    const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    const booked = data(
      await ask(session, 'meeting_book', {
        meeting_id: stored.id,
        slot_id: slot.slot_id,
        invitation: {
          title: 'Sam and Pat: Q4 pilot',
          location: 'https://acme.zoom.us/j/8812345678',
          notes: 'Zoom passcode 4411.',
        },
      }),
    );
    expect(String(booked.message)).not.toMatch(/Meet/);
    expect(bookedEvent(stored.id)).toMatchObject({
      location: 'https://acme.zoom.us/j/8812345678',
      description: 'Zoom passcode 4411.',
    });
    expect(bookedEvent(stored.id)?.conference).toBeUndefined();
  });

  it('refuses an invitation carrying a private value, a missing title, and a Meet link the calendar does not allow, before any write', async () => {
    const { meeting: stored, session } = await arranged(sam);
    const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    await addPrivateValue({ label: 'Holiday home', kind: 'address', value: 'Rosewood Lodge' });
    const message = refusal(
      await ask(session, 'meeting_book', {
        meeting_id: stored.id,
        slot_id: slot.slot_id,
        invitation: { title: 'Planning', location: 'Rosewood Lodge' },
      }),
    );
    expect(message).toContain('address');
    expect(message).not.toContain('Rosewood');
    expect(refusal(await ask(session, 'meeting_book', { meeting_id: stored.id, slot_id: slot.slot_id }))).toMatch(
      /title/,
    );
    expect(
      refusal(
        await ask(session, 'meeting_book', {
          meeting_id: stored.id,
          slot_id: slot.slot_id,
          invitation: { title: 'Planning', video_call: true },
        }),
      ),
    ).toMatch(/does not allow Google Meet/);
    expect(calendar.writes.filter((write) => write.op === 'insert')).toEqual([]);
    expect(await getBooking(stored.id)).toBeUndefined();
  });

  it('says when Google is still creating the Meet link, and when it could not', async () => {
    calendar.calendars.set(PRINCIPAL, {
      id: PRINCIPAL,
      accessRole: 'writer',
      primary: false,
      conferenceTypes: ['hangoutsMeet'],
    });
    calendar.meetCreation = 'pending';
    const first = await arranged(sam);
    const [slot] = slotsOf(await ask(first.session, 'meeting_free_time', { meeting_id: first.meeting.id }));
    const pending = data(
      await ask(first.session, 'meeting_book', {
        meeting_id: first.meeting.id,
        slot_id: slot.slot_id,
        invitation: { title: 'Q4 pilot', video_call: true },
      }),
    );
    expect(String(pending.message)).toMatch(/still creating its Meet link/);

    calendar.meetCreation = 'failure';
    const second = await arranged(acme);
    const [other] = slotsOf(await ask(second.session, 'meeting_free_time', { meeting_id: second.meeting.id }));
    const failed = data(
      await ask(second.session, 'meeting_book', {
        meeting_id: second.meeting.id,
        slot_id: other.slot_id,
        invitation: { title: 'Intro', video_call: true },
      }),
    );
    expect(String(failed.message)).toMatch(/could not create a Meet link, so ask main about the place/);
  });

  it('creates no duplicate when retried after Google applied it but the answer was lost, and a repeat is a no-op', async () => {
    const { meeting: stored, session } = await arranged(sam);
    const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    calendar.failNext({
      op: 'insert',
      error: new GoogleApiError(0, 'Google could not be reached'),
      afterApplying: true,
    });
    const booking = { meeting_id: stored.id, slot_id: slot.slot_id, invitation: { title: 'Partnership intro' } };
    expect((await ask(session, 'meeting_book', booking)).ok).toBe(false);
    data(await ask(session, 'meeting_book', booking));
    data(await ask(session, 'meeting_book', booking));
    const bookings = calendar.live(PRINCIPAL).filter((event) => event.tags?.gwsEaRole === 'booking');
    expect(bookings).toHaveLength(1);
    // One invitation went out: no second insert, and no update that would email the attendees again.
    expect(calendar.writes.filter((write) => write.sendUpdates === 'all')).toHaveLength(1);
  });

  it('moves the booked event in place for a newly offered time, once booked', async () => {
    const { meeting: stored, session } = await arranged(sam);
    const [first, second] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    data(
      await ask(session, 'meeting_book', {
        meeting_id: stored.id,
        slot_id: first.slot_id,
        invitation: { title: 'Partnership intro' },
      }),
    );
    expect(
      data(await ask(session, 'meeting_book', { meeting_id: stored.id, slot_id: second.slot_id })).message,
    ).toMatch(/^Moved:/);
    expect(await getBooking(stored.id)).toMatchObject({ start_at: second.start });
    expect(
      calendar.writes.filter((write) => write.op === 'insert' && write.fields?.tags?.gwsEaRole === 'booking'),
    ).toHaveLength(1);
  });
});

describe('AE3: book for a reschedule moves the original event', () => {
  it('keeps its id, sends the attendees the update, and creates no second event', async () => {
    calendar.put({
      ...busy('evt-coffee', '2026-10-08T09:00:00Z', '2026-10-08T09:30:00Z'),
      summary: 'Coffee with Sam',
      attendees: [
        { email: PRINCIPAL, organizer: true, responseStatus: 'accepted' },
        { email: SAM, responseStatus: 'accepted' },
      ],
    });
    const moved = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-coffee',
        ...WINDOW,
        purpose: 'Moving our coffee',
      }),
    );
    const session = await meetingSession(moved.meeting_id);
    const eventsBefore = calendar.events.length;
    const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: moved.meeting_id }));
    // Its title, place and notes are the principal's own: a move takes no invitation.
    expect(
      refusal(
        await ask(session, 'meeting_book', {
          meeting_id: moved.meeting_id,
          slot_id: slot.slot_id,
          invitation: { title: 'Coffee, moved' },
        }),
      ),
    ).toMatch(/principal's own event/);
    data(await ask(session, 'meeting_book', { meeting_id: moved.meeting_id, slot_id: slot.slot_id }));

    expect(calendar.events).toHaveLength(eventsBefore);
    expect(calendar.writes.filter((write) => write.op === 'insert')).toEqual([]);
    expect(calendar.writes).toEqual([
      {
        op: 'patch',
        calendarId: PRINCIPAL,
        eventId: 'evt-coffee',
        sendUpdates: 'all',
        fields: { start: slot.start, end: slot.end },
      },
    ]);
    expect(calendar.event(PRINCIPAL, 'evt-coffee')).toMatchObject({
      summary: 'Coffee with Sam',
      start: { dateTime: slot.start },
      end: { dateTime: slot.end },
    });
    expect(await getBooking(String(moved.meeting_id))).toMatchObject({ event_id: 'evt-coffee', start_at: slot.start });
  });
});

// ---------------------------------------------------------------------------
// Colleagues (R11)
// ---------------------------------------------------------------------------

describe('a colleague (R11)', () => {
  it('whose free/busy is visible is booked directly at a time free for both, without any email', async () => {
    fillTheMornings();
    // Kim is busy for the rest of Tuesday, so Wednesday 10:00 is the first time free for both.
    calendar.sharedFreeBusy.set(KIM, [{ start: '2026-10-06T13:00:00Z', end: '2026-10-06T16:00:00Z' }]);
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(kim)));
    expect(answer).toMatchObject({ state: 'booked', booking: { start: WEDNESDAY_10AM } });
    expect(String(answer.message)).toMatch(/directly/);

    const stored = await meeting(answer.meeting_id);
    expect(stored).toMatchObject({ state: 'booked', session_id: null });
    expect(await count('gws_ea_inbox_threads')).toBe(0);
    const [event] = calendar.live(PRINCIPAL).filter((e) => e.tags?.gwsEaRole === 'booking');
    expect(event.attendees?.map((attendee) => attendee.email)).toEqual([KIM]);
    expect(event.start?.dateTime).toBe(WEDNESDAY_10AM);
    expect(calendar.writes.find((write) => write.eventId === event.id)?.sendUpdates).toBe('all');
    expect(await getBooking(stored.id)).toMatchObject({ event_id: event.id, start_at: WEDNESDAY_10AM });
  });

  it("is booked with the invitation main gives, and main's purpose as its title when it gives none", async () => {
    calendar.calendars.set(PRINCIPAL, {
      id: PRINCIPAL,
      accessRole: 'writer',
      primary: false,
      conferenceTypes: ['hangoutsMeet'],
    });
    calendar.sharedFreeBusy.set(KIM, []);
    const answer = data(
      await ask(
        main,
        'meeting_arrange',
        arrangeWith(kim, { invitation: { video_call: true, notes: 'Bring the Q4 numbers.' } }),
      ),
    );
    expect(answer.state).toBe('booked');
    const [event] = calendar.live(PRINCIPAL).filter((e) => e.tags?.gwsEaRole === 'booking');
    expect(event).toMatchObject({ summary: 'Partnership intro', description: 'Bring the Q4 numbers.' });
    expect(event.conference?.status).toBe('success');
    expect((await meeting(answer.meeting_id)).invitation).toEqual({ video_call: true, notes: 'Bring the Q4 numbers.' });
  });

  it('whose free/busy is hidden is arranged by email, as anyone else', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(lee)));
    const stored = await meeting(answer.meeting_id);
    expect(stored.state).toBe('active');
    expect(stored.session_id).not.toBeNull();
    expect(await count('gws_ea_inbox_threads')).toBe(1);
    expect(calendar.writes).toEqual([]);
  });

  it("adds a visible colleague's busy time to the times offered in a meeting with someone outside", async () => {
    fillTheMornings();
    calendar.sharedFreeBusy.set(KIM, [{ start: '2026-10-06T13:00:00Z', end: '2026-10-06T16:00:00Z' }]);
    const answer = data(
      await ask(
        main,
        'meeting_arrange',
        arrangeWith(acme, { people: [{ person_id: acme.id }, { person_id: kim.id }] }),
      ),
    );
    const session = await meetingSession(answer.meeting_id);
    const offered = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: answer.meeting_id }));
    expect(offered[0].start).toBe(WEDNESDAY_10AM);
    expect(offered.some((slot) => slot.start.startsWith('2026-10-06'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ending a meeting releases its holds
// ---------------------------------------------------------------------------

describe("a meeting's holds", () => {
  async function heldMeeting(person: Person) {
    const { meeting: stored, session } = await arranged(person);
    const [s1, s2] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: stored.id }));
    data(await ask(session, 'meeting_hold', { meeting_id: stored.id, slot_ids: [s1.slot_id, s2.slot_id] }));
    expect(holds()).toHaveLength(2);
    return { stored, session };
  }

  it('are released when main cancels the meeting', async () => {
    const { stored } = await heldMeeting(sam);
    data(await ask(main, 'meeting_cancel', { meeting_id: stored.id }));
    expect(holds()).toEqual([]);
  });

  it('are released when the meeting gives up', async () => {
    const { stored, session } = await heldMeeting(sam);
    data(await ask(session, 'meeting_outcome', { meeting_id: stored.id, outcome: 'gave-up' }));
    expect(holds()).toEqual([]);
  });

  it('are released when a person in the meeting is forgotten', async () => {
    const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-calendar-actions-secrets-'));
    fs.chmodSync(secrets, 0o700);
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(secrets, 'google-grant.json'));
    try {
      await heldMeeting(dana);
      await forgetPerson({ id: dana.id, source: 'principal' });
      expect(holds()).toEqual([]);
    } finally {
      fs.rmSync(secrets, { recursive: true, force: true });
    }
  });

  it('that no longer fit an amended length are released; a change of constraints keeps them', async () => {
    const { stored } = await heldMeeting(sam);
    data(await ask(main, 'meeting_amend', { meeting_id: stored.id, constraints: 'Video call, please.' }));
    expect(holds()).toHaveLength(2);
    data(await ask(main, 'meeting_amend', { meeting_id: stored.id, length_minutes: 60 }));
    expect(holds()).toEqual([]);
  });
});
