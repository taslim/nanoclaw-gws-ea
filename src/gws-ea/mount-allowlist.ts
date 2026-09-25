/**
 * The shared NanoClaw mount allowlist (KTD9). It is NanoClaw's documented
 * configuration file, `~/.config/nanoclaw/mount-allowlist.json`: every
 * assistant's host reads it before mounting an extra directory into an agent.
 *
 * NanoClaw checks only a mount's root, against `blockedPatterns` as
 * substrings of its real path. So gws-ea (1) keeps its config, state, and log
 * roots in `blockedPatterns`, which refuses any mount at or below them, and
 * (2) stops while an `allowedRoots` entry equals or contains one of them,
 * because a mount of that ancestor would carry them along. With both, no
 * mount the allowlist permits exposes another assistant's secrets.
 */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { canonicalPath, isWithinDirectory, type ControlPlanePaths } from './paths.js';
import { writePrivateTextFile } from './secrets.js';
import { GwsEaError } from './types.js';
import { isRecord, parseJson } from './validation.js';

export type ProtectedRoots = Pick<ControlPlanePaths, 'configRoot' | 'stateRoot' | 'logsRoot'>;

export interface MountAllowlistLocation {
  readonly homeDirectory: string;
  /** Defaults to NanoClaw's documented location under `homeDirectory`. */
  readonly file?: string;
}

export function nanoclawMountAllowlistFile(homeDirectory: string): string {
  return path.join(homeDirectory, '.config', 'nanoclaw', 'mount-allowlist.json');
}

/** NanoClaw's own expansion: `~` and `~/…` are the host's home; other entries resolve against its cwd. */
function expandEntry(entry: string, homeDirectory: string): string | undefined {
  if (entry === '~') return homeDirectory;
  if (entry.startsWith('~/')) return path.join(homeDirectory, entry.slice(2));
  return path.isAbsolute(entry) ? entry : undefined;
}

/**
 * Keep gws-ea's roots in the allowlist's `blockedPatterns`, preserving every
 * other entry and field, then stop if an allowed root would expose them.
 * Without the file NanoClaw mounts nothing extra, so there is nothing to do.
 */
export async function protectFromAgentMounts(roots: ProtectedRoots, location: MountAllowlistLocation): Promise<void> {
  const named = location.file ?? nanoclawMountAllowlistFile(location.homeDirectory);
  let file: string;
  let source: string;
  try {
    // An operator's symlinked allowlist is kept; its target is updated in place.
    file = await realpath(named);
    source = await readFile(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  const allowlist = parseJson(source, `The NanoClaw mount allowlist at ${named}`, 'invalid_mount_allowlist');
  if (!isRecord(allowlist) || !Array.isArray(allowlist.allowedRoots) || !Array.isArray(allowlist.blockedPatterns)) {
    throw new GwsEaError(
      'invalid_mount_allowlist',
      `The NanoClaw mount allowlist at ${named} must be a JSON object with allowedRoots and blockedPatterns lists. Fix it, then retry.`,
      { details: { file: named } },
    );
  }
  const allowedRoots: readonly unknown[] = allowlist.allowedRoots;
  const blockedPatterns: readonly unknown[] = allowlist.blockedPatterns;
  const protectedRoots = [...new Set([roots.configRoot, roots.stateRoot, roots.logsRoot])];
  const missing = protectedRoots.filter((root) => !blockedPatterns.includes(root));
  if (missing.length > 0) {
    const next = { ...allowlist, blockedPatterns: [...blockedPatterns, ...missing] };
    await writePrivateTextFile(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  for (const root of allowedRoots) {
    const entry = isRecord(root) && typeof root.path === 'string' ? root.path : undefined;
    if (entry === undefined) continue;
    const details = { file: named, entry };
    const expanded = expandEntry(entry, location.homeDirectory);
    if (expanded === undefined) {
      throw new GwsEaError(
        'mount_allowlist_exposes_gws_ea',
        `The NanoClaw mount allowlist at ${named} allows "${entry}", a relative path each assistant's host resolves against its own checkout inside ${roots.stateRoot}. Replace it with an absolute path, then retry.`,
        { details },
      );
    }
    const allowed = canonicalPath(expanded);
    const exposed = protectedRoots.find((candidate) => candidate === allowed || isWithinDirectory(candidate, allowed));
    if (exposed === undefined) continue;
    throw new GwsEaError(
      'mount_allowlist_exposes_gws_ea',
      `The NanoClaw mount allowlist at ${named} allows mounting "${entry}", which contains gws-ea's private files at ${exposed}. Remove that allowedRoots entry or narrow it to a directory outside ${exposed}, then retry.`,
      { details: { ...details, root: exposed } },
    );
  }
}
