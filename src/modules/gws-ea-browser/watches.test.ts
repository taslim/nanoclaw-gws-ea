import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return `${tmpdir()}/browser-watch-tests`;
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { resolveSystemSession } from '../../session-manager.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore } from './db.js';
import { BrowserQueue } from './queue.js';
import { PurchaseAuthorityStore } from './authority.js';
import { browserWatchesMigration } from './migration.js';
import type { PurchaseFacts } from './fingerprint.js';
import {
  claimWatchBooking,
  compareWatchBounds,
  createBrowserWatch,
  finishWatchPurchase,
  prepareWatchPurchase,
  recoverBrowserWatches,
  type WatchBounds,
} from './watches.js';
import * as calendarFacts from '../gws-ea-meetings/calendar-facts.js';
import * as watchRuntime from './watch-runtime.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { handleApprovalsResponse, resumeApprovedApprovals } from '../approvals/response-handler.js';
import { saveBrowserRecipe } from './recipes.js';
import { cancelBrowserJob } from './cancel.js';

const bounds: WatchBounds = {
  site: 'resy.com',
  venue: { id: 'bistro', name: 'Bistro' },
  partySize: 4,
  windows: [{ start: '2026-10-16T19:00:00Z', end: '2026-10-16T21:00:00Z' }],
  financial: { freeOnly: true, currency: 'USD', maxTotalMinor: 0, maxDueNowMinor: 0 },
  until: '2026-10-16T18:00:00Z',
};
function freeFacts(): PurchaseFacts {
  return {
    flowId: 'reviewed-reservation',
    site: 'resy.com',
    origin: 'https://resy.com',
    control: { selector: 'button', label: 'Reserve', formAction: 'https://resy.com/reserve' },
    account: 'principal',
    items: [{ id: 'bistro', title: 'Bistro', quantity: 4 }],
    currency: 'USD',
    totalMinor: 0,
    dueNowMinor: 0,
    cardEnding: null,
    address: null,
    commitments: [],
    noCommitmentTerms: 'No deposit, cancellation or no-show fee.',
    reservation: {
      venueId: 'bistro',
      venueName: 'Bistro',
      partySize: 4,
      at: '2026-10-16T19:30:00Z',
      endAt: '2026-10-16T21:00:00Z',
      timeZone: 'UTC',
    },
  };
}
let jobId: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  await runMigrations(await initTestDb());
  if (!(await getDb().hasTable('gws_ea_browser_watches'))) await browserWatchesMigration.up(getDb());
  for (const id of ['watch-main', 'watch-browser'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
    'watch-main',
    'watch-browser',
  );
  const session = (await resolveSystemSession('watch-browser', 'system:a2a:watch-main:watch')).session;
  const job = await new BrowserStore().jobForSession(session);
  if (!job) throw new Error('Expected native browser job');
  jobId = job.id;
  const file = `${root}/browser/policy.json`;
  fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true }), { mode: 0o600 });
  process.env.GWS_EA_BROWSER_POLICY_FILE = file;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

async function executionContext(name: string) {
  const store = new BrowserStore();
  const job = (await store.getJob(jobId))!;
  const { getSession } = await import('../../db/sessions.js');
  const session = (await getSession(job.browser_session_id))!;
  await store.accept(job, session, name, 'purchase', {}, 90_000);
  const request = (await store.pending(jobId)).find((candidate) => candidate.request_id === name)!;
  await store.start(request.id);
  const queue = new BrowserQueue(store, {
    async pageForJob(): Promise<never> {
      throw new Error('Unexpected browser');
    },
    async connection(): Promise<never> {
      throw new Error('Unexpected browser');
    },
    async closeJob() {},
    onDisconnected: () => () => undefined,
  });
  return { queue, context: (await queue.contextForRequest(request.id))! };
}

async function seedWatch(id: string, site = 'resy.com'): Promise<void> {
  const at = '2026-10-15T12:00:00.000Z';
  await getDb().run(
    `INSERT INTO gws_ea_browser_watches
    (id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at)
    VALUES(?,?,?,'recipe',1,'{}',?,?, 'armed',?,?,?)`,
    id,
    jobId,
    site,
    id,
    JSON.stringify({ ...bounds, site }),
    at,
    at,
    at,
  );
  await getDb().run(
    "INSERT INTO gws_ea_browser_watch_job_claims(job_id,state) VALUES(?,'available') ON CONFLICT(job_id) DO NOTHING",
    jobId,
  );
}

describe('native watch bounds and one booking claim', () => {
  it('requires exact venue, party, slot and explicit free merchant facts', () => {
    const facts = freeFacts();
    expect(compareWatchBounds(bounds, facts, '2026-10-15T12:00:00Z')).toEqual({ status: 'within_bounds' });
    expect(compareWatchBounds(bounds, { ...facts, noCommitmentTerms: undefined }, '2026-10-15T12:00:00Z').status).toBe(
      'outside_bounds',
    );
    for (const reservation of [
      { ...facts.reservation!, venueId: 'other' },
      { ...facts.reservation!, partySize: 2 },
      { ...facts.reservation!, at: '2026-10-16T22:00:00Z' },
    ])
      expect(compareWatchBounds(bounds, { ...facts, reservation }, '2026-10-15T12:00:00Z').status).toBe(
        'outside_bounds',
      );
    expect(compareWatchBounds(bounds, facts, bounds.until).status).toBe('outside_bounds');
  });
  it('conditionally claims once across sites before any press, including genuinely free bookings', async () => {
    await seedWatch('friday');
    await seedWatch('saturday', 'other.example');
    const facts = freeFacts();
    const input = {
      watchId: 'friday',
      jobId,
      authorityId: 'authority',
      attemptId: 'attempt',
      requestId: 'request',
      facts,
      calendarCheckedReservation: facts.reservation!,
      at: '2026-10-15T12:00:00Z',
    };
    await getDb().transaction(() => claimWatchBooking(getDb(), input));
    expect(
      await getDb().get('SELECT state,watch_id FROM gws_ea_browser_watch_job_claims WHERE job_id = ?', jobId),
    ).toEqual({ state: 'committing', watch_id: 'friday' });
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id = ?', 'friday')).toEqual({
      status: 'booking',
    });
    const otherFacts = { ...facts, site: 'other.example', origin: 'https://other.example' };
    await expect(
      getDb().transaction(() =>
        claimWatchBooking(getDb(), {
          ...input,
          watchId: 'saturday',
          facts: otherFacts,
          calendarCheckedReservation: otherFacts.reservation!,
        }),
      ),
    ).rejects.toThrow('already claimed');
    await finishWatchPurchase(getDb(), 'friday', 'attempt', { status: 'booked' });
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id = ?', 'saturday')).toEqual({
      status: 'cancelled',
    });
  });
  it('rejects slot drift after the calendar read without consuming the shared claim', async () => {
    await seedWatch('friday');
    const facts = freeFacts();
    await expect(
      getDb().transaction(() =>
        claimWatchBooking(getDb(), {
          watchId: 'friday',
          jobId,
          authorityId: 'authority',
          attemptId: 'attempt',
          requestId: 'request',
          facts,
          calendarCheckedReservation: { ...facts.reservation!, at: '2026-10-16T20:00:00Z' },
          at: '2026-10-15T12:00:00Z',
        }),
      ),
    ).rejects.toThrow();
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id = ?', jobId)).toEqual({
      state: 'available',
    });
  });
  it('creates a native free-watch authority and joins its claim, request marker and conclusion', async () => {
    await seedWatch('friday');
    await seedWatch('saturday', 'other.example');
    const facts = freeFacts();
    const store = new BrowserStore();
    const job = (await store.getJob(jobId))!;
    const { getSession } = await import('../../db/sessions.js');
    const session = (await getSession(job.browser_session_id))!;
    await store.accept(job, session, 'native-commit', 'purchase', {}, 90_000);
    const request = (await store.pending(jobId))[0];
    await store.start(request.id);
    const queue = new BrowserQueue(store, {
      async pageForJob(): Promise<never> {
        throw new Error('No DOM in authority test');
      },
      async connection(): Promise<never> {
        throw new Error('No DOM in authority test');
      },
      async closeJob() {},
      onDisconnected: () => () => undefined,
    });
    const context = (await queue.contextForRequest(request.id))!;
    const authorityStore = new PurchaseAuthorityStore();
    const authority = await authorityStore.create({
      id: 'free-watch',
      jobId,
      kind: 'watch',
      watchId: 'friday',
      facts,
      bounds: {
        reservation: {
          venueId: 'bistro',
          partySize: 4,
          windowStart: bounds.windows[0].start,
          windowEnd: bounds.windows[0].end,
        },
      },
      attemptId: 'native-attempt',
      expiresAt: bounds.until,
    });
    await getDb().run(
      "INSERT INTO gws_ea_browser_site_leases VALUES('resy.com',?,'active',?)",
      jobId,
      new Date().toISOString(),
    );
    await queue.withJobLock(jobId, () =>
      authorityStore.begin(context, authority.id, facts, (db, accepted, current) =>
        claimWatchBooking(db, {
          watchId: 'friday',
          jobId,
          authorityId: accepted.id,
          attemptId: accepted.attempt_id,
          requestId: request.id,
          facts: current,
          calendarCheckedReservation: facts.reservation!,
          at: new Date().toISOString(),
        }),
      ),
    );
    expect(await store.request(request.id)).toMatchObject({ commit_started_at: expect.any(String) });
    expect(await authorityStore.get(authority.id)).toMatchObject({ state: 'committing' });
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'friday')).toEqual({
      status: 'booking',
    });
    expect(await cancelBrowserJob(jobId)).toMatchObject({ status: 'in_progress' });
    await authorityStore.conclude(
      authority.id,
      { status: 'booked', evidence: { recordId: 'reservation-1', account: 'principal' } },
      true,
    );
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'friday')).toEqual({
      status: 'booked',
    });
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'saturday')).toEqual({
      status: 'cancelled',
    });
  });
  it('refuses invented, foreign-job and financial watch grants without a principal approval', async () => {
    await seedWatch('friday');
    const store = new PurchaseAuthorityStore();
    const facts = freeFacts();
    const base = {
      jobId,
      kind: 'watch' as const,
      watchId: 'missing',
      facts,
      bounds: {
        reservation: {
          venueId: 'bistro',
          partySize: 4,
          windowStart: bounds.windows[0].start,
          windowEnd: bounds.windows[0].end,
        },
      },
      expiresAt: bounds.until,
    };
    await expect(store.create({ ...base, id: 'invented', attemptId: 'invented' })).rejects.toThrow();
    await expect(
      store.create({ ...base, watchId: 'friday', jobId: 'other-job', id: 'foreign', attemptId: 'foreign' }),
    ).rejects.toThrow();
    const financial = {
      ...facts,
      totalMinor: 5000,
      dueNowMinor: 0,
      cardEnding: '4242',
      address: 'Billing address',
      noCommitmentTerms: undefined,
      commitments: [
        {
          kind: 'conditional_fee' as const,
          terms: '$50 no-show fee',
          amountMinor: 5000,
          trigger: 'No show',
          conditionalTrigger: 'no_show' as const,
          cancellationDeadline: '2026-10-15T19:30:00Z',
          cancellationTerms: 'Cancel 24 hours before arrival',
        },
      ],
    };
    await expect(
      store.create({ ...base, watchId: 'friday', facts: financial, id: 'financial', attemptId: 'financial' }),
    ).rejects.toThrow();
    expect(await getDb().all('SELECT * FROM gws_ea_browser_authorities')).toEqual([]);
  });
  it('does not create authority or consume the claim when a job-driven hit cannot read the calendar', async () => {
    await seedWatch('friday');
    const { context } = await executionContext('calendar-failed');
    vi.spyOn(calendarFacts, 'findPrincipalCalendarConflicts').mockRejectedValue(new Error('No calendar access'));
    expect(await prepareWatchPurchase(context, freeFacts())).toEqual({
      status: 'calendar_unavailable',
      watchId: 'friday',
    });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_authorities')).toEqual([]);
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id=?', jobId)).toEqual({
      state: 'available',
    });
  });
  it('refreshes an unspent child authority when a later hit moves to another approved window', async () => {
    await seedWatch('friday');
    const laterWindow = { start: '2026-10-17T19:00:00Z', end: '2026-10-17T21:00:00Z' };
    await getDb().run(
      'UPDATE gws_ea_browser_watches SET bounds_json=? WHERE id=?',
      JSON.stringify({ ...bounds, windows: [...bounds.windows, laterWindow] }),
      'friday',
    );
    vi.spyOn(calendarFacts, 'findPrincipalCalendarConflicts').mockResolvedValue({
      conflicts: [],
      conflicts_not_listed: 0,
      message: 'Free',
    });
    const first = await prepareWatchPurchase((await executionContext('first-hit')).context, freeFacts());
    expect(first?.status).toBe('ready');
    if (first?.status !== 'ready') throw new Error('Expected first authority');
    const laterFacts = {
      ...freeFacts(),
      reservation: { ...freeFacts().reservation!, at: '2026-10-17T19:30:00Z', endAt: '2026-10-17T21:00:00Z' },
    };
    const later = await prepareWatchPurchase((await executionContext('later-hit')).context, laterFacts);
    expect(later?.status).toBe('ready');
    if (later?.status !== 'ready') throw new Error('Expected later authority');
    expect(later.authorityId).not.toBe(first.authorityId);
    const authorities = new PurchaseAuthorityStore();
    expect(await authorities.get(first.authorityId)).toMatchObject({ state: 'revoked' });
    expect(await authorities.get(later.authorityId)).toMatchObject({
      state: 'live',
      facts_json: JSON.stringify(laterFacts),
    });
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id=?', jobId)).toEqual({
      state: 'available',
    });
    expect(await prepareWatchPurchase((await executionContext('same-hit')).context, laterFacts)).toEqual(later);
  });
  it('re-arms preparation before the marker, but recovers a marked attempt as unknown and site-blocked', async () => {
    await seedWatch('friday');
    await getDb().run("UPDATE gws_ea_browser_watches SET status='preparing' WHERE id='friday'");
    const { queue, context } = await executionContext('recovery');
    await recoverBrowserWatches(queue);
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'friday')).toEqual({
      status: 'armed',
    });
    const facts = freeFacts();
    const store = new PurchaseAuthorityStore();
    const authority = await store.create({
      id: 'restart-authority',
      jobId,
      kind: 'watch',
      watchId: 'friday',
      facts,
      bounds: {
        reservation: {
          venueId: 'bistro',
          partySize: 4,
          windowStart: bounds.windows[0].start,
          windowEnd: bounds.windows[0].end,
        },
      },
      attemptId: 'restart-attempt',
      expiresAt: bounds.until,
    });
    await getDb().run(
      "INSERT INTO gws_ea_browser_site_leases VALUES('resy.com',?,'active',?)",
      jobId,
      new Date().toISOString(),
    );
    await store.begin(context, authority.id, facts, (db, current, latest) =>
      claimWatchBooking(db, {
        watchId: 'friday',
        jobId,
        authorityId: current.id,
        attemptId: current.attempt_id,
        requestId: context.request.id,
        facts: latest,
        calendarCheckedReservation: facts.reservation!,
        at: new Date().toISOString(),
      }),
    );
    await queue.start();
    expect(await store.get(authority.id)).toMatchObject({ state: 'unknown' });
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'friday')).toEqual({
      status: 'outcome_unknown',
    });
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id=?', jobId)).toEqual({
      state: 'unknown',
    });
    expect(await getDb().get('SELECT site FROM gws_ea_browser_purchase_blocks WHERE site=?', 'resy.com')).toEqual({
      site: 'resy.com',
    });
    await queue.stop();
  });
  it('arms a financial watch only through its native principal card, with restart-safe replay and exact host policy', async () => {
    const principal = 'gchat:users/watch-principal';
    const at = new Date().toISOString();
    await createMessagingGroup({
      id: 'watch-dm',
      channel_type: 'gchat',
      platform_id: 'spaces/watch-principal',
      name: 'Principal',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: at,
    });
    await upsertUser({ id: principal, kind: 'gchat', display_name: 'Principal', created_at: at });
    await upsertUserDm({ user_id: principal, channel_type: 'gchat', messaging_group_id: 'watch-dm', resolved_at: at });
    await bindVerifiedPrincipalUser(principal, at);
    const cards: string[] = [];
    setDeliveryAdapter({
      async deliver(_type, _platform, _thread, _kind, content) {
        cards.push(content);
        return `watch-card-${cards.length}`;
      },
    });
    const { context } = await executionContext('setup');
    const terms = '$12.50 per guest for cancellation within 24 hours or no-show';
    vi.spyOn(watchRuntime, 'readBrowserWatchSetup').mockResolvedValue({
      availability: {
        status: 'ready',
        site: 'resy.com',
        venue: bounds.venue,
        partySize: 4,
        currency: 'USD',
        timeZone: 'UTC',
        slots: [],
      },
      policy: {
        currency: 'USD',
        dueNowMinor: 0,
        commitments: [
          {
            kind: 'conditional_fee',
            terms,
            amountMinor: 1250,
            perPerson: true,
            trigger: 'Late cancellation or no-show',
            conditionalTrigger: 'cancellation',
            cancellationTerms: 'Cancel at least 24 hours before arrival',
            cancellationBeforeMs: 86_400_000,
          },
        ],
      },
    });
    const result = await createBrowserWatch(context, {
      site: 'https://resy.com/search',
      recipe_id: 'check-recipe',
      parameters: {},
      venue: bounds.venue,
      party_size: 4,
      windows: bounds.windows,
      financial: { currency: 'USD', max_total: '50.00', terms },
      until: bounds.until,
    });
    expect(result).toMatchObject({ status: 'refused', reason: 'read_only_recipe_required' });
    await getDb().run(
      "INSERT INTO gws_ea_browser_recipes(id,site,name,version,source_job_id,first_action,last_action,parameters_json,steps_json,read_only,created_at) VALUES('check-recipe','resy.com','Availability',1,?,0,0,'[]','[]',1,?)",
      jobId,
      at,
    );
    const pending = await createBrowserWatch(context, {
      site: 'https://resy.com/search',
      recipe_id: 'check-recipe',
      parameters: {},
      venue: bounds.venue,
      party_size: 4,
      windows: bounds.windows,
      financial: { currency: 'USD', max_total: '50.00', terms },
      until: bounds.until,
    });
    expect(pending).toMatchObject({ status: 'awaiting_principal' });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain('Bistro');
    expect(cards[0]).toContain('$50.00');
    expect(cards[0]).toContain(terms);
    const approval = (
      await getDb().all<import('../../types.js').PendingApproval>(
        "SELECT * FROM pending_approvals WHERE action='browser_watch_setup'",
      )
    )[0];
    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value: 'approve',
      userId: 'gchat:users/operator',
      channelType: 'gchat',
      platformId: 'spaces/watch-principal',
      threadId: null,
    });
    expect(
      await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', pending.watch_id as string),
    ).toEqual({ status: 'awaiting_principal' });
    await getDb().run("UPDATE pending_approvals SET status='approved' WHERE approval_id=?", approval.approval_id);
    await resumeApprovedApprovals();
    expect(
      await getDb().get('SELECT status,approval_id FROM gws_ea_browser_watches WHERE id=?', pending.watch_id as string),
    ).toEqual({ status: 'armed', approval_id: approval.approval_id });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_authorities')).toEqual([]);
    await createBrowserWatch(context, {
      site: 'https://resy.com/search',
      recipe_id: 'check-recipe',
      parameters: {},
      venue: bounds.venue,
      party_size: 4,
      windows: bounds.windows,
      financial: { currency: 'USD', max_total: '50.00', terms },
      until: bounds.until,
    });
    expect(cards).toHaveLength(1);
  });
  it('promotes only the recorded booking path present at the verified commit, not a later same-site save', async () => {
    await seedWatch('friday');
    const facts = freeFacts();
    const step = {
      action: { kind: 'click', ref: 'e1', generation: 1 },
      targets: [
        {
          role: 'button',
          name: 'Reserve',
          ordinal: 0,
          count: 1,
          framePath: [],
          frameUrls: ['https://resy.com/venue/bistro'],
        },
      ],
      before: { url: 'https://resy.com/venue/bistro' },
      after: { url: 'https://resy.com/venue/bistro' },
      readOnly: false,
      stopReason: 'purchase_control',
    };
    await getDb().run(
      'INSERT INTO gws_ea_browser_action_trace VALUES(?,?,?,?,?)',
      jobId,
      0,
      'preparation',
      JSON.stringify(step),
      new Date().toISOString(),
    );
    const { context } = await executionContext('verified-path');
    const saved = await saveBrowserRecipe(context, { name: 'Book', first_action: 0, last_action: 0, parameters: [] });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_watch_recipe_links')).toEqual([]);
    const store = new PurchaseAuthorityStore();
    const authority = await store.create({
      id: 'recipe-authority',
      jobId,
      kind: 'watch',
      watchId: 'friday',
      facts,
      bounds: {
        reservation: {
          venueId: 'bistro',
          partySize: 4,
          windowStart: bounds.windows[0].start,
          windowEnd: bounds.windows[0].end,
        },
      },
      attemptId: 'recipe-attempt',
      expiresAt: bounds.until,
    });
    await getDb().run(
      "INSERT INTO gws_ea_browser_site_leases VALUES('resy.com',?,'active',?)",
      jobId,
      new Date().toISOString(),
    );
    await store.begin(context, authority.id, facts, (db, current, latest) =>
      claimWatchBooking(db, {
        watchId: 'friday',
        jobId,
        authorityId: current.id,
        attemptId: current.attempt_id,
        requestId: context.request.id,
        facts: latest,
        calendarCheckedReservation: facts.reservation!,
        at: new Date().toISOString(),
      }),
    );
    await store.conclude(
      authority.id,
      { status: 'booked', evidence: { recordId: 'reservation-recipe', account: 'principal' } },
      true,
    );
    expect(
      await getDb().all('SELECT booking_recipe_id,source_attempt_id FROM gws_ea_browser_watch_recipe_links'),
    ).toEqual([{ booking_recipe_id: saved.recipe_id, source_attempt_id: 'recipe-attempt' }]);
    await getDb().run(
      'INSERT INTO gws_ea_browser_action_trace VALUES(?,?,?,?,?)',
      jobId,
      1,
      'later-preparation',
      JSON.stringify(step),
      new Date().toISOString(),
    );
    await saveBrowserRecipe(context, { name: 'Different path', first_action: 1, last_action: 1, parameters: [] });
    expect(await getDb().all('SELECT booking_recipe_id FROM gws_ea_browser_watch_recipe_links')).toEqual([
      { booking_recipe_id: saved.recipe_id },
    ]);
  });
  it('does not let two jobs consume the same shared slot under different venue display spellings', async () => {
    await seedWatch('first');
    const facts = freeFacts();
    const firstJob = jobId;
    await getDb().transaction(() =>
      claimWatchBooking(getDb(), {
        watchId: 'first',
        jobId: firstJob,
        authorityId: 'first-authority',
        attemptId: 'first-attempt',
        requestId: 'first-request',
        facts,
        calendarCheckedReservation: facts.reservation!,
        at: '2026-10-15T12:00:00Z',
      }),
    );
    const session = (await resolveSystemSession('watch-browser', 'system:a2a:watch-main:second')).session;
    jobId = (await new BrowserStore().jobForSession(session))!.id;
    await seedWatch('second');
    await getDb().run(
      'UPDATE gws_ea_browser_watches SET bounds_json=? WHERE id=?',
      JSON.stringify({ ...bounds, venue: { id: 'bistro', name: 'BISTRO' } }),
      'second',
    );
    const otherFacts = { ...facts, reservation: { ...facts.reservation!, venueName: 'BISTRO' } };
    await expect(
      getDb().transaction(() =>
        claimWatchBooking(getDb(), {
          watchId: 'second',
          jobId,
          authorityId: 'second-authority',
          attemptId: 'second-attempt',
          requestId: 'second-request',
          facts: otherFacts,
          calendarCheckedReservation: otherFacts.reservation,
          at: '2026-10-15T12:00:00Z',
        }),
      ),
    ).rejects.toThrow();
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id=?', jobId)).toEqual({
      state: 'available',
    });
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'second')).toEqual({
      status: 'armed',
    });
  });
});
