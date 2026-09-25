import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { isOwnerOnlyMode, isWithinDirectory } from './paths.js';
import { GwsEaError } from './types.js';
import { parseJson } from './validation.js';

const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;

/** Each owner-only rule's refusal: its code and what it says before the file's path. */
type OwnerOnlyRefusals = Readonly<Record<'file' | 'owner' | 'mode' | 'size', readonly [code: string, message: string]>>;

const OWNER_ONLY_STATE: OwnerOnlyRefusals = {
  file: ['unsafe_secret', 'Owner-only state must be a regular file'],
  owner: ['unsafe_owner', 'Owner-only state must be owned by the current user'],
  mode: ['unsafe_mode', 'Owner-only state must be readable only by its owner (0600)'],
  size: ['unsafe_secret', 'Owner-only state exceeds its size limit'],
};

/** A regular file, owned by the current user, with no group or other permission bits, within the size limit. */
function assertOwnerOnlyStat(
  info: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  file: string,
  refusals: OwnerOnlyRefusals = OWNER_ONLY_STATE,
): void {
  const refuse = (rule: keyof OwnerOnlyRefusals): GwsEaError => {
    const [code, message] = refusals[rule];
    return new GwsEaError(code, `${message}: ${file}`);
  };
  if (!info.isFile()) throw refuse('file');
  if (typeof process.getuid === 'function' && Number(info.uid) !== process.getuid()) throw refuse('owner');
  if (!isOwnerOnlyMode(Number(info.mode))) throw refuse('mode');
  if (Number(info.size) > MAX_PRIVATE_FILE_BYTES) throw refuse('size');
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

/** An owner-only JSON state file; malformed JSON raises `code`. */
export async function readOwnerOnlyJson(file: string, label: string, code: string): Promise<unknown> {
  return parseJson(await readOwnerOnlyFile(file), label, code);
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
    assertOwnerOnlyStat(await handle.stat(), absolute, {
      file: [code, `${label} must be a regular file`],
      owner: [code, `${label} must be owned by the current user`],
      mode: [code, `${label} must be readable only by its owner (chmod 0600)`],
      size: [code, `${label} is too large`],
    });
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
