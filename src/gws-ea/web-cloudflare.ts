import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from '../community-portal/errors.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { registerSecret } from './redact.js';
import { withMachineLock } from './registry.js';
import { readOperatorFile, readOwnerOnlyJson, writePrivateTextFile } from './secrets.js';
import { GwsEaError, type WebNamespaceClaim } from './types.js';
import { hasControlCharacters, INSTANCE_ID_PATTERN, isRecord, normalizePrincipalEmail } from './validation.js';

const ID = /^[a-zA-Z0-9_-]{1,256}$/u;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export function webIngress(claim: WebNamespaceClaim): { readonly hostname: string; readonly service: string } {
  return { hostname: claim.hostname, service: `http://127.0.0.1:${claim.listen_port}` };
}

export interface WebCloudflareDependencies {
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}
export interface WebCloudflareApi {
  request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', resource: string, body?: unknown): Promise<unknown>;
  list(resource: string): Promise<Record<string, unknown>[]>;
}

/** Raw response errors and the credential never enter diagnostics. */
export function createWebCloudflareApi(token: string, dependencies: WebCloudflareDependencies = {}): WebCloudflareApi {
  if (!token || /\s/u.test(token))
    throw new GwsEaError('web_credential_invalid', 'Cloudflare credential file must hold one API token.');
  registerSecret(token);
  const send = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? delay;
  const deadline = Date.now() + 45_000;
  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    resource: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!resource.startsWith('/') || resource.startsWith('//')) throw new Error('Invalid Cloudflare resource');
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new GwsEaError('web_cloudflare_timeout', 'The bounded Cloudflare operation deadline was reached.');
      let response: Response;
      let envelope: unknown;
      try {
        response = await send(`https://api.cloudflare.com/client/v4${resource}`, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(Math.min(5000, remaining)),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (reader) {
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              if (bytes > MAX_RESPONSE_BYTES) throw new Error('Response too large');
              chunks.push(next.value);
            }
          } finally {
            await reader.cancel();
          }
        }
        envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_cause) {
        throw new GwsEaError(
          'web_cloudflare_unavailable',
          'Cloudflare did not return a verifiable response. An interrupted create remains recorded and must be resolved before retrying.',
        );
      }
      if (response.status === 429) {
        const retry = response.headers.get('Retry-After');
        const seconds = retry && /^\d+$/u.test(retry) ? Number(retry) : undefined;
        const milliseconds = seconds === undefined ? Math.max(0, Date.parse(retry ?? '') - Date.now()) : seconds * 1000;
        if (
          attempt === 0 &&
          Number.isFinite(milliseconds) &&
          milliseconds <= 2000 &&
          milliseconds < deadline - Date.now()
        ) {
          await sleep(milliseconds);
          continue;
        }
        throw new GwsEaError(
          'web_cloudflare_rate_limited',
          'Cloudflare rate limited this operation. Retry after the reported delay.',
          { details: { retry_after_seconds: seconds ?? null, definite_rejection: true } },
        );
      }
      if (!response.ok || !isRecord(envelope) || envelope.success !== true) {
        const code =
          response.status === 401 || response.status === 403 ? 'web_cloudflare_forbidden' : 'web_cloudflare_rejected';
        throw new GwsEaError(
          code,
          'Cloudflare refused this operation. Check the configured account, resource permissions and Access capacity.',
          { details: { status: response.status, definite_rejection: response.status >= 400 && response.status < 500 } },
        );
      }
      return envelope;
    }
    throw new Error('Unreachable Cloudflare retry');
  }
  return {
    async request(method, resource, body) {
      const result = await request(method, resource, body);
      return isRecord(result) ? result.result : undefined;
    },
    async list(resource) {
      const records: Record<string, unknown>[] = [];
      for (let page = 1; page <= 20; page++) {
        const envelope = await request(
          'GET',
          `${resource}${resource.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        );
        if (!isRecord(envelope) || !Array.isArray(envelope.result) || !envelope.result.every(isRecord))
          throw new GwsEaError('web_cloudflare_invalid', 'Cloudflare returned an invalid resource list.');
        records.push(...envelope.result);
        const pages = isRecord(envelope.result_info) ? envelope.result_info.total_pages : undefined;
        if (pages === undefined ? envelope.result.length < 100 : typeof pages === 'number' && page >= pages)
          return records;
      }
      throw new GwsEaError('web_cloudflare_capacity', 'Cloudflare resource discovery exceeded its bounded page limit.');
    },
  };
}

export interface WebRemoteAssistant {
  readonly claim: WebNamespaceClaim;
  readonly applicationId?: string;
  readonly policyId?: string;
  readonly aud?: string;
  readonly enabled: boolean;
  readonly publicationReady?: boolean;
  readonly revokePending?: boolean;
}
type WebCreateKind = 'pin' | 'tunnel' | 'application' | 'policy' | 'dns';
export interface WebCreateAttempt {
  readonly kind: WebCreateKind;
  readonly key: string;
  readonly target: string;
  readonly startedAt: string;
  readonly resource: string;
  readonly fingerprint: string;
  readonly name?: string;
}
export interface WebResolvedAttempt extends WebCreateAttempt {
  readonly resolvedAt: string;
  readonly resolution: 'operator_removed';
}
export interface WebOperatorConfig {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly teamName: string;
  readonly zoneId: string;
  readonly zoneApex: string;
  readonly credentialFile: string;
  readonly cloudflaredPath: string;
  readonly connector?: {
    readonly manager: 'launchd' | 'systemd-user' | 'systemd-system';
    readonly definitionFile: string;
    readonly label: string;
    readonly homeDirectory: string;
  };
  readonly tunnelId?: string;
  readonly pin?: { readonly id: string; readonly owned: boolean };
  readonly dns: Readonly<Record<string, { readonly id: string; readonly zoneId: string }>>;
  readonly assistants: Readonly<Record<string, WebRemoteAssistant>>;
  readonly pending?: WebCreateAttempt;
  readonly resolvedAttempts?: readonly WebResolvedAttempt[];
}

export function webOperatorFiles(paths: Pick<ControlPlanePaths, 'configRoot'>) {
  const root = path.join(paths.configRoot, 'web');
  return { root, configFile: path.join(root, 'config.json'), tokenFile: path.join(root, 'tunnel-token') };
}

export function parseWebOperatorConfig(value: unknown): WebOperatorConfig {
  const invalid = (): never => {
    throw new GwsEaError(
      'web_operator_invalid',
      'Web operator configuration is invalid. Restore its owner-only record.',
    );
  };
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.accountId !== 'string' ||
    !ID.test(value.accountId) ||
    typeof value.zoneId !== 'string' ||
    !ID.test(value.zoneId) ||
    typeof value.teamName !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value.teamName) ||
    typeof value.zoneApex !== 'string' ||
    !HOST.test(value.zoneApex) ||
    typeof value.credentialFile !== 'string' ||
    !path.isAbsolute(value.credentialFile) ||
    typeof value.cloudflaredPath !== 'string' ||
    !path.isAbsolute(value.cloudflaredPath) ||
    !isRecord(value.dns) ||
    !isRecord(value.assistants)
  )
    return invalid();
  const optionalId = (candidate: unknown): string | undefined => {
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'string' || !ID.test(candidate)) return invalid();
    return candidate;
  };
  const tunnelId = optionalId(value.tunnelId);
  let pin: WebOperatorConfig['pin'];
  if (value.pin !== undefined) {
    if (
      !isRecord(value.pin) ||
      typeof value.pin.id !== 'string' ||
      !ID.test(value.pin.id) ||
      typeof value.pin.owned !== 'boolean'
    )
      return invalid();
    pin = { id: value.pin.id, owned: value.pin.owned };
  }
  const dns: Record<string, { id: string; zoneId: string }> = {};
  for (const [hostname, record] of Object.entries(value.dns)) {
    if (
      !HOST.test(hostname) ||
      !isRecord(record) ||
      typeof record.id !== 'string' ||
      !ID.test(record.id) ||
      typeof record.zoneId !== 'string' ||
      !ID.test(record.zoneId)
    )
      return invalid();
    dns[hostname] = { id: record.id, zoneId: record.zoneId };
  }
  const assistants: Record<string, WebRemoteAssistant> = {};
  const applications = new Set<string>();
  for (const [instanceId, assistant] of Object.entries(value.assistants)) {
    if (!INSTANCE_ID_PATTERN.test(instanceId)) return invalid();
    if (!isRecord(assistant) || typeof assistant.enabled !== 'boolean' || !isRecord(assistant.claim)) return invalid();
    const claim = assistant.claim;
    if (
      typeof claim.hostname !== 'string' ||
      !HOST.test(claim.hostname) ||
      typeof claim.listen_port !== 'number' ||
      !Number.isInteger(claim.listen_port) ||
      claim.listen_port < 1 ||
      claim.listen_port > 65535
    )
      return invalid();
    const applicationId = optionalId(assistant.applicationId);
    const policyId = optionalId(assistant.policyId);
    const aud = optionalId(assistant.aud);
    if (
      (aud && !applicationId) ||
      (policyId && (!applicationId || !aud)) ||
      (assistant.enabled && (!applicationId || !policyId || !aud || !pin || !tunnelId)) ||
      (applicationId && applications.has(applicationId))
    )
      return invalid();
    if (applicationId) applications.add(applicationId);
    if (assistant.revokePending !== undefined && typeof assistant.revokePending !== 'boolean') return invalid();
    if (assistant.publicationReady !== undefined && typeof assistant.publicationReady !== 'boolean') return invalid();
    assistants[instanceId] = {
      claim: { hostname: claim.hostname, listen_port: claim.listen_port },
      enabled: assistant.enabled,
      ...(typeof assistant.publicationReady === 'boolean' ? { publicationReady: assistant.publicationReady } : {}),
      ...(applicationId === undefined ? {} : { applicationId }),
      ...(policyId === undefined ? {} : { policyId }),
      ...(aud === undefined ? {} : { aud }),
      ...(typeof assistant.revokePending === 'boolean' ? { revokePending: assistant.revokePending } : {}),
    };
  }
  let connector: WebOperatorConfig['connector'];
  if (value.connector !== undefined) {
    const record = value.connector;
    if (
      !isRecord(record) ||
      (record.manager !== 'launchd' && record.manager !== 'systemd-user' && record.manager !== 'systemd-system') ||
      typeof record.definitionFile !== 'string' ||
      !path.isAbsolute(record.definitionFile) ||
      typeof record.homeDirectory !== 'string' ||
      !path.isAbsolute(record.homeDirectory) ||
      typeof record.label !== 'string' ||
      !/^com\.gws-ea\.web\.[0-9a-f]{16}$/u.test(record.label)
    )
      return invalid();
    const expected =
      record.manager === 'launchd'
        ? path.join(record.homeDirectory, 'Library', 'LaunchAgents', `${record.label}.plist`)
        : record.manager === 'systemd-system'
          ? `/etc/systemd/system/${record.label}.service`
          : path.join(record.homeDirectory, '.config', 'systemd', 'user', `${record.label}.service`);
    if (record.definitionFile !== expected) return invalid();
    connector = {
      manager: record.manager,
      definitionFile: record.definitionFile,
      homeDirectory: record.homeDirectory,
      label: record.label,
    };
  }
  const attempt = (candidate: unknown): WebCreateAttempt => {
    if (
      !isRecord(candidate) ||
      (candidate.kind !== 'pin' &&
        candidate.kind !== 'tunnel' &&
        candidate.kind !== 'application' &&
        candidate.kind !== 'policy' &&
        candidate.kind !== 'dns') ||
      typeof candidate.key !== 'string' ||
      !INSTANCE_ID_PATTERN.test(candidate.key) ||
      typeof candidate.target !== 'string' ||
      !candidate.target ||
      hasControlCharacters(candidate.target) ||
      typeof candidate.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.startedAt)) ||
      typeof candidate.resource !== 'string' ||
      !candidate.resource.startsWith('/') ||
      candidate.resource.startsWith('//') ||
      hasControlCharacters(candidate.resource) ||
      typeof candidate.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(candidate.fingerprint) ||
      (candidate.name !== undefined && (typeof candidate.name !== 'string' || hasControlCharacters(candidate.name)))
    )
      return invalid();
    return {
      kind: candidate.kind,
      key: candidate.key,
      target: candidate.target,
      startedAt: candidate.startedAt,
      resource: candidate.resource,
      fingerprint: candidate.fingerprint,
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    };
  };
  const pending = value.pending === undefined ? undefined : attempt(value.pending);
  let resolvedAttempts: WebResolvedAttempt[] | undefined;
  if (value.resolvedAttempts !== undefined) {
    if (!Array.isArray(value.resolvedAttempts) || value.resolvedAttempts.length > 64) return invalid();
    resolvedAttempts = value.resolvedAttempts.map((entry: unknown) => {
      const created = attempt(entry);
      if (
        !isRecord(entry) ||
        typeof entry.resolvedAt !== 'string' ||
        !Number.isFinite(Date.parse(entry.resolvedAt)) ||
        entry.resolution !== 'operator_removed'
      )
        return invalid();
      return { ...created, resolvedAt: entry.resolvedAt, resolution: entry.resolution };
    });
  }
  return {
    schemaVersion: 1,
    accountId: value.accountId,
    teamName: value.teamName,
    zoneId: value.zoneId,
    zoneApex: value.zoneApex,
    credentialFile: value.credentialFile,
    cloudflaredPath: value.cloudflaredPath,
    dns,
    assistants,
    ...(tunnelId === undefined ? {} : { tunnelId }),
    ...(pin === undefined ? {} : { pin }),
    ...(connector === undefined ? {} : { connector }),
    ...(pending === undefined ? {} : { pending }),
    ...(resolvedAttempts === undefined ? {} : { resolvedAttempts }),
  };
}

export async function readWebOperatorConfig(file: string): Promise<WebOperatorConfig | undefined> {
  try {
    const config = parseWebOperatorConfig(
      await readOwnerOnlyJson(file, 'Web operator configuration', 'web_operator_invalid'),
    );
    if (config.credentialFile !== path.join(path.dirname(file), 'management-token'))
      throw new GwsEaError('web_operator_invalid', 'Cloudflare management credential path is not canonical.');
    return config;
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return undefined;
    throw cause;
  }
}
export async function writeWebOperatorConfig(file: string, config: WebOperatorConfig): Promise<void> {
  await writePrivateTextFile(file, `${JSON.stringify(parseWebOperatorConfig(config))}\n`);
}
export async function webApi(
  config: WebOperatorConfig,
  dependencies: WebCloudflareDependencies = {},
): Promise<WebCloudflareApi> {
  const root = path.dirname(path.dirname(config.credentialFile));
  const token = (
    await readOperatorFile(config.credentialFile, root, 'Cloudflare management credential', 'web_credential_invalid')
  ).trim();
  return createWebCloudflareApi(token, dependencies);
}
export function cloudflareId(value: unknown): string {
  if (!isRecord(value) || typeof value.id !== 'string' || !ID.test(value.id))
    throw new GwsEaError('web_cloudflare_invalid', 'Cloudflare did not return an exact resource ID.');
  return value.id;
}
export function webEmails(emails: readonly string[]): string[] {
  const normalized = emails.map((email) => normalizePrincipalEmail(email));
  if (normalized.some((email) => email === undefined) || normalized.length > 1000)
    throw new GwsEaError('web_email_invalid', 'Access admission requires at most 1000 exact valid email addresses.');
  return [...new Set(normalized.filter((email): email is string => email !== undefined))].sort();
}
export function webEmailPolicy(emails: readonly string[]): Record<string, unknown> {
  const exact = webEmails(emails);
  return {
    name: 'Artifact readers',
    decision: exact.length ? 'allow' : 'deny',
    precedence: 1,
    include: exact.length ? exact.map((email) => ({ email: { email } })) : [{ everyone: {} }],
    exclude: [],
    require: [],
  };
}
export function verifiedPolicyEmails(value: unknown): string[] {
  if (
    isRecord(value) &&
    value.decision === 'deny' &&
    JSON.stringify(value.include) === '[{"everyone":{}}]' &&
    (value.exclude === undefined || (Array.isArray(value.exclude) && value.exclude.length === 0)) &&
    (value.require === undefined || (Array.isArray(value.require) && value.require.length === 0))
  )
    return [];
  if (
    !isRecord(value) ||
    value.decision !== 'allow' ||
    !Array.isArray(value.include) ||
    (value.exclude !== undefined && (!Array.isArray(value.exclude) || value.exclude.length > 0)) ||
    (value.require !== undefined && (!Array.isArray(value.require) || value.require.length > 0))
  )
    throw new GwsEaError('web_access_mismatch', 'The owned Access policy no longer has exact email admission.');
  const emails = value.include.map((rule: unknown) =>
    isRecord(rule) && Object.keys(rule).length === 1 && isRecord(rule.email) && typeof rule.email.email === 'string'
      ? rule.email.email
      : '',
  );
  return webEmails(emails);
}
export function webAccessApplication(claim: WebNamespaceClaim, pinId: string): Record<string, unknown> {
  return {
    name: `Web ${claim.hostname}`,
    type: 'self_hosted',
    destinations: [
      {
        type: 'public',
        uri: claim.hostname,
        overrides: [{ behavior: 'public', path_pattern: `/artifacts/public/*` }],
      },
    ],
    allowed_idps: [pinId],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    session_duration: '1h',
  };
}

export function assertWebApplication(value: unknown, assistant: WebRemoteAssistant, config: WebOperatorConfig): void {
  const destination =
    isRecord(value) && Array.isArray(value.destinations) && value.destinations.length === 1
      ? value.destinations[0]
      : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.aud !== 'string' ||
    !isRecord(destination) ||
    typeof destination.uri !== 'string'
  )
    throw new GwsEaError(
      'web_access_unverified',
      'Cloudflare did not return verifiable Access application coordinates.',
    );
  if (
    isRecord(value) &&
    (value.id !== assistant.applicationId ||
      value.aud !== assistant.aud ||
      (isRecord(destination) && destination.uri !== assistant.claim.hostname))
  )
    throw new GwsEaError(
      'web_application_mismatch',
      'The owned Access application no longer points at its recorded assistant address and audience.',
    );
  const overrides =
    isRecord(destination) && Array.isArray(destination.overrides) && destination.overrides.length === 1
      ? destination.overrides[0]
      : undefined;
  if (
    !isRecord(value) ||
    value.id !== assistant.applicationId ||
    value.type !== 'self_hosted' ||
    value.aud !== assistant.aud ||
    !isRecord(destination) ||
    destination.type !== 'public' ||
    destination.uri !== assistant.claim.hostname ||
    !isRecord(overrides) ||
    overrides.behavior !== 'public' ||
    overrides.path_pattern !== `/artifacts/public/*` ||
    !Array.isArray(value.allowed_idps) ||
    value.allowed_idps.length !== 1 ||
    value.allowed_idps[0] !== config.pin?.id ||
    value.auto_redirect_to_identity !== true
  )
    throw new GwsEaError(
      'web_access_mismatch',
      'The owned Access application no longer matches its recorded destination, audience or PIN identity provider.',
    );
}

export interface WebAccessReconciliation {
  readonly operatorConfigFile: string;
  readonly accountId: string;
  readonly applicationId: string;
  /** A callback is read once the machine lock is held, so it sees current local admission. */
  readonly emails: readonly string[] | (() => Promise<readonly string[]>);
}
/** Call outside DB transactions. Removing an admitted email revokes the app's existing sessions. */
export async function reconcileWebAccessEmails(
  input: WebAccessReconciliation,
  dependencies: WebCloudflareDependencies = {},
): Promise<{ readonly verified: true; readonly emails: readonly string[]; readonly changed: boolean }> {
  const configRoot = path.dirname(path.dirname(input.operatorConfigFile));
  const paths = resolveControlPlanePaths({ configRoot });
  if (webOperatorFiles(paths).configFile !== input.operatorConfigFile)
    throw new GwsEaError('web_operator_invalid', 'Web operator configuration path is not canonical.');
  return withMachineLock(paths, async () => {
    let config = await readWebOperatorConfig(input.operatorConfigFile);
    if (!config || config.accountId !== input.accountId)
      throw new GwsEaError('web_access_mismatch', 'Web Cloudflare account is not the recorded owner.');
    const entry = Object.entries(config.assistants).find(
      ([, assistant]) => assistant.applicationId === input.applicationId,
    );
    if (!entry || !entry[1].enabled || !entry[1].policyId)
      throw new GwsEaError('web_disabled', 'Web are disabled or their Access resources are incomplete.');
    const [instanceId, assistant] = entry;
    const emails = webEmails(typeof input.emails === 'function' ? await input.emails() : input.emails);
    const api = await webApi(config, dependencies);
    const appPath = `/accounts/${config.accountId}/access/apps/${input.applicationId}`;
    assertWebApplication(await api.request('GET', appPath), assistant, config);
    const policies = await api.list(`${appPath}/policies`);
    if (policies.length !== 1 || policies[0].id !== assistant.policyId)
      throw new GwsEaError('web_access_mismatch', 'Unexpected policies exist on the owned Access application.');
    const previous = verifiedPolicyEmails(policies[0]);
    const changed = JSON.stringify(previous) !== JSON.stringify(emails);
    const reduction = previous.some((email) => !emails.includes(email));
    if (reduction && !assistant.revokePending) {
      config = { ...config, assistants: { ...config.assistants, [instanceId]: { ...assistant, revokePending: true } } };
      await writeWebOperatorConfig(input.operatorConfigFile, config);
    }
    if (changed) await api.request('PUT', `${appPath}/policies/${assistant.policyId}`, webEmailPolicy(emails));
    const verified = verifiedPolicyEmails(await api.request('GET', `${appPath}/policies/${assistant.policyId}`));
    if (JSON.stringify(verified) !== JSON.stringify(emails))
      throw new GwsEaError('web_access_unverified', 'Cloudflare email admission has not converged.');
    if (reduction || assistant.revokePending) {
      await api.request('POST', `${appPath}/revoke_tokens`);
      config = {
        ...config,
        assistants: { ...config.assistants, [instanceId]: { ...assistant, revokePending: false } },
      };
      await writeWebOperatorConfig(input.operatorConfigFile, config);
    }
    return { verified: true, emails, changed };
  });
}
