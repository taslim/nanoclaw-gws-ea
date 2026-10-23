import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { parseArtifactDocument } from './generated/document.js';
import { ARTIFACT_MIN_CHROMIUM, renderArtifactChild, renderArtifactViewer } from './generated/viewer.js';

export interface ArtifactPreviewImage {
  readonly viewport: 'desktop' | 'mobile';
  readonly mode: 'interactive' | 'static';
  readonly mimeType: 'image/png';
  readonly data: string;
}
export interface ArtifactPreviewDiagnostics {
  readonly errors: readonly string[];
  readonly blockedRequests: readonly string[];
  readonly horizontalOverflow: readonly string[];
  readonly chromiumMajor: number;
  readonly interactionAvailable: boolean;
}
export type ArtifactPreviewResult =
  | {
      readonly status: 'previewed';
      readonly sourceHash: string;
      readonly images: readonly ArtifactPreviewImage[];
      readonly diagnostics: ArtifactPreviewDiagnostics;
    }
  | { readonly status: 'busy' | 'failed'; readonly sourceHash: string; readonly reason: string };
export interface ArtifactPreviewInput {
  readonly sessionId: string;
  readonly html: string;
  readonly title?: string;
  readonly expectedHash?: string;
  readonly signal?: AbortSignal;
  /** An existing system Chromium. Never a persistent browser or signed-in profile. */
  readonly executablePath?: string;
}
const activeSessions = new Set<string>();
const DEADLINE_MS = 15_000;
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
] as const;
function executablePath(input: ArtifactPreviewInput): string | undefined {
  return [
    input.executablePath,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.AGENT_BROWSER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((file): file is string => Boolean(file && existsSync(file)));
}
/** Four native PNG captures: desktop/mobile with the verified interaction path and with the static fallback. */
export async function previewArtifact(input: ArtifactPreviewInput): Promise<ArtifactPreviewResult> {
  const sourceHash = createHash('sha256').update(input.html).digest('hex');
  if (activeSessions.has(input.sessionId))
    return { status: 'busy', sourceHash, reason: 'An artifact preview is already active in this session.' };
  if (input.expectedHash !== undefined && input.expectedHash !== sourceHash)
    return { status: 'failed', sourceHash, reason: 'Artifact source changed since the expected hash.' };
  if (input.signal?.aborted) return { status: 'failed', sourceHash, reason: 'Artifact preview was cancelled.' };
  activeSessions.add(input.sessionId);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const errors: string[] = [];
  const blockedRequests: string[] = [];
  const horizontalOverflow: string[] = [];
  const append = (target: string[], value: string): void => {
    if (target.length < 20 && !target.includes(value)) target.push(value.slice(0, 300));
  };
  const run = async (): Promise<ArtifactPreviewResult> => {
    const artifactDocument = parseArtifactDocument(input.html);
    const executable = executablePath(input);
    if (!executable)
      return { status: 'failed', sourceHash, reason: 'No existing system Chromium is available for artifact preview.' };
    browser = await chromium.launch({ executablePath: executable, headless: true, timeout: DEADLINE_MS });
    if (ended) {
      await browser.close();
      return { status: 'failed', sourceHash, reason: 'Artifact preview was cancelled.' };
    }
    const chromiumMajor = Number(browser.version().split('.')[0]);
    context = await browser.newContext({ serviceWorkers: 'block' });
    if (ended) {
      await context.close();
      return { status: 'failed', sourceHash, reason: 'Artifact preview was cancelled.' };
    }
    const origin = 'https://artifact-preview.invalid';
    const viewPath = '/00000000-0000-4000-8000-000000000001';
    const childUrl = `${origin}${viewPath}/frame/${sourceHash}`;
    let staticCapture = false;
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      if (request.method() !== 'GET' || (url !== `${origin}${viewPath}` && url !== childUrl)) {
        // URLs may contain private information; report the resource kind and scheme only.
        append(blockedRequests, `${request.resourceType()}:${new URL(url).protocol}`);
        await route.abort('blockedbyclient');
        return;
      }
      const nonce = randomBytes(24).toString('base64url');
      const response =
        url === childUrl
          ? renderArtifactChild({ document: artifactDocument, nonce })
          : renderArtifactViewer({
              document: artifactDocument,
              nonce,
              title: input.title ?? 'Artifact preview',
              childUrl,
            });
      // Removing only the enforcement header deliberately exercises the same conservative static fallback.
      const headers = { ...response.headers };
      if (staticCapture) delete headers['connection-allowlist'];
      await route.fulfill({ status: 200, headers, body: response.body });
    });
    const images: ArtifactPreviewImage[] = [];
    let interactionAvailable = chromiumMajor >= ARTIFACT_MIN_CHROMIUM;
    for (const mode of ['interactive', 'static'] as const) {
      staticCapture = mode === 'static';
      for (const viewport of VIEWPORTS) {
        const page = await context.newPage();
        try {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          page.on('pageerror', (error) => append(errors, error.message));
          page.on('console', (message) => {
            const text = message.text();
            // CSP may refuse an attempted resource before Playwright emits a network request.
            // Keep only a directive name, never the console text or its target URL.
            if (text.includes('Content Security Policy') && /blocked|violates/iu.test(text)) {
              const directive = /directive: "([a-z-]+)/u.exec(text)?.[1];
              append(blockedRequests, directive ? `csp:${directive}` : 'csp');
            }
          });
          page.on('requestfailed', (request) =>
            append(blockedRequests, `${request.resourceType()}:${new URL(request.url()).protocol}`),
          );
          await page.goto(`${origin}${viewPath}`, { waitUntil: 'load', timeout: DEADLINE_MS });
          const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
          if (!frame) throw new Error('Artifact frame did not load.');
          await frame
            .waitForFunction(() => document.documentElement.dataset.artifactMode === 'interactive', undefined, {
              timeout: 1_200,
            })
            .catch((_error: unknown) => undefined);
          const interactive = (await frame.locator('html').getAttribute('data-artifact-mode')) === 'interactive';
          if (mode === 'interactive') interactionAvailable &&= interactive;
          const overflow = await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
          if (overflow) append(horizontalOverflow, `${mode}:${viewport.name}`);
          images.push({
            viewport: viewport.name,
            mode: interactive ? 'interactive' : 'static',
            mimeType: 'image/png',
            data: (await page.screenshot({ type: 'png' })).toString('base64'),
          });
        } finally {
          await page.close();
        }
      }
    }
    return {
      status: 'previewed',
      sourceHash,
      images,
      diagnostics: { errors, blockedRequests, horizontalOverflow, chromiumMajor, interactionAvailable },
    };
  };
  try {
    const interruption = new Promise<ArtifactPreviewResult>((resolve) => {
      cancel = () => {
        ended = true;
        resolve({
          status: 'failed',
          sourceHash,
          reason: input.signal?.aborted
            ? 'Artifact preview was cancelled.'
            : 'Artifact preview exceeded its 15-second deadline.',
        });
      };
      timer = setTimeout(cancel, DEADLINE_MS);
      input.signal?.addEventListener('abort', cancel, { once: true });
    });
    return await Promise.race([run(), interruption]);
  } catch (_error: unknown) {
    return {
      status: 'failed',
      sourceHash,
      reason: 'Artifact preview failed. Check that the source is supported and system Chromium can launch.',
    };
  } finally {
    ended = true;
    clearTimeout(timer);
    if (cancel) input.signal?.removeEventListener('abort', cancel);
    // Close the browser first: this also interrupts an unresponsive authored script or outstanding screenshot.
    await browser?.close().catch((_error: unknown) => undefined);
    activeSessions.delete(input.sessionId);
  }
}
