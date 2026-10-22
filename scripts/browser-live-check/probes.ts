import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errors, type Page } from 'playwright-core';

import {
  prepareChromeProfile,
  spawnChrome,
  stopChrome,
  type OwnedChrome,
} from '../../src/modules/gws-ea-browser/chrome.js';
import { ensureBrowserNavigationGuard, registrableSite } from '../../src/modules/gws-ea-browser/commit-classifier.js';
import {
  connectChrome,
  createBackgroundPage,
  verifyChromePolicy,
  type ChromeConnection,
} from '../../src/modules/gws-ea-browser/connection.js';
import { BrowserDiagnosticAttempt } from '../../src/modules/gws-ea-browser/diagnostics.js';
import { browserPaths } from '../../src/modules/gws-ea-browser/paths.js';
import { runProbe, type JsonValue, type ProbeResult } from './evidence.js';

export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface ProbeBrowser extends Pick<ChromeConnection, 'browser' | 'session' | 'child' | 'debuggerPort'> {
  profile: string;
  artifacts: string;
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
    /** Only the host's public-only filtering proxy may be supplied here. */
    publicProxyUrl?: string;
  } = {},
): Promise<ProbeBrowser> {
  const root = await mkdtemp(join(tmpdir(), 'nanoclaw-browser-probe-'));
  const paths = browserPaths(join(root, 'policy.json'));
  let refusingProxy: Awaited<ReturnType<typeof denyAllProxy>> | undefined;
  let owned: OwnedChrome | undefined;
  let connection: ChromeConnection | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        if (connection) await connection.close();
        else if (owned) await stopChrome(owned.child);
      } finally {
        try {
          if (refusingProxy) {
            const server = refusingProxy.server;
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error === undefined ? resolve() : reject(error)));
            });
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    })().catch(() => {
      throw new Error('Probe Chrome cleanup unavailable');
    });
    return closing;
  };
  try {
    await prepareChromeProfile(paths);
    refusingProxy = options.publicProxyUrl === undefined ? await denyAllProxy() : undefined;
    const proxyUrl = options.publicProxyUrl ?? refusingProxy?.url;
    if (!proxyUrl) throw new Error('Probe proxy unavailable');
    const signal = AbortSignal.timeout(30_000);
    owned = await spawnChrome({ chromePath: options.chromePath ?? SYSTEM_CHROME, paths, proxyUrl }, signal);
    connection = await connectChrome(owned, paths, signal);
    const attached = connection;
    const probe = await createBackgroundPage(attached);
    try {
      await verifyChromePolicy(probe);
      signal.throwIfAborted();
    } finally {
      await probe.close();
    }
    return {
      browser: attached.browser,
      session: attached.session,
      child: attached.child,
      debuggerPort: attached.debuggerPort,
      profile: paths.profileDir,
      artifacts: paths.artifactsDir,
      async newPage() {
        try {
          return await createBackgroundPage(attached);
        } catch {
          throw new Error('Background probe page unavailable');
        }
      },
      close,
    };
  } catch {
    await close();
    throw new Error('Probe Chrome unavailable');
  }
}

/** Native error messages can include private debugger endpoints or page data. */
async function sanitizedProbe(execute: () => Promise<Omit<ProbeResult, 'name'>>): Promise<Omit<ProbeResult, 'name'>> {
  try {
    return await execute();
  } catch {
    return { status: 'failed', detail: { error: 'Browser probe could not complete' } };
  }
}

export async function localProbes(
  probeBrowser: ProbeBrowser,
  observedProbe: typeof runProbe = runProbe,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const add = async (name: string, execute: () => Promise<Omit<ProbeResult, 'name'>>): Promise<void> => {
    results.push(await observedProbe(name, () => sanitizedProbe(execute)));
  };
  const page = await probeBrowser.newPage();
  await add('owned_loopback_cdp', async () => ({
    status: 'passed',
    detail: {
      transport: 'owned Chrome child on explicit loopback CDP port',
      debuggerPort: probeBrowser.debuggerPort,
      scope:
        'host ownership and literal 127.0.0.1 binding verified at attachment; no assistant-network isolation proof',
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
    const screenshotBytes = (await page.screenshot({ timeout: 5_000 })).length;
    return {
      status: clicked && json !== undefined && screenshotBytes > 0 ? 'passed' : 'failed',
      detail: {
        aiSnapshot: true,
        jsonSnapshot: json !== undefined,
        getByRefClicked: clicked,
        screenshotBytes,
        normalized: normalized.toString(),
      },
    };
  });
  await add('detection_signals', async () => ({
    status: 'passed',
    detail: await detectionSignals(page),
  }));
  await add('notifications_denied', async () => {
    const notification = await page.evaluate(() => ({
      api: typeof Notification,
      permission: Notification.permission,
    }));
    return {
      status: notification.api === 'function' && notification.permission === 'denied' ? 'passed' : 'failed',
      detail: { ...notification, permissionPromptRequested: false },
    };
  });
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
        candidateCount: candidates.length,
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
      let screenshotBytes = 0;
      let screenshotTimedOut = false;
      try {
        screenshotBytes = (await minimized.screenshot({ timeout: 5_000 })).length;
      } catch (error) {
        if (!(error instanceof errors.TimeoutError)) throw error;
        screenshotTimedOut = true;
      }
      const { bounds } = await probeBrowser.session.send('Browser.getWindowBounds', { windowId });
      let status: ProbeResult['status'];
      if (!clicked || bounds.windowState !== 'minimized') status = 'failed';
      else if (screenshotTimedOut) status = 'not-run';
      else status = screenshotBytes > 0 ? 'passed' : 'failed';
      return {
        status,
        detail: {
          clicked,
          screenshotBytes,
          screenshotTimedOut,
          windowState: bounds.windowState ?? 'unknown',
          scope: 'this desktop state only; no restore or activation was requested',
        },
      };
    } finally {
      await minimized.close();
    }
  });
  await page.close().catch(() => {
    throw new Error('Probe page cleanup unavailable');
  });
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
  probeBrowser: Pick<ProbeBrowser, 'newPage'>,
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
      await observedProbe(`signed_out_flow_${site.name}`, () =>
        sanitizedProbe(async () => {
          const page = await probeBrowser.newPage();
          const diagnostics = new BrowserDiagnosticAttempt({
            jobId: 'anonymous-probe',
            requestId: site.name,
            action: 'navigate',
          });
          diagnostics.observe(page);
          try {
            const leasedSite = registrableSite(site.url);
            if (!leasedSite) throw new Error('Public probe site unavailable');
            const guard = await ensureBrowserNavigationGuard(page);
            return await guard.runWithPolicy(
              {
                readOnly: true,
                leasedSite,
                async beforeNavigate(url, document) {
                  return !document.topLevel || registrableSite(url.href) === leasedSite
                    ? 'ordinary'
                    : 'blocked_address';
                },
              },
              async () => {
                const response = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                let ready = true;
                try {
                  // These sites hydrate after DOMContentLoaded; an empty shell establishes no merchant outcome.
                  await page.waitForFunction(
                    () =>
                      /restaurant|reservation|availability|search results|no (?:results|availability)|find a table|verify (?:you are|you're) human|unusual activity|access denied|captcha|attention required|checking your browser|security check|blocked/i.test(
                        document.body?.innerText ?? '',
                      ),
                    undefined,
                    { timeout: 15_000 },
                  );
                } catch (error) {
                  if (!(error instanceof errors.TimeoutError)) throw error;
                  ready = false;
                }
                const text = await page.locator('body').innerText();
                const challenge =
                  /verify (?:you are|you're) human|unusual activity|access denied|captcha|attention required|checking your browser|security check|blocked/i.test(
                    text,
                  );
                const searchResults =
                  /restaurant|reservation|availability|search results|no (?:results|availability)|find a table/i.test(
                    text,
                  );
                const status = response?.status() ?? 0;
                const refusal = guard.reason();
                const evidence = diagnostics.finish();
                return {
                  status:
                    challenge || !searchResults || status < 200 || status >= 400 || refusal !== undefined
                      ? 'failed'
                      : 'passed',
                  detail: {
                    requestedUrl: site.url,
                    finalSite: registrableSite(page.url()) ?? 'unknown',
                    responseStatus: status,
                    hostRefusal: refusal ?? null,
                    challenge,
                    ready,
                    searchResults,
                    runtime: { ...evidence.runtime },
                    requests: evidence.events.map((event) => ({ ...event })),
                    omittedEvents: evidence.omitted_events,
                    scope:
                      'fresh diagnostic profile; read-only anonymous search page on the leased site; no login, reservation, payment, or operator-profile comparison',
                  },
                };
              },
            );
          } catch {
            const evidence = diagnostics.finish();
            return {
              status: 'failed',
              detail: {
                requestedUrl: site.url,
                error: 'Anonymous navigation could not complete',
                runtime: { ...evidence.runtime },
                requests: evidence.events.map((event) => ({ ...event })),
                omittedEvents: evidence.omitted_events,
              },
            };
          } finally {
            await page.close();
          }
        }),
      ),
    );
  }
  return results;
}
