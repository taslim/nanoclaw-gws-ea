/**
 * `update` (R7-R12, R14, R15). Every refusal comes before anything changes.
 * Then, while the assistant keeps serving, the tool's own release is staged
 * beside the live checkout (KTD1): fetched, installed, built, and preflighted
 * in `<instance>/next/nanoclaw` with its receipt under `next/`, its
 * migrations tried on a copy of the live central database (KTD15), its agent
 * image built as `<base>:next` (KTD7), and its gateway image built when the
 * release changes it (KTD8). The preview then says what the cutover will
 * change.
 *
 * Nothing live changes before the operator confirms. A decline or a staging
 * failure writes no record and removes `next/` and the `:next` image; a
 * staging cut short (Ctrl-C, a kill) leaves them for the next update to remove
 * (KTD2). Confirming records the update at `staged`, and its cutover follows:
 * the host is stopped and its checkout proven quiet, its state carried into
 * the staged checkout, the two swapped, images retagged and the gateway
 * recreated when it changed, and the host started and verified on the
 * release, which is then recorded. Each phase is recorded as it completes, so
 * an update cut short anywhere is continued by the next `update --id`; one
 * that fails before it is recorded is handed to recovery.
 */
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { getInstallScopedNames } from '../install-slug.js';
import {
  assertDeploymentCheckoutUnmodified,
  materializeReleaseCheckout,
  prepareReleaseCommandEnvironments,
  resolveToolCommit,
  type CheckoutRuntime,
} from './checkout.js';
import {
  assertCarriable,
  assertCheckoutQuiet,
  carryState,
  cutoverDocker,
  cutoverOnecli,
  cutoverQuiescence,
  cutoverServiceDependencies,
  dockerEnvironment,
  finishFollowUps,
  finishSwap,
  imageIdOf,
  keepCutoverHostStopped,
  nextAgentImage,
  openCutoverHost,
  planFollowUps,
  quietCheckoutOf,
  removeUpdateStaging,
  reverseSwapBeforeLiveMoved,
  settleCheckoutDatabases,
  stopCutoverHost,
  verifyServingRelease,
  type CutoverDependencies,
  type CutoverHost,
  type CutoverSeams,
  type SwapReleases,
} from './cutover.js';
import { keepReleaseFiles, keptReleaseFiles, stagedKeptFilesRoot } from './kept-release.js';
import { runStep } from './events.js';
import { loadCreatedRuntime, type InstanceOperation } from './journal.js';
import {
  decideMainTemplate,
  describeCustomized,
  mainTemplateRoot,
  type MainTemplateDecision,
} from './main-template.js';
import { prepareReleaseGatewayImage, type GatewayImageChange } from './onecli.js';
import { parseOnecliComposeImages, type OnecliPins } from './onecli-compose.js';
import { resolveWrapperGatewayImage } from './onecli-gateway-image.js';
import {
  advanceOperation,
  assertNotCommitted,
  beginOperation,
  commitOperationRelease,
  operationNextSteps,
  readOperationRecord,
  recordOperationFacts,
  reservationAt,
  revertClause,
  targetReservationView,
  type MovedImage,
  type OperationFollowUp,
  type OperationRecord,
  type SnapshotManifest,
} from './operation.js';
import { CONTROL_PLANE_ROOT, instanceMarkerFile, isRegularFile, type ControlPlanePaths } from './paths.js';
import { LAUNCHER_PINS } from './pins.js';
import { runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { instanceOnecliLayout, readDeployedSetup, writeReleasePreflightReceipt } from './provision.js';
import { redact, safeErrorMessage } from './redact.js';
import { getInstanceReservation } from './registry.js';
import { runReleasePreflight } from './release-preflight.js';
import { resolveReleaseTarget, type ToolProviderSetup, type UpdateReleaseTarget } from './release-target.js';
import { resolveReleaseSource, type ReleaseSource } from './release-tracks.js';
import { describeRollback, localTimezone, revertUpdate } from './rollback.js';
import { readOwnerOnlyFile } from './secrets.js';
import {
  createInstanceRuntimeConfig,
  instanceServiceDefinitionFile,
  readInstanceHostEnvironment,
  stampUpgradeState,
  writeInstanceServiceDefinition,
  writeReleaseRuntime,
  type InstanceRuntimeConfig,
} from './service.js';
import { createServiceControl, runtimeServiceTarget } from './service-control.js';
import {
  GwsEaError,
  INSTANCE_MARKER_SCHEMA_VERSION,
  releaseOf,
  sameRelease,
  shortCommit,
  type GwsEaErrorDetails,
  type InstanceMarker,
  type InstanceReservation,
  type ReleaseCoordinates,
} from './types.js';
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
const IMAGE_BUILD_TIMEOUT_MS = 20 * 60_000;
const DOCKER_TIMEOUT_MS = 60_000;

export interface UpdateRequest {
  readonly instanceId: string;
  /** `--track`: the assistant's own track unless given. */
  readonly track?: string;
  /** `--source-remote`: the assistant's recorded source remote unless given (KTD4). */
  readonly sourceRemote?: string;
}

/** Boundary seams; each defaults to the real one. */
export interface UpdateSeams extends CutoverSeams {
  /** The tool's checkout, whose commit an update deploys; the one this control plane runs from by default. */
  readonly toolRoot?: string;
  readonly runReleasePreflight?: typeof runReleasePreflight;
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

/** What the operator confirms (R8). */
export interface UpdatePreview {
  readonly instanceId: string;
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  /** The central migrations the release adds, in the order they ran on the copy. */
  readonly migrations: readonly string[];
  readonly gateway: GatewayImageChange;
  /** The groups whose own image is rebuilt on the new base once the update is recorded (KTD7). */
  readonly groupImages: readonly DerivedImageGroup[];
  /** Those groups then run the previous agent-runner dependencies until their rebuild finishes. */
  readonly agentRunnerLockChanged: boolean;
  /** The session-schema sources differ, so session columns may change once the new host opens each session. */
  readonly sessionSchemaChanged: boolean;
  /**
   * What happens to main's template (R11, KTD12): refreshed once the update
   * is recorded, unchanged, kept because these files are customized, or not
   * stamped. Decided here and again right before any restamp.
   */
  readonly mainTemplate: MainTemplateDecision;
}

/** A release staged and previewed, not yet recorded. */
export interface StagedUpdate {
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  /** `<instance>/next/nanoclaw`: installed, built, preflighted, and holding the dry run's database. */
  readonly checkoutRoot: string;
  /** The assistant's runtime record: its service, install, and Docker endpoint. */
  readonly runtime: InstanceRuntimeConfig;
  /** The live schema as staging read it; the dry run left its migrations as they were. */
  readonly manifest: SnapshotManifest;
  readonly preview: UpdatePreview;
}

interface CheckedUpdate {
  readonly reservation: InstanceReservation;
  readonly runtime: InstanceRuntimeConfig;
  readonly target: UpdateReleaseTarget;
}

function checkoutRuntime(seams: UpdateSeams): CheckoutRuntime {
  return seams.runCommand ? { runCommand: seams.runCommand } : {};
}

/**
 * The release `update` would deploy: the tool's own commit, on the track the
 * operator names or the assistant's own, from the source remote the operator
 * names or the assistant's recorded one.
 */
export async function resolveUpdateIntent(
  paths: ControlPlanePaths,
  request: UpdateRequest,
  seams: UpdateSeams = {},
): Promise<UpdateIntent> {
  const reservation = await getInstanceReservation(paths, request.instanceId);
  const track = request.track ?? reservation.release_track;
  const source = resolveReleaseSource(track, request.sourceRemote ?? reservation.source_remote);
  const commit = await resolveToolCommit(seams.toolRoot ?? CONTROL_PLANE_ROOT, checkoutRuntime(seams));
  return {
    instanceId: request.instanceId,
    track,
    source,
    target: { source_remote: source.remote, release_track: track, deployed_commit: commit },
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

/**
 * Remove an update's staging: the `:next` image, then `next/`. The image goes
 * first, so a staging whose image could not be removed is still found as
 * abandoned. The staging of an unfinished update is that update's own, so it
 * is never removed here.
 */
export async function discardUpdateStaging(
  operation: InstanceOperation,
  runtime: InstanceRuntimeConfig,
  seams: UpdateSeams = {},
): Promise<void> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const record = await readOperationRecord(paths, instanceId);
  if (record && record.phase !== 'recorded') {
    throw new GwsEaError(
      'staging_in_use',
      `The staged release belongs to this assistant's unfinished ${record.kind}; continue or revert it instead.`,
    );
  }
  await removeUpdateStaging(paths, instanceId, runtime, seams);
}

/** Remove what a failed staging left, keeping the failure: what cannot be removed is left for the next update. */
async function discardAfterFailure(
  operation: InstanceOperation,
  runtime: InstanceRuntimeConfig,
  dependencies: UpdateDependencies,
): Promise<void> {
  try {
    await runStep(dependencies.reporter ?? {}, { id: 'discard_staging' }, () =>
      discardUpdateStaging(operation, runtime, dependencies),
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- The staging failure is what the operator must see; its step log records this one, and the next update removes what is left.
  } catch {
    return;
  }
}

/** A stopped assistant cannot prove its new release serves; one outside its service cannot be stopped for the cutover. */
function assertHostRunning(runtime: InstanceRuntimeConfig, dependencies: UpdateDependencies): void {
  const id = runtime.instance_id;
  const handle = createServiceControl(
    dependencies.serviceHelpers,
    runtimeServiceTarget(runtime),
    dependencies.service,
  ).detect();
  if (handle.mode === 'unmanaged') {
    throw new GwsEaError(
      'service_unmanaged',
      `Assistant ${id}'s host runs from ${runtime.checkout_realpath} outside its service (PID ${handle.name}); stop that process and start the assistant with gws-ea start --id ${id}, then update.`,
    );
  }
  if (!handle.active) {
    throw new GwsEaError(
      'host_not_running',
      `Assistant ${id} is stopped, and an update proves its new release on a running assistant. Start it with gws-ea start --id ${id}, then update.`,
    );
  }
}

/** Every byte under `root`, each file counted once however many links it has; links are not followed. */
async function treeBytes(root: string, seen = new Set<string>()): Promise<number> {
  const info = await lstat(root);
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

async function fileBytes(file: string): Promise<number> {
  try {
    return (await lstat(file)).size;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0;
    throw error;
  }
}

async function freeBytesAt(directory: string): Promise<number> {
  const disk = await statfs(directory);
  return Number(disk.bavail) * Number(disk.bsize);
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Room for what the update adds before it can delete anything, mirroring the
 * upstream updater's check (KTD14). The live checkout's size stands for the
 * staged release's code, dependencies, and build together with the copy of
 * its state the cutover carries across; its central database's size for the
 * dry run's copy; its agent image's size for the new one. The live checkout
 * is kept whole as the previous release, so it frees nothing. Counted against
 * the instance's filesystem, which also holds Docker's disk where Docker runs
 * in a local VM.
 */
async function assertFreeDisk(
  paths: ControlPlanePaths,
  runtime: InstanceRuntimeConfig,
  dependencies: UpdateDependencies,
): Promise<void> {
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const database = path.join(runtime.checkout_realpath, 'data', 'v2.db');
  const [checkout, central, journal, image] = await Promise.all([
    treeBytes(runtime.checkout_realpath),
    fileBytes(database),
    fileBytes(`${database}-wal`),
    run({
      command: 'docker',
      args: [
        'image',
        'inspect',
        '--format',
        '{{.Size}}',
        getInstallScopedNames(runtime.install_id).defaultContainerImage,
      ],
      cwd: paths.instanceRoot(runtime.instance_id),
      env: dockerEnvironment(runtime, dependencies),
      timeoutMs: DOCKER_TIMEOUT_MS,
    }).then(({ stdout }) => {
      const size = Number(stdout.trim());
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new GwsEaError('invalid_child_output', 'Docker reported an invalid agent image size');
      }
      return size;
    }),
  ]);
  const needed = checkout + central + journal + image + DISK_RESERVE_BYTES;
  const directory = paths.instanceRoot(runtime.instance_id);
  const free = await (dependencies.freeBytes ?? freeBytesAt)(directory);
  if (free >= needed) return;
  throw new GwsEaError(
    'insufficient_disk',
    `Updating assistant ${runtime.instance_id} needs about ${gigabytes(needed)} free for the staged release, a copy of its state, and a new agent image, and ${gigabytes(free)} is free at ${directory}. Free some space, then retry.`,
    { details: { needed, free } },
  );
}

/**
 * Every refusal an update makes before it changes anything (R9), under the
 * instance lock. Abandoned staging is removed first, after the gate: nothing
 * else can own it once no update is unfinished.
 */
async function checkUpdate(
  operation: InstanceOperation,
  intent: UpdateIntent,
  dependencies: UpdateDependencies,
): Promise<CheckedUpdate> {
  const { paths, instanceId } = operation;
  const runtime = await loadCreatedRuntime(paths, instanceId);
  if (await exists(paths.releaseRoot(instanceId, 'next'))) {
    await discardUpdateStaging(operation, runtime, dependencies);
  }
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
  assertHostRunning(runtime, dependencies);
  await assertDeploymentCheckoutUnmodified(reservation, checkoutRuntime(dependencies));
  await assertFreeDisk(paths, runtime, dependencies);
  return { reservation, runtime, target };
}

export interface MigrationDryRun {
  readonly liveCheckout: string;
  /** The live migrations as staging recorded them; the dry run must leave them so. */
  readonly liveMigrations: readonly string[];
  readonly stagedCheckout: string;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * Where the dry run may put its copy: the staged checkout's own `data/`, as a
 * physical directory. What the migration script resolves from its working
 * directory (NanoClaw's `src/config.ts`: `data/v2.db` under it), links
 * followed, must be exactly there, and hold no database yet. Nothing is
 * written before that holds.
 */
async function dryRunDatabase(workingDirectory: string, stagedCheckout: string): Promise<string> {
  const expected = path.join(await realpath(path.dirname(stagedCheckout)), path.basename(stagedCheckout), 'data');
  const data = path.join(workingDirectory, 'data');
  const present = await exists(data);
  const database = path.join(present ? await realpath(data) : data, 'v2.db');
  if (path.dirname(database) !== expected) {
    throw new GwsEaError(
      'unsafe_dry_run',
      `The release's migrations would run against ${database}, outside the staged checkout's ${expected}; nothing was run.`,
    );
  }
  if (!present) await mkdir(data, { mode: 0o700 });
  if (await exists(database)) {
    throw new GwsEaError(
      'unsafe_dry_run',
      `The staged checkout already holds a database at ${database}; the dry run copies the live one there itself, so nothing was run.`,
    );
  }
  return database;
}

/**
 * Try a release's own migrations on a copy of the live central database
 * (KTD15): a single-step online backup into the staged checkout's `data/`,
 * then the release's migration script, run from the staged checkout's real
 * path. The live migrations must be as staging recorded them afterwards.
 * Returns the migrations the release adds, in the order they ran.
 */
export async function dryRunReleaseMigrations(
  request: MigrationDryRun,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<readonly string[]> {
  const workingDirectory = await realpath(request.stagedCheckout);
  const database = await dryRunDatabase(workingDirectory, request.stagedCheckout);
  await backupCentralDatabase(request.liveCheckout, database);
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
  const live = readCentralMigrations(request.liveCheckout);
  if (!sameList(live, request.liveMigrations)) {
    throw new GwsEaError(
      'live_schema_changed',
      `The live database's migrations changed while the release's were tried on a copy (${request.liveMigrations.join(', ')} became ${live.join(', ')}); the update stopped before changing anything else.`,
      { ...(failure ? { cause: failure } : {}), details: { staged: request.liveMigrations, live } },
    );
  }
  const added = readCentralMigrations(workingDirectory).filter((name) => !request.liveMigrations.includes(name));
  if (!failure) return added;
  const applied = added.length > 0 ? `after applying ${added.join(', ')}` : 'before applying any';
  throw new GwsEaError(
    'migration_dry_run_failed',
    `The release's database migrations failed on a copy of this assistant's database, ${applied}; the release's own error follows. Nothing live changed.`,
    { cause: failure, details: { ...failure.details, applied: added } },
  );
}

/** Copy the instance's `.env` into the staged checkout, owner permissions kept: the image build reads its flags. */
async function copyInstanceEnvironment(liveCheckout: string, stagedCheckout: string): Promise<void> {
  const source = path.join(liveCheckout, '.env');
  let mode: number;
  try {
    const info = await lstat(source);
    if (!info.isFile()) {
      throw new GwsEaError('unsafe_runtime', `The assistant's environment file ${source} is not a regular file`);
    }
    mode = info.mode & 0o777;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  const destination = path.join(stagedCheckout, '.env');
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  await chmod(destination, mode);
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

/** Stage the checked release in `next/` while the assistant serves, and preview the cutover. */
async function stageRelease(
  operation: InstanceOperation,
  { reservation, runtime, target }: CheckedUpdate,
  dependencies: UpdateDependencies,
): Promise<StagedUpdate> {
  const { paths, instanceId } = operation;
  const reporter = dependencies.reporter ?? {};
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const live = reservation.checkout_realpath;
  const staged = paths.releaseCheckoutRoot(instanceId, 'next');
  const release = target.release;

  await runStep(
    reporter,
    { id: 'stage_release', label: 'Preparing the new release beside the running assistant…' },
    async () => {
      await materializeReleaseCheckout(
        paths,
        reservationAt(reservation, release),
        checkoutRuntime(dependencies),
        'next',
      );
      const preflight = await (dependencies.runReleasePreflight ?? runReleasePreflight)(
        { checkoutRoot: staged, ...target.preflight },
        { runCommand: run },
      );
      await writeReleasePreflightReceipt(
        paths.releasePreflightFile(instanceId, 'next'),
        instanceId,
        release.deployed_commit,
        preflight,
      );
    },
  );

  const { manifest, migrations } = await runStep(
    reporter,
    { id: 'try_migrations', label: "Trying the release's database migrations on a copy…" },
    async () => {
      const read = readSchemaManifest(live);
      const added = await dryRunReleaseMigrations(
        { liveCheckout: live, liveMigrations: read.central_migrations, stagedCheckout: staged },
        run,
        (await prepareReleaseCommandEnvironments(paths.releaseRoot(instanceId, 'next'))).common,
      );
      return { manifest: read, migrations: added };
    },
  );

  await runStep(reporter, { id: 'build_agent_image', label: 'Building the new agent image…' }, async () => {
    await copyInstanceEnvironment(live, staged);
    await run({
      command: 'bash',
      args: [path.join(staged, 'container', 'build.sh'), 'next'],
      cwd: staged,
      env: { ...dockerEnvironment(runtime, dependencies), NANOCLAW_INSTALL_ID: runtime.install_id },
      timeoutMs: IMAGE_BUILD_TIMEOUT_MS,
      stream: true,
    });
  });

  const gateway = await runStep(reporter, { id: 'prepare_gateway_image', label: 'Preparing the gateway image…' }, () =>
    prepareReleaseGatewayImage(
      instanceOnecliLayout(paths, reservation, runtime.onecli_cli_path, runtime.docker_endpoint),
      { gateway: LAUNCHER_PINS.onecliGateway, cli: LAUNCHER_PINS.onecliCli },
      { runCommand: run, ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}) },
    ),
  );

  const [lockUnchanged, sessionSchemaUnchanged, mainTemplate] = await Promise.all([
    sameFiles(live, staged, [AGENT_RUNNER_LOCKFILE]),
    sameFiles(live, staged, SESSION_SCHEMA_SOURCES),
    decideMainTemplate(live, mainTemplateRoot(staged)),
  ]);
  return {
    from: releaseOf(reservation),
    to: release,
    checkoutRoot: staged,
    runtime,
    manifest,
    preview: {
      instanceId,
      from: releaseOf(reservation),
      to: release,
      migrations,
      gateway,
      groupImages: readDerivedImageGroups(live, getInstallScopedNames(runtime.install_id).containerImageBase),
      agentRunnerLockChanged: !lockUnchanged,
      sessionSchemaChanged: !sessionSchemaUnchanged,
      mainTemplate,
    },
  };
}

/**
 * Check, stage, and preview an update under its instance lock, the assistant
 * serving throughout. A staging failure removes what it staged before the
 * failure is reported.
 */
export async function prepareUpdate(
  operation: InstanceOperation,
  intent: UpdateIntent,
  dependencies: UpdateDependencies,
): Promise<StagedUpdate> {
  operation.assertActive();
  const checked = await runStep(
    dependencies.reporter ?? {},
    { id: 'check_update', label: 'Checking the assistant…' },
    () => checkUpdate(operation, intent, dependencies),
  );
  try {
    return await stageRelease(operation, checked, dependencies);
  } catch (error) {
    await discardAfterFailure(operation, checked.runtime, dependencies);
    throw error;
  }
}

/**
 * Record a confirmed update at `staged` (KTD2): from the release the registry
 * names to the staged one, with the live schema staging read, the groups
 * whose image is rebuilt once the release is recorded, and main's template
 * refresh when the preview promised one. One the preview kept is not planned,
 * so a customization undone meanwhile never refreshes what the operator was
 * told is kept.
 */
export function recordStagedUpdate(operation: InstanceOperation, staged: StagedUpdate): Promise<OperationRecord> {
  return beginOperation(operation, {
    kind: 'update',
    from: staged.from,
    to: staged.to,
    manifest: staged.manifest,
    follow_ups: [
      ...staged.preview.groupImages.map((group) => ({
        kind: 'rebuild_group_image' as const,
        agent_group_id: group.id,
      })),
      ...(staged.preview.mainTemplate.kind === 'refresh' ? [{ kind: 'refresh_template' as const }] : []),
    ],
  });
}

/**
 * Ask `confirm` about a staged update, then record it at `staged`; a decline
 * removes the staging. So does a failure to ask or to record: nothing is left
 * but a recorded update or no update at all. Returns the record, or undefined
 * when declined.
 */
export async function confirmStagedUpdate(
  operation: InstanceOperation,
  staged: StagedUpdate,
  dependencies: UpdateDependencies,
  confirm: (preview: UpdatePreview) => Promise<boolean>,
): Promise<OperationRecord | undefined> {
  try {
    if (await confirm(staged.preview)) return await recordStagedUpdate(operation, staged);
  } catch (error) {
    await discardAfterFailure(operation, staged.runtime, dependencies);
    throw error;
  }
  await runStep(dependencies.reporter ?? {}, { id: 'discard_staging', label: 'Removing the staged release…' }, () =>
    discardUpdateStaging(operation, staged.runtime, dependencies),
  );
  return undefined;
}

function releaseLine(release: ReleaseCoordinates): string {
  return `${release.release_track} ${shortCommit(release.deployed_commit)}`;
}

function mainTemplateLine(decision: MainTemplateDecision): string {
  switch (decision.kind) {
    case 'refresh':
      return "Main's template: refreshed from this release once the update is recorded, unless something is customized by then";
    case 'unchanged':
      return "Main's template: unchanged in this release";
    case 'customized':
      return `Main's template: kept as it is, because these are customized: ${describeCustomized(decision.customized)}`;
    case 'not_stamped':
      return `Main's template: not refreshed (${decision.reason})`;
  }
}

/** The preview, one fact per line (R8). */
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
    mainTemplateLine(preview.mainTemplate),
    ...(preview.agentRunnerLockChanged && groupImages.length > 0
      ? [
          `Until rebuilt, ${groups} run the previous agent-runner dependencies, so their first turns may fail and retry.`,
        ]
      : []),
    ...(preview.migrations.length > 0 || preview.sessionSchemaChanged
      ? [
          `${preview.migrations.length > 0 ? 'This release migrates the database' : "This release changes its session databases' schema"}: a failure after the swap may restore the pre-update snapshot, discarding what the new release recorded before it failed.`,
        ]
      : []),
  ];
}

/** An update that failed before its release was recorded (R14), as recovery receives it. */
export interface FailedCutover {
  /** The update's record as the failure left it: its phase says how far the cutover got. */
  readonly record: OperationRecord;
  readonly cause: unknown;
  /** The host the cutover opened, whose service recovery may start again; absent when it failed before that. */
  readonly host?: CutoverHost;
}

/** From here on the assistant ran the update's release, so a failure rolls it back (R14). */
const RENAMED: ReadonlySet<OperationRecord['phase']> = new Set(['swapped', 'started', 'verified']);

/** What recovery did with the host of the release an update never swapped out. */
type OutgoingHost =
  | { readonly kind: 'serving' }
  | { readonly kind: 'stopped'; readonly failure: unknown }
  | { readonly kind: 'left' };

/**
 * Start the old release's host again after a failure before the swap moved
 * the live checkout, so the assistant keeps serving: the live checkout still
 * holds that release whole, and continuing the update stops it, proves it
 * quiet, and carries its state again, so nothing it records meanwhile is lost
 * (KTD2). A swap cut short is first taken back to `stopped`. Once the live
 * checkout moved, only finishing or reverting the swap puts a release there,
 * so the host is left as it is.
 */
async function resumeOutgoingHost(host: CutoverHost, record: OperationRecord): Promise<OutgoingHost> {
  const { operation, dependencies } = host;
  try {
    if (record.phase === 'swapping') {
      const reversed = await reverseSwapBeforeLiveMoved(
        operation.paths,
        operation.instanceId,
        { from: record.from.deployed_commit, to: record.to.deployed_commit },
        dependencies.rename ? { rename: dependencies.rename } : {},
      );
      if (!reversed) return { kind: 'left' };
      await advanceOperation(operation, 'stopped');
    }
    await runStep(host.reporter, { id: 'start_outgoing', label: 'Starting the assistant again…' }, () =>
      host.service.start(),
    );
    return { kind: 'serving' };
    // eslint-disable-next-line no-catch-all/no-catch-all -- NanoClaw's service helpers fail with plain errors; the operator is told the assistant is stopped, and why.
  } catch (error) {
    return { kind: 'stopped', failure: error };
  }
}

/**
 * Recovery for an update that failed before its release was recorded (R14).
 * The registry is read first: an update it already names was committed, so
 * it stands, and is reported for `update --id` to finish recording (see
 * `assertNotCommitted`). Once its renames ran, the update is rolled back by
 * R13's rule, which its own confirmation covers: code only when neither
 * schema moved, else the snapshot its stop left. Before that nothing ran on
 * the release: the old release's host is started again (see
 * `resumeOutgoingHost`), the record stays open with its staging, and the
 * failure names the commands that continue or revert it. Either way the
 * failure is reported, with where the assistant was left.
 */
export async function recoverUpdate(
  operation: InstanceOperation,
  failed: FailedCutover,
  dependencies: UpdateDependencies,
): Promise<never> {
  operation.assertActive();
  const { record, cause } = failed;
  await assertNotCommitted(operation, cause);
  const failure = `${safeErrorMessage(cause)} The update to ${releaseLine(record.to)} stopped at ${record.phase}`;
  const details: GwsEaErrorDetails = { ...(cause instanceof GwsEaError ? cause.details : {}), phase: record.phase };
  if (record.kind === 'update' && RENAMED.has(record.phase)) {
    let rolledBack: string;
    try {
      rolledBack = describeRollback(await revertUpdate(operation, dependencies), localTimezone());
    } catch (error) {
      throw new GwsEaError(
        'update_recovery_failed',
        `${failure}, and rolling it back did not finish: ${safeErrorMessage(error)} ` +
          `Continue the rollback with gws-ea rollback --id ${record.instance_id}.`,
        { cause, details: { ...details, continueWith: `gws-ea rollback --id ${record.instance_id}` } },
      );
    }
    throw new GwsEaError('update_rolled_back', `${failure}, so it was rolled back: ${rolledBack}`, {
      cause,
      details,
    });
  }
  const next = operationNextSteps(record);
  const unfinished = { ...details, continueWith: next.continueWith, revertWith: next.revertWith ?? null };
  const outgoing: OutgoingHost = failed.host ? await resumeOutgoingHost(failed.host, record) : { kind: 'left' };
  const from = releaseLine(record.from);
  switch (outgoing.kind) {
    case 'serving':
      throw new GwsEaError(
        'update_interrupted',
        `${failure}, before its swap; the assistant runs ${from}, and the update is unfinished: continue it with ${next.continueWith}${revertClause(next)}.`,
        { cause, details: unfinished },
      );
    case 'stopped': {
      // NanoClaw's service helpers report why they failed as a plain error, so its text is shown, redacted.
      const reason = outgoing.failure instanceof Error ? outgoing.failure.message : String(outgoing.failure);
      const discard = next.revertWith ? `, or discard it and start ${from} again with ${next.revertWith}` : '';
      throw new GwsEaError(
        'update_interrupted',
        `${failure}, before its swap, and starting ${from} again failed: ${redact(reason).replace(/\.$/u, '')}. ` +
          `Assistant ${record.instance_id} is stopped: continue the update with ${next.continueWith}${discard}.`,
        { cause, details: unfinished },
      );
    }
    case 'left':
      throw new GwsEaError(
        'update_interrupted',
        `${failure} and is unfinished: continue it with ${next.continueWith}${revertClause(next)}.`,
        { cause, details: unfinished },
      );
  }
}

/** What every update cutover phase works from, read once per run. */
interface Cutover extends CutoverHost {
  readonly dependencies: UpdateDependencies;
  /** The reservation with the update's target overlaid (KTD17). */
  readonly target: InstanceReservation;
  /** The runtime record the release the update deploys runs with. */
  readonly release: InstanceRuntimeConfig;
  readonly releases: SwapReleases;
}

async function prepareCutover(
  operation: InstanceOperation,
  record: OperationRecord,
  dependencies: UpdateDependencies,
): Promise<Cutover> {
  const host = await openCutoverHost(operation, dependencies);
  const target = targetReservationView(host.reservation, record);
  return {
    ...host,
    dependencies,
    target,
    release: createInstanceRuntimeConfig(target, host.onecli, {
      nodePath: host.runtime.node_path,
      homeDirectory: host.runtime.home_directory,
      selectedProvider: host.runtime.selected_provider,
      dockerEndpoint: host.runtime.docker_endpoint,
    }),
    releases: { from: record.from.deployed_commit, to: record.to.deployed_commit },
  };
}

const STOP_LABEL = 'Stopping the assistant for the switch…';

/** The live migrations must still be the ones staging read, or the dry run no longer speaks for them. */
function assertMigrationsUnchanged(record: OperationRecord, checkoutRoot: string): void {
  const staged = record.manifest?.central_migrations;
  const live = readCentralMigrations(checkoutRoot);
  if (!staged || sameList(live, staged)) return;
  throw new GwsEaError(
    'live_schema_changed',
    `The live database's migrations changed since the update was staged (${staged.join(', ')} became ${live.join(', ')}), so its dry run no longer holds.`,
    { details: { staged, live } },
  );
}

/** The per-group images the rebuilds will displace, deleted once nothing names them (KTD19). */
async function displacedGroupImages(cutover: Cutover, record: OperationRecord): Promise<OperationFollowUp[]> {
  const base = getInstallScopedNames(cutover.runtime.install_id).containerImageBase;
  const displaced: OperationFollowUp[] = [];
  for (const followUp of record.follow_ups) {
    if (followUp.kind !== 'rebuild_group_image') continue;
    const id = await imageIdOf(cutover, `${base}:${followUp.agent_group_id}`);
    if (id) displaced.push({ kind: 'delete_image', image_id: id });
  }
  return displaced;
}

/**
 * Write what the release runs with into its staged checkout, the outgoing
 * one's state already carried in: its marker, runtime record, and gws-ea's
 * `.env` keys (KTD9), then its upgrade tripwire, stamped by its own script.
 * The outgoing release's own files are gathered to be kept beside it, with
 * its manifest: the release it is, and when its host stopped.
 */
async function carryIntoRelease(cutover: Cutover, stoppedAt: string): Promise<void> {
  const { operation, runtime, release, reservation, dependencies } = cutover;
  const { paths, instanceId } = operation;
  const live = reservation.checkout_realpath;
  const staged = paths.releaseCheckoutRoot(instanceId, 'next');
  await carryState(live, staged);
  await writeReleaseRuntime(release, staged, dependencies.upsertEnvVars);
  await writePrivate(instanceMarkerFile(staged), {
    schema_version: INSTANCE_MARKER_SCHEMA_VERSION,
    instance_id: instanceId,
    deployed_commit: release.deployed_commit,
  } satisfies InstanceMarker);
  await stampUpgradeState(staged, cutover.run, {
    ...dockerEnvironment(runtime, dependencies),
    NANOCLAW_INSTALL_ID: runtime.install_id,
  });
  const definition = instanceServiceDefinitionFile(runtime, cutoverServiceDependencies(cutover));
  await keepReleaseFiles(stagedKeptFilesRoot(paths, instanceId), {
    manifest: {
      schema_version: 1,
      instance_id: instanceId,
      release: releaseOf(reservation),
      snapshot_at: stoppedAt,
    },
    receipt: paths.releasePreflightFile(instanceId),
    compose: cutover.onecli.composeFile,
    serviceDefinition: (await isRegularFile(definition)) ? definition : undefined,
    hostEnvironment: readInstanceHostEnvironment(live),
  });
}

/**
 * `staged` or `stopped` → `swapping`: stop the host and its agents, prove the
 * checkout quiet and settle its databases (KTD18), and record the stop with
 * the schema as it stood (KTD5); then carry the state into the staged
 * checkout. Run again from `stopped`, all of it runs again, since the OS may
 * have started the old host meanwhile.
 */
async function stopAndCarry(cutover: Cutover, record: OperationRecord): Promise<OperationRecord> {
  const { operation, reporter, reservation } = cutover;
  const { paths, instanceId } = operation;
  const live = reservation.checkout_realpath;
  await assertCarriable(live);
  await stopCutoverHost(cutover, STOP_LABEL);
  const stoppedAt = new Date().toISOString();
  const { graceful, manifest } = await runStep(
    reporter,
    { id: 'prove_quiet', label: 'Checking nothing still uses its state…' },
    async () => {
      await assertCheckoutQuiet(quietCheckoutOf(cutover, live), cutoverQuiescence(cutover));
      const settled = settleCheckoutDatabases(live);
      assertMigrationsUnchanged(record, live);
      return { graceful: settled.graceful, manifest: readSchemaManifest(live) };
    },
  );
  const stopped = await advanceOperation(operation, 'stopped', {
    stop: { at: stoppedAt, graceful },
    manifest,
    follow_ups: planFollowUps(record.follow_ups, await displacedGroupImages(cutover, record)),
  });
  await runStep(
    reporter,
    { id: 'carry_state', label: 'Carrying conversations, memory, and settings to the new release…' },
    () => carryIntoRelease(cutover, stoppedAt),
  );
  const kept: OperationFollowUp[] = [
    ...((await exists(paths.releaseRoot(instanceId, 'previous')))
      ? [{ kind: 'delete_release' as const, release: 'superseded_previous' as const }]
      : []),
    ...((await exists(paths.releaseRoot(instanceId, 'outgoing')))
      ? [{ kind: 'delete_release' as const, release: 'outgoing' as const }]
      : []),
  ];
  return advanceOperation(operation, 'swapping', { follow_ups: planFollowUps(stopped.follow_ups, kept) });
}

/**
 * `swapping` → `swapped` (KTD1): with the host stopped (again, in case the OS
 * started one) and its checkout proven quiet just before the first rename,
 * swap the releases from wherever an interrupted swap left them.
 */
async function swapReleases(cutover: Cutover): Promise<OperationRecord> {
  const { operation, reporter, reservation, dependencies } = cutover;
  const { paths, instanceId } = operation;
  await keepCutoverHostStopped(cutover);
  await runStep(reporter, { id: 'swap_releases', label: 'Switching to the new release…' }, async () => {
    // Between the two renames the outgoing release is no longer at the live path, but in previous/.
    const outgoing = (await exists(reservation.checkout_realpath))
      ? reservation.checkout_realpath
      : paths.releaseCheckoutRoot(instanceId, 'previous');
    await assertCheckoutQuiet(quietCheckoutOf(cutover, outgoing), cutoverQuiescence(cutover));
    await finishSwap(paths, instanceId, cutover.releases, dependencies.rename ? { rename: dependencies.rename } : {});
  });
  return advanceOperation(operation, 'swapped');
}

/**
 * Retag the agent images (KTD7): `:latest` moves to the image staging built
 * and `:previous` to the one the assistant ran. The moves are recorded by ID
 * before they are made, so a retag cut short replays exactly; the image
 * `:previous` named before is deleted once the release is recorded.
 */
async function moveAgentImages(cutover: Cutover, record: OperationRecord): Promise<OperationRecord> {
  const base = getInstallScopedNames(cutover.runtime.install_id).containerImageBase;
  const latestTag = `${base}:latest`;
  const previousTag = `${base}:previous`;
  const nextTag = nextAgentImage(cutover.runtime);
  let current = record;
  if (current.images.length === 0) {
    const [ran, kept, built] = await Promise.all([
      imageIdOf(cutover, latestTag),
      imageIdOf(cutover, previousTag),
      imageIdOf(cutover, nextTag),
    ]);
    if (!built || !ran) {
      throw new GwsEaError(
        'agent_image_missing',
        `The agent image ${built ? latestTag : nextTag} is missing, so the release's image cannot take its place.`,
      );
    }
    const images: MovedImage[] = [
      { tag: latestTag, image_id: built, displaced_image_id: ran },
      { tag: previousTag, image_id: ran, displaced_image_id: kept ?? null },
    ];
    const displaced: OperationFollowUp[] =
      kept && kept !== ran && kept !== built ? [{ kind: 'delete_image', image_id: kept }] : [];
    current = await recordOperationFacts(cutover.operation, {
      images,
      follow_ups: planFollowUps(current.follow_ups, displaced),
    });
  }
  for (const image of current.images) await cutoverDocker(cutover, ['tag', image.image_id, image.tag]);
  const latest = current.images.find((image) => image.tag === latestTag);
  // `:next` now names the image `:latest` does, so removing it only removes the tag.
  if (latest && (await imageIdOf(cutover, nextTag)) === latest.image_id) {
    await cutoverDocker(cutover, ['image', 'rm', nextTag]);
  }
  return current;
}

/** The OneCLI versions the release's receipt records; an update never changes them (R9). */
async function releasePins(cutover: Cutover): Promise<OnecliPins> {
  const { onecli } = await readDeployedSetup(cutover.operation.paths, cutover.target);
  return { gateway: onecli.gateway, cli: onecli.cli };
}

/** Whether the release runs another gateway than the one kept with the outgoing release (KTD8). */
async function gatewayChanged(cutover: Cutover, pins: OnecliPins): Promise<boolean> {
  const { paths, instanceId } = cutover.operation;
  const kept = keptReleaseFiles(paths.releaseRoot(instanceId, 'previous'));
  const { gateway } = parseOnecliComposeImages(await readOwnerOnlyFile(kept.compose));
  return gateway !== (await resolveWrapperGatewayImage(pins)).image;
}

/**
 * `swapped` → `started`: stop any host the OS started meanwhile, retag the
 * agent images, recreate the gateway when the release changed it, write the
 * release's service definition, and start the host.
 */
async function startRelease(cutover: Cutover, record: OperationRecord): Promise<OperationRecord> {
  const { operation, reporter } = cutover;
  await keepCutoverHostStopped(cutover);
  await runStep(reporter, { id: 'move_images', label: "Moving the assistant's images to the new release…" }, () =>
    moveAgentImages(cutover, record),
  );
  const pins = await releasePins(cutover);
  if (await gatewayChanged(cutover, pins)) {
    await runStep(reporter, { id: 'recreate_gateway', label: 'Recreating the credential gateway…' }, () =>
      cutoverOnecli(cutover).apply(cutover.onecli, pins),
    );
  }
  await runStep(reporter, { id: 'start_release', label: 'Starting the new release…' }, async () => {
    await writeInstanceServiceDefinition(cutover.release, cutoverServiceDependencies(cutover));
    await cutover.service.start();
  });
  return advanceOperation(operation, 'started');
}

/**
 * `started` → `verified`: the host serves on the release (see
 * `verifyServingRelease`); after a killed host its claim lease lengthens every
 * wait, and when the release changed the gateway the isolation probe runs.
 */
async function verifyRelease(cutover: Cutover, record: OperationRecord): Promise<OperationRecord> {
  await runStep(cutover.reporter, { id: 'verify_release', label: 'Checking the new release serves…' }, async () => {
    const pins = await releasePins(cutover);
    await verifyServingRelease(cutover, {
      view: cutover.target,
      pins,
      leaseHeld: record.stop?.graceful === false,
      gatewayChanged: await gatewayChanged(cutover, pins),
      subject: 'The new release',
    });
  });
  return advanceOperation(cutover.operation, 'verified');
}

/**
 * Go on with a swap an earlier run left under way (KTD2). One cut short
 * before it moved the live checkout is taken back to `stopped`, since the OS
 * may have started the old host from the live path since: its stop,
 * quiescence proof, and carry run again, unconditionally. One that moved it
 * is finished.
 */
async function resumeSwap(cutover: Cutover, record: OperationRecord): Promise<OperationRecord> {
  const { operation, dependencies } = cutover;
  const reversed = await reverseSwapBeforeLiveMoved(
    operation.paths,
    operation.instanceId,
    cutover.releases,
    dependencies.rename ? { rename: dependencies.rename } : {},
  );
  return reversed ? advanceOperation(operation, 'stopped') : record;
}

/** Run the cutover from the phase its record reached until the release is recorded. */
async function runCutover(cutover: Cutover, start: OperationRecord): Promise<void> {
  let record = start.phase === 'swapping' ? await resumeSwap(cutover, start) : start;
  for (;;) {
    switch (record.phase) {
      case 'staged':
      case 'stopped':
        record = await stopAndCarry(cutover, record);
        break;
      case 'swapping':
        record = await swapReleases(cutover);
        break;
      case 'swapped':
        record = await startRelease(cutover, record);
        break;
      case 'started':
        record = await verifyRelease(cutover, record);
        break;
      case 'verified':
        await runStep(cutover.reporter, { id: 'record_release', label: 'Recording the new release…' }, () =>
          commitOperationRelease(cutover.operation),
        );
        return;
      case 'recorded':
        return;
    }
  }
}

/** Where an update left the assistant: the release it runs, the one kept to roll back to, and what its follow-ups said. */
export interface UpdatedAssistant {
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  readonly notes: readonly string[];
}

/**
 * Carry a confirmed update from whatever phase its record reached to its
 * recorded release, then run its follow-ups. A failure before the release is
 * recorded goes to recovery; one after never rolls back, and is left for the
 * next `update --id` to retry.
 */
export async function continueUpdate(
  operation: InstanceOperation,
  dependencies: UpdateDependencies,
): Promise<UpdatedAssistant> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const record = await readOperationRecord(paths, instanceId);
  if (!record || record.kind !== 'update') {
    throw new GwsEaError('operation_missing', `Assistant ${instanceId} has no update under way.`);
  }
  if (record.phase !== 'recorded') {
    let cutover: Cutover | undefined;
    try {
      cutover = await prepareCutover(operation, record, dependencies);
      await runCutover(cutover, record);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Every failure before the commit point goes to recovery, which reports it.
    } catch (error) {
      return recoverUpdate(
        operation,
        {
          record: (await readOperationRecord(paths, instanceId)) ?? record,
          cause: error,
          ...(cutover ? { host: cutover } : {}),
        },
        dependencies,
      );
    }
  }
  return { from: record.from, to: record.to, notes: await finishFollowUps(operation, dependencies) };
}
