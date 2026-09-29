import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyReleaseGateway,
  importProviderCredential,
  observeOnecliRuntime,
  onecliSecretMatchesCredentialMetadata,
  persistOnecliApiKeyFiles,
  prepareReleaseGatewayImage,
  reconcileOnecliRuntime,
  removeOnecliRuntime,
  verifyOnecliRuntime,
  type OnecliCommand,
  type OnecliCommandRunner,
} from './onecli.js';
import {
  createOnecliRuntimeLayout,
  ONECLI_WAIT_TIMEOUT_SECONDS,
  renderOnecliCompose,
  type OnecliPins,
  type OnecliRuntimeLayout,
} from './onecli-compose.js';
import { computeWrapperImageHash, wrapperImageTag } from './onecli-gateway-image.js';
import { RECORDED_ONECLI_VERSION } from './fixtures/recordings.js';
import { GwsEaError } from './types.js';

const INSTANCE_ID = '12345678-1234-4123-8123-123456789abc';
const ONECLI_API_KEY = `oc_${'a'.repeat(64)}`;
const DOCKER_ENDPOINT = 'unix:///Users/operator/.docker/run/docker.sock';
/** The pins this instance's release recorded, deliberately not this launcher's. */
const PINS: OnecliPins = { gateway: '1.41.3', cli: '2.2.4' };
/** The content-addressed wrapper gateway image the launcher builds for these pins (real in-tree source). */
const WRAPPER_HASH = await computeWrapperImageHash(PINS);
const GATEWAY_IMAGE = wrapperImageTag(WRAPPER_HASH);
/**
 * The wrapper gateway an earlier release built from other firewall files, and
 * the Postgres image it pinned: an instance it created runs these, never what
 * this tool's tree would build.
 */
const RELEASE_WRAPPER_HASH = '0123456789abcdef';
const RELEASE_GATEWAY_IMAGE = wrapperImageTag(RELEASE_WRAPPER_HASH);
const RELEASE_POSTGRES_IMAGE = 'postgres:17-alpine';
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

/** The instance's own Compose file, as the release that created it rendered it; `edit` rewrites the source. */
async function writeInstanceCompose(
  layout: OnecliRuntimeLayout,
  gatewayImage: string = GATEWAY_IMAGE,
  edit: (source: string) => string = (source) => source,
): Promise<string> {
  const source = edit(renderOnecliCompose(layout, PINS, gatewayImage));
  await mkdir(layout.rootDirectory, { recursive: true, mode: 0o700 });
  await writeFile(layout.composeFile, source, { mode: 0o600 });
  return source;
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
  /** The image the postgres container runs, instead of this tool's. */
  postgresImage?: string;
  /** The networks the postgres container joins, instead of the backend alone. */
  postgresNetworks?: readonly string[];
  /** When set, the wrapper image existence probe reports it missing so reconcile builds it. */
  wrapperImageMissing?: boolean;
  /** Set true when the wrapper image build ran. */
  builtImage?: boolean;
  /** When set, the wrapper image build fails with this error. */
  failBuild?: GwsEaError;
  /** Each local wrapper image's provenance label, as its build stamped it. */
  readonly provenance: Map<string, string>;
  /** When set, the provenance-label read returns this instead of the image's own label. */
  wrongProvenance?: string;
  /** When set, the isolation probe (`docker run`) fails with this error, standing in for a detected leak. */
  failProbe?: GwsEaError;
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
      Image:
        service === 'postgres'
          ? 'postgres:18-alpine'
          : service === 'gateway'
            ? GATEWAY_IMAGE
            : `ghcr.io/onecli/onecli:${PINS.gateway}`,
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
    provenance: new Map([
      [GATEWAY_IMAGE, WRAPPER_HASH],
      [RELEASE_GATEWAY_IMAGE, RELEASE_WRAPPER_HASH],
    ]),
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
          if (service === 'postgres' && world.postgresImage !== undefined) container.Config.Image = world.postgresImage;
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
    if (args[0] === 'run') {
      if (world.failProbe) throw world.failProbe;
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'build') {
      if (world.failBuild) throw world.failBuild;
      world.builtImage = true;
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'ls') {
      // Existence probe (reconcile): image id when present, empty when a test says it is missing.
      return { stdout: world.wrapperImageMissing ? '' : 'sha256:deadbeef\n', stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      // Provenance-label read: the label the image's build stamped.
      if (args.includes('--format')) {
        return { stdout: `${world.wrongProvenance ?? world.provenance.get(args[2]!) ?? ''}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
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
    await writeInstanceCompose(layout);
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).resolves.toEqual({
      status: 'present',
    });
  });

  it('expects the images its own Compose file names, not the gateway this tool would build', async () => {
    const layout = await layoutFixture();
    // An earlier release built this gateway from other firewall files and pinned another Postgres.
    await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE, (source) =>
      source.replace('postgres:18-alpine', RELEASE_POSTGRES_IMAGE),
    );
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    world.gatewayImage = RELEASE_GATEWAY_IMAGE;
    world.postgresImage = RELEASE_POSTGRES_IMAGE;
    const dependencies = { dockerCommandRunner: runner, runCommand: runner, fetch: healthyFetch() };

    expect(RELEASE_GATEWAY_IMAGE).not.toBe(GATEWAY_IMAGE);
    await expect(observeOnecliRuntime(layout, PINS, dependencies)).resolves.toEqual({ status: 'present' });
    await expect(verifyOnecliRuntime(layout, PINS, dependencies)).resolves.toBeDefined();
    const provenanceReads = world.calls.filter((call) => call.args[0] === 'image' && call.args[1] === 'inspect');
    expect(provenanceReads.map((call) => call.args[2])).toEqual([RELEASE_GATEWAY_IMAGE, RELEASE_GATEWAY_IMAGE]);
    expect(world.calls.some((call) => call.args[0] === 'build')).toBe(false);
  });

  it('refuses a gateway whose provenance label does not match its Compose tag', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    world.gatewayImage = RELEASE_GATEWAY_IMAGE;
    // This tool's own build content, re-tagged as the release's gateway.
    world.provenance.set(RELEASE_GATEWAY_IMAGE, WRAPPER_HASH);

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).rejects.toMatchObject({
      code: 'unsafe_onecli_image',
      message: expect.stringMatching(/provenance label/u),
    });
  });

  it('refuses a Compose file whose app does not run the OneCLI its release pinned', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout, GATEWAY_IMAGE, (source) =>
      source.replace(`ghcr.io/onecli/onecli:${PINS.gateway}`, 'ghcr.io/onecli/onecli:1.42.0'),
    );
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).rejects.toMatchObject({
      code: 'invalid_onecli_runtime',
      message: expect.stringMatching(/1\.42\.0.*1\.41\.3/u),
    });
  });

  it('finds a running runtime without its Compose file absent, so it is set up again', async () => {
    const layout = await layoutFixture();
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).resolves.toEqual({
      status: 'absent',
      reason: 'its Compose file is missing',
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
    await writeInstanceCompose(layout);
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
      { args: [...project, 'pull', '--policy', 'missing', 'postgres', 'app'], cwd: layout.rootDirectory },
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
    // A new instance runs the release this tool deploys: its pinned base and the gateway this tree builds.
    expect(compose).toBe(renderOnecliCompose(layout, PINS, GATEWAY_IMAGE));
  });

  it('keeps an existing Compose file byte-identical and starts the gateway it names, never the one this tool builds', async () => {
    const layout = await layoutFixture();
    const written = await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'stopped' });
    world.gatewayImage = RELEASE_GATEWAY_IMAGE;

    await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      runCommand: runner,
      fetch: healthyFetch(),
    });

    expect(await readFile(layout.composeFile, 'utf8')).toBe(written);
    expect(world.calls.find((call) => call.args[0] === 'image' && call.args[1] === 'ls')?.args).toEqual([
      'image',
      'ls',
      '--quiet',
      RELEASE_GATEWAY_IMAGE,
    ]);
    expect(world.builtImage).toBeUndefined();
    expect(world.services.get('gateway')).toEqual({ running: true, health: 'healthy' });
  });

  it('refuses to build a missing gateway image its Compose file names but this tool does not build', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout);
    world.wrapperImageMissing = true;

    await expect(
      reconcileOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, runCommand: runner, fetch: healthyFetch() }),
    ).rejects.toMatchObject({
      code: 'onecli_gateway_image_missing',
      message: expect.stringContaining(RELEASE_GATEWAY_IMAGE),
    });
    expect(world.calls.some((call) => call.args[0] === 'build' || call.args.includes('up'))).toBe(false);
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

  it('builds the content-addressed wrapper gateway image when absent, from the pinned base', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);
    world.wrapperImageMissing = true;

    await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      runCommand: runner,
      fetch: healthyFetch(),
    });

    expect(world.builtImage).toBe(true);
    const build = world.calls.find((call) => call.args[0] === 'build')!;
    expect(build.args).toContain(GATEWAY_IMAGE);
    expect(build.args.join(' ')).toContain(`ONECLI_BASE=ghcr.io/onecli/onecli:${PINS.gateway}`);
    expect(build.args.join(' ')).toContain(`GATEWAY_WRAPPER_HASH=${WRAPPER_HASH}`);
    // The pull (which fetches the base via the app image) precedes the build, so the
    // base is local before `FROM`; the pull is scoped to postgres+app so the
    // local-only wrapper tag is never fetched from a registry.
    const buildIndex = world.calls.findIndex((call) => call.args[0] === 'build');
    const pullIndex = world.calls.findIndex((call) => call.args.includes('pull'));
    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeLessThan(buildIndex);
  });

  it('aborts the reconcile and starts nothing when the wrapper image build fails', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);
    world.wrapperImageMissing = true;
    world.failBuild = new GwsEaError('command_failed', 'docker build failed');

    await expect(
      reconcileOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, runCommand: runner, fetch: healthyFetch() }),
    ).rejects.toMatchObject({ code: 'command_failed' });
    // A failed build must abort before compose brings anything up.
    expect(world.calls.some((call) => call.args.includes('up'))).toBe(false);
  });

  it('reuses the present wrapper image instead of rebuilding it', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);

    await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      runCommand: runner,
      fetch: healthyFetch(),
    });

    expect(world.builtImage).toBeUndefined();
    expect(world.calls.some((call) => call.args[0] === 'build')).toBe(false);
  });

  it('probes agent egress through the gateway on the internal network during reconcile', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);

    await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      runCommand: runner,
      fetch: healthyFetch(),
    });

    const probe = world.calls.find((call) => call.args[0] === 'run')!;
    expect(probe.args).toContain(layout.agentEgressNetwork);
    expect(probe.args).toContain('--rm');
    // The probe is a throwaway agent-like container: the base image, entrypoint node.
    expect(probe.args).toContain('--entrypoint');
    expect(probe.args).toContain('node');
    expect(probe.args).toContain(`ghcr.io/onecli/onecli:${PINS.gateway}`);
  });

  it('fails the reconcile closed when the agent-egress isolation probe reports a leak', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);
    // The probe (docker run of the isolation script) exits non-zero -> a leak was found.
    world.failProbe = new GwsEaError('command_failed', 'own app admin API reachable through gateway');

    await expect(
      reconcileOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, runCommand: runner, fetch: healthyFetch() }),
    ).rejects.toMatchObject({ code: 'command_failed' });
  });

  it('refuses a gateway image whose provenance label does not match its build content', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    world.wrongProvenance = 'stale0000feedface';

    await expect(
      verifyOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, runCommand: runner, fetch: healthyFetch() }),
    ).rejects.toMatchObject({ code: 'unsafe_onecli_image', message: expect.stringMatching(/provenance label/u) });
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

describe("an update's gateway image", () => {
  it('builds the release gateway before the stop when its tag differs, and leaves the running runtime alone', async () => {
    const layout = await layoutFixture();
    const written = await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    world.wrapperImageMissing = true;

    await expect(
      prepareReleaseGatewayImage(layout, PINS, { dockerCommandRunner: runner, ambientEnv: HOSTILE_AMBIENT }),
    ).resolves.toEqual({ current: RELEASE_GATEWAY_IMAGE, release: GATEWAY_IMAGE });

    const build = world.calls.find((call) => call.args[0] === 'build')!;
    expect(build.args).toContain(GATEWAY_IMAGE);
    expect(build.env?.DOCKER_HOST).toBe(DOCKER_ENDPOINT);
    // Only the image is built: the Compose file and every container stay as they are until the cutover.
    expect(await readFile(layout.composeFile, 'utf8')).toBe(written);
    expect(world.calls.map((call) => call.args.slice(0, 2).join(' '))).toEqual(['image ls', 'build --build-arg']);
  });

  it('reuses a release gateway image another assistant already built', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout);

    await expect(prepareReleaseGatewayImage(layout, PINS, { dockerCommandRunner: runner })).resolves.toEqual({
      current: RELEASE_GATEWAY_IMAGE,
      release: GATEWAY_IMAGE,
    });

    expect(world.calls.some((call) => call.args[0] === 'build')).toBe(false);
  });

  it('moves the assistant to the release gateway at the cutover: Compose file re-rendered, only the gateway recreated', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });

    await applyReleaseGateway(layout, PINS, { dockerCommandRunner: runner, ambientEnv: HOSTILE_AMBIENT });

    const compose = await readFile(layout.composeFile, 'utf8');
    expect(compose).toBe(renderOnecliCompose(layout, PINS, GATEWAY_IMAGE));
    expect((await stat(layout.composeFile)).mode & 0o777).toBe(0o600);
    // Only the gateway: no pull, no Postgres or app recreate, and nothing that removes a volume.
    expect(composeCalls(world)).toEqual([
      [
        'up',
        '--detach',
        '--wait',
        '--wait-timeout',
        String(ONECLI_WAIT_TIMEOUT_SECONDS),
        '--pull',
        'never',
        '--no-deps',
        'gateway',
      ],
    ]);
    expect(world.calls.flatMap((call) => call.args)).not.toContain('down');
    expect(world.calls.every((call) => call.env?.DOCKER_HOST === DOCKER_ENDPOINT)).toBe(true);

    // Run again after an interruption, it converges without rendering anything new.
    await applyReleaseGateway(layout, PINS, { dockerCommandRunner: runner });
    expect(await readFile(layout.composeFile, 'utf8')).toBe(compose);
  });

  it('touches Docker not at all when the release runs the gateway the assistant already runs', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout, GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout);

    await expect(prepareReleaseGatewayImage(layout, PINS, { dockerCommandRunner: runner })).resolves.toEqual({
      current: GATEWAY_IMAGE,
      release: GATEWAY_IMAGE,
    });

    expect(world.calls).toEqual([]);
  });
});

describe('OneCLI health and version check', () => {
  it('accepts the runtime at this instance’s recorded pins and imports the provider credential through a CLI aimed only at it', async () => {
    const layout = await layoutFixture();
    await mkdir(layout.secretsDirectory, { recursive: true, mode: 0o700 });
    await writeInstanceCompose(layout);
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
      /gateway image.*gws-ea-onecli-gateway/u,
    ],
  ] as const)('refuses a %s that differs from the instance’s recorded pin', async (_label, drift, code, message) => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    Object.assign(world, drift);

    await expect(
      verifyOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, runCommand: runner, fetch: healthyFetch() }),
    ).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
  });

  it('reads the recorded `onecli version` answer, whose gateway reports no version', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
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
    await writeInstanceCompose(layout);
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
    await writeInstanceCompose(layout);
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
