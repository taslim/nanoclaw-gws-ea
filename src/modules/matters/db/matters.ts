/**
 * Central matters DB helpers.
 *
 * ⚠️  PROJECTION INVARIANT — READ BEFORE ADDING NEW CALL SITES.
 *
 * Containers read matters from a per-session projection in `inbound.db`,
 * not the central DB. The host writes the projection via
 * `writeMatters(agentGroupId, sessionId)` on every container wake.
 * Mid-session mutations do NOT propagate automatically — the running
 * container keeps serving the stale projection until its next wake.
 *
 * If you mutate a matter from code that runs while a container may be
 * alive AND the calling agent expects to see its own change immediately,
 * call `writeMatters(agentGroupId, sessionId)` after this returns.
 * The system-action handlers in `src/modules/matters/actions.ts` already do
 * this for the caller's session.
 */
import type { Matter, MatterArtifact, MatterStatus } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

export interface CreateMatterInput {
  title: string;
  description: string | null;
  status?: MatterStatus;
}

export function createMatter(input: CreateMatterInput): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `INSERT INTO matters (title, description, status, updated_at)
       VALUES (@title, @description, @status, @updated_at)`,
    )
    .run({
      title: input.title,
      description: input.description,
      status: input.status ?? 'active',
      updated_at: now,
    });
  return Number(result.lastInsertRowid);
}

export interface UpdateMatterInput {
  title?: string;
  description?: string | null;
  status?: MatterStatus;
}

export function updateMatter(id: number, patch: UpdateMatterInput): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.title !== undefined) {
    sets.push('title = @title');
    params.title = patch.title;
  }
  if (patch.description !== undefined) {
    sets.push('description = @description');
    params.description = patch.description;
  }
  if (patch.status !== undefined) {
    sets.push('status = @status');
    params.status = patch.status;
  }
  if (sets.length === 0) throw new Error('updateMatter: no fields to update');
  sets.push('updated_at = @updated_at');
  params.updated_at = new Date().toISOString();
  getDb()
    .prepare(`UPDATE matters SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);
}

export function touchMatter(id: number): void {
  getDb().prepare('UPDATE matters SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function getMatter(id: number): Matter | undefined {
  return getDb().prepare('SELECT * FROM matters WHERE id = ?').get(id) as Matter | undefined;
}

export function getAllMatters(): Matter[] {
  return getDb().prepare('SELECT * FROM matters ORDER BY updated_at DESC').all() as Matter[];
}

/**
 * Detect-or-link in a single transaction. Returns the row already attached
 * if one exists, undefined if a fresh link was inserted. Resolves the
 * concurrent-link race a two-step lookup-then-INSERT would have left open.
 */
export function linkArtifactIfFree(matterId: number, artifactType: string, artifactId: string): Matter | undefined {
  const db = getDb();
  let existing: Matter | undefined;
  db.transaction(() => {
    existing = db
      .prepare(
        `SELECT m.* FROM matters m
         JOIN matter_artifacts a ON a.matter_id = m.id
         WHERE a.artifact_type = ? AND a.artifact_id = ?`,
      )
      .get(artifactType, artifactId) as Matter | undefined;
    if (existing) return;
    db.prepare(
      `INSERT INTO matter_artifacts (matter_id, artifact_type, artifact_id, linked_at)
       VALUES (?, ?, ?, ?)`,
    ).run(matterId, artifactType, artifactId, new Date().toISOString());
  })();
  return existing;
}

export function getAllArtifacts(): MatterArtifact[] {
  return getDb().prepare('SELECT * FROM matter_artifacts').all() as MatterArtifact[];
}
