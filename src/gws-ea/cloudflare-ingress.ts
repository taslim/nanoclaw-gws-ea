import { setTimeout as delay } from 'node:timers/promises';

import {
  CloudflareAmbiguousMutationError,
  type CloudflareApi,
  type CloudflareDnsRecord,
  type CloudflareDnsRecordWrite,
  type CloudflareTunnel,
} from './cloudflare-api.js';
import { activeRemovalInstanceIds, withLockedCloudflareRegistry } from './registry.js';
import { GwsEaError, type InstanceRegistry, type InstanceReservation } from './types.js';
import { isRecord } from './validation.js';
import type { ControlPlanePaths } from './paths.js';

export const GCHAT_TUNNEL_PATH = '^/webhook/gchat$';
const CATCH_ALL_SERVICE = 'http_status:404';
const AMBIGUOUS_CREATE_OBSERVATION_DELAYS_MS = [100, 250] as const;

type Sleep = (milliseconds: number) => Promise<void>;

export type CloudflareOriginHost = '127.0.0.1' | 'host.docker.internal';

export interface ManagedCloudflareIngressRule {
  readonly hostname: string;
  readonly path: typeof GCHAT_TUNNEL_PATH;
  readonly service: string;
}

export interface ManagedCloudflareCatchAllRule {
  readonly service: typeof CATCH_ALL_SERVICE;
}

export interface ManagedCloudflareConfiguration {
  readonly ingress: readonly (ManagedCloudflareIngressRule | ManagedCloudflareCatchAllRule)[];
}

export interface ManagedCloudflareReconcileResult {
  readonly tunnelId: string;
  readonly configurationVersion: number;
  readonly dnsRecordIds: Readonly<Record<string, string>>;
}

export function cloudflareDnsOwnershipComment(instanceId: string): string {
  return `gws-ea managed ingress ${instanceId}`;
}

function managedReservations(registry: InstanceRegistry): readonly InstanceReservation[] {
  return Object.values(registry.instances).filter(
    (instance) => instance.exclusive_resource_claims.ingress.mode === 'managed-cloudflare',
  );
}

export function renderManagedCloudflareConfiguration(
  registry: InstanceRegistry,
  originHost: CloudflareOriginHost,
): ManagedCloudflareConfiguration {
  const ingress = managedReservations(registry)
    .map((instance): ManagedCloudflareIngressRule => {
      const claim = instance.exclusive_resource_claims.ingress;
      if (claim.mode !== 'managed-cloudflare') {
        throw new GwsEaError('invalid_registry', 'Managed Cloudflare route has no managed claim');
      }
      return {
        hostname: claim.hostname,
        path: GCHAT_TUNNEL_PATH,
        service: `http://${originHost}:${instance.allocated_ports.nanoclaw_webhook}`,
      };
    })
    .sort((left, right) => left.hostname.localeCompare(right.hostname));
  return { ingress: [...ingress, { service: CATCH_ALL_SERVICE }] };
}

function isCatchAll(value: unknown): value is ManagedCloudflareCatchAllRule {
  return isRecord(value) && Object.keys(value).length === 1 && value.service === CATCH_ALL_SERVICE;
}

function parseOwnedConfiguration(value: unknown): ManagedCloudflareConfiguration {
  if (!isRecord(value)) {
    throw new GwsEaError('foreign_cloudflare_configuration', 'Cloudflare tunnel configuration is not recognized');
  }
  const allowedTopLevel = new Set(['ingress', 'warp-routing', 'originRequest']);
  if (Object.keys(value).some((key) => !allowedTopLevel.has(key))) {
    throw new GwsEaError('foreign_cloudflare_configuration', 'Cloudflare tunnel configuration contains foreign state');
  }
  if (Object.hasOwn(value, 'warp-routing')) {
    const warpRouting = value['warp-routing'];
    if (
      !isRecord(warpRouting) ||
      Object.keys(warpRouting).some((key) => key !== 'enabled') ||
      warpRouting.enabled !== false
    ) {
      throw new GwsEaError('foreign_cloudflare_configuration', 'Cloudflare tunnel has a foreign private-network route');
    }
  }
  if (Object.hasOwn(value, 'originRequest')) {
    const originRequest = value.originRequest;
    if (!isRecord(originRequest) || Object.keys(originRequest).length !== 0) {
      throw new GwsEaError('foreign_cloudflare_configuration', 'Cloudflare tunnel has foreign origin settings');
    }
  }
  if (value.ingress === undefined) return { ingress: [] };
  if (!Array.isArray(value.ingress)) {
    throw new GwsEaError('foreign_cloudflare_configuration', 'Cloudflare tunnel ingress is invalid');
  }
  const rules = value.ingress.map((rule): ManagedCloudflareIngressRule | ManagedCloudflareCatchAllRule => {
    if (isCatchAll(rule)) return rule;
    if (
      !isRecord(rule) ||
      Object.keys(rule).sort().join(',') !== 'hostname,path,service' ||
      typeof rule.hostname !== 'string' ||
      rule.path !== GCHAT_TUNNEL_PATH ||
      typeof rule.service !== 'string'
    ) {
      throw new GwsEaError('foreign_cloudflare_configuration', 'Cloudflare tunnel contains a foreign ingress rule');
    }
    return { hostname: rule.hostname, path: GCHAT_TUNNEL_PATH, service: rule.service };
  });
  if (rules.length > 0 && !isCatchAll(rules.at(-1))) {
    throw new GwsEaError('foreign_cloudflare_configuration', 'Cloudflare tunnel has no final owned catch-all');
  }
  if (rules.slice(0, -1).some(isCatchAll)) {
    throw new GwsEaError('foreign_cloudflare_configuration', 'Cloudflare tunnel contains more than one catch-all');
  }
  return { ingress: rules };
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function assertConfigurationIsOwnedSubset(
  current: ManagedCloudflareConfiguration,
  ownershipUniverse: ManagedCloudflareConfiguration,
): void {
  const ownedRoutes = new Set(ownershipUniverse.ingress.slice(0, -1).map(stable));
  const currentRoutes = current.ingress.length === 0 ? [] : current.ingress.slice(0, -1);
  if (currentRoutes.some((rule) => !ownedRoutes.has(stable(rule)))) {
    throw new GwsEaError(
      'foreign_cloudflare_configuration',
      'Cloudflare tunnel contains a route not owned by the current machine registry',
    );
  }
  if (new Set(currentRoutes.map(stable)).size !== currentRoutes.length) {
    throw new GwsEaError('foreign_cloudflare_configuration', 'Cloudflare tunnel contains a duplicate ingress route');
  }
}

/**
 * Validate remote state against an explicit registry-owned route universe.
 * Removal can pass the pre-removal universe while rendering a smaller desired
 * configuration, so an owned target route is not mistaken for foreign state.
 */
export function assertManagedCloudflareConfigurationOwnership(
  remoteConfiguration: unknown,
  ownershipUniverse: ManagedCloudflareConfiguration,
): ManagedCloudflareConfiguration {
  const current = parseOwnedConfiguration(remoteConfiguration);
  const owned = parseOwnedConfiguration(ownershipUniverse);
  assertConfigurationIsOwnedSubset(current, owned);
  return current;
}

function assertTunnel(tunnel: CloudflareTunnel, expectedName: string, expectedId?: string): CloudflareTunnel {
  if (
    tunnel.name !== expectedName ||
    tunnel.configSource !== 'cloudflare' ||
    (expectedId !== undefined && tunnel.id !== expectedId)
  ) {
    throw new GwsEaError('foreign_cloudflare_tunnel', 'Cloudflare tunnel does not match the reserved managed owner');
  }
  return tunnel;
}

function chooseOwnedTunnel(
  tunnels: readonly CloudflareTunnel[],
  expectedName: string,
  expectedId?: string,
): CloudflareTunnel | undefined {
  if (tunnels.length > 1) {
    throw new GwsEaError('ambiguous_cloudflare_tunnel', 'More than one Cloudflare tunnel has the reserved owner name');
  }
  return tunnels[0] ? assertTunnel(tunnels[0], expectedName, expectedId) : undefined;
}

function desiredDnsRecord(instance: InstanceReservation, tunnelId: string): CloudflareDnsRecordWrite {
  const claim = instance.exclusive_resource_claims.ingress;
  if (claim.mode !== 'managed-cloudflare') {
    throw new GwsEaError('invalid_registry', 'DNS reconciliation requires a managed Cloudflare claim');
  }
  return {
    type: 'CNAME',
    name: claim.hostname,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    comment: cloudflareDnsOwnershipComment(instance.instance_id),
  };
}

function dnsMatches(record: CloudflareDnsRecord, desired: CloudflareDnsRecordWrite): boolean {
  return (
    record.type === desired.type &&
    record.name === desired.name &&
    record.content === desired.content &&
    record.proxied === desired.proxied &&
    record.comment === desired.comment
  );
}

function chooseOwnedDnsRecord(
  records: readonly CloudflareDnsRecord[],
  desired: CloudflareDnsRecordWrite,
  expectedId: string | null,
): CloudflareDnsRecord | undefined {
  if (records.length === 0) return undefined;
  if (records.length !== 1 || !dnsMatches(records[0]!, desired)) {
    throw new GwsEaError('foreign_cloudflare_dns', `Cloudflare DNS name ${desired.name} contains foreign state`);
  }
  const record = records[0]!;
  if (expectedId !== null && record.id !== expectedId) {
    throw new GwsEaError('foreign_cloudflare_dns', `Cloudflare DNS name ${desired.name} changed ownership`);
  }
  return record;
}

async function observeCreatedResource<T>(
  error: GwsEaError,
  observe: () => Promise<T | undefined>,
  sleep: Sleep,
): Promise<T> {
  const attempts =
    error instanceof CloudflareAmbiguousMutationError ? AMBIGUOUS_CREATE_OBSERVATION_DELAYS_MS.length + 1 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const observed = await observe();
      if (observed !== undefined) return observed;
    } catch (observationError) {
      if (!(error instanceof CloudflareAmbiguousMutationError)) throw error;
      throw observationError;
    }
    const wait = AMBIGUOUS_CREATE_OBSERVATION_DELAYS_MS[attempt];
    if (wait !== undefined) await sleep(wait);
  }
  throw error;
}

async function createOrObserveTunnel(
  api: CloudflareApi,
  accountId: string,
  tunnelName: string,
  sleep: Sleep,
): Promise<CloudflareTunnel> {
  try {
    return assertTunnel(await api.createTunnel(accountId, tunnelName), tunnelName);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    return observeCreatedResource(
      error,
      async () => chooseOwnedTunnel(await api.listTunnels(accountId, tunnelName), tunnelName),
      sleep,
    );
  }
}

export async function replaceManagedCloudflareConfiguration(
  api: CloudflareApi,
  accountId: string,
  tunnelId: string,
  desired: ManagedCloudflareConfiguration,
): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await api.replaceTunnelConfiguration(accountId, tunnelId, desired);
    } catch (error) {
      const observed = await api.getTunnelConfiguration(accountId, tunnelId);
      if (stable(parseOwnedConfiguration(observed.config)) === stable(desired)) return observed.version;
      if (!(error instanceof CloudflareAmbiguousMutationError) || attempt === 1) throw error;
      continue;
    }
    const readback = await api.getTunnelConfiguration(accountId, tunnelId);
    if (stable(parseOwnedConfiguration(readback.config)) !== stable(desired)) {
      throw new GwsEaError(
        'cloudflare_configuration_drift',
        'Cloudflare tunnel configuration changed during readback; refusing to continue',
      );
    }
    return readback.version;
  }
  throw new GwsEaError('cloudflare_configuration_drift', 'Cloudflare tunnel configuration could not be verified');
}

async function createOrObserveDnsRecord(
  api: CloudflareApi,
  zoneId: string,
  desired: CloudflareDnsRecordWrite,
  sleep: Sleep,
): Promise<CloudflareDnsRecord> {
  try {
    const created = await api.createDnsRecord(zoneId, desired);
    if (!dnsMatches(created, desired)) {
      throw new GwsEaError('cloudflare_dns_drift', `Cloudflare DNS name ${desired.name} did not match after creation`);
    }
    return created;
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    return observeCreatedResource(
      error,
      async () => chooseOwnedDnsRecord(await api.listDnsRecords(zoneId, desired.name), desired, null),
      sleep,
    );
  }
}

export async function reconcileManagedCloudflareIngress(
  paths: ControlPlanePaths,
  api: CloudflareApi,
  options: { readonly originHost: CloudflareOriginHost; readonly sleep?: Sleep },
): Promise<ManagedCloudflareReconcileResult> {
  return withLockedCloudflareRegistry(paths, async (locked) => {
    if ((await activeRemovalInstanceIds(paths, locked.registry)).length > 0) {
      throw new GwsEaError(
        'removal_in_progress',
        'An assistant removal is in progress; retry managed ingress reconciliation after it completes',
      );
    }
    let registry = locked.registry;
    const metadata = registry.shared_infrastructure_metadata.cloudflare;
    const reservations = managedReservations(registry);
    if (!metadata || reservations.length === 0) {
      throw new GwsEaError('cloudflare_state_missing', 'No managed Cloudflare ingress is reserved');
    }

    // Complete all authority and foreign-state reads before the first mutation.
    await api.verifyToken();
    const zones = await api.listActiveZones();
    for (const instance of reservations) {
      const claim = instance.exclusive_resource_claims.ingress;
      if (claim.mode !== 'managed-cloudflare') continue;
      if (
        !zones.some(
          (zone) =>
            zone.zoneId === claim.zone_id &&
            zone.name === claim.zone_name &&
            zone.accountId === claim.account_id &&
            zone.status === 'active',
        )
      ) {
        throw new GwsEaError(
          'cloudflare_capability_missing',
          `Cloudflare authorization cannot read active zone ${claim.zone_name}.`,
        );
      }
    }
    const tunnels = await api.listTunnels(metadata.account_id, metadata.tunnel_name);
    const existingTunnel = chooseOwnedTunnel(
      tunnels,
      metadata.tunnel_name,
      metadata.tunnel_id === null ? undefined : metadata.tunnel_id,
    );
    if (!existingTunnel && metadata.tunnel_id !== null) {
      throw new GwsEaError(
        'cloudflare_tunnel_missing',
        'The recorded Cloudflare tunnel is missing; refusing replacement',
      );
    }

    const probedDns = new Map<string, readonly CloudflareDnsRecord[]>();
    for (const instance of reservations) {
      const claim = instance.exclusive_resource_claims.ingress;
      if (claim.mode !== 'managed-cloudflare') continue;
      probedDns.set(instance.instance_id, await api.listDnsRecords(claim.zone_id, claim.hostname));
    }
    if (!existingTunnel && metadata.tunnel_id === null) {
      for (const records of probedDns.values()) {
        if (records.length > 0) {
          throw new GwsEaError(
            'foreign_cloudflare_dns',
            'A managed hostname already contains DNS state before tunnel ownership was established',
          );
        }
      }
    }

    let tunnel = existingTunnel;
    const sleep = options.sleep ?? delay;
    if (!tunnel) tunnel = await createOrObserveTunnel(api, metadata.account_id, metadata.tunnel_name, sleep);

    const desired = renderManagedCloudflareConfiguration(registry, options.originHost);
    const currentConfiguration = await api.getTunnelConfiguration(metadata.account_id, tunnel.id);
    const normalizedCurrent = assertManagedCloudflareConfigurationOwnership(currentConfiguration.config, desired);
    if (metadata.tunnel_id === null) {
      registry = await locked.updateCoordinates({ tunnelId: tunnel.id });
    }

    const desiredRecords = new Map<string, { desired: CloudflareDnsRecordWrite; record?: CloudflareDnsRecord }>();
    for (const instance of managedReservations(registry)) {
      const claim = instance.exclusive_resource_claims.ingress;
      if (claim.mode !== 'managed-cloudflare') continue;
      const desiredRecord = desiredDnsRecord(instance, tunnel.id);
      desiredRecords.set(instance.instance_id, {
        desired: desiredRecord,
        record: chooseOwnedDnsRecord(probedDns.get(instance.instance_id) ?? [], desiredRecord, claim.dns_record_id),
      });
    }

    const configurationVersion =
      stable(normalizedCurrent) === stable(desired)
        ? currentConfiguration.version
        : await replaceManagedCloudflareConfiguration(api, metadata.account_id, tunnel.id, desired);

    const dnsRecordIds: Record<string, string> = {};
    for (const instance of managedReservations(registry)) {
      const state = desiredRecords.get(instance.instance_id);
      if (!state) throw new GwsEaError('invalid_registry', 'Managed DNS desired state is missing');
      const claim = instance.exclusive_resource_claims.ingress;
      if (claim.mode !== 'managed-cloudflare') {
        throw new GwsEaError('invalid_registry', 'Managed DNS claim changed during reconciliation');
      }
      const record = state.record ?? (await createOrObserveDnsRecord(api, claim.zone_id, state.desired, sleep));
      dnsRecordIds[instance.instance_id] = record.id;
      if (claim.dns_record_id !== record.id) {
        registry = await locked.updateCoordinates({ dnsRecordIds: { [instance.instance_id]: record.id } });
      }
    }

    const finalConfiguration = await api.getTunnelConfiguration(metadata.account_id, tunnel.id);
    if (stable(parseOwnedConfiguration(finalConfiguration.config)) !== stable(desired)) {
      throw new GwsEaError(
        'cloudflare_configuration_drift',
        'Cloudflare tunnel configuration drifted after DNS reconciliation',
      );
    }
    for (const instance of managedReservations(registry)) {
      const claim = instance.exclusive_resource_claims.ingress;
      if (claim.mode !== 'managed-cloudflare') continue;
      const record = chooseOwnedDnsRecord(
        await api.listDnsRecords(claim.zone_id, claim.hostname),
        desiredDnsRecord(instance, tunnel.id),
        claim.dns_record_id,
      );
      if (!record) throw new GwsEaError('cloudflare_dns_drift', `Cloudflare DNS name ${claim.hostname} is missing`);
    }

    return { tunnelId: tunnel.id, configurationVersion, dnsRecordIds };
  });
}
