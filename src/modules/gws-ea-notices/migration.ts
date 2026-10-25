import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * `gws_ea_notices_reported`: each message of the principal's they were told
 * the assistant could not finish, so a failure reported again after a stop is
 * heard once.
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
