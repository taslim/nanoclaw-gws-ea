import { afterEach, beforeEach, expect, it } from 'vitest';

import { closeDb, getDb, initSqliteTestDb } from '../../db/connection.js';
import { getRegisteredMigrations, runMigrations } from '../../db/migrations/index.js';
import '../index.js';
import {
  bookingOwner,
  deleteBooking,
  deleteBookingRequest,
  getBooking,
  getBookingRequest,
  hasPendingBookingRequest,
  listPendingBookingRequests,
  markBookingRequestApplied,
  markBookingRequestReported,
  recordBooking,
  recordBookingRequest,
  type NewBookingRequest,
} from './bookings-db.js';
import { bookingsMigration } from './bookings-migration.js';

const AT = '2026-10-18T12:00:00.000Z';
const CALENDAR = 'Juno.Hale@example.com';
const THREAD = { kind: 'thread', key: 'mail-juno-venue' } as const;
const CHAT = { kind: 'chat', key: 'chat-mira-venue' } as const;

function request(overrides: Partial<NewBookingRequest> = {}): NewBookingRequest {
  return {
    sessionId: 'session-juno',
    requestId: 'change-venue',
    action: 'change',
    fingerprint: 'fingerprint-venue',
    requestJson: '{"title":"Venue visit"}',
    owner: THREAD,
    calendarId: CALENDAR,
    eventId: 'event-venue',
    startAt: '2026-10-20T12:00:00.000Z',
    endAt: '2026-10-20T12:30:00.000Z',
    eventEtag: '"version-before-change"',
    createdAt: AT,
    ...overrides,
  };
}

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db, [
    ...getRegisteredMigrations().filter((migration) => migration.name !== bookingsMigration.name),
    bookingsMigration,
  ]);
});

afterEach(closeDb);

it('records both owner kinds, finds their own events and finds an owner with any calendar letter case', async () => {
  const threadBooking = { owner: THREAD, calendarId: CALENDAR, eventId: 'event-juno', bookedAt: AT };
  const chatBooking = { owner: CHAT, calendarId: CALENDAR, eventId: 'event-mira', bookedAt: AT };
  await recordBooking(threadBooking);
  await recordBooking(chatBooking);

  expect(await getBooking(THREAD, 'event-juno')).toEqual(threadBooking);
  expect(await getBooking(CHAT, 'event-mira')).toEqual(chatBooking);
  expect(await getBooking(CHAT, 'event-juno')).toBeUndefined();
  expect(await bookingOwner('juno.hale@EXAMPLE.COM', 'event-juno')).toEqual(THREAD);
  expect(await bookingOwner('JUNO.HALE@example.com', 'event-mira')).toEqual(CHAT);
  expect(await bookingOwner(CALENDAR, 'event-missing')).toBeUndefined();

  await recordBooking({ ...threadBooking, owner: CHAT, bookedAt: '2026-10-19T12:00:00.000Z' });
  expect(await getBooking(THREAD, 'event-juno')).toEqual(threadBooking);
  await deleteBooking(CALENDAR, 'event-juno');
  expect(await getBooking(THREAD, 'event-juno')).toBeUndefined();
  expect(await getBooking(CHAT, 'event-mira')).toEqual(chatBooking);
});

it('keeps the first request for a matching fingerprint and refuses different work under the same id', async () => {
  const first = await recordBookingRequest(request());
  expect(first).toEqual({ ...request(), carriedOver: false, applied: false, resultJson: null, reported: false });
  const replay = await recordBookingRequest(request({ eventEtag: '"newer-version"' }));
  expect(replay).toEqual(first);
  await expect(recordBookingRequest(request({ fingerprint: 'different-work' }))).rejects.toThrow(/different/u);
  expect(await getBookingRequest('session-juno', 'change-venue')).toEqual(first);

  const otherSession = await recordBookingRequest(request({ sessionId: 'session-mira', owner: CHAT }));
  expect(otherSession.sessionId).toBe('session-mira');
});

it('keeps the first applied result, holds a booking only until reported, and retains reported work for mailbox cleanup', async () => {
  await recordBookingRequest(request());
  expect(await hasPendingBookingRequest(THREAD, 'event-venue')).toBe(true);
  expect(await hasPendingBookingRequest(THREAD, 'another-event')).toBe(false);
  expect(await hasPendingBookingRequest(CHAT, 'event-venue')).toBe(false);

  await markBookingRequestApplied('session-juno', 'change-venue', '{"booking":"event-venue","outcome":"changed"}');
  await markBookingRequestApplied('session-juno', 'change-venue', '{"outcome":"different"}');
  expect(await getBookingRequest('session-juno', 'change-venue')).toMatchObject({
    applied: true,
    resultJson: '{"booking":"event-venue","outcome":"changed"}',
    reported: false,
  });
  expect(await hasPendingBookingRequest(THREAD, 'event-venue')).toBe(true);

  await markBookingRequestReported('session-juno', 'change-venue');
  await markBookingRequestReported('session-juno', 'change-venue');
  expect(await hasPendingBookingRequest(THREAD, 'event-venue')).toBe(false);
  expect(await listPendingBookingRequests()).toMatchObject([{ requestId: 'change-venue', reported: true }]);
  await deleteBookingRequest('session-juno', 'change-venue');
  expect(await getBookingRequest('session-juno', 'change-venue')).toBeUndefined();
  expect(await listPendingBookingRequests()).toEqual([]);
});

it('lists unfinished requests oldest first across owners and keeps them after their session is removed', async () => {
  const db = getDb();
  await db.run('INSERT INTO agent_groups(id,name,folder,created_at) VALUES(?,?,?,?)', 'agent-juno', 'Juno', 'juno', AT);
  await db.run('INSERT INTO sessions(id,agent_group_id,created_at) VALUES(?,?,?)', 'session-juno', 'agent-juno', AT);
  await recordBookingRequest(request({ requestId: 'newer', createdAt: '2026-10-19T12:00:00.000Z' }));
  await recordBookingRequest(request({ requestId: 'older', owner: CHAT }));
  await db.run('DELETE FROM sessions WHERE id=?', 'session-juno');

  expect((await listPendingBookingRequests()).map((row) => row.requestId)).toEqual(['older', 'newer']);
  expect(await getBookingRequest('session-juno', 'older')).toMatchObject({ owner: CHAT });
});
