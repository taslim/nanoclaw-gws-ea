import { expect, it } from 'vitest';

import {
  RELEASE_BURST_MS,
  RELEASE_CHECK_DELAY_MS,
  WATCH_SLOWED_INTERVAL_MS,
  nextWatchCheck,
  releaseInstants,
  watchQuietUntil,
  watchSitePolicy,
  watchSlowdown,
  watchStartAt,
  type WatchReleaseRule,
} from './watch-policy.js';

const policy = watchSitePolicy('resy.com');
const quietUntil = (at: string, timeZone: string): string =>
  new Date(watchQuietUntil(policy, Date.parse(at), timeZone)).toISOString();

it("pauses for the principal's local night and keeps checking through their evening", () => {
  // 20:30 in Los Angeles is 03:30 UTC: prime time for a dinner table, never quiet.
  expect(quietUntil('2026-10-16T03:30:00.000Z', 'America/Los_Angeles')).toBe('2026-10-16T03:30:00.000Z');
  // 03:30 in Los Angeles waits for 06:00 there.
  expect(quietUntil('2026-10-16T10:30:00.000Z', 'America/Los_Angeles')).toBe('2026-10-16T13:00:00.000Z');
});

it.each([
  [
    'falls back',
    [
      ['2026-10-31T10:30:00.000Z', '2026-10-31T13:00:00.000Z'],
      ['2026-11-01T10:30:00.000Z', '2026-11-01T10:30:00.000Z'],
      ['2026-11-01T11:30:00.000Z', '2026-11-01T14:00:00.000Z'],
    ],
  ],
  [
    'springs forward',
    [
      ['2027-03-13T11:30:00.000Z', '2027-03-13T14:00:00.000Z'],
      ['2027-03-14T09:59:00.000Z', '2027-03-14T09:59:00.000Z'],
      ['2027-03-14T10:00:00.000Z', '2027-03-14T13:00:00.000Z'],
    ],
  ],
] as const)('keeps quiet hours at 03:00-06:00 local as Los Angeles %s', (_change, cases) => {
  for (const [at, until] of cases) expect(quietUntil(at, 'America/Los_Angeles')).toBe(until);
});

// "Tables released 30 days ahead at 10:00" at a Tokyo venue, for a table on 24 November.
const tokyo: WatchReleaseRule = {
  schedule: { kind: 'days_ahead', days: 30 },
  time: '10:00',
  timeZone: 'Asia/Tokyo',
  wording: 'Tables released 30 days ahead at 10:00',
};
const dinner = [{ start: '2026-11-24T19:00:00+09:00', end: '2026-11-24T21:00:00+09:00' }];
const created = Date.parse('2026-10-15T12:00:00Z');
const until = Date.parse('2026-11-24T00:00:00Z');
const iso = (at: number): string => new Date(at).toISOString();

it("expands a venue's days-ahead rule to a release on its own clock for each watched date", () => {
  // 10:00 in Tokyo on 25 October, ten days from now.
  expect(releaseInstants(tokyo, dinner, created, until).map(iso)).toEqual(['2026-10-25T01:00:00.000Z']);
  // A window across two venue dates releases each of them.
  expect(
    releaseInstants(
      tokyo,
      [{ start: '2026-11-24T21:00:00+09:00', end: '2026-11-25T01:00:00+09:00' }],
      created,
      until + 86_400_000,
    ).map(iso),
  ).toEqual(['2026-10-25T01:00:00.000Z', '2026-10-26T01:00:00.000Z']);
});

it('expands a monthly date to the month it names, on the last day when the month is short', () => {
  const monthly = (day: number): WatchReleaseRule => ({
    schedule: { kind: 'monthly', day, monthsAhead: 1 },
    time: '12:00',
    timeZone: 'Europe/Paris',
    wording: `Reservations for the next month open on day ${day} at noon`,
  });
  const december = [{ start: '2026-12-10T19:00:00+01:00', end: '2026-12-10T21:00:00+01:00' }];
  expect(releaseInstants(monthly(1), december, created, Date.parse('2026-12-10T00:00:00Z')).map(iso)).toEqual([
    '2026-11-01T11:00:00.000Z',
  ]);
  expect(releaseInstants(monthly(31), december, created, Date.parse('2026-12-10T00:00:00Z')).map(iso)).toEqual([
    '2026-11-30T11:00:00.000Z',
  ]);
});

it('releases nothing that had passed when the watch was set, or that comes after it ends', () => {
  // A table 20 days out was released ten days ago.
  const soon = [{ start: '2026-11-04T19:00:00+09:00', end: '2026-11-04T21:00:00+09:00' }];
  expect(releaseInstants(tokyo, soon, created, until)).toEqual([]);
  // A release a few minutes before the watch was set has passed too.
  expect(releaseInstants(tokyo, dinner, Date.parse('2026-10-25T01:03:00Z'), until)).toEqual([]);
  // The watch ends before the release.
  expect(releaseInstants(tokyo, dinner, created, Date.parse('2026-10-25T01:00:00Z'))).toEqual([]);
});

it('moves a release time a daylight-saving change skips forward, and takes the first of a repeated one', () => {
  const at = (time: string, date: string): string[] =>
    releaseInstants(
      { schedule: { kind: 'days_ahead', days: 1 }, time, timeZone: 'America/New_York', wording: 'A day ahead' },
      [{ start: `${date}T19:00:00-04:00`, end: `${date}T21:00:00-04:00` }],
      created,
      Date.parse('2027-12-31T00:00:00Z'),
    ).map(iso);
  // 02:30 on 14 March 2027 does not exist in New York; the clock reads 03:30 EDT then.
  expect(at('02:30', '2027-03-15')).toEqual(['2027-03-14T07:30:00.000Z']);
  // 01:30 on 7 November 2027 happens twice; the first is 01:30 EDT.
  expect(at('01:30', '2027-11-08')).toEqual(['2027-11-07T05:30:00.000Z']);
});

it('checks a few seconds after the release, then at the floor through the burst, then at the ordinary cadence', () => {
  const release = Date.parse('2026-10-25T01:00:00Z');
  const arrival = Date.parse(dinner[0].start);
  const next = (at: string, releases: readonly number[] = [release]): { at: string; interval: number } => {
    const plan = nextWatchCheck(policy, { now: Date.parse(at), arrival, releases, previous: null, random: () => 0.5 });
    return { at: iso(plan.at), interval: plan.interval };
  };
  // An ordinary check close before the release gives way to the release check at 10:00:05 in Tokyo.
  expect(next('2026-10-25T00:57:30Z').at).toBe('2026-10-25T01:00:05.000Z');
  expect(RELEASE_CHECK_DELAY_MS).toBe(5_000);
  // One well before keeps the ordinary cadence.
  expect(next('2026-10-24T12:00:00Z')).toEqual({ at: '2026-10-24T12:05:00.000Z', interval: policy.intervalMs });
  // Inside the burst, the floor.
  expect(next('2026-10-25T01:00:05Z').interval).toBe(policy.floorMs);
  expect(next(iso(release + RELEASE_CHECK_DELAY_MS + RELEASE_BURST_MS - 1)).interval).toBe(policy.floorMs);
  // After it, and with no rule at all, the ordinary cadence.
  expect(next(iso(release + RELEASE_CHECK_DELAY_MS + RELEASE_BURST_MS)).interval).toBe(policy.intervalMs);
  expect(next('2026-10-25T00:57:30Z', [])).toEqual({ at: '2026-10-25T01:02:30.000Z', interval: policy.intervalMs });
});

it("lets a release burst start inside the principal's night and holds ordinary checks until morning", () => {
  const release = Date.parse('2026-10-25T01:00:00Z');
  // 01:00 UTC is 05:00 in Dubai, inside the principal's night.
  const startAt = (at: string, releases: readonly number[]): string =>
    iso(watchStartAt(policy, Date.parse(at), releases, 'Asia/Dubai'));
  expect(startAt('2026-10-25T00:30:00Z', [release])).toBe('2026-10-25T01:00:05.000Z');
  expect(startAt('2026-10-25T01:04:00Z', [release])).toBe('2026-10-25T01:04:00.000Z');
  expect(startAt('2026-10-25T01:30:00Z', [release])).toBe('2026-10-25T02:00:00.000Z');
  expect(startAt('2026-10-25T00:30:00Z', [])).toBe('2026-10-25T02:00:00.000Z');
});

it('slows a watch whose changes keep matching nothing, to at most an hour, but never its release', () => {
  const release = Date.parse('2026-10-25T01:00:00Z');
  const arrival = Date.parse(dinner[0].start);
  const plan = (at: string, unmatched: number, releases: readonly number[] = []) =>
    nextWatchCheck(policy, {
      now: Date.parse(at),
      arrival,
      releases,
      previous: null,
      random: () => 0.5,
      slowdown: watchSlowdown(unmatched),
    });
  // A month out the cadence is five minutes; each change that booked nothing doubles it, up to an hour.
  expect([0, 1, 2, 3, 4, 5, 9].map((unmatched) => plan('2026-10-17T12:00:00Z', unmatched).interval / 60_000)).toEqual([
    5, 10, 20, 40, 60, 60, 60,
  ]);
  expect(WATCH_SLOWED_INTERVAL_MS).toBe(60 * 60_000);
  // The day before arrival the cadence is two minutes, and slows from there.
  expect(plan('2026-11-24T00:00:00Z', 2).interval).toBe(8 * 60_000);
  // A release is the moment the watch exists for: its burst keeps the floor, and a slowed check gives way to it.
  expect(plan('2026-10-25T01:00:05Z', 5, [release]).interval).toBe(policy.floorMs);
  expect(plan('2026-10-25T00:30:00Z', 5, [release]).at).toBe(release + RELEASE_CHECK_DELAY_MS);
});
