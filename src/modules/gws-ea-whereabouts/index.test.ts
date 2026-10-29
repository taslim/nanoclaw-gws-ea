import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-privacy/index.js';
import {
  addPlace,
  addStay,
  dismissStay,
  getWhereabouts,
  setBase,
  setRhythm,
  getWhereaboutsHistory,
  syncDerivedStays,
} from './db.js';
import { onWhereaboutsChange } from './changes.js';
import { deriveLegs } from './derive.js';
import { loadTimeline, zoneAt } from './timeline.js';
import './index.js';

const HOST: CallerContext = { caller: 'host' };
const main: CallerContext = {
  caller: 'agent',
  sessionId: 's-main',
  agentGroupId: 'ag-main',
  messagingGroupId: 'mg-main',
};
const other: CallerContext = { ...main, agentGroupId: 'ag-other' };
const run = (verb: string, args: Record<string, unknown> = {}, ctx: CallerContext = main) =>
  dispatch({ id: verb, command: `whereabouts-${verb}`, args }, ctx);

beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const id of ['ag-main', 'ag-other']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: '2026-10-28T00:00:00Z' });
    await ensureContainerConfig(id);
    await updateContainerConfigScalars(id, { cli_scope: 'global' });
  }
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name = 'Juno', principal_first_name = 'Morgan', main_agent_group_id = ?, principal_timezone = ? WHERE singleton = 1",
    'ag-main',
    'America/Los_Angeles',
  );
});
afterEach(closeDb);

describe('main-only whereabouts commands', () => {
  it('refuses every command for another agent, while the host can inspect', async () => {
    for (const verb of [
      'get',
      'base-set',
      'rhythm-set',
      'place-add',
      'pair-set',
      'travel-set',
      'stay-add',
      'stay-dismiss',
      'history',
    ]) {
      const response = await run(verb, {}, other);
      expect(response).toMatchObject({ ok: false, error: { message: expect.stringContaining('only to main') } });
    }
    expect(await run('get', {}, HOST)).toMatchObject({ ok: true });
  });
  it('records places, travel, explicit none rhythm, and keeps base history', async () => {
    expect(
      await run('place-add', { id: 'office', label: 'Office', locality: 'Berkeley', zone: 'America/Los_Angeles' }),
    ).toMatchObject({ ok: true });
    expect(await run('base-set', { place: 'office', trip_source: 'none' })).toMatchObject({ ok: true });
    expect(await run('rhythm-set', { weekdays: 'none' })).toMatchObject({ ok: true });
    expect(
      await run('pair-set', { from: 'home', to: 'office', mode: 'walk', minutes: 20, source: 'learned' }),
    ).toMatchObject({ ok: false });
    await addPlace({ id: 'station', label: 'Station', locality: 'Berkeley', zone: 'America/Los_Angeles' });
    expect(
      await run('pair-set', { from: 'station', to: 'office', mode: 'walk', minutes: 20, source: 'learned' }),
    ).toMatchObject({ ok: true, data: { minutes: 20 } });
    expect(
      await run('travel-set', { event: 'meeting-42', mode: 'rail', minutes: 40, source: 'estimated' }),
    ).toMatchObject({ ok: true, data: { event_id: 'meeting-42', minutes: 40 } });
    await setBase({ tripSource: 'mail' });
    const history = await run('history');
    expect(history).toMatchObject({
      ok: true,
      data: expect.arrayContaining([
        expect.objectContaining({ kind: 'base', previous: expect.objectContaining({ trip_source: 'none' }) }),
      ]),
    });
  });
  it('persists a dismissal through changed calendar versions; an explicit stay add undoes it', async () => {
    const event = {
      id: 'flight',
      start: { dateTime: '2026-11-01T21:00:00-08:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-11-02T17:00:00+01:00', timeZone: 'Europe/Brussels' },
      location: 'Brussels',
    };
    const window = { start: Date.parse('2026-11-01'), end: Date.parse('2026-11-10') };
    await syncDerivedStays(deriveLegs([event]), window);
    await dismissStay({ sourceEventId: 'flight', reason: 'The ticket belongs to Remy.' });
    await syncDerivedStays(
      deriveLegs([{ ...event, end: { ...event.end, dateTime: '2026-11-02T18:00:00+01:00' } }]),
      window,
    );
    expect((await getWhereabouts()).stays).toEqual([]);
    expect((await getWhereabouts()).dismissed_events).toEqual([
      expect.objectContaining({ source_event_id: 'flight', reason: 'The ticket belongs to Remy.' }),
    ]);
    await addStay({
      locality: 'Brussels',
      zone: 'Europe/Brussels',
      start: '2026-11-02',
      end: '2026-11-07',
      source: 'calendar',
      certainty: 'certain',
      sourceEventId: 'flight',
    });
    expect((await getWhereabouts()).dismissed_events).toEqual([]);
    expect(zoneAt(await loadTimeline(), Date.parse('2026-11-03T12:00:00Z'))).toBe('Europe/Brussels');
  });
  it('reconciles cancelled or absent calendar legs only in the read window and signals committed edits', async () => {
    const changes: string[] = [];
    const unsubscribe = onWhereaboutsChange((change) => {
      changes.push(change.kind);
    });
    try {
      await addPlace({ id: 'paris', label: 'Paris', locality: 'Paris', zone: 'Europe/Paris' });
      const event = {
        id: 'flight',
        start: { dateTime: '2026-11-01T21:00:00-08:00', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-11-02T17:00:00+01:00', timeZone: 'Europe/Brussels' },
        location: 'Brussels',
      };
      const window = { start: Date.parse('2026-11-01'), end: Date.parse('2026-11-10') };
      await syncDerivedStays(deriveLegs([event]), window);
      await syncDerivedStays([], { start: Date.parse('2026-12-01'), end: Date.parse('2026-12-10') });
      expect((await getWhereabouts()).stays).toHaveLength(1);
      await syncDerivedStays([], window);
      expect((await getWhereabouts()).stays).toHaveLength(0);
      expect(changes).toEqual(['place', 'derived', 'derived']);
    } finally {
      unsubscribe();
    }
  });
  it('keeps rhythm history with minute clock values', async () => {
    await addPlace({ id: 'office', label: 'Office', locality: 'Berkeley', zone: 'America/Los_Angeles' });
    await setRhythm({ weekdays: ['mon'], placeId: 'office', start: '09:05', end: '17:30' });
    await setRhythm({ weekdays: ['mon'], placeId: 'office', start: '10:00', end: '18:00' });
    expect((await getWhereabouts()).rhythm).toEqual([
      expect.objectContaining({ weekday: 'mon', start_minute: 600, end_minute: 1080 }),
    ]);
    expect(await getWhereaboutsHistory()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'rhythm',
          previous: { known: true, days: [expect.objectContaining({ start_minute: 545, end_minute: 1050 })] },
        }),
      ]),
    );
  });

  it('removes an absent overnight flight that overlaps the read window and does not rewrite unchanged legs', async () => {
    const event = {
      id: 'overnight',
      start: { dateTime: '2026-11-01T21:00:00-08:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-11-02T17:00:00+01:00', timeZone: 'Europe/Brussels' },
      location: 'Brussels',
    };
    const window = { start: Date.parse('2026-11-02T00:00:00Z'), end: Date.parse('2026-11-03T00:00:00Z') };
    await syncDerivedStays(deriveLegs([event]), window);
    expect(await syncDerivedStays(deriveLegs([{ ...event, etag: 'guest-answer-changed' }]), window)).toEqual({
      changed: false,
    });
    await syncDerivedStays([], { start: Date.parse('2026-11-02T08:00:00Z'), end: Date.parse('2026-11-03T00:00:00Z') });
    expect((await getWhereabouts()).stays).toEqual([]);
  });
});
