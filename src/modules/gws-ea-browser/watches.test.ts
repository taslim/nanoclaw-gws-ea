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
import { ERRAND_ORIGIN_LINE } from './cards.js';
import { browserWatchesMigration } from './migration.js';
import { GENERIC_FLOW_ID, type PurchaseFacts } from './fingerprint.js';
import {
  claimRegionWatchCommit,
  claimWatchBooking,
  compareWatchBounds,
  createBrowserWatch,
  finishWatchCommit,
  finishWatchPurchase,
  getBrowserWatch,
  prepareWatchPurchase,
  recoverBrowserWatches,
  renderWatchCard,
  validateWatchRequest,
  type WatchBounds,
  type WatchRow,
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

async function bindPrincipal(): Promise<string[]> {
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
  return cards;
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
    await finishWatchPurchase(getDb(), 'friday', 'attempt', true, 'page');
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
    await authorityStore.resolve(authority.attempt_id, {
      placed: true,
      source: 'page',
      evidence: { recordId: 'reservation-1' },
      record: { id: 'reservation-1', account: 'principal' },
      outcome: { status: 'booked' },
    });
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
    const at = new Date().toISOString();
    const cards = await bindPrincipal();
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
    // The card names the errand in the principal's words, never its internal thread (KTD18).
    expect(approval.question.endsWith(`\n\n${ERRAND_ORIGIN_LINE}`)).toBe(true);
    expect(approval.question).not.toContain(jobId);
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
    await store.resolve(authority.attempt_id, {
      placed: true,
      source: 'page',
      evidence: { recordId: 'reservation-recipe' },
      record: { id: 'reservation-recipe', account: 'principal' },
      outcome: { status: 'booked' },
    });
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

describe('venue release schedules and card times', () => {
  const free = {
    site: 'https://resy.com/search',
    recipe_id: 'check-recipe',
    parameters: {},
    venue: bounds.venue,
    party_size: 4,
    windows: bounds.windows,
    financial: { currency: 'USD', max_total: '0', terms: 'Nothing due' },
    until: bounds.until,
  };
  it('reads a release rule apart from the bounds and refuses one it could not schedule', () => {
    const wording = 'Tables released 30 days ahead at 10:00';
    expect(validateWatchRequest({ ...free, release: { days_ahead: 30, time: '10:00', wording } })).toMatchObject({
      release: { schedule: { kind: 'days_ahead', days: 30 }, time: '10:00', wording },
    });
    expect(
      validateWatchRequest({
        ...free,
        release: { day_of_month: 1, months_ahead: 1, time: '12:00', wording, time_zone: 'europe/paris' },
      }).release,
    ).toEqual({
      schedule: { kind: 'monthly', day: 1, monthsAhead: 1 },
      time: '12:00',
      wording,
      timeZone: 'Europe/Paris',
    });
    for (const time_zone of ['Mars/Olympus', '+09:00', 'JST-9'])
      expect(() =>
        validateWatchRequest({ ...free, release: { days_ahead: 30, time: '10:00', wording, time_zone } }),
      ).toThrow('IANA');
    for (const release of [
      { days_ahead: 30, day_of_month: 1, months_ahead: 1, time: '10:00', wording },
      { day_of_month: 1, time: '10:00', wording },
      { time: '10:00', wording },
      { days_ahead: -1, time: '10:00', wording },
      { days_ahead: 30, time: '24:00', wording },
      { days_ahead: 30, time: '9:00', wording },
      { days_ahead: 30, time: '10:00', wording: ' ' },
      { days_ahead: 30, time: '10:00' },
      { days_ahead: 30, time: '10:00', wording, until: bounds.until },
      'Tables released 30 days ahead at 10:00',
    ])
      expect(() => validateWatchRequest({ ...free, release })).toThrow();
  });

  it("stores the rule once, on the venue's clock as the host reads it, outside the bounds the principal approves", async () => {
    await getDb().run(
      "UPDATE gws_ea_profile SET principal_display_name = 'Morgan Ellery',principal_timezone = 'America/Los_Angeles' WHERE singleton = 1",
    );
    const cards = await bindPrincipal();
    const { context } = await executionContext('release-setup');
    await getDb().run(
      "INSERT INTO gws_ea_browser_recipes(id,site,name,version,source_job_id,first_action,last_action,parameters_json,steps_json,read_only,created_at) VALUES('check-recipe','resy.com','Availability',1,?,0,0,'[]','[]',1,?)",
      jobId,
      new Date().toISOString(),
    );
    const terms = '¥5,000 per guest for cancellation within 24 hours or no-show';
    vi.spyOn(watchRuntime, 'readBrowserWatchSetup').mockResolvedValue({
      availability: {
        status: 'ready',
        site: 'resy.com',
        venue: bounds.venue,
        partySize: 4,
        currency: 'JPY',
        timeZone: 'Asia/Tokyo',
        slots: [],
      },
      policy: {
        currency: 'JPY',
        dueNowMinor: 0,
        commitments: [
          {
            kind: 'conditional_fee',
            terms,
            amountMinor: 5000,
            perPerson: true,
            trigger: 'Late cancellation or no-show',
            conditionalTrigger: 'cancellation',
            cancellationTerms: 'Cancel at least 24 hours before arrival',
            cancellationBeforeMs: 86_400_000,
          },
        ],
      },
    });
    const request = {
      ...free,
      windows: [{ start: '2026-11-24T19:00:00+09:00', end: '2026-11-24T21:00:00+09:00' }],
      financial: { currency: 'JPY', max_total: '20000', terms },
      until: '2026-11-24T00:00:00Z',
    };
    const created = await createBrowserWatch(context, {
      ...request,
      // The host's own read of the venue's zone outranks the agent's.
      release: {
        days_ahead: 30,
        time: '10:00',
        wording: 'Tables released 30 days ahead at 10:00',
        time_zone: 'Asia/Seoul',
      },
    });
    expect(created).toMatchObject({ status: 'awaiting_principal' });
    const id = created.watch_id as string;
    const stored = {
      schedule: { kind: 'days_ahead', days: 30 },
      time: '10:00',
      timeZone: 'Asia/Tokyo',
      wording: 'Tables released 30 days ahead at 10:00',
    };
    const watch = (await getBrowserWatch(id))!;
    expect(JSON.parse(watch.release_json!)).toEqual(stored);
    const approval = (
      await getDb().all<import('../../types.js').PendingApproval>(
        "SELECT * FROM pending_approvals WHERE action='browser_watch_setup'",
      )
    )[0];
    const approved = JSON.parse(approval.payload) as { bounds: WatchBounds };
    expect(approved.bounds).toEqual(JSON.parse(watch.bounds_json));
    expect(JSON.stringify(approved)).not.toContain('release');
    expect(cards[0]).toContain(
      'Arrival window: Nov 24, 2026, 7:00 PM through 9:00 PM Tokyo time (Nov 24, 2026, 2:00 AM through 4:00 AM Los Angeles time)',
    );
    expect(cards[0]).toContain('Watch deadline: Nov 23, 2026, 4:00 PM Los Angeles time');
    // A repeat of the request cannot change the rule, nor can the principal's approval.
    await createBrowserWatch(context, {
      ...request,
      release: { day_of_month: 1, months_ahead: 2, time: '09:00', wording: 'Opens on the 1st' },
    });
    await getDb().run("UPDATE pending_approvals SET status='approved' WHERE approval_id=?", approval.approval_id);
    await resumeApprovedApprovals();
    expect(await getDb().get('SELECT status,release_json FROM gws_ea_browser_watches WHERE id=?', id)).toEqual({
      status: 'armed',
      release_json: JSON.stringify(stored),
    });
  });

  it('prints a trial conversion on the principal’s clock, labelled, never as raw ISO', () => {
    const watch = {
      id: 'trial-watch',
      site: 'resy.com',
      bounds_json: JSON.stringify({
        ...bounds,
        financial: {
          freeOnly: false,
          currency: 'USD',
          maxTotalMinor: 2000,
          maxDueNowMinor: 0,
          policy: {
            currency: 'USD',
            dueNowMinor: 0,
            commitments: [
              {
                kind: 'trial',
                terms: 'Free for 30 days, then $20 monthly',
                amountMinor: 2000,
                trigger: 'Trial ends',
                cancellationTerms: 'Cancel before the trial ends',
                cancellationBeforeMs: 0,
                conversionAt: '2026-11-15T08:00:00.000Z',
                frequency: 'monthly',
              },
            ],
          },
        },
      }),
    } as WatchRow;
    const card = renderWatchCard(watch, 'UTC', 'America/Los_Angeles');
    expect(card).toContain('converts Nov 15, 2026, 12:00 AM Los Angeles time');
    expect(card).not.toContain('2026-11-15T08:00:00');
    expect(card).toContain(
      'Arrival window: Oct 16, 2026, 7:00 PM through 9:00 PM UTC (Oct 16, 2026, 12:00 PM through 2:00 PM Los Angeles time)',
    );
  });
});

describe('watches on sites with no reader (KTD20)', () => {
  const regionBounds: WatchBounds = {
    kind: 'region',
    site: 'larder.example',
    venue: { id: 'the-larder', name: 'The Larder' },
    partySize: 2,
    windows: [{ start: '2026-10-17T02:00:00.000Z', end: '2026-10-17T04:00:00.000Z' }],
    financial: { freeOnly: false, currency: 'USD', maxTotalMinor: 5000, maxDueNowMinor: 5000 },
    until: '2026-10-16T19:00:00.000Z',
  };
  /** A deposit booking on The Larder's own checkout, as the generic signature reads it. */
  function depositFacts(deposit = 4000, booking: Record<string, unknown> = {}): PurchaseFacts {
    return {
      flowId: GENERIC_FLOW_ID,
      site: 'larder.example',
      origin: 'https://larder.example',
      control: {
        label: 'Reserve now',
        locator: {
          role: 'button',
          name: 'Reserve now',
          ordinal: 0,
          count: 1,
          framePath: [],
          frameUrls: ['https://larder.example/book'],
        },
      },
      account: 'guest checkout',
      items: [],
      currency: 'USD',
      totalMinor: deposit,
      dueNowMinor: deposit,
      cardEnding: '4242',
      address: null,
      commitments: [{ kind: 'deposit', terms: 'Deposit charged when you book', amountMinor: deposit }],
      generic: {
        guest: true,
        contactEmail: 'aya.web@example.test',
        items: ['Table for 2'],
        payment: 'Card on file: Visa ending in 4242',
        booking: { venue: 'The Larder', partySize: 2, at: '2026-10-16T19:30:00-07:00', timeZone: '-07:00', ...booking },
      },
    };
  }
  async function seedRegionWatch(id: string, watchBounds: WatchBounds = regionBounds, status = 'armed'): Promise<void> {
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,region_json,region_baseline,region_marked_at,status,created_at,updated_at,next_check_at)
      VALUES(?,?,'larder.example','recipe',1,'{}',?,?,'{}','No tables',?,?,?,?,?)`,
      id,
      jobId,
      id,
      JSON.stringify(watchBounds),
      at,
      status,
      at,
      at,
      at,
    );
    await getDb().run(
      "INSERT INTO gws_ea_browser_watch_job_claims(job_id,state) VALUES(?,'available') ON CONFLICT(job_id) DO NOTHING",
      jobId,
    );
  }

  it('covers a booking the site’s own checkout reads within the merchant, venue, party, window and maximum', () => {
    const now = '2026-10-15T12:00:00.000Z';
    expect(compareWatchBounds(regionBounds, depositFacts(), now)).toEqual({ status: 'within_bounds' });
    // The page's venue reads as the principal named it, case and apostrophes aside.
    expect(compareWatchBounds(regionBounds, depositFacts(4000, { venue: 'THE LARDER' }), now).status).toBe(
      'within_bounds',
    );
    const outside: Array<[PurchaseFacts, string]> = [
      [{ ...depositFacts(), site: 'tables.example' }, 'merchant'],
      [depositFacts(4000, { venue: 'The Larder Annex' }), 'venue_or_party'],
      [depositFacts(4000, { partySize: 4 }), 'venue_or_party'],
      [depositFacts(4000, { at: undefined }), 'venue_or_party'],
      [depositFacts(4000, { at: '2026-10-16T22:00:00-07:00' }), 'time'],
      [depositFacts(8000), 'financial_limit'],
      [{ ...depositFacts(), currency: 'EUR' }, 'currency_or_total'],
      [
        {
          ...depositFacts(),
          commitments: [
            { kind: 'subscription', terms: 'Supper club, $10 monthly', amountMinor: 1000, frequency: 'monthly' },
          ],
        },
        'financial_terms',
      ],
      [{ ...depositFacts(), addOns: ['Wine pairing'] }, 'financial_terms'],
    ];
    for (const [facts, reason] of outside)
      expect(compareWatchBounds(regionBounds, facts, now)).toEqual({ status: 'outside_bounds', reason });
    // A no-show fee per guest counts for every guest against the maximum.
    const noShow = {
      ...depositFacts(0),
      commitments: [
        {
          kind: 'conditional_fee' as const,
          terms: 'No-show fee $30 per person',
          amountMinor: 3000,
          perPerson: true,
          conditionalTrigger: 'no_show' as const,
        },
      ],
    };
    expect(compareWatchBounds(regionBounds, noShow, now)).toEqual({
      status: 'outside_bounds',
      reason: 'financial_limit',
    });
    expect(compareWatchBounds(regionBounds, depositFacts(), regionBounds.until).status).toBe('outside_bounds');
  });

  it('leaves a booking its approval does not cover to the purchase’s own card', async () => {
    await seedRegionWatch('larder');
    const { context } = await executionContext('larder-purchase');
    expect(await prepareWatchPurchase(context, depositFacts(8000))).toBeUndefined();
    expect(await getDb().all('SELECT * FROM gws_ea_browser_watch_notices')).toEqual([]);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_authorities')).toEqual([]);
  });

  it('lets a free commit or a card on the watched site spend the job’s one booking, and its outcome end the watch', async () => {
    await seedRegionWatch('larder');
    await seedRegionWatch('elsewhere', { ...regionBounds, site: 'tables.example' });
    await getDb().run("UPDATE gws_ea_browser_watches SET site = 'tables.example' WHERE id = 'elsewhere'");
    const at = new Date().toISOString();
    // A commit on another site touches nothing.
    await claimRegionWatchCommit(getDb(), {
      jobId,
      site: 'bistro.example',
      attemptId: 'other',
      requestId: 'r0',
      at,
    });
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims')).toEqual({ state: 'available' });
    await claimRegionWatchCommit(getDb(), { jobId, site: 'larder.example', attemptId: 'free', requestId: 'r1', at });
    expect(await getDb().get('SELECT state,watch_id,attempt_id FROM gws_ea_browser_watch_job_claims')).toEqual({
      state: 'committing',
      watch_id: 'larder',
      attempt_id: 'free',
    });
    expect(await getBrowserWatch('larder')).toMatchObject({ status: 'booking' });
    // The claim is spent: a second commit leaves the other watch armed.
    await claimRegionWatchCommit(getDb(), { jobId, site: 'tables.example', attemptId: 'again', requestId: 'r2', at });
    expect(await getBrowserWatch('elsewhere')).toMatchObject({ status: 'armed' });
    await finishWatchCommit(getDb(), jobId, 'other', true, 'page');
    expect(await getBrowserWatch('larder')).toMatchObject({ status: 'booking' });
    await finishWatchCommit(getDb(), jobId, 'free', true, 'page');
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims')).toEqual({ state: 'booked' });
    expect(await getBrowserWatch('larder')).toMatchObject({ status: 'booked' });
    // The job's other watches end with it.
    expect(await getBrowserWatch('elsewhere')).toMatchObject({ status: 'cancelled' });
  });

  it('asks for a region only where the host has no reader, and refuses one where it reads the venue itself', async () => {
    const { context } = await executionContext('region-setup');
    await getDb().run(
      "INSERT INTO gws_ea_browser_recipes(id,site,name,version,source_job_id,first_action,last_action,parameters_json,steps_json,read_only,created_at) VALUES('larder-recipe','larder.example','Tables',1,?,0,0,'[]','[]',1,?),('resy-recipe','resy.com','Availability',1,?,0,0,'[]','[]',1,?)",
      jobId,
      new Date().toISOString(),
      jobId,
      new Date().toISOString(),
    );
    const request = {
      site: 'https://larder.example/tables',
      recipe_id: 'larder-recipe',
      parameters: {},
      venue: { id: 'the-larder', name: 'The Larder' },
      party_size: 2,
      windows: regionBounds.windows,
      financial: { currency: 'USD', max_total: '0', terms: 'Nothing due' },
      until: regionBounds.until,
    };
    expect(await createBrowserWatch(context, request)).toEqual({ status: 'refused', reason: 'region_required' });
    const region = { ref: 'e5', generation: 1 };
    expect(
      await createBrowserWatch(context, {
        ...request,
        site: 'https://www.resy.com/',
        recipe_id: 'resy-recipe',
        region,
      }),
    ).toEqual({ status: 'refused', reason: 'site_has_reader' });
    // A release on a site with no reader needs the venue's zone from the agent.
    expect(
      await createBrowserWatch(context, {
        ...request,
        region,
        release: { days_ahead: 30, time: '10:00', wording: 'Tables open 30 days ahead at 10:00' },
      }),
    ).toEqual({ status: 'refused', reason: 'release_zone_unknown' });
    expect(await getDb().all('SELECT id FROM gws_ea_browser_watches')).toEqual([]);
  });

  it('reads a region and the watch to mark again, and keeps a queued release readable when it runs', async () => {
    const request = {
      site: 'https://larder.example/tables',
      recipe_id: 'larder-recipe',
      parameters: {},
      venue: { id: 'the-larder', name: 'The Larder' },
      party_size: 2,
      windows: regionBounds.windows,
      financial: { currency: 'USD', max_total: '0', terms: 'Nothing due' },
      until: regionBounds.until,
    };
    expect(validateWatchRequest({ ...request, region: { ref: 'f1e7', generation: 3 } }).region).toEqual({
      ref: 'f1e7',
      generation: 3,
    });
    expect(() => validateWatchRequest({ ...request, region: { ref: 'button', generation: 3 } })).toThrow('region');
    expect(() => validateWatchRequest({ ...request, watch_id: 'watch-1' })).toThrow('watch_id');
    // The queue keeps the agent's own fields, so the run reads a release rule as the agent sent it.
    const cards = await bindPrincipal();
    const { queue } = await executionContext('queued-release');
    await queue.start();
    try {
      await getDb().run(
        "INSERT INTO gws_ea_browser_recipes(id,site,name,version,source_job_id,first_action,last_action,parameters_json,steps_json,read_only,created_at) VALUES('check-recipe','resy.com','Availability',1,?,0,0,'[]','[]',1,?)",
        jobId,
        new Date().toISOString(),
      );
      vi.spyOn(watchRuntime, 'readBrowserWatchSetup').mockResolvedValue({
        availability: {
          status: 'ready',
          site: 'resy.com',
          venue: bounds.venue,
          partySize: 4,
          currency: 'USD',
          timeZone: 'America/New_York',
          slots: [],
        },
      });
      const job = (await new BrowserStore().getJob(jobId))!;
      const { getSession } = await import('../../db/sessions.js');
      const session = (await getSession(job.browser_session_id))!;
      await queue.accept(
        'watch',
        {
          action: 'watch',
          requestId: 'queued',
          site: 'https://resy.com/search',
          recipe_id: 'check-recipe',
          parameters: {},
          venue: bounds.venue,
          party_size: 4,
          windows: bounds.windows,
          financial: { currency: 'USD', max_total: '0', terms: 'Nothing due' },
          until: bounds.until,
          release: { days_ahead: 30, time: '10:00', wording: 'Tables released 30 days ahead at 10:00' },
        },
        session,
        'queued',
      );
      await queue.idle();
      const answer = await getDb().get<{ answer_json: string }>(
        "SELECT answer_json FROM gws_ea_browser_requests WHERE request_id = 'queued'",
      );
      expect(JSON.parse(answer!.answer_json)).toMatchObject({ ok: true, data: { status: 'armed' } });
      expect(await getDb().get('SELECT release_json FROM gws_ea_browser_watches')).toEqual({
        release_json: expect.stringContaining('"timeZone":"America/New_York"') as unknown,
      });
      expect(cards).toEqual([]);
    } finally {
      await queue.stop();
    }
  });

  it('shows the principal the maximum the host enforces, not terms it cannot check in advance', () => {
    const card = renderWatchCard(
      { id: 'larder', site: 'larder.example', bounds_json: JSON.stringify(regionBounds) } as WatchRow,
      'America/Los_Angeles',
      'America/Los_Angeles',
    );
    expect(card).toContain('Venue: "The Larder"');
    expect(card).toContain('Maximum total exposure, all guests and fees: $50.00 (USD)');
    expect(card).toContain('Arrival window: Oct 16, 2026, 7:00 PM through 9:00 PM Los Angeles time');
    expect(card).toContain('Any other booking, a recurring charge included, comes to you on its own card.');
    expect(card).not.toContain('merchant identity');
  });
});
