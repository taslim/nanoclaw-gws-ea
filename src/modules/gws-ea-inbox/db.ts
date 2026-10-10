/**
 * The inbox's own tables (see migration.ts): its state, each message seen,
 * each sender's hourly count, and the principal's calendars. The thread map
 * has its own module (thread-map.ts). Every timestamp is passed in as an ISO
 * string; SQL never reads the clock.
 */
import { getDb } from '../../db/connection.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface InboxState {
  /** The inbox's messaging group (`email:inbox`), wired to `external-email`. */
  readonly messaging_group_id: string | null;
  /** The principal's own email conversation (`email:principal`), wired to `main`. */
  readonly principal_messaging_group_id: string | null;
  readonly history_id: string | null;
  readonly health: 'healthy' | 'unhealthy';
  readonly health_reason: string | null;
  readonly health_since: string | null;
  readonly consecutive_failures: number;
  readonly unhealthy_notified_at: string | null;
  readonly last_success_at: string | null;
  readonly calendar_sync: 'unknown' | 'ok' | 'failing';
  readonly calendar_sync_reason: string | null;
}

export async function getInboxState(): Promise<InboxState> {
  const row = await getDb().get<InboxState>('SELECT * FROM gws_ea_inbox_state WHERE singleton = 1');
  if (!row) throw new Error('The inbox state row is missing');
  return row;
}

/** The email channel's two messaging groups, as the host stored them; null until it creates each, or without an inbox. */
export async function emailMessagingGroupIds(): Promise<{
  readonly inbox: string | null;
  readonly principal: string | null;
}> {
  if (!(await getDb().hasTable('gws_ea_inbox_state'))) return { inbox: null, principal: null };
  const state = await getInboxState();
  return { inbox: state.messaging_group_id, principal: state.principal_messaging_group_id };
}

export async function updateInboxState(updates: Partial<InboxState>): Promise<void> {
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
  await getDb().run(
    `UPDATE gws_ea_inbox_state SET ${assignments} WHERE singleton = 1`,
    Object.fromEntries(entries.map(([key, value]) => [key, value])),
  );
}

// ---------------------------------------------------------------------------
// Messages seen
// ---------------------------------------------------------------------------

export async function isSettled(gmailMessageId: string): Promise<boolean> {
  const row = await getDb().get<{ settled_at: string | null }>(
    'SELECT settled_at FROM gws_ea_inbox_messages WHERE gmail_message_id = ?',
    gmailMessageId,
  );
  return row?.settled_at !== undefined && row.settled_at !== null;
}

/**
 * Known messages routing has not settled: each failed an attempt, or an
 * update left it to route again. Oldest first.
 */
export async function unsettledMessages(): Promise<string[]> {
  const rows = await getDb().all<{ gmail_message_id: string }>(
    `SELECT gmail_message_id FROM gws_ea_inbox_messages
      WHERE settled_at IS NULL ORDER BY first_seen_at, gmail_message_id`,
  );
  return rows.map((row) => row.gmail_message_id);
}

/** Where routing left a message, as its settled record names it. */
export type RouteOutcome =
  | 'own'
  | 'calendar-unreadable'
  | 'calendar-not-principal'
  | 'calendar-own-change'
  | 'forged-calendar-notification'
  | 'workspace-unreadable'
  | 'forged-workspace-notification'
  | 'automated'
  | 'principal'
  | 'outside'
  | 'rate-limited'
  | 'gone'
  | 'not-in-inbox'
  | 'calendar-note'
  | 'workspace-note'
  | 'set-aside';

/** Record where a message was routed. Its routing attempts end here. */
export async function settleMessage(gmailMessageId: string, outcome: RouteOutcome, at: string): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_inbox_messages (gmail_message_id, outcome, attempts, first_seen_at, settled_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT (gmail_message_id) DO UPDATE
          SET outcome = excluded.outcome, settled_at = excluded.settled_at, attempts = 0`,
    gmailMessageId,
    outcome,
    at,
    at,
  );
}

/** Count one failed attempt to route a message; returns the attempts so far. */
export async function recordFailedAttempt(gmailMessageId: string, at: string): Promise<number> {
  const db = getDb();
  await db.run(
    `INSERT INTO gws_ea_inbox_messages (gmail_message_id, outcome, attempts, first_seen_at, settled_at)
       VALUES (?, NULL, 1, ?, NULL)
       ON CONFLICT (gmail_message_id) DO UPDATE SET attempts = gws_ea_inbox_messages.attempts + 1`,
    gmailMessageId,
    at,
  );
  const row = await db.get<{ attempts: number }>(
    'SELECT attempts FROM gws_ea_inbox_messages WHERE gmail_message_id = ?',
    gmailMessageId,
  );
  return row?.attempts ?? 1;
}

export async function pruneSettledMessages(before: string): Promise<void> {
  await getDb().run('DELETE FROM gws_ea_inbox_messages WHERE settled_at IS NOT NULL AND settled_at < ?', before);
}

// ---------------------------------------------------------------------------
// Per-sender rate
// ---------------------------------------------------------------------------

/** Count one message from `sender` in the window; returns the window's count. */
export async function countSenderMessage(sender: string, windowStart: string): Promise<number> {
  const db = getDb();
  await db.run(
    `INSERT INTO gws_ea_inbox_sender_counts (sender, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (sender, window_start) DO UPDATE SET count = gws_ea_inbox_sender_counts.count + 1`,
    sender,
    windowStart,
  );
  const row = await db.get<{ count: number }>(
    'SELECT count FROM gws_ea_inbox_sender_counts WHERE sender = ? AND window_start = ?',
    sender,
    windowStart,
  );
  return row?.count ?? 1;
}

export async function pruneSenderCounts(before: string): Promise<void> {
  await getDb().run('DELETE FROM gws_ea_inbox_sender_counts WHERE window_start < ?', before);
}

// ---------------------------------------------------------------------------
// The principal's calendars
// ---------------------------------------------------------------------------

export async function listPrincipalCalendars(): Promise<string[]> {
  const rows = await getDb().all<{ calendar_id: string }>('SELECT calendar_id FROM gws_ea_inbox_calendars');
  return rows.map((row) => row.calendar_id);
}

export async function replacePrincipalCalendars(calendarIds: readonly string[], at: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    const kept = new Set(calendarIds);
    for (const existing of await listPrincipalCalendars()) {
      if (!kept.has(existing)) await db.run('DELETE FROM gws_ea_inbox_calendars WHERE calendar_id = ?', existing);
    }
    for (const id of calendarIds) {
      await db.run(
        'INSERT INTO gws_ea_inbox_calendars (calendar_id, applied_at) VALUES (?, ?) ON CONFLICT (calendar_id) DO NOTHING',
        id,
        at,
      );
    }
  });
}
