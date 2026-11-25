/**
 * One assistant's host service, controlled through NanoClaw's own update
 * controller helpers (`scripts/update/service.ts`) so the mechanics cannot
 * drift from NanoClaw's. `src/` cannot import `scripts/`, so the driver
 * supplies the helpers and this module binds them to one instance: its
 * checkout, install, home, and Docker endpoint. What gws-ea adds is naming the
 * install exactly (`installSlug`), on systemd a reset of a unit's failed state
 * before each start, and turning the service off and on in its manager.
 *
 * `start` and `stop` follow NanoClaw and are transient: updates, rollbacks,
 * removal, and stray cleanup share them, so they never change whether the
 * service starts at login or boot. Only the operator's own stop and start turn
 * it off and on, through `disable` and `enable`. NanoClaw has no such helper,
 * and launchd refuses to load a disabled job with the same error it gives a
 * job still being removed, so the manager's own record is read, never inferred.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { getInstallScopedNames } from '../install-slug.js';

import { buildToolEnvironment } from './process.js';
import { activeStep } from './run-log.js';
import { serviceManagerEnvironment, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';

export { hostLogFiles, type HostLogFiles } from './service.js';

/** Bounds a `systemctl` call a hung user bus would otherwise hold forever, leaving the assistant down. */
const SYSTEMCTL_TIMEOUT_MS = 30_000;

/**
 * NanoClaw's drain filter (`drainContainers` in `scripts/update/service.ts`, which `src/` cannot import): the
 * install's containers minus gateway-owned ones, which carry the gateway role and no session.
 */
const DRAIN_LIST_FORMAT = '{{.ID}}|{{.Label "nanoclaw-session"}}|{{.Label "nanoclaw-role"}}';
const GATEWAY_ROLE = 'gateway';

/** `systemctl is-enabled` states other than `disabled`, which it reports with a non-zero exit. */
const SYSTEMD_UNIT_FILE_STATES: ReadonlySet<string> = new Set([
  'enabled-runtime',
  'linked',
  'linked-runtime',
  'alias',
  'masked',
  'masked-runtime',
  'static',
  'indirect',
  'generated',
  'transient',
  'bad',
  'not-found',
]);

interface SwitchableService {
  readonly mode: 'launchd' | 'systemd-user' | 'systemd-system';
  readonly name: string;
}

/** NanoClaw's `ServiceMode`. */
export type NanoclawServiceMode = 'launchd' | 'systemd-user' | 'systemd-system' | 'nohup' | 'unmanaged' | 'none';

/** NanoClaw's `ServiceHandle`. */
export interface NanoclawServiceHandle {
  readonly mode: NanoclawServiceMode;
  readonly active: boolean;
  /** A systemd unit activating or deactivating: it still holds the service, but is not serving. */
  readonly transitional?: boolean;
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

export interface ServiceControlTarget {
  /** Named in the recovery commands its refusals give. */
  readonly instanceId: string;
  /** The live release's link, which the service runs from. */
  readonly checkoutRoot: string;
  /** NanoClaw's install slug: the instance ID without dashes. */
  readonly installId: string;
  readonly homeDirectory: string;
  readonly dockerEndpoint: string;
}

export function runtimeServiceTarget(
  runtime: Pick<
    InstanceRuntimeConfig,
    'instance_id' | 'checkout_root' | 'install_id' | 'home_directory' | 'docker_endpoint'
  >,
): ServiceControlTarget {
  return {
    instanceId: runtime.instance_id,
    checkoutRoot: runtime.checkout_root,
    installId: runtime.install_id,
    homeDirectory: runtime.home_directory,
    dockerEndpoint: runtime.docker_endpoint,
  };
}

export interface ServiceControlOptions {
  readonly recordEffect?: (changed: true | null) => void;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  /** Where the tool environment and the user-bus variables are read. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** Whether the service manager starts the service at login or boot: the record an operator's stop leaves. */
export type ServiceEnablement = 'enabled' | 'disabled';

export type StartOutcome = 'started' | 'already-running';
export type StopOutcome = 'stopped' | 'already-stopped';
export type RestartOutcome = 'restarted' | 'started';

export interface StartOptions {
  /**
   * Whether the service definition changed since the job was loaded, as
   * writing or restoring it reports. A job still loaded holds the old
   * definition, so it is stopped (launchd boots it out) and started from the
   * new one (launchd bootstraps it); otherwise a running job is left running.
   */
  readonly definitionChanged?: boolean;
}

export interface InstanceServiceControl {
  detect(): NanoclawServiceHandle;
  /** A running host is restarted only when its definition changed. */
  start(options?: StartOptions): Promise<StartOutcome>;
  /** Leaves agent containers for the next start, and returns once the host has exited. */
  stop(): Promise<StopOutcome>;
  enablement(): ServiceEnablement;
  /** Keeps the service from starting at login or boot; true when it changed. Leaves a running host running. */
  disable(): boolean;
  /** Lets the service start again; true when it changed. Starts nothing. */
  enable(): boolean;
  /**
   * Stops a launchd job by its label, and returns once it has gone. NanoClaw
   * finds a job by its plist, so a job still loaded after its plist was deleted
   * is stopped this way; for removal only.
   */
  stopByLabel(label: string, definition: string): Promise<void>;
  restart(): Promise<RestartOutcome>;
  /** Stops this assistant's agent containers and waits until none runs; for a fence, removal, and turning it off. */
  drain(timeoutMs?: number): Promise<void>;
  /** Whether any container `drain` would stop is running; a Docker it cannot ask counts as yes, leaving the answer to `drain`. */
  agentsRunning(): boolean;
  /** Whether the host serves: its service active, its CLI socket up, and `ncl` answering. */
  verifyHealth(timeoutMs?: number): Promise<boolean>;
}

function requireUid(uid: number | undefined): number {
  if (uid === undefined) throw new GwsEaError('unsupported_platform', 'The service manager requires a user ID');
  return uid;
}

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
  /**
   * NanoClaw's helpers throw plain errors, which `safeErrorMessage` never
   * shows the operator; their reasons say what to do, so each is rewrapped in
   * a gws-ea error.
   */
  const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
  const detect = (): NanoclawServiceHandle => {
    try {
      return helpers.detectService(root, env);
    } catch (cause) {
      throw new GwsEaError('service_unobservable', reasonOf(cause), { cause });
    }
  };

  /** A host running outside NanoClaw's service is the operator's to stop; no action here takes it over. */
  const managed = (handle: NanoclawServiceHandle): NanoclawServiceHandle => {
    if (handle.mode !== 'unmanaged') return handle;
    throw new GwsEaError(
      'service_unmanaged',
      `A NanoClaw host runs from ${root} outside its service (PID ${handle.name}); stop that process, then retry.`,
    );
  };
  const installed = (handle: NanoclawServiceHandle): NanoclawServiceHandle => {
    if (handle.mode !== 'none') return handle;
    throw new GwsEaError(
      'service_not_installed',
      `No NanoClaw service is installed for ${root}; gws-ea resume --id ${target.instanceId} installs it.`,
    );
  };

  /** NanoClaw's stop returns once the host has exited, and throws when it cannot stop it. */
  const stopHost = async (handle: NanoclawServiceHandle): Promise<void> => {
    try {
      options.recordEffect?.(null);
      await helpers.stopService(handle, env);
      options.recordEffect?.(true);
    } catch (cause) {
      throw new GwsEaError(
        'service_still_running',
        `NanoClaw's service ${handle.name ?? handle.mode} did not stop: ${reasonOf(cause)}`,
        { cause },
      );
    }
  };

  /**
   * A systemd unit that kept failing while it could not start (inside an
   * update's fence, after a reboot) hits its start limit, and systemd refuses
   * to start it again until its failed state is reset. A unit systemd has not
   * loaded has no failed state, and starting it loads it. launchd retries such
   * a job on its own, so needs nothing.
   */
  const resetFailed = ({ mode, name }: NanoclawServiceHandle): void => {
    if (name === undefined || (mode !== 'systemd-user' && mode !== 'systemd-system')) return;
    try {
      env.runner.run('systemctl', [...(mode === 'systemd-user' ? ['--user'] : []), 'reset-failed', name], undefined, {
        timeoutMs: SYSTEMCTL_TIMEOUT_MS,
      });
    } catch (cause) {
      if (!/not loaded/u.test(reasonOf(cause))) throw cause;
    }
  };

  /** Marked active: NanoClaw's `startService` skips a handle that is not. */
  const startHandle = (handle: NanoclawServiceHandle): void => {
    try {
      options.recordEffect?.(null);
      resetFailed(handle);
      helpers.startService({ ...handle, active: true }, root, env);
      options.recordEffect?.(true);
    } catch (cause) {
      throw new GwsEaError(
        'service_start_failed',
        `NanoClaw's service ${handle.name ?? handle.mode} did not start: ${reasonOf(cause)}`,
        { cause },
      );
    }
  };

  /** Stop a running job before starting it, so it is loaded from its definition as it is now. */
  const startAfresh = async (handle: NanoclawServiceHandle): Promise<void> => {
    if (handle.active) await stopHost(handle);
    startHandle(handle);
  };

  const switchable = (): SwitchableService => {
    const handle = installed(managed(detect()));
    const { mode, name } = handle;
    if (name !== undefined && (mode === 'launchd' || mode === 'systemd-user' || mode === 'systemd-system')) {
      return { mode, name };
    }
    throw new GwsEaError(
      'unsupported_platform',
      `NanoClaw's service for ${root} runs under ${mode}, which gws-ea cannot keep off across reboots.`,
    );
  };
  const systemctl = (mode: 'systemd-user' | 'systemd-system', ...args: string[]): string[] => [
    ...(mode === 'systemd-user' ? ['--user'] : []),
    ...args,
  ];
  const managerOptions = { timeoutMs: SYSTEMCTL_TIMEOUT_MS };

  const observeEnablement = (service: SwitchableService): ServiceEnablement => {
    if (service.mode === 'launchd') {
      let listed: string;
      try {
        listed = env.runner.run('launchctl', ['print-disabled', `gui/${uid}`], undefined, managerOptions);
      } catch (cause) {
        throw new GwsEaError('service_unobservable', reasonOf(cause), { cause });
      }
      const label = `"${service.name}"`;
      const row = listed
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith(`${label} `) || line.startsWith(`${label}=`));
      const state = row?.slice(label.length).replace('=>', '').trim();
      // Older macOS prints true/false where current releases print disabled/enabled.
      return state === 'disabled' || state === 'true' ? 'disabled' : 'enabled';
    }
    const answer = env.runner.tryRun(
      'systemctl',
      systemctl(service.mode, 'is-enabled', service.name),
      undefined,
      managerOptions,
    );
    const state = answer.stdout.trim().split('\n')[0]?.trim() ?? '';
    if (state === 'disabled') return 'disabled';
    // is-enabled exits non-zero for masked, static, and other states that are not an operator's disable.
    if (answer.ok || SYSTEMD_UNIT_FILE_STATES.has(state)) return 'enabled';
    throw new GwsEaError('service_unobservable', `systemctl is-enabled ${service.name} failed: ${answer.stdout}`);
  };

  const setEnablement = (to: ServiceEnablement): boolean => {
    const service = switchable();
    if (observeEnablement(service) === to) return false;
    const verb = to === 'enabled' ? 'enable' : 'disable';
    try {
      options.recordEffect?.(null);
      if (service.mode === 'launchd') {
        env.runner.run('launchctl', [verb, `gui/${uid}/${service.name}`], undefined, managerOptions);
      } else {
        env.runner.run('systemctl', systemctl(service.mode, verb, service.name), undefined, managerOptions);
      }
      options.recordEffect?.(true);
    } catch (cause) {
      throw new GwsEaError(
        'service_enablement_failed',
        `Could not ${verb} NanoClaw's service ${service.name}: ${reasonOf(cause)}`,
        { cause },
      );
    }
    return true;
  };

  return {
    detect,
    enablement: () => observeEnablement(switchable()),
    disable: () => setEnablement('disabled'),
    enable: () => setEnablement('enabled'),
    async start({ definitionChanged = false } = {}) {
      const handle = managed(detect());
      if (handle.active && !definitionChanged) return 'already-running';
      await startAfresh(installed(handle));
      return 'started';
    },
    async stop() {
      const handle = managed(detect());
      if (!handle.active) return 'already-stopped';
      await stopHost(handle);
      return 'stopped';
    },
    stopByLabel: (name, definition) => stopHost({ mode: 'launchd', name, definition, active: true }),
    async restart() {
      const handle = installed(managed(detect()));
      await startAfresh(handle);
      return handle.active ? 'restarted' : 'started';
    },
    async drain(timeoutMs) {
      try {
        await helpers.drainContainers(root, env, timeoutMs);
      } catch (cause) {
        // NanoClaw's reasons (its timeout, a failed `docker ps`) end without a full stop.
        throw new GwsEaError(
          'containers_still_running',
          `NanoClaw did not stop the assistant's agent containers: ${reasonOf(cause)}.`,
          { cause },
        );
      }
    },
    agentsRunning() {
      const listed = env.runner.tryRun(
        'docker',
        [
          'ps',
          '--filter',
          `label=${getInstallScopedNames(target.installId).containerInstallLabel}`,
          '--format',
          DRAIN_LIST_FORMAT,
        ],
        undefined,
        managerOptions,
      );
      if (!listed.ok) return true;
      return listed.stdout
        .split('\n')
        .filter(Boolean)
        .some((line) => {
          const [, session, role] = line.split('|');
          return Boolean(session) || role !== GATEWAY_ROLE;
        });
    },
    verifyHealth: (timeoutMs) => helpers.verifyServiceHealth({ ...detect(), active: true }, root, env, timeoutMs),
  };
}
