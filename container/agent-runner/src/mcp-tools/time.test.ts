import { afterEach, describe, expect, it } from 'bun:test';

import {
  createTimeTools,
  type TimeConvertResult,
  type TimeDiffResult,
  type TimeNowResult,
  type TimeRangeResult,
  type TimeResolveResult,
} from './time.js';

/** Mon, Oct 5 2026 09:00 UTC: 10:00 in Lagos, 05:00 in New York. */
const NOW = Date.UTC(2026, 9, 5, 9, 0, 0);

interface ResultOf {
  time_now: TimeNowResult;
  time_resolve: TimeResolveResult;
  time_convert: TimeConvertResult;
  time_diff: TimeDiffResult;
  time_range: TimeRangeResult;
}
type ToolName = keyof ResultOf;

async function call(
  zone: string,
  name: ToolName,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const definition = createTimeTools(zone, () => NOW).find((candidate) => candidate.tool.name === name);
  if (!definition) throw new Error(`no tool named ${name}`);
  const result = await definition.handler(args);
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error(`${name} returned no text`);
  return { isError: result.isError === true, text: block.text };
}

async function ok<N extends ToolName>(zone: string, name: N, args: Record<string, unknown> = {}): Promise<ResultOf[N]> {
  const outcome = await call(zone, name, args);
  if (outcome.isError) throw new Error(`${name} failed: ${outcome.text}`);
  return JSON.parse(outcome.text) as ResultOf[N];
}

async function failure(zone: string, name: ToolName, args: Record<string, unknown>): Promise<string> {
  const outcome = await call(zone, name, args);
  expect(outcome.isError).toBe(true);
  return outcome.text;
}

describe('the tool set', () => {
  it("keeps Soji's five tools", () => {
    expect(createTimeTools('UTC').map((definition) => definition.tool.name)).toEqual([
      'time_now',
      'time_resolve',
      'time_convert',
      'time_diff',
      'time_range',
    ]);
  });

  it('refuses a zone that is not an IANA timezone', () => {
    expect(() => createTimeTools('Mars/Olympus_Mons')).toThrow('Mars/Olympus_Mons');
  });
});

describe('time_now', () => {
  it("reports the current time in the principal's timezone", async () => {
    expect(await ok('Africa/Lagos', 'time_now')).toEqual({
      iso: '2026-10-05T10:00:00+01:00',
      formatted: 'Mon, Oct 5 2026 10:00 AM GMT+1',
      day: 'Monday',
      zone: 'Africa/Lagos',
      unix: NOW / 1000,
    });
    const newYork = await ok('America/New_York', 'time_now');
    expect(newYork.iso).toBe('2026-10-05T05:00:00-04:00');
    expect(newYork.formatted).toBe('Mon, Oct 5 2026 5:00 AM EDT');
  });
});

describe('time_resolve', () => {
  it('resolves "next Tuesday at 3pm" against a fixed reference in Africa/Lagos and America/New_York', async () => {
    for (const [zone, iso, reference] of [
      ['Africa/Lagos', '2026-10-13T15:00:00+01:00', '2026-10-05T10:00:00+01:00'],
      ['America/New_York', '2026-10-13T15:00:00-04:00', '2026-10-05T10:00:00-04:00'],
    ]) {
      const body = await ok(zone, 'time_resolve', {
        expression: 'next Tuesday at 3pm',
        reference_date: '2026-10-05T10:00',
      });
      expect(body.reference.iso).toBe(reference);
      expect(body.resolved).toEqual(expect.objectContaining({ iso, day: 'Tuesday', zone }));
      expect(body.time_stated).toBe(true);
      expect(body.interpretation.read).toBe('next Tuesday at 3pm');
      // Said on a Monday, "next Tuesday" could be tomorrow: the tool says which it chose and what the other is.
      expect(body.interpretation.notes).toContain(
        '"next Tuesday at 3pm" was read as Tue, Oct 13 2026, in the week after this one. If the coming Tuesday was meant, that is Tue, Oct 6 2026.',
      );
    }
  });

  it('reads relative days from the reference as it is on the clocks of the zone', async () => {
    // 23:30 UTC on Monday is already Tuesday in Lagos, and still Monday evening in New York.
    const args = { expression: 'tomorrow at 9am', reference_date: '2026-10-05T23:30:00Z' };
    expect((await ok('Africa/Lagos', 'time_resolve', args)).resolved?.iso).toBe('2026-10-07T09:00:00+01:00');
    expect((await ok('America/New_York', 'time_resolve', args)).resolved?.iso).toBe('2026-10-06T09:00:00-04:00');
  });

  it('resolves against now when no reference is given', async () => {
    const body = await ok('Africa/Lagos', 'time_resolve', { expression: 'tomorrow at 9am' });
    expect(body.reference.iso).toBe('2026-10-05T10:00:00+01:00');
    expect(body.resolved?.iso).toBe('2026-10-06T09:00:00+01:00');
  });

  it('reports 02:30 on a spring-forward day in America/New_York as nonexistent', async () => {
    for (const expression of ['March 8 2026 at 2:30am', '2026-03-08T02:30', '2026-03-08 02:30']) {
      const text = await failure('America/New_York', 'time_resolve', { expression });
      expect(text).toBe(
        'Error: 2:30 AM on Sun, Mar 8 2026 does not exist in America/New_York: the clocks go forward then, from UTC-05:00 to UTC-04:00. Use a time before or after the change.',
      );
    }
  });

  it('returns both candidates for 01:30 on a fall-back day, and resolves neither', async () => {
    const body = await ok('America/New_York', 'time_resolve', {
      expression: 'November 1 2026 at 1:30am',
      reference_date: '2026-10-05',
    });
    expect(body.resolved).toBeUndefined();
    expect(body.candidates?.map((candidate) => candidate.iso)).toEqual([
      '2026-11-01T01:30:00-04:00',
      '2026-11-01T01:30:00-05:00',
    ]);
    expect(body.candidates?.map((candidate) => candidate.formatted)).toEqual([
      'Sun, Nov 1 2026 1:30 AM EDT',
      'Sun, Nov 1 2026 1:30 AM EST',
    ]);
    expect(body.interpretation.notes).toContain(
      '1:30 AM on Sun, Nov 1 2026 happens twice in America/New_York because the clocks go back then: first at UTC-04:00, then at UTC-05:00. Ask which one is meant.',
    );
  });

  it('keeps an explicit UTC offset exact, even inside a clock change', async () => {
    const body = await ok('America/New_York', 'time_resolve', { expression: '2026-11-01T01:30:00-05:00' });
    expect(body.resolved?.iso).toBe('2026-11-01T01:30:00-05:00');
    expect(body.candidates).toBeUndefined();
  });

  it('says when a time has already passed and was moved to the next day', async () => {
    const body = await ok('Africa/Lagos', 'time_resolve', {
      expression: '9am',
      reference_date: '2026-10-05T16:00',
    });
    expect(body.resolved?.iso).toBe('2026-10-06T09:00:00+01:00');
    expect(body.interpretation.notes).toContain(
      '"9am" could also mean Mon, Oct 5 2026 9:00 AM, which is in the past; read as Tue, Oct 6 2026 9:00 AM.',
    );
  });

  it('gives the other reading of an hour said without AM or PM', async () => {
    const body = await ok('Africa/Lagos', 'time_resolve', {
      expression: 'Thursday at 3',
      reference_date: '2026-10-05T10:00',
    });
    expect(body.resolved?.iso).toBe('2026-10-08T03:00:00+01:00');
    expect(body.interpretation.notes).toContain(
      'No AM or PM was given: read as 3:00 AM. If the afternoon or evening was meant, that is 3:00 PM.',
    );
  });

  it('does not treat a 24-hour time as missing its AM or PM', async () => {
    const body = await ok('Africa/Lagos', 'time_resolve', {
      expression: 'Thursday at 03:00',
      reference_date: '2026-10-05T10:00',
    });
    expect(body.interpretation.notes).toEqual([]);
  });

  it('flags a day given without a time', async () => {
    const body = await ok('Africa/Lagos', 'time_resolve', {
      expression: 'Friday',
      reference_date: '2026-10-05T10:00',
    });
    expect(body.resolved?.day).toBe('Friday');
    expect(body.time_stated).toBe(false);
    expect(body.interpretation.notes).toContain('No time of day was given; the time shown is a placeholder.');
  });

  it('reads a date without a year as the next one, and says so', async () => {
    const body = await ok('Africa/Lagos', 'time_resolve', {
      expression: 'May 1 at 2pm',
      reference_date: '2026-10-05T10:00',
    });
    expect(body.resolved?.iso).toBe('2027-05-01T14:00:00+01:00');
    expect(body.interpretation.notes).toContain(
      '"May 1 at 2pm" could also mean Fri, May 1 2026 2:00 PM, which is in the past; read as Sat, May 1 2027 2:00 PM.',
    );
  });

  it('keeps "last" in the past', async () => {
    const body = await ok('Africa/Lagos', 'time_resolve', {
      expression: 'last Friday at 10am',
      reference_date: '2026-10-05T10:00',
    });
    expect(body.resolved?.iso).toBe('2026-10-02T10:00:00+01:00');
  });

  it('says which part of a longer phrase it read', async () => {
    const body = await ok('Africa/Lagos', 'time_resolve', {
      expression: 'the budget review next Tuesday 1pm',
      reference_date: '2026-10-05T10:00',
    });
    expect(body.interpretation.read).toBe('next Tuesday 1pm');
    expect(body.interpretation.notes).toContain('Read only "next Tuesday 1pm"; the rest was ignored.');
  });

  it('uses a timezone named in the text, and says so', async () => {
    const body = await ok('America/New_York', 'time_resolve', {
      expression: 'October 6 2026 3pm EST',
      reference_date: '2026-10-05T10:00',
    });
    expect(body.resolved?.iso).toBe('2026-10-06T16:00:00-04:00');
    expect(body.interpretation.notes).toContain('Used the timezone in the text: UTC-05:00.');
  });

  it('resolves a range with its end', async () => {
    const body = await ok('Africa/Lagos', 'time_resolve', {
      expression: 'Wednesday 3-4pm',
      reference_date: '2026-10-05T10:00',
    });
    expect(body.resolved?.iso).toBe('2026-10-07T15:00:00+01:00');
    expect(body.end?.iso).toBe('2026-10-07T16:00:00+01:00');
  });

  it('refuses an expression that names more than one date', async () => {
    const text = await failure('Africa/Lagos', 'time_resolve', { expression: 'two weeks from Friday' });
    expect(text).toContain('more than one date or time');
    expect(text).toContain('"two weeks", "Friday"');
    expect(text).toContain('reference_date');
  });

  it('refuses what it cannot read, and a reference that is not ISO', async () => {
    expect(await failure('Africa/Lagos', 'time_resolve', { expression: 'whenever suits' })).toContain(
      'Could not read "whenever suits"',
    );
    expect(await failure('Africa/Lagos', 'time_resolve', { expression: '' })).toBe('Error: expression is required.');
    expect(
      await failure('Africa/Lagos', 'time_resolve', { expression: 'tomorrow', reference_date: 'last week' }),
    ).toContain('reference_date must be an ISO date or date-time');
    expect(await failure('Africa/Lagos', 'time_resolve', { expression: '2026-02-30' })).toContain(
      '2026-02-30 is not a valid date',
    );
  });
});

describe('natural language independent of the process timezone', () => {
  const processZone = process.env.TZ;
  afterEach(() => {
    // Bun keeps the zone it started with when TZ is deleted, so restore by assignment.
    process.env.TZ = processZone ?? 'UTC';
  });

  it('reads the same in every process timezone', async () => {
    const args = { expression: 'next Tuesday at 3pm', reference_date: '2026-10-05T23:30:00Z' };
    const expected = (await ok('Africa/Lagos', 'time_resolve', args)).resolved?.iso;
    for (const zone of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Chatham']) {
      process.env.TZ = zone;
      expect((await ok('Africa/Lagos', 'time_resolve', args)).resolved?.iso).toBe(expected);
    }
  });

  // The container runs with TZ set to the principal's zone, so chrono's own
  // arithmetic happens on those clocks. Elapsed time must still come out exact.
  it('counts "in N hours" as elapsed time across a spring-forward change', async () => {
    process.env.TZ = 'America/New_York';
    const from = { reference_date: '2026-03-08T00:30' };
    expect((await ok('America/New_York', 'time_resolve', { expression: 'in 2 hours', ...from })).resolved?.iso).toBe(
      '2026-03-08T03:30:00-04:00',
    );
    expect((await ok('America/New_York', 'time_resolve', { expression: 'in 3 hours', ...from })).resolved?.iso).toBe(
      '2026-03-08T04:30:00-04:00',
    );
    expect(
      (await ok('America/New_York', 'time_resolve', { expression: '2 hours ago', reference_date: '2026-03-08T04:30' }))
        .resolved?.iso,
    ).toBe('2026-03-08T01:30:00-05:00');
  });

  // chrono stamps "now" with the process timezone's offset as if the text had
  // named it; read in any other zone, that offset would move the instant.
  it('reads "now" as the reference instant, whatever zone it is read in', async () => {
    process.env.TZ = 'Asia/Tokyo';
    const resolved = await ok('Africa/Lagos', 'time_resolve', {
      expression: 'now',
      reference_date: '2026-10-05T10:00',
    });
    expect(resolved.resolved?.iso).toBe('2026-10-05T10:00:00+01:00');
    expect(resolved.interpretation.notes).toEqual([]);

    process.env.TZ = 'Africa/Lagos';
    const converted = await ok('Africa/Lagos', 'time_convert', { time: 'now', from: 'America/New_York' });
    expect(converted.source?.iso).toBe('2026-10-05T05:00:00-04:00');
    expect(converted.conversions?.['Africa/Lagos'].iso).toBe('2026-10-05T10:00:00+01:00');
  });

  it('counts "in N hours" as elapsed time across a fall-back change', async () => {
    process.env.TZ = 'America/New_York';
    const body = await ok('America/New_York', 'time_resolve', {
      expression: 'in 3 hours',
      reference_date: '2026-11-01T00:30',
    });
    expect(body.resolved?.iso).toBe('2026-11-01T02:30:00-05:00');
  });
});

describe('time_convert', () => {
  it('converts 15:00 Europe/London to Africa/Lagos and Asia/Tokyo on both sides of the UK clock change', async () => {
    const before = await ok('Africa/Lagos', 'time_convert', {
      time: '2026-03-27T15:00',
      from: 'Europe/London',
      to: ['Africa/Lagos', 'Asia/Tokyo'],
    });
    expect(before.source?.iso).toBe('2026-03-27T15:00:00+00:00');
    expect(before.conversions?.['Africa/Lagos'].iso).toBe('2026-03-27T16:00:00+01:00');
    expect(before.conversions?.['Asia/Tokyo']).toEqual({
      iso: '2026-03-28T00:00:00+09:00',
      formatted: 'Sat, Mar 28 2026 12:00 AM GMT+9',
      day: 'Saturday',
      zone: 'Asia/Tokyo',
    });

    const after = await ok('Africa/Lagos', 'time_convert', {
      time: '2026-03-30T15:00',
      from: 'Europe/London',
      to: ['Africa/Lagos', 'Asia/Tokyo'],
    });
    expect(after.source?.iso).toBe('2026-03-30T15:00:00+01:00');
    expect(after.conversions?.['Africa/Lagos'].iso).toBe('2026-03-30T15:00:00+01:00');
    expect(after.conversions?.['Asia/Tokyo'].iso).toBe('2026-03-30T23:00:00+09:00');
  });

  it("converts into the principal's timezone by default", async () => {
    const body = await ok('Africa/Lagos', 'time_convert', { time: '2026-10-05T09:00', from: 'America/New_York' });
    expect(Object.keys(body.conversions ?? {})).toEqual(['Africa/Lagos']);
    expect(body.conversions?.['Africa/Lagos'].iso).toBe('2026-10-05T14:00:00+01:00');
  });

  it('reads natural language in the source timezone', async () => {
    const body = await ok('Africa/Lagos', 'time_convert', { time: 'tomorrow at 9am', from: 'America/New_York' });
    expect(body.source?.iso).toBe('2026-10-06T09:00:00-04:00');
    expect(body.conversions?.['Africa/Lagos'].iso).toBe('2026-10-06T14:00:00+01:00');
  });

  it('refuses a nonexistent local time and returns both conversions of one that happens twice', async () => {
    expect(
      await failure('Africa/Lagos', 'time_convert', { time: '2026-03-08T02:30', from: 'America/New_York' }),
    ).toContain('does not exist in America/New_York');

    const body = await ok('Africa/Lagos', 'time_convert', {
      time: '2026-11-01T01:30',
      from: 'America/New_York',
      to: ['UTC'],
    });
    expect(body.ambiguous).toBe(true);
    expect(body.source).toBeUndefined();
    expect(body.candidates?.map((candidate) => candidate.conversions.UTC.iso)).toEqual([
      '2026-11-01T05:30:00Z',
      '2026-11-01T06:30:00Z',
    ]);
    expect(body.notes?.[0]).toContain('happens twice in America/New_York');
  });

  it('refuses an unknown timezone', async () => {
    expect(await failure('Africa/Lagos', 'time_convert', { time: '2026-10-05T09:00', from: 'Lagos' })).toContain(
      'Invalid source timezone "Lagos"',
    );
    expect(
      await failure('Africa/Lagos', 'time_convert', { time: '2026-10-05T09:00', to: ['UTC', 'Nowhere/Else'] }),
    ).toContain('Invalid target timezone "Nowhere/Else"');
    expect(await failure('Africa/Lagos', 'time_convert', { time: '2026-10-05T09:00', to: 'UTC' })).toBe(
      'Error: to must be a list of IANA timezones.',
    );
  });
});

describe('time_diff', () => {
  it('counts 2 business days between a Friday and the next Tuesday', async () => {
    const body = await ok('Africa/Lagos', 'time_diff', { from: '2026-10-09', to: '2026-10-13' });
    expect(body.business_days).toBe(2);
    expect(body.calendar_days).toBe(4);
    expect(body.direction).toBe('future');
    expect(body.human).toBe('4 days');
    expect(body.from.day).toBe('Friday');
    expect(body.to.day).toBe('Tuesday');
  });

  it('counts weekdays after the start day up to and including the end day, in either direction', async () => {
    expect((await ok('Africa/Lagos', 'time_diff', { from: '2026-10-10', to: '2026-10-12' })).business_days).toBe(1);
    expect((await ok('Africa/Lagos', 'time_diff', { from: '2026-10-09', to: '2026-10-11' })).business_days).toBe(0);
    expect((await ok('Africa/Lagos', 'time_diff', { from: '2026-10-05', to: '2026-11-02' })).business_days).toBe(20);
    const past = await ok('Africa/Lagos', 'time_diff', { from: '2026-10-13', to: '2026-10-09' });
    expect(past.direction).toBe('past');
    expect(past.business_days).toBe(2);
    expect(past.calendar_days).toBe(4);
  });

  it('counts calendar days by the local date, not by elapsed hours', async () => {
    const body = await ok('Africa/Lagos', 'time_diff', { from: '2026-10-09T22:00', to: '2026-10-10T07:00' });
    expect(body.calendar_days).toBe(1);
    expect(body.human).toBe('9 hours');
    expect(body.breakdown).toEqual({ years: 0, months: 0, weeks: 0, days: 0, hours: 9, minutes: 0 });
  });

  it('measures from now by default', async () => {
    const body = await ok('Africa/Lagos', 'time_diff', { to: '2026-10-06T12:30' });
    expect(body.from.iso).toBe('2026-10-05T10:00:00+01:00');
    expect(body.human).toBe('1 day, 2 hours and 30 minutes');
  });

  it('refuses a local time that does not exist or happens twice', async () => {
    expect(await failure('America/New_York', 'time_diff', { from: '2026-03-01', to: '2026-03-08T02:30' })).toContain(
      'does not exist in America/New_York',
    );
    const text = await failure('America/New_York', 'time_diff', { from: '2026-10-01', to: '2026-11-01T01:30' });
    expect(text).toContain('to: 1:30 AM on Sun, Nov 1 2026 happens twice');
    expect(text).toContain('2026-11-01T01:30:00-04:00 or 2026-11-01T01:30:00-05:00');
  });
});

describe('time_range', () => {
  it('refuses a range over 60 days and names the limit', async () => {
    expect(await failure('Africa/Lagos', 'time_range', { from: '2026-10-01', to: '2026-12-15' })).toBe(
      'Error: Range too large: it covers 76 days. The maximum is 60 days.',
    );
    const sixty = await ok('Africa/Lagos', 'time_range', { from: '2026-10-01', to: '2026-11-29' });
    expect(sixty.count).toBe(60);
  });

  it('lists weekday slots on a fixed grid, including the whole last day', async () => {
    const body = await ok('Africa/Lagos', 'time_range', {
      from: '2026-10-05',
      to: '2026-10-11',
      time_start: '09:00',
      time_end: '11:00',
      weekdays_only: true,
    });
    expect(body.count).toBe(10);
    expect(body.slots[0]).toEqual({
      date: 'Mon, Oct 5',
      day: 'Monday',
      time: '9:00 AM',
      iso: '2026-10-05T09:00:00+01:00',
    });
    expect(body.slots.at(-1)?.iso).toBe('2026-10-09T10:00:00+01:00');
    expect(body.time_window).toBe('09:00–11:00');
    expect(body.interval_minutes).toBe(60);
  });

  it('keeps the grid when the range starts between slots', async () => {
    const body = await ok('Africa/Lagos', 'time_range', {
      from: '2026-10-05T10:17',
      to: '2026-10-05',
      time_start: '09:00',
      time_end: '12:00',
    });
    expect(body.slots.map((slot) => slot.time)).toEqual(['11:00 AM']);
  });

  it('lists whole days when no daily window is given', async () => {
    const body = await ok('Africa/Lagos', 'time_range', { from: '2026-10-09', to: '2026-10-12' });
    expect(body.slots).toEqual([
      { date: 'Fri, Oct 9 2026', day: 'Friday', iso: '2026-10-09T00:00:00+01:00' },
      { date: 'Sat, Oct 10 2026', day: 'Saturday', iso: '2026-10-10T00:00:00+01:00' },
      { date: 'Sun, Oct 11 2026', day: 'Sunday', iso: '2026-10-11T00:00:00+01:00' },
      { date: 'Mon, Oct 12 2026', day: 'Monday', iso: '2026-10-12T00:00:00+01:00' },
    ]);
  });

  it('skips a slot the clocks jump over and marks one that happens twice', async () => {
    const spring = await ok('America/New_York', 'time_range', {
      from: '2026-03-08',
      to: '2026-03-08',
      time_start: '00:00',
      time_end: '04:00',
    });
    expect(spring.slots.map((slot) => slot.iso)).toEqual([
      '2026-03-08T00:00:00-05:00',
      '2026-03-08T01:00:00-05:00',
      '2026-03-08T03:00:00-04:00',
    ]);
    expect(spring.skipped).toEqual(['2:00 AM on Sun, Mar 8 2026 does not exist in America/New_York.']);

    const fall = await ok('America/New_York', 'time_range', {
      from: '2026-11-01',
      to: '2026-11-01',
      time_start: '00:00',
      time_end: '03:00',
    });
    expect(fall.slots.map((slot) => slot.iso)).toEqual([
      '2026-11-01T00:00:00-04:00',
      '2026-11-01T01:00:00-04:00',
      '2026-11-01T02:00:00-05:00',
    ]);
    expect(fall.slots[1].second_occurrence_iso).toBe('2026-11-01T01:00:00-05:00');
    expect(fall.skipped).toBeUndefined();
  });

  it('refuses bad windows and intervals', async () => {
    const range = { from: '2026-10-05', to: '2026-10-06' };
    expect(await failure('Africa/Lagos', 'time_range', { ...range, time_start: '09:00' })).toBe(
      'Error: time_start and time_end go together; give both or neither.',
    );
    expect(await failure('Africa/Lagos', 'time_range', { ...range, time_start: '17:00', time_end: '09:00' })).toContain(
      'time_end must be after time_start',
    );
    expect(await failure('Africa/Lagos', 'time_range', { ...range, time_start: '9am', time_end: '17:00' })).toContain(
      'Invalid time_start "9am"',
    );
    for (const interval of [0, -15, 1.5, 1441]) {
      expect(
        await failure('Africa/Lagos', 'time_range', {
          ...range,
          time_start: '09:00',
          time_end: '17:00',
          interval_minutes: interval,
        }),
      ).toBe('Error: interval_minutes must be a whole number from 1 to 1440.');
    }
    expect(await failure('Africa/Lagos', 'time_range', { from: '2026-10-06', to: '2026-10-05' })).toBe(
      'Error: "to" must be after "from".',
    );
  });

  it('refuses more than 1000 slots', async () => {
    expect(
      await failure('Africa/Lagos', 'time_range', {
        from: '2026-10-01',
        to: '2026-10-30',
        time_start: '00:00',
        time_end: '23:59',
        interval_minutes: 15,
      }),
    ).toContain('Too many slots (more than 1000)');
  });
});
