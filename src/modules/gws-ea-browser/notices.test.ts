import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return `${tmpdir()}/browser-notice-tests`;
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));
vi.mock('../../container-runner.js', () => ({
  registerSessionAdmissionPolicy: vi.fn(),
  wakeContainer: vi.fn(async () => true),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSystemSession, writeSessionMessage } from '../../session-manager.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore } from './db.js';
import { BrowserQueue } from './queue.js';
import { notifyPurchaseOutcome } from './authority.js';
import { notifyPurchaseCard } from './cards.js';
import { deliverWatchNotices } from './watches.js';

beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  for (const id of ['notice-main', 'notice-browser'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
    'notice-main',
    'notice-browser',
  );
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The rows are produced by host emitters, then consumed by the actual Bun runner and formatter. */
it('delivers purchase, card, watch and site notices to cold and active browser turns, while hiding tool responses', async () => {
  const session = (await resolveSystemSession('notice-browser', 'system:a2a:notice-main:notices')).session;
  const store = new BrowserStore();
  const job = await store.jobForSession(session);
  if (!job) throw new Error('Expected browser job');
  const at = new Date().toISOString();
  await getDb().run(
    `INSERT INTO gws_ea_browser_purchase_cards
     (id,job_id,request_id,status,facts_json,bounds_json,exception_ids_json,expires_at,created_at)
     VALUES('notice-card',?,'notice-card-request','rejected','{}','{}','[]',?,?)`,
    job.id,
    at,
    at,
  );
  await getDb().run(
    `INSERT INTO gws_ea_browser_authorities
     (id,job_id,kind,state,facts_json,bounds_json,exception_ids_json,attempt_id,expires_at,created_at,outcome_json)
     VALUES('notice-authority',?,'checkout','committed','{}','{}','[]','notice-attempt',?,?,?)`,
    job.id,
    at,
    at,
    JSON.stringify({ status: 'placed', order_number: 'notice-order' }),
  );
  await getDb().run(
    `INSERT INTO gws_ea_browser_watches
     (id,job_id,site,check_recipe_id,check_recipe_version,parameters_json,check_key,bounds_json,status,created_at,updated_at,next_check_at)
     VALUES('notice-watch',?,'resy.com','recipe',1,'{}','key','{}','armed',?,?,?)`,
    job.id,
    at,
    at,
    at,
  );
  await getDb().run(
    `INSERT INTO gws_ea_browser_watch_notices(watch_id,event_key,outcome_json,created_at)
     VALUES('notice-watch','found',?,?)`,
    JSON.stringify({ type: 'browser_watch_outcome', status: 'found', watch_id: 'notice-watch' }),
    at,
  );
  const queue = new BrowserQueue(store, {
    async pageForJob(): Promise<never> {
      throw new Error('No browser operation expected');
    },
    async connection(): Promise<never> {
      throw new Error('No browser operation expected');
    },
    async closeJob() {},
    onDisconnected: () => () => undefined,
  });
  await notifyPurchaseOutcome('notice-authority');
  await notifyPurchaseCard('notice-card', 'rejected');
  await deliverWatchNotices();
  await queue.wakeWaiters([job.id], 'site-notice');
  // Recovery repeats every emitter without creating another model-visible event.
  await notifyPurchaseOutcome('notice-authority');
  await notifyPurchaseCard('notice-card', 'rejected');
  await deliverWatchNotices();
  await queue.wakeWaiters([job.id], 'site-notice');
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: 'action-resp-hidden',
    kind: 'system',
    timestamp: at,
    trigger: false,
    content: JSON.stringify({ type: 'action_response', secret: 'TOOL_RESPONSE_MUST_STAY_HIDDEN' }),
  });
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const rows = inbound.prepare('SELECT * FROM messages_in ORDER BY seq').all();
  inbound.close();
  expect(rows).toHaveLength(5);
  const runner = new URL('../../../container/agent-runner/src/', import.meta.url).href;
  const script = `
    await import(${JSON.stringify(`${runner}modules/index.ts`)});
    const { initTestSessionDb, getInboundDb, closeSessionDb } = await import(${JSON.stringify(`${runner}mailbox/sqlite/connection.ts`)});
    const { runPollLoop, processQuery } = await import(${JSON.stringify(`${runner}poll-loop.ts`)});
    const rows = JSON.parse(await Bun.stdin.text());
    const insert = () => { for (const row of rows) getInboundDb().prepare(
      'INSERT INTO messages_in(id,seq,kind,timestamp,trigger,platform_id,channel_type,thread_id,content) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(row.id,row.seq,row.kind,row.timestamp,row.trigger,row.platform_id,row.channel_type,row.thread_id,row.content); };
    initTestSessionDb(); insert();
    const controller = new AbortController();
    let cold = '';
    const timer = setTimeout(() => controller.abort(), 3000);
    await runPollLoop({ providerName: 'mock', cwd: '/tmp', signal: controller.signal,
      provider: { isSessionInvalid: () => false, query(input) { cold = input.prompt; controller.abort(); return {
        push() {}, end() {}, abort() {}, events: (async function* () { yield { type:'result',text:'' }; })()
      }; }}
    });
    clearTimeout(timer); closeSessionDb(); initTestSessionDb();
    let active = '';
    let complete;
    const pushed = new Promise(resolve => { complete = resolve; });
    let activeTimer;
    const query = { push(prompt) { active = prompt; complete(); }, end() {}, abort() {},
      events: (async function* () { yield { type:'init',continuation:'notice-test' }; insert();
        await Promise.race([pushed,new Promise(resolve => { activeTimer = setTimeout(resolve,3000); })]);
        clearTimeout(activeTimer);
      })()
    };
    await processQuery(query,{platformId:'notice-browser',channelType:'agent',threadId:null,inReplyTo:'opening'},[],'mock',undefined,'opening');
    closeSessionDb(); console.log(JSON.stringify({cold,active}));
  `;
  const result = JSON.parse(
    execFileSync('bun', ['--eval', script], {
      input: JSON.stringify(rows),
      encoding: 'utf8',
      timeout: 10000,
    }),
  ) as { cold: string; active: string };
  for (const prompt of [result.cold, result.active]) {
    expect(prompt).toContain('browser_purchase_outcome');
    expect(prompt).toContain('notice-order');
    expect(prompt).toContain('The principal declined.');
    expect(prompt).toContain('browser_watch_outcome');
    expect(prompt).toContain('browser_site_available');
    expect(prompt).not.toContain('TOOL_RESPONSE_MUST_STAY_HIDDEN');
  }
}, 15_000);
