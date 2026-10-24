/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live beside the SQLite task implementation.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  countDueMessages,
  countUnreadContext,
  ensureSchema,
  getInboundSourceSessionId,
  insertMessage,
  migrateMessagesInTable,
  releaseHeldMessages,
  settleHeldMessages,
  syncProcessingAcks,
} from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });
});

describe('syncProcessingAcks — script-skip counter', () => {
  function freshPair() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(DB_PATH, 'inbound');
    const outPath = path.join(TEST_DIR, 'outbound.db');
    ensureSchema(outPath, 'outbound');
    return { inDb: new Database(DB_PATH), outDb: new Database(outPath) };
  }

  function seedTask(inDb: InstanceType<typeof Database>, id: string, content: Record<string, unknown>) {
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, content, series_id)
         VALUES (?, 2, datetime('now'), 'processing', 0, 'task', ?, ?)`,
      )
      .run(id, JSON.stringify(content), id);
  }

  function ack(outDb: InstanceType<typeof Database>, id: string, status: string) {
    outDb
      .prepare(
        "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, datetime('now'))",
      )
      .run(id, status);
  }

  const status = (inDb: InstanceType<typeof Database>, id: string) =>
    (inDb.prepare('SELECT status FROM messages_in WHERE id = ?').get(id) as { status: string }).status;

  it('script-skip:error ack lands the row as a FAILED run (streak-derivable history)', () => {
    const { inDb, outDb } = freshPair();
    seedTask(inDb, 't1', { prompt: 'p', script: 'x' });
    ack(outDb, 't1', 'script-skip:error');

    syncProcessingAcks(inDb, outDb);

    expect(status(inDb, 't1')).toBe('failed');
  });

  it('a settled row is terminal — a lingering ack cannot flip failed back to completed', () => {
    const { inDb, outDb } = freshPair();
    seedTask(inDb, 't1', { prompt: 'p', script: 'x' });
    ack(outDb, 't1', 'script-skip:error');
    syncProcessingAcks(inDb, outDb);

    ack(outDb, 't1', 'completed');
    syncProcessingAcks(inDb, outDb);

    expect(status(inDb, 't1')).toBe('failed');
  });

  it('plain completed ack completes the row as before', () => {
    const { inDb, outDb } = freshPair();
    seedTask(inDb, 't1', { prompt: 'p', script: 'x' });
    ack(outDb, 't1', 'completed');

    syncProcessingAcks(inDb, outDb);

    expect(status(inDb, 't1')).toBe('completed');
  });
});

describe('held messages', () => {
  function freshInbound(): InstanceType<typeof Database> {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(DB_PATH, 'inbound');
    return new Database(DB_PATH);
  }

  function write(
    db: InstanceType<typeof Database>,
    id: string,
    options: { status?: 'pending' | 'held'; trigger?: boolean } = {},
  ): void {
    insertMessage(db, {
      id,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'email:inbox',
      channelType: 'email',
      threadId: 'thread-noel-archer',
      content: JSON.stringify({ sender: 'Noel Archer', text: 'Following up on the proposal' }),
      processAfter: null,
      recurrence: null,
      trigger: options.trigger ?? true,
      ...(options.status ? { status: options.status } : {}),
    });
  }

  const row = (db: InstanceType<typeof Database>, id: string) =>
    db.prepare('SELECT status, trigger, process_after FROM messages_in WHERE id = ?').get(id) as {
      status: string;
      trigger: number;
      process_after: string | null;
    };

  it('stores a held message that is never due', () => {
    const db = freshInbound();
    write(db, 'held-1', { status: 'held' });

    expect(row(db, 'held-1')).toEqual({ status: 'held', trigger: 1, process_after: null });
    expect(countDueMessages(db)).toBe(0);
    db.close();
  });

  it('releases every held message as a trigger due at the time given, and says how many', () => {
    const db = freshInbound();
    write(db, 'held-1', { status: 'held' });
    write(db, 'held-2', { status: 'held', trigger: false });
    write(db, 'ambient', { trigger: false });
    const due = new Date(Date.now() - 1000).toISOString();

    expect(releaseHeldMessages(db, due)).toBe(2);

    expect(row(db, 'held-1')).toEqual({ status: 'pending', trigger: 1, process_after: due });
    expect(row(db, 'held-2')).toEqual({ status: 'pending', trigger: 1, process_after: due });
    expect(row(db, 'ambient')).toEqual({ status: 'pending', trigger: 0, process_after: null });
    expect(countDueMessages(db)).toBe(2);
    expect(releaseHeldMessages(db, null)).toBe(0);
    db.close();
  });

  it('refuses a release time that is not an ISO-8601 UTC timestamp, releasing nothing', () => {
    const db = freshInbound();
    write(db, 'held-1', { status: 'held' });

    expect(() => releaseHeldMessages(db, '2026-10-12 09:00:00')).toThrow('invalid ISO-8601 UTC timestamp');
    expect(row(db, 'held-1').status).toBe('held');
    db.close();
  });

  it('settles every held message unread, so no release brings it back, and says how many', () => {
    const db = freshInbound();
    write(db, 'held-1', { status: 'held' });
    write(db, 'held-2', { status: 'held', trigger: false });
    write(db, 'waiting');

    expect(settleHeldMessages(db)).toBe(2);

    expect(row(db, 'held-1')).toEqual({ status: 'completed', trigger: 1, process_after: null });
    expect(row(db, 'held-2')).toEqual({ status: 'completed', trigger: 0, process_after: null });
    expect(row(db, 'waiting')).toEqual({ status: 'pending', trigger: 1, process_after: null });
    expect(releaseHeldMessages(db, null)).toBe(0);
    expect(settleHeldMessages(db)).toBe(0);
    expect(countDueMessages(db)).toBe(1);
    db.close();
  });
});

describe('unread context', () => {
  it('counts readable due context, excluding tool replies, triggers, read or future rows, and the named channel', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    ensureSchema(DB_PATH, 'inbound');
    const db = new Database(DB_PATH);
    const write = (
      id: string,
      options: {
        trigger: boolean;
        kind?: 'chat' | 'system';
        channelType?: string;
        processAfter?: string;
        status?: 'held';
      },
    ): void =>
      insertMessage(db, {
        id,
        kind: options.kind ?? 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'chat:dm-morgan',
        channelType: options.channelType ?? 'chat',
        threadId: null,
        content: JSON.stringify({ sender: 'system', text: 'Calendar access to the work calendar dropped.' }),
        processAfter: options.processAfter ?? null,
        recurrence: null,
        trigger: options.trigger,
        ...(options.status ? { status: options.status } : {}),
      });

    write('note-due', { trigger: false });
    write('note-past', { trigger: false, processAfter: new Date(Date.now() - 60_000).toISOString() });
    write('note-ahead', { trigger: false, processAfter: new Date(Date.now() + 3_600_000).toISOString() });
    write('note-read', { trigger: false });
    write('echo', { trigger: false, channelType: 'session-echo' });
    write('message', { trigger: true });
    write('held', { trigger: false, status: 'held' });
    write('tool-reply', { trigger: false, kind: 'system' });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'note-read'").run();

    expect(countUnreadContext(db, 'session-echo')).toBe(2);
    expect(db.prepare('SELECT kind, status, trigger FROM messages_in WHERE id = ?').get('tool-reply')).toEqual({
      kind: 'system',
      status: 'pending',
      trigger: 0,
    });
    db.close();
  });
});
