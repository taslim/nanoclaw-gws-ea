/**
 * What a group's capabilities change about its container: the skills it is
 * handed.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-container-runner-capabilities-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-container-runner-capabilities-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-container-runner-capabilities-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { resolveCapabilities } from './capabilities.js';
import type { ContainerConfig } from './container-config.js';
import { syncSkillSymlinks } from './container-runner.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { getGatewayProvider } from './gateway-providers/index.js';

const ALL = resolveCapabilities('all', 'capabilities-test');

function config(capabilities: string[], skills: string[] | 'all' = ['welcome']): ContainerConfig {
  return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills, capabilities };
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

describe('skills within capabilities', () => {
  function tmpClaudeDir(): string {
    return fs.mkdtempSync(path.join(TEST_ROOT, 'claude-'));
  }

  it("hands a group holding every key its selection and the gateway's skill", () => {
    const linked = syncSkillSymlinks(tmpClaudeDir(), config(ALL, ['welcome', 'agent-browser']));

    expect(linked).toEqual(['welcome', 'agent-browser', ...getGatewayProvider().agentSkills]);
  });

  it('hands a group without a shell no command-line skill and no gateway skill', () => {
    const linked = syncSkillSymlinks(
      tmpClaudeDir(),
      config(['reply', 'web'], ['welcome', 'agent-browser', 'gcalendar']),
    );

    expect(linked).toEqual(['welcome']);
  });

  it('withholds a skill whose key the group lacks', () => {
    expect(syncSkillSymlinks(tmpClaudeDir(), config(['time'], ['welcome']))).toEqual([]);
  });
});
