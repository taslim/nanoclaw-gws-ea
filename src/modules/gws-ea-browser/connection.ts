import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type ConnectOverCDPTransport,
  type Page,
} from 'playwright-core';

import { stopChrome } from './chrome.js';
import { ensurePrivateDirectory, type BrowserPaths } from './paths.js';

const allowedDownloads = new WeakSet<Page>();
const downloadTails = new WeakMap<ChromeConnection, Promise<void>>();

export interface ChromeConnection {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly session: CDPSession;
  readonly child: ChildProcess;
  close(): Promise<void>;
}

/** Attach only to descriptors inherited from the Chrome child this host spawned. */
export async function connectChromePipe(child: ChildProcess, paths: BrowserPaths): Promise<ChromeConnection> {
  const outbound = child.stdio[3];
  const inbound = child.stdio[4];
  if (!(outbound instanceof Writable) || !(inbound instanceof Readable)) throw new Error('Chrome pipe unavailable');
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let ended = false;
  const transport: ConnectOverCDPTransport = {
    send(message) {
      if (ended) return;
      outbound.write(`${JSON.stringify(message)}\0`, (error) => {
        if (error) terminate();
      });
    },
    close() {
      child.kill('SIGTERM');
    },
  };
  function terminate(): void {
    if (ended) return;
    ended = true;
    transport.onclose?.('Chrome pipe closed');
    child.kill('SIGTERM');
  }
  inbound.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 32 * 1024 * 1024) {
      terminate();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf(0)) !== -1) {
      const frame = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      if (!frame) continue;
      let message: unknown;
      try {
        message = JSON.parse(frame) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError) {
          terminate();
          return;
        }
        throw error;
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        terminate();
        return;
      }
      // Match Playwright's native pipe transport: each protocol message gets
      // its own task so response continuations install listeners before the
      // next event, even when Chrome coalesces both into one pipe chunk.
      setImmediate(() => transport.onmessage?.(message));
    }
  });
  inbound.on('error', terminate);
  outbound.on('error', terminate);
  child.on('error', terminate);
  child.on('exit', terminate);
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(transport, {
      isLocal: true,
      artifactsDir: paths.artifactsDir,
      timeout: 15_000,
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome default context unavailable');
    const session = await browser.newBrowserCDPSession();
    for (const name of ['clipboard-read', 'clipboard-write', 'local-network-access']) {
      await session.send('Browser.setPermission', { permission: { name }, setting: 'denied' });
    }
    await session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    let closing: Promise<void> | undefined;
    const attached = browser;
    return {
      browser,
      context,
      session,
      child,
      close() {
        closing ??= (async () => {
          // Chrome may not answer Browser.close after a process crash.
          const requested = attached.close().catch(() => undefined);
          const deadline = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2_000);
            timer.unref();
          });
          await Promise.race([requested, deadline]);
          await stopChrome(child);
        })();
        return closing;
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await stopChrome(child);
    throw new Error('Chrome connection unavailable', { cause: error });
  }
}

/** Install before exposing a job page. Native dialogs/choosers never reach the operator. */
export async function secureJobPage(page: Page): Promise<void> {
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('dialog', (dialog) => {
    void dialog.dismiss().catch(() => undefined);
  });
  page.on('download', (download) => {
    if (!allowedDownloads.has(page)) void download.cancel().catch(() => undefined);
  });
  const session = await page.context().newCDPSession(page);
  await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
  page.once('close', () => {
    void session.detach().catch(() => undefined);
  });
}

/** Shared-context download permission is serialized; unsolicited downloads on every other page remain cancelled. */
export async function withBrowserDownload<T>(
  connection: ChromeConnection,
  page: Page,
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (page.context() !== connection.context || page.isClosed()) throw new Error('Download page unavailable');
  const prior = downloadTails.get(connection) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  downloadTails.set(connection, tail);
  await prior;
  try {
    await ensurePrivateDirectory(directory);
    allowedDownloads.add(page);
    await connection.session.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: directory });
    return await operation();
  } finally {
    allowedDownloads.delete(page);
    try {
      await restoreDownloadBoundary(connection);
    } finally {
      release();
      if (downloadTails.get(connection) === tail) downloadTails.delete(connection);
    }
  }
}

async function restoreDownloadBoundary(connection: ChromeConnection): Promise<void> {
  try {
    await connection.session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
  } catch (error) {
    await connection.close();
    throw new Error('Download permission could not be closed', { cause: error });
  }
}
