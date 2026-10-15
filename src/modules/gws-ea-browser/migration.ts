import type { ModuleMigrationName, PortableMigration } from '../../db/migrations/index.js';

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
