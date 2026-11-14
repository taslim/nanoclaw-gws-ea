/**
 * How an app's server signs in, learned from one unauthenticated MCP request: an answer means no sign-in, a 401
 * with protected-resource metadata means OAuth, and a 401 without it means a pasted token.
 */
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';

import { hasControlCharacters, isRecord } from '../../gws-ea/validation.js';
import { EgressError } from '../gws-ea-egress/fetch.js';
import {
  ConnectionOAuthError,
  connectionFetches,
  MCP_PROTOCOL_VERSION,
  readProtectedResource,
  signInServer,
  type ConnectionOAuthOptions,
  type SignInServer,
} from './oauth.js';

export type SignInMethod =
  | { readonly kind: 'none' }
  | { readonly kind: 'token' }
  | {
      readonly kind: 'oauth';
      readonly issuer: string;
      /** The server registers clients itself, so the principal enters no client details. */
      readonly dynamicRegistration: boolean;
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

const NAME_MAX = 100;
const ACCESS_TOKEN = /^[\x21-\x7e]+$/u;
const INITIALIZE_ID = 1;

function initializeRequest(token?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'gws-ea-connections', version: '1' },
      },
    }),
  };
}

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Each event's data lines, joined as the event-stream format defines. */
function eventData(text: string): string[] {
  return text.split(/\r?\n\r?\n/u).flatMap((event) => {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /u, ''));
    return data.length > 0 ? [data.join('\n')] : [];
  });
}

async function initializeResult(response: Response): Promise<Record<string, unknown> | undefined> {
  const text = await response.text();
  const streamed = /^text\/event-stream/iu.test(response.headers.get('content-type') ?? '');
  for (const message of streamed ? eventData(text) : [text]) {
    const value = parsedJson(message);
    if (isRecord(value) && value.jsonrpc === '2.0' && value.id === INITIALIZE_ID && isRecord(value.result))
      return value.result;
  }
  return undefined;
}

function advertisedName(result: Record<string, unknown>): string | undefined {
  const info = result.serverInfo;
  if (!isRecord(info)) return undefined;
  const value = typeof info.title === 'string' && info.title.trim() ? info.title : info.name;
  if (typeof value !== 'string') return undefined;
  const name = value.normalize('NFC').trim();
  return name && name.length <= NAME_MAX && !hasControlCharacters(name) ? name : undefined;
}

async function unauthorized(
  appUrl: string,
  response: Response,
  options: ConnectionOAuthOptions,
): Promise<ProbeOutcome> {
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
  try {
    const resource = await readProtectedResource(appUrl, { ...options, metadataUrl: resourceMetadataUrl });
    if (!resource) return { status: 'ok', method: { kind: 'token' }, advertisedName: undefined };
    const signIn = await signInServer(resource, scope, options);
    const methods = signIn.server.tokenAuthMethods;
    return {
      status: 'ok',
      method: {
        kind: 'oauth',
        issuer: signIn.server.issuer,
        dynamicRegistration: signIn.server.registrationEndpoint !== undefined,
        clientAuthMethods: methods.length > 0 ? methods : ['client_secret_basic'],
        scope: signIn.scope,
        signIn,
      },
      advertisedName: undefined,
    };
  } catch (error) {
    if (error instanceof ConnectionOAuthError)
      return { status: error.code === 'unreachable' ? 'unreachable' : 'unsupported' };
    throw error;
  }
}

/** One unauthenticated MCP request to an admitted URL, then discovery when the server asks for OAuth. */
export async function probeApp(appUrl: string, options: ConnectionOAuthOptions = {}): Promise<ProbeOutcome> {
  const scoped = { ...options, fetches: options.fetches ?? connectionFetches() };
  let response: Response;
  try {
    response = await scoped.fetches.direct(appUrl, initializeRequest());
  } catch (error) {
    if (error instanceof EgressError) return { status: 'unreachable' };
    throw error;
  }
  if (response.ok) {
    const result = await initializeResult(response);
    return result
      ? { status: 'ok', method: { kind: 'none' }, advertisedName: advertisedName(result) }
      : { status: 'unsupported' };
  }
  if (response.status === 401) return unauthorized(appUrl, response, scoped);
  return { status: response.status === 429 || response.status >= 500 ? 'unreachable' : 'unsupported' };
}

/** A pasted token is checked once, with the request main would make; nothing is stored unless the server takes it. */
export async function checkPastedToken(
  appUrl: string,
  token: string,
  options: Pick<ConnectionOAuthOptions, 'fetches'> = {},
): Promise<TokenCheck> {
  if (typeof token !== 'string' || !ACCESS_TOKEN.test(token)) return 'refused';
  let response: Response;
  try {
    response = await (options.fetches ?? connectionFetches()).direct(appUrl, initializeRequest(token));
  } catch (error) {
    if (error instanceof EgressError) return 'unreachable';
    throw error;
  }
  if (response.ok) return (await initializeResult(response)) ? 'valid' : 'unsupported';
  if (response.status === 401 || response.status === 403) return 'refused';
  return response.status === 429 || response.status >= 500 ? 'unreachable' : 'unsupported';
}
