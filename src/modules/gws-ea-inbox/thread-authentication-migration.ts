import type { ModuleMigration } from '../../db/migrations/index.js';

export const threadAuthenticationMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-inbox:thread-sender-authentication',
  async up(db) {
    await db.exec(`ALTER TABLE gws_ea_thread_addresses
      ADD COLUMN sender_authenticated INTEGER NOT NULL DEFAULT 0 CHECK (sender_authenticated IN (0, 1))`);
  },
};
