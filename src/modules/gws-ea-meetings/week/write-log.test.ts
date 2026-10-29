import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, initTestDb, runMigrations } from '../../../db/index.js';
import '../index.js';
import {
  beginCalendarWrite,
  markCalendarWriteApplied,
  completeCalendarWriteFindings,
  getCalendarWrite,
} from './write-log.js';
import { recordPendingCalendarChange, settledCalendarChanges, settleCalendarChanges } from './pending-changes.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
});
it('durably keeps one request and its findings gap until a successful recheck', async () => {
  const write = {
    requestId: 'req-1',
    calendarId: 'morgan@ellery.example',
    eventId: 'call',
    action: 'change_event' as const,
    request: { start: '2026-10-05T16:00:00Z' },
    before: null,
    affectedStart: '2026-10-05T16:00:00Z',
    affectedEnd: '2026-10-06T17:00:00Z',
  };
  await beginCalendarWrite(write);
  await beginCalendarWrite(write);
  await markCalendarWriteApplied('req-1', 'Changed.');
  expect(await getCalendarWrite('req-1')).toMatchObject({
    state: 'applied',
    outcome: 'Changed.',
    findingsChecked: false,
  });
  await completeCalendarWriteFindings('req-1');
  expect(await getCalendarWrite('req-1')).toMatchObject({ findingsChecked: true });
});
it('coalesces an event until its last change settles and acknowledges only the flushed version', async () => {
  const notice = { calendarId: 'morgan@ellery.example', eventId: 'dinner', change: 'changed' as const };
  await recordPendingCalendarChange('gmail-1', notice, new Date('2026-10-05T16:00:00Z'));
  await recordPendingCalendarChange('gmail-2', notice, new Date('2026-10-05T16:00:20Z'));
  expect(await settledCalendarChanges(new Date('2026-10-05T16:00:40Z'))).toEqual([]);
  const ready = await settledCalendarChanges(new Date('2026-10-05T16:02:00Z'));
  expect(ready).toMatchObject([{ notice, messageIds: ['gmail-1', 'gmail-2'] }]);
  await recordPendingCalendarChange('gmail-3', notice, new Date('2026-10-05T16:02:01Z'));
  await settleCalendarChanges(ready);
  expect(await settledCalendarChanges(new Date('2026-10-05T16:04:00Z'))).toMatchObject([{ messageIds: ['gmail-3'] }]);
});
