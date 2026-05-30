import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Email module — Gmail channel state. Custom build for GWS-EA — no upstream equivalent.
 *
 * `email_state` stores the Gmail history pointer (`last_history_id`) so the
 * adapter resumes change polling across restarts without re-processing or
 * skipping. `email_deferred` queues external-route emails that wait
 * `EMAIL_EXTERNAL_DELAY` before reaching the agent — survives host restart
 * because `last_history_id` advances past these messages on the poll that
 * enqueued them, so Gmail won't replay.
 */
export const moduleEmail: Migration = {
  version: 15,
  name: 'email',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE email_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE email_deferred (
        message_id TEXT PRIMARY KEY,
        thread_id  TEXT NOT NULL,
        due_at     TEXT NOT NULL,
        payload    TEXT NOT NULL
      );
      CREATE INDEX idx_email_deferred_due ON email_deferred(due_at);
    `);
  },
};
