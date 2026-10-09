import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  restoreReleaseGateway,
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
import { GwsEaError } from './types.js';

const INSTANCE_ID = '12345678-1234-4123-8123-123456789abc';
const ONECLI_API_KEY = `oc_${'a'.repeat(64)}`;
const DOCKER_ENDPOINT = 'unix:///Users/operator/.docker/run/docker.sock';
/** The pins this instance's release recorded, deliberately not this launcher's. */
const PINS: OnecliPins = { gateway: '1.41.3' };
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
/** An operator shell that points Docker and Compose at another runtime. */
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

  it.each([
    ['header', { headerName: 'x-api-key' }, { headerName: 'x-api-key', valueFormat: '{value}' }],
    ['query parameter', { paramName: 'key' }, { paramName: 'key', paramFormat: '{value}' }],
  ])(
    'matches a %s secret OneCLI stored with its default format to metadata that names none',
    (_kind, named, stored) => {
      const expected = { name: 'Search', type: 'generic', hostPattern: 'api.search.example.test', ...named };
      const observed = {
        id: 'search-secret-id',
        name: 'Search',
        type: 'generic',
        hostPattern: 'api.search.example.test',
        pathPattern: null,
        injectionConfig: stored,
      };

      expect(onecliSecretMatchesCredentialMetadata(observed, expected)).toBe(true);
    },
  );
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
        // By the project's name alone: Compose finds what to remove by its labels, wherever its file now is.
        expect(command.args).toEqual([
          'compose',
          '--project-name',
          layout.project,
          'down',
          '--volumes',
          '--remove-orphans',
        ]);
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
const SERVICES = ['postgres', 'app', 'gateway'] as const;

/** One service's container: each one Compose (re)creates has a new ID and the config hash it was created from. */
interface FakeContainer {
  readonly id: string;
  readonly running: boolean;
  readonly health: Health;
  readonly configHash: string;
}

interface InspectedNetwork {
  readonly Name: string;
  Internal: boolean;
  readonly Labels: Record<string, string>;
}

interface InspectedVolume {
  readonly Name: string;
  readonly Labels: Record<string, string>;
}

/** An in-memory Docker daemon for one instance's runtime. */
interface DockerWorld {
  readonly services: Map<ServiceName, FakeContainer>;
  /** Containers outside the three services, by ID and as Docker inspects them, until `container rm` removes them. */
  readonly strays: Map<string, unknown>;
  readonly calls: OnecliCommand[];
  /** Health a container takes when `up` (re)creates or starts it. */
  startsAs: Health;
  failUp?: GwsEaError;
  /** When set, the wrapper image existence probe reports it missing so reconcile builds it. */
  wrapperImageMissing?: boolean;
  /** Set true when the wrapper image build ran. */
  builtImage?: boolean;
  /** When set, the wrapper image build fails with this error. */
  failBuild?: GwsEaError;
  /** Each local wrapper image's provenance label, as its build stamped it. */
  readonly provenance: Map<string, string>;
  /** When set, the isolation probe (`docker run`) fails with this error, standing in for a detected leak. */
  failProbe?: GwsEaError;
  /** The instance's networks and volumes, as Docker inspects them. */
  readonly networks: InspectedNetwork[];
  readonly volumes: InspectedVolume[];
}

/**
 * Compose's per-service configuration hash, as `config --hash` prints it and
 * `up` labels each container it creates: any change to a service's definition
 * changes it.
 */
function composeHashes(source: string): Record<ServiceName, string> {
  const { services } = parseYaml(source) as { services: Record<ServiceName, unknown> };
  const hash = (service: ServiceName) => createHash('sha256').update(JSON.stringify(services[service])).digest('hex');
  return { postgres: hash('postgres'), app: hash('app'), gateway: hash('gateway') };
}

function containerJson(layout: OnecliRuntimeLayout, service: ServiceName, container: FakeContainer) {
  const published: Record<ServiceName, Record<string, Array<{ HostIp: string; HostPort: string }>>> = {
    postgres: {},
    app: { '10254/tcp': [{ HostIp: '127.0.0.1', HostPort: String(layout.appPort) }] },
    gateway: { '10255/tcp': [{ HostIp: '127.0.0.1', HostPort: String(layout.gatewayPort) }] },
  };
  return {
    Id: container.id,
    Config: {
      Labels: {
        'com.docker.compose.project': layout.project,
        'com.docker.compose.service': service,
        'com.docker.compose.config-hash': container.configHash,
        'dev.gws-ea.instance-id': INSTANCE_ID,
      },
    },
    State: {
      Running: container.running,
      Status: container.running ? 'running' : 'exited',
      Health: { Status: container.health },
    },
    NetworkSettings: { Ports: container.running ? published[service] : {} },
  };
}

/** `deployed` is the Compose file the seeded containers were created from. */
function dockerWorld(
  layout: OnecliRuntimeLayout,
  initial: Partial<Record<ServiceName, Health | 'stopped'>> = {},
  deployed: string = renderOnecliCompose(layout, PINS, GATEWAY_IMAGE),
) {
  const labels = (role: string) => ({ 'dev.gws-ea.instance-id': INSTANCE_ID, 'dev.gws-ea.onecli-role': role });
  const world: DockerWorld = {
    services: new Map(),
    strays: new Map(),
    calls: [],
    startsAs: 'healthy',
    provenance: new Map([
      [GATEWAY_IMAGE, WRAPPER_HASH],
      [RELEASE_GATEWAY_IMAGE, RELEASE_WRAPPER_HASH],
    ]),
    networks: [
      { Name: layout.backendNetwork, Internal: false, Labels: labels('backend') },
      { Name: layout.agentEgressNetwork, Internal: true, Labels: labels('agent-egress') },
    ],
    volumes: [
      { Name: layout.postgresVolume, Labels: labels('postgres-data') },
      { Name: layout.appVolume, Labels: labels('app-data') },
    ],
  };
  let created = 0;
  const create = (service: ServiceName, health: Health, configHash: string): FakeContainer => {
    created += 1;
    return { id: `id-${service}-${created}`, running: true, health, configHash };
  };
  const seeded = composeHashes(deployed);
  for (const [service, state] of Object.entries(initial) as Array<[ServiceName, Health | 'stopped']>) {
    const container = create(service, state === 'stopped' ? 'unhealthy' : state, seeded[service]);
    world.services.set(service, state === 'stopped' ? { ...container, running: false } : container);
  }
  const fileHashes = async () => composeHashes(await readFile(layout.composeFile, 'utf8'));
  const runner: OnecliCommandRunner = async (command) => {
    world.calls.push(command);
    const args = command.args;
    const reply = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' });
    if (command.command !== 'docker') throw new Error(`unexpected program: ${command.command}`);
    if (args[0] === 'container' && args[1] === 'ls') {
      const ids = [...[...world.services.values()].map((container) => container.id), ...world.strays.keys()];
      return { stdout: ids.map((id) => `${id}\n`).join(''), stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      return reply(
        args.slice(2).map((id) => {
          const stray = world.strays.get(id);
          if (stray !== undefined) return stray;
          const [service, container] = [...world.services].find(([, candidate]) => candidate.id === id)!;
          return containerJson(layout, service, container);
        }),
      );
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      for (const id of args.slice(3)) world.strays.delete(id);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'network' && args[1] === 'inspect') return reply(world.networks);
    if (args[0] === 'volume' && args[1] === 'inspect') return reply(world.volumes);
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
      // Provenance-label read: the label the image's build stamped, as Docker's template prints a missing one.
      return { stdout: `${world.provenance.get(args[2]!) ?? '<no value>'}\n`, stderr: '' };
    }
    if (args[0] === 'compose' && args.includes('pull')) return { stdout: '', stderr: '' };
    if (args[0] === 'compose' && args.includes('config')) {
      const hashes = await fileHashes();
      return {
        stdout: [...SERVICES]
          .sort()
          .map((service) => `${service} ${hashes[service]}\n`)
          .join(''),
        stderr: '',
      };
    }
    if (args[0] === 'compose' && args.includes('up')) {
      if (world.failUp) throw world.failUp;
      const hashes = await fileHashes();
      const named = SERVICES.filter((service) => args.slice(args.indexOf('up') + 1).includes(service));
      for (const service of named.length > 0 ? named : SERVICES) {
        const current = world.services.get(service);
        // Compose recreates a container whose service's config hash changed, and only starts a stopped one.
        if (!current || args.includes('--force-recreate') || current.configHash !== hashes[service]) {
          world.services.set(service, create(service, world.startsAs, hashes[service]));
        } else if (!current.running) {
          world.services.set(service, { ...current, running: true, health: world.startsAs });
        }
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected docker command: ${args.join(' ')}`);
  };
  return { world, runner };
}

/** The isolation probes the runtime ran: throwaway agent containers on its agent-egress network. */
function probes(world: DockerWorld): OnecliCommand[] {
  return world.calls.filter((call) => call.args[0] === 'run');
}

/** Each service's container ID, which Compose changes only by recreating it. */
function containerIds(world: DockerWorld): Partial<Record<ServiceName, string>> {
  return Object.fromEntries([...world.services].map(([service, container]) => [service, container.id]));
}

/** OneCLI's health endpoints, all healthy, and the local API key it hands a keyless caller. */
const healthyFetch = () =>
  vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/v1/user/api-key') ? Response.json({ apiKey: ONECLI_API_KEY }) : Response.json({}),
  );

interface OnecliRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown> | undefined;
}

/** OneCLI's app behind `fetch`: healthy, handing out one local API key, and holding `secrets`. */
function onecliApp(layout: OnecliRuntimeLayout, secrets: Record<string, unknown>[] = []) {
  const requests: OnecliRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ method, url, authorization: new Headers(init?.headers).get('authorization'), body });
    if (url === `${layout.appUrl}/v1/user/api-key`) return Response.json({ apiKey: ONECLI_API_KEY });
    if (url === `${layout.appUrl}/v1/secrets` && method === 'GET') return Response.json(secrets);
    if (url === `${layout.appUrl}/v1/secrets` && method === 'POST') {
      const { value, ...metadata } = body ?? {};
      secrets.push({ id: 'secret-provider', ...metadata });
      return Response.json({ id: 'secret-provider', preview: `${String(value).slice(0, 4)}••••` }, { status: 201 });
    }
    return Response.json({});
  });
  return { fetch, requests };
}

/** Every file beneath `root`, with its contents. */
async function filesBeneath(root: string): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      files.set(file, await readFile(file, 'utf8'));
    }
  }
  return files;
}

/** Every Compose command runs against the instance's own project, file, directory and env file. */
function composeProject(layout: OnecliRuntimeLayout): string[] {
  return [
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
}

/** The Compose subcommands the runtime ran, after its project arguments. */
function composeCalls(world: DockerWorld): string[][] {
  return world.calls
    .filter((call) => call.command === 'docker' && call.args[0] === 'compose')
    .map((call) => call.args.slice(call.args.indexOf('--env-file') + 2));
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
    const written = await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE, (source) =>
      source.replace('postgres:18-alpine', RELEASE_POSTGRES_IMAGE),
    );
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' }, written);
    const dependencies = { dockerCommandRunner: runner, fetch: healthyFetch() };

    expect(RELEASE_GATEWAY_IMAGE).not.toBe(GATEWAY_IMAGE);
    await expect(observeOnecliRuntime(layout, PINS, dependencies)).resolves.toEqual({ status: 'present' });
    await expect(verifyOnecliRuntime(layout, PINS, dependencies)).resolves.toBeDefined();
    const provenanceReads = world.calls.filter((call) => call.args[0] === 'image' && call.args[1] === 'inspect');
    expect(provenanceReads.map((call) => call.args[2])).toEqual([RELEASE_GATEWAY_IMAGE, RELEASE_GATEWAY_IMAGE]);
    expect(world.calls.some((call) => call.args[0] === 'build')).toBe(false);
  });

  it('refuses a gateway whose provenance label does not match its Compose tag', async () => {
    const layout = await layoutFixture();
    const written = await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' }, written);
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

  it('reports a running runtime whose Compose file is missing as absent, so it is set up again', async () => {
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
      const foreign = containerJson(layout, 'postgres', {
        id: 'id-postgres',
        running: true,
        health: 'healthy',
        configHash: 'f'.repeat(64),
      });
      foreign.Config.Labels['dev.gws-ea.instance-id'] = 'another-instance';
      return { stdout: JSON.stringify([foreign]), stderr: '' };
    };

    await expect(observeOnecliRuntime(layout, PINS, { dockerCommandRunner: runner })).rejects.toMatchObject({
      code: 'unsafe_onecli_owner',
    });
  });

  it("matches an unchanged project's config hash through its own Compose invocation, and recreates nothing", async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    const running = containerIds(world);
    const dependencies = { dockerCommandRunner: runner, fetch: healthyFetch(), ambientEnv: HOSTILE_AMBIENT };

    await expect(observeOnecliRuntime(layout, PINS, dependencies)).resolves.toEqual({ status: 'present' });
    await reconcileOnecliRuntime(layout, PINS, dependencies);

    expect(containerIds(world)).toEqual(running);
    // Hashed for the same resolved project `up` creates from, through the instance's Docker endpoint alone.
    const hashing = world.calls.filter((call) => call.args.includes('--hash'));
    expect(hashing.map(({ args, cwd, env }) => ({ args, cwd, env }))).toEqual(
      [1, 2].map(() => ({
        args: [...composeProject(layout), 'config', '--hash', '*'],
        cwd: layout.rootDirectory,
        env: { PATH: '/safe/bin', LANG: 'en_US.UTF-8', HOME: '/host/home', DOCKER_HOST: DOCKER_ENDPOINT },
      })),
    );
  });

  it('treats a container whose Compose file changed since as absent, and recreates only it, keeping every volume', async () => {
    const layout = await layoutFixture();
    const current = await writeInstanceCompose(layout);
    // The app container was created while the Compose file published another port.
    const created = current.replace(`127.0.0.1:${layout.appPort}:10254`, '127.0.0.1:31009:10254');
    expect(created).not.toBe(current);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' }, created);
    const { app, ...unchanged } = containerIds(world);
    const dependencies = { dockerCommandRunner: runner, fetch: healthyFetch() };

    await expect(observeOnecliRuntime(layout, PINS, dependencies)).resolves.toEqual({
      status: 'absent',
      reason: expect.stringMatching(/^the app container /u),
    });
    await reconcileOnecliRuntime(layout, PINS, dependencies);

    const { app: recreated, ...after } = containerIds(world);
    expect(recreated).not.toBe(app);
    expect(after).toEqual(unchanged);
    // Compose's own `up` recreated it: nothing removed a container's volumes or a named volume.
    const args = world.calls.flatMap((call) => call.args);
    for (const removal of ['down', 'rm', '--volumes', '-v', '--renew-anon-volumes', '-V']) {
      expect(args).not.toContain(removal);
    }
    // The recreated runtime was probed before the receipt was issued.
    const up = world.calls.findIndex((call) => call.args.includes('up'));
    expect(world.calls.indexOf(probes(world)[0]!)).toBeGreaterThan(up);
    await expect(observeOnecliRuntime(layout, PINS, dependencies)).resolves.toEqual({ status: 'present' });
  });

  it.each([
    [
      'an agent-egress network that is not internal',
      (world: DockerWorld) => {
        world.networks[1]!.Internal = false;
      },
      'unsafe_onecli_topology',
    ],
    [
      'a network labelled for another role',
      (world: DockerWorld) => {
        world.networks[0]!.Labels['dev.gws-ea.onecli-role'] = 'agent-egress';
      },
      'unsafe_onecli_topology',
    ],
    [
      'a volume another instance owns',
      (world: DockerWorld) => {
        world.volumes[0]!.Labels['dev.gws-ea.instance-id'] = 'another-instance';
      },
      'unsafe_onecli_owner',
    ],
    [
      'an inspection without one of its volumes',
      (world: DockerWorld) => {
        world.volumes.pop();
      },
      'invalid_onecli_runtime',
    ],
  ] as const)('refuses %s, which no config hash covers, before probing it', async (_case, drift, code) => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    drift(world);
    const dependencies = { dockerCommandRunner: runner, fetch: healthyFetch() };

    await expect(observeOnecliRuntime(layout, PINS, dependencies)).rejects.toMatchObject({ code });
    await expect(verifyOnecliRuntime(layout, PINS, dependencies)).rejects.toMatchObject({ code });
    expect(probes(world)).toEqual([]);
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
      fetch: healthyFetch(),
      ambientEnv: HOSTILE_AMBIENT,
    });

    const project = composeProject(layout);
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
      { args: [...project, 'config', '--hash', '*'], cwd: layout.rootDirectory },
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
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'stopped' }, written);

    await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
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
    expect(world.services.get('gateway')).toMatchObject({ running: true, health: 'healthy' });
  });

  it('refuses to build a missing gateway image its Compose file names but this tool does not build', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout);
    world.wrapperImageMissing = true;

    await expect(
      reconcileOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, fetch: healthyFetch() }),
    ).rejects.toMatchObject({
      code: 'onecli_gateway_image_missing',
      message: expect.stringContaining(RELEASE_GATEWAY_IMAGE),
    });
    expect(world.calls.some((call) => call.args[0] === 'build' || call.args.includes('up'))).toBe(false);
  });

  it('removes an owned container of a retired service before starting the runtime', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);
    const postgres = containerJson(layout, 'postgres', {
      id: 'id-retired',
      running: false,
      health: 'unhealthy',
      configHash: 'f'.repeat(64),
    });
    const labels = { ...postgres.Config.Labels, 'com.docker.compose.service': 'retired-service' };
    world.strays.set('id-retired', { ...postgres, Id: 'id-retired', Config: { ...postgres.Config, Labels: labels } });

    await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
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
      reconcileOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, fetch: healthyFetch() }),
    ).rejects.toMatchObject({ code: 'command_failed' });
    // A failed build must abort before compose brings anything up.
    expect(world.calls.some((call) => call.args.includes('up'))).toBe(false);
  });

  it('reuses the present wrapper image instead of rebuilding it', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);

    await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
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

  it('probes again when a create whose isolation probe failed resumes, and refuses again', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout);
    // The probe (docker run of the isolation script) exits non-zero: a leak was found.
    world.failProbe = new GwsEaError('command_failed', 'own app admin API reachable through gateway');
    const dependencies = { dockerCommandRunner: runner, fetch: healthyFetch() };

    await expect(reconcileOnecliRuntime(layout, PINS, dependencies)).rejects.toBe(world.failProbe);
    const created = containerIds(world);
    // No receipt kept its API key files, so the resumed create starts the vault again, or its provider step checks it.
    await expect(reconcileOnecliRuntime(layout, PINS, dependencies)).rejects.toBe(world.failProbe);
    await expect(verifyOnecliRuntime(layout, PINS, dependencies)).rejects.toBe(world.failProbe);

    expect(containerIds(world)).toEqual(created);
    expect(probes(world)).toHaveLength(3);
  });

  it.each([
    ['does not match its build content', 'stale0000feedface'],
    ['is missing', undefined],
  ])('refuses a gateway image whose provenance label %s', async (_case, label) => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    if (label === undefined) world.provenance.delete(GATEWAY_IMAGE);
    else world.provenance.set(GATEWAY_IMAGE, label);
    const dependencies = { dockerCommandRunner: runner, fetch: healthyFetch() };
    const refusal = { code: 'unsafe_onecli_image', message: expect.stringMatching(/provenance label/u) };

    await expect(observeOnecliRuntime(layout, PINS, dependencies)).rejects.toMatchObject(refusal);
    await expect(verifyOnecliRuntime(layout, PINS, dependencies)).rejects.toMatchObject(refusal);
    expect(probes(world)).toEqual([]);
  });

  it('force-recreates only an unhealthy postgres on resume, then continues', async () => {
    const layout = await layoutFixture();
    const { world, runner } = dockerWorld(layout, { postgres: 'unhealthy', app: 'healthy', gateway: 'healthy' });

    const receipt = await reconcileOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
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
    expect(world.services.get('postgres')).toMatchObject({ running: true, health: 'healthy' });
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

  it('puts a kept Compose file back and brings the whole project up from it, converging when rerun', async () => {
    const layout = await layoutFixture();
    const running = await writeInstanceCompose(layout, GATEWAY_IMAGE);
    const kept = renderOnecliCompose(layout, PINS, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });

    await restoreReleaseGateway(
      layout,
      PINS,
      { compose: kept, left: running },
      { dockerCommandRunner: runner, ambientEnv: HOSTILE_AMBIENT },
    );

    expect(await readFile(layout.composeFile, 'utf8')).toBe(kept);
    expect((await stat(layout.composeFile)).mode & 0o777).toBe(0o600);
    // The kept image is present: nothing is built or pulled, and Compose brings every service to the file.
    expect(world.calls.some((call) => call.args[0] === 'build')).toBe(false);
    expect(composeCalls(world)).toEqual([
      ['up', '--detach', '--wait', '--wait-timeout', String(ONECLI_WAIT_TIMEOUT_SECONDS), '--pull', 'never'],
    ]);
    expect(world.calls.every((call) => call.env?.DOCKER_HOST === DOCKER_ENDPOINT)).toBe(true);

    await restoreReleaseGateway(layout, PINS, { compose: kept, left: running }, { dockerCommandRunner: runner });
    expect(await readFile(layout.composeFile, 'utf8')).toBe(kept);
  });

  it('recreates the app a release renders differently, keeping its volumes, so the runtime verifies on its file', async () => {
    const layout = await layoutFixture();
    const running = await writeInstanceCompose(layout);
    const rendered = parseYaml(running) as { services: { app: { environment: Record<string, string> } } };
    rendered.services.app.environment.LOG_LEVEL = 'warn';
    const kept = stringifyYaml(rendered);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' }, running);
    const { app, ...unchanged } = containerIds(world);
    const volumes = structuredClone(world.volumes);
    const dependencies = { dockerCommandRunner: runner, fetch: healthyFetch() };

    await restoreReleaseGateway(layout, PINS, { compose: kept, left: running }, dependencies);

    const { app: recreated, ...after } = containerIds(world);
    expect(recreated).not.toBe(app);
    expect(after).toEqual(unchanged);
    expect(world.volumes).toEqual(volumes);
    const args = world.calls.flatMap((call) => call.args);
    for (const removal of ['down', 'rm', '--volumes', '-v', '--renew-anon-volumes', '-V', '--force-recreate']) {
      expect(args).not.toContain(removal);
    }
    expect(probes(world)).toHaveLength(1);
    // Every service now runs the configuration its file gives, as verification compares it.
    await expect(observeOnecliRuntime(layout, PINS, dependencies)).resolves.toEqual({ status: 'present' });
    await expect(verifyOnecliRuntime(layout, PINS, dependencies)).resolves.toBeDefined();
  });

  it('probes a recreated gateway before returning, and again when a switch cut short before its probe resumes', async () => {
    const layout = await layoutFixture();
    const running = await writeInstanceCompose(layout, RELEASE_GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' }, running);
    const { gateway, ...unchanged } = containerIds(world);
    const kept = renderOnecliCompose(layout, PINS, GATEWAY_IMAGE);
    // The run is cut short while its probe runs, after Compose recreated the gateway.
    world.failProbe = new GwsEaError('command_timeout', 'docker run was interrupted');

    await expect(
      restoreReleaseGateway(layout, PINS, { compose: kept, left: running }, { dockerCommandRunner: runner }),
    ).rejects.toBe(world.failProbe);

    const { gateway: recreated, ...after } = containerIds(world);
    expect(recreated).not.toBe(gateway);
    expect(after).toEqual(unchanged);
    // Probed from the agent-egress network after the recreate, as the last thing before the switch goes on.
    const [probe] = probes(world);
    expect(probe?.args).toContain(layout.agentEgressNetwork);
    expect(world.calls.indexOf(probe!)).toBeGreaterThan(world.calls.findIndex((call) => call.args.includes('up')));
    expect(world.calls.at(-1)).toBe(probe);
    delete world.failProbe;

    // Resumed, Compose recreates nothing, and the gateway no probe passed is proven before the switch goes on.
    await restoreReleaseGateway(layout, PINS, { compose: kept, left: running }, { dockerCommandRunner: runner });
    expect(containerIds(world).gateway).toBe(recreated);
    expect(probes(world)).toHaveLength(2);
    expect(world.calls.at(-1)).toBe(probes(world)[1]);
  });

  it('recreates and probes nothing when the release runs the Compose file of the one it leaves', async () => {
    const layout = await layoutFixture();
    const running = await writeInstanceCompose(layout);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' }, running);
    const before = containerIds(world);

    await restoreReleaseGateway(layout, PINS, { compose: running, left: running }, { dockerCommandRunner: runner });

    expect(containerIds(world)).toEqual(before);
    expect(probes(world)).toEqual([]);
  });

  it('refuses a rollback whose recreated gateway fails the isolation probe', async () => {
    const layout = await layoutFixture();
    const written = await writeInstanceCompose(layout, GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    world.failProbe = new GwsEaError('command_failed', 'link-local/metadata reachable through gateway');

    await expect(
      restoreReleaseGateway(
        layout,
        PINS,
        { compose: renderOnecliCompose(layout, PINS, RELEASE_GATEWAY_IMAGE), left: written },
        { dockerCommandRunner: runner },
      ),
    ).rejects.toBe(world.failProbe);
    expect(probes(world)).toHaveLength(1);
  });

  it('refuses to restore a kept gateway image that is gone and that this tool does not build, leaving it unstarted', async () => {
    const layout = await layoutFixture();
    const written = await writeInstanceCompose(layout, GATEWAY_IMAGE);
    const { world, runner } = dockerWorld(layout);
    world.wrapperImageMissing = true;

    await expect(
      restoreReleaseGateway(
        layout,
        PINS,
        { compose: renderOnecliCompose(layout, PINS, RELEASE_GATEWAY_IMAGE), left: written },
        { dockerCommandRunner: runner },
      ),
    ).rejects.toMatchObject({
      code: 'onecli_gateway_image_missing',
      message: expect.stringContaining(RELEASE_GATEWAY_IMAGE),
    });
    expect(composeCalls(world)).toEqual([]);
    expect(await readFile(layout.composeFile, 'utf8')).toBe(written);
  });

  it('refuses to restore a kept Compose file whose gateway is not a gws-ea wrapper image, changing nothing', async () => {
    const layout = await layoutFixture();
    const written = await writeInstanceCompose(layout, GATEWAY_IMAGE);
    // The pinned OneCLI base itself, without the egress firewall the wrapper adds.
    const unwrapped = `ghcr.io/onecli/onecli:${PINS.gateway}`;
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });

    await expect(
      restoreReleaseGateway(
        layout,
        PINS,
        { compose: renderOnecliCompose(layout, PINS, unwrapped), left: written },
        { dockerCommandRunner: runner },
      ),
    ).rejects.toMatchObject({ code: 'unsafe_onecli_image', message: expect.stringContaining(unwrapped) });
    expect(await readFile(layout.composeFile, 'utf8')).toBe(written);
    expect(composeCalls(world)).toEqual([]);
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

describe('OneCLI health check and provider credential', () => {
  it('accepts the runtime at its recorded pins, reading its local API key once, keylessly, from its own app', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    const { fetch, requests } = onecliApp(layout);

    const receipt = await verifyOnecliRuntime(layout, PINS, {
      dockerCommandRunner: runner,
      fetch,
      ambientEnv: HOSTILE_AMBIENT,
    });

    expect(requests.map(({ method, url }) => `${method} ${url}`).sort()).toEqual(
      [
        `GET ${layout.appUrl}/api/health`,
        `GET ${layout.appUrl}/v1/health`,
        `GET ${layout.gatewayUrl}/healthz`,
        `GET ${layout.appUrl}/v1/user/api-key`,
      ].sort(),
    );
    expect(requests.find(({ url }) => url.endsWith('/v1/user/api-key'))?.authorization).toBeNull();
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.keys(receipt)).toEqual([]);
  });

  it('reads the same key on every check, so the key files the first check wrote are kept', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    const { fetch } = onecliApp(layout);
    const dependencies = { dockerCommandRunner: runner, fetch };
    await mkdir(layout.secretsDirectory, { recursive: true, mode: 0o700 });
    const files = {
      runtime: path.join(layout.secretsDirectory, 'runtime-api-key'),
      admin: path.join(layout.secretsDirectory, 'admin-api-key'),
    };

    await persistOnecliApiKeyFiles(await verifyOnecliRuntime(layout, PINS, dependencies), files);
    await persistOnecliApiKeyFiles(await verifyOnecliRuntime(layout, PINS, dependencies), files);

    expect(await readFile(files.runtime, 'utf8')).toBe(ONECLI_API_KEY);
    expect(await readFile(files.admin, 'utf8')).toBe(ONECLI_API_KEY);
  });

  it('imports the provider credential with its value only in the request body, writing no file', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    const app = onecliApp(layout);
    const { requests } = app;
    const value = 'sk-ant-api03-provider-real-secret';
    // The whole instance root is searched again while OneCLI is sent the value, so a file staged for the
    // request and removed after it is found too.
    const instanceRoot = path.dirname(layout.rootDirectory);
    const holdingValue = async (): Promise<string[]> =>
      [...(await filesBeneath(instanceRoot))].flatMap(([file, contents]) => (contents.includes(value) ? [file] : []));
    const whileSent: string[][] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') whileSent.push(await holdingValue());
      return app.fetch(input, init);
    });
    const receipt = await verifyOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, fetch });
    const before = await filesBeneath(instanceRoot);
    requests.length = 0;

    const imported = await importProviderCredential(
      receipt,
      { name: 'Anthropic', type: 'anthropic', value, hostPattern: 'api.anthropic.com' },
      { fetch },
    );

    expect(imported).toEqual({ id: 'secret-provider', created: true });
    expect(requests).toEqual([
      { method: 'GET', url: `${layout.appUrl}/v1/secrets`, authorization: `Bearer ${ONECLI_API_KEY}`, body: undefined },
      {
        method: 'POST',
        url: `${layout.appUrl}/v1/secrets`,
        authorization: `Bearer ${ONECLI_API_KEY}`,
        body: { name: 'Anthropic', type: 'anthropic', value, hostPattern: 'api.anthropic.com' },
      },
    ]);
    expect(whileSent).toEqual([[]]);
    const after = await filesBeneath(instanceRoot);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const contents of after.values()) expect(contents).not.toContain(value);
  });

  it.each([
    [
      'its provider credential',
      { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
      { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com', injectionConfig: null },
    ],
    [
      'a header credential stored with OneCLI’s default format',
      { name: 'Search', type: 'generic', hostPattern: 'api.search.example.test', headerName: 'x-api-key' },
      {
        name: 'Search',
        type: 'generic',
        hostPattern: 'api.search.example.test',
        injectionConfig: { headerName: 'x-api-key', valueFormat: '{value}' },
      },
    ],
  ] as const)('reuses the secret OneCLI already holds for %s, creating none', async (_case, metadata, stored) => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    const { fetch, requests } = onecliApp(layout, [{ id: 'held-secret', pathPattern: null, ...stored }]);
    const receipt = await verifyOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, fetch });

    await expect(
      importProviderCredential(receipt, { ...metadata, value: 'provider-real-secret' }, { fetch }),
    ).resolves.toEqual({ id: 'held-secret', created: false });
    expect(requests.some(({ method }) => method === 'POST')).toBe(false);
  });

  it('refuses a gateway running another configuration than its Compose file gives, before probing or asking for a key', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    // The gateway was created to run the unwrapped OneCLI image, without the egress firewall.
    const created = renderOnecliCompose(layout, PINS, `ghcr.io/onecli/onecli:${PINS.gateway}`);
    const { world, runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' }, created);
    const fetch = healthyFetch();

    await expect(verifyOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, fetch })).rejects.toMatchObject({
      code: 'unhealthy_onecli',
      message: expect.stringContaining('the gateway container'),
    });
    expect(probes(world)).toEqual([]);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/v1/user/api-key'))).toBe(false);
  });

  it('refuses an unhealthy endpoint before asking for a key', async () => {
    const layout = await layoutFixture();
    await writeInstanceCompose(layout);
    const { runner } = dockerWorld(layout, { postgres: 'healthy', app: 'healthy', gateway: 'healthy' });
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/healthz') ? new Response('', { status: 503 }) : Response.json({ apiKey: ONECLI_API_KEY }),
    );

    await expect(verifyOnecliRuntime(layout, PINS, { dockerCommandRunner: runner, fetch })).rejects.toMatchObject({
      code: 'unhealthy_onecli',
      message: expect.stringContaining('gateway'),
    });
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/v1/user/api-key'))).toBe(false);
  });

  it('refuses to import without a passed health check', async () => {
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
