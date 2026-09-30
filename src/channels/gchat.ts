/**
 * Google Chat channel adapter (v2) — uses the standard Chat SDK bridge.
 * Self-registers on import.
 */
import { createGoogleChatAdapter } from '@chat-adapter/gchat';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

const GCHAT_ENV_KEYS = [
  'GCHAT_CREDENTIALS',
  'GCHAT_ENDPOINT_URL',
  'GCHAT_BOT_USER_ID',
  'GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL',
] as const;
const GCHAT_BOT_USER_ID_RE = /^users\/[^/\s]+$/;
const GCHAT_ADDON_IDENTITY_RE = /^service-[1-9]\d*@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const ALTERNATE_VERIFIER_ENV_KEYS = [
  'GOOGLE_CHAT_PROJECT_NUMBER',
  'GOOGLE_CHAT_PUBSUB_AUDIENCE',
  'GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_CHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION',
] as const;

interface GoogleChatCredentials {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function configuredValue(processValue: string | undefined, fileValue: string | undefined): string | undefined {
  if (processValue?.trim()) return processValue;
  if (fileValue?.trim()) return fileValue;
  return undefined;
}

function parseCredentials(raw: string): GoogleChatCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('GCHAT_CREDENTIALS must contain valid JSON', { cause });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('GCHAT_CREDENTIALS must be a service-account JSON object');
  }

  const value = parsed as Record<string, unknown>;
  if (typeof value.client_email !== 'string' || !value.client_email.trim()) {
    throw new Error('GCHAT_CREDENTIALS must contain a non-empty client_email');
  }
  if (typeof value.private_key !== 'string' || !value.private_key.trim()) {
    throw new Error('GCHAT_CREDENTIALS must contain a non-empty private_key');
  }
  if (value.project_id !== undefined && typeof value.project_id !== 'string') {
    throw new Error('GCHAT_CREDENTIALS project_id must be a string when present');
  }

  return {
    client_email: value.client_email,
    private_key: value.private_key,
    ...(value.project_id !== undefined ? { project_id: value.project_id } : {}),
  };
}

function validateEndpointUrl(endpointUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch (cause) {
    throw new Error('GCHAT_ENDPOINT_URL must be a valid absolute URL', { cause });
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('GCHAT_ENDPOINT_URL must use https');
  }
}

function validateBotUserId(botUserId: string): void {
  if (!GCHAT_BOT_USER_ID_RE.test(botUserId)) {
    throw new Error('GCHAT_BOT_USER_ID must be a canonical Google Chat user resource name (users/<id>)');
  }
}

function rejectAlternateVerifierConfiguration(): void {
  const configuredKeys = ALTERNATE_VERIFIER_ENV_KEYS.filter((key) => process.env[key]?.trim());
  if (configuredKeys.length === 0) return;

  throw new Error(
    `Google Chat exact endpoint verification cannot be combined with alternate verifier settings: ${configuredKeys.join(', ')}`,
  );
}

/** The silent reaction Google Chat shows on the principal's message while the assistant works. */
const WORKING_REACTION = '👀';
/**
 * The typing module refreshes every 4 s from an engaged message; the reaction
 * lands on the refresh about 4 s after the first. The margin absorbs timer
 * jitter so a refresh that fires a few milliseconds early still counts.
 */
const REACT_AFTER_MS = 3_500;
/** No refresh for the host's stuck-work window (CLAIM_STUCK_MS) means the work is over. */
const IDLE_REMOVE_MS = 60_000;
/** A reaction removal never holds a reply back longer than this. */
const REMOVAL_WAIT_MS = 2_000;
/** Conversations whose latest message is remembered; the least recent is forgotten first. */
const MAX_REMEMBERED_CONVERSATIONS = 500;

/** The Google Chat adapter's reaction calls. */
export interface ReactionApi {
  addReaction(threadId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(threadId: string, messageId: string, emoji: string): Promise<void>;
}

interface ReactionTarget {
  threadId: string;
  messageId: string;
}

interface Working {
  startedAt: number;
  idleTimer?: NodeJS.Timeout;
  reaction: { target: ReactionTarget; added: Promise<boolean> } | null;
}

function conversationKey(platformId: string, threadId: string | null): string {
  return `${platformId}\n${threadId ?? ''}`;
}

/** Resolve when `work` settles or after `ms`, whichever comes first. `work` must not reject. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

/**
 * Show a silent reaction on the principal's latest message while the
 * assistant works, in place of the typing indicator Google Chat does not have.
 *
 * The host's typing module calls `setTyping` every 4 s after an engaged
 * message. The first call starts a conversation's clock; the call about 4 s
 * later adds the reaction, so a quick reply shows nothing. The reaction comes
 * off before any message posts to that conversation, or after 60 s without a
 * refresh. Every reaction call is best effort: a Chat app that cannot react
 * shows nothing, and no failure delays or blocks a reply.
 */
export function withWorkingReaction(bridge: ChannelAdapter, reactions: ReactionApi): ChannelAdapter {
  const latestMessage = new Map<string, ReactionTarget>();
  const working = new Map<string, Working>();
  const { setup: bridgeSetup, deliver: bridgeDeliver, teardown: bridgeTeardown } = bridge;

  function remember(key: string, target: ReactionTarget): void {
    latestMessage.delete(key);
    latestMessage.set(key, target);
    if (latestMessage.size > MAX_REMEMBERED_CONVERSATIONS) {
      const oldest = latestMessage.keys().next();
      if (!oldest.done) latestMessage.delete(oldest.value);
    }
    // A new message gets its own wait: a clock still running from earlier
    // work would otherwise react to it on the first refresh.
    const current = working.get(key);
    if (current && !current.reaction) {
      clearTimeout(current.idleTimer);
      working.delete(key);
    }
  }

  function add(target: ReactionTarget): Promise<boolean> {
    return reactions.addReaction(target.threadId, target.messageId, WORKING_REACTION).then(
      () => true,
      (err: unknown) => {
        log.debug('Google Chat working reaction could not be added', { messageId: target.messageId, err });
        return false;
      },
    );
  }

  async function remove(reaction: NonNullable<Working['reaction']>): Promise<void> {
    if (!(await reaction.added)) return;
    const { threadId, messageId } = reaction.target;
    await reactions.removeReaction(threadId, messageId, WORKING_REACTION).catch((err: unknown) => {
      log.debug('Google Chat working reaction could not be removed', { messageId, err });
    });
  }

  function stop(key: string): Promise<void> {
    const current = working.get(key);
    if (!current) return Promise.resolve();
    working.delete(key);
    clearTimeout(current.idleTimer);
    return current.reaction ? remove(current.reaction) : Promise.resolve();
  }

  bridge.setup = (config) =>
    bridgeSetup.call(bridge, {
      ...config,
      onInbound: (platformId, threadId, message) => {
        if (message.authenticatedSender?.kind === 'human') {
          const target = { threadId: threadId ?? platformId, messageId: message.id };
          // Typing arrives with the thread the router kept: the thread in a
          // threaded conversation, none in a DM.
          remember(conversationKey(platformId, threadId), target);
          if (threadId !== null) remember(conversationKey(platformId, null), target);
        }
        return config.onInbound(platformId, threadId, message);
      },
    });

  bridge.setTyping = async (platformId, threadId) => {
    const key = conversationKey(platformId, threadId);
    const now = Date.now();
    const state = working.get(key) ?? { startedAt: now, reaction: null };
    working.set(key, state);
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (working.get(key) === state) void stop(key);
    }, IDLE_REMOVE_MS);
    state.idleTimer.unref();

    if (state.reaction || now - state.startedAt < REACT_AFTER_MS) return;
    const target = latestMessage.get(key);
    if (target) state.reaction = { target, added: add(target) };
  };

  bridge.deliver = async (platformId, threadId, message) => {
    const key = conversationKey(platformId, threadId);
    const answered = latestMessage.get(key);
    await settleWithin(stop(key), REMOVAL_WAIT_MS);
    const platformMessageId = await bridgeDeliver.call(bridge, platformId, threadId, message);
    // Work that continues after a reply never re-reacts to the message it answered.
    if (answered && latestMessage.get(key) === answered) latestMessage.delete(key);
    return platformMessageId;
  };

  bridge.teardown = async () => {
    await settleWithin(Promise.all([...working.keys()].map(stop)), REMOVAL_WAIT_MS);
    latestMessage.clear();
    await bridgeTeardown.call(bridge);
  };

  return bridge;
}

/**
 * Dedicated bot app on a threaded platform. `mention` (not sticky) is the
 * conservative group default; operators upgrade per wiring.
 */
const GCHAT_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('gchat', {
  factory: () => {
    const fileEnv = readEnvFile([...GCHAT_ENV_KEYS]);
    const credentialsRaw = configuredValue(process.env.GCHAT_CREDENTIALS, fileEnv.GCHAT_CREDENTIALS);
    const endpointUrl = configuredValue(process.env.GCHAT_ENDPOINT_URL, fileEnv.GCHAT_ENDPOINT_URL);
    const botUserId = configuredValue(process.env.GCHAT_BOT_USER_ID, fileEnv.GCHAT_BOT_USER_ID);
    const addOnIdentity = configuredValue(
      process.env.GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL,
      fileEnv.GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL,
    );

    if (!credentialsRaw && !endpointUrl && !botUserId && !addOnIdentity) return null;
    if (!credentialsRaw) {
      throw new Error('Google Chat configuration requires GCHAT_CREDENTIALS');
    }
    if (!endpointUrl) {
      throw new Error('Google Chat configuration requires GCHAT_ENDPOINT_URL');
    }
    const credentials = parseCredentials(credentialsRaw);
    validateEndpointUrl(endpointUrl);
    if (botUserId) validateBotUserId(botUserId);
    if (addOnIdentity && !GCHAT_ADDON_IDENTITY_RE.test(addOnIdentity)) {
      throw new Error('GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL must be a Workspace Add-on service identity');
    }
    rejectAlternateVerifierConfiguration();

    const gchatAdapter = createGoogleChatAdapter({
      credentials,
      endpointUrl,
      ...(botUserId ? { botUserId } : {}),
      ...(addOnIdentity ? { workspaceAddOnServiceAccountEmail: addOnIdentity } : {}),
    });
    const bridge = createChatSdkBridge({
      adapter: gchatAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: GCHAT_DEFAULTS,
    });
    return withWorkingReaction(bridge, gchatAdapter);
  },
  defaults: GCHAT_DEFAULTS,
});
