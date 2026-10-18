import path from 'node:path';

import { readEnvFile } from '../../env.js';
import { browserPaths, readPrivateFile, type BrowserPaths } from './paths.js';

export const BROWSER_POLICY_FILE_ENV = 'GWS_EA_BROWSER_POLICY_FILE';
export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/**
 * The policy versions this host reads (KTD15): version 1 grants the browser
 * to main alone, version 2 to exactly the agent groups it lists. The host
 * reports them in its browser health and a release declares them in
 * `src/gws-ea/browser-compatibility.json`, so the launcher writes version 2
 * only to a host that reads it and never rolls back below it.
 */
export const BROWSER_POLICY_VERSIONS = [1, 2] as const;
/** The most agent groups a version-2 policy lists. */
const MAX_LISTED_GROUPS = 64;

export type BrowserPolicyFile =
  | { schemaVersion: 1; enabled: boolean; chromePath?: string }
  | { schemaVersion: 2; enabled: boolean; chromePath?: string; agentGroupIds: string[] };
/** Who may use the browser: main alone (version 1), or exactly the agent groups a version-2 policy lists. */
export type BrowserAccessPolicy =
  | { readonly version: 1 }
  | { readonly version: 2; readonly agentGroupIds: readonly string[] };
export type BrowserPolicy =
  | {
      status: 'enabled';
      enabled: true;
      paths: BrowserPaths;
      chromePath: string;
      access: BrowserAccessPolicy;
    }
  | { status: 'disabled'; enabled: false; reason: 'operator-enablement-required'; access: BrowserAccessPolicy }
  | { status: 'unavailable'; enabled: false; reason: 'invalid-browser-policy' };

/** No policy file: the browser is off, and would be main's alone. */
export const DEFAULT_BROWSER_POLICY: BrowserPolicy = {
  status: 'disabled',
  enabled: false,
  reason: 'operator-enablement-required',
  access: { version: 1 },
};

/**
 * The host's own check of a version-2 list (`access.ts`): whether it may
 * grant these groups the browser. The launcher reads the file alone; it
 * validated the IDs through the running host before writing them.
 */
type AccessListCheck = (agentGroupIds: readonly string[]) => Promise<boolean>;
let accessListCheck: AccessListCheck | undefined;
export function registerBrowserAccessListCheck(check: AccessListCheck): void {
  accessListCheck = check;
}

export function browserPolicyFile(): string | undefined {
  return (
    process.env[BROWSER_POLICY_FILE_ENV]?.trim() ||
    readEnvFile([BROWSER_POLICY_FILE_ENV])[BROWSER_POLICY_FILE_ENV]?.trim() ||
    undefined
  );
}

/** An agent group ID as the host holds one: no whitespace or control character, at most 256 characters. */
function isAgentGroupId(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s\p{Cc}]{1,256}$/u.test(value);
}

/** A version-2 list naming each group once; anything else is no list. */
function agentGroupList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_LISTED_GROUPS || !value.every(isAgentGroupId)) return undefined;
  return new Set(value).size === value.length ? value : undefined;
}

/** A policy file in a version this host reads, or undefined for anything else. */
export function parseBrowserPolicyFile(value: unknown): BrowserPolicyFile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'enabled', 'chromePath', ...(record.schemaVersion === 2 ? ['agentGroupIds'] : [])];
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    typeof record.enabled !== 'boolean' ||
    (record.chromePath !== undefined && (typeof record.chromePath !== 'string' || !path.isAbsolute(record.chromePath)))
  )
    return undefined;
  const chrome = typeof record.chromePath === 'string' ? { chromePath: record.chromePath } : {};
  if (record.schemaVersion === 1) return { schemaVersion: 1, enabled: record.enabled, ...chrome };
  if (record.schemaVersion !== 2) return undefined;
  const agentGroupIds = agentGroupList(record.agentGroupIds);
  return agentGroupIds && { schemaVersion: 2, enabled: record.enabled, ...chrome, agentGroupIds };
}

/** Who a policy file grants the browser. */
export function browserAccessOf(file: BrowserPolicyFile): BrowserAccessPolicy {
  return file.schemaVersion === 1 ? { version: 1 } : { version: 2, agentGroupIds: file.agentGroupIds };
}

/** Optional capability policy is re-read for every host operation. Malformed state fails closed. */
export async function readBrowserPolicy(file = browserPolicyFile()): Promise<BrowserPolicy> {
  if (!file) return DEFAULT_BROWSER_POLICY;
  /* eslint-disable no-catch-all/no-catch-all -- invalid optional operator state disables browser admission, never text service */
  try {
    const paths = browserPaths(file);
    const parsed = parseBrowserPolicyFile(JSON.parse(await readPrivateFile(file, 16 * 1024)));
    if (!parsed) throw new Error('Invalid browser policy');
    const access = browserAccessOf(parsed);
    if (access.version === 2 && accessListCheck && !(await accessListCheck(access.agentGroupIds)))
      throw new Error('Invalid browser policy');
    if (!parsed.enabled) return { status: 'disabled', enabled: false, reason: 'operator-enablement-required', access };
    return { status: 'enabled', enabled: true, paths, chromePath: parsed.chromePath ?? SYSTEM_CHROME, access };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return DEFAULT_BROWSER_POLICY;
    return { status: 'unavailable', enabled: false, reason: 'invalid-browser-policy' };
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
