import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { calendarWriteLogMigration } from '../gws-ea-meetings/week/write-log-migration.js';
import { calendarSplitRecoveryMigration } from '../gws-ea-meetings/week/split-recovery-migration.js';
import { beginCalendarWrite, markCalendarWriteApplied } from '../gws-ea-meetings/week/write-log.js';
import {
  closeRunsMigration,
  beginCloseRun,
  recordCloseLedger,
  completeCloseRun,
  failCloseRun,
  lastCompletedClose,
  listOpenCloseRuns,
} from './close-runs.js';
beforeEach(async () => {
  await runMigrations(await initTestDb(), [
    calendarWriteLogMigration,
    calendarSplitRecoveryMigration,
    closeRunsMigration,
  ]);
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
  await beginCloseRun({ id: 'close-one', sessionId: 'close-session', taskId: 'task-one' });
  expect(await listOpenCloseRuns()).toMatchObject([
    { id: 'close-one', task_id: 'task-one', session_id: 'close-session' },
  ]);
  await expect(completeCloseRun('close-one', 'close-session')).rejects.toThrow(/ledger/u);
  await recordCloseLedger('close-one', 'close-session', {
    from: null,
    through: '2026-10-27T21:00:00.000Z',
    writes: [{ requestId: 'used', updatedAt: version }],
  });
  await expect(completeCloseRun('close-one', 'other')).rejects.toThrow(/open/u);
  expect(await lastCompletedClose()).toBeUndefined();
  await completeCloseRun('close-one', 'close-session', '2026-10-27T21:15:00.000Z');
  expect(await lastCompletedClose()).toMatchObject({
    state: 'completed',
    ledger_through_at: '2026-10-27T21:00:00.000Z',
    done_at: '2026-10-27T21:15:00.000Z',
  });
  expect(await getDb().all('SELECT * FROM gws_ea_calendar_write_log')).toEqual([]);
  await expect(completeCloseRun('close-one', 'close-session')).rejects.toThrow(/open/u);
});
it('retains failed, unread and subsequently changed write evidence', async () => {
  const version = await write('changed');
  await write('unread');
  await beginCloseRun({ id: 'failed', sessionId: 'session', taskId: 'task' });
  await recordCloseLedger('failed', 'session', {
    from: null,
    through: '2026-10-27T21:00:00.000Z',
    writes: [{ requestId: 'changed', updatedAt: version }],
  });
  await failCloseRun('failed');
  expect(await lastCompletedClose()).toBeUndefined();
  expect(await getDb().all('SELECT request_id FROM gws_ea_calendar_write_log')).toHaveLength(2);
  await beginCloseRun({ id: 'next', sessionId: 'session', taskId: 'next-task' });
  await recordCloseLedger('next', 'session', {
    from: null,
    through: '2026-10-28T21:00:00.000Z',
    writes: [{ requestId: 'changed', updatedAt: version }],
  });
  await getDb().run(
    "UPDATE gws_ea_calendar_write_log SET updated_at='2026-10-28T21:01:00Z' WHERE request_id='changed'",
  );
  await completeCloseRun('next', 'session');
  expect(await getDb().all('SELECT request_id FROM gws_ea_calendar_write_log')).toHaveLength(2);
});
