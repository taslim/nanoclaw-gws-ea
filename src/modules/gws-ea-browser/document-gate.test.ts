import type { Browser } from 'playwright-core';
import { expect, it, vi } from 'vitest';

import { documentGate, type GuardedPage } from './document-gate.js';

interface TargetFixture {
  type: string;
  parentFrameId?: string;
}

/** A browser session double: frames resolve only through the targets and frame trees given here. */
function fixture(targets: Record<string, TargetFixture>, lookupFails?: string) {
  let paused: ((event: unknown) => void) | undefined;
  const answers = new Map<string, string>();
  const session = {
    on: (name: string, handler: (event: unknown) => void) => {
      if (name === 'Fetch.requestPaused') paused = handler;
    },
    send: async (method: string, params: { targetId?: string; requestId?: string } = {}) => {
      if (method === 'Target.getTargetInfo') {
        if (params.targetId === lookupFails) throw new Error('Protocol error (Target.getTargetInfo): Internal error');
        const target = params.targetId ? targets[params.targetId] : undefined;
        if (!target) throw new Error('Protocol error (Target.getTargetInfo): No target with given id found');
        return { targetInfo: { targetId: params.targetId, ...target } };
      }
      if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest')
        answers.set(String(params.requestId), method === 'Fetch.continueRequest' ? 'continued' : 'refused');
      return {};
    },
  };
  const browser = { once: () => undefined, newBrowserCDPSession: async () => session } as unknown as Browser;
  let next = 0;
  const pause = async (frameId: string): Promise<string | undefined> => {
    const requestId = String(next++);
    paused?.({ requestId, frameId, resourceType: 'Document', request: { url: 'https://shop.example/', headers: {} } });
    await vi.waitFor(() => expect(answers.has(requestId)).toBe(true));
    return answers.get(requestId);
  };
  return { browser, pause };
}

function guardedPage(frameIds: ReadonlySet<string> | undefined) {
  const decide = vi.fn(async () => ({ allow: true as const }));
  const refuse = vi.fn();
  const page: GuardedPage = { capture: () => ({ decide, refuse }), frameIds: async () => frameIds };
  return { page, decide, refuse };
}

it('places main frames, cross-site frames and nested frames with the page that hosts them', async () => {
  const { browser, pause } = fixture({
    main: { type: 'page' },
    widget: { type: 'iframe', parentFrameId: 'main' },
    // A cross-site frame nested in the widget's same-process child.
    nested: { type: 'iframe', parentFrameId: 'widget-child' },
  });
  const guarded = guardedPage(new Set(['main', 'widget', 'widget-child']));
  (await documentGate(browser)).register('main', guarded.page);
  for (const frame of ['main', 'widget', 'widget-child', 'nested']) expect(await pause(frame)).toBe('continued');
  expect(guarded.decide).toHaveBeenCalledTimes(4);
});

it('continues the documents of a page without a guard, untouched by any guard', async () => {
  const { browser, pause } = fixture({ main: { type: 'page' }, other: { type: 'page' } });
  const guarded = guardedPage(new Set(['main']));
  (await documentGate(browser)).register('main', guarded.page);
  expect(await pause('other')).toBe('continued');
  // A same-process frame that no guarded page hosts belongs to an unguarded page.
  expect(await pause('unguarded-child')).toBe('continued');
  expect(guarded.decide).not.toHaveBeenCalled();
});

it('refuses a document it cannot place, recording the refusal for the page that left it uncertain', async () => {
  const { browser, pause } = fixture({ main: { type: 'page' } }, 'broken');
  // The guarded page's frame trees cannot all be read, so a same-process frame may be its own.
  const unreadable = guardedPage(undefined);
  (await documentGate(browser)).register('main', unreadable.page);
  expect(await pause('unknown-child')).toBe('refused');
  expect(unreadable.refuse).toHaveBeenCalledTimes(1);
  // A target lookup that fails for any reason but a missing target is no proof of ownership either.
  expect(await pause('broken')).toBe('refused');
  expect(unreadable.decide).not.toHaveBeenCalled();
});
