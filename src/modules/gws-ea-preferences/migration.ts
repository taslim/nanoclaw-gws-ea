import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * One table per kind of scheduling preference, each with typed columns the
 * schema checks, so a value outside its kind's shape cannot be stored even by
 * a writer that skips `db.ts`. Clock times are minutes after local midnight in
 * the principal's timezone; weekday sets are canonical comma-separated lists.
 * `basis` and `reason` are main-only (see `MAIN_ONLY_PREFERENCE_FIELDS`).
 */
export const gwsEaPreferencesMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-preferences:create-preferences',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_pref_working_hours (
        weekday       TEXT PRIMARY KEY CHECK (weekday IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
        start_minute  INTEGER CHECK (start_minute >= 0 AND start_minute < 1440),
        end_minute    INTEGER CHECK (end_minute > 0 AND end_minute <= 1440),
        source        TEXT NOT NULL CHECK (source IN ('principal', 'learned')),
        basis         TEXT NOT NULL CHECK (basis <> ''),
        updated_at    TEXT NOT NULL,
        CHECK (
          (start_minute IS NULL AND end_minute IS NULL)
          OR (start_minute IS NOT NULL AND end_minute IS NOT NULL AND start_minute < end_minute)
        )
      );

      CREATE TABLE gws_ea_pref_protected_windows (
        id            TEXT PRIMARY KEY,
        weekdays      TEXT NOT NULL CHECK (weekdays <> ''),
        start_minute  INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
        end_minute    INTEGER NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
        reason        TEXT CHECK (reason <> ''),
        source        TEXT NOT NULL CHECK (source IN ('principal', 'learned')),
        basis         TEXT NOT NULL CHECK (basis <> ''),
        updated_at    TEXT NOT NULL,
        CHECK (start_minute < end_minute),
        UNIQUE (weekdays, start_minute, end_minute)
      );

      CREATE TABLE gws_ea_pref_meeting_lengths (
        meeting_kind  TEXT PRIMARY KEY CHECK (meeting_kind <> ''),
        minutes       INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
        source        TEXT NOT NULL CHECK (source IN ('principal', 'learned')),
        basis         TEXT NOT NULL CHECK (basis <> ''),
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE gws_ea_pref_buffers (
        meeting_kind  TEXT PRIMARY KEY CHECK (meeting_kind <> ''),
        minutes       INTEGER NOT NULL CHECK (minutes >= 0 AND minutes <= 1440),
        source        TEXT NOT NULL CHECK (source IN ('principal', 'learned')),
        basis         TEXT NOT NULL CHECK (basis <> ''),
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE gws_ea_pref_preferred_times (
        meeting_kind  TEXT PRIMARY KEY CHECK (meeting_kind <> ''),
        weekdays      TEXT NOT NULL CHECK (weekdays <> ''),
        start_minute  INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
        end_minute    INTEGER NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
        source        TEXT NOT NULL CHECK (source IN ('principal', 'learned')),
        basis         TEXT NOT NULL CHECK (basis <> ''),
        updated_at    TEXT NOT NULL,
        CHECK (start_minute < end_minute)
      );
    `);
  },
};
