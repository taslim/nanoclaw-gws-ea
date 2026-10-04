/**
 * What the meetings module teaches: main's side of the handoff to every
 * default group, external-email's side only to a group that holds it, and
 * each side only its own tools. Each side's capability names every tool it
 * grants, so an operator choosing capabilities sees them all. The runner's
 * tools and the host's actions share one set of names: the container cannot
 * import the host, so the runner's copy is pinned here.
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

/** Every capability as its module registered it, by key. */
const registered = vi.hoisted(() => new Map<string, { readonly description: string }>());
vi.mock('../../capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../capabilities.js')>();
  return {
    ...actual,
    registerCapability: (key: string, def: Parameters<typeof actual.registerCapability>[1]) => {
      registered.set(key, def);
      actual.registerCapability(key, def);
    },
  };
});

import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { composeGroupProjectDoc, DEFAULT_PROJECT_DOC } from '../../project-doc-compose.js';
import type { AgentGroup } from '../../types.js';
import { EXTERNAL_EMAIL_MEETINGS_CAPABILITY } from '../gws-ea-external-email/index.js';
import { MEETING_ACTIONS } from './index.js';

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
  it('teaches each side only its own tools', async () => {
    const main = await composed('ag-main', 'all');
    expect(main).toContain('# NanoClaw Module: gws-ea-meetings\n');
    expect(main).toContain(moduleDoc('gws-ea-meetings'));
    expect(main).not.toContain('# NanoClaw Module: gws-ea-meetings-external');

    const external = await composed('ag-external', ['reply', EXTERNAL_EMAIL_MEETINGS_CAPABILITY]);
    expect(external).toContain(moduleDoc(EXTERNAL_EMAIL_MEETINGS_CAPABILITY));
    expect(external).not.toContain('# NanoClaw Module: gws-ea-meetings\n');
    expect(external).not.toContain('meeting_arrange');
  });

  it("names every tool each side's capability grants", () => {
    const tools: Readonly<Record<string, readonly string[]>> = {
      'gws-ea-meetings': [
        'meeting_arrange',
        'meeting_reschedule',
        'meeting_cancel',
        'meeting_amend',
        'email_respond',
        'email_dismiss',
        'email_reply_to_principal',
      ],
      [EXTERNAL_EMAIL_MEETINGS_CAPABILITY]: [
        'meeting_free_time',
        'meeting_hold',
        'meeting_book',
        'meeting_ask_main',
        'email_recipients',
        'meeting_outcome',
      ],
    };
    // Every action the host answers is granted to one side or the other.
    expect(Object.values(tools).flat().sort()).toEqual([...MEETING_ACTIONS].sort());
    for (const [key, names] of Object.entries(tools)) {
      const description = registered.get(key)?.description ?? '';
      for (const name of names) expect(description, `${key} names ${name}`).toContain(name);
    }
  });
});

describe("the runner's meeting tools", () => {
  it('each send the host action of their own name, and every action has its tool', () => {
    const runner = fs.readFileSync(path.join(MODULES, 'gws-ea-meetings.ts'), 'utf8');
    const names = [...runner.matchAll(/requestTool\(\{\s*name: '([a-z_]+)'/gu)].map((match) => match[1]);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...MEETING_ACTIONS].sort());
  });
});
