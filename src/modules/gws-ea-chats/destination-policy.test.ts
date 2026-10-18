import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/gws-ea-chat-destinations-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
import '../gws-ea-profile/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-chat-agents/index.js';
import '../gws-ea-browser/index.js';
import './index.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { resolveSession, withExistingMailboxSession } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { routeAgentMessage } from '../agent-to-agent/agent-route.js';
import { reconcileBrowserGroup } from '../gws-ea-browser/reconcile.js';
import { BrowserStore } from '../gws-ea-browser/db.js';
import { writeBrowserAccess } from '../gws-ea-browser/testing/browser-access.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';
import type { Session } from '../../types.js';

let source: Session;
let other: Session;
beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  for (const id of ['main', 'external', 'job', 'other', 'browser', 'unconnected'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
  await getDb().run(
    "UPDATE gws_ea_profile SET main_agent_group_id='main', external_chat_agent_group_id='external', browser_agent_group_id='browser' WHERE singleton=1",
  );
  await createMessagingGroup({
    id: 'trip',
    channel_type: 'whatsapp',
    instance: 'whatsapp',
    platform_id: 'trip@g.us',
    name: 'Trip',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO gws_ea_job_agents (agent_group_id,messaging_group_id,state,created_at,updated_at) VALUES ('job','trip','active',?,?)",
    now,
    now,
  );
  await getDb().run(
    "INSERT INTO gws_ea_chats (messaging_group_id,state,serving_agent_group_id,principal_present,created_at,updated_at) VALUES ('trip','job','job',1,?,?)",
    now,
    now,
  );
  source = (await resolveSession('job', 'trip', null, 'shared')).session;
  other = (await resolveSession('other', null, null, 'agent-shared')).session;
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const send = (id: string, target: string, thread_id?: string) => ({
  id,
  platform_id: target,
  thread_id,
  content: JSON.stringify({ text: 'Please check the public schedule.' }),
  in_reply_to: null,
});
function messages(session: Session) {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    return db.prepare('SELECT id, content FROM messages_in').all() as { id: string; content: string }[];
  } finally {
    db.close();
  }
}
it('routes an explicitly configured native agent connection and refuses an unconnected send', async () => {
  await createDestination({
    agent_group_id: 'job',
    local_name: 'other',
    target_type: 'agent',
    target_id: 'other',
    created_at: new Date().toISOString(),
  });
  await routeAgentMessage(send('connected', 'other'), source);
  const stored = await withExistingMailboxSession(other.agent_group_id, other.id, (mailbox) =>
    mailbox.countDueMessages(),
  );
  expect(stored).toBe(1);
  await expect(routeAgentMessage(send('unconnected', 'unconnected'), source)).rejects.toThrow();
});
it('preserves explicit job browser delegation, source-bound untrusted replies and another authorized delegator on revocation', async () => {
  const policy = `${ROOT}/browser/policy.json`;
  writeBrowserAccess(policy, { agentGroupIds: ['job', 'other'] });
  await reconcileBrowserGroup();
  await routeAgentMessage(send('job-errand', 'browser', 'new'), source);
  await routeAgentMessage(send('other-errand', 'browser', 'new'), other);
  const errands = await getDb().all<Session>(
    "SELECT * FROM sessions WHERE agent_group_id='browser' ORDER BY thread_id",
  );
  const jobErrand = errands.find((session) => session.thread_id?.startsWith('system:a2a:job:'));
  const otherErrand = errands.find((session) => session.thread_id?.startsWith('system:a2a:other:'));
  if (!jobErrand || !otherErrand) throw new Error('Missing native errand sessions');
  await new BrowserStore().jobForSession(jobErrand);
  await new BrowserStore().jobForSession(otherErrand);
  await expect(routeAgentMessage(send('foreign-report', 'other'), jobErrand)).rejects.toThrow('errand-reports');
  const requestId = messages(jobErrand)[0]?.id;
  if (!requestId) throw new Error('Missing delivered native errand');
  await routeAgentMessage({ ...send('job-report', 'job'), in_reply_to: requestId }, jobErrand);
  expect(messages(source)[0]?.content).toContain('EXTERNAL_UNTRUSTED_CONTENT');
  writeBrowserAccess(policy, { agentGroupIds: ['other'] });
  await reconcileBrowserGroup();
  expect(
    await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE thread_id = ?', jobErrand.thread_id),
  ).toEqual({ cancelled: 1 });
  expect(
    await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE thread_id = ?', otherErrand.thread_id),
  ).toEqual({ cancelled: 0 });
  expect(
    await getDb().get("SELECT * FROM agent_destinations WHERE agent_group_id='job' AND target_id='browser'"),
  ).toBeUndefined();
  await expect(routeAgentMessage(send('revoked', 'browser', 'new'), source)).rejects.toThrow();
  await expect(routeAgentMessage(send('still-granted', 'browser', 'new'), other)).resolves.toBeUndefined();
  expect((await getSession(otherErrand.id))?.status).toBe('active');
});
