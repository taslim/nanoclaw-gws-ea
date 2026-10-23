import type { ModuleMigration } from '../../db/migrations/index.js';

export const artifactsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-artifacts:content-and-requests',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_artifacts (
        artifact_id TEXT PRIMARY KEY,
        author_group_id TEXT NOT NULL,
        create_key TEXT NOT NULL,
        initial_fingerprint TEXT NOT NULL,
        title TEXT,
        head_revision INTEGER,
        generation INTEGER NOT NULL CHECK(generation > 0),
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(author_group_id, create_key),
        FOREIGN KEY(artifact_id, head_revision) REFERENCES gws_ea_artifact_revisions(artifact_id, revision),
        CHECK(head_revision IS NULL OR head_revision > 0),
        CHECK(deleted_at IS NULL OR (title IS NULL AND head_revision IS NULL AND expires_at IS NULL))
      );
      CREATE INDEX gws_ea_artifacts_author ON gws_ea_artifacts(author_group_id, artifact_id);
      CREATE TABLE gws_ea_artifact_revisions (
        artifact_id TEXT NOT NULL REFERENCES gws_ea_artifacts(artifact_id),
        revision INTEGER NOT NULL CHECK(revision > 0),
        title TEXT NOT NULL,
        html TEXT NOT NULL,
        source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
        byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 4194304),
        created_at TEXT NOT NULL,
        PRIMARY KEY(artifact_id, revision)
      );
      CREATE TABLE gws_ea_artifact_shares (
        share_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES gws_ea_artifacts(artifact_id),
        kind TEXT NOT NULL CHECK(kind IN ('named', 'public')),
        revision INTEGER,
        source_hash TEXT,
        generation INTEGER NOT NULL CHECK(generation > 0),
        state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'revoked')),
        expires_at TEXT,
        principal_messaging_group_id TEXT,
        principal_message_id TEXT,
        scope_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(artifact_id, revision) REFERENCES gws_ea_artifact_revisions(artifact_id, revision),
        CHECK(state = 'revoked' OR (revision IS NOT NULL AND source_hash IS NOT NULL AND scope_hash IS NOT NULL)),
        CHECK(source_hash IS NULL OR length(source_hash) = 64)
      );
      CREATE UNIQUE INDEX gws_ea_artifact_public_slot ON gws_ea_artifact_shares(artifact_id) WHERE kind = 'public';
      CREATE INDEX gws_ea_artifact_share_artifact ON gws_ea_artifact_shares(artifact_id);
      CREATE TABLE gws_ea_artifact_share_recipients (
        share_id TEXT NOT NULL REFERENCES gws_ea_artifact_shares(share_id) ON DELETE CASCADE,
        email TEXT NOT NULL CHECK(email <> '' AND email = lower(email)),
        PRIMARY KEY(share_id, email)
      );
      CREATE TABLE gws_ea_artifact_requests (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        actor_group_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('save', 'share', 'delete')),
        fingerprint TEXT NOT NULL,
        source_hash TEXT,
        state TEXT NOT NULL DEFAULT 'settled' CHECK(state IN ('pending','settled')),
        result_json TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, request_id),
        CHECK((state='settled' AND result_json IS NOT NULL) OR (state='pending' AND action='share' AND result_json IS NULL AND payload_json IS NOT NULL)),
        CHECK(payload_json IS NULL OR length(payload_json) <= 16384)
      );
    `);
  },
};
