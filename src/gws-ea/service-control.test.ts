import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { resolveControlPlanePaths } from './paths.js';
import { allocateInstanceId } from './registry.js';
import { createInstanceRuntimeConfig, reconcileInstanceService, type InstanceRuntimeConfig } from './service.js';
import {
  createServiceControl,
  hostLogFiles,
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

/**
 * NanoClaw's helpers, faked: detection answers from `detections` in turn and
 * then keeps its last answer; every helper call is recorded in order.
 */
function nanoclaw(...detections: NanoclawServiceHandle[]) {
  const calls: string[] = [];
  const runner: NanoclawCommandRunner = { run: () => '', tryRun: () => ({ ok: true, stdout: '' }) };
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
    const instanceId = allocateInstanceId();
    const checkout = paths.checkoutRoot(instanceId);
    await mkdir(path.join(checkout, 'dist', 'gws-ea'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(checkout, 'bin'), { mode: 0o700 });
    await writeFile(path.join(checkout, 'dist', 'index.js'), 'host');
    await writeFile(path.join(checkout, 'dist', 'gws-ea', 'process.js'), 'launcher');
    await writeFile(path.join(checkout, 'bin', 'ncl'), '#!/bin/sh\n', { mode: 0o700 });
    const home = path.join(root, 'home');
    await mkdir(home, { mode: 0o700 });
    const reservation: InstanceReservation = {
      instance_id: instanceId,
      checkout_realpath: checkout,
      release_track: 'dogfood',
      source_remote: 'https://example.test/nanoclaw.git',
      deployed_commit: 'a'.repeat(40),
      allocated_ports: { nanoclaw_webhook: 31_001, onecli_app: 31_002, onecli_gateway: 31_003 },
      exclusive_resource_claims: {
        ingress: { mode: 'existing', endpoint_url: 'https://assistant.example.test/webhook/gchat' },
        gcp_project_id: 'assistant-project',
        gcp_account: 'operator@example.test',
        gchat_service_account: 'gws-ea-chat@assistant-project.iam.gserviceaccount.com',
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
    return createInstanceRuntimeConfig(reservation, onecli, {
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
      const logs = hostLogFiles(runtime.checkout_realpath);

      expect(definition).toContain(logs.output);
      expect(definition).toContain(logs.errors);
    },
  );
});
