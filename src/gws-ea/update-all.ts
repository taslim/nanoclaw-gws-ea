/**
 * `update --all`: `update --id` for every assistant on this machine that can
 * move to the tool's release, one at a time, in the order `list` shows them.
 *
 * Before anything runs, each assistant is checked as `update --id` checks it,
 * in its order, lock-free and read-only as `list` reads: a removal under way,
 * an unfinished update or rollback, an unfinished create, the release
 * resolution itself (on its own track, forward, keeping its OneCLI, Postgres,
 * and provider setup), and a running service. One that cannot move is
 * skipped and reported, with the command that moves it; each other one then
 * takes its turn through `update --id`'s own path, which checks everything
 * again under its lock. A recorded update's follow-ups are finished before
 * anything else, as `update --id` finishes them, even at the tool's release.
 *
 * A declined preview skips that assistant. A failure, another command
 * holding the assistant, or the operator cancelling its prompt stops the run
 * there, leaving the rest unattempted; a cancel exits 0, as `update --id`'s
 * does.
 */
import { errorCode } from '../community-portal/errors.js';
import { resolveToolCommit } from './checkout.js';
import { assertInstanceCreated } from './journal.js';
import { CONTROL_PLANE_ROOT, type ControlPlanePaths } from './paths.js';
import { safeErrorMessage } from './redact.js';
import { getInstanceReservation } from './registry.js';
import { resolveReleaseTarget, type ToolProviderSetup } from './release-target.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import { listAssistants, type ListedAssistant } from './status.js';
import { GwsEaError, sameRelease, shortCommit, type ReleaseCoordinates } from './types.js';
import { resolveUpdateIntent, type UpdatedAssistant, type UpdateSeams } from './update.js';

/** What `update --all` checks the assistants with. */
export interface UpdateAllContext {
  readonly paths: ControlPlanePaths;
  readonly serviceHelpers: NanoclawServiceHelpers;
  readonly providerSetup: ToolProviderSetup;
  readonly seams: UpdateSeams;
}

/** One registered assistant: it takes its turn, or it is skipped for `reason`. */
export type UpdateCandidate =
  | { readonly instanceId: string; readonly eligible: true }
  | { readonly instanceId: string; readonly eligible: false; readonly reason: string };

export interface UpdateAllPlan {
  /** The tool's own commit: the release every turn deploys. */
  readonly toolCommit: string;
  /** Every registered assistant, in `list` order. */
  readonly candidates: readonly UpdateCandidate[];
}

/** How one assistant's `update --id` path ended when it did not fail. */
export type AssistantUpdate =
  | { readonly kind: 'updated'; readonly updated: UpdatedAssistant }
  /** Its recorded update to the release it would deploy only had follow-ups left, and they finished. */
  | { readonly kind: 'completed'; readonly release: ReleaseCoordinates; readonly notes: readonly string[] }
  | { readonly kind: 'declined' }
  /** The operator cancelled its preview's prompt (Ctrl-C, Esc): changed as little as a decline, but the run stops. */
  | { readonly kind: 'cancelled' };

/** How one assistant's turn ended: its update's end, a failure, or another command holding it. */
export type UpdateTurn = AssistantUpdate | { readonly kind: 'failed' } | { readonly kind: 'busy' };

/** A turn the run goes on after. */
type EndedUpdate = Exclude<AssistantUpdate, { readonly kind: 'cancelled' }>;

/** The run's stop summary; its outcome is the exit code's. */
export interface UpdateAllSummary {
  readonly outcome: 'ready' | 'failed' | 'busy';
  readonly headline: string;
  readonly details: readonly string[];
}

function releaseName(release: ReleaseCoordinates): string {
  return `${release.release_track} ${shortCommit(release.deployed_commit)}`;
}

/** Why an assistant's service keeps it from an update, which proves its release on a running host; none when it runs. */
function serviceRefusal({ instance_id: id, service }: ListedAssistant): string | undefined {
  switch (service.state) {
    case 'running':
      return undefined;
    case 'stopped':
      return `It is stopped, and an update proves its new release on a running assistant; start it with gws-ea start --id ${id}, then update it.`;
    case 'not_installed':
      return `No NanoClaw service is installed for it; gws-ea resume --id ${id} installs it.`;
    case 'unmanaged':
      return `${service.reason ?? 'Its host runs outside its service.'} Stop that process and start it with gws-ea start --id ${id}, then update it.`;
    case 'unknown':
      return `Its service could not be observed: ${service.reason ?? 'unknown'}`;
  }
}

/** Why the assistant's update or rollback record keeps it from an update, naming what moves it on. */
function operationRefusal({ operation }: ListedAssistant): string | undefined {
  switch (operation.state) {
    case 'none':
    case 'recorded':
      return undefined;
    case 'open': {
      const revert = operation.revert_with ? `, or revert it with ${operation.revert_with}` : '';
      return `Its ${operation.kind} to ${releaseName(operation.to)} is unfinished (${operation.phase}); continue it with ${operation.continue_with}${revert}.`;
    }
    case 'unreadable':
      return `Its update or rollback record cannot be read: ${operation.message}`;
  }
}

/**
 * Whether `update --id` would take this assistant forward, decided as it
 * decides, in its order. Its own refusals are reported with their own
 * message; anything else is not an answer, so it is thrown, naming the
 * assistant, and nothing runs.
 */
async function classify(context: UpdateAllContext, listed: ListedAssistant): Promise<UpdateCandidate> {
  const { paths, seams } = context;
  const instanceId = listed.instance_id;
  const skip = (reason: string): UpdateCandidate => ({ instanceId, eligible: false, reason });
  if (listed.removal_in_progress) {
    return skip(`Its removal is in progress; finish it with gws-ea remove --id ${instanceId}.`);
  }
  const unfinished = operationRefusal(listed);
  if (unfinished) return skip(unfinished);
  try {
    await assertInstanceCreated(paths, instanceId);
    const intent = await resolveUpdateIntent(paths, { instanceId }, seams);
    // `update --id` finishes a recorded operation's follow-ups first, and is done when it recorded this release.
    if (listed.operation.state === 'recorded' && sameRelease(listed.operation.to, intent.target)) {
      return { instanceId, eligible: true };
    }
    const reservation = await getInstanceReservation(paths, instanceId);
    if (reservation.deployed_commit === intent.target.deployed_commit) {
      return skip(`It already runs ${releaseName(intent.target)}, this tool's release.`);
    }
    await resolveReleaseTarget(
      {
        track: intent.track,
        source: intent.source,
        update: { paths, reservation, providerSetup: context.providerSetup },
      },
      {
        ...(seams.runCommand ? { runCommand: seams.runCommand } : {}),
        ...(seams.toolRoot ? { toolRoot: seams.toolRoot } : {}),
      },
    );
  } catch (error) {
    if (error instanceof GwsEaError) return skip(safeErrorMessage(error));
    // Only its code is shown: an unexpected error's message may carry a secret.
    throw new GwsEaError(
      'update_check_failed',
      `Could not tell whether assistant ${instanceId} can be updated (${errorCode(error, 'unexpected')}); gws-ea status --id ${instanceId} shows its state. Nothing was updated.`,
      { cause: error },
    );
  }
  const stopped = serviceRefusal(listed);
  return stopped ? skip(stopped) : { instanceId, eligible: true };
}

/**
 * Every registered assistant in `list` order, each eligible or skipped with
 * why. The tool's own commit is resolved once first: a tool that cannot
 * deploy stops the run before any assistant is checked.
 */
export async function planUpdateAll(context: UpdateAllContext): Promise<UpdateAllPlan> {
  const { paths, seams } = context;
  const toolCommit = await resolveToolCommit(
    seams.toolRoot ?? CONTROL_PLANE_ROOT,
    seams.runCommand ? { runCommand: seams.runCommand } : {},
  );
  const { assistants } = await listAssistants({
    paths,
    serviceHelpers: context.serviceHelpers,
    ...(seams.toolRoot ? { toolRoot: seams.toolRoot } : {}),
    ...(seams.runCommand ? { observers: { runCommand: seams.runCommand } } : {}),
    ...(seams.service?.platform ? { platform: seams.service.platform } : {}),
    ...(seams.service?.uid === undefined ? {} : { uid: seams.service.uid }),
  });
  // One at a time: each resolution fetches its track, which may ask for credentials.
  const candidates: UpdateCandidate[] = [];
  for (const listed of assistants) candidates.push(await classify(context, listed));
  return { toolCommit, candidates };
}

function skippedLines(candidates: readonly UpdateCandidate[]): string[] {
  return candidates.flatMap((candidate) =>
    candidate.eligible ? [] : [`Skipped ${candidate.instanceId}: ${candidate.reason}`],
  );
}

/** One line per assistant whose turn ended, by how it ended. */
function endedLines(ended: ReadonlyMap<string, EndedUpdate>): Record<EndedUpdate['kind'], string[]> {
  const lines: Record<EndedUpdate['kind'], string[]> = { updated: [], completed: [], declined: [] };
  for (const [id, update] of ended) {
    switch (update.kind) {
      case 'updated':
        lines.updated.push(`Updated ${id}: ${releaseName(update.updated.from)} → ${releaseName(update.updated.to)}`);
        break;
      case 'completed':
        lines.completed.push(`Completed ${id}'s update to ${releaseName(update.release)}: its follow-ups are done`);
        break;
      case 'declined':
        lines.declined.push(`Declined ${id}: nothing was changed`);
        break;
    }
  }
  return lines;
}

/** What the run did and skipped: each assistant's line, updated first, skipped last. */
function outcomeLines(ended: ReadonlyMap<string, EndedUpdate>, skipped: readonly string[]): string[] {
  const { updated, completed, declined } = endedLines(ended);
  return [...updated, ...completed, ...declined, ...skipped];
}

/** How many assistants ended each way, naming only the ways some did. */
function counted(ended: ReadonlyMap<string, EndedUpdate>, skipped: number): string {
  const { updated, completed, declined } = endedLines(ended);
  return (
    [
      [updated.length, 'updated'],
      [completed.length, 'completed'],
      [declined.length, 'declined'],
      [skipped, 'skipped'],
    ] as const
  )
    .filter(([number]) => number > 0)
    .map(([number, label]) => `${number} ${label}`)
    .join(', ');
}

/** How the run reads when a turn stopped it: its outcome and headline, and the line naming where. */
function stopOf(
  turn: Exclude<UpdateTurn, EndedUpdate>,
  instanceId: string,
  unattempted: string,
): Pick<UpdateAllSummary, 'outcome' | 'headline'> & { readonly where: string } {
  const told = `Stopped at ${instanceId}; its summary above says why and what to run.`;
  switch (turn.kind) {
    case 'failed':
      return {
        outcome: 'failed',
        headline: `update --all stopped at assistant ${instanceId}${unattempted}.`,
        where: told,
      };
    case 'busy':
      return {
        outcome: 'busy',
        headline: `update --all stopped: another command holds assistant ${instanceId}${unattempted}.`,
        where: told,
      };
    case 'cancelled':
      // The operator's choice, as a cancelled `update --id` is: nothing failed.
      return {
        outcome: 'ready',
        headline: `update --all was stopped by the operator at assistant ${instanceId}${unattempted}.`,
        where: `Stopped at ${instanceId} by the operator; nothing of it was changed.`,
      };
  }
}

/**
 * Give each eligible assistant its turn through `updateOne`, in order, and
 * summarize the run. The skipped ones are named first; a failed or busy turn,
 * or one the operator cancelled, stops the run there.
 */
export async function runUpdateAll(
  plan: UpdateAllPlan,
  updateOne: (instanceId: string) => Promise<UpdateTurn>,
  present: (line: string) => void,
): Promise<UpdateAllSummary> {
  const eligible = plan.candidates.flatMap((candidate) => (candidate.eligible ? [candidate.instanceId] : []));
  const skipped = skippedLines(plan.candidates);
  const release = shortCommit(plan.toolCommit);
  if (eligible.length === 0) {
    return {
      outcome: 'ready',
      headline:
        plan.candidates.length === 0
          ? 'Nothing to update: no assistants are registered on this machine.'
          : `Nothing to update: no assistant here can move to this tool's release ${release}.`,
      details: skipped,
    };
  }
  const assistants = eligible.length === 1 ? 'assistant' : `${eligible.length} assistants`;
  present(`Updating ${assistants} to this tool's release ${release}, one at a time: ${eligible.join(', ')}.`);
  for (const line of skipped) present(line);
  const ended = new Map<string, EndedUpdate>();
  for (const [index, instanceId] of eligible.entries()) {
    present(`Updating assistant ${instanceId} (${index + 1} of ${eligible.length})…`);
    const turn = await updateOne(instanceId);
    if (turn.kind === 'failed' || turn.kind === 'busy' || turn.kind === 'cancelled') {
      const rest = eligible.slice(index + 1);
      const { outcome, headline, where } = stopOf(
        turn,
        instanceId,
        rest.length > 0 ? `; ${rest.length} not attempted` : '',
      );
      return {
        outcome,
        headline,
        details: [
          ...outcomeLines(ended, skipped),
          where,
          ...(rest.length > 0 ? [`Not attempted: ${rest.join(', ')}`] : []),
        ],
      };
    }
    ended.set(instanceId, turn);
  }
  return {
    outcome: 'ready',
    headline: `update --all finished: ${counted(ended, skipped.length)}.`,
    details: outcomeLines(ended, skipped),
  };
}
