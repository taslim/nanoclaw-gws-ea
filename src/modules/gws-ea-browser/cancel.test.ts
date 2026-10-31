import { configureBrowserAccess } from './testing/browser-access.js';
import { useAvailableBrowser } from './testing/browser-runtime.js';
import { createBrowserQueue } from './index.js';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), 'browser-cancel-tests');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));
import { closeDb, createAgentGroup, createPendingApproval, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { resolveSystemSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore } from './db.js';
import {
  browserDelegateGuard,
  cancelBrowserJob,
  cancelBrowserJobInTransaction,
  finishBrowserJobCancellation,
  finishRequestedCancellation,
  readBrowserJob,
  registerBrowserCancellationDelivery,
  sweepBrowserJobSessions,
} from './cancel.js';
import { getSession, updateSession } from '../../db/sessions.js';
import { guard } from '../../guard/index.js';
import { browserWatchesMigration } from './migration.js';
import { deliverAction as send, refusal } from './testing/delivery-answer.js';
import { loginsPageGuard } from './logins-link.js';
import { credentialAttempts } from './credential-attempts.js';
import { browserAvailability } from './availability.js';

let session: Session;
beforeEach(async () => {
  useAvailableBrowser();
  await runMigrations(await initTestDb());
  for (const id of ['main', 'browser'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1`,
    'main',
    'browser',
  );
  session = (await resolveSystemSession('browser', 'system:a2a:main:cancel')).session;
  const queue = createBrowserQueue(new BrowserStore(), {
    pageForJob: async () => {
      throw new Error('Cancellation must not open a page');
    },
    connection: async () => {
      throw new Error('Cancellation must not launch Chrome');
    },
    closeJob: async () => undefined,
    withActivity: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    onDisconnected: () => () => undefined,
  });
  registerBrowserCancellationDelivery(() => queue);
});
afterEach(async () => {
  delete process.env.GWS_EA_BROWSER_ROOT;
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

it('admits canonical main alone and denies browser delegation while the operator policy is disabled', async () => {
  const file = `${root}/browser`;
  fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });

  process.env.GWS_EA_BROWSER_ROOT = file;
  expect(
    await guard(browserDelegateGuard, { actor: { kind: 'agent', agentGroupId: 'main' }, payload: {} }),
  ).toMatchObject({ effect: 'allow' });
  for (const agentGroupId of ['browser', 'external', 'other'])
    expect(await guard(browserDelegateGuard, { actor: { kind: 'agent', agentGroupId }, payload: {} })).toMatchObject({
      effect: 'deny',
    });
  vi.stubEnv('GWS_EA_BROWSER_ROOT', '');
  expect(
    await guard(browserDelegateGuard, { actor: { kind: 'agent', agentGroupId: 'main' }, payload: {} }),
  ).toMatchObject({ effect: 'deny' });
});

it('creates the job on first reference and derives state freshly from held work', async () => {
  expect(await readBrowserJob(session.thread_id!)).toMatchObject({ state: 'idle' });
  await getDb().run(
    "INSERT INTO gws_ea_browser_site_leases VALUES (?, ?, 'idle', ?)",
    'merchant.example',
    session.thread_id,
    new Date().toISOString(),
  );
  expect(await readBrowserJob(session.thread_id!)).toMatchObject({
    state: 'working',
    held_sites: ['merchant.example'],
  });
});

it('exposes only the live host-recorded principal sign-in site for a code request', async () => {
  const thread = session.thread_id!;
  await readBrowserJob(thread);
  const at = new Date().toISOString();
  const expires = new Date(Date.now() + 60_000).toISOString();
  await getDb().run(
    `INSERT INTO gws_ea_browser_sign_in_claims
     (id,job_id,source,origin,domain,binding_json,since_at,expires_at,state)
     VALUES(?,?,'principal','https://login.merchant.example','merchant.example','{}',?,?,'waiting')`,
    'principal-wait',
    thread,
    at,
    expires,
  );
  expect(await readBrowserJob(thread)).toMatchObject({
    state: 'idle',
    waiting_sign_in: { site: 'merchant.example', origin: 'https://login.merchant.example', expires_at: expires },
  });
  await getDb().run("UPDATE gws_ea_browser_sign_in_claims SET state = 'finished'");
  expect(await readBrowserJob(thread)).not.toHaveProperty('waiting_sign_in');
});

it('cancels at the host, releases site leases and refuses later browser use', async () => {
  const thread = session.thread_id!;
  await readBrowserJob(thread);
  await getDb().run(
    "INSERT INTO gws_ea_browser_site_leases VALUES (?, ?, 'active', ?)",
    'merchant.example',
    thread,
    new Date().toISOString(),
  );
  expect(await cancelBrowserJob(thread)).toMatchObject({ status: 'cancelled', thread });
  expect(await getDb().all('SELECT * FROM gws_ea_browser_site_leases')).toEqual([]);
  expect(await readBrowserJob(thread)).toMatchObject({ state: 'cancelled' });
  expect(await new BrowserStore().jobForSession(session)).toBeUndefined();
  expect(await cancelBrowserJob(thread)).toMatchObject({ status: 'already_cancelled' });
  await expect(cancelBrowserJob('system:a2a:someone:foreign')).rejects.toThrow('browser job');
});

it.each(['idle', 'cancelled'] as const)(
  'closes a %s session at fourteen days while retaining its durable job',
  async (state) => {
    const now = new Date();
    const old = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const job = (await readBrowserJob(session.thread_id!))!.job;
    if (state === 'cancelled') await cancelBrowserJob(job.thread_id);
    await getDb().run('UPDATE gws_ea_browser_jobs SET created_at = ?, updated_at = ? WHERE id = ?', old, old, job.id);
    await getDb().run('UPDATE sessions SET created_at = ?, last_active = ? WHERE id = ?', old, old, session.id);
    await sweepBrowserJobSessions(new Date(now.getTime() - 1).toISOString());
    expect((await getSession(session.id))?.status).toBe('active');
    await sweepBrowserJobSessions(now.toISOString());
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await new BrowserStore().getJob(job.id)).toBeDefined();
  },
);

it('keeps a session whose activity changed after inspection and never closes a pending request', async () => {
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const store = new BrowserStore();
  const job = (await readBrowserJob(session.thread_id!))!.job;
  await store.db.run('UPDATE gws_ea_browser_jobs SET created_at = ?, updated_at = ? WHERE id = ?', old, old, job.id);
  await store.db.run('UPDATE sessions SET created_at = ?, last_active = ? WHERE id = ?', old, old, session.id);
  const transaction = store.db.transaction.bind(store.db);
  const spy = vi.spyOn(store.db, 'transaction').mockImplementationOnce(async (operation) => {
    await updateSession(session.id, { last_active: new Date().toISOString() });
    return transaction(operation);
  });
  await sweepBrowserJobSessions(new Date().toISOString(), store);
  spy.mockRestore();
  expect((await getSession(session.id))?.status).toBe('active');
  await store.accept(job, session, 'queued', 'browser', {}, 90_000);
  await store.db.run('UPDATE gws_ea_browser_jobs SET updated_at = ? WHERE id = ?', old, job.id);
  await updateSession(session.id, { last_active: old });
  await sweepBrowserJobSessions(new Date().toISOString(), store);
  expect((await getSession(session.id))?.status).toBe('active');
});

it('derives awaiting and watching state and cancels watches before a later tick can book', async () => {
  if (!(await getDb().hasTable('gws_ea_browser_watches'))) await browserWatchesMigration.up(getDb());
  const job = (await readBrowserJob(session.thread_id!))!.job;
  const at = new Date().toISOString();
  await getDb().run(
    `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at) VALUES('watch',?,'resy.com','recipe',1,'{}','key','{}','awaiting_principal',?,?,?)`,
    job.id,
    at,
    at,
    at,
  );
  expect(await readBrowserJob(job.id)).toMatchObject({ state: 'awaiting_principal' });
  await getDb().run("UPDATE gws_ea_browser_watches SET status='armed'");
  expect(await readBrowserJob(job.id)).toMatchObject({ state: 'watching' });
  await cancelBrowserJob(job.id);
  expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'watch')).toEqual({
    status: 'cancelled',
  });
});

describe('cancelling a job with credential attempts', () => {
  const insert = async (id: string, jobId: string, phase: string, exposedAt: string | null): Promise<void> => {
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO gws_ea_browser_credential_attempts(id,kind,job_id,instance_id,account_id,vault_id,origin,site,username,phase,created_at,updated_at,exposed_at)
       VALUES(?,'signup',?,'instance','account','vault','https://accounts.shop.example','shop.example',?,?,?,?,?)`,
      id,
      jobId,
      `${id}@example.com`,
      phase,
      at,
      at,
      exposedAt,
    );
  };
  const phases = async () =>
    Object.fromEntries(
      (
        await getDb().all<{ id: string; phase: string }>(
          'SELECT id, phase FROM gws_ea_browser_credential_attempts ORDER BY id',
        )
      ).map((row) => [row.id, row.phase]),
    );
  const closed: string[] = [];
  const queue = () =>
    createBrowserQueue(new BrowserStore(), {
      pageForJob: async () => {
        throw new Error('This test must not open a page');
      },
      connection: async () => {
        throw new Error('This test must not launch Chrome');
      },
      closeJob: async (jobId: string) => {
        closed.push(jobId);
      },
      withActivity: <T>(operation: () => Promise<T>): Promise<T> => operation(),
      onDisconnected: () => () => undefined,
    });

  it('abandons every attempt nothing was disclosed for, and cancels at once', async () => {
    const job = (await readBrowserJob(session.thread_id!))!.job;
    await insert('preparing', job.id, 'preparing', null);
    await insert('saved', job.id, 'saved', null);
    await insert('finished', job.id, 'finalized', new Date().toISOString());
    expect(await cancelBrowserJob(job.thread_id)).toMatchObject({ status: 'cancelled' });
    expect(await phases()).toEqual({ finished: 'finalized', preparing: 'rejected', saved: 'rejected' });
  });

  it.each(['exposed', 'awaiting_verification', 'unknown', 'confirmed'])(
    'answers in_progress while a disclosed attempt is %s, keeps its site, and finishes once it settles',
    async (phase) => {
      const job = (await readBrowserJob(session.thread_id!))!.job;
      await getDb().run(
        "INSERT INTO gws_ea_browser_site_leases VALUES ('shop.example', ?, 'active', ?)",
        job.id,
        new Date().toISOString(),
      );
      await insert('disclosed', job.id, phase, new Date().toISOString());
      await insert('unused', job.id, 'saved', null);
      expect(await cancelBrowserJob(job.thread_id)).toMatchObject({ status: 'in_progress' });
      expect(
        await getDb().get('SELECT cancelled, cancel_requested FROM gws_ea_browser_jobs WHERE id = ?', job.id),
      ).toEqual({ cancelled: 0, cancel_requested: 1 });
      expect(await phases()).toEqual({ disclosed: phase, unused: 'rejected' });
      expect(await readBrowserJob(job.thread_id)).toMatchObject({ state: 'working', held_sites: ['shop.example'] });
      // Still held: nothing finishes the cancellation yet.
      await finishRequestedCancellation(job.id, queue());
      expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', job.id)).toEqual({
        cancelled: 0,
      });
      await getDb().run("UPDATE gws_ea_browser_credential_attempts SET phase = 'rejected' WHERE id = 'disclosed'");
      await finishRequestedCancellation(job.id, queue());
      expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', job.id)).toEqual({
        cancelled: 1,
      });
      expect(await getDb().all('SELECT * FROM gws_ea_browser_site_leases')).toEqual([]);
      expect(closed).toContain(job.id);
      expect(await cancelBrowserJob(job.thread_id)).toMatchObject({ status: 'already_cancelled' });
    },
  );

  it('interrupts pending work and closes its page even when candidate cleanup fails', async () => {
    const job = (await readBrowserJob(session.thread_id!))!.job;
    await insert('unused-cleanup', job.id, 'saved', null);
    const activeQueue = queue();
    await activeQueue.store.accept(job, session, 'cancel-cleanup', 'browser', {}, 90_000);
    const result = await activeQueue.store.db.transaction(() =>
      cancelBrowserJobInTransaction(job.thread_id, activeQueue.store),
    );
    const retire = vi.spyOn(credentialAttempts, 'retireCandidates').mockRejectedValue(new Error('Vault unavailable'));
    try {
      await expect(finishBrowserJobCancellation(result, activeQueue)).rejects.toThrow('Vault unavailable');
      expect(await activeQueue.store.pending(job.id)).toEqual([]);
      expect(closed).toContain(job.id);
      expect(await activeQueue.store.undelivered(job.id)).toEqual([]);
    } finally {
      retire.mockRestore();
    }
  });

  it('never closes the session of a job whose credential attempt is unresolved', async () => {
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const job = (await readBrowserJob(session.thread_id!))!.job;
    await insert('unresolved', job.id, 'unknown', old);
    await getDb().run('UPDATE gws_ea_browser_jobs SET created_at = ?, updated_at = ? WHERE id = ?', old, old, job.id);
    await getDb().run('UPDATE sessions SET created_at = ?, last_active = ? WHERE id = ?', old, old, session.id);
    await sweepBrowserJobSessions(new Date().toISOString());
    expect((await getSession(session.id))?.status).toBe('active');
    await getDb().run("UPDATE gws_ea_browser_credential_attempts SET phase = 'rejected'");
    await sweepBrowserJobSessions(new Date().toISOString());
    expect((await getSession(session.id))?.status).toBe('closed');
  });
});

describe('an explicitly granted second agent group', () => {
  const bounds = {
    venue_id: 'bistro-ellery',
    party_size: 2,
    window_start: '2026-11-06T19:00:00-05:00',
    window_end: '2026-11-06T21:00:00-05:00',
  };

  let main: Session;
  let research: Session;
  let other: Session;
  let mainThread: string;
  let researchThread: string;
  beforeEach(async () => {
    for (const id of ['research', 'other'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    const file = `${root}/browser`;
    fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });

    await configureBrowserAccess(file, ['research']);
    main = (await resolveSystemSession('main', 'system:test:main')).session;
    research = (await resolveSystemSession('research', 'system:test:research')).session;
    other = (await resolveSystemSession('other', 'system:test:other')).session;
    mainThread = session.thread_id!;
    researchThread = (await resolveSystemSession('browser', 'system:a2a:research:errand')).session.thread_id!;
  });

  it('records its jobs as its own and lets it manage them like main', async () => {
    expect((await readBrowserJob(researchThread))?.job.source_agent_group_id).toBe('research');
    expect(await send(research, 'reservation_bounds', { thread: researchThread, ...bounds })).toMatchObject({
      ok: true,
      data: { status: 'recorded', thread: researchThread },
    });
    expect(await send(research, 'cancel_job', { thread: researchThread })).toMatchObject({
      ok: true,
      data: { status: 'cancelled' },
    });
    expect(await readBrowserJob(mainThread)).toMatchObject({ state: 'idle' });
  });

  it('cancels only its own job while Chrome is unavailable, retaining access and ownership checks', async () => {
    const job = (await readBrowserJob(researchThread))!.job;
    await readBrowserJob(mainThread);
    const at = new Date().toISOString();
    await getDb().run(
      `INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at) VALUES('offline-watch',?,'resy.com','recipe',1,'{}','key','{}','awaiting_principal',?,?,?)`,
      job.id,
      at,
      at,
      at,
    );
    await createPendingApproval({
      approval_id: 'offline-watch-card',
      request_id: 'offline-watch-setup',
      action: 'browser_watch_setup',
      payload: JSON.stringify({ watchId: 'offline-watch' }),
      created_at: at,
      title: 'Watch for a table?',
      options_json: '[]',
    });
    vi.mocked(browserAvailability).mockResolvedValue({ available: false, reason: 'chrome-missing' });

    expect(refusal(await send(main, 'cancel_job', { thread: researchThread }))).toBe(
      'No delegated browser job exists for that thread.',
    );
    expect(refusal(await send(other, 'cancel_job', { thread: researchThread }))).toBe(
      'Only an agent with browser access may manage browser jobs.',
    );
    expect(refusal(await send(session, 'cancel_job', { thread: researchThread }))).toBe(
      'Only an agent with browser access may manage browser jobs.',
    );
    await configureBrowserAccess(`${root}/browser`, []);
    expect(refusal(await send(research, 'cancel_job', { thread: researchThread }))).toBe(
      'Only an agent with browser access may manage browser jobs.',
    );
    await configureBrowserAccess(`${root}/browser`, ['research']);
    const cancelled = await send(research, 'cancel_job', { thread: researchThread });
    expect(refusal(cancelled)).toBeUndefined();
    expect(cancelled).toMatchObject({
      ok: true,
      data: { status: 'cancelled', thread: researchThread },
    });
    expect(await readBrowserJob(mainThread)).toMatchObject({ state: 'idle' });
    expect(await readBrowserJob(researchThread)).toMatchObject({ state: 'cancelled' });
    expect(await getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id=?', 'offline-watch')).toEqual({
      status: 'cancelled',
    });
    expect(
      await getDb().get('SELECT approval_id FROM pending_approvals WHERE approval_id=?', 'offline-watch-card'),
    ).toBeUndefined();
    expect(
      await guard(browserDelegateGuard, {
        actor: { kind: 'agent', agentGroupId: research.agent_group_id },
        payload: {},
      }),
    ).toMatchObject({ effect: 'deny' });
  });

  it("never lets main reach its jobs, nor it main's", async () => {
    for (const [from, thread] of [
      [main, researchThread],
      [research, mainThread],
    ] as const) {
      expect(refusal(await send(from, 'cancel_job', { thread }))).toBe(
        'No delegated browser job exists for that thread.',
      );
      expect(refusal(await send(from, 'reservation_bounds', { thread, ...bounds }))).toBe(
        'No live browser job of yours exists for that thread.',
      );
    }
    expect(await readBrowserJob(researchThread)).toMatchObject({ state: 'idle' });
    expect(await readBrowserJob(mainThread)).toMatchObject({ state: 'idle' });
    expect(await getDb().all('SELECT job_id FROM gws_ea_browser_reservation_bounds')).toEqual([]);
  });

  it("lets it obtain the principal's logins page, as main may", async () => {
    for (const [agentGroupId, effect] of [
      ['research', 'allow'],
      ['main', 'allow'],
      ['other', 'deny'],
    ] as const)
      expect(await guard(loginsPageGuard, { actor: { kind: 'agent', agentGroupId }, payload: {} })).toMatchObject({
        effect,
      });
  });

  it('refuses an ungranted group while main always retains authority', async () => {
    expect(refusal(await send(other, 'cancel_job', { thread: researchThread }))).toBe(
      'Only an agent with browser access may manage browser jobs.',
    );

    await configureBrowserAccess(`${root}/browser`, ['research']);
    expect(
      await guard(browserDelegateGuard, { actor: { kind: 'agent', agentGroupId: 'main' }, payload: {} }),
    ).toMatchObject({ effect: 'allow' });
  });
});
