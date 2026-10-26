import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ROOT = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), 'browser-policy-tests');
});

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import '../capabilities/index.js';
import { browserAccessGroups, browserDelegators, errandSource, hasBrowserAccess } from './access.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';

beforeEach(async () => {
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  await runMigrations(await initTestDb());
  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-browser', 'browser'],
    ['ag-external', 'external-email'],
    ['ag-chat', 'external-chat'],
    ['ag-research', 'Research Desk'],
    ['ag-other-main', 'Main'],
  ])
    await createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ?, browser_agent_group_id = ?, external_email_agent_group_id = ? WHERE singleton = 1`,
    'ag-main',
    'ag-browser',
    'ag-external',
  );
  await getDb().run('UPDATE gws_ea_profile SET external_chat_agent_group_id = ? WHERE singleton = 1', 'ag-chat');
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('always grants main and requires an explicit stored key for every other group', async () => {
  expect(await hasBrowserAccess('ag-main')).toBe(true);
  expect(await hasBrowserAccess('ag-research')).toBe(false);
  await ensureContainerConfig('ag-research');
  await updateContainerConfigJson('ag-research', 'capabilities', 'all');
  expect(await hasBrowserAccess('ag-research')).toBe(false);
  await updateContainerConfigJson('ag-research', 'capabilities', ['browser-delegate']);
  expect(await hasBrowserAccess('ag-research')).toBe(true);
  expect(await browserAccessGroups()).toEqual(expect.arrayContaining(['ag-main', 'ag-research']));
});

it('never grants sealed or nonexistent groups even when their stored selection includes the key', async () => {
  for (const id of ['ag-browser', 'ag-external', 'ag-chat']) {
    await ensureContainerConfig(id);
    await updateContainerConfigJson(id, 'capabilities', ['browser-delegate']);
    expect(await hasBrowserAccess(id)).toBe(false);
  }
  expect(await hasBrowserAccess('ag-gone')).toBe(false);
});

it('gives delegators unique destination names while preserving main', async () => {
  for (const id of ['ag-other-main', 'ag-research']) {
    await ensureContainerConfig(id);
    await updateContainerConfigJson(id, 'capabilities', ['browser-delegate']);
  }
  expect(await browserDelegators()).toEqual(
    expect.arrayContaining([
      { agentGroupId: 'ag-other-main', name: 'main-2' },
      { agentGroupId: 'ag-research', name: 'research-desk' },
      { agentGroupId: 'ag-main', name: 'main' },
    ]),
  );
});

it('reads the group that opened an errand from its thread alone', () => {
  expect(errandSource('system:a2a:ag-research:msg-1')).toBe('ag-research');
  expect(errandSource('system:a2a:ag-main:msg:with:colons')).toBe('ag-main');
  for (const thread of [null, undefined, '', 'system:task:scheduled', 'system:a2a:ag-main:', 'system:a2a::x'])
    expect(errandSource(thread)).toBeUndefined();
});
