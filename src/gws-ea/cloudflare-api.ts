import type { CloudflareZoneChoice, ManagedIngressSetupSession } from './create-input.js';
import { GwsEaError } from './types.js';
import { hasControlCharacters, isRecord } from './validation.js';

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_READ_ATTEMPTS = 3;
const MAX_PAGES = 100;
const MAX_RETRY_DELAY_MS = 30_000;
const CLOUDFLARE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const TUNNEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DNS_NAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

type Fetch = typeof globalThis.fetch;
type Sleep = (delayMs: number) => Promise<void>;

export interface CloudflareApiOptions {
  readonly accountToken: string;
  readonly baseUrl?: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly maxReadAttempts?: number;
  readonly sleep?: Sleep;
}

interface CloudflareEnvelope {
  readonly success: boolean;
  readonly result: unknown;
  readonly errors: readonly unknown[];
  readonly messages: readonly unknown[];
  readonly resultInfo?: CloudflareResultInfo;
}

interface CloudflareResultInfo {
  readonly page: number;
  readonly totalPages: number;
}

export interface CloudflareTunnel {
  readonly id: string;
  readonly name: string;
  readonly configSource: 'cloudflare';
  readonly status: string;
}

export interface CloudflareTunnelConfiguration {
  readonly config: unknown;
  readonly initialized: boolean;
  readonly version: number;
}

export interface CloudflareTunnelConnection {
  readonly id?: string;
  readonly configVersion?: number;
}

export interface CloudflareDnsRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly proxied: boolean;
  readonly comment: string;
}

export interface CloudflareDnsRecordWrite {
  readonly type: 'CNAME';
  readonly name: string;
  readonly content: string;
  readonly proxied: true;
  readonly comment: string;
}

export interface CloudflareApi {
  verifyToken(): Promise<void>;
  listActiveZones(): Promise<readonly CloudflareZoneChoice[]>;
  listTunnels(accountId: string, name: string): Promise<readonly CloudflareTunnel[]>;
  createTunnel(accountId: string, name: string): Promise<CloudflareTunnel>;
  getTunnelConfiguration(accountId: string, tunnelId: string): Promise<CloudflareTunnelConfiguration>;
  replaceTunnelConfiguration(
    accountId: string,
    tunnelId: string,
    config: unknown,
  ): Promise<CloudflareTunnelConfiguration>;
  getTunnelToken(accountId: string, tunnelId: string): Promise<string>;
  listTunnelConnections(accountId: string, tunnelId: string): Promise<readonly CloudflareTunnelConnection[]>;
  listDnsRecords(zoneId: string, name: string): Promise<readonly CloudflareDnsRecord[]>;
  createDnsRecord(zoneId: string, record: CloudflareDnsRecordWrite): Promise<CloudflareDnsRecord>;
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
  deleteTunnel(accountId: string, tunnelId: string): Promise<void>;
}

export interface RetainedManagedIngressSetupSession extends ManagedIngressSetupSession {
  requireAccountToken(accountId: string): string;
}

export class CloudflareAmbiguousMutationError extends GwsEaError {
  constructor(operation: string) {
    super(
      'cloudflare_mutation_ambiguous',
      `Cloudflare did not confirm ${operation}; inspect the exact owned resource before retrying.`,
    );
    this.name = 'CloudflareAmbiguousMutationError';
  }
}

function requireString(value: unknown, label: string, maxLength = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || hasControlCharacters(value)) {
    throw new GwsEaError('invalid_cloudflare_response', `Cloudflare returned an invalid ${label}`);
  }
  return value;
}

function requireCloudflareHexId(value: unknown, label: string): string {
  const id = requireString(value, label, 32).toLowerCase();
  if (!CLOUDFLARE_ID_PATTERN.test(id)) {
    throw new GwsEaError('invalid_cloudflare_response', `Cloudflare returned an invalid ${label}`);
  }
  return id;
}

function requireCloudflareTunnelId(value: unknown, label: string): string {
  const id = requireString(value, label, 36).toLowerCase();
  if (!TUNNEL_ID_PATTERN.test(id)) {
    throw new GwsEaError('invalid_cloudflare_response', `Cloudflare returned an invalid ${label}`);
  }
  return id;
}

function requireAccountOrZoneId(value: string, label: string): string {
  const id = value.toLowerCase();
  if (!CLOUDFLARE_ID_PATTERN.test(id)) throw new GwsEaError('invalid_cloudflare_request', `${label} is invalid`);
  return id;
}

function requireTunnelId(value: string): string {
  const id = value.toLowerCase();
  if (!TUNNEL_ID_PATTERN.test(id))
    throw new GwsEaError('invalid_cloudflare_request', 'Cloudflare tunnel ID is invalid');
  return id;
}

function requireDnsName(value: string): string {
  const name = value.toLowerCase();
  if (name !== value || !DNS_NAME_PATTERN.test(name)) {
    throw new GwsEaError('invalid_cloudflare_request', 'Cloudflare DNS name is invalid');
  }
  return name;
}

function parseResultInfo(value: unknown): CloudflareResultInfo {
  if (!isRecord(value)) throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare pagination is missing');
  const { page, per_page: perPage, total_count: totalCount, total_pages: reportedTotalPages } = value;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
    throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare pagination is invalid');
  }
  const totalPages =
    reportedTotalPages === undefined &&
    typeof perPage === 'number' &&
    Number.isInteger(perPage) &&
    perPage > 0 &&
    typeof totalCount === 'number' &&
    Number.isInteger(totalCount) &&
    totalCount >= 0
      ? Math.max(1, Math.ceil(totalCount / perPage))
      : reportedTotalPages;
  if (typeof totalPages !== 'number' || !Number.isInteger(totalPages) || totalPages < page || totalPages > MAX_PAGES) {
    throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare pagination is invalid');
  }
  return { page, totalPages };
}

function parseEnvelope(
  value: unknown,
  options: { readonly paginated: boolean; readonly allowMissingResult: boolean },
): CloudflareEnvelope {
  if (
    !isRecord(value) ||
    typeof value.success !== 'boolean' ||
    !Array.isArray(value.errors) ||
    !Array.isArray(value.messages)
  ) {
    throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned an invalid response envelope');
  }
  if (!options.allowMissingResult && !Object.hasOwn(value, 'result')) {
    throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare response has no result');
  }
  return {
    success: value.success,
    result: value.result,
    errors: value.errors,
    messages: value.messages,
    ...(options.paginated && value.success ? { resultInfo: parseResultInfo(value.result_info) } : {}),
  };
}

function cloudflareErrorCode(errors: readonly unknown[]): number | undefined {
  for (const value of errors) {
    if (isRecord(value) && typeof value.code === 'number' && Number.isInteger(value.code)) return value.code;
  }
  return undefined;
}

function failure(operation: string, status: number, errors: readonly unknown[]): GwsEaError {
  const code = cloudflareErrorCode(errors);
  const suffix = code === undefined ? '' : ` (Cloudflare code ${code})`;
  if (status === 401 || status === 403 || code === 9_100 || code === 10_000) {
    return new GwsEaError(
      'cloudflare_capability_missing',
      `Cloudflare authorization cannot ${operation}${suffix}. Use an active token with Zone Read, DNS Edit, and Cloudflare Tunnel Edit for the selected resources.`,
    );
  }
  return new GwsEaError('cloudflare_api_failed', `Cloudflare could not ${operation}${suffix}`);
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp)) return Math.min(Math.max(timestamp - Date.now(), 0), MAX_RETRY_DELAY_MS);
  }
  return Math.min(100 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function parseTunnel(value: unknown): CloudflareTunnel {
  if (!isRecord(value)) throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned an invalid tunnel');
  if (value.config_src !== 'cloudflare') {
    throw new GwsEaError('foreign_cloudflare_tunnel', 'Cloudflare tunnel is not remotely managed by Cloudflare');
  }
  return {
    id: requireCloudflareTunnelId(value.id, 'tunnel ID'),
    name: requireString(value.name, 'tunnel name', 100),
    configSource: 'cloudflare',
    status: requireString(value.status, 'tunnel status', 64),
  };
}

function invalidConfiguration(value: unknown): GwsEaError {
  const shape = (entry: unknown): string => {
    if (entry === undefined) return 'missing';
    if (entry === null) return 'null';
    if (Array.isArray(entry)) return 'array';
    return typeof entry;
  };
  const summary = isRecord(value)
    ? `config=${shape(value.config)}, version=${shape(value.version)}`
    : `result=${shape(value)}`;
  return new GwsEaError(
    'invalid_cloudflare_response',
    `Cloudflare returned an invalid tunnel configuration (${summary})`,
  );
}

function parseConfiguration(value: unknown, allowUninitialized: boolean): CloudflareTunnelConfiguration {
  // The current GET schema makes result, config, and version optional before
  // the first configuration PUT. No error status is treated as initialization.
  if (allowUninitialized && value === undefined) {
    return { config: {}, initialized: false, version: 0 };
  }
  if (!isRecord(value)) throw invalidConfiguration(value);
  const documentedKeys = new Set(['account_id', 'config', 'created_at', 'source', 'tunnel_id', 'version']);
  if (Object.keys(value).some((key) => !documentedKeys.has(key))) {
    throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare tunnel configuration contains unknown fields');
  }
  if (value.account_id !== undefined) requireCloudflareHexId(value.account_id, 'configuration account ID');
  if (value.tunnel_id !== undefined) requireCloudflareTunnelId(value.tunnel_id, 'configuration tunnel ID');
  if (value.created_at !== undefined) requireString(value.created_at, 'configuration creation time', 64);
  if (value.source !== undefined && value.source !== 'cloudflare') {
    throw new GwsEaError('foreign_cloudflare_tunnel', 'Cloudflare tunnel configuration is not remotely managed');
  }
  if (
    allowUninitialized &&
    (value.version === undefined || value.version === 0) &&
    (value.config === undefined ||
      value.config === null ||
      (isRecord(value.config) && Object.keys(value.config).length === 0))
  ) {
    return { config: {}, initialized: false, version: 0 };
  }
  if (!isRecord(value.config)) throw invalidConfiguration(value);
  const version = value.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw invalidConfiguration(value);
  }
  return { config: value.config, initialized: true, version };
}

function parseDnsRecord(value: unknown): CloudflareDnsRecord {
  if (!isRecord(value) || typeof value.proxied !== 'boolean') {
    throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned an invalid DNS record');
  }
  const name = requireString(value.name, 'DNS record name', 253).toLowerCase();
  if (!DNS_NAME_PATTERN.test(name)) {
    throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned an invalid DNS record name');
  }
  return {
    id: requireCloudflareHexId(value.id, 'DNS record ID'),
    type: requireString(value.type, 'DNS record type', 16),
    name,
    content: requireString(value.content, 'DNS record content', 2048),
    proxied: value.proxied,
    comment:
      value.comment === null || value.comment === undefined ? '' : requireString(value.comment, 'DNS comment', 500),
  };
}

class CloudflareApiClient implements CloudflareApi {
  readonly #accountToken: string;
  readonly #baseUrl: string;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #maxReadAttempts: number;
  readonly #sleep: Sleep;

  constructor(options: CloudflareApiOptions) {
    if (!options.accountToken.trim() || hasControlCharacters(options.accountToken)) {
      throw new GwsEaError('invalid_cloudflare_token', 'Cloudflare API token is invalid');
    }
    const baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new GwsEaError('invalid_cloudflare_api', 'Cloudflare API base URL is invalid');
    }
    this.#accountToken = options.accountToken;
    this.#baseUrl = baseUrl.toString().replace(/\/$/u, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxReadAttempts = options.maxReadAttempts ?? DEFAULT_READ_ATTEMPTS;
    this.#sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new GwsEaError('invalid_cloudflare_api', 'Cloudflare request timeout is invalid');
    }
    if (!Number.isInteger(this.#maxReadAttempts) || this.#maxReadAttempts < 1 || this.#maxReadAttempts > 5) {
      throw new GwsEaError('invalid_cloudflare_api', 'Cloudflare read retry limit is invalid');
    }
  }

  async #request(
    operation: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: {
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
      readonly paginated?: boolean;
      readonly allowMissingResult?: boolean;
    } = {},
  ): Promise<CloudflareEnvelope> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const attempts = method === 'GET' ? this.#maxReadAttempts : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#accountToken}`,
            accept: 'application/json',
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          redirect: 'error',
          signal: controller.signal,
        });
        if (isRetryableStatus(response.status) && method === 'GET' && attempt + 1 < attempts) {
          await this.#sleep(retryDelay(response, attempt));
          continue;
        }
        if (isRetryableStatus(response.status) && method !== 'GET') {
          throw new CloudflareAmbiguousMutationError(operation);
        }
        let raw: unknown;
        try {
          raw = await response.json();
        } catch (_error) {
          if (!response.ok) throw failure(operation, response.status, []);
          throw new GwsEaError(
            'invalid_cloudflare_response',
            `Cloudflare returned invalid JSON while trying to ${operation}`,
          );
        }
        const envelope = parseEnvelope(raw, {
          paginated: options.paginated === true,
          allowMissingResult: options.allowMissingResult === true,
        });
        if (!response.ok || !envelope.success) throw failure(operation, response.status, envelope.errors);
        return envelope;
      } catch (error) {
        if (error instanceof GwsEaError) throw error;
        if (method !== 'GET') throw new CloudflareAmbiguousMutationError(operation);
        if (attempt + 1 >= attempts) {
          throw new GwsEaError('cloudflare_unavailable', `Cloudflare did not answer while trying to ${operation}`);
        }
        await this.#sleep(Math.min(100 * 2 ** attempt, MAX_RETRY_DELAY_MS));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new GwsEaError('cloudflare_unavailable', `Cloudflare did not answer while trying to ${operation}`);
  }

  async #list<T>(
    operation: string,
    path: string,
    query: Readonly<Record<string, string>>,
    parse: (value: unknown) => T,
  ): Promise<readonly T[]> {
    const values: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const envelope = await this.#request(operation, 'GET', path, {
        query: { ...query, page: String(page), per_page: '50' },
        paginated: true,
      });
      if (!Array.isArray(envelope.result) || !envelope.resultInfo || envelope.resultInfo.page !== page) {
        throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned an invalid paginated result');
      }
      values.push(...envelope.result.map(parse));
      if (page === envelope.resultInfo.totalPages) return values;
    }
    throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare pagination exceeded its safety bound');
  }

  async verifyToken(): Promise<void> {
    const { result } = await this.#request('verify the API token', 'GET', '/user/tokens/verify');
    if (!isRecord(result) || result.status !== 'active') {
      throw new GwsEaError('cloudflare_token_inactive', 'Cloudflare API token is not active');
    }
  }

  async listActiveZones(): Promise<readonly CloudflareZoneChoice[]> {
    return this.#list('read active zones', '/zones', { status: 'active' }, (value) => {
      if (!isRecord(value) || !isRecord(value.account) || value.status !== 'active') {
        throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned an invalid active zone');
      }
      const name = requireString(value.name, 'zone name', 253).toLowerCase();
      if (!DNS_NAME_PATTERN.test(name)) {
        throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned an invalid zone name');
      }
      return {
        zoneId: requireCloudflareHexId(value.id, 'zone ID'),
        name,
        status: 'active',
        accountId: requireCloudflareHexId(value.account.id, 'account ID'),
        accountName: requireString(value.account.name, 'account name', 256),
      };
    });
  }

  async listTunnels(accountId: string, name: string): Promise<readonly CloudflareTunnel[]> {
    const account = requireAccountOrZoneId(accountId, 'Cloudflare account ID');
    const tunnelName = requireString(name, 'tunnel name', 100);
    return this.#list(
      'read managed tunnels',
      `/accounts/${account}/cfd_tunnel`,
      {
        name: tunnelName,
        is_deleted: 'false',
      },
      parseTunnel,
    );
  }

  async createTunnel(accountId: string, name: string): Promise<CloudflareTunnel> {
    const account = requireAccountOrZoneId(accountId, 'Cloudflare account ID');
    const tunnelName = requireString(name, 'tunnel name', 100);
    const { result } = await this.#request('create the managed tunnel', 'POST', `/accounts/${account}/cfd_tunnel`, {
      body: { name: tunnelName, config_src: 'cloudflare' },
    });
    return parseTunnel(result);
  }

  async getTunnelConfiguration(accountId: string, tunnelId: string): Promise<CloudflareTunnelConfiguration> {
    const account = requireAccountOrZoneId(accountId, 'Cloudflare account ID');
    const tunnel = requireTunnelId(tunnelId);
    const { result } = await this.#request(
      'read the tunnel configuration',
      'GET',
      `/accounts/${account}/cfd_tunnel/${tunnel}/configurations`,
      { allowMissingResult: true },
    );
    return parseConfiguration(result, true);
  }

  async replaceTunnelConfiguration(
    accountId: string,
    tunnelId: string,
    config: unknown,
  ): Promise<CloudflareTunnelConfiguration> {
    const account = requireAccountOrZoneId(accountId, 'Cloudflare account ID');
    const tunnel = requireTunnelId(tunnelId);
    if (!isRecord(config)) throw new GwsEaError('invalid_cloudflare_request', 'Tunnel configuration is invalid');
    const { result } = await this.#request(
      'replace the tunnel configuration',
      'PUT',
      `/accounts/${account}/cfd_tunnel/${tunnel}/configurations`,
      { body: { config } },
    );
    return parseConfiguration(result, false);
  }

  async getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    const account = requireAccountOrZoneId(accountId, 'Cloudflare account ID');
    const tunnel = requireTunnelId(tunnelId);
    const { result } = await this.#request(
      'read the connector token',
      'GET',
      `/accounts/${account}/cfd_tunnel/${tunnel}/token`,
    );
    return requireString(result, 'connector token', 16_384);
  }

  async listTunnelConnections(accountId: string, tunnelId: string): Promise<readonly CloudflareTunnelConnection[]> {
    const account = requireAccountOrZoneId(accountId, 'Cloudflare account ID');
    const tunnel = requireTunnelId(tunnelId);
    const { result } = await this.#request(
      'read tunnel connections',
      'GET',
      `/accounts/${account}/cfd_tunnel/${tunnel}/connections`,
    );
    if (!Array.isArray(result)) {
      throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned invalid tunnel connections');
    }
    return result.map((value) => {
      if (!isRecord(value)) {
        throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned an invalid tunnel connection');
      }
      const id = value.id;
      const configVersion = value.config_version;
      if (
        (configVersion !== undefined &&
          configVersion !== null &&
          (typeof configVersion !== 'number' || !Number.isInteger(configVersion))) ||
        (id !== undefined && id !== null && typeof id !== 'string')
      ) {
        throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare returned an invalid tunnel connection');
      }
      return {
        ...(id === undefined || id === null ? {} : { id: requireString(id, 'connection ID', 128) }),
        ...(configVersion === undefined || configVersion === null ? {} : { configVersion }),
      };
    });
  }

  async listDnsRecords(zoneId: string, name: string): Promise<readonly CloudflareDnsRecord[]> {
    const zone = requireAccountOrZoneId(zoneId, 'Cloudflare zone ID');
    const dnsName = requireDnsName(name);
    return this.#list('read DNS records', `/zones/${zone}/dns_records`, { name: dnsName }, parseDnsRecord);
  }

  async createDnsRecord(zoneId: string, record: CloudflareDnsRecordWrite): Promise<CloudflareDnsRecord> {
    const zone = requireAccountOrZoneId(zoneId, 'Cloudflare zone ID');
    const { result } = await this.#request('create the owned DNS record', 'POST', `/zones/${zone}/dns_records`, {
      body: record,
    });
    return parseDnsRecord(result);
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    const zone = requireAccountOrZoneId(zoneId, 'Cloudflare zone ID');
    const id = requireAccountOrZoneId(recordId, 'Cloudflare DNS record ID');
    await this.#request('delete the owned DNS record', 'DELETE', `/zones/${zone}/dns_records/${id}`);
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    const account = requireAccountOrZoneId(accountId, 'Cloudflare account ID');
    const tunnel = requireTunnelId(tunnelId);
    await this.#request('delete the owned tunnel', 'DELETE', `/accounts/${account}/cfd_tunnel/${tunnel}`);
  }
}

export function createCloudflareApi(options: CloudflareApiOptions): CloudflareApi {
  return new CloudflareApiClient(options);
}

export function createManagedIngressSetupSession(
  dependencies: {
    readonly clientFactory?: (accountToken: string) => CloudflareApi;
  } = {},
): RetainedManagedIngressSetupSession {
  const clientFactory = dependencies.clientFactory ?? ((accountToken) => createCloudflareApi({ accountToken }));
  let retained: { readonly token: string; readonly accountIds: ReadonlySet<string> } | null = null;
  let discovered: { readonly token: string; readonly accountIds: ReadonlySet<string> } | null = null;
  return {
    async discoverZones(accountToken) {
      const api = clientFactory(accountToken);
      await api.verifyToken();
      const zones = await api.listActiveZones();
      discovered = { token: accountToken, accountIds: new Set(zones.map((zone) => zone.accountId)) };
      return zones;
    },
    retainAccountToken(accountToken) {
      if (!discovered || discovered.token !== accountToken) {
        throw new GwsEaError(
          'cloudflare_token_unverified',
          'Cloudflare API token must be verified before it is retained for this run',
        );
      }
      retained = discovered;
      discovered = null;
    },
    requireAccountToken(accountId) {
      if (!retained || !retained.accountIds.has(accountId)) {
        throw new GwsEaError(
          'cloudflare_token_required',
          'A fresh Cloudflare API token is required for the selected account.',
        );
      }
      return retained.token;
    },
    clearAccountToken() {
      retained = null;
      discovered = null;
    },
  };
}
