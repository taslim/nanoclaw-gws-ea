import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, initTestDb, runMigrations } from '../../../db/index.js';
import '../index.js';
import { acknowledgeFinding, loadAcknowledgements } from './acks.js';
import { checkWeek } from './checker.js';
import { buildWeek } from './model.js';
import { event, input } from './testing/fixture.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
});
it('persists a finding version once, and a later event version is visible again', async () => {
  const original = event('e', '2026-10-05T11:30:00-07:00', '2026-10-05T14:00:00-07:00');
  const week = buildWeek(input([original]));
  const finding = checkWeek(week).find((f) => f.kind === 'meal')!;
  await acknowledgeFinding(finding);
  await acknowledgeFinding(finding);
  const acks = await loadAcknowledgements();
  expect(acks).toMatchObject([{ key: finding.key, version: finding.version, kind: 'meal' }]);
  expect(acks[0].acknowledged_at).toMatch(/^\d{4}-\d{2}-\d{2}T.+Z$/u);
  expect(checkWeek(week, acks).some((f) => f.kind === 'meal')).toBe(false);
  const changed = { ...original, event: { ...original.event, end: { dateTime: '2026-10-05T14:15:00-07:00' } } };
  expect(checkWeek(buildWeek(input([changed])), acks).some((f) => f.kind === 'meal')).toBe(true);
});
