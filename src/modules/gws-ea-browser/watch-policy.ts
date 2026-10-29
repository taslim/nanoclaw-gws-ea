import { TIMEZONE } from '../../config.js';
import { loadTimeline, zoneAt } from '../gws-ea-whereabouts/timeline.js';
import { zonedDate, zonedInstant } from './iso-time.js';

/**
 * Host politeness defaults, not claims about a merchant's published limits. Quiet hours are a condition of the
 * principal's clock as it is now, never a stored time.
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
/** A site's `notifySenders` stay empty until its sender addresses are verified and reviewed as host policy. */
export function watchSitePolicy(site: string): WatchSitePolicy {
  return policies[site] ?? defaults;
}
function clockHour(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  return Number(parts.find((part) => part.type === 'hour')?.value);
}
/** One current whereabouts snapshot for the moment this browser operation concerns. */
export async function principalClock(at = Date.now()): Promise<string> {
  return zoneAt(await loadTimeline(), at) ?? TIMEZONE;
}
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
 * A venue's stated release schedule, recorded once when its watch is set and never part of the bounds the principal
 * approves: tables for a date open some days before it, or on a day of an earlier month, at a time on the venue's
 * clock.
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
const RELEASE_CHECK_DELAY_MS = 5_000;
/**
 * Checks then run at the site's floor: long enough for a release that opens late and for tables that come back when
 * the first rush's checkouts are abandoned, and at the default floor about a third of the hourly cap, which still
 * bounds it.
 */
const RELEASE_BURST_MS = 10 * 60_000;

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
 * The release instants a rule sets for each venue date the windows cover, read on the venue's clock. A release that
 * had passed when the watch was set (`createdAt`), or whose check would come after the watch ends (`until`), sets none.
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
 * When a check due at `due` may start: at once inside a release burst, which the principal's night does not hold,
 * otherwise once their night is over or a burst begins.
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
 * How often a watch with no reader may wake the browser agent in any hour: every change it reports and every request
 * to mark its region again count, and a change over the cap waits until the hour allows it.
 */
export const WATCH_HOURLY_WAKES = 5;
/** The most normalized text a marked region may hold: the part that shows availability, not a whole page. */
export const WATCH_REGION_TEXT_LIMIT = 4_000;
/** Cap on a slowed watch's interval before jitter, however many of its changes matched nothing. */
const WATCH_SLOWED_INTERVAL_MS = 60 * 60_000;
/** The interval multiplier after `unmatched` wakes this hour that led to no booking. */
export function watchSlowdown(unmatched: number): number {
  return 2 ** Math.min(Math.max(0, unmatched), WATCH_HOURLY_WAKES);
}
export interface WatchCheckPlanInput {
  readonly now: number;
  /** The earliest arrival the watch's windows allow. */
  readonly arrival: number;
  readonly releases: readonly number[];
  /** The interval the site's last plan chose, which this one never repeats. */
  readonly previous: number | null;
  readonly random?: () => number;
  /** A `watchSlowdown` multiplier. */
  readonly slowdown?: number;
}
/**
 * A watch's next check after one at `now`: the floor inside a release burst, otherwise a cadence that quickens as
 * arrival nears, slowed by `slowdown` to at most an hour when the watch's changes keep matching nothing. Never past a
 * coming release check, nor so close before one that the floor would hold it back. Jitter, and the bump off
 * `previous`, keep intervals from repeating even when a deterministic random source does.
 */
export function nextWatchCheck(
  policy: WatchSitePolicy,
  { now, arrival, releases, previous, random = Math.random, slowdown = 1 }: WatchCheckPlanInput,
): { at: number; interval: number } {
  const remaining = arrival - now;
  const cadence = Math.min(
    policy.intervalMs,
    remaining < 86_400_000 ? 2 * 60_000 : remaining < 7 * 86_400_000 ? 4 * 60_000 : policy.intervalMs,
  );
  // A release burst is the moment the watch exists for: no slowdown holds it back.
  const base =
    releaseBurstFrom(releases, now) === now
      ? policy.floorMs
      : Math.min(cadence * Math.max(1, slowdown), Math.max(cadence, WATCH_SLOWED_INTERVAL_MS));
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
