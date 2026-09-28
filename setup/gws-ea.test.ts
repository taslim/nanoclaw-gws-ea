import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as nanoclawService from '../scripts/update/service.js';
import type { CliRuntime, FailureReport } from '../src/gws-ea/cli.js';
import type { Interaction } from '../src/gws-ea/events.js';
import type { PrerequisiteRequest } from '../src/gws-ea/prerequisites.js';
import {
  createServiceControl,
  type NanoclawCommandRunner,
  type NanoclawServiceHelpers,
  type ServiceControlTarget,
} from '../src/gws-ea/service-control.js';
import { createInstanceServiceCoordinates, type InstanceServicePlatform } from '../src/gws-ea/service-coordinates.js';

const fixture = vi.hoisted(() => {
  const spinner = {
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
  };
  return {
    runCli: vi.fn(async (_args: readonly string[], _runtime: unknown) => 0),
    collect: vi.fn(async (_context: unknown, _dependencies: unknown) => ({ marker: 'collected' })),
    authenticate: vi.fn(async (_provider: string, _providers: unknown) => ({ marker: 'authenticated' })),
    providers: [{ value: 'claude' }],
    spinner,
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn(), step: vi.fn() },
    note: vi.fn(),
    password: vi.fn(async () => 'fresh-cloudflare-token'),
    confirm: vi.fn(async () => true),
    ensurePrerequisites: vi.fn(async () => ({ account: 'operator@example.com' })),
    signIn: vi.fn(async () => undefined),
    confirmAccount: vi.fn(async () => true),
    offerDiagnosis: vi.fn(async () => 'answered'),
    dump: vi.fn(),
  };
});

vi.mock('@clack/prompts', () => ({
  log: fixture.log,
  note: fixture.note,
  password: fixture.password,
  confirm: fixture.confirm,
  spinner: () => fixture.spinner,
  isCancel: () => false,
}));
vi.mock('../src/gws-ea/cli.js', () => ({ runCli: fixture.runCli }));
vi.mock('./gws-ea-input.js', () => ({
  collectGwsEaCreateInput: fixture.collect,
  authenticateGwsEaProvider: fixture.authenticate,
  CLOUDFLARE_API_TOKEN_GUIDANCE: 'cloudflare-token-guidance',
}));
vi.mock('./gws-ea-prerequisites.js', () => ({
  ensurePrerequisites: fixture.ensurePrerequisites,
  signInToGoogleCloud: fixture.signIn,
  confirmGoogleAccount: fixture.confirmAccount,
}));
vi.mock('./gws-ea-assist.js', () => ({ offerDiagnosis: fixture.offerDiagnosis }));
vi.mock('./lib/runner.js', () => ({ dumpTranscriptOnFailure: fixture.dump }));
vi.mock('./providers/registry.js', () => ({ listSetupProviders: () => fixture.providers }));
vi.mock('./providers/index.js', () => ({}));

const { createTerminalPresenter, main } = await import('./gws-ea.js');
/** Upstream's `.env` writer: the driver injects it unchanged. */
const { upsertEnvVars } = await import('./set-env.js');
/** Upstream's host readiness helpers (untyped ESM, so loaded by URL): the driver injects them unchanged. */
const hostStatus = (await import(new URL('./lib/host-status.mjs', import.meta.url).href)) as Readonly<
  Record<'queryHost' | 'waitForHost', unknown>
>;

function runtimeOf(call = 0): CliRuntime {
  return fixture.runCli.mock.calls[call]![1] as CliRuntime;
}

/** Service control runs NanoClaw's own update-controller helpers, unchanged. */
function expectUpstreamServiceHelpers(runtime: CliRuntime): void {
  expect(runtime.serviceHelpers).toEqual({
    createCommandRunner: nanoclawService.createCommandRunner,
    detectService: nanoclawService.detectService,
    stopService: nanoclawService.stopService,
    startService: nanoclawService.startService,
    drainContainers: nanoclawService.drainContainers,
    verifyServiceHealth: nanoclawService.verifyServiceHealth,
  });
}

function report(overrides: Partial<FailureReport> = {}): FailureReport {
  return {
    command: 'resume',
    step: 'start_onecli',
    code: 'onecli_unhealthy',
    cause: 'OneCLI did not become healthy',
    nextAction: 'Resume with: gws-ea resume --id x',
    progressLog: '/logs/progress.log',
    runDirectory: '/logs',
    ...overrides,
  };
}

describe('GWS-EA driver', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs unattended without a TTY: no spinner, prompts, gcloud guidance, or failure loop', async () => {
    await main(['create', '--track', 'prod'], { interactive: false });

    expect(fixture.runCli).toHaveBeenCalledOnce();
    const runtime = runtimeOf();
    expect(fixture.runCli.mock.calls[0]![0]).toEqual(['create', '--track', 'prod']);
    expect(runtime.presenter).toBeUndefined();
    expect(runtime.prompts).toBeUndefined();
    expect(runtime.onFailure).toBeUndefined();
    expect(runtime.checkPrerequisites).toBeUndefined();
    expect(runtime.confirmRemoval).toBeUndefined();
    expect(runtime.upsertEnvVars).toBe(upsertEnvVars);
    expect(runtime.hostStatus?.queryHost).toBe(hostStatus.queryHost);
    expect(runtime.hostStatus?.waitForHost).toBe(hostStatus.waitForHost);
    expectUpstreamServiceHelpers(runtime);
    await runtime.collectCreateInputs!({ marker: 'context' } as never);
    expect(fixture.collect).toHaveBeenCalledWith(
      { marker: 'context' },
      { providers: fixture.providers, interactive: false },
    );
  });

  it('relies on upstream waitForHost naming the checkout-relative error log that gws-ea rewrites', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-host-status-'));
    const waitForHost = hostStatus.waitForHost as (root: string, options: { timeoutMs: number }) => Promise<unknown>;
    try {
      // No host listens in an empty checkout: the helper gives up with its reason and the relative log path.
      await expect(waitForHost(root, { timeoutMs: 50 })).rejects.toThrow(/\. Check logs\/nanoclaw\.error\.log\.$/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('wires the spinner, prompts, gcloud guidance, and failure loop on a TTY', async () => {
    await main(['resume', '--id', 'x'], { interactive: true });
    const runtime = runtimeOf();

    expect(runtime.presenter).toBeDefined();
    expect(runtime.upsertEnvVars).toBe(upsertEnvVars);
    expect(runtime.hostStatus?.waitForHost).toBe(hostStatus.waitForHost);
    expectUpstreamServiceHelpers(runtime);
    await runtime.collectCreateInputs!({ marker: 'context' } as never);
    expect(fixture.collect).toHaveBeenCalledWith(
      { marker: 'context' },
      { providers: fixture.providers, interactive: true },
    );

    await runtime.prompts!.providerCredential('claude');
    expect(fixture.authenticate).toHaveBeenCalledWith('claude', fixture.providers);

    await expect(
      runtime.prompts!.cloudflareAccountToken({ accountId: 'a'.repeat(32), reason: 'The listener drifted.' }),
    ).resolves.toBe('fresh-cloudflare-token');
    expect(fixture.log.warn).toHaveBeenCalledWith('The listener drifted.');
    expect(fixture.note).toHaveBeenCalledWith('cloudflare-token-guidance', 'Cloudflare access');
    expect(fixture.log.warn.mock.invocationCallOrder[0]).toBeLessThan(fixture.password.mock.invocationCallOrder[0]!);
    expect(fixture.note.mock.invocationCallOrder[0]).toBeLessThan(fixture.password.mock.invocationCallOrder[0]!);

    await runtime.prompts!.googleCloudSignIn('reserved@example.com');
    expect(fixture.signIn).toHaveBeenCalledWith('reserved@example.com');
    await expect(runtime.prompts!.googleAccount('operator@example.com')).resolves.toBe(true);
    expect(fixture.confirmAccount).toHaveBeenCalledWith('operator@example.com');

    const interaction = { marker: 'interaction' } as unknown as Interaction;
    const request: PrerequisiteRequest = {
      command: 'resume',
      paths: {
        configRoot: '/config',
        stateRoot: '/state',
        logsRoot: '/state/logs',
        instancesRoot: '/state/instances',
        onecliCliFile: (version) => `/state/tools/onecli/${version}/onecli`,
      },
      account: 'reserved@example.com',
      dockerEndpoint: 'unix:///var/run/docker.sock',
      checkoutRoot: '/state/instances/x/nanoclaw',
    };
    await runtime.checkPrerequisites!(request, interaction);
    expect(fixture.ensurePrerequisites).toHaveBeenCalledWith(request, interaction);
  });

  it('offers diagnosis, then a retry, after an interactive failure', async () => {
    await main(['resume', '--id', 'x'], { interactive: true });
    const { onFailure } = runtimeOf();

    await expect(onFailure!(report())).resolves.toBe('retry');
    expect(fixture.offerDiagnosis).toHaveBeenCalledWith(report());
    expect(fixture.offerDiagnosis.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.confirm.mock.invocationCallOrder[0]!,
    );
    expect(fixture.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/retry/iu) }),
    );

    fixture.confirm.mockResolvedValueOnce(false);
    await expect(onFailure!(report())).resolves.toBe('stop');
  });

  it('asks before removal on a TTY, defaulting to keep the assistant', async () => {
    await main(['remove', '--id', 'x'], { interactive: true });
    fixture.confirm.mockResolvedValueOnce(false);
    await expect(runtimeOf().confirmRemoval!({ instanceId: 'x', gcpProject: 'p' } as never)).resolves.toBe(false);
    expect(fixture.confirm).toHaveBeenCalledExactlyOnceWith({
      message: expect.stringMatching(/assistant x .*GCP project p\?$/u),
      initialValue: false,
    });
  });
});

describe('GWS-EA terminal presenter', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('renders a labeled step as a spinner that shows its waiting reason and elapsed time', () => {
    vi.useFakeTimers();
    const presenter = createTerminalPresenter();

    presenter.event({ type: 'step-started', step: 'provision_gcp', label: 'Configuring Google Cloud…' });
    expect(fixture.spinner.start).toHaveBeenCalledWith(expect.stringContaining('Configuring Google Cloud'));
    presenter.event({ type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for the service account…' });
    vi.advanceTimersByTime(1000);
    expect(fixture.spinner.message).toHaveBeenLastCalledWith(
      expect.stringContaining('Waiting for the service account'),
    );
    expect(fixture.spinner.message).toHaveBeenLastCalledWith(expect.stringContaining('(1s)'));
    presenter.event({ type: 'step-completed', step: 'provision_gcp' });
    expect(fixture.spinner.stop).toHaveBeenCalledWith(expect.stringContaining('Configuring Google Cloud'));
  });

  it('hands the terminal over and back without losing the running step', () => {
    const presenter = createTerminalPresenter();

    presenter.event({ type: 'step-started', step: 'configure_provider', label: 'Connecting the AI provider…' });
    presenter.suspend();
    presenter.suspend();
    expect(fixture.spinner.clear).toHaveBeenCalledOnce();
    presenter.resume();
    presenter.resume();
    expect(fixture.spinner.start).toHaveBeenCalledTimes(2);
    presenter.event({ type: 'step-failed', step: 'configure_provider', error: new Error('x') });
    expect(fixture.spinner.error).toHaveBeenCalledWith(expect.stringContaining('Connecting the AI provider'));
    presenter.resume();
    expect(fixture.spinner.start).toHaveBeenCalledTimes(2);
  });

  it('ignores unlabeled steps and renders the failure summary with its redacted tail', () => {
    const presenter = createTerminalPresenter();

    presenter.event({ type: 'step-started', step: 'inputs' });
    expect(fixture.spinner.start).not.toHaveBeenCalled();
    presenter.report({
      outcome: 'failed',
      headline: 'Stopped at start_onecli: OneCLI did not become healthy',
      details: ['Log: /logs/progress.log'],
      tail: 'last stderr line',
    });
    expect(fixture.log.error).toHaveBeenCalledWith('Stopped at start_onecli: OneCLI did not become healthy');
    expect(fixture.log.message).toHaveBeenCalledWith('Log: /logs/progress.log');
    expect(fixture.dump).toHaveBeenCalledWith('last stderr line');
  });
});

describe("GWS-EA service control through NanoClaw's helpers", () => {
  // The helpers the driver wires, with only their command runner faked: no real launchctl or systemctl runs.
  const INSTALL_ID = '0123456789abcdef0123456789abcdef';
  const UID = 501;
  const homes: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  });

  async function wiredHelpers(runner: NanoclawCommandRunner): Promise<NanoclawServiceHelpers> {
    await main(['remove', '--id', 'x'], { interactive: false });
    const helpers = runtimeOf().serviceHelpers;
    if (!helpers) throw new Error('The driver supplied no service helpers');
    return { ...helpers, createCommandRunner: () => runner };
  }

  /** A home holding the service definition gws-ea writes for the install, where its coordinates put it. */
  async function installed(platform: InstanceServicePlatform) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-service-home-'));
    homes.push(home);
    const coordinates = createInstanceServiceCoordinates({
      installId: INSTALL_ID,
      homeDirectory: home,
      platform,
      runningAsRoot: false,
    });
    await mkdir(path.dirname(coordinates.serviceDefinitionPath), { recursive: true });
    await writeFile(coordinates.serviceDefinitionPath, 'definition\n');
    const target: ServiceControlTarget = {
      checkoutRoot: path.join(home, 'nanoclaw'),
      installId: INSTALL_ID,
      homeDirectory: home,
      dockerEndpoint: 'unix:///var/run/docker.sock',
    };
    return { coordinates, target };
  }

  /**
   * launchd at `launchctl`: `bootout` unloads the job, but it lingers for
   * `linger` more `print`s while launchd removes it, and `bootstrap` fails as
   * launchd does while the job is still loaded.
   */
  function fakeLaunchd(label: string, state: { loaded: boolean; lingering: number }, linger = 0) {
    const calls: string[] = [];
    const service = `gui/${UID}/${label}`;
    const runner: NanoclawCommandRunner = {
      run(command, args) {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === 'launchctl' && args[0] === 'bootout') {
          if (!state.loaded)
            throw new Error(`Command failed: launchctl bootout ${service}\nBoot-out failed: 3: No such process`);
          state.loaded = false;
          state.lingering = linger;
          return '';
        }
        if (command === 'launchctl' && args[0] === 'bootstrap') {
          if (state.loaded || state.lingering > 0) {
            throw new Error(`Command failed: launchctl bootstrap gui/${UID}\nBootstrap failed: 5: Input/output error`);
          }
          state.loaded = true;
          return '';
        }
        if (command === 'launchctl' && args[0] === 'kickstart' && state.loaded) return '';
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
      tryRun(command, args) {
        calls.push(`${command} ${args.join(' ')}`);
        if (command !== 'launchctl' || args[0] !== 'print') return { ok: false, stdout: '' };
        if (state.lingering > 0) {
          state.lingering -= 1;
          return { ok: true, stdout: '' };
        }
        return { ok: state.loaded, stdout: '' };
      },
    };
    return { runner, calls };
  }

  it.each([
    ['macos', 'darwin', (identity: string) => `launchctl print gui/${UID}/${identity}`],
    ['linux', 'linux', (identity: string) => `systemctl --user is-active --quiet ${identity}`],
  ] as const)(
    "detects the %s service at the label and definition gws-ea's coordinates produce (drift guard)",
    async (platform, nodePlatform, probe) => {
      const { coordinates, target } = await installed(platform);
      const calls: string[] = [];
      const runner: NanoclawCommandRunner = {
        run: () => '',
        tryRun(command, args) {
          calls.push(`${command} ${args.join(' ')}`);
          return { ok: true, stdout: '' };
        },
      };
      const service = createServiceControl(await wiredHelpers(runner), target, {
        platform: nodePlatform,
        uid: UID,
        ambientEnv: {},
      });

      expect(service.detect()).toMatchObject({
        name: coordinates.serviceIdentity,
        definition: coordinates.serviceDefinitionPath,
        active: true,
      });
      expect(calls).toEqual([probe(coordinates.serviceIdentity)]);
    },
  );

  it('starts a stopped (booted-out) assistant by bootstrapping and kickstarting it', async () => {
    const { coordinates, target } = await installed('macos');
    const { runner, calls } = fakeLaunchd(coordinates.serviceIdentity, { loaded: false, lingering: 0 });
    const service = createServiceControl(await wiredHelpers(runner), target, {
      platform: 'darwin',
      uid: UID,
      ambientEnv: {},
    });

    await expect(service.start()).resolves.toBe('started');

    expect(calls).toEqual([
      `launchctl print gui/${UID}/${coordinates.serviceIdentity}`,
      `launchctl bootstrap gui/${UID} ${coordinates.serviceDefinitionPath}`,
      `launchctl kickstart gui/${UID}/${coordinates.serviceIdentity}`,
    ]);
  });

  it.each([
    ['a running job', { loaded: true, lingering: 0 }],
    ['a job a stop has just booted out', { loaded: false, lingering: 2 }],
  ] as const)('restarts %s only once launchd has dropped it, so bootstrap never fails', async (_what, initial) => {
    const { coordinates, target } = await installed('macos');
    const { runner, calls } = fakeLaunchd(coordinates.serviceIdentity, { ...initial }, 3);
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const service = createServiceControl(await wiredHelpers(runner), target, {
      platform: 'darwin',
      uid: UID,
      ambientEnv: {},
      sleep,
    });

    await expect(service.restart()).resolves.toBe('restarted');

    const bootstrap = calls.indexOf(`launchctl bootstrap gui/${UID} ${coordinates.serviceDefinitionPath}`);
    expect(bootstrap).toBeGreaterThan(calls.indexOf(`launchctl bootout gui/${UID}/${coordinates.serviceIdentity}`));
    expect(calls.slice(bootstrap)).toEqual([
      `launchctl bootstrap gui/${UID} ${coordinates.serviceDefinitionPath}`,
      `launchctl kickstart gui/${UID}/${coordinates.serviceIdentity}`,
    ]);
    expect(sleep).toHaveBeenCalled();
  });
});
