import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-privacy/index.js';
import '../gws-ea-whereabouts/index.js';
import { addStay } from '../gws-ea-whereabouts/db.js';
import { loadTimeline } from '../gws-ea-whereabouts/timeline.js';
import { parseMatterDueAt, resolveMatterDueAt } from './planning.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await getDb().run("UPDATE gws_ea_profile SET principal_timezone = 'America/Los_Angeles' WHERE singleton = 1");
});
afterEach(closeDb);

it('resolves a local due date in that date’s stay zone and keeps a fixed moment fixed', async () => {
  await addStay({
    locality: 'Brussels',
    zone: 'Europe/Brussels',
    start: '2026-12-30',
    end: '2026-12-31',
    source: 'mail',
    certainty: 'certain',
  });
  const timeline = await loadTimeline();
  expect(parseMatterDueAt('2026-12-31')).toBe('2026-12-31');
  expect(resolveMatterDueAt('2026-12-31', timeline)).toMatchObject({
    instant: Date.parse('2026-12-31T23:00:00Z'),
    zone: 'Europe/Brussels',
    dateOnly: true,
  });
  const fixed = parseMatterDueAt('2026-12-31T17:30:00-08:00');
  expect(fixed).toBe('2027-01-01T01:30:00.000Z');
  expect(resolveMatterDueAt(fixed ?? '', timeline)).toMatchObject({
    instant: Date.parse('2027-01-01T01:30:00Z'),
    dateOnly: false,
  });
  expect(() => parseMatterDueAt('2026-02-30')).toThrow(/date/i);
});
