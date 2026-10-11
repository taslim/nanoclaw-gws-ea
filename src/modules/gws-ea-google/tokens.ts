/**
 * Access tokens minted from the assistant's grant (KTD1, KTD2, KTD6): one per
 * host-only service, and one per agent credential, each limited to exactly
 * the scopes it wants that the grant holds. A token Google does not narrow
 * is refused rather than used: the inbox-modifying Gmail scope, in
 * particular, must stay out of every agent's reach.
 */
import { isRecord } from '../../gws-ea/validation.js';
import {
  credentialScopes,
  GOOGLE_SERVICES,
  googleGrantIdentity,
  grantedScopes,
  scopesOfGrant,
  type AgentGoogleCredential,
  type GoogleGrant,
  type GoogleServiceId,
  type HostGoogleServiceId,
} from './grant.js';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Renew a token this long before Google expires it. */
export const RENEW_BEFORE_EXPIRY_MS = 15 * 60_000;

/** Google refused the refresh token itself: the sign-in was revoked or expired, and only a new one helps. */
export class GoogleGrantRevokedError extends Error {
  readonly code = 'google_grant_revoked';
}

/** Google could not mint a token this time, or minted one other than asked for. */
export class GoogleTokenError extends Error {
  readonly code = 'google_token_failed';

  constructor(
    message: string,
    /** Google's OAuth error, the HTTP status, or what was wrong with the token. */
    readonly reason: string,
    /**
     * Google's answer is final for these scopes: a 4xx naming an OAuth error
     * other than a revoked grant, or a token not limited to exactly them.
     * Anything else (429, 5xx, an unreadable answer) is worth asking again.
     */
    readonly refused: boolean,
  ) {
    super(message);
  }
}

/** The grant holds none of a service's scopes, so Google was not asked: only a new sign-in grants them. */
export class GoogleScopeNotGrantedError extends Error {
  readonly code = 'google_scope_not_granted';

  constructor(readonly service: GoogleServiceId) {
    super(`The assistant's Google sign-in does not grant ${service}'s scopes`);
  }
}

export interface ServiceToken {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

export interface TokenOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

/**
 * Exchange the refresh token of the consent that granted `scopes` for an
 * access token limited to exactly them; `label` names it in errors.
 */
async function mintToken(
  grant: GoogleGrant,
  label: string,
  scopes: readonly string[],
  options: TokenOptions,
): Promise<ServiceToken> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const consent = grant.consents.find((candidate) => scopes.every((scope) => candidate.scopes.includes(scope)));
  if (!consent) {
    throw new GoogleTokenError(
      `No one consent of the assistant's sign-in granted every ${label} scope`,
      'its scopes span consents',
      true,
    );
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: consent.refresh_token,
    client_id: grant.client_id,
    client_secret: grant.client_secret,
    scope: scopes.join(' '),
  });
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isRecord(payload) && typeof payload.error === 'string' ? payload.error : undefined;
    if (error === 'invalid_grant') {
      throw new GoogleGrantRevokedError("Google no longer accepts the assistant's sign-in; sign in again");
    }
    const reason = error ?? `HTTP ${response.status}`;
    const refused = error !== undefined && response.status >= 400 && response.status < 500 && response.status !== 429;
    throw new GoogleTokenError(`Google refused a ${label} token (${reason})`, reason, refused);
  }
  if (
    !isRecord(payload) ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length === 0 ||
    typeof payload.expires_in !== 'number' ||
    !(payload.expires_in > 0) ||
    typeof payload.scope !== 'string'
  ) {
    throw new GoogleTokenError(`Google returned an unreadable ${label} token`, 'an unreadable token', false);
  }
  const minted = [...new Set(payload.scope.split(' ').filter(Boolean))];
  if (minted.length !== scopes.length || !scopes.every((scope) => minted.includes(scope))) {
    throw new GoogleTokenError(
      `Google did not limit the ${label} token to exactly its scopes`,
      'the token carried other scopes',
      true,
    );
  }
  return { accessToken: payload.access_token, expiresAt: now() + payload.expires_in * 1_000, scopes: minted };
}

/**
 * A token for one service, limited to exactly the scopes of its that the
 * grant holds. When it holds none, Google is not asked.
 */
export async function mintServiceToken(
  grant: GoogleGrant,
  service: GoogleServiceId,
  options: TokenOptions = {},
): Promise<ServiceToken> {
  const scopes = grantedScopes(GOOGLE_SERVICES[service].scopes, scopesOfGrant(grant));
  if (scopes.length === 0) throw new GoogleScopeNotGrantedError(service);
  return mintToken(grant, service, scopes, options);
}

/** Why a credential's token carries its first service's scopes alone. */
export interface CredentialFallback {
  /** The scopes Google refused. */
  readonly refused: readonly string[];
  /** Google's reason for refusing them. */
  readonly reason: string;
}

export interface CredentialToken extends ServiceToken {
  readonly fallback?: CredentialFallback;
}

export interface CredentialTokenOptions extends TokenOptions {
  /** Whether a final refusal of the full scopes falls back to the first service's; on unless turned off. */
  readonly fallBack?: boolean;
}

/**
 * The token an agent credential publishes (KTD1): its scopes the grant
 * holds, or undefined when it holds none. When Google gives a final refusal
 * for a credential serving more than one service, the token carries its
 * first service's scopes alone, so Calendar keeps working when Google
 * refuses Drive. A revoked grant and a failure worth retrying are thrown as
 * they are: a brief outage never cuts a service off.
 */
export async function mintCredentialToken(
  grant: GoogleGrant,
  credential: AgentGoogleCredential,
  options: CredentialTokenOptions = {},
): Promise<CredentialToken | undefined> {
  const scopes = credentialScopes(credential, scopesOfGrant(grant));
  if (scopes.length === 0) return undefined;
  try {
    return await mintToken(grant, credential.host, scopes, options);
  } catch (error) {
    const first = credential.services.slice(0, 1);
    if (!(error instanceof GoogleTokenError) || !error.refused || options.fallBack === false) throw error;
    const kept = credentialScopes({ ...credential, services: first }, scopesOfGrant(grant));
    const refused = scopes.filter((scope) => !kept.includes(scope));
    if (kept.length === 0 || refused.length === 0) throw error;
    const token = await mintToken(grant, credential.host, kept, options);
    return { ...token, fallback: { refused, reason: error.reason } };
  }
}

export interface HostTokenSourceOptions extends TokenOptions {
  /** The current grant, or undefined before the assistant has signed in. */
  readonly readGrant: () => Promise<GoogleGrant | undefined>;
}

/** Tokens for the host-only services, held only in this process's memory. */
export interface HostTokenSource {
  /** A live token for a host-only service. */
  accessToken(service: HostGoogleServiceId): Promise<string>;
}

/**
 * The host's own tokens (KTD5, KTD6), minted from the grant on demand. It
 * needs nothing but the grant, so a channel that starts before the host's
 * modules has its token, whatever the gateway stores. A token is kept until
 * it is close to expiry, and a new sign-in replaces every token. A revoked
 * sign-in is not asked again until a new one is written; any other failure
 * is asked again on the next call.
 */
export function createHostTokenSource(options: HostTokenSourceOptions): HostTokenSource {
  const now = options.now ?? Date.now;
  const tokenOptions: TokenOptions = { ...(options.fetch ? { fetch: options.fetch } : {}), now };
  const held = new Map<HostGoogleServiceId, { identity: string; token: ServiceToken }>();
  const minting = new Map<HostGoogleServiceId, Promise<string>>();
  let revoked: string | undefined;

  async function mint(service: HostGoogleServiceId): Promise<string> {
    const grant = await options.readGrant();
    if (!grant) throw new Error('The assistant is not signed in to Google yet');
    const identity = googleGrantIdentity(grant);
    if (revoked === identity) {
      throw new GoogleGrantRevokedError("Google no longer accepts the assistant's sign-in; sign in again");
    }
    const current = held.get(service);
    if (current && current.identity === identity && current.token.expiresAt - now() > RENEW_BEFORE_EXPIRY_MS) {
      return current.token.accessToken;
    }
    try {
      const token = await mintServiceToken(grant, service, tokenOptions);
      held.set(service, { identity, token });
      return token.accessToken;
    } catch (error) {
      if (error instanceof GoogleGrantRevokedError) revoked = identity;
      throw error;
    }
  }

  return {
    accessToken(service) {
      // Callers asking at once share one mint.
      const pending = minting.get(service);
      if (pending) return pending;
      const minted = mint(service).finally(() => minting.delete(service));
      minting.set(service, minted);
      return minted;
    },
  };
}
