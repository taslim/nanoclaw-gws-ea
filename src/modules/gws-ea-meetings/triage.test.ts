/**
 * A human assistant's inbox, on the meetings side (KTD16; R16, R19, R40, R41,
 * AE10, AE11): `main` schedules in the thread a request came in on, answers
 * a thread once with `respond`, closes one with `dismiss`, adds people with
 * `amend`, and answers the principal by email; `external-email` replies to
 * everyone on the thread, placed as it chooses among them.
 *
 * Drives the real delivery actions, guards, inbox, router, privacy check and
 * session DBs against an in-memory Gmail and Google Calendar. Only the
 * container runtime and its wake are mocked, and the clock is fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-triage';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-triage',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-triage/groups',
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
import { getSession } from '../../db/sessions.js';
import { deliverSessionMessages } from '../../delivery.js';
import { addPerson } from '../gws-ea-people/db.js';
import { getThreadParticipants, GoogleApiError } from '../gws-ea-inbox/index.js';
import { header, type SentMail } from './testing/fake-gmail.js';
import {
  ADDRESSES,
  ask,
  contents,
  data,
  meeting,
  meetingSession,
  notes,
  PRINCIPAL,
  refusal,
  reply,
  setUpScheduling,
  tearDownScheduling,
  type Scheduling,
} from './testing/scheduling.js';

/** Monday 5 October 2026, 08:00 in London (BST, UTC+1). */
const NOW = '2026-10-05T07:00:00.000Z';
/** Tuesday 6 October to the end of Friday 16 October, London. */
const WINDOW = { window_start: '2026-10-06T00:00:00+01:00', window_end: '2026-10-17T00:00:00+01:00' };

const UNSENT = 'gws-ea-meetings.unsent';
const JANE = 'jane@partner.example';

let scheduling: Scheduling;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
  scheduling = await setUpScheduling(TEST_DIR, google);
});

afterEach(async () => {
  vi.useRealTimers();
  await tearDownScheduling(TEST_DIR);
});

function arrangeOn(threadKey: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    thread_key: threadKey,
    calendar_id: PRINCIPAL,
    length_minutes: 30,
    ...WINDOW,
    purpose: 'Catch up',
    ...extra,
  };
}

function recipientsOf(sent: SentMail): { to?: string; cc?: string; bcc?: string } {
  return { to: header(sent.headers, 'To'), cc: header(sent.headers, 'Cc'), bcc: header(sent.headers, 'Bcc') };
}

async function meetingCount(): Promise<number> {
  const row = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM gws_ea_meetings');
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Scheduling in the thread a request came in on
// ---------------------------------------------------------------------------

describe('AE10: Sam, who has a record, emails the assistant for time', () => {
  it('refuses a thread key that is not a thread waiting for main, naming no copy-in key', async () => {
    const message = refusal(await ask(scheduling.main, 'meeting_arrange', arrangeOn('not-a-key')));
    expect(message).not.toContain('mail-copy');
    expect(await meetingCount()).toBe(0);
  });
});

describe('a new thread the assistant starts', () => {
  it('copies the principal only when main asks', async () => {
    const plain = data(
      await ask(scheduling.main, 'meeting_arrange', {
        people: [{ person_id: scheduling.people.acme.id }],
        calendar_id: PRINCIPAL,
        length_minutes: 30,
        ...WINDOW,
        purpose: 'Partnership intro',
      }),
    );
    const copied = data(
      await ask(scheduling.main, 'meeting_arrange', {
        people: [{ person_id: scheduling.people.pat.id }],
        calendar_id: PRINCIPAL,
        length_minutes: 30,
        ...WINDOW,
        purpose: 'Warm introduction',
        copy_principal: true,
      }),
    );
    expect((await getThreadParticipants(String(plain.thread_key)))?.people).toEqual({
      to: [ADDRESSES.acme],
      cc: [],
      bcc: [],
    });
    expect((await getThreadParticipants(String(copied.thread_key)))?.people).toEqual({
      to: [ADDRESSES.pat],
      cc: [PRINCIPAL],
      bcc: [],
    });

    const session = await meetingSession(copied.meeting_id);
    expect(contents(session)[0].text).toContain(`the principal <${PRINCIPAL}>`);
    await reply(session, String(copied.thread_key), 'Hello Pat, Alex asked me to introduce you both.');
    expect(recipientsOf(scheduling.gmail.sent[0])).toEqual({ to: ADDRESSES.pat, cc: PRINCIPAL, bcc: undefined });
  });
});

// ---------------------------------------------------------------------------
// Reply-all (R40)
// ---------------------------------------------------------------------------

describe('amend with people', () => {
  it('adds Jane to the meeting and its thread, briefs external-email, and the next reply includes Jane', async () => {
    const jane = await addPerson({
      name: 'Jane Roe',
      level: 'known',
      source: 'principal',
      basis: 'a partner',
      identity: `email:${JANE}`,
    });
    const answer = data(
      await ask(scheduling.main, 'meeting_arrange', {
        people: [{ person_id: scheduling.people.sam.id }],
        calendar_id: PRINCIPAL,
        length_minutes: 30,
        ...WINDOW,
        purpose: 'Project review',
      }),
    );
    const session = await meetingSession(answer.meeting_id);
    const threadKey = String(answer.thread_key);
    await reply(session, threadKey, 'Hello Sam, would Tuesday at 10:00 suit?');

    const amended = data(
      await ask(scheduling.main, 'meeting_amend', { meeting_id: answer.meeting_id, people: [{ person_id: jane.id }] }),
    );
    expect(amended).toMatchObject({ brief_version: 2 });
    const stored = await meeting(answer.meeting_id);
    expect(stored.counterparts.map((c) => c.address)).toEqual([ADDRESSES.sam, JANE]);
    expect(stored.level).toBe('known');
    const latest = contents(session).filter((c) => c.brief !== undefined);
    expect(latest.map((c) => c.brief?.version)).toEqual([1, 2]);
    expect(latest[1].text).toContain(`Jane Roe <${JANE}>`);
    expect(latest[1].text).toMatch(/main added Jane Roe/);

    await reply(session, threadKey, 'Welcome, Jane. Would Tuesday at 10:00 suit you too?');
    expect(recipientsOf(scheduling.gmail.sent[1])).toEqual({
      to: `${ADDRESSES.sam}, ${JANE}`,
      cc: undefined,
      bcc: undefined,
    });
  });

  it('refuses people for a meeting that moves an existing event', async () => {
    scheduling.calendar.put({
      calendarId: PRINCIPAL,
      id: 'evt-review',
      iCalUID: 'evt-review@google.com',
      status: 'confirmed',
      organizer: { email: PRINCIPAL },
      attendees: [
        { email: PRINCIPAL, organizer: true, responseStatus: 'accepted' },
        { email: ADDRESSES.sam, responseStatus: 'accepted' },
      ],
      start: { dateTime: '2026-10-08T09:00:00Z' },
      end: { dateTime: '2026-10-08T10:00:00Z' },
    });
    const moved = data(
      await ask(scheduling.main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-review',
        ...WINDOW,
        purpose: 'Moving our review',
      }),
    );
    expect(
      refusal(
        await ask(scheduling.main, 'meeting_amend', {
          meeting_id: moved.meeting_id,
          people: [{ person_id: scheduling.people.dana.id }],
        }),
      ),
    ).toMatch(/arrange/);
  });
});

describe('an email delivery gives up on, in a meeting being arranged', () => {
  it('reaches main once, with the meeting and its thread, while the meeting stays open; the principal gets nothing', async () => {
    const answer = data(
      await ask(scheduling.main, 'meeting_arrange', {
        people: [{ person_id: scheduling.people.acme.id }],
        calendar_id: PRINCIPAL,
        length_minutes: 30,
        ...WINDOW,
        purpose: 'Partnership intro',
      }),
    );
    const meetingId = String(answer.meeting_id);
    const threadKey = String(answer.thread_key);
    const session = await meetingSession(meetingId);
    vi.spyOn(scheduling.gmail, 'send').mockRejectedValue(
      new GoogleApiError(400, 'Google refused /gmail/v1/users/me/messages/send: bad request'),
    );

    await reply(session, threadKey, 'Hello, I am Juno, Alex Doe’s assistant. Would Tuesday at 10:00 suit?');
    await deliverSessionMessages(session);
    expect(notes(scheduling.main, UNSENT)).toHaveLength(0);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    const [note, ...more] = notes(scheduling.main, UNSENT);
    expect(more).toEqual([]);
    expect(note.note).toMatchObject({ meeting_id: meetingId, thread_key: threadKey });
    expect(note.text).toMatch(/could not be sent/);
    expect(note.text).toContain(ADDRESSES.acme);
    expect(note.text).toContain(meetingId);
    expect(note.text).toContain(`thread_key ${threadKey}`);
    expect(note.text).toMatch(/amend/);
    expect(note.text).toMatch(/cancel/);
    expect(note.row.trigger).toBe(1);
    expect(scheduling.chat).toEqual([]);

    // The meeting goes on, so main can amend or cancel it.
    expect((await meeting(meetingId)).state).toBe('active');
    expect((await getSession(session.id))?.status).toBe('active');
    expect(await getThreadParticipants(threadKey)).toMatchObject({ state: 'open' });
  });
});

// ---------------------------------------------------------------------------
// respond and dismiss
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The principal's email, answered by email (R41)
// ---------------------------------------------------------------------------
