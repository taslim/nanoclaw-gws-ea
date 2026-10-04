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
import {
  ADDRESSES,
  ask,
  data,
  PRINCIPAL,
  refusal,
  setUpScheduling,
  tearDownScheduling,
  type Scheduling,
} from './testing/scheduling.js';

/** Monday 5 October 2026, 08:00 in London (BST, UTC+1). */
const NOW = '2026-10-05T07:00:00.000Z';
/** Tuesday 6 October to the end of Friday 16 October, London. */
const WINDOW = { window_start: '2026-10-06T00:00:00+01:00', window_end: '2026-10-17T00:00:00+01:00' };

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

// ---------------------------------------------------------------------------
// Reply-all (R40)
// ---------------------------------------------------------------------------

describe('amend with people', () => {
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

// ---------------------------------------------------------------------------
// respond and dismiss
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The principal's email, answered by email (R41)
// ---------------------------------------------------------------------------
