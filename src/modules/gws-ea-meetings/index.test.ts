/**
 * What the meetings module registers: main's side of the handoff as a
 * capability every default group holds, external-email's side off by
 * default, each side taught only its own tools, and every request a guarded
 * delivery action.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-meetings-index-test';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-gws-ea-meetings-index-test/groups',
  DATA_DIR: '/tmp/nanoclaw-gws-ea-meetings-index-test/data',
}));

import { resolveCapabilities } from '../../capabilities.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDeliveryAction } from '../../delivery.js';
import { listGuardedActions } from '../../guard/index.js';
import { composeGroupProjectDoc, DEFAULT_PROJECT_DOC } from '../../project-doc-compose.js';
import type { AgentGroup } from '../../types.js';
import { EXTERNAL_EMAIL_MEETINGS_CAPABILITY } from '../gws-ea-external-email/index.js';
import { MEETINGS_CAPABILITY } from './index.js';

const MODULES = path.join('container', 'agent-runner', 'src', 'mcp-tools');

async function composed(id: string, capabilities: 'all' | readonly string[]): Promise<string> {
  const group: AgentGroup = { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() };
  await createAgentGroup(group);
  await ensureContainerConfig(id);
  await updateContainerConfigJson(id, 'capabilities', capabilities === 'all' ? 'all' : [...capabilities]);
  const dir = path.join(TEST_ROOT, 'groups', id);
  fs.mkdirSync(dir, { recursive: true });
  await composeGroupProjectDoc(group, dir, DEFAULT_PROJECT_DOC);
  return fs.readFileSync(path.join(dir, DEFAULT_PROJECT_DOC.fileName), 'utf8');
}

function moduleDoc(name: string): string {
  return fs.readFileSync(path.join(MODULES, `${name}.instructions.md`), 'utf8').trim();
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('the meetings module', () => {
  it("gives main's side to every group on all, and external-email's side to none", () => {
    const all = resolveCapabilities('all', 'fixture');
    expect(all).toContain(MEETINGS_CAPABILITY);
    expect(all).not.toContain(EXTERNAL_EMAIL_MEETINGS_CAPABILITY);
  });

  it('teaches each side only its own tools', async () => {
    const main = await composed('ag-main', 'all');
    expect(main).toContain('# NanoClaw Module: gws-ea-meetings\n');
    expect(main).toContain(moduleDoc(MEETINGS_CAPABILITY));
    expect(main).not.toContain('# NanoClaw Module: gws-ea-meetings-external');

    const external = await composed('ag-external', ['reply', EXTERNAL_EMAIL_MEETINGS_CAPABILITY]);
    expect(external).toContain(moduleDoc(EXTERNAL_EMAIL_MEETINGS_CAPABILITY));
    expect(external).not.toContain('# NanoClaw Module: gws-ea-meetings\n');
    expect(external).not.toContain('ask_organizer');
  });

  it('registers every request as a delivery action behind a guard', () => {
    for (const action of [
      'meeting_arrange',
      'meeting_reschedule',
      'meeting_ask_organizer',
      'meeting_cancel',
      'meeting_amend',
      'meeting_outcome',
    ]) {
      expect(getDeliveryAction(action), action).toBeDefined();
    }
    const guarded = listGuardedActions().map((spec) => spec.action);
    expect(guarded).toEqual(expect.arrayContaining(['gws_ea_meetings.request', 'gws_ea_meetings.outcome']));
  });
});
