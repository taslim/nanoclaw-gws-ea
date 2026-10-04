/**
 * Covers R20 for the provider's own state: each external-email session gets
 * its own Claude home, so one thread's transcript never reaches another's
 * container.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-external-email-sessions-test';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-gws-ea-external-email-sessions-test/groups',
  DATA_DIR: '/tmp/nanoclaw-gws-ea-external-email-sessions-test/data',
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { configFromDb } from '../../container-config.js';
import { buildMounts } from '../../container-runner.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { closeDb, getAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { initGroupFilesystem } from '../../group-init.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import type { VolumeMount } from '../../providers/provider-container-registry.js';
import type { AgentGroup, Session } from '../../types.js';
import { getExternalEmailAgentGroupId } from './index.js';
import '../gws-ea-profile/index.js';

const DATA_DIR = path.join(TEST_ROOT, 'data');
const CLAUDE_HOME = '/home/node/.claude';

async function startHost(): Promise<void> {
  const signal = new AbortController().signal;
  const deliveryAdapter = { deliver: async () => undefined };
  for (const start of getHostStartCallbacks()) await start({ db: getDb(), deliveryAdapter, signal });
}

async function mountsFor(group: AgentGroup, sessionId: string): Promise<VolumeMount[]> {
  await initGroupFilesystem(group, { provider: 'claude' });
  const row = await getContainerConfig(group.id);
  if (!row) throw new Error(`no container config for ${group.id}`);
  const session = { id: sessionId, agent_group_id: group.id } as Session;
  return buildMounts(group, session, configFromDb(row, group), 'claude', {});
}

function home(mounts: readonly VolumeMount[]): VolumeMount {
  const found = mounts.find((mount) => mount.containerPath === CLAUDE_HOME);
  if (!found) throw new Error('no Claude home mounted');
  return found;
}

function under(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

describe("external-email's Claude home", () => {
  it("is each session's own: session A cannot read session B's transcript", async () => {
    await startHost();
    const id = await getExternalEmailAgentGroupId();
    const ee = id === null ? undefined : await getAgentGroup(id);
    if (!ee) throw new Error('external-email was not created');

    const a = await mountsFor(ee, 'sess-a');
    const b = await mountsFor(ee, 'sess-b');

    const homeA = home(a);
    const homeB = home(b);
    expect(homeA.hostPath).toBe(path.join(DATA_DIR, 'v2-sessions', ee.id, 'sess-a', '.claude-shared'));
    expect(homeB.hostPath).toBe(path.join(DATA_DIR, 'v2-sessions', ee.id, 'sess-b', '.claude-shared'));
    expect(homeA).toMatchObject({ readonly: false, mountClass: 'group-state' });
    // Each session starts from the settings every group starts from, memory off.
    const settings = JSON.parse(fs.readFileSync(path.join(homeA.hostPath, 'settings.json'), 'utf8')) as {
      autoMemoryEnabled?: unknown;
    };
    expect(settings.autoMemoryEnabled).toBe(false);

    // A transcript session A writes is under no path session B mounts, and
    // no session mounts the group-wide home.
    const transcript = path.join(homeA.hostPath, 'projects', '-workspace-agent', 'thread-a.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"thread":"a"}\n');
    const groupHome = path.join(DATA_DIR, 'v2-sessions', ee.id, '.claude-shared');
    for (const mount of b) {
      expect(under(transcript, mount.hostPath), mount.containerPath).toBe(false);
      expect(under(mount.hostPath, groupHome), mount.containerPath).toBe(false);
    }
    // Its skills directory stays read-only over the session's own home, and
    // over the same directory where the writable session mount reaches it.
    for (const containerPath of [`${CLAUDE_HOME}/skills`, '/workspace/.claude-shared/skills']) {
      expect(b.find((mount) => mount.containerPath === containerPath)).toMatchObject({
        hostPath: path.join(homeB.hostPath, 'skills'),
        readonly: true,
      });
    }
    const order = b.map((mount) => mount.containerPath);
    expect(order.indexOf('/workspace/.claude-shared/skills')).toBeGreaterThan(order.indexOf('/workspace'));
  });
});
