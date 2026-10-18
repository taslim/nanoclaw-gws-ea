import type { ModuleMigration } from '../../db/migrations/index.js';

export const chatToolsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-chats:tools',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_chat_expected_replies (
        messaging_group_id TEXT NOT NULL REFERENCES gws_ea_chats(messaging_group_id) ON DELETE CASCADE,
        chat_created_at TEXT NOT NULL,
        request_id TEXT NOT NULL,
        member_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_message_id TEXT,
        PRIMARY KEY(messaging_group_id, request_id, member_key)
      );
      CREATE INDEX gws_ea_chat_expected_expiry ON gws_ea_chat_expected_replies(expires_at);
      CREATE TABLE gws_ea_chat_bookings (
        messaging_group_id TEXT NOT NULL REFERENCES gws_ea_chats(messaging_group_id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        booked_at TEXT NOT NULL,
        PRIMARY KEY(calendar_id,event_id)
      );
      CREATE INDEX gws_ea_chat_bookings_chat ON gws_ea_chat_bookings(messaging_group_id,event_id);
    `);
  },
};
