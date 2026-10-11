import { afterEach, describe, expect, it, vi } from 'vitest';

import { GCHAT_PROJECT_ID_ENV, GCHAT_SUBSCRIBER_KEY_FILE_ENV, readChatDeliveryConfig } from './config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the Chat delivery configuration', () => {
  it('is absent on a host with neither key, so the host runs no Chat delivery', () => {
    vi.stubEnv(GCHAT_SUBSCRIBER_KEY_FILE_ENV, '');
    vi.stubEnv(GCHAT_PROJECT_ID_ENV, '');
    expect(readChatDeliveryConfig()).toBeUndefined();
  });

  it('names the topic and the pull subscription from the project', () => {
    vi.stubEnv(GCHAT_SUBSCRIBER_KEY_FILE_ENV, '/srv/juno/state/secrets/chat-subscriber.json');
    vi.stubEnv(GCHAT_PROJECT_ID_ENV, 'gws-ea-juno-hale-1a2b');
    expect(readChatDeliveryConfig()).toEqual({
      subscriberKeyFile: '/srv/juno/state/secrets/chat-subscriber.json',
      topic: 'projects/gws-ea-juno-hale-1a2b/topics/gws-ea-chat-events',
      subscription: 'projects/gws-ea-juno-hale-1a2b/subscriptions/gws-ea-chat-events-pull',
    });
  });

  it('refuses half a configuration, naming the missing key, and an invalid project', () => {
    vi.stubEnv(GCHAT_SUBSCRIBER_KEY_FILE_ENV, '/srv/juno/state/secrets/chat-subscriber.json');
    vi.stubEnv(GCHAT_PROJECT_ID_ENV, '');
    expect(() => readChatDeliveryConfig()).toThrow(`${GCHAT_PROJECT_ID_ENV} is not set`);

    vi.stubEnv(GCHAT_PROJECT_ID_ENV, 'Not A Project');
    expect(() => readChatDeliveryConfig()).toThrow('GCP project ID is invalid');
  });
});
