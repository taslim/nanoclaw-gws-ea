import { repairBrowserWatchChecks } from './scheduler.js';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { browserActions, browserQueueFollowUps, recoverAndStartBrowserQueue } from './index.js';
import type { BrowserActions } from './actions.js';
import { BrowserStore, browserRequestId, markBrowserRequestCommitStarted, type BrowserJob } from './db.js';
import { BrowserQueue, browserRequestGuard } from './queue.js';
import { setBrowserAdmissionReady } from './group.js';
import { recoverCredentialRequest } from './credential-operations.js';
import * as signedOut from './signed-out.js';
import * as recipes from './recipes.js';
import { runBrowserWatchCheck } from './watch-runtime.js';
import type { ChromeConnection } from './connection.js';

let store: BrowserStore;
let session: Session;
let actions: BrowserActions;
beforeEach(async () => {
  actions = browserActions;
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
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true }), { mode: 0o600 });
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
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: false }));
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
function createQueue(runtimeArg: BrowserQueue['runtime']): BrowserQueue {
  return new BrowserQueue(store, runtimeArg, actions, browserQueueFollowUps);
}

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

it('persists observed HTTP response evidence with the exact request answer without network payloads', async () => {
  const events = new EventEmitter();
  const page = Object.assign(events, {
    context: () => ({ browser: () => ({ version: () => '155.0.0.0' }) }),
  }) as unknown as Page;
  actions = {
    ...actions,
    browser: {
      validate: () => ({}),
      async execute(context) {
        await context.page();
        const networkRequest = {
          url: () => 'https://fixture.example/private-secret-sentinel?token=secret-sentinel',
          method: () => 'GET',
          resourceType: () => 'document',
          redirectedFrom: () => null,
          headers: () => {
            throw new Error('Diagnostics must never read headers');
          },
          postData: () => {
            throw new Error('Diagnostics must never read bodies');
          },
        };
        events.emit('request', networkRequest);
        events.emit('response', { request: () => networkRequest, status: () => 403 });
        events.emit('requestfinished', networkRequest);
        return { status: 'completed' };
      },
    },
  };
  const queue = createQueue({ ...runtime, pageForJob: async () => page });
  await recoverAndStartBrowserQueue(queue);
  await queue.accept('browser', {}, session, 'diagnostic-response');
  await queue.idle();
  const request = await store.request(browserRequestId(session.id, 'diagnostic-response'));
  const answer: unknown = JSON.parse(request?.answer_json ?? 'null');
  expect(answer).toMatchObject({
    data: {
      diagnostics: {
        schema_version: 1,
        request_id: browserRequestId(session.id, 'diagnostic-response'),
        runtime: { chrome: '155.0.0.0', playwright: '1.64.0' },
        events: [
          { source: 'http_response', site: 'fixture.example', method: 'GET', resource: 'document', status: 403 },
        ],
      },
    },
  });
  expect(JSON.stringify(answer)).not.toContain('secret-sentinel');
  await queue.stop();
});

it('preserves a sanitized native refusal before commit and uncertainty after a commit marker', async () => {
  actions = {
    ...actions,
    browser: {
      validate: (content) => ({ marked: content.marked === true }),
      async execute(context, payload) {
        if (payload.marked) await context.markCommitStarted();
        throw forbidden('The bound authentication field is no longer safe.');
      },
    },
  };
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  await queue.accept('browser', {}, session, 'refused-before');
  await queue.accept('browser', { marked: true }, session, 'refused-after');
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
          data: expect.objectContaining({ reason: 'unconfirmed', repeat_safe: false }),
        }),
      }),
    ]),
  );
  await queue.stop();
});

it('returns an internal TypeError as a sanitized native error frame while preserving marked uncertainty', async () => {
  actions = {
    ...actions,
    browser: {
      validate: (content) => ({ marked: content.marked === true }),
      async execute(context, payload) {
        if (payload.marked) await context.markCommitStarted();
        throw new TypeError('private-runtime-sentinel https://example.com/?token=private');
      },
    },
  };
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  try {
    await queue.accept('browser', {}, session, 'type-error');
    await queue.accept('browser', { marked: true }, session, 'type-error-marked');
    await queue.idle();
    expect(responses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'type-error',
          frame: {
            id: 'type-error',
            ok: false,
            error: {
              code: 'handler-error',
              message: 'The browser action failed unexpectedly.',
              metadata: {
                diagnostics: expect.objectContaining({
                  request_id: browserRequestId(session.id, 'type-error'),
                  events: [expect.objectContaining({ source: 'runtime_error', category: 'execution' })],
                }),
              },
            },
          },
        }),
        expect.objectContaining({
          requestId: 'type-error-marked',
          frame: expect.objectContaining({
            ok: true,
            data: expect.objectContaining({ reason: 'unconfirmed', repeat_safe: false }),
          }),
        }),
      ]),
    );
    expect(JSON.stringify(responses())).not.toContain('private-runtime-sentinel');
  } finally {
    await queue.stop();
  }
});

it('blocks the whole site before delivering an uncertain marked purchase answer', async () => {
  actions = {
    ...actions,
    browser: {
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
    },
  };
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  await queue.accept('browser', {}, session, 'marked-purchase');
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
  actions = {
    ...actions,
    browser: {
      validate: () => ({}),
      async execute() {
        executions++;
        return { status: 'completed' };
      },
      async deliverAnswer(_request, frame) {
        delivered.push(frame);
        if (unavailable) throw new Error('The main mailbox is unavailable');
      },
    },
  };
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected browser job');
  await store.accept(job, session, 'terminal-recovery', 'browser', {}, 90_000);
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
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
  const queue = createQueue(runtime);
  await queue.accept('browser_purchase_commit', { authority_id: 'restart-live' }, session, 'internal-restart');
  await recoverAndStartBrowserQueue(queue);
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
  const queue = createQueue(runtime);
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
  actions = {
    ...actions,
    browser: {
      validate: () => ({}),
      async execute() {
        runs++;
        await waiting;
        return { status: 'completed' };
      },
    },
  };
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  await queue.accept('browser', {}, session, 'r-running');
  await queue.accept('browser', {}, session, 'r-running');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(runs).toBe(1);
  expect(responses()).toEqual([]);
  release();
  await queue.idle();
  await queue.accept('browser', {}, session, 'r-running');
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
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  await queue.stop();
  const restarted = createQueue(runtime);
  await recoverAndStartBrowserQueue(restarted);
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
          data: expect.objectContaining({ reason: 'unconfirmed', repeat_safe: false }),
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
  actions = {
    ...actions,
    browser: {
      validate: () => ({}),
      async execute() {
        runs++;
        await held;
        return { status: 'completed' };
      },
    },
  };
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  await queue.accept('browser', {}, session, 'long');
  await queue.accept('browser', { budget_ms: 1 }, session, 'expired');
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

it('clears a failed context deadline before recovery gives the job a replacement page', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  let open = true;
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => ({ version: () => '155.0.0.0' }) }),
    isClosed: () => !open,
    close: async () => {
      open = false;
    },
  }) as unknown as Page;
  actions = {
    ...actions,
    browser: {
      validate: () => ({}),
      async execute(context) {
        await context.page();
        return { status: 'completed' };
      },
    },
  };
  const queue = createQueue({ ...runtime, pageForJob: async () => page, closeJob: async () => page.close() });
  let entered!: () => void;
  const loading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let rejectContext!: (error: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectContext = reject;
  });
  try {
    await recoverAndStartBrowserQueue(queue);
    const getJob = store.getJob.bind(store);
    let failed = false;
    const lookup = vi.spyOn(store, 'getJob').mockImplementation(async (jobId) => {
      const first = await store.request(browserRequestId(session.id, 'failed-context'));
      if (first?.started_at && !failed) {
        failed = true;
        entered();
        return failure;
      }
      return getJob(jobId);
    });
    await queue.accept('browser', { budget_ms: 100 }, session, 'failed-context');
    await loading;
    const idle = queue.idle();
    rejectContext(new Error('Transient context read failure'));
    await expect(idle).rejects.toThrow('Transient context read failure');
    lookup.mockRestore();
    expect(await store.request(browserRequestId(session.id, 'failed-context'))).toMatchObject({
      started_at: expect.any(String),
      answered_at: null,
    });
    await queue.accept('browser', { budget_ms: 1_000 }, session, 'replacement-page');
    await queue.idle();
    expect(responses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: 'failed-context',
          frame: expect.objectContaining({
            data: expect.objectContaining({ reason: 'interrupted' }),
          }),
        }),
        expect.objectContaining({
          requestId: 'replacement-page',
          frame: expect.objectContaining({
            data: expect.objectContaining({ status: 'completed' }),
          }),
        }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(101);
    expect(page.isClosed()).toBe(false);
    expect(responses()).toHaveLength(2);
  } finally {
    await queue.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it('does not strand acceptance at the final empty-read boundary', async () => {
  let runs = 0;
  actions = {
    ...actions,
    browser: {
      validate: () => ({}),
      async execute() {
        runs++;
        return { status: 'completed' };
      },
    },
  };
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  const pending = store.nextPending.bind(store);
  let inserted = false;
  vi.spyOn(store, 'nextPending').mockImplementation(async (jobId) => {
    const result = await pending(jobId);
    if (jobId && !result && !inserted) {
      inserted = true;
      await queue.accept('browser', {}, session, 'boundary-second');
    }
    return result;
  });
  await queue.accept('browser', {}, session, 'boundary-first');
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
  actions = {
    ...actions,
    browser: {
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
    },
  };
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  await queue.accept('browser', { budget_ms: 5 }, session, 'late-1');
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

it('closes a page acquired after timeout before another owner can take the job', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = vi.fn(async () => undefined);
  const page = { close } as unknown as Page;
  let refused = false;
  actions = {
    ...actions,
    browser: {
      validate: () => ({}),
      async execute(context) {
        try {
          await context.page();
        } catch {
          refused = true;
        }
        return { status: 'completed' };
      },
    },
  };
  const queue = createQueue({
    ...runtime,
    pageForJob: async () => {
      await held;
      return page;
    },
  });
  await recoverAndStartBrowserQueue(queue);
  await queue.accept('browser', { budget_ms: 10 }, session, 'late-page');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected native job');
  expect(await queue.tryWithJobLocks([job.id], async () => 'replacement')).toEqual({ acquired: false });
  release();
  await queue.idle();
  expect(refused).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  expect(await queue.tryWithJobLocks([job.id], async () => 'replacement')).toEqual({
    acquired: true,
    value: 'replacement',
  });
  await queue.stop();
});

it('bounds a real watch check with its own provenance and keeps late work quarantined', async () => {
  const file = `${root}/browser/policy.json`;
  fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true }), { mode: 0o600 });
  vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', file);
  const queue = createQueue({ ...runtime, connection: async () => ({}) as ChromeConnection });
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected native job');
  const at = new Date().toISOString();
  await store.db.run(
    `INSERT INTO gws_ea_browser_watch_checks(id,site,check_recipe_id,check_recipe_version,parameter_hash,trigger,scheduled_at,started_at)
     VALUES('native-check','resy.com','recipe',1,'parameters','timer',?,?)`,
    at,
    at,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const executing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const close = vi.fn(async () => undefined);
  const page = { close } as unknown as Page;
  const signedOutPage = vi
    .spyOn(signedOut, 'withSignedOutBrowserPage')
    .mockImplementation(async (_connection, run) => run(page));
  let lateRefused = false;
  const replay = vi.spyOn(recipes, 'executeRecipe').mockImplementation(async (context) => {
    expect(context).toMatchObject({ kind: 'watch_check', check: { id: 'native-check' } });
    expect(context).not.toHaveProperty('request');
    entered();
    await held;
    try {
      await context.page();
    } catch {
      lateRefused = true;
    }
    return { status: 'checkpoint_failed' };
  });
  vi.useFakeTimers();
  const running = runBrowserWatchCheck(
    queue,
    {
      id: 'native-check',
      jobId: job.id,
      site: 'resy.com',
      recipeId: 'recipe',
      parameters: {},
      venueId: 'venue',
      partySize: 2,
    },
    new AbortController().signal,
  );
  try {
    await executing;
    await vi.advanceTimersByTimeAsync(90_001);
    expect(close).toHaveBeenCalledOnce();
    expect(await queue.tryWithJobLocks([job.id], async () => 'replacement')).toEqual({ acquired: false });
    expect(await store.db.all('SELECT id FROM gws_ea_browser_requests')).toEqual([]);
    expect(await store.db.get('SELECT id,finished_at FROM gws_ea_browser_watch_checks')).toEqual({
      id: 'native-check',
      finished_at: null,
    });
    release();
    expect(await running).toEqual({ status: 'failed' });
    expect(lateRefused).toBe(true);
    expect(await queue.tryWithJobLocks([job.id], async () => 'replacement')).toEqual({
      acquired: true,
      value: 'replacement',
    });
  } finally {
    release();
    await running;
    vi.useRealTimers();
    replay.mockRestore();
    signedOutPage.mockRestore();
  }
});

it('settles another job when one feature cannot recover its interrupted request', async () => {
  let entered!: () => void;
  const bothRunning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let executing = 0;
  actions = {
    ...actions,
    browser: {
      validate: (content) => ({ fail: content.fail === true }),
      async execute(context) {
        if (++executing === 2) entered();
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { status: 'completed' };
      },
      async recover(request) {
        if ((JSON.parse(request.payload_json) as { fail: boolean }).fail) throw new Error('Feature recovery failed');
        return undefined;
      },
    },
  };
  const closed: string[] = [];
  const queue = createQueue({
    ...runtime,
    closeJob: async (jobId) => {
      closed.push(jobId);
    },
  });
  await recoverAndStartBrowserQueue(queue);
  const other = (await resolveSystemSession('browser-q', 'system:a2a:main-q:unrelated-stop')).session;
  await queue.accept('browser', { fail: true }, session, 'failed-feature');
  await queue.accept('browser', {}, other, 'unrelated-stop');
  await bothRunning;
  await expect(queue.interruptRunning()).rejects.toThrow('Feature recovery failed');
  await queue.idle().catch(() => undefined);
  expect(await store.request(browserRequestId(other.id, 'unrelated-stop'))).toMatchObject({
    answered_at: expect.any(String),
    delivered_at: expect.any(String),
  });
  expect(closed).toEqual(expect.arrayContaining([session.thread_id, other.thread_id]));
  expect(closed).toHaveLength(2);
  await queue.stop();
});

it('recovers orphaned started requests without executing them or spinning the drain', async () => {
  let runs = 0;
  actions = {
    ...actions,
    browser: {
      validate: () => ({}),
      async execute() {
        runs++;
        return { status: 'completed' };
      },
    },
  };
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected browser job');
  for (const id of ['orphan-before', 'orphan-marked']) {
    await store.accept(job, session, id, 'browser', {}, 90_000);
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
          data: expect.objectContaining({ reason: 'unconfirmed', repeat_safe: false }),
        }),
      }),
    ]),
  );
  expect(responses()).toHaveLength(2);
  await queue.stop();
});

it('defers a failed durable answer until the periodic retry instead of immediately spinning', async () => {
  let runs = 0;
  actions = {
    ...actions,
    browser: {
      validate: () => ({}),
      async execute() {
        runs++;
        return { status: 'completed' };
      },
    },
  };
  const queue = createQueue(runtime);
  await recoverAndStartBrowserQueue(queue);
  const pending = store.nextPending.bind(store);
  let reads = 0;
  const pendingSpy = vi.spyOn(store, 'nextPending').mockImplementation(async (jobId) => {
    if (++reads > 8) throw new Error('Bounded test detected repeated immediate retries');
    return pending(jobId);
  });
  const answerSpy = vi.spyOn(store, 'answer').mockRejectedValue(new Error('Disk full'));
  await queue.accept('browser', {}, session, 'disk-failure');
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
  const queue = createQueue(runtime);
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
  const queue = createQueue(runtime);
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
  const queue = createQueue(runtime);
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

describe('an authorized credential operation cut off after disclosure', () => {
  const AUTHORITY = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  const ref = (n: number) => ({ ref: `e${n}`, generation: 2 });
  const form = { authority: AUTHORITY, username: ref(1), new_password: ref(2), activate: ref(3) };

  async function attempt(job: BrowserJob, phase: string, exposedAt: string | null): Promise<void> {
    const at = new Date(Date.now() - 60_000).toISOString();
    await store.db.run(
      `INSERT INTO gws_ea_browser_credential_attempts
       (id,kind,job_id,instance_id,account_id,vault_id,origin,site,username,candidate_item_id,candidate_version,phase,save_started_at,created_at,updated_at,exposed_at)
       VALUES(?,'signup',?,'instance','account','vault','https://accounts.shop.example','shop.example','morgan.ellery@example.com','candidate-1',1,?,?,?,?,?)`,
      AUTHORITY,
      job.id,
      phase,
      at,
      at,
      at,
      exposedAt,
    );
  }
  const read = () =>
    store.db.get<{ phase: string; candidate_item_id: string; exposed_at: string }>(
      'SELECT phase, candidate_item_id, exposed_at FROM gws_ea_browser_credential_attempts WHERE id = ?',
      AUTHORITY,
    );
  const answer = (requestId: string) =>
    (responses() as Array<{ requestId: string; frame: { data?: Record<string, unknown> } }>).find(
      (response) => response.requestId === requestId,
    )?.frame.data;
  async function noPurchaseRecords(): Promise<void> {
    for (const table of [
      'gws_ea_browser_authorities',
      'gws_ea_browser_purchase_attempts',
      'gws_ea_browser_purchase_blocks',
      'gws_ea_browser_pending_commits',
    ])
      expect(await store.db.all(`SELECT * FROM ${table}`)).toEqual([]);
  }

  it('covers AE3: answers it outcome_unknown on restart, keeps the same candidate and site held, and never submits again', async () => {
    const job = await store.jobForSession(session);
    if (!job) throw new Error('Expected browser job');
    await store.db.run(
      "INSERT INTO gws_ea_browser_site_leases VALUES ('shop.example', ?, 'active', ?)",
      job.id,
      new Date().toISOString(),
    );
    await store.accept(job, session, 'credential-crash', 'credential_form', form, 90_000);
    await store.start(browserRequestId(session.id, 'credential-crash'));
    // The crash came during the first input callback: the attempt was recorded exposed, then nothing answered.
    await attempt(job, 'exposed', new Date(Date.now() + 1_000).toISOString());

    const queue = createQueue(runtime);
    const run = store.db.run.bind(store.db);
    const unavailableChecks = vi.spyOn(store.db, 'run').mockImplementation(async (sql, ...parameters) => {
      if (sql.includes('UPDATE gws_ea_browser_watch_checks')) throw new Error('Scheduled checks unavailable');
      return run(sql, ...parameters);
    });
    try {
      await recoverAndStartBrowserQueue(queue);
      await expect(repairBrowserWatchChecks(queue)).rejects.toThrow('Scheduled checks unavailable');
      expect(unavailableChecks).toHaveBeenCalled();
    } finally {
      unavailableChecks.mockRestore();
    }
    expect(answer('credential-crash')).toMatchObject({ status: 'outcome_unknown' });
    expect(await read()).toMatchObject({ phase: 'unknown', candidate_item_id: 'candidate-1' });
    await noPurchaseRecords();

    // A retry, by the browser or after another restart, reports the recorded outcome without touching the page.
    await queue.accept('credential_form', form, session, 'credential-retry');
    await queue.idle();
    expect(answer('credential-retry')).toEqual(expect.objectContaining({ status: 'outcome_unknown' }));
    await queue.stop();
    const restarted = createQueue(runtime);
    await recoverAndStartBrowserQueue(restarted);
    expect(await read()).toMatchObject({ phase: 'unknown', candidate_item_id: 'candidate-1' });
    await noPurchaseRecords();

    // The site stays held by this job; every other site is free for other errands.
    const other = await store.jobForSession(
      (await resolveSystemSession('browser-q', 'system:a2a:main-q:unrelated')).session,
    );
    if (!other) throw new Error('Expected another browser job');
    expect(await restarted.leases.acquire(other.id, 'https://www.shop.example/')).toMatchObject({ acquired: false });
    expect(await restarted.leases.acquire(other.id, 'https://news.example/')).toMatchObject({ acquired: true });
    expect(await store.db.get("SELECT job_id FROM gws_ea_browser_site_leases WHERE site = 'shop.example'")).toEqual({
      job_id: job.id,
    });
    await restarted.stop();
  });

  it('answers a timed-out operation outcome_unknown and leaves the attempt for reconciliation', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    actions = {
      ...actions,
      browser: {
        validate: (content) => ({ authority: content.authority }),
        async execute() {
          await store.db.run(
            "UPDATE gws_ea_browser_credential_attempts SET phase = 'exposed', exposed_at = ? WHERE id = ?",
            new Date().toISOString(),
            AUTHORITY,
          );
          await held;
          return { status: 'account_created', vault: 'saved' };
        },
        recover: recoverCredentialRequest,
      },
    };
    const job = await store.jobForSession(session);
    if (!job) throw new Error('Expected browser job');
    await attempt(job, 'saved', null);
    const queue = createQueue(runtime);
    await recoverAndStartBrowserQueue(queue);
    await queue.accept('browser', { authority: AUTHORITY, budget_ms: 50 }, session, 'timed-out');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(answer('timed-out')).toMatchObject({ status: 'outcome_unknown' });
    expect(await read()).toMatchObject({ phase: 'unknown' });
    release();
    await queue.idle();
    await noPurchaseRecords();
    await queue.stop();
  });

  it('answers from the attempt, not the timeout, when the operation settles while its page is closing', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    actions = {
      ...actions,
      browser: {
        validate: (content) => ({ authority: content.authority }),
        async execute() {
          await store.db.run(
            "UPDATE gws_ea_browser_credential_attempts SET phase = 'exposed', exposed_at = ? WHERE id = ?",
            new Date().toISOString(),
            AUTHORITY,
          );
          await held;
          return { status: 'account_created', vault: 'saved' };
        },
        recover: recoverCredentialRequest,
      },
    };
    const job = await store.jobForSession(session);
    if (!job) throw new Error('Expected browser job');
    await attempt(job, 'saved', null);
    // Closing the timed-out page ends the cut-off operation, which settles before the answer is recorded.
    const queue = createQueue({
      ...runtime,
      async closeJob() {
        release();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    await recoverAndStartBrowserQueue(queue);
    await queue.accept('browser', { authority: AUTHORITY, budget_ms: 20 }, session, 'late');
    await queue.idle();
    expect(answer('late')).toMatchObject({ status: 'outcome_unknown' });
    expect(await read()).toMatchObject({ phase: 'unknown' });
    expect(responses()).toHaveLength(1);
    await queue.stop();
  });

  it('leaves an attempt another request disclosed, such as one awaiting email verification, as it was', async () => {
    const job = await store.jobForSession(session);
    if (!job) throw new Error('Expected browser job');
    await attempt(job, 'awaiting_verification', new Date(Date.now() - 30_000).toISOString());
    await store.accept(job, session, 'later-step', 'credential_form', form, 90_000);
    await store.start(browserRequestId(session.id, 'later-step'));
    const queue = createQueue(runtime);
    await recoverAndStartBrowserQueue(queue);
    expect(answer('later-step')).toMatchObject({ status: 'stopped', reason: 'interrupted' });
    expect(await read()).toMatchObject({ phase: 'awaiting_verification' });
    await queue.stop();
  });
});

describe('the notice after an approved purchase that went no further', () => {
  const live = new Date(Date.now() + 60 * 60_000).toISOString();
  /** Delivers `frame` as the answer of the job's approved commit, and returns the notice the browser reads. */
  async function deliverCommit(
    data: Record<string, unknown>,
    setup: (job: BrowserJob) => Promise<void> = async () => undefined,
    expiresAt = live,
  ): Promise<Record<string, unknown>> {
    const job = await store.jobForSession(session);
    if (!job) throw new Error('Expected browser job');
    await store.db.run(
      `INSERT INTO gws_ea_browser_authorities
       (id,job_id,kind,state,facts_json,bounds_json,exception_ids_json,attempt_id,expires_at,created_at)
       VALUES('notice-live',?,'checkout','live',?,'{}','[]','notice-attempt',?,?)`,
      job.id,
      JSON.stringify({ site: 'amazon.com' }),
      expiresAt,
      new Date().toISOString(),
    );
    await store.accept(
      job,
      session,
      'notice-commit',
      'browser_purchase_commit',
      { authority_id: 'notice-live' },
      90_000,
    );
    // What befell the job while its commit ran.
    await setup(job);
    const id = browserRequestId(session.id, 'notice-commit');
    await store.answer(id, { id: 'notice-commit', ok: true, data }, new Date().toISOString());
    const request = await store.request(id);
    if (!request) throw new Error('Expected the commit request');
    await new BrowserQueue(store, runtime, actions, browserQueueFollowUps).deliver(request);
    const inbound = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
    try {
      const rows = inbound.prepare("SELECT content FROM messages_in WHERE id LIKE 'browser-commit-%'").all() as Array<{
        content: string;
      }>;
      expect(rows).toHaveLength(1);
      return JSON.parse((JSON.parse(rows[0].content) as { text: string }).text) as Record<string, unknown>;
    } finally {
      inbound.close();
    }
  }
  const cancel = (job: BrowserJob) =>
    store.db.run('UPDATE gws_ea_browser_jobs SET cancelled = 1 WHERE id = ?', job.id).then(() => undefined);

  it.each([
    [
      'a lapsed checkout',
      { status: 'checkout_lapsed', repeat_safe: true },
      true,
      false,
      /Rebuild the checkout from a fresh observation and call purchase/,
    ],
    [
      'an interrupted commit',
      { status: 'stopped', reason: 'interrupted', repeat_safe: true },
      true,
      false,
      /Rebuild the checkout from a fresh observation and call purchase/,
    ],
    [
      'a browser that failed under the commit',
      { status: 'stopped', reason: 'browser_unavailable', repeat_safe: false },
      true,
      false,
      /Rebuild the checkout from a fresh observation and call purchase/,
    ],
    [
      'an earlier purchase awaiting its outcome',
      { status: 'waiting_on_earlier', site: 'amazon.com', repeat_safe: true },
      false,
      false,
      /earlier purchase on this site is waiting for its outcome.*Browse on.*when the host wakes you.*call purchase.*approval holds until it expires/s,
    ],
    [
      'a site another errand holds',
      { status: 'stopped', reason: 'site_busy', repeat_safe: true },
      false,
      true,
      /another errand holds this site.*wakes you when it is free.*call purchase again.*approval holds until it expires/s,
    ],
    [
      'a checkout that went back to the principal as a new card',
      { status: 'awaiting_principal', repeat_safe: false },
      false,
      false,
      /principal has a new card with the checkout's current facts.*Stay on the checkout and wait for its outcome/s,
    ],
    [
      'a checkout with no saved card',
      { status: 'card_needed', repeat_safe: false },
      false,
      false,
      /no payment method saved.*Report it to main/s,
    ],
    [
      'a checkout missing facts',
      { status: 'facts_incomplete', missing: ['the total'], repeat_safe: false },
      false,
      false,
      /could not read the total.*Report it to main/s,
    ],
    [
      'a checkout whose terms the host could not read',
      { status: 'terms_unavailable', repeat_safe: false },
      false,
      false,
      /could not read the site’s terms.*Report it to main/s,
    ],
    [
      'a checkout whose terms can charge more than the maximum',
      { status: 'terms_over_bounds', repeat_safe: false },
      false,
      false,
      /terms can charge more than the principal’s maximum.*Report it to main/s,
    ],
    [
      'an unknown status',
      { status: 'withdrawn', reason: 'authority_unavailable', repeat_safe: false },
      false,
      false,
      /withdrawn.*as the purchase tool describes/s,
    ],
  ] as const)('tells the browser the truth about %s', async (_name, data, rebuild, repeatSafe, words) => {
    const notice = await deliverCommit(data);
    expect(notice).toMatchObject({ safe_to_rebuild: rebuild, repeat_safe: repeatSafe });
    expect(notice.message).toMatch(/^No purchase was attempted/);
    expect(notice.message).toMatch(words);
    expect(notice.message).not.toMatch(/internal commit request/);
  });

  it('tells the browser a cancelled errand stops, whatever its checkout answered', async () => {
    const notice = await deliverCommit({ status: 'checkout_lapsed', repeat_safe: true }, cancel);
    expect(notice).toMatchObject({ safe_to_rebuild: false, repeat_safe: false });
    expect(notice.message).toMatch(/this errand was cancelled.*stop/is);
    expect(notice.message).not.toMatch(/call purchase/);
  });

  it('gives the host-written change when the host stopped a checkout that kept changing', async () => {
    const notice = await deliverCommit(
      {
        status: 'checkout_changing',
        reason: 'The total rose to $45.00, from $42.00.',
        message:
          'The checkout changed again after three changed cards (The total rose to $45.00, from $42.00.), so the host stopped this errand.',
        repeat_safe: false,
      },
      cancel,
    );
    expect(notice).toMatchObject({ safe_to_rebuild: false, reason: 'The total rose to $45.00, from $42.00.' });
    expect(notice.message).toMatch(
      /\(The total rose to \$45\.00, from \$42\.00\.\), so the host stopped this errand.*Report it to main/s,
    );
    expect(notice.message).not.toMatch(/cancelled/);
  });

  it.each([
    [
      'a late confirmation',
      'late_confirmation',
      /placed after all, so the host stopped this errand.*Report it to main/s,
    ],
    [
      'an unapproved commit',
      'unapproved_commit',
      /confirmation showing a charge nobody approved, so the host stopped this errand.*Report it to main/s,
    ],
  ] as const)('tells the browser the host stopped an errand %s ended', async (_name, kind, words) => {
    const notice = await deliverCommit({ status: 'checkout_lapsed', repeat_safe: true }, async (job) => {
      await cancel(job);
      await store.db.run(
        `INSERT INTO gws_ea_browser_incidents(id,kind,site,job_id,evidence_key,evidence_json,created_at)
         VALUES('incident-notice',?,'amazon.com',?,'order-1','{}',?)`,
        kind,
        job.id,
        new Date().toISOString(),
      );
    });
    expect(notice).toMatchObject({ safe_to_rebuild: false });
    expect(notice.message).toMatch(words);
  });

  it('tells the browser an expired approval no longer covers the checkout', async () => {
    const notice = await deliverCommit(
      { status: 'checkout_lapsed', repeat_safe: true },
      undefined,
      new Date(Date.now() - 60_000).toISOString(),
    );
    expect(notice).toMatchObject({ safe_to_rebuild: false });
    expect(notice.message).toMatch(/approval expired.*Report it to main/s);
  });
});
