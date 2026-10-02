import { describe, expect, it } from 'bun:test';

import { scheduleStats, type ScheduleStatsResult } from './schedule-stats.js';

const ZONE = 'Africa/Lagos';
const PRINCIPAL = 'principal@example.test';
const COLLEAGUE = 'colleague@example.test';
/** Mon 10 Aug 2026 to Sun 4 Oct 2026: eight of every weekday. */
const WINDOW = { from: '2026-08-10', to: '2026-10-04' };

interface EventArg {
  start: string;
  end: string;
  attendee_count: number;
  organizer?: string;
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** An event on `date` in Lagos (UTC+01:00 all year). */
function event(date: string, start: string, end: string, attendees: number, organizer = COLLEAGUE): EventArg {
  return { start: `${date}T${start}:00+01:00`, end: `${date}T${end}:00+01:00`, attendee_count: attendees, organizer };
}

/**
 * Eight weeks of a principal's calendar. Mondays run 09:00-17:00 with one
 * early 07:00 start; Wednesdays have meetings in seven of the eight weeks;
 * Saturdays hold only a block with no guests; Sundays are empty.
 */
function eightWeeks(): EventArg[] {
  const events: EventArg[] = [];
  for (let week = 0; week < 8; week++) {
    const day = (weekday: number) => addDays(WINDOW.from, week * 7 + weekday);
    events.push(
      event(day(0), '09:00', '09:30', 2, PRINCIPAL),
      event(day(0), '09:45', '10:45', 5),
      event(day(0), '16:30', '17:00', 2, PRINCIPAL),
      event(day(1), '10:00', '10:30', 2, PRINCIPAL),
      event(day(1), '10:30', '11:00', 2),
      event(day(1), '14:00', '15:00', 4),
      event(day(3), '09:30', '10:15', 3),
      event(day(3), '12:00', '12:30', 2, PRINCIPAL),
      event(day(3), '15:00', '16:00', 5),
      event(day(4), '10:00', '10:30', 2, PRINCIPAL),
      event(day(5), '07:00', '08:00', 0, PRINCIPAL),
    );
    if (week < 7) events.push(event(day(2), '09:00', '10:00', 6), event(day(2), '10:15', '10:40', 2, PRINCIPAL));
  }
  events.push(event(addDays(WINDOW.from, 21), '07:00', '07:30', 2, PRINCIPAL));
  return events;
}

async function call(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await scheduleStats.handler(args);
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('schedule_stats returned no text');
  return { isError: result.isError === true, text: block.text };
}

async function stats(args: Record<string, unknown>): Promise<ScheduleStatsResult> {
  const outcome = await call({ timezone: ZONE, ...WINDOW, ...args });
  if (outcome.isError) throw new Error(`schedule_stats failed: ${outcome.text}`);
  return JSON.parse(outcome.text) as ScheduleStatsResult;
}

async function refusal(args: Record<string, unknown>): Promise<string> {
  const outcome = await call({ timezone: ZONE, ...WINDOW, events: [], ...args });
  expect(outcome.isError).toBe(true);
  return outcome.text;
}

const NO_MEETINGS = {
  days_with_meetings: 0,
  usual_start: null,
  usual_end: null,
  earliest_start: null,
  latest_end: null,
};

describe('schedule_stats over eight weeks', () => {
  it('returns the usual start and end of the working day for each weekday', async () => {
    const result = await stats({ events: eightWeeks() });
    expect(result.window).toEqual({ ...WINDOW, days: 56 });
    expect(result.working_hours).toEqual({
      mon: {
        days_in_window: 8,
        days_with_meetings: 8,
        usual_start: '09:00',
        usual_end: '17:00',
        earliest_start: '07:00',
        latest_end: '17:00',
      },
      tue: {
        days_in_window: 8,
        days_with_meetings: 8,
        usual_start: '10:00',
        usual_end: '15:00',
        earliest_start: '10:00',
        latest_end: '15:00',
      },
      wed: {
        days_in_window: 8,
        days_with_meetings: 7,
        usual_start: '09:00',
        usual_end: '10:40',
        earliest_start: '09:00',
        latest_end: '10:40',
      },
      thu: {
        days_in_window: 8,
        days_with_meetings: 8,
        usual_start: '09:30',
        usual_end: '16:00',
        earliest_start: '09:30',
        latest_end: '16:00',
      },
      fri: {
        days_in_window: 8,
        days_with_meetings: 8,
        usual_start: '10:00',
        usual_end: '10:30',
        earliest_start: '10:00',
        latest_end: '10:30',
      },
      sat: { days_in_window: 8, ...NO_MEETINGS },
      sun: { days_in_window: 8, ...NO_MEETINGS },
    });
  });

  it('returns the most common meeting lengths, overall, by size, and for meetings the principal organized', async () => {
    const result = await stats({ events: eightWeeks(), principal_addresses: ['Principal@Example.TEST'] });
    expect(result.meeting_lengths).toEqual({
      all: {
        count: 95,
        most_common: [
          { minutes: 30, count: 49 },
          { minutes: 60, count: 31 },
          { minutes: 45, count: 8 },
        ],
      },
      one_on_one: {
        count: 56,
        most_common: [
          { minutes: 30, count: 49 },
          { minutes: 25, count: 7 },
        ],
      },
      group: {
        count: 39,
        most_common: [
          { minutes: 60, count: 31 },
          { minutes: 45, count: 8 },
        ],
      },
      organized_by_principal: {
        count: 48,
        most_common: [
          { minutes: 30, count: 41 },
          { minutes: 25, count: 7 },
        ],
      },
    });
  });

  it('returns the usual gaps between meetings, setting aside free time of more than an hour', async () => {
    const result = await stats({ events: eightWeeks() });
    expect(result.gaps).toEqual({
      count: 23,
      back_to_back: 8,
      median_minutes: 15,
      most_common: [
        { minutes: 15, count: 15 },
        { minutes: 0, count: 8 },
      ],
      longer_than_an_hour: 33,
      overlapping_meetings: 0,
    });
  });

  it('counts every event in exactly one group', async () => {
    const result = await stats({ events: eightWeeks() });
    expect(result.events).toEqual({
      received: 103,
      meetings: 95,
      solo_blocks: 8,
      all_day: 0,
      zero_length: 0,
      crosses_midnight: 0,
      outside_window: 0,
    });
    expect(result.notes).toEqual([]);
  });

  it('gives the same answer whatever order the events arrive in', async () => {
    const forward = await stats({ events: eightWeeks() });
    expect(await stats({ events: eightWeeks().reverse() })).toEqual(forward);
  });

  it('reports no organizer split when the principal addresses are not given', async () => {
    const result = await stats({ events: eightWeeks() });
    expect(result.meeting_lengths.organized_by_principal).toBeNull();
  });
});

describe('schedule_stats reads times on the principal clocks', () => {
  it('keeps a 9am meeting at 09:00 across a clock change, whatever offset the event carries', async () => {
    // New York leaves daylight time on Sun 1 Nov 2026.
    const result = await stats({
      timezone: 'America/New_York',
      from: '2026-10-26',
      to: '2026-11-08',
      events: [
        { start: '2026-10-26T09:00:00-04:00', end: '2026-10-26T09:30:00-04:00', attendee_count: 2 },
        { start: '2026-11-02T14:00:00Z', end: '2026-11-02T14:30:00Z', attendee_count: 2 },
      ],
    });
    expect(result.working_hours.mon).toEqual({
      days_in_window: 2,
      days_with_meetings: 2,
      usual_start: '09:00',
      usual_end: '09:30',
      earliest_start: '09:00',
      latest_end: '09:30',
    });
    expect(result.meeting_lengths.all.most_common).toEqual([{ minutes: 30, count: 2 }]);
  });

  it('files an event under its local date, not its UTC date', async () => {
    // 23:30 UTC on Sunday 4 October is 00:30 on Monday 5 October in Lagos, after the window.
    const result = await stats({
      events: [{ start: '2026-10-04T23:30:00Z', end: '2026-10-05T00:00:00Z', attendee_count: 2 }],
    });
    expect(result.events.outside_window).toBe(1);
    expect(result.events.meetings).toBe(0);
  });

  it('takes the earlier middle start and the later middle end when the days split evenly', async () => {
    const mondays = [0, 7, 14, 21].map((offset) => addDays(WINDOW.from, offset));
    const result = await stats({
      events: [
        event(mondays[0], '08:00', '15:00', 2),
        event(mondays[1], '09:00', '16:00', 2),
        event(mondays[2], '10:00', '17:00', 2),
        event(mondays[3], '11:00', '18:00', 2),
      ],
    });
    expect(result.working_hours.mon.usual_start).toBe('09:00');
    expect(result.working_hours.mon.usual_end).toBe('17:00');
  });
});

describe('schedule_stats sets aside what is not a meeting', () => {
  it('answers empty input with counts of zero and no values', async () => {
    const result = await stats({ events: [] });
    expect(result.events.received).toBe(0);
    expect(result.working_hours.mon).toEqual({ days_in_window: 8, ...NO_MEETINGS });
    expect(result.meeting_lengths.all).toEqual({ count: 0, most_common: [] });
    expect(result.gaps).toEqual({
      count: 0,
      back_to_back: 0,
      median_minutes: null,
      most_common: [],
      longer_than_an_hour: 0,
      overlapping_meetings: 0,
    });
    expect(result.notes).toEqual([
      'No meetings with other people in this window, so there is nothing to learn from it.',
    ]);
  });

  it('counts all-day events without using them', async () => {
    const result = await stats({
      events: [
        { start: '2026-08-10', end: '2026-08-11', attendee_count: 0 },
        { start: '2026-08-11', end: '2026-08-14', attendee_count: 12, organizer: COLLEAGUE },
        event('2026-08-10', '11:00', '11:30', 2),
      ],
    });
    expect(result.events).toEqual(expect.objectContaining({ received: 3, all_day: 2, meetings: 1 }));
    expect(result.working_hours.mon.usual_start).toBe('11:00');
    expect(result.working_hours.tue.days_with_meetings).toBe(0);
  });

  it('counts blocks with no other attendee, zero-length events, and events crossing midnight without using them', async () => {
    const result = await stats({
      events: [
        event('2026-08-10', '07:00', '08:00', 0),
        event('2026-08-10', '06:00', '06:30', 1),
        event('2026-08-10', '12:00', '12:00', 3),
        { start: '2026-08-10T23:00:00+01:00', end: '2026-08-11T00:30:00+01:00', attendee_count: 2 },
        event('2026-08-10', '10:00', '11:00', 2),
      ],
    });
    expect(result.events).toEqual({
      received: 5,
      meetings: 1,
      solo_blocks: 2,
      all_day: 0,
      zero_length: 1,
      crosses_midnight: 1,
      outside_window: 0,
    });
    expect(result.working_hours.mon.usual_start).toBe('10:00');
    expect(result.working_hours.mon.usual_end).toBe('11:00');
  });

  it('keeps a meeting that ends exactly at midnight, ending at 24:00', async () => {
    const result = await stats({
      events: [{ start: '2026-08-10T23:00:00+01:00', end: '2026-08-11T00:00:00+01:00', attendee_count: 2 }],
    });
    expect(result.events.meetings).toBe(1);
    expect(result.working_hours.mon.usual_end).toBe('24:00');
    expect(result.meeting_lengths.all.most_common).toEqual([{ minutes: 60, count: 1 }]);
  });

  it('merges overlapping meetings for gaps, and still counts each one for lengths and hours', async () => {
    const result = await stats({
      events: [
        event('2026-08-10', '09:00', '12:00', 4),
        event('2026-08-10', '10:00', '10:30', 2),
        event('2026-08-10', '11:30', '12:30', 3),
        event('2026-08-10', '12:30', '13:00', 2),
        event('2026-08-10', '13:15', '13:45', 2),
      ],
    });
    // One block 09:00-12:30, then 0 minutes to 12:30, then 15 minutes to 13:15; never a negative gap.
    expect(result.gaps).toEqual({
      count: 2,
      back_to_back: 1,
      median_minutes: 0,
      most_common: [
        { minutes: 0, count: 1 },
        { minutes: 15, count: 1 },
      ],
      longer_than_an_hour: 0,
      overlapping_meetings: 3,
    });
    expect(result.meeting_lengths.all.count).toBe(5);
    expect(result.working_hours.mon.usual_start).toBe('09:00');
    expect(result.working_hours.mon.usual_end).toBe('13:45');
  });
});

describe('schedule_stats refuses what it cannot count exactly', () => {
  it('refuses a window over 60 days and names the limit', async () => {
    expect(await refusal({ from: '2026-08-01', to: '2026-10-14' })).toBe(
      'Error: The window covers 75 days; the limit is 60 days (about eight weeks). Use a shorter window.',
    );
    const sixty = await stats({ from: '2026-08-01', to: '2026-09-29', events: [] });
    expect(sixty.window.days).toBe(60);
  });

  it('refuses a window that is backwards or not made of dates', async () => {
    expect(await refusal({ from: '2026-10-04', to: '2026-08-10' })).toBe('Error: "to" must be on or after "from".');
    expect(await refusal({ from: 'eight weeks ago' })).toBe(
      'Error: from must be a date written as YYYY-MM-DD, such as 2026-08-10.',
    );
    expect(await refusal({ to: '2026-02-30' })).toBe(
      'Error: to must be a date written as YYYY-MM-DD, such as 2026-08-10.',
    );
  });

  it('refuses a missing or unknown timezone', async () => {
    expect(await refusal({ timezone: 'Lagos' })).toBe(
      'Error: Invalid timezone "Lagos". Use an IANA name like "Africa/Lagos".',
    );
    expect(await refusal({ timezone: undefined })).toBe('Error: timezone is required.');
  });

  it('refuses the whole call when any timestamp is invalid, naming each bad event', async () => {
    const good = event('2026-08-10', '09:00', '09:30', 2);
    const text = await refusal({
      events: [
        good,
        { ...good, start: '2026-08-10T09:00:00' },
        { ...good, end: 'half past nine' },
        { ...good, start: '2026-08-10T25:00:00+01:00' },
        { ...good, end: '2026-08-10T08:00:00+01:00' },
        { ...good, start: '2026-08-10' },
        { start: '2026-08-12', end: '2026-08-11', attendee_count: 0 },
      ],
    });
    expect(text).toBe(
      'Error: Invalid events: 6 of 7, so nothing was counted. ' +
        'events[1].start must be a date-time with its UTC offset, such as 2026-10-05T09:00:00+01:00, or a date (2026-10-05) for an all-day event. ' +
        'events[2].end must be a date-time with its UTC offset, such as 2026-10-05T09:00:00+01:00, or a date (2026-10-05) for an all-day event. ' +
        'events[3].start must be a date-time with its UTC offset, such as 2026-10-05T09:00:00+01:00, or a date (2026-10-05) for an all-day event. ' +
        'events[4] ends before it starts. ' +
        'events[5] mixes a date and a date-time; an all-day event gives both as dates. ' +
        '1 more invalid event is not listed.',
    );
  });

  it('refuses events that are not shaped as events', async () => {
    const good = event('2026-08-10', '09:00', '09:30', 2);
    expect(await refusal({ events: 'all of them' })).toBe('Error: events must be a list of events.');
    for (const [bad, message] of [
      [null, 'events[0] must be an object with start, end, and attendee_count.'],
      [{ ...good, attendee_count: -1 }, 'events[0].attendee_count must be a whole number, 0 or more.'],
      [{ ...good, attendee_count: 1.5 }, 'events[0].attendee_count must be a whole number, 0 or more.'],
      [{ ...good, attendee_count: '2' }, 'events[0].attendee_count must be a whole number, 0 or more.'],
      [{ ...good, organizer: 7 }, 'events[0].organizer must be an email address.'],
    ] as const) {
      expect(await refusal({ events: [bad] })).toBe(
        `Error: Invalid events: 1 of 1, so nothing was counted. ${message}`,
      );
    }
    expect(await refusal({ principal_addresses: 'principal@example.test' })).toBe(
      'Error: principal_addresses must be a list of email addresses.',
    );
  });

  it('refuses more than 2000 events and names the limit', async () => {
    const events = Array.from({ length: 2001 }, () => event('2026-08-10', '09:00', '09:30', 2));
    expect(await refusal({ events })).toBe('Error: Too many events: 2001. The limit is 2000; use a shorter window.');
  });
});
