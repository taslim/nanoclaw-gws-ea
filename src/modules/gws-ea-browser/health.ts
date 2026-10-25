import type { BrowserRuntime } from './runtime.js';
import { BROWSER_POLICY_VERSIONS } from './policy.js';

/**
 * Host-only status includes the admitted debugger port, never its URL, browser identifier, credentials, cookies or
 * page text. `policyVersions` names the browser policy versions this host reads: the launcher writes a version-2
 * access list only to a host that reports it.
 */
export async function browserHealth(
  state: ReturnType<BrowserRuntime['state']>,
): Promise<{ schemaVersion: 1; policyVersions: readonly number[] } & ReturnType<BrowserRuntime['state']>> {
  return { schemaVersion: 1, policyVersions: BROWSER_POLICY_VERSIONS, ...state };
}
