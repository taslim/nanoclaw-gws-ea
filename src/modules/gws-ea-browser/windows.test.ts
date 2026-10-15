import { readFile, readdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';

import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import type { ChromeConnection } from './connection.js';
import { BROWSER_WINDOW_IDLE_MS, JobWindows } from './windows.js';

function fixture(injectPopup = false) {
  const events = new EventEmitter();
  const pages: Page[] = [];
  const targets = new WeakMap<Page, string>();
  const sends: { method: string; parameters: unknown }[] = [];
  const context = {
    waitForEvent: (_event: string, options: { predicate: (page: Page) => Promise<boolean> }) =>
      new Promise<Page>((resolve, reject) => {
        const listener = (page: Page): void => {
          void options.predicate(page).then((matches) => {
            if (matches) {
              events.off('page', listener);
              resolve(page);
            }
          }, reject);
        };
        events.on('page', listener);
      }),
    newCDPSession: async (page: Page) => ({
      send: async () => ({ targetInfo: { targetId: targets.get(page) } }),
      detach: async () => undefined,
    }),
  };
  function createPage(target: string): Page {
    const pageEvents = new EventEmitter();
    let closed = false;
    const page = {
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      viewportSize: () => null,
      isClosed: () => closed,
      on: pageEvents.on.bind(pageEvents),
      once: pageEvents.once.bind(pageEvents),
      context: () => context,
      async close() {
        closed = true;
        pageEvents.emit('close');
      },
    } as unknown as Page;
    targets.set(page, target);
    return page;
  }
  const connection = {
    context,
    session: {
      async send(method: string, parameters: unknown) {
        sends.push({ method, parameters });
        const targetId = `target-${pages.length + 1}`;
        if (injectPopup) events.emit('page', createPage('unrelated-popup'));
        const page = createPage(targetId);
        pages.push(page);
        events.emit('page', page);
        return { targetId };
      },
    },
  } as unknown as ChromeConnection;
  return { windows: new JobWindows(connection), sends, pages };
}

describe('quiet job windows', () => {
  it('creates simultaneous jobs in distinct background windows and reuses only their own page', async () => {
    const { windows, sends } = fixture();
    const [first, second] = await Promise.all([windows.pageForJob('first'), windows.pageForJob('second')]);
    expect(first).not.toBe(second);
    expect(await windows.pageForJob('first')).toBe(first);
    expect(sends).toEqual(
      Array.from({ length: 2 }, () => ({
        method: 'Target.createTarget',
        parameters: { url: 'about:blank', newWindow: true, background: true },
      })),
    );
    await windows.closeJob('first');
    expect(first.isClosed()).toBe(true);
    expect(second.isClosed()).toBe(false);
    await windows.closeIdle(Date.now() + BROWSER_WINDOW_IDLE_MS);
    expect(second.isClosed()).toBe(true);
    expect(windows.size).toBe(0);
  });
  it('binds its page to the returned target id even if an unrelated popup event arrives first', async () => {
    const { windows, pages } = fixture(true);
    expect(await windows.pageForJob('job')).toBe(pages[0]);
    await windows.close();
  });
  it('has no OS focus, foreground-target, port or trace path in runtime source', async () => {
    const names = await readdir(new URL('.', import.meta.url));
    for (const name of names.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = await readFile(new URL(name, import.meta.url), 'utf8');
      expect(source, name).not.toMatch(
        /\bbringToFront\s*\(|['"]Target\.activateTarget['"]|--remote-debugging-port|--enable-automation|--remote-allow-origins|\btracing\s*\./,
      );
      expect(source, name).not.toMatch(/\bpage\.route\s*\(|\bcontext\.newPage\s*\(/);
    }
  });
});
