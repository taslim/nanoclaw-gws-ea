/**
 * Covers R20 and R65 for what a session keeps: each external-email session
 * gets its own Claude home and its own inbox, so one thread's transcript and
 * files never reach another thread's container, and nothing it mounts reaches
 * main's folder, where main keeps what it knows of people (R10, R15).
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
import { closeDb, createAgentGroup, getAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { initGroupFilesystem } from '../../group-init.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { VolumeMount } from '../../providers/provider-container-registry.js';
import type { AgentGroup, Session } from '../../types.js';
import { getExternalEmailAgentGroupId } from './index.js';
import '../gws-ea-profile/index.js';

const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
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

/** Every file under `dir`, at any depth. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .flatMap((entry) => (entry.isFile() ? [path.join(entry.parentPath, entry.name)] : []));
}

async function externalEmail(): Promise<AgentGroup> {
  await startHost();
  const id = await getExternalEmailAgentGroupId();
  const ee = id === null ? undefined : await getAgentGroup(id);
  if (!ee) throw new Error('external-email was not created');
  return ee;
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
    const ee = await externalEmail();

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
  });
});

describe("external-email's files", () => {
  it("leave thread B's file tools nothing of thread A's: A's attachments stay in A's own session folder", async () => {
    const ee = await externalEmail();
    const a = await mountsFor(ee, 'sess-a');
    const b = await mountsFor(ee, 'sess-b');

    // An attachment reaches thread A, staged the way core stages every inbound file.
    await writeSessionMessage(ee.id, 'sess-a', {
      id: 'mail-a-1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        text: 'The contract is attached.',
        attachments: [{ name: 'contract-a.pdf', type: 'file', data: Buffer.from('thread A only').toString('base64') }],
      }),
    });
    const staged = path.join(DATA_DIR, 'v2-sessions', ee.id, 'sess-a', 'inbox', 'mail-a-1', 'contract-a.pdf');
    expect(fs.readFileSync(staged, 'utf8')).toBe('thread A only');

    // Nothing B mounts reaches it, and the folder every session shares holds no copy of it.
    for (const mount of b) expect(under(staged, mount.hostPath), mount.containerPath).toBe(false);
    const shared = b.find((mount) => mount.containerPath === '/workspace/agent');
    expect(shared?.hostPath).toBe(a.find((mount) => mount.containerPath === '/workspace/agent')?.hostPath);
    const copies = filesUnder(shared?.hostPath ?? '').filter((file) =>
      fs.readFileSync(file, 'utf8').includes('thread A only'),
    );
    expect(copies).toEqual([]);
  });
});

describe("external-email's mounts", () => {
  it("reach nothing in main's folder, where main keeps a file on each person", async () => {
    const ee = await externalEmail();
    const main: AgentGroup = {
      id: 'ag-main',
      name: 'main',
      folder: 'main',
      agent_provider: null,
      created_at: new Date().toISOString(),
    };
    await createAgentGroup(main);
    await initGroupFilesystem(main, { provider: 'claude' });
    const mainFolder = path.join(GROUPS_DIR, main.folder);
    const person = path.join(mainFolder, 'memory', 'people', 'remy-vance.md');
    fs.mkdirSync(path.dirname(person), { recursive: true });
    fs.writeFileSync(person, '---\ntype: person\n---\nRemy Vance prefers mornings.\n');

    const mounts = await mountsFor(ee, 'sess-a');
    expect(mounts.find((mount) => mount.containerPath === '/workspace/agent')?.hostPath).toBe(
      path.join(GROUPS_DIR, ee.folder),
    );
    for (const mount of mounts) {
      expect(under(person, mount.hostPath), mount.containerPath).toBe(false);
      expect(under(mount.hostPath, mainFolder), mount.containerPath).toBe(false);
    }
  });
});
