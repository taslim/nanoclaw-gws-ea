import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePrivate } from '../community-portal/private-file.js';
import { processLockOwner } from '../community-portal/process-lock.js';
import { createCloudflareApi, type CloudflareApi } from './cloudflare-api.js';
import { createCloudflareConnectorLayout } from './cloudflare-connector.js';
import {
  assertManagedCloudflareConfigurationOwnership,
  cloudflareDnsOwnershipComment,
  managedTransportResources,
  reconcileManagedCloudflareIngress,
  renderManagedCloudflareConfiguration,
  type ManagedIngressReconcileOptions,
  type ManagedTransport,
} from './cloudflare-ingress.js';
import type { RunEvent } from './events.js';
import { reserveInstance, withInstanceOperation } from './journal.js';
import { preparePrivateDirectory, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import {
  OBSERVATION_WAITS_SECONDS,
  PRESENT,
  runProvisionSteps,
  type ProvisionStep,
  type ProvisionSteps,
} from './phases.js';
import { CLOUDFLARED_IMAGE } from './pins.js';
import type { SanitizedCommand } from './process.js';
import { allocateInstanceId, readRegistry } from './registry.js';
import { GwsEaError, PROVISION_STEPS, type InstanceReservationInput } from './types.js';

const roots: string[] = [];
const TOKEN = 'cf-account-token-canary';
/** The Docker endpoint the assistant recorded, which the connector runs against. */
const DOCKER_ENDPOINT = 'unix:///run/user/1000/docker.sock';
const ACCOUNT_ID = '699d98642c564d2e855e9661899b7252';
const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353';
const TUNNEL_ID = 'f70ff985-a4ef-4643-bbbc-4a0ed4fc8415';
const BASE_URL = 'https://api.cloudflare.test/client/v4';
const LISTENER_ID = '22222222-2222-4222-8222-222222222222';
const IMAGE_ENVIRONMENT = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
];
const FULL_WAIT = OBSERVATION_WAITS_SECONDS.map((seconds) => seconds * 1_000);

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-cloudflare-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

function managedReservation(paths: ControlPlanePaths, hostname: string, webhookPort: number): InstanceReservationInput {
  const instanceId = allocateInstanceId();
  const projectId = `gws-ea-${instanceId.replaceAll('-', '').slice(0, 20)}`;
  return {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: webhookPort, onecli_app: webhookPort + 1, onecli_gateway: webhookPort + 2 },
    exclusive_resource_claims: {
      ingress: {
        mode: 'managed-cloudflare',
        account_id: ACCOUNT_ID,
        zone_id: ZONE_ID,
        zone_name: 'example.com',
        hostname,
        callback_url: `https://${hostname}/webhook/gchat`,
        dns_record_id: null,
      },
      gcp_project_id: projectId,
      gcp_account: 'operator@example.test',
      gchat_service_account: `gws-ea-chat@${projectId}.iam.gserviceaccount.com`,
      workspace_email: `${hostname.split('.')[0]}@example.test`,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

type Json = Record<string, unknown>;

function envelope(result: unknown, resultInfo?: Json, status = 200): Response {
  return Response.json(
    { success: true, errors: [], messages: [], result, ...(resultInfo ? { result_info: resultInfo } : {}) },
    { status },
  );
}

function listEnvelope(items: readonly unknown[]): Response {
  return envelope(items, {
    page: 1,
    per_page: 50,
    count: items.length,
    total_count: items.length,
    total_pages: items.length === 0 ? 0 : 1,
  });
}

/**
 * Cloudflare as the documented v4 API answers it: fresh remote-managed
 * tunnels have no `config` or `version`, readbacks add per-rule
 * `originRequest` and fields gws-ea never reads, and empty lists report
 * `total_pages: 0`.
 */
class FakeCloudflare {
  readonly requests: Array<{ method: string; route: string; body: unknown }> = [];
  /** The active zones the token reads: the claimed zone, unless a test changes it. */
  readonly zones: Json[] = [
    {
      id: ZONE_ID,
      name: 'example.com',
      status: 'active',
      paused: false,
      type: 'full',
      account: { id: ACCOUNT_ID, name: 'Example account' },
      owner: { id: null, type: 'user', email: null },
      permissions: ['#dns_records:edit', '#zone:read'],
      plan: { id: '0feeeeeeeeeeeeeeeeeeeeeeeeeeeeee', name: 'Free Website' },
    },
  ];
  readonly tunnels: Json[] = [];
  readonly records: Json[] = [];
  configuration: { config?: Json; version?: number } = {};
  /** Scripted `/connections` answers; otherwise the running connector reports the current version. */
  readonly connectionAnswers: unknown[][] = [];
  connectorRunning = false;
  /** Answers a request instead of Cloudflare; `apply` performs it as Cloudflare would. */
  intercept: ((method: string, route: string, apply: () => Response) => Response | undefined) | undefined;
  #recordCount = 0;

  readonly fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const route = url.pathname.replace('/client/v4', '');
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    this.requests.push({ method, route, body });
    const apply = (): Response => this.#answer(method, route, url, body);
    return this.intercept?.(method, route, apply) ?? apply();
  });

  #answer(method: string, route: string, url: URL, body: unknown): Response {
    const tunnelRoot = `/accounts/${ACCOUNT_ID}/cfd_tunnel`;
    if (method === 'GET' && route === '/zones') return listEnvelope(this.zones);
    if (method === 'GET' && route === tunnelRoot) {
      return listEnvelope(this.tunnels.filter((tunnel) => tunnel.name === url.searchParams.get('name')));
    }
    if (method === 'POST' && route === tunnelRoot) {
      const tunnel = {
        id: TUNNEL_ID,
        account_tag: ACCOUNT_ID,
        created_at: '2026-09-20T10:00:00.000000Z',
        deleted_at: null,
        name: (body as Json).name,
        conns_active_at: null,
        conns_inactive_at: null,
        metadata: {},
        remote_config: true,
        config_src: 'cloudflare',
        status: 'inactive',
        tun_type: 'cfd_tunnel',
      };
      this.tunnels.push(tunnel);
      return envelope(tunnel);
    }
    if (route === `${tunnelRoot}/${TUNNEL_ID}/configurations`) {
      if (method === 'PUT') this.applyConfiguration((body as Json).config as Json);
      return envelope(this.readback());
    }
    if (method === 'GET' && route === `${tunnelRoot}/${TUNNEL_ID}/token`) return envelope(`tunnel-token-${TUNNEL_ID}`);
    if (method === 'GET' && route === `${tunnelRoot}/${TUNNEL_ID}/connections`) {
      const scripted = this.connectionAnswers.shift();
      if (scripted) return envelope(scripted);
      return envelope(
        this.connectorRunning
          ? [{ id: '1bedc50d-42b3-473c-b108-ff3d10c0d925', config_version: this.configuration.version ?? 0, conns: [] }]
          : [],
      );
    }
    if (method === 'GET' && route === `/zones/${ZONE_ID}/dns_records`) {
      return listEnvelope(this.records.filter((record) => record.name === url.searchParams.get('name')));
    }
    if (method === 'POST' && route === `/zones/${ZONE_ID}/dns_records`) {
      this.#recordCount += 1;
      const record = {
        id: String(this.#recordCount).padStart(32, 'c'),
        ...(body as Json),
        proxiable: true,
        ttl: 1,
        settings: { flatten_cname: false },
        meta: {},
        tags: [],
        created_on: '2026-09-20T10:00:00.000000Z',
        modified_on: '2026-09-20T10:00:00.000000Z',
      };
      this.records.push(record);
      return envelope(record);
    }
    throw new Error(`unexpected ${method} ${route}`);
  }

  applyConfiguration(config: Json): void {
    this.configuration = { config, version: (this.configuration.version ?? 0) + 1 };
  }

  /** A readback as Cloudflare returns it after a PUT. */
  readback(): Json {
    const { config, version } = this.configuration;
    const base = {
      tunnel_id: TUNNEL_ID,
      account_id: ACCOUNT_ID,
      source: 'cloudflare',
      created_at: '2026-09-20T10:00:00.000000Z',
    };
    if (config === undefined) return base;
    const ingress = (config.ingress as Json[] | undefined)?.map((rule) => ({ ...rule, originRequest: {} }));
    return { ...base, version, config: { ...config, ingress, 'warp-routing': { enabled: false } }, future: true };
  }

  count(method: string, suffix: string): number {
    return this.requests.filter((request) => request.method === method && request.route.endsWith(suffix)).length;
  }

  api(sleep: (milliseconds: number) => Promise<void> = async () => undefined): CloudflareApi {
    return createCloudflareApi({ accountToken: TOKEN, fetch: this.fetch, baseUrl: BASE_URL, sleep });
  }
}

interface FakeContainer {
  image: string;
  status: 'running' | 'exited' | 'restarting';
  inspect: Json;
}

/** Docker as the connector sees it: the container is built from the rendered Compose file. */
class FakeDocker {
  readonly calls: string[][] = [];
  /** The Docker endpoint each call targeted. */
  readonly endpoints: Array<string | undefined> = [];
  readonly images = new Set<string>();
  container: FakeContainer | undefined;
  upUnderMachineLock: boolean[] = [];

  constructor(
    private readonly paths: ControlPlanePaths,
    private readonly cloud: FakeCloudflare,
  ) {}

  readonly run = async (command: SanitizedCommand): Promise<{ stdout: string; stderr: string }> => {
    const args = [...command.args];
    this.calls.push(args);
    this.endpoints.push(command.env?.DOCKER_HOST);
    const words = args.filter((arg) => !arg.startsWith('-'));
    if (args[0] === 'container' && args[1] === 'ls') return { stdout: this.container ? 'c0ffee\n' : '', stderr: '' };
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (!this.container) throw new GwsEaError('command_failed', 'No such container');
      const inspect = structuredClone(this.container.inspect);
      (inspect.Config as Json).Image = this.container.image;
      inspect.State = {
        Status: this.container.status,
        Running: this.container.status === 'running',
        Restarting: this.container.status === 'restarting',
        ExitCode: this.container.status === 'running' ? 0 : 1,
      };
      return { stdout: JSON.stringify([inspect]), stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!this.images.has(args.at(-1)!)) throw new GwsEaError('command_failed', 'No such image');
      return { stdout: `${JSON.stringify(IMAGE_ENVIRONMENT)}\n`, stderr: '' };
    }
    if (args[0] === 'pull') {
      this.images.add(args.at(-1)!);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'compose' && words.includes('up')) {
      this.upUnderMachineLock.push(processLockOwner(this.paths.registryLock)?.pid === process.pid);
      const composeFile = args[args.indexOf('--file') + 1]!;
      const compose = parseYaml(await readFile(composeFile, 'utf8')) as Json;
      const service = (compose.services as Json).connector as Json;
      const secret = (compose.secrets as Json).tunnel_token as Json;
      if (!this.images.has(String(service.image))) throw new GwsEaError('command_failed', 'Image not present');
      this.container = {
        image: String(service.image),
        status: 'running',
        inspect: {
          Id: 'c0ffee',
          Config: {
            Image: service.image,
            User: service.user,
            Cmd: service.command,
            Env: IMAGE_ENVIRONMENT,
            Labels: {
              'com.docker.compose.project': args[args.indexOf('--project-name') + 1],
              'com.docker.compose.service': 'connector',
              'com.docker.compose.config-hash': 'f'.repeat(64),
              ...(service.labels as Json),
            },
          },
          RestartCount: 0,
          HostConfig: {
            RestartPolicy: { Name: service.restart, MaximumRetryCount: 0 },
            ReadonlyRootfs: service.read_only,
            Privileged: false,
            CapDrop: service.cap_drop,
            CapAdd: null,
            SecurityOpt: service.security_opt,
            NetworkMode: service.network_mode,
            ExtraHosts: service.extra_hosts ?? null,
            Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777' },
            PortBindings: {},
          },
          Mounts: [
            {
              Type: 'bind',
              Source: secret.file,
              Destination: '/run/secrets/tunnel_token',
              Mode: '',
              RW: false,
              Propagation: 'rprivate',
            },
          ],
        },
      };
      this.cloud.connectorRunning = true;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected docker ${args.join(' ')}`);
  };

  stop(): void {
    this.container!.status = 'exited';
    this.cloud.connectorRunning = false;
  }
}

/** The assistant's listener and Cloudflare's edge, derived from the fakes' state. */
function edge(cloud: FakeCloudflare, docker: FakeDocker, options: { edgeDownFor: number; unresolvedFor: number }) {
  const probes: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = new URL(String(input));
    probes.push(`${init.method ?? 'GET'} ${url.href}`);
    if (url.hostname === '127.0.0.1') {
      return new Response(null, { status: 401, headers: { 'x-nanoclaw-webhook-id': LISTENER_ID } });
    }
    const resolving = options.unresolvedFor <= 0;
    options.unresolvedFor -= 1;
    if (!resolving || !cloud.records.some((record) => record.name === url.hostname)) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      });
    }
    if (options.edgeDownFor > 0 || docker.container?.status !== 'running') {
      options.edgeDownFor -= 1;
      return new Response('<!DOCTYPE html><title>Cloudflare Tunnel error | 1033</title>', {
        status: 530,
        headers: { 'content-type': 'text/html' },
      });
    }
    const rules = (cloud.configuration.config?.ingress as Json[] | undefined) ?? [];
    const routed = rules.some(
      (rule) =>
        rule.hostname === url.hostname &&
        typeof rule.path === 'string' &&
        new RegExp(rule.path, 'u').test(url.pathname),
    );
    if (!routed) return new Response(null, { status: 404 });
    return new Response(null, { status: 401, headers: { 'x-nanoclaw-webhook-id': LISTENER_ID } });
  });
  return { fetch, probes };
}

async function transportFixture(
  options: { hostname?: string; webhookPort?: number; edgeDownFor?: number; unresolvedFor?: number } = {},
) {
  const paths = await testPaths();
  const reserved = await reserveInstance(
    paths,
    managedReservation(paths, options.hostname ?? 'assistant.example.com', options.webhookPort ?? 31_100),
  );
  const cloud = new FakeCloudflare();
  const docker = new FakeDocker(paths, cloud);
  const route = edge(cloud, docker, {
    edgeDownFor: options.edgeDownFor ?? 0,
    unresolvedFor: options.unresolvedFor ?? 0,
  });
  const sleeps: number[] = [];
  const events: RunEvent[] = [];
  const tokenRequests: string[] = [];
  const sleep = async (milliseconds: number): Promise<void> => void sleeps.push(milliseconds);
  return {
    paths,
    cloud,
    docker,
    route,
    sleeps,
    events,
    tokenRequests,
    reserve: (hostname: string, webhookPort: number) =>
      reserveInstance(paths, managedReservation(paths, hostname, webhookPort)),
    run: async (instanceId = reserved.instance_id) => {
      const registry = await readRegistry(paths);
      const claim = registry.instances[instanceId]!.exclusive_resource_claims.ingress;
      if (claim.mode !== 'managed-cloudflare') throw new Error('managed fixture');
      const transport: ManagedTransport = {
        paths,
        instanceId,
        claim,
        platform: 'linux',
        webhookPort: registry.instances[instanceId]!.allocated_ports.nanoclaw_webhook,
        dockerEndpoint: DOCKER_ENDPOINT,
        accountToken: async (reason) => {
          tokenRequests.push(reason);
          return TOKEN;
        },
      };
      const satisfied: ProvisionStep<unknown> = {
        label: 'Already satisfied…',
        resources: [{ name: 'nothing', observe: async () => PRESENT, apply: async () => undefined }],
      };
      const steps = {
        ...Object.fromEntries(PROVISION_STEPS.map((id) => [id, satisfied])),
        establish_transport: {
          label: 'Publishing the secure callback…',
          liveness: { label: 'Checking the secure callback…' },
          resources: managedTransportResources(transport, {
            createApi: () => cloud.api(sleep),
            connector: { runCommand: docker.run, ambientEnv: { PATH: '/usr/bin:/bin' } },
            fetch: route.fetch,
            sleep,
          }),
        },
      } as ProvisionSteps<unknown>;
      const result = await withInstanceOperation(paths, instanceId, (operation) =>
        runProvisionSteps(operation, {}, steps, { sleep, emit: (event) => void events.push(event) }),
      );
      if (!result) throw new Error('The instance operation was busy');
      return result;
    },
    instanceId: reserved.instance_id,
  };
}

describe('managed Cloudflare desired state', () => {
  it('sorts exact routes stably, leaves out assistants under removal, and ends with one catch-all', async () => {
    const paths = await testPaths();
    const zeta = await reserveInstance(paths, managedReservation(paths, 'zeta.example.com', 31_100));
    await reserveInstance(paths, managedReservation(paths, 'alpha.example.com', 31_200));
    const registry = await readRegistry(paths);

    expect(renderManagedCloudflareConfiguration(registry, 'host.docker.internal')).toEqual({
      ingress: [
        { hostname: 'alpha.example.com', path: '^/webhook/gchat$', service: 'http://host.docker.internal:31200' },
        { hostname: 'zeta.example.com', path: '^/webhook/gchat$', service: 'http://host.docker.internal:31100' },
        { service: 'http_status:404' },
      ],
    });
    expect(renderManagedCloudflareConfiguration(registry, '127.0.0.1', new Set([zeta.instance_id]))).toEqual({
      ingress: [
        { hostname: 'alpha.example.com', path: '^/webhook/gchat$', service: 'http://127.0.0.1:31200' },
        { service: 'http_status:404' },
      ],
    });
  });

  it('owns a readback by its (hostname, path, service) projection and refuses routes outside the universe', () => {
    const target = {
      hostname: 'target.example.com',
      path: '^/webhook/gchat$' as const,
      service: 'http://127.0.0.1:31100',
    };
    const peer = { hostname: 'peer.example.com', path: '^/webhook/gchat$' as const, service: 'http://127.0.0.1:31200' };
    const catchAll = { service: 'http_status:404' as const };
    const readback = {
      ingress: [
        { ...peer, originRequest: {} },
        { ...target, originRequest: { connectTimeout: 30 } },
        { ...catchAll, originRequest: {} },
      ],
      'warp-routing': { enabled: false },
    };

    expect(assertManagedCloudflareConfigurationOwnership(readback, { ingress: [peer, target, catchAll] })).toEqual({
      ingress: [peer, target, catchAll],
    });
    expect(assertManagedCloudflareConfigurationOwnership({ ingress: null }, { ingress: [catchAll] })).toEqual({
      ingress: [],
    });
    expect(() => assertManagedCloudflareConfigurationOwnership(readback, { ingress: [peer, catchAll] })).toThrow(
      /not owned/iu,
    );
    expect(() =>
      assertManagedCloudflareConfigurationOwnership(
        { ingress: [{ hostname: 'foreign.example.com', service: 'http://127.0.0.1:9999' }, catchAll] },
        { ingress: [peer, catchAll] },
      ),
    ).toThrow(/foreign/iu);
    expect(() =>
      assertManagedCloudflareConfigurationOwnership(
        { ...readback, 'warp-routing': { enabled: true } },
        {
          ingress: [peer, target, catchAll],
        },
      ),
    ).toThrow(/private-network/iu);
  });
});

describe('managed Cloudflare reconciliation', () => {
  it('converges a fresh tunnel whose configuration has no config or version, and stores the connector token', async () => {
    const paths = await testPaths();
    const input = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, input);
    const cloud = new FakeCloudflare();
    const connector = createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform: 'linux' });

    await expect(
      reconcileManagedCloudflareIngress(paths, cloud.api(), {
        instanceId: input.instance_id,
        originHost: '127.0.0.1',
        connector,
      }),
    ).resolves.toEqual({ tunnelId: TUNNEL_ID, configurationVersion: 1 });

    expect(cloud.configuration.config).toEqual({
      ingress: [
        { hostname: 'assistant.example.com', path: '^/webhook/gchat$', service: 'http://127.0.0.1:31100' },
        { service: 'http_status:404' },
      ],
    });
    expect(cloud.records).toEqual([
      expect.objectContaining({
        type: 'CNAME',
        name: 'assistant.example.com',
        content: `${TUNNEL_ID}.cfargotunnel.com`,
        proxied: true,
        comment: cloudflareDnsOwnershipComment(input.instance_id),
      }),
    ]);
    const stored = await readRegistry(paths);
    expect(stored.shared_infrastructure_metadata.cloudflare?.tunnel_id).toBe(TUNNEL_ID);
    expect(stored.instances[input.instance_id]?.exclusive_resource_claims.ingress).toMatchObject({
      dns_record_id: cloud.records[0]!.id,
    });
    expect(await readFile(connector.tokenFile, 'utf8')).toBe(`tunnel-token-${TUNNEL_ID}`);
    expect((await stat(connector.tokenFile)).mode & 0o777).toBe(0o600);
  });

  it('owns its own readback, with per-rule originRequest and extra fields, and writes nothing the second time', async () => {
    const paths = await testPaths();
    const input = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, input);
    const cloud = new FakeCloudflare();
    const options = {
      instanceId: input.instance_id,
      originHost: '127.0.0.1' as const,
      connector: createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform: 'linux' }),
    };
    await reconcileManagedCloudflareIngress(paths, cloud.api(), options);
    expect(cloud.readback()).toMatchObject({
      config: { ingress: [{ originRequest: {} }, { originRequest: {} }], 'warp-routing': { enabled: false } },
      future: true,
    });
    cloud.requests.length = 0;

    await expect(reconcileManagedCloudflareIngress(paths, cloud.api(), options)).resolves.toEqual({
      tunnelId: TUNNEL_ID,
      configurationVersion: 1,
    });
    expect(cloud.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it.each([
    { label: 'not applied', applied: false, puts: 2 },
    { label: 'applied anyway', applied: true, puts: 1 },
  ])(
    'waits out a 429 on the route PUT, re-reads, and retries only when the change is absent ($label)',
    async ({ applied, puts }) => {
      const paths = await testPaths();
      const input = managedReservation(paths, 'assistant.example.com', 31_100);
      await reserveInstance(paths, input);
      const cloud = new FakeCloudflare();
      let limited = false;
      cloud.intercept = (method, route, apply) => {
        if (method !== 'PUT' || !route.endsWith('/configurations') || limited) return undefined;
        limited = true;
        if (applied) apply();
        return Response.json(
          {
            success: false,
            errors: [{ code: 971, message: 'Please wait and consider throttling your request speed' }],
            messages: [],
            result: null,
          },
          { status: 429, headers: { 'retry-after': '3' } },
        );
      };
      const sleeps: number[] = [];

      await expect(
        reconcileManagedCloudflareIngress(
          paths,
          cloud.api(async (milliseconds) => void sleeps.push(milliseconds)),
          {
            instanceId: input.instance_id,
            originHost: '127.0.0.1',
            connector: createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform: 'linux' }),
          },
        ),
      ).resolves.toMatchObject({ tunnelId: TUNNEL_ID });
      expect(sleeps).toEqual([3_000]);
      expect(cloud.count('PUT', '/configurations')).toBe(puts);
      const afterLimit = cloud.requests.findIndex((request) => request.method === 'PUT');
      expect(cloud.requests[afterLimit + 1]).toMatchObject({
        method: 'GET',
        route: expect.stringMatching(/configurations$/u),
      });
      expect(cloud.configuration.config?.ingress).toHaveLength(2);
    },
  );

  it('reconciles only its own DNS record, so a hand-edited peer record does not block it', async () => {
    const paths = await testPaths();
    const peer = managedReservation(paths, 'peer.example.com', 31_200);
    const target = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, peer);
    await reserveInstance(paths, target);
    const cloud = new FakeCloudflare();
    const connector = createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform: 'linux' });
    await reconcileManagedCloudflareIngress(paths, cloud.api(), {
      instanceId: peer.instance_id,
      originHost: '127.0.0.1',
      connector,
    });
    const peerRecord = cloud.records[0]!;
    peerRecord.proxied = false;
    peerRecord.comment = 'hand edited';

    await expect(
      reconcileManagedCloudflareIngress(paths, cloud.api(), {
        instanceId: target.instance_id,
        originHost: '127.0.0.1',
        connector,
      }),
    ).resolves.toMatchObject({ configurationVersion: 1 });
    expect(cloud.count('PUT', '/configurations')).toBe(1);
    expect(cloud.requests.filter((request) => request.route.endsWith('/dns_records')).map((r) => r.method)).toEqual([
      'GET',
      'POST',
      'GET',
      'POST',
    ]);
    expect(peerRecord).toMatchObject({ proxied: false, comment: 'hand edited' });
    expect((cloud.configuration.config?.ingress as Json[]).map((rule) => rule.hostname)).toEqual([
      'assistant.example.com',
      'peer.example.com',
      undefined,
    ]);
  });

  it("is not blocked by a peer's stuck removal, whose route leaves the route set", async () => {
    const paths = await testPaths();
    const removing = managedReservation(paths, 'removing.example.com', 31_200);
    const target = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, removing);
    await reserveInstance(paths, target);
    const cloud = new FakeCloudflare();
    const connector = createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform: 'linux' });
    await reconcileManagedCloudflareIngress(paths, cloud.api(), {
      instanceId: removing.instance_id,
      originHost: '127.0.0.1',
      connector,
    });
    await preparePrivateDirectory(paths.removalRoot);
    await writePrivate(paths.removalFile(removing.instance_id), { active: true });
    // Finder metadata and an interrupted receipt write are not removal receipts.
    await writeFile(path.join(paths.removalRoot, '.DS_Store'), 'finder', { mode: 0o644 });
    await writeFile(`${paths.removalFile(target.instance_id)}.AAAAAAAAAAA.tmp`, '{', { mode: 0o600 });

    await expect(
      reconcileManagedCloudflareIngress(paths, cloud.api(), {
        instanceId: target.instance_id,
        originHost: '127.0.0.1',
        connector,
      }),
    ).resolves.toMatchObject({ tunnelId: TUNNEL_ID });
    expect((cloud.configuration.config?.ingress as Json[]).map((rule) => rule.hostname)).toEqual([
      'assistant.example.com',
      undefined,
    ]);
    await expect(
      reconcileManagedCloudflareIngress(paths, cloud.api(), {
        instanceId: removing.instance_id,
        originHost: '127.0.0.1',
        connector,
      }),
    ).rejects.toMatchObject({ code: 'removal_in_progress' });
  });

  it.each(['foreign-config', 'foreign-dns'] as const)('refuses %s before changing anything', async (kind) => {
    const paths = await testPaths();
    const input = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, input);
    const cloud = new FakeCloudflare();
    const connector = createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform: 'linux' });
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare!;
    cloud.tunnels.push({ id: TUNNEL_ID, name: metadata.tunnel_name, config_src: 'cloudflare', remote_config: true });
    if (kind === 'foreign-config') {
      cloud.configuration = {
        version: 1,
        config: {
          ingress: [
            { hostname: 'foreign.example.com', service: 'http://127.0.0.1:9999' },
            { service: 'http_status:404' },
          ],
        },
      };
    } else {
      cloud.records.push({
        id: 'd'.repeat(32),
        type: 'A',
        name: 'assistant.example.com',
        content: '192.0.2.1',
        proxied: true,
        comment: 'someone else',
      });
    }

    await expect(
      reconcileManagedCloudflareIngress(paths, cloud.api(), {
        instanceId: input.instance_id,
        originHost: '127.0.0.1',
        connector,
      }),
    ).rejects.toThrow(/foreign/iu);
    expect(cloud.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare?.tunnel_id).toBeNull();
  });

  it('adopts a create Cloudflare applied without confirming, and does not send it again', async () => {
    const paths = await testPaths();
    const input = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, input);
    const cloud = new FakeCloudflare();
    cloud.intercept = (method, _route, apply) => {
      if (method !== 'POST') return undefined;
      // Cloudflare applied the create, then answered with a gateway error.
      apply();
      return new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    };

    await expect(
      reconcileManagedCloudflareIngress(paths, cloud.api(), {
        instanceId: input.instance_id,
        originHost: '127.0.0.1',
        connector: createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform: 'linux' }),
      }),
    ).resolves.toMatchObject({ tunnelId: TUNNEL_ID });
    expect(cloud.count('POST', '/cfd_tunnel')).toBe(1);
    expect(cloud.count('POST', '/dns_records')).toBe(1);
    expect(cloud.tunnels).toHaveLength(1);
    expect(cloud.records).toHaveLength(1);
  });

  it('records that the tunnel is being created first, so a failure before its ID is recorded leaves a trace', async () => {
    const paths = await testPaths();
    const input = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, input);
    const cloud = new FakeCloudflare();
    // Cloudflare creates the tunnel, then the run stops before recording its ID.
    cloud.intercept = (method, route) =>
      method === 'GET' && route.endsWith('/configurations')
        ? new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: 'bad request' }] }), {
            status: 400,
          })
        : undefined;
    const options: ManagedIngressReconcileOptions = {
      instanceId: input.instance_id,
      originHost: '127.0.0.1',
      connector: createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform: 'linux' }),
    };

    await expect(reconcileManagedCloudflareIngress(paths, cloud.api(), options)).rejects.toMatchObject({
      code: 'cloudflare_api_failed',
    });
    expect(cloud.tunnels).toHaveLength(1);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare).toMatchObject({
      tunnel_id: null,
      tunnel_creation_started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/u),
    });

    // Resuming adopts the tunnel by its reserved name, records its ID, and clears the trace.
    cloud.intercept = undefined;
    await expect(reconcileManagedCloudflareIngress(paths, cloud.api(), options)).resolves.toMatchObject({
      tunnelId: TUNNEL_ID,
    });
    expect(cloud.count('POST', '/cfd_tunnel')).toBe(1);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare).toMatchObject({
      tunnel_id: TUNNEL_ID,
      tunnel_creation_started_at: null,
    });
  });

  it.each([
    { label: 'another zone', change: (zone: Json) => void (zone.id = 'f'.repeat(32)) },
    {
      label: 'the claimed zone under another account',
      change: (zone: Json) => void (zone.account = { id: 'e'.repeat(32), name: 'Another account' }),
    },
  ])('fails before any change when the token reads $label instead of the claimed zone', async ({ change }) => {
    const paths = await testPaths();
    const input = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, input);
    const cloud = new FakeCloudflare();
    change(cloud.zones[0]!);

    await expect(
      reconcileManagedCloudflareIngress(paths, cloud.api(), {
        instanceId: input.instance_id,
        originHost: '127.0.0.1',
        connector: createCloudflareConnectorLayout({ cloudflareRoot: paths.cloudflareRoot, platform: 'linux' }),
      }),
    ).rejects.toMatchObject({ code: 'cloudflare_capability_missing' });
    expect(cloud.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });
});

describe('managed Cloudflare transport step', () => {
  it('creates the route, starts the connector under the machine lock, and proves the public callback', async () => {
    const world = await transportFixture();

    await expect(world.run()).resolves.toEqual({ status: 'ready' });

    expect(world.tokenRequests).toEqual([
      'Cloudflare must route https://assistant.example.com/webhook/gchat to this assistant',
    ]);
    expect(world.cloud.count('POST', '/cfd_tunnel')).toBe(1);
    expect(world.cloud.count('PUT', '/configurations')).toBe(1);
    expect(world.cloud.count('POST', '/dns_records')).toBe(1);
    expect(world.docker.calls.filter((args) => args[0] === 'pull')).toEqual([['pull', CLOUDFLARED_IMAGE]]);
    expect(world.docker.calls.filter((args) => args.includes('up'))).toEqual([
      expect.arrayContaining(['up', '--detach', '--force-recreate']),
    ]);
    expect(world.docker.upUnderMachineLock).toEqual([true]);
    expect(new Set(world.docker.endpoints)).toEqual(new Set([DOCKER_ENDPOINT]));
    expect(JSON.stringify(world.docker.calls)).not.toContain(`tunnel-token-${TUNNEL_ID}`);
    expect(world.route.probes).toEqual([
      'POST http://127.0.0.1:31100/webhook/gchat',
      'POST https://assistant.example.com/webhook/gchat',
      'GET https://assistant.example.com/__gws_ea_wrong_path__',
    ]);
  });

  it('restarts a stopped connector from its stored token at once, with no prompt', async () => {
    const world = await transportFixture();
    await world.run();
    world.docker.stop();
    world.docker.calls.length = 0;
    world.sleeps.length = 0;

    await expect(world.run()).resolves.toEqual({ status: 'ready' });

    expect(world.tokenRequests).toHaveLength(1);
    expect(world.sleeps).toEqual([]);
    expect(world.docker.calls.some((args) => args[0] === 'pull')).toBe(false);
    expect(world.docker.calls.filter((args) => args.includes('up'))).toHaveLength(1);
    expect(world.docker.upUnderMachineLock).toEqual([true, true]);
    expect(world.cloud.requests.filter((request) => request.method !== 'GET')).toHaveLength(3);
  });

  it('refuses a connector it does not own, without asking for the token or changing anything', async () => {
    const world = await transportFixture();
    await world.run();
    const labels = (world.docker.container!.inspect.Config as Json).Labels as Json;
    labels['dev.gws-ea.resource-owner'] = 'someone-else';
    world.docker.stop();
    world.docker.calls.length = 0;
    world.cloud.requests.length = 0;

    await expect(world.run()).rejects.toMatchObject({ code: 'unsafe_connector_owner' });

    expect(world.tokenRequests).toHaveLength(1);
    expect(world.docker.calls.some((args) => args.includes('up') || args[0] === 'pull')).toBe(false);
    expect(world.cloud.requests).toEqual([]);
  });

  it('recreates the connector when the cloudflared pin moves, with no prompt', async () => {
    const world = await transportFixture();
    await world.run();
    const previous = `cloudflare/cloudflared:2026.8.0@sha256:${'1'.repeat(64)}`;
    world.docker.container!.image = previous;
    world.docker.images.delete(CLOUDFLARED_IMAGE);
    world.docker.calls.length = 0;

    await expect(world.run()).resolves.toEqual({ status: 'ready' });

    expect(world.tokenRequests).toHaveLength(1);
    expect(world.docker.calls.filter((args) => args[0] === 'pull')).toEqual([['pull', CLOUDFLARED_IMAGE]]);
    expect(world.docker.container?.image).toBe(CLOUDFLARED_IMAGE);
  });

  it('waits for a connector that reports no config_version, then a newer one, before checking a new route', async () => {
    const world = await transportFixture();
    await world.run();
    const second = await world.reserve('second.example.com', 31_200);
    const client = { id: '1bedc50d-42b3-473c-b108-ff3d10c0d925', conns: [] };
    world.cloud.connectionAnswers.push([client], [{ ...client, config_version: 3 }]);
    world.cloud.requests.length = 0;
    world.sleeps.length = 0;

    await expect(world.run(second.instance_id)).resolves.toEqual({ status: 'ready' });

    expect(world.cloud.configuration.version).toBe(2);
    expect(world.cloud.count('GET', '/connections')).toBe(2);
    expect(world.sleeps).toEqual([1_000]);
    expect(world.tokenRequests).toHaveLength(2);
  });

  it('waits for a new hostname to resolve, without asking for the token again', async () => {
    const world = await transportFixture({ unresolvedFor: 2 });

    await expect(world.run()).resolves.toEqual({ status: 'ready' });

    expect(world.tokenRequests).toHaveLength(1);
    expect(world.sleeps).toEqual([1_000]);
    expect(world.cloud.count('POST', '/dns_records')).toBe(1);
    expect(world.events).toContainEqual(
      expect.objectContaining({ type: 'step-waiting', reason: expect.stringMatching(/does not resolve/u) }),
    );
  });

  it('recreates a DNS record deleted by hand once the callback stops resolving', async () => {
    const world = await transportFixture();
    await world.run();
    world.cloud.records.length = 0;

    await expect(world.run()).resolves.toEqual({ status: 'ready' });

    expect(world.tokenRequests.at(-1)).toMatch(/does not resolve.*needs repair/u);
    expect(world.cloud.count('POST', '/dns_records')).toBe(2);
    const claim = (await readRegistry(world.paths)).instances[world.instanceId]!.exclusive_resource_claims.ingress;
    expect(claim).toMatchObject({ dns_record_id: world.cloud.records[0]!.id });
  });

  it('retries a 530 right after DNS creation, then succeeds once the edge reaches the tunnel', async () => {
    const world = await transportFixture({ edgeDownFor: 2 });

    await expect(world.run()).resolves.toEqual({ status: 'ready' });

    expect(world.sleeps).toEqual([1_000, 2_000]);
    expect(world.events).toContainEqual(
      expect.objectContaining({ type: 'step-waiting', reason: expect.stringMatching(/530/u) }),
    );
  });

  it('reports the tunnel or the assistant down when 530 persists, without changing Cloudflare again', async () => {
    const world = await transportFixture({ edgeDownFor: Number.POSITIVE_INFINITY });

    await expect(world.run()).rejects.toMatchObject({
      code: 'observation_unknown',
      message: expect.stringMatching(/public Google Chat callback: .*530.*tunnel or the assistant is down/u),
    });
    expect(world.sleeps).toEqual(FULL_WAIT);
    expect(world.tokenRequests).toHaveLength(1);
    expect(world.cloud.count('PUT', '/configurations')).toBe(1);
  });

  it('repairs a route Cloudflare no longer serves, naming what the callback answered', async () => {
    const world = await transportFixture();
    await world.run();
    world.cloud.applyConfiguration({ ingress: [{ service: 'http_status:404' }] });

    await expect(world.run()).resolves.toEqual({ status: 'ready' });

    expect(world.tokenRequests.at(-1)).toMatch(/answered 404.*needs repair/u);
    expect(world.cloud.configuration.config?.ingress).toHaveLength(2);
  });
});
