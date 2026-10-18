import { fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readWhatsAppLink } from './paths.js';
import { transportHarness, type TransportHarness } from './testing/harness.js';

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  fetchLatestWaWebVersion: vi.fn(),
}));
let h: TransportHarness;
beforeEach(async () => {
  h = await transportHarness();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await h.close();
});
describe('current WhatsApp Web version lookup', () => {
  it('opens no socket with the built-in fallback when both live sources fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    vi.mocked(fetchLatestWaWebVersion).mockResolvedValue({
      version: [2, 3000, 1],
      isLatest: false,
      error: new Error('rate limited'),
    });
    await h.start({ resolveVersion: undefined }, false);
    expect(h.sockets).toEqual([]);
    expect((await readWhatsAppLink(h.directory))?.error?.message).toContain('current WhatsApp Web version');
  });
  it('passes the looked-up version to every fresh socket', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('latest 2.3000.123456'))
      .mockResolvedValueOnce(new Response('latest 2.3000.234567'));
    vi.stubGlobal('fetch', fetcher);
    const adapter = await h.start({ resolveVersion: undefined }, false);
    await adapter.reconnect();
    expect(h.socketConfigs.map((config) => config.version)).toEqual([
      [2, 3000, 123456],
      [2, 3000, 234567],
    ]);
  });
});
