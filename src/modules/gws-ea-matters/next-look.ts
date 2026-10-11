import { CronExpressionParser, type CronExpression } from 'cron-parser';

import { hasControlCharacters } from '../../gws-ea/validation.js';
import { parseZonedToUtc } from '../../timezone.js';
import { MAX_DAILY_FIRES } from '../scheduling/create.js';

/**
 * A matter's next look as `main` asks for it (KTD4): once, at a time, or
 * repeating on a cron expression read in the principal's time zone, as the
 * look for a yearly date does (R24). The scheduled task made from it is the
 * matter's only clock, so the matter stores the task's id and never the time.
 */
export type NextLook =
  | { readonly kind: 'once'; /** UTC, ISO 8601. */ readonly at: string }
  | { readonly kind: 'repeat'; /** Five fields, single-spaced. */ readonly cron: string };

/** Unvalidated caller input: `--look` and `--look-cron`. */
export interface NextLookInput {
  readonly at?: string;
  readonly cron?: string;
}

/** A date and a time to the minute, then optional seconds and an optional UTC offset. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/u;
const LOOK_MAX_LENGTH = 40;
const CRON_MAX_LENGTH = 120;
const YEAR_MS = 366 * 24 * 60 * 60 * 1000;

function notATime(value: string): Error {
  return new Error(
    `--look must be a date and time, such as 2026-10-14T09:00 in the principal's time zone or 2026-10-14T09:00:00-04:00 with its UTC offset; got ${JSON.stringify(value)}`,
  );
}

/** Whether the written date and time exist on the calendar: JavaScript would roll 30 February into March. */
function onCalendar(parts: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map((part) => Number(part ?? '0'));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function once(value: string, timezone: string, now: Date): NextLook {
  const text = value.trim();
  const parts = text.length <= LOOK_MAX_LENGTH ? DATE_TIME.exec(text) : null;
  if (parts === null || !onCalendar(parts)) throw notATime(value);
  const at = parseZonedToUtc(text, timezone);
  if (!Number.isFinite(at.getTime())) throw notATime(value);
  if (at.getTime() <= now.getTime()) throw new Error('--look must be in the future');
  return { kind: 'once', at: at.toISOString() };
}

/** The interval's next run, or a refusal naming the expression when it has none. */
function nextRun(interval: CronExpression, cron: string): number {
  try {
    return interval.next().getTime();
  } catch (error) {
    throw new Error(`--look-cron ${JSON.stringify(cron)} has no upcoming run`, { cause: error });
  }
}

/**
 * A repeating look comes back at most as often as core lets a task repeat
 * without a gate. Core lets a task with a script repeat faster because the
 * script can skip a run; a look's script wakes `main` whenever its matter
 * is open, so the limit holds for looks too. It holds on every day of the
 * year ahead, counted on the principal's calendar, so a cron that comes back
 * often only on weekdays is refused on a Saturday too, and one that comes
 * back four times a day stays allowed on the day the clocks change.
 */
function repeating(value: string, timezone: string, now: Date): NextLook {
  if (value.length > CRON_MAX_LENGTH || hasControlCharacters(value)) {
    throw new Error(`--look-cron must be one line of at most ${CRON_MAX_LENGTH} characters`);
  }
  const fields = value.trim().split(/ +/u);
  if (fields.length !== 5) {
    throw new Error(
      '--look-cron must have five fields (minute, hour, day of month, month, day of week), such as "0 9 14 3 *" for 14 March at 09:00',
    );
  }
  const cron = fields.join(' ');
  let interval: CronExpression;
  try {
    interval = CronExpressionParser.parse(cron, { tz: timezone, currentDate: now });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`--look-cron ${JSON.stringify(cron)} is not a cron expression: ${reason}`, { cause: error });
  }
  const horizon = now.getTime() + YEAR_MS;
  const dayOf = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const firesOn = new Map<string, number>();
  for (let run = nextRun(interval, cron); run <= horizon; run = nextRun(interval, cron)) {
    const day = dayOf.format(run);
    const fires = (firesOn.get(day) ?? 0) + 1;
    if (fires > MAX_DAILY_FIRES) {
      throw new Error(
        `--look-cron ${JSON.stringify(cron)} would come back more than ${MAX_DAILY_FIRES} times a day: set a one-off --look for what needs a closer eye`,
      );
    }
    firesOn.set(day, fires);
  }
  return { kind: 'repeat', cron };
}

/**
 * The next look `input` asks for, read in `timezone`, or undefined when it
 * asks for none. A one-off look must be in the future; a repeating one must
 * have an upcoming run.
 */
export function parseNextLook(input: NextLookInput, timezone: string, now: Date = new Date()): NextLook | undefined {
  if (input.at !== undefined && input.cron !== undefined) {
    throw new Error('Give either --look or --look-cron: a matter has one next look');
  }
  if (input.at !== undefined) return once(input.at, timezone, now);
  if (input.cron !== undefined) return repeating(input.cron, timezone, now);
  return undefined;
}
