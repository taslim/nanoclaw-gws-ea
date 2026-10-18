import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), 'browser-policy-tests');
});

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { browserAccessGroups, browserDelegators, errandSource, hasBrowserAccess } from './access.js';
import { readBrowserPolicy, type BrowserPolicy } from './policy.js';

const file = `${ROOT}/browser/policy.json`;
function write(policy: unknown): void {
  fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
}

beforeEach(async () => {
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  await runMigrations(await initTestDb());
  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-browser', 'browser'],
    ['ag-external', 'external-email'],
    ['ag-research', 'Research Desk'],
    ['ag-other-main', 'Main'],
  ])
    await createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ?, external_email_agent_group_id = ? WHERE singleton = 1',
    'ag-main',
    'ag-browser',
    'ag-external',
  );
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('version 1', () => {
  it('grants main alone, whether the browser is enabled, disabled or has no policy at all', async () => {
    const policies: BrowserPolicy[] = [await readBrowserPolicy(file)];
    write({ schemaVersion: 1, enabled: true });
    policies.push(await readBrowserPolicy(file));
    write({ schemaVersion: 1, enabled: false });
    policies.push(await readBrowserPolicy(file));
    expect(policies.map((policy) => policy.status)).toEqual(['disabled', 'enabled', 'disabled']);
    for (const policy of policies) {
      expect(policy).toMatchObject({ access: { version: 1 } });
      expect(await browserAccessGroups(policy)).toEqual(['ag-main']);
      expect(await hasBrowserAccess('ag-main', policy)).toBe(true);
      expect(await hasBrowserAccess('ag-research', policy)).toBe(false);
    }
  });

  it('refuses a list it does not read', async () => {
    write({ schemaVersion: 1, enabled: true, agentGroupIds: ['ag-research'] });
    expect(await readBrowserPolicy(file)).toMatchObject({ status: 'unavailable', reason: 'invalid-browser-policy' });
  });
});

describe('version 2', () => {
  it('grants exactly the groups it lists, and keeps them while disabled', async () => {
    write({ schemaVersion: 2, enabled: true, agentGroupIds: ['ag-research', 'ag-main'] });
    const enabled = await readBrowserPolicy(file);
    expect(enabled).toMatchObject({
      status: 'enabled',
      access: { version: 2, agentGroupIds: ['ag-research', 'ag-main'] },
    });
    expect(await browserAccessGroups(enabled)).toEqual(['ag-research', 'ag-main']);
    write({ schemaVersion: 2, enabled: false, agentGroupIds: ['ag-research'] });
    const disabled = await readBrowserPolicy(file);
    expect(disabled).toMatchObject({ status: 'disabled', access: { version: 2, agentGroupIds: ['ag-research'] } });
    expect(await hasBrowserAccess('ag-research', disabled)).toBe(true);
    expect(await hasBrowserAccess('ag-main', disabled)).toBe(false);
  });

  it('allows no delegator when its list is empty, main included', async () => {
    write({ schemaVersion: 2, enabled: true, agentGroupIds: [] });
    const policy = await readBrowserPolicy(file);
    expect(policy).toMatchObject({ status: 'enabled', access: { version: 2, agentGroupIds: [] } });
    expect(await browserAccessGroups(policy)).toEqual([]);
    expect(await hasBrowserAccess('ag-main', policy)).toBe(false);
  });

  it.each([
    ['names the external-email group', ['ag-main', 'ag-external']],
    ['names the browser itself', ['ag-browser']],
  ])('reads as invalid, leaving the browser unavailable, when edited by hand so it %s', async (_case, ids) => {
    write({ schemaVersion: 2, enabled: true, agentGroupIds: ids });
    const policy = await readBrowserPolicy(file);
    expect(policy).toMatchObject({ status: 'unavailable', enabled: false, reason: 'invalid-browser-policy' });
    // Nothing runs while unavailable; main keeps its guidance, as under any unreadable policy.
    expect(await browserAccessGroups(policy)).toEqual(['ag-main']);
    expect(await hasBrowserAccess('ag-external', policy)).toBe(false);
  });

  it.each([
    ['a repeated group', { schemaVersion: 2, enabled: true, agentGroupIds: ['ag-main', 'ag-main'] }],
    ['an ID with whitespace', { schemaVersion: 2, enabled: true, agentGroupIds: ['ag main'] }],
    ['an empty ID', { schemaVersion: 2, enabled: true, agentGroupIds: [''] }],
    ['no list', { schemaVersion: 2, enabled: true }],
    ['a list that is not one', { schemaVersion: 2, enabled: true, agentGroupIds: 'ag-main' }],
    ['an unknown field', { schemaVersion: 2, enabled: true, agentGroupIds: [], profileDir: '/personal' }],
    ['a version this host does not read', { schemaVersion: 3, enabled: true, agentGroupIds: [] }],
  ])('reads %s as invalid', async (_case, policy) => {
    write(policy);
    expect(await readBrowserPolicy(file)).toMatchObject({ status: 'unavailable', reason: 'invalid-browser-policy' });
  });
});

it('names each delegator as the browser addresses it: main as main, any other group by its own name', async () => {
  write({ schemaVersion: 2, enabled: true, agentGroupIds: ['ag-other-main', 'ag-research', 'ag-main', 'ag-gone'] });
  expect(await browserDelegators(await readBrowserPolicy(file))).toEqual([
    { agentGroupId: 'ag-other-main', name: 'main-2' },
    { agentGroupId: 'ag-research', name: 'research-desk' },
    { agentGroupId: 'ag-main', name: 'main' },
  ]);
});

it('reads the group that opened an errand from its thread alone', () => {
  expect(errandSource('system:a2a:ag-research:msg-1')).toBe('ag-research');
  expect(errandSource('system:a2a:ag-main:msg:with:colons')).toBe('ag-main');
  for (const thread of [null, undefined, '', 'system:task:scheduled', 'system:a2a:ag-main:', 'system:a2a::x'])
    expect(errandSource(thread)).toBeUndefined();
});
