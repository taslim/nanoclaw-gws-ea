/**
 * How a time reads in an email: its day, its times and its zone as people
 * write them; and how an event the assistant writes tells its guests: on
 * its first write alone. The bookings themselves are covered with the
 * scheduling tools that make them (tools.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { ensureEvent, guestsOn, slotLabel, TAG_ROLE } from './calendar-actions.js';
import { FakeCalendar } from './testing/fake-calendar.js';

describe('a slot as people write it', () => {
  it('names its day, its times and its zone the way people do, never an IANA name', () => {
    const span = { start: Date.parse('2026-10-06T09:00:00Z'), end: Date.parse('2026-10-06T09:30:00Z') };
    expect(slotLabel(span, 'Europe/London')).toBe('Tuesday 6 Oct, 10:00–10:30 BST');
    expect(slotLabel(span, 'America/New_York')).toBe('Tuesday 6 Oct, 05:00–05:30 EDT');
    expect(slotLabel(span, 'Africa/Lagos')).toBe('Tuesday 6 Oct, 10:00–10:30 GMT+1');
  });
});

describe('an event the assistant writes', () => {
  const PRINCIPAL = 'morgan@northwind.example';
  const REMY = 'remy@northwind.example';
  const OWNER = { key: 'gwsEaThread', value: 'thread-1' };
  const EVENT = {
    summary: 'Intro',
    start: '2026-10-06T09:00:00.000Z',
    end: '2026-10-06T09:30:00.000Z',
    attendees: guestsOn(PRINCIPAL, [REMY]),
    tags: { [TAG_ROLE]: 'booking', [OWNER.key]: OWNER.value },
  };

  it('tells its guests on the first write alone: a retry that finds it puts back what it wrote, telling no one again', async () => {
    const calendar = new FakeCalendar();
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);
    // A retry that finds it as it was written changes nothing.
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);
    // Before the next, it has been moved: the retry puts its time back without a word to anyone.
    const written = calendar.event(PRINCIPAL, 'intro01');
    if (written === undefined) throw new Error('ensureEvent made no event');
    calendar.put({
      ...written,
      start: { dateTime: '2026-10-06T10:00:00.000Z' },
      end: { dateTime: '2026-10-06T10:30:00.000Z' },
    });
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);

    expect(calendar.writes.map(({ op, sendUpdates }) => ({ op, sendUpdates }))).toEqual([
      { op: 'insert', sendUpdates: 'all' },
      { op: 'patch', sendUpdates: 'none' },
    ]);
    expect(calendar.event(PRINCIPAL, 'intro01')).toMatchObject({
      start: { dateTime: EVENT.start },
      end: { dateTime: EVENT.end },
    });
  });

  it('tells its guests again when a retry restores it: the last they heard was that it was cancelled', async () => {
    const calendar = new FakeCalendar();
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);
    await calendar.deleteEvent(PRINCIPAL, 'intro01', 'all');
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);

    expect(calendar.writes.map(({ op, sendUpdates }) => ({ op, sendUpdates }))).toEqual([
      { op: 'insert', sendUpdates: 'all' },
      { op: 'delete', sendUpdates: 'all' },
      { op: 'patch', sendUpdates: 'all' },
    ]);
    expect(calendar.event(PRINCIPAL, 'intro01')).toMatchObject({ status: 'confirmed' });
  });
});
