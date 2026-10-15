/**
 * The matters store (KTD3): the matters, with the host's mark for a failed
 * look (KTD7 step 3), and their links. An assistant from before this release
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
  it('create matters and extend their native links with browser jobs', () => {
    expect(mattersMigrations().map((migration) => migration.name)).toEqual([
      CREATE_MATTERS,
      'module:gws-ea-matters:browser-jobs',
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
});
