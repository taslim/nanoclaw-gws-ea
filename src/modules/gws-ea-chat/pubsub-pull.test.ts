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

/** A message created event, about the space the message is in, as Google publishes it. */
function chatMessage(name: string, time?: string) {
  return {
    type: CHAT_MESSAGE_CREATED,
    subject: `//chat.googleapis.com/${name.split('/messages/')[0]}`,
    data: { message: { name } },
    ...(time === undefined ? {} : { time }),
  };
}

function messageName(event: WorkspaceEvent): string {
  return (event.data.message as { name: string }).name;
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

describe('ordering', () => {
  it("holds a conversation's event from a later pull until its earlier one is handled, and acks them in order", async () => {
    const earlier = 'spaces/AAAAjuno/messages/remy.10';
    const later = 'spaces/AAAAjuno/messages/remy.11';
    const held = deferred();
    const started: string[] = [];
    start((event) => {
      started.push(messageName(event));
      return messageName(event) === earlier ? held.promise : Promise.resolve();
    });
    const earlierId = fake.publish(chatMessage(earlier));
    await until(() => started.length === 1);
    // The same space, though this subject names the message rather than the space.
    const laterId = fake.publish({ ...chatMessage(later), subject: `//chat.googleapis.com/${later}` });
    await until(() => fake.messages.get(laterId)?.ackIds.length === 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual([earlier]);
    expect(fake.calls('acknowledge')).toEqual([]);

    held.resolve();
    await until(() => fake.acks(laterId) === 1);
    expect(started).toEqual([earlier, later]);
    expect(ackIds(fake.calls('acknowledge'))).toEqual([`${earlierId}-ack-1`, `${laterId}-ack-1`]);
  });

  it("handles another conversation's event while one conversation's handler is still pending", async () => {
    const held = deferred();
    let calls = 0;
    start((event) => {
      calls += 1;
      return messageName(event).startsWith('spaces/AAAAjuno/') ? held.promise : Promise.resolve();
    });
    const juno = fake.publish(chatMessage('spaces/AAAAjuno/messages/remy.12'));
    await until(() => calls === 1);
    const morgan = fake.publish(chatMessage('spaces/AAAAmorgan/messages/remy.13'));

    await until(() => fake.acks(morgan) === 1);
    expect(fake.acks(juno)).toBe(0);

    held.resolve();
    await until(() => fake.acks(juno) === 1);
  });

  it('extends the lease of an event waiting for an earlier one of its conversation', async () => {
    const held = deferred();
    let calls = 0;
    start(() => {
      calls += 1;
      return calls === 1 ? held.promise : Promise.resolve();
    });
    fake.publish(chatMessage('spaces/AAAAjuno/messages/remy.14'));
    await until(() => calls === 1);
    const waiting = fake.publish(chatMessage('spaces/AAAAjuno/messages/remy.15'));
    await until(() => fake.messages.get(waiting)?.ackIds.length === 1);

    // Past the deadline it was pulled with, its lease still runs: Pub/Sub has not handed it out again.
    await vi.advanceTimersByTimeAsync(2 * ACK_DEADLINE_SECONDS * 1_000);
    expect(ackIds(fake.calls('modifyAckDeadline'))).toContain(`${waiting}-ack-1`);
    expect(fake.messages.get(waiting)?.ackIds).toEqual([`${waiting}-ack-1`]);
    expect(calls).toBe(1);

    held.resolve();
    await until(() => fake.acks(waiting) === 1);
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
