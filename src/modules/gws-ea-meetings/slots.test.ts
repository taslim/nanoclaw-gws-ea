/**
 * The host's slot arithmetic (R4, R5, R13, KTD11): wall-clock times across
 * clock changes, which events block time, and which candidate start times a
 * meeting's level, window and the principal's preferences allow.
 */
import { describe, expect, it } from 'vitest';

import type { Weekday } from '../gws-ea-preferences/db.js';
import type { CalendarEvent } from './calendar-api.js';
import {
  bestSlots,
  blocksTime,
  eventSpan,
  isOpen,
  openSlots,
  schedulingRules,
  slotIdFor,
  workingDaysLater,
  zonedInstant,
  type SchedulingRules,
  type SlotQuery,
  type Span,
} from './slots.js';

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';
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

const WEEKDAY_RULES: SchedulingRules = schedulingRules(
  {
    working_hours: workingDays('09:00', '17:00'),
    protected_windows: [],
    meeting_lengths: [],
    buffers: [],
    preferred_times: [],
  },
  null,
);

function query(overrides: Partial<SlotQuery> & Pick<SlotQuery, 'window'>): SlotQuery {
  return {
    timezone: LONDON,
    level: 'known',
    lengthMinutes: 30,
    earliest: overrides.window.start,
    busy: [],
    rules: WEEKDAY_RULES,
    ...overrides,
  };
}

/** Monday 5 October 2026 to the end of Sunday 11 October, London (BST, UTC+1). */
const WEEK = span('2026-10-04T23:00:00Z', '2026-10-11T23:00:00Z');
/** Monday 5 October, 09:00 in London. */
const MONDAY_NINE = at('2026-10-05T08:00:00Z');

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
});

describe('slots across a daylight-saving change', () => {
  it('offer the same local working hours on both sides of the change', () => {
    const open = openSlots(query({ window: span('2026-10-22T23:00:00Z', '2026-10-27T00:00:00Z'), lengthMinutes: 60 }));
    const friday = open.filter((slot) => weekday(slot.start) === 'Fri');
    const monday = open.filter((slot) => weekday(slot.start) === 'Mon');
    expect(iso(friday[0].start)).toBe('2026-10-23T08:00:00.000Z');
    expect(iso(friday.at(-1)?.end ?? 0)).toBe('2026-10-23T16:00:00.000Z');
    expect(iso(monday[0].start)).toBe('2026-10-26T09:00:00.000Z');
    expect(iso(monday.at(-1)?.end ?? 0)).toBe('2026-10-26T17:00:00.000Z');
    expect(open.some((slot) => ['Sat', 'Sun'].includes(weekday(slot.start)))).toBe(false);
  });

  it('measure a slot that spans the change in real time, on a day 25 hours long', () => {
    const allSunday = schedulingRules(
      {
        working_hours: workingDays('00:00', '24:00', ['sun']),
        protected_windows: [],
        meeting_lengths: [],
        buffers: [],
        preferred_times: [],
      },
      null,
    );
    const open = openSlots(
      query({
        window: span('2026-10-24T23:00:00Z', '2026-10-26T00:00:00Z'),
        lengthMinutes: 180,
        rules: allSunday,
      }),
    );
    expect({ start: iso(open[0].start), end: iso(open[0].end) }).toEqual({
      start: '2026-10-24T23:00:00.000Z',
      end: '2026-10-25T02:00:00.000Z',
    });
    expect(iso(open.at(-1)?.start ?? 0)).toBe('2026-10-25T21:00:00.000Z');
    expect(open).toHaveLength(45);
    for (const slot of open) expect(slot.end - slot.start).toBe(3 * HOUR);
  });
});

describe("a meeting's level", () => {
  it('keeps known, active and unknown counterparts to working hours', () => {
    for (const level of ['known', 'active', 'unknown'] as const) {
      const open = openSlots(query({ window: WEEK, level }));
      expect(open.length).toBeGreaterThan(0);
      for (const slot of open) {
        expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(weekday(slot.start));
        expect(clock(slot.start) >= '09:00' && clock(slot.end) <= '17:00').toBe(true);
      }
    }
  });

  it('lets the inner circle and close use evenings and weekends, but never the night', () => {
    for (const level of ['inner-circle', 'close'] as const) {
      const open = openSlots(query({ window: WEEK, level }));
      expect(open.some((slot) => weekday(slot.start) === 'Sat')).toBe(true);
      expect(open.some((slot) => clock(slot.start) === '19:00')).toBe(true);
      for (const slot of open) {
        expect(clock(slot.start) >= '07:00').toBe(true);
        expect(clock(slot.end) <= '22:00' && clock(slot.end) !== '00:00').toBe(true);
      }
    }
  });

  it("keeps the principal's protected time free for everyone, the closest included", () => {
    const rules = schedulingRules(
      {
        working_hours: workingDays('09:00', '17:00'),
        protected_windows: [{ ...PROVENANCE, id: 'pw-1', weekdays: ['tue'], start: '12:00', end: '13:00' }],
        meeting_lengths: [],
        buffers: [],
        preferred_times: [],
      },
      null,
    );
    for (const level of ['inner-circle', 'known'] as const) {
      const tuesday = openSlots(query({ window: WEEK, level, rules })).filter((slot) => weekday(slot.start) === 'Tue');
      const starts = tuesday.map((slot) => clock(slot.start));
      expect(starts).not.toContain('12:00');
      expect(starts).not.toContain('12:30');
      expect(starts).toContain('11:30');
      expect(starts).toContain('13:00');
    }
  });

  it('keeps the buffer for the meeting’s kind around busy time, falling back to the default', () => {
    const values = {
      working_hours: workingDays('09:00', '17:00'),
      protected_windows: [],
      meeting_lengths: [],
      buffers: [
        { ...PROVENANCE, meeting_kind: 'default', minutes: 15 },
        { ...PROVENANCE, meeting_kind: 'external', minutes: 45 },
      ],
      preferred_times: [],
    };
    const busy = [span('2026-10-07T09:00:00Z', '2026-10-07T10:00:00Z')]; // Wednesday 10:00-11:00
    const wednesday = (kind: string | null) =>
      openSlots(query({ window: WEEK, busy, rules: schedulingRules(values, kind) }))
        .filter((slot) => weekday(slot.start) === 'Wed')
        .map((slot) => clock(slot.start));
    expect(wednesday(null)).not.toContain('09:30');
    expect(wednesday(null)).not.toContain('11:00');
    expect(wednesday(null)).toContain('09:00');
    expect(wednesday(null)).toContain('11:30');
    expect(wednesday('external')).not.toContain('09:00');
    expect(wednesday('external')).not.toContain('11:30');
    expect(wednesday('external')).toContain('12:00');
    expect(wednesday('one-on-one')).toEqual(wednesday(null));
  });

  it('refuses a start outside the window, too soon, or not open', () => {
    const q = query({
      window: WEEK,
      earliest: MONDAY_NINE + HOUR,
      busy: [span('2026-10-06T09:00:00Z', '2026-10-06T10:00:00Z')],
    });
    expect(isOpen(at('2026-10-05T08:30:00Z'), q)).toBe(false); // Monday 09:30: too soon
    expect(isOpen(at('2026-10-05T09:15:00Z'), q)).toBe(true); // Monday 10:15: open, off the half-hour grid
    expect(isOpen(at('2026-10-06T09:30:00Z'), q)).toBe(false); // Tuesday 10:30: busy
    expect(isOpen(at('2026-10-10T10:00:00Z'), q)).toBe(false); // Saturday: outside working hours
    expect(isOpen(at('2026-10-12T09:00:00Z'), q)).toBe(false); // the Monday after: outside the window
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

describe('choosing which times to offer', () => {
  const now = MONDAY_NINE;
  const earliest = now + HOUR;

  it('prefers the next two working days for an active counterpart, from the next one once the day is over', () => {
    const twoWeeks = span('2026-10-04T23:00:00Z', '2026-10-18T23:00:00Z');
    for (const [from, horizon] of [
      // Monday 09:00: Monday and Tuesday, to Tuesday 17:00.
      [MONDAY_NINE, '2026-10-06T16:00:00Z'],
      // Friday 18:00: Friday is over, so Monday and Tuesday, to Tuesday 17:00.
      [at('2026-10-09T17:00:00Z'), '2026-10-13T16:00:00Z'],
    ] as const) {
      const q = query({ window: twoWeeks, level: 'active', earliest: from + HOUR });
      const best = bestSlots(q, openSlots(q), 5, from);
      expect(best).toHaveLength(5);
      expect(best.filter((slot) => slot.end <= at(horizon))).toHaveLength(4);
      expect(best.slice(0, 2).map((slot) => weekday(slot.start))).toEqual(['Mon', 'Tue']);
    }
  });

  it('spreads a known or unknown counterpart’s times across the window, with no other preference', () => {
    const preferring = schedulingRules(
      {
        working_hours: workingDays('09:00', '17:00'),
        protected_windows: [],
        meeting_lengths: [],
        buffers: [],
        preferred_times: [{ ...PROVENANCE, meeting_kind: 'default', weekdays: ['thu'], start: '15:00', end: '16:00' }],
      },
      null,
    );
    for (const level of ['known', 'unknown'] as const) {
      const q = query({ window: WEEK, level, earliest, rules: preferring });
      const best = bestSlots(q, openSlots(q), 5, now);
      expect(best.map((slot) => weekday(slot.start))).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
      expect(clock(best[0].start)).toBe('10:00');
      expect(clock(best[3].start)).toBe('09:00');
    }
  });

  it("puts the principal's preferred times for the meeting's kind first for someone close", () => {
    const values = {
      working_hours: workingDays('09:00', '17:00'),
      protected_windows: [],
      meeting_lengths: [],
      buffers: [],
      preferred_times: [
        { ...PROVENANCE, meeting_kind: 'default', weekdays: ['thu'] as const, start: '15:00', end: '16:00' },
        { ...PROVENANCE, meeting_kind: 'coffee', weekdays: ['sat'] as const, start: '08:00', end: '09:00' },
      ],
    };
    const close = (kind: string | null) => {
      const q = query({ window: WEEK, level: 'close', earliest, rules: schedulingRules(values, kind) });
      return bestSlots(q, openSlots(q), 5, now);
    };
    expect([weekday(close(null)[0].start), clock(close(null)[0].start)]).toEqual(['Thu', '15:00']);
    expect([weekday(close('coffee')[0].start), clock(close('coffee')[0].start)]).toEqual(['Sat', '08:00']);
  });

  it('never offers overlapping times, and caps the list', () => {
    const q = query({ window: span('2026-10-05T08:00:00Z', '2026-10-05T16:00:00Z'), lengthMinutes: 60, earliest });
    const best = bestSlots(q, openSlots(q), 3, now);
    expect(best).toHaveLength(3);
    const sorted = [...best].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
  });

  it('gives each time a stable, opaque id per meeting', () => {
    const slot = span('2026-10-06T13:00:00Z', '2026-10-06T13:30:00Z');
    expect(slotIdFor('mtg-a', slot)).toBe(slotIdFor('mtg-a', slot));
    expect(slotIdFor('mtg-a', slot)).not.toBe(slotIdFor('mtg-b', slot));
    expect(slotIdFor('mtg-a', slot)).toMatch(/^slot-[0-9a-f]{12}$/);
  });
});

describe('working days', () => {
  it('assume Monday to Friday, 09:00 to 17:00, until the principal has working hours', () => {
    const none = schedulingRules(
      { working_hours: [], protected_windows: [], meeting_lengths: [], buffers: [], preferred_times: [] },
      null,
    );
    expect(openSlots(query({ window: WEEK, rules: none }))).toEqual(openSlots(query({ window: WEEK })));
  });
});

describe('working days later (follow-through deadlines)', () => {
  const later = (from: string, count: number, rules = WEEKDAY_RULES, timezone = LONDON) =>
    iso(workingDaysLater(at(from), count, rules, timezone));

  it('land at the same time of day the given number of working days on, skipping the weekend', () => {
    // Monday 11:30 in London.
    expect(later('2026-10-05T10:30:00Z', 2)).toBe('2026-10-07T10:30:00.000Z');
    // Thursday 15:00 to Monday 15:00, past the weekend.
    expect(later('2026-10-08T14:00:00Z', 2)).toBe('2026-10-12T14:00:00.000Z');
  });

  it('count from the start of the working day when it begins outside working hours', () => {
    // Monday 08:00: from Monday 09:00.
    expect(later('2026-10-05T07:00:00Z', 2)).toBe('2026-10-07T08:00:00.000Z');
    // Friday 18:00 and Saturday noon: from Monday 09:00.
    expect(later('2026-10-09T17:00:00Z', 2)).toBe('2026-10-14T08:00:00.000Z');
    expect(later('2026-10-10T11:00:00Z', 2)).toBe('2026-10-14T08:00:00.000Z');
  });

  it("follow the principal's own days and hours on their clock, across a clock change", () => {
    const shortWeek = schedulingRules(
      {
        working_hours: [
          ...workingDays('10:00', '16:00', ['mon', 'tue', 'wed', 'thu']),
          { ...PROVENANCE, weekday: 'fri', off: true as const },
        ],
        protected_windows: [],
        meeting_lengths: [],
        buffers: [],
        preferred_times: [],
      },
      null,
    );
    // Thursday 17:00 in New York: Friday is off, so from Monday 10:00 to Wednesday 10:00.
    expect(later('2026-10-08T21:00:00Z', 2, shortWeek, NEW_YORK)).toBe('2026-10-14T14:00:00.000Z');
    // Wednesday 15:30 in New York, a day before the clocks go back: to Monday 15:30, now on standard time.
    expect(later('2026-10-28T19:30:00Z', 2, shortWeek, NEW_YORK)).toBe('2026-11-02T20:30:00.000Z');
  });

  it('end at the close of a shorter day rather than past it', () => {
    const shortFriday = schedulingRules(
      {
        working_hours: [
          ...workingDays('09:00', '17:00', ['mon', 'tue', 'wed', 'thu']),
          ...workingDays('09:00', '13:00', ['fri']),
        ],
        protected_windows: [],
        meeting_lengths: [],
        buffers: [],
        preferred_times: [],
      },
      null,
    );
    // Wednesday 16:00 to Friday, which ends at 13:00.
    expect(later('2026-10-07T15:00:00Z', 2, shortFriday)).toBe('2026-10-09T12:00:00.000Z');
  });

  it('assume Monday to Friday, 09:00 to 17:00, when the principal works no day at all', () => {
    const never = schedulingRules(
      {
        working_hours: (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((weekday) => ({
          ...PROVENANCE,
          weekday,
          off: true as const,
        })),
        protected_windows: [],
        meeting_lengths: [],
        buffers: [],
        preferred_times: [],
      },
      null,
    );
    expect(later('2026-10-05T07:00:00Z', 2, never)).toBe('2026-10-07T08:00:00.000Z');
  });
});
