/**
 * The assistant's Chat delivery (KTD2, KTD3): the subscription supervisor
 * and the pull consumer, which the Chat channel starts when it initializes
 * and stops when it disconnects. The consumer hands each lifecycle event
 * about a subscription to the supervisor, and every Chat event to the
 * channel, whichever subscription it came through.
 */
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import type { ChatDeliveryConfig } from './config.js';
import { chatHealth, type ChatHealthRecorder } from './health.js';
import { startPullConsumer, type WorkspaceEvent } from './pubsub-pull.js';
import { createSubscriberToken } from './subscriber-credentials.js';
import { isSubscriptionLifecycleEvent, startSubscriptionSupervisor } from './subscription.js';

export interface ChatDeliveryOptions {
  readonly config: ChatDeliveryConfig;
  /**
   * Handles one Chat event (a message or reaction, single or batched). It
   * resolves once the event is routed, answered, or found permanent, and
   * rejects when Pub/Sub must deliver it again.
   */
  readonly onChatEvent: (event: WorkspaceEvent) => Promise<void>;
  /** The assistant's Chat token; the host's own by default. */
  readonly assistantToken?: () => Promise<string>;
  /** The subscriber's Pub/Sub token; minted from the configured key file by default. */
  readonly subscriberToken?: () => Promise<string>;
  /** Where health is recorded; this host's by default. */
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
