import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectors, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { prepareChromeProfile, spawnChrome } from './chrome.js';
import { connectChromePipe, type ChromeConnection } from './connection.js';
import { browserPaths } from './paths.js';
import { withSignedOutBrowserPage } from './signed-out.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
describe.skipIf(!chromePath)('native signed-out watch pages', { timeout: 30_000 }, () => {
  let root: string;
  let connection: ChromeConnection;

  beforeAll(async () => {
    if (!chromePath) throw new Error('A Chromium executable is required.');
    root = await mkdtemp(join(tmpdir(), 'nanoclaw-signed-out-native-'));
    const paths = browserPaths(join(root, 'browser', 'policy.json'));
    await prepareChromeProfile(paths);
    connection = await connectChromePipe(spawnChrome({ chromePath, paths, proxyUrl: 'http://127.0.0.1:9' }), paths);
    await connection.context.addCookies([
      { name: 'assistant-session', value: 'persistent-only', url: 'https://fixture.example' },
    ]);
  });

  afterAll(async () => {
    await connection?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('uses an isolated native context and closes it after returning without touching the persistent account', async () => {
    let ephemeral: BrowserContext | undefined;
    let observed: Page | undefined;
    const result = await withSignedOutBrowserPage(connection, async (page) => {
      ephemeral = page.context();
      observed = page;
      expect(ephemeral).not.toBe(connection.context);
      expect(page.viewportSize()).toBeNull();
      expect(await ephemeral.cookies('https://fixture.example')).toEqual([]);
      await ephemeral.addCookies([{ name: 'watch-only', value: 'discard-me', url: 'https://fixture.example' }]);
      return 'checked';
    });
    expect(result).toBe('checked');
    expect(observed?.isClosed()).toBe(true);
    expect(connection.browser.contexts()).not.toContain(ephemeral);
    expect(await connection.context.cookies('https://fixture.example')).toEqual([
      expect.objectContaining({ name: 'assistant-session', value: 'persistent-only' }),
    ]);
  });

  it('reuses registered native selector engines across periodic checks', async () => {
    const registration = vi.spyOn(selectors, 'register');
    try {
      await withSignedOutBrowserPage(connection, async () => undefined);
      await withSignedOutBrowserPage(connection, async () => undefined);
      expect(registration).not.toHaveBeenCalled();
    } finally {
      registration.mockRestore();
    }
  });

  it('closes the ephemeral page and context when the check throws', async () => {
    let observed: Page | undefined;
    await expect(
      withSignedOutBrowserPage(connection, async (page) => {
        observed = page;
        throw new Error('fixture check failed');
      }),
    ).rejects.toThrow('fixture check failed');
    expect(observed?.isClosed()).toBe(true);
    expect(connection.browser.contexts()).toEqual([connection.context]);
  });

  it('allows checks to overlap while keeping their browser contexts and pages distinct', async () => {
    const contexts = new Set<BrowserContext>();
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const check = () =>
      withSignedOutBrowserPage(connection, async (page) => {
        contexts.add(page.context());
        entered += 1;
        if (entered === 2) release();
        await bothEntered;
        expect(page.isClosed()).toBe(false);
      });
    await Promise.all([check(), check()]);
    expect(contexts.size).toBe(2);
    expect(connection.browser.contexts()).toEqual([connection.context]);
  });

  it('retains WebRTC and external-protocol protection and denies clipboard permissions and downloads', async () => {
    await withSignedOutBrowserPage(connection, async (page) => {
      const permissions: unknown = await page.evaluate(`(async () => {
        const result = [];
        for (const name of ['clipboard-read', 'clipboard-write', 'local-network-access']) {
          result.push((await navigator.permissions.query({ name })).state);
        }
        return result;
      })()`);
      expect(permissions).toEqual(['denied', 'denied', 'denied']);
      const candidates: unknown = await page.evaluate(`(async () => {
        const peer = new RTCPeerConnection({ iceServers: [] });
        const found = [];
        peer.createDataChannel('signed-out-test');
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ICE did not complete')), 3_000);
            peer.onicecandidate = ({ candidate }) => {
              if (candidate) found.push(candidate.candidate);
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
          return found;
        } finally {
          peer.close();
        }
      })()`);
      expect(candidates).toEqual([]);
      await page.setContent('<a href="data:text/plain,watch-fixture" download="should-not-save.txt">Download</a>');
      const started = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download', exact: true }).click();
      const download = await started;
      expect(await download.failure()).not.toBeNull();
      await expect(page.goto('nanoclaw-signed-out-test://no-registered-handler')).rejects.toThrow(
        'ERR_BLOCKED_BY_ADMINISTRATOR',
      );
    });
  });
});
