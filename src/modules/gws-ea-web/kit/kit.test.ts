import fs from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { afterEach, expect, it } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { DENY, defineGuardedAction } from '../../../guard/index.js';
import '../../gws-ea-profile/index.js';
import type { PrincipalPageMount, WebMountPath } from '../mounts.js';
import {
  escapeHtml,
  InvalidSubmission,
  pageHeaders,
  pageNonce,
  readShell,
  readSubmission,
  refuse,
  renderCopyButton,
  renderMenu,
  renderPrincipalPage,
  sameOriginJson,
  sendJson,
  sendPage,
  sendUnavailable,
  type Shell,
} from './index.js';

const HOST = 'juno.example.test';
const linkGuard = defineGuardedAction({ action: 'test.kit-link', decide: () => DENY('test') });
const shell: Shell = {
  assistantName: 'Juno <Hale>',
  pages: [
    { title: 'Home', path: '/' },
    { title: 'Logins', path: '/logins' },
  ],
};
let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function page(name: string, mountPath: WebMountPath, title: string): PrincipalPageMount {
  return {
    name,
    audience: 'principal',
    path: mountPath,
    methods: ['GET'],
    title,
    status: async () => '',
    linkGuard,
    handler: () => () => undefined,
  };
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
async function serve(listener: RequestListener, method = 'GET', body?: string): Promise<Reply> {
  server = createServer(listener);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: address.port, method, path: '/' }, (response) => {
      let output = '';
      response.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: output }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function incoming(headers: Readonly<Record<string, string>>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function sample(nonce: string): string {
  return renderPrincipalPage(
    {
      shell,
      page: '/logins',
      title: 'Saved logins',
      view: 'list',
      outcome: 'Saved <now>.',
      error: false,
      content: `<form method="post" action="/logins/remove" data-send data-confirm-title="Remove login?" data-confirm-action="Remove login" data-confirm-message="Remove it?"><button class="button" type="submit" id="remove">Remove</button></form>${renderMenu(
        'actions-menu',
        'Actions',
        [
          '<button type="button" role="menuitem" tabindex="-1">Rename</button>',
          '<form method="post" action="/logins/remove" data-send data-confirm-title="Delete?" data-confirm-action="Delete" data-confirm-message="Delete it?"><button type="submit" role="menuitem" tabindex="-1">Delete</button></form>',
        ],
      )}<code id="redirect-uri">https://${HOST}/callback</code>${renderCopyButton('redirect-uri', 'Copy redirect URI')}`,
    },
    nonce,
  );
}

it('sends no-store, nosniff, a nonce CSP and no framing on every kind of kit response', async () => {
  const nonce = pageNonce();
  const responses = [
    await serve((_request, response) => refuse(response)),
    await serve((_request, response) => sendUnavailable(response)),
    await serve((_request, response) => sendJson(response, 409, { error: 'Changed.' })),
    await serve((_request, response) =>
      sendPage(response, { status: 200, nonce, body: sample(nonce), location: '/logins', saved: true }),
    ),
  ];
  for (const response of responses) {
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['content-security-policy']).toMatch(
      /^default-src 'none'; script-src '(?:nonce-[\w-]+|none)'/u,
    );
  }
  expect(responses[0]).toMatchObject({ status: 404, body: '' });
  expect(responses[3].headers['content-security-policy']).toContain(
    `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
  );
  expect(responses[3].headers['x-page-location']).toBe('/logins');
  expect(responses[3].headers['x-page-saved']).toBe('true');
  expect(pageHeaders()['content-security-policy']).toContain("script-src 'none'; style-src 'none'");
});

it('accepts a change only as bounded same-origin JSON', () => {
  const json = { 'content-type': 'application/json' };
  expect(sameOriginJson(incoming({ ...json, 'sec-fetch-site': 'same-origin' }), HOST)).toBe(true);
  expect(sameOriginJson(incoming({ ...json, origin: `https://${HOST}` }), HOST)).toBe(true);
  for (const headers of [
    { ...json, 'sec-fetch-site': 'cross-site', origin: `https://${HOST}` },
    { ...json, 'sec-fetch-site': 'same-site' },
    { ...json, origin: 'https://remy.example.test' },
    json,
    { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' },
    { ...json, 'sec-fetch-site': 'same-origin', 'content-length': '16385' },
  ])
    expect(sameOriginJson(incoming(headers), HOST), JSON.stringify(headers)).toBe(false);
});

it('reads one JSON object of at most 16 KiB and refuses anything else', async () => {
  const read = async (body: string): Promise<unknown> => {
    let result: unknown;
    await serve(
      (request, response) => {
        void readSubmission(request).then(
          (value) => {
            result = value;
            response.end();
          },
          (error: unknown) => {
            result = error;
            response.end();
          },
        );
      },
      'POST',
      body,
    );
    return result;
  };
  expect(await read('{"handle":"x"}')).toEqual({ handle: 'x' });
  for (const body of ['{', '[]', 'null', '"text"', JSON.stringify({ padding: 'x'.repeat(16 * 1024) })])
    expect(await read(body)).toBeInstanceOf(InvalidSubmission);
});

it('draws the shell with the escaped assistant name and the current page marked', () => {
  const html = sample('nonce-value');
  expect(html).toContain(
    '<p class="shell-name"><span class="shell-mark" aria-hidden="true">J</span><span>Juno &lt;Hale&gt;</span></p>',
  );
  expect(html).toContain('<a href="/" data-navigation>Home</a>');
  expect(html).toContain('<a href="/logins" data-navigation aria-current="page">Logins</a>');
  expect(html).toContain('<title>Saved logins · Logins · Juno &lt;Hale&gt;</title>');
  expect(html).toContain('>Saved &lt;now&gt;.</p>');
  expect(html).toContain('<p id="announcer" class="sr-only" role="status" aria-live="polite"></p>');
  expect(html.match(/nonce="nonce-value"/gu)).toHaveLength(2);
  expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
});

it('reads the assistant name and lists home first, then pages in registration order', async () => {
  await runMigrations(await initTestDb());
  try {
    const pages = [page('logins', '/logins', 'Logins'), page('home', '/', 'Home'), page('apps', '/apps', 'Apps')];
    expect(await readShell(pages)).toEqual({
      assistantName: 'Your assistant',
      pages: [
        { title: 'Home', path: '/' },
        { title: 'Logins', path: '/logins' },
        { title: 'Apps', path: '/apps' },
      ],
    });
    await getDb().run("UPDATE gws_ea_profile SET assistant_first_name = 'Juno', assistant_last_name = 'Hale'");
    expect((await readShell(pages)).assistantName).toBe('Juno Hale');
  } finally {
    await closeDb();
  }
});

it('keeps artifact viewing outside the shell', () => {
  const artifacts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gws-ea-artifacts');
  const importers = fs
    .readdirSync(artifacts)
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => /gws-ea-web\/kit\//u.test(fs.readFileSync(path.join(artifacts, file), 'utf8')));
  expect(importers).toEqual([]);
});

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
it.skipIf(!chromePath).each([320, 1200])(
  'keeps dialogs and menus keyboard-operable and announces copies in Chrome at %ipx',
  async (width) => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    try {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `https://${HOST}` });
      const sent: string[] = [];
      await context.route(`https://${HOST}/**`, async (route) => {
        if (route.request().method() === 'POST') sent.push(new URL(route.request().url()).pathname);
        const nonce = pageNonce();
        await route.fulfill({ status: 200, headers: { ...pageHeaders(nonce) }, body: sample(nonce) });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(`https://${HOST}/logins`);
      const focused = (): Promise<string> =>
        page.evaluate<string>(
          "document.activeElement.id || document.activeElement.getAttribute('aria-label') || document.activeElement.textContent",
        );

      expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      expect(
        await page.evaluate<string[]>(
          `[...document.querySelectorAll('.shell-nav a, button')].filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44); }).map(element => element.getAttribute('aria-label') || element.textContent)`,
        ),
      ).toEqual([]);

      await page.locator('#remove').focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Remove login?' });
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain('Remove it?');
      expect(await focused()).toBe('confirm-cancel');
      await page.keyboard.press('Tab');
      expect(await focused()).toBe('confirm-action');
      await page.keyboard.press('Tab');
      expect(await focused()).toBe('confirm-cancel');
      await page.keyboard.press('Shift+Tab');
      expect(await focused()).toBe('confirm-action');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      expect(await focused()).toBe('remove');
      expect(sent).toEqual([]);

      const menuButton = page.getByRole('button', { name: 'Actions' });
      await menuButton.focus();
      await page.keyboard.press('ArrowDown');
      expect(await menuButton.getAttribute('aria-expanded')).toBe('true');
      expect(await focused()).toBe('Rename');
      await page.keyboard.press('ArrowDown');
      expect(await focused()).toBe('Delete');
      await page.keyboard.press('ArrowDown');
      expect(await focused()).toBe('Rename');
      await page.keyboard.press('End');
      expect(await focused()).toBe('Delete');
      await page.keyboard.press('Escape');
      expect(await page.getByRole('menu').isHidden()).toBe(true);
      expect(await focused()).toBe('Actions');
      await page.keyboard.press('ArrowUp');
      expect(await focused()).toBe('Delete');
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Delete?' }).waitFor();
      expect(await page.getByRole('menu').isHidden()).toBe(true);
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      expect(await focused()).toBe('Actions');
      expect(sent).toEqual([]);

      await page.getByRole('button', { name: 'Copy redirect URI' }).click();
      await expect.poll(() => page.locator('#announcer').textContent()).toBe('Copied.');
      expect(await page.getByRole('button', { name: 'Copy redirect URI' }).textContent()).toBe('Copied');
      expect(await page.evaluate<string>('navigator.clipboard.readText()')).toBe(`https://${HOST}/callback`);

      await page.locator('#remove').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Remove login' }).click();
      await expect.poll(() => sent).toEqual(['/logins/remove']);
      await context.close();
    } finally {
      await browser.close();
    }
  },
  30_000,
);
