/**
 * The home folder's store (KTD3): one row for the folder, and the host's
 * record of each principal address's grant on it. An assistant from before
 * this release gains both tables on its next start, exactly as a fresh
 * install builds them.
 */
import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { DbDriver } from '../../db/driver.js';
import { sqliteRaw } from '../../db/drivers/sqlite.js';
import { closeDb, initSqliteTestDb } from '../../db/index.js';
import { getRegisteredMigrations, runMigrations, type Migration } from '../../db/migrations/index.js';
import '../index.js';

const HOME_FOLDER = 'module:gws-ea-workspace:home-folder';
const AT = '2026-10-09T09:00:00.000Z';

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

function workspaceMigrations(): Migration[] {
  return getRegisteredMigrations().filter((migration) => migration.name.startsWith('module:gws-ea-workspace:'));
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
    getRegisteredMigrations().filter((migration) => !migration.name.startsWith('module:gws-ea-workspace:')),
  );
  await runMigrations(db);
  return db;
}

interface SchemaEntry {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

function schemaOf(db: DbDriver): SchemaEntry[] {
  return sqliteRaw(db).prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all() as SchemaEntry[];
}

describe('the workspace migrations', () => {
  it("are one, for the home folder, after the modules it loads behind and before the inbox's", () => {
    expect(workspaceMigrations().map((migration) => migration.name)).toEqual([HOME_FOLDER]);
    const names = getRegisteredMigrations().map((migration) => migration.name);
    const earlier = names.filter((name) => /^module:gws-ea-(profile|privacy|people|notices):/u.test(name));
    for (const name of earlier) expect(names.indexOf(name)).toBeLessThan(names.indexOf(HOME_FOLDER));
    expect(names.indexOf(HOME_FOLDER)).toBeLessThan(names.indexOf('module:gws-ea-inbox:create-inbox'));
  });

  it('are portable: async, and free of every banned construct', () => {
    for (const migration of workspaceMigrations()) {
      expect(migration.sqliteOnly, migration.name).not.toBe(true);
      expect(migration.up.constructor.name, migration.name).toBe('AsyncFunction');
    }
    const source = fs.readFileSync(new URL('./migration.ts', import.meta.url), 'utf8');
    for (const banned of BANNED_PORTABLE_SQL) expect(source, String(banned)).not.toMatch(banned);
  });

  it('give an install from the release before the schema of a fresh install', async () => {
    const fresh = schemaOf(await freshInstall());
    expect(fresh.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['gws_ea_workspace_folder', 'gws_ea_workspace_grants']),
    );
    expect(schemaOf(await updatedInstall())).toEqual(fresh);
  });

  it('start with one empty folder row and no grants', async () => {
    const db = await freshInstall();
    expect(await db.all('SELECT * FROM gws_ea_workspace_folder')).toEqual([
      { singleton: 1, folder_id: null, told_folder_id: null, address_list: null, updated_at: null },
    ]);
    expect(await db.all('SELECT * FROM gws_ea_workspace_grants')).toEqual([]);
  });

  it('refuse a grant that contradicts itself', async () => {
    const db = await freshInstall();
    const insert = (email: string, permissionId: string | null, state: string, hostMade: number) =>
      db.run(
        'INSERT INTO gws_ea_workspace_grants (email, permission_id, state, host_made, recorded_at) VALUES (?, ?, ?, ?, ?)',
        email,
        permissionId,
        state,
        hostMade,
        AT,
      );
    await insert('morgan@example.test', '0812', 'granted', 1);
    await insert('morgan@nowhere.example', null, 'refused', 0);
    await insert('morgan@work.example.test', '0813', 'removed', 1);
    // A grant without its permission, a refusal the host made, and a state Drive has no word for.
    await expect(insert('morgan@other.example.test', null, 'granted', 1)).rejects.toThrow(/CHECK/);
    await expect(insert('morgan@other.example.test', '0814', 'refused', 1)).rejects.toThrow(/CHECK/);
    await expect(insert('morgan@other.example.test', '0814', 'pending', 0)).rejects.toThrow(/CHECK/);
    await expect(db.run('INSERT INTO gws_ea_workspace_folder (singleton) VALUES (2)')).rejects.toThrow(/CHECK/);
  });
});
