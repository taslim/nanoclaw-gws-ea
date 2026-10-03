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
  readonly messaging_group_id: string | null;
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

/** Where routing left a message, as its settled record names it. */
export type RouteOutcome =
  | 'own'
  | 'calendar-unreadable'
  | 'calendar-not-principal'
  | 'calendar-own-change'
  | 'forged-calendar-notification'
  | 'automated'
  | 'principal-note'
  | 'copy-in'
  | 'thread'
  | 'held'
  | 'inbound'
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

export async function findThreadByGmailId(gmailThreadId: string): Promise<InboxThread | undefined> {
  const row = await getDb().get<ThreadRow>(
    'SELECT * FROM gws_ea_inbox_threads WHERE gmail_thread_id = ?',
    gmailThreadId,
  );
  return row ? toThread(row) : undefined;
}

/** The thread one of these Message-IDs belongs to, preferring the latest-known match. */
export async function findThreadByMessageIds(ids: readonly string[]): Promise<InboxThread | undefined> {
  if (ids.length === 0) return undefined;
  const row = await getDb().get<ThreadRow>(
    `SELECT t.* FROM gws_ea_inbox_thread_messages m
       JOIN gws_ea_inbox_threads t ON t.thread_key = m.thread_key
      WHERE m.rfc_message_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY m.added_at DESC, m.position DESC
      LIMIT 1`,
    ...ids,
  );
  return row ? toThread(row) : undefined;
}

export interface NewThread {
  readonly threadKey: string;
  readonly origin: ThreadOrigin;
  readonly state: ThreadState;
  readonly gmailThreadId: string | null;
  readonly subject: string;
  readonly people: ThreadPeople;
}

export async function insertThread(thread: NewThread, at: string): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_inbox_threads (
       thread_key, origin, state, gmail_thread_id, subject, people_to, people_cc, people_bcc,
       session_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    thread.threadKey,
    thread.origin,
    thread.state,
    thread.gmailThreadId,
    thread.subject,
    JSON.stringify(thread.people.to),
    JSON.stringify(thread.people.cc),
    JSON.stringify(thread.people.bcc),
    at,
    at,
  );
}

export interface ThreadUpdate {
  readonly state?: ThreadState;
  readonly gmailThreadId?: string | null;
  readonly people?: ThreadPeople;
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
    ...(update.sessionId === undefined ? {} : { session_id: update.sessionId }),
  };
  const assignments = ['updated_at = @updated_at', ...Object.keys(columns).map((column) => `${column} = @${column}`)];
  await getDb().run(`UPDATE gws_ea_inbox_threads SET ${assignments.join(', ')} WHERE thread_key = @thread_key`, {
    ...columns,
    thread_key: threadKey,
    updated_at: at,
  });
}

/** Record Message-IDs as the thread's, in order; one already known keeps its thread and place. */
export async function addThreadMessageIds(threadKey: string, ids: readonly string[], at: string): Promise<void> {
  const db = getDb();
  for (const id of ids) {
    await db.run(
      `INSERT INTO gws_ea_inbox_thread_messages (rfc_message_id, thread_key, position, added_at)
         SELECT ?, ?, COALESCE(MAX(position), 0) + 1, ? FROM gws_ea_inbox_thread_messages WHERE thread_key = ?
         ON CONFLICT (rfc_message_id) DO NOTHING`,
      id,
      threadKey,
      at,
      threadKey,
    );
  }
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

export async function holdMessage(
  gmailMessageId: string,
  threadKey: string,
  sender: string | undefined,
  at: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_inbox_held (gmail_message_id, thread_key, sender, held_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (gmail_message_id) DO NOTHING`,
    gmailMessageId,
    threadKey,
    sender ?? null,
    at,
  );
}

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

/** Open threads that still hold mail: a release the poll finishes. */
export async function openThreadsWithHeldMail(): Promise<string[]> {
  const rows = await getDb().all<{ thread_key: string }>(
    `SELECT DISTINCT h.thread_key FROM gws_ea_inbox_held h
       JOIN gws_ea_inbox_threads t ON t.thread_key = h.thread_key
      WHERE t.state = 'open'`,
  );
  return rows.map((row) => row.thread_key);
}

// ---------------------------------------------------------------------------
// The principal's messages
// ---------------------------------------------------------------------------

/** A message Gmail verified as the principal's: what a reply to them alone needs. */
export interface PrincipalMessage {
  readonly gmailMessageId: string;
  /** The principal's address that wrote it, as Gmail verified it. */
  readonly address: string;
  readonly gmailThreadId: string;
  readonly rfcMessageId: string | null;
  /** The message's own References, oldest first. */
  readonly referenceIds: readonly string[];
  readonly subject: string;
  readonly receivedAt: string;
}

interface PrincipalMessageRow {
  gmail_message_id: string;
  address: string;
  gmail_thread_id: string;
  rfc_message_id: string | null;
  reference_ids: string;
  subject: string;
  received_at: string;
}

/** Record a message as the principal's; recording it again changes nothing. */
export async function recordPrincipalMessage(message: PrincipalMessage): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_inbox_principal_messages
       (gmail_message_id, address, gmail_thread_id, rfc_message_id, reference_ids, subject, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (gmail_message_id) DO NOTHING`,
    message.gmailMessageId,
    message.address,
    message.gmailThreadId,
    message.rfcMessageId,
    JSON.stringify(message.referenceIds),
    message.subject,
    message.receivedAt,
  );
}

export async function getPrincipalMessage(gmailMessageId: string): Promise<PrincipalMessage | undefined> {
  const row = await getDb().get<PrincipalMessageRow>(
    'SELECT * FROM gws_ea_inbox_principal_messages WHERE gmail_message_id = ?',
    gmailMessageId,
  );
  return row
    ? {
        gmailMessageId: row.gmail_message_id,
        address: row.address,
        gmailThreadId: row.gmail_thread_id,
        rfcMessageId: row.rfc_message_id,
        referenceIds: stringList(row.reference_ids),
        subject: row.subject,
        receivedAt: row.received_at,
      }
    : undefined;
}

/** Forget the principal's messages received before `before`, and the replies in flight to them. */
export async function prunePrincipalMessages(before: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    await db.run(
      `DELETE FROM gws_ea_inbox_sends WHERE principal_message_id IN
         (SELECT gmail_message_id FROM gws_ea_inbox_principal_messages WHERE received_at < ?)`,
      before,
    );
    await db.run('DELETE FROM gws_ea_inbox_principal_messages WHERE received_at < ?', before);
  });
}

// ---------------------------------------------------------------------------
// Sends in flight
// ---------------------------------------------------------------------------

/** What a send answers: a reply in an inbox thread, or a reply to one of the principal's messages. */
export type SendScope = { readonly threadKey: string } | { readonly principalMessageId: string };

export interface SendRecord {
  readonly id: string;
  readonly scope: SendScope;
  readonly contentHash: string;
  readonly rfcMessageId: string;
  readonly state: 'pending' | 'sent';
  readonly gmailMessageId: string | null;
}

interface SendRow {
  id: string;
  thread_key: string | null;
  principal_message_id: string | null;
  content_hash: string;
  rfc_message_id: string;
  state: 'pending' | 'sent';
  gmail_message_id: string | null;
}

function scopeColumn(scope: SendScope): { readonly column: string; readonly value: string } {
  return 'threadKey' in scope
    ? { column: 'thread_key', value: scope.threadKey }
    : { column: 'principal_message_id', value: scope.principalMessageId };
}

/** The oldest in-flight send of this content in this scope. */
export async function findSend(scope: SendScope, contentHash: string): Promise<SendRecord | undefined> {
  const { column, value } = scopeColumn(scope);
  const row = await getDb().get<SendRow>(
    `SELECT id, thread_key, principal_message_id, content_hash, rfc_message_id, state, gmail_message_id
       FROM gws_ea_inbox_sends WHERE ${column} = ? AND content_hash = ?
      ORDER BY created_at, id LIMIT 1`,
    value,
    contentHash,
  );
  return row
    ? {
        id: row.id,
        scope,
        contentHash: row.content_hash,
        rfcMessageId: row.rfc_message_id,
        state: row.state,
        gmailMessageId: row.gmail_message_id,
      }
    : undefined;
}

/**
 * A pending send, written before Gmail is called. A reply in a thread records
 * its Message-ID as the thread's in the same transaction.
 */
export async function insertPendingSend(
  record: Omit<SendRecord, 'state' | 'gmailMessageId'>,
  at: string,
): Promise<void> {
  const db = getDb();
  const threadKey = 'threadKey' in record.scope ? record.scope.threadKey : null;
  const principalMessageId = 'principalMessageId' in record.scope ? record.scope.principalMessageId : null;
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO gws_ea_inbox_sends (
         id, thread_key, principal_message_id, content_hash, rfc_message_id, state, gmail_message_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      record.id,
      threadKey,
      principalMessageId,
      record.contentHash,
      record.rfcMessageId,
      at,
      at,
    );
    if (threadKey !== null) await addThreadMessageIds(threadKey, [record.rfcMessageId], at);
  });
}

export async function markSendSent(id: string, gmailMessageId: string, at: string): Promise<void> {
  await getDb().run(
    "UPDATE gws_ea_inbox_sends SET state = 'sent', gmail_message_id = ?, updated_at = ? WHERE id = ?",
    gmailMessageId,
    at,
    id,
  );
}

/** A thread reply's records once delivery recorded or gave up on it. */
export async function deleteSends(threadKey: string, contentHash: string, state: 'pending' | 'sent'): Promise<void> {
  await getDb().run(
    'DELETE FROM gws_ea_inbox_sends WHERE thread_key = ? AND content_hash = ? AND state = ?',
    threadKey,
    contentHash,
    state,
  );
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

// ---------------------------------------------------------------------------
// Pinned DKIM selectors
// ---------------------------------------------------------------------------

export interface PinnedSelector {
  readonly domain: string;
  readonly selector: string;
  readonly pinned_at: string;
}

export async function listPinnedSelectors(): Promise<PinnedSelector[]> {
  return getDb().all<PinnedSelector>(
    'SELECT domain, selector, pinned_at FROM gws_ea_inbox_dkim_selectors ORDER BY domain, selector',
  );
}

export async function pinSelector(domain: string, selector: string, at: string): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO gws_ea_inbox_dkim_selectors (domain, selector, pinned_at) VALUES (?, ?, ?)
       ON CONFLICT (domain, selector) DO NOTHING`,
    domain,
    selector,
    at,
  );
  return result.changes > 0;
}

export async function unpinSelector(domain: string, selector: string): Promise<boolean> {
  const result = await getDb().run(
    'DELETE FROM gws_ea_inbox_dkim_selectors WHERE domain = ? AND selector = ?',
    domain,
    selector,
  );
  return result.changes > 0;
}
