import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../../community-portal/errors.js';
import { readEnvFile } from '../../env.js';
import { browserPaths, type BrowserPaths } from './paths.js';

export const BROWSER_ROOT_ENV = 'GWS_EA_BROWSER_ROOT';
export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export type BrowserAvailability =
  | { readonly available: true; readonly paths: BrowserPaths; readonly chromePath: string }
  | {
      readonly available: false;
      readonly reason:
        | 'browser-root-unconfigured'
        | 'browser-path-unavailable'
        | 'chrome-missing'
        | 'chrome-not-launchable';
    };

export function browserRoot(): string | undefined {
  return (
    process.env[BROWSER_ROOT_ENV]?.trim() || readEnvFile([BROWSER_ROOT_ENV])[BROWSER_ROOT_ENV]?.trim() || undefined
  );
}

/** Configuration is independent of Chrome presence, so installing Chrome never requires repairing destinations. */
export function browserConfigured(root = browserRoot()): boolean {
  return typeof root === 'string' && root.length > 0 && path.isAbsolute(root) && path.resolve(root) === root;
}

async function validDirectory(directory: string): Promise<boolean> {
  try {
    const entry = await lstat(directory);
    return (
      entry.isDirectory() && !entry.isSymbolicLink() && (process.getuid === undefined || entry.uid === process.getuid())
    );
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return true;
    throw error;
  }
}

/** Read-only and fresh on each use. The Chrome argument is a constructor/test dependency, never operator configuration. */
export async function browserAvailability(
  root = browserRoot(),
  chromePath = SYSTEM_CHROME,
): Promise<BrowserAvailability> {
  if (!root || !browserConfigured(root)) return { available: false, reason: 'browser-root-unconfigured' };
  const paths = browserPaths(root);
  try {
    for (const directory of [paths.root, paths.profileDir, paths.stagingDir])
      if (!(await validDirectory(directory))) return { available: false, reason: 'browser-path-unavailable' };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { available: false, reason: 'browser-path-unavailable' };
  }
  try {
    if (!(await stat(chromePath)).isFile()) return { available: false, reason: 'chrome-not-launchable' };
    await access(chromePath, constants.X_OK);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      available: false,
      reason: isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') ? 'chrome-missing' : 'chrome-not-launchable',
    };
  }
  return { available: true, paths, chromePath };
}

export function browserUnavailableMessage(
  reason: Extract<BrowserAvailability, { available: false }>['reason'],
): string {
  switch (reason) {
    case 'chrome-missing':
      return 'Chrome is not installed in its standard location; ask your operator to install Google Chrome.';
    case 'chrome-not-launchable':
      return 'Chrome is installed but cannot be launched; ask your operator to check its file permissions and diagnostics.';
    case 'browser-root-unconfigured':
    case 'browser-path-unavailable':
      return 'The browser is unavailable; ask your operator to check this assistant’s browser state.';
  }
}
