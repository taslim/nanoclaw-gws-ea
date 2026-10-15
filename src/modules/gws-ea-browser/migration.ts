import type { ModuleMigrationName, PortableMigration } from '../../db/migrations/index.js';

export const browserQueueMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 2,
  name: 'module:gws-ea-browser:durable-queue',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_jobs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL UNIQUE,
        browser_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        source_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE gws_ea_browser_requests (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        budget_ms INTEGER NOT NULL,
        accepted_at TEXT NOT NULL,
        started_at TEXT,
        commit_started_at TEXT,
        answered_at TEXT,
        answer_json TEXT,
        delivered_at TEXT,
        UNIQUE(session_id, request_id)
      );
      CREATE INDEX gws_ea_browser_requests_pending ON gws_ea_browser_requests(job_id, answered_at, accepted_at);
      CREATE INDEX gws_ea_browser_requests_delivery ON gws_ea_browser_requests(delivered_at, answered_at);
      CREATE TABLE gws_ea_browser_downloads (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES gws_ea_browser_jobs(id),
        request_id TEXT NOT NULL REFERENCES gws_ea_browser_requests(id),
        host_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        inbox_path TEXT,
        handed_off_at TEXT
      );
    `);
  },
};

/** Profile-local site ownership and durable wake candidates; never session mailbox state. */
export const browserSiteLeasesMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:site-leases',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_site_leases (
        site TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'idle', 'purchase')),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX gws_ea_browser_site_leases_job ON gws_ea_browser_site_leases(job_id);
      CREATE TABLE gws_ea_browser_site_waiters (
        site TEXT NOT NULL,
        job_id TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        PRIMARY KEY (site, job_id)
      );
    `);
  },
};
