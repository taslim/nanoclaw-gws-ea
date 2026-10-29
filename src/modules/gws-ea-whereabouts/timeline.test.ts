import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-privacy/index.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { addPlace, addStay, getWhereabouts, setBase, setRhythm, syncDerivedStays } from './db.js';
import { deriveLegs } from './derive.js';
import { gaps } from './gaps.js';
import { loadTimeline, whereaboutsAt, zoneAt, zoneForDay, type Timeline } from './timeline.js';
import './index.js';

const PACIFIC = 'America/Los_Angeles';
const BRUSSELS = 'Europe/Brussels';
const NOW = '2026-10-28T16:00:00.000Z';
const at = (value: string): number => Date.parse(value);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await runMigrations(await initTestDb());
  await getDb().run('UPDATE gws_ea_profile SET principal_timezone = ? WHERE singleton = 1', PACIFIC);
});
afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

async function home() {
  const address = await addPrivateValue({ label: 'Home', kind: 'address', value: '24 Alder Lane, Berkeley, CA 94704' });
  const place = await addPlace({ id: 'home', label: 'Home', locality: 'Berkeley', privateValueId: address.id });
  await setBase({ placeId: place.id });
  return place;
}
async function brussels() {
  return addPlace({ id: 'brussels', label: 'Brussels', locality: 'Brussels', zone: BRUSSELS });
}

describe('whereabouts timeline', () => {
  it('keeps today separate from the base and tomorrow, and snapshots do not change after an edit', async () => {
    await home();
    await brussels();
    const before = await loadTimeline();
    const stay = await addStay({ placeId: 'brussels', start: '2026-10-28', source: 'said', certainty: 'tentative' });
    expect(stay.end).toBe('2026-10-28');
    const after = await loadTimeline();
    expect(zoneAt(before, at(NOW))).toBe(PACIFIC);
    expect(zoneAt(after, at(NOW))).toBe(BRUSSELS);
    expect(zoneForDay(after, '2026-10-29')).toBe(PACIFIC);
    expect(after.version).not.toBe(before.version);
    expect((await getWhereabouts()).base.home_place_id).toBe('home');
    expect(Object.isFrozen(after.stays)).toBe(true);
  });

  it('lets certainty win, then a nested shorter stay, and merges overlapping stays in one locality', async () => {
    await brussels();
    await addPlace({ id: 'paris', label: 'Paris', locality: 'Paris', zone: 'Europe/Paris' });
    await addStay({
      placeId: 'brussels',
      start: '2026-11-01',
      end: '2026-11-07',
      source: 'mail',
      certainty: 'certain',
    });
    await addStay({
      locality: 'London',
      zone: 'Europe/London',
      start: '2026-11-02',
      end: '2026-11-04',
      source: 'said',
      certainty: 'tentative',
    });
    await addStay({ placeId: 'paris', start: '2026-11-03', end: '2026-11-03', source: 'said', certainty: 'certain' });
    await addStay({
      placeId: 'brussels',
      start: '2026-11-06',
      end: '2026-11-08',
      source: 'mail',
      certainty: 'certain',
    });
    const timeline = await loadTimeline();
    expect(whereaboutsAt(timeline, at('2026-11-02T12:00:00Z')).locality).toBe('Brussels');
    expect(whereaboutsAt(timeline, at('2026-11-03T12:00:00Z')).locality).toBe('Paris');
    expect(timeline.stays.filter((s) => s.locality === 'Brussels')).toHaveLength(1);
    expect(zoneAt(timeline, at('2026-11-08T12:00:00Z'))).toBe(BRUSSELS);
  });

  it('refuses an ambiguous certain overlap and names both places', async () => {
    await addStay({
      locality: 'Brussels',
      zone: BRUSSELS,
      start: '2026-11-01',
      end: '2026-11-04',
      source: 'mail',
      certainty: 'certain',
    });
    await expect(
      addStay({
        locality: 'London',
        zone: 'Europe/London',
        start: '2026-11-03',
        end: '2026-11-06',
        source: 'mail',
        certainty: 'certain',
      }),
    ).rejects.toThrow(/Brussels.*London|London.*Brussels/u);
  });

  it('reads home and saved-place zones live without storing the home zone, and retains home working hours', async () => {
    await home();
    await brussels();
    await addStay({
      placeId: 'brussels',
      start: '2026-11-01',
      end: '2026-11-07',
      source: 'mail',
      certainty: 'certain',
      workingHours: 'home',
    });
    await addStay({ placeId: 'home', start: '2026-12-01', end: '2026-12-02', source: 'said', certainty: 'certain' });
    const before = await loadTimeline();
    expect(whereaboutsAt(before, at('2026-11-03T12:00:00Z')).workingHoursZone).toBe(PACIFIC);
    await getDb().run('UPDATE gws_ea_profile SET principal_timezone = ? WHERE singleton = 1', 'America/New_York');
    await addPlace({ id: 'brussels', label: 'Brussels', locality: 'Brussels', zone: 'Europe/London' });
    const after = await loadTimeline();
    expect(zoneAt(after, at('2026-10-28T16:00:00Z'))).toBe('America/New_York');
    expect(zoneAt(after, at('2026-12-01T16:00:00Z'))).toBe('America/New_York');
    expect(zoneAt(after, at('2026-11-03T12:00:00Z'))).toBe('Europe/London');
    expect(after.places.find((p) => p.id === 'home')?.zone).toBe('America/New_York');
    expect((await getWhereabouts()).places.find((p) => p.id === 'home')?.zone).toBeNull();
    expect((await getWhereabouts()).stays[0].zone).toBeNull();
    expect(after.version).not.toBe(before.version);
  });

  it('reports durable gaps and clears explicit none values', async () => {
    expect(gaps(await loadTimeline())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'home' }),
        expect.objectContaining({ kind: 'rhythm' }),
        expect.objectContaining({ kind: 'trip-source' }),
      ]),
    );
    await home();
    await setRhythm({ weekdays: [] });
    await setBase({ tripSource: 'none' });
    expect(gaps(await loadTimeline())).toEqual([]);
  });

  it('switches on arrival, keeps a one-way destination, and reports an unknown return', async () => {
    const legs = deriveLegs([
      {
        id: 'outbound',
        start: { dateTime: '2026-11-01T21:00:00-08:00', timeZone: PACIFIC },
        end: { dateTime: '2026-11-02T17:00:00+01:00', timeZone: BRUSSELS },
        location: 'Brussels',
      },
    ]);
    await syncDerivedStays(legs, { start: at('2026-11-01T00:00:00Z'), end: at('2026-11-10T00:00:00Z') });
    const timeline = await loadTimeline();
    expect(zoneAt(timeline, at('2026-11-02T15:59:59Z'))).toBe(PACIFIC);
    expect(zoneAt(timeline, at('2026-11-02T16:00:00Z'))).toBe(BRUSSELS);
    expect(zoneAt(timeline, at('2026-12-01T12:00:00Z'))).toBe(BRUSSELS);
    expect(gaps(timeline)).toContainEqual(expect.objectContaining({ kind: 'return', sourceEventId: 'outbound' }));
  });

  it('uses the departure zone at the start of a westward flight date', async () => {
    const legs = deriveLegs([
      {
        id: 'west',
        start: { dateTime: '2026-11-02T00:30:00+01:00', timeZone: BRUSSELS },
        end: { dateTime: '2026-11-02T03:00:00-08:00', timeZone: PACIFIC },
        location: 'Berkeley',
      },
    ]);
    await syncDerivedStays(legs, { start: at('2026-11-01T00:00:00Z'), end: at('2026-11-10T00:00:00Z') });
    expect(zoneForDay(await loadTimeline(), '2026-11-02')).toBe(BRUSSELS);
  });
  it('keeps a one-way destination after the snapshot is serialized', async () => {
    await home();
    const legs = deriveLegs([
      {
        id: 'one-way',
        start: { dateTime: '2026-11-01T21:00:00-08:00', timeZone: PACIFIC },
        end: { dateTime: '2026-11-02T17:00:00+01:00', timeZone: BRUSSELS },
        location: 'Brussels',
      },
    ]);
    await syncDerivedStays(legs, { start: at('2026-11-01'), end: at('2026-11-10') });
    const serialized = JSON.parse(JSON.stringify(await loadTimeline())) as Timeline;
    expect(zoneAt(serialized, at('2026-12-01T12:00:00Z'))).toBe(BRUSSELS);
    expect(whereaboutsAt(serialized, at('2026-12-01T12:00:00Z')).placeId).toBeNull();
  });

  it('reports an unknown stay zone for its day instead of substituting home', async () => {
    await home();
    await addStay({
      locality: 'Place not yet identified',
      zone: 'unknown',
      start: '2026-11-03',
      end: '2026-11-03',
      source: 'said',
      certainty: 'tentative',
    });
    const timeline = await loadTimeline();
    expect(whereaboutsAt(timeline, at('2026-11-03T18:00:00Z'))).toMatchObject({
      zone: null,
      zoneLabel: 'zone unknown',
      placeId: null,
    });
    expect(zoneForDay(timeline, '2026-11-03')).toBeNull();
  });
});
