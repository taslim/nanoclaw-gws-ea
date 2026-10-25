/**
 * `update --all`: `update --id` for every assistant on this machine that can
 * move to the tool's release, one at a time, in the order `list` shows them.
 *
 * Before anything runs, each assistant is checked as `update --id` checks it,
 * lock-free and read-only as `list` reads. One that cannot move is skipped
 * and reported, with the command that moves it; each other one then takes its
 * turn through `update --id`'s own path, which checks everything again under
 * its lock. A committed update's follow-ups are finished before anything
 * else, as `update --id` finishes them, even at the tool's release. The tool's
 * commit is read once, as the run begins, and every check and turn is pinned
 * to it: a turn that finds the tool's checkout moved refuses before it stages
 * anything, so one run never deploys two releases.
 *
 * The plan is confirmed once, or by `--yes`, before anything is staged; the
 * turns then run without asking. A failure, or another command holding the
 * assistant, stops the run there, leaving the rest unattempted. An interrupt
 * leaves the assistant in its turn as an interrupted `update --id` leaves it,
 * and the rest untouched.
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
import { GwsEaError, releaseLine, releaseOf, sameRelease, shortCommit, type ReleaseCoordinates } from './types.js';
import { resolveUpdateIntent, serviceRefusal, type UpdatedAssistant, type UpdateSeams } from './update.js';
import { readCentralMigrations } from './verify.js';

export interface UpdateAllContext {
  readonly paths: ControlPlanePaths;
  readonly serviceHelpers: NanoclawServiceHelpers;
  readonly providerSetup: ToolProviderSetup;
  readonly seams: UpdateSeams;
  /** The central migrations the tool's release applies, in order; its own registry when absent. */
  readonly releaseMigrations?: () => Promise<readonly string[]>;
}

export type PlannedTurn =
  /** `migrations` are those it has not applied; undefined when its database could not be read. */
  | {
      readonly kind: 'update';
      readonly from: ReleaseCoordinates;
      readonly to: ReleaseCoordinates;
      readonly migrations: readonly string[] | undefined;
    }
  /** It already runs `release`, committed by an update whose follow-ups are left. */
  | { readonly kind: 'follow_ups'; readonly release: ReleaseCoordinates };

export type UpdateCandidate =
  | { readonly instanceId: string; readonly eligible: true; readonly turn: PlannedTurn }
  | { readonly instanceId: string; readonly eligible: false; readonly reason: string };

export interface UpdateAllPlan {
  /** The tool's own commit as the run began, which every turn is pinned to. */
  readonly toolCommit: string;
  /** Every registered assistant, in `list` order. */
  readonly candidates: readonly UpdateCandidate[];
}

export type AssistantUpdate =
  | { readonly kind: 'updated'; readonly updated: UpdatedAssistant }
  /** Its recorded update to the release it would deploy only had follow-ups left, and they finished. */
  | { readonly kind: 'completed'; readonly release: ReleaseCoordinates };

export type UpdateTurn =
  | AssistantUpdate
  | { readonly kind: 'failed'; readonly exitCode?: number }
  | { readonly kind: 'busy' };

export type UpdateTargetResult =
  | { readonly instance_id: string; readonly outcome: 'completed'; readonly update: AssistantUpdate }
  | { readonly instance_id: string; readonly outcome: 'skipped'; readonly reason: string }
  | { readonly instance_id: string; readonly outcome: 'failed' | 'busy' | 'unattempted' };

export function initialUpdateTarget(candidate: UpdateCandidate): UpdateTargetResult {
  return candidate.eligible
    ? { instance_id: candidate.instanceId, outcome: 'unattempted' }
    : { instance_id: candidate.instanceId, outcome: 'skipped', reason: candidate.reason };
}

/** `exitCode`, when set, overrides the exit code `outcome` implies. */
export interface UpdateAllSummary {
  readonly outcome: 'ready' | 'failed' | 'busy';
  readonly headline: string;
  readonly details: readonly string[];
  readonly targets: readonly UpdateTargetResult[];
  readonly cancelled?: boolean;
  readonly exitCode?: number;
}

function operationRefusal({ operation }: ListedAssistant): string | undefined {
  switch (operation.state) {
    case 'none':
    case 'committed':
      return undefined;
    case 'open':
    case 'failed':
    case 'unreadable':
      return unfinishedOperation(operation);
  }
}

type IntendedTurn =
  | {
      readonly kind: 'update';
      readonly from: ReleaseCoordinates;
      readonly to: ReleaseCoordinates;
      /** Its `state/` path, whose central database records the migrations it has applied. */
      readonly state: string;
    }
  | { readonly kind: 'follow_ups'; readonly release: ReleaseCoordinates }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Decided as `update --id` decides, in its order. Its own refusals are
 * reported with their own message; anything else is not an answer, so it is
 * thrown, naming the assistant, and nothing runs.
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
    // `update --id` finishes a committed operation's follow-ups first, and is done when it committed this release.
    if (operation.state === 'committed' && sameRelease(operation.to, intent.target)) {
      return { kind: 'follow_ups', release: intent.target };
    }
    const reservation = await getInstanceReservation(paths, instanceId);
    if (reservation.deployed_commit === intent.target.deployed_commit) {
      return { kind: 'refused', reason: `It already runs ${releaseLine(intent.target)}, this tool's release.` };
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
    return {
      kind: 'update',
      from: releaseOf(reservation),
      to: intent.target,
      state: paths.instanceLayout(reservation.instance_id).state,
    };
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
 * In the order the release applies them; undefined when the database cannot
 * be read. Only read: the plan names them, and each turn's dry run on a copy
 * of the database is what its update is held to.
 */
function unappliedMigrations(state: string, release: readonly string[]): readonly string[] | undefined {
  let applied: readonly string[];
  try {
    applied = readCentralMigrations(state);
  } catch (error) {
    if (error instanceof GwsEaError || error instanceof Database.SqliteError) return undefined;
    throw error;
  }
  return release.filter((name) => !applied.includes(name));
}

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
  const { state, reason } = listed.service;
  if (state !== 'running') return skip(serviceRefusal(instanceId, state, reason));
  if (intended.kind === 'follow_ups') return { instanceId, eligible: true, turn: intended };
  const { from, to, state: stateRoot } = intended;
  const migrations = unappliedMigrations(stateRoot, await releaseMigrations());
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
 * The tool's own commit is resolved once, first: a tool that cannot deploy
 * stops the run before any assistant is checked.
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

function migrationsLine(migrations: readonly string[] | undefined): string {
  if (migrations === undefined) return 'unknown (its database could not be read)';
  return migrations.length > 0 ? migrations.join(', ') : 'none';
}

function turnLine(instanceId: string, turn: PlannedTurn): string {
  switch (turn.kind) {
    case 'update':
      return `Update ${instanceId}: ${releaseLine(turn.from)} → ${releaseLine(turn.to)}; database migrations to add: ${migrationsLine(turn.migrations)}`;
    case 'follow_ups':
      return `Finish ${instanceId}'s update to ${releaseLine(turn.release)}: only its follow-ups are left`;
  }
}

function planLines(candidates: readonly UpdateCandidate[]): string[] {
  const turns = candidates.flatMap((candidate) =>
    candidate.eligible ? [turnLine(candidate.instanceId, candidate.turn)] : [],
  );
  return [...turns, ...skippedLines(candidates)];
}

function endedLines(ended: ReadonlyMap<string, AssistantUpdate>): Record<AssistantUpdate['kind'], string[]> {
  const lines: Record<AssistantUpdate['kind'], string[]> = { updated: [], completed: [] };
  for (const [id, update] of ended) {
    switch (update.kind) {
      case 'updated':
        lines.updated.push(`Updated ${id}: ${releaseLine(update.updated.from)} → ${releaseLine(update.updated.to)}`);
        break;
      case 'completed':
        lines.completed.push(`Completed ${id}'s update to ${releaseLine(update.release)}: its follow-ups are done`);
        break;
    }
  }
  return lines;
}

function outcomeLines(ended: ReadonlyMap<string, AssistantUpdate>, skipped: readonly string[]): string[] {
  const { updated, completed } = endedLines(ended);
  return [...updated, ...completed, ...skipped];
}

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
 * `confirm` is asked once, before any turn, and not at all when nothing can
 * move; a failed or busy turn stops the run there.
 */
export async function runUpdateAll(
  plan: UpdateAllPlan,
  confirm: (plan: UpdateAllPlan) => Promise<boolean>,
  updateOne: (instanceId: string, toolCommit: string) => Promise<UpdateTurn>,
  present: {
    readonly preview: (headline: string, details: readonly string[]) => void;
    readonly progress: (line: string) => void;
  },
): Promise<UpdateAllSummary> {
  const eligible = plan.candidates.flatMap((candidate) => (candidate.eligible ? [candidate.instanceId] : []));
  const skipped = skippedLines(plan.candidates);
  const release = shortCommit(plan.toolCommit);
  const targets = new Map<string, UpdateTargetResult>(
    plan.candidates.map((candidate) => [candidate.instanceId, initialUpdateTarget(candidate)]),
  );
  const results = (): UpdateTargetResult[] => plan.candidates.map((candidate) => targets.get(candidate.instanceId)!);
  if (eligible.length === 0) {
    return {
      outcome: 'ready',
      headline:
        plan.candidates.length === 0
          ? 'Nothing to update: no assistants are registered on this machine.'
          : `Nothing to update: no assistant here can move to this tool's release ${release}.`,
      details: skipped,
      targets: results(),
    };
  }
  const assistants = eligible.length === 1 ? '1 assistant' : `${eligible.length} assistants`;
  present.preview(
    `Plan: update ${assistants} to this tool's release ${release}, one at a time:`,
    planLines(plan.candidates),
  );
  // Asked once, before staging: declining this plan retains no rollout preparation.
  if (!(await confirm(plan))) {
    return {
      outcome: 'ready',
      cancelled: true,
      headline: 'Update cancelled. No assistant was changed.',
      details: [],
      targets: results(),
    };
  }
  const ended = new Map<string, AssistantUpdate>();
  for (const [index, instanceId] of eligible.entries()) {
    present.progress(`Updating assistant ${instanceId} (${index + 1} of ${eligible.length})…`);
    const turn = await updateOne(instanceId, plan.toolCommit);
    if (turn.kind === 'failed' || turn.kind === 'busy') {
      targets.set(instanceId, { instance_id: instanceId, outcome: turn.kind });
      const rest = eligible.slice(index + 1);
      return {
        ...stopOf(turn, instanceId, rest.length > 0 ? `; ${rest.length} not attempted` : ''),
        targets: results(),
        exitCode: turn.kind === 'busy' ? 75 : (turn.exitCode ?? 1),
        details: [
          ...outcomeLines(ended, skipped),
          `Stopped at ${instanceId}; its summary above says why and what to run.`,
          ...(rest.length > 0 ? [`Not attempted: ${rest.join(', ')}`] : []),
        ],
      };
    }
    ended.set(instanceId, turn);
    targets.set(instanceId, { instance_id: instanceId, outcome: 'completed', update: turn });
  }
  return {
    outcome: 'ready',
    headline: `update --all finished: ${counted(ended, skipped.length)}.`,
    details: outcomeLines(ended, skipped),
    targets: results(),
  };
}
