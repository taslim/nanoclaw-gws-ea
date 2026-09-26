/**
 * The Cloudflare account token a create keeps while it is unfinished, so a
 * resume does not ask for it again. It lives owner-only in the instance's
 * private secrets and is deleted once the route is set up, or with the
 * instance. A kept token is only a convenience: whoever uses it checks it
 * first, and forgets it when Cloudflare refuses it.
 */
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { preparePrivateDirectory } from './paths.js';
import { registerSecret } from './redact.js';
import { readOwnerOnlyFile, removePrivateFile, writePrivateTextFile } from './secrets.js';
import { GwsEaError } from './types.js';

/** Cloudflare refused the token itself, rather than failing to answer. */
export function isCloudflareTokenRefusal(error: unknown): boolean {
  return (
    error instanceof GwsEaError &&
    (error.code === 'cloudflare_capability_missing' || error.code === 'invalid_cloudflare_token')
  );
}

/** The kept token, or undefined when none is kept. */
export async function readKeptAccountToken(file: string): Promise<string | undefined> {
  try {
    const token = (await readOwnerOnlyFile(file)).trim();
    if (!token) return undefined;
    registerSecret(token);
    return token;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** Keep `token` for this create's later runs. */
export async function keepAccountToken(file: string, token: string): Promise<void> {
  if ((await readKeptAccountToken(file)) === token) return;
  await preparePrivateDirectory(path.dirname(file));
  await writePrivateTextFile(file, token);
}

export function forgetAccountToken(file: string): Promise<void> {
  return removePrivateFile(file);
}
