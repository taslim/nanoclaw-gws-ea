import type { ModuleMigration } from '../../../db/migrations/index.js';

export const calendarSplitRecoveryMigration: ModuleMigration = {
  version: 7,
  name: 'module:gws-ea-meetings:calendar-split-recovery',
  async up(db) {
    await db.exec(`
      ALTER TABLE gws_ea_calendar_write_log ADD COLUMN refresh_scope TEXT NOT NULL DEFAULT 'event';
      CREATE TABLE gws_ea_calendar_split_recovery (
        request_id TEXT PRIMARY KEY REFERENCES gws_ea_calendar_write_log(request_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, created_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, master_changed INTEGER NOT NULL DEFAULT 0,
        terminal_error TEXT, reported INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX gws_ea_calendar_split_recovery_pending
        ON gws_ea_calendar_split_recovery(reported,next_attempt_at,request_id);
    `);
  },
};
