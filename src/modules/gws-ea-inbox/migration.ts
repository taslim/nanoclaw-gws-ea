import type { ModuleMigration } from '../../db/migrations/index.js';

/*
 * Both live assistants applied an earlier form of `create-inbox` and
 * `email-channel`, along with the meetings store's three migrations, which
 * built an earlier release's threads and meetings and then moved them into
 * the thread map (testing/earlier-chain.ts). The runner skips a name already
 * applied and ignores one it no longer registers, so each body below builds
 * only today's tables, for a fresh install. migration.test.ts checks that a
 * fresh install has the schema of an install updated from that chain.
 */

/**
 * The inbox's own state (KTD4, KTD9). No mail body is stored: a message is
 * kept by its Gmail id and read again when it is routed.
 *
 * - `gws_ea_inbox_state`: the inbox's messaging group (`email:inbox`), the
 *   history cursor, the inbox's health and its calendar notifications', and
 *   the principal's own email conversation with `main` (`email:principal`).
 *   The wiring and destination policies pin both messaging groups by these
 *   stored ids.
 * - `gws_ea_inbox_messages`: each Gmail message seen, with its routing outcome
 *   once settled and its failed attempts until then, so a message routes once.
 * - `gws_ea_inbox_sender_counts`: messages per sender per hour.
 * - `gws_ea_inbox_calendars`: the principal's calendars in the assistant's
 *   calendar list, whose notifications the host turned on.
 */
export const gwsEaInboxMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-inbox:create-inbox',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_inbox_state (
        singleton                     INTEGER PRIMARY KEY CHECK (singleton = 1),
        messaging_group_id            TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL,
        history_id                    TEXT,
        health                        TEXT NOT NULL CHECK (health IN ('healthy', 'unhealthy')),
        health_reason                 TEXT,
        health_since                  TEXT,
        consecutive_failures          INTEGER NOT NULL CHECK (consecutive_failures >= 0),
        unhealthy_notified_at         TEXT,
        last_success_at               TEXT,
        calendar_sync                 TEXT NOT NULL CHECK (calendar_sync IN ('unknown', 'ok', 'failing')),
        calendar_sync_reason          TEXT,
        principal_messaging_group_id  TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL
      );
      INSERT INTO gws_ea_inbox_state (singleton, health, consecutive_failures, calendar_sync)
        VALUES (1, 'healthy', 0, 'unknown');

      CREATE TABLE gws_ea_inbox_messages (
        gmail_message_id  TEXT PRIMARY KEY,
        outcome           TEXT,
        attempts          INTEGER NOT NULL CHECK (attempts >= 0),
        first_seen_at     TEXT NOT NULL,
        settled_at        TEXT
      );

      CREATE TABLE gws_ea_inbox_sender_counts (
        sender        TEXT NOT NULL,
        window_start  TEXT NOT NULL,
        count         INTEGER NOT NULL CHECK (count >= 0),
        PRIMARY KEY (sender, window_start)
      );

      CREATE TABLE gws_ea_inbox_calendars (
        calendar_id  TEXT PRIMARY KEY,
        applied_at   TEXT NOT NULL
      );
    `);
  },
};

/**
 * The thread map (KTD1, KTD2, KTD7, KTD9): every table keyed to an email
 * thread.
 *
 * - `gws_ea_threads`: each thread's stable `mail-…` key and its Gmail thread,
 *   which a thread `main` hands over gains on its first send, and the
 *   calendar its bookings go on when `main` named one.
 * - `gws_ea_thread_messages`: each message in the thread, in the order the
 *   thread learned of it, with its side (`principal` when only the principal
 *   and the assistant can read it, `outside` otherwise), its Gmail id, and
 *   its Message-ID. A message known only by its Message-ID has no Gmail id.
 * - `gws_ea_thread_addresses`: each address the thread's messages carried,
 *   each one an outside sender wrote in their own words, and each one `main`
 *   named, recorded once for each way it came.
 * - `gws_ea_thread_files`: each file `main` handed over for the thread, by
 *   its SHA-256, with its name and the host's staged copy.
 * - `gws_ea_thread_sends`: a send between allocating its Message-ID and
 *   delivery recording it, per thread and side, so a retry finds what Gmail
 *   may already hold.
 * - `gws_ea_thread_bookings`: each event the thread booked, which it alone
 *   may move or cancel.
 */
export const gwsEaInboxEmailChannelMigration: ModuleMigration = {
  version: 2,
  name: 'module:gws-ea-inbox:email-channel',
  async up(db) {
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
        source       TEXT NOT NULL CHECK (source IN ('message', 'written', 'main')),
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

      CREATE TABLE gws_ea_thread_bookings (
        thread_key   TEXT NOT NULL REFERENCES gws_ea_threads(thread_key) ON DELETE CASCADE,
        calendar_id  TEXT NOT NULL CHECK (calendar_id <> ''),
        event_id     TEXT NOT NULL CHECK (event_id <> ''),
        booked_at    TEXT NOT NULL,
        PRIMARY KEY (calendar_id, event_id)
      );
      CREATE INDEX idx_gws_ea_thread_bookings_thread ON gws_ea_thread_bookings (thread_key);
    `);
  },
};

/**
 * Offering a time no longer reserves it, so the holds the earlier chain's
 * `email-channel` recorded per thread go. A fresh install never had them.
 */
export const gwsEaInboxDropThreadHoldsMigration: ModuleMigration = {
  version: 3,
  name: 'module:gws-ea-inbox:drop-thread-holds',
  async up(db) {
    await db.exec('DROP TABLE IF EXISTS gws_ea_thread_holds');
  },
};
