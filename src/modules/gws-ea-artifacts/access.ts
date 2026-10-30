import type { IncomingMessage } from 'node:http';
import { getDb } from '../../db/connection.js';
import { readWebPolicy, webPolicyDigest, type WebPolicyFile } from '../gws-ea-web/policy.js';
import { createWebIdentity, isPrincipalWebIdentity, type WebIdentity } from '../gws-ea-web/access.js';
import type { ArtifactViewRoute, AuthorizedArtifactView } from './server.js';

export function createArtifactViewResolver(
  config: WebPolicyFile,
  identity: WebIdentity = createWebIdentity(config),
): (request: IncomingMessage, route: ArtifactViewRoute) => Promise<AuthorizedArtifactView | undefined> {
  return async (request, route) => {
    const policy = await readWebPolicy();
    if (policy.status !== 'enabled' || webPolicyDigest(policy.config) !== webPolicyDigest(config)) return undefined;
    let email: string | undefined;
    let principal = false;
    if (route.audience !== 'public') {
      email = await identity(request);
      if (!email) return undefined;
      principal = await isPrincipalWebIdentity(email);
      if (route.audience === 'private' && !principal) return undefined;
      const fresh = await readWebPolicy();
      if (fresh.status !== 'enabled' || webPolicyDigest(fresh.config) !== webPolicyDigest(config)) return undefined;
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
