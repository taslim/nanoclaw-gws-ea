/**
 * Signing in to an app's server on the principal's behalf. The MCP SDK's client auth helpers carry the protocol:
 * protected-resource discovery, PKCE authorization URLs, registration, exchange and refresh with `resource`. This
 * module adds what they leave to the caller: the server must describe itself consistently, every endpoint is https
 * and off the assistant's own hostname, S256 is required, the authorization response's `iss` is checked, and
 * revocation is attempted.
 *
 * Every request goes through the public-only egress. Nothing a server says crosses this boundary: failures carry
 * only a code, so no URL, `error_description` or callback query can reach a log line or a page.
 */
import {
  buildDiscoveryUrls,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  selectClientAuthMethod,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';

import { isRecord } from '../../gws-ea/validation.js';
import { EgressError, publicFetch, type EgressDependencies, type PublicFetch } from '../gws-ea-egress/fetch.js';
import type { ClientRegistration, GrantCredentials } from './store.js';

/** The revision servers mostly implement today, sent on discovery and MCP requests. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

/** A token answer without `expires_in` is treated as lasting this long. */
export const ACCESS_LIFETIME_WITHOUT_EXPIRY_MS = 60 * 60_000;

export type ConnectionOAuthCode =
  /** No usable answer this time: the network, a timeout, a 429 or a 5xx. Worth asking again later. */
  | 'unreachable'
  /** The server's sign-in description is missing, malformed or unsafe to follow. */
  | 'unsupported'
  /** The protected resource names an address other than the app's. */
  | 'resource_mismatch'
  /** The protected resource now names a different authorization server than the one signed in with. */
  | 'issuer_changed'
  /** The authorization response's `iss` is wrong, or missing where the server promised it. */
  | 'issuer_mismatch'
  /** The server offers no automatic registration and no client details were entered. */
  | 'needs_client'
  /** The server refused the client: registration, `invalid_client` or `unauthorized_client`. */
  | 'client_refused'
  /** The server refused the code or the refresh token (`invalid_grant`). */
  | 'grant_refused'
  /** The principal declined at the server. */
  | 'cancelled'
  /** Any other definite refusal or malformed answer. */
  | 'failed';

export class ConnectionOAuthError extends Error {
  constructor(readonly code: ConnectionOAuthCode) {
    super(`OAuth ${code}`);
    this.name = 'ConnectionOAuthError';
  }
}

export interface ConnectionFetches {
  /** Discovery documents: JSON only, following a redirect only on the same host. */
  readonly metadata: PublicFetch;
  /** Token and registration endpoints: no redirect, and a successful answer must be JSON. */
  readonly token: PublicFetch;
  /** Revocation and MCP requests: no redirect. */
  readonly direct: PublicFetch;
}

export function connectionFetches(overrides: Partial<EgressDependencies> = {}): ConnectionFetches {
  return {
    metadata: publicFetch({ redirect: 'same-host', json: true }, overrides),
    token: publicFetch({ redirect: 'none', json: true }, overrides),
    direct: publicFetch({ redirect: 'none' }, overrides),
  };
}

export interface ConnectionOAuthOptions {
  readonly fetches?: ConnectionFetches;
  /** The assistant's own web hostname: no sign-in endpoint may sit on it. */
  readonly assistantHost?: string;
  readonly now?: () => number;
}

/** What an authorization server says about itself, after every check. */
export interface AuthorizationServer {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | undefined;
  readonly revocationEndpoint: string | undefined;
  /** As advertised; empty when the server named none, which RFC 8414 reads as `client_secret_basic`. */
  readonly tokenAuthMethods: readonly string[];
  readonly revocationAuthMethods: readonly string[];
  readonly issParameterSupported: boolean;
}

export interface ProtectedResource {
  readonly resource: string;
  readonly issuer: string;
  readonly scopes: readonly string[];
}

/** Everything a sign-in to one app needs from discovery. */
export interface SignInServer {
  /** The app's URL, sent as `resource` on every authorization and token request. */
  readonly resource: string;
  readonly scope: string | undefined;
  readonly server: AuthorizationServer;
}

export interface IssuedTokens {
  readonly accessToken: string;
  /** Present when the server issued a refresh token, or rotated the one it had issued. */
  readonly refreshToken?: string;
  readonly accessIssuedAt: string;
  readonly accessExpiresAt: string;
}

/** What a claimed sign-in holds for its return. */
export interface PendingAuthorization {
  readonly issuer: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly resource: string;
}

export interface PreparedAuthorization {
  readonly verifier: string;
  /** The server's sign-in page for this attempt; state is minted once the verifier is stored. */
  readonly authorizationUrl: (state: string) => string;
}

export type RevocationOutcome = 'revoked' | 'unsupported' | 'failed' | 'nothing';

type SdkMetadata = NonNullable<Parameters<typeof startAuthorization>[1]['metadata']>;
type SdkClient = Parameters<typeof startAuthorization>[1]['clientInformation'];
type SdkClientMetadata = Parameters<typeof registerClient>[1]['clientMetadata'];
type SdkTokens = Awaited<ReturnType<typeof exchangeAuthorization>>;

/** RFC 6749 client credentials and refresh tokens are visible ASCII. */
const VSCHAR = /^[\x20-\x7e]+$/u;
/** An access token travels in a header the gateway writes, so it may not hold spaces or control characters. */
const ACCESS_TOKEN = /^[\x21-\x7e]+$/u;

function fail(code: ConnectionOAuthCode): never {
  throw new ConnectionOAuthError(code);
}

export function appRedirectUri(webHostname: string, appHost: string): string {
  return `https://${webHostname}/connections/callback/${appHost}`;
}

export const CLIENT_DOCUMENT_PATH = '/oauth-client';

/**
 * A document client's ID is the address its metadata document is served from, so it changes only with the web
 * hostname: the app ID is opaque and survives renames, and the address never reveals which apps are connected.
 */
export function appClientDocumentUrl(webHostname: string, appId: string): string {
  return `https://${webHostname}${CLIENT_DOCUMENT_PATH}/${appId}`;
}

/** Counts whether any answer said to come back later, since the SDK's errors do not keep the status. */
interface Watched {
  readonly fetch: PublicFetch;
  readonly transient: () => boolean;
}
function watched(fetch: PublicFetch): Watched {
  let transient = false;
  return {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (response.status === 429 || response.status >= 500) transient = true;
      return response;
    },
    transient: () => transient,
  };
}

function oauthErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('errorCode' in error)) return undefined;
  return typeof error.errorCode === 'string' ? error.errorCode : undefined;
}

/** The SDK refuses with plain errors, and a malformed answer surfaces as a schema or JSON error. */
function malformedOrRefused(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && (error.constructor === Error || error.name === 'ZodError'))
  );
}

/** Only the code survives: the error's message may quote the server. */
function failure(error: unknown, watch: Watched | undefined, fallback: ConnectionOAuthCode): ConnectionOAuthError {
  if (error instanceof ConnectionOAuthError) return error;
  if (error instanceof EgressError)
    return new ConnectionOAuthError(error.code === 'refused' ? fallback : 'unreachable');
  if (watch?.transient()) return new ConnectionOAuthError('unreachable');
  const code = oauthErrorCode(error);
  if (code !== undefined) {
    if (code === 'temporarily_unavailable' || code === 'too_many_requests')
      return new ConnectionOAuthError('unreachable');
    if (code === 'invalid_grant') return new ConnectionOAuthError('grant_refused');
    if (code === 'invalid_client' || code === 'unauthorized_client' || code === 'invalid_client_metadata')
      return new ConnectionOAuthError('client_refused');
    return new ConnectionOAuthError(fallback);
  }
  if (malformedOrRefused(error)) return new ConnectionOAuthError(fallback);
  throw error;
}

async function guarded<T>(
  fallback: ConnectionOAuthCode,
  watch: Watched | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw failure(error, watch, fallback);
  }
}

function sameUrl(a: string, b: string): boolean {
  return URL.canParse(a) && URL.canParse(b) && new URL(a).href === new URL(b).href;
}

function onAssistantHost(url: URL, assistantHost: string | undefined): boolean {
  return assistantHost !== undefined && url.hostname.replace(/\.$/u, '') === assistantHost.toLowerCase();
}

function endpoint(value: unknown, assistantHost: string | undefined): string {
  if (typeof value !== 'string' || !URL.canParse(value)) return fail('unsupported');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || onAssistantHost(url, assistantHost))
    return fail('unsupported');
  return url.href;
}

/** RFC 8414 issuers are https URLs without a query or fragment. */
function issuerOf(value: unknown, assistantHost: string | undefined): string {
  const href = endpoint(value, assistantHost);
  return new URL(href).search ? fail('unsupported') : href;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function optionalEndpoint(value: unknown, assistantHost: string | undefined): string | undefined {
  return value === undefined ? undefined : endpoint(value, assistantHost);
}

function readServerMetadata(document: unknown, issuer: string, assistantHost: string | undefined): AuthorizationServer {
  if (!isRecord(document) || typeof document.issuer !== 'string' || !sameUrl(document.issuer, issuer))
    return fail('unsupported');
  if (!strings(document.response_types_supported).includes('code')) return fail('unsupported');
  if (!strings(document.code_challenge_methods_supported).includes('S256')) return fail('unsupported');
  return {
    issuer,
    authorizationEndpoint: endpoint(document.authorization_endpoint, assistantHost),
    tokenEndpoint: endpoint(document.token_endpoint, assistantHost),
    registrationEndpoint: optionalEndpoint(document.registration_endpoint, assistantHost),
    revocationEndpoint: optionalEndpoint(document.revocation_endpoint, assistantHost),
    tokenAuthMethods: strings(document.token_endpoint_auth_methods_supported),
    revocationAuthMethods: strings(document.revocation_endpoint_auth_methods_supported),
    issParameterSupported: document.authorization_response_iss_parameter_supported === true,
  };
}

/**
 * Reads the issuer's metadata in RFC 8414 and OpenID discovery order. Its `issuer` must be the one it was looked up
 * by, so one server cannot answer for another.
 */
export async function discoverAuthorizationServer(
  issuer: string,
  options: ConnectionOAuthOptions = {},
): Promise<AuthorizationServer> {
  const identifier = issuerOf(issuer, options.assistantHost);
  const watch = watched((options.fetches ?? connectionFetches()).metadata);
  for (const { url } of buildDiscoveryUrls(identifier)) {
    const response = await guarded('unsupported', watch, () =>
      watch.fetch(url, { headers: { accept: 'application/json', 'mcp-protocol-version': MCP_PROTOCOL_VERSION } }),
    );
    if (watch.transient()) return fail('unreachable');
    if (!response.ok) continue;
    const document: unknown = await guarded('unsupported', watch, () => response.json());
    return readServerMetadata(document, identifier, options.assistantHost);
  }
  return fail('unsupported');
}

/**
 * The app's protected-resource metadata, from the location its 401 named or the well-known one. Undefined when the
 * server publishes none. Its `resource` must be the app's URL.
 */
export async function readProtectedResource(
  appUrl: string,
  options: ConnectionOAuthOptions & { readonly metadataUrl?: URL } = {},
): Promise<ProtectedResource | undefined> {
  const watch = watched((options.fetches ?? connectionFetches()).metadata);
  let document: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>>;
  try {
    document = await discoverOAuthProtectedResourceMetadata(
      appUrl,
      { resourceMetadataUrl: options.metadataUrl, protocolVersion: MCP_PROTOCOL_VERSION },
      watch.fetch,
    );
  } catch (error) {
    // The SDK answers a missing document with a plain error, and a malformed one with a schema error.
    if (error instanceof EgressError || watch.transient() || (error instanceof Error && error.name === 'ZodError'))
      throw failure(error, watch, 'unsupported');
    if (error instanceof Error && error.constructor === Error) return undefined;
    throw error;
  }
  if (!sameUrl(document.resource, appUrl)) return fail('resource_mismatch');
  return {
    resource: appUrl,
    issuer: issuerOf(document.authorization_servers?.[0], options.assistantHost),
    scopes: strings(document.scopes_supported),
  };
}

/** The scope a 401 asked for, else every scope the resource lists, else none (the server's default). */
export async function signInServer(
  resource: ProtectedResource,
  scopeHint: string | undefined,
  options: ConnectionOAuthOptions = {},
): Promise<SignInServer> {
  const server = await discoverAuthorizationServer(resource.issuer, options);
  const scope = scopeHint || (resource.scopes.length > 0 ? resource.scopes.join(' ') : undefined);
  return { resource: resource.resource, scope, server };
}

function sdkMetadata(server: AuthorizationServer): SdkMetadata {
  return {
    issuer: server.issuer,
    authorization_endpoint: server.authorizationEndpoint,
    token_endpoint: server.tokenEndpoint,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...server.tokenAuthMethods],
    ...(server.registrationEndpoint === undefined ? {} : { registration_endpoint: server.registrationEndpoint }),
  };
}

function sdkClient(client: ClientRegistration): SdkClient {
  if (!VSCHAR.test(client.clientId) || (client.clientSecret !== undefined && !VSCHAR.test(client.clientSecret)))
    return fail('client_refused');
  return {
    client_id: client.clientId,
    ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
    ...(client.tokenEndpointAuthMethod === undefined
      ? {}
      : { token_endpoint_auth_method: client.tokenEndpointAuthMethod }),
  };
}

/** A confidential client when the server allows one: the host can keep a secret. */
function registrationAuthMethod(server: AuthorizationServer): string {
  const methods = server.tokenAuthMethods.length > 0 ? server.tokenAuthMethods : ['client_secret_basic'];
  if (methods.includes('client_secret_basic')) return 'client_secret_basic';
  if (methods.includes('client_secret_post')) return 'client_secret_post';
  return 'none';
}

/**
 * The client this app signs in with: the details the principal entered for this issuer, else a registration made
 * now for this app alone, else the principal must enter details. A client is never borrowed from another app, even
 * one on the same authorization server; `registered` asks the caller to store the new one.
 */
export async function clientForSignIn(
  signIn: SignInServer,
  stored: { readonly issuer: string | null; readonly client: ClientRegistration | undefined },
  app: { readonly host: string; readonly redirectUri: string },
  options: ConnectionOAuthOptions = {},
): Promise<{ readonly client: ClientRegistration; readonly registered: boolean }> {
  if (stored.client && stored.issuer !== null && sameUrl(stored.issuer, signIn.server.issuer))
    return { client: stored.client, registered: false };
  if (signIn.server.registrationEndpoint === undefined) return fail('needs_client');
  const method = registrationAuthMethod(signIn.server);
  // `application_type` is standard registration metadata the SDK's type does not list.
  const clientMetadata: SdkClientMetadata & { readonly application_type: 'web' } = {
    redirect_uris: [app.redirectUri],
    client_name: `Assistant access to ${app.host}`,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    application_type: 'web',
  };
  const watch = watched((options.fetches ?? connectionFetches()).token);
  const registered = await guarded('client_refused', watch, () =>
    registerClient(signIn.server.issuer, {
      metadata: sdkMetadata(signIn.server),
      clientMetadata,
      scope: signIn.scope,
      fetchFn: watch.fetch,
    }),
  );
  const client: ClientRegistration = {
    clientId: registered.client_id,
    ...(registered.client_secret === undefined ? {} : { clientSecret: registered.client_secret }),
    tokenEndpointAuthMethod: registered.token_endpoint_auth_method ?? method,
  };
  sdkClient(client);
  return { client, registered: true };
}

/** PKCE S256 with the app's URL as `resource`, the chosen scope and this app's redirect URI. */
export async function prepareAuthorization(
  signIn: SignInServer,
  client: ClientRegistration,
  redirectUri: string,
): Promise<PreparedAuthorization> {
  const information = sdkClient(client);
  const { authorizationUrl, codeVerifier } = await guarded('unsupported', undefined, () =>
    startAuthorization(signIn.server.issuer, {
      metadata: sdkMetadata(signIn.server),
      clientInformation: information,
      redirectUrl: redirectUri,
      scope: signIn.scope,
      resource: signIn.resource,
    }),
  );
  return {
    verifier: codeVerifier,
    authorizationUrl: (state) => {
      const url = new URL(authorizationUrl);
      url.searchParams.set('state', state);
      return url.href;
    },
  };
}

function issued(tokens: SdkTokens, previousRefreshToken: string | undefined, now: number): IssuedTokens {
  if (tokens.token_type.toLowerCase() !== 'bearer' || !ACCESS_TOKEN.test(tokens.access_token)) return fail('failed');
  const refreshToken =
    tokens.refresh_token !== undefined && tokens.refresh_token !== previousRefreshToken
      ? tokens.refresh_token
      : undefined;
  if (refreshToken !== undefined && !VSCHAR.test(refreshToken)) return fail('failed');
  const seconds = tokens.expires_in;
  const lifetime =
    seconds !== undefined && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : ACCESS_LIFETIME_WITHOUT_EXPIRY_MS;
  return {
    accessToken: tokens.access_token,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    accessIssuedAt: new Date(now).toISOString(),
    accessExpiresAt: new Date(now + lifetime).toISOString(),
  };
}

function single(returned: URLSearchParams, name: string): string | undefined | null {
  const values = returned.getAll(name);
  if (values.length > 1) return null;
  return values[0];
}

/**
 * The server's answer at the redirect URI. A refusal is read from its `error` code alone; a code is exchanged only
 * after `iss` names the issuer the sign-in started with (RFC 9207), or is absent from a server that never promised
 * it.
 */
export async function completeAuthorization(
  returned: URLSearchParams,
  pending: PendingAuthorization,
  client: ClientRegistration,
  options: ConnectionOAuthOptions = {},
): Promise<IssuedTokens> {
  const error = single(returned, 'error');
  if (error !== undefined) {
    if (error === 'access_denied') return fail('cancelled');
    return fail(error === 'unauthorized_client' ? 'client_refused' : 'failed');
  }
  const code = single(returned, 'code');
  if (!code) return fail('failed');
  const iss = single(returned, 'iss');
  if (iss === null || (iss !== undefined && !sameUrl(iss, pending.issuer))) return fail('issuer_mismatch');
  const server = await discoverAuthorizationServer(pending.issuer, options);
  if (iss === undefined && server.issParameterSupported) return fail('issuer_mismatch');
  const information = sdkClient(client);
  const watch = watched((options.fetches ?? connectionFetches()).token);
  const tokens = await guarded('failed', watch, () =>
    exchangeAuthorization(server.issuer, {
      metadata: sdkMetadata(server),
      clientInformation: information,
      authorizationCode: code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      fetchFn: watch.fetch,
    }),
  );
  return issued(tokens, undefined, (options.now ?? Date.now)());
}

/**
 * Renews an access token. The app must still describe the same resource and authorization server; a server that
 * publishes no resource metadata is renewed with the issuer it signed in with. Once `signal` is aborted no token
 * request starts; one already sent is left to finish, since the server may have rotated the refresh token.
 */
export async function refreshAccess(
  app: { readonly url: string; readonly issuer: string },
  grant: { readonly refreshToken: string; readonly client: ClientRegistration | undefined },
  options: ConnectionOAuthOptions & { readonly signal?: AbortSignal } = {},
): Promise<IssuedTokens> {
  if (!grant.client) return fail('client_refused');
  const resource = await readProtectedResource(app.url, options);
  if (resource && !sameUrl(resource.issuer, app.issuer)) return fail('issuer_changed');
  const server = await discoverAuthorizationServer(app.issuer, options);
  const information = sdkClient(grant.client);
  const watch = watched((options.fetches ?? connectionFetches()).token);
  options.signal?.throwIfAborted();
  const tokens = await guarded('failed', watch, () =>
    refreshAuthorization(server.issuer, {
      metadata: sdkMetadata(server),
      clientInformation: information,
      refreshToken: grant.refreshToken,
      resource: app.url,
      fetchFn: watch.fetch,
    }),
  );
  return issued(tokens, grant.refreshToken, (options.now ?? Date.now)());
}

function revocationRequest(
  server: AuthorizationServer,
  client: ClientRegistration,
  refreshToken: string,
): { readonly headers: Headers; readonly body: URLSearchParams } {
  const information = sdkClient(client);
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  const body = new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token' });
  const methods = server.revocationAuthMethods.length > 0 ? server.revocationAuthMethods : server.tokenAuthMethods;
  const method = selectClientAuthMethod(information, [...methods]);
  if (method === 'client_secret_basic' && client.clientSecret !== undefined) {
    headers.set(
      'authorization',
      `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`,
    );
  } else {
    body.set('client_id', client.clientId);
    if (method === 'client_secret_post' && client.clientSecret !== undefined)
      body.set('client_secret', client.clientSecret);
  }
  return { headers, body };
}

/**
 * Best-effort RFC 7009 revocation of an ended grant's refresh token, which also ends the access tokens it issued.
 * Never throws for anything the server or the network does: a server that refuses must not stop a disconnect.
 */
export async function revokeGrant(
  issuer: string | null,
  released: GrantCredentials | undefined,
  options: ConnectionOAuthOptions = {},
): Promise<RevocationOutcome> {
  if (released?.kind !== 'oauth' || !released.refreshToken || !released.client || issuer === null) return 'nothing';
  const { refreshToken, client } = released;
  try {
    const server = await discoverAuthorizationServer(issuer, options);
    if (server.revocationEndpoint === undefined) return 'unsupported';
    const { headers, body } = revocationRequest(server, client, refreshToken);
    const response = await (options.fetches ?? connectionFetches()).direct(server.revocationEndpoint, {
      method: 'POST',
      headers,
      body,
    });
    return response.ok ? 'revoked' : 'failed';
  } catch (error) {
    if (error instanceof ConnectionOAuthError || error instanceof EgressError) return 'failed';
    throw error;
  }
}
