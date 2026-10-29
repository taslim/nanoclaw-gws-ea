import { createHash } from 'node:crypto';

import { untrustedLine } from '../../gws-ea-inbox/untrusted.js';
import type { Matter } from '../../gws-ea-matters/db.js';
import { resolveMatterDueAt } from '../../gws-ea-matters/planning.js';
import type { PersonSummary, PersonLevel } from '../../gws-ea-people/db.js';
import type { SchedulingPreferenceValues, Weekday } from '../../gws-ea-preferences/db.js';
import type { PrincipalRecognizer } from '../../gws-ea-profile/db.js';
import {
  boundary,
  dateString,
  nextDate,
  parseDate,
  wallClock,
  zonedInstant,
  zonedIso,
} from '../../gws-ea-whereabouts/clock.js';
import { whereaboutsAt, zoneAt, zoneForDay, type Timeline } from '../../gws-ea-whereabouts/timeline.js';
import type { DetailedEvent } from '../calendar-api.js';
import { blocksTime, eventSpan, isPrincipalAttendee, principalAnswer, schedulingRules, type Span } from '../slots.js';
import { resolvePlace, travelBetween, type ResolvedPlace, type TravelFact } from './places.js';

/** Exact private-property names shared by readers and calendar writers. */
export const WEEK_TAGS = {
  parentEvent: 'gws_ea_parent_event',
  parentCalendar: 'gws_ea_parent_calendar',
  parentStart: 'gws_ea_parent_start',
  blockKind: 'gws_ea_block_kind',
  matter: 'gws_ea_matter_id',
  flight: 'gws_ea_flight',
  previousFlight: 'gws_ea_previous_flight',
  connectionMinutes: 'gws_ea_connection_minutes',
  assistantWritten: 'gws_ea_assistant_written',
  meetingKind: 'gws_ea_meeting_kind',
} as const;
export interface EventCopy {
  readonly calendarId: string;
  readonly event: DetailedEvent;
  readonly owner: 'principal' | 'assistant';
  readonly assistantWritten?: boolean;
}
export interface MatterInput {
  readonly matter: Matter;
  readonly checkInAt: string | null;
}
export interface MeetingHistory {
  readonly identity: string;
  readonly meetings: number;
  readonly last_meeting: string | null;
}
export interface DeletedBlock {
  readonly parentEventId: string;
  readonly parentCalendarId?: string;
  readonly kind: 'travel' | 'prep' | 'preflight';
  readonly actor: 'principal' | 'unknown';
}
export interface WeekInput {
  readonly deletedBlocks?: readonly DeletedBlock[];
  readonly now: number;
  readonly timeline: Timeline;
  readonly events: readonly EventCopy[];
  readonly principal: PrincipalRecognizer;
  readonly principalNames: readonly string[];
  readonly preferences: SchedulingPreferenceValues;
  readonly matters: readonly MatterInput[];
  readonly people: readonly PersonSummary[];
  /** Loaded only for a shaping answer, never by the view refresher. Absence is unknown, not zero meetings. */
  readonly history?: readonly MeetingHistory[];
  readonly privateValues?: Readonly<Record<string, string>>;
  readonly dayCount?: number;
}
export interface InvolvedPerson {
  readonly identity: string;
  readonly name: string | null;
  readonly personId: string | null;
  readonly hasPeopleRecord: boolean;
  readonly level: PersonLevel | 'unknown';
  readonly meetings: number | null;
  readonly metInSixMonths: boolean | null;
  readonly lastMeeting: string | null;
  readonly response: string | null;
  readonly organizer: boolean;
}
export interface Involvement {
  readonly onlyPrincipal: boolean;
  readonly guests: readonly InvolvedPerson[];
  readonly named: readonly InvolvedPerson[];
  readonly linked: readonly InvolvedPerson[];
}
/** Host-only facts. Use presentWeek/presentFinding before passing any part to a model. */
export interface WeekEvent extends Span {
  readonly key: string;
  readonly id: string;
  readonly calendarId: string;
  readonly version: string;
  readonly event: DetailedEvent;
  readonly copies: readonly EventCopy[];
  readonly copiesDisagree: boolean;
  readonly day: string;
  readonly lastDay: string;
  readonly zone: string | null;
  readonly workingHoursZone: string | null;
  readonly allDay: boolean;
  readonly busy: boolean;
  readonly place: ResolvedPlace;
  readonly assistantWritten: boolean;
  readonly principalRole: 'organizer' | 'guest' | 'neither';
  readonly ownerOrganizes: boolean;
  readonly involvement: Involvement;
}
export interface WeekMatter {
  readonly id: string;
  readonly matter: Matter;
  readonly due: number | null;
  readonly day: string | null;
  readonly checkIn: number | null;
  readonly involvement: Involvement;
}
export interface Move extends TravelFact {
  readonly from: ResolvedPlace;
  readonly to: ResolvedPlace;
  readonly eventKey: string;
  readonly previousEventKey: string | null;
  readonly availableMinutes: number | null;
  readonly reserved: boolean;
}
export interface WeekDay {
  readonly date: string;
  readonly weekday: Weekday;
  readonly zone: string | null;
  readonly locality: string | null;
  readonly events: readonly WeekEvent[];
  readonly matters: readonly WeekMatter[];
  readonly moves: readonly Move[];
}
export interface Week {
  readonly cancelledEventKeys: readonly string[];
  readonly deletedBlocks: readonly DeletedBlock[];
  readonly now: number;
  readonly timeline: Timeline;
  readonly preferences: SchedulingPreferenceValues;
  readonly events: readonly WeekEvent[];
  readonly matters: readonly WeekMatter[];
  readonly undatedMatters: readonly WeekMatter[];
  readonly days: readonly WeekDay[];
  readonly homeUnknown: boolean;
  readonly principalAddresses: readonly string[];
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
const timeKey = (time: DetailedEvent['start']): string =>
  time?.date ?? String(time?.dateTime ? Date.parse(time.dateTime) : '');
const originalKey = (copy: EventCopy): string => {
  const event = copy.event;
  const identity = event.iCalUID ?? `${copy.calendarId}/${event.id ?? digest(event)}`;
  const occurrence = event.originalStartTime ?? (event.recurringEventId ? event.start : undefined);
  return occurrence ? `${identity}|${timeKey(occurrence)}` : identity;
};
const weekdays: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const weekdayOf = (date: string): Weekday => weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()];
export const calendarText = (text: string, limit = 200): string => untrustedLine(text, limit, 'google_calendar');
const normalized = (text: string): string => text.normalize('NFKC').toLowerCase();

function personFact(
  identity: string,
  name: string | null,
  input: WeekInput,
  response: string | null = null,
  organizer = false,
): InvolvedPerson {
  const person = input.people.find(
    (p) => p.id === identity || p.identities.some((i) => normalized(i) === normalized(identity)),
  );
  const stats = input.history?.find((s) => normalized(s.identity) === normalized(identity));
  return {
    identity,
    name: name ?? person?.name ?? null,
    personId: person?.id ?? null,
    hasPeopleRecord: person !== undefined,
    level: person?.level ?? 'unknown',
    meetings: input.history === undefined ? null : (stats?.meetings ?? 0),
    metInSixMonths: input.history === undefined ? null : (stats?.meetings ?? 0) > 0,
    lastMeeting: stats?.last_meeting ?? null,
    response,
    organizer,
  };
}
function involvement(event: DetailedEvent, input: WeekInput): Involvement {
  const guests = (event.attendees ?? [])
    .filter(
      (a) =>
        !a.resource && !a.email?.endsWith('@resource.calendar.google.com') && !isPrincipalAttendee(a, input.principal),
    )
    .map((a) =>
      personFact(
        `email:${a.email ?? ''}`,
        a.displayName ?? null,
        input,
        a.responseStatus ?? null,
        a.organizer === true || a.email === event.organizer?.email,
      ),
    );
  if (
    event.organizer?.email &&
    !input.principal.has(event.organizer.email) &&
    !guests.some((g) => g.identity === `email:${event.organizer?.email}`)
  )
    guests.push(personFact(`email:${event.organizer.email}`, null, input, null, true));
  const text = normalized(`${event.summary ?? ''}\n${event.description ?? ''}`);
  const named = input.people
    .filter(
      (person) =>
        !input.principalNames.some((n) => normalized(n) === normalized(person.name)) &&
        !person.identities.some((i) => i.startsWith('email:') && input.principal.has(i.slice(6))) &&
        !guests.some((g) => g.personId === person.id) &&
        [
          person.name,
          ...(input.people.filter(
            (p) => normalized(p.name.split(/\s+/u)[0]) === normalized(person.name.split(/\s+/u)[0]),
          ).length === 1
            ? [person.name.split(/\s+/u)[0]]
            : []),
          ...person.identities.map((i) => i.slice(i.indexOf(':') + 1)),
        ].some((n) => {
          const key = normalized(n);
          let at = text.indexOf(key);
          while (at >= 0) {
            const before = text[at - 1] ?? ' ';
            const after = text[at + key.length] ?? ' ';
            if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
            at = text.indexOf(key, at + 1);
          }
          return false;
        }),
    )
    .map((p) => personFact(p.identities[0] ?? p.id, p.name, input));
  return { onlyPrincipal: guests.length + named.length === 0, guests, named, linked: [] };
}
function factVersion(event: DetailedEvent, principal: PrincipalRecognizer): string {
  return digest([
    event.start,
    event.end,
    event.summary,
    event.location,
    event.description,
    event.organizer,
    event.creator,
    event.tags,
    event.attendees?.map((a) => [a.email, a.resource]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    principalAnswer(event, principal),
  ]);
}
function comparable(copy: EventCopy): string {
  const e = copy.event;
  return digest([
    timeKey(e.start),
    timeKey(e.end),
    e.summary,
    e.location,
    e.description,
    (e.attendees ?? []).map((a) => a.email).sort(),
  ]);
}
function eventFrom(copies: readonly EventCopy[], input: WeekInput): WeekEvent {
  const prefixes = input.preferences.ignored_events?.map((p) => p.prefix) ?? [];
  const active = copies.filter((c) => !prefixes.some((p) => c.event.id?.startsWith(p)));
  const copy = [...active].sort(
    (a, b) =>
      Number(b.owner === 'principal') - Number(a.owner === 'principal') ||
      a.calendarId.localeCompare(b.calendarId) ||
      (a.event.id ?? '').localeCompare(b.event.id ?? ''),
  )[0];
  const event = copy.event;
  const startInstant = Date.parse(event.start?.dateTime ?? '');
  if (event.start?.date === undefined && !Number.isFinite(startInstant))
    throw new Error('A calendar detail event has no readable time span');
  const initialZone = event.start?.date
    ? zoneForDay(input.timeline, event.start.date)
    : zoneAt(input.timeline, startInstant);
  const span = eventSpan(event, initialZone ?? event.start?.timeZone ?? 'UTC');
  if (!span || !Number.isFinite(span.start) || span.end <= span.start)
    throw new Error('A calendar detail event has no readable positive time span');
  const where = whereaboutsAt(input.timeline, span.start);
  const zone = where.zone;
  const day = event.start?.date ?? dateString(wallClock(span.start, zone ?? 'UTC'));
  const lastDay = event.start?.date ? dateString(wallClock(span.end - 1, initialZone ?? 'UTC')) : day;
  const id = event.id ?? digest([copy.calendarId, event]);
  const principalOrganizes =
    input.principal.has(event.organizer?.email) || (copy.owner === 'principal' && event.organizer?.self === true);
  return {
    ...span,
    key: `${copy.calendarId}/${id}`,
    id,
    calendarId: copy.calendarId,
    version: factVersion(event, input.principal),
    event,
    copies,
    copiesDisagree: new Set(active.map(comparable)).size > 1,
    day,
    lastDay,
    zone,
    workingHoursZone: where.workingHoursZone,
    allDay: event.start?.date !== undefined,
    busy:
      (copy.owner === 'principal' ||
        principalOrganizes ||
        (event.attendees ?? []).some((a) => isPrincipalAttendee(a, input.principal))) &&
      blocksTime(event, input.principal),
    place: resolvePlace(event.location, input.timeline, input.privateValues),
    assistantWritten:
      copy.assistantWritten === true ||
      (copy.owner === 'assistant' && event.creator?.self === true) ||
      event.tags?.[WEEK_TAGS.assistantWritten] === 'true',
    principalRole: principalOrganizes
      ? 'organizer'
      : copy.owner === 'principal' || (event.attendees ?? []).some((a) => isPrincipalAttendee(a, input.principal))
        ? 'guest'
        : 'neither',
    ownerOrganizes:
      copy.owner === 'principal'
        ? principalOrganizes
        : event.organizer?.self === true || event.organizer?.email === copy.calendarId,
    involvement: involvement(event, input),
  };
}
function linked(block: WeekEvent, parent: WeekEvent): boolean {
  const tags = block.event.tags;
  return (
    tags?.[WEEK_TAGS.parentEvent] === parent.id &&
    (!tags[WEEK_TAGS.parentCalendar] || tags[WEEK_TAGS.parentCalendar] === parent.calendarId)
  );
}
export function linkedBlocks(events: readonly WeekEvent[], parent: WeekEvent, kind?: string): WeekEvent[] {
  return events.filter(
    (e) => linked(e, parent) && (kind === undefined || e.event.tags?.[WEEK_TAGS.blockKind] === kind) && e.busy,
  );
}
function movesFor(events: readonly WeekEvent[], input: WeekInput): Move[] {
  const result: Move[] = [];
  let previous: WeekEvent | undefined;
  for (const event of events.filter(
    (e) =>
      e.busy &&
      !e.allDay &&
      (e.place.kind === 'known' || e.place.kind === 'unknown') &&
      !e.event.tags?.[WEEK_TAGS.blockKind],
  )) {
    const where = whereaboutsAt(input.timeline, event.start);
    const eventDate = wallClock(event.start, event.zone ?? 'UTC');
    const homeZone = input.timeline.homeZone;
    const rhythm =
      !where.stay && !where.leg && homeZone
        ? input.timeline.rhythm
            .filter(
              (r) =>
                r.weekday === weekdayOf(dateString(eventDate)) &&
                zonedInstant(eventDate, r.end_minute, homeZone) <= event.start,
            )
            .sort((a, b) => b.end_minute - a.end_minute)[0]
        : undefined;
    const rhythmEnd =
      rhythm && input.timeline.homeZone ? zonedInstant(eventDate, rhythm.end_minute, input.timeline.homeZone) : null;
    const saved = input.timeline.places.find((p) => p.id === (rhythm?.place_id ?? where.placeId));
    const from =
      previous && previous.end <= event.start
        ? previous.place
        : saved
          ? resolvePlace(saved.id, input.timeline, input.privateValues)
          : {
              kind: 'unknown' as const,
              id: null,
              label: where.locality ?? 'home not set',
              locality: where.locality,
              home: where.stay === null,
            };
    if (from.id === null || from.id !== event.place.id) {
      const travel = travelBetween(from, event.place, event.id, input.timeline);
      const lower = previous?.end ?? rhythmEnd ?? Number.NEGATIVE_INFINITY;
      const minutes = travel.minutes;
      const reserved =
        minutes !== null &&
        linkedBlocks(events, event, 'travel').some(
          (b) => b.start >= lower && b.end <= event.start && b.end - b.start >= minutes * 60000,
        );
      result.push({
        from,
        to: event.place,
        eventKey: event.key,
        previousEventKey: previous?.key ?? null,
        availableMinutes: Number.isFinite(lower) ? Math.max(0, (event.start - lower) / 60000) : null,
        ...travel,
        reserved,
      });
    }
    previous = event;
  }
  return result;
}
/** One caller supplies one timeline and native store snapshots; no clock or IO is read here. */
export function buildWeek(input: WeekInput): Week {
  const count = input.dayCount ?? 8;
  if (!Number.isInteger(count) || count < 1) throw new Error('A week needs a positive whole day count');
  const first = dateString(wallClock(input.now, zoneAt(input.timeline, input.now) ?? 'UTC'));
  const dates: string[] = [];
  let cursor = parseDate(first);
  for (let i = 0; i < count; i++) {
    dates.push(dateString(cursor));
    cursor = nextDate(cursor);
  }
  const groups = new Map<string, EventCopy[]>();
  const ignored: EventCopy[] = [];
  const prefixes = input.preferences.ignored_events?.map((p) => p.prefix) ?? [];
  for (const copy of input.events) {
    if (copy.event.status === 'cancelled') continue;
    if (prefixes.some((p) => copy.event.id?.startsWith(p))) {
      ignored.push(copy);
      continue;
    }
    const key = originalKey(copy);
    groups.set(key, [...(groups.get(key) ?? []), copy]);
  }
  for (const copy of ignored) {
    const matches = [...groups.values()].filter(
      (copies) =>
        timeKey(copies[0].event.start) === timeKey(copy.event.start) &&
        timeKey(copies[0].event.end) === timeKey(copy.event.end),
    );
    if (matches.length === 1) matches[0].push(copy);
  }
  const windows = dates.map((date) => {
    const zone = zoneForDay(input.timeline, date) ?? 'UTC';
    return { start: boundary(date, zone, 'start'), end: boundary(date, zone, 'end') };
  });
  const events = [...groups.values()]
    .map((c) => eventFrom(c, input))
    .filter((e) =>
      e.allDay
        ? e.day <= dates[dates.length - 1] && e.lastDay >= dates[0]
        : windows.some((window) => e.start < window.end && e.end > window.start),
    )
    .sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  const matters: WeekMatter[] = input.matters
    .filter((m) => m.matter.open)
    .map(({ matter, checkInAt }) => {
      const due = matter.due_at ? (resolveMatterDueAt(matter.due_at, input.timeline)?.instant ?? null) : null;
      const checkIn = checkInAt ? Date.parse(checkInAt) : null;
      const day =
        matter.due_at && /^\d{4}-\d{2}-\d{2}$/u.test(matter.due_at)
          ? matter.due_at
          : due === null
            ? checkIn === null
              ? null
              : dateString(wallClock(checkIn, zoneAt(input.timeline, checkIn) ?? 'UTC'))
            : dateString(wallClock(due, zoneAt(input.timeline, due) ?? 'UTC'));
      const linked = matter.links
        .filter((l) => l.kind === 'person')
        .map((l) => {
          const p = input.people.find((p) => p.id === l.reference);
          return personFact(p?.identities[0] ?? l.reference, p?.name ?? null, input);
        });
      return {
        id: matter.id,
        matter,
        due,
        day,
        checkIn,
        involvement: { onlyPrincipal: linked.length === 0, guests: [], named: [], linked },
      };
    });
  const days = dates.map((date) => {
    const zone = zoneForDay(input.timeline, date);
    const start = zonedInstant(parseDate(date), 0, zone ?? 'UTC');
    const where = whereaboutsAt(input.timeline, start);
    const onDay = events.filter((e) => (e.allDay ? e.day <= date && date <= e.lastDay : e.day === date));
    return {
      date,
      weekday: weekdayOf(date),
      zone,
      locality: where.locality,
      events: onDay,
      matters: matters.filter(
        (m) =>
          m.day === date ||
          (m.checkIn !== null && dateString(wallClock(m.checkIn, zoneAt(input.timeline, m.checkIn) ?? 'UTC')) === date),
      ),
      moves: movesFor(onDay, input),
    };
  });
  return {
    cancelledEventKeys: input.events
      .filter((copy) => copy.event.status === 'cancelled' && copy.event.id !== undefined)
      .map((copy) => `${copy.calendarId}/${copy.event.id}`),
    deletedBlocks: input.deletedBlocks ?? [],
    principalAddresses: input.principal.listed,
    now: input.now,
    timeline: input.timeline,
    preferences: input.preferences,
    events,
    matters: matters.filter((m) => days.some((d) => d.matters.includes(m))),
    undatedMatters: matters.filter((m) => m.day === null && m.matter.needs_minutes !== null),
    days,
    homeUnknown: input.timeline.base.home_place_id === null,
  };
}

function presentedPerson(person: InvolvedPerson) {
  return {
    ...person,
    identity: calendarText(person.identity),
    name: person.name === null ? null : calendarText(person.name),
  };
}
function presentedEvent(e: WeekEvent) {
  const event = e.event;
  return {
    key: e.key,
    id: e.id,
    calendarId: e.calendarId,
    day: e.day,
    lastDay: e.lastDay,
    zone: e.zone,
    start: e.zone ? zonedIso(e.start, e.zone) : new Date(e.start).toISOString(),
    end: e.zone ? zonedIso(e.end, e.zone) : new Date(e.end).toISOString(),
    allDay: e.allDay,
    busy: e.busy,
    title: calendarText(event.summary ?? '(untitled)'),
    description: event.description ? calendarText(event.description, 2000) : null,
    location: event.location ? calendarText(event.location) : null,
    conference: event.conference
      ? {
          status: event.conference.status,
          entryPoints: event.conference.entryPoints.map((point) => ({
            type: point.entryPointType,
            uri: calendarText(point.uri),
            label: point.label ? calendarText(point.label) : null,
          })),
        }
      : null,
    creator: event.creator
      ? {
          email: event.creator.email ? calendarText(event.creator.email) : null,
          name: event.creator.displayName ? calendarText(event.creator.displayName) : null,
        }
      : null,
    organizer: event.organizer?.email ? calendarText(event.organizer.email) : null,
    principalRole: e.principalRole,
    ownerOrganizes: e.ownerOrganizes,
    involvement: {
      onlyPrincipal: e.involvement.onlyPrincipal,
      guests: e.involvement.guests.map(presentedPerson),
      named: e.involvement.named.map(presentedPerson),
    },
  };
}
/** The only model-facing serialization of a Week; never spread its host-only event/copy objects. */
export function presentWeek(week: Week) {
  const matter = (m: WeekMatter) => ({
    id: m.id,
    title: m.matter.title,
    openLoop: m.matter.open_loop,
    due: m.matter.due_at,
    needsMinutes: m.matter.needs_minutes,
    place: m.matter.place,
    checkIn: m.checkIn,
    deferrals: m.matter.deferrals,
    involvement: m.involvement.linked.map(presentedPerson),
  });
  const rules = schedulingRules(week.preferences);
  const clockRange = (weekday: Weekday) => {
    const range = rules.workingHours.get(weekday);
    return range ? { start: minuteClock(range.start), end: minuteClock(range.end) } : null;
  };
  const minuteClock = (value: number) =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return {
    meetingLengths: week.preferences.meeting_lengths,
    days: week.days.map((d) => ({
      date: d.date,
      zone: d.zone,
      locality: d.locality === null ? null : calendarText(d.locality),
      workingHoursZone: d.zone
        ? whereaboutsAt(week.timeline, zonedInstant(parseDate(d.date), 0, d.zone)).workingHoursZone
        : null,
      workingHours: clockRange(d.weekday),
      workingHoursDefault: week.preferences.working_hours.length === 0,
      keptTime: week.preferences.protected_windows
        .filter((p) => p.weekdays.includes(d.weekday))
        .map((p) => ({ start: p.start, end: p.end })),
      events: d.events.map(presentedEvent),
      matters: d.matters.map(matter),
      moves: d.moves.map((m) => ({
        ...m,
        from: {
          ...m.from,
          label: calendarText(m.from.label),
          locality: m.from.locality === null ? null : calendarText(m.from.locality),
        },
        to: {
          ...m.to,
          label: calendarText(m.to.label),
          locality: m.to.locality === null ? null : calendarText(m.to.locality),
        },
      })),
    })),
    undatedMatters: week.undatedMatters.map(matter),
    homeUnknown: week.homeUnknown,
  };
}
