import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return `${tmpdir()}/browser-host-evidence-tests`;
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));

import { dispatch } from '../../cli/dispatch.js';
import { lookup } from '../../cli/registry.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  destroySessionMailbox,
  resolveSystemSession,
  withExistingMailboxSession,
  writeSessionMessage,
} from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore, browserRequestId } from './db.js';
import { readBrowserEvidence } from './evidence.js';

let session: Session;
let store: BrowserStore;
const thread = 'system:a2a:evidence-main:errand';
const canary = 'PRIVATE_CANARY_credential_or_document_contents';
const at = (second: number): string => new Date(Date.UTC(2026, 9, 15, 12, 0, second)).toISOString();

beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at(0)));
  await runMigrations(await initTestDb());
  for (const id of ['evidence-main', 'evidence-browser', 'evidence-foreign']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: at(0) });
    await ensureContainerConfig(id);
  }
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id=?,browser_agent_group_id=? WHERE singleton=1`,
    'evidence-main',
    'evidence-browser',
  );
  session = (await resolveSystemSession('evidence-browser', thread)).session;
  store = new BrowserStore();
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

async function accept(requestId: string, action = 'browser'): Promise<string> {
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected native browser job');
  await store.accept(job, session, requestId, action, { url: `https://example.com/${canary}` }, 90_000);
  return browserRequestId(session.id, requestId);
}
async function outbound(id: string, content: string, kind = 'system', target: string | null = null): Promise<void> {
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.writeDirect({
      id,
      kind,
      channelType: target ? 'agent' : null,
      platformId: target,
      threadId: target ? thread : null,
      content,
    }),
  );
}

it('uses each request’s own immutable outbound timestamp and projects metadata without private content', async () => {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: 'first-delegation',
    kind: 'chat',
    timestamp: at(1),
    channelType: 'agent',
    content: JSON.stringify({ text: canary }),
  });
  vi.setSystemTime(new Date(at(2)));
  await outbound('request-a', JSON.stringify({ action: 'browser', requestId: 'request-a', url: canary }));
  vi.setSystemTime(new Date(at(3)));
  const id = await accept('request-a');
  await getDb().run(
    'UPDATE gws_ea_browser_requests SET started_at=?,commit_started_at=?,answered_at=?,delivered_at=?,answer_json=? WHERE id=?',
    at(4),
    at(5),
    at(6),
    at(7),
    JSON.stringify({
      id: 'request-a',
      ok: true,
      data: { status: 'stopped', reason: 'purchase_control', text: canary },
    }),
    id,
  );
  await getDb().run(
    'INSERT INTO gws_ea_browser_downloads(id,job_id,request_id,host_path,filename,bytes,inbox_path,handed_off_at) VALUES(?,?,?,?,?,?,?,?)',
    'download-1',
    thread,
    id,
    `/private/${canary}`,
    'invoice.pdf',
    1024,
    `/inbox/${canary}`,
    at(7),
  );
  await getDb().run(
    "INSERT INTO gws_ea_browser_purchase_cards(id,job_id,request_id,status,facts_json,bounds_json,exception_ids_json,expires_at,created_at) VALUES(?,?,?,'open',?,'{}','[]',?,?)",
    'card-1',
    thread,
    'card-request',
    JSON.stringify({ account: canary }),
    at(59),
    at(3),
  );
  for (const [authorityId, attemptId, resolution] of [
    ['authority-committed', 'attempt-committed', 'committed'],
    ['authority-unknown', 'attempt-unknown', null],
  ] as const) {
    await getDb().run(
      "INSERT INTO gws_ea_browser_authorities(id,job_id,kind,state,facts_json,bounds_json,exception_ids_json,attempt_id,expires_at,created_at) VALUES(?,?,'checkout',?,'{}','{}','[]',?,?,?)",
      authorityId,
      thread,
      resolution === 'committed' ? 'committed' : 'unknown',
      attemptId,
      at(59),
      at(3),
    );
    await getDb().run(
      'INSERT INTO gws_ea_browser_purchase_attempts(id,authority_id,job_id,site,facts_json,attempted_at,resolution,evidence_json) VALUES(?,?,?,?,?,?,?,?)',
      attemptId,
      authorityId,
      thread,
      'example.com',
      JSON.stringify({ address: canary }),
      at(5),
      resolution,
      JSON.stringify({ cookie: canary }),
    );
  }
  vi.setSystemTime(new Date(at(8)));
  await outbound('delivered-report', JSON.stringify({ text: canary }), 'chat', 'evidence-main');
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.markDelivered('delivered-report', 'a2a-delivered-report'),
  );
  vi.setSystemTime(new Date(at(9)));
  await outbound('newer-unrelated', JSON.stringify({ action: 'browser', requestId: 'different', secret: canary }));
  await outbound('newer-pending-report', JSON.stringify({ text: canary }), 'chat', 'evidence-main');

  const evidence = await readBrowserEvidence(thread);
  expect(evidence).toEqual({
    schemaVersion: 1,
    capturedAt: at(9),
    job: {
      id: thread,
      browserSessionId: session.id,
      createdAt: at(3),
      cancelled: false,
      cancelRequested: false,
      firstInboundAt: at(1),
      lastDeliveredReportAt: at(8),
    },
    requests: [
      {
        id,
        requestId: 'request-a',
        action: 'browser',
        emittedAt: at(2),
        acceptedAt: at(3),
        startedAt: at(4),
        commitStartedAt: at(5),
        answeredAt: at(6),
        deliveredAt: at(7),
        status: 'stopped',
        reason: 'purchase_control',
      },
    ],
    downloads: [{ id: 'download-1', filename: 'invoice.pdf', bytes: 1024, handedOffAt: at(7) }],
    purchase: { openCards: 1, committedAttempts: 1, unresolvedAttempts: 1 },
    watchNextCheckAt: null,
    watchChecks: [],
  });
  expect(JSON.stringify(evidence)).not.toContain(canary);
});

it('does not guess missing or ambiguous emissions, and never exports arbitrary result or error strings', async () => {
  const content = JSON.stringify({ action: 'browser', requestId: 'ambiguous', text: canary });
  await outbound('ambiguous', content);
  vi.setSystemTime(new Date(at(1)));
  await outbound('identical-content', content);
  const ambiguous = await accept('ambiguous');
  const internal = await accept('host-internal', 'browser_purchase_commit');
  const erroneous = await accept('error');
  await getDb().run(
    'UPDATE gws_ea_browser_requests SET answer_json=? WHERE id=?',
    JSON.stringify({ ok: true, data: { status: canary, reason: canary } }),
    ambiguous,
  );
  await getDb().run(
    'UPDATE gws_ea_browser_requests SET answer_json=? WHERE id=?',
    JSON.stringify({ ok: false, error: { code: 'forbidden', message: canary } }),
    erroneous,
  );
  const evidence = await readBrowserEvidence(thread);
  expect(evidence.requests.find((request) => request.id === ambiguous)).toMatchObject({
    emittedAt: null,
    status: null,
    reason: null,
  });
  expect(evidence.requests.find((request) => request.id === internal)).toMatchObject({ emittedAt: null });
  expect(evidence.requests.find((request) => request.id === erroneous)).toMatchObject({
    status: 'error',
    reason: 'forbidden',
  });
  expect(JSON.stringify(evidence)).not.toContain(canary);
});

it('records an unconfirmed purchase as its operational code, never its attempt id', async () => {
  // The agent-runner's description test holds every code with an underscore that a browser tool names to this same
  // list; `unconfirmed` has none, so its place in the list is proven here.
  await getDb().run(
    'UPDATE gws_ea_browser_requests SET answer_json=? WHERE id=?',
    JSON.stringify({ ok: true, data: { status: 'unconfirmed', attempt_id: canary } }),
    await accept('unconfirmed', 'purchase'),
  );
  const evidence = await readBrowserEvidence(thread);
  expect(evidence.requests).toMatchObject([{ status: 'unconfirmed', reason: null }]);
  expect(JSON.stringify(evidence)).not.toContain(canary);
});

it('leaves truncated mailbox timing unavailable and never provisions an absent mailbox', async () => {
  await accept('old-request');
  await withExistingMailboxSession(session.agent_group_id, session.id, async (mailbox) => {
    for (let index = 0; index < 2_000; index++) {
      await mailbox.insertMessage({
        id: `inbound-${index}`,
        timestamp: at(0),
        kind: 'chat',
        platformId: null,
        channelType: 'agent',
        threadId: thread,
        content: canary,
        processAfter: null,
        recurrence: null,
      });
      await mailbox.writeDirect({
        id: index === 0 ? 'old-request' : `outbound-${index}`,
        kind: 'system',
        channelType: null,
        platformId: null,
        threadId: null,
        content: JSON.stringify({ action: 'browser', requestId: `request-${index}` }),
      });
    }
  });
  expect(await readBrowserEvidence(thread)).toMatchObject({
    job: { firstInboundAt: null },
    requests: [{ emittedAt: null }],
  });
  await destroySessionMailbox(session.agent_group_id, session.id);
  const files = fs.readdirSync(root, { recursive: true }).sort();
  expect(await readBrowserEvidence(thread)).toMatchObject({
    job: { firstInboundAt: null, lastDeliveredReportAt: null },
    requests: [{ emittedAt: null }],
  });
  expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(files);
}, 30_000);

it('refuses unknown, unstarted, foreign and closed origins without creating jobs or mailbox files', async () => {
  const before = fs.readdirSync(root, { recursive: true }).sort();
  for (const job of ['unknown', thread])
    await expect(readBrowserEvidence(job)).rejects.toThrow('Browser job not found');
  expect(await getDb().all('SELECT id FROM gws_ea_browser_jobs')).toEqual([]);
  expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
  await accept('one');
  await getDb().run('UPDATE gws_ea_browser_jobs SET source_agent_group_id=? WHERE id=?', 'evidence-foreign', thread);
  await expect(readBrowserEvidence(thread)).rejects.toThrow('Browser job not found');
  await getDb().run('UPDATE gws_ea_browser_jobs SET source_agent_group_id=? WHERE id=?', 'evidence-main', thread);
  await getDb().run("UPDATE sessions SET status='closed' WHERE id=?", session.id);
  await expect(readBrowserEvidence(thread)).rejects.toThrow('Browser job not found');
  expect(await getDb().all('SELECT id FROM gws_ea_browser_jobs')).toEqual([{ id: thread }]);
});

it('is a hidden host-only command and refuses a global agent through the real dispatcher', async () => {
  await accept('one');
  await updateContainerConfigScalars('evidence-main', { cli_scope: 'global' });
  const command = 'gws-ea-browser-evidence';
  expect(lookup(command)).toMatchObject({ access: 'hidden', hostOnly: true });
  const request = { id: 'inspection', command, args: { job: thread } };
  expect(
    await dispatch(request, {
      caller: 'agent',
      agentGroupId: 'evidence-main',
      sessionId: session.id,
      messagingGroupId: 'none',
    }),
  ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  expect(await dispatch(request, { caller: 'host' })).toMatchObject({
    ok: true,
    data: { schemaVersion: 1, job: { id: thread } },
  });
  expect(await dispatch({ ...request, args: { job: thread, path: canary } }, { caller: 'host' })).toMatchObject({
    ok: false,
    error: { code: 'invalid-args' },
  });
});

it('attributes shared watch checks only to persisted consumer watches for this job', async () => {
  await accept('one');
  const foreignSession = (await resolveSystemSession('evidence-browser', 'system:a2a:evidence-main:foreign')).session;
  const foreignJob = await store.jobForSession(foreignSession);
  if (!foreignJob) throw new Error('Expected foreign native job');
  for (const [watch, job] of [
    ['own-watch', thread],
    ['foreign-watch', foreignJob.id],
  ] as const) {
    await getDb().run(
      "INSERT INTO gws_ea_browser_watches(id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at) VALUES(?,?,'resy.com','recipe',1,'{}','same','{}','armed',?,?,?)",
      watch,
      job,
      at(1),
      at(1),
      at(9),
    );
  }
  for (const [id, members] of [
    ['shared', ['own-watch', 'foreign-watch']],
    ['foreign-only', ['foreign-watch']],
  ] as const) {
    await getDb().run(
      "INSERT INTO gws_ea_browser_watch_checks(id,site,check_recipe_id,check_recipe_version,parameter_hash,trigger,scheduled_at,started_at,finished_at,outcome,next_check_at) VALUES(?,'resy.com','recipe',1,'same','timer',?,?,?,'ready',?)",
      id,
      at(1),
      at(2),
      at(3),
      at(9),
    );
    for (const member of members)
      await getDb().run('INSERT INTO gws_ea_browser_watch_check_members(check_id,watch_id) VALUES(?,?)', id, member);
  }
  expect((await readBrowserEvidence(thread)).watchChecks).toEqual([
    { id: 'shared', scheduledAt: at(1), startedAt: at(2), finishedAt: at(3), outcome: 'ready', nextCheckAt: at(9) },
  ]);
  await getDb().run('UPDATE gws_ea_browser_watches SET next_check_at=? WHERE id=?', at(4), 'foreign-watch');
  expect(await readBrowserEvidence(thread)).toMatchObject({ watchNextCheckAt: at(9) });
  await getDb().run("UPDATE gws_ea_browser_watches SET status='cancelled' WHERE id=?", 'own-watch');
  expect(await readBrowserEvidence(thread)).toMatchObject({ watchNextCheckAt: null });
});

it('projects fresh bounded provenance and recording from both success and native error envelopes', async () => {
  const success = await accept('provenance');
  const failure = await accept('provenance-error');
  for (const [id, ok] of [
    [success, true],
    [failure, false],
  ] as const) {
    const diagnostics = {
      schema_version: 1,
      job_id: thread,
      request_id: id,
      action: 'browser',
      action_index: 0,
      runtime: { playwright: '1.64.0', chrome: '155.0.0.0', node: '22.0.0', headers: canary },
      events: [
        {
          source: 'http_response',
          site: 'fixture.example',
          method: 'GET',
          resource: 'document',
          status: 403,
          elapsed_ms: 3,
          action_index: 0,
          request_index: 2,
          redirected_from: 1,
          body: canary,
          url: `https://example.com/?token=${canary}`,
        },
        { source: 'host_refusal', category: 'document', rule: 'blocked_address', elapsed_ms: 4, action_index: 0 },
        {
          source: 'transport_failure',
          site: 'fixture.example',
          method: 'GET',
          resource: 'document',
          category: 'tls',
          elapsed_ms: 5,
          request_index: 3,
        },
        { source: 'runtime_error', category: 'execution', elapsed_ms: 6, raw_error: canary },
        {
          source: 'http_response',
          site: `https://example.com/${canary}`,
          method: 'GET',
          resource: 'document',
          status: 200,
          elapsed_ms: 7,
        },
        { source: canary, elapsed_ms: 8 },
      ],
      omitted_events: 2,
      screenshot: canary,
    };
    const metadata = { diagnostics, recording: { status: 'unavailable', trace_indices: [2, 3], page: canary } };
    await getDb().run(
      'UPDATE gws_ea_browser_requests SET answer_json=? WHERE id=?',
      JSON.stringify(
        ok
          ? { ok, data: { status: 'stopped', reason: 'challenge', ...metadata, observation: canary } }
          : { ok, error: { code: 'handler-error', message: canary, metadata } },
      ),
      id,
    );
  }
  const evidence = await readBrowserEvidence(thread);
  for (const request of evidence.requests) {
    expect(request).toMatchObject({
      diagnostics: {
        schema_version: 1,
        job_id: thread,
        request_id: request.id,
        action: 'browser',
        action_index: 0,
        runtime: { playwright: '1.64.0', chrome: '155.0.0.0', node: '22.0.0' },
        events: [
          {
            source: 'http_response',
            site: 'fixture.example',
            method: 'GET',
            resource: 'document',
            status: 403,
            elapsed_ms: 3,
            action_index: 0,
            request_index: 2,
            redirected_from: 1,
          },
          { source: 'host_refusal', category: 'document', rule: 'blocked_address', elapsed_ms: 4, action_index: 0 },
          {
            source: 'transport_failure',
            site: 'fixture.example',
            method: 'GET',
            resource: 'document',
            category: 'tls',
            elapsed_ms: 5,
            request_index: 3,
          },
          { source: 'runtime_error', category: 'execution', elapsed_ms: 6 },
          { source: 'http_response', method: 'GET', resource: 'document', status: 200, elapsed_ms: 7 },
        ],
        omitted_events: 2,
      },
      recording: { status: 'unavailable', trace_indices: [2, 3] },
    });
  }
  expect(evidence.requests.map(({ status, reason }) => [status, reason])).toEqual(
    expect.arrayContaining([
      ['stopped', 'challenge'],
      ['error', 'handler-error'],
    ]),
  );
  expect(JSON.stringify(evidence)).not.toContain(canary);
  expect(JSON.stringify(evidence)).not.toMatch(/screenshot|headers|raw_error|observation|body|https:/u);
  const diagnostics = {
    schema_version: 1,
    job_id: thread,
    request_id: success,
    action: 'browser',
    runtime: { node: '22.0.0' },
    events: Array.from({ length: 70 }, () => ({ source: 'runtime_error', category: 'execution', elapsed_ms: 1 })),
    omitted_events: 2,
  };
  await getDb().run(
    'UPDATE gws_ea_browser_requests SET answer_json=? WHERE id=?',
    JSON.stringify({ ok: true, data: { diagnostics } }),
    success,
  );
  const bounded = (await readBrowserEvidence(thread)).requests.find((request) => request.id === success);
  expect(bounded?.diagnostics?.events).toHaveLength(64);
  expect(bounded?.diagnostics?.omitted_events).toBe(8);
  await getDb().run(
    'UPDATE gws_ea_browser_requests SET answer_json=? WHERE id=?',
    JSON.stringify({ ok: true, data: { diagnostics: { ...diagnostics, job_id: canary } } }),
    success,
  );
  expect(
    (await readBrowserEvidence(thread)).requests.find((request) => request.id === success)?.diagnostics,
  ).toBeUndefined();
});
