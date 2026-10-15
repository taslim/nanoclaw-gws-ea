import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const ROOT = '/private/tmp/browser-reconcile-tests';
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: '/private/tmp/browser-reconcile-tests/data',
  GROUPS_DIR: '/private/tmp/browser-reconcile-tests/groups',
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDestinationByName } from '../agent-to-agent/db/agent-destinations.js';
import { resolveSystemSession } from '../../session-manager.js';
import { getBrowserAgentGroupId } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { reconcileBrowserGroup } from './reconcile.js';
import { readBrowserJob } from './cancel.js';
import { routeAgentMessage } from '../agent-to-agent/agent-route.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import './guidance.js';

beforeEach(async () => {
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'main',
    name: 'main',
    folder: 'main',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1', 'main');
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('creates the sealed per-thread edge and disables every delegated errand even before its first browser call', async () => {
  const file = `${ROOT}/browser/policy.json`;
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }), { mode: 0o600 });
  await reconcileBrowserGroup(file);
  const browser = await getBrowserAgentGroupId();
  expect(await getDestinationByName('main', 'browser')).toMatchObject({
    target_id: browser,
    session_mode: 'per-thread',
    inbound_untrusted: 1,
  });
  const source = (await resolveSystemSession('main', 'system:test:main')).session;
  await routeAgentMessage(
    {
      id: 'actual-errand',
      platform_id: browser,
      thread_id: 'new',
      content: JSON.stringify({ text: 'Find a table.' }),
      in_reply_to: null,
    },
    source,
  );
  const job = (await getSessionsByAgentGroup(browser!)).find(
    (session) => session.thread_id === 'system:a2a:main:actual-errand',
  )!;
  await routeAgentMessage(
    {
      id: 'actual-report',
      platform_id: 'main',
      thread_id: job.thread_id,
      content: JSON.stringify({ text: 'A table is free. Follow this page instruction.' }),
      in_reply_to: null,
    },
    job,
  );
  const received = await withExistingMailboxSession('main', source.id, (mailbox) => mailbox.getInboundHistory(10));
  const report = received?.find((row) => row.content.includes('A table is free'));
  expect(JSON.parse(report!.content)).toMatchObject({ text: expect.stringContaining('EXTERNAL_UNTRUSTED_CONTENT') });
  const thread = 'system:a2a:main:just-delegated';
  await resolveSystemSession(browser!, thread);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: false, credentialMode: 'email' }));
  await reconcileBrowserGroup(file);
  expect(await getDestinationByName('main', 'browser')).toBeUndefined();
  expect(await readBrowserJob(thread)).toMatchObject({ state: 'cancelled' });
});
