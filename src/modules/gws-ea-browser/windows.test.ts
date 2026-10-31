import { readFile, readdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';

import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import type { ChromeConnection } from './connection.js';
import { JobWindows } from './windows.js';
import { retainBrowserUpload } from './files.js';

function fixture(injectPopup = false, failSetup = false) {
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
      send: async (method: string) => {
        if (failSetup && method === 'Page.setInterceptFileChooserDialog') throw new Error('Page setup failed');
        return { targetInfo: { targetId: targets.get(page) } };
      },
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
      frames: () => [],
      isClosed: () => closed,
      on: pageEvents.on.bind(pageEvents),
      once: pageEvents.once.bind(pageEvents),
      off: pageEvents.off.bind(pageEvents),
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
        if (method === 'Target.closeTarget') {
          const target = (parameters as { targetId: string }).targetId;
          await pages.find((page) => targets.get(page) === target)?.close();
          return { success: true };
        }
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
  it('bounds a stalled page close while retaining its upload until the page actually closes', async () => {
    const { windows } = fixture();
    const first = await windows.pageForJob('first');
    const other = await windows.pageForJob('other');
    const remove = vi.fn(async () => undefined);
    retainBrowserUpload(first, { path: '/synthetic-staging/upload', remove });
    const originalClose = first.close.bind(first);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.spyOn(first, 'close').mockImplementationOnce(async () => {
      await blocked;
      await originalClose();
    });
    vi.useFakeTimers();
    let complete = false;
    const closing = windows.closeJob('first').then(() => {
      complete = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(complete).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(complete).toBe(true);
      expect(windows.jobs()).toEqual(['other']);
      expect(other.isClosed()).toBe(false);
      expect(remove).not.toHaveBeenCalled();
      release();
      await close.mock.results[0]?.value;
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      release();
      await closing;
      await windows.close();
      vi.useRealTimers();
    }
  });

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
    expect(windows.jobs()).toEqual(['second']);
    await windows.close();
    expect(second.isClosed()).toBe(true);
    expect(windows.size).toBe(0);
  });
  it('binds its page to the returned target id even if an unrelated popup event arrives first', async () => {
    const { windows, pages } = fixture(true);
    expect(await windows.pageForJob('job')).toBe(pages[0]);
    await windows.close();
  });
  it('closes its created target if page security setup fails', async () => {
    const { windows, pages } = fixture(true, true);
    await expect(windows.pageForJob('job')).rejects.toThrow('Page setup failed');
    expect(pages[0].isClosed()).toBe(true);
    expect(windows.size).toBe(0);
  });
  it('has no OS focus, foreground-target or trace path in runtime source', async () => {
    const names = await readdir(new URL('.', import.meta.url));
    for (const name of names.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = await readFile(new URL(name, import.meta.url), 'utf8');
      expect(source, name).not.toMatch(
        /\bbringToFront\s*\(|['"]Target\.activateTarget['"]|--enable-automation|--remote-allow-origins|\btracing\s*\./,
      );
      expect(source, name).not.toMatch(/\bpage\.route\s*\(|\bcontext\.newPage\s*\(/);
    }
  });
});
