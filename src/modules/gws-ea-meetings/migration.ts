import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * The meeting store (KTD5, KTD11, KTD12). It records intent and links only:
 * the calendar is re-read whenever a fact about it matters.
 *
 * - `gws_ea_meetings`: one job main handed to `external-email`. Its kind and
 *   the request that created it; its level, booking calendar, and the event
 *   it concerns (the event a reschedule moves, the invitation an
 *   ask_organizer is about); its length, window, purpose and constraints;
 *   its state; the thread and session it is bound to; its brief's version;
 *   its follow-through deadlines; and the question `external-email` put to
 *   main and is waiting on, if any (`ask_about`, `asked_at`). A `respond`
 *   job is a conversation in a thread waiting for main: it has no length or
 *   window. Each job records when its first email was delivered. A meeting
 *   called off while it owes the other side one line is `closing` until
 *   that line has gone. At most one live meeting holds a thread at a time.
 * - `gws_ea_meeting_counterparts`: who the meeting is with: each address the
 *   host took from a person's record, from Google, from the mail of a thread
 *   held for main, or from main, with that person's name and level as the
 *   brief showed them.
 * - `gws_ea_meeting_requests`: each typed request's answer, keyed on the
 *   session and the outbound message that carried it, so a replay returns
 *   the first answer.
 * - `gws_ea_meeting_outcomes`: each outcome a meeting reported, once. A
 *   conversation's `done` is recorded when it ends, and its `gave-up` when
 *   delivery gives up on its email.
 * - `gws_ea_meeting_slots`: the candidate times the host offered for a
 *   meeting, by slot id (written by the calendar actions).
 * - `gws_ea_meeting_bookings`: the event the host's own `book` created or
 *   moved for a meeting (written by the calendar actions). A booked outcome
 *   is accepted only with one.
 */
export const gwsEaMeetingsMigration: ModuleMigration = {
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
                       'booked', 'settled', 'not-scheduling', 'gave-up', 'done'
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
        booked_at    TEXT NOT NULL
      );
      CREATE INDEX idx_gws_ea_meeting_bookings_event ON gws_ea_meeting_bookings (calendar_id, event_id);
    `);
  },
};

/**
 * The calendar actions' own state (KTD11):
 *
 * - `gws_ea_meetings.meeting_kind`: the kind of meeting main named, such as
 *   `one-on-one`, whose buffer and preferred times apply; null for the
 *   principal's `default` values.
 * - `gws_ea_meeting_holds`: each hold the assistant placed for a meeting, by
 *   the slot it holds and the event it created. Recorded before the event is
 *   created, so a release always finds every hold the assistant may have
 *   placed, and touches no other event.
 */
export const gwsEaMeetingsCalendarActionsMigration: ModuleMigration = {
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
};

/**
 * Making room (KTD12; R14, R23): `gws_ea_meeting_rooms` holds each
 * reschedule `main` sent to make room, by the meeting doing the move. It
 * names the meeting the room is for, the booked meeting that moves, and the
 * time reserved for the first: busy for the move, and held for the meeting
 * it is for once the move is booked (`given`), or reported to `main` when
 * that time was taken first (`lost`).
 */
export const gwsEaMeetingsRoomsMigration: ModuleMigration = {
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
};
