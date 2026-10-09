/**
 * Finds a weekday written beside a date it does not fall on, such as
 * "Friday 15 October" when 15 October 2026 is a Thursday. Pure: no clock of
 * its own, no store.
 *
 * Only an explicit pair counts: a weekday with a day of the month and a
 * month, in the ways people write them —
 *
 *   Thursday 15 October 2026 · Thu, 15 Oct · Thursday the 15th of October
 *   Thursday, October 15th, 2026 · Thu Oct 15 · Thursday 2026-10-15
 *   Thursday 15/10 (and 10/15: either reading may agree)
 *   15 October (Thursday)
 *   Mon 12, Tue 13 and Wed 14 October · Mon 28 – Fri 2 Oct
 *   Monday to Friday, 12–16 October
 *
 * A weekday alone ("Tuesday at 12:30"), a day without a month ("Friday the
 * 13th"), a time ("Friday 10:30"), or a count ("Monday, 5 people") is never a
 * pair. Lower-case "wed", "sat", "sun", "may", "march" or "august" are words,
 * not dates. Text in double quotation marks, in a quoted block (lines that
 * start with ">"), or inside untrusted-content markers is someone else's
 * words, and is not read.
 *
 * A date without a year reads as its next occurrence within a year, or, when
 * it fell in the last four months, that one too: the pair stands when either
 * reading agrees, so a date the writer meant in the recent past is never
 * refused for next year's weekday.
 */

/** A calendar date; `month` runs 1 to 12. */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface WeekdayMismatch {
  /** The words as written, such as "Friday 15 October". */
  readonly written: string;
  /** The weekday they name, in full. */
  readonly weekday: string;
  /** Each reading of the date, with the weekday it falls on: "15 October 2026 is a Thursday". */
  readonly readings: readonly string[];
}

const WEEKDAYS = 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday'.split(' ');
const MONTHS = 'January February March April May June July August September October November December'.split(' ');

/** Short forms people write, each to its weekday (0 is Sunday) or month (1 is January). */
const WEEKDAY_SHORT = new Map<string, number>([
  ...WEEKDAYS.map((name, index) => [name.slice(0, 3).toLowerCase(), index] as const),
  ['tues', 2],
  ['weds', 3],
  ['thur', 4],
  ['thurs', 4],
]);
const MONTH_SHORT = new Map<string, number>([
  ...MONTHS.map((name, index) => [name.slice(0, 3).toLowerCase(), index + 1] as const),
  ['sept', 9],
]);
/** Month names that are also everyday words: read as a month only when capitalized. */
const MONTH_WORDS = new Set(['may', 'march', 'august']);

/** How far back a date without a year may be read, as a day just gone. */
const RECENT_DAYS = 120;
/** How far ahead a date without a year is read: its next occurrence. */
const AHEAD_DAYS = 366;
const DAY_MS = 86_400_000;

/** Where a token sits in the text. */
interface At {
  readonly start: number;
  readonly end: number;
}
type Token = At &
  (
    | { readonly kind: 'weekday' | 'month'; readonly value: number }
    | { readonly kind: 'number'; readonly value: number; readonly ordinal: boolean }
    | { readonly kind: 'iso'; readonly date: CalendarDate }
    | { readonly kind: 'numeric'; readonly first: number; readonly second: number; readonly year: number | undefined }
    | { readonly kind: 'word'; readonly value: 'the' | 'of' | 'at' | 'from' }
    /** `stop` ends a sentence or clause: a full stop, ?, !, ; or a line break. */
    | { readonly kind: 'link' | 'open' | 'close' | 'comma' | 'stop' | 'other' }
  );
/** A weekday or a month, with which one it is. */
type Named = At & { readonly kind: 'weekday' | 'month'; readonly value: number };

const TOKEN =
  /(\d{4}-\d{2}-\d{2})|(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?|(\d{1,2})(st|nd|rd|th)?(?![\d:./]?\d)(?![a-z])|(\d+(?:[:.]\d+)*[a-z]*)|([A-Za-z]+)(\.)?|([–—-]|&)|(,)|(\()|(\))|([.?!;\n])|(\S)/gu;
const LINK_WORDS = new Set(['to', 'through', 'thru', 'until', 'till', 'and', 'or']);

/** Quoted words, quoted blocks and untrusted text, blanked out so they are never read; positions are kept. */
function ownWords(text: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/gu, ' ');
  return text
    .replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gu, blank)
    .replace(/^[ \t]*>.*$/gmu, blank)
    .replace(/"[^"\n]*"|“[^”\n]*”/gu, blank);
}

function weekdayOf(word: string): number | undefined {
  const lower = word.toLowerCase();
  const full = WEEKDAYS.findIndex((name) => name.toLowerCase() === lower);
  if (full >= 0) return full;
  const short = WEEKDAY_SHORT.get(lower);
  // A short form is a weekday only when written as one: "Wed", "WED", never "wed".
  return short !== undefined && word[0] === word[0].toUpperCase() ? short : undefined;
}

function monthOf(word: string): number | undefined {
  const lower = word.toLowerCase();
  const capitalized = word[0] === word[0].toUpperCase();
  const full = MONTHS.findIndex((name) => name.toLowerCase() === lower);
  if (full >= 0) return MONTH_WORDS.has(lower) && !capitalized ? undefined : full + 1;
  const short = MONTH_SHORT.get(lower);
  return short !== undefined && capitalized ? short : undefined;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    const end = start + match[0].length;
    const [
      ,
      iso,
      firstPart,
      secondPart,
      numericYear,
      day,
      ordinal,
      otherNumber,
      word,
      period,
      link,
      comma,
      open,
      close,
      stop,
    ] = match;
    if (iso !== undefined) {
      const [year, month, dayOfMonth] = iso.split('-').map(Number);
      tokens.push({ kind: 'iso', date: { year, month, day: dayOfMonth }, start, end });
    } else if (firstPart !== undefined && secondPart !== undefined) {
      tokens.push({
        kind: 'numeric',
        first: Number(firstPart),
        second: Number(secondPart),
        year: numericYear === undefined ? undefined : Number(numericYear),
        start,
        end,
      });
    } else if (day !== undefined) {
      tokens.push({ kind: 'number', value: Number(day), ordinal: ordinal !== undefined, start, end });
    } else if (otherNumber !== undefined) {
      // A year, or a number that is no day of a month: a time, a count, a figure.
      const value = /^\d{4}$/u.test(otherNumber) ? Number(otherNumber) : NaN;
      tokens.push(
        Number.isNaN(value) ? { kind: 'other', start, end } : { kind: 'number', value, ordinal: false, start, end },
      );
    } else if (word !== undefined) {
      // A full stop after a word ends a short form ("Oct.") or the sentence, never the date.
      const end = start + word.length;
      const weekday = weekdayOf(word);
      const month = weekday === undefined ? monthOf(word) : undefined;
      const lower = word.toLowerCase();
      if (weekday !== undefined) tokens.push({ kind: 'weekday', value: weekday, start, end });
      else if (month !== undefined) tokens.push({ kind: 'month', value: month, start, end });
      else if (LINK_WORDS.has(lower)) tokens.push({ kind: 'link', start, end });
      else if (lower === 'the' || lower === 'of' || lower === 'at' || lower === 'from') {
        tokens.push({ kind: 'word', value: lower, start, end });
      } else tokens.push({ kind: 'other', start, end });
      const shortForm = word.length <= 5 && (weekday !== undefined || month !== undefined);
      if (period !== undefined && !shortForm) tokens.push({ kind: 'stop', start: end, end: end + 1 });
    } else if (link !== undefined) {
      tokens.push({ kind: 'link', start, end });
    } else if (comma !== undefined) {
      tokens.push({ kind: 'comma', start, end });
    } else if (open !== undefined) {
      tokens.push({ kind: 'open', start, end });
    } else if (close !== undefined) {
      tokens.push({ kind: 'close', start, end });
    } else if (stop !== undefined) {
      tokens.push({ kind: 'stop', start, end });
    } else {
      tokens.push({ kind: 'other', start, end });
    }
  }
  return tokens;
}

const isDay = (token: Token | undefined): token is Extract<Token, { kind: 'number' }> =>
  token?.kind === 'number' && token.value >= 1 && token.value <= 31;
const isYear = (token: Token | undefined): token is Extract<Token, { kind: 'number' }> =>
  token?.kind === 'number' && !token.ordinal && token.value >= 1900 && token.value <= 2199;

/** One weekday said to fall on a day of a month, with the year when written. */
interface Pair {
  readonly weekday: number;
  readonly day: number;
  readonly month: number;
  readonly year: number | undefined;
  /** Other readings of the date (a numeric date read both ways). */
  readonly alternative?: { readonly day: number; readonly month: number };
  readonly start: number;
  readonly end: number;
}

/** The date tokens from `index`: day and month in either order, with a year; the index after them. */
function dateAt(
  tokens: readonly Token[],
  index: number,
): { day: number; month: number; year: number | undefined; next: number } | undefined {
  let at = index;
  const skip = (kind: Token['kind'], value?: string): void => {
    const token = tokens[at];
    if (token?.kind === kind && (value === undefined || (token.kind === 'word' && token.value === value))) at++;
  };
  const yearAfter = (): number | undefined => {
    const comma = tokens[at]?.kind === 'comma' ? 1 : 0;
    const token = tokens[at + comma];
    if (isYear(token)) {
      at += comma + 1;
      return token.value;
    }
    return undefined;
  };
  const first = tokens[at];
  if (first?.kind === 'month') {
    at++;
    const day = tokens[at];
    if (!isDay(day)) return undefined;
    at++;
    return { day: day.value, month: first.value, year: yearAfter(), next: at };
  }
  if (isDay(first)) {
    at++;
    skip('word', 'of');
    const month = tokens[at];
    if (month?.kind !== 'month') return undefined;
    at++;
    return { day: first.value, month: month.value, year: yearAfter(), next: at };
  }
  return undefined;
}

/** Every pair the tokens write, in order. */
function pairsOf(tokens: readonly Token[]): Pair[] {
  const pairs: Pair[] = [];
  /** The month and year of the last pair in this sentence, which a later "Tuesday 13" in it shares. */
  let carried: { month: number; year: number | undefined; day: number } | undefined;
  const pushPair = (pair: Pair): void => {
    pairs.push(pair);
    carried = { month: pair.month, year: pair.year, day: pair.day };
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === 'stop') {
      carried = undefined;
      continue;
    }

    // A date followed by its weekday in brackets: "15 October (Thursday)".
    if (token.kind === 'month' || isDay(token)) {
      const date = dateAt(tokens, index);
      const [open, weekday, close] = date === undefined ? [] : tokens.slice(date.next, date.next + 3);
      if (date !== undefined && open?.kind === 'open' && weekday?.kind === 'weekday' && close?.kind === 'close') {
        pushPair({
          weekday: weekday.value,
          day: date.day,
          month: date.month,
          year: date.year,
          start: token.start,
          end: close.end,
        });
        index = date.next + 2;
        continue;
      }
    }
    if (token.kind !== 'weekday') continue;

    // Weekdays joined into a range or list, then as many days: "Monday to Friday, 12–16 October".
    const weekdays: Array<Named> = [token];
    let at = index + 1;
    while (tokens[at]?.kind === 'link' && tokens[at + 1]?.kind === 'weekday') {
      weekdays.push(tokens[at + 1] as Named);
      at += 2;
    }
    if (tokens[at]?.kind === 'comma') at++;
    if (tokens[at]?.kind === 'word' && (tokens[at] as { value: string }).value === 'the') at++;
    const next = tokens[at];

    if (weekdays.length === 1 && next?.kind === 'iso') {
      pushPair({ weekday: token.value, ...next.date, start: token.start, end: next.end });
      index = at;
      continue;
    }
    if (weekdays.length === 1 && next?.kind === 'numeric') {
      const { first, second } = next;
      pushPair({
        weekday: token.value,
        day: first,
        month: second,
        year: next.year,
        alternative: { day: second, month: first },
        start: token.start,
        end: next.end,
      });
      index = at;
      continue;
    }
    // A weekday with its date in brackets: "Monday (12 October)".
    if (weekdays.length === 1 && next?.kind === 'open') {
      const date = dateAt(tokens, at + 1);
      const close = date === undefined ? undefined : tokens[date.next];
      if (date !== undefined && close?.kind === 'close') {
        pushPair({
          weekday: token.value,
          day: date.day,
          month: date.month,
          year: date.year,
          start: token.start,
          end: close.end,
        });
        index = date.next;
      }
      continue;
    }
    if (weekdays.length === 1 && next?.kind === 'month') {
      const date = dateAt(tokens, at);
      if (date !== undefined) {
        pushPair({
          weekday: token.value,
          day: date.day,
          month: date.month,
          year: date.year,
          start: token.start,
          end: tokens[date.next - 1].end,
        });
        index = date.next - 1;
      }
      continue;
    }
    if (!isDay(next)) continue;

    // Days, each with its own weekday or one of the range's, until a month names them all.
    const items: Array<{ weekday: number | undefined; day: number }> = [
      { weekday: weekdays.length === 1 ? token.value : undefined, day: next.value },
    ];
    at++;
    let month: { value: number; year: number | undefined; end: number } | undefined;
    for (;;) {
      if (tokens[at]?.kind === 'word' && (tokens[at] as { value: string }).value === 'of') at++;
      const after = tokens[at];
      if (after?.kind === 'month') {
        const comma = tokens[at + 1]?.kind === 'comma' ? 1 : 0;
        const year = tokens[at + 1 + comma];
        month = isYear(year)
          ? { value: after.value, year: year.value, end: year.end }
          : { value: after.value, year: undefined, end: after.end };
        at += isYear(year) ? 2 + comma : 1;
        break;
      }
      if (after?.kind !== 'link' && after?.kind !== 'comma') break;
      let step = at + 1;
      if (tokens[step]?.kind === 'link') step++;
      const weekday = tokens[step]?.kind === 'weekday' ? (tokens[step] as Named).value : undefined;
      if (weekday !== undefined) step++;
      const day = tokens[step];
      if (!isDay(day)) break;
      items.push({ weekday, day: day.value });
      at = step + 1;
    }
    if (month === undefined) {
      // "Monday 12 October at 11, Tuesday 13 at 12:30": a lone day after a dated one in the same sentence
      // shares its month, or the next when it comes earlier in the month; only before a time, a list, or
      // the sentence's end, so "Monday 5 people" is never a date.
      const follower = tokens[at];
      const ends =
        follower === undefined ||
        ['comma', 'link', 'stop', 'close'].includes(follower.kind) ||
        (follower.kind === 'word' && (follower.value === 'at' || follower.value === 'from'));
      if (carried === undefined || weekdays.length !== 1 || items.length !== 1 || !ends) continue;
      const later = items[0].day < carried.day;
      month = {
        value: later ? (carried.month % 12) + 1 : carried.month,
        year: carried.year === undefined ? undefined : later && carried.month === 12 ? carried.year + 1 : carried.year,
        end: tokens[at - 1].end,
      };
    }
    // A range's weekdays name its days in order; with one day, it is the range's last weekday's.
    const named =
      weekdays.length === 1
        ? items
        : weekdays.length === items.length
          ? items.map((item, position) => ({ ...item, weekday: weekdays[position].value }))
          : items.length === 1
            ? [{ ...items[0], weekday: weekdays[weekdays.length - 1].value }]
            : [];
    const lastDay = items[items.length - 1].day;
    for (const item of named) {
      if (item.weekday === undefined) continue;
      // A day after the last one listed belongs to the month before it: "Mon 28 – Fri 2 Oct".
      const earlier = item.day > lastDay;
      const itemMonth = earlier ? (month.value === 1 ? 12 : month.value - 1) : month.value;
      const itemYear =
        month.year === undefined ? undefined : earlier && month.value === 1 ? month.year - 1 : month.year;
      pushPair({
        weekday: item.weekday,
        day: item.day,
        month: itemMonth,
        year: itemYear,
        start: token.start,
        end: month.end,
      });
    }
    index = at - 1;
  }
  return pairs;
}

function utc(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function exists(date: CalendarDate): boolean {
  const check = new Date(utc(date));
  return (
    check.getUTCFullYear() === date.year && check.getUTCMonth() === date.month - 1 && check.getUTCDate() === date.day
  );
}

function weekdayOn(date: CalendarDate): number {
  return new Date(utc(date)).getUTCDay();
}

/** The dates a day and month without a year are read as, from `today`: the next one, and one just gone. */
function readingsOf(day: number, month: number, today: CalendarDate): CalendarDate[] {
  const now = utc(today);
  return [today.year - 1, today.year, today.year + 1]
    .map((year) => ({ year, month, day }))
    .filter(exists)
    .filter((date) => {
      const offset = (utc(date) - now) / DAY_MS;
      return offset >= -RECENT_DAYS && offset < AHEAD_DAYS;
    });
}

function describe(date: CalendarDate): string {
  return `${date.day} ${MONTHS[date.month - 1]} ${date.year} is a ${WEEKDAYS[weekdayOn(date)]}`;
}

/**
 * The first weekday in `text` written beside a date it does not fall on, read
 * from `today` (the writer's date), or undefined when every pair agrees.
 */
export function findWeekdayMismatch(text: string, today: CalendarDate): WeekdayMismatch | undefined {
  const own = ownWords(text);
  for (const pair of pairsOf(tokenize(own))) {
    const asWritten = [
      { day: pair.day, month: pair.month },
      ...(pair.alternative === undefined ? [] : [pair.alternative]),
    ];
    const readings = asWritten.flatMap(({ day, month }) =>
      pair.year === undefined ? readingsOf(day, month, today) : [{ year: pair.year, month, day }].filter(exists),
    );
    if (readings.length === 0 || readings.some((date) => weekdayOn(date) === pair.weekday)) continue;
    return {
      written: text.slice(pair.start, pair.end),
      weekday: WEEKDAYS[pair.weekday],
      readings: readings.map(describe),
    };
  }
  return undefined;
}
