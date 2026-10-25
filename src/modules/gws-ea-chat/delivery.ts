/**
 * The subscription supervisor and the pull consumer, which the Chat channel
 * starts when it initializes and stops when it disconnects. A Chat event goes
 * to the channel whichever subscription it came through, so one retained from
 * an expired subscription is still handled.
 */
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import type { ChatDeliveryConfig } from './config.js';
import { chatHealth, type ChatHealthRecorder } from './health.js';
import { startPullConsumer, type WorkspaceEvent } from './pubsub-pull.js';
import { createSubscriberToken } from './subscriber-credentials.js';
import { isSubscriptionLifecycleEvent, startSubscriptionSupervisor } from './subscription.js';

export interface ChatDeliveryOptions {
  readonly config: ChatDeliveryConfig;
  /** Resolves once the event is handled; rejecting leaves it for Pub/Sub to deliver again. */
  readonly onChatEvent: (event: WorkspaceEvent) => Promise<void>;
  readonly assistantToken?: () => Promise<string>;
  readonly subscriberToken?: () => Promise<string>;
  readonly health?: ChatHealthRecorder;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ChatDelivery {
  stop(): Promise<void>;
}

export function startChatDelivery(options: ChatDeliveryOptions): ChatDelivery {
  const health = options.health ?? chatHealth;
  const fetch = options.fetch === undefined ? {} : { fetch: options.fetch };
  const supervisor = startSubscriptionSupervisor({
    topic: options.config.topic,
    token: options.assistantToken ?? (() => hostGoogleAccessToken('chat')),
    health,
    ...fetch,
  });
  const consumer = startPullConsumer({
    subscription: options.config.subscription,
    token: options.subscriberToken ?? createSubscriberToken({ keyFile: options.config.subscriberKeyFile, ...fetch }),
    handle: (event) =>
      isSubscriptionLifecycleEvent(event) ? supervisor.handleLifecycleEvent(event) : options.onChatEvent(event),
    health,
    ...fetch,
  });
  return {
    async stop() {
      await Promise.all([consumer.stop(), supervisor.stop()]);
    },
  };
}
