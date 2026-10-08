/**
 * How a time reads in an email: its day, its times and its zone as people
 * write them. The writes behind bookings are covered with the scheduling
 * tools that make them (tools.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { slotLabel } from './calendar-actions.js';

describe('a slot as people write it', () => {
  it('names its day, its times and its zone the way people do, never an IANA name', () => {
    const span = { start: Date.parse('2026-10-06T09:00:00Z'), end: Date.parse('2026-10-06T09:30:00Z') };
    expect(slotLabel(span, 'Europe/London')).toBe('Tuesday 6 Oct, 10:00–10:30 BST');
    expect(slotLabel(span, 'America/New_York')).toBe('Tuesday 6 Oct, 05:00–05:30 EDT');
    expect(slotLabel(span, 'Africa/Lagos')).toBe('Tuesday 6 Oct, 10:00–10:30 GMT+1');
  });
});
