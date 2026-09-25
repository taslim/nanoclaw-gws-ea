import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';
import { acquireInstanceOperation } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { readRegistry, reserveInstance, withLockedCloudflareRegistry, writeInstanceMarker } from './registry.js';
import { removeAssistant } from './remove.js';
import { allocateInstanceId } from './registry.js';
import type { CloudflareApi, CloudflareDnsRecord } from './cloudflare-api.js';
import type { InstanceReservationInput } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ paths: ControlPlanePaths; input: InstanceReservationInput }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-remove-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const instanceId = allocateInstanceId();
  const projectId = `gws-ea-${instanceId.replaceAll('-', '').slice(0, 20)}`;
  const input: InstanceReservationInput = {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: 32_001, onecli_app: 32_002, onecli_gateway: 32_003 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://assistant.example.test/webhook/gchat' },
      gcp_project_id: projectId,
      gcp_account: 'operator@example.test',
      gchat_service_account: `gws-ea-chat@${projectId}.iam.gserviceaccount.com`,
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
  await reserveInstance(paths, input);
  await mkdir(input.checkout_realpath, { recursive: true, mode: 0o700 });
  await writeInstanceMarker(paths, instanceId);
  return { paths, input };
}

const ACCOUNT_ID = 'a'.repeat(32);
const ZONE_ID = 'b'.repeat(32);
const TUNNEL_ID = '11111111-1111-4111-8111-111111111111';

async function managedFixture(
  peerCount: 0 | 1,
  options: {
    readonly tunnelId?: string | null;
    readonly dnsCoordinates?: boolean;
    readonly privateRoot?: boolean;
  } = {},
): Promise<{
  paths: ControlPlanePaths;
  target: InstanceReservationInput;
  peer?: InstanceReservationInput;
}> {
  const tunnelId = options.tunnelId === undefined ? TUNNEL_ID : options.tunnelId;
  const dnsCoordinates = options.dnsCoordinates ?? true;
  const privateRoot = options.privateRoot ?? true;
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-managed-remove-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const makeInput = (label: string, portOffset: number): InstanceReservationInput => {
    const instanceId = allocateInstanceId();
    const projectId = `gws-ea-${instanceId.replaceAll('-', '').slice(0, 20)}`;
    return {
      instance_id: instanceId,
      checkout_realpath: paths.checkoutRoot(instanceId),
      release_track: 'dogfood',
      source_remote: 'https://example.test/nanoclaw.git',
      deployed_commit: 'a'.repeat(40),
      allocated_ports: {
        nanoclaw_webhook: 33_001 + portOffset,
        onecli_app: 33_101 + portOffset,
        onecli_gateway: 33_201 + portOffset,
      },
      exclusive_resource_claims: {
        ingress: {
          mode: 'managed-cloudflare',
          account_id: ACCOUNT_ID,
          zone_id: ZONE_ID,
          zone_name: 'example.test',
          hostname: `${label}.example.test`,
          callback_url: `https://${label}.example.test/webhook/gchat`,
          dns_record_id: dnsCoordinates ? (label === 'target' ? 'c'.repeat(32) : 'd'.repeat(32)) : null,
        },
        gcp_project_id: projectId,
        gcp_account: 'operator@example.test',
        gchat_service_account: `gws-ea-chat@${projectId}.iam.gserviceaccount.com`,
        workspace_email: `${label}@example.test`,
        onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
      },
    };
  };
  const target = makeInput('target', 0);
  await reserveInstance(paths, target);
  await mkdir(target.checkout_realpath, { recursive: true, mode: 0o700 });
  await writeInstanceMarker(paths, target.instance_id);
  let peer: InstanceReservationInput | undefined;
  if (peerCount === 1) {
    peer = makeInput('peer', 10);
    await reserveInstance(paths, peer);
    await mkdir(peer.checkout_realpath, { recursive: true, mode: 0o700 });
    await writeInstanceMarker(paths, peer.instance_id);
  }
  if (tunnelId !== null) {
    await withLockedCloudflareRegistry(paths, async (locked) => {
      await locked.updateCoordinates({ tunnelId });
    });
  }
  if (privateRoot) await mkdir(paths.cloudflareRoot, { recursive: true, mode: 0o700 });
  return { paths, target, ...(peer ? { peer } : {}) };
}

function dnsRecord(input: InstanceReservationInput): CloudflareDnsRecord {
  const ingress = input.exclusive_resource_claims.ingress;
  if (ingress.mode !== 'managed-cloudflare' || ingress.dns_record_id === null) throw new Error('managed fixture');
  return {
    id: ingress.dns_record_id,
    type: 'CNAME',
    name: ingress.hostname,
    content: `${TUNNEL_ID}.cfargotunnel.com`,
    proxied: true,
    comment: `gws-ea managed ingress ${input.instance_id}`,
  };
}

function cloudflareApi(overrides: Partial<CloudflareApi> = {}): CloudflareApi {
  return {
    listActiveZones: vi.fn<CloudflareApi['listActiveZones']>(async () => [
      { zoneId: ZONE_ID, name: 'example.test', accountId: ACCOUNT_ID, accountName: 'Test', status: 'active' },
    ]),
    listTunnels: vi.fn(async () => []),
    createTunnel: vi.fn(),
    getTunnelConfiguration: vi.fn(),
    replaceTunnelConfiguration: vi.fn(),
    getTunnelToken: vi.fn(),
    listTunnelConnections: vi.fn(async () => []),
    listDnsRecords: vi.fn(),
    createDnsRecord: vi.fn(),
    deleteDnsRecord: vi.fn(async () => undefined),
    deleteTunnel: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('assistant removal', () => {
  it('tears down the exact GCP project, NanoClaw copy, OneCLI runtime, local state, then registry claim', async () => {
    const { paths, input } = await fixture();
    const calls: string[] = [];

    await removeAssistant(paths, input.instance_id, {
      deleteGcpProject: async (reservation) =>
        void calls.push(`gcp:${reservation.exclusive_resource_claims.gcp_project_id}`),
      uninstallNanoclaw: async (reservation) => void calls.push(`nanoclaw:${reservation.checkout_realpath}`),
      removeOnecli: async (reservation) =>
        void calls.push(`onecli:${reservation.exclusive_resource_claims.onecli_project}`),
      removeInstanceFiles: async (reservation) => void calls.push(`files:${reservation.instance_id}`),
    });

    expect(calls).toEqual([
      `nanoclaw:${input.checkout_realpath}`,
      `gcp:${input.exclusive_resource_claims.gcp_project_id}`,
      `onecli:${input.exclusive_resource_claims.onecli_project}`,
      `files:${input.instance_id}`,
    ]);
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('persists completed teardown phases and resumes without repeating destructive effects', async () => {
    const { paths, input } = await fixture();
    const deleteGcpProject = vi.fn(async () => undefined);
    const uninstallNanoclaw = vi.fn(async () => undefined);
    const removeOnecli = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('docker unavailable'))
      .mockResolvedValueOnce(undefined);
    const removeInstanceFiles = vi.fn(async () => undefined);
    const dependencies = { deleteGcpProject, uninstallNanoclaw, removeOnecli, removeInstanceFiles };

    await expect(removeAssistant(paths, input.instance_id, dependencies)).rejects.toThrow(/docker unavailable/u);
    await removeAssistant(paths, input.instance_id, dependencies);

    expect(deleteGcpProject).toHaveBeenCalledTimes(1);
    expect(uninstallNanoclaw).toHaveBeenCalledTimes(1);
    expect(removeOnecli).toHaveBeenCalledTimes(2);
    expect(removeInstanceFiles).toHaveBeenCalledTimes(1);
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('refuses removal before any effect when the immutable marker is missing', async () => {
    const { paths, input } = await fixture();
    await rm(paths.markerFile(input.instance_id));
    const deleteGcpProject = vi.fn(async () => undefined);

    await expect(
      removeAssistant(paths, input.instance_id, {
        deleteGcpProject,
        uninstallNanoclaw: async () => undefined,
        removeOnecli: async () => undefined,
        removeInstanceFiles: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'marker_missing' });
    expect(deleteGcpProject).not.toHaveBeenCalled();
  });

  it('blocks provisioning while a resumable removal receipt exists', async () => {
    const { paths, input } = await fixture();
    await expect(
      removeAssistant(paths, input.instance_id, {
        uninstallNanoclaw: async () => undefined,
        deleteGcpProject: async () => {
          throw new Error('cloud unavailable');
        },
        removeOnecli: async () => undefined,
        removeInstanceFiles: async () => undefined,
      }),
    ).rejects.toThrow(/cloud unavailable/u);

    await expect(acquireInstanceOperation(paths, input.instance_id)).rejects.toMatchObject({
      code: 'removal_in_progress',
    });
  });

  it('leaves a peer reservation untouched', async () => {
    const { paths, input } = await fixture();
    const peer = (await fixture()).input;
    const peerForSameRegistry: InstanceReservationInput = {
      ...peer,
      checkout_realpath: paths.checkoutRoot(peer.instance_id),
      allocated_ports: { nanoclaw_webhook: 42_001, onecli_app: 42_002, onecli_gateway: 42_003 },
      exclusive_resource_claims: {
        ...peer.exclusive_resource_claims,
        ingress: { mode: 'existing', endpoint_url: 'https://peer.example.test/webhook/gchat' },
        workspace_email: 'peer@example.test',
      },
    };
    await reserveInstance(paths, peerForSameRegistry);

    await removeAssistant(paths, input.instance_id, {
      uninstallNanoclaw: async () => undefined,
      deleteGcpProject: async () => undefined,
      removeOnecli: async () => undefined,
      removeInstanceFiles: async () => undefined,
    });

    expect((await readRegistry(paths)).instances).toEqual({ [peer.instance_id]: peerForSameRegistry });
  });

  it('previews removal and defaults to leaving the assistant unchanged', async () => {
    const { paths, input } = await fixture();
    const output: string[] = [];
    const remove = vi.fn(async () => undefined);

    const exitCode = await runCli(['remove', '--id', input.instance_id], {
      paths,
      stdout: (line) => output.push(line),
      stderr: () => undefined,
      removeAssistant: remove,
      confirmRemoval: async () => false,
    });

    expect(exitCode).toBe(0);
    expect(output).toContain(
      `Google Cloud project: ${input.exclusive_resource_claims.gcp_project_id} (operator@example.test)`,
    );
    expect(output).toContain('Removal cancelled. Nothing was changed.');
    expect(remove).not.toHaveBeenCalled();
  });

  it('supports an explicit non-interactive confirmation', async () => {
    const { paths, input } = await fixture();
    const remove = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => {
      throw new Error('confirmation must be skipped');
    });

    expect(
      await runCli(['remove', '--id', input.instance_id, '--yes'], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        removeAssistant: remove,
        confirmRemoval: confirm,
      }),
    ).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(paths, input.instance_id, expect.anything());
  });

  it('previews exact managed ownership and whether shared ingress is retained or retired', async () => {
    const { paths, target } = await managedFixture(1);
    const output: string[] = [];
    const requestToken = vi.fn(async () => 'token-canary');

    expect(
      await runCli(['remove', '--id', target.instance_id], {
        paths,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
        confirmRemoval: async () => false,
        prompts: {
          providerCredential: vi.fn(),
          cloudflareAccountToken: requestToken,
          googleCloudSignIn: vi.fn(),
          googleAccount: vi.fn(),
        },
      }),
    ).toBe(0);

    expect(output).toContain('Managed hostname: target.example.test');
    expect(output).toContain('Managed callback: https://target.example.test/webhook/gchat');
    expect(output).toContain(`Owned DNS record: ${'c'.repeat(32)}`);
    expect(output).toContain('Owned tunnel route: target.example.test ^/webhook/gchat$');
    expect(output).toContain('Shared Cloudflare ingress: retained for other assistants');
    expect(output).toContain('Removal cancelled. Nothing was changed.');
    expect(requestToken).not.toHaveBeenCalled();
    expect((await readRegistry(paths)).instances[target.instance_id]).toBeDefined();

    const finalFixture = await managedFixture(0);
    const finalOutput: string[] = [];
    await runCli(['remove', '--id', finalFixture.target.instance_id], {
      paths: finalFixture.paths,
      stdout: (line) => finalOutput.push(line),
      stderr: () => undefined,
      confirmRemoval: async () => false,
    });
    expect(finalOutput).toContain('Shared Cloudflare ingress: retired after this final managed callback');
  });

  it('clears run-scoped Cloudflare authority when the remove command exits', async () => {
    const { paths, target } = await managedFixture(0);
    const clearAccountToken = vi.fn();

    expect(
      await runCli(['remove', '--id', target.instance_id, '--yes'], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        removeAssistant: async () => undefined,
        managedIngressSetup: {
          discoverZones: vi.fn(),
          retainAccountToken: vi.fn(),
          requireAccountToken: vi.fn(),
          clearAccountToken,
        },
      }),
    ).toBe(0);
    expect(clearAccountToken).toHaveBeenCalledOnce();
  });

  it('removes one managed route and DNS record while preserving every shared peer resource', async () => {
    const { paths, target, peer } = await managedFixture(1);
    if (!peer) throw new Error('peer fixture missing');
    const registry = await readRegistry(paths);
    const metadata = registry.shared_infrastructure_metadata.cloudflare;
    if (!metadata) throw new Error('Cloudflare metadata missing');
    const fullConfig = {
      ingress: [
        { hostname: 'peer.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33011' },
        { hostname: 'target.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33001' },
        { service: 'http_status:404' },
      ],
    };
    const peerConfig = {
      ingress: [
        { hostname: 'peer.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33011' },
        { service: 'http_status:404' },
      ],
    };
    const order: string[] = [];
    let dnsPresent = true;
    const api = cloudflareApi({
      listTunnels: vi.fn<CloudflareApi['listTunnels']>(async () => [{ id: TUNNEL_ID, name: metadata.tunnel_name }]),
      getTunnelConfiguration: vi
        .fn<CloudflareApi['getTunnelConfiguration']>()
        .mockResolvedValueOnce({ config: fullConfig, version: 1 })
        .mockResolvedValueOnce({ config: peerConfig, version: 2 }),
      replaceTunnelConfiguration: vi.fn(async (_accountId, _tunnelId, config) => {
        order.push('configuration');
        expect(config).toEqual(peerConfig);
      }),
      listDnsRecords: vi.fn(async () => (dnsPresent ? [dnsRecord(target)] : [])),
      deleteDnsRecord: vi.fn(async () => {
        order.push('dns');
        dnsPresent = false;
      }),
    });

    await removeAssistant(paths, target.instance_id, {
      requestCloudflareAccountToken: async () => 'account-token-canary',
      createCloudflareApi: () => api,
      originHost: '127.0.0.1',
      uninstallNanoclaw: async () => void order.push('nanoclaw'),
      deleteGcpProject: async () => void order.push('gcp'),
      removeOnecli: async () => void order.push('onecli'),
      removeInstanceFiles: async () => void order.push('files'),
      inspectCloudflareConnector: vi.fn(),
      stopCloudflareConnector: vi.fn(),
      removeCloudflarePrivateState: vi.fn(),
    });

    expect(order).toEqual(['configuration', 'dns', 'nanoclaw', 'gcp', 'onecli', 'files']);
    expect(api.listActiveZones).toHaveBeenCalledOnce();
    expect(api.deleteTunnel).not.toHaveBeenCalled();
    expect(api.listTunnelConnections).not.toHaveBeenCalled();
    const after = await readRegistry(paths);
    expect(after.instances).toEqual({ [peer.instance_id]: peer });
    expect(after.shared_infrastructure_metadata.cloudflare).toEqual(metadata);
    await expect(access(paths.cloudflareRoot)).resolves.toBeUndefined();
  });

  it('retires final managed ingress in exact order before ordinary assistant teardown', async () => {
    const { paths, target } = await managedFixture(0);
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare;
    if (!metadata) throw new Error('Cloudflare metadata missing');
    const fullConfig = {
      ingress: [
        { hostname: 'target.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33001' },
        { service: 'http_status:404' },
      ],
    };
    const catchAll = { ingress: [{ service: 'http_status:404' }] };
    const order: string[] = [];
    let dnsPresent = true;
    let tunnelPresent = true;
    const api = cloudflareApi({
      listTunnels: vi.fn<CloudflareApi['listTunnels']>(async () =>
        tunnelPresent ? [{ id: TUNNEL_ID, name: metadata.tunnel_name }] : [],
      ),
      getTunnelConfiguration: vi
        .fn<CloudflareApi['getTunnelConfiguration']>()
        .mockResolvedValueOnce({ config: fullConfig, version: 1 })
        .mockResolvedValueOnce({ config: catchAll, version: 2 }),
      replaceTunnelConfiguration: vi.fn(async () => {
        order.push('configuration');
      }),
      listDnsRecords: vi.fn(async () => (dnsPresent ? [dnsRecord(target)] : [])),
      deleteDnsRecord: vi.fn(async () => {
        order.push('dns');
        dnsPresent = false;
      }),
      listTunnelConnections: vi.fn(async () => {
        order.push('connections');
        return [];
      }),
      deleteTunnel: vi.fn(async () => {
        order.push('tunnel');
        tunnelPresent = false;
      }),
    });

    await removeAssistant(paths, target.instance_id, {
      requestCloudflareAccountToken: async () => 'account-token-canary',
      createCloudflareApi: () => api,
      connectorPlatform: 'linux',
      originHost: '127.0.0.1',
      inspectCloudflareConnector: async () => ({}) as never,
      validateCloudflareConnector: () => undefined,
      stopCloudflareConnector: async () => void order.push('connector'),
      removeCloudflarePrivateState: async () => {
        order.push('private-state');
        await rm(paths.cloudflareRoot, { recursive: true });
      },
      uninstallNanoclaw: async () => void order.push('nanoclaw'),
      deleteGcpProject: async () => void order.push('gcp'),
      removeOnecli: async () => void order.push('onecli'),
      removeInstanceFiles: async () => void order.push('files'),
    });

    expect(order).toEqual([
      'configuration',
      'dns',
      'connector',
      'connections',
      'tunnel',
      'private-state',
      'nanoclaw',
      'gcp',
      'onecli',
      'files',
    ]);
    const after = await readRegistry(paths);
    expect(after.instances).toEqual({});
    expect(after.shared_infrastructure_metadata.cloudflare).toBeNull();
  });

  it('removes a managed reservation whose tunnel and all ingress effects were never created', async () => {
    const { paths, target } = await managedFixture(0, {
      tunnelId: null,
      dnsCoordinates: false,
      privateRoot: false,
    });
    const api = cloudflareApi({
      listTunnels: vi.fn(async () => []),
      listDnsRecords: vi.fn(async () => []),
    });
    const inspectConnector = vi.fn(async () => undefined);
    const removePrivateState = vi.fn(async () => undefined);
    const order: string[] = [];

    await removeAssistant(paths, target.instance_id, {
      requestCloudflareAccountToken: async () => 'account-token',
      createCloudflareApi: () => api,
      inspectCloudflareConnector: inspectConnector,
      removeCloudflarePrivateState: removePrivateState,
      uninstallNanoclaw: async () => void order.push('nanoclaw'),
      deleteGcpProject: async () => void order.push('gcp'),
      removeOnecli: async () => void order.push('onecli'),
      removeInstanceFiles: async () => void order.push('files'),
    });

    expect(order).toEqual(['nanoclaw', 'gcp', 'onecli', 'files']);
    expect(inspectConnector).toHaveBeenCalledOnce();
    expect(api.getTunnelConfiguration).not.toHaveBeenCalled();
    expect(api.replaceTunnelConfiguration).not.toHaveBeenCalled();
    expect(api.deleteDnsRecord).not.toHaveBeenCalled();
    expect(api.listTunnelConnections).not.toHaveBeenCalled();
    expect(api.deleteTunnel).not.toHaveBeenCalled();
    expect(removePrivateState).not.toHaveBeenCalled();
    expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare).toBeNull();
  });

  it('refuses to adopt or delete a tunnel by name when no tunnel ID was recorded', async () => {
    const { paths, target } = await managedFixture(0, {
      tunnelId: null,
      dnsCoordinates: false,
      privateRoot: false,
    });
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare;
    if (!metadata) throw new Error('Cloudflare metadata missing');
    const api = cloudflareApi({
      listTunnels: vi.fn<CloudflareApi['listTunnels']>(async () => [{ id: TUNNEL_ID, name: metadata.tunnel_name }]),
    });

    await expect(
      removeAssistant(paths, target.instance_id, {
        requestCloudflareAccountToken: async () => 'account-token',
        createCloudflareApi: () => api,
      }),
    ).rejects.toMatchObject({ code: 'foreign_cloudflare_tunnel' });
    expect(api.deleteTunnel).not.toHaveBeenCalled();
  });

  it('tears down exact recorded remote state when the connector and private root were never created', async () => {
    const { paths, target } = await managedFixture(0, { privateRoot: false });
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare;
    if (!metadata) throw new Error('Cloudflare metadata missing');
    const fullConfig = {
      ingress: [
        { hostname: 'target.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33001' },
        { service: 'http_status:404' },
      ],
    };
    const catchAll = { ingress: [{ service: 'http_status:404' }] };
    const order: string[] = [];
    let dnsPresent = true;
    let tunnelPresent = true;
    const api = cloudflareApi({
      listTunnels: vi.fn<CloudflareApi['listTunnels']>(async () =>
        tunnelPresent ? [{ id: TUNNEL_ID, name: metadata.tunnel_name }] : [],
      ),
      getTunnelConfiguration: vi
        .fn<CloudflareApi['getTunnelConfiguration']>()
        .mockResolvedValueOnce({ config: fullConfig, version: 1 })
        .mockResolvedValueOnce({ config: catchAll, version: 2 }),
      replaceTunnelConfiguration: vi.fn(async () => {
        order.push('configuration');
      }),
      listDnsRecords: vi.fn(async () => (dnsPresent ? [dnsRecord(target)] : [])),
      deleteDnsRecord: vi.fn(async () => {
        order.push('dns');
        dnsPresent = false;
      }),
      listTunnelConnections: vi.fn(async () => {
        order.push('connections');
        return [];
      }),
      deleteTunnel: vi.fn(async () => {
        order.push('tunnel');
        tunnelPresent = false;
      }),
    });
    const stopConnector = vi.fn(async () => undefined);
    const removePrivateState = vi.fn(async () => undefined);

    await removeAssistant(paths, target.instance_id, {
      requestCloudflareAccountToken: async () => 'account-token',
      createCloudflareApi: () => api,
      originHost: '127.0.0.1',
      inspectCloudflareConnector: async () => undefined,
      stopCloudflareConnector: stopConnector,
      removeCloudflarePrivateState: removePrivateState,
      uninstallNanoclaw: async () => void order.push('nanoclaw'),
      deleteGcpProject: async () => void order.push('gcp'),
      removeOnecli: async () => void order.push('onecli'),
      removeInstanceFiles: async () => void order.push('files'),
    });

    expect(order).toEqual(['configuration', 'dns', 'connections', 'tunnel', 'nanoclaw', 'gcp', 'onecli', 'files']);
    expect(stopConnector).not.toHaveBeenCalled();
    expect(removePrivateState).not.toHaveBeenCalled();
  });

  it('resumes after a DNS boundary failure without replacing the peer-safe configuration twice', async () => {
    const { paths, target } = await managedFixture(1);
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare;
    if (!metadata) throw new Error('Cloudflare metadata missing');
    const fullConfig = {
      ingress: [
        { hostname: 'peer.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33011' },
        { hostname: 'target.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33001' },
        { service: 'http_status:404' },
      ],
    };
    const peerConfig = {
      ingress: [
        { hostname: 'peer.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33011' },
        { service: 'http_status:404' },
      ],
    };
    let currentConfig = fullConfig;
    let dnsPresent = true;
    const replace = vi.fn(async (_accountId: string, _tunnelId: string, config: unknown) => {
      currentConfig = config as typeof fullConfig;
    });
    const deleteDns = vi
      .fn<CloudflareApi['deleteDnsRecord']>()
      .mockRejectedValueOnce(new Error('Cloudflare unavailable'))
      .mockImplementationOnce(async () => {
        dnsPresent = false;
      });
    const api = cloudflareApi({
      listTunnels: vi.fn<CloudflareApi['listTunnels']>(async () => [{ id: TUNNEL_ID, name: metadata.tunnel_name }]),
      getTunnelConfiguration: vi.fn(async () => ({ config: currentConfig, version: 2 })),
      replaceTunnelConfiguration: replace,
      listDnsRecords: vi.fn(async () => (dnsPresent ? [dnsRecord(target)] : [])),
      deleteDnsRecord: deleteDns,
    });
    const requestToken = vi.fn(async () => 'account-token-canary');
    const dependencies = {
      requestCloudflareAccountToken: requestToken,
      createCloudflareApi: () => api,
      originHost: '127.0.0.1' as const,
      uninstallNanoclaw: async () => undefined,
      deleteGcpProject: async () => undefined,
      removeOnecli: async () => undefined,
      removeInstanceFiles: async () => undefined,
    };

    await expect(removeAssistant(paths, target.instance_id, dependencies)).rejects.toThrow(/unavailable/u);
    await removeAssistant(paths, target.instance_id, dependencies);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(deleteDns).toHaveBeenCalledTimes(2);
    expect(requestToken).toHaveBeenCalledTimes(2);
    expect(currentConfig).toEqual(peerConfig);
  });

  it('refuses changed DNS ownership before any managed mutation and never serializes the account token', async () => {
    const { paths, target } = await managedFixture(1);
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare;
    if (!metadata) throw new Error('Cloudflare metadata missing');
    const token = 'account-token-canary-never-persist';
    const replace = vi.fn<CloudflareApi['replaceTunnelConfiguration']>();
    const deleteDns = vi.fn<CloudflareApi['deleteDnsRecord']>();
    const api = cloudflareApi({
      listTunnels: vi.fn<CloudflareApi['listTunnels']>(async () => [{ id: TUNNEL_ID, name: metadata.tunnel_name }]),
      getTunnelConfiguration: vi.fn(async () => ({
        config: {
          ingress: [
            { hostname: 'peer.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33011' },
            { hostname: 'target.example.test', path: '^/webhook/gchat$', service: 'http://127.0.0.1:33001' },
            { service: 'http_status:404' },
          ],
        },
        initialized: true,
        version: 1,
      })),
      replaceTunnelConfiguration: replace,
      listDnsRecords: vi.fn(async () => [{ ...dnsRecord(target), comment: 'somebody else' }]),
      deleteDnsRecord: deleteDns,
    });

    await expect(
      removeAssistant(paths, target.instance_id, {
        requestCloudflareAccountToken: async () => token,
        createCloudflareApi: () => api,
        originHost: '127.0.0.1',
      }),
    ).rejects.toMatchObject({ code: 'foreign_cloudflare_dns' });

    expect(replace).not.toHaveBeenCalled();
    expect(deleteDns).not.toHaveBeenCalled();
    expect(await readFile(paths.registryFile, 'utf8')).not.toContain(token);
    expect(await readFile(paths.removalFile(target.instance_id), 'utf8')).not.toContain(token);
  });

  it('verifies authority for the exact reserved zone before creating removal state', async () => {
    const { paths, target } = await managedFixture(0);
    const api = cloudflareApi({
      listActiveZones: vi.fn<CloudflareApi['listActiveZones']>(async () => [
        { zoneId: 'e'.repeat(32), name: 'other.test', accountId: ACCOUNT_ID, accountName: 'Test', status: 'active' },
      ]),
    });

    await expect(
      removeAssistant(paths, target.instance_id, {
        requestCloudflareAccountToken: async () => 'account-token',
        createCloudflareApi: () => api,
      }),
    ).rejects.toMatchObject({ code: 'cloudflare_capability_missing' });
    await expect(access(paths.removalFile(target.instance_id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(api.listTunnels).not.toHaveBeenCalled();
  });

  it('keeps existing-endpoint removal completely Cloudflare-free', async () => {
    const { paths, input } = await fixture();
    const requestToken = vi.fn(async () => 'must-not-be-used');
    const createApi = vi.fn(() => cloudflareApi());

    await removeAssistant(paths, input.instance_id, {
      requestCloudflareAccountToken: requestToken,
      createCloudflareApi: createApi,
      uninstallNanoclaw: async () => undefined,
      deleteGcpProject: async () => undefined,
      removeOnecli: async () => undefined,
      removeInstanceFiles: async () => undefined,
    });

    expect(requestToken).not.toHaveBeenCalled();
    expect(createApi).not.toHaveBeenCalled();
  });

  it('blocks a new reservation while durable removal state protects shared teardown', async () => {
    const { paths, input } = await fixture();
    await expect(
      removeAssistant(paths, input.instance_id, {
        uninstallNanoclaw: async () => undefined,
        deleteGcpProject: async () => {
          throw new Error('pause removal');
        },
      }),
    ).rejects.toThrow(/pause removal/u);

    const nextId = allocateInstanceId();
    const nextProject = `gws-ea-${nextId.replaceAll('-', '').slice(0, 20)}`;
    await expect(
      reserveInstance(paths, {
        ...input,
        instance_id: nextId,
        checkout_realpath: paths.checkoutRoot(nextId),
        allocated_ports: { nanoclaw_webhook: 44_001, onecli_app: 44_002, onecli_gateway: 44_003 },
        exclusive_resource_claims: {
          ...input.exclusive_resource_claims,
          ingress: { mode: 'existing', endpoint_url: 'https://next.example.test/webhook/gchat' },
          gcp_project_id: nextProject,
          gchat_service_account: `gws-ea-chat@${nextProject}.iam.gserviceaccount.com`,
          workspace_email: 'next@example.test',
          onecli_project: `gws-ea-${nextId.replaceAll('-', '')}`,
        },
      }),
    ).rejects.toMatchObject({ code: 'removal_in_progress' });
  });
});
