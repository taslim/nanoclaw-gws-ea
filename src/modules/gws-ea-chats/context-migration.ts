import type { ModuleMigration } from '../../db/migrations/index.js';

/** The chat facts each session was last told, so a change back to earlier facts is told again. */
export const chatContextMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-chats:contexts',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_chat_contexts (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        version INTEGER NOT NULL,
        written_at TEXT NOT NULL
      );
    `);
  },
};
