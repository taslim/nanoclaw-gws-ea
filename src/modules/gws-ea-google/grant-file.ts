/**
 * Reading the grant file, for the host's refresher and the control plane
 * alike. It must be a regular, owner-only file owned by the current user,
 * reached without a link.
 */
import { isErrno } from '../../community-portal/errors.js';
import { readOwnerOnlyJson } from '../../gws-ea/secrets.js';
import { parseGoogleGrant, type GoogleGrant } from './grant.js';

/** The grant, or undefined before the assistant has signed in. */
export async function readGoogleGrantFile(file: string): Promise<GoogleGrant | undefined> {
  try {
    return parseGoogleGrant(await readOwnerOnlyJson(file, 'Google grant', 'invalid_google_grant'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}
