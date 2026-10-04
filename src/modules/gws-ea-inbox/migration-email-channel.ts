import type { DbDriver } from '../../db/driver.js';
import type { ModuleMigration } from '../../db/migrations/index.js';

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
