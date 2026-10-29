import { describe, expect, it } from 'vitest';
import { resolvePlace, travelBetween } from './places.js';
import { timeline } from './testing/fixture.js';

describe('calendar places and measured moves', () => {
  it.each(['https://meet.google.com/abc-defg-hij', '+1 (415) 555-0100', 'tel:+14155550100'])(
    'treats %s as remote',
    (text) => {
      expect(resolvePlace(text, timeline).kind).toBe('remote');
    },
  );
  it('matches a private home value without exposing it in the resolved place', () => {
    const place = resolvePlace('42 Cedar Lane', timeline, { 'home-address': '42 Cedar Lane' });
    expect(place).toMatchObject({ kind: 'known', id: 'sf', label: 'Home' });
    expect(JSON.stringify(place)).not.toContain('42 Cedar');
  });
  it('uses directional saved pairs, then an event estimate; never guesses', () => {
    const from = resolvePlace('Office', timeline);
    const to = resolvePlace('Mission restaurant', timeline);
    const known = {
      ...timeline,
      pairs: [
        {
          from_place_id: 'mv',
          to_place_id: 'mission',
          mode: 'car',
          minutes: 50,
          source: 'learned' as const,
          updated_at: 'fixed',
        },
      ],
    };
    expect(travelBetween(from, to, 'dinner', known)).toMatchObject({ minutes: 50, source: 'learned' });
    expect(travelBetween(to, from, 'dinner', known).minutes).toBeNull();
    expect(
      travelBetween(from, resolvePlace('New venue', timeline), 'dinner', {
        ...timeline,
        travel: [{ event_id: 'dinner', mode: 'car', minutes: 20, source: 'estimated', updated_at: 'fixed' }],
      }),
    ).toMatchObject({ minutes: 20, source: 'estimated' });
  });
});
