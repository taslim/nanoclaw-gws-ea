/** Native Chrome + real queue/authority/claims. Only calendar service and container wake are fixture boundaries. */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { root, calendar } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return { root: `${tmpdir()}/browser-reservation-execution`, calendar: vi.fn() };
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
  GROUPS_DIR: `${root}/groups`,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: () => Date.now(),
  isContainerRunning: () => false,
  killContainer: vi.fn(),
  registerSessionAdmissionPolicy: vi.fn(),
  wakeContainer: vi.fn(async () => true),
}));
vi.mock('../gws-ea-meetings/calendar-facts.js', () => ({ findPrincipalCalendarConflicts: calendar }));
import type { OutboundFile } from '../../channels/adapter.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { resolveSystemSession } from '../../session-manager.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore, browserRequestId } from './db.js';
import { BrowserQueue } from './queue.js';
import { observePage, pageMayShowSecret } from './observe.js';
import { principalReachable, seedPrincipal } from './principal-fixture.js';
import { freeResyTable, resyFixture, type ResyFixtureState } from './resy-native-fixture.js';
import { resyReservationSignature } from './resy-signature.js';
import type { WatchBounds } from './watches.js';
import type { Session } from '../../types.js';
const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
describe.skipIf(!chromePath)('native reservation through the common purchase executor', () => {
  let fixture: Awaited<ReturnType<typeof resyFixture>>;
  let fixtureState: ResyFixtureState;
  let queue: BrowserQueue;
  let session: Session;
  let jobId: string;
  async function load(throughQueue = false): Promise<void> {
    if (throughQueue) {
      await queue.accept(
        'browser',
        { actions: [{ kind: 'navigate', url: 'https://resy.com/reservation-details' }] },
        session,
        `reload-${Date.now()}`,
      );
      await queue.idle();
    } else await fixture.page.goto('https://resy.com/reservation-details');
    await fixture.page.locator('body[data-ready="yes"]').waitFor();
  }
  async function purchase(id: string): Promise<Record<string, unknown>> {
    const observation = await observePage(fixture.page);
    const ref = /- button "Reserve Now" \[ref=((?:f\d+)?e\d+)\]/u.exec(observation.snapshot)?.[1];
    if (!ref) throw new Error('Missing native reservation control');
    await queue.accept('purchase', { target: { ref, generation: observation.generation } }, session, id);
    await queue.idle();
    const request = await queue.store.request(browserRequestId(session.id, id));
    return (JSON.parse(request?.answer_json ?? '{}') as { data: Record<string, unknown> }).data;
  }
  beforeEach(async () => {
    if (!chromePath) throw new Error('Chrome required');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
    calendar.mockReset();
    calendar.mockResolvedValue({ conflicts: [], conflicts_not_listed: 0 });
    await runMigrations(await initTestDb());
    for (const id of ['reservation-main', 'reservation-browser'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await getDb().run(
      'UPDATE gws_ea_profile SET main_agent_group_id=?,browser_agent_group_id=? WHERE singleton=1',
      'reservation-main',
      'reservation-browser',
    );
    session = (await resolveSystemSession('reservation-browser', 'system:a2a:reservation-main:booking')).session;
    const store = new BrowserStore();
    const job = await store.jobForSession(session);
    if (!job) throw new Error('No browser job');
    jobId = job.id;
    fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });
    const policyFile = `${root}/browser/policy.json`;
    fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 1, enabled: true }), {
      mode: 0o600,
    });
    process.env.GWS_EA_BROWSER_POLICY_FILE = policyFile;
    fixtureState = freeResyTable();
    fixture = await resyFixture(chromePath, fixtureState);
    await resyReservationSignature.preparePage?.(fixture.page);
    await load();
    queue = new BrowserQueue(store, {
      pageForJob: async () => fixture.page,
      connection: async () => {
        throw new Error('No file transfer in reservation fixture');
      },
      closeJob: async () => {
        await fixture.page.close();
      },
      onDisconnected: () => () => undefined,
    });
    await queue.start();
    const bounds: WatchBounds = {
      site: 'resy.com',
      venue: { id: '25973', name: "L'Artusi" },
      partySize: 2,
      windows: [{ start: '2026-10-17T15:00:00.000Z', end: '2026-10-17T16:00:00.000Z' }],
      financial: { freeOnly: true, currency: 'USD', maxTotalMinor: 0, maxDueNowMinor: 0 },
      until: '2026-10-17T14:00:00.000Z',
    };
    await getDb().run(
      `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at) VALUES('watch',?,'resy.com','check',1,'{}','check',?,'armed',?,?,?)`,
      jobId,
      JSON.stringify(bounds),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    await getDb().run("INSERT INTO gws_ea_browser_watch_job_claims(job_id,state) VALUES(?,'available')", jobId);
  });
  afterEach(async () => {
    await queue?.stop();
    await fixture?.close();
    delete process.env.GWS_EA_BROWSER_POLICY_FILE;
    await closeDb();
    fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });
  it('books an explicitly free reservation exactly once without an invented payment card approval', async () => {
    expect(await purchase('first')).toMatchObject({ status: 'booked', order_number: '90123' });
    expect(fixture.submitted()).toBe(1);
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'watch')).toEqual({
      status: 'booked',
    });
    expect(await getDb().get('SELECT COUNT(*) AS count FROM pending_approvals')).toEqual({ count: 0 });
    await load(true);
    expect(await purchase('second')).toMatchObject({ status: 'watch_spent' });
    expect(fixture.submitted()).toBe(1);
  });
  it('uses main-recorded bounds for one direct standing-guarantee booking across purchase requests', async () => {
    await getDb().run('DELETE FROM gws_ea_browser_watches');
    await getDb().run('DELETE FROM gws_ea_browser_watch_job_claims');
    fixtureState.policy = [
      'We have a 24-hour cancellation/no-show policy of $25 per person for guests booking with us.',
    ];
    const inventory = fixtureState.inventory as {
      results: { venues: Array<{ slots: Array<{ payment: Record<string, unknown> }> }> };
    };
    inventory.results.venues[0].slots[0].payment.cancellation_fee = 25;
    fixtureState.details.cancellation = { fee: { amount: 25 }, display: { policy: fixtureState.policy } };
    await load();
    const main = (await resolveSystemSession('reservation-main', 'system:reservation-source')).session;
    const record = getDeliveryAction('reservation_bounds');
    if (!record) throw new Error('No native reservation bounds action');
    await record(
      {
        action: 'reservation_bounds',
        requestId: 'direct-bounds',
        thread: session.thread_id!,
        venue_id: '25973',
        party_size: 2,
        window_start: '2026-10-17T15:00:00.000Z',
        window_end: '2026-10-17T16:00:00.000Z',
      },
      main,
    );
    expect(await getDb().get('SELECT job_id FROM gws_ea_browser_reservation_bounds')).toEqual({ job_id: jobId });
    await getDb().run(
      'INSERT INTO gws_ea_browser_reservation_guarantees(id,approval_id,principal_user_id,currency,max_total_minor,created_at) VALUES(?,?,?,?,?,?)',
      'standing',
      'principal-approved',
      'principal',
      'USD',
      10000,
      new Date().toISOString(),
    );
    expect(await purchase('direct')).toMatchObject({ status: 'booked' });
    expect(fixture.submitted()).toBe(1);
    await load(true);
    await purchase('direct-again');
    expect(fixture.submitted()).toBe(1);
    expect(await getDb().all('SELECT kind,state FROM gws_ea_browser_authorities')).toEqual([
      { kind: 'reservation_guarantee', state: 'committed' },
    ]);
  });
  it('treats calendar failure as unavailable and never consumes the marker', async () => {
    calendar.mockRejectedValue(new Error('Calendar unavailable'));
    expect(await purchase('calendar')).toMatchObject({ status: 'calendar_unavailable' });
    expect(fixture.submitted()).toBe(0);
    expect(await getDb().get('SELECT COUNT(*) AS count FROM gws_ea_browser_purchase_attempts')).toEqual({ count: 0 });
  });
  it('rereads native DOM after the last calendar wait and refuses a changed party', async () => {
    calendar.mockResolvedValueOnce({ conflicts: [], conflicts_not_listed: 0 }).mockImplementationOnce(async () => {
      await fixture.page.locator('.ReservationSummary__row-text').evaluate((node) => {
        node.textContent = '3 Guests, Bar Counter';
      });
      return { conflicts: [], conflicts_not_listed: 0 };
    });
    expect(await purchase('drift')).toMatchObject({ status: 'outside_bounds' });
    expect(fixture.submitted()).toBe(0);
    expect(await getDb().get('SELECT COUNT(*) AS count FROM gws_ea_browser_purchase_attempts')).toEqual({ count: 0 });
  });
  it('leaves a submitted reservation with no bound native confirmation unconfirmed, holding back the next purchase on the site', async () => {
    fixtureState.responseToken = '';
    const outcome = await purchase('unknown');
    expect(outcome).toMatchObject({ status: 'unconfirmed', attempt_id: expect.any(String) });
    expect(fixture.submitted()).toBe(1);
    expect(await getDb().get('SELECT site FROM gws_ea_browser_purchase_blocks')).toEqual({ site: 'resy.com' });
    expect(await getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id=?', jobId)).toEqual({
      state: 'unknown',
    });
  }, 15_000);
  describe('an errand with no watch', () => {
    /** Each card posted to the principal, with the files that went with it. */
    let cards: Array<{ card: Record<string, unknown>; files: readonly OutboundFile[] | undefined }>;
    beforeEach(async () => {
      await getDb().run('DELETE FROM gws_ea_browser_watches');
      await getDb().run('DELETE FROM gws_ea_browser_watch_job_claims');
      // The principal who answers purchase cards, in their direct message.
      await seedPrincipal();
      await principalReachable();
      cards = [];
      setDeliveryAdapter({
        async deliver(_type, _platformId, _thread, _kind, content, files) {
          const card = JSON.parse(content) as Record<string, unknown>;
          if (card.type === 'ask_question') cards.push({ card, files });
          return `message-${cards.length}`;
        },
      });
    });
    it('books a free reservation with no card on file itself, with no card, as a money-less attempt (R3)', async () => {
      fixtureState.selectedPayment = null;
      fixtureState.details.user = { id: 72, payment_methods: [] };
      // The booking sends this box's state, and Resy's reviewed record proves only a booking with it unticked.
      fixtureState.extraTerms =
        '<label><input type="checkbox" name="venue_marketing_opt_in" checked> Send me news and offers from L&#39;Artusi</label>';
      await load();
      expect(await purchase('free')).toMatchObject({ status: 'booked', order_number: '90123', repeat_safe: false });
      expect(fixture.submitted()).toBe(1);
      expect(cards).toEqual([]);
      expect(await getDb().get('SELECT COUNT(*) AS count FROM pending_approvals')).toEqual({ count: 0 });
      expect(
        await getDb().all(
          'SELECT site,platform,account_key,resolution,resolution_source,merchant_record_id FROM gws_ea_browser_free_attempts',
        ),
      ).toEqual([
        {
          site: 'resy.com',
          platform: null,
          // The reviewed merchant's account keys its reservation numbers, as a paid attempt's does.
          account_key: 'resy:72',
          resolution: 'committed',
          resolution_source: 'page',
          merchant_record_id: '90123',
        },
      ]);
      expect(await getDb().get('SELECT COUNT(*) AS count FROM gws_ea_browser_purchase_attempts')).toEqual({ count: 0 });
      expect(await getDb().get('SELECT COUNT(*) AS count FROM gws_ea_browser_authorities')).toEqual({ count: 0 });
    });
    it('sends a card and presses nothing for a reservation with a card on file, or with a fee', async () => {
      expect(await purchase('card-on-file')).toMatchObject({ status: 'awaiting_principal' });
      fixtureState.policy = [
        'We have a 24-hour cancellation/no-show policy of $25 per person for guests booking with us.',
      ];
      const inventory = fixtureState.inventory as {
        results: { venues: Array<{ slots: Array<{ payment: Record<string, unknown> }> }> };
      };
      inventory.results.venues[0].slots[0].payment.cancellation_fee = 25;
      fixtureState.details.cancellation = { fee: { amount: 25 }, display: { policy: fixtureState.policy } };
      await load();
      expect(await purchase('fee')).toMatchObject({ status: 'awaiting_principal' });
      expect(fixture.submitted()).toBe(0);
      expect(await getDb().get('SELECT COUNT(*) AS count FROM gws_ea_browser_free_attempts')).toEqual({ count: 0 });
      // Resy's checkout document holds a booking bearer the host tracks as a secret, so its reader places no
      // picture: each card names one with none beside it, which the card says is unavailable (KTD6).
      expect(await pageMayShowSecret(fixture.page)).toBe(true);
      expect(cards.map(({ card, files }) => ({ pictures: card.pictures, files }))).toEqual([
        { pictures: 1, files: undefined },
        { pictures: 1, files: undefined },
      ]);
    });
  });
});
