import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveGcpClaims } from './gcp-identity.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { resolveControlPlanePaths } from './paths.js';

import { createInstanceRuntimeConfig, reconcileInstanceService, type InstanceRuntimeConfig } from './service.js';
import {
  createServiceControl,
  hostLogFiles,
  restartTurnedOn,
  type NanoclawCommandRunner,
  type NanoclawServiceHandle,
  type NanoclawServiceHelpers,
  type ServiceControlOptions,
  type ServiceControlTarget,
} from './service-control.js';
import type { InstanceReservation } from './types.js';

const INSTANCE_ID = '01234567-89ab-cdef-0123-456789abcdef';
/** NanoClaw's install slug: the instance ID without dashes. */
const INSTALL_ID = INSTANCE_ID.replaceAll('-', '');
const LABEL = `com.nanoclaw-v2-${INSTALL_ID}`;
const TARGET: ServiceControlTarget = {
  instanceId: INSTANCE_ID,
  checkoutRoot: '/state/instances/x/nanoclaw',
  installId: INSTALL_ID,
  homeDirectory: '/Users/operator',
  dockerEndpoint: 'unix:///Users/operator/.docker/run/docker.sock',
};

const LOADED: NanoclawServiceHandle = {
  mode: 'launchd',
  active: true,
  name: LABEL,
  definition: `/Users/operator/Library/LaunchAgents/${LABEL}.plist`,
};
const BOOTED_OUT: NanoclawServiceHandle = { ...LOADED, active: false };
const NOT_INSTALLED: NanoclawServiceHandle = { mode: 'none', active: false };
const UNMANAGED: NanoclawServiceHandle = { mode: 'unmanaged', active: true, name: '4242' };
const UNIT = `nanoclaw-v2-${INSTALL_ID}`;
const SYSTEMD_RUNNING: NanoclawServiceHandle = {
  mode: 'systemd-user',
  active: true,
  name: UNIT,
  definition: `/home/operator/.config/systemd/user/${UNIT}.service`,
};

/**
 * NanoClaw's helpers, faked: detection answers from `detections` in turn and
 * then keeps its last answer; every helper call, and every command run
 * outside them, is recorded in order.
 */
function nanoclaw(...detections: NanoclawServiceHandle[]) {
  const calls: string[] = [];
  const runner = {
    run: vi.fn<NanoclawCommandRunner['run']>((command, args) => {
      calls.push([command, ...args].join(' '));
      return '';
    }),
    tryRun: vi.fn<NanoclawCommandRunner['tryRun']>(() => ({ ok: true, stdout: '' })),
  } satisfies NanoclawCommandRunner;
  let detected = 0;
  const helpers = {
    createCommandRunner: vi.fn<NanoclawServiceHelpers['createCommandRunner']>(() => runner),
    detectService: vi.fn<NanoclawServiceHelpers['detectService']>(() => {
      calls.push('detect');
      return detections[Math.min(detected++, detections.length - 1)]!;
    }),
    stopService: vi.fn<NanoclawServiceHelpers['stopService']>(async () => void calls.push('stop')),
    startService: vi.fn<NanoclawServiceHelpers['startService']>(() => void calls.push('start')),
    drainContainers: vi.fn<NanoclawServiceHelpers['drainContainers']>(async () => void calls.push('drain')),
    verifyServiceHealth: vi.fn<NanoclawServiceHelpers['verifyServiceHealth']>(async () => {
      calls.push('health');
      return true;
    }),
  } satisfies NanoclawServiceHelpers;
  return { helpers, calls, runner };
}

function control(helpers: NanoclawServiceHelpers, options: ServiceControlOptions = {}) {
  const sleep = vi.fn(async (_milliseconds: number) => undefined);
  return {
    sleep,
    service: createServiceControl(helpers, TARGET, { platform: 'darwin', uid: 501, ambientEnv: {}, sleep, ...options }),
  };
}

describe('binding NanoClaw service helpers to one assistant', () => {
  it("names the assistant's install, home, and user to every helper, and runs its commands in its environment", () => {
    const { helpers, runner } = nanoclaw(LOADED);
    const ambientEnv = {
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/someone-else',
      DOCKER_HOST: 'unix:///var/run/another-docker.sock',
      NANOCLAW_INSTALL_ID: 'another-install',
      ANTHROPIC_API_KEY: 'provider-secret-canary',
    };
    const { service } = control(helpers, { platform: 'darwin', uid: 501, ambientEnv });

    expect(service.detect()).toEqual(LOADED);

    expect(helpers.createCommandRunner).toHaveBeenCalledExactlyOnceWith({
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin',
        HOME: TARGET.homeDirectory,
        DOCKER_HOST: TARGET.dockerEndpoint,
        NANOCLAW_INSTALL_ID: INSTALL_ID,
      },
    });
    expect(helpers.detectService).toHaveBeenCalledExactlyOnceWith(TARGET.checkoutRoot, {
      platform: 'darwin',
      home: TARGET.homeDirectory,
      uid: 501,
      installSlug: INSTALL_ID,
      runner,
      sleep: expect.any(Function),
      log: expect.any(Function),
    });
  });

  it('reaches the systemd user manager over the user bus, derived from the UID when the caller has none', () => {
    const { helpers } = nanoclaw(NOT_INSTALLED);
    const { service } = control(helpers, { platform: 'linux', uid: 1000, ambientEnv: { PATH: '/usr/bin' } });

    service.detect();

    expect(helpers.createCommandRunner).toHaveBeenCalledExactlyOnceWith({
      env: {
        PATH: '/usr/bin',
        HOME: TARGET.homeDirectory,
        DOCKER_HOST: TARGET.dockerEndpoint,
        NANOCLAW_INSTALL_ID: INSTALL_ID,
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
    });
    expect(helpers.detectService.mock.calls[0]![1]).toMatchObject({ platform: 'linux', uid: 1000 });
  });
});

describe('start', () => {
  it('starts a stopped (booted-out) assistant by passing its detected handle marked active', async () => {
    const { helpers, calls } = nanoclaw(BOOTED_OUT);
    const { service } = control(helpers);

    await expect(service.start()).resolves.toBe('started');

    expect(helpers.startService).toHaveBeenCalledExactlyOnceWith(
      { ...BOOTED_OUT, active: true },
      TARGET.checkoutRoot,
      helpers.detectService.mock.calls[0]![1],
    );
    expect(calls).toEqual(['detect', 'start']);
  });

  it('leaves a running assistant as it is', async () => {
    const { helpers, calls } = nanoclaw(LOADED);

    await expect(control(helpers).service.start()).resolves.toBe('already-running');
    expect(calls).toEqual(['detect']);
  });

  it.each([
    ['launchd', LOADED, 'darwin'],
    ['systemd', SYSTEMD_RUNNING, 'linux'],
  ] as const)(
    'verifies a %s host already running after the switch without restarting it',
    async (_manager, running, platform) => {
      const { helpers, calls } = nanoclaw(running);
      const { service } = control(helpers, { platform });

      await expect(service.start({ definitionChanged: false })).resolves.toBe('already-running');
      await expect(service.verifyHealth()).resolves.toBe(true);

      // No stop, no start, and no command outside NanoClaw's helpers: the serving host is only checked.
      expect(calls).toEqual(['detect', 'detect', 'health']);
    },
  );
});

describe('start after a changed service definition', () => {
  it('boots out a job launchd still holds with the stale definition, then bootstraps it from the changed one', async () => {
    const { helpers, calls } = nanoclaw(LOADED);
    const { service } = control(helpers);

    await expect(service.start({ definitionChanged: true })).resolves.toBe('started');

    const env = helpers.detectService.mock.calls[0]![1];
    expect(calls).toEqual(['detect', 'stop', 'start']);
    expect(helpers.stopService).toHaveBeenCalledExactlyOnceWith(LOADED, env);
    expect(helpers.startService).toHaveBeenCalledExactlyOnceWith(LOADED, TARGET.checkoutRoot, env);
  });

  it('bootstraps a booted-out job from the changed definition, with nothing to boot out', async () => {
    const { helpers, calls } = nanoclaw(BOOTED_OUT);

    await expect(control(helpers).service.start({ definitionChanged: true })).resolves.toBe('started');
    expect(calls).toEqual(['detect', 'start']);
  });

  it('never starts a job that did not leave', async () => {
    const { helpers, calls } = nanoclaw(LOADED);
    helpers.stopService.mockRejectedValueOnce(new Error(`NanoClaw service ${LABEL} did not stop`));

    await expect(control(helpers).service.start({ definitionChanged: true })).rejects.toMatchObject({
      code: 'service_still_running',
    });
    expect(calls).not.toContain('start');
  });
});

describe('start on systemd', () => {
  /**
   * systemd holding the unit as start-limit-failed (it failed while an
   * update's fence hid its paths, after a reboot): `start` is refused until
   * `reset-failed` clears the failed state.
   */
  function startLimitFailed(mode: 'systemd-user' | 'systemd-system') {
    const fake = nanoclaw({ ...SYSTEMD_RUNNING, mode, active: false });
    const unit = { failed: true };
    fake.runner.run.mockImplementation((command, args) => {
      fake.calls.push([command, ...args].join(' '));
      if (command === 'systemctl' && args.includes('reset-failed')) unit.failed = false;
      return '';
    });
    fake.helpers.startService.mockImplementation(() => {
      if (unit.failed) {
        throw new Error(
          `Command failed: systemctl start ${UNIT}\nJob for ${UNIT}.service failed because start of the service was attempted too often.`,
        );
      }
      fake.calls.push('start');
    });
    return fake;
  }

  it.each([
    ['systemd-user', `systemctl --user reset-failed ${UNIT}`],
    ['systemd-system', `systemctl reset-failed ${UNIT}`],
  ] as const)('starts a %s unit left start-limit-failed once its failed state is reset', async (mode, reset) => {
    for (const action of ['start', 'restart'] as const) {
      const { helpers, calls } = startLimitFailed(mode);

      await expect(control(helpers, { platform: 'linux' }).service[action]()).resolves.toBe('started');
      expect(calls).toEqual(['detect', reset, 'start']);
    }
  });

  it("resets the failed state with the assistant's own command environment", async () => {
    const { helpers, runner } = startLimitFailed('systemd-user');

    await control(helpers, { platform: 'linux', uid: 1000 }).service.start();

    // The runner NanoClaw's helpers were given, which carries the user bus.
    expect(helpers.createCommandRunner).toHaveBeenCalledExactlyOnceWith({
      env: expect.objectContaining({ XDG_RUNTIME_DIR: '/run/user/1000' }),
    });
    // Bounded, as a hung user bus would otherwise hold the start with the assistant fenced.
    expect(runner.run).toHaveBeenCalledWith('systemctl', ['--user', 'reset-failed', UNIT], undefined, {
      timeoutMs: 30_000,
    });
  });

  it('starts a unit systemd has not loaded, which has no failed state to reset', async () => {
    const { helpers, calls, runner } = nanoclaw({ ...SYSTEMD_RUNNING, active: false });
    runner.run.mockImplementationOnce(() => {
      throw new Error(
        `Command failed: systemctl --user reset-failed ${UNIT}\nFailed to reset failed state of unit ${UNIT}.service: Unit ${UNIT}.service not loaded.`,
      );
    });

    await expect(control(helpers, { platform: 'linux' }).service.start()).resolves.toBe('started');
    expect(calls).toEqual(['detect', 'start']);
  });

  it("fails the start, keeping systemd's reason, when it cannot reset the failed state", async () => {
    const { helpers, runner } = nanoclaw({ ...SYSTEMD_RUNNING, active: false });
    const unreachable = new Error(
      `Command failed: systemctl --user reset-failed ${UNIT}\nFailed to connect to bus: No such file or directory`,
    );
    runner.run.mockImplementationOnce(() => {
      throw unreachable;
    });

    await expect(control(helpers, { platform: 'linux' }).service.start()).rejects.toMatchObject({
      code: 'service_start_failed',
      message: `NanoClaw's service ${UNIT} did not start: ${unreachable.message}`,
      cause: unreachable,
    });
    expect(helpers.startService).not.toHaveBeenCalled();
  });
});

describe('stop', () => {
  it("stops the service through NanoClaw's stop, which waits for the host to exit, without draining its agents", async () => {
    const { helpers, calls } = nanoclaw(LOADED);

    await expect(control(helpers).service.stop()).resolves.toBe('stopped');

    expect(helpers.stopService).toHaveBeenCalledExactlyOnceWith(LOADED, helpers.detectService.mock.calls[0]![1]);
    expect(calls).toEqual(['detect', 'stop']);
    expect(helpers.drainContainers).not.toHaveBeenCalled();
  });

  it('counts an assistant that is not running as already stopped', async () => {
    for (const handle of [BOOTED_OUT, NOT_INSTALLED]) {
      const { helpers, calls } = nanoclaw(handle);

      await expect(control(helpers).service.stop()).resolves.toBe('already-stopped');
      expect(calls).toEqual(['detect']);
    }
  });

  it("fails, naming the service and keeping NanoClaw's reason, when the host never exits", async () => {
    const { helpers, calls } = nanoclaw(LOADED);
    const didNotStop = new Error(
      `NanoClaw service ${LABEL} did not stop (PID 4242). Once it has exited, start it again with: launchctl bootstrap`,
    );
    helpers.stopService.mockRejectedValueOnce(didNotStop);

    await expect(control(helpers).service.stop()).rejects.toMatchObject({
      code: 'service_still_running',
      message: `NanoClaw's service ${LABEL} did not stop: ${didNotStop.message}`,
      cause: didNotStop,
    });
    expect(calls).not.toContain('start');
  });
});

describe('stopping a launchd job without its plist', () => {
  const plist = LOADED.definition!;

  it("stops the install's launchd job by its label through NanoClaw's stop, though detection, which needs its plist, finds none", async () => {
    const { helpers, calls, runner } = nanoclaw(NOT_INSTALLED);
    const { service } = control(helpers);

    await service.stopJobWithoutPlist();

    // The environment every other helper gets: this assistant's home, user, install, and command runner.
    expect(helpers.stopService).toHaveBeenCalledExactlyOnceWith(
      { mode: 'launchd', name: LABEL, definition: plist, active: true },
      expect.objectContaining({
        platform: 'darwin',
        home: TARGET.homeDirectory,
        uid: 501,
        installSlug: INSTALL_ID,
        runner,
      }),
    );
    expect(calls).toEqual(['stop']);
  });

  it("fails, keeping NanoClaw's reason, when the job never leaves", async () => {
    const { helpers } = nanoclaw(NOT_INSTALLED);
    const didNotStop = new Error(`NanoClaw service ${LABEL} did not stop (PID 4242).`);
    helpers.stopService.mockRejectedValueOnce(didNotStop);

    await expect(control(helpers).service.stopJobWithoutPlist()).rejects.toMatchObject({
      code: 'service_still_running',
      message: `NanoClaw's service ${LABEL} did not stop: ${didNotStop.message}`,
      cause: didNotStop,
    });
  });

  it('does nothing off macOS, where no launchd job exists', async () => {
    const { helpers } = nanoclaw(NOT_INSTALLED);

    await control(helpers, { platform: 'linux' }).service.stopJobWithoutPlist();

    expect(helpers.stopService).not.toHaveBeenCalled();
  });
});

describe('restart', () => {
  it("starts the job again only after NanoClaw's stop has returned", async () => {
    const { helpers, calls } = nanoclaw(LOADED);
    const { service } = control(helpers);

    await expect(service.restart()).resolves.toBe('restarted');

    expect(calls).toEqual(['detect', 'stop', 'start']);
    expect(helpers.startService).toHaveBeenCalledExactlyOnceWith(
      { ...LOADED, active: true },
      TARGET.checkoutRoot,
      helpers.detectService.mock.calls[0]![1],
    );
    expect(helpers.drainContainers).not.toHaveBeenCalled();
  });

  it('starts a stopped assistant', async () => {
    const { helpers, calls } = nanoclaw(BOOTED_OUT);

    await expect(control(helpers).service.restart()).resolves.toBe('started');
    expect(calls).toEqual(['detect', 'start']);
    expect(helpers.startService).toHaveBeenCalledWith(
      { ...BOOTED_OUT, active: true },
      TARGET.checkoutRoot,
      expect.anything(),
    );
  });

  it('never starts a job that did not leave', async () => {
    const { helpers, calls } = nanoclaw(LOADED);
    helpers.stopService.mockRejectedValueOnce(new Error(`NanoClaw service ${LABEL} did not stop`));

    await expect(control(helpers).service.restart()).rejects.toMatchObject({ code: 'service_still_running' });
    expect(calls).not.toContain('start');
  });
});

describe("NanoClaw's own reasons", () => {
  it('keeps what a failed detection says, in an error the operator is shown', async () => {
    const { helpers } = nanoclaw(LOADED);
    const unobservable = new Error(
      `Cannot tell whether NanoClaw is running: \`launchctl print gui/501/${LABEL}\` failed (Could not find domain). Run the update from a login session of this user.`,
    );
    helpers.detectService.mockImplementationOnce(() => {
      throw unobservable;
    });

    await expect(control(helpers).service.start()).rejects.toMatchObject({
      name: 'GwsEaError',
      code: 'service_unobservable',
      message: unobservable.message,
      cause: unobservable,
    });
    expect(helpers.startService).not.toHaveBeenCalled();
  });

  it('keeps what a failed start says, naming the service', async () => {
    const { helpers } = nanoclaw(BOOTED_OUT);
    const refused = new Error(`Command failed: launchctl bootstrap gui/501\nBootstrap failed: 5: Input/output error`);
    helpers.startService.mockImplementationOnce(() => {
      throw refused;
    });

    await expect(control(helpers).service.start()).rejects.toMatchObject({
      name: 'GwsEaError',
      code: 'service_start_failed',
      message: `NanoClaw's service ${LABEL} did not start: ${refused.message}`,
      cause: refused,
    });
  });

  it('keeps what a failed drain says', async () => {
    const { helpers } = nanoclaw(BOOTED_OUT);
    const timedOut = new Error('Timed out waiting for NanoClaw containers to stop: 3f2a9c1b7d4e');
    helpers.drainContainers.mockRejectedValueOnce(timedOut);

    await expect(control(helpers).service.drain()).rejects.toMatchObject({
      name: 'GwsEaError',
      code: 'containers_still_running',
      message: `NanoClaw did not stop the assistant's agent containers: ${timedOut.message}.`,
      cause: timedOut,
    });
  });
});

describe('refusals', () => {
  it.each(['start', 'restart'] as const)(
    '%s refuses when no service is installed, naming the command that installs it',
    async (action) => {
      const { helpers, calls } = nanoclaw(NOT_INSTALLED);

      await expect(control(helpers).service[action]()).rejects.toMatchObject({
        code: 'service_not_installed',
        message: `No NanoClaw service is installed for ${TARGET.checkoutRoot}; gws-ea resume --id ${INSTANCE_ID} installs it.`,
      });
      expect(calls).toEqual(['detect']);
    },
  );

  it.each(['start', 'stop', 'restart'] as const)(
    '%s refuses a host running from the checkout outside its service',
    async (action) => {
      const { helpers, calls } = nanoclaw(UNMANAGED);

      await expect(control(helpers).service[action]()).rejects.toMatchObject({
        code: 'service_unmanaged',
        message: expect.stringContaining('4242'),
      });
      expect(calls).toEqual(['detect']);
    },
  );
});

describe('turning the service off and on', () => {
  /** launchd's override list as `print-disabled` prints it, with this assistant's row set to `state`. */
  function overrides(state?: string): string {
    const rows = ['"com.apple.some-agent" => enabled', `"${LABEL}-other" => disabled`];
    if (state !== undefined) rows.push(`"${LABEL}" => ${state}`);
    return `disabled services = {\n${rows.map((row) => `\t\t${row}`).join('\n')}\n\t}\n`;
  }

  /** NanoClaw's helpers whose runner answers launchctl's override list with `state` and records every command. */
  function launchd(state?: string) {
    const fake = nanoclaw(LOADED);
    fake.runner.run.mockImplementation((command, args) => {
      fake.calls.push([command, ...args].join(' '));
      return args[0] === 'print-disabled' ? overrides(state) : '';
    });
    return fake;
  }

  /** NanoClaw's helpers whose runner answers `is-enabled` as systemctl does: non-zero for anything but enabled. */
  function systemd(mode: 'systemd-user' | 'systemd-system', state: string) {
    const fake = nanoclaw({ ...SYSTEMD_RUNNING, mode });
    fake.runner.tryRun.mockImplementation((command, args) => {
      fake.calls.push([command, ...args].join(' '));
      return { ok: state === 'enabled', stdout: state };
    });
    return fake;
  }

  it.each([
    ['disabled', 'disabled'],
    ['true', 'disabled'],
    ['enabled', 'enabled'],
    ['false', 'enabled'],
    [undefined, 'enabled'],
  ] as const)('reads a launchd override of %s as %s', (state, expected) => {
    const { helpers, runner } = launchd(state);

    expect(control(helpers).service.enablement()).toBe(expected);
    expect(runner.run).toHaveBeenCalledWith('launchctl', ['print-disabled', 'gui/501'], undefined, {
      timeoutMs: 30_000,
    });
  });

  it.each([
    ['disabled', 'disabled'],
    ['enabled', 'enabled'],
    ['masked', 'enabled'],
    ['static', 'enabled'],
  ] as const)('reads systemd is-enabled %s as %s', (state, expected) => {
    const { helpers, calls } = systemd('systemd-user', state);

    expect(control(helpers, { platform: 'linux' }).service.enablement()).toBe(expected);
    expect(calls).toEqual(['detect', `systemctl --user is-enabled ${UNIT}`]);
  });

  it('cannot tell whether a systemd unit is disabled when systemctl itself fails', () => {
    const { helpers, runner } = nanoclaw(SYSTEMD_RUNNING);
    runner.tryRun.mockReturnValue({ ok: false, stdout: 'Failed to connect to bus: No such file or directory' });

    expect(() => control(helpers, { platform: 'linux' }).service.enablement()).toThrow(
      expect.objectContaining({ code: 'service_unobservable' }),
    );
  });

  it('disables and enables a launchd job by its label, reporting each change once', () => {
    const disabled = launchd(undefined);
    expect(control(disabled.helpers).service.disable()).toBe(true);
    expect(disabled.calls).toContain(`launchctl disable gui/501/${LABEL}`);

    const already = launchd('disabled');
    expect(control(already.helpers).service.disable()).toBe(false);
    expect(already.calls.filter((call) => call.startsWith('launchctl disable'))).toEqual([]);

    const enabled = launchd('disabled');
    expect(control(enabled.helpers).service.enable()).toBe(true);
    expect(enabled.calls).toContain(`launchctl enable gui/501/${LABEL}`);

    const on = launchd('enabled');
    expect(control(on.helpers).service.enable()).toBe(false);
    expect(on.calls.filter((call) => call.startsWith('launchctl enable'))).toEqual([]);
  });

  it.each([
    ['systemd-user', ['--user']],
    ['systemd-system', []],
  ] as const)('disables and enables a %s unit', (mode, scope) => {
    const on = systemd(mode, 'enabled');
    on.runner.run.mockImplementation((command, args) => {
      on.calls.push([command, ...args].join(' '));
      return '';
    });
    expect(control(on.helpers, { platform: 'linux' }).service.disable()).toBe(true);
    expect(on.calls).toContain(['systemctl', ...scope, 'disable', UNIT].join(' '));

    const off = systemd(mode, 'disabled');
    off.runner.run.mockImplementation((command, args) => {
      off.calls.push([command, ...args].join(' '));
      return '';
    });
    expect(control(off.helpers, { platform: 'linux' }).service.enable()).toBe(true);
    expect(off.calls).toContain(['systemctl', ...scope, 'enable', UNIT].join(' '));
  });

  it('fails naming the label when launchd refuses to disable it, and reports the effect as uncertain', () => {
    const { helpers, runner } = launchd(undefined);
    const refused = new Error(`Command failed: launchctl disable gui/501/${LABEL}\nOperation not permitted`);
    runner.run.mockImplementation((_command, args) => {
      if (args[0] === 'disable') throw refused;
      return overrides(undefined);
    });
    const effects: (true | null)[] = [];

    expect(() => control(helpers, { recordEffect: (changed) => effects.push(changed) }).service.disable()).toThrow(
      expect.objectContaining({ code: 'service_enablement_failed', message: expect.stringContaining(LABEL) }),
    );
    expect(effects).toEqual([null]);
  });

  it('never turns the service off or on from the start and stop that updates, rollbacks, and removal share', async () => {
    const stopped = launchd(undefined);
    await control(stopped.helpers).service.stop();
    const started = launchd(undefined);
    started.helpers.detectService.mockReturnValue(BOOTED_OUT);
    await control(started.helpers).service.start();

    for (const { calls } of [stopped, started]) {
      expect(calls.filter((call) => /^(launchctl|systemctl) /u.test(call))).toEqual([]);
    }
  });
});

describe('starting as create and resume do', () => {
  it.each([
    ['disabled', ['launchctl print-disabled gui/501', `launchctl enable gui/501/${LABEL}`, 'start']],
    ['enabled', ['launchctl print-disabled gui/501', 'start']],
  ] as const)('turns a %s launchd job on before loading it', async (state, steps) => {
    const { helpers, calls, runner } = nanoclaw(BOOTED_OUT);
    runner.run.mockImplementation((command, args) => {
      calls.push([command, ...args].join(' '));
      return args[0] === 'print-disabled' ? `\t\t"${LABEL}" => ${state}\n` : '';
    });

    await expect(restartTurnedOn(control(helpers).service)).resolves.toBe('started');
    expect(calls.filter((call) => call !== 'detect')).toEqual(steps);
  });

  it('turns a disabled systemd unit on before starting it', async () => {
    const { helpers, calls, runner } = nanoclaw({ ...SYSTEMD_RUNNING, active: false });
    runner.tryRun.mockReturnValue({ ok: false, stdout: 'disabled' });

    await restartTurnedOn(control(helpers, { platform: 'linux' }).service);

    expect(calls.filter((call) => call !== 'detect')).toEqual([
      `systemctl --user enable ${UNIT}`,
      `systemctl --user reset-failed ${UNIT}`,
      'start',
    ]);
  });
});

describe('drain and health', () => {
  it("drains only the assistant's own containers, within the bound given", async () => {
    const { helpers } = nanoclaw(LOADED);
    const { service } = control(helpers);

    await service.drain(5_000);

    expect(helpers.drainContainers).toHaveBeenCalledExactlyOnceWith(
      TARGET.checkoutRoot,
      expect.objectContaining({ installSlug: INSTALL_ID }),
      5_000,
    );
  });

  it.each([
    ['an agent container', 'a1|sess-1|\n', true],
    ['a session auxiliary', 'a2|sess-1|gateway\n', true],
    ['only a gateway-owned container, which a host start never recreates', 'g1||gateway\n', false],
    ['nothing', '', false],
  ] as const)('sees agents running when Docker lists %s', (_case, listed, expected) => {
    const { helpers, runner } = nanoclaw(LOADED);
    runner.tryRun.mockReturnValue({ ok: true, stdout: listed });

    expect(control(helpers).service.agentsRunning()).toBe(expected);
    expect(runner.tryRun).toHaveBeenCalledWith(
      'docker',
      [
        'ps',
        '--filter',
        `label=nanoclaw-install=${INSTALL_ID}`,
        '--format',
        '{{.ID}}|{{.Label "nanoclaw-session"}}|{{.Label "nanoclaw-role"}}',
      ],
      undefined,
      { timeoutMs: 30_000 },
    );
  });

  it('verifies health against the detected service marked active, so a stopped one is never taken as healthy', async () => {
    const { helpers } = nanoclaw(BOOTED_OUT);
    helpers.verifyServiceHealth.mockResolvedValueOnce(false);
    const { service } = control(helpers);

    await expect(service.verifyHealth(10_000)).resolves.toBe(false);

    expect(helpers.verifyServiceHealth).toHaveBeenCalledExactlyOnceWith(
      { ...BOOTED_OUT, active: true },
      TARGET.checkoutRoot,
      expect.objectContaining({ installSlug: INSTALL_ID }),
      10_000,
    );
  });
});

describe("an assistant's own service coordinates", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  /** A created assistant's runtime record, with the checkout files its service definition names. */
  async function createdRuntime(): Promise<InstanceRuntimeConfig> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-service-control-'));
    roots.push(root);
    const paths = resolveControlPlanePaths({
      configRoot: path.join(root, 'config'),
      stateRoot: path.join(root, 'state'),
    });
    const instanceId = randomUUID();
    const checkout = paths.instanceLayout(instanceId).release('aaaaaaaa');
    await mkdir(path.join(checkout, 'dist', 'gws-ea'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(checkout, 'bin'), { mode: 0o700 });
    await writeFile(path.join(checkout, 'dist', 'index.js'), 'host');
    await writeFile(path.join(checkout, 'dist', 'gws-ea', 'process.js'), 'launcher');
    await writeFile(path.join(checkout, 'bin', 'ncl'), '#!/bin/sh\n', { mode: 0o700 });
    await symlink('aaaaaaaa', paths.checkoutRoot(instanceId));
    const home = path.join(root, 'home');
    await mkdir(home, { mode: 0o700 });
    const reservation: InstanceReservation = {
      instance_id: instanceId,
      release_track: 'dogfood',
      source_remote: 'https://example.test/nanoclaw.git',
      deployed_commit: 'a'.repeat(40),
      allocated_ports: { onecli_app: 31_002, onecli_gateway: 31_003 },
      exclusive_resource_claims: {
        ...deriveGcpClaims(instanceId),
        gcp_account: 'operator@example.test',
        workspace_email: 'assistant@example.test',
        onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
      },
    };
    const onecli = createOnecliRuntimeLayout({
      instanceId,
      instanceRoot: paths.instanceRoot(instanceId),
      project: reservation.exclusive_resource_claims.onecli_project,
      appPort: 31_002,
      gatewayPort: 31_003,
      dockerEndpoint: TARGET.dockerEndpoint,
    });
    return createInstanceRuntimeConfig(paths, reservation, onecli, {
      nodePath: process.execPath,
      homeDirectory: home,
      selectedProvider: 'claude',
      dockerEndpoint: TARGET.dockerEndpoint,
    });
  }

  it.each(['macos', 'linux'] as const)(
    'reads the log files the rendered %s service definition sends the host to (drift guard)',
    async (platform) => {
      const runtime = await createdRuntime();
      // Only the definition is rendered; every service-manager command is faked.
      const runCommand = vi.fn(async () => ({ stdout: 'yes\n', stderr: '' }));
      const { layout } = await reconcileInstanceService(runtime, {
        platform,
        homeDirectory: runtime.home_directory,
        runningAsRoot: false,
        uid: 501,
        ambientEnv: {},
        runCommand,
        restartService: async () => undefined,
      });
      const definition = await readFile(layout.serviceDefinitionPath, 'utf8');
      const logs = hostLogFiles(runtime.instance_root);

      expect(definition).toContain(logs.output);
      expect(definition).toContain(logs.errors);
    },
  );
});
