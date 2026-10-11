import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../../cli/dispatch.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { GoogleGrantRevokedError } from '../gws-ea-google/tokens.js';
import { startChatDelivery, type ChatDelivery } from './delivery.js';
import { chatHealth, createChatHealth } from './health.js';
import {
  ASSISTANT_TOKEN,
  FakeGoogleEvents,
  SUBSCRIBER_TOKEN,
  SUBSCRIPTION,
  TOPIC,
} from './testing/fake-google-events.js';
import './index.js';

let fake: FakeGoogleEvents;
let delivery: ChatDelivery | undefined;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
  await runMigrations(await initTestDb());
  fake = new FakeGoogleEvents();
});

afterEach(async () => {
  await delivery?.stop();
  delivery = undefined;
  vi.useRealTimers();
  await closeDb();
});

/** This host's delivery, recording into the health status reads. */
function start(assistantToken: () => Promise<string> = async () => ASSISTANT_TOKEN): void {
  delivery = startChatDelivery({
    config: { subscriberKeyFile: '/unused/subscriber-key.json', topic: TOPIC, subscription: SUBSCRIPTION },
    onChatEvent: async () => undefined,
    assistantToken,
    subscriberToken: async () => SUBSCRIBER_TOKEN,
    fetch: fake.fetch,
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > 5_000) throw new Error('The delivery never got there');
    await vi.advanceTimersByTimeAsync(10);
  }
}

async function report(): Promise<unknown> {
  return dispatch({ id: 'h', command: 'gws-ea-chat-health', args: {} }, { caller: 'host' });
}

describe('gws-ea-chat health', () => {
  it('reports the consumer connected with its last pull, and the subscription active with its expiry', async () => {
    fake.emptyPullHoldMs = 1_000;
    start();
    await until(
      () => chatHealth.read().consumer.lastPullAt !== null && chatHealth.read().subscription.state === 'active',
    );

    const [subscription] = [...fake.subscriptions.values()];
    expect(await report()).toEqual({
      id: 'h',
      ok: true,
      data: {
        consumer: { connected: true, lastPullAt: '2026-10-10T09:00:01.000Z', error: null },
        subscription: {
          state: 'active',
          name: subscription?.name,
          expireTime: subscription?.expireTime,
          suspensionReason: null,
          error: null,
        },
        signInNeeded: false,
      },
    });
  });

  it("reports each side's last error kind, and a refused sign-in as sign-in needed", async () => {
    fake.pubsubFailure = { status: 403, message: 'User not authorized to perform this action.' };
    start(async () => {
      throw new GoogleGrantRevokedError("Google no longer accepts the assistant's sign-in; sign in again");
    });
    await until(() => chatHealth.read().consumer.error !== null && chatHealth.read().subscription.error !== null);

    expect(await report()).toMatchObject({
      ok: true,
      data: {
        consumer: { connected: false, error: { kind: 'subscriber_credential', at: '2026-10-10T09:00:00.000Z' } },
        subscription: {
          error: {
            kind: 'sign_in_needed',
            message: "Google no longer accepts the assistant's sign-in; sign in again",
          },
        },
        signInNeeded: true,
      },
    });
  });

  it('answers the host only, and refuses fields it does not know', async () => {
    const agent = await dispatch(
      { id: 'a', command: 'gws-ea-chat-health', args: {} },
      { caller: 'agent', agentGroupId: 'ag-main', sessionId: 'sess-main', messagingGroupId: 'mg-dm' },
    );
    expect(agent).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    const unknown = await dispatch(
      { id: 'u', command: 'gws-ea-chat-health', args: { verbose: true } },
      { caller: 'host' },
    );
    expect(unknown).toMatchObject({ ok: false, error: { message: expect.stringContaining('--verbose') } });
  });

  it('reads a subscription recorded active as expired once its expiry passes', () => {
    const health = createChatHealth();
    const expireTime = '2026-10-17T09:00:00.000Z';
    const renewalFailure = {
      kind: 'unreachable',
      message: 'Google refused /v1/subscriptions/chat-juno: The service is currently unavailable.',
      at: '2026-10-16T09:00:00.000Z',
    } as const;
    health.subscription({ state: 'active', name: 'subscriptions/chat-juno', expireTime });
    // Every renewal since has failed.
    health.subscription({ error: renewalFailure });

    vi.setSystemTime(Date.parse(expireTime) - 1);
    expect(health.read().subscription.state).toBe('active');

    vi.setSystemTime(Date.parse(expireTime));
    expect(health.read()).toEqual({
      consumer: { connected: false, lastPullAt: null, error: null },
      subscription: {
        state: 'expired',
        name: 'subscriptions/chat-juno',
        expireTime,
        suspensionReason: null,
        error: renewalFailure,
      },
      signInNeeded: false,
    });
  });
});
