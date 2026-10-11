import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatHealth, type ChatHealthRecorder } from './health.js';
import {
  ACK_DEADLINE_SECONDS,
  startPullConsumer,
  type PullConsumer,
  type PullConsumerOptions,
  type WorkspaceEvent,
} from './pubsub-pull.js';
import { CHAT_MESSAGE_CREATED } from './subscription.js';
import {
  FakeGoogleEvents,
  SUBSCRIBER_TOKEN,
  SUBSCRIPTION,
  type RecordedRequest,
} from './testing/fake-google-events.js';

const BATCH_CREATED = 'google.workspace.chat.message.v1.batchCreated';

let fake: FakeGoogleEvents;
let health: ChatHealthRecorder;
let consumer: PullConsumer | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakeGoogleEvents();
  health = createChatHealth();
});

afterEach(async () => {
  await consumer?.stop();
  consumer = undefined;
  vi.useRealTimers();
});

function start(handle: PullConsumerOptions['handle']): PullConsumer {
  consumer = startPullConsumer({
    subscription: SUBSCRIPTION,
    token: async () => SUBSCRIBER_TOKEN,
    handle,
    health,
    fetch: fake.fetch,
  });
  return consumer;
}

/** Let the consumer run, a few fake milliseconds at a time, until `check` holds. */
async function until(check: () => boolean): Promise<void> {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > 5_000) throw new Error('The consumer never got there');
    await vi.advanceTimersByTimeAsync(10);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function ackIds(requests: readonly RecordedRequest[]): string[] {
  return requests.flatMap((request) => (request.body as { ackIds: string[] }).ackIds);
}

function chatMessage(name: string, time?: string) {
  return { type: CHAT_MESSAGE_CREATED, data: { message: { name } }, ...(time === undefined ? {} : { time }) };
}

describe('acking', () => {
  it('acks an event once its handler resolves, and only once', async () => {
    const handled: WorkspaceEvent[] = [];
    start(async (event) => {
      handled.push(event);
    });
    const id = fake.publish(chatMessage('spaces/AAAAjuno/messages/remy.1'));

    await until(() => fake.acks(id) === 1);
    expect(handled).toEqual([
      expect.objectContaining({
        messageId: id,
        type: CHAT_MESSAGE_CREATED,
        subject: '//chat.googleapis.com/spaces/AAAAjuno',
        data: { message: { name: 'spaces/AAAAjuno/messages/remy.1' } },
      }),
    ]);

    // Past the lease: an acked event never comes back.
    await vi.advanceTimersByTimeAsync(2 * ACK_DEADLINE_SECONDS * 1_000);
    expect(fake.acks(id)).toBe(1);
    expect(handled).toHaveLength(1);
  });

  it('extends the lease of an event still being handled at 50 seconds, and acks it when it resolves', async () => {
    const handling = deferred();
    let calls = 0;
    start(() => {
      calls += 1;
      return handling.promise;
    });
    const id = fake.publish(chatMessage('spaces/AAAAjuno/messages/remy.2'));
    await until(() => calls === 1);

    await vi.advanceTimersByTimeAsync(50_000);
    const extensions = fake.calls('modifyAckDeadline');
    expect(ackIds(extensions)).toContain(`${id}-ack-1`);
    expect(extensions[0]?.body).toMatchObject({ ackDeadlineSeconds: ACK_DEADLINE_SECONDS });
    expect(fake.acks(id)).toBe(0);

    // Well past the first deadline, Pub/Sub has not handed it out again.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(fake.messages.get(id)?.ackIds).toEqual([`${id}-ack-1`]);

    handling.resolve();
    await until(() => fake.acks(id) === 1);
    expect(calls).toBe(1);
  });

  it('neither handles nor acks a copy of an event still being handled', async () => {
    const handling = deferred();
    let calls = 0;
    start(() => {
      calls += 1;
      return handling.promise;
    });
    const id = fake.publish(chatMessage('spaces/AAAAjuno/messages/remy.3'));
    await until(() => calls === 1);

    fake.redeliverNow(id);
    await until(() => fake.messages.get(id)?.ackIds.length === 2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    expect(fake.calls('acknowledge')).toEqual([]);

    handling.resolve();
    await until(() => fake.acks(id) === 1);
    // Acked through the copy being handled, never the skipped one.
    expect(ackIds(fake.calls('acknowledge'))).toEqual([`${id}-ack-1`]);
  });

  it('leaves an event its handler rejects unacked, and handles it again when Pub/Sub delivers it again', async () => {
    let attempts = 0;
    start(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Chat answered 500');
    });
    const id = fake.publish(chatMessage('spaces/AAAAjuno/messages/remy.4'));
    await until(() => attempts === 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.acks(id)).toBe(0);

    await vi.advanceTimersByTimeAsync(ACK_DEADLINE_SECONDS * 1_000);
    await until(() => fake.acks(id) === 1);
    expect(attempts).toBe(2);
  });

  it('acks a batch event only once every part is routed; its routed parts are dropped when it comes again', async () => {
    const routed: string[] = [];
    const failOnce = new Set(['spaces/AAAAjuno/messages/remy.7']);
    start(async (event) => {
      const parts = (event.data.messages as { message: { name: string } }[]).map((part) => part.message.name);
      for (const name of parts) {
        // The router's dedupe: a part already routed is dropped.
        if (routed.includes(name)) continue;
        if (failOnce.delete(name)) throw new Error('Chat answered 503');
        routed.push(name);
      }
    });
    const id = fake.publish({
      type: BATCH_CREATED,
      data: {
        messages: ['remy.5', 'remy.6', 'remy.7'].map((part) => ({
          message: { name: `spaces/AAAAjuno/messages/${part}` },
        })),
      },
    });
    await until(() => routed.length === 2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.acks(id)).toBe(0);

    await vi.advanceTimersByTimeAsync(ACK_DEADLINE_SECONDS * 1_000);
    await until(() => fake.acks(id) === 1);
    expect(routed).toEqual([
      'spaces/AAAAjuno/messages/remy.5',
      'spaces/AAAAjuno/messages/remy.6',
      'spaces/AAAAjuno/messages/remy.7',
    ]);
  });

  it('hands a pulled batch over in event-time order, one event after another', async () => {
    fake.publish(chatMessage('spaces/AAAAjuno/messages/third', '2026-10-10T09:00:03.000300Z'));
    fake.publish(chatMessage('spaces/AAAAjuno/messages/first', '2026-10-10T09:00:01.000100Z'));
    fake.publish(chatMessage('spaces/AAAAjuno/messages/second', '2026-10-10T09:00:02.000200Z'));
    const order: string[] = [];
    let busy = false;
    start(async (event) => {
      expect(busy).toBe(false);
      busy = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push((event.data.message as { name: string }).name.split('/').pop() ?? '');
      busy = false;
    });

    await until(() => order.length === 3);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('acks what Pub/Sub carries that is no readable Workspace event, without handling it', async () => {
    const handled: WorkspaceEvent[] = [];
    start(async (event) => {
      handled.push(event);
    });
    const notJson = fake.publishRaw('not json', { 'ce-type': CHAT_MESSAGE_CREATED });
    const untyped = fake.publishRaw(JSON.stringify({ message: { name: 'spaces/AAAAjuno/messages/remy.8' } }));

    await until(() => fake.acks(notJson) === 1 && fake.acks(untyped) === 1);
    expect(handled).toEqual([]);
  });
});

describe('pulling', () => {
  it('pulls again after an empty long-poll, acking nothing', async () => {
    fake.emptyPullHoldMs = 5_000;
    start(async () => undefined);

    await vi.advanceTimersByTimeAsync(21_000);
    expect(fake.calls('pull').length).toBeGreaterThanOrEqual(4);
    expect(fake.calls('pull')[0]?.body).toEqual({ maxMessages: 100 });
    expect(fake.calls('acknowledge')).toEqual([]);
    expect(health.read().consumer).toEqual({ connected: true, lastPullAt: expect.any(String), error: null });
  });

  it('shows a subscriber Google refuses (401) as a failing credential, backs off without spinning, and recovers', async () => {
    fake.pubsubFailure = { status: 401, message: 'Request had invalid authentication credentials.' };
    start(async () => undefined);

    await vi.advanceTimersByTimeAsync(10_000);
    // Tried at 0, 1, 3, and 7 seconds.
    expect(fake.requests.length).toBeLessThanOrEqual(5);
    expect(health.read().consumer).toEqual({
      connected: false,
      lastPullAt: null,
      error: {
        kind: 'subscriber_credential',
        message: expect.stringContaining('invalid authentication credentials'),
        at: expect.any(String),
      },
    });

    fake.pubsubFailure = undefined;
    await vi.advanceTimersByTimeAsync(6_000);
    await until(() => health.read().consumer.connected);
    expect(health.read().consumer.error).toBeNull();
  });

  it('shows a subscriber Pub/Sub does not let pull as a failing credential', async () => {
    fake.mayConsume = false;
    start(async () => undefined);

    await until(() => health.read().consumer.error !== null);
    expect(health.read().consumer).toMatchObject({
      connected: false,
      error: { kind: 'subscriber_credential', message: `The Chat subscriber may not pull ${SUBSCRIPTION}` },
    });
    expect(fake.calls('pull')).toEqual([]);
  });

  it('stops pulling when stopped', async () => {
    const running = start(async () => undefined);
    await until(() => fake.calls('pull').length === 1);

    await running.stop();
    consumer = undefined;
    expect(health.read().consumer.connected).toBe(false);
    fake.publish(chatMessage('spaces/AAAAjuno/messages/remy.9'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.calls('pull')).toHaveLength(1);
  });
});
