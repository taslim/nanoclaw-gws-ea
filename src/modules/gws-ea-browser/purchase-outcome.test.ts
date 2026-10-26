import { useAvailableBrowser } from './testing/browser-runtime.js';
import { claimRegionWatchCommit } from './watch-state.js';
import { createBrowserQueue } from './index.js';
import { holdBrowserRequest, stopHeldBrowserRequests } from './testing/held-request.js';
/**
 * Purchase outcomes against a real central DB and real session DBs: an attempt with no page
 * proof is unconfirmed and told once, main records its outcome through the one resolve function, and every edge
 * of the purchase state machine past the press settles the authority, the watch, the block and the waiting jobs.
 */
import fs from 'node:fs';

import Database from 'better-sqlite3';
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

import type { ResponseFrame } from '../../cli/frame.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { PurchaseAuthorityError, PurchaseAuthorityStore } from './authority.js';
import { readBrowserJob } from './cancel.js';
import { BrowserStore, type BrowserJob } from './db.js';
import { GENERIC_FLOW_ID, type PurchaseFacts } from './fingerprint.js';
import { SiteLeaseStore } from './leases.js';
import { errand, notes, principalReachable, seedAssistant, configurePrincipalBrowser } from './principal-fixture.js';
import { notifyPendingIncidents } from './incidents.js';
import { notifyPendingUnconfirmed, recordPurchaseOutcome } from './purchase-outcome.js';
import { recoverBrowserPurchases } from './purchase.js';

import { type BrowserQueue } from './queue.js';

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
const policy = (agentGroupIds?: readonly string[]): Promise<string> => configurePrincipalBrowser(root, agentGroupIds);

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
) =>
  recordPurchaseOutcome({ thread, attempt_id: attemptId, outcome, source }, from, () =>
    createBrowserQueue(new BrowserStore(), runtime),
  );

let requests = 0;
/** Sends record_purchase_outcome as the agent's tool does, through its guarded delivery, and reads the one answer. */
async function recordAsTool(from: Session, fields: Record<string, unknown>): Promise<ResponseFrame> {
  const requestId = `outcome-${++requests}`;
  await getDeliveryAction('record_purchase_outcome')!(
    { ...fields, action: 'record_purchase_outcome', requestId },
    from,
  );
  const db = new Database(inboundDbPath(from.agent_group_id, from.id), { readonly: true });
  try {
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(`action-resp-${requestId}`) as {
      content: string;
    };
    return (JSON.parse(row.content) as { frame: ResponseFrame }).frame;
  } finally {
    db.close();
  }
}

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
  useAvailableBrowser();
  fs.rmSync(root, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  main = await seedAssistant();
  vi.stubEnv('GWS_EA_BROWSER_ROOT', await policy());
  await principalReachable();
});

afterEach(async () => {
  await stopHeldBrowserRequests();
  vi.restoreAllMocks();
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
    await principalReachable();
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
      "That job made no purchase with that attempt id: use the attempt id the host's unconfirmed notice gave.",
    );
    await expect(record(job.thread_id, 'attempt-invented', 'placed', 'email')).rejects.toThrow(
      "That job made no purchase with that attempt id: use the attempt id the host's unconfirmed notice gave.",
    );
    // A delegator other than main reads no matter state, so the id it is pointed to is the one its notice carried.
    await expect(
      recordPurchaseOutcome({ thread: job.thread_id, attempt_id: id, outcome: 'unknown', source: 'email' }, main, () =>
        createBrowserQueue(new BrowserStore(), runtime),
      ),
    ).rejects.toThrow(
      "record_purchase_outcome needs the job thread, the attempt id the host's unconfirmed notice gave, placed or not_placed, and the source: email or principal.",
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

  it('raises a duplicate incident when the order email confirms a purchase recorded not placed, alarming once, in the answer', async () => {
    const { job } = await errand('main-p', 'mugs');
    const id = await unconfirmed(job, 'mugs');
    await record(job.thread_id, id, 'not_placed', 'principal');
    const answer = await record(job.thread_id, id, 'placed', 'email');
    expect(answer).toMatchObject({
      status: 'possible_duplicate',
      thread: job.thread_id,
      recorded: { outcome: 'not_placed', source: 'principal' },
    });
    expect(answer.message).toBe(
      `The purchase on ${SITE} for $42.00 was recorded as not placed and is now reported placed after all, so the principal may have bought it twice. The host stopped this errand. Tell the principal now.`,
    );
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
    // The recorder heard it in its answer: no second alarm reaches it, now or from the sweep.
    await notifyPendingIncidents();
    expect((await notes(main)).filter((text) => text.includes('bought it twice'))).toEqual([]);
    // The recorded outcome stands, and a later report raises nothing new: it asks the recorder to make sure the
    // principal has heard, which a second telling never harms.
    const again = await record(job.thread_id, id, 'placed', 'principal');
    expect(again).toMatchObject({ status: 'possible_duplicate' });
    expect(again.message).toBe(
      `The purchase on ${SITE} for $42.00 was already reported as a possible duplicate, and the host stopped this errand then. The principal may have bought it twice, so make sure they have heard.`,
    );
    expect(await attempt(id)).toMatchObject({ resolution: 'not_committed', resolution_source: 'principal' });
    expect(await getDb().all('SELECT id FROM gws_ea_browser_incidents')).toHaveLength(1);
  });

  it('still alarms in the answer to a replay of the request that raised the duplicate incident', async () => {
    const { job } = await errand('main-p', 'mugs');
    const id = await unconfirmed(job, 'mugs');
    await record(job.thread_id, id, 'not_placed', 'principal');
    // The host raised the incident for this request, then stopped before its answer was written.
    const fields = { thread: job.thread_id, attempt_id: id, outcome: 'placed', source: 'email' };
    await recordPurchaseOutcome(
      { ...fields, action: 'record_purchase_outcome', requestId: 'outcome-replayed' },
      main,
      () => createBrowserQueue(new BrowserStore(), runtime),
    );
    expect(await getDb().get('SELECT notified_at FROM gws_ea_browser_incidents WHERE job_id = ?', job.id)).toEqual({
      notified_at: expect.any(String),
    });
    // The restarted host delivers the same request again: its one answer carries the alarm.
    await getDeliveryAction('record_purchase_outcome')!(
      { ...fields, action: 'record_purchase_outcome', requestId: 'outcome-replayed' },
      main,
    );
    const inbound = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
    try {
      const row = inbound
        .prepare('SELECT content FROM messages_in WHERE id = ?')
        .get('action-resp-outcome-replayed') as {
        content: string;
      };
      expect((JSON.parse(row.content) as { frame: ResponseFrame }).frame).toMatchObject({
        ok: true,
        data: {
          status: 'possible_duplicate',
          message: `The purchase on ${SITE} for $42.00 was recorded as not placed and is now reported placed after all, so the principal may have bought it twice. The host stopped this errand. Tell the principal now.`,
        },
      });
    } finally {
      inbound.close();
    }
    expect(await getDb().all('SELECT id FROM gws_ea_browser_incidents')).toHaveLength(1);
  });

  it('tells a delegating group other than the recorder that its errand stopped, as information only', async () => {
    await policy(['main-p', 'desk-p']);
    const desk = (await resolveSession('desk-p', null, null, 'agent-shared')).session;
    const { session, job } = await errand('desk-p', 'aprons');
    await writeSessionMessage('browser-p', session.id, {
      id: 'desk-delegation',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'desk-p',
      channelType: 'agent',
      threadId: session.thread_id,
      content: JSON.stringify({ text: 'Order the aprons.' }),
      sourceSessionId: desk.id,
    });
    const id = await unconfirmed(job, 'aprons');
    // Removed from the browser setting, the desk's purchase falls to main to record.
    await policy(['main-p']);
    await record(job.thread_id, id, 'not_placed', 'principal');
    const answer = await record(job.thread_id, id, 'placed', 'email');
    expect(answer.message).toContain('Tell the principal now.');
    expect((await notes(main)).filter((text) => text.includes('bought it twice'))).toEqual([]);
    const told = (await notes(desk)).filter((text) => text.includes('was stopped'));
    expect(told).toEqual([
      `Browser job ${job.thread_id} was stopped: the purchase on ${SITE} recorded as not placed was reported placed after all. Main is telling the principal, so nothing more is needed from you.`,
    ]);
  });

  it('answers possible_duplicate with the incident told when the stopped job’s cleanup fails', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const duplicate = async (name: string, queue: BrowserQueue): Promise<BrowserJob> => {
      const { job } = await errand('main-p', name);
      const id = await unconfirmed(job, name);
      await record(job.thread_id, id, 'not_placed', 'principal');
      expect(
        await recordPurchaseOutcome(
          { thread: job.thread_id, attempt_id: id, outcome: 'placed', source: 'email' },
          main,
          () => queue,
        ),
      ).toMatchObject({ status: 'possible_duplicate' });
      // The incident is told before the cleanup that fails.
      expect(await getDb().get('SELECT notified_at FROM gws_ea_browser_incidents WHERE job_id = ?', job.id)).toEqual({
        notified_at: expect.any(String),
      });
      return job;
    };
    // Closing the stopped job's window, which releases its staged uploads, fails: a job waiting on its site still wakes.
    const leases = new SiteLeaseStore(getDb());
    const waiting = await errand('main-p', 'plates');
    const { job: mugs } = await errand('main-p', 'mugs');
    expect(await leases.acquire(mugs.id, `https://${SITE}/`)).toMatchObject({ acquired: true });
    expect(await leases.acquire(waiting.job.id, `https://${SITE}/`)).toMatchObject({ acquired: false });
    await duplicate(
      'mugs',
      createBrowserQueue(new BrowserStore(), {
        ...runtime,
        closeJob: () => Promise.reject(new Error('Staged upload removal failed')),
      }),
    );
    const woken = (await notes(waiting.session)).filter((text) => text.includes('browser_site_available'));
    expect(woken).toHaveLength(1);
    // Any other cleanup that fails after the incident is recorded and told leaves the answer standing.
    const failing = createBrowserQueue(new BrowserStore(), runtime);
    vi.spyOn(failing, 'wakeWaiters').mockRejectedValue(new Error('Mailbox unavailable'));
    const bowls = await duplicate('bowls', failing);
    expect(warned).toHaveBeenCalledWith(
      'A stopped browser job could not be cleaned up',
      expect.objectContaining({ job: bowls.id, error: 'Mailbox unavailable' }),
    );
  });

  it("refuses another group's attempt, and lets main record one whose group's browser access was removed", async () => {
    await policy(['main-p', 'desk-p']);
    const desk = (await resolveSession('desk-p', null, null, 'agent-shared')).session;
    const ask = (from: Session, thread: string, attemptId: string, outcome: 'placed' | 'not_placed') =>
      recordAsTool(from, { thread, attempt_id: attemptId, outcome, source: 'principal' });
    const refused = (message: string) => ({ ok: false, error: { code: 'forbidden', message } });
    const recorded = { ok: true, data: { status: 'recorded' } };
    const { job } = await errand('desk-p', 'aprons');
    const id = await unconfirmed(job, 'aprons');
    expect(await ask(main, job.thread_id, id, 'placed')).toMatchObject(
      refused('No browser job of yours exists for that thread.'),
    );
    const mine = await errand('main-p', 'mugs');
    const own = await unconfirmed(mine.job, 'mugs', 'mugs.example');
    expect(await ask(desk, mine.job.thread_id, own, 'placed')).toMatchObject(
      refused('No browser job of yours exists for that thread.'),
    );
    // Removed from the browser setting, it records nothing: its errand's notice and its answer fall to main.
    await policy(['main-p']);
    expect(await ask(desk, job.thread_id, id, 'placed')).toMatchObject(
      refused('Only an agent with browser access records a purchase outcome.'),
    );
    const removed = await unconfirmed(job, 'aprons-again', 'aprons.example');
    expect((await unconfirmedNotes(main)).some((text) => text.includes(removed))).toBe(true);
    expect(await ask(main, job.thread_id, id, 'not_placed')).toMatchObject(recorded);
    expect(await attempt(id)).toMatchObject({ resolution: 'not_committed', resolution_source: 'principal' });
    // Main records whatever the setting lists.
    await policy(['desk-p']);
    expect(await ask(main, mine.job.thread_id, own, 'placed')).toMatchObject(recorded);
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
    const { queue, context } = await holdBrowserRequest(store, runtime);
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
    return { queue, context };
  }

  it('makes another purchase on the site wait unless its card’s one-attempt exception names the earlier one', async () => {
    const earlier = await errand('main-p', 'mugs');
    const id = await unconfirmed(earlier.job, 'mugs');
    const { session, job } = await errand('main-p', 'plates');
    const store = new PurchaseAuthorityStore();
    const plain = await approved(job, session, 'plain', []);
    await expect(store.begin(plain.context, 'authority-plain', checkout())).rejects.toThrow(PurchaseAuthorityError);
    expect(await store.get('authority-plain')).toMatchObject({ state: 'live' });
    await getDb().run("UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE id = 'authority-plain'");
    await plain.queue.stop();
    const excepted = await approved(job, session, 'excepted', [id]);
    expect(await store.begin(excepted.context, 'authority-excepted', checkout())).toMatchObject({
      state: 'committing',
    });
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

describe('a region watch', () => {
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
    await recoverBrowserPurchases(createBrowserQueue(new BrowserStore(), runtime));
    expect(await blocks()).toEqual([{ site: 'bowls.example' }]);
    expect(await authority(cutOff)).toMatchObject({ state: 'unknown' });
    expect((await unconfirmedNotes(main)).filter((text) => text.includes(cutOff))).toHaveLength(1);
    expect(await attempt(resolved)).toMatchObject({ resolution: 'not_committed' });
    expect((await notes(waiting.session)).filter((text) => text.includes('browser_site_available'))).toHaveLength(1);
    await recoverBrowserPurchases(createBrowserQueue(new BrowserStore(), runtime));
    expect(await blocks()).toEqual([{ site: 'bowls.example' }]);
    expect((await unconfirmedNotes(main)).filter((text) => text.includes(cutOff))).toHaveLength(1);
  });
});
