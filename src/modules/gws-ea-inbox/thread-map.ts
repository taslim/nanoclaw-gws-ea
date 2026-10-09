/**
 * The thread map (KTD2): every email thread the assistant is part of, by a
 * stable key in the `mail-…` format that exists before Gmail has a thread.
 * Its tables are described in migration.ts.
 *
 * - A thread maps to its Gmail thread once there is one: the thread of the
 *   message that opened it, or of the first send in a thread `main` handed
 *   over (`createThread`, `attachGmailThread`, `recordSent`).
 * - A message belongs to the thread of its Gmail thread, else to the thread
 *   of the nearest Message-ID it answers, so a reply under a changed subject,
 *   which Gmail files as a new thread, stays in its thread (`findThreadFor`).
 * - Each message is recorded with its side: `principal` when only the
 *   principal and the assistant can read it, `outside` otherwise. A side
 *   replies against, and references, only its own messages, so a
 *   principal-only note never reaches a reply-all, and a reply-all never
 *   loses the outsiders to a note written after it (`threadMessages`,
 *   `visibleMessageIds`).
 * - A thread's addresses are those its messages carried and those `main`
 *   named (`recordThreadAddresses`). A forgotten person's go from every
 *   thread (`deleteThreadAddresses`).
 * - A file goes out in a thread only when `main` handed it over for it, by
 *   its SHA-256 (`recordThreadFile`, `findThreadFile`).
 * - A send never happens twice. Before Gmail is called, a pending record
 *   holds its pre-allocated Message-ID, so a retry of the same send on the
 *   same side finds it, and a reply to it already resolves. Once Gmail holds
 *   it, `recordSent` makes it the thread's message. Delivery deletes a
 *   reply's record once it recorded the send or gave up on it, so the same
 *   words sent later are a new send; an `email_send` request's record stays,
 *   so a replay of that request never sends again.
 *
 * Every timestamp is passed in as an ISO string; SQL never reads the clock.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { normalizeAddress } from './mime.js';

/** Who can read a message: only the principal and the assistant, or someone besides. */
export type ThreadSide = 'principal' | 'outside';

export interface Thread {
  readonly threadKey: string;
  /** Null until the thread has a message in Gmail. */
  readonly gmailThreadId: string | null;
  readonly createdAt: string;
}

interface ThreadRow {
  thread_key: string;
  gmail_thread_id: string | null;
  created_at: string;
}

const THREAD_COLUMNS = 'thread_key, gmail_thread_id, created_at';

function toThread(row: ThreadRow): Thread {
  return { threadKey: row.thread_key, gmailThreadId: row.gmail_thread_id, createdAt: row.created_at };
}

/**
 * A new thread: for a message that starts one, or one `main` hands over
 * before Gmail has it. A handoff gives the key it derived from its request,
 * so a replay of the request finds the thread it began.
 */
export async function createThread(
  gmailThreadId: string | null,
  at: string,
  threadKey = `mail-${randomUUID()}`,
): Promise<Thread> {
  const thread: Thread = { threadKey, gmailThreadId, createdAt: at };
  await getDb().run(
    'INSERT INTO gws_ea_threads (thread_key, gmail_thread_id, created_at) VALUES (?, ?, ?)',
    thread.threadKey,
    gmailThreadId,
    at,
  );
  return thread;
}

export async function getThread(threadKey: string): Promise<Thread | undefined> {
  const row = await getDb().get<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM gws_ea_threads WHERE thread_key = ?`,
    threadKey,
  );
  return row ? toThread(row) : undefined;
}

/**
 * Give the thread this Gmail thread, unless it already has one or another
 * thread holds it. True when this call gave it.
 */
export async function attachGmailThread(threadKey: string, gmailThreadId: string): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE gws_ea_threads SET gmail_thread_id = ?
      WHERE thread_key = ? AND gmail_thread_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM gws_ea_threads WHERE gmail_thread_id = ?)`,
    gmailThreadId,
    threadKey,
    gmailThreadId,
  );
  return changes > 0;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** What a message says of its thread: its Gmail thread, and the Message-IDs it answers. */
export interface MessageThreading {
  readonly gmailThreadId: string;
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
}

/** The most Message-IDs a message is matched by, nearest first: a header may name any number. */
const MAX_ANSWERED_IDS = 100;

/**
 * The thread a message belongs to: the one holding its Gmail thread, else the
 * one holding the nearest Message-ID it answers (In-Reply-To, then References
 * from the newest back), whether a message the thread recorded or a send of
 * its still in flight.
 */
export async function findThreadFor(message: MessageThreading): Promise<Thread | undefined> {
  const db = getDb();
  const byGmailThread = await db.get<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM gws_ea_threads WHERE gmail_thread_id = ?`,
    message.gmailThreadId,
  );
  if (byGmailThread) return toThread(byGmailThread);
  const answered = [...new Set([...message.inReplyTo, ...[...message.references].reverse()])].slice(
    0,
    MAX_ANSWERED_IDS,
  );
  if (answered.length === 0) return undefined;
  const list = answered.map(() => '?').join(', ');
  const rows = await db.all<{ rfc_message_id: string; thread_key: string }>(
    `SELECT rfc_message_id, thread_key FROM gws_ea_thread_messages WHERE rfc_message_id IN (${list})
     UNION
     SELECT rfc_message_id, thread_key FROM gws_ea_thread_sends WHERE rfc_message_id IN (${list})`,
    ...answered,
    ...answered,
  );
  const owners = new Map(rows.map((row) => [row.rfc_message_id, row.thread_key]));
  const threadKey = answered.map((id) => owners.get(id)).find((key) => key !== undefined);
  return threadKey === undefined ? undefined : getThread(threadKey);
}

export interface ThreadMessage {
  readonly threadKey: string;
  readonly side: ThreadSide;
  /** Null for a message known only by its Message-ID. */
  readonly gmailMessageId: string | null;
  readonly rfcMessageId: string | null;
}

interface MessageRow {
  thread_key: string;
  side: ThreadSide;
  gmail_message_id: string | null;
  rfc_message_id: string | null;
}

const MESSAGE_COLUMNS = 'thread_key, side, gmail_message_id, rfc_message_id';

function toMessage(row: MessageRow): ThreadMessage {
  return {
    threadKey: row.thread_key,
    side: row.side,
    gmailMessageId: row.gmail_message_id,
    rfcMessageId: row.rfc_message_id,
  };
}

/** A message a side's session received or sent, to record as the thread's. */
export interface NewThreadMessage {
  readonly threadKey: string;
  readonly side: ThreadSide;
  readonly gmailMessageId: string;
  /** Its Message-ID, when it has one. */
  readonly rfcMessageId?: string;
}

/**
 * Record a message as the thread's, after every message it learned of
 * before. A message already recorded keeps its thread, side, and place.
 */
export async function recordThreadMessage(message: NewThreadMessage, at: string): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_thread_messages (thread_key, position, side, gmail_message_id, rfc_message_id, recorded_at)
       SELECT ?, COALESCE(MAX(position), 0) + 1, ?, ?, ?, ? FROM gws_ea_thread_messages WHERE thread_key = ?
       ON CONFLICT (gmail_message_id) DO NOTHING`,
    message.threadKey,
    message.side,
    message.gmailMessageId,
    message.rfcMessageId ?? null,
    at,
    message.threadKey,
  );
}

/** A side's messages in the thread, oldest first. */
export async function threadMessages(threadKey: string, side: ThreadSide): Promise<ThreadMessage[]> {
  const rows = await getDb().all<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM gws_ea_thread_messages WHERE thread_key = ? AND side = ? ORDER BY position`,
    threadKey,
    side,
  );
  return rows.map(toMessage);
}

/** The Message-IDs of a side's messages in the thread, oldest first: all a reply on that side may reference. */
export async function visibleMessageIds(threadKey: string, side: ThreadSide): Promise<string[]> {
  const rows = await getDb().all<{ rfc_message_id: string }>(
    `SELECT rfc_message_id FROM gws_ea_thread_messages
      WHERE thread_key = ? AND side = ? AND rfc_message_id IS NOT NULL ORDER BY position`,
    threadKey,
    side,
  );
  return [...new Set(rows.map((row) => row.rfc_message_id))];
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * How a thread came to have an address: a message carried it, an outside
 * sender wrote it in their own words, or `main` named it.
 */
export type AddressSource = 'message' | 'written' | 'main';

export interface ThreadAddress {
  readonly address: string;
  readonly source: AddressSource;
}

/**
 * Record addresses as the thread's, as they came; one already recorded that
 * way keeps its record. Throws for anything that is not an address.
 */
export async function recordThreadAddresses(
  threadKey: string,
  addresses: readonly string[],
  source: AddressSource,
  at: string,
): Promise<void> {
  const normalized = addresses.map((value) => {
    const address = normalizeAddress(value);
    if (address === undefined) throw new Error(`Not an email address: ${JSON.stringify(value)}`);
    return address;
  });
  const db = getDb();
  await db.transaction(async () => {
    for (const address of new Set(normalized)) {
      await db.run(
        `INSERT INTO gws_ea_thread_addresses (thread_key, address, source, recorded_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (thread_key, address, source) DO NOTHING`,
        threadKey,
        address,
        source,
        at,
      );
    }
  });
}

/** Every address the thread has, in the order it gained them, each with how it came. */
export async function threadAddresses(threadKey: string): Promise<ThreadAddress[]> {
  return getDb().all<ThreadAddress>(
    `SELECT address, source FROM gws_ea_thread_addresses
      WHERE thread_key = ? ORDER BY recorded_at, address, source`,
    threadKey,
  );
}

/**
 * The threads an address `matches` is on, and those addresses, each once:
 * what forgetting a person reaches.
 */
export async function threadsWithAddresses(
  matches: (address: string) => boolean,
): Promise<{ readonly threadKeys: readonly string[]; readonly addresses: readonly string[] }> {
  const rows = await getDb().all<{ thread_key: string; address: string }>(
    'SELECT DISTINCT thread_key, address FROM gws_ea_thread_addresses ORDER BY thread_key, address',
  );
  const found = rows.filter((row) => matches(row.address));
  return {
    threadKeys: [...new Set(found.map((row) => row.thread_key))],
    addresses: [...new Set(found.map((row) => row.address))],
  };
}

/** Delete these addresses from every thread, however each came. */
export async function deleteThreadAddresses(addresses: readonly string[]): Promise<void> {
  const db = getDb();
  for (const address of addresses) await db.run('DELETE FROM gws_ea_thread_addresses WHERE address = ?', address);
}

// ---------------------------------------------------------------------------
// Handed files
// ---------------------------------------------------------------------------

/** A file `main` handed over for a thread: its name, and where the host keeps its copy. */
export interface ThreadFile {
  readonly fileName: string;
  readonly hostPath: string;
}

/**
 * Record a file `main` handed over for the thread, by its SHA-256. The same
 * bytes handed over again point the record at the newer copy.
 */
export async function recordThreadFile(
  threadKey: string,
  file: ThreadFile & { readonly sha256: string },
  at: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_thread_files (thread_key, sha256, file_name, host_path, handed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (thread_key, sha256)
       DO UPDATE SET file_name = excluded.file_name, host_path = excluded.host_path, handed_at = excluded.handed_at`,
    threadKey,
    file.sha256,
    file.fileName,
    file.hostPath,
    at,
  );
}

/** The file with this SHA-256 that `main` handed over for the thread, or undefined. */
export async function findThreadFile(threadKey: string, sha256: string): Promise<ThreadFile | undefined> {
  const row = await getDb().get<{ file_name: string; host_path: string }>(
    'SELECT file_name, host_path FROM gws_ea_thread_files WHERE thread_key = ? AND sha256 = ?',
    threadKey,
    sha256,
  );
  return row ? { fileName: row.file_name, hostPath: row.host_path } : undefined;
}

// ---------------------------------------------------------------------------
// Sends in flight
// ---------------------------------------------------------------------------

/** Whose sends a record belongs to: its thread, and the side the send writes to. */
export interface SendScope {
  readonly threadKey: string;
  readonly side: ThreadSide;
}

/** A send about to be made, with the Message-ID allocated for it. */
export interface NewSend {
  readonly id: string;
  readonly scope: SendScope;
  readonly contentHash: string;
  readonly rfcMessageId: string;
}

/** A send in flight: pending until Gmail holds it, then sent, with Gmail's id for it. */
export type SendRecord = NewSend &
  (
    | { readonly state: 'pending'; readonly gmailMessageId: null }
    | { readonly state: 'sent'; readonly gmailMessageId: string }
  );

/** What Gmail holds for a send. */
export interface SentMessage {
  readonly gmailMessageId: string;
  readonly gmailThreadId: string;
  /** The Message-ID as Gmail holds it: read back from Gmail, or else the one allocated. */
  readonly rfcMessageId: string;
}

interface SendRow {
  id: string;
  content_hash: string;
  rfc_message_id: string;
  gmail_message_id: string | null;
}

/** The oldest in-flight send of these words in this scope. */
export async function findSend(scope: SendScope, contentHash: string): Promise<SendRecord | undefined> {
  const row = await getDb().get<SendRow>(
    `SELECT id, content_hash, rfc_message_id, gmail_message_id FROM gws_ea_thread_sends
      WHERE thread_key = ? AND side = ? AND content_hash = ?
      ORDER BY created_at, id LIMIT 1`,
    scope.threadKey,
    scope.side,
    contentHash,
  );
  if (!row) return undefined;
  const send: NewSend = { id: row.id, scope, contentHash: row.content_hash, rfcMessageId: row.rfc_message_id };
  // The table ties a Gmail id to `sent`, and its absence to `pending`.
  return row.gmail_message_id === null
    ? { ...send, state: 'pending', gmailMessageId: null }
    : { ...send, state: 'sent', gmailMessageId: row.gmail_message_id };
}

/** A pending send, written before Gmail is called. */
export async function insertPendingSend(send: NewSend, at: string): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_thread_sends (
       id, thread_key, side, content_hash, rfc_message_id, state, gmail_message_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    send.id,
    send.scope.threadKey,
    send.scope.side,
    send.contentHash,
    send.rfcMessageId,
    at,
    at,
  );
}

/**
 * Gmail holds the send: record it as sent, its message as the thread's on its
 * side, and its Gmail thread as the thread's when the thread has none yet.
 * Safe to repeat.
 */
export async function recordSent(send: Pick<NewSend, 'id' | 'scope'>, sent: SentMessage, at: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    await db.run(
      "UPDATE gws_ea_thread_sends SET state = 'sent', gmail_message_id = ?, updated_at = ? WHERE id = ?",
      sent.gmailMessageId,
      at,
      send.id,
    );
    await recordThreadMessage(
      {
        threadKey: send.scope.threadKey,
        side: send.scope.side,
        gmailMessageId: sent.gmailMessageId,
        rfcMessageId: sent.rfcMessageId,
      },
      at,
    );
    await attachGmailThread(send.scope.threadKey, sent.gmailThreadId);
  });
}

/** Forget a send of these words once delivery recorded it (`sent`) or gave up on it (`pending`). */
export async function deleteSends(scope: SendScope, contentHash: string, state: SendRecord['state']): Promise<void> {
  await getDb().run(
    'DELETE FROM gws_ea_thread_sends WHERE thread_key = ? AND side = ? AND content_hash = ? AND state = ?',
    scope.threadKey,
    scope.side,
    contentHash,
    state,
  );
}
