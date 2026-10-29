import { log } from '../../log.js';
import { createHash } from 'node:crypto';
import { forbidden, invalidArgs, type ActionAnswer } from '../../cli/delivery-action.js';
import { stageInboxFile } from '../../session-manager.js';
import { getMatter, listOpenMatters } from '../gws-ea-matters/db.js';
import { findTasks } from '../gws-ea-matters/looks.js';
import { listPeople } from '../gws-ea-people/db.js';
import { listPrivateValues } from '../gws-ea-privacy/db.js';
import { getSchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { getGwsEaProfile, principalRecognizer } from '../gws-ea-profile/db.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { isPrincipalCalendar } from '../gws-ea-inbox/calendar-notifications.js';
import { boundary, dateString, isDate, nextDate, parseDate, wallClock, zonedIso } from '../gws-ea-whereabouts/clock.js';
import { loadTimeline, zoneAt, zoneForDay, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import type { DetailedEvent, MeetingsCalendarApi } from './calendar-api.js';
import { addressesOf, flagOf, instantOf, lineOf } from './fields.js';
import { isPrincipalAttendee, principalAnswer } from './slots.js';
import { loadAcknowledgements } from './week/acks.js';
import { checkWeek, presentFinding } from './week/checker.js';
import {
  buildWeek,
  calendarText,
  presentWeek,
  type EventCopy,
  type MeetingHistory,
  type Week,
  type WeekEvent,
} from './week/model.js';

const DAY = 86_400_000;
export const CALENDAR_ANSWER_LIMIT = 12_000;
export function boundedCalendarMessage(
  head: string,
  entries: readonly string[],
  limit = CALENDAR_ANSWER_LIMIT,
): string {
  const lines = [head];
  let size = head.length;
  for (const entry of entries) {
    if (size + entry.length + 42 > limit) break;
    lines.push(entry);
    size += 1 + entry.length;
  }
  const more = entries.length - lines.length + 1;
  if (more > 0) lines.push(`${more} more.`);
  return lines.join('\n');
}
export interface CalendarWeekOptions {
  readonly start: number;
  readonly end: number;
  readonly timeline?: Timeline;
  readonly shaping?: boolean;
  readonly eventSnapshot?: readonly EventCopy[];
  readonly additionalEvents?: readonly EventCopy[];
  readonly replaceEvent?: { readonly calendarId: string; readonly eventId: string };
}
/** One operation owns one timeline; the refresher may supply its already-read snapshot. */
export async function loadCalendarWeek(calendar: MeetingsCalendarApi, options: CalendarWeekOptions): Promise<Week> {
  const [timeline, profile, listed, preferences, people, summaries, privateValues] = await Promise.all([
    options.timeline ?? loadTimeline(),
    getGwsEaProfile(),
    options.eventSnapshot ? Promise.resolve([]) : calendar.listCalendars(),
    getSchedulingPreferenceValues(),
    listPeople(),
    listOpenMatters(),
    listPrivateValues(),
  ]);
  const principal = principalRecognizer(profile.principal_emails);
  const calendars = listed.filter((entry) => isPrincipalCalendar(entry, principal));
  if (!options.eventSnapshot && !calendars.length)
    throw forbidden("None of the principal's calendars is in your list yet.");
  const copies =
    options.eventSnapshot ??
    (
      await Promise.all(
        calendars.map(async (entry) =>
          (
            await calendar.listEventDetails(
              entry.id,
              new Date(options.start - DAY).toISOString(),
              new Date(options.end + DAY).toISOString(),
            )
          ).map((event): EventCopy => ({ calendarId: entry.id, owner: 'principal', event })),
        ),
      )
    ).flat();
  const matterIds = summaries.flatMap((m) => [m.id, ...m.strands.map((s) => s.id)]);
  const matters = (await Promise.all(matterIds.map(getMatter))).filter((m) => m !== undefined);
  const tasks = await findTasks(matters.flatMap((m) => (m.look_task_id ? [m.look_task_id] : [])));
  let history: MeetingHistory[] | undefined;
  if (options.shaping) {
    /* eslint-disable no-catch-all/no-catch-all -- an unavailable history is unknown, never zero meetings or a failed write */
    try {
      const historyCalendars = options.eventSnapshot
        ? (await calendar.listCalendars()).filter((entry) => isPrincipalCalendar(entry, principal))
        : calendars;
      if (historyCalendars.length === 0)
        throw new Error('No principal calendars were available to verify meeting history');
      const now = Date.now();
      const since = now - 183 * DAY;
      const assistant = await assistantAddresses();
      const seen = new Set<string>();
      const tally = new Map<string, { meetings: number; last: number }>();
      for (const entry of historyCalendars)
        for (const e of await calendar.listEventDetails(
          entry.id,
          new Date(since).toISOString(),
          new Date(now).toISOString(),
        )) {
          const at = Date.parse(e.start?.dateTime ?? `${e.start?.date ?? ''}T00:00:00Z`);
          const original = e.originalStartTime ?? e.start;
          const key = `${e.iCalUID ?? `${entry.id}/${e.id}`}|${original?.date ?? (original?.dateTime ? Date.parse(original.dateTime) : '')}`;
          if (
            at < since ||
            at >= now ||
            !Number.isFinite(at) ||
            seen.has(key) ||
            e.status === 'cancelled' ||
            e.attendeesOmitted ||
            (e.attendees ?? []).filter((a) => !a.resource).length > 8
          )
            continue;
          if (
            !principal.has(e.organizer?.email) &&
            e.organizer?.self !== true &&
            principalAnswer(e, principal) !== 'accepted'
          )
            continue;
          seen.add(key);
          for (const email of new Set(
            (e.attendees ?? [])
              .filter((a) => !a.resource && !isPrincipalAttendee(a, principal) && a.email && !assistant.has(a.email))
              .flatMap((a) => a.email ?? []),
          )) {
            const held = tally.get(email) ?? { meetings: 0, last: 0 };
            tally.set(email, { meetings: held.meetings + 1, last: Math.max(at, held.last) });
          }
        }
      history = [...tally].map(([email, value]) => ({
        identity: `email:${email}`,
        meetings: value.meetings,
        last_meeting: dateString(wallClock(value.last, zoneAt(timeline, value.last) ?? 'UTC')),
      }));
    } catch (error) {
      log.warn('Calendar shaping history unavailable', { error });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  const first = dateString(wallClock(options.start, zoneAt(timeline, options.start) ?? 'UTC'));
  const last = dateString(wallClock(options.end - 1, zoneAt(timeline, options.end - 1) ?? 'UTC'));
  return buildWeek({
    now: options.start,
    timeline,
    principal,
    principalNames: [
      profile.principal_first_name,
      profile.principal_display_name,
      [profile.principal_first_name, profile.principal_last_name].filter(Boolean).join(' '),
    ].filter((n): n is string => Boolean(n)),
    events: [
      ...copies.filter(
        (c) =>
          !options.replaceEvent ||
          c.calendarId !== options.replaceEvent.calendarId ||
          c.event.id !== options.replaceEvent.eventId,
      ),
      ...(options.additionalEvents ?? []),
    ],
    preferences,
    people,
    matters: matters.map((matter) => ({
      matter,
      checkInAt: matter.look_task_id ? (tasks.get(matter.look_task_id)?.task.processAfter ?? null) : null,
    })),
    privateValues: Object.fromEntries(privateValues.map((v) => [v.id, v.value])),
    ...(history === undefined ? {} : { history }),
    dayCount: Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / DAY) + 1),
  });
}
const responseWords = (status: string | null | undefined): string =>
  status && ['accepted', 'tentative', 'declined', 'needsAction'].includes(status) ? status : 'not recorded';
function personWords(person: WeekEvent['involvement']['guests'][number]): string {
  return [
    calendarText(person.name ?? person.identity),
    `response: ${responseWords(person.response)}`,
    `people record: ${person.hasPeopleRecord ? 'yes' : 'no'}`,
    `relationship: ${person.level}`,
    person.meetings === null
      ? 'meeting history not read'
      : `${person.meetings} meetings together in six months${person.lastMeeting ? `; last met ${person.lastMeeting}` : ''}`,
  ].join('; ');
}
export function affectedPeople(event: WeekEvent, week: Week): string {
  const creator = event.event.creator;
  const principalCreated = creator?.email && principalRecognizer(week.principalAddresses).has(creator.email);
  const organizer =
    event.principalRole === 'organizer'
      ? 'The principal organizes it.'
      : event.ownerOrganizes
        ? 'The assistant organizes it on its own calendar.'
        : event.event.organizer?.email
          ? `Organizer: ${calendarText(event.event.organizer.email)}.`
          : 'Organizer not shown.';
  return boundedCalendarMessage(
    event.involvement.onlyPrincipal
      ? 'No one else is affected; only the principal is involved.'
      : 'People this affects:',
    [
      organizer,
      ...(event.principalRole === 'guest'
        ? [
            event.event.guestsCanModify === true
              ? 'Google permits guests to edit; moving this event is a change.'
              : 'The principal is a guest; a move is a request to the organizer unless Google permits the edit.',
          ]
        : []),
      ...event.involvement.guests.map((p) => `Guest: ${personWords(p)}.`),
      ...event.involvement.named.map(
        (p) =>
          `${personWords(p)}; named but not on the invite${principalCreated ? ' of an event the principal created' : creator?.email ? `; creator: ${calendarText(creator.email)}` : '; creator not shown'}.`,
      ),
      ...week.matters
        .filter((m) => m.matter.links.some((l) => l.kind === 'event' && l.reference === event.key))
        .flatMap((m) => m.involvement.linked.map((p) => `Matter commitment with: ${personWords(p)}.`)),
    ],
    8_000,
  );
}
export function renderDays(week: Week, filter?: string): string {
  const shown = presentWeek(week);
  const selected = week.events.filter(
    (e) =>
      !filter ||
      `${e.event.summary ?? ''}\n${e.event.description ?? ''}\n${e.event.location ?? ''}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const lines = selected.map((e) => {
    const p = shown.days.flatMap((d) => d.events).find((p) => p.key === e.key);
    if (!p) throw new Error('Calendar event missing from presentation');
    return [
      e.allDay
        ? `${e.day}${e.day === e.lastDay ? '' : ` to ${e.lastDay}`}, all day`
        : `${p.start} to ${p.end} (${e.zone ?? 'zone unknown'})`,
      `event ${e.id} on calendar ${e.calendarId}`,
      p.title,
      ...(p.location ? [`Place: ${p.location}`] : []),
      ...(p.description ? [`Notes: ${p.description}`] : []),
      ...(p.creator ? [`Creator: ${p.creator.name ?? ''} ${p.creator.email ?? ''}`] : []),
      `Organizer: ${p.organizer ?? 'not shown'}`,
      ...(e.event.attendees ?? []).map(
        (a) =>
          `Attendee: ${calendarText(a.displayName ?? a.email ?? 'unknown')}${a.displayName && a.email ? ` ${calendarText(a.email)}` : ''}; ${responseWords(a.responseStatus)}${a.self ? ' (this calendar’s own response)' : ''}`,
      ),
    ].join('\n');
  });
  return boundedCalendarMessage(`${selected.length} events across ${week.days.length} local days.`, lines);
}
export async function calendarFindings(week: Week): Promise<string> {
  const findings = checkWeek(week, await loadAcknowledgements());
  return boundedCalendarMessage(
    `Findings for ${week.days.map((d) => d.date).join(', ')}:`,
    findings.length ? findings.map((f) => presentFinding(f, week)) : ['No findings.'],
  );
}
export function meetingLengthFacts(week: Week, kind?: string): string {
  const lengths = week.preferences.meeting_lengths.filter((p) => kind === undefined || p.meeting_kind === kind);
  return lengths.length
    ? `Recorded meeting lengths:\n${lengths.map((p) => `${calendarText(p.meeting_kind)}: ${p.minutes} minutes`).join('\n')}`
    : `No meeting length recorded${kind ? ` for ${calendarText(kind)}` : ''}.`;
}
function dayBoundary(value: unknown, label: string, timeline: Timeline, end: boolean): number {
  if (typeof value === 'string' && isDate(value)) {
    parseDate(value);
    return boundary(value, zoneForDay(timeline, value) ?? 'UTC', end ? 'end' : 'start');
  }
  return instantOf(value, label);
}
export function createDaysTools(deps: { readonly calendar: () => MeetingsCalendarApi }) {
  const days: ActionAnswer = async (content, session, requestId) => {
    const timeline = await loadTimeline();
    const now = Date.now();
    const today = dateString(wallClock(now, zoneAt(timeline, now) ?? 'UTC'));
    const start =
      content.start === undefined
        ? boundary(today, zoneForDay(timeline, today) ?? 'UTC', 'start')
        : dayBoundary(content.start, 'start', timeline, false);
    let lastDay = parseDate(dateString(wallClock(start, zoneAt(timeline, start) ?? 'UTC')));
    for (let day = 1; day < 8; day++) lastDay = nextDate(lastDay);
    const lastDate = dateString(lastDay);
    const end =
      content.end === undefined
        ? boundary(lastDate, zoneForDay(timeline, lastDate) ?? 'UTC', 'end')
        : dayBoundary(content.end, 'end', timeline, true);
    if (end <= start) throw invalidArgs('end must come after start');
    const eventId = lineOf(content.event, 'event', 1024);
    let additionalEvents: EventCopy[] = [];
    if (eventId) {
      const calendarId = lineOf(content.calendar, 'calendar', 254);
      if (!calendarId) throw invalidArgs('calendar is required with event');
      const [entry, profile, assistant, detail] = await Promise.all([
        deps.calendar().getCalendar(calendarId),
        getGwsEaProfile(),
        assistantAddresses(),
        deps.calendar().getEventDetail(calendarId, eventId),
      ]);
      const owner =
        entry && isPrincipalCalendar(entry, principalRecognizer(profile.principal_emails))
          ? 'principal'
          : assistant.has(calendarId)
            ? 'assistant'
            : undefined;
      if (!entry || !owner) throw forbidden('Read an event on a principal calendar or your own calendar.');
      if (!detail || detail.status === 'cancelled') return { message: 'That event is no longer on this calendar.' };
      additionalEvents = [{ calendarId, event: detail, owner }];
      const detailStart = dayBoundary(detail.start?.date ?? detail.start?.dateTime, 'event start', timeline, false);
      const detailEnd = detail.end?.date
        ? boundary(detail.end.date, zoneForDay(timeline, detail.end.date) ?? 'UTC', 'start')
        : instantOf(detail.end?.dateTime, 'event end');
      const week = await loadCalendarWeek(deps.calendar(), {
        start: detailStart,
        end: detailEnd,
        timeline,
        additionalEvents,
        replaceEvent: { calendarId, eventId },
      });
      return {
        message: renderDays({
          ...week,
          events: week.events.filter((e) => e.id === eventId && e.calendarId === calendarId),
        }),
      };
    }
    const week = await loadCalendarWeek(deps.calendar(), { start, end, timeline });
    const filter = lineOf(content.filter, 'filter', 200);
    if (flagOf(content.export, 'export')) {
      const selected = week.events.filter(
        (e) =>
          !filter ||
          `${e.event.summary ?? ''}\n${e.event.description ?? ''}\n${e.event.location ?? ''}`
            .toLowerCase()
            .includes(filter.toLowerCase()),
      );
      const rendered = selected.map((e) => renderDays({ ...week, events: [e] })).join('\n\n');
      const key = createHash('sha256').update(requestId).digest('hex').slice(0, 24);
      const path = stageInboxFile(
        session.agent_group_id,
        session.id,
        `calendar-${key}`,
        'days.txt',
        Buffer.from(rendered),
      );
      return { path, count: selected.length, message: `Exported ${selected.length} events to ${path}.` };
    }
    return { message: renderDays(week, filter) };
  };
  const check: ActionAnswer = async (content) => {
    const timeline = await loadTimeline();
    const start = dayBoundary(content.start, 'start', timeline, false);
    const end = dayBoundary(content.end, 'end', timeline, false);
    if (end <= start) throw invalidArgs('end must come after start');
    const colleagues = addressesOf(content.calendars, 'calendars', 50);
    if (colleagues) {
      const busy = await deps
        .calendar()
        .freeBusy(colleagues, new Date(start).toISOString(), new Date(end).toISOString());
      return {
        message: boundedCalendarMessage(
          'People this affects: the calendar owners below. Busy windows only; nothing booked.',
          Object.entries(busy).map(
            ([id, windows]) =>
              `${calendarText(id)}:\n${windows.length ? windows.map((w) => `${zonedIso(Date.parse(w.start), zoneAt(timeline, Date.parse(w.start)) ?? 'UTC')} to ${zonedIso(Date.parse(w.end), zoneAt(timeline, Date.parse(w.start)) ?? 'UTC')}`).join('\n') : 'No busy windows.'}`,
          ),
        ),
      };
    }
    const eventId = lineOf(content.event, 'event', 1024);
    const profile = await getGwsEaProfile();
    const calendarId = lineOf(content.calendar, 'calendar', 254) ?? profile.principal_emails[0];
    if (!calendarId) throw forbidden('No principal calendar is known.');
    const [entry, assistant] = await Promise.all([deps.calendar().getCalendar(calendarId), assistantAddresses()]);
    const owner =
      entry && isPrincipalCalendar(entry, principalRecognizer(profile.principal_emails))
        ? 'principal'
        : assistant.has(calendarId)
          ? 'assistant'
          : undefined;
    if (!entry || !owner)
      throw forbidden(
        'Event details are available on principal calendars and your own; use calendars for colleagues’ busy windows.',
      );
    const existing = eventId ? await deps.calendar().getEventDetail(calendarId, eventId) : undefined;
    if (eventId && (!existing || existing.status === 'cancelled'))
      throw forbidden('That event is no longer on this calendar.');
    const detail: DetailedEvent = {
      ...existing,
      ...(existing ? {} : { organizer: { email: calendarId } }),
      id: eventId ?? 'proposed',
      summary: lineOf(content.title, 'title', 200) ?? existing?.summary ?? 'Proposed time',
      ...(content.location === undefined ? {} : { location: lineOf(content.location, 'location', 500) }),
      ...(content.guests === undefined
        ? {}
        : { attendees: (addressesOf(content.guests, 'guests', 50) ?? []).map((email) => ({ email })) }),
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(end).toISOString() },
    };
    const oldStart = existing?.start?.dateTime ? Date.parse(existing.start.dateTime) : start;
    const oldEnd = existing?.end?.dateTime ? Date.parse(existing.end.dateTime) : end;
    const week = await loadCalendarWeek(deps.calendar(), {
      start: Math.min(start, oldStart),
      end: Math.max(end, oldEnd),
      timeline,
      shaping: true,
      ...(eventId ? { replaceEvent: { calendarId, eventId } } : {}),
      additionalEvents: [{ calendarId, owner, event: detail }],
    });
    const changed = week.events.find((e) => e.id === detail.id && e.calendarId === calendarId);
    if (!changed) throw new Error('Proposed event missing from checked week');
    return {
      message: boundedCalendarMessage(affectedPeople(changed, week), [
        'Nothing booked or changed.',
        meetingLengthFacts(week, lineOf(content.kind, 'kind', 100)),
        await calendarFindings(week),
      ]),
    };
  };
  return { days, check };
}
