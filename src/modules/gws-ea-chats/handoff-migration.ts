import type { ModuleMigration } from '../../db/migrations/index.js';

export const chatHandoffMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-chats:handoffs',
  async up(db) {
    await db.exec(`
      ALTER TABLE gws_ea_chats ADD COLUMN placed_nowhere INTEGER NOT NULL DEFAULT 0 CHECK (placed_nowhere IN (0,1));
      ALTER TABLE gws_ea_chats ADD COLUMN calendar_id TEXT;
      CREATE TABLE gws_ea_chat_handoffs (
        id TEXT PRIMARY KEY,
        messaging_group_id TEXT NOT NULL REFERENCES gws_ea_chats(messaging_group_id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        matter_id TEXT REFERENCES gws_ea_matters(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        delivered_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
      );
      CREATE INDEX gws_ea_chat_handoffs_pending ON gws_ea_chat_handoffs(messaging_group_id, delivered_session_id);
      CREATE TABLE gws_ea_chat_files (
        handoff_id TEXT NOT NULL REFERENCES gws_ea_chat_handoffs(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        host_path TEXT NOT NULL,
        PRIMARY KEY(handoff_id,file_name)
      );
    `);
  },
};
