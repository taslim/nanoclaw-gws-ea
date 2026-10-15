import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { chromium, type Browser, type CDPSession, type ConnectOverCDPTransport, type Page } from 'playwright-core';

import { runProbe, type JsonValue, type ProbeResult } from './evidence.js';

const execFileAsync = promisify(execFile);
export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface ProbeBrowser {
  browser: Browser;
  session: CDPSession;
  child: ChildProcess;
  profile: string;
  artifacts: string;
  flags: string[];
  newPage: () => Promise<Page>;
  close: () => Promise<void>;
}

/** Local probes need no network. A refusing proxy prevents accidental egress. */
async function denyAllProxy(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(403, { Connection: 'close' });
    response.end('Network disabled for local browser probes');
  });
  server.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Proxy has no TCP address');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

export async function launchProbeBrowser(
  options: {
    chromePath?: string;
    automationControlled?: boolean;
    /** Only the host's public-only filtering proxy may be supplied here. */
    publicProxyUrl?: string;
  } = {},
): Promise<ProbeBrowser> {
  const profile = await mkdtemp(join(tmpdir(), 'nanoclaw-browser-probe-'));
  await chmod(profile, 0o700);
  const artifacts = join(profile, 'artifacts');
  await mkdir(artifacts, { mode: 0o700 });
  await mkdir(join(profile, 'Default'), { mode: 0o700 });
  await writeFile(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      profile: { exit_type: 'Normal', exited_cleanly: true, password_manager_enabled: false },
      credentials_enable_service: false,
      autofill: { credit_card_enabled: false, profile_enabled: false },
      browser: { check_default_browser: false },
      session: { restore_on_startup: 5 },
      // Chrome's renderer reads this profile pref. The command-line switch
      // alone produced non-proxied UDP host candidates on branded Chrome 155.
      // chromium/src chrome/common/pref_names.h: kWebRTCIPHandlingPolicy.
      webrtc: { ip_handling_policy: 'disable_non_proxied_udp' },
    }),
    { mode: 0o600 },
  );
  const refusingProxy = options.publicProxyUrl === undefined ? await denyAllProxy() : undefined;
  const flags = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--no-startup-window',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--enable-features=CDPScreenshotNewSurface',
    `--proxy-server=${options.publicProxyUrl ?? refusingProxy?.url}`,
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ...(options.automationControlled === false ? [] : ['--disable-blink-features=AutomationControlled']),
  ];
  const child = spawn(options.chromePath ?? SYSTEM_CHROME, flags, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  let browser: Browser | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await browser?.close().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').then(() => undefined);
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    if (refusingProxy !== undefined) {
      refusingProxy.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        refusingProxy.server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    await rm(profile, { recursive: true, force: true });
  };
  try {
    const outbound = child.stdio[3];
    const inbound = child.stdio[4];
    if (!(outbound instanceof Writable) || !(inbound instanceof Readable)) {
      throw new Error('Chrome debugging pipe descriptors are unavailable');
    }
    const transport: ConnectOverCDPTransport = {
      send(message) {
        outbound.write(`${JSON.stringify(message)}\0`);
      },
      close() {
        child.kill('SIGTERM');
      },
    };
    let buffered = Buffer.alloc(0);
    inbound.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      let end: number;
      while ((end = buffered.indexOf(0)) !== -1) {
        const frame = buffered.subarray(0, end).toString('utf8');
        buffered = buffered.subarray(end + 1);
        if (frame.length === 0) continue;
        const message: unknown = JSON.parse(frame);
        if (typeof message !== 'object' || message === null) {
          transport.onclose?.('Chrome sent an invalid protocol frame');
          child.kill('SIGTERM');
          return;
        }
        transport.onmessage?.(message);
      }
    });
    child.on('error', (error) => transport.onclose?.(error.message));
    child.on('exit', () => transport.onclose?.('Chrome exited'));
    browser = await chromium.connectOverCDP(transport, { isLocal: true, artifactsDir: artifacts, timeout: 15_000 });
    const attachedBrowser = browser;
    const session = await browser.newBrowserCDPSession();
    for (const name of ['clipboard-read', 'clipboard-write', 'local-network-access']) {
      await session.send('Browser.setPermission', { permission: { name }, setting: 'denied' });
    }
    await session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    return {
      browser,
      session,
      child,
      profile,
      artifacts,
      flags,
      async newPage() {
        const context = attachedBrowser.contexts()[0];
        if (context === undefined) throw new Error('Chrome has no default context');
        const appeared = context.waitForEvent('page', { timeout: 10_000 });
        await session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
        const page = await appeared;
        page.setDefaultTimeout(5_000);
        page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
        const pageSession = await context.newCDPSession(page);
        await pageSession.send('Page.setInterceptFileChooserDialog', { enabled: true });
        return page;
      },
      close,
    };
  } catch (error: unknown) {
    await close();
    throw error;
  }
}

export async function localProbes(
  probeBrowser: ProbeBrowser,
  observedProbe: typeof runProbe = runProbe,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const add = async (name: string, execute: () => Promise<Omit<ProbeResult, 'name'>>): Promise<void> => {
    results.push(await observedProbe(name, execute));
  };
  const page = await probeBrowser.newPage();
  await add('debugging_pipe', async () => ({
    status: 'passed',
    detail: {
      transport: 'private child-process pipe',
      chromeVersion: probeBrowser.browser.version(),
      viewport: page.viewportSize(),
    },
  }));
  await add('playwright_api_surface', async () => {
    await page.goto(
      "data:text/html,<h1>Before</h1><button onclick=\"document.querySelector('h1').textContent='After'\">Run</button>",
    );
    const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
    const ref = /button[^\n]*\[ref=(e\d+)\]/.exec(snapshot)?.[1];
    if (ref === undefined) throw new Error('AI snapshot supplied no button ref');
    const normalized = await page.getByRef(ref).normalize();
    await page.getByRef(ref).click();
    const clicked = (await page.locator('h1').textContent()) === 'After';
    // JSON snapshots generate a new ref generation; consume the old ref first.
    const json = await page.locator('body').ariaSnapshotJSON();
    return {
      status: clicked && json !== undefined ? 'passed' : 'failed',
      detail: {
        aiSnapshot: true,
        jsonSnapshot: json !== undefined,
        getByRefClicked: clicked,
        normalized: normalized.toString(),
      },
    };
  });
  await add('no_debugging_tcp_listener', async () => {
    if (probeBrowser.child.pid === undefined) throw new Error('Chrome pid unavailable');
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        '/usr/sbin/lsof',
        ['-a', '-p', String(probeBrowser.child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
        { encoding: 'utf8', timeout: 5_000 },
      ));
    } catch (error: unknown) {
      // lsof returns 1 when its successful query found no matching descriptor.
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 1 ||
        !('stdout' in error) ||
        typeof error.stdout !== 'string'
      )
        throw error;
      stdout = error.stdout;
    }
    return { status: stdout.trim() === '' ? 'passed' : 'failed', detail: { listeningSocketRecords: stdout.trim() } };
  });
  await add('detection_signals_with_flag', async () => ({
    status: 'passed',
    detail: await detectionSignals(page),
  }));
  await add('clipboard_permissions', async () => {
    // Permission denial is checked before attempting either API. No readText
    // call runs, so clipboard contents cannot be read even if Chrome regresses.
    const permissions = await page.evaluate(async () => {
      const names = ['clipboard-read', 'clipboard-write'] as const;
      const states: Record<string, string> = {};
      for (const name of names) {
        const result = await navigator.permissions.query({ name: name as PermissionName });
        states[name] = result.state;
      }
      return states;
    });
    const denied = Object.values(permissions).every((state) => state === 'denied');
    return {
      status: denied ? 'passed' : 'failed',
      detail: { permissions, clipboardContentsRead: false, clipboardWritesAttempted: false },
    };
  });
  await add('javascript_dialog', async () => {
    await page.evaluate(() => {
      alert('Browser quiet-operation probe');
    });
    return { status: 'passed', detail: { javascriptDialogDismissed: true, nativeUiNotVerified: true } };
  });
  await add('webrtc_non_proxied_candidates', async () => {
    const candidates = await page.evaluate(async () => {
      const peer = new RTCPeerConnection({ iceServers: [] });
      peer.createDataChannel('probe');
      const gathered: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 3_000);
        peer.onicecandidate = (event) => {
          if (event.candidate !== null) gathered.push(event.candidate.candidate);
          else {
            clearTimeout(timer);
            resolve();
          }
        };
        void peer
          .createOffer()
          .then((offer) => peer.setLocalDescription(offer))
          .catch(reject);
      });
      peer.close();
      return gathered;
    });
    return {
      status: candidates.length === 0 ? 'passed' : 'failed',
      detail: {
        candidates,
        scope: 'no non-proxied host candidates with empty ICE server list; external STUN/QUIC not exercised',
      },
    };
  });
  await add('minimized_rendering_and_input', async () => {
    const minimized = await probeBrowser.newPage();
    try {
      await minimized.goto(
        "data:text/html,<h1>Before</h1><button onclick=\"document.querySelector('h1').textContent='After'\">Run</button>",
      );
      const pageSession = await minimized.context().newCDPSession(minimized);
      const { targetInfo } = await pageSession.send('Target.getTargetInfo');
      const { windowId } = await probeBrowser.session.send('Browser.getWindowForTarget', {
        targetId: targetInfo.targetId,
      });
      await probeBrowser.session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await minimized.getByRole('button', { name: 'Run', exact: true }).click();
      const clicked = (await minimized.locator('h1').textContent()) === 'After';
      const screenshot = await minimized.screenshot({ timeout: 5_000 });
      const { bounds } = await probeBrowser.session.send('Browser.getWindowBounds', { windowId });
      return {
        status: clicked && screenshot.length > 0 && bounds.windowState === 'minimized' ? 'passed' : 'failed',
        detail: {
          clicked,
          screenshotBytes: screenshot.length,
          windowState: bounds.windowState ?? 'unknown',
          scope: 'this desktop state only; no restore or activation was requested',
        },
      };
    } finally {
      await minimized.close();
    }
  });
  await page.close();
  return results;
}

export async function detectionSignals(page: Page): Promise<{ [key: string]: JsonValue }> {
  return page.evaluate(() => ({
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    documentHasFocus: document.hasFocus(),
    visibilityState: document.visibilityState,
  }));
}

/** Signed-out only; no account state or transaction controls are touched. */
export async function publicSiteProbes(
  probeBrowser: ProbeBrowser,
  observedProbe: typeof runProbe = runProbe,
): Promise<ProbeResult[]> {
  const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const sites = [
    {
      name: 'opentable',
      url: `https://www.opentable.com/s?dateTime=${nextWeek}T19%3A00%3A00&covers=2&term=San%20Francisco`,
    },
    { name: 'resy', url: `https://resy.com/cities/sf?date=${nextWeek}&seats=2` },
    { name: 'tock', url: 'https://www.exploretock.com/search?city=San%20Francisco' },
  ];
  const results: ProbeResult[] = [];
  for (const site of sites) {
    results.push(
      await observedProbe(`signed_out_flow_${site.name}`, async () => {
        const page = await probeBrowser.newPage();
        try {
          await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          // A search URL is the first model-free flow step. Record what arrived,
          // rather than treating an HTTP 200 bot challenge as a successful flow.
          const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' });
          const text = await page.locator('body').innerText();
          const challenge =
            /verify (?:you are|you're) human|unusual activity|access denied|captcha|attention required|checking your browser|security check|blocked/i.test(
              text,
            );
          const searchResults =
            /restaurant|reservation|availability|search results|no (?:results|availability)|find a table/i.test(text);
          return {
            status: challenge || !searchResults ? 'failed' : 'passed',
            detail: {
              url: page.url(),
              title: await page.title(),
              challenge,
              searchResults,
              snapshot: snapshot.slice(0, 24_000),
              scope: 'signed-out search page; no login, booking, payment, or operator-profile comparison',
            },
          };
        } finally {
          await page.close();
        }
      }),
    );
  }
  return results;
}
