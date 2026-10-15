import { expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  observePage,
  registerPageSecret,
  releasePageSecret,
  redactPageText,
  registerBrowserSiteInfoProvider,
  pageHasSecret,
  bindPageSecretDocuments,
  snapshotBrowserStructure,
  pinBrowserRefs,
  registerPageRedaction,
} from './observe.js';

it('redacts public inventory bindings and encoded copies without inventing credential taint', async () => {
  const page = { frames: () => [] } as unknown as Page;
  const value = 'rgs://inventory/slot?binding=opaque';
  registerPageRedaction(page, value);
  expect(redactPageText(page, `${value} ${encodeURIComponent(value)}`)).toBe('[redacted] [redacted]');
  expect(await pageHasSecret(page)).toBe(false);
  for (const url of [
    'https://widgets.resy.com/?resyToken=private',
    'https://widgets.resy.com/?book_token=private',
    'https://widgets.resy.com/?reservation=%7B%22config%22%3A%22private%22%7D',
  ])
    expect(redactPageText(page, url)).toBe('[redacted URL]');
});

it('invalidates earlier agent refs when the host captures a structured recipe checkpoint', async () => {
  const page = {
    url: () => 'https://example.com/search',
    frames: () => [],
    locator: () => ({
      ariaSnapshot: async () => '- textbox "Party size" [ref=e1]',
      ariaSnapshotJSON: async () => [{ role: 'textbox', name: 'Party size', ref: 'e2' }],
    }),
  } as unknown as Page;
  const observation = await observePage(page);
  const structured = await snapshotBrowserStructure(page);
  expect(structured).toMatchObject({
    generation: observation.generation + 1,
    tree: [{ role: 'textbox', name: 'Party size' }],
  });
  await expect(pinBrowserRefs(page, [{ ref: 'e1', generation: observation.generation }])).rejects.toMatchObject({
    reason: 'stale_ref',
  });
});

it('redacts registered field values and bearer URLs from every observation', async () => {
  const page = {
    url: () => 'https://example.com/?token=secret-bearer',
    frames: () => [],
    locator: () => ({
      ariaSnapshot: async () =>
        '- textbox "Password": super-secret\n- link "magic": https://example.com/?token=secret-bearer',
    }),
  } as unknown as Page;
  registerPageSecret(page, 'super-secret');
  registerPageSecret(page, 'https://example.com/?token=secret-bearer');
  const observation = await observePage(page);
  expect(JSON.stringify(observation)).not.toContain('super-secret');
  expect(JSON.stringify(observation)).not.toContain('secret-bearer');
  expect(redactPageText(page, 'super-secret')).toBe('[redacted]');
  releasePageSecret(page, 'super-secret');
  expect(redactPageText(page, 'super-secret')).toBe('[redacted]');
});

it('refuses screenshots after a value is cleared because page scripts may have copied it into a canvas', async () => {
  const page = { frames: () => [{ evaluate: async () => [] }] } as unknown as Page;
  registerPageSecret(page, 'echoed-into-canvas');
  releasePageSecret(page, 'echoed-into-canvas');
  expect(await pageHasSecret(page)).toBe(true);
});

it('permits a fresh document and remembers tainted document identities across history restoration', async () => {
  let loaderId = 'tainted-native-document';
  const page = {
    frames: () => [],
    once: () => undefined,
    context: () => ({ newCDPSession: async () => ({ send: async () => ({ frameTree: { frame: { loaderId } } }) }) }),
  } as unknown as Page;
  registerPageSecret(page, 'canvas-fixture');
  await bindPageSecretDocuments(page, 'canvas-fixture');
  releasePageSecret(page, 'canvas-fixture');
  expect(await pageHasSecret(page)).toBe(true);
  loaderId = 'new-clean-document';
  expect(await pageHasSecret(page)).toBe(false);
  loaderId = 'tainted-native-document';
  expect(await pageHasSecret(page)).toBe(true);
});

it('emits host site metadata once per private registrable domain, and keeps titles untrusted and redacted', async () => {
  let url = 'https://alice.github.io/login';
  const page = {
    url: () => url,
    frames: () => [],
    locator: () => ({ ariaSnapshot: async () => '- heading "Sign in"' }),
  } as unknown as Page;
  registerPageSecret(page, 'private-fixture-value');
  registerBrowserSiteInfoProvider(async () => ({
    vault_items: [{ title: 'Login private-fixture-value', item_handle: 'vault_host-opaque' }],
  }));
  const first = await observePage(page);
  expect(first.site).toEqual({
    origin: 'https://alice.github.io',
    untrusted: true,
    vault_items: [{ title: 'Login [redacted]', item_handle: 'vault_host-opaque' }],
  });
  expect((await observePage(page)).site).toBeUndefined();
  url = 'https://bob.github.io/login';
  expect((await observePage(page)).site?.origin).toBe('https://bob.github.io');
  expect(JSON.stringify(first)).not.toContain('private-fixture-value');
});
