import fs, { constants, type Stats } from 'node:fs';
import { chmod, lstat, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Download, Page } from 'playwright-core';

import { AnchoredDir } from '../../anchored-dir.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { isErrno } from '../../community-portal/errors.js';
import { sessionDir } from '../../session-manager.js';
import { withBrowserDownload } from './connection.js';
import { ensurePrivateDirectory } from './paths.js';
import type { BrowserExecutionContext } from './actions.js';
import { redactPageText } from './observe.js';

const readAt = promisify(fs.read);
const fstat = promisify(fs.fstat);
const fsync = promisify(fs.fsync);
const close = promisify(fs.close);

export const BROWSER_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const BROWSER_JOB_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;

/**
 * Make a directory's entries durable. Opened without following its last name
 * and without blocking, so a container-made link or FIFO there costs nothing.
 */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readChunk(fd: number, buffer: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await readAt(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset;
}

async function equalFiles(left: number, right: number): Promise<boolean> {
  const leftBytes = Buffer.alloc(64 * 1024);
  const rightBytes = Buffer.alloc(64 * 1024);
  for (let position = 0; ; position += leftBytes.length) {
    const [leftCount, rightCount] = await Promise.all([
      readChunk(left, leftBytes, position),
      readChunk(right, rightBytes, position),
    ]);
    if (leftCount !== rightCount || !leftBytes.subarray(0, leftCount).equals(rightBytes.subarray(0, rightCount)))
      return false;
    if (leftCount < leftBytes.length) return true;
  }
}

async function copyInto(input: number, output: number): Promise<void> {
  const buffer = Buffer.alloc(64 * 1024);
  for (let position = 0; ; ) {
    const bytes = await readChunk(input, buffer, position);
    for (let written = 0; written < bytes; ) {
      written += fs.writeSync(output, buffer, written, bytes - written, position + written);
    }
    position += bytes;
    if (bytes < buffer.length) return;
  }
}

/**
 * Open a file in an agent-writable tree, reached through each directory's
 * descriptor from `root` down: a link or anything but a real directory on the
 * way, or anything but a regular file at the end, is refused, never followed.
 */
function openAnchoredFile(root: string, segments: readonly string[], name: string): number {
  const directory = AnchoredDir.open(root, segments);
  if (!directory) throw Object.assign(new Error('No such file'), { code: 'ENOENT' });
  try {
    return directory.openReadFd(name);
  } finally {
    directory.close();
  }
}

/** Only the host copy is given to Chrome; later container mutations cannot change it. */
export async function stageBrowserUpload(
  sessionRoot: string,
  stagingRoot: string,
  requested: string,
): Promise<{ path: string; remove(): Promise<void> }> {
  const relative = requested.startsWith('/workspace/') ? requested.slice('/workspace/'.length) : requested;
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/u).some((part) => part === '..' || part === '.'))
    throw new Error('Unsafe upload path');
  const segments = relative.split('/');
  const name = segments.pop()!;
  let input: number;
  try {
    input = openAnchoredFile(sessionRoot, segments, name);
  } catch (error) {
    throw new Error('Upload is not a regular session file', { cause: error });
  }
  try {
    if ((await fstat(input)).nlink !== 1) throw new Error('Upload is not a regular session file');
    await ensurePrivateDirectory(stagingRoot);
    const directory = path.join(stagingRoot, `upload-${randomUUID()}`);
    await ensurePrivateDirectory(directory);
    const target = path.join(directory, name);
    const remove = async () => {
      await unlink(target).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
    };
    try {
      const output = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await copyInto(input, output.fd);
        await output.sync();
      } finally {
        await output.close();
      }
      await syncDirectory(stagingRoot);
      return { path: target, remove };
    } catch (error) {
      await remove();
      throw error;
    }
  } finally {
    await close(input);
  }
}

type StagedBrowserUpload = Awaited<ReturnType<typeof stageBrowserUpload>>;
const pageUploads = new WeakMap<Page, Set<StagedBrowserUpload>>();
const uploadCleanups = new WeakMap<Page, Promise<void>>();

/** Chrome reads selected disk files lazily, so a successful selection does not finish their use. */
export function retainBrowserUpload(page: Page, upload: StagedBrowserUpload): void {
  if (page.isClosed()) throw new Error('Upload page closed');
  let uploads = pageUploads.get(page);
  if (!uploads) {
    uploads = new Set();
    pageUploads.set(page, uploads);
    page.once('close', () => {
      void releaseBrowserUploads(page).catch(() => undefined);
    });
  }
  uploads.add(upload);
}
export function releaseBrowserUploads(page: Page): Promise<void> {
  const existing = uploadCleanups.get(page);
  if (existing) return existing;
  const uploads = pageUploads.get(page);
  if (!uploads) return Promise.resolve();
  pageUploads.delete(page);
  const cleanup = Promise.all([...uploads].map((upload) => upload.remove())).then(() => undefined);
  uploadCleanups.set(page, cleanup);
  return cleanup;
}

/**
 * Hand a download from the host's staging to the session inbox, then remove
 * the host original. A failed copy retains it. The inbox is the container's,
 * so `inbox/<artifact>` is reached by descriptor and written there alone: a
 * target already holding the same bytes is kept on replay, and anything else
 * under its name (a partial copy, a change, a link) is removed and copied again.
 */
export async function handoffBrowserDownload(
  hostPath: string,
  inboxRoot: string,
  artifactId: string,
  filename: string,
): Promise<string> {
  if (!isSafeAttachmentName(artifactId) || !isSafeAttachmentName(filename)) throw new Error('Unsafe download name');
  // The session folder is the host's (the container's mount point), so its
  // physical place is recorded: a path through a release's data link would
  // go stale once an update prunes that release.
  const sessionRoot = await realpath(path.dirname(inboxRoot));
  const target = path.join(sessionRoot, path.basename(inboxRoot), artifactId, filename);
  let directory: AnchoredDir | null;
  try {
    const inbox = AnchoredDir.open(sessionRoot, [path.basename(inboxRoot)], true);
    if (!inbox) throw new Error('Inbox missing');
    try {
      directory = inbox.openDir(artifactId, true);
      if (directory) {
        try {
          makePrivate(inbox, path.dirname(target), artifactId);
        } catch (error) {
          directory.close();
          throw error;
        }
      }
    } finally {
      inbox.close();
    }
  } catch (error) {
    throw new Error('Unsafe download inbox', { cause: error });
  }
  if (!directory) throw new Error('Unsafe download inbox');
  try {
    let input: number;
    try {
      input = fs.openSync(hostPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      // Handed off before: the inbox copy is all that remains.
      const existing = directory.openReadFd(filename);
      await close(existing);
      return target;
    }
    try {
      const stat = await fstat(input);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > BROWSER_DOWNLOAD_MAX_BYTES)
        throw new Error('Unsafe host download');
      if (!(await holdsSameFile(directory, filename, input, stat.size))) {
        removeEntry(directory, filename);
        const output = directory.openNewFd(filename);
        try {
          fs.fchmodSync(output, 0o600);
          await copyInto(input, output);
          await fsync(output);
        } finally {
          await close(output);
        }
      }
    } finally {
      await close(input);
    }
    await syncDirectory(path.dirname(target));
    await syncDirectory(inboxRoot);
    await syncDirectory(path.dirname(inboxRoot));
    await unlink(hostPath);
    return target;
  } finally {
    directory.close();
  }
}

/**
 * Make the inbox folder `name` private (0700). Node cannot chmod through a
 * directory descriptor it did not open, so the folder is opened by path,
 * never following its own name, and changed only when it is the very folder
 * the anchored inbox holds under `name`.
 */
function makePrivate(inbox: AnchoredDir, folder: string, name: string): void {
  const fd = fs.openSync(
    folder,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const held = inbox.lstat(name);
    // The anchored side reads identities as numbers: only one below 2^53 is
    // exact, so a larger one is refused rather than compared rounded.
    const same =
      Number.isSafeInteger(held.dev) &&
      Number.isSafeInteger(held.ino) &&
      opened.dev === BigInt(held.dev) &&
      opened.ino === BigInt(held.ino);
    if (!same) throw new Error('Download inbox changed during handoff');
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether `name` in the inbox is a regular single-link file holding exactly the host original's bytes. */
async function holdsSameFile(directory: AnchoredDir, name: string, original: number, size: number): Promise<boolean> {
  let existing: number;
  try {
    existing = directory.openReadFd(name);
  } catch (error) {
    // openReadFd refuses a non-regular file with an Error carrying no code.
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP') || !(error instanceof Error && 'code' in error))
      return false;
    throw error;
  }
  try {
    const stat = await fstat(existing);
    return stat.nlink === 1 && stat.size === size && (await equalFiles(existing, original));
  } finally {
    await close(existing);
  }
}

/** Remove whatever holds `name` in the inbox, a link itself and never its target. */
function removeEntry(directory: AnchoredDir, name: string): void {
  let entry: Stats;
  try {
    entry = directory.lstat(name);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  if (entry.isDirectory()) throw new Error('Download target is a directory');
  directory.unlink(name);
}

/**
 * The bytes a download has staged so far. Chrome writes `<guid>.crdownload`
 * and renames it to `<guid>` when the download completes, so an entry can
 * vanish between the listing and its size read: it is counted under its new
 * name by the next check, never taken for unsafe staging.
 */
export async function browserStagingBytes(directory: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(directory)) {
    let stat: Stats;
    try {
      stat = await lstat(path.join(directory, name));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe download staging');
    total += stat.size;
  }
  return total;
}

/** Where the agent reads a handed-off download: its inbox folder, as the container mounts the session. */
function workspaceDownloadPath(artifactId: string, filename: string): string {
  return path.posix.join('/workspace', 'inbox', artifactId, filename);
}

export async function captureBrowserDownload(
  context: BrowserExecutionContext,
  page: Page,
  stagingRoot: string,
  index: number,
  activate: () => Promise<void>,
): Promise<{ path: string; filename: string; bytes: number }> {
  const id = `${context.request.id}-${index}`;
  const prior = await context.store.db.get<{
    host_path: string;
    filename: string;
    bytes: number;
    inbox_path: string | null;
  }>('SELECT * FROM gws_ea_browser_downloads WHERE id = ?', id);
  const inboxRoot = path.join(sessionDir(context.session.agent_group_id, context.session.id), 'inbox');
  if (prior) {
    await handoffBrowserDownload(prior.host_path, inboxRoot, id, prior.filename);
    return { path: workspaceDownloadPath(id, prior.filename), filename: prior.filename, bytes: prior.bytes };
  }
  const used = await context.store.db.get<{ bytes: number }>(
    'SELECT COALESCE(SUM(bytes),0) AS bytes FROM gws_ea_browser_downloads WHERE job_id = ?',
    context.job.id,
  );
  const cap = Math.min(BROWSER_DOWNLOAD_MAX_BYTES, BROWSER_JOB_DOWNLOAD_MAX_BYTES - (used?.bytes ?? 0));
  if (cap <= 0) throw new Error('Download cap reached');
  const directory = path.join(stagingRoot, id);
  await ensurePrivateDirectory(directory);
  const connection = await context.runtime.connection();
  let download: Download | undefined;
  let overCap = false;
  let checking = false;
  const monitor = setInterval(() => {
    if (checking) return;
    checking = true;
    void browserStagingBytes(directory)
      .then(async (bytes) => {
        if (bytes > cap) {
          overCap = true;
          await download?.cancel();
        }
      })
      .catch(async () => {
        overCap = true;
        await download?.cancel();
      })
      .finally(() => {
        checking = false;
      });
  }, 50);
  monitor.unref();
  try {
    return await withBrowserDownload(connection, page, directory, async () => {
      const event = page.waitForEvent('download', { timeout: context.remaining() });
      void event.catch(() => undefined);
      await activate();
      download = await event;
      if (overCap) await download.cancel();
      // CDP reports Playwright's fixed artifacts directory, while allowAndName uses our request directory.
      const guid = path.basename(await download.path());
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(guid))
        throw new Error('Invalid native download identity');
      const hostPath = path.join(directory, guid);
      const stat = await lstat(hostPath);
      if (overCap || !stat.isFile() || stat.size > cap) {
        overCap = true;
        await unlink(hostPath);
        throw new Error('Download exceeds cap');
      }
      await chmod(hostPath, 0o600);
      const candidate = redactPageText(page, download.suggestedFilename());
      const filename =
        isSafeAttachmentName(candidate) && Buffer.byteLength(candidate) <= 200 ? candidate : 'download.bin';
      await context.store.db.run(
        'INSERT INTO gws_ea_browser_downloads(id,job_id,request_id,host_path,filename,bytes) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        id,
        context.job.id,
        context.request.id,
        hostPath,
        filename,
        stat.size,
      );
      const target = await handoffBrowserDownload(hostPath, inboxRoot, id, filename);
      await context.store.db.run(
        'UPDATE gws_ea_browser_downloads SET inbox_path = ?, handed_off_at = ? WHERE id = ?',
        target,
        new Date().toISOString(),
        id,
      );
      return { path: workspaceDownloadPath(id, filename), filename, bytes: stat.size };
    });
  } catch (error) {
    if (overCap) {
      await download?.cancel().catch(() => undefined);
      for (const name of await readdir(directory)) await unlink(path.join(directory, name)).catch(() => undefined);
    }
    throw error;
  } finally {
    clearInterval(monitor);
  }
}
