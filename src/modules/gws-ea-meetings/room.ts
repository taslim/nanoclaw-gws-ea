/**
 * Making room (KTD12; R14, R23): when nothing in its window is open for
 * someone in the inner circle or close, the host lists the meetings that
 * could move for them, from the meeting store and the calendar as it is now.
 *
 * - A candidate is a booked meeting the assistant arranged: its event
 *   carries the assistant's own booking tags, which nobody else can set, and
 *   the principal organizes it, so the principal did not create it and no one
 *   else organizes it.
 * - Everyone on it, as the event lists them now, matters less to the
 *   principal than the meeting that needs room: a meeting with anyone at the
 *   same or a higher level never moves.
 * - It sits in the window, and moving it frees a time that fits: the best
 *   such time is reserved for the meeting that needs room.
 *
 * `main` picks one and sends `reschedule` with `making_room_for`. While the
 * move is arranged, the reserved time is busy for it; once the move is
 * booked, the host holds the reserved time for the meeting that needed it
 * and tells its conversation, which offers it (`handOver`). When that time
 * was taken in the meantime, `main` hears so and decides again.
 */
import { resolveGroupTimezone } from '../../container-config.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { formatLocalTime } from '../../timezone.js';
import type { MeetingsCalendarApi } from './calendar-api.js';
import { slotLabel, TAG_MEETING, TAG_ROLE, type EventRef } from './calendar-actions.js';
import {
  findBookedMeetingForEvent,
  getBooking,
  getMeeting,
  getRoomMadeBy,
  LEVEL_ORDER,
  listOpenBookings,
  recordOfferedSlots,
  settleRoom,
  type Booking,
  type Meeting,
  type MeetingLevel,
  type Room,
} from './db.js';
import {
  addressBook,
  counterpartForAddress,
  guestsOf,
  MeetingRequestError,
  organizedByPrincipal,
  principalTimezone,
  refused,
  type AddressBook,
} from './handoff.js';
import {
  mainTimezone,
  ROOM_LOST_NOTE_TYPE,
  ROOM_NOTE_TYPE,
  who,
  writeMainNote,
  writeMeetingNote,
  type RoomCandidate,
} from './notes.js';
import { eventSpan, slotIdFor, type Span } from './slots.js';

/** At most this many candidates go to main: it weighs a few, never a calendar's worth. */
const MAX_CANDIDATES = 5;
const MINUTE = 60_000;

export interface RoomDeps {
  /** The host's own Calendar client. */
  readonly calendar: () => MeetingsCalendarApi;
  /** Open times for a meeting inside `range`, best first, as if the events in `ignore` were not there. */
  readonly openTimes: (meeting: Meeting, range: Span, ignore: readonly EventRef[]) => Promise<Span[]>;
  /** Hold offered slots for a meeting, as its own `hold` does; refused when one is no longer open. */
  readonly holdSlots: (meeting: Meeting, slotIds: readonly string[]) => Promise<unknown>;
}

function iso(instant: number): string {
  return new Date(instant).toISOString();
}

/** Whether `level` matters less to the principal than `than`. */
function mattersLess(level: MeetingLevel, than: MeetingLevel): boolean {
  return LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(than);
}

export function createRoom(deps: RoomDeps) {
  const calendar = () => deps.calendar();

  /**
   * Whether the booked meeting `moved` may move to make room for `meeting`:
   * the candidate it is, or why it may not move for it.
   */
  async function judge(
    meeting: Meeting,
    moved: Meeting,
    booking: Booking,
    book: AddressBook,
    timezone: string,
  ): Promise<RoomCandidate | string> {
    const event = await calendar().getEvent(booking.calendar_id, booking.event_id);
    if (!event || event.status === 'cancelled') return 'That event is no longer on the calendar.';
    if (event.tags?.[TAG_ROLE] !== 'booking' || event.tags[TAG_MEETING] === undefined) {
      return "That event is the principal's own, and the principal's own events never move to make room. Recommend it to the principal instead.";
    }
    if (!organizedByPrincipal(event, booking.calendar_id, book)) {
      return 'Someone else organizes that event, so it never moves to make room.';
    }
    const addresses = [...new Set([...guestsOf(event, book), ...moved.counterparts.map((c) => c.address)])];
    const people = await Promise.all(addresses.map((address) => counterpartForAddress(address)));
    const weighty = people.find((person) => !mattersLess(person.level, meeting.level));
    if (weighty) {
      return (
        `${weighty.name ?? weighty.address} matters as much to the principal as ${who(meeting)}, or more, ` +
        'so a meeting with them never moves to make room.'
      );
    }
    const span = eventSpan(event, timezone);
    const window = { start: Date.parse(meeting.window_start), end: Date.parse(meeting.window_end) };
    if (!span || span.end <= window.start || span.start >= window.end) {
      return 'That event is outside the window of the meeting that needs room, so moving it frees nothing for it.';
    }
    const length = meeting.length_minutes * MINUTE;
    const freed = (await deps.openTimes(meeting, { start: span.start - length, end: span.end + length }, [event])).find(
      (slot) => slot.start < span.end && slot.end > span.start,
    );
    if (!freed) return 'Moving that event frees no time that fits the meeting that needs room.';
    return {
      meeting_id: moved.id,
      calendar_id: booking.calendar_id,
      event_id: booking.event_id,
      start: iso(span.start),
      end: iso(span.end),
      purpose: moved.purpose,
      people: people.map(({ name, address, level }) => ({ name, address, level })),
      frees: { start: iso(freed.start), end: iso(freed.end) },
    };
  }

  /** The booked meetings that could move to make room for `meeting`, earliest first. */
  async function candidates(meeting: Meeting): Promise<RoomCandidate[]> {
    const book = await addressBook();
    const timezone = await principalTimezone();
    const window = { start: Date.parse(meeting.window_start), end: Date.parse(meeting.window_end) };
    const seen = new Set<string>();
    const found: RoomCandidate[] = [];
    for (const { meeting: moved, booking } of await listOpenBookings()) {
      if (found.length >= MAX_CANDIDATES) break;
      const event = `${booking.calendar_id}\u0000${booking.event_id}`;
      if (moved.id === meeting.id || seen.has(event)) continue;
      seen.add(event);
      if (Date.parse(booking.end_at) <= window.start || Date.parse(booking.start_at) >= window.end) continue;
      const judged = await judge(meeting, moved, booking, book, timezone);
      if (typeof judged !== 'string') found.push(judged);
    }
    return found;
  }

  /** That event as a candidate for `meeting`; refused, saying why, when it may not move for it. */
  async function candidate(meeting: Meeting, calendarId: string, eventId: string): Promise<RoomCandidate> {
    const moved = await findBookedMeetingForEvent(calendarId, eventId);
    const booking = moved ? await getBooking(moved.id) : undefined;
    if (!moved || !booking) {
      throw refused(
        "That event is not a meeting the assistant arranged: the principal's own events, and those someone else organizes, never move to make room. Recommend it to the principal instead.",
      );
    }
    const judged = await judge(meeting, moved, booking, await addressBook(), await principalTimezone());
    if (typeof judged === 'string') throw refused(judged);
    return judged;
  }

  /**
   * Once a move making room is booked, hold the time it freed for the
   * meeting that needed it, and tell that meeting's conversation. Safe to
   * repeat; a room settles once.
   */
  async function handOver(room: Room): Promise<void> {
    if (room.state !== 'reserved') return;
    const at = new Date().toISOString();
    const target = await getMeeting(room.for_meeting_id);
    if (!target || target.state !== 'active' || target.ended_at !== null || target.session_id === null) {
      // main ended that meeting meanwhile: there is no one to give the time to.
      await settleRoom(room.by_meeting_id, 'lost', at);
      return;
    }
    const span = { start: Date.parse(room.start_at), end: Date.parse(room.end_at) };
    const slot = { slot_id: slotIdFor(target.id, span), start_at: room.start_at, end_at: room.end_at };
    await recordOfferedSlots(target.id, [slot], at);
    try {
      await deps.holdSlots(target, [slot.slot_id]);
    } catch (error) {
      if (!(error instanceof MeetingRequestError)) throw error;
      log.warn('The time freed to make room could not be held', { meetingId: target.id, reason: error.message });
      if (await settleRoom(room.by_meeting_id, 'lost', at)) await tellRoomLost(target, room, at);
      return;
    }
    const session = await getSession(target.session_id);
    if (session?.status === 'active') {
      const label = slotLabel(span, await resolveGroupTimezone(session.agent_group_id));
      await writeMeetingNote(
        session,
        target,
        `meeting-room-${target.id}-${room.by_meeting_id}`,
        { type: ROOM_NOTE_TYPE, slot_id: slot.slot_id, start: slot.start_at, end: slot.end_at },
        `Note for meeting ${target.id}, from the host: room was made for it. ${slot.slot_id}, ${label}, is now held ` +
          'for this meeting. Offer it to them, and book it when they agree.',
        at,
      );
    }
    await settleRoom(room.by_meeting_id, 'given', at);
  }

  /** Hand over the room a just-booked move made, if it was making one. */
  async function handOverFrom(moved: Meeting): Promise<void> {
    const room = await getRoomMadeBy(moved.id);
    if (room) await handOver(room);
  }

  async function tellRoomLost(target: Meeting, room: Room, at: string): Promise<void> {
    const timezone = await mainTimezone();
    await writeMainNote(
      `meeting-room-lost-${target.id}-${room.by_meeting_id}`,
      { type: ROOM_LOST_NOTE_TYPE, meeting_id: target.id, moved_meeting_id: room.moved_meeting_id },
      `A meeting moved to make room for meeting ${target.id} with ${who(target)}, but the time it freed, ` +
        `${formatLocalTime(room.start_at, timezone)}, was taken before it could be held. That meeting still needs room: ` +
        'move another meeting the needs-room note listed, or tell the principal in one line with your recommendation.',
      at,
    );
  }

  return { candidates, candidate, handOver, handOverFrom };
}

export type MeetingRoom = ReturnType<typeof createRoom>;
