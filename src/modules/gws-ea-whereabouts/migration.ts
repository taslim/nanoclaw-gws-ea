import type { ModuleMigration } from '../../db/migrations/index.js';

export const gwsEaWhereaboutsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-whereabouts:create-whereabouts',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_places (
        id TEXT PRIMARY KEY CHECK (id <> ''),
        label TEXT NOT NULL CHECK (label <> ''),
        locality TEXT NOT NULL CHECK (locality <> ''),
        zone TEXT,
        private_value_id TEXT REFERENCES gws_ea_private_values(id) ON DELETE SET NULL,
        is_home INTEGER NOT NULL DEFAULT 0 CHECK (is_home IN (0, 1)),
        updated_at TEXT NOT NULL,
        CHECK (is_home = 0 OR zone IS NULL)
      );
      CREATE TABLE gws_ea_whereabouts_base (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        home_place_id TEXT REFERENCES gws_ea_places(id),
        trip_source TEXT,
        rhythm_known INTEGER NOT NULL DEFAULT 0 CHECK (rhythm_known IN (0, 1)),
        updated_at TEXT
      );
      INSERT INTO gws_ea_whereabouts_base (singleton) VALUES (1);
      CREATE TABLE gws_ea_whereabouts_rhythm (
        weekday TEXT PRIMARY KEY CHECK (weekday IN ('mon','tue','wed','thu','fri','sat','sun')),
        place_id TEXT NOT NULL REFERENCES gws_ea_places(id),
        start_minute INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
        end_minute INTEGER NOT NULL CHECK (end_minute > start_minute AND end_minute <= 1440),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE gws_ea_place_pairs (
        from_place_id TEXT NOT NULL REFERENCES gws_ea_places(id),
        to_place_id TEXT NOT NULL REFERENCES gws_ea_places(id),
        mode TEXT NOT NULL CHECK (mode <> ''),
        minutes INTEGER NOT NULL CHECK (minutes >= 0),
        source TEXT NOT NULL CHECK (source IN ('learned','estimated')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (from_place_id, to_place_id, mode)
      );
      CREATE TABLE gws_ea_event_travel (
        event_id TEXT PRIMARY KEY CHECK (event_id <> ''),
        mode TEXT NOT NULL CHECK (mode <> ''),
        minutes INTEGER NOT NULL CHECK (minutes >= 0),
        source TEXT NOT NULL CHECK (source IN ('learned','estimated')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE gws_ea_stays (
        id TEXT PRIMARY KEY,
        place_id TEXT REFERENCES gws_ea_places(id),
        locality TEXT,
        zone TEXT,
        start TEXT NOT NULL,
        end TEXT,
        source TEXT NOT NULL CHECK (source IN ('calendar','mail','said')),
        certainty TEXT NOT NULL CHECK (certainty IN ('certain','tentative')),
        working_hours TEXT NOT NULL CHECK (working_hours IN ('local','home')),
        source_event_id TEXT UNIQUE,
        source_version TEXT,
        derived INTEGER NOT NULL DEFAULT 0 CHECK (derived IN (0, 1)),
        departure_at TEXT,
        departure_zone TEXT,
        updated_at TEXT NOT NULL,
        CHECK ((place_id IS NOT NULL AND locality IS NULL AND zone IS NULL) OR (place_id IS NULL AND locality IS NOT NULL)),
        CHECK (derived = 0 OR (source_event_id IS NOT NULL AND source_version IS NOT NULL AND departure_at IS NOT NULL AND departure_zone IS NOT NULL))
      );
      CREATE TABLE gws_ea_dismissed_travel_events (
        source_event_id TEXT PRIMARY KEY CHECK (source_event_id <> ''),
        dismissed_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason <> '')
      );
      CREATE TABLE gws_ea_whereabouts_history (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('base','rhythm')),
        previous_json TEXT NOT NULL,
        value_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
    `);
  },
};
