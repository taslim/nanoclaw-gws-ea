import path from 'node:path';

import { readEnvFile } from '../../env.js';
import { browserPaths, readPrivateFile, type BrowserPaths } from './paths.js';

export const BROWSER_POLICY_FILE_ENV = 'GWS_EA_BROWSER_POLICY_FILE';
export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export interface BrowserPolicyFile {
  schemaVersion: 1;
  enabled: boolean;
  credentialMode: 'email' | '1password';
  chromePath?: string;
}
export type BrowserPolicy =
  | {
      status: 'enabled';
      enabled: true;
      paths: BrowserPaths;
      credentialMode: BrowserPolicyFile['credentialMode'];
      chromePath: string;
    }
  | { status: 'disabled'; enabled: false; reason: 'operator-enablement-required' }
  | { status: 'unavailable'; enabled: false; reason: 'invalid-browser-policy' };

export function browserPolicyFile(): string | undefined {
  return (
    process.env[BROWSER_POLICY_FILE_ENV]?.trim() ||
    readEnvFile([BROWSER_POLICY_FILE_ENV])[BROWSER_POLICY_FILE_ENV]?.trim() ||
    undefined
  );
}

/** Optional capability policy is re-read for every host operation. Malformed state fails closed. */
export async function readBrowserPolicy(file = browserPolicyFile()): Promise<BrowserPolicy> {
  if (!file) return { status: 'disabled', enabled: false, reason: 'operator-enablement-required' };
  /* eslint-disable no-catch-all/no-catch-all -- invalid optional operator state disables browser admission, never text service */
  try {
    const paths = browserPaths(file);
    const value: unknown = JSON.parse(await readPrivateFile(file, 16 * 1024));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid browser policy');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !['schemaVersion', 'enabled', 'credentialMode', 'chromePath'].includes(key)) ||
      record.schemaVersion !== 1 ||
      typeof record.enabled !== 'boolean' ||
      (record.credentialMode !== 'email' && record.credentialMode !== '1password') ||
      (record.chromePath !== undefined &&
        (typeof record.chromePath !== 'string' || !path.isAbsolute(record.chromePath)))
    )
      throw new Error('Invalid browser policy');
    if (!record.enabled) return { status: 'disabled', enabled: false, reason: 'operator-enablement-required' };
    return {
      status: 'enabled',
      enabled: true,
      paths,
      credentialMode: record.credentialMode,
      chromePath: typeof record.chromePath === 'string' ? record.chromePath : SYSTEM_CHROME,
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { status: 'disabled', enabled: false, reason: 'operator-enablement-required' };
    return { status: 'unavailable', enabled: false, reason: 'invalid-browser-policy' };
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
