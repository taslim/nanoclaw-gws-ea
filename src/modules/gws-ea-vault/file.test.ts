import { chmod, link, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openPrivateDatabase, withPrivateDatabase } from './file.js';

const SCHEMA = 'CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY) STRICT;';
let directory: string;
let storeRoot: string;
let file: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vault-file-')));
  storeRoot = path.join(directory, 'connections');
  file = path.join(storeRoot, 'apps.db');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('creates an owner-only directory and file with durable, secure-delete pragmas and the schema', async () => {
  const db = await openPrivateDatabase(file, SCHEMA);
  try {
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
    expect(db.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all()).toEqual(['entries']);
  } finally {
    db.close();
  }
  expect((await stat(storeRoot)).mode & 0o777).toBe(0o700);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('refuses a symlinked file, a hard-linked file and a symlinked directory', async () => {
  const target = path.join(directory, 'target.db');
  await writeFile(target, '');
  await mkdir(storeRoot);
  await symlink(target, file);
  await expect(openPrivateDatabase(file, SCHEMA)).rejects.toThrow();
  await rm(file);
  await link(target, file);
  await expect(openPrivateDatabase(file, SCHEMA)).rejects.toThrow('Private store file is not owner-only');
  await rm(storeRoot, { recursive: true });
  const elsewhere = path.join(directory, 'elsewhere');
  await mkdir(elsewhere);
  await symlink(elsewhere, storeRoot);
  await expect(openPrivateDatabase(file, SCHEMA)).rejects.toThrow('Private store directory is not owner-only');
});

it('never leaves a group- or world-readable store readable', async () => {
  await mkdir(storeRoot, { mode: 0o755 });
  await writeFile(file, '');
  await chmod(storeRoot, 0o755);
  await chmod(file, 0o644);
  (await openPrivateDatabase(file, SCHEMA)).close();
  expect((await stat(storeRoot)).mode & 0o777).toBe(0o700);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it('refuses a path that is not normalized and absolute', async () => {
  await expect(openPrivateDatabase('connections/apps.db', SCHEMA)).rejects.toThrow();
  await expect(openPrivateDatabase(`${storeRoot}/../connections/apps.db`, SCHEMA)).rejects.toThrow();
});

it('runs operations on one file one at a time, in order, each on a connection closed afterwards', async () => {
  const order: string[] = [];
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first: Database.Database | undefined;
  const slow = withPrivateDatabase(file, SCHEMA, async (db) => {
    first = db;
    order.push('first started');
    await held;
    db.prepare('INSERT INTO entries (id) VALUES (?)').run('first');
    order.push('first finished');
  });
  const failing = withPrivateDatabase(file, SCHEMA, () => {
    order.push('second started');
    throw new Error('second failed');
  });
  const reading = withPrivateDatabase(file, SCHEMA, (db) => {
    order.push('third started');
    return db.prepare('SELECT id FROM entries').pluck().all();
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(order).toEqual(['first started']);
  release();

  await slow;
  await expect(failing).rejects.toThrow('second failed');
  expect(await reading).toEqual(['first']);
  expect(order).toEqual(['first started', 'first finished', 'second started', 'third started']);
  expect(first?.open).toBe(false);
});
