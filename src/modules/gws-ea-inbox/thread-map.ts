/**
 * The thread map: every email thread the assistant is part of, by a stable
 * key in the `mail-…` format that exists before Gmail has a thread. Its
 * tables are described in migration.ts.
 *
 * - Each message is recorded with its side: `principal` when only the
 *   principal and the assistant can read it, `outside` otherwise. A side
 *   replies against, and references, only its own messages, so a
 *   principal-only note never reaches a reply-all, and a reply-all never
 *   loses the outsiders to a note written after it.
 * - A thread is where `main` placed it: not yet, in an open matter, or
 *   nowhere, and handed over to `external-email` or not; until main hands it
 *   over, its mail waits, held. Mail starts a thread unplaced, and the
 *   matters store keeps a thread's placement in step with its matters.
 * - A file goes out in a thread only when `main` handed it over for it, by
 *   its SHA-256.
 * - A send never happens twice. Before Gmail is called, a pending record
 *   holds its pre-allocated Message-ID, so a retry of the same send on the
 *   same side finds it, and a reply to it already resolves. Delivery deletes
 *   a reply's record once it recorded the send or gave up on it, so the same
 *   words sent later are a new send; an `email_send` request's record stays,
 *   so a replay of that request never sends again.
 *
 * Every timestamp is passed in as an ISO string; SQL never reads the clock.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { AnchoredDir } from '../../anchored-dir.js';
import { DATA_DIR } from '../../config.js';
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

/** A handoff gives the key it derived from its request, so a replay of the request finds the thread it began. */
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

/** False when the thread already has a Gmail thread or another thread holds this one. */
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

export interface MessageThreading {
  readonly gmailThreadId: string;
  readonly inReplyTo: readonly string[];
  readonly references: readonly string[];
}

/** Bounds the Message-IDs a lookup reads, nearest first: a header may name any number. */
const MAX_ANSWERED_IDS = 100;

/**
 * The thread holding the message's Gmail thread, else the one holding the
 * nearest Message-ID it answers (In-Reply-To, then References from the newest
 * back), whether a message the thread recorded or a send of its still in
 * flight. Gmail files a reply under a changed subject as a new thread, which
 * the Message-IDs keep in its thread.
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

export interface NewThreadMessage {
  readonly threadKey: string;
  readonly side: ThreadSide;
  readonly gmailMessageId: string;
  readonly rfcMessageId?: string;
}

/** After every message the thread learned of before; one already recorded keeps its thread, side, and place. */
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

export async function threadsWithMessageIds(rfcMessageIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(rfcMessageIds)].slice(0, MAX_ANSWERED_IDS);
  if (ids.length === 0) return [];
  const rows = await getDb().all<{ thread_key: string }>(
    `SELECT DISTINCT thread_key FROM gws_ea_thread_messages
      WHERE rfc_message_id IN (${ids.map(() => '?').join(', ')}) ORDER BY thread_key`,
    ...ids,
  );
  return rows.map((row) => row.thread_key);
}

export async function threadMessages(threadKey: string, side: ThreadSide): Promise<ThreadMessage[]> {
  const rows = await getDb().all<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM gws_ea_thread_messages WHERE thread_key = ? AND side = ? ORDER BY position`,
    threadKey,
    side,
  );
  return rows.map(toMessage);
}

/** All a reply on that side may reference, oldest first. */
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

/** One already recorded from the same source keeps its record. Throws for anything that is not an address. */
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

export async function threadAddresses(threadKey: string): Promise<ThreadAddress[]> {
  return getDb().all<ThreadAddress>(
    `SELECT address, source FROM gws_ea_thread_addresses
      WHERE thread_key = ? ORDER BY recorded_at, address, source`,
    threadKey,
  );
}

/** Only Gmail's authenticated From verdict establishes sender identity; carrying an address does not. */
export async function recordAuthenticatedThreadSender(threadKey: string, value: string, at: string): Promise<void> {
  const address = normalizeAddress(value);
  if (address === undefined) throw new Error(`Not an email address: ${JSON.stringify(value)}`);
  await getDb().run(
    `INSERT INTO gws_ea_thread_addresses (thread_key, address, source, recorded_at, sender_authenticated)
      VALUES (?, ?, 'message', ?, 1)
      ON CONFLICT (thread_key, address, source) DO UPDATE SET sender_authenticated = 1`,
    threadKey,
    address,
    at,
  );
}

/** Identities this reader already knows, rather than every address someone copied or mentioned. */
export async function threadSchedulingPeople(threadKey: string): Promise<string[]> {
  const rows = await getDb().all<{ address: string }>(
    `SELECT DISTINCT address FROM gws_ea_thread_addresses
      WHERE thread_key = ? AND (source = 'main' OR sender_authenticated = 1) ORDER BY address`,
    threadKey,
  );
  return rows.map((row) => row.address);
}

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

export async function deleteThreadAddresses(addresses: readonly string[]): Promise<void> {
  const db = getDb();
  for (const address of addresses) await db.run('DELETE FROM gws_ea_thread_addresses WHERE address = ?', address);
}

// ---------------------------------------------------------------------------
// The account of the agent working it
// ---------------------------------------------------------------------------

/** The longest account the agent working a thread may leave: what a matter shows whole under the thread. */
export const THREAD_ACCOUNT_MAX = 2_000;

/** What the agent working a thread last said of it; `at` is ISO. */
export interface ThreadAccount {
  readonly text: string;
  readonly at: string;
}

export async function setThreadAccount(threadKey: string, text: string, at: string): Promise<void> {
  const { changes } = await getDb().run(
    'UPDATE gws_ea_threads SET account = ?, account_at = ? WHERE thread_key = ?',
    text,
    at,
    threadKey,
  );
  if (changes === 0) throw new Error(`No email thread ${threadKey} exists`);
}

export async function clearThreadAccounts(threadKeys: readonly string[]): Promise<void> {
  const db = getDb();
  for (const threadKey of new Set(threadKeys)) {
    await db.run('UPDATE gws_ea_threads SET account = NULL, account_at = NULL WHERE thread_key = ?', threadKey);
  }
}

export async function threadAccount(threadKey: string): Promise<ThreadAccount | undefined> {
  const row = await getDb().get<{ account: string; account_at: string }>(
    'SELECT account, account_at FROM gws_ea_threads WHERE thread_key = ? AND account IS NOT NULL',
    threadKey,
  );
  return row ? { text: row.account, at: row.account_at } : undefined;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Where `main` placed the thread; `nowhere` also once its matter closed. */
export type Placement = 'unplaced' | 'matter' | 'nowhere';

export interface ThreadPlacement {
  readonly placement: Placement;
  /** main handed it over: external-email reads its mail as it comes. Until then the mail waits, held. */
  readonly released: boolean;
}

/** The agent that works a thread main hands over, as the matter it sits in names it. */
export const THREAD_HANDLER = 'external-email';

export async function threadPlacement(threadKey: string): Promise<ThreadPlacement | undefined> {
  const row = await getDb().get<{ placement: Placement; released: number }>(
    'SELECT placement, released FROM gws_ea_threads WHERE thread_key = ?',
    threadKey,
  );
  return row ? { placement: row.placement, released: row.released === 1 } : undefined;
}

export async function placeThread(threadKey: string, placement: Exclude<Placement, 'unplaced'>): Promise<void> {
  await getDb().run('UPDATE gws_ea_threads SET placement = ? WHERE thread_key = ?', placement, threadKey);
}

/** Its mail is external-email's from now on. Throws unless main has placed the thread. */
export async function releaseThread(threadKey: string): Promise<void> {
  const { changes } = await getDb().run(
    "UPDATE gws_ea_threads SET released = 1 WHERE thread_key = ? AND placement <> 'unplaced'",
    threadKey,
  );
  if (changes === 0) throw new Error(`Email thread ${threadKey} does not exist or is not placed yet`);
}

/** The thread's matter closed: it sits in no matter, and its new mail waits, held, to be placed again. */
export async function holdThread(threadKey: string): Promise<void> {
  await getDb().run("UPDATE gws_ea_threads SET placement = 'nowhere', released = 0 WHERE thread_key = ?", threadKey);
}

/**
 * New mail on a thread in no matter that main has not handed over since: it
 * waits to be placed again, and no note has asked yet. False when it is not
 * such a thread, such as one main handed over meanwhile.
 */
export async function unplaceThread(threadKey: string): Promise<boolean> {
  const { changes } = await getDb().run(
    `UPDATE gws_ea_threads SET placement = 'unplaced', placement_note = NULL
      WHERE thread_key = ? AND placement = 'nowhere' AND released = 0`,
    threadKey,
  );
  return changes > 0;
}

/** Whether a note has asked main to place the thread since it last became unplaced. */
export async function placementAsked(threadKey: string): Promise<boolean> {
  const row = await getDb().get<{ placement_note: string | null }>(
    'SELECT placement_note FROM gws_ea_threads WHERE thread_key = ?',
    threadKey,
  );
  return (row?.placement_note ?? null) !== null;
}

/** `noteId` asked main to place these threads; one placed meanwhile keeps nothing of it. */
export async function recordPlacementNote(threadKeys: readonly string[], noteId: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    for (const threadKey of threadKeys) {
      await db.run(
        "UPDATE gws_ea_threads SET placement_note = ? WHERE thread_key = ? AND placement = 'unplaced'",
        noteId,
        threadKey,
      );
    }
  });
}

export interface UnplacedThread {
  readonly threadKey: string;
  readonly gmailThreadId: string | null;
  /** The addresses its mail carried. */
  readonly people: readonly string[];
  readonly latestAt: string;
  /** The note that last asked main to place it, or null while none has. */
  readonly placementNote: string | null;
}

/**
 * Unplaced threads with mail from outside, the one whose latest such mail is
 * oldest first. A thread only the principal and the assistant are on waits
 * for no placement.
 */
export async function listUnplacedThreads(): Promise<UnplacedThread[]> {
  const rows = await getDb().all<{
    thread_key: string;
    gmail_thread_id: string | null;
    placement_note: string | null;
    latest_at: string;
  }>(
    `SELECT t.thread_key, t.gmail_thread_id, t.placement_note, MAX(m.recorded_at) AS latest_at
       FROM gws_ea_threads t
       JOIN gws_ea_thread_messages m ON m.thread_key = t.thread_key AND m.side = 'outside'
      WHERE t.placement = 'unplaced'
      GROUP BY t.thread_key, t.gmail_thread_id, t.placement_note
      ORDER BY latest_at, t.thread_key`,
  );
  return Promise.all(
    rows.map(async (row) => ({
      threadKey: row.thread_key,
      gmailThreadId: row.gmail_thread_id,
      people: [
        ...new Set(
          (await threadAddresses(row.thread_key))
            .filter((entry) => entry.source === 'message')
            .map((entry) => entry.address),
        ),
      ],
      latestAt: row.latest_at,
      placementNote: row.placement_note,
    })),
  );
}

// ---------------------------------------------------------------------------
// Handed files
// ---------------------------------------------------------------------------

export interface ThreadFile {
  readonly fileName: string;
  readonly hostPath: string;
}

/**
 * The same bytes handed over again point the record at the newer copy. The
 * copy is recorded by its place in the data directory: the host reaches that
 * directory through the release folder it runs from, and a later update
 * prunes that folder, taking any path through it along.
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
    path.relative(DATA_DIR, file.hostPath),
    at,
  );
}

/** Its copy as the host reaches the data directory now. Throws for a copy recorded outside it. */
export async function findThreadFile(threadKey: string, sha256: string): Promise<ThreadFile | undefined> {
  const row = await getDb().get<{ file_name: string; host_path: string }>(
    'SELECT file_name, host_path FROM gws_ea_thread_files WHERE thread_key = ? AND sha256 = ?',
    threadKey,
    sha256,
  );
  if (!row) return undefined;
  const hostPath = path.resolve(DATA_DIR, row.host_path);
  const relative = path.relative(DATA_DIR, hostPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`The host's copy of ${row.file_name} is recorded outside the data directory`);
  }
  return { fileName: row.file_name, hostPath };
}

/**
 * The bytes of the host's copy of a handed file. The copy sits in a session
 * folder the external-email agent can write, so it is reached through each
 * directory's descriptor from the data directory down: a link planted on the
 * way is refused, never followed, and so is anything but a regular file.
 */
export function readThreadFile(file: ThreadFile): Buffer {
  const segments = path.relative(DATA_DIR, file.hostPath).split(path.sep);
  const name = segments.pop()!;
  const directory = AnchoredDir.open(DATA_DIR, segments);
  if (!directory) throw new Error(`The host's copy of ${file.fileName} is gone`);
  try {
    return directory.readFile(name);
  } finally {
    directory.close();
  }
}

// ---------------------------------------------------------------------------
// Sends in flight
// ---------------------------------------------------------------------------

export interface SendScope {
  readonly threadKey: string;
  readonly side: ThreadSide;
}

export interface NewSend {
  readonly id: string;
  readonly scope: SendScope;
  readonly contentHash: string;
  readonly rfcMessageId: string;
}

export type SendRecord = NewSend &
  (
    | { readonly state: 'pending'; readonly gmailMessageId: null }
    | { readonly state: 'sent'; readonly gmailMessageId: string }
  );

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

/** Written before Gmail is called. */
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

/** Safe to repeat. */
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
