import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';

import { stopChrome, type OwnedChrome } from './chrome.js';
import { prepareMerchantPage } from './merchant-read.js';
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
  readonly debuggerPort: number;
  close(): Promise<void>;
}

async function ownsDebugger(owned: OwnedChrome, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const { child, debuggerPort } = owned;
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    throw new Error('Chrome process unavailable');
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof',
      ['-w', '-nP', '-a', `-iTCP:${debuggerPort}`, '-sTCP:LISTEN', '-Fpfn'],
      { signal, timeout: 2_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        // lsof exits 1 for an empty selection; any stderr or other failure leaves ownership unobservable.
        if (stderr || (error && !(error.code === 1 && !error.killed && !error.signal && stdout === ''))) {
          reject(new Error('Chrome listener ownership unavailable'));
        } else resolve(stdout);
      },
    );
  });
  if (!output) return false;
  let pid: number | undefined;
  let file = false;
  let named = false;
  let listeners = 0;
  for (const line of output.replace(/\n$/, '').split('\n')) {
    if (/^p[1-9]\d*$/.test(line)) {
      if (pid !== undefined && (!file || !named)) throw new Error('Chrome listener ownership invalid');
      pid = Number(line.slice(1));
      file = false;
    } else if (/^f\d+$/.test(line) && pid !== undefined) {
      if (file && !named) throw new Error('Chrome listener ownership invalid');
      file = true;
      named = false;
    } else if (line.startsWith('n') && file && !named) {
      if (pid !== child.pid || line !== `n127.0.0.1:${debuggerPort}`)
        throw new Error('Chrome listener is not owned loopback');
      named = true;
      listeners++;
    } else throw new Error('Chrome listener ownership invalid');
  }
  if (!listeners || !file || !named) throw new Error('Chrome listener ownership invalid');
  signal.throwIfAborted();
  return true;
}

async function discoverDebugger(debuggerPort: number, signal: AbortSignal): Promise<string> {
  const body = await new Promise<string>((resolve, reject) => {
    const request = http.get(
      { hostname: '127.0.0.1', port: debuggerPort, path: '/json/version', signal },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error('Chrome discovery unavailable'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            response.destroy(new Error('Chrome discovery response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    request.once('error', reject);
  });
  const version: unknown = JSON.parse(body);
  if (
    typeof version !== 'object' ||
    version === null ||
    !('webSocketDebuggerUrl' in version) ||
    typeof version.webSocketDebuggerUrl !== 'string'
  )
    throw new Error('Chrome discovery invalid');
  const endpoint = new URL(version.webSocketDebuggerUrl);
  if (
    version.webSocketDebuggerUrl !== endpoint.href ||
    endpoint.protocol !== 'ws:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.port !== String(debuggerPort) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint.pathname)
  )
    throw new Error('Chrome discovery invalid');
  return endpoint.href;
}

/** Attaches only to a loopback listener proven, before and after discovery, to belong to the spawned child. */
export async function connectChrome(
  owned: OwnedChrome,
  paths: BrowserPaths,
  startupSignal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<ChromeConnection> {
  const { child, debuggerPort } = owned;
  const ended = new AbortController();
  const onExit = (): void => ended.abort();
  child.once('exit', onExit);
  child.once('error', onExit);
  const signal = AbortSignal.any([startupSignal, ended.signal]);
  let browser: Browser | undefined;
  const check = (): void => {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Chrome process unavailable');
  };
  let rejectAborted!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => rejectAborted(new Error('Chrome startup cancelled'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const setup = (async (): Promise<ChromeConnection> => {
      check();
      while (!(await ownsDebugger(owned, signal))) await delay(50, undefined, { signal });
      const endpoint = await discoverDebugger(debuggerPort, signal);
      if (!(await ownsDebugger(owned, signal))) throw new Error('Chrome listener disappeared');
      check();
      browser = await chromium.connectOverCDP(endpoint, { isLocal: true, artifactsDir: paths.artifactsDir });
      if (signal.aborted) {
        await stopChrome(child);
        void browser.close().catch(() => undefined);
        check();
      }
      const attached = browser;
      const context = attached.contexts()[0];
      if (!context) throw new Error('Chrome default context unavailable');
      await prepareAuthenticationIsolation(context);
      check();
      await documentGate(attached);
      check();
      const session = await attached.newBrowserCDPSession();
      await applyChromeContextPolicy(session);
      check();
      let closing: Promise<void> | undefined;
      return {
        browser: attached,
        context,
        session,
        child,
        debuggerPort,
        close() {
          closing ??= (async () => {
            const exited =
              child.exitCode !== null || child.signalCode !== null
                ? Promise.resolve()
                : once(child, 'exit').then(() => undefined);
            // Profile flushing is independent of the protocol reply, which Chrome may never send.
            void session.send('Browser.close').catch(() => undefined);
            let timer: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                exited,
                new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, 2_000);
                  timer.unref();
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
            await stopChrome(child);
            // Process retirement must remain reachable even if the client never finishes disposal.
            void attached.close().catch(() => undefined);
          })();
          return closing;
        },
      };
    })();
    const connection = await Promise.race([setup, aborted]);
    check();
    return connection;
  } catch {
    await stopChrome(child);
    void browser?.close().catch(() => undefined);
    // eslint-disable-next-line preserve-caught-error -- Native causes can expose private debugger endpoints or browser identifiers.
    throw new Error('Chrome connection unavailable');
  } finally {
    signal.removeEventListener('abort', onAbort);
    child.removeListener('exit', onExit);
    child.removeListener('error', onExit);
  }
}

/** Permissions and download denial are scoped to this native context, never borrowed from another. */
export async function applyChromeContextPolicy(session: CDPSession, browserContextId?: string): Promise<void> {
  const scope = browserContextId ? { browserContextId } : {};
  for (const name of ['clipboard-read', 'clipboard-write', 'local-network-access', 'notifications']) {
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

/** Run on a probe page in every browser context before that context serves a job. */
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
