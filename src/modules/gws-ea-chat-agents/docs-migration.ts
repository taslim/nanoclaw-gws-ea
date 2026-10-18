import type { ModuleMigration } from '../../db/migrations/index.js';

export const jobDocumentsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-chat-agents:documents',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_job_document_folders (
        agent_group_id TEXT PRIMARY KEY REFERENCES gws_ea_job_agents(agent_group_id) ON DELETE CASCADE,
        folder_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE gws_ea_job_documents (
        file_id TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL REFERENCES gws_ea_job_agents(agent_group_id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX gws_ea_job_documents_owner ON gws_ea_job_documents(agent_group_id);
      CREATE TABLE gws_ea_job_document_requests (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('create','edit')),
        fingerprint TEXT NOT NULL,
        file_id TEXT,
        revision_id TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id,request_id)
      );
    `);
  },
};
