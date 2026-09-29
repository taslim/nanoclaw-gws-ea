import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import {
  assertOwnedDestination,
  assertPrivateDirectory,
  instanceMarkerFile,
  preparePrivateDirectory,
  type ControlPlanePaths,
  type ReleaseSlot,
} from './paths.js';
import {
  assertCheckoutMarker,
  assertRegistryMarkerAgreement,
  getInstanceReservation,
  readInstanceMarkerFile,
} from './registry.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import type { ReleaseSource } from './release-tracks.js';
import {
  GwsEaError,
  INSTANCE_MARKER_SCHEMA_VERSION,
  sameRelease,
  type InstanceMarker,
  type InstanceReservation,
} from './types.js';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export interface ResolvedRelease {
  sourceRemote: string;
  releaseRef: string;
  commit: string;
}

export interface CheckoutRuntime {
  runCommand?: SanitizedCommandRunner;
  fetchAuthentication?: GitFetchAuthentication;
}

export interface GitFetchAuthentication {
  askPassProgram?: string;
  sshAgentSocket?: string;
}

export interface ReleaseCommandEnvironments {
  common: Readonly<Record<string, string>>;
  git: Readonly<Record<string, string>>;
}

/** Build the tool environment rooted in storage owned by this release operation. */
export async function prepareReleaseCommandEnvironments(ownerRoot: string): Promise<ReleaseCommandEnvironments> {
  const home = path.join(ownerRoot, '.release-home');
  await preparePrivateDirectory(home);
  const common = buildToolEnvironment(process.env, { HOME: home });
  return {
    common,
    git: { ...common, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  };
}

function fetchEnvironment(
  environment: Readonly<Record<string, string>>,
  authentication: GitFetchAuthentication | undefined,
): Readonly<Record<string, string>> {
  if (!authentication) return environment;
  const result = { ...environment };
  if (authentication.askPassProgram) result.GIT_ASKPASS = authentication.askPassProgram;
  if (authentication.sshAgentSocket) result.SSH_AUTH_SOCK = authentication.sshAgentSocket;
  return result;
}

function validateSourceRemote(sourceRemote: string): void {
  if (
    sourceRemote.length === 0 ||
    sourceRemote.length > 4096 ||
    sourceRemote.startsWith('-') ||
    [...sourceRemote].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code === 0 || code === 0x0a || code === 0x0d);
    })
  ) {
    throw new GwsEaError('invalid_source_remote', 'Source remote is invalid');
  }
}

function validateCommit(commit: string): string {
  const normalized = commit.toLowerCase();
  if (!COMMIT_PATTERN.test(normalized)) {
    throw new GwsEaError('invalid_release_commit', 'Resolved release commit must be a full object ID');
  }
  return normalized;
}

async function assertValidReleaseRef(
  repository: string,
  releaseRef: string,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  if (!releaseRef || releaseRef.startsWith('-') || releaseRef.length > 256) {
    throw new GwsEaError('invalid_release_ref', 'Release ref is invalid');
  }
  try {
    await run({
      command: 'git',
      args: ['check-ref-format', '--allow-onelevel', releaseRef],
      cwd: repository,
      env: environment,
    });
  } catch {
    throw new GwsEaError('invalid_release_ref', 'Release ref is invalid');
  }
}

/**
 * Run `use` with release command environments whose HOME is a scratch
 * directory outside every instance, removed afterwards: Git reads no
 * operator configuration, and nothing is created under an instance.
 */
async function withScratchEnvironments<T>(
  prefix: string,
  use: (environments: ReleaseCommandEnvironments, scratchRoot: string) => Promise<T>,
): Promise<T> {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await use(await prepareReleaseCommandEnvironments(scratchRoot), scratchRoot);
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

/**
 * The files a checkout's tracked tree differs in. Untracked files belong to no
 * release, and Git takes no optional lock, so its index is never rewritten.
 */
async function trackedChanges(
  checkoutRoot: string,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<string[]> {
  const { stdout } = await run({
    command: 'git',
    args: ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=no'],
    cwd: checkoutRoot,
    env: environment,
  });
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
}

/** The tool's own commit, read in its checkout; see `resolveToolCommit`. */
async function readToolCommit(
  toolRoot: string,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  const git = async (args: readonly string[]): Promise<string> =>
    (await run({ command: 'git', args, cwd: toolRoot, env: environment })).stdout;
  let head: string;
  try {
    head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch (error) {
    if (!(error instanceof GwsEaError) || error.code !== 'command_failed') throw error;
    throw new GwsEaError(
      'tool_checkout_unknown',
      `gws-ea at ${toolRoot} is not a Git checkout, so it has no release to deploy; run gws-ea from a clone of its repository`,
      { cause: error },
    );
  }
  const commit = validateCommit(head.trim());
  const files = await trackedChanges(toolRoot, run, environment);
  if (files.length > 0) {
    throw new GwsEaError(
      'tool_checkout_modified',
      `gws-ea's checkout has tracked changes, so it is not the release it would deploy: ${files.join(', ')}. Discard them, or run gws-ea from a clean checkout, then retry.`,
      { details: { files } },
    );
  }
  return commit;
}

/**
 * The tool's own commit: the release every create and update deploys, so
 * everything the tool writes is correct for it by construction. A tracked
 * change would make the tool differ from that commit and is refused, naming
 * its files; untracked files belong to no release.
 */
export async function resolveToolCommit(toolRoot: string, runtime: CheckoutRuntime = {}): Promise<string> {
  const run = runtime.runCommand ?? runSanitizedCommand;
  return withScratchEnvironments('gws-ea-tool-', ({ git: environment }) => readToolCommit(toolRoot, run, environment));
}

/** Where an assistant's deployed commit stands against the tool's own release. */
export interface ToolReleasePosition {
  /** The tool's own commit: the release an update would deploy. */
  readonly toolCommit: string;
  /**
   * `behind`: a strict ancestor of the tool's commit, so an update can move
   * it forward; `same`: the tool's commit; `elsewhere`: newer than it or
   * diverged from it; `unknown`: the tool's history does not hold the commit.
   */
  readonly position: 'behind' | 'same' | 'elsewhere' | 'unknown';
}

/**
 * Place `commit` against the tool's own release using only the tool's own
 * history: nothing is fetched, even lazily, and the tool's index is never
 * refreshed. Track membership is left to update, which fetches the track.
 */
export async function locateAgainstToolRelease(
  toolRoot: string,
  commit: string,
  runtime: CheckoutRuntime = {},
): Promise<ToolReleasePosition> {
  const deployed = validateCommit(commit);
  const run = runtime.runCommand ?? runSanitizedCommand;
  return withScratchEnvironments<ToolReleasePosition>('gws-ea-tool-', async ({ git: environment }) => {
    const toolCommit = await readToolCommit(toolRoot, run, environment);
    if (deployed === toolCommit) return { toolCommit, position: 'same' };
    const local = { ...environment, GIT_NO_LAZY_FETCH: '1' };
    if (!(await presentCommits(toolRoot, [deployed], run, local)).has(deployed)) {
      return { toolCommit, position: 'unknown' };
    }
    return {
      toolCommit,
      position: (await isAncestor(toolRoot, deployed, toolCommit, run, local)) ? 'behind' : 'elsewhere',
    };
  });
}

export interface TrackCommits {
  readonly commit: string;
  /** For an update: the commit the assistant runs. */
  readonly deployedCommit?: string;
}

/** Where a commit stands on a release track. */
export interface TrackPosition {
  /** The commit is reachable from the track's tip. */
  readonly onTrack: boolean;
  /**
   * Where the deployed commit stands, when one was given: `behind` is a
   * strict ancestor of the commit, the only place an update moves forward
   * from; `elsewhere` is newer, diverged, or not in the track's history.
   */
  readonly deployed?: 'behind' | 'same' | 'elsewhere';
}

/** Which of `commits` the object database holds, never fetching one it lacks. */
async function presentCommits(
  repository: string,
  commits: readonly string[],
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<ReadonlySet<string>> {
  const { stdout } = await run({
    command: 'git',
    args: ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    cwd: repository,
    env: environment,
    input: `${commits.join('\n')}\n`,
  });
  return new Set(
    stdout
      .split('\n')
      .map((line) => line.split(' '))
      .filter(([, type]) => type === 'commit')
      .map(([objectName]) => objectName!),
  );
}

async function isAncestor(
  repository: string,
  ancestor: string,
  descendant: string,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<boolean> {
  try {
    await run({
      command: 'git',
      args: ['merge-base', '--is-ancestor', ancestor, descendant],
      cwd: repository,
      env: environment,
    });
    return true;
  } catch (error) {
    // Exit 1 is Git's "not an ancestor"; anything else is a failure.
    if (error instanceof GwsEaError && error.code === 'command_failed' && error.details?.exitCode === 1) return false;
    throw error;
  }
}

/**
 * Fetch the track branch's history without blobs into a disposable object
 * database, and place `commit` (and an update's deployed commit) on it
 * (KTD4). Only the commit graph is read, and lazy fetching is off, so a
 * commit the history lacks counts as off the track rather than being fetched
 * from wherever else the remote keeps it.
 */
export async function locateOnTrack(
  source: ReleaseSource,
  commits: TrackCommits,
  runtime: CheckoutRuntime = {},
): Promise<TrackPosition> {
  validateSourceRemote(source.remote);
  const commit = validateCommit(commits.commit);
  const deployedCommit = commits.deployedCommit === undefined ? undefined : validateCommit(commits.deployedCommit);
  const run = runtime.runCommand ?? runSanitizedCommand;
  return withScratchEnvironments<TrackPosition>('gws-ea-track-', async (environments, scratchRoot) => {
    const repository = path.join(scratchRoot, 'history.git');
    const local = { ...environments.git, GIT_NO_LAZY_FETCH: '1' };
    await run({ command: 'git', args: ['init', '--bare', repository], cwd: scratchRoot, env: local });
    await assertValidReleaseRef(repository, source.ref, run, local);
    await run({ command: 'git', args: ['remote', 'add', 'origin', source.remote], cwd: repository, env: local });
    await run({
      command: 'git',
      args: ['fetch', '--no-tags', '--filter=blob:none', '--end-of-options', 'origin', source.ref],
      cwd: repository,
      env: fetchEnvironment(environments.git, runtime.fetchAuthentication),
    });
    let tip: string;
    try {
      tip = validateCommit(
        (
          await run({
            command: 'git',
            args: ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
            cwd: repository,
            env: local,
          })
        ).stdout.trim(),
      );
    } catch {
      throw new GwsEaError('release_ref_not_commit', 'Release ref does not resolve to a commit');
    }

    const present = await presentCommits(repository, [commit, ...(deployedCommit ? [deployedCommit] : [])], run, local);
    const onTrack = present.has(commit) && (await isAncestor(repository, commit, tip, run, local));
    if (deployedCommit === undefined) return { onTrack };
    if (deployedCommit === commit) return { onTrack, deployed: 'same' };
    const behind =
      onTrack && present.has(deployedCommit) && (await isAncestor(repository, deployedCommit, commit, run, local));
    return { onTrack, deployed: behind ? 'behind' : 'elsewhere' };
  });
}

async function assertCheckoutTargetAbsent(checkoutRoot: string): Promise<void> {
  try {
    const info = await lstat(checkoutRoot);
    if (info.isSymbolicLink()) {
      throw new GwsEaError('unsafe_checkout', 'Reserved checkout path must not be a symlink');
    }
    throw new GwsEaError('checkout_exists', 'Reserved checkout path already exists');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
}

function stagingCheckoutRoot(checkoutRoot: string): string {
  return `${checkoutRoot}.staging`;
}

async function writeStagingMarker(checkoutRoot: string, reservation: InstanceReservation): Promise<void> {
  const file = instanceMarkerFile(checkoutRoot);
  await preparePrivateDirectory(path.dirname(file));
  await writePrivate(file, {
    schema_version: INSTANCE_MARKER_SCHEMA_VERSION,
    instance_id: reservation.instance_id,
    deployed_commit: reservation.deployed_commit,
  } satisfies InstanceMarker);
}

async function assertStagingMarker(checkoutRoot: string, reservation: InstanceReservation): Promise<void> {
  const marker = await readInstanceMarkerFile(instanceMarkerFile(checkoutRoot));
  if (marker.instance_id !== reservation.instance_id || marker.deployed_commit !== reservation.deployed_commit) {
    throw new GwsEaError('marker_mismatch', 'Staging instance marker mismatch; refusing mutation');
  }
}

/**
 * Materialize a reservation's release. Create publishes the registry's
 * reservation at the live checkout, which only ever holds the release the
 * registry records. An update stages its target reservation view (KTD17) in
 * a release `slot` beside it, while the registry still names the release the
 * update moves from.
 */
export async function materializeReleaseCheckout(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  runtime: CheckoutRuntime = {},
  slot?: ReleaseSlot,
): Promise<InstanceReservation> {
  const instanceId = reservation.instance_id;
  const recorded = await getInstanceReservation(paths, instanceId);
  if (!slot && !sameRelease(recorded, reservation)) {
    throw new GwsEaError('release_mismatch', 'The live checkout holds only the release the registry records');
  }
  const destination = slot ? paths.releaseCheckoutRoot(instanceId, slot) : recorded.checkout_realpath;
  await assertCheckoutTargetAbsent(destination);
  await assertOwnedDestination(destination);
  await mkdir(paths.instanceRoot(instanceId), { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(paths.instanceRoot(instanceId));
  if (slot) await preparePrivateDirectory(paths.releaseRoot(instanceId, slot));
  const environments = await prepareReleaseCommandEnvironments(paths.instanceRoot(instanceId));
  const stagingRoot = stagingCheckoutRoot(destination);
  const run = runtime.runCommand ?? runSanitizedCommand;
  const verifyPublished = async (): Promise<InstanceReservation> => {
    if (!slot) return assertReleaseCheckoutAgreement(paths, instanceId, runtime);
    await assertCheckoutMarker(destination, instanceId, [reservation.deployed_commit]);
    await assertCheckoutRoot(destination, reservation.deployed_commit, run, environments.git);
    return reservation;
  };
  try {
    const info = await lstat(stagingRoot);
    if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(stagingRoot)) !== stagingRoot) {
      throw new GwsEaError('unsafe_checkout', 'Staging checkout must be a physical directory at its claimed path');
    }
    await assertPrivateDirectory(stagingRoot);
    try {
      await promoteStagingCheckout(stagingRoot, destination, reservation, run, environments.git);
      return verifyPublished();
    } catch (error) {
      if (error instanceof GwsEaError && ['invalid_marker', 'marker_mismatch'].includes(error.code)) throw error;
      await rm(stagingRoot, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  await preparePrivateDirectory(stagingRoot);

  let completed = false;
  try {
    await run({ command: 'git', args: ['init'], cwd: stagingRoot, env: environments.git });
    await run({
      command: 'git',
      args: ['remote', 'add', 'origin', reservation.source_remote],
      cwd: stagingRoot,
      env: environments.git,
    });
    await run({
      command: 'git',
      args: ['fetch', '--no-tags', '--depth=1', '--end-of-options', 'origin', reservation.deployed_commit],
      cwd: stagingRoot,
      env: fetchEnvironment(environments.git, runtime.fetchAuthentication),
    });
    await run({
      command: 'git',
      args: ['checkout', '--detach', reservation.deployed_commit],
      cwd: stagingRoot,
      env: environments.git,
    });
    await writeStagingMarker(stagingRoot, reservation);
    await promoteStagingCheckout(stagingRoot, destination, reservation, run, environments.git);
    const result = await verifyPublished();
    completed = true;
    return result;
  } finally {
    if (!completed) await rm(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Move a staged checkout to `destination` once it carries this instance's
 * marker, sits at the reservation's commit, and nothing occupies the path.
 */
async function promoteStagingCheckout(
  stagingRoot: string,
  destination: string,
  reservation: InstanceReservation,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await assertStagingMarker(stagingRoot, reservation);
  await assertCheckoutRoot(stagingRoot, reservation.deployed_commit, run, environment);
  await assertCheckoutTargetAbsent(destination);
  await rename(stagingRoot, destination);
}

/**
 * A checkout sits detached at `commit` with a clean tree. Git is told not to
 * take optional locks, so reading its status never rewrites the index.
 */
async function assertCheckoutRoot(
  checkoutRoot: string,
  commit: string,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await assertDetachedAt(checkoutRoot, commit, run, environment);
  const status = (
    await run({
      command: 'git',
      args: ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'],
      cwd: checkoutRoot,
      env: environment,
    })
  ).stdout.trim();
  if (status) throw new GwsEaError('checkout_drift', `Release checkout is not clean:\n${status}`);
}

/** A checkout's HEAD is detached at `commit`. */
async function assertDetachedAt(
  checkoutRoot: string,
  commit: string,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const head = validateCommit(
    (
      await run({
        command: 'git',
        args: ['rev-parse', '--verify', 'HEAD^{commit}'],
        cwd: checkoutRoot,
        env: environment,
      })
    ).stdout.trim(),
  );
  if (head !== commit) {
    throw new GwsEaError('release_mismatch', "Checkout HEAD does not match the reservation's release");
  }
  const branch = (
    await run({
      command: 'git',
      args: ['rev-parse', '--abbrev-ref', 'HEAD'],
      cwd: checkoutRoot,
      env: environment,
    })
  ).stdout.trim();
  if (branch !== 'HEAD') throw new GwsEaError('checkout_not_detached', 'Release checkout HEAD must be detached');
}

/** The reserved checkout is a physical directory at exactly its reserved real path. */
async function assertPhysicalCheckout(reservation: InstanceReservation): Promise<void> {
  const info = await lstat(reservation.checkout_realpath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new GwsEaError('unsafe_checkout', 'Reserved checkout must be a physical directory');
  }
  if ((await realpath(reservation.checkout_realpath)) !== reservation.checkout_realpath) {
    throw new GwsEaError('unsafe_checkout', 'Checkout real path does not match the immutable reservation');
  }
}

/** Verify registry, physical checkout, detached HEAD, marker, commit, and clean tree agree. */
export async function assertReleaseCheckoutAgreement(
  paths: ControlPlanePaths,
  instanceId: string,
  runtime: CheckoutRuntime = {},
): Promise<InstanceReservation> {
  const reservation = await assertRegistryMarkerAgreement(paths, instanceId);
  await assertPhysicalCheckout(reservation);
  const run = runtime.runCommand ?? runSanitizedCommand;
  const environments = await prepareReleaseCommandEnvironments(paths.instanceRoot(instanceId));
  await assertCheckoutRoot(reservation.checkout_realpath, reservation.deployed_commit, run, environments.git);
  return reservation;
}

/**
 * The live checkout as a read-only command observes it: the checks
 * `assertReleaseCheckoutAgreement` makes, against any of `commits` (the
 * registry's, plus any an unfinished update or rollback placed there), with
 * Git's HOME outside the instance, so nothing under it is created or changed.
 * Returns the commit the checkout holds.
 */
export async function observeLiveCheckout(
  reservation: InstanceReservation,
  commits: readonly string[],
  runtime: CheckoutRuntime = {},
): Promise<string> {
  const root = reservation.checkout_realpath;
  await assertCheckoutMarker(root, reservation.instance_id, commits);
  const { deployed_commit: commit } = await readInstanceMarkerFile(instanceMarkerFile(root));
  await assertPhysicalCheckout(reservation);
  const run = runtime.runCommand ?? runSanitizedCommand;
  await withScratchEnvironments('gws-ea-checkout-', ({ git }) => assertCheckoutRoot(root, commit, run, git));
  return commit;
}

/**
 * The live checkout an update moves from: its marker and detached HEAD at the
 * release the registry records. A tracked edit would stay behind with the
 * release it edits, so it is refused, naming the files; untracked files belong
 * to no release and are left alone. Git's HOME is outside the instance, and
 * Git takes no optional lock, so nothing under the instance changes.
 */
export async function assertDeploymentCheckoutUnmodified(
  reservation: InstanceReservation,
  runtime: CheckoutRuntime = {},
): Promise<void> {
  const root = reservation.checkout_realpath;
  await assertCheckoutMarker(root, reservation.instance_id, [reservation.deployed_commit]);
  await assertPhysicalCheckout(reservation);
  const run = runtime.runCommand ?? runSanitizedCommand;
  await withScratchEnvironments('gws-ea-checkout-', async ({ git }) => {
    await assertDetachedAt(root, reservation.deployed_commit, run, git);
    const files = await trackedChanges(root, run, git);
    if (files.length === 0) return;
    throw new GwsEaError(
      'deployment_checkout_modified',
      `Assistant ${reservation.instance_id}'s checkout ${root} has tracked changes, which an update would leave behind with its release: ${files.join(', ')}. Discard them, then retry.`,
      { details: { files } },
    );
  });
}
