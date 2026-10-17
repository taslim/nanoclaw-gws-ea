import { expect, it } from 'vitest';

import { watchInterval, watchQuietUntil, watchSitePolicy } from './watch-policy.js';

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

it('reads each release time on the site clock it names, across that clock’s DST change', () => {
  const site = {
    ...policy,
    principalQuietHours: [],
    releaseTimes: [{ hour: 10, minute: 0, burstMinutes: 15, timeZone: 'America/New_York' }],
  };
  const interval = (at: string): number => {
    const now = Date.parse(at);
    return watchInterval(site, now, now + 30 * 86_400_000, null, () => 0.5);
  };
  // 10:05 in New York bursts at the floor, in daylight and standard time alike.
  expect(interval('2026-10-15T14:05:00Z')).toBe(site.floorMs);
  expect(interval('2026-11-02T15:05:00Z')).toBe(site.floorMs);
  // 10:05 UTC is 06:05 in New York: the usual cadence.
  expect(interval('2026-10-15T10:05:00Z')).toBe(site.intervalMs);
});
