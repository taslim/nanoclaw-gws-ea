/**
 * Google Chat channel adapter (v2). Self-registers on import.
 *
 * Hybrid: chat-sdk for outbound (sendMessage/edit/delete/reactions/cards/files);
 * native inbound via `src/modules/gchat-events/` (one wildcard Workspace Events
 * subscription, persisted across restart, 7-day TTL, Pub/Sub StreamingPull).
 * Chat-sdk's per-space + recreate-on-restart inbound model dropped events on
 * every restart and intermittently in steady state — replaced; outbound surface
 * is non-trivial and keeps working, kept as-is.
 */
import { createGoogleChatAdapter } from '@chat-adapter/gchat';
import { google } from 'googleapis';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { getSaKeyPath, loadServiceAccount, type ServiceAccountKey } from '../gws-paths.js';
import { log } from '../log.js';
import {
  createMemberCache,
  createSpaceCache,
  startInboundStream,
  type InboundHandle,
} from '../modules/gchat-events/inbound.js';
import { ensureWorkspaceSubscription, type SubscriptionHandle } from '../modules/gchat-events/subscription.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

const TOP_LEVEL_MARKER = ':tl';
const EMOJI_RECEIVED = '👀';
const EMOJI_ERROR = '❌';

function dwdJwt(sa: ServiceAccountKey, subject: string, scopes: string[]): InstanceType<typeof google.auth.JWT> {
  return new google.auth.JWT({ email: sa.client_email, key: sa.private_key, scopes, subject });
}

/**
 * Collapse `<scheme:url|display>` tokens where display equals the URL's bare
 * tail. @chat-adapter/gchat's nodeToGChat already does this for plain URLs
 * (`<https://x|https://x>` → `https://x`) but misses mailto/tel because the
 * scheme prefix means linkText !== node.url, so remark-gfm autolinked emails
 * leave the wire as `<mailto:foo|foo>`.
 */
export function collapseRedundantGchatTokens(s: string): string {
  return s
    .replace(/<mailto:([^|>]+)\|\1>/g, '$1')
    .replace(/<tel:([^|>]+)\|\1>/g, '$1')
    .replace(/<(https?:\/\/[^|>]+)\|\1>/g, '$1');
}

/** GChat message names follow `spaces/X/messages/<a>.<b>`. A top-level
 * message has a === b (it is the only entry in its own thread). A reply
 * inside a thread has a !== b. */
function isTopLevelGchatMessage(messageId: string | undefined): boolean {
  if (!messageId) return false;
  const lastSlash = messageId.lastIndexOf('/');
  const localPart = lastSlash >= 0 ? messageId.slice(lastSlash + 1) : messageId;
  const dot = localPart.indexOf('.');
  if (dot < 0) return false;
  return localPart.slice(0, dot) === localPart.slice(dot + 1);
}

registerChannelAdapter('gchat', {
  factory: () => {
    const env = readEnvFile(['ASSISTANT_EMAIL', 'GCHAT_PUBSUB_TOPIC', 'SA_KEY_PATH']);
    if (!env.ASSISTANT_EMAIL) return null;

    const saKeyPath = env.SA_KEY_PATH || getSaKeyPath();
    const sa = loadServiceAccount(saKeyPath);
    if (!sa) {
      log.warn('GChat: service-account key not found, channel disabled', { path: saKeyPath });
      return null;
    }
    if (!env.GCHAT_PUBSUB_TOPIC) {
      log.warn('GChat: GCHAT_PUBSUB_TOPIC not set, channel disabled');
      return null;
    }
    const topicShort = env.GCHAT_PUBSUB_TOPIC;

    // Outbound only — chat-sdk no longer manages inbound subscriptions for us.
    // Omitting `pubsubTopic` makes chat-sdk skip its per-space subscription path.
    const gchatAdapter = createGoogleChatAdapter({
      credentials: { client_email: sa.client_email, private_key: sa.private_key },
      impersonateUser: env.ASSISTANT_EMAIL,
    });

    // Patch the format converter's renderPostable — the single funnel through
    // which postMessage, editMessage, postEphemeral, and postChannelMessage
    // all render — to strip the redundant mailto/tel/url tokens the SDK emits.
    // formatConverter is declared private in the .d.ts but exists at runtime;
    // drop this whole block once the SDK lands the same optimization upstream.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fc = (gchatAdapter as any).formatConverter as { renderPostable(m: unknown): string };
    const origRender = fc.renderPostable.bind(fc);
    fc.renderPostable = (m) => collapseRedundantGchatTokens(origRender(m));

    const bridge = createChatSdkBridge({ adapter: gchatAdapter, concurrency: 'concurrent', supportsThreads: true });

    // Impersonated chat client — used both for inbound message-body fetch
    // (so we read what the user can read) and the existing space metadata
    // reconcile (DM detection). Includes message-read scope on top of the
    // spaces scope used for spaces.get.
    const impersonatedAuth = dwdJwt(sa, env.ASSISTANT_EMAIL, [
      'https://www.googleapis.com/auth/chat.spaces',
      'https://www.googleapis.com/auth/chat.messages.readonly',
    ]);
    const impersonatedChat = google.chat({ version: 'v1', auth: impersonatedAuth });

    // Self user id — under DWD impersonation the assistant posts as the
    // impersonated user, not the bot principal, so any reply we send loops
    // back through Pub/Sub as a normal inbound. Resolve the impersonated
    // user's `users/<id>` once via oauth2.userinfo and drop matching events
    // before they reach the router.
    const selfOauth2 = google.oauth2({
      version: 'v2',
      auth: dwdJwt(sa, env.ASSISTANT_EMAIL, ['openid', 'https://www.googleapis.com/auth/userinfo.email']),
    });
    let selfUserIdPromise: Promise<string | null> | null = null;
    const getSelfUserId = (): Promise<string | null> => {
      if (!selfUserIdPromise) {
        selfUserIdPromise = selfOauth2.userinfo
          .get()
          .then(({ data }) => {
            const id = data.id ? `users/${data.id}` : null;
            log.info('GChat: identified self user', { selfUserId: id, email: data.email });
            if (id) {
              upsertUser({
                id: `gchat:${id}`,
                kind: 'gchat',
                display_name: ASSISTANT_NAME,
                created_at: new Date().toISOString(),
              });
            }
            return id;
          })
          .catch((err) => {
            log.warn('GChat: failed to resolve self user id; self-message filter disabled', {
              err: err instanceof Error ? err.message : String(err),
            });
            return null;
          });
      }
      return selfUserIdPromise;
    };
    void getSelfUserId();

    const spaceCache = createSpaceCache();
    const memberCache = createMemberCache();

    const wrappedSetup = bridge.setup.bind(bridge);
    const wrappedTeardown = bridge.teardown.bind(bridge);
    const wrappedDeliver = bridge.deliver.bind(bridge);
    const wrappedSubscribe = bridge.subscribe?.bind(bridge);
    let inboundHandle: InboundHandle | null = null;
    let subscriptionHandle: SubscriptionHandle | null = null;

    bridge.setup = async (config) => {
      // Tag top-level messages with `:tl` so reply delivery posts at space level
      // (the marker is stripped before subscribe-state writes — see bridge.subscribe).
      const wrappedConfig = {
        ...config,
        onInbound: async (
          platformId: string,
          threadId: string | null,
          message: Parameters<typeof config.onInbound>[2],
        ) => {
          const markedThreadId =
            threadId && isTopLevelGchatMessage(message.id) ? `${threadId}${TOP_LEVEL_MARKER}` : threadId;
          await config.onInbound(platformId, markedThreadId, message);
        },
      };
      await wrappedSetup(wrappedConfig);

      try {
        subscriptionHandle = await ensureWorkspaceSubscription({
          auth: impersonatedAuth,
          projectId: sa.project_id,
          topicShort,
        });
        inboundHandle = await startInboundStream({
          projectId: sa.project_id,
          saCredentials: { client_email: sa.client_email, private_key: sa.private_key },
          topicShort,
          selfUserId: getSelfUserId,
          chat: impersonatedChat,
          spaceCache,
          memberCache,
          onInbound: wrappedConfig.onInbound,
        });
      } catch (err) {
        log.error('GChat: native inbound failed to start', { err });
      }
    };

    bridge.teardown = async () => {
      if (inboundHandle) {
        await inboundHandle.stop();
        inboundHandle = null;
      }
      if (subscriptionHandle) {
        subscriptionHandle.stop();
        subscriptionHandle = null;
      }
      await wrappedTeardown();
    };

    // Pass null to drop the thread component and force a flat space-level
    // post; the underlying bridge falls back to platformId.
    bridge.deliver = async (platformId, threadId, message) => {
      const flat = threadId?.endsWith(TOP_LEVEL_MARKER) ?? false;
      return wrappedDeliver(platformId, flat ? null : threadId, message);
    };

    // Subscribe state must store the bare encoded thread id so future
    // in-thread replies match (which arrive without our marker).
    if (wrappedSubscribe) {
      bridge.subscribe = async (platformId, threadId) => {
        const stripped = threadId.endsWith(TOP_LEVEL_MARKER) ? threadId.slice(0, -TOP_LEVEL_MARKER.length) : threadId;
        await wrappedSubscribe(platformId, stripped);
      };
    }

    bridge.markReceived = async (_platformId, threadId, messageId) => {
      await gchatAdapter.addReaction(threadId ?? '', messageId, EMOJI_RECEIVED);
    };
    bridge.clearReceived = async (_platformId, threadId, messageId) => {
      await gchatAdapter.removeReaction(threadId ?? '', messageId, EMOJI_RECEIVED);
    };
    bridge.markError = async (_platformId, threadId, messageId) => {
      try {
        await gchatAdapter.removeReaction(threadId ?? '', messageId, EMOJI_RECEIVED);
      } catch (err) {
        log.debug('GChat: removeReaction failed during error swap', { messageId, err });
      }
      await gchatAdapter.addReaction(threadId ?? '', messageId, EMOJI_ERROR);
    };

    return bridge;
  },
});
