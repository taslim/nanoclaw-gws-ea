/**
 * How an app's server signs in, learned by connecting without credentials. A 401 with protected-resource metadata
 * means OAuth, and a 401 without it means a pasted token. A 2025 server signs in from its handshake on, so a handshake
 * it answers means no sign-in. A 2026-07-28 server answers its discovery before sign-in, so a listing it refuses or
 * the protected-resource metadata it publishes decides.
 */
import {
  Client,
  extractWWWAuthenticateParams,
  StreamableHTTPClientTransport,
  type FetchLike,
  type Implementation,
} from '@modelcontextprotocol/client';

import { hasControlCharacters } from '../../gws-ea/validation.js';
import { EgressError, type PublicFetch } from '../gws-ea-egress/fetch.js';
import {
  ConnectionOAuthError,
  connectionFetches,
  readProtectedResource,
  signInServer,
  takesClientDocuments,
  type ConnectionOAuthOptions,
  type ProtectedResource,
  type SignInServer,
} from './oauth.js';
import { NAME_MAX } from './store.js';

export type SignInMethod =
  | { readonly kind: 'none' }
  | { readonly kind: 'token' }
  | {
      readonly kind: 'oauth';
      readonly issuer: string;
      /** The server registers clients itself, so the principal enters no client details. */
      readonly dynamicRegistration: boolean;
      readonly clientDocuments: boolean;
      /** How the token endpoint takes client credentials, `client_secret_basic` when the server names none. */
      readonly clientAuthMethods: readonly string[];
      readonly scope: string | undefined;
      readonly signIn: SignInServer;
    };

export type ProbeOutcome =
  | {
      readonly status: 'ok';
      readonly method: SignInMethod;
      /** The name a server without sign-in gave itself, when it is fit to show. */
      readonly advertisedName: string | undefined;
    }
  /** No answer this time, or the server's sign-in cannot be used. */
  | { readonly status: 'unreachable' | 'unsupported' };

export type TokenCheck = 'valid' | 'refused' | 'unreachable' | 'unsupported';

const ACCESS_TOKEN = /^[\x21-\x7e]+$/u;

/** What the requests met, since the client's errors keep neither the response nor the egress refusal. */
interface Observed {
  status: number | undefined;
  unauthorized: Response | undefined;
  egressError: EgressError | undefined;
}

type Exchange<T> =
  { readonly answered: true; readonly value: T } | { readonly answered: false; readonly observed: Observed };

/**
 * Connects, runs `use` and closes, through the public-only egress. The client offers the 2026-07-28 revision first
 * and falls back to the 2025 handshake, as the relay does.
 */
async function exchange<T>(
  appUrl: string,
  fetch: PublicFetch,
  token: string | undefined,
  use: (client: Client) => Promise<T>,
): Promise<Exchange<T>> {
  const observed: Observed = { status: undefined, unauthorized: undefined, egressError: undefined };
  const observing: FetchLike = async (input, init) => {
    // Never open the standalone event stream: a 405 tells the transport the server offers none.
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') return new Response(null, { status: 405 });
    const headers = new Headers(init?.headers);
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
    try {
      const response = await fetch(input, { ...init, headers });
      observed.status = response.status;
      if (response.status === 401) observed.unauthorized = response;
      return response;
    } catch (error) {
      if (error instanceof EgressError) observed.egressError = error;
      throw error;
    }
  };
  const client = new Client(
    { name: 'gws-ea-connections', version: '1' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(appUrl), { fetch: observing }));
    return { answered: true, value: await use(client) };
    /* eslint-disable-next-line no-catch-all/no-catch-all -- any failure to connect or list is classified by what the requests met */
  } catch {
    return { answered: false, observed };
  } finally {
    await client.close();
  }
}

function transientStatus(status: number | undefined): boolean {
  return status !== undefined && (status === 429 || status >= 500);
}

function advertisedName(info: Implementation | undefined): string | undefined {
  if (!info) return undefined;
  const value = info.title?.trim() ? info.title : info.name;
  const name = value.normalize('NFC').trim();
  return name && name.length <= NAME_MAX && !hasControlCharacters(name) ? name : undefined;
}

async function oauthFrom(
  resource: ProtectedResource,
  scope: string | undefined,
  options: ConnectionOAuthOptions,
): Promise<ProbeOutcome> {
  const signIn = await signInServer(resource, scope, options);
  const methods = signIn.server.tokenAuthMethods;
  return {
    status: 'ok',
    method: {
      kind: 'oauth',
      issuer: signIn.server.issuer,
      dynamicRegistration: signIn.server.registrationEndpoint !== undefined,
      clientDocuments: takesClientDocuments(signIn.server),
      clientAuthMethods: methods.length > 0 ? methods : ['client_secret_basic'],
      scope: signIn.scope,
      signIn,
    },
    advertisedName: undefined,
  };
}

async function signInDiscovery(run: () => Promise<ProbeOutcome>): Promise<ProbeOutcome> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectionOAuthError)
      return { status: error.code === 'unreachable' ? 'unreachable' : 'unsupported' };
    throw error;
  }
}

function unauthorized(appUrl: string, response: Response, options: ConnectionOAuthOptions): Promise<ProbeOutcome> {
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
  return signInDiscovery(async () => {
    const resource = await readProtectedResource(appUrl, { ...options, metadataUrl: resourceMetadataUrl });
    if (!resource) return { status: 'ok', method: { kind: 'token' }, advertisedName: undefined };
    return oauthFrom(resource, scope, options);
  });
}

function unanswered(appUrl: string, observed: Observed, options: ConnectionOAuthOptions): Promise<ProbeOutcome> {
  if (observed.egressError) return Promise.resolve({ status: 'unreachable' });
  if (observed.unauthorized) return unauthorized(appUrl, observed.unauthorized, options);
  return Promise.resolve({ status: transientStatus(observed.status) ? 'unreachable' : 'unsupported' });
}

/** Connects to an admitted URL without credentials, then reads the sign-in the server describes. */
export async function probeApp(appUrl: string, options: ConnectionOAuthOptions = {}): Promise<ProbeOutcome> {
  const scoped = { ...options, fetches: options.fetches ?? connectionFetches() };
  const connected = await exchange(appUrl, scoped.fetches.direct, undefined, async (client) => {
    const modern = client.getProtocolEra() === 'modern';
    if (modern) await client.listTools(undefined, { cacheMode: 'bypass' });
    return { name: advertisedName(client.getServerVersion()), modern };
  });
  if (!connected.answered) return unanswered(appUrl, connected.observed, scoped);
  const none: ProbeOutcome = { status: 'ok', method: { kind: 'none' }, advertisedName: connected.value.name };
  if (!connected.value.modern) return none;
  return signInDiscovery(async () => {
    const resource = await readProtectedResource(appUrl, scoped);
    return resource ? oauthFrom(resource, undefined, scoped) : none;
  });
}

/**
 * A pasted token is checked once, with the requests main would make: connecting, then listing the tools. Nothing is
 * stored unless the server takes it.
 */
export async function checkPastedToken(
  appUrl: string,
  token: string,
  options: Pick<ConnectionOAuthOptions, 'fetches'> = {},
): Promise<TokenCheck> {
  if (typeof token !== 'string' || !ACCESS_TOKEN.test(token)) return 'refused';
  const checked = await exchange(appUrl, (options.fetches ?? connectionFetches()).direct, token, (client) =>
    client.listTools(undefined, { cacheMode: 'bypass' }),
  );
  if (checked.answered) return 'valid';
  const { egressError, status } = checked.observed;
  if (egressError) return 'unreachable';
  if (status === 401 || status === 403) return 'refused';
  return transientStatus(status) ? 'unreachable' : 'unsupported';
}
