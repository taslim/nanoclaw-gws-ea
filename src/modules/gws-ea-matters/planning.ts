import { boundary, isDate, parseDate } from '../gws-ea-whereabouts/clock.js';
import { zoneAt, zoneForDay, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import { formatLocalTime } from '../../timezone.js';
import type { Matter } from './db.js';

export function parseMatterDueAt(value: string | null): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (isDate(text)) {
    parseDate(text);
    return text;
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(text) || !Number.isFinite(Date.parse(text)))
    throw new Error('A due date is YYYY-MM-DD, or a fixed instant with its UTC offset');
  parseDate(text.slice(0, 10));
  return new Date(text).toISOString();
}

export interface ResolvedMatterDue {
  /** A date is due by the end of that local day, represented as an exclusive boundary. */
  readonly instant: number;
  readonly zone: string | null;
  readonly dateOnly: boolean;
}

export function resolveMatterDueAt(dueAt: string, timeline: Timeline): ResolvedMatterDue | null {
  if (isDate(dueAt)) {
    const zone = zoneForDay(timeline, dueAt);
    return zone === null ? null : { instant: boundary(dueAt, zone, 'end'), zone, dateOnly: true };
  }
  const instant = Date.parse(dueAt);
  return { instant, zone: zoneAt(timeline, instant), dateOnly: false };
}

/** Planning facts stay observations; no deadline or deferral forbids an agent's choice. */
export function matterPlanningLines(
  matter: Pick<Matter, 'due_at' | 'needs_minutes' | 'place' | 'deferrals'>,
  timeline: Timeline | null,
  homeZone: string,
): string[] {
  const lines: string[] = [];
  if (matter.due_at !== null) {
    const due = timeline === null ? null : resolveMatterDueAt(matter.due_at, timeline);
    if (isDate(matter.due_at)) lines.push(`Due: ${matter.due_at} (end of local day; ${due?.zone ?? 'zone unknown'}).`);
    else
      lines.push(
        `Due: ${formatLocalTime(new Date(due?.instant ?? Date.parse(matter.due_at)).toISOString(), due?.zone ?? homeZone)} (fixed moment).`,
      );
  }
  if (matter.needs_minutes !== null) lines.push(`Principal time needed: ${matter.needs_minutes} minutes.`);
  if (matter.place !== null) {
    const saved = timeline?.places.find((place) => place.id === matter.place);
    lines.push(`Place: ${saved ? `${saved.label} (${saved.locality})` : matter.place}.`);
  }
  if (matter.deferrals > 0)
    lines.push(
      `Check-in moved ${matter.deferrals} time${matter.deferrals === 1 ? '' : 's'} without an open-loop change.`,
    );
  return lines;
}
