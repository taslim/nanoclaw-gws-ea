/**
 * Managed Cloudflare ingress: one remotely managed tunnel per machine,
 * one route and DNS record per assistant, and one shared connector.
 *
 * Ownership stays exact: the tunnel by name and recorded ID, each DNS record
 * by name, content, and comment, and the route set by each rule's
 * (hostname, path, service) projection against the registry. Everything else
 * a readback carries is tolerated. The route-set write and connector repair
 * take the machine lock; the account token is asked for only when a tunnel,
 * route, or DNS change may be needed.
 */
import {
  CloudflareAmbiguousMutationError,
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareDnsRecord,
  type CloudflareDnsRecordWrite,
  type CloudflareTunnel,
} from './cloudflare-api.js';
import {
  connectorNetworking,
  createCloudflareConnectorLayout,
  hasConnectorToken,
  observeCloudflareConnector,
  repairCloudflareConnector,
  storeConnectorToken,
  type CloudflareConnectorDependencies,
  type CloudflareConnectorLayout,
  type CloudflareConnectorPlatform,
  type CloudflareOriginHost,
} from './cloudflare-connector.js';
import { observeManagedGchatRoute } from './endpoint.js';
import type { ControlPlanePaths } from './paths.js';
import { ABSENT, PRESENT, type StepResource } from './phases.js';
import { activeRemovalInstanceIds, readRegistry, withLockedCloudflareRegistry } from './registry.js';
import { activeStep } from './run-log.js';
import {
  GwsEaError,
  type InstanceRegistry,
  type InstanceReservation,
  type ManagedCloudflareIngressClaim,
} from './types.js';
import { isRecord } from './validation.js';

export const GCHAT_TUNNEL_PATH = '^/webhook/gchat$';
const CATCH_ALL_SERVICE = 'http_status:404';
/** Sends of one rate-limited or unconfirmed idempotent change, each after a re-read shows it absent. */
const CHANGE_ATTEMPTS = 3;

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

export function cloudflareDnsOwnershipComment(instanceId: string): string {
  return `gws-ea managed ingress ${instanceId}`;
}

function managedClaim(instance: InstanceReservation): ManagedCloudflareIngressClaim {
  const claim = instance.exclusive_resource_claims.ingress;
  if (claim.mode !== 'managed-cloudflare') {
    throw new GwsEaError('invalid_registry', 'Managed Cloudflare ingress requires a managed claim');
  }
  return claim;
}

/**
 * The route set: one exact rule per managed assistant, sorted, then the
 * catch-all 404. `without` leaves out assistants being removed.
 */
export function renderManagedCloudflareConfiguration(
  registry: InstanceRegistry,
  originHost: CloudflareOriginHost,
  without: ReadonlySet<string> = new Set(),
): ManagedCloudflareConfiguration {
  const ingress = Object.values(registry.instances)
    .filter(
      (instance) =>
        instance.exclusive_resource_claims.ingress.mode === 'managed-cloudflare' && !without.has(instance.instance_id),
    )
    .map(
      (instance): ManagedCloudflareIngressRule => ({
        hostname: managedClaim(instance).hostname,
        path: GCHAT_TUNNEL_PATH,
        service: `http://${originHost}:${instance.allocated_ports.nanoclaw_webhook}`,
      }),
    )
    .sort((left, right) => left.hostname.localeCompare(right.hostname));
  return { ingress: [...ingress, { service: CATCH_ALL_SERVICE }] };
}

function foreign(message: string): GwsEaError {
  return new GwsEaError('foreign_cloudflare_configuration', message);
}

/**
 * Project a remote configuration onto what ownership compares: each rule's
 * (hostname, path, service), ending in one catch-all. Per-rule settings such
 * as `originRequest` and a null `ingress` are tolerated; other
 * top-level settings are foreign.
 */
function projectConfiguration(value: unknown): ManagedCloudflareConfiguration {
  if (!isRecord(value)) throw foreign('Cloudflare tunnel configuration is not recognized');
  if (Object.keys(value).some((key) => !['ingress', 'warp-routing', 'originRequest'].includes(key))) {
    throw foreign('Cloudflare tunnel configuration contains foreign state');
  }
  const warpRouting = value['warp-routing'];
  if (
    warpRouting !== undefined &&
    (!isRecord(warpRouting) ||
      Object.keys(warpRouting).some((key) => key !== 'enabled') ||
      warpRouting.enabled !== false)
  ) {
    throw foreign('Cloudflare tunnel has a foreign private-network route');
  }
  const originRequest = value.originRequest;
  if (originRequest !== undefined && (!isRecord(originRequest) || Object.keys(originRequest).length > 0)) {
    throw foreign('Cloudflare tunnel has foreign origin settings');
  }
  if (value.ingress === undefined || value.ingress === null) return { ingress: [] };
  if (!Array.isArray(value.ingress)) throw foreign('Cloudflare tunnel ingress is invalid');
  const rules = value.ingress.map((rule): ManagedCloudflareIngressRule | ManagedCloudflareCatchAllRule => {
    if (!isRecord(rule)) throw foreign('Cloudflare tunnel contains a foreign ingress rule');
    if (rule.hostname === undefined && rule.path === undefined && rule.service === CATCH_ALL_SERVICE) {
      return { service: CATCH_ALL_SERVICE };
    }
    if (typeof rule.hostname !== 'string' || rule.path !== GCHAT_TUNNEL_PATH || typeof rule.service !== 'string') {
      throw foreign('Cloudflare tunnel contains a foreign ingress rule');
    }
    return { hostname: rule.hostname, path: GCHAT_TUNNEL_PATH, service: rule.service };
  });
  const catchAlls = rules.filter((rule) => !('hostname' in rule)).length;
  if (rules.length > 0 && (catchAlls !== 1 || 'hostname' in rules.at(-1)!)) {
    throw foreign('Cloudflare tunnel has no single final catch-all');
  }
  return { ingress: rules };
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function sameConfiguration(left: ManagedCloudflareConfiguration, right: ManagedCloudflareConfiguration): boolean {
  return stable(left) === stable(right);
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
  const current = projectConfiguration(remoteConfiguration);
  const owned = new Set(projectConfiguration(ownershipUniverse).ingress.slice(0, -1).map(stable));
  const routes = current.ingress.slice(0, -1).map(stable);
  if (routes.some((route) => !owned.has(route))) {
    throw foreign('Cloudflare tunnel contains a route not owned by the current machine registry');
  }
  if (new Set(routes).size !== routes.length) throw foreign('Cloudflare tunnel contains a duplicate ingress route');
  return current;
}

/**
 * This machine's tunnel among those listed under its name, which only it
 * uses: none, or exactly one with that name and, once recorded, the recorded
 * ID. Anything else is refused. A recorded tunnel that is gone is its
 * caller's to judge.
 */
export function chooseOwnedTunnel(
  tunnels: readonly CloudflareTunnel[],
  name: string,
  recordedId: string | null,
): CloudflareTunnel | undefined {
  if (tunnels.length > 1) {
    throw new GwsEaError('ambiguous_cloudflare_tunnel', `More than one Cloudflare tunnel is named ${name}`);
  }
  const [tunnel] = tunnels;
  if (tunnel && (tunnel.name !== name || (recordedId !== null && tunnel.id !== recordedId))) {
    throw new GwsEaError(
      'foreign_cloudflare_tunnel',
      `Cloudflare tunnel ${name} is not the one this machine recorded; refusing to change it`,
    );
  }
  return tunnel;
}

export function desiredDnsRecord(instance: InstanceReservation, tunnelId: string): CloudflareDnsRecordWrite {
  return {
    type: 'CNAME',
    name: managedClaim(instance).hostname,
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

function matchDnsRecord(
  records: readonly CloudflareDnsRecord[],
  desired: CloudflareDnsRecordWrite,
  expectedId: string | null,
): CloudflareDnsRecord | undefined {
  if (records.length === 0) return undefined;
  const [record] = records;
  if (records.length !== 1 || !record || !dnsMatches(record, desired)) {
    throw new GwsEaError('foreign_cloudflare_dns', `Cloudflare DNS name ${desired.name} contains foreign state`);
  }
  if (expectedId !== null && record.id !== expectedId) {
    throw new GwsEaError('foreign_cloudflare_dns', `Cloudflare DNS name ${desired.name} changed ownership`);
  }
  return record;
}

/**
 * The assistant's own DNS record among the records at its hostname: exactly
 * the one pointing at `tunnelId`, the machine's tunnel. Records there while
 * the machine has no tunnel are foreign, since none of its could point
 * anywhere.
 */
export function chooseOwnedDnsRecord(
  records: readonly CloudflareDnsRecord[],
  instance: InstanceReservation,
  tunnelId: string | null,
): CloudflareDnsRecord | undefined {
  const claim = managedClaim(instance);
  if (tunnelId === null) {
    if (records.length === 0) return undefined;
    throw new GwsEaError(
      'foreign_cloudflare_dns',
      `Cloudflare DNS name ${claim.hostname} has records, but this machine has no tunnel they could point to`,
    );
  }
  return matchDnsRecord(records, desiredDnsRecord(instance, tunnelId), claim.dns_record_id);
}

/**
 * Send one change and confirm it. After any failure the change
 * is re-read: if it shows, it is done. It is sent again only when the re-read
 * shows it absent and Cloudflare rate-limited it (so it was not applied), or
 * the change is idempotent; anything else stops with the original error.
 */
async function change<T>(
  send: () => Promise<T>,
  reread: () => Promise<T | undefined>,
  options: { readonly idempotent: boolean },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      const unconfirmed = error instanceof CloudflareAmbiguousMutationError ? error : undefined;
      let seen: T | undefined;
      try {
        seen = await reread();
      } catch (rereadError) {
        throw unconfirmed ? rereadError : error;
      }
      if (seen !== undefined) return seen;
      if (!unconfirmed || !(unconfirmed.rateLimited || options.idempotent) || attempt >= CHANGE_ATTEMPTS) throw error;
      activeStep()?.write(`${unconfirmed.message}; a re-read shows it was not applied, so it is sent again\n`);
    }
  }
}

/** Replace the whole route set, then read it back. */
export async function replaceManagedCloudflareConfiguration(
  api: CloudflareApi,
  accountId: string,
  tunnelId: string,
  desired: ManagedCloudflareConfiguration,
  expectedBefore: ManagedCloudflareConfiguration,
): Promise<void> {
  /** The version that holds `desired`; undefined while Cloudflare still holds `expectedBefore`. */
  const reread = async (): Promise<number | undefined> => {
    const observed = await api.getTunnelConfiguration(accountId, tunnelId);
    const current = projectConfiguration(observed.config);
    if (sameConfiguration(current, desired)) return observed.version;
    if (sameConfiguration(current, expectedBefore)) return undefined;
    throw new GwsEaError(
      'cloudflare_configuration_drift',
      'Cloudflare tunnel configuration changed while it was being replaced; refusing to overwrite it',
    );
  };
  await change(
    async () => {
      await api.replaceTunnelConfiguration(accountId, tunnelId, desired);
      const version = await reread();
      if (version === undefined) {
        throw new GwsEaError('cloudflare_configuration_drift', 'Cloudflare did not keep the tunnel configuration');
      }
      return version;
    },
    reread,
    { idempotent: true },
  );
}

function createTunnel(api: CloudflareApi, accountId: string, name: string): Promise<CloudflareTunnel> {
  return change(
    async () => {
      const created = chooseOwnedTunnel([await api.createTunnel(accountId, name)], name, null);
      if (!created) throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare created no tunnel');
      return created;
    },
    async () => chooseOwnedTunnel(await api.listTunnels(accountId, name), name, null),
    { idempotent: false },
  );
}

function createDnsRecord(
  api: CloudflareApi,
  zoneId: string,
  desired: CloudflareDnsRecordWrite,
): Promise<CloudflareDnsRecord> {
  return change(
    async () => {
      const created = await api.createDnsRecord(zoneId, desired);
      if (!dnsMatches(created, desired)) {
        throw new GwsEaError(
          'cloudflare_dns_drift',
          `Cloudflare DNS name ${desired.name} did not match after creation`,
        );
      }
      return created;
    },
    async () => matchDnsRecord(await api.listDnsRecords(zoneId, desired.name), desired, null),
    { idempotent: false },
  );
}

export interface ManagedIngressReconcileOptions {
  /** The assistant whose route and DNS record are reconciled; peers' DNS is not read. */
  readonly instanceId: string;
  readonly originHost: CloudflareOriginHost;
  /** Where the connector token read from the owned tunnel is stored for connector repair. */
  readonly connector: CloudflareConnectorLayout;
}

/**
 * Converge the machine's tunnel, the full route set, and one assistant's DNS
 * record under the machine lock. Every read that decides ownership happens
 * before the first change. Assistants under removal leave the route set, so
 * a stuck removal never blocks another assistant.
 */
export async function reconcileManagedCloudflareIngress(
  paths: ControlPlanePaths,
  api: CloudflareApi,
  options: ManagedIngressReconcileOptions,
): Promise<void> {
  await withLockedCloudflareRegistry(paths, async (locked) => {
    const { registry } = locked;
    const instance = registry.instances[options.instanceId];
    const metadata = registry.shared_infrastructure_metadata.cloudflare;
    if (!instance || !metadata) {
      throw new GwsEaError('cloudflare_state_missing', 'This assistant has no managed Cloudflare ingress reserved');
    }
    const claim = managedClaim(instance);
    const removing = new Set(await activeRemovalInstanceIds(paths, registry));
    if (removing.has(options.instanceId)) {
      throw new GwsEaError('removal_in_progress', 'This assistant is being removed; finish its removal instead');
    }

    // Listing zones proves the token, account-owned tokens included.
    const zones = await api.listActiveZones();
    if (!zones.some((zone) => zone.zoneId === claim.zone_id && zone.accountId === claim.account_id)) {
      throw new GwsEaError(
        'cloudflare_capability_missing',
        `Cloudflare authorization cannot read active zone ${claim.zone_name}.`,
      );
    }
    const existing = chooseOwnedTunnel(
      await api.listTunnels(metadata.account_id, metadata.tunnel_name),
      metadata.tunnel_name,
      metadata.tunnel_id,
    );
    if (!existing && metadata.tunnel_id !== null) {
      throw new GwsEaError(
        'cloudflare_tunnel_missing',
        'The recorded Cloudflare tunnel is missing; refusing replacement',
      );
    }
    const recorded = chooseOwnedDnsRecord(
      await api.listDnsRecords(claim.zone_id, claim.hostname),
      instance,
      existing?.id ?? null,
    );
    // Recorded first, so a crash after Cloudflare creates the tunnel still leaves a trace removal can follow.
    if (!existing) await locked.recordTunnelCreationStarted();
    // A new tunnel starts empty, so creating it before reading its configuration changes nothing foreign.
    const tunnel = existing ?? (await createTunnel(api, metadata.account_id, metadata.tunnel_name));
    const current = await api.getTunnelConfiguration(metadata.account_id, tunnel.id);
    const universe = renderManagedCloudflareConfiguration(registry, options.originHost);
    const owned = assertManagedCloudflareConfigurationOwnership(current.config, universe);
    if (metadata.tunnel_id === null) await locked.updateCoordinates({ tunnelId: tunnel.id });
    const desired = renderManagedCloudflareConfiguration(registry, options.originHost, removing);
    if (!sameConfiguration(owned, desired)) {
      await replaceManagedCloudflareConfiguration(api, metadata.account_id, tunnel.id, desired, owned);
    }
    const record = recorded ?? (await createDnsRecord(api, claim.zone_id, desiredDnsRecord(instance, tunnel.id)));
    if (claim.dns_record_id !== record.id) {
      await locked.updateCoordinates({ dnsRecordIds: { [options.instanceId]: record.id } });
    }
    await storeConnectorToken(options.connector, await api.getTunnelToken(metadata.account_id, tunnel.id));
  });
}

/** One assistant's managed transport, as its `establish_transport` step sees it. */
export interface ManagedTransport {
  readonly paths: ControlPlanePaths;
  readonly instanceId: string;
  readonly claim: ManagedCloudflareIngressClaim;
  readonly platform: CloudflareConnectorPlatform;
  /** The assistant's loopback webhook port, which its route targets. */
  readonly webhookPort: number;
  /** The assistant's recorded Docker endpoint, where the connector runs. */
  readonly dockerEndpoint: string;
  /** The account token, asked for only when a tunnel, route, or DNS change may be needed. */
  readonly accountToken: (reason: string) => Promise<string>;
}

export interface ManagedTransportDependencies {
  readonly createApi?: (accountToken: string) => CloudflareApi;
  readonly connector?: CloudflareConnectorDependencies;
  /** Probes the public callback and the local listener. */
  readonly fetch?: typeof globalThis.fetch;
}

async function routeRecorded(transport: ManagedTransport, layout: CloudflareConnectorLayout): Promise<boolean> {
  const registry = await readRegistry(transport.paths);
  const claim = registry.instances[transport.instanceId]?.exclusive_resource_claims.ingress;
  return (
    (registry.shared_infrastructure_metadata.cloudflare?.tunnel_id ?? null) !== null &&
    claim?.mode === 'managed-cloudflare' &&
    claim.dns_record_id !== null &&
    (await hasConnectorToken(layout))
  );
}

function sentence(clause: string): string {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
}

/**
 * `establish_transport`'s resources in managed mode:
 *
 * 1. The Cloudflare route (tunnel, route set, this assistant's DNS record),
 *    observed locally from the recorded coordinates and the stored connector
 *    token: completed cloud setup is not re-proven.
 * 2. The connector, a local runtime repaired from the stored connector token
 *    without the account token. Every assistant shares it, so a running one
 *    on another pin or token is logged as drift and left as it is (KTD11).
 * 3. The public callback, observed from outside. Edge 5xx/53x is waited on
 *    and never changes Cloudflare; a misroute or a hostname that does not
 *    resolve repairs the route, and the engine then waits for DNS and edge
 *    propagation on its bounded schedule.
 */
export function managedTransportResources(
  transport: ManagedTransport,
  dependencies: ManagedTransportDependencies = {},
): readonly StepResource<unknown>[] {
  const { paths, instanceId, claim } = transport;
  const layout = createCloudflareConnectorLayout({
    cloudflareRoot: paths.cloudflareRoot,
    platform: transport.platform,
  });
  const connector = { dockerEndpoint: transport.dockerEndpoint, ...dependencies.connector };
  const localEndpointUrl = `http://127.0.0.1:${transport.webhookPort}/webhook/gchat`;
  let misrouted: string | undefined;
  let reconciled = false;

  const reconcileRoute = async (reason: string): Promise<undefined> => {
    const accountToken = await transport.accountToken(reason);
    const api = (dependencies.createApi ?? ((token: string) => createCloudflareApi({ accountToken: token })))(
      accountToken,
    );
    await reconcileManagedCloudflareIngress(paths, api, {
      instanceId,
      originHost: connectorNetworking(layout.platform).originHost,
      connector: layout,
    });
    reconciled = true;
    return undefined;
  };

  return [
    {
      name: 'the Cloudflare route',
      observe: async () => ((await routeRecorded(transport, layout)) ? PRESENT : ABSENT),
      apply: () => reconcileRoute(`Cloudflare must route ${claim.callback_url} to this assistant`),
    },
    {
      name: 'the Cloudflare connector',
      absentMeansStopped: true,
      observe: async () => {
        const seen = await observeCloudflareConnector(layout, connector);
        if (seen.status === 'present' && seen.drift !== undefined) {
          activeStep()?.write(`the Cloudflare connector: ${seen.drift}; it is shared, so it is left as it is\n`);
        }
        return seen;
      },
      apply: async () => {
        await repairCloudflareConnector(paths, layout, connector);
        return undefined;
      },
    },
    {
      name: 'the public Google Chat callback',
      observe: async () => {
        const seen = await observeManagedGchatRoute(
          { endpointUrl: claim.callback_url, localEndpointUrl },
          dependencies.fetch ? { fetch: dependencies.fetch } : {},
        );
        if (seen.status === 'routed') return PRESENT;
        if (seen.status === 'down') {
          return { status: 'unknown', reason: sentence(seen.observed), evidence: seen.evidence };
        }
        misrouted = seen.observed;
        return { status: 'absent', reason: seen.observed };
      },
      // A route this run already reconciled is given time to propagate, not reconciled again.
      apply: async () =>
        reconciled
          ? undefined
          : reconcileRoute(
              `${sentence(misrouted ?? 'the public callback is misrouted')}; its Cloudflare route needs repair`,
            ),
    },
  ];
}
