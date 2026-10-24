import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ROOT = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), 'browser-group-tests');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  GROUPS_DIR: `${ROOT}/groups`,
  DATA_DIR: `${ROOT}/data`,
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));

import { getGroupCapabilities, resolveCapabilities } from '../../capabilities.js';
import { materializeContainerJson } from '../../container-config.js';
import { assertSessionAdmitted } from '../../container-runner.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import { getBrowserAgentGroupId } from '../gws-ea-profile/db.js';
import { getDb } from '../../db/connection.js';
import { resolveSystemSession } from '../../session-manager.js';
import '../gws-ea-profile/index.js';
import './index.js';
import './guidance.js';
import { browserGroupDrift, ensureBrowserGroup, setBrowserAdmissionReady } from './group.js';
import { writeBrowserAccess } from './testing/browser-access.js';

beforeEach(async () => {
  setBrowserAdmissionReady(true);
  fs.rmSync(ROOT, { recursive: true, force: true });
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  setBrowserAdmissionReady(false);
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('stamps the exact sealed composition once and refuses capability drift at admission', async () => {
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  const policy = `${ROOT}/browser/policy.json`;
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, enabled: true }), {
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
  // A stored selection never grants the delegate tools: the browser access setting does.
  expect(resolveCapabilities('all', 'main')).not.toContain('browser-delegate');
  expect(resolveCapabilities('all', 'main')).not.toContain('browser');
});

it('keeps active main guidance conditional so enablement changes need no container restart', async () => {
  const main = { id: 'main', name: 'main', folder: 'main', agent_provider: null, created_at: new Date().toISOString() };
  await createAgentGroup(main);
  const { getDb } = await import('../../db/connection.js');
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    main.id,
  );
  const file = `${ROOT}/browser/policy.json`;
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  process.env.GWS_EA_BROWSER_POLICY_FILE = file;
  const original = await getRequiredProjectDocSections(main);
  const initialGuidance = original.find((section) => section.name === 'Browser delegation')?.body;
  expect(initialGuidance).toContain('Access can change during a conversation');
  expect(initialGuidance).toContain('shared signed-in profile and vault');
  expect(initialGuidance).toContain('try each new errand');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true }), { mode: 0o600 });
  const sections = await getRequiredProjectDocSections(main);
  const guidance = sections.find((section) => section.name === 'Browser delegation')?.body;
  expect(guidance).toBe(initialGuidance);
  expect(guidance).toContain('principal approvals');
  expect(guidance).toContain('In a group other than main, take outcomes needing the principal to main');
  expect(guidance).toContain('Never ask for or accept card details in chat');
  expect(guidance).toContain('there is no way to use card details sent to you');
  expect(guidance).toContain('adds one on the site or finishes checkout themselves');
  expect(guidance).toContain('tell the principal their operator needs to enable it');
  expect(guidance).toContain(
    "only to a site the principal's request names, or the booking platform embedded in that site",
  );
  // The shared guide is judgment; tool descriptions and job instructions carry result meanings.
  expect(guidance).not.toMatch(/relay_code|no_item_for_site|vault_unavailable|outcome_unknown|--job/u);
  // Operator setup stays the operator's: main never relays its commands or provider-administration terms.
  expect(guidance).not.toMatch(/gws-ea|capabilit|service account/iu);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: false }));
  expect(
    (await getRequiredProjectDocSections(main)).find((section) => section.name === 'Browser delegation')?.body,
  ).toBe(initialGuidance);
});

it('admits only canonical main errand sessions to the sealed browser group', async () => {
  await createAgentGroup({
    id: 'main',
    name: 'main',
    folder: 'main',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    'main',
  );
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  const policy = `${ROOT}/browser/policy.json`;
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, enabled: true }), {
    mode: 0o600,
  });
  process.env.GWS_EA_BROWSER_POLICY_FILE = policy;
  const id = await ensureBrowserGroup();
  const own = (await resolveSystemSession(id, 'system:a2a:main:errand')).session;
  await expect(
    assertSessionAdmitted({ disposition: 'create', key: { installSlug: 'test', agentGroupId: id, sessionId: own.id } }),
  ).resolves.toBeUndefined();
  setBrowserAdmissionReady(false);
  for (const disposition of ['create', 'adopt'] as const)
    await expect(
      assertSessionAdmitted({ disposition, key: { installSlug: 'test', agentGroupId: id, sessionId: own.id } }),
    ).rejects.toThrow('host browser recovery is unavailable');
  setBrowserAdmissionReady(true);
  await expect(
    assertSessionAdmitted({ disposition: 'adopt', key: { installSlug: 'test', agentGroupId: id, sessionId: own.id } }),
  ).resolves.toBeUndefined();
  for (const thread of ['system:a2a:external:errand', 'system:task:scheduled', 'system:channel:chat']) {
    const foreign = (await resolveSystemSession(id, thread)).session;
    await expect(
      assertSessionAdmitted({
        disposition: 'create',
        key: { installSlug: 'test', agentGroupId: id, sessionId: foreign.id },
      }),
    ).rejects.toThrow('errand delegated by an agent with browser access');
  }
});

it('hands the delegate tools to main under version 1, enabled or not, and to no other group', async () => {
  for (const id of ['main', 'research']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await ensureContainerConfig(id);
  }
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    'main',
  );
  expect((await getGroupCapabilities('main')).has('browser-delegate')).toBe(true);
  expect((await getGroupCapabilities('research')).has('browser-delegate')).toBe(false);
  // Stored explicitly, the key is still the setting's to grant.
  await updateContainerConfigJson('research', 'capabilities', ['reply', 'browser-delegate']);
  expect((await materializeContainerJson('research')).capabilities).toEqual(['reply']);
  expect((await materializeContainerJson('main')).capabilities).toContain('browser-delegate');
  expect(
    JSON.parse(fs.readFileSync(`${ROOT}/groups/main/container.json`, 'utf8')) as { capabilities: string[] },
  ).toMatchObject({ capabilities: expect.arrayContaining(['browser-delegate']) });
});

it('hands record_purchase_outcome to main and every delegator, main off the access list included', async () => {
  for (const id of ['main', 'research', 'desk']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await ensureContainerConfig(id);
  }
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    'main',
  );
  writeBrowserAccess(`${ROOT}/browser/policy.json`, { agentGroupIds: ['research'] });
  // Main records the purchases of a group that lost access, so it holds the tool the unconfirmed note names.
  expect((await getGroupCapabilities('main')).has('browser-delegate')).toBe(false);
  expect((await getGroupCapabilities('main')).has('browser-purchase-outcome')).toBe(true);
  expect((await getGroupCapabilities('research')).has('browser-purchase-outcome')).toBe(true);
  expect((await getGroupCapabilities('desk')).has('browser-purchase-outcome')).toBe(false);
  expect((await materializeContainerJson('main')).capabilities).toContain('browser-purchase-outcome');
});

it('admits the errands of every listed group, and no longer main once the list leaves it out', async () => {
  for (const id of ['main', 'research'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    'main',
  );
  writeBrowserAccess(`${ROOT}/browser/policy.json`, { agentGroupIds: ['research'] });
  const id = await ensureBrowserGroup();
  const admit = async (thread: string) =>
    assertSessionAdmitted({
      disposition: 'create',
      key: { installSlug: 'test', agentGroupId: id, sessionId: (await resolveSystemSession(id, thread)).session.id },
    });
  await expect(admit('system:a2a:research:errand')).resolves.toBeUndefined();
  await expect(admit('system:a2a:main:errand')).rejects.toThrow('errand delegated by an agent with browser access');
});
