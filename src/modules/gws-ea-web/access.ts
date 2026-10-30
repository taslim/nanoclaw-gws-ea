import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { normalizePrincipalEmail } from '../../gws-ea/validation.js';
import { listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { readWebPolicy, webPolicyDigest, type WebPolicyFile } from './policy.js';

export type WebIdentityVerifier = (token: string | undefined) => Promise<string | undefined>;
/** One configured key cache per running origin. Token headers cannot choose its key endpoint. */
export function createWebIdentityVerifier(
  issuer: string,
  audience: string,
  fetcher: typeof fetch = fetch,
): WebIdentityVerifier {
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    [customFetch]: fetcher,
    timeoutDuration: 5000,
  });
  return async (token) => {
    if (!token || token.length > 32 * 1024) return undefined;
    /* eslint-disable no-catch-all/no-catch-all -- all malformed or unverifiable identities deny this request */
    try {
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'],
        issuer,
        audience,
        requiredClaims: ['exp', 'email', 'iss', 'aud'],
      });
      return typeof payload.email === 'string' ? normalizePrincipalEmail(payload.email) : undefined;
    } catch {
      return undefined;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  };
}

export type WebIdentity = (request: IncomingMessage) => Promise<string | undefined>;

/** A verified identity belongs to the principal while its exact email remains recorded. */
export async function isPrincipalWebIdentity(email: string | undefined): Promise<boolean> {
  return email !== undefined && (await listPrincipalAddresses()).some((address) => address.email === email);
}

/** Identity alone grants no feature access. Policy must still match on both sides of verification. */
export function createWebIdentity(
  config: WebPolicyFile,
  verify: WebIdentityVerifier = createWebIdentityVerifier(config.accessIssuer, config.accessAud),
): WebIdentity {
  return async (request) => {
    const policy = await readWebPolicy();
    if (policy.status !== 'enabled' || webPolicyDigest(policy.config) !== webPolicyDigest(config)) return undefined;
    const assertion = request.headers['cf-access-jwt-assertion'];
    const email = await verify(typeof assertion === 'string' ? assertion : undefined);
    if (!email) return undefined;
    const fresh = await readWebPolicy();
    return fresh.status === 'enabled' && webPolicyDigest(fresh.config) === webPolicyDigest(config) ? email : undefined;
  };
}
