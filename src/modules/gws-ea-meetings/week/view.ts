import { AnchoredDir } from '../../../anchored-dir.js';
import { findConversationSessions, getActiveSessions } from '../../../db/sessions.js';
import { sessionDir } from '../../../session-manager.js';
import { getOpenCloseRun } from '../../gws-ea-matters/close-runs.js';
import { getMainAgentGroupId } from '../../gws-ea-profile/db.js';
import type { Timeline } from '../../gws-ea-whereabouts/timeline.js';
import { checkWeek, presentFinding } from './checker.js';
import { digest, presentWeek, type Week } from './model.js';

export const WEEK_VIEW_NAME = 'week-view.json';
const VIEW_CHARACTERS = 8_000;
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
  /** Only what the session's clock reads. */
  readonly timeline: Pick<Timeline, 'homeZone' | 'base' | 'places' | 'rhythm' | 'stays' | 'legs'>;
}

const WRAPPER_ID = /(<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT) id="[0-9a-f]+">>>/gu;
/** Every render wraps untrusted text under fresh random ids, so a version digests the text without them. */
const versionOf = (text: string): string => digest(text.replace(WRAPPER_ID, '$1>>>'));

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
  const days = allDays.map((day, index): ViewDay => {
    const more = day.entries.length - shownEntries[index].length;
    return { ...day, entries: [...shownEntries[index], ...(more ? [entry('more', `+${more} more; use days`)] : [])] };
  });
  const { homeZone, base, places, rhythm, stays, legs } = week.timeline;
  return {
    schema: 1,
    asOf,
    version: digest([
      asOf,
      days.map((day) => [day.date, day.version, day.entries.map((entry) => [entry.id, entry.version])]),
      manual,
      week.timeline.version,
    ]),
    text: days.map((day) => [day.header, ...day.entries.map((entry) => entry.text)].join('\n')).join('\n\n'),
    days,
    manual,
    timeline: { homeZone, base, places, rhythm, stays, legs },
  };
}

/**
 * Publish every conversation, and the evening close while it runs, before the matching change note can wake any
 * of them. A view whose version is unchanged goes only to sessions that have none yet.
 */
export async function writeWeekView(view: WeekView, unchanged = false): Promise<void> {
  const main = await getMainAgentGroupId();
  if (!main) return;
  const bytes = JSON.stringify(view) + '\n';
  const sessions = await findConversationSessions(main);
  for (const session of await getActiveSessions())
    if (session.agent_group_id === main && (await getOpenCloseRun(session.id))) sessions.push(session);
  for (const session of sessions) {
    const dir = AnchoredDir.open(sessionDir(main, session.id), [], true);
    if (!dir) throw new Error('The conversation directory is unavailable');
    try {
      if (!unchanged || !dir.entries().includes(WEEK_VIEW_NAME)) dir.replaceFile(WEEK_VIEW_NAME, bytes);
    } finally {
      dir.close();
    }
  }
}
