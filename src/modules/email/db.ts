import { getDb } from '../../db/connection.js';

const LAST_HISTORY_ID = 'last_history_id';

export function getLastHistoryId(): string | null {
  const row = getDb().prepare('SELECT value FROM email_state WHERE key = ?').get(LAST_HISTORY_ID) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setLastHistoryId(historyId: string): void {
  getDb()
    .prepare(
      `INSERT INTO email_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(LAST_HISTORY_ID, historyId);
}

export interface DeferredRow {
  message_id: string;
  thread_id: string;
  due_at: string;
}

export function getDueDeferred(now: string): DeferredRow[] {
  return getDb()
    .prepare('SELECT message_id, thread_id, due_at FROM email_deferred WHERE due_at <= ? ORDER BY due_at')
    .all(now) as DeferredRow[];
}

export function deleteDeferred(messageId: string): void {
  getDb().prepare('DELETE FROM email_deferred WHERE message_id = ?').run(messageId);
}

/** Drop all pending defers on a thread. Used when principal activity cancels a queued external reply. */
export function clearDeferredOnThread(threadId: string): number {
  return getDb().prepare('DELETE FROM email_deferred WHERE thread_id = ?').run(threadId).changes;
}

/**
 * Upsert a thread's pending defer, keeping the original due_at when a row
 * already exists for the thread. The pointer (`message_id`) advances to the
 * latest message so the drain refetches fresh thread state, but the clock
 * stays anchored to the first message — bounded latency, no starvation
 * under repeated follow-ups.
 *
 * Returns the effective `due_at` and whether an earlier message was
 * superseded so the caller can log it.
 */
export function upsertDeferredOnThread(args: { message_id: string; thread_id: string; fallback_due_at: string }): {
  due_at: string;
  superseded: boolean;
} {
  const db = getDb();
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT message_id, due_at FROM email_deferred WHERE thread_id = ? LIMIT 1')
      .get(args.thread_id) as { message_id: string; due_at: string } | undefined;

    if (existing?.message_id === args.message_id) {
      return { due_at: existing.due_at, superseded: false };
    }
    if (existing) {
      db.prepare('DELETE FROM email_deferred WHERE thread_id = ?').run(args.thread_id);
      db.prepare(
        `INSERT INTO email_deferred (message_id, thread_id, due_at, payload)
         VALUES (?, ?, ?, '')`,
      ).run(args.message_id, args.thread_id, existing.due_at);
      return { due_at: existing.due_at, superseded: true };
    }
    db.prepare(
      `INSERT INTO email_deferred (message_id, thread_id, due_at, payload)
       VALUES (?, ?, ?, '')`,
    ).run(args.message_id, args.thread_id, args.fallback_due_at);
    return { due_at: args.fallback_due_at, superseded: false };
  })();
}
