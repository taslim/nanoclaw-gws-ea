import { afterEach, expect, it } from 'vitest';
import { closeDb, initSqliteTestDb } from '../../../db/connection.js';
import { getRegisteredMigrations, runMigrations } from '../../../db/migrations/index.js';
import '../index.js';
import { beginCalendarWrite, getCalendarSplitRecovery, getCalendarWrite } from './write-log.js';
import { calendarSplitRecoveryMigration } from './split-recovery-migration.js';

afterEach(closeDb);

it('upgrades existing write receipts with event scope and preserves them on a second migration run', async () => {
  const db = await initSqliteTestDb();
  await runMigrations(
    db,
    getRegisteredMigrations().filter(
      (migration) => !migration.name.startsWith('module:gws-ea-meetings:') || migration.version < 7,
    ),
  );
  await db.run(
    `INSERT INTO gws_ea_calendar_write_log
    (request_id,calendar_id,event_id,action,fingerprint,request_json,before_json,affected_start,affected_end,state,outcome,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'legacy',
    'morgan@ellery.example',
    'event-1',
    'change_event',
    'legacy-fingerprint',
    '{}',
    null,
    '2026-10-05T16:00:00Z',
    '2026-10-05T17:00:00Z',
    'applied',
    'Changed.',
    '2026-10-05T15:00:00Z',
  );
  await runMigrations(db);
  const first = await getCalendarWrite('legacy');
  expect(first).toMatchObject({ requestId: 'legacy', refreshScope: 'event', outcome: 'Changed.', state: 'applied' });
  await runMigrations(db);
  expect(await getCalendarWrite('legacy')).toEqual(first);
  expect(await db.all('SELECT * FROM gws_ea_calendar_split_recovery')).toEqual([]);
  expect(await db.all('PRAGMA foreign_key_check')).toEqual([]);
  expect(await db.all('SELECT * FROM schema_version WHERE name=?', calendarSplitRecoveryMigration.name)).toHaveLength(
    1,
  );
});

it('atomically owns a durable split recovery and refuses a different session claiming its request', async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
  const write = {
    requestId: 'owned',
    calendarId: 'morgan@ellery.example',
    eventId: 'series_2',
    action: 'change_event' as const,
    request: { scope: 'following' },
    before: null,
    refreshScope: 'series' as const,
    affectedStart: '2026-10-05T16:00:00Z',
    affectedEnd: '2026-10-05T17:00:00Z',
    plan: {
      patch: {},
      split: {
        masterId: 'series',
        master: { id: 'series', etag: 'v1' },
        trim: ['RRULE:FREQ=WEEKLY;COUNT=1'],
        deleteMaster: false,
        followingId: 'following',
        following: { start: '2026-10-05T16:00:00Z', end: '2026-10-05T17:00:00Z' },
      },
    },
  };
  await beginCalendarWrite(write, 'session-a');
  await expect(beginCalendarWrite(write, 'session-b')).rejects.toThrow('different session');
  expect(await getCalendarSplitRecovery('owned')).toMatchObject({
    sessionId: 'session-a',
    attempts: 0,
    reported: false,
  });
  expect(await getCalendarWrite('owned')).toMatchObject({ refreshScope: 'series', state: 'pending' });
  expect(await db.all('SELECT request_id FROM gws_ea_calendar_write_log')).toHaveLength(1);
  expect(await db.all('SELECT request_id FROM gws_ea_calendar_split_recovery')).toHaveLength(1);
});
