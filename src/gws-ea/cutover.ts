/**
 * The cutover's mechanics, shared by update and rollback. Once an assistant's
 * host is stopped, its checkout is proven quiet (KTD18): nothing runs from it,
 * no container carries its install's label in any state, and no process holds
 * anything under its `data/` open. Its databases are then settled — the
 * central WAL folded into `v2.db`, every hot journal rolled back, without
 * running anything of the release's own — and its state carried, root by
 * root and whole, into the checkout that replaces it (KTD9). The two are
 * swapped by renames that recovery can place from wherever they were cut
 * short, then finish or reverse (KTD1, KTD2): an update's swap, and a
 * rollback's, which also sets the kept release's own state aside rather than
 * overwrite it (KTD19).
 *
 * The host side both share lives here too: the service stopped and started
 * through NanoClaw's helpers, agent images looked up by ID, the checks that a
 * started release serves, and the follow-ups a recorded release runs.
 */
import { constants as fsConstants, lstatSync, readdirSync, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lchown,
  lstat,
  lutimes,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import Database from 'better-sqlite3';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { getInstallScopedNames } from '../install-slug.js';
import { MUTABLE_PATHS } from '../mutable-paths.js';
import { observeLiveCheckout } from './checkout.js';
import { observeManagedGchatRoute, verifyExistingGchatRoute } from './endpoint.js';
import { runStep, type StepReporter } from './events.js';
import { loadCreatedRuntime, type InstanceOperation } from './journal.js';
import {
  parseTemplateRestamp,
  refreshMainTemplate,
  reverseMainTemplate,
  type TemplateFollowUp,
  type TemplateRestamp,
} from './main-template.js';
import { runInstanceNclJson, type InstanceNclOptions } from './ncl.js';
import { applyReleaseGateway, observeOnecliRuntime, restoreReleaseGateway, verifyOnecliRuntime } from './onecli.js';
import type { OnecliPins, OnecliRuntimeLayout } from './onecli-compose.js';
import { completeFollowUp, followUpKey, readOperationRecord, type OperationFollowUp } from './operation.js';
import {
  instanceMarkerFile,
  instanceRuntimeFile,
  isRegularFile,
  isWithinDirectory,
  type ControlPlanePaths,
  type ReleaseSlot,
} from './paths.js';
import type { Observation } from './phases.js';
import { pollUntil } from './poll.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { instanceOnecliLayout } from './provision.js';
import { redact, safeErrorMessage } from './redact.js';
import { getInstanceReservation, readInstanceMarkerFile, validateReleaseCoordinates } from './registry.js';
import { readOwnerOnlyFile, readOwnerOnlyJson, writePrivateTextFile } from './secrets.js';
import {
  validateRuntimeConfig,
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
import { GwsEaError, shortCommit, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import { isRecord, requireCanonicalTimestamp } from './validation.js';
import { readDerivedImageGroups } from './verify.js';

/** What a cutover carries from the outgoing checkout into the incoming one: NanoClaw's mutable paths and the host's logs. */
export const CARRIED_ROOTS = [...MUTABLE_PATHS, 'logs'] as const;

/**
 * State under a carried root that stays with its release: its marker and
 * runtime record, which the incoming release gets fresh, and the circuit
 * breaker, which counts only the outgoing release's crashes and could keep
 * the incoming host asleep past its verification. Sockets are never copied.
 */
const RELEASE_BOUND_STATE: ReadonlySet<string> = new Set([
  path.join('data', 'gws-ea', 'instance.json'),
  path.join('data', 'gws-ea', 'runtime.json'),
  path.join('data', 'circuit-breaker.json'),
]);

/** How long containers the drain stopped may take to be removed (`--rm` removes them after they exit). */
const CONTAINER_POLL_MS = 1_000;
const CONTAINER_LIMIT_MS = 30_000;
const PROBE_TIMEOUT_MS = 60_000;

async function lstatIfPresent(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** The checkout a cutover proves quiet, with what Docker needs to look for its containers. */
export interface QuietCheckout {
  readonly checkoutRoot: string;
  readonly installId: string;
  readonly homeDirectory: string;
  readonly dockerEndpoint: string;
}

/** Boundary seams; each defaults to this process's. */
export interface QuiescenceSeams {
  /** Runs `ps`, Docker, and `lsof`. */
  readonly runCommand?: SanitizedCommandRunner;
  readonly platform?: NodeJS.Platform;
  /** Where the tool environment is read. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Where Linux's process table is read. */
  readonly procRoot?: string;
}

/** A process holding a file (or its working directory) open. */
export interface OpenFileHolder {
  readonly pid: number;
  readonly command: string;
  readonly file: string;
}

function toolEnvironment(seams: QuiescenceSeams, overrides: Readonly<Record<string, string>> = {}) {
  return buildToolEnvironment(seams.ambientEnv ?? process.env, overrides);
}

function isInside(file: string, directory: string): boolean {
  return file === directory || isWithinDirectory(file, directory);
}

/**
 * Processes whose arguments name a path inside the checkout: its host, its
 * `ncl`, a script run from it. One only reading its logs (`gws-ea logs
 * --follow`) touches no state. A tool started with relative paths names none,
 * which is what the open-file check is for.
 */
async function processesRunningFrom(
  checkoutRoot: string,
  seams: QuiescenceSeams,
): Promise<Array<{ readonly pid: number; readonly args: string }>> {
  const { stdout } = await (seams.runCommand ?? runSanitizedCommand)({
    command: 'ps',
    args: ['-A', '-ww', '-o', 'pid=', '-o', 'args='],
    cwd: path.dirname(checkoutRoot),
    env: toolEnvironment(seams),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const inside = `${checkoutRoot}${path.sep}`;
  const logs = `${inside}logs${path.sep}`;
  const found: Array<{ pid: number; args: string }> = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = match[2]!;
    if (pid === process.pid) continue;
    if (args.split(inside).length > args.split(logs).length) found.push({ pid, args });
  }
  return found;
}

/** Every container carrying the install's label, in any state. */
async function labeledContainers(checkout: QuietCheckout, seams: QuiescenceSeams): Promise<string[]> {
  const label = getInstallScopedNames(checkout.installId).containerInstallLabel;
  const { stdout } = await (seams.runCommand ?? runSanitizedCommand)({
    command: 'docker',
    args: ['ps', '--all', '--quiet', '--filter', `label=${label}`],
    cwd: checkout.homeDirectory,
    env: toolEnvironment(seams, { HOME: checkout.homeDirectory, DOCKER_HOST: checkout.dockerEndpoint }),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * `lsof` on everything under `directory`, in its field output. It exits 1,
 * printing nothing, when nothing there is open; an error it meets instead is
 * reported on stderr, and fails the check.
 */
async function lsofHolders(directory: string, seams: QuiescenceSeams): Promise<OpenFileHolder[]> {
  let stdout: string;
  try {
    ({ stdout } = await (seams.runCommand ?? runSanitizedCommand)({
      command: 'lsof',
      args: ['-n', '-P', '-w', '-F', 'pcn', '+D', directory],
      cwd: directory,
      env: toolEnvironment(seams),
      timeoutMs: PROBE_TIMEOUT_MS,
    }));
  } catch (error) {
    const quiet =
      error instanceof GwsEaError &&
      error.code === 'command_failed' &&
      error.details?.exitCode === 1 &&
      !error.details.stderrTail;
    if (quiet) return [];
    throw error;
  }
  const holders: OpenFileHolder[] = [];
  let pid = 0;
  let command = 'unknown';
  for (const line of stdout.split('\n')) {
    const value = line.slice(1);
    if (line.startsWith('p')) {
      pid = Number(value);
      command = 'unknown';
    } else if (line.startsWith('c')) command = value;
    else if (line.startsWith('n') && pid > 0 && isInside(value, directory)) holders.push({ pid, command, file: value });
  }
  return holders;
}

/** A process that left, or one this user cannot inspect (it cannot open this user's owner-only state either). */
function unobservable(error: unknown): boolean {
  return ['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].some((code) => isErrno(error, code));
}

/** Linux's process table: each process's working directory and open descriptors under `directory`. */
async function procHolders(directory: string, procRoot: string): Promise<OpenFileHolder[]> {
  const holders: OpenFileHolder[] = [];
  for (const entry of await readdir(procRoot)) {
    if (!/^\d+$/u.test(entry)) continue;
    const base = path.join(procRoot, entry);
    let links: string[];
    try {
      links = [
        path.join(base, 'cwd'),
        ...(await readdir(path.join(base, 'fd'))).map((fd) => path.join(base, 'fd', fd)),
      ];
    } catch (error) {
      if (unobservable(error)) continue;
      throw error;
    }
    const files: string[] = [];
    for (const link of links) {
      try {
        const target = await readlink(link);
        if (isInside(target, directory)) files.push(target);
      } catch (error) {
        if (!unobservable(error)) throw error;
      }
    }
    if (files.length === 0) continue;
    const command = await readFile(path.join(base, 'comm'), 'utf8').then(
      (name) => name.trim() || 'unknown',
      (error: unknown) => {
        if (unobservable(error)) return 'unknown';
        throw error;
      },
    );
    for (const file of files) holders.push({ pid: Number(entry), command, file });
  }
  return holders.sort((left, right) => left.pid - right.pid || left.file.localeCompare(right.file));
}

/**
 * Every process holding anything under `directory` open, its working
 * directory included: `lsof` on macOS, the process table on Linux. A WAL
 * checkpoint cannot see an idle connection, and a process matched by its
 * arguments misses one started with relative paths; this sees both.
 */
export async function openFileHolders(
  directory: string,
  seams: QuiescenceSeams = {},
): Promise<readonly OpenFileHolder[]> {
  const platform = seams.platform ?? process.platform;
  if (platform === 'darwin') return lsofHolders(directory, seams);
  if (platform === 'linux') return procHolders(directory, seams.procRoot ?? '/proc');
  throw new GwsEaError('unsupported_platform', `Proving a checkout quiet needs macOS or Linux, not ${platform}`);
}

function notQuiet(checkoutRoot: string, detail: string): GwsEaError {
  return new GwsEaError(
    'checkout_not_quiet',
    `The assistant's checkout ${checkoutRoot} is not quiet, so the cutover went no further: ${detail}.`,
  );
}

function abbreviated(args: string): string {
  return args.length > 160 ? `${args.slice(0, 157)}...` : args;
}

/**
 * Prove a stopped assistant's checkout quiet (KTD18): no process runs from
 * it, no container carries its install's label in any state (those the drain
 * stopped get a moment to be removed), and no process holds anything under
 * its `data/` open, `-wal`, `-shm`, and `-journal` side files included.
 * Refuses, naming what it found, before anything is copied or moved.
 */
export async function assertCheckoutQuiet(checkout: QuietCheckout, seams: QuiescenceSeams = {}): Promise<void> {
  const root = checkout.checkoutRoot;
  const running = await processesRunningFrom(root, seams);
  if (running.length > 0) {
    throw notQuiet(
      root,
      `${running.map(({ pid, args }) => `PID ${pid} (${abbreviated(args)})`).join('; ')} still run${running.length === 1 ? 's' : ''} from it`,
    );
  }
  const containers = await pollUntil(
    () => labeledContainers(checkout, seams),
    (ids) => ids.length === 0,
    {
      intervalMs: CONTAINER_POLL_MS,
      limitMs: CONTAINER_LIMIT_MS,
      sleep: seams.sleep ?? ((milliseconds) => delay(milliseconds)),
    },
  );
  if (containers.length > 0) {
    throw notQuiet(root, `containers ${containers.join(', ')} still carry its install's label`);
  }
  const data = path.join(root, 'data');
  if (!(await lstatIfPresent(data))?.isDirectory()) return;
  const holders = await openFileHolders(data, seams);
  if (holders.length > 0) {
    throw notQuiet(root, holders.map(({ pid, command, file }) => `${command} (PID ${pid}) holds ${file}`).join('; '));
  }
}

/** How the stopped host left its checkout. */
export interface SettledCheckout {
  /** False when the host was killed: its lease is still live, and delays the next host's claims until it expires. */
  readonly graceful: boolean;
}

/** SQLite's `wal_checkpoint` answer. */
interface CheckpointResult {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

/**
 * Open `file` read-write as SQLite itself, running nothing of the release's:
 * the first read rolls back a hot journal, and a WAL database has its log
 * folded into the main file and truncated. A reader holding the log back
 * leaves busy frames, and is refused rather than waited on.
 */
function settleDatabase<T>(file: string, read: (database: Database.Database) => T): T {
  const database = new Database(file, { fileMustExist: true, timeout: 0 });
  try {
    database.prepare('SELECT count(*) FROM sqlite_master').get();
    if (String(database.pragma('journal_mode', { simple: true })) === 'wal') {
      const [result] = database.pragma('wal_checkpoint(TRUNCATE)') as CheckpointResult[];
      if (!result || result.busy !== 0) {
        throw new GwsEaError(
          'database_busy',
          `${file} still has a reader holding its log back (${result?.busy ?? 'unknown'} busy), so it cannot be copied whole.`,
        );
      }
    }
    return read(database);
  } finally {
    database.close();
  }
}

/** Whether no host left a live lease: a graceful stop marks its row stopped; a release without leases has none. */
function hostStoppedGracefully(database: Database.Database, now: string): boolean {
  const leases = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'host_instances'").get();
  if (!leases) return true;
  return (
    database
      .prepare('SELECT 1 FROM host_instances WHERE stopped_at IS NULL AND lease_expires_at > ? LIMIT 1')
      .get(now) === undefined
  );
}

/** The databases under `directory` that have a `-journal` or `-wal` beside them. */
function databasesWithSideFiles(directory: string): string[] {
  const found = new Set<string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      const side = /^(.*)-(?:journal|wal)$/u.exec(entry.name);
      if (!side || !entry.isFile()) continue;
      const database = path.join(current, side[1]!);
      try {
        if (lstatSync(database).isFile()) found.add(database);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
  };
  walk(directory);
  return [...found].sort();
}

/**
 * Settle a quiet checkout's databases before they are copied (KTD18): a
 * TRUNCATE checkpoint folds the central WAL into `v2.db` and must find no
 * busy frames, and every other database with a side file — a session's hot
 * journal above all — is opened read-write and read once, which rolls it back.
 * No lazy migration runs: only SQLite opens them. Reports whether the host
 * that stopped left its lease stopped.
 */
export function settleCheckoutDatabases(checkoutRoot: string, now: Date = new Date()): SettledCheckout {
  const data = path.join(checkoutRoot, 'data');
  const central = path.join(data, 'v2.db');
  const graceful = settleDatabase(central, (database) => hostStoppedGracefully(database, now.toISOString()));
  for (const file of databasesWithSideFiles(data)) {
    if (file !== central) settleDatabase(file, () => undefined);
  }
  return { graceful };
}

/**
 * A carried root that is a link would be copied as the link, so the kept
 * previous release and the new one would share one state; anything but a
 * file or directory is no state of the install's at all.
 */
export async function assertCarriable(checkoutRoot: string): Promise<void> {
  for (const root of CARRIED_ROOTS) {
    const target = path.join(checkoutRoot, root);
    const info = await lstatIfPresent(target);
    if (!info || info.isFile() || info.isDirectory()) continue;
    throw new GwsEaError(
      'uncarriable_state',
      info.isSymbolicLink()
        ? `${target} is a link, so its copy would share its state with the release kept for rollback; replace it with what it points to, then update.`
        : `${target} is neither a file nor a directory, so it cannot be carried to the new release.`,
    );
  }
}

/** Keep `source`'s owner, mode, and times on `target`: ownership first, since changing it can clear mode bits. */
async function preserve(target: string, source: Stats, link: boolean): Promise<void> {
  const current = await lstat(target);
  if (current.uid !== source.uid || current.gid !== source.gid) {
    try {
      await lchown(target, source.uid, source.gid);
    } catch (error) {
      if (!isErrno(error, 'EPERM')) throw error;
      throw new GwsEaError(
        'uncarriable_state',
        `${target} could not be given the owner of the state it copies (${source.uid}:${source.gid}), so the new release would not read it as the previous one did.`,
        { cause: error },
      );
    }
  }
  if (link) {
    await lutimes(target, source.atime, source.mtime);
    return;
  }
  await chmod(target, source.mode & 0o7777);
  await utimes(target, source.atime, source.mtime);
}

/**
 * Copy one entry of a carried root. Files are cloned where the filesystem
 * can (APFS, Btrfs, XFS), which keeps the offline window short; a directory
 * is made owner-writable while it fills, then given its own mode.
 */
async function copyEntry(source: string, destination: string, relative: string): Promise<void> {
  if (RELEASE_BOUND_STATE.has(relative)) return;
  const info = await lstat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    for (const name of await readdir(source)) {
      await copyEntry(path.join(source, name), path.join(destination, name), path.join(relative, name));
    }
    await preserve(destination, info, false);
  } else if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    await preserve(destination, info, true);
  } else if (info.isFile()) {
    await copyFile(source, destination, fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL);
    await preserve(destination, info, false);
  }
  // A socket, pipe, or device belongs to a process that ran, not to the install's state.
}

/**
 * Carry the outgoing checkout's state into the incoming one (KTD9): each
 * carried root is copied whole into a build area beside the incoming
 * checkout, then replaces its counterpart there whole. Nothing is merged, so
 * a stale `-wal` or `-journal` the incoming checkout held can never be
 * replayed onto a copied database; the outgoing checkout is only read, so it
 * stays the snapshot the previous release is kept as. A carry cut short is
 * started again from scratch.
 */
export async function carryState(fromCheckout: string, toCheckout: string): Promise<void> {
  await assertCarriable(fromCheckout);
  const building = path.join(path.dirname(toCheckout), 'carrying');
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { mode: 0o700 });
  for (const root of CARRIED_ROOTS) {
    const source = path.join(fromCheckout, root);
    const built = path.join(building, root);
    const destination = path.join(toCheckout, root);
    const present = (await lstatIfPresent(source)) !== undefined;
    if (present) await copyEntry(source, built, root);
    await rm(destination, { recursive: true, force: true });
    if (present) await rename(built, destination);
  }
  await rm(building, { recursive: true, force: true });
}

/**
 * What an assistant keeps with each release besides its checkout, so a
 * rollback can put the release back as it ran (KTD6, KTD8): its manifest, its
 * receipt, its OneCLI Compose file, its service definition, and gws-ea's
 * `.env` keys.
 */
export interface KeptReleaseFiles {
  readonly manifest: string;
  readonly receipt: string;
  readonly compose: string;
  readonly serviceDefinition: string;
  readonly hostEnvironment: string;
}

/** Where a release slot (`<instance>/<slot>/`) keeps its release's files. */
export function keptReleaseFiles(releaseRoot: string): KeptReleaseFiles {
  return {
    manifest: path.join(releaseRoot, 'release-manifest.json'),
    receipt: path.join(releaseRoot, 'release-preflight.json'),
    compose: path.join(releaseRoot, 'onecli-compose.yaml'),
    serviceDefinition: path.join(releaseRoot, 'service-definition'),
    hostEnvironment: path.join(releaseRoot, 'host-environment.json'),
  };
}

export const KEPT_RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * What a kept release is: the assistant it belongs to, the release it ran
 * (source, track, and commit, which its marker alone does not name), and when
 * its host stopped for the cutover that kept it, so its checkout's state is
 * as of then. Readers ignore unknown fields.
 */
export interface KeptReleaseManifest {
  readonly schema_version: typeof KEPT_RELEASE_MANIFEST_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly release: ReleaseCoordinates;
  readonly snapshot_at: string;
  /**
   * The restamp of main's template the update that kept this release ran once
   * it was recorded (KTD12): what it changed, recorded before it ran and
   * again once it settled, so a code-only rollback back here can reverse it.
   */
  readonly template_restamp?: TemplateRestamp;
}

/** A kept release's manifest, refused when it belongs to another assistant: a release is restorable only into its own. */
export async function readKeptReleaseManifest(releaseRoot: string, instanceId: string): Promise<KeptReleaseManifest> {
  const file = keptReleaseFiles(releaseRoot).manifest;
  const value = await readOwnerOnlyJson(file, 'Kept release manifest', 'invalid_kept_release');
  const invalid = (detail: string): GwsEaError =>
    new GwsEaError('invalid_kept_release', `The kept release manifest ${file} ${detail}.`);
  if (!isRecord(value) || value.schema_version !== KEPT_RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw invalid('was written by a different gws-ea');
  }
  if (value.instance_id !== instanceId) {
    throw new GwsEaError(
      'kept_release_mismatch',
      `The release kept in ${releaseRoot} belongs to another assistant, so it cannot be restored into ${instanceId}.`,
    );
  }
  let release: ReleaseCoordinates;
  try {
    release = validateReleaseCoordinates(value.release);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    throw invalid('names no valid release');
  }
  return {
    schema_version: KEPT_RELEASE_MANIFEST_SCHEMA_VERSION,
    instance_id: instanceId,
    release,
    snapshot_at: requireCanonicalTimestamp(value.snapshot_at, 'invalid_kept_release', `${file} names no snapshot time`),
    ...(value.template_restamp === undefined
      ? {}
      : { template_restamp: parseTemplateRestamp(value.template_restamp, invalid) }),
  };
}

/** Record main's template restamp with a kept release, in place of any recorded before (one atomic write). */
export async function recordKeptTemplateRestamp(
  releaseRoot: string,
  instanceId: string,
  restamp: TemplateRestamp,
): Promise<void> {
  const manifest = await readKeptReleaseManifest(releaseRoot, instanceId);
  await writePrivate(keptReleaseFiles(releaseRoot).manifest, { ...manifest, template_restamp: restamp });
}

/** The live release's files a cutover keeps. */
export interface KeptReleaseSources {
  readonly manifest: KeptReleaseManifest;
  readonly receipt: string;
  readonly compose: string;
  /** Undefined when the release has no service definition installed. */
  readonly serviceDefinition: string | undefined;
  readonly hostEnvironment: Readonly<Record<string, string>>;
}

/** Where a cutover gathers the live release's files before its swap moves them to `previous/`. */
export function stagedKeptFilesRoot(paths: ControlPlanePaths, instanceId: string): string {
  return path.join(paths.releaseRoot(instanceId, 'next'), 'previous');
}

/** Copy the live release's files into `root`, owner-only, replacing whatever an earlier attempt left there. */
export async function keepReleaseFiles(root: string, sources: KeptReleaseSources): Promise<void> {
  const building = `${root}.building`;
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { mode: 0o700 });
  const kept = keptReleaseFiles(building);
  await writePrivate(kept.manifest, sources.manifest);
  await writePrivateTextFile(kept.receipt, await readOwnerOnlyFile(sources.receipt));
  await writePrivateTextFile(kept.compose, await readOwnerOnlyFile(sources.compose));
  if (sources.serviceDefinition !== undefined) {
    await writePrivateTextFile(kept.serviceDefinition, await readFile(sources.serviceDefinition, 'utf8'));
  }
  await writePrivate(kept.hostEnvironment, sources.hostEnvironment);
  await rm(root, { recursive: true, force: true });
  await rename(building, root);
}

/** The two commits a swap exchanges. */
export interface SwapReleases {
  readonly from: string;
  readonly to: string;
}

/** Boundary seams; each defaults to the real one. */
export interface SwapSeams {
  readonly rename?: (from: string, to: string) => Promise<void>;
}

/**
 * How far a swap got, each stage one rename further (the last removes the
 * emptied `next/`): `ready` → the kept previous release set aside → the live
 * release's files kept in `previous/` → the live checkout moved into it → the
 * staged checkout moved live → its receipt promoted → `next/` removed.
 */
const SWAP_STAGES = [
  'ready',
  'set_aside',
  'kept',
  'live_moved',
  'staged_moved',
  'receipt_promoted',
  'swapped',
] as const;
type SwapStage = (typeof SWAP_STAGES)[number];

interface SwapPlaces {
  readonly live: string;
  readonly liveReceipt: string;
  readonly next: string;
  readonly staged: string;
  readonly stagedReceipt: string;
  readonly kept: string;
  readonly previous: string;
  readonly previousCheckout: string;
  readonly superseded: string;
}

/** What is where: each checkout's marker commit, which directories exist, and which receipt the live one is. */
interface SwapLayout {
  readonly live: string | undefined;
  readonly liveReceipt: string | undefined;
  readonly next: boolean;
  readonly staged: string | undefined;
  readonly stagedReceipt: boolean;
  readonly kept: boolean;
  readonly previous: boolean;
  readonly previousCheckout: string | undefined;
  readonly superseded: boolean;
}

function swapPlaces(paths: ControlPlanePaths, instanceId: string): SwapPlaces {
  return {
    live: paths.checkoutRoot(instanceId),
    liveReceipt: paths.releasePreflightFile(instanceId),
    next: paths.releaseRoot(instanceId, 'next'),
    staged: paths.releaseCheckoutRoot(instanceId, 'next'),
    stagedReceipt: paths.releasePreflightFile(instanceId, 'next'),
    kept: stagedKeptFilesRoot(paths, instanceId),
    previous: paths.releaseRoot(instanceId, 'previous'),
    previousCheckout: paths.releaseCheckoutRoot(instanceId, 'previous'),
    superseded: paths.releaseRoot(instanceId, 'superseded'),
  };
}

function layoutFault(message: string): GwsEaError {
  return new GwsEaError('swap_layout_unknown', message);
}

/** The commit a checkout's marker names, or undefined when there is no checkout there. */
async function markerCommit(checkout: string, instanceId: string): Promise<string | undefined> {
  if (!(await lstatIfPresent(checkout))) return undefined;
  let marker;
  try {
    marker = await readInstanceMarkerFile(instanceMarkerFile(checkout));
  } catch (error) {
    if (error instanceof GwsEaError && error.code === 'marker_missing') {
      throw layoutFault(`${checkout} holds no instance marker, so it is no release of this assistant.`);
    }
    throw error;
  }
  if (marker.instance_id !== instanceId) throw layoutFault(`${checkout} belongs to another assistant.`);
  return marker.deployed_commit;
}

/** The commit a release receipt names, or undefined when there is none. */
async function receiptCommit(file: string, instanceId: string): Promise<string | undefined> {
  if (!(await lstatIfPresent(file))) return undefined;
  const receipt = await readOwnerOnlyJson(file, 'Release preflight receipt', 'invalid_release_preflight');
  if (!isRecord(receipt) || receipt.instance_id !== instanceId || typeof receipt.deployed_commit !== 'string') {
    throw layoutFault(`${file} is not a release receipt of this assistant.`);
  }
  return receipt.deployed_commit;
}

async function observeSwap(places: SwapPlaces, instanceId: string): Promise<SwapLayout> {
  const present = async (target: string): Promise<boolean> => (await lstatIfPresent(target)) !== undefined;
  const [live, liveReceipt, next, staged, stagedReceipt, kept, previous, previousCheckout, superseded] =
    await Promise.all([
      markerCommit(places.live, instanceId),
      receiptCommit(places.liveReceipt, instanceId),
      present(places.next),
      markerCommit(places.staged, instanceId),
      present(places.stagedReceipt),
      present(places.kept),
      present(places.previous),
      markerCommit(places.previousCheckout, instanceId),
      present(places.superseded),
    ]);
  return { live, liveReceipt, next, staged, stagedReceipt, kept, previous, previousCheckout, superseded };
}

/**
 * The stage a layout is at, or undefined for one no swap leaves. Up to the
 * staged checkout's move, the live checkout and receipt are the outgoing
 * release's and the staged ones are waiting in `next/`; from then on, the
 * outgoing checkout is `previous/nanoclaw`. A live receipt missing beside a
 * staged one is where a reversal had moved it back and not yet restored its
 * own.
 */
function swapStage(layout: SwapLayout, { from, to }: SwapReleases): SwapStage | undefined {
  const receiptsWaiting = layout.stagedReceipt && layout.liveReceipt === from;
  if (layout.live === from) {
    if (layout.staged !== to || !receiptsWaiting) return undefined;
    if (!layout.kept) return layout.previous && layout.previousCheckout === undefined ? 'kept' : undefined;
    if (layout.superseded) return layout.previous ? undefined : 'set_aside';
    return layout.previousCheckout === from || layout.previousCheckout === to ? undefined : 'ready';
  }
  if (layout.kept || layout.previousCheckout !== from) return undefined;
  if (layout.live === undefined) return layout.staged === to && receiptsWaiting ? 'live_moved' : undefined;
  if (layout.live !== to || layout.staged !== undefined) return undefined;
  if (layout.stagedReceipt) {
    return layout.liveReceipt === from || layout.liveReceipt === undefined ? 'staged_moved' : undefined;
  }
  if (layout.liveReceipt !== to) return undefined;
  return layout.next ? 'receipt_promoted' : 'swapped';
}

function describeLayout(layout: SwapLayout): string {
  const commit = (value: string | undefined): string => (value === undefined ? 'none' : shortCommit(value));
  return [
    `live ${commit(layout.live)}`,
    `live receipt ${commit(layout.liveReceipt)}`,
    `staged ${commit(layout.staged)}`,
    `staged receipt ${layout.stagedReceipt ? 'present' : 'none'}`,
    `kept files ${layout.kept ? 'staged' : 'not staged'}`,
    `previous ${layout.previous ? commit(layout.previousCheckout) : 'none'}`,
    `set-aside previous ${layout.superseded ? 'present' : 'none'}`,
  ].join(', ');
}

/** Observe the releases and place them, refusing, before anything moves, a layout no swap step leaves. */
async function placeSwap(
  paths: ControlPlanePaths,
  instanceId: string,
  releases: SwapReleases,
): Promise<{ readonly places: SwapPlaces; readonly layout: SwapLayout; readonly stage: number }> {
  const places = swapPlaces(paths, instanceId);
  const layout = await observeSwap(places, instanceId);
  const stage = swapStage(layout, releases);
  if (stage === undefined) {
    throw layoutFault(
      `Assistant ${instanceId}'s releases are in a layout no swap from ${shortCommit(releases.from)} to ${shortCommit(releases.to)} leaves (${describeLayout(layout)}); nothing was moved.`,
    );
  }
  return { places, layout, stage: SWAP_STAGES.indexOf(stage) };
}

/**
 * Swap the live release for the staged one (KTD1), from whatever stage an
 * interrupted swap reached: a kept previous release is set aside as
 * `superseded/` (deleted only once the update is recorded, KTD19), the live
 * release's kept files become `previous/`, the live checkout moves into it,
 * the staged checkout moves live, its receipt is promoted, and the emptied
 * `next/` is removed. The checkout path never changes.
 */
export async function finishSwap(
  paths: ControlPlanePaths,
  instanceId: string,
  releases: SwapReleases,
  seams: SwapSeams = {},
): Promise<void> {
  const move = seams.rename ?? rename;
  const { places, layout, stage } = await placeSwap(paths, instanceId, releases);
  const before = (step: SwapStage): boolean => stage < SWAP_STAGES.indexOf(step);
  if (before('set_aside') && layout.previous) await move(places.previous, places.superseded);
  if (before('kept')) await move(places.kept, places.previous);
  if (before('live_moved')) await move(places.live, places.previousCheckout);
  if (before('staged_moved')) await move(places.staged, places.live);
  if (before('receipt_promoted')) await move(places.stagedReceipt, places.liveReceipt);
  if (before('swapped')) await rm(places.next, { recursive: true, force: true });
}

/**
 * Undo a swap from whatever stage it, or an interrupted reversal, reached,
 * back to where it started: the outgoing release live with its own receipt,
 * the staged release and its receipt in `next/` beside the outgoing release's
 * kept files, and any set-aside previous release back in `previous/`.
 */
export async function reverseSwap(
  paths: ControlPlanePaths,
  instanceId: string,
  releases: SwapReleases,
  seams: SwapSeams = {},
): Promise<void> {
  const move = seams.rename ?? rename;
  const { places, layout, stage } = await placeSwap(paths, instanceId, releases);
  const reached = (step: SwapStage): boolean => stage >= SWAP_STAGES.indexOf(step);
  if (reached('swapped')) await mkdir(places.next, { mode: 0o700 });
  if (reached('receipt_promoted')) await move(places.liveReceipt, places.stagedReceipt);
  if (reached('receipt_promoted') || (reached('staged_moved') && layout.liveReceipt === undefined)) {
    await writePrivateTextFile(places.liveReceipt, await readOwnerOnlyFile(keptReleaseFiles(places.previous).receipt));
  }
  if (reached('staged_moved')) await move(places.live, places.staged);
  if (reached('live_moved')) await move(places.previousCheckout, places.live);
  if (reached('kept')) await move(places.previous, places.kept);
  if (reached('set_aside') && layout.superseded) await move(places.superseded, places.previous);
}

/** Where a rollback's outgoing release keeps what the release it restores left behind (`outgoing/restored/`). */
export function restoredReleaseRoot(paths: ControlPlanePaths, instanceId: string): string {
  return path.join(paths.releaseRoot(instanceId, 'outgoing'), 'restored');
}

/** Where a kept release's own state is set aside while another is carried into its checkout. */
export function setAsideStateRoot(releaseRoot: string): string {
  return path.join(releaseRoot, 'state');
}

/**
 * Set a kept release's own state aside, root by root, so another can be
 * carried into its checkout without overwriting it (KTD19). The roots gather
 * in a building area that is renamed into place once all of them are there;
 * nothing is carried in before, so every carried root still in the checkout
 * is its own, and an interrupted set-aside simply goes on.
 */
export async function setAsideState(checkoutRoot: string, stateRoot: string): Promise<void> {
  if (await lstatIfPresent(stateRoot)) return;
  const building = `${stateRoot}.building`;
  await mkdir(building, { recursive: true, mode: 0o700 });
  for (const root of CARRIED_ROOTS) {
    const source = path.join(checkoutRoot, root);
    if (await lstatIfPresent(source)) await rename(source, path.join(building, root));
  }
  await rename(building, stateRoot);
}

/** The records that name a checkout's release, which a carry leaves out: its marker and runtime record. */
const RELEASE_RECORDS = [path.join('data', 'gws-ea', 'instance.json'), path.join('data', 'gws-ea', 'runtime.json')];

/** Copy a release's own marker and runtime record from its set-aside state into its checkout. */
export async function copyReleaseRecords(stateRoot: string, checkoutRoot: string): Promise<void> {
  for (const record of RELEASE_RECORDS) {
    const source = path.join(stateRoot, record);
    if (!(await lstatIfPresent(source))) continue;
    const destination = path.join(checkoutRoot, record);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writePrivateTextFile(destination, await readOwnerOnlyFile(source));
  }
}

/**
 * Put a kept release's own state back in its checkout, replacing whatever was
 * carried in, from wherever the set-aside or an earlier restore stopped. A
 * set-aside that never finished had nothing carried in, so its roots move
 * back; a finished one is copied back whole, like any carry, with the
 * release's own marker and runtime record, and only then discarded, so an
 * interrupted restore starts over from state that is still whole.
 */
export async function restoreSetAsideState(checkoutRoot: string, stateRoot: string): Promise<void> {
  const building = `${stateRoot}.building`;
  if (await lstatIfPresent(building)) {
    for (const root of CARRIED_ROOTS) {
      const moved = path.join(building, root);
      if (await lstatIfPresent(moved)) await rename(moved, path.join(checkoutRoot, root));
    }
    await rm(building, { recursive: true, force: true });
  }
  const discarded = `${stateRoot}.discarded`;
  if (await lstatIfPresent(stateRoot)) {
    await carryState(stateRoot, checkoutRoot);
    await copyReleaseRecords(stateRoot, checkoutRoot);
    await rename(stateRoot, discarded);
  }
  await rm(discarded, { recursive: true, force: true });
}

/** The two commits a rollback exchanges, and whether it puts back a previous release its update set aside. */
export interface RollbackReleases extends SwapReleases {
  /**
   * The rollback reverts an update that was never recorded: the previous
   * release that update set aside at its swap is the rollback point again.
   */
  readonly restoreSetAside: boolean;
}

/**
 * How far a rollback's swap got, each stage one rename further, starting once
 * the outgoing release's files are kept in `outgoing/`: the outgoing checkout
 * moved there → the restored one moved live → its receipt made the live one →
 * the rest of `previous/` moved to `outgoing/restored/` → a set-aside previous
 * release put back.
 */
const ROLLBACK_STAGES = [
  'prepared',
  'outgoing_moved',
  'previous_moved',
  'receipt_restored',
  'kept_moved',
  'swapped',
] as const;
type RollbackStage = (typeof ROLLBACK_STAGES)[number];

interface RollbackPlaces {
  readonly live: string;
  readonly liveReceipt: string;
  readonly previous: string;
  readonly previousCheckout: string;
  readonly previousReceipt: string;
  readonly outgoing: string;
  readonly outgoingCheckout: string;
  readonly restored: string;
  readonly superseded: string;
}

interface RollbackLayout {
  readonly live: string | undefined;
  readonly liveReceipt: string | undefined;
  readonly previous: boolean;
  readonly previousCheckout: string | undefined;
  readonly previousReceipt: boolean;
  readonly outgoing: boolean;
  readonly outgoingCheckout: string | undefined;
  readonly restored: boolean;
  readonly superseded: boolean;
}

function rollbackPlaces(paths: ControlPlanePaths, instanceId: string): RollbackPlaces {
  const previous = paths.releaseRoot(instanceId, 'previous');
  return {
    live: paths.checkoutRoot(instanceId),
    liveReceipt: paths.releasePreflightFile(instanceId),
    previous,
    previousCheckout: paths.releaseCheckoutRoot(instanceId, 'previous'),
    previousReceipt: keptReleaseFiles(previous).receipt,
    outgoing: paths.releaseRoot(instanceId, 'outgoing'),
    outgoingCheckout: paths.releaseCheckoutRoot(instanceId, 'outgoing'),
    restored: restoredReleaseRoot(paths, instanceId),
    superseded: paths.releaseRoot(instanceId, 'superseded'),
  };
}

async function observeRollback(places: RollbackPlaces, instanceId: string): Promise<RollbackLayout> {
  const present = async (target: string): Promise<boolean> => (await lstatIfPresent(target)) !== undefined;
  const [live, liveReceipt, previous, previousCheckout, previousReceipt, outgoing, outgoingCheckout, restored] =
    await Promise.all([
      markerCommit(places.live, instanceId),
      receiptCommit(places.liveReceipt, instanceId),
      present(places.previous),
      markerCommit(places.previousCheckout, instanceId),
      present(places.previousReceipt),
      present(places.outgoing),
      markerCommit(places.outgoingCheckout, instanceId),
      present(places.restored),
    ]);
  const superseded = await present(places.superseded);
  return {
    live,
    liveReceipt,
    previous,
    previousCheckout,
    previousReceipt,
    outgoing,
    outgoingCheckout,
    restored,
    superseded,
  };
}

/**
 * The stage a layout is at, or undefined for one no rollback leaves. Until
 * the restored checkout moves live, the outgoing release's receipt is the
 * live one; a live receipt missing then is where a return moved the restored
 * release's back and had not yet put the outgoing one's in its place.
 */
function rollbackStage(
  layout: RollbackLayout,
  { from, to, restoreSetAside }: RollbackReleases,
): RollbackStage | undefined {
  if (!layout.outgoing) return undefined;
  const untouched = layout.previousCheckout === to && layout.previousReceipt && !layout.restored;
  if (layout.live === from) {
    return layout.outgoingCheckout === undefined && untouched && layout.liveReceipt === from ? 'prepared' : undefined;
  }
  if (layout.outgoingCheckout !== from) return undefined;
  if (layout.live === undefined) return untouched && layout.liveReceipt === from ? 'outgoing_moved' : undefined;
  if (layout.live !== to) return undefined;
  const emptied = layout.previous && layout.previousCheckout === undefined;
  if (layout.previousReceipt) {
    const receipt = layout.liveReceipt === from || layout.liveReceipt === undefined;
    return emptied && !layout.restored && receipt ? 'previous_moved' : undefined;
  }
  if (layout.liveReceipt !== to) return undefined;
  if (!layout.restored) return emptied ? 'receipt_restored' : undefined;
  if (!restoreSetAside) return layout.previous ? undefined : 'swapped';
  if (layout.superseded) return layout.previous ? undefined : 'kept_moved';
  return layout.previousCheckout !== from && layout.previousCheckout !== to ? 'swapped' : undefined;
}

function describeRollbackLayout(layout: RollbackLayout): string {
  const commit = (value: string | undefined): string => (value === undefined ? 'none' : shortCommit(value));
  return [
    `live ${commit(layout.live)}`,
    `live receipt ${commit(layout.liveReceipt)}`,
    `previous ${layout.previous ? commit(layout.previousCheckout) : 'none'}`,
    `previous receipt ${layout.previousReceipt ? 'present' : 'none'}`,
    `outgoing ${layout.outgoing ? commit(layout.outgoingCheckout) : 'none'}`,
    `restored files ${layout.restored ? 'present' : 'none'}`,
    `set-aside previous ${layout.superseded ? 'present' : 'none'}`,
  ].join(', ');
}

async function placeRollback(
  paths: ControlPlanePaths,
  instanceId: string,
  releases: RollbackReleases,
): Promise<{ readonly places: RollbackPlaces; readonly layout: RollbackLayout; readonly stage: number }> {
  const places = rollbackPlaces(paths, instanceId);
  const layout = await observeRollback(places, instanceId);
  const stage = rollbackStage(layout, releases);
  if (stage === undefined) {
    throw layoutFault(
      `Assistant ${instanceId}'s releases are in a layout no rollback from ${shortCommit(releases.from)} to ${shortCommit(releases.to)} leaves (${describeRollbackLayout(layout)}); nothing was moved.`,
    );
  }
  return { places, layout, stage: ROLLBACK_STAGES.indexOf(stage) };
}

/**
 * Swap the live release for the kept previous one (KTD19), from whatever
 * stage an interrupted swap reached, once the outgoing release's files are
 * kept in `outgoing/`: the live checkout moves to `outgoing/nanoclaw` whole,
 * the previous checkout moves live and its receipt becomes the live one, what
 * else `previous/` held moves to `outgoing/restored/`, and a previous release
 * the reverted update had set aside is put back. The checkout path never
 * changes.
 */
export async function finishRollbackSwap(
  paths: ControlPlanePaths,
  instanceId: string,
  releases: RollbackReleases,
  seams: SwapSeams = {},
): Promise<void> {
  const move = seams.rename ?? rename;
  const { places, layout, stage } = await placeRollback(paths, instanceId, releases);
  const before = (step: RollbackStage): boolean => stage < ROLLBACK_STAGES.indexOf(step);
  if (before('outgoing_moved')) await move(places.live, places.outgoingCheckout);
  if (before('previous_moved')) await move(places.previousCheckout, places.live);
  if (before('receipt_restored')) await move(places.previousReceipt, places.liveReceipt);
  if (before('kept_moved')) await move(places.previous, places.restored);
  if (before('swapped') && releases.restoreSetAside && layout.superseded)
    await move(places.superseded, places.previous);
}

/**
 * Undo a rollback's swap from whatever stage it, or an interrupted return,
 * reached: the outgoing release live again with its own receipt, the restored
 * one back in `previous/` with its receipt and files, and a set-aside previous
 * release put back aside.
 */
export async function reverseRollbackSwap(
  paths: ControlPlanePaths,
  instanceId: string,
  releases: RollbackReleases,
  seams: SwapSeams = {},
): Promise<void> {
  const move = seams.rename ?? rename;
  const { places, layout, stage } = await placeRollback(paths, instanceId, releases);
  const reached = (step: RollbackStage): boolean => stage >= ROLLBACK_STAGES.indexOf(step);
  if (reached('swapped') && releases.restoreSetAside && layout.previous) await move(places.previous, places.superseded);
  if (reached('kept_moved')) await move(places.restored, places.previous);
  if (reached('receipt_restored')) await move(places.liveReceipt, places.previousReceipt);
  if (reached('receipt_restored') || (reached('previous_moved') && layout.liveReceipt === undefined)) {
    await writePrivateTextFile(places.liveReceipt, await readOwnerOnlyFile(keptReleaseFiles(places.outgoing).receipt));
  }
  if (reached('previous_moved')) await move(places.live, places.previousCheckout);
  if (reached('outgoing_moved')) await move(places.outgoingCheckout, places.live);
}

// The host side of a cutover, shared by update and rollback: the assistant's service stopped and started through
// NanoClaw's helpers, its agent images, its credential gateway, the checks that a release serves, and the
// follow-ups that run once a release is recorded.

/** OneCLI as a cutover moves and checks it; each step defaults to the real one. */
export interface CutoverOnecli {
  /** Recreate the gateway at the image the release an update deploys builds (KTD8). */
  apply(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<void>;
  /** Put a kept release's Compose file back and recreate the gateway it names (KTD8). */
  restore(layout: OnecliRuntimeLayout, pins: OnecliPins, compose: string): Promise<void>;
  /** Its health and versions, and the isolation probe through the gateway: after the gateway changed. */
  verify(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<void>;
  /** Its health alone: when the gateway did not change. */
  observe(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<Observation>;
}

/** A cutover's boundary seams; each defaults to the real one. */
export interface CutoverSeams {
  /** Runs Git, Docker, `ps`, `lsof`, and the release's own scripts. */
  readonly runCommand?: SanitizedCommandRunner;
  /** Where the tool environment of Docker and the release's scripts is read. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
  /** The service manager's platform and user, and the waits every poll takes. */
  readonly service?: ServiceControlOptions;
  /** Reaches the host's listener and its callback route (public DNS for the route by default). */
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

/** What a cutover needs from the driver, and its seams. */
export interface CutoverDependencies extends CutoverSeams {
  /** Upstream's service helpers (`scripts/update/service.ts`): the cutover stops and starts the host with them. */
  readonly serviceHelpers: NanoclawServiceHelpers;
  /** Upstream's `.env` upsert (`setup/set-env.ts`): gws-ea's keys are written with it. */
  readonly upsertEnvVars: UpsertEnvVars;
  /** Upstream's host readiness helpers: verification asks the host for its status. */
  readonly hostStatus: HostStatusHelpers;
  readonly reporter?: StepReporter;
}

/** What every step of one cutover works from, read once per run. */
export interface CutoverHost {
  readonly operation: InstanceOperation;
  readonly dependencies: CutoverDependencies;
  readonly reporter: StepReporter;
  readonly run: SanitizedCommandRunner;
  /** The registry's reservation, which names the release the cutover moves from until its commit point. */
  readonly reservation: InstanceReservation;
  /** The assistant's runtime: its checkout path, install, home, and Docker endpoint are the same on every release. */
  readonly runtime: InstanceRuntimeConfig;
  readonly onecli: OnecliRuntimeLayout;
  readonly service: InstanceServiceControl;
  readonly uid: number | undefined;
}

/** Where a cutover may find a runtime record: the live checkout, then the releases kept, staged, and left. */
const RUNTIME_SLOTS = ['previous', 'next', 'outgoing'] as const satisfies readonly ReleaseSlot[];

/**
 * The runtime record of whichever of the assistant's releases holds one: the
 * live checkout's, or mid-swap a kept, staged, or outgoing release's. Only
 * the fields every release shares are used.
 */
async function readCutoverRuntime(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<InstanceRuntimeConfig> {
  const id = reservation.instance_id;
  const checkouts = [
    reservation.checkout_realpath,
    ...RUNTIME_SLOTS.map((slot) => paths.releaseCheckoutRoot(id, slot)),
  ];
  for (const checkout of checkouts) {
    const file = instanceRuntimeFile(checkout);
    if (!(await isRegularFile(file))) continue;
    const runtime = validateRuntimeConfig(await readOwnerOnlyJson(file, 'Runtime config', 'invalid_runtime_config'));
    if (runtime.instance_id === id && runtime.checkout_realpath === reservation.checkout_realpath) return runtime;
  }
  throw new GwsEaError(
    'runtime_missing',
    `None of assistant ${id}'s releases holds its runtime record, so its update or rollback cannot go on.`,
  );
}

/** Read what one cutover works from: the reservation, the runtime some release holds, and its service. */
export async function openCutoverHost(
  operation: InstanceOperation,
  dependencies: CutoverDependencies,
): Promise<CutoverHost> {
  const reservation = await getInstanceReservation(operation.paths, operation.instanceId);
  const runtime = await readCutoverRuntime(operation.paths, reservation);
  return {
    operation,
    dependencies,
    reporter: dependencies.reporter ?? {},
    run: dependencies.runCommand ?? runSanitizedCommand,
    reservation,
    runtime,
    onecli: instanceOnecliLayout(operation.paths, reservation, runtime.onecli_cli_path, runtime.docker_endpoint),
    service: createServiceControl(dependencies.serviceHelpers, runtimeServiceTarget(runtime), dependencies.service),
    uid: dependencies.service?.uid ?? process.getuid?.(),
  };
}

/** How every cutover wait sleeps. */
export function cutoverSleep({ dependencies }: CutoverHost): (milliseconds: number) => Promise<void> {
  return dependencies.service?.sleep ?? ((milliseconds) => delay(milliseconds));
}

/** The checkout at `checkoutRoot` as the quiescence proof looks for it. */
export function quietCheckoutOf(host: CutoverHost, checkoutRoot: string): QuietCheckout {
  return {
    checkoutRoot,
    installId: host.runtime.install_id,
    homeDirectory: host.runtime.home_directory,
    dockerEndpoint: host.runtime.docker_endpoint,
  };
}

export function cutoverQuiescence({ run, dependencies }: CutoverHost): QuiescenceSeams {
  return {
    runCommand: run,
    ...(dependencies.service?.platform ? { platform: dependencies.service.platform } : {}),
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
    ...(dependencies.service?.sleep ? { sleep: dependencies.service.sleep } : {}),
  };
}

/** What writing the assistant's service definition needs. */
export function cutoverServiceDependencies(host: CutoverHost): InstanceServiceDependencies {
  const { dependencies, runtime, uid } = host;
  return {
    platform: instanceServicePlatform(dependencies.service?.platform),
    homeDirectory: runtime.home_directory,
    runningAsRoot: uid === 0,
    runCommand: host.run,
    ...(uid === undefined ? {} : { uid }),
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
  };
}

export function cutoverOnecli({ run, dependencies }: CutoverHost): CutoverOnecli {
  const boundaries = {
    runCommand: run,
    dockerCommandRunner: run,
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  };
  return {
    apply: dependencies.onecli?.apply ?? ((layout, pins) => applyReleaseGateway(layout, pins, boundaries)),
    restore:
      dependencies.onecli?.restore ??
      ((layout, pins, compose) => restoreReleaseGateway(layout, pins, compose, boundaries)),
    verify:
      dependencies.onecli?.verify ??
      (async (layout, pins) => {
        await verifyOnecliRuntime(layout, pins, boundaries);
      }),
    observe: dependencies.onecli?.observe ?? ((layout, pins) => observeOnecliRuntime(layout, pins, boundaries)),
  };
}

/** Docker's environment for one assistant: the operator's tools, its home, and its Docker endpoint. */
export function dockerEnvironment(
  runtime: InstanceRuntimeConfig,
  seams: Pick<CutoverSeams, 'ambientEnv'>,
): Readonly<Record<string, string>> {
  return buildToolEnvironment(seams.ambientEnv ?? process.env, {
    HOME: runtime.home_directory,
    DOCKER_HOST: runtime.docker_endpoint,
  });
}

export function cutoverDocker(host: CutoverHost, args: readonly string[]) {
  return host.run({
    command: 'docker',
    args,
    cwd: host.operation.paths.instanceRoot(host.operation.instanceId),
    env: dockerEnvironment(host.runtime, host.dependencies),
    timeoutMs: DOCKER_TIMEOUT_MS,
  });
}

const DOCKER_TIMEOUT_MS = 60_000;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;

/** The ID of the image `reference` names, or undefined when it names none. */
export async function imageIdOf(host: CutoverHost, reference: string): Promise<string | undefined> {
  const listed = new Set(
    (await cutoverDocker(host, ['image', 'ls', '--quiet', '--no-trunc', reference])).stdout
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

/** The tag an update builds its agent image as, beside the `:latest` the assistant runs. */
export function nextAgentImage(runtime: Pick<InstanceRuntimeConfig, 'install_id'>): string {
  return `${getInstallScopedNames(runtime.install_id).containerImageBase}:next`;
}

/** Add follow-ups to those planned, each at most once. */
export function planFollowUps(
  planned: readonly OperationFollowUp[],
  added: readonly OperationFollowUp[],
): OperationFollowUp[] {
  const known = new Set(planned.map(followUpKey));
  return [...planned, ...added.filter((followUp) => !known.has(followUpKey(followUp)))];
}

/**
 * Stop the host and its agents. Service control waits until the job is gone;
 * the drain stops the containers the host leaves for the next start to adopt.
 */
export async function stopCutoverHost(host: CutoverHost, label: string): Promise<void> {
  await runStep(host.reporter, { id: 'stop_host', label }, async () => {
    await host.service.stop();
    await host.service.drain();
  });
}

/**
 * Remove an update's staging: the `:next` image, then `next/`. The image goes
 * first, so a staging whose image could not be removed is still found as
 * abandoned.
 */
export async function removeUpdateStaging(
  paths: ControlPlanePaths,
  instanceId: string,
  runtime: InstanceRuntimeConfig,
  seams: Pick<CutoverSeams, 'runCommand' | 'ambientEnv'>,
): Promise<void> {
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

/** How long a started host may take to serve, and what a killed host's claim lease adds (`src/host-instance.ts`). */
const HOST_READY_MS = 60_000;
const HOST_LEASE_MS = 90_000;
const PROBE_INTERVAL_MS = 1_000;
const LISTENER_TIMEOUT_MS = 10_000;

function hostFailure(error: unknown, checkoutRoot: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.replaceAll('logs/nanoclaw.error.log', path.join(checkoutRoot, 'logs', 'nanoclaw.error.log')));
}

/** The listener ID of the host serving the live checkout, once it answers with Google Chat connected. */
async function servingListener(host: CutoverHost, budgetMs: number, subject: string): Promise<string> {
  const root = host.reservation.checkout_realpath;
  const port = host.reservation.allocated_ports.nanoclaw_webhook;
  let status: unknown;
  try {
    status = await host.dependencies.hostStatus.waitForHost(root, { channel: 'gchat', timeoutMs: budgetMs });
  } catch (error) {
    // Upstream waitForHost reports every failure as a plain Error naming why the host is not ready.
    throw new GwsEaError('host_not_serving', `${subject}'s host is not serving: ${hostFailure(error, root)}`, {
      cause: error,
    });
  }
  const webhook = isRecord(status) ? status.webhook : undefined;
  if (!isRecord(webhook) || webhook.port !== port || typeof webhook.id !== 'string' || !webhook.id) {
    throw new GwsEaError(
      'host_not_serving',
      `${subject}'s host answers without its Google Chat listener on port ${port}.`,
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

/** The host's listener refuses unsigned traffic with 401 and its own listener ID. */
async function assertListenerServes(host: CutoverHost, listener: string, budgetMs: number, subject: string) {
  const url = `http://127.0.0.1:${host.reservation.allocated_ports.nanoclaw_webhook}/webhook/gchat`;
  const expected = `HTTP 401 from listener ${listener}`;
  const answer = await pollUntil(
    () => askListener(host.dependencies.fetch ?? globalThis.fetch, url),
    (seen) => seen === expected,
    { intervalMs: PROBE_INTERVAL_MS, limitMs: budgetMs, sleep: cutoverSleep(host) },
  );
  if (answer === expected) return;
  throw new GwsEaError(
    'listener_not_serving',
    `${subject}'s listener at ${url} answered ${answer}, not 401 from the host's listener ${listener}.`,
  );
}

/** The callback reaches the host's listener (managed) or refuses unsigned traffic (existing), observed read-only. */
async function assertRouteServes(host: CutoverHost, listener: string, budgetMs: number): Promise<void> {
  const ingress = host.reservation.exclusive_resource_claims.ingress;
  const fetchRoute = host.dependencies.fetch ? { fetch: host.dependencies.fetch } : {};
  const wait = { intervalMs: PROBE_INTERVAL_MS, limitMs: budgetMs, sleep: cutoverSleep(host) };
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
          localEndpointUrl: `http://127.0.0.1:${host.reservation.allocated_ports.nanoclaw_webhook}/webhook/gchat`,
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
    throw new GwsEaError('route_not_serving', "The assistant's callback reaches another listener than the host's.");
  }
}

/** What a release must show to count as serving. */
export interface ServingRelease {
  /** The reservation with that release overlaid (KTD17): its commit must be the live checkout's. */
  readonly view: InstanceReservation;
  /** The OneCLI versions its receipt records. */
  readonly pins: OnecliPins;
  /** The stop killed the host, so its claim lease delays the next one's (KTD18). */
  readonly leaseHeld: boolean;
  /** It runs another gateway than the release it replaced, so the isolation probe runs again (KTD8). */
  readonly gatewayChanged: boolean;
  /** How failures name it, such as "The new release". */
  readonly subject: string;
}

/**
 * Check a started release serves. Its service is healthy; the live checkout
 * is the release, marker and commit and clean tree, and the host answers for
 * it, which NanoClaw's upgrade tripwire allows only at the commit its
 * checkout was stamped for; its listener answers 401 with the host's own
 * listener ID; OneCLI is healthy, and still isolates agents when the gateway
 * changed; and the callback route reaches it. A killed host's claim lease can
 * delay the new one, so it lengthens every wait. A host that went down since
 * it was started is started again; a running one is left as it is.
 */
export async function verifyServingRelease(host: CutoverHost, release: ServingRelease): Promise<void> {
  const { subject } = release;
  await host.service.start();
  const budget = release.leaseHeld ? HOST_READY_MS + HOST_LEASE_MS : HOST_READY_MS;
  if (!(await host.service.verifyHealth(budget))) {
    throw new GwsEaError('host_not_serving', `${subject}'s host service never became healthy.`);
  }
  await observeLiveCheckout(release.view, [release.view.deployed_commit], { runCommand: host.run });
  const listener = await servingListener(host, budget, subject);
  await assertListenerServes(host, listener, budget, subject);
  const onecli = cutoverOnecli(host);
  if (release.gatewayChanged) await onecli.verify(host.onecli, release.pins);
  else {
    const seen = await onecli.observe(host.onecli, release.pins);
    if (seen.status !== 'present') {
      throw new GwsEaError('onecli_not_serving', `The credential vault is not healthy on ${subject.toLowerCase()}.`);
    }
  }
  await assertRouteServes(host, listener, budget);
}

/** At least the host's own bound on building an agent group's image (`src/container-runner.ts`), plus its restart. */
const GROUP_IMAGE_REBUILD_TIMEOUT_MS = 20 * 60_000;

function releaseLine(release: ReleaseCoordinates): string {
  return `${release.release_track} ${shortCommit(release.deployed_commit)}`;
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
 * Rebuild an agent group's own image on the base the release runs with the
 * assistant's own `ncl` (KTD7): NanoClaw's `buildAgentGroupImage`, then a
 * restart of that group's containers. A group that no longer runs its own
 * image is done.
 */
async function rebuildGroupImage(
  runtime: InstanceRuntimeConfig,
  agentGroupId: string,
  dependencies: CutoverSeams,
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

/** The tags `docker image inspect --format '{{json .RepoTags}}'` reports. */
export function imageTags(output: string): readonly string[] {
  let tags: unknown;
  try {
    tags = JSON.parse(output);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new GwsEaError('invalid_child_output', 'Docker reported invalid image tags', { cause: error });
  }
  // Docker reports an image no tag names with an empty list, or none at all.
  if (tags === null) return [];
  if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === 'string')) {
    throw new GwsEaError('invalid_child_output', 'Docker reported invalid image tags');
  }
  return tags;
}

/** Delete an image a retag or rebuild displaced, by ID, unless a tag still names it (KTD19). */
async function deleteDisplacedImage(
  runtime: InstanceRuntimeConfig,
  imageId: string,
  dependencies: CutoverSeams,
  cwd: string,
): Promise<void> {
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const command = (args: readonly string[]) =>
    run({ command: 'docker', args, cwd, env: dockerEnvironment(runtime, dependencies), timeoutMs: DOCKER_TIMEOUT_MS });
  let inspected: string;
  try {
    inspected = (await command(['image', 'inspect', '--format', '{{json .RepoTags}}', imageId])).stdout;
  } catch (error) {
    const gone =
      error instanceof GwsEaError &&
      error.code === 'command_failed' &&
      /No such image/iu.test(String(error.details?.stderrTail ?? ''));
    if (gone) return;
    throw error;
  }
  if (imageTags(inspected).length > 0) return;
  await command(['image', 'rm', imageId]);
}

/**
 * A template follow-up's view of the release its restamp is recorded with:
 * for a refresh, the one the update kept in `previous/`; for a reversal, the
 * restored release's own files, which its rollback moved to
 * `outgoing/restored/`.
 */
function templateFollowUp(
  operation: InstanceOperation,
  runtime: InstanceRuntimeConfig,
  releaseRoot: string,
  dependencies: CutoverSeams,
): TemplateFollowUp {
  return {
    runtime,
    ncl: dependencies.ncl ?? runInstanceNclJson,
    recorded: async () => {
      try {
        return (await readKeptReleaseManifest(releaseRoot, operation.instanceId)).template_restamp;
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
        throw new GwsEaError(
          'kept_release_missing',
          `The release kept in ${releaseRoot} has no manifest, so main's template restamp cannot be recorded with it.`,
        );
      }
    },
    record: (restamp) => recordKeptTemplateRestamp(releaseRoot, operation.instanceId, restamp),
  };
}

/** Run one follow-up; returns what the operator is told about it, if anything. */
async function runFollowUp(
  operation: InstanceOperation,
  runtime: InstanceRuntimeConfig,
  followUp: OperationFollowUp,
  dependencies: CutoverSeams,
): Promise<string | undefined> {
  const { paths, instanceId } = operation;
  switch (followUp.kind) {
    case 'rebuild_group_image':
      await rebuildGroupImage(runtime, followUp.agent_group_id, dependencies);
      return undefined;
    case 'refresh_template':
      return refreshMainTemplate(
        templateFollowUp(operation, runtime, paths.releaseRoot(instanceId, 'previous'), dependencies),
      );
    case 'reverse_template_restamp':
      return reverseMainTemplate(
        templateFollowUp(operation, runtime, restoredReleaseRoot(paths, instanceId), dependencies),
      );
    case 'delete_release':
      await rm(paths.releaseRoot(instanceId, followUp.release === 'outgoing' ? 'outgoing' : 'superseded'), {
        recursive: true,
        force: true,
      });
      return undefined;
    case 'delete_image':
      await deleteDisplacedImage(runtime, followUp.image_id, dependencies, paths.instanceRoot(instanceId));
      return undefined;
  }
}

function sentenceCase(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * Run a recorded update's or rollback's follow-ups (KTD2): the per-group image
 * rebuilds and main's template refresh or its reversal first, then, once they
 * all succeeded, the cleanup of the superseded releases and displaced images.
 * Each is struck from the record as it finishes, and the record is deleted
 * with the last. A failure never rolls back: it stays in the record, `status`
 * reports it, and the next run of the same command retries it. Returns what
 * the operator is told about the follow-ups that finished.
 */
export async function finishFollowUps(
  operation: InstanceOperation,
  dependencies: CutoverDependencies,
): Promise<readonly string[]> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const record = await readOperationRecord(paths, instanceId);
  if (!record || record.phase !== 'recorded') return [];
  const runtime = await loadCreatedRuntime(paths, instanceId);
  const reporter = dependencies.reporter ?? {};
  const failures: string[] = [];
  const notes: string[] = [];
  const attempt = async (followUp: OperationFollowUp, label: string): Promise<void> => {
    try {
      const note = await runStep(reporter, { id: followUp.kind, label }, () =>
        runFollowUp(operation, runtime, followUp, dependencies),
      );
      await completeFollowUp(operation, followUp);
      if (note) notes.push(note);
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
      await attempt(followUp, `Cleaning up after the ${record.kind}…`);
    }
  }
  if (failures.length === 0) return notes;
  throw new GwsEaError(
    'follow_ups_failed',
    `Assistant ${instanceId} runs ${releaseLine(record.to)}, but ${failures.length === 1 ? 'a follow-up' : `${failures.length} follow-ups`} of its ${record.kind} failed: ${failures.join('; ')}. ` +
      `gws-ea status --id ${instanceId} lists what is left, and gws-ea ${record.kind} --id ${instanceId} retries it.` +
      notes.map((note) => ` ${note}`).join(''),
  );
}
