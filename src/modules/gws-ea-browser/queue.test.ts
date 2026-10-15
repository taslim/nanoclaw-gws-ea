import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), 'browser-queue-tests');
});

vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: root,
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { resolveSystemSession } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { Session } from '../../types.js';
import { forbidden } from '../../cli/delivery-action.js';
import { guard } from '../../guard/index.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore, browserRequestId, markBrowserRequestCommitStarted } from './db.js';
import { BrowserQueue, browserRequestGuard, registerBrowserQueuedAction } from './queue.js';
import { setBrowserAdmissionReady } from './group.js';

let store: BrowserStore;
let session: Session;
beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  for (const id of ['main-q', 'browser-q', 'external-q'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
    'main-q',
    'browser-q',
  );
  session = (await resolveSystemSession('browser-q', 'system:a2a:main-q:errand')).session;
  store = new BrowserStore();
});
afterEach(async () => {
  setBrowserAdmissionReady(false);
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

it('rechecks operator enablement for a previously live browser job', async () => {
  const file = `${root}/browser/policy.json`;
  fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }), { mode: 0o600 });
  vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', file);
  setBrowserAdmissionReady(true);
  const input = {
    actor: { kind: 'agent' as const, agentGroupId: session.agent_group_id, sessionId: session.id },
    payload: {},
  };
  expect(await guard(browserRequestGuard, input)).toMatchObject({ effect: 'allow' });
  setBrowserAdmissionReady(false);
  expect(await guard(browserRequestGuard, input)).toMatchObject({ effect: 'deny' });
  setBrowserAdmissionReady(true);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: false, credentialMode: 'email' }));
  expect(await guard(browserRequestGuard, input)).toMatchObject({ effect: 'deny' });
});

const runtime = {
  async pageForJob(): Promise<never> {
    throw new Error('This test must not launch Chrome');
  },
  async connection(): Promise<never> {
    throw new Error('This test must not launch Chrome');
  },
  async closeJob(): Promise<void> {},
  onDisconnected(): () => void {
    return () => undefined;
  },
};
function responses(): unknown[] {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    return (
      db.prepare("SELECT content FROM messages_in WHERE id LIKE 'action-resp-%'").all() as { content: string }[]
    ).map((r) => JSON.parse(r.content) as unknown);
  } finally {
    db.close();
  }
}

it('preserves a sanitized native refusal before commit and uncertainty after a commit marker', async () => {
  registerBrowserQueuedAction('queue_refusal_fixture', {
    validate: (content) => ({ marked: content.marked === true }),
    async execute(context, payload) {
      if (payload.marked) await context.markCommitStarted();
      throw forbidden('The bound authentication field is no longer safe.');
    },
  });
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  await queue.accept('queue_refusal_fixture', {}, session, 'refused-before');
  await queue.accept('queue_refusal_fixture', { marked: true }, session, 'refused-after');
  await queue.idle();
  expect(responses()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestId: 'refused-before',
        frame: {
          id: 'refused-before',
          ok: false,
          error: { code: 'forbidden', message: 'The bound authentication field is no longer safe.' },
        },
      }),
      expect.objectContaining({
        requestId: 'refused-after',
        frame: expect.objectContaining({
          ok: true,
          data: expect.objectContaining({ reason: 'outcome_unknown', repeat_safe: false }),
        }),
      }),
    ]),
  );
  await queue.stop();
});

it('blocks the whole site before delivering an uncertain marked purchase answer', async () => {
  registerBrowserQueuedAction('queue_marked_purchase_fixture', {
    validate: () => ({}),
    async execute(context) {
      await context.markCommitStarted();
      const at = new Date().toISOString();
      await store.db.run(
        `INSERT INTO gws_ea_browser_authorities
         (id,job_id,kind,state,facts_json,bounds_json,exception_ids_json,attempt_id,expires_at,created_at,commit_request_id)
         VALUES(?,?,'checkout','committing',?,'{}','[]',?,?,?,?)`,
        'marked-authority',
        context.job.id,
        JSON.stringify({ site: 'amazon.com' }),
        'marked-attempt',
        new Date(Date.now() + 60_000).toISOString(),
        at,
        context.request.id,
      );
      await store.db.run(
        `INSERT INTO gws_ea_browser_purchase_attempts(id,authority_id,job_id,site,facts_json,attempted_at)
         VALUES(?,?,?,'amazon.com',?,?)`,
        'marked-attempt',
        'marked-authority',
        context.job.id,
        JSON.stringify({ site: 'amazon.com' }),
        at,
      );
      throw new Error('The browser disconnected after the durable commit marker');
    },
    async deliverAnswer() {
      expect(
        await store.db.get('SELECT site FROM gws_ea_browser_purchase_blocks WHERE site = ?', 'amazon.com'),
      ).toEqual({ site: 'amazon.com' });
    },
  });
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  await queue.accept('queue_marked_purchase_fixture', {}, session, 'marked-purchase');
  await queue.idle();
  expect(await store.db.get('SELECT site FROM gws_ea_browser_purchase_blocks WHERE site = ?', 'amazon.com')).toEqual({
    site: 'amazon.com',
  });
  expect(await store.request(browserRequestId(session.id, 'marked-purchase'))).toMatchObject({
    delivered_at: expect.any(String),
  });
  await queue.stop();
});

it('retries a delegated terminal answer from its durable frame after startup interruption', async () => {
  let unavailable = true;
  const delivered: unknown[] = [];
  let executions = 0;
  registerBrowserQueuedAction('queue_terminal_answer_fixture', {
    validate: () => ({}),
    async execute() {
      executions++;
      return { status: 'completed' };
    },
    async deliverAnswer(_request, frame) {
      delivered.push(frame);
      if (unavailable) throw new Error('The main mailbox is unavailable');
    },
  });
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected browser job');
  await store.accept(job, session, 'terminal-recovery', 'queue_terminal_answer_fixture', {}, 90_000);
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  const id = browserRequestId(session.id, 'terminal-recovery');
  const first = await store.request(id);
  expect(first).toMatchObject({ answered_at: expect.any(String), delivered_at: null });
  expect(delivered).not.toEqual([]);
  expect(delivered[0]).toMatchObject({ id: 'terminal-recovery', data: { reason: 'interrupted' } });
  expect(responses()).toHaveLength(1);
  unavailable = false;
  await queue.retryAnswers();
  expect(await store.request(id)).toMatchObject({ delivered_at: expect.any(String) });
  expect(delivered.at(-1)).toEqual(delivered[0]);
  expect(responses()).toHaveLength(1);
  expect(executions).toBe(0);
  await queue.stop();
});

it('wakes an interrupted internal purchase after restart without consuming or pressing its authority', async () => {
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected browser job');
  const at = new Date().toISOString();
  await store.db.run(
    `INSERT INTO gws_ea_browser_authorities
     (id,job_id,kind,state,facts_json,bounds_json,exception_ids_json,attempt_id,expires_at,created_at)
     VALUES('restart-live',?,'checkout','live',?,'{}','[]','restart-attempt',?,?)`,
    job.id,
    JSON.stringify({ site: 'amazon.com' }),
    new Date(Date.now() + 60_000).toISOString(),
    at,
  );
  const queue = new BrowserQueue(store, runtime);
  await queue.accept('browser_purchase_commit', { authority_id: 'restart-live' }, session, 'internal-restart');
  await queue.start();
  await queue.idle();
  const notes = (): Array<{ kind: string; trigger: number; content: string }> => {
    const inbound = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
    try {
      return inbound
        .prepare("SELECT kind,trigger,content FROM messages_in WHERE id LIKE 'browser-commit-%'")
        .all() as Array<{ kind: string; trigger: number; content: string }>;
    } finally {
      inbound.close();
    }
  };
  expect(notes()).toHaveLength(1);
  expect(notes()[0]).toMatchObject({ kind: 'chat', trigger: 1 });
  const envelope = JSON.parse(notes()[0].content) as { text: string };
  expect(JSON.parse(envelope.text)).toMatchObject({
    type: 'browser_purchase_outcome',
    reason: 'interrupted',
    authority_id: 'restart-live',
    authority_unspent: true,
    safe_to_rebuild: true,
  });
  await queue.retryAnswers();
  expect(notes()).toHaveLength(1);
  expect(
    await store.db.get('SELECT state,commit_started_at FROM gws_ea_browser_authorities WHERE id = ?', 'restart-live'),
  ).toEqual({ state: 'live', commit_started_at: null });
  expect(await store.db.all('SELECT * FROM gws_ea_browser_purchase_attempts')).toEqual([]);
  await queue.stop();
});

it('refuses main, external-email, a foreign thread and cancelled browser jobs', async () => {
  const queue = new BrowserQueue(store, runtime);
  for (const id of ['main-q', 'external-q']) {
    const other = (await resolveSystemSession(id, 'system:a2a:main-q:other')).session;
    await expect(queue.accept('browser', {}, other, 'r1')).rejects.toThrow('live browser job');
  }
  const foreign = (await resolveSystemSession('browser-q', 'system:a2a:external-q:other')).session;
  await expect(queue.accept('browser', {}, foreign, 'r2')).rejects.toThrow('live browser job');
  await store.jobForSession(session);
  await getDb().run('UPDATE gws_ea_browser_jobs SET cancelled = 1');
  await expect(queue.accept('browser', {}, session, 'r3')).rejects.toThrow('live browser job');
});

it('accepts without waiting, never executes replays, and persists a timed answer once', async () => {
  let release!: () => void;
  let runs = 0;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  registerBrowserQueuedAction('queue_fixture', {
    validate: () => ({}),
    async execute() {
      runs++;
      await waiting;
      return { status: 'completed' };
    },
  });
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  await queue.accept('queue_fixture', {}, session, 'r-running');
  await queue.accept('queue_fixture', {}, session, 'r-running');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(runs).toBe(1);
  expect(responses()).toEqual([]);
  release();
  await queue.idle();
  await queue.accept('queue_fixture', {}, session, 'r-running');
  await queue.idle();
  expect(runs).toBe(1);
  const request = await store.request(browserRequestId(session.id, 'r-running'));
  expect(request).toMatchObject({
    accepted_at: expect.any(String),
    started_at: expect.any(String),
    answered_at: expect.any(String),
    delivered_at: expect.any(String),
  });
  expect(responses()).toHaveLength(1);
  await queue.stop();
});

it('answers pre-crash requests interrupted or unknown once before new workers start', async () => {
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected real browser job');
  await store.accept(job, session, 'r-interrupted', 'browser', {}, 90_000);
  await store.accept(job, session, 'r-unknown', 'browser', {}, 90_000);
  await markBrowserRequestCommitStarted(getDb(), browserRequestId(session.id, 'r-unknown'));
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  await queue.stop();
  const restarted = new BrowserQueue(store, runtime);
  await restarted.start();
  expect(responses()).toHaveLength(2);
  expect(responses()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestId: 'r-interrupted',
        frame: expect.objectContaining({ data: expect.objectContaining({ reason: 'interrupted', repeat_safe: true }) }),
      }),
      expect.objectContaining({
        requestId: 'r-unknown',
        frame: expect.objectContaining({
          data: expect.objectContaining({ reason: 'outcome_unknown', repeat_safe: false }),
        }),
      }),
    ]),
  );
  await restarted.stop();
});

it('expires a request waiting behind a batch without executing it', async () => {
  let runs = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  registerBrowserQueuedAction('queue_deadline_fixture', {
    validate: () => ({}),
    async execute() {
      runs++;
      await held;
      return { status: 'completed' };
    },
  });
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  await queue.accept('queue_deadline_fixture', {}, session, 'long');
  await queue.accept('queue_deadline_fixture', { budget_ms: 1 }, session, 'expired');
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await queue.idle();
  expect(runs).toBe(1);
  expect(responses()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestId: 'expired',
        frame: expect.objectContaining({ data: expect.objectContaining({ reason: 'timeout', repeat_safe: true }) }),
      }),
    ]),
  );
  await queue.stop();
});

it('does not strand acceptance at the final empty-read boundary', async () => {
  let runs = 0;
  registerBrowserQueuedAction('queue_boundary_fixture', {
    validate: () => ({}),
    async execute() {
      runs++;
      return { status: 'completed' };
    },
  });
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  const pending = store.nextPending.bind(store);
  let inserted = false;
  vi.spyOn(store, 'nextPending').mockImplementation(async (jobId) => {
    const result = await pending(jobId);
    if (jobId && !result && !inserted) {
      inserted = true;
      await queue.accept('queue_boundary_fixture', {}, session, 'boundary-second');
    }
    return result;
  });
  await queue.accept('queue_boundary_fixture', {}, session, 'boundary-first');
  await queue.idle();
  expect(runs).toBe(2);
  expect(responses()).toHaveLength(2);
  await queue.stop();
});

it('keeps a timed-out job locked until its late operation settles and forbids any late page access', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lateRefused = false;
  registerBrowserQueuedAction('queue_late_fixture', {
    validate: () => ({}),
    async execute(context) {
      await held;
      try {
        await context.page();
      } catch (_error) {
        lateRefused = true;
      }
      return { status: 'completed' };
    },
  });
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  await queue.accept('queue_late_fixture', { budget_ms: 5 }, session, 'late-1');
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(responses()).toHaveLength(1);
  expect(responses()).toEqual([
    expect.objectContaining({
      frame: expect.objectContaining({ data: expect.objectContaining({ reason: 'timeout', repeat_safe: false }) }),
    }),
  ]);
  release();
  await queue.idle();
  expect(lateRefused).toBe(true);
  expect(responses()).toHaveLength(1);
  await queue.stop();
});

it('recovers orphaned started requests without executing them or spinning the drain', async () => {
  let runs = 0;
  registerBrowserQueuedAction('queue_orphan_fixture', {
    validate: () => ({}),
    async execute() {
      runs++;
      return { status: 'completed' };
    },
  });
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected browser job');
  for (const id of ['orphan-before', 'orphan-marked']) {
    await store.accept(job, session, id, 'queue_orphan_fixture', {}, 90_000);
    await store.start(browserRequestId(session.id, id));
  }
  await markBrowserRequestCommitStarted(store.db, browserRequestId(session.id, 'orphan-marked'));
  const pending = store.nextPending.bind(store);
  let reads = 0;
  vi.spyOn(store, 'nextPending').mockImplementation(async (jobId) => {
    if (++reads > 8) throw new Error('Bounded test detected a spinning drain');
    return pending(jobId);
  });
  queue.wake(job.id);
  await queue.idle();
  expect(runs).toBe(0);
  expect(responses()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestId: 'orphan-before',
        frame: expect.objectContaining({
          data: expect.objectContaining({ reason: 'interrupted', repeat_safe: false }),
        }),
      }),
      expect.objectContaining({
        requestId: 'orphan-marked',
        frame: expect.objectContaining({
          data: expect.objectContaining({ reason: 'outcome_unknown', repeat_safe: false }),
        }),
      }),
    ]),
  );
  expect(responses()).toHaveLength(2);
  await queue.stop();
});

it('defers a failed durable answer until the periodic retry instead of immediately spinning', async () => {
  let runs = 0;
  registerBrowserQueuedAction('queue_disk_fixture', {
    validate: () => ({}),
    async execute() {
      runs++;
      return { status: 'completed' };
    },
  });
  const queue = new BrowserQueue(store, runtime);
  await queue.start();
  const pending = store.nextPending.bind(store);
  let reads = 0;
  const pendingSpy = vi.spyOn(store, 'nextPending').mockImplementation(async (jobId) => {
    if (++reads > 8) throw new Error('Bounded test detected repeated immediate retries');
    return pending(jobId);
  });
  const answerSpy = vi.spyOn(store, 'answer').mockRejectedValue(new Error('Disk full'));
  await queue.accept('queue_disk_fixture', {}, session, 'disk-failure');
  await queue.idle().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(reads).toBeLessThanOrEqual(2);
  expect(runs).toBe(1);
  expect(responses()).toEqual([]);
  answerSpy.mockRestore();
  pendingSpy.mockRestore();
  await queue.retryAnswers();
  await queue.idle();
  expect(runs).toBe(1);
  expect(responses()).toHaveLength(1);
  expect(responses()).toEqual([
    expect.objectContaining({
      frame: expect.objectContaining({ data: expect.objectContaining({ reason: 'interrupted' }) }),
    }),
  ]);
  await queue.stop();
});

it('does not queue a signed-out check behind an active errand and acquires its job set atomically', async () => {
  const queue = new BrowserQueue(store, runtime);
  let release!: () => void;
  const held = queue.withJobLock(
    'checkout-owner',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const operation = vi.fn(async () => 'ran');
  expect(await queue.tryWithJobLocks(['watch', 'checkout-owner'], operation)).toEqual({ acquired: false });
  expect(operation).not.toHaveBeenCalled();
  expect(await queue.tryWithJobLocks(['watch'], operation)).toEqual({ acquired: true, value: 'ran' });
  release();
  await held;
  expect(await queue.tryWithJobLocks(['watch', 'checkout-owner'], operation)).toEqual({ acquired: true, value: 'ran' });
});

it('refuses ordinary site contention before creating a signed-out Chrome context', async () => {
  const queue = new BrowserQueue(store, runtime);
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Missing native job');
  const ownerSession = (await resolveSystemSession('browser-q', 'system:a2a:main-q:checkout')).session;
  const owner = await store.jobForSession(ownerSession);
  if (!owner) throw new Error('Missing native checkout job');
  await queue.leases.acquire(owner.id, 'https://resy.com');
  const { runBrowserWatchCheck } = await import('./watch-runtime.js');
  expect(
    await runBrowserWatchCheck(
      queue,
      {
        id: 'check',
        jobId: job.id,
        site: 'resy.com',
        recipeId: 'recipe',
        parameters: {},
        venueId: 'venue',
        partySize: 2,
      },
      new AbortController().signal,
    ),
  ).toEqual({ status: 'site_busy' });
  expect(await getDb().get('SELECT job_id,state FROM gws_ea_browser_site_leases WHERE site=?', 'resy.com')).toEqual({
    job_id: owner.id,
    state: 'active',
  });
});

it('keeps a pending checkout exclusive while its owning job is executing', async () => {
  const queue = new BrowserQueue(store, runtime);
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Missing native job');
  const ownerSession = (await resolveSystemSession('browser-q', 'system:a2a:main-q:checkout')).session;
  const owner = await store.jobForSession(ownerSession);
  if (!owner) throw new Error('Missing native checkout job');
  await queue.leases.acquire(owner.id, 'https://resy.com');
  await queue.leases.holdForPurchase(owner.id, 'resy.com');
  const at = new Date().toISOString();
  await getDb().run(
    `INSERT INTO gws_ea_browser_purchase_cards(id,job_id,request_id,status,facts_json,bounds_json,exception_ids_json,expires_at,created_at) VALUES('held-card',?,'card-request','open',?,'{}','[]',?,?)`,
    owner.id,
    JSON.stringify({ site: 'resy.com' }),
    new Date(Date.now() + 60_000).toISOString(),
    at,
  );
  let release!: () => void;
  const held = queue.withJobLock(
    owner.id,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  try {
    const { runBrowserWatchCheck } = await import('./watch-runtime.js');
    expect(
      await runBrowserWatchCheck(
        queue,
        {
          id: 'check',
          jobId: job.id,
          site: 'resy.com',
          recipeId: 'recipe',
          parameters: {},
          venueId: 'venue',
          partySize: 2,
        },
        new AbortController().signal,
      ),
    ).toEqual({ status: 'site_busy' });
    expect(await getDb().get('SELECT job_id,state FROM gws_ea_browser_site_leases WHERE site=?', 'resy.com')).toEqual({
      job_id: owner.id,
      state: 'purchase',
    });
  } finally {
    release();
    await held;
  }
});
