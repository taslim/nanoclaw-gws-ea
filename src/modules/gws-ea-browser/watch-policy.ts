import { TIMEZONE } from '../../config.js';
import { principalNameAndTimezone } from '../gws-ea-profile/db.js';
import { zonedDate, zonedInstant } from './iso-time.js';

/**
 * Operator-owned politeness defaults, not claims about a merchant's published limits.
 * Each time of day names its clock: quiet hours are the principal's night, a condition
 * of their clock now, read from their profile each time, never a stored time; a release
 * is the venue's own schedule, recorded with its watch on the venue's clock.
 */
export interface WatchSitePolicy {
  floorMs: number;
  hourlyCap: number;
  dailyCap: number;
  intervalMs: number;
  jitterFraction: number;
  /** Hours [start, end) of the principal's local night, when no ordinary check starts. */
  principalQuietHours: readonly { start: number; end: number }[];
  notifySenders: readonly string[];
}
const defaults: WatchSitePolicy = Object.freeze({
  floorMs: 60_000,
  hourlyCap: 30,
  dailyCap: 240,
  intervalMs: 5 * 60_000,
  jitterFraction: 0.2,
  principalQuietHours: [{ start: 3, end: 6 }],
  notifySenders: [],
});
const policies: Readonly<Record<string, WatchSitePolicy>> = Object.freeze({
  'resy.com': { ...defaults },
  'opentable.com': { ...defaults },
  'exploretock.com': { ...defaults },
});
/** Unknown sender addresses stay empty until verified and reviewed as host policy. */
export function watchSitePolicy(site: string): WatchSitePolicy {
  return policies[site] ?? defaults;
}
function clockHour(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  return Number(parts.find((part) => part.type === 'hour')?.value);
}
/**
 * The principal's clock, which quiet hours and card times are read on: from the profile,
 * so a change they make through main holds at once; the install's until create seeds it,
 * as the rest of GWS-EA reads it.
 */
export async function principalClock(): Promise<string> {
  return (await principalNameAndTimezone()).timezone ?? TIMEZONE;
}
/** The first minute from `at` outside the principal's quiet hours, on their clock in `principalTimeZone`. */
export function watchQuietUntil(policy: WatchSitePolicy, at: number, principalTimeZone: string): number {
  let next = at;
  for (let count = 0; count < 24 * 60; count++) {
    const hour = clockHour(next, principalTimeZone);
    if (
      !policy.principalQuietHours.some((quiet) =>
        quiet.start <= quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end,
      )
    )
      return next;
    next += 60_000;
  }
  return next;
}
/**
 * A venue's stated release schedule, recorded once when its watch is set and never part
 * of the bounds the principal approves: tables for a date open some days before it, or
 * on a day of an earlier month, at a time on the venue's clock.
 */
export interface WatchReleaseRule {
  schedule: { kind: 'days_ahead'; days: number } | { kind: 'monthly'; day: number; monthsAhead: number };
  /** HH:MM on the venue's clock. */
  time: string;
  /** The venue's IANA zone, as the host read it from the site or, failing that, as the agent gave it. */
  timeZone: string;
  /** The venue's own words, the source of the rule. */
  wording: string;
}
/** The first check comes a few seconds after the release, once a venue that opens on the minute has opened. */
export const RELEASE_CHECK_DELAY_MS = 5_000;
/**
 * Checks then run at the site's floor for ten minutes: long enough for a release that opens
 * late and for tables that come back when the first rush's checkouts are abandoned, and at
 * the default floor about a third of the hourly cap, which still bounds it.
 */
export const RELEASE_BURST_MS = 10 * 60_000;

const calendarDay = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
function releaseDate(schedule: WatchReleaseRule['schedule'], date: string): string {
  switch (schedule.kind) {
    case 'days_ahead':
      return calendarDay(date, -schedule.days);
    case 'monthly': {
      const [year, month] = date.split('-').map(Number);
      const first = new Date(Date.UTC(year, month - 1 - schedule.monthsAhead, 1));
      const length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      return calendarDay(first.toISOString().slice(0, 10), Math.min(schedule.day, length) - 1);
    }
  }
}
/**
 * The release instants a rule sets for each venue date the windows cover, read on the
 * venue's clock. A release that had passed when the watch was set (`createdAt`), or whose
 * check would come after the watch ends (`until`), sets none.
 */
export function releaseInstants(
  rule: WatchReleaseRule,
  windows: readonly { start: string; end: string }[],
  createdAt: number,
  until: number,
): number[] {
  const releases = new Set<number>();
  for (const window of windows) {
    const last = zonedDate(Date.parse(window.end), rule.timeZone);
    for (let date = zonedDate(Date.parse(window.start), rule.timeZone); date <= last; date = calendarDay(date, 1)) {
      const release = zonedInstant(`${releaseDate(rule.schedule, date)}T${rule.time}:00`, rule.timeZone);
      // Later dates release no earlier.
      if (release + RELEASE_CHECK_DELAY_MS >= until) break;
      if (release > createdAt) releases.add(release);
    }
  }
  return [...releases].sort((a, b) => a - b);
}
/** The first moment from `at` inside a release burst, if one is still to end. */
function releaseBurstFrom(releases: readonly number[], at: number): number | undefined {
  let first: number | undefined;
  for (const release of releases) {
    const start = release + RELEASE_CHECK_DELAY_MS;
    if (at >= start + RELEASE_BURST_MS) continue;
    first = Math.min(first ?? Infinity, Math.max(at, start));
  }
  return first;
}
/**
 * When a check due at `due` may start: at once inside a release burst, which the
 * principal's night does not hold, otherwise once their night is over or a burst begins.
 */
export function watchStartAt(
  policy: WatchSitePolicy,
  due: number,
  releases: readonly number[],
  principalTimeZone: string,
): number {
  return Math.min(watchQuietUntil(policy, due, principalTimeZone), releaseBurstFrom(releases, due) ?? Infinity);
}
/**
 * The one source of a watch's next check, after one at `now`: the floor inside a release
 * burst, otherwise a cadence that quickens as arrival nears, and never past a coming
 * release check, nor so close before one that the floor would hold it back. A bounded
 * jitter avoids identical intervals even when a deterministic random source repeats.
 */
export function nextWatchCheck(
  policy: WatchSitePolicy,
  now: number,
  arrival: number,
  releases: readonly number[],
  previous: number | null,
  random: () => number = Math.random,
): { at: number; interval: number } {
  const remaining = arrival - now;
  const base =
    releaseBurstFrom(releases, now) === now
      ? policy.floorMs
      : Math.min(
          policy.intervalMs,
          remaining < 86_400_000 ? 2 * 60_000 : remaining < 7 * 86_400_000 ? 4 * 60_000 : policy.intervalMs,
        );
  let interval = Math.max(
    policy.floorMs,
    Math.round(base * (1 + (Math.min(1, Math.max(0, random())) * 2 - 1) * policy.jitterFraction)),
  );
  if (interval === previous) interval++;
  const release = Math.min(
    ...releases.map((instant) => instant + RELEASE_CHECK_DELAY_MS).filter((check) => check > now),
  );
  return now + interval >= release - policy.floorMs
    ? { at: release, interval: release - now }
    : { at: now + interval, interval };
}
