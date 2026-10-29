/**
 * A matter as `main` reads it, from one renderer wherever main reads a matter,
 * and the open list placement shows beside a new piece. Every time is in the
 * principal's zone, and every render says when its links were read, so an old
 * one is never taken for the present.
 *
 * Bare data for `main`, never words for the principal.
 */
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { findConversationSessions } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { loadTimeline, zoneAt, type Timeline } from '../gws-ea-whereabouts/timeline.js';
import { dateString, wallClock } from '../gws-ea-whereabouts/clock.js';
import { getTimeAnchor, retimeAnchor } from './anchors.js';
import { matterPlanningLines } from './planning.js';
import { getMatter, type Matter, type OpenMatterSummary } from './db.js';
import { hostSources, loadLens, readLinks, type Lens, type LiveSources } from './live.js';

export interface NextLookView {
  /** When it next comes, ISO. */
  readonly at: string;
  /** Its cron expression, when it repeats. */
  readonly repeats: string | null;
  readonly paused: boolean;
}

/** Undefined when none of `main`'s conversations holds the task still to come. */
export async function readNextLook(taskId: string, timeline: Timeline): Promise<NextLookView | undefined> {
  const mainAgentGroupId = await getMainAgentGroupId();
  if (mainAgentGroupId === null) return undefined;
  for (const session of await findConversationSessions(mainAgentGroupId)) {
    const task = await withExistingMailboxSession(mainAgentGroupId, session.id, (mailbox) => mailbox.getTask(taskId));
    if (task === undefined || task.processAfter === null || (task.status !== 'pending' && task.status !== 'paused')) {
      continue;
    }
    const paused = task.status === 'paused';
    // A pending occurrence whose time has passed is the look being taken now: nothing comes
    // after a one-off, and a repeating look comes back on its next date.
    if (paused || Date.parse(task.processAfter) > Date.now()) {
      return { at: task.processAfter, repeats: task.recurrence, paused };
    }
    if (task.recurrence === null) return undefined;
    const timezone = zoneAt(timeline, Date.now()) ?? TIMEZONE;
    const anchor = await getTimeAnchor(session.id, task.seriesId ?? task.id);
    const runWall = anchor ? wallClock(Date.parse(task.processAfter), anchor.appliedZone) : null;
    const lastLocalRun = runWall
      ? `${dateString(runWall)}T${String(runWall.hour).padStart(2, '0')}:${String(runWall.minute).padStart(2, '0')}:${String(runWall.second).padStart(2, '0')}`
      : null;
    const next = anchor
      ? retimeAnchor({ ...anchor, lastRun: task.processAfter, lastLocalRun }, timeline, Date.now())?.at
      : CronExpressionParser.parse(task.recurrence, { tz: timezone }).next().toISOString();
    return next == null ? undefined : { at: next, repeats: task.recurrence, paused };
  }
  return undefined;
}

function nextLookLine(look: NextLookView | undefined, timezone: string): string {
  if (look === undefined) return 'Next look: none pending.';
  const repeats = look.repeats === null ? '' : `, repeating on "${look.repeats}"`;
  return `Next look: ${formatLocalTime(look.at, timezone)}${repeats}${look.paused ? ', paused' : ''}.`;
}

function strandLine(strand: { readonly id: string; readonly title: string; readonly open: boolean }): string {
  return `- ${strand.id}, ${strand.open ? 'open' : 'closed'}: ${strand.title}`;
}

function projectLines(matter: Matter, project: Matter | undefined): string[] {
  if (project === undefined) return [];
  const others = project.strands.filter((strand) => strand.id !== matter.id);
  return [
    `Project ${project.id}: ${project.title}`,
    'Its open loop:',
    project.open_loop,
    ...(others.length === 0 ? [] : ['Its other strands:', ...others.map(strandLine)]),
  ];
}

export async function principalLens(): Promise<Lens> {
  return loadLens(await loadTimeline());
}

/** `given` is the lens a caller rendering several matters reads once for all of them. */
export async function renderMatter(
  matter: Matter,
  sources: LiveSources = hostSources(),
  given?: Lens,
): Promise<string> {
  const readAt = new Date().toISOString();
  const lens = given ?? (await principalLens());
  const { timezone } = lens;
  const [links, look, project] = await Promise.all([
    readLinks(matter.links, sources, lens),
    matter.open && matter.look_task_id !== null ? readNextLook(matter.look_task_id, lens.timeline) : undefined,
    matter.parent_id === null ? undefined : getMatter(matter.parent_id),
  ]);
  const planning = matterPlanningLines(matter, lens.timeline, timezone);
  const state = matter.open
    ? 'open'
    : `closed ${formatLocalTime(matter.closed_at ?? matter.updated_at, zoneAt(lens.timeline, Date.parse(matter.closed_at ?? matter.updated_at)) ?? timezone)}`;
  return [
    `Matter ${matter.id}, ${state}: ${matter.title}`,
    `Links read ${formatLocalTime(readAt, timezone)}.`,
    'Open loop:',
    matter.open_loop,
    ...planning,
    matter.open
      ? nextLookLine(look, look ? (zoneAt(lens.timeline, Date.parse(look.at)) ?? timezone) : timezone)
      : `Outcome: ${matter.outcome ?? ''}`,
    ...projectLines(matter, project),
    ...(matter.strands.length === 0 ? [] : ['Strands:', ...matter.strands.map(strandLine)]),
    ...(links.length === 0 ? ['Links: none.'] : ['Links:', ...links]),
  ].join('\n');
}

function indented(text: string, indent: string): string[] {
  return text.split('\n').map((line) => `${indent}${line}`);
}

export function renderOpenList(matters: readonly OpenMatterSummary[]): string {
  if (matters.length === 0) return 'Open matters: none.';
  return [
    'Open matters:',
    ...matters.flatMap((matter) => [
      `- ${matter.id}: ${matter.title}`,
      ...indented(matter.open_loop, '  '),
      ...matter.strands.flatMap((strand) => [
        `  - ${strand.id}: ${strand.title}`,
        ...indented(strand.open_loop, '    '),
      ]),
    ]),
  ].join('\n');
}
