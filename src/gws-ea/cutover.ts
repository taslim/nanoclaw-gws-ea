/**
 * What update and rollback share on the release layout (KTD1): the fence, the
 * one switch, and the host around them.
 *
 * The fence stops the assistant's service job and drains its agents, proves
 * the instance quiet (no process runs from its instance root, no container
 * carries its install's label, nothing holds anything under its `state/`
 * open), and removes the live link, so nothing can start a host until a
 * switch points the link again, not even the service manager after a reboot.
 * The switch, run only fenced, stamps the target release's upgrade tripwire
 * with its own script, resets the circuit breaker, applies the files kept
 * with the release (`applyReleaseFiles`), has the service manager read its
 * definition, and points the live link at it. Neither moves or copies state.
 *
 * The host side lives here too: the service started and checked through
 * NanoClaw's helpers, the checks that a started release serves, main's
 * shared skills reconciled (KTD16), and the follow-ups a committed release
 * runs.
 */
import { lstat, readdir, readFile, readlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from '../community-portal/errors.js';
import { getInstallScopedNames } from '../install-slug.js';
import { removeReleaseImage, reclaimImage } from './agent-image-release.js';
import { taggedImageId, type ImageDocker } from './agent-image.js';
import { observeLiveCheckout } from './checkout.js';
import { observeManagedGchatRoute, verifyExistingGchatRoute } from './endpoint.js';
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
import { isWithinDirectory, type ControlPlanePaths } from './paths.js';
import type { Observation } from './phases.js';
import { pollUntil } from './poll.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { instanceOnecliLayout } from './provision.js';
import { redact, safeErrorMessage } from './redact.js';
import { getInstanceReservation } from './registry.js';
import { fence, pointCurrent, pruneInstance, readCurrent, releaseName, type InstanceLayout } from './release-layout.js';
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
import { GwsEaError, shortCommit, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import { isRecord, unwrapData } from './validation.js';
import { hostLeaseLive, readDerivedImageGroups } from './verify.js';

/** How long containers the drain stopped may take to be removed (`--rm` removes them after they exit). */
const CONTAINER_POLL_MS = 1_000;
const CONTAINER_LIMIT_MS = 30_000;
const PROBE_TIMEOUT_MS = 60_000;

/** The instance a fence proves quiet, with what Docker needs to look for its containers. */
export interface QuietInstance {
  /** `<state root>/<hex8>`: every release, its state, and its records. */
  readonly instanceRoot: string;
  /** The physical `state/`, which no process may hold open. */
  readonly state: string;
  readonly installId: string;
  readonly homeDirectory: string;
  readonly dockerEndpoint: string;
}

/** Boundary seams; each defaults to this process's. */
export interface QuiescenceSeams {
  /** Runs `ps`, Docker, and `lsof`. */
  readonly runCommand?: SanitizedCommandRunner;
  readonly platform?: NodeJS.Platform;
  /** Where the tool environment is read. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Where Linux's process table is read. */
  readonly procRoot?: string;
}

/** A process holding a file (or its working directory) open. */
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
 * Processes whose arguments name a path inside the instance root: its host,
 * its `ncl`, a script run from a release. One only reading the host's logs
 * (`gws-ea logs --follow`) touches no state. A tool started with relative
 * paths names none, which is what the open-file check is for.
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

/** Every container carrying the install's label, in any state. */
async function labeledContainers(instance: QuietInstance, seams: QuiescenceSeams): Promise<string[]> {
  const label = getInstallScopedNames(instance.installId).containerInstallLabel;
  const { stdout } = await (seams.runCommand ?? runSanitizedCommand)({
    command: 'docker',
    args: ['ps', '--all', '--quiet', '--filter', `label=${label}`],
    cwd: instance.homeDirectory,
    env: toolEnvironment(seams, { HOME: instance.homeDirectory, DOCKER_HOST: instance.dockerEndpoint }),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return stdout
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Run `lsof` with the arguments after it, keeping any status but 1: lsof exits
 * 1 both when nothing it was asked about is open and, on macOS, once it found
 * what is open but skipped a process it may not inspect, so that status says
 * nothing about what it printed.
 */
const LSOF = 'lsof "$@"; status=$?; [ "$status" -le 1 ] || exit "$status"';

/**
 * `lsof` on everything under `directory`, in its field output, read whatever
 * its status; an error it meets is reported on stderr, and fails the check.
 */
async function lsofHolders(directory: string, seams: QuiescenceSeams): Promise<OpenFileHolder[]> {
  const { stdout, stderr } = await (seams.runCommand ?? runSanitizedCommand)({
    command: 'sh',
    args: ['-c', LSOF, 'lsof', '-n', '-P', '-w', '-F', 'pcn', '+D', directory],
    cwd: directory,
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

/** Linux's process table: each process's working directory and open descriptors under `directory`. */
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
 * Every process holding anything under `directory` open, its working
 * directory included: `lsof` on macOS, the process table on Linux. A process
 * matched by its arguments misses one started with relative paths, or an
 * idle database connection; this sees both.
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

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

function abbreviated(args: string): string {
  return args.length > 160 ? `${args.slice(0, 157)}...` : args;
}

/**
 * Prove a stopped assistant quiet (KTD1): no process runs from its instance
 * root, no container carries its install's label in any state (those the
 * drain stopped get a moment to be removed), and no process holds anything
 * under its `state/` open, a database's `-wal`, `-shm`, and `-journal` side
 * files included. Refuses, naming what it found, before anything is copied
 * or moved.
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
  // A snapshot restore cut short holds `state/` aside whole, until it is finished or gone back from.
  const holders = (await exists(instance.state)) ? await openFileHolders(instance.state, seams) : [];
  if (holders.length > 0) {
    throw notQuiet(root, holders.map(({ pid, command, file }) => `${command} (PID ${pid}) holds ${file}`).join('; '));
  }
}

/** OneCLI as a switch's host checks it; each step defaults to the real one. */
export interface CutoverOnecli {
  /**
   * Re-verify the serving runtime before the fence (KTD15): observed by
   * Compose's config hash, provenance, and ownership; anything but present is
   * repaired by Compose, and probed for isolation, as create's repair is.
   */
  reverify(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<void>;
  /** Its health alone, once a release serves. */
  observe(layout: OnecliRuntimeLayout, pins: OnecliPins): Promise<Observation>;
}

/** A cutover's boundary seams; each defaults to the real one. */
export interface CutoverSeams {
  /** Runs Git, Docker, `ps`, `lsof`, and the release's own scripts. */
  readonly runCommand?: SanitizedCommandRunner;
  /** Where the tool environment of Docker and the release's scripts is read. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
  /** The service manager's platform and user, and the waits every poll takes. */
  readonly service?: ServiceControlOptions;
  /** Reaches the host's listener and its callback route (public DNS for the route by default). */
  readonly fetch?: typeof globalThis.fetch;
  readonly onecli?: Partial<CutoverOnecli>;
  /** `ncl <args> --json` through the assistant's own host. */
  readonly ncl?: (
    runtime: InstanceRuntimeConfig,
    args: readonly string[],
    options?: InstanceNclOptions,
  ) => Promise<unknown>;
}

/** What a cutover needs from the driver, and its seams. */
export interface CutoverDependencies extends CutoverSeams {
  /** Upstream's service helpers (`scripts/update/service.ts`): the cutover stops and starts the host with them. */
  readonly serviceHelpers: NanoclawServiceHelpers;
  /** Upstream's `.env` upsert (`setup/set-env.ts`): gws-ea's keys are written with it. */
  readonly upsertEnvVars: UpsertEnvVars;
  /** Upstream's host readiness helpers: verification asks the host for its status. */
  readonly hostStatus: HostStatusHelpers;
  readonly reporter?: StepReporter;
}

/** What every step of one cutover works from, read once per run. */
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

/** The assistant's one runtime record, read physically from its `state/`. */
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

/** Read what one cutover works from: the reservation, the runtime, the layout, and the service. */
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

/** How every cutover wait sleeps. */
function cutoverSleep({ dependencies }: CutoverHost): (milliseconds: number) => Promise<void> {
  return dependencies.service?.sleep ?? ((milliseconds) => delay(milliseconds));
}

/** The instance as the quiescence proof looks for it. */
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

/** What installing the assistant's service definition needs. */
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

/** Docker's environment for one assistant: the operator's tools, its home, and its Docker endpoint. */
export function dockerEnvironment(
  runtime: InstanceRuntimeConfig,
  seams: Pick<CutoverSeams, 'ambientEnv'>,
): Readonly<Record<string, string>> {
  return buildToolEnvironment(seams.ambientEnv ?? process.env, {
    HOME: runtime.home_directory,
    DOCKER_HOST: runtime.docker_endpoint,
  });
}

/** One assistant's images as `agent-image.ts` reaches them: from its instance directory, through its Docker. */
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
 * Fence the assistant (KTD1): stop its service's job and drain its agents,
 * prove the instance quiet, then remove the live link, so nothing can start a
 * host until a switch points it again. `inspect` runs once nothing uses the
 * state and while the link is still there: an operation reads the schema the
 * host left, and an update checks its dry run still speaks for it. Fencing
 * an assistant already fenced stops whatever started since (a launchd job
 * loaded at login is booted out) and proves it quiet again; the link stays
 * absent. Reports the stop, ungraceful when the host left its claim lease
 * live.
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
 * The one switch (KTD1), run only while the assistant is fenced and proven
 * quiet: stamp the target release's upgrade tripwire with its own script, so
 * the host it starts accepts exactly that release; reset the circuit
 * breaker, which counts only the crashes of the release it left; apply the
 * files kept with the release, its OneCLI gateway recreated and probed only
 * when its Compose file differs, a failed probe refusing the release before
 * its host starts (KTD15); have the service manager read its definition; and
 * point the live link at it. Each step converges, so a switch cut short is
 * finished by running it again. Returns whether the service definition
 * changed, which the start needs.
 */
export async function switchTo(host: CutoverHost, release: ReleaseCoordinates, label: string): Promise<boolean> {
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
      { runtime, onecli: host.onecli, commit: release.deployed_commit },
      { ...service, upsertEnvVars: dependencies.upsertEnvVars },
      onecliBoundaries(host),
    );
    await reloadInstanceService(runtime, service);
    await pointCurrent(layout, name);
    return definitionChanged;
  });
}

/** Start the release the live link names; a job still loaded is started afresh when its definition changed. */
export async function startRelease(host: CutoverHost, definitionChanged: boolean, label: string): Promise<void> {
  await runStep(host.reporter, { id: 'start_release', label }, async () => {
    await host.service.start({ definitionChanged });
  });
}

/**
 * Serve `release` again, the one an operation left, after the operation
 * stopped short of its target serving. While the live link still names it,
 * nothing of its own was touched: the fence never removed the link, or an
 * earlier return already switched back; only its host is started. Otherwise
 * the assistant is fenced again, which stops whatever started since and
 * proves it quiet, `beforeSwitch` runs (a rollback's state goes back), and
 * the release is switched to, its kept files put back over whatever the
 * operation's switch applied, and started.
 */
export async function serveLeftRelease(
  host: CutoverHost,
  release: ReleaseCoordinates,
  beforeSwitch?: () => Promise<void>,
): Promise<void> {
  if ((await readCurrent(host.layout)) === releaseName(release.deployed_commit)) {
    await runStep(host.reporter, { id: 'start_release', label: 'Starting the assistant again…' }, async () => {
      await host.service.start();
    });
    return;
  }
  await fenceInstance(host, 'Stopping the assistant to go back…');
  await beforeSwitch?.();
  const changed = await switchTo(host, release, 'Switching back to the release it ran…');
  await startRelease(host, changed, 'Starting the assistant again…');
}

/** How long a started host may take to serve, and what a killed host's claim lease adds (`src/host-instance.ts`). */
const HOST_READY_MS = 60_000;
const HOST_LEASE_MS = 90_000;
const PROBE_INTERVAL_MS = 1_000;
const LISTENER_TIMEOUT_MS = 10_000;
/** As long as the host's own `ncl` may take to answer while it starts. */
const SKILLS_TIMEOUT_MS = 60_000;

function hostFailure(error: unknown, logs: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.replaceAll('logs/nanoclaw.error.log', path.join(logs, 'nanoclaw.error.log')));
}

/** The listener ID of the host serving the live release, once it answers with Google Chat connected. */
async function servingListener(host: CutoverHost, budgetMs: number, subject: string): Promise<string> {
  const root = host.runtime.checkout_root;
  const port = host.reservation.allocated_ports.nanoclaw_webhook;
  let status: unknown;
  try {
    status = await host.dependencies.hostStatus.waitForHost(root, { channel: 'gchat', timeoutMs: budgetMs });
  } catch (error) {
    // Upstream waitForHost reports every failure as a plain Error naming why the host is not ready.
    throw new GwsEaError(
      'host_not_serving',
      `${subject}'s host is not serving: ${hostFailure(error, host.layout.logs)}`,
      { cause: error },
    );
  }
  const webhook = isRecord(status) ? status.webhook : undefined;
  if (!isRecord(webhook) || webhook.port !== port || typeof webhook.id !== 'string' || !webhook.id) {
    throw new GwsEaError(
      'host_not_serving',
      `${subject}'s host answers without its Google Chat listener on port ${port}.`,
    );
  }
  return webhook.id;
}

/** What the local listener answered: its status, and the listener ID it named. */
async function askListener(fetchListener: typeof globalThis.fetch, url: string): Promise<string> {
  try {
    const response = await fetchListener(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(LISTENER_TIMEOUT_MS),
    });
    return `HTTP ${response.status} from listener ${response.headers.get('x-nanoclaw-webhook-id') ?? 'none'}`;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Not answering is itself the answer.
  } catch {
    return 'no answer';
  }
}

/** The host's listener refuses unsigned traffic with 401 and its own listener ID. */
async function assertListenerServes(host: CutoverHost, listener: string, budgetMs: number, subject: string) {
  const url = `http://127.0.0.1:${host.reservation.allocated_ports.nanoclaw_webhook}/webhook/gchat`;
  const expected = `HTTP 401 from listener ${listener}`;
  const answer = await pollUntil(
    () => askListener(host.dependencies.fetch ?? globalThis.fetch, url),
    (seen) => seen === expected,
    { intervalMs: PROBE_INTERVAL_MS, limitMs: budgetMs, sleep: cutoverSleep(host) },
  );
  if (answer === expected) return;
  throw new GwsEaError(
    'listener_not_serving',
    `${subject}'s listener at ${url} answered ${answer}, not 401 from the host's listener ${listener}.`,
  );
}

/** The callback reaches the host's listener (managed) or refuses unsigned traffic (existing), observed read-only. */
async function assertRouteServes(host: CutoverHost, listener: string, budgetMs: number): Promise<void> {
  const ingress = host.reservation.exclusive_resource_claims.ingress;
  const fetchRoute = host.dependencies.fetch ? { fetch: host.dependencies.fetch } : {};
  const wait = { intervalMs: PROBE_INTERVAL_MS, limitMs: budgetMs, sleep: cutoverSleep(host) };
  if (ingress.mode === 'existing') {
    const failure = await pollUntil(
      () =>
        verifyExistingGchatRoute({ endpointUrl: ingress.endpoint_url }, fetchRoute).then(
          () => undefined,
          (error: unknown) => {
            if (error instanceof GwsEaError) return error;
            throw error;
          },
        ),
      (seen) => seen === undefined,
      wait,
    );
    if (failure) throw failure;
    return;
  }
  const seen = await pollUntil(
    () =>
      observeManagedGchatRoute(
        {
          endpointUrl: ingress.callback_url,
          localEndpointUrl: `http://127.0.0.1:${host.reservation.allocated_ports.nanoclaw_webhook}/webhook/gchat`,
        },
        fetchRoute,
      ),
    (route) => route.status === 'routed',
    wait,
  );
  if (seen.status !== 'routed') {
    throw new GwsEaError('route_not_serving', `The assistant's callback does not reach it: ${seen.observed}.`);
  }
  if (seen.listenerId !== listener) {
    throw new GwsEaError('route_not_serving', "The assistant's callback reaches another listener than the host's.");
  }
}

/**
 * Wait for the started host's service to be healthy, its `ncl` answering; a
 * killed host's claim lease lengthens the wait. Returns the budget every
 * later wait is allowed.
 */
async function awaitHealthyHost(host: CutoverHost, leaseHeld: boolean, subject: string): Promise<number> {
  const budget = leaseHeld ? HOST_READY_MS + HOST_LEASE_MS : HOST_READY_MS;
  if (!(await host.service.verifyHealth(budget))) {
    throw new GwsEaError('host_not_serving', `${subject}'s host service never became healthy.`);
  }
  return budget;
}

/** What a release must show to count as serving. */
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
 * Check a started release serves. Its service is healthy; the live link names
 * the release, at its commit with no tracked changes, and the host answers
 * for it, which NanoClaw's upgrade tripwire allows only at the commit it was
 * stamped for; its listener answers 401 with the host's own listener ID;
 * OneCLI is healthy (a gateway the switch recreated was probed before the
 * start); and the callback route reaches it. A killed host's claim lease can
 * delay the new one, so it lengthens every wait. A host that went down since
 * it was started is started again; a running one is left as it is.
 */
export async function verifyServingRelease(host: CutoverHost, release: ServingRelease): Promise<void> {
  const { subject } = release;
  await host.service.start();
  const budget = await awaitHealthyHost(host, release.leaseHeld, subject);
  await observeLiveCheckout(host.operation.paths, release.view, [release.view.deployed_commit], {
    runCommand: host.run,
  });
  const listener = await servingListener(host, budget, subject);
  await assertListenerServes(host, listener, budget, subject);
  const seen = await cutoverOnecli(host).observe(host.onecli, release.pins);
  if (seen.status !== 'present') {
    throw new GwsEaError('onecli_not_serving', `The credential vault is not healthy on ${subject.toLowerCase()}.`);
  }
  await assertRouteServes(host, listener, budget);
}

/**
 * Reconcile main's shared skills to the started release's own list (KTD16),
 * through the assistant's own `ncl` once its host answers, before the release
 * is verified: a release that changes the list reaches main this way, on
 * every update and rollback, never by restamping main's template.
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

/**
 * The follow-ups a committed release runs (KTD4, KTD6): each agent group
 * running its own image has it rebuilt on the release's image, then whatever
 * nothing keeps any more is pruned.
 */
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

function releaseLine(release: ReleaseCoordinates): string {
  return `${release.release_track} ${shortCommit(release.deployed_commit)}`;
}

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

/** Work that brings the release up to date, before any cleanup. */
function isCleanup(followUp: OperationFollowUp): boolean {
  return followUp.kind !== 'rebuild_group_image';
}

/**
 * Rebuild an agent group's own image on the base the release runs with the
 * assistant's own `ncl` (KTD6): NanoClaw's `buildAgentGroupImage`, then a
 * restart of that group's containers. The image the group's tag named is
 * recorded first, to be reclaimed once nothing names it (KTD6). A group that
 * no longer runs its own image is done.
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

/** Delete the releases, snapshots, and quarantines nothing keeps: the live release and the rollback point stay (KTD4). */
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

/** Run one follow-up. */
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
 * Run a committed update's or rollback's follow-ups (KTD2): the per-group
 * image rebuilds first, then, once they all succeeded, the cleanup: the
 * images they displaced, and the prune. Each is struck from the record as it
 * finishes, and the record is deleted with the last. A failure never rolls
 * back: it stays in the record, `status` reports it, and the next run of the
 * same command retries it.
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
