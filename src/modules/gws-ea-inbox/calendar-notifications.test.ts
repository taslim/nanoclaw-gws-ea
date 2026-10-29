import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const note = vi.hoisted(() => vi.fn().mockResolvedValue('written'));
vi.mock('../gws-ea-profile/main-note.js', () => ({ writeNoteForMain: note }));
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { registerMigration } from '../../db/migrations/index.js';
import { pendingCalendarChangesMigration } from '../gws-ea-meetings/week/pending-changes-migration.js';
import { recordPendingCalendarChange, hasPendingCalendarChanges } from '../gws-ea-meetings/week/pending-changes.js';
import { flushPendingCalendarChanges, registerCalendarChangeRenderer } from './calendar-notifications.js';
registerMigration(pendingCalendarChangesMigration);
const renderer = vi.fn().mockResolvedValue({ text: 'Findings: a linked travel block no longer reaches dinner.' });
registerCalendarChangeRenderer(renderer);
beforeEach(async () => {
  await runMigrations(await initTestDb());
  note.mockClear();
  note.mockResolvedValue('written');
  renderer.mockReset();
  renderer.mockResolvedValue({ text: 'Findings: a linked travel block no longer reaches dinner.' });
});
afterEach(async () => {
  await closeDb();
});
const notice = { calendarId: 'morgan@ellery.example', eventId: 'dinner', change: 'changed' as const };
it('delivers two edits as one settled note and retains a later edit that arrives during rendering', async () => {
  await recordPendingCalendarChange('gmail-1', notice, new Date('2026-10-05T16:00:00Z'));
  await recordPendingCalendarChange('gmail-2', notice, new Date('2026-10-05T16:00:20Z'));
  expect(await flushPendingCalendarChanges(new Date('2026-10-05T16:00:40Z'))).toBe(0);
  renderer.mockImplementationOnce(async () => {
    await recordPendingCalendarChange('gmail-3', notice, new Date('2026-10-05T16:02:01Z'));
    return { text: 'Findings: linked travel block.' };
  });
  expect(await flushPendingCalendarChanges(new Date('2026-10-05T16:02:00Z'))).toBe(1);
  expect(note).toHaveBeenCalledTimes(1);
  expect(note.mock.calls[0][0]).toMatchObject({
    wake: true,
    text: expect.stringContaining('Findings: linked travel block.'),
  });
  expect(await hasPendingCalendarChanges()).toBe(true);
  expect(await flushPendingCalendarChanges(new Date('2026-10-05T16:04:00Z'))).toBe(1);
  expect(await hasPendingCalendarChanges()).toBe(false);
});
it('settles and delivers a note when findings rendering fails, with one retry-safe message id', async () => {
  await recordPendingCalendarChange('gmail-1', notice, new Date('2026-10-05T16:00:00Z'));
  renderer.mockRejectedValueOnce(new Error('checker unavailable'));
  expect(await flushPendingCalendarChanges(new Date('2026-10-05T16:02:00Z'))).toBe(1);
  expect(note.mock.calls[0][0].text).toContain('findings unavailable');
  expect(await hasPendingCalendarChanges()).toBe(false);
  expect(await flushPendingCalendarChanges(new Date('2026-10-05T16:03:00Z'))).toBe(0);
});
