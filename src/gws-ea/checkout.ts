import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import {
  assertOwnedDestination,
  assertPrivateDirectory,
  preparePrivateDirectory,
  type ControlPlanePaths,
} from './paths.js';
import { assertRegistryMarkerAgreement, getInstanceReservation, readInstanceMarkerFile } from './registry.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { GwsEaError, INSTANCE_MARKER_SCHEMA_VERSION, type InstanceMarker, type InstanceReservation } from './types.js';

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
 * Resolve and peel a release ref in a disposable object database. The caller
 * records only the returned full commit, never the movable ref.
 */
export async function resolveReleaseCommit(
  sourceRemote: string,
  releaseRef: string,
  runtime: CheckoutRuntime = {},
): Promise<ResolvedRelease> {
  validateSourceRemote(sourceRemote);
  const run = runtime.runCommand ?? runSanitizedCommand;
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-resolve-'));
  const repository = path.join(scratchRoot, 'objects.git');
  try {
    const environment = await prepareReleaseCommandEnvironments(scratchRoot);
    await run({ command: 'git', args: ['init', '--bare', repository], cwd: scratchRoot, env: environment.git });
    await assertValidReleaseRef(repository, releaseRef, run, environment.git);
    await run({
      command: 'git',
      args: ['fetch', '--no-tags', '--depth=1', '--end-of-options', sourceRemote, releaseRef],
      cwd: repository,
      env: fetchEnvironment(environment.git, runtime.fetchAuthentication),
    });

    let commit: string;
    try {
      commit = validateCommit(
        (
          await run({
            command: 'git',
            args: ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
            cwd: repository,
            env: environment.git,
          })
        ).stdout.trim(),
      );
    } catch {
      throw new GwsEaError('release_ref_not_commit', 'Release ref does not resolve to a commit');
    }
    return { sourceRemote, releaseRef, commit };
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
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

function markerPath(checkoutRoot: string): string {
  return path.join(checkoutRoot, 'data', 'gws-ea', 'instance.json');
}

async function writeStagingMarker(
  checkoutRoot: string,
  instanceId: string,
  reservation: InstanceReservation,
): Promise<void> {
  const file = markerPath(checkoutRoot);
  await preparePrivateDirectory(path.dirname(file));
  await writePrivate(file, {
    schema_version: INSTANCE_MARKER_SCHEMA_VERSION,
    instance_id: instanceId,
    deployed_commit: reservation.deployed_commit,
  } satisfies InstanceMarker);
}

async function assertStagingMarker(
  checkoutRoot: string,
  instanceId: string,
  reservation: InstanceReservation,
): Promise<void> {
  const marker = await readInstanceMarkerFile(markerPath(checkoutRoot));
  if (marker.instance_id !== instanceId || marker.deployed_commit !== reservation.deployed_commit) {
    throw new GwsEaError('marker_mismatch', 'Staging instance marker mismatch; refusing mutation');
  }
}

function assertResolvedReleaseMatches(reservation: InstanceReservation, release: ResolvedRelease): void {
  if (reservation.source_remote !== release.sourceRemote || reservation.deployed_commit !== release.commit) {
    throw new GwsEaError('release_mismatch', 'Resolved release does not match the immutable instance reservation');
  }
}

/** Materialize only the commit already recorded in the machine registry. */
export async function materializeReleaseCheckout(
  paths: ControlPlanePaths,
  instanceId: string,
  release: ResolvedRelease,
  runtime: CheckoutRuntime = {},
): Promise<InstanceReservation> {
  const reservation = await getInstanceReservation(paths, instanceId);
  assertResolvedReleaseMatches(reservation, release);
  await assertCheckoutTargetAbsent(reservation.checkout_realpath);
  await assertOwnedDestination(reservation.checkout_realpath);
  await mkdir(paths.instanceRoot(instanceId), { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(paths.instanceRoot(instanceId));
  const environments = await prepareReleaseCommandEnvironments(paths.instanceRoot(instanceId));
  const stagingRoot = stagingCheckoutRoot(reservation.checkout_realpath);
  const run = runtime.runCommand ?? runSanitizedCommand;
  try {
    const info = await lstat(stagingRoot);
    if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(stagingRoot)) !== stagingRoot) {
      throw new GwsEaError('unsafe_checkout', 'Staging checkout must be a physical directory at its claimed path');
    }
    await assertPrivateDirectory(stagingRoot);
    try {
      await promoteStagingCheckout(stagingRoot, instanceId, reservation, run, environments.git);
      return assertReleaseCheckoutAgreement(paths, instanceId, runtime);
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
    await writeStagingMarker(stagingRoot, instanceId, reservation);
    await promoteStagingCheckout(stagingRoot, instanceId, reservation, run, environments.git);
    const result = await assertReleaseCheckoutAgreement(paths, instanceId, runtime);
    completed = true;
    return result;
  } finally {
    if (!completed) await rm(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Move a staged checkout into place once it carries this instance's marker,
 * sits at the reserved commit, and nothing occupies the checkout path.
 */
async function promoteStagingCheckout(
  stagingRoot: string,
  instanceId: string,
  reservation: InstanceReservation,
  run: SanitizedCommandRunner,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await assertStagingMarker(stagingRoot, instanceId, reservation);
  await assertCheckoutRoot(stagingRoot, reservation, run, environment);
  await assertCheckoutTargetAbsent(reservation.checkout_realpath);
  await rename(stagingRoot, reservation.checkout_realpath);
}

async function assertCheckoutRoot(
  checkoutRoot: string,
  reservation: InstanceReservation,
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
  if (head !== reservation.deployed_commit) {
    throw new GwsEaError('release_mismatch', 'Checkout HEAD does not match the immutable instance reservation');
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

  const status = (
    await run({
      command: 'git',
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
      cwd: checkoutRoot,
      env: environment,
    })
  ).stdout.trim();
  if (status) throw new GwsEaError('checkout_drift', `Release checkout is not clean:\n${status}`);
}

/** Verify registry, physical checkout, detached HEAD, marker, commit, and clean tree agree. */
export async function assertReleaseCheckoutAgreement(
  paths: ControlPlanePaths,
  instanceId: string,
  runtime: CheckoutRuntime = {},
): Promise<InstanceReservation> {
  const reservation = await assertRegistryMarkerAgreement(paths, instanceId);
  const info = await lstat(reservation.checkout_realpath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new GwsEaError('unsafe_checkout', 'Reserved checkout must be a physical directory');
  }
  if ((await realpath(reservation.checkout_realpath)) !== reservation.checkout_realpath) {
    throw new GwsEaError('unsafe_checkout', 'Checkout real path does not match the immutable reservation');
  }

  const run = runtime.runCommand ?? runSanitizedCommand;
  const environments = await prepareReleaseCommandEnvironments(paths.instanceRoot(instanceId));
  await assertCheckoutRoot(reservation.checkout_realpath, reservation, run, environments.git);
  return reservation;
}
