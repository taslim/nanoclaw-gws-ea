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
