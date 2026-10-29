import {
  dateString,
  nextDate,
  parseDate,
  wallClock,
  zonedInstant,
} from '../../../src/modules/gws-ea-whereabouts/clock.js';

export const CLOSE_CASES: ReadonlySet<string> = new Set([
  'close-speaks',
  'close-quiet',
  'sunday-stale-matter',
  'leave-by-look',
]);
export const CLOSE_ZONE = 'America/Los_Angeles';

export function closeDates(referenceAt: string) {
  const today = dateString(wallClock(Date.parse(referenceAt), CLOSE_ZONE));
  const tomorrow = dateString(nextDate(parseDate(today)));
  let due = nextDate(parseDate(today));
  while (new Date(`${dateString(due)}T12:00Z`).getUTCDay() !== 3) due = nextDate(due);
  const at = (day: string, hour: number, minute = 0) =>
    new Date(zonedInstant(parseDate(day), hour * 60 + minute, CLOSE_ZONE)).toISOString();
  return { today, tomorrow, due: dateString(due), at };
}
