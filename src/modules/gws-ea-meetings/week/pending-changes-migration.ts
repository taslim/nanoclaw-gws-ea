import type { ModuleMigration } from '../../../db/migrations/index.js';
export const pendingCalendarChangesMigration: ModuleMigration = {
  version: 6,
  name: 'module:gws-ea-meetings:pending-calendar-changes',
  async up(db) {
    await db.exec(`CREATE TABLE gws_ea_pending_calendar_changes (
      message_id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL,
      change_kind TEXT NOT NULL, received_at TEXT NOT NULL
    ); CREATE INDEX gws_ea_pending_calendar_changes_event ON gws_ea_pending_calendar_changes(calendar_id,event_id,received_at);`);
  },
};
