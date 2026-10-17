import { constants, type Stats } from 'node:fs';
import { chmod, link, lstat, open, readdir, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Download, Page } from 'playwright-core';

import { isSafeAttachmentName } from '../../attachment-safety.js';
import { isErrno } from '../../community-portal/errors.js';
import { ensureContainedInboxDir, isPathInside } from '../../inbox-safety.js';
import { sessionDir } from '../../session-manager.js';
import { withBrowserDownload } from './connection.js';
import { ensurePrivateDirectory } from './paths.js';
import type { BrowserExecutionContext } from './queue.js';
import { redactPageText } from './observe.js';

export const BROWSER_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const BROWSER_JOB_DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024;

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readChunk(file: FileHandle, buffer: Buffer): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset;
}

async function equalFiles(left: FileHandle, right: FileHandle): Promise<boolean> {
  const leftBytes = Buffer.alloc(64 * 1024);
  const rightBytes = Buffer.alloc(64 * 1024);
  for (;;) {
    const [leftCount, rightCount] = await Promise.all([readChunk(left, leftBytes), readChunk(right, rightBytes)]);
    if (leftCount !== rightCount || !leftBytes.subarray(0, leftCount).equals(rightBytes.subarray(0, rightCount)))
      return false;
    if (!leftCount) return true;
  }
}

/** Bind every path component to the open, so a directory swap cannot redirect the copy. */
async function openUploadSource(source: string): Promise<FileHandle> {
  if (process.platform === 'darwin') {
    // Darwin's open(2) protects the entire lookup. Combining this with O_NOFOLLOW is EINVAL.
    // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
    const noFollowAny = 0x20000000;
    return open(source, constants.O_RDONLY | noFollowAny);
  }
  if (process.platform !== 'linux') throw new Error('Safe upload opening requires macOS or Linux');
  // Node has no openat API. Linux procfs resolves each child from the held directory inode,
  // including after its original name is renamed or replaced with a symlink.
  const components = source.split(path.sep).filter(Boolean);
  let directory = await open(
    path.parse(source).root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const component of components.slice(0, -1)) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const previous = directory;
      directory = next;
      await previous.close();
    }
    return await open(`/proc/self/fd/${directory.fd}/${components.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  } finally {
    await directory.close();
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
  const base = await realpath(sessionRoot);
  const source = path.join(base, relative);
  let component = base;
  for (const part of relative.split('/')) {
    component = path.join(component, part);
    if ((await lstat(component)).isSymbolicLink()) throw new Error('Upload symlink refused');
  }
  if (!isPathInside(base, await realpath(source))) throw new Error('Upload escaped session');
  await ensurePrivateDirectory(stagingRoot);
  const input = await openUploadSource(source);
  const directory = path.join(stagingRoot, `upload-${randomUUID()}`);
  await ensurePrivateDirectory(directory);
  const target = path.join(directory, path.basename(source));
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Upload is not a regular session file');
    const output = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let bytes: number;
      while ((bytes = (await input.read(buffer, 0, buffer.length, null)).bytesRead))
        await output.writeFile(buffer.subarray(0, bytes));
      await output.sync();
    } finally {
      await output.close();
    }
    await syncDirectory(stagingRoot);
    return {
      path: target,
      async remove() {
        await unlink(target).catch(() => undefined);
        await rmdir(directory).catch(() => undefined);
      },
    };
  } catch (error) {
    await unlink(target).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
    throw error;
  } finally {
    await input.close();
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

/** A failed copy retains the host original. An existing completed target is recognized on replay. */
export async function handoffBrowserDownload(
  hostPath: string,
  inboxRoot: string,
  artifactId: string,
  filename: string,
): Promise<string> {
  if (!isSafeAttachmentName(artifactId) || !isSafeAttachmentName(filename)) throw new Error('Unsafe download name');
  const directory = ensureContainedInboxDir(inboxRoot, artifactId, { artifactId });
  if (!directory) throw new Error('Unsafe download inbox');
  await chmod(directory, 0o700);
  const target = path.join(directory, filename);
  let input;
  try {
    input = await open(hostPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await existing.stat()).isFile()) throw new Error('Unsafe existing download', { cause: error });
    } finally {
      await existing.close();
    }
    return target;
  }
  let output;
  let temporary: string | undefined;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > BROWSER_DOWNLOAD_MAX_BYTES)
      throw new Error('Unsafe host download');
    let existing;
    try {
      existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (existing) {
      try {
        const existingStat = await existing.stat();
        if (
          !existingStat.isFile() ||
          existingStat.nlink !== 1 ||
          existingStat.size !== stat.size ||
          !(await equalFiles(existing, input))
        )
          throw new Error('Download target is incomplete or changed');
      } finally {
        await existing.close();
      }
      await syncDirectory(directory);
      await syncDirectory(inboxRoot);
      await syncDirectory(path.dirname(inboxRoot));
      await unlink(hostPath);
      return target;
    }
    temporary = path.join(directory, `.browser-${randomUUID()}.partial`);
    output = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.alloc(64 * 1024);
    let bytes: number;
    while ((bytes = (await input.read(buffer, 0, buffer.length, null)).bytesRead))
      await output.writeFile(buffer.subarray(0, bytes));
    await output.sync();
    await output.close();
    output = undefined;
    if ((await realpath(path.dirname(target))) !== directory) throw new Error('Download inbox changed during handoff');
    // Publish a complete file atomically without ever replacing an existing target.
    await link(temporary, target);
    await unlink(temporary);
    temporary = undefined;
    await syncDirectory(directory);
    await syncDirectory(inboxRoot);
    await syncDirectory(path.dirname(inboxRoot));
    await unlink(hostPath);
    return target;
  } finally {
    await output?.close();
    if (temporary) await unlink(temporary).catch(() => undefined);
    await input.close();
  }
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

async function workspaceDownloadPath(sessionRoot: string, target: string): Promise<string> {
  const base = await realpath(sessionRoot);
  if (!isPathInside(base, target)) throw new Error('Download escaped its session');
  return path.posix.join('/workspace', ...path.relative(base, target).split(path.sep));
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
    const target = await handoffBrowserDownload(prior.host_path, inboxRoot, id, prior.filename);
    return {
      path: await workspaceDownloadPath(sessionDir(context.session.agent_group_id, context.session.id), target),
      filename: prior.filename,
      bytes: prior.bytes,
    };
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
      return {
        path: await workspaceDownloadPath(sessionDir(context.session.agent_group_id, context.session.id), target),
        filename,
        bytes: stat.size,
      };
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
