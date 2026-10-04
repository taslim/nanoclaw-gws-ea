import type { ModuleMigration } from '../../db/migrations/index.js';

export const gwsEaProfileMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-profile:create-profile',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_profile (
        singleton                    INTEGER PRIMARY KEY CHECK (singleton = 1),
        assistant_display_name       TEXT,
        assistant_workspace_email    TEXT,
        principal_display_name       TEXT,
        principal_timezone           TEXT,
        main_agent_group_id          TEXT UNIQUE REFERENCES agent_groups(id),
        updated_at                    TEXT
      );

      CREATE TABLE gws_ea_principal_users (
        user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        verified_at  TEXT NOT NULL
      );

      INSERT INTO gws_ea_profile (singleton) VALUES (1);
    `);
  },
};

/**
 * `external-email`'s agent group, beside main's. The host creates the group
 * once and records it here (src/modules/gws-ea-external-email). An assistant
 * from before it gains an empty pointer, which its next start fills.
 */
export const gwsEaExternalEmailPointerMigration: ModuleMigration = {
  version: 3,
  name: 'module:gws-ea-profile:external-email-pointer',
  async up(db) {
    await db.exec(
      'ALTER TABLE gws_ea_profile ADD COLUMN external_email_agent_group_id TEXT REFERENCES agent_groups(id);',
    );
  },
};

/** The principal's email addresses: one row each, stored lowercased, so each address is held once. */
export const gwsEaPrincipalAddressesMigration: ModuleMigration = {
  version: 2,
  name: 'module:gws-ea-profile:principal-addresses',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_principal_addresses (
        email     TEXT PRIMARY KEY,
        added_at  TEXT NOT NULL
      );
    `);
  },
};
