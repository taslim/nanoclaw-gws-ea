/**
 * A matter as `main` reads it (KTD5): one renderer for `ncl matters get`, a
 * look, a note about one of its links (KTD11), and placement. Its title and
 * open loop, its next look as its scheduled task holds it (KTD4), for a
 * strand its project's open loop and a line for each other strand (R30), for
 * a project its strands, and each link as its source says it is now
 * (`live.ts`). Every time is in the principal's zone, and every render says
 * when its links were read, so an old one is never taken for the present.
 *
 * Beside it, the open list placement shows (R10): each open matter's title
 * and open loop, strands under their project.
 *
 * Bare data for `main`, never words for the principal (R6).
 */
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { findConversationSessions } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { getMatter, type Matter, type OpenMatterSummary } from './db.js';
import { hostSources, loadLens, readLinks, type LiveSources } from './live.js';

/** The time zone `main` lives in, which its matters are read and written in. */
export async function principalTimezone(): Promise<string> {
  const mainAgentGroupId = await getMainAgentGroupId();
  return mainAgentGroupId === null ? TIMEZONE : resolveGroupTimezone(mainAgentGroupId);
}

/** A matter's next look as its scheduled task holds it now. */
export interface NextLookView {
  /** When it next comes, ISO. */
  readonly at: string;
  /** Its cron expression, when it repeats. */
  readonly repeats: string | null;
  readonly paused: boolean;
}

/**
 * The look task `taskId` names, while it is still to come, from whichever of
 * `main`'s conversations holds it; undefined when none does. The task is the
 * matter's only clock (KTD4).
 */
export async function readNextLook(taskId: string): Promise<NextLookView | undefined> {
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
    const timezone = await resolveGroupTimezone(mainAgentGroupId);
    const next = CronExpressionParser.parse(task.recurrence, { tz: timezone }).next().toISOString();
    return next === null ? undefined : { at: next, repeats: task.recurrence, paused };
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

/** A strand's project: its open loop, and a line for each of its other strands (R30). */
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

/**
 * The matter as it stands now, every link read fresh from its source by the
 * host's own Google clients, or by `sources` when given. A link whose source
 * fails or is late says so; the rest render all the same.
 */
export async function renderMatter(matter: Matter, sources: LiveSources = hostSources()): Promise<string> {
  const readAt = new Date().toISOString();
  const timezone = await principalTimezone();
  const lens = await loadLens(timezone);
  const [links, look, project] = await Promise.all([
    readLinks(matter.links, sources, lens),
    matter.open && matter.look_task_id !== null ? readNextLook(matter.look_task_id) : undefined,
    matter.parent_id === null ? undefined : getMatter(matter.parent_id),
  ]);
  const state = matter.open ? 'open' : `closed ${formatLocalTime(matter.closed_at ?? matter.updated_at, timezone)}`;
  return [
    `Matter ${matter.id}, ${state}: ${matter.title}`,
    `Links read ${formatLocalTime(readAt, timezone)}.`,
    'Open loop:',
    matter.open_loop,
    matter.open ? nextLookLine(look, timezone) : `Outcome: ${matter.outcome ?? ''}`,
    ...projectLines(matter, project),
    ...(matter.strands.length === 0 ? [] : ['Strands:', ...matter.strands.map(strandLine)]),
    ...(links.length === 0 ? ['Links: none.'] : ['Links:', ...links]),
  ].join('\n');
}

function indented(text: string, indent: string): string[] {
  return text.split('\n').map((line) => `${indent}${line}`);
}

/** Every open matter's title and open loop, as `listOpenMatters` orders them, each project's strands under it. */
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
