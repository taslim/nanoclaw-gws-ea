import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { assertLocalOwnedDestination, assertOwnedLocalDirectory, type ControlPlanePaths } from './paths.js';
import { assertRegistryMarkerAgreement, getInstanceReservation, writeInstanceMarker } from './registry.js';
import { GwsEaError, type InstanceReservation } from './types.js';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export interface CommandSpec {
  command: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

export interface ResolvedRelease {
  sourceRemote: string;
  releaseRef: string;
  commit: string;
}

export interface CheckoutRuntime {
  runCommand?: CommandRunner;
}

function appendOutput(current: string, chunk: Buffer, childCommand: string): string {
  if (Buffer.byteLength(current) + chunk.byteLength > MAX_COMMAND_OUTPUT_BYTES) {
    throw new GwsEaError('command_output_limit', `${childCommand} produced too much output`);
  }
  return current + chunk.toString('utf8');
}

/** Execute one binary directly. Arguments are never interpreted by a shell. */
export function runArgumentCommand(spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        stdout = appendOutput(stdout, chunk, spec.command);
      } catch (error) {
        if (!(error instanceof GwsEaError)) throw error;
        fail(error);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      try {
        stderr = appendOutput(stderr, chunk, spec.command);
      } catch (error) {
        if (!(error instanceof GwsEaError)) throw error;
        fail(error);
      }
    });
    child.once('error', (error) => {
      fail(new GwsEaError('command_failed', `Could not execute ${spec.command}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const outcome = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      reject(new GwsEaError('command_failed', `${spec.command} failed with ${outcome}`));
    });

    const timeout = setTimeout(() => {
      fail(new GwsEaError('command_timeout', `${spec.command} exceeded its execution timeout`));
    }, spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref();
    child.once('close', () => clearTimeout(timeout));
  });
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

async function assertValidReleaseRef(repository: string, releaseRef: string, run: CommandRunner): Promise<void> {
  if (!releaseRef || releaseRef.startsWith('-') || releaseRef.length > 256) {
    throw new GwsEaError('invalid_release_ref', 'Release ref is invalid');
  }
  try {
    await run({ command: 'git', args: ['check-ref-format', '--allow-onelevel', releaseRef], cwd: repository });
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
  const run = runtime.runCommand ?? runArgumentCommand;
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-resolve-'));
  const repository = path.join(scratchRoot, 'objects.git');
  try {
    await run({ command: 'git', args: ['init', '--bare', repository] });
    await assertValidReleaseRef(repository, releaseRef, run);
    await run({
      command: 'git',
      args: ['fetch', '--no-tags', '--depth=1', '--end-of-options', sourceRemote, releaseRef],
      cwd: repository,
    });

    let commit: string;
    try {
      commit = validateCommit(
        (
          await run({ command: 'git', args: ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], cwd: repository })
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
  await assertLocalOwnedDestination(reservation.checkout_realpath);
  await mkdir(paths.instanceRoot(instanceId), { recursive: true, mode: 0o700 });
  await assertOwnedLocalDirectory(paths.instanceRoot(instanceId), 0o700);
  await mkdir(reservation.checkout_realpath, { mode: 0o700 });

  const run = runtime.runCommand ?? runArgumentCommand;
  let completed = false;
  try {
    await run({ command: 'git', args: ['init'], cwd: reservation.checkout_realpath });
    await run({
      command: 'git',
      args: ['remote', 'add', 'origin', reservation.source_remote],
      cwd: reservation.checkout_realpath,
    });
    await run({
      command: 'git',
      args: ['fetch', '--no-tags', '--depth=1', '--end-of-options', 'origin', reservation.deployed_commit],
      cwd: reservation.checkout_realpath,
    });
    await run({
      command: 'git',
      args: ['checkout', '--detach', reservation.deployed_commit],
      cwd: reservation.checkout_realpath,
    });
    await writeInstanceMarker(paths, instanceId);
    const result = await assertReleaseCheckoutAgreement(paths, instanceId, runtime);
    completed = true;
    return result;
  } finally {
    if (!completed) await rm(reservation.checkout_realpath, { recursive: true, force: true });
  }
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

  const run = runtime.runCommand ?? runArgumentCommand;
  const head = validateCommit(
    (
      await run({
        command: 'git',
        args: ['rev-parse', '--verify', 'HEAD^{commit}'],
        cwd: reservation.checkout_realpath,
      })
    ).stdout.trim(),
  );
  if (head !== reservation.deployed_commit) {
    throw new GwsEaError('release_mismatch', 'Checkout HEAD does not match the immutable instance reservation');
  }
  const branch = (
    await run({ command: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: reservation.checkout_realpath })
  ).stdout.trim();
  if (branch !== 'HEAD') throw new GwsEaError('checkout_not_detached', 'Release checkout HEAD must be detached');

  const status = (
    await run({
      command: 'git',
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
      cwd: reservation.checkout_realpath,
    })
  ).stdout.trim();
  if (status) {
    throw new GwsEaError('checkout_drift', `Release checkout is not clean:\n${status}`);
  }
  return reservation;
}
