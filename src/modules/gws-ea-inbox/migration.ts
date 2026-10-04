import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * The inbox's own state (KTD4, KTD9). No mail body is stored: a held message
 * is kept by its Gmail id and read again when its thread opens.
 *
 * - `gws_ea_inbox_state`: the inbox's messaging group, the history cursor,
 *   and its health.
 * - `gws_ea_inbox_messages`: each Gmail message seen, with its routing outcome
 *   once settled and its failed attempts until then, so a message routes once.
 * - `gws_ea_inbox_threads`: each thread's key, Gmail thread, authorization,
 *   and its people as its next reply places them, in To, Cc, and Bcc (JSON
 *   arrays).
 * - `gws_ea_inbox_thread_messages`: the Message-IDs known in each thread,
 *   in order, for matching replies and writing `References`.
 * - `gws_ea_inbox_held`: mail for a thread whose session is not open yet.
 * - `gws_ea_inbox_principal_messages`: each message Gmail verified as the
 *   principal's, with what a reply needs to answer only them, in its thread.
 * - `gws_ea_inbox_sends`: a send between allocating its Message-ID and the
 *   delivery being recorded, so a retry finds what Gmail may already hold:
 *   a reply in a thread, or a reply to one of the principal's messages.
 * - `gws_ea_inbox_sender_counts`: messages per sender per hour.
 * - `gws_ea_inbox_calendars`: the principal's calendars in the assistant's
 *   calendar list, whose notifications the host turned on.
 * - `gws_ea_inbox_dkim_selectors`: the selectors the operator pinned.
 */
export const gwsEaInboxMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-inbox:create-inbox',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_inbox_state (
        singleton              INTEGER PRIMARY KEY CHECK (singleton = 1),
        messaging_group_id     TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL,
        history_id             TEXT,
        health                 TEXT NOT NULL CHECK (health IN ('healthy', 'unhealthy')),
        health_reason          TEXT,
        health_since           TEXT,
        consecutive_failures   INTEGER NOT NULL CHECK (consecutive_failures >= 0),
        unhealthy_notified_at  TEXT,
        last_success_at        TEXT,
        calendar_sync          TEXT NOT NULL CHECK (calendar_sync IN ('unknown', 'ok', 'failing')),
        calendar_sync_reason   TEXT
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

      CREATE TABLE gws_ea_inbox_threads (
        thread_key             TEXT PRIMARY KEY CHECK (thread_key LIKE 'mail-%'),
        origin                 TEXT NOT NULL CHECK (origin IN ('arrange', 'ask_organizer', 'copy-in', 'inbound')),
        state                  TEXT NOT NULL CHECK (state IN ('awaiting-arrange', 'authorized', 'open', 'closed')),
        gmail_thread_id        TEXT UNIQUE,
        subject                TEXT NOT NULL,
        people_to              TEXT NOT NULL,
        people_cc              TEXT NOT NULL,
        people_bcc             TEXT NOT NULL,
        vouched_people         TEXT NOT NULL,
        session_id             TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );

      CREATE TABLE gws_ea_inbox_thread_messages (
        rfc_message_id  TEXT PRIMARY KEY,
        thread_key      TEXT NOT NULL REFERENCES gws_ea_inbox_threads(thread_key) ON DELETE CASCADE,
        position        INTEGER NOT NULL,
        added_at        TEXT NOT NULL
      );
      CREATE INDEX idx_gws_ea_inbox_thread_messages_thread
        ON gws_ea_inbox_thread_messages(thread_key, position);

      CREATE TABLE gws_ea_inbox_held (
        gmail_message_id  TEXT PRIMARY KEY,
        thread_key        TEXT NOT NULL REFERENCES gws_ea_inbox_threads(thread_key) ON DELETE CASCADE,
        sender            TEXT,
        held_at           TEXT NOT NULL
      );
      CREATE INDEX idx_gws_ea_inbox_held_thread ON gws_ea_inbox_held(thread_key, held_at);

      CREATE TABLE gws_ea_inbox_principal_messages (
        gmail_message_id  TEXT PRIMARY KEY,
        address           TEXT NOT NULL,
        gmail_thread_id   TEXT NOT NULL,
        rfc_message_id    TEXT,
        reference_ids     TEXT NOT NULL,
        subject           TEXT NOT NULL,
        received_at       TEXT NOT NULL
      );
      CREATE INDEX idx_gws_ea_inbox_principal_messages_received
        ON gws_ea_inbox_principal_messages(received_at);

      CREATE TABLE gws_ea_inbox_sends (
        id                    TEXT PRIMARY KEY,
        thread_key            TEXT REFERENCES gws_ea_inbox_threads(thread_key) ON DELETE CASCADE,
        principal_message_id  TEXT REFERENCES gws_ea_inbox_principal_messages(gmail_message_id) ON DELETE CASCADE,
        content_hash          TEXT NOT NULL,
        rfc_message_id        TEXT NOT NULL UNIQUE,
        state                 TEXT NOT NULL CHECK (state IN ('pending', 'sent')),
        gmail_message_id      TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        CHECK ((thread_key IS NULL) <> (principal_message_id IS NULL))
      );
      CREATE INDEX idx_gws_ea_inbox_sends_content ON gws_ea_inbox_sends(thread_key, content_hash);
      CREATE INDEX idx_gws_ea_inbox_sends_principal ON gws_ea_inbox_sends(principal_message_id, content_hash);

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

      CREATE TABLE gws_ea_inbox_dkim_selectors (
        domain     TEXT NOT NULL,
        selector   TEXT NOT NULL,
        pinned_at  TEXT NOT NULL,
        PRIMARY KEY (domain, selector)
      );
    `);
  },
};
