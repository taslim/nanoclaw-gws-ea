/**
 * Per-install KV store for state derived from `.env` that the host has
 * copied somewhere persistent (CLAUDE.md text, role grants, etc.). Each row
 * is the last-synced value of one tracked env var; on boot,
 * `syncInstallState` compares stored vs. current env and dispatches a
 * per-key handler when they diverge, then writes the new value back.
 *
 * First-boot semantics: stored is null, env is current, handler treats this
 * as a "from null to current" change. For PRINCIPAL_EMAILS that means every
 * principal email gets owner-granted on first run — auto-seeds the install
 * without a separate ritual.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'install-state',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE install_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
