/**
 * A real TLS server standing in for remote MCP servers and their authorization servers. The egress resolves every
 * host to it and still verifies TLS against each hostname, so requests take the production path end to end.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import type { EgressDependencies } from '../../gws-ea-egress/fetch.js';
import { connectionFetches, type ConnectionFetches } from '../oauth.js';

export interface FakeRequest {
  readonly host: string;
  readonly method: string;
  /** Path and query. */
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface FakeReply {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** A string is sent as is; anything else as JSON. */
  readonly body?: unknown;
}

export type FakeHandler = (request: FakeRequest) => FakeReply | undefined | Promise<FakeReply | undefined>;

export interface FakeEndpoints {
  readonly egress: Partial<EgressDependencies>;
  readonly fetches: ConnectionFetches;
  readonly requests: FakeRequest[];
  /** Handlers answer in the order added; the first reply wins and nothing answering is a 404. */
  use(handler: FakeHandler): void;
  reset(): void;
  close(): Promise<void>;
}

function certificateFor(hosts: readonly string[]): { key: string; cert: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connections-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        `/CN=${hosts[0]}`,
        '-addext',
        `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(',')}`,
        '-keyout',
        path.join(directory, 'key.pem'),
        '-out',
        path.join(directory, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    return {
      key: fs.readFileSync(path.join(directory, 'key.pem'), 'utf8'),
      cert: fs.readFileSync(path.join(directory, 'cert.pem'), 'utf8'),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function startFakeEndpoints(hosts: readonly string[]): Promise<FakeEndpoints> {
  const { key, cert } = certificateFor(hosts);
  const requests: FakeRequest[] = [];
  const handlers: FakeHandler[] = [];
  const server = https.createServer({ key, cert }, (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      void (async () => {
        const request: FakeRequest = {
          host: (incoming.headers.host ?? '').replace(/:443$/u, ''),
          method: incoming.method ?? '',
          path: incoming.url ?? '',
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(request);
        let reply: FakeReply = { status: 404, body: { error: 'not_found' } };
        for (const handler of [...handlers]) {
          const answer = await handler(request);
          if (answer) {
            reply = answer;
            break;
          }
        }
        const text =
          typeof reply.body === 'string' ? reply.body : reply.body === undefined ? '' : JSON.stringify(reply.body);
        const json = typeof reply.body !== 'string' && reply.body !== undefined;
        outgoing.writeHead(reply.status, {
          ...(json ? { 'content-type': 'application/json' } : {}),
          ...reply.headers,
        });
        outgoing.end(text);
      })().catch((error: unknown) => {
        if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : 'handler_failed' }));
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const egress: Partial<EgressDependencies> = {
    resolve: async () => ({ address: '127.0.0.1', family: 4, port: 443 }),
    connect: ({ servername }) => tls.connect({ host: '127.0.0.1', port, servername, ca: cert }),
  };
  return {
    egress,
    fetches: connectionFetches(egress),
    requests,
    use: (handler) => handlers.push(handler),
    reset: () => {
      handlers.length = 0;
      requests.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A 2025 server without sign-in or tools: it answers `initialize`, takes notifications and knows no other method,
 * `server/discover` included.
 */
export function legacyMcpReply(
  request: FakeRequest,
  serverInfo: { readonly name: string; readonly title?: string; readonly version: string },
): FakeReply {
  const message = JSON.parse(request.body) as { id?: number | string; method?: string };
  if (message.id === undefined) return { status: 202 };
  return {
    status: 200,
    body:
      message.method === 'initialize'
        ? { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo } }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } },
  };
}

export interface FakeToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, Record<string, unknown>>>;
    readonly required?: readonly string[];
    readonly [key: string]: unknown;
  };
  readonly outputSchema?: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, Record<string, unknown>>>;
    readonly required?: readonly string[];
    readonly [key: string]: unknown;
  };
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export interface RecordedToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly bearer: string | undefined;
}

export interface FakeToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

export interface FakeAppOptions {
  readonly appUrl: string;
  /** The resource identifier the server publishes and expects back verbatim; the app's URL unless given. */
  readonly resource?: string;
  /** Root-path issuer, on the app's host or another. */
  readonly issuer: string;
  readonly registration?: boolean;
  /** Advertises `authorization_response_iss_parameter_supported` and sends `iss` back. */
  readonly issParameter?: boolean;
  readonly tokenAuthMethods?: readonly string[];
  readonly scopes?: readonly string[];
  readonly revocation?: boolean;
  /** A client registered by hand with the server, as a principal would. */
  readonly client?: { readonly id: string; readonly secret: string; readonly redirectUri: string };
  readonly serverName?: string;
  readonly instructions?: string;
  readonly tools?: readonly FakeToolDefinition[];
  readonly allowUnauthenticated?: boolean;
  readonly onToolCall?: (call: RecordedToolCall) => FakeToolResult | FakeReply | undefined;
  readonly fetchClientDocument?: (url: string) => Promise<FakeReply>;
  /**
   * `2026-07-28` serves that revision alone, as Shop does: discovery instead of `initialize`, the protocol headers and
   * request `_meta` on every request, and sign-in asked for only by tool calls.
   */
  readonly protocol?: '2025-11-25' | '2026-07-28';
}

const MODERN_PROTOCOL = '2026-07-28';

interface McpMessage {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

function rpcError(id: string | number | undefined, code: number, message: string, data?: unknown): FakeReply {
  return {
    status: 200,
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } },
  };
}

function toolCallOf(params: Record<string, unknown>, bearer: string | undefined): RecordedToolCall {
  const name = typeof params.name === 'string' ? params.name : '';
  const args =
    typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
  return { name, arguments: args, bearer };
}

interface Client {
  readonly secret: string | undefined;
  readonly redirectUris: readonly string[];
}
interface PendingCode {
  readonly clientId: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly resource: string | null;
}

/**
 * An MCP server with OAuth in the shape Ledgerly publishes by default: protected-resource and authorization-server
 * metadata, PKCE S256, refresh tokens with rotation, revocation, `client_secret_basic` or `client_secret_post`, and
 * no registration endpoint unless asked for. With `fetchClientDocument` it also takes client metadata documents.
 */
export class FakeMcpApp {
  readonly app: URL;
  readonly resource: string;
  readonly issuer: URL;
  readonly resourceMetadata: Record<string, unknown>;
  readonly serverMetadata: Record<string, unknown>;
  readonly clients = new Map<string, Client>();
  readonly registrations: Record<string, unknown>[] = [];
  readonly documents: Record<string, unknown>[] = [];
  readonly revoked: string[] = [];
  readonly accessTokens = new Set<string>();
  readonly toolCalls: RecordedToolCall[] = [];
  tools: FakeToolDefinition[];
  instructions: string | undefined;
  mcpOverride: ((request: FakeRequest) => FakeReply | undefined | Promise<FakeReply | undefined>) | undefined;
  onToolCall: ((call: RecordedToolCall) => FakeToolResult | FakeReply | undefined) | undefined;
  private readonly refreshTokens = new Map<string, string>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly issParameter: boolean;
  private readonly serverName: string;
  private readonly allowUnauthenticated: boolean;
  private readonly fetchClientDocument: ((url: string) => Promise<FakeReply>) | undefined;
  private readonly modern: boolean;

  constructor(options: FakeAppOptions) {
    this.app = new URL(options.appUrl);
    this.resource = options.resource ?? this.app.href;
    this.issuer = new URL(options.issuer);
    this.issParameter = options.issParameter ?? false;
    this.serverName = options.serverName ?? 'Ledgerly';
    this.instructions = options.instructions;
    this.tools = [...(options.tools ?? [])];
    this.allowUnauthenticated = options.allowUnauthenticated ?? false;
    this.onToolCall = options.onToolCall;
    this.fetchClientDocument = options.fetchClientDocument;
    this.modern = options.protocol === MODERN_PROTOCOL;
    const at = (route: string): string => new URL(route, this.issuer).href;
    this.resourceMetadata = {
      resource: this.resource,
      authorization_servers: [options.issuer],
      ...(options.scopes ? { scopes_supported: [...options.scopes] } : {}),
    };
    this.serverMetadata = {
      issuer: options.issuer,
      authorization_endpoint: at('/oauth/authorize'),
      token_endpoint: at('/oauth/token'),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [
        ...(options.tokenAuthMethods ?? ['client_secret_basic', 'client_secret_post']),
      ],
      ...(options.registration ? { registration_endpoint: at('/oauth/register') } : {}),
      ...(options.revocation === false ? {} : { revocation_endpoint: at('/oauth/revoke') }),
      ...(this.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
      ...(options.fetchClientDocument ? { client_id_metadata_document_supported: true } : {}),
    };
    if (options.client)
      this.clients.set(options.client.id, {
        secret: options.client.secret,
        redirectUris: [options.client.redirectUri],
      });
  }

  get resourceMetadataUrl(): string {
    return new URL(this.resourceMetadataPath, this.app).href;
  }

  /** RFC 9728 inserts the well-known segment before the app's path, which is empty for an app at the root. */
  private get resourceMetadataPath(): string {
    return `/.well-known/oauth-protected-resource${this.app.pathname.replace(/\/$/u, '')}`;
  }

  /** Plays the principal approving at the server's sign-in page; returns the query sent to the redirect URI. */
  approve(authorizationUrl: string): { readonly redirectUri: string; readonly query: URLSearchParams } {
    const url = new URL(authorizationUrl);
    const parameters = url.searchParams;
    const clientId = parameters.get('client_id') ?? '';
    const redirectUri = parameters.get('redirect_uri') ?? '';
    const client = this.clients.get(clientId);
    if (
      url.origin + url.pathname !== this.serverMetadata.authorization_endpoint ||
      parameters.get('response_type') !== 'code' ||
      parameters.get('code_challenge_method') !== 'S256' ||
      !client?.redirectUris.includes(redirectUri)
    )
      throw new Error('The fake server would show an error page for this authorization request');
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, {
      clientId,
      challenge: parameters.get('code_challenge') ?? '',
      redirectUri,
      resource: parameters.get('resource'),
    });
    const query = new URLSearchParams({ code, state: parameters.get('state') ?? '' });
    if (this.issParameter) query.set('iss', String(this.serverMetadata.issuer));
    return { redirectUri, query };
  }

  async approveWithDocument(
    authorizationUrl: string,
  ): Promise<{ readonly redirectUri: string; readonly query: URLSearchParams }> {
    const clientId = new URL(authorizationUrl).searchParams.get('client_id') ?? '';
    if (!this.fetchClientDocument || !URL.canParse(clientId))
      throw new Error('The fake server takes no client document for this authorization request');
    const reply = await this.fetchClientDocument(clientId);
    const document = reply.body;
    if (
      reply.status !== 200 ||
      typeof document !== 'object' ||
      document === null ||
      Array.isArray(document) ||
      !('client_id' in document) ||
      document.client_id !== clientId ||
      !('token_endpoint_auth_method' in document) ||
      document.token_endpoint_auth_method !== 'none' ||
      !('redirect_uris' in document) ||
      !Array.isArray(document.redirect_uris)
    )
      throw new Error('The fake server would show an error page for this client document');
    this.documents.push(document as Record<string, unknown>);
    this.clients.set(clientId, { secret: undefined, redirectUris: document.redirect_uris.map(String) });
    return this.approve(authorizationUrl);
  }

  readonly handle: FakeHandler = (request) => {
    if (request.host === this.app.hostname) {
      if (request.method === 'POST' && request.path === this.app.pathname) return this.mcp(request);
      if (request.method === 'GET' && request.path === this.app.pathname) return { status: 405 };
      if (request.method === 'DELETE' && request.path === this.app.pathname) return { status: 204 };
      if (request.method === 'GET' && request.path === this.resourceMetadataPath)
        return { status: 200, body: this.resourceMetadata };
    }
    if (request.host !== this.issuer.hostname) return undefined;
    if (request.method === 'GET' && request.path === '/.well-known/oauth-authorization-server')
      return { status: 200, body: this.serverMetadata };
    if (request.method !== 'POST') return undefined;
    if (request.path === '/oauth/token') return this.token(request);
    if (request.path === '/oauth/register' && this.serverMetadata.registration_endpoint) return this.register(request);
    if (request.path === '/oauth/revoke' && this.serverMetadata.revocation_endpoint) {
      const form = new URLSearchParams(request.body);
      if (!this.authenticated(request, form)) return { status: 401, body: { error: 'invalid_client' } };
      const token = form.get('token') ?? '';
      this.revoked.push(token);
      this.refreshTokens.delete(token);
      return { status: 200 };
    }
    return undefined;
  };

  private async mcp(request: FakeRequest): Promise<FakeReply> {
    const overridden = await this.mcpOverride?.(request);
    if (overridden) return overridden;
    const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1];
    if (this.modern) return this.modernMcp(request, bearer);
    if (!this.allowUnauthenticated && (bearer === undefined || !this.accessTokens.has(bearer)))
      return {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${this.resourceMetadataUrl}"` },
        body: { error: 'invalid_token' },
      };
    let parsed: { id?: string | number; method?: string; params?: Record<string, unknown> } = {};
    if (request.body.trim()) {
      try {
        parsed = JSON.parse(request.body) as typeof parsed;
        /* eslint-disable-next-line no-catch-all/no-catch-all -- invalid JSON falls back to default initialize reply */
      } catch {
        parsed = {};
      }
    }
    const id = parsed.id ?? 1;
    switch (parsed.method) {
      case 'notifications/initialized':
        return { status: 202 };
      case 'tools/list':
        return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: this.tools } } };
      case 'tools/call': {
        const call = toolCallOf(parsed.params ?? {}, bearer);
        this.toolCalls.push(call);
        const custom = this.onToolCall?.(call);
        if (custom && 'status' in custom) return custom;
        return { status: 200, body: { jsonrpc: '2.0', id, result: custom ?? this.defaultResult(call) } };
      }
      case 'ping':
        return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
      default:
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: this.serverName, version: '1' },
              ...(this.instructions === undefined ? {} : { instructions: this.instructions }),
            },
          },
        };
    }
  }

  private defaultResult(call: RecordedToolCall): FakeToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: call.name, arguments: call.arguments }) }],
    };
  }

  /** Each string argument the tool's current definition mirrors into an `Mcp-Param-*` header must arrive there. */
  private paramHeadersMatch(request: FakeRequest, call: RecordedToolCall): boolean {
    const properties = this.tools.find((tool) => tool.name === call.name)?.inputSchema.properties ?? {};
    return Object.entries(properties).every(([key, schema]) => {
      const header = schema['x-mcp-header'];
      const value = call.arguments[key];
      if (typeof header !== 'string' || typeof value !== 'string') return true;
      return request.headers[`mcp-param-${header.toLowerCase()}`] === value;
    });
  }

  /** Discovery and listings are open; a tool call without a live token is refused with where to sign in. */
  private modernMcp(request: FakeRequest, bearer: string | undefined): FakeReply {
    const message = JSON.parse(request.body) as McpMessage;
    const { id, method } = message;
    const params = message.params ?? {};
    if (method === 'initialize')
      return rpcError(id, -32022, 'Unsupported protocol version', {
        supported: [MODERN_PROTOCOL],
        requested: params.protocolVersion,
      });
    if (id === undefined) return { status: 202 };
    if (request.headers['mcp-protocol-version'] !== MODERN_PROTOCOL || request.headers['mcp-method'] !== method)
      return rpcError(id, -32020, 'Header mismatch');
    const meta = params._meta;
    if (
      typeof meta !== 'object' ||
      meta === null ||
      !('io.modelcontextprotocol/protocolVersion' in meta) ||
      !('io.modelcontextprotocol/clientCapabilities' in meta)
    )
      return rpcError(id, -32602, 'Missing request metadata');
    const result = (value: Record<string, unknown>): FakeReply => ({
      status: 200,
      body: { jsonrpc: '2.0', id, result: { resultType: 'complete', ...value } },
    });
    switch (method) {
      case 'server/discover':
        return result({
          supportedVersions: [MODERN_PROTOCOL],
          capabilities: { tools: {} },
          ...(this.instructions === undefined ? {} : { instructions: this.instructions }),
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: this.serverName, version: '1' } },
        });
      case 'tools/list':
        return result({ tools: this.tools, ttlMs: 0, cacheScope: 'private' });
      case 'tools/call': {
        const call = toolCallOf(params, bearer);
        if (request.headers['mcp-name'] !== call.name || !this.paramHeadersMatch(request, call))
          return rpcError(id, -32020, 'Header mismatch');
        if (bearer === undefined || !this.accessTokens.has(bearer)) {
          const scopes = this.resourceMetadata.scopes_supported;
          const scope = Array.isArray(scopes) ? `, scope="${scopes.join(' ')}"` : '';
          return {
            status: 401,
            headers: { 'www-authenticate': `Bearer resource_metadata="${this.resourceMetadataUrl}"${scope}` },
            body: { error: 'invalid_token' },
          };
        }
        this.toolCalls.push(call);
        return result({ ...this.defaultResult(call) });
      }
      default:
        return rpcError(id, -32601, 'Method not found');
    }
  }

  private authenticated(request: FakeRequest, form: URLSearchParams): string | undefined {
    const basic = /^Basic (.+)$/u.exec(request.headers.authorization ?? '')?.[1];
    const [id, secret] = basic
      ? Buffer.from(basic, 'base64').toString('utf8').split(':')
      : [form.get('client_id') ?? '', form.get('client_secret') ?? undefined];
    const client = this.clients.get(id ?? '');
    return client && client.secret === secret ? id : undefined;
  }

  private issue(clientId: string): FakeReply {
    const access = `access-${randomBytes(12).toString('hex')}`;
    const refresh = `refresh-${randomBytes(12).toString('hex')}`;
    this.accessTokens.add(access);
    this.refreshTokens.set(refresh, clientId);
    return {
      status: 200,
      body: { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh },
    };
  }

  private token(request: FakeRequest): FakeReply {
    const form = new URLSearchParams(request.body);
    const clientId = this.authenticated(request, form);
    if (!clientId) return { status: 401, body: { error: 'invalid_client' } };
    if (form.get('resource') !== this.resource) return { status: 400, body: { error: 'invalid_target' } };
    if (form.get('grant_type') === 'authorization_code') {
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (
        !pending ||
        pending.clientId !== clientId ||
        pending.challenge !== challenge ||
        pending.redirectUri !== form.get('redirect_uri') ||
        pending.resource !== this.resource
      )
        return { status: 400, body: { error: 'invalid_grant' } };
      return this.issue(clientId);
    }
    if (form.get('grant_type') === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      if (this.refreshTokens.get(presented) !== clientId) return { status: 400, body: { error: 'invalid_grant' } };
      this.refreshTokens.delete(presented);
      return this.issue(clientId);
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }

  private register(request: FakeRequest): FakeReply {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    this.registrations.push(body);
    const id = `client-${randomBytes(6).toString('hex')}`;
    const secret = `secret-${randomBytes(12).toString('hex')}`;
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    this.clients.set(id, { secret, redirectUris });
    return {
      status: 201,
      body: { ...body, client_id: id, client_secret: secret, client_id_issued_at: Math.floor(Date.now() / 1000) },
    };
  }
}
