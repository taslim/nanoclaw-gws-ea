import type { BrowserRuntime } from './runtime.js';
import { BROWSER_POLICY_VERSIONS } from './policy.js';

/**
 * Host-only status contains no URLs, credentials, cookies, page text or debugging transport.
 * `policyVersions` names the browser policy versions this host reads: the launcher writes a
 * version-2 access list only to a host that reports it (KTD15).
 */
export async function browserHealth(
  state: ReturnType<BrowserRuntime['state']>,
): Promise<{ schemaVersion: 1; policyVersions: readonly number[] } & ReturnType<BrowserRuntime['state']>> {
  return { schemaVersion: 1, policyVersions: BROWSER_POLICY_VERSIONS, ...state };
}
