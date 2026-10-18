/**
 * Purchase outcomes against a real central DB and real session DBs (KTD8, KTD9, KTD10): an attempt with no page
 * proof is unconfirmed and told once, main records its outcome through the one resolve function, and every edge
 * of the purchase state machine past the press settles the authority, the watch, the block and the waiting jobs.
 */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { root } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: join(tmpdir(), 'nanoclaw-browser-outcome-tests') };
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

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { guard } from '../../guard/index.js';
import { resolveSession, resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { PurchaseAuthorityError, PurchaseAuthorityStore } from './authority.js';
import { readBrowserJob } from './cancel.js';
import { BrowserStore, type BrowserJob } from './db.js';
import { GENERIC_FLOW_ID, type PurchaseFacts } from './fingerprint.js';
import { notifyPendingUnconfirmed, purchaseOutcomeGuard, recordPurchaseOutcome } from './purchase-outcome.js';
import { recoverBrowserPurchases } from './purchase.js';
import { claimRegionWatchCommit } from './watches.js';
import { BrowserQueue } from './queue.js';

const PRINCIPAL = 'gchat:users/principal';
const ALIAS = 'aya.web@example.test';
const SITE = 'pottery.example';

/** The pottery shop's checkout, as the generic signature reads it. */
function checkout(site = SITE): PurchaseFacts {
  return {
    flowId: GENERIC_FLOW_ID,
    site,
    origin: `https://${site}`,
    control: {
      label: 'Place order',
      locator: {
        role: 'button',
        name: 'Place order',
        ordinal: 0,
        count: 1,
        framePath: [],
        frameUrls: [`https://${site}/checkout/review`],
      },
    },
    account: 'guest checkout',
    items: [],
    currency: 'USD',
    totalMinor: 4200,
    dueNowMinor: 4200,
    cardEnding: '4242',
    address: null,
    commitments: [],
    generic: { guest: true, contactEmail: ALIAS, items: ['Celadon mug × 2'], payment: 'Visa ending in 4242' },
  };
}

const runtime: ConstructorParameters<typeof BrowserQueue>[1] = {
  async pageForJob(): Promise<never> {
    throw new Error('No page in an outcome test');
  },
  async connection(): Promise<never> {
    throw new Error('No browser in an outcome test');
  },
  async closeJob() {},
  onDisconnected: () => () => undefined,
};

let main: Session;

async function policy(agentGroupIds?: readonly string[]): Promise<void> {
  fs.mkdirSync(`${root}/browser`, { recursive: true });
  fs.writeFileSync(
    `${root}/browser/policy.json`,
    JSON.stringify(
      agentGroupIds ? { schemaVersion: 2, enabled: true, agentGroupIds } : { schemaVersion: 1, enabled: true },
    ),
    { mode: 0o600 },
  );
}

/** A live errand that `source` opened, with its lazily created job. */
async function errand(source: string, name: string): Promise<{ session: Session; job: BrowserJob }> {
  const session = (await resolveSystemSession('browser-p', `system:a2a:${source}:${name}`)).session;
  const job = await new BrowserStore().jobForSession(session);
  if (!job) throw new Error('The errand was not admitted');
  return { session, job };
}

/** What the host wrote into a session, oldest first. */
async function notes(session: Session): Promise<string[]> {
  return (
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox
        .getInboundHistory(50)
        .map((message) => (JSON.parse(message.content) as { text: string }).text)
        .reverse(),
    )) ?? []
  );
}
const unconfirmedNotes = async (session: Session): Promise<string[]> =>
  (await notes(session)).filter((text) => text.includes('so it is unconfirmed'));

/** An approved press of `job`'s checkout whose page proved nothing: its authority and its attempt, in progress. */
async function press(job: BrowserJob, name: string, site = SITE, watchId?: string): Promise<string> {
  const at = new Date().toISOString();
  await getDb().run(
    `INSERT INTO gws_ea_browser_authorities
     (id,job_id,kind,state,facts_json,bounds_json,exception_ids_json,attempt_id,expires_at,created_at,commit_started_at,watch_id)
     VALUES(?,?,?,'committing',?,'{}','[]',?,?,?,?,?)`,
    `authority-${name}`,
    job.id,
    watchId ? 'watch' : 'checkout',
    JSON.stringify(checkout(site)),
    `attempt-${name}`,
    new Date(Date.now() + 86_400_000).toISOString(),
    at,
    at,
    watchId ?? null,
  );
  await getDb().run(
    'INSERT INTO gws_ea_browser_purchase_attempts(id,authority_id,job_id,site,facts_json,attempted_at,account_key) VALUES(?,?,?,?,?,?,?)',
    `attempt-${name}`,
    `authority-${name}`,
    job.id,
    site,
    JSON.stringify(checkout(site)),
    at,
    ALIAS,
  );
  return `attempt-${name}`;
}
/** A press that ended with no page proof: unconfirmed. */
async function unconfirmed(job: BrowserJob, name: string, site = SITE, watchId?: string): Promise<string> {
  const id = await press(job, name, site, watchId);
  expect(await new PurchaseAuthorityStore().unconfirm(id)).toEqual({
    status: 'unconfirmed',
    attempt_id: id,
    repeat_safe: false,
  });
  return id;
}

const record = (
  thread: string,
  attemptId: string,
  outcome: 'placed' | 'not_placed',
  source: 'email' | 'principal',
  from: Session = main,
) => recordPurchaseOutcome({ thread, attempt_id: attemptId, outcome, source }, from);

const attempt = (id: string) =>
  getDb().get<{ resolution: string | null; resolution_source: string | null; merchant_record_id: string | null }>(
    'SELECT resolution,resolution_source,merchant_record_id FROM gws_ea_browser_purchase_attempts WHERE id = ?',
    id,
  );
const authority = (attemptId: string) =>
  getDb().get<{ state: string; outcome_json: string | null; notified_at: string | null }>(
    'SELECT state,outcome_json,notified_at FROM gws_ea_browser_authorities WHERE attempt_id = ?',
    attemptId,
  );
const blocks = () => getDb().all<{ site: string }>('SELECT site FROM gws_ea_browser_purchase_blocks ORDER BY site');

beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await policy();
  vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', `${root}/browser/policy.json`);
  await runMigrations(await initTestDb());
  for (const id of ['main-p', 'browser-p', 'desk-p'])
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
    principalDisplayName: 'Morgan',
    principalTimezone: 'America/Los_Angeles',
    mainAgentGroupId: 'main-p',
    principalEmails: ['morgan@example.test'],
  });
  await getDb().run('UPDATE gws_ea_profile SET browser_agent_group_id = ? WHERE singleton = 1', 'browser-p');
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: new Date().toISOString() });
  await upsertUserDm({
    user_id: PRINCIPAL,
    channel_type: 'gchat',
    messaging_group_id: 'mg-principal',
    resolved_at: new Date().toISOString(),
  });
  await bindVerifiedPrincipalUser(PRINCIPAL, new Date().toISOString());
  main = (await resolveSession('main-p', 'mg-principal', null, 'agent-shared')).session;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a purchase with no page proof', () => {
  it('is unconfirmed once, told to its delegating group once, and holds back only the next purchase on its site', async () => {
    const { job } = await errand('main-p', 'mugs');
    const id = await unconfirmed(job, 'mugs');
    // Unconfirming again changes and tells nothing.
    await new PurchaseAuthorityStore().unconfirm(id);
    await notifyPendingUnconfirmed();
    const told = await unconfirmedNotes(main);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(
      /^Browser job system:a2a:main-p:mugs: the purchase on pottery\.example for \$42\.00, pressed .+ Los Angeles time, has no page proving whether it went through, so it is unconfirmed \(attempt attempt-mugs\)\./u,
    );
    expect(await authority(id)).toMatchObject({ state: 'unknown' });
    expect(JSON.parse((await authority(id))!.outcome_json!)).toEqual({
      status: 'unconfirmed',
      attempt_id: id,
      repeat_safe: false,
    });
    expect(await attempt(id)).toEqual({ resolution: null, resolution_source: null, merchant_record_id: null });
    expect(await blocks()).toEqual([{ site: SITE }]);
    const store = new PurchaseAuthorityStore();
    expect(await store.waitsOnEarlier(SITE)).toBe(true);
    expect(await store.waitsOnEarlier('table.example')).toBe(false);
    // The card's one-attempt exception names it.
    expect(await store.waitsOnEarlier(SITE, [id])).toBe(false);
    expect((await readBrowserJob(job.thread_id))?.unconfirmed).toEqual([
      {
        attempt_id: id,
        what: 'purchase on pottery.example',
        total: '$42.00',
        pressed: expect.stringMatching(/ Los Angeles time$/u),
      },
    ]);
  });

  it('keeps its notice for the sweep while main cannot be reached, then tells it once', async () => {
    await getDb().run('DELETE FROM user_dms');
    const { job } = await errand('main-p', 'mugs');
    const id = await unconfirmed(job, 'mugs');
    expect(await unconfirmedNotes(main)).toEqual([]);
    expect(await getDb().get('SELECT notified_at FROM gws_ea_browser_purchase_attempts WHERE id = ?', id)).toEqual({
      notified_at: null,
    });
    await upsertUserDm({
      user_id: PRINCIPAL,
      channel_type: 'gchat',
      messaging_group_id: 'mg-principal',
      resolved_at: new Date().toISOString(),
    });
    await notifyPendingUnconfirmed();
    await notifyPendingUnconfirmed();
    expect(await unconfirmedNotes(main)).toHaveLength(1);
  });

  it('answers in_progress while its press is still settling, and refuses an attempt that is not the job’s', async () => {
    const { job } = await errand('main-p', 'mugs');
    const id = await press(job, 'mugs');
    expect(await record(job.thread_id, id, 'placed', 'email')).toEqual({
      status: 'in_progress',
      thread: job.thread_id,
    });
    expect(await attempt(id)).toMatchObject({ resolution: null });
    const other = await errand('main-p', 'bowls');
    await expect(record(other.job.thread_id, id, 'placed', 'email')).rejects.toThrow(
      "That job made no purchase with that attempt id: use the id the job's state shows.",
    );
    await expect(record(job.thread_id, 'attempt-invented', 'placed', 'email')).rejects.toThrow(
      "That job made no purchase with that attempt id: use the id the job's state shows.",
    );
  });
});

describe('main recording an unconfirmed purchase', () => {
  it('records placed from the order email, settling the authority, the block and the waiting job together', async () => {
    const { job } = await errand('main-p', 'mugs');
    const waiting = await errand('main-p', 'plates');
    const id = await unconfirmed(job, 'mugs');
    const store = new PurchaseAuthorityStore();
    expect(await store.waitOnEarlier(waiting.job.id, SITE)).toBe(true);
    expect(await record(job.thread_id, id, 'placed', 'email')).toEqual({
      status: 'recorded',
      thread: job.thread_id,
      outcome: 'placed',
      source: 'email',
    });
    // A resolution without a merchant record is valid for the email source.
    expect(await attempt(id)).toEqual({
      resolution: 'committed',
      resolution_source: 'email',
      merchant_record_id: null,
    });
    const settled = await authority(id);
    expect(settled).toMatchObject({ state: 'committed', notified_at: expect.any(String) });
    expect(JSON.parse(settled!.outcome_json!)).toEqual({
      status: 'placed',
      source: 'email',
      attempt_id: id,
      repeat_safe: false,
    });
    expect(await blocks()).toEqual([]);
    expect(await store.waitsOnEarlier(SITE)).toBe(false);
    // The waiting errand is woken once; the errand that made it hears nothing of main's own answer.
    const woken = (await notes(waiting.session)).filter((text) => text.includes('browser_site_available'));
    expect(woken).toHaveLength(1);
    expect(JSON.parse(woken[0])).toMatchObject({ type: 'browser_site_available', job: waiting.job.id, site: SITE });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_waiters')).toEqual([]);
    expect(
      (await notes((await getSession(job.browser_session_id))!)).filter((text) => text.includes('"placed"')),
    ).toEqual([]);
    expect((await readBrowserJob(job.thread_id))?.unconfirmed).toBeUndefined();
  });

  it('records not placed from the principal, leaving the authority spent and the answer for the next card', async () => {
    const { job } = await errand('main-p', 'mugs');
    const id = await unconfirmed(job, 'mugs');
    expect(await record(job.thread_id, id, 'not_placed', 'principal')).toMatchObject({ status: 'recorded' });
    expect(await attempt(id)).toEqual({
      resolution: 'not_committed',
      resolution_source: 'principal',
      merchant_record_id: null,
    });
    expect(await authority(id)).toMatchObject({ state: 'revoked' });
    expect(await blocks()).toEqual([]);
    const store = new PurchaseAuthorityStore();
    expect(await store.recordedNotPlaced(SITE)).toEqual([{ id, attemptedAt: expect.any(String), source: 'principal' }]);
    await store.markRecordedShown(await store.recordedNotPlaced(SITE), 'card-next');
    expect(await store.recordedNotPlaced(SITE)).toEqual([]);
  });

  it('returns the recorded result to a later recording and never overwrites it', async () => {
    const { job } = await errand('main-p', 'mugs');
    const id = await unconfirmed(job, 'mugs');
    await record(job.thread_id, id, 'not_placed', 'principal');
    expect(await record(job.thread_id, id, 'not_placed', 'email')).toEqual({
      status: 'already_recorded',
      thread: job.thread_id,
      outcome: 'not_placed',
      source: 'principal',
    });
    const placed = await errand('main-p', 'bowls');
    const other = await unconfirmed(placed.job, 'bowls', 'bowls.example');
    await record(placed.job.thread_id, other, 'placed', 'email');
    expect(await record(placed.job.thread_id, other, 'not_placed', 'principal')).toEqual({
      status: 'already_recorded',
      thread: placed.job.thread_id,
      outcome: 'placed',
      source: 'email',
    });
    expect(await attempt(id)).toMatchObject({ resolution: 'not_committed', resolution_source: 'principal' });
    expect(await attempt(other)).toMatchObject({ resolution: 'committed', resolution_source: 'email' });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_incidents')).toEqual([]);
  });

  it('lets exactly one of two racing recordings win, and gives the other the recorded result', async () => {
    const { job } = await errand('main-p', 'mugs');
    const id = await unconfirmed(job, 'mugs');
    const answers = await Promise.all([
      record(job.thread_id, id, 'placed', 'email'),
      record(job.thread_id, id, 'placed', 'principal'),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual(['already_recorded', 'recorded']);
    const winner = answers.find((answer) => answer.status === 'recorded')!;
    expect(answers.find((answer) => answer.status === 'already_recorded')).toMatchObject({
      outcome: 'placed',
      source: winner.source,
    });
    expect(await attempt(id)).toMatchObject({ resolution: 'committed', resolution_source: winner.source });
  });

  it('raises a duplicate incident when the order email confirms a purchase recorded not placed, told at once and once', async () => {
    const { job } = await errand('main-p', 'mugs');
    const id = await unconfirmed(job, 'mugs');
    await record(job.thread_id, id, 'not_placed', 'principal');
    expect(await record(job.thread_id, id, 'placed', 'email')).toEqual({
      status: 'possible_duplicate',
      thread: job.thread_id,
      recorded: { outcome: 'not_placed', source: 'principal' },
    });
    expect(
      await getDb().all('SELECT kind,site,job_id,attempt_id,evidence_key,notified_at FROM gws_ea_browser_incidents'),
    ).toEqual([
      {
        kind: 'late_confirmation',
        site: SITE,
        job_id: job.id,
        attempt_id: id,
        evidence_key: id,
        notified_at: expect.any(String),
      },
    ]);
    expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', job.id)).toEqual({
      cancelled: 1,
    });
    const duplicate = (await notes(main)).filter((text) => text.includes('bought it twice'));
    expect(duplicate).toEqual([
      `Browser job ${job.thread_id} was stopped: the purchase on ${SITE} recorded as not placed was reported placed after all, so the principal may have bought it twice. Tell the principal now.`,
    ]);
    // The recorded outcome stands, and the same report again raises and tells nothing new.
    expect(await record(job.thread_id, id, 'placed', 'principal')).toMatchObject({ status: 'possible_duplicate' });
    expect(await attempt(id)).toMatchObject({ resolution: 'not_committed', resolution_source: 'principal' });
    expect(await getDb().all('SELECT id FROM gws_ea_browser_incidents')).toHaveLength(1);
    expect((await notes(main)).filter((text) => text.includes('bought it twice'))).toHaveLength(1);
  });

  it("refuses another group's attempt, and lets main record one whose group's browser access was removed", async () => {
    await policy(['main-p', 'desk-p']);
    const desk = (await resolveSession('desk-p', null, null, 'agent-shared')).session;
    const { job } = await errand('desk-p', 'aprons');
    const id = await unconfirmed(job, 'aprons');
    await expect(record(job.thread_id, id, 'placed', 'email')).rejects.toThrow(
      'No browser job of yours exists for that thread.',
    );
    const mine = await errand('main-p', 'mugs');
    const own = await unconfirmed(mine.job, 'mugs', 'mugs.example');
    await expect(record(mine.job.thread_id, own, 'placed', 'email', desk)).rejects.toThrow(
      'No browser job of yours exists for that thread.',
    );
    // Removed from the browser setting: its errand's notice and its answer fall to main.
    await policy(['main-p']);
    expect(
      await guard(purchaseOutcomeGuard, { actor: { kind: 'agent', agentGroupId: 'desk-p' }, payload: {} }),
    ).toMatchObject({ effect: 'deny' });
    const removed = await unconfirmed(job, 'aprons-again', 'aprons.example');
    expect((await unconfirmedNotes(main)).some((text) => text.includes(removed))).toBe(true);
    expect(await record(job.thread_id, id, 'not_placed', 'principal')).toMatchObject({ status: 'recorded' });
    expect(await attempt(id)).toMatchObject({ resolution: 'not_committed', resolution_source: 'principal' });
    // Main records whatever the setting lists.
    await policy(['desk-p']);
    expect(
      await guard(purchaseOutcomeGuard, { actor: { kind: 'agent', agentGroupId: 'main-p' }, payload: {} }),
    ).toMatchObject({ effect: 'allow' });
  });
});

describe('page evidence', () => {
  it('never resolves a second attempt, paid or free, from an order number already used under the same contact email', async () => {
    const { job } = await errand('main-p', 'mugs');
    const store = new PurchaseAuthorityStore();
    const page = (id: string, account: string | null) => ({
      placed: true,
      source: 'page' as const,
      evidence: { reference: id },
      record: { id, account },
    });
    const first = await press(job, 'first');
    const second = await press((await errand('main-p', 'bowls')).job, 'second');
    expect(await store.resolve(first, page('HP-1042', ALIAS))).toMatchObject({ status: 'resolved' });
    expect(await store.resolve(second, page('HP-1042', ALIAS))).toMatchObject({ status: 'record_used' });
    expect(await attempt(second)).toEqual({ resolution: null, resolution_source: null, merchant_record_id: null });
    // A free booking keyed by the same contact email is held to the same order numbers.
    await getDb().run(
      `INSERT INTO gws_ea_browser_free_attempts(id,job_id,request_id,site,account_key,facts_json,attempted_at)
       VALUES('free-attempt-table',?,'free-request',?,?,'{}',?)`,
      job.id,
      SITE,
      ALIAS,
      new Date().toISOString(),
    );
    expect(await store.resolve('free-attempt-table', page('HP-1042', ALIAS))).toMatchObject({ status: 'record_used' });
    // Under another contact email the same number is another order.
    expect(await store.resolve(second, page('HP-1042', 'morgan.ellery@example.test'))).toMatchObject({
      status: 'resolved',
    });
    expect(await attempt(second)).toMatchObject({ resolution: 'committed', merchant_record_id: 'HP-1042' });
  });
});

describe('the begin rule', () => {
  /** A live checkout authority of `job` on the pottery shop, its card naming `exceptions`, ready to press. */
  async function approved(job: BrowserJob, session: Session, name: string, exceptions: string[]) {
    const store = new BrowserStore();
    await store.accept(job, session, name, 'purchase', {}, 90_000);
    const request = (await store.pending(job.id)).find((candidate) => candidate.request_id === name)!;
    await store.start(request.id);
    const queue = new BrowserQueue(store, runtime);
    const context = (await queue.contextForRequest(request.id))!;
    await getDb().run(
      `INSERT INTO gws_ea_browser_authorities
       (id,job_id,kind,state,facts_json,bounds_json,exception_ids_json,attempt_id,expires_at,created_at)
       VALUES(?,?,'checkout','live',?,'{}',?,?,?,?)`,
      `authority-${name}`,
      job.id,
      JSON.stringify(checkout()),
      JSON.stringify(exceptions),
      `attempt-${name}`,
      new Date(Date.now() + 86_400_000).toISOString(),
      new Date().toISOString(),
    );
    await getDb().run(
      "INSERT INTO gws_ea_browser_site_leases VALUES(?,?,'purchase',?) ON CONFLICT(site) DO UPDATE SET job_id = excluded.job_id",
      SITE,
      job.id,
      new Date().toISOString(),
    );
    return context;
  }

  it('makes another purchase on the site wait unless its card’s one-attempt exception names the earlier one', async () => {
    const earlier = await errand('main-p', 'mugs');
    const id = await unconfirmed(earlier.job, 'mugs');
    const { session, job } = await errand('main-p', 'plates');
    const store = new PurchaseAuthorityStore();
    const plain = await approved(job, session, 'plain', []);
    await expect(store.begin(plain, 'authority-plain', checkout())).rejects.toThrow(PurchaseAuthorityError);
    expect(await store.get('authority-plain')).toMatchObject({ state: 'live' });
    await getDb().run("UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE id = 'authority-plain'");
    const excepted = await approved(job, session, 'excepted', [id]);
    expect(await store.begin(excepted, 'authority-excepted', checkout())).toMatchObject({ state: 'committing' });
    expect(await attempt('attempt-excepted')).toMatchObject({ resolution: null });
  });
});

describe('a watch booking', () => {
  async function watched(job: BrowserJob, id: string): Promise<string> {
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO gws_ea_browser_watches
       (id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at)
       VALUES(?,?,?,'recipe',1,'{}',?,'{}','booking',?,?,?)`,
      id,
      job.id,
      SITE,
      id,
      at,
      at,
      at,
    );
    const attemptId = await press(job, id, SITE, id);
    await getDb().run(
      `INSERT INTO gws_ea_browser_watch_job_claims(job_id,state,watch_id,authority_id,attempt_id,request_id,commit_started_at)
       VALUES(?,'committing',?,?,?,'request',?)`,
      job.id,
      id,
      `authority-${id}`,
      attemptId,
      at,
    );
    await new PurchaseAuthorityStore().unconfirm(attemptId);
    return attemptId;
  }
  const state = (job: BrowserJob, watch: string) =>
    Promise.all([
      getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id = ?', watch),
      getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id = ?', job.id),
    ]);

  it('resolved through main leaves its watch and claim final: booked, or the claim spent and the watch cancelled', async () => {
    const booked = await errand('main-p', 'friday');
    const bookedAttempt = await watched(booked.job, 'friday');
    expect(await state(booked.job, 'friday')).toEqual([{ status: 'outcome_unknown' }, { state: 'unknown' }]);
    await record(booked.job.thread_id, bookedAttempt, 'placed', 'principal');
    expect(await state(booked.job, 'friday')).toEqual([{ status: 'booked' }, { state: 'booked' }]);
    expect(await authority(bookedAttempt)).toMatchObject({ state: 'committed' });
    // Only a booking its page proved promotes its recipe.
    expect(await getDb().all('SELECT * FROM gws_ea_browser_watch_recipe_links')).toEqual([]);
    const missed = await errand('main-p', 'saturday');
    const missedAttempt = await watched(missed.job, 'saturday');
    await record(missed.job.thread_id, missedAttempt, 'not_placed', 'principal');
    expect(await state(missed.job, 'saturday')).toEqual([{ status: 'cancelled' }, { state: 'unknown' }]);
    expect(await authority(missedAttempt)).toMatchObject({ state: 'revoked' });
  });
});

describe('a region watch (KTD20)', () => {
  /** A region watch of `job` on `site`, armed, with the job's one booking still to spend. */
  async function regionWatch(job: BrowserJob, id: string, site: string): Promise<void> {
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,region_json,region_baseline,region_marked_at,status,created_at,updated_at,next_check_at)
       VALUES(?,?,?,'recipe',1,'{}',?,'{}','{}','No tables',?,'armed',?,?,?)`,
      id,
      job.id,
      site,
      id,
      at,
      at,
      at,
      at,
    );
    await getDb().run("INSERT INTO gws_ea_browser_watch_job_claims(job_id,state) VALUES(?,'available')", job.id);
  }
  /** The claim a commit on the watched site takes, in its own transaction, as the press's does. */
  const claim = (job: BrowserJob, site: string, attemptId: string) =>
    getDb().transaction(() =>
      claimRegionWatchCommit(getDb(), {
        jobId: job.id,
        site,
        attemptId,
        requestId: 'request',
        at: new Date().toISOString(),
      }),
    );
  const watchState = (job: BrowserJob, watch: string) =>
    Promise.all([
      getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id = ?', watch),
      getDb().get<{ state: string; finished_at: string | null }>(
        'SELECT state,finished_at FROM gws_ea_browser_watch_job_claims WHERE job_id = ?',
        job.id,
      ),
    ]);

  it('ends the watch a free table claimed once its outcome is unconfirmed, then once main records it, and never again', async () => {
    const { job } = await errand('main-p', 'larder');
    await regionWatch(job, 'larder', 'larder.example');
    await getDb().run(
      `INSERT INTO gws_ea_browser_free_attempts(id,job_id,request_id,site,account_key,facts_json,attempted_at)
       VALUES('free-attempt-larder',?,'free-request','larder.example',?,?,?)`,
      job.id,
      ALIAS,
      JSON.stringify({ site: 'larder.example', control: { label: 'Reserve' }, booking: { partySize: 2 } }),
      new Date().toISOString(),
    );
    await claim(job, 'larder.example', 'free-attempt-larder');
    expect((await watchState(job, 'larder'))[0]).toEqual({ status: 'booking' });
    await new PurchaseAuthorityStore().unconfirm('free-attempt-larder');
    expect(await watchState(job, 'larder')).toEqual([
      { status: 'outcome_unknown' },
      { state: 'unknown', finished_at: expect.any(String) },
    ]);
    expect(await record(job.thread_id, 'free-attempt-larder', 'placed', 'principal')).toMatchObject({
      status: 'recorded',
    });
    const [watch, finished] = await watchState(job, 'larder');
    expect(watch).toEqual({ status: 'booked' });
    expect(finished).toMatchObject({ state: 'booked' });
    expect(await record(job.thread_id, 'free-attempt-larder', 'placed', 'email')).toMatchObject({
      status: 'already_recorded',
    });
    expect(await watchState(job, 'larder')).toEqual([{ status: 'booked' }, finished]);
  });

  it('ends the watch a card booking claimed when its step shows it was not placed', async () => {
    const { job } = await errand('main-p', 'osteria');
    await regionWatch(job, 'osteria', 'osteria.example');
    const id = await press(job, 'osteria', 'osteria.example');
    await claim(job, 'osteria.example', id);
    expect(
      await new PurchaseAuthorityStore().resolve(id, {
        placed: false,
        source: 'step',
        evidence: { declined: 'Your card was declined.' },
      }),
    ).toMatchObject({ status: 'resolved' });
    expect(await watchState(job, 'osteria')).toEqual([
      { status: 'cancelled' },
      { state: 'unknown', finished_at: expect.any(String) },
    ]);
    expect(await authority(id)).toMatchObject({ state: 'revoked' });
  });
});

describe('a restart', () => {
  it('unconfirms presses it cut off, re-blocks only unresolved sites, and wakes jobs waiting on a resolved one', async () => {
    const { job } = await errand('main-p', 'mugs');
    const waiting = await errand('main-p', 'plates');
    const resolved = await unconfirmed(job, 'mugs');
    await record(job.thread_id, resolved, 'not_placed', 'principal');
    const cutOff = await press(job, 'bowls', 'bowls.example');
    // A stale block and a wait on the resolved site, as an older host may have left them.
    await getDb().run(
      'INSERT INTO gws_ea_browser_purchase_blocks(site,created_at) VALUES(?,?)',
      SITE,
      new Date().toISOString(),
    );
    await getDb().run(
      'INSERT INTO gws_ea_browser_purchase_waiters(site,job_id,requested_at) VALUES(?,?,?)',
      SITE,
      waiting.job.id,
      new Date().toISOString(),
    );
    await recoverBrowserPurchases(new BrowserQueue(new BrowserStore(), runtime));
    expect(await blocks()).toEqual([{ site: 'bowls.example' }]);
    expect(await authority(cutOff)).toMatchObject({ state: 'unknown' });
    expect((await unconfirmedNotes(main)).filter((text) => text.includes(cutOff))).toHaveLength(1);
    expect(await attempt(resolved)).toMatchObject({ resolution: 'not_committed' });
    expect((await notes(waiting.session)).filter((text) => text.includes('browser_site_available'))).toHaveLength(1);
    await recoverBrowserPurchases(new BrowserQueue(new BrowserStore(), runtime));
    expect(await blocks()).toEqual([{ site: 'bowls.example' }]);
    expect((await unconfirmedNotes(main)).filter((text) => text.includes(cutOff))).toHaveLength(1);
  });
});
