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
import { prepareMerchantPage } from './merchant-signatures.js';
import { prepareAuthenticationIsolation } from './authentication-submit.js';
import { documentGate } from './document-gate.js';
import { coverPageTargets } from './page-targets.js';
import { ensurePrivateDirectory, type BrowserPaths } from './paths.js';
import { attachBrowserDiagnostics } from './diagnostics.js';

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
    await prepareAuthenticationIsolation(context);
    // Every document of this connection pauses at its gate from the first request; the gate ends with it.
    await documentGate(browser);
    const session = await browser.newBrowserCDPSession();
    await applyChromeContextPolicy(session);
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

/** Permissions and download denial are scoped to this native context, never borrowed from another. */
export async function applyChromeContextPolicy(session: CDPSession, browserContextId?: string): Promise<void> {
  const scope = browserContextId ? { browserContextId } : {};
  for (const name of ['clipboard-read', 'clipboard-write', 'local-network-access']) {
    await session.send('Browser.setPermission', { permission: { name }, setting: 'denied', ...scope });
  }
  await session.send('Browser.setDownloadBehavior', { behavior: 'deny', ...scope });
}

/**
 * CDP supplies background native-window creation and its exact target identity. Playwright supplies
 * the page and all interactions; its ordinary new-page operation cannot request a background window.
 */
export async function createBackgroundPage(
  connection: ChromeConnection,
  context: BrowserContext = connection.context,
  browserContextId?: string,
): Promise<Page> {
  let createdTargetId: string | undefined;
  let setupFailed = false;
  const closeCreatedTarget = async (): Promise<void> => {
    if (createdTargetId)
      await connection.session.send('Target.closeTarget', { targetId: createdTargetId }).catch(() => undefined);
  };
  let resolveTarget!: (id: string) => void;
  const expectedTarget = new Promise<string>((resolve) => {
    resolveTarget = resolve;
  });
  const appeared = context.waitForEvent('page', {
    timeout: 10_000,
    predicate: async (candidate) => {
      const targetId = await expectedTarget;
      if (!targetId || candidate.isClosed()) return false;
      const metadata = await context.newCDPSession(candidate);
      try {
        return (await metadata.send('Target.getTargetInfo')).targetInfo.targetId === targetId;
      } finally {
        await metadata.detach();
      }
    },
  });
  try {
    const created = connection.session
      .send('Target.createTarget', {
        url: 'about:blank',
        newWindow: true,
        background: true,
        ...(browserContextId ? { browserContextId } : {}),
      })
      .then(
        ({ targetId }) => {
          createdTargetId = targetId;
          if (setupFailed) void closeCreatedTarget();
          resolveTarget(targetId);
        },
        (error: unknown) => {
          resolveTarget('');
          throw error;
        },
      );
    const [, page] = await Promise.all([created, appeared]);
    attachBrowserDiagnostics(page);
    await secureJobPage(page);
    if (page.isClosed() || page.viewportSize() !== null) throw new Error('Native Chrome page unavailable');
    return page;
  } catch (error) {
    setupFailed = true;
    await closeCreatedTarget();
    throw error;
  }
}

/** The same host-owned probes verify the persistent profile and each signed-out context. */
export async function verifyChromePolicy(page: Page): Promise<void> {
  const result: unknown = await page.evaluate(`new Promise((resolve) => {
    const peer = new RTCPeerConnection({iceServers: []});
    let candidates = 0;
    let finished = false;
    const finish = (complete) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      peer.close();
      resolve({complete, candidates});
    };
    const timer = setTimeout(() => finish(false), 3000);
    peer.onicecandidate = event => {if (event.candidate) candidates += 1;};
    peer.onicegatheringstatechange = () => {if (peer.iceGatheringState === 'complete') finish(true);};
    peer.createDataChannel('host-policy-check');
    peer.createOffer().then(offer => peer.setLocalDescription(offer)).catch(() => finish(false));
  })`);
  if (
    typeof result !== 'object' ||
    result === null ||
    !('complete' in result) ||
    result.complete !== true ||
    !('candidates' in result) ||
    result.candidates !== 0
  )
    throw new Error('Chrome WebRTC policy unavailable');
  let blocked = false;
  try {
    await page.goto('nanoclaw-runtime-policy-check://no-registered-handler');
  } catch (error) {
    if (error instanceof Error && error.message.includes('ERR_BLOCKED_BY_ADMINISTRATOR')) blocked = true;
    else throw error;
  }
  if (!blocked) throw new Error('Chrome external-protocol policy unavailable');
}

/** Install before exposing a job page. Native dialogs/choosers never reach the operator. */
export async function secureJobPage(page: Page): Promise<void> {
  await prepareMerchantPage(page);
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('dialog', (dialog) => {
    void dialog.dismiss().catch(() => undefined);
  });
  page.on('download', (download) => {
    if (!allowedDownloads.has(page)) void download.cancel().catch(() => undefined);
  });
  // A cross-site frame's file input opens its chooser from that frame's own target.
  await coverPageTargets(page, async (session) => {
    // Chrome intercepts a chooser only for a session whose Page domain is enabled.
    await session.send('Page.enable');
    await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
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
