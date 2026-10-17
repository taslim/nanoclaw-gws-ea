import { expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { executeBrowserBatch, validateBrowserBatch } from './executor.js';
import type { BrowserExecutionContext } from './queue.js';
import { registerPageSecret } from './observe.js';

it('rejects unknown actions and clipboard shortcuts without running a partial batch', () => {
  expect(() =>
    validateBrowserBatch({ actions: [{ kind: 'observe' }, { kind: 'evaluate', expression: 'alert(1)' }] }),
  ).toThrow();
  for (const key of ['Control+Shift+V', 'Meta+Shift+V', 'Meta+C', 'Control+X', 'Shift+Insert'])
    expect(() => validateBrowserBatch({ actions: [{ kind: 'key', ref: 'e1', generation: 1, key }] })).toThrow();
  expect(() => validateBrowserBatch({ actions: [{ kind: 'key', ref: 'e1', generation: 1, key: 'Meta+V' }] })).toThrow();
  expect(() =>
    validateBrowserBatch({ actions: [{ kind: 'type', ref: 'e1', generation: 1, text: 'hello', selector: 'body' }] }),
  ).toThrow();
  expect(
    validateBrowserBatch({ actions: [{ kind: 'navigate', url: 'https://example.com/' }, { kind: 'observe' }] }),
  ).toEqual({ actions: [{ kind: 'navigate', url: 'https://example.com/' }, { kind: 'observe' }] });
});

it('returns screenshots in a top-level image envelope linked to their action, while retaining secret refusal', async () => {
  let screenshots = 0;
  const page = {
    url: () => 'about:blank',
    context: () => ({
      newCDPSession: async () => ({ on() {}, send: async () => ({ targetInfo: { targetId: 'page' } }) }),
      browser: () => ({ once() {}, newBrowserCDPSession: async () => ({ on() {}, send: async () => undefined }) }),
    }),
    on() {},
    off() {},
    once() {},
    frames: () => [],
    mainFrame: () => ({}),
    isClosed: () => false,
    locator: () => ({ ariaSnapshot: async () => '- document' }),
    screenshot: async () => {
      screenshots++;
      return Buffer.from('screenshot');
    },
  } as unknown as Page;
  const context = {
    page: async () => page,
    assertActive: async () => undefined,
    remaining: () => 90_000,
    signal: new AbortController().signal,
    store: { db: {} },
  } as unknown as BrowserExecutionContext;
  const result = await executeBrowserBatch(
    context,
    {
      actions: [{ kind: 'screenshot' }, { kind: 'observe' }, { kind: 'screenshot' }],
    },
    { record: false },
  );
  expect(result).toMatchObject({
    status: 'completed',
    actions: [
      { index: 0, status: 'completed', image_index: 0 },
      { index: 1, status: 'completed' },
      { index: 2, status: 'completed', image_index: 1 },
    ],
    images: [
      { mime_type: 'image/png', data: 'c2NyZWVuc2hvdA==' },
      { mime_type: 'image/png', data: 'c2NyZWVuc2hvdA==' },
    ],
  });
  expect(JSON.stringify(result.actions)).not.toContain('c2NyZWVuc2hvdA==');
  registerPageSecret(page, 'password');
  const refused = await executeBrowserBatch(context, { actions: [{ kind: 'screenshot' }] }, { record: false });
  expect(refused).toMatchObject({ status: 'stopped', reason: 'secret_field' });
  expect(refused.images).toBeUndefined();
  expect(screenshots).toBe(2);
});
