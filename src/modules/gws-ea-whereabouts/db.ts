import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { parseLine } from '../../gws-ea/validation.js';
import { ianaTimezone } from '../../timezone.js';
import { getPrivateValue } from '../gws-ea-privacy/db.js';
import { boundary, dateString, iso, wallClock } from './clock.js';
import { signalWhereaboutsChange } from './changes.js';
import type { DerivedLeg } from './derive.js';
import {
  getWhereabouts,
  WEEKDAYS,
  type Base,
  type Certainty,
  type EventTravel,
  type Place,
  type PlacePair,
  type Rhythm,
  type Stay,
  type StaySource,
  type WorkingHours,
} from './records.js';
import { loadTimeline, resolveStay, zoneAt, type TimelineStay } from './timeline.js';

export { getWhereabouts, WEEKDAYS } from './records.js';
export type {
  Base,
  Certainty,
  DismissedEvent,
  EventTravel,
  Place,
  PlacePair,
  Rhythm,
  Stay,
  StaySource,
  TravelSource,
  Whereabouts,
  Weekday,
  WorkingHours,
} from './records.js';

const now = (): string => new Date().toISOString();
const line = (value: string, label: string): string => parseLine(value, label, 280);
function zone(value: string | undefined): string | null {
  if (value === undefined || value === 'unknown') return null;
  const parsed = ianaTimezone(value);
  if (!parsed) throw new Error(`Invalid IANA zone ${JSON.stringify(value)}`);
  return parsed;
}
function member<T extends string>(value: string, values: readonly T[], label: string): T {
  const parsed = values.find((candidate) => candidate === value);
  if (!parsed) throw new Error(`${label} must be ${values.join(' or ')}`);
  return parsed;
}
function clock(value: string, end: boolean): number {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value);
  const minute = match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
  if (!match || Number(match[2]) > 59 || minute < 0 || minute > (end ? 1440 : 1439))
    throw new Error('Use local HH:MM; an end may be 24:00');
  return minute;
}
async function placeById(id: string): Promise<Place> {
  const place = await getDb().get<Place>('SELECT * FROM gws_ea_places WHERE id = ?', id);
  if (!place) throw new Error(`Place ${JSON.stringify(id)} is not set`);
  return place;
}
async function history(kind: 'base' | 'rhythm', previous: unknown, value: unknown): Promise<void> {
  await getDb().run(
    'INSERT INTO gws_ea_whereabouts_history (id, kind, previous_json, value_json, changed_at) VALUES (?, ?, ?, ?, ?)',
    randomUUID(),
    kind,
    JSON.stringify(previous),
    JSON.stringify(value),
    now(),
  );
}

export async function addPlace(input: {
  readonly id?: string;
  readonly label: string;
  readonly locality: string;
  readonly zone?: string;
  readonly privateValueId?: string;
  readonly home?: boolean;
}): Promise<Place> {
  const id = input.id === undefined ? `place-${randomUUID()}` : line(input.id, 'Place id');
  const label = line(input.label, 'Place label');
  const locality = line(input.locality, 'Locality');
  const result = await getDb().transaction(async () => {
    const previous = await getDb().get<Place>('SELECT * FROM gws_ea_places WHERE id = ?', id);
    const privateId = input.privateValueId ?? previous?.private_value_id ?? null;
    if (privateId) {
      const value = await getPrivateValue(privateId);
      if (!value || value.kind !== 'address') throw new Error('Home must link to a stored private address');
    }
    const isHome = input.home || privateId !== null || previous?.is_home === 1;
    const record: Place = {
      id,
      label,
      locality,
      zone: isHome ? null : zone(input.zone),
      private_value_id: privateId,
      is_home: isHome ? 1 : 0,
      updated_at: now(),
    };
    await getDb().run(
      `INSERT INTO gws_ea_places (id, label, locality, zone, private_value_id, is_home, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, locality=excluded.locality, zone=excluded.zone, private_value_id=excluded.private_value_id, is_home=excluded.is_home, updated_at=excluded.updated_at`,
      record.id,
      record.label,
      record.locality,
      record.zone,
      record.private_value_id,
      record.is_home,
      record.updated_at,
    );
    await assertCertainStays();
    return record;
  });
  await signalWhereaboutsChange('place');
  return result;
}

export async function setBase(input: { readonly placeId?: string; readonly tripSource?: string }): Promise<Base> {
  if (input.placeId === undefined && input.tripSource === undefined)
    throw new Error('Set a home place or a trip source');
  const result = await getDb().transaction(async () => {
    const previous = (await getWhereabouts()).base;
    const place = input.placeId === undefined ? undefined : await placeById(input.placeId);
    if (place)
      await getDb().run(
        'UPDATE gws_ea_places SET is_home = 1, zone = NULL, updated_at = ? WHERE id = ?',
        now(),
        place.id,
      );
    const record: Base = {
      ...previous,
      home_place_id: place?.id ?? previous.home_place_id,
      trip_source: input.tripSource === undefined ? previous.trip_source : line(input.tripSource, 'Trip source'),
      updated_at: now(),
    };
    await history('base', previous, record);
    await getDb().run(
      'UPDATE gws_ea_whereabouts_base SET home_place_id = ?, trip_source = ?, updated_at = ? WHERE singleton = 1',
      record.home_place_id,
      record.trip_source,
      record.updated_at,
    );
    await assertCertainStays();
    return record;
  });
  await signalWhereaboutsChange('base');
  return result;
}

export async function setRhythm(input: {
  readonly weekdays: readonly string[];
  readonly placeId?: string;
  readonly start?: string;
  readonly end?: string;
}): Promise<readonly Rhythm[]> {
  const days = [...new Set(input.weekdays.map((day) => member(day, WEEKDAYS, 'Weekday')))];
  if (days.length && (!input.placeId || !input.start || !input.end))
    throw new Error('Commute days need a place, start and end; use weekdays none for no commute');
  const start = days.length ? clock(input.start ?? '', false) : 0;
  const end = days.length ? clock(input.end ?? '', true) : 0;
  if (days.length && end <= start) throw new Error('Rhythm end must follow its start');
  const result = await getDb().transaction(async () => {
    if (days.length) await placeById(input.placeId ?? '');
    const previous = await getWhereabouts();
    if (!days.length) await getDb().run('DELETE FROM gws_ea_whereabouts_rhythm');
    for (const day of days)
      await getDb().run(
        `INSERT INTO gws_ea_whereabouts_rhythm (weekday, place_id, start_minute, end_minute, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(weekday) DO UPDATE SET place_id=excluded.place_id, start_minute=excluded.start_minute, end_minute=excluded.end_minute, updated_at=excluded.updated_at`,
        day,
        input.placeId,
        start,
        end,
        now(),
      );
    await getDb().run('UPDATE gws_ea_whereabouts_base SET rhythm_known = 1, updated_at = ? WHERE singleton = 1', now());
    const current = (await getWhereabouts()).rhythm;
    await history(
      'rhythm',
      { known: Boolean(previous.base.rhythm_known), days: previous.rhythm },
      { known: true, days: current },
    );
    return current;
  });
  await signalWhereaboutsChange('rhythm');
  return result;
}

function travelValue(input: { readonly mode: string; readonly minutes: number; readonly source: string }) {
  if (!Number.isSafeInteger(input.minutes) || input.minutes < 0)
    throw new Error('Travel minutes must be a nonnegative whole number');
  return {
    mode: line(input.mode, 'Travel mode'),
    minutes: input.minutes,
    source: member(input.source, ['learned', 'estimated'], 'Travel source'),
    updated_at: now(),
  };
}
export async function setPlacePair(input: {
  readonly fromPlaceId: string;
  readonly toPlaceId: string;
  readonly mode: string;
  readonly minutes: number;
  readonly source: string;
}): Promise<PlacePair> {
  const record: PlacePair = { from_place_id: input.fromPlaceId, to_place_id: input.toPlaceId, ...travelValue(input) };
  await getDb().transaction(async () => {
    await placeById(input.fromPlaceId);
    await placeById(input.toPlaceId);
    await getDb().run(
      `INSERT INTO gws_ea_place_pairs (from_place_id, to_place_id, mode, minutes, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(from_place_id, to_place_id, mode) DO UPDATE SET minutes=excluded.minutes, source=excluded.source, updated_at=excluded.updated_at`,
      record.from_place_id,
      record.to_place_id,
      record.mode,
      record.minutes,
      record.source,
      record.updated_at,
    );
  });
  await signalWhereaboutsChange('pair');
  return record;
}
export async function setEventTravel(input: {
  readonly eventId: string;
  readonly mode: string;
  readonly minutes: number;
  readonly source: string;
}): Promise<EventTravel> {
  const record: EventTravel = { event_id: line(input.eventId, 'Event id'), ...travelValue(input) };
  await getDb().run(
    `INSERT INTO gws_ea_event_travel (event_id, mode, minutes, source, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET mode=excluded.mode, minutes=excluded.minutes, source=excluded.source, updated_at=excluded.updated_at`,
    record.event_id,
    record.mode,
    record.minutes,
    record.source,
    record.updated_at,
  );
  await signalWhereaboutsChange('travel');
  return record;
}

export interface AddStayInput {
  readonly id?: string;
  readonly placeId?: string;
  readonly locality?: string;
  readonly zone?: string;
  readonly start: string;
  readonly end?: string;
  readonly source: string;
  readonly certainty: string;
  readonly workingHours?: string;
  readonly sourceEventId?: string;
  readonly sourceVersion?: string;
}

function conflicts(a: TimelineStay, b: TimelineStay): boolean {
  const aEnd = a.end ?? Number.POSITIVE_INFINITY;
  const bEnd = b.end ?? Number.POSITIVE_INFINITY;
  if (
    a.certainty !== 'certain' ||
    b.certainty !== 'certain' ||
    a.locality.toLocaleLowerCase() === b.locality.toLocaleLowerCase() ||
    !a.zone ||
    !b.zone ||
    a.zone === b.zone ||
    a.start >= bEnd ||
    b.start >= aEnd
  )
    return false;
  const aInside = a.start >= b.start && aEnd <= bEnd && (a.start > b.start || aEnd < bEnd);
  const bInside = b.start >= a.start && bEnd <= aEnd && (b.start > a.start || bEnd < aEnd);
  return !aInside && !bInside;
}

async function assertCertainStays(): Promise<void> {
  const timeline = await loadTimeline();
  // Resolve the original records: merging same-locality spans must not hide a shorter nested stay.
  const raw = await getWhereabouts();
  const stays = raw.stays.map((stay) => resolveStay(stay, timeline.places, timeline.homeZone));
  for (let i = 0; i < stays.length; i++)
    for (let j = i + 1; j < stays.length; j++) {
      if (conflicts(stays[i], stays[j]))
        throw new Error(
          `Certain stays in ${stays[i].locality} and ${stays[j].locality} overlap; record their dates so one is contained in the other`,
        );
    }
}
async function writeStay(record: Stay): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_stays (id, place_id, locality, zone, start, end, source, certainty, working_hours, source_event_id, source_version, derived, departure_at, departure_zone, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET place_id=excluded.place_id, locality=excluded.locality, zone=excluded.zone, start=excluded.start, end=excluded.end, source=excluded.source, certainty=excluded.certainty, working_hours=excluded.working_hours, source_event_id=excluded.source_event_id, source_version=excluded.source_version, derived=excluded.derived, departure_at=excluded.departure_at, departure_zone=excluded.departure_zone, updated_at=excluded.updated_at`,
    record.id,
    record.place_id,
    record.locality,
    record.zone,
    record.start,
    record.end,
    record.source,
    record.certainty,
    record.working_hours,
    record.source_event_id,
    record.source_version,
    record.derived,
    record.departure_at,
    record.departure_zone,
    record.updated_at,
  );
}

export async function addStay(input: AddStayInput): Promise<Stay> {
  const result = await getDb().transaction(async () => {
    if (input.placeId && (input.locality !== undefined || input.zone !== undefined))
      throw new Error('A stay at a saved place takes its locality and zone from that place');
    const place = input.placeId ? await placeById(input.placeId) : undefined;
    const timeline = await loadTimeline();
    const ownZone = place?.is_home ? timeline.homeZone : (place?.zone ?? zone(input.zone));
    const end = input.end ?? dateString(wallClock(Date.now(), ownZone ?? zoneAt(timeline, Date.now()) ?? 'UTC'));
    const startInstant = boundary(input.start, ownZone ?? timeline.homeZone ?? 'UTC', 'start');
    const endInstant = boundary(end, ownZone ?? timeline.homeZone ?? 'UTC', 'end');
    if (endInstant <= startInstant) throw new Error('Stay end must follow its start; without an end a stay ends today');
    const sourceEventId = input.sourceEventId === undefined ? null : line(input.sourceEventId, 'Source event id');
    const existing = sourceEventId
      ? await getDb().get<Stay>('SELECT * FROM gws_ea_stays WHERE source_event_id = ?', sourceEventId)
      : undefined;
    const record: Stay = {
      id: input.id ?? existing?.id ?? `stay-${randomUUID()}`,
      place_id: place?.id ?? null,
      locality: place ? null : line(input.locality ?? '', 'Stay locality'),
      zone: place ? null : ownZone,
      start: input.start,
      end,
      source: member<StaySource>(input.source, ['calendar', 'mail', 'said'], 'Stay source'),
      certainty: member<Certainty>(input.certainty, ['certain', 'tentative'], 'Certainty'),
      working_hours: member<WorkingHours>(input.workingHours ?? 'local', ['local', 'home'], 'Working hours'),
      source_event_id: sourceEventId,
      source_version: input.sourceVersion ?? null,
      derived: 0,
      departure_at: null,
      departure_zone: null,
      updated_at: now(),
    };
    await writeStay(record);
    await assertCertainStays();
    if (sourceEventId)
      await getDb().run('DELETE FROM gws_ea_dismissed_travel_events WHERE source_event_id = ?', sourceEventId);
    return record;
  });
  await signalWhereaboutsChange('stay');
  return result;
}

export async function dismissStay(input: {
  readonly id?: string;
  readonly sourceEventId?: string;
  readonly reason: string;
}): Promise<{ readonly source_event_id: string | null; readonly dismissed: readonly string[] }> {
  const reason = line(input.reason, 'Dismissal reason');
  if (!input.id && !input.sourceEventId) throw new Error('Dismiss a stay id or source event');
  const result = await getDb().transaction(async () => {
    const stay = input.id ? await getDb().get<Stay>('SELECT * FROM gws_ea_stays WHERE id = ?', input.id) : undefined;
    if (input.id && !stay) throw new Error(`No stay ${input.id} exists`);
    const eventId = input.sourceEventId ?? stay?.source_event_id ?? null;
    if (eventId)
      await getDb().run(
        `INSERT INTO gws_ea_dismissed_travel_events (source_event_id, dismissed_at, reason) VALUES (?, ?, ?)
      ON CONFLICT(source_event_id) DO UPDATE SET dismissed_at=excluded.dismissed_at, reason=excluded.reason`,
        eventId,
        now(),
        reason,
      );
    const ids = eventId
      ? (await getDb().all<{ id: string }>('SELECT id FROM gws_ea_stays WHERE source_event_id = ?', eventId)).map(
          (row) => row.id,
        )
      : [input.id ?? ''];
    for (const id of ids) await getDb().run('DELETE FROM gws_ea_stays WHERE id = ?', id);
    await linkDerivedEnds();
    return { source_event_id: eventId, dismissed: ids };
  });
  await signalWhereaboutsChange('dismissal');
  return result;
}

/** Calendar read windows cover source events whose flight spans overlap the window. */
export interface DerivationWindow {
  readonly start: number;
  readonly end: number;
}
async function linkDerivedEnds(): Promise<boolean> {
  const rows = await getDb().all<Stay>(
    'SELECT * FROM gws_ea_stays WHERE derived = 1 ORDER BY departure_at, source_event_id',
  );
  let changed = false;
  for (let i = 0; i < rows.length; i++) {
    const end = rows[i + 1]?.departure_at ?? null;
    if (rows[i].end !== end) {
      await getDb().run('UPDATE gws_ea_stays SET end = ?, updated_at = ? WHERE id = ?', end, now(), rows[i].id);
      changed = true;
    }
  }
  return changed;
}
export async function syncDerivedStays(
  legs: readonly DerivedLeg[],
  window: DerivationWindow,
): Promise<{ readonly changed: boolean }> {
  if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.end <= window.start)
    throw new Error('A derivation window must have ordered instant bounds');
  const changed = await getDb().transaction(async () => {
    const raw = await getWhereabouts();
    const dismissed = new Set(raw.dismissed_events.map((event) => event.source_event_id));
    const supplied = new Set(legs.map((leg) => leg.sourceEventId));
    let edited = false;
    for (const stay of raw.stays)
      if (
        stay.derived &&
        stay.departure_at &&
        Date.parse(stay.start) > window.start &&
        Date.parse(stay.departure_at) < window.end &&
        !supplied.has(stay.source_event_id ?? '')
      ) {
        await getDb().run('DELETE FROM gws_ea_stays WHERE id = ?', stay.id);
        edited = true;
      }
    for (const leg of legs) {
      if (dismissed.has(leg.sourceEventId)) continue;
      const held = raw.stays.find((stay) => stay.source_event_id === leg.sourceEventId);
      const place = raw.places.find((p) => p.locality.toLocaleLowerCase() === leg.locality.toLocaleLowerCase());
      const record: Stay = {
        id: held?.id ?? `stay-${randomUUID()}`,
        place_id: place?.id ?? null,
        locality: place ? null : leg.locality,
        zone: place ? null : zone(leg.destinationZone),
        start: iso(leg.arrival),
        end: held?.derived ? held.end : null,
        source: 'calendar',
        certainty: 'certain',
        working_hours: held?.working_hours ?? 'local',
        source_event_id: leg.sourceEventId,
        source_version: leg.sourceVersion,
        derived: 1,
        departure_at: iso(leg.departure),
        departure_zone: zone(leg.departureZone),
        updated_at: now(),
      };
      const { updated_at: _oldTime, ...oldValue } = held ?? record;
      const { updated_at: _newTime, ...newValue } = record;
      if (!held || JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        await writeStay(record);
        edited = true;
      }
    }
    if (await linkDerivedEnds()) edited = true;
    await assertCertainStays();
    return edited;
  });
  if (changed) await signalWhereaboutsChange('derived');
  return { changed };
}

export interface WhereaboutsHistory {
  readonly id: string;
  readonly kind: 'base' | 'rhythm';
  readonly previous: unknown;
  readonly value: unknown;
  readonly changed_at: string;
}
export async function getWhereaboutsHistory(): Promise<WhereaboutsHistory[]> {
  const rows = await getDb().all<{
    id: string;
    kind: 'base' | 'rhythm';
    previous_json: string;
    value_json: string;
    changed_at: string;
  }>('SELECT * FROM gws_ea_whereabouts_history ORDER BY changed_at, rowid');
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    previous: JSON.parse(row.previous_json) as unknown,
    value: JSON.parse(row.value_json) as unknown,
    changed_at: row.changed_at,
  }));
}

/** Deletes each base change whose trip source, before or after, `names` matches. */
export async function clearTripSourceHistory(names: (tripSource: string) => boolean): Promise<void> {
  for (const entry of await getWhereaboutsHistory()) {
    if (entry.kind !== 'base') continue;
    const sources = [entry.previous, entry.value].map((base) => (base as Base).trip_source);
    if (sources.some((source) => source !== null && names(source)))
      await getDb().run('DELETE FROM gws_ea_whereabouts_history WHERE id = ?', entry.id);
  }
}
