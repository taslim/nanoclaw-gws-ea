import type { ModuleMigrationName, PortableMigration } from '../../db/migrations/index.js';

/** Host-only metadata: no message body, code, bearer link or credential is stored here. */
export const browserSignInMigration: PortableMigration & { name: ModuleMigrationName } = {
  version: 1,
  name: 'module:gws-ea-browser:sign-in-claims',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_browser_sign_in_claims (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('assistant','principal')),
        origin TEXT NOT NULL,
        domain TEXT NOT NULL,
        binding_json TEXT NOT NULL,
        since_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('waiting','finished')),
        gmail_message_id TEXT UNIQUE
      );
      CREATE INDEX gws_ea_browser_sign_in_claim_site ON gws_ea_browser_sign_in_claims(domain,expires_at);
      CREATE INDEX gws_ea_browser_sign_in_claim_job ON gws_ea_browser_sign_in_claims(job_id,state);
    `);
  },
};
