import { dateString, parseDate, wallClock, zonedInstant } from '../../gws-ea-whereabouts/clock.js';
import { whereaboutsAt } from '../../gws-ea-whereabouts/timeline.js';
import { schedulingRules, fitOf, type Span } from '../slots.js';
import {
  calendarText,
  digest,
  linkedBlocks,
  placeText,
  WEEK_TAGS,
  weekdayOf,
  type Week,
  type WeekEvent,
  type WeekDay,
} from './model.js';

export const FINDING_KINDS = [
  'whereabouts-gap',
  'overlap',
  'travel',
  'travel-unknown',
  'flight-chain',
  'working-hours',
  'protected-time',
  'meal',
  'back-to-back',
  'missing-prep',
  'copy-disagreement',
  'all-day-task',
  'address-in-title',
  'orphaned-block',
  'home-while-away',
  'attendance-missing',
  'matter-unscheduled',
  'matter-overdue-check-in',
  'matter-deferred',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export interface Finding {
  readonly key: string;
  readonly kind: FindingKind;
  readonly version: string;
  readonly day: string | null;
  readonly eventKeys: readonly string[];
  readonly message: string;
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
}
const MINUTE = 60000;
const overlap = (a: Span, b: Span): number => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const clock = (text: string): number => {
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
};
const onDay = (date: string, start: string, end: string, zone: string): Span => ({
  start: zonedInstant(parseDate(date), clock(start), zone),
  end: zonedInstant(parseDate(date), clock(end), zone),
});
function longestGap(window: Span, busy: readonly Span[]): number {
  const intervals = busy.filter((s) => overlap(s, window) > 0).sort((a, b) => a.start - b.start);
  let edge = window.start;
  let gap = 0;
  for (const span of intervals) {
    gap = Math.max(gap, Math.min(window.end, span.start) - edge);
    edge = Math.max(edge, Math.min(window.end, span.end));
  }
  return Math.max(gap, window.end - edge) / MINUTE;
}
const flight = (event: WeekEvent, week: Week): boolean => week.timeline.legs.some((l) => l.sourceEventId === event.id);
function findingVersion(kind: FindingKind, event: WeekEvent): unknown {
  const time = [event.start, event.end, event.zone, event.workingHoursZone, event.busy];
  switch (kind) {
    case 'meal':
    case 'overlap':
    case 'back-to-back':
    case 'working-hours':
    case 'protected-time':
    case 'flight-chain':
      return time;
    case 'travel':
    case 'travel-unknown':
      return [time, event.place];
    case 'missing-prep':
      return [time, event.event.description, event.involvement.guests.map((g) => g.identity)];
    case 'attendance-missing':
      return [
        time,
        event.event.location,
        event.event.conference,
        event.event.description,
        event.involvement.guests.map((g) => g.identity),
      ];
    case 'copy-disagreement':
      return event.copies.map((copy) => [
        copy.calendarId,
        copy.event.start,
        copy.event.end,
        copy.event.summary,
        copy.event.location,
        copy.event.description,
        copy.event.attendees?.map((a) => a.email).sort(),
      ]);
    case 'all-day-task':
      return [time, event.involvement.guests.map((g) => g.identity)];
    case 'address-in-title':
      return [event.event.summary, event.event.location];
    case 'orphaned-block':
      return [time, event.event.tags];
    case 'home-while-away':
      return [time, event.place];
    case 'whereabouts-gap':
    case 'matter-unscheduled':
    case 'matter-overdue-check-in':
    case 'matter-deferred':
      return time;
  }
}

/** Findings report facts; none authorizes any action. */
export function checkWeek(week: Week): Finding[] {
  const findings: Finding[] = [];
  const add = (
    kind: FindingKind,
    day: string | null,
    events: readonly WeekEvent[],
    message: string,
    facts: Finding['facts'] = {},
    anchor?: string,
  ) => {
    const eventKeys = events.map((e) => e.key).sort();
    const key = `${kind}:${anchor ?? (eventKeys.length ? eventKeys.join('|') : (day ?? 'week'))}`;
    findings.push({
      key,
      kind,
      version: digest([
        events
          .map((e): readonly [string, unknown] => [e.key, findingVersion(kind, e)])
          .sort(([a], [b]) => a.localeCompare(b)),
        facts,
      ]),
      day,
      eventKeys,
      message,
      facts,
    });
  };
  const rules = schedulingRules(week.preferences);
  if (week.homeUnknown)
    add('whereabouts-gap', null, [], 'travel unknown: home not set', { timeline: week.timeline.version }, 'home');
  for (const day of week.days) {
    const window = onDay(day.date, '00:00', '24:00', day.zone ?? 'UTC');
    const busy = week.events.filter((e) => e.busy && !e.allDay && overlap(e, window) > 0);
    for (let i = 0; i < busy.length; i++)
      for (let j = i + 1; j < busy.length; j++) {
        const a = busy[i],
          b = busy[j];
        const shared = { start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) };
        const minutes = overlap(shared, window) / MINUTE;
        if (minutes > 0)
          add(
            'overlap',
            day.date,
            [a, b],
            `${minutes} minutes overlap.`,
            { minutes },
            shared.start < window.start || shared.end > window.end
              ? `${day.date}/${[a.key, b.key].sort().join('|')}`
              : undefined,
          );
      }
    for (const move of day.moves) {
      if (week.homeUnknown && (move.from.home || move.to.home)) continue;
      const event = day.events.find((e) => e.key === move.eventKey)!;
      if (move.to.home && whereaboutsAt(week.timeline, event.start).stay) continue;
      if (move.reserved || move.minutes === 0) continue;
      if (move.minutes === null) {
        add('travel-unknown', day.date, [event], 'travel unknown', { place: move.to.label, origin: move.from.label });
      } else {
        const available = move.availableMinutes;
        const fits = available === null || available >= move.minutes;
        add(
          'travel',
          day.date,
          [event],
          `${move.minutes} minutes needed; ${available === null ? 'origin before first event' : `${available} minutes available`}; ${fits ? 'no linked travel time set aside' : 'not enough time between commitments'}.`,
          {
            minutes: move.minutes,
            available_minutes: available,
            source: move.source,
            from: move.from.label,
            to: move.to.label,
          },
        );
      }
    }
    for (const e of day.events) {
      if (e.copiesDisagree)
        add('copy-disagreement', day.date, [e], 'Copies disagree on their time, title, place, notes or guests.');
      if (!e.busy) continue;
      const tags = e.event.tags;
      const blocks = linkedBlocks(week.events, e);
      const windowZone = e.workingHoursZone;
      if (!e.allDay && windowZone) {
        const fit = fitOf(e, rules, windowZone);
        if (fit === 'protected time') add('protected-time', day.date, [e], 'Crosses a recorded protected window.');
        const localDate = dateString(wallClock(e.start, windowZone));
        const working = rules.workingHours.get(weekdayOf(localDate));
        const range = working
          ? {
              start: zonedInstant(parseDate(localDate), working.start, windowZone),
              end: zonedInstant(parseDate(localDate), working.end, windowZone),
            }
          : null;
        if (!range || e.start < range.start || e.end > range.end)
          add(
            'working-hours',
            day.date,
            [e],
            `Outside ${week.preferences.working_hours.length ? 'recorded' : 'default window for'} working hours.`,
            { zone: windowZone, default_window: week.preferences.working_hours.length === 0 },
          );
      }
      const outside = e.involvement.guests.filter(
        (g) =>
          g.identity.startsWith('email:') &&
          !week.principalAddresses.some((address) => address.split('@')[1] === g.identity.split('@')[1]),
      );
      if (
        outside.length > 0 &&
        !e.event.description?.trim() &&
        !blocks.some((b) => b.event.tags?.[WEEK_TAGS.blockKind] === 'prep' && b.end <= e.start)
      )
        add('missing-prep', day.date, [e], 'Meeting has outside guests, no notes and no prep block.');
      if (
        !e.allDay &&
        e.involvement.guests.length > 0 &&
        !e.event.location?.trim() &&
        !e.event.conference?.uri &&
        !e.event.conference?.entryPoints.length &&
        !/(?:https?:\/\/|\+?\d[\d\s().-]{6,})/iu.test(e.event.description ?? '')
      )
        add('attendance-missing', day.date, [e], 'Event with guests gives no place, meeting link or phone number.');
      if (e.assistantWritten) {
        if (e.allDay && e.involvement.guests.length === 0)
          add('all-day-task', day.date, [e], 'Assistant-created all-day event has no guests; it holds no sized time.');
        if (
          !e.event.location?.trim() &&
          /\b\d{1,6}\s+[\p{L}\d .'-]+\s(?:street|st\.?|avenue|ave\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?)\b/iu.test(
            e.event.summary ?? '',
          )
        )
          add(
            'address-in-title',
            day.date,
            [e],
            'Assistant-written title contains an address but the location field is empty.',
          );
      }
      const where = whereaboutsAt(week.timeline, e.start);
      if (e.place.home && where.stay && where.stay.placeId !== week.timeline.base.home_place_id)
        add('home-while-away', day.date, [e], 'In-person home event while staying elsewhere.', {
          stay: where.stay.locality,
        });
      if (tags?.[WEEK_TAGS.parentEvent]) {
        const parent = week.events.find(
          (p) =>
            p.id === tags[WEEK_TAGS.parentEvent] &&
            (!tags[WEEK_TAGS.parentCalendar] || p.calendarId === tags[WEEK_TAGS.parentCalendar]),
        );
        const observed = tags[WEEK_TAGS.parentStart];
        if (!parent || !parent.busy || (observed && Date.parse(observed) !== parent.start))
          add(
            'orphaned-block',
            day.date,
            [e],
            parent
              ? 'Linked event moved or was cancelled.'
              : week.cancelledEventKeys.some(
                    (key) => key === `${tags[WEEK_TAGS.parentCalendar] ?? e.calendarId}/${tags[WEEK_TAGS.parentEvent]}`,
                  )
                ? 'Linked event was cancelled.'
                : 'Linked event is absent from the read window.',
            {
              parent: tags[WEEK_TAGS.parentEvent],
              observed_parent_start: parent?.start ?? null,
              expected_parent_start: observed ?? null,
            },
          );
      }
      if (flight(e, week)) {
        const chain = blocks
          .filter((b) => ['travel', 'preflight'].includes(b.event.tags?.[WEEK_TAGS.blockKind] ?? ''))
          .sort((a, b) => a.start - b.start);
        if (chain.some((b, i) => i > 0 && chain[i - 1].end !== b.start))
          add('flight-chain', day.date, [e, ...chain], 'Flight preparation blocks are not contiguous.');
      }
    }
    mealFindings(day, busy, week, add);
    const setting = week.preferences.back_to_back?.[0];
    const limit = setting?.minutes ?? 180;
    const breakMinutes = setting?.break_minutes ?? 5;
    let run: WeekEvent[] = [];
    let end = 0;
    const finish = () => {
      if (run.length > 1 && end - run[0].start > limit * MINUTE)
        add(
          'back-to-back',
          day.date,
          run,
          `Longest back-to-back run: ${(end - run[0].start) / MINUTE} minutes (${setting ? 'recorded limit' : 'default window'} ${limit}; breaks under ${breakMinutes} minutes).`,
          {
            minutes: (end - run[0].start) / MINUTE,
            limit,
            break_minutes: breakMinutes,
            default_window: setting === undefined,
          },
        );
    };
    for (const event of busy) {
      if (run.length && event.start - end >= breakMinutes * MINUTE) {
        finish();
        run = [];
      }
      run.push(event);
      end = Math.max(run.length === 1 ? event.end : end, event.end);
    }
    finish();
  }
  for (const item of week.matters) {
    const m = item.matter;
    const linked = week.events.filter(
      (e) =>
        e.busy &&
        !e.allDay &&
        (e.event.tags?.[WEEK_TAGS.matter] === m.id ||
          m.links.some(
            (l) => l.kind === 'event' && (l.reference === e.key || l.reference === `${e.calendarId}/${e.id}`),
          )),
    );
    const allotted = linked
      .filter((e) => item.due === null || e.end <= item.due)
      .reduce((n, e) => n + (e.end - e.start) / MINUTE, 0);
    if (item.due !== null && m.needs_minutes !== null && allotted < m.needs_minutes) {
      const dueDay = item.day ?? dateString(wallClock(item.due, week.timeline.homeZone ?? 'UTC'));
      const today = week.days[0].date;
      const days = Math.round((Date.parse(`${dueDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
      add(
        'matter-unscheduled',
        item.day,
        [],
        `Matter is due in ${days} days; ${m.needs_minutes} minutes needed, ${allotted} set aside before its deadline.`,
        { matter: m.id, days, needs_minutes: m.needs_minutes, allotted_minutes: allotted },
        m.id,
      );
    }
    if (item.due !== null && item.checkIn !== null && item.checkIn > item.due)
      add(
        'matter-overdue-check-in',
        item.day,
        [],
        'Matter check-in is after its due date.',
        { matter: m.id, due: item.due, check_in: item.checkIn },
        m.id,
      );
    if (m.deferrals >= 3)
      add(
        'matter-deferred',
        item.day,
        [],
        `Matter check-in moved ${m.deferrals} times without an open-loop change.`,
        { matter: m.id, deferrals: m.deferrals, open_loop: m.open_loop },
        m.id,
      );
  }
  return [...new Map(findings.map((f) => [`${f.key}\0${f.version}`, f])).values()].sort(
    (a, b) => (a.day ?? '').localeCompare(b.day ?? '') || a.key.localeCompare(b.key),
  );
}
function mealFindings(
  day: WeekDay,
  busy: readonly WeekEvent[],
  week: Week,
  add: (
    kind: FindingKind,
    day: string | null,
    events: readonly WeekEvent[],
    message: string,
    facts?: Finding['facts'],
    anchor?: string,
  ) => void,
) {
  if (!day.zone) return;
  for (const meal of ['lunch', 'dinner'] as const) {
    const preference = week.preferences.meal_windows?.find((p) => p.meal === meal);
    const days = preference?.weekdays ?? ['mon', 'tue', 'wed', 'thu', 'fri'];
    if (!days.includes(day.weekday)) continue;
    const start = preference?.start ?? (meal === 'lunch' ? '11:30' : '18:00');
    const end = preference?.end ?? (meal === 'lunch' ? '14:00' : '21:00');
    const needed = preference?.minutes ?? 30;
    const window = onDay(day.date, start, end, day.zone);
    const events = busy.filter((e) => overlap(e, window) > 0);
    const longest = longestGap(window, events);
    if (longest < needed)
      add(
        'meal',
        day.date,
        events,
        `${meal}: longest gap ${start} to ${end}: ${longest} minutes; ${needed} minutes needed${preference ? '' : ' (default window)'}.`,
        {
          meal,
          start,
          end,
          longest_gap_minutes: longest,
          needed_minutes: needed,
          default_window: preference === undefined,
        },
        `${day.date}/${meal}`,
      );
  }
}
/** All finding text is host-authored; quoted calendar facts are wrapped here. */
export function presentFinding(finding: Finding, week: Week): string {
  const subjects = finding.eventKeys.flatMap((key) => {
    const e = week.events.find((e) => e.key === key);
    return e ? [calendarText(e.event.summary ?? '(untitled)')] : [];
  });
  const places = ['place', 'origin', 'from', 'to'].flatMap((key) => {
    const value = finding.facts[key];
    return typeof value === 'string' ? [`${key}: ${placeText(value, week.timeline)}`] : [];
  });
  return [finding.message, ...subjects, ...places].join('\n');
}
