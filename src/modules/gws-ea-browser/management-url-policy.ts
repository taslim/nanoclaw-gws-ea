import path from 'node:path';

import { envValue } from '../../env.js';
import { resolveControlPlanePaths } from '../../gws-ea/paths.js';
import { readRegistry } from '../../gws-ea/registry.js';
import { readWebOperatorConfig } from '../../gws-ea/web-cloudflare.js';
import { readWebPolicy } from '../gws-ea-web/policy.js';

function normalizedLoginMount(candidate: string): boolean {
  const slashes = candidate.replaceAll('\\', '/').split(/[?#]/u, 1)[0].toLowerCase();
  return [slashes, path.posix.normalize(slashes)].some((route) => /^\/+logins(?:\/|$)/u.test(route));
}

function loginMount(pathname: string): boolean {
  let candidate = pathname;
  for (let depth = 0; depth < 4; depth++) {
    // Check each representation: a proxy may decode separators or dot segments before routing.
    if (normalizedLoginMount(candidate)) return true;
    const decoded = candidate.replace(/%([a-f\d]{2})/giu, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  // Deeper escaping stays a candidate on protected hosts, without unbounded synchronous decoding.
  return normalizedLoginMount(candidate) || /%[a-f\d]{2}/iu.test(candidate);
}

/** Managed Chrome may carry the principal's Access cookies, so no target may reach this private mount. */
export async function blocksManagedLogins(rawUrl: string): Promise<boolean> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !loginMount(url.pathname)) return false;
  try {
    const configRoot = process.env.GWS_EA_CONFIG_ROOT?.trim() || envValue('GWS_EA_CONFIG_ROOT')?.trim();
    if (configRoot && !path.isAbsolute(configRoot)) return true;
    const policy = await readWebPolicy();
    if (policy.status === 'unavailable') return true;
    const [registry, operator] = await Promise.all([
      readRegistry(resolveControlPlanePaths({ configRoot })),
      policy.config ? readWebOperatorConfig(policy.config.cloudflare.operatorConfigFile) : undefined,
    ]);
    // A completed uninstall retains a disabled policy after removing shared operator metadata.
    if (policy.enabled && !operator) return true;
    const hostname = url.hostname.toLowerCase().replace(/\.+$/u, '');
    return (
      policy.config?.hostname === hostname ||
      Object.values(registry.instances).some(
        (instance) => instance.exclusive_resource_claims.web?.hostname === hostname,
      ) ||
      Object.values(operator?.assistants ?? {}).some((assistant) => assistant.claim.hostname === hostname)
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- Invalid host authority cannot authorize a private-mount request.
  } catch (_error) {
    return true;
  }
}
