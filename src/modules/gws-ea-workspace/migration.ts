import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * The home folder (KTD3): one row holding the folder's Drive id and the
 * principal's addresses the grants were last reconciled against, and the
 * host's record of each principal address's grant on the folder. A grant
 * holds the Drive permission it matched, whether the host made it (only
 * those are ever revoked), and whether it stands, Google refused the
 * address, or the principal removed it by hand.
 */
export const gwsEaWorkspaceHomeFolderMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-workspace:home-folder',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_workspace_folder (
        singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
        folder_id     TEXT,
        address_list  TEXT,
        updated_at    TEXT
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
