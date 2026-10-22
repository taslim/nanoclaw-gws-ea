import type { ModuleMigration } from '../../db/migrations/index.js';

export const chatBookingReportsMigration: ModuleMigration = {
  version: 2,
  name: 'module:gws-ea-meetings:chat-booking-reports',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_chat_booking_requests_with_books (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('book','change','cancel')),
        fingerprint TEXT NOT NULL,
        request_json TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
        result_json TEXT,
        reported INTEGER NOT NULL DEFAULT 0 CHECK(reported IN (0,1)),
        answered INTEGER NOT NULL DEFAULT 0 CHECK(answered IN (0,1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id,request_id)
      );
      INSERT INTO gws_ea_chat_booking_requests_with_books SELECT * FROM gws_ea_chat_booking_requests;
      DROP TABLE gws_ea_chat_booking_requests;
      ALTER TABLE gws_ea_chat_booking_requests_with_books RENAME TO gws_ea_chat_booking_requests;
      CREATE INDEX gws_ea_chat_booking_requests_pending ON gws_ea_chat_booking_requests(answered,created_at);
    `);
  },
};
