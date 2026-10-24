import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { getDb } from '../../db/connection.js';
import { normalizePrincipalEmail } from '../../gws-ea/validation.js';
import { listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { artifactDigest } from './db.js';
import { readArtifactsPolicy, type ArtifactsPolicyFile } from './policy.js';
import type { ArtifactViewRoute, AuthorizedArtifactView } from './server.js';

export type ArtifactIdentityVerifier = (token: string | undefined) => Promise<string | undefined>;
/** One configured key cache per running origin. Token headers cannot choose its key endpoint. */
export function createArtifactIdentityVerifier(
  issuer: string,
  audience: string,
  fetcher: typeof fetch = fetch,
): ArtifactIdentityVerifier {
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
/** The origin checks live local authority on every wrapper, child and HEAD request. */
export function createArtifactViewResolver(
  config: ArtifactsPolicyFile,
  verify: ArtifactIdentityVerifier = createArtifactIdentityVerifier(config.accessIssuer, config.accessAud),
): (request: IncomingMessage, route: ArtifactViewRoute) => Promise<AuthorizedArtifactView | undefined> {
  return async (request, route) => {
    const policy = await readArtifactsPolicy();
    if (policy.status !== 'enabled' || artifactDigest(policy.config) !== artifactDigest(config)) return undefined;
    let email: string | undefined;
    let principal = false;
    if (route.audience !== 'public') {
      const assertion = request.headers['cf-access-jwt-assertion'];
      email = await verify(typeof assertion === 'string' ? assertion : undefined);
      if (!email) return undefined;
      principal = (await listPrincipalAddresses()).some((address) => address.email === email);
      if (route.audience === 'private' && !principal) return undefined;
      const fresh = await readArtifactsPolicy();
      if (fresh.status !== 'enabled' || artifactDigest(fresh.config) !== artifactDigest(config)) return undefined;
    }
    const now = new Date().toISOString();
    if (route.audience === 'private') {
      return getDb().get<AuthorizedArtifactView>(
        `SELECT r.title,r.html,r.source_hash AS sourceHash FROM gws_ea_artifacts a JOIN gws_ea_artifact_revisions r ON r.artifact_id=a.artifact_id AND r.revision=a.head_revision WHERE a.artifact_id=? AND a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?)`,
        route.id,
        now,
      );
    }
    return getDb().get<AuthorizedArtifactView>(
      `SELECT r.title,r.html,r.source_hash AS sourceHash FROM gws_ea_artifact_shares s JOIN gws_ea_artifacts a ON a.artifact_id=s.artifact_id JOIN gws_ea_artifact_revisions r ON r.artifact_id=s.artifact_id AND r.revision=s.revision AND r.source_hash=s.source_hash WHERE s.share_id=? AND s.kind=? AND s.state='active' AND a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?) AND (s.expires_at IS NULL OR s.expires_at>?)${route.audience === 'share' && !principal ? ' AND EXISTS(SELECT 1 FROM gws_ea_artifact_share_recipients g WHERE g.share_id=s.share_id AND g.email=?)' : ''}`,
      route.id,
      route.audience === 'public' ? 'public' : 'named',
      now,
      now,
      ...(route.audience === 'share' && !principal ? [email ?? ''] : []),
    );
  };
}
