import type { ModuleMigration } from '../../db/migrations/index.js';

export const chatAgentsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-chat-agents:job-agents',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_job_agents (
        agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('creating','active','retiring','retired')),
        retirement_peer_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX gws_ea_job_agents_live_chat ON gws_ea_job_agents(messaging_group_id)
        WHERE state <> 'retired';
    `);
  },
};
