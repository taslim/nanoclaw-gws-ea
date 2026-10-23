/**
 * The assistant's own agents are named by its display name (KTD1): main and
 * whichever of `external-email` and the browser exist take it from the
 * profile, by the groups the profile records, at every reconcile and at
 * creation. Any other group keeps its own name.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-assistant-name-test';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-gws-ea-assistant-name-test/groups',
  DATA_DIR: '/tmp/nanoclaw-gws-ea-assistant-name-test/data',
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { materializeContainerJson } from '../../container-config.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import type { AgentGroup } from '../../types.js';
import { ensureBrowserGroup } from '../gws-ea-browser/group.js';
import { ensureExternalEmailGroup } from '../gws-ea-external-email/group.js';
import { reconcileGwsEaProfile } from './db.js';
import './index.js';

function group(id: string, name: string): AgentGroup {
  return { id, name, folder: id, agent_provider: null, created_at: '2026-10-19T00:00:00.000Z' };
}

async function createGroup(value: AgentGroup): Promise<void> {
  await createAgentGroup(value);
  await ensureContainerConfig(value.id);
}

async function reconcile(firstName: string, lastName: string): Promise<void> {
  await reconcileGwsEaProfile({
    assistantName: { firstName, lastName },
    assistantWorkspaceEmail: 'remy@example.test',
    principalName: { firstName: 'Morgan', lastName: 'Ellery' },
    principalTimezone: 'America/New_York',
    mainAgentGroupId: 'ag-main',
    principalEmails: ['morgan@example.test'],
  });
}

async function assistantName(agentGroupId: string): Promise<string | null | undefined> {
  return (await getContainerConfig(agentGroupId))?.assistant_name;
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  await createGroup(group('ag-main', 'main'));
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("the assistant's own agents carry its display name", () => {
  it('names main, external-email and the browser at a reconcile, and each spawns as that name', async () => {
    const externalEmail = await ensureExternalEmailGroup();
    const browser = await ensureBrowserGroup();

    await reconcile('Remy', 'Vance');

    for (const id of ['ag-main', externalEmail, browser]) {
      expect(await assistantName(id)).toBe('Remy Vance');
      expect((await materializeContainerJson(id)).assistantName).toBe('Remy Vance');
    }
  });

  it('writes nothing when a second reconcile holds the same name', async () => {
    const externalEmail = await ensureExternalEmailGroup();
    await reconcile('Remy', 'Vance');
    const before = [await getContainerConfig('ag-main'), await getContainerConfig(externalEmail)];

    await reconcile('Remy', 'Vance');

    expect([await getContainerConfig('ag-main'), await getContainerConfig(externalEmail)]).toEqual(before);
  });

  it('renames all three when a reconcile renames the assistant', async () => {
    const externalEmail = await ensureExternalEmailGroup();
    const browser = await ensureBrowserGroup();
    await reconcile('Remy', 'Vance');

    await reconcile('Juno', 'Hale');

    for (const id of ['ag-main', externalEmail, browser]) expect(await assistantName(id)).toBe('Juno Hale');
  });

  it('leaves a group main made with create_agent to its own name', async () => {
    await createGroup(group('ag-research', 'research'));

    await reconcile('Remy', 'Vance');

    expect(await assistantName('ag-research')).toBeNull();
    expect((await materializeContainerJson('ag-research')).assistantName).toBe('research');
  });

  it('names external-email and the browser at creation once the profile holds the name', async () => {
    await reconcile('Remy', 'Vance');

    const externalEmail = await ensureExternalEmailGroup();
    const browser = await ensureBrowserGroup();

    expect(await assistantName(externalEmail)).toBe('Remy Vance');
    expect(await assistantName(browser)).toBe('Remy Vance');
  });

  it('names an external-email created before the profile named the assistant at the next reconcile', async () => {
    const externalEmail = await ensureExternalEmailGroup();
    expect(await assistantName(externalEmail)).toBeNull();

    await reconcile('Remy', 'Vance');

    expect(await assistantName(externalEmail)).toBe('Remy Vance');
  });
});
