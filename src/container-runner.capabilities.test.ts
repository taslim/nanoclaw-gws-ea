/**
 * What a group's capabilities change about its container: the skills it is
 * handed and, for a group without a shell, the read-only layers over the
 * writable directories its settings and skills live in.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-container-runner-capabilities-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');

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
import { buildMounts, syncSkillSymlinks } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { getGatewayProvider } from './gateway-providers/index.js';
import { initGroupFilesystem } from './group-init.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import type { AgentGroup, Session } from './types.js';

const ALL = resolveCapabilities('all', 'capabilities-test');

function config(capabilities: string[], skills: string[] | 'all' = ['welcome']): ContainerConfig {
  return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills, capabilities };
}

async function seed(id: string): Promise<AgentGroup> {
  const ag: AgentGroup = { id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() };
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
  await initGroupFilesystem(ag, {});
  return ag;
}

async function mountsFor(ag: AgentGroup, capabilities: string[]): Promise<VolumeMount[]> {
  const session = { id: `${ag.id}-session`, agent_group_id: ag.id } as Session;
  return buildMounts(ag, session, config(capabilities), 'claude', {});
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

describe('restricted surfaces', () => {
  it('adds no layer for a group holding every key', async () => {
    const ag = await seed('caps-all');

    const paths = (await mountsFor(ag, ALL)).map((mount) => mount.containerPath);

    expect(paths).not.toContain('/home/node/.claude/skills');
    expect(paths).not.toContain('/workspace/agent/.claude');
  });

  it('lays the skills and Claude project directory read-only over a group without a shell', async () => {
    const ag = await seed('caps-reply');

    const mounts = await mountsFor(ag, ['reply', 'files-write']);

    const byPath = new Map(mounts.map((mount) => [mount.containerPath, mount]));
    // Without conversation-context its sessions are sealed, so the Claude home
    // is the session's own, and its skills are reachable through the writable
    // session mount too: the same read-only layer goes over both paths.
    const sessionSkills = path.join(DATA_DIR, 'v2-sessions', ag.id, `${ag.id}-session`, '.claude-shared', 'skills');
    for (const containerPath of ['/home/node/.claude/skills', '/workspace/.claude-shared/skills']) {
      expect(byPath.get(containerPath), containerPath).toMatchObject({ hostPath: sessionSkills, readonly: true });
    }
    expect(byPath.get('/workspace/agent/.claude')).toMatchObject({
      hostPath: path.join(GROUPS_DIR, ag.folder, '.claude'),
      readonly: true,
    });
    // The writable directories they sit in stay writable, and every layer
    // comes after the mount it covers.
    expect(byPath.get('/home/node/.claude')).toMatchObject({ readonly: false });
    expect(byPath.get('/workspace/agent')).toMatchObject({ readonly: false });
    const order = mounts.map((mount) => mount.containerPath);
    expect(order.indexOf('/home/node/.claude/skills')).toBeGreaterThan(order.indexOf('/home/node/.claude'));
    expect(order.indexOf('/workspace/.claude-shared/skills')).toBeGreaterThan(order.indexOf('/workspace'));
    expect(order.indexOf('/workspace/agent/.claude')).toBeGreaterThan(order.indexOf('/workspace/agent'));
    // The composed document and container.json are read-only for every group.
    expect(byPath.get('/workspace/agent/CLAUDE.md')).toMatchObject({ readonly: true });
  });

  // Claude reads project settings, skills, agents and commands from
  // /workspace/agent/.claude. For a group without a shell that path is the
  // host's own directory, created empty and mounted read-only, so the agent
  // cannot place a settings file there.
  it('serves the project settings directory from an empty read-only layer the host made', async () => {
    const ag = await seed('caps-planted');

    const mounts = await mountsFor(ag, ['reply']);

    const project = mounts.find((mount) => mount.containerPath === '/workspace/agent/.claude');
    expect(project?.readonly).toBe(true);
    expect(fs.readdirSync(project!.hostPath)).toEqual([]);
  });
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
