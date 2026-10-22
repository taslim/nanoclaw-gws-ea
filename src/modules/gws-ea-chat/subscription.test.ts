import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoogleGrantRevokedError } from '../gws-ea-google/tokens.js';
import { startChatDelivery, type ChatDelivery } from './delivery.js';
import { createChatHealth, type ChatHealthRecorder } from './health.js';
import type { WorkspaceEvent } from './pubsub-pull.js';
import {
  CHAT_MESSAGE_CREATED,
  CHAT_EVENT_TYPES,
  CHAT_REACTION_CREATED,
  CHAT_SUBSCRIPTION_TARGET,
  SUBSCRIPTION_EXPIRATION_REMINDER,
  SUBSCRIPTION_EXPIRED,
  SUBSCRIPTION_SUSPENDED,
} from './subscription.js';
import {
  ASSISTANT_TOKEN,
  FakeGoogleEvents,
  SUBSCRIBER_TOKEN,
  SUBSCRIPTION,
  TOPIC,
  type StoredSubscription,
} from './testing/fake-google-events.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let fake: FakeGoogleEvents;
let health: ChatHealthRecorder;
let chatEvents: WorkspaceEvent[];
let delivery: ChatDelivery | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T09:00:00.000Z'));
  fake = new FakeGoogleEvents();
  health = createChatHealth();
  chatEvents = [];
});

afterEach(async () => {
  await delivery?.stop();
  delivery = undefined;
  vi.useRealTimers();
});

function start(assistantToken: () => Promise<string> = async () => ASSISTANT_TOKEN): ChatDelivery {
  delivery = startChatDelivery({
    config: { subscriberKeyFile: '/unused/subscriber-key.json', topic: TOPIC, subscription: SUBSCRIPTION },
    onChatEvent: async (event) => {
      chatEvents.push(event);
    },
    assistantToken,
    subscriberToken: async () => SUBSCRIBER_TOKEN,
    health,
    fetch: fake.fetch,
  });
  return delivery;
}

async function stop(): Promise<void> {
  await delivery?.stop();
  delivery = undefined;
}

async function until(check: () => boolean): Promise<void> {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > 5_000) throw new Error('The delivery never got there');
    await vi.advanceTimersByTimeAsync(10);
  }
}

const active = () => health.read().subscription.state === 'active';

/** Workspace Events calls by method and path, such as `POST /v1/subscriptions`. */
function workspaceCalls(method: string, path: string): number {
  return fake.requests.filter(
    (request) =>
      request.url.host === 'workspaceevents.googleapis.com' &&
      request.method === method &&
      request.url.pathname === path,
  ).length;
}

/** A subscription renewed an hour ago: not due again for 23 hours. */
function seedRenewed(fields: Partial<StoredSubscription> = {}): StoredSubscription {
  return fake.seedSubscription({ expireTime: new Date(Date.now() + 7 * DAY - HOUR).toISOString(), ...fields });
}

function lifecycle(type: string, subscription: string, data: Record<string, unknown> = {}): string {
  const source = `//workspaceevents.googleapis.com/${subscription}`;
  return fake.publish({ type, source, subject: source, data: { subscription: { name: subscription, ...data } } });
}

describe('adoption', () => {
  it('adopts a matching subscription for every space and creates nothing', async () => {
    const existing = seedRenewed();
    start();

    await until(active);
    expect(health.read().subscription).toEqual({
      state: 'active',
      name: existing.name,
      expireTime: existing.expireTime,
      suspensionReason: null,
      error: null,
    });
    expect(workspaceCalls('POST', '/v1/subscriptions')).toBe(0);
    expect(workspaceCalls('DELETE', `/v1/${existing.name}`)).toBe(0);
    const list = fake.requests.find((request) => request.url.pathname === '/v1/subscriptions');
    expect(list?.url.searchParams.get('filter')).toBe(
      `(${CHAT_EVENT_TYPES.map((type) => `event_types:"${type}"`).join(' OR ')}) AND target_resource="${CHAT_SUBSCRIPTION_TARGET}"`,
    );
  });

  it.each<[string, Partial<StoredSubscription>]>([
    [
      'delivers to another topic',
      { notificationEndpoint: { pubsubTopic: 'projects/gws-ea-old-project-9z8y/topics/gws-ea-chat-events' } },
    ],
    ['subscribes to other events', { eventTypes: [CHAT_MESSAGE_CREATED] }],
    // An hour before the test's clock.
    ['has expired', { expireTime: '2026-10-10T08:00:00.000Z' }],
  ])('deletes one that %s and creates it again', async (_, fields) => {
    const stale = seedRenewed(fields);
    start();

    await until(active);
    expect(workspaceCalls('DELETE', `/v1/${stale.name}`)).toBe(1);
    const [created, ...others] = [...fake.subscriptions.values()];
    expect(others).toEqual([]);
    expect(created).toMatchObject({
      eventTypes: [...CHAT_EVENT_TYPES],
      notificationEndpoint: { pubsubTopic: TOPIC },
    });
    expect(created!.name).not.toBe(stale.name);
    expect(health.read().subscription.name).toBe(created!.name);
  });

  it("creates one with message, reaction and membership events, name-only, for a 7-day life, with the assistant's own token", async () => {
    fake.slowOperations = 1;
    start();

    await until(active);
    const create = fake.requests.find(
      (request) => request.method === 'POST' && request.url.pathname === '/v1/subscriptions',
    );
    expect(create?.authorization).toBe(`Bearer ${ASSISTANT_TOKEN}`);
    expect(create?.body).toEqual({
      targetResource: CHAT_SUBSCRIPTION_TARGET,
      eventTypes: [
        CHAT_MESSAGE_CREATED,
        CHAT_REACTION_CREATED,
        'google.workspace.chat.membership.v1.created',
        'google.workspace.chat.membership.v1.updated',
        'google.workspace.chat.membership.v1.deleted',
      ],
      notificationEndpoint: { pubsubTopic: TOPIC },
      payloadOptions: { includeResource: false },
      ttl: '604800s',
    });
    // Google finished creating it on a later poll of its operation.
    expect(fake.requests.some((request) => request.url.pathname.startsWith('/v1/operations/'))).toBe(true);
    const [created] = [...fake.subscriptions.values()];
    expect(health.read().subscription).toMatchObject({ name: created?.name, expireTime: created?.expireTime });
  });

  it('adopts the one Google has when creating returns ALREADY_EXISTS', async () => {
    const existing = seedRenewed();
    fake.staleLists = 1;
    start();

    await until(active);
    expect(workspaceCalls('POST', '/v1/subscriptions')).toBe(1);
    expect([...fake.subscriptions.keys()]).toEqual([existing.name]);
    expect(health.read().subscription.name).toBe(existing.name);
  });
});

describe('lifecycle', () => {
  it('renews the subscription a day after its last renewal, and patches only its lifetime', async () => {
    // Renewed an hour ago, so due in 23 hours.
    const existing = seedRenewed();
    const renewedAt = Date.now() - HOUR;
    start();
    await until(active);

    await vi.advanceTimersByTimeAsync(22 * HOUR);
    expect(workspaceCalls('PATCH', `/v1/${existing.name}`)).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * HOUR);
    const renewals = fake.requests.filter((request) => request.method === 'PATCH');
    expect(renewals).toHaveLength(1);
    expect(renewals[0]?.url.searchParams.get('updateMask')).toBe('ttl');
    expect(renewals[0]?.body).toEqual({ ttl: '604800s' });
    const expireTime = health.read().subscription.expireTime ?? '';
    expect(expireTime).toBe(existing.expireTime);
    expect(Date.parse(expireTime) - renewedAt).toBeGreaterThanOrEqual(8 * DAY);
  });

  it('renews within the hour of waking when the host slept through the renewal', async () => {
    const existing = seedRenewed();
    start();
    await until(active);

    // Asleep for three days: the wall clock moves, the host's timers do not.
    vi.setSystemTime(Date.now() + 3 * DAY);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(workspaceCalls('PATCH', `/v1/${existing.name}`)).toBe(1);
  });

  it('renews on an expirationReminder for the adopted subscription', async () => {
    const existing = seedRenewed();
    start();
    await until(active);

    const reminder = lifecycle(SUBSCRIPTION_EXPIRATION_REMINDER, existing.name);
    await until(() => fake.acks(reminder) === 1);
    expect(workspaceCalls('PATCH', `/v1/${existing.name}`)).toBe(1);
    expect(chatEvents).toEqual([]);
  });

  it('creates a new subscription when the adopted one expires', async () => {
    const existing = seedRenewed();
    start();
    await until(active);

    fake.subscriptions.delete(existing.name);
    const expired = lifecycle(SUBSCRIPTION_EXPIRED, existing.name);
    await until(() => fake.acks(expired) === 1);
    const [created] = [...fake.subscriptions.values()];
    expect(created?.name).not.toBe(existing.name);
    expect(health.read().subscription).toMatchObject({ state: 'active', name: created?.name });
  });

  it('shows a suspension for the sign-in as sign-in needed, and the next start reactivates it rather than renewing', async () => {
    const existing = seedRenewed();
    start();
    await until(active);

    existing.state = 'SUSPENDED';
    existing.suspensionReason = 'USER_SCOPE_REVOKED';
    const suspended = lifecycle(SUBSCRIPTION_SUSPENDED, existing.name, { suspensionReason: 'USER_SCOPE_REVOKED' });
    await until(() => fake.acks(suspended) === 1);
    expect(health.read()).toMatchObject({
      subscription: { state: 'suspended', name: existing.name, suspensionReason: 'USER_SCOPE_REVOKED' },
      signInNeeded: true,
    });

    // The principal signs the assistant in again, and the host starts.
    await stop();
    start();
    await until(active);
    expect(workspaceCalls('POST', `/v1/${existing.name}:reactivate`)).toBe(1);
    expect(workspaceCalls('PATCH', `/v1/${existing.name}`)).toBe(0);
    expect(workspaceCalls('POST', '/v1/subscriptions')).toBe(0);
    expect(health.read()).toMatchObject({
      subscription: { state: 'active', suspensionReason: null },
      signInNeeded: false,
    });
  });

  it('does not call a suspension Google blames on the topic sign-in needed', async () => {
    const existing = seedRenewed();
    start();
    await until(active);

    const suspended = lifecycle(SUBSCRIPTION_SUSPENDED, existing.name, { suspensionReason: 'ENDPOINT_NOT_FOUND' });
    await until(() => fake.acks(suspended) === 1);
    expect(health.read()).toMatchObject({ subscription: { state: 'suspended' }, signInNeeded: false });
  });

  it('acts on nothing when an expired event names another subscription', async () => {
    const existing = seedRenewed();
    start();
    await until(active);
    const requestsBefore = fake.requests.filter((request) => request.url.host !== 'pubsub.googleapis.com').length;

    const expired = lifecycle(SUBSCRIPTION_EXPIRED, 'subscriptions/chat-retired-1');
    await until(() => fake.acks(expired) === 1);
    expect(fake.requests.filter((request) => request.url.host !== 'pubsub.googleapis.com')).toHaveLength(
      requestsBefore,
    );
    expect(health.read().subscription).toMatchObject({ state: 'active', name: existing.name });
  });

  it('hands over a Chat event retained from a previous, expired subscription', async () => {
    const retained = fake.publish({
      type: CHAT_MESSAGE_CREATED,
      source: '//workspaceevents.googleapis.com/subscriptions/chat-retired-1',
      time: '2026-10-09T23:59:00.000Z',
      data: { message: { name: 'spaces/AAAAjuno/messages/morgan.1' } },
    });
    start();

    await until(() => fake.acks(retained) === 1);
    expect(chatEvents).toEqual([expect.objectContaining({ messageId: retained, type: CHAT_MESSAGE_CREATED })]);
    expect(health.read().subscription.state).toBe('active');
  });
});

describe('failures', () => {
  it('shows a refused sign-in as sign-in needed, without asking Google, and tries again later without spinning', async () => {
    let asked = 0;
    start(async () => {
      asked += 1;
      throw new GoogleGrantRevokedError("Google no longer accepts the assistant's sign-in; sign in again");
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Tried at once, then after one, two, and four minutes.
    expect(asked).toBe(4);
    expect(fake.requests.filter((request) => request.url.host === 'workspaceevents.googleapis.com')).toEqual([]);
    expect(health.read()).toMatchObject({
      subscription: { state: 'unknown', error: { kind: 'sign_in_needed' } },
      signInNeeded: true,
    });
  });

  it('shows Google out of reach as unreachable, and recovers on a later try', async () => {
    fake.workspaceFailure = { status: 503, message: 'The service is currently unavailable.' };
    start();
    await until(() => health.read().subscription.error !== null);
    expect(health.read()).toMatchObject({ subscription: { error: { kind: 'unreachable' } }, signInNeeded: false });

    fake.workspaceFailure = undefined;
    await vi.advanceTimersByTimeAsync(61_000);
    await until(active);
    expect(health.read().subscription.error).toBeNull();
  });

  it('shows no subscription once it deleted an expired one and Google refused a new one', async () => {
    const existing = seedRenewed();
    start();
    await until(active);

    // Asleep past its expiry; on waking, Google refuses to create another.
    fake.createFailure = { status: 429, message: 'Quota exceeded for subscription creation.' };
    vi.setSystemTime(Date.parse(existing.expireTime) + HOUR);
    await vi.advanceTimersByTimeAsync(HOUR);
    await until(() => health.read().subscription.error !== null);

    expect(workspaceCalls('DELETE', `/v1/${existing.name}`)).toBe(1);
    expect(fake.subscriptions.size).toBe(0);
    expect(health.read().subscription).toEqual({
      state: 'unknown',
      name: null,
      expireTime: null,
      suspensionReason: null,
      error: expect.objectContaining({ kind: 'unreachable' }),
    });
  });

  it('shows no subscription once Google lists none at a renewal, though the last one had not expired', async () => {
    const existing = seedRenewed();
    start();
    await until(active);

    // Deleted from outside this host; Google then refuses a new one.
    fake.subscriptions.delete(existing.name);
    fake.createFailure = { status: 503, message: 'The service is currently unavailable.' };
    await vi.advanceTimersByTimeAsync(DAY);
    await until(() => health.read().subscription.error !== null);

    expect(health.read().subscription).toMatchObject({ state: 'unknown', name: null, expireTime: null });
  });
});
