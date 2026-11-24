/**
 * Host requests to servers someone outside the operator named. Every hop
 * resolves once through the shared public-address policy, dials that pinned IP
 * on 443 and verifies TLS against the original hostname. Its own dispatcher
 * never consults global or environment proxies.
 */
import type { IncomingHttpHeaders } from 'node:http';
import tls from 'node:tls';

import { Agent, type buildConnector, type Dispatcher } from 'undici';

import { RefusedDestination, resolveDestination, type Destination } from './resolve.js';

const MAX_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([300, 301, 302, 303, 307, 308]);
const NULL_BODY = new Set([204, 205, 304]);
const JSON_TYPE = /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/iu;

/** `refused`: the policy said no. `timeout`: the time cap ran out. `failed`: anything else on the way. */
export type EgressFailure = 'refused' | 'timeout' | 'failed';
export type EgressRefusalReason = 'response_too_large';

export interface EgressErrorDetail {
  /** True once the request left the host; false when rejected before dialing. */
  readonly sent?: boolean;
  readonly reason?: EgressRefusalReason;
}

/** Carries only its code and safe detail: no URL, header or body ever reaches a message, cause or log line. */
export class EgressError extends Error {
  constructor(
    readonly code: EgressFailure,
    readonly detail?: EgressErrorDetail,
  ) {
    super(`Public request ${code}`);
    this.name = 'EgressError';
  }
}

export interface PublicFetchOptions {
  /**
   * Token, registration and revocation requests and MCP calls follow none, so
   * a credential can never be steered elsewhere. Metadata reads may follow a
   * redirect on the same host, which is checked again like the first hop.
   */
  readonly redirect: 'none' | 'same-host';
  /** Metadata is read only as JSON: a successful answer that is not JSON is refused. */
  readonly json?: boolean;
  /** Maximum response body size in bytes; defaults to 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Per-request timeout in milliseconds; defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

export interface PinnedEndpoint {
  readonly address: string;
  readonly port: number;
  readonly servername: string;
}

export interface EgressDependencies {
  readonly resolve: (target: URL) => Promise<Destination>;
  readonly connect: (endpoint: PinnedEndpoint) => tls.TLSSocket;
  readonly timeoutMs: number;
}

/** The shape MCP's client auth helpers take as their fetch. */
export type PublicFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const production: EgressDependencies = {
  resolve: resolveDestination,
  connect: ({ address, port, servername }) =>
    tls.connect({
      host: address,
      port,
      servername,
      // Set explicitly so NODE_TLS_REJECT_UNAUTHORIZED cannot weaken it.
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    }),
  timeoutMs: TIMEOUT_MS,
};

interface Outgoing {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer | null;
}

interface Reply {
  readonly status: number;
  readonly statusText: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer | null;
}

export function publicFetch(options: PublicFetchOptions, overrides: Partial<EgressDependencies> = {}): PublicFetch {
  const timeoutMs = overrides.timeoutMs ?? options.timeoutMs ?? production.timeoutMs;
  const dependencies: EgressDependencies = { ...production, ...overrides, timeoutMs };
  return (input, init) => send(options, dependencies, input, init);
}

function bodyCap(options: PublicFetchOptions): number {
  const cap = options.maxBodyBytes;
  if (cap === undefined) return MAX_BODY_BYTES;
  if (!Number.isSafeInteger(cap) || cap < 1) throw new EgressError('refused', { sent: false });
  return cap;
}

async function send(
  options: PublicFetchOptions,
  dependencies: EgressDependencies,
  input: string | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(new EgressError('timeout')), dependencies.timeoutMs);
  const cancel = (): void => control.abort(new EgressError('failed'));
  init?.signal?.addEventListener('abort', cancel, { once: true });
  if (init?.signal?.aborted) cancel();
  let sent = false;
  let stop!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(control.signal.reason);
    control.signal.addEventListener('abort', stop, { once: true });
    if (control.signal.aborted) stop();
  });
  try {
    return await Promise.race([
      exchange(options, dependencies, input, init, control.signal, () => {
        sent = true;
      }),
      stopped,
    ]);
  } catch (error) {
    throw classify(error, control.signal, sent);
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener('abort', cancel);
    control.signal.removeEventListener('abort', stop);
  }
}

function classify(error: unknown, signal: AbortSignal, sent: boolean): EgressError {
  if (signal.aborted && signal.reason instanceof EgressError) {
    return new EgressError(signal.reason.code, {
      ...signal.reason.detail,
      sent: signal.reason.detail?.sent ?? sent,
    });
  }
  if (error instanceof EgressError) return error;
  if (error instanceof RefusedDestination) return new EgressError('refused', { sent: false });
  return new EgressError('failed', { sent });
}

async function outgoing(input: string | URL, init: RequestInit | undefined): Promise<{ url: URL; request: Outgoing }> {
  let request: Request;
  // The platform's own parser normalizes every header and body shape a caller can pass,
  // and rejects a URL that carries credentials.
  try {
    request = new Request(input, { method: init?.method, headers: init?.headers, body: init?.body });
  } catch (_error) {
    throw new EgressError('refused', { sent: false });
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  delete headers.host;
  // An encoded answer would bypass the byte cap until decoded, so none is accepted.
  headers['accept-encoding'] = 'identity';
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
  return { url: new URL(request.url), request: { method: request.method, headers, body } };
}

async function exchange(
  options: PublicFetchOptions,
  dependencies: EgressDependencies,
  input: string | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
  onConnect: () => void,
): Promise<Response> {
  const maxBodyBytes = bodyCap(options);
  const { url: first, request } = await outgoing(input, init);
  let url = first;
  let headers = request.headers;
  for (let hop = 0; ; hop += 1) {
    const reply = await hopOnce(url, { ...request, headers }, dependencies, maxBodyBytes, signal, onConnect);
    if (!REDIRECTS.has(reply.status)) return answer(reply, request.method, options);
    const location = reply.headers.location;
    if (
      options.redirect !== 'same-host' ||
      hop >= MAX_REDIRECTS ||
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      typeof location !== 'string' ||
      !URL.canParse(location, url.href)
    ) {
      throw new EgressError('refused', { sent: true });
    }
    const next = new URL(location, url);
    if (next.hostname !== url.hostname) throw new EgressError('refused', { sent: true });
    const { authorization: _authorization, ...rest } = headers;
    headers = rest;
    url = next;
  }
}

function pinned(url: URL): void {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443')) {
    throw new EgressError('refused', { sent: false });
  }
}

async function hopOnce(
  url: URL,
  request: Outgoing,
  dependencies: EgressDependencies,
  maxBodyBytes: number,
  signal: AbortSignal,
  onConnect: () => void,
): Promise<Reply> {
  pinned(url);
  const destination = await dependencies.resolve(url);
  if (destination.port !== 443) throw new EgressError('refused', { sent: false });
  if (signal.aborted) throw signal.reason;
  let connected = false;
  const agent = new Agent({
    connect: connector(url.hostname, destination, dependencies, signal, () => {
      connected = true;
      onConnect();
    }),
    connections: 1,
    headersTimeout: dependencies.timeoutMs,
    bodyTimeout: dependencies.timeoutMs,
  });
  try {
    const response = await agent.request({
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
    });
    if (REDIRECTS.has(response.statusCode)) {
      discard(response.body);
      return { status: response.statusCode, statusText: '', headers: response.headers, body: null };
    }
    return {
      status: response.statusCode,
      statusText: response.statusText,
      headers: response.headers,
      body: await capped(response, maxBodyBytes),
    };
  } catch (error) {
    if (error instanceof EgressError) throw error;
    if (signal.aborted && signal.reason instanceof EgressError) {
      throw new EgressError(signal.reason.code, { sent: connected });
    }
    throw new EgressError('failed', { sent: connected });
  } finally {
    await agent.destroy(null);
  }
}

function connector(
  hostname: string,
  destination: Destination,
  dependencies: EgressDependencies,
  signal: AbortSignal,
  onConnect: () => void,
): buildConnector.connector {
  return (_options, callback) => {
    const socket = dependencies.connect({
      address: destination.address,
      port: destination.port,
      servername: hostname,
    });
    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      socket.removeListener('error', fail);
      signal.removeEventListener('abort', aborted);
      return true;
    };
    const fail = (error: Error): void => {
      if (!settle()) return;
      socket.destroy();
      callback(error, null);
    };
    const aborted = (): void => fail(new EgressError('failed', { sent: false }));
    socket.once('secureConnect', () => {
      if (settle()) {
        onConnect();
        callback(null, socket);
      }
    });
    socket.once('error', fail);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  };
}

/** Undici reports a destroyed body as an error event; this body is unwanted, so that is expected. */
function discard(body: Dispatcher.ResponseData['body']): void {
  body.on('error', () => undefined);
  body.destroy();
}

async function capped(response: Dispatcher.ResponseData, maxBodyBytes: number): Promise<Buffer> {
  const encoding = response.headers['content-encoding'];
  const declared = Number(response.headers['content-length']);
  if (encoding !== undefined && encoding !== 'identity') {
    discard(response.body);
    throw new EgressError('refused', { sent: true });
  }
  if (declared > maxBodyBytes) {
    discard(response.body);
    throw new EgressError('refused', { sent: true, reason: 'response_too_large' });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response.body) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) throw new EgressError('failed', { sent: true });
    size += chunk.length;
    if (size > maxBodyBytes) {
      discard(response.body);
      throw new EgressError('refused', { sent: true, reason: 'response_too_large' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function parsesAsJson(text: string): boolean {
  // The parser's message quotes the body, so only the verdict leaves here.
  /* eslint-disable no-catch-all/no-catch-all -- a body that does not parse is simply not JSON */
  try {
    JSON.parse(text);
    return true;
  } catch (_error) {
    return false;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function answer(reply: Reply, method: string, options: PublicFetchOptions): Response {
  if (reply.status < 200 || reply.status > 599) throw new EgressError('failed', { sent: true });
  const body = reply.body ?? Buffer.alloc(0);
  if (options.json && reply.status < 300) {
    const type = reply.headers['content-type'];
    if (typeof type !== 'string' || !JSON_TYPE.test(type) || !parsesAsJson(body.toString('utf8'))) {
      throw new EgressError('refused', { sent: true });
    }
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(reply.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const empty = NULL_BODY.has(reply.status) || method === 'HEAD';
  return new Response(empty ? null : new Uint8Array(body), {
    status: reply.status,
    statusText: reply.statusText,
    headers,
  });
}
