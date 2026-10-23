import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { migrations, runMigrations } from '../../db/migrations/index.js';
import {
  gwsEaProfileMigration,
  gwsEaPrincipalAddressesMigration,
  gwsEaExternalEmailPointerMigration,
  gwsEaBrowserPointerMigration,
  gwsEaWebAliasMigration,
  gwsEaExternalChatPointerMigration,
  gwsEaPrincipalMessagesMigration,
  gwsEaPrincipalDmRoutingMigration,
} from './migration.js';

let db: SqliteDriver;
const profileMigrations = [
  ...migrations,
  gwsEaProfileMigration,
  gwsEaPrincipalAddressesMigration,
  gwsEaExternalEmailPointerMigration,
  gwsEaBrowserPointerMigration,
  gwsEaWebAliasMigration,
  gwsEaExternalChatPointerMigration,
  gwsEaPrincipalMessagesMigration,
  gwsEaPrincipalDmRoutingMigration,
];

beforeEach(async () => {
  db = new SqliteDriver(new Database(':memory:'));
  await db.exec('PRAGMA foreign_keys = ON');
  await runMigrations(db, profileMigrations);
});
afterEach(async () => db.close());

describe('native structured profile schema', () => {
  it('creates an empty singleton and requires both first names before publication, with optional last names', async () => {
    expect(
      await db.get(
        'SELECT assistant_first_name, assistant_last_name, principal_first_name, principal_last_name FROM gws_ea_profile',
      ),
    ).toEqual({
      assistant_first_name: null,
      assistant_last_name: null,
      principal_first_name: null,
      principal_last_name: null,
    });
    await db.run("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('main', 'main', 'main', 'then')");
    await expect(db.run("UPDATE gws_ea_profile SET main_agent_group_id = 'main'")).rejects.toThrow(/CHECK/iu);
    await db.run("UPDATE gws_ea_profile SET assistant_first_name = 'Aya'");
    await expect(db.run("UPDATE gws_ea_profile SET main_agent_group_id = 'main'")).rejects.toThrow(/CHECK/iu);
    await db.run("UPDATE gws_ea_profile SET principal_first_name = 'Morgan', main_agent_group_id = 'main'");
    expect(
      await db.get('SELECT main_agent_group_id, assistant_last_name, principal_last_name FROM gws_ea_profile'),
    ).toEqual({
      main_agent_group_id: 'main',
      assistant_last_name: null,
      principal_last_name: null,
    });
  });
});
