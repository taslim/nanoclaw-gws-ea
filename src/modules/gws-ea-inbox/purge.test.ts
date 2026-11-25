/**
 * Forgetting a person purges their external-email sessions. Any running
 * container for a purged session must be stopped and exited before its mailbox
 * and session directory are removed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  root: '',
  running: new Set<string>(),
  exitCallbacks: new Map<string, Array<() => void>>(),
}));

const containerMocks = vi.hoisted(() => ({
  isContainerRunning: vi.fn((sessionId: string) => fixture.running.has(sessionId)),
  killContainer: vi.fn((sessionId: string, _reason: string, onExit?: () => void) => {
    if (!fixture.running.has(sessionId)) return;
    if (onExit) {
      const list = fixture.exitCallbacks.get(sessionId) ?? [];
      list.push(onExit);
      fixture.exitCallbacks.set(sessionId, list);
    }
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return fixture.root;
    },
    get GROUPS_DIR() {
      return path.join(fixture.root, 'groups');
    },
  };
});

vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: containerMocks.isContainerRunning,
  killContainer: containerMocks.killContainer,
  registerSessionAdmissionPolicy: vi.fn(),
  setAutoGroupImageRefresh: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../gws-ea-external-email/index.js', () => ({
  getExternalEmailAgentGroupId: vi.fn(async () => 'ag-external'),
}));

import '../../mailbox/compose.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { resolveSession, sessionDir } from '../../session-manager.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { addPerson, forgetPerson } from '../gws-ea-people/db.js';
import '../gws-ea-people/index.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { createThread, recordAuthenticatedThreadSender } from './thread-map.js';

const NOW = '2026-10-15T12:00:00.000Z';

function finishContainer(sessionId: string): void {
  fixture.running.delete(sessionId);
  const callbacks = fixture.exitCallbacks.get(sessionId) ?? [];
  fixture.exitCallbacks.delete(sessionId);
  for (const cb of callbacks) cb();
}

describe('gws-ea-inbox person-forget purge', () => {
  beforeEach(async () => {
    fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-inbox-purge-'));
    const secretsDir = path.join(fixture.root, 'secrets');
    fs.mkdirSync(secretsDir, { mode: 0o700 });
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(secretsDir, 'google-grant.json'));
    fixture.running.clear();
    fixture.exitCallbacks.clear();
    containerMocks.isContainerRunning.mockClear();
    containerMocks.killContainer.mockClear();
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: 'ag-external',
      name: 'External Email',
      folder: 'external-email',
      agent_provider: null,
      created_at: NOW,
    });
    await createMessagingGroup({
      id: 'mg-inbox',
      channel_type: 'email',
      platform_id: 'email:inbox',
      name: 'Inbox',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: NOW,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  it('closes the session and waits for a running container to exit before removing its mailbox and folder', async () => {
    const thread = await createThread('gmail-t1', NOW, 'mail-purge-running');
    await recordAuthenticatedThreadSender(thread.threadKey, 'pat@example.test', NOW);
    const { session } = await resolveSession('ag-external', 'mg-inbox', thread.threadKey, 'per-thread');
    const dir = sessionDir('ag-external', session.id);
    expect(fs.existsSync(dir)).toBe(true);

    const { id: personId } = await addPerson({
      name: 'Pat Example',
      level: 'active',
      source: 'principal',
      basis: 'test fixture',
      identity: 'email:pat@example.test',
    });

    fixture.running.add(session.id);
    let settled = false;
    const purging = forgetPerson({ id: personId }).then(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(containerMocks.killContainer).toHaveBeenCalledWith(
        session.id,
        'person-forget-purge',
        expect.any(Function),
      );
    });

    // While the container is still shutting down, the session is already closed
    // (blocking new wakes) and its session directory stays intact.
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(settled).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);

    finishContainer(session.id);
    await purging;

    expect(settled).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(await getSession(session.id)).toBeUndefined();
  });

  it('purges immediately without killing when the session container is not running', async () => {
    const thread = await createThread('gmail-t2', NOW, 'mail-purge-stopped');
    await recordAuthenticatedThreadSender(thread.threadKey, 'sam@example.test', NOW);
    const { session } = await resolveSession('ag-external', 'mg-inbox', thread.threadKey, 'per-thread');
    const dir = sessionDir('ag-external', session.id);

    const { id: personId } = await addPerson({
      name: 'Sam Example',
      level: 'active',
      source: 'principal',
      basis: 'test fixture',
      identity: 'email:sam@example.test',
    });

    await forgetPerson({ id: personId });

    expect(containerMocks.killContainer).not.toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(false);
    expect(await getSession(session.id)).toBeUndefined();
  });

  it('resolves cleanly if the container exits between the running check and killContainer', async () => {
    const thread = await createThread('gmail-t3', NOW, 'mail-purge-race');
    await recordAuthenticatedThreadSender(thread.threadKey, 'lee@example.test', NOW);
    const { session } = await resolveSession('ag-external', 'mg-inbox', thread.threadKey, 'per-thread');
    const dir = sessionDir('ag-external', session.id);

    const { id: personId } = await addPerson({
      name: 'Lee Example',
      level: 'active',
      source: 'principal',
      basis: 'test fixture',
      identity: 'email:lee@example.test',
    });

    fixture.running.add(session.id);
    containerMocks.killContainer.mockImplementationOnce((sessionId: string) => {
      // Simulate the container having just exited before killContainer registered onExit.
      fixture.running.delete(sessionId);
    });

    await forgetPerson({ id: personId });

    expect(fs.existsSync(dir)).toBe(false);
    expect(await getSession(session.id)).toBeUndefined();
  });
});
