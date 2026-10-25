import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * The home folder: one row for the folder's Drive id, the folder `main` was
 * last told of, and the principal addresses the grants were last reconciled
 * against; and one row per principal address's grant on the folder. Only a
 * grant the host made (`host_made`) is ever revoked.
 */
export const gwsEaWorkspaceHomeFolderMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-workspace:home-folder',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_workspace_folder (
        singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
        folder_id       TEXT,
        told_folder_id  TEXT,
        address_list    TEXT,
        updated_at      TEXT
      );

      CREATE TABLE gws_ea_workspace_grants (
        email          TEXT PRIMARY KEY,
        permission_id  TEXT,
        state          TEXT NOT NULL CHECK (state IN ('granted', 'refused', 'removed')),
        host_made      INTEGER NOT NULL CHECK (host_made IN (0, 1)),
        recorded_at    TEXT NOT NULL,
        CHECK (state <> 'granted' OR permission_id IS NOT NULL),
        CHECK (state <> 'refused' OR host_made = 0)
      );

      INSERT INTO gws_ea_workspace_folder (singleton) VALUES (1);
    `);
  },
};
