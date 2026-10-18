import { getBrowserRuntime } from './index.js';
import { BROWSER_POLICY_VERSIONS } from './policy.js';

/**
 * Host-only status contains no URLs, credentials, cookies, page text or debugging transport.
 * `policyVersions` names the browser policy versions this host reads: the launcher writes a
 * version-2 access list only to a host that reports it (KTD15).
 */
export async function browserHealth(): Promise<
  { schemaVersion: 1; policyVersions: readonly number[] } & ReturnType<ReturnType<typeof getBrowserRuntime>['state']>
> {
  const runtime = getBrowserRuntime();
  return { schemaVersion: 1, policyVersions: BROWSER_POLICY_VERSIONS, ...runtime.state() };
}
