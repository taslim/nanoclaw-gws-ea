import fs from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isErrno } from '../community-portal/errors.js';
import { instanceLayout, releaseName, type InstanceLayout } from './release-layout.js';
import { GwsEaError } from './types.js';

/**
 * The checkout this control plane runs from (`src/gws-ea` and `dist/gws-ea` both sit two levels below it). Node
 * resolves the main module's links, so a launcher started through an assistant's `nanoclaw` link finds the
 * physical release folder it runs from here.
 */
export const CONTROL_PLANE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The name of an instance's root under the state root: the first eight hex digits of its ID (KTD10). */
export function instanceRootName(instanceId: string): string {
  return instanceId.slice(0, 8);
}

/** The instance marker under `stateRoot`, the directory that holds NanoClaw's `data`. */
export function instanceMarkerFile(stateRoot: string): string {
  return path.join(stateRoot, 'data', 'gws-ea', 'instance.json');
}

/** The runtime record under `stateRoot`, the directory that holds NanoClaw's `data`. */
export function instanceRuntimeFile(stateRoot: string): string {
  return path.join(stateRoot, 'data', 'gws-ea', 'runtime.json');
}

export interface ControlPlanePathOverrides {
  configRoot?: string;
  stateRoot?: string;
}

export interface ControlPlanePaths {
  configRoot: string;
  stateRoot: string;
  registryFile: string;
  registryLock: string;
  removalRoot: string;
  ingressRoot: string;
  cloudflareRoot: string;
  logsRoot: string;
  preReservationLogsRoot: string;
  instanceLogsRoot(instanceId: string): string;
  /** `<state root>/<first 8 hex of the ID>`: the assistant's releases, state, and records. */
  instanceRoot(instanceId: string): string;
  /** The instance root's layout: its live link, its physical `state/` and `logs/`, and its releases. */
  instanceLayout(instanceId: string): InstanceLayout;
  /** The live release's link, `<instance root>/nanoclaw`: what the service, `ncl`, and the host's status run from. */
  checkoutRoot(instanceId: string): string;
  journalFile(instanceId: string): string;
  /** The record of an update or rollback under way, beside the provision journal. */
  operationFile(instanceId: string): string;
  /** The release a rollback returns to, and the snapshot of the state it left (KTD4). */
  rollbackPointFile(instanceId: string): string;
  instanceLock(instanceId: string): string;
  /** The instance marker in the physical `state/`, which names the assistant the state belongs to. */
  markerFile(instanceId: string): string;
  /** The runtime record in the physical `state/`, written once at create. */
  runtimeFile(instanceId: string): string;
  bootstrapFile(instanceId: string): string;
  /** The receipt of the release at `commit`, kept with it in `kept/<hex8>/` and written last. */
  releasePreflightFile(instanceId: string, commit: string): string;
  removalFile(instanceId: string): string;
  /** The Cloudflare account token a create keeps until its route is set up. */
  keptCloudflareTokenFile(instanceId: string): string;
}

function nearestExistingAncestor(target: string): string {
  let candidate = target;
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

/** `target` with every existing ancestor's symlinks resolved; the missing rest is kept as written. */
export function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  const ancestor = nearestExistingAncestor(resolved);
  return path.join(fs.realpathSync(ancestor), path.relative(ancestor, resolved));
}

function canonicalNewPath(target: string): string {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new GwsEaError('unsafe_path', `Managed root must not be a symlink: ${resolved}`);
  }
  return canonicalPath(resolved);
}

export function resolveControlPlanePaths(overrides: ControlPlanePathOverrides = {}): ControlPlanePaths {
  const defaultConfigBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const defaultStateBase = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const configRoot = canonicalNewPath(
    overrides.configRoot ?? process.env.GWS_EA_CONFIG_ROOT ?? path.join(defaultConfigBase, 'gws-ea'),
  );
  const stateRoot = canonicalNewPath(
    overrides.stateRoot ?? process.env.GWS_EA_STATE_ROOT ?? path.join(defaultStateBase, 'gws-ea'),
  );
  const removalRoot = path.join(configRoot, 'removals');
  const ingressRoot = path.join(stateRoot, 'ingress');
  const cloudflareRoot = path.join(ingressRoot, 'cloudflare');
  const logsRoot = path.join(stateRoot, 'logs');
  const instanceRoot = (instanceId: string): string => path.join(stateRoot, instanceRootName(instanceId));
  const layout = (instanceId: string): InstanceLayout => instanceLayout(instanceRoot(instanceId));

  return {
    configRoot,
    stateRoot,
    registryFile: path.join(configRoot, 'instances.json'),
    registryLock: path.join(configRoot, 'instances.lock'),
    removalRoot,
    ingressRoot,
    cloudflareRoot,
    logsRoot,
    preReservationLogsRoot: path.join(logsRoot, 'runs'),
    instanceLogsRoot: (instanceId) => path.join(logsRoot, instanceId),
    instanceRoot,
    instanceLayout: layout,
    checkoutRoot: (instanceId) => layout(instanceId).current,
    journalFile: (instanceId) => path.join(instanceRoot(instanceId), 'provision.json'),
    operationFile: (instanceId) => path.join(instanceRoot(instanceId), 'operation.json'),
    rollbackPointFile: (instanceId) => path.join(instanceRoot(instanceId), 'rollback-point.json'),
    instanceLock: (instanceId) => path.join(configRoot, 'locks', `${instanceId}.lock`),
    markerFile: (instanceId) => instanceMarkerFile(layout(instanceId).state),
    runtimeFile: (instanceId) => instanceRuntimeFile(layout(instanceId).state),
    bootstrapFile: (instanceId) => path.join(instanceRoot(instanceId), 'bootstrap.json'),
    releasePreflightFile: (instanceId, commit) => layout(instanceId).receipt(releaseName(commit)),
    removalFile: (instanceId) => path.join(removalRoot, `${instanceId}.json`),
    keptCloudflareTokenFile: (instanceId) => path.join(instanceRoot(instanceId), 'secrets', 'cloudflare-account-token'),
  };
}

/** Whether a regular file exists at `file`. */
export async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

/** Whether `target` lies strictly inside `root` (both absolute, already canonical where it matters). */
export function isWithinDirectory(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** No permission bits for group or others: `0600`/`0700` or stricter. */
export function isOwnerOnlyMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function assertOwnedByCurrentUser(uid: number, message: string): void {
  if (typeof process.getuid === 'function' && uid !== process.getuid()) throw new GwsEaError('unsafe_owner', message);
}

export async function assertOwnedDestination(target: string): Promise<void> {
  const ancestor = nearestExistingAncestor(path.resolve(target));
  const info = await lstat(ancestor);
  if (info.isSymbolicLink()) {
    throw new GwsEaError('unsafe_path', `Managed path resolves through a symlinked destination: ${ancestor}`);
  }
  assertOwnedByCurrentUser(info.uid, `Managed path parent must be owned by the current user: ${ancestor}`);
}

export async function assertOwnedDirectory(directory: string): Promise<fs.Stats> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new GwsEaError('unsafe_path', `Managed root is not a physical directory: ${directory}`);
  }
  assertOwnedByCurrentUser(info.uid, `Managed root must be owned by the current user: ${directory}`);
  return info;
}

export async function assertPrivateDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  if (!isOwnerOnlyMode((await assertOwnedDirectory(resolved)).mode)) {
    throw new GwsEaError('unsafe_mode', `Managed root must be accessible only by its owner (0700): ${resolved}`);
  }
}

export async function preparePrivateDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new GwsEaError('unsafe_path', `Managed root must not be a symlink: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) {
    await assertOwnedDestination(resolved);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
  }
  await assertPrivateDirectory(resolved);
}

export async function assertPrivateStateFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new GwsEaError('unsafe_state', `Private state must be a regular file: ${file}`);
  }
  assertOwnedByCurrentUser(info.uid, `Private state must be owned by the current user: ${file}`);
  if (!isOwnerOnlyMode(info.mode)) {
    throw new GwsEaError('unsafe_mode', `Private state must be readable only by its owner (0600): ${file}`);
  }
}
