import { dateString, nextDate, wallClock, zonedInstant, type LocalDate } from '../gws-ea-whereabouts/clock.js';
import { WEEKDAYS } from '../gws-ea-whereabouts/records.js';
import { whereaboutsAt, zoneAt, type Timeline } from '../gws-ea-whereabouts/timeline.js';

export interface LocalMoment {
  readonly at: number;
  readonly zone: string;
  readonly day: string;
}

/** Try each native zone segment; an unknown stay jumps to its end rather than scanning its dates. */
export function nextLocalMoment(
  timeline: Timeline,
  notBefore: number,
  minute: (day: string, zone: string) => number,
): LocalMoment {
  const zones = new Set([
    timeline.homeZone,
    ...timeline.places.map((place) => place.zone),
    ...timeline.stays.map((stay) => stay.zone),
    ...timeline.legs.map((leg) => leg.departureZone),
  ]);
  const boundaries = [
    ...new Set([
      notBefore,
      ...timeline.stays.flatMap((stay) => [stay.start, ...(stay.end === null ? [] : [stay.end])]),
      ...timeline.legs.flatMap((leg) => [leg.departure, leg.arrival]),
    ]),
  ]
    .filter((at) => at >= notBefore)
    .sort((left, right) => left - right);
  for (const [index, start] of boundaries.entries()) {
    const end = boundaries[index + 1] ?? Number.POSITIVE_INFINITY;
    const current = whereaboutsAt(timeline, start);
    if ((current.stay || current.leg) && current.zone === null) continue;
    let best: LocalMoment | undefined;
    for (const zone of zones) {
      if (zone === null) continue;
      let date: LocalDate = wallClock(start, zone);
      for (let daysAhead = 0; daysAhead <= WEEKDAYS.length; daysAhead++) {
        const day = dateString(date);
        const at = zonedInstant(date, minute(day, zone), zone);
        if (at >= start && at < end && zoneAt(timeline, at) === zone && (best === undefined || at < best.at)) {
          best = { at, zone, day };
        }
        date = nextDate(date);
      }
    }
    if (best) return best;
  }
  throw new Error('The zone in effect is unknown for the next local clock occurrence; record the stay’s zone first.');
}

export function sundayOnOrBefore(at: number, zone: string): string {
  const wall = wallClock(at, zone);
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}
