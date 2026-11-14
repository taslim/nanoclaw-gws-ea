import { useAvailableBrowser } from './testing/browser-runtime.js';
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
import { reconcileSealedGateway } from '../gws-ea-sealed-gateway/gateway.js';
import {
  APP_SECRET,
  MODEL_SECRET,
  useFakeGateway,
  type FakeGateway,
} from '../gws-ea-sealed-gateway/testing/fake-gateway.js';
import { getDb } from '../../db/connection.js';
import { resolveSystemSession } from '../../session-manager.js';
import '../gws-ea-profile/index.js';
import './index.js';
import './guidance.js';
import { BROWSER_NAME, browserGroupDrift, ensureBrowserGroup, setBrowserAdmissionReady } from './group.js';
import { reconcileBrowserGroup } from './reconcile.js';
import { configureBrowserAccess } from './testing/browser-access.js';

let gateway: FakeGateway;

beforeEach(async () => {
  gateway = useFakeGateway();
  useAvailableBrowser();
  setBrowserAdmissionReady(true);
  fs.rmSync(ROOT, { recursive: true, force: true });
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  setBrowserAdmissionReady(false);
  delete process.env.GWS_EA_BROWSER_ROOT;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('stamps the exact sealed composition once and refuses capability drift at admission', async () => {
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  const policy = `${ROOT}/browser`;

  process.env.GWS_EA_BROWSER_ROOT = policy;
  const id = await ensureBrowserGroup();
  expect(await ensureBrowserGroup()).toBe(id);
  expect(await getBrowserAgentGroupId()).toBe(id);
  expect(await getContainerConfig(id)).toMatchObject({
    model: 'claude-sonnet-5-5',
    cli_scope: 'disabled',
    skills: '[]',
    capabilities: JSON.stringify(['browser', 'reply', 'files-send', 'files-read', 'time', 'request-status']),
  });
  expect(await browserGroupDrift(id)).toEqual(['its gateway identity is missing']);
  await reconcileSealedGateway(id, BROWSER_NAME);
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
  // The default all selection excludes delegation; main receives it through its authority.
  expect(resolveCapabilities('all', 'main')).not.toContain('browser-delegate');
  expect(resolveCapabilities('all', 'main')).not.toContain('browser');
});

it('keeps main guidance stable while browser availability changes', async () => {
  const main = { id: 'main', name: 'main', folder: 'main', agent_provider: null, created_at: new Date().toISOString() };
  await createAgentGroup(main);
  const { getDb } = await import('../../db/connection.js');
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    main.id,
  );
  const file = `${ROOT}/browser`;
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  process.env.GWS_EA_BROWSER_ROOT = file;
  const original = await getRequiredProjectDocSections(main);
  const initialGuidance = original.find((section) => section.name === 'Browser delegation')?.body;
  expect(initialGuidance).toContain('Access can change during a conversation');
  expect(initialGuidance).toContain('shared signed-in profile');
  expect(initialGuidance).toContain('try each new errand');

  const sections = await getRequiredProjectDocSections(main);
  const guidance = sections.find((section) => section.name === 'Browser delegation')?.body;
  expect(guidance).toBe(initialGuidance);
  expect(guidance).toContain('principal approvals');
  expect(guidance).toContain('In a group other than main, take outcomes needing the principal to main');
  expect(guidance).toContain('Never ask for or accept card details in chat');
  expect(guidance).toContain('there is no way to use card details sent to you');
  expect(guidance).toContain('adds one on the site or finishes checkout themselves');
  expect(guidance).toContain(
    'If `browser` is unknown in main, tell the principal to ask their operator to configure the browser root; elsewhere, to check the group’s access grant.',
  );
  expect(guidance).toContain(
    'If the host reports Chrome unavailable, tell the principal to ask their operator to check Chrome.',
  );
  expect(guidance).toContain(
    "only to a site the principal's request names, or the booking platform embedded in that site",
  );
  // The shared guide is judgment; tool descriptions and job instructions carry result meanings.
  expect(guidance).not.toMatch(/relay_code|no_item_for_site|vault_unavailable|outcome_unknown|--job/u);
  // Operator setup stays the operator's: main never relays its commands or provider-administration terms.
  expect(guidance).not.toMatch(/gws-ea|capabilit|service account/iu);
  vi.stubEnv('GWS_EA_BROWSER_ROOT', '');
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
  const policy = `${ROOT}/browser`;

  process.env.GWS_EA_BROWSER_ROOT = policy;
  await reconcileBrowserGroup();
  const id = (await getBrowserAgentGroupId())!;
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

it('hands the delegate tools to main to main by default and to explicitly granted groups', async () => {
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
  // A stored explicit key grants delegation to an ordinary group.
  await updateContainerConfigJson('research', 'capabilities', ['reply', 'browser-delegate']);
  expect((await materializeContainerJson('research')).capabilities).toEqual([
    'reply',
    'browser-delegate',
    'browser-purchase-outcome',
  ]);
  expect((await materializeContainerJson('main')).capabilities).toContain('browser-delegate');
  expect(
    JSON.parse(fs.readFileSync(`${ROOT}/groups/main/container.json`, 'utf8')) as { capabilities: string[] },
  ).toMatchObject({ capabilities: expect.arrayContaining(['browser-delegate']) });
});

it('hands record_purchase_outcome to main and every delegator, main always included', async () => {
  for (const id of ['main', 'research', 'desk']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await ensureContainerConfig(id);
  }
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    'main',
  );
  await configureBrowserAccess(`${ROOT}/browser`, ['research']);
  // Main records the purchases of a group that lost access, so it holds the tool the unconfirmed note names.
  expect((await getGroupCapabilities('main')).has('browser-delegate')).toBe(true);
  expect((await getGroupCapabilities('main')).has('browser-purchase-outcome')).toBe(true);
  expect((await getGroupCapabilities('research')).has('browser-purchase-outcome')).toBe(true);
  expect((await getGroupCapabilities('desk')).has('browser-purchase-outcome')).toBe(false);
  expect((await materializeContainerJson('main')).capabilities).toContain('browser-purchase-outcome');
});

it('admits the errands of every explicitly granted group and always main', async () => {
  for (const id of ['main', 'research'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    'main',
  );
  await configureBrowserAccess(`${ROOT}/browser`, ['research']);
  await reconcileBrowserGroup();
  const id = (await getBrowserAgentGroupId())!;
  const admit = async (thread: string) =>
    assertSessionAdmitted({
      disposition: 'create',
      key: { installSlug: 'test', agentGroupId: id, sessionId: (await resolveSystemSession(id, thread)).session.id },
    });
  await expect(admit('system:a2a:research:errand')).resolves.toBeUndefined();
  await expect(admit('system:a2a:main:errand')).resolves.toBeUndefined();
});

it('gives browser a gateway identity holding only the model credential, refusing any other until repaired, and leaves main all', async () => {
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
  await configureBrowserAccess(`${ROOT}/browser`);
  gateway.createDefault('main', 'main');

  await reconcileBrowserGroup();
  const id = (await getBrowserAgentGroupId())!;
  expect(gateway.agents.get(id)).toMatchObject({ secretMode: 'selective', secrets: [MODEL_SECRET.id] });
  expect(gateway.injected(id, APP_SECRET.hostPattern)).toEqual([]);
  expect(gateway.injected(id, MODEL_SECRET.hostPattern)).toEqual([MODEL_SECRET.id]);
  const errand = (await resolveSystemSession(id, 'system:a2a:main:errand')).session;
  const admit = () =>
    assertSessionAdmitted({
      disposition: 'create',
      key: { installSlug: 'test', agentGroupId: id, sessionId: errand.id },
    });
  await expect(admit()).resolves.toBeUndefined();

  gateway.agents.get(id)!.secrets.push(APP_SECRET.id);
  expect(await browserGroupDrift(id)).toEqual(['its gateway secret assignments are not model-only']);
  await expect(admit()).rejects.toThrow('browser may not start: its gateway secret assignments are not model-only');
  gateway.agents.get(id)!.secretMode = 'all';
  await expect(admit()).rejects.toThrow('its gateway secret mode is not selective');

  await reconcileBrowserGroup();
  expect(gateway.agents.get(id)).toMatchObject({ secretMode: 'selective', secrets: [MODEL_SECRET.id] });
  await expect(admit()).resolves.toBeUndefined();
  expect(gateway.agents.get('main')).toMatchObject({ secretMode: 'all', secrets: [] });
  expect(gateway.injected('main', APP_SECRET.hostPattern)).toEqual([APP_SECRET.id]);
});
