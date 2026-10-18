import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRegistration } from '../../channels/adapter.js';
import { WHATSAPP_DIRECTORY_ENV, writeWhatsAppLink } from './paths.js';

vi.mock('../../channels/channel-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channels/channel-registry.js')>();
  return { ...actual, registerChannelAdapter: vi.fn(actual.registerChannelAdapter) };
});
vi.mock('../../delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../delivery.js')>();
  return { ...actual, registerPostDeliveryHook: vi.fn(actual.registerPostDeliveryHook) };
});
const originalCwd = process.cwd();
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-register-'));
  process.chdir(root);
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv(WHATSAPP_DIRECTORY_ENV, '');
});
afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
async function registered(): Promise<ChannelRegistration> {
  const registry = await import('../../channels/channel-registry.js');
  await import('./index.js');
  const calls = vi.mocked(registry.registerChannelAdapter).mock.calls.filter(([name]) => name === 'whatsapp');
  expect(calls).toHaveLength(1);
  return calls[0][1];
}
describe('module-owned WhatsApp registration', () => {
  it('is inert with no account path or link record', async () => {
    const registration = await registered();
    expect(registration.factory()).toBeNull();
    vi.stubEnv(WHATSAPP_DIRECTORY_ENV, path.join(root, 'secrets', 'whatsapp'));
    expect(registration.factory()).toBeNull();
    expect(fs.existsSync(path.join(root, 'secrets'))).toBe(false);
  });
  it.each(['linking', 'connected', 'needs-relink'] as const)(
    'keeps an adapter registered for a %s account',
    async (state) => {
      const directory = path.join(root, 'secrets', 'whatsapp');
      await writeWhatsAppLink(directory, { schema_version: 1, state });
      vi.stubEnv(WHATSAPP_DIRECTORY_ENV, directory);
      const registration = await registered();
      const adapter = await registration.factory();
      expect(adapter).toMatchObject({
        channelType: 'whatsapp',
        supportsThreads: false,
        defaults: registration.defaults,
      });
      expect(adapter?.isConnected()).toBe(false);
      await adapter?.teardown();
    },
  );
});
