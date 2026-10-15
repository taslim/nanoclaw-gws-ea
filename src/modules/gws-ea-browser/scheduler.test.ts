import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return `${tmpdir()}/browser-scheduler-tests`;
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { resolveSystemSession } from '../../session-manager.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore } from './db.js';
import { BrowserQueue } from './queue.js';
import { browserWatchesMigration } from './migration.js';
import { createBrowserWatchScheduler } from './scheduler.js';
import type { WatchBounds } from './watches.js';
import type { ReservationAvailability } from './merchant-contract.js';
import { watchInterval, watchQuietUntil, watchSitePolicy } from './watch-policy.js';
import { parseGmailMessage } from '../gws-ea-inbox/mime.js';

let queue: BrowserQueue;
let jobId: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  await runMigrations(await initTestDb());
  if (!(await getDb().hasTable('gws_ea_browser_watches'))) await browserWatchesMigration.up(getDb());
  for (const id of ['scheduler-main', 'scheduler-browser'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id = ?,browser_agent_group_id = ? WHERE singleton = 1',
    'scheduler-main',
    'scheduler-browser',
  );
  const session = (await resolveSystemSession('scheduler-browser', 'system:a2a:scheduler-main:job')).session;
  const store = new BrowserStore();
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Missing job');
  jobId = job.id;
  queue = new BrowserQueue(store, {
    async pageForJob(): Promise<never> {
      throw new Error('Unexpected signed-in browser');
    },
    async connection(): Promise<never> {
      throw new Error('Unexpected browser');
    },
    async closeJob() {},
    onDisconnected: () => () => undefined,
  });
  const file = `${root}/browser/policy.json`;
  fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }), { mode: 0o600 });
  process.env.GWS_EA_BROWSER_POLICY_FILE = file;
});
afterEach(async () => {
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
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
async function arm(id: string, key: string, party = 4, version = 1): Promise<void> {
  const at = new Date().toISOString();
  await getDb().run(
    `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at) VALUES(?,?,'resy.com','recipe',?,?,?,?,'armed',?,?,?)`,
    id,
    jobId,
    version,
    JSON.stringify({ party: String(party) }),
    key,
    JSON.stringify({ ...bounds, partySize: party }),
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

it('shares exactly identical read-only checks, while different parties and versions consume the same site budget', async () => {
  await arm('a', 'same');
  await arm('b', 'same');
  await arm('c', 'different-party', 2);
  await arm('d', 'different-version', 4, 2);
  let checks = 0;
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async (_queue, input) => {
      checks++;
      return { status: 'ready', availability: availability(Number(input.parameters.party)) };
    },
    calendar: freeCalendar,
    random: () => 0.5,
  });
  await scheduler.tick();
  expect(checks).toBe(1);
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
  expect(await getDb().all('SELECT watch_id FROM gws_ea_browser_watch_check_members ORDER BY watch_id')).toEqual([
    { watch_id: 'a' },
    { watch_id: 'b' },
    { watch_id: 'c' },
    { watch_id: 'd' },
  ]);
});
it('does not check pending setup cards and never consumes a booking claim after a failed calendar read', async () => {
  await arm('a', 'same');
  await arm('pending', 'pending');
  await getDb().run("UPDATE gws_ea_browser_watches SET status='awaiting_principal' WHERE id='pending'");
  const scheduler = createBrowserWatchScheduler(queue, {
    check: async () => ({ status: 'ready', availability: availability() }),
    calendar: async () => {
      throw new Error('Calendar access failed');
    },
    random: () => 0.5,
  });
  await scheduler.tick();
  expect(await getDb().all('SELECT outcome_json FROM gws_ea_browser_watch_notices')).toEqual([
    { outcome_json: expect.stringContaining('calendar_unavailable') },
  ]);
  expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id=?', jobId)).toEqual({
    state: 'available',
  });
  expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'pending')).toEqual({
    status: 'awaiting_principal',
  });
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
  const policy = { ...watchSitePolicy('resy.com'), quietHours: [], hourlyCap: 2, dailyCap: 3 };
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
    const interval = watchInterval(policy, now, now + 60_000, previous, () => 0);
    expect(interval).toBeGreaterThanOrEqual(policy.floorMs);
    expect(interval).not.toBe(previous);
    previous = interval;
  }
  expect(watchQuietUntil({ ...policy, quietHours: [{ start: 3, end: 6 }] }, Date.parse('2026-10-15T03:15:00Z'))).toBe(
    Date.parse('2026-10-15T06:00:00Z'),
  );
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
