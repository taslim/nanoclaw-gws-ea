import { afterEach, expect, it } from 'vitest';

import { closeDb, initSqliteTestDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { getRegisteredMigrations, runMigrations } from '../../db/migrations/index.js';
import '../index.js';
import { bookingOwner, getBooking, getBookingRequest, listPendingBookingRequests } from './bookings-db.js';
import { bookingsMigration } from './bookings-migration.js';

const AT = '2026-10-18T12:00:00.000Z';
const CALENDAR = 'Juno.Hale@example.com';
const THREAD = { kind: 'thread', key: 'mail-juno-venue' } as const;
const CHAT = { kind: 'chat', key: 'chat-mira-venue' } as const;

afterEach(closeDb);

async function releasedDatabase(): Promise<DbDriver> {
  const db = await initSqliteTestDb();
  await runMigrations(
    db,
    getRegisteredMigrations().filter((migration) => migration.name !== bookingsMigration.name),
  );
  return db;
}

async function migrate(db: DbDriver): Promise<void> {
  await runMigrations(db, [
    ...getRegisteredMigrations().filter((migration) => migration.name !== bookingsMigration.name),
    bookingsMigration,
  ]);
}

async function seedChat(db: DbDriver): Promise<void> {
  await db.run('INSERT INTO agent_groups(id,name,folder,created_at) VALUES(?,?,?,?)', 'agent-juno', 'Juno', 'juno', AT);
  await db.run(
    'INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at) VALUES(?,?,?,?,?,?)',
    CHAT.key,
    'whatsapp',
    'whatsapp',
    'venue-group',
    1,
    AT,
  );
  await db.run(
    'INSERT INTO sessions(id,agent_group_id,messaging_group_id,created_at) VALUES(?,?,?,?)',
    'session-juno',
    'agent-juno',
    CHAT.key,
    AT,
  );
  await db.run(
    'INSERT INTO gws_ea_chats(messaging_group_id,state,serving_agent_group_id,principal_present,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    CHAT.key,
    'connected',
    'agent-juno',
    1,
    AT,
    AT,
  );
}

async function oldRequest(
  db: DbDriver,
  requestId: string,
  action: 'book' | 'change' | 'cancel',
  applied: number,
  result: string | null,
  reported: number,
  answered: number,
): Promise<void> {
  await db.run(
    'INSERT INTO gws_ea_chat_booking_requests(session_id,request_id,action,fingerprint,request_json,messaging_group_id,calendar_id,event_id,start_at,end_at,applied,result_json,reported,answered,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'session-juno',
    requestId,
    action,
    `fingerprint-${requestId}`,
    '{"title":"Venue visit"}',
    CHAT.key,
    CALENDAR,
    'event-mira',
    '2026-10-20T12:00:00.000Z',
    '2026-10-20T12:30:00.000Z',
    applied,
    result,
    reported,
    answered,
    AT,
  );
}

async function expectOldTablesGone(db: DbDriver): Promise<void> {
  for (const table of ['gws_ea_thread_bookings', 'gws_ea_chat_bookings', 'gws_ea_chat_booking_requests']) {
    expect(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table)).toBeUndefined();
  }
}

it('carries Juno Hale’s thread booking, the chat booking and unanswered requests over without losing their recovery state', async () => {
  const db = await releasedDatabase();
  await seedChat(db);
  await db.run('INSERT INTO gws_ea_threads(thread_key,created_at) VALUES(?,?)', THREAD.key, AT);
  await db.run(
    'INSERT INTO gws_ea_thread_bookings(thread_key,calendar_id,event_id,booked_at) VALUES(?,?,?,?)',
    THREAD.key,
    CALENDAR,
    'event-juno',
    AT,
  );
  await db.run(
    'INSERT INTO gws_ea_chat_bookings(messaging_group_id,calendar_id,event_id,booked_at) VALUES(?,?,?,?)',
    CHAT.key,
    CALENDAR,
    'event-mira',
    AT,
  );
  await oldRequest(db, 'change-venue', 'change', 0, null, 0, 0);
  await oldRequest(db, 'book-venue', 'book', 1, '{"booking":"event-mira","message":"Booked"}', 0, 0);
  await oldRequest(db, 'answered-venue', 'cancel', 1, '{"cancelled":true}', 1, 1);

  await migrate(db);

  expect(
    await db.all('SELECT owner_kind,owner_key,calendar_id,event_id,booked_at FROM gws_ea_bookings ORDER BY event_id'),
  ).toEqual([
    { owner_kind: 'thread', owner_key: THREAD.key, calendar_id: CALENDAR, event_id: 'event-juno', booked_at: AT },
    { owner_kind: 'chat', owner_key: CHAT.key, calendar_id: CALENDAR, event_id: 'event-mira', booked_at: AT },
  ]);
  expect(await getBooking(THREAD, 'event-juno')).toEqual({
    owner: THREAD,
    calendarId: CALENDAR,
    eventId: 'event-juno',
    bookedAt: AT,
  });
  expect(await bookingOwner('juno.hale@EXAMPLE.COM', 'event-mira')).toEqual(CHAT);
  expect(await getBookingRequest('session-juno', 'change-venue')).toEqual({
    sessionId: 'session-juno',
    requestId: 'change-venue',
    action: 'change',
    fingerprint: 'fingerprint-change-venue',
    requestJson: '{"title":"Venue visit"}',
    owner: CHAT,
    calendarId: CALENDAR,
    eventId: 'event-mira',
    startAt: '2026-10-20T12:00:00.000Z',
    endAt: '2026-10-20T12:30:00.000Z',
    eventEtag: null,
    requestMark: null,
    carriedOver: true,
    applied: false,
    resultJson: null,
    reported: false,
    createdAt: AT,
  });
  expect(await getBookingRequest('session-juno', 'book-venue')).toMatchObject({
    action: 'book',
    carriedOver: true,
    applied: true,
    resultJson: '{"booking":"event-mira","message":"Booked"}',
    reported: false,
  });
  expect(await getBookingRequest('session-juno', 'answered-venue')).toBeUndefined();
  expect(await listPendingBookingRequests()).toHaveLength(2);
  await expectOldTablesGone(db);
  expect(await db.all('PRAGMA foreign_key_check')).toEqual([]);

  await db.run('DELETE FROM sessions WHERE id=?', 'session-juno');
  expect(await listPendingBookingRequests()).toHaveLength(2);
});

it('keeps an unanswered request already reported to main until its mailbox cleanup', async () => {
  const db = await releasedDatabase();
  await seedChat(db);
  await oldRequest(db, 'reported-venue', 'change', 1, '{"booking":"event-mira","message":"Changed"}', 1, 0);

  await migrate(db);

  expect(await listPendingBookingRequests()).toMatchObject([
    {
      requestId: 'reported-venue',
      applied: true,
      resultJson: '{"booking":"event-mira","message":"Changed"}',
      reported: true,
      carriedOver: true,
    },
  ]);
});

it('migrates a fresh database through the full chain and safely skips a repeated run', async () => {
  const db = await releasedDatabase();
  await migrate(db);
  await migrate(db);

  expect(await db.all('SELECT * FROM gws_ea_bookings')).toEqual([]);
  expect(await listPendingBookingRequests()).toEqual([]);
  await expectOldTablesGone(db);
  expect(await db.get('SELECT name FROM schema_version WHERE name=?', 'module:gws-ea-meetings:bookings')).toEqual({
    name: 'module:gws-ea-meetings:bookings',
  });
});
