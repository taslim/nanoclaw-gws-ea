import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  importProviderCredential,
  observeOnecliRuntime,
  onecliSecretMatchesCredentialMetadata,
  persistOnecliApiKeyFiles,
  reconcileOnecliRuntime,
  removeOnecliRuntime,
  verifyOnecliRuntime,
  type OnecliCommand,
  type OnecliCommandRunner,
} from './onecli.js';
import {
  createOnecliRuntimeLayout,
  ONECLI_WAIT_TIMEOUT_SECONDS,
  type OnecliPins,
  type OnecliRuntimeLayout,
} from './onecli-compose.js';
import { RECORDED_ONECLI_VERSION } from './fixtures/recordings.js';
import { GwsEaError } from './types.js';

const INSTANCE_ID = '12345678-1234-4123-8123-123456789abc';
const ONECLI_API_KEY = `oc_${'a'.repeat(64)}`;
const DOCKER_ENDPOINT = 'unix:///Users/operator/.docker/run/docker.sock';
/** The pins this instance's release recorded, deliberately not this launcher's. */
const PINS: OnecliPins = { gateway: '1.41.3', cli: '2.2.4' };
/** An operator shell that points Docker, Compose, and OneCLI at another runtime. */
const HOSTILE_AMBIENT: NodeJS.ProcessEnv = {
  PATH: '/safe/bin',
  HOME: '/host/home',
  LANG: 'en_US.UTF-8',
  DOCKER_HOST: 'tcp://attacker.invalid:2376',
  COMPOSE_PROJECT_NAME: 'victim',
  COMPOSE_FILE: '/tmp/attacker.yml',
  ONECLI_API_HOST: 'https://attacker.invalid',
  ONECLI_API_KEY: 'ambient-secret',
  POSTGRES_PASSWORD: 'ambient-postgres',
  NANOCLAW_INSTALL_ID: 'victim',
  GCHAT_CREDENTIALS: 'channel-secret',
};
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function layoutFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-onecli-'));
  roots.push(root);
  return createOnecliRuntimeLayout({
    instanceId: INSTANCE_ID,
    instanceRoot: root,
    project: 'gws-ea-12345678123441238123123456789abc',
    appPort: 31_002,
    gatewayPort: 31_003,
    cliExecutable: '/opt/onecli/bin/onecli',
    dockerEndpoint: DOCKER_ENDPOINT,
  });
}

describe('OneCLI child boundaries', () => {
  it('compares the complete non-secret provider contract for an existing secret ID', () => {
    const expected = {
      name: 'Anthropic',
      type: 'generic',
      hostPattern: 'api.example.test',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    };
    const observed = {
      id: 'same-secret-id',
      name: 'Anthropic',
      type: 'generic',
      hostPattern: 'api.example.test',
      pathPattern: null,
      injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    };

    expect(onecliSecretMatchesCredentialMetadata(observed, expected)).toBe(true);
    expect(onecliSecretMatchesCredentialMetadata({ ...observed, hostPattern: 'drifted.example.test' }, expected)).toBe(
      false,
    );
  });
});

describe('OneCLI runtime removal', () => {
  it('removes and verifies only the exact owned OneCLI networks and volumes', async () => {
    const layout = await layoutFixture();
    let resourcesPresent = true;
    let downCalls = 0;
    const runner: OnecliCommandRunner = async (command) => {
      if (command.args[0] === 'container' && command.args[1] === 'ls') {
        return { stdout: '', stderr: '' };
      }
      if ((command.args[0] === 'network' || command.args[0] === 'volume') && command.args[1] === 'ls') {
        if (!resourcesPresent) return { stdout: '', stderr: '' };
        const filter = command.args[command.args.indexOf('--filter') + 1] ?? '';
        const name = filter.replace(/^name=\^/u, '').replace(/\$$/u, '');
        return { stdout: `${name}\n`, stderr: '' };
      }
      if (command.args[0] === 'compose' && command.args.includes('down')) {
        downCalls += 1;
        resourcesPresent = false;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command.args.join(' ')}`);
    };

    await removeOnecliRuntime(layout, { dockerCommandRunner: runner, ambientEnv: { PATH: '/safe/bin' } });

    expect(downCalls).toBe(1);
  });

  it('treats a not-yet-created OneCLI runtime as already removed', async () => {
    const layout = await layoutFixture();
    const calls: string[][] = [];
    const runner: OnecliCommandRunner = async (command) => {
      expect(command.cwd).toBe(path.dirname(layout.rootDirectory));
      calls.push([...command.args]);
      return { stdout: '', stderr: '' };
    };

    await removeOnecliRuntime(layout, { dockerCommandRunner: runner });

    expect(calls.some((args) => args[0] === 'compose')).toBe(false);
  });

  it('refuses to remove an exact-name OneCLI resource without this instance ownership label', async () => {
    const layout = await layoutFixture();
    let downCalls = 0;
    const runner: OnecliCommandRunner = async (command) => {
      if (command.args[0] === 'container' && command.args[1] === 'ls') {
        return { stdout: '', stderr: '' };
      }
      if ((command.args[0] === 'network' || command.args[0] === 'volume') && command.args[1] === 'ls') {
        const filters = command.args.filter((value) => value.startsWith('label='));
        if (filters.length > 0) return { stdout: '', stderr: '' };
        const filter = command.args[command.args.indexOf('--filter') + 1] ?? '';
        const name = filter.replace(/^name=\^/u, '').replace(/\$$/u, '');
        return { stdout: `${name}\n`, stderr: '' };
      }
      if (command.args[0] === 'compose' && command.args.includes('down')) {
        downCalls += 1;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command.args.join(' ')}`);
    };

    await expect(removeOnecliRuntime(layout, { dockerCommandRunner: runner })).rejects.toMatchObject({
      code: 'unsafe_onecli_owner',
    });
    expect(downCalls).toBe(0);
  });
});

type Health = 'healthy' | 'unhealthy' | 'starting';
type ServiceName = 'postgres' | 'app' | 'gateway';

/** An in-memory Docker daemon and OneCLI CLI for one instance's runtime. */
interface DockerWorld {
  readonly services: Map<ServiceName, { running: boolean; health: Health }>;
  /** Containers outside the three services, by ID and as Docker inspects them, until `container rm` removes them. */
  readonly strays: Map<string, unknown>;
  readonly calls: OnecliCommand[];
  /** Health a container takes when `up` (re)creates or starts it. */
  startsAs: Health;
  failUp?: GwsEaError;
  serverVersion: string;
  cliVersion: string;
  /** `onecli version` as printed, instead of an answer built from the versions above. */
  versionOutput?: string;
  /** The image the gateway container runs, instead of the recorded pin. */
  gatewayImage?: string;
  /** The networks the postgres container joins, instead of the backend alone. */
  postgresNetworks?: readonly string[];
}

function containerJson(layout: OnecliRuntimeLayout, service: ServiceName, state: { running: boolean; health: Health }) {
  const published: Record<ServiceName, Record<string, Array<{ HostIp: string; HostPort: string }>>> = {
    postgres: {},
    app: { '10254/tcp': [{ HostIp: '127.0.0.1', HostPort: String(layout.appPort) }] },
    gateway: { '10255/tcp': [{ HostIp: '127.0.0.1', HostPort: String(layout.gatewayPort) }] },
  };
  return {
    Id: `id-${service}`,
    Config: {
      Image: service === 'postgres' ? 'postgres:18-alpine' : `ghcr.io/onecli/onecli:${PINS.gateway}`,
      Labels: {
        'com.docker.compose.project': layout.project,
        'com.docker.compose.service': service,
        'dev.gws-ea.instance-id': INSTANCE_ID,
      },
    },
    State: { Running: state.running, Status: state.running ? 'running' : 'exited', Health: { Status: state.health } },
    NetworkSettings: {
      Ports: state.running ? published[service] : {},
      Networks: Object.fromEntries(
        (service === 'gateway' ? [layout.backendNetwork, layout.agentEgressNetwork] : [layout.backendNetwork]).map(
          (network) => [network, {}],
        ),
      ),
    },
    Mounts: [
      service === 'postgres'
        ? { Type: 'volume', Name: layout.postgresVolume, Destination: '/var/lib/postgresql' }
        : { Type: 'volume', Name: layout.appVolume, Destination: '/app/data' },
    ],
  };
}

function dockerWorld(layout: OnecliRuntimeLayout, initial: Partial<Record<ServiceName, Health | 'stopped'>> = {}) {
  const world: DockerWorld = {
    services: new Map(),
    strays: new Map(),
    calls: [],
    startsAs: 'healthy',
    serverVersion: PINS.gateway,
    cliVersion: PINS.cli,
  };
  for (const [service, state] of Object.entries(initial) as Array<[ServiceName, Health | 'stopped']>) {
    world.services.set(
      service,
      state === 'stopped' ? { running: false, health: 'unhealthy' } : { running: true, health: state },
    );
  }
  const runner: OnecliCommandRunner = async (command) => {
    world.calls.push(command);
    const args = command.args;
    const reply = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' });
    if (command.command === layout.cliExecutable) {
      if (args[0] === 'auth') return reply({ apiKey: ONECLI_API_KEY });
      if (args[0] === 'version') {
        return world.versionOutput === undefined
          ? reply({ version: world.cliVersion, server_version: world.serverVersion })
          : { stdout: world.versionOutput, stderr: '' };
      }
      if (args[0] === 'secrets' && args[1] === 'list') return reply([]);
      if (args[0] === 'secrets' && args[1] === 'create') {
        return reply({ id: 'secret-provider', name: args[args.indexOf('--name') + 1] });
      }
      throw new Error(`unexpected onecli command: ${args.join(' ')}`);
    }
    if (command.command !== 'docker') throw new Error(`unexpected program: ${command.command}`);
    if (args[0] === 'container' && args[1] === 'ls') {
      const ids = [...[...world.services.keys()].map((service) => `id-${service}`), ...world.strays.keys()];
      return { stdout: ids.map((id) => `${id}\n`).join(''), stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      return reply(
        args.slice(2).map((id) => {
          const stray = world.strays.get(id);
          if (stray !== undefined) return stray;
          const service = id.replace(/^id-/u, '') as ServiceName;
          const container = containerJson(layout, service, world.services.get(service)!);
          if (service === 'gateway' && world.gatewayImage !== undefined) container.Config.Image = world.gatewayImage;
          if (service === 'postgres' && world.postgresNetworks !== undefined) {
            container.NetworkSettings.Networks = Object.fromEntries(
              world.postgresNetworks.map((network) => [network, {}]),
            );
          }
          return container;
        }),
      );
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      for (const id of args.slice(3)) world.strays.delete(id);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      return reply([
        {
          Name: layout.backendNetwork,
          Internal: false,
          Labels: { 'dev.gws-ea.instance-id': INSTANCE_ID, 'dev.gws-ea.onecli-role': 'backend' },
        },
        {
          Name: layout.agentEgressNetwork,
          Internal: true,
          Labels: { 'dev.gws-ea.instance-id': INSTANCE_ID, 'dev.gws-ea.onecli-role': 'agent-egress' },
        },
      ]);
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return reply([
        {
          Name: layout.postgresVolume,
          Labels: { 'dev.gws-ea.instance-id': INSTANCE_ID, 'dev.gws-ea.onecli-role': 'postgres-data' },
        },
        {
          Name: layout.appVolume,
          Labels: { 'dev.gws-ea.instance-id': INSTANCE_ID, 'dev.gws-ea.onecli-role': 'app-data' },
        },
      ]);
    }
    if (args[0] === 'run') return { stdout: '', stderr: '' };
    if (args[0] === 'compose' && args.includes('pull')) return { stdout: '', stderr: '' };
    if (args[0] === 'compose' && args.includes('up')) {
      if (world.failUp) throw world.failUp;
      const named = args.slice(args.indexOf('up') + 1).filter((arg) => ['postgres', 'app', 'gateway'].includes(arg));
      for (const service of named.length > 0 ? (named as ServiceName[]) : (['postgres', 'app', 'gateway'] as const)) {
        const current = world.services.get(service);
        const recreate = args.includes('--force-recreate');
        if (!current || !current.running || recreate)
          world.services.set(service, { running: true, health: world.startsAs });
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected docker command: ${args.join(' ')}`);
  };
  return { world, runner };
}

const healthyFetch = () => vi.fn(async (_url: string | URL | Request) => new Response('{}', { status: 200 }));

function composeCalls(world: DockerWorld): string[][] {
  return world.calls
    .filter((call) => call.command === 'docker' && call.args[0] === 'compose')
    .map((call) => call.args.slice(call.args.indexOf(call.args.find((arg) => arg === 'pull' || arg === 'up')!)));
}

describe('OneCLI runtime observation', () => {
  it('is present only while every service is running and healthy with the recorded pins', async () => {
    const layout = await layoutFixture();
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).resolves.toEqual({
      status: 'present',
    });
  });

  it('reports a service that is still starting as unknown, so liveness waits instead of repairing', async () => {
    const layout = await layoutFixture();
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'starting', gateway: 'healthy' });

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).resolves.toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('app'),
    });
  });

  it.each([
    ['a stopped', { postgres: 'healthy', app: 'healthy', gateway: 'stopped' }, /gateway.*stopped/u],
    ['an unhealthy', { postgres: 'unhealthy', app: 'healthy', gateway: 'healthy' }, /postgres.*unhealthy/u],
    ['a missing', { postgres: 'healthy', app: 'healthy' }, /gateway.*missing/u],
    ['no', {}, /not been created/u],
  ] as const)('reports %s container as absent, so liveness repairs it at once', async (_label, services, reason) => {
    const layout = await layoutFixture();
    const { runner } = dockerWorld(layout, services);

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).resolves.toMatchObject({
      status: 'absent',
      reason: expect.stringMatching(reason),
    });
  });

  it('refuses a container in its project that another instance owns', async () => {
    const layout = await layoutFixture();
    const runner: OnecliCommandRunner = async (command) => {
      if (command.args[1] === 'ls') return { stdout: 'id-postgres\n', stderr: '' };
      const foreign = containerJson(layout, 'postgres', { running: true, health: 'healthy' });
      foreign.Config.Labels['dev.gws-ea.instance-id'] = 'another-instance';
      return { stdout: JSON.stringify([foreign]), stderr: '' };
    };

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).rejects.toMatchObject({
      code: 'unsafe_onecli_owner',
    });
  });

  it('refuses a runtime whose gateway is not the only dual-homed service', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    world.postgresNetworks = [layout.backendNetwork, layout.agentEgressNetwork];

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).rejects.toMatchObject({
      code: 'unsafe_onecli_topology',
      message: expect.stringContaining('postgres'),
    });
  });

  it('is unknown, not absent, when Docker does not answer', async () => {
    const layout = await layoutFixture();
    const runner: OnecliCommandRunner = async () => {
      throw new GwsEaError('command_timeout', 'Command timed out after 30.0s: docker container ls');
    };

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).resolves.toMatchObject({
      status: 'unknown',
      evidence: expect.stringContaining('timed out'),
    });
  });
});

describe('OneCLI runtime start and repair', () => {
  it('starts from owner-only material at its own Compose coordinates and Docker endpoint, under separate pull and health timeouts', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);

    await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      runCommand: runner,
      fetch: healthyFetch(),
      ambientEnv: HOSTILE_AMBIENT,
    });

    const project = [
      'compose',
      '--project-name',
      layout.project,
      '--file',
      layout.composeFile,
      '--project-directory',
      layout.rootDirectory,
      '--env-file',
      layout.envFile,
    ];
    expect(world.calls.filter((call) => call.args[0] === 'compose').map(({ args, cwd }) => ({ args, cwd }))).toEqual([
      { args: [...project, 'pull', '--policy', 'missing'], cwd: layout.rootDirectory },
      {
        args: [
          ...project,
          'up',
          '--detach',
          '--wait',
          '--wait-timeout',
          String(ONECLI_WAIT_TIMEOUT_SECONDS),
          '--pull',
          'never',
          '--remove-orphans',
        ],
        cwd: layout.rootDirectory,
      },
    ]);
    const pull = world.calls.find((call) => call.args.includes('pull'))!;
    const up = world.calls.find((call) => call.args.includes('up'))!;
    expect(pull).toMatchObject({ stream: true });
    expect(up.timeoutMs).toBeGreaterThan(ONECLI_WAIT_TIMEOUT_SECONDS * 1_000);
    expect(up.timeoutMs).not.toBe(pull.timeoutMs);
    const docker = world.calls.filter((call) => call.command === 'docker');
    expect(docker.map((call) => call.env)).toEqual(
      docker.map(() => ({ PATH: '/safe/bin', LANG: 'en_US.UTF-8', HOME: '/host/home', DOCKER_HOST: DOCKER_ENDPOINT })),
    );

    for (const file of [
      layout.composeFile,
      layout.envFile,
      layout.postgresPasswordFile,
      layout.encryptionKeyFile,
      layout.gatewayInternalSecretFile,
    ]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect((await stat(layout.rootDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(layout.secretsDirectory)).mode & 0o777).toBe(0o700);
    const compose = await readFile(layout.composeFile, 'utf8');
    const envFile = await readFile(layout.envFile, 'utf8');
    for (const secretFile of [
      layout.postgresPasswordFile,
      layout.encryptionKeyFile,
      layout.gatewayInternalSecretFile,
    ]) {
      const secret = (await readFile(secretFile, 'utf8')).trim();
      expect(secret.length).toBeGreaterThan(30);
      expect(compose).not.toContain(secret);
      expect(envFile).not.toContain(secret);
    }
    expect((await readFile(layout.encryptionKeyFile, 'utf8')).trim()).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(compose).toContain(`ghcr.io/onecli/onecli:${PINS.gateway}`);
  });

  it('removes an owned container of a retired service before starting the runtime', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);
    const postgres = containerJson(layout, 'postgres', { running: false, health: 'unhealthy' });
    const labels = { ...postgres.Config.Labels, 'com.docker.compose.service': 'retired-service' };
    world.strays.set('id-retired', { ...postgres, Id: 'id-retired', Config: { ...postgres.Config, Labels: labels } });

    await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      runCommand: runner,
      fetch: healthyFetch(),
    });

    const commands = world.calls.map((call) => call.args.join(' '));
    const beforeCompose = commands.slice(
      0,
      commands.findIndex((command) => command.startsWith('compose ')),
    );
    expect(beforeCompose).toContain('container rm --force id-retired');
  });

  it('force-recreates only an unhealthy postgres on resume, then continues', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout, { postgres: 'unhealthy', app: 'healthy', gateway: 'healthy' });

    const receipt = await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      runCommand: runner,
      fetch: healthyFetch(),
    });

    const ups = composeCalls(world).filter((args) => args[0] === 'up');
    expect(ups).toEqual([
      [
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        '750',
        '--pull',
        'never',
        '--no-deps',
        '--force-recreate',
        'postgres',
      ],
      ['up', '--detach', '--wait', '--wait-timeout', '750', '--pull', 'never', '--remove-orphans'],
    ]);
    expect(world.services.get('postgres')).toEqual({ running: true, health: 'healthy' });
    const files = {
      runtime: path.join(layout.secretsDirectory, 'rt'),
      admin: path.join(layout.secretsDirectory, 'ad'),
    };
    await persistOnecliApiKeyFiles(receipt, files);
    expect(await readFile(files.admin, 'utf8')).toBe(ONECLI_API_KEY);
  });

  it('names a foreign process holding an allocated OneCLI port when the start fails', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy' });
    world.failUp = new GwsEaError('command_failed', 'Command failed (exit code 1): docker compose up');
    const holders: number[] = [];

    const failure = await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      runCommand: runner,
      fetch: healthyFetch(),
      findPortHolder: async (port) => {
        holders.push(port);
        return port === layout.gatewayPort ? { pid: 5150, command: 'python3' } : undefined;
      },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'port_in_use',
      message: expect.stringContaining(`python3 (pid 5150)`),
    });
    expect((failure as Error).message).toContain(`127.0.0.1:${layout.gatewayPort}`);
    expect((failure as Error).cause).toBe(world.failUp);
    expect(holders.sort()).toEqual([layout.appPort, layout.gatewayPort].sort());
  });
});

describe('OneCLI health and version check', () => {
  it('accepts the runtime at this instance’s recorded pins and imports the provider credential through a CLI aimed only at it', async () => {
    const layout = await layoutFixture();
    await mkdir(layout.secretsDirectory, { recursive: true, mode: 0o700 });
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    const fetch = healthyFetch();

    const receipt = await verifyOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      runCommand: runner,
      fetch,
      ambientEnv: HOSTILE_AMBIENT,
    });
    const imported = await importProviderCredential(
      receipt,
      { name: 'Anthropic', type: 'anthropic', value: 'provider-real-secret', hostPattern: 'api.anthropic.com' },
      { runCommand: runner, ambientEnv: HOSTILE_AMBIENT },
    );

    expect(fetch.mock.calls.map(([url]) => String(url)).sort()).toEqual(
      [`${layout.appUrl}/api/health`, `${layout.appUrl}/v1/health`, `${layout.gatewayUrl}/healthz`].sort(),
    );
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.keys(receipt)).toEqual([]);
    expect(imported).toEqual({ id: 'secret-provider', created: true });
    const cliCalls = world.calls.filter((call) => call.command === layout.cliExecutable);
    expect(cliCalls.slice(0, 2).map((call) => call.args.join(' '))).toEqual(['auth api-key', 'version']);
    // Only the key `auth api-key` returned reaches the CLI; the ambient shell's key, host, and targets never do.
    const [auth, ...keyed] = cliCalls;
    const keyless = { PATH: '/safe/bin', LANG: 'en_US.UTF-8', HOME: layout.cliHome, ONECLI_API_HOST: layout.appUrl };
    expect(auth?.env).toEqual(keyless);
    expect(keyed.map((call) => call.env)).toEqual(keyed.map(() => ({ ...keyless, ONECLI_API_KEY })));
    const create = world.calls.find((call) => call.args[0] === 'secrets' && call.args[1] === 'create')!;
    expect(create.args).toContain('--file');
    expect(create.args).not.toContain('provider-real-secret');
    expect(await stat(layout.providerStagingFile).catch(() => null)).toBeNull();
  });

  it.each([
    ['CLI', { cliVersion: '2.2.5' }, 'incompatible_onecli', /CLI 2\.2\.5.*2\.2\.4/u],
    ['gateway', { serverVersion: '1.42.0' }, 'incompatible_onecli', /gateway 1\.42\.0.*1\.41\.3/u],
    [
      'gateway image',
      { gatewayImage: 'ghcr.io/onecli/onecli:1.42.0' },
      'unsafe_onecli_image',
      /gateway image.*onecli:1\.41\.3/u,
    ],
  ] as const)('refuses a %s that differs from the instance’s recorded pin', async (_label, drift, code, message) => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    Object.assign(world, drift);

    await expect(
      verifyOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, runCommand: runner, fetch: healthyFetch() }),
    ).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
  });

  it('reads the recorded `onecli version` answer, whose gateway reports no version', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    world.versionOutput = RECORDED_ONECLI_VERSION.stdout;
    const dependencies = { dockerCommandRunner: runner, runCommand: runner, fetch: healthyFetch() };

    await expect(verifyOnecliRuntime(layout, { ...PINS, cli: '2.2.5' }, dependencies)).resolves.toBeDefined();
    await expect(verifyOnecliRuntime(layout, PINS, dependencies)).rejects.toMatchObject({
      code: 'incompatible_onecli',
      message: expect.stringMatching(/CLI 2\.2\.5.*2\.2\.4/u),
    });
  });

  it('refuses an unhealthy endpoint before asking the CLI for a key', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/healthz') ? new Response('', { status: 503 }) : new Response('{}', { status: 200 }),
    );

    await expect(
      verifyOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, runCommand: runner, fetch }),
    ).rejects.toMatchObject({ code: 'unhealthy_onecli', message: expect.stringContaining('gateway') });
    expect(world.calls.some((call) => call.command === layout.cliExecutable)).toBe(false);
  });

  it('removes an orphaned plaintext staging file before verifying or importing', async () => {
    const layout = await layoutFixture();
    await mkdir(path.dirname(layout.providerStagingFile), { recursive: true });
    await writeFile(layout.providerStagingFile, 'orphaned-provider-secret', { mode: 0o600 });
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });

    await verifyOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, runCommand: runner, fetch: healthyFetch() });

    expect(await stat(layout.providerStagingFile).catch(() => null)).toBeNull();
  });

  it('refuses to import without a passed health and version check', async () => {
    await expect(
      importProviderCredential(Object.freeze({}) as Parameters<typeof importProviderCredential>[0], {
        name: 'Anthropic',
        type: 'anthropic',
        value: 'provider-real-secret',
        hostPattern: 'api.anthropic.com',
      }),
    ).rejects.toMatchObject({ code: 'onecli_unverified' });
  });
});
