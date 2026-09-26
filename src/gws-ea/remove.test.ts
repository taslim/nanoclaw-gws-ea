import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePrivate } from '../community-portal/private-file.js';
import { processLockOwner } from '../community-portal/process-lock.js';
import { getInstallScopedNames } from '../install-slug.js';
import { runCli, type CliRuntime } from './cli.js';
import type { CloudflareApi, CloudflareDnsRecord, CloudflareTunnel } from './cloudflare-api.js';
import { PauseRequired, type CloudflareTokenRequest } from './events.js';
import type { GcloudCommandRunner } from './gcloud.js';
import {
  acquireInstanceOperation,
  recordKeyPolicyLifted,
  recordStepCompleted,
  recordStepStarted,
  reserveInstance,
  withInstanceOperation,
} from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { SanitizedCommand, SanitizedCommandOutcome } from './process.js';
import { allocateInstanceId, readRegistry, withLockedCloudflareRegistry, writeInstanceMarker } from './registry.js';
import {
  describeRemoval,
  RemovalPause,
  removeAssistant,
  type RemovalDependencies,
  type RemovalInteraction,
} from './remove.js';
import { GwsEaError, type InstanceReservationInput, type ProvisionStepId } from './types.js';
import { keepAccountToken } from './cloudflare-token.js';

// Removal must never reach a real gcloud, Docker, service manager, or Cloudflare from these tests.
vi.mock('./process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process.js')>();
  const refuse = async (command: { readonly command: string }): Promise<never> => {
    throw new Error(`A real ${command.command} command ran`);
  };
  return { ...actual, runSanitizedCommand: refuse, runSanitizedCommandOutcome: refuse };
});
vi.mock('./cloudflare-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cloudflare-api.js')>()),
  createCloudflareApi: () => {
    throw new Error('A real Cloudflare client was created');
  },
}));

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ACCOUNT = 'operator@example.test';
const ACCOUNT_ID = 'a'.repeat(32);
const ZONE_ID = 'b'.repeat(32);
const TUNNEL_ID = '11111111-1111-4111-8111-111111111111';
const DOCKER = 'unix:///var/run/docker.sock';
const CATCH_ALL = { service: 'http_status:404' };
const KEY_CONSTRAINTS = ['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation'];

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-remove-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

function projectFor(instanceId: string): string {
  return `gws-ea-${instanceId.replaceAll('-', '').slice(0, 20)}`;
}

function reservationInput(
  paths: ControlPlanePaths,
  options: { readonly label?: string; readonly port?: number; readonly managed?: boolean; readonly dns?: boolean } = {},
): InstanceReservationInput {
  const label = options.label ?? 'target';
  const port = options.port ?? 33_001;
  const instanceId = allocateInstanceId();
  const projectId = projectFor(instanceId);
  return {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: port, onecli_app: port + 100, onecli_gateway: port + 200 },
    exclusive_resource_claims: {
      ingress: options.managed
        ? {
            mode: 'managed-cloudflare',
            account_id: ACCOUNT_ID,
            zone_id: ZONE_ID,
            zone_name: 'example.test',
            hostname: `${label}.example.test`,
            callback_url: `https://${label}.example.test/webhook/gchat`,
            dns_record_id: options.dns ? (label === 'target' ? 'c' : 'd').repeat(32) : null,
          }
        : { mode: 'existing', endpoint_url: `https://${label}.example.test/webhook/gchat` },
      gcp_project_id: projectId,
      gcp_account: ACCOUNT,
      gchat_service_account: `gws-ea-chat@${projectId}.iam.gserviceaccount.com`,
      workspace_email: `${label}@example.test`,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

/** Reserve, optionally materialize the checkout with its marker, and record which steps started. */
async function reserve(
  paths: ControlPlanePaths,
  input: InstanceReservationInput,
  options: {
    readonly checkout?: boolean;
    readonly started?: readonly ProvisionStepId[];
    readonly lifted?: boolean;
  } = {},
): Promise<InstanceReservationInput> {
  await reserveInstance(paths, input);
  if (options.checkout ?? true) {
    await mkdir(input.checkout_realpath, { recursive: true, mode: 0o700 });
    await writeInstanceMarker(paths, input.instance_id);
  }
  await withInstanceOperation(paths, input.instance_id, async (operation) => {
    for (const step of options.started ?? []) {
      await recordStepStarted(operation, step);
      if (step === 'materialize_checkout') await recordStepCompleted(operation, step);
    }
    if (options.lifted) await recordKeyPolicyLifted(operation, true);
  });
  return input;
}

async function recordTunnel(paths: ControlPlanePaths): Promise<void> {
  await withLockedCloudflareRegistry(paths, (locked) => locked.updateCoordinates({ tunnelId: TUNNEL_ID }));
}

function ok(stdout = '', stderr = ''): SanitizedCommandOutcome {
  return { stdout, stderr, exitCode: 0 };
}

function failed(stderr: string): SanitizedCommandOutcome {
  return { stdout: '', stderr, exitCode: 1 };
}

/** One Google Cloud project as gcloud reports it to the reserved account. */
class FakeGcloud {
  project: { labels: Record<string, string>; lifecycleState: string } | undefined;
  signedIn = true;
  readonly calls: string[] = [];
  readonly mutations: string[] = [];

  constructor(readonly input: InstanceReservationInput) {}

  owned(): this {
    this.project = {
      labels: { 'gws-ea-instance': this.input.instance_id, 'gws-ea-managed': 'true' },
      lifecycleState: 'ACTIVE',
    };
    return this;
  }

  readonly run: GcloudCommandRunner = async (command) => {
    const projectId = this.input.exclusive_resource_claims.gcp_project_id;
    const words = command.args.filter((arg) => arg !== `--account=${ACCOUNT}` && arg !== '--quiet');
    const line = words.join(' ');
    this.calls.push(line);
    if (line === 'version --format=json') return ok('{"Google Cloud SDK":"540.0.0"}\n');
    if (line === 'auth print-access-token') {
      return this.signedIn
        ? ok('ya29.removal-canary\n')
        : failed(
            `ERROR: (gcloud.auth.print-access-token) There was a problem refreshing auth tokens for account ${ACCOUNT}: invalid_grant\n\nto obtain new credentials.`,
          );
    }
    if (!this.project) {
      return failed(
        `ERROR: (gcloud.${words.slice(0, 2).join('.')}) [${ACCOUNT}] does not have permission to access projects instance [${projectId}] (or it may not exist): The caller does not have permission.`,
      );
    }
    if (line === `projects describe ${projectId} --format=json`) {
      return ok(
        JSON.stringify({
          projectId,
          projectNumber: '441811502258',
          lifecycleState: this.project.lifecycleState,
          labels: this.project.labels,
        }),
      );
    }
    if (line === `projects delete ${projectId}`) {
      this.project.lifecycleState = 'DELETE_REQUESTED';
      this.mutations.push('projects delete');
      return ok();
    }
    if (words[0] === 'org-policies' && words[1] === 'set-policy') {
      const policy = JSON.parse(await readFile(words[2]!, 'utf8')) as {
        name: string;
        spec: { rules: { enforce: boolean }[] };
      };
      this.mutations.push(`set-policy ${policy.name.split('/').at(-1)} enforce=${policy.spec.rules[0]!.enforce}`);
      return ok();
    }
    throw new Error(`Unexpected gcloud command: ${line}`);
  };
}

/** One Cloudflare account holding this machine's tunnel, its route set, and the zone's DNS. */
class FakeCloudflare {
  tunnels: CloudflareTunnel[] = [];
  config: Record<string, unknown> = { ingress: [CATCH_ALL] };
  version = 1;
  dns: CloudflareDnsRecord[] = [];
  readonly calls: string[] = [];
  readonly onCall: Array<(call: string) => void> = [];

  #record(call: string): void {
    this.calls.push(call);
    for (const listener of this.onCall) listener(call);
  }

  api(): CloudflareApi {
    return {
      listActiveZones: vi.fn<CloudflareApi['listActiveZones']>(async () => [
        { zoneId: ZONE_ID, name: 'example.test', accountId: ACCOUNT_ID, accountName: 'Test', status: 'active' },
      ]),
      listTunnels: vi.fn(async (_account: string, name: string) => this.tunnels.filter((t) => t.name === name)),
      createTunnel: vi.fn(),
      getTunnelConfiguration: vi.fn(async () => ({ config: this.config, version: this.version })),
      replaceTunnelConfiguration: vi.fn(async (_account: string, _tunnel: string, config: unknown) => {
        this.#record('configuration');
        this.config = config as Record<string, unknown>;
        this.version += 1;
      }),
      getTunnelToken: vi.fn(),
      listTunnelConnections: vi.fn(async () => {
        this.#record('connections');
        return [];
      }),
      listDnsRecords: vi.fn(async (_zone: string, name: string) => this.dns.filter((record) => record.name === name)),
      createDnsRecord: vi.fn(),
      deleteDnsRecord: vi.fn(async (_zone: string, id: string) => {
        this.#record('dns');
        this.dns = this.dns.filter((record) => record.id !== id);
      }),
      deleteTunnel: vi.fn(async (_account: string, id: string) => {
        this.#record('tunnel');
        this.tunnels = this.tunnels.filter((tunnel) => tunnel.id !== id);
      }),
    };
  }
}

function route(input: InstanceReservationInput): Record<string, unknown> {
  const ingress = input.exclusive_resource_claims.ingress;
  if (ingress.mode !== 'managed-cloudflare') throw new Error('managed fixture');
  return {
    hostname: ingress.hostname,
    path: '^/webhook/gchat$',
    service: `http://127.0.0.1:${input.allocated_ports.nanoclaw_webhook}`,
  };
}

function dnsRecord(input: InstanceReservationInput, id = 'c'.repeat(32)): CloudflareDnsRecord {
  const ingress = input.exclusive_resource_claims.ingress;
  if (ingress.mode !== 'managed-cloudflare') throw new Error('managed fixture');
  return {
    id,
    type: 'CNAME',
    name: ingress.hostname,
    content: `${TUNNEL_ID}.cfargotunnel.com`,
    proxied: true,
    comment: `gws-ea managed ingress ${input.instance_id}`,
  };
}

async function tunnelName(paths: ControlPlanePaths): Promise<string> {
  const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare;
  if (!metadata) throw new Error('Cloudflare metadata missing');
  return metadata.tunnel_name;
}

interface World {
  readonly gcloud: FakeGcloud;
  readonly cloudflare: FakeCloudflare;
  readonly order: string[];
  readonly interaction: { [K in keyof RemovalInteraction]: ReturnType<typeof vi.fn<RemovalInteraction[K]>> };
  readonly dependencies: RemovalDependencies & {
    readonly resolveDocker: ReturnType<typeof vi.fn<NonNullable<RemovalDependencies['resolveDocker']>>>;
    readonly createCloudflareApi: ReturnType<typeof vi.fn<NonNullable<RemovalDependencies['createCloudflareApi']>>>;
  };
}

/** Every boundary faked; each records into `order` when it changes something. */
function world(input: InstanceReservationInput): World {
  const gcloud = new FakeGcloud(input);
  const cloudflare = new FakeCloudflare();
  const order: string[] = [];
  cloudflare.onCall.push((call) => {
    if (call !== 'connections') order.push(call);
  });
  const interaction = {
    signInToGoogleCloud: vi.fn<RemovalInteraction['signInToGoogleCloud']>(async () => {
      gcloud.signedIn = true;
    }),
    requestCloudflareAccountToken: vi.fn<RemovalInteraction['requestCloudflareAccountToken']>(
      async () => 'account-token-canary',
    ),
  };
  const runGcloud: GcloudCommandRunner = async (command) => {
    const outcome = await gcloud.run(command);
    if (command.args[1] === 'delete') order.push('gcp');
    return outcome;
  };
  return {
    gcloud,
    cloudflare,
    order,
    interaction,
    dependencies: {
      interaction,
      platform: 'linux',
      runGcloud,
      resolveDocker: vi.fn(async (recorded: string | undefined) => recorded ?? DOCKER),
      createCloudflareApi: vi.fn(() => cloudflare.api()),
      uninstallNanoclaw: vi.fn(async () => void order.push('nanoclaw')),
      removeOnecli: vi.fn(async () => void order.push('onecli')),
      stopCloudflareConnector: vi.fn(async () => void order.push('connector')),
      sleep: async () => undefined,
    },
  };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function expectGone(paths: ControlPlanePaths, input: InstanceReservationInput): Promise<void> {
  expect((await readRegistry(paths)).instances[input.instance_id]).toBeUndefined();
  expect(await exists(paths.instanceRoot(input.instance_id))).toBe(false);
  expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
}

describe('removal from any partial state', () => {
  it('removes a reservation with no journal locally, without gcloud, Docker, or Cloudflare', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true }), { checkout: false });
    await rm(paths.journalFile(input.instance_id));
    const { dependencies, interaction, gcloud } = world(input);

    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    await expectGone(paths, input);
    expect(gcloud.calls).toEqual([]);
    expect(dependencies.resolveDocker).not.toHaveBeenCalled();
    expect(interaction.requestCloudflareAccountToken).not.toHaveBeenCalled();
    expect(dependencies.createCloudflareApi).not.toHaveBeenCalled();
    expect(dependencies.uninstallNanoclaw).not.toHaveBeenCalled();
    expect(dependencies.removeOnecli).not.toHaveBeenCalled();
    expect(outcome).toEqual({ removed: ['instance-files'], abandoned: [] });
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare).toBeNull();
  });

  it('deletes a created project when the checkout is gone, skipping everything that never started', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths), {
      checkout: false,
      started: ['materialize_checkout', 'provision_gcp'],
    });
    const { dependencies, gcloud, order } = world(input);
    gcloud.owned();

    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    expect(order).toEqual(['gcp']);
    expect(gcloud.calls).toEqual([
      'version --format=json',
      'auth print-access-token',
      `projects describe ${input.exclusive_resource_claims.gcp_project_id} --format=json`,
      `projects delete ${input.exclusive_resource_claims.gcp_project_id}`,
      `projects describe ${input.exclusive_resource_claims.gcp_project_id} --format=json`,
    ]);
    expect(dependencies.resolveDocker).not.toHaveBeenCalled();
    expect(outcome.removed).toEqual(['gcp-project', 'instance-files']);
    await expectGone(paths, input);
  });

  it('pauses on a started project Google will not show, then abandons it on request with its evidence', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths), {
      started: ['materialize_checkout', 'provision_gcp', 'start_onecli'],
      lifted: true,
    });
    const { dependencies, gcloud } = world(input);
    const io = { out: [] as string[], err: [] as string[] };
    const cli = (args: readonly string[]): Promise<number> =>
      runCli(['remove', '--id', input.instance_id, '--yes', ...args], {
        paths,
        stdout: (line) => io.out.push(line),
        stderr: (line) => io.err.push(line),
        removeAssistant: (removalPaths, id, options) =>
          removeAssistant(removalPaths, id, { ...dependencies, ...options, interaction: dependencies.interaction }),
      });

    expect(await cli([])).toBe(10);
    const paused = io.out.join('\n');
    expect(paused).toContain('Paused at remove_gcp_project');
    expect(paused).toContain(input.exclusive_resource_claims.gcp_project_id);
    expect(paused).toContain('(or it may not exist)');
    expect(paused).toContain(`gws-ea remove --id ${input.instance_id} --yes --abandon gcp-project`);
    expect(gcloud.mutations).toEqual([]);
    expect((await readRegistry(paths)).instances[input.instance_id]).toBeDefined();

    // Abandoning records the evidence and the policy lift it could not restore, and continues.
    const removeOnecli = vi
      .fn<NonNullable<RemovalDependencies['removeOnecli']>>()
      .mockRejectedValueOnce(new GwsEaError('docker_stopped', 'Docker is not running'))
      .mockResolvedValueOnce(undefined);
    await expect(
      removeAssistant(paths, input.instance_id, { ...dependencies, removeOnecli, abandon: new Set(['gcp-project']) }),
    ).rejects.toMatchObject({ code: 'docker_stopped' });
    const receipt = JSON.parse(await readFile(paths.removalFile(input.instance_id), 'utf8')) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schema_version: 3,
      instance_id: input.instance_id,
      reservation: input,
      completed: {},
      abandoned: {
        'gcp-project': { at: expect.any(String), evidence: expect.stringContaining('(or it may not exist)') },
      },
      key_policy_unrestored: { at: expect.any(String), evidence: expect.stringContaining('may not exist') },
    });

    io.out.length = 0;
    expect(await cli(['--abandon', 'gcp-project'])).toBe(0);
    expect(io.out.join('\n')).toContain(
      `Left behind: Google Cloud project ${input.exclusive_resource_claims.gcp_project_id}`,
    );
    expect(io.out.join('\n')).toContain('key-creation policy');
    expect(gcloud.mutations).toEqual([]);
    await expectGone(paths, input);
  });

  it('pauses when the token cannot see the reserved zone, then leaves only its DNS record behind on request', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true, dns: true }), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    const ingress = input.exclusive_resource_claims.ingress;
    if (ingress.mode !== 'managed-cloudflare') throw new Error('expected managed ingress');
    await recordTunnel(paths);
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const { dependencies, cloudflare, order } = world(input);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    cloudflare.config = { ingress: [route(input), CATCH_ALL] };
    // The domain was deleted and added again: the token works, but the reserved zone is gone.
    const api: CloudflareApi = {
      ...cloudflare.api(),
      listActiveZones: vi.fn<CloudflareApi['listActiveZones']>(async () => [
        {
          zoneId: 'e'.repeat(32),
          name: ingress.zone_name,
          accountId: ACCOUNT_ID,
          accountName: 'Test',
          status: 'active',
        },
      ]),
    };
    const io = { out: [] as string[], err: [] as string[] };
    const cli = (args: readonly string[]): Promise<number> =>
      runCli(['remove', '--id', input.instance_id, '--yes', ...args], {
        paths,
        stdout: (line) => io.out.push(line),
        stderr: (line) => io.err.push(line),
        removeAssistant: (removalPaths, id, options) =>
          removeAssistant(removalPaths, id, {
            ...dependencies,
            createCloudflareApi: () => api,
            ...options,
            interaction: dependencies.interaction,
          }),
      });

    expect(await cli([])).toBe(10);
    const paused = io.out.join('\n');
    expect(paused).toContain('Paused at prerequisites');
    expect(paused).toContain(`Cloudflare cannot see zone ${ingress.zone_name}`);
    expect(paused).toContain(`${ingress.zone_name} is now a different zone`);
    expect(paused).toContain(`gws-ea remove --id ${input.instance_id} --yes --abandon cloudflare-dns`);
    expect(order).toEqual([]);
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);

    io.out.length = 0;
    expect(await cli(['--abandon', 'cloudflare-dns'])).toBe(0);
    expect(order).toEqual(['configuration', 'connector', 'tunnel']);
    expect(api.listDnsRecords).not.toHaveBeenCalled();
    expect(io.out.join('\n')).toContain(`Left behind: DNS record ${ingress.hostname}`);
    await expectGone(paths, input);
  });

  it('restores a lifted key-creation policy before it deletes the project', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths), {
      started: ['materialize_checkout', 'provision_gcp'],
      lifted: true,
    });
    const { dependencies, gcloud } = world(input);
    gcloud.owned();

    await expect(removeAssistant(paths, input.instance_id, dependencies)).resolves.toMatchObject({ abandoned: [] });

    expect(gcloud.mutations).toEqual([
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
      'projects delete',
    ]);
  });

  it('never asks for a Cloudflare token when establish_transport never started, though a hostname is claimed', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true }), {
      started: ['materialize_checkout', 'provision_gcp', 'start_onecli', 'configure_provider', 'start_nanoclaw'],
    });
    const { dependencies, interaction, gcloud, order } = world(input);
    gcloud.owned();

    await removeAssistant(paths, input.instance_id, dependencies);

    expect(interaction.requestCloudflareAccountToken).not.toHaveBeenCalled();
    expect(dependencies.createCloudflareApi).not.toHaveBeenCalled();
    expect(dependencies.resolveDocker).toHaveBeenCalledOnce();
    expect(order).toEqual(['nanoclaw', 'gcp', 'onecli']);
    await expectGone(paths, input);
  });

  it("removes the route a peer wrote into the shared set, though this assistant's transport never started", async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true }), {
      started: ['materialize_checkout'],
    });
    const peer = await reserve(
      paths,
      reservationInput(paths, { managed: true, dns: true, label: 'peer', port: 34_001 }),
    );
    await recordTunnel(paths);
    const { dependencies, cloudflare, interaction, order } = world(input);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    cloudflare.config = { ingress: [route(peer), route(input), CATCH_ALL] };
    const api = cloudflare.api();

    await removeAssistant(paths, input.instance_id, { ...dependencies, createCloudflareApi: () => api });

    expect(interaction.requestCloudflareAccountToken).toHaveBeenCalledOnce();
    expect(order).toEqual(['configuration']);
    expect(cloudflare.config).toEqual({ ingress: [route(peer), CATCH_ALL] });
    expect(api.listDnsRecords).not.toHaveBeenCalled();
    expect(dependencies.resolveDocker).not.toHaveBeenCalled();
    await expectGone(paths, input);
  });

  it('adopts and removes a tunnel under this machine name whose ID was never recorded', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true }), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const { dependencies, cloudflare, order } = world(input);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    cloudflare.config = { ingress: [route(input), CATCH_ALL] };
    cloudflare.dns = [dnsRecord(input)];

    await removeAssistant(paths, input.instance_id, dependencies);

    expect(order).toEqual(['configuration', 'dns', 'connector', 'tunnel']);
    expect(cloudflare.config).toEqual({ ingress: [CATCH_ALL] });
    expect(cloudflare.tunnels).toEqual([]);
    expect(await exists(paths.cloudflareRoot)).toBe(false);
    await expectGone(paths, input);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare).toBeNull();
  });

  it('retires a tunnel whose creation started but was never recorded, from a peer that never set up transport', async () => {
    const paths = await testPaths();
    const crashed = await reserve(paths, reservationInput(paths, { managed: true }), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    const unstarted = await reserve(paths, reservationInput(paths, { managed: true, label: 'peer', port: 34_001 }), {
      started: ['materialize_checkout'],
    });
    // The crash: Cloudflare created the tunnel, and only the start of its creation was recorded.
    await withLockedCloudflareRegistry(paths, (locked) => locked.recordTunnelCreationStarted());
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const { dependencies, cloudflare } = world(crashed);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    const stopConnector = vi.fn(async () => undefined);
    const shared = { createCloudflareApi: () => cloudflare.api(), stopCloudflareConnector: stopConnector };

    // The crashed assistant's removal leaves the tunnel to the peer still registered.
    await removeAssistant(paths, crashed.instance_id, { ...dependencies, ...shared });
    expect(cloudflare.tunnels).toHaveLength(1);
    expect(stopConnector).not.toHaveBeenCalled();

    // The peer never set up transport, but the recorded creation tells its removal a tunnel may exist.
    const peer = world(unstarted);
    await removeAssistant(paths, unstarted.instance_id, { ...peer.dependencies, ...shared });
    expect(peer.interaction.requestCloudflareAccountToken).toHaveBeenCalledOnce();
    expect(stopConnector).toHaveBeenCalledOnce();
    expect(cloudflare.tunnels).toEqual([]);
    expect(await exists(paths.cloudflareRoot)).toBe(false);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare).toBeNull();
  });

  it('removes an unfinished create with the token it kept, asking only when Cloudflare refuses it', async () => {
    for (const refused of [false, true]) {
      const paths = await testPaths();
      const input = await reserve(paths, reservationInput(paths, { managed: true }), {
        started: ['materialize_checkout', 'establish_transport'],
      });
      await recordTunnel(paths);
      await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
      await keepAccountToken(paths.keptCloudflareTokenFile(input.instance_id), 'kept-account-token');
      const { dependencies, cloudflare, interaction } = world(input);
      cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
      cloudflare.config = { ingress: [route(input), CATCH_ALL] };
      const tokens: string[] = [];
      const createCloudflareApi = (token: string): CloudflareApi => {
        tokens.push(token);
        const api = cloudflare.api();
        if (!refused || token !== 'kept-account-token') return api;
        return {
          ...api,
          listActiveZones: vi.fn<CloudflareApi['listActiveZones']>(async () => {
            throw new GwsEaError('cloudflare_capability_missing', 'Cloudflare refused the token');
          }),
        };
      };

      await removeAssistant(paths, input.instance_id, { ...dependencies, createCloudflareApi });

      expect(interaction.requestCloudflareAccountToken).toHaveBeenCalledTimes(refused ? 1 : 0);
      expect(tokens).toEqual(refused ? ['kept-account-token', 'account-token-canary'] : ['kept-account-token']);
      expect(cloudflare.tunnels).toEqual([]);
      await expectGone(paths, input);
      await expect(stat(paths.keptCloudflareTokenFile(input.instance_id))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each([
    ['cannot see the reserved zone', { code: 'cloudflare_dns_unobservable', resource: 'cloudflare-dns' }],
    ['is refused deleting the tunnel', { code: 'cloudflare_capability_missing' }],
  ])('forgets a kept token that %s, so the rerun asks for another', async (failure, stopped) => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true }), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    await recordTunnel(paths);
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const kept = paths.keptCloudflareTokenFile(input.instance_id);
    await keepAccountToken(kept, 'kept-account-token');
    const { dependencies, cloudflare, interaction } = world(input);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    cloudflare.config = { ingress: [route(input), CATCH_ALL] };
    const createCloudflareApi = (token: string): CloudflareApi => {
      const api = cloudflare.api();
      if (token !== 'kept-account-token') return api;
      if (failure === 'cannot see the reserved zone') {
        return {
          ...api,
          listActiveZones: vi.fn<CloudflareApi['listActiveZones']>(async () => [
            {
              zoneId: 'e'.repeat(32),
              name: 'other.test',
              accountId: ACCOUNT_ID,
              accountName: 'Test',
              status: 'active',
            },
          ]),
        };
      }
      return {
        ...api,
        deleteTunnel: vi.fn<CloudflareApi['deleteTunnel']>(async () => {
          throw new GwsEaError('cloudflare_capability_missing', 'Cloudflare refused the token');
        }),
      };
    };

    await expect(
      removeAssistant(paths, input.instance_id, { ...dependencies, createCloudflareApi }),
    ).rejects.toMatchObject(stopped);
    await expect(stat(kept)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(interaction.requestCloudflareAccountToken).not.toHaveBeenCalled();

    await removeAssistant(paths, input.instance_id, { ...dependencies, createCloudflareApi });
    expect(interaction.requestCloudflareAccountToken).toHaveBeenCalledOnce();
    expect(cloudflare.tunnels).toEqual([]);
    await expectGone(paths, input);
  });

  it('counts an already-removed route and an already-deleted DNS record as done', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true, dns: true }), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    const peer = await reserve(
      paths,
      reservationInput(paths, { managed: true, dns: true, label: 'peer', port: 34_001 }),
    );
    await recordTunnel(paths);
    const { dependencies, cloudflare, order } = world(input);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    // A peer's reconciliation already left the removing assistant out of the route set.
    cloudflare.config = { ingress: [route(peer), CATCH_ALL] };
    cloudflare.dns = [dnsRecord(input)];
    const api = cloudflare.api();
    // Another run deleted the record between this run's read and its delete.
    api.deleteDnsRecord = vi.fn(async () => {
      cloudflare.dns = [];
      throw new GwsEaError('cloudflare_api_failed', 'Cloudflare could not delete the owned DNS record (HTTP 404)');
    });

    await removeAssistant(paths, input.instance_id, { ...dependencies, createCloudflareApi: () => api });

    expect(api.replaceTunnelConfiguration).not.toHaveBeenCalled();
    expect(api.deleteDnsRecord).toHaveBeenCalledOnce();
    expect(order).toEqual([]);
    await expectGone(paths, input);
    expect((await readRegistry(paths)).instances[peer.instance_id]).toEqual(peer);
  });

  it('retires the connector and tunnel under the machine lock only for the last managed assistant', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true, dns: true }), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    const peer = await reserve(
      paths,
      reservationInput(paths, { managed: true, dns: true, label: 'peer', port: 34_001 }),
      {
        started: ['materialize_checkout', 'establish_transport'],
      },
    );
    await recordTunnel(paths);
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const { dependencies, cloudflare, order } = world(input);
    const name = await tunnelName(paths);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name }];
    cloudflare.config = { ingress: [route(peer), route(input), CATCH_ALL] };
    cloudflare.dns = [dnsRecord(input), dnsRecord(peer, 'd'.repeat(32))];
    const lockHeld: Record<string, boolean> = {};
    cloudflare.onCall.push((call) => {
      lockHeld[call] = processLockOwner(paths.registryLock)?.pid === process.pid;
    });
    const stopConnector = vi.fn(async () => {
      lockHeld.connector = processLockOwner(paths.registryLock)?.pid === process.pid;
      order.push('connector');
    });

    // With a peer present, only the assistant's own route and record go.
    await removeAssistant(paths, input.instance_id, { ...dependencies, stopCloudflareConnector: stopConnector });
    expect(order).toEqual(['configuration', 'dns']);
    expect(cloudflare.config).toEqual({ ingress: [route(peer), CATCH_ALL] });
    expect(cloudflare.tunnels).toEqual([{ id: TUNNEL_ID, name }]);
    expect(stopConnector).not.toHaveBeenCalled();
    expect(await exists(paths.cloudflareRoot)).toBe(true);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare?.tunnel_id).toBe(TUNNEL_ID);

    // The last managed assistant retires the shared connector and tunnel.
    order.length = 0;
    const last = world(peer);
    last.cloudflare.tunnels = cloudflare.tunnels;
    last.cloudflare.config = cloudflare.config;
    last.cloudflare.dns = cloudflare.dns;
    last.cloudflare.onCall.push((call) => {
      lockHeld[call] = processLockOwner(paths.registryLock)?.pid === process.pid;
    });
    await removeAssistant(paths, peer.instance_id, { ...last.dependencies, stopCloudflareConnector: stopConnector });
    expect(last.order).toEqual(['configuration', 'dns', 'tunnel']);
    expect(stopConnector).toHaveBeenCalledOnce();
    expect(stopConnector).toHaveBeenCalledWith(
      expect.objectContaining({ rootDirectory: paths.cloudflareRoot }),
      DOCKER,
    );
    expect(lockHeld).toMatchObject({ configuration: true, connector: true, connections: true, tunnel: true });
    expect(last.cloudflare.tunnels).toEqual([]);
    expect(await exists(paths.cloudflareRoot)).toBe(false);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare).toBeNull();
  });

  it('retires the tunnel with the last route to leave, though an earlier removal is still paused', async () => {
    const paths = await testPaths();
    const paused = await reserve(paths, reservationInput(paths, { managed: true, dns: true }), {
      started: ['materialize_checkout', 'provision_gcp', 'establish_transport'],
    });
    const last = await reserve(
      paths,
      reservationInput(paths, { managed: true, dns: true, label: 'peer', port: 34_001 }),
      { started: ['materialize_checkout', 'establish_transport'] },
    );
    await recordTunnel(paths);
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const { dependencies, cloudflare, interaction } = world(paused);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    cloudflare.config = { ingress: [route(paused), route(last), CATCH_ALL] };
    cloudflare.dns = [dnsRecord(paused), dnsRecord(last, 'd'.repeat(32))];
    const stopConnector = vi.fn(async () => undefined);
    const shared = { createCloudflareApi: () => cloudflare.api(), stopCloudflareConnector: stopConnector };

    // A live peer keeps the tunnel; the paused removal's own route and record are gone.
    await expect(removeAssistant(paths, paused.instance_id, { ...dependencies, ...shared })).rejects.toBeInstanceOf(
      RemovalPause,
    );
    expect(cloudflare.config).toEqual({ ingress: [route(last), CATCH_ALL] });
    expect(cloudflare.tunnels).toHaveLength(1);
    expect(stopConnector).not.toHaveBeenCalled();

    // The paused removal no longer needs the tunnel, so the last route to leave retires it.
    await removeAssistant(paths, last.instance_id, { ...world(last).dependencies, ...shared });
    expect(stopConnector).toHaveBeenCalledOnce();
    expect(cloudflare.calls.filter((call) => call === 'tunnel')).toHaveLength(1);
    expect(cloudflare.tunnels).toEqual([]);
    expect(cloudflare.dns).toEqual([]);
    expect(await exists(paths.cloudflareRoot)).toBe(false);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare?.tunnel_id).toBeNull();

    // Finishing the paused removal never asks Cloudflare again.
    const outcome = await removeAssistant(paths, paused.instance_id, {
      ...dependencies,
      ...shared,
      abandon: new Set(['gcp-project']),
    });
    expect(interaction.requestCloudflareAccountToken).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      removed: ['managed-ingress', 'instance-files'],
      abandoned: [{ resource: 'gcp-project' }],
    });
    await expectGone(paths, paused);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare).toBeNull();
  });

  it('retires the tunnel exactly once when the last two managed assistants are removed together', async () => {
    const paths = await testPaths();
    const started = ['materialize_checkout', 'establish_transport', 'start_nanoclaw'] as const;
    const first = await reserve(paths, reservationInput(paths, { managed: true, dns: true }), { started });
    const second = await reserve(
      paths,
      reservationInput(paths, { managed: true, dns: true, label: 'peer', port: 34_001 }),
      { started },
    );
    await recordTunnel(paths);
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const cloudflare = new FakeCloudflare();
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    cloudflare.config = { ingress: [route(first), route(second), CATCH_ALL] };
    cloudflare.dns = [dnsRecord(first), dnsRecord(second, 'd'.repeat(32))];
    const stopConnector = vi.fn(async () => undefined);
    // Neither assistant leaves the registry until both have decided about the tunnel.
    let decided = 0;
    let bothDecided = (): void => undefined;
    const decisions = new Promise<void>((resolve) => {
      bothDecided = resolve;
    });
    const uninstallNanoclaw = vi.fn(async () => {
      decided += 1;
      if (decided === 2) bothDecided();
      await decisions;
    });
    const remove = (input: InstanceReservationInput) =>
      removeAssistant(paths, input.instance_id, {
        ...world(input).dependencies,
        createCloudflareApi: () => cloudflare.api(),
        stopCloudflareConnector: stopConnector,
        uninstallNanoclaw,
      });

    await Promise.all([remove(first), remove(second)]);

    expect(uninstallNanoclaw).toHaveBeenCalledTimes(2);
    expect(stopConnector).toHaveBeenCalledOnce();
    expect(cloudflare.calls.filter((call) => call === 'tunnel')).toHaveLength(1);
    expect(cloudflare.tunnels).toEqual([]);
    expect(cloudflare.dns).toEqual([]);
    expect(cloudflare.config).toEqual({ ingress: [CATCH_ALL] });
    await expectGone(paths, first);
    await expectGone(paths, second);
    expect(await exists(paths.cloudflareRoot)).toBe(false);
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare).toBeNull();
  });

  it("does not let one assistant's stuck removal block creating, resuming, or removing another", async () => {
    const paths = await testPaths();
    const stuck = await reserve(paths, reservationInput(paths, { managed: true, dns: true }), {
      started: ['materialize_checkout', 'provision_gcp', 'establish_transport'],
    });
    await recordTunnel(paths);
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const { dependencies, cloudflare } = world(stuck);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    cloudflare.config = { ingress: [route(stuck), CATCH_ALL] };
    cloudflare.dns = [dnsRecord(stuck)];

    await expect(removeAssistant(paths, stuck.instance_id, dependencies)).rejects.toBeInstanceOf(PauseRequired);
    await expect(access(paths.removalFile(stuck.instance_id))).resolves.toBeUndefined();
    // The retired tunnel is forgotten, so the next managed assistant creates a fresh one.
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare?.tunnel_id).toBeNull();

    const next = await reserve(paths, reservationInput(paths, { managed: true, label: 'next', port: 35_001 }));
    const operation = await acquireInstanceOperation(paths, next.instance_id);
    expect(operation).not.toBeNull();
    operation?.release();
    await removeAssistant(paths, next.instance_id, world(next).dependencies);
    await expectGone(paths, next);

    await expect(acquireInstanceOperation(paths, stuck.instance_id)).rejects.toMatchObject({
      code: 'removal_in_progress',
    });
    expect((await readRegistry(paths)).instances[stuck.instance_id]).toEqual(stuck);
  });

  it('removes an instance an earlier launcher left mid-removal, from its own state files', async () => {
    const paths = await testPaths();
    const instanceId = allocateInstanceId();
    const ownershipId = allocateInstanceId();
    const fixtures = path.join(import.meta.dirname, '__fixtures__', 'pre-v3');
    const values: Record<string, string> = {
      INSTANCE_ID: instanceId,
      INSTALL_ID: instanceId.replaceAll('-', ''),
      GCP_PROJECT: projectFor(instanceId),
      CHECKOUT: paths.checkoutRoot(instanceId),
      SECRETS: path.join(paths.instanceRoot(instanceId), 'secrets'),
      OWNERSHIP_ID: ownershipId,
      TUNNEL_NAME: `gws-ea-${ownershipId.replaceAll('-', '')}`,
      TUNNEL_ID,
      HOME: path.join(paths.stateRoot, 'home'),
    };
    const load = async (name: string): Promise<unknown> =>
      JSON.parse(
        (await readFile(path.join(fixtures, name), 'utf8')).replaceAll(/__([A-Z_]+)__/gu, (_match, key: string) => {
          const value = values[key];
          if (value === undefined) throw new Error(`Unknown fixture value ${key}`);
          return value;
        }),
      );
    await writePrivate(paths.registryFile, await load('instances.json'));
    await mkdir(path.join(paths.checkoutRoot(instanceId), 'data', 'gws-ea'), { recursive: true, mode: 0o700 });
    await writeInstanceMarker(paths, instanceId);
    await writePrivate(paths.journalFile(instanceId), await load('provision.json'));
    await writePrivate(
      path.join(paths.checkoutRoot(instanceId), 'data', 'gws-ea', 'runtime.json'),
      await load('runtime.json'),
    );
    await writePrivate(paths.removalFile(instanceId), await load('removal.json'));
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const reservation = (await readRegistry(paths)).instances[instanceId]!;
    const { dependencies, gcloud, cloudflare, order } = world(reservation);
    gcloud.owned();
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: values.TUNNEL_NAME! }];
    cloudflare.dns = [dnsRecord(reservation)];

    const outcome = await removeAssistant(paths, instanceId, dependencies);

    // An earlier journal is unreadable to this launcher, so every resource is observed.
    expect(order).toEqual(['dns', 'connector', 'tunnel', 'nanoclaw', 'gcp', 'onecli']);
    expect(outcome.removed).toEqual(['managed-ingress', 'nanoclaw', 'gcp-project', 'onecli', 'instance-files']);
    // The earlier runtime recorded no Docker endpoint, so the active one is used; the OneCLI CLI is its own.
    expect(dependencies.resolveDocker).toHaveBeenCalledWith(undefined);
    expect(dependencies.removeOnecli).toHaveBeenCalledWith(reservation, {
      homeDirectory: values.HOME,
      dockerEndpoint: DOCKER,
      onecliCliPath: '/opt/onecli/bin/onecli',
    });
    await expectGone(paths, reservation);
    expect(await readRegistry(paths)).toMatchObject({
      instances: {},
      shared_infrastructure_metadata: { cloudflare: null },
    });
  });
});

describe('removal safety', () => {
  it('refuses before any effect when the checkout exists without its marker', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths), { started: ['materialize_checkout', 'provision_gcp'] });
    await rm(paths.markerFile(input.instance_id));
    const { dependencies, gcloud } = world(input);

    await expect(removeAssistant(paths, input.instance_id, dependencies)).rejects.toMatchObject({
      code: 'marker_missing',
    });
    expect(gcloud.calls).toEqual([]);
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
  });

  it('resumes after a failure without repeating completed teardown', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths), {
      started: ['materialize_checkout', 'provision_gcp', 'start_onecli', 'start_nanoclaw'],
    });
    const { dependencies, gcloud } = world(input);
    gcloud.owned();
    const removeOnecli = vi
      .fn<NonNullable<RemovalDependencies['removeOnecli']>>()
      .mockRejectedValueOnce(new Error('docker unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(removeAssistant(paths, input.instance_id, { ...dependencies, removeOnecli })).rejects.toThrow(
      /docker unavailable/u,
    );
    await removeAssistant(paths, input.instance_id, { ...dependencies, removeOnecli });

    expect(dependencies.uninstallNanoclaw).toHaveBeenCalledOnce();
    expect(gcloud.mutations).toEqual(['projects delete']);
    expect(removeOnecli).toHaveBeenCalledTimes(2);
    await expectGone(paths, input);
  });

  it('signs in once when Google sign-in expired, then continues', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths), { started: ['materialize_checkout', 'provision_gcp'] });
    const { dependencies, gcloud, interaction } = world(input);
    gcloud.owned().signedIn = false;

    await removeAssistant(paths, input.instance_id, dependencies);

    expect(interaction.signInToGoogleCloud).toHaveBeenCalledExactlyOnceWith(ACCOUNT);
    expect(gcloud.mutations).toEqual(['projects delete']);
  });

  it('checks the exact reserved zone before recording removal, and pauses when the token cannot see it', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true }), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    const { dependencies, cloudflare } = world(input);
    const api = cloudflare.api();
    api.listActiveZones = vi.fn<CloudflareApi['listActiveZones']>(async () => [
      { zoneId: 'e'.repeat(32), name: 'other.test', accountId: ACCOUNT_ID, accountName: 'Test', status: 'active' },
    ]);

    await expect(
      removeAssistant(paths, input.instance_id, { ...dependencies, createCloudflareApi: () => api }),
    ).rejects.toMatchObject({ code: 'cloudflare_dns_unobservable', resource: 'cloudflare-dns' });
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
    expect(api.listTunnels).not.toHaveBeenCalled();
  });

  it('refuses a foreign DNS record by name and never stores the account token', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true, dns: true }), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    await reserve(paths, reservationInput(paths, { managed: true, label: 'peer', port: 34_001 }));
    await recordTunnel(paths);
    const { dependencies, cloudflare } = world(input);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    cloudflare.dns = [{ ...dnsRecord(input), comment: 'somebody else' }];

    await expect(removeAssistant(paths, input.instance_id, dependencies)).rejects.toMatchObject({
      code: 'foreign_cloudflare_dns',
      message: expect.stringContaining('target.example.test'),
    });
    expect(cloudflare.dns).toHaveLength(1);
    expect(await readFile(paths.registryFile, 'utf8')).not.toContain('account-token-canary');
    expect(await readFile(paths.removalFile(input.instance_id), 'utf8')).not.toContain('account-token-canary');
  });

  it('keeps existing-endpoint removal free of Cloudflare', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    const { dependencies, interaction } = world(input);

    await removeAssistant(paths, input.instance_id, dependencies);

    expect(interaction.requestCloudflareAccountToken).not.toHaveBeenCalled();
    expect(dependencies.createCloudflareApi).not.toHaveBeenCalled();
  });

  it.each(['linux', 'macos'] as const)(
    'stops the %s service through its manager and cleans Docker at the recorded endpoint',
    async (platform) => {
      const paths = await testPaths();
      const input = await reserve(paths, reservationInput(paths), {
        started: ['materialize_checkout', 'start_nanoclaw'],
      });
      const home = path.join(paths.stateRoot, 'home');
      const recorded = 'unix:///run/user/501/docker.sock';
      await writePrivate(path.join(input.checkout_realpath, 'data', 'gws-ea', 'runtime.json'), {
        home_directory: home,
        docker_endpoint: recorded,
      });
      const names = getInstallScopedNames(input.instance_id.replaceAll('-', ''));
      const definition =
        platform === 'linux'
          ? path.join(home, '.config', 'systemd', 'user', `${names.systemdUnit}.service`)
          : path.join(home, 'Library', 'LaunchAgents', `${names.launchdLabel}.plist`);
      await mkdir(path.dirname(definition), { recursive: true });
      await writeFile(definition, 'unit', { mode: 0o600 });
      const commands: SanitizedCommand[] = [];
      const runCommand = async (command: SanitizedCommand): Promise<SanitizedCommandOutcome> => {
        commands.push(command);
        if (['pkill', 'pgrep'].includes(command.command)) return failed('');
        if (command.args.includes('is-active')) return { stdout: 'inactive\n', stderr: '', exitCode: 3 };
        if (command.args[0] === 'print') return { stdout: '', stderr: 'Could not find service', exitCode: 113 };
        return ok();
      };
      const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;

      await removeAssistant(paths, input.instance_id, { ...dependencies, platform, runCommand });

      expect(await exists(definition)).toBe(false);
      const service = commands.filter((command) => ['launchctl', 'systemctl'].includes(command.command));
      if (platform === 'linux') {
        expect(service.map((command) => command.args.join(' '))).toEqual([
          `--user disable --now ${names.systemdUnit}.service`,
          `--user is-active ${names.systemdUnit}.service`,
          '--user daemon-reload',
        ]);
        for (const command of service) {
          expect(command.env).toMatchObject({
            XDG_RUNTIME_DIR: expect.any(String),
            DBUS_SESSION_BUS_ADDRESS: expect.any(String),
          });
        }
      } else {
        const domain = `gui/${process.getuid!()}/${names.launchdLabel}`;
        expect(service.map((command) => command.args.join(' '))).toEqual([`bootout ${domain}`, `print ${domain}`]);
      }
      const docker = commands.filter((command) => command.command === 'docker');
      expect(docker.map((command) => command.args.slice(0, 2).join(' '))).toEqual(['ps -aq', 'image ls']);
      for (const command of docker) expect(command.env?.DOCKER_HOST).toBe(recorded);
      await expectGone(paths, input);
    },
  );

  it('stops before deleting a retiring tunnel whose connector sessions never clear', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths, { managed: true }), {
      started: ['materialize_checkout', 'establish_transport'],
    });
    await recordTunnel(paths);
    await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
    const { dependencies, cloudflare } = world(input);
    const tunnel = { id: TUNNEL_ID, name: await tunnelName(paths) };
    cloudflare.tunnels = [tunnel];
    cloudflare.config = { ingress: [route(input), CATCH_ALL] };
    const connections = vi.fn(async () => [{ id: 'connector-session' }]);
    const sleep = vi.fn(async () => undefined);

    await expect(
      removeAssistant(paths, input.instance_id, {
        ...dependencies,
        createCloudflareApi: () => ({ ...cloudflare.api(), listTunnelConnections: connections }),
        sleep,
      }),
    ).rejects.toMatchObject({ code: 'cloudflare_connections_active' });
    expect(connections).toHaveBeenCalledTimes(30);
    expect(sleep).toHaveBeenCalledTimes(29);
    expect(cloudflare.tunnels).toEqual([tunnel]);
  });

  it('waits for a stray NanoClaw host it stopped to exit, and names one that never does', async () => {
    for (const exitsAfter of [2, Infinity]) {
      const paths = await testPaths();
      const input = await reserve(paths, reservationInput(paths), {
        started: ['materialize_checkout', 'start_nanoclaw'],
      });
      let checks = 0;
      const runCommand = async (command: SanitizedCommand): Promise<SanitizedCommandOutcome> => {
        if (command.command !== 'pgrep') return ok();
        checks += 1;
        return checks > exitsAfter ? failed('') : ok();
      };
      const sleep = vi.fn(async () => undefined);
      const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;

      const removal = removeAssistant(paths, input.instance_id, { ...dependencies, runCommand, sleep });
      if (exitsAfter === Infinity) {
        await expect(removal).rejects.toMatchObject({ code: 'nanoclaw_removal_incomplete' });
        expect(checks).toBe(10);
      } else {
        await removal;
        expect(checks).toBe(3);
        await expectGone(paths, input);
      }
      expect(sleep).toHaveBeenCalledTimes(checks - 1);
    }
  });
});

describe('removal command', () => {
  function cliRuntime(paths: ControlPlanePaths, output: string[], extra: Partial<CliRuntime> = {}): CliRuntime {
    return { paths, stdout: (line) => output.push(line), stderr: () => undefined, ...extra };
  }

  it('previews removal and defaults to leaving the assistant unchanged', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths));
    const output: string[] = [];
    const remove = vi.fn();

    const exitCode = await runCli(
      ['remove', '--id', input.instance_id],
      cliRuntime(paths, output, { removeAssistant: remove, confirmRemoval: async () => false }),
    );

    expect(exitCode).toBe(0);
    expect(output).toContain(`Google Cloud project: ${input.exclusive_resource_claims.gcp_project_id} (${ACCOUNT})`);
    expect(output).toContain('Removal cancelled. Nothing was changed.');
    expect(remove).not.toHaveBeenCalled();
  });

  it('supports an explicit non-interactive confirmation and names what was abandoned', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths));
    const output: string[] = [];
    const remove = vi.fn(async () => ({
      removed: ['instance-files' as const],
      abandoned: [{ resource: 'gcp-project' as const, evidence: 'denied' }],
    }));

    expect(
      await runCli(
        ['remove', '--id', input.instance_id, '--yes', '--abandon', 'gcp-project'],
        cliRuntime(paths, output, {
          removeAssistant: remove,
          confirmRemoval: async () => {
            throw new Error('confirmation must be skipped');
          },
        }),
      ),
    ).toBe(0);
    expect(remove).toHaveBeenCalledWith(
      paths,
      input.instance_id,
      expect.objectContaining({ abandon: new Set(['gcp-project']) }),
    );
    expect(output.join('\n')).toContain(
      `Left behind: Google Cloud project ${input.exclusive_resource_claims.gcp_project_id}`,
    );
  });

  it('rejects an unknown resource to abandon before anything runs', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(paths));
    const errors: string[] = [];
    const remove = vi.fn();

    expect(
      await runCli(['remove', '--id', input.instance_id, '--yes', '--abandon', 'registry'], {
        paths,
        stdout: () => undefined,
        stderr: (line) => errors.push(line),
        removeAssistant: remove,
      }),
    ).toBe(1);
    expect(errors.join('\n')).toContain('--abandon');
    expect(remove).not.toHaveBeenCalled();
  });

  it('previews exact managed ownership and whether shared ingress is retained or retired', async () => {
    const paths = await testPaths();
    const target = await reserve(paths, reservationInput(paths, { managed: true, dns: true }));
    await reserve(paths, reservationInput(paths, { managed: true, label: 'peer', port: 34_001 }));
    const output: string[] = [];
    const requestToken = vi.fn(async (_request: CloudflareTokenRequest) => 'token-canary');

    expect(
      await runCli(
        ['remove', '--id', target.instance_id],
        cliRuntime(paths, output, {
          confirmRemoval: async () => false,
          prompts: {
            providerCredential: vi.fn(),
            cloudflareAccountToken: requestToken,
            googleCloudSignIn: vi.fn(),
            googleAccount: vi.fn(),
            attendPause: async () => ({ kind: 'stop' }),
          },
        }),
      ),
    ).toBe(0);

    expect(output).toContain('Managed hostname: target.example.test');
    expect(output).toContain('Managed callback: https://target.example.test/webhook/gchat');
    expect(output).toContain(`Owned DNS record: ${'c'.repeat(32)}`);
    expect(output).toContain('Owned tunnel route: target.example.test ^/webhook/gchat$');
    expect(output).toContain('Shared Cloudflare ingress: retained for other assistants');
    expect(requestToken).not.toHaveBeenCalled();

    const finalPaths = await testPaths();
    const final = await reserve(finalPaths, reservationInput(finalPaths, { managed: true }));
    const finalOutput: string[] = [];
    await runCli(
      ['remove', '--id', final.instance_id],
      cliRuntime(finalPaths, finalOutput, { confirmRemoval: async () => false }),
    );
    expect(finalOutput).toContain('Shared Cloudflare ingress: retired after this final managed callback');
  });

  it('previews shared ingress as retired once the only other managed removal has taken its route down', async () => {
    const paths = await testPaths();
    const target = await reserve(paths, reservationInput(paths, { managed: true, dns: true }));
    const paused = await reserve(paths, reservationInput(paths, { managed: true, label: 'peer', port: 34_001 }), {
      started: ['materialize_checkout', 'provision_gcp'],
    });
    await recordTunnel(paths);
    const { dependencies, cloudflare } = world(paused);
    cloudflare.tunnels = [{ id: TUNNEL_ID, name: await tunnelName(paths) }];
    cloudflare.config = { ingress: [route(target), route(paused), CATCH_ALL] };
    const sharedIngress = async () => {
      const { ingress } = await describeRemoval(paths, target.instance_id);
      return ingress.mode === 'managed-cloudflare' ? ingress.sharedIngress : undefined;
    };

    expect(await sharedIngress()).toBe('retained-for-peers');
    await expect(removeAssistant(paths, paused.instance_id, dependencies)).rejects.toBeInstanceOf(RemovalPause);
    expect(cloudflare.config).toEqual({ ingress: [route(target), CATCH_ALL] });
    expect(await sharedIngress()).toBe('retired');
  });
});
