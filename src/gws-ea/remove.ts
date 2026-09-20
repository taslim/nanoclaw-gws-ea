import { access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readJson, writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
import { deleteOwnedGcpProject } from './gcloud.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { removeOnecliRuntime } from './onecli.js';
import { assertPrivateStateFile, preparePrivateLocalDirectory, type ControlPlanePaths } from './paths.js';
import { buildAllowlistedEnvironment, runSanitizedCommandOutcome } from './process.js';
import {
  assertInstanceId,
  assertRegistryMarkerAgreement,
  getInstanceReservation,
  releaseInstanceReservation,
  validateReservation,
} from './registry.js';
import { removePrivateFile } from './secrets.js';
import { loadInstanceRuntimeConfig } from './service.js';
import { createInstanceServiceCoordinates, type InstanceServicePlatform } from './service-coordinates.js';
import { GwsEaError, type InstanceReservation } from './types.js';
import { isRecord } from './validation.js';

const REMOVAL_SCHEMA_VERSION = 1 as const;
const REMOVAL_PHASES = ['nanoclaw', 'gcp_project', 'onecli', 'instance_files', 'registry'] as const;
type RemovalPhase = (typeof REMOVAL_PHASES)[number];

interface RemovalReceipt {
  readonly schema_version: typeof REMOVAL_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly reservation: InstanceReservation;
  readonly started_at: string;
  readonly completed: Record<RemovalPhase, string | null>;
}

export interface RemovalDependencies {
  readonly uninstallNanoclaw?: (reservation: InstanceReservation) => Promise<void>;
  readonly deleteGcpProject?: (reservation: InstanceReservation) => Promise<void>;
  readonly removeOnecli?: (reservation: InstanceReservation) => Promise<void>;
  readonly removeInstanceFiles?: (reservation: InstanceReservation) => Promise<void>;
}

export interface RemovalPreview {
  readonly instanceId: string;
  readonly checkout: string;
  readonly gcpProject: string;
  readonly gcpAccount: string;
  readonly onecliProject: string;
  readonly endpoint: string;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new GwsEaError('invalid_removal', `${label} contains unknown or missing fields`);
  }
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new GwsEaError('invalid_removal', `${label} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new GwsEaError('invalid_removal', `${label} is invalid`);
  }
  return value;
}

function validateReceipt(value: unknown, paths: ControlPlanePaths, instanceId: string): RemovalReceipt {
  if (!isRecord(value)) throw new GwsEaError('invalid_removal', 'Removal receipt is invalid');
  exactKeys(value, ['schema_version', 'instance_id', 'reservation', 'started_at', 'completed'], 'Removal receipt');
  if (value.schema_version !== REMOVAL_SCHEMA_VERSION || value.instance_id !== instanceId) {
    throw new GwsEaError('invalid_removal', 'Removal receipt does not match this instance');
  }
  if (!isRecord(value.completed)) throw new GwsEaError('invalid_removal', 'Removal phases are invalid');
  exactKeys(value.completed, REMOVAL_PHASES, 'Removal phases');
  const completed = {} as Record<RemovalPhase, string | null>;
  for (const phase of REMOVAL_PHASES) {
    const stamp = value.completed[phase];
    completed[phase] = stamp === null ? null : isoTimestamp(stamp, `${phase} completion`);
  }
  const reservation = validateReservation(value.reservation, paths);
  if (reservation.instance_id !== instanceId) {
    throw new GwsEaError('invalid_removal', 'Removal reservation does not match this instance');
  }
  return {
    schema_version: REMOVAL_SCHEMA_VERSION,
    instance_id: instanceId,
    reservation,
    started_at: isoTimestamp(value.started_at, 'Removal start'),
    completed,
  };
}

async function readReceipt(paths: ControlPlanePaths, instanceId: string): Promise<RemovalReceipt | undefined> {
  const file = paths.removalFile(instanceId);
  try {
    await assertPrivateStateFile(file);
    return validateReceipt(await readJson<unknown>(file), paths, instanceId);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    if (error instanceof GwsEaError) throw error;
    throw new GwsEaError('invalid_removal', 'Removal receipt cannot be read safely');
  }
}

async function ensureReceipt(paths: ControlPlanePaths, instanceId: string): Promise<RemovalReceipt> {
  const existing = await readReceipt(paths, instanceId);
  if (existing) return existing;
  const reservation = await assertRegistryMarkerAgreement(paths, instanceId);
  const receipt: RemovalReceipt = {
    schema_version: REMOVAL_SCHEMA_VERSION,
    instance_id: instanceId,
    reservation,
    started_at: new Date().toISOString(),
    completed: {
      nanoclaw: null,
      gcp_project: null,
      onecli: null,
      instance_files: null,
      registry: null,
    },
  };
  await preparePrivateLocalDirectory(paths.removalRoot);
  await writePrivate(paths.removalFile(instanceId), receipt);
  return receipt;
}

async function completePhase(
  paths: ControlPlanePaths,
  receipt: RemovalReceipt,
  phase: RemovalPhase,
  effect: () => Promise<void>,
): Promise<RemovalReceipt> {
  if (receipt.completed[phase] !== null) return receipt;
  await effect();
  const next: RemovalReceipt = {
    ...receipt,
    completed: { ...receipt.completed, [phase]: new Date().toISOString() },
  };
  await writePrivate(paths.removalFile(receipt.instance_id), next);
  return next;
}

async function uninstallNanoclaw(reservation: InstanceReservation): Promise<void> {
  let installId = reservation.instance_id.replaceAll('-', '');
  let homeDirectory = os.homedir();
  const runtimeFile = path.join(reservation.checkout_realpath, 'data', 'gws-ea', 'runtime.json');
  try {
    const runtime = await loadInstanceRuntimeConfig(runtimeFile);
    installId = runtime.install_id;
    homeDirectory = runtime.home_directory;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  const coordinates = (platform: InstanceServicePlatform, runningAsRoot: boolean) =>
    createInstanceServiceCoordinates({ installId, homeDirectory, platform, runningAsRoot });
  const environment = buildAllowlistedEnvironment(
    {},
    { HOME: homeDirectory, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
  );
  const outcome = (command: string, args: readonly string[]) =>
    runSanitizedCommandOutcome({
      command,
      args,
      cwd: reservation.checkout_realpath,
      env: environment,
      timeoutMs: 120_000,
    });
  const run = async (command: string, args: readonly string[], acceptFailure = false): Promise<string> => {
    const result = await outcome(command, args);
    if (result.exitCode !== 0 && !acceptFailure) {
      throw new GwsEaError('nanoclaw_removal_incomplete', `Could not remove the instance ${command} resource`);
    }
    return result.stdout;
  };

  if (process.platform === 'darwin') {
    const service = coordinates('macos', false);
    await run('launchctl', ['unload', service.serviceDefinitionPath], true);
    const uid = process.getuid?.();
    if (uid === undefined) throw new GwsEaError('unsupported_platform', 'launchd requires a user ID');
    const serviceDomain = `gui/${uid}/${service.serviceIdentity}`;
    await run('launchctl', ['bootout', serviceDomain], true);
    if ((await outcome('launchctl', ['print', serviceDomain])).exitCode === 0) {
      throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw launchd service is still loaded');
    }
    await rm(service.serviceDefinitionPath, { force: true });
  } else if (process.platform === 'linux') {
    const userService = coordinates('linux', false);
    try {
      await access(userService.serviceDefinitionPath);
      await run('systemctl', ['--user', 'disable', '--now', `${userService.serviceIdentity}.service`], true);
      if (
        (await outcome('systemctl', ['--user', 'is-active', `${userService.serviceIdentity}.service`])).exitCode === 0
      ) {
        throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw user service is still active');
      }
      await rm(userService.serviceDefinitionPath, { force: true });
      await run('systemctl', ['--user', 'daemon-reload']);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    const systemService = coordinates('linux', true);
    try {
      await access(systemService.serviceDefinitionPath);
      if (process.getuid?.() !== 0) {
        throw new GwsEaError(
          'root_required',
          `Re-run removal with root privileges to remove ${systemService.serviceDefinitionPath}`,
        );
      }
      await run('systemctl', ['disable', '--now', `${systemService.serviceIdentity}.service`], true);
      if ((await outcome('systemctl', ['is-active', `${systemService.serviceIdentity}.service`])).exitCode === 0) {
        throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw system service is still active');
      }
      await rm(systemService.serviceDefinitionPath, { force: true });
      await run('systemctl', ['daemon-reload']);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }

  const hostPattern = path
    .join(reservation.checkout_realpath, 'dist', 'index.js')
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const killed = await outcome('pkill', ['-f', hostPattern]);
  if (killed.exitCode !== 0 && killed.exitCode !== 1) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'Could not stop the NanoClaw host process');
  }
  const remaining = await outcome('pgrep', ['-f', hostPattern]);
  if (remaining.exitCode === 0) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw host process is still running');
  }
  if (remaining.exitCode !== 1) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'Could not verify the NanoClaw host process stopped');
  }

  const resources = coordinates(process.platform === 'darwin' ? 'macos' : 'linux', process.getuid?.() === 0);
  const ids = (await run('docker', ['ps', '-aq', '--filter', `label=${resources.installLabel}`]))
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length > 0) await run('docker', ['rm', '--force', ...ids]);
  if ((await run('docker', ['ps', '-aq', '--filter', `label=${resources.installLabel}`])).trim()) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw containers remain after removal');
  }
  if ((await run('docker', ['image', 'ls', '--quiet', '--no-trunc', resources.imageTag])).trim()) {
    await run('docker', ['image', 'rm', resources.imageTag]);
  }
  if ((await run('docker', ['image', 'ls', '--quiet', '--no-trunc', resources.imageTag])).trim()) {
    throw new GwsEaError('nanoclaw_removal_incomplete', 'NanoClaw image remains after removal');
  }
}

async function deleteGcpProject(reservation: InstanceReservation): Promise<void> {
  const claims = reservation.exclusive_resource_claims;
  await deleteOwnedGcpProject({
    instanceId: reservation.instance_id,
    projectId: claims.gcp_project_id,
    account: claims.gcp_account,
    cwd: path.dirname(reservation.checkout_realpath),
  });
}

async function removeOnecli(reservation: InstanceReservation): Promise<void> {
  const claims = reservation.exclusive_resource_claims;
  await removeOnecliRuntime(
    createOnecliRuntimeLayout({
      instanceId: reservation.instance_id,
      instanceRoot: path.dirname(reservation.checkout_realpath),
      project: claims.onecli_project,
      appPort: reservation.allocated_ports.onecli_app,
      gatewayPort: reservation.allocated_ports.onecli_gateway,
      cliExecutable: '/usr/local/bin/onecli',
    }),
  );
}

export async function describeRemoval(paths: ControlPlanePaths, instanceId: string): Promise<RemovalPreview> {
  assertInstanceId(instanceId);
  const receipt = await readReceipt(paths, instanceId);
  const reservation = receipt?.reservation ?? (await getInstanceReservation(paths, instanceId));
  const claims = reservation.exclusive_resource_claims;
  return {
    instanceId,
    checkout: reservation.checkout_realpath,
    gcpProject: claims.gcp_project_id,
    gcpAccount: claims.gcp_account,
    onecliProject: claims.onecli_project,
    endpoint: claims.endpoint_url,
  };
}

export async function removeAssistant(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: RemovalDependencies = {},
): Promise<void> {
  assertInstanceId(instanceId);
  await preparePrivateLocalDirectory(path.dirname(paths.instanceLock(instanceId)));
  const release = await processLock(paths.instanceLock(instanceId));
  if (!release) throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
  try {
    let receipt = await ensureReceipt(paths, instanceId);
    receipt = await completePhase(paths, receipt, 'nanoclaw', () =>
      (dependencies.uninstallNanoclaw ?? uninstallNanoclaw)(receipt.reservation),
    );
    receipt = await completePhase(paths, receipt, 'gcp_project', () =>
      (dependencies.deleteGcpProject ?? deleteGcpProject)(receipt.reservation),
    );
    receipt = await completePhase(paths, receipt, 'onecli', () =>
      (dependencies.removeOnecli ?? removeOnecli)(receipt.reservation),
    );
    receipt = await completePhase(paths, receipt, 'instance_files', () =>
      dependencies.removeInstanceFiles
        ? dependencies.removeInstanceFiles(receipt.reservation)
        : rm(paths.instanceRoot(instanceId), { recursive: true, force: true }),
    );
    receipt = await completePhase(paths, receipt, 'registry', () =>
      releaseInstanceReservation(paths, receipt.reservation),
    );
    await removePrivateFile(paths.removalFile(instanceId));
  } finally {
    release();
  }
}
