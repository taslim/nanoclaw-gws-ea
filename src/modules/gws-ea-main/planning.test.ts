import { afterEach, beforeEach, expect, it } from 'vitest';

import { getGroupCapabilities } from '../../capabilities.js';
import { composeContainerEnv } from '../../container-env.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import '../capabilities/index.js';
import '../gws-ea-profile/index.js';
import './index.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
});

it('contributes planning definitions only to canonical main, excluding outward agents even with an explicit stored grant', async () => {
  for (const id of ['planning-main', 'external-email', 'external-chat']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: '2026-10-28T00:00:00.000Z' });
    await ensureContainerConfig(id);
    await updateContainerConfigJson(id, 'capabilities', ['gws-ea-main-context']);
  }
  await reconcileGwsEaProfile({
    assistantName: { firstName: 'Juno', lastName: 'Hale' },
    assistantWorkspaceEmail: 'juno@example.test',
    principalName: { firstName: 'Morgan', lastName: 'Ellery' },
    principalTimezone: 'America/Los_Angeles',
    mainAgentGroupId: 'planning-main',
  });
  for (const id of ['planning-main', 'external-email', 'external-chat']) {
    const capabilities = new Set(await getGroupCapabilities(id));
    const env = composeContainerEnv({ agentGroupId: id, capabilities }, new Set());
    expect(env.GWS_EA_PLANNING_AGENTS).toBe(id === 'planning-main' ? '1' : undefined);
  }
});
