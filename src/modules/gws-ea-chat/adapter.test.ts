/**
 * The assistant's Chat adapter, driven as the pull consumer drives it: each
 * test hands it Workspace events and reads what reaches the host through the
 * real Chat SDK bridge and core, over the SQLite state store. Google's HTTP is
 * faked at the `fetch` boundary, for both the channel's own reads and writes
 * and the SDK's Chat client. The working 👀 is driven as the host's typing
 * module drives it, through the bridge's typing pulse and its end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup, InboundMessage } from '../../channels/adapter.js';
import { readPostedRequest } from '../../channels/chat-sdk-bridge.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDeliveryAdapter, setDeliveryAdapter } from '../../delivery.js';
import { SqliteStateAdapter } from '../../state-sqlite.js';
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

const { registerWebhookAdapter } = vi.hoisted(() => ({ registerWebhookAdapter: vi.fn() }));
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
/** Routing fails this many next times, as the host's does when the router throws. */
let routingFailures: number;
/** The consumer's handler, as the adapter hands it over when it starts its delivery. */
let deliver: ((event: WorkspaceEvent) => Promise<void>) | undefined;
let deliveriesStopped: number;
/** How the channel's own Chat calls reach Google. */
let chatFetch: typeof globalThis.fetch;

beforeEach(async () => {
  await runMigrations(await initTestDb());
  api = new FakeChatApi();
  chatFetch = api.fetch;
  api.addSpace(DM, 'DIRECT_MESSAGE');
  api.addSpace(ROOM, 'SPACE');
  api.people.set('2001', 'Juno Hale');
  routed = [];
  routingFailures = 0;
  deliver = undefined;
  deliveriesStopped = 0;
  registerWebhookAdapter.mockClear();
});

afterEach(async () => {
  await channel?.teardown();
  channel = undefined;
  await closeDb();
});

/** The channel as the host builds it, not yet set up. */
function build(startDelivery?: ConstructorParameters<typeof AssistantChatAdapter>[0]['startDelivery']): ChannelAdapter {
  adapter = new AssistantChatAdapter({
    botUserId: ASSISTANT,
    userName: 'morgan',
    auth: hostChatAuth(async () => CHAT_TOKEN, api.fetch),
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
      if (routingFailures > 0) {
        routingFailures -= 1;
        throw new Error('database is locked');
      }
      routed.push({ platformId, threadId, message });
    },
    onInboundEvent: () => undefined,
    onMetadata: () => undefined,
    onAction: () => undefined,
  };
}

async function start(startDelivery?: ConstructorParameters<typeof AssistantChatAdapter>[0]['startDelivery']) {
  await build(startDelivery).setup(hostSetup());
}

function messageEvent(name: string): WorkspaceEvent {
  return {
    messageId: `pubsub-${name}`,
    type: CHAT_MESSAGE_CREATED,
    source: '//chat.googleapis.com/spaces/-',
    subject: `//chat.googleapis.com/${name.split('/messages/')[0]}`,
    time: '2026-10-10T17:00:00Z',
    data: { message: { name } },
  };
}

function reactionEvent(name: string): WorkspaceEvent {
  return { ...messageEvent(name.split('/reactions/')[0]!), type: CHAT_REACTION_CREATED, data: { reaction: { name } } };
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

  it("counts a mention of the assistant's account in a space, and reads it as its handle", async () => {
    await start();
    api.addMessage(
      chatMessage(ROOM, 'remy.1', {
        text: '@Morgan Ellery and @Remy Vance, lunch?',
        annotations: [mentionOf(ASSISTANT, 0, 14), mentionOf('users/2003', 19, 11)],
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
    expect(content().text).toBe('@morgan and @Remy Vance, lunch?');
  });

  it('routes a space message that mentions someone else, or no one, as group chatter', async () => {
    await start();
    api.addMessage(
      chatMessage(ROOM, 'remy.1', { text: '@Remy Vance lunch?', annotations: [mentionOf('users/2003', 0, 11)] }),
    );
    api.addMessage(chatMessage(ROOM, 'remy.2', { text: 'Running late.' }));

    await deliver!(messageEvent(`${ROOM}/messages/remy.1`));
    await deliver!(messageEvent(`${ROOM}/messages/remy.2`));

    expect(routed.map((entry) => [entry.message.isMention, entry.message.isGroup])).toEqual([
      [false, true],
      [false, true],
    ]);
  });

  it('dispatches each message of a batch, in the order they were written', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'remy.1', { text: 'first', createTime: '2026-10-10T17:00:01Z' }));
    api.addMessage(chatMessage(DM, 'remy.2', { text: 'second', createTime: '2026-10-10T17:00:02Z' }));
    api.addMessage(chatMessage(DM, 'remy.3', { text: 'third', createTime: '2026-10-10T17:00:03Z' }));

    await deliver!({
      ...messageEvent(`${DM}/messages/remy.3`),
      type: CHAT_MESSAGE_BATCH_CREATED,
      data: { messages: ['remy.3', 'remy.1', 'remy.2'].map((id) => ({ message: { name: `${DM}/messages/${id}` } })) },
    });

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

  it('names a sender with no visible profile by their user id, never "User 123"', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'remy.1', { from: 'users/2002' }));

    await deliver!(messageEvent(`${DM}/messages/remy.1`));

    expect(content()).toMatchObject({ sender: 'users/2002', senderName: 'users/2002' });
  });

  it('gives the agent the quoted text, its sender, and the name of the message replied to', async () => {
    await start();
    api.addMessage(
      chatMessage(DM, 'remy.2', {
        text: 'yes',
        quotedMessageMetadata: {
          name: `${DM}/messages/morgan.1`,
          quoteType: 'REPLY',
          quotedMessageSnapshot: { sender: 'Morgan Ellery', text: 'Shall I move Thursday to Friday?' },
        },
      }),
    );

    await deliver!(messageEvent(`${DM}/messages/remy.2`));

    expect(content().replyTo).toEqual({
      id: `${DM}/messages/morgan.1`,
      sender: 'Morgan Ellery',
      text: 'Shall I move Thursday to Friday?',
    });
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
    expect(api.calls('media/ref-agenda')).toEqual([expect.objectContaining({ authorization: `Bearer ${CHAT_TOKEN}` })]);
  });
});

describe('when an event cannot be handled', () => {
  it('acknowledges a message that is gone without routing it', async () => {
    await start();

    await expect(deliver!(messageEvent(`${DM}/messages/remy.9`))).resolves.toBeUndefined();
    expect(routed).toEqual([]);
  });

  it('refuses a message Google fails to return, so Pub/Sub delivers it again', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'remy.1'));
    api.failures.set(`${DM}/messages/remy.1`, { status: 500, message: 'Internal error' });

    await expect(deliver!(messageEvent(`${DM}/messages/remy.1`))).rejects.toThrow(/Internal error/u);
    expect(routed).toEqual([]);

    api.failures.clear();
    await deliver!(messageEvent(`${DM}/messages/remy.1`));
    expect(routed).toHaveLength(1);
  });

  it('routes a message again after its routing failed: the SDK forgets it was seen', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'remy.1'));
    routingFailures = 1;

    await expect(deliver!(messageEvent(`${DM}/messages/remy.1`))).rejects.toThrow(/database is locked/u);
    expect(routed).toEqual([]);

    await deliver!(messageEvent(`${DM}/messages/remy.1`));
    expect(routed).toHaveLength(1);
  });

  it('drops a copy of a message already routed, and acknowledges it', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'remy.1'));

    await deliver!(messageEvent(`${DM}/messages/remy.1`));
    await expect(deliver!(messageEvent(`${DM}/messages/remy.1`))).resolves.toBeUndefined();

    expect(routed).toHaveLength(1);
  });

  it('dispatches none of a batch while one of its messages cannot be read, so their order holds', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'remy.1', { createTime: '2026-10-10T17:00:01Z' }));
    api.addMessage(chatMessage(DM, 'remy.2', { createTime: '2026-10-10T17:00:02Z' }));
    api.failures.set(`${DM}/messages/remy.1`, { status: 503, message: 'Unavailable' });
    const batch: WorkspaceEvent = {
      ...messageEvent(`${DM}/messages/remy.2`),
      type: CHAT_MESSAGE_BATCH_CREATED,
      data: { messages: ['remy.1', 'remy.2'].map((id) => ({ message: { name: `${DM}/messages/${id}` } })) },
    };

    await expect(deliver!(batch)).rejects.toThrow(/Unavailable/u);
    expect(routed).toEqual([]);

    api.failures.clear();
    await deliver!(batch);
    expect(routed.map((entry) => entry.message.id)).toEqual([`${DM}/messages/remy.1`, `${DM}/messages/remy.2`]);
  });

  it('brings a refused event back through Pub/Sub and routes it once, acknowledged once', async () => {
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
    api.failures.set(`${DM}/messages/remy.1`, { status: 500, message: 'Internal error' });

    const id = events.publish({ type: CHAT_MESSAGE_CREATED, data: { message: { name: `${DM}/messages/remy.1` } } });
    await vi.waitFor(() => expect(api.calls(`${DM}/messages/remy.1`)).toHaveLength(1));
    expect(events.acks(id)).toBe(0);

    api.failures.clear();
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
    api.addReaction({
      name: `${target}/reactions/r1`,
      user: { name: 'users/2001', type: 'HUMAN' },
      emoji: { unicode: '👍' },
    });

    await deliver!(reactionEvent(`${target}/reactions/r1`));

    expect(events).toEqual([
      expect.objectContaining({
        reactionName: `${target}/reactions/r1`,
        rawEmoji: '👍',
        added: true,
        messageId: target,
        threadId: `gchat:${DM}:dm`,
        user: { userId: 'users/2001', userName: 'Juno Hale', fullName: 'Juno Hale', isBot: false, isMe: false },
        reactedAt: new Date('2026-10-10T17:00:00Z'),
      }),
    ]);
    expect(events[0]!.emoji.name).toBe('thumbs_up');
    expect(events[0]!.message.author).toMatchObject({ userId: ASSISTANT, isMe: true });
    expect(events[0]!.message.text).toBe('Shall I move Thursday to Friday?');
  });

  it("names the author of another person's message the reaction is on", async () => {
    await start();
    const events = received();
    api.addMessage(chatMessage(ROOM, 'remy.1', { from: 'users/2001', text: 'Lunch at 1?' }));
    api.addReaction({
      name: `${ROOM}/messages/remy.1/reactions/r1`,
      user: { name: 'users/2002', type: 'HUMAN' },
      emoji: { unicode: '🎉' },
    });

    await deliver!(reactionEvent(`${ROOM}/messages/remy.1/reactions/r1`));

    expect(events[0]!.threadId).toBe(threadOf(ROOM, 'remy'));
    expect(events[0]!.user.fullName).toBe('users/2002');
    expect(events[0]!.message.author).toMatchObject({ userId: 'users/2001', fullName: 'Juno Hale', isMe: false });
  });

  it("drops the assistant's own reaction without reading the message it is on", async () => {
    await start();
    const events = received();
    api.addMessage(chatMessage(DM, 'remy.1'));
    api.addReaction({
      name: `${DM}/messages/remy.1/reactions/r1`,
      user: { name: ASSISTANT, type: 'HUMAN' },
      emoji: { unicode: '👀' },
    });

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
    api.addReaction({
      name: `${target}/reactions/r1`,
      user: { name: 'users/2001', type: 'HUMAN' },
      emoji: { unicode: '👍' },
    });
    api.addReaction({
      name: `${ROOM}/messages/remy.1/reactions/r2`,
      user: { name: 'users/2001', type: 'HUMAN' },
      emoji: { unicode: '👍' },
    });

    await deliver!(reactionEvent(`${target}/reactions/r1`));
    await deliver!(reactionEvent(`${ROOM}/messages/remy.1/reactions/r2`));

    expect(routed).toEqual([
      {
        platformId: `gchat:${DM}`,
        threadId: `gchat:${DM}:dm`,
        message: expect.objectContaining({
          id: `${target}/reactions/r1`,
          timestamp: '2026-10-10T17:00:00.000Z',
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
      target: { self: true, sender: 'morgan', excerpt: 'Shall I move Thursday to Friday?' },
    });
    expect(content(1).reaction).toEqual({
      emoji: 'thumbs_up',
      target: { self: false, sender: 'Juno Hale', excerpt: 'Lunch at 1?' },
    });
  });

  it('refuses a reaction the host could not route, so it comes again', async () => {
    await start();
    api.addMessage(chatMessage(DM, 'morgan.1', { from: ASSISTANT }));
    api.addReaction({
      name: `${target}/reactions/r1`,
      user: { name: 'users/2001', type: 'HUMAN' },
      emoji: { unicode: '👍' },
    });
    routingFailures = 1;

    await expect(deliver!(reactionEvent(`${target}/reactions/r1`))).rejects.toThrow(/database is locked/u);
    await deliver!(reactionEvent(`${target}/reactions/r1`));
    expect(routed).toHaveLength(1);
  });

  it('refuses a reaction whose handler fails, so it comes again', async () => {
    await start();
    adapter.setReactionHandler(async () => {
      throw new Error('database is locked');
    });
    api.addMessage(chatMessage(DM, 'morgan.1', { from: ASSISTANT }));
    api.addReaction({
      name: `${target}/reactions/r1`,
      user: { name: 'users/2001', type: 'HUMAN' },
      emoji: { unicode: '👍' },
    });

    await expect(deliver!(reactionEvent(`${target}/reactions/r1`))).rejects.toThrow(/database is locked/u);
  });
});

describe('the working 👀 (R6)', () => {
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
    expect(api.calls(`${JUNO_1}/reactions`)[0]!.authorization).toBe(`Bearer ${CHAT_TOKEN}`);
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

  it("removes exactly its own 👀 by the name Chat gave it, and leaves the principal's own 👀 in place", async () => {
    api.addReaction({
      name: `${JUNO_1}/reactions/juno-eyes`,
      user: { name: 'users/2001', type: 'HUMAN' },
      emoji: { unicode: '👀' },
    });
    await start();
    await pulse();
    await wait(3_000);
    const [placed] = eyesOn(JUNO_1).filter((reaction) => reaction.user === ASSISTANT);

    await end();

    expect(requests('DELETE')).toEqual([placed!.name]);
    expect(eyesOn(JUNO_1)).toEqual([{ name: `${JUNO_1}/reactions/juno-eyes`, user: 'users/2001' }]);
  });

  it('never shows 👀 again for a message whose work ended', async () => {
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

    /** The principal's message, read and routed; the turn it engages starts typing as the router does. */
    async function engage(session: string): Promise<string> {
      registerChannelAdapter('gchat', { factory: () => (hosted = build()) });
      await initChannelAdapters(() => hostSetup());
      setDeliveryAdapter(createChannelDeliveryAdapter());
      await deliver!(messageEvent(JUNO_1));
      const anchor = routed[0]!.message.id;
      startTypingRefresh(session, 'ag-main', 'gchat', PLATFORM, null, 'gchat', anchor);
      await settle();
      return anchor;
    }

    it('a full turn: 👀 after 3 seconds, removed by the reply, and nothing left recorded', async () => {
      const anchor = await engage('sess-reply');
      expect(anchor).toBe(JUNO_1);
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

    it('a reply within 3 seconds never shows 👀', async () => {
      await engage('sess-quick');
      await wait(1_500);
      await getDeliveryAdapter()!.deliver(
        'gchat',
        PLATFORM,
        null,
        'chat',
        JSON.stringify({ text: 'Done.' }),
        undefined,
        'gchat',
      );
      await wait(10_000);
      stopTypingRefresh('sess-quick');

      expect(requests('POST')).toEqual([]);
    });

    it('a turn that sends nothing removes its 👀 when it goes idle', async () => {
      await engage('sess-idle');
      await wait(3_000);
      expect(eyesOn(JUNO_1)).toHaveLength(1);

      // Past the typing module's grace window with no heartbeat: the agent is idle.
      await wait(20_000);
      expect(eyesOn(JUNO_1)).toEqual([]);
    });

    it("an approval request the host posts into the DM removes 👀; the container's exit removes another turn's", async () => {
      await engage('sess-approval');
      await wait(3_000);
      await getDeliveryAdapter()!.deliver(
        'gchat',
        PLATFORM,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: 'appr-1',
          title: 'Install a package?',
          question: 'Morgan wants jq.',
          options: ['Approve', 'Reject'],
        }),
        undefined,
        'gchat',
      );
      await settle();
      expect(eyesOn(JUNO_1)).toEqual([]);
      stopTypingRefresh('sess-approval');

      const JUNO_2 = `${DM}/messages/juno.2`;
      api.addMessage(chatMessage(DM, 'juno.2'));
      startTypingRefresh('sess-exit', 'ag-main', 'gchat', PLATFORM, null, 'gchat', JUNO_2);
      await wait(3_000);
      expect(eyesOn(JUNO_2)).toHaveLength(1);

      stopTypingRefresh('sess-exit');
      await settle();
      expect(eyesOn(JUNO_2)).toEqual([]);
    });
  });
});

describe('requests', () => {
  it("posts a request as the assistant's text, and remembers it with the time Google recorded it", async () => {
    await start();

    const name = await channel!.deliver(`gchat:${DM}`, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-1',
        title: 'Install a package?',
        question: 'I would like jq to read the export.',
        options: [
          { label: 'Approve', value: 'approve' },
          { label: 'Reject', value: 'reject' },
        ],
      },
    });

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

  it("shows an answered request's outcome by editing its text alone, as a user may", async () => {
    await start();
    const name = await channel!.deliver(`gchat:${DM}`, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-2',
        title: 'Install a package?',
        question: 'I would like jq to read the export.',
        options: [
          { label: 'Approve', value: 'approve' },
          { label: 'Reject', value: 'reject' },
        ],
      },
    });

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
    ).toEqual({ sender: 'Remy Vance', text: 'Offsite moved to May.' });
    expect(extractGchatReplyContext(quoting({ name: `${ROOM}/messages/remy.9`, quoteType: 'FORWARD' }))).toBeNull();
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

  it('registers no webhook route, and refuses every webhook request', async () => {
    await start();

    expect(registerWebhookAdapter).not.toHaveBeenCalled();
    const pubsubPush = new Request('https://assistant.example.test/webhook/gchat', {
      method: 'POST',
      body: JSON.stringify({ message: { data: 'e30=', messageId: '1', publishTime: '' }, subscription: 'x' }),
    });
    const chatEvent = new Request('https://assistant.example.test/webhook/gchat', {
      method: 'POST',
      body: JSON.stringify({
        chat: { messagePayload: { message: { name: `${DM}/messages/x` }, space: { name: DM } } },
      }),
    });
    expect((await adapter.handleWebhook(pubsubPush)).status).toBe(404);
    expect((await adapter.handleWebhook(chatEvent)).status).toBe(404);
    expect(routed).toEqual([]);
  });
});
