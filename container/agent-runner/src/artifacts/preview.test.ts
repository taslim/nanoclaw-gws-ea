import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { previewArtifact } from './preview.js';
const configuredChrome = process.env.ARTIFACT_TEST_CHROMIUM || process.env.GWS_EA_BROWSER_TEST_CHROME;
const executablePath =
  configuredChrome ??
  [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (configuredChrome && !existsSync(configuredChrome))
  throw new Error(`Configured artifact test Chromium is missing: ${configuredChrome}`);
const html =
  '<!doctype html><html><head><style>body{font:20px system-ui;margin:20px}svg{max-width:100%}</style></head><body><h1>Quarterly budget</h1><p>Base amount: $42</p><button id="up">Increase</button><output>42</output><script>document.querySelector("#up").onclick=()=>document.querySelector("output").textContent="84";</script></body></html>';
describe('artifact preview', () => {
  it('rejects a changed source hash and pre-cancelled work without starting Chromium', async () => {
    expect((await previewArtifact({ sessionId: 'hash', html, expectedHash: '0'.repeat(64) })).status).toBe('failed');
    const abort = new AbortController();
    abort.abort();
    const result = await previewArtifact({ sessionId: 'cancel', html, signal: abort.signal });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.reason).toContain('cancelled');
  });
  it.skipIf(!executablePath)(
    'captures actual desktop/mobile interaction and fallback within its deadline, rejects concurrency, and releases the session',
    async () => {
      const start = performance.now();
      const pending = previewArtifact({ sessionId: 'captures', html, executablePath });
      expect((await previewArtifact({ sessionId: 'captures', html, executablePath })).status).toBe('busy');
      const result = await pending;
      expect(result.status).toBe('previewed');
      if (result.status !== 'previewed') throw new Error(result.reason);
      expect(result.sourceHash).toBe(createHash('sha256').update(html).digest('hex'));
      expect(result.images.map((image) => `${image.mode}:${image.viewport}`)).toEqual([
        'interactive:desktop',
        'interactive:mobile',
        'static:desktop',
        'static:mobile',
      ]);
      for (const image of result.images)
        expect(Buffer.from(image.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(result.diagnostics.interactionAvailable).toBe(true);
      expect(result.diagnostics.errors).toEqual([]);
      expect(result.diagnostics.horizontalOverflow).toEqual([]);
      expect(performance.now() - start).toBeLessThan(15_000);
      const retry = await previewArtifact({ sessionId: 'captures', html: '<iframe></iframe>', executablePath });
      expect(retry.status).toBe('failed');
      if (retry.status === 'failed') expect(retry.reason).not.toContain('already active');
    },
    20_000,
  );
  it.skipIf(!executablePath)(
    'closes cancelled running work and allows the next request',
    async () => {
      const abort = new AbortController();
      const pending = previewArtifact({
        sessionId: 'abort-running',
        html: '<!doctype html><h1>Information</h1><script>while(true){}</script>',
        executablePath,
        signal: abort.signal,
      });
      setTimeout(() => abort.abort(), 600);
      const result = await pending;
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.reason).toContain('cancelled');
      const retry = await previewArtifact({ sessionId: 'abort-running', html: '<form></form>', executablePath });
      expect(retry.status).toBe('failed');
      if (retry.status === 'failed') expect(retry.reason).not.toContain('already active');
    },
    5_000,
  );
  it.skipIf(!executablePath)(
    'enforces its deadline on unresponsive authored JavaScript and cleans up',
    async () => {
      const started = performance.now();
      const result = await previewArtifact({
        sessionId: 'deadline',
        html: '<!doctype html><h1>Information</h1><script>while(true){}</script>',
        executablePath,
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.reason).toContain('15-second deadline');
      expect(performance.now() - started).toBeLessThan(17_000);
      const retry = await previewArtifact({ sessionId: 'deadline', html: '<form></form>', executablePath });
      expect(retry.status).toBe('failed');
      if (retry.status === 'failed') expect(retry.reason).not.toContain('already active');
    },
    20_000,
  );
  it.skipIf(!executablePath)(
    'reports authored JavaScript errors, blocked requests and overflow without exposing target URLs',
    async () => {
      const result = await previewArtifact({
        sessionId: 'diagnostics',
        executablePath,
        html: '<!doctype html><style>body{width:2000px}</style><h1>Wide content</h1><script>fetch("https://blocked.invalid/private-value").catch(()=>{});throw new Error("Preview fixture exception")</script>',
      });
      expect(result.status).toBe('previewed');
      if (result.status !== 'previewed') throw new Error(result.reason);
      expect(result.diagnostics.errors).toContain('Preview fixture exception');
      expect(result.diagnostics.blockedRequests.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.diagnostics.blockedRequests)).not.toContain('private-value');
      expect(result.diagnostics.horizontalOverflow).toContain('interactive:mobile');
      expect(result.diagnostics.horizontalOverflow).toContain('static:mobile');
    },
    10_000,
  );
});
