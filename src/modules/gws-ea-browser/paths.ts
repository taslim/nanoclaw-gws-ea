import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BrowserPaths {
  root: string;
  policyFile: string;
  profileDir: string;
  stagingDir: string;
  artifactsDir: string;
}

/** The policy owns a dedicated sibling profile; no foreign browser endpoint or profile is adopted. */
export function browserPaths(policyFile: string): BrowserPaths {
  if (!path.isAbsolute(policyFile)) throw new Error('Browser policy path must be absolute');
  const root = path.dirname(policyFile);
  const stagingDir = path.join(root, 'staging');
  return {
    root,
    policyFile,
    profileDir: path.join(root, 'profile'),
    stagingDir,
    artifactsDir: path.join(stagingDir, 'artifacts'),
  };
}

function assertOwner(stat: { uid: number }): void {
  if (process.getuid !== undefined && stat.uid !== process.getuid())
    throw new Error('Browser path has a different owner');
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  assertOwner(stat);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Browser directory is a symlink or not a directory');
  if ((stat.mode & 0o7777) !== 0o700) await chmod(directory, 0o700);
}

async function makeTreePrivate(directory: string, singletonLinks = false): Promise<void> {
  await ensurePrivateDirectory(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = await lstat(file);
    assertOwner(stat);
    if (stat.isSymbolicLink()) {
      // Chromium's process singleton uses these three symlinks in its own
      // root. They are not traversed, copied, or made accessible to agents.
      if (singletonLinks && ['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(entry.name)) continue;
      throw new Error('Browser private tree contains a symlink');
    }
    if (stat.isDirectory()) await makeTreePrivate(file);
    else if (stat.isFile() && stat.nlink === 1) {
      if ((stat.mode & 0o7777) !== 0o600) await chmod(file, 0o600);
    } else throw new Error('Browser private tree contains an unsafe file');
  }
}

export async function ensureBrowserPaths(paths: BrowserPaths): Promise<void> {
  await ensurePrivateDirectory(paths.root);
  await makeTreePrivate(paths.profileDir, true);
  await makeTreePrivate(paths.stagingDir);
  await ensurePrivateDirectory(paths.artifactsDir);
}

/** Called only after private-tree validation and while the owning Chrome is stopped. */
export async function clearBrowserUploadStaging(paths: BrowserPaths): Promise<void> {
  const directory = path.join(paths.stagingDir, 'uploads');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) await rm(path.join(directory, entry), { recursive: true, force: true });
}

/** Atomic owner-only files, including policy and Preferences; never follows an existing symlink. */
export async function writePrivateFile(file: string, data: string | Uint8Array): Promise<void> {
  await ensurePrivateDirectory(path.dirname(file));
  try {
    const existing = await lstat(file);
    assertOwner(existing);
    if (!existing.isFile() || existing.nlink !== 1) throw new Error('Browser file is not a private regular file');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    const parent = await open(path.dirname(file), constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readPrivateFile(file: string, maxBytes = 64 * 1024): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assertOwner(stat);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
      throw new Error('Browser file is not a private regular file');
    if ((stat.mode & 0o077) !== 0) throw new Error('Browser file is not owner-only');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
