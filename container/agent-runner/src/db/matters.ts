/**
 * Container-side read helpers for the matters projection.
 *
 * Reads from `matters` / `matter_artifacts` in `inbound.db` — snapshots
 * written by the host on every container wake and after every
 * matters-mutating system action for the calling session. Tables ship in
 * `INBOUND_SCHEMA` like `destinations`, so reads can assume they exist.
 *
 * MatterStatus / MatterRow are duplicated from the host's `Matter` type
 * intentionally: host (Node) and container (Bun) live in separate tsconfig
 * trees with no shared type imports — same pattern as `DestinationRow`.
 * Container only adds `context` (the projected file body).
 */
import { getInboundDb } from './connection.js';

export const MATTER_STATUSES = ['active', 'waiting', 'escalated', 'paused', 'resolved', 'archived'] as const;
export type MatterStatus = (typeof MATTER_STATUSES)[number];

export interface MatterRow {
  id: number;
  title: string;
  description: string | null;
  status: MatterStatus;
  context: string | null;
  updated_at: string;
}

export interface MatterArtifactRow {
  matter_id: number;
  artifact_type: string;
  artifact_id: string;
  linked_at: string;
}

export function getMatter(id: number): MatterRow | undefined {
  return getInboundDb()
    .prepare('SELECT id, title, description, status, context, updated_at FROM matters WHERE id = ?')
    .get(id) as MatterRow | undefined;
}

export function listMatters(status?: MatterStatus): MatterRow[] {
  const db = getInboundDb();
  if (status) {
    return db
      .prepare(
        'SELECT id, title, description, status, context, updated_at FROM matters WHERE status = ? ORDER BY updated_at DESC',
      )
      .all(status) as MatterRow[];
  }
  return db
    .prepare(
      'SELECT id, title, description, status, context, updated_at FROM matters ORDER BY updated_at DESC',
    )
    .all() as MatterRow[];
}

export function findMatterByArtifact(artifactType: string, artifactId: string): MatterRow | undefined {
  return getInboundDb()
    .prepare(
      `SELECT m.id, m.title, m.description, m.status, m.context, m.updated_at
       FROM matters m
       JOIN matter_artifacts a ON a.matter_id = m.id
       WHERE a.artifact_type = ? AND a.artifact_id = ?`,
    )
    .get(artifactType, artifactId) as MatterRow | undefined;
}

/**
 * Splits the query on whitespace and requires every term (case-insensitive)
 * to appear in title or description. LIKE-based — fine for tens of matters;
 * revisit with FTS5 if matters cross ~100.
 */
export function searchMatters(query: string, limit = 10): MatterRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const clauses = terms.map(() => '(LOWER(title) LIKE ? OR LOWER(IFNULL(description, "")) LIKE ?)');
  const params: string[] = [];
  for (const t of terms) {
    const wrapped = `%${t}%`;
    params.push(wrapped, wrapped);
  }
  return getInboundDb()
    .prepare(
      `SELECT id, title, description, status, context, updated_at
       FROM matters
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as MatterRow[];
}

export function getArtifactsForMatter(matterId: number): MatterArtifactRow[] {
  return getInboundDb()
    .prepare(
      'SELECT matter_id, artifact_type, artifact_id, linked_at FROM matter_artifacts WHERE matter_id = ? ORDER BY linked_at ASC',
    )
    .all(matterId) as MatterArtifactRow[];
}

export function getLinkedArtifactIds(artifactType: string): Set<string> {
  const rows = getInboundDb()
    .prepare('SELECT artifact_id FROM matter_artifacts WHERE artifact_type = ?')
    .all(artifactType) as Array<{ artifact_id: string }>;
  return new Set(rows.map((r) => r.artifact_id));
}

export function getArtifactsForMatters(matterIds: readonly number[]): MatterArtifactRow[] {
  if (matterIds.length === 0) return [];
  const placeholders = matterIds.map(() => '?').join(',');
  return getInboundDb()
    .prepare(
      `SELECT matter_id, artifact_type, artifact_id, linked_at
         FROM matter_artifacts
         WHERE matter_id IN (${placeholders})
         ORDER BY linked_at ASC`,
    )
    .all(...matterIds) as MatterArtifactRow[];
}

const OPEN_MATTER_STATUSES: readonly MatterStatus[] = ['active', 'waiting', 'escalated'] as const;

export function listOpenMattersUpdatedSince(sinceIso: string): MatterRow[] {
  const placeholders = OPEN_MATTER_STATUSES.map(() => '?').join(',');
  return getInboundDb()
    .prepare(
      `SELECT id, title, description, status, context, updated_at
         FROM matters
         WHERE status IN (${placeholders})
           AND updated_at > ?
         ORDER BY updated_at DESC`,
    )
    .all(...OPEN_MATTER_STATUSES, sinceIso) as MatterRow[];
}
