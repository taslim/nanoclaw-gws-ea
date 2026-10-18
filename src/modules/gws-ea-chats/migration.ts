import type { ModuleMigration } from '../../db/migrations/index.js';

export const chatsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-chats:chats',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_chats (
        messaging_group_id TEXT PRIMARY KEY REFERENCES messaging_groups(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('asking','connected','moving','job','declined','detached')),
        serving_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        principal_present INTEGER NOT NULL CHECK (principal_present IN (0,1)),
        asking_notified_at TEXT,
        connected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX gws_ea_chats_state ON gws_ea_chats(state, created_at);
      CREATE TABLE gws_ea_chat_members (
        messaging_group_id TEXT NOT NULL REFERENCES gws_ea_chats(messaging_group_id) ON DELETE CASCADE,
        member_key TEXT NOT NULL,
        person_id TEXT REFERENCES gws_ea_people(id) ON DELETE SET NULL,
        name TEXT,
        is_principal INTEGER NOT NULL CHECK (is_principal IN (0,1)),
        email TEXT,
        email_source TEXT CHECK (email_source IN ('main','member')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (messaging_group_id, member_key),
        CHECK ((email IS NULL) = (email_source IS NULL))
      );
      CREATE INDEX gws_ea_chat_members_person ON gws_ea_chat_members(person_id);
    `);
  },
};
