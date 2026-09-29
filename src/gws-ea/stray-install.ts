/**
 * A stray NanoClaw install in the checkout gws-ea runs from. That checkout is
 * itself a NanoClaw tree, so NanoClaw's own setup, `pnpm run dev`, a service
 * install, or `container/build.sh` run there creates an install no assistant
 * owns, keyed by the checkout path's hash. gws-ea is the only way NanoClaw
 * runs from this tree, so such an install is always a mistake: `create`,
 * `update`, and `cleanup` remove it whole, and `list` and `status` note it.
 */
import { createHash } from 'node:crypto';
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
import { uninstallNanoclaw } from './remove.js';
import type { HostStatusHelpers } from './service.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import {
  createInstanceServiceCoordinates,
  instanceServicePlatform,
  type InstanceServicePlatform,
} from './service-coordinates.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

/** How long the check before `create` and `update`, and `list`'s and `status`'s note, wait on Docker. */
export const QUICK_CHECK_MS = 500;
/** How long `gws-ea cleanup`, which the operator asked for, waits on Docker. */
export const FULL_CHECK_MS = 10_000;
/** How often, and for how long, removal waits for a host it stopped to go. */
const HOST_POLL_MS = 500;
const HOST_STOP_LIMIT_MS = 30_000;

/** Boundary seams; each defaults to the real one. */
export interface StraySeams {
  readonly platform?: InstanceServicePlatform;
  readonly homeDirectory?: string;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  /** The active local Docker endpoint, which the teardown runs against. */
  readonly resolveDocker?: () => Promise<string>;
  /** Sends SIGTERM to a host started by hand. */
  readonly terminate?: (pid: number) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** The checkout gws-ea runs from. Only the launcher names it, so nothing else ever cleans a tree (KTD4). */
export interface ToolCheckout extends StraySeams {
  /** Its real path. */
  readonly root: string;
  /** NanoClaw's own `.env` backup (`setup/uninstall/remove.ts`): a copy beside it, never clobbering one; its path. */
  readonly backupEnv: (envPath: string) => string;
}

/** Upstream's helpers removal stops the stray's host with; the launcher supplies them. */
export interface StrayLauncher {
  readonly hostStatus: HostStatusHelpers;
  readonly serviceHelpers: NanoclawServiceHelpers;
}

/** What a check found in the tool checkout. */
export interface StrayInstall {
  readonly root: string;
  /** Its service definitions. */
  readonly services: readonly string[];
  /** Files in the checkout only an install leaves: its database, host socket, and nohup launcher. */
  readonly files: readonly string[];
  readonly containers: number;
  readonly imageTags: number;
  /** Why Docker's containers and image tags went unchecked, when Docker did not answer in time. */
  readonly unchecked?: string;
}

/** Files in the checkout only an install leaves. `.env` and empty directories are not among them: tests leave those. */
const INSTALL_FILES = ['data/v2.db', 'data/ncl.sock', 'start-nanoclaw.sh', 'nanoclaw.pid'] as const;
/** gws-ea's own log, which `setup/gws-ea.ts` writes in the checkout it runs from. */
const OWN_LOG = 'gws-ea-setup.log';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Each part a check found, named for the operator; none means there is no stray install. */
export function strayParts(stray: StrayInstall): string[] {
  return [
    ...stray.services,
    ...stray.files,
    ...(stray.containers > 0 ? [plural(stray.containers, 'container')] : []),
    ...(stray.imageTags > 0 ? [plural(stray.imageTags, 'image tag')] : []),
  ];
}

/** The note `list` and `status` add beside their result when a stray install is present. */
export function strayNote(stray: StrayInstall): string | undefined {
  const parts = strayParts(stray);
  if (parts.length === 0) return undefined;
  return `Note: a stray NanoClaw install is in ${stray.root} (${parts.join(', ')}); gws-ea cleanup removes it.`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
}

/** Where the stray install lives: the slug NanoClaw derives from the checkout's own path, never from the environment (KTD3). */
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

/** A checkout that is an assistant's, or that holds gws-ea's own state, is never cleaned (R8). */
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
  const docker = async (args: readonly string[]): Promise<string[]> => {
    const { exitCode, stdout, stderr } = await run({
      command: 'docker',
      args,
      cwd: CONTROL_PLANE_ROOT,
      env,
      timeoutMs: deadlineMs,
    });
    if (exitCode !== 0) throw new Error(stderr.trim() || `docker exited with code ${exitCode}`);
    return stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
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
      ([containers, references]) => ({
        containers: containers.length,
        imageTags: references.filter((reference) => !reference.endsWith(':<none>')).length,
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
 * Remove a stray install whole (R1, R2, R9). A host answering on the
 * checkout's socket is stopped first: one started by hand has relative
 * arguments no kill pattern matches (KTD5). gws-ea's own NanoClaw teardown
 * then removes the service, any host it left, the containers, and every tag
 * in the stray's image repository (KTD2). State goes only once no host
 * answers, and `data/` last, so an interrupted removal stays detectable and
 * the next run finishes it. Returns what it removed, named for the operator.
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
  /** The PID of the host answering for this checkout; undefined only when nothing listens on its socket. */
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

  const answering = await host();
  if (typeof answering === 'number') {
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
  }
  await uninstallNanoclaw(
    {
      checkoutRoot: root,
      installId: stray.installId,
      homeDirectory: stray.homeDirectory,
      dockerEndpoint: await (checkout.resolveDocker ?? (() => resolveDockerEndpoint(run)))(),
    },
    { platform: stray.platform, run, sleep, serviceHelpers: launcher.serviceHelpers, recordedImages: [] },
  );
  if ((await host()) !== undefined) throw stillAnswering();

  // The files it was found by are state, named as the state below is removed.
  const removed = strayParts({ ...found, files: [] });
  const remove = async (target: string, label: string): Promise<void> => {
    if (!(await exists(target))) return;
    await rm(target, { recursive: true, force: true });
    removed.push(label);
  };
  const env = path.join(root, '.env');
  if (await exists(env)) {
    const backup = checkout.backupEnv(env);
    await rm(env, { force: true });
    removed.push(`.env (kept as ${path.basename(backup)})`);
  }
  for (const entry of ['groups/', 'store/', 'start-nanoclaw.sh', 'nanoclaw.pid']) {
    await remove(path.join(root, entry), entry);
  }
  const logs = path.join(root, 'logs');
  const logEntries = (await exists(logs)) ? (await readdir(logs)).filter((entry) => entry !== OWN_LOG) : [];
  for (const entry of logEntries) await rm(path.join(logs, entry), { recursive: true, force: true });
  if (logEntries.length > 0) removed.push("NanoClaw's logs");
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
  await remove(path.join(root, 'data/'), 'data/');
  return removed;
}

function terminate(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!isErrno(error, 'ESRCH')) throw error;
  }
}
