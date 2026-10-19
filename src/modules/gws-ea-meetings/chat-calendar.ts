import { TIMEZONE } from '../../config.js';
import {
  ANSWER_LATER,
  ActionRefusal,
  forbidden,
  invalidArgs,
  writeActionResponse,
  type ActionAnswer,
  type DeferredActionAnswer,
} from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { inChatConversation, requireServingChat } from '../gws-ea-chats/bridge.js';
import { assertChatToolFields } from '../gws-ea-chats/expect.js';
import { getChatCalendar, chatMatterIds } from '../gws-ea-chats/handoffs.js';
import { refreshChatMembership } from '../gws-ea-chats/join.js';
import { listChatMembers } from '../gws-ea-chats/roster.js';
import { isBookableCalendar, isReadable, recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { listPrincipalCalendars } from '../gws-ea-inbox/db.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';
import { placeInMatter } from '../gws-ea-matters/db.js';
import { getSchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { getGwsEaProfile, principalRecognizer } from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { allowsMeet, type EventWrite, type EventConference } from './calendar-api.js';
import {
  assertInvitationShareable,
  bothZones,
  conferenceWords,
  ensureEvent,
  eventIdFor,
  guestsOn,
  readConference,
  slotLabel,
  TAG_ROLE,
} from './calendar-actions.js';
import { addressesOf, flagOf, instantOf, lineOf, notesOf, timezoneOf } from './fields.js';
import {
  blocksTime,
  eventSpan,
  freeWindows,
  isClear,
  iso,
  READ_MARGIN_MS,
  schedulingRules,
  type Span,
} from './slots.js';
import { inSchedulingTurn, type SchedulingToolsDeps } from './tools.js';

export const TAG_CHAT = 'gwsEaChat';
const TAG_CHAT_REQUEST = 'gwsEaChatRequest';
interface BookingRequest {
  readonly session_id: string;
  readonly request_id: string;
  readonly action: 'change' | 'cancel';
  readonly fingerprint: string;
  readonly request_json: string;
  readonly messaging_group_id: string;
  readonly calendar_id: string;
  readonly event_id: string;
  readonly start_at: string;
  readonly end_at: string;
  readonly applied: number;
  readonly reported: number;
  readonly result_json: string | null;
}
interface ChatBooking {
  readonly messaging_group_id: string;
  readonly calendar_id: string;
  readonly event_id: string;
  readonly booked_at: string;
}
const MINUTE = 60_000;
const PRIVATE_ADVICE = 'Write it without that detail, or ask main with tell_main.';
function minutesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > 480)
    throw invalidArgs('minutes must be a whole number from 5 to 480.');
  return value;
}
function bookingIdOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    throw invalidArgs('booking must be the id book gave you in this chat.');
  return value;
}
async function bookingFor(chat: string, eventId: string): Promise<ChatBooking | undefined> {
  return getDb().get<ChatBooking>(
    'SELECT * FROM gws_ea_chat_bookings WHERE messaging_group_id=? AND event_id=?',
    chat,
    eventId,
  );
}

/** Native chat ownership: no email thread, thread map, or Google grant is created for the agent. */
export function createChatSchedulingTools(deps: SchedulingToolsDeps) {
  const calendar = () => deps.calendar();
  async function viewForChat(chatId: string) {
    const profile = await getGwsEaProfile();
    return {
      chatId,
      timezone: profile.principal_timezone ?? TIMEZONE,
      addresses: principalRecognizer(profile.principal_emails),
      rules: schedulingRules(await getSchedulingPreferenceValues()),
    };
  }
  async function viewOf(session: Session) {
    return viewForChat((await requireServingChat(session)).messaging_group_id);
  }
  type View = Awaited<ReturnType<typeof viewOf>>;
  async function bookingCalendar(view: View) {
    const id = await getChatCalendar(view.chatId);
    const entry = id === null ? undefined : await calendar().getCalendar(id);
    if (!entry || !isBookableCalendar(entry, view.addresses))
      throw forbidden('This chat has no calendar the assistant can book on. Ask main with tell_main.');
    return entry;
  }
  async function busyIn(view: View, span: Span, ignore: ReadonlySet<string>, writing?: string): Promise<Span[]> {
    const margin = view.rules.bufferMinutes * MINUTE + READ_MARGIN_MS;
    const ids = [...new Set([...(await listPrincipalCalendars()), ...(writing ? [writing] : [])])];
    const listings = await Promise.all(
      ids.map((id) => calendar().listEvents(id, iso(span.start - margin), iso(span.end + margin))),
    );
    return listings
      .flat()
      .flatMap((event) =>
        (event.id !== undefined && ignore.has(event.id)) || !blocksTime(event, view.addresses)
          ? []
          : (eventSpan(event, view.timezone) ?? []),
      );
  }
  async function available(view: View, calendarId: string, span: Span, eventId: string) {
    if (span.start <= Date.now()) throw forbidden('That time has passed. Call free_time for another time.');
    if (!isClear(span, await busyIn(view, span, new Set([eventId]), calendarId)))
      throw forbidden('That time is no longer free. Call free_time for another time.');
  }
  async function inviteesOf(value: unknown, view: View): Promise<string[]> {
    const known = (await listChatMembers(view.chatId)).flatMap((member) =>
      member.email === null ? [] : [member.email],
    );
    const named = addressesOf(value, 'invitees', 20);
    if (named?.some((address) => !known.includes(address)))
      throw forbidden('Invite only current members of this chat with known email addresses.');
    const assistant = await assistantAddresses();
    const invitees = [...new Set(named ?? known)].filter(
      (address) => !view.addresses.has(address) && !assistant.has(address),
    );
    if (invitees.length === 0)
      throw invalidArgs(
        'No current chat member has an email address to invite. Ask main or the members for their addresses.',
      );
    return invitees;
  }
  function bound(
    answer: DeferredActionAnswer,
    fields: readonly string[],
    writing = false,
    roster = false,
  ): DeferredActionAnswer {
    return async (content, session, requestId) => {
      assertChatToolFields(content, fields);
      const chat = await requireServingChat(session);
      if (roster) await refreshChatMembership(chat.messaging_group_id);
      return inChatConversation(chat.messaging_group_id, async () => {
        await requireServingChat(session);
        const run = () => answer(content, session, requestId);
        return writing ? inSchedulingTurn(run) : run();
      });
    };
  }
  async function tellMain(
    view: View,
    booking: Pick<ChatBooking, 'calendar_id' | 'event_id'>,
    kind: 'booked' | 'changed' | 'cancelled',
    span: Span,
    requestId: string,
    title?: string,
  ) {
    /* eslint-disable no-catch-all/no-catch-all -- the calendar change stands; reporting failure must not retry the write */
    try {
      const matters = await chatMatterIds(view.chatId);
      if (kind === 'booked' && matters.length === 1)
        await placeInMatter(matters[0], [{ kind: 'event', reference: `${booking.calendar_id}/${booking.event_id}` }]);
      const result = await writeNoteForMain({
        id: `chat-booking-${booking.event_id}-${kind}-${requestId}`,
        timestamp: new Date().toISOString(),
        wake: true,
        text: `Chat ${view.chatId} ${kind} booking ${booking.event_id} on calendar ${booking.calendar_id}: ${slotLabel(span, view.timezone)}.${title === undefined ? '' : `\n${untrustedLine(title, 120)}`}`,
        matters,
        pieces: [{ kind: 'event', reference: `${booking.calendar_id}/${booking.event_id}` }],
      });
      return result === 'written' || result === 'already-written';
    } catch (error) {
      log.error('Main was not told of a chat booking change', { chatId: view.chatId, kind, error });
      return false;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  async function withdrawFailedBooking(calendarId: string, eventId: string, chatId: string): Promise<void> {
    /* eslint-disable no-catch-all/no-catch-all -- the booking already failed; withdrawing its partial write is best effort and logged */
    try {
      const event = await calendar().getEvent(calendarId, eventId);
      if (
        event &&
        event.status !== 'cancelled' &&
        event.tags?.[TAG_CHAT] === chatId &&
        event.tags[TAG_ROLE] === 'booking'
      ) {
        await calendar().deleteEvent(calendarId, eventId, 'all');
        recordOwnCalendarChange(calendarId, eventId);
      }
    } catch (error) {
      log.error('A failed chat booking could not be withdrawn', { calendarId, eventId, chatId, error });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  const freeTime: ActionAnswer = async (content, session) => {
    const view = await viewOf(session);
    const from = instantOf(content.from, 'from');
    const to = instantOf(content.to, 'to');
    const minutes = minutesOf(content.minutes);
    const theirs = timezoneOf(content.timezone);
    if (to <= from || to <= Date.now() || to - from > 60 * 86_400_000)
      throw invalidArgs('Give a future range of at most 60 days, with to after from.');
    const window = { start: Math.max(from, Date.now()), end: to };
    const found = freeWindows({
      timezone: view.timezone,
      counterpartTimezone: theirs,
      lengthMinutes: minutes,
      window,
      busy: await busyIn(view, window, new Set()),
      rules: view.rules,
    });
    const windows = found.slice(0, 24).map((span) => ({
      start: iso(span.start),
      end: iso(span.end),
      principal_time: slotLabel(span, view.timezone),
      ...(theirs === undefined ? {} : { their_time: slotLabel(span, theirs) }),
      fit: span.fit,
    }));
    return {
      windows,
      windows_not_listed: found.length - windows.length,
      advice: windows.length
        ? 'Any start that ends within one of these windows is free.'
        : 'No free time in this range; ask for another range.',
    };
  };
  const book: ActionAnswer = async (content, session, requestId) => {
    const view = await viewOf(session);
    const entry = await bookingCalendar(view);
    const start = instantOf(content.start, 'start');
    const span = { start, end: start + minutesOf(content.minutes) * MINUTE };
    const title = lineOf(content.title, 'title', 120);
    if (!title) throw invalidArgs('title is required.');
    const notes = notesOf(content.notes, 2_000);
    const location = lineOf(content.location, 'location', 500);
    const video = flagOf(content.video_call, 'video_call');
    const theirs = timezoneOf(content.timezone);
    const invitees = await inviteesOf(content.invitees, view);
    const eventId = eventIdFor('chat-booking', view.chatId, requestId);
    let booking = await bookingFor(view.chatId, eventId);
    if (!booking) {
      await available(view, entry.id, span, eventId);
      await assertInvitationShareable(
        {
          texts: [title, notes, location],
          shown: [entry.summary],
          recipients: invitees,
          writer: 'external-chat',
          chatId: view.chatId,
        },
        'The booking was not made',
        PRIVATE_ADVICE,
      );
      if (video && !allowsMeet(entry))
        throw forbidden('This calendar does not allow Google Meet links. Give a location instead.');
      try {
        await ensureEvent(
          calendar(),
          entry.id,
          eventId,
          {
            summary: title,
            ...(notes === undefined ? {} : { description: notes }),
            ...(location === undefined ? {} : { location }),
            ...(video ? { conference: { requestId: eventIdFor('meet', eventId) } } : {}),
            start: iso(span.start),
            end: iso(span.end),
            timeZone: view.timezone,
            attendees: guestsOn(entry.id, invitees),
            reminders: 'default',
            tags: { [TAG_ROLE]: 'booking', [TAG_CHAT]: view.chatId },
          },
          'all',
          { key: TAG_CHAT, value: view.chatId },
        );
        booking = {
          messaging_group_id: view.chatId,
          calendar_id: entry.id,
          event_id: eventId,
          booked_at: new Date().toISOString(),
        };
        await getDb().run(
          'INSERT INTO gws_ea_chat_bookings(messaging_group_id,calendar_id,event_id,booked_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
          view.chatId,
          entry.id,
          eventId,
          booking.booked_at,
        );
      } catch (error) {
        await withdrawFailedBooking(entry.id, eventId, view.chatId);
        throw error;
      }
    }
    const conference = video ? await readConference(calendar(), booking.calendar_id, eventId) : undefined;
    await tellMain(view, booking, 'booked', span, requestId, title);
    return {
      booking: eventId,
      start: iso(span.start),
      end: iso(span.end),
      message: `Booked: ${bothZones(span, view.timezone, theirs)}${conferenceWords(conference)}. Google sends the invitation; main hears. To change or cancel it, give booking ${eventId}.`,
    };
  };
  async function ownBooking(content: Record<string, unknown>, view: View) {
    const eventId = bookingIdOf(content.booking);
    const booking = await bookingFor(view.chatId, eventId);
    if (!booking) throw forbidden('This chat has no such booking. Use the id book gave you here.');
    const event = await calendar().getEvent(booking.calendar_id, eventId);
    if (!event) {
      const entry = await calendar().getCalendar(booking.calendar_id);
      if (!entry || !isReadable(entry))
        throw forbidden('The booking calendar is no longer readable. Ask main with tell_main.');
    }
    if (!event || event.status === 'cancelled') {
      await getDb().run(
        'DELETE FROM gws_ea_chat_bookings WHERE calendar_id=? AND event_id=?',
        booking.calendar_id,
        eventId,
      );
      throw forbidden('That booking is no longer on the calendar.');
    }
    if (event.tags?.[TAG_CHAT] !== view.chatId || event.tags[TAG_ROLE] !== 'booking')
      throw forbidden('That event no longer belongs to this chat. Ask main with tell_main.');
    const span = eventSpan(event, view.timezone);
    if (!span) throw forbidden('The booking has no readable time. Ask main with tell_main.');
    const invitees = (event.attendees ?? []).flatMap((guest) =>
      guest.resource || guest.organizer || !guest.email ? [] : [guest.email],
    );
    return { booking, event, span, invitees };
  }
  async function savedMutation(
    session: Session,
    requestId: string,
    action: BookingRequest['action'],
    content: Record<string, unknown>,
  ) {
    const row = await getDb().get<BookingRequest>(
      'SELECT * FROM gws_ea_chat_booking_requests WHERE session_id=? AND request_id=?',
      session.id,
      requestId,
    );
    if (row && (row.action !== action || row.fingerprint !== eventIdFor(JSON.stringify(content))))
      throw forbidden('This booking request ID was already used for different work.');
    return row;
  }
  function savedResult(row: BookingRequest | undefined, reported = true): Record<string, unknown> | undefined {
    if (!row?.result_json || (reported && row.reported !== 1)) return undefined;
    const result: unknown = JSON.parse(row.result_json);
    if (!isRecord(result)) throw new Error('The saved booking result is unreadable.');
    return result;
  }
  async function recordMutation(
    session: Session,
    requestId: string,
    action: BookingRequest['action'],
    content: Record<string, unknown>,
    booking: ChatBooking,
    span: Span,
  ): Promise<BookingRequest> {
    await getDb().run(
      'INSERT INTO gws_ea_chat_booking_requests(session_id,request_id,action,fingerprint,request_json,messaging_group_id,calendar_id,event_id,start_at,end_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      session.id,
      requestId,
      action,
      eventIdFor(JSON.stringify(content)),
      JSON.stringify(content),
      booking.messaging_group_id,
      booking.calendar_id,
      booking.event_id,
      iso(span.start),
      iso(span.end),
      new Date().toISOString(),
    );
    const row = await savedMutation(session, requestId, action, content);
    if (!row) throw new Error('The booking request was not recorded.');
    return row;
  }
  async function refuseRejectedMutation(row: BookingRequest, error: unknown): Promise<void> {
    if (error instanceof GoogleApiError && !error.retryable) {
      await getDb().run(
        'DELETE FROM gws_ea_chat_booking_requests WHERE session_id=? AND request_id=?',
        row.session_id,
        row.request_id,
      );
      throw forbidden(`Google refused this booking request: ${error.message}`);
    }
  }
  async function completeMutation(
    row: BookingRequest,
    view: View,
    result: Record<string, unknown>,
    title?: string,
  ): Promise<Record<string, unknown> | typeof ANSWER_LATER> {
    const span = { start: Date.parse(row.start_at), end: Date.parse(row.end_at) };
    const booking = { calendar_id: row.calendar_id, event_id: row.event_id };
    recordOwnCalendarChange(row.calendar_id, row.event_id);
    await getDb().run(
      'UPDATE gws_ea_chat_booking_requests SET applied=1,result_json=? WHERE session_id=? AND request_id=?',
      JSON.stringify(result),
      row.session_id,
      row.request_id,
    );
    if (
      !(await tellMain(view, booking, row.action === 'change' ? 'changed' : 'cancelled', span, row.request_id, title))
    )
      return ANSWER_LATER;
    await getDb().transaction(async () => {
      await getDb().run(
        'UPDATE gws_ea_chat_booking_requests SET reported=1 WHERE session_id=? AND request_id=?',
        row.session_id,
        row.request_id,
      );
      if (row.action === 'cancel')
        await getDb().run(
          'DELETE FROM gws_ea_chat_bookings WHERE calendar_id=? AND event_id=?',
          row.calendar_id,
          row.event_id,
        );
    });
    return result;
  }
  function changedAnswer(
    eventId: string,
    span: Span,
    view: View,
    theirs: string | undefined,
    conference: EventConference | undefined,
  ): Record<string, unknown> {
    return {
      booking: eventId,
      start: iso(span.start),
      end: iso(span.end),
      message: `The booking stands at ${bothZones(span, view.timezone, theirs)}${conferenceWords(conference)}. Google sends any update; main hears.`,
    };
  }
  const changeBooking: DeferredActionAnswer = async (content, session, requestId) => {
    const view = await viewOf(session);
    let saved = await savedMutation(session, requestId, 'change', content);
    const cached = savedResult(saved);
    if (cached) return cached;
    const applied = savedResult(saved, false);
    if (saved?.applied === 1 && applied)
      return completeMutation(saved, view, applied, lineOf(content.title, 'title', 120));
    let current;
    try {
      current = await ownBooking(content, view);
    } catch (error) {
      if (saved && !(error instanceof ActionRefusal)) return ANSWER_LATER;
      throw error;
    }
    const { booking, event, span: was, invitees } = current;
    const mark = eventIdFor('chat-booking-change', session.id, requestId);
    if (saved && event.tags?.[TAG_CHAT_REQUEST] === mark) {
      const appliedSpan = { start: Date.parse(saved.start_at), end: Date.parse(saved.end_at) };
      return completeMutation(
        saved,
        view,
        changedAnswer(booking.event_id, appliedSpan, view, timezoneOf(content.timezone), event.conference),
        lineOf(content.title, 'title', 120),
      );
    }
    await inviteesOf(invitees, view);
    const start = content.start === undefined ? was.start : instantOf(content.start, 'start');
    const minutes = content.minutes === undefined ? (was.end - was.start) / MINUTE : minutesOf(content.minutes);
    const span = saved
      ? { start: Date.parse(saved.start_at), end: Date.parse(saved.end_at) }
      : { start, end: start + minutes * MINUTE };
    const retimed = span.start !== was.start || span.end !== was.end;
    const title = lineOf(content.title, 'title', 120);
    const notes = notesOf(content.notes, 2_000);
    const location = lineOf(content.location, 'location', 500);
    const video = flagOf(content.video_call, 'video_call');
    const theirs = timezoneOf(content.timezone);
    if ([content.start, content.minutes, title, notes, location].every((value) => value === undefined) && !video)
      throw invalidArgs('Give at least one change.');
    if (retimed) await available(view, booking.calendar_id, span, booking.event_id);
    const linking = video && (!event.conference || event.conference.status === 'failure');
    const entry = await calendar().getCalendar(booking.calendar_id);
    await assertInvitationShareable(
      {
        texts: [title, notes, location],
        shown: [entry?.summary],
        recipients: invitees,
        writer: 'external-chat',
        chatId: view.chatId,
      },
      'The booking was not changed',
      PRIVATE_ADVICE,
    );
    if (linking && (!entry || !allowsMeet(entry)))
      throw forbidden('This calendar does not allow Google Meet links. Give a location instead.');
    const fields: EventWrite = {
      ...(title === undefined ? {} : { summary: title }),
      ...(notes === undefined ? {} : { description: notes }),
      ...(location === undefined ? {} : { location }),
      ...(retimed ? { start: iso(span.start), end: iso(span.end) } : {}),
      ...(linking ? { conference: { requestId: eventIdFor('meet', booking.event_id, requestId) } } : {}),
    };
    if (!saved && Object.keys(fields).length === 0)
      return {
        booking: booking.event_id,
        start: iso(span.start),
        end: iso(span.end),
        message: `The booking already stands at ${bothZones(span, view.timezone, theirs)}: nothing changed.`,
      };
    saved ??= await recordMutation(session, requestId, 'change', content, booking, span);
    if (saved.applied !== 1 && event.tags?.[TAG_CHAT_REQUEST] !== mark) {
      try {
        await calendar().patchEvent(
          booking.calendar_id,
          booking.event_id,
          { ...fields, tags: { ...event.tags, [TAG_CHAT_REQUEST]: mark } },
          'all',
        );
        /* eslint-disable no-catch-all/no-catch-all -- a failed write is uncertain until its own Google mark is read */
      } catch (error) {
        await refuseRejectedMutation(saved, error);
        // The request may already stand in Google. Only its private request mark confirms it.
        try {
          const observed = await calendar().getEvent(booking.calendar_id, booking.event_id);
          if (observed?.status === 'cancelled' || observed?.tags?.[TAG_CHAT_REQUEST] !== mark) return ANSWER_LATER;
        } catch (readError) {
          log.warn('Chat booking change awaits Google confirmation', { requestId, error, readError });
          return ANSWER_LATER;
        }
      }
    }
    /* eslint-enable no-catch-all/no-catch-all */
    const conference = linking
      ? await readConference(calendar(), booking.calendar_id, booking.event_id)
      : event.conference;
    return completeMutation(saved, view, changedAnswer(booking.event_id, span, view, theirs, conference), title);
  };
  const cancelBooking: DeferredActionAnswer = async (content, session, requestId) => {
    const theirs = timezoneOf(content.timezone);
    const view = await viewOf(session);
    let saved = await savedMutation(session, requestId, 'cancel', content);
    const cached = savedResult(saved);
    if (cached) return cached;
    const applied = savedResult(saved, false);
    if (saved?.applied === 1 && applied) return completeMutation(saved, view, applied);
    if (!saved) {
      const { booking, span } = await ownBooking(content, view);
      saved = await recordMutation(session, requestId, 'cancel', content, booking, span);
    }
    if (!(await bookingFor(view.chatId, saved.event_id))) throw forbidden('This chat has no such booking.');
    /* eslint-disable no-catch-all/no-catch-all -- Google failures leave the durable cancellation unanswered for a later read-back */
    try {
      const event = await calendar().getEvent(saved.calendar_id, saved.event_id);
      const entry = await calendar().getCalendar(saved.calendar_id);
      if (!entry || !isReadable(entry))
        throw forbidden('The booking calendar is no longer readable. Ask main with tell_main.');
      if (event && event.status !== 'cancelled') {
        if (event.tags?.[TAG_CHAT] !== view.chatId || event.tags[TAG_ROLE] !== 'booking')
          throw forbidden('That event no longer belongs to this chat. Ask main with tell_main.');
        try {
          await calendar().deleteEvent(saved.calendar_id, saved.event_id, 'all');
        } catch (error) {
          await refuseRejectedMutation(saved, error);
          try {
            const observed = await calendar().getEvent(saved.calendar_id, saved.event_id);
            if (observed && observed.status !== 'cancelled') return ANSWER_LATER;
            if (!observed) {
              const readable = await calendar().getCalendar(saved.calendar_id);
              if (!readable || !isReadable(readable)) return ANSWER_LATER;
            }
          } catch (readError) {
            log.warn('Chat booking cancellation awaits Google confirmation', { requestId, error, readError });
            return ANSWER_LATER;
          }
        }
      }
    } catch (error) {
      if (error instanceof ActionRefusal) throw error;
      log.warn('Chat booking cancellation awaits Google confirmation', { requestId, error });
      return ANSWER_LATER;
    }
    /* eslint-enable no-catch-all/no-catch-all */
    const span = { start: Date.parse(saved.start_at), end: Date.parse(saved.end_at) };
    return completeMutation(saved, view, {
      booking: saved.event_id,
      message: `Cancelled: ${bothZones(span, view.timezone, theirs)}. Google sends the cancellation; main hears.`,
    });
  };
  async function reportUnconfirmed(row: BookingRequest): Promise<boolean> {
    const result = await writeNoteForMain({
      id: `chat-booking-unconfirmed-${row.session_id}-${row.request_id}`,
      timestamp: new Date().toISOString(),
      wake: true,
      text: `Chat ${row.messaging_group_id} can no longer continue request ${row.request_id} to ${row.action} booking ${row.event_id} on calendar ${row.calendar_id}. It may already have changed in Google. Check it before acting again.`,
      pieces: [{ kind: 'event', reference: `${row.calendar_id}/${row.event_id}` }],
    });
    return result === 'written' || result === 'already-written';
  }
  function mutationAnswer(answer: DeferredActionAnswer): DeferredActionAnswer {
    return async (content, session, requestId) => {
      try {
        return await answer(content, session, requestId);
      } catch (error) {
        if (error instanceof ActionRefusal) {
          const row = await getDb().get<BookingRequest>(
            'SELECT * FROM gws_ea_chat_booking_requests WHERE session_id=? AND request_id=? AND applied=0',
            session.id,
            requestId,
          );
          if (row && (await reportUnconfirmed(row)))
            await getDb().run(
              'UPDATE gws_ea_chat_booking_requests SET answered=1 WHERE session_id=? AND request_id=?',
              session.id,
              requestId,
            );
        }
        throw error;
      }
    };
  }
  const change = bound(
    mutationAnswer(changeBooking),
    ['booking', 'start', 'minutes', 'title', 'notes', 'location', 'video_call', 'timezone'],
    true,
    true,
  );
  const cancel = bound(mutationAnswer(cancelBooking), ['booking', 'timezone'], true);
  return {
    async resumePending(): Promise<void> {
      if (!(await getDb().hasTable('gws_ea_chat_booking_requests'))) return;
      for (const row of await getDb().all<BookingRequest>(
        'SELECT * FROM gws_ea_chat_booking_requests WHERE answered=0 ORDER BY created_at,session_id,request_id',
      )) {
        const session = await getSession(row.session_id);
        if (!session) continue;
        const answered = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
          mailbox.hasMessage(`action-resp-${row.request_id}`),
        );
        if (answered) {
          if (row.reported !== 1) {
            const applied = savedResult(row, false);
            const settled =
              row.applied === 1 && applied
                ? await completeMutation(row, await viewForChat(row.messaging_group_id), applied)
                : await reportUnconfirmed(row);
            if (settled === ANSWER_LATER || settled === false) continue;
          }
          await getDb().run(
            'UPDATE gws_ea_chat_booking_requests SET answered=1 WHERE session_id=? AND request_id=?',
            row.session_id,
            row.request_id,
          );
          continue;
        }
        let serves = session.status === 'active' && (await getChatCalendar(row.messaging_group_id)) !== null;
        if (serves) {
          try {
            await requireServingChat(session);
          } catch (error) {
            if (error instanceof ActionRefusal) serves = false;
            else throw error;
          }
        }
        if (!serves) {
          const applied = savedResult(row, false);
          const result =
            row.applied === 1 && applied
              ? await completeMutation(row, await viewForChat(row.messaging_group_id), applied)
              : await reportUnconfirmed(row);
          if (result !== ANSWER_LATER && result !== false)
            await getDb().run(
              'UPDATE gws_ea_chat_booking_requests SET answered=1 WHERE session_id=? AND request_id=?',
              row.session_id,
              row.request_id,
            );
          continue;
        }
        const content: unknown = JSON.parse(row.request_json);
        if (!isRecord(content)) throw new Error('The saved booking request is unreadable.');
        try {
          const result = await (row.action === 'change' ? change : cancel)(content, session, row.request_id);
          if (result !== ANSWER_LATER) {
            await writeActionResponse(session, row.request_id, { id: row.request_id, ok: true, data: result });
            await getDb().run(
              'UPDATE gws_ea_chat_booking_requests SET answered=1 WHERE session_id=? AND request_id=?',
              row.session_id,
              row.request_id,
            );
          }
          // A failed resume keeps its durable request for the next lifecycle pass.
          // eslint-disable-next-line no-catch-all/no-catch-all
        } catch (error) {
          log.warn('Chat booking request could not resume', { requestId: row.request_id, error });
        }
      }
    },
    freeTime: bound(freeTime, ['from', 'to', 'minutes', 'timezone']),
    book: bound(
      book,
      ['start', 'minutes', 'title', 'notes', 'location', 'video_call', 'invitees', 'timezone'],
      true,
      true,
    ),
    changeBooking: change,
    cancelBooking: cancel,
  };
}
