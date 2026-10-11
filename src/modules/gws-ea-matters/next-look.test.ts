import { describe, expect, it } from 'vitest';

import { parseNextLook } from './next-look.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const LAGOS = 'Africa/Lagos';

describe('a next look', () => {
  it('reads a time without an offset in the principal’s time zone, and one with an offset as written', () => {
    expect(parseNextLook({ at: '2026-10-14T09:00' }, LAGOS, NOW)).toEqual({
      kind: 'once',
      at: '2026-10-14T08:00:00.000Z',
    });
    expect(parseNextLook({ at: '2026-10-14 09:00' }, LAGOS, NOW)).toEqual({
      kind: 'once',
      at: '2026-10-14T08:00:00.000Z',
    });
    expect(parseNextLook({ at: ' 2026-10-14T09:00:00-04:00 ' }, LAGOS, NOW)).toEqual({
      kind: 'once',
      at: '2026-10-14T13:00:00.000Z',
    });
  });

  it('keeps a repeating look’s cron expression for the principal’s time zone', () => {
    expect(parseNextLook({ cron: ' 0 9 14 3 * ' }, LAGOS, NOW)).toEqual({ kind: 'repeat', cron: '0 9 14 3 *' });
    expect(parseNextLook({ cron: '0 8,12,16,20 * * *' }, LAGOS, NOW)).toEqual({
      kind: 'repeat',
      cron: '0 8,12,16,20 * * *',
    });
  });

  it('is absent when neither kind is given', () => {
    expect(parseNextLook({}, LAGOS, NOW)).toBeUndefined();
  });

  it.each<[string, { at?: string; cron?: string }, RegExp]>([
    ['both kinds', { at: '2026-10-14T09:00', cron: '0 9 * * 1' }, /either --look or --look-cron/],
    ['a time that has passed', { at: '2026-10-10T12:59' }, /in the future/],
    ['now', { at: '2026-10-10T12:00:00Z' }, /in the future/],
    ['a time with no date', { at: '09:00' }, /date and time/],
    ['a date with no time', { at: '2026-10-14' }, /date and time/],
    ['an impossible date', { at: '2026-02-30T09:00' }, /date and time/],
    ['a cron expression with a sixth field', { cron: '0 0 9 * * 1' }, /five fields/],
    ['a cron expression for a date that never comes', { cron: '0 9 30 2 *' }, /is not a cron expression/],
    ['a cron expression that fires five times a day', { cron: '0 8,11,14,17,20 * * *' }, /more than 4 times a day/],
    ['a cron expression on two lines', { cron: '0 9 * *\n1' }, /must be one line/],
  ])('refuses %s', (_label, input, message) => {
    expect(() => parseNextLook(input, LAGOS, NOW)).toThrow(message);
  });
});
