import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/booking-week-refresh-${process.pid}`);
vi.mock('../../../config.js', async (original) => ({
  ...(await original<typeof import('../../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import '../../gws-ea-manual/index.js';
import { ANSWER_LATER } from '../../../cli/delivery-action.js';
import { sessionDir } from '../../../session-manager.js';
import type { Session } from '../../../types.js';
import { consumeOwnCalendarChange } from '../../gws-ea-inbox/calendar-notifications.js';
import { createBookingTools } from '../booking.js';
import { getBookingRequest } from '../bookings-db.js';
import {
  answerData,
  BOOK,
  cleanBookingFixture,
  LATER,
  mainSession,
  seedBookingFixture,
  TEAM,
  type BookingFixture,
} from '../testing/booking-fixture.js';
import { settledCalendarChanges } from './pending-changes.js';
import { createWeekRefresher } from './refresh.js';
import type { WeekView } from './view.js';

let fixture: BookingFixture;
let main: Session;
let refresher: ReturnType<typeof createWeekRefresher>;

function readView(): WeekView {
  return JSON.parse(
    fs.readFileSync(path.join(sessionDir(main.agent_group_id, main.id), 'week-view.json'), 'utf8'),
  ) as WeekView;
}
function eventDates(id: string): string[] {
  return readView()
    .days.filter((day) => day.entries.some((entry) => entry.text.includes(id)))
    .map((day) => day.date);
}

beforeEach(async () => {
  fixture = await seedBookingFixture();
  main = await mainSession();
  refresher = createWeekRefresher({ calendar: () => fixture.calendar });
  await refresher.start();
});
afterEach(async () => {
  await refresher.stop();
  await cleanBookingFixture();
});

it('refreshes a primed readable-only view after outward book, move and cancel despite consumed own notices', async () => {
  const { calendar, tools, emailSession } = fixture;
  expect([...calendar.calendars.values()].every((entry) => entry.accessRole !== 'freeBusyReader')).toBe(true);
  const reads = vi.spyOn(calendar, 'listEventDetails');
  const calendarLists = vi.spyOn(calendar, 'listCalendars');
  const id = String(answerData(await tools.book(BOOK, emailSession, 'book-refresh')).booking);
  expect(consumeOwnCalendarChange(TEAM, id, new Date())).toBe(true);
  expect(await settledCalendarChanges(new Date('2100-01-01'))).toEqual([]);
  expect(eventDates(id)).toEqual([]);
  reads.mockClear();
  calendarLists.mockClear();
  await refresher.refresh();
  expect(eventDates(id)).toEqual(['2026-10-20']);
  expect(calendarLists).not.toHaveBeenCalled();
  expect(reads.mock.calls.length).toBeGreaterThan(0);
  expect(reads.mock.calls.every(([, start, end]) => Date.parse(end) - Date.parse(start) <= 86_400_000)).toBe(true);

  answerData(await tools.changeBooking({ booking: id, start: LATER }, emailSession, 'move-refresh'));
  expect(consumeOwnCalendarChange(TEAM, id, new Date())).toBe(true);
  reads.mockClear();
  calendarLists.mockClear();
  await refresher.refresh();
  expect(eventDates(id)).toEqual(['2026-10-21']);
  expect(calendarLists).not.toHaveBeenCalled();
  expect(reads.mock.calls.every(([, start, end]) => Date.parse(end) - Date.parse(start) <= 2 * 86_400_000)).toBe(true);

  answerData(await tools.cancelBooking({ booking: id }, emailSession, 'cancel-refresh'));
  expect(consumeOwnCalendarChange(TEAM, id, new Date())).toBe(true);
  reads.mockClear();
  calendarLists.mockClear();
  await refresher.refresh();
  expect(eventDates(id)).toEqual([]);
  expect(calendarLists).not.toHaveBeenCalled();
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert', 'patch', 'delete']);
  reads.mockClear();
  await refresher.refresh();
  expect(reads).not.toHaveBeenCalled();
});

it('shows a booking after a refresh that failed once', async () => {
  const { calendar, tools, emailSession } = fixture;
  const id = String(answerData(await tools.book(BOOK, emailSession, 'failed-refresh')).booking);
  vi.spyOn(calendar, 'listEventDetails').mockRejectedValueOnce(new Error('Calendar unavailable'));
  await expect(refresher.refresh()).rejects.toThrow('Calendar unavailable');
  expect(eventDates(id)).toEqual([]);
  await refresher.refresh();
  expect(eventDates(id)).toEqual(['2026-10-20']);
});

it('shows a booking completed by lost-response recovery without another Google write', async () => {
  const { calendar, tools, emailSession } = fixture;
  calendar.failNext({ op: 'insert', error: new Error('Insert reply lost'), afterApplying: true });
  expect(await tools.book(BOOK, emailSession, 'lost-refresh')).toBe(ANSWER_LATER);
  const restarted = createBookingTools({ calendar: () => calendar });
  await restarted.resumePending();
  const id = calendar.live(TEAM)[0].id;
  expect(await getBookingRequest(emailSession.id, 'lost-refresh')).toBeUndefined();
  expect(consumeOwnCalendarChange(TEAM, id, new Date())).toBe(true);
  const calendarLists = vi.spyOn(calendar, 'listCalendars');
  await refresher.refresh();
  expect(eventDates(id)).toEqual(['2026-10-20']);
  expect(calendarLists).not.toHaveBeenCalled();
  expect(calendar.writes.map((write) => write.op)).toEqual(['insert']);
});
