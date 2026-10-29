import { describe, expect, it } from 'vitest';
import { deriveLegs } from './derive.js';

const event = {
  id: 'flight-42',
  start: { dateTime: '2026-11-01T21:00:00-08:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-11-02T17:00:00+01:00', timeZone: 'Europe/Brussels' },
  location: 'UA 900 SFO to BRU, confirmation K7Q2XZ, seat 14C',
};

describe('travel leg derivation', () => {
  it('uses instant boundaries and carries zones only, copying no event text', () => {
    const [leg] = deriveLegs([event]);
    expect(leg).toEqual({
      sourceEventId: 'flight-42',
      sourceVersion: expect.any(String),
      departure: Date.parse('2026-11-02T05:00:00Z'),
      arrival: Date.parse('2026-11-02T16:00:00Z'),
      departureZone: 'America/Los_Angeles',
      destinationZone: 'Europe/Brussels',
    });
    expect(JSON.stringify(leg)).not.toContain('K7Q2XZ');
  });
  it('keeps its version through guest responses, etags and location edits', () => {
    const [leg] = deriveLegs([event]);
    const [responded] = deriveLegs([
      { ...event, etag: 'new', attendees: [{ email: 'remy@example.net', responseStatus: 'accepted' }] },
    ]);
    expect(responded.sourceVersion).toBe(leg.sourceVersion);
    const relocated = { ...event, location: 'Gate B12' };
    expect(deriveLegs([relocated])[0].sourceVersion).toBe(leg.sourceVersion);
    expect(
      deriveLegs([{ ...event, end: { ...event.end, dateTime: '2026-11-02T18:00:00+01:00' } }])[0].sourceVersion,
    ).not.toBe(leg.sourceVersion);
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
});
