import { describe, expect, it } from 'vitest';

import { turnOff, turnOn, type AssistantVault } from './assistant-power.js';
import type { InstanceServiceControl, NanoclawServiceMode, ServiceEnablement } from './service-control.js';
import { GwsEaError } from './types.js';

interface World {
  mode?: NanoclawServiceMode;
  /** The manager cannot be asked whether the service is off. */
  unobservable?: boolean;
  enablement: ServiceEnablement;
  hostRunning: boolean;
  agentsRunning: boolean;
  vaultRunning: boolean;
  vaultFails?: boolean;
  hostWillNotStop?: boolean;
  /** The host is run by a launchd job still loaded after its plist was lost, which detection sees as unmanaged. */
  jobWithoutPlist?: boolean;
}

/** The service manager, the host, its agent containers, and the vault, as one machine whose steps are logged. */
function machine(world: World) {
  const log: string[] = [];
  const service = {
    detect: () => ({ mode: world.mode ?? 'launchd', active: world.hostRunning }),
    enablement: () => {
      if (world.unobservable) throw new GwsEaError('service_unobservable', 'launchctl did not answer');
      return world.enablement;
    },
    disable: () => {
      // Service control refuses to switch anything but a launchd job or a systemd unit.
      if (world.mode === 'none' || world.mode === 'nohup') throw new GwsEaError('service_not_installed', world.mode);
      if (world.enablement === 'disabled') return false;
      world.enablement = 'disabled';
      log.push('disable');
      return true;
    },
    enable: () => {
      if (world.enablement === 'enabled') return false;
      world.enablement = 'enabled';
      log.push('enable');
      return true;
    },
    stopJobWithoutPlist: async () => {
      if (!world.jobWithoutPlist) return;
      world.jobWithoutPlist = false;
      world.hostRunning = false;
      world.mode = 'none';
      log.push('stop job');
    },
    stop: async () => {
      if (!world.hostRunning) return 'already-stopped' as const;
      if (world.mode === 'unmanaged') throw new GwsEaError('service_unmanaged', 'a host runs outside its service');
      if (world.hostWillNotStop) throw new GwsEaError('service_still_running', 'the host did not stop');
      world.hostRunning = false;
      log.push('stop host');
      return 'stopped' as const;
    },
    start: async () => {
      if (world.hostRunning) return 'already-running' as const;
      world.hostRunning = true;
      log.push('start host');
      return 'started' as const;
    },
    agentsRunning: () => world.agentsRunning,
    drain: async () => {
      world.agentsRunning = false;
      log.push('drain');
    },
  } as unknown as InstanceServiceControl;
  const vault: AssistantVault = {
    bringUp: async () => {
      if (world.vaultRunning) return;
      world.vaultRunning = true;
      log.push('vault up');
      if (world.vaultFails) throw new GwsEaError('onecli_unhealthy', 'the vault never became healthy');
    },
    stop: async () => {
      if (!world.vaultRunning) return 'already-stopped';
      world.vaultRunning = false;
      log.push('vault stop');
      return 'stopped';
    },
  };
  return { service, vault, log, world };
}

const RUNNING: World = { enablement: 'enabled', hostRunning: true, agentsRunning: true, vaultRunning: true };
const OFF: World = { enablement: 'disabled', hostRunning: false, agentsRunning: false, vaultRunning: false };

describe('turning an assistant off', () => {
  it('disables the service before stopping the host, then its agents, then its vault', async () => {
    const { service, vault, log, world } = machine({ ...RUNNING });

    await expect(turnOff(service, vault)).resolves.toBe('stopped');
    expect(log).toEqual(['disable', 'stop host', 'drain', 'vault stop']);
    expect(world).toEqual(OFF);
  });

  it.each([
    ['still enabled, as an older stop left it', { ...OFF, enablement: 'enabled' as const }, ['disable']],
    ['with agent containers left running', { ...OFF, agentsRunning: true }, ['drain']],
    ['with its vault left running', { ...OFF, vaultRunning: true }, ['vault stop']],
    ['disabled but its host still up', { ...OFF, hostRunning: true }, ['stop host']],
  ])('finishes an assistant stopped %s, and says it stopped it', async (_case, start, steps) => {
    const { service, vault, log, world } = machine({ ...start });

    await expect(turnOff(service, vault)).resolves.toBe('stopped');
    expect(log).toEqual(steps);
    expect(world).toEqual(OFF);
  });

  it.each(['none', 'nohup'] as const)(
    'stops the agents and vault of an assistant whose service is %s, with no service to turn off',
    async (mode) => {
      const { service, vault, log } = machine({ ...OFF, mode, agentsRunning: true, vaultRunning: true });

      await expect(turnOff(service, vault)).resolves.toBe('stopped');
      expect(log).toEqual(['drain', 'vault stop']);
    },
  );

  it('stops the host of a launchd job still loaded after its plist was lost, then its agents and vault', async () => {
    const { service, vault, log, world } = machine({
      ...RUNNING,
      mode: 'unmanaged',
      jobWithoutPlist: true,
    });

    await expect(turnOff(service, vault)).resolves.toBe('stopped');
    expect(log).toEqual(['stop job', 'drain', 'vault stop']);
    expect(world).toMatchObject({ hostRunning: false, agentsRunning: false, vaultRunning: false });
  });

  it('refuses a host running outside any service before stopping its agents or vault', async () => {
    const { service, vault, log } = machine({ ...RUNNING, mode: 'unmanaged' });

    await expect(turnOff(service, vault)).rejects.toMatchObject({ code: 'service_unmanaged' });
    expect(log).toEqual([]);
  });

  it('changes nothing and says so when every part is already off', async () => {
    const { service, vault, log } = machine({ ...OFF });

    await expect(turnOff(service, vault)).resolves.toBe('already-stopped');
    expect(log).toEqual([]);
  });

  it('leaves the service disabled when the host will not stop, so a login or reboot cannot bring it back', async () => {
    const { service, vault, world } = machine({ ...RUNNING, hostWillNotStop: true });

    await expect(turnOff(service, vault)).rejects.toMatchObject({ code: 'service_still_running' });
    expect(world.enablement).toBe('disabled');
  });
});

describe('turning an assistant on', () => {
  it('brings the vault up, then enables the service, then starts the host', async () => {
    const { service, vault, log, world } = machine({ ...OFF });

    await expect(turnOn(service, vault, () => service.start())).resolves.toEqual({
      turnedOn: true,
      started: 'started',
    });
    expect(log).toEqual(['vault up', 'enable', 'start host']);
    expect(world).toMatchObject({ enablement: 'enabled', hostRunning: true, vaultRunning: true });
  });

  it('keeps the assistant fully off when its vault cannot be brought up healthy', async () => {
    const { service, vault, log, world } = machine({ ...OFF, vaultFails: true });

    await expect(turnOn(service, vault, () => service.start())).rejects.toMatchObject({ code: 'onecli_unhealthy' });
    expect(log).toEqual(['vault up', 'vault stop']);
    expect(world).toMatchObject(OFF);
  });

  it('starts an assistant that was never off without touching its vault', async () => {
    const { service, vault, log } = machine({ ...RUNNING, hostRunning: false, vaultRunning: false, vaultFails: true });

    await expect(turnOn(service, vault, () => service.start())).resolves.toEqual({
      turnedOn: false,
      started: 'started',
    });
    expect(log).toEqual(['start host']);
  });

  it('starts an assistant whose manager cannot say whether it is off, as status and update treat it', async () => {
    const { service, vault, log } = machine({ ...OFF, enablement: 'enabled', unobservable: true });

    await expect(turnOn(service, vault, () => service.start())).resolves.toEqual({
      turnedOn: false,
      started: 'started',
    });
    expect(log).toEqual(['start host']);
  });

  it('turns on a running assistant whose stop never finished', async () => {
    const { service, vault, log } = machine({ ...RUNNING, enablement: 'disabled' });

    await expect(turnOn(service, vault, () => service.start())).resolves.toEqual({
      turnedOn: true,
      started: 'already-running',
    });
    expect(log).toEqual(['enable']);
  });
});
