import type { ModuleMigration } from '../../db/migrations/index.js';

export const chatMoveMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-chats:move',
  async up(db) {
    await db.exec(`
      ALTER TABLE gws_ea_chats ADD COLUMN move_source_session_id TEXT REFERENCES sessions(id);
      ALTER TABLE gws_ea_chats ADD COLUMN move_request_id TEXT;
      ALTER TABLE gws_ea_chats ADD COLUMN move_pending_reminder_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE gws_ea_chats ADD COLUMN move_failed INTEGER NOT NULL DEFAULT 0 CHECK (move_failed IN (0,1));
    `);
  },
};
