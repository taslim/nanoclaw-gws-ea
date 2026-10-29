import { createHash } from 'node:crypto';

import { log } from '../../../log.js';
import { getMainAgentGroupId, getGwsEaProfile, principalRecognizer } from '../../gws-ea-profile/db.js';
import { writeNoteForMain, type NotePiece } from '../../gws-ea-profile/main-note.js';
import {
  isPrincipalCalendar,
  isReadable,
  onOwnCalendarChange,
  type CalendarChange,
} from '../../gws-ea-inbox/calendar-notifications.js';
import { untrustedLine } from '../../gws-ea-inbox/untrusted.js';
import { onManualChange } from '../../gws-ea-manual/changes.js';
import { loadManualSections } from '../../gws-ea-manual/front-page.js';
import { onWhereaboutsChange } from '../../gws-ea-whereabouts/changes.js';
import { boundary, dateString, nextDate, parseDate, wallClock } from '../../gws-ea-whereabouts/clock.js';
import { syncDerivedStays, type DerivationWindow } from '../../gws-ea-whereabouts/db.js';
import { deriveLegs } from '../../gws-ea-whereabouts/derive.js';
import { loadTimeline, zoneAt, zoneForDay, type Timeline } from '../../gws-ea-whereabouts/timeline.js';
import type { CalendarEntry, MeetingsCalendarApi } from '../calendar-api.js';
import { boundedCalendarMessage, loadCalendarWeek, renderDays } from '../days.js';
import { checkWeek, presentFinding } from './checker.js';
import { digest, inWindow, spanOf, type EventCopy, type Week } from './model.js';
import { settleCalendarChanges, settledCalendarChanges, type PendingCalendarChange } from './pending-changes.js';
import { appliedCalendarWrites, calendarWriteVersion } from './write-log.js';
import { renderWeekView, writeWeekView } from './view.js';

const DAY = 86_400_000;
const INTERVAL = 5_000;
/** After a failed cycle, as long as the booking sweep waits between its runs. */
const RETRY_INTERVAL = 60_000;
const BUSY_REFRESH = 15 * 60_000;
function dayAfter(day: string, count: number): string {
  let date = parseDate(day);
  for (let i = 0; i < count; i++) date = nextDate(date);
  return dateString(date);
}
function windowFor(day: string, count: number, timeline: Timeline): DerivationWindow {
  const last = dayAfter(day, count - 1);
  return {
    start: boundary(day, zoneForDay(timeline, day) ?? 'UTC', 'start'),
    end: boundary(last, zoneForDay(timeline, last) ?? 'UTC', 'end'),
  };
}
function coalesced(windows: readonly DerivationWindow[]): DerivationWindow[] {
  const result: DerivationWindow[] = [];
  for (const window of [...windows].sort((a, b) => a.start - b.start)) {
    const previous = result[result.length - 1];
    if (previous && window.start <= previous.end)
      result[result.length - 1] = { start: previous.start, end: Math.max(previous.end, window.end) };
    else result.push(window);
  }
  return result;
}

export interface CalendarChangeContext {
  readonly week?: Week;
  readonly timeline?: Timeline;
  /** The copies held before the change, which place the days it left. */
  readonly previous?: readonly EventCopy[];
}

async function changeFacts(
  calendar: MeetingsCalendarApi,
  changes: readonly PendingCalendarChange[],
  at: Date,
  context: CalendarChangeContext,
): Promise<{ readonly text: string; readonly pieces: readonly NotePiece[] }> {
  const changed = (calendarId: string, eventId: string | undefined) =>
    changes.some(({ notice }) => notice.calendarId === calendarId && notice.eventId === eventId);
  const timeline = context.timeline ?? (await loadTimeline());
  const left = (context.previous ?? []).flatMap((copy) =>
    changed(copy.calendarId, copy.event.id) ? (spanOf(copy.event, timeline) ?? []) : [],
  );
  let week = context.week;
  if (!week) {
    const details = await Promise.all(
      changes.map(({ notice }) => calendar.getEventDetail(notice.calendarId, notice.eventId)),
    );
    const spans = [...left, ...details.flatMap((event) => (event && spanOf(event, timeline)) ?? [])];
    const start = spans.length ? Math.min(...spans.map((span) => span.start)) : at.getTime();
    const end = spans.length ? Math.max(...spans.map((span) => span.end)) : start + DAY;
    week = await loadCalendarWeek(calendar, { start, end: Math.max(start + 1, end), timeline });
  }
  const affected = week.events.filter((e) => changed(e.calendarId, e.id));
  // The days the change left and the days it now holds.
  const touched = week.days
    .filter((day) => {
      const zone = day.zone ?? 'UTC';
      const window = { start: boundary(day.date, zone, 'start'), end: boundary(day.date, zone, 'end') };
      return [...left, ...affected].some((span) => inWindow(span, window));
    })
    .map((day) => day.date);
  const findings = checkWeek(week).filter((f) => f.day !== null && touched.includes(f.day));
  return {
    text: boundedCalendarMessage(
      'Calendar facts:',
      [
        ...affected.map((e) => renderDays({ ...week, events: [e] })),
        ...(touched.length
          ? [
              `Findings for ${touched.join(', ')}:`,
              ...(findings.length ? findings.map((f) => presentFinding(f, week)) : ['No findings.']),
            ]
          : []),
      ],
      10_000,
    ),
    pieces: changes.map(({ notice }) => ({
      kind: 'event' as const,
      reference: `${notice.calendarId}/${notice.eventId}`,
      ...(notice.change === 'created'
        ? {
            arrival: {
              from: affected.find((e) => e.calendarId === notice.calendarId && e.id === notice.eventId)?.event.organizer
                ?.email,
            },
          }
        : {}),
    })),
  };
}

export async function flushPendingCalendarChanges(
  calendar: MeetingsCalendarApi,
  at: Date = new Date(),
  context: CalendarChangeContext = {},
): Promise<number> {
  const changes = await settledCalendarChanges(at);
  if (!changes.length) return 0;
  const words: Readonly<Record<CalendarChange, string>> = {
    created: 'created',
    changed: 'changed',
    cancelled: 'cancelled',
    response: 'guest response',
    unknown: 'changed',
  };
  const lines = changes.map(
    ({ notice }) =>
      `- Event ${notice.eventId} on calendar ${untrustedLine(notice.calendarId, 254, 'google_calendar')}: ${words[notice.change]}.`,
  );
  let facts: { readonly text: string; readonly pieces?: readonly NotePiece[] } = { text: 'findings unavailable' };
  /* eslint-disable no-catch-all/no-catch-all -- durable notices deliver even when their findings cannot render */
  try {
    facts = await changeFacts(calendar, changes, at, context);
  } catch (error) {
    log.warn('Calendar notice delivered without findings', { error });
  }
  /* eslint-enable no-catch-all/no-catch-all */
  const head = `Google Calendar reports ${changes.length === 1 ? 'a change' : `${changes.length} changes`}:`;
  const body = [head];
  let length = head.length;
  const entries = [...lines, facts.text];
  for (const line of entries) {
    if (length + line.length + 42 > 12_000) break;
    body.push(line);
    length += 1 + line.length;
  }
  if (body.length - 1 < entries.length) body.push(`${entries.length - body.length + 1} more.`);
  const key = createHash('sha256')
    .update(
      changes
        .flatMap((c) => c.messageIds)
        .sort()
        .join('\n'),
    )
    .digest('hex');
  const result = await writeNoteForMain({
    id: `inbox-calendar-${key}`,
    timestamp: at.toISOString(),
    wake: true,
    text: body.join('\n'),
    pieces:
      facts.pieces ??
      changes.map(({ notice }) => ({ kind: 'event', reference: `${notice.calendarId}/${notice.eventId}` })),
  });
  if (result === 'no-main' || result === 'no-principal') return 0;
  await settleCalendarChanges(changes);
  return changes.length;
}

/** Its own timer and single flight keep a slow Google read outside the matters loop and every message path. */
export function createWeekRefresher(deps: { readonly calendar: () => MeetingsCalendarApi; readonly now?: () => Date }) {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let flight: Promise<void> | undefined;
  let again = false;
  let forceFull = false;
  let placementChanged = false;
  let renderChanged = false;
  let copies: readonly EventCopy[] | undefined;
  let calendars: readonly CalendarEntry[] = [];
  let fullDay: string | undefined;
  let lastReadAt: string | undefined;
  let lastFullAt = 0;
  let writeVersion: string | undefined;
  let publishedVersion: string | undefined;
  const knownWrites = new Set<string>();
  // The assistant's own writes, whose notices no longer arrive. A cycle that fails rereads every day anyway.
  const ownChanges = new Map<string, { readonly calendarId: string; readonly eventId: string }>();
  const unsubscribe: (() => void)[] = [];
  const now = deps.now ?? (() => new Date());

  async function publish(events: readonly EventCopy[], timeline: Timeline, at: Date, asOf: string) {
    const today = dateString(wallClock(at.getTime(), zoneAt(timeline, at.getTime()) ?? 'UTC'));
    const week = await loadCalendarWeek(deps.calendar(), {
      ...windowFor(today, 8, timeline),
      timeline,
      eventSnapshot: events,
    });
    const manual = await loadManualSections(timeline);
    const view = renderWeekView(week, asOf, manual);
    await writeWeekView(view, view.version === publishedVersion);
    publishedVersion = view.version;
    return week;
  }

  async function readWindow(window: DerivationWindow): Promise<EventCopy[]> {
    const values: EventCopy[] = [];
    for (const calendar of calendars) {
      const start = new Date(window.start).toISOString();
      const end = new Date(window.end).toISOString();
      if (isReadable(calendar)) {
        values.push(
          ...(await deps.calendar().listEventDetails(calendar.id, start, end)).map(
            (event): EventCopy => ({ calendarId: calendar.id, owner: 'principal', event }),
          ),
        );
      } else if (calendar.accessRole === 'freeBusyReader') {
        const busy = await deps.calendar().freeBusy([calendar.id], start, end);
        values.push(
          ...(busy[calendar.id] ?? []).map(
            (block): EventCopy => ({
              calendarId: calendar.id,
              owner: 'principal',
              event: {
                id: `busy-${digest(block)}`,
                summary: 'Busy (details unavailable)',
                start: { dateTime: block.start },
                end: { dateTime: block.end },
              },
            }),
          ),
        );
      }
    }
    return values;
  }

  async function cycle(): Promise<void> {
    if (!(await getMainAgentGroupId())) return;
    const at = now();
    const previous = copies;
    let current: CalendarChangeContext = {};
    try {
      current = await read(at);
    } catch (error) {
      // The settled notices are told below even so, and only a full read still sees the days they touched.
      forceFull = true;
      throw error;
    } finally {
      await flushPendingCalendarChanges(deps.calendar(), at, { ...current, previous });
    }
  }

  async function read(at: Date): Promise<CalendarChangeContext> {
    let timeline = await loadTimeline();
    const today = dateString(wallClock(at.getTime(), zoneAt(timeline, at.getTime()) ?? 'UTC'));
    const full =
      forceFull ||
      copies === undefined ||
      fullDay !== today ||
      (calendars.some((calendar) => calendar.accessRole === 'freeBusyReader') &&
        at.getTime() - lastFullAt >= BUSY_REFRESH);
    if ((placementChanged || renderChanged) && copies && lastReadAt) await publish(copies, timeline, at, lastReadAt);
    renderChanged = false;
    const changes = await settledCalendarChanges(at);
    const version = await calendarWriteVersion();
    const writes = version !== writeVersion ? await appliedCalendarWrites() : [];
    const own = [...ownChanges.values()];
    ownChanges.clear();
    const windows: DerivationWindow[] = [];
    const affected = (bounds: DerivationWindow | undefined) => {
      if (!bounds || !Number.isFinite(bounds.start) || !Number.isFinite(bounds.end) || bounds.end < bounds.start)
        return;
      const lastInstant = Math.max(bounds.start, bounds.end - 1);
      const first = dateString(wallClock(bounds.start, zoneAt(timeline, bounds.start) ?? 'UTC'));
      const last = dateString(wallClock(lastInstant, zoneAt(timeline, lastInstant) ?? 'UTC'));
      windows.push(windowFor(first, Math.round((Date.parse(last) - Date.parse(first)) / DAY) + 1, timeline));
    };
    if (full) {
      const profile = await getGwsEaProfile();
      const principal = principalRecognizer(profile.principal_emails);
      calendars = (await deps.calendar().listCalendars()).filter((calendar) =>
        isPrincipalCalendar(calendar, principal),
      );
      if (!calendars.length) throw new Error('No principal calendars are available to refresh');
      windows.push(windowFor(today, 60, timeline));
    } else {
      for (const { calendarId, eventId } of [...changes.map(({ notice }) => notice), ...own]) {
        const calendar = calendars.find((entry) => entry.id === calendarId);
        if (!calendar || !isReadable(calendar)) continue;
        const held = copies?.find((copy) => copy.calendarId === calendarId && copy.event.id === eventId)?.event;
        affected(held && spanOf(held, timeline));
        for (const leg of timeline.legs.filter((leg) => leg.sourceEventId === eventId))
          affected({ start: leg.departure, end: leg.arrival });
        const current = await deps.calendar().getEventDetail(calendarId, eventId);
        affected(current && spanOf(current, timeline));
      }
      for (const write of writes)
        if (!knownWrites.has(write.requestId)) {
          if (write.refreshScope === 'series') windows.push(windowFor(today, 60, timeline));
          affected(write.before ? spanOf(write.before, timeline) : undefined);
          affected({ start: Date.parse(write.affectedStart), end: Date.parse(write.affectedEnd) });
          if (calendars.some((calendar) => calendar.id === write.calendarId && isReadable(calendar))) {
            const current = await deps.calendar().getEventDetail(write.calendarId, write.eventId);
            affected(current && spanOf(current, timeline));
          }
        }
      if (placementChanged) windows.push(windowFor(today, 8, timeline));
    }
    let updated = [...(copies ?? [])];
    const reads = coalesced(windows);
    for (const window of reads) {
      const events = await readWindow(window);
      updated = [
        ...updated.filter((copy) => {
          const bounds = spanOf(copy.event, timeline);
          return bounds !== undefined && !inWindow(bounds, window);
        }),
        ...events,
      ];
    }
    placementChanged = false;
    if (full)
      updated = updated.filter((copy) => {
        const bounds = spanOf(copy.event, timeline);
        return bounds !== undefined && inWindow(bounds, windows[0]);
      });
    if (reads.length) {
      const principal = principalRecognizer((await getGwsEaProfile()).principal_emails);
      const sourceWeek = await loadCalendarWeek(deps.calendar(), {
        start: Math.min(...reads.map((window) => window.start)),
        end: Math.max(...reads.map((window) => window.end)),
        timeline,
        eventSnapshot: updated,
      });
      const legs = deriveLegs(
        sourceWeek.events.map((event) => ({
          ...event.event,
          id: event.id,
          principalDeclined: event.event.attendees?.some(
            (attendee) => principal.has(attendee.email) && attendee.responseStatus === 'declined',
          ),
        })),
      );
      for (const window of reads)
        await syncDerivedStays(
          legs.filter((leg) => leg.departure < window.end && leg.arrival > window.start),
          window,
        );
      timeline = await loadTimeline();
    }
    const currentDay = dateString(wallClock(at.getTime(), zoneAt(timeline, at.getTime()) ?? 'UTC'));
    const asOf = reads.length ? at.toISOString() : (lastReadAt ?? at.toISOString());
    const week = await publish(updated, timeline, at, asOf);
    copies = updated;
    lastReadAt = asOf;
    if (full) {
      forceFull = false;
      fullDay = currentDay;
      lastFullAt = at.getTime();
    }
    for (const write of writes) knownWrites.add(write.requestId);
    writeVersion = version;
    const noteWeek = reads.length
      ? await loadCalendarWeek(deps.calendar(), {
          start: Math.min(week.now, ...reads.map((window) => window.start)),
          end: Math.max(windowFor(currentDay, 8, timeline).end, ...reads.map((window) => window.end)),
          timeline,
          eventSnapshot: updated,
        })
      : week;
    return { week: noteWeek, timeline };
  }

  function refresh(options: { readonly placementChanged?: boolean; readonly render?: boolean } = {}): Promise<void> {
    placementChanged ||= options.placementChanged === true;
    renderChanged ||= options.render === true;
    if (flight) {
      if (options.placementChanged || options.render) again = true;
      return flight;
    }
    flight = (async () => {
      do {
        again = false;
        await cycle();
      } while (again);
    })().finally(() => {
      flight = undefined;
    });
    return flight;
  }
  function schedule(delay = INTERVAL): void {
    if (!running) return;
    timer = setTimeout(() => {
      void refresh().then(
        () => schedule(),
        (error: unknown) => {
          log.warn('Coming-days refresh failed; the previous view remains', { error });
          schedule(RETRY_INTERVAL);
        },
      );
    }, delay);
    timer.unref();
  }
  return {
    refresh,
    async start(): Promise<void> {
      if (running) return;
      running = true;
      unsubscribe.push(
        onOwnCalendarChange((calendarId, eventId) => {
          ownChanges.set(`${calendarId}\0${eventId}`, { calendarId, eventId });
        }),
        // A saved Manual or whereabouts edit answers at once; its view follows on its own.
        onManualChange(() => {
          void refresh({ render: true }).catch((error: unknown) =>
            log.warn('The Manual was saved; its calendar reread is unavailable', { error }),
          );
        }),
        onWhereaboutsChange((change) => {
          if (change.kind !== 'derived')
            void refresh({
              render: true,
              placementChanged:
                change.kind === 'stay' ||
                change.kind === 'base' ||
                change.kind === 'rhythm' ||
                change.kind === 'place' ||
                change.kind === 'dismissal',
            }).catch((error: unknown) =>
              log.warn('The whereabouts edit was saved; its calendar reread is unavailable', { error }),
            );
        }),
      );
      await refresh().then(
        () => schedule(),
        (error: unknown) => {
          schedule(RETRY_INTERVAL);
          throw error;
        },
      );
    },
    async stop(): Promise<void> {
      running = false;
      clearTimeout(timer);
      for (const remove of unsubscribe.splice(0)) remove();
      await flight;
    },
  };
}
