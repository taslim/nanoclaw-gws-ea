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

  it('takes a certain stay overlapping calendar stays in either order, the shorter one winning', async () => {
    const legs = deriveLegs([
      {
        id: 'out',
        start: { dateTime: '2026-11-01T21:00:00-08:00', timeZone: PACIFIC },
        end: { dateTime: '2026-11-02T17:00:00+01:00', timeZone: BRUSSELS },
      },
      {
        id: 'onward',
        start: { dateTime: '2026-11-06T17:00:00+01:00', timeZone: BRUSSELS },
        end: { dateTime: '2026-11-06T17:15:00+00:00', timeZone: 'Europe/London' },
      },
    ]);
    const window = { start: at('2026-10-31T00:00:00Z'), end: at('2026-11-10T00:00:00Z') };
    await syncDerivedStays(legs, window);
    await addStay({
      locality: 'Brussels',
      zone: BRUSSELS,
      start: '2026-11-02',
      end: '2026-11-06',
      source: 'mail',
      certainty: 'certain',
    });
    const timeline = await loadTimeline();
    expect(whereaboutsAt(timeline, at('2026-11-06T20:00:00Z'))).toMatchObject({ locality: 'Brussels', zone: BRUSSELS });
    expect(zoneAt(timeline, at('2026-11-08T12:00:00Z'))).toBe('Europe/London');
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
      },
    ]);
    await syncDerivedStays(legs, { start: at('2026-11-01T00:00:00Z'), end: at('2026-11-10T00:00:00Z') });
    const timeline = await loadTimeline();
    expect(zoneAt(timeline, at('2026-11-02T15:59:59Z'))).toBe(PACIFIC);
    expect(zoneAt(timeline, at('2026-11-02T16:00:00Z'))).toBe(BRUSSELS);
    expect(zoneAt(timeline, at('2026-12-01T12:00:00Z'))).toBe(BRUSSELS);
    expect(gaps(timeline)).toContainEqual({
      kind: 'return',
      sourceEventId: 'outbound',
      message: 'return from Europe/Brussels unknown',
    });
  });

  it('uses the departure zone at the start of a westward flight date', async () => {
    const legs = deriveLegs([
      {
        id: 'west',
        start: { dateTime: '2026-11-02T00:30:00+01:00', timeZone: BRUSSELS },
        end: { dateTime: '2026-11-02T03:00:00-08:00', timeZone: PACIFIC },
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
      },
    ]);
    await syncDerivedStays(legs, { start: at('2026-11-01'), end: at('2026-11-10') });
    const serialized = JSON.parse(JSON.stringify(await loadTimeline())) as Timeline;
    expect(zoneAt(serialized, at('2026-12-01T12:00:00Z'))).toBe(BRUSSELS);
    expect(whereaboutsAt(serialized, at('2026-12-01T12:00:00Z')).placeId).toBeNull();
  });

  it('refuses a stay without its zone, and reports a saved place’s lost zone instead of substituting home', async () => {
    await home();
    const lisbon = {
      locality: 'Lisbon',
      start: '2026-11-03',
      end: '2026-11-03',
      source: 'said',
      certainty: 'tentative',
    };
    for (const zone of [undefined, 'unknown'])
      await expect(addStay({ ...lisbon, zone })).rejects.toThrow('A stay somewhere new needs --zone');
    await addPlace({ id: 'studio', label: 'Studio', locality: 'Lisbon' });
    await expect(addStay({ ...lisbon, locality: undefined, placeId: 'studio' })).rejects.toThrow(
      'Saved place studio has no zone',
    );
    expect((await getWhereabouts()).stays).toEqual([]);
    await addPlace({ id: 'studio', label: 'Studio', locality: 'Lisbon', zone: 'Europe/Lisbon' });
    await addStay({ ...lisbon, locality: undefined, placeId: 'studio' });
    await addPlace({ id: 'studio', label: 'Studio', locality: 'Lisbon', zone: 'unknown' });
    const timeline = await loadTimeline();
    expect(whereaboutsAt(timeline, at('2026-11-03T18:00:00Z'))).toMatchObject({
      zone: null,
      zoneLabel: 'zone unknown',
      placeId: 'studio',
    });
    expect(zoneForDay(timeline, '2026-11-03')).toBeNull();
  });

  describe('a trip on the calendar beside what main recorded', () => {
    // Pacific is on standard time and Brussels on winter time throughout.
    const outbound = {
      id: 'ua-900',
      start: { dateTime: '2026-11-09T18:00:00-08:00', timeZone: PACIFIC },
      end: { dateTime: '2026-11-10T13:30:00+01:00', timeZone: BRUSSELS },
      location: 'UA 900 SFO to BRU, confirmation K7Q2XZ, seat 14C',
    };
    const inbound = {
      id: 'ua-901',
      start: { dateTime: '2026-11-14T11:00:00+01:00', timeZone: BRUSSELS },
      end: { dateTime: '2026-11-14T13:30:00-08:00', timeZone: PACIFIC },
      location: 'UA 901 BRU to SFO, confirmation K7Q2XZ, seat 14C',
    };
    const window = { start: at('2026-11-01T00:00:00Z'), end: at('2026-11-30T00:00:00Z') };
    async function mailStay(start: string, end: string) {
      return addStay({ locality: 'Brussels', zone: BRUSSELS, start, end, source: 'mail', certainty: 'certain' });
    }

    it('syncs the doc walkthrough, a mailed Brussels stay plus both flights, and resolves by precedence', async () => {
      await home();
      await mailStay('2026-11-10', '2026-11-14');
      await expect(syncDerivedStays(deriveLegs([outbound, inbound]), window)).resolves.toEqual({ changed: true });
      const timeline = await loadTimeline();
      expect(whereaboutsAt(timeline, at('2026-11-12T12:00:00Z'))).toMatchObject({
        zone: BRUSSELS,
        locality: 'Brussels',
      });
      expect(zoneAt(timeline, at('2026-11-14T12:00:00Z'))).toBe(BRUSSELS);
      // Landed at 21:30Z; the mailed stay runs to the end of the 14th, Brussels time.
      expect(zoneAt(timeline, at('2026-11-14T22:00:00Z'))).toBe(BRUSSELS);
      expect(whereaboutsAt(timeline, at('2026-11-15T01:00:00Z'))).toMatchObject({ zone: PACIFIC, placeId: 'home' });
      expect(gaps(timeline)).toEqual([
        expect.objectContaining({ kind: 'rhythm' }),
        expect.objectContaining({ kind: 'trip-source' }),
      ]);
    });

    it('syncs a calendar leg that partly overlaps a certain stay main recorded', async () => {
      await mailStay('2026-11-10', '2026-11-14');
      const onward = {
        id: 'ba-389',
        start: { dateTime: '2026-11-14T17:00:00+01:00', timeZone: BRUSSELS },
        end: { dateTime: '2026-11-14T17:15:00+00:00', timeZone: 'Europe/London' },
      };
      await expect(syncDerivedStays(deriveLegs([outbound, onward]), window)).resolves.toEqual({ changed: true });
      const timeline = await loadTimeline();
      // The shorter certain stay wins while both cover the evening of the 14th.
      expect(zoneAt(timeline, at('2026-11-14T20:00:00Z'))).toBe(BRUSSELS);
      expect(zoneAt(timeline, at('2026-11-15T12:00:00Z'))).toBe('Europe/London');
    });

    it('hands the clock back to home, its base and rhythm, when a flight lands in the home zone', async () => {
      await home();
      await addPlace({ id: 'office', label: 'Office', locality: 'Oakland', zone: PACIFIC });
      await setRhythm({ weekdays: ['mon'], placeId: 'office', start: '09:00', end: '17:00' });
      await syncDerivedStays(deriveLegs([outbound, inbound]), window);
      let timeline = await loadTimeline();
      expect(zoneAt(timeline, at('2026-11-14T21:29:00Z'))).toBe(BRUSSELS);
      // Monday the 16th, 10:00 Pacific.
      expect(whereaboutsAt(timeline, at('2026-11-16T18:00:00Z'))).toMatchObject({ placeId: 'office', stay: null });
      expect(gaps(timeline).filter((gap) => gap.kind === 'return')).toEqual([]);
      await getDb().run('UPDATE gws_ea_profile SET principal_timezone = ? WHERE singleton = 1', 'America/New_York');
      timeline = await loadTimeline();
      expect(zoneAt(timeline, at('2026-11-15T12:00:00Z'))).toBe('America/New_York');
    });

    it('keeps the stay main recorded for a flight through the next calendar refresh', async () => {
      await syncDerivedStays(deriveLegs([outbound]), window);
      const derived = (await getWhereabouts()).stays[0];
      await addStay({
        id: derived.id,
        locality: 'Brussels',
        zone: BRUSSELS,
        start: '2026-11-10',
        end: '2026-11-16',
        source: 'mail',
        certainty: 'certain',
        sourceEventId: 'ua-900',
      });
      expect(await syncDerivedStays(deriveLegs([outbound]), window)).toEqual({ changed: false });
      expect((await getWhereabouts()).stays).toEqual([
        expect.objectContaining({ id: derived.id, end: '2026-11-16', derived: 0, source: 'mail' }),
      ]);
      const timeline = await loadTimeline();
      expect(zoneAt(timeline, at('2026-11-17T12:00:00Z'))).toBe(PACIFIC);
      expect(gaps(timeline).filter((gap) => gap.kind === 'return')).toEqual([]);
    });

    it('ends the stay before a flight main recorded at that flight’s departure', async () => {
      const onward = {
        id: 'ba-389',
        start: { dateTime: '2026-11-14T17:00:00+01:00', timeZone: BRUSSELS },
        end: { dateTime: '2026-11-14T17:15:00+00:00', timeZone: 'Europe/London' },
      };
      await syncDerivedStays(deriveLegs([outbound, onward]), window);
      await addStay({
        locality: 'London',
        zone: 'Europe/London',
        start: '2026-11-14T17:15:00+00:00',
        end: '2026-11-16',
        source: 'mail',
        certainty: 'certain',
        sourceEventId: 'ba-389',
      });
      await syncDerivedStays(deriveLegs([outbound, onward]), window);
      const timeline = await loadTimeline();
      expect(timeline.legs.map((leg) => leg.sourceEventId)).toEqual(['ua-900', 'ba-389']);
      expect(zoneAt(timeline, at('2026-11-15T12:00:00Z'))).toBe('Europe/London');
      expect(zoneAt(timeline, at('2026-11-18T12:00:00Z'))).toBe(PACIFIC);
    });

    it('lends a calendar stay the locality of a stay main recorded only where it lies within it', async () => {
      await syncDerivedStays(deriveLegs([outbound, inbound]), window);
      await addStay({
        locality: 'Antwerp',
        zone: BRUSSELS,
        start: '2026-11-11',
        end: '2026-11-12',
        source: 'mail',
        certainty: 'certain',
      });
      const timeline = await loadTimeline();
      expect(whereaboutsAt(timeline, at('2026-11-10T20:00:00Z'))).toMatchObject({ locality: null, zone: BRUSSELS });
      expect(whereaboutsAt(timeline, at('2026-11-12T12:00:00Z'))).toMatchObject({
        locality: 'Antwerp',
        zone: BRUSSELS,
      });
      expect(whereaboutsAt(timeline, at('2026-11-13T12:00:00Z'))).toMatchObject({ locality: null, zone: BRUSSELS });
    });

    it('stores only the destination zone of a calendar leg, never its event text', async () => {
      await syncDerivedStays(deriveLegs([outbound]), window);
      const [stay] = (await getWhereabouts()).stays;
      expect(stay).toMatchObject({ place_id: null, locality: null, zone: BRUSSELS, derived: 1 });
      const timeline = await loadTimeline();
      expect(JSON.stringify(timeline)).not.toContain('K7Q2XZ');
      expect(whereaboutsAt(timeline, at('2026-11-12T12:00:00Z'))).toMatchObject({ zone: BRUSSELS, locality: null });
    });
  });

  it('reads the zone of a place that is no longer home from the place itself', async () => {
    await getDb().run('UPDATE gws_ea_profile SET principal_timezone = ? WHERE singleton = 1', 'America/New_York');
    await addPlace({ id: 'brooklyn', label: 'Brooklyn flat', locality: 'New York' });
    await setBase({ placeId: 'brooklyn' });
    await getDb().run('UPDATE gws_ea_profile SET principal_timezone = ? WHERE singleton = 1', PACIFIC);
    await home();
    const edited = await addPlace({
      id: 'brooklyn',
      label: 'Brooklyn flat',
      locality: 'New York',
      zone: 'America/New_York',
    });
    expect(edited.zone).toBe('America/New_York');
    await addStay({
      placeId: 'brooklyn',
      start: '2026-12-01',
      end: '2026-12-05',
      source: 'said',
      certainty: 'certain',
    });
    const timeline = await loadTimeline();
    expect(zoneAt(timeline, at('2026-12-02T17:00:00Z'))).toBe('America/New_York');
    expect(zoneAt(timeline, at('2026-12-10T17:00:00Z'))).toBe(PACIFIC);
    expect(timeline.places.find((place) => place.id === 'home')?.zone).toBe(PACIFIC);
  });
});
