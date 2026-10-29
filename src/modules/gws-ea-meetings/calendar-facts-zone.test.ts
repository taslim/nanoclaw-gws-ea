import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-whereabouts/index.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import { addStay } from '../gws-ea-whereabouts/db.js';
import { findPrincipalCalendarConflicts } from './calendar-facts.js';
import { FakeCalendar } from './testing/fake-calendar.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await getDb().run("UPDATE gws_ea_profile SET principal_timezone='America/Los_Angeles'");
  await addPrincipalAddress('morgan@example.test');
  await addStay({
    locality: 'Brussels',
    zone: 'Europe/Brussels',
    source: 'said',
    certainty: 'certain',
    start: '2026-11-10T00:00:00Z',
    end: '2026-11-15T00:00:00Z',
  });
});
afterEach(async () => {
  await closeDb();
});

it('reads each conflicting moment on its covering clock, without changing the home profile', async () => {
  const calendar = new FakeCalendar();
  calendar.calendars.set('morgan@example.test', { id: 'morgan@example.test', accessRole: 'owner' });
  calendar.put({
    calendarId: 'morgan@example.test',
    id: 'brussels-call',
    summary: 'Call with Juno',
    start: { dateTime: '2026-11-12T08:00:00Z' },
    end: { dateTime: '2026-11-12T09:00:00Z' },
  });
  const result = await findPrincipalCalendarConflicts('2026-11-12T08:30:00Z', '2026-11-12T09:30:00Z', calendar);
  expect(result.conflicts).toMatchObject([{ start: '2026-11-12T09:00+01:00', end: '2026-11-12T10:00+01:00' }]);
  expect(await getDb().get('SELECT principal_timezone FROM gws_ea_profile')).toMatchObject({
    principal_timezone: 'America/Los_Angeles',
  });
});
