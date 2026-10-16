/** Operator-owned politeness defaults, not claims about a merchant's published limits. */
export interface WatchSitePolicy {
  floorMs: number;
  hourlyCap: number;
  dailyCap: number;
  intervalMs: number;
  jitterFraction: number;
  quietHours: readonly { start: number; end: number }[];
  timeZone: string;
  releaseTimes: readonly { hour: number; minute: number; burstMinutes: number }[];
  notifySenders: readonly string[];
}
const defaults: WatchSitePolicy = Object.freeze({
  floorMs: 60_000,
  hourlyCap: 30,
  dailyCap: 240,
  intervalMs: 5 * 60_000,
  jitterFraction: 0.2,
  quietHours: [{ start: 3, end: 6 }],
  timeZone: 'UTC',
  releaseTimes: [],
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
function clock(at: number, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  return {
    hour: Number(parts.find((part) => part.type === 'hour')?.value),
    minute: Number(parts.find((part) => part.type === 'minute')?.value),
  };
}
export function watchQuietUntil(policy: WatchSitePolicy, at: number): number {
  let next = at;
  for (let count = 0; count < 24 * 60; count++) {
    const { hour } = clock(next, policy.timeZone);
    if (
      !policy.quietHours.some((quiet) =>
        quiet.start <= quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end,
      )
    )
      return next;
    next += 60_000;
  }
  return next;
}
/** A bounded jitter avoids identical intervals even when a deterministic random source repeats. */
export function watchInterval(
  policy: WatchSitePolicy,
  now: number,
  arrival: number,
  previous: number | null,
  random: () => number = Math.random,
): number {
  const { hour, minute } = clock(now, policy.timeZone);
  const release = policy.releaseTimes.some((time) => {
    const elapsed = (hour * 60 + minute - time.hour * 60 - time.minute + 1440) % 1440;
    return elapsed < time.burstMinutes;
  });
  const remaining = arrival - now;
  const base = release
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
  return interval;
}
