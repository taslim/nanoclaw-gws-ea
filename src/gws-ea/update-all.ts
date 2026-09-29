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
 * anything else, as `update --id` finishes them, even at the tool's release;
 * they run through the assistant's host, so a stopped one is skipped first.
 * The tool's commit is read once, as the run begins, and every check and
 * turn is pinned to it: a turn that finds the tool's checkout moved refuses
 * before it stages anything, so one run never deploys two releases.
 *
 * The plan is shown before anything is staged: each assistant that moves,
 * from and to, with the database migrations of the release it has not
 * applied, then each one skipped and why. It is confirmed once, or by
 * `--yes`; a no changes nothing. The turns then run without asking. A
 * failure, or another command holding the assistant, stops the run there,
 * leaving the rest unattempted. An interrupt ends the run as it ends any
 * command: the assistant in its turn is left as an interrupted `update --id`
 * leaves it, which `gws-ea update --id` continues, and the rest untouched.
 */
import Database from 'better-sqlite3';

import { errorCode } from '../community-portal/errors.js';
import { resolveToolCommit } from './checkout.js';
import { assertInstanceCreated } from './journal.js';
import { CONTROL_PLANE_ROOT, type ControlPlanePaths } from './paths.js';
import { safeErrorMessage } from './redact.js';
import { getInstanceReservation } from './registry.js';
import { resolveReleaseTarget, type ToolProviderSetup } from './release-target.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import { listAssistants, unfinishedOperation, type ListedAssistant } from './status.js';
import { GwsEaError, releaseOf, sameRelease, shortCommit, type ReleaseCoordinates } from './types.js';
import { resolveUpdateIntent, type UpdatedAssistant, type UpdateSeams } from './update.js';
import { readCentralMigrations } from './verify.js';

/** What `update --all` checks the assistants with. */
export interface UpdateAllContext {
  readonly paths: ControlPlanePaths;
  readonly serviceHelpers: NanoclawServiceHelpers;
  readonly providerSetup: ToolProviderSetup;
  readonly seams: UpdateSeams;
  /** The central migrations the tool's release applies, in order; its own registry when absent. */
  readonly releaseMigrations?: () => Promise<readonly string[]>;
}

/** What an assistant's turn does, as its plan shows it. */
export type PlannedTurn =
  /** It moves `from` → `to`, adding `migrations` to its database; undefined when its database could not be read. */
  | {
      readonly kind: 'update';
      readonly from: ReleaseCoordinates;
      readonly to: ReleaseCoordinates;
      readonly migrations: readonly string[] | undefined;
    }
  /** It already runs `release`, recorded by an update whose follow-ups are left. */
  | { readonly kind: 'follow_ups'; readonly release: ReleaseCoordinates };

/** One registered assistant: it takes `turn`, or it is skipped for `reason`. */
export type UpdateCandidate =
  | { readonly instanceId: string; readonly eligible: true; readonly turn: PlannedTurn }
  | { readonly instanceId: string; readonly eligible: false; readonly reason: string };

export interface UpdateAllPlan {
  /** The tool's own commit as the run began: the release every turn deploys, or refuses to move from. */
  readonly toolCommit: string;
  /** Every registered assistant, in `list` order. */
  readonly candidates: readonly UpdateCandidate[];
}

/** How one assistant's `update --id` path ended when it did not fail. */
export type AssistantUpdate =
  | { readonly kind: 'updated'; readonly updated: UpdatedAssistant }
  /** Its recorded update to the release it would deploy only had follow-ups left, and they finished. */
  | { readonly kind: 'completed'; readonly release: ReleaseCoordinates; readonly notes: readonly string[] };

/** How one assistant's turn ended: its update's end, a failure, or another command holding it. */
export type UpdateTurn = AssistantUpdate | { readonly kind: 'failed' } | { readonly kind: 'busy' };

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

/** Why the assistant's update or rollback record keeps it from an update, naming what moves it on, as `status` does. */
function operationRefusal({ operation }: ListedAssistant): string | undefined {
  switch (operation.state) {
    case 'none':
    case 'recorded':
      return undefined;
    case 'open':
    case 'unreadable':
      return unfinishedOperation(operation);
  }
}

/** What `update --id` would do with an assistant, as far as its release decides: its turn, or why it has none. */
type IntendedTurn =
  | {
      readonly kind: 'update';
      readonly from: ReleaseCoordinates;
      readonly to: ReleaseCoordinates;
      /** Its live checkout, whose central database names the migrations it has applied. */
      readonly checkout: string;
    }
  | { readonly kind: 'follow_ups'; readonly release: ReleaseCoordinates }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Whether `update --id` would take this assistant forward, decided as it
 * decides, in its order. Its own refusals are reported with their own
 * message; anything else is not an answer, so it is thrown, naming the
 * assistant, and nothing runs.
 */
async function intendedTurn(
  context: UpdateAllContext,
  instanceId: string,
  operation: ListedAssistant['operation'],
  toolCommit: string,
): Promise<IntendedTurn> {
  const { paths, seams } = context;
  try {
    await assertInstanceCreated(paths, instanceId);
    const intent = await resolveUpdateIntent(paths, { instanceId, expectedToolCommit: toolCommit }, seams);
    // `update --id` finishes a recorded operation's follow-ups first, and is done when it recorded this release.
    if (operation.state === 'recorded' && sameRelease(operation.to, intent.target)) {
      return { kind: 'follow_ups', release: intent.target };
    }
    const reservation = await getInstanceReservation(paths, instanceId);
    if (reservation.deployed_commit === intent.target.deployed_commit) {
      return { kind: 'refused', reason: `It already runs ${releaseName(intent.target)}, this tool's release.` };
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
    return { kind: 'update', from: releaseOf(reservation), to: intent.target, checkout: reservation.checkout_realpath };
  } catch (error) {
    if (error instanceof GwsEaError) return { kind: 'refused', reason: safeErrorMessage(error) };
    // Only its code is shown: an unexpected error's message may carry a secret.
    throw new GwsEaError(
      'update_check_failed',
      `Could not tell whether assistant ${instanceId} can be updated (${errorCode(error, 'unexpected')}); gws-ea status --id ${instanceId} shows its state. Nothing was updated.`,
      { cause: error },
    );
  }
}

/**
 * The release's migrations the central database under `checkout` has not
 * applied, in the order the release applies them; undefined when that
 * database cannot be read. Only read, never changed: the plan names them,
 * and each turn's dry run on a copy of the database is what its update is
 * held to.
 */
function unappliedMigrations(checkout: string, release: readonly string[]): readonly string[] | undefined {
  let applied: readonly string[];
  try {
    applied = readCentralMigrations(checkout);
  } catch (error) {
    if (error instanceof GwsEaError || error instanceof Database.SqliteError) return undefined;
    throw error;
  }
  return release.filter((name) => !applied.includes(name));
}

/** Whether this assistant takes a turn, and what it does; `releaseMigrations` names the release's, once one moves. */
async function classify(
  context: UpdateAllContext,
  listed: ListedAssistant,
  toolCommit: string,
  releaseMigrations: () => Promise<readonly string[]>,
): Promise<UpdateCandidate> {
  const instanceId = listed.instance_id;
  const skip = (reason: string): UpdateCandidate => ({ instanceId, eligible: false, reason });
  if (listed.removal_in_progress) {
    return skip(`Its removal is in progress; finish it with gws-ea remove --id ${instanceId}.`);
  }
  const unfinished = operationRefusal(listed);
  if (unfinished) return skip(unfinished);
  const intended = await intendedTurn(context, instanceId, listed.operation, toolCommit);
  if (intended.kind === 'refused') return skip(intended.reason);
  // An update proves its release, and a recorded one's follow-ups run, through the assistant's running host.
  const stopped = serviceRefusal(listed);
  if (stopped) return skip(stopped);
  if (intended.kind === 'follow_ups') return { instanceId, eligible: true, turn: intended };
  const { from, to, checkout } = intended;
  const migrations = unappliedMigrations(checkout, await releaseMigrations());
  return { instanceId, eligible: true, turn: { kind: 'update', from, to, migrations } };
}

/**
 * The central migrations this tool's release applies, as its migration
 * script (`scripts/migrate.ts`) registers them: NanoClaw's own, then its
 * modules'. The release is the tree this control plane runs from, so its
 * registry is read in place, only once a plan needs it; nothing is run.
 */
export async function registeredReleaseMigrations(): Promise<readonly string[]> {
  const { getRegisteredMigrations } = await import('../db/migrations/index.js');
  await import('../modules/index.js');
  return getRegisteredMigrations().map((migration) => migration.name);
}

/**
 * Every registered assistant in `list` order, each eligible, with what its
 * turn does, or skipped with why. The tool's own commit is resolved once
 * first: a tool that cannot deploy stops the run before any assistant is
 * checked.
 */
export async function planUpdateAll(context: UpdateAllContext): Promise<UpdateAllPlan> {
  const { paths, seams } = context;
  const toolCommit = await resolveToolCommit(
    seams.toolRoot ?? CONTROL_PLANE_ROOT,
    seams.runCommand ? { runCommand: seams.runCommand } : {},
  );
  // Read once, and only when an assistant moves.
  let registered: Promise<readonly string[]> | undefined;
  const releaseMigrations = (): Promise<readonly string[]> =>
    (registered ??= (context.releaseMigrations ?? registeredReleaseMigrations)());
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
  for (const listed of assistants) candidates.push(await classify(context, listed, toolCommit, releaseMigrations));
  return { toolCommit, candidates };
}

function skippedLines(candidates: readonly UpdateCandidate[]): string[] {
  return candidates.flatMap((candidate) =>
    candidate.eligible ? [] : [`Skipped ${candidate.instanceId}: ${candidate.reason}`],
  );
}

/** The migrations a planned update adds, as its preview names them. */
function migrationsLine(migrations: readonly string[] | undefined): string {
  if (migrations === undefined) return 'unknown (its database could not be read)';
  return migrations.length > 0 ? migrations.join(', ') : 'none';
}

function turnLine(instanceId: string, turn: PlannedTurn): string {
  switch (turn.kind) {
    case 'update':
      return `Update ${instanceId}: ${releaseName(turn.from)} → ${releaseName(turn.to)}; database migrations to add: ${migrationsLine(turn.migrations)}`;
    case 'follow_ups':
      return `Finish ${instanceId}'s update to ${releaseName(turn.release)}: only its follow-ups are left`;
  }
}

/** The plan, one line per assistant: each turn, in order, then each one skipped. */
function planLines(candidates: readonly UpdateCandidate[]): string[] {
  const turns = candidates.flatMap((candidate) =>
    candidate.eligible ? [turnLine(candidate.instanceId, candidate.turn)] : [],
  );
  return [...turns, ...skippedLines(candidates)];
}

/** One line per assistant whose turn ended, by how it ended. */
function endedLines(ended: ReadonlyMap<string, AssistantUpdate>): Record<AssistantUpdate['kind'], string[]> {
  const lines: Record<AssistantUpdate['kind'], string[]> = { updated: [], completed: [] };
  for (const [id, update] of ended) {
    switch (update.kind) {
      case 'updated':
        lines.updated.push(`Updated ${id}: ${releaseName(update.updated.from)} → ${releaseName(update.updated.to)}`);
        break;
      case 'completed':
        lines.completed.push(`Completed ${id}'s update to ${releaseName(update.release)}: its follow-ups are done`);
        break;
    }
  }
  return lines;
}

/** What the run did and skipped: each assistant's line, updated first, skipped last. */
function outcomeLines(ended: ReadonlyMap<string, AssistantUpdate>, skipped: readonly string[]): string[] {
  const { updated, completed } = endedLines(ended);
  return [...updated, ...completed, ...skipped];
}

/** How many assistants ended each way, naming only the ways some did. */
function counted(ended: ReadonlyMap<string, AssistantUpdate>, skipped: number): string {
  const { updated, completed } = endedLines(ended);
  return (
    [
      [updated.length, 'updated'],
      [completed.length, 'completed'],
      [skipped, 'skipped'],
    ] as const
  )
    .filter(([number]) => number > 0)
    .map(([number, label]) => `${number} ${label}`)
    .join(', ');
}

/** How the run reads when a turn stopped it: its outcome and headline. */
function stopOf(
  turn: Exclude<UpdateTurn, AssistantUpdate>,
  instanceId: string,
  unattempted: string,
): Pick<UpdateAllSummary, 'outcome' | 'headline'> {
  switch (turn.kind) {
    case 'failed':
      return { outcome: 'failed', headline: `update --all stopped at assistant ${instanceId}${unattempted}.` };
    case 'busy':
      return {
        outcome: 'busy',
        headline: `update --all stopped: another command holds assistant ${instanceId}${unattempted}.`,
      };
  }
}

/**
 * Show the plan and ask `confirm` about it once, before anything is staged;
 * a no changes nothing. Then give each eligible assistant its turn through
 * `updateOne`, in order, pinned to the plan's tool commit, and summarize the
 * run; a failed or busy turn stops it there. With nothing to update, nothing
 * is asked.
 */
export async function runUpdateAll(
  plan: UpdateAllPlan,
  confirm: (plan: UpdateAllPlan) => Promise<boolean>,
  updateOne: (instanceId: string, toolCommit: string) => Promise<UpdateTurn>,
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
  const assistants = eligible.length === 1 ? '1 assistant' : `${eligible.length} assistants`;
  present(`Plan: update ${assistants} to this tool's release ${release}, one at a time:`);
  for (const line of planLines(plan.candidates)) present(line);
  // Asked once, before anything is staged: a no changes nothing, as a no to `update --id` does.
  if (!(await confirm(plan))) {
    return { outcome: 'ready', headline: 'Update cancelled. Nothing was changed.', details: [] };
  }
  const ended = new Map<string, AssistantUpdate>();
  for (const [index, instanceId] of eligible.entries()) {
    present(`Updating assistant ${instanceId} (${index + 1} of ${eligible.length})…`);
    const turn = await updateOne(instanceId, plan.toolCommit);
    if (turn.kind === 'failed' || turn.kind === 'busy') {
      const rest = eligible.slice(index + 1);
      return {
        ...stopOf(turn, instanceId, rest.length > 0 ? `; ${rest.length} not attempted` : ''),
        details: [
          ...outcomeLines(ended, skipped),
          `Stopped at ${instanceId}; its summary above says why and what to run.`,
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
