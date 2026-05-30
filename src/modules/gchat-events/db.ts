/**
 * State for the wildcard Workspace Events subscription. One row per project.
 * Stores the subscription resource name so the host reuses it across restarts
 * (rather than creating a fresh one each boot).
 */
import { getDb } from '../../db/connection.js';

export interface SubscriptionRow {
  project_id: string;
  name: string;
  expire_time: string | null;
}

export function getSubscription(projectId: string): SubscriptionRow | undefined {
  return getDb()
    .prepare('SELECT project_id, name, expire_time FROM gchat_workspace_subscription WHERE project_id = ?')
    .get(projectId) as SubscriptionRow | undefined;
}

export function upsertSubscription(row: SubscriptionRow): void {
  getDb()
    .prepare(
      `INSERT INTO gchat_workspace_subscription (project_id, name, expire_time, updated_at)
       VALUES (@project_id, @name, @expire_time, @updated_at)
       ON CONFLICT(project_id) DO UPDATE SET
         name = excluded.name,
         expire_time = excluded.expire_time,
         updated_at = excluded.updated_at`,
    )
    .run({ ...row, updated_at: new Date().toISOString() });
}

export function deleteSubscription(projectId: string): void {
  getDb().prepare('DELETE FROM gchat_workspace_subscription WHERE project_id = ?').run(projectId);
}
