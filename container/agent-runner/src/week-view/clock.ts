import fs from 'node:fs';
import { DateTime } from 'luxon';

export const WEEK_VIEW_FILE = '/workspace/week-view.json';
export const WEEK_VIEW_MAX_BYTES = 1_048_576;
export type ClockSource = 'zone in effect' | 'home zone';
interface ClockStay {
  readonly ids: readonly string[];
  readonly zone: string | null;
  readonly start: number;
  readonly end: number | null;
  readonly certainty: 'certain' | 'tentative';
}
interface ClockLeg {
  readonly departure: number;
  readonly arrival: number;
  readonly departureZone: string;
}
interface ClockPlace {
  readonly id: string;
  readonly zone: string | null;
}
interface ClockRhythm {
  readonly weekday: string;
  readonly start_minute: number;
  readonly end_minute: number;
  readonly place_id: string;
}
export interface ClockTimeline {
  readonly homeZone: string | null;
  readonly base: { readonly home_place_id: string | null };
  readonly places: readonly ClockPlace[];
  readonly rhythm: readonly ClockRhythm[];
  readonly stays: readonly ClockStay[];
  readonly legs: readonly ClockLeg[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const zone = (value: unknown): value is string => typeof value === 'string' && DateTime.now().setZone(value).isValid;
const nullableZone = (value: unknown): value is string | null => value === null || zone(value);
function list<T>(value: unknown, parse: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const values: T[] = [];
  for (const entry of value) {
    const parsed = parse(entry);
    if (parsed === null) return null;
    values.push(parsed);
  }
  return values;
}
export function parseClockTimeline(value: unknown): ClockTimeline | null {
  if (
    !record(value) ||
    !nullableZone(value.homeZone) ||
    !record(value.base) ||
    !(value.base.home_place_id === null || typeof value.base.home_place_id === 'string')
  )
    return null;
  const stays = list(value.stays, (s): ClockStay | null =>
    record(s) &&
    Array.isArray(s.ids) &&
    s.ids.every((id): id is string => typeof id === 'string') &&
    nullableZone(s.zone) &&
    finite(s.start) &&
    (s.end === null || finite(s.end)) &&
    (s.certainty === 'certain' || s.certainty === 'tentative')
      ? { ids: s.ids, zone: s.zone, start: s.start, end: s.end, certainty: s.certainty }
      : null,
  );
  const legs = list(value.legs, (l): ClockLeg | null =>
    record(l) && finite(l.departure) && finite(l.arrival) && zone(l.departureZone)
      ? { departure: l.departure, arrival: l.arrival, departureZone: l.departureZone }
      : null,
  );
  const places = list(value.places, (p): ClockPlace | null =>
    record(p) && typeof p.id === 'string' && nullableZone(p.zone) ? { id: p.id, zone: p.zone } : null,
  );
  const rhythm = list(value.rhythm, (r): ClockRhythm | null =>
    record(r) &&
    typeof r.weekday === 'string' &&
    finite(r.start_minute) &&
    finite(r.end_minute) &&
    typeof r.place_id === 'string'
      ? { weekday: r.weekday, start_minute: r.start_minute, end_minute: r.end_minute, place_id: r.place_id }
      : null,
  );
  return stays && legs && places && rhythm
    ? {
        homeZone: value.homeZone,
        base: { home_place_id: value.base.home_place_id },
        stays,
        legs,
        places,
        rhythm,
      }
    : null;
}

/** Read one bounded snapshot per operation; malformed or unavailable views use the home clock. */
export function readWeekViewFile(file = WEEK_VIEW_FILE): Record<string, unknown> | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > WEEK_VIEW_MAX_BYTES) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    const read = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (read > stat.size) return null;
    const value: unknown = JSON.parse(bytes.subarray(0, read).toString('utf8'));
    return record(value) ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error)) return null;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
export function readClockTimeline(file = WEEK_VIEW_FILE): ClockTimeline | null {
  const value = readWeekViewFile(file);
  return value ? parseClockTimeline(value.timeline) : null;
}
const end = (s: ClockStay) => s.end ?? Number.POSITIVE_INFINITY;
function covering(timeline: ClockTimeline, at: number): ClockStay | undefined {
  return timeline.stays
    .filter((s) => s.start <= at && at < end(s))
    .sort(
      (a, b) =>
        Number(b.certainty === 'certain') - Number(a.certainty === 'certain') ||
        end(a) - a.start - (end(b) - b.start) ||
        (a.ids[0] ?? '').localeCompare(b.ids[0] ?? ''),
    )[0];
}
export function timelineZoneAt(timeline: ClockTimeline, at: number): string | null {
  const leg = timeline.legs.find((l) => l.departure <= at && at < l.arrival);
  if (leg) return leg.departureZone;
  const stay = covering(timeline, at);
  if (stay) return stay.zone;
  let place = timeline.places.find((p) => p.id === timeline.base.home_place_id);
  if (timeline.homeZone) {
    const local = DateTime.fromMillis(at, { zone: timeline.homeZone });
    const weekday = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'][local.weekday - 1];
    const minute = local.hour * 60 + local.minute;
    const rule = timeline.rhythm.find(
      (r) => r.weekday === weekday && r.start_minute <= minute && minute < r.end_minute,
    );
    if (rule) place = timeline.places.find((p) => p.id === rule.place_id);
  }
  return place?.zone ?? timeline.homeZone;
}
export function timelineZoneForDay(timeline: ClockTimeline, day: string): string | null {
  const departing = timeline.legs.find(
    (l) => DateTime.fromMillis(l.departure, { zone: l.departureZone }).toISODate() === day,
  );
  const midnight = (z: string) => DateTime.fromISO(day, { zone: z }).startOf('day').toMillis();
  if (departing) return covering(timeline, midnight(departing.departureZone))?.zone ?? departing.departureZone;
  const zones = new Set([
    timeline.homeZone,
    ...timeline.stays.map((s) => s.zone),
    ...timeline.legs.map((l) => l.departureZone),
  ]);
  const candidates = [...zones]
    .filter((z): z is string => z !== null)
    .map((z) => ({ zone: z, instant: midnight(z) }))
    .sort((a, b) => a.instant - b.instant);
  for (const candidate of candidates)
    if (timelineZoneAt(timeline, candidate.instant) === candidate.zone) return candidate.zone;
  return timelineZoneAt(timeline, midnight(timeline.homeZone ?? 'UTC'));
}
