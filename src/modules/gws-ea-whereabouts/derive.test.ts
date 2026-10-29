import { describe, expect, it } from 'vitest';
import { deriveLegs } from './derive.js';

const event = {
  id: 'flight-42',
  start: { dateTime: '2026-11-01T21:00:00-08:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-11-02T17:00:00+01:00', timeZone: 'Europe/Brussels' },
  location: 'Brussels',
};

describe('travel leg derivation', () => {
  it('uses instant boundaries and ignores guest responses and etags in its version', () => {
    const [leg] = deriveLegs([event]);
    expect(leg).toMatchObject({
      sourceEventId: 'flight-42',
      departure: Date.parse('2026-11-02T05:00:00Z'),
      arrival: Date.parse('2026-11-02T16:00:00Z'),
      departureZone: 'America/Los_Angeles',
      destinationZone: 'Europe/Brussels',
      locality: 'Brussels',
    });
    const [responded] = deriveLegs([
      { ...event, etag: 'new', attendees: [{ email: 'remy@example.net', responseStatus: 'accepted' }] },
    ]);
    expect(responded.sourceVersion).toBe(leg.sourceVersion);
    expect(deriveLegs([{ ...event, location: 'Paris' }])[0].sourceVersion).not.toBe(leg.sourceVersion);
  });
  it('does not derive cancelled, declined, or same-zone events', () => {
    expect(
      deriveLegs([
        { ...event, status: 'cancelled' },
        { ...event, id: 'declined', attendees: [{ self: true, responseStatus: 'declined' }] },
        { ...event, id: 'local', end: { ...event.end, timeZone: event.start.timeZone } },
      ]),
    ).toEqual([]);
  });
  it('ends a destination stay at the next departure and leaves a final destination open', () => {
    const legs = deriveLegs([
      event,
      {
        id: 'return',
        start: { dateTime: '2026-11-08T10:00:00+01:00', timeZone: 'Europe/Brussels' },
        end: { dateTime: '2026-11-08T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
        location: 'Berkeley',
      },
    ]);
    expect(legs[0].end).toBe(Date.parse('2026-11-08T09:00:00Z'));
    expect(legs[1].end).toBeNull();
  });
});
