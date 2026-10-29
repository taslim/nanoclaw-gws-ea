import { getDb } from '../../db/connection.js';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type StaySource = 'calendar' | 'mail' | 'said';
export type Certainty = 'certain' | 'tentative';
export type WorkingHours = 'local' | 'home';
export type TravelSource = 'learned' | 'estimated';

export interface Place {
  readonly id: string;
  readonly label: string;
  readonly locality: string;
  /** Null while the place is home: its zone belongs only to the profile. */
  readonly zone: string | null;
  readonly private_value_id: string | null;
  readonly updated_at: string;
}
export interface Base {
  readonly home_place_id: string | null;
  /** Null means unknown; "none" is a recorded answer. */
  readonly trip_source: string | null;
  readonly rhythm_known: number;
  readonly updated_at: string | null;
}
export interface Rhythm {
  readonly weekday: Weekday;
  readonly place_id: string;
  readonly start_minute: number;
  readonly end_minute: number;
  readonly updated_at: string;
}
export interface Travel {
  readonly mode: string;
  readonly minutes: number;
  readonly source: TravelSource;
  readonly updated_at: string;
}
export interface PlacePair extends Travel {
  readonly from_place_id: string;
  readonly to_place_id: string;
}
export interface EventTravel extends Travel {
  readonly event_id: string;
}
export interface Stay {
  readonly id: string;
  readonly place_id: string | null;
  readonly locality: string | null;
  readonly zone: string | null;
  /** Date bounds include the end day; instant bounds use an exclusive end. */
  readonly start: string;
  readonly end: string | null;
  readonly source: StaySource;
  readonly certainty: Certainty;
  readonly working_hours: WorkingHours;
  readonly source_event_id: string | null;
  readonly source_version: string | null;
  readonly derived: number;
  readonly departure_at: string | null;
  readonly departure_zone: string | null;
  readonly updated_at: string;
}
export interface DismissedEvent {
  readonly source_event_id: string;
  readonly dismissed_at: string;
  readonly reason: string;
}
export interface Whereabouts {
  readonly base: Base;
  readonly places: readonly Place[];
  readonly rhythm: readonly Rhythm[];
  readonly pairs: readonly PlacePair[];
  readonly travel: readonly EventTravel[];
  readonly stays: readonly Stay[];
  readonly dismissed_events: readonly DismissedEvent[];
}

/** Internal read boundary shared by the writer and snapshot loader, without an import cycle. */
export async function getWhereabouts(): Promise<Whereabouts> {
  const db = getDb();
  const base = await db.get<Base>(
    'SELECT home_place_id, trip_source, rhythm_known, updated_at FROM gws_ea_whereabouts_base WHERE singleton = 1',
  );
  if (!base) throw new Error('Whereabouts store is not initialized');
  return {
    base,
    places: await db.all<Place>('SELECT * FROM gws_ea_places ORDER BY id'),
    rhythm: await db.all<Rhythm>('SELECT * FROM gws_ea_whereabouts_rhythm ORDER BY weekday'),
    pairs: await db.all<PlacePair>('SELECT * FROM gws_ea_place_pairs ORDER BY from_place_id, to_place_id, mode'),
    travel: await db.all<EventTravel>('SELECT * FROM gws_ea_event_travel ORDER BY event_id'),
    stays: await db.all<Stay>('SELECT * FROM gws_ea_stays ORDER BY start, id'),
    dismissed_events: await db.all<DismissedEvent>(
      'SELECT * FROM gws_ea_dismissed_travel_events ORDER BY source_event_id',
    ),
  };
}
