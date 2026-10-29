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

/** The assistant's Drive and what a signed-out visit sees, for the link check. */
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
import * as capabilityStorage from '../../capabilities.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDeliveryAction } from '../../delivery.js';
import { inboundDbPath, outboundDbPath, sessionMailboxDir } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import { addPrincipalAddress, recordExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { EXTERNAL_EMAIL_CAPABILITIES } from '../gws-ea-external-email/group.js';
import '../gws-ea-inbox/index.js';
import { consumeOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { addPerson, forgetPerson } from '../gws-ea-people/db.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { setSchedulingPreference } from '../gws-ea-preferences/db.js';
import { addStay } from '../gws-ea-whereabouts/db.js';
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
/** What every answer for an event on the assistant's own calendar says of who sees it. */
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

function followingRequest(id: string, properties: Partial<StoredEvent> = {}): Record<string, unknown> {
  const master = {
    ...teamSync([PRINCIPAL_GUEST]),
    ...properties,
    id,
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'],
    start: { dateTime: '2026-10-02T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-02T16:30:00Z', timeZone: PACIFIC },
  };
  calendar.put(master);
  calendar.put({
    ...master,
    id: `${id}_2`,
    recurrence: undefined,
    recurringEventId: id,
    originalStartTime: { dateTime: '2026-10-16T16:00:00Z' },
    start: { dateTime: '2026-10-16T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-16T16:30:00Z', timeZone: PACIFIC },
  });
  return {
    calendar: PRINCIPAL,
    event: `${id}_2`,
    start: '2026-10-16T10:00:00-07:00',
    end: '2026-10-16T10:30:00-07:00',
    scope: 'following',
    send_updates: 'all',
  };
}

function responseFor(session: Session, requestId: string): ResponseFrame | undefined {
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    const row = inbound.prepare('SELECT content FROM messages_in WHERE id=?').get(`action-resp-${requestId}`) as
      | { content: string }
      | undefined;
    return row ? (JSON.parse(row.content) as { frame: ResponseFrame }).frame : undefined;
  } finally {
    inbound.close();
  }
}

function deferredSignal() {
  let complete: () => void;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: () => complete() };
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
        SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = 'ag-main', assistant_first_name = 'Juno', assistant_last_name = NULL, assistant_workspace_email = ?,
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
  it('confirms an applied insert after a lost reply before caching its first action answer', async () => {
    calendar.failNext({ op: 'insert', afterApplying: true, error: new Error('The insert reply was lost.') });
    const request = { ...FOCUS, guests: [REMY] };
    const first = data(await send(main, 'create_event', request, 'create-lost-reply'));
    const second = data(await send(main, 'create_event', request, 'create-lost-reply'));
    expect(first.message).toContain('Added');
    expect(second).toEqual(first);
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'insert', sendUpdates: 'all' })]);
    expect(calendar.event(PRINCIPAL, String(first.event))?.status).toBe('confirmed');
  });
  it('confirms guest and response writes after lost replies without issuing either write twice', async () => {
    calendar.put(teamSync([PRINCIPAL_GUEST]));
    calendar.failNext({ op: 'guests', afterApplying: true, error: new Error('The guest reply was lost.') });
    const guests = { calendar: PRINCIPAL, event: 'teamsync01', add: [REMY] };
    const first = data(await send(main, 'change_guests', guests, 'guest-lost-reply'));
    expect(data(await send(main, 'change_guests', guests, 'guest-lost-reply'))).toEqual(first);
    expect(first.guests).toEqual([REMY]);
    calendar.put({
      ...teamSync([
        { email: PRINCIPAL, self: true, responseStatus: 'needsAction' },
        { email: REMY, organizer: true, responseStatus: 'accepted' },
      ]),
      id: 'foreigninvite',
      organizer: { email: REMY },
    });
    calendar.failNext({ op: 'own', afterApplying: true, error: new Error('The response reply was lost.') });
    const answer = { calendar: PRINCIPAL, event: 'foreigninvite', response: 'declined' };
    const response = data(await send(main, 'respond_to_event', answer, 'response-lost-reply'));
    expect(data(await send(main, 'respond_to_event', answer, 'response-lost-reply'))).toEqual(response);
    expect(response.response).toBe('declined');
    expect(calendar.writes.map((write) => write.op)).toEqual(['guests', 'own']);
  });
  it('creates a future event on its covering stay clock without changing the home profile', async () => {
    await addStay({
      locality: 'Brussels',
      zone: 'Europe/Brussels',
      start: '2032-11-10',
      end: '2032-11-15',
      source: 'said',
      certainty: 'certain',
    });
    data(
      await send(main, 'create_event', {
        calendar: PRINCIPAL,
        title: 'Call with Juno',
        start: '2032-11-12T09:00:00+01:00',
        end: '2032-11-12T09:30:00+01:00',
      }),
    );
    expect(calendar.writes[0].fields?.timeZone).toBe('Europe/Brussels');
    expect(await getDb().get('SELECT principal_timezone FROM gws_ea_profile')).toMatchObject({
      principal_timezone: PACIFIC,
    });
  });
  it('uses the same spoken calendar names as conflict answers, without an address', async () => {
    calendar.calendars.set(READ_ONLY, { id: READ_ONLY, accessRole: 'reader', summary: 'Family calendar' });
    const listed = vi.spyOn(calendar, 'listCalendars');
    const created = data(await send(main, 'create_event', FOCUS));

    expect(created.message).toContain("to the principal's calendar at northwind.example:");
    expect(created.message).not.toContain(PRINCIPAL);
    expect(listed).toHaveBeenCalledTimes(2);
  });

  it('marks a calendar name supplied by Google as untrusted', async () => {
    calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer', summary: 'Work calendar' });
    const created = data(await send(main, 'create_event', FOCUS));

    expect(created.message).toMatch(
      /to <<<EXTERNAL_UNTRUSTED_CONTENT id="([0-9a-f]{16})">>>\nSource: google_calendar\n---\nWork calendar\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>:/u,
    );
  });

  it('still confirms the event without exposing an address when calendar listing fails', async () => {
    vi.spyOn(calendar, 'listCalendars').mockRejectedValueOnce(new Error('Calendar list unavailable'));
    const created = data(await send(main, 'create_event', FOCUS));

    expect(created.message).toContain('Added "Focus: board deck"');
    expect(created.message).not.toContain(PRINCIPAL);
    expect(calendar.event(PRINCIPAL, String(created.event))).toMatchObject({ summary: FOCUS.title });
  });

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

  it('takes a calendar whose ID is another Gmail spelling of a listed address, its owner in any spelling the principal', async () => {
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
        /^The event was not added: as its guests would see it, the invitation carries the principal's private (address|email address)\./u,
      );
      expect(refused).not.toContain('Rosewood');
      expect(refused).not.toContain(JUNO_PERSONAL);
      expect(calendar.writes).toEqual([]);
      expect(calendar.events).toEqual([]);
    },
  );

  it('refuses, before anything reaches Google, notes that link a pre-read a guest cannot open', async () => {
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
    expect(changed.message).toContain(
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
      expect(changed.message, answer).toContain(
        `Its guests now: ${REMY} and ${NOEL}, and the principal, ${words}. Google sent the guests the update.`,
      );

      // With nothing else to change, their answer is no reason to write.
      calendar.writes.length = 0;
      const unchanged = data(
        await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [REMY] }),
      );
      expect(calendar.writes, answer).toEqual([]);
      expect(unchanged.message, answer).toContain(
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
    expect(changed.message).toContain(
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
    expect(unchanged.message).toContain(`Nothing changed: ${NOEL} is not invited; the principal is already on it.`);

    // Named in another Gmail spelling on their calendar of that address, the principal is still already on it.
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
    expect(respelled.message).toContain('Nothing changed: the principal is already on it.');
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
    expect(answered.message).toContain(`Its guests now: ${REMY}, and the principal, accepted. Google emailed no one.`);
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
        /^The guests were not changed: as its guests would see it, the invitation carries the principal's private (address|email address)\./u,
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
    ).toMatch(/the principal's private email address\./u);
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
    const organizerRefusal = refusal(
      await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [NOEL] }),
    );
    expect(organizerRefusal).toContain(`Source: google_calendar\n---\n${REMY}`);
    expect(organizerRefusal).toContain('organizes that event: only they change who it invites');

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

  it('refuses, writing nothing, a guest list Google returned incomplete: written back, it would drop the guests left out', async () => {
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

  it('puts the principal back as accepted on a meeting they organize, changing no one else and emailing no one', async () => {
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
      message: expect.stringContaining('Google now shows the principal as going (accepted). Google emailed no one.'),
    });
  });

  it('refuses, writing nothing, a meeting they organize whose guest list Google returned incomplete', async () => {
    calendar.put(ownMeeting('needsAction', { attendeesOmitted: true }));
    expect(refusal(await answer('teamsync01', 'accepted'))).toBe(
      "Google didn't return this event's whole guest list, so changing it could drop guests: ask the principal to change it in Google Calendar.",
    );
    expect(calendar.writes).toEqual([]);
  });

  it("answers someone else's invitation by writing only the principal's own entry, and Google is asked to tell the organizer", async () => {
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
    expect(answered.message).toContain(
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
    expect(answered.message).toContain(
      'Google now shows the principal as maybe going (tentative). Google emailed no one.',
    );
  });

  it('sends their entry back as Google holds it, under the address it names, and drops a note left with an earlier answer', async () => {
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

  it('writes nothing when the answer already holds, and says so', async () => {
    calendar.put(ownMeeting('accepted'));
    calendar.put(invitation(self('declined')));

    expect(data(await answer('teamsync01', 'accepted')).message).toContain(
      'Nothing changed: Google already shows the principal as going (accepted).',
    );
    expect(data(await answer('remyinvite1', 'declined')).message).toContain(
      'Nothing changed: Google already shows the principal as not going (declined).',
    );
    expect(calendar.writes).toEqual([]);
  });

  it('says whether the answer covers one occurrence or every occurrence of a series', async () => {
    calendar.put(invitation(self('needsAction'), { id: 'weekly1_20261012T160000Z', recurringEventId: 'weekly1' }));
    calendar.put(invitation(self('needsAction'), { id: 'weekly1', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] }));

    expect(data(await answer('weekly1_20261012T160000Z', 'accepted')).message).toContain(
      'Google now shows the principal as going (accepted) on this occurrence only. Google was asked to tell the organizer.',
    );
    expect(data(await answer('weekly1', 'accepted')).message).toContain(
      'Google now shows the principal as going (accepted) on every occurrence. Google was asked to tell the organizer.',
    );
  });

  it("refuses, writing nothing, any calendar but the principal's, one it may only read, and an event that is not there", async () => {
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

  it('stops, writing nothing, when the principal answers it themselves while it runs', async () => {
    calendar.put(invitation());
    calendar.changeAfterNextGuestRead(() => calendar.put(invitation(self('tentative'))));
    expect(refusal(await answer('remyinvite1', 'declined'))).toBe(
      'The principal answered maybe going (tentative) themselves while this ran, so nothing was written: their answer stands unless they ask you to change it.',
    );

    // Their own answer, landing first, is the one asked for: nothing more to write.
    calendar.put(invitation());
    calendar.changeAfterNextGuestRead(() => calendar.put(invitation(self('declined'))));
    expect(data(await answer('remyinvite1', 'declined')).message).toContain(
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
    expect(answered.message).toContain(
      'Google took the answer but could not show it back just now, so check it with days before you tell the principal. Google was asked to tell the organizer.',
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

  it('records no change of its own: a notice of the event after an answer still reaches main', async () => {
    calendar.put(invitation());
    data(await answer('remyinvite1', 'accepted'));
    expect(consumeOwnCalendarChange(PRINCIPAL, 'remyinvite1', new Date())).toBe(false);
  });

  it('joins a matter on a write and on an answer that already holds, and refuses an unknown one before writing', async () => {
    const { matter } = await openMatter({ title: 'Pilot', openLoop: 'Remy reviews the pilot.', links: [] });
    calendar.put(invitation());
    calendar.put(ownMeeting('accepted'));

    expect(data(await answer('remyinvite1', 'accepted', { matter: matter.id })).message).toMatch(
      new RegExp(` It joins matter ${matter.id}\\.`, 'u'),
    );
    expect(data(await answer('teamsync01', 'accepted', { matter: matter.id })).message).toMatch(
      new RegExp(` It joins matter ${matter.id}\\.`, 'u'),
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

describe('the assistant’s own calendar', () => {
  it('puts an event there with itself its one guest, no principal, emailing no one, and says who sees it', async () => {
    const created = data(await send(main, 'create_event', { ...FOCUS, calendar: ASSISTANT }));

    expect(calendar.event(ASSISTANT, String(created.event))?.attendees).toEqual([ASSISTANT_GUEST]);
    expect(calendar.writes).toEqual([
      expect.objectContaining({ op: 'insert', calendarId: ASSISTANT, sendUpdates: 'none' }),
    ]);
    expect(created).toMatchObject({ calendar: ASSISTANT, start: FOCUS.start, end: FOCUS.end });
    expect(created.message).toContain(
      `Added "Focus: board deck" to your own calendar: Thursday, Oct 8, 9:00–11:00 AM PDT. ${OWN_CALENDAR_VISIBILITY} Change who it invites with change_guests, event ${String(created.event)}; anything else with change_event.`,
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
    const { createCalendarFactTools } = await import('./calendar-facts.js');
    const facts = await createCalendarFactTools({ calendar: () => calendar }).findConflicts({
      start: '2026-10-08T09:00:00-07:00',
      end: '2026-10-08T12:00:00-07:00',
    });
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
    expect(changed.message).toContain(`Its guests now: ${REMY} and ${PRINCIPAL}. Google sent the guests the update.`);

    calendar.writes.length = 0;
    const without = data(await send(main, 'change_guests', { calendar: ASSISTANT, event, remove: [PRINCIPAL] }));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'guests', sendUpdates: 'all' })]);
    expect(without.message).toContain(`Its guests now: ${REMY}. Google sent the guests the update.`);

    calendar.writes.length = 0;
    expect(data(await send(main, 'change_guests', { calendar: ASSISTANT, event, add: [REMY] })).message).toContain(
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
      /^The event was not added: as its guests would see it, the invitation carries the principal's private address\./u,
    );
    expect(calendar.writes).toEqual([]);

    const event = String(data(await send(main, 'create_event', dinner)).event);
    calendar.writes.length = 0;
    expect(refusal(await send(main, 'change_guests', { calendar: ASSISTANT, event, add: [NOEL] }))).toMatch(
      /^The guests were not changed: as its guests would see it, the invitation carries the principal's private address\./u,
    );
    expect(calendar.writes).toEqual([]);

    // The principal may see anything of theirs.
    data(await send(main, 'change_guests', { calendar: ASSISTANT, event, add: [PRINCIPAL] }));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'guests', sendUpdates: 'all' })]);
  });

  it('records no change of its own there, so a guest’s answer minutes later still reaches main', async () => {
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

describe('an open matter main names', () => {
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
    expect(created.message).toMatch(new RegExp(` It joins matter ${matterId}\\.`, 'u'));
    expect(changed.message).toMatch(new RegExp(` It joins matter ${matterId}\\.`, 'u'));
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

    expect(created.message).toMatch(new RegExp(` It did not join matter ${matterId}: .+\\.`, 'u'));
    expect(calendar.writes).toEqual([expect.objectContaining({ op: 'insert', eventId: created.event })]);
    expect(calendar.event(PRINCIPAL, String(created.event))).toMatchObject({ summary: FOCUS.title });
    expect(await linked(matterId)).toEqual([]);
  });

  it("is refused from any group but main, though it holds Google Calendar: matters are main's alone", async () => {
    await createAgentGroup({ id: 'ag-other', name: 'other', folder: 'other', agent_provider: null, created_at: now() });
    await ensureContainerConfig('ag-other');
    const other = (await resolveSession('ag-other', 'mg-dm', null, 'agent-shared')).session;
    const matterId = await boardDeck();

    expect(refusal(await send(other, 'create_event', { ...FOCUS, matter: matterId }))).toBe(
      'Only main reads and changes the principal’s calendar through these tools.',
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

describe('calendar outcomes and findings', () => {
  it('keeps a created event successful when findings fail, and a replay never writes twice', async () => {
    const failed = vi.spyOn(calendar, 'listEventDetails').mockRejectedValue(new Error('checker read unavailable'));
    const first = data(await send(main, 'create_event', FOCUS, 'act-gap'));
    expect(first.message).toContain('Added');
    expect(first.message).toContain('findings unavailable');
    const { listCalendarWriteGaps } = await import('./week/write-log.js');
    expect(await listCalendarWriteGaps()).toMatchObject([{ requestId: 'act-gap', eventId: first.event }]);
    const inbound = new Database(inboundDbPath(main.agent_group_id, main.id));
    inbound.prepare('DELETE FROM messages_in WHERE id = ?').run('action-resp-act-gap');
    inbound.close();
    const replay = data(await send(main, 'create_event', FOCUS, 'act-gap'));
    expect(replay.event).toBe(first.event);
    expect(calendar.writes.filter((w) => w.op === 'insert')).toHaveLength(1);
    failed.mockRestore();
  });
  it('moves a guest meeting over the observed version, reports guest response and Google notification choice, then checks both days', async () => {
    calendar.put(teamSync([PRINCIPAL_GUEST, { email: REMY, responseStatus: 'tentative' }]));
    const result = data(
      await send(main, 'change_event', {
        calendar: PRINCIPAL,
        event: 'teamsync01',
        start: '2026-10-10T09:00:00-07:00',
        end: '2026-10-10T09:30:00-07:00',
        send_updates: 'all',
      }),
    );
    expect(result.message).toMatch(/^People this affects:/);
    expect(result.message).toContain('tentative');
    expect(result.message).toContain('Google notified');
    expect(result.message).toContain('2026-10-09');
    expect(result.message).toContain('2026-10-10');
    expect(calendar.event(PRINCIPAL, 'teamsync01')?.start?.dateTime).toBe('2026-10-10T16:00:00.000Z');
    expect(calendar.writes).toMatchObject([{ op: 'patch', sendUpdates: 'all' }]);
    expect(consumeOwnCalendarChange(PRINCIPAL, 'teamsync01', new Date())).toBe(true);
  });
  it('cancels only the principal’s copy of another organizer’s event and explains declining', async () => {
    calendar.put({
      ...teamSync([PRINCIPAL_GUEST, { email: REMY, responseStatus: 'accepted' }]),
      organizer: { email: REMY },
    });
    const result = data(
      await send(main, 'cancel_event', { calendar: PRINCIPAL, event: 'teamsync01', send_updates: 'none' }),
    );
    expect(result.message).toContain('Organizer:');
    expect(result.message).toContain('principal’s copy');
    expect(result.message).toContain('respond_to_event');
    expect(calendar.event(PRINCIPAL, 'teamsync01')?.status).toBe('cancelled');
  });
});

it('moves one occurrence and all following by splitting the series, retaining its finite count and logging before both writes', async () => {
  const master = {
    ...teamSync([PRINCIPAL_GUEST, { email: REMY, responseStatus: 'accepted' }]),
    id: 'weekly01',
    start: { dateTime: '2026-10-02T16:00:00Z' },
    end: { dateTime: '2026-10-02T16:30:00Z' },
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'],
  };
  calendar.put(master);
  for (let i = 0; i < 3; i++)
    calendar.put({
      ...master,
      id: `weekly01_${i}`,
      recurrence: undefined,
      recurringEventId: 'weekly01',
      originalStartTime: { dateTime: new Date(Date.parse('2026-10-02T16:00:00Z') + i * 7 * 86400000).toISOString() },
      start: { dateTime: new Date(Date.parse('2026-10-02T16:00:00Z') + i * 7 * 86400000).toISOString() },
      end: { dateTime: new Date(Date.parse('2026-10-02T16:30:00Z') + i * 7 * 86400000).toISOString() },
    });
  const result = data(
    await send(
      main,
      'change_event',
      {
        calendar: PRINCIPAL,
        event: 'weekly01_2',
        start: '2026-10-16T10:00:00-07:00',
        end: '2026-10-16T10:30:00-07:00',
        scope: 'following',
        send_updates: 'all',
      },
      'act-following',
    ),
  );
  const inserts = calendar.writes.filter((w) => w.op === 'insert');
  expect(inserts).toHaveLength(1);
  expect(inserts[0].fields?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=3']);
  expect(calendar.event(PRINCIPAL, 'weekly01')?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;UNTIL=20261016T155959Z']);
  expect(result.message).toContain('following');
  const { getCalendarWrite } = await import('./week/write-log.js');
  expect(await getCalendarWrite('act-following')).toMatchObject({ state: 'applied' });
});

it('preserves privacy, availability, reminders and the existing conference in a time-only following split', async () => {
  const conferenceData = {
    conferenceId: 'existing-meet',
    conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
    entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/existing-meet' }],
    signature: 'existing-conference-signature',
  };
  const master = {
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'privateweekly',
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'],
    start: { dateTime: '2026-10-02T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-02T16:30:00Z', timeZone: PACIFIC },
    visibility: 'private',
    transparency: 'transparent',
    reminders: 'none' as const,
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    conference: { status: 'success' as const, uri: 'https://meet.google.com/existing-meet' },
    conferenceData,
  };
  calendar.put(master);
  calendar.put({
    ...master,
    id: 'privateweekly_2',
    recurrence: undefined,
    recurringEventId: master.id,
    originalStartTime: { dateTime: '2026-10-16T16:00:00Z' },
    start: { dateTime: '2026-10-16T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-16T16:30:00Z', timeZone: PACIFIC },
  });
  data(
    await send(main, 'change_event', {
      calendar: PRINCIPAL,
      event: 'privateweekly_2',
      start: '2026-10-16T10:00:00-07:00',
      end: '2026-10-16T10:30:00-07:00',
      scope: 'following',
      send_updates: 'none',
    }),
  );
  const following = calendar.writes.find((write) => write.op === 'insert');
  expect(following?.fields).toMatchObject({
    visibility: 'private',
    transparency: 'transparent',
    reminders: 'none',
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    conferenceData,
  });
  expect(calendar.event(PRINCIPAL, following?.eventId ?? '')).toMatchObject({
    visibility: 'private',
    transparency: 'transparent',
    reminders: 'none',
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    conference: { uri: 'https://meet.google.com/existing-meet' },
  });
});

it('defers a failed replacement insert and finishes the persisted split after a recovery restart', async () => {
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'weeklydeferred',
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'],
    start: { dateTime: '2026-10-02T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-02T16:30:00Z', timeZone: PACIFIC },
  });
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'weeklydeferred_2',
    recurringEventId: 'weeklydeferred',
    originalStartTime: { dateTime: '2026-10-16T16:00:00Z' },
    start: { dateTime: '2026-10-16T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-16T16:30:00Z', timeZone: PACIFIC },
  });
  const requestId = 'act-split-deferred';
  const handler = getDeliveryAction('change_event');
  if (!handler) throw new Error('change_event is not registered');
  const startedAt = new Date(Date.now() - 31_000).toISOString();
  const outbox = new Database(outboundDbPath(main.agent_group_id, main.id));
  try {
    outbox
      .prepare('INSERT INTO messages_out(id,timestamp,kind,content) VALUES(?,?,?,?)')
      .run(requestId, startedAt, 'system', JSON.stringify({ action: 'change_event', requestId }));
  } finally {
    outbox.close();
  }
  calendar.failNext({ op: 'insert', error: new Error('connection closed before insertion') });
  await handler(
    {
      action: 'change_event',
      requestId,
      calendar: PRINCIPAL,
      event: 'weeklydeferred_2',
      start: '2026-10-16T10:00:00-07:00',
      end: '2026-10-16T10:30:00-07:00',
      scope: 'following',
      send_updates: 'all',
    },
    main,
  );
  const response = () => {
    const inbound = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
    try {
      const row = inbound.prepare('SELECT content FROM messages_in WHERE id=?').get(`action-resp-${requestId}`) as
        | { content: string }
        | undefined;
      return row ? (JSON.parse(row.content) as { frame: ResponseFrame }).frame : undefined;
    } finally {
      inbound.close();
    }
  };
  expect(response()).toBeUndefined();
  const { getCalendarSplitRecovery } = await import('./week/write-log.js');
  expect((await getCalendarSplitRecovery(requestId))?.createdAt).toBe(startedAt);
  expect(calendar.event(PRINCIPAL, 'weeklydeferred')?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;UNTIL=20261016T155959Z']);
  expect(calendar.writes.filter((write) => write.op === 'insert')).toEqual([]);
  const { createPrincipalEventTools } = await import('./principal-events.js');
  vi.useFakeTimers({ toFake: ['Date'] });
  const recoveryAt = Date.now() + 60_001;
  vi.setSystemTime(recoveryAt);
  try {
    await createPrincipalEventTools({ calendar: () => calendar }).resumePending();
    expect(
      data(response() ?? { id: requestId, ok: false, error: { code: 'handler-error', message: 'no answer' } }).message,
    ).toContain('Changed this occurrence and all following occurrences');
    await createPrincipalEventTools({ calendar: () => calendar }).resumePending();
  } finally {
    vi.useRealTimers();
  }
  expect(calendar.writes.filter((write) => write.op === 'patch')).toHaveLength(1);
  expect(calendar.writes.filter((write) => write.op === 'insert')).toHaveLength(1);
  expect(consumeOwnCalendarChange(PRINCIPAL, 'weeklydeferred', new Date())).toBe(true);
  expect(consumeOwnCalendarChange(PRINCIPAL, 'weeklydeferred', new Date())).toBe(false);
});

it('resumes a following split with its saved guest plan after the original occurrence disappears', async () => {
  const request = { ...followingRequest('missingguestoccurrence'), guests: [REMY] };
  const requestId = 'act-split-saved-guests';
  const handler = getDeliveryAction('change_event');
  if (!handler) throw new Error('change_event is not registered');
  calendar.failNext({ op: 'insert', error: new Error('replacement temporarily unavailable') });
  await handler({ ...request, action: 'change_event', requestId }, main);
  expect(responseFor(main, requestId)).toBeUndefined();
  calendar.remove(PRINCIPAL, 'missingguestoccurrence_2');
  const { createPrincipalEventTools } = await import('./principal-events.js');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 60_001);
  try {
    await createPrincipalEventTools({ calendar: () => calendar }).resumePending();
  } finally {
    vi.useRealTimers();
  }
  const frame = responseFor(main, requestId);
  expect(frame).toMatchObject({ ok: true });
  const following = calendar.writes.find((write) => write.op === 'insert');
  expect(
    calendar
      .event(PRINCIPAL, following?.eventId ?? '')
      ?.attendees?.map((guest) => guest.email)
      .sort(),
  ).toEqual([PRINCIPAL, REMY].sort());
  expect(calendar.writes.filter((write) => write.op === 'patch')).toHaveLength(1);
  expect(calendar.writes.filter((write) => write.op === 'insert')).toHaveLength(1);
});

it('rejects a changed same-id retry without poisoning the pending split or its original answer', async () => {
  const request = { ...followingRequest('immutablesplit'), guests: [REMY] };
  const requestId = 'act-immutable-split';
  const handler = getDeliveryAction('change_event');
  if (!handler) throw new Error('change_event is not registered');
  calendar.failNext({ op: 'insert', error: new Error('replacement temporarily unavailable') });
  await handler({ ...request, action: 'change_event', requestId }, main);
  const { getCalendarWrite, getCalendarSplitRecovery } = await import('./week/write-log.js');
  const originalWrite = await getCalendarWrite(requestId);
  const originalRecovery = await getCalendarSplitRecovery(requestId);
  expect(originalWrite?.state).toBe('pending');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 60_001);
  try {
    await handler({ ...request, guests: [NOEL], action: 'change_event', requestId }, main);
    expect(responseFor(main, requestId)).toBeUndefined();
    expect(await getCalendarWrite(requestId)).toEqual(originalWrite);
    expect(await getCalendarSplitRecovery(requestId)).toEqual(originalRecovery);
    const { createPrincipalEventTools } = await import('./principal-events.js');
    await createPrincipalEventTools({ calendar: () => calendar }).resumePending();
    expect(responseFor(main, requestId)).toMatchObject({ ok: true });
  } finally {
    vi.useRealTimers();
  }
  const following = calendar.writes.find((write) => write.op === 'insert');
  const guests = calendar.event(PRINCIPAL, following?.eventId ?? '')?.attendees?.map((guest) => guest.email);
  expect(guests).toContain(REMY);
  expect(guests).not.toContain(NOEL);
  expect(calendar.writes.filter((write) => write.op === 'patch')).toHaveLength(1);
  expect(calendar.writes.filter((write) => write.op === 'insert')).toHaveLength(1);
});

it('refuses a different session claiming a pending split without changing the original work or answer', async () => {
  const request = followingRequest('crosssessionsplit');
  const requestId = 'act-cross-session-split';
  const handler = getDeliveryAction('change_event');
  if (!handler) throw new Error('change_event is not registered');
  calendar.failNext({ op: 'insert', error: new Error('replacement temporarily unavailable') });
  await handler({ ...request, action: 'change_event', requestId }, main);
  const { getCalendarWrite, getCalendarSplitRecovery } = await import('./week/write-log.js');
  const originalWrite = await getCalendarWrite(requestId);
  const originalRecovery = await getCalendarSplitRecovery(requestId);
  const other = (await resolveSession(main.agent_group_id, main.messaging_group_id, 'other-thread', 'per-thread'))
    .session;
  const refused = await send(other, 'change_event', request, requestId);
  expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
  expect(responseFor(main, requestId)).toBeUndefined();
  expect(await getCalendarWrite(requestId)).toEqual(originalWrite);
  expect(await getCalendarSplitRecovery(requestId)).toEqual(originalRecovery);
  const { createPrincipalEventTools } = await import('./principal-events.js');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 60_001);
  try {
    await createPrincipalEventTools({ calendar: () => calendar }).resumePending();
  } finally {
    vi.useRealTimers();
  }
  expect(responseFor(main, requestId)).toMatchObject({ ok: true });
  expect(responseFor(other, requestId)).toEqual(refused);
  expect(calendar.writes.filter((write) => write.op === 'patch')).toHaveLength(1);
  expect(calendar.writes.filter((write) => write.op === 'insert')).toHaveLength(1);
});

it.each(['initial', 'recovery'] as const)(
  'rechecks authority after a %s split waits for the native calendar turn',
  async (kind) => {
    const request = followingRequest(`queued${kind}`);
    const requestId = `act-queued-${kind}`;
    const handler = getDeliveryAction('change_event');
    if (!handler) throw new Error('change_event is not registered');
    if (kind === 'recovery') {
      calendar.failNext({ op: 'insert', error: new Error('replacement temporarily unavailable') });
      await handler({ ...request, action: 'change_event', requestId }, main);
      expect(responseFor(main, requestId)).toBeUndefined();
    }
    calendar.put({ ...teamSync([PRINCIPAL_GUEST]), id: 'blockingrequest' });
    const entered = deferredSignal();
    const release = deferredSignal();
    const admitted = deferredSignal();
    const patch = calendar.patchEvent.bind(calendar);
    const patchSpy = vi.spyOn(calendar, 'patchEvent').mockImplementation(async (...args) => {
      if (args[1] === 'blockingrequest') {
        entered.resolve();
        await release.promise;
      }
      return patch(...args);
    });
    const blocking = handler(
      {
        action: 'change_event',
        requestId: 'act-blocking',
        calendar: PRINCIPAL,
        event: 'blockingrequest',
        title: 'Already issued calendar write',
        send_updates: 'none',
      },
      main,
    );
    await entered.promise;
    const capabilities = capabilityStorage.getGroupCapabilities;
    const capabilitySpy = vi.spyOn(capabilityStorage, 'getGroupCapabilities').mockImplementationOnce(async (id) => {
      const value = await capabilities(id);
      admitted.resolve();
      return value;
    });
    const { createPrincipalEventTools } = await import('./principal-events.js');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_001);
    const queued =
      kind === 'recovery'
        ? createPrincipalEventTools({ calendar: () => calendar }).resumePending()
        : handler({ ...request, action: 'change_event', requestId }, main);
    try {
      await admitted.promise;
      await updateContainerConfigJson(main.agent_group_id, 'capabilities', []);
      expect(calendar.writes.filter((write) => write.op === 'insert')).toEqual([]);
      release.resolve();
      await Promise.all([blocking, queued]);
      expect(calendar.writes.filter((write) => write.op === 'insert')).toEqual([]);
      if (kind === 'initial')
        expect(responseFor(main, requestId)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      else {
        const { getCalendarSplitRecovery } = await import('./week/write-log.js');
        expect((await getCalendarSplitRecovery(requestId))?.terminalError).toContain(
          'no longer has calendar authority',
        );
        expect(responseFor(main, requestId)).toBeUndefined();
      }
    } finally {
      release.resolve();
      await Promise.allSettled([blocking, queued]);
      patchSpy.mockRestore();
      capabilitySpy.mockRestore();
      vi.useRealTimers();
    }
  },
);

it.each([
  { attachments: [{ fileId: 'file-1', fileUrl: 'https://drive.google.com/file/d/file-1' }] },
  { privateCopy: true },
  { endTimeUnspecified: true },
  { anyoneCanAddSelf: true },
])('refuses a split before trimming when unsupported metadata cannot be preserved (%j)', async (properties) => {
  const request = followingRequest('unsupportedmetadata', properties);
  const message = refusal(await send(main, 'change_event', request));
  expect(message).toContain('cannot be preserved');
  expect(message).toContain('Nothing was written');
  expect(calendar.writes).toEqual([]);
});

it('reports a permanent partial split failure instead of success or another destructive retry', async () => {
  const request = followingRequest('permanentpartial');
  const requestId = 'act-split-permanent';
  calendar.failNext({ op: 'insert', error: new GoogleApiError(400, 'Invalid replacement') });
  const message = refusal(await send(main, 'change_event', request, requestId));
  expect(message).toContain('only partly changed');
  expect(message).toContain('original series was shortened');
  expect(message).toContain('will not be retried automatically');
  const { createPrincipalEventTools } = await import('./principal-events.js');
  await createPrincipalEventTools({ calendar: () => calendar }).resumePending();
  expect(refusal(await send(main, 'change_event', request, requestId))).toBe(message);
  expect(calendar.writes.filter((write) => write.op === 'patch')).toHaveLength(1);
  expect(calendar.writes.filter((write) => write.op === 'insert')).toEqual([]);
  const { getCalendarSplitRecovery } = await import('./week/write-log.js');
  expect(await getCalendarSplitRecovery(requestId)).toMatchObject({ terminalError: message, reported: true });
});

it.each(['default', 'none'] as const)(
  'replaces custom reminders with %s without carrying stale overrides into recovery',
  async (reminders) => {
    const request = followingRequest('replacedreminders', {
      reminders: 'custom',
      reminderOverrides: [{ method: 'popup', minutes: 17 }],
    });
    const result = data(await send(main, 'change_event', { ...request, reminders }, `act-reminders-${reminders}`));
    expect(result.message).toContain('all following occurrences');
    const following = calendar.writes.find((write) => write.op === 'insert');
    expect(following?.fields?.reminders).toBe(reminders);
    expect(following?.fields).not.toHaveProperty('reminderOverrides');
  },
);

it('retains custom reminder overrides when the following split changes only time', async () => {
  const request = followingRequest('keptcustomreminders', {
    reminders: 'custom',
    reminderOverrides: [
      { method: 'popup', minutes: 17 },
      { method: 'email', minutes: 90 },
    ],
  });
  data(await send(main, 'change_event', request));
  expect(calendar.writes.find((write) => write.op === 'insert')?.fields).toMatchObject({
    reminders: 'custom',
    reminderOverrides: [
      { method: 'popup', minutes: 17 },
      { method: 'email', minutes: 90 },
    ],
  });
});

it.each(['closed', 'foreign-agent', 'capability-removed'] as const)(
  'makes no new calendar write when a deferred split loses %s session authority',
  async (kind) => {
    const request = followingRequest('obsoletepartial');
    const requestId = 'act-split-obsolete';
    const handler = getDeliveryAction('change_event');
    if (!handler) throw new Error('change_event is not registered');
    calendar.failNext({ op: 'insert', error: new Error('temporary transport failure') });
    await handler({ ...request, action: 'change_event', requestId }, main);
    expect(responseFor(main, requestId)).toBeUndefined();
    if (kind === 'closed') await getDb().run("UPDATE sessions SET status='closed' WHERE id=?", main.id);
    else if (kind === 'foreign-agent')
      await getDb().run("UPDATE sessions SET agent_group_id='ag-external' WHERE id=?", main.id);
    else await updateContainerConfigJson(main.agent_group_id, 'capabilities', []);
    const { createPrincipalEventTools } = await import('./principal-events.js');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_001);
    try {
      await createPrincipalEventTools({ calendar: () => calendar }).resumePending();
    } finally {
      vi.useRealTimers();
    }
    expect(calendar.writes.filter((write) => write.op === 'patch')).toHaveLength(1);
    expect(calendar.writes.filter((write) => write.op === 'insert')).toEqual([]);
    const { getCalendarSplitRecovery } = await import('./week/write-log.js');
    expect((await getCalendarSplitRecovery(requestId))?.terminalError).toContain('no longer has calendar authority');
    expect(responseFor(main, requestId)).toBeUndefined();
  },
);

it('bounds transient split recovery attempts and reports the unresolved partial change', async () => {
  const request = followingRequest('boundedpartial');
  const requestId = 'act-split-bounded';
  const handler = getDeliveryAction('change_event');
  if (!handler) throw new Error('change_event is not registered');
  for (let attempt = 0; attempt < 8; attempt++)
    calendar.failNext({ op: 'insert', error: new Error('still unavailable') });
  await handler({ ...request, action: 'change_event', requestId }, main);
  expect(responseFor(main, requestId)).toBeUndefined();
  const { createPrincipalEventTools } = await import('./principal-events.js');
  const { getCalendarSplitRecovery } = await import('./week/write-log.js');
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    for (let attempt = 1; attempt < 8; attempt++) {
      vi.setSystemTime(Date.now() + 60_001);
      await createPrincipalEventTools({ calendar: () => calendar }).resumePending();
    }
  } finally {
    vi.useRealTimers();
  }
  const frame = responseFor(main, requestId);
  if (!frame) throw new Error('Bounded recovery did not answer');
  expect(refusal(frame)).toContain('only partly changed');
  expect(refusal(frame)).toContain('bounded recovery attempts');
  expect((await getCalendarSplitRecovery(requestId))?.terminalError).toBe(refusal(frame));
  expect((await getCalendarSplitRecovery(requestId))?.attempts).toBe(8);
  expect(calendar.writes.filter((write) => write.op === 'patch')).toHaveLength(1);
  expect(calendar.writes.filter((write) => write.op === 'insert')).toEqual([]);
});

it('recovers a pending split ahead of twenty-one completed reports waiting for a principal route', async () => {
  const { beginCalendarWrite, markCalendarWriteApplied } = await import('./week/write-log.js');
  for (let index = 0; index < 21; index++) {
    const requestId = `act-blocked-report-${index}`;
    await beginCalendarWrite(
      {
        requestId,
        calendarId: PRINCIPAL,
        eventId: `oldseries_${index}`,
        action: 'change_event',
        request: {},
        before: null,
        plan: {
          patch: {},
          split: {
            masterId: 'oldseries',
            master: { id: 'oldseries' },
            trim: [],
            deleteMaster: false,
            followingId: `oldfollowing${index}`,
            following: null,
          },
        },
        affectedStart: '2026-10-05T16:00:00Z',
        affectedEnd: '2026-10-05T17:00:00Z',
      },
      `missing-session-${index}`,
    );
    await markCalendarWriteApplied(requestId, 'An earlier split completed.');
  }
  const requestId = 'act-behind-blocked-reports';
  const request = followingRequest('waitingforrecovery');
  const handler = getDeliveryAction('change_event');
  if (!handler) throw new Error('change_event is not registered');
  calendar.failNext({ op: 'insert', error: new Error('temporary transport failure') });
  await handler({ ...request, action: 'change_event', requestId }, main);
  expect(responseFor(main, requestId)).toBeUndefined();
  const { createPrincipalEventTools } = await import('./principal-events.js');
  vi.useFakeTimers({ toFake: ['Date'] });
  const recoveryAt = Date.now() + 60_001;
  vi.setSystemTime(recoveryAt);
  try {
    await createPrincipalEventTools({ calendar: () => calendar }).resumePending();
  } finally {
    vi.useRealTimers();
  }
  expect(responseFor(main, requestId)).toMatchObject({ ok: true });
  const { getCalendarSplitRecovery } = await import('./week/write-log.js');
  const blocked = await getCalendarSplitRecovery('act-blocked-report-0');
  expect(blocked).toMatchObject({ reported: false, attempts: 0 });
  expect(Date.parse(blocked?.nextAttemptAt ?? '')).toBeGreaterThan(recoveryAt);
  expect(calendar.writes.filter((write) => write.op === 'patch')).toHaveLength(1);
  expect(calendar.writes.filter((write) => write.op === 'insert')).toHaveLength(1);
});

it('changes an event even when the calendar scan used only for findings cannot be read', async () => {
  calendar.put(teamSync([PRINCIPAL_GUEST, { email: REMY, responseStatus: 'accepted' }]));
  vi.spyOn(calendar, 'listEventDetails').mockRejectedValue(new Error('calendar scan unavailable'));
  const changed = data(
    await send(
      main,
      'change_event',
      { calendar: PRINCIPAL, event: 'teamsync01', location: 'Video meeting', send_updates: 'none' },
      'act-change-gap',
    ),
  );
  expect(changed.message).toContain('Changed');
  expect(changed.message).toContain('findings unavailable');
  expect(calendar.event(PRINCIPAL, 'teamsync01')?.location).toBe('Video meeting');
});
it('logs a guest write and its findings gap without turning the successful invitation into failure', async () => {
  calendar.put(teamSync([PRINCIPAL_GUEST]));
  vi.spyOn(calendar, 'listEventDetails').mockRejectedValue(new Error('calendar scan unavailable'));
  const changed = data(
    await send(main, 'change_guests', { calendar: PRINCIPAL, event: 'teamsync01', add: [REMY] }, 'act-guests-gap'),
  );
  expect(changed.message).toContain('findings unavailable');
  const { listCalendarWriteGaps } = await import('./week/write-log.js');
  expect(await listCalendarWriteGaps()).toMatchObject([{ action: 'change_guests', requestId: 'act-guests-gap' }]);
  expect(calendar.event(PRINCIPAL, 'teamsync01')?.attendees).toEqual(
    expect.arrayContaining([{ email: REMY, responseStatus: 'needsAction' }]),
  );
});

it('exports nine weeks to a session inbox file with a count, and filters the ordinary days answer', async () => {
  for (let i = 0; i < 9; i++)
    calendar.put({
      ...teamSync([PRINCIPAL_GUEST]),
      id: `weekly${i}`,
      summary: i % 2 ? 'Planning' : 'Call with Remy',
      start: { dateTime: new Date(Date.parse('2026-10-05T16:00:00Z') + i * 7 * 86400000).toISOString() },
      end: { dateTime: new Date(Date.parse('2026-10-05T16:30:00Z') + i * 7 * 86400000).toISOString() },
    });
  const exported = data(await send(main, 'days', { start: '2026-10-05', end: '2026-12-06', export: true }));
  expect(exported.count).toBe(9);
  expect(exported.message).toContain('Exported 9 events to inbox/');
  expect(exported.message).not.toContain('summary');
  const file = fs.readFileSync(
    `${sessionMailboxDir({ agentGroupId: main.agent_group_id, sessionId: main.id })}/${String(exported.path)}`,
    'utf8',
  );
  expect(file).toContain('Call with Remy');
  expect(file).toContain('Planning');
  expect(file).toContain('Source: google_calendar');
  const filtered = data(await send(main, 'days', { start: '2026-10-05', end: '2026-12-06', filter: 'Remy' }));
  expect(filtered.message).toContain('5 events');
  expect(filtered.message).not.toContain('Planning');
});

it('checks a proposed pickup and a colleague’s busy windows, with known-zero history and recorded lengths, without writing', async () => {
  await setSchedulingPreference({
    kind: 'meeting-length',
    meetingKind: 'intro',
    minutes: 25,
    source: 'principal',
    basis: 'Morgan prefers short introductions.',
  });
  const checked = data(
    await send(main, 'check', {
      title: 'Pickup',
      start: '2026-10-09T14:30:00-07:00',
      end: '2026-10-09T15:00:00-07:00',
      guests: [REMY],
      kind: 'intro',
    }),
  );
  expect(checked.message).toContain('Nothing booked or changed');
  expect(checked.message).toContain('people record: no');
  expect(checked.message).toContain('0 meetings together in six months');
  expect(checked.message).toContain('25 minutes');
  calendar.put({ ...teamSync([]), calendarId: COLLEAGUE_CALENDAR, id: 'colleague' });
  const busy = data(
    await send(main, 'check', {
      start: '2026-10-09T08:00:00-07:00',
      end: '2026-10-09T17:00:00-07:00',
      calendars: [COLLEAGUE_CALENDAR],
    }),
  );
  expect(busy.message).toContain('Busy windows only');
  expect(busy.message).toContain('09:00');
  expect(busy.message).not.toContain('Team sync');
  expect(calendar.writes).toEqual([]);
});

it('counts one historical meeting across calendar copies with equivalent offset representations', async () => {
  const start = new Date(Date.now() - 86_400_000).toISOString();
  const end = new Date(Date.parse(start) + 30 * 60_000).toISOString();
  const meeting: StoredEvent = {
    ...teamSync([PRINCIPAL_GUEST, { email: REMY, responseStatus: 'accepted' }]),
    id: 'past-main',
    iCalUID: 'shared-past-meeting',
    start: { dateTime: start },
    end: { dateTime: end },
  };
  calendar.put(meeting);
  calendar.put({
    ...meeting,
    calendarId: READ_ONLY,
    id: 'past-copy',
    start: { dateTime: start.replace('Z', '+00:00') },
  });
  const checked = data(
    await send(main, 'check', {
      title: 'Next call with Remy',
      start: '2026-11-12T09:00:00-08:00',
      end: '2026-11-12T09:30:00-08:00',
      guests: [REMY],
    }),
  );
  expect(checked.message).toContain('1 meetings together in six months');
  expect(checked.message).not.toContain('2 meetings together in six months');
  expect(calendar.writes).toEqual([]);
});

it('reports a named person omitted by the principal without notifying or inviting them', async () => {
  await addPerson({
    name: 'Remy Vance',
    level: 'known',
    source: 'principal',
    basis: 'Morgan knows Remy.',
    identity: `email:${REMY}`,
  });
  calendar.put({ ...teamSync([PRINCIPAL_GUEST]), summary: 'Call with Remy', creator: { email: PRINCIPAL } });
  const changed = data(
    await send(main, 'change_event', {
      calendar: PRINCIPAL,
      event: 'teamsync01',
      start: '2026-10-09T10:00:00-07:00',
      end: '2026-10-09T10:30:00-07:00',
      send_updates: 'none',
    }),
  );
  expect(changed.message).toContain('named but not on the invite of an event the principal created');
  expect(changed.message).toContain('Google notified no guests');
  expect(calendar.event(PRINCIPAL, 'teamsync01')?.attendees).toEqual([PRINCIPAL_GUEST]);
});

it('leaves a linked prep block flagged as orphaned after its parent is cancelled', async () => {
  calendar.put(teamSync([PRINCIPAL_GUEST]));
  const block = data(
    await send(main, 'create_event', {
      calendar: PRINCIPAL,
      title: 'Prep',
      start: '2026-10-09T08:30:00-07:00',
      end: '2026-10-09T09:00:00-07:00',
      parent_event: 'teamsync01',
      parent_calendar: PRINCIPAL,
      parent_start: '2026-10-09T16:00:00Z',
      block_kind: 'prep',
    }),
  );
  const cancelled = data(
    await send(main, 'cancel_event', { calendar: PRINCIPAL, event: 'teamsync01', send_updates: 'none' }),
  );
  expect(cancelled.message).toContain('Linked event was cancelled');
  expect(calendar.event(PRINCIPAL, String(block.event))?.status).toBe('confirmed');
});

it('forgets person handles from the durable write payload, split plan, outcome and pending notices', async () => {
  const person = await addPerson({
    name: 'Remy Vance',
    level: 'known',
    source: 'principal',
    basis: 'Morgan knows Remy.',
    identity: `email:${REMY}`,
  });
  await send(main, 'create_event', { ...FOCUS, title: 'Call with Remy', guests: [REMY] }, 'act-forget');
  fs.mkdirSync(`${TEST_DIR}/secrets`, { mode: 0o700 });
  vi.stubEnv(GOOGLE_GRANT_FILE_ENV, `${TEST_DIR}/secrets/google-grant.json`);
  try {
    await forgetPerson({ id: person.id });
  } finally {
    vi.unstubAllEnvs();
  }
  const rows = await getDb().all('SELECT * FROM gws_ea_calendar_write_log');
  expect(JSON.stringify(rows)).not.toContain(REMY);
  expect(JSON.stringify(await getDb().all('SELECT * FROM gws_ea_pending_calendar_changes'))).not.toContain(REMY);
});

it('preserves a finite recurrence count across an excluded date when splitting after it', async () => {
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'weeklyex',
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE:20261009T160000Z'],
    start: { dateTime: '2026-10-02T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-02T16:30:00Z', timeZone: PACIFIC },
  });
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'weeklyex_2',
    recurringEventId: 'weeklyex',
    originalStartTime: { dateTime: '2026-10-16T16:00:00Z' },
    start: { dateTime: '2026-10-16T16:00:00Z' },
    end: { dateTime: '2026-10-16T16:30:00Z' },
  });
  data(
    await send(main, 'change_event', {
      calendar: PRINCIPAL,
      event: 'weeklyex_2',
      start: '2026-10-16T10:00:00-07:00',
      end: '2026-10-16T10:30:00-07:00',
      scope: 'following',
      send_updates: 'none',
    }),
  );
  const following = calendar.writes.find((w) => w.op === 'insert');
  expect(following?.fields?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=3']);
  expect(calendar.event(PRINCIPAL, 'weeklyex')?.recurrence).toEqual([
    'RRULE:FREQ=WEEKLY;UNTIL=20261016T155959Z',
    'EXDATE:20261009T160000Z',
  ]);
});

it('resumes a split after the insert reply is lost without trimming or inviting twice', async () => {
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'weeklyretry',
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'],
    start: { dateTime: '2026-10-02T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-02T16:30:00Z', timeZone: PACIFIC },
  });
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'weeklyretry_2',
    recurringEventId: 'weeklyretry',
    originalStartTime: { dateTime: '2026-10-16T16:00:00Z' },
    start: { dateTime: '2026-10-16T16:00:00Z' },
    end: { dateTime: '2026-10-16T16:30:00Z' },
  });
  const request = {
    calendar: PRINCIPAL,
    event: 'weeklyretry_2',
    start: '2026-10-16T10:00:00-07:00',
    end: '2026-10-16T10:30:00-07:00',
    scope: 'following',
    send_updates: 'all',
  };
  calendar.failNext({ op: 'insert', error: new Error('reply lost'), afterApplying: true });
  const first = data(await send(main, 'change_event', request, 'act-split-retry'));
  expect(first.message).toContain('Changed this occurrence and all following occurrences');
  const inbound = new Database(inboundDbPath(main.agent_group_id, main.id));
  inbound.prepare('DELETE FROM messages_in WHERE id = ?').run('action-resp-act-split-retry');
  inbound.close();
  const retried = data(await send(main, 'change_event', request, 'act-split-retry'));
  expect(retried.message).toContain('all following occurrences');
  expect(calendar.writes.filter((w) => w.op === 'patch')).toHaveLength(1);
  expect(calendar.writes.filter((w) => w.op === 'insert')).toHaveLength(1);
});

it('cancels this and following occurrences by truncating the master without deleting earlier occurrences', async () => {
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'weeklycancel',
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'],
    start: { dateTime: '2026-10-02T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-02T16:30:00Z', timeZone: PACIFIC },
  });
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'weeklycancel_2',
    recurringEventId: 'weeklycancel',
    originalStartTime: { dateTime: '2026-10-16T16:00:00Z' },
    start: { dateTime: '2026-10-16T16:00:00Z' },
    end: { dateTime: '2026-10-16T16:30:00Z' },
  });
  const result = data(
    await send(main, 'cancel_event', {
      calendar: PRINCIPAL,
      event: 'weeklycancel_2',
      scope: 'following',
      send_updates: 'none',
    }),
  );
  expect(result.message).toContain('Cancelled this occurrence and all following occurrences');
  expect(calendar.event(PRINCIPAL, 'weeklycancel')?.recurrence).toEqual(['RRULE:FREQ=WEEKLY;UNTIL=20261016T155959Z']);
  expect(calendar.writes).toMatchObject([{ op: 'patch', eventId: 'weeklycancel' }]);
});

it.each([
  ['an off-cadence RDATE', ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', 'RDATE:20261009T160000Z']],
  ['an EXRULE with a different phase', ['RRULE:FREQ=WEEKLY;BYDAY=FR', 'EXRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=FR']],
])('refuses a split of %s before writing rather than silently moving later occurrences', async (_label, recurrence) => {
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'phased',
    recurrence,
    start: { dateTime: '2026-10-02T16:00:00Z', timeZone: PACIFIC },
    end: { dateTime: '2026-10-02T16:30:00Z', timeZone: PACIFIC },
  });
  calendar.put({
    ...teamSync([PRINCIPAL_GUEST]),
    id: 'phased_1',
    recurringEventId: 'phased',
    originalStartTime: { dateTime: '2026-10-09T16:00:00Z' },
    start: { dateTime: '2026-10-09T16:00:00Z' },
    end: { dateTime: '2026-10-09T16:30:00Z' },
  });
  const request = {
    calendar: PRINCIPAL,
    event: 'phased_1',
    start: '2026-10-09T10:00:00-07:00',
    end: '2026-10-09T10:30:00-07:00',
    scope: 'following',
    send_updates: 'none',
  };
  const refused = refusal(await send(main, 'change_event', request));
  expect(refused).toContain('cannot preserve the existing recurrence');
  expect(refused).toContain('explicit replacement recurrence');
  expect(calendar.writes).toEqual([]);
  const changed = data(await send(main, 'change_event', { ...request, recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] }));
  expect(changed.message).toContain('all following occurrences');
});

it('does not swallow a later principal notice after an unchanged edit', async () => {
  calendar.put({ ...teamSync([PRINCIPAL_GUEST]), id: 'unchangededit', tags: { gws_ea_assistant_written: 'true' } });
  const result = data(
    await send(main, 'change_event', {
      calendar: PRINCIPAL,
      event: 'unchangededit',
      title: 'Team sync',
      send_updates: 'none',
    }),
  );
  expect(calendar.writes).toEqual([]);
  expect(consumeOwnCalendarChange(PRINCIPAL, 'unchangededit', new Date())).toBe(false);
  expect(result.message).toContain('Nothing changed');
});

it('defaults days to exactly eight local dates when the clock changes during the range', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-28T20:00:00Z'));
  try {
    const result = data(await send(main, 'days', {}));
    expect(result.message).toContain('across 8 local days');
  } finally {
    clock.mockRestore();
  }
});
