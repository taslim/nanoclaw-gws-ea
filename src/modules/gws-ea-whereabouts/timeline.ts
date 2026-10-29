import { createHash } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import { boundary, dateString, parseDate, wallClock, zonedInstant } from './clock.js';
import {
  getWhereabouts,
  WEEKDAYS,
  type Base,
  type Certainty,
  type DismissedEvent,
  type EventTravel,
  type Place,
  type PlacePair,
  type Rhythm,
  type Stay,
  type WorkingHours,
} from './records.js';

export interface TimelineStay {
  readonly ids: readonly string[];
  readonly sourceEventIds: readonly string[];
  readonly placeId: string | null;
  /** Null for a stay known only by its zone, such as one derived from a flight. */
  readonly locality: string | null;
  readonly zone: string | null;
  readonly start: number;
  readonly end: number | null;
  readonly certainty: Certainty;
  readonly workingHours: WorkingHours;
  readonly derived: boolean;
}
export interface TimelineLeg {
  readonly sourceEventId: string;
  readonly departure: number;
  readonly arrival: number;
  readonly departureZone: string;
  readonly destinationZone: string | null;
  readonly returnUnknown: boolean;
}
export interface Timeline {
  readonly version: string;
  readonly homeZone: string | null;
  readonly base: Base;
  readonly places: readonly Place[];
  readonly rhythm: readonly Rhythm[];
  readonly pairs: readonly PlacePair[];
  readonly travel: readonly EventTravel[];
  readonly stays: readonly TimelineStay[];
  readonly legs: readonly TimelineLeg[];
  readonly dismissedEvents: readonly DismissedEvent[];
}
export interface WhereaboutsAt {
  readonly locality: string | null;
  readonly placeId: string | null;
  readonly zone: string | null;
  readonly zoneLabel: string;
  readonly certainty: Certainty | null;
  readonly workingHoursZone: string | null;
  readonly stay: TimelineStay | null;
  readonly leg: TimelineLeg | null;
}

/** Store bounds resolve against `places` as `loadTimeline` resolves them, with home on the live profile zone. */
export function resolveStay(stay: Stay, places: readonly Place[], homeZone: string | null): TimelineStay {
  const place = places.find((p) => p.id === stay.place_id);
  const zone = place ? place.zone : stay.zone;
  const boundaryZone = zone ?? homeZone ?? 'UTC';
  return {
    ids: [stay.id],
    sourceEventIds: stay.source_event_id ? [stay.source_event_id] : [],
    placeId: stay.place_id,
    locality: place?.locality ?? stay.locality,
    zone,
    start: boundary(stay.start, boundaryZone, 'start'),
    end: stay.end === null ? null : boundary(stay.end, boundaryZone, 'end'),
    certainty: stay.certainty,
    workingHours: stay.working_hours,
    derived: stay.derived === 1,
  };
}

const endOf = (stay: TimelineStay): number => stay.end ?? Number.POSITIVE_INFINITY;

/** A stay known only by its zone agrees with any locality in that zone. */
function sameLocality(a: string | null, b: string | null): boolean {
  return a === null || b === null || a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

function mergeStays(values: readonly TimelineStay[]): TimelineStay[] {
  const result: TimelineStay[] = [];
  for (const value of [...values].sort((a, b) => a.start - b.start || endOf(a) - endOf(b))) {
    const index = result.findIndex(
      (s) =>
        sameLocality(s.locality, value.locality) &&
        s.zone === value.zone &&
        s.certainty === value.certainty &&
        s.workingHours === value.workingHours &&
        endOf(s) >= value.start &&
        endOf(value) >= s.start,
    );
    if (index < 0) {
      result.push(value);
      continue;
    }
    const held = result[index];
    result[index] = {
      ...held,
      locality: held.locality ?? value.locality,
      ids: [...held.ids, ...value.ids],
      sourceEventIds: [...held.sourceEventIds, ...value.sourceEventIds],
      start: Math.min(held.start, value.start),
      end: held.end === null || value.end === null ? null : Math.max(held.end, value.end),
      derived: held.derived && value.derived,
    };
  }
  return result;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Every reader in an operation retains this snapshot rather than loading between decisions. */
export async function loadTimeline(): Promise<Timeline> {
  return getDb().transaction(async () => {
    const raw = await getWhereabouts();
    const homeZone = (await getGwsEaProfile()).principal_timezone;
    const places = raw.places.map((place) => ({
      ...place,
      zone: place.id === raw.base.home_place_id ? homeZone : place.zone,
    }));
    const resolved = raw.stays.map((stay) => resolveStay(stay, places, homeZone));
    const legs = raw.stays
      .flatMap((stay) => {
        if (!stay.derived || !stay.source_event_id || !stay.departure_at || !stay.departure_zone) return [];
        const destination = resolved.find((s) => s.ids.includes(stay.id));
        if (!destination) return [];
        return [
          {
            sourceEventId: stay.source_event_id,
            departure: Date.parse(stay.departure_at),
            arrival: destination.start,
            departureZone: stay.departure_zone,
            destinationZone: destination.zone,
            returnUnknown: destination.end === null,
          },
        ];
      })
      .sort((a, b) => a.departure - b.departure);
    const version = createHash('sha256')
      .update(JSON.stringify([raw, homeZone]))
      .digest('hex');
    return freeze({
      version,
      homeZone,
      base: raw.base,
      places,
      rhythm: raw.rhythm,
      pairs: raw.pairs,
      travel: raw.travel,
      stays: mergeStays(resolved),
      legs,
      dismissedEvents: raw.dismissed_events,
    });
  });
}

function coveringStay(timeline: Timeline, instant: number): TimelineStay | undefined {
  return timeline.stays
    .filter((s) => s.start <= instant && instant < endOf(s))
    .sort(
      (a, b) =>
        Number(b.certainty === 'certain') - Number(a.certainty === 'certain') ||
        endOf(a) - a.start - (endOf(b) - b.start) ||
        a.ids[0].localeCompare(b.ids[0]),
    )[0];
}

export function whereaboutsAt(timeline: Timeline, instant: number): WhereaboutsAt {
  const leg = timeline.legs.find((l) => l.departure <= instant && instant < l.arrival) ?? null;
  const stay = coveringStay(timeline, instant) ?? null;
  let place = timeline.places.find((p) => p.id === timeline.base.home_place_id);
  if (!leg && !stay && timeline.homeZone) {
    const wall = wallClock(instant, timeline.homeZone);
    const weekday = WEEKDAYS[(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay() + 6) % 7];
    const minute = wall.hour * 60 + wall.minute;
    const rhythm = timeline.rhythm.find(
      (r) => r.weekday === weekday && r.start_minute <= minute && minute < r.end_minute,
    );
    if (rhythm) place = timeline.places.find((p) => p.id === rhythm.place_id);
  }
  const zone = leg ? leg.departureZone : stay ? stay.zone : (place?.zone ?? timeline.homeZone);
  return {
    locality: leg ? leg.departureZone : stay ? stay.locality : (place?.locality ?? null),
    placeId: leg ? null : stay ? stay.placeId : (place?.id ?? null),
    zone,
    zoneLabel: zone ?? 'zone unknown',
    certainty: leg ? 'certain' : (stay?.certainty ?? null),
    workingHoursZone: stay?.workingHours === 'home' ? timeline.homeZone : zone,
    stay,
    leg,
  };
}

export function zoneAt(timeline: Timeline, instant: number): string | null {
  return whereaboutsAt(timeline, instant).zone;
}

export interface ZoneSegment {
  readonly start: number;
  readonly end: number;
  readonly zone: string | null;
}

/** Spans from `from` between stay and leg boundaries, each with the zone in effect at its start. */
export function zoneSegments(timeline: Timeline, from: number): ZoneSegment[] {
  const points = [
    ...new Set([
      from,
      ...timeline.stays.flatMap((stay) => (stay.end === null ? [stay.start] : [stay.start, stay.end])),
      ...timeline.legs.flatMap((leg) => [leg.departure, leg.arrival]),
    ]),
  ]
    .filter((point) => point >= from)
    .sort((a, b) => a - b);
  return points.map((start, i) => ({
    start,
    end: points[i + 1] ?? Number.POSITIVE_INFINITY,
    zone: zoneAt(timeline, start),
  }));
}

/** A travel day starts on its departure clock, even if a westward arrival repeats its date. */
export function zoneForDay(timeline: Timeline, day: string): string | null {
  const date = parseDate(day);
  const departing = timeline.legs.find((leg) => dateString(wallClock(leg.departure, leg.departureZone)) === day);
  if (departing) {
    const midnight = zonedInstant(date, 0, departing.departureZone);
    const stay = coveringStay(timeline, midnight);
    return stay?.zone ?? departing.departureZone;
  }
  const zones = new Set([
    timeline.homeZone,
    ...timeline.stays.map((s) => s.zone),
    ...timeline.legs.map((l) => l.departureZone),
  ]);
  const candidates = [...zones]
    .filter((zone): zone is string => zone !== null)
    .map((zone) => ({ zone, instant: zonedInstant(date, 0, zone) }))
    .sort((a, b) => a.instant - b.instant);
  for (const candidate of candidates) if (zoneAt(timeline, candidate.instant) === candidate.zone) return candidate.zone;
  return zoneAt(timeline, zonedInstant(date, 0, timeline.homeZone ?? 'UTC'));
}
