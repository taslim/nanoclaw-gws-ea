import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Adapter } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelRegistration } from './adapter.js';

const mocks = vi.hoisted(() => ({
  createGoogleChatAdapter: vi.fn(),
  createChatSdkBridge: vi.fn(),
  registerChannelAdapter: vi.fn(),
}));

vi.mock('@chat-adapter/gchat', () => ({
  createGoogleChatAdapter: mocks.createGoogleChatAdapter,
}));

vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: mocks.createChatSdkBridge,
}));

vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: mocks.registerChannelAdapter,
}));

const credentialEnv = '{"client_email":"bot@example.test","private_key":"secret"}';
const endpointUrl = 'https://assistant.example.com/webhook/gchat';
const botUserId = 'users/123456789';
const alternateVerifierEnvKeys = [
  'GOOGLE_CHAT_PROJECT_NUMBER',
  'GOOGLE_CHAT_PUBSUB_AUDIENCE',
  'GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_CHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION',
] as const;
const originalCwd = process.cwd();
let tempDir: string;

async function registeredFactory(): Promise<ChannelRegistration['factory']> {
  await import('./gchat.js');
  const registration = mocks.registerChannelAdapter.mock.calls.find(([name]) => name === 'gchat')?.[1] as
    | ChannelRegistration
    | undefined;
  if (!registration) throw new Error('gchat did not register a channel factory');
  return registration.factory;
}

describe('Google Chat channel configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.GCHAT_CREDENTIALS;
    delete process.env.GCHAT_ENDPOINT_URL;
    delete process.env.GCHAT_BOT_USER_ID;
    delete process.env.GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_CHAT_BOT_USER_ID;
    for (const key of alternateVerifierEnvKeys) delete process.env[key];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gchat-test-'));
    process.chdir(tempDir);

    const sdkAdapter = { name: 'gchat' } as Adapter;
    const channelAdapter = { channelType: 'gchat' } as ChannelAdapter;
    mocks.createGoogleChatAdapter.mockReturnValue(sdkAdapter);
    mocks.createChatSdkBridge.mockReturnValue(channelAdapter);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.GCHAT_CREDENTIALS;
    delete process.env.GCHAT_ENDPOINT_URL;
    delete process.env.GCHAT_BOT_USER_ID;
    delete process.env.GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_CHAT_BOT_USER_ID;
    for (const key of alternateVerifierEnvKeys) delete process.env[key];
  });

  it('passes the exact process configuration to the standard adapter and bridge', async () => {
    process.env.GCHAT_CREDENTIALS = credentialEnv;
    process.env.GCHAT_ENDPOINT_URL = endpointUrl;
    process.env.GCHAT_BOT_USER_ID = botUserId;
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'GCHAT_CREDENTIALS={"client_email":"file@example.test","private_key":"file-secret"}\n' +
        'GCHAT_ENDPOINT_URL=https://file.example.test/webhook/gchat\n' +
        'GCHAT_BOT_USER_ID=users/file-bot\n',
    );

    const factory = await registeredFactory();
    const result = await factory();

    expect(result).toBeDefined();
    expect(mocks.createGoogleChatAdapter).toHaveBeenCalledWith({
      credentials: { client_email: 'bot@example.test', private_key: 'secret' },
      endpointUrl,
      botUserId,
    });
    expect(mocks.createGoogleChatAdapter.mock.calls[0]?.[0]).not.toHaveProperty('disableSignatureVerification');
    expect(mocks.createChatSdkBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: mocks.createGoogleChatAdapter.mock.results[0]?.value,
        concurrency: 'concurrent',
        supportsThreads: true,
      }),
    );
  });

  it('uses .env values when process configuration is absent', async () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      `GCHAT_CREDENTIALS=${credentialEnv}\nGCHAT_ENDPOINT_URL=${endpointUrl}\nGCHAT_BOT_USER_ID=${botUserId}\n`,
    );

    const factory = await registeredFactory();
    await factory();

    expect(mocks.createGoogleChatAdapter).toHaveBeenCalledWith({
      credentials: { client_email: 'bot@example.test', private_key: 'secret' },
      endpointUrl,
      botUserId,
    });
  });

  it('passes the exact Workspace Add-on identity to the Chat adapter', async () => {
    process.env.GCHAT_CREDENTIALS = credentialEnv;
    process.env.GCHAT_ENDPOINT_URL = endpointUrl;
    process.env.GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL =
      'service-441811502258@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';

    const factory = await registeredFactory();
    await factory();

    expect(mocks.createGoogleChatAdapter).toHaveBeenCalledWith({
      credentials: { client_email: 'bot@example.test', private_key: 'secret' },
      endpointUrl,
      workspaceAddOnServiceAccountEmail: 'service-441811502258@gcp-sa-gsuiteaddons.iam.gserviceaccount.com',
    });
  });

  it('returns null only when Google Chat is wholly unconfigured', async () => {
    const factory = await registeredFactory();

    expect(factory()).toBeNull();
    expect(mocks.createGoogleChatAdapter).not.toHaveBeenCalled();
  });

  it('rejects a Workspace Add-on identity without the required Chat configuration', async () => {
    process.env.GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL =
      'service-441811502258@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';

    const factory = await registeredFactory();
    expect(() => factory()).toThrow('GCHAT_CREDENTIALS');
  });

  it.each([
    {
      configured: { GCHAT_ENDPOINT_URL: endpointUrl, GCHAT_BOT_USER_ID: botUserId },
      missingKey: 'GCHAT_CREDENTIALS',
    },
    {
      configured: { GCHAT_CREDENTIALS: credentialEnv, GCHAT_BOT_USER_ID: botUserId },
      missingKey: 'GCHAT_ENDPOINT_URL',
    },
  ] as const)('rejects partial configuration missing $missingKey', async ({ configured, missingKey }) => {
    Object.assign(process.env, configured);
    const factory = await registeredFactory();

    expect(() => factory()).toThrow(`Google Chat configuration requires ${missingKey}`);
    expect(mocks.createGoogleChatAdapter).not.toHaveBeenCalled();
  });

  it('rejects malformed credential JSON with an actionable error', async () => {
    process.env.GCHAT_CREDENTIALS = '{not-json';
    process.env.GCHAT_ENDPOINT_URL = endpointUrl;
    process.env.GCHAT_BOT_USER_ID = botUserId;
    const factory = await registeredFactory();

    expect(() => factory()).toThrow('GCHAT_CREDENTIALS must contain valid JSON');
    expect(mocks.createGoogleChatAdapter).not.toHaveBeenCalled();
  });

  it.each([
    ['{}', 'client_email'],
    ['{"client_email":"bot@example.test"}', 'private_key'],
  ] as const)('rejects credential JSON missing %s', async (credentials, missingField) => {
    process.env.GCHAT_CREDENTIALS = credentials;
    process.env.GCHAT_ENDPOINT_URL = endpointUrl;
    process.env.GCHAT_BOT_USER_ID = botUserId;
    const factory = await registeredFactory();

    expect(() => factory()).toThrow(`GCHAT_CREDENTIALS must contain a non-empty ${missingField}`);
    expect(mocks.createGoogleChatAdapter).not.toHaveBeenCalled();
  });

  it('rejects a malformed endpoint URL without altering it', async () => {
    process.env.GCHAT_CREDENTIALS = credentialEnv;
    process.env.GCHAT_ENDPOINT_URL = 'not a URL';
    process.env.GCHAT_BOT_USER_ID = botUserId;
    const factory = await registeredFactory();

    expect(() => factory()).toThrow('GCHAT_ENDPOINT_URL must be a valid absolute URL');
    expect(mocks.createGoogleChatAdapter).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTPS endpoint URL', async () => {
    process.env.GCHAT_CREDENTIALS = credentialEnv;
    process.env.GCHAT_ENDPOINT_URL = 'http://assistant.example.com/webhook/gchat';
    process.env.GCHAT_BOT_USER_ID = botUserId;
    const factory = await registeredFactory();

    expect(() => factory()).toThrow('GCHAT_ENDPOINT_URL must use https');
    expect(mocks.createGoogleChatAdapter).not.toHaveBeenCalled();
  });

  it.each(['users', 'people/123456789', 'users/123/456', 'users/123 456'])(
    'rejects malformed bot user ID %s',
    async (invalidBotUserId) => {
      process.env.GCHAT_CREDENTIALS = credentialEnv;
      process.env.GCHAT_ENDPOINT_URL = endpointUrl;
      process.env.GCHAT_BOT_USER_ID = invalidBotUserId;
      const factory = await registeredFactory();

      expect(() => factory()).toThrow(
        'GCHAT_BOT_USER_ID must be a canonical Google Chat user resource name (users/<id>)',
      );
      expect(mocks.createGoogleChatAdapter).not.toHaveBeenCalled();
    },
  );

  it('starts without an explicit bot user ID and ignores the package ambient identity', async () => {
    process.env.GCHAT_CREDENTIALS = credentialEnv;
    process.env.GCHAT_ENDPOINT_URL = endpointUrl;
    process.env.GOOGLE_CHAT_BOT_USER_ID = botUserId;
    const factory = await registeredFactory();

    await factory();

    expect(mocks.createGoogleChatAdapter).toHaveBeenCalledWith({
      credentials: { client_email: 'bot@example.test', private_key: 'secret' },
      endpointUrl,
    });
  });

  it.each(alternateVerifierEnvKeys)('rejects ambient alternate verifier setting %s', async (key) => {
    process.env.GCHAT_CREDENTIALS = credentialEnv;
    process.env.GCHAT_ENDPOINT_URL = endpointUrl;
    process.env.GCHAT_BOT_USER_ID = botUserId;
    process.env[key] = key === 'GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION' ? 'true' : 'configured';
    const factory = await registeredFactory();

    expect(() => factory()).toThrow(
      `Google Chat exact endpoint verification cannot be combined with alternate verifier settings: ${key}`,
    );
    expect(mocks.createGoogleChatAdapter).not.toHaveBeenCalled();
  });
});
