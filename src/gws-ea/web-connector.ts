import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from '../community-portal/errors.js';
import { parseWebPolicyFile, readWebPolicy, type WebPolicyFile } from '../modules/gws-ea-web/policy.js';
import { asciiName } from './alias.js';
import { withAssistantLock } from './assistant-lock.js';
import type { InstanceOperation } from './journal.js';
import {
  webAccessApplication,
  webApi,
  webEmailPolicy,
  webEmails,
  webIngress,
  webOperatorFiles,
  assertWebApplication,
  cloudflareId,
  createWebCloudflareApi,
  parseWebOperatorConfig,
  readWebOperatorConfig,
  reconcileWebAccessEmails,
  verifiedPolicyEmails,
  writeWebOperatorConfig,
  type WebCloudflareApi,
  type WebCloudflareDependencies,
  type WebOperatorConfig,
  type WebRemoteAssistant,
} from './web-cloudflare.js';
import { runInstanceNclJson } from './ncl.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import {
  buildToolEnvironment,
  resolvePersistedExecutable,
  runSanitizedCommandOutcome,
  type SanitizedCommandOutcomeRunner,
} from './process.js';
import { registerSecret } from './redact.js';
import {
  claimInstanceWeb,
  getInstanceReservation,
  readRegistry,
  releaseInstanceWeb,
  withMachineLock,
} from './registry.js';
import { readOperatorFile, readOwnerOnlyFile, writePrivateTextFile } from './secrets.js';
import { loadInstanceRuntimeConfig, serviceManagerEnvironment, type InstanceRuntimeConfig } from './service.js';
import { renderLaunchdService, renderSystemdService } from './service-definition.js';
import { GwsEaError, type WebNamespaceClaim } from './types.js';
import { isRecord } from './validation.js';
import { inspectWebUninstall, withWebHostLock } from './web-uninstall.js';

export { inspectWebUninstall, uninstallWebConnector } from './web-uninstall.js';
export type { WebConnectorUninstallData, WebUninstallReceipt } from './web-uninstall.js';

export const WEB_CAPABILITY = {
  name: 'web',
  actions: ['install', 'uninstall', 'show', 'check'],
  scope: 'assistant',
  summary: 'Serve private HTML views and explicitly shared revisions through Cloudflare Access.',
} as const;
export interface WebCapabilityOptions {
  readonly accountId?: string;
  readonly teamName?: string;
  readonly zoneId?: string;
  readonly credentialFile?: string;
  readonly cloudflaredPath?: string;
  readonly discardUnproven?: string;
}
export interface WebCapabilityDependencies extends WebCloudflareDependencies {
  readonly ncl?: typeof runInstanceNclJson;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  readonly recordEffect?: (changed: true | null) => void | Promise<unknown>;
}
export interface WebCapabilityObservation {
  readonly name: 'web';
  readonly scope: 'assistant';
  readonly actions: typeof WEB_CAPABILITY.actions;
  readonly summary: string;
  readonly instance_id: string;
  readonly observed_at: string;
  readonly activation: 'enabled' | 'disabled' | 'unavailable';
  readonly hostname: string | null;
  readonly policy_file: string;
  readonly remote: 'not_checked' | 'verified' | 'mismatch' | 'unavailable';
  readonly listener: 'not_checked' | 'listening' | 'unavailable';
  readonly ready: boolean;
  readonly reason: string | null;
  readonly reason_code: string | null;
  readonly operator: {
    readonly status: 'configured' | 'missing' | 'unavailable';
    readonly account_id: string | null;
    readonly team_name: string | null;
    readonly zone_id: string | null;
    readonly zone_apex: string | null;
    readonly pending: { readonly kind: string; readonly attempt: string; readonly started_at: string } | null;
  };
}
export interface WebOperationData {
  readonly name: 'web';
  readonly scope: 'assistant';
  readonly actions: typeof WEB_CAPABILITY.actions;
  readonly summary: string;
  readonly instance_id: string;
  readonly enabled: boolean;
  readonly changed: boolean;
  readonly hostname: string | null;
}

export interface WebAssistantProvisioning {
  readonly instance_id: string;
  readonly outcome: 'ready' | 'pending' | 'unsupported';
  readonly reason: string | null;
  readonly message: string | null;
  readonly changed: boolean;
}

export interface WebConnectorOperation {
  readonly name: 'web';
  readonly scope: 'host';
  readonly installed: true;
  readonly changed: boolean;
  readonly assistants: readonly WebAssistantProvisioning[];
}

export type WebReleaseCompatibility = 'compatible' | 'unsupported' | 'unknown';
const WEB_CONTRACT = 'gws-ea-web-1';

export async function webReleaseCompatibility(checkout: string): Promise<WebReleaseCompatibility> {
  try {
    const marker: unknown = JSON.parse(
      await readFile(path.join(checkout, 'src/gws-ea/web-compatibility.json'), 'utf8'),
    );
    if (!isRecord(marker) || marker.schemaVersion !== 1 || typeof marker.contract !== 'string') return 'unknown';
    return marker.contract === WEB_CONTRACT ? 'compatible' : 'unsupported';
  } catch (cause) {
    if (isErrno(cause, 'ENOENT') || isErrno(cause, 'ENOTDIR')) return 'unsupported';
    if (cause instanceof SyntaxError) return 'unknown';
    throw cause;
  }
}

export async function webConnectorInstalled(paths: ControlPlanePaths): Promise<boolean> {
  if (await inspectWebUninstall(paths)) return false;
  return (await readWebOperatorConfig(webOperatorFiles(paths).configFile)) !== undefined;
}

async function provisionRecordedAssistant(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: WebCapabilityDependencies,
): Promise<WebAssistantProvisioning> {
  let changed = false;
  try {
    const config = await readWebOperatorConfig(webOperatorFiles(paths).configFile);
    if (config?.pending)
      return {
        instance_id: instanceId,
        outcome: 'pending',
        reason: 'web_create_unproven',
        message: `Unproven ${config.pending.kind} creation ${config.pending.key} must be resolved before provisioning.`,
        changed,
      };
    const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId));
    const compatibility = await webReleaseCompatibility(runtime.checkout_root);
    if (compatibility !== 'compatible')
      return {
        instance_id: instanceId,
        outcome: compatibility === 'unsupported' ? 'unsupported' : 'pending',
        reason: compatibility === 'unsupported' ? 'release_unsupported' : 'release_unknown',
        message:
          compatibility === 'unsupported'
            ? 'Update this assistant to a release that supports web.'
            : 'The assistant release compatibility marker is unreadable.',
        changed,
      };
    const result = await provisionWebAssistant(paths, instanceId, {
      ...dependencies,
      recordEffect: async (effect) => {
        if (effect === true) changed = true;
        await dependencies.recordEffect?.(effect);
      },
    });
    return { instance_id: instanceId, outcome: 'ready', reason: null, message: null, changed: result.changed };
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return {
      instance_id: instanceId,
      outcome: 'pending',
      reason: cause instanceof GwsEaError ? cause.code : 'web_host_unavailable',
      message:
        cause instanceof GwsEaError
          ? cause.message
          : 'The assistant host or web prerequisites could not be observed. Start the assistant and rerun connector installation.',
      changed,
    };
  }
}

/** Configure the host once, then reconcile every registered assistant using its native instance lock. */
export async function installWebConnector(
  paths: ControlPlanePaths,
  options: WebCapabilityOptions = {},
  dependencies: WebCapabilityDependencies = {},
): Promise<WebConnectorOperation> {
  return withWebHostLock(paths, async () => {
    const uninstall = await inspectWebUninstall(paths);
    if (uninstall) {
      if (options.discardUnproven) {
        await dependencies.recordEffect?.(null);
        await configure(paths, { discardUnproven: options.discardUnproven }, dependencies);
        await dependencies.recordEffect?.(true);
      }
      throw new GwsEaError(
        'web_uninstall_incomplete',
        'Finish web uninstall before installing it again. Rerun gws-ea connectors uninstall web.',
      );
    }
    await dependencies.recordEffect?.(null);
    const previous = await readWebOperatorConfig(webOperatorFiles(paths).configFile);
    const config = await configure(paths, options, dependencies);
    let changed =
      previous === undefined || options.credentialFile !== undefined || options.discardUnproven !== undefined;
    if (changed) await dependencies.recordEffect?.(true);
    const assistants: WebAssistantProvisioning[] = [];
    for (const instanceId of Object.keys((await readRegistry(paths)).instances).sort()) {
      let result: WebAssistantProvisioning;
      try {
        result = await withAssistantLock(paths, instanceId, () =>
          provisionRecordedAssistant(paths, instanceId, dependencies),
        );
      } catch (cause) {
        if (!(cause instanceof GwsEaError)) throw cause;
        result = {
          instance_id: instanceId,
          outcome: 'pending',
          reason: cause.code,
          message: cause.message,
          changed: false,
        };
      }
      assistants.push(result);
      changed ||= result.changed;
    }
    if (config.pending && assistants.length === 0)
      throw new GwsEaError(
        'web_create_unproven',
        `Unproven ${config.pending.kind} creation ${config.pending.key} must be resolved before provisioning.`,
      );
    return { name: 'web', scope: 'host', installed: true, changed, assistants };
  });
}

/** Called by create/update/start while their existing instance operation is held. */
export async function provisionAssistantWeb(
  operation: InstanceOperation,
  dependencies: WebCapabilityDependencies = {},
): Promise<WebAssistantProvisioning | undefined> {
  operation.assertActive();
  if (!(await webConnectorInstalled(operation.paths))) return undefined;
  try {
    return await withWebHostLock(operation.paths, async () => {
      operation.assertActive();
      if (!(await webConnectorInstalled(operation.paths))) return undefined;
      return provisionRecordedAssistant(operation.paths, operation.instanceId, {
        ...dependencies,
        recordEffect: async (effect) => {
          operation.recordEffect?.(effect);
          await dependencies.recordEffect?.(effect);
        },
      });
    });
  } catch (cause) {
    if (!(cause instanceof GwsEaError)) throw cause;
    return {
      instance_id: operation.instanceId,
      outcome: 'pending',
      reason: cause.code,
      message: cause.message,
      changed: false,
    };
  }
}
export function instanceWebPolicyFile(runtime: Pick<InstanceRuntimeConfig, 'instance_root'>): string {
  return path.join(runtime.instance_root, 'web', 'policy.json');
}
async function target(paths: ControlPlanePaths, instanceId: string) {
  const reservation = await getInstanceReservation(paths, instanceId);
  const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId));
  return { reservation, runtime, policyFile: instanceWebPolicyFile(runtime) };
}
async function writePolicy(file: string, policy: WebPolicyFile): Promise<void> {
  if (!parseWebPolicyFile(policy)) throw new GwsEaError('web_policy_invalid', 'Web policy coordinates are invalid.');
  await preparePrivateDirectory(path.dirname(file));
  await writePrivateTextFile(file, `${JSON.stringify(policy)}\n`);
}
function operation(
  instanceId: string,
  claim: WebNamespaceClaim | undefined,
  enabled: boolean,
  changed: boolean,
): WebOperationData {
  return {
    ...WEB_CAPABILITY,
    instance_id: instanceId,
    enabled,
    changed,
    hostname: claim?.hostname ?? null,
  };
}

async function configure(
  paths: ControlPlanePaths,
  options: WebCapabilityOptions,
  dependencies: WebCapabilityDependencies,
): Promise<WebOperatorConfig> {
  const files = webOperatorFiles(paths);
  return withMachineLock(paths, async () => {
    await preparePrivateDirectory(files.root);
    let existing = await readWebOperatorConfig(files.configFile);
    if (existing) {
      if (options.discardUnproven) {
        if (!existing.pending || existing.pending.key !== options.discardUnproven)
          throw new GwsEaError(
            'web_attempt_mismatch',
            'Only the exact unresolved attempt may be acknowledged after its possible remote resource was removed.',
          );
        if ((existing.resolvedAttempts?.length ?? 0) >= 64)
          throw new GwsEaError(
            'web_attempt_capacity',
            'The retained recovery receipt is full. Preserve and inspect it before further provisioning.',
          );
        const { pending, ...rest } = existing;
        existing = {
          ...rest,
          resolvedAttempts: [
            ...(rest.resolvedAttempts ?? []),
            { ...pending, resolvedAt: new Date().toISOString(), resolution: 'operator_removed' },
          ],
        };
        await writeWebOperatorConfig(files.configFile, existing);
      }
      for (const key of ['accountId', 'teamName', 'zoneId', 'cloudflaredPath'] as const)
        if (options[key] !== undefined && options[key] !== existing[key])
          throw new GwsEaError(
            'web_operator_conflict',
            'The operator account, team, zone and connector retain their recorded coordinates.',
          );
      if (options.credentialFile) {
        const token = (
          await readOperatorFile(
            options.credentialFile,
            paths.configRoot,
            'Cloudflare management credential',
            'web_credential_invalid',
          )
        ).trim();
        registerSecret(token);
        await verifyCoordinates(createWebCloudflareApi(token, dependencies), existing, existing.zoneApex);
        await writePrivateTextFile(existing.credentialFile, token);
      }
      return existing;
    }
    if (!options.accountId || !options.teamName || !options.zoneId || !options.credentialFile)
      throw new GwsEaError(
        'web_operator_required',
        'First install requires --account, --team, --zone and --credential-file under the operator config root.',
      );
    const credentialFile = path.join(files.root, 'management-token');
    const token = (
      await readOperatorFile(
        options.credentialFile,
        paths.configRoot,
        'Cloudflare management credential',
        'web_credential_invalid',
      )
    ).trim();
    registerSecret(token);
    const zoneApex = await verifyCoordinates(createWebCloudflareApi(token, dependencies), {
      accountId: options.accountId,
      teamName: options.teamName,
      zoneId: options.zoneId,
    });
    const config = parseWebOperatorConfig({
      schemaVersion: 1,
      accountId: options.accountId,
      teamName: options.teamName,
      zoneId: options.zoneId,
      zoneApex,
      credentialFile,
      cloudflaredPath: await resolvePersistedExecutable(options.cloudflaredPath ?? 'cloudflared'),
      dns: {},
      assistants: {},
    });
    await writePrivateTextFile(credentialFile, token);
    await writeWebOperatorConfig(files.configFile, config);
    return config;
  });
}

async function verifyCoordinates(
  api: WebCloudflareApi,
  config: Pick<WebOperatorConfig, 'accountId' | 'teamName' | 'zoneId'>,
  expectedApex?: string,
): Promise<string> {
  const zone = await api.request('GET', `/zones/${config.zoneId}`);
  if (
    !isRecord(zone) ||
    zone.id !== config.zoneId ||
    zone.status !== 'active' ||
    !isRecord(zone.account) ||
    zone.account.id !== config.accountId ||
    typeof zone.name !== 'string' ||
    (expectedApex !== undefined && zone.name !== expectedApex)
  )
    throw new GwsEaError(
      'web_zone_invalid',
      'The selected zone must be active and belong to the configured Cloudflare account.',
    );
  const organization = await api.request('GET', `/accounts/${config.accountId}/access/organizations`);
  if (!isRecord(organization) || organization.auth_domain !== `${config.teamName}.cloudflareaccess.com`)
    throw new GwsEaError('web_team_invalid', 'The configured Access team does not belong to this account.');
  return zone.name;
}

function overlapsHostname(candidate: unknown, hostname: string): boolean {
  return (
    typeof candidate === 'string' &&
    (candidate.toLowerCase() === hostname ||
      candidate === '*' ||
      (candidate.startsWith('*.') && hostname.endsWith(candidate.toLowerCase().slice(1))))
  );
}

function assertNoAccessOverlap(apps: readonly Record<string, unknown>[], hostname: string, ownedId?: string): void {
  for (const app of apps) {
    if (app.id === ownedId) continue;
    const destinations: unknown[] = Array.isArray(app.destinations) ? app.destinations : [];
    const uris = [
      app.domain,
      ...(Array.isArray(app.self_hosted_domains) ? app.self_hosted_domains : []),
      ...destinations.map((destination) =>
        isRecord(destination) && destination.type === 'public' ? destination.uri : undefined,
      ),
    ];
    for (const uri of uris) {
      if (typeof uri === 'string' && overlapsHostname(uri.split('/')[0], hostname))
        throw new GwsEaError(
          'web_hostname_foreign',
          `Access destination ${uri} already covers ${hostname}. Remove that unowned destination and rerun gws-ea connectors install web.`,
        );
    }
  }
}

/** Read-only hostname preflight; callers decide whether its result permits a claim or only reports readiness. */
export async function assertWebHostnameAvailable(
  config: WebOperatorConfig,
  hostname: string,
  dependencies: WebCapabilityDependencies = {},
): Promise<void> {
  const api = await webApi(config, dependencies);
  for (const name of [hostname, `*.${config.zoneApex}`]) {
    const records = await api.list(`/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(name)}`);
    for (const record of records) {
      if (record.id !== config.dns[name]?.id)
        throw new GwsEaError(
          'web_hostname_foreign',
          `DNS record ${name} (${cloudflareId(record)}) already covers ${hostname}. Remove that unowned record and rerun gws-ea connectors install web.`,
        );
    }
  }
  assertNoAccessOverlap(await api.list(`/accounts/${config.accountId}/access/apps`), hostname);
  if (config.tunnelId) {
    const current = await api.request(
      'GET',
      `/accounts/${config.accountId}/cfd_tunnel/${config.tunnelId}/configurations`,
    );
    const routes = isRecord(current) && isRecord(current.config) ? current.config.ingress : undefined;
    if (!Array.isArray(routes) || !routes.every(isRecord))
      throw new GwsEaError('web_tunnel_invalid', 'The recorded tunnel ingress could not be verified.');
    for (const route of routes) {
      if (
        overlapsHostname(route.hostname, hostname) ||
        (route.hostname === undefined && (route.path !== undefined || route.service !== 'http_status:404'))
      )
        throw new GwsEaError(
          'web_hostname_foreign',
          `Tunnel route ${String(route.hostname ?? '*')} already covers ${hostname}. Remove that unowned route and rerun gws-ea connectors install web.`,
        );
    }
  }
}

async function claimNamespace(
  paths: ControlPlanePaths,
  instanceId: string,
  firstName: string,
  config: WebOperatorConfig,
  dependencies: WebCapabilityDependencies,
): Promise<WebNamespaceClaim> {
  const previous = (await getInstanceReservation(paths, instanceId)).exclusive_resource_claims.web;
  if (previous) return previous;
  const label = asciiName(firstName).slice(0, 63);
  if (!/[a-z]/u.test(label))
    throw new GwsEaError(
      'web_name_unusable',
      `“${firstName}” has no Latin letter for a web address. Recreate this assistant under a first name with a Latin letter.`,
    );
  const hostname = `${label}.${config.zoneApex}`;
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback listener');
    const claim = { hostname, listen_port: address.port };
    await claimInstanceWeb(paths, instanceId, claim, async (registry) => {
      const holder = Object.values(registry.instances).find(
        (assistant) =>
          assistant.instance_id !== instanceId && assistant.exclusive_resource_claims.web?.hostname === hostname,
      );
      if (holder)
        throw new GwsEaError(
          'web_hostname_claimed',
          `${hostname} is already held by assistant ${holder.instance_id}. Recreate this assistant under another first name, or remove the holder.`,
        );
      const live = await readWebOperatorConfig(webOperatorFiles(paths).configFile);
      if (!live) throw new GwsEaError('web_not_installed', 'Web is not installed on this operator host.');
      await assertWebHostnameAvailable(live, hostname, dependencies);
    });
    return claim;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

/** Must run under the machine lock: remote PUT replaces the complete tunnel configuration. */
export async function setWebIngress(
  api: WebCloudflareApi,
  config: WebOperatorConfig,
  claim: WebNamespaceClaim,
  enabled: boolean,
): Promise<void> {
  if (!config.tunnelId) return;
  const resource = `/accounts/${config.accountId}/cfd_tunnel/${config.tunnelId}/configurations`;
  const remote = await api.request('GET', resource);
  if (!isRecord(remote) || (remote.config !== undefined && remote.config !== null && !isRecord(remote.config)))
    throw new GwsEaError('web_tunnel_unverified', 'Cloudflare tunnel configuration is invalid.');
  const current = isRecord(remote.config) ? remote.config : {};
  if (
    isRecord(current.originRequest) &&
    isRecord(current.originRequest.access) &&
    current.originRequest.access.required === true
  )
    throw new GwsEaError(
      'web_tunnel_conflict',
      'Global tunnel Access enforcement would block the explicitly public namespace.',
    );
  const ingress = current.ingress === undefined ? [] : current.ingress;
  if (!Array.isArray(ingress) || !ingress.every(isRecord))
    throw new GwsEaError('web_tunnel_unverified', 'Cloudflare tunnel ingress is invalid.');
  const expected = webIngress(claim);
  const retained: Record<string, unknown>[] = [];
  for (const route of ingress) {
    if (route.hostname === claim.hostname && route.path === expected.path) {
      if (route.service !== expected.service)
        throw new GwsEaError('web_tunnel_conflict', 'The claimed tunnel route points to an unowned service.');
      continue;
    }
    if (route.hostname === undefined && route.path === undefined) {
      if (route.service !== 'http_status:404')
        throw new GwsEaError('web_tunnel_conflict', 'The tunnel has an unowned catch-all service.');
      continue;
    }
    const overlappingHost =
      route.hostname === undefined ||
      route.hostname === claim.hostname ||
      route.hostname === '*' ||
      (typeof route.hostname === 'string' &&
        route.hostname.startsWith('*.') &&
        claim.hostname.endsWith(route.hostname.slice(1)));
    if (
      overlappingHost &&
      !Object.values(config.assistants).some((assistant) => {
        const owned = webIngress(assistant.claim);
        return owned.hostname === route.hostname && owned.path === route.path && owned.service === route.service;
      })
    )
      throw new GwsEaError('web_tunnel_conflict', 'An unowned tunnel route overlaps this assistant hostname.');
    retained.push(route);
  }
  const next = { ...current, ingress: [...retained, ...(enabled ? [expected] : []), { service: 'http_status:404' }] };
  if (JSON.stringify(current) !== JSON.stringify(next)) await api.request('PUT', resource, { config: next });
  const verified = await api.request('GET', resource);
  if (!isRecord(verified) || !isRecord(verified.config) || JSON.stringify(verified.config) !== JSON.stringify(next))
    throw new GwsEaError('web_tunnel_unverified', 'Cloudflare tunnel ingress has not converged.');
}

function confirmedOwnershipMismatch(code: string | null): boolean {
  return [
    'web_dns_missing',
    'web_dns_mismatch',
    'web_application_mismatch',
    'web_tunnel_invalid',
    'web_owned_resource_missing',
  ].includes(code ?? '');
}

async function readOwnedResource(api: WebCloudflareApi, resource: string): Promise<unknown> {
  try {
    return await api.request('GET', resource);
  } catch (cause) {
    if (cause instanceof GwsEaError && cause.details?.status === 404)
      throw new GwsEaError('web_owned_resource_missing', 'Cloudflare reports a recorded Web resource missing.', {
        cause,
      });
    throw cause;
  }
}

async function provision(
  paths: ControlPlanePaths,
  instanceId: string,
  claim: WebNamespaceClaim,
  emails: readonly string[],
  dependencies: WebCapabilityDependencies,
): Promise<WebOperatorConfig> {
  const file = webOperatorFiles(paths).configFile;
  return withMachineLock(paths, async () => {
    const loaded = await readWebOperatorConfig(file);
    if (!loaded) throw new GwsEaError('web_operator_required', 'Web operator configuration is missing.');
    let config: WebOperatorConfig = loaded;
    if (config.pending)
      throw new GwsEaError(
        'web_create_unproven',
        'An interrupted Cloudflare create is unresolved. Inspect the recorded attempt and resolve its exact remote outcome before retrying; resources are never adopted by name.',
        { details: { resource: config.pending.kind, attempt: config.pending.key } },
      );
    const api = await webApi(config, dependencies);
    const account = `/accounts/${config.accountId}`;
    await verifyCoordinates(api, config, config.zoneApex);
    const zoneId = config.zoneId;
    const save = async (next: WebOperatorConfig): Promise<void> => {
      await writeWebOperatorConfig(file, next);
      config = next;
    };
    const create = async (
      kind: NonNullable<WebOperatorConfig['pending']>['kind'],
      key: string,
      resource: string,
      body: unknown,
      recorded: (id: string) => WebOperatorConfig,
    ): Promise<void> => {
      await save({
        ...config,
        pending: {
          kind,
          key: randomUUID(),
          target: key,
          startedAt: new Date().toISOString(),
          resource,
          fingerprint: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
          ...(isRecord(body) && typeof body.name === 'string' ? { name: body.name } : {}),
        },
      });
      let result: unknown;
      try {
        result = await api.request('POST', resource, body);
      } catch (cause) {
        if (cause instanceof GwsEaError && cause.details?.definite_rejection === true) {
          const { pending: _pending, ...rest } = config;
          await save(rest);
        }
        throw cause;
      }
      const id = cloudflareId(result);
      const { pending: _pending, ...next } = recorded(id);
      await save(next);
    };
    const idps = await api.list(`${account}/access/identity_providers`);
    if (config.pin) {
      if (!idps.some((idp) => idp.id === config?.pin?.id && idp.type === 'onetimepin'))
        throw new GwsEaError('web_pin_missing', 'The recorded one-time-PIN identity provider is missing.');
    } else {
      const pin = idps.find((idp) => idp.type === 'onetimepin');
      if (pin) await save({ ...config, pin: { id: cloudflareId(pin), owned: false } });
      else
        await create(
          'pin',
          randomUUID(),
          `${account}/access/identity_providers`,
          { name: 'Web email PIN', type: 'onetimepin', config: {} },
          (id) => ({ ...config, pin: { id, owned: true } }),
        );
    }
    if (!config.tunnelId)
      await create(
        'tunnel',
        randomUUID(),
        `${account}/cfd_tunnel`,
        { name: `gws-ea-web-${randomUUID()}`, config_src: 'cloudflare' },
        (id) => ({ ...config, tunnelId: id }),
      );
    const tunnel = await readOwnedResource(api, `${account}/cfd_tunnel/${config.tunnelId}`);
    if (
      !isRecord(tunnel) ||
      typeof tunnel.id !== 'string' ||
      typeof tunnel.config_src !== 'string' ||
      (tunnel.deleted_at !== null && typeof tunnel.deleted_at !== 'string')
    )
      throw new GwsEaError('web_tunnel_unobserved', 'Cloudflare did not return a verifiable tunnel record.');
    if (tunnel.id !== config.tunnelId || tunnel.config_src !== 'cloudflare' || tunnel.deleted_at)
      throw new GwsEaError('web_tunnel_invalid', 'The recorded remotely managed tunnel is unavailable.');
    const dns = config.dns[claim.hostname];
    if (!dns) {
      const existing = await api.list(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(claim.hostname)}`);
      if (existing.length)
        throw new GwsEaError(
          'web_dns_conflict',
          'The hostname already has DNS records that this operator does not own.',
        );
      await create(
        'dns',
        claim.hostname,
        `/zones/${zoneId}/dns_records`,
        { type: 'CNAME', name: claim.hostname, content: `${config.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 },
        (id) => ({ ...config, dns: { ...config.dns, [claim.hostname]: { id, zoneId } } }),
      );
    }
    const ownedDns = config.dns[claim.hostname];
    const record = await readOwnedResource(api, `/zones/${ownedDns.zoneId}/dns_records/${ownedDns.id}`);
    assertDns(record, claim.hostname, config.tunnelId!, ownedDns.id);
    let assistant: WebRemoteAssistant = config.assistants[instanceId] ?? { claim, enabled: false };
    if (JSON.stringify(assistant.claim) !== JSON.stringify(claim))
      throw new GwsEaError('web_owner_mismatch', 'Recorded web namespace does not match the assistant claim.');
    const apps = await api.list(`${account}/access/apps`);
    assertNoAccessOverlap(apps, claim.hostname, assistant.applicationId);
    if (!assistant.applicationId) {
      if (apps.length >= 500)
        throw new GwsEaError(
          'web_cloudflare_capacity',
          'The Cloudflare account has reached its Access application limit.',
        );
      await create(
        'application',
        instanceId,
        `${account}/access/apps`,
        webAccessApplication(claim, config.pin!.id),
        (id) => ({
          ...config,
          assistants: { ...config.assistants, [instanceId]: { ...assistant, applicationId: id } },
        }),
      );
      assistant = config.assistants[instanceId];
    }
    const appPath = `${account}/access/apps/${assistant.applicationId}`;
    const app = await readOwnedResource(api, appPath);
    if (!isRecord(app) || typeof app.aud !== 'string')
      throw new GwsEaError('web_access_unverified', 'Cloudflare did not return the application audience.');
    if (!assistant.aud) {
      assistant = { ...assistant, aud: app.aud };
      await save({ ...config, assistants: { ...config.assistants, [instanceId]: assistant } });
    }
    assertWebApplication(app, assistant, config);
    const policies = await api.list(`${appPath}/policies`);
    if (!assistant.policyId) {
      if (policies.length)
        throw new GwsEaError(
          'web_access_conflict',
          'The owned application has an unrecorded policy. It was left unchanged.',
        );
      await create('policy', instanceId, `${appPath}/policies`, webEmailPolicy(emails), (id) => ({
        ...config,
        assistants: { ...config.assistants, [instanceId]: { ...assistant, policyId: id } },
      }));
      assistant = config.assistants[instanceId];
    } else if (policies.length !== 1 || policies[0].id !== assistant.policyId)
      throw new GwsEaError('web_access_conflict', 'The owned application has unexpected policies.');
    const token = await api.request('GET', `${account}/cfd_tunnel/${config.tunnelId}/token`);
    if (typeof token !== 'string' || !token || /\s/u.test(token))
      throw new GwsEaError('web_tunnel_token_unavailable', 'Cloudflare tunnel run token is unavailable.');
    registerSecret(token);
    await writePrivateTextFile(webOperatorFiles(paths).tokenFile, token);
    assistant = { ...assistant, enabled: true };
    await save({ ...config, assistants: { ...config.assistants, [instanceId]: assistant } });
    return config;
  });
}

function assertDns(record: unknown, hostname: string, tunnelId: string, expectedId: string): void {
  if (
    !isRecord(record) ||
    typeof record.id !== 'string' ||
    typeof record.type !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.content !== 'string' ||
    typeof record.proxied !== 'boolean'
  )
    throw new GwsEaError('web_dns_unverified', 'Cloudflare did not return a verifiable DNS record.');
  if (
    record.id !== expectedId ||
    record.type !== 'CNAME' ||
    record.name !== hostname ||
    record.content !== `${tunnelId}.cfargotunnel.com` ||
    record.proxied !== true
  )
    throw new GwsEaError('web_dns_mismatch', 'The owned DNS record no longer points at the recorded tunnel.');
}

export function supportedCloudflaredVersion(output: string): boolean {
  const match = /^cloudflared version (\d{4})\.(\d+)\.(\d+)\b/u.exec(output.trim());
  return match !== null && (Number(match[1]) > 2025 || (Number(match[1]) === 2025 && Number(match[2]) >= 4));
}

async function verifyConnectorExecutable(
  config: WebOperatorConfig,
  runtime: InstanceRuntimeConfig,
  dependencies: WebCapabilityDependencies,
): Promise<void> {
  const result = await (dependencies.runCommand ?? runSanitizedCommandOutcome)({
    command: config.cloudflaredPath,
    args: ['--version'],
    cwd: runtime.instance_root,
    env: buildToolEnvironment({}, { HOME: runtime.home_directory }),
    timeoutMs: 5000,
    outputLimitBytes: 4096,
  });
  if (result.exitCode !== 0 || !supportedCloudflaredVersion(result.stdout))
    throw new GwsEaError(
      'web_connector_unsupported',
      'cloudflared 2025.4.0 or later is required for the owner-only run-token file.',
    );
}

export function renderWebConnectorService(
  files: ReturnType<typeof webOperatorFiles>,
  cloudflaredPath: string,
  connector: NonNullable<WebOperatorConfig['connector']>,
): string {
  const input = {
    programArguments: [cloudflaredPath, 'tunnel', '--no-autoupdate', 'run', '--token-file', files.tokenFile],
    workingDirectory: files.root,
    environment: { HOME: connector.homeDirectory, PATH: '/usr/local/bin:/usr/bin:/bin' },
    standardOutputPath: path.join(files.root, 'connector.log'),
    standardErrorPath: path.join(files.root, 'connector.error.log'),
  };
  return connector.manager === 'launchd'
    ? renderLaunchdService({ ...input, label: connector.label })
    : renderSystemdService({
        ...input,
        wantedBy: connector.manager === 'systemd-system' ? 'multi-user.target' : 'default.target',
      });
}

async function startConnector(
  paths: ControlPlanePaths,
  runtime: InstanceRuntimeConfig,
  dependencies: WebCapabilityDependencies,
): Promise<void> {
  await withMachineLock(paths, async () => {
    const files = webOperatorFiles(paths);
    const loaded = await readWebOperatorConfig(files.configFile);
    if (!loaded?.tunnelId) throw new GwsEaError('web_tunnel_invalid', 'The tunnel has not been provisioned.');
    let config: WebOperatorConfig = loaded;
    const uid = process.getuid?.();
    if (uid === undefined || !['darwin', 'linux'].includes(process.platform))
      throw new GwsEaError('unsupported_platform', 'Web connector service needs macOS or Linux.');
    const label = `com.gws-ea.web.${createHash('sha256').update(paths.configRoot).digest('hex').slice(0, 16)}`;
    const manager = process.platform === 'darwin' ? 'launchd' : uid === 0 ? 'systemd-system' : 'systemd-user';
    const definitionFile =
      manager === 'launchd'
        ? path.join(runtime.home_directory, 'Library', 'LaunchAgents', `${label}.plist`)
        : manager === 'systemd-system'
          ? `/etc/systemd/system/${label}.service`
          : path.join(runtime.home_directory, '.config', 'systemd', 'user', `${label}.service`);
    const connector = { manager, definitionFile, label, homeDirectory: runtime.home_directory } as const;
    if (
      config.connector &&
      (config.connector.manager !== connector.manager ||
        config.connector.definitionFile !== connector.definitionFile ||
        config.connector.label !== connector.label ||
        config.connector.homeDirectory !== connector.homeDirectory)
    )
      throw new GwsEaError('web_connector_conflict', 'The shared connector service coordinates changed.');
    const definition = renderWebConnectorService(files, config.cloudflaredPath, connector);
    const stored = await readOwnerOnlyFile(definitionFile).catch((cause: unknown) => {
      if (isErrno(cause, 'ENOENT')) return undefined;
      throw cause;
    });
    if (!config.connector && stored !== undefined)
      throw new GwsEaError(
        'web_connector_conflict',
        'An unowned service definition already exists at the connector path.',
      );
    if (stored !== undefined && stored !== definition)
      throw new GwsEaError(
        'web_connector_conflict',
        'The owned connector service definition was changed outside this capability.',
      );
    if (!config.connector) {
      config = { ...config, connector };
      await writeWebOperatorConfig(files.configFile, config);
    }
    if (stored === undefined) {
      await mkdir(path.dirname(definitionFile), { recursive: true, mode: 0o700 });
      await writePrivateTextFile(definitionFile, definition);
    }
    const run = dependencies.runCommand ?? runSanitizedCommandOutcome;
    const invoke = (command: string, args: readonly string[]) =>
      run({
        command,
        args,
        cwd: files.root,
        env: serviceManagerEnvironment(runtime, manager, {}),
        timeoutMs: 10000,
        outputLimitBytes: 4096,
      });
    if (manager === 'launchd') {
      const domain = `gui/${uid}`;
      const current = await invoke('launchctl', ['print', `${domain}/${label}`]);
      if (current.exitCode !== 0 && (await invoke('launchctl', ['bootstrap', domain, definitionFile])).exitCode !== 0)
        throw new GwsEaError('web_connector_failed', 'The owned cloudflared launchd service could not start.');
    } else {
      const args = manager === 'systemd-user' ? ['--user'] : [];
      if (
        (await invoke('systemctl', [...args, 'daemon-reload'])).exitCode !== 0 ||
        (await invoke('systemctl', [...args, 'enable', '--now', `${label}.service`])).exitCode !== 0
      )
        throw new GwsEaError('web_connector_failed', 'The owned cloudflared systemd service could not start.');
    }
  });
}

function availableHealth(value: unknown, port: number): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.policyVersions) &&
    value.policyVersions.includes(1) &&
    value.enabled === true &&
    value.availability === 'available' &&
    isRecord(value.listener) &&
    value.listener.state === 'listening' &&
    value.listener.port === port
  );
}
async function hostHealth(
  runtime: InstanceRuntimeConfig,
  dependencies: WebCapabilityDependencies,
  timeoutMs?: number,
): Promise<unknown> {
  return (dependencies.ncl ?? runInstanceNclJson)(runtime, ['gws-ea-web-health'], { timeoutMs });
}

async function waitForArtifactListener(
  runtime: InstanceRuntimeConfig,
  dependencies: WebCapabilityDependencies,
  port: number,
): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      availableHealth(await hostHealth(runtime, dependencies, Math.min(5000, deadline - Date.now())), port) &&
      Date.now() <= deadline
    )
      return true;
    const remaining = deadline - Date.now();
    if (remaining > 0) await (dependencies.sleep ?? delay)(Math.min(500, remaining));
  }
  return false;
}

async function provisionWebAssistant(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: WebCapabilityDependencies = {},
): Promise<WebOperationData> {
  const { runtime, policyFile, reservation } = await target(paths, instanceId);
  const ncl = dependencies.ncl ?? runInstanceNclJson;
  const profile = await ncl(runtime, ['gws-ea-profile-get']);
  if (
    !isRecord(profile) ||
    typeof profile.assistant_first_name !== 'string' ||
    !Array.isArray(profile.principal_emails) ||
    !profile.principal_emails.every((email: unknown): email is string => typeof email === 'string') ||
    !profile.principal_emails.length
  )
    throw new GwsEaError(
      'web_profile_unavailable',
      'Web requires the assistant first name and all confirmed principal email addresses from the running host.',
    );
  const principalEmails = webEmails(profile.principal_emails);
  const health = await hostHealth(runtime, dependencies);
  if (!isRecord(health) || !Array.isArray(health.policyVersions) || !health.policyVersions.includes(1))
    throw new GwsEaError('web_release_unsupported', 'Update and start the assistant before installing web.');
  const config = await readWebOperatorConfig(webOperatorFiles(paths).configFile);
  if (!config) throw new GwsEaError('web_not_installed', 'Web is not installed on this operator host.');
  await verifyConnectorExecutable(config, runtime, dependencies);
  const previousPolicy = await readWebPolicy(policyFile);
  if (previousPolicy.status === 'unavailable')
    throw new GwsEaError('web_policy_invalid', 'Web policy is invalid or inaccessible.');
  let ownershipMismatch = false;
  const recorded = config.assistants[instanceId];
  if (recorded?.publicationReady) {
    const current = await inspectWebCapability(paths, instanceId, { ...dependencies, check: true });
    if (current.ready) return operation(instanceId, recorded.claim, true, false);
    if (current.activation === 'enabled' && current.remote === 'verified') {
      if (await waitForArtifactListener(runtime, dependencies, recorded.claim.listen_port))
        return operation(instanceId, recorded.claim, true, false);
      throw new GwsEaError(
        'web_listener_unavailable',
        'The running assistant has not verified its web listener. Its existing web configuration is retained.',
      );
    }
    ownershipMismatch = confirmedOwnershipMismatch(current.reason_code);
    if (current.remote !== 'mismatch')
      throw new GwsEaError(
        'web_not_ready',
        `${current.reason ?? 'Web prerequisites could not be observed.'} The existing web configuration is retained.`,
      );
  }
  await dependencies.recordEffect?.(null);
  const retained = reservation.exclusive_resource_claims.web;
  const claim =
    retained ?? (await claimNamespace(paths, instanceId, profile.assistant_first_name, config, dependencies));
  await dependencies.recordEffect?.(true);
  const currentEmails = async (): Promise<readonly string[]> => {
    const current = await ncl(runtime, ['gws-ea-web-admission-emails']);
    if (
      !isRecord(current) ||
      !Array.isArray(current.emails) ||
      !current.emails.every((email: unknown): email is string => typeof email === 'string')
    )
      throw new GwsEaError('web_profile_unavailable', 'The host could not read authoritative web admission.');
    const exact = webEmails(current.emails);
    if (!principalEmails.every((email) => exact.includes(email)))
      throw new GwsEaError(
        'web_profile_changed',
        'Principal addresses changed during installation. Retry with the current profile.',
      );
    return exact;
  };
  const preserveEnabled = previousPolicy.enabled && !ownershipMismatch;
  let enabledPolicy: WebPolicyFile | undefined = previousPolicy.config;
  try {
    if (ownershipMismatch && enabledPolicy) await writePolicy(policyFile, { ...enabledPolicy, enabled: false });
    const provisioned = await provision(paths, instanceId, claim, await currentEmails(), dependencies);
    const assistant = provisioned.assistants[instanceId];
    await reconcileWebAccessEmails(
      {
        operatorConfigFile: webOperatorFiles(paths).configFile,
        accountId: provisioned.accountId,
        applicationId: assistant.applicationId!,
        emails: currentEmails,
      },
      dependencies,
    );
    enabledPolicy = {
      schemaVersion: 1,
      enabled: true,
      hostname: claim.hostname,
      listenPort: claim.listen_port,
      accessIssuer: `https://${provisioned.teamName}.cloudflareaccess.com`,
      accessAud: assistant.aud!,
      cloudflare: {
        accountId: provisioned.accountId,
        applicationId: assistant.applicationId!,
        operatorConfigFile: webOperatorFiles(paths).configFile,
      },
    };
    await writePolicy(policyFile, enabledPolicy);
    // The host module binds asynchronously. Poll for its listener outside the machine lock, and before ingress
    // opens or the connector starts, since the listener depends on neither.
    if (!(await waitForArtifactListener(runtime, dependencies, claim.listen_port)))
      throw new GwsEaError(
        'web_listener_unavailable',
        'The running assistant has not verified its web listener. Web ingress remains closed.',
      );
    await withMachineLock(paths, async () => {
      const live = await readWebOperatorConfig(webOperatorFiles(paths).configFile);
      if (!live?.assistants[instanceId]?.enabled)
        throw new GwsEaError('web_disabled', 'Web was disabled while provisioning.');
      await setWebIngress(await webApi(live, dependencies), live, claim, true);
    });
    await startConnector(paths, runtime, dependencies);
    const observed = await inspectWebCapability(paths, instanceId, { ...dependencies, check: true });
    if (observed.remote !== 'verified' || observed.listener !== 'listening')
      throw new GwsEaError(
        'web_not_ready',
        'Web prerequisites have not all been verified. Check this connector after resolving the reported prerequisite.',
      );
    if (!recorded?.publicationReady || !preserveEnabled) {
      const authors = await ncl(runtime, ['gws-ea-artifacts-author-groups']);
      if (
        !isRecord(authors) ||
        !Array.isArray(authors.group_ids) ||
        !authors.group_ids.every((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      )
        throw new GwsEaError('web_authors_unavailable', 'The host could not read current artifact author groups.');
      for (const groupId of new Set(authors.group_ids)) await ncl(runtime, ['groups', 'restart', '--id', groupId]);
    }
    const activationPolicy = enabledPolicy;
    await withMachineLock(paths, async () => {
      const file = webOperatorFiles(paths).configFile;
      const live = await readWebOperatorConfig(file);
      const current = live?.assistants[instanceId];
      const policy = await readWebPolicy(policyFile);
      if (
        !live ||
        !current?.enabled ||
        current.applicationId !== activationPolicy.cloudflare.applicationId ||
        current.aud !== activationPolicy.accessAud ||
        JSON.stringify(current.claim) !== JSON.stringify(claim) ||
        policy.status !== 'enabled' ||
        JSON.stringify(policy.config) !== JSON.stringify(activationPolicy)
      )
        throw new GwsEaError('web_disabled', 'Web coordinates changed before activation completed.');
      await writeWebOperatorConfig(file, {
        ...live,
        assistants: { ...live.assistants, [instanceId]: { ...current, publicationReady: true } },
      });
    });
    return operation(instanceId, claim, true, true);
  } catch (cause) {
    if (preserveEnabled && !confirmedOwnershipMismatch(cause instanceof GwsEaError ? cause.code : null)) throw cause;
    if (enabledPolicy) await writePolicy(policyFile, { ...enabledPolicy, enabled: false });
    /* eslint-disable no-catch-all/no-catch-all -- Origin is already closed; retain the original failure when remote cleanup is also unavailable. */
    let releaseUnrecordedClaim = false;
    try {
      await withMachineLock(paths, async () => {
        const file = webOperatorFiles(paths).configFile;
        const live = await readWebOperatorConfig(file);
        const assistant = live?.assistants[instanceId];
        releaseUnrecordedClaim =
          live !== undefined &&
          assistant === undefined &&
          retained === undefined &&
          !previousPolicy.config?.enabled &&
          live.dns[claim.hostname] === undefined &&
          !(live.pending?.kind === 'dns' && live.pending.target === claim.hostname) &&
          !(live.pending && live.pending.target === instanceId);
        if (live && assistant) {
          await writeWebOperatorConfig(file, {
            ...live,
            assistants: {
              ...live.assistants,
              [instanceId]: { ...live.assistants[instanceId], enabled: false, publicationReady: false },
            },
          });
          if (live.tunnelId) await setWebIngress(await webApi(live, dependencies), live, assistant.claim, false);
        }
      });
    } catch (_cleanupCause) {
      /* The disabled policy is authoritative; check observes pending ingress cleanup. */
    }
    /* eslint-enable no-catch-all/no-catch-all */
    if (releaseUnrecordedClaim) await releaseInstanceWeb(paths, instanceId, claim);
    throw cause;
  }
}

/** Read-only and bounded: creates, replaces, reconciles, starts and repairs nothing. */
export async function inspectWebCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: WebCapabilityDependencies & { readonly check?: boolean } = {},
): Promise<WebCapabilityObservation> {
  const { runtime, policyFile, reservation } = await target(paths, instanceId);
  const policy = await readWebPolicy(policyFile);
  const coordinates = policy.status === 'unavailable' ? undefined : policy.config;
  const claim = reservation.exclusive_resource_claims.web;
  let remote: WebCapabilityObservation['remote'] = 'not_checked';
  let listener: WebCapabilityObservation['listener'] = 'not_checked';
  let reasonCode: string | null = null;
  let reason: string | null = policy.status === 'unavailable' ? 'Web policy is invalid or inaccessible.' : null;
  let config: WebOperatorConfig | undefined;
  let operator: WebCapabilityObservation['operator'] = {
    status: 'missing',
    account_id: null,
    team_name: null,
    zone_id: null,
    zone_apex: null,
    pending: null,
  };
  try {
    config = await readWebOperatorConfig(webOperatorFiles(paths).configFile);
    if (config)
      operator = {
        status: 'configured',
        account_id: config.accountId,
        team_name: config.teamName,
        zone_id: config.zoneId,
        zone_apex: config.zoneApex,
        pending: config.pending
          ? { kind: config.pending.kind, attempt: config.pending.key, started_at: config.pending.startedAt }
          : null,
      };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Read-only optional configuration failure remains observable without exposing file contents.
  } catch (_cause) {
    operator = { ...operator, status: 'unavailable' };
    reason = 'Web operator configuration is invalid or inaccessible.';
  }
  if (dependencies.check) {
    try {
      const assistant = config?.assistants[instanceId];
      if (
        !config?.pin ||
        !config.tunnelId ||
        !assistant?.applicationId ||
        !assistant.policyId ||
        !assistant.aud ||
        !coordinates ||
        config.pending
      )
        throw new GwsEaError('web_not_provisioned', 'Web have incomplete or unresolved provisioning.');
      if (
        coordinates.hostname !== assistant.claim.hostname ||
        coordinates.listenPort !== assistant.claim.listen_port ||
        coordinates.accessAud !== assistant.aud ||
        coordinates.accessIssuer !== `https://${config.teamName}.cloudflareaccess.com` ||
        coordinates.cloudflare.accountId !== config.accountId ||
        coordinates.cloudflare.applicationId !== assistant.applicationId ||
        coordinates.cloudflare.operatorConfigFile !== webOperatorFiles(paths).configFile ||
        policy.enabled !== assistant.enabled
      )
        throw new GwsEaError(
          'web_owner_mismatch',
          'Web policy does not match current owned resources and enabled intent.',
        );
      const api = await webApi(config, dependencies);
      await verifyCoordinates(api, config, config.zoneApex);
      const account = `/accounts/${config.accountId}`;
      const idp = await api.request('GET', `${account}/access/identity_providers/${config.pin.id}`);
      if (!isRecord(idp) || idp.type !== 'onetimepin')
        throw new GwsEaError('web_pin_missing', 'The recorded PIN provider is missing.');
      assertWebApplication(
        await readOwnedResource(api, `${account}/access/apps/${assistant.applicationId}`),
        assistant,
        config,
      );
      const policies = await api.list(`${account}/access/apps/${assistant.applicationId}/policies`);
      if (policies.length !== 1 || policies[0].id !== assistant.policyId)
        throw new GwsEaError('web_access_mismatch', 'Unexpected Access policies exist.');
      const admitted = verifiedPolicyEmails(policies[0]);
      const admission = await (dependencies.ncl ?? runInstanceNclJson)(runtime, ['gws-ea-web-admission-emails']);
      if (
        !isRecord(admission) ||
        !Array.isArray(admission.emails) ||
        !admission.emails.every((email: unknown): email is string => typeof email === 'string')
      )
        throw new GwsEaError('web_admission_unavailable', 'The host’s current artifact readers could not be observed.');
      if (JSON.stringify(webEmails(admission.emails)) !== JSON.stringify(admitted))
        throw new GwsEaError(
          'web_access_admission_drift',
          'Cloudflare admission does not match the host’s current intended readers.',
        );
      const dns = config.dns[assistant.claim.hostname];
      if (!dns) throw new GwsEaError('web_dns_missing', 'The owned DNS record is missing.');
      assertDns(
        await readOwnedResource(api, `/zones/${dns.zoneId}/dns_records/${dns.id}`),
        assistant.claim.hostname,
        config.tunnelId,
        dns.id,
      );
      const tunnel = await readOwnedResource(api, `${account}/cfd_tunnel/${config.tunnelId}`);
      if (
        !isRecord(tunnel) ||
        typeof tunnel.id !== 'string' ||
        typeof tunnel.config_src !== 'string' ||
        (tunnel.deleted_at !== null && typeof tunnel.deleted_at !== 'string')
      )
        throw new GwsEaError('web_tunnel_unobserved', 'Cloudflare did not return a verifiable tunnel record.');
      if (tunnel.id !== config.tunnelId || tunnel.config_src !== 'cloudflare' || tunnel.deleted_at)
        throw new GwsEaError('web_tunnel_invalid', 'The recorded remotely managed tunnel is unavailable.');
      const configuration = await api.request('GET', `${account}/cfd_tunnel/${config.tunnelId}/configurations`);
      const ingress =
        isRecord(configuration) && isRecord(configuration.config) ? configuration.config.ingress : undefined;
      const expected = webIngress(assistant.claim);
      const origin =
        isRecord(configuration) && isRecord(configuration.config) ? configuration.config.originRequest : undefined;
      const expectedRoutes = Array.isArray(ingress)
        ? ingress.filter(
            (route: unknown) => isRecord(route) && route.hostname === expected.hostname && route.path === expected.path,
          )
        : [];
      if (
        !Array.isArray(ingress) ||
        !ingress.every(isRecord) ||
        ingress.at(-1)?.service !== 'http_status:404' ||
        (isRecord(origin) && isRecord(origin.access) && origin.access.required === true) ||
        (policy.enabled
          ? expectedRoutes.length !== 1 ||
            !isRecord(expectedRoutes[0]) ||
            expectedRoutes[0].service !== expected.service ||
            (isRecord(expectedRoutes[0].originRequest) &&
              isRecord(expectedRoutes[0].originRequest.access) &&
              expectedRoutes[0].originRequest.access.required === true)
          : expectedRoutes.length !== 0)
      )
        throw new GwsEaError('web_tunnel_unverified', 'Web ingress does not match current policy.');
      const connections = await api.request('GET', `${account}/cfd_tunnel/${config.tunnelId}/connections`);
      if (
        policy.enabled &&
        (!Array.isArray(connections) ||
          !connections.some((connection: unknown) => isRecord(connection) && connection.is_pending_reconnect !== true))
      )
        throw new GwsEaError('web_connector_unavailable', 'No active tunnel connection was observed.');
      remote = 'verified';
      const health = await hostHealth(runtime, dependencies);
      listener = policy.enabled && availableHealth(health, assistant.claim.listen_port) ? 'listening' : 'unavailable';
      if (policy.enabled && listener !== 'listening')
        reason = 'The running host listener is not available at its claimed port.';
      else if (policy.enabled && assistant.publicationReady !== true)
        reason =
          'Web activation has not completed. Rerun gws-ea connectors install web to verify and finish activation.';
      // eslint-disable-next-line no-catch-all/no-catch-all -- Optional status never exposes raw API, process or credential failures.
    } catch (cause) {
      reasonCode = cause instanceof GwsEaError ? cause.code : 'web_host_unavailable';
      remote =
        cause instanceof GwsEaError &&
        (cause.details?.status === 404 ||
          [
            'web_owned_resource_missing',
            'web_owner_mismatch',
            'web_zone_invalid',
            'web_pin_missing',
            'web_application_mismatch',
            'web_access_mismatch',
            'web_access_admission_drift',
            'web_dns_missing',
            'web_dns_mismatch',
            'web_tunnel_invalid',
            'web_tunnel_unverified',
          ].includes(cause.code))
          ? 'mismatch'
          : 'unavailable';
      listener = 'unavailable';
      reason =
        cause instanceof GwsEaError
          ? cause.message
          : 'Web prerequisites could not be observed. Check the owner-only configuration and running host.';
    }
  }
  return {
    ...WEB_CAPABILITY,
    instance_id: instanceId,
    observed_at: new Date().toISOString(),
    activation: policy.status === 'unavailable' ? 'unavailable' : policy.enabled ? 'enabled' : 'disabled',
    hostname: coordinates?.hostname ?? claim?.hostname ?? null,
    policy_file: policyFile,
    remote,
    listener,
    ready:
      policy.enabled &&
      remote === 'verified' &&
      listener === 'listening' &&
      config?.assistants[instanceId]?.publicationReady === true,
    reason,
    reason_code: reasonCode,
    operator,
  };
}
