import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * The principal's private values. Each has a label the principal knows it by
 * and one fixed kind. The value is held as the principal wrote it; the check
 * reduces it to its matching form when it runs, so a better normalization
 * covers every stored value at once.
 *
 * Installs that ran an earlier release also created a per-thread record table
 * here; `drop-thread-records` removes it there and does nothing on a fresh
 * install.
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
 * per-thread records (what each outbound thread sent, its refusals, and when
 * it stopped) go. A no-op on a fresh install.
 */
export const gwsEaPrivacyDropThreadsMigration: ModuleMigration = {
  version: 2,
  name: 'module:gws-ea-privacy:drop-thread-records',
  async up(db) {
    await db.exec('DROP TABLE IF EXISTS gws_ea_privacy_threads');
  },
};
