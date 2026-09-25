import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { readOperatorFile } from './secrets.js';
import { GwsEaError } from './types.js';

export const GWS_EA_RELEASE_REMOTE = 'https://github.com/taslim/nanoclaw-gws-ea.git';

/** Operator-written, owner-only file under the config root naming the private `dogfood` remote. */
export const DOGFOOD_SOURCE_FILE = 'dogfood-source';

const REMOTE_PATTERN = /^[^\s\p{Cc}]+$/u;

/** `host/owner/repo` for URL and scp-style remotes, so spelling variants of one repository compare equal. */
function remoteIdentity(remote: string): string | undefined {
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/u.exec(remote);
  let host: string;
  let repository: string;
  if (scp) {
    host = scp[1]!;
    repository = scp[2]!;
  } else if (URL.canParse(remote) && new URL(remote).hostname) {
    const url = new URL(remote);
    host = url.hostname;
    repository = url.pathname;
  } else {
    return undefined;
  }
  const normalized = repository
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/u, '')
    .toLowerCase();
  return `${host.toLowerCase()}/${normalized}`;
}

export function isPublicReleaseRemote(remote: string): boolean {
  const identity = remoteIdentity(remote.trim());
  return identity !== undefined && identity === remoteIdentity(GWS_EA_RELEASE_REMOTE);
}

async function readDogfoodSource(file: string, configRoot: string): Promise<string | undefined> {
  let contents: string;
  try {
    contents = await readOperatorFile(file, configRoot, 'The dogfood source file', 'unsafe_source_file');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const lines = contents.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length !== 1 || !REMOTE_PATTERN.test(lines[0]!.trim())) {
    throw new GwsEaError('invalid_source_file', `The dogfood source file must hold exactly one git remote: ${file}`);
  }
  return lines[0]!.trim();
}

/**
 * The git remote a release track installs from. Only `prod` maps to the public
 * repository; `dogfood` comes from the operator's owner-only source file and is
 * never the public origin; `--source-remote` overrides either.
 */
export async function resolveReleaseSource(input: {
  readonly track: string;
  readonly sourceRemote?: string;
  readonly configRoot: string;
}): Promise<string> {
  const override = input.sourceRemote?.trim();
  if (input.track === 'prod') return override || GWS_EA_RELEASE_REMOTE;
  if (input.track !== 'dogfood') {
    if (override) return override;
    throw new GwsEaError(
      'release_source_required',
      `Release track ${input.track} has no configured source; pass --source-remote.`,
    );
  }
  const file = path.join(input.configRoot, DOGFOOD_SOURCE_FILE);
  const source = override || (await readDogfoodSource(file, input.configRoot));
  if (!source) {
    throw new GwsEaError(
      'release_source_required',
      `Release track dogfood has no source: pass --source-remote, or write the private remote to ${file} (chmod 0600).`,
    );
  }
  if (isPublicReleaseRemote(source)) {
    throw new GwsEaError(
      'public_dogfood_source',
      `The dogfood track never installs from the public repository ${GWS_EA_RELEASE_REMOTE}; name a private remote.`,
    );
  }
  return source;
}
