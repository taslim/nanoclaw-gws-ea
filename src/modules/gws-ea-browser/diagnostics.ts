/** Passive, bounded facts only: network payloads and raw failure text never cross this boundary. */
import { createRequire } from 'node:module';

import type { Page, Request } from 'playwright-core';
import { getDomain } from 'tldts';

const manifest: unknown = createRequire(import.meta.url)('playwright-core/package.json');
const playwrightVersion =
  typeof manifest === 'object' && manifest !== null && 'version' in manifest ? version(manifest.version) : undefined;
const EVENT_LIMIT = 64;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);
const RESOURCES = new Set([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
]);
const ACTIONS = new Set([
  'browser',
  'fill_secret',
  'credential_form',
  'sign_in_code',
  'save_recipe',
  'run_recipe',
  'purchase',
  'watch',
  'list_watches',
  'cancel_watch',
  'request_consent',
  'browser_watch_book',
  'browser_purchase_commit',
  'browser_relay_sign_in',
]);

export interface BrowserDiagnosticCorrelation {
  readonly jobId: string;
  readonly requestId: string;
  readonly action: string;
  readonly actionIndex?: number;
}
export type BrowserHostRefusal = 'address' | 'document' | 'action' | 'target' | 'download';
type TransportCategory = 'dns' | 'tls' | 'aborted' | 'connection' | 'timeout' | 'unknown';
interface RequestFacts {
  site?: string;
  method: string;
  resource: string;
}
type BrowserDiagnosticFact =
  | (RequestFacts & { source: 'http_response'; status: number })
  | (RequestFacts & { source: 'transport_failure'; category: TransportCategory })
  | (Partial<RequestFacts> & { source: 'host_refusal'; category: BrowserHostRefusal })
  | { source: 'runtime_error'; category: 'unavailable' | 'disconnected' | 'execution' };
export type BrowserDiagnosticEvent = BrowserDiagnosticFact & { elapsed_ms: number };
export interface BrowserDiagnostics {
  schema_version: 1;
  job_id: string;
  request_id: string;
  action: string;
  action_index?: number;
  runtime: { playwright?: string; chrome?: string; node: string };
  events: readonly BrowserDiagnosticEvent[];
  omitted_events: number;
}

function version(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+(?:\.\d+){1,3}(?:-[a-z0-9.]+)?$/i.test(value) && value.length <= 64
    ? value
    : undefined;
}
function facts(input: { url: string; method: string; resource: string }): RequestFacts {
  const url = URL.canParse(input.url) ? new URL(input.url) : undefined;
  const site =
    url && (url.protocol === 'http:' || url.protocol === 'https:')
      ? getDomain(url.hostname, { allowPrivateDomains: true })
      : null;
  return {
    ...(site ? { site } : {}),
    method: METHODS.has(input.method) ? input.method : 'OTHER',
    resource: RESOURCES.has(input.resource) ? input.resource : 'other',
  };
}
function transportCategory(raw: string | undefined): TransportCategory {
  switch (raw) {
    case 'net::ERR_NAME_NOT_RESOLVED':
    case 'net::ERR_DNS_TIMED_OUT':
      return 'dns';
    case 'net::ERR_CERT_AUTHORITY_INVALID':
    case 'net::ERR_CERT_COMMON_NAME_INVALID':
    case 'net::ERR_CERT_DATE_INVALID':
    case 'net::ERR_SSL_PROTOCOL_ERROR':
    case 'net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH':
      return 'tls';
    case 'net::ERR_ABORTED':
      return 'aborted';
    case 'net::ERR_CONNECTION_REFUSED':
    case 'net::ERR_CONNECTION_RESET':
    case 'net::ERR_CONNECTION_CLOSED':
    case 'net::ERR_INTERNET_DISCONNECTED':
      return 'connection';
    case 'net::ERR_TIMED_OUT':
    case 'net::ERR_CONNECTION_TIMED_OUT':
      return 'timeout';
    default:
      return 'unknown';
  }
}

const current = new WeakMap<Page, BrowserDiagnosticAttempt>();
const attached = new WeakSet<Page>();

/** Installed before a job page can act. Request object identity, never a URL match, binds its later events. */
export function attachBrowserDiagnostics(page: Page): void {
  if (attached.has(page)) return;
  attached.add(page);
  const requests = new WeakMap<Request, { attempt: BrowserDiagnosticAttempt; facts: RequestFacts }>();
  page.on('request', (request) => {
    const attempt = current.get(page);
    if (!attempt) return;
    requests.set(request, {
      attempt,
      facts: facts({ url: request.url(), method: request.method(), resource: request.resourceType() }),
    });
  });
  page.on('response', (response) => {
    const request = requests.get(response.request());
    const status = response.status();
    if (!request || current.get(page) !== request.attempt || !Number.isInteger(status) || status < 100 || status > 599)
      return;
    request.attempt.record({ ...request.facts, source: 'http_response', status });
  });
  page.on('requestfailed', (request) => {
    const captured = requests.get(request);
    if (!captured || current.get(page) !== captured.attempt) return;
    captured.attempt.record({
      ...captured.facts,
      source: 'transport_failure',
      category: transportCategory(request.failure()?.errorText),
    });
    requests.delete(request);
  });
  page.on('requestfinished', (request) => requests.delete(request));
  page.once('close', () => current.delete(page));
}

/** Construct each persisted event explicitly; extra properties can never turn into stored payloads. */
function safeFact(event: BrowserDiagnosticFact): BrowserDiagnosticFact {
  const request = {
    ...(event.source !== 'runtime_error' && event.site ? { site: event.site } : {}),
    ...(event.source !== 'runtime_error' && event.method ? { method: event.method } : {}),
    ...(event.source !== 'runtime_error' && event.resource ? { resource: event.resource } : {}),
  };
  switch (event.source) {
    case 'http_response':
      return {
        source: event.source,
        status: event.status,
        site: event.site,
        method: event.method,
        resource: event.resource,
      };
    case 'transport_failure':
      return {
        source: event.source,
        category: event.category,
        site: event.site,
        method: event.method,
        resource: event.resource,
      };
    case 'host_refusal':
      return { source: event.source, category: event.category, ...request };
    case 'runtime_error':
      return { source: event.source, category: event.category };
  }
}

/** One immutable correlation/epoch; an event from an older attempt cannot enter a newer one. */
export class BrowserDiagnosticAttempt {
  private readonly started = performance.now();
  private readonly pages = new Set<Page>();
  private readonly events: BrowserDiagnosticEvent[] = [];
  private omitted = 0;
  private closed = false;
  private chrome: string | undefined;
  private readonly correlation: BrowserDiagnosticCorrelation;

  constructor(correlation: BrowserDiagnosticCorrelation) {
    this.correlation = {
      jobId: correlation.jobId,
      requestId: correlation.requestId,
      action: correlation.action,
      ...(Number.isInteger(correlation.actionIndex) && (correlation.actionIndex ?? -1) >= 0
        ? { actionIndex: correlation.actionIndex }
        : {}),
    };
  }

  observe(page: Page): void {
    if (this.closed) return;
    attachBrowserDiagnostics(page);
    this.chrome ??= version(page.context().browser()?.version());
    this.pages.add(page);
    current.set(page, this);
  }

  record(event: BrowserDiagnosticFact): void {
    if (this.closed) return;
    if (this.events.length >= EVENT_LIMIT) {
      this.omitted++;
      return;
    }
    this.events.push({ ...safeFact(event), elapsed_ms: Math.max(0, Math.round(performance.now() - this.started)) });
  }

  finish(): BrowserDiagnostics {
    this.closed = true;
    for (const page of this.pages) if (current.get(page) === this) current.delete(page);
    this.pages.clear();
    return {
      schema_version: 1,
      job_id: this.correlation.jobId,
      request_id: this.correlation.requestId,
      action: ACTIONS.has(this.correlation.action) ? this.correlation.action : 'unknown',
      ...(this.correlation.actionIndex === undefined ? {} : { action_index: this.correlation.actionIndex }),
      runtime: {
        ...(playwrightVersion ? { playwright: playwrightVersion } : {}),
        ...(this.chrome ? { chrome: this.chrome } : {}),
        node: process.versions.node,
      },
      events: this.events.map((event) => ({ ...event })),
      omitted_events: this.omitted,
    };
  }
}

/** Capture at the decision's start, before awaiting policy/lease work. A late refusal is discarded. */
export function captureBrowserDiagnosticRefusal(
  page: Page,
): (category: BrowserHostRefusal, request?: { url: string; method: string; resource: string }) => void {
  const attempt = current.get(page);
  return (category, request) => {
    if (!attempt || current.get(page) !== attempt) return;
    attempt.record({ source: 'host_refusal', category, ...(request ? facts(request) : {}) });
  };
}
