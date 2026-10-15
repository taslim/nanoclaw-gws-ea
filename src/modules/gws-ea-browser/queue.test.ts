import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: '/private/tmp/browser-queue-tests',
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { resolveSystemSession } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { Session } from '../../types.js';
import { forbidden } from '../../cli/delivery-action.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore, browserRequestId, markBrowserRequestCommitStarted } from './db.js';
import { BrowserQueue, registerBrowserQueuedAction } from './queue.js';

let store: BrowserStore;
let session: Session;
const root = '/private/tmp/browser-queue-tests';
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
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
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
