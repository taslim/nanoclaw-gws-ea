import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * GChat events module — native inbound for Google Chat via Workspace Events.
 *
 * `gchat_workspace_subscription` persists the wildcard Workspace Events
 * subscription name + expiry so the host reuses it across restarts (rather
 * than recreating per-space subscriptions every boot, which is the
 * chat-sdk's default and the source of the inbound-loss window). One row
 * per project — a single wildcard `spaces/-` subscription delivers events
 * for every space the bot is in.
 */
export const moduleGchatEvents: Migration = {
  version: 16,
  name: 'gchat-events',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE gchat_workspace_subscription (
        project_id   TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        expire_time  TEXT,
        updated_at   TEXT NOT NULL
      );
    `);
  },
};
