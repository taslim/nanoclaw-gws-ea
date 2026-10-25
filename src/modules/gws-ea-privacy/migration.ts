import type { ModuleMigration } from '../../db/migrations/index.js';

export const gwsEaChatClearancesMigration: ModuleMigration = {
  version: 3,
  name: 'module:gws-ea-privacy:chat-clearances',
  async up(db) {
    // The cited mark expires after a day; the clearance lasts until detach,
    // so its audit id deliberately has no foreign key to the pruned marks.
    await db.exec(`
      CREATE TABLE gws_ea_chat_clearances (
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        private_value_id TEXT NOT NULL REFERENCES gws_ea_private_values(id) ON DELETE CASCADE,
        principal_message_id TEXT NOT NULL,
        cleared_at TEXT NOT NULL,
        PRIMARY KEY (messaging_group_id, private_value_id)
      );
    `);
  },
};

/**
 * The value is held as the principal wrote it; the check reduces it to its
 * matching form when it runs, so a better normalization covers every stored
 * value at once.
 */
export const gwsEaPrivacyMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-privacy:create-privacy',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_private_values (
        id          TEXT PRIMARY KEY CHECK (id LIKE 'pv-%'),
        label       TEXT NOT NULL CHECK (label <> ''),
        kind        TEXT NOT NULL CHECK (kind IN ('address', 'phone', 'email', 'other')),
        value       TEXT NOT NULL CHECK (value <> ''),
        created_at  TEXT NOT NULL
      );
    `);
  },
};

/**
 * The audience check judges each send on its own, so an earlier release's
 * per-thread records go. A no-op on a fresh install.
 */
export const gwsEaPrivacyDropThreadsMigration: ModuleMigration = {
  version: 2,
  name: 'module:gws-ea-privacy:drop-thread-records',
  async up(db) {
    await db.exec('DROP TABLE IF EXISTS gws_ea_privacy_threads');
  },
};
