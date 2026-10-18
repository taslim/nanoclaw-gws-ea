import { expect, it } from 'vitest';

import { readIsoTime, zonedDate, zonedInstant } from './iso-time.js';

it('reads real ISO dates as written and offset times in UTC', () => {
  expect(readIsoTime('2028-02-29', 'optional')).toBe('2028-02-29');
  expect(readIsoTime('2026-10-14T17:00:00-07:00', 'optional')).toBe('2026-10-15T00:00:00.000Z');
  expect(readIsoTime('2026-10-14T17:00:00.25+05:30', 'required')).toBe('2026-10-14T11:30:00.250Z');
  expect(readIsoTime('2026-10-14T23:59:59Z', 'required')).toBe('2026-10-14T23:59:59.000Z');
});

it('refuses impossible calendar values that Date.parse would silently move', () => {
  for (const value of [
    '2026-02-30',
    '2026-04-31T00:00:00+02:00',
    '2027-02-29T12:00:00Z',
    '2026-02-28T24:00:00Z',
    '2026-02-28T23:60:00Z',
    '2026-02-28T23:59:60Z',
    '2026-02-28T12:00:00+24:00',
    '2026-13-01',
  ])
    expect(readIsoTime(value, 'optional')).toBeUndefined();
});

it('requires an explicit offset and seconds for a time, and a time when one is required', () => {
  for (const value of ['2026-10-14T17:00:00', '2026-10-14T17:00-07:00', 'Fri, 16 Oct 2026 19:00:00 +0000', 7])
    expect(readIsoTime(value, 'optional')).toBeUndefined();
  expect(readIsoTime('2026-10-14', 'required')).toBeUndefined();
});

it('reads a wall time on a named clock, moving one a daylight-saving change skips forward', () => {
  const at = (wall: string, timeZone: string): string => new Date(zonedInstant(wall, timeZone)).toISOString();
  expect(at('2026-10-20T19:00:00', 'Asia/Tokyo')).toBe('2026-10-20T10:00:00.000Z');
  expect(at('2026-10-20T23:59:59.999', 'America/Los_Angeles')).toBe('2026-10-21T06:59:59.999Z');
  // New York skips 02:00 to 03:00 on 14 March 2027: 02:30 reads as 03:30 EDT.
  expect(at('2027-03-14T02:30:00', 'America/New_York')).toBe('2027-03-14T07:30:00.000Z');
  // It repeats 01:00 to 02:00 on 7 November 2027: 01:30 is the first, in EDT.
  expect(at('2027-11-07T01:30:00', 'America/New_York')).toBe('2027-11-07T05:30:00.000Z');
  expect(zonedInstant('soonT00:00:00', 'Asia/Tokyo')).toBeNaN();
  expect(zonedDate(Date.parse('2026-10-20T16:00:00Z'), 'Asia/Tokyo')).toBe('2026-10-21');
  expect(zonedDate(Date.parse('2026-10-20T16:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-20');
});
