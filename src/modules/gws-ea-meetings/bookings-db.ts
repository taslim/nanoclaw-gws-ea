import { getDb } from '../../db/connection.js';

export interface BookingOwner {
  readonly kind: 'thread' | 'chat';
  readonly key: string;
}

export interface Booking {
  readonly owner: BookingOwner;
  readonly calendarId: string;
  readonly eventId: string;
  readonly bookedAt: string;
}

export interface BookingRequest {
  readonly state: 'write';
  readonly sessionId: string;
  readonly requestId: string;
  readonly action: 'book' | 'change' | 'cancel';
  readonly fingerprint: string;
  readonly requestJson: string;
  readonly owner: BookingOwner;
  readonly calendarId: string;
  readonly eventId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly eventEtag: string | null;
  readonly requestMark: string | null;
  readonly carriedOver: boolean;
  readonly applied: boolean;
  readonly resultJson: string | null;
  readonly reported: boolean;
  readonly createdAt: string;
}

export type NewBookingRequest = Omit<BookingRequest, 'state' | 'carriedOver' | 'applied' | 'resultJson' | 'reported'>;

export interface BookingAnswerRequest extends Pick<
  BookingRequest,
  'sessionId' | 'requestId' | 'action' | 'fingerprint' | 'requestJson' | 'owner' | 'createdAt'
> {
  readonly state: 'answer';
  readonly applied: true;
  readonly reported: true;
  readonly answerJson: string;
}

export type PendingBookingRequest = BookingRequest | BookingAnswerRequest;
export type NewBookingAnswer = Omit<BookingAnswerRequest, 'state' | 'applied' | 'reported'>;

interface OwnerRow {
  owner_kind: BookingOwner['kind'];
  owner_key: string;
}

interface BookingRow extends OwnerRow {
  calendar_id: string;
  event_id: string;
  booked_at: string;
}

interface BookingRequestRow extends OwnerRow {
  session_id: string;
  request_id: string;
  action: BookingRequest['action'];
  fingerprint: string;
  request_json: string;
  calendar_id: string | null;
  event_id: string | null;
  start_at: string | null;
  end_at: string | null;
  event_etag: string | null;
  request_mark: string | null;
  carried_over: number;
  applied: number;
  result_json: string | null;
  reported: number;
  created_at: string;
}

function ownerOf(row: OwnerRow): BookingOwner {
  return { kind: row.owner_kind, key: row.owner_key };
}

function requestOf(row: BookingRequestRow): PendingBookingRequest {
  if (row.calendar_id === null) {
    if (row.result_json === null) throw new Error('A terminal booking answer has no saved response.');
    return {
      state: 'answer',
      sessionId: row.session_id,
      requestId: row.request_id,
      action: row.action,
      fingerprint: row.fingerprint,
      requestJson: row.request_json,
      owner: ownerOf(row),
      createdAt: row.created_at,
      applied: true,
      reported: true,
      answerJson: row.result_json,
    };
  }
  if (row.event_id === null || row.start_at === null || row.end_at === null)
    throw new Error('The saved booking intent is incomplete.');
  return {
    state: 'write',
    sessionId: row.session_id,
    requestId: row.request_id,
    action: row.action,
    fingerprint: row.fingerprint,
    requestJson: row.request_json,
    owner: ownerOf(row),
    calendarId: row.calendar_id,
    eventId: row.event_id,
    startAt: row.start_at,
    endAt: row.end_at,
    eventEtag: row.event_etag,
    requestMark: row.request_mark,
    carriedOver: row.carried_over === 1,
    applied: row.applied === 1,
    resultJson: row.result_json,
    reported: row.reported === 1,
    createdAt: row.created_at,
  };
}

export async function recordBooking(booking: Booking): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_bookings(owner_kind,owner_key,calendar_id,event_id,booked_at) VALUES(?,?,?,?,?)
       ON CONFLICT(calendar_id,event_id) DO NOTHING`,
    booking.owner.kind,
    booking.owner.key,
    booking.calendarId,
    booking.eventId,
    booking.bookedAt,
  );
}

export async function getBooking(owner: BookingOwner, eventId: string): Promise<Booking | undefined> {
  const row = await getDb().get<BookingRow>(
    'SELECT * FROM gws_ea_bookings WHERE owner_kind=? AND owner_key=? AND event_id=?',
    owner.kind,
    owner.key,
    eventId,
  );
  return row
    ? { owner: ownerOf(row), calendarId: row.calendar_id, eventId: row.event_id, bookedAt: row.booked_at }
    : undefined;
}

export async function bookingOwner(calendarId: string, eventId: string): Promise<BookingOwner | undefined> {
  const row = await getDb().get<OwnerRow>(
    'SELECT owner_kind,owner_key FROM gws_ea_bookings WHERE lower(calendar_id)=? AND event_id=?',
    calendarId.toLowerCase(),
    eventId,
  );
  return row ? ownerOf(row) : undefined;
}

export async function deleteBooking(calendarId: string, eventId: string): Promise<void> {
  await getDb().run('DELETE FROM gws_ea_bookings WHERE calendar_id=? AND event_id=?', calendarId, eventId);
}

export async function getBookingRequest(
  sessionId: string,
  requestId: string,
): Promise<PendingBookingRequest | undefined> {
  const row = await getDb().get<BookingRequestRow>(
    'SELECT * FROM gws_ea_booking_requests WHERE session_id=? AND request_id=?',
    sessionId,
    requestId,
  );
  return row ? requestOf(row) : undefined;
}

export async function recordBookingRequest(request: NewBookingRequest): Promise<BookingRequest> {
  const db = getDb();
  return db.transaction(async () => {
    await db.run(
      `INSERT INTO gws_ea_booking_requests(
         session_id,request_id,action,fingerprint,request_json,owner_kind,owner_key,calendar_id,event_id,
         start_at,end_at,event_etag,request_mark,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,request_id) DO NOTHING`,
      request.sessionId,
      request.requestId,
      request.action,
      request.fingerprint,
      request.requestJson,
      request.owner.kind,
      request.owner.key,
      request.calendarId,
      request.eventId,
      request.startAt,
      request.endAt,
      request.eventEtag,
      request.requestMark,
      request.createdAt,
    );
    const saved = await getBookingRequest(request.sessionId, request.requestId);
    if (!saved) throw new Error('The booking request was not recorded.');
    if (saved.fingerprint !== request.fingerprint)
      throw new Error('This booking request ID was already used for different work.');
    if (saved.state !== 'write') throw new Error('This request already has a terminal answer.');
    return saved;
  });
}

export async function recordBookingAnswer(request: NewBookingAnswer): Promise<PendingBookingRequest> {
  const db = getDb();
  return db.transaction(async () => {
    await db.run(
      `INSERT INTO gws_ea_booking_requests(
        session_id,request_id,action,fingerprint,request_json,owner_kind,owner_key,created_at,
        applied,reported,result_json
      ) VALUES(?,?,?,?,?,?,?,?,1,1,?) ON CONFLICT(session_id,request_id) DO NOTHING`,
      request.sessionId,
      request.requestId,
      request.action,
      request.fingerprint,
      request.requestJson,
      request.owner.kind,
      request.owner.key,
      request.createdAt,
      request.answerJson,
    );
    const saved = await getBookingRequest(request.sessionId, request.requestId);
    if (!saved) throw new Error('The terminal booking answer was not recorded.');
    if (
      saved.fingerprint !== request.fingerprint ||
      saved.action !== request.action ||
      saved.owner.kind !== request.owner.kind ||
      saved.owner.key !== request.owner.key
    )
      throw new Error('This booking request ID was already used for different work.');
    return saved;
  });
}

export async function markBookingRequestApplied(
  sessionId: string,
  requestId: string,
  resultJson: string,
): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_booking_requests SET applied=1,result_json=? WHERE session_id=? AND request_id=? AND applied=0',
    resultJson,
    sessionId,
    requestId,
  );
}

export async function markBookingRequestReported(sessionId: string, requestId: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_booking_requests SET reported=1 WHERE session_id=? AND request_id=?',
    sessionId,
    requestId,
  );
}

export async function listPendingBookingRequests(): Promise<PendingBookingRequest[]> {
  const rows = await getDb().all<BookingRequestRow>(
    'SELECT * FROM gws_ea_booking_requests ORDER BY created_at,session_id,request_id',
  );
  return rows.map(requestOf);
}

export async function hasPendingBookingRequest(owner: BookingOwner, eventId: string): Promise<boolean> {
  return (
    (await getDb().get(
      'SELECT 1 FROM gws_ea_booking_requests WHERE owner_kind=? AND owner_key=? AND event_id=? AND reported=0 LIMIT 1',
      owner.kind,
      owner.key,
      eventId,
    )) !== undefined
  );
}

export async function deleteBookingRequest(sessionId: string, requestId: string): Promise<void> {
  await getDb().run('DELETE FROM gws_ea_booking_requests WHERE session_id=? AND request_id=?', sessionId, requestId);
}
