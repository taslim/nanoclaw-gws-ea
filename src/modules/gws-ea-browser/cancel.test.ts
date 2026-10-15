import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), 'browser-cancel-tests');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { resolveSystemSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore } from './db.js';
import { browserDelegateGuard, cancelBrowserJob, readBrowserJob, sweepBrowserJobSessions } from './cancel.js';
import { getSession, updateSession } from '../../db/sessions.js';
import { guard } from '../../guard/index.js';

let session: Session;
beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const id of ['main', 'browser'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
    'main',
    'browser',
  );
  session = (await resolveSystemSession('browser', 'system:a2a:main:cancel')).session;
});
afterEach(async () => {
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

it('admits canonical main alone and denies browser delegation while the operator policy is disabled', async () => {
  const file = `${root}/browser/policy.json`;
  fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }), { mode: 0o600 });
  process.env.GWS_EA_BROWSER_POLICY_FILE = file;
  expect(
    await guard(browserDelegateGuard, { actor: { kind: 'agent', agentGroupId: 'main' }, payload: {} }),
  ).toMatchObject({ effect: 'allow' });
  for (const agentGroupId of ['browser', 'external', 'other'])
    expect(await guard(browserDelegateGuard, { actor: { kind: 'agent', agentGroupId }, payload: {} })).toMatchObject({
      effect: 'deny',
    });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: false, credentialMode: 'email' }));
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
