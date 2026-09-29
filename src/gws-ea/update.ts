/**
 * `update`, up to its confirmation (R7, R8, R9, R12). Every refusal comes
 * before anything changes. Then, while the assistant keeps serving, the tool's
 * own release is staged beside the live checkout (KTD1): fetched, installed,
 * built, and preflighted in `<instance>/next/nanoclaw` with its receipt under
 * `next/`, its migrations tried on a copy of the live central database
 * (KTD15), its agent image built as `<base>:next` (KTD7), and its gateway
 * image built when the release changes it (KTD8). The preview then says what
 * the cutover will change.
 *
 * Nothing live changes before the operator confirms. A decline or a staging
 * failure writes no record and removes `next/` and the `:next` image; a
 * staging cut short (Ctrl-C, a kill) leaves them for the next update to remove
 * (KTD2). Confirming records the update at `staged`, from where its cutover
 * continues.
 */
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { getInstallScopedNames } from '../install-slug.js';
import {
  assertDeploymentCheckoutUnmodified,
  materializeReleaseCheckout,
  prepareReleaseCommandEnvironments,
  resolveToolCommit,
  type CheckoutRuntime,
} from './checkout.js';
import { runStep, type StepReporter } from './events.js';
import { loadCreatedRuntime, type InstanceOperation } from './journal.js';
import { prepareReleaseGatewayImage, type GatewayImageChange } from './onecli.js';
import {
  beginOperation,
  readOperationRecord,
  reservationAt,
  type OperationRecord,
  type SnapshotManifest,
} from './operation.js';
import { CONTROL_PLANE_ROOT, type ControlPlanePaths } from './paths.js';
import { LAUNCHER_PINS } from './pins.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { instanceOnecliLayout, writeReleasePreflightReceipt } from './provision.js';
import { getInstanceReservation } from './registry.js';
import { runReleasePreflight } from './release-preflight.js';
import { resolveReleaseTarget, type ToolProviderSetup, type UpdateReleaseTarget } from './release-target.js';
import { resolveReleaseSource, type ReleaseSource } from './release-tracks.js';
import type { InstanceRuntimeConfig } from './service.js';
import {
  createServiceControl,
  runtimeServiceTarget,
  type NanoclawServiceHelpers,
  type ServiceControlOptions,
} from './service-control.js';
import { GwsEaError, releaseOf, sameRelease, type InstanceReservation, type ReleaseCoordinates } from './types.js';
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

/** Boundary seams; each defaults to the real one. */
export interface UpdateSeams {
  /** The tool's checkout, whose commit an update deploys; the one this control plane runs from by default. */
  readonly toolRoot?: string;
  /** Runs Git, Docker, and the release's migration script and image build. */
  readonly runCommand?: SanitizedCommandRunner;
  readonly runReleasePreflight?: typeof runReleasePreflight;
  /** Bytes free to this user on the filesystem holding `directory`. */
  readonly freeBytes?: (directory: string) => Promise<number>;
  /** Where the tool environment of the image builds and Docker is read. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly service?: ServiceControlOptions;
}

export interface UpdateDependencies extends UpdateSeams {
  /** Upstream's service helpers, which the driver supplies; staging only looks at the service. */
  readonly serviceHelpers: NanoclawServiceHelpers;
  /** The tool's provider setup, which the driver reads from `setup/providers`. */
  readonly providerSetup: ToolProviderSetup;
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
