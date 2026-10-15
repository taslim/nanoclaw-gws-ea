import { registerMigration } from '../../../db/migrations/index.js';

registerMigration({
  version: 1,
  name: 'module:agent-to-agent:threaded-destinations',
  async up(db) {
    await db.exec(`
      ALTER TABLE agent_destinations ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'agent-shared' CHECK (session_mode IN ('agent-shared', 'per-thread'));
      ALTER TABLE agent_destinations ADD COLUMN inbound_untrusted INTEGER NOT NULL DEFAULT 0 CHECK (inbound_untrusted IN (0, 1));
    `);
  },
});
