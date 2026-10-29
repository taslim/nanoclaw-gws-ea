/**
 * The weekday check (`weekday-check.ts`) with today on the principal's clock,
 * and the refusal an agent reads. It writes nothing, so the calendar tools
 * check an invitation's text the same way the outbound guard checks a message.
 */
import { TIMEZONE } from '../../config.js';
import { loadTimeline, zoneAt } from '../gws-ea-whereabouts/timeline.js';
import { findWeekdayMismatch, type CalendarDate } from './weekday-check.js';

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

async function today(): Promise<CalendarDate> {
  const timeline = await loadTimeline();
  const timezone = zoneAt(timeline, Date.now()) ?? TIMEZONE;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date())
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** Undefined when every weekday `texts` pair with a date falls on it. */
export async function weekdayRefusal(texts: readonly string[]): Promise<string | undefined> {
  const mismatch = findWeekdayMismatch(texts.join('\n'), await today());
  if (mismatch === undefined) return undefined;
  return (
    `it says "${mismatch.written}", but ${LIST.format(mismatch.readings)}. ` +
    'Work the day out with the time tools and write it again; give the year when you mean another one, and put words you quote from someone else in quotation marks.'
  );
}
