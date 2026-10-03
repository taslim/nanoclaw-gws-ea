/**
 * Keyed fingerprints of forgotten identities (KTD8). Forgetting a person
 * keeps only an HMAC of each identity, so learning cannot bring them back
 * while nothing readable about them remains. The key lives in an owner-only
 * file in the instance's secrets directory, beside the Google grant; it is
 * created once, by the first forget, and never replaced.
 */
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';

import { isErrno } from '../../community-portal/errors.js';
import { assertPrivateDirectory } from '../../gws-ea/paths.js';
import { readOwnerOnlyFile, writeOwnerOnlyFileExclusive } from '../../gws-ea/secrets.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';

/** The key's file name in the instance's `secrets/` directory. */
export const FINGERPRINT_KEY_FILE_NAME = 'people-fingerprint-key';

const KEY_BYTES = 32;

/**
 * Where the key lives: beside the Google grant, whose path the instance's
 * host is started with. Undefined on a host that is not a GWS-EA instance.
 */
export function fingerprintKeyFile(): string | undefined {
  const grantFile = process.env[GOOGLE_GRANT_FILE_ENV];
  return grantFile ? path.join(path.dirname(grantFile), FINGERPRINT_KEY_FILE_NAME) : undefined;
}

function decodeKey(contents: string, file: string): Buffer {
  const key = Buffer.from(contents.trim(), 'base64url');
  if (key.length !== KEY_BYTES) throw new Error(`The people fingerprint key is invalid: ${file}`);
  return key;
}

/** The key, or undefined when its file does not exist. An unsafe or malformed file is refused. */
export async function readFingerprintKey(file: string): Promise<Buffer | undefined> {
  try {
    return decodeKey(await readOwnerOnlyFile(file), file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * Create the key in its private directory. Exclusive: a key another writer
 * created first is read back, never overwritten.
 */
export async function createFingerprintKey(file: string): Promise<Buffer> {
  await assertPrivateDirectory(path.dirname(file));
  try {
    await writeOwnerOnlyFileExclusive(file, randomBytes(KEY_BYTES).toString('base64url'));
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }
  const key = await readFingerprintKey(file);
  if (key === undefined) throw new Error(`The people fingerprint key could not be created: ${file}`);
  return key;
}

/** The keyed fingerprint of an identity: HMAC-SHA256 of its match key, in hex. */
export function identityFingerprint(key: Buffer, handle: string): string {
  return createHmac('sha256', key).update(identityMatchKey(handle), 'utf8').digest('hex');
}
