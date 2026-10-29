import { AnchoredDir } from '../../../anchored-dir.js';
import { findConversationSessions } from '../../../db/sessions.js';
import { sessionDir } from '../../../session-manager.js';
import { getMainAgentGroupId } from '../../gws-ea-profile/db.js';
import type { Timeline } from '../../gws-ea-whereabouts/timeline.js';
import { checkWeek, presentFinding } from './checker.js';
import { calendarText, digest, presentWeek, type Week } from './model.js';

export const WEEK_VIEW_NAME = 'week-view.json';
const VIEW_CHARACTERS = 8_000;
const VIEW_MAX_BYTES = 1_048_576;
export interface ViewEntry {
  readonly id: string;
  readonly text: string;
  readonly version: string;
}
export interface ViewDay {
  readonly date: string;
  readonly header: string;
  readonly version: string;
  readonly entries: readonly ViewEntry[];
}
export interface WeekView {
  readonly schema: 1;
  readonly version: string;
  readonly asOf: string;
  readonly text: string;
  readonly days: readonly ViewDay[];
  /** The Manual's current sections; the hook prints only those its session does not already hold. */
  readonly manual: readonly string[];
  readonly timeline: Timeline;
}

const WRAPPER_ID = /(<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT) id="[0-9a-f]+">>>/gu;
/** Every render wraps untrusted text under fresh random ids, so a version digests the text without them. */
const versionOf = (text: string): string => digest(text.replace(WRAPPER_ID, '$1>>>'));

function presentedTimeline(timeline: Timeline): Timeline {
  return {
    ...timeline,
    stays: timeline.stays.map((stay) => ({
      ...stay,
      locality: stay.sourceEventIds.length ? calendarText(stay.locality) : stay.locality,
    })),
    legs: timeline.legs.map((leg) => ({ ...leg, locality: calendarText(leg.locality) })),
  };
}

export function renderWeekView(week: Week, asOf: string, manual: readonly string[]): WeekView {
  const shown = presentWeek(week);
  const findings = checkWeek(week);
  const entry = (id: string, text: string): ViewEntry => ({ id, text, version: versionOf(text) });
  const allDays = shown.days.slice(0, 8).map((day): ViewDay => {
    const header = `${day.date} — ${day.locality ?? 'place unknown'} (${day.zone ?? 'zone unknown'})\nWorking hours: ${day.workingHours ? `${day.workingHours.start}-${day.workingHours.end}` : 'not working'} (${day.workingHoursZone ?? 'zone unknown'})${day.workingHoursDefault ? '; default hours' : ''}\nKept time: ${day.keptTime.length ? day.keptTime.map((time) => `${time.start}-${time.end}`).join(', ') : 'none recorded'}`;
    return {
      date: day.date,
      header,
      version: versionOf(header),
      entries: [
        ...day.events.map((event) =>
          entry(
            `event:${event.key}`,
            `${event.start} to ${event.end}: ${event.title}${event.location ? `; place: ${event.location}` : ''}; event ${event.id} on calendar ${event.calendarId}`,
          ),
        ),
        ...day.moves.map((move) =>
          entry(
            `move:${move.previousEventKey ?? 'start'}:${move.eventKey}`,
            `Move: ${move.from.label} to ${move.to.label}; ${move.minutes ?? 'unknown'} minutes${move.reserved ? '; time reserved' : '; no reserved time'}`,
          ),
        ),
        ...day.matters.map((matter) =>
          entry(
            `matter:${matter.id}`,
            `Matter ${matter.id}: ${matter.title}${matter.due ? `; due ${matter.due}` : ''}${matter.needsMinutes ? `; needs ${matter.needsMinutes} minutes` : ''}`,
          ),
        ),
        ...findings
          .filter((finding) => finding.day === day.date || (finding.day === null && day === shown.days[0]))
          .map((finding) => entry(`finding:${finding.key}`, `Finding: ${presentFinding(finding, week)}`)),
      ],
    };
  });
  const headers = allDays.map((day) => day.header).join('\n\n');
  let allowance = Math.max(0, VIEW_CHARACTERS - headers.length - 300);
  const shownEntries = allDays.map((): ViewEntry[] => []);
  for (let index = 0; allDays.some((day) => index < day.entries.length); index++)
    for (let day = 0; day < allDays.length; day++) {
      const entry = allDays[day].entries[index];
      if (entry && entry.text.length + 1 <= allowance) {
        shownEntries[day].push(entry);
        allowance -= entry.text.length + 1;
      }
    }
  const text = allDays
    .map((day, index) =>
      [
        day.header,
        ...shownEntries[index].map((entry) => entry.text),
        ...(day.entries.length > shownEntries[index].length
          ? [`+${day.entries.length - shownEntries[index].length} more; use days`]
          : []),
      ].join('\n'),
    )
    .join('\n\n');
  const timeline = presentedTimeline(week.timeline);
  const envelope = (days: readonly ViewDay[], version: string): WeekView => ({
    schema: 1,
    asOf,
    version,
    text,
    days,
    manual,
    timeline,
  });
  const empty = allDays.map((day) => ({ ...day, entries: [] }));
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const footer = (count: number, version: string): ViewEntry => ({ id: 'more', text: `+${count} more`, version });
  const reserved = allDays.reduce((total, day) => total + bytes(footer(day.entries.length, '0'.repeat(64))) + 1, 1);
  let remaining = VIEW_MAX_BYTES - bytes(envelope(empty, '0'.repeat(64))) - reserved;
  if (remaining < 0) throw new Error('The coming-days clock timeline exceeds the bounded view file');
  const selected = allDays.map(() => new Set<number>());
  for (let index = 0; allDays.some((day) => index < day.entries.length); index++)
    for (let day = 0; day < allDays.length; day++) {
      const entry = allDays[day].entries[index];
      if (!entry) continue;
      const size = bytes(entry) + 1;
      if (size <= remaining) {
        selected[day].add(index);
        remaining -= size;
      }
    }
  const days = allDays.map((day, index): ViewDay => {
    const retained = day.entries.filter((_, entry) => selected[index].has(entry));
    const omitted = day.entries.filter((_, entry) => !selected[index].has(entry));
    return {
      ...day,
      entries: [
        ...retained,
        ...(omitted.length ? [footer(omitted.length, digest(omitted.map((entry) => entry.version)))] : []),
      ],
    };
  });
  return envelope(
    days,
    digest([
      asOf,
      days.map((day) => [day.date, day.version, day.entries.map((entry) => [entry.id, entry.version])]),
      manual,
      week.timeline.version,
    ]),
  );
}

/**
 * Publish every conversation before the matching change note can wake any of them. A view whose version is
 * unchanged goes only to sessions that have none yet.
 */
export async function writeWeekView(view: WeekView, unchanged = false): Promise<void> {
  const main = await getMainAgentGroupId();
  if (!main) return;
  const bytes = JSON.stringify(view) + '\n';
  for (const session of await findConversationSessions(main)) {
    const dir = AnchoredDir.open(sessionDir(main, session.id), [], true);
    if (!dir) throw new Error('The conversation directory is unavailable');
    try {
      if (!unchanged || !dir.entries().includes(WEEK_VIEW_NAME)) dir.replaceFile(WEEK_VIEW_NAME, bytes);
    } finally {
      dir.close();
    }
  }
}
