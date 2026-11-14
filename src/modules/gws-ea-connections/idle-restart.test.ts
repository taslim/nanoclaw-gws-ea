import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/connections-idle-restart-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
  GROUPS_DIR: `${ROOT}/groups`,
}));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

/**
 * Each running container's config read time (undefined for one this host adopted), and each container still
 * starting with the time it read its configuration, not yet registered as running.
 */
const runtime = vi.hoisted(() => ({
  running: new Map<string, number | undefined>(),
  spawning: new Map<string, number>(),
  exits: new Map<string, Array<() => void>>(),
  kill: vi.fn((sessionId: string, _reason: string, onExit?: () => void) => {
    const callbacks = runtime.exits.get(sessionId) ?? [];
    if (onExit) callbacks.push(onExit);
    runtime.exits.set(sessionId, callbacks);
  }),
}));
vi.mock('../../container-runner.js', async (original) => ({
  ...(await original<typeof import('../../container-runner.js')>()),
  isContainerRunning: (sessionId: string) => runtime.running.has(sessionId),
  getContainerConfigReadAtMs: (sessionId: string) => runtime.running.get(sessionId),
  getSpawningConfigReadAtMs: (sessionId: string) => runtime.spawning.get(sessionId),
  killContainer: runtime.kill,
}));

import '../../mailbox/compose.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import * as idle from './idle-restart.js';
import type { ConnectionsStore } from './store.js';
import { testConnectionsStore } from './testing/store.js';

const MAIN = 'ag-main';
const OTHER = 'ag-other';
let store: ConnectionsStore;
let dm: Session;
let close: Session;
let other: Session;

async function session(id: string, agentGroupId: string, threadId: string | null): Promise<Session> {
  const created: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: '2026-11-14T08:00:00.000Z',
  };
  await createSession(created);
  initSessionFolder(agentGroupId, id);
  return created;
}

/** A turn in progress is the container's own processing claim in its outbound DB. */
function claim(target: Session, messageId: string, status: 'processing' | 'completed'): void {
  const out = new Database(outboundDbPath(target.agent_group_id, target.id));
  try {
    out
      .prepare(
        `INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET status = excluded.status`,
      )
      .run(messageId, status, new Date().toISOString());
  } finally {
    out.close();
  }
}

/** A container stopped by the check finishes exiting. */
function exit(target: Session): void {
  runtime.running.delete(target.id);
  const callbacks = runtime.exits.get(target.id) ?? [];
  runtime.exits.delete(target.id);
  for (const callback of callbacks) callback();
}

function killed(): string[] {
  return runtime.kill.mock.calls.map(([sessionId]) => sessionId);
}

async function requestAt(offsetMs: number): Promise<string> {
  const appliedAt = new Date(Date.now() + offsetMs).toISOString();
  await store.requestRestart(appliedAt);
  return appliedAt;
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  ({ store } = testConnectionsStore(path.join(ROOT, 'connections')));
  runtime.running.clear();
  runtime.spawning.clear();
  runtime.exits.clear();
  runtime.kill.mockClear();
  vi.mocked(requestWake).mockClear();
  await runMigrations(await initTestDb());
  for (const id of [MAIN, OTHER])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: '2026-11-14T00:00:00.000Z' });
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name = 'Juno', principal_first_name = 'Morgan', main_agent_group_id = ? WHERE singleton = 1",
    MAIN,
  );
  dm = await session('sess-dm', MAIN, null);
  close = await session('sess-close', MAIN, 'system:evening-close');
  other = await session('sess-other', OTHER, null);
  // Every container read its configuration a minute before the change.
  for (const target of [dm, close, other]) runtime.running.set(target.id, Date.now() - 60_000);
});
afterEach(async () => {
  await idle.stopRestartChecks();
  vi.useRealTimers();
  // Containers stopped and never exited would stay stopping into the next test.
  for (const sessionId of [...runtime.exits.keys()]) {
    const callbacks = runtime.exits.get(sessionId) ?? [];
    runtime.exits.delete(sessionId);
    for (const callback of callbacks) callback();
  }
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('servePendingRestart', () => {
  it('leaves a session mid-turn running and restarts it on the first check after the turn ends', async () => {
    claim(dm, 'turn-1', 'processing');
    claim(close, 'close-1', 'processing');
    await requestAt(0);

    expect(await idle.servePendingRestart(store)).toBe(true);
    expect(killed()).toEqual([]);

    claim(dm, 'turn-1', 'completed');
    expect(await idle.servePendingRestart(store)).toBe(true);
    expect(killed()).toEqual([dm.id]);
    expect(requestWake).not.toHaveBeenCalled();
  });

  it('restarts the idle conversation while the busy evening close keeps its container, then the close in turn', async () => {
    claim(close, 'close-1', 'processing');
    await requestAt(0);

    await idle.servePendingRestart(store);
    expect(killed()).toEqual([dm.id]);

    claim(close, 'close-1', 'completed');
    await idle.servePendingRestart(store);
    expect(killed()).toEqual([dm.id, close.id]);
    expect(killed()).not.toContain(other.id);
  });

  it('restarts a session with a due message and brings the new container straight back for it', async () => {
    claim(close, 'close-1', 'processing');
    await writeSessionMessage(MAIN, dm.id, {
      id: 'follow-up-1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ sender: 'Morgan', text: 'One more thing.' }),
    });
    await requestAt(0);

    await idle.servePendingRestart(store);
    expect(killed()).toEqual([dm.id]);
    expect(requestWake).not.toHaveBeenCalled();

    exit(dm);
    await vi.waitFor(() =>
      expect(requestWake).toHaveBeenCalledWith(expect.objectContaining({ id: dm.id }), 'container-restart'),
    );
  });

  it('restarts each container once for several changes and clears the request when every one reads the latest', async () => {
    claim(dm, 'turn-1', 'processing');
    claim(close, 'close-1', 'processing');
    await requestAt(-2);
    await requestAt(-1);
    const latest = await requestAt(0);
    expect(await idle.servePendingRestart(store)).toBe(true);

    claim(dm, 'turn-1', 'completed');
    claim(close, 'close-1', 'completed');
    await idle.servePendingRestart(store);
    // Still exiting: a second check does not stop them again.
    await idle.servePendingRestart(store);
    expect(killed().sort()).toEqual([close.id, dm.id].sort());
    expect(await store.pendingRestart()).toBe(latest);

    exit(dm);
    exit(close);
    // The conversation came back on the new configuration; the close stays down until its next turn.
    runtime.running.set(dm.id, Date.now() + 1);
    expect(await idle.servePendingRestart(store)).toBe(false);
    expect(await store.pendingRestart()).toBeUndefined();
    expect(runtime.kill).toHaveBeenCalledTimes(2);
  });

  it('keeps a request recorded during the check that served the previous one', async () => {
    const first = await requestAt(0);
    runtime.running.clear();
    const later = new Date(Date.parse(first) + 1).toISOString();
    const clear = store.clearRestart.bind(store);
    // An apply lands after the check read the request and before it clears it.
    vi.spyOn(store, 'clearRestart').mockImplementationOnce(async (appliedAt) => {
      await store.requestRestart(later);
      return clear(appliedAt);
    });

    expect(await idle.servePendingRestart(store)).toBe(true);
    expect(await store.pendingRestart()).toBe(later);

    expect(await idle.servePendingRestart(store)).toBe(false);
    expect(await store.pendingRestart()).toBeUndefined();
  });
});

describe('a main session still starting', () => {
  it('keeps the request while it starts on the configuration it read before the change, then restarts it', async () => {
    runtime.running.clear();
    const readAt = Date.now() - 1_000;
    runtime.spawning.set(dm.id, readAt);
    await requestAt(0);

    expect(await idle.servePendingRestart(store)).toBe(true);
    expect(await store.pendingRestart()).toBeDefined();
    expect(killed()).toEqual([]);

    // Registered with the configuration it read before the change, and idle.
    runtime.spawning.delete(dm.id);
    runtime.running.set(dm.id, readAt);
    expect(await idle.servePendingRestart(store)).toBe(true);
    expect(killed()).toEqual([dm.id]);

    exit(dm);
    expect(await idle.servePendingRestart(store)).toBe(false);
    expect(await store.pendingRestart()).toBeUndefined();
  });

  it("does not hold the request when it read after the change, failed to start, or is not main's", async () => {
    runtime.running.clear();
    await requestAt(0);
    runtime.spawning.set(dm.id, Date.now() + 1_000);
    runtime.spawning.set(other.id, Date.now() - 1_000);

    expect(await idle.servePendingRestart(store)).toBe(false);
    expect(await store.pendingRestart()).toBeUndefined();

    await requestAt(2_000);
    runtime.spawning.delete(dm.id);
    expect(await idle.servePendingRestart(store)).toBe(false);
    expect(killed()).toEqual([]);
  });
});

describe('a request left by a previous host', () => {
  it('restarts the adopted containers, spares the ones this host spawned since, and then clears', async () => {
    await requestAt(-60_000);
    // A new host: whatever it adopted carries no config read time, though it may have started after the change.
    runtime.running.set(dm.id, undefined);
    runtime.running.set(close.id, Date.now());

    expect(await idle.servePendingRestart(store)).toBe(true);
    expect(killed()).toEqual([dm.id]);

    exit(dm);
    expect(await idle.servePendingRestart(store)).toBe(false);
    expect(await store.pendingRestart()).toBeUndefined();
  });
});

describe('restart checks', () => {
  it('check every five seconds while a request is pending and stop when the host does', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    claim(dm, 'turn-1', 'processing');
    claim(close, 'close-1', 'processing');
    await requestAt(0);
    const host = new AbortController();
    idle.startRestartChecks(store, host.signal);
    await vi.waitFor(async () => expect(await store.pendingRestart()).toBeDefined());
    expect(killed()).toEqual([]);

    claim(dm, 'turn-1', 'completed');
    await vi.advanceTimersByTimeAsync(idle.RESTART_CHECK_INTERVAL_MS);
    await vi.waitFor(() => expect(killed()).toEqual([dm.id]));

    host.abort();
    claim(close, 'close-1', 'completed');
    await vi.advanceTimersByTimeAsync(idle.RESTART_CHECK_INTERVAL_MS * 3);
    expect(killed()).toEqual([dm.id]);
  });

  it('do nothing once the host has stopped, whatever asks for a check', async () => {
    const reads = vi.spyOn(store, 'pendingRestart');
    const host = new AbortController();
    idle.startRestartChecks(store, host.signal);
    // The first check finds nothing pending and settles.
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    await reads.mock.results[0]?.value;
    await new Promise((resolve) => setImmediate(resolve));

    host.abort();
    await requestAt(0);
    idle.checkRestartSoon();
    // Waits for any check that began, so a stop it made would show.
    await idle.stopRestartChecks();

    expect(killed()).toEqual([]);
    expect(await store.pendingRestart()).toBeDefined();
  });
});
