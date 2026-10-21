import { EventEmitter } from 'node:events';

import type { Browser, Page } from 'playwright-core';
import { expect, it, vi } from 'vitest';

import { documentGate, type GuardedPage, type PausedDocument } from './document-gate.js';

interface Tree {
  frame: { id: string };
  childFrames?: Tree[];
}
interface TargetFacts {
  type: string;
  subtype?: string;
  openerId?: string;
  openerFrameId?: string;
  parentFrameId?: string;
}
/** A page's targets: its own, rooted at its main frame, and one per out-of-process frame. */
interface PageFixture {
  tree: Tree;
  frames?: Tree[];
  unreadable?: boolean;
  silent?: boolean;
}

const tree = (id: string, ...children: string[]): Tree => ({
  frame: { id },
  childFrames: children.map((child) => ({ frame: { id: child } })),
});

/** Playwright pages and a browser session double; frames resolve only through what is given here. */
function fixture(
  targets: Record<string, TargetFacts>,
  fixtures: PageFixture[],
  lookup?: (targetId: string) => Promise<never> | undefined,
) {
  let paused: ((event: unknown) => void) | undefined;
  const answers = new Map<string, string>();
  const lookups: string[] = [];
  const pageSessions = { count: 0 };
  const gateSession = {
    on: (name: string, handler: (event: unknown) => void) => {
      if (name === 'Fetch.requestPaused') paused = handler;
    },
    send: async (method: string, params: { targetId?: string; requestId?: string } = {}) => {
      if (method === 'Target.getTargetInfo') {
        const targetId = String(params.targetId);
        lookups.push(targetId);
        const failing = lookup?.(targetId);
        if (failing) return failing;
        const target = targets[targetId];
        if (!target) throw new Error('Protocol error (Target.getTargetInfo): No target with given id found');
        return { targetInfo: { targetId, ...target } };
      }
      if (method === 'Target.getTargets')
        return { targetInfos: Object.entries(targets).map(([targetId, target]) => ({ targetId, ...target })) };
      if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest')
        answers.set(String(params.requestId), method === 'Fetch.continueRequest' ? 'continued' : 'refused');
      return {};
    },
  };
  const session = (page: PageFixture, root: () => Tree) => ({
    on: () => undefined,
    once: () => undefined,
    detach: async () => undefined,
    send: async (method: string) => {
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: root().frame.id } };
      if (method === 'Page.getFrameTree') {
        if (page.silent) return new Promise<never>(() => undefined);
        if (page.unreadable) throw new Error('Protocol error (Page.getFrameTree): Internal error');
        return { frameTree: root() };
      }
      return {};
    },
  });
  const pages = fixtures.map((page) => {
    const main = { isDetached: () => false };
    // Playwright's frame objects, one per out-of-process frame it currently lists.
    const listed = new Map<Tree, { isDetached(): boolean }>();
    const frameOf = (frame: Tree) => {
      let object = listed.get(frame);
      if (!object) listed.set(frame, (object = { isDetached: () => false }));
      return object;
    };
    const fake = {
      context: () => ({
        newCDPSession: async (target: unknown) => {
          if (target === fake) {
            pageSessions.count++;
            return session(page, () => page.tree);
          }
          const frame = (page.frames ?? []).find((candidate) => frameOf(candidate) === target);
          if (!frame)
            throw new Error(
              "This frame does not have a separate CDP session, it is a part of the parent frame's session",
            );
          return session(page, () => frame);
        },
      }),
      mainFrame: () => main,
      frames: () => [main, ...(page.frames ?? []).map(frameOf)],
      isClosed: () => false,
      on: () => undefined,
      once: () => undefined,
      off: () => undefined,
    } as unknown as Page;
    return fake;
  });
  const opens = { count: 0, fail: false };
  const browser = Object.assign(new EventEmitter(), {
    contexts: () => [{ pages: () => pages }],
    newBrowserCDPSession: async () => {
      opens.count++;
      if (opens.fail) throw new Error('Browser session unavailable');
      return gateSession;
    },
  });
  let next = 0;
  const pause = async (
    frameId: string,
    resourceType = 'Document',
    headers: Record<string, string> = {},
    method = 'GET',
  ) => {
    const requestId = String(next++);
    paused?.({ requestId, frameId, resourceType, request: { url: 'https://shop.example/', method, headers } });
    await vi.waitFor(() => expect(answers.has(requestId)).toBe(true), { timeout: 5_000 });
    return answers.get(requestId);
  };
  return { browser: browser as unknown as Browser & EventEmitter, pause, lookups, opens, pageSessions };
}

function guardedPage() {
  const decide = vi.fn(async (_document: PausedDocument) => ({ allow: true as const }));
  const refuse = vi.fn();
  const page: GuardedPage = { capture: () => ({ decide, refuse }) };
  return { page, decide, refuse };
}

it('places main, cross-site, nested and same-process frames, and windows, with their page, handing each its method and level', async () => {
  const { browser, pause } = fixture(
    {
      main: { type: 'page' },
      widget: { type: 'iframe', parentFrameId: 'main' },
      // A cross-site frame inside the widget's same-process child.
      nested: { type: 'iframe', parentFrameId: 'widget-child' },
      // A window the page opened from one of its frames.
      popup: { type: 'page', openerId: 'main', openerFrameId: 'main-child' },
    },
    [{ tree: tree('main', 'main-child'), frames: [tree('widget', 'widget-child')] }, { tree: tree('popup') }],
  );
  const guarded = guardedPage();
  (await documentGate(browser)).register('main', guarded.page);
  expect(await pause('main', 'Document', {}, 'POST')).toBe('continued');
  for (const frame of ['main-child', 'widget', 'widget-child', 'nested', 'popup'])
    expect(await pause(frame)).toBe('continued');
  // Each document carries its method; a frame's document and a window's are their page's to decide, but never its
  // own top-level document.
  expect(guarded.decide.mock.calls.map(([document]) => [document.method, document.topLevel])).toEqual([
    ['POST', true],
    ...Array.from({ length: 5 }, () => ['GET', false]),
  ]);
});

it('continues the documents of pages nobody guards or opened, and of the windows they open', async () => {
  const { browser, pause } = fixture(
    { main: { type: 'page' }, other: { type: 'page' }, window: { type: 'page', openerId: 'other' } },
    [{ tree: tree('main') }, { tree: tree('other', 'other-child') }, { tree: tree('window') }],
  );
  const guarded = guardedPage();
  (await documentGate(browser)).register('main', guarded.page);
  for (const frame of ['other', 'other-child', 'window']) expect(await pause(frame)).toBe('continued');
  expect(guarded.decide).not.toHaveBeenCalled();
});

it('places a frame with the page that hosts it when another guarded page cannot be read', async () => {
  const { browser, pause } = fixture({ one: { type: 'page' }, two: { type: 'page' } }, [
    { tree: tree('one'), unreadable: true },
    { tree: tree('two', 'two-child') },
  ]);
  const [one, two] = [guardedPage(), guardedPage()];
  const gate = await documentGate(browser);
  gate.register('one', one.page);
  gate.register('two', two.page);
  expect(await pause('two-child')).toBe('continued');
  expect(two.decide).toHaveBeenCalledTimes(1);
  expect(one.refuse).not.toHaveBeenCalled();
});

it('refuses what it cannot place, blaming only the pages it is uncertain about', async () => {
  const { browser, pause } = fixture(
    { one: { type: 'page' }, two: { type: 'page' }, worker: { type: 'service_worker' } },
    [{ tree: tree('one'), unreadable: true }, { tree: tree('two') }],
    (id) => (id === 'broken' ? Promise.reject(new Error('Protocol error: Internal error')) : undefined),
  );
  const [one, two] = [guardedPage(), guardedPage()];
  const gate = await documentGate(browser);
  gate.register('one', one.page);
  gate.register('two', two.page);
  // A same-process frame no readable page hosts may be the unreadable page's own.
  expect(await pause('unknown-child')).toBe('refused');
  expect([one.refuse.mock.calls.length, two.refuse.mock.calls.length]).toEqual([1, 0]);
  // A worker is no page's frame.
  expect(await pause('worker')).toBe('refused');
  expect([one.refuse.mock.calls.length, two.refuse.mock.calls.length]).toEqual([1, 0]);
  // A lookup that fails for any reason but a missing target rules out no guarded page.
  expect(await pause('broken')).toBe('refused');
  expect([one.refuse.mock.calls.length, two.refuse.mock.calls.length]).toEqual([2, 1]);
  expect(one.decide).not.toHaveBeenCalled();
  expect(two.decide).not.toHaveBeenCalled();
});

it('refuses a prerender and a frame no page hosts, blaming nobody', async () => {
  const { browser, pause } = fixture(
    { main: { type: 'page' }, prerendered: { type: 'page', subtype: 'prerender', openerId: 'main' } },
    [{ tree: tree('main') }],
  );
  const guarded = guardedPage();
  (await documentGate(browser)).register('main', guarded.page);
  expect(await pause('prerendered')).toBe('refused');
  expect(await pause('gone-child')).toBe('refused');
  expect(guarded.refuse).not.toHaveBeenCalled();
});

it('walks a parent loop once, and refuses a lookup that never answers within its bound', async () => {
  const { browser, pause } = fixture(
    { main: { type: 'page' }, a: { type: 'iframe', parentFrameId: 'b' }, b: { type: 'iframe', parentFrameId: 'a' } },
    [{ tree: tree('main') }],
    (id) => (id === 'silent' ? new Promise<never>(() => undefined) : undefined),
  );
  const guarded = guardedPage();
  (await documentGate(browser)).register('main', guarded.page);
  expect(await pause('a')).toBe('refused');
  expect(guarded.refuse).not.toHaveBeenCalled();
  expect(await pause('silent')).toBe('refused');
  expect(guarded.refuse).toHaveBeenCalledTimes(1);
});

it('refuses a service worker script and lets every other request through untouched', async () => {
  const { browser, pause, lookups } = fixture({ main: { type: 'page' } }, [{ tree: tree('main') }]);
  (await documentGate(browser)).register('main', guardedPage().page);
  expect(await pause('worker', 'Other', { 'Service-Worker': 'script' })).toBe('refused');
  expect(await pause('main', 'Other')).toBe('continued');
  expect(lookups).toEqual([]);
});

it('continues a document whose page registered its guard only after the document paused', async () => {
  let release!: () => void;
  const held = new Promise<never>((_resolve, reject) => {
    release = () => reject(new Error('Protocol error (Target.getTargetInfo): No target with given id found'));
  });
  // The lookup answers only after the page's guard registered.
  const { browser, pause } = fixture({}, [{ tree: tree('late') }], (id) => (id === 'late' ? held : undefined));
  const gate = await documentGate(browser);
  const guarded = guardedPage();
  const answer = pause('late');
  gate.register('late', guarded.page);
  release();
  expect(await answer).toBe('continued');
  expect(guarded.decide).not.toHaveBeenCalled();
});

it('places a same-process frame once, so its next document is decided without another read', async () => {
  const { browser, pause, lookups } = fixture({ main: { type: 'page' } }, [{ tree: tree('main', 'first') }]);
  const guarded = guardedPage();
  (await documentGate(browser)).register('main', guarded.page);
  expect(await pause('first')).toBe('continued');
  lookups.length = 0;
  expect(await pause('first')).toBe('continued');
  expect(lookups).toEqual([]);
  expect(guarded.decide).toHaveBeenCalledTimes(2);
});

it('covers an unguarded page once, however many placements read it at once', async () => {
  const { browser, pause, pageSessions } = fixture({ main: { type: 'page' } }, [{ tree: tree('main', 'a', 'b', 'c') }]);
  await documentGate(browser);
  expect(await Promise.all(['a', 'b', 'c'].map((frame) => pause(frame)))).toEqual([
    'continued',
    'continued',
    'continued',
  ]);
  expect(pageSessions.count).toBe(1);
});

it('forgets frames no page hosts any more', async () => {
  const fixtures: PageFixture[] = [{ tree: tree('main', 'first') }];
  const { browser, pause, lookups } = fixture({ main: { type: 'page' } }, fixtures);
  (await documentGate(browser)).register('main', guardedPage().page);
  expect(await pause('first')).toBe('continued');
  // The first child is gone; placing the next one reads every tree again and drops it.
  fixtures[0].tree.childFrames = [{ frame: { id: 'second' } }];
  expect(await pause('second')).toBe('continued');
  lookups.length = 0;
  expect(await pause('first')).toBe('refused');
  expect(lookups).toEqual(['first']);
});

it('opens again after an open that failed, and after its browser disconnected', async () => {
  const { browser, opens } = fixture({}, []);
  opens.fail = true;
  await expect(documentGate(browser)).rejects.toThrow('Browser session unavailable');
  opens.fail = false;
  const first = await documentGate(browser);
  expect(await documentGate(browser)).toBe(first);
  browser.emit('disconnected');
  expect(await documentGate(browser)).not.toBe(first);
  expect(opens.count).toBe(3);
});

it('waits for a host target Playwright lists late, and refuses a frame whose host it never lists', async () => {
  const fixtures: PageFixture[] = [{ tree: tree('main'), frames: [] }];
  const { browser, pause } = fixture(
    {
      main: { type: 'page' },
      // Chrome already runs both widgets as their own targets.
      widget: { type: 'iframe', parentFrameId: 'main' },
      stray: { type: 'iframe', parentFrameId: 'main' },
    },
    fixtures,
  );
  const guarded = guardedPage();
  (await documentGate(browser)).register('main', guarded.page);
  setTimeout(() => fixtures[0].frames?.push(tree('widget', 'widget-child')), 120);
  expect(await pause('widget-child')).toBe('continued');
  expect(guarded.decide).toHaveBeenCalledTimes(1);
  // The stray widget never surfaces, so a frame it may host is refused and its page blamed.
  expect(await pause('stray-child')).toBe('refused');
  expect(guarded.refuse).toHaveBeenCalledTimes(1);
});

it('refuses within its bound a frame whose possible host never answers, blaming only that page', async () => {
  const { browser, pause } = fixture({ one: { type: 'page' }, two: { type: 'page' } }, [
    { tree: tree('one'), silent: true },
    { tree: tree('two') },
  ]);
  const [one, two] = [guardedPage(), guardedPage()];
  const gate = await documentGate(browser);
  gate.register('one', one.page);
  gate.register('two', two.page);
  const started = Date.now();
  expect(await pause('unknown-child')).toBe('refused');
  expect(Date.now() - started).toBeLessThan(4_000);
  expect([one.refuse.mock.calls.length, two.refuse.mock.calls.length]).toEqual([1, 0]);
});

it('holds script submissions in newly created frames and windows from their first request', async () => {
  const { browser, pause } = fixture(
    {
      main: { type: 'page' },
      newFrame: { type: 'iframe', parentFrameId: 'main' },
      popup: { type: 'page', openerId: 'main' },
      other: { type: 'page' },
    },
    [{ tree: tree('main') }, { tree: tree('other') }],
  );
  let held = true;
  const guarded = guardedPage();
  (await documentGate(browser)).register('main', {
    capture: () => ({ ...guarded.page.capture(), submissionsHeld: held }),
  });
  for (const frame of ['main', 'newFrame', 'popup'])
    for (const resource of ['XHR', 'Fetch', 'Ping']) expect(await pause(frame, resource, {}, 'POST')).toBe('refused');
  expect(await pause('newFrame', 'Fetch')).toBe('refused');
  expect(await pause('newFrame', 'Fetch', {}, 'HEAD')).toBe('refused');
  expect(await pause('other', 'Fetch', {}, 'POST')).toBe('continued');
  held = false;
  expect(await pause('newFrame', 'Fetch', {}, 'POST')).toBe('continued');
});
