/**
 * The host's free-time arithmetic (KTD7; R69): wall-clock times across clock
 * changes, which events block time, and which times free time offers from
 * the principal's preferences and both sides' waking days, spread as a person
 * offers them and listed in date order.
 */
import { describe, expect, it } from 'vitest';

import type { Weekday } from '../gws-ea-preferences/db.js';
import type { CalendarEvent } from './calendar-api.js';
import {
  blocksTime,
  eventSpan,
  fitOf,
  freeTimes,
  inProtectedTime,
  schedulingRules,
  zonedInstant,
  zonedIso,
  type FreeTimeQuery,
  type SchedulingRules,
  type Span,
} from './slots.js';

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
const LOS_ANGELES = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';
const PRINCIPAL = new Set(['pat@principal.example']);
const HOUR = 3_600_000;

function at(iso: string): number {
  return Date.parse(iso);
}

function iso(instant: number): string {
  return new Date(instant).toISOString();
}

function span(start: string, end: string): Span {
  return { start: at(start), end: at(end) };
}

/** Local `HH:MM` of an instant, for reading results back. */
function clock(instant: number, timezone = LONDON): string {
  return new Date(instant).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
}

function weekday(instant: number, timezone = LONDON): string {
  return new Date(instant).toLocaleDateString('en-GB', { timeZone: timezone, weekday: 'short' });
}

const PROVENANCE = { source: 'principal', updated_at: '2026-09-01T00:00:00.000Z' } as const;

function workingDays(start: string, end: string, days: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri']) {
  return days.map((day) => ({ ...PROVENANCE, weekday: day, off: false as const, start, end }));
}

const NONE = { protected_windows: [], meeting_lengths: [], buffers: [], preferred_times: [] };
const WEEKDAY_RULES: SchedulingRules = schedulingRules({ ...NONE, working_hours: workingDays('09:00', '17:00') });

function query(overrides: Partial<FreeTimeQuery> & Pick<FreeTimeQuery, 'window'>): FreeTimeQuery {
  return { timezone: LONDON, lengthMinutes: 30, busy: [], rules: WEEKDAY_RULES, ...overrides };
}

/** Monday 5 October 2026 to the end of Sunday 11 October, London (BST, UTC+1). */
const WEEK = span('2026-10-04T23:00:00Z', '2026-10-11T23:00:00Z');
const EVERY_TIME = 10_000;

describe('wall-clock times', () => {
  it('turn into the right instant on either side of a clock change', () => {
    expect(iso(zonedInstant({ year: 2026, month: 10, day: 23 }, 9 * 60, LONDON))).toBe('2026-10-23T08:00:00.000Z');
    expect(iso(zonedInstant({ year: 2026, month: 10, day: 26 }, 9 * 60, LONDON))).toBe('2026-10-26T09:00:00.000Z');
    // New York springs forward at 02:00 on 8 March: 03:30 that morning is already daylight time.
    expect(iso(zonedInstant({ year: 2026, month: 3, day: 8 }, 3 * 60 + 30, NEW_YORK))).toBe('2026-03-08T07:30:00.000Z');
    expect(iso(zonedInstant({ year: 2026, month: 3, day: 7 }, 3 * 60 + 30, NEW_YORK))).toBe('2026-03-07T08:30:00.000Z');
    expect(iso(zonedInstant({ year: 2026, month: 11, day: 1 }, 3 * 60, NEW_YORK))).toBe('2026-11-01T08:00:00.000Z');
    // A time the clocks skip lands just after the change, never an hour early.
    expect(iso(zonedInstant({ year: 2026, month: 3, day: 29 }, 90, LONDON))).toBe('2026-03-29T01:30:00.000Z');
    // 24:00 ends the day at the next midnight.
    expect(iso(zonedInstant({ year: 2026, month: 10, day: 25 }, 24 * 60, LONDON))).toBe('2026-10-26T00:00:00.000Z');
  });

  it("read as ISO times on the zone's clock with its offset, the hour the clocks repeat told apart", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['2026-10-06T11:00:00.000Z', NEW_YORK, '2026-10-06T07:00-04:00'],
      ['2026-10-06T11:00:00.000Z', LONDON, '2026-10-06T12:00+01:00'],
      ['2026-12-01T11:00:00.000Z', LONDON, '2026-12-01T11:00+00:00'],
      ['2026-10-06T02:00:00.000Z', LOS_ANGELES, '2026-10-05T19:00-07:00'],
      ['2026-10-06T04:00:00.000Z', 'Asia/Kolkata', '2026-10-06T09:30+05:30'],
      ['2026-10-06T12:00:00.000Z', 'America/St_Johns', '2026-10-06T09:30-02:30'],
      // New York's clocks go back at 02:00 on 1 November: 01:30 comes twice, an hour apart.
      ['2026-11-01T05:30:00.000Z', NEW_YORK, '2026-11-01T01:30-04:00'],
      ['2026-11-01T06:30:00.000Z', NEW_YORK, '2026-11-01T01:30-05:00'],
      ['2026-10-06T11:00:30.250Z', NEW_YORK, '2026-10-06T07:00:30.250-04:00'],
    ];
    for (const [instant, timezone, expected] of cases) {
      expect(zonedIso(at(instant), timezone), `${instant} in ${timezone}`).toBe(expected);
      expect(iso(Date.parse(expected))).toBe(instant);
    }
  });
});

describe('free time', () => {
  it("offers from the principal's waking day on the same local hours on both sides of a clock change", () => {
    const times = freeTimes(query({ window: span('2026-10-22T23:00:00Z', '2026-10-27T00:00:00Z') }), EVERY_TIME);
    for (const day of ['Fri', 'Sun', 'Mon']) {
      const onDay = times.filter((time) => weekday(time.start) === day).sort((a, b) => a.start - b.start);
      expect(clock(onDay[0].start), day).toBe('07:00');
      expect(clock(onDay.at(-1)?.end ?? 0), day).toBe('22:00');
    }
    for (const time of times) expect(time.end - time.start).toBe(HOUR / 2);
  });

  it('widens the waking day by working hours that reach past it, and never offers the night', () => {
    const late = schedulingRules({ ...NONE, working_hours: workingDays('06:00', '23:00', ['tue']) });
    const tuesday = freeTimes(
      query({ window: span('2026-10-05T23:00:00Z', '2026-10-06T23:00:00Z'), rules: late }),
      EVERY_TIME,
    ).sort((a, b) => a.start - b.start);
    expect(clock(tuesday[0].start)).toBe('06:00');
    expect(clock(tuesday.at(-1)?.end ?? 0)).toBe('23:00');
  });

  it("keeps the principal's protected time free, and finds a proposed time inside it", () => {
    const rules = schedulingRules({
      ...NONE,
      working_hours: workingDays('09:00', '17:00'),
      protected_windows: [{ ...PROVENANCE, id: 'pw-1', weekdays: ['tue'], start: '12:00', end: '13:00' }],
    });
    const starts = freeTimes(query({ window: WEEK, rules }), EVERY_TIME)
      .filter((time) => weekday(time.start) === 'Tue')
      .map((time) => clock(time.start));
    expect(starts).not.toContain('12:00');
    expect(starts).not.toContain('12:30');
    expect(starts).toContain('11:30');
    expect(starts).toContain('13:00');
    // Tuesday 12:45 to 13:15 London touches the window: a counterpart's proposal never gets round it.
    expect(inProtectedTime(span('2026-10-06T11:45:00Z', '2026-10-06T12:15:00Z'), rules, LONDON)).toBe(true);
    expect(inProtectedTime(span('2026-10-06T12:00:00Z', '2026-10-06T12:30:00Z'), rules, LONDON)).toBe(false);
  });

  it("keeps the principal's default buffer around busy time, and no other kind's", () => {
    const rules = schedulingRules({
      ...NONE,
      working_hours: workingDays('09:00', '17:00'),
      buffers: [
        { ...PROVENANCE, meeting_kind: 'default', minutes: 15 },
        { ...PROVENANCE, meeting_kind: 'external', minutes: 45 },
      ],
    });
    const busy = [span('2026-10-07T09:00:00Z', '2026-10-07T10:00:00Z')]; // Wednesday 10:00-11:00
    const wednesday = freeTimes(query({ window: WEEK, busy, rules }), EVERY_TIME)
      .filter((time) => weekday(time.start) === 'Wed')
      .map((time) => clock(time.start));
    expect(wednesday).not.toContain('09:30');
    expect(wednesday).not.toContain('11:00');
    expect(wednesday).toContain('09:00');
    expect(wednesday).toContain('11:30');
  });

  it('notes how each time fits in a fixed vocabulary, listing the times in date order whatever their fit', () => {
    const rules = schedulingRules({
      ...NONE,
      working_hours: workingDays('09:00', '17:00'),
      preferred_times: [
        { ...PROVENANCE, meeting_kind: 'default', weekdays: ['thu'], start: '15:00', end: '16:00' },
        { ...PROVENANCE, meeting_kind: 'coffee', weekdays: ['sat'], start: '08:00', end: '09:00' },
      ],
    });
    expect(fitOf(span('2026-10-08T14:00:00Z', '2026-10-08T14:30:00Z'), rules, LONDON)).toBe('preferred');
    expect(fitOf(span('2026-10-08T09:00:00Z', '2026-10-08T09:30:00Z'), rules, LONDON)).toBe('acceptable');
    // Only the default kind's preferred times count: no meeting kind reaches free time.
    expect(fitOf(span('2026-10-10T07:00:00Z', '2026-10-10T07:30:00Z'), rules, LONDON)).toBe('outside usual hours');

    // Thursday's preferred 15:00 is the best fit, yet it is listed in its place in the week, not first.
    const offered = freeTimes(query({ window: span('2026-10-07T23:00:00Z', '2026-10-09T23:00:00Z'), rules }), 2);
    expect(offered.map((time) => [weekday(time.start), clock(time.start), time.fit])).toEqual([
      ['Thu', '07:00', 'outside usual hours'],
      ['Fri', '08:00', 'outside usual hours'],
    ]);
  });

  it('offers the earliest time each day at a new hour of the day, then the earliest left, in date order', () => {
    const offered = freeTimes(query({ window: WEEK }), 8);
    expect(offered.map((time) => `${weekday(time.start)} ${clock(time.start)}`)).toEqual([
      'Mon 07:00',
      'Mon 07:30',
      'Tue 08:00',
      'Wed 09:00',
      'Thu 10:00',
      'Fri 11:00',
      'Sat 12:00',
      'Sun 13:00',
    ]);
  });

  it('never offers two times that overlap', () => {
    const offered = freeTimes(
      query({ window: span('2026-10-05T06:00:00Z', '2026-10-05T10:00:00Z'), lengthMinutes: 60 }),
      8,
    );
    expect(offered.map((time) => clock(time.start))).toEqual(['07:00', '08:00', '09:00', '10:00']);
  });

  it("offers only times inside the counterpart's waking day too: for a Pacific principal and Berlin, the shared mornings", () => {
    // Berlin is nine hours ahead of Los Angeles in early October: 07:00 to 13:00 in Los Angeles is 16:00 to 22:00 in Berlin.
    const tuesday = span('2026-10-06T07:00:00Z', '2026-10-07T07:00:00Z');
    const both = freeTimes(
      query({ timezone: LOS_ANGELES, counterpartTimezone: BERLIN, window: tuesday }),
      EVERY_TIME,
    ).sort((a, b) => a.start - b.start);
    const morning = Array.from(
      { length: 12 },
      (_, i) => `${String(7 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`,
    );
    expect(both.map((time) => clock(time.start, LOS_ANGELES))).toEqual(morning);
    expect(both.map((time) => clock(time.end, BERLIN)).at(-1)).toBe('22:00');
  });

  it('offers fewer times when a narrow window holds fewer', () => {
    expect(freeTimes(query({ window: span('2026-10-06T08:00:00Z', '2026-10-06T09:00:00Z') }), 5)).toHaveLength(2);
  });

  it('counts Monday to Friday, 09:00 to 17:00, as working hours until the principal has some', () => {
    const none = schedulingRules({ ...NONE, working_hours: [] });
    expect(freeTimes(query({ window: WEEK, rules: none }), EVERY_TIME)).toEqual(
      freeTimes(query({ window: WEEK }), EVERY_TIME),
    );
  });
});

describe('which events block time', () => {
  function event(overrides: Partial<CalendarEvent>): CalendarEvent {
    return {
      id: 'evt',
      status: 'confirmed',
      start: { dateTime: '2026-10-06T09:00:00Z' },
      end: { dateTime: '2026-10-06T10:00:00Z' },
      ...overrides,
    };
  }

  it('ignores cancelled events, free events, and invitations the principal declined', () => {
    expect(blocksTime(event({}), PRINCIPAL)).toBe(true);
    expect(blocksTime(event({ status: 'cancelled' }), PRINCIPAL)).toBe(false);
    expect(blocksTime(event({ transparency: 'transparent' }), PRINCIPAL)).toBe(false);
    expect(
      blocksTime(event({ attendees: [{ email: 'pat@principal.example', responseStatus: 'declined' }] }), PRINCIPAL),
    ).toBe(false);
    expect(
      blocksTime(event({ attendees: [{ email: 'pat@principal.example', responseStatus: 'needsAction' }] }), PRINCIPAL),
    ).toBe(true);
  });

  it("reads an all-day event as the principal's whole local days, however long the clocks make them", () => {
    const allDay = event({ start: { date: '2026-10-25' }, end: { date: '2026-10-26' } });
    const day = eventSpan(allDay, LONDON);
    expect(day && { start: iso(day.start), end: iso(day.end) }).toEqual({
      start: '2026-10-24T23:00:00.000Z',
      end: '2026-10-26T00:00:00.000Z',
    });
  });
});
