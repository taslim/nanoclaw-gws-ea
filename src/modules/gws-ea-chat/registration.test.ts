/**
 * The Google Chat channel registers from this module, over the assistant's
 * grant and the host's Chat delivery, as the email channel registers from
 * its own: a host without both has no Chat, and a grant this release cannot
 * read asks for a new sign-in. The channel barrel no longer registers it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelRegistration } from '../../channels/adapter.js';
import { GOOGLE_GRANT_FILE_ENV, GOOGLE_SIGN_IN_SCOPES } from '../gws-ea-google/grant.js';
import { GCHAT_PROJECT_ID_ENV, GCHAT_SUBSCRIBER_KEY_FILE_ENV } from './config.js';
import { ASSISTANT, ASSISTANT_SUB } from './testing/fake-chat-api.js';

vi.mock('../../channels/channel-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channels/channel-registry.js')>();
  return { ...actual, registerChannelAdapter: vi.fn(actual.registerChannelAdapter) };
});
vi.mock('../../channels/chat-sdk-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channels/chat-sdk-bridge.js')>();
  return { ...actual, createChatSdkBridge: vi.fn(actual.createChatSdkBridge) };
});

const originalCwd = process.cwd();
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-chat-registration-'));
  // No `.env` here: the host's configuration is only what each test sets.
  process.chdir(root);
  vi.resetModules();
  // The recording mocks outlive a module reset: each test reads only its own registrations.
  vi.clearAllMocks();
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The assistant's grant, as the sign-in writes it; `fields` overrides what it records. */
function writeGrant(fields: Record<string, unknown> = {}): string {
  const file = path.join(root, 'google-grant.json');
  const grant = {
    schema_version: 2,
    account: 'morgan.ellery@northwind.example',
    sub: ASSISTANT_SUB,
    client_id: 'client.apps.googleusercontent.com',
    client_secret: 'GOCSPX-client-secret',
    refresh_token: '1//refresh-token',
    scopes: [...GOOGLE_SIGN_IN_SCOPES],
    granted_at: '2026-10-10T09:00:00.000Z',
    ...fields,
  };
  fs.writeFileSync(file, JSON.stringify(grant), { mode: 0o600 });
  return file;
}

function configureDelivery(): void {
  vi.stubEnv(GCHAT_SUBSCRIBER_KEY_FILE_ENV, path.join(root, 'chat-subscriber.json'));
  vi.stubEnv(GCHAT_PROJECT_ID_ENV, 'gws-ea-juno-hale-1a2b');
}

/** The module as the host loads it, and the registration it made for `gchat`. */
async function registered(): Promise<ChannelRegistration> {
  const registry = await import('../../channels/channel-registry.js');
  await import('./index.js');
  const registration = vi.mocked(registry.registerChannelAdapter).mock.calls.find(([name]) => name === 'gchat')?.[1];
  if (!registration) throw new Error('gws-ea-chat registered no gchat channel');
  return registration;
}

describe('the gchat registration', () => {
  it('registers no adapter on a host without a Google sign-in', async () => {
    configureDelivery();

    expect(await (await registered()).factory()).toBeNull();
  });

  it('registers no adapter on a host without Chat delivery', async () => {
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, writeGrant());

    expect(await (await registered()).factory()).toBeNull();
  });

  it('refuses a half-configured Chat delivery, naming what is missing', async () => {
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, writeGrant());
    vi.stubEnv(GCHAT_PROJECT_ID_ENV, 'gws-ea-juno-hale-1a2b');
    const registration = await registered();

    expect(() => registration.factory()).toThrow(GCHAT_SUBSCRIBER_KEY_FILE_ENV);
  });

  it('fails setup asking for a new sign-in when the grant predates Chat and lacks the Google ID', async () => {
    // The schema before Chat, which recorded no Google ID.
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, writeGrant({ schema_version: 1, sub: undefined }));
    configureDelivery();
    const registration = await registered();

    await expect(registration.factory()).rejects.toThrow(/sign in to Google again/u);
  });

  it('fails setup asking for a sign-in when the assistant has not signed in yet', async () => {
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(root, 'google-grant.json'));
    configureDelivery();
    const registration = await registered();

    await expect(registration.factory()).rejects.toThrow(/has not signed in to Google/u);
  });

  it("builds the assistant's adapter from the grant, behind the bridge, with Chat's defaults", async () => {
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, writeGrant());
    configureDelivery();
    const registration = await registered();
    const { AssistantChatAdapter, GCHAT_DEFAULTS, extractGchatReplyContext } = await import('./adapter.js');
    const bridge = await import('../../channels/chat-sdk-bridge.js');

    const channel = (await registration.factory()) as ChannelAdapter;

    expect(channel).toMatchObject({ channelType: 'gchat', supportsThreads: true, defaults: GCHAT_DEFAULTS });
    expect(registration.defaults).toBe(GCHAT_DEFAULTS);
    const config = vi.mocked(bridge.createChatSdkBridge).mock.calls[0]![0];
    expect(config).toMatchObject({
      concurrency: 'concurrent',
      extractReplyContext: extractGchatReplyContext,
      redelivers: true,
    });
    expect(config.adapter).toBeInstanceOf(AssistantChatAdapter);
    expect(config.adapter).toMatchObject({ botUserId: ASSISTANT, userName: 'morgan.ellery', runtimeMode: 'polling' });
  });
});

describe('registration across the barrels', () => {
  it('registers gchat once: from this module, and not from the channel barrel', async () => {
    const registry = await import('../../channels/channel-registry.js');
    await import('../../channels/index.js');
    expect(vi.mocked(registry.registerChannelAdapter).mock.calls.map(([name]) => name)).not.toContain('gchat');

    await import('../index.js');
    expect(vi.mocked(registry.registerChannelAdapter).mock.calls.filter(([name]) => name === 'gchat')).toHaveLength(1);
  });
});
