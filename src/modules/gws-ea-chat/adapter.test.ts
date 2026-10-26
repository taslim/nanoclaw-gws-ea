/**
 * The assistant's Chat adapter, driven as the pull consumer drives it: each
 * test hands it Workspace events and reads what reaches the host through the
 * real Chat SDK bridge and core, over the SQLite state store. Google's HTTP is
 * faked at the `fetch` boundary, for both the channel's own reads and writes
 * and the SDK's Chat client. The working 👀 is driven as the host's typing
 * module drives it, through the bridge's typing pulse and its end.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup, InboundMessage } from '../../channels/adapter.js';
import { readPostedRequest } from '../../channels/chat-sdk-bridge.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { createSession, getPendingApproval } from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerMessageInterceptor, routeInbound } from '../../router.js';
import type { Session } from '../../types.js';
import * as typing from '../typing/index.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDeliveryAdapter, setDeliveryAdapter } from '../../delivery.js';
import { SqliteStateAdapter } from '../../state-sqlite.js';
import { requestApproval } from '../approvals/primitive.js';
import { RENEW_BEFORE_EXPIRY_MS } from '../gws-ea-google/tokens.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import { chatsMigration } from '../gws-ea-chats/migration.js';
import { startTypingRefresh, stopTypingRefresh } from '../typing/index.js';
import {
  AssistantChatAdapter,
  createAssistantChatChannel,
  extractGchatReplyContext,
  hostChatAuth,
  type ChatReactionEvent,
} from './adapter.js';
import { startChatDelivery } from './delivery.js';
import { createChatHealth } from './health.js';
import { CHAT_MESSAGE_BATCH_CREATED, createChatHydrator } from './hydrate.js';
import type { WorkspaceEvent } from './pubsub-pull.js';
import { CHAT_MESSAGE_CREATED, CHAT_REACTION_CREATED } from './subscription.js';
import {
  ASSISTANT,
  CHAT_TOKEN,
  DIRECTORY_TOKEN,
  FakeChatApi,
  chatMessage,
  mentionOf,
} from './testing/fake-chat-api.js';
import { FakeGoogleEvents, SUBSCRIBER_TOKEN, SUBSCRIPTION, TOPIC } from './testing/fake-google-events.js';

const { registerWebhookAdapter, TEST_DATA_DIR } = vi.hoisted(() => ({
  registerWebhookAdapter: vi.fn(),
  TEST_DATA_DIR: `/tmp/gws-ea-chat-voice-${process.pid}`,
}));
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('../../webhook-server.js', () => ({ registerWebhookAdapter }));

const DM = 'spaces/AAAAjuno';
const ROOM = 'spaces/AAAAroom';

interface Routed {
  readonly platformId: string;
  readonly threadId: string | null;
  readonly message: InboundMessage;
}

let api: FakeChatApi;
let adapter: AssistantChatAdapter;
let channel: ChannelAdapter | undefined;
let routed: Routed[];
/** What the host fails to route, once each, by inbound id, as it does when the router throws. */
let unroutable: Set<string>;
/** The consumer's handler, as the adapter hands it over when it starts its delivery. */
let deliver: ((event: WorkspaceEvent) => Promise<void>) | undefined;
let deliveriesStopped: number;
/** How often the SDK's Chat client took the host's Chat token. */
let hostTokensTaken: number;
/** How the channel's own Chat calls reach Google. */
let chatFetch: typeof globalThis.fetch;
/** The SDK's authenticated media download, including slow native HTTP in the lease test. */
let sdkFetch: typeof globalThis.fetch;
let interceptedSourceId: string | undefined;
let awaitingInterceptedReply: boolean;
let consumedReplies: number;
/** The answers the channel handed the host, as onAction received them. */
let answered: Array<Parameters<ChannelSetup['onAction']>>;

// The router's native capture seam disarms after consuming a naming/rejection
// reply. Redelivery must not then turn that same source into an ordinary turn.
registerMessageInterceptor(async (event) => {
  if (event.message.id !== interceptedSourceId || !awaitingInterceptedReply) return false;
  awaitingInterceptedReply = false;
  consumedReplies += 1;
  return true;
});

beforeEach(async () => {
  await runMigrations(await initTestDb());
  api = new FakeChatApi();
  chatFetch = api.fetch;
  sdkFetch = api.fetch;
  api.addSpace(DM, 'DIRECT_MESSAGE');
  api.addSpace(ROOM, 'SPACE');
  api.people.set('2001', 'Juno Hale');
  routed = [];
  unroutable = new Set();
  deliver = undefined;
  deliveriesStopped = 0;
  hostTokensTaken = 0;
  interceptedSourceId = undefined;
  awaitingInterceptedReply = false;
  consumedReplies = 0;
  answered = [];
  registerWebhookAdapter.mockClear();
});

afterEach(async () => {
  await channel?.teardown();
  channel = undefined;
  await closeDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The channel as the host builds it, not yet set up. */
function build(startDelivery?: ConstructorParameters<typeof AssistantChatAdapter>[0]['startDelivery']): ChannelAdapter {
  adapter = new AssistantChatAdapter({
    botUserId: ASSISTANT,
    userName: 'morgan',
    auth: hostChatAuth(async () => {
      hostTokensTaken += 1;
      return CHAT_TOKEN;
    }, sdkFetch),
    hydrator: createChatHydrator({
      chatToken: async () => CHAT_TOKEN,
      directoryToken: async () => DIRECTORY_TOKEN,
      fetch: api.fetch,
    }),
    chatToken: async () => CHAT_TOKEN,
    fetch: chatFetch,
    startDelivery:
      startDelivery ??
      ((onChatEvent) => {
        deliver = onChatEvent;
        return {
          stop: async () => {
            deliveriesStopped += 1;
          },
        };
      }),
  });
  const built = createAssistantChatChannel(adapter);
  channel = built;
  return built;
}

/** The host's side of the channel: what it routes is recorded. */
function hostSetup(): ChannelSetup {
  return {
    async onInbound(platformId, threadId, message) {
      if (unroutable.delete(message.id)) throw new Error('database is locked');
      routed.push({ platformId, threadId, message });
    },
    onInboundEvent: () => undefined,
    onMetadata: () => undefined,
    onAction: (...answer) => {
      answered.push(answer);
    },
  };
}

async function start(startDelivery?: ConstructorParameters<typeof AssistantChatAdapter>[0]['startDelivery']) {
  await build(startDelivery).setup(hostSetup());
}

it('uses one stable Google create request ID for a repeated durable text row', async () => {
  await start();
  const message = { kind: 'chat', content: { text: 'A durable notice' } };
  await channel!.deliver(`gchat:${DM}`, null, message, 'notice-row');
  await channel!.deliver(`gchat:${DM}`, null, message, 'notice-row');
  await channel!.deliver(`gchat:${DM}`, null, message, 'another-row');
  const ids = api.calls(`${DM}/messages`).map(({ url }) => url.searchParams.get('requestId'));
  expect(ids).toHaveLength(3);
  expect(ids[0]).toMatch(/^[0-9a-f]{64}$/u);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[2]).not.toBe(ids[0]);
});

function messageEvent(name: string): WorkspaceEvent {
  return {
    messageId: `pubsub-${name}`,
    type: CHAT_MESSAGE_CREATED,
    source: '//workspaceevents.googleapis.com/subscriptions/chat-1',
    subject: `//chat.googleapis.com/${name.split('/messages/')[0]}`,
    time: '2026-10-10T17:00:00Z',
    data: { message: { name } },
  };
}

it.each(['declined', 'detached'])('downloads no media for a %s chat', async (state) => {
  await runMigrations(getDb(), [chatsMigration]);
  await createAgentGroup({
    id: 'closed-chat-agent',
    name: 'external-chat',
    folder: 'closed-chat-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createMessagingGroup({
    id: 'closed-room',
    channel_type: 'gchat',
    instance: 'gchat',
    platform_id: `gchat:${ROOM}`,
    name: 'Closed room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  await getDb().run(
    'INSERT INTO gws_ea_chats (messaging_group_id,state,serving_agent_group_id,principal_present,created_at,updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    'closed-room',
    state,
    'closed-chat-agent',
    new Date().toISOString(),
    new Date().toISOString(),
  );
  await start();
  api.media.set('closed-voice', Buffer.from('recording'));
  api.addMessage(
    chatMessage(ROOM, 'closed.1', {
      attachment: [
        { contentName: 'recording.ogg', contentType: 'audio/ogg', attachmentDataRef: { resourceName: 'closed-voice' } },
      ],
    }),
  );
  await deliver!(messageEvent(`${ROOM}/messages/closed.1`));
  expect(api.calls('media/closed-voice')).toEqual([]);
  expect(routed).toEqual([]);
});

/** A reaction placed four minutes after the message it is on, as Google records the event's time. */
function reactionEvent(name: string): WorkspaceEvent {
  return {
    ...messageEvent(name.split('/reactions/')[0]!),
    type: CHAT_REACTION_CREATED,
    time: '2026-10-10T17:04:00Z',
    data: { reaction: { name } },
  };
}

/** A batch event naming the DM's messages `ids`, in the order Google lists them. */
function batchEvent(...ids: string[]): WorkspaceEvent {
  return {
    ...messageEvent(`${DM}/messages/${ids[0]!}`),
    type: CHAT_MESSAGE_BATCH_CREATED,
    data: { messages: ids.map((id) => ({ message: { name: `${DM}/messages/${id}` } })) },
  };
}

/** A reaction Google holds: Juno Hale's 👍 unless another person or emoji is named. */
function reacted(name: string, by = 'users/2001', unicode = '👍'): void {
  api.addReaction({ name, user: { name: by, type: 'HUMAN' }, emoji: { unicode } });
}

function content(index = 0): Record<string, unknown> {
  return routed[index]!.message.content as Record<string, unknown>;
}

function threadOf(space: string, thread: string): string {
  return `gchat:${space}:${Buffer.from(`${space}/threads/${thread}`).toString('base64url')}`;
}

describe('messages', () => {
  it('reads a name-only DM message and routes it as a DM, which always addresses the assistant', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'remy.1', { text: 'Can you move Thursday?' }));

    await deliver!(messageEvent(`${DM}/messages/remy.1`));

    expect(routed).toEqual([
      {
        platformId: `gchat:${DM}`,
        threadId: `gchat:${DM}:dm`,
        message: expect.objectContaining({
          id: `${DM}/messages/remy.1`,
          kind: 'chat-sdk',
          timestamp: '2026-10-10T17:00:00.000Z',
          isMention: true,
          isGroup: false,
          deduplicate: true,
          authenticatedSender: { userId: 'users/2001', displayName: 'Juno Hale', kind: 'human' },
        }),
      },
    ]);
    expect(content()).toMatchObject({ text: 'Can you move Thursday?', sender: 'Juno Hale', senderId: 'users/2001' });
  });

  it("counts a mention of the assistant's account in a space, and reads each one as its handle", async () => {
    await start();
    api.addMessage(
      chatMessage(ROOM, 'remy.1', {
        text: '@Morgan Ellery and @Remy Vance, lunch? @Morgan Ellery, you pick.',
        annotations: [mentionOf(ASSISTANT, 0, 14), mentionOf('users/2003', 19, 11), mentionOf(ASSISTANT, 39, 14)],
      }),
    );

    await deliver!(messageEvent(`${ROOM}/messages/remy.1`));

    expect(routed).toEqual([
      expect.objectContaining({
        platformId: `gchat:${ROOM}`,
        threadId: threadOf(ROOM, 'remy'),
        message: expect.objectContaining({ isMention: true, isGroup: true }),
      }),
    ]);
    expect(content().text).toBe('@morgan and @Remy Vance, lunch? @morgan, you pick.');
  });

  it('dispatches each message of a batch, in the order they were written', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'remy.1', { text: 'first', createTime: '2026-10-10T17:00:01Z' }));
    api.addMessage(chatMessage(DM, 'remy.2', { text: 'second', createTime: '2026-10-10T17:00:02Z' }));
    api.addMessage(chatMessage(DM, 'remy.3', { text: 'third', createTime: '2026-10-10T17:00:03Z' }));

    await deliver!(batchEvent('remy.3', 'remy.1', 'remy.2'));

    expect(routed.map((entry) => (entry.message.content as { text: string }).text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it("drops the assistant's own message without looking up its name", async () => {
    await start();
    api.addMessage(chatMessage(DM, 'morgan.1', { from: ASSISTANT, text: 'Done: Thursday moved.' }));

    await deliver!(messageEvent(`${DM}/messages/morgan.1`));

    expect(routed).toEqual([]);
    expect(api.requests.filter((request) => request.url.host === 'people.googleapis.com')).toEqual([]);
  });

  it('gives the agent the quoted text, its author by name and id, and the name of the message replied to', async () => {
    await start();
    api.addMessage(
      chatMessage(DM, 'remy.2', {
        text: 'yes',
        quotedMessageMetadata: {
          name: `${DM}/messages/juno.1`,
          quoteType: 'REPLY',
          quotedMessageSnapshot: { sender: 'users/2001', text: 'Shall I move Thursday to Friday?' },
        },
      }),
    );

    await deliver!(messageEvent(`${DM}/messages/remy.2`));

    expect(content().replyTo).toEqual({
      id: `${DM}/messages/juno.1`,
      sender: 'Juno Hale',
      senderId: 'users/2001',
      text: 'Shall I move Thursday to Friday?',
    });
  });

  it('reads a name once when a member quotes their own message', async () => {
    await start();
    api.addMessage(
      chatMessage(DM, 'juno.2', {
        sender: { name: 'users/2001', type: 'HUMAN' },
        text: 'Still true',
        quotedMessageMetadata: {
          name: `${DM}/messages/juno.1`,
          quoteType: 'REPLY',
          quotedMessageSnapshot: { sender: 'users/2001', text: 'Friday works' },
        },
      }),
    );

    await deliver!(messageEvent(`${DM}/messages/juno.2`));

    expect(content().replyTo).toMatchObject({ sender: 'Juno Hale', senderId: 'users/2001' });
    expect(api.requests.filter((request) => request.url.host === 'people.googleapis.com')).toHaveLength(1);
  });

  it("marks a quote of the assistant's own message, and lists whom a message mentions", async () => {
    await start();
    api.addMessage(
      chatMessage(DM, 'remy.3', {
        text: '@Juno Hale and you, see this',
        annotations: [
          {
            type: 'USER_MENTION',
            startIndex: 0,
            length: 10,
            userMention: { user: { name: 'users/2001', type: 'HUMAN' }, type: 'MENTION' },
          },
          {
            type: 'USER_MENTION',
            startIndex: 15,
            length: 3,
            userMention: { user: { name: ASSISTANT, type: 'HUMAN' }, type: 'MENTION' },
          },
        ],
        quotedMessageMetadata: {
          name: `${DM}/messages/assistant.1`,
          quoteType: 'REPLY',
          quotedMessageSnapshot: { sender: ASSISTANT, text: 'Friday at 3?' },
        },
      }),
    );

    await deliver!(messageEvent(`${DM}/messages/remy.3`));

    expect(content().replyTo).toEqual({
      id: `${DM}/messages/assistant.1`,
      sender: ASSISTANT,
      self: true,
      text: 'Friday at 3?',
    });
    expect(content().mentions).toEqual(['users/2001', 'you']);
  });

  it('preserves forwarded audio facts, caption, authenticated participant and original source ID', async () => {
    await start();
    api.media.set('ref-voice', Buffer.from('recording'));
    api.addMessage(
      chatMessage(DM, 'voice.1', {
        text: 'Please summarize this recording.',
        attachment: [
          {
            name: `${DM}/messages/voice.1/attachments/a1`,
            contentName: 'voice.ogg',
            contentType: 'audio/ogg',
            attachmentDataRef: { resourceName: 'ref-voice' },
          },
        ],
        quotedMessageMetadata: {
          name: `${DM}/messages/original.1`,
          quoteType: 'FORWARD',
          quotedMessageSnapshot: { text: 'Book it now.' },
        },
      }),
    );

    await deliver!(messageEvent(`${DM}/messages/voice.1`));

    expect(content()).toMatchObject({
      text: 'Please summarize this recording.',
      attachments: [
        {
          type: 'audio',
          name: 'voice.ogg',
          mimeType: 'audio/ogg',
          data: Buffer.from('recording').toString('base64'),
          audioSource: { kind: 'audio', forwarded: true },
        },
      ],
    });
    expect(content().raw).toBeUndefined();
    expect(routed[0]!.message).toMatchObject({
      id: `${DM}/messages/voice.1`,
      authenticatedSender: { userId: 'users/2001', kind: 'human' },
      deduplicate: true,
    });
    expect(api.calls('media/ref-voice')).toEqual([expect.objectContaining({ authorization: `Bearer ${CHAT_TOKEN}` })]);
  });

  it('keeps a caption and an explicit failed audio result when authenticated media download fails', async () => {
    await start();
    api.addMessage(
      chatMessage(DM, 'voice.2', {
        text: 'The recording explains the move.',
        attachment: [
          {
            name: `${DM}/messages/voice.2/attachments/a1`,
            contentName: 'voice.ogg',
            contentType: 'audio/ogg',
            attachmentDataRef: { resourceName: 'unavailable-voice' },
          },
        ],
      }),
    );

    await deliver!(messageEvent(`${DM}/messages/voice.2`));

    expect(content()).toMatchObject({
      text: 'The recording explains the move.',
      attachments: [
        {
          type: 'audio',
          audioSource: { kind: 'audio' },
          speech: { status: 'failed', reason: 'media-download-failed' },
        },
      ],
    });
    expect(content().attachments).toEqual([expect.not.objectContaining({ data: expect.anything() })]);
  });

  it('does not treat a new audio reply as a forwarded or quoted recording', async () => {
    await start();
    api.media.set('ref-reply-voice', Buffer.from('new recording'));
    api.addMessage(
      chatMessage(DM, 'voice.3', {
        text: '',
        attachment: [
          {
            contentName: 'reply.ogg',
            contentType: 'audio/ogg',
            attachmentDataRef: { resourceName: 'ref-reply-voice' },
          },
        ],
        quotedMessageMetadata: {
          quoteType: 'REPLY',
          name: `${DM}/messages/old.1`,
          quotedMessageSnapshot: { text: 'Which day?' },
        },
      }),
    );

    await deliver!(messageEvent(`${DM}/messages/voice.3`));

    expect(content().attachments).toEqual([expect.objectContaining({ audioSource: { kind: 'audio' } })]);
    expect(content().replyTo).toMatchObject({ id: `${DM}/messages/old.1` });
  });

  it('downloads a Chat-uploaded attachment through the SDK, as the assistant', async () => {
    await start();
    api.media.set('ref-agenda', Buffer.from('agenda'));
    api.addMessage(
      chatMessage(DM, 'remy.1', {
        text: '',
        attachment: [
          {
            name: `${DM}/messages/remy.1/attachments/a1`,
            contentName: 'agenda.txt',
            contentType: 'text/plain',
            attachmentDataRef: { resourceName: 'ref-agenda' },
          },
        ],
      }),
    );

    await deliver!(messageEvent(`${DM}/messages/remy.1`));

    expect(content().attachments).toEqual([
      expect.objectContaining({
        name: 'agenda.txt',
        mimeType: 'text/plain',
        data: Buffer.from('agenda').toString('base64'),
      }),
    ]);
  });
});

describe('slow native audio download', () => {
  it('renews the pull lease and preserves following text until the recording reaches routing', async () => {
    vi.useFakeTimers();
    const events = new FakeGoogleEvents();
    const apiFetch = api.fetch;
    let downloading = false;
    let releaseMedia: () => void = () => undefined;
    const mediaReady = new Promise<void>((resolve) => {
      releaseMedia = resolve;
    });
    sdkFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/v1/media/ref-slow') {
        downloading = true;
        await mediaReady;
      }
      return apiFetch(input, init);
    };
    const fetch: typeof globalThis.fetch = (input, init) => {
      const hostname = new URL(input instanceof Request ? input.url : String(input)).hostname;
      return hostname === 'chat.googleapis.com' || hostname === 'people.googleapis.com'
        ? apiFetch(input, init)
        : events.fetch(input, init);
    };
    await start((onChatEvent) =>
      startChatDelivery({
        config: { subscriberKeyFile: '/unused', topic: TOPIC, subscription: SUBSCRIPTION },
        onChatEvent,
        assistantToken: async () => CHAT_TOKEN,
        subscriberToken: async () => SUBSCRIBER_TOKEN,
        health: createChatHealth(),
        fetch,
      }),
    );
    api.media.set('ref-slow', Buffer.from('complete recording'));
    api.addMessage(
      chatMessage(DM, 'slow.1', {
        text: '',
        attachment: [
          { contentName: 'slow.ogg', contentType: 'audio/ogg', attachmentDataRef: { resourceName: 'ref-slow' } },
        ],
      }),
    );
    api.addMessage(chatMessage(DM, 'slow.2', { text: 'Actually, cancel that.', createTime: '2026-10-10T17:00:01Z' }));
    const publish = (name: string, time: string) =>
      events.publish({
        type: CHAT_MESSAGE_CREATED,
        subject: `//chat.googleapis.com/${DM}`,
        time,
        data: { message: { name } },
      });
    const noteId = publish(`${DM}/messages/slow.1`, '2026-10-10T17:00:00Z');
    const until = async (check: () => boolean) => {
      for (let waited = 0; !check(); waited += 10) {
        if (waited > 5_000) throw new Error('The native pull delivery did not progress');
        await vi.advanceTimersByTimeAsync(10);
      }
    };
    try {
      await until(() => downloading);
      const cancelId = publish(`${DM}/messages/slow.2`, '2026-10-10T17:00:01Z');
      await vi.advanceTimersByTimeAsync(50_000);
      expect(events.acks(noteId)).toBe(0);
      expect(events.acks(cancelId)).toBe(0);
      expect(routed).toEqual([]);
      expect(events.calls('modifyAckDeadline')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: expect.objectContaining({ ackIds: expect.arrayContaining([`${noteId}-ack-1`]) }),
          }),
        ]),
      );
      releaseMedia();
      await until(() => events.acks(cancelId) === 1);
      expect(events.acks(noteId)).toBe(1);
      expect(routed.map((entry) => entry.message.id)).toEqual([`${DM}/messages/slow.1`, `${DM}/messages/slow.2`]);
      expect(content()).toMatchObject({
        attachments: [{ data: Buffer.from('complete recording').toString('base64') }],
      });
    } finally {
      releaseMedia();
    }
  });
});

describe('durable acceptance across Chat dispatch restart', () => {
  async function nativeMailboxHost(): Promise<ChannelSetup> {
    const now = new Date().toISOString();
    await createAgentGroup({
      id: 'ag-voice',
      name: 'voice-test',
      folder: 'voice-test',
      agent_provider: null,
      created_at: now,
    });
    await createMessagingGroup({
      id: 'mg-voice',
      channel_type: 'gchat',
      instance: 'gchat',
      platform_id: `gchat:${DM}`,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    });
    await createMessagingGroupAgent({
      id: 'wire-voice',
      messaging_group_id: 'mg-voice',
      agent_group_id: 'ag-voice',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      created_at: now,
    });
    vi.spyOn(typing, 'startTypingRefresh').mockImplementation(() => undefined);
    return {
      ...hostSetup(),
      onInbound: async (platformId, threadId, message) =>
        routeInbound({
          channelType: 'gchat',
          instance: 'gchat',
          platformId,
          threadId,
          message: { ...message, content: JSON.stringify(message.content) },
        }),
    };
  }

  it.each([false, true])(
    'does not repeat a typed command denial on redelivery (audio attached: %s)',
    async (withAudio) => {
      // The router sends a denial straight to the chat (never through outbound.db).
      const denials: string[] = [];
      setDeliveryAdapter({
        async deliver(_channelType, _platformId, _threadId, _kind, content) {
          denials.push(content);
          return undefined;
        },
      });
      await build().setup(await nativeMailboxHost());
      api.media.set('ref-command', Buffer.from('recording beside command'));
      api.addMessage(
        chatMessage(DM, 'denied.1', {
          text: '/clear',
          ...(withAudio
            ? {
                attachment: [
                  {
                    contentName: 'command.ogg',
                    contentType: 'audio/ogg',
                    attachmentDataRef: { resourceName: 'ref-command' },
                  },
                ],
              }
            : {}),
        }),
      );
      await deliver!(messageEvent(`${DM}/messages/denied.1`));
      await deliver!(messageEvent(`${DM}/messages/denied.1`));

      expect(denials).toEqual([JSON.stringify({ text: 'Permission denied: /clear requires admin access.' })]);
    },
  );

  it('does not route a consumed audio caption as an ordinary turn on redelivery', async () => {
    await build().setup(await nativeMailboxHost());
    interceptedSourceId = `${DM}/messages/captured.1`;
    awaitingInterceptedReply = true;
    api.media.set('ref-captured', Buffer.from('recording beside captured reply'));
    api.addMessage(
      chatMessage(DM, 'captured.1', {
        text: 'The amount is incorrect.',
        attachment: [
          {
            contentName: 'reason.ogg',
            contentType: 'audio/ogg',
            attachmentDataRef: { resourceName: 'ref-captured' },
          },
        ],
      }),
    );

    await deliver!(messageEvent(interceptedSourceId));
    await deliver!(messageEvent(interceptedSourceId));

    expect(consumedReplies).toBe(1);
    expect(await getDb().get('SELECT id FROM sessions WHERE agent_group_id = ?', 'ag-voice')).toBeUndefined();
  });

  it('retries an SDK claim left before insertion and keeps durable source IDs unique after adapter restart', async () => {
    const nativeHost = await nativeMailboxHost();
    const recording = `${DM}/messages/restart.1`;
    api.media.set('ref-restart', Buffer.from('original recording'));
    api.addMessage(
      chatMessage(DM, 'restart.1', {
        text: 'Please handle this recording.',
        attachment: [
          {
            contentName: 'recording.ogg',
            contentType: 'audio/ogg',
            attachmentDataRef: { resourceName: 'ref-restart' },
          },
        ],
      }),
    );

    // This is the persisted SDK shape after processMessage claimed the event,
    // then the host died during preparation before its mailbox insertion.
    const state = new SqliteStateAdapter();
    await state.connect();
    await state.set(`dedupe:gchat:${recording}`, true, 10 * 60_000);
    await build().setup(nativeHost);
    await deliver!(messageEvent(recording));

    const session = await getDb().get<{ id: string }>('SELECT id FROM sessions WHERE agent_group_id = ?', 'ag-voice');
    expect(session).toBeDefined();
    const inboundPath = path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-voice', session!.id, 'inbound.db');
    const rows = () => {
      const database = new Database(inboundPath, { readonly: true });
      try {
        return database.prepare('SELECT id, content FROM messages_in ORDER BY seq').all() as {
          id: string;
          content: string;
        }[];
      } finally {
        database.close();
      }
    };
    expect(rows()).toEqual([expect.objectContaining({ id: `${recording}:ag-voice` })]);
    const stored = JSON.parse(rows()[0]!.content) as {
      text: string;
      attachments: { localPath: string; data?: string }[];
    };
    expect(stored).toMatchObject({
      text: 'Please handle this recording.',
      attachments: [{ type: 'audio', audioSource: { kind: 'audio' } }],
    });
    expect(stored.attachments[0]!.data).toBeUndefined();
    expect(fs.readFileSync(path.join(path.dirname(inboundPath), stored.attachments[0]!.localPath))).toEqual(
      Buffer.from('original recording'),
    );

    expect(await state.get(`dedupe:gchat:${recording}`)).toEqual({ gwsEaAudioCompleted: true });
    // A completed dispatch keeps the SDK's native acceptance across restart.
    await channel!.teardown();
    await build().setup(nativeHost);
    await deliver!(messageEvent(recording));
    await deliver!(messageEvent(recording));
    expect(rows()).toHaveLength(1);

    // A death after mailbox insertion but before the completion write leaves
    // the SDK's original boolean claim. Native mailbox source IDs still keep
    // that unfinished dispatch unique when replay reaches the router.
    await state.set(`dedupe:gchat:${recording}`, true, 10 * 60_000);
    await channel!.teardown();
    await build().setup(nativeHost);
    await deliver!(messageEvent(recording));
    expect(rows()).toHaveLength(1);
  });
});

describe('when an event cannot be handled', () => {
  it('acknowledges a message that is gone without routing it', async () => {
    await start();

    await expect(deliver!(messageEvent(`${DM}/messages/remy.9`))).resolves.toBeUndefined();
    expect(routed).toEqual([]);
  });

  it('dispatches none of a batch while one of its messages cannot be read, so their order holds', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'remy.1', { createTime: '2026-10-10T17:00:01Z' }));
    api.addMessage(chatMessage(DM, 'remy.2', { createTime: '2026-10-10T17:00:02Z' }));
    api.failures.set(`${DM}/messages/remy.1`, { status: 503, message: 'Unavailable' });
    const batch = batchEvent('remy.1', 'remy.2');

    await expect(deliver!(batch)).rejects.toThrow(/Unavailable/u);
    expect(routed).toEqual([]);

    api.failures.clear();
    await deliver!(batch);
    expect(routed.map((entry) => entry.message.id)).toEqual([`${DM}/messages/remy.1`, `${DM}/messages/remy.2`]);
  });

  it('stops a batch at routing failure and skips accepted text on retry while keeping source order', async () => {
    await start();
    for (const [id, second] of [
      ['remy.1', '01'],
      ['remy.2', '02'],
      ['remy.3', '03'],
    ] as const) {
      api.addMessage(chatMessage(DM, id, { createTime: `2026-10-10T17:00:${second}Z` }));
    }
    unroutable.add(`${DM}/messages/remy.2`);
    const batch = batchEvent('remy.1', 'remy.2', 'remy.3');

    await expect(deliver!(batch)).rejects.toThrow(/database is locked/u);
    expect(routed.map((entry) => entry.message.id)).toEqual([`${DM}/messages/remy.1`]);

    await deliver!(batch);
    expect(routed.map((entry) => entry.message.id)).toEqual([
      `${DM}/messages/remy.1`,
      `${DM}/messages/remy.2`,
      `${DM}/messages/remy.3`,
    ]);
    expect(routed.every((entry) => entry.message.deduplicate === true)).toBe(true);
  });

  it('brings a failed route back through Pub/Sub and routes it once, acknowledged once', async () => {
    const events = new FakeGoogleEvents();
    const fetch: typeof globalThis.fetch = (input, init) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).host;
      return host === 'chat.googleapis.com' || host === 'people.googleapis.com'
        ? api.fetch(input, init)
        : events.fetch(input, init);
    };
    await start((onChatEvent) =>
      startChatDelivery({
        config: { subscriberKeyFile: '/unused', topic: TOPIC, subscription: SUBSCRIPTION },
        onChatEvent,
        assistantToken: async () => CHAT_TOKEN,
        subscriberToken: async () => SUBSCRIBER_TOKEN,
        health: createChatHealth(),
        fetch,
      }),
    );
    api.addMessage(chatMessage(DM, 'remy.1'));
    unroutable.add(`${DM}/messages/remy.1`);

    const id = events.publish({ type: CHAT_MESSAGE_CREATED, data: { message: { name: `${DM}/messages/remy.1` } } });
    await vi.waitFor(() => expect(api.calls(`${DM}/messages/remy.1`)).toHaveLength(1));
    expect(events.acks(id)).toBe(0);

    events.redeliverNow(id);
    await vi.waitFor(() => expect(events.acks(id)).toBe(1));
    expect(routed).toHaveLength(1);
  });
});

describe('reactions', () => {
  const target = `${DM}/messages/morgan.1`;

  function received(): ChatReactionEvent[] {
    const events: ChatReactionEvent[] = [];
    adapter.setReactionHandler(async (event) => {
      events.push(event);
    });
    return events;
  }

  it("hands a reaction on the assistant's message to the reaction handler, read and named", async () => {
    await start();
    const events = received();
    api.addMessage(chatMessage(DM, 'morgan.1', { from: ASSISTANT, text: 'Shall I move Thursday to Friday?' }));
    reacted(`${target}/reactions/r1`);

    await deliver!(reactionEvent(`${target}/reactions/r1`));

    expect(events).toEqual([
      expect.objectContaining({
        reactionName: `${target}/reactions/r1`,
        rawEmoji: '👍',
        added: true,
        messageId: target,
        threadId: `gchat:${DM}:dm`,
        user: { userId: 'users/2001', userName: 'Juno Hale', fullName: 'Juno Hale', isBot: false, isMe: false },
        reactedAt: new Date('2026-10-10T17:04:00Z'),
      }),
    ]);
    expect(events[0]!.emoji.name).toBe('thumbs_up');
    expect(events[0]!.message.author).toMatchObject({ userId: ASSISTANT, isMe: true });
    expect(events[0]!.message.text).toBe('Shall I move Thursday to Friday?');
  });

  it("drops the assistant's own reaction without reading the message it is on", async () => {
    await start();
    const events = received();
    api.addMessage(chatMessage(DM, 'remy.1'));
    reacted(`${DM}/messages/remy.1/reactions/r1`, ASSISTANT, '👀');

    await deliver!(reactionEvent(`${DM}/messages/remy.1/reactions/r1`));

    expect(events).toEqual([]);
    expect(api.calls(`${DM}/messages/remy.1`)).toEqual([]);
  });

  it('acknowledges a reaction removed before it was read', async () => {
    await start();
    const events = received();
    api.addMessage(chatMessage(DM, 'remy.1'));

    await expect(deliver!(reactionEvent(`${DM}/messages/remy.1/reactions/r1`))).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it("routes a reaction through the channel: waking on the assistant's message, quiet on anyone else's", async () => {
    await start();
    api.addMessage(chatMessage(DM, 'morgan.1', { from: ASSISTANT, text: 'Shall I move Thursday to Friday?' }));
    api.addMessage(chatMessage(ROOM, 'remy.1', { from: 'users/2001', text: 'Lunch at 1?' }));
    reacted(`${target}/reactions/r1`);
    reacted(`${ROOM}/messages/remy.1/reactions/r2`);

    await deliver!(reactionEvent(`${target}/reactions/r1`));
    await deliver!(reactionEvent(`${ROOM}/messages/remy.1/reactions/r2`));

    expect(routed).toEqual([
      {
        platformId: `gchat:${DM}`,
        threadId: `gchat:${DM}:dm`,
        message: expect.objectContaining({
          id: `${target}/reactions/r1`,
          timestamp: '2026-10-10T17:04:00.000Z',
          isGroup: false,
          reaction: true,
          deduplicate: true,
          authenticatedSender: { userId: 'users/2001', displayName: 'Juno Hale', kind: 'human' },
        }),
      },
      {
        platformId: `gchat:${ROOM}`,
        threadId: threadOf(ROOM, 'remy'),
        message: expect.objectContaining({ id: `${ROOM}/messages/remy.1/reactions/r2`, isGroup: true, quiet: true }),
      },
    ]);
    expect(routed[0]!.message).not.toHaveProperty('quiet');
    expect(content(0).reaction).toEqual({
      emoji: 'thumbs_up',
      target: {
        self: true,
        sender: 'morgan',
        senderId: 'users/100000000000000000001',
        excerpt: 'Shall I move Thursday to Friday?',
      },
    });
    expect(content(1).reaction).toEqual({
      emoji: 'thumbs_up',
      target: { self: false, sender: 'Juno Hale', senderId: 'users/2001', excerpt: 'Lunch at 1?' },
    });
  });

  it('refuses a reaction whose handler fails, so it comes again', async () => {
    await start();
    adapter.setReactionHandler(async () => {
      throw new Error('database is locked');
    });
    api.addMessage(chatMessage(DM, 'morgan.1', { from: ASSISTANT }));
    reacted(`${target}/reactions/r1`);

    await expect(deliver!(reactionEvent(`${target}/reactions/r1`))).rejects.toThrow(/database is locked/u);
  });
});

describe('the working 👀', () => {
  const PLATFORM = `gchat:${DM}`;
  const JUNO_1 = `${DM}/messages/juno.1`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    api.addMessage(chatMessage(DM, 'juno.1', { text: 'Can you move Thursday to Friday?' }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let Google's fake answers and the state store's writes land. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** The typing module's pulse for a turn working on `anchor` in the DM, as the bridge receives it. */
  async function pulse(anchor = JUNO_1): Promise<void> {
    await channel!.setTyping!(PLATFORM, null, undefined, undefined, anchor);
    await settle();
  }

  async function end(anchor = JUNO_1): Promise<void> {
    await channel!.endTyping!(PLATFORM, null, anchor);
    await settle();
  }

  async function wait(milliseconds: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(milliseconds);
    await settle();
  }

  function eyesOn(message: string): Array<{ name: string; user: string }> {
    return (api.reactions.get(message) ?? [])
      .filter((reaction) => reaction.emoji.unicode === '👀')
      .map((reaction) => ({ name: reaction.name, user: reaction.user.name }));
  }

  function requests(method: 'POST' | 'DELETE'): string[] {
    return api.requests
      .filter((request) => request.method === method && request.url.pathname.includes('/reactions'))
      .map((request) => decodeURIComponent(request.url.pathname.replace(/^\/v1\//u, '')));
  }

  /** The host stops without ending the turn, and starts again. */
  async function crashAndRestart(): Promise<void> {
    await channel!.teardown();
    await start();
  }

  it('shows 👀 on the message once the turn has run 3 seconds, once however often it pulses', async () => {
    await start();
    await pulse();
    await wait(2_900);
    expect(requests('POST')).toEqual([]);

    await wait(200);
    expect(eyesOn(JUNO_1)).toEqual([
      { name: expect.stringMatching(/^spaces\/AAAAjuno\/messages\/juno\.1\/reactions\//u), user: ASSISTANT },
    ]);

    await pulse();
    await wait(4_000);
    await pulse();
    await wait(4_000);
    expect(requests('POST')).toEqual([`${JUNO_1}/reactions`]);
  });

  it('never asks Chat for 👀 on a message the host made itself, such as the welcome to the principal', async () => {
    const welcome = 'gws-ea-welcome:9fab48387b4277a8f29886a43bcd65ec23d9844fc38e3d604abeda5b5573c827';
    await start();
    await pulse(welcome);
    await wait(10_000);
    await end(welcome);

    expect(requests('POST')).toEqual([]);
    expect(requests('DELETE')).toEqual([]);
  });

  it('never shows 👀 for a turn that ends within 3 seconds', async () => {
    await start();
    await pulse();
    await wait(1_000);
    await end();
    await wait(10_000);

    expect(requests('POST')).toEqual([]);
    expect(requests('DELETE')).toEqual([]);
  });

  it('never shows 👀 after the channel stops, for a turn not yet 3 seconds in', async () => {
    await start();
    await pulse();
    await wait(1_000);
    await channel!.teardown();
    channel = undefined;
    await wait(10_000);

    expect(requests('POST')).toEqual([]);
  });

  it("removes exactly its own 👀 by the name Chat gave it, and leaves the principal's own 👀 in place", async () => {
    reacted(`${JUNO_1}/reactions/juno-eyes`, 'users/2001', '👀');
    await start();
    await pulse();
    await wait(3_000);
    const [placed] = eyesOn(JUNO_1).filter((reaction) => reaction.user === ASSISTANT);

    await end();

    expect(requests('DELETE')).toEqual([placed!.name]);
    expect(eyesOn(JUNO_1)).toEqual([{ name: `${JUNO_1}/reactions/juno-eyes`, user: 'users/2001' }]);
  });

  it('never shows 👀 again for a message whose work ended, yet shows it for the next message there', async () => {
    await start();
    await pulse();
    await wait(3_000);
    await end();
    await pulse();
    await wait(10_000);

    // Nor for one whose work ended before it ever pulsed.
    const JUNO_2 = `${DM}/messages/juno.2`;
    api.addMessage(chatMessage(DM, 'juno.2'));
    await end(JUNO_2);
    await pulse(JUNO_2);
    await wait(10_000);

    expect(requests('POST')).toEqual([`${JUNO_1}/reactions`]);
    expect(eyesOn(JUNO_1)).toEqual([]);
    expect(eyesOn(JUNO_2)).toEqual([]);

    const JUNO_3 = `${DM}/messages/juno.3`;
    api.addMessage(chatMessage(DM, 'juno.3'));
    await pulse(JUNO_3);
    await wait(3_000);
    expect(eyesOn(JUNO_3)).toHaveLength(1);
  });

  it('removes the 👀 Chat was still placing when the work ended', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    chatFetch = async (input, init) => {
      if (init?.method === 'POST') await held;
      return api.fetch(input, init);
    };
    await start();
    await pulse();
    await wait(3_000);
    const ending = end();
    await settle();
    expect(requests('DELETE')).toEqual([]);

    release();
    await ending;
    await settle();

    expect(requests('POST')).toEqual([`${JUNO_1}/reactions`]);
    expect(requests('DELETE')).toHaveLength(1);
    expect(eyesOn(JUNO_1)).toEqual([]);
  });

  it('a 👀 Chat refuses to place is not tried again, and its end has nothing to remove', async () => {
    api.failures.set(`${JUNO_1}/reactions`, { status: 403, message: 'The caller does not have permission' });
    await start();
    await pulse();
    await wait(3_000);
    await pulse();
    await wait(8_000);
    await end();

    expect(requests('POST')).toEqual([`${JUNO_1}/reactions`]);
    expect(requests('DELETE')).toEqual([]);
  });

  it('a 👀 left by a crash is removed when the host starts again, and its record cleared', async () => {
    await start();
    await pulse();
    await wait(3_000);
    const [placed] = eyesOn(JUNO_1);

    await crashAndRestart();
    await settle();
    expect(requests('DELETE')).toEqual([placed!.name]);
    expect(eyesOn(JUNO_1)).toEqual([]);

    await crashAndRestart();
    await settle();
    expect(requests('DELETE')).toHaveLength(1);
  });

  it('a 👀 someone already removed counts as gone', async () => {
    await start();
    await pulse();
    await wait(3_000);
    api.reactions.set(JUNO_1, []);

    await end();
    expect(requests('DELETE')).toHaveLength(1);

    await crashAndRestart();
    await settle();
    expect(requests('DELETE')).toHaveLength(1);
  });

  it('a 👀 Chat fails to remove is removed when the host next starts', async () => {
    await start();
    await pulse();
    await wait(3_000);
    const [placed] = eyesOn(JUNO_1);
    api.failures.set(placed!.name, { status: 503, message: 'Unavailable' });

    await end();
    expect(eyesOn(JUNO_1)).toEqual([placed]);

    api.failures.clear();
    await crashAndRestart();
    await settle();
    expect(requests('DELETE')).toEqual([placed!.name, placed!.name]);
    expect(eyesOn(JUNO_1)).toEqual([]);
  });

  describe('through the host: typing, delivery, and the adapter registry', () => {
    /** The channel the host's registry started; the registry tears it down. */
    let hosted: ChannelAdapter | undefined;

    afterEach(async () => {
      await teardownChannelAdapters();
      if (channel === hosted) channel = undefined;
    });

    it('a full turn: 👀 after 3 seconds, removed by the reply, and nothing left recorded', async () => {
      registerChannelAdapter('gchat', { factory: () => (hosted = build()) });
      await initChannelAdapters(() => hostSetup());
      setDeliveryAdapter(createChannelDeliveryAdapter());
      // The principal's message, read and routed; the turn it engages starts typing as the router does.
      await deliver!(messageEvent(JUNO_1));
      startTypingRefresh('sess-reply', 'ag-main', 'gchat', PLATFORM, null, 'gchat', routed[0]!.message.id);
      await settle();
      await wait(3_000);
      const [placed] = eyesOn(JUNO_1);
      expect(placed?.user).toBe(ASSISTANT);

      await getDeliveryAdapter()!.deliver(
        'gchat',
        PLATFORM,
        null,
        'chat',
        JSON.stringify({ text: 'Moved to Friday.' }),
        undefined,
        'gchat',
      );
      await settle();
      expect(requests('DELETE')).toEqual([placed!.name]);
      expect(eyesOn(JUNO_1)).toEqual([]);

      // The container exits: the end already fired.
      stopTypingRefresh('sess-reply');
      await settle();
      expect(requests('DELETE')).toHaveLength(1);

      await teardownChannelAdapters();
      await start();
      await settle();
      expect(requests('DELETE')).toHaveLength(1);
    });
  });
});

describe('requests', () => {
  /** The host's approval request in the DM; resolves to the name Google gave the post. */
  function askToInstall(questionId: string): Promise<string | undefined> {
    return channel!.deliver(`gchat:${DM}`, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId,
        title: 'Install a package?',
        question: 'I would like jq to read the export.',
        options: [
          { label: 'Approve', value: 'approve' },
          { label: 'Reject', value: 'reject' },
        ],
      },
    });
  }

  it("posts a request as the assistant's text, and remembers it with the time Google recorded it", async () => {
    await start();

    const name = await askToInstall('appr-1');

    expect(name).toBe(`${DM}/messages/morgan.1`);
    expect(api.messages.get(name!)?.text).toBe(
      '*Install a package?*\n\nI would like jq to read the export.\n\n' +
        'Quote this message with yes or no, or react 👍 or 👎.',
    );
    const state = new SqliteStateAdapter();
    await state.connect();
    expect(await readPostedRequest(state, 'gchat', name!)).toEqual({
      questionId: 'appr-1',
      platformId: `gchat:${DM}`,
      postedAt: '2026-10-10T17:00:05.000Z',
    });
  });

  it("posts a host's request with Chat's markup shown as text, and an agent's own question as written", async () => {
    await start();
    const ask = (questionId: string, question: string, fromAgent?: true) =>
      channel!.deliver(`gchat:${DM}`, null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId,
          title: 'Add a sender?',
          question,
          options: [{ label: 'Approve', value: 'approve' }],
          ...(fromAgent ? { fromAgent } : {}),
        },
      });

    const hosts = await ask('appr-markup', 'From "&lt;users/all&gt;" <https://evil.example|Approve>');
    const agents = await ask('q-agent', 'Which of <users/2001> or <users/2002>?', true);

    expect(api.messages.get(hosts!)?.text).not.toMatch(/<users\/|<https?:/u);
    expect(api.messages.get(agents!)?.text).toContain('<users/2001>');
  });

  it("shows a request's option labels and its outcome with Chat's markup as text too", async () => {
    await start();
    const name = await channel!.deliver(`gchat:${DM}`, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-options',
        title: 'Connect a space?',
        question: 'Juno Hale mentioned me in a space.',
        options: [
          { label: 'Connect to <users/all>', value: 'connect:ag-1' },
          { label: 'Ignore', value: 'ignore' },
        ],
      },
    });
    expect(api.messages.get(name!)?.text).not.toMatch(/<users\//u);

    await channel!.deliver(`gchat:${DM}`, null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        questionId: 'appr-options',
        messageId: name,
        terminalCard: {
          title: 'Connect a space?',
          question: 'Juno Hale mentioned me in a space.',
          resolution: '✅ Connected to <https://evil.example|Andy>',
        },
      },
    });
    expect(api.messages.get(name!)?.text).toContain('Connected to');
    expect(api.messages.get(name!)?.text).not.toMatch(/<https?:/u);
  });

  it("shows an answered request's outcome by editing its text alone, as a user may", async () => {
    await start();
    const name = await askToInstall('appr-2');

    await channel!.deliver(`gchat:${DM}`, null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        questionId: 'appr-2',
        messageId: name,
        text: 'Install a package?\n\nI would like jq to read the export.\n\nApproved',
      },
    });

    expect(api.messages.get(name!)?.text).toContain('Approved');
    const edits = api.requests.filter((request) => request.method === 'PUT' || request.method === 'PATCH');
    expect(edits.map((request) => request.url.searchParams.get('updateMask'))).toEqual(['text']);
  });

  it("never edits a message outside the conversation's own space", async () => {
    await start();
    const name = await askToInstall('appr-3');
    const elsewhere = name!.replace(DM, 'spaces/OTHER');

    await expect(
      channel!.deliver(`gchat:${DM}`, null, {
        kind: 'chat-sdk',
        content: { operation: 'edit', messageId: elsewhere, text: 'Approved' },
      }),
    ).rejects.toThrow('does not belong to space');
    const edits = api.requests.filter((request) => request.method === 'PUT' || request.method === 'PATCH');
    expect(edits).toEqual([]);
  });
});

describe('a picture on an approval request', () => {
  // A host module's approval request, from requestApproval through the
  // host's delivery and the channel to Google, with a checkout's picture
  // beside it: Chat sees one upload and one message per card.
  const PRINCIPAL = 'gchat:users/2001';
  const QUESTION = 'Checkout at shop.example: 41.20 USD due now, paid with the saved card ending 4242.';
  const ORIGIN = 'From your browser errand thread-7.';
  const HOW_TO_ANSWER =
    'Quote this message with yes or no, or react 👍 or 👎. To say why, quote it with no and your reason.';
  const NO_PICTURE = "I couldn't attach the picture that goes with this.";
  /** A checkout's picture: PNG bytes, distinct enough to find wherever they might be written. */
  const PICTURE = {
    filename: 'checkout.png',
    mimeType: 'image/png' as const,
    data: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f]),
      Buffer.from('total 41.20 USD beside the Place order button'),
    ]),
  };
  const UPLOAD_PATH = `${DM}/attachments:upload`;
  const CHAT_IS_DOWN = { status: 500, message: 'Internal error encountered.' };

  let session: Session;
  /** The channel the host's registry started; the registry tears it down. */
  let hosted: ChannelAdapter | undefined;

  beforeEach(async () => {
    const now = new Date().toISOString();
    await createAgentGroup({
      id: 'ag-browser',
      name: 'browser',
      folder: 'browser',
      agent_provider: null,
      created_at: now,
    });
    session = {
      id: 'sess-browser',
      agent_group_id: 'ag-browser',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now,
      created_at: now,
    };
    await createSession(session);
    await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Juno Hale', created_at: now });
    await createMessagingGroup({
      id: 'mg-juno',
      channel_type: 'gchat',
      platform_id: `gchat:${DM}`,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    await upsertUserDm({ user_id: PRINCIPAL, channel_type: 'gchat', messaging_group_id: 'mg-juno', resolved_at: now });
    registerChannelAdapter('gchat', { factory: () => (hosted = build()) });
    await initChannelAdapters(() => hostSetup());
    setDeliveryAdapter(createChannelDeliveryAdapter());
  });

  afterEach(async () => {
    await teardownChannelAdapters();
    if (channel === hosted) channel = undefined;
  });

  /** The browser's purchase card for the principal, with the checkout's picture. */
  function askToBuy(): Promise<string | null> {
    return requestApproval({
      session,
      agentName: 'browser',
      action: 'browser_purchase',
      payload: { cardId: 'card-1', jobId: 'job-1' },
      title: 'Approve this purchase?',
      question: QUESTION,
      approverUserId: PRINCIPAL,
      originLine: ORIGIN,
      pictures: [PICTURE],
    });
  }

  /** The card's text as Chat holds it, with any line it adds before how to answer it. */
  function cardText(...lines: string[]): string {
    return ['*Approve this purchase?*', QUESTION, ORIGIN, ...lines, HOW_TO_ANSWER].join('\n\n');
  }

  /** Whether `value` holds the picture's bytes, raw or in any text form, anywhere inside it. */
  function holdsPicture(value: unknown, seen = new Set<unknown>()): boolean {
    if (typeof value === 'string') {
      const forms = ['base64', 'base64url', 'hex', 'latin1'] as const;
      return forms.some((form) => value.includes(PICTURE.data.toString(form)));
    }
    if (value instanceof Uint8Array) return Buffer.from(value).includes(PICTURE.data);
    if (typeof value !== 'object' || value === null || seen.has(value)) return false;
    seen.add(value);
    if (value instanceof Error) {
      return [value.message, value.stack, value.cause].some((part) => holdsPicture(part, seen));
    }
    return Object.values(value).some((part) => holdsPicture(part, seen));
  }

  /** The tables in the central database holding the picture's bytes in any row. */
  async function tablesHoldingPicture(): Promise<string[]> {
    const tables = await getDb().all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    const holding: string[] = [];
    for (const { name } of tables) {
      const rows = await getDb().all<Record<string, unknown>>(`SELECT * FROM "${name}"`);
      if (rows.some((row) => holdsPicture(row))) holding.push(name);
    }
    return holding;
  }

  it('posts the card and its picture as one message, and a 👍 on it answers the request', async () => {
    const id = await askToBuy();

    expect(id).not.toBeNull();
    expect(api.uploads).toEqual([
      expect.objectContaining({ space: DM, filename: 'checkout.png', contentType: 'image/png', data: PICTURE.data }),
    ]);
    const [card, ...more] = api.posted();
    expect(more).toEqual([]);
    expect(card!.text).toBe(cardText());
    expect(card!.attachment).toEqual([
      expect.objectContaining({ contentName: 'checkout.png', contentType: 'image/png', source: 'UPLOADED_CONTENT' }),
    ]);
    expect((await getPendingApproval(id!))?.platform_message_id).toBe(card!.name);

    reacted(`${card!.name}/reactions/r1`);
    await deliver!(reactionEvent(`${card!.name}/reactions/r1`));

    expect(answered).toEqual([
      [
        id,
        'approve',
        'users/2001',
        { instance: 'gchat', messageId: card!.name, platformId: `gchat:${DM}` },
        { deferResolution: true },
      ],
    ]);
  });

  it("shows the card's outcome on its own message, which keeps its picture", async () => {
    const id = await askToBuy();
    const [card] = api.posted();

    await getDeliveryAdapter()!.deliver(
      'gchat',
      `gchat:${DM}`,
      null,
      'chat-sdk',
      JSON.stringify({
        questionId: id,
        operation: 'edit',
        messageId: card!.name,
        terminalCard: { title: 'Approve this purchase?', question: QUESTION, resolution: '✅ Approved' },
      }),
      undefined,
      'gchat',
    );

    expect(api.messages.get(card!.name)?.text).toBe(`*Approve this purchase?*\n\n${QUESTION}\n\n✅ Approved`);
    expect(api.messages.get(card!.name)?.attachment).toEqual(card!.attachment);
  });

  it('still posts the card when Chat refuses its picture, saying the picture is unavailable', async () => {
    api.failures.set(UPLOAD_PATH, CHAT_IS_DOWN);

    const id = await askToBuy();

    expect(id).not.toBeNull();
    expect(api.uploads).toEqual([]);
    const [card, ...more] = api.posted();
    expect(more).toEqual([]);
    expect(card!.text).toBe(cardText(NO_PICTURE));
    expect(card!.attachment).toBeUndefined();
    expect((await getPendingApproval(id!))?.platform_message_id).toBe(card!.name);
  });

  it('keeps the picture out of the approval row, the database and the logs', async () => {
    const logged: unknown[] = [];
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(log, level).mockImplementation((...line) => {
        logged.push(line);
      });
    }

    const attached = await askToBuy();
    api.failures.set(UPLOAD_PATH, CHAT_IS_DOWN);
    const refused = await askToBuy();

    expect(api.uploads).toHaveLength(1);
    expect(api.posted().map((card) => card.attachment?.length ?? 0)).toEqual([1, 0]);
    expect(holdsPicture(await getPendingApproval(attached!))).toBe(false);
    expect(holdsPicture(await getPendingApproval(refused!))).toBe(false);
    expect(await tablesHoldingPicture()).toEqual([]);
    expect(logged.length).toBeGreaterThan(0);
    expect(holdsPicture(logged)).toBe(false);
  });
});

describe('the reply context', () => {
  function quoting(quotedMessageMetadata?: Record<string, unknown>): Record<string, unknown> {
    return { message: { name: `${DM}/messages/remy.2`, text: 'yes', quotedMessageMetadata } };
  }

  it('gives nothing for a message that quotes nothing', () => {
    expect(extractGchatReplyContext(quoting())).toBeNull();
    expect(extractGchatReplyContext({})).toBeNull();
  });

  it('names the message replied to even when Google keeps no text of it, and an unnamed sender as unknown', () => {
    expect(extractGchatReplyContext(quoting({ name: `${DM}/messages/morgan.1`, quoteType: 'REPLY' }))).toEqual({
      id: `${DM}/messages/morgan.1`,
      sender: 'unknown',
      text: '',
    });
  });

  it('gives a forward its text and sender, but no message replied to', () => {
    expect(
      extractGchatReplyContext(
        quoting({
          name: `${ROOM}/messages/remy.9`,
          quoteType: 'FORWARD',
          quotedMessageSnapshot: { sender: 'Remy Vance', text: 'Offsite moved to May.' },
        }),
      ),
    ).toEqual({ sender: 'Remy Vance', text: 'Offsite moved to May.', forwarded: true });
    expect(extractGchatReplyContext(quoting({ name: `${ROOM}/messages/remy.9`, quoteType: 'FORWARD' }))).toEqual({
      sender: 'unknown',
      text: '',
      forwarded: true,
    });
  });
});

describe('transport', () => {
  it('pulls while the channel runs: delivery starts when it initializes and stops when it is torn down', async () => {
    await start();
    expect(deliver).toBeDefined();

    await channel!.teardown();
    channel = undefined;
    expect(deliveriesStopped).toBe(1);
  });

  it("signs the SDK's Chat calls with the host's token, taken again before the host's guarantee of it runs out", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await start();
      await channel!.deliver(`gchat:${DM}`, null, { kind: 'chat', content: { text: 'Moved to Friday.' } });
      const taken = hostTokensTaken;
      expect(taken).toBeGreaterThan(0);

      // The host hands out a token only while it has this long left to live.
      vi.setSystemTime(Date.now() + RENEW_BEFORE_EXPIRY_MS);
      await channel!.deliver(`gchat:${DM}`, null, { kind: 'chat', content: { text: 'The room is booked too.' } });

      expect(hostTokensTaken).toBeGreaterThan(taken);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers no webhook route, and refuses every webhook request', async () => {
    await start();

    expect(registerWebhookAdapter).not.toHaveBeenCalled();
    const chatEvent = new Request('https://assistant.example.test/webhook/gchat', {
      method: 'POST',
      body: JSON.stringify({
        chat: { messagePayload: { message: { name: `${DM}/messages/x` }, space: { name: DM } } },
      }),
    });
    expect((await adapter.handleWebhook(chatEvent)).status).toBe(404);
    expect(routed).toEqual([]);
  });
});
