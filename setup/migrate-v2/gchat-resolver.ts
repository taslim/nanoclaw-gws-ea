/**
 * GChat space → is_group resolver for the v1 → v2 migration. The bare space
 * id has no DM/group signal, so we classify via spaces.get under DWD
 * impersonation. Best-effort: returns null on any failure so the caller
 * falls back to inferIsGroup's default.
 */
import { google } from 'googleapis';

import { isDmSpace, loadServiceAccount } from '../../src/gws-paths.js';

export interface GchatResolver {
  /** 0 (DM), 1 (group/space), or null when the API call failed. */
  resolveIsGroup(spaceId: string): 0 | 1 | null;
  stats(): { dms: number; groups: number; reason?: string };
}

function emptyResolver(reason: string): GchatResolver {
  return {
    resolveIsGroup: () => null,
    stats: () => ({ dms: 0, groups: 0, reason }),
  };
}

/**
 * Probes spaces.get sequentially per id. Bails early if the very first call
 * fails — that's almost always a credentials/scope problem, no point burning
 * the rest. Subsequent per-space failures are logged but don't abort.
 */
export async function buildGchatResolver(
  saKeyPath: string | null | undefined,
  impersonateUser: string | null | undefined,
  spaceIds: string[],
): Promise<GchatResolver> {
  if (!saKeyPath) {
    return emptyResolver('SA key path not provided — set up GWS credentials before re-running migrate to classify GChat DMs');
  }
  if (!impersonateUser) {
    return emptyResolver('ASSISTANT_EMAIL not set — needed for DWD impersonation to call spaces.get');
  }
  let sa;
  try {
    sa = loadServiceAccount(saKeyPath);
  } catch (err) {
    return emptyResolver(`SA key unreadable: ${(err as Error).message}`);
  }
  if (!sa) {
    return emptyResolver(`SA key not found at ${saKeyPath}`);
  }

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/chat.spaces.readonly'],
    subject: impersonateUser,
  });
  const chatApi = google.chat({ version: 'v1', auth });

  const cache = new Map<string, 0 | 1>();
  let dms = 0;
  let groups = 0;

  const probe = async (spaceId: string): Promise<{ ok: true; isGroup: 0 | 1 } | { ok: false; reason: string }> => {
    try {
      const spaceName = spaceId.startsWith('spaces/') ? spaceId : `spaces/${spaceId}`;
      const res = await chatApi.spaces.get({ name: spaceName });
      return { ok: true, isGroup: isDmSpace(res.data) ? 0 : 1 };
    } catch (err) {
      return { ok: false, reason: ((err as Error).message ?? String(err)).split('\n')[0] };
    }
  };

  if (spaceIds.length === 0) return { resolveIsGroup: () => null, stats: () => ({ dms: 0, groups: 0 }) };

  const first = await probe(spaceIds[0]!);
  if (!first.ok) {
    return emptyResolver(`first spaces.get failed (${first.reason}) — falling back to is_group=1 for all GChat`);
  }
  cache.set(spaceIds[0]!, first.isGroup);
  if (first.isGroup === 0) dms++;
  else groups++;

  for (const spaceId of spaceIds.slice(1)) {
    const res = await probe(spaceId);
    if (!res.ok) {
      console.log(`WARN:gchat resolver: spaces.get failed for ${spaceId}: ${res.reason}`);
      continue;
    }
    cache.set(spaceId, res.isGroup);
    if (res.isGroup === 0) dms++;
    else groups++;
  }

  return {
    resolveIsGroup: (spaceId) => cache.get(spaceId) ?? null,
    stats: () => ({ dms, groups }),
  };
}
