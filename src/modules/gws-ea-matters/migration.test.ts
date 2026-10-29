/**
 * The matters store: the matters, with the host's mark for a failed look,
 * and their links. An assistant from before this release
 * gains them on its next start, exactly as a fresh install builds them.
 */
import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { DbDriver } from '../../db/driver.js';
import { sqliteRaw } from '../../db/drivers/sqlite.js';
import { closeDb, initSqliteTestDb } from '../../db/index.js';
import { getRegisteredMigrations, runMigrations, type Migration } from '../../db/migrations/index.js';
import '../index.js';

const CREATE_MATTERS = 'module:gws-ea-matters:create-matters';

/** The banned constructs of `src/db/migrations/portability.test.ts`, which covers built-in migrations only. */
const BANNED_PORTABLE_SQL = [
  /\bPRAGMA\b/i,
  /\bsqlite_master\b/i,
  /\bINSERT\s+OR\b/i,
  /\browid\b/i,
  /\bdatetime\s*\(/i,
  /\bstrftime\s*\(/i,
  /\bIS\s+\?/i,
];

afterEach(async () => {
  await closeDb();
});

function mattersMigrations(): Migration[] {
  return getRegisteredMigrations().filter((migration) => migration.name.startsWith('module:gws-ea-matters:'));
}

async function freshInstall(): Promise<DbDriver> {
  const db = await initSqliteTestDb();
  await runMigrations(db);
  return db;
}

/** An install from the release before: every other migration applied, then this release's. */
async function updatedInstall(): Promise<DbDriver> {
  const db = await initSqliteTestDb();
  await runMigrations(
    db,
    getRegisteredMigrations().filter((migration) => !migration.name.startsWith('module:gws-ea-matters:')),
  );
  await runMigrations(db);
  return db;
}

interface SchemaEntry {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

function schemaOf(db: DbDriver): SchemaEntry[] {
  return sqliteRaw(db)
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
    .all() as SchemaEntry[];
}

describe('the matters migrations', () => {
  it('create matters and extend links and planning facts', () => {
    expect(mattersMigrations().map((migration) => migration.name)).toEqual([
      CREATE_MATTERS,
      'module:gws-ea-matters:browser-jobs',
      'module:gws-ea-matters:chat-links',
      'module:gws-ea-matters:planning-facts',
    ]);
  });

  it('are portable: async, and free of every banned construct', () => {
    for (const migration of mattersMigrations()) {
      expect(migration.sqliteOnly, migration.name).not.toBe(true);
      expect(migration.up.constructor.name, migration.name).toBe('AsyncFunction');
    }
    const source = fs.readFileSync(new URL('./migration.ts', import.meta.url), 'utf8');
    for (const banned of BANNED_PORTABLE_SQL) expect(source, String(banned)).not.toMatch(banned);
  });

  it('leave the two tables and the indexes that keep them, and nothing else', async () => {
    const declared = schemaOf(await freshInstall()).filter(
      (entry) => entry.tbl_name.startsWith('gws_ea_matter') && entry.sql !== null,
    );
    expect(declared.map((entry) => `${entry.type} ${entry.name}`)).toEqual([
      'index idx_gws_ea_matter_links_one_open_matter',
      'index idx_gws_ea_matter_links_reference',
      'index idx_gws_ea_matters_parent',
      'table gws_ea_matter_links',
      'table gws_ea_matters',
    ]);
  });

  it('give an install from the release before the schema of a fresh install', async () => {
    const fresh = schemaOf(await freshInstall());
    expect(schemaOf(await updatedInstall())).toEqual(fresh);
  });

  it('preserves every existing link and the unique piece index when chat links are added', async () => {
    const db = await initSqliteTestDb();
    const old = getRegisteredMigrations().filter((migration) => migration.name !== 'module:gws-ea-matters:chat-links');
    await runMigrations(db, old);
    const at = '2026-10-18T12:00:00.000Z';
    for (const id of ['m-first', 'm-second']) {
      await db.run(
        "INSERT INTO gws_ea_matters (id, title, open_loop, created_at, updated_at) VALUES (?, 'Title', 'Loop', ?, ?)",
        id,
        at,
        at,
      );
    }
    for (const kind of ['thread', 'event', 'file', 'person', 'memory', 'job']) {
      await db.run(
        'INSERT INTO gws_ea_matter_links (matter_id, kind, reference, handler, matter_open, linked_at) VALUES (?, ?, ?, ?, 1, ?)',
        'm-first',
        kind,
        `${kind}-reference`,
        'existing-handler',
        at,
      );
    }
    const before = await db.all('SELECT * FROM gws_ea_matter_links ORDER BY kind');
    await runMigrations(db);
    expect(
      await db.all(
        'SELECT matter_id, kind, reference, handler, matter_open, linked_at FROM gws_ea_matter_links ORDER BY kind',
      ),
    ).toEqual(before);
    expect(await db.all('SELECT account, account_at FROM gws_ea_matter_links')).toEqual(
      Array.from({ length: 6 }, () => ({ account: null, account_at: null })),
    );
    await expect(
      db.run(
        "INSERT INTO gws_ea_matter_links (matter_id, kind, reference, matter_open, linked_at) VALUES ('m-second', 'job', 'job-reference', 1, ?)",
        at,
      ),
    ).rejects.toThrow(/UNIQUE/);
    for (const id of ['m-first', 'm-second']) {
      await db.run(
        "INSERT INTO gws_ea_matter_links (matter_id, kind, reference, matter_open, linked_at) VALUES (?, 'chat', 'mg-trip', 1, ?)",
        id,
        at,
      );
    }
    expect(await db.all("SELECT matter_id FROM gws_ea_matter_links WHERE kind = 'chat' ORDER BY matter_id")).toEqual([
      { matter_id: 'm-first' },
      { matter_id: 'm-second' },
    ]);
  });
});
