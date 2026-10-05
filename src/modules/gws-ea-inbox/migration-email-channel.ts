import type { DbDriver } from '../../db/driver.js';
import type { ModuleMigration } from '../../db/migrations/index.js';

/** A converted hold lapses this long after the update, unless its thread holds it again. */
const HOLD_LIFETIME_MS = 3 * 24 * 60 * 60_000;

/** The lists earlier releases stamped `external-email` with, as each wrote it. */
const EARLIER_EXTERNAL_EMAIL_CAPABILITIES: readonly (readonly string[])[] = [
  ['reply', 'gws-ea-meetings-external'],
  ['reply', 'request-status', 'gws-ea-meetings-external'],
  ['reply', 'time', 'request-status', 'gws-ea-meetings-external'],
];

/** The list this release stamps `external-email` with (`EXTERNAL_EMAIL_CAPABILITIES`), as this migration moves it. */
export const MOVED_EXTERNAL_EMAIL_CAPABILITIES: readonly string[] = [
  'files-read',
  'time',
  'request-status',
  'gws-ea-reminders',
  'gws-ea-email-external',
];

/** A meeting the earlier release was still working on, which a thread's calendar belongs to. */
const LIVE_MEETING_STATES = "('opening', 'active', 'booked', 'closing')";

/**
 * The email channel's records (KTD1, KTD2, KTD7, KTD9, KTD10). The inbox
 * registers this after its own store and the meetings store, so it runs once
 * every earlier inbox and meetings table exists.
 *
 * The inbox's state gains `principal_messaging_group_id`: the principal's own
 * email conversation with `main` (`email:principal`), which the wiring and
 * destination policies pin by this stored id, as they pin the inbox by
 * `messaging_group_id`.
 *
 * Every table is keyed to the thread map, under names no earlier table or
 * index uses:
 *
 * - `gws_ea_threads`: each thread's stable `mail-…` key and its Gmail thread,
 *   which a thread `main` hands over gains on its first send, and the
 *   calendar its bookings go on when `main` named one.
 * - `gws_ea_thread_messages`: each message in the thread, in the order the
 *   thread learned of it, with its side (`principal` when only the principal
 *   and the assistant can read it, `outside` otherwise), its Gmail id, and
 *   its Message-ID. A message known only by its Message-ID has no Gmail id.
 * - `gws_ea_thread_addresses`: each address the thread's messages carried,
 *   and each one `main` named, recorded once for each way it came.
 * - `gws_ea_thread_files`: each file `main` handed over for the thread, by
 *   its SHA-256, with its name and the host's staged copy.
 * - `gws_ea_thread_sends`: a send between allocating its Message-ID and
 *   delivery recording it, per thread and side, so a retry finds what Gmail
 *   may already hold.
 * - `gws_ea_thread_holds`: each hold the thread placed on the principal's
 *   calendar, with its time and when it lapses. A thread with holds recorded
 *   cannot be deleted: the record is how its event is found and released.
 * - `gws_ea_thread_bookings`: each event the thread booked, which it alone
 *   may move or cancel.
 *
 * Then it moves the earlier release's in-flight work into these records,
 * once, and drops every table of that release's threads and meetings (R77):
 *
 * 1. Each thread keeps its key, so its next message reaches the same
 *    `external-email` session; its Gmail thread; its Message-IDs, in order,
 *    each with the Gmail id of an email Gmail took for it; the people on it,
 *    as `main` named them for a thread it started and as the mail carried
 *    them for any other; and the calendar `main` named for its live meeting.
 * 2. Each hold, under the thread of its meeting (a bare thread when the inbox
 *    no longer had it), lapses three days on. Each booking a meeting made
 *    stays its thread's; a reschedule's is the principal's own event, so it
 *    is not.
 * 3. The thread's sends in flight keep their content hash, so a retry of the
 *    same words still finds what Gmail holds. A reply to the principal alone
 *    goes with that release's way of answering them.
 * 4. Mail held for a thread, and the principal's messages in a thread they
 *    copied the assistant into that `main` had not taken over, are left to
 *    route again: the poll routes a known message not yet settled first.
 * 5. `external-email`'s capabilities move to this release's list, only from
 *    a list an earlier release stamped; anything else is left for the drift
 *    check to report.
 * 6. Every count converted is checked against its source, so a row that
 *    could not be carried over throws, and the runner rolls the whole
 *    migration back.
 */
export const gwsEaInboxEmailChannelMigration: ModuleMigration = {
  version: 2,
  name: 'module:gws-ea-inbox:email-channel',
  async up(db) {
    await db.exec(`
      ALTER TABLE gws_ea_inbox_state
        ADD COLUMN principal_messaging_group_id TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL
    `);
    await createThreadTables(db);
    const at = new Date();
    const calendars = await bookingCalendars(db);
    await convertThreads(db, calendars);
    const bareThreads = await convertCalendar(db, calendars, at);
    await convertSends(db);
    await routeHeldMailAgain(db);
    await moveExternalEmailCapabilities(db, at);
    await checkCounts(db, bareThreads);
    await dropEarlierTables(db);
  },
};

async function createThreadTables(db: DbDriver): Promise<void> {
  await db.exec(`
    CREATE TABLE gws_ea_threads (
      thread_key       TEXT PRIMARY KEY CHECK (thread_key LIKE 'mail-%'),
      gmail_thread_id  TEXT UNIQUE CHECK (gmail_thread_id <> ''),
      booking_calendar_id  TEXT CHECK (booking_calendar_id <> ''),
      created_at       TEXT NOT NULL
    );

    CREATE TABLE gws_ea_thread_messages (
      thread_key        TEXT NOT NULL REFERENCES gws_ea_threads(thread_key) ON DELETE CASCADE,
      position          INTEGER NOT NULL CHECK (position > 0),
      side              TEXT NOT NULL CHECK (side IN ('principal', 'outside')),
      gmail_message_id  TEXT UNIQUE CHECK (gmail_message_id <> ''),
      rfc_message_id    TEXT CHECK (rfc_message_id <> ''),
      recorded_at       TEXT NOT NULL,
      PRIMARY KEY (thread_key, position),
      CHECK (gmail_message_id IS NOT NULL OR rfc_message_id IS NOT NULL)
    );
    CREATE INDEX idx_gws_ea_thread_messages_rfc ON gws_ea_thread_messages (rfc_message_id);

    CREATE TABLE gws_ea_thread_addresses (
      thread_key   TEXT NOT NULL REFERENCES gws_ea_threads(thread_key) ON DELETE CASCADE,
      address      TEXT NOT NULL CHECK (address <> '' AND address = lower(address)),
      source       TEXT NOT NULL CHECK (source IN ('message', 'main')),
      recorded_at  TEXT NOT NULL,
      PRIMARY KEY (thread_key, address, source)
    );

    CREATE TABLE gws_ea_thread_files (
      thread_key  TEXT NOT NULL REFERENCES gws_ea_threads(thread_key) ON DELETE CASCADE,
      sha256      TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 = lower(sha256)),
      file_name   TEXT NOT NULL CHECK (file_name <> ''),
      host_path   TEXT NOT NULL CHECK (host_path <> ''),
      handed_at   TEXT NOT NULL,
      PRIMARY KEY (thread_key, sha256)
    );

    CREATE TABLE gws_ea_thread_sends (
      id                TEXT PRIMARY KEY,
      thread_key        TEXT NOT NULL REFERENCES gws_ea_threads(thread_key) ON DELETE CASCADE,
      side              TEXT NOT NULL CHECK (side IN ('principal', 'outside')),
      content_hash      TEXT NOT NULL,
      rfc_message_id    TEXT NOT NULL UNIQUE,
      state             TEXT NOT NULL CHECK (state IN ('pending', 'sent')),
      gmail_message_id  TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      CHECK ((state = 'sent') = (gmail_message_id IS NOT NULL))
    );
    CREATE INDEX idx_gws_ea_thread_sends_content ON gws_ea_thread_sends (thread_key, side, content_hash);

    CREATE TABLE gws_ea_thread_holds (
      thread_key   TEXT NOT NULL REFERENCES gws_ea_threads(thread_key),
      calendar_id  TEXT NOT NULL CHECK (calendar_id <> ''),
      event_id     TEXT NOT NULL CHECK (event_id <> ''),
      start_at     TEXT NOT NULL,
      end_at       TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      PRIMARY KEY (calendar_id, event_id)
    );
    CREATE INDEX idx_gws_ea_thread_holds_thread ON gws_ea_thread_holds (thread_key);

    CREATE TABLE gws_ea_thread_bookings (
      thread_key   TEXT NOT NULL REFERENCES gws_ea_threads(thread_key) ON DELETE CASCADE,
      calendar_id  TEXT NOT NULL CHECK (calendar_id <> ''),
      event_id     TEXT NOT NULL CHECK (event_id <> ''),
      booked_at    TEXT NOT NULL,
      PRIMARY KEY (calendar_id, event_id)
    );
    CREATE INDEX idx_gws_ea_thread_bookings_thread ON gws_ea_thread_bookings (thread_key);
  `);
}

// ---------------------------------------------------------------------------
// Moving the earlier release's work
// ---------------------------------------------------------------------------

interface EarlierThread {
  thread_key: string;
  origin: string;
  gmail_thread_id: string | null;
  people_to: string;
  people_cc: string;
  people_bcc: string;
  vouched_people: string;
  created_at: string;
}

/** A JSON list of addresses as the earlier inbox stored them, each lowercased once. */
function addressList(json: string, threadKey: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
    throw new Error(`Thread ${threadKey} holds a malformed address list`);
  }
  return parsed.map((address) => address.trim().toLowerCase()).filter((address) => address !== '');
}

/** The calendar `main` named for each thread's live meeting. */
async function bookingCalendars(db: DbDriver): Promise<Map<string, string>> {
  const rows = await db.all<{ thread_key: string; booking_calendar_id: string | null }>(
    `SELECT thread_key, booking_calendar_id FROM gws_ea_meetings
      WHERE kind = 'arrange' AND state IN ${LIVE_MEETING_STATES}`,
  );
  return new Map(
    rows.flatMap((row) => (row.booking_calendar_id === null ? [] : [[row.thread_key, row.booking_calendar_id]])),
  );
}

/**
 * Each thread, with its Message-IDs, its people, and the calendar `main`
 * named for it. A send still in flight keeps its Message-ID in its send's
 * record alone, as a new send does, so delivery records its message once,
 * when Gmail holds it.
 */
async function convertThreads(db: DbDriver, calendars: ReadonlyMap<string, string>): Promise<void> {
  const threads = await db.all<EarlierThread>(
    `SELECT thread_key, origin, gmail_thread_id, people_to, people_cc, people_bcc, vouched_people, created_at
       FROM gws_ea_inbox_threads ORDER BY created_at, thread_key`,
  );
  for (const thread of threads) {
    await db.run(
      'INSERT INTO gws_ea_threads (thread_key, gmail_thread_id, booking_calendar_id, created_at) VALUES (?, ?, ?, ?)',
      thread.thread_key,
      thread.gmail_thread_id,
      calendars.get(thread.thread_key) ?? null,
      thread.created_at,
    );
    // main named the people of a thread it started; any other thread's came on its mail.
    const source = thread.origin === 'arrange' || thread.origin === 'ask_organizer' ? 'main' : 'message';
    const people = new Set(
      [thread.people_to, thread.people_cc, thread.people_bcc, thread.vouched_people].flatMap((json) =>
        addressList(json, thread.thread_key),
      ),
    );
    for (const address of people) {
      await db.run(
        'INSERT INTO gws_ea_thread_addresses (thread_key, address, source, recorded_at) VALUES (?, ?, ?, ?)',
        thread.thread_key,
        address,
        source,
        thread.created_at,
      );
    }
  }

  // An email Gmail took for the thread is known by its Gmail id too, so a reply can answer it.
  const sent = new Map(
    (
      await db.all<{ thread_key: string; rfc_message_id: string; gmail_message_id: string }>(
        `SELECT thread_key, rfc_message_id, gmail_message_id FROM gws_ea_inbox_sends
          WHERE thread_key IS NOT NULL AND state = 'sent' AND gmail_message_id IS NOT NULL`,
      )
    ).map((row) => [`${row.thread_key}\u0000${row.rfc_message_id}`, row.gmail_message_id]),
  );
  const inFlight = new Set(
    (
      await db.all<{ thread_key: string; rfc_message_id: string }>(
        `SELECT thread_key, rfc_message_id FROM gws_ea_inbox_sends WHERE thread_key IS NOT NULL AND state = 'pending'`,
      )
    ).map((row) => `${row.thread_key}\u0000${row.rfc_message_id}`),
  );
  const converted = new Set(threads.map((thread) => thread.thread_key));
  const positions = new Map<string, number>();
  for (const message of await db.all<{ thread_key: string; rfc_message_id: string; added_at: string }>(
    `SELECT thread_key, rfc_message_id, added_at FROM gws_ea_inbox_thread_messages
      ORDER BY thread_key, position, added_at, rfc_message_id`,
  )) {
    if (!converted.has(message.thread_key)) continue;
    if (inFlight.has(`${message.thread_key}\u0000${message.rfc_message_id}`)) continue;
    const position = (positions.get(message.thread_key) ?? 0) + 1;
    positions.set(message.thread_key, position);
    await db.run(
      `INSERT INTO gws_ea_thread_messages (thread_key, position, side, gmail_message_id, rfc_message_id, recorded_at)
       VALUES (?, ?, 'outside', ?, ?, ?)`,
      message.thread_key,
      position,
      sent.get(`${message.thread_key}\u0000${message.rfc_message_id}`) ?? null,
      message.rfc_message_id,
      message.added_at,
    );
  }
}

/**
 * Each hold, lapsing three days on, and each booking but a reschedule's,
 * under its meeting's thread. Returns how many bare threads it added.
 */
async function convertCalendar(db: DbDriver, calendars: ReadonlyMap<string, string>, at: Date): Promise<number> {
  let bare = 0;
  const ensureThread = async (threadKey: string, createdAt: string): Promise<void> => {
    if (await db.get('SELECT 1 AS found FROM gws_ea_threads WHERE thread_key = ?', threadKey)) return;
    await db.run(
      'INSERT INTO gws_ea_threads (thread_key, gmail_thread_id, booking_calendar_id, created_at) VALUES (?, NULL, ?, ?)',
      threadKey,
      calendars.get(threadKey) ?? null,
      createdAt,
    );
    bare += 1;
  };

  const expiresAt = new Date(at.getTime() + HOLD_LIFETIME_MS).toISOString();
  for (const hold of await db.all<{
    thread_key: string;
    calendar_id: string;
    event_id: string;
    start_at: string;
    end_at: string;
    created_at: string;
  }>(
    `SELECT m.thread_key, h.calendar_id, h.event_id, h.start_at, h.end_at, m.created_at
       FROM gws_ea_meeting_holds h JOIN gws_ea_meetings m ON m.id = h.meeting_id
      ORDER BY h.held_at, h.event_id`,
  )) {
    await ensureThread(hold.thread_key, hold.created_at);
    await db.run(
      `INSERT INTO gws_ea_thread_holds (thread_key, calendar_id, event_id, start_at, end_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      hold.thread_key,
      hold.calendar_id,
      hold.event_id,
      hold.start_at,
      hold.end_at,
      expiresAt,
    );
  }

  for (const booking of await db.all<{
    thread_key: string;
    calendar_id: string;
    event_id: string;
    booked_at: string;
    created_at: string;
  }>(
    `SELECT m.thread_key, b.calendar_id, b.event_id, b.booked_at, m.created_at
       FROM gws_ea_meeting_bookings b JOIN gws_ea_meetings m ON m.id = b.meeting_id
      WHERE m.kind <> 'reschedule'
      ORDER BY b.booked_at, b.event_id`,
  )) {
    await ensureThread(booking.thread_key, booking.created_at);
    await db.run(
      'INSERT INTO gws_ea_thread_bookings (thread_key, calendar_id, event_id, booked_at) VALUES (?, ?, ?, ?)',
      booking.thread_key,
      booking.calendar_id,
      booking.event_id,
      booking.booked_at,
    );
  }
  return bare;
}

/** Each thread's send in flight, on the thread's outside side, its content hash unchanged. */
async function convertSends(db: DbDriver): Promise<void> {
  await db.run(
    `INSERT INTO gws_ea_thread_sends (
       id, thread_key, side, content_hash, rfc_message_id, state, gmail_message_id, created_at, updated_at
     )
     SELECT s.id, s.thread_key, 'outside', s.content_hash, s.rfc_message_id, s.state, s.gmail_message_id,
            s.created_at, s.updated_at
       FROM gws_ea_inbox_sends s JOIN gws_ea_threads t ON t.thread_key = s.thread_key`,
  );
}

/**
 * Mail held for a thread, and the principal's messages in a thread they
 * copied the assistant into that `main` had not taken over: each becomes a
 * known message not yet settled, which the poll routes before new mail.
 */
async function routeHeldMailAgain(db: DbDriver): Promise<void> {
  const firstSeen = new Map<string, string>();
  const keepEarliest = (gmailMessageId: string, at: string): void => {
    const known = firstSeen.get(gmailMessageId);
    if (known === undefined || at < known) firstSeen.set(gmailMessageId, at);
  };
  for (const held of await db.all<{ gmail_message_id: string; held_at: string }>(
    'SELECT gmail_message_id, held_at FROM gws_ea_inbox_held',
  )) {
    keepEarliest(held.gmail_message_id, held.held_at);
  }
  for (const copied of await db.all<{ gmail_message_id: string; received_at: string }>(
    `SELECT p.gmail_message_id, p.received_at
       FROM gws_ea_inbox_principal_messages p JOIN gws_ea_inbox_threads t ON t.gmail_thread_id = p.gmail_thread_id
      WHERE t.origin = 'copy-in' AND t.state = 'awaiting-arrange'`,
  )) {
    keepEarliest(copied.gmail_message_id, copied.received_at);
  }
  for (const [gmailMessageId, at] of firstSeen) {
    await db.run(
      `INSERT INTO gws_ea_inbox_messages (gmail_message_id, outcome, attempts, first_seen_at, settled_at)
         VALUES (?, NULL, 0, ?, NULL)
         ON CONFLICT (gmail_message_id) DO UPDATE
            SET outcome = NULL, attempts = 0, first_seen_at = excluded.first_seen_at, settled_at = NULL`,
      gmailMessageId,
      at,
    );
  }
}

/** Whether a stored capability list is one an earlier release stamped, in any order. */
function isEarlierList(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return false;
    throw err;
  }
  if (!Array.isArray(parsed) || !parsed.every((key): key is string => typeof key === 'string')) return false;
  const stored = [...new Set(parsed)].sort();
  return EARLIER_EXTERNAL_EMAIL_CAPABILITIES.some(
    (list) => list.length === stored.length && [...list].sort().every((key, index) => key === stored[index]),
  );
}

/** `external-email`'s stored list moves to this release's, only from a list an earlier release stamped. */
async function moveExternalEmailCapabilities(db: DbDriver, at: Date): Promise<void> {
  if (!(await db.hasTable('gws_ea_profile'))) return;
  const pointer = await db.get<{ external_email_agent_group_id: string | null }>(
    'SELECT external_email_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
  );
  const agentGroupId = pointer?.external_email_agent_group_id ?? null;
  if (agentGroupId === null) return;
  const config = await db.get<{ capabilities: string }>(
    'SELECT capabilities FROM container_configs WHERE agent_group_id = ?',
    agentGroupId,
  );
  if (config === undefined || !isEarlierList(config.capabilities)) return;
  await db.run(
    'UPDATE container_configs SET capabilities = ?, updated_at = ? WHERE agent_group_id = ?',
    JSON.stringify(MOVED_EXTERNAL_EMAIL_CAPABILITIES),
    at.toISOString(),
    agentGroupId,
  );
}

/** An earlier thread message that is a send in flight, which only the send's record carries over. */
const IN_FLIGHT_MESSAGE = `WHERE EXISTS (
  SELECT 1 FROM gws_ea_inbox_sends s
   WHERE s.thread_key = gws_ea_inbox_thread_messages.thread_key
     AND s.rfc_message_id = gws_ea_inbox_thread_messages.rfc_message_id
     AND s.state = 'pending'
)`;

async function count(db: DbDriver, table: string, where = ''): Promise<number> {
  return (await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} ${where}`))?.count ?? 0;
}

/**
 * Every record carried over against its source: the earlier threads, with
 * the bare ones holds and bookings needed; their Message-IDs; the holds; the
 * bookings but a reschedule's; and the thread's sends in flight. A mismatch
 * throws, and the runner rolls the whole migration back.
 */
async function checkCounts(db: DbDriver, bareThreads: number): Promise<void> {
  const checks: ReadonlyArray<readonly [string, number, number]> = [
    ['threads', await count(db, 'gws_ea_threads'), (await count(db, 'gws_ea_inbox_threads')) + bareThreads],
    [
      'thread messages',
      await count(db, 'gws_ea_thread_messages'),
      (await count(db, 'gws_ea_inbox_thread_messages')) -
        (await count(db, 'gws_ea_inbox_thread_messages', IN_FLIGHT_MESSAGE)),
    ],
    ['holds', await count(db, 'gws_ea_thread_holds'), await count(db, 'gws_ea_meeting_holds')],
    [
      'bookings',
      await count(db, 'gws_ea_thread_bookings'),
      await count(
        db,
        'gws_ea_meeting_bookings',
        "WHERE meeting_id NOT IN (SELECT id FROM gws_ea_meetings WHERE kind = 'reschedule')",
      ),
    ],
    [
      'sends in flight',
      await count(db, 'gws_ea_thread_sends'),
      await count(db, 'gws_ea_inbox_sends', 'WHERE thread_key IS NOT NULL'),
    ],
  ];
  for (const [what, carried, source] of checks) {
    if (carried !== source) {
      throw new Error(`The email channel's migration carried ${carried} of ${source} earlier ${what} over`);
    }
  }
}

/** Every table of the earlier release's threads and meetings, children before their parents. */
async function dropEarlierTables(db: DbDriver): Promise<void> {
  await db.exec(`
    DROP TABLE gws_ea_inbox_sends;
    DROP TABLE gws_ea_inbox_held;
    DROP TABLE gws_ea_inbox_thread_messages;
    DROP TABLE gws_ea_inbox_principal_messages;
    DROP TABLE gws_ea_inbox_threads;
    DROP TABLE gws_ea_meeting_rooms;
    DROP TABLE gws_ea_meeting_holds;
    DROP TABLE gws_ea_meeting_bookings;
    DROP TABLE gws_ea_meeting_slots;
    DROP TABLE gws_ea_meeting_outcomes;
    DROP TABLE gws_ea_meeting_counterparts;
    DROP TABLE gws_ea_meeting_requests;
    DROP TABLE gws_ea_meetings;
  `);
}
