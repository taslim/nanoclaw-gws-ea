import { TIMEZONE } from '../../config.js';
import { forbidden, invalidArgs, type ActionAnswer, type DeferredActionAnswer } from '../../cli/delivery-action.js';
import type { Session } from '../../types.js';
import { assertChatToolFields } from '../gws-ea-chats/expect.js';
import { isBookableCalendar } from '../gws-ea-inbox/calendar-notifications.js';
import { listPrincipalCalendars } from '../gws-ea-inbox/db.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { getSchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { getGwsEaProfile, principalRecognizer, type PrincipalRecognizer } from '../gws-ea-profile/db.js';
import type { CalendarEntry, MeetingsCalendarApi } from './calendar-api.js';
import { slotLabel } from './calendar-actions.js';
import { resolveBookingSurface, type BookingSurfaceContext } from './booking-surface.js';
import { addressesOf, instantOf, timezoneOf } from './fields.js';
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

interface Principal {
  readonly timezone: string;
  readonly rules: SchedulingRules;
  readonly addresses: PrincipalRecognizer;
}
interface BookingView extends BookingSurfaceContext {
  readonly principal: Principal;
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
export function inSchedulingTurn<T>(work: () => Promise<T>): Promise<T> {
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

export function createBookingReads(deps: BookingToolsDeps) {
  const calendar = () => deps.calendar();

  async function viewOf(session: Session): Promise<BookingView> {
    return { ...(await resolveBookingSurface(session)), principal: await principalView() };
  }

  function bound(answer: BookingAnswer, fields: readonly string[], writing = false): DeferredActionAnswer {
    return async (content, session, requestId) => {
      assertChatToolFields(content, fields);
      const view = await viewOf(session);
      if (!writing) return answer(content, session, requestId, view);
      // The roster refresh takes the same conversation tail as the write wrapper.
      await view.surface.beforeWrite();
      return view.surface.inWrite(() =>
        inSchedulingTurn(async () => {
          if (!(await view.surface.stillServing(session)))
            throw forbidden('This session no longer serves this booking’s owner.');
          return answer(content, session, requestId, view);
        }),
      );
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

  return { freeTime, bound, viewOf, bookingCalendarOf, busyIn, assertAvailable, inviteesOf };
}
