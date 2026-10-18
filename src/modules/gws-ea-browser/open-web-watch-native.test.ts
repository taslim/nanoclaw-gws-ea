/**
 * Wake-on-change watches against native Chrome (KTD20): an unreviewed booking site whose slot list changes, checked
 * by the real scheduler and replay without the model. The signed-out context is the fixture's own page, since the
 * fixture's Chrome carries no host policy; the calendar and container wake are the other fixture boundaries.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { root, signedOut } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return {
    root: join(tmpdir(), 'nanoclaw-open-web-watch-native-tests'),
    signedOut: { open: undefined as (() => Promise<Page>) | undefined },
  };
});
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: root,
  GROUPS_DIR: `${root}/groups`,
}));
vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  registerSessionAdmissionPolicy: vi.fn(),
  wakeContainer: vi.fn(async () => true),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../gws-ea-meetings/calendar-facts.js', async (original) => ({
  ...(await original<typeof import('../gws-ea-meetings/calendar-facts.js')>()),
  findPrincipalCalendarConflicts: vi.fn(async () => ({ conflicts: [], conflicts_not_listed: 0, message: 'Free' })),
}));
vi.mock('./signed-out.js', () => ({
  async withSignedOutBrowserPage<T>(_connection: unknown, operation: (page: Page) => Promise<T>): Promise<T> {
    if (!signedOut.open) throw new Error('No signed-out fixture page');
    const page = await signedOut.open();
    try {
      return await operation(page);
    } finally {
      await page.context().close();
    }
  },
}));

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, resolveSystemSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { configureBrowserCancellation } from './cancel.js';
import type { ChromeConnection } from './connection.js';
import { BrowserStore } from './db.js';
import type { BrowserAction } from './executor.js';
import { setBrowserAdmissionReady } from './group.js';
import { prepareMerchantPage } from './merchant-signatures.js';
import {
  WATCHED,
  openWebFixture,
  watchedBookingSite,
  type OpenWebFixture,
  type WatchedSiteState,
} from './open-web-native-fixture.js';
import { observePage, type BrowserRef } from './observe.js';
import { prepareAuthenticationIsolation } from './authentication-submit.js';
import { resyFixture, type ResyFixtureState } from './resy-native-fixture.js';
import { resyReservationSignature } from './resy-signature.js';
import { registerBrowserPurchaseDelivery, resumeBrowserPurchaseCommits } from './purchase.js';
import { BrowserQueue } from './queue.js';
import { createBrowserWatchScheduler, type BrowserWatchScheduler } from './scheduler.js';
import { watchSitePolicy } from './watch-policy.js';
import type { WatchBounds, WatchRow } from './watches.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;

/** The aria ref of the one element named `name` in an observation, with its generation. */
function refIn(observation: { snapshot: string; generation: number }, name: string): BrowserRef {
  const line = observation.snapshot.split('\n').find((candidate) => candidate.includes(`"${name}"`));
  const ref = line && /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1];
  if (!ref) throw new Error(`Missing ${name} in ${observation.snapshot}`);
  return { ref, generation: observation.generation };
}

describe.skipIf(!chromePath)('wake-on-change watches in native Chrome', { timeout: 90_000 }, () => {
  const PRINCIPAL = 'gchat:users/principal';
  const BOUNDS = {
    site: WATCHED.tables,
    parameters: {},
    venue: { id: 'the-larder', name: 'The Larder' },
    party_size: 2,
    windows: [{ start: '2026-10-24T19:00:00-07:00', end: '2026-10-24T21:00:00-07:00' }],
    until: '2026-10-24T12:00:00-07:00',
  };
  const FREE = { currency: 'USD', max_total: '0', terms: 'Nothing due' };
  let fixture: OpenWebFixture;
  let page: Page;
  let queue: BrowserQueue;
  let session: Session;
  let scheduler: BrowserWatchScheduler;
  let site: WatchedSiteState;
  let sent: string[];

  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
    signedOut.open = () => fixture.newPage();
  }, 30_000);
  afterAll(async () => {
    signedOut.open = undefined;
    await fixture?.close();
  });
  beforeEach(async () => {
    // Date moves on in real time from the errand's afternoon, a week before the dinner; a test may jump it.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-17T19:00:00.000Z'));
    vi.mocked(requestWake).mockClear();
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(`${root}/browser`, { recursive: true });
    fs.writeFileSync(`${root}/browser/policy.json`, JSON.stringify({ schemaVersion: 1, enabled: true }), {
      mode: 0o600,
    });
    process.env.GWS_EA_BROWSER_POLICY_FILE = `${root}/browser/policy.json`;
    await runMigrations(await initTestDb());
    for (const id of ['main-w', 'browser-w'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await createMessagingGroup({
      id: 'mg-principal',
      channel_type: 'gchat',
      platform_id: 'spaces/principal',
      name: 'principal',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Morgan Ellery',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: 'main-w',
      principalEmails: ['morgan@example.test'],
    });
    await getDb().run(
      'UPDATE gws_ea_profile SET browser_agent_group_id = ?, assistant_alias = ? WHERE singleton = 1',
      'browser-w',
      'aya.web@example.test',
    );
    await upsertUser({
      id: PRINCIPAL,
      kind: 'gchat',
      display_name: 'Morgan Ellery',
      created_at: new Date().toISOString(),
    });
    await upsertUserDm({
      user_id: PRINCIPAL,
      channel_type: 'gchat',
      messaging_group_id: 'mg-principal',
      resolved_at: new Date().toISOString(),
    });
    await bindVerifiedPrincipalUser(PRINCIPAL, new Date().toISOString());
    await resolveSession('main-w', 'mg-principal', null, 'agent-shared');
    session = (await resolveSystemSession('browser-w', 'system:a2a:main-w:dinner')).session;
    sent = [];
    setDeliveryAdapter({
      async deliver(_type, _platformId, _thread, _kind, content) {
        sent.push(content);
        return `message-${sent.length}`;
      },
    });
    const watched = watchedBookingSite();
    site = watched.state;
    for (const [url, route] of Object.entries(watched.pages)) fixture.serve(url, route);
    page = await fixture.newPage();
    await prepareMerchantPage(page);
    queue = new BrowserQueue(new BrowserStore(), {
      pageForJob: async () => page,
      // The signed-out check page is the fixture's own (see the mock above); no host Chrome is reached.
      connection: async () => ({}) as ChromeConnection,
      closeJob: async () => undefined,
      onDisconnected: () => () => undefined,
    });
    configureBrowserCancellation(queue);
    registerBrowserPurchaseDelivery(() => queue);
    await queue.start();
    await resumeBrowserPurchaseCommits(queue);
    setBrowserAdmissionReady(true);
    // The fixture site's politeness floor and the principal's night would only slow these checks down.
    scheduler = createBrowserWatchScheduler(queue, {
      policy: (watchedSite) => ({ ...watchSitePolicy(watchedSite), floorMs: 0, principalQuietHours: [] }),
      random: () => 0.5,
    });
    fixture.requests.length = 0;
  });
  afterEach(async () => {
    await scheduler?.stop();
    setBrowserAdmissionReady(false);
    await queue?.stop();
    await page?.context().close();
    delete process.env.GWS_EA_BROWSER_POLICY_FILE;
    await closeDb();
    fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  async function answer(id: string): Promise<Record<string, unknown>> {
    const row = await getDb().get<{ answer_json: string }>(
      'SELECT answer_json FROM gws_ea_browser_requests WHERE session_id = ? AND request_id = ?',
      session.id,
      id,
    );
    if (!row) throw new Error(`No answer for ${id}`);
    return (JSON.parse(row.answer_json) as { data: Record<string, unknown> }).data;
  }
  async function request(action: string, content: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `${action}-${randomUUID()}`;
    await queue.accept(action, content, session, id);
    await queue.idle();
    return answer(id);
  }
  const run = (actions: BrowserAction[]): Promise<Record<string, unknown>> => request('browser', { actions });
  /** The agent's purchase of the control named `name`, aimed from a fresh observation. */
  async function purchase(name: string): Promise<Record<string, unknown>> {
    const handler = getDeliveryAction('purchase');
    if (!handler) throw new Error('purchase delivery missing');
    const id = `purchase-${randomUUID()}`;
    await handler({ action: 'purchase', requestId: id, target: refIn(await observePage(page), name) }, session);
    await queue.idle();
    return answer(id);
  }
  const approvals = (): Promise<PendingApproval[]> =>
    getDb().all<PendingApproval>('SELECT * FROM pending_approvals ORDER BY created_at');
  async function approve(approval: PendingApproval): Promise<void> {
    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value: 'approve',
      userId: PRINCIPAL,
      channelType: 'gchat',
      platformId: 'spaces/principal',
      threadId: null,
    });
    await queue.idle();
  }
  /** The agent records the route to the slot list, then sets the watch with the list marked. */
  async function setWatch(financial: Record<string, string> = FREE): Promise<Record<string, unknown>> {
    await run([{ kind: 'navigate', url: WATCHED.tables }]);
    const recipe = await request('save_recipe', { name: 'Tables', first_action: 0, last_action: 0, parameters: [] });
    expect(recipe).toMatchObject({ status: 'saved', read_only: true });
    return request('watch', {
      ...BOUNDS,
      recipe_id: recipe.recipe_id,
      financial,
      region: refIn(await observePage(page), 'Available tables'),
    });
  }
  const watch = async (): Promise<WatchRow> => (await getDb().get<WatchRow>('SELECT * FROM gws_ea_browser_watches'))!;
  /** One scheduled check, due now: the scheduler replays the recipe in a signed-out page and reads the region. */
  async function checkNow(): Promise<void> {
    const now = new Date().toISOString();
    await getDb().run("UPDATE gws_ea_browser_watches SET next_check_at = ? WHERE status = 'armed'", now);
    await getDb().run(
      'UPDATE gws_ea_browser_watch_site_state SET next_allowed_at = NULL,last_check_at = NULL,backoff_until = NULL',
    );
    await scheduler.tick();
  }
  const outcomes = async (): Promise<string[]> =>
    (await getDb().all<{ outcome: string }>('SELECT outcome FROM gws_ea_browser_watch_checks ORDER BY started_at')).map(
      (check) => check.outcome,
    );
  const notices = async (): Promise<Array<Record<string, unknown>>> =>
    (
      await getDb().all<{ outcome_json: string }>(
        'SELECT outcome_json FROM gws_ea_browser_watch_notices ORDER BY created_at,event_key',
      )
    ).map((notice) => JSON.parse(notice.outcome_json) as Record<string, unknown>);
  const watchWakes = (): number =>
    vi.mocked(requestWake).mock.calls.filter(([, reason]) => reason === 'browser-watch').length;

  it('wakes the agent when "No tables" becomes 7:30 PM, never for its countdown, and the agent books the free table (AE11)', async () => {
    expect(await setWatch()).toMatchObject({
      status: 'armed',
      free_only: true,
      region: { untrusted: true, text: expect.stringContaining('No tables') as unknown },
    });
    // Each view moves its countdown, viewer count, clock and tally: the region still reads the same.
    for (let check = 0; check < 3; check++) await checkNow();
    expect(site.served).toBe(4);
    expect(await outcomes()).toEqual(['region_read', 'region_read', 'region_read']);
    expect(await notices()).toEqual([]);
    expect(watchWakes()).toBe(0);

    site.slots = ['1930'];
    await checkNow();
    const [change] = await notices();
    expect(change).toMatchObject({
      type: 'browser_watch_outcome',
      status: 'changed',
      region: { untrusted: true },
    });
    const region = change.region as { before: string; after: string };
    expect(region.before).toContain('No tables');
    expect(region.after).toContain('7:30 PM');
    expect(region.after).not.toMatch(/No tables|people viewing|ends in/u);
    expect(watchWakes()).toBe(1);
    expect((await watch()).region_baseline).toBe(region.after);

    // The agent observes, opens the slot, and books: a free table the host presses itself, with no card.
    await run([{ kind: 'navigate', url: WATCHED.tables }]);
    await run([{ kind: 'click', ...refIn(await observePage(page), '7:30 PM') }]);
    expect(await purchase('Reserve now')).toMatchObject({ status: 'booked', order_number: 'LR-1930' });
    expect(await approvals()).toEqual([]);
    expect(sent).toEqual([]);
    expect(await watch()).toMatchObject({ status: 'booked' });
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims')).toEqual({ state: 'booked' });
    expect(await getDb().all('SELECT resolution,merchant_record_id FROM gws_ea_browser_free_attempts')).toEqual([
      { resolution: 'committed', merchant_record_id: 'LR-1930' },
    ]);
    // A booked watch checks no more.
    const served = site.served;
    await checkNow();
    expect(site.served).toBe(served);
  });

  it('books a free table outside the watch’s window without spending the watch, which then books its own', async () => {
    await setWatch();
    await run([{ kind: 'navigate', url: `${WATCHED.book}?slot=2215` }]);
    expect(await purchase('Reserve now')).toMatchObject({ status: 'booked', order_number: 'LR-2215' });
    expect(await watch()).toMatchObject({ status: 'armed' });
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims')).toEqual({ state: 'available' });

    site.slots = ['1930'];
    await checkNow();
    expect(await notices()).toEqual([expect.objectContaining({ status: 'changed' })]);
    await run([{ kind: 'navigate', url: WATCHED.tables }]);
    await run([{ kind: 'click', ...refIn(await observePage(page), '7:30 PM') }]);
    expect(await purchase('Reserve now')).toMatchObject({ status: 'booked', order_number: 'LR-1930' });
    expect(await watch()).toMatchObject({ status: 'booked' });
    expect(await getDb().get('SELECT state,attempt_id FROM gws_ea_browser_watch_job_claims')).toEqual({
      state: 'booked',
      attempt_id: expect.stringMatching(/^free-attempt-/u) as unknown,
    });
  });

  it('slows down as changes book nothing, and the hourly cap holds a sixth wake until the hour allows it', async () => {
    await setWatch();
    const intervals: number[] = [];
    // Late, early and bar seating: each a change, none within the window, so the agent books none.
    for (const slots of [['2215'], ['2230'], ['2245'], ['1600'], ['1630']]) {
      site.slots = slots;
      const before = Date.now();
      await checkNow();
      intervals.push(Math.round((Date.parse((await watch()).next_check_at) - before) / 60_000));
    }
    expect((await notices()).map((notice) => notice.status)).toEqual(Array(5).fill('changed'));
    expect(watchWakes()).toBe(5);
    // The week-out cadence is five minutes; each unmatched change doubles it, to at most an hour.
    expect(intervals).toEqual([10, 20, 40, 60, 60]);

    site.slots = ['1645'];
    await checkNow();
    expect(await notices()).toHaveLength(5);
    expect(watchWakes()).toBe(5);
    expect((await watch()).region_baseline).toContain('4:30 PM');

    vi.setSystemTime(Date.now() + 61 * 60_000);
    await checkNow();
    const all = await notices();
    expect(all).toHaveLength(6);
    const held = all[5].region as { before: string; after: string };
    expect(held.before).toContain('4:30 PM');
    expect(held.after).toContain('4:45 PM');
  });

  it('wakes the agent to mark the region again when a redesign drops it, and checks the new mark', async () => {
    const created = await setWatch();
    site.redesigned = true;
    await checkNow();
    // One miss may be the site's own hiccup: only a second one running wakes the agent.
    expect(await notices()).toEqual([]);
    await checkNow();
    await checkNow();
    expect(await notices()).toEqual([
      expect.objectContaining({ status: 'region_missing', reason: 'region_not_found', watch_id: created.watch_id }),
    ]);
    expect(await outcomes()).toEqual(['region_missing', 'region_missing', 'region_missing']);
    expect(watchWakes()).toBe(1);
    const listed = (await request('list_watches', {})).watches as Array<Record<string, unknown>>;
    expect(listed).toEqual([
      expect.objectContaining({
        id: created.watch_id,
        region: {
          marked_at: expect.any(String) as unknown,
          missing_since: expect.any(String) as unknown,
          wakes_this_hour: 1,
          baseline: { untrusted: true, text: expect.stringContaining('No tables') as unknown },
        },
      }),
    ]);

    // The agent marks the redesigned list on the view its recipe reaches; bounds and recipe are unchanged.
    await run([{ kind: 'navigate', url: WATCHED.tables }]);
    const recipe = (await watch()).check_recipe_id;
    expect(
      await request('watch', {
        ...BOUNDS,
        recipe_id: recipe,
        financial: FREE,
        watch_id: created.watch_id,
        region: refIn(await observePage(page), 'Times'),
      }),
    ).toMatchObject({ status: 'marked', watch_id: created.watch_id, region: { untrusted: true } });
    expect(
      await request('watch', {
        ...BOUNDS,
        party_size: 4,
        recipe_id: recipe,
        financial: FREE,
        watch_id: created.watch_id,
        region: refIn(await observePage(page), 'Times'),
      }),
    ).toMatchObject({ status: 'refused', reason: 'bounds_changed' });
    await checkNow();
    expect(await notices()).toHaveLength(1);
    site.slots = ['2000'];
    await checkNow();
    const [, change] = await notices();
    expect(change).toMatchObject({ status: 'changed' });
    expect((change.region as { after: string }).after).toContain('8:00 PM');
  });

  it('refuses a region off the recipe’s view, one with nothing to compare or one too large, set or marked again', async () => {
    await run([{ kind: 'navigate', url: WATCHED.tables }]);
    const recipe = await request('save_recipe', { name: 'Tables', first_action: 0, last_action: 0, parameters: [] });
    const mark = (region: BrowserRef, watchId?: string): Promise<Record<string, unknown>> =>
      request('watch', {
        ...BOUNDS,
        recipe_id: recipe.recipe_id,
        financial: FREE,
        region,
        ...(watchId ? { watch_id: watchId } : {}),
      });
    /** The ref of the first element whose observed line shows `text`. */
    const refShowing = (observation: { snapshot: string; generation: number }, text: string): BrowserRef => {
      const line = observation.snapshot.split('\n').find((candidate) => candidate.includes(text));
      const ref = line && /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1];
      if (!ref) throw new Error(`Missing ${text} in ${observation.snapshot}`);
      return { ref, generation: observation.generation };
    };
    // More slots than the host keeps of a region's text.
    const crowded = Array.from(
      { length: 168 },
      (_, index) => `${10 + Math.floor(index / 12)}${String((index % 12) * 5).padStart(2, '0')}`,
    );
    async function refusesEach(watchId?: string): Promise<void> {
      const refused = (reason: string) => ({ status: 'refused', reason, ...(watchId ? { watch_id: watchId } : {}) });
      // The booking page is not the view the recipe reaches.
      await run([{ kind: 'navigate', url: `${WATCHED.book}?slot=1930` }]);
      expect(await mark(refIn(await observePage(page), 'Reserve now'), watchId)).toMatchObject(
        refused('region_off_route'),
      );
      // The day's booking tally changes on every view: once stripped, nothing is left to compare.
      await run([{ kind: 'navigate', url: WATCHED.tables }]);
      expect(await mark(refShowing(await observePage(page), 'times today'), watchId)).toMatchObject(
        refused('region_unmarkable'),
      );
      site.slots = crowded;
      await run([{ kind: 'navigate', url: WATCHED.tables }]);
      expect(await mark(refIn(await observePage(page), 'Available tables'), watchId)).toMatchObject(
        refused('region_too_large'),
      );
      site.slots = [];
    }
    await refusesEach();
    expect(await getDb().all('SELECT id FROM gws_ea_browser_watches')).toEqual([]);

    // Marking a watch's region again refuses each the same way, and leaves its marked region as it was.
    await run([{ kind: 'navigate', url: WATCHED.tables }]);
    const created = await mark(refIn(await observePage(page), 'Available tables'));
    expect(created).toMatchObject({ status: 'armed' });
    const marked = await watch();
    await refusesEach(String(created.watch_id));
    expect(await watch()).toMatchObject({
      status: 'armed',
      region_json: marked.region_json,
      region_baseline: marked.region_baseline,
      region_marked_at: marked.region_marked_at,
    });
  });

  it('books a paid table a change found under the watch’s approval when the host-read total is within it', async () => {
    site.deposit = 40;
    expect(await setWatch({ currency: 'USD', max_total: '50.00', terms: 'A deposit of up to $50' })).toMatchObject({
      status: 'awaiting_principal',
    });
    const [card] = await approvals();
    expect(card.question).toContain('Venue: "The Larder"');
    expect(card.question).toContain('Maximum total exposure, all guests and fees: $50.00 (USD)');
    expect(card.question).toContain(
      'A booking goes ahead without asking you again only when the site’s own checkout shows this venue',
    );
    await approve(card);
    expect(await watch()).toMatchObject({ status: 'armed' });

    site.slots = ['2000'];
    await checkNow();
    expect(await notices()).toEqual([expect.objectContaining({ status: 'changed' })]);
    await run([{ kind: 'navigate', url: WATCHED.tables }]);
    await run([{ kind: 'click', ...refIn(await observePage(page), '8:00 PM') }]);
    expect(await purchase('Reserve now')).toMatchObject({ status: 'booked', order_number: 'LR-2000' });
    // No purchase card: the watch's approval covered it.
    expect(await getDb().all('SELECT id FROM gws_ea_browser_purchase_cards')).toEqual([]);
    expect(await getDb().all('SELECT kind,state FROM gws_ea_browser_authorities WHERE watch_id IS NOT NULL')).toEqual([
      { kind: 'watch', state: 'committed' },
    ]);
    expect(await watch()).toMatchObject({ status: 'booked' });
  });

  it('sends a card for a paid table above the watch’s maximum, and its approved booking ends the watch', async () => {
    site.deposit = 80;
    await setWatch({ currency: 'USD', max_total: '50.00', terms: 'A deposit of up to $50' });
    await approve((await approvals())[0]);
    site.slots = ['1930'];
    await checkNow();
    await run([{ kind: 'navigate', url: WATCHED.tables }]);
    await run([{ kind: 'click', ...refIn(await observePage(page), '7:30 PM') }]);
    expect(await purchase('Reserve now')).toMatchObject({ status: 'awaiting_principal' });
    const purchaseCard = (await approvals()).find((approval) => approval.action === 'browser_purchase');
    if (!purchaseCard) throw new Error('No purchase card');
    expect(purchaseCard.question).toContain('$80.00');
    // A card pursued is the agent's match: the watch keeps its cadence while the principal decides.
    expect((await watch()).status).toBe('armed');
    await approve(purchaseCard);
    expect(await getDb().all('SELECT kind,state FROM gws_ea_browser_authorities')).toEqual([
      { kind: 'checkout', state: 'committed' },
    ]);
    expect(await watch()).toMatchObject({ status: 'booked' });
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims')).toEqual({ state: 'booked' });
  });

  it('books a carded table outside the watch’s window without spending the watch', async () => {
    site.deposit = 80;
    await setWatch({ currency: 'USD', max_total: '50.00', terms: 'A deposit of up to $50' });
    await approve((await approvals())[0]);
    await run([{ kind: 'navigate', url: `${WATCHED.book}?slot=2215` }]);
    expect(await purchase('Reserve now')).toMatchObject({ status: 'awaiting_principal' });
    const purchaseCard = (await approvals()).find((approval) => approval.action === 'browser_purchase');
    if (!purchaseCard) throw new Error('No purchase card');
    await approve(purchaseCard);
    expect(await getDb().all('SELECT kind,state FROM gws_ea_browser_authorities')).toEqual(
      expect.arrayContaining([{ kind: 'checkout', state: 'committed' }]),
    );
    expect(await watch()).toMatchObject({ status: 'armed' });
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims')).toEqual({ state: 'available' });
  });
});

describe.skipIf(!chromePath)('a reader watch beside region watches in native Chrome', { timeout: 90_000 }, () => {
  let resy: Awaited<ReturnType<typeof resyFixture>>;
  let queue: BrowserQueue;
  let session: Session;
  let jobId: string;
  /** A free bar-counter table at L'Artusi, as Resy's own API answers it. */
  const state = (): ResyFixtureState => ({
    inventory: {
      query: { day: '2026-10-17', party_size: 2 },
      results: {
        venues: [
          {
            venue: {
              id: { resy: 25973 },
              name: "L'Artusi",
              currency: { code: 'USD' },
              location: { time_zone: 'EST5EDT' },
            },
            slots: [
              {
                config: { id: 1442725, token: 'opaque-native-slot-token', type: 'Bar Counter' },
                date: { start: '2026-10-17 11:00:00', end: '2026-10-17 12:00:00' },
                size: { min: 2, max: 2 },
                time: { turn: { actual: 3600 } },
                payment: { is_paid: false, cancellation_fee: null, deposit_fee: null, is_add_on_required: false },
                has_add_ons: false,
              },
            ],
          },
        ],
      },
    },
    policy: [],
    details: {
      venue: { id: 25973 },
      user: { id: 72, payment_methods: [{ id: 101, display: '4242' }] },
      config: { double_confirmation: false, add_ons: [] },
      payment: { amounts: { total: 0, items: [] } },
      cancellation: { fee: null, display: { policy: [] } },
      book_token: { value: 'secret-book-token' },
    },
  });
  async function request(action: string, content: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `${action}-${randomUUID()}`;
    await queue.accept(action, content, session, id);
    await queue.idle();
    const row = await getDb().get<{ answer_json: string }>(
      'SELECT answer_json FROM gws_ea_browser_requests WHERE session_id = ? AND request_id = ?',
      session.id,
      id,
    );
    return (JSON.parse(row?.answer_json ?? '{}') as { data: Record<string, unknown> }).data;
  }
  beforeEach(async () => {
    if (!chromePath) throw new Error('Chrome required');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    vi.mocked(requestWake).mockClear();
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${root}/browser/policy.json`, JSON.stringify({ schemaVersion: 1, enabled: true }), {
      mode: 0o600,
    });
    process.env.GWS_EA_BROWSER_POLICY_FILE = `${root}/browser/policy.json`;
    await runMigrations(await initTestDb());
    for (const id of ['reader-main', 'reader-browser'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await getDb().run(
      'UPDATE gws_ea_profile SET main_agent_group_id=?,browser_agent_group_id=? WHERE singleton=1',
      'reader-main',
      'reader-browser',
    );
    session = (await resolveSystemSession('reader-browser', 'system:a2a:reader-main:counter')).session;
    const store = new BrowserStore();
    const job = await store.jobForSession(session);
    if (!job) throw new Error('No browser job');
    jobId = job.id;
    resy = await resyFixture(chromePath, state());
    await resyReservationSignature.preparePage?.(resy.page);
    // The model-free check reads Resy's API in a page of its own, as a signed-out check page would.
    signedOut.open = async () => {
      const checkPage = await resy.browser.newPage();
      await prepareAuthenticationIsolation(checkPage.context(), true);
      await prepareMerchantPage(checkPage);
      return checkPage;
    };
    queue = new BrowserQueue(store, {
      pageForJob: async () => resy.page,
      connection: async () => ({}) as ChromeConnection,
      closeJob: async () => undefined,
      onDisconnected: () => () => undefined,
    });
    await queue.start();
  });
  afterEach(async () => {
    signedOut.open = undefined;
    await queue?.stop();
    await resy?.close();
    delete process.env.GWS_EA_BROWSER_POLICY_FILE;
    await closeDb();
    fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('books a Resy table through its reader without waking the agent', async () => {
    // TEMPORARY CI DIAGNOSTIC: what the page did when its readiness never comes.
    const seen: string[] = [];
    const stamp = (): string => `${Math.round(performance.now())}ms`;
    resy.page.on('request', (r) => seen.push(`${stamp()} -> ${r.resourceType()} ${r.method()} ${r.url()}`));
    resy.page.on('requestfinished', (r) => seen.push(`${stamp()} ok ${r.method()} ${r.url()}`));
    resy.page.on('requestfailed', (r) =>
      seen.push(`${stamp()} FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText}`),
    );
    resy.page.on('framenavigated', (f) =>
      seen.push(`${stamp()} navigated ${f === resy.page.mainFrame() ? 'main' : 'child'} ${f.url()}`),
    );
    resy.page.on('pageerror', (e) => seen.push(`${stamp()} pageerror ${e.message}`));
    resy.page.on('console', (m) => seen.push(`${stamp()} console ${m.type()} ${m.text()}`));
    resy.page.on('crash', () => seen.push(`${stamp()} crash`));
    const network = await resy.page.context().newCDPSession(resy.page);
    await network.send('Network.enable');
    network.on('Network.requestWillBeSent', (e) =>
      seen.push(`${stamp()} cdp sent ${e.requestId} ${e.type ?? '?'} ${e.request.method} ${e.request.url}`),
    );
    network.on('Network.loadingFailed', (e) => seen.push(`${stamp()} cdp failed ${JSON.stringify(e)}`));
    network.on('Network.responseReceived', (e) =>
      seen.push(`${stamp()} cdp response ${e.requestId} ${e.type} ${e.response.status} ${e.response.url}`),
    );
    const browserSession = await resy.browser.newBrowserCDPSession();
    await browserSession.send('Target.setDiscoverTargets', { discover: true });
    browserSession.on('Target.targetCreated', (e) =>
      seen.push(`${stamp()} target+ ${e.targetInfo.type} ${e.targetInfo.url}`),
    );
    browserSession.on('Target.targetDestroyed', (e) => seen.push(`${stamp()} target- ${e.targetId}`));
    browserSession.on('Target.targetCrashed', (e) => seen.push(`${stamp()} target crashed ${e.targetId}`));
    // The agent recorded the route to the reservation and its booking path: a click that reached the commit.
    expect(
      await request('browser', { actions: [{ kind: 'navigate', url: 'https://resy.com/reservation-details' }] }),
    ).toMatchObject({ reason: 'navigated', actions: [{ status: 'completed' }] });
    seen.push(`${stamp()} answered`);
    await resy.page
      .locator('body[data-ready="yes"]')
      .waitFor({ timeout: 15_000 })
      .catch(async (error: unknown) => {
        const body = await resy.page
          .evaluate<string>("JSON.stringify(document.body.dataset) + ' ' + document.body.innerHTML.slice(0, 200)")
          .catch((failure: unknown) => String(failure));
        throw new Error(
          `${String(error)}\nchrome ${resy.browser.version()}\nurl ${resy.page.url()}\nbody ${body}\n${seen.join('\n')}`,
        );
      });
    const observation = await observePage(resy.page);
    expect(
      await request('browser', { actions: [{ kind: 'click', ...refIn(observation, 'Reserve Now') }] }),
    ).toMatchObject({ status: 'stopped', reason: 'purchase_control' });
    const check = await request('save_recipe', { name: 'Table', first_action: 0, last_action: 0, parameters: [] });
    const bounds: WatchBounds = {
      site: 'resy.com',
      venue: { id: '25973', name: "L'Artusi" },
      partySize: 2,
      windows: [{ start: '2026-10-17T15:00:00.000Z', end: '2026-10-17T16:00:00.000Z' }],
      financial: { freeOnly: true, currency: 'USD', maxTotalMinor: 0, maxDueNowMinor: 0 },
      until: '2026-10-17T14:00:00.000Z',
    };
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at) VALUES('reader',?,'resy.com',?,1,'{}','reader',?,'armed',?,?,?)`,
      jobId,
      check.recipe_id,
      JSON.stringify(bounds),
      at,
      at,
      at,
    );
    await getDb().run("INSERT INTO gws_ea_browser_watch_job_claims(job_id,state) VALUES(?,'available')", jobId);
    await request('save_recipe', { name: 'Book', first_action: 0, last_action: 1, parameters: [] });
    expect(await getDb().get('SELECT booking_recipe_id IS NOT NULL AS linked FROM gws_ea_browser_watches')).toEqual({
      linked: 1,
    });

    const scheduler = createBrowserWatchScheduler(queue, {
      policy: (watchedSite) => ({ ...watchSitePolicy(watchedSite), floorMs: 0, principalQuietHours: [] }),
      random: () => 0.5,
    });
    try {
      await scheduler.tick();
      await queue.idle();
    } finally {
      await scheduler.stop();
    }
    expect(await getDb().all('SELECT outcome FROM gws_ea_browser_watch_checks')).toEqual([{ outcome: 'ready' }]);
    expect(resy.submitted()).toBe(1);
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches')).toEqual({ status: 'booked' });
    // The agent hears only the booking's outcome: nothing woke it to decide.
    expect(await getDb().all('SELECT event_key FROM gws_ea_browser_watch_notices')).toEqual([]);
    expect(vi.mocked(requestWake).mock.calls.map(([, reason]) => reason)).not.toContain('browser-watch');
  });
});
