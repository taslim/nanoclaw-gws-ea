import { runBrowserWatchCheck } from './watch-runtime.js';
import {
  type WatchBounds,
  type WatchRow,
  watchSlotKey,
  watchReleases,
  emitWatchNotice,
  regionWatchSlowdown,
  type RegionCheckRead,
  recordRegionCheck,
  deliverWatchNotices,
  expireBrowserWatches,
} from './watch-state.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DbDriver } from '../../db/driver.js';
import { findPrincipalCalendarConflicts, type CalendarConflictResult } from '../gws-ea-meetings/calendar-facts.js';
import { dkimAlignedToSite } from '../gws-ea-inbox/authentication.js';
import type { ParsedMail } from '../gws-ea-inbox/mime.js';
import { registerInboxObserver } from '../gws-ea-inbox/observers.js';
import { cancelBrowserJob } from './cancel.js';
import type { ReservationAvailability } from './merchant-contract.js';
import { browserAvailability, browserConfigured } from './availability.js';

import type { BrowserQueue } from './queue.js';
import type { StructuredBrowserLocator } from './locators.js';

import {
  nextWatchCheck,
  loadPrincipalClock,
  watchSitePolicy,
  watchStartAt,
  type WatchSitePolicy,
} from './watch-policy.js';

export interface BrowserWatchCheckInput {
  id: string;
  jobId: string;
  site: string;
  recipeId: string;
  parameters: Record<string, string>;
  venueId: string;
  partySize: number;
  /** Set for a region watch: the check reads this region's text instead of a reader's availability. */
  region?: StructuredBrowserLocator;
}
export type BrowserWatchCheckResult =
  | { status: 'ready'; availability: Extract<ReservationAvailability, { status: 'ready' }> }
  | RegionCheckRead
  | { status: 'blocked' | 'failed' | 'site_busy' };
interface WatchSchedulerDeps {
  check(queue: BrowserQueue, input: BrowserWatchCheckInput, signal: AbortSignal): Promise<BrowserWatchCheckResult>;
  calendar(start: string, end: string): Promise<CalendarConflictResult>;
  policy(site: string): WatchSitePolicy;
  random(): number;
}
interface SiteState {
  site: string;
  last_check_at: string | null;
  last_interval_ms: number | null;
  next_allowed_at: string | null;
  backoff_until: string | null;
  consecutive_blocks: number;
  budget_scale: number;
}
const MAX_CONCURRENT_SITES = 4;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const watchBounds = (watch: WatchRow): WatchBounds => JSON.parse(watch.bounds_json) as WatchBounds;
function groupKey(watch: WatchRow): string {
  const bounds = watchBounds(watch);
  return JSON.stringify([
    watch.check_recipe_id,
    watch.check_recipe_version,
    watch.check_key,
    bounds.venue.id,
    bounds.partySize,
    bounds.windows.map((window) => [window.start.slice(0, 10), window.end.slice(0, 10)]),
    // Region watches share a check only when they read the same marked region.
    watch.region_json,
  ]);
}
export class BrowserWatchScheduler {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private controller = new AbortController();
  private unobserve: (() => void) | undefined;
  private unsubscribeAbort: (() => void) | undefined;
  private readonly deps: WatchSchedulerDeps;
  constructor(
    private readonly queue: BrowserQueue,
    deps: Partial<WatchSchedulerDeps> = {},
  ) {
    this.deps = {
      check: runBrowserWatchCheck,
      calendar: findPrincipalCalendarConflicts,
      policy: watchSitePolicy,
      random: Math.random,
      ...deps,
    };
  }
  start(signal?: AbortSignal): void {
    if (this.timer || signal?.aborted) return;
    this.controller = new AbortController();
    if (signal) {
      const onAbort = (): void => {
        void this.stop();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.unsubscribeAbort = () => signal.removeEventListener('abort', onAbort);
    }
    this.unobserve = registerInboxObserver((mail) => this.notify(mail));
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 1_000);
    this.timer.unref();
    void this.tick().catch(() => undefined);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribeAbort?.();
    this.unsubscribeAbort = undefined;
    this.controller.abort();
    this.unobserve?.();
    this.unobserve = undefined;
    await this.active;
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    const running = this.runTick();
    this.active = running;
    void running
      .finally(() => {
        if (this.active === running) this.active = undefined;
      })
      .catch(() => undefined);
    return running;
  }
  /** Only marks the site for an early check: it never claims, fetches or reroutes the mail. */
  async notify(mail: ParsedMail): Promise<void> {
    if (!mail.from) return;
    const db = this.queue.store.db;
    if (!(await db.hasTable('gws_ea_browser_watches'))) return;
    const sites = await db.all<{ site: string }>(
      "SELECT DISTINCT site FROM gws_ea_browser_watches WHERE status = 'armed'",
    );
    for (const { site } of sites)
      if (
        this.deps.policy(site).notifySenders.includes(mail.from.address.toLowerCase()) &&
        dkimAlignedToSite(mail.headers, site)
      ) {
        await db.run(
          'INSERT INTO gws_ea_browser_watch_notify(site,message_id,received_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',
          site,
          mail.id,
          new Date().toISOString(),
        );
      }
  }
  private async runTick(): Promise<void> {
    const db = this.queue.store.db;
    if (!(await db.hasTable('gws_ea_browser_watches')) || this.controller.signal.aborted) return;
    if (!browserConfigured()) {
      const jobs = await db.all<{ job_id: string }>(
        "SELECT DISTINCT job_id FROM gws_ea_browser_watches WHERE status IN ('awaiting_principal','armed','checking','preparing','booking')",
      );
      for (const job of jobs) await cancelBrowserJob(job.job_id, this.queue.store);
      return;
    }
    await expireBrowserWatches(db);
    await deliverWatchNotices(db);
    if (!(await browserAvailability()).available) return;
    const rows = await db.all<WatchRow>(
      "SELECT w.* FROM gws_ea_browser_watches w JOIN gws_ea_browser_jobs j ON j.id=w.job_id WHERE w.status='armed' AND j.cancelled=0 AND j.cancel_requested=0 ORDER BY w.next_check_at,w.created_at,w.id",
    );
    const sites = new Map<string, Map<string, WatchRow[]>>();
    for (const row of rows) {
      let groups = sites.get(row.site);
      if (!groups) {
        groups = new Map();
        sites.set(row.site, groups);
      }
      const key = groupKey(row);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const pending = sites.values();
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(MAX_CONCURRENT_SITES, sites.size) }, async () => {
        for (const groups of pending) await this.runSite(groups);
      }),
    );
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }
  private async runSite(groups: Map<string, WatchRow[]>): Promise<void> {
    const db = this.queue.store.db;
    for (const watches of groups.values()) {
      if (this.controller.signal.aborted) return;
      const first = watches[0];
      const now = Date.now();
      const notify = await db.get(
        'SELECT message_id FROM gws_ea_browser_watch_notify WHERE site=? AND consumed_at IS NULL LIMIT 1',
        first.site,
      );
      if (Date.parse(first.next_check_at) > now && !notify) continue;
      const policy = this.deps.policy(first.site);
      // A shared check serves every member's venue release.
      const releases = watches.flatMap(watchReleases);
      // A due check waits out the principal's night on their clock as it is now, so a timezone change holds at
      // once; a release burst does not wait.
      if (watchStartAt(policy, now, releases, await loadPrincipalClock()) > now) continue;
      const state = await this.reserveCheck(db, watches, policy, Boolean(notify));
      if (!state) continue;
      const id = `watch-check-${randomUUID()}`;
      const bounds = watchBounds(first);
      const at = new Date().toISOString();
      await db.transaction(async () => {
        await db.run(
          `INSERT INTO gws_ea_browser_watch_checks(id,site,check_recipe_id,check_recipe_version,parameter_hash,trigger,scheduled_at,started_at) VALUES(?,?,?,?,?,?,?,?)`,
          id,
          first.site,
          first.check_recipe_id,
          first.check_recipe_version,
          first.check_key,
          notify ? 'notify' : 'timer',
          first.next_check_at,
          at,
        );
        for (const watch of watches) {
          const changed = await db.run(
            "UPDATE gws_ea_browser_watches SET status='checking',pending_request_id=? WHERE id=? AND status='armed'",
            id,
            watch.id,
          );
          if (changed.changes)
            await db.run('INSERT INTO gws_ea_browser_watch_check_members(check_id,watch_id) VALUES(?,?)', id, watch.id);
        }
        if (notify)
          await db.run(
            'UPDATE gws_ea_browser_watch_notify SET consumed_at=? WHERE site=? AND consumed_at IS NULL',
            at,
            first.site,
          );
      });
      let result: BrowserWatchCheckResult;
      try {
        result = await this.deps.check(
          this.queue,
          {
            id,
            jobId: first.job_id,
            site: first.site,
            recipeId: first.check_recipe_id,
            parameters: JSON.parse(first.parameters_json) as Record<string, string>,
            venueId: bounds.venue.id,
            partySize: bounds.partySize,
            ...(first.region_json ? { region: JSON.parse(first.region_json) as StructuredBrowserLocator } : {}),
          },
          this.controller.signal,
        );
        // eslint-disable-next-line no-catch-all/no-catch-all -- Every native browser check failure is recorded as failed, never empty availability.
      } catch (_error) {
        result = { status: 'failed' };
      }
      // A region's read decides its wakes before the next check is planned, so a change that matched nothing slows it now.
      if (result.status === 'region_read' || result.status === 'region_missing')
        for (const watch of watches) await recordRegionCheck(db, watch, id, result);
      const blocks = result.status === 'blocked' ? state.consecutive_blocks + 1 : 0;
      const backoff =
        result.status === 'blocked'
          ? Date.now() + Math.min(24 * 60 * 60_000, policy.floorMs * 2 ** Math.min(blocks, 20))
          : 0;
      const arrival = Math.min(...bounds.windows.map((window) => Date.parse(window.start)));
      const plan = nextWatchCheck(policy, {
        now: Date.now(),
        arrival,
        releases,
        previous: state.last_interval_ms,
        random: this.deps.random,
        slowdown: await regionWatchSlowdown(db, watches),
      });
      const next = new Date(Math.max(plan.at, backoff)).toISOString();
      await db.transaction(async () => {
        await db.run(
          'UPDATE gws_ea_browser_watch_checks SET finished_at=?,outcome=?,next_check_at=?,backoff_until=? WHERE id=?',
          new Date().toISOString(),
          result.status,
          next,
          backoff ? new Date(backoff).toISOString() : null,
          id,
        );
        await db.run(
          'UPDATE gws_ea_browser_watch_site_state SET consecutive_blocks=?,budget_scale=?,backoff_until=?,last_interval_ms=?,next_allowed_at=? WHERE site=?',
          blocks,
          result.status === 'blocked' ? Math.max(1 / policy.dailyCap, state.budget_scale / 2) : state.budget_scale,
          backoff ? new Date(backoff).toISOString() : null,
          plan.interval,
          new Date(Math.max(Date.now() + policy.floorMs, backoff)).toISOString(),
          first.site,
        );
        for (const watch of watches)
          await db.run(
            "UPDATE gws_ea_browser_watches SET status=?,pending_request_id=NULL,next_check_at=?,updated_at=? WHERE id=? AND status='checking'",
            blocks >= 3 ? 'blocked' : 'armed',
            next,
            new Date().toISOString(),
            watch.id,
          );
      });
      if (blocks >= 3) for (const watch of watches) await emitWatchNotice(watch, 'blocked', 'blocked');
      if (result.status === 'ready' && !this.controller.signal.aborted)
        await this.processHits(watches, result.availability);
      // A region watch never books by itself: its change wakes the agent, who decides.
      if (result.status === 'region_read' || result.status === 'region_missing') await deliverWatchNotices(db);
    }
  }
  private async reserveCheck(
    db: DbDriver,
    watches: WatchRow[],
    policy: WatchSitePolicy,
    notify: boolean,
  ): Promise<SiteState | undefined> {
    return db.transaction(async () => {
      const site = watches[0].site;
      const now = Date.now();
      await db.run('INSERT INTO gws_ea_browser_watch_site_state(site) VALUES(?) ON CONFLICT DO NOTHING', site);
      const state = (await db.get<SiteState>('SELECT * FROM gws_ea_browser_watch_site_state WHERE site=?', site))!;
      let next = Math.max(
        Date.parse(state.next_allowed_at ?? '') || 0,
        Date.parse(state.backoff_until ?? '') || 0,
        (Date.parse(state.last_check_at ?? '') || 0) + policy.floorMs,
      );
      const checks = await db.all<{ started_at: string }>(
        'SELECT started_at FROM gws_ea_browser_watch_checks WHERE site=? AND started_at>? ORDER BY started_at',
        site,
        new Date(now - 86_400_000).toISOString(),
      );
      for (const [window, cap] of [
        [3_600_000, policy.hourlyCap],
        [86_400_000, policy.dailyCap],
      ]) {
        const times = checks.map((row) => Date.parse(row.started_at)).filter((time) => time > now - window);
        const limit = Math.max(1, Math.floor(cap * state.budget_scale));
        if (times.length >= limit) next = Math.max(next, times[times.length - limit] + window + 1);
      }
      if (next > now) {
        for (const watch of watches)
          if (!notify || Date.parse(watch.next_check_at) < next)
            await db.run(
              'UPDATE gws_ea_browser_watches SET next_check_at=? WHERE id=? AND status=?',
              new Date(next).toISOString(),
              watch.id,
              'armed',
            );
        return undefined;
      }
      await db.run(
        'UPDATE gws_ea_browser_watch_site_state SET last_check_at=?,next_allowed_at=? WHERE site=?',
        new Date(now).toISOString(),
        new Date(now + policy.floorMs).toISOString(),
        site,
      );
      return state;
    });
  }
  private async processHits(
    watches: WatchRow[],
    availability: Extract<ReservationAvailability, { status: 'ready' }>,
  ): Promise<void> {
    const queuedSlots = new Set<string>();
    const calendarResults = new Map<string, 'free' | 'calendar_conflict' | 'calendar_unavailable'>();
    for (const watch of watches) {
      const current = await this.queue.store.db.get<WatchRow>(
        'SELECT * FROM gws_ea_browser_watches WHERE id=?',
        watch.id,
      );
      if (current?.status !== 'armed') continue;
      const bounds = watchBounds(current);
      for (const slot of availability.slots) {
        const key = watchSlotKey(slot.reservation);
        const reservation = slot.reservation;
        if (
          availability.site !== bounds.site ||
          availability.venue.id !== bounds.venue.id ||
          availability.venue.name !== bounds.venue.name ||
          availability.partySize !== bounds.partySize ||
          reservation.venueId !== bounds.venue.id ||
          reservation.venueName !== bounds.venue.name ||
          reservation.partySize !== bounds.partySize ||
          !bounds.windows.some(
            (window) =>
              Date.parse(reservation.at) >= Date.parse(window.start) &&
              Date.parse(reservation.at) <= Date.parse(window.end),
          )
        ) {
          await emitWatchNotice(watch, 'outside_bounds', `outside:${key}`, { slot: reservation });
          continue;
        }
        const calendarKey = JSON.stringify([reservation.at, reservation.endAt]);
        let calendarStatus = calendarResults.get(calendarKey);
        if (!calendarStatus) {
          try {
            const calendar = await this.deps.calendar(reservation.at, reservation.endAt);
            calendarStatus = calendar.conflicts.length || calendar.conflicts_not_listed ? 'calendar_conflict' : 'free';
            // eslint-disable-next-line no-catch-all/no-catch-all -- Unavailable calendar data never counts as a free slot.
          } catch (_error) {
            calendarStatus = 'calendar_unavailable';
          }
          calendarResults.set(calendarKey, calendarStatus);
        }
        if (calendarStatus !== 'free') {
          await emitWatchNotice(watch, calendarStatus, `${calendarStatus}:${key}`, { slot: reservation });
          continue;
        }
        const lease = await this.queue.store.db.get<{ job_id: string }>(
          'SELECT job_id FROM gws_ea_browser_site_leases WHERE site=?',
          watch.site,
        );
        if (!watch.booking_recipe_id || (lease && lease.job_id !== watch.job_id)) {
          await emitWatchNotice(watch, 'available', `available:${key}`, {
            reason: watch.booking_recipe_id ? 'site_busy' : 'booking_recipe_required',
            slot: reservation,
          });
          continue;
        }
        if (queuedSlots.has(key)) continue;
        const slotClaim = await this.queue.store.db.get(
          'SELECT watch_id FROM gws_ea_browser_watch_slot_claims WHERE site=? AND slot_key=?',
          watch.site,
          key,
        );
        if (slotClaim) continue;
        const requestId = `watch-book-${watch.id}-${hash(`${key}:${new Date().toISOString()}`)}`;
        const preparing = await this.queue.store.db.run(
          "UPDATE gws_ea_browser_watches SET status='preparing',pending_request_id=? WHERE id=? AND status='armed'",
          requestId,
          watch.id,
        );
        if (!preparing.changes) continue;
        try {
          await this.queue.enqueueInternal(watch.job_id, 'browser_watch_book', { watch_id: watch.id }, requestId);
        } catch (error) {
          await this.queue.store.db.run(
            "UPDATE gws_ea_browser_watches SET status='armed',pending_request_id=NULL WHERE id=? AND status='preparing' AND pending_request_id=?",
            watch.id,
            requestId,
          );
          throw error;
        }
        queuedSlots.add(key);
        break;
      }
    }
  }
}
export function createBrowserWatchScheduler(
  queue: BrowserQueue,
  deps: Partial<WatchSchedulerDeps> = {},
): BrowserWatchScheduler {
  return new BrowserWatchScheduler(queue, deps);
}

/** Optional scheduled-check repair never gates required attempts or ordinary browser admission. */
export async function repairBrowserWatchChecks(queue: BrowserQueue): Promise<void> {
  const db = queue.store.db;
  if (!(await db.hasTable('gws_ea_browser_watches'))) return;
  await db.run(
    "UPDATE gws_ea_browser_watch_checks SET finished_at = ?,outcome = 'interrupted' WHERE finished_at IS NULL",
    new Date().toISOString(),
  );
  await expireBrowserWatches(db);
  await deliverWatchNotices(db);
}
