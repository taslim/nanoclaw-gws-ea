/**
 * One assistant's host service, controlled through NanoClaw's own update
 * controller helpers (`scripts/update/service.ts`) so the mechanics cannot
 * drift from NanoClaw's: detection, stop, start, container drain, and health.
 * `src/` cannot import `scripts/`, so the driver supplies the helpers and this
 * module binds them to one instance: its checkout, install, home, and Docker
 * endpoint. What gws-ea adds is only the exact-ID targeting and the waits
 * NanoClaw's own callers do not need.
 *
 * Stop follows NanoClaw: agent containers are left for the next start to
 * adopt, and the stop lasts until the next start, login, or reboot. Only
 * cutover and removal drain containers.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { pollUntil } from './poll.js';
import { buildToolEnvironment } from './process.js';
import { activeStep } from './run-log.js';
import { serviceManagerEnvironment, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';

/** Where a host service sends the host's output and its errors. */
export { hostLogFiles, type HostLogFiles } from './service.js';

/** NanoClaw's `ServiceMode`: how detection found the service run. */
export type NanoclawServiceMode = 'launchd' | 'systemd-user' | 'systemd-system' | 'nohup' | 'unmanaged' | 'none';

/** NanoClaw's `ServiceHandle`: a service as detection found it. */
export interface NanoclawServiceHandle {
  readonly mode: NanoclawServiceMode;
  readonly active: boolean;
  readonly name?: string;
  readonly definition?: string;
  readonly pid?: number;
}

/** NanoClaw's `CommandRunner`. */
export interface NanoclawCommandRunner {
  run(command: string, args: string[], cwd?: string, options?: { timeoutMs?: number }): string;
  tryRun(
    command: string,
    args: string[],
    cwd?: string,
    options?: { timeoutMs?: number },
  ): { ok: boolean; stdout: string };
}

/** NanoClaw's `ServiceEnvironment`, always naming the install it acts on. */
export interface NanoclawServiceEnvironment {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly uid: number;
  readonly runner: NanoclawCommandRunner;
  readonly installSlug: string;
  sleep(milliseconds: number): Promise<void>;
  log?(message: string): void;
}

/** NanoClaw's update-controller service helpers, which the driver supplies. */
export interface NanoclawServiceHelpers {
  readonly createCommandRunner: (options: { readonly env: NodeJS.ProcessEnv }) => NanoclawCommandRunner;
  readonly detectService: (projectRoot: string, env: NanoclawServiceEnvironment) => NanoclawServiceHandle;
  readonly stopService: (handle: NanoclawServiceHandle, env: NanoclawServiceEnvironment) => Promise<void>;
  readonly startService: (handle: NanoclawServiceHandle, projectRoot: string, env: NanoclawServiceEnvironment) => void;
  readonly drainContainers: (projectRoot: string, env: NanoclawServiceEnvironment, timeoutMs?: number) => Promise<void>;
  readonly verifyServiceHealth: (
    handle: NanoclawServiceHandle,
    projectRoot: string,
    env: NanoclawServiceEnvironment,
    timeoutMs?: number,
  ) => Promise<boolean>;
}

/** The one assistant a service control acts on, as its runtime records it. */
export interface ServiceControlTarget {
  /** Its instance ID, which the commands its refusals name take. */
  readonly instanceId: string;
  /** The live checkout the service runs from. */
  readonly checkoutRoot: string;
  /** NanoClaw's install slug: the instance ID without dashes. */
  readonly installId: string;
  readonly homeDirectory: string;
  readonly dockerEndpoint: string;
}

/** The service a created assistant's own runtime record names (R18). */
export function runtimeServiceTarget(
  runtime: Pick<
    InstanceRuntimeConfig,
    'instance_id' | 'checkout_realpath' | 'install_id' | 'home_directory' | 'docker_endpoint'
  >,
): ServiceControlTarget {
  return {
    instanceId: runtime.instance_id,
    checkoutRoot: runtime.checkout_realpath,
    installId: runtime.install_id,
    homeDirectory: runtime.home_directory,
    dockerEndpoint: runtime.docker_endpoint,
  };
}

/** Boundary seams; each defaults to this process's. */
export interface ServiceControlOptions {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  /** Where the tool environment and the user-bus variables are read. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type StartOutcome = 'started' | 'already-running';
export type StopOutcome = 'stopped' | 'already-stopped';
export type RestartOutcome = 'restarted' | 'started';

export interface InstanceServiceControl {
  /** The service as NanoClaw detects it now. */
  detect(): NanoclawServiceHandle;
  start(): Promise<StartOutcome>;
  /** Stops the host, leaving agent containers for the next start, and returns once detection shows it gone. */
  stop(): Promise<StopOutcome>;
  restart(): Promise<RestartOutcome>;
  /** Stops this assistant's agent containers and waits until none runs; for cutover and removal only. */
  drain(timeoutMs?: number): Promise<void>;
  /** Whether the host serves: its service active, its CLI socket up, and `ncl` answering. */
  verifyHealth(timeoutMs?: number): Promise<boolean>;
}

/**
 * How long a stopped job may take to leave. launchd can still be removing a
 * job `bootout` unloaded, and gives a process that ignores SIGTERM 20 seconds
 * before it kills it; nothing may start the job again until it is gone.
 */
const STOPPED_POLL_MS = 500;
const STOPPED_LIMIT_MS = 30_000;

function requireUid(uid: number | undefined): number {
  if (uid === undefined) throw new GwsEaError('unsupported_platform', 'The service manager requires a user ID');
  return uid;
}

/**
 * What every helper's command runs with: the operator's tools, this
 * assistant's home, Docker endpoint, and install, and on Linux the user bus
 * `systemctl --user` needs.
 */
function commandEnvironment(
  target: ServiceControlTarget,
  platform: NodeJS.Platform,
  uid: number,
  ambient: NodeJS.ProcessEnv,
): Record<string, string> {
  const runtime = { home_directory: target.homeDirectory, docker_endpoint: target.dockerEndpoint };
  const userBus = (): Readonly<Record<string, string>> => {
    const { XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS } = serviceManagerEnvironment(runtime, 'systemd-user', {
      uid,
      ambientEnv: ambient,
    });
    return { XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS };
  };
  return buildToolEnvironment(ambient, {
    HOME: target.homeDirectory,
    DOCKER_HOST: target.dockerEndpoint,
    NANOCLAW_INSTALL_ID: target.installId,
    ...(platform === 'linux' ? userBus() : {}),
  });
}

export function createServiceControl(
  helpers: NanoclawServiceHelpers,
  target: ServiceControlTarget,
  options: ServiceControlOptions = {},
): InstanceServiceControl {
  const platform = options.platform ?? process.platform;
  const uid = requireUid(options.uid ?? process.getuid?.());
  const sleep: (milliseconds: number) => Promise<void> = options.sleep ?? delay;
  const env: NanoclawServiceEnvironment = {
    platform,
    home: target.homeDirectory,
    uid,
    runner: helpers.createCommandRunner({
      env: commandEnvironment(target, platform, uid, options.ambientEnv ?? process.env),
    }),
    installSlug: target.installId,
    sleep,
    log: (message) => activeStep()?.write(`${message}\n`),
  };
  const root = target.checkoutRoot;
  const detect = (): NanoclawServiceHandle => helpers.detectService(root, env);

  /** A host running outside NanoClaw's service is the operator's to stop; no action here takes it over. */
  const managed = (handle: NanoclawServiceHandle): NanoclawServiceHandle => {
    if (handle.mode !== 'unmanaged') return handle;
    throw new GwsEaError(
      'service_unmanaged',
      `A NanoClaw host runs from ${root} outside its service (PID ${handle.name}); stop that process, then retry.`,
    );
  };
  /** Starting needs the service NanoClaw installed; resume installs a missing one. */
  const installed = (handle: NanoclawServiceHandle): NanoclawServiceHandle => {
    if (handle.mode !== 'none') return handle;
    throw new GwsEaError(
      'service_not_installed',
      `No NanoClaw service is installed for ${root}; gws-ea resume --id ${target.instanceId} installs it.`,
    );
  };

  const stopUntilGone = async (handle: NanoclawServiceHandle): Promise<void> => {
    await helpers.stopService(handle, env);
    const current = await pollUntil(
      async () => detect(),
      (found) => !found.active,
      {
        intervalMs: STOPPED_POLL_MS,
        limitMs: STOPPED_LIMIT_MS,
        sleep,
      },
    );
    if (current.active) {
      throw new GwsEaError(
        'service_still_running',
        `NanoClaw's service ${handle.name ?? handle.mode} is still running after it was stopped`,
      );
    }
  };

  /** Start the way NanoClaw's own transaction does: the service's handle, marked active. */
  const startHandle = (handle: NanoclawServiceHandle): void =>
    helpers.startService({ ...handle, active: true }, root, env);

  return {
    detect,
    async start() {
      const handle = managed(detect());
      if (handle.active) return 'already-running';
      startHandle(installed(handle));
      return 'started';
    },
    async stop() {
      const handle = managed(detect());
      if (!handle.active) return 'already-stopped';
      await stopUntilGone(handle);
      return 'stopped';
    },
    async restart() {
      const handle = installed(managed(detect()));
      if (handle.active) await stopUntilGone(handle);
      startHandle(handle);
      return handle.active ? 'restarted' : 'started';
    },
    drain: (timeoutMs) => helpers.drainContainers(root, env, timeoutMs),
    verifyHealth: (timeoutMs) => helpers.verifyServiceHealth({ ...detect(), active: true }, root, env, timeoutMs),
  };
}
