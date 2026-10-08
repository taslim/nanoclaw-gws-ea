import type { ModuleMigration } from '../../../db/migrations/index.js';

/**
 * The inbox's and the meetings store's migrations as both live assistants
 * applied them, before they were squashed (release c2c1a9a6), under the same
 * names. Each keeps that release's schema statements verbatim. The email
 * channel's one-time move of the release before it into the thread map is
 * left out: it moved rows, not schema, and it has run on every live install.
 *
 * Test-only: the squash test runs this chain and then today's migrations, and
 * compares the result with a fresh install.
 */
export const EARLIER_INBOX_CHAIN: readonly ModuleMigration[] = [
  {
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
      `);
    },
  },
  {
    version: 1,
    name: 'module:gws-ea-meetings:create-meetings',
    async up(db) {
      await db.exec(`
        CREATE TABLE gws_ea_meetings (
          id                    TEXT PRIMARY KEY CHECK (id LIKE 'mtg-%'),
          kind                  TEXT NOT NULL CHECK (kind IN ('arrange', 'reschedule', 'ask_organizer', 'respond')),
          requested_by_session  TEXT NOT NULL,
          request_id            TEXT NOT NULL,
          state                 TEXT NOT NULL CHECK (state IN (
                                  'opening', 'active', 'booked', 'closing', 'settled', 'not-scheduling', 'done',
                                  'gave-up', 'cancelled', 'stopped', 'superseded', 'failed'
                                )),
          level                 TEXT NOT NULL CHECK (level IN ('inner-circle', 'close', 'active', 'known', 'unknown')),
          booking_calendar_id   TEXT CHECK (booking_calendar_id <> ''),
          event_calendar_id     TEXT CHECK (event_calendar_id <> ''),
          event_id              TEXT CHECK (event_id <> ''),
          length_minutes        INTEGER CHECK (length_minutes BETWEEN 5 AND 480),
          window_start          TEXT,
          window_end            TEXT,
          purpose               TEXT NOT NULL CHECK (purpose <> ''),
          constraints           TEXT CHECK (constraints <> ''),
          invitation            TEXT,
          thread_key            TEXT NOT NULL CHECK (thread_key LIKE 'mail-%'),
          session_id            TEXT,
          brief_version         INTEGER NOT NULL CHECK (brief_version >= 0),
          replaces_meeting_id   TEXT,
          nudge_at              TEXT,
          give_up_at            TEXT,
          replied_at            TEXT,
          ask_about             TEXT CHECK (ask_about IN ('time', 'length', 'people', 'place', 'other')),
          asked_at              TEXT,
          created_at            TEXT NOT NULL,
          updated_at            TEXT NOT NULL,
          ended_at              TEXT,
          UNIQUE (requested_by_session, request_id),
          CHECK (kind IN ('ask_organizer', 'respond') OR booking_calendar_id IS NOT NULL),
          CHECK (kind IN ('arrange', 'respond') OR (event_calendar_id IS NOT NULL AND event_id IS NOT NULL)),
          CHECK ((kind = 'respond') = (length_minutes IS NULL)),
          CHECK ((length_minutes IS NULL) = (window_start IS NULL) AND (window_start IS NULL) = (window_end IS NULL)),
          CHECK ((ask_about IS NULL) = (asked_at IS NULL))
        );
        CREATE UNIQUE INDEX idx_gws_ea_meetings_live_thread
          ON gws_ea_meetings (thread_key) WHERE state IN ('opening', 'active', 'booked', 'closing');
        CREATE INDEX idx_gws_ea_meetings_session ON gws_ea_meetings (session_id);
        CREATE INDEX idx_gws_ea_meetings_event ON gws_ea_meetings (event_calendar_id, event_id);

        CREATE TABLE gws_ea_meeting_counterparts (
          meeting_id  TEXT NOT NULL REFERENCES gws_ea_meetings(id) ON DELETE CASCADE,
          position    INTEGER NOT NULL CHECK (position >= 0),
          address     TEXT NOT NULL CHECK (address <> '' AND address = lower(address)),
          person_id   TEXT,
          name        TEXT CHECK (name <> ''),
          level       TEXT NOT NULL CHECK (level IN ('inner-circle', 'close', 'active', 'known', 'unknown')),
          PRIMARY KEY (meeting_id, address)
        );
        CREATE INDEX idx_gws_ea_meeting_counterparts_person ON gws_ea_meeting_counterparts (person_id);

        CREATE TABLE gws_ea_meeting_requests (
          session_id   TEXT NOT NULL,
          request_id   TEXT NOT NULL,
          action       TEXT NOT NULL,
          meeting_id   TEXT,
          response     TEXT NOT NULL,
          answered_at  TEXT NOT NULL,
          PRIMARY KEY (session_id, request_id)
        );
        CREATE INDEX idx_gws_ea_meeting_requests_meeting ON gws_ea_meeting_requests (meeting_id);

        CREATE TABLE gws_ea_meeting_outcomes (
          meeting_id   TEXT NOT NULL REFERENCES gws_ea_meetings(id) ON DELETE CASCADE,
          outcome      TEXT NOT NULL CHECK (outcome IN (
                         'settled', 'not-scheduling', 'gave-up', 'done'
                       )),
          response     TEXT NOT NULL,
          recorded_at  TEXT NOT NULL,
          PRIMARY KEY (meeting_id, outcome)
        );

        CREATE TABLE gws_ea_meeting_slots (
          meeting_id  TEXT NOT NULL REFERENCES gws_ea_meetings(id) ON DELETE CASCADE,
          slot_id     TEXT NOT NULL CHECK (slot_id <> ''),
          start_at    TEXT NOT NULL,
          end_at      TEXT NOT NULL,
          offered_at  TEXT NOT NULL,
          PRIMARY KEY (meeting_id, slot_id)
        );

        CREATE TABLE gws_ea_meeting_bookings (
          meeting_id   TEXT PRIMARY KEY REFERENCES gws_ea_meetings(id) ON DELETE CASCADE,
          calendar_id  TEXT NOT NULL CHECK (calendar_id <> ''),
          event_id     TEXT NOT NULL CHECK (event_id <> ''),
          start_at     TEXT NOT NULL,
          end_at       TEXT NOT NULL,
          booked_at    TEXT NOT NULL,
          invitation   TEXT
        );
        CREATE INDEX idx_gws_ea_meeting_bookings_event ON gws_ea_meeting_bookings (calendar_id, event_id);
      `);
    },
  },
  {
    version: 2,
    name: 'module:gws-ea-meetings:calendar-actions',
    async up(db) {
      await db.exec(`
        ALTER TABLE gws_ea_meetings ADD COLUMN meeting_kind TEXT CHECK (meeting_kind IS NULL OR meeting_kind <> '');

        CREATE TABLE gws_ea_meeting_holds (
          meeting_id   TEXT NOT NULL REFERENCES gws_ea_meetings(id) ON DELETE CASCADE,
          slot_id      TEXT NOT NULL CHECK (slot_id <> ''),
          calendar_id  TEXT NOT NULL CHECK (calendar_id <> ''),
          event_id     TEXT NOT NULL CHECK (event_id <> ''),
          start_at     TEXT NOT NULL,
          end_at       TEXT NOT NULL,
          held_at      TEXT NOT NULL,
          PRIMARY KEY (meeting_id, slot_id),
          UNIQUE (calendar_id, event_id)
        );
      `);
    },
  },
  {
    version: 3,
    name: 'module:gws-ea-meetings:rooms',
    async up(db) {
      await db.exec(`
        CREATE TABLE gws_ea_meeting_rooms (
          by_meeting_id     TEXT PRIMARY KEY REFERENCES gws_ea_meetings(id) ON DELETE CASCADE,
          for_meeting_id    TEXT NOT NULL REFERENCES gws_ea_meetings(id) ON DELETE CASCADE,
          moved_meeting_id  TEXT NOT NULL REFERENCES gws_ea_meetings(id) ON DELETE CASCADE,
          start_at          TEXT NOT NULL,
          end_at            TEXT NOT NULL,
          state             TEXT NOT NULL CHECK (state IN ('reserved', 'given', 'lost')),
          chosen_at         TEXT NOT NULL,
          settled_at        TEXT
        );
        CREATE INDEX idx_gws_ea_meeting_rooms_for ON gws_ea_meeting_rooms (for_meeting_id);
        CREATE INDEX idx_gws_ea_meeting_rooms_moved ON gws_ea_meeting_rooms (moved_meeting_id);
      `);
    },
  },
  {
    version: 2,
    name: 'module:gws-ea-inbox:email-channel',
    async up(db) {
      await db.exec(`
        ALTER TABLE gws_ea_inbox_state
          ADD COLUMN principal_messaging_group_id TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL
      `);
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
    },
  },
];
