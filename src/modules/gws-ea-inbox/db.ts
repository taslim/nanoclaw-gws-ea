/**
 * The inbox's tables (see migration.ts). Every timestamp is passed in as an
 * ISO string; SQL never reads the clock.
 */
import { getDb } from '../../db/connection.js';

export type ThreadState = 'awaiting-arrange' | 'authorized' | 'open' | 'closed';
/**
 * How a thread began: `arrange` and `ask_organizer` opened it; the principal
 * copied the assistant in (`copy-in`); or someone else wrote (`inbound`). The
 * last two are held for `main` until it takes them over.
 */
export type ThreadOrigin = 'arrange' | 'ask_organizer' | 'copy-in' | 'inbound';

/** Who a thread's next reply goes to, each placed in To, Cc, or Bcc; every address appears once. */
export interface ThreadPeople {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

/** A thread as stored, its address lists parsed. */
export interface InboxThread {
  readonly threadKey: string;
  readonly origin: ThreadOrigin;
  readonly state: ThreadState;
  readonly gmailThreadId: string | null;
  readonly subject: string;
  /** Its people: those on its latest message, as `main` added or `external-email` arranged them since. */
  readonly people: ThreadPeople;
  /**
   * Everyone the principal, a sender Gmail verified, or `main` put on the
   * thread, whether or not they are on it now. Only for these does a record's
   * level and name apply: an unverified email can name anyone (R21).
   */
  readonly vouched: readonly string[];
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ThreadRow {
  thread_key: string;
  origin: ThreadOrigin;
  state: ThreadState;
  gmail_thread_id: string | null;
  subject: string;
  people_to: string;
  people_cc: string;
  people_bcc: string;
  vouched_people: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A JSON list of strings, as the inbox stores addresses and Message-IDs. */
function stringList(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
    throw new Error('An inbox row holds a malformed list');
  }
  return parsed;
}

function toThread(row: ThreadRow): InboxThread {
  return {
    threadKey: row.thread_key,
    origin: row.origin,
    state: row.state,
    gmailThreadId: row.gmail_thread_id,
    subject: row.subject,
    people: { to: stringList(row.people_to), cc: stringList(row.people_cc), bcc: stringList(row.people_bcc) },
    vouched: stringList(row.vouched_people),
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Unique, in first-seen order. */
export function uniqueAddresses(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

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
  | 'automated'
  | 'principal'
  | 'outside'
  | 'rate-limited'
  | 'gone'
  | 'not-in-inbox'
  | 'calendar-note'
  | 'set-aside';

/**
 * Record where a message was routed. Its routing attempts end here, so the
 * count starts over for held mail's release (`MAX_RELEASE_ATTEMPTS`).
 */
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

/** Count one failed attempt to route a message, or to release it once held; returns the attempts so far. */
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
// Threads
// ---------------------------------------------------------------------------

export async function getThread(threadKey: string): Promise<InboxThread | undefined> {
  const row = await getDb().get<ThreadRow>('SELECT * FROM gws_ea_inbox_threads WHERE thread_key = ?', threadKey);
  return row ? toThread(row) : undefined;
}

export interface NewThread {
  readonly threadKey: string;
  readonly origin: ThreadOrigin;
  readonly state: ThreadState;
  readonly gmailThreadId: string | null;
  readonly subject: string;
  readonly people: ThreadPeople;
  readonly vouched: readonly string[];
}

export async function insertThread(thread: NewThread, at: string): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_inbox_threads (
       thread_key, origin, state, gmail_thread_id, subject, people_to, people_cc, people_bcc,
       vouched_people, session_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    thread.threadKey,
    thread.origin,
    thread.state,
    thread.gmailThreadId,
    thread.subject,
    JSON.stringify(thread.people.to),
    JSON.stringify(thread.people.cc),
    JSON.stringify(thread.people.bcc),
    JSON.stringify(thread.vouched),
    at,
    at,
  );
}

export interface ThreadUpdate {
  readonly state?: ThreadState;
  readonly gmailThreadId?: string | null;
  readonly people?: ThreadPeople;
  readonly vouched?: readonly string[];
  readonly sessionId?: string;
}

export async function updateThread(threadKey: string, update: ThreadUpdate, at: string): Promise<void> {
  const columns: Record<string, unknown> = {
    ...(update.state === undefined ? {} : { state: update.state }),
    ...(update.gmailThreadId === undefined ? {} : { gmail_thread_id: update.gmailThreadId }),
    ...(update.people === undefined
      ? {}
      : {
          people_to: JSON.stringify(update.people.to),
          people_cc: JSON.stringify(update.people.cc),
          people_bcc: JSON.stringify(update.people.bcc),
        }),
    ...(update.vouched === undefined ? {} : { vouched_people: JSON.stringify(update.vouched) }),
    ...(update.sessionId === undefined ? {} : { session_id: update.sessionId }),
  };
  const assignments = ['updated_at = @updated_at', ...Object.keys(columns).map((column) => `${column} = @${column}`)];
  await getDb().run(`UPDATE gws_ea_inbox_threads SET ${assignments.join(', ')} WHERE thread_key = @thread_key`, {
    ...columns,
    thread_key: threadKey,
    updated_at: at,
  });
}

export async function threadMessageIds(threadKey: string): Promise<string[]> {
  const rows = await getDb().all<{ rfc_message_id: string }>(
    'SELECT rfc_message_id FROM gws_ea_inbox_thread_messages WHERE thread_key = ? ORDER BY position',
    threadKey,
  );
  return rows.map((row) => row.rfc_message_id);
}

// ---------------------------------------------------------------------------
// Held mail
// ---------------------------------------------------------------------------

export async function heldMessages(threadKey: string): Promise<string[]> {
  const rows = await getDb().all<{ gmail_message_id: string }>(
    'SELECT gmail_message_id FROM gws_ea_inbox_held WHERE thread_key = ? ORDER BY held_at, gmail_message_id',
    threadKey,
  );
  return rows.map((row) => row.gmail_message_id);
}

export async function dropHeldMessage(gmailMessageId: string): Promise<void> {
  await getDb().run('DELETE FROM gws_ea_inbox_held WHERE gmail_message_id = ?', gmailMessageId);
}

// ---------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------

/** Whether Gmail took an email the assistant sent in the thread at or after `since`: the durable record of a reply gone. */
export async function hasSentInThreadSince(threadKey: string, since: string): Promise<boolean> {
  const row = await getDb().get<{ found: number }>(
    `SELECT 1 AS found FROM gws_ea_inbox_sends
      WHERE thread_key = ? AND state = 'sent' AND created_at >= ?
      LIMIT 1`,
    threadKey,
    since,
  );
  return row !== undefined;
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
