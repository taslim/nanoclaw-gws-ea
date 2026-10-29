import { log } from '../../../log.js';
import { getMainAgentGroupId, getGwsEaProfile, principalRecognizer } from '../../gws-ea-profile/db.js';
import {
  flushPendingCalendarChanges,
  isPrincipalCalendar,
  isReadable,
} from '../../gws-ea-inbox/calendar-notifications.js';
import { onManualChange } from '../../gws-ea-manual/changes.js';
import { loadManualFrontPage } from '../../gws-ea-manual/front-page.js';
import { onWhereaboutsChange } from '../../gws-ea-whereabouts/changes.js';
import { boundary, dateString, nextDate, parseDate, wallClock } from '../../gws-ea-whereabouts/clock.js';
import { syncDerivedStays, type DerivationWindow } from '../../gws-ea-whereabouts/db.js';
import { deriveLegs } from '../../gws-ea-whereabouts/derive.js';
import { loadTimeline, zoneAt, zoneForDay, type Timeline } from '../../gws-ea-whereabouts/timeline.js';
import type { CalendarEntry, DetailedEvent, MeetingsCalendarApi } from '../calendar-api.js';
import { loadCalendarWeek } from '../days.js';
import { eventSpan } from '../slots.js';
import { loadAcknowledgements } from './acks.js';
import { digest, type EventCopy } from './model.js';
import { settledCalendarChanges } from './pending-changes.js';
import { appliedCalendarWrites, calendarWriteVersion } from './write-log.js';
import { renderWeekView, writeWeekView } from './view.js';

const DAY = 86_400_000;
const INTERVAL = 5_000;
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
function span(event: DetailedEvent, timeline: Timeline): DerivationWindow | null {
  const instant = Date.parse(event.start?.dateTime ?? '');
  const zone = event.start?.date
    ? zoneForDay(timeline, event.start.date)
    : Number.isFinite(instant)
      ? zoneAt(timeline, instant)
      : null;
  const bounds = eventSpan(event, zone ?? 'UTC');
  return bounds && Number.isFinite(bounds.start) && Number.isFinite(bounds.end) && bounds.end > bounds.start
    ? bounds
    : null;
}
const overlaps = (a: DerivationWindow, b: DerivationWindow) => a.start < b.end && a.end > b.start;
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
  const knownWrites = new Set<string>();
  const unsubscribe: (() => void)[] = [];
  const now = deps.now ?? (() => new Date());

  async function publish(events: readonly EventCopy[], timeline: Timeline, at: Date, asOf: string) {
    const today = dateString(wallClock(at.getTime(), zoneAt(timeline, at.getTime()) ?? 'UTC'));
    const week = await loadCalendarWeek(deps.calendar(), {
      ...windowFor(today, 8, timeline),
      timeline,
      eventSnapshot: events,
    });
    const manual = await loadManualFrontPage(timeline);
    await writeWeekView(renderWeekView(week, await loadAcknowledgements(), asOf, manual));
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
    let timeline = await loadTimeline();
    const at = now();
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
    const windows: DerivationWindow[] = [];
    if (full) {
      const profile = await getGwsEaProfile();
      const principal = principalRecognizer(profile.principal_emails);
      calendars = (await deps.calendar().listCalendars()).filter((calendar) =>
        isPrincipalCalendar(calendar, principal),
      );
      if (!calendars.length) throw new Error('No principal calendars are available to refresh');
      windows.push(windowFor(today, 60, timeline));
    } else {
      const affected = (event: DetailedEvent | undefined) => {
        const bounds = event ? span(event, timeline) : null;
        if (!bounds) return;
        const first = dateString(wallClock(bounds.start, zoneAt(timeline, bounds.start) ?? 'UTC'));
        const last = dateString(wallClock(bounds.end - 1, zoneAt(timeline, bounds.end - 1) ?? 'UTC'));
        windows.push(windowFor(first, Math.round((Date.parse(last) - Date.parse(first)) / DAY) + 1, timeline));
      };
      for (const { notice } of changes) {
        const calendar = calendars.find((entry) => entry.id === notice.calendarId);
        if (!calendar || !isReadable(calendar)) continue;
        affected(
          copies?.find((copy) => copy.calendarId === notice.calendarId && copy.event.id === notice.eventId)?.event,
        );
        for (const leg of timeline.legs.filter((leg) => leg.sourceEventId === notice.eventId))
          affected({
            start: { dateTime: new Date(leg.departure).toISOString() },
            end: { dateTime: new Date(leg.arrival).toISOString() },
          });
        affected(await deps.calendar().getEventDetail(notice.calendarId, notice.eventId));
      }
      for (const write of writes)
        if (!knownWrites.has(write.requestId)) {
          affected(write.before ?? undefined);
          const bounds = { start: { dateTime: write.affectedStart }, end: { dateTime: write.affectedEnd } };
          affected(bounds);
          if (calendars.some((calendar) => calendar.id === write.calendarId && isReadable(calendar)))
            affected(await deps.calendar().getEventDetail(write.calendarId, write.eventId));
        }
      if (placementChanged) windows.push(windowFor(today, 8, timeline));
    }
    let updated = [...(copies ?? [])];
    const reads = coalesced(windows);
    for (const window of reads) {
      const events = await readWindow(window);
      updated = [
        ...updated.filter((copy) => {
          const bounds = span(copy.event, timeline);
          return bounds !== null && !overlaps(bounds, window);
        }),
        ...events,
      ];
    }
    placementChanged = false;
    if (full)
      updated = updated.filter((copy) => {
        const bounds = span(copy.event, timeline);
        return bounds !== null && overlaps(bounds, windows[0]);
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
    await flushPendingCalendarChanges(at, { week: noteWeek, timeline });
  }

  function refresh(
    options: { readonly full?: boolean; readonly placementChanged?: boolean; readonly render?: boolean } = {},
  ): Promise<void> {
    forceFull ||= options.full === true;
    placementChanged ||= options.placementChanged === true;
    renderChanged ||= options.render === true;
    if (flight) {
      if (options.full || options.placementChanged || options.render) again = true;
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
  function schedule(): void {
    if (!running) return;
    timer = setTimeout(() => {
      void refresh()
        .catch((error: unknown) => log.warn('Coming-days refresh failed; the previous view remains', { error }))
        .finally(schedule);
    }, INTERVAL);
    timer.unref();
  }
  return {
    refresh,
    async start(): Promise<void> {
      if (running) return;
      running = true;
      unsubscribe.push(
        onManualChange(() =>
          refresh({ render: true }).catch((error: unknown) =>
            log.warn('The Manual was saved; its calendar reread is unavailable', { error }),
          ),
        ),
        onWhereaboutsChange(async (change) => {
          if (change.kind !== 'derived')
            await refresh({
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
      try {
        await refresh();
      } finally {
        schedule();
      }
    },
    async stop(): Promise<void> {
      running = false;
      clearTimeout(timer);
      for (const remove of unsubscribe.splice(0)) remove();
      await flight;
    },
  };
}
