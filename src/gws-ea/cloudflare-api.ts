/**
 * The Cloudflare REST seam. Readers tolerate the documented optional
 * and extra fields; ownership is decided by callers on exact values. Every
 * request writes its method, path, and HTTP status to the step's raw log,
 * never a body; non-token reads go to the fixture capture sink when enabled.
 */
import { setTimeout as delay } from 'node:timers/promises';

import type { CloudflareZoneChoice, ManagedIngressSetupSession } from './create-input.js';
import { redact, registerSecret } from './redact.js';
import { activeStep } from './run-log.js';
import { GwsEaError } from './types.js';
import { hasControlCharacters, isRecord, requireString as requireText } from './validation.js';

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_READ_ATTEMPTS = 3;
const MAX_PAGES = 100;
const PER_PAGE = 50;
const MAX_BACKOFF_MS = 30_000;
/** Cloudflare blocks a rate-limited token for up to five minutes. */
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_ERROR_MESSAGE_CHARACTERS = 200;
const CLOUDFLARE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const TUNNEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DNS_NAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

type Fetch = typeof globalThis.fetch;
type Sleep = (delayMs: number) => Promise<void>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface CloudflareApiOptions {
  readonly accountToken: string;
  readonly baseUrl?: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly maxReadAttempts?: number;
  readonly sleep?: Sleep;
}

/** A remotely managed tunnel; locally managed ones are refused as foreign when read. */
export interface CloudflareTunnel {
  readonly id: string;
  readonly name: string;
}

/** A tunnel's configuration: an empty one before the first write. */
export interface CloudflareTunnelConfiguration {
  readonly config: Readonly<Record<string, unknown>>;
  readonly version: number;
}

/** One connected connector; `configVersion` is optional in the documented schema. */
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
  /** Also proves the token, including account-owned tokens, which `/user/tokens/verify` rejects. */
  listActiveZones(): Promise<readonly CloudflareZoneChoice[]>;
  listTunnels(accountId: string, name: string): Promise<readonly CloudflareTunnel[]>;
  createTunnel(accountId: string, name: string): Promise<CloudflareTunnel>;
  getTunnelConfiguration(accountId: string, tunnelId: string): Promise<CloudflareTunnelConfiguration>;
  /** Replace the whole configuration; callers confirm it by reading it back. */
  replaceTunnelConfiguration(accountId: string, tunnelId: string, config: unknown): Promise<void>;
  /** The connector token, registered with the redactor on receipt and never logged or captured. */
  getTunnelToken(accountId: string, tunnelId: string): Promise<string>;
  /** Connector state comes only from here: tunnel objects lose `connections` on 2026-10-05. */
  listTunnelConnections(accountId: string, tunnelId: string): Promise<readonly CloudflareTunnelConnection[]>;
  listDnsRecords(zoneId: string, name: string): Promise<readonly CloudflareDnsRecord[]>;
  createDnsRecord(zoneId: string, record: CloudflareDnsRecordWrite): Promise<CloudflareDnsRecord>;
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
  deleteTunnel(accountId: string, tunnelId: string): Promise<void>;
}

export interface RetainedManagedIngressSetupSession extends ManagedIngressSetupSession {
  requireAccountToken(accountId: string): string;
}

/**
 * A change Cloudflare did not confirm: no answer or a 5xx (it may have been
 * applied), or a 429 after its Retry-After (it was not). Either way the
 * caller re-reads before deciding whether to send it again.
 */
export class CloudflareAmbiguousMutationError extends GwsEaError {
  readonly status: number | undefined;

  constructor(operation: string, status?: number, cause?: unknown) {
    super(
      status === 429 ? 'cloudflare_rate_limited' : 'cloudflare_mutation_ambiguous',
      status === 429
        ? `Cloudflare rate-limited the request to ${operation} (HTTP 429)`
        : `Cloudflare did not confirm the request to ${operation}${status === undefined ? ': no answer' : ` (HTTP ${status})`}`,
      {
        details: { operation, ...(status === undefined ? {} : { http_status: status }) },
        ...(cause === undefined ? {} : { cause }),
      },
    );
    this.name = 'CloudflareAmbiguousMutationError';
    this.status = status;
  }

  /** A rate-limited change was certainly not applied. */
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

function invalid(what: string): GwsEaError {
  return new GwsEaError('invalid_cloudflare_response', `Cloudflare returned an invalid ${what}`);
}

function requireString(value: unknown, label: string, maxLength?: number): string {
  return requireText(value, `Cloudflare ${label}`, 'invalid_cloudflare_response', maxLength);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function responseId(value: unknown, label: string, pattern: RegExp): string {
  const id = requireString(value, label, 36).toLowerCase();
  if (!pattern.test(id)) throw invalid(label);
  return id;
}

function requestId(value: string, label: string, pattern: RegExp): string {
  const id = value.toLowerCase();
  if (!pattern.test(id)) throw new GwsEaError('invalid_cloudflare_request', `${label} is invalid`);
  return id;
}

function accountPath(accountId: string): string {
  return `/accounts/${requestId(accountId, 'Cloudflare account ID', CLOUDFLARE_ID_PATTERN)}`;
}

function tunnelPath(accountId: string, tunnelId: string): string {
  return `${accountPath(accountId)}/cfd_tunnel/${requestId(tunnelId, 'Cloudflare tunnel ID', TUNNEL_ID_PATTERN)}`;
}

function zonePath(zoneId: string): string {
  return `/zones/${requestId(zoneId, 'Cloudflare zone ID', CLOUDFLARE_ID_PATTERN)}`;
}

/** The first documented `{ code, message }` error, with its message redacted and bounded. */
function firstError(errors: unknown): { readonly code?: number; readonly message?: string } {
  const first = Array.isArray(errors) ? errors.find(isRecord) : undefined;
  if (!first) return {};
  const message = redact(text(first.message)).replace(/\s+/gu, ' ').trim();
  return {
    ...(integer(first.code) === undefined ? {} : { code: integer(first.code) }),
    ...(message ? { message: message.slice(0, MAX_ERROR_MESSAGE_CHARACTERS) } : {}),
  };
}

function failure(operation: string, status: number, errors: unknown): GwsEaError {
  const { code, message } = firstError(errors);
  const observed = [`HTTP ${status}`, ...(code === undefined ? [] : [`code ${code}`])].join(', ');
  const details = {
    operation,
    http_status: status,
    ...(code === undefined ? {} : { cloudflare_code: code }),
    ...(message === undefined ? {} : { cloudflare_message: message }),
  };
  const summary = `Cloudflare could not ${operation} (${observed})${message ? `: ${message}` : ''}`;
  if (status === 401 || status === 403 || code === 9_109 || code === 10_000) {
    return new GwsEaError(
      'cloudflare_capability_missing',
      `${summary}. Use an active token with Zone Read, DNS Edit, and Cloudflare Tunnel Edit for the selected resources.`,
      { details },
    );
  }
  return new GwsEaError(status >= 500 ? 'cloudflare_unavailable' : 'cloudflare_api_failed', summary, { details });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function backoff(attempt: number): number {
  return Math.min(100 * 2 ** attempt, MAX_BACKOFF_MS);
}

function retryAfter(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp)) return Math.min(Math.max(timestamp - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return backoff(attempt);
}

function parseTunnel(value: unknown): CloudflareTunnel {
  if (!isRecord(value)) throw invalid('tunnel');
  // Either documented field marks a remotely managed tunnel; `connections` is never read.
  const remote = value.config_src === undefined ? value.remote_config === true : value.config_src === 'cloudflare';
  if (!remote) throw new GwsEaError('foreign_cloudflare_tunnel', 'Cloudflare tunnel is not remotely managed');
  return {
    id: responseId(value.id, 'tunnel ID', TUNNEL_ID_PATTERN),
    name: requireString(value.name, 'tunnel name', 100),
  };
}

function shape(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/** Every field of the documented result is optional: a fresh tunnel has neither `config` nor `version`. */
function parseConfiguration(value: unknown): CloudflareTunnelConfiguration {
  if (value === undefined || value === null) return { config: {}, version: 0 };
  const { config, version } = isRecord(value) ? value : { config: undefined, version: undefined };
  if (
    !isRecord(value) ||
    (config !== undefined && config !== null && !isRecord(config)) ||
    (version !== undefined && version !== null && integer(version) === undefined)
  ) {
    const summary = isRecord(value) ? `config=${shape(config)}, version=${shape(version)}` : `result=${shape(value)}`;
    throw new GwsEaError(
      'invalid_cloudflare_response',
      `Cloudflare returned an invalid tunnel configuration (${summary})`,
    );
  }
  if (value.source !== undefined && value.source !== 'cloudflare') {
    throw new GwsEaError('foreign_cloudflare_tunnel', 'Cloudflare tunnel configuration is not remotely managed');
  }
  return { config: isRecord(config) ? config : {}, version: integer(version) ?? 0 };
}

function parseConnection(value: unknown): CloudflareTunnelConnection {
  if (!isRecord(value)) return {};
  const configVersion = integer(value.config_version);
  return {
    ...(typeof value.id === 'string' && value.id ? { id: value.id } : {}),
    ...(configVersion === undefined ? {} : { configVersion }),
  };
}

/** Fields other than the ID are read as found: a record that differs is foreign to its caller, not invalid. */
function parseDnsRecord(value: unknown): CloudflareDnsRecord {
  if (!isRecord(value)) throw invalid('DNS record');
  return {
    id: responseId(value.id, 'DNS record ID', CLOUDFLARE_ID_PATTERN),
    type: text(value.type),
    name: text(value.name).toLowerCase(),
    content: text(value.content),
    proxied: value.proxied === true,
    comment: text(value.comment),
  };
}

function parseZone(value: unknown): CloudflareZoneChoice | undefined {
  if (!isRecord(value) || !isRecord(value.account)) throw invalid('zone');
  if (value.status !== 'active') return undefined;
  const name = requireString(value.name, 'zone name', 253).toLowerCase();
  if (!DNS_NAME_PATTERN.test(name)) throw invalid('zone name');
  const accountId = responseId(value.account.id, 'account ID', CLOUDFLARE_ID_PATTERN);
  return {
    zoneId: responseId(value.id, 'zone ID', CLOUDFLARE_ID_PATTERN),
    name,
    status: 'active',
    accountId,
    accountName: text(value.account.name) || accountId,
  };
}

/** The last page: an empty one, the reported last page (`total_pages: 0` for none), or a short page. */
function isLastPage(page: number, count: number, info: unknown): boolean {
  if (count === 0) return true;
  if (isRecord(info)) {
    const totalCount = integer(info.total_count);
    const perPage = integer(info.per_page);
    const totalPages =
      integer(info.total_pages) ?? (totalCount !== undefined && perPage ? Math.ceil(totalCount / perPage) : undefined);
    if (totalPages !== undefined) return page >= totalPages;
  }
  return count < PER_PAGE;
}

interface RequestOptions {
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** The result is a secret: never captured. */
  readonly secret?: boolean;
}

interface Answer {
  readonly result: unknown;
  readonly resultInfo: unknown;
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
    registerSecret(options.accountToken);
    this.#accountToken = options.accountToken;
    this.#baseUrl = baseUrl.toString().replace(/\/$/u, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxReadAttempts = options.maxReadAttempts ?? DEFAULT_READ_ATTEMPTS;
    this.#sleep = options.sleep ?? delay;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new GwsEaError('invalid_cloudflare_api', 'Cloudflare request timeout is invalid');
    }
    if (!Number.isInteger(this.#maxReadAttempts) || this.#maxReadAttempts < 1 || this.#maxReadAttempts > 5) {
      throw new GwsEaError('invalid_cloudflare_api', 'Cloudflare read retry limit is invalid');
    }
  }

  /**
   * One call. Reads retry transient failures within their bound, honoring
   * Retry-After. A change is sent once: after a 429 it waits Retry-After, then
   * reports the change unconfirmed so the caller re-reads first.
   */
  async #request(operation: string, method: Method, path: string, options: RequestOptions = {}): Promise<Answer> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const reading = method === 'GET';
    const attempts = reading ? this.#maxReadAttempts : 1;
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt + 1 >= attempts;
      let response: Response;
      let body: string;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#accountToken}`,
            accept: 'application/json',
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        body = await response.text();
      } catch (error) {
        activeStep()?.write(`Cloudflare ${method} ${url.pathname}: no answer\n`);
        if (!reading) throw new CloudflareAmbiguousMutationError(operation, undefined, error);
        if (last) {
          throw new GwsEaError('cloudflare_unavailable', `Cloudflare did not answer the request to ${operation}`, {
            cause: error,
            details: { operation },
          });
        }
        await this.#sleep(backoff(attempt));
        continue;
      }
      activeStep()?.write(`Cloudflare ${method} ${url.pathname}: HTTP ${response.status}, ${body.length} bytes\n`);
      if (isRetryableStatus(response.status) && (reading ? !last : response.status === 429)) {
        const wait = retryAfter(response, attempt);
        activeStep()?.write(`Waiting ${Math.ceil(wait / 1_000)} s before Cloudflare is asked again\n`);
        await this.#sleep(wait);
        if (reading) continue;
      }
      if (!reading && isRetryableStatus(response.status)) {
        throw new CloudflareAmbiguousMutationError(operation, response.status);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        if (!response.ok) throw failure(operation, response.status, []);
        throw new GwsEaError(
          'invalid_cloudflare_response',
          `Cloudflare answered the request to ${operation} with HTTP ${response.status} but no JSON`,
          { details: { operation, http_status: response.status } },
        );
      }
      if (!isRecord(parsed) || typeof parsed.success !== 'boolean') {
        if (!response.ok) throw failure(operation, response.status, []);
        throw invalid(`response envelope for ${operation}`);
      }
      if (!response.ok || !parsed.success) throw failure(operation, response.status, parsed.errors);
      if (reading && !options.secret) {
        activeStep()?.captureHttp({ method, url: url.toString(), status: response.status, body });
      }
      return { result: parsed.result, resultInfo: parsed.result_info };
    }
  }

  async #list<T>(
    operation: string,
    path: string,
    query: Readonly<Record<string, string>>,
    parse: (value: unknown) => T | undefined,
  ): Promise<readonly T[]> {
    const values: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { result, resultInfo } = await this.#request(operation, 'GET', path, {
        query: { ...query, page: String(page), per_page: String(PER_PAGE) },
      });
      if (!Array.isArray(result)) throw invalid(`list while trying to ${operation}`);
      for (const item of result) {
        const parsed = parse(item);
        if (parsed !== undefined) values.push(parsed);
      }
      if (isLastPage(page, result.length, resultInfo)) return values;
    }
    throw new GwsEaError('invalid_cloudflare_response', 'Cloudflare pagination exceeded its safety bound');
  }

  listActiveZones(): Promise<readonly CloudflareZoneChoice[]> {
    return this.#list('read active zones', '/zones', { status: 'active' }, parseZone);
  }

  listTunnels(accountId: string, name: string): Promise<readonly CloudflareTunnel[]> {
    return this.#list(
      'read managed tunnels',
      `${accountPath(accountId)}/cfd_tunnel`,
      { name: requireString(name, 'tunnel name', 100), is_deleted: 'false' },
      parseTunnel,
    );
  }

  async createTunnel(accountId: string, name: string): Promise<CloudflareTunnel> {
    const { result } = await this.#request(
      'create the managed tunnel',
      'POST',
      `${accountPath(accountId)}/cfd_tunnel`,
      {
        body: { name: requireString(name, 'tunnel name', 100), config_src: 'cloudflare' },
      },
    );
    return parseTunnel(result);
  }

  async getTunnelConfiguration(accountId: string, tunnelId: string): Promise<CloudflareTunnelConfiguration> {
    const path = `${tunnelPath(accountId, tunnelId)}/configurations`;
    return parseConfiguration((await this.#request('read the tunnel configuration', 'GET', path)).result);
  }

  async replaceTunnelConfiguration(accountId: string, tunnelId: string, config: unknown): Promise<void> {
    if (!isRecord(config)) throw new GwsEaError('invalid_cloudflare_request', 'Tunnel configuration is invalid');
    const path = `${tunnelPath(accountId, tunnelId)}/configurations`;
    await this.#request('replace the tunnel configuration', 'PUT', path, { body: { config } });
  }

  async getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    const { result } = await this.#request(
      'read the connector token',
      'GET',
      `${tunnelPath(accountId, tunnelId)}/token`,
      {
        secret: true,
      },
    );
    const token = requireString(result, 'connector token', 16_384);
    registerSecret(token);
    return token;
  }

  async listTunnelConnections(accountId: string, tunnelId: string): Promise<readonly CloudflareTunnelConnection[]> {
    const path = `${tunnelPath(accountId, tunnelId)}/connections`;
    const { result } = await this.#request('read tunnel connections', 'GET', path);
    if (!Array.isArray(result)) throw invalid('tunnel connection list');
    return result.map(parseConnection);
  }

  listDnsRecords(zoneId: string, name: string): Promise<readonly CloudflareDnsRecord[]> {
    const dnsName = name.toLowerCase();
    if (dnsName !== name || !DNS_NAME_PATTERN.test(dnsName)) {
      throw new GwsEaError('invalid_cloudflare_request', 'Cloudflare DNS name is invalid');
    }
    return this.#list('read DNS records', `${zonePath(zoneId)}/dns_records`, { name: dnsName }, parseDnsRecord);
  }

  async createDnsRecord(zoneId: string, record: CloudflareDnsRecordWrite): Promise<CloudflareDnsRecord> {
    const path = `${zonePath(zoneId)}/dns_records`;
    return parseDnsRecord((await this.#request('create the owned DNS record', 'POST', path, { body: record })).result);
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    const id = requestId(recordId, 'Cloudflare DNS record ID', CLOUDFLARE_ID_PATTERN);
    await this.#request('delete the owned DNS record', 'DELETE', `${zonePath(zoneId)}/dns_records/${id}`);
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    await this.#request('delete the owned tunnel', 'DELETE', tunnelPath(accountId, tunnelId));
  }
}

export function createCloudflareApi(options: CloudflareApiOptions): CloudflareApi {
  return new CloudflareApiClient(options);
}

/**
 * The account token for one run: listing its zones proves it, and it is held
 * in memory only for the accounts those zones belong to.
 */
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
      const zones = await clientFactory(accountToken).listActiveZones();
      discovered = { token: accountToken, accountIds: new Set(zones.map((zone) => zone.accountId)) };
      return zones;
    },
    retainAccountToken(accountToken) {
      if (!discovered || discovered.token !== accountToken) {
        throw new GwsEaError(
          'cloudflare_token_unverified',
          'Cloudflare API token must list its zones before it is retained for this run',
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
