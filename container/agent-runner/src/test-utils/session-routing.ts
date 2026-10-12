import { getInboundDb } from '../mailbox/sqlite/connection.js';

/**
 * Bind the test session as the host's `writeSessionRouting` does on every
 * wake: a conversation's chat route, or a task session's `system:tasks:<id>`
 * thread with no route.
 */
export function seedSessionRouting(
  channelType: string | null,
  platformId: string | null,
  threadId: string | null,
): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(channelType, platformId, threadId);
}
