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
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { getInstallScopedNames } from '../install-slug.js';
import {
  assertDeploymentCheckoutUnmodified,
  materializeReleaseCheckout,
  observeLiveCheckout,
  prepareReleaseCommandEnvironments,
  resolveToolCommit,
  type CheckoutRuntime,
} from './checkout.js';
import {
  assertCarriable,
  assertCheckoutQuiet,
  carryState,
  finishSwap,
  keepReleaseFiles,
  keptReleaseFiles,
  settleCheckoutDatabases,
  stagedKeptFilesRoot,
  type QuiescenceSeams,
  type QuietCheckout,
  type SwapReleases,
} from './cutover.js';
import { observeManagedGchatRoute, verifyExistingGchatRoute } from './endpoint.js';
import { runStep, type StepReporter } from './events.js';
import { loadCreatedRuntime, type InstanceOperation } from './journal.js';
import { runInstanceNclJson, type InstanceNclOptions } from './ncl.js';
import {
  applyReleaseGateway,
  observeOnecliRuntime,
  prepareReleaseGatewayImage,
  verifyOnecliRuntime,
  type GatewayImageChange,
} from './onecli.js';
import { parseOnecliComposeImages, type OnecliPins, type OnecliRuntimeLayout } from './onecli-compose.js';
import { resolveWrapperGatewayImage } from './onecli-gateway-image.js';
import {
  advanceOperation,
  beginOperation,
  commitOperationRelease,
  completeFollowUp,
  followUpKey,
  operationNextSteps,
  readOperationRecord,
  recordOperationFacts,
  reservationAt,
  targetReservationView,
  type MovedImage,
  type OperationFollowUp,
  type OperationRecord,
  type SnapshotManifest,
} from './operation.js';
import { CONTROL_PLANE_ROOT, instanceMarkerFile, isRegularFile, type ControlPlanePaths } from './paths.js';
import type { Observation } from './phases.js';
import { LAUNCHER_PINS } from './pins.js';
import { pollUntil } from './poll.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { instanceOnecliLayout, readDeployedSetup, writeReleasePreflightReceipt } from './provision.js';
import { redact, safeErrorMessage } from './redact.js';
import { getInstanceReservation } from './registry.js';
import { runReleasePreflight } from './release-preflight.js';
import { resolveReleaseTarget, type ToolProviderSetup, type UpdateReleaseTarget } from './release-target.js';
import { resolveReleaseSource, type ReleaseSource } from './release-tracks.js';
import { readOwnerOnlyFile, readOwnerOnlyJson } from './secrets.js';
import {
  createInstanceRuntimeConfig,
  instanceServiceDefinitionFile,
  readInstanceHostEnvironment,
  stampUpgradeState,
  validateRuntimeConfig,
  writeInstanceServiceDefinition,
  writeReleaseRuntime,
  type HostStatusHelpers,
  type InstanceRuntimeConfig,
  type InstanceServiceDependencies,
  type UpsertEnvVars,
} from './service.js';
import {
  createServiceControl,
  runtimeServiceTarget,
  type InstanceServiceControl,
  type NanoclawServiceHelpers,
  type ServiceControlOptions,
} from './service-control.js';
import { instanceServicePlatform } from './service-coordinates.js';
import {
  GwsEaError,
  INSTANCE_MARKER_SCHEMA_VERSION,
  releaseOf,
  sameRelease,
  type GwsEaErrorDetails,
  type InstanceMarker,
  type InstanceReservation,
  type ReleaseCoordinates,
} from './types.js';
import { isRecord } from './validation.js';
import {
  backupCentralDatabase,
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

/** OneCLI as a cutover moves and checks it; each step defaults to the real one. */
export interface CutoverOnecli {
  /** Recreate the gateway at the image the release builds (KTD8). */
  apply(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<void>;
  /** Its health and versions, and the isolation probe through the gateway: after the gateway changed. */
  verify(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<void>;
  /** Its health alone: when the gateway did not change. */
  observe(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<Observation>;
}

/** Boundary seams; each defaults to the real one. */
export interface UpdateSeams {
  /** The tool's checkout, whose commit an update deploys; the one this control plane runs from by default. */
  readonly toolRoot?: string;
  /** Runs Git, Docker, `ps`, `lsof`, and the release's migration, image build, and tripwire scripts. */
  readonly runCommand?: SanitizedCommandRunner;
  readonly runReleasePreflight?: typeof runReleasePreflight;
  /** Bytes free to this user on the filesystem holding `directory`. */
  readonly freeBytes?: (directory: string) => Promise<number>;
  /** Where the tool environment of the image builds and Docker is read. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
  /** The service manager's platform and user, and the waits every poll takes. */
  readonly service?: ServiceControlOptions;
  /** Reaches the new host's listener and its callback route (public DNS for the route by default). */
  readonly fetch?: typeof globalThis.fetch;
  readonly onecli?: Partial<CutoverOnecli>;
  /** `ncl <args> --json` through the assistant's own host. */
  readonly ncl?: (
    runtime: InstanceRuntimeConfig,
    args: readonly string[],
    options?: InstanceNclOptions,
  ) => Promise<unknown>;
  /** Renames the swap makes. */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

export interface UpdateDependencies extends UpdateSeams {
  /** Upstream's service helpers, which the driver supplies: staging only looks at the service, the cutover controls it. */
  readonly serviceHelpers: NanoclawServiceHelpers;
  /** The tool's provider setup, which the driver reads from `setup/providers`. */
  readonly providerSetup: ToolProviderSetup;
  /** Upstream's `.env` upsert (`setup/set-env.ts`), which the driver supplies: the cutover writes gws-ea's keys with it. */
  readonly upsertEnvVars: UpsertEnvVars;
  /** Upstream's host readiness helpers, which the driver supplies: verification asks the new host for its status. */
  readonly hostStatus: HostStatusHelpers;
  readonly reporter?: StepReporter;
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

function short(commit: string): string {
  return commit.slice(0, 12);
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

/** The image tag an update builds its agent image as, beside the `:latest` the assistant runs. */
function nextAgentImage(runtime: InstanceRuntimeConfig): string {
  return `${getInstallScopedNames(runtime.install_id).containerImageBase}:next`;
}

/** Docker's environment for one assistant: the operator's tools, its home, and its Docker endpoint. */
function dockerEnvironment(runtime: InstanceRuntimeConfig, seams: UpdateSeams): Readonly<Record<string, string>> {
  return buildToolEnvironment(seams.ambientEnv ?? process.env, {
    HOME: runtime.home_directory,
    DOCKER_HOST: runtime.docker_endpoint,
  });
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
  const run = seams.runCommand ?? runSanitizedCommand;
  const image = nextAgentImage(runtime);
  const docker = (args: readonly string[]) =>
    run({
      command: 'docker',
      args,
      cwd: paths.instanceRoot(instanceId),
      env: dockerEnvironment(runtime, seams),
      timeoutMs: DOCKER_TIMEOUT_MS,
    });
  if ((await docker(['image', 'ls', '--quiet', image])).stdout.trim()) await docker(['image', 'rm', image]);
  await rm(paths.releaseRoot(instanceId, 'next'), { recursive: true, force: true });
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
      `gws-ea moved from ${short(intent.target.deployed_commit)} to ${short(target.release.deployed_commit)} while this update started; retry it.`,
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

  const [lockUnchanged, sessionSchemaUnchanged] = await Promise.all([
    sameFiles(live, staged, [AGENT_RUNNER_LOCKFILE]),
    sameFiles(live, staged, SESSION_SCHEMA_SOURCES),
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
 * names to the staged one, with the live schema staging read, and the groups
 * whose image is rebuilt once the release is recorded.
 */
export function recordStagedUpdate(operation: InstanceOperation, staged: StagedUpdate): Promise<OperationRecord> {
  return beginOperation(operation, {
    kind: 'update',
    from: staged.from,
    to: staged.to,
    manifest: staged.manifest,
    follow_ups: staged.preview.groupImages.map((group) => ({
      kind: 'rebuild_group_image' as const,
      agent_group_id: group.id,
    })),
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
  return `${release.release_track} ${short(release.deployed_commit)}`;
}

/** The preview, one fact per line (R8). */
export function updatePreviewLines(preview: UpdatePreview): string[] {
  const { from, to, gateway, groupImages } = preview;
  const groups = groupImages.map((group) => `${group.name} (${group.id})`).join(', ');
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
    ...(preview.migrations.length > 0 || preview.sessionSchemaChanged
      ? [
          `${preview.migrations.length > 0 ? 'This release migrates the database' : "This release changes its session databases' schema"}: a failure after the swap may restore the pre-update snapshot, discarding what the new release recorded before it failed.`,
        ]
      : []),
  ];
}

/** How long the new host may take to serve, and what a killed host's claim lease adds (`src/host-instance.ts`). */
const HOST_READY_MS = 60_000;
const HOST_LEASE_MS = 90_000;
const PROBE_INTERVAL_MS = 1_000;
const LISTENER_TIMEOUT_MS = 10_000;
/** At least the host's own bound on building an agent group's image (`src/container-runner.ts`), plus its restart. */
const GROUP_IMAGE_REBUILD_TIMEOUT_MS = 20 * 60_000;

/** An update that failed before its release was recorded (R14), as recovery receives it. */
export interface FailedCutover {
  /** The update's record as the failure left it: its phase says how far the cutover got. */
  readonly record: OperationRecord;
  readonly cause: unknown;
}

/**
 * Recovery for an update that failed before its release was recorded (R14).
 * Rollback (U9) reverts it here by R13's rule, which the update's own
 * confirmation covers. Until then the record stays open, so every other
 * command is refused, and the failure names the commands that continue or
 * revert it.
 */
export async function recoverUpdate(operation: InstanceOperation, failed: FailedCutover): Promise<never> {
  operation.assertActive();
  const { record, cause } = failed;
  const next = operationNextSteps(record);
  const details: GwsEaErrorDetails = {
    ...(cause instanceof GwsEaError ? cause.details : {}),
    phase: record.phase,
    continueWith: next.continueWith,
    revertWith: next.revertWith ?? null,
  };
  throw new GwsEaError(
    'update_interrupted',
    `${safeErrorMessage(cause)} The update to ${releaseLine(record.to)} stopped at ${record.phase} and is unfinished: ` +
      `continue it with ${next.continueWith}${next.revertWith ? `, or revert it with ${next.revertWith}` : ''}.`,
    { cause, details },
  );
}

/** What every cutover phase works from, read once per run. */
interface Cutover {
  readonly operation: InstanceOperation;
  readonly dependencies: UpdateDependencies;
  readonly reporter: StepReporter;
  readonly run: SanitizedCommandRunner;
  /** The registry's reservation: it names the release the update moves from until the commit point. */
  readonly reservation: InstanceReservation;
  /** The reservation with the update's target overlaid (KTD17). */
  readonly target: InstanceReservation;
  /** The assistant's runtime: its checkout path, install, home, and Docker endpoint are the same on either release. */
  readonly runtime: InstanceRuntimeConfig;
  /** The runtime record the release the update deploys runs with. */
  readonly release: InstanceRuntimeConfig;
  readonly releases: SwapReleases;
  readonly onecli: OnecliRuntimeLayout;
  readonly service: InstanceServiceControl;
  readonly uid: number | undefined;
}

/**
 * The runtime record of whichever of the assistant's releases holds one: the
 * live checkout's, or mid-swap the outgoing release's in `previous/` or the
 * staged one's in `next/`. Only the fields the two releases share are used.
 */
async function readCutoverRuntime(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<InstanceRuntimeConfig> {
  const id = reservation.instance_id;
  const checkouts = [
    reservation.checkout_realpath,
    paths.releaseCheckoutRoot(id, 'previous'),
    paths.releaseCheckoutRoot(id, 'next'),
  ];
  for (const checkout of checkouts) {
    const file = path.join(checkout, 'data', 'gws-ea', 'runtime.json');
    if (!(await isRegularFile(file))) continue;
    const runtime = validateRuntimeConfig(await readOwnerOnlyJson(file, 'Runtime config', 'invalid_runtime_config'));
    if (runtime.instance_id === id && runtime.checkout_realpath === reservation.checkout_realpath) return runtime;
  }
  throw new GwsEaError(
    'runtime_missing',
    `None of assistant ${id}'s releases holds its runtime record, so its update cannot go on.`,
  );
}

async function prepareCutover(
  operation: InstanceOperation,
  record: OperationRecord,
  dependencies: UpdateDependencies,
): Promise<Cutover> {
  const reservation = await getInstanceReservation(operation.paths, operation.instanceId);
  const runtime = await readCutoverRuntime(operation.paths, reservation);
  const onecli = instanceOnecliLayout(operation.paths, reservation, runtime.onecli_cli_path, runtime.docker_endpoint);
  const target = targetReservationView(reservation, record);
  return {
    operation,
    dependencies,
    reporter: dependencies.reporter ?? {},
    run: dependencies.runCommand ?? runSanitizedCommand,
    reservation,
    target,
    runtime,
    release: createInstanceRuntimeConfig(target, onecli, {
      nodePath: runtime.node_path,
      homeDirectory: runtime.home_directory,
      selectedProvider: runtime.selected_provider,
      dockerEndpoint: runtime.docker_endpoint,
    }),
    releases: { from: record.from.deployed_commit, to: record.to.deployed_commit },
    onecli,
    service: createServiceControl(dependencies.serviceHelpers, runtimeServiceTarget(runtime), dependencies.service),
    uid: dependencies.service?.uid ?? process.getuid?.(),
  };
}

/** How every cutover wait sleeps. */
function sleeper({ dependencies }: Cutover): (milliseconds: number) => Promise<void> {
  return dependencies.service?.sleep ?? ((milliseconds) => delay(milliseconds));
}

function quietCheckout(cutover: Cutover, checkoutRoot: string): QuietCheckout {
  return {
    checkoutRoot,
    installId: cutover.runtime.install_id,
    homeDirectory: cutover.runtime.home_directory,
    dockerEndpoint: cutover.runtime.docker_endpoint,
  };
}

function quiescenceSeams({ run, dependencies }: Cutover): QuiescenceSeams {
  return {
    runCommand: run,
    ...(dependencies.service?.platform ? { platform: dependencies.service.platform } : {}),
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
    ...(dependencies.service?.sleep ? { sleep: dependencies.service.sleep } : {}),
  };
}

function serviceDependencies(cutover: Cutover): InstanceServiceDependencies {
  const { dependencies, runtime, uid } = cutover;
  return {
    platform: instanceServicePlatform(dependencies.service?.platform),
    homeDirectory: runtime.home_directory,
    runningAsRoot: uid === 0,
    runCommand: cutover.run,
    ...(uid === undefined ? {} : { uid }),
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
  };
}

function cutoverOnecli({ run, dependencies }: Cutover): CutoverOnecli {
  const boundaries = {
    runCommand: run,
    dockerCommandRunner: run,
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  };
  return {
    apply: dependencies.onecli?.apply ?? ((layout, pins) => applyReleaseGateway(layout, pins, boundaries)),
    verify:
      dependencies.onecli?.verify ??
      (async (layout, pins) => {
        await verifyOnecliRuntime(layout, pins, boundaries);
      }),
    observe: dependencies.onecli?.observe ?? ((layout, pins) => observeOnecliRuntime(layout, pins, boundaries)),
  };
}

function docker(cutover: Cutover, args: readonly string[]) {
  return cutover.run({
    command: 'docker',
    args,
    cwd: cutover.operation.paths.instanceRoot(cutover.operation.instanceId),
    env: dockerEnvironment(cutover.runtime, cutover.dependencies),
    timeoutMs: DOCKER_TIMEOUT_MS,
  });
}

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;

/** The ID of the image `reference` names, or undefined when it names none. */
async function imageIdOf(cutover: Cutover, reference: string): Promise<string | undefined> {
  const listed = new Set(
    (await docker(cutover, ['image', 'ls', '--quiet', '--no-trunc', reference])).stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const [id, ...others] = listed;
  if (id === undefined) return undefined;
  if (others.length > 0 || !IMAGE_ID.test(id)) {
    throw new GwsEaError('invalid_child_output', `Docker reported no single image ID for ${reference}`);
  }
  return id;
}

/** Add follow-ups to those planned, each at most once. */
function plan(planned: readonly OperationFollowUp[], added: readonly OperationFollowUp[]): OperationFollowUp[] {
  const known = new Set(planned.map(followUpKey));
  return [...planned, ...added.filter((followUp) => !known.has(followUpKey(followUp)))];
}

/**
 * Stop the host and its agents. Service control waits until the job is gone;
 * the drain stops the containers the host leaves for the next start to adopt.
 */
async function stopHost(cutover: Cutover): Promise<void> {
  await runStep(cutover.reporter, { id: 'stop_host', label: 'Stopping the assistant for the switch…' }, async () => {
    await cutover.service.stop();
    await cutover.service.drain();
  });
}

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
 * The outgoing release's own files are gathered to be kept beside it.
 */
async function carryIntoRelease(cutover: Cutover): Promise<void> {
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
  const definition = instanceServiceDefinitionFile(runtime, serviceDependencies(cutover));
  await keepReleaseFiles(stagedKeptFilesRoot(paths, instanceId), {
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
  await stopHost(cutover);
  const stoppedAt = new Date().toISOString();
  const { graceful, manifest } = await runStep(
    reporter,
    { id: 'prove_quiet', label: 'Checking nothing still uses its state…' },
    async () => {
      await assertCheckoutQuiet(quietCheckout(cutover, live), quiescenceSeams(cutover));
      const settled = settleCheckoutDatabases(live);
      assertMigrationsUnchanged(record, live);
      return { graceful: settled.graceful, manifest: readSchemaManifest(live) };
    },
  );
  const stopped = await advanceOperation(operation, 'stopped', {
    stop: { at: stoppedAt, graceful },
    manifest,
    follow_ups: plan(record.follow_ups, await displacedGroupImages(cutover, record)),
  });
  await runStep(
    reporter,
    { id: 'carry_state', label: 'Carrying conversations, memory, and settings to the new release…' },
    () => carryIntoRelease(cutover),
  );
  const kept: OperationFollowUp[] = [
    ...((await exists(paths.releaseRoot(instanceId, 'previous')))
      ? [{ kind: 'delete_release' as const, release: 'superseded_previous' as const }]
      : []),
    ...((await exists(paths.releaseRoot(instanceId, 'outgoing')))
      ? [{ kind: 'delete_release' as const, release: 'outgoing' as const }]
      : []),
  ];
  return advanceOperation(operation, 'swapping', { follow_ups: plan(stopped.follow_ups, kept) });
}

/**
 * `swapping` → `swapped` (KTD1): with the host stopped (again, in case the OS
 * started one) and its checkout proven quiet just before the first rename,
 * swap the releases from wherever an interrupted swap left them.
 */
async function swapReleases(cutover: Cutover): Promise<OperationRecord> {
  const { operation, reporter, reservation, dependencies } = cutover;
  const { paths, instanceId } = operation;
  await stopHost(cutover);
  await runStep(reporter, { id: 'swap_releases', label: 'Switching to the new release…' }, async () => {
    // Between the two renames the outgoing release is no longer at the live path, but in previous/.
    const outgoing = (await exists(reservation.checkout_realpath))
      ? reservation.checkout_realpath
      : paths.releaseCheckoutRoot(instanceId, 'previous');
    await assertCheckoutQuiet(quietCheckout(cutover, outgoing), quiescenceSeams(cutover));
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
  const nextTag = `${base}:next`;
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
      follow_ups: plan(current.follow_ups, displaced),
    });
  }
  for (const image of current.images) await docker(cutover, ['tag', image.image_id, image.tag]);
  const latest = current.images.find((image) => image.tag === latestTag);
  // `:next` now names the image `:latest` does, so removing it only removes the tag.
  if (latest && (await imageIdOf(cutover, nextTag)) === latest.image_id) {
    await docker(cutover, ['image', 'rm', nextTag]);
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
  await stopHost(cutover);
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
    await writeInstanceServiceDefinition(cutover.release, serviceDependencies(cutover));
    await cutover.service.start();
  });
  return advanceOperation(operation, 'started');
}

function hostFailure(error: unknown, checkoutRoot: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.replaceAll('logs/nanoclaw.error.log', path.join(checkoutRoot, 'logs', 'nanoclaw.error.log')));
}

/** The listener ID of the host serving the live checkout, once it answers with Google Chat connected. */
async function servingListener(cutover: Cutover, budgetMs: number): Promise<string> {
  const root = cutover.reservation.checkout_realpath;
  const port = cutover.reservation.allocated_ports.nanoclaw_webhook;
  let status: unknown;
  try {
    status = await cutover.dependencies.hostStatus.waitForHost(root, { channel: 'gchat', timeoutMs: budgetMs });
  } catch (error) {
    // Upstream waitForHost reports every failure as a plain Error naming why the host is not ready.
    throw new GwsEaError('host_not_serving', `The new release's host is not serving: ${hostFailure(error, root)}`, {
      cause: error,
    });
  }
  const webhook = isRecord(status) ? status.webhook : undefined;
  if (!isRecord(webhook) || webhook.port !== port || typeof webhook.id !== 'string' || !webhook.id) {
    throw new GwsEaError(
      'host_not_serving',
      `The new release's host answers without its Google Chat listener on port ${port}.`,
    );
  }
  return webhook.id;
}

/** What the local listener answered: its status, and the listener ID it named. */
async function askListener(fetchListener: typeof globalThis.fetch, url: string): Promise<string> {
  try {
    const response = await fetchListener(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(LISTENER_TIMEOUT_MS),
    });
    return `HTTP ${response.status} from listener ${response.headers.get('x-nanoclaw-webhook-id') ?? 'none'}`;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Not answering is itself the answer.
  } catch {
    return 'no answer';
  }
}

/** The new host's listener refuses unsigned traffic with 401 and its own listener ID. */
async function assertListenerServes(cutover: Cutover, listener: string, budgetMs: number): Promise<void> {
  const url = `http://127.0.0.1:${cutover.reservation.allocated_ports.nanoclaw_webhook}/webhook/gchat`;
  const expected = `HTTP 401 from listener ${listener}`;
  const answer = await pollUntil(
    () => askListener(cutover.dependencies.fetch ?? globalThis.fetch, url),
    (seen) => seen === expected,
    { intervalMs: PROBE_INTERVAL_MS, limitMs: budgetMs, sleep: sleeper(cutover) },
  );
  if (answer === expected) return;
  throw new GwsEaError(
    'listener_not_serving',
    `The new release's listener at ${url} answered ${answer}, not 401 from the host's listener ${listener}.`,
  );
}

/** The callback reaches the new listener (managed) or refuses unsigned traffic (existing), observed read-only. */
async function assertRouteServes(cutover: Cutover, listener: string, budgetMs: number): Promise<void> {
  const ingress = cutover.reservation.exclusive_resource_claims.ingress;
  const fetchRoute = cutover.dependencies.fetch ? { fetch: cutover.dependencies.fetch } : {};
  const wait = { intervalMs: PROBE_INTERVAL_MS, limitMs: budgetMs, sleep: sleeper(cutover) };
  if (ingress.mode === 'existing') {
    const failure = await pollUntil(
      () =>
        verifyExistingGchatRoute({ endpointUrl: ingress.endpoint_url }, fetchRoute).then(
          () => undefined,
          (error: unknown) => {
            if (error instanceof GwsEaError) return error;
            throw error;
          },
        ),
      (seen) => seen === undefined,
      wait,
    );
    if (failure) throw failure;
    return;
  }
  const seen = await pollUntil(
    () =>
      observeManagedGchatRoute(
        {
          endpointUrl: ingress.callback_url,
          localEndpointUrl: `http://127.0.0.1:${cutover.reservation.allocated_ports.nanoclaw_webhook}/webhook/gchat`,
        },
        fetchRoute,
      ),
    (route) => route.status === 'routed',
    wait,
  );
  if (seen.status !== 'routed') {
    throw new GwsEaError('route_not_serving', `The assistant's callback does not reach it: ${seen.observed}.`);
  }
  if (seen.listenerId !== listener) {
    throw new GwsEaError('route_not_serving', "The assistant's callback reaches another listener than the new host's.");
  }
}

/**
 * `started` → `verified`: the host serves on the release. Its service is
 * healthy; the live checkout is the target, marker and commit and clean tree,
 * and the host answers for it, which NanoClaw's upgrade tripwire allows only
 * at the commit its checkout was stamped for; its listener answers 401 with
 * the new host's listener ID; OneCLI is healthy, and still isolates agents
 * when the gateway changed; and the callback route reaches it. A killed host's
 * claim lease can delay the new one, so its stop lengthens every wait.
 */
async function verifyRelease(cutover: Cutover, record: OperationRecord): Promise<OperationRecord> {
  const { operation, reporter } = cutover;
  await runStep(reporter, { id: 'verify_release', label: 'Checking the new release serves…' }, async () => {
    // A host that went down since it was started is started again; a running one is left as it is.
    await cutover.service.start();
    const budget = record.stop?.graceful === false ? HOST_READY_MS + HOST_LEASE_MS : HOST_READY_MS;
    if (!(await cutover.service.verifyHealth(budget))) {
      throw new GwsEaError('host_not_serving', "The new release's host service never became healthy.");
    }
    await observeLiveCheckout(cutover.target, [cutover.releases.to], { runCommand: cutover.run });
    const listener = await servingListener(cutover, budget);
    await assertListenerServes(cutover, listener, budget);
    const pins = await releasePins(cutover);
    const onecli = cutoverOnecli(cutover);
    if (await gatewayChanged(cutover, pins)) await onecli.verify(cutover.onecli, pins);
    else {
      const seen = await onecli.observe(cutover.onecli, pins);
      if (seen.status !== 'present') {
        throw new GwsEaError('onecli_not_serving', `The credential vault is not healthy on the new release.`);
      }
    }
    await assertRouteServes(cutover, listener, budget);
  });
  return advanceOperation(operation, 'verified');
}

/** Run the cutover from the phase its record reached until the release is recorded. */
async function runCutover(cutover: Cutover, start: OperationRecord): Promise<void> {
  let record = start;
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

/** Where an update left the assistant: the release it runs, and the one kept to roll back to. */
export interface UpdatedAssistant {
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
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
    try {
      await runCutover(await prepareCutover(operation, record, dependencies), record);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Every failure before the commit point goes to recovery, which reports it.
    } catch (error) {
      return recoverUpdate(operation, {
        record: (await readOperationRecord(paths, instanceId)) ?? record,
        cause: error,
      });
    }
  }
  await finishFollowUps(operation, dependencies);
  return { from: record.from, to: record.to };
}

function describeFollowUp(followUp: OperationFollowUp): string {
  switch (followUp.kind) {
    case 'rebuild_group_image':
      return `rebuilding agent group ${followUp.agent_group_id}'s image`;
    case 'refresh_template':
      return "refreshing main's template";
    case 'reverse_template_restamp':
      return "reversing main's template refresh";
    case 'delete_release':
      return followUp.release === 'outgoing'
        ? 'deleting the outgoing release'
        : 'deleting the superseded previous release';
    case 'delete_image':
      return `deleting image ${followUp.image_id.slice(0, 19)}`;
  }
}

/** Work that brings the release up to date, before any cleanup. */
function isCleanup(followUp: OperationFollowUp): boolean {
  return followUp.kind === 'delete_release' || followUp.kind === 'delete_image';
}

/**
 * Rebuild an agent group's own image on the new base with the assistant's own
 * `ncl` (KTD7): NanoClaw's `buildAgentGroupImage`, then a restart of that
 * group's containers. A group that no longer runs its own image is done.
 */
async function rebuildGroupImage(
  runtime: InstanceRuntimeConfig,
  agentGroupId: string,
  dependencies: UpdateDependencies,
): Promise<void> {
  const base = getInstallScopedNames(runtime.install_id).containerImageBase;
  if (!readDerivedImageGroups(runtime.checkout_realpath, base).some((group) => group.id === agentGroupId)) return;
  const result = await (dependencies.ncl ?? runInstanceNclJson)(
    runtime,
    ['groups', 'restart', '--id', agentGroupId, '--rebuild'],
    { timeoutMs: GROUP_IMAGE_REBUILD_TIMEOUT_MS },
  );
  if (isRecord(result) && result.rebuilt === true) return;
  const reason = isRecord(result) && typeof result.error === 'string' ? `: ${result.error}` : '';
  throw new GwsEaError(
    'group_image_not_rebuilt',
    `NanoClaw did not rebuild agent group ${agentGroupId}'s image${reason}.`,
  );
}

/** Delete an image a retag or rebuild displaced, by ID, unless a tag still names it (KTD19). */
async function deleteDisplacedImage(
  runtime: InstanceRuntimeConfig,
  imageId: string,
  dependencies: UpdateDependencies,
  cwd: string,
): Promise<void> {
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const command = (args: readonly string[]) =>
    run({ command: 'docker', args, cwd, env: dockerEnvironment(runtime, dependencies), timeoutMs: DOCKER_TIMEOUT_MS });
  let tags: unknown;
  try {
    tags = JSON.parse((await command(['image', 'inspect', '--format', '{{json .RepoTags}}', imageId])).stdout);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new GwsEaError('invalid_child_output', 'Docker reported invalid image tags');
    const gone =
      error instanceof GwsEaError &&
      error.code === 'command_failed' &&
      /No such image/iu.test(String(error.details?.stderrTail ?? ''));
    if (gone) return;
    throw error;
  }
  // Docker reports an image no tag names with an empty list, or none at all.
  if (tags !== null && !Array.isArray(tags)) {
    throw new GwsEaError('invalid_child_output', 'Docker reported invalid image tags');
  }
  if (tags !== null && tags.length > 0) return;
  await command(['image', 'rm', imageId]);
}

async function runFollowUp(
  operation: InstanceOperation,
  runtime: InstanceRuntimeConfig,
  followUp: OperationFollowUp,
  dependencies: UpdateDependencies,
): Promise<void> {
  const { paths, instanceId } = operation;
  switch (followUp.kind) {
    case 'rebuild_group_image':
      return rebuildGroupImage(runtime, followUp.agent_group_id, dependencies);
    case 'refresh_template':
    case 'reverse_template_restamp':
      // Planned only by a gws-ea that refreshes templates (U10); this one leaves it for that release to finish.
      throw new GwsEaError(
        'follow_up_unsupported',
        `This gws-ea does not run ${describeFollowUp(followUp)}; finish it with the gws-ea release that planned it.`,
      );
    case 'delete_release':
      return rm(paths.releaseRoot(instanceId, followUp.release === 'outgoing' ? 'outgoing' : 'superseded'), {
        recursive: true,
        force: true,
      });
    case 'delete_image':
      return deleteDisplacedImage(runtime, followUp.image_id, dependencies, paths.instanceRoot(instanceId));
  }
}

/**
 * Run a recorded update's or rollback's follow-ups (KTD2): the per-group image
 * rebuilds first, then, once they all succeeded, the cleanup of the superseded
 * releases and displaced images. Each is struck from the record as it
 * finishes, and the record is deleted with the last. A failure never rolls
 * back: it stays in the record, `status` reports it, and the next
 * `update --id` retries it.
 */
export async function finishFollowUps(operation: InstanceOperation, dependencies: UpdateDependencies): Promise<void> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const record = await readOperationRecord(paths, instanceId);
  if (!record || record.phase !== 'recorded') return;
  const runtime = await loadCreatedRuntime(paths, instanceId);
  const reporter = dependencies.reporter ?? {};
  const failures: string[] = [];
  const attempt = async (followUp: OperationFollowUp, label: string): Promise<void> => {
    try {
      await runStep(reporter, { id: followUp.kind, label }, () =>
        runFollowUp(operation, runtime, followUp, dependencies),
      );
      await completeFollowUp(operation, followUp);
    } catch (error) {
      if (!(error instanceof GwsEaError)) throw error;
      failures.push(`${describeFollowUp(followUp)}: ${safeErrorMessage(error)}`);
    }
  };
  for (const followUp of record.follow_ups.filter((pending) => !isCleanup(pending))) {
    await attempt(followUp, `${sentenceCase(describeFollowUp(followUp))}…`);
  }
  if (failures.length === 0) {
    for (const followUp of record.follow_ups.filter(isCleanup)) {
      await attempt(followUp, 'Cleaning up after the update…');
    }
  }
  if (failures.length === 0) return;
  throw new GwsEaError(
    'follow_ups_failed',
    `Assistant ${instanceId} runs ${releaseLine(record.to)}, but ${failures.length === 1 ? 'a follow-up' : `${failures.length} follow-ups`} of its ${record.kind} failed: ${failures.join('; ')}. ` +
      `gws-ea status --id ${instanceId} lists what is left, and gws-ea update --id ${instanceId} retries it.`,
  );
}

function sentenceCase(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
