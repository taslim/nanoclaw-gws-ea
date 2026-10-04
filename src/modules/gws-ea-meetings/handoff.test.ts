/**
 * The typed handoff between `main` and `external-email` (KTD5; R7, R8, R16,
 * R19, R20, R21, R23, R26).
 *
 * Drives the real delivery actions, guards, router, inbox channel, privacy
 * guard, people store and session DBs against an in-memory Gmail and Google
 * Calendar. Only the container runtime and its wake are mocked.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-meetings';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-meetings',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-meetings/groups',
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

/** The test's Google Calendar, swapped in per test behind the module's own client. */
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

import { teardownChannelAdapters } from '../../channels/channel-registry.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { killContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { deliverSessionMessages, getDeliveryAction } from '../../delivery.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { requestWake } from '../../request-wake.js';
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
import { addPerson, addPersonInstruction, forgetPerson, type Person } from '../gws-ea-people/db.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import '../gws-ea-privacy/index.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import '../gws-ea-external-email/index.js';
import { ensureInbox, getThreadParticipants, GoogleApiError, type Inbox } from '../gws-ea-inbox/index.js';
import { consumeOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { getMeeting } from './index.js';
import { FakeCalendar, type StoredEvent } from './testing/fake-calendar.js';
import { FakeGmail, header } from './testing/fake-gmail.js';
import {
  ask,
  contents,
  data,
  meeting,
  meetingSession,
  notes,
  refusal,
  reply,
  slotsOf,
  startInbox,
} from './testing/scheduling.js';

const ROBIN = 'robin@assistant.example';
const PRINCIPAL = 'pat@principal.example';
const PRINCIPAL_USER = 'gchat:users/pat';
const SAM = 'sam@acme.example';
const SALES = 'sales@acme.example';
const DANA = 'dana@friends.example';
const OLU = 'olu@partner.example';
const LEE = 'lee@stranger.example';
const TEAM_CALENDAR = 'team@group.calendar.google.com';
const READ_ONLY_CALENDAR = 'holidays@group.calendar.google.com';
const COLLEAGUE_CALENDAR = 'kim@principal.example';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let gmail: FakeGmail;
let calendar: FakeCalendar;
let inbox: Inbox;
let main: Session;
let sam: Person;
let dana: Person;
let olu: Person;

function now(): string {
  return new Date().toISOString();
}

/** A UTC instant `days` from today, `hours` (fractions too) after midnight. */
function inDays(days: number, hours = 0): string {
  const midnight = new Date(Date.now() + days * DAY);
  midnight.setUTCHours(0, 0, 0, 0);
  return new Date(midnight.getTime() + hours * HOUR).toISOString();
}

const WINDOW = { window_start: inDays(7, 9), window_end: inDays(11, 17) };

/** What a tool reads back: the session's `action_response` for one request. */
function responses(session: Session, requestId: string): ResponseFrame[] {
  return contents(session)
    .filter((c) => c.type === 'action_response' && c.requestId === requestId)
    .map((c) => c.frame as ResponseFrame);
}

function meetingNotes(outcome?: string) {
  return notes(main, 'gws-ea-meetings.outcome').filter((c) => outcome === undefined || c.note?.outcome === outcome);
}

function briefs(session: Session) {
  return contents(session).filter((c) => c.brief !== undefined);
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

async function count(table: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

interface BookedTime {
  readonly calendar_id: string;
  readonly event_id: string;
  readonly start: string;
  readonly end: string;
}

/** external-email books the first time free_time offers, with its own tools. */
async function bookFirstTime(session: Session, meetingId: unknown): Promise<BookedTime> {
  const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: meetingId }));
  return data(await ask(session, 'meeting_book', { meeting_id: meetingId, slot_id: slot.slot_id }))
    .booking as BookedTime;
}

/** The principal copies Robin into a thread with Acme Sales; returns the thread key from main's note. */
async function copyRobinIn(): Promise<string> {
  gmail.receive({
    threadId: 'g-acme',
    from: `Pat <${PRINCIPAL}>`,
    principal: true,
    to: [`Acme Sales <${SALES}>`],
    cc: [`Robin <${ROBIN}>`],
    subject: 'Partnership',
    body: 'Adding my assistant to find 45 minutes for us next week.',
  });
  await inbox.tick();
  const copyIn = contents(main).find((c) => c.note?.type === 'gws-ea-inbox.copy-in');
  if (!copyIn) throw new Error('no copy-in note');
  return String(copyIn.note?.thread_key);
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(requestWake).mockClear();
  vi.mocked(killContainer).mockClear();

  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
    ['ag-other', 'other'],
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
    id: 'mg-other',
    channel_type: 'gchat',
    platform_id: 'spaces/other',
    name: 'other',
    is_group: 1,
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
            principal_display_name = 'Pat Doe', principal_timezone = 'Europe/London'
      WHERE singleton = 1`,
    ROBIN,
  );
  await recordExternalEmailAgentGroupId('ag-external');
  await addPrincipalAddress(PRINCIPAL);

  sam = await addPerson({
    name: 'Sam Lee',
    level: 'active',
    source: 'principal',
    basis: 'a frequent collaborator',
    identity: `email:${SAM}`,
    organization: 'Acme Holdings',
    notes: 'Has a dog called Rexford',
  });
  await addPersonInstruction({ id: sam.id, text: 'Never book Sam on Fridays', source: 'principal' });
  dana = await addPerson({
    name: 'Dana Fox',
    level: 'close',
    source: 'principal',
    basis: 'an old friend',
    identity: `email:${DANA}`,
  });
  olu = await addPerson({
    name: 'Olu Ade',
    level: 'known',
    source: 'principal',
    basis: 'met once',
    identity: `email:${OLU}`,
  });

  gmail = new FakeGmail(ROBIN);
  calendar = new FakeCalendar();
  google.calendar = calendar;
  calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer', primary: false });
  calendar.calendars.set(TEAM_CALENDAR, { id: TEAM_CALENDAR, accessRole: 'owner', dataOwner: PRINCIPAL });
  calendar.calendars.set(READ_ONLY_CALENDAR, { id: READ_ONLY_CALENDAR, accessRole: 'reader', dataOwner: PRINCIPAL });
  calendar.calendars.set(COLLEAGUE_CALENDAR, { id: COLLEAGUE_CALENDAR, accessRole: 'writer' });

  await ensureInbox('ag-external');
  inbox = await startInbox(gmail, calendar);
  main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
  await inbox.tick();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// arrange
// ---------------------------------------------------------------------------

describe('arrange', () => {
  it("stores the meeting at its counterpart's level and opens a session whose first message is the brief", async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    expect(answer).toMatchObject({ level: 'active' });

    const stored = await meeting(answer.meeting_id);
    expect(stored).toMatchObject({
      kind: 'arrange',
      state: 'active',
      level: 'active',
      booking_calendar_id: PRINCIPAL,
      length_minutes: 30,
      purpose: 'Partnership intro',
    });
    expect(stored.counterparts).toEqual([{ address: SAM, person_id: sam.id, name: 'Sam Lee', level: 'active' }]);

    const session = await meetingSession(answer.meeting_id);
    expect(session.agent_group_id).toBe('ag-external');
    const [first, ...rest] = contents(session);
    expect(rest).toEqual([]);
    expect(first.sender).toBe('system');
    expect(first.row.thread_id).toBe(stored.thread_key);
    expect(first.brief).toMatchObject({ type: 'gws-ea-meetings.brief', meeting_id: stored.id, version: 1 });
    for (const shown of ['Sam Lee', SAM, 'active', '30', 'Partnership intro', 'Mornings suit the principal best.']) {
      expect(first.text).toContain(shown);
    }
    // Nothing else from the people store, and no event details.
    for (const hidden of ['Acme Holdings', 'Rexford', 'Fridays', 'a frequent collaborator']) {
      expect(first.text).not.toContain(hidden);
      expect(first.row.content).not.toContain(hidden);
    }
    expect(vi.mocked(requestWake)).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), 'inbound-message');

    const thread = await getThreadParticipants(stored.thread_key);
    expect(thread).toMatchObject({ origin: 'arrange', state: 'open', people: { to: [SAM], cc: [], bcc: [] } });
  });

  it('takes the lowest level among several counterparts', async () => {
    const answer = data(
      await ask(
        main,
        'meeting_arrange',
        arrangeWith(dana, { people: [{ person_id: dana.id }, { person_id: olu.id }] }),
      ),
    );
    expect((await meeting(answer.meeting_id)).level).toBe('known');
  });

  it("refuses a calendar that is not the principal's or that the assistant cannot write to", async () => {
    for (const calendarId of [COLLEAGUE_CALENDAR, READ_ONLY_CALENDAR, 'missing@group.calendar.google.com']) {
      const message = refusal(await ask(main, 'meeting_arrange', arrangeWith(sam, { calendar_id: calendarId })));
      expect(message).toMatch(/calendar/i);
    }
    expect(data(await ask(main, 'meeting_arrange', arrangeWith(sam, { calendar_id: TEAM_CALENDAR })))).toMatchObject({
      level: 'active',
    });
    expect(await count('gws_ea_meetings')).toBe(1);
  });

  it("refuses a purpose or constraints that carry the principal's private value, before external-email sees them", async () => {
    await addPrivateValue({ label: 'Home', kind: 'address', value: '12 Elm Road, Springfield' });
    const message = refusal(
      await ask(main, 'meeting_arrange', arrangeWith(sam, { constraints: 'Meet near 12 Elm Rd Springfield.' })),
    );
    expect(message).toContain('address');
    expect(message).not.toContain('Elm');
    expect(await count('gws_ea_meetings')).toBe(0);
    expect(await count('gws_ea_inbox_threads')).toBe(0);
  });

  it('refuses a person with no record and a window that has already ended', async () => {
    refusal(await ask(main, 'meeting_arrange', arrangeWith(sam, { people: [{ person_id: 'p-000000000000' }] })));
    refusal(
      await ask(main, 'meeting_arrange', arrangeWith(sam, { window_start: inDays(-3, 9), window_end: inDays(-1, 17) })),
    );
    expect(await count('gws_ea_meetings')).toBe(0);
  });

  it('binds a copied-in thread, takes its counterparts from the principal’s message, and never its length or window from counterpart mail', async () => {
    const threadKey = await copyRobinIn();
    gmail.receive({
      threadId: 'g-acme',
      from: `Acme Sales <${SALES}>`,
      to: [PRINCIPAL],
      cc: [ROBIN],
      subject: 'Re: Partnership',
      body: 'Let us do two hours sometime next month instead.',
    });
    await inbox.tick();

    const fields = {
      thread_key: threadKey,
      calendar_id: PRINCIPAL,
      length_minutes: 45,
      ...WINDOW,
      purpose: 'Partnership follow-up',
    };
    const answer = data(await ask(main, 'meeting_arrange', fields));
    expect(answer.thread_key).toBe(threadKey);
    const stored = await meeting(answer.meeting_id);
    expect(stored.counterparts).toEqual([{ address: SALES, person_id: null, name: null, level: 'unknown' }]);
    expect(stored).toMatchObject({
      level: 'unknown',
      length_minutes: 45,
      window_start: WINDOW.window_start,
      window_end: WINDOW.window_end,
      thread_key: threadKey,
    });

    const session = await meetingSession(answer.meeting_id);
    const [first, second] = contents(session);
    expect(first.brief?.meeting_id).toBe(stored.id);
    expect(first.text).toContain('copied you into');
    expect(second.text).toContain('two hours sometime next month');
    expect(await getThreadParticipants(threadKey)).toMatchObject({ state: 'open' });
  });

  describe('a copied-in thread with mail held for it', () => {
    const fields = () => ({
      calendar_id: PRINCIPAL,
      length_minutes: 45,
      ...WINDOW,
      purpose: 'Partnership follow-up',
    });

    async function copiedInWithHeldMail(): Promise<string> {
      const threadKey = await copyRobinIn();
      gmail.receive({
        threadId: 'g-acme',
        from: `Acme Sales <${SALES}>`,
        to: [PRINCIPAL],
        cc: [ROBIN],
        subject: 'Re: Partnership',
        body: 'Thursday afternoon works for us.',
      });
      await inbox.tick();
      return threadKey;
    }

    it('opens when Gmail cannot be read as its mail is handed over, and the next poll hands the mail over', async () => {
      const threadKey = await copiedInWithHeldMail();
      vi.spyOn(gmail, 'getMessage').mockRejectedValueOnce(
        new GoogleApiError(503, 'Google refused /gmail/v1/users/me/messages: backend error'),
      );

      const answer = data(await ask(main, 'meeting_arrange', { thread_key: threadKey, ...fields() }));
      const stored = await meeting(answer.meeting_id);
      expect(stored.state).toBe('active');
      expect(await getThreadParticipants(threadKey)).toMatchObject({ state: 'open' });
      const session = await meetingSession(stored.id);
      // The brief wakes the session; the mail is still held.
      expect(contents(session).map((c) => c.brief?.meeting_id)).toEqual([stored.id]);
      expect(vi.mocked(requestWake)).toHaveBeenCalledWith(
        expect.objectContaining({ id: session.id }),
        'inbound-message',
      );

      await inbox.tick();
      const [, held, ...more] = contents(session);
      expect(more).toEqual([]);
      expect(held.text).toContain('Thursday afternoon works for us.');
      expect(await count('gws_ea_inbox_held')).toBe(0);
      expect(await count('gws_ea_meetings')).toBe(1);
    });

    it('is handed back to wait for arrange, its held mail kept, when its arrange fails, so main can arrange it again', async () => {
      const threadKey = await copiedInWithHeldMail();
      vi.spyOn(gmail, 'getMessage').mockRejectedValueOnce(
        new GoogleApiError(403, 'Google refused /gmail/v1/users/me/messages: insufficient permission'),
      );

      expect(await ask(main, 'meeting_arrange', { thread_key: threadKey, ...fields() })).toMatchObject({
        ok: false,
        error: { code: 'handler-error' },
      });
      const failed = await getDb().get<{ state: string; session_id: string }>(
        'SELECT state, session_id FROM gws_ea_meetings',
      );
      expect(failed?.state).toBe('failed');
      expect((await getSession(String(failed?.session_id)))?.status).toBe('closed');
      expect(await getThreadParticipants(threadKey)).toMatchObject({ state: 'awaiting-arrange' });
      expect(await count('gws_ea_inbox_held')).toBe(1);

      const answer = data(await ask(main, 'meeting_arrange', { thread_key: threadKey, ...fields() }));
      const session = await meetingSession(answer.meeting_id);
      expect(session.id).not.toBe(failed?.session_id);
      const [brief, held, ...more] = contents(session);
      expect(more).toEqual([]);
      expect(brief.brief?.meeting_id).toBe(answer.meeting_id);
      expect(held.text).toContain('Thursday afternoon works for us.');
      expect(await getThreadParticipants(threadKey)).toMatchObject({ state: 'open' });
    });
  });

  it('is refused to every caller but main', async () => {
    const other = (await resolveSession('ag-other', 'mg-other', null, 'shared')).session;
    expect(refusal(await ask(other, 'meeting_arrange', arrangeWith(sam)))).toMatch(/main/);

    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const external = await meetingSession(answer.meeting_id);
    expect(refusal(await ask(external, 'meeting_arrange', arrangeWith(dana)))).toMatch(/main/);
    expect(await count('gws_ea_meetings')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Replays and errors
// ---------------------------------------------------------------------------

describe('a request replayed after a host restart', () => {
  it('returns the first result: no second meeting, thread, brief or note', async () => {
    const arranged = await ask(main, 'meeting_arrange', arrangeWith(sam), 'req-arrange');
    const handler = getDeliveryAction('meeting_arrange');
    await handler?.({ action: 'meeting_arrange', requestId: 'req-arrange', ...arrangeWith(sam) }, main);
    expect(responses(main, 'req-arrange')).toEqual([arranged]);
    expect(await count('gws_ea_meetings')).toBe(1);
    expect(await count('gws_ea_inbox_threads')).toBe(1);
    const session = await meetingSession(data(arranged).meeting_id);
    expect(briefs(session)).toHaveLength(1);

    const meetingId = String(data(arranged).meeting_id);
    await bookFirstTime(session, meetingId);
    const booked = await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'booked' }, 'req-booked');
    await getDeliveryAction('meeting_outcome')?.(
      { action: 'meeting_outcome', requestId: 'req-booked', meeting_id: meetingId, outcome: 'booked' },
      session,
    );
    expect(responses(session, 'req-booked')).toEqual([booked]);
    // The same outcome sent again as a new request is recorded once too.
    expect(data(await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'booked' }))).toEqual(
      data(booked),
    );
    expect(meetingNotes('booked')).toHaveLength(1);
  });

  it('finishes the meeting it already created when the host stopped before recording the answer', async () => {
    calendar.put(principalEvent('evt-review', OLU));
    calendar.put(invitation('evt-invite', OLU));
    const requests = [
      ['meeting_arrange', 'req-arrange', arrangeWith(sam)],
      [
        'meeting_reschedule',
        'req-move',
        { calendar_id: PRINCIPAL, event_id: 'evt-review', ...WINDOW, purpose: 'Moving the review' },
      ],
      [
        'meeting_reschedule',
        'req-ask',
        { calendar_id: PRINCIPAL, event_id: 'evt-invite', ...WINDOW, purpose: 'Your Tuesday invitation' },
      ],
    ] as const;
    const created = new Map<string, unknown>();
    for (const [action, requestId, fields] of requests) {
      created.set(requestId, data(await ask(main, action, fields, requestId)).meeting_id);
    }
    // The meetings opened, but the host stopped before it recorded or wrote their answers.
    await getDb().run('DELETE FROM gws_ea_meeting_requests');
    const answers = new Database(inboundDbPath(main.agent_group_id, main.id));
    answers.prepare("DELETE FROM messages_in WHERE json_extract(content, '$.type') = 'action_response'").run();
    answers.close();

    for (const [action, requestId, fields] of requests) {
      expect(data(await ask(main, action, fields, requestId)).meeting_id).toBe(created.get(requestId));
      expect(briefs(await meetingSession(created.get(requestId)))).toHaveLength(1);
    }
    expect(await count('gws_ea_meetings')).toBe(3);
    expect(await count('gws_ea_inbox_threads')).toBe(3);
  });

  it('answers a failed request with its error once, and never runs it again as a new side effect', async () => {
    calendar.failure = new GoogleApiError(503, 'Google refused /calendar: backend error');
    const failed = await ask(main, 'meeting_arrange', arrangeWith(sam), 'req-fails');
    expect(failed).toMatchObject({ ok: false, error: { code: 'handler-error' } });
    const callsAfterFailure = calendar.calls;

    calendar.failure = undefined;
    await getDeliveryAction('meeting_arrange')?.(
      { action: 'meeting_arrange', requestId: 'req-fails', ...arrangeWith(sam) },
      main,
    );
    expect(responses(main, 'req-fails')).toEqual([failed]);
    expect(calendar.calls).toBe(callsAfterFailure);
    expect(await count('gws_ea_meetings')).toBe(0);
    expect(await count('gws_ea_inbox_threads')).toBe(0);
  });

  it('answers a request delivered from the outbound mailbox, and marks it delivered', async () => {
    const db = new Database(outboundDbPath(main.agent_group_id, main.id));
    db.prepare(`INSERT INTO messages_out (id, timestamp, kind, content) VALUES (?, ?, 'system', ?)`).run(
      'req-mailbox',
      now(),
      JSON.stringify({ action: 'meeting_arrange', requestId: 'req-mailbox', ...arrangeWith(sam) }),
    );
    db.close();
    await deliverSessionMessages(main);
    await deliverSessionMessages(main);
    expect(responses(main, 'req-mailbox')).toHaveLength(1);
    expect(responses(main, 'req-mailbox')[0]).toMatchObject({ ok: true });
    expect(await count('gws_ea_meetings')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// outcome
// ---------------------------------------------------------------------------

describe('outcome', () => {
  it('is refused from main, from another group, and from a session bound to a different meeting', async () => {
    const first = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const second = data(await ask(main, 'meeting_arrange', arrangeWith(dana)));
    const secondSession = await meetingSession(second.meeting_id);
    const other = (await resolveSession('ag-other', 'mg-other', null, 'shared')).session;

    for (const caller of [main, other]) {
      expect(
        refusal(await ask(caller, 'meeting_outcome', { meeting_id: first.meeting_id, outcome: 'gave-up' })),
      ).toMatch(/Only external-email reports/);
    }
    expect(
      refusal(await ask(secondSession, 'meeting_outcome', { meeting_id: first.meeting_id, outcome: 'gave-up' })),
    ).toMatch(/Use only the meeting your brief names/);
    expect((await meeting(first.meeting_id)).state).toBe('active');
    expect(meetingNotes()).toHaveLength(0);
  });

  it('accepts booked only after the host’s own booking, and tells main in a note it turns into one line (R26)', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(answer.meeting_id);

    expect(
      refusal(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'booked' })),
    ).toMatch(/book/);
    expect(meetingNotes()).toHaveLength(0);

    const booking = await bookFirstTime(session, answer.meeting_id);
    vi.mocked(requestWake).mockClear();
    data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'booked' }));

    const stored = await meeting(answer.meeting_id);
    expect(stored.state).toBe('booked');
    const [note] = meetingNotes('booked');
    expect(note.note).toMatchObject({
      meeting_id: answer.meeting_id,
      outcome: 'booked',
      booking: { calendar_id: PRINCIPAL, event_id: booking.event_id, start: booking.start, end: booking.end },
    });
    expect(note.text).toContain('Sam Lee');
    expect(note.text).toContain('one line');
    expect(note.row.trigger).toBe(1);
    expect(vi.mocked(requestWake)).toHaveBeenCalledWith(expect.objectContaining({ id: main.id }), 'inbound-message');
    // The session stays open after booking, so a later "can we move it?" lands there.
    expect((await getSession(session.id))?.status).toBe('active');
  });

  it('refuses needs-room for an active or known meeting, and accepts it for a close one', async () => {
    for (const person of [sam, olu]) {
      const answer = data(await ask(main, 'meeting_arrange', arrangeWith(person)));
      const session = await meetingSession(answer.meeting_id);
      expect(
        refusal(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'needs-room' })),
      ).toMatch(/close/);
    }
    const close = data(await ask(main, 'meeting_arrange', arrangeWith(dana)));
    const closeSession = await meetingSession(close.meeting_id);
    data(await ask(closeSession, 'meeting_outcome', { meeting_id: close.meeting_id, outcome: 'needs-room' }));
    expect(meetingNotes('needs-room')).toHaveLength(1);
    expect((await meeting(close.meeting_id)).state).toBe('active');
  });

  it('hands a copied-in thread that is not about scheduling back to main to triage (R19)', async () => {
    const threadKey = await copyRobinIn();
    const answer = data(
      await ask(main, 'meeting_arrange', {
        thread_key: threadKey,
        calendar_id: PRINCIPAL,
        length_minutes: 30,
        ...WINDOW,
        purpose: 'Whatever the principal needs',
      }),
    );
    const session = await meetingSession(answer.meeting_id);
    data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'not-scheduling' }));

    const [note] = meetingNotes('not-scheduling');
    expect(note.note).toMatchObject({ thread_key: threadKey });
    expect(note.text).toContain(`thread_key ${threadKey}`);
    expect(note.text).not.toMatch(/can't take it on/);
    expect((await meeting(answer.meeting_id)).state).toBe('not-scheduling');
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await getThreadParticipants(threadKey)).toMatchObject({ state: 'awaiting-arrange' });
    expect(gmail.sent).toHaveLength(0);
  });

  it('refuses not-scheduling for a thread main opened for scheduling', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(answer.meeting_id);
    refusal(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'not-scheduling' }));
  });

  it('reports gave-up and closes the session', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(answer.meeting_id);
    data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'gave-up' }));
    expect(meetingNotes('gave-up')).toHaveLength(1);
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(
      refusal(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'booked' })),
    ).toMatch(/gave-up/);
  });
});

// ---------------------------------------------------------------------------
// ask_organizer and settled
// ---------------------------------------------------------------------------

function invitation(id: string, organizer: string, startHour = 10, endHour = 11): StoredEvent {
  return {
    calendarId: PRINCIPAL,
    id,
    iCalUID: `${id}@google.com`,
    status: 'confirmed',
    organizer: { email: organizer },
    attendees: [
      { email: organizer, organizer: true, responseStatus: 'accepted' },
      { email: PRINCIPAL, responseStatus: 'needsAction' },
    ],
    start: { dateTime: inDays(9, startHour) },
    end: { dateTime: inDays(9, endHour) },
  };
}

function principalEvent(id: string, attendee: string, startHour = 10, endHour = 11): StoredEvent {
  return {
    calendarId: PRINCIPAL,
    id,
    iCalUID: `${id}@google.com`,
    status: 'confirmed',
    organizer: { email: PRINCIPAL },
    attendees: [
      { email: PRINCIPAL, organizer: true, responseStatus: 'accepted' },
      { email: attendee, responseStatus: 'accepted' },
      { email: 'room-1@resource.calendar.google.com', resource: true, responseStatus: 'accepted' },
    ],
    start: { dateTime: inDays(9, startHour) },
    end: { dateTime: inDays(9, endHour) },
  };
}

describe('rescheduling an invitation someone else organizes', () => {
  it('asks the organizer Google reports, for the length of their invitation, and says so', async () => {
    calendar.put(invitation('evt-invite', OLU, 10, 11));
    const answer = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-invite',
        ...WINDOW,
        purpose: 'Your Thursday invitation',
      }),
    );
    expect(answer.message).toMatch(/to ask its organizer about/);
    const stored = await meeting(answer.meeting_id);
    expect(stored).toMatchObject({
      kind: 'ask_organizer',
      level: 'known',
      length_minutes: 60,
      event_calendar_id: PRINCIPAL,
      event_id: 'evt-invite',
      booking_calendar_id: null,
    });
    expect(stored.counterparts).toEqual([{ address: OLU, person_id: olu.id, name: 'Olu Ade', level: 'known' }]);
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({
      origin: 'ask_organizer',
      people: { to: [OLU], cc: [], bcc: [] },
    });
  });

  it('writes to an organizer without a record, who is judged like anyone else (R16)', async () => {
    calendar.put(invitation('evt-stranger', LEE));
    const answer = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-stranger',
        ...WINDOW,
        purpose: 'Your invitation',
      }),
    );
    const stored = await meeting(answer.meeting_id);
    expect(stored).toMatchObject({ kind: 'ask_organizer', level: 'unknown' });
    expect(stored.counterparts).toEqual([{ address: LEE, person_id: null, name: null, level: 'unknown' }]);
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({
      origin: 'ask_organizer',
      people: { to: [LEE], cc: [], bcc: [] },
    });
  });

  it('accepts settled only once the invitation moved to an offered slot or its conflict cleared', async () => {
    calendar.put(invitation('evt-invite', OLU, 10, 11));
    calendar.put(principalEvent('evt-standup', SAM, 10, 11));
    const answer = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-invite',
        ...WINDOW,
        purpose: 'Your Thursday invitation',
      }),
    );
    const meetingId = String(answer.meeting_id);
    const session = await meetingSession(meetingId);

    // Still clashing with the standup: refused.
    expect(refusal(await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'settled' }))).toMatch(
      /conflict/,
    );

    // Moved, but to a time nobody offered, which still clashes: refused.
    calendar.put(principalEvent('evt-lunch', SAM, 13, 14));
    calendar.put({ ...invitation('evt-invite', OLU, 13, 14) });
    refusal(await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'settled' }));

    // Moved to a time external-email offered: accepted on that alone, even with something else there since.
    const [slot] = slotsOf(await ask(session, 'meeting_free_time', { meeting_id: meetingId }));
    const at = { start: { dateTime: slot.start }, end: { dateTime: slot.end } };
    calendar.put({ ...principalEvent('evt-later', SAM), ...at });
    calendar.put({ ...invitation('evt-invite', OLU), ...at });
    data(await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'settled' }));
    expect((await meeting(meetingId)).state).toBe('settled');
    expect(meetingNotes('settled')).toHaveLength(1);
    expect((await getSession(session.id))?.status).toBe('closed');
  });

  it('refuses to make room with it or change its length: both are its organizer’s', async () => {
    calendar.put(invitation('evt-invite', OLU, 10, 11));
    const request = { calendar_id: PRINCIPAL, event_id: 'evt-invite', ...WINDOW, purpose: 'Your invitation' };
    expect(
      refusal(
        await ask(main, 'meeting_reschedule', {
          ...request,
          making_room_for: `mtg-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`,
        }),
      ),
    ).toMatch(/never moves to make room/);
    expect(refusal(await ask(main, 'meeting_reschedule', { ...request, length_minutes: 30 }))).toMatch(
      /length is theirs to change/,
    );
    expect(await count('gws_ea_meetings')).toBe(0);
  });

  it('accepts settled when the conflicting event is gone', async () => {
    calendar.put(invitation('evt-invite', OLU, 10, 11));
    calendar.put(principalEvent('evt-standup', SAM, 10, 11));
    const answer = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-invite',
        ...WINDOW,
        purpose: 'Your Thursday invitation',
      }),
    );
    const session = await meetingSession(answer.meeting_id);
    calendar.remove(PRINCIPAL, 'evt-standup');
    data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'settled' }));
  });
});

// ---------------------------------------------------------------------------
// reschedule
// ---------------------------------------------------------------------------

describe('reschedule', () => {
  it('is accepted for a meeting the principal organizes, with its attendees as counterparts', async () => {
    calendar.put(principalEvent('evt-review', SAM, 10, 11));
    const answer = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-review',
        ...WINDOW,
        purpose: 'Moving our review',
      }),
    );
    const stored = await meeting(answer.meeting_id);
    expect(stored).toMatchObject({
      kind: 'reschedule',
      level: 'active',
      length_minutes: 60,
      booking_calendar_id: PRINCIPAL,
      event_calendar_id: PRINCIPAL,
      event_id: 'evt-review',
    });
    expect(stored.counterparts.map((c) => c.address)).toEqual([SAM]);
  });

  it('continues in the thread of a meeting the assistant booked, which it takes over', async () => {
    const arranged = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(arranged.meeting_id);
    const booking = await bookFirstTime(session, arranged.meeting_id);
    data(await ask(session, 'meeting_outcome', { meeting_id: arranged.meeting_id, outcome: 'booked' }));

    const moved = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: booking.event_id,
        ...WINDOW,
        purpose: 'Moving our intro',
      }),
    );
    expect((await meeting(arranged.meeting_id)).state).toBe('superseded');
    const stored = await meeting(moved.meeting_id);
    expect(stored).toMatchObject({
      session_id: session.id,
      length_minutes: 30,
      replaces_meeting_id: arranged.meeting_id,
    });
    expect(briefs(session).map((b) => b.brief?.meeting_id)).toEqual([arranged.meeting_id, moved.meeting_id]);
  });
});

// ---------------------------------------------------------------------------
// cancel and amend
// ---------------------------------------------------------------------------

describe('cancel', () => {
  it('releases the meeting, closes its session, sends the counterparts one checked line, and leaves no deadline', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const stored = await meeting(answer.meeting_id);
    const session = await meetingSession(answer.meeting_id);
    await reply(session, stored.thread_key, 'Hello Sam, I am Robin, Pat Doe’s assistant. Would Tuesday at 10:00 work?');
    expect(gmail.sent).toHaveLength(1);
    await getDb().run(
      'UPDATE gws_ea_meetings SET nudge_at = ?, give_up_at = ? WHERE id = ?',
      inDays(2),
      inDays(4),
      stored.id,
    );

    const cancelled = data(await ask(main, 'meeting_cancel', { meeting_id: stored.id }));
    expect(cancelled).toMatchObject({ state: 'cancelled', counterparts_told: true });

    expect(gmail.sent).toHaveLength(2);
    const line = gmail.sent[1];
    expect(line.threadId).toBe(gmail.sent[0].threadId);
    expect(header(line.headers, 'To')).toBe(SAM);
    expect(line.text.split('\n').filter((l) => l.trim() !== '').length).toBeLessThanOrEqual(2);

    const after = await meeting(stored.id);
    expect(after).toMatchObject({ state: 'cancelled', nudge_at: null, give_up_at: null });
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(vi.mocked(killContainer)).toHaveBeenCalledWith(session.id, expect.any(String));
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
    expect(
      await getDb().all('SELECT thread_id FROM gws_ea_privacy_threads WHERE thread_id = ?', stored.thread_key),
    ).toEqual([]);

    // A cancelled meeting takes no more outcomes.
    refusal(await ask(session, 'meeting_outcome', { meeting_id: stored.id, outcome: 'gave-up' }));
  });

  it('checks the line like every send, so a line carrying a private detail is not sent', async () => {
    await addPrivateValue({ label: 'Full name', kind: 'other', value: 'Pat Doe' });
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const stored = await meeting(answer.meeting_id);
    const session = await meetingSession(answer.meeting_id);
    await reply(session, stored.thread_key, 'Hello Sam, I am Robin. Would Tuesday at 10:00 work?');
    expect(gmail.sent).toHaveLength(1);

    expect(data(await ask(main, 'meeting_cancel', { meeting_id: stored.id }))).toMatchObject({
      state: 'cancelled',
      counterparts_told: false,
    });
    expect(gmail.sent).toHaveLength(1);
    expect((await getSession(session.id))?.status).toBe('closed');
  });

  it('sends no line to people the assistant has not written to yet', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    expect(data(await ask(main, 'meeting_cancel', { meeting_id: answer.meeting_id }))).toMatchObject({
      counterparts_told: false,
    });
    expect(gmail.sent).toHaveLength(0);
  });
});

describe('cancel for an event the principal organizes (R8)', () => {
  it("deletes it with Google's own cancellation notice to its guests, and no text of the assistant's", async () => {
    calendar.put(principalEvent('evt-review', SAM, 10, 11));
    const answer = data(await ask(main, 'meeting_cancel', { calendar_id: PRINCIPAL, event_id: 'evt-review' }));
    expect(answer).toMatchObject({ calendar_id: PRINCIPAL, event_id: 'evt-review', state: 'cancelled' });
    expect(String(answer.message)).toContain(SAM);
    expect(calendar.writes).toEqual([
      { op: 'delete', calendarId: PRINCIPAL, eventId: 'evt-review', sendUpdates: 'all' },
    ]);
    expect(calendar.event(PRINCIPAL, 'evt-review')?.status).toBe('cancelled');
    // The notification Google sends about it is the assistant's own change.
    expect(consumeOwnCalendarChange(PRINCIPAL, 'evt-review', new Date())).toBe(true);
    expect(gmail.sent).toHaveLength(0);
    expect(await count('gws_ea_meetings')).toBe(0);
  });

  it('refuses an event someone else organizes: ask its organizer instead', async () => {
    calendar.put(invitation('evt-theirs', OLU));
    const message = refusal(await ask(main, 'meeting_cancel', { calendar_id: PRINCIPAL, event_id: 'evt-theirs' }));
    expect(message).toMatch(/have meeting_reschedule ask its organizer/);
    expect(calendar.writes).toEqual([]);
    expect(calendar.event(PRINCIPAL, 'evt-theirs')?.status).toBe('confirmed');
  });

  it('refuses an event on a calendar the assistant cannot change', async () => {
    calendar.put({ ...principalEvent('evt-holiday', SAM), calendarId: READ_ONLY_CALENDAR });
    const message = refusal(
      await ask(main, 'meeting_cancel', { calendar_id: READ_ONLY_CALENDAR, event_id: 'evt-holiday' }),
    );
    expect(message).toMatch(/calendar/i);
    expect(calendar.writes).toEqual([]);
  });

  it('answers a replay with the first result, and deletes nothing twice', async () => {
    calendar.put(principalEvent('evt-review', SAM, 10, 11));
    const fields = { calendar_id: PRINCIPAL, event_id: 'evt-review' };
    const first = await ask(main, 'meeting_cancel', fields, 'req-cancel-event');
    await getDeliveryAction('meeting_cancel')?.(
      { action: 'meeting_cancel', requestId: 'req-cancel-event', ...fields },
      main,
    );
    expect(responses(main, 'req-cancel-event')).toEqual([first]);
    // Asked again as a new request, it is already cancelled.
    expect(data(await ask(main, 'meeting_cancel', fields))).toMatchObject({ state: 'cancelled' });
    expect(calendar.writes.filter((write) => write.op === 'delete')).toHaveLength(1);
  });

  it('ends a meeting the assistant booked as that event, as cancelling the meeting does', async () => {
    const arranged = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const stored = await meeting(arranged.meeting_id);
    const session = await meetingSession(arranged.meeting_id);
    await reply(session, stored.thread_key, 'Hello Sam, I am Robin. Would Tuesday at 10:00 work?');
    const booking = await bookFirstTime(session, stored.id);
    data(await ask(session, 'meeting_outcome', { meeting_id: stored.id, outcome: 'booked' }));

    const answer = data(await ask(main, 'meeting_cancel', { calendar_id: PRINCIPAL, event_id: booking.event_id }));
    expect(answer).toMatchObject({ state: 'cancelled', meeting_id: stored.id });
    expect(calendar.event(PRINCIPAL, booking.event_id)?.status).toBe('cancelled');
    expect((await meeting(stored.id)).state).toBe('cancelled');
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
    expect(gmail.sent).toHaveLength(2);
  });
});

describe('amend', () => {
  it('writes a new brief into the meeting’s session', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(answer.meeting_id);
    vi.mocked(requestWake).mockClear();

    const amended = data(
      await ask(main, 'meeting_amend', {
        meeting_id: answer.meeting_id,
        length_minutes: 60,
        constraints: 'Afternoons now suit better.',
      }),
    );
    expect(amended).toMatchObject({ brief_version: 2 });
    const all = briefs(session);
    expect(all.map((b) => b.brief?.version)).toEqual([1, 2]);
    expect(all[1].text).toContain('60');
    expect(all[1].text).toContain('Afternoons now suit better.');
    expect(await meeting(answer.meeting_id)).toMatchObject({ length_minutes: 60, brief_version: 2 });
    expect(vi.mocked(requestWake)).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), 'inbound-message');
  });
});

// ---------------------------------------------------------------------------
// Ending a thread from elsewhere
// ---------------------------------------------------------------------------

describe('a thread the privacy check stops', () => {
  it('closes its meeting’s session, so it cannot keep waking its agent', async () => {
    await addPrivateValue({ label: 'Home', kind: 'address', value: '12 Elm Road, Springfield' });
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const stored = await meeting(answer.meeting_id);
    const session = await meetingSession(answer.meeting_id);
    for (let attempt = 0; attempt < 3; attempt++) {
      await reply(session, stored.thread_key, 'Come to 12 Elm Road, Springfield.');
    }
    expect(gmail.sent).toHaveLength(0);
    expect((await meeting(stored.id)).state).toBe('stopped');
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
  });
});

describe('forgetting a person', () => {
  it("purges their meetings and their meetings' sessions", async () => {
    const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-meetings-secrets-'));
    fs.chmodSync(secrets, 0o700);
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(secrets, 'google-grant.json'));
    try {
      const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
      const kept = data(await ask(main, 'meeting_arrange', arrangeWith(dana)));
      const stored = await meeting(answer.meeting_id);
      const session = await meetingSession(answer.meeting_id);

      await forgetPerson({ id: sam.id, source: 'principal' });

      expect(await getMeeting(stored.id)).toBeUndefined();
      expect(await getSession(session.id)).toBeUndefined();
      expect(fs.existsSync(inboundDbPath(session.agent_group_id, session.id))).toBe(false);
      expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
      expect(
        await getDb().all('SELECT request_id FROM gws_ea_meeting_requests WHERE meeting_id = ?', stored.id),
      ).toEqual([]);
      expect(await getMeeting(String(kept.meeting_id))).toBeDefined();
    } finally {
      fs.rmSync(secrets, { recursive: true, force: true });
    }
  });
});
