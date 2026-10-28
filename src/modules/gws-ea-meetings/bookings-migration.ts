import type { ModuleMigration } from '../../db/migrations/index.js';

export const bookingsMigration: ModuleMigration = {
  version: 3,
  name: 'module:gws-ea-meetings:bookings',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_bookings (
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('thread','chat')),
        owner_key TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        booked_at TEXT NOT NULL,
        PRIMARY KEY(calendar_id,event_id)
      );
      CREATE INDEX gws_ea_bookings_owner ON gws_ea_bookings(owner_kind,owner_key,event_id);
      CREATE TABLE gws_ea_booking_requests (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('book','change','cancel')),
        fingerprint TEXT NOT NULL,
        request_json TEXT NOT NULL,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('thread','chat')),
        owner_key TEXT NOT NULL,
        calendar_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        event_etag TEXT,
        carried_over INTEGER NOT NULL DEFAULT 0 CHECK(carried_over IN (0,1)),
        applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
        result_json TEXT,
        reported INTEGER NOT NULL DEFAULT 0 CHECK(reported IN (0,1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id,request_id)
      );
      CREATE INDEX gws_ea_booking_requests_pending ON gws_ea_booking_requests(created_at,session_id,request_id);
      CREATE INDEX gws_ea_booking_requests_booking ON gws_ea_booking_requests(owner_kind,owner_key,event_id,reported);
      INSERT INTO gws_ea_bookings(owner_kind,owner_key,calendar_id,event_id,booked_at)
        SELECT 'thread',thread_key,calendar_id,event_id,booked_at FROM gws_ea_thread_bookings;
      INSERT INTO gws_ea_bookings(owner_kind,owner_key,calendar_id,event_id,booked_at)
        SELECT 'chat',messaging_group_id,calendar_id,event_id,booked_at FROM gws_ea_chat_bookings;
      INSERT INTO gws_ea_booking_requests(
        session_id,request_id,action,fingerprint,request_json,owner_kind,owner_key,calendar_id,event_id,
        start_at,end_at,event_etag,carried_over,applied,result_json,reported,created_at
      ) SELECT session_id,request_id,action,fingerprint,request_json,'chat',messaging_group_id,calendar_id,event_id,
        start_at,end_at,NULL,1,applied,result_json,reported,created_at
        FROM gws_ea_chat_booking_requests WHERE answered=0;
      DROP TABLE gws_ea_chat_booking_requests;
      DROP TABLE gws_ea_chat_bookings;
      DROP TABLE gws_ea_thread_bookings;
    `);
  },
};
