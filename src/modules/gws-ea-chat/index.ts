/**
 * GWS-EA's Google Chat, as the assistant's own account (KTD1–KTD4, KTD12).
 * Chat's events reach the host through a Workspace Events subscription the
 * host keeps (subscription.ts) and a Pub/Sub subscription it pulls
 * (pubsub-pull.ts), so the host needs no public endpoint. The `gchat`
 * channel registers here, as the email channel registers from its module:
 * upstream's Chat SDK adapter signed in as the assistant (adapter.ts), which
 * starts both when it initializes (delivery.ts) and reads each event it
 * pulls (hydrate.ts).
 *
 * A host without the assistant's Google sign-in or without Chat delivery
 * (config.ts) has no Chat channel. Status reads whether Chat is receiving
 * through `gws-ea-chat health`, and create opens the principal's DM through
 * `gws-ea-chat open-principal-dm` (dm.ts).
 */
import type { ChannelAdapter } from '../../channels/adapter.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { register } from '../../cli/registry.js';
import { GCHAT_CHANNEL_TYPE } from '../../gws-ea/types.js';
import { normalizePrincipalEmail } from '../../gws-ea/validation.js';
import { googleGrantFilePath } from '../gws-ea-google/grant-file.js';
import { assistantGoogleAccount, hostGoogleAccessToken, type AssistantGoogleAccount } from '../gws-ea-google/index.js';
import { AssistantChatAdapter, createAssistantChatChannel, GCHAT_DEFAULTS, hostChatAuth } from './adapter.js';
import { readChatDeliveryConfig, type ChatDeliveryConfig } from './config.js';
import { startChatDelivery } from './delivery.js';
import { openPrincipalDm } from './dm.js';
import { chatHealth } from './health.js';
import { createChatHydrator } from './hydrate.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The assistant's account from its grant. Chat knows the assistant by the
 * account's Google ID, which a grant from before Chat lacks: a grant this
 * host cannot read needs a new sign-in.
 */
async function signedInAssistant(): Promise<AssistantGoogleAccount> {
  let assistant: AssistantGoogleAccount | undefined;
  try {
    assistant = await assistantGoogleAccount();
  } catch (error) {
    throw new Error(
      `Google Chat cannot start: the assistant's Google sign-in cannot be read (${errorMessage(error)}); sign in to Google again`,
      { cause: error },
    );
  }
  if (assistant === undefined) {
    throw new Error('Google Chat cannot start: the assistant has not signed in to Google; sign in to Google first');
  }
  return assistant;
}

async function createAssistantChat(delivery: ChatDeliveryConfig): Promise<ChannelAdapter> {
  const assistant = await signedInAssistant();
  const chatToken = () => hostGoogleAccessToken('chat');
  const adapter = new AssistantChatAdapter({
    botUserId: `users/${assistant.sub}`,
    // A mention of the assistant reads to agents as its address's handle.
    userName: /^[^@]+/u.exec(assistant.account)?.[0] ?? assistant.account,
    auth: hostChatAuth(chatToken),
    hydrator: createChatHydrator({ chatToken, directoryToken: () => hostGoogleAccessToken('directory-host') }),
    startDelivery: (onChatEvent) => startChatDelivery({ config: delivery, onChatEvent }),
  });
  return createAssistantChatChannel(adapter);
}

registerChannelAdapter(GCHAT_CHANNEL_TYPE, {
  // Only a host with the assistant's Google sign-in and its Chat delivery has Chat.
  factory: () => {
    if (googleGrantFilePath() === undefined) return null;
    const delivery = readChatDeliveryConfig();
    return delivery === undefined ? null : createAssistantChat(delivery);
  },
  defaults: GCHAT_DEFAULTS,
});

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

// Create's binding, from the host only: the assistant opens its DM with the one address the
// principal uses for Google Chat, and answers with the person Google resolved and its conversation.
register({
  name: 'gws-ea-chat-open-principal-dm',
  description: "Open the assistant's direct message with the principal's Google Chat address.",
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const unknown = Object.keys(raw).filter((key) => key !== 'email');
    if (unknown.length > 0) throw new Error(`Unknown Chat field: --${unknown[0]}`);
    const email = typeof raw.email === 'string' ? normalizePrincipalEmail(raw.email) : undefined;
    if (email === undefined) throw new Error("--email must be the principal's Google Chat address");
    return { email };
  },
  handler: async ({ email }) => {
    const assistant = await signedInAssistant();
    return openPrincipalDm(email, {
      chatToken: () => hostGoogleAccessToken('chat'),
      assistantUserId: `users/${assistant.sub}`,
    });
  },
});

export {
  AssistantChatAdapter,
  extractGchatReplyContext,
  GCHAT_DEFAULTS,
  type ChatReactionEvent,
  type ChatReactionHandler,
} from './adapter.js';
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
