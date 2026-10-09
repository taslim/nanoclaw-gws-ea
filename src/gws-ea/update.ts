/**
 * `update` (R1, R2, R10, R11). Every refusal comes before anything changes.
 * Then, while the assistant serves, the tool's own release is staged in its
 * own folder as every release is (`stageRelease`, KTD3): materialized,
 * installed, built and preflighted, its agent image tagged `<base>:r-<hex8>`
 * (KTD6), its migrations tried on a copy of the live central database in a
 * scratch `data/` the release holds before its links to the assistant's state
 * are made, and the files it runs with kept, its receipt last. Staging writes
 * nothing into `state/`. The gateway image the release names is built when it
 * differs from the one the assistant runs, and the preview says what the
 * switch will change.
 *
 * Nothing live changes before the operator confirms. A decline or a staging
 * failure writes no record, and the staged release is left for the next
 * update, which reuses it complete or stages it again. Confirming records the
 * update at `staged`; the serving OneCLI runtime is re-verified (KTD15), and
 * only then is the assistant offline: fenced, snapshotted, switched to the
 * release, and started. Main's shared skills are reconciled (KTD16), the
 * release verified and committed through the registry, and its follow-ups
 * run. Each phase is recorded as it completes, so an update cut short
 * anywhere is continued by the next `update --id`; one that fails before it
 * is committed is handed to recovery.
 *
 * An assistant still on the layout before releases is converted by its first
 * update, one way and with no rollback target (`release-convert.ts`, KTD12).
 */
import { lstat, mkdir, readdir, readFile, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { getInstallScopedNames } from '../install-slug.js';
import { readInstallCjkFonts, releaseImageKey, releaseImageTag } from './agent-image-release.js';
import { findSharedAgentImage } from './agent-image.js';
import {
  assertDeploymentCheckoutUnmodified,
  committedTree,
  prepareReleaseCommandEnvironments,
  resolveToolCommit,
  type CheckoutRuntime,
} from './checkout.js';
import {
  assistantImageDocker,
  cutoverOnecli,
  dockerEnvironment,
  fenceInstance,
  finishFollowUps,
  openCutoverHost,
  reconcileMainSkills,
  releaseFollowUps,
  serveLeftRelease,
  startRelease,
  switchTo,
  verifyServingRelease,
  type CutoverDependencies,
  type CutoverHost,
  type CutoverSeams,
} from './cutover.js';
import { runStep } from './events.js';
import { loadCreatedRuntime, type InstanceOperation } from './journal.js';
import { prepareReleaseGatewayImage, type GatewayImageChange } from './onecli.js';
import type { OnecliRuntimeLayout } from './onecli-compose.js';
import {
  advanceOperation,
  assertNotCommitted,
  beginOperation,
  closeOperationFailed,
  commitOperationRelease,
  discardOperation,
  operationNextSteps,
  planFollowUps,
  readOperationRecord,
  recordOperationFacts,
  reservationAt,
  revertClause,
  supersedable,
  targetMayHaveStarted,
  type OperationRecord,
  type SnapshotManifest,
} from './operation.js';
import { CONTROL_PLANE_ROOT, type ControlPlanePaths } from './paths.js';
import { LAUNCHER_PINS } from './pins.js';
import { runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { instanceOnecliLayout, readDeployedSetup } from './provision.js';
import { safeErrorMessage } from './redact.js';
import { getInstanceReservation } from './registry.js';
import { continueConversion, finishConversion, prepareConversion, type ConversionSeams } from './release-convert.js';
import {
  exists,
  fenceEnded,
  isReleaseComplete,
  operationName,
  readCurrent,
  releaseName,
  STATE_ROOTS,
  takeSnapshot,
} from './release-layout.js';
import type { ReleasePreflightRuntime } from './release-preflight.js';
import { stageRelease } from './release-stage.js';
import { resolveReleaseTarget, type ToolProviderSetup, type UpdateReleaseTarget } from './release-target.js';
import { resolveReleaseSource, type ReleaseSource } from './release-tracks.js';
import { describeRollback, localTimezone, revertUpdate } from './rollback.js';
import { readOwnerOnlyJson } from './secrets.js';
import type { InstanceRuntimeConfig } from './service.js';
import { createServiceControl, runtimeServiceTarget } from './service-control.js';
import { instanceServicePlatform } from './service-coordinates.js';
import type { ServiceState } from './status.js';
import {
  GwsEaError,
  releaseLine,
  releaseOf,
  sameRelease,
  shortCommit,
  type GwsEaErrorDetails,
  type InstanceReservation,
  type ReleaseCoordinates,
} from './types.js';
import { isRecord } from './validation.js';
import {
  backupCentralDatabase,
  printableName,
  readCentralMigrations,
  readDerivedImageGroups,
  readSchemaManifest,
  type DerivedImageGroup,
} from './verify.js';

/** The agent-runner lockfile: its dependencies are baked into the base image, not mounted. */
const AGENT_RUNNER_LOCKFILE = 'container/agent-runner/bun.lock';
/**
 * The sources that shape the session databases. Their columns are added only
 * when a host opens each session, so a dry run cannot exercise them (KTD5).
 */
const SESSION_SCHEMA_SOURCES = [
  'src/mailbox/sqlite/schema.ts',
  'src/mailbox/sqlite/session-db.ts',
  'container/agent-runner/src/mailbox/sqlite/connection.ts',
] as const;
/** What the upstream updater keeps free beyond what it copies (`scripts/update/transaction.ts`). */
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;
const MIGRATION_TIMEOUT_MS = 5 * 60_000;
const DOCKER_TIMEOUT_MS = 60_000;
/** What a staged release keeps of its migration dry run, beside its receipt. */
const DRY_RUN_FILE = 'migration-dry-run.json';

export interface UpdateRequest {
  readonly instanceId: string;
  /** `--track`: the assistant's own track unless given. */
  readonly track?: string;
  /** `--source-remote`: the assistant's recorded source remote unless given (KTD4). */
  readonly sourceRemote?: string;
  /**
   * `update --all`'s release: the tool's commit when the run began. A tool
   * checkout that has moved off it since is refused before anything is
   * staged, so one run never deploys two releases. `update --id` pins none.
   */
  readonly expectedToolCommit?: string;
}

/** Boundary seams; each defaults to the real one. */
export interface UpdateSeams extends CutoverSeams, ConversionSeams {
  /** The tool's checkout, whose commit an update deploys; the one this control plane runs from by default. */
  readonly toolRoot?: string;
  /** Runs the staged release's frozen install and its build. */
  readonly runSetupCommand?: ReleasePreflightRuntime['runSetupCommand'];
  /** Bytes free to this user on the filesystem holding `directory`. */
  readonly freeBytes?: (directory: string) => Promise<number>;
}

export interface UpdateDependencies extends CutoverDependencies, UpdateSeams {
  /** The tool's provider setup, which the driver reads from `setup/providers`. */
  readonly providerSetup: ToolProviderSetup;
}

/**
 * The release an update deploys, known before the instance lock is taken, so
 * the gate can tell an unfinished update to this release from one to another.
 */
export interface UpdateIntent {
  readonly instanceId: string;
  readonly track: string;
  readonly source: ReleaseSource;
  readonly target: ReleaseCoordinates;
}

/** What the operator confirms. */
export interface UpdatePreview {
  readonly instanceId: string;
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  /** The central migrations the release adds, in the order they ran on the copy. */
  readonly migrations: readonly string[];
  readonly gateway: GatewayImageChange;
  /** The groups whose own image is rebuilt on the new release's image once it is committed (KTD6). */
  readonly groupImages: readonly DerivedImageGroup[];
  /** Those groups then run the previous agent-runner dependencies until their rebuild finishes. */
  readonly agentRunnerLockChanged: boolean;
  /** The session-schema sources differ, so session columns may change once the new host opens each session. */
  readonly sessionSchemaChanged: boolean;
  /** The update converts an assistant on the layout before releases (KTD12): the root it leaves, and its short root. */
  readonly conversion?: { readonly from: string; readonly to: string };
}

/** A release staged and previewed, not yet recorded. */
export interface StagedUpdate {
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  /** The live schema as staging read it; the dry run left its migrations as they were. */
  readonly manifest: SnapshotManifest;
  readonly preview: UpdatePreview;
}

/** Where the release an update leaves runs from, which staging reads and never writes. */
interface RunningRelease {
  /** The directory holding its `data/`, whose central database the dry run copies. */
  readonly state: string;
  /** Its folder, which the staged release is compared with. */
  readonly release: string;
  /** Its OneCLI project, whose Compose file names the gateway it runs. */
  readonly onecli: OnecliRuntimeLayout;
}

export interface CheckedUpdate {
  readonly reservation: InstanceReservation;
  /** The assistant's runtime, which the staged release's kept files are rendered for. */
  readonly runtime: InstanceRuntimeConfig;
  readonly target: UpdateReleaseTarget;
  readonly serving: RunningRelease;
}

function checkoutRuntime(seams: UpdateSeams): CheckoutRuntime {
  return seams.runCommand ? { runCommand: seams.runCommand } : {};
}

/**
 * The release `update` would deploy: the tool's own commit, on the track the
 * operator names or the assistant's own, from the source remote the operator
 * names or the assistant's recorded one. A request pinned to a commit the
 * tool's checkout has since moved off is refused.
 */
export async function resolveUpdateIntent(
  paths: ControlPlanePaths,
  request: UpdateRequest,
  seams: UpdateSeams = {},
): Promise<UpdateIntent> {
  const reservation = await getInstanceReservation(paths, request.instanceId);
  const track = request.track ?? reservation.release_track;
  const source = resolveReleaseSource(track, request.sourceRemote ?? reservation.source_remote);
  const toolRoot = seams.toolRoot ?? CONTROL_PLANE_ROOT;
  const commit = await resolveToolCommit(toolRoot, checkoutRuntime(seams));
  const expected = request.expectedToolCommit;
  if (expected !== undefined && commit !== expected) {
    throw new GwsEaError(
      'tool_checkout_moved',
      `gws-ea's checkout ${toolRoot} moved from ${shortCommit(expected)} to ${shortCommit(commit)} while update --all ran, ` +
        `so assistant ${request.instanceId} was not updated: one run deploys only the release it started with, ${shortCommit(expected)}. ` +
        `Run gws-ea update --all again to update to ${shortCommit(commit)}.`,
    );
  }
  return {
    instanceId: request.instanceId,
    track,
    source,
    target: { source_remote: source.remote, release_track: track, deployed_commit: commit },
  };
}

/**
 * Why an assistant's service keeps an update from it, naming what fixes it:
 * an update proves its new release on a running host, and stops that host
 * for the switch through its service. `update --id` and `update --all` give
 * the same reason; `reason` is what was observed of an unmanaged host or an
 * unobservable service.
 */
export function serviceRefusal(
  instanceId: string,
  state: Exclude<ServiceState, 'running'>,
  reason: string | null,
): string {
  switch (state) {
    case 'stopped':
      return `It is stopped, and an update proves its new release on a running assistant; start it with gws-ea start --id ${instanceId}, then update it.`;
    case 'not_installed':
      return `No NanoClaw service is installed for it; gws-ea resume --id ${instanceId} installs it.`;
    case 'unmanaged':
      return `${reason ?? 'Its host runs outside its service.'} Stop that process and start it with gws-ea start --id ${instanceId}, then update it.`;
    case 'unknown':
      return `Its service could not be observed: ${reason ?? 'unknown'}`;
  }
}

/** The assistant's service must run its host; `serviceRefusal` says why it does not. */
function assertHostRunning(runtime: InstanceRuntimeConfig, dependencies: UpdateDependencies): void {
  const id = runtime.instance_id;
  const handle = createServiceControl(
    dependencies.serviceHelpers,
    runtimeServiceTarget(runtime),
    dependencies.service,
  ).detect();
  const refused = (code: string, state: Exclude<ServiceState, 'running'>, reason: string | null = null) =>
    new GwsEaError(code, `Assistant ${id} cannot be updated. ${serviceRefusal(id, state, reason)}`);
  if (handle.mode === 'none') throw refused('service_not_installed', 'not_installed');
  if (handle.mode === 'unmanaged') {
    throw refused(
      'service_unmanaged',
      'unmanaged',
      `A NanoClaw host runs from ${runtime.checkout_root} outside its service (PID ${handle.pid ?? handle.name ?? 'unknown'}).`,
    );
  }
  if (!handle.active) throw refused('host_not_running', 'stopped');
}

/** Every byte under `root`, each file counted once however many links it has; links are not followed. */
async function treeBytes(root: string, seen = new Set<string>()): Promise<number> {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0;
    throw error;
  }
  if (info.isFile()) {
    const inode = `${info.dev}:${info.ino}`;
    if (info.nlink > 1 && seen.has(inode)) return 0;
    seen.add(inode);
    return info.size;
  }
  if (!info.isDirectory()) return 0;
  const sizes = await Promise.all((await readdir(root)).map((entry) => treeBytes(path.join(root, entry), seen)));
  return sizes.reduce((total, size) => total + size, 0);
}

async function freeBytesAt(directory: string): Promise<number> {
  const disk = await statfs(directory);
  return Number(disk.bavail) * Number(disk.bsize);
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** The size Docker reports for the agent image the assistant runs, its release's own tag. */
async function agentImageBytes(
  runtime: InstanceRuntimeConfig,
  reservation: InstanceReservation,
  dependencies: UpdateDependencies,
): Promise<number> {
  const base = getInstallScopedNames(runtime.install_id).containerImageBase;
  const { stdout } = await (dependencies.runCommand ?? runSanitizedCommand)({
    command: 'docker',
    args: [
      'image',
      'inspect',
      '--format',
      '{{.Size}}',
      releaseImageTag(base, releaseName(reservation.deployed_commit)),
    ],
    cwd: runtime.instance_root,
    env: dockerEnvironment(runtime, dependencies),
    timeoutMs: DOCKER_TIMEOUT_MS,
  });
  const size = Number(stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new GwsEaError('invalid_child_output', 'Docker reported an invalid agent image size');
  }
  return size;
}

/**
 * Whether the agent image the release would build for this assistant is
 * already built and shared under its content key, read before anything is
 * staged: from the tool's checkout, which is the release (R6), and the
 * assistant's own `INSTALL_CJK_FONTS`, which its build is given.
 */
async function releaseAgentImageShared(
  runtime: InstanceRuntimeConfig,
  target: UpdateReleaseTarget,
  dependencies: UpdateDependencies,
): Promise<boolean> {
  const key = releaseImageKey({
    contextTree: await committedTree(
      dependencies.toolRoot ?? CONTROL_PLANE_ROOT,
      target.release.deployed_commit,
      'container',
      checkoutRuntime(dependencies),
    ),
    installCjkFonts: readInstallCjkFonts(runtime.state_root),
  });
  return (await findSharedAgentImage(assistantImageDocker(runtime, dependencies), key)) !== undefined;
}

/**
 * Room for what the update adds before it can delete anything, mirroring the
 * upstream updater's check (KTD14), measured on the filesystem holding the
 * physical `state/`: the snapshot of `state/` the switch takes; the staged
 * release's install and build, for which the live release's folder stands,
 * unless it is staged already; the dry run's copy of the central database;
 * and a new agent image, unless the release's is already shared under its
 * content key. Where Docker runs in a local VM, its disk is on the same
 * filesystem.
 */
async function assertFreeDisk(
  paths: ControlPlanePaths,
  { reservation, runtime, target }: CheckedUpdate,
  dependencies: UpdateDependencies,
): Promise<void> {
  const layout = paths.instanceLayout(runtime.instance_id);
  const staged = await isReleaseComplete(layout, releaseName(target.release.deployed_commit));
  const shared = await releaseAgentImageShared(runtime, target, dependencies);
  const database = path.join(layout.state, 'data', 'v2.db');
  const [state, release, central, journal, image] = await Promise.all([
    treeBytes(layout.state),
    staged ? 0 : treeBytes(layout.release(releaseName(reservation.deployed_commit))),
    treeBytes(database),
    treeBytes(`${database}-wal`),
    shared ? 0 : agentImageBytes(runtime, reservation, dependencies),
  ]);
  const needed = state + release + central + journal + image + DISK_RESERVE_BYTES;
  const free = await (dependencies.freeBytes ?? freeBytesAt)(layout.state);
  if (free >= needed) return;
  const adds = shared
    ? "the staged release and a snapshot of its state (the release's agent image is already built)"
    : 'the staged release, a snapshot of its state, and a new agent image';
  throw new GwsEaError(
    'insufficient_disk',
    `Updating assistant ${runtime.instance_id} needs about ${gigabytes(needed)} free for ${adds}, and ${gigabytes(free)} is free at ${layout.state}. Free some space, then retry.`,
    { details: { needed, free, agentImageShared: shared } },
  );
}

/**
 * Whether this update supersedes an operation with no release to return to
 * (KTD9, `supersedable`): one closed for fix-forward, or an update with no
 * rollback target, to another release. Such an assistant may be fenced, so
 * its host is not required to serve, and the release it ran is not checked.
 */
async function supersedes(paths: ControlPlanePaths, instanceId: string, target: ReleaseCoordinates): Promise<boolean> {
  const record = await readOperationRecord(paths, instanceId);
  return record !== undefined && supersedable(record, target);
}

/** Every refusal an update makes before it changes anything, under the instance lock. */
async function checkUpdate(
  operation: InstanceOperation,
  intent: UpdateIntent,
  dependencies: UpdateDependencies,
): Promise<CheckedUpdate> {
  const { paths, instanceId } = operation;
  const runtime = await loadCreatedRuntime(paths, instanceId);
  const reservation = await getInstanceReservation(paths, instanceId);
  const target = await resolveReleaseTarget(
    {
      track: intent.track,
      source: intent.source,
      update: { paths, reservation, providerSetup: dependencies.providerSetup },
    },
    { ...checkoutRuntime(dependencies), ...(dependencies.toolRoot ? { toolRoot: dependencies.toolRoot } : {}) },
  );
  if (!sameRelease(target.release, intent.target)) {
    throw new GwsEaError(
      'release_changed',
      `gws-ea moved from ${shortCommit(intent.target.deployed_commit)} to ${shortCommit(target.release.deployed_commit)} while this update started; retry it.`,
    );
  }
  if (!(await supersedes(paths, instanceId, target.release))) {
    assertHostRunning(runtime, dependencies);
    await assertDeploymentCheckoutUnmodified(paths, reservation, checkoutRuntime(dependencies));
  }
  const layout = paths.instanceLayout(instanceId);
  const checked: CheckedUpdate = {
    reservation,
    runtime,
    target,
    serving: {
      state: layout.state,
      release: layout.release(releaseName(reservation.deployed_commit)),
      onecli: instanceOnecliLayout(paths, reservation, runtime.docker_endpoint),
    },
  };
  await assertFreeDisk(paths, checked, dependencies);
  return checked;
}

export interface MigrationDryRun {
  /** The assistant's physical `state/`, whose central database is copied. */
  readonly liveState: string;
  /** The live migrations as staging recorded them; the dry run must leave them so. */
  readonly liveMigrations: readonly string[];
  /** The staged release's folder, before its links to the assistant's state are made. */
  readonly stagedRelease: string;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * Where the dry run may put its copy: the staged release's own `data/`, as a
 * physical directory. What the migration script resolves from its working
 * directory (NanoClaw's `src/config.ts`: `data/v2.db` under it), links
 * followed, must be exactly there, and hold no database yet. Nothing is
 * written before that holds.
 */
async function dryRunDatabase(workingDirectory: string, stagedRelease: string): Promise<string> {
  const expected = path.join(await realpath(path.dirname(stagedRelease)), path.basename(stagedRelease), 'data');
  const data = path.join(workingDirectory, 'data');
  const present = await exists(data);
  const database = path.join(present ? await realpath(data) : data, 'v2.db');
  if (path.dirname(database) !== expected) {
    throw new GwsEaError(
      'unsafe_dry_run',
      `The release's migrations would run against ${database}, outside the staged release's ${expected}; nothing was run.`,
    );
  }
  if (!present) await mkdir(data, { mode: 0o700 });
  if (await exists(database)) {
    throw new GwsEaError(
      'unsafe_dry_run',
      `The staged release already holds a database at ${database}; the dry run copies the live one there itself, so nothing was run.`,
    );
  }
  return database;
}

/**
 * Try a release's own migrations on a copy of the live central database
 * (KTD15): a single-step online backup into the staged release's scratch
 * `data/`, then the release's migration script, run from the release's real
 * path. The live migrations must be as staging recorded them afterwards.
 * Whatever the run made where the release's links go is then removed, so the
 * release holds none of it (KTD3). Returns the migrations the release adds,
 * in the order they ran.
 */
export async function dryRunReleaseMigrations(
  request: MigrationDryRun,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<readonly string[]> {
  const workingDirectory = await realpath(request.stagedRelease);
  const scratch = [];
  for (const root of [...STATE_ROOTS, 'logs']) {
    if (!(await exists(path.join(workingDirectory, root)))) scratch.push(path.join(workingDirectory, root));
  }
  const database = await dryRunDatabase(workingDirectory, request.stagedRelease);
  await backupCentralDatabase(request.liveState, database);
  let failure: GwsEaError | undefined;
  try {
    await run({
      command: 'pnpm',
      args: ['run', 'migrate'],
      cwd: workingDirectory,
      env: environment,
      timeoutMs: MIGRATION_TIMEOUT_MS,
      stream: true,
    });
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    failure = error;
  }
  const live = readCentralMigrations(request.liveState);
  const added = readCentralMigrations(workingDirectory).filter((name) => !request.liveMigrations.includes(name));
  for (const made of scratch) await rm(made, { recursive: true, force: true });
  if (!sameList(live, request.liveMigrations)) {
    throw new GwsEaError(
      'live_schema_changed',
      `The live database's migrations changed while the release's were tried on a copy (${request.liveMigrations.join(', ')} became ${live.join(', ')}); the update stopped before changing anything else.`,
      { ...(failure ? { cause: failure } : {}), details: { staged: request.liveMigrations, live } },
    );
  }
  if (!failure) return added;
  const applied = added.length > 0 ? `after applying ${added.join(', ')}` : 'before applying any';
  throw new GwsEaError(
    'migration_dry_run_failed',
    `The release's database migrations failed on a copy of this assistant's database, ${applied}; the release's own error follows. Nothing live changed.`,
    { cause: failure, details: { ...failure.details, applied: added } },
  );
}

/** What a staged release keeps of its dry run: the live migrations it was tried against, and those it added. */
interface KeptDryRun {
  readonly live: readonly string[];
  readonly added: readonly string[];
}

function dryRunFile(paths: ControlPlanePaths, instanceId: string, release: string): string {
  return path.join(paths.instanceLayout(instanceId).kept(release), DRY_RUN_FILE);
}

function stringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * The dry run a release staged earlier kept. The live migrations only change
 * when a release migrates the state, which prunes this one, so it still
 * speaks for them; one that does not is refused, naming both.
 */
async function keptDryRun(file: string, live: readonly string[]): Promise<readonly string[]> {
  const kept = await readOwnerOnlyJson(file, 'Kept migration dry run', 'invalid_kept_release');
  if (!isRecord(kept) || !stringList(kept.live) || !stringList(kept.added)) {
    throw new GwsEaError('invalid_kept_release', `${file} holds no migration dry run`);
  }
  if (!sameList(kept.live, live)) {
    throw new GwsEaError(
      'live_schema_changed',
      `The staged release's migrations were tried on ${kept.live.join(', ')}, and the live database now has ${live.join(', ')}.`,
      { details: { staged: kept.live, live } },
    );
  }
  return kept.added;
}

async function sameFiles(left: string, right: string, files: readonly string[]): Promise<boolean> {
  const read = (root: string, file: string): Promise<Buffer | undefined> =>
    readFile(path.join(root, file)).then(
      (contents) => contents,
      (error: unknown) => {
        if (isErrno(error, 'ENOENT')) return undefined;
        throw error;
      },
    );
  for (const file of files) {
    const [a, b] = await Promise.all([read(left, file), read(right, file)]);
    if (a === undefined ? b !== undefined : b === undefined || !a.equals(b)) return false;
  }
  return true;
}

/**
 * Stage the checked release while the assistant serves (`stageRelease`),
 * with its migration dry run on the release before its links are made, and
 * the gateway image it names; then preview the switch. A release staged
 * complete by an earlier update is reused with the dry run it kept.
 */
async function stageUpdate(
  operation: InstanceOperation,
  { reservation, runtime, target, serving }: CheckedUpdate,
  dependencies: UpdateDependencies,
): Promise<StagedUpdate> {
  const { paths, instanceId } = operation;
  const reporter = dependencies.reporter ?? {};
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const layout = paths.instanceLayout(instanceId);
  const release = target.release;
  const name = releaseName(release.deployed_commit);
  const onecli = instanceOnecliLayout(paths, reservation, runtime.docker_endpoint);
  const manifest = readSchemaManifest(serving.state);
  const live = manifest.central_migrations;

  const migrations = await runStep(
    reporter,
    { id: 'stage_release', label: 'Preparing the new release beside the running assistant…' },
    async () => {
      let tried: readonly string[] | undefined;
      await stageRelease(
        {
          paths,
          view: reservationAt(reservation, release),
          runtime,
          state: serving.state,
          onecli,
          service: {
            platform: instanceServicePlatform(dependencies.service?.platform),
            homeDirectory: runtime.home_directory,
            runningAsRoot: (dependencies.service?.uid ?? process.getuid?.()) === 0,
          },
          provider: target.preflight,
          beforeLink: async (stagedRelease) => {
            const added = await dryRunReleaseMigrations(
              { liveState: serving.state, liveMigrations: live, stagedRelease },
              run,
              (await prepareReleaseCommandEnvironments(layout.root)).common,
            );
            await writePrivate(dryRunFile(paths, instanceId, name), { live, added } satisfies KeptDryRun);
            tried = added;
          },
        },
        {
          ...checkoutRuntime(dependencies),
          ...(dependencies.runSetupCommand ? { runSetupCommand: dependencies.runSetupCommand } : {}),
          ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
        },
      );
      return tried ?? keptDryRun(dryRunFile(paths, instanceId, name), live);
    },
  );

  const gateway = await runStep(reporter, { id: 'prepare_gateway_image', label: 'Preparing the gateway image…' }, () =>
    prepareReleaseGatewayImage(
      serving.onecli,
      { gateway: LAUNCHER_PINS.onecliGateway },
      { dockerCommandRunner: run, ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}) },
    ),
  );

  const from = releaseOf(reservation);
  const staged = layout.release(name);
  const [lockUnchanged, sessionSchemaUnchanged] = await Promise.all([
    sameFiles(serving.release, staged, [AGENT_RUNNER_LOCKFILE]),
    sameFiles(serving.release, staged, SESSION_SCHEMA_SOURCES),
  ]);
  return {
    from,
    to: release,
    manifest,
    preview: {
      instanceId,
      from,
      to: release,
      migrations,
      gateway,
      groupImages: readDerivedImageGroups(serving.state, getInstallScopedNames(runtime.install_id).containerImageBase),
      agentRunnerLockChanged: !lockUnchanged,
      sessionSchemaChanged: !sessionSchemaUnchanged,
    },
  };
}

/**
 * Check, stage, and preview an update under its instance lock, the assistant
 * serving throughout. An assistant on the layout before releases is converted
 * by this update, checked and proven as its conversion needs (KTD12).
 */
export async function prepareUpdate(
  operation: InstanceOperation,
  intent: UpdateIntent,
  dependencies: UpdateDependencies,
): Promise<StagedUpdate> {
  operation.assertActive();
  const conversion = await prepareConversion(operation, intent, dependencies, (checked) =>
    stageUpdate(operation, checked, dependencies),
  );
  if (conversion) return conversion;
  const checked = await runStep(
    dependencies.reporter ?? {},
    { id: 'check_update', label: 'Checking the assistant…' },
    () => checkUpdate(operation, intent, dependencies),
  );
  return stageUpdate(operation, checked, dependencies);
}

/**
 * Ask `confirm` about a staged update, then record it at `staged` (KTD2),
 * from the release the registry names, with the live schema staging read.
 * A conversion keeps nothing to return to, so it has no rollback target
 * (KTD9, KTD12). A decline records nothing; the staged release is left for
 * the next update. Returns the record, or undefined when declined.
 */
export async function confirmStagedUpdate(
  operation: InstanceOperation,
  staged: StagedUpdate,
  confirm: (preview: UpdatePreview) => Promise<boolean>,
): Promise<OperationRecord | undefined> {
  if (!(await confirm(staged.preview))) return undefined;
  return beginOperation(operation, {
    kind: 'update',
    from: staged.from,
    to: staged.to,
    manifest: staged.manifest,
    ...(staged.preview.conversion ? { no_rollback_target: true as const } : {}),
  });
}

/** The preview, one fact per line. */
export function updatePreviewLines(preview: UpdatePreview): string[] {
  const { from, to, gateway, groupImages } = preview;
  const groups = groupImages.map((group) => `${printableName(group.name)} (${group.id})`).join(', ');
  return [
    `Assistant: ${preview.instanceId}`,
    `From: ${releaseLine(from)}`,
    `To: ${releaseLine(to)}`,
    ...(from.source_remote === to.source_remote ? [] : [`Source: ${from.source_remote} → ${to.source_remote}`]),
    `Database migrations to add: ${preview.migrations.length > 0 ? preview.migrations.join(', ') : 'none'}`,
    gateway.release === gateway.current
      ? `Gateway image: unchanged (${gateway.current})`
      : `Gateway image: ${gateway.current} → ${gateway.release}`,
    `Agent group images rebuilt after the update: ${groups || 'none'}`,
    ...(preview.agentRunnerLockChanged && groupImages.length > 0
      ? [
          `Until rebuilt, ${groups} run the previous agent-runner dependencies, so their first turns may fail and retry.`,
        ]
      : []),
    ...(preview.conversion
      ? [
          `Layout: its state moves by rename from ${preview.conversion.from} to ${preview.conversion.to}, one way.`,
          'Rollback: none. No backup is kept and its old rollback point is dropped; a failure after the new release starts is fixed forward with a newer release.',
        ]
      : preview.migrations.length > 0 || preview.sessionSchemaChanged
        ? [
            `${preview.migrations.length > 0 ? 'This release migrates the database' : "This release changes its session databases' schema"}: a failure after it starts may restore the pre-update snapshot, discarding what the new release recorded before it failed.`,
          ]
        : []),
  ];
}

/** An update that failed before its release was committed, as recovery receives it. */
interface FailedUpdate {
  /** The update's record as the failure left it: its phase says how far it got. */
  readonly record: OperationRecord;
  readonly cause: unknown;
}

/** From here on the update's release was started, so one with no release to return to is closed for fix-forward. */
const STARTED: ReadonlySet<OperationRecord['phase']> = new Set(['started', 'verified']);

/**
 * Recovery for an update that failed before its release was committed. The
 * registry is read first: an update it already names was committed, so it
 * stands, and is reported for `update --id` to finish recording (see
 * `assertNotCommitted`). Once its release may have started (from `switched`,
 * `targetMayHaveStarted`), the update is rolled back by the rollback rules,
 * which its own confirmation covers: code only when neither schema moved,
 * else the snapshot its fence took. One with no rollback target is closed for
 * fix-forward instead once its release started (KTD9). Before that the
 * release it left is served again (`serveLeftRelease`) and the record
 * discarded, the staged release kept for the next update: a refusal before
 * the release started. When that return fails too, or the update has no
 * release to return to, the record stays open and the failure names what
 * continues it.
 */
async function recoverUpdate(
  operation: InstanceOperation,
  failed: FailedUpdate,
  dependencies: UpdateDependencies,
): Promise<never> {
  operation.assertActive();
  const { record, cause } = failed;
  await assertNotCommitted(operation, cause);
  const id = record.instance_id;
  const failure = `${safeErrorMessage(cause)} The update to ${releaseLine(record.to)} stopped at ${record.phase}`;
  const details: GwsEaErrorDetails = { ...(cause instanceof GwsEaError ? cause.details : {}), phase: record.phase };
  const fixForward = `update it to a newer release with gws-ea update --id ${id}`;
  if (STARTED.has(record.phase) && record.no_rollback_target) {
    await closeOperationFailed(operation);
    throw new GwsEaError(
      'update_failed',
      `${failure}, and it has no release to return to. Fix it forward: ${fixForward}.`,
      { cause, details: { ...details, continueWith: `gws-ea update --id ${id}` } },
    );
  }
  if (targetMayHaveStarted(record) && !record.no_rollback_target) {
    let rolledBack: string;
    try {
      rolledBack = describeRollback(await revertUpdate(operation, dependencies), localTimezone());
    } catch (error) {
      throw new GwsEaError(
        'update_recovery_failed',
        `${failure}, and rolling it back failed too: ${safeErrorMessage(error)}`,
        { cause, details: { ...details, continueWith: `gws-ea update --id ${id}` } },
      );
    }
    throw new GwsEaError('update_rolled_back', `${failure}, so it was rolled back: ${rolledBack}`, {
      cause,
      details,
    });
  }
  const next = operationNextSteps(record);
  const unfinished = { ...details, continueWith: next.continueWith, revertWith: next.revertWith ?? null };
  if (record.no_rollback_target) {
    throw new GwsEaError(
      'update_interrupted',
      `${failure} and is unfinished: continue it with ${next.continueWith}, or fix it forward to another release with gws-ea update --id ${id}.`,
      { cause, details: unfinished },
    );
  }
  try {
    await serveLeftRelease(await openCutoverHost(operation, dependencies), record);
    await discardOperation(operation);
  } catch (error) {
    throw new GwsEaError(
      'update_interrupted',
      `${failure}, before its release started, and serving ${releaseLine(record.from)} again failed too: ${safeErrorMessage(error)} ` +
        `The update is unfinished: continue it with ${next.continueWith}${revertClause(next)}.`,
      { cause, details: unfinished },
    );
  }
  throw new GwsEaError(
    'update_refused',
    `${failure}, before its release started, so assistant ${id} runs ${releaseLine(record.from)} again. ` +
      `The staged release is kept: gws-ea update --id ${id} tries it again.`,
    { cause, details },
  );
}

const STOP_LABEL = 'Stopping the assistant for the switch…';

/** The live migrations must still be the ones staging read, or the dry run no longer speaks for them. */
function assertMigrationsUnchanged(record: OperationRecord, manifest: SnapshotManifest): void {
  const staged = record.manifest?.central_migrations;
  const live = manifest.central_migrations;
  if (!staged || sameList(live, staged)) return;
  throw new GwsEaError(
    'live_schema_changed',
    `The live database's migrations changed since the update was staged (${staged.join(', ')} became ${live.join(', ')}), so its dry run no longer holds.`,
    { details: { staged, live } },
  );
}

/** The OneCLI version a release's receipt records; an update never changes it. */
async function releasePins(host: CutoverHost, release: ReleaseCoordinates): Promise<{ readonly gateway: string }> {
  const { onecli } = await readDeployedSetup(host.operation.paths, reservationAt(host.reservation, release));
  return { gateway: onecli.gateway };
}

/** Where an operation resumed is fenced, its live link absent or naming a release not yet started. */
const RESUMED_FENCED: ReadonlySet<OperationRecord['phase']> = new Set(['fenced', 'snapshotted', 'switched']);

/**
 * Re-establish the fence of an update resumed while fenced (KTD1): whatever
 * started since (a reboot, a login) is stopped and the instance proven quiet
 * again before anything goes on, and the stop is recorded afresh. Once the
 * update took its snapshot, a fence in force that ended the release the
 * update left means that release was served again since (a return that
 * refused the update and was cut short) and may have recorded more, so the
 * snapshot is taken again under this fence before the update goes on (KTD4);
 * one this fence already took is kept. A fence that ended the update's own
 * release leaves the snapshot as the release it left wrote it.
 */
async function refence(host: CutoverHost, record: OperationRecord): Promise<OperationRecord> {
  const stop = await fenceInstance(host, 'Making sure the assistant is still stopped…');
  const left = releaseName(record.from.deployed_commit);
  if (record.phase !== 'fenced' && (await fenceEnded(host.layout)) === left) {
    await runStep(host.reporter, { id: 'snapshot_state', label: 'Taking a snapshot of its state…' }, () =>
      takeSnapshot(host.layout, operationName(record.started_at), left),
    );
  }
  return recordOperationFacts(host.operation, { stop });
}

/**
 * Run the update from the phase its record reached until its release is
 * committed. Before the fence the serving OneCLI runtime is re-verified;
 * then the assistant is fenced, its state snapshotted as the release it
 * left last wrote it (`snapshots/<op>/`, keyed to the fence), switched to the
 * release, and started; main's skills are reconciled, the release verified,
 * its follow-ups planned, and the registry compare-and-swap commits it. A
 * resume between the fence and the start fences again first, so a switch is
 * always followed by a start that reads the service definition it installed.
 * Returns why what a converted assistant's old layout left could not be
 * removed, for the update to report once committed.
 */
async function runUpdate(host: CutoverHost, start: OperationRecord): Promise<GwsEaError | undefined> {
  const { operation, layout, reporter } = host;
  const name = releaseName(start.to.deployed_commit);
  let record = RESUMED_FENCED.has(start.phase) ? await refence(host, start) : start;
  let definitionChanged = false;
  for (;;) {
    switch (record.phase) {
      case 'staged': {
        const pins = await releasePins(host, record.from);
        await runStep(reporter, { id: 'verify_gateway', label: 'Checking the credential gateway…' }, () =>
          cutoverOnecli(host).reverify(host.onecli, pins),
        );
        const staged = record;
        let manifest: SnapshotManifest | undefined;
        const stop = await fenceInstance(host, STOP_LABEL, () => {
          manifest = readSchemaManifest(layout.state);
          assertMigrationsUnchanged(staged, manifest);
        });
        record = await advanceOperation(operation, 'fenced', { stop, ...(manifest ? { manifest } : {}) });
        break;
      }
      case 'fenced':
        await runStep(reporter, { id: 'snapshot_state', label: 'Taking a snapshot of its state…' }, () =>
          takeSnapshot(layout, operationName(record.started_at), releaseName(record.from.deployed_commit)),
        );
        record = await advanceOperation(operation, 'snapshotted');
        break;
      case 'snapshotted':
        definitionChanged = await switchTo(host, record.to, record.from, 'Switching to the new release…');
        record = await advanceOperation(operation, 'switched');
        break;
      case 'switched':
        if ((await readCurrent(layout)) !== name) {
          definitionChanged = await switchTo(host, record.to, record.from, 'Switching to the new release…');
        }
        await startRelease(host, definitionChanged, 'Starting the new release…');
        record = await advanceOperation(operation, 'started');
        break;
      case 'started': {
        const started = record;
        await reconcileMainSkills(host, started.stop?.graceful === false);
        await runStep(reporter, { id: 'verify_release', label: 'Checking the new release serves…' }, async () =>
          verifyServingRelease(host, {
            view: reservationAt(host.reservation, started.to),
            pins: await releasePins(host, started.to),
            leaseHeld: started.stop?.graceful === false,
            subject: 'The new release',
          }),
        );
        record = await advanceOperation(operation, 'verified', {
          follow_ups: planFollowUps(record.follow_ups, releaseFollowUps(host.runtime)),
        });
        break;
      }
      case 'verified': {
        // A converted assistant's old layout goes once a release here is verified, before the commit, so a run cut
        // short removes it when this update is continued (KTD12).
        const leftover = await finishConversion(host);
        await runStep(reporter, { id: 'record_release', label: 'Recording the new release…' }, () =>
          commitOperationRelease(operation),
        );
        return leftover;
      }
      case 'committed':
        return undefined;
    }
  }
}

/** Where an update left the assistant: the release it runs, and the one it left. */
export interface UpdatedAssistant {
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  /** The release it left is kept to roll back to: false for an update with no rollback target (KTD9). */
  readonly rollbackTarget: boolean;
}

/**
 * Carry a confirmed update from whatever phase its record reached to its
 * committed release, then run its follow-ups. A failure before the release is
 * committed goes to recovery; one after never rolls back, and is left for the
 * next `update --id` to retry. What a converted assistant's old layout left
 * and could not be removed is reported last.
 */
export async function continueUpdate(
  operation: InstanceOperation,
  dependencies: UpdateDependencies,
): Promise<UpdatedAssistant> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const record = await readOperationRecord(paths, instanceId);
  if (!record || record.kind !== 'update' || record.closed) {
    throw new GwsEaError('operation_missing', `Assistant ${instanceId} has no update under way.`);
  }
  let leftover: GwsEaError | undefined;
  if (record.phase !== 'committed') {
    // An assistant on the layout before releases is moved to its short root first; the conversion reports its own
    // failures, and leaves the update recorded at `snapshotted` (KTD12).
    await continueConversion(operation, dependencies);
    try {
      leftover = await runUpdate(
        await openCutoverHost(operation, dependencies),
        (await readOperationRecord(paths, instanceId)) ?? record,
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Every failure before the commit point goes to recovery, which reports it.
    } catch (error) {
      return recoverUpdate(
        operation,
        { record: (await readOperationRecord(paths, instanceId)) ?? record, cause: error },
        dependencies,
      );
    }
  }
  await finishFollowUps(operation, dependencies);
  if (leftover) throw leftover;
  return { from: record.from, to: record.to, rollbackTarget: record.no_rollback_target !== true };
}
