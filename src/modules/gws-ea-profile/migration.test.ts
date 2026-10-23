import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { migrations, runMigrations } from '../../db/migrations/index.js';
import { PROFILE_NAME_INPUT_TABLE, type ProfileNameMigrationInput } from '../../gws-ea/profile-name-migration.js';
import {
  gwsEaProfileMigration,
  gwsEaPrincipalAddressesMigration,
  gwsEaExternalEmailPointerMigration,
  gwsEaBrowserPointerMigration,
  gwsEaWebAliasMigration,
  gwsEaExternalChatPointerMigration,
  gwsEaPrincipalMessagesMigration,
  gwsEaPrincipalDmRoutingMigration,
  gwsEaStructuredNamesMigration,
} from './migration.js';

let db: SqliteDriver;
const beforeNames = [
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
const input: ProfileNameMigrationInput = {
  schema_version: 1,
  instance_id: 'assistant-one',
  previous: { assistant_display_name: 'Aya Ren', principal_display_name: 'María del Carmen Sol' },
  assistant: { firstName: 'Aya', lastName: 'Ren' },
  principal: { firstName: 'María del Carmen', lastName: 'Sol' },
};

beforeEach(async () => {
  db = new SqliteDriver(new Database(':memory:'));
  await db.exec('PRAGMA foreign_keys = ON');
  await runMigrations(db, beforeNames);
});
afterEach(async () => db.close());

async function legacy(): Promise<void> {
  await db.run("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('main', 'main', 'main', 'then')");
  await db.run(`UPDATE gws_ea_profile SET assistant_display_name = 'Aya Ren', principal_display_name = 'María del Carmen Sol',
    assistant_workspace_email = 'aya@example.test', principal_timezone = 'Europe/Madrid', main_agent_group_id = 'main',
    external_email_agent_group_id = 'main', browser_agent_group_id = 'main', external_chat_agent_group_id = 'main',
    assistant_alias = 'aya-web@example.test', alias_candidate = 'candidate@example.test', alias_probe_message_id = 'probe', updated_at = 'then'`);
  await db.run("INSERT INTO gws_ea_principal_addresses (email, added_at) VALUES ('principal@example.test', 'then')");
}

async function seed(value: unknown): Promise<void> {
  await db.exec(
    `CREATE TABLE ${PROFILE_NAME_INPUT_TABLE} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL)`,
  );
  await db.run(`INSERT INTO ${PROFILE_NAME_INPUT_TABLE} VALUES (1, ?)`, JSON.stringify(value));
}

async function convert(): Promise<void> {
  await runMigrations(db, [gwsEaStructuredNamesMigration]);
}

describe('explicit structured profile name migration', () => {
  it('converts exact supplied boundaries and preserves every unrelated profile value and foreign key', async () => {
    await legacy();
    await db.run("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('other', 'other', 'other', 'then')");
    await db.run(`INSERT INTO container_configs (agent_group_id, assistant_name, timezone, updated_at)
      VALUES ('main', 'Aya Ren', 'Europe/Madrid', 'then'), ('other', 'Independent', 'UTC', 'then')`);
    await seed({ ...input, assistant: { firstName: 'Aya', lastName: 'Renée' } });
    await convert();
    expect(await db.get('SELECT * FROM gws_ea_profile')).toEqual({
      singleton: 1,
      assistant_first_name: 'Aya',
      assistant_last_name: 'Renée',
      principal_first_name: 'María del Carmen',
      principal_last_name: 'Sol',
      assistant_workspace_email: 'aya@example.test',
      principal_timezone: 'Europe/Madrid',
      main_agent_group_id: 'main',
      external_email_agent_group_id: 'main',
      browser_agent_group_id: 'main',
      external_chat_agent_group_id: 'main',
      assistant_alias: 'aya-web@example.test',
      alias_candidate: 'candidate@example.test',
      alias_probe_message_id: 'probe',
      updated_at: 'then',
    });
    expect(await db.all('SELECT * FROM gws_ea_principal_addresses')).toEqual([
      { email: 'principal@example.test', added_at: 'then' },
    ]);
    expect(
      await db.all('SELECT agent_group_id, assistant_name, timezone FROM container_configs ORDER BY agent_group_id'),
    ).toEqual([
      { agent_group_id: 'main', assistant_name: 'Aya Renée', timezone: 'Europe/Madrid' },
      { agent_group_id: 'other', assistant_name: 'Independent', timezone: 'UTC' },
    ]);
    expect(await db.get('SELECT name FROM sqlite_master WHERE name = ?', PROFILE_NAME_INPUT_TABLE)).toBeUndefined();
    expect(await db.all('PRAGMA foreign_key_check')).toEqual([]);
    await expect(db.run("UPDATE gws_ea_profile SET browser_agent_group_id = 'missing'")).rejects.toThrow(
      /FOREIGN KEY/iu,
    );
    await convert();
  });

  it.each(['missing', 'stale', 'invalid'] as const)(
    'refuses %s input without partially changing legacy schema or data',
    async (kind) => {
      await legacy();
      if (kind !== 'missing')
        await seed(
          kind === 'stale'
            ? { ...input, previous: { ...input.previous, principal_display_name: 'Old' } }
            : { ...input, principal: { firstName: '', lastName: null } },
        );
      const before = await db.get('SELECT * FROM gws_ea_profile');
      await expect(convert()).rejects.toThrow(
        kind === 'missing' ? /requires explicit names/u : kind === 'stale' ? /input is stale/u : /person's name/u,
      );
      expect(await db.get('SELECT * FROM gws_ea_profile')).toEqual(before);
      expect(
        await db.get('SELECT name FROM schema_version WHERE name = ?', 'module:gws-ea-profile:structured-names'),
      ).toBeUndefined();
      if (kind !== 'missing')
        expect(await db.get(`SELECT singleton FROM ${PROFILE_NAME_INPUT_TABLE}`)).toEqual({ singleton: 1 });
    },
  );

  it('converts a fresh singleton without input and prevents publication without both first names', async () => {
    await convert();
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
  });
});
