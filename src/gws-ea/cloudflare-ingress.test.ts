import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePrivate } from '../community-portal/private-file.js';
import { CloudflareAmbiguousMutationError, type CloudflareApi } from './cloudflare-api.js';
import {
  assertManagedCloudflareConfigurationOwnership,
  cloudflareDnsOwnershipComment,
  reconcileManagedCloudflareIngress,
  replaceManagedCloudflareConfiguration,
  renderManagedCloudflareConfiguration,
} from './cloudflare-ingress.js';
import { preparePrivateDirectory, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { allocateInstanceId, readRegistry, reserveInstance, withLockedCloudflareRegistry } from './registry.js';
import { GwsEaError } from './types.js';
import type { InstanceReservationInput } from './types.js';

const roots: string[] = [];
const ACCOUNT_ID = 'a'.repeat(32);
const ZONE_ID = 'b'.repeat(32);
const TUNNEL_ID = '11111111-1111-4111-8111-111111111111';

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-cloudflare-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

function managedReservation(
  paths: ControlPlanePaths,
  hostname: string,
  webhookPort: number,
  instanceId = allocateInstanceId(),
): InstanceReservationInput {
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

describe('managed Cloudflare desired state', () => {
  it('sorts exact routes stably, anchors the unchanged Chat path, and emits one final catch-all', async () => {
    const paths = await testPaths();
    await reserveInstance(paths, managedReservation(paths, 'zeta.example.com', 31_100));
    await reserveInstance(paths, managedReservation(paths, 'alpha.example.com', 31_200));

    const registry = await readRegistry(paths);
    expect(renderManagedCloudflareConfiguration(registry, 'host.docker.internal')).toEqual({
      ingress: [
        {
          hostname: 'alpha.example.com',
          path: '^/webhook/gchat$',
          service: 'http://host.docker.internal:31200',
        },
        {
          hostname: 'zeta.example.com',
          path: '^/webhook/gchat$',
          service: 'http://host.docker.internal:31100',
        },
        { service: 'http_status:404' },
      ],
    });
  });

  it('accepts a target route only when it is in an explicit pre-removal ownership universe', () => {
    const target = {
      hostname: 'target.example.com',
      path: '^/webhook/gchat$' as const,
      service: 'http://host.docker.internal:31100',
    };
    const peer = {
      hostname: 'peer.example.com',
      path: '^/webhook/gchat$' as const,
      service: 'http://host.docker.internal:31200',
    };
    const current = { ingress: [peer, target, { service: 'http_status:404' }] };
    const preRemovalOwnership = { ingress: [peer, target, { service: 'http_status:404' as const }] };
    const postRemovalDesired = { ingress: [peer, { service: 'http_status:404' as const }] };

    expect(assertManagedCloudflareConfigurationOwnership(current, preRemovalOwnership)).toEqual(current);
    expect(() => assertManagedCloudflareConfigurationOwnership(current, postRemovalDesired)).toThrow(/not owned/i);
  });

  it('reconciles one exact remote-managed tunnel, full config, and owned proxied CNAME under the registry lock', async () => {
    const paths = await testPaths();
    const input = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, input);
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare!;
    let config: unknown = { ingress: [{ service: 'http_status:404' }] };
    let configVersion = 1;
    let records: Array<{
      id: string;
      type: 'CNAME';
      name: string;
      content: string;
      proxied: boolean;
      comment: string;
    }> = [];
    const api = {
      verifyToken: vi.fn(async () => undefined),
      listActiveZones: vi.fn(async () => [
        { zoneId: ZONE_ID, name: 'example.com', status: 'active', accountId: ACCOUNT_ID, accountName: 'Example' },
      ]),
      listTunnels: vi.fn(async () => []),
      createTunnel: vi.fn(async () => ({
        id: TUNNEL_ID,
        name: metadata.tunnel_name,
        configSource: 'cloudflare' as const,
        status: 'inactive',
      })),
      getTunnelConfiguration: vi.fn(async () => ({ config, version: configVersion })),
      replaceTunnelConfiguration: vi.fn(async (_accountId: string, _tunnelId: string, desired: unknown) => {
        config = desired;
        configVersion = 2;
        return { config, version: configVersion };
      }),
      listDnsRecords: vi.fn(async () => records),
      createDnsRecord: vi.fn(async (_zoneId: string, desired: Omit<(typeof records)[number], 'id'>) => {
        const created = { id: 'c'.repeat(32), ...desired };
        records = [created];
        return created;
      }),
    } as unknown as CloudflareApi;

    await expect(
      reconcileManagedCloudflareIngress(paths, api, { originHost: 'host.docker.internal' }),
    ).resolves.toMatchObject({ tunnelId: TUNNEL_ID, configurationVersion: 2 });

    expect(api.replaceTunnelConfiguration).toHaveBeenCalledWith(ACCOUNT_ID, TUNNEL_ID, {
      ingress: [
        {
          hostname: 'assistant.example.com',
          path: '^/webhook/gchat$',
          service: 'http://host.docker.internal:31100',
        },
        { service: 'http_status:404' },
      ],
    });
    expect(api.createDnsRecord).toHaveBeenCalledWith(ZONE_ID, {
      type: 'CNAME',
      name: 'assistant.example.com',
      content: `${TUNNEL_ID}.cfargotunnel.com`,
      proxied: true,
      comment: cloudflareDnsOwnershipComment(input.instance_id),
    });
    const stored = await readRegistry(paths);
    expect(stored.shared_infrastructure_metadata.cloudflare?.tunnel_id).toBe(TUNNEL_ID);
    expect(stored.instances[input.instance_id]?.exclusive_resource_claims.ingress).toMatchObject({
      dns_record_id: 'c'.repeat(32),
    });
    await expect(
      withLockedCloudflareRegistry(paths, (locked) =>
        locked.updateCoordinates({ tunnelId: '22222222-2222-4222-8222-222222222222' }),
      ),
    ).rejects.toMatchObject({ code: 'reservation_mismatch' });
  });

  it('blocks every managed reconciliation while an assistant removal receipt is active', async () => {
    const paths = await testPaths();
    const removing = managedReservation(paths, 'removing.example.com', 31_100);
    await reserveInstance(paths, removing);
    await reserveInstance(paths, managedReservation(paths, 'peer.example.com', 31_200));
    await preparePrivateDirectory(paths.removalRoot);
    await writePrivate(paths.removalFile(removing.instance_id), { active: true });
    const api = {
      verifyToken: vi.fn(),
      listActiveZones: vi.fn(),
      listTunnels: vi.fn(),
      listDnsRecords: vi.fn(),
      createTunnel: vi.fn(),
      replaceTunnelConfiguration: vi.fn(),
      createDnsRecord: vi.fn(),
    } as unknown as CloudflareApi;

    await expect(
      reconcileManagedCloudflareIngress(paths, api, { originHost: 'host.docker.internal' }),
    ).rejects.toMatchObject({ code: 'removal_in_progress' });
    expect(api.verifyToken).not.toHaveBeenCalled();
    expect(api.listTunnels).not.toHaveBeenCalled();
    expect(api.replaceTunnelConfiguration).not.toHaveBeenCalled();
    expect(api.createDnsRecord).not.toHaveBeenCalled();
  });

  it.each(['foreign-config', 'foreign-dns'] as const)('refuses %s before overwriting it', async (kind) => {
    const paths = await testPaths();
    const input = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, input);
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare!;
    const api = {
      verifyToken: vi.fn(async () => undefined),
      listActiveZones: vi.fn(async () => [
        { zoneId: ZONE_ID, name: 'example.com', status: 'active', accountId: ACCOUNT_ID, accountName: 'Example' },
      ]),
      listTunnels: vi.fn(async () => [
        { id: TUNNEL_ID, name: metadata.tunnel_name, configSource: 'cloudflare', status: 'inactive' },
      ]),
      getTunnelConfiguration: vi.fn(async () => ({
        config:
          kind === 'foreign-config'
            ? {
                ingress: [
                  { hostname: 'foreign.example.com', service: 'http://127.0.0.1:9999' },
                  { service: 'http_status:404' },
                ],
              }
            : { ingress: [{ service: 'http_status:404' }] },
        version: 1,
      })),
      listDnsRecords: vi.fn(async () =>
        kind === 'foreign-dns'
          ? [
              {
                id: 'd'.repeat(32),
                type: 'A',
                name: 'assistant.example.com',
                content: '192.0.2.1',
                proxied: true,
                comment: 'someone else',
              },
            ]
          : [],
      ),
      replaceTunnelConfiguration: vi.fn(),
      createDnsRecord: vi.fn(),
    } as unknown as CloudflareApi;

    await expect(reconcileManagedCloudflareIngress(paths, api, { originHost: 'host.docker.internal' })).rejects.toThrow(
      /foreign|ownership/i,
    );
    expect(api.replaceTunnelConfiguration).not.toHaveBeenCalled();
    expect(api.createDnsRecord).not.toHaveBeenCalled();
    if (kind === 'foreign-config') {
      expect((await readRegistry(paths)).shared_infrastructure_metadata.cloudflare?.tunnel_id).toBeNull();
    }
  });

  it('polls deterministic tunnel and DNS identity after ambiguous creates without repeating either POST', async () => {
    const paths = await testPaths();
    const input = managedReservation(paths, 'assistant.example.com', 31_100);
    await reserveInstance(paths, input);
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare!;
    let tunnelReads = 0;
    let dnsReads = 0;
    const tunnel = {
      id: TUNNEL_ID,
      name: metadata.tunnel_name,
      configSource: 'cloudflare' as const,
      status: 'inactive',
    };
    const dns = {
      id: 'c'.repeat(32),
      type: 'CNAME' as const,
      name: 'assistant.example.com',
      content: `${TUNNEL_ID}.cfargotunnel.com`,
      proxied: true,
      comment: cloudflareDnsOwnershipComment(input.instance_id),
    };
    let config: unknown = { ingress: [{ service: 'http_status:404' }] };
    const api = {
      verifyToken: vi.fn(async () => undefined),
      listActiveZones: vi.fn(async () => [
        { zoneId: ZONE_ID, name: 'example.com', status: 'active', accountId: ACCOUNT_ID, accountName: 'Example' },
      ]),
      listTunnels: vi.fn(async () => (++tunnelReads <= 2 ? [] : [tunnel])),
      createTunnel: vi.fn(async () => {
        throw new CloudflareAmbiguousMutationError('create the managed tunnel');
      }),
      getTunnelConfiguration: vi.fn(async () => ({ config, version: 1 })),
      replaceTunnelConfiguration: vi.fn(async (_a: string, _t: string, desired: unknown) => {
        config = desired;
        return { config, version: 2 };
      }),
      listDnsRecords: vi.fn(async () => (++dnsReads <= 2 ? [] : [dns])),
      createDnsRecord: vi.fn(async () => {
        throw new CloudflareAmbiguousMutationError('create the owned DNS record');
      }),
    } as unknown as CloudflareApi;
    const sleep = vi.fn(async () => undefined);

    await expect(
      reconcileManagedCloudflareIngress(paths, api, { originHost: 'host.docker.internal', sleep }),
    ).resolves.toMatchObject({ tunnelId: TUNNEL_ID });
    expect(api.createTunnel).toHaveBeenCalledOnce();
    expect(api.createDnsRecord).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('observes or retries one ambiguous full-configuration write and always verifies readback', async () => {
    const desired = {
      ingress: [
        {
          hostname: 'assistant.example.com',
          path: '^/webhook/gchat$' as const,
          service: 'http://host.docker.internal:31100',
        },
        { service: 'http_status:404' as const },
      ],
    };
    const old = { ingress: [{ service: 'http_status:404' as const }] };
    const observedAfterAmbiguous = {
      replaceTunnelConfiguration: vi.fn(async () => {
        throw new CloudflareAmbiguousMutationError('replace the tunnel configuration');
      }),
      getTunnelConfiguration: vi.fn(async () => ({ config: desired, initialized: true, version: 2 })),
    } as unknown as CloudflareApi;
    await expect(
      replaceManagedCloudflareConfiguration(observedAfterAmbiguous, ACCOUNT_ID, TUNNEL_ID, desired, old),
    ).resolves.toBe(2);
    expect(observedAfterAmbiguous.replaceTunnelConfiguration).toHaveBeenCalledOnce();

    let writes = 0;
    let reads = 0;
    const retriedAfterOldReadback = {
      replaceTunnelConfiguration: vi.fn(async () => {
        writes += 1;
        if (writes === 1) throw new CloudflareAmbiguousMutationError('replace the tunnel configuration');
        return { config: desired, initialized: true, version: 3 };
      }),
      getTunnelConfiguration: vi.fn(async () => {
        reads += 1;
        return { config: reads === 1 ? old : desired, initialized: true, version: reads === 1 ? 1 : 3 };
      }),
    } as unknown as CloudflareApi;
    await expect(
      replaceManagedCloudflareConfiguration(retriedAfterOldReadback, ACCOUNT_ID, TUNNEL_ID, desired, old),
    ).resolves.toBe(3);
    expect(retriedAfterOldReadback.replaceTunnelConfiguration).toHaveBeenCalledTimes(2);
    expect(retriedAfterOldReadback.getTunnelConfiguration).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous configuration write over a concurrent change', async () => {
    const old = { ingress: [{ service: 'http_status:404' as const }] };
    const desired = {
      ingress: [
        {
          hostname: 'assistant.example.com',
          path: '^/webhook/gchat$' as const,
          service: 'http://host.docker.internal:31100',
        },
        { service: 'http_status:404' as const },
      ],
    };
    const changed = {
      ingress: [
        {
          hostname: 'other.example.com',
          path: '^/webhook/gchat$' as const,
          service: 'http://host.docker.internal:31200',
        },
        { service: 'http_status:404' as const },
      ],
    };
    const api = {
      replaceTunnelConfiguration: vi.fn(async () => {
        throw new CloudflareAmbiguousMutationError('replace the tunnel configuration');
      }),
      getTunnelConfiguration: vi.fn(async () => ({ config: changed, initialized: true, version: 2 })),
    } as unknown as CloudflareApi;

    await expect(replaceManagedCloudflareConfiguration(api, ACCOUNT_ID, TUNNEL_ID, desired, old)).rejects.toMatchObject(
      {
        code: 'cloudflare_configuration_drift',
      },
    );
    expect(api.replaceTunnelConfiguration).toHaveBeenCalledOnce();
  });

  it.each(['zones', 'tunnels', 'dns'] as const)(
    'fails a missing %s read capability before remote mutation',
    async (boundary) => {
      const paths = await testPaths();
      await reserveInstance(paths, managedReservation(paths, 'assistant.example.com', 31_100));
      const denied = new GwsEaError('cloudflare_capability_missing', 'Cloudflare authorization is insufficient');
      const api = {
        verifyToken: vi.fn(async () => undefined),
        listActiveZones: vi.fn(async () => {
          if (boundary === 'zones') throw denied;
          return [
            { zoneId: ZONE_ID, name: 'example.com', status: 'active', accountId: ACCOUNT_ID, accountName: 'Example' },
          ];
        }),
        listTunnels: vi.fn(async () => {
          if (boundary === 'tunnels') throw denied;
          return [];
        }),
        listDnsRecords: vi.fn(async () => {
          if (boundary === 'dns') throw denied;
          return [];
        }),
        createTunnel: vi.fn(),
        replaceTunnelConfiguration: vi.fn(),
        createDnsRecord: vi.fn(),
      } as unknown as CloudflareApi;

      await expect(
        reconcileManagedCloudflareIngress(paths, api, { originHost: 'host.docker.internal' }),
      ).rejects.toMatchObject({ code: 'cloudflare_capability_missing' });
      expect(api.createTunnel).not.toHaveBeenCalled();
      expect(api.replaceTunnelConfiguration).not.toHaveBeenCalled();
      expect(api.createDnsRecord).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the full configuration readback differs from the requested state', async () => {
    const paths = await testPaths();
    await reserveInstance(paths, managedReservation(paths, 'assistant.example.com', 31_100));
    const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare!;
    const api = {
      verifyToken: vi.fn(async () => undefined),
      listActiveZones: vi.fn(async () => [
        { zoneId: ZONE_ID, name: 'example.com', status: 'active', accountId: ACCOUNT_ID, accountName: 'Example' },
      ]),
      listTunnels: vi.fn(async () => [
        { id: TUNNEL_ID, name: metadata.tunnel_name, configSource: 'cloudflare', status: 'inactive' },
      ]),
      listDnsRecords: vi.fn(async () => []),
      getTunnelConfiguration: vi.fn(async () => ({
        config: { ingress: [{ service: 'http_status:404' }] },
        version: 1,
      })),
      replaceTunnelConfiguration: vi.fn(async (_a: string, _t: string, config: unknown) => ({ config, version: 2 })),
      createDnsRecord: vi.fn(),
    } as unknown as CloudflareApi;

    await expect(
      reconcileManagedCloudflareIngress(paths, api, { originHost: 'host.docker.internal' }),
    ).rejects.toMatchObject({ code: 'cloudflare_configuration_drift' });
    expect(api.createDnsRecord).not.toHaveBeenCalled();
  });

  it.each(['tunnel', 'dns'] as const)(
    'preserves the actionable original error after a non-ambiguous %s create failure',
    async (boundary) => {
      const paths = await testPaths();
      const input = managedReservation(paths, 'assistant.example.com', 31_100);
      await reserveInstance(paths, input);
      const metadata = (await readRegistry(paths)).shared_infrastructure_metadata.cloudflare!;
      const original = new GwsEaError('cloudflare_capability_missing', `Cannot create ${boundary}`);
      let config: unknown = { ingress: [{ service: 'http_status:404' }] };
      const tunnel = {
        id: TUNNEL_ID,
        name: metadata.tunnel_name,
        configSource: 'cloudflare' as const,
        status: 'inactive',
      };
      const api = {
        verifyToken: vi.fn(async () => undefined),
        listActiveZones: vi.fn(async () => [
          { zoneId: ZONE_ID, name: 'example.com', status: 'active', accountId: ACCOUNT_ID, accountName: 'Example' },
        ]),
        listTunnels: vi.fn(async () => (boundary === 'tunnel' ? [] : [tunnel])),
        createTunnel: vi.fn(async () => {
          throw original;
        }),
        getTunnelConfiguration: vi.fn(async () => ({ config, version: 1 })),
        replaceTunnelConfiguration: vi.fn(async (_a: string, _t: string, desired: unknown) => {
          config = desired;
          return { config, version: 2 };
        }),
        listDnsRecords: vi.fn(async () => []),
        createDnsRecord: vi.fn(async () => {
          throw original;
        }),
      } as unknown as CloudflareApi;

      await expect(reconcileManagedCloudflareIngress(paths, api, { originHost: 'host.docker.internal' })).rejects.toBe(
        original,
      );
      expect(boundary === 'tunnel' ? api.createTunnel : api.createDnsRecord).toHaveBeenCalledOnce();
    },
  );
});
