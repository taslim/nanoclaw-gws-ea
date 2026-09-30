import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Adapter } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelRegistration, ChannelSetup, OutboundMessage } from './adapter.js';

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

const DM = { platformId: 'gchat:spaces/dm', inboundThreadId: 'gchat:spaces/dm:dGhyZWFk:dm', typingThreadId: null };
const TEAM = {
  platformId: 'gchat:spaces/team',
  inboundThreadId: 'gchat:spaces/team:dGVhbQ',
  typingThreadId: 'gchat:spaces/team:dGVhbQ',
};
type Conversation = typeof DM | typeof TEAM;
const TYPING_REFRESH_MS = 4_000;

function reply(text: string): OutboundMessage {
  return { kind: 'chat', content: { text } };
}

async function workingReactionHarness() {
  const { withWorkingReaction } = await import('./gchat.js');
  const events: string[] = [];
  const reactions = {
    addReaction: vi.fn(async (_threadId: string, messageId: string, emoji: string) => {
      events.push(`add ${messageId} ${emoji}`);
    }),
    removeReaction: vi.fn(async (_threadId: string, messageId: string, emoji: string) => {
      events.push(`remove ${messageId} ${emoji}`);
    }),
  };
  let host: ChannelSetup | undefined;
  const post = vi.fn(async (platformId: string, _threadId: string | null, message: OutboundMessage) => {
    events.push(`post ${platformId} ${(message.content as { text: string }).text}`);
    return `${platformId}/messages/reply`;
  });
  const bridge: ChannelAdapter = {
    name: 'gchat',
    channelType: 'gchat',
    supportsThreads: true,
    isConnected: () => true,
    setup: vi.fn(async (config: ChannelSetup) => {
      host = config;
    }),
    teardown: vi.fn(async () => {
      events.push('teardown');
    }),
    deliver: post,
  };
  const routed = vi.fn();
  const adapter = withWorkingReaction(bridge, reactions);
  await adapter.setup({
    onInbound: routed,
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  });

  return {
    adapter,
    post,
    events,
    reactions,
    routed,
    async receive(conversation: Conversation, messageId: string, kind: 'human' | 'bot' = 'human') {
      await host!.onInbound(conversation.platformId, conversation.inboundThreadId, {
        id: messageId,
        kind: 'chat-sdk',
        content: { text: 'hello' },
        timestamp: new Date().toISOString(),
        authenticatedSender: { userId: 'users/principal', kind },
      });
    },
    /** The typing module's cadence: an immediate call, then one every 4 s through `untilMs`. */
    async type(conversation: Conversation, untilMs: number) {
      for (let at = 0; at <= untilMs; at += TYPING_REFRESH_MS) {
        if (at > 0) await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
        await adapter.setTyping!(conversation.platformId, conversation.typingThreadId);
      }
    },
    deliver(conversation: Conversation, text: string) {
      return adapter.deliver(conversation.platformId, conversation.typingThreadId, reply(text));
    },
  };
}

describe('Google Chat working reaction', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T09:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds no reaction to a reply delivered within 2 seconds', async () => {
    const chat = await workingReactionHarness();
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 0);
    await vi.advanceTimersByTimeAsync(2_000);

    await chat.deliver(DM, 'Your next meeting is at 10:00.');

    expect(chat.events).toEqual(['post gchat:spaces/dm Your next meeting is at 10:00.']);
    expect(chat.routed).toHaveBeenCalledTimes(1);
  });

  it('adds one reaction to work lasting 10 seconds and removes it before the reply posts', async () => {
    const chat = await workingReactionHarness();
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 8_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await chat.deliver(DM, 'Done.');

    expect(chat.events).toEqual([
      'add spaces/dm/messages/one 👀',
      'remove spaces/dm/messages/one 👀',
      'post gchat:spaces/dm Done.',
    ]);
  });

  it('reacts on the refresh about 4 seconds after the first, not before', async () => {
    const chat = await workingReactionHarness();
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.adapter.setTyping!(DM.platformId, null);
    await vi.advanceTimersByTimeAsync(3_000);
    await chat.adapter.setTyping!(DM.platformId, null);
    expect(chat.reactions.addReaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await chat.adapter.setTyping!(DM.platformId, null);
    expect(chat.reactions.addReaction).toHaveBeenCalledExactlyOnceWith(
      DM.inboundThreadId,
      'spaces/dm/messages/one',
      '👀',
    );
  });

  it('reacts to the principal’s latest message and never to a bot message', async () => {
    const chat = await workingReactionHarness();
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.receive(DM, 'spaces/dm/messages/two');
    await chat.receive(DM, 'spaces/dm/messages/from-a-bot', 'bot');
    await chat.type(DM, 4_000);

    expect(chat.events).toEqual(['add spaces/dm/messages/two 👀']);
    expect(chat.routed).toHaveBeenCalledTimes(3);
  });

  it('removes the reaction after 60 seconds with no refresh and no reply', async () => {
    const chat = await workingReactionHarness();
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 4_000);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(chat.reactions.removeReaction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(chat.events).toEqual(['add spaces/dm/messages/one 👀', 'remove spaces/dm/messages/one 👀']);
  });

  it('keeps the reaction until the reply when refreshes end at 20 seconds and the reply posts at 40', async () => {
    const chat = await workingReactionHarness();
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(chat.reactions.removeReaction).not.toHaveBeenCalled();

    await chat.deliver(DM, 'Moved it to Thursday.');

    expect(chat.events).toEqual([
      'add spaces/dm/messages/one 👀',
      'remove spaces/dm/messages/one 👀',
      'post gchat:spaces/dm Moved it to Thursday.',
    ]);
  });

  it('keeps an independent reaction for each conversation', async () => {
    const chat = await workingReactionHarness();
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.receive(TEAM, 'spaces/team/messages/one');
    await chat.adapter.setTyping!(DM.platformId, DM.typingThreadId);
    await chat.adapter.setTyping!(TEAM.platformId, TEAM.typingThreadId);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
    await chat.adapter.setTyping!(DM.platformId, DM.typingThreadId);
    await chat.adapter.setTyping!(TEAM.platformId, TEAM.typingThreadId);

    await chat.deliver(TEAM, 'Team answer.');
    expect(chat.events).toEqual([
      'add spaces/dm/messages/one 👀',
      'add spaces/team/messages/one 👀',
      'remove spaces/team/messages/one 👀',
      'post gchat:spaces/team Team answer.',
    ]);

    await chat.deliver(DM, 'DM answer.');
    expect(chat.events.slice(4)).toEqual(['remove spaces/dm/messages/one 👀', 'post gchat:spaces/dm DM answer.']);
  });

  it('posts the reply when removing the reaction fails', async () => {
    const chat = await workingReactionHarness();
    chat.reactions.removeReaction.mockRejectedValueOnce(new Error('403 PERMISSION_DENIED'));
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 4_000);

    await expect(chat.deliver(DM, 'Done.')).resolves.toBe('gchat:spaces/dm/messages/reply');
    expect(chat.events).toEqual(['add spaces/dm/messages/one 👀', 'post gchat:spaces/dm Done.']);
  });

  it('shows nothing and still posts when the app cannot react', async () => {
    const chat = await workingReactionHarness();
    chat.reactions.addReaction.mockRejectedValue(new Error('403 PERMISSION_DENIED'));
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 8_000);

    await expect(chat.deliver(DM, 'Done.')).resolves.toBe('gchat:spaces/dm/messages/reply');
    expect(chat.reactions.addReaction).toHaveBeenCalledTimes(1);
    expect(chat.reactions.removeReaction).not.toHaveBeenCalled();
    expect(chat.events).toEqual(['post gchat:spaces/dm Done.']);
  });

  it('removes a reaction whose add was still in flight when the reply arrived', async () => {
    const chat = await workingReactionHarness();
    let finishAdd: () => void = () => {};
    chat.reactions.addReaction.mockImplementationOnce(
      (_threadId, messageId, emoji) =>
        new Promise<void>((resolve) => {
          finishAdd = () => {
            chat.events.push(`add ${messageId} ${emoji}`);
            resolve();
          };
        }),
    );
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 4_000);

    const delivered = chat.deliver(DM, 'Done.');
    await vi.advanceTimersByTimeAsync(100);
    expect(chat.post).not.toHaveBeenCalled();
    finishAdd();
    await delivered;

    expect(chat.events).toEqual([
      'add spaces/dm/messages/one 👀',
      'remove spaces/dm/messages/one 👀',
      'post gchat:spaces/dm Done.',
    ]);
  });

  it('never holds a reply longer than 2 seconds for a removal that does not answer', async () => {
    const chat = await workingReactionHarness();
    chat.reactions.removeReaction.mockImplementationOnce(() => new Promise<void>(() => {}));
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 4_000);

    const delivered = chat.deliver(DM, 'Done.');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(chat.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(delivered).resolves.toBe('gchat:spaces/dm/messages/reply');
  });

  it('does not react again to an answered message, and gives a new message its own wait', async () => {
    const chat = await workingReactionHarness();
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 4_000);
    await chat.deliver(DM, 'Done.');

    // The agent keeps working after its reply; the typing module keeps refreshing.
    await vi.advanceTimersByTimeAsync(10_000);
    await chat.type(DM, 8_000);
    expect(chat.reactions.addReaction).toHaveBeenCalledTimes(1);

    // A new message restarts the typing module's refresh with an immediate call.
    await chat.receive(DM, 'spaces/dm/messages/two');
    await chat.adapter.setTyping!(DM.platformId, null);
    expect(chat.reactions.addReaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
    await chat.adapter.setTyping!(DM.platformId, null);
    expect(chat.reactions.addReaction).toHaveBeenLastCalledWith(DM.inboundThreadId, 'spaces/dm/messages/two', '👀');
  });

  it('removes active reactions before tearing the bridge down', async () => {
    const chat = await workingReactionHarness();
    await chat.receive(DM, 'spaces/dm/messages/one');
    await chat.type(DM, 4_000);

    await chat.adapter.teardown();

    expect(chat.events).toEqual(['add spaces/dm/messages/one 👀', 'remove spaces/dm/messages/one 👀', 'teardown']);
  });

  it('wires the reaction to the Google Chat adapter behind the registered channel', async () => {
    process.env.GCHAT_CREDENTIALS = credentialEnv;
    process.env.GCHAT_ENDPOINT_URL = endpointUrl;
    const sdkAdapter = { name: 'gchat', addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}) };
    let host: ChannelSetup | undefined;
    const post = vi.fn(async () => 'spaces/dm/messages/reply');
    const bridge = {
      name: 'gchat',
      channelType: 'gchat',
      supportsThreads: true,
      isConnected: () => true,
      setup: vi.fn(async (config: ChannelSetup) => {
        host = config;
      }),
      teardown: vi.fn(async () => {}),
      deliver: post,
    } satisfies ChannelAdapter;
    mocks.createGoogleChatAdapter.mockReturnValue(sdkAdapter);
    mocks.createChatSdkBridge.mockReturnValue(bridge);
    try {
      const adapter = (await (await registeredFactory())()) as ChannelAdapter;
      await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
      await host!.onInbound(DM.platformId, DM.inboundThreadId, {
        id: 'spaces/dm/messages/one',
        kind: 'chat-sdk',
        content: {},
        timestamp: new Date().toISOString(),
        authenticatedSender: { userId: 'users/principal', kind: 'human' },
      });
      await adapter.setTyping!(DM.platformId, null);
      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
      await adapter.setTyping!(DM.platformId, null);
      await adapter.deliver(DM.platformId, null, reply('Done.'));

      expect(adapter).toBe(bridge);
      expect(sdkAdapter.addReaction).toHaveBeenCalledExactlyOnceWith(
        DM.inboundThreadId,
        'spaces/dm/messages/one',
        '👀',
      );
      expect(sdkAdapter.removeReaction).toHaveBeenCalledExactlyOnceWith(
        DM.inboundThreadId,
        'spaces/dm/messages/one',
        '👀',
      );
      expect(post).toHaveBeenCalledExactlyOnceWith(DM.platformId, null, reply('Done.'));
    } finally {
      delete process.env.GCHAT_CREDENTIALS;
      delete process.env.GCHAT_ENDPOINT_URL;
    }
  });
});
