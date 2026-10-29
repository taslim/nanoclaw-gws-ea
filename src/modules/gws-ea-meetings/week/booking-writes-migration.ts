import type { ModuleMigration } from '../../../db/migrations/index.js';

export const bookingWriteWindowsMigration: ModuleMigration = {
  version: 8,
  name: 'module:gws-ea-meetings:booking-write-windows',
  async up(db) {
    await db.exec(`CREATE TABLE gws_ea_booking_write_windows (
      session_id TEXT NOT NULL, request_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL, event_id TEXT NOT NULL,
      previous_start TEXT NOT NULL, previous_end TEXT NOT NULL,
      current_start TEXT NOT NULL, current_end TEXT NOT NULL,
      refreshed INTEGER NOT NULL DEFAULT 0 CHECK(refreshed IN (0,1)),
      PRIMARY KEY(session_id,request_id)
    );
    CREATE INDEX gws_ea_booking_write_windows_pending ON gws_ea_booking_write_windows(refreshed);`);
  },
};
