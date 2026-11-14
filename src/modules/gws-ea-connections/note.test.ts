import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/connections-note-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
  GROUPS_DIR: `${ROOT}/groups`,
}));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

/** Each running container's config read time; undefined for one this host adopted. */
const runtime = vi.hoisted(() => ({ running: new Map<string, number | undefined>() }));
vi.mock('../../container-runner.js', async (original) => ({
  ...(await original<typeof import('../../container-runner.js')>()),
  isContainerRunning: (sessionId: string) => runtime.running.has(sessionId),
  getContainerConfigReadAtMs: (sessionId: string) => runtime.running.get(sessionId),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { Session } from '../../types.js';
import { MAIN, mainSession, seedMain } from '../gws-ea-matters/testing/main-conversation.js';
import '../gws-ea-profile/index.js';
import { createReconnectNotes, type ReconnectNotes } from './note.js';
import type { RefusedApp } from './refresher.js';
import type { ConnectionApp, ConnectionsStore } from './store.js';
import { testConnectionsStore } from './testing/store.js';

const SENTINEL_TOKEN = 'sentinel-dead-grant-token-Q8x4';

let store: ConnectionsStore;
let session: Session;
let notes: ReconnectNotes;
let clock: number;

interface NoteRow {
  readonly id: string;
  readonly trigger: number;
  readonly content: string;
}

function written(): NoteRow[] {
  const db = new Database(inboundDbPath(MAIN, session.id));
  try {
    return db
      .prepare("SELECT id, trigger, content FROM messages_in WHERE id LIKE 'connection-reconnect:%' ORDER BY seq")
      .all() as NoteRow[];
  } finally {
    db.close();
  }
}

async function setMainServers(servers: Record<string, unknown>): Promise<void> {
  await updateContainerConfigJson(MAIN, 'mcp_servers', servers);
}

/** A token app whose grant the server refused, taken out of main's servers as the refresher's apply leaves it. */
async function refusedApp(name: string, url: string): Promise<{ app: ConnectionApp; refused: RefusedApp }> {
  const created = await store.create({ name, url, auth: 'token' });
  const { app, generation } = await store.connect(created.id, created.version, {
    kind: 'token',
    token: SENTINEL_TOKEN,
  });
  expect(await store.markRefused(app.id, generation)).toBe(true);
  return { app: await store.get(app.id), refused: { appId: app.id, generation } };
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  ({ store } = testConnectionsStore(path.join(ROOT, 'connections')));
  await runMigrations(await initTestDb());
  await seedMain('UTC');
  session = await mainSession();
  runtime.running.clear();
  clock = Date.parse('2026-11-14T12:00:00.000Z');
  notes = createReconnectNotes(store, { now: () => clock });
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('the reconnect note', () => {
  it('is written at once, without waking main, when none of its containers runs', async () => {
    const { refused } = await refusedApp('Notes', 'https://notes.example.test/mcp');

    notes.owe(refused);

    expect(await notes.deliver()).toBe(false);
    const [note, ...rest] = written();
    expect(rest).toEqual([]);
    expect(note).toMatchObject({ id: `connection-reconnect:${refused.appId}:${refused.generation}`, trigger: 0 });
    const { text } = JSON.parse(note.content) as { text: string };
    expect(text).toContain('"Notes" at notes.example.test needs reconnecting');
    expect(note.content).not.toContain(SENTINEL_TOKEN);
  });

  it('is one note for repeated refusals of one grant, and a new one once a reconnected grant breaks', async () => {
    const { app, refused } = await refusedApp('Notes', 'https://notes.example.test/mcp');

    notes.owe(refused);
    await notes.deliver();
    notes.owe(refused);
    await notes.deliver();
    expect(written()).toHaveLength(1);

    const again = await store.connect(app.id, app.version, { kind: 'token', token: SENTINEL_TOKEN });
    await store.markRefused(app.id, again.generation);
    notes.owe({ appId: app.id, generation: again.generation });
    await notes.deliver();

    expect(written().map(({ id }) => id)).toEqual([
      `connection-reconnect:${app.id}:${refused.generation}`,
      `connection-reconnect:${app.id}:${again.generation}`,
    ]);
    expect(written().every(({ trigger, content }) => trigger === 0 && !content.includes(SENTINEL_TOKEN))).toBe(true);
  });

  it('waits until every main container that could hold the app has restarted', async () => {
    const { refused } = await refusedApp('Notes', 'https://notes.example.test/mcp');
    runtime.running.set(session.id, clock - 60_000);
    runtime.running.set('adopted-session', undefined);
    await setMainServers({});
    await createSession({ ...session, id: 'adopted-session', thread_id: 'close' });

    notes.owe(refused);
    expect(await notes.deliver()).toBe(true);
    expect(written()).toEqual([]);

    // The conversation's container came back on the new configuration; the adopted one still runs.
    clock += 5_000;
    runtime.running.set(session.id, clock);
    expect(await notes.deliver()).toBe(true);
    expect(written()).toEqual([]);

    runtime.running.delete('adopted-session');
    expect(await notes.deliver()).toBe(false);
    expect(written()).toHaveLength(1);
  });

  it("waits while main's servers still list the app, counting containers from when it left them", async () => {
    const { app, refused } = await refusedApp('Notes', 'https://notes.example.test/mcp');
    await setMainServers({ [app.serverKey]: { type: 'http', url: app.url } });

    notes.owe(refused);
    expect(await notes.deliver()).toBe(true);

    // A container started while the entry was still there holds the app.
    clock += 1_000;
    runtime.running.set(session.id, clock);
    clock += 1_000;
    await setMainServers({});
    expect(await notes.deliver()).toBe(true);
    expect(written()).toEqual([]);

    clock += 1_000;
    runtime.running.set(session.id, clock);
    expect(await notes.deliver()).toBe(false);
    expect(written()).toHaveLength(1);
    expect((await getContainerConfig(MAIN))?.mcp_servers).toBe('{}');
  });

  it('is dropped once the app is reconnected or deleted before it could be written', async () => {
    const { app, refused } = await refusedApp('Notes', 'https://notes.example.test/mcp');
    const deleted = await refusedApp('Recipes', 'https://recipes.example.test/mcp');
    runtime.running.set(session.id, clock - 1);

    notes.owe(refused);
    notes.owe(deleted.refused);
    expect(await notes.deliver()).toBe(true);
    await store.connect(app.id, app.version, { kind: 'token', token: SENTINEL_TOKEN });
    await store.remove(deleted.app.id, deleted.app.version);
    runtime.running.clear();

    expect(await notes.deliver()).toBe(false);
    expect(written()).toEqual([]);
  });
});
