/**
 * The host's free-time arithmetic (KTD7; R69): wall-clock times across clock
 * changes, which events block time, and the free windows free time lists
 * from the principal's preferences and both sides' waking days, each with the
 * fit every meeting inside it meets.
 */
import { describe, expect, it } from 'vitest';

import type { Weekday } from '../gws-ea-preferences/db.js';
import type { CalendarEvent } from './calendar-api.js';
import {
  blocksTime,
  eventSpan,
  fitOf,
  freeWindows,
  inProtectedTime,
  schedulingRules,
  zonedInstant,
  zonedIso,
  type FreeTimeQuery,
  type FreeWindow,
  type SchedulingRules,
  type Span,
} from './slots.js';

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
const LOS_ANGELES = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';
const PRINCIPAL = new Set(['pat@principal.example']);

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

/** Each window as "Tue 09:00–17:00 acceptable", on `timezone`'s clock. */
function shown(windows: readonly FreeWindow[], timezone = LONDON): string[] {
  return windows.map(
    (free) =>
      `${weekday(free.start, timezone)} ${clock(free.start, timezone)}–${clock(free.end, timezone)} ${free.fit}`,
  );
}

function on(day: string, windows: readonly FreeWindow[], timezone = LONDON): string[] {
  return shown(windows, timezone).filter((line) => line.startsWith(`${day} `));
}

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
  it("lists the principal's waking day on the same local hours on both sides of a clock change, split where the fit changes", () => {
    const windows = freeWindows(query({ window: span('2026-10-22T23:00:00Z', '2026-10-27T00:00:00Z') }));
    expect(on('Fri', windows)).toEqual([
      'Fri 07:00–09:00 outside usual hours',
      'Fri 09:00–17:00 acceptable',
      'Fri 17:00–22:00 outside usual hours',
    ]);
    // Sunday 25 October is 25 hours long in London; its waking day is still 07:00 to 22:00.
    expect(on('Sun', windows)).toEqual(['Sun 07:00–22:00 outside usual hours']);
    expect(on('Mon', windows)).toEqual([
      'Mon 07:00–09:00 outside usual hours',
      'Mon 09:00–17:00 acceptable',
      'Mon 17:00–22:00 outside usual hours',
    ]);
  });

  it('widens the waking day by working hours that reach past it, and never lists the night', () => {
    const late = schedulingRules({ ...NONE, working_hours: workingDays('06:00', '23:00', ['tue']) });
    const tuesday = freeWindows(query({ window: span('2026-10-05T23:00:00Z', '2026-10-06T23:00:00Z'), rules: late }));
    expect(shown(tuesday)).toEqual(['Tue 06:00–23:00 acceptable']);
  });

  it("keeps the principal's protected time out of every window, and finds a proposed time inside it", () => {
    const rules = schedulingRules({
      ...NONE,
      working_hours: workingDays('09:00', '17:00'),
      protected_windows: [{ ...PROVENANCE, id: 'pw-1', weekdays: ['tue'], start: '12:00', end: '13:00' }],
    });
    expect(on('Tue', freeWindows(query({ window: WEEK, rules })))).toEqual([
      'Tue 07:00–09:00 outside usual hours',
      'Tue 09:00–12:00 acceptable',
      'Tue 13:00–17:00 acceptable',
      'Tue 17:00–22:00 outside usual hours',
    ]);
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
    expect(on('Wed', freeWindows(query({ window: WEEK, busy, rules })))).toEqual([
      'Wed 07:00–09:00 outside usual hours',
      'Wed 09:00–09:45 acceptable',
      'Wed 11:15–17:00 acceptable',
      'Wed 17:00–22:00 outside usual hours',
    ]);
  });

  it('puts window edges on the quarter hour, and lists no window too short for the meeting', () => {
    const busy = [
      span('2026-10-06T08:00:00Z', '2026-10-06T09:40:00Z'), // Tuesday 09:00-10:40
      span('2026-10-06T10:10:00Z', '2026-10-06T10:30:00Z'), // 11:10-11:30: only 25 minutes free before it
      span('2026-10-06T13:10:00Z', '2026-10-06T16:00:00Z'), // 14:10-17:00
    ];
    const windows = freeWindows(
      query({ window: span('2026-10-06T08:00:00Z', '2026-10-06T16:00:00Z'), busy, lengthMinutes: 30 }),
    );
    expect(shown(windows)).toEqual(['Tue 11:30–14:00 acceptable']);
  });

  it('notes the fit every meeting in a window meets, from a fixed vocabulary, listing windows in date order', () => {
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

    const windows = freeWindows(query({ window: span('2026-10-07T23:00:00Z', '2026-10-10T23:00:00Z'), rules }));
    expect(on('Thu', windows)).toEqual([
      'Thu 07:00–09:00 outside usual hours',
      'Thu 09:00–15:00 acceptable',
      'Thu 15:00–16:00 preferred',
      'Thu 16:00–17:00 acceptable',
      'Thu 17:00–22:00 outside usual hours',
    ]);
    expect(on('Sat', windows)).toEqual(['Sat 07:00–22:00 outside usual hours']);
    expect(windows.map((free) => free.start)).toEqual([...windows.map((free) => free.start)].sort((a, b) => a - b));
    for (const free of windows) expect(fitOf(free, rules, LONDON)).toBe(free.fit);
  });

  it('never claims a better fit than a meeting inside the window gets: a preferred time too short to hold one joins its neighbour', () => {
    const rules = schedulingRules({
      ...NONE,
      working_hours: workingDays('09:00', '17:00'),
      preferred_times: [
        { ...PROVENANCE, meeting_kind: 'default', weekdays: ['tue'], start: '10:00', end: '10:20' },
        // A preferred time past the end of the working day, too short for an hour.
        { ...PROVENANCE, meeting_kind: 'default', weekdays: ['tue'], start: '17:00', end: '17:20' },
      ],
    });
    const tuesday = on('Tue', freeWindows(query({ window: WEEK, rules, lengthMinutes: 60 })));
    expect(tuesday).toEqual([
      'Tue 07:00–09:00 outside usual hours',
      'Tue 09:00–17:00 acceptable',
      'Tue 17:00–22:00 outside usual hours',
    ]);
  });

  it("lists only time inside the counterpart's waking day too: for a Pacific principal and Berlin, the shared mornings", () => {
    // Berlin is nine hours ahead of Los Angeles in early October: 07:00 to 13:00 in Los Angeles is 16:00 to 22:00 in Berlin.
    const tuesday = span('2026-10-06T07:00:00Z', '2026-10-07T07:00:00Z');
    const both = freeWindows(query({ timezone: LOS_ANGELES, counterpartTimezone: BERLIN, window: tuesday }));
    expect(shown(both, LOS_ANGELES)).toEqual(['Tue 07:00–09:00 outside usual hours', 'Tue 09:00–13:00 acceptable']);
    expect(shown(both, BERLIN)).toEqual(['Tue 16:00–18:00 outside usual hours', 'Tue 18:00–22:00 acceptable']);
  });

  it('lists only the part of a day inside the range', () => {
    expect(shown(freeWindows(query({ window: span('2026-10-06T08:00:00Z', '2026-10-06T09:00:00Z') })))).toEqual([
      'Tue 09:00–10:00 acceptable',
    ]);
  });

  it('counts Monday to Friday, 09:00 to 17:00, as working hours until the principal has some', () => {
    const none = schedulingRules({ ...NONE, working_hours: [] });
    expect(freeWindows(query({ window: WEEK, rules: none }))).toEqual(freeWindows(query({ window: WEEK })));
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

  it("reads the principal's answer from the calendar's own entry first, then from any spelling of their addresses", () => {
    const work = new Set(['pat@principal.example', 'pat.lee@gmail.com']);
    // Accepted on this calendar, declined from another address: this calendar's own answer stands.
    expect(
      blocksTime(
        event({
          attendees: [
            { email: 'pat@principal.example', self: true, responseStatus: 'accepted' },
            { email: 'pat.lee@gmail.com', responseStatus: 'declined' },
          ],
        }),
        work,
      ),
    ).toBe(true);
    expect(
      blocksTime(event({ attendees: [{ email: 'team@example.com', self: true, responseStatus: 'declined' }] }), work),
    ).toBe(false);
    // Gmail delivers Pat.Lee+cal@googlemail.com to the same mailbox.
    expect(
      blocksTime(event({ attendees: [{ email: 'pat.lee+cal@googlemail.com', responseStatus: 'declined' }] }), work),
    ).toBe(false);
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
