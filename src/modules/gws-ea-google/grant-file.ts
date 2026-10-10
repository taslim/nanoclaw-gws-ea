/**
 * Reading the grant file, for the host's refresher and the control plane
 * alike. It must be a regular, owner-only file owned by the current user,
 * reached without a link.
 */
import { isErrno } from '../../community-portal/errors.js';
import { readEnvFile } from '../../env.js';
import { readOwnerOnlyJson } from '../../gws-ea/secrets.js';
import { GOOGLE_GRANT_FILE_ENV, parseGoogleGrant, type GoogleGrant } from './grant.js';

/** Where the host finds the grant file: its environment, else the install's `.env`. Undefined without a sign-in setup. */
export function googleGrantFilePath(): string | undefined {
  return process.env[GOOGLE_GRANT_FILE_ENV] || readEnvFile([GOOGLE_GRANT_FILE_ENV])[GOOGLE_GRANT_FILE_ENV] || undefined;
}

/** The grant, or undefined before the assistant has signed in. */
export async function readGoogleGrantFile(file: string): Promise<GoogleGrant | undefined> {
  try {
    return parseGoogleGrant(await readOwnerOnlyJson(file, 'Google grant', 'invalid_google_grant'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}
