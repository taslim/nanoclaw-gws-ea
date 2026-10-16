import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ElementHandle, Frame, Page } from 'playwright-core';

import { inspectAuthenticationControl, submitAuthenticationForm } from './authentication-signatures.js';
import { prepareAuthenticationIsolation } from './authentication-submit.js';
import { prepareChromeProfile, spawnChrome } from './chrome.js';
import { connectChromePipe, type ChromeConnection } from './connection.js';
import { browserPaths } from './paths.js';

type Location = 'top' | 'same-origin-frame' | 'cross-origin-frame' | 'shadow' | 'ambiguous-frame';
interface Fixture {
  page: Page;
  frame: Frame;
  control: ElementHandle;
  callbacks: string[];
  posts: { url: string; body: string | null }[];
}

// The native-world boundary needs a real Chromium renderer. CI can opt in with its
// Chromium executable; local acceptance uses the same headed Chrome as production.
const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
describe.skipIf(!chromePath)('native authentication submission', () => {
  let root: string;
  let connection: ChromeConnection;

  beforeAll(async () => {
    if (!chromePath) throw new Error('A Chromium executable is required.');
    root = await mkdtemp(join(tmpdir(), 'nanoclaw-auth-native-'));
    const paths = browserPaths(join(root, 'browser', 'policy.json'));
    await prepareChromeProfile(paths);
    connection = await connectChromePipe(spawnChrome({ chromePath, paths, proxyUrl: 'http://127.0.0.1:9' }), paths);
    await prepareAuthenticationIsolation(connection.context);
  });

  afterAll(async () => {
    await connection?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const form = (id: string): string => `
    <form id="${id}" method="post" action="/login">
      <input name="which" type="hidden" value="${id}">
      <input name="username" autocomplete="username">
      <input name="password" type="password" autocomplete="current-password">
      <button id="${id}-submit" type="submit">Sign in</button>
    </form>`;
  const poison = `<script>
    HTMLFormElement.prototype.submit = function () { authCallback('prototype'); };
    EventTarget.prototype.dispatchEvent = function () { authCallback('dispatch'); return false; };
    window.Event = function () { authCallback('event'); throw new Error('page Event'); };
    document.addEventListener('click', () => authCallback('click'));
    document.addEventListener('submit', () => authCallback('submit'));
  </script>`;

  async function withFixture(location: Location, operation: (fixture: Fixture) => Promise<void>): Promise<void> {
    const callbacks: string[] = [];
    const posts: Fixture['posts'] = [];
    const appeared = connection.context.waitForEvent('page');
    await connection.session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
    const page = await appeared;
    await page.exposeFunction('authCallback', (kind: string) => callbacks.push(kind));
    const inFrame = location.endsWith('frame');
    await connection.context.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        posts.push({ url: request.url(), body: request.postData() });
        await route.fulfill({ contentType: 'text/html', body: '<body>Signed in</body>' });
      } else if (new URL(request.url()).pathname === '/host') {
        const origin = location === 'cross-origin-frame' ? 'https://frame.example' : 'https://auth.example';
        const iframe = `<iframe src="${origin}/frame"></iframe>`;
        await route.fulfill({ contentType: 'text/html', body: iframe.repeat(location === 'ambiguous-frame' ? 2 : 1) });
      } else {
        const forms = `${form('other')}${form('chosen')}`;
        const body =
          location === 'shadow'
            ? `<body><script>document.body.attachShadow({mode:'open'}).innerHTML = ${JSON.stringify(forms)};</script>${poison}`
            : `${forms}${poison}`;
        await route.fulfill({ contentType: 'text/html', body });
      }
    });
    try {
      await page.goto(`https://auth.example/${inFrame ? 'host' : 'login'}`);
      const frame = inFrame ? page.frames().find((candidate) => candidate.parentFrame()) : page.mainFrame();
      if (!frame) throw new Error('The fixture frame is missing.');
      const control = await frame.locator('#chosen-submit').elementHandle();
      if (!control) throw new Error('The fixture control is missing.');
      try {
        await operation({ page, frame, control, callbacks, posts });
      } finally {
        await control.dispose();
      }
    } finally {
      await page.close();
      await connection.context.unrouteAll({ behavior: 'wait' });
    }
  }

  for (const location of ['top', 'same-origin-frame', 'cross-origin-frame', 'shadow'] as const) {
    it(`submits the exact chosen form in ${location} without page prototype or submit callbacks`, async () => {
      await withFixture(location, async ({ page, frame, control, callbacks, posts }) => {
        if (location === 'cross-origin-frame') {
          // Assert the fixture exercises an out-of-process frame, rather than
          // silently covering only same-process iframe mapping twice.
          const session = await connection.context.newCDPSession(frame);
          await session.detach();
        }
        const signature = await inspectAuthenticationControl(control);
        if (!signature) throw new Error('The native authentication signature was refused.');
        await frame.locator('#chosen input[name=password]').focus();
        await page.keyboard.insertText('host-only-fixture-secret');
        expect(await submitAuthenticationForm(signature)).toBe(true);
        await expect.poll(() => posts.length, { timeout: 1_500 }).toBe(1);
        expect(posts).toEqual([
          {
            url: `${location === 'cross-origin-frame' ? 'https://frame.example' : 'https://auth.example'}/login`,
            body: 'which=chosen&username=&password=host-only-fixture-secret',
          },
        ]);
        expect(callbacks).toEqual([]);
      });
    });
  }

  for (const drift of ['action', 'fields', 'form'] as const) {
    it(`refuses ${drift} drift without substituting the other matching form`, async () => {
      await withFixture('top', async ({ page, control, callbacks, posts }) => {
        const signature = await inspectAuthenticationControl(control);
        if (!signature) throw new Error('The native authentication signature was refused.');
        await page.evaluate(`(() => {
          const form = document.getElementById('chosen');
          if (${JSON.stringify(drift)} === 'action') form.action = '/checkout';
          else if (${JSON.stringify(drift)} === 'fields') {
            const field = document.createElement('input'); field.name = 'cc-number'; form.append(field);
          } else {
            const replacement = form.cloneNode(true);
            replacement.querySelector('button').replaceWith(form.querySelector('button'));
            form.replaceWith(replacement);
          }
        })()`);
        expect(await submitAuthenticationForm(signature)).toBe(false);
        expect(posts).toEqual([]);
        expect(callbacks).toEqual([]);
      });
    });
  }

  it('refuses a document replaced during the last asynchronous liveness check', async () => {
    await withFixture('top', async ({ page, control, callbacks, posts }) => {
      const signature = await inspectAuthenticationControl(control);
      if (!signature) throw new Error('The native authentication signature was refused.');
      expect(
        await submitAuthenticationForm(signature, async () => {
          await page.goto('https://other.example/login');
        }),
      ).toBe(false);
      expect(posts).toEqual([]);
      expect(callbacks).toEqual([]);
    });
  });

  it('refuses ambiguous same-URL sibling frames before any submission', async () => {
    await withFixture('ambiguous-frame', async ({ control, callbacks, posts }) => {
      expect(await inspectAuthenticationControl(control)).toBeUndefined();
      expect(posts).toEqual([]);
      expect(callbacks).toEqual([]);
    });
  });
});
