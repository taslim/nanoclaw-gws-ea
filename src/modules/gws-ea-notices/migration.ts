import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * `gws_ea_notices_reported`: each failed reply the principal was told of.
 * Delivery may report a give-up again after a stop, and the principal hears
 * of each reply once.
 */
export const gwsEaNoticesMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-notices:reported-failures',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_notices_reported (
        message_id   TEXT PRIMARY KEY,
        reported_at  TEXT NOT NULL
      );
    `);
  },
};
