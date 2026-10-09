/**
 * main's tools on the principal's own events: `create_event` puts an event
 * on one of their calendars and `change_guests` changes who an event of
 * theirs invites. On every event either writes, the principal is a guest,
 * accepted, as the organizer of an event they made themselves, unless they
 * answered it otherwise themselves.
 *
 * Drives the real delivery actions, guard, capabilities and session DBs
 * against an in-memory Google Calendar. Only the container runtime and its
 * wake are mocked.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-principal-events';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-principal-events',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-principal-events/groups',
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
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDeliveryAction } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import { addPrincipalAddress, recordExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import '../gws-ea-inbox/index.js';
import './index.js';
import { FakeCalendar, type StoredEvent } from './testing/fake-calendar.js';

const PRINCIPAL = 'morgan@northwind.example';
/** A calendar of the principal's that the assistant may only read. */
const READ_ONLY = 'morgan.family@northwind.example';
/** A colleague's calendar the assistant can write to, which is not the principal's. */
const COLLEAGUE_CALENDAR = 'lena@northwind.example';
const REMY = 'remy@northwind.example';
const NOEL = 'noel@friends.example';
const PACIFIC = 'America/Los_Angeles';
/** The principal's home, which they keep private. */
const HOME = '12 Rosewood Lane';
/** The personal address of someone close to the principal, which they keep private. */
const JUNO_PERSONAL = 'juno.hale@home.example';

/** The principal on an event of theirs, as Google lists the organizer of an event they made themselves. */
const PRINCIPAL_GUEST = { email: PRINCIPAL, responseStatus: 'accepted', organizer: true };

let calendar: FakeCalendar;
let main: Session;
let external: Session;
let requests = 0;

function now(): string {
  return new Date().toISOString();
}

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

/** A timed event on the principal's calendar that `create_event` makes. */
const FOCUS = {
  calendar: PRINCIPAL,
  title: 'Focus: board deck',
  start: '2026-10-08T09:00:00-07:00',
  end: '2026-10-08T11:00:00-07:00',
};

/** An event of the principal's with these guests, each answer and note Google keeps intact, and what it says. */
function teamSync(
  guests: readonly Record<string, unknown>[],
  text: Pick<StoredEvent, 'summary' | 'description' | 'location'> = {},
): StoredEvent {
  return {
    calendarId: PRINCIPAL,
    id: 'teamsync01',
    status: 'confirmed',
    organizer: { email: PRINCIPAL },
    start: { dateTime: '2026-10-09T16:00:00.000Z' },
    end: { dateTime: '2026-10-09T16:30:00.000Z' },
    summary: 'Team sync',
    ...text,
    guests,
    attendees: guests.map((guest) => ({
      email: String(guest.email),
      responseStatus: String(guest.responseStatus),
      ...(guest.organizer === true ? { organizer: true } : {}),
    })),
  };
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());

  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
  }
  await updateContainerConfigJson('ag-external', 'capabilities', [
    'files-read',
    'time',
    'request-status',
    'gws-ea-reminders',
    'gws-ea-email-external',
  ]);
  for (const [id, channel, platform] of [
    ['mg-dm', 'gchat', 'spaces/dm'],
    ['mg-inbox', 'email', 'email:inbox'],
  ] as const) {
    await createMessagingGroup({
      id,
      channel_type: channel,
      platform_id: platform,
      name: id,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  }
  await getDb().run(
    `UPDATE gws_ea_profile
        SET main_agent_group_id = 'ag-main', assistant_display_name = 'Juno', principal_timezone = ?
      WHERE singleton = 1`,
    PACIFIC,
  );
  await recordExternalEmailAgentGroupId('ag-external');
  await addPrincipalAddress(PRINCIPAL);
  await addPrincipalAddress(READ_ONLY);

  calendar = new FakeCalendar();
  google.calendar = calendar;
  calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer', conferenceTypes: ['hangoutsMeet'] });
  calendar.calendars.set(READ_ONLY, { id: READ_ONLY, accessRole: 'reader' });
  calendar.calendars.set(COLLEAGUE_CALENDAR, { id: COLLEAGUE_CALENDAR, accessRole: 'writer' });

  main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
  external = (await resolveSession('ag-external', 'mg-inbox', 'mail-1', 'per-thread')).session;
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('create_event', () => {
  it('puts an event on the principal’s calendar with the principal its one guest, accepted, emailing no one', async () => {
    const created = data(
      await send(main, 'create_event', {
        ...FOCUS,
        notes: 'Deck review notes.',
        location: 'Home office',
        free: true,
        private: true,
      }),
    );

    const event = calendar.event(PRINCIPAL, String(created.event));
    expect(event).toMatchObject({
      summary: 'Focus: board deck',
      description: 'Deck review notes.',
      location: 'Home office',
      start: { dateTime: '2026-10-08T16:00:00.000Z' },
      end: { dateTime: '2026-10-08T18:00:00.000Z' },
      transparency: 'transparent',
      visibility: 'private',
      attendees: [PRINCIPAL_GUEST],
    });
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'insert', sendUpdates: 'none' })]);
    expect(created).toMatchObject({ calendar: PRINCIPAL, start: FOCUS.start, end: FOCUS.end });
    expect(created.message).toMatch(/^Added "Focus: board deck" to .+: Thursday 8 Oct, 09:00–11:00 PDT\./u);
    expect(created.message).toMatch(/the principal is on its guest list, accepted/u);
  });

  it('invites the guests named after the principal, repeats, and adds a Meet link', async () => {
    const created = data(
      await send(main, 'create_event', {
        ...FOCUS,
        title: 'Weekly sync',
        guests: [REMY, PRINCIPAL],
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=10'],
        video_call: true,
      }),
    );

    const event = calendar.event(PRINCIPAL, String(created.event));
    // The principal, named as a guest too, is listed once: first, accepted.
    expect(event?.attendees).toEqual([PRINCIPAL_GUEST, { email: REMY, responseStatus: 'needsAction' }]);
    expect(event?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=10']);
    expect(event?.conference?.status).toBe('success');
    expect(created.message).toMatch(new RegExp(`Its guests: ${REMY}; Google sent them the invitation\\.`, 'u'));
    expect(created.message).toMatch(/It repeats\./u);
    expect(created.message).toMatch(/with a Google Meet link \(https:\/\/meet\.google\.com\//u);
  });

  it('sends Google’s invitation when it invites anyone but the principal, and emails no one otherwise', async () => {
    const invited = data(await send(main, 'create_event', { ...FOCUS, title: 'Weekly sync', guests: [REMY] }));
    expect(calendar.writes).toEqual([
      expect.objectContaining({ op: 'insert', eventId: invited.event, sendUpdates: 'all' }),
    ]);

    // Another of the principal's own addresses is the principal: nobody else to tell.
    calendar.writes.length = 0;
    const own = data(await send(main, 'create_event', { ...FOCUS, guests: [READ_ONLY] }));
    expect(calendar.writes).toEqual([
      expect.objectContaining({ op: 'insert', eventId: own.event, sendUpdates: 'none' }),
    ]);
    expect(own.message).toMatch(new RegExp(`Its guests: ${READ_ONLY}; Google emailed no one\\.`, 'u'));
  });

  it('tells its guests once: a replayed request writes nothing more, and keeps what changed since', async () => {
    const request = { ...FOCUS, title: 'Weekly sync', guests: [REMY] };
    const first = data(await send(main, 'create_event', request, 'act-replayed'));
    // The principal moves it an hour later before the answer reaches the agent, and the request runs again.
    const made = calendar.event(PRINCIPAL, String(first.event));
    if (made === undefined) throw new Error('create_event made no event');
    const moved = { start: { dateTime: '2026-10-08T17:00:00.000Z' }, end: { dateTime: '2026-10-08T19:00:00.000Z' } };
    calendar.put({ ...made, ...moved });
    const inbound = new Database(inboundDbPath(main.agent_group_id, main.id));
    inbound.prepare('DELETE FROM messages_in WHERE id = ?').run('action-resp-act-replayed');
    inbound.close();

    expect(data(await send(main, 'create_event', request, 'act-replayed')).event).toBe(first.event);
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'insert', sendUpdates: 'all' })]);
    expect(calendar.event(PRINCIPAL, String(first.event))).toMatchObject(moved);
  });

  it.each([
    { carrier: 'title', fields: { title: `Drinks at ${HOME}` } },
    { carrier: 'notes', fields: { notes: `Come round to ${HOME}.` } },
    { carrier: 'place', fields: { location: HOME } },
    { carrier: 'calendar name', fields: {}, calendarName: `Morgan – ${HOME}` },
    { carrier: 'guest list', fields: { guests: [REMY, JUNO_PERSONAL] } },
  ])(
    'refuses, before anything reaches Google, an invitation whose $carrier would show its guests a private detail',
    async ({ fields, calendarName }) => {
      await addPrivateValue({ label: 'Home', kind: 'address', value: HOME });
      await addPrivateValue({ label: 'Juno at home', kind: 'email', value: JUNO_PERSONAL });
      if (calendarName !== undefined) {
        calendar.calendars.set(PRINCIPAL, {
          id: PRINCIPAL,
          accessRole: 'writer',
          conferenceTypes: ['hangoutsMeet'],
          summary: calendarName,
        });
      }

      const refused = refusal(await send(main, 'create_event', { ...FOCUS, guests: [REMY], ...fields }));

      expect(refused).toMatch(
        /^The event was not added: as its guests would see it, the invitation carries one of the principal's private details \((address|email)\)\./u,
      );
      expect(refused).not.toContain('Rosewood');
      expect(refused).not.toContain(JUNO_PERSONAL);
      expect(calendar.writes).toEqual([]);
      expect(calendar.events).toEqual([]);
    },
  );

  it('adds an event that holds a private detail when only the principal will see it', async () => {
    await addPrivateValue({ label: 'Home', kind: 'address', value: HOME });
    data(await send(main, 'create_event', { ...FOCUS, title: `Plumber at ${HOME}`, guests: [READ_ONLY] }));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'insert', sendUpdates: 'none' })]);
  });

  it('invites someone at their own private address: no one else sees it', async () => {
    await addPrivateValue({ label: 'Juno at home', kind: 'email', value: JUNO_PERSONAL });
    data(await send(main, 'create_event', { ...FOCUS, title: 'Anniversary dinner', guests: [JUNO_PERSONAL] }));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'insert', sendUpdates: 'all' })]);
  });

  it('refuses text whose weekday and date disagree, adding nothing', async () => {
    const refused = refusal(
      await send(main, 'create_event', { ...FOCUS, notes: 'Prep for the board on Friday 10 October 2026.' }),
    );
    expect(refused).toMatch(
      /^The event was not added: it says "Friday 10 October 2026", but 10 October 2026 is a Saturday\./u,
    );
    expect(calendar.writes).toEqual([]);
  });

  it('names both days of a timed event that ends on a later day', async () => {
    const created = data(
      await send(main, 'create_event', {
        calendar: PRINCIPAL,
        title: 'Board offsite',
        start: '2026-10-08T09:00:00-07:00',
        end: '2026-10-10T17:00:00-07:00',
      }),
    );
    expect(created.message).toMatch(/: Thursday 8 Oct, 09:00 PDT to Saturday 10 Oct, 17:00 PDT\./u);
  });

  it('makes an all-day event from its first day to its last', async () => {
    const created = data(
      await send(main, 'create_event', {
        calendar: PRINCIPAL,
        title: 'Offsite',
        all_day: true,
        start: '2026-10-12',
        end: '2026-10-13',
      }),
    );
    expect(calendar.event(PRINCIPAL, String(created.event))).toMatchObject({
      start: { date: '2026-10-12' },
      end: { date: '2026-10-14' },
      attendees: [PRINCIPAL_GUEST],
    });
    expect(created.message).toMatch(/: Monday 12 Oct to Tuesday 13 Oct, all day\./u);
  });

  it('creates one event for one request, when the host stopped before answering it', async () => {
    const first = data(await send(main, 'create_event', FOCUS, 'act-replayed'));
    // The event stands on the calendar, but the answer never reached the agent: the request runs again.
    const inbound = new Database(inboundDbPath(main.agent_group_id, main.id));
    inbound.prepare('DELETE FROM messages_in WHERE id = ?').run('action-resp-act-replayed');
    inbound.close();
    const replay = data(await send(main, 'create_event', FOCUS, 'act-replayed'));
    expect(replay.event).toBe(first.event);
    expect(calendar.live(PRINCIPAL)).toHaveLength(1);
  });

  it('adds nothing when the event a request made was deleted before the host answered it', async () => {
    const first = data(await send(main, 'create_event', FOCUS, 'act-replayed'));
    // Someone deletes the event before the answer reaches the agent, and the request runs again.
    await calendar.deleteEvent(PRINCIPAL, String(first.event), 'none');
    const inbound = new Database(inboundDbPath(main.agent_group_id, main.id));
    inbound.prepare('DELETE FROM messages_in WHERE id = ?').run('action-resp-act-replayed');
    inbound.close();

    expect(refusal(await send(main, 'create_event', FOCUS, 'act-replayed'))).toMatch(
      /has since been deleted from that calendar/u,
    );
    expect(calendar.live(PRINCIPAL)).toEqual([]);
    expect(calendar.writes.map((write) => write.op)).toEqual(['insert', 'delete']);
  });

  it('refuses a calendar that is not the principal’s, one it may only read, and one not in its list, writing nothing', async () => {
    for (const [calendarId, problem] of [
      [COLLEAGUE_CALENDAR, /not one of the principal's calendars/u],
      ['nobody@northwind.example', /not one of the principal's calendars/u],
      [READ_ONLY, /lets you see that calendar but not change it/u],
      ['not a calendar', /calendar must be a calendar ID/u],
    ] as const) {
      expect(refusal(await send(main, 'create_event', { ...FOCUS, calendar: calendarId })), calendarId).toMatch(
        problem,
      );
    }
    expect(calendar.events).toEqual([]);
  });

  it('refuses times it cannot read, a repetition that is not one, and a Meet link the calendar does not allow', async () => {
    calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'owner' });
    for (const [fields, problem] of [
      [{ start: '2026-10-08T09:00' }, /start must be a date and time with its UTC offset/u],
      [{ end: '2026-10-08T08:00:00-07:00' }, /end must come after start/u],
      [{ all_day: true, start: '2026-10-12', end: '2026-10-11' }, /end, the last day, must not come before start/u],
      [{ all_day: true, start: '2026-02-30', end: '2026-03-01' }, /start must be a date such as 2026-10-12/u],
      // 367 days: a year and a day too long, timed or all day.
      [{ end: '2027-10-10T09:00:00-07:00' }, /may last at most 366 days/u],
      [{ all_day: true, start: '2026-10-12', end: '2027-10-13' }, /may last at most 366 days/u],
      [
        { guests: Array.from({ length: 51 }, (_, index) => `guest${index}@friends.example`) },
        /guests must list 1 to 50 email addresses/u,
      ],
      [{ recurrence: ['every Thursday'] }, /recurrence must list RRULE, EXRULE, RDATE or EXDATE lines/u],
      [{ title: undefined }, /title must be text/u],
      [{ video_call: true }, /does not allow Google Meet links/u],
    ] as const) {
      expect(refusal(await send(main, 'create_event', { ...FOCUS, ...fields })), JSON.stringify(fields)).toMatch(
        problem,
      );
    }
    expect(calendar.events).toEqual([]);
  });
});

describe('change_guests', () => {
  it('adds and removes guests, keeping everyone else’s answer and note, and the principal accepted', async () => {
    calendar.put(
      teamSync([
        { email: PRINCIPAL, responseStatus: 'accepted', organizer: true, self: true },
        { email: REMY, responseStatus: 'accepted', comment: 'Running 5 late', optional: true },
        { email: 'lena@northwind.example', responseStatus: 'declined' },
      ]),
    );

    const changed = data(
      await send(main, 'change_guests', {
        calendar: PRINCIPAL,
        event: 'teamsync01',
        add: [NOEL],
        remove: ['lena@northwind.example'],
      }),
    );

    expect(calendar.writes).toEqual([
      expect.objectContaining({
        op: 'guests',
        eventId: 'teamsync01',
        sendUpdates: 'all',
        guests: [
          { email: PRINCIPAL, responseStatus: 'accepted', organizer: true, self: true },
          { email: REMY, responseStatus: 'accepted', comment: 'Running 5 late', optional: true },
          { email: NOEL },
        ],
      }),
    ]);
    expect(changed.guests).toEqual([REMY, NOEL]);
    expect(changed.message).toBe(
      `Its guests now: ${REMY} and ${NOEL}, and the principal, accepted. Google sent the guests the update.`,
    );
  });

  it('puts the principal on an event of theirs that lacks them, or lists them awaiting an answer', async () => {
    calendar.put(teamSync([{ email: REMY, responseStatus: 'accepted' }]));
    data(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] }));
    expect(calendar.event(PRINCIPAL, 'teamsync01')?.attendees).toEqual([
      PRINCIPAL_GUEST,
      { email: REMY, responseStatus: 'accepted' },
      { email: NOEL, responseStatus: 'needsAction' },
    ]);

    calendar.put(teamSync([{ email: PRINCIPAL, responseStatus: 'needsAction' }]));
    data(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [REMY] }));
    expect(calendar.event(PRINCIPAL, 'teamsync01')?.attendees?.[0]).toEqual(PRINCIPAL_GUEST);
  });

  it('keeps the answer the principal gave an event of theirs, declined or maybe, and says what it is', async () => {
    for (const [answer, words] of [
      ['declined', 'who declined it'],
      ['tentative', 'who answered maybe'],
    ] as const) {
      calendar.writes.length = 0;
      const principal = { email: PRINCIPAL, responseStatus: answer, organizer: true, self: true };
      calendar.put(teamSync([principal, { email: REMY, responseStatus: 'accepted' }]));

      const changed = data(
        await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] }),
      );
      expect(calendar.writes, answer).toEqual([
        expect.objectContaining({
          op: 'guests',
          guests: [principal, { email: REMY, responseStatus: 'accepted' }, { email: NOEL }],
        }),
      ]);
      expect(changed.message, answer).toBe(
        `Its guests now: ${REMY} and ${NOEL}, and the principal, ${words}. Google sent the guests the update.`,
      );

      // With nothing else to change, their answer is no reason to write.
      calendar.writes.length = 0;
      const unchanged = data(
        await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [REMY] }),
      );
      expect(calendar.writes, answer).toEqual([]);
      expect(unchanged.message, answer).toBe(
        `Nothing changed: ${REMY} is already invited; the principal is already on it.`,
      );
    }
  });

  it('leaves a room booked on the event as it is, and never names it as a guest', async () => {
    const room = {
      email: 'boardroom@resource.northwind.example',
      displayName: 'Boardroom',
      responseStatus: 'accepted',
      resource: true,
    };
    calendar.put(teamSync([{ email: PRINCIPAL, responseStatus: 'accepted', organizer: true }, room]));

    const changed = data(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] }));

    expect(calendar.writes).toEqual([
      expect.objectContaining({
        op: 'guests',
        guests: [{ email: PRINCIPAL, responseStatus: 'accepted', organizer: true }, room, { email: NOEL }],
      }),
    ]);
    expect(changed.guests).toEqual([NOEL]);
    expect(changed.message).toBe(
      `Its guests now: ${NOEL}, and the principal, accepted. Google sent the guests the update.`,
    );
  });

  it('writes nothing when the list already says it', async () => {
    calendar.put(teamSync([{ email: PRINCIPAL, responseStatus: 'accepted', organizer: true }]));
    const unchanged = data(
      await send(main, 'change_guests', {
        calendar: PRINCIPAL,
        event: 'teamsync01',
        add: [PRINCIPAL],
        remove: [NOEL],
      }),
    );
    expect(calendar.writes).toEqual([]);
    expect(unchanged.message).toBe(`Nothing changed: ${NOEL} is not invited; the principal is already on it.`);
  });

  it('tells the guests only of a change to who it invites, never of the principal alone', async () => {
    const principal = { email: PRINCIPAL, responseStatus: 'accepted', organizer: true, self: true };
    const remy = { email: REMY, responseStatus: 'accepted' };
    for (const [change, sendUpdates] of [
      [{ add: [NOEL] }, 'all'],
      [{ remove: [REMY] }, 'all'],
      // Another of the principal's own addresses is the principal: nobody else to tell.
      [{ add: [READ_ONLY] }, 'none'],
    ] as const) {
      calendar.writes.length = 0;
      calendar.put(teamSync([principal, remy]));
      data(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', ...change }));
      expect(calendar.writes, JSON.stringify(change)).toEqual([expect.objectContaining({ op: 'guests', sendUpdates })]);
    }

    // Only the principal's own answer is set: the guests have nothing new to hear.
    calendar.writes.length = 0;
    calendar.put(teamSync([{ ...principal, responseStatus: 'needsAction' }, remy]));
    const answered = data(
      await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [PRINCIPAL] }),
    );
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'guests', sendUpdates: 'none' })]);
    expect(answered.message).toBe(`Its guests now: ${REMY}, and the principal, accepted. Google emailed no one.`);
  });

  it.each([
    { carrier: 'title', text: { summary: `Drinks at ${HOME}` } },
    { carrier: 'notes', text: { description: `Come round to ${HOME}.` } },
    { carrier: 'place', text: { location: HOME } },
    { carrier: 'calendar name', text: {}, calendarName: `Morgan – ${HOME}` },
    { carrier: 'guest list', text: {}, guest: JUNO_PERSONAL },
  ])(
    'refuses, writing nothing, to invite anyone to an event whose $carrier holds a private detail',
    async ({ text, calendarName, guest }) => {
      await addPrivateValue({ label: 'Home', kind: 'address', value: HOME });
      await addPrivateValue({ label: 'Juno at home', kind: 'email', value: JUNO_PERSONAL });
      if (calendarName !== undefined) {
        calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer', summary: calendarName });
      }
      calendar.put(
        teamSync(
          [
            { email: PRINCIPAL, responseStatus: 'accepted', organizer: true, self: true },
            ...(guest === undefined ? [] : [{ email: guest, responseStatus: 'accepted' }]),
          ],
          text,
        ),
      );

      const refused = refusal(
        await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [REMY] }),
      );

      expect(refused).toMatch(
        /^The guests were not changed: as its guests would see it, the invitation carries one of the principal's private details \((address|email)\)\./u,
      );
      expect(refused).not.toContain('Rosewood');
      expect(refused).not.toContain(JUNO_PERSONAL);
      expect(calendar.writes).toEqual([]);
    },
  );

  it('invites someone at their own private address, unless another guest would see it beside theirs', async () => {
    await addPrivateValue({ label: 'Juno at home', kind: 'email', value: JUNO_PERSONAL });
    const principal = { email: PRINCIPAL, responseStatus: 'accepted', organizer: true, self: true };
    calendar.put(teamSync([principal], { summary: 'Anniversary dinner' }));
    data(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [JUNO_PERSONAL] }));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'guests', sendUpdates: 'all' })]);

    calendar.writes.length = 0;
    calendar.put(teamSync([principal, { email: REMY, responseStatus: 'accepted' }]));
    expect(
      refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [JUNO_PERSONAL] })),
    ).toMatch(/private details \(email\)/u);
    expect(calendar.writes).toEqual([]);
  });

  it('takes a guest off an event that holds a private detail: nobody is shown anything new', async () => {
    await addPrivateValue({ label: 'Home', kind: 'address', value: HOME });
    calendar.put(
      teamSync(
        [
          { email: PRINCIPAL, responseStatus: 'accepted', organizer: true, self: true },
          { email: REMY, responseStatus: 'accepted' },
          { email: NOEL, responseStatus: 'accepted' },
        ],
        { description: `Come round to ${HOME}.` },
      ),
    );
    data(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', remove: [NOEL] }));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'guests', sendUpdates: 'all' })]);
  });

  it('keeps a guest’s own answer and note that land between its read of the list and its write', async () => {
    const principal = { email: PRINCIPAL, responseStatus: 'accepted', organizer: true, self: true };
    calendar.put(teamSync([principal, { email: REMY, responseStatus: 'needsAction' }]));
    // Remy accepts just after the first read, then adds a note just after the second.
    calendar.changeAfterNextGuestRead(() =>
      calendar.put(teamSync([principal, { email: REMY, responseStatus: 'accepted' }])),
    );
    calendar.changeAfterNextGuestRead(() =>
      calendar.put(teamSync([principal, { email: REMY, responseStatus: 'accepted', comment: 'Bringing the deck' }])),
    );

    const changed = data(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] }));

    expect(calendar.writes).toEqual([
      expect.objectContaining({
        op: 'guests',
        guests: [principal, { email: REMY, responseStatus: 'accepted', comment: 'Bringing the deck' }, { email: NOEL }],
      }),
    ]);
    expect(changed.guests).toEqual([REMY, NOEL]);
  });

  it('refuses, writing nothing, when the list keeps changing under it', async () => {
    const principal = { email: PRINCIPAL, responseStatus: 'accepted', organizer: true };
    calendar.put(teamSync([principal, { email: REMY, responseStatus: 'needsAction' }]));
    for (const answer of ['accepted', 'tentative', 'declined']) {
      calendar.changeAfterNextGuestRead(() =>
        calendar.put(teamSync([principal, { email: REMY, responseStatus: answer }])),
      );
    }

    expect(refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] }))).toBe(
      "The event's guests kept changing while this ran: try again in a moment.",
    );
    expect(calendar.writes).toEqual([]);
    expect(calendar.event(PRINCIPAL, 'teamsync01')?.attendees).toEqual([
      principal,
      { email: REMY, responseStatus: 'declined' },
    ]);
  });

  it('refuses an event someone else organizes, the principal’s own removal, and an event that is not there', async () => {
    calendar.put({ ...teamSync([{ email: REMY, responseStatus: 'accepted' }]), organizer: { email: REMY } });
    expect(
      refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] })),
    ).toMatch(new RegExp(`${REMY} organizes that event: only they change who it invites`, 'u'));

    calendar.put(teamSync([{ email: PRINCIPAL, responseStatus: 'accepted', organizer: true }]));
    expect(
      refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', remove: [PRINCIPAL] })),
    ).toMatch(/The principal stays on their own events/u);

    expect(
      refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'nosuchevent', add: [NOEL] })),
    ).toMatch(/No event nosuchevent on that calendar/u);
    expect(refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01' }))).toMatch(
      /Give add, remove, or both/u,
    );
    expect(calendar.writes).toEqual([]);
  });
});

describe("main's calendar tools", () => {
  it('answer only a group holding the calendar capability: never external-email', async () => {
    calendar.put(teamSync([{ email: PRINCIPAL, responseStatus: 'accepted', organizer: true }]));
    expect(refusal(await send(external, 'create_event', FOCUS))).toMatch(/needs Google Calendar/u);
    expect(
      refusal(await send(external, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] })),
    ).toMatch(/needs Google Calendar/u);
    expect(calendar.writes).toEqual([]);
  });
});
