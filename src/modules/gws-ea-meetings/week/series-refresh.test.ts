import fs from 'node:fs';
import path from 'node:path';
import recurrenceRules from 'rrule';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/series-week-refresh-${process.pid}`);
vi.mock('../../../config.js', async (original) => ({
  ...(await original<typeof import('../../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { closeDb, createAgentGroup, createSession, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { sessionDir } from '../../../session-manager.js';
import type { Session } from '../../../types.js';
import '../../gws-ea-profile/index.js';
import '../../gws-ea-manual/index.js';
import '../../gws-ea-matters/index.js';
import '../index.js';
import { addPrincipalAddress } from '../../gws-ea-profile/db.js';
import type { DetailedEvent, EventGuests } from '../calendar-api.js';
import { createPrincipalEventTools } from '../principal-events.js';
import { FakeCalendar, type StoredEvent } from '../testing/fake-calendar.js';
import { createWeekRefresher } from './refresh.js';
import { getCalendarWrite } from './write-log.js';
import type { WeekView } from './view.js';

const principal = 'morgan@ellery.example';
const stamp = '2026-10-05T07:00:00Z';
const compact = (at: string) => at.replace(/[-:]/gu, '').replace('.000', '');

/** Google expands stored masters when singleEvents is requested; the ordinary fake stores only masters. */
class ExpandedCalendar extends FakeCalendar {
  private occurrences(master: StoredEvent, start: string, end: string): DetailedEvent[] {
    if (!master.recurrence?.length || !master.start?.dateTime || !master.end?.dateTime) return [];
    const duration = Date.parse(master.end.dateTime) - Date.parse(master.start.dateTime);
    const rule = recurrenceRules.rrulestr(
      [`DTSTART:${compact(new Date(master.start.dateTime).toISOString())}`, ...master.recurrence].join('\n'),
    );
    return rule.between(new Date(Date.parse(start) - duration), new Date(end), true).flatMap((at) => {
      if (at.getTime() >= Date.parse(end) || at.getTime() + duration <= Date.parse(start)) return [];
      const from = at.toISOString();
      return [
        {
          ...master,
          conference: master.conference
            ? {
                ...master.conference,
                entryPoints: master.conference.uri ? [{ entryPointType: 'video', uri: master.conference.uri }] : [],
              }
            : undefined,
          id: `${master.id}_${compact(from)}`,
          recurrence: undefined,
          recurringEventId: master.id,
          iCalUID: master.iCalUID ?? master.id,
          originalStartTime: { dateTime: from, timeZone: 'UTC' },
          start: { dateTime: from, timeZone: 'UTC' },
          end: { dateTime: new Date(at.getTime() + duration).toISOString(), timeZone: 'UTC' },
        },
      ];
    });
  }

  override async getEventDetail(calendarId: string, eventId: string): Promise<DetailedEvent | undefined> {
    const stored = await super.getEventDetail(calendarId, eventId);
    return (
      stored ??
      this.live(calendarId)
        .flatMap((master) => this.occurrences(master, '2026-10-01T00:00:00Z', '2027-01-01T00:00:00Z'))
        .find((event) => event.id === eventId)
    );
  }

  override async listEventDetails(calendarId: string, start: string, end: string): Promise<DetailedEvent[]> {
    const direct = await super.listEventDetails(calendarId, start, end);
    const exceptions = new Set(
      this.events.filter((event) => event.calendarId === calendarId && event.recurringEventId).map((event) => event.id),
    );
    return [
      ...direct.filter((event) => !event.recurrence?.length),
      ...this.live(calendarId).flatMap((master) =>
        this.occurrences(master, start, end).filter((event) => !exceptions.has(event.id ?? '')),
      ),
    ];
  }

  override async getGuests(calendarId: string, eventId: string): Promise<EventGuests | undefined> {
    const stored = await super.getGuests(calendarId, eventId);
    if (stored) return stored;
    const event = await this.getEventDetail(calendarId, eventId);
    return event?.recurringEventId
      ? { etag: event.etag, guests: event.attendees?.map((guest) => ({ ...guest })) ?? [] }
      : undefined;
  }
}

let calendar: ExpandedCalendar;
let main: Session;
let tools: ReturnType<typeof createPrincipalEventTools>;
let refresher: ReturnType<typeof createWeekRefresher>;

function eventLines(): { date: string; text: string }[] {
  const view = JSON.parse(
    fs.readFileSync(path.join(sessionDir('main', main.id), 'week-view.json'), 'utf8'),
  ) as WeekView;
  return view.days.flatMap((day) =>
    day.entries.filter((entry) => entry.id.startsWith('event:')).map((entry) => ({ date: day.date, text: entry.text })),
  );
}
function seedSeries(): void {
  calendar.put({
    calendarId: principal,
    id: 'dailyplan',
    iCalUID: 'daily-planning-uid',
    summary: 'Daily planning',
    organizer: { email: principal, self: true },
    creator: { email: principal, self: true },
    attendees: [{ email: principal, responseStatus: 'accepted', organizer: true }],
    start: { dateTime: '2026-10-05T16:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-10-05T16:30:00Z', timeZone: 'UTC' },
    recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
  });
}
async function refreshSeries(requestId: string) {
  expect(await getCalendarWrite(requestId)).toMatchObject({ state: 'applied', refreshScope: 'series' });
  const reads = vi.spyOn(calendar, 'listEventDetails');
  await refresher.refresh();
  return reads;
}

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(stamp), toFake: ['Date'] });
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'main', name: 'main', folder: 'main', created_at: stamp, agent_provider: null });
  await getDb().run(
    "UPDATE gws_ea_profile SET main_agent_group_id='main',principal_timezone='America/Los_Angeles',principal_first_name='Morgan',assistant_first_name='Aster' WHERE singleton=1",
  );
  await addPrincipalAddress(principal);
  main = {
    id: 'main-week',
    agent_group_id: 'main',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: 'claude',
    status: 'active',
    container_status: 'stopped',
    last_active: stamp,
    created_at: stamp,
  };
  await createSession(main);
  calendar = new ExpandedCalendar();
  calendar.calendars.set(principal, { id: principal, accessRole: 'writer' });
  tools = createPrincipalEventTools({ calendar: () => calendar });
  refresher = createWeekRefresher({ calendar: () => calendar });
});
afterEach(async () => {
  await refresher.stop();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('loads every new occurrence after native recurring creation on a primed empty view', async () => {
  await refresher.refresh();
  await tools.createEvent(
    {
      calendar: principal,
      title: 'Daily planning',
      start: '2026-10-06T16:00:00Z',
      end: '2026-10-06T16:30:00Z',
      timezone: 'UTC',
      recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
    },
    main,
    'new-series',
  );
  const reads = await refreshSeries('new-series');
  expect(eventLines().map((event) => event.date)).toEqual([
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-10',
  ]);
  expect(
    reads.mock.calls.some(([, start, end]) => {
      const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
      return days >= 59 && days <= 61;
    }),
  ).toBe(true);
});

it('replaces later cached occurrences after a native master edit', async () => {
  seedSeries();
  await refresher.refresh();
  await tools.changeEvent(
    { calendar: principal, event: 'dailyplan', title: 'Changed daily plan', send_updates: 'none' },
    main,
    'master-edit',
  );
  await refreshSeries('master-edit');
  expect(eventLines()).toHaveLength(5);
  expect(eventLines().every((event) => event.text.includes('Changed daily plan'))).toBe(true);
});

it('keeps a native single-occurrence change confined to its touched day', async () => {
  seedSeries();
  const master = calendar.event(principal, 'dailyplan');
  if (!master) throw new Error('The test series is missing');
  calendar.put({
    ...master,
    id: 'dailyplan_20261007T160000Z',
    recurrence: undefined,
    recurringEventId: 'dailyplan',
    originalStartTime: { dateTime: '2026-10-07T16:00:00Z', timeZone: 'UTC' },
    start: { dateTime: '2026-10-07T16:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-10-07T16:30:00Z', timeZone: 'UTC' },
  });
  await refresher.refresh();
  await tools.changeEvent(
    {
      calendar: principal,
      event: 'dailyplan_20261007T160000Z',
      title: 'Changed only this',
      send_updates: 'none',
    },
    main,
    'one-occurrence',
  );
  expect(await getCalendarWrite('one-occurrence')).toMatchObject({ refreshScope: 'event' });
  const reads = vi.spyOn(calendar, 'listEventDetails');
  await refresher.refresh();
  const lines = eventLines();
  expect(lines).toHaveLength(5);
  expect(lines.find((event) => event.date === '2026-10-07')?.text).toContain('Changed only this');
  expect(
    lines.filter((event) => event.date !== '2026-10-07').every((event) => event.text.includes('Daily planning')),
  ).toBe(true);
  expect(reads.mock.calls.length).toBeGreaterThan(0);
  expect(reads.mock.calls.every(([, start, end]) => Date.parse(end) - Date.parse(start) <= 86_400_000)).toBe(true);
});

it('replaces every later cached occurrence after a native following-series move', async () => {
  seedSeries();
  await refresher.refresh();
  await tools.changeEvent(
    {
      calendar: principal,
      event: 'dailyplan_20261007T160000Z',
      start: '2026-10-07T17:00:00Z',
      end: '2026-10-07T17:30:00Z',
      timezone: 'UTC',
      scope: 'following',
      send_updates: 'none',
    },
    main,
    'following-move',
  );
  await refreshSeries('following-move');
  const lines = eventLines();
  expect(lines.map((event) => event.date)).toEqual([
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
  ]);
  expect(lines.filter((event) => event.date >= '2026-10-07').every((event) => event.text.includes('10:00'))).toBe(true);
});

it('removes all later cached occurrences after native following-series cancellation', async () => {
  seedSeries();
  await refresher.refresh();
  await tools.cancelEvent(
    { calendar: principal, event: 'dailyplan_20261007T160000Z', scope: 'following', send_updates: 'none' },
    main,
    'following-cancel',
  );
  await refreshSeries('following-cancel');
  expect(eventLines().map((event) => event.date)).toEqual(['2026-10-05', '2026-10-06']);
});
