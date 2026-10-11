/**
 * GWS-EA's Google Chat, as the assistant's own account (KTD2, KTD3, KTD12).
 * Chat's events reach the host through a Workspace Events subscription the
 * host keeps (subscription.ts) and a Pub/Sub subscription it pulls
 * (pubsub-pull.ts), so the host needs no public endpoint. The Chat channel
 * starts both when it initializes (delivery.ts).
 *
 * A host without Chat delivery (config.ts) runs none of it. Status reads
 * whether Chat is receiving through `gws-ea-chat health`.
 */
import { register } from '../../cli/registry.js';
import { chatHealth } from './health.js';

// What status reads, from the host only: whether the consumer is connected, its last pull, the
// subscription's state and expiry, and each side's last error kind.
register({
  name: 'gws-ea-chat-health',
  description: 'Report whether Google Chat is receiving: the pull consumer and the subscription.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const unknown = Object.keys(raw);
    if (unknown.length > 0) throw new Error(`Unknown Chat field: --${unknown[0]}`);
    return undefined;
  },
  handler: async () => chatHealth.read(),
});

export {
  GCHAT_PROJECT_ID_ENV,
  GCHAT_SUBSCRIBER_KEY_FILE_ENV,
  readChatDeliveryConfig,
  type ChatDeliveryConfig,
} from './config.js';
export { startChatDelivery, type ChatDelivery, type ChatDeliveryOptions } from './delivery.js';
export {
  chatHealth,
  type ChatErrorKind,
  type ChatHealth,
  type ChatHealthError,
  type ChatSubscriptionState,
} from './health.js';
export type { WorkspaceEvent } from './pubsub-pull.js';
export {
  CHAT_EVENT_TYPES,
  CHAT_MESSAGE_CREATED,
  CHAT_REACTION_CREATED,
  CHAT_SUBSCRIPTION_TARGET,
} from './subscription.js';
