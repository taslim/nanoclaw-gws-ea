import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * The principal's private values, and what the audience check keeps per
 * outbound thread.
 *
 * - A private value has a label the principal knows it by and one fixed
 *   kind. The value is held as the principal wrote it; the check reduces it
 *   to its matching form when it runs, so a better normalization covers
 *   every stored value at once.
 * - A thread record holds only what the check needs: the canonical tail of
 *   the latest sends to anyone but the principal (bounded, see `db.ts`), the
 *   number of refusals, and when the thread was stopped. `thread_id` is ''
 *   for a send outside any thread.
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

      CREATE TABLE gws_ea_privacy_threads (
        channel_type  TEXT NOT NULL CHECK (channel_type <> ''),
        platform_id   TEXT NOT NULL CHECK (platform_id <> ''),
        thread_id     TEXT NOT NULL,
        recent        TEXT NOT NULL,
        refusals      INTEGER NOT NULL CHECK (refusals >= 0),
        stopped_at    TEXT,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (channel_type, platform_id, thread_id)
      );
    `);
  },
};
