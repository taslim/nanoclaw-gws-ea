/**
 * Access tokens minted from the assistant's grant, one per Google service and
 * limited to that service's scopes (KTD2). A token Google does not narrow is
 * refused rather than injected: a consented but unexposed service, Gmail in
 * this checkpoint, must stay out of every agent's reach.
 */
import type { GoogleGrant, GoogleService } from './grant.js';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Google refused the refresh token itself: the sign-in was revoked or expired, and only a new one helps. */
export class GoogleGrantRevokedError extends Error {
  readonly code = 'google_grant_revoked';
}

/** Google could not mint a token this time, or minted one wider than asked for. */
export class GoogleTokenError extends Error {
  readonly code = 'google_token_failed';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exchange the grant's refresh token for an access token limited to `service`'s scopes. */
export async function mintServiceToken(
  grant: GoogleGrant,
  service: GoogleService,
  options: TokenOptions = {},
): Promise<ServiceToken> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: grant.refresh_token,
    client_id: grant.client_id,
    client_secret: grant.client_secret,
    scope: service.scopes.join(' '),
  });
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const reason = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    if (reason === 'invalid_grant') {
      throw new GoogleGrantRevokedError("Google no longer accepts the assistant's sign-in; sign in again");
    }
    throw new GoogleTokenError(`Google refused a ${service.secretName} token (${reason})`);
  }
  if (
    !isRecord(payload) ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length === 0 ||
    typeof payload.expires_in !== 'number' ||
    !(payload.expires_in > 0) ||
    typeof payload.scope !== 'string'
  ) {
    throw new GoogleTokenError(`Google returned an unreadable ${service.secretName} token`);
  }
  const scopes = payload.scope.split(' ').filter(Boolean);
  const allowed = new Set(service.scopes);
  if (scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
    throw new GoogleTokenError(`Google did not limit the ${service.secretName} token to its scopes`);
  }
  return { accessToken: payload.access_token, expiresAt: now() + payload.expires_in * 1_000, scopes };
}
