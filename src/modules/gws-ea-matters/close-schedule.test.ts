import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Timeline } from '../gws-ea-whereabouts/timeline.js';
import { wallClock } from '../gws-ea-whereabouts/clock.js';
import { nextClosePlacement } from './sync.js';

function route(homeZone: string, destination: string, departure: string, arrival: string): Timeline {
  return {
    version: 'route',
    homeZone,
    base: { home_place_id: null, trip_source: null, rhythm_known: 0, updated_at: null },
    places: [],
    rhythm: [],
    pairs: [],
    travel: [],
    dismissedEvents: [],
    stays: [
      {
        ids: ['stay'],
        sourceEventIds: ['flight'],
        placeId: null,
        locality: destination,
        zone: destination,
        start: Date.parse(arrival),
        end: null,
        certainty: 'certain',
        workingHours: 'local',
        derived: true,
      },
    ],
    legs: [
      {
        sourceEventId: 'flight',
        departure: Date.parse(departure),
        arrival: Date.parse(arrival),
        departureZone: homeZone,
        destinationZone: destination,
        locality: destination,
        returnUnknown: true,
      },
    ],
  };
}

describe('R34 close route grid', () => {
  it('reports an open-ended unknown-zone stay promptly instead of holding the matters loop forever', () => {
    const initial = route('America/Los_Angeles', 'Asia/Tokyo', '2026-10-11T00:00Z', '2026-10-12T00:00Z');
    const timeline: Timeline = { ...initial, legs: [], stays: initial.stays.map((stay) => ({ ...stay, zone: null })) };
    const source = `import { nextClosePlacement } from ${JSON.stringify(fileURLToPath(new URL('./sync.ts', import.meta.url)))}; nextClosePlacement(JSON.parse(process.argv[1]), Date.parse('2026-10-12T17:00Z'));`;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source, JSON.stringify(timeline)],
      { encoding: 'utf8', timeout: 2000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('zone in effect is unknown');
  });

  it('jumps over a years-long unknown stay to the next known zone boundary', () => {
    const initial = route('America/Los_Angeles', 'Asia/Tokyo', '2026-10-11T00:00Z', '2026-10-12T00:00Z');
    const timeline: Timeline = {
      ...initial,
      legs: [],
      stays: initial.stays.map((stay) => ({ ...stay, zone: null, end: Date.parse('2040-10-12T17:00Z') })),
    };
    expect(new Date(nextClosePlacement(timeline, Date.parse('2026-10-12T17:00Z')).at).toISOString()).toBe(
      '2040-10-13T04:00:00.000Z',
    );
  });

  it('includes a rhythm place’s 21:00 clock when that is the zone actually in effect', () => {
    const initial = route('America/Los_Angeles', 'Asia/Tokyo', '2026-10-11T00:00Z', '2026-10-12T00:00Z');
    const timeline: Timeline = {
      ...initial,
      stays: [],
      legs: [],
      places: [
        {
          id: 'new-york',
          label: 'New York',
          locality: 'New York',
          zone: 'America/New_York',
          private_value_id: null,
          is_home: 0,
          updated_at: '2026-10-12T00:00Z',
        },
      ],
      rhythm: [
        {
          weekday: 'mon',
          place_id: 'new-york',
          start_minute: 17 * 60,
          end_minute: 24 * 60,
          updated_at: '2026-10-12T00:00Z',
        },
      ],
    };
    expect(nextClosePlacement(timeline, Date.parse('2026-10-12T17:00Z'))).toMatchObject({
      at: Date.parse('2026-10-13T01:00Z'),
      zone: 'America/New_York',
    });
  });

  it.each([
    {
      name: 'SFO to NRT',
      home: 'America/Los_Angeles',
      to: 'Asia/Tokyo',
      departure: '2026-10-31T20:00Z',
      arrival: '2026-11-01T07:00Z',
      after: '2026-10-31T04:00Z',
      expected: ['2026-11-01T04:00:00.000Z', '2026-11-02T12:00:00.000Z', '2026-11-03T12:00:00.000Z'],
    },
    {
      name: 'NRT to SFO',
      home: 'Asia/Tokyo',
      to: 'America/Los_Angeles',
      departure: '2026-11-01T08:00Z',
      arrival: '2026-11-01T18:00Z',
      after: '2026-10-31T12:00Z',
      expected: ['2026-11-01T12:00:00.000Z', '2026-11-02T05:00:00.000Z', '2026-11-03T05:00:00.000Z'],
    },
    {
      name: 'SFO to SYD',
      home: 'America/Los_Angeles',
      to: 'Australia/Sydney',
      departure: '2026-10-31T18:00Z',
      arrival: '2026-11-01T09:00Z',
      after: '2026-10-31T04:00Z',
      expected: ['2026-11-01T04:00:00.000Z', '2026-11-02T10:00:00.000Z', '2026-11-03T10:00:00.000Z'],
    },
    {
      name: 'SYD to SFO',
      home: 'Australia/Sydney',
      to: 'America/Los_Angeles',
      departure: '2026-11-01T00:00Z',
      arrival: '2026-11-01T14:00Z',
      after: '2026-10-31T10:00Z',
      expected: ['2026-11-01T10:00:00.000Z', '2026-11-02T05:00:00.000Z', '2026-11-03T05:00:00.000Z'],
    },
  ])(
    '$name keeps 21:00 on the effective clock with twelve hours between closes',
    ({ home, to, departure, arrival, after, expected }) => {
      const timeline = route(home, to, departure, arrival);
      let previous = Date.parse(after);
      const actual: string[] = [];
      for (const ignored of expected) {
        void ignored;
        const next = nextClosePlacement(timeline, previous + 1, previous);
        expect(next.at - previous).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000);
        expect(wallClock(next.at, next.zone)).toMatchObject({ hour: 21, minute: 0 });
        actual.push(new Date(next.at).toISOString());
        previous = next.at;
      }
      expect(actual).toEqual(expected);
    },
  );
});
