/**
 * Why words cannot go out as written: a weekday beside a date it does not
 * fall on (`weekday-check.ts`), with a date without a year read from today on
 * the principal's clock. No side effects, so the calendar tools check the
 * text of an invitation the same way the outbound guard checks a message.
 */
import { TIMEZONE } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import { findWeekdayMismatch, type CalendarDate } from './weekday-check.js';

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** Today's date on the principal's clock. */
async function today(): Promise<CalendarDate> {
  const timezone = (await getDb().hasTable('gws_ea_profile'))
    ? ((await getGwsEaProfile()).principal_timezone ?? TIMEZONE)
    : TIMEZONE;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date())
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * Why `texts` cannot go out as written, or undefined when every weekday they
 * pair with a date falls on it.
 */
export async function weekdayRefusal(texts: readonly string[]): Promise<string | undefined> {
  const mismatch = findWeekdayMismatch(texts.join('\n'), await today());
  if (mismatch === undefined) return undefined;
  return (
    `it says "${mismatch.written}", but ${LIST.format(mismatch.readings)}. ` +
    'Work the day out with the time tools and write it again; give the year when you mean another one, and put words you quote from someone else in quotation marks.'
  );
}
