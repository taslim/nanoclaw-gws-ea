/**
 * main's tools on events: `create_event` puts an event on one of the
 * principal's calendars or the assistant's own, and `change_guests` changes
 * who an event there invites. On every event either writes on a principal
 * calendar, the principal is a guest, accepted, as the organizer of an event
 * they made themselves, unless they answered it otherwise themselves; on the
 * assistant's own calendar, they are a guest only when main invites them.
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

/** The assistant's Drive and what a signed-out visit sees, for the link check (Slice 6 KTD5). */
const workspace = vi.hoisted(() => ({ drive: undefined as unknown }));
vi.mock('../gws-ea-workspace/drive-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gws-ea-workspace/drive-api.js')>();
  const { delegatingDriveApi } = await import('../gws-ea-workspace/testing/fake-drive.js');
  return {
    ...actual,
    createDriveApi: () =>
      delegatingDriveApi(() => workspace.drive as import('../gws-ea-workspace/drive-api.js').DriveApi),
  };
});
// Nothing in these tests is public: a signed-out visit always meets a sign-in.
vi.mock('../gws-ea-workspace/probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gws-ea-workspace/probe.js')>()),
  probeLink: async () => 'sign-in',
}));

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
import { EXTERNAL_EMAIL_CAPABILITIES } from '../gws-ea-external-email/group.js';
import '../gws-ea-inbox/index.js';
import { consumeOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { closeMatter, getMatter, openMatter } from '../gws-ea-matters/db.js';
import '../gws-ea-matters/index.js';
import './index.js';
import { FakeCalendar, type StoredEvent } from './testing/fake-calendar.js';
import { FakeDrive } from '../gws-ea-workspace/testing/fake-drive.js';

const PRINCIPAL = 'morgan@northwind.example';
/** A calendar of the principal's that the assistant may only read. */
const READ_ONLY = 'morgan.family@northwind.example';
/** A colleague's calendar the assistant can write to, which is not the principal's. */
const COLLEAGUE_CALENDAR = 'lena@northwind.example';
const REMY = 'remy@northwind.example';
/** A principal calendar Google names by the undotted spelling of a Gmail address the principal listed dotted. */
const GMAIL_CALENDAR = 'morganellery@gmail.com';
const NOEL = 'noel@friends.example';
const PACIFIC = 'America/Los_Angeles';
/** The principal's home, which they keep private. */
const HOME = '12 Rosewood Lane';
/** The personal address of someone close to the principal, which they keep private. */
const JUNO_PERSONAL = 'juno.hale@home.example';
/** The assistant's own address, which names its own calendar. */
const ASSISTANT = 'juno@northwind.example';

/** The principal on an event of theirs, as Google lists the organizer of an event they made themselves. */
const PRINCIPAL_GUEST = { email: PRINCIPAL, responseStatus: 'accepted', organizer: true };
/** The assistant on an event of its own calendar, its organizer like the owner of any calendar. */
const ASSISTANT_GUEST = { email: ASSISTANT, responseStatus: 'accepted', organizer: true };
/** What every answer for an event on the assistant's own calendar says of who sees it (KTD10). */
const OWN_CALENDAR_VISIBILITY =
  'It is on your own calendar: anyone your calendar is shared with sees its details unless it is private, and in a company Workspace that can include colleagues.';

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
  // external-email as the host stamps it.
  await updateContainerConfigJson('ag-external', 'capabilities', [...EXTERNAL_EMAIL_CAPABILITIES]);
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
        SET main_agent_group_id = 'ag-main', assistant_display_name = 'Juno', assistant_workspace_email = ?,
            principal_timezone = ?
      WHERE singleton = 1`,
    ASSISTANT,
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
  calendar.calendars.set(ASSISTANT, { id: ASSISTANT, accessRole: 'owner' });

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
    expect(created.message).toMatch(/^Added "Focus: board deck" to .+: Thursday, Oct 8, 9:00–11:00 AM PDT\./u);
    expect(created.message).toMatch(/the principal is on its guest list, accepted/u);
    expect(created.message).not.toContain(OWN_CALENDAR_VISIBILITY);
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

  it('takes a calendar whose ID is another Gmail spelling of a listed address, its owner in any spelling the principal (R1)', async () => {
    await addPrincipalAddress('morgan.ellery@gmail.com');
    calendar.calendars.set(GMAIL_CALENDAR, { id: GMAIL_CALENDAR, accessRole: 'owner' });

    const created = data(
      await send(main, 'create_event', {
        ...FOCUS,
        calendar: GMAIL_CALENDAR,
        guests: ['Morgan.Ellery+focus@gmail.com', PRINCIPAL],
      }),
    );
    // Named again in another spelling, the owner is still listed once, and nobody but the principal is told.
    expect(calendar.event(GMAIL_CALENDAR, String(created.event))?.attendees).toEqual([
      { email: GMAIL_CALENDAR, responseStatus: 'accepted', organizer: true },
      { email: PRINCIPAL, responseStatus: 'needsAction' },
    ]);
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'insert', sendUpdates: 'none' })]);
    expect(created.message).toMatch(new RegExp(`Its guests: ${PRINCIPAL}; Google emailed no one\\.`, 'u'));
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

  it('refuses, before anything reaches Google, notes that link a pre-read a guest cannot open (Slice 6 R4)', async () => {
    const drive = new FakeDrive('juno@northwind.example');
    for (const person of [PRINCIPAL, REMY]) drive.addAccount(person);
    workspace.drive = drive;
    const { id } = await drive.createFile({ name: 'Pre-read', mimeType: 'application/vnd.google-apps.document' });
    const url = `https://docs.google.com/document/d/${id}/edit`;

    expect(refusal(await send(main, 'create_event', { ...FOCUS, guests: [REMY], notes: `Pre-read: ${url}` }))).toBe(
      `The event was not added: ${REMY} can't open ${url}: it isn't shared with them. Share it with them (view-only, unless they need more), leave them out, or send it without the link.`,
    );
    expect(calendar.writes).toEqual([]);

    await drive.createPermission(id, { emailAddress: REMY, role: 'reader' });
    data(await send(main, 'create_event', { ...FOCUS, guests: [REMY], notes: `Pre-read: ${url}` }));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'insert', sendUpdates: 'all' })]);
  });

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
    expect(created.message).toMatch(/: Thursday, Oct 8, 9:00 AM PDT to Saturday, Oct 10, 5:00 PM PDT\./u);
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
    expect(created.message).toMatch(/: Monday, Oct 12 to Tuesday, Oct 13, all day\./u);
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

  it('refuses a calendar neither the principal’s nor its own, one it may only read, and one not in its list, writing nothing', async () => {
    for (const [calendarId, problem] of [
      [COLLEAGUE_CALENDAR, /is not one of the principal's calendars in your list, nor your own/u],
      ['nobody@northwind.example', /is not one of the principal's calendars in your list, nor your own/u],
      [READ_ONLY, /lets you see that calendar but not change it/u],
      ['not a calendar', /calendar must be a calendar ID/u],
    ] as const) {
      expect(refusal(await send(main, 'create_event', { ...FOCUS, calendar: calendarId })), calendarId).toMatch(
        problem,
      );
    }
    expect(calendar.events).toEqual([]);
  });

  it('writes on a calendar it may change without seeing the principal’s private events, but makes no event private there', async () => {
    calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writerWithoutPrivateAccess' });

    expect(refusal(await send(main, 'create_event', { ...FOCUS, private: true }))).toMatch(
      /shared with you without its private events, so Google lets you add only events that are not private there/u,
    );
    expect(calendar.events).toEqual([]);

    const created = data(await send(main, 'create_event', FOCUS));
    const event = calendar.event(PRINCIPAL, String(created.event));
    expect(event).toMatchObject({ summary: 'Focus: board deck', attendees: [PRINCIPAL_GUEST] });
    expect(event?.visibility).toBeUndefined();
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

    // Named in another Gmail spelling on their calendar of that address, the principal is still already on it (R1).
    await addPrincipalAddress('morgan.ellery@gmail.com');
    calendar.calendars.set(GMAIL_CALENDAR, { id: GMAIL_CALENDAR, accessRole: 'owner' });
    calendar.put({
      ...teamSync([{ email: GMAIL_CALENDAR, responseStatus: 'accepted', organizer: true }]),
      calendarId: GMAIL_CALENDAR,
      organizer: { email: GMAIL_CALENDAR },
    });
    const respelled = data(
      await send(main, 'change_guests', {
        calendar: GMAIL_CALENDAR,
        event: 'teamsync01',
        add: ['Morgan.Ellery+notes@gmail.com'],
      }),
    );
    expect(calendar.writes).toEqual([]);
    expect(respelled.message).toBe('Nothing changed: the principal is already on it.');
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

    await addPrincipalAddress('morgan.ellery@gmail.com');
    calendar.calendars.set(GMAIL_CALENDAR, { id: GMAIL_CALENDAR, accessRole: 'owner' });
    calendar.put({
      ...teamSync([{ email: GMAIL_CALENDAR, responseStatus: 'accepted', organizer: true }]),
      calendarId: GMAIL_CALENDAR,
      organizer: { email: GMAIL_CALENDAR },
    });
    expect(
      refusal(
        await send(main, 'change_guests', {
          calendar: GMAIL_CALENDAR,
          event: 'teamsync01',
          remove: ['Morgan.Ellery@gmail.com'],
        }),
      ),
    ).toMatch(/The principal stays on their own events/u);

    expect(
      refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'nosuchevent', add: [NOEL] })),
    ).toMatch(/No event nosuchevent on that calendar/u);
    expect(refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01' }))).toMatch(
      /Give add, remove, or both/u,
    );
    expect(calendar.writes).toEqual([]);
  });

  it('refuses, writing nothing, a guest list Google returned incomplete: written back, it would drop the guests left out (R9)', async () => {
    calendar.put({
      ...teamSync([PRINCIPAL_GUEST, { email: REMY, responseStatus: 'accepted' }]),
      attendeesOmitted: true,
    });
    expect(refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] }))).toBe(
      "Google didn't return this event's whole guest list, so changing it could drop guests: ask the principal to change it in Google Calendar.",
    );
    expect(calendar.writes).toEqual([]);
  });

  it('refuses, having written nothing, an event deleted between its read of the list and its write', async () => {
    calendar.put(teamSync([PRINCIPAL_GUEST]));
    calendar.changeAfterNextGuestRead(() => calendar.remove(PRINCIPAL, 'teamsync01'));
    expect(refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] }))).toBe(
      'No event teamsync01 on that calendar.',
    );

    // Deleted after the list changed under it twice: still gone, not "kept changing".
    calendar.put(teamSync([PRINCIPAL_GUEST]));
    calendar.changeAfterNextGuestRead(() => calendar.put(teamSync([PRINCIPAL_GUEST, { email: REMY }])));
    calendar.changeAfterNextGuestRead(() => calendar.put(teamSync([PRINCIPAL_GUEST])));
    calendar.changeAfterNextGuestRead(() => calendar.remove(PRINCIPAL, 'teamsync01'));
    expect(refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] }))).toBe(
      'No event teamsync01 on that calendar.',
    );
    expect(calendar.writes).toEqual([]);
  });

  it('refuses an event on a calendar neither the principal’s nor its own, though it may write there', async () => {
    calendar.put({
      ...teamSync([{ email: COLLEAGUE_CALENDAR, responseStatus: 'accepted', organizer: true }]),
      calendarId: COLLEAGUE_CALENDAR,
      organizer: { email: COLLEAGUE_CALENDAR },
    });
    expect(
      refusal(await send(main, 'change_guests', { calendar: COLLEAGUE_CALENDAR, event: 'teamsync01', add: [NOEL] })),
    ).toBe(
      `${COLLEAGUE_CALENDAR} is not one of the principal's calendars in your list, nor your own: you write only on those.`,
    );
    expect(calendar.writes).toEqual([]);
  });
});

describe('respond_to_event', () => {
  /** The principal's own entry on a copy on their calendar, as Google marks it. */
  const self = (responseStatus: string, more: Record<string, unknown> = {}) => ({
    email: PRINCIPAL,
    responseStatus,
    self: true,
    ...more,
  });
  const REMY_ACCEPTED = { email: REMY, responseStatus: 'accepted', comment: 'Bringing the deck', optional: true };
  const NOEL_DECLINED = { email: NOEL, responseStatus: 'declined' };

  /** A meeting the principal organizes, after a guest moved it: Google reset their own answer. */
  function ownMeeting(answer = 'needsAction', more: Partial<StoredEvent> = {}): StoredEvent {
    return { ...teamSync([self(answer, { organizer: true }), REMY_ACCEPTED, NOEL_DECLINED]), ...more };
  }

  /** Remy's invitation, on the principal's calendar. */
  function invitation(
    entry: Record<string, unknown> = self('needsAction'),
    more: Partial<StoredEvent> = {},
  ): StoredEvent {
    const guests = [{ email: REMY, responseStatus: 'accepted', organizer: true }, entry, NOEL_DECLINED];
    return { ...teamSync(guests), id: 'remyinvite1', organizer: { email: REMY }, summary: 'Pilot review', ...more };
  }

  function answer(event: string, response: string, more: Record<string, unknown> = {}) {
    return send(main, 'respond_to_event', { calendar: PRINCIPAL, event, response, ...more });
  }

  it('puts the principal back as accepted on a meeting they organize, changing no one else and emailing no one (R2)', async () => {
    calendar.put(ownMeeting());

    const answered = data(await answer('teamsync01', 'accepted'));

    expect(calendar.writes).toEqual([
      {
        op: 'guests',
        calendarId: PRINCIPAL,
        eventId: 'teamsync01',
        sendUpdates: 'none',
        guests: [self('accepted', { organizer: true }), REMY_ACCEPTED, NOEL_DECLINED],
      },
    ]);
    expect(calendar.event(PRINCIPAL, 'teamsync01')?.guests).toEqual([
      self('accepted', { organizer: true }),
      REMY_ACCEPTED,
      NOEL_DECLINED,
    ]);
    expect(answered).toEqual({
      calendar: PRINCIPAL,
      event: 'teamsync01',
      response: 'accepted',
      message: 'Google now shows the principal as going (accepted). Google emailed no one.',
    });
  });

  it('refuses, writing nothing, a meeting they organize whose guest list Google returned incomplete', async () => {
    calendar.put(ownMeeting('needsAction', { attendeesOmitted: true }));
    expect(refusal(await answer('teamsync01', 'accepted'))).toBe(
      "Google didn't return this event's whole guest list, so changing it could drop guests: ask the principal to change it in Google Calendar.",
    );
    expect(calendar.writes).toEqual([]);
  });

  it("answers someone else's invitation by writing only the principal's own entry, and Google is asked to tell the organizer (R3)", async () => {
    calendar.put(invitation());

    const answered = data(await answer('remyinvite1', 'declined'));

    expect(calendar.writes).toEqual([
      {
        op: 'own',
        calendarId: PRINCIPAL,
        eventId: 'remyinvite1',
        sendUpdates: 'all',
        guests: [self('declined')],
      },
    ]);
    // The organizer stays Remy's, and nobody else's answer moves.
    expect(calendar.event(PRINCIPAL, 'remyinvite1')?.guests).toEqual([
      { email: REMY, responseStatus: 'accepted', organizer: true },
      self('declined'),
      NOEL_DECLINED,
    ]);
    expect(answered.message).toBe(
      'Google now shows the principal as not going (declined). Google was asked to tell the organizer.',
    );
  });

  it("emails no one when the invitation comes from another of the principal's own addresses", async () => {
    calendar.put({
      ...invitation(),
      organizer: { email: READ_ONLY },
      guests: [{ email: READ_ONLY, responseStatus: 'accepted', organizer: true }, self('needsAction')],
    });

    const answered = data(await answer('remyinvite1', 'tentative'));

    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'own', sendUpdates: 'none' })]);
    expect(answered.message).toBe('Google now shows the principal as maybe going (tentative). Google emailed no one.');
  });

  it('sends their entry back as Google holds it, under the address it names, and drops a note left with an earlier answer (KTD5)', async () => {
    const alias = 'morgan.e@northwind.example';
    calendar.put(invitation(self('accepted', { email: alias, comment: 'See you there', displayName: 'Morgan' })));

    data(await answer('remyinvite1', 'declined'));

    expect(calendar.writes).toEqual([
      expect.objectContaining({
        op: 'own',
        guests: [{ email: alias, responseStatus: 'declined', self: true, displayName: 'Morgan' }],
      }),
    ]);
  });

  it('writes nothing when the answer already holds, and says so (R6)', async () => {
    calendar.put(ownMeeting('accepted'));
    calendar.put(invitation(self('declined')));

    expect(data(await answer('teamsync01', 'accepted')).message).toBe(
      'Nothing changed: Google already shows the principal as going (accepted).',
    );
    expect(data(await answer('remyinvite1', 'declined')).message).toBe(
      'Nothing changed: Google already shows the principal as not going (declined).',
    );
    expect(calendar.writes).toEqual([]);
  });

  it('says whether the answer covers one occurrence or every occurrence of a series (R4)', async () => {
    calendar.put(invitation(self('needsAction'), { id: 'weekly1_20261012T160000Z', recurringEventId: 'weekly1' }));
    calendar.put(invitation(self('needsAction'), { id: 'weekly1', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] }));

    expect(data(await answer('weekly1_20261012T160000Z', 'accepted')).message).toBe(
      'Google now shows the principal as going (accepted) on this occurrence only. Google was asked to tell the organizer.',
    );
    expect(data(await answer('weekly1', 'accepted')).message).toBe(
      'Google now shows the principal as going (accepted) on every occurrence. Google was asked to tell the organizer.',
    );
  });

  it("refuses, writing nothing, any calendar but the principal's, one it may only read, and an event that is not there (R5)", async () => {
    calendar.put({ ...invitation(), calendarId: ASSISTANT });
    calendar.put({ ...invitation(), calendarId: COLLEAGUE_CALENDAR });
    calendar.put({ ...invitation(), calendarId: READ_ONLY });
    calendar.put({ ...invitation(), id: 'cancelled1', status: 'cancelled' });

    for (const [calendarId, event, reason] of [
      [
        ASSISTANT,
        'remyinvite1',
        "That is your own calendar: the principal's answer lives on their calendar, so answer there.",
      ],
      [
        COLLEAGUE_CALENDAR,
        'remyinvite1',
        `${COLLEAGUE_CALENDAR} is not one of the principal's calendars in your list, nor your own: you write only on those.`,
      ],
      [READ_ONLY, 'remyinvite1', 'Google lets you see that calendar but not change it.'],
      [PRINCIPAL, 'nosuchevent', 'No event nosuchevent on that calendar.'],
      [PRINCIPAL, 'cancelled1', 'No event cancelled1 on that calendar.'],
    ] as const) {
      expect(
        refusal(await send(main, 'respond_to_event', { calendar: calendarId, event, response: 'accepted' })),
        calendarId,
      ).toBe(reason);
    }
    expect(calendar.writes).toEqual([]);
  });

  it('refuses, writing nothing, an event that lists no entry of the principal’s on that calendar, and says why it may be', async () => {
    calendar.put(teamSync([REMY_ACCEPTED]));
    calendar.put({
      ...invitation(),
      guests: [{ email: REMY, responseStatus: 'accepted', organizer: true }, NOEL_DECLINED],
    });

    expect(refusal(await answer('teamsync01', 'accepted'))).toBe(
      "The principal organizes that event and isn't on its guest list, so they have no answer to set.",
    );
    expect(refusal(await answer('remyinvite1', 'accepted'))).toBe(
      "The principal isn't on that event's guest list on that calendar, as when they're invited through a group: bring it to them.",
    );

    // A calendar shared without its private events shows a private one without its guests.
    calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writerWithoutPrivateAccess' });
    expect(refusal(await answer('remyinvite1', 'accepted'))).toBe(
      "You can't see the principal on that event. That calendar is shared with you without their private events, so if it is private, only they can answer it; otherwise bring it to them.",
    );
    expect(calendar.writes).toEqual([]);
  });

  it('writes over the version it read: an unrelated change in between is read again and kept', async () => {
    calendar.put(ownMeeting());
    calendar.changeAfterNextGuestRead(() =>
      calendar.put(
        teamSync([
          self('needsAction', { organizer: true }),
          REMY_ACCEPTED,
          { email: NOEL, responseStatus: 'accepted' },
        ]),
      ),
    );

    data(await answer('teamsync01', 'accepted'));

    expect(calendar.writes).toEqual([
      expect.objectContaining({
        op: 'guests',
        guests: [self('accepted', { organizer: true }), REMY_ACCEPTED, { email: NOEL, responseStatus: 'accepted' }],
      }),
    ]);
  });

  it('stops, writing nothing, when the principal answers it themselves while it runs (KTD6)', async () => {
    calendar.put(invitation());
    calendar.changeAfterNextGuestRead(() => calendar.put(invitation(self('tentative'))));
    expect(refusal(await answer('remyinvite1', 'declined'))).toBe(
      'The principal answered maybe going (tentative) themselves while this ran, so nothing was written: their answer stands unless they ask you to change it.',
    );

    // Their own answer, landing first, is the one asked for: nothing more to write.
    calendar.put(invitation());
    calendar.changeAfterNextGuestRead(() => calendar.put(invitation(self('declined'))));
    expect(data(await answer('remyinvite1', 'declined')).message).toBe(
      'Nothing changed: Google already shows the principal as not going (declined).',
    );
    expect(calendar.writes).toEqual([]);
  });

  it('refuses, writing nothing, an event that keeps changing under it, or that is deleted before its write', async () => {
    calendar.put(ownMeeting());
    for (const remy of ['accepted', 'tentative', 'declined']) {
      calendar.changeAfterNextGuestRead(() =>
        calendar.put(teamSync([self('needsAction', { organizer: true }), { email: REMY, responseStatus: remy }])),
      );
    }
    expect(refusal(await answer('teamsync01', 'accepted'))).toBe(
      'The event kept changing while this ran: try again in a moment.',
    );

    calendar.put(invitation());
    calendar.changeAfterNextGuestRead(() => calendar.remove(PRINCIPAL, 'remyinvite1'));
    expect(refusal(await answer('remyinvite1', 'accepted'))).toBe('No event remyinvite1 on that calendar.');
    expect(calendar.writes).toEqual([]);
  });

  it('says the answer is unconfirmed, not refused, when Google takes it but cannot show it back', async () => {
    calendar.put(invitation());
    const read = calendar.getGuests.bind(calendar);
    let reads = 0;
    vi.spyOn(calendar, 'getGuests').mockImplementation(async (calendarId, eventId) => {
      reads += 1;
      if (reads === 2) throw new GoogleApiError(503, 'Google refused the read: Backend Error');
      return read(calendarId, eventId);
    });

    const answered = data(await answer('remyinvite1', 'accepted'));

    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'own' })]);
    expect(answered.message).toBe(
      'Google took the answer but could not show it back just now, so check it with gog calendar event before you tell the principal. Google was asked to tell the organizer.',
    );
  });

  it('refuses when the event is deleted between its answer and the read back', async () => {
    calendar.put(invitation());
    const write = calendar.setOwnEntry.bind(calendar);
    vi.spyOn(calendar, 'setOwnEntry').mockImplementationOnce(async (...args) => {
      const written = await write(...args);
      calendar.remove(PRINCIPAL, 'remyinvite1');
      return written;
    });

    expect(refusal(await answer('remyinvite1', 'accepted'))).toBe('No event remyinvite1 on that calendar.');
  });

  it('reports, as a refusal, an answer Google did not keep', async () => {
    calendar.put(invitation());
    vi.spyOn(calendar, 'setOwnEntry').mockResolvedValueOnce('set');

    expect(refusal(await answer('remyinvite1', 'accepted'))).toBe(
      "Google took the answer but still shows the principal as not yet answered (needsAction), so it didn't take: ask them to answer it in Google Calendar.",
    );
  });

  it('records no change of its own: a notice of the event after an answer still reaches main (KTD7)', async () => {
    calendar.put(invitation());
    data(await answer('remyinvite1', 'accepted'));
    expect(consumeOwnCalendarChange(PRINCIPAL, 'remyinvite1', new Date())).toBe(false);
  });

  it('joins a matter on a write and on an answer that already holds, and refuses an unknown one before writing', async () => {
    const { matter } = await openMatter({ title: 'Pilot', openLoop: 'Remy reviews the pilot.', links: [] });
    calendar.put(invitation());
    calendar.put(ownMeeting('accepted'));

    expect(data(await answer('remyinvite1', 'accepted', { matter: matter.id })).message).toMatch(
      new RegExp(` It joins matter ${matter.id}\\.$`, 'u'),
    );
    expect(data(await answer('teamsync01', 'accepted', { matter: matter.id })).message).toMatch(
      new RegExp(` It joins matter ${matter.id}\\.$`, 'u'),
    );
    expect(((await getMatter(matter.id))?.links ?? []).map((link) => link.reference)).toEqual([
      `${PRINCIPAL}/remyinvite1`,
      `${PRINCIPAL}/teamsync01`,
    ]);

    calendar.writes.length = 0;
    calendar.put(invitation());
    expect(refusal(await answer('remyinvite1', 'declined', { matter: 'm-000000000000' }))).toMatch(
      /There is no matter m-000000000000/u,
    );
    expect(calendar.writes).toEqual([]);
  });

  it('refuses a response that is not an answer, and a request missing its calendar or event', async () => {
    calendar.put(invitation());
    for (const response of ['needsAction', 'yes', undefined]) {
      expect(refusal(await answer('remyinvite1', response as string))).toBe(
        'response must be accepted, tentative or declined',
      );
    }
    expect(refusal(await send(main, 'respond_to_event', { event: 'remyinvite1', response: 'accepted' }))).toMatch(
      /calendar must be a calendar ID/u,
    );
    expect(refusal(await send(main, 'respond_to_event', { calendar: PRINCIPAL, response: 'accepted' }))).toMatch(
      /event must be the event's id/u,
    );
    expect(calendar.writes).toEqual([]);
  });
});

describe('the assistant’s own calendar (R19)', () => {
  it('puts an event there with itself its one guest, no principal, emailing no one, and says who sees it', async () => {
    const created = data(await send(main, 'create_event', { ...FOCUS, calendar: ASSISTANT }));

    expect(calendar.event(ASSISTANT, String(created.event))?.attendees).toEqual([ASSISTANT_GUEST]);
    expect(calendar.writes).toEqual([
      expect.objectContaining({ op: 'insert', calendarId: ASSISTANT, sendUpdates: 'none' }),
    ]);
    expect(created).toMatchObject({ calendar: ASSISTANT, start: FOCUS.start, end: FOCUS.end });
    expect(created.message).toBe(
      `Added "Focus: board deck" to ${ASSISTANT}: Thursday, Oct 8, 9:00–11:00 AM PDT. ${OWN_CALENDAR_VISIBILITY} Change who it invites with change_guests, event ${String(created.event)}; anything else with gog calendar update.`,
    );
  });

  it('invites the principal only when named, and takes their time only through the copy Google’s invitation puts on their calendar', async () => {
    const invited = data(
      await send(main, 'create_event', { ...FOCUS, calendar: ASSISTANT, title: 'Board prep', guests: [PRINCIPAL] }),
    );
    const alone = data(
      await send(main, 'create_event', {
        calendar: ASSISTANT,
        title: 'Draft the agenda',
        start: '2026-10-08T11:00:00-07:00',
        end: '2026-10-08T12:00:00-07:00',
      }),
    );
    const made = calendar.event(ASSISTANT, String(invited.event));
    if (made === undefined) throw new Error('create_event made no event');
    // A guest like any other: Google sends them the invitation.
    expect(made.attendees).toEqual([ASSISTANT_GUEST, { email: PRINCIPAL, responseStatus: 'needsAction' }]);
    expect(calendar.writes).toEqual([
      expect.objectContaining({ op: 'insert', eventId: invited.event, sendUpdates: 'all' }),
      expect.objectContaining({ op: 'insert', eventId: alone.event, sendUpdates: 'none' }),
    ]);
    expect(invited.message).toMatch(new RegExp(`Its guests: ${PRINCIPAL}; Google sent them the invitation\\.`, 'u'));

    // Google's invitation puts a copy of the event on the principal's calendar.
    calendar.put({ ...made, calendarId: PRINCIPAL });
    const read = vi.spyOn(calendar, 'listEventDetails');
    const facts = data(
      await send(main, 'find_conflicts', { start: '2026-10-08T09:00:00-07:00', end: '2026-10-08T12:00:00-07:00' }),
    );
    expect(facts.conflicts).toEqual([expect.objectContaining({ calendars: [PRINCIPAL], ical_uid: made.iCalUID })]);
    expect(read.mock.calls.map(([calendarId]) => calendarId)).not.toContain(ASSISTANT);
  });

  it('changes who an event there invites, telling the principal like any guest, and keeps itself on it', async () => {
    const event = String(
      data(await send(main, 'create_event', { ...FOCUS, calendar: ASSISTANT, guests: [REMY] })).event,
    );

    calendar.writes.length = 0;
    const changed = data(await send(main, 'change_guests', { calendar: ASSISTANT, event, add: [PRINCIPAL] }));
    expect(calendar.writes).toEqual([
      expect.objectContaining({
        op: 'guests',
        sendUpdates: 'all',
        guests: [ASSISTANT_GUEST, { email: REMY, responseStatus: 'needsAction' }, { email: PRINCIPAL }],
      }),
    ]);
    expect(changed.guests).toEqual([REMY, PRINCIPAL]);
    expect(changed.message).toBe(`Its guests now: ${REMY} and ${PRINCIPAL}. Google sent the guests the update.`);

    calendar.writes.length = 0;
    const without = data(await send(main, 'change_guests', { calendar: ASSISTANT, event, remove: [PRINCIPAL] }));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'guests', sendUpdates: 'all' })]);
    expect(without.message).toBe(`Its guests now: ${REMY}. Google sent the guests the update.`);

    calendar.writes.length = 0;
    expect(data(await send(main, 'change_guests', { calendar: ASSISTANT, event, add: [REMY] })).message).toBe(
      `Nothing changed: ${REMY} is already invited; you are already on it.`,
    );
    expect(refusal(await send(main, 'change_guests', { calendar: ASSISTANT, event, remove: [ASSISTANT] }))).toBe(
      'You stay on the events on your own calendar: you organize them.',
    );
    expect(calendar.writes).toEqual([]);
  });

  it('runs the private-details check on every invitee but the principal, for either tool', async () => {
    await addPrivateValue({ label: 'Home', kind: 'address', value: HOME });
    const dinner = { ...FOCUS, calendar: ASSISTANT, title: 'Dinner', location: HOME };

    expect(refusal(await send(main, 'create_event', { ...dinner, guests: [NOEL] }))).toMatch(
      /^The event was not added: as its guests would see it, the invitation carries one of the principal's private details \(address\)\./u,
    );
    expect(calendar.writes).toEqual([]);

    const event = String(data(await send(main, 'create_event', dinner)).event);
    calendar.writes.length = 0;
    expect(refusal(await send(main, 'change_guests', { calendar: ASSISTANT, event, add: [NOEL] }))).toMatch(
      /^The guests were not changed: as its guests would see it, the invitation carries one of the principal's private details \(address\)\./u,
    );
    expect(calendar.writes).toEqual([]);

    // The principal may see anything of theirs.
    data(await send(main, 'change_guests', { calendar: ASSISTANT, event, add: [PRINCIPAL] }));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'guests', sendUpdates: 'all' })]);
  });

  it('records no change of its own there, so a guest’s answer minutes later still reaches main (AE5, KTD12)', async () => {
    const minutesLater = (): Date => new Date(Date.now() + 5 * 60_000);
    const own = String(data(await send(main, 'create_event', { ...FOCUS, calendar: ASSISTANT, guests: [NOEL] })).event);
    expect(consumeOwnCalendarChange(ASSISTANT, own, minutesLater())).toBe(false);
    data(await send(main, 'change_guests', { calendar: ASSISTANT, event: own, add: [REMY] }));
    expect(consumeOwnCalendarChange(ASSISTANT, own, minutesLater())).toBe(false);

    // On the principal's calendar, Google's notification of the assistant's own write is still its own.
    const theirs = String(data(await send(main, 'create_event', { ...FOCUS, guests: [NOEL] })).event);
    expect(consumeOwnCalendarChange(PRINCIPAL, theirs, minutesLater())).toBe(true);
    // An event no earlier test has changed, so the record is this write's.
    calendar.put({ ...teamSync([PRINCIPAL_GUEST]), id: 'replysync01' });
    data(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'replysync01', add: [NOEL] }));
    expect(consumeOwnCalendarChange(PRINCIPAL, 'replysync01', minutesLater())).toBe(true);
  });
});

describe('an open matter main names (KTD11)', () => {
  async function boardDeck(): Promise<string> {
    const { matter } = await openMatter({
      title: 'Board deck',
      openLoop: 'Morgan presents it Friday.\nFocus time, then a dry run with Remy.',
      links: [],
    });
    return matter.id;
  }

  async function linked(matterId: string): Promise<string[]> {
    return ((await getMatter(matterId))?.links ?? []).map((link) => `${link.kind} ${link.reference}`);
  }

  it('is joined by the event create_event adds and the event change_guests changes', async () => {
    const matterId = await boardDeck();
    calendar.put(teamSync([PRINCIPAL_GUEST]));

    const created = data(await send(main, 'create_event', { ...FOCUS, matter: matterId }));
    const changed = data(
      await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [REMY], matter: matterId }),
    );

    expect(await linked(matterId)).toEqual([
      `event ${PRINCIPAL}/${String(created.event)}`,
      `event ${PRINCIPAL}/teamsync01`,
    ]);
    expect(created.message).toMatch(new RegExp(` It joins matter ${matterId}\\.$`, 'u'));
    expect(changed.message).toMatch(new RegExp(` It joins matter ${matterId}\\.$`, 'u'));
  });

  it('is refused, writing nothing, when it is no matter id, names no matter, or names a closed one', async () => {
    const closed = await boardDeck();
    await closeMatter({ id: closed, outcome: 'Presented.' });
    calendar.put(teamSync([PRINCIPAL_GUEST]));

    for (const [matter, reason] of [
      ['Board deck', 'matter must be the id of an open matter, such as m-1a2b3c4d5e6f'],
      [42, 'matter must be the id of an open matter, such as m-1a2b3c4d5e6f'],
      [
        'm-000000000000',
        'There is no matter m-000000000000: name an open one by its id, as ncl matters list gives it.',
      ],
      [closed, `${closed} is closed: a next look reopens it before anything joins it.`],
    ] as const) {
      expect(refusal(await send(main, 'create_event', { ...FOCUS, matter }))).toBe(reason);
      expect(
        refusal(await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [REMY], matter })),
      ).toBe(reason);
    }
    expect(calendar.writes).toEqual([]);
  });

  it('that closes while create_event writes, leaves the event standing, and the answer says it did not join', async () => {
    const matterId = await boardDeck();
    const insert = calendar.insertEvent.bind(calendar);
    // The matter was open when the request was checked, and closes before the event joins it.
    vi.spyOn(calendar, 'insertEvent').mockImplementationOnce(async (...args) => {
      await closeMatter({ id: matterId, outcome: 'Presented.' });
      return insert(...args);
    });

    const created = data(await send(main, 'create_event', { ...FOCUS, matter: matterId }));

    expect(created.message).toMatch(new RegExp(` It did not join matter ${matterId}: .+\\.$`, 'u'));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'insert', eventId: created.event })]);
    expect(calendar.event(PRINCIPAL, String(created.event))).toMatchObject({ summary: FOCUS.title });
    expect(await linked(matterId)).toEqual([]);
  });

  it("is refused from any group but main, though it holds Google Calendar: matters are main's alone (R8)", async () => {
    await createAgentGroup({ id: 'ag-other', name: 'other', folder: 'other', agent_provider: null, created_at: now() });
    await ensureContainerConfig('ag-other');
    const other = (await resolveSession('ag-other', 'mg-dm', null, 'agent-shared')).session;
    const matterId = await boardDeck();

    expect(refusal(await send(other, 'create_event', { ...FOCUS, matter: matterId }))).toBe(
      'Only main keeps matters, so only main names one.',
    );
    expect(calendar.writes).toEqual([]);
    expect(await linked(matterId)).toEqual([]);
  });
});

describe("main's calendar tools", () => {
  it('answer only a group holding the calendar capability: never external-email', async () => {
    calendar.put(teamSync([{ email: PRINCIPAL, responseStatus: 'accepted', organizer: true }]));
    expect(refusal(await send(external, 'create_event', FOCUS))).toMatch(/needs Google Calendar/u);
    expect(
      refusal(await send(external, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] })),
    ).toMatch(/needs Google Calendar/u);
    expect(
      refusal(
        await send(external, 'respond_to_event', { calendar: PRINCIPAL, event: 'teamsync01', response: 'accepted' }),
      ),
    ).toMatch(/needs Google Calendar/u);
    expect(calendar.writes).toEqual([]);
  });
});
