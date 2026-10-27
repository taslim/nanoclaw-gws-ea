import { getDb } from '../../db/connection.js';
import type { BrowserRuntime } from './runtime.js';

/** Host-only listener facts never include endpoints, browser IDs, page text or credentials. */
export async function browserHealth(
  state: ReturnType<BrowserRuntime['state']>,
): Promise<{ schemaVersion: 1; credentialAttempts: number } & ReturnType<BrowserRuntime['state']>> {
  const db = getDb();
  const credentialAttempts = (await db.hasTable('gws_ea_browser_credential_attempts'))
    ? ((
        await db.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM gws_ea_browser_credential_attempts WHERE phase NOT IN ('rejected','finalized')",
        )
      )?.count ?? 0)
    : 0;
  return { schemaVersion: 1, ...state, credentialAttempts };
}
