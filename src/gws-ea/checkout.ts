import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import {
  assertOwnedDestination,
  assertPrivateDirectory,
  preparePrivateDirectory,
  type ControlPlanePaths,
  type ReleaseSlot,
} from './paths.js';
import {
  assertRegistryMarkerAgreement,
  assertStateMarker,
  getInstanceReservation,
  writeInstanceMarker,
} from './registry.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { readCurrent, releaseName } from './release-layout.js';
import type { ReleaseSource } from './release-tracks.js';
import { GwsEaError, sameRelease, shortCommit, type InstanceReservation } from './types.js';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
/** A Git object ID, in a SHA-1 or a SHA-256 repository. */
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
 * The paths `git status` reports for a checkout, narrowed by `options`. Git
 * takes no optional lock, so its index is never rewritten.
 */
async function statusPaths(
  checkoutRoot: string,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
  options: readonly string[],
): Promise<string[]> {
  const { stdout } = await run({
    command: 'git',
    args: ['--no-optional-locks', 'status', '--porcelain=v1', ...options],
    cwd: checkoutRoot,
    env: environment,
  });
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
}

/** The files a checkout's tracked tree differs in. Untracked files belong to no release. */
function trackedChanges(
  checkoutRoot: string,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<string[]> {
  return statusPaths(checkoutRoot, run, environment, ['--untracked-files=no']);
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

/**
 * The ID of the Git tree `directory` holds at `commit`, read from the
 * repository at `root`: its own objects only, nothing fetched even lazily,
 * and no operator configuration read. The ID names the directory's committed
 * content exactly, whatever the working tree holds.
 */
export async function committedTree(
  root: string,
  commit: string,
  directory: string,
  runtime: CheckoutRuntime = {},
): Promise<string> {
  const release = validateCommit(commit);
  const run = runtime.runCommand ?? runSanitizedCommand;
  return withScratchEnvironments('gws-ea-tree-', async ({ git: environment }) => {
    const { stdout } = await run({
      command: 'git',
      args: ['ls-tree', '--full-tree', release, '--', directory],
      cwd: root,
      env: { ...environment, GIT_NO_LAZY_FETCH: '1' },
    });
    const entry = stdout.replace(/\n$/u, '');
    if (!entry) {
      throw new GwsEaError('incomplete_release', `Release ${shortCommit(release)} holds no ${directory}/ directory`);
    }
    const [mode, type, tree, ...rest] = entry.split(/[ \t]/u);
    if (mode !== '040000' || type !== 'tree' || tree === undefined || !OBJECT_ID_PATTERN.test(tree)) {
      throw new GwsEaError('invalid_child_output', `Git reported no tree for ${directory}/ in ${shortCommit(release)}`);
    }
    if (rest.join(' ') !== directory) {
      throw new GwsEaError(
        'invalid_child_output',
        `Git reported another entry than ${directory}/ in ${shortCommit(release)}`,
      );
    }
    return tree;
  });
}

/**
 * The paths under `directory` where a checkout's working tree differs from
 * its HEAD: tracked changes, and untracked files Git does not ignore.
 */
export async function workingTreeChanges(
  root: string,
  directory: string,
  runtime: CheckoutRuntime = {},
): Promise<string[]> {
  const run = runtime.runCommand ?? runSanitizedCommand;
  return withScratchEnvironments('gws-ea-tree-', ({ git: environment }) =>
    statusPaths(root, run, environment, ['--untracked-files=all', '--', directory]),
  );
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

/** The physical folder of the release at `commit`, `<instance root>/<hex8>`, never reached through a link. */
function releaseFolder(paths: ControlPlanePaths, instanceId: string, commit: string): string {
  return paths.instanceLayout(instanceId).release(releaseName(commit));
}

/**
 * Materialize a reservation's release. Create publishes the release the
 * registry records in its physical folder, `<instance root>/<hex8>`, and
 * writes the instance marker into the assistant's `state/`. An update stages
 * its target reservation view (KTD17) in a release `slot`, while the registry
 * still names the release the update moves from. A staged checkout is
 * published only at the reservation's commit with a clean tree: its folder
 * and its Git HEAD are what identify it.
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
  const destination = slot
    ? paths.releaseCheckoutRoot(instanceId, slot)
    : releaseFolder(paths, instanceId, recorded.deployed_commit);
  await assertCheckoutTargetAbsent(destination);
  await assertOwnedDestination(destination);
  await mkdir(paths.instanceRoot(instanceId), { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(paths.instanceRoot(instanceId));
  if (slot) await preparePrivateDirectory(paths.releaseRoot(instanceId, slot));
  else await writeInstanceMarker(paths, instanceId);
  const environments = await prepareReleaseCommandEnvironments(paths.instanceRoot(instanceId));
  const stagingRoot = stagingCheckoutRoot(destination);
  const run = runtime.runCommand ?? runSanitizedCommand;
  const verifyPublished = async (): Promise<InstanceReservation> => {
    if (!slot) return assertReleaseCheckoutAgreement(paths, instanceId, runtime);
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
      if (error instanceof GwsEaError && ['checkout_exists', 'unsafe_checkout'].includes(error.code)) throw error;
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
    await promoteStagingCheckout(stagingRoot, destination, reservation, run, environments.git);
    const result = await verifyPublished();
    completed = true;
    return result;
  } finally {
    if (!completed) await rm(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Move a staged checkout to `destination` once it sits at the reservation's
 * commit with a clean tree and nothing occupies the path.
 */
async function promoteStagingCheckout(
  stagingRoot: string,
  destination: string,
  reservation: InstanceReservation,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
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

/** A release folder is a physical directory at exactly its own real path: no link on the way to it. */
async function assertPhysicalRelease(release: string): Promise<void> {
  const info = await lstat(release);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new GwsEaError('unsafe_checkout', 'A release must be a physical directory');
  }
  if ((await realpath(release)) !== release) {
    throw new GwsEaError('unsafe_checkout', 'A release must be at its own real path, not reached through a link');
  }
}

/**
 * Verify the registry and the assistant's `state/` marker agree, and the
 * release the registry records is a physical folder whose HEAD is detached at
 * its commit with a clean tree.
 */
export async function assertReleaseCheckoutAgreement(
  paths: ControlPlanePaths,
  instanceId: string,
  runtime: CheckoutRuntime = {},
): Promise<InstanceReservation> {
  const reservation = await assertRegistryMarkerAgreement(paths, instanceId);
  const release = releaseFolder(paths, instanceId, reservation.deployed_commit);
  await assertPhysicalRelease(release);
  const run = runtime.runCommand ?? runSanitizedCommand;
  const environments = await prepareReleaseCommandEnvironments(paths.instanceRoot(instanceId));
  await assertCheckoutRoot(release, reservation.deployed_commit, run, environments.git);
  return reservation;
}

/**
 * The tracked files a live checkout differs in, once its HEAD is found
 * detached at `commit`. A live checkout's contract: untracked files belong to
 * no release, so they never count. Git's HOME is outside the instance, and Git
 * takes no optional lock, so nothing under the instance is created or changed.
 */
async function liveTrackedChanges(root: string, commit: string, run: SanitizedCommandRunner): Promise<string[]> {
  return withScratchEnvironments('gws-ea-checkout-', async ({ git }) => {
    await assertDetachedAt(root, commit, run, git);
    return trackedChanges(root, run, git);
  });
}

/**
 * The live release as a read-only command observes it: the release the live
 * link names, which must be one of `commits` (the registry's, plus any an
 * unfinished update or rollback placed there), a physical folder with HEAD
 * detached at that commit, and no tracked changes, which are refused by name.
 * The assistant's `state/` must carry its marker. Returns the commit.
 */
export async function observeLiveCheckout(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  commits: readonly string[],
  runtime: CheckoutRuntime = {},
): Promise<string> {
  const instanceId = reservation.instance_id;
  const layout = paths.instanceLayout(instanceId);
  await assertStateMarker(layout.state, instanceId);
  const live = await readCurrent(layout);
  if (live === undefined) {
    throw new GwsEaError('release_fenced', `Assistant ${instanceId} has no live release: a switch has fenced it.`);
  }
  const commit = commits.find((candidate) => releaseName(candidate) === live);
  if (commit === undefined) {
    throw new GwsEaError(
      'release_mismatch',
      `Assistant ${instanceId}'s live release ${live} is not one its records name (${commits.map(shortCommit).join(', ')}).`,
    );
  }
  const root = layout.release(live);
  await assertPhysicalRelease(root);
  const files = await liveTrackedChanges(root, commit, runtime.runCommand ?? runSanitizedCommand);
  if (files.length > 0) {
    throw new GwsEaError(
      'checkout_drift',
      `Assistant ${instanceId}'s live release ${root} has tracked changes: ${files.join(', ')}.`,
      { details: { files } },
    );
  }
  return commit;
}

/**
 * The release an update moves from: the registry's, in its physical folder
 * with HEAD detached at its commit, and the assistant's `state/` carrying its
 * marker. A tracked edit would stay behind with the release it edits, so it
 * is refused, naming the files.
 */
export async function assertDeploymentCheckoutUnmodified(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  runtime: CheckoutRuntime = {},
): Promise<void> {
  const instanceId = reservation.instance_id;
  await assertStateMarker(paths.instanceLayout(instanceId).state, instanceId);
  const root = releaseFolder(paths, instanceId, reservation.deployed_commit);
  await assertPhysicalRelease(root);
  const files = await liveTrackedChanges(root, reservation.deployed_commit, runtime.runCommand ?? runSanitizedCommand);
  if (files.length === 0) return;
  throw new GwsEaError(
    'deployment_checkout_modified',
    `Assistant ${instanceId}'s release ${root} has tracked changes, which an update would leave behind with it: ${files.join(', ')}. Discard them, then retry.`,
    { details: { files } },
  );
}
