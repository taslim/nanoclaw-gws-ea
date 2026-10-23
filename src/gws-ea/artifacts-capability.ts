import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from '../community-portal/errors.js';
import {
  parseArtifactsPolicyFile,
  readArtifactsPolicy,
  type ArtifactsPolicyFile,
} from '../modules/gws-ea-artifacts/policy.js';
import { withAssistantLock } from './browser-capability.js';
import {
  artifactsAccessApplication,
  artifactsApi,
  artifactsEmailPolicy,
  artifactsEmails,
  artifactsIngress,
  artifactsOperatorFiles,
  artifactsPathPrefix,
  assertArtifactsApplication,
  cloudflareId,
  parseArtifactsOperatorConfig,
  readArtifactsOperatorConfig,
  reconcileArtifactsAccessEmails,
  verifiedPolicyEmails,
  writeArtifactsOperatorConfig,
  type ArtifactsCloudflareApi,
  type ArtifactsCloudflareDependencies,
  type ArtifactsOperatorConfig,
  type ArtifactsRemoteAssistant,
} from './artifacts-cloudflare.js';
import { runInstanceNclJson } from './ncl.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import {
  buildToolEnvironment,
  resolvePersistedExecutable,
  runSanitizedCommandOutcome,
  type SanitizedCommandOutcomeRunner,
} from './process.js';
import { registerSecret } from './redact.js';
import { claimInstanceArtifacts, getInstanceReservation, withMachineLock } from './registry.js';
import { readOperatorFile, readOwnerOnlyFile, writePrivateTextFile } from './secrets.js';
import { loadInstanceRuntimeConfig, serviceManagerEnvironment, type InstanceRuntimeConfig } from './service.js';
import { renderLaunchdService, renderSystemdService } from './service-definition.js';
import { GwsEaError, type ArtifactsNamespaceClaim } from './types.js';
import { isRecord } from './validation.js';

export const ARTIFACTS_CAPABILITY = {
  name: 'artifacts',
  actions: ['show', 'check', 'enable', 'disable'],
  scope: 'assistant',
  summary: 'Serve private HTML views and explicitly shared revisions through Cloudflare Access.',
} as const;
export interface ArtifactsCapabilityOptions {
  readonly accountId?: string;
  readonly teamName?: string;
  readonly zoneId?: string;
  readonly hostname?: string;
  readonly credentialFile?: string;
  readonly assistantHostname?: string;
  readonly cloudflaredPath?: string;
  readonly discardUnproven?: string;
}
export interface ArtifactsCapabilityDependencies extends ArtifactsCloudflareDependencies {
  readonly ncl?: typeof runInstanceNclJson;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  readonly recordEffect?: (changed: true | null) => void | Promise<unknown>;
}
export interface ArtifactsCapabilityObservation {
  readonly name: 'artifacts';
  readonly scope: 'assistant';
  readonly actions: typeof ARTIFACTS_CAPABILITY.actions;
  readonly summary: string;
  readonly instance_id: string;
  readonly observed_at: string;
  readonly activation: 'enabled' | 'disabled' | 'unavailable';
  readonly hostname: string | null;
  readonly path_prefix: string | null;
  readonly policy_file: string;
  readonly remote: 'not_checked' | 'verified' | 'unavailable';
  readonly listener: 'not_checked' | 'listening' | 'unavailable';
  readonly ready: boolean;
  readonly reason: string | null;
  readonly operator: {
    readonly status: 'configured' | 'missing' | 'unavailable';
    readonly account_id: string | null;
    readonly team_name: string | null;
    readonly zone_id: string | null;
    readonly hostname: string | null;
    readonly pending: { readonly kind: string; readonly attempt: string; readonly started_at: string } | null;
  };
}
export interface ArtifactsOperationData {
  readonly name: 'artifacts';
  readonly scope: 'assistant';
  readonly actions: typeof ARTIFACTS_CAPABILITY.actions;
  readonly summary: string;
  readonly instance_id: string;
  readonly enabled: boolean;
  readonly changed: boolean;
  readonly hostname: string | null;
  readonly path_prefix: string | null;
}
export function instanceArtifactsPolicyFile(runtime: Pick<InstanceRuntimeConfig, 'instance_root'>): string {
  return path.join(runtime.instance_root, 'artifacts', 'policy.json');
}
async function target(paths: ControlPlanePaths, instanceId: string) {
  const reservation = await getInstanceReservation(paths, instanceId);
  const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId));
  return { reservation, runtime, policyFile: instanceArtifactsPolicyFile(runtime) };
}
async function writePolicy(file: string, policy: ArtifactsPolicyFile): Promise<void> {
  if (!parseArtifactsPolicyFile(policy))
    throw new GwsEaError('artifacts_policy_invalid', 'Artifact policy coordinates are invalid.');
  await preparePrivateDirectory(path.dirname(file));
  await writePrivateTextFile(file, `${JSON.stringify(policy)}\n`);
}
function operation(
  instanceId: string,
  claim: ArtifactsNamespaceClaim | undefined,
  enabled: boolean,
  changed: boolean,
): ArtifactsOperationData {
  return {
    ...ARTIFACTS_CAPABILITY,
    instance_id: instanceId,
    enabled,
    changed,
    hostname: claim?.hostname ?? null,
    path_prefix: claim?.path_prefix ?? null,
  };
}

async function configure(
  paths: ControlPlanePaths,
  options: ArtifactsCapabilityOptions,
): Promise<ArtifactsOperatorConfig> {
  const files = artifactsOperatorFiles(paths);
  return withMachineLock(paths, async () => {
    await preparePrivateDirectory(files.root);
    let existing = await readArtifactsOperatorConfig(files.configFile);
    if (existing) {
      if (options.discardUnproven) {
        if (!existing.pending || existing.pending.key !== options.discardUnproven)
          throw new GwsEaError(
            'artifacts_attempt_mismatch',
            'Only the exact unresolved attempt may be acknowledged after its possible remote resource was removed.',
          );
        if ((existing.resolvedAttempts?.length ?? 0) >= 64)
          throw new GwsEaError(
            'artifacts_attempt_capacity',
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
        await writeArtifactsOperatorConfig(files.configFile, existing);
      }
      for (const key of ['accountId', 'teamName', 'zoneId', 'hostname', 'cloudflaredPath'] as const)
        if (options[key] !== undefined && options[key] !== existing[key])
          throw new GwsEaError(
            'artifacts_operator_conflict',
            'The operator account, team, zone, hostname and connector retain their recorded coordinates.',
          );
      if (options.credentialFile) {
        const token = (
          await readOperatorFile(
            options.credentialFile,
            paths.configRoot,
            'Cloudflare management credential',
            'artifacts_credential_invalid',
          )
        ).trim();
        registerSecret(token);
        await writePrivateTextFile(existing.credentialFile, token);
      }
      return existing;
    }
    if (!options.accountId || !options.teamName || !options.zoneId || !options.hostname || !options.credentialFile)
      throw new GwsEaError(
        'artifacts_operator_required',
        'First enable requires --account, --team, --zone, --hostname and --credential-file under the operator config root.',
      );
    const credentialFile = path.join(files.root, 'management-token');
    const config = parseArtifactsOperatorConfig({
      schemaVersion: 1,
      accountId: options.accountId,
      teamName: options.teamName,
      zoneId: options.zoneId,
      hostname: options.hostname,
      credentialFile,
      cloudflaredPath: await resolvePersistedExecutable(options.cloudflaredPath ?? 'cloudflared'),
      dns: {},
      assistants: {},
    });
    const token = (
      await readOperatorFile(
        options.credentialFile,
        paths.configRoot,
        'Cloudflare management credential',
        'artifacts_credential_invalid',
      )
    ).trim();
    registerSecret(token);
    await writePrivateTextFile(credentialFile, token);
    await writeArtifactsOperatorConfig(files.configFile, config);
    return config;
  });
}

async function claimNamespace(
  paths: ControlPlanePaths,
  instanceId: string,
  hostname: string,
  prefix: string,
): Promise<ArtifactsNamespaceClaim> {
  const previous = (await getInstanceReservation(paths, instanceId)).exclusive_resource_claims.artifacts;
  if (previous) {
    if (previous.hostname !== hostname)
      throw new GwsEaError('claim_conflict', 'Existing artifact links retain their claimed hostname.');
    return previous;
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback listener');
    const claim = { hostname, path_prefix: prefix, listen_port: address.port };
    await claimInstanceArtifacts(paths, instanceId, claim);
    return claim;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function verifyZone(
  api: ArtifactsCloudflareApi,
  config: ArtifactsOperatorConfig,
  hostname: string,
): Promise<string> {
  const configured = await api.request('GET', `/zones/${config.zoneId}`);
  const suitable = (zone: unknown): zone is Record<string, unknown> =>
    isRecord(zone) &&
    zone.status === 'active' &&
    isRecord(zone.account) &&
    zone.account.id === config.accountId &&
    typeof zone.name === 'string' &&
    (hostname === zone.name || hostname.endsWith(`.${zone.name}`));
  if (suitable(configured)) return cloudflareId(configured);
  if (hostname === config.hostname)
    throw new GwsEaError(
      'artifacts_zone_invalid',
      'The default hostname must belong to the configured active zone and account.',
    );
  const zones = (await api.list(`/zones?account.id=${config.accountId}&status=active`))
    .filter(suitable)
    .sort((a, b) => String(b.name).length - String(a.name).length);
  if (!zones.length)
    throw new GwsEaError(
      'artifacts_zone_invalid',
      'The assistant hostname has no active zone in the configured account.',
    );
  return cloudflareId(zones[0]);
}
function assertNoAccessOverlap(
  apps: readonly Record<string, unknown>[],
  claim: ArtifactsNamespaceClaim,
  ownedId?: string,
): void {
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
      if (typeof uri !== 'string') continue;
      const slash = uri.indexOf('/');
      const host = (slash < 0 ? uri : uri.slice(0, slash)).toLowerCase();
      const prefix = slash < 0 ? '' : uri.slice(slash).replace(/\/*\*?$/u, '');
      const sameHost =
        host === claim.hostname || (host.startsWith('*.') && claim.hostname.endsWith(host.slice(1))) || host === '*';
      if (!sameHost) continue;
      if (
        prefix.includes('*') ||
        prefix === '' ||
        claim.path_prefix === '' ||
        prefix === claim.path_prefix ||
        prefix.startsWith(`${claim.path_prefix}/`) ||
        claim.path_prefix.startsWith(`${prefix}/`)
      )
        throw new GwsEaError(
          'artifacts_access_conflict',
          'An existing Access destination overlaps this assistant namespace. No existing resource was adopted or overwritten.',
        );
    }
  }
}

/** Must run under the machine lock: remote PUT replaces the complete tunnel configuration. */
export async function setArtifactsIngress(
  api: ArtifactsCloudflareApi,
  config: ArtifactsOperatorConfig,
  claim: ArtifactsNamespaceClaim,
  enabled: boolean,
): Promise<void> {
  if (!config.tunnelId) return;
  const resource = `/accounts/${config.accountId}/cfd_tunnel/${config.tunnelId}/configurations`;
  const remote = await api.request('GET', resource);
  if (!isRecord(remote) || (remote.config !== undefined && remote.config !== null && !isRecord(remote.config)))
    throw new GwsEaError('artifacts_tunnel_invalid', 'Cloudflare tunnel configuration is invalid.');
  const current = isRecord(remote.config) ? remote.config : {};
  if (
    isRecord(current.originRequest) &&
    isRecord(current.originRequest.access) &&
    current.originRequest.access.required === true
  )
    throw new GwsEaError(
      'artifacts_tunnel_conflict',
      'Global tunnel Access enforcement would block the explicitly public namespace.',
    );
  const ingress = current.ingress === undefined ? [] : current.ingress;
  if (!Array.isArray(ingress) || !ingress.every(isRecord))
    throw new GwsEaError('artifacts_tunnel_invalid', 'Cloudflare tunnel ingress is invalid.');
  const expected = artifactsIngress(claim);
  const retained: Record<string, unknown>[] = [];
  for (const route of ingress) {
    if (route.hostname === claim.hostname && route.path === expected.path) {
      if (route.service !== expected.service)
        throw new GwsEaError('artifacts_tunnel_conflict', 'The claimed tunnel route points to an unowned service.');
      continue;
    }
    if (route.hostname === undefined && route.path === undefined) {
      if (route.service !== 'http_status:404')
        throw new GwsEaError('artifacts_tunnel_conflict', 'The tunnel has an unowned catch-all service.');
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
        const owned = artifactsIngress(assistant.claim);
        return owned.hostname === route.hostname && owned.path === route.path && owned.service === route.service;
      })
    )
      throw new GwsEaError('artifacts_tunnel_conflict', 'An unowned tunnel route overlaps this assistant hostname.');
    retained.push(route);
  }
  const next = { ...current, ingress: [...retained, ...(enabled ? [expected] : []), { service: 'http_status:404' }] };
  if (JSON.stringify(current) !== JSON.stringify(next)) await api.request('PUT', resource, { config: next });
  const verified = await api.request('GET', resource);
  if (!isRecord(verified) || !isRecord(verified.config) || JSON.stringify(verified.config) !== JSON.stringify(next))
    throw new GwsEaError('artifacts_tunnel_unverified', 'Cloudflare tunnel ingress has not converged.');
}

async function provision(
  paths: ControlPlanePaths,
  instanceId: string,
  claim: ArtifactsNamespaceClaim,
  emails: readonly string[],
  dependencies: ArtifactsCapabilityDependencies,
): Promise<ArtifactsOperatorConfig> {
  const file = artifactsOperatorFiles(paths).configFile;
  return withMachineLock(paths, async () => {
    const loaded = await readArtifactsOperatorConfig(file);
    if (!loaded) throw new GwsEaError('artifacts_operator_required', 'Artifacts operator configuration is missing.');
    let config: ArtifactsOperatorConfig = loaded;
    if (config.pending)
      throw new GwsEaError(
        'artifacts_create_unproven',
        'An interrupted Cloudflare create is unresolved. Inspect the recorded attempt and resolve its exact remote outcome before retrying; resources are never adopted by name.',
        { details: { resource: config.pending.kind, attempt: config.pending.key } },
      );
    const api = await artifactsApi(config, dependencies);
    const account = `/accounts/${config.accountId}`;
    const zoneId = await verifyZone(api, config, claim.hostname);
    const organization = await api.request('GET', `${account}/access/organizations`);
    if (!isRecord(organization) || organization.auth_domain !== `${config.teamName}.cloudflareaccess.com`)
      throw new GwsEaError('artifacts_team_invalid', 'The configured Access team does not belong to this account.');
    const save = async (next: ArtifactsOperatorConfig): Promise<void> => {
      await writeArtifactsOperatorConfig(file, next);
      config = next;
    };
    const create = async (
      kind: NonNullable<ArtifactsOperatorConfig['pending']>['kind'],
      key: string,
      resource: string,
      body: unknown,
      recorded: (id: string) => ArtifactsOperatorConfig,
    ): Promise<void> => {
      if (!config) throw new Error('Missing operator configuration');
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
        throw new GwsEaError('artifacts_pin_missing', 'The recorded one-time-PIN identity provider is missing.');
    } else {
      const pin = idps.find((idp) => idp.type === 'onetimepin');
      if (pin) await save({ ...config, pin: { id: cloudflareId(pin), owned: false } });
      else
        await create(
          'pin',
          randomUUID(),
          `${account}/access/identity_providers`,
          { name: 'Artifact email PIN', type: 'onetimepin', config: {} },
          (id) => ({ ...config!, pin: { id, owned: true } }),
        );
    }
    let assistant: ArtifactsRemoteAssistant = config.assistants[instanceId] ?? { claim, enabled: false };
    if (JSON.stringify(assistant.claim) !== JSON.stringify(claim))
      throw new GwsEaError(
        'artifacts_owner_mismatch',
        'Recorded artifact namespace does not match the assistant claim.',
      );
    const apps = await api.list(`${account}/access/apps`);
    assertNoAccessOverlap(apps, claim, assistant.applicationId);
    if (!assistant.applicationId) {
      if (apps.length >= 500)
        throw new GwsEaError(
          'artifacts_cloudflare_capacity',
          'The Cloudflare account has reached its Access application limit.',
        );
      await create(
        'application',
        instanceId,
        `${account}/access/apps`,
        artifactsAccessApplication(claim, config.pin!.id),
        (id) => ({
          ...config!,
          assistants: { ...config!.assistants, [instanceId]: { ...assistant, applicationId: id } },
        }),
      );
      assistant = config.assistants[instanceId];
    }
    const appPath = `${account}/access/apps/${assistant.applicationId}`;
    const app = await api.request('GET', appPath);
    if (!isRecord(app) || typeof app.aud !== 'string')
      throw new GwsEaError('artifacts_access_unverified', 'Cloudflare did not return the application audience.');
    if (!assistant.aud) {
      assistant = { ...assistant, aud: app.aud };
      await save({ ...config, assistants: { ...config.assistants, [instanceId]: assistant } });
    }
    assertArtifactsApplication(app, assistant, config);
    const policies = await api.list(`${appPath}/policies`);
    if (!assistant.policyId) {
      if (policies.length)
        throw new GwsEaError(
          'artifacts_access_conflict',
          'The owned application has an unrecorded policy. It was left unchanged.',
        );
      await create('policy', instanceId, `${appPath}/policies`, artifactsEmailPolicy(emails), (id) => ({
        ...config!,
        assistants: { ...config!.assistants, [instanceId]: { ...assistant, policyId: id } },
      }));
      assistant = config.assistants[instanceId];
    } else if (policies.length !== 1 || policies[0].id !== assistant.policyId)
      throw new GwsEaError('artifacts_access_conflict', 'The owned application has unexpected policies.');
    if (!config.tunnelId)
      await create(
        'tunnel',
        randomUUID(),
        `${account}/cfd_tunnel`,
        { name: `gws-ea-artifacts-${randomUUID()}`, config_src: 'cloudflare' },
        (id) => ({ ...config!, tunnelId: id }),
      );
    const tunnel = await api.request('GET', `${account}/cfd_tunnel/${config.tunnelId}`);
    if (!isRecord(tunnel) || tunnel.id !== config.tunnelId || tunnel.config_src !== 'cloudflare' || tunnel.deleted_at)
      throw new GwsEaError('artifacts_tunnel_invalid', 'The recorded remotely managed tunnel is unavailable.');
    const dns = config.dns[claim.hostname];
    if (!dns) {
      const existing = await api.list(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(claim.hostname)}`);
      if (existing.length)
        throw new GwsEaError(
          'artifacts_dns_conflict',
          'The hostname already has DNS records that this operator does not own.',
        );
      await create(
        'dns',
        claim.hostname,
        `/zones/${zoneId}/dns_records`,
        { type: 'CNAME', name: claim.hostname, content: `${config.tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 },
        (id) => ({ ...config!, dns: { ...config!.dns, [claim.hostname]: { id, zoneId } } }),
      );
    }
    const ownedDns = config.dns[claim.hostname];
    const record = await api.request('GET', `/zones/${ownedDns.zoneId}/dns_records/${ownedDns.id}`);
    assertDns(record, claim.hostname, config.tunnelId!, ownedDns.id);
    const token = await api.request('GET', `${account}/cfd_tunnel/${config.tunnelId}/token`);
    if (typeof token !== 'string' || !token || /\s/u.test(token))
      throw new GwsEaError('artifacts_tunnel_invalid', 'Cloudflare tunnel run token is unavailable.');
    registerSecret(token);
    await writePrivateTextFile(artifactsOperatorFiles(paths).tokenFile, token);
    assistant = { ...assistant, enabled: true };
    await save({ ...config, assistants: { ...config.assistants, [instanceId]: assistant } });
    return config;
  });
}

function assertDns(record: unknown, hostname: string, tunnelId: string, expectedId: string): void {
  if (
    !isRecord(record) ||
    record.id !== expectedId ||
    record.type !== 'CNAME' ||
    record.name !== hostname ||
    record.content !== `${tunnelId}.cfargotunnel.com` ||
    record.proxied !== true
  )
    throw new GwsEaError('artifacts_dns_mismatch', 'The owned DNS record no longer points at the recorded tunnel.');
}

async function verifyConnectorExecutable(
  config: ArtifactsOperatorConfig,
  runtime: InstanceRuntimeConfig,
  dependencies: ArtifactsCapabilityDependencies,
): Promise<void> {
  const result = await (dependencies.runCommand ?? runSanitizedCommandOutcome)({
    command: config.cloudflaredPath,
    args: ['--version'],
    cwd: runtime.instance_root,
    env: buildToolEnvironment({}, { HOME: runtime.home_directory }),
    timeoutMs: 5000,
    outputLimitBytes: 4096,
  });
  const match = /^cloudflared version (\d{4})\.(\d+)\.(\d+)\b/u.exec(result.stdout.trim());
  if (result.exitCode !== 0 || !match || Number(match[1]) < 2025 || (Number(match[1]) === 2025 && Number(match[2]) < 4))
    throw new GwsEaError(
      'artifacts_connector_unsupported',
      'cloudflared 2025.4.0 or later is required for the owner-only run-token file.',
    );
}

async function startConnector(
  paths: ControlPlanePaths,
  runtime: InstanceRuntimeConfig,
  dependencies: ArtifactsCapabilityDependencies,
): Promise<void> {
  await withMachineLock(paths, async () => {
    const files = artifactsOperatorFiles(paths);
    const loaded = await readArtifactsOperatorConfig(files.configFile);
    if (!loaded?.tunnelId) throw new GwsEaError('artifacts_tunnel_invalid', 'The tunnel has not been provisioned.');
    let config: ArtifactsOperatorConfig = loaded;
    const uid = process.getuid?.();
    if (uid === undefined || !['darwin', 'linux'].includes(process.platform))
      throw new GwsEaError('unsupported_platform', 'Artifacts connector service needs macOS or Linux.');
    const label = `com.gws-ea.artifacts.${createHash('sha256').update(paths.configRoot).digest('hex').slice(0, 16)}`;
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
      throw new GwsEaError('artifacts_connector_conflict', 'The shared connector service coordinates changed.');
    const input = {
      programArguments: [config.cloudflaredPath, 'tunnel', '--no-autoupdate', 'run', '--token-file', files.tokenFile],
      workingDirectory: files.root,
      environment: { HOME: runtime.home_directory, PATH: '/usr/local/bin:/usr/bin:/bin' },
      standardOutputPath: path.join(files.root, 'connector.log'),
      standardErrorPath: path.join(files.root, 'connector.error.log'),
    };
    const definition =
      manager === 'launchd'
        ? renderLaunchdService({ ...input, label })
        : renderSystemdService({
            ...input,
            wantedBy: manager === 'systemd-system' ? 'multi-user.target' : 'default.target',
          });
    const stored = await readOwnerOnlyFile(definitionFile).catch((cause: unknown) => {
      if (isErrno(cause, 'ENOENT')) return undefined;
      throw cause;
    });
    if (!config.connector && stored !== undefined)
      throw new GwsEaError(
        'artifacts_connector_conflict',
        'An unowned service definition already exists at the connector path.',
      );
    if (stored !== undefined && stored !== definition)
      throw new GwsEaError(
        'artifacts_connector_conflict',
        'The owned connector service definition was changed outside this capability.',
      );
    if (!config.connector) {
      config = { ...config, connector };
      await writeArtifactsOperatorConfig(files.configFile, config);
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
        throw new GwsEaError('artifacts_connector_failed', 'The owned cloudflared launchd service could not start.');
    } else {
      const args = manager === 'systemd-user' ? ['--user'] : [];
      if (
        (await invoke('systemctl', [...args, 'daemon-reload'])).exitCode !== 0 ||
        (await invoke('systemctl', [...args, 'enable', '--now', `${label}.service`])).exitCode !== 0
      )
        throw new GwsEaError('artifacts_connector_failed', 'The owned cloudflared systemd service could not start.');
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
  dependencies: ArtifactsCapabilityDependencies,
  timeoutMs?: number,
): Promise<unknown> {
  return (dependencies.ncl ?? runInstanceNclJson)(runtime, ['gws-ea-artifacts-health'], { timeoutMs });
}

export async function enableArtifactsCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  options: ArtifactsCapabilityOptions = {},
  dependencies: ArtifactsCapabilityDependencies = {},
): Promise<ArtifactsOperationData> {
  return withAssistantLock(paths, instanceId, async () => {
    const { runtime, policyFile, reservation } = await target(paths, instanceId);
    const ncl = dependencies.ncl ?? runInstanceNclJson;
    const profile = await ncl(runtime, ['gws-ea-profile-get']);
    if (
      !isRecord(profile) ||
      typeof profile.assistant_first_name !== 'string' ||
      !Array.isArray(profile.principal_emails) ||
      !profile.principal_emails.every((email): email is string => typeof email === 'string') ||
      !profile.principal_emails.length
    )
      throw new GwsEaError(
        'artifacts_profile_unavailable',
        'Artifacts require the assistant first name and all confirmed principal email addresses from the running host.',
      );
    const principalEmails = artifactsEmails(profile.principal_emails);
    const health = await hostHealth(runtime, dependencies);
    if (!isRecord(health) || !Array.isArray(health.policyVersions) || !health.policyVersions.includes(1))
      throw new GwsEaError(
        'artifacts_release_unsupported',
        'Update and start the assistant before enabling artifacts.',
      );
    await dependencies.recordEffect?.(null);
    const config = await configure(paths, options);
    await verifyConnectorExecutable(config, runtime, dependencies);
    const retained = reservation.exclusive_resource_claims.artifacts;
    const hostname = options.assistantHostname ?? retained?.hostname ?? config.hostname;
    const prefix =
      retained?.path_prefix ?? (options.assistantHostname ? '' : artifactsPathPrefix(profile.assistant_first_name));
    const claim = await claimNamespace(paths, instanceId, hostname, prefix);
    await dependencies.recordEffect?.(true);
    const currentEmails = async (): Promise<readonly string[]> => {
      const current = await ncl(runtime, ['gws-ea-artifacts-admission-emails']);
      if (
        !isRecord(current) ||
        !Array.isArray(current.emails) ||
        !current.emails.every((email): email is string => typeof email === 'string')
      )
        throw new GwsEaError(
          'artifacts_profile_unavailable',
          'The host could not read authoritative artifact admission.',
        );
      const exact = artifactsEmails(current.emails);
      if (!principalEmails.every((email) => exact.includes(email)))
        throw new GwsEaError(
          'artifacts_profile_changed',
          'Principal addresses changed during enable. Retry with the current profile.',
        );
      return exact;
    };
    const previousPolicy = await readArtifactsPolicy(policyFile);
    if (previousPolicy.status === 'unavailable')
      throw new GwsEaError('artifacts_policy_invalid', 'Artifacts policy is invalid or inaccessible.');
    let enabledPolicy: ArtifactsPolicyFile | undefined = previousPolicy.config;
    try {
      if (enabledPolicy?.enabled) await writePolicy(policyFile, { ...enabledPolicy, enabled: false });
      const provisioned = await provision(paths, instanceId, claim, await currentEmails(), dependencies);
      const assistant = provisioned.assistants[instanceId];
      await reconcileArtifactsAccessEmails(
        {
          operatorConfigFile: artifactsOperatorFiles(paths).configFile,
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
        pathPrefix: claim.path_prefix,
        listenPort: claim.listen_port,
        accessIssuer: `https://${provisioned.teamName}.cloudflareaccess.com`,
        accessAud: assistant.aud!,
        cloudflare: {
          accountId: provisioned.accountId,
          applicationId: assistant.applicationId!,
          operatorConfigFile: artifactsOperatorFiles(paths).configFile,
        },
      };
      await writePolicy(policyFile, { ...enabledPolicy, enabled: false });
      await writePolicy(policyFile, enabledPolicy);
      let listening = false;
      const readinessDeadline = Date.now() + 30_000;
      // The module recovers and binds asynchronously. Poll local readiness outside the machine lock,
      // before ingress or connector availability can be a prerequisite for this listener.
      while (Date.now() < readinessDeadline) {
        if (
          availableHealth(
            await hostHealth(runtime, dependencies, Math.min(5000, readinessDeadline - Date.now())),
            claim.listen_port,
          ) &&
          Date.now() <= readinessDeadline
        ) {
          listening = true;
          break;
        }
        const remaining = readinessDeadline - Date.now();
        if (remaining > 0) await (dependencies.sleep ?? delay)(Math.min(500, remaining));
      }
      if (!listening)
        throw new GwsEaError(
          'artifacts_listener_unavailable',
          'The running assistant has not verified its artifact listener. Artifact ingress remains closed.',
        );
      await withMachineLock(paths, async () => {
        const live = await readArtifactsOperatorConfig(artifactsOperatorFiles(paths).configFile);
        if (!live?.assistants[instanceId]?.enabled)
          throw new GwsEaError('artifacts_disabled', 'Artifacts were disabled while enabling.');
        await setArtifactsIngress(await artifactsApi(live, dependencies), live, claim, true);
      });
      await startConnector(paths, runtime, dependencies);
      const observed = await inspectArtifactsCapability(paths, instanceId, { ...dependencies, check: true });
      if (!observed.ready)
        throw new GwsEaError(
          'artifacts_not_ready',
          'Artifact prerequisites have not all been verified. Check this capability after resolving the reported prerequisite.',
        );
      return operation(instanceId, claim, true, true);
    } catch (cause) {
      if (enabledPolicy) await writePolicy(policyFile, { ...enabledPolicy, enabled: false });
      /* eslint-disable no-catch-all/no-catch-all -- Origin is already closed; retain the original failure when remote cleanup is also unavailable. */
      try {
        await withMachineLock(paths, async () => {
          const file = artifactsOperatorFiles(paths).configFile;
          const live = await readArtifactsOperatorConfig(file);
          const assistant = live?.assistants[instanceId];
          if (live && assistant) {
            await writeArtifactsOperatorConfig(file, {
              ...live,
              assistants: { ...live.assistants, [instanceId]: { ...live.assistants[instanceId], enabled: false } },
            });
            if (live.tunnelId)
              await setArtifactsIngress(await artifactsApi(live, dependencies), live, assistant.claim, false);
          }
        });
      } catch (_cleanupCause) {
        /* The disabled policy is authoritative; check observes pending ingress cleanup. */
      }
      /* eslint-enable no-catch-all/no-catch-all */
      throw cause;
    }
  });
}

export async function disableArtifactsCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: ArtifactsCapabilityDependencies = {},
): Promise<ArtifactsOperationData> {
  return withAssistantLock(paths, instanceId, async () => {
    const { policyFile, reservation } = await target(paths, instanceId);
    const policy = await readArtifactsPolicy(policyFile);
    if (policy.status === 'unavailable')
      throw new GwsEaError(
        'artifacts_policy_invalid',
        'Invalid artifacts policy already fails closed. Restore its owner-only coordinates before cleanup.',
      );
    let changed = false;
    if (policy.config?.enabled) {
      await dependencies.recordEffect?.(null);
      await writePolicy(policyFile, { ...policy.config, enabled: false });
      changed = true;
      await dependencies.recordEffect?.(true);
    }
    await withMachineLock(paths, async () => {
      const file = artifactsOperatorFiles(paths).configFile;
      const config = await readArtifactsOperatorConfig(file);
      const assistant = config?.assistants[instanceId];
      if (!config || !assistant) return;
      if (assistant.enabled) {
        await dependencies.recordEffect?.(null);
        await writeArtifactsOperatorConfig(file, {
          ...config,
          assistants: { ...config.assistants, [instanceId]: { ...assistant, enabled: false } },
        });
        changed = true;
        await dependencies.recordEffect?.(true);
      }
      await setArtifactsIngress(await artifactsApi(config, dependencies), config, assistant.claim, false);
    });
    return operation(instanceId, reservation.exclusive_resource_claims.artifacts, false, changed);
  });
}

/** Read-only, bounded observation. Does not create, replace, reconcile, start or repair anything. */
export async function inspectArtifactsCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: ArtifactsCapabilityDependencies & { readonly check?: boolean } = {},
): Promise<ArtifactsCapabilityObservation> {
  const { runtime, policyFile, reservation } = await target(paths, instanceId);
  const policy = await readArtifactsPolicy(policyFile);
  const coordinates = policy.status === 'unavailable' ? undefined : policy.config;
  const claim = reservation.exclusive_resource_claims.artifacts;
  let remote: ArtifactsCapabilityObservation['remote'] = 'not_checked';
  let listener: ArtifactsCapabilityObservation['listener'] = 'not_checked';
  let reason: string | null = policy.status === 'unavailable' ? 'Artifacts policy is invalid or inaccessible.' : null;
  let config: ArtifactsOperatorConfig | undefined;
  let operator: ArtifactsCapabilityObservation['operator'] = {
    status: 'missing',
    account_id: null,
    team_name: null,
    zone_id: null,
    hostname: null,
    pending: null,
  };
  try {
    config = await readArtifactsOperatorConfig(artifactsOperatorFiles(paths).configFile);
    if (config)
      operator = {
        status: 'configured',
        account_id: config.accountId,
        team_name: config.teamName,
        zone_id: config.zoneId,
        hostname: config.hostname,
        pending: config.pending
          ? { kind: config.pending.kind, attempt: config.pending.key, started_at: config.pending.startedAt }
          : null,
      };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Read-only optional configuration failure remains observable without exposing file contents.
  } catch (_cause) {
    operator = { ...operator, status: 'unavailable' };
    reason = 'Artifacts operator configuration is invalid or inaccessible.';
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
        throw new GwsEaError('artifacts_not_provisioned', 'Artifacts have incomplete or unresolved provisioning.');
      if (
        coordinates.hostname !== assistant.claim.hostname ||
        coordinates.pathPrefix !== assistant.claim.path_prefix ||
        coordinates.listenPort !== assistant.claim.listen_port ||
        coordinates.accessAud !== assistant.aud ||
        coordinates.accessIssuer !== `https://${config.teamName}.cloudflareaccess.com` ||
        coordinates.cloudflare.accountId !== config.accountId ||
        coordinates.cloudflare.applicationId !== assistant.applicationId ||
        coordinates.cloudflare.operatorConfigFile !== artifactsOperatorFiles(paths).configFile ||
        policy.enabled !== assistant.enabled
      )
        throw new GwsEaError(
          'artifacts_owner_mismatch',
          'Artifact policy does not match current owned resources and enabled intent.',
        );
      const api = await artifactsApi(config, dependencies);
      await verifyZone(api, config, assistant.claim.hostname);
      const account = `/accounts/${config.accountId}`;
      const idp = await api.request('GET', `${account}/access/identity_providers/${config.pin.id}`);
      if (!isRecord(idp) || idp.type !== 'onetimepin')
        throw new GwsEaError('artifacts_pin_missing', 'The recorded PIN provider is missing.');
      assertArtifactsApplication(
        await api.request('GET', `${account}/access/apps/${assistant.applicationId}`),
        assistant,
        config,
      );
      const policies = await api.list(`${account}/access/apps/${assistant.applicationId}/policies`);
      if (policies.length !== 1 || policies[0].id !== assistant.policyId)
        throw new GwsEaError('artifacts_access_mismatch', 'Unexpected Access policies exist.');
      const admitted = verifiedPolicyEmails(policies[0]);
      const admission = await (dependencies.ncl ?? runInstanceNclJson)(runtime, ['gws-ea-artifacts-admission-emails']);
      if (
        !isRecord(admission) ||
        !Array.isArray(admission.emails) ||
        !admission.emails.every((email): email is string => typeof email === 'string') ||
        JSON.stringify(artifactsEmails(admission.emails)) !== JSON.stringify(admitted)
      )
        throw new GwsEaError(
          'artifacts_access_unverified',
          'Cloudflare admission does not match the host’s current intended readers.',
        );
      const dns = config.dns[assistant.claim.hostname];
      if (!dns) throw new GwsEaError('artifacts_dns_missing', 'The owned DNS record is missing.');
      assertDns(
        await api.request('GET', `/zones/${dns.zoneId}/dns_records/${dns.id}`),
        assistant.claim.hostname,
        config.tunnelId,
        dns.id,
      );
      const tunnel = await api.request('GET', `${account}/cfd_tunnel/${config.tunnelId}`);
      if (!isRecord(tunnel) || tunnel.id !== config.tunnelId || tunnel.config_src !== 'cloudflare' || tunnel.deleted_at)
        throw new GwsEaError('artifacts_tunnel_invalid', 'The recorded remotely managed tunnel is unavailable.');
      const configuration = await api.request('GET', `${account}/cfd_tunnel/${config.tunnelId}/configurations`);
      const ingress =
        isRecord(configuration) && isRecord(configuration.config) ? configuration.config.ingress : undefined;
      const expected = artifactsIngress(assistant.claim);
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
        throw new GwsEaError('artifacts_tunnel_unverified', 'Artifact ingress does not match current policy.');
      const connections = await api.request('GET', `${account}/cfd_tunnel/${config.tunnelId}/connections`);
      if (
        policy.enabled &&
        (!Array.isArray(connections) ||
          !connections.some((connection) => isRecord(connection) && connection.is_pending_reconnect !== true))
      )
        throw new GwsEaError('artifacts_connector_unavailable', 'No active tunnel connection was observed.');
      remote = 'verified';
      const health = await hostHealth(runtime, dependencies);
      listener = policy.enabled && availableHealth(health, assistant.claim.listen_port) ? 'listening' : 'unavailable';
      if (policy.enabled && listener !== 'listening')
        reason = 'The running host listener is not available at its claimed port.';
      // eslint-disable-next-line no-catch-all/no-catch-all -- Optional status never exposes raw API, process or credential failures.
    } catch (cause) {
      remote = 'unavailable';
      listener = 'unavailable';
      reason =
        cause instanceof GwsEaError
          ? cause.message
          : 'Artifact prerequisites could not be observed. Check the owner-only configuration and running host.';
    }
  }
  return {
    ...ARTIFACTS_CAPABILITY,
    instance_id: instanceId,
    observed_at: new Date().toISOString(),
    activation: policy.status === 'unavailable' ? 'unavailable' : policy.enabled ? 'enabled' : 'disabled',
    hostname: coordinates?.hostname ?? claim?.hostname ?? null,
    path_prefix: coordinates?.pathPrefix ?? claim?.path_prefix ?? null,
    policy_file: policyFile,
    remote,
    listener,
    ready: policy.enabled && remote === 'verified' && listener === 'listening',
    reason,
    operator,
  };
}
