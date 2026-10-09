/**
 * The weekday-and-date check over a corpus of what an assistant writes:
 * every wrong pair it must catch, and every sentence it must leave alone.
 * Written on Wednesday 7 October 2026.
 */
import { describe, expect, it } from 'vitest';

import { findWeekdayMismatch } from './weekday-check.js';

const TODAY = { year: 2026, month: 10, day: 7 };

/** Sentences with a weekday beside a date it does not fall on, and the words the check names. */
const WRONG: ReadonlyArray<readonly [sentence: string, written: string]> = [
  ['Would Friday 15 October at 10:00 work for you?', 'Friday 15 October'],
  ['How about Thu, 16 Oct, at 2pm Pacific?', 'Thu, 16 Oct'],
  ["I've booked Tuesday the 14th of October at 3pm.", 'Tuesday the 14th of October'],
  ['See you on Thursday, October 16th, 2026.', 'Thursday, October 16th, 2026'],
  ['Does Wednesday 2026-10-15 suit?', 'Wednesday 2026-10-15'],
  ['Could you do Mon 13 or Tue 14 October?', 'Mon 13 or Tue 14 October'],
  ['The offsite runs Mon 28 – Fri 3 Oct.', 'Mon 28 – Fri 3 Oct'],
  ['She is away Monday to Friday, 13–17 October.', 'Monday to Friday, 13–17 October'],
  ['Your flight is on 16 October (Thursday).', '16 October (Thursday)'],
  ['The dinner is booked for Friday 25 December 2027.', 'Friday 25 December 2027'],
  ['THU 16 OCT — all hands', 'THU 16 OCT'],
  ['Friday 15/10 works.', 'Friday 15/10'],
  ['**Tuesday 14 October**, 09:00–09:30 BST', 'Tuesday 14 October'],
  ['We could meet Thursday 16 Oct or Friday 17 Oct.', 'Thursday 16 Oct'],
  ['Saturday 1 November is free.', 'Saturday 1 November'],
  ['Shall we start Thursday 1 January?', 'Thursday 1 January'],
  ['Weds 13 Oct at 9 is open.', 'Weds 13 Oct'],
  ['Next Monday (13 October) is clear.', 'Monday (13 October)'],
  ['It moved from Tuesday to Thursday 16 October.', 'Tuesday to Thursday 16 October'],
  ['Remy wrote "Thursday 15 October works", so I booked Thursday 16 October.', 'Thursday 16 October'],
  ['Sept 30 (Tue) is the deadline.', 'Sept 30 (Tue)'],
  ['Plan: Mon 12 Oct kickoff, Wed 15 Oct review.', 'Wed 15 Oct'],
  // A lone day later in the sentence shares the dated day's month.
  ['Would Monday 12 October at 11, Wednesday 13 at 12:30, or Thursday 15 at 9:30 (Pacific) work?', 'Wednesday 13'],
  ['Friday 30 October, then Tuesday 2 at 9.', 'Tuesday 2'],
];

/** Sentences the check must leave alone: right pairs, and words that only look like dates. */
const RIGHT: readonly string[] = [
  // Pairs the tools write, and the ways people write right ones.
  'Thursday 15 October at 10:00 BST suits Pat.',
  'Thu, Oct 15 2026 3:00 PM EDT',
  'Tuesday 6 Oct, 12:00–15:00 BST; for them, Tuesday 6 Oct, 07:00–10:00 EDT (acceptable)',
  'Thursday 8 Oct, 09:00 PDT to Saturday 10 Oct, 17:00 PDT',
  'Thursday 15 Oct 23:00 PDT (Friday 16 Oct 07:00 BST)',
  'How about Monday 12 October 2026 at 9:00, or Wednesday 14 October at 9:30?',
  'between Monday 12 and Wednesday 14 October',
  'Mon 5–Wed 7 Oct',
  'Mon 28 Sep – Fri 2 Oct',
  'Mon 28 – Fri 2 Oct',
  'Monday to Friday, 12–16 October',
  'Monday to Friday, 12-16 October',
  'Q4 planning: Tuesday 13 Oct–Thursday 15 Oct',
  '15 October (Thursday)',
  'Thursday 2026-10-15',
  'Thursday 15/10, or for the US office Thursday 10/15',
  'On Fri, 16 Oct 2026 09:00:00 +0000, Remy Vance wrote:',
  'SAT 10 OCT',
  'Sept 30 (Wed)',
  'Friday 1 January',
  'Would Monday 12 October at 11, Tuesday 13 at 12:30, or Wednesday 14 at 9:30 (Pacific) work for a 30-minute call?',
  'Friday 30 October, then Monday 2 at 9.',
  'Thursday 15 October works; Monday 5 people are out.',
  'Thursday 15 October works, and Monday 5 people are out.',
  'Thursday 15 October. Tuesday 13 was busy.',
  // A date without a year, read as next year's.
  'Wednesday 12 May works for the summit.',
  // A date without a year, read as one just gone.
  'We last met on Monday 3 August.',
  'Tuesday 1 September was the kickoff.',
  // No date beside the weekday, or no month beside the day.
  'Would Monday at 11, Tuesday at 12:30, or Wednesday at 9:30 (Pacific) work for a 30-minute call?',
  'Friday the 13th is unlucky.',
  'Tuesday 13 at 3pm?',
  'Monday, 5 people joined the call.',
  'On Friday, 3 of us will be in the office.',
  'Mon–Fri 9–5',
  'Sunday 3 to 5pm',
  'The board meets on Wednesday 10:30 sharp.',
  'Sun 30 degrees, apparently.',
  '2 October was a Friday.',
  'Call me Friday on 07700 900123.',
  // Everyday words that are also short weekdays or months.
  'They wed 5 May 2026 in Lisbon.',
  'I sat 3 March exams.',
  'Friday 15 may work better.',
  // Someone else's words: quoted, in a quoted block, or marked untrusted.
  'Remy wrote "Thursday 16 October works for me".',
  'Juno replied: “Friday 15 October is fine”',
  '> Thursday 16 October works for me\n\nThanks, Remy. I have booked Friday 16 October.',
  '<<<EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>\nSource: gmail\n---\nThursday 16 October?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="0123456789abcdef">>>',
  // A date that does not exist is not a weekday mistake.
  'Thursday 31 September',
];

describe('the weekday and date check', () => {
  it.each(WRONG)('catches %j', (sentence, written) => {
    expect(findWeekdayMismatch(sentence, TODAY)?.written).toBe(written);
  });

  it.each(RIGHT)('leaves %j alone', (sentence) => {
    expect(findWeekdayMismatch(sentence, TODAY)).toBeUndefined();
  });

  it('says which weekday each reading of the date falls on', () => {
    expect(findWeekdayMismatch('Would Friday 15 October work?', TODAY)).toEqual({
      written: 'Friday 15 October',
      weekday: 'Friday',
      readings: ['15 October 2026 is a Thursday'],
    });
    // A day just gone and its next occurrence are both read; neither agrees.
    expect(findWeekdayMismatch('Thursday 1 September', TODAY)?.readings).toEqual([
      '1 September 2026 is a Tuesday',
      '1 September 2027 is a Wednesday',
    ]);
  });

  it('lets a date without a year stand when either reading agrees: a known miss for a date just gone', () => {
    // 1 September 2026 was a Tuesday; 1 September 2027 is a Wednesday.
    expect(findWeekdayMismatch('Wednesday 1 September', TODAY)).toBeUndefined();
  });

  it('reports its precision and recall over the corpus', () => {
    const caught = WRONG.filter(([sentence]) => findWeekdayMismatch(sentence, TODAY) !== undefined).length;
    const falseAlarms = RIGHT.filter((sentence) => findWeekdayMismatch(sentence, TODAY) !== undefined).length;
    expect({ caught, of: WRONG.length, falseAlarms, among: RIGHT.length }).toEqual({
      caught: WRONG.length,
      of: WRONG.length,
      falseAlarms: 0,
      among: RIGHT.length,
    });
  });
});
