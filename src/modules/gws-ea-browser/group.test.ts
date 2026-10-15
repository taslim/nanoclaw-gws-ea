import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ROOT = '/private/tmp/browser-group-tests';
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  GROUPS_DIR: '/private/tmp/browser-group-tests/groups',
  DATA_DIR: '/private/tmp/browser-group-tests/data',
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));

import { resolveCapabilities } from '../../capabilities.js';
import { assertSessionAdmitted } from '../../container-runner.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import { getBrowserAgentGroupId } from '../gws-ea-profile/db.js';
import { getDb } from '../../db/connection.js';
import { resolveSystemSession } from '../../session-manager.js';
import '../gws-ea-profile/index.js';
import './index.js';
import './guidance.js';
import { browserGroupDrift, ensureBrowserGroup } from './group.js';

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('stamps the exact sealed composition once and refuses capability drift at admission', async () => {
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  const policy = `${ROOT}/browser/policy.json`;
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }), {
    mode: 0o600,
  });
  process.env.GWS_EA_BROWSER_POLICY_FILE = policy;
  const id = await ensureBrowserGroup();
  expect(await ensureBrowserGroup()).toBe(id);
  expect(await getBrowserAgentGroupId()).toBe(id);
  expect(await getContainerConfig(id)).toMatchObject({
    model: 'claude-sonnet-5-5',
    cli_scope: 'disabled',
    skills: '[]',
    capabilities: JSON.stringify(['browser', 'reply', 'files-send', 'files-read', 'time', 'request-status']),
  });
  expect(await browserGroupDrift(id)).toEqual([]);
  await updateContainerConfigJson(id, 'capabilities', [
    'browser',
    'reply',
    'files-send',
    'files-read',
    'time',
    'request-status',
    'shell',
  ]);
  expect(await browserGroupDrift(id)).toEqual([expect.stringContaining('capabilities')]);
  await expect(
    assertSessionAdmitted({ disposition: 'create', key: { installSlug: 'test', agentGroupId: id, sessionId: 'job' } }),
  ).rejects.toThrow('browser may not start');
  expect(resolveCapabilities('all', 'main')).toContain('browser-delegate');
  expect(resolveCapabilities('all', 'main')).not.toContain('browser');
});

it('composes main delegation only with enabled policy and gives the disabled operator instruction otherwise', async () => {
  const main = { id: 'main', name: 'main', folder: 'main', agent_provider: null, created_at: new Date().toISOString() };
  await createAgentGroup(main);
  const { getDb } = await import('../../db/connection.js');
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1', main.id);
  const file = `${ROOT}/browser/policy.json`;
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  process.env.GWS_EA_BROWSER_POLICY_FILE = file;
  let sections = await getRequiredProjectDocSections(main);
  expect(sections.find((section) => section.name === 'Browser delegation')?.body).toMatch(/operator.*enable/i);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }), { mode: 0o600 });
  sections = await getRequiredProjectDocSections(main);
  const guidance = sections.find((section) => section.name === 'Browser delegation')?.body;
  expect(guidance).toContain('thread: "new"');
  expect(guidance).toContain('relay_code');
  expect(guidance).toContain('no_item_for_site');
  expect(guidance).toContain('outcome_unknown');
  expect(guidance).toContain('password or token');
});

it('admits only canonical main errand sessions to the sealed browser group', async () => {
  await createAgentGroup({
    id: 'main',
    name: 'main',
    folder: 'main',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1', 'main');
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  const policy = `${ROOT}/browser/policy.json`;
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }), {
    mode: 0o600,
  });
  process.env.GWS_EA_BROWSER_POLICY_FILE = policy;
  const id = await ensureBrowserGroup();
  const own = (await resolveSystemSession(id, 'system:a2a:main:errand')).session;
  await expect(
    assertSessionAdmitted({ disposition: 'create', key: { installSlug: 'test', agentGroupId: id, sessionId: own.id } }),
  ).resolves.toBeUndefined();
  for (const thread of ['system:a2a:external:errand', 'system:task:scheduled', 'system:channel:chat']) {
    const foreign = (await resolveSystemSession(id, thread)).session;
    await expect(
      assertSessionAdmitted({
        disposition: 'create',
        key: { installSlug: 'test', agentGroupId: id, sessionId: foreign.id },
      }),
    ).rejects.toThrow('main-owned errand');
  }
});
