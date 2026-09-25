import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { isWithinDirectory } from './paths.js';
import { GwsEaError } from './types.js';

const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;

function assertOwnerOnlyStat(info: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>, file: string): void {
  if (!info.isFile()) throw new GwsEaError('unsafe_secret', `Owner-only state must be a regular file: ${file}`);
  if (typeof process.getuid === 'function' && Number(info.uid) !== process.getuid()) {
    throw new GwsEaError('unsafe_owner', `Owner-only state must be owned by the current user: ${file}`);
  }
  if ((Number(info.mode) & 0o777) !== 0o600) {
    throw new GwsEaError('unsafe_mode', `Owner-only state must have mode 0600: ${file}`);
  }
  if (Number(info.size) > MAX_PRIVATE_FILE_BYTES) {
    throw new GwsEaError('unsafe_secret', `Owner-only state exceeds its size limit: ${file}`);
  }
}

export async function readOwnerOnlyFile(file: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, 'ELOOP')) {
      throw new GwsEaError('unsafe_secret', `Owner-only state must be a regular non-symlink file: ${file}`);
    }
    throw error;
  }
  try {
    assertOwnerOnlyStat(await handle.stat(), file);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Read an operator-written file that must sit under `root`: a regular,
 * non-symlink file owned by the current user with no group or other
 * permission bits. Refusals raise `code` naming the file and the rule; a
 * missing file raises the underlying ENOENT for the caller to interpret.
 */
export async function readOperatorFile(file: string, root: string, label: string, code: string): Promise<string> {
  const absolute = path.resolve(file);
  const outside = (): GwsEaError => new GwsEaError(code, `${label} must be inside ${root}: ${absolute}`);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    // Without its root the file cannot exist; report it missing unless it names another place.
    if (isErrno(error, 'ENOENT') && !isWithinDirectory(absolute, path.resolve(root))) throw outside();
    throw error;
  }
  const directory = await realpath(path.dirname(absolute));
  if (!isWithinDirectory(path.join(directory, path.basename(absolute)), canonicalRoot)) throw outside();
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, 'ELOOP')) throw new GwsEaError(code, `${label} must not be a symlink: ${absolute}`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new GwsEaError(code, `${label} must be a regular file: ${absolute}`);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new GwsEaError(code, `${label} must be owned by the current user: ${absolute}`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new GwsEaError(code, `${label} must be readable only by its owner (chmod 0600): ${absolute}`);
    }
    if (info.size > MAX_PRIVATE_FILE_BYTES) throw new GwsEaError(code, `${label} is too large: ${absolute}`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function writeOwnerOnlyFileExclusive(file: string, contents: string): Promise<void> {
  const handle = await open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

export async function writePrivateTextFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    await chmod(file, 0o600);
    await syncDirectory(path.dirname(file));
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) throw error;
    });
  }
}

export async function ensureRandomOwnerOnlyFile(file: string, encoding: 'base64' | 'base64url'): Promise<void> {
  try {
    await readOwnerOnlyFile(file);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    await writeOwnerOnlyFileExclusive(file, randomBytes(32).toString(encoding));
  }
}

export async function removePrivateFile(file: string): Promise<void> {
  let removed = false;
  try {
    const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      assertOwnerOnlyStat(await handle.stat(), file);
    } finally {
      await handle.close();
    }
    await unlink(file);
    removed = true;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  if (removed) await syncDirectory(path.dirname(file));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
