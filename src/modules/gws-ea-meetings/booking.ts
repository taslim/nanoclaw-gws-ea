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
import { resolveGroupTimezone } from '../../container-config.js';
import { getDb } from '../../db/connection.js';
import { RetryDeliveryError } from '../../delivery-guard.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { requestWake } from '../../request-wake.js';
import { clearOutbox, withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { GOOGLE_CONNECTION_DOWN, isGoogleConnectionDown } from '../gws-ea-google/agent-boundary.js';
import type { Session } from '../../types.js';
import { assertChatToolFields } from '../gws-ea-chats/expect.js';
import { isBookableCalendar, isReadable, recordOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { listPrincipalCalendars } from '../gws-ea-inbox/db.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';
import { placeInMatter } from '../gws-ea-matters/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { getSchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import {
  getGwsEaProfile,
  getExternalChatAgentGroupId,
  getMainAgentGroupId,
  principalRecognizer,
  type PrincipalRecognizer,
} from '../gws-ea-profile/db.js';
import {
  allowsMeet,
  type CalendarEntry,
  type CalendarEvent,
  type EventConference,
  type EventWrite,
  type MeetingsCalendarApi,
  type NewEvent,
} from './calendar-api.js';
import {
  assertInvitationShareable,
  bothZones,
  conferenceWords,
  eventIdFor,
  guestsOn,
  slotLabel,
  TAG_ROLE,
} from './calendar-actions.js';
import {
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
  recordBookingAnswer,
  type BookingRequest,
  type BookingAnswerRequest,
  type PendingBookingRequest,
} from './bookings-db.js';
import { bookingSurfaceFor, resolveBookingSurface, type BookingSurfaceContext } from './booking-surface.js';
import { addressesOf, flagOf, instantOf, lineOf, notesOf, timezoneOf } from './fields.js';
import {
  blocksTime,
  eventSpan,
  freeWindows,
  isClear,
  iso,
  READ_MARGIN_MS,
  schedulingRules,
  type SchedulingRules,
  type Span,
  zonedIso,
} from './slots.js';

const MAX_WINDOWS = 24;
const MAX_RANGE_DAYS = 60;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TOOL_WAIT_MS = 120_000;

interface Principal {
  readonly timezone: string;
  readonly rules: SchedulingRules;
  readonly addresses: PrincipalRecognizer;
}
interface BookingView extends BookingSurfaceContext {
  readonly principal: Principal;
  startedAt: string;
  readonly answerExists?: boolean;
}

type BookingAnswer = (
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
  view: BookingView,
) => ReturnType<DeferredActionAnswer>;

function minutesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > 480)
    throw invalidArgs('minutes must be a whole number from 5 to 480');
  return value;
}

async function principalView(): Promise<Principal> {
  const profile = await getGwsEaProfile();
  return {
    timezone: profile.principal_timezone ?? TIMEZONE,
    rules: schedulingRules(await getSchedulingPreferenceValues()),
    addresses: principalRecognizer(profile.principal_emails),
  };
}

let schedulingTurn: Promise<unknown> = Promise.resolve();
function inSchedulingTurn<T>(work: () => Promise<T>): Promise<T> {
  const done = schedulingTurn.then(work);
  schedulingTurn = done.then(
    () => undefined,
    () => undefined,
  );
  return done;
}

export interface BookingToolsDeps {
  readonly calendar: () => MeetingsCalendarApi;
}

export function createBookingTools(deps: BookingToolsDeps) {
  const calendar = () => deps.calendar();
  const inFlight = new Map<string, number>();
  const ownChangeRequests = new Set<string>();
  const requestKey = (sessionId: string, requestId: string): string => JSON.stringify([sessionId, requestId]);

  async function answeredMessage(session: Session, requestId: string, createdAt: string) {
    return withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.getInboundRecords({ since: createdAt }).find((message) => message.id === `action-resp-${requestId}`),
    );
  }

  async function wakeLateAnswer(session: Session, requestId: string, content: string): Promise<void> {
    if ((await getSession(session.id))?.status !== 'active') return;
    const stored: unknown = JSON.parse(content);
    if (!isRecord(stored) || !isRecord(stored.frame)) throw new Error('The saved booking answer is unreadable.');
    const frame = stored.frame;
    let words: string;
    if (frame.ok === true && isRecord(frame.data) && typeof frame.data.message === 'string') words = frame.data.message;
    else if (frame.ok === false && isRecord(frame.error) && typeof frame.error.message === 'string')
      words = frame.error.message;
    else throw new Error('The saved booking answer has no readable outcome.');
    const destination = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    try {
      await writeSessionMessage(session.agent_group_id, session.id, {
        id: `gws-ea-booking-answer-${eventIdFor(session.id, requestId)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: destination?.platform_id,
        channelType: destination?.channel_type,
        threadId: session.thread_id,
        content: JSON.stringify({
          text: `Booking request ${requestId}: ${words}`,
          sender: 'system',
          senderId: 'system',
        }),
        trigger: true,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return;
    }
    await requestWake(session, 'cli');
  }

  async function deliverAnswer(
    session: Session,
    requestId: string,
    createdAt: string,
    frame: ResponseFrame,
  ): Promise<void> {
    await writeActionResponse(session, requestId, frame);
    const answer = await answeredMessage(session, requestId, createdAt);
    if (answer && Date.parse(answer.timestamp) - Date.parse(createdAt) >= TOOL_WAIT_MS)
      await wakeLateAnswer(session, requestId, answer.content);
    clearOutbox(session.agent_group_id, session.id, requestId);
  }

  async function requestStartedAt(session: Session, requestId: string): Promise<string | undefined> {
    return withExistingMailboxSession(
      session.agent_group_id,
      session.id,
      (mailbox) => mailbox.getOutboundMessage(requestId)?.timestamp,
    );
  }

  async function completeAnswer(session: Session, requestId: string): Promise<void> {
    const startedAt =
      (await requestStartedAt(session, requestId)) ?? (await getBookingRequest(session.id, requestId))?.createdAt;
    if (startedAt === undefined) return;
    const answer = await answeredMessage(session, requestId, startedAt);
    if (answer && Date.parse(answer.timestamp) - Date.parse(startedAt) >= TOOL_WAIT_MS)
      await wakeLateAnswer(session, requestId, answer.content);
  }

  function terminalFrame(row: BookingAnswerRequest): ResponseFrame {
    const stored: unknown = JSON.parse(row.answerJson);
    if (!isRecord(stored) || stored.id !== row.requestId)
      throw new Error('The saved terminal booking answer is unreadable.');
    if (stored.ok === true && isRecord(stored.data)) return { id: row.requestId, ok: true, data: stored.data };
    if (
      stored.ok === false &&
      isRecord(stored.error) &&
      (stored.error.code === 'forbidden' || stored.error.code === 'invalid-args') &&
      typeof stored.error.message === 'string'
    )
      return { id: row.requestId, ok: false, error: { code: stored.error.code, message: stored.error.message } };
    throw new Error('The saved terminal booking answer has no outcome.');
  }

  function terminalResult(row: BookingAnswerRequest): Record<string, unknown> {
    const frame = terminalFrame(row);
    if (frame.ok && isRecord(frame.data)) return frame.data;
    if (!frame.ok && (frame.error.code === 'forbidden' || frame.error.code === 'invalid-args'))
      throw new ActionRefusal(frame.error.code, frame.error.message);
    throw new Error('The saved terminal booking answer has no outcome.');
  }

  async function viewOf(session: Session, startedAt = new Date().toISOString()): Promise<BookingView> {
    return { ...(await resolveBookingSurface(session)), principal: await principalView(), startedAt };
  }

  function bound(
    action: BookingRequest['action'],
    answer: BookingAnswer,
    fields: readonly string[],
  ): DeferredActionAnswer {
    return async (content, session, requestId) => {
      const handlerStartedAt = new Date().toISOString();
      const key = requestKey(session.id, requestId);
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      try {
        const startedAt = (await requestStartedAt(session, requestId)) ?? handlerStartedAt;
        const existing = await getBookingRequest(session.id, requestId);
        if (existing?.state === 'answer') {
          if (existing.action !== action || existing.fingerprint !== eventIdFor(JSON.stringify(content)))
            throw forbidden('This booking request ID was already used for different work.');
          if (!(await bookingSurfaceFor(existing.owner).stillServing(session)))
            throw forbidden('This session no longer serves this booking’s owner.');
          if (Date.now() - Date.parse(existing.createdAt) >= TOOL_WAIT_MS)
            await deliverAnswer(session, requestId, existing.createdAt, terminalFrame(existing));
          return terminalResult(existing);
        }
        const view = await viewOf(session, startedAt);
        let preparationRefusal: ActionRefusal | undefined;
        try {
          assertChatToolFields(content, fields);
          if (!existing?.applied) await view.surface.beforeWrite();
        } catch (error) {
          if (!(error instanceof ActionRefusal)) throw error;
          preparationRefusal = error;
        }
        const frame = await view.surface.inWrite(() =>
          inSchedulingTurn(async (): Promise<ResponseFrame | typeof ANSWER_LATER> => {
            const answered = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
              mailbox.hasMessage(`action-resp-${requestId}`),
            );
            if (answered) {
              await completeAnswer(session, requestId);
              return ANSWER_LATER;
            }
            let response: ResponseFrame;
            try {
              if (preparationRefusal) throw preparationRefusal;
              if (!(await view.surface.stillServing(session)))
                throw forbidden('This session no longer serves this booking’s owner.');
              const result = await answer(content, session, requestId, view);
              if (result === ANSWER_LATER) return result;
              response = { id: requestId, ok: true, data: result };
            } catch (error) {
              if (!(error instanceof ActionRefusal)) throw error;
              response = { id: requestId, ok: false, error: { code: error.code, message: error.message } };
            }
            const saved =
              (await getBookingRequest(session.id, requestId)) ??
              (await recordBookingAnswer({
                sessionId: session.id,
                requestId,
                action,
                fingerprint: eventIdFor(JSON.stringify(content)),
                requestJson: JSON.stringify(content),
                owner: view.surface.owner,
                createdAt: view.startedAt,
                answerJson: JSON.stringify(response),
              }));
            return saved.state === 'answer' ? terminalFrame(saved) : response;
          }),
        );
        if (frame === ANSWER_LATER) return frame;
        if (Date.now() - Date.parse(view.startedAt) >= TOOL_WAIT_MS)
          await deliverAnswer(session, requestId, view.startedAt, frame);
        if (frame.ok && isRecord(frame.data)) return frame.data;
        if (!frame.ok && (frame.error.code === 'forbidden' || frame.error.code === 'invalid-args'))
          throw new ActionRefusal(frame.error.code, frame.error.message);
        throw new Error('The booking answer has no outcome.');
      } catch (error) {
        if (error instanceof ActionRefusal || error instanceof RetryDeliveryError) throw error;
        throw new RetryDeliveryError(
          'Booking preparation or answer delivery could not finish; its outbound request must retry.',
          { cause: error },
        );
      } finally {
        const remaining = (inFlight.get(key) ?? 1) - 1;
        if (remaining === 0) inFlight.delete(key);
        else inFlight.set(key, remaining);
      }
    };
  }

  /** to: external-email, external-chat, job */
  async function bookingCalendarOf(view: BookingView, offering = false): Promise<CalendarEntry> {
    const { words } = view.surface;
    const id = await view.surface.calendarId();
    if (id === null) {
      if (offering)
        throw forbidden(
          `No calendar is set for ${words.ownerLabel}'s bookings yet: wake main once with tell_main to ask which calendar to book on, and offer no time until it answers.`,
        );
      throw forbidden(
        `No calendar is set for ${words.ownerLabel}'s bookings yet, so nothing was booked: ${words.askForCalendar}, and book once it answers.`,
      );
    }
    const entry = await calendar().getCalendar(id);
    if (entry !== undefined && isBookableCalendar(entry, view.principal.addresses)) return entry;
    throw forbidden(
      `The calendar main set for ${words.ownerLabel}'s bookings is no longer one the assistant can book on, so ${offering ? 'no time was offered' : 'nothing was booked'}: ${words.askForCalendar}, and ${offering ? 'offer times' : 'book'} once it answers.`,
    );
  }

  async function busyIn(
    view: BookingView,
    span: Span,
    ignore: ReadonlySet<string>,
    bookingCalendarId: string,
  ): Promise<Span[]> {
    const { principal } = view;
    const margin = principal.rules.bufferMinutes * MINUTE + READ_MARGIN_MS;
    const ids = new Map<string, string>();
    for (const id of [...(await listPrincipalCalendars()), bookingCalendarId])
      if (!ids.has(id.toLowerCase())) ids.set(id.toLowerCase(), id);
    const listings = await Promise.all(
      [...ids.values()].map((id) => calendar().listEvents(id, iso(span.start - margin), iso(span.end + margin))),
    );
    return listings
      .flat()
      .flatMap((event) =>
        (event.id !== undefined && ignore.has(event.id)) || !blocksTime(event, principal.addresses)
          ? []
          : (eventSpan(event, principal.timezone) ?? []),
      );
  }

  /** to: external-email, external-chat, job */
  async function assertAvailable(
    view: BookingView,
    calendarId: string,
    spans: readonly Span[],
    ignore: ReadonlySet<string>,
  ): Promise<void> {
    const label = (span: Span): string => slotLabel(span, view.principal.timezone);
    const passed = spans.filter((span) => span.start <= Date.now());
    if (passed.length > 0) throw forbidden(`${passed.map(label).join('; ')}: that time has passed.`);
    const covering = {
      start: Math.min(...spans.map((span) => span.start)),
      end: Math.max(...spans.map((span) => span.end)),
    };
    const busy = await busyIn(view, covering, ignore, calendarId);
    const taken = spans.filter((span) => !isClear(span, busy));
    if (taken.length > 0)
      throw forbidden(`${taken.map(label).join('; ')}: no longer free. Call free_time for times to offer instead.`);
  }

  async function inviteesOf(value: unknown, view: BookingView): Promise<string[]> {
    const people = await view.surface.invitationPeople();
    const allowed = new Set(people.allowed.map((address) => address.toLowerCase()));
    const named = addressesOf(value, 'invitees', 20);
    const stranger = named?.find((address) => !allowed.has(address));
    if (stranger !== undefined) throw forbidden(people.outside(stranger));
    const assistant = await assistantAddresses();
    const invitees = [...new Set(named ?? people.defaults)].filter(
      (address) => !view.principal.addresses.has(address) && !assistant.has(address),
    );
    if (invitees.length === 0) throw invalidArgs(people.empty);
    return invitees;
  }

  /** to: external-email, external-chat, job */
  const freeTime: ActionAnswer = async (content, session) => {
    assertChatToolFields(content, ['from', 'to', 'minutes', 'timezone']);
    const from = instantOf(content.from, 'from');
    const to = instantOf(content.to, 'to');
    const minutes = minutesOf(content.minutes);
    const theirs = timezoneOf(content.timezone);
    if (to <= from) throw invalidArgs('to must come after from');
    if (to - from > MAX_RANGE_DAYS * DAY) throw invalidArgs(`The range may span at most ${MAX_RANGE_DAYS} days`);
    if (to <= Date.now()) throw invalidArgs('That range has already passed: ask for one in the future.');
    const view = await viewOf(session);
    const entry = await bookingCalendarOf(view, true);
    const { timezone, rules } = view.principal;
    const window = { start: Math.max(from, Date.now()), end: to };
    const busy = window.start < window.end ? await busyIn(view, window, new Set(), entry.id) : [];
    const found = freeWindows({ timezone, counterpartTimezone: theirs, lengthMinutes: minutes, window, busy, rules });
    const windows = found.slice(0, MAX_WINDOWS).map((free) => ({
      start: iso(free.start),
      end: iso(free.end),
      principal_time: slotLabel(free, timezone),
      ...(theirs === undefined ? {} : { their_time: slotLabel(free, theirs) }),
      fit: free.fit,
    }));
    const unlisted = found.length - windows.length;
    const lines = found
      .slice(0, MAX_WINDOWS)
      .map(
        (free, index) =>
          `- ${zonedIso(free.start, timezone)} to ${zonedIso(free.end, timezone)}: ${windows[index].principal_time}` +
          (theirs === undefined ? '' : `; for them, ${windows[index].their_time}`) +
          ` (${free.fit})`,
      );
    const answer =
      windows.length === 0
        ? [
            `Nothing in that range is free for ${minutes} minutes${theirs === undefined ? '' : ' and inside their waking day'}: ask for another range, or ${view.surface.words.waitForMain}.`,
          ]
        : [
            `Free for ${minutes} minutes: any start that ends by a window's end.`,
            ...lines,
            ...(unlisted > 0 ? [`${unlisted} later windows are not listed: ask from the last one on for more.`] : []),
          ];
    return { windows, windows_not_listed: unlisted, message: answer.join('\n') };
  };

  interface PreparedRequest {
    readonly content: Record<string, unknown>;
    readonly invitees: readonly string[];
    readonly previous: Span;
    readonly title?: string;
    readonly video: boolean;
    readonly fresh: readonly string[];
  }
  interface BookingOutcome {
    readonly kind: 'success' | 'removed' | 'changed' | 'unknown' | 'absent' | 'refused';
    readonly result: Record<string, unknown>;
    readonly span: Span;
    readonly conference?: EventConference;
    readonly refusal?: string;
    readonly refusalCode?: ActionRefusal['code'];
  }

  const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });
  /** to: external-email, external-chat, job */
  const privateAdvice = 'Write it without that detail, or ask main with tell_main.';
  const tagRequest = 'gwsEaRequest';
  const ownerTag = (view: BookingView): string => (view.surface.owner.kind === 'thread' ? 'gwsEaThread' : 'gwsEaChat');
  const spanOf = (row: BookingRequest): Span => ({ start: Date.parse(row.startAt), end: Date.parse(row.endAt) });

  function contentOf(row: BookingRequest): Record<string, unknown> {
    const stored: unknown = JSON.parse(row.requestJson);
    if (!isRecord(stored)) throw new Error('The saved booking request is unreadable.');
    if (row.carriedOver) return stored;
    if (!isRecord(stored.content)) throw new Error('The saved booking content is unreadable.');
    return stored.content;
  }

  function preparedOf(row: BookingRequest): PreparedRequest {
    const content = contentOf(row);
    const stored: unknown = JSON.parse(row.requestJson);
    if (row.carriedOver) return { content, invitees: [], previous: spanOf(row), video: false, fresh: [] };
    if (
      !isRecord(stored) ||
      !Array.isArray(stored.invitees) ||
      !stored.invitees.every((v: unknown) => typeof v === 'string') ||
      !isRecord(stored.previous) ||
      typeof stored.previous.start !== 'number' ||
      typeof stored.previous.end !== 'number' ||
      typeof stored.video !== 'boolean' ||
      !Array.isArray(stored.fresh) ||
      !stored.fresh.every((v: unknown) => typeof v === 'string') ||
      (stored.title !== undefined && typeof stored.title !== 'string')
    )
      throw new Error('The saved booking details are unreadable.');
    return {
      content,
      invitees: stored.invitees,
      previous: { start: stored.previous.start, end: stored.previous.end },
      video: stored.video,
      fresh: stored.fresh,
      ...(stored.title === undefined ? {} : { title: stored.title }),
    };
  }

  function outcomeOf(row: BookingRequest): BookingOutcome {
    const stored: unknown = row.resultJson === null ? undefined : JSON.parse(row.resultJson);
    if (!isRecord(stored)) throw new Error('The saved booking result is unreadable.');
    if (row.carriedOver && !isRecord(stored.result)) return { kind: 'success', result: stored, span: spanOf(row) };
    if (
      !['success', 'removed', 'changed', 'unknown', 'absent', 'refused'].includes(String(stored.kind)) ||
      !isRecord(stored.result) ||
      !isRecord(stored.span) ||
      typeof stored.span.start !== 'number' ||
      typeof stored.span.end !== 'number' ||
      (stored.refusal !== undefined && typeof stored.refusal !== 'string')
    )
      throw new Error('The saved booking outcome is unreadable.');
    const kind = stored.kind as BookingOutcome['kind'];
    const conference =
      isRecord(stored.conference) && ['success', 'pending', 'failure'].includes(String(stored.conference.status))
        ? {
            status: stored.conference.status as EventConference['status'],
            ...(typeof stored.conference.uri === 'string' ? { uri: stored.conference.uri } : {}),
          }
        : undefined;
    return {
      kind,
      result: stored.result,
      span: { start: stored.span.start, end: stored.span.end },
      ...(conference === undefined ? {} : { conference }),
      ...(stored.refusal === undefined ? {} : { refusal: stored.refusal }),
      ...(stored.refusalCode === 'forbidden' || stored.refusalCode === 'invalid-args'
        ? { refusalCode: stored.refusalCode }
        : {}),
    };
  }

  /** to: external-email, external-chat, job */
  function removedWords(view: BookingView): string {
    return `That booking is no longer on the calendar. The principal or main may have removed it. ${view.surface.words.waitForMain}; book again only once main says to.`;
  }

  /** to: external-email, external-chat, job */
  function changedOutcome(row: BookingRequest, event: CalendarEvent, view: BookingView): BookingOutcome {
    const span = eventSpan(event, view.principal.timezone) ?? spanOf(row);
    const message = `The meeting changed since it was checked. It now stands at ${slotLabel(span, view.principal.timezone)}. Ask main with tell_main before changing it again.`;
    return { kind: 'changed', span, result: { booking: row.eventId, message }, refusal: message };
  }

  /** to: external-email, external-chat, job */
  function removedOutcome(row: BookingRequest, view: BookingView): BookingOutcome {
    const message = removedWords(view);
    return { kind: 'removed', span: spanOf(row), result: { booking: row.eventId, message }, refusal: message };
  }

  /** to: external-email, external-chat, job */
  function unknownOutcome(row: BookingRequest, view: BookingView): BookingOutcome {
    const message = `This request to ${row.action} booking ${row.eventId} may or may not have gone through in Google. Main hears the same. ${view.surface.words.waitForMain} before acting on it again.`;
    return { kind: 'unknown', span: spanOf(row), result: { booking: row.eventId, message } };
  }

  /** to: external-email, external-chat, job */
  function absentOutcome(row: BookingRequest, view: BookingView): BookingOutcome {
    const message = `This booking is not on the calendar. The pending booking request was not carried out. ${view.surface.words.waitForMain} before booking again.`;
    return { kind: 'absent', span: spanOf(row), result: { booking: row.eventId, message }, refusal: message };
  }

  /** to: external-email, external-chat, job */
  function successOutcome(row: BookingRequest, view: BookingView, event?: CalendarEvent): BookingOutcome {
    const span = (event === undefined ? undefined : eventSpan(event, view.principal.timezone)) ?? spanOf(row);
    const prepared = preparedOf(row);
    const conference = event?.conference ?? (prepared.video ? { status: 'pending' as const } : undefined);
    const when = bothZones(span, view.principal.timezone, timezoneOf(prepared.content.timezone));
    const message =
      row.action === 'cancel'
        ? `Cancelled: ${when}. Google sends the cancellation; main hears.`
        : row.action === 'book'
          ? `Booked: ${when}${conferenceWords(conference)}. Google sends the invitation; main hears. To change or cancel it, give booking ${row.eventId}.`
          : `The booking stands at ${when}${conferenceWords(conference)}. Google sends any update; main hears.`;
    return {
      kind: 'success',
      span,
      ...(conference === undefined ? {} : { conference }),
      result: {
        booking: row.eventId,
        ...(row.action === 'cancel' ? {} : { start: iso(span.start), end: iso(span.end) }),
        message,
      },
    };
  }

  async function reportRequest(row: BookingRequest, view: BookingView, outcome: BookingOutcome): Promise<void> {
    const prepared = preparedOf(row);
    const main = await getMainAgentGroupId();
    const timezone = main === null ? view.principal.timezone : await resolveGroupTimezone(main);
    const when = (span: Span): string => slotLabel(span, timezone);
    const lasting = `${when(outcome.span)} (${Math.round((outcome.span.end - outcome.span.start) / MINUTE)} minutes)`;
    const withWhom = prepared.invitees.length === 0 ? '' : ` with ${list.format(prepared.invitees)}`;
    const ids = `(${row.owner.kind} ${row.owner.key}; event ${row.eventId} on calendar ${row.calendarId})`;
    const retimed = outcome.span.start !== prepared.previous.start || outcome.span.end !== prepared.previous.end;
    let text: string;
    if (outcome.kind === 'unknown')
      text = `The request to ${row.action} the meeting${withWhom} at ${lasting} may or may not have gone through in Google. Check it before acting again. ${ids}`;
    else if (outcome.kind === 'absent')
      text = `The meeting${withWhom} requested for ${lasting} is not on the calendar. The pending booking request was not carried out. ${ids}`;
    else if (outcome.kind === 'changed')
      text = `The meeting${withWhom} changed since it was checked; it now stands at ${lasting}. The pending ${row.action} was not written again. ${ids}`;
    else if (outcome.kind === 'removed')
      text = `${row.action === 'book' ? 'Booked a meeting' : 'The meeting'}${withWhom} for ${lasting}, then it was removed from the calendar. It was not restored. ${ids}`;
    else if (row.action === 'cancel')
      text = `Cancelled the meeting${withWhom} on ${when(outcome.span)}. Google sent them the cancellation. ${ids}`;
    else if (row.action === 'book')
      text = `Booked a meeting${withWhom} for ${lasting}${prepared.video ? ', by video call' : ''}. Google sent them the invitation. ${ids}`;
    else {
      const fresh = prepared.fresh.length === 0 ? '' : `, with a new ${list.format(prepared.fresh)}`;
      text =
        (retimed
          ? `Rescheduled the meeting${withWhom} to ${lasting}, from ${when(prepared.previous)}`
          : `Changed the meeting${withWhom} on ${lasting}`) +
        `${fresh}${outcome.conference === undefined ? '' : ', by video call'}. Google sent them the update. ${ids}`;
    }
    if (prepared.title !== undefined)
      text += `\nIts ${row.action === 'change' ? 'new ' : ''}title, as written in the ${row.owner.kind}, is untrusted:\n${untrustedLine(prepared.title, 120, row.owner.kind === 'chat' ? 'chat' : 'gmail')}`;
    const matters = await view.surface.openMatters();
    const others = [
      ...new Map(
        matters.flatMap((matter) => matter.conversations).map((owner) => [`${owner.kind}:${owner.key}`, owner]),
      ).values(),
    ];
    if (others.length > 0)
      text += `\nIts matter's other conversations, to brief at once: ${list.format(others.map((owner) => `${owner.kind} ${owner.key}`))}.`;
    const result = await writeNoteForMain({
      id: `gws-ea-booking-${eventIdFor(row.sessionId, row.requestId)}`,
      timestamp: new Date().toISOString(),
      wake: true,
      text,
      matters: matters.map((matter) => matter.id),
      pieces: [
        ...(row.owner.kind === 'thread' ? [{ kind: 'thread' as const, reference: row.owner.key }] : []),
        { kind: 'event', reference: `${row.calendarId}/${row.eventId}` },
      ],
    });
    if (result === 'no-main' || result === 'no-principal')
      log.warn('Nobody to tell of a booking change', { owner: row.owner, requestId: row.requestId, result });
    await markBookingRequestReported(row.sessionId, row.requestId);
  }

  async function finishRequest(
    row: BookingRequest,
    view: BookingView,
    outcome: BookingOutcome,
  ): Promise<Record<string, unknown>> {
    const key = requestKey(row.sessionId, row.requestId);
    if (
      !view.answerExists &&
      !ownChangeRequests.has(key) &&
      (outcome.kind === 'success' || (outcome.kind === 'removed' && row.action === 'book'))
    ) {
      recordOwnCalendarChange(row.calendarId, row.eventId);
      ownChangeRequests.add(key);
    }
    await getDb().transaction(async () => {
      if (!row.applied) {
        if (outcome.kind === 'success' && row.action === 'book') {
          await recordBooking({
            owner: row.owner,
            calendarId: row.calendarId,
            eventId: row.eventId,
            bookedAt: row.createdAt,
          });
          const matters = await view.surface.openMatters();
          if (matters.length === 1)
            await placeInMatter(matters[0].id, [{ kind: 'event', reference: `${row.calendarId}/${row.eventId}` }]);
        }
        await markBookingRequestApplied(row.sessionId, row.requestId, JSON.stringify(outcome));
      }
      if ((row.action === 'cancel' && outcome.kind === 'success') || outcome.kind === 'removed')
        await deleteBooking(row.calendarId, row.eventId);
    });
    if (!row.reported && outcome.kind !== 'refused') await reportRequest(row, view, outcome);
    if (outcome.refusal !== undefined) throw new ActionRefusal(outcome.refusalCode ?? 'forbidden', outcome.refusal);
    return outcome.result;
  }

  function owns(event: CalendarEvent, view: BookingView): boolean {
    return event.tags?.[TAG_ROLE] === 'booking' && event.tags[ownerTag(view)] === view.surface.owner.key;
  }

  function inviteesOn(event: CalendarEvent, view: BookingView): string[] {
    return (event.attendees ?? []).flatMap((guest) =>
      guest.resource || guest.organizer || !guest.email || view.principal.addresses.has(guest.email)
        ? []
        : [guest.email.toLowerCase()],
    );
  }

  /** to: external-email, external-chat, job */
  async function ownBooking(content: Record<string, unknown>, view: BookingView) {
    const eventId = content.booking;
    if (typeof eventId !== 'string' || !/^[0-9a-f]{64}$/u.test(eventId))
      throw invalidArgs(`booking must be the id book gave you in ${view.surface.words.ownerLabel}.`);
    if (await hasPendingBookingRequest(view.surface.owner, eventId))
      throw forbidden(
        'An earlier request for this booking is still waiting for confirmation or reporting. Its first answer will reach you; wait for it before changing the booking again.',
      );
    const booking = await getBooking(view.surface.owner, eventId);
    if (!booking)
      throw forbidden(`There is no such booking for ${view.surface.words.ownerLabel}. Use the id book gave you here.`);
    const event = await calendar().getEvent(booking.calendarId, eventId);
    if (!event) {
      const entry = await calendar().getCalendar(booking.calendarId);
      if (!entry || !isReadable(entry))
        throw forbidden('The booking calendar is no longer readable. Ask main with tell_main.');
    }
    if (!event || event.status === 'cancelled') {
      await deleteBooking(booking.calendarId, eventId);
      throw forbidden(removedWords(view));
    }
    if (!owns(event, view))
      throw forbidden(`That event no longer belongs to ${view.surface.words.ownerLabel}. Ask main with tell_main.`);
    const span = eventSpan(event, view.principal.timezone);
    if (!span) throw forbidden('The booking has no readable time. Ask main with tell_main.');
    if (event.etag === undefined)
      throw forbidden('Google supplied no version for this booking. Ask main with tell_main.');
    return { booking, event, span, invitees: inviteesOn(event, view) };
  }

  /** to: external-email, external-chat, job */
  async function checkShareable(
    view: BookingView,
    entry: CalendarEntry | undefined,
    recipients: readonly string[],
    fields: EventWrite,
    changing: boolean,
  ): Promise<void> {
    await assertInvitationShareable(
      {
        texts: [fields.summary, fields.description, fields.location],
        shown: [entry?.summary],
        recipients,
        ...(await view.surface.privacyFor(recipients, view.writer)),
      },
      changing ? 'The booking was not changed' : 'The booking was not made',
      privateAdvice,
    );
  }

  function bookFields(
    content: Record<string, unknown>,
    view: BookingView,
    invitees: readonly string[],
    eventId: string,
    calendarId: string,
  ): NewEvent {
    const title = lineOf(content.title, 'title', 120);
    if (title === undefined) throw invalidArgs('title is required.');
    const start = instantOf(content.start, 'start');
    const span = { start, end: start + minutesOf(content.minutes) * MINUTE };
    const notes = notesOf(content.notes, 2_000);
    const location = lineOf(content.location, 'location', 500);
    const video = flagOf(content.video_call, 'video_call');
    timezoneOf(content.timezone);
    return {
      summary: title,
      ...(notes === undefined ? {} : { description: notes }),
      ...(location === undefined ? {} : { location }),
      ...(video ? { conference: { requestId: eventIdFor('meet', eventId) } } : {}),
      start: iso(span.start),
      end: iso(span.end),
      timeZone: view.principal.timezone,
      attendees: guestsOn(calendarId, invitees),
      reminders: 'default',
      tags: { [TAG_ROLE]: 'booking', [ownerTag(view)]: view.surface.owner.key },
    };
  }

  /** to: external-email, external-chat, job */
  async function checkedBook(
    content: Record<string, unknown>,
    view: BookingView,
    eventId: string,
    calendarId?: string,
    preparedInvitees?: readonly string[],
  ) {
    const entry = await bookingCalendarOf(view);
    if (calendarId !== undefined && entry.id !== calendarId)
      throw forbidden('The booking calendar changed before this request was confirmed. Ask main with tell_main.');
    const invitees = await inviteesOf(preparedInvitees ?? content.invitees, view);
    const fields = bookFields(content, view, invitees, eventId, entry.id);
    const span = { start: Date.parse(fields.start), end: Date.parse(fields.end) };
    await assertAvailable(view, entry.id, [span], new Set([eventId]));
    await checkShareable(view, entry, invitees, fields, false);
    if (fields.conference !== undefined && !allowsMeet(entry))
      throw forbidden('This calendar does not allow Google Meet links. Give a location instead.');
    return { entry, fields, span, invitees };
  }

  /** to: external-email, external-chat, job */
  async function checkedChange(
    content: Record<string, unknown>,
    view: BookingView,
    event: CalendarEvent,
    calendarId: string,
    requestId: string,
    target?: Span,
  ) {
    const previous = eventSpan(event, view.principal.timezone);
    if (!previous) throw forbidden('The booking has no readable time. Ask main with tell_main.');
    const start = content.start === undefined ? previous.start : instantOf(content.start, 'start');
    const span = target ?? {
      start,
      end:
        start + (content.minutes === undefined ? previous.end - previous.start : minutesOf(content.minutes) * MINUTE),
    };
    const title = lineOf(content.title, 'title', 120);
    const notes = notesOf(content.notes, 2_000);
    const location = lineOf(content.location, 'location', 500);
    const video = flagOf(content.video_call, 'video_call');
    timezoneOf(content.timezone);
    if ([content.start, content.minutes, title, notes, location].every((value) => value === undefined) && !video)
      throw invalidArgs('Give at least one change.');
    const retimed = span.start !== previous.start || span.end !== previous.end;
    const linking = video && (event.conference === undefined || event.conference.status === 'failure');
    const fields: EventWrite = {
      ...(title === undefined ? {} : { summary: title }),
      ...(notes === undefined ? {} : { description: notes }),
      ...(location === undefined ? {} : { location }),
      ...(retimed ? { start: iso(span.start), end: iso(span.end) } : {}),
      ...(linking ? { conference: { requestId: eventIdFor('meet', event.id, requestId) } } : {}),
    };
    if (retimed) await assertAvailable(view, calendarId, [span], new Set([event.id]));
    const entry = await calendar().getCalendar(calendarId);
    if (!entry || !isBookableCalendar(entry, view.principal.addresses))
      throw forbidden('The booking calendar is no longer bookable. Ask main with tell_main.');
    const invitees = inviteesOn(event, view);
    await checkShareable(view, entry, invitees, fields, true);
    if (linking && !allowsMeet(entry))
      throw forbidden('This calendar does not allow Google Meet links. Give a location instead.');
    return {
      fields,
      span,
      previous,
      invitees,
      title,
      video,
      fresh: [
        ...(title === undefined ? [] : ['title']),
        ...(notes === undefined ? [] : ['note']),
        ...(location === undefined ? [] : ['place']),
        ...(linking ? ['video link'] : []),
      ],
    };
  }

  async function retainAndRefuse(row: BookingRequest, error: ActionRefusal): Promise<never> {
    const outcome: BookingOutcome = {
      kind: 'refused',
      result: {},
      span: spanOf(row),
      refusal: error.message,
      refusalCode: error.code,
    };
    await getDb().transaction(async () => {
      await markBookingRequestApplied(row.sessionId, row.requestId, JSON.stringify(outcome));
      await markBookingRequestReported(row.sessionId, row.requestId);
    });
    throw error;
  }

  async function checkFailure(
    row: BookingRequest,
    view: BookingView,
    error: unknown,
    recovering: boolean,
  ): Promise<never> {
    if (error instanceof ActionRefusal) return retainAndRefuse(row, error);
    if (recovering && isGoogleConnectionDown(error)) throw error;
    if (isGoogleConnectionDown(error))
      return retainAndRefuse(row, forbidden(`${GOOGLE_CONNECTION_DOWN} ${view.surface.words.connectionStep}`));
    throw error;
  }

  async function writeFailure(
    row: BookingRequest,
    view: BookingView,
    error: unknown,
    recovering: boolean,
  ): Promise<typeof ANSWER_LATER | Record<string, unknown>> {
    if (error instanceof GoogleApiError && error.status === 412) {
      const event = await calendar().getEvent(row.calendarId, row.eventId);
      return event && event.status !== 'cancelled'
        ? finishRequest(row, view, changedOutcome(row, event, view))
        : settleRequest(row, view, false, recovering);
    }
    if (recovering && isGoogleConnectionDown(error)) throw error;
    if (isGoogleConnectionDown(error))
      return retainAndRefuse(row, forbidden(`${GOOGLE_CONNECTION_DOWN} ${view.surface.words.connectionStep}`));
    const rateLimited =
      error instanceof GoogleApiError &&
      error.status === 403 &&
      ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(
        error.reason ?? '',
      );
    if (error instanceof GoogleApiError && !error.retryable && !rateLimited)
      return retainAndRefuse(row, forbidden(`Google refused this booking request: ${error.message}`));
    log.warn('Booking write awaits Google confirmation', { requestId: row.requestId, owner: row.owner, error });
    return ANSWER_LATER;
  }

  /* eslint-disable no-catch-all/no-catch-all -- a durable intent stays unanswered on uncertain Google or local failures */
  async function applyRequest(
    row: BookingRequest,
    view: BookingView,
    event?: CalendarEvent,
    recovering = false,
  ): ReturnType<DeferredActionAnswer> {
    const content = contentOf(row);
    if (row.action === 'book') {
      const { fields } = await checkedBook(content, view, row.eventId, row.calendarId, preparedOf(row).invitees).catch(
        (error: unknown) => checkFailure(row, view, error, recovering),
      );
      try {
        const result = await calendar().insertEvent(row.calendarId, row.eventId, fields, 'all');
        if (result === 'exists') return settleRequest(row, view, false, recovering);
      } catch (error) {
        return writeFailure(row, view, error, recovering);
      }
    } else if (row.action === 'change') {
      if (!event || row.eventEtag === null) return finishRequest(row, view, unknownOutcome(row, view));
      const checked = await checkedChange(content, view, event, row.calendarId, row.requestId, spanOf(row)).catch(
        (error: unknown) => checkFailure(row, view, error, recovering),
      );
      try {
        await calendar().patchEvent(
          row.calendarId,
          row.eventId,
          { ...checked.fields, tags: { ...event.tags, [tagRequest]: row.requestMark ?? '' } },
          'all',
          row.eventEtag,
        );
      } catch (error) {
        return writeFailure(row, view, error, recovering);
      }
    } else {
      try {
        const deleted = await calendar().deleteEvent(row.calendarId, row.eventId, 'all', row.eventEtag ?? undefined);
        if (deleted === 'gone') return settleRequest(row, view, false, recovering);
      } catch (error) {
        if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410))
          return settleRequest(row, view, false, recovering);
        return writeFailure(row, view, error, recovering);
      }
    }
    const observed = row.action === 'cancel' ? undefined : await calendar().getEvent(row.calendarId, row.eventId);
    if (row.action !== 'cancel' && !observed) {
      const entry = await calendar().getCalendar(row.calendarId);
      return finishRequest(
        row,
        view,
        entry && isReadable(entry) ? removedOutcome(row, view) : unknownOutcome(row, view),
      );
    }
    if (observed?.status === 'cancelled') return finishRequest(row, view, removedOutcome(row, view));
    return finishRequest(row, view, successOutcome(row, view, observed));
  }

  async function settleRequest(
    row: BookingRequest,
    view: BookingView,
    replayAllowed: boolean,
    recovering = false,
  ): ReturnType<DeferredActionAnswer> {
    if (row.applied) return finishRequest(row, view, outcomeOf(row));
    const event = await calendar().getEvent(row.calendarId, row.eventId);
    if (!event) {
      const entry = await calendar().getCalendar(row.calendarId);
      if (!entry || !isReadable(entry)) return finishRequest(row, view, unknownOutcome(row, view));
      if (row.action === 'cancel') return finishRequest(row, view, successOutcome(row, view));
      if (row.action === 'change') return finishRequest(row, view, removedOutcome(row, view));
      return replayAllowed && !row.carriedOver
        ? applyRequest(row, view, undefined, recovering)
        : finishRequest(row, view, absentOutcome(row, view));
    }
    if (event.status === 'cancelled')
      return finishRequest(row, view, row.action === 'cancel' ? successOutcome(row, view) : removedOutcome(row, view));
    if (!owns(event, view)) return finishRequest(row, view, unknownOutcome(row, view));
    if (row.action === 'book') return finishRequest(row, view, successOutcome(row, view, event));
    if (row.action === 'change' && row.requestMark !== null && event.tags?.[tagRequest] === row.requestMark)
      return finishRequest(row, view, successOutcome(row, view, event));
    if (row.eventEtag === null) return finishRequest(row, view, unknownOutcome(row, view));
    if (event.etag !== row.eventEtag) return finishRequest(row, view, changedOutcome(row, event, view));
    if (!replayAllowed || row.carriedOver) return finishRequest(row, view, unknownOutcome(row, view));
    if (row.action === 'change') {
      try {
        await assertAvailable(view, row.calendarId, [spanOf(row)], new Set([row.eventId]));
      } catch (error) {
        if (error instanceof ActionRefusal) return retainAndRefuse(row, error);
        throw error;
      }
    }
    return applyRequest(row, view, event, recovering);
  }

  async function request(
    action: BookingRequest['action'],
    content: Record<string, unknown>,
    session: Session,
    requestId: string,
    view: BookingView,
  ): ReturnType<DeferredActionAnswer> {
    const fingerprint = eventIdFor(JSON.stringify(content));
    let row: PendingBookingRequest | undefined;
    try {
      row = await getBookingRequest(session.id, requestId);
    } catch (error) {
      throw new RetryDeliveryError('Booking intent could not be read; its outbound request must retry.', {
        cause: error,
      });
    }
    let intentAttempted = false;
    if (row && (row.action !== action || row.fingerprint !== fingerprint))
      throw forbidden('This booking request ID was already used for different work.');
    if (row && (row.owner.kind !== view.surface.owner.kind || row.owner.key !== view.surface.owner.key))
      throw forbidden('This booking request belongs to another conversation.');
    try {
      if (row) {
        view.startedAt = row.createdAt;
        return row.state === 'answer' ? terminalResult(row) : await settleRequest(row, view, true);
      }
      let prepared: PreparedRequest;
      let event: CalendarEvent | undefined;
      let span: Span;
      let calendarId: string;
      let eventId: string;
      if (action === 'book') {
        eventId = eventIdFor('booking', view.surface.owner.kind, view.surface.owner.key, requestId);
        const checked = await checkedBook(content, view, eventId);
        calendarId = checked.entry.id;
        span = checked.span;
        prepared = {
          content,
          invitees: checked.invitees,
          previous: span,
          title: checked.fields.summary,
          video: checked.fields.conference !== undefined,
          fresh: [],
        };
      } else {
        const owned = await ownBooking(content, view);
        event = owned.event;
        calendarId = owned.booking.calendarId;
        eventId = owned.booking.eventId;
        if (action === 'change') {
          const checked = await checkedChange(content, view, event, calendarId, requestId);
          span = checked.span;
          if (Object.keys(checked.fields).length === 0)
            return {
              booking: eventId,
              start: iso(span.start),
              end: iso(span.end),
              message: `The booking already stands at ${bothZones(span, view.principal.timezone, timezoneOf(content.timezone))}${conferenceWords(event.conference)}: nothing changed.`,
            };
          prepared = {
            content,
            invitees: checked.invitees,
            previous: checked.previous,
            title: checked.title,
            video: checked.video,
            fresh: checked.fresh,
          };
        } else {
          timezoneOf(content.timezone);
          span = owned.span;
          prepared = {
            content,
            invitees: owned.invitees,
            previous: span,
            video: event.conference !== undefined,
            fresh: [],
          };
        }
      }
      intentAttempted = true;
      row = await recordBookingRequest({
        sessionId: session.id,
        requestId,
        action,
        fingerprint,
        requestJson: JSON.stringify(prepared),
        owner: view.surface.owner,
        calendarId,
        eventId,
        startAt: iso(span.start),
        endAt: iso(span.end),
        eventEtag: event?.etag ?? null,
        requestMark: action === 'change' ? eventIdFor('booking-change', session.id, requestId) : null,
        createdAt: view.startedAt,
      });
      return await applyRequest(row, view, event);
    } catch (error) {
      if (!row && intentAttempted) {
        throw new RetryDeliveryError(
          'Booking intent recording could not be confirmed; its outbound request must retry.',
          { cause: error },
        );
      }
      if (!row) {
        if (isGoogleConnectionDown(error))
          throw forbidden(`${GOOGLE_CONNECTION_DOWN} ${view.surface.words.connectionStep}`);
        throw error;
      }
      let current: PendingBookingRequest | undefined;
      try {
        current = await getBookingRequest(row.sessionId, row.requestId);
      } catch (readError) {
        log.warn('Booking settlement could not be read; the request stays unanswered', { requestId, error, readError });
        return ANSWER_LATER;
      }
      if (
        error instanceof ActionRefusal &&
        (!current ||
          current.state === 'answer' ||
          (current.applied && current.reported && outcomeOf(current).refusal === error.message))
      )
        throw error;
      log.warn('Durable booking request awaits settlement or reporting', { requestId, owner: row.owner, error });
      return ANSWER_LATER;
    }
  }

  async function resumePending(): Promise<void> {
    if (!(await getDb().hasTable('gws_ea_booking_requests'))) return;
    const pendingRequests = await listPendingBookingRequests();
    for (const pending of pendingRequests) {
      const key = requestKey(pending.sessionId, pending.requestId);
      if (inFlight.has(key)) continue;
      try {
        const surface = bookingSurfaceFor(pending.owner);
        const candidate = await getSession(pending.sessionId);
        if (
          pending.state === 'write' &&
          !pending.applied &&
          candidate &&
          !pending.carriedOver &&
          !(await answeredMessage(candidate, pending.requestId, pending.createdAt)) &&
          (await surface.stillServing(candidate))
        )
          await surface.beforeWrite();
        await surface.inWrite(() =>
          inSchedulingTurn(async () => {
            if (inFlight.has(key)) return;
            const row = await getBookingRequest(pending.sessionId, pending.requestId);
            if (!row) return;
            const session = await getSession(row.sessionId);
            const answered = session ? await answeredMessage(session, row.requestId, row.createdAt) : undefined;
            const view: BookingView = {
              surface,
              writer:
                row.owner.kind === 'thread'
                  ? 'external-email'
                  : session?.agent_group_id === (await getExternalChatAgentGroupId())
                    ? 'external-chat'
                    : 'job',
              principal: await principalView(),
              startedAt: row.createdAt,
              answerExists: answered !== undefined,
            };
            const replayAllowed =
              row.state === 'write' &&
              !answered &&
              !row.carriedOver &&
              session !== undefined &&
              (await surface.stillServing(session));
            let frame: ResponseFrame;
            try {
              const result =
                row.state === 'answer' ? terminalResult(row) : await settleRequest(row, view, replayAllowed, true);
              if (result === ANSWER_LATER) return;
              frame = { id: row.requestId, ok: true, data: result };
            } catch (error) {
              if (!(error instanceof ActionRefusal)) throw error;
              const current = await getBookingRequest(row.sessionId, row.requestId);
              if (
                current &&
                current.state !== 'answer' &&
                !(current.applied && current.reported && outcomeOf(current).refusal === error.message)
              )
                throw error;
              frame = { id: row.requestId, ok: false, error: { code: error.code, message: error.message } };
            }
            if (session) {
              if (!answered) await deliverAnswer(session, row.requestId, row.createdAt, frame);
              else {
                if (Date.parse(answered.timestamp) - Date.parse(row.createdAt) >= TOOL_WAIT_MS)
                  await wakeLateAnswer(session, row.requestId, answered.content);
                clearOutbox(session.agent_group_id, session.id, row.requestId);
              }
            }
            await deleteBookingRequest(row.sessionId, row.requestId);
            ownChangeRequests.delete(key);
          }),
        );
      } catch (error) {
        log.warn('Booking request could not resume; it will retry', {
          requestId: pending.requestId,
          owner: pending.owner,
          error,
        });
      }
    }
  }

  /* eslint-enable no-catch-all/no-catch-all */
  return {
    resumePending,
    completeAnswer,
    freeTime,
    book: bound('book', (content, session, requestId, view) => request('book', content, session, requestId, view), [
      'start',
      'minutes',
      'title',
      'notes',
      'location',
      'video_call',
      'invitees',
      'timezone',
    ]),
    changeBooking: bound(
      'change',
      (content, session, requestId, view) => request('change', content, session, requestId, view),
      ['booking', 'start', 'minutes', 'title', 'notes', 'location', 'video_call', 'timezone'],
    ),
    cancelBooking: bound(
      'cancel',
      (content, session, requestId, view) => request('cancel', content, session, requestId, view),
      ['booking', 'timezone'],
    ),
  };
}
