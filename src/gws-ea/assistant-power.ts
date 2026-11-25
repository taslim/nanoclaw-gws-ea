/**
 * An operator's own off and on for an assistant: its service in the OS
 * manager, its host, its agent containers, and its credential vault. Off lasts
 * until the operator turns it on again, through logins, reboots, and Docker
 * restarts; the manager's disabled state is its only record.
 */
import {
  observeOnecliRuntime,
  reconcileOnecliRuntime,
  stopOnecliRuntime,
  type OnecliRuntimeDependencies,
} from './onecli.js';
import type { ControlPlanePaths } from './paths.js';
import { instanceOnecliLayout, readDeployedSetup } from './provision.js';
import type { InstanceServiceControl, NanoclawServiceHandle, StopOutcome } from './service-control.js';
import { GwsEaError, type InstanceReservation } from './types.js';

/**
 * Whether the operator turned the assistant off. A host outside a service
 * manager is never off, and a manager that cannot be asked leaves what
 * detection saw to decide.
 */
export function isTurnedOff(
  service: InstanceServiceControl,
  { mode }: NanoclawServiceHandle = service.detect(),
): boolean {
  if (mode !== 'launchd' && mode !== 'systemd-user' && mode !== 'systemd-system') return false;
  try {
    return service.enablement() === 'disabled';
  } catch (error) {
    if (error instanceof GwsEaError && error.code === 'service_unobservable') return false;
    throw error;
  }
}

export interface AssistantVault {
  readonly bringUp: () => Promise<void>;
  readonly stop: () => Promise<'stopped' | 'already-stopped'>;
}

export function onecliVault(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  dockerEndpoint: string,
  dependencies: Pick<OnecliRuntimeDependencies, 'ambientEnv'> = {},
): AssistantVault {
  const layout = instanceOnecliLayout(paths, reservation, dockerEndpoint);
  return {
    async bringUp() {
      const pins = { gateway: (await readDeployedSetup(paths, reservation)).onecli.gateway };
      if ((await observeOnecliRuntime(layout, pins, dependencies)).status === 'present') return;
      await reconcileOnecliRuntime(layout, pins, dependencies);
    },
    stop: () => stopOnecliRuntime(layout, dependencies),
  };
}

/**
 * The service is disabled before anything stops, so a host that will not stop,
 * or a later step that fails, still never comes back at login or boot; running
 * it again finishes whatever is left. Agents are drained once the host can no
 * longer start new ones.
 */
export async function turnOff(service: InstanceServiceControl, vault: AssistantVault): Promise<StopOutcome> {
  const disabled = service.disable();
  const host = await service.stop();
  const agents = service.agentsRunning();
  if (agents) await service.drain();
  const vaulted = (await vault.stop()) === 'stopped';
  return disabled || host === 'stopped' || agents || vaulted ? 'stopped' : 'already-stopped';
}

export interface TurnedOn<T> {
  readonly turnedOn: boolean;
  readonly started: T;
}

/**
 * The service is enabled only once the vault serves, since launchd will not
 * load a disabled job: a vault that cannot come up leaves an assistant that was
 * off fully off, its vault stopped again because `compose up` may have started
 * some of it.
 */
export async function turnOn<T>(
  service: InstanceServiceControl,
  vault: AssistantVault,
  start: () => Promise<T>,
): Promise<TurnedOn<T>> {
  const wasOff = service.enablement() === 'disabled';
  try {
    await vault.bringUp();
  } catch (error) {
    if (wasOff) await stopAfterFailedStart(vault, error);
    throw error;
  }
  const turnedOn = wasOff && service.enable();
  return { turnedOn, started: await start() };
}

async function stopAfterFailedStart(vault: AssistantVault, failure: unknown): Promise<void> {
  try {
    await vault.stop();
  } catch (stopFailure) {
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
    throw new GwsEaError(
      'onecli_stop_incomplete',
      `The credential vault did not start (${reason(failure)}), and stopping it again failed: ${reason(stopFailure)}`,
      { cause: stopFailure },
    );
  }
}
