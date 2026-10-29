import { useAvailableBrowser } from './testing/browser-runtime.js';
import { createBrowserQueue } from './index.js';
import fs from 'node:fs';
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return `${tmpdir()}/browser-scheduler-tests`;
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
  // The install's zone, which quiet hours fall back to until the profile holds the principal's.
  TIMEZONE: 'America/New_York',
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { closeDb, createAgentGroup, createPendingApproval, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { requestWake } from '../../request-wake.js';
import { resolveSystemSession } from '../../session-manager.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore } from './db.js';
import { browserAvailability } from './availability.js';
import { type BrowserQueue } from './queue.js';
import { browserWatchesMigration } from './migration.js';
import { createBrowserWatchScheduler, type BrowserWatchCheckResult } from './scheduler.js';
import type { WatchBounds } from './watch-state.js';
import type { ReservationAvailability } from './merchant-contract.js';
import { nextWatchCheck, watchSitePolicy, type WatchReleaseRule, type WatchSitePolicy } from './watch-policy.js';
import { parseGmailMessage } from '../gws-ea-inbox/mime.js';
import * as profile from '../gws-ea-profile/db.js';
import { setPrincipalNameAndTimezone } from '../gws-ea-profile/db.js';

let queue: BrowserQueue;
let jobId: string;
beforeEach(async () => {
  useAvailableBrowser();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  await runMigrations(await initTestDb());
  if (!(await getDb().hasTable('gws_ea_browser_watches'))) await browserWatchesMigration.up(getDb());
  for (const id of ['scheduler-main', 'scheduler-browser'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ?,browser_agent_group_id = ? WHERE singleton = 1`,
    'scheduler-main',
    'scheduler-browser',
  );
  const session = (await resolveSystemSession('scheduler-browser', 'system:a2a:scheduler-main:job')).session;
  const store = new BrowserStore();
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Missing job');
  jobId = job.id;
  queue = createBrowserQueue(store, {
    async pageForJob(): Promise<never> {
      throw new Error('Unexpected signed-in browser');
    },
    async connection(): Promise<never> {
      throw new Error('Unexpected browser');
    },
    async closeJob() {},
    onDisconnected: () => () => undefined,
  });
  const file = `${root}/browser`;
  fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });

  process.env.GWS_EA_BROWSER_ROOT = file;
});
afterEach(async () => {
  delete process.env.GWS_EA_BROWSER_ROOT;
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
const bounds: WatchBounds = {
  site: 'resy.com',
  venue: { id: 'bistro', name: 'Bistro' },
  partySize: 4,
  windows: [{ start: '2026-10-16T19:00:00Z', end: '2026-10-16T21:00:00Z' }],
  financial: { freeOnly: true, currency: 'USD', maxTotalMinor: 0, maxDueNowMinor: 0 },
  until: '2026-10-16T18:00:00Z',
};
/**
 * An armed watch of the job. `watch` sets its bounds apart from the shared ones, its venue's release rule, and, for a
 * region watch, its marked region's baseline text.
 */
async function arm(
  id: string,
  key: string,
  party = 4,
  version = 1,
  site = bounds.site,
  watch: { bounds?: Partial<WatchBounds>; release?: WatchReleaseRule; baseline?: string } = {},
): Promise<void> {
  const at = new Date().toISOString();
  const region = watch.baseline !== undefined;
  await getDb().run(
    `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,release_json,region_json,region_baseline,region_marked_at,status,created_at,updated_at,next_check_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'armed',?,?,?)`,
    id,
    jobId,
    site,
    `recipe:${site}`,
    version,
    JSON.stringify({ party: String(party) }),
    key,
    JSON.stringify({ ...bounds, site, partySize: party, ...watch.bounds }),
    watch.release ? JSON.stringify(watch.release) : null,
    region
      ? JSON.stringify({ role: 'region', name: 'Available tables', ordinal: 0, count: 1, framePath: [], frameUrls: [] })
      : null,
    watch.baseline ?? null,
    region ? at : null,
    at,
    at,
    at,
  );
  await getDb().run(
    "INSERT INTO gws_ea_browser_watch_job_claims(job_id,state) VALUES(?,'available') ON CONFLICT DO NOTHING",
    jobId,
  );
}
function availability(partySize = 4): Extract<ReservationAvailability, { status: 'ready' }> {
  return {
    status: 'ready',
    site: 'resy.com',
    venue: bounds.venue,
    partySize,
    currency: 'USD',
    timeZone: 'UTC',
    slots: [
      {
        id: 'slot',
        reservation: {
          venueId: 'bistro',
          venueName: 'Bistro',
          partySize,
          at: '2026-10-16T19:30:00Z',
          endAt: '2026-10-16T21:00:00Z',
          timeZone: 'UTC',
        },
      },
    ],
  };
}
const freeCalendar = async () => ({ conflicts: [], conflicts_not_listed: 0, message: 'Free' });

it('expires watches and delivers pending notices without Chrome, without running checks', async () => {
  await arm('expired-offline', 'expired', 4, 1, bounds.site, {
    bounds: { until: new Date(Date.now() - 1000).toISOString() },
  });
  await arm('notice-offline', 'waiting');
  await getDb().run(
    'INSERT INTO gws_ea_browser_watch_notices(watch_id,event_key,outcome_json,created_at) VALUES(?,?,?,?)',
    'notice-offline',
    'blocked',
    JSON.stringify({ status: 'blocked', reason: 'calendar_unavailable' }),
    new Date().toISOString(),
  );
  const { scheduler, checks } = countingScheduler();
  vi.mocked(browserAvailability).mockResolvedValueOnce({ available: false, reason: 'chrome-missing' });

  await scheduler.tick();

  expect(await getDb().all('SELECT id,status FROM gws_ea_browser_watches ORDER BY id')).toEqual([
    { id: 'expired-offline', status: 'expired' },
    { id: 'notice-offline', status: 'armed' },
  ]);
  expect(await getDb().all('SELECT watch_id,delivered_at FROM gws_ea_browser_watch_notices ORDER BY watch_id')).toEqual(
    [
      { watch_id: 'expired-offline', delivered_at: expect.any(String) },
      { watch_id: 'notice-offline', delivered_at: expect.any(String) },
    ],
  );
  expect(checks()).toBe(0);
  expect(await getDb().all('SELECT id FROM gws_ea_browser_watch_checks')).toEqual([]);
});

it('preserves armed watches and pending cards while Chrome is missing, then checks when it returns', async () => {
  await arm('armed', 'ready');
  await arm('pending', 'pending');
  await getDb().run("UPDATE gws_ea_browser_watches SET status='awaiting_principal' WHERE id='pending'");
  await createPendingApproval({
    approval_id: 'pending-watch-card',
    request_id: 'pending-watch-setup',
    action: 'browser_watch_setup',
    payload: JSON.stringify({ watchId: 'pending' }),
    created_at: new Date().toISOString(),
    title: 'Watch for a table?',
    options_json: '[]',
  });
  const { scheduler, checks } = countingScheduler();
  vi.mocked(browserAvailability).mockResolvedValueOnce({ available: false, reason: 'chrome-missing' });

  await scheduler.tick();

  expect(await getDb().get('SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id=?', jobId)).toEqual({
    cancelled: 0,
    cancel_requested: 0,
  });
  expect(await getDb().all('SELECT id,status FROM gws_ea_browser_watches ORDER BY id')).toEqual([
    { id: 'armed', status: 'armed' },
    { id: 'pending', status: 'awaiting_principal' },
  ]);
  expect(await getDb().get('SELECT status FROM pending_approvals WHERE approval_id=?', 'pending-watch-card')).toEqual({
    status: 'pending',
  });
  expect(checks()).toBe(0);
  expect(await getDb().all('SELECT id FROM gws_ea_browser_watch_checks')).toEqual([]);

  await scheduler.tick();

  expect(checks()).toBe(1);
  expect(await getDb().all('SELECT outcome FROM gws_ea_browser_watch_checks')).toEqual([{ outcome: 'ready' }]);
  expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'armed')).toEqual({
    status: 'armed',
  });
  expect(await getDb().get('SELECT status FROM pending_approvals WHERE approval_id=?', 'pending-watch-card')).toEqual({
    status: 'pending',
  });
});

it('cancels armed watch errands when the browser root is no longer configured', async () => {
  await arm('armed', 'ready');
  const { scheduler, checks } = countingScheduler();
  vi.stubEnv('GWS_EA_BROWSER_ROOT', 'relative/browser');

  await scheduler.tick();

  expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id=?', jobId)).toEqual({ cancelled: 1 });
  expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'armed')).toEqual({
    status: 'cancelled',
  });
  expect(checks()).toBe(0);
});

it('releases the host abort subscription when stopped and still honors host shutdown', async () => {
  const host = new AbortController();
  for (let attempt = 0; attempt < 3; attempt++) {
    const scheduler = createBrowserWatchScheduler(queue);
    scheduler.start(host.signal);
    expect(getEventListeners(host.signal, 'abort')).toHaveLength(1);
    await scheduler.stop();
    expect(getEventListeners(host.signal, 'abort')).toHaveLength(0);
  }
  await arm('shutdown-watch', 'shutdown');
  let checkStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    checkStarted = resolve;
  });
  let aborted = false;
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async (_queue, _input, signal) => {
      checkStarted?.();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { status: 'failed' };
    },
  });
  scheduler.start(host.signal);
  await started;
  host.abort();
  await scheduler.stop();
  expect(aborted).toBe(true);
  expect(getEventListeners(host.signal, 'abort')).toHaveLength(0);
});

it('finishes another site while the first is pending and keeps checks within each site sequential', async () => {
  await arm('a', 'first');
  await arm('b', 'second');
  await arm('c', 'first', 4, 1, 'opentable.com');
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const activeSites = new Set<string>();
  const overlap: string[] = [];
  const order: string[] = [];
  const scheduler = createBrowserWatchScheduler(queue, {
    policy: (site) => ({ ...watchSitePolicy(site), floorMs: 0 }),
    check: async (_queue, input) => {
      if (activeSites.has(input.site)) overlap.push(input.site);
      activeSites.add(input.site);
      order.push(`start:${input.site}`);
      if (input.site === 'resy.com' && order.length === 1) {
        started?.();
        await pending;
      }
      order.push(`finish:${input.site}`);
      activeSites.delete(input.site);
      const found = { ...availability(), site: input.site, slots: [] };
      return { status: 'ready', availability: found };
    },
    calendar: freeCalendar,
    random: () => 0.5,
  });
  const ticking = scheduler.tick();
  try {
    await firstStarted;
    await vi.waitFor(async () => {
      expect(
        await getDb().get('SELECT outcome,finished_at FROM gws_ea_browser_watch_checks WHERE site=?', 'opentable.com'),
      ).toEqual({ outcome: 'ready', finished_at: expect.any(String) });
    });
    expect(await getDb().get('SELECT finished_at FROM gws_ea_browser_watch_checks WHERE site=?', 'resy.com')).toEqual({
      finished_at: null,
    });
  } finally {
    release?.();
    await ticking;
  }
  expect(overlap).toEqual([]);
  expect(order).toEqual([
    'start:resy.com',
    'start:opentable.com',
    'finish:opentable.com',
    'finish:resy.com',
    'start:resy.com',
    'finish:resy.com',
  ]);
  expect(await getDb().all('SELECT id FROM gws_ea_browser_watch_checks')).toHaveLength(3);
});

it('limits concurrent site pipelines to four and starts the next site as soon as capacity frees', async () => {
  const sites = ['resy.com', 'opentable.com', 'exploretock.com', 'four.example', 'five.example'];
  for (const site of sites) await arm(site, 'same', 4, 1, site);
  const releases = new Map<string, () => void>();
  let concurrent = 0;
  let maximum = 0;
  let draining = false;
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async (_queue, input) => {
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      await new Promise<void>((resolve) => {
        releases.set(input.site, resolve);
        if (draining) resolve();
      });
      concurrent--;
      return { status: 'ready', availability: { ...availability(), site: input.site, slots: [] } };
    },
    calendar: freeCalendar,
    random: () => 0.5,
  });
  const ticking = scheduler.tick();
  try {
    await vi.waitFor(() => expect(releases.size).toBe(4));
    expect(await getDb().all('SELECT site FROM gws_ea_browser_watch_checks')).toHaveLength(4);
    releases.values().next().value?.();
    await vi.waitFor(() => expect(releases.size).toBe(5));
    expect(concurrent).toBe(4);
    expect(maximum).toBe(4);
  } finally {
    draining = true;
    for (const release of releases.values()) release();
    await ticking;
  }
  expect(await getDb().all("SELECT site FROM gws_ea_browser_watch_checks WHERE outcome='ready'")).toHaveLength(5);
});

it('shares exactly identical read-only checks, while different parties and versions consume the same site budget', async () => {
  await arm('a', 'same');
  await arm('b', 'same');
  await arm('c', 'different-party', 2);
  await arm('d', 'different-version', 4, 2);
  let checks = 0;
  const calendar = vi.fn(freeCalendar);
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async (_queue, input) => {
      checks++;
      return { status: 'ready', availability: availability(Number(input.parameters.party)) };
    },
    calendar,
    random: () => 0.5,
  });
  await scheduler.tick();
  expect(checks).toBe(1);
  expect(calendar).toHaveBeenCalledTimes(1);
  expect(await getDb().all('SELECT watch_id FROM gws_ea_browser_watch_notices ORDER BY watch_id')).toEqual([
    { watch_id: 'a' },
    { watch_id: 'b' },
  ]);
  expect(await getDb().all('SELECT id FROM gws_ea_browser_watch_checks')).toHaveLength(1);
  expect(await getDb().all('SELECT watch_id FROM gws_ea_browser_watch_check_members ORDER BY watch_id')).toEqual([
    { watch_id: 'a' },
    { watch_id: 'b' },
  ]);
  expect(await getDb().all("SELECT status FROM gws_ea_browser_watches WHERE id IN ('a','b')")).toEqual([
    { status: 'armed' },
    { status: 'armed' },
  ]);
  vi.setSystemTime(new Date('2026-10-15T12:01:01Z'));
  await scheduler.tick();
  expect(checks).toBe(2);
  vi.setSystemTime(new Date('2026-10-15T12:02:02Z'));
  await scheduler.tick();
  expect(checks).toBe(3);
  expect(calendar).toHaveBeenCalledTimes(3);
  expect(await getDb().all('SELECT watch_id FROM gws_ea_browser_watch_check_members ORDER BY watch_id')).toEqual([
    { watch_id: 'a' },
    { watch_id: 'b' },
    { watch_id: 'c' },
    { watch_id: 'd' },
  ]);
});
it('does not check pending setup cards and never consumes a booking claim after a failed calendar read', async () => {
  await arm('a', 'same');
  await arm('b', 'same');
  await arm('pending', 'pending');
  await getDb().run("UPDATE gws_ea_browser_watches SET status='awaiting_principal' WHERE id='pending'");
  const calendar = vi.fn(async () => {
    throw new Error('Calendar access failed');
  });
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => ({ status: 'ready', availability: availability() }),
    calendar,
    random: () => 0.5,
  });
  await scheduler.tick();
  expect(calendar).toHaveBeenCalledTimes(1);
  expect(await getDb().all('SELECT watch_id,outcome_json FROM gws_ea_browser_watch_notices ORDER BY watch_id')).toEqual(
    [
      { watch_id: 'a', outcome_json: expect.stringContaining('calendar_unavailable') },
      { watch_id: 'b', outcome_json: expect.stringContaining('calendar_unavailable') },
    ],
  );
  expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id=?', jobId)).toEqual({
    state: 'available',
  });
  expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'pending')).toEqual({
    status: 'awaiting_principal',
  });
});

it.each([
  ['arrival', { at: '2026-10-16T20:00:00Z' }],
  ['departure', { endAt: '2026-10-16T22:00:00Z' }],
] as const)('reads the calendar separately when only the slot %s changes', async (_name, change) => {
  await arm('a', 'same');
  await arm('b', 'same');
  const found = availability();
  found.slots.push({
    id: 'another-slot',
    reservation: { ...found.slots[0].reservation, ...change },
  });
  const calendar = vi.fn(freeCalendar);
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => ({ status: 'ready', availability: found }),
    calendar,
    random: () => 0.5,
  });
  await scheduler.tick();
  expect(calendar.mock.calls).toEqual(found.slots.map(({ reservation }) => [reservation.at, reservation.endAt]));
  expect(await getDb().all('SELECT watch_id FROM gws_ea_browser_watch_notices ORDER BY watch_id')).toEqual([
    { watch_id: 'a' },
    { watch_id: 'a' },
    { watch_id: 'b' },
    { watch_id: 'b' },
  ]);
});
it('backs off and halves budgets on the first block, waking blocked after three consecutive checks', async () => {
  await arm('a', 'same');
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => ({ status: 'blocked' }),
    calendar: freeCalendar,
    random: () => 0.5,
  });
  await scheduler.tick();
  expect(
    await getDb().get(
      'SELECT budget_scale,consecutive_blocks FROM gws_ea_browser_watch_site_state WHERE site=?',
      'resy.com',
    ),
  ).toEqual({ budget_scale: 0.5, consecutive_blocks: 1 });
  for (let i = 0; i < 2; i++) {
    const row = await getDb().get<{ next_check_at: string }>(
      'SELECT next_check_at FROM gws_ea_browser_watches WHERE id=?',
      'a',
    );
    vi.setSystemTime(new Date(row!.next_check_at));
    await scheduler.tick();
  }
  expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'a')).toEqual({ status: 'blocked' });
  expect(await getDb().all('SELECT outcome_json FROM gws_ea_browser_watch_notices')).toEqual([
    { outcome_json: expect.stringContaining('blocked') },
  ]);
});
it('deduplicates the same outside slot across ticks and reports expiry without another browser check', async () => {
  await arm('a', 'same');
  let checks = 0;
  const outside = availability();
  outside.slots[0].reservation.partySize = 2;
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => {
      checks++;
      return { status: 'ready', availability: outside };
    },
    calendar: freeCalendar,
    random: () => 0.5,
  });
  for (let i = 0; i < 3; i++) {
    await scheduler.tick();
    const row = await getDb().get<{ next_check_at: string }>(
      'SELECT next_check_at FROM gws_ea_browser_watches WHERE id=?',
      'a',
    );
    vi.setSystemTime(new Date(row!.next_check_at));
  }
  expect(await getDb().all('SELECT outcome_json FROM gws_ea_browser_watch_notices')).toHaveLength(1);
  vi.setSystemTime(new Date(bounds.until));
  await scheduler.tick();
  expect(checks).toBe(3);
  expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'a')).toEqual({ status: 'expired' });
});

it('keeps hourly and daily caps shared across parameters, and never repeats an interval or goes below the floor', async () => {
  await arm('a', 'same');
  const now = Date.now();
  const policy = { ...watchSitePolicy('resy.com'), principalQuietHours: [], hourlyCap: 2, dailyCap: 3 };
  for (const [id, minutes] of [
    ['one', 30],
    ['two', 15],
  ] as const)
    await getDb().run(
      "INSERT INTO gws_ea_browser_watch_checks(id,site,check_recipe_id,check_recipe_version,parameter_hash,trigger,scheduled_at,started_at,finished_at,outcome) VALUES(?,'resy.com','recipe',1,?,'timer',?,?,?,'ready')",
      id,
      id,
      new Date(now - minutes * 60_000).toISOString(),
      new Date(now - minutes * 60_000).toISOString(),
      new Date(now - minutes * 60_000).toISOString(),
    );
  let checks = 0;
  const empty = availability();
  empty.slots = [];
  const scheduler = createBrowserWatchScheduler(queue, {
    policy: () => policy,
    check: async () => {
      checks++;
      return { status: 'ready', availability: empty };
    },
    calendar: freeCalendar,
    random: () => 0.5,
  });
  await scheduler.tick();
  expect(checks).toBe(0);
  const next = (await getDb().get<{ next_check_at: string }>(
    'SELECT next_check_at FROM gws_ea_browser_watches WHERE id=?',
    'a',
  ))!;
  expect(Date.parse(next.next_check_at)).toBe(now + 30 * 60_000 + 1);
  vi.setSystemTime(new Date(next.next_check_at));
  await scheduler.tick();
  expect(checks).toBe(1);
  vi.setSystemTime(new Date(Date.now() + 60_001));
  await getDb().run('UPDATE gws_ea_browser_watches SET next_check_at=?', new Date().toISOString());
  await scheduler.tick();
  expect(checks).toBe(1);
  let previous: number | null = null;
  for (let i = 0; i < 20; i++) {
    const { interval } = nextWatchCheck(policy, {
      now,
      arrival: now + 60_000,
      releases: [],
      previous,
      random: () => 0,
    });
    expect(interval).toBeGreaterThanOrEqual(policy.floorMs);
    expect(interval).not.toBe(previous);
    previous = interval;
  }
});

function countingScheduler(policy?: (site: string) => WatchSitePolicy): {
  scheduler: ReturnType<typeof createBrowserWatchScheduler>;
  checks: () => number;
} {
  let checks = 0;
  const empty = availability();
  empty.slots = [];
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => {
      checks++;
      return { status: 'ready', availability: empty };
    },
    calendar: freeCalendar,
    random: () => 0.5,
    ...(policy ? { policy } : {}),
  });
  return { scheduler, checks: () => checks };
}
async function nextCheck(id: string): Promise<string | undefined> {
  return (
    await getDb().get<{ next_check_at: string }>('SELECT next_check_at FROM gws_ea_browser_watches WHERE id=?', id)
  )?.next_check_at;
}
async function seedPrincipal(timezone: string): Promise<void> {
  await getDb().run(
    "UPDATE gws_ea_profile SET principal_first_name = 'Morgan', principal_last_name = 'Ellery',principal_timezone = ? WHERE singleton = 1",
    timezone,
  );
}

it("checks through the principal's evening and pauses only for their night", async () => {
  await seedPrincipal('America/Los_Angeles');
  // 20:30 in Los Angeles, 03:30 UTC.
  vi.setSystemTime(new Date('2026-10-16T03:30:00Z'));
  await arm('a', 'same');
  const { scheduler, checks } = countingScheduler();
  await scheduler.tick();
  expect(checks()).toBe(1);
  // 03:30 to 05:59 in Los Angeles: no check until 06:00 there.
  for (const at of ['2026-10-16T10:30:00Z', '2026-10-16T12:59:00Z']) {
    vi.setSystemTime(new Date(at));
    await scheduler.tick();
    expect(checks()).toBe(1);
  }
  vi.setSystemTime(new Date('2026-10-16T13:00:00Z'));
  await scheduler.tick();
  expect(checks()).toBe(2);
});

it('applies a timezone the principal changes through main at once, whichever way it moves their night', async () => {
  await seedPrincipal('America/Los_Angeles');
  vi.setSystemTime(new Date('2026-10-16T03:30:00Z'));
  await arm('a', 'same');
  const { scheduler, checks } = countingScheduler();
  await scheduler.tick();
  expect(checks()).toBe(1);
  await setPrincipalNameAndTimezone({ timezone: 'Europe/London' });
  // Due at 03:32 UTC, which is 04:32 in London: quiet there until 06:00.
  vi.setSystemTime(new Date((await nextCheck('a'))!));
  await scheduler.tick();
  expect(checks()).toBe(1);
  vi.setSystemTime(new Date('2026-10-16T05:00:00Z'));
  await scheduler.tick();
  expect(checks()).toBe(2);
  // 03:30 in Los Angeles holds the due check until the principal moves to London, where it is 11:30.
  await setPrincipalNameAndTimezone({ timezone: 'America/Los_Angeles' });
  vi.setSystemTime(new Date('2026-10-16T10:30:00Z'));
  await scheduler.tick();
  expect(checks()).toBe(2);
  await setPrincipalNameAndTimezone({ timezone: 'Europe/London' });
  vi.setSystemTime(new Date('2026-10-16T10:31:00Z'));
  await scheduler.tick();
  expect(checks()).toBe(3);
});

it('skips only the site whose principal timezone read failed mid-tick, and checks it on the next tick', async () => {
  await seedPrincipal('America/Los_Angeles');
  // 20:30 in Los Angeles: no quiet hours stand in the way.
  vi.setSystemTime(new Date('2026-10-16T03:30:00Z'));
  await arm('a', 'same');
  await arm('b', 'same', 4, 1, 'opentable.com');
  const armedAt = new Date().toISOString();
  const read = vi.spyOn(profile, 'getGwsEaProfile');
  read.mockRejectedValueOnce(new Error('Profile unavailable'));
  const { scheduler, checks } = countingScheduler();
  await expect(scheduler.tick()).rejects.toThrow('Profile unavailable');
  // The other site was checked; the failed one reserved nothing and kept its schedule.
  expect(checks()).toBe(1);
  const untouched = await getDb().all<{ id: string; next_check_at: string }>(
    'SELECT id,next_check_at FROM gws_ea_browser_watches WHERE next_check_at=?',
    armedAt,
  );
  expect(untouched).toHaveLength(1);
  const skipped = untouched[0].id === 'a' ? 'resy.com' : 'opentable.com';
  expect(
    await getDb().get(
      'SELECT last_check_at FROM gws_ea_browser_watch_site_state WHERE site=? AND last_check_at IS NOT NULL',
      skipped,
    ),
  ).toBeUndefined();
  await scheduler.tick();
  expect(checks()).toBe(2);
  read.mockRestore();
});

it("reads quiet hours on the install's timezone until the profile holds the principal's", async () => {
  // 03:30 in New York, the install's zone.
  vi.setSystemTime(new Date('2026-10-16T07:30:00Z'));
  await arm('a', 'same');
  const { scheduler, checks } = countingScheduler();
  await scheduler.tick();
  expect(checks()).toBe(0);
  vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
  await scheduler.tick();
  expect(checks()).toBe(1);
});

it('uses an authenticated notify only once within the floor and site caps', async () => {
  await arm('a', 'same');
  let checks = 0;
  const empty = availability();
  empty.slots = [];
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => {
      checks++;
      return { status: 'ready', availability: empty };
    },
    calendar: freeCalendar,
    policy: () => ({ ...watchSitePolicy('resy.com'), notifySenders: ['notify@resy.com'] }),
    random: () => 0.5,
  });
  await scheduler.tick();
  expect(checks).toBe(1);
  const mail = parseGmailMessage({
    id: 'notify-message',
    threadId: 'notify-thread',
    payload: {
      headers: [
        {
          name: 'Authentication-Results',
          value: 'mx.google.com; dkim=pass header.i=@resy.com; dmarc=pass header.from=resy.com',
        },
        { name: 'From', value: 'notify@resy.com' },
      ],
    },
  });
  await scheduler.notify(mail);
  await scheduler.notify(mail);
  expect(await getDb().all('SELECT message_id FROM gws_ea_browser_watch_notify')).toHaveLength(1);
  await scheduler.tick();
  expect(checks).toBe(1);
  vi.setSystemTime(new Date(Date.now() + 60_001));
  await scheduler.tick();
  expect(checks).toBe(2);
  await scheduler.notify(mail);
  await scheduler.tick();
  expect(checks).toBe(2);
  expect(await getDb().all('SELECT outcome_json FROM gws_ea_browser_watch_notices')).toEqual([]);
});

// "Tables released 30 days ahead at 10:00" at a Tokyo venue, watched for dinner on 24 November, 40 days out.
const tokyoRelease: WatchReleaseRule = {
  schedule: { kind: 'days_ahead', days: 30 },
  time: '10:00',
  timeZone: 'Asia/Tokyo',
  wording: 'Tables released 30 days ahead at 10:00',
};
const armTokyoDinner = (id: string, site: string, release?: WatchReleaseRule): Promise<void> =>
  arm(id, id, 4, 1, site, {
    bounds: {
      windows: [{ start: '2026-11-24T10:00:00.000Z', end: '2026-11-24T12:00:00.000Z' }],
      until: '2026-11-24T00:00:00.000Z',
    },
    release,
  });
/** Ticks every five seconds through the principal's night of 25 October, around 10:00 in Tokyo. */
async function tickThroughRelease(scheduler: ReturnType<typeof createBrowserWatchScheduler>): Promise<void> {
  for (let at = Date.parse('2026-10-25T00:55:00Z'); at <= Date.parse('2026-10-25T01:30:00Z'); at += 5_000) {
    vi.setSystemTime(new Date(at));
    await scheduler.tick();
  }
}
async function checksStarted(site: string): Promise<string[]> {
  return (
    await getDb().all<{ started_at: string }>(
      'SELECT started_at FROM gws_ea_browser_watch_checks WHERE site=? AND started_at>? ORDER BY started_at',
      site,
      '2026-10-20T00:00:00Z',
    )
  ).map((row) => row.started_at);
}

it("checks a few seconds after the venue's release, at the floor through its burst and within the site's hourly cap, during the principal's night", async () => {
  // 01:00 UTC is 05:00 in Dubai, inside the principal's night, and 10:00 in Tokyo.
  await seedPrincipal('Asia/Dubai');
  await armTokyoDinner('release', 'resy.com', tokyoRelease);
  await armTokyoDinner('capped', 'exploretock.com', tokyoRelease);
  await armTokyoDinner('ordinary', 'opentable.com');
  const { scheduler, checks } = countingScheduler((site) => ({
    ...watchSitePolicy(site),
    ...(site === 'exploretock.com' ? { hourlyCap: 4 } : {}),
  }));
  await scheduler.tick();
  expect(checks()).toBe(3);
  await tickThroughRelease(scheduler);
  const started = await checksStarted('resy.com');
  expect(started[0]).toBe('2026-10-25T01:00:05.000Z');
  // At the floor, and only inside the burst; the night holds the rest until morning.
  for (let i = 1; i < started.length; i++) {
    const gap = Date.parse(started[i]) - Date.parse(started[i - 1]);
    expect(gap).toBeGreaterThanOrEqual(watchSitePolicy('resy.com').floorMs);
    expect(gap).toBeLessThan(watchSitePolicy('resy.com').floorMs + 10_000);
  }
  expect(started.length).toBeGreaterThanOrEqual(9);
  expect(started.at(-1)! < '2026-10-25T01:10:05.000Z').toBe(true);
  // On a site whose hourly cap is four, the burst runs four, and the cap sets the next: an hour after the first.
  const capped = await checksStarted('exploretock.com');
  expect(capped[0]).toBe('2026-10-25T01:00:05.000Z');
  expect(capped).toHaveLength(4);
  expect(Date.parse((await nextCheck('capped'))!)).toBe(Date.parse(capped[0]) + 3_600_000 + 1);
  // A watch without a rule keeps the ordinary cadence, which waits out the night.
  expect(await checksStarted('opentable.com')).toEqual([]);
}, 30_000);

/** A region watch on an unreviewed site, its slot list marked with `baseline` as its text. */
const armRegion = (id: string, baseline: string): Promise<void> =>
  arm(id, id, 4, 1, 'larder.example', {
    bounds: { kind: 'region', venue: { id: 'larder', name: 'The Larder' } },
    baseline,
  });
const regionWakes = (): number =>
  vi.mocked(requestWake).mock.calls.filter(([, reason]) => reason === 'browser-watch').length;
/** Runs the scheduler to its watch's next check, `checks` times. */
async function checkRegion(scheduler: ReturnType<typeof createBrowserWatchScheduler>, checks = 1): Promise<void> {
  for (let check = 0; check < checks; check++) {
    const row = await getDb().get<{ next_check_at: string }>('SELECT next_check_at FROM gws_ea_browser_watches');
    vi.setSystemTime(new Date(Math.max(Date.parse(row!.next_check_at), Date.now())));
    await scheduler.tick();
  }
}
const regionInterval = async (id: string): Promise<number> =>
  (Date.parse((await nextCheck(id))!) - Date.now()) / 60_000;

it('makes no model wakes over a simulated day for a watch on a static page', async () => {
  vi.mocked(requestWake).mockClear();
  const text = '- region "Available tables":\n  - paragraph: No tables';
  await armRegion('static', text);
  let reads = 0;
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => {
      reads++;
      return { status: 'region_read', text };
    },
    random: () => 0.5,
  });
  const end = Date.now() + 86_400_000;
  while (Date.now() < end) {
    await scheduler.tick();
    const row = await getDb().get<{ next_check_at: string }>('SELECT next_check_at FROM gws_ea_browser_watches');
    vi.setSystemTime(new Date(Math.max(Date.parse(row!.next_check_at), Date.now() + 60_000)));
  }
  // Checks ran all day within the site's daily cap; none woke the agent.
  expect(reads).toBeGreaterThan(100);
  expect(reads).toBeLessThanOrEqual(watchSitePolicy('larder.example').dailyCap);
  expect(await getDb().all('SELECT * FROM gws_ea_browser_watch_notices')).toEqual([]);
  expect(regionWakes()).toBe(0);
  expect(await getDb().get('SELECT status,region_baseline FROM gws_ea_browser_watches')).toEqual({
    status: 'armed',
    region_baseline: text,
  });
});

it('wakes the agent with each change and books nothing itself; a step toward a booking ends the slowdown', async () => {
  vi.mocked(requestWake).mockClear();
  await armRegion('changing', 'No tables');
  let text = 'No tables';
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => ({ status: 'region_read', text }),
    random: () => 0.5,
  });
  // A day and a half out, the cadence is four minutes; two changes that book nothing make it sixteen.
  for (const change of ['10:15 PM', '10:30 PM']) {
    text = change;
    await checkRegion(scheduler);
  }
  expect(regionWakes()).toBe(2);
  expect(await regionInterval('changing')).toBe(16);
  expect(
    (
      await getDb().all<{ outcome_json: string }>(
        'SELECT outcome_json FROM gws_ea_browser_watch_notices ORDER BY created_at',
      )
    ).map((notice) => (JSON.parse(notice.outcome_json) as { region: unknown }).region),
  ).toEqual([
    { untrusted: true, before: 'No tables', after: '10:15 PM' },
    { untrusted: true, before: '10:15 PM', after: '10:30 PM' },
  ]);
  // The host never books a region watch's change: no booking was queued, and the job's one claim is untouched.
  expect(await getDb().all("SELECT id FROM gws_ea_browser_requests WHERE action = 'browser_watch_book'")).toEqual([]);
  expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims')).toEqual({ state: 'available' });
  // The agent pursued the next change: a free commit's attempt is its match, and the cadence is back to four minutes.
  text = '7:30 PM';
  await checkRegion(scheduler);
  await getDb().run(
    "INSERT INTO gws_ea_browser_free_attempts(id,job_id,request_id,site,facts_json,attempted_at) VALUES('free',?,'free-request','larder.example','{}',?)",
    jobId,
    new Date(Date.now() + 1).toISOString(),
  );
  await checkRegion(scheduler);
  expect(regionWakes()).toBe(3);
  expect(await regionInterval('changing')).toBe(4);
});

it('holds a sixth change in an hour, keeping its baseline, until the hour allows its wake', async () => {
  vi.mocked(requestWake).mockClear();
  await armRegion('capped', 'No tables');
  let text = 'No tables';
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => ({ status: 'region_read', text }),
    random: () => 0.5,
  });
  /** One check of `next`, due now, ahead of the slowed cadence and the site's floor. */
  async function changeTo(next: string): Promise<void> {
    text = next;
    await getDb().run('UPDATE gws_ea_browser_watches SET next_check_at = ?', new Date().toISOString());
    await getDb().run('UPDATE gws_ea_browser_watch_site_state SET next_allowed_at = NULL,last_check_at = NULL');
    await scheduler.tick();
  }
  for (const change of ['10:15 PM', '10:30 PM', '10:45 PM', '4:00 PM', '4:30 PM']) await changeTo(change);
  expect(regionWakes()).toBe(5);
  await changeTo('4:45 PM');
  expect(regionWakes()).toBe(5);
  expect(await getDb().get('SELECT region_baseline FROM gws_ea_browser_watches')).toEqual({
    region_baseline: '4:30 PM',
  });
  vi.setSystemTime(Date.now() + 61 * 60_000);
  await changeTo('4:45 PM');
  expect(regionWakes()).toBe(6);
  const notices = await getDb().all<{ outcome_json: string }>(
    'SELECT outcome_json FROM gws_ea_browser_watch_notices ORDER BY created_at',
  );
  expect((JSON.parse(notices.at(-1)!.outcome_json) as { region: unknown }).region).toEqual({
    untrusted: true,
    before: '4:30 PM',
    after: '4:45 PM',
  });
});

it('wakes the agent once to mark the region again when two checks running miss it, and starts over when it is found', async () => {
  vi.mocked(requestWake).mockClear();
  await armRegion('missing', 'No tables');
  const reads: BrowserWatchCheckResult[] = [];
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => reads.shift() ?? { status: 'failed' },
    random: () => 0.5,
  });
  const missing: BrowserWatchCheckResult = { status: 'region_missing', reason: 'region_not_found' };
  reads.push(missing, missing, missing, { status: 'region_read', text: 'No tables' }, missing, missing);
  await checkRegion(scheduler, 1);
  expect(regionWakes()).toBe(0);
  await checkRegion(scheduler, 2);
  expect(regionWakes()).toBe(1);
  await checkRegion(scheduler, 3);
  const notices = await getDb().all<{ outcome_json: string }>(
    'SELECT outcome_json FROM gws_ea_browser_watch_notices ORDER BY created_at',
  );
  expect(notices.map((notice) => JSON.parse(notice.outcome_json) as Record<string, unknown>)).toEqual([
    expect.objectContaining({ status: 'region_missing', reason: 'region_not_found', watch_id: 'missing' }),
    expect.objectContaining({ status: 'region_missing', reason: 'region_not_found', watch_id: 'missing' }),
  ]);
  expect(regionWakes()).toBe(2);
  // A failed check is neither a read nor a miss: the absence stands, and nothing more wakes the agent.
  await checkRegion(scheduler);
  expect(await getDb().get('SELECT region_missing_since IS NOT NULL AS missing FROM gws_ea_browser_watches')).toEqual({
    missing: 1,
  });
  expect(regionWakes()).toBe(2);
});
