import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { calendarWriteLogMigration } from '../gws-ea-meetings/week/write-log-migration.js';
import { beginCalendarWrite, markCalendarWriteApplied } from '../gws-ea-meetings/week/write-log.js';
import {
  closeRunsMigration,
  recordCloseLedger,
  completeCloseRun,
  failCloseRun,
  getOpenCloseRun,
  lastCompletedClose,
} from './close-runs.js';
import { openClose } from './testing/main-conversation.js';
beforeEach(async () => {
  await runMigrations(await initTestDb());
  await runMigrations(getDb(), [calendarWriteLogMigration, closeRunsMigration]);
});
afterEach(closeDb);
async function write(id: string) {
  await beginCalendarWrite({
    requestId: id,
    calendarId: 'morgan@example.test',
    eventId: id,
    action: 'change_event',
    request: {},
    before: null,
    affectedStart: '2026-10-27T12:00:00Z',
    affectedEnd: '2026-10-27T13:00:00Z',
  });
  await markCalendarWriteApplied(id, 'Changed.');
  return (await getDb().get<{ updated_at: string }>(
    'SELECT updated_at FROM gws_ea_calendar_write_log WHERE request_id=?',
    id,
  ))!.updated_at;
}
it('advances only on the exact open run marker and only to its captured coverage', async () => {
  const version = await write('used');
  await openClose('close-one', 'close-session');
  expect(await getOpenCloseRun('close-session')).toMatchObject({ id: 'close-one', state: 'open' });
  await expect(completeCloseRun('close-one', 'close-session')).rejects.toThrow(/ledger/u);
  await recordCloseLedger('close-one', 'close-session', {
    through: '2026-10-27T21:00:00.000Z',
    writes: [{ requestId: 'used', updatedAt: version }],
    inbound: {},
  });
  await expect(completeCloseRun('close-one', 'other')).rejects.toThrow(/open/u);
  expect(await lastCompletedClose()).toBeUndefined();
  await completeCloseRun('close-one', 'close-session');
  expect(await lastCompletedClose()).toMatchObject({
    state: 'completed',
    ledger_through_at: '2026-10-27T21:00:00.000Z',
  });
  expect(await getDb().all('SELECT * FROM gws_ea_calendar_write_log')).toEqual([]);
  await expect(completeCloseRun('close-one', 'close-session')).rejects.toThrow(/open/u);
});
it('retains failed, unread and subsequently changed write evidence', async () => {
  const version = await write('changed');
  await write('unread');
  await openClose('failed', 'session');
  await recordCloseLedger('failed', 'session', {
    through: '2026-10-27T21:00:00.000Z',
    writes: [{ requestId: 'changed', updatedAt: version }],
    inbound: {},
  });
  await failCloseRun('failed');
  expect(await lastCompletedClose()).toBeUndefined();
  expect(await getDb().all('SELECT request_id FROM gws_ea_calendar_write_log')).toHaveLength(2);
  await openClose('next', 'next-session');
  await recordCloseLedger('next', 'next-session', {
    through: '2026-10-28T21:00:00.000Z',
    writes: [{ requestId: 'changed', updatedAt: version }],
    inbound: {},
  });
  await getDb().run(
    "UPDATE gws_ea_calendar_write_log SET updated_at='2026-10-28T21:01:00Z' WHERE request_id='changed'",
  );
  await completeCloseRun('next', 'next-session');
  expect(await getDb().all('SELECT request_id FROM gws_ea_calendar_write_log')).toHaveLength(2);
});
