import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * The person record (KTD8), its invariants held by the schema itself so a
 * writer that skips `db.ts` still cannot break them:
 *
 * - each person has exactly one level from the fixed set, with its source;
 *   anyone without a record is unknown, so `unknown` is never stored;
 * - a learned level stops at active: inner circle and close come only from
 *   the principal;
 * - each identity is a channel-qualified handle (`email:<address>`, in
 *   NanoClaw's user-id form) held by one person, an email handle lowercased;
 * - a remembered name means one person;
 * - standing instructions come only from the principal;
 * - a forgotten identity survives only as a keyed fingerprint (an HMAC-SHA256
 *   hex digest), never as the handle itself.
 *
 * `match_key` is the identity as `fingerprint.ts` normalizes it (case, Gmail
 * dots, plus-addressing), so an address made the principal's can release
 * every spelling of it.
 */
export const gwsEaPeopleMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-people:create-people',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_people (
        id            TEXT PRIMARY KEY CHECK (id LIKE 'p-%'),
        name          TEXT NOT NULL CHECK (name <> ''),
        name_key      TEXT NOT NULL CHECK (name_key <> ''),
        organization  TEXT CHECK (organization <> ''),
        notes         TEXT CHECK (notes <> ''),
        level         TEXT NOT NULL CHECK (level IN ('inner-circle', 'close', 'active', 'known')),
        level_source  TEXT NOT NULL CHECK (level_source IN ('principal', 'learned')),
        level_basis   TEXT NOT NULL CHECK (level_basis <> ''),
        level_set_at  TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        CHECK (level_source = 'principal' OR level IN ('active', 'known'))
      );
      CREATE INDEX idx_gws_ea_people_name_key ON gws_ea_people (name_key);

      CREATE TABLE gws_ea_people_identities (
        handle     TEXT PRIMARY KEY CHECK (
                     handle LIKE '_%:_%' AND (handle NOT LIKE 'email:%' OR handle = lower(handle))
                   ),
        match_key  TEXT NOT NULL CHECK (match_key <> ''),
        person_id  TEXT NOT NULL REFERENCES gws_ea_people(id) ON DELETE CASCADE,
        source     TEXT NOT NULL CHECK (source IN ('principal', 'directory', 'calendar')),
        added_at   TEXT NOT NULL
      );
      CREATE INDEX idx_gws_ea_people_identities_person ON gws_ea_people_identities (person_id);
      CREATE INDEX idx_gws_ea_people_identities_match ON gws_ea_people_identities (match_key);

      CREATE TABLE gws_ea_people_names (
        name_key   TEXT PRIMARY KEY CHECK (name_key <> ''),
        name       TEXT NOT NULL CHECK (name <> ''),
        person_id  TEXT NOT NULL REFERENCES gws_ea_people(id) ON DELETE CASCADE,
        added_at   TEXT NOT NULL
      );
      CREATE INDEX idx_gws_ea_people_names_person ON gws_ea_people_names (person_id);

      CREATE TABLE gws_ea_people_instructions (
        id          TEXT PRIMARY KEY CHECK (id LIKE 'i-%'),
        person_id   TEXT NOT NULL REFERENCES gws_ea_people(id) ON DELETE CASCADE,
        text        TEXT NOT NULL CHECK (text <> ''),
        source      TEXT NOT NULL CHECK (source = 'principal'),
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_gws_ea_people_instructions_person ON gws_ea_people_instructions (person_id);

      CREATE TABLE gws_ea_people_fingerprints (
        fingerprint   TEXT PRIMARY KEY CHECK (length(fingerprint) = 64 AND fingerprint NOT LIKE '%:%'),
        forgotten_at  TEXT NOT NULL
      );
    `);
  },
};
