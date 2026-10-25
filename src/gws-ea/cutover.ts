/**
 * What update and rollback share on the release layout: the fence, the one switch, and the host checks and
 * follow-ups around them. Neither the fence nor the switch moves or copies state.
 */
import { readdir, readFile, readlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from '../community-portal/errors.js';
import { getInstallScopedNames } from '../install-slug.js';
import { removeReleaseImage, reclaimImage } from './agent-image-release.js';
import { taggedImageId, type ImageDocker } from './agent-image.js';
import { CHAT_HEALTH_ARGS, chatReceiving, parseChatHealth } from './chat-health.js';
import { observeLiveCheckout } from './checkout.js';
import { runStep, type StepReporter } from './events.js';
import { loadCreatedRuntime, type InstanceOperation } from './journal.js';
import { runInstanceNclJson, type InstanceNclOptions } from './ncl.js';
import { observeOnecliRuntime, reconcileOnecliRuntime } from './onecli.js';
import type { OnecliPins, OnecliRuntimeLayout } from './onecli-compose.js';
import {
  addFollowUps,
  completeFollowUp,
  readOperationRecord,
  readRollbackPoint,
  type OperationFollowUp,
  type OperationStop,
} from './operation.js';
import { canonicalPath, isWithinDirectory, type ControlPlanePaths } from './paths.js';
import type { Observation } from './phases.js';
import { pollUntil } from './poll.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { instanceOnecliLayout } from './provision.js';
import { redact, safeErrorMessage } from './redact.js';
import { getInstanceReservation } from './registry.js';
import {
  exists,
  fence,
  pointCurrent,
  pruneInstance,
  readCurrent,
  releaseName,
  type InstanceLayout,
} from './release-layout.js';
import { applyReleaseFiles } from './release-stage.js';
import {
  loadInstanceRuntimeConfig,
  reloadInstanceService,
  stampUpgradeState,
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
import { GwsEaError, releaseLine, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import { isRecord, parseJson, requireRecord, requireString, unwrapData } from './validation.js';
import { hostLeaseLive, readDerivedImageGroups } from './verify.js';

/** `--rm` removes the containers the drain stopped only after they exit, so the proof waits for them. */
const CONTAINER_POLL_MS = 1_000;
const CONTAINER_LIMIT_MS = 30_000;
const PROBE_TIMEOUT_MS = 60_000;
/** The process a Linux VM runs as on macOS, as lsof names it (shortened). */
const APPLE_VM = /^com\.apple\.Virtualization/u;
const DOCKER_DESKTOP_DISK = 'Docker.raw';
const INVALID_DOCKER_OUTPUT = 'invalid_docker_output';

export interface QuietInstance {
  /** `<state root>/<hex8>`: every release, its state, and its records. */
  readonly instanceRoot: string;
  /** The physical `state/`, which no process may hold open. */
  readonly state: string;
  readonly installId: string;
  readonly homeDirectory: string;
  readonly dockerEndpoint: string;
}

export interface QuiescenceSeams {
  readonly runCommand?: SanitizedCommandRunner;
  readonly platform?: NodeJS.Platform;
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly procRoot?: string;
}

/** `file` may be the process's working directory. */
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
 * A process whose arguments name only paths under `logs/` (`gws-ea logs --follow`) touches no state. One started
 * with relative paths names none; the open-file check catches it.
 */
async function processesRunningFrom(
  instanceRoot: string,
  seams: QuiescenceSeams,
): Promise<Array<{ readonly pid: number; readonly args: string }>> {
  const { stdout } = await (seams.runCommand ?? runSanitizedCommand)({
    command: 'ps',
    args: ['-A', '-ww', '-o', 'pid=', '-o', 'args='],
    cwd: path.dirname(instanceRoot),
    env: toolEnvironment(seams),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const inside = `${instanceRoot}${path.sep}`;
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

function quietDocker(instance: QuietInstance, seams: QuiescenceSeams, args: readonly string[]) {
  return (seams.runCommand ?? runSanitizedCommand)({
    command: 'docker',
    args: [...args],
    cwd: instance.homeDirectory,
    env: toolEnvironment(seams, { HOME: instance.homeDirectory, DOCKER_HOST: instance.dockerEndpoint }),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

async function labeledContainers(instance: QuietInstance, seams: QuiescenceSeams): Promise<string[]> {
  const label = getInstallScopedNames(instance.installId).containerInstallLabel;
  const { stdout } = await quietDocker(instance, seams, ['ps', '--all', '--quiet', '--filter', `label=${label}`]);
  return stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * lsof exits 1 both when nothing it was asked about is open and, on macOS, when it skipped a process it may not
 * inspect, so status 1 says nothing about its output; any other failing status stands.
 */
const LSOF = 'lsof "$@"; status=$?; [ "$status" -le 1 ] || exit "$status"';

/** Its status cannot say whether lsof met an error, so anything on stderr fails the check. */
async function lsofHolders(directory: string, seams: QuiescenceSeams): Promise<OpenFileHolder[]> {
  const { stdout, stderr } = await (seams.runCommand ?? runSanitizedCommand)({
    command: 'sh',
    args: ['-c', LSOF, 'lsof', '-n', '-P', '-w', '-F', 'pcn', '+D', directory],
    // Run from beside it: `lsof +D` reports every process whose working directory is inside, its own included.
    cwd: path.dirname(directory),
    env: toolEnvironment(seams),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (stderr.trim()) {
    throw new GwsEaError(
      'command_failed',
      `lsof could not tell what holds ${directory} open: ${redact(stderr.trim())}`,
    );
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
 * Working directories included. Matching arguments misses a process started with relative paths, or an idle
 * database connection; this sees both.
 */
export async function openFileHolders(
  directory: string,
  seams: QuiescenceSeams = {},
): Promise<readonly OpenFileHolder[]> {
  const platform = seams.platform ?? process.platform;
  if (platform === 'darwin') return lsofHolders(directory, seams);
  if (platform === 'linux') return procHolders(directory, seams.procRoot ?? '/proc');
  throw new GwsEaError('unsupported_platform', `Proving an assistant quiet needs macOS or Linux, not ${platform}`);
}

function notQuiet(instanceRoot: string, detail: string): GwsEaError {
  return new GwsEaError(
    'instance_not_quiet',
    `The assistant at ${instanceRoot} is not quiet, so the switch went no further: ${detail}.`,
  );
}

function abbreviated(args: string): string {
  return args.length > 160 ? `${args.slice(0, 157)}...` : args;
}

function summarizeHolders(holders: readonly OpenFileHolder[]): string {
  const processes = new Map<number, { command: string; files: Set<string> }>();
  for (const holder of holders) {
    const held = processes.get(holder.pid) ?? { command: holder.command, files: new Set<string>() };
    held.files.add(holder.file);
    processes.set(holder.pid, held);
  }
  return [...processes]
    .map(([pid, { command, files }]) => {
      const paths = [...files];
      const detail =
        paths.length === 1
          ? paths[0]
          : `${paths.length} paths (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', ...' : ''})`;
      return `${command} (PID ${pid}) holds ${detail}`;
    })
    .join('; ');
}

/**
 * The holder that is Docker Desktop's VM: an Apple VM process holding Docker Desktop's disk open. Every container
 * reaches the Mac's files through it, and it keeps files open for what its guest still caches, or leaked, long
 * after the container that read them has gone; it writes nothing of its own.
 */
async function dockerDesktopVm(
  instance: QuietInstance,
  holders: readonly OpenFileHolder[],
  seams: QuiescenceSeams,
): Promise<number | undefined> {
  if ((seams.platform ?? process.platform) !== 'darwin') return undefined;
  const vms = [...new Set(holders.filter(({ command }) => APPLE_VM.test(command)).map(({ pid }) => pid))];
  if (vms.length === 0) return undefined;
  const { stdout: system } = await quietDocker(instance, seams, ['info', '--format', '{{.OperatingSystem}}']);
  // Another runtime's VM may serve containers this assistant's Docker cannot list, so its holds still count.
  if (system.trim() !== 'Docker Desktop') return undefined;
  for (const pid of vms) {
    const { stdout, stderr } = await (seams.runCommand ?? runSanitizedCommand)({
      command: 'sh',
      args: ['-c', LSOF, 'lsof', '-n', '-P', '-w', '-F', 'n', '-p', String(pid)],
      cwd: instance.homeDirectory,
      env: toolEnvironment(seams),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    // An lsof that met an error has not shown what the process holds.
    if (stderr.trim()) continue;
    const files = stdout.split('\n').filter((line) => line.startsWith('n'));
    if (files.some((line) => path.basename(line.slice(1)) === DOCKER_DESKTOP_DISK)) return pid;
  }
  return undefined;
}

function reachesState(source: string, state: string): boolean {
  const folder = canonicalPath(source);
  return isInside(folder, state) || isInside(state, folder);
}

/**
 * A local volume created with `o=bind` and a `device` is a bind mount of that folder by another name; one with no
 * device keeps its data inside Docker, apart from the state.
 */
async function localVolumeDevices(
  instance: QuietInstance,
  seams: QuiescenceSeams,
  names: readonly string[],
): Promise<ReadonlyMap<string, string | undefined>> {
  const devices = new Map<string, string | undefined>();
  if (names.length === 0) return devices;
  const { stdout } = await quietDocker(instance, seams, [
    'volume',
    'inspect',
    '--format',
    '{"name":{{json .Name}},"options":{{json .Options}}}',
    ...names,
  ]);
  for (const line of stdout.split('\n').filter((entry) => entry.trim())) {
    const volume = requireRecord(
      parseJson(line, 'Docker volume', INVALID_DOCKER_OUTPUT),
      'Volume',
      INVALID_DOCKER_OUTPUT,
    );
    const name = requireString(volume.name, 'Volume name', INVALID_DOCKER_OUTPUT);
    const device = isRecord(volume.options) ? volume.options.device : undefined;
    devices.set(name, typeof device === 'string' && path.isAbsolute(device) ? device : undefined);
  }
  return devices;
}

/**
 * Running containers, whoever started them, with a mount that can reach `state/`. A bind mount or bound local
 * volume reaches it when its folder, links resolved, is the state, inside it, or holds it, since an agent container
 * mounts the state through its release's folder. A volume of any other driver could point anywhere, so it counts.
 */
async function containersReachingState(instance: QuietInstance, seams: QuiescenceSeams): Promise<string[]> {
  const { stdout: listed } = await quietDocker(instance, seams, ['ps', '--quiet', '--no-trunc']);
  const ids = listed.split(/\s+/u).filter(Boolean);
  if (ids.length === 0) return [];
  const { stdout } = await quietDocker(instance, seams, [
    'container',
    'inspect',
    '--format',
    '{"name":{{json .Name}},"mounts":{{json .Mounts}}}',
    ...ids,
  ]);
  const containers = stdout
    .split('\n')
    .filter((entry) => entry.trim())
    .map((line) => {
      const container = requireRecord(
        parseJson(line, 'Docker inspection', INVALID_DOCKER_OUTPUT),
        'Container',
        INVALID_DOCKER_OUTPUT,
      );
      const name = requireString(container.name, 'Container name', INVALID_DOCKER_OUTPUT).replace(/^\//u, '');
      if (!Array.isArray(container.mounts))
        throw new GwsEaError(INVALID_DOCKER_OUTPUT, `Docker did not list ${name}'s mounts`);
      return {
        name,
        mounts: container.mounts.map((mount) => requireRecord(mount, 'Container mount', INVALID_DOCKER_OUTPUT)),
      };
    });
  const localVolumes = new Set<string>();
  for (const { mounts } of containers) {
    for (const mount of mounts) {
      if (mount.Type === 'volume' && mount.Driver === 'local') {
        localVolumes.add(requireString(mount.Name, 'Volume name', INVALID_DOCKER_OUTPUT));
      }
    }
  }
  const devices = await localVolumeDevices(instance, seams, [...localVolumes]);
  const state = canonicalPath(instance.state);
  const found: string[] = [];
  for (const { name, mounts } of containers) {
    for (const mount of mounts) {
      if (mount.Type === 'bind') {
        if (reachesState(requireString(mount.Source, 'Mount source', INVALID_DOCKER_OUTPUT), state)) {
          found.push(name);
          break;
        }
      } else if (mount.Type === 'volume') {
        const volume = requireString(mount.Name, 'Volume name', INVALID_DOCKER_OUTPUT);
        if (mount.Driver !== 'local') {
          found.push(`${name} (its volume ${volume} is not local, so where it points is unknown)`);
          break;
        }
        const device = devices.get(volume);
        if (device !== undefined && reachesState(device, state)) {
          found.push(name);
          break;
        }
      }
    }
  }
  return found;
}

/**
 * Checks each place a writer runs: processes running from the instance root, containers with its install's label in
 * any state, running containers whose mounts reach `state/`, and any process holding something under `state/` open
 * (a database's `-wal`, `-shm` and `-journal` files included). Docker Desktop's VM is not counted: the containers
 * that reach the Mac's files through it are already checked. Refuses, naming what it found.
 */
export async function assertInstanceQuiet(instance: QuietInstance, seams: QuiescenceSeams = {}): Promise<void> {
  const root = instance.instanceRoot;
  const running = await processesRunningFrom(root, seams);
  if (running.length > 0) {
    throw notQuiet(
      root,
      `${running.map(({ pid, args }) => `PID ${pid} (${abbreviated(args)})`).join('; ')} still run${running.length === 1 ? 's' : ''} from it`,
    );
  }
  const containers = await pollUntil(
    () => labeledContainers(instance, seams),
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
  const reaching = await containersReachingState(instance, seams);
  if (reaching.length > 0) {
    throw notQuiet(root, `running containers ${reaching.join(', ')} mount its state`);
  }
  // A snapshot restore cut short holds `state/` aside whole, until it is finished or gone back from.
  const holders = (await exists(instance.state)) ? await openFileHolders(instance.state, seams) : [];
  if (holders.length === 0) return;
  const vm = await dockerDesktopVm(instance, holders, seams);
  const others = holders.filter(({ pid }) => pid !== vm);
  if (others.length > 0) throw notQuiet(root, summarizeHolders(others));
}

export interface CutoverOnecli {
  /** Before the fence: anything but present is repaired as create repairs it, isolation probe included. */
  reverify(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<void>;
  /** Health only, never repairing, once a release serves. */
  observe(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<Observation>;
}

export interface CutoverSeams {
  readonly runCommand?: SanitizedCommandRunner;
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly service?: ServiceControlOptions;
  readonly fetch?: typeof globalThis.fetch;
  readonly onecli?: Partial<CutoverOnecli>;
  /** `ncl <args> --json`, answered by the assistant's own host. */
  readonly ncl?: (
    runtime: InstanceRuntimeConfig,
    args: readonly string[],
    options?: InstanceNclOptions,
  ) => Promise<unknown>;
}

export interface CutoverDependencies extends CutoverSeams {
  readonly serviceHelpers: NanoclawServiceHelpers;
  readonly upsertEnvVars: UpsertEnvVars;
  readonly hostStatus: HostStatusHelpers;
  readonly reporter?: StepReporter;
}

/** Read once per run, so every step of one cutover works from the same records. */
export interface CutoverHost {
  readonly operation: InstanceOperation;
  readonly dependencies: CutoverDependencies;
  readonly reporter: StepReporter;
  readonly run: SanitizedCommandRunner;
  /** The registry's reservation, which names the release the cutover moves from until its commit point. */
  readonly reservation: InstanceReservation;
  /** The assistant's runtime, the same on every release. */
  readonly runtime: InstanceRuntimeConfig;
  readonly layout: InstanceLayout;
  readonly onecli: OnecliRuntimeLayout;
  readonly service: InstanceServiceControl;
  readonly uid: number | undefined;
}

async function readCutoverRuntime(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<InstanceRuntimeConfig> {
  const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(reservation.instance_id));
  if (runtime.instance_id !== reservation.instance_id) {
    throw new GwsEaError('runtime_mismatch', "The assistant's runtime record belongs to another instance");
  }
  return runtime;
}

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
    layout: operation.paths.instanceLayout(operation.instanceId),
    onecli: instanceOnecliLayout(operation.paths, reservation, runtime.docker_endpoint),
    service: createServiceControl(dependencies.serviceHelpers, runtimeServiceTarget(runtime), dependencies.service),
    uid: dependencies.service?.uid ?? process.getuid?.(),
  };
}

function cutoverSleep({ dependencies }: CutoverHost): (milliseconds: number) => Promise<void> {
  return dependencies.service?.sleep ?? ((milliseconds) => delay(milliseconds));
}

function quietInstanceOf(host: CutoverHost): QuietInstance {
  return {
    instanceRoot: host.layout.root,
    state: host.layout.state,
    installId: host.runtime.install_id,
    homeDirectory: host.runtime.home_directory,
    dockerEndpoint: host.runtime.docker_endpoint,
  };
}

function cutoverQuiescence({ run, dependencies }: CutoverHost): QuiescenceSeams {
  return {
    runCommand: run,
    ...(dependencies.service?.platform ? { platform: dependencies.service.platform } : {}),
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
    ...(dependencies.service?.sleep ? { sleep: dependencies.service.sleep } : {}),
  };
}

function cutoverServiceDependencies(host: CutoverHost): InstanceServiceDependencies {
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

function onecliBoundaries({ run, dependencies }: CutoverHost) {
  return {
    dockerCommandRunner: run,
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
  };
}

export function cutoverOnecli(host: CutoverHost): CutoverOnecli {
  const { dependencies } = host;
  const boundaries = {
    ...onecliBoundaries(host),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  };
  return {
    reverify:
      dependencies.onecli?.reverify ??
      (async (layout, pins) => {
        if ((await observeOnecliRuntime(layout, pins, boundaries)).status === 'present') return;
        await reconcileOnecliRuntime(layout, pins, boundaries);
      }),
    observe: dependencies.onecli?.observe ?? ((layout, pins) => observeOnecliRuntime(layout, pins, boundaries)),
  };
}

export function dockerEnvironment(
  runtime: InstanceRuntimeConfig,
  seams: Pick<CutoverSeams, 'ambientEnv'>,
): Readonly<Record<string, string>> {
  return buildToolEnvironment(seams.ambientEnv ?? process.env, {
    HOME: runtime.home_directory,
    DOCKER_HOST: runtime.docker_endpoint,
  });
}

export function assistantImageDocker(
  runtime: InstanceRuntimeConfig,
  seams: Pick<CutoverSeams, 'runCommand' | 'ambientEnv'>,
): ImageDocker {
  return {
    run: seams.runCommand ?? runSanitizedCommand,
    cwd: runtime.instance_root,
    env: dockerEnvironment(runtime, seams),
  };
}

/**
 * Removes the live link once the instance is proven quiet, so nothing, not even the service manager after a reboot,
 * can start a host until a switch points it again. `inspect` runs while nothing uses the state and the link is still
 * there. Fencing again stops whatever started since (a launchd job loaded at login is booted out). The stop is
 * ungraceful when the host left its claim lease live.
 */
export async function fenceInstance(host: CutoverHost, label: string, inspect?: () => void): Promise<OperationStop> {
  await runStep(host.reporter, { id: 'stop_host', label }, async () => {
    await host.service.stop();
    await host.service.drain();
  });
  const at = new Date().toISOString();
  return runStep(host.reporter, { id: 'fence', label: 'Checking nothing still uses its state…' }, async () => {
    await assertInstanceQuiet(quietInstanceOf(host), cutoverQuiescence(host));
    inspect?.();
    const graceful = !(await exists(host.layout.state)) || !hostLeaseLive(host.layout.state, at);
    await fence(host.layout);
    return { at, graceful };
  });
}

/**
 * Run only while fenced and proven quiet. The target's upgrade tripwire is stamped with its own script, so its host
 * accepts exactly that release, and the circuit breaker is reset, since it counts only the left release's crashes.
 * A failed OneCLI probe, when applying the kept files recreated a gateway service or its Compose file differs from
 * `leaving`'s, refuses the release before its host starts. Each step converges, so a switch cut short finishes when
 * run again. Returns whether the service definition changed.
 */
export async function switchTo(
  host: CutoverHost,
  release: ReleaseCoordinates,
  leaving: ReleaseCoordinates,
  label: string,
): Promise<boolean> {
  const name = releaseName(release.deployed_commit);
  return runStep(host.reporter, { id: 'switch_release', label }, async () => {
    const { runtime, layout, dependencies } = host;
    await stampUpgradeState(layout.release(name), host.run, {
      ...dockerEnvironment(runtime, dependencies),
      NANOCLAW_INSTALL_ID: runtime.install_id,
    });
    await rm(path.join(layout.state, 'data', 'circuit-breaker.json'), { force: true });
    const service = cutoverServiceDependencies(host);
    const { definitionChanged } = await applyReleaseFiles(
      { runtime, onecli: host.onecli, commit: release.deployed_commit, leaving: leaving.deployed_commit },
      { ...service, upsertEnvVars: dependencies.upsertEnvVars },
      onecliBoundaries(host),
    );
    await reloadInstanceService(runtime, service);
    await pointCurrent(layout, name);
    return definitionChanged;
  });
}

export async function startRelease(host: CutoverHost, definitionChanged: boolean, label: string): Promise<void> {
  await runStep(host.reporter, { id: 'start_release', label }, async () => {
    await host.service.start({ definitionChanged });
  });
}

/**
 * Serve `move.from` again after an operation stopped short of `move.to` serving. While the live link still names
 * `move.from`, nothing of its own was touched, so only its host is started. Otherwise the assistant is fenced again,
 * `beforeSwitch` runs (a rollback puts its state back), and the switch puts `move.from`'s kept files back over what
 * the operation applied.
 */
export async function serveLeftRelease(
  host: CutoverHost,
  move: { readonly from: ReleaseCoordinates; readonly to: ReleaseCoordinates },
  beforeSwitch?: () => Promise<void>,
): Promise<void> {
  if ((await readCurrent(host.layout)) === releaseName(move.from.deployed_commit)) {
    await runStep(host.reporter, { id: 'start_release', label: 'Starting the assistant again…' }, async () => {
      await host.service.start();
    });
    return;
  }
  await fenceInstance(host, 'Stopping the assistant to go back…');
  await beforeSwitch?.();
  const changed = await switchTo(host, move.from, move.to, 'Switching back to the release it ran…');
  await startRelease(host, changed, 'Starting the assistant again…');
}

/** How long a started host may take to serve, and what a killed host's claim lease adds (`src/host-instance.ts`). */
const HOST_READY_MS = 60_000;
const HOST_LEASE_MS = 90_000;
const CHAT_POLL_MS = 1_000;
/** As long as the host's own `ncl` may take to answer while it starts. */
const SKILLS_TIMEOUT_MS = 60_000;

function hostFailure(error: unknown, logs: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.replaceAll('logs/nanoclaw.error.log', path.join(logs, 'nanoclaw.error.log')));
}

/**
 * A host answering for the live checkout serves the release, since NanoClaw's upgrade tripwire lets it start only at
 * the commit it was stamped for.
 */
async function awaitServingHost(host: CutoverHost, budgetMs: number, subject: string): Promise<void> {
  try {
    await host.dependencies.hostStatus.waitForHost(host.runtime.checkout_root, { timeoutMs: budgetMs });
  } catch (error) {
    // Upstream waitForHost reports every failure as a plain Error naming why the host is not ready.
    throw new GwsEaError(
      'host_not_serving',
      `${subject}'s host is not serving: ${hostFailure(error, host.layout.logs)}`,
      { cause: error },
    );
  }
}

/**
 * Receiving means the consumer is connected and the subscription active, as `gws-ea-chat health` reports. A broken
 * Google sign-in fails only the subscription (the consumer pulls with the subscriber key), and only a new sign-in
 * repairs it, so while the consumer is connected the release serves through it and the reason is returned; anything
 * else that keeps Chat from receiving refuses the release.
 */
async function awaitChatReceiving(host: CutoverHost, budgetMs: number, subject: string): Promise<string | null> {
  const ncl = host.dependencies.ncl ?? runInstanceNclJson;
  const seen = await pollUntil(
    async () =>
      chatReceiving(parseChatHealth(unwrapData(await ncl(host.runtime, CHAT_HEALTH_ARGS))), host.operation.instanceId),
    (receiving) => receiving.state === 'receiving',
    { intervalMs: CHAT_POLL_MS, limitMs: budgetMs, sleep: cutoverSleep(host) },
  );
  switch (seen.state) {
    case 'receiving':
      return null;
    case 'sign_in_needed':
      return seen.reason;
    case 'not_receiving':
      throw new GwsEaError(
        'chat_not_receiving',
        `${subject}'s host is up, but ${seen.reason}. Check ${path.join(host.layout.logs, 'nanoclaw.error.log')}.`,
      );
  }
}

/** A killed host's claim lease lengthens the wait. Returns the budget every later wait is allowed. */
async function awaitHealthyHost(host: CutoverHost, leaseHeld: boolean, subject: string): Promise<number> {
  const budget = leaseHeld ? HOST_READY_MS + HOST_LEASE_MS : HOST_READY_MS;
  if (!(await host.service.verifyHealth(budget))) {
    throw new GwsEaError('host_not_serving', `${subject}'s host service never became healthy.`);
  }
  return budget;
}

export interface ServedRelease {
  /** Why Chat waits on a new Google sign-in, a fault the release serves through; null while Chat receives. */
  readonly signInNeeded: string | null;
}

export interface ServingRelease {
  /** The reservation with that release overlaid: its commit must be the live link's. */
  readonly view: InstanceReservation;
  /** The OneCLI versions its receipt records. */
  readonly pins: OnecliPins;
  /** The stop killed the host, so its claim lease delays the next one's. */
  readonly leaseHeld: boolean;
  /** How failures name it, such as "The new release". */
  readonly subject: string;
}

/**
 * The live link must name the release at its commit with no tracked changes. When a broken Google sign-in is all
 * that keeps Chat from receiving, the release serves and says so. A host that went down since it was started is
 * started again; a running one is left as it is.
 */
export async function verifyServingRelease(host: CutoverHost, release: ServingRelease): Promise<ServedRelease> {
  const { subject } = release;
  await host.service.start();
  const budget = await awaitHealthyHost(host, release.leaseHeld, subject);
  await observeLiveCheckout(host.operation.paths, release.view, [release.view.deployed_commit], {
    runCommand: host.run,
  });
  await awaitServingHost(host, budget, subject);
  const signInNeeded = await awaitChatReceiving(host, budget, subject);
  const seen = await cutoverOnecli(host).observe(host.onecli, release.pins);
  if (seen.status !== 'present') {
    throw new GwsEaError('onecli_not_serving', `The credential vault is not healthy on ${subject.toLowerCase()}.`);
  }
  return { signInNeeded };
}

/**
 * A release that changes main's shared skills reaches main only this way, never by restamping main's template. It
 * runs before the release is verified, so it waits for a healthy host itself.
 */
export async function reconcileMainSkills(host: CutoverHost, leaseHeld: boolean): Promise<void> {
  await runStep(host.reporter, { id: 'reconcile_main_skills', label: "Updating main's shared skills…" }, async () => {
    await awaitHealthyHost(host, leaseHeld, 'The started release');
    const ncl = host.dependencies.ncl ?? runInstanceNclJson;
    const options = { timeoutMs: SKILLS_TIMEOUT_MS };
    const profile = unwrapData(await ncl(host.runtime, ['gws-ea-profile', 'get'], options));
    const main = isRecord(profile) ? profile.main_agent_group_id : undefined;
    if (typeof main !== 'string' || !main) {
      throw new GwsEaError(
        'main_unpublished',
        "The assistant's profile names no main group, so its skills were not reconciled.",
      );
    }
    const skills = unwrapData(await ncl(host.runtime, ['gws-ea-main', 'reconcile', '--agent-group-id', main], options));
    if (
      !isRecord(skills) ||
      skills.agent_group_id !== main ||
      !Array.isArray(skills.skills) ||
      !skills.skills.every((skill) => typeof skill === 'string')
    ) {
      throw new GwsEaError('main_group_mismatch', "Main's skills did not reconcile to the release's list.");
    }
  });
}

export function releaseFollowUps(runtime: InstanceRuntimeConfig): OperationFollowUp[] {
  const base = getInstallScopedNames(runtime.install_id).containerImageBase;
  return [
    ...readDerivedImageGroups(runtime.state_root, base).map((group) => ({
      kind: 'rebuild_group_image' as const,
      agent_group_id: group.id,
    })),
    { kind: 'prune' },
  ];
}

/** At least the host's own bound on building an agent group's image (`src/container-runner.ts`), plus its restart. */
const GROUP_IMAGE_REBUILD_TIMEOUT_MS = 20 * 60_000;

function describeFollowUp(followUp: OperationFollowUp): string {
  switch (followUp.kind) {
    case 'rebuild_group_image':
      return `rebuilding agent group ${followUp.agent_group_id}'s image`;
    case 'reclaim_image':
      return `removing the image ${followUp.image_id.slice(0, 19)} a rebuild replaced`;
    case 'prune':
      return 'removing the releases and snapshots nothing keeps';
  }
}

function isCleanup(followUp: OperationFollowUp): boolean {
  return followUp.kind !== 'rebuild_group_image';
}

/**
 * The image the group's tag named is recorded before the rebuild, to be reclaimed once nothing names it. A group
 * that no longer runs its own image is done.
 */
async function rebuildGroupImage(
  operation: InstanceOperation,
  runtime: InstanceRuntimeConfig,
  agentGroupId: string,
  dependencies: CutoverSeams,
): Promise<void> {
  const base = getInstallScopedNames(runtime.install_id).containerImageBase;
  if (!readDerivedImageGroups(runtime.state_root, base).some((group) => group.id === agentGroupId)) return;
  const displaced = await taggedImageId(assistantImageDocker(runtime, dependencies), `${base}:${agentGroupId}`);
  if (displaced) await addFollowUps(operation, [{ kind: 'reclaim_image', image_id: displaced }]);
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

/** Delete the releases, snapshots, and quarantines nothing keeps: the live release and the rollback point stay. */
async function pruneReleases(
  operation: InstanceOperation,
  runtime: InstanceRuntimeConfig,
  dependencies: CutoverSeams,
): Promise<void> {
  const { paths, instanceId } = operation;
  const point = await readRollbackPoint(paths, instanceId);
  const base = getInstallScopedNames(runtime.install_id).containerImageBase;
  const docker = assistantImageDocker(runtime, dependencies);
  await pruneInstance(
    paths.instanceLayout(instanceId),
    point ? { rollbackPoint: { release: releaseName(point.release.deployed_commit), snapshot: point.snapshot } } : {},
    (release) => removeReleaseImage(docker, base, release),
  );
}

async function runFollowUp(
  operation: InstanceOperation,
  runtime: InstanceRuntimeConfig,
  followUp: OperationFollowUp,
  dependencies: CutoverSeams,
): Promise<void> {
  switch (followUp.kind) {
    case 'rebuild_group_image':
      await rebuildGroupImage(operation, runtime, followUp.agent_group_id, dependencies);
      return;
    case 'reclaim_image':
      await reclaimImage(assistantImageDocker(runtime, dependencies), followUp.image_id);
      return;
    case 'prune':
      await pruneReleases(operation, runtime, dependencies);
      return;
  }
}

function sentenceCase(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The image rebuilds run first; the cleanup runs only once they all succeeded. Each follow-up is struck from the
 * record as it finishes, and the record is deleted with the last. A failure never rolls back: it stays in the record,
 * `status` reports it, and the next run of the same command retries it.
 */
export async function finishFollowUps(operation: InstanceOperation, dependencies: CutoverDependencies): Promise<void> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const record = await readOperationRecord(paths, instanceId);
  if (record?.phase !== 'committed') return;
  const runtime = await loadCreatedRuntime(paths, instanceId);
  const reporter = dependencies.reporter ?? {};
  const failures: string[] = [];
  const attempt = async (followUp: OperationFollowUp, label: string): Promise<void> => {
    try {
      await runStep(reporter, { id: followUp.kind, label }, () =>
        runFollowUp(operation, runtime, followUp, dependencies),
      );
      await completeFollowUp(operation, followUp);
    } catch (error) {
      if (!(error instanceof GwsEaError)) throw error;
      failures.push(`${describeFollowUp(followUp)}: ${safeErrorMessage(error)}`);
    }
  };
  for (const followUp of record.follow_ups.filter((planned) => !isCleanup(planned))) {
    await attempt(followUp, `${sentenceCase(describeFollowUp(followUp))}…`);
  }
  if (failures.length === 0) {
    // The rebuilds recorded the images they displaced, so the cleanup is read again.
    const cleanup = (await readOperationRecord(paths, instanceId))?.follow_ups.filter(isCleanup) ?? [];
    for (const followUp of cleanup) await attempt(followUp, `Cleaning up after the ${record.kind}…`);
  }
  if (failures.length === 0) return;
  throw new GwsEaError(
    'follow_ups_failed',
    `Assistant ${instanceId} runs ${releaseLine(record.to)}, but ${failures.length === 1 ? 'a follow-up' : `${failures.length} follow-ups`} of its ${record.kind} failed: ${failures.join('; ')}. ` +
      `gws-ea status --id ${instanceId} lists what is left, and gws-ea ${record.kind} --id ${instanceId} retries it.`,
  );
}
