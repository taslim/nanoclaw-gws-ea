/**
 * A stray NanoClaw install in the checkout gws-ea runs from. That checkout is
 * itself a NanoClaw tree, so NanoClaw's own setup, `pnpm run dev`, a service
 * install, or `container/build.sh` run there creates an install no assistant
 * owns, keyed by the checkout path's hash. gws-ea is the only way NanoClaw
 * runs from this tree, so such an install is always a mistake: gws-ea removes
 * it whole, and its read-only commands only note it.
 */
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readdir, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from '../community-portal/errors.js';
import { getInstallScopedNames } from '../install-slug.js';
import {
  CONTROL_PLANE_ROOT,
  instanceMarkerFile,
  instanceRuntimeFile,
  isWithinDirectory,
  type ControlPlanePaths,
} from './paths.js';
import { pollUntil } from './poll.js';
import { resolveDockerEndpoint } from './prerequisites.js';
import { buildToolEnvironment, runSanitizedCommandOutcome, type SanitizedCommandOutcomeRunner } from './process.js';
import { repositoryTags, uninstallNanoclaw } from './remove.js';
import type { HostStatusHelpers } from './service.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import {
  createInstanceServiceCoordinates,
  instanceServicePlatform,
  type InstanceServicePlatform,
} from './service-coordinates.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

/** How long a check the operator did not ask for waits on Docker. */
const QUICK_CHECK_MS = 500;
/** How long `gws-ea cleanup`, which the operator asked for, waits on Docker. */
export const FULL_CHECK_MS = 10_000;
const HOST_POLL_MS = 500;
const HOST_STOP_LIMIT_MS = 30_000;

export interface StraySeams {
  readonly platform?: InstanceServicePlatform;
  readonly homeDirectory?: string;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  readonly resolveDocker?: () => Promise<string>;
  readonly terminate?: (pid: number) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** The checkout gws-ea runs from. Only the launcher names it, so nothing else ever cleans a tree. */
export interface ToolCheckout extends StraySeams {
  /** Its real path. */
  readonly root: string;
  /** NanoClaw's `.env` backup (`setup/uninstall/remove.ts`): a copy beside it that never clobbers an earlier one. */
  readonly backupEnv: (envPath: string) => string;
}

export interface StrayLauncher {
  readonly recordRemoved?: (part: string) => void;
  readonly recordEffect?: (changed: true | null) => void;
  readonly hostStatus: HostStatusHelpers;
  readonly serviceHelpers: NanoclawServiceHelpers;
}

export interface StrayInstall {
  readonly root: string;
  readonly services: readonly string[];
  readonly files: readonly string[];
  readonly containers: number;
  readonly imageTags: number;
  /** Why Docker's containers and image tags went unchecked; their counts are then 0. */
  readonly unchecked?: string;
}

/** Files in the checkout only an install leaves. `.env` and empty directories are not among them: tests leave those. */
const INSTALL_FILES = ['data/v2.db', 'data/ncl.sock', 'start-nanoclaw.sh', 'nanoclaw.pid'] as const;
/** gws-ea's own log, which `gws-ea.sh` writes in the checkout it runs from. */
const OWN_LOG = 'gws-ea-setup.log';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Named for the operator; empty when there is no stray install. */
export function strayParts(stray: StrayInstall): string[] {
  return [
    ...stray.services,
    ...stray.files,
    ...(stray.containers > 0 ? [plural(stray.containers, 'container')] : []),
    ...(stray.imageTags > 0 ? [plural(stray.imageTags, 'image tag')] : []),
  ];
}

export function strayNote(stray: StrayInstall): string | undefined {
  const parts = strayParts(stray);
  if (parts.length === 0) return undefined;
  return `Note: a stray NanoClaw install is in ${stray.root} (${parts.join(', ')}); gws-ea cleanup removes it.`;
}

async function entryAt(file: string): Promise<Stats | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  return (await entryAt(file)) !== undefined;
}

/** The slug NanoClaw derives from the checkout's own path, never from the environment. */
function strayCoordinates(checkout: ToolCheckout) {
  const platform = checkout.platform ?? instanceServicePlatform();
  const homeDirectory = checkout.homeDirectory ?? os.homedir();
  const installId = createHash('sha1').update(checkout.root).digest('hex').slice(0, 8);
  const { containerImageBase, containerInstallLabel } = getInstallScopedNames(installId);
  const services = (platform === 'macos' ? [false] : [false, true]).map(
    (runningAsRoot) =>
      createInstanceServiceCoordinates({ installId, homeDirectory, platform, runningAsRoot }).serviceDefinitionPath,
  );
  return { platform, homeDirectory, installId, containerImageBase, containerInstallLabel, services };
}

/** A checkout that is an assistant's, or that holds gws-ea's own state, is never cleaned. */
async function guarded(root: string, paths: ControlPlanePaths): Promise<boolean> {
  const within = (inner: string, outer: string): boolean => inner === outer || isWithinDirectory(inner, outer);
  if (within(root, paths.stateRoot) || within(paths.stateRoot, root) || within(paths.configRoot, root)) return true;
  return (await exists(instanceMarkerFile(root))) || (await exists(instanceRuntimeFile(root)));
}

/**
 * Look for a stray install. Every probe runs at once, and Docker's are killed
 * at `deadlineMs`, so a clean checkout is checked in a fraction of a second.
 * Docker not answering in time leaves its probes unchecked, never failed.
 */
export async function detectStrayInstall(
  checkout: ToolCheckout,
  paths: ControlPlanePaths,
  deadlineMs: number = QUICK_CHECK_MS,
): Promise<StrayInstall> {
  const { root } = checkout;
  const nothing: StrayInstall = { root, services: [], files: [], containers: 0, imageTags: 0 };
  if (await guarded(root, paths)) return nothing;
  const stray = strayCoordinates(checkout);
  const run = checkout.runCommand ?? runSanitizedCommandOutcome;
  const env = buildToolEnvironment(process.env, { HOME: stray.homeDirectory });
  const docker = async (args: readonly string[]): Promise<string> => {
    const { exitCode, stdout, stderr } = await run({
      command: 'docker',
      args,
      cwd: CONTROL_PLANE_ROOT,
      env,
      timeoutMs: deadlineMs,
    });
    if (exitCode !== 0) throw new Error(stderr.trim() || `docker exited with code ${exitCode}`);
    return stdout;
  };
  const shown = (file: string): string =>
    isWithinDirectory(file, stray.homeDirectory) ? `~${file.slice(stray.homeDirectory.length)}` : file;
  const [services, files, docked] = await Promise.all([
    Promise.all(stray.services.map(async (file) => ((await exists(file)) ? [shown(file)] : []))),
    Promise.all(INSTALL_FILES.map(async (file) => ((await exists(path.join(root, file))) ? [file] : []))),
    Promise.all([
      docker(['ps', '-aq', '--filter', `label=${stray.containerInstallLabel}`]),
      docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', stray.containerImageBase]),
    ]).then(
      // Tags are counted as the teardown lists them, so a check finds exactly what a removal removes.
      ([containers, images]) => ({
        containers: containers.split(/\r?\n/u).filter((id) => id.trim()).length,
        imageTags: repositoryTags(images, stray.containerImageBase).length,
      }),
      (error: unknown) => ({
        containers: 0,
        imageTags: 0,
        unchecked: error instanceof Error ? error.message : String(error),
      }),
    ),
  ]);
  return { root, services: services.flat(), files: files.flat(), ...docked };
}

/**
 * A host answering on the checkout's socket is stopped first: one started by
 * hand has relative arguments no kill pattern matches. gws-ea's own NanoClaw
 * teardown then removes the rest of the install. State goes only once no host
 * answers, and `data/` last, so an interrupted removal stays detectable and
 * the next run finishes it. Each entry is removed by its own name, so one
 * linked elsewhere loses its link, never what it points at.
 */
export async function removeStrayInstall(
  checkout: ToolCheckout,
  found: StrayInstall,
  launcher: StrayLauncher,
): Promise<string[]> {
  const { root } = checkout;
  const stray = strayCoordinates(checkout);
  const run = checkout.runCommand ?? runSanitizedCommandOutcome;
  const sleep: (milliseconds: number) => Promise<void> = checkout.sleep ?? delay;
  /** Undefined only when nothing listens on the checkout's socket; `unanswered` when something does but gave no PID. */
  const host = async (): Promise<number | 'unanswered' | undefined> => {
    try {
      const status = await launcher.hostStatus.queryHost(root);
      return isRecord(status) && typeof status.pid === 'number' ? status.pid : 'unanswered';
      // eslint-disable-next-line no-catch-all/no-catch-all -- Upstream queryHost reports every failure as a plain Error; a busy host answers late, so only a missing or refused socket means no host.
    } catch (error) {
      return isErrno(error, 'ENOENT') || isErrno(error, 'ECONNREFUSED') ? undefined : 'unanswered';
    }
  };
  const stillAnswering = (): GwsEaError =>
    new GwsEaError(
      'nanoclaw_removal_incomplete',
      `A NanoClaw host still answers on ${path.join(root, 'data', 'ncl.sock')}; stop it, then retry.`,
    );
  // The parts it was found by that are files are state, named as they are removed.
  const removed = strayParts({ ...found, files: [] });
  const remove = async (target: string, label: string): Promise<void> => {
    try {
      await rm(target, { recursive: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return;
      throw error;
    }
    removed.push(label);
    launcher.recordRemoved?.(label);
  };

  const answering = await host();
  // With no host listening, a nohup PID file is stale, and its PID may belong to another process by now, which
  // NanoClaw's own nohup stop would signal.
  if (answering === undefined) await remove(path.join(root, 'nanoclaw.pid'), 'nanoclaw.pid');
  if (typeof answering === 'number') {
    launcher.recordEffect?.(null);
    (checkout.terminate ?? terminate)(answering);
    // Gone, or replaced by a service manager restarting it, which the teardown stops.
    const now = await pollUntil(
      host,
      (state) => state === undefined || (typeof state === 'number' && state !== answering),
      {
        intervalMs: HOST_POLL_MS,
        limitMs: HOST_STOP_LIMIT_MS,
        sleep,
      },
    );
    if (now === answering) throw stillAnswering();
    launcher.recordEffect?.(true);
  }
  launcher.recordEffect?.(null);
  await uninstallNanoclaw(
    {
      checkoutRoot: root,
      installId: stray.installId,
      homeDirectory: stray.homeDirectory,
      dockerEndpoint: await (checkout.resolveDocker ?? (() => resolveDockerEndpoint(run)))(),
    },
    { platform: stray.platform, run, sleep, serviceHelpers: launcher.serviceHelpers, recordedImages: [] },
  );
  for (const part of strayParts({ ...found, files: [] })) launcher.recordRemoved?.(part);
  if ((await host()) !== undefined) throw stillAnswering();

  const env = path.join(root, '.env');
  if (await exists(env)) {
    const backup = checkout.backupEnv(env);
    await rm(env, { force: true });
    const part = `.env (kept as ${path.basename(backup)})`;
    removed.push(part);
    launcher.recordRemoved?.(part);
  }
  for (const [entry, label] of [
    ['groups', 'groups/'],
    ['store', 'store/'],
    ['start-nanoclaw.sh', 'start-nanoclaw.sh'],
    ['nanoclaw.pid', 'nanoclaw.pid'],
  ] as const) {
    await remove(path.join(root, entry), label);
  }
  // A logs/ linked elsewhere is not the checkout's to empty, and it holds gws-ea's own log too.
  const logs = path.join(root, 'logs');
  const logEntries = (await entryAt(logs))?.isDirectory()
    ? (await readdir(logs)).filter((entry) => entry !== OWN_LOG)
    : [];
  for (const entry of logEntries) {
    await rm(path.join(logs, entry), { recursive: true, force: true });
    launcher.recordEffect?.(true);
  }
  if (logEntries.length > 0) {
    removed.push("NanoClaw's logs");
    launcher.recordRemoved?.("NanoClaw's logs");
  }
  // NanoClaw's setup links `ncl` to its checkout; a link to any other install stays.
  const ncl = path.join(stray.homeDirectory, '.local', 'bin', 'ncl');
  const linked = await readlink(ncl).then(
    (target) => path.resolve(path.dirname(ncl), target),
    (error: unknown) => {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'EINVAL')) return undefined;
      throw error;
    },
  );
  if (linked === path.join(root, 'bin', 'ncl')) await remove(ncl, '~/.local/bin/ncl');
  await remove(path.join(root, 'data'), 'data/');
  return removed;
}

function terminate(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!isErrno(error, 'ESRCH')) throw error;
  }
}
