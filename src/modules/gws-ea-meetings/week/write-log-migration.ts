import type { ModuleMigration } from '../../../db/migrations/index.js';
export const calendarWriteLogMigration: ModuleMigration = {
  version: 5,
  name: 'module:gws-ea-meetings:calendar-write-log',
  async up(db) {
    await db.exec(`CREATE TABLE gws_ea_calendar_write_log (
      request_id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL,
      action TEXT NOT NULL, fingerprint TEXT NOT NULL, request_json TEXT NOT NULL, before_json TEXT, plan_json TEXT,
      affected_start TEXT NOT NULL, affected_end TEXT NOT NULL, state TEXT NOT NULL,
      outcome TEXT, findings_checked INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );`);
  },
};
