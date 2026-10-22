import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRegistration } from '../../channels/adapter.js';
import { instanceRootName } from '../../gws-ea/paths.js';
import { WHATSAPP_DIRECTORY_ENV, writeWhatsAppLink } from './paths.js';
import { WhatsAppAuthStore } from './auth-store.js';

vi.mock('./adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapter.js')>();
  return { ...actual, createWhatsAppAdapter: vi.fn(actual.createWhatsAppAdapter) };
});

vi.mock('../../channels/channel-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channels/channel-registry.js')>();
  return { ...actual, registerChannelAdapter: vi.fn(actual.registerChannelAdapter) };
});
const originalCwd = process.cwd();
let root: string;
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-register-')));
  process.chdir(root);
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv(WHATSAPP_DIRECTORY_ENV, '');
  vi.stubEnv('GWS_EA_CONFIG_ROOT', path.join(root, 'config'));
  vi.stubEnv('GWS_EA_STATE_ROOT', path.join(root, 'assistants'));
  vi.stubEnv('GWS_EA_INSTANCE_ID', '12345678-1234-4234-8234-123456789abc');
  await import('../gws-ea-profile/index.js');
  const { initTestDb } = await import('../../db/connection.js');
  const { runMigrations } = await import('../../db/migrations/index.js');
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  const { closeDb } = await import('../../db/connection.js');
  const { whatsAppLinking } = await import('./link.js');
  if (process.env[WHATSAPP_DIRECTORY_ENV] && fs.existsSync(process.env[WHATSAPP_DIRECTORY_ENV]!))
    whatsAppLinking().close();
  await closeDb();
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
    expect(await registration.factory()).toBeNull();
    vi.stubEnv(
      WHATSAPP_DIRECTORY_ENV,
      path.join(root, 'assistants', instanceRootName('12345678-1234-4234-8234-123456789abc'), 'secrets', 'whatsapp'),
    );
    expect(await registration.factory()).toBeNull();
    expect(fs.existsSync(path.join(root, 'secrets'))).toBe(false);
  });
  it.each(['linking', 'connected', 'needs-relink'] as const)(
    'keeps an adapter registered for a %s account',
    async (state) => {
      const directory = path.join(
        root,
        'assistants',
        instanceRootName('12345678-1234-4234-8234-123456789abc'),
        'secrets',
        'whatsapp',
      );
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
  it('withdraws a central binding restored after unlink even though no adapter is enabled', async () => {
    const directory = path.join(
      root,
      'assistants',
      instanceRootName('12345678-1234-4234-8234-123456789abc'),
      'secrets',
      'whatsapp',
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    vi.stubEnv(WHATSAPP_DIRECTORY_ENV, directory);
    const { createAgentGroup } = await import('../../db/agent-groups.js');
    const { reconcileGwsEaProfile, isVerifiedPrincipalUser } = await import('../gws-ea-profile/db.js');
    const { bindWhatsAppPrincipal } = await import('../gws-ea-profile/bind.js');
    await createAgentGroup({
      id: 'main',
      name: 'Main',
      folder: 'main',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Pat',
      principalTimezone: 'UTC',
      mainAgentGroupId: 'main',
    });
    await bindWhatsAppPrincipal({ lid: '12000', phoneJid: '447700900123@s.whatsapp.net' }, '2026-01-01T00:00:00.000Z');
    expect(await (await registered()).factory()).toBeNull();
    expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(false);
    expect(fs.existsSync(path.join(directory, 'link.json'))).toBe(false);
  });
  it('constructs only one fresh adapter when boot reconciles an expired pairing that already authenticated', async () => {
    const directory = path.join(
      root,
      'assistants',
      instanceRootName('12345678-1234-4234-8234-123456789abc'),
      'secrets',
      'whatsapp',
    );
    vi.stubEnv(WHATSAPP_DIRECTORY_ENV, directory);
    await writeWhatsAppLink(directory, {
      schema_version: 1,
      state: 'linking',
      number: '+15550000000',
      pairing: { expiresAt: Date.now() - 1, previousState: null },
    });
    const auth = new WhatsAppAuthStore(directory);
    auth.saveCreds({
      account: { details: Buffer.from('native paired account') },
      me: { id: '15550000000:1@s.whatsapp.net', name: 'Assistant' },
    });
    auth.close();
    const adapter = await (await registered()).factory();
    const { createWhatsAppAdapter } = await import('./adapter.js');
    expect(createWhatsAppAdapter).toHaveBeenCalledTimes(1);
    expect(adapter).toBeDefined();
    const retained = new WhatsAppAuthStore(directory);
    expect(retained.state.creds.account?.details).toEqual(Buffer.from('native paired account'));
    retained.close();
    await adapter?.teardown();
  });
});
