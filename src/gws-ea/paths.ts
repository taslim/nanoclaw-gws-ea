import fs from 'node:fs';
import { chmod, lstat, mkdir, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GwsEaError } from './types.js';

/** The checkout this control plane runs from (`src/gws-ea` and `dist/gws-ea` both sit two levels below it). */
export const CONTROL_PLANE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  instancesRoot: string;
  logsRoot: string;
  preReservationLogsRoot: string;
  instanceLogsRoot(instanceId: string): string;
  instanceRoot(instanceId: string): string;
  checkoutRoot(instanceId: string): string;
  journalFile(instanceId: string): string;
  instanceLock(instanceId: string): string;
  markerFile(instanceId: string): string;
  bootstrapFile(instanceId: string): string;
  releasePreflightFile(instanceId: string): string;
  principalSelectionFile(instanceId: string): string;
  chatConfigurationFile(instanceId: string): string;
  removalFile(instanceId: string): string;
}

const REMOTE_FILESYSTEM_TYPES = new Set([
  0x6969n, // NFS
  0x517bn, // SMB
  0xff534d42n, // CIFS
  0x73757245n, // CODA
  0x5346414fn, // AFS
  0x01021997n, // 9P
  0x65735546n, // FUSE: may be backed by sshfs or another remote service
]);

function nearestExistingAncestor(target: string): string {
  let candidate = target;
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

function canonicalNewPath(target: string): string {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new GwsEaError('unsafe_path', `Managed root must not be a symlink: ${resolved}`);
  }
  const ancestor = nearestExistingAncestor(resolved);
  const canonicalAncestor = fs.realpathSync(ancestor);
  const relative = path.relative(ancestor, resolved);
  return path.join(canonicalAncestor, relative);
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
  const instancesRoot = path.join(stateRoot, 'instances');
  const removalRoot = path.join(configRoot, 'removals');
  const ingressRoot = path.join(stateRoot, 'ingress');
  const cloudflareRoot = path.join(ingressRoot, 'cloudflare');
  const logsRoot = path.join(stateRoot, 'logs');
  const instanceRoot = (instanceId: string): string => path.join(instancesRoot, instanceId);
  const checkoutRoot = (instanceId: string): string => path.join(instanceRoot(instanceId), 'nanoclaw');

  return {
    configRoot,
    stateRoot,
    registryFile: path.join(configRoot, 'instances.json'),
    registryLock: path.join(configRoot, 'instances.lock'),
    removalRoot,
    ingressRoot,
    cloudflareRoot,
    instancesRoot,
    logsRoot,
    preReservationLogsRoot: path.join(logsRoot, 'runs'),
    instanceLogsRoot: (instanceId) => path.join(logsRoot, instanceId),
    instanceRoot,
    checkoutRoot,
    journalFile: (instanceId) => path.join(instanceRoot(instanceId), 'provision.json'),
    instanceLock: (instanceId) => path.join(configRoot, 'locks', `${instanceId}.lock`),
    markerFile: (instanceId) => path.join(checkoutRoot(instanceId), 'data', 'gws-ea', 'instance.json'),
    bootstrapFile: (instanceId) => path.join(instanceRoot(instanceId), 'bootstrap.json'),
    releasePreflightFile: (instanceId) => path.join(instanceRoot(instanceId), 'release-preflight.json'),
    principalSelectionFile: (instanceId) => path.join(instanceRoot(instanceId), 'principal-selection.json'),
    chatConfigurationFile: (instanceId) => path.join(instanceRoot(instanceId), 'chat-configured.json'),
    removalFile: (instanceId) => path.join(removalRoot, `${instanceId}.json`),
  };
}

/** Whether `target` lies strictly inside `root` (both absolute, already canonical where it matters). */
export function isWithinDirectory(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function unsignedFilesystemType(type: number | bigint): bigint {
  return BigInt.asUintN(64, BigInt(type));
}

export function isLocalFilesystemType(type: number | bigint): boolean {
  return !REMOTE_FILESYSTEM_TYPES.has(unsignedFilesystemType(type));
}

export async function assertLocalOwnedDestination(target: string): Promise<void> {
  const ancestor = nearestExistingAncestor(path.resolve(target));
  const info = await lstat(ancestor);
  if (info.isSymbolicLink()) {
    throw new GwsEaError('unsafe_path', `Managed path resolves through a symlinked destination: ${ancestor}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new GwsEaError('unsafe_owner', `Managed path parent must be owned by the current user: ${ancestor}`);
  }
  const filesystem = await statfs(ancestor);
  if (!isLocalFilesystemType(filesystem.type)) {
    throw new GwsEaError('remote_filesystem', `Managed path must be on a local filesystem: ${target}`);
  }
}

export async function assertOwnedLocalDirectory(directory: string, requiredMode?: number): Promise<void> {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new GwsEaError('unsafe_path', `Managed root is not a physical directory: ${directory}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new GwsEaError('unsafe_owner', `Managed root must be owned by the current user: ${directory}`);
  }
  if (requiredMode !== undefined && (info.mode & 0o777) !== requiredMode) {
    throw new GwsEaError(
      'unsafe_mode',
      `Managed root must have mode ${requiredMode.toString(8).padStart(4, '0')}: ${directory}`,
    );
  }
  const filesystem = await statfs(directory);
  if (!isLocalFilesystemType(filesystem.type)) {
    throw new GwsEaError('remote_filesystem', `Managed root must be on a local filesystem: ${directory}`);
  }
}

export async function preparePrivateLocalDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new GwsEaError('unsafe_path', `Managed root must not be a symlink: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) {
    await assertLocalOwnedDestination(resolved);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
  }
  await assertOwnedLocalDirectory(resolved, 0o700);
}

export async function assertPrivateLocalDirectory(directory: string): Promise<void> {
  await assertOwnedLocalDirectory(path.resolve(directory), 0o700);
}

export async function assertPrivateStateFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new GwsEaError('unsafe_state', `Private state must be a regular file: ${file}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new GwsEaError('unsafe_owner', `Private state must be owned by the current user: ${file}`);
  }
  if ((info.mode & 0o777) !== 0o600) {
    throw new GwsEaError('unsafe_mode', `Private state must have mode 0600: ${file}`);
  }
}
