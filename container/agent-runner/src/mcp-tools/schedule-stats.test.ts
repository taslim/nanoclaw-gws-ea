import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { scheduleStats, type ScheduleStatsResult } from './schedule-stats.js';

const ZONE = 'Africa/Lagos';
const PRINCIPAL = 'principal@example.test';
const HOME = 'principal.home@gmail.com';
const COLLEAGUE = 'colleague@example.test';
const ROOM = 'c_1882@resource.calendar.google.com';
/** Mon 10 Aug 2026 to Sun 4 Oct 2026: eight of every weekday. */
const WINDOW = { from: '2026-08-10', to: '2026-10-04' };

interface GogTime {
  date?: string;
  dateTime?: string;
}

interface GogParty {
  email: string;
  self?: boolean;
  organizer?: boolean;
  resource?: boolean;
  responseStatus: string;
}

interface GogEvent {
  id: string;
  iCalUID: string;
  status: string;
  start: GogTime;
  end: GogTime;
  organizer?: { email: string; self?: boolean };
  attendees?: GogParty[];
  attendeesOmitted?: boolean;
}

let root: string;
let counter = 0;
let fileCounter = 0;

beforeAll(() => {
  // The temp directory is one of the two places schedule_stats reads from.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-stats-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * A timed event as gog prints it, with `people` invited in all: the
 * principal's own entry, the organizer's, and guests. An event nobody is
 * invited to has no attendees, the way Google lists a block.
 */
function timed(start: string, end: string, people: number, organizer = COLLEAGUE): GogEvent {
  counter++;
  const byPrincipal = organizer === PRINCIPAL;
  const invited: GogParty[] = [
    { email: PRINCIPAL, self: true, responseStatus: 'accepted' },
    ...(byPrincipal ? [] : [{ email: organizer, organizer: true, responseStatus: 'accepted' }]),
    ...Array.from({ length: people }, (_, index) => ({
      email: `guest${index}@example.test`,
      responseStatus: 'accepted',
    })),
  ];
  return {
    id: `event${counter}`,
    iCalUID: `event${counter}@google.com`,
    status: 'confirmed',
    start: { dateTime: start },
    end: { dateTime: end },
    organizer: byPrincipal ? { email: PRINCIPAL, self: true } : { email: organizer },
    ...(people === 0 ? {} : { attendees: invited.slice(0, people) }),
  };
}

/** An event on `date` in Lagos (UTC+01:00 all year). */
function event(date: string, start: string, end: string, people: number, organizer = COLLEAGUE): GogEvent {
  return timed(`${date}T${start}:00+01:00`, `${date}T${end}:00+01:00`, people, organizer);
}

function allDay(first: string, next: string, people: number): GogEvent {
  const days = timed(`${first}T00:00:00+01:00`, `${next}T00:00:00+01:00`, people);
  return { ...days, start: { date: first }, end: { date: next } };
}

/** The event with the principal's answer on it changed. */
function answered(gogEvent: GogEvent, response: string): GogEvent {
  return {
    ...gogEvent,
    attendees: gogEvent.attendees?.map((party) => (party.self ? { ...party, responseStatus: response } : party)),
  };
}

function writeRaw(text: string): string {
  const file = path.join(root, `file${++fileCounter}.json`);
  fs.writeFileSync(file, text);
  return file;
}

/** What `gog calendar events --calendars <id> --all-pages` saves. */
function writeEvents(events: GogEvent[], calendarId = PRINCIPAL): string {
  return writeRaw(
    JSON.stringify({
      events: events.map((gogEvent) => ({ ...gogEvent, CalendarID: calendarId })),
      nextPageTokens: [],
    }),
  );
}

/**
 * Eight weeks of a principal's calendar. Mondays run 09:00-17:00 with one
 * early 07:00 start; Wednesdays have meetings in seven of the eight weeks;
 * Saturdays hold only a block with no guests; Sundays are empty.
 */
function eightWeeks(): GogEvent[] {
  const events: GogEvent[] = [];
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

/** schedule_stats over one saved file of `events`, unless `args` names other files. */
async function stats(events: GogEvent[], args: Record<string, unknown> = {}): Promise<ScheduleStatsResult> {
  const outcome = await call({ timezone: ZONE, ...WINDOW, files: [writeEvents(events)], ...args });
  if (outcome.isError) throw new Error(`schedule_stats failed: ${outcome.text}`);
  return JSON.parse(outcome.text) as ScheduleStatsResult;
}

async function refusal(args: Record<string, unknown>): Promise<string> {
  const outcome = await call({ timezone: ZONE, ...WINDOW, files: [writeEvents([])], ...args });
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

const NOTHING_SET_ASIDE = {
  duplicate_copies: 0,
  cancelled: 0,
  declined: 0,
  solo_blocks: 0,
  all_day: 0,
  zero_length: 0,
  crosses_midnight: 0,
  attendees_omitted: 0,
  outside_window: 0,
};

describe('schedule_stats over eight weeks of saved gog output', () => {
  it('returns the usual start and end of the working day for each weekday', async () => {
    const result = await stats(eightWeeks());
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
    // The principal set this one up from their home address: Google does not mark it as their own.
    const fromHome = event(addDays(WINDOW.from, 2), '13:00', '13:45', 4, HOME);
    const result = await stats([...eightWeeks(), fromHome], {
      principal_addresses: ['Principal@Example.TEST', 'Principal.Home@Gmail.COM'],
    });
    expect(result.meeting_lengths).toEqual({
      all: {
        count: 96,
        most_common: [
          { minutes: 30, count: 49 },
          { minutes: 60, count: 31 },
          { minutes: 45, count: 9 },
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
        count: 40,
        most_common: [
          { minutes: 60, count: 31 },
          { minutes: 45, count: 9 },
        ],
      },
      organized_by_principal: {
        count: 49,
        most_common: [
          { minutes: 30, count: 41 },
          { minutes: 25, count: 7 },
          { minutes: 45, count: 1 },
        ],
      },
    });
  });

  it('returns the usual gaps between meetings, setting aside free time of more than an hour', async () => {
    const result = await stats(eightWeeks());
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
    const result = await stats(eightWeeks());
    expect(result.events).toEqual({ ...NOTHING_SET_ASIDE, received: 103, meetings: 95, solo_blocks: 8 });
    expect(result.notes).toEqual([]);
  });

  it('gives the same answer whatever order the events arrive in', async () => {
    const forward = await stats(eightWeeks());
    expect(await stats(eightWeeks().reverse())).toEqual(forward);
  });

  it('reports no organizer split when the principal addresses are not given', async () => {
    const result = await stats(eightWeeks());
    expect(result.meeting_lengths.organized_by_principal).toBeNull();
  });

  it('sizes a meeting by its people: the principal counts once, however many of their addresses are invited', async () => {
    const date = addDays(WINDOW.from, 2);
    // Set up from home with the work address invited: with one guest it is a one-on-one, with none a block.
    const withGuest = event(date, '13:00', '13:30', 3, HOME);
    const block = event(date, '15:00', '16:00', 2, HOME);
    const result = await stats([withGuest, block], { principal_addresses: [PRINCIPAL, HOME] });
    expect(result.events).toMatchObject({ meetings: 1, solo_blocks: 1 });
    expect(result.meeting_lengths.one_on_one).toEqual({ count: 1, most_common: [{ minutes: 30, count: 1 }] });
  });

  it('counts a file saved a while ago, since history needs no fresh fetch', async () => {
    // Older than a conflict check accepts.
    const file = writeEvents(eightWeeks());
    const then = new Date(Date.now() - 16 * 60_000);
    fs.utimesSync(file, then, then);
    expect((await stats([], { files: [file] })).events.meetings).toBe(95);
  });
});

describe('schedule_stats reads times on the principal clocks', () => {
  it('keeps a 9am meeting at 09:00 across a clock change, whatever offset the event carries', async () => {
    // New York leaves daylight time on Sun 1 Nov 2026.
    const result = await stats(
      [
        timed('2026-10-26T09:00:00-04:00', '2026-10-26T09:30:00-04:00', 2),
        timed('2026-11-02T14:00:00Z', '2026-11-02T14:30:00Z', 2),
      ],
      { timezone: 'America/New_York', from: '2026-10-26', to: '2026-11-08' },
    );
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
    const result = await stats([timed('2026-10-04T23:30:00Z', '2026-10-05T00:00:00Z', 2)]);
    expect(result.events.outside_window).toBe(1);
    expect(result.events.meetings).toBe(0);
  });

  it('takes the earlier middle start and the later middle end when the days split evenly', async () => {
    const mondays = [0, 7, 14, 21].map((offset) => addDays(WINDOW.from, offset));
    const result = await stats([
      event(mondays[0], '08:00', '15:00', 2),
      event(mondays[1], '09:00', '16:00', 2),
      event(mondays[2], '10:00', '17:00', 2),
      event(mondays[3], '11:00', '18:00', 2),
    ]);
    expect(result.working_hours.mon.usual_start).toBe('09:00');
    expect(result.working_hours.mon.usual_end).toBe('17:00');
  });
});

describe('schedule_stats sets aside what is not a meeting', () => {
  it('answers empty input with counts of zero and no values', async () => {
    const result = await stats([]);
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
    const result = await stats([
      allDay('2026-08-10', '2026-08-11', 0),
      allDay('2026-08-11', '2026-08-14', 12),
      event('2026-08-10', '11:00', '11:30', 2),
    ]);
    expect(result.events).toEqual(expect.objectContaining({ received: 3, all_day: 2, meetings: 1 }));
    expect(result.working_hours.mon.usual_start).toBe('11:00');
    expect(result.working_hours.tue.days_with_meetings).toBe(0);
  });

  it('counts blocks with no other attendee, zero-length events, and events crossing midnight without using them', async () => {
    const result = await stats([
      event('2026-08-10', '07:00', '08:00', 0),
      event('2026-08-10', '06:00', '06:30', 1),
      event('2026-08-10', '12:00', '12:00', 3),
      timed('2026-08-10T23:00:00+01:00', '2026-08-11T00:30:00+01:00', 2),
      event('2026-08-10', '10:00', '11:00', 2),
    ]);
    expect(result.events).toEqual({
      ...NOTHING_SET_ASIDE,
      received: 5,
      meetings: 1,
      solo_blocks: 2,
      zero_length: 1,
      crosses_midnight: 1,
    });
    expect(result.working_hours.mon.usual_start).toBe('10:00');
    expect(result.working_hours.mon.usual_end).toBe('11:00');
  });

  it('sets aside cancelled events, invitations the principal declined, and events whose guests Google left out', async () => {
    const result = await stats([
      { ...event('2026-08-10', '08:00', '08:30', 2), status: 'cancelled' },
      answered(event('2026-08-10', '09:00', '10:00', 3), 'declined'),
      { ...event('2026-08-10', '10:00', '10:30', 1), attendeesOmitted: true },
      // An invitation the principal has not declined is time they may give.
      answered(event('2026-08-10', '11:00', '11:30', 2), 'needsAction'),
      answered(event('2026-08-10', '12:00', '12:30', 2), 'tentative'),
    ]);
    expect(result.events).toEqual({
      ...NOTHING_SET_ASIDE,
      received: 5,
      meetings: 2,
      cancelled: 1,
      declined: 1,
      attendees_omitted: 1,
    });
    expect(result.working_hours.mon.usual_start).toBe('11:00');
    expect(result.working_hours.mon.usual_end).toBe('12:30');
  });

  it('counts a meeting on two of the principal calendars once, and never counts a room as a person', async () => {
    const review = event('2026-08-10', '09:00', '10:00', 2);
    const focus = event('2026-08-10', '11:00', '11:30', 1, PRINCIPAL);
    const roomBooked: GogEvent = {
      ...focus,
      attendees: [...(focus.attendees ?? []), { email: ROOM, resource: true, responseStatus: 'accepted' }],
    };

    const result = await stats([], { files: [writeEvents([review, roomBooked]), writeEvents([review], HOME)] });

    expect(result.events).toEqual({
      ...NOTHING_SET_ASIDE,
      received: 3,
      meetings: 1,
      duplicate_copies: 1,
      solo_blocks: 1,
    });
    expect(result.meeting_lengths.all).toEqual({ count: 1, most_common: [{ minutes: 60, count: 1 }] });
  });

  it('counts a meeting the principal declined on one calendar but accepted on another', async () => {
    const review = event('2026-08-10', '09:00', '10:00', 2);

    const result = await stats([], {
      files: [writeEvents([answered(review, 'declined')], HOME), writeEvents([review])],
    });

    expect(result.events).toEqual({ ...NOTHING_SET_ASIDE, received: 2, meetings: 1, duplicate_copies: 1 });
    expect(result.meeting_lengths.all).toEqual({ count: 1, most_common: [{ minutes: 60, count: 1 }] });
  });

  it('keeps a meeting that ends exactly at midnight, ending at 24:00', async () => {
    const result = await stats([timed('2026-08-10T23:00:00+01:00', '2026-08-11T00:00:00+01:00', 2)]);
    expect(result.events.meetings).toBe(1);
    expect(result.working_hours.mon.usual_end).toBe('24:00');
    expect(result.meeting_lengths.all.most_common).toEqual([{ minutes: 60, count: 1 }]);
  });

  it('merges overlapping meetings for gaps, and still counts each one for lengths and hours', async () => {
    const result = await stats([
      event('2026-08-10', '09:00', '12:00', 4),
      event('2026-08-10', '10:00', '10:30', 2),
      event('2026-08-10', '11:30', '12:30', 3),
      event('2026-08-10', '12:30', '13:00', 2),
      event('2026-08-10', '13:15', '13:45', 2),
    ]);
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
    const sixty = await stats([], { from: '2026-08-01', to: '2026-09-29' });
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

  it('refuses the whole call when any event in a file is invalid, naming the file and each bad event', async () => {
    const good = event('2026-08-10', '09:00', '09:30', 2);
    const file = writeEvents([
      good,
      { ...good, start: { dateTime: '2026-08-10T09:00:00' } },
      { ...good, end: { dateTime: '2026-08-10T08:00:00+01:00' } },
    ]);
    expect(await refusal({ files: [file] })).toBe(
      `Error: Refused ${file}: 2 of 3 events are invalid, so nothing was counted. ` +
        'events[1].start must have a dateTime with its UTC offset, such as 2026-10-06T10:00:00+01:00, or a date. ' +
        'events[2] ends before it starts.',
    );
  });

  it('refuses a partial file, or one outside the folders it reads, naming it', async () => {
    // The reader's other refusals are pinned in calendar-facts.test.ts.
    for (const [file, reason] of [
      [writeRaw('{"events": [], "nextPageTokens": [{"calendarId": "x", "nextPageToken": "abc"}]}'), '--all-pages'],
      ['/etc/gog-events.json', 'outside'],
    ]) {
      const text = await refusal({ files: [file] });
      expect(text).toContain(file);
      expect(text).toContain(reason);
    }
  });

  it('refuses inputs that are not shaped as files and addresses', async () => {
    expect(await refusal({ files: 'events.json' })).toBe(
      'Error: files must list from 1 to 10 paths to saved gog calendar events output.',
    );
    expect(await refusal({ principal_addresses: 'principal@example.test' })).toBe(
      'Error: principal_addresses must be a list of email addresses.',
    );
  });
});
