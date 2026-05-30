import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Matters: workstream tracking. Custom build for GWS-EA — no upstream equivalent.
 *
 * Schema is a slim header: title, stable `description` (scope/aliases for
 * `search_matters`), `status`, `updated_at`. Live working memory ("what we
 * know right now") lives in the optional context file at
 * `groups/main/matters/<id>.md` — files are canonical and purgeable
 * independently of the row.
 *
 * `matter_artifacts` is the foreign-system pointer table. (type, id) is
 * unique across the whole table — an artifact belongs to at most one matter,
 * which makes `find_matter` an indexed equality lookup.
 */
export const moduleMatters: Migration = {
  version: 14,
  name: 'matters',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE matters (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'active',
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_matters_status ON matters(status);

      CREATE TABLE matter_artifacts (
        matter_id     INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL,
        artifact_id   TEXT NOT NULL,
        linked_at     TEXT NOT NULL,
        PRIMARY KEY (artifact_type, artifact_id)
      );
      CREATE INDEX idx_matter_artifacts_matter ON matter_artifacts(matter_id);
    `);
  },
};
