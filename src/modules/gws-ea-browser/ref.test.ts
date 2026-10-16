import { expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { validateBrowserBatch } from './executor.js';
import { validateSignInCode } from './sign-in-mail.js';
import { observePage, pinBrowserRefs, disposeBrowserRefs } from './observe.js';

it('accepts document-prefixed native references on every host browser surface', () => {
  const target = { ref: 'f2e17', generation: 1 };
  expect(validateBrowserBatch({ actions: [{ kind: 'click', ...target }] })).toEqual({
    actions: [{ kind: 'click', ...target }],
  });
  expect(validateSignInCode({ target, send: target }).target).toEqual(target);
  for (const ref of ['fe17', 'f2e17extra', 'f2f3e4', 'e-1', 'f1e1foo']) {
    expect(() => validateBrowserBatch({ actions: [{ kind: 'click', ref, generation: 1 }] })).toThrow();
    expect(() => validateSignInCode({ target: { ref, generation: 1 }, send: target })).toThrow();
  }
});

it('resolves a prefixed reference and still rejects it after its observation generation changes', async () => {
  const frame = { url: () => 'https://example.com/' };
  const element = { ownerFrame: async () => frame, dispose: vi.fn(async () => undefined) };
  const getByRef = vi.fn(() => ({ elementHandle: async () => element }));
  const page = {
    url: () => 'https://example.com/',
    frames: () => [],
    locator: () => ({ ariaSnapshot: async () => '- button "Continue" [ref=f2e17]' }),
    getByRef,
  } as unknown as Page;
  const observation = await observePage(page);
  const refs = await pinBrowserRefs(page, [{ ref: 'f2e17', generation: observation.generation }]);
  expect(getByRef).toHaveBeenCalledWith('f2e17');
  expect(refs.get('f2e17')?.element).toBe(element);
  await disposeBrowserRefs(refs);
  await observePage(page);
  await expect(pinBrowserRefs(page, [{ ref: 'f2e17', generation: observation.generation }])).rejects.toMatchObject({
    reason: 'stale_ref',
  });
});
