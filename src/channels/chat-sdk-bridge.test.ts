import http from 'http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getEmoji, Message, parseMarkdown, type Adapter, type AdapterPostableMessage, type RawMessage } from 'chat';

import type { ChannelSetup, InboundMessage, OutboundFile } from './adapter.js';
import {
  createChatSdkBridge,
  FilesNotAttachedError,
  readPostedRequest,
  splitForLimit,
  type FileAttacher,
  type InboundReaction,
  type ReactionSource,
  type WorkingIndicator,
} from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });

  it('reports an adapter transport probe when one is available', () => {
    let connected = false;
    const adapter = stubAdapter({}) as Adapter & { isConnected(): boolean };
    adapter.isConnected = () => connected;
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });

    expect(bridge.isConnected()).toBe(false);
    connected = true;
    expect(bridge.isConnected()).toBe(true);
  });

  it('keeps adapters without a transport probe available after setup', () => {
    const bridge = createChatSdkBridge({ adapter: stubAdapter({}), supportsThreads: true });
    expect(bridge.isConnected()).toBe(true);
  });

  it("gives an adapter without a working mark no endTyping, and its typing pulse stays the SDK's alone", async () => {
    const typing: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        startTyping: async (threadId: string) => {
          typing.push(threadId);
        },
      }),
      supportsThreads: true,
    });

    await bridge.setTyping!('stub:c1', 'thread-1', undefined, undefined, 'message-1');

    expect(bridge.endTyping).toBeUndefined();
    expect(typing).toEqual(['thread-1']);
  });

  it('hands an adapter with a working mark each pulse that names a message, and each end, by thread', async () => {
    const calls: string[] = [];
    const adapter = stubAdapter({
      startTyping: async (threadId: string) => {
        calls.push(`typing ${threadId}`);
      },
    }) as Adapter & WorkingIndicator;
    Object.assign(adapter, {
      workingOn: async (threadId: string, messageId: string) => void calls.push(`working ${threadId} ${messageId}`),
      endWorking: async (threadId: string, messageId: string) => void calls.push(`ended ${threadId} ${messageId}`),
    });
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });

    await bridge.setTyping!('stub:c1', null, undefined, undefined, 'message-1');
    await bridge.setTyping!('stub:c1', null);
    await bridge.endTyping!('stub:c1', null, 'message-1');

    expect(calls).toEqual(['typing stub:c1', 'working stub:c1 message-1', 'typing stub:c1', 'ended stub:c1 message-1']);
  });
});

describe('createChatSdkBridge — instance identity', () => {
  it('default: name === channelType === adapter.name, instance undefined', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBeUndefined();
  });

  it('named instance: name follows the instance, channelType stays the platform', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack-tester');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBe('slack-tester');
  });

  it('rejects instance names that would break the webhook route or state delimiter', () => {
    for (const bad of ['a/b', 'a:b', 'a?b', 'a b']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });

  it('rejects empty and whitespace-only instance names (config bug — fail loud)', () => {
    // '' is falsy: a truthiness guard would skip it, dead-ending the
    // webhook route ('/webhook/' + '') and collapsing the state namespace
    // into the default instance's unprefixed keyspace — the exact
    // cross-bot dedupe/lock collisions the namespace exists to prevent.
    for (const bad of ['', ' ', '   ', '\t']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });
});

describe('createChatSdkBridge.setup — webhook route and state namespace', () => {
  // Real setup() over a stub adapter: Chat.initialize() needs a working
  // StateAdapter (chat_sdk_* tables) and an adapter.initialize — nothing
  // platform-side. registerWebhookAdapter is mocked at module level so we
  // can assert the (chat, adapterName, routingPath) triple.
  // runtimeMode is assigned inside initialize(), as the Telegram adapter does
  // when mode 'auto' resolves: a guard that reads it earlier sees undefined.
  function setupStubAdapter(runtimeMode?: 'webhook' | 'polling'): Adapter {
    const adapter = stubAdapter({ name: 'slack' }) as Adapter & { runtimeMode?: string };
    adapter.initialize = async () => {
      adapter.runtimeMode = runtimeMode;
    };
    return adapter;
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    vi.mocked(registerWebhookAdapter).mockClear();
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  const hostConfig = {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };

  it('named instance registers the webhook with adapterName as handler key and instance as route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath).toBe('slack-tester');
    await bridge.teardown();
  });

  it('default instance registers the historical route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath ?? adapterName).toBe('slack');
    await bridge.teardown();
  });

  // Polling adapters (Telegram) pull updates themselves; a registered route
  // would lazily bind the shared webhook port, and a busy port then crashes a
  // Telegram-only host. Kill condition: delete the `runtimeMode === 'polling'`
  // branch in setup() and the polling case goes red.
  it('polling adapter (mode resolved inside initialize) registers no webhook route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('polling'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).not.toHaveBeenCalled();
    await bridge.teardown();
  });

  it('webhook adapter registers the route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('webhook'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('adapter without runtimeMode registers the route (non-Telegram adapters declare none)', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('named instance namespaces Chat SDK state; default stays unprefixed (live-install constraint)', async () => {
    const { getDb } = await import('../db/connection.js');

    const named = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await named.setup(hostConfig);
    await named.subscribe!('slack:C1', 'slack:T1');

    const def = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await def.setup(hostConfig);
    await def.subscribe!('slack:C1', 'slack:T1');

    const rows = await getDb().all<{ thread_id: string }>(
      'SELECT thread_id FROM chat_sdk_subscriptions ORDER BY thread_id',
    );
    expect(rows.map((r) => r.thread_id)).toEqual(['slack-tester:slack:T1', 'slack:T1']);

    await named.teardown();
    await def.teardown();
  });

  it('explicitly naming the primary instance after the platform stays on the unprefixed keyspace', async () => {
    const { getDb } = await import('../db/connection.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack', // explicit, but equal to adapter.name ⇒ default keyspace
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    await bridge.subscribe!('slack:C1', 'slack:T9');
    const rows = await getDb().all<{ thread_id: string }>('SELECT thread_id FROM chat_sdk_subscriptions');
    expect(rows.map((r) => r.thread_id)).toEqual(['slack:T9']);
    await bridge.teardown();
  });
});

describe('createChatSdkBridge.deliver — ask_question cards (button styles)', () => {
  // Approval cards color their buttons (Slack: primary→green, danger→red).
  // The bridge must forward the normalized option style into Button() and
  // omit it when unset — an invalid style surviving to Block Kit would fail
  // the whole card with invalid_blocks (effective auto-deny).

  interface CapturedButton {
    type?: string;
    id?: string;
    label?: string;
    value?: string;
    style?: string;
  }

  function buttonsFrom(calls: PostCall[]): CapturedButton[] {
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: CapturedButton[] }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    return actionsRow?.children ?? [];
  }

  it('passes each option style through to the Button, and omits it when unset', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-1',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [
          { label: 'Approve', style: 'primary' },
          { label: 'Deny', style: 'danger' },
          'Skip', // string shorthand — never styled
        ],
      },
    });
    expect(calls).toHaveLength(1);
    const buttons = buttonsFrom(calls);
    expect(buttons.map((b) => b.label)).toEqual(['Approve', 'Deny', 'Skip']);
    expect(buttons.map((b) => b.style)).toEqual(['primary', 'danger', undefined]);
  });

  it('drops invalid styles before they reach the Button (delivery goes through normalizeOptions)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-2',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [{ label: 'Approve', style: 'chartreuse' }],
      },
    });
    const buttons = buttonsFrom(calls);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].style).toBeUndefined();
  });

  it('retains the approval body and replaces buttons with a muted timeout resolution', async () => {
    const edits: PostCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        editMessage: async (threadId, _messageId, message) => {
          edits.push({ threadId, message });
          return { id: 'msg-1', threadId, raw: {} };
        },
      }),
      supportsThreads: false,
    });

    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        text: 'Credentials Request\n\n*Agent:* Andy\n*Action:* Send email\n\n⏱️ Timed out — no response',
        terminalCard: {
          title: 'Credentials Request',
          question: '*Agent:* Andy\n*Action:* Send email',
          resolution: '⏱️ Timed out — no response',
        },
      },
    });

    expect(edits).toHaveLength(1);
    const edited = edits[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string; style?: string }> };
    };
    expect(edited.card.title).toBe('Credentials Request');
    expect(edited.card.children).toEqual([
      { type: 'text', content: '*Agent:* Andy\n*Action:* Send email' },
      { type: 'text', content: '⏱️ Timed out — no response', style: 'muted' },
    ]);
    expect(edited.card.children.some((child) => child.type === 'actions')).toBe(false);
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('survives a null action instead of throwing on a property read', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [null, { label: 'Open', url: 'https://example.com' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('renders an unknown style as the default button style rather than dropping the action', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [
            { label: 'Open', url: 'https://example.com', style: 'chartreuse' },
            { label: 'Also', url: 'https://example.org', style: null },
          ],
        },
      },
    });
    const msg = calls[0].message as {
      card?: {
        children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string; style?: string }> }>;
      };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].style).toBeUndefined();
    expect(buttons[1].style).toBeUndefined();
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

it('uses a registered approval presentation losslessly for initial and terminal cards', async () => {
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  const evidence = 'full evidence\n'.repeat(500);
  registerQuestionRenderResolver((id) =>
    id === 'presentation-fixture'
      ? {
          title: 'Review',
          options: [],
          deferResolution: true,
          renderMessage: () => ({ markdown: evidence }),
          renderTerminal: (resolution) => ({ markdown: `${evidence}\n${resolution}` }),
        }
      : undefined,
  );
  const { calls, postMessage } = makePostCapture();
  const edits: PostCall[] = [];
  const bridge = createChatSdkBridge({
    adapter: stubAdapter({
      postMessage,
      editMessage: async (threadId, _id, message) => {
        edits.push({ threadId, message });
        return { id: 'card', threadId, raw: {} };
      },
    }),
    supportsThreads: false,
  });
  await bridge.deliver('stub:C1', null, {
    kind: 'chat-sdk',
    content: {
      type: 'ask_question',
      questionId: 'presentation-fixture',
      title: 'Review',
      options: [],
      requirePresentation: true,
    },
  });
  expect(calls[0].message).toEqual({ markdown: evidence });
  await bridge.deliver('stub:C1', null, {
    kind: 'chat-sdk',
    content: {
      operation: 'edit',
      questionId: 'presentation-fixture',
      messageId: 'card',
      terminalCard: { resolution: 'Rejected' },
    },
  });
  expect(edits[0].message).toEqual({ markdown: `${evidence}\nRejected` });
});

it('forwards the authenticated instance and message address without editing a deferred approval', async () => {
  const { initTestDb, closeDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
  await runMigrations(await initTestDb());
  registerQuestionRenderResolver((id) =>
    id === 'address-fixture'
      ? {
          title: 'Review',
          options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
          deferResolution: true,
        }
      : undefined,
  );
  const editMessage = vi.fn();
  const adapter = stubAdapter({
    name: 'fixture',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId,
    editMessage,
  });
  const bridge = createChatSdkBridge({ adapter, instance: 'fixture-one', supportsThreads: false });
  const onAction = vi.fn();
  try {
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
    await chat.processAction(
      {
        actionId: 'ncq:address-fixture:0',
        adapter,
        messageId: 'original-card',
        raw: {},
        threadId: 'fixture:room',
        user: { userId: 'selected' } as never,
        value: '0',
      },
      undefined,
    );
    expect(onAction).toHaveBeenCalledWith(
      'address-fixture',
      'approve',
      'selected',
      { instance: 'fixture-one', messageId: 'original-card', platformId: 'fixture:room' },
      { deferResolution: true },
    );
    expect(editMessage).not.toHaveBeenCalled();
  } finally {
    await bridge.teardown();
    await closeDb();
  }
});

describe('createChatSdkBridge — reactions an adapter reads itself', () => {
  // An adapter that reads its platform's reactions (ReactionSource) hands each
  // to the bridge and awaits it, so a reaction is acknowledged only once routed.
  const ASSISTANT_TEXT = "I'd book Tuesday 3pm with Juno, shall I?";

  interface Routed {
    readonly platformId: string;
    readonly threadId: string | null;
    readonly message: InboundMessage;
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  function targetMessage(threadId: string, author: { userId: string; fullName: string; isMe: boolean }, text: string) {
    return new Message({
      id: 'spaces/AAAAjuno/messages/morgan.1',
      threadId,
      text,
      formatted: parseMarkdown(text),
      raw: {},
      author: { ...author, userName: author.fullName, isBot: false },
      metadata: { dateSent: new Date('2026-10-10T16:58:00Z'), edited: false },
      attachments: [],
    });
  }

  function thumbsUp(
    threadId: string,
    on: { userId: string; fullName: string; isMe: boolean },
    text = ASSISTANT_TEXT,
  ): InboundReaction {
    return {
      reactionName: 'spaces/AAAAjuno/messages/morgan.1/reactions/r1',
      emoji: getEmoji('thumbs_up'),
      user: { userId: 'users/1001', userName: 'Juno Hale', fullName: 'Juno Hale', isBot: false, isMe: false },
      message: targetMessage(threadId, on, text),
      threadId,
      reactedAt: new Date('2026-10-10T17:00:00Z'),
    };
  }

  async function startReactionSource(options: { redelivers?: boolean; failRouting?: boolean } = {}) {
    let handler: ((reaction: InboundReaction) => Promise<void>) | undefined;
    let handlerAtInitialize = false;
    const routed: Routed[] = [];
    const source: ReactionSource = {
      setReactionHandler: (next) => {
        handler = next;
      },
    };
    const adapter = Object.assign(
      stubAdapter({
        name: 'fixture',
        initialize: async () => {
          // The adapter starts reading events here, so the bridge must already listen.
          handlerAtInitialize = handler !== undefined;
        },
        channelIdFromThreadId: (threadId: string) => threadId.slice(0, threadId.lastIndexOf(':')),
        isDM: (threadId: string) => threadId.endsWith(':dm'),
      }),
      source,
    );
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, redelivers: options.redelivers });
    await bridge.setup({
      onInbound: async (platformId, threadId, message) => {
        if (options.failRouting) throw new Error('database is locked');
        routed.push({ platformId, threadId, message });
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    });
    return {
      bridge,
      routed,
      handlerAtInitialize: () => handlerAtInitialize,
      react: (reaction: InboundReaction) => handler!(reaction),
    };
  }

  it("listens before the adapter starts, and routes a reaction on the assistant's message to wake it", async () => {
    const source = await startReactionSource({ redelivers: true });
    try {
      expect(source.handlerAtInitialize()).toBe(true);
      await source.react(thumbsUp('fixture:spaces/AAAAjuno:dm', { userId: 'users/9', fullName: 'Morgan', isMe: true }));

      expect(source.routed).toEqual([
        {
          platformId: 'fixture:spaces/AAAAjuno',
          threadId: 'fixture:spaces/AAAAjuno:dm',
          message: {
            id: 'spaces/AAAAjuno/messages/morgan.1/reactions/r1',
            kind: 'chat-sdk',
            timestamp: '2026-10-10T17:00:00.000Z',
            content: {
              sender: 'Juno Hale',
              senderId: 'users/1001',
              senderName: 'Juno Hale',
              reaction: { emoji: 'thumbs_up', target: { self: true, sender: 'Morgan', excerpt: ASSISTANT_TEXT } },
            },
            isMention: false,
            isGroup: false,
            authenticatedSender: { userId: 'users/1001', displayName: 'Juno Hale', kind: 'human' },
            reaction: true,
            deduplicate: true,
          },
        },
      ]);
    } finally {
      await source.bridge.teardown();
    }
  });

  it("marks a reaction on someone else's message quiet, naming whose it is", async () => {
    const source = await startReactionSource();
    try {
      await source.react(
        thumbsUp('fixture:spaces/AAAAroom:thread-1', { userId: 'users/2002', fullName: 'Remy Vance', isMe: false }),
      );

      const [{ message }] = source.routed;
      expect(message).toMatchObject({
        reaction: true,
        quiet: true,
        isGroup: true,
        content: { reaction: { target: { self: false, sender: 'Remy Vance' } } },
      });
      expect(message).not.toHaveProperty('deduplicate');
    } finally {
      await source.bridge.teardown();
    }
  });

  it('carries an excerpt of a long message, cut to 200 characters', async () => {
    const source = await startReactionSource();
    try {
      const long = `${'Agenda: '.repeat(40)}end`;
      await source.react(
        thumbsUp('fixture:spaces/AAAAjuno:dm', { userId: 'users/9', fullName: 'Morgan', isMe: true }, long),
      );

      const content = source.routed[0]!.message.content as { reaction: { target: { excerpt: string } } };
      expect(content.reaction.target.excerpt).toBe(`${'Agenda: '.repeat(24)}Agenda:…`);
    } finally {
      await source.bridge.teardown();
    }
  });

  it('rejects when routing fails, so the adapter hands the reaction over again', async () => {
    const source = await startReactionSource({ failRouting: true });
    try {
      await expect(
        source.react(thumbsUp('fixture:spaces/AAAAjuno:dm', { userId: 'users/9', fullName: 'Morgan', isMe: true })),
      ).rejects.toThrow(/database is locked/u);
    } finally {
      await source.bridge.teardown();
    }
  });
});

describe('createChatSdkBridge — local Gateway webhook', () => {
  // The Gateway listener forwards raw events to a loopback server; only it may
  // post there. It sends the bot token in x-discord-gateway-token.
  const BOT_TOKEN = 'test-bot-token';
  const realFetch = globalThis.fetch;

  const click = JSON.stringify({
    type: 'GATEWAY_INTERACTION_CREATE',
    data: {
      type: 3,
      id: 'interaction-1',
      token: 'interaction-token',
      channel_id: 'chan-1',
      data: { custom_id: 'ncq:q-1:approve' },
      member: { user: { id: 'clicker-1', username: 'clicker' } },
      message: { id: 'card-1', embeds: [] },
    },
  });
  const message = JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', data: { id: 'm-1', content: 'hi' } });

  async function startGateway(botToken?: string) {
    let webhookUrl = '';
    const handleWebhook = vi.fn(async () => new Response('ok'));
    const adapter = stubAdapter({
      name: 'discord',
      initialize: async () => {},
      handleWebhook,
      channelIdFromThreadId: (threadId: string) => threadId,
    }) as Adapter & { startGatewayListener: unknown };
    adapter.startGatewayListener = async (_opts: unknown, _ms: number, _signal: AbortSignal, url: string) => {
      webhookUrl = url;
      return new Response('{}');
    };
    const onAction = vi.fn();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, botToken });
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const post = (body: string, headers: Record<string, string> = {}) =>
      realFetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    return { bridge, post, onAction, handleWebhook, webhookUrl };
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    // Interaction acks go to the Discord API; keep them off the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  it.each([
    ['no gateway token', {}],
    ['a wrong gateway token', { 'x-discord-gateway-token': 'not-the-token' }],
  ])('rejects a request with %s before it reaches the adapter or the host', async (_label, headers) => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      for (const body of [click, message]) {
        const res = await post(body, headers);
        expect(res.status).toBe(401);
      }
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('answers 401 without waiting for the request body', async () => {
    const { bridge, webhookUrl } = await startGateway(BOT_TOKEN);
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.request(webhookUrl, { method: 'POST', headers: { 'Content-Length': '1000' } }, (res) => {
          resolve(res.statusCode);
          req.destroy();
        });
        req.on('error', reject);
        req.flushHeaders(); // the body never follows
      });
      expect(status).toBe(401);
    } finally {
      await bridge.teardown();
    }
  });

  it('rejects every request when no bot token is configured', async () => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(undefined);
    try {
      const res = await post(click, { 'x-discord-gateway-token': '' });
      expect(res.status).toBe(401);
      expect((await post(message)).status).toBe(401);
      expect(onAction).not.toHaveBeenCalled();
      expect(handleWebhook).not.toHaveBeenCalled();
    } finally {
      await bridge.teardown();
    }
  });

  it('dispatches clicks and forwards other events when the gateway token matches', async () => {
    const { bridge, post, onAction, handleWebhook } = await startGateway(BOT_TOKEN);
    try {
      const auth = { 'x-discord-gateway-token': BOT_TOKEN };
      expect((await post(click, auth)).status).toBe(200);
      expect(onAction).toHaveBeenCalledWith('q-1', 'approve', 'clicker-1', {
        messageId: 'card-1',
        platformId: 'chan-1',
      });
      expect((await post(message, auth)).status).toBe(200);
      expect(handleWebhook).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
    }
  });
});

describe('createChatSdkBridge — requests as text', () => {
  // A channel whose account cannot show cards (Google Chat under user
  // authentication) posts questions and approval requests in words, records
  // each one it posts, and leaves its outcome to the handler that authorizes
  // an answer: the bridge never edits a request on its own.
  const DM = 'fixture:spaces/AAAAjuno';
  const POSTED_AT = '2026-10-10T17:00:05.000000Z';
  const APPROVAL_OPTIONS = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
    { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: 'reject_with_reason' },
  ];
  const QUESTION = "I'd like to install ffmpeg to cut the video.";

  interface EditCall {
    threadId: string;
    messageId: string;
    message: AdapterPostableMessage;
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  async function textBridge(postedRaw: unknown = { createTime: POSTED_AT }) {
    const posts: PostCall[] = [];
    const edits: EditCall[] = [];
    const adapter = stubAdapter({
      name: 'fixture',
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => threadId,
      postMessage: async (threadId, message) => {
        posts.push({ threadId, message });
        return { id: `spaces/AAAAjuno/messages/morgan.${posts.length}`, threadId, raw: postedRaw };
      },
      editMessage: async (threadId, messageId, message) => {
        edits.push({ threadId, messageId, message });
        return { id: messageId, threadId, raw: {} };
      },
    });
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      textRequests: {
        postedAt: (raw) => {
          const createTime = (raw as { createTime?: string }).createTime;
          return createTime === undefined ? undefined : new Date(createTime);
        },
      },
    });
    const onAction = vi.fn();
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
    const { SqliteStateAdapter } = await import('../state-sqlite.js');
    const state = new SqliteStateAdapter();
    await state.connect();
    return {
      bridge,
      adapter,
      posts,
      edits,
      onAction,
      posted: (messageId: string) => readPostedRequest(state, 'fixture', messageId),
    };
  }

  function askApproval(questionId = 'appr-1') {
    return {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId,
        title: 'Install packages',
        question: QUESTION,
        options: APPROVAL_OPTIONS,
      },
    };
  }

  function outcome(questionId: string, resolution: string, messageId?: string) {
    return {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        questionId,
        ...(messageId === undefined ? {} : { messageId }),
        text: ['Install packages', QUESTION, resolution].join('\n\n'),
        terminalCard: { title: 'Install packages', question: QUESTION, resolution },
      },
    };
  }

  it.each([
    [
      'an approval whose rejection takes a reason',
      APPROVAL_OPTIONS,
      'Quote this message with yes or no, or react 👍 or 👎. To say why, quote it with no and your reason.',
    ],
    ['a plain approval', APPROVAL_OPTIONS.slice(0, 2), 'Quote this message with yes or no, or react 👍 or 👎.'],
    [
      'any other request, numbering its options,',
      [
        { label: 'Connect to main', value: 'connect:ag-main' },
        { label: 'Connect new agent', value: 'new_agent' },
        { label: 'Reject', value: 'reject' },
      ],
      '1. Connect to main\n2. Connect new agent\n3. Reject\n\nQuote this message with the number or name of your choice.',
    ],
  ] as const)('posts %s in words, with no code and no card, and records it', async (_asked, options, howToAnswer) => {
    const { bridge, posts, posted } = await textBridge();
    try {
      const id = await bridge.deliver(DM, null, {
        kind: 'chat-sdk',
        content: { type: 'ask_question', questionId: 'appr-1', title: 'Install packages', question: QUESTION, options },
      });

      expect(id).toBe('spaces/AAAAjuno/messages/morgan.1');
      expect(posts).toEqual([
        { threadId: DM, message: { markdown: `**Install packages**\n\n${QUESTION}\n\n${howToAnswer}` } },
      ]);
      expect(await posted('spaces/AAAAjuno/messages/morgan.1')).toEqual({
        questionId: 'appr-1',
        platformId: DM,
        postedAt: '2026-10-10T17:00:05.000Z',
      });
    } finally {
      await bridge.teardown();
    }
  });

  it('posts a display card as text with its links', async () => {
    const { bridge, posts, posted } = await textBridge();
    try {
      const id = await bridge.deliver(DM, null, {
        kind: 'chat-sdk',
        content: {
          type: 'card',
          card: {
            title: 'Launch review',
            description: 'Thursday at 10am with Juno and Remy.',
            children: ['Agenda attached', { text: 'Room: Atlas' }],
            actions: [
              { label: 'Agenda', url: 'https://example.com/agenda' },
              { label: 'No link' },
              { label: 'Room booking', url: 'https://example.com/atlas' },
            ],
          },
          fallbackText: 'Launch review Thursday',
        },
      });

      expect(id).toBe('spaces/AAAAjuno/messages/morgan.1');
      expect(posts[0]!.message).toEqual({
        markdown:
          '**Launch review**\n\nThursday at 10am with Juno and Remy.\n\nAgenda attached\n\nRoom: Atlas\n\n' +
          '[Agenda](https://example.com/agenda)\n[Room booking](https://example.com/atlas)',
      });
      expect(await posted('spaces/AAAAjuno/messages/morgan.1')).toBeUndefined();
    } finally {
      await bridge.teardown();
    }
  });

  it('remembers a request the platform reported no time for, without one', async () => {
    const { bridge, posted } = await textBridge({});
    try {
      await bridge.deliver(DM, null, askApproval());

      expect(await posted('spaces/AAAAjuno/messages/morgan.1')).toEqual({ questionId: 'appr-1', platformId: DM });
    } finally {
      await bridge.teardown();
    }
  });

  it('edits nothing for an outcome of a request it never posted, naming no message', async () => {
    const { bridge, edits } = await textBridge();
    try {
      await bridge.deliver(DM, null, outcome('appr-elsewhere', '✅ Approved'));

      expect(edits).toEqual([]);
    } finally {
      await bridge.teardown();
    }
  });

  it("edits the posted request to its handler's outcome, after which it takes no answer", async () => {
    const { bridge, edits, posted } = await textBridge();
    try {
      await bridge.deliver(DM, null, askApproval());
      await bridge.deliver(DM, null, outcome('appr-1', '✅ Approved', 'spaces/AAAAjuno/messages/morgan.1'));

      expect(edits).toEqual([
        {
          threadId: DM,
          messageId: 'spaces/AAAAjuno/messages/morgan.1',
          message: { markdown: `**Install packages**\n\n${QUESTION}\n\n✅ Approved` },
        },
      ]);
      expect(await posted('spaces/AAAAjuno/messages/morgan.1')).toBeUndefined();
    } finally {
      await bridge.teardown();
    }
  });

  it('refuses to reword an open request, and edits it once it shows its outcome', async () => {
    const { bridge, edits, posted } = await textBridge();
    try {
      await bridge.deliver(DM, null, askApproval());
      const reworded = {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'spaces/AAAAjuno/messages/morgan.1',
          text: 'Install a spell checker?',
        },
      };

      await expect(bridge.deliver(DM, null, reworded)).rejects.toThrow(/open request/);
      expect(edits).toEqual([]);
      expect((await posted('spaces/AAAAjuno/messages/morgan.1'))?.questionId).toBe('appr-1');

      await bridge.deliver(DM, null, outcome('appr-1', '✅ Approved'));
      await bridge.deliver(DM, null, reworded);
      expect(edits.map((edit) => edit.message)).toEqual([
        { markdown: `**Install packages**\n\n${QUESTION}\n\n✅ Approved` },
        { markdown: 'Install a spell checker?' },
      ]);
    } finally {
      await bridge.teardown();
    }
  });

  it('edits the message the answer named when a question was posted twice, and the newest when none is named', async () => {
    const { bridge, edits, posted } = await textBridge();
    try {
      await bridge.deliver(DM, null, askApproval('mg-room'));
      await bridge.deliver(DM, null, askApproval('mg-room'));
      await bridge.deliver(DM, null, outcome('mg-room', '📋 Choosing…', 'spaces/AAAAjuno/messages/morgan.1'));

      expect(edits.map((edit) => edit.messageId)).toEqual(['spaces/AAAAjuno/messages/morgan.1']);
      expect(await posted('spaces/AAAAjuno/messages/morgan.1')).toBeUndefined();
      expect((await posted('spaces/AAAAjuno/messages/morgan.2'))?.questionId).toBe('mg-room');

      await bridge.deliver(DM, null, outcome('mg-room', '✅ Connected to main'));
      expect(edits.map((edit) => edit.messageId)).toEqual([
        'spaces/AAAAjuno/messages/morgan.1',
        'spaces/AAAAjuno/messages/morgan.2',
      ]);
    } finally {
      await bridge.teardown();
    }
  });

  it("edits an expired gateway request to say so, through the coordinator's own edit", async () => {
    const coordinator = await import('../gateway-approval-coordinator.js');
    const { createPendingApproval, getPendingApproval } = await import('../db/sessions.js');
    const { bridge, edits } = await textBridge();
    await coordinator.startGatewayApprovalCoordinator(
      {
        kind: 'fixture',
        agentSkills: [],
        sessions: {
          async ensure() {
            return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
          },
        },
        approvals: {
          async subscribe(_decide, signal) {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          },
        },
      },
      {
        deliver: (_channelType, platformId, threadId, kind, content) =>
          bridge.deliver(platformId, threadId, { kind, content: JSON.parse(content) as unknown }),
      },
      vi.fn(),
    );
    try {
      const messageId = await bridge.deliver(DM, null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: 'ga-1',
          title: 'Credentials request',
          question: 'POST api.example.com/v1/charges',
          options: APPROVAL_OPTIONS.slice(0, 2),
        },
      });
      await createPendingApproval({
        approval_id: 'ga-1',
        request_id: 'req-1',
        action: coordinator.GATEWAY_APPROVAL_ACTION,
        payload: JSON.stringify({ gatewayProvider: 'fixture' }),
        created_at: new Date().toISOString(),
        channel_type: 'fixture',
        platform_id: DM,
        platform_message_id: messageId ?? null,
        expires_at: new Date().toISOString(),
        title: 'Credentials request',
        question: 'POST api.example.com/v1/charges',
        options_json: JSON.stringify(APPROVAL_OPTIONS.slice(0, 2)),
      });

      await coordinator.editExpiredGatewayApprovalCard((await getPendingApproval('ga-1'))!, 'no response');

      expect(edits).toEqual([
        {
          threadId: DM,
          messageId: 'spaces/AAAAjuno/messages/morgan.1',
          message: {
            markdown: '**Credentials request**\n\nPOST api.example.com/v1/charges\n\n⏱️ Timed out — no response',
          },
        },
      ]);
    } finally {
      await coordinator.stopGatewayApprovalCoordinator();
      await bridge.teardown();
    }
  });

  it('never edits a request on a click: it hands the answer on for its handler to resolve', async () => {
    const { registerQuestionRenderResolver } = await import('./question-render-registry.js');
    registerQuestionRenderResolver((id) =>
      id === 'text-click-fixture'
        ? { title: 'Pick a time', options: [{ label: 'Tuesday', selectedLabel: 'Tuesday', value: 'tue' }] }
        : undefined,
    );
    const { bridge, adapter, edits, onAction } = await textBridge();
    try {
      const chat = (bridge as unknown as { _chat: import('chat').Chat })._chat;
      await chat.processAction(
        {
          actionId: 'ncq:text-click-fixture:0',
          adapter,
          messageId: 'spaces/AAAAjuno/messages/morgan.1',
          raw: {},
          threadId: DM,
          user: { userId: 'users/2001' } as never,
          value: '0',
        },
        undefined,
      );

      expect(onAction).toHaveBeenCalledWith(
        'text-click-fixture',
        'tue',
        'users/2001',
        { instance: 'fixture', messageId: 'spaces/AAAAjuno/messages/morgan.1', platformId: DM },
        { deferResolution: true },
      );
      expect(edits).toEqual([]);
    } finally {
      await bridge.teardown();
    }
  });
});

describe('createChatSdkBridge — pictures on requests (KTD6)', () => {
  // A request may name pictures that go with it, such as a checkout's total
  // and its commit control; their bytes ride beside its content as the
  // message's files. They go on the request's own message only through an
  // adapter that attaches files to it (FileAttacher). Otherwise the request
  // posts without them and says so, as it does when their bytes did not come
  // with it: a re-post from anything kept after a restart has none.
  const DM = 'fixture:spaces/AAAAjuno';
  const TITLE = 'Approve this purchase?';
  const QUESTION = 'Checkout at shop.example: 41.20 USD due now, paid with the saved card ending 4242.';
  const OPTIONS = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
  ];
  const HOW_TO_ANSWER = 'Quote this message with yes or no, or react 👍 or 👎.';
  const NO_PICTURE = "I couldn't attach the picture that goes with this.";
  const PICTURE: OutboundFile = { filename: 'checkout.png', mimeType: 'image/png', data: Buffer.from('png bytes') };

  type Attaching = 'attaches' | 'cannot attach' | 'fails';
  interface AttachCall {
    threadId: string;
    message: AdapterPostableMessage;
    files: readonly OutboundFile[];
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  /** A bridge whose adapter attaches files as told, or cannot attach any when told nothing. */
  async function pictureBridge(attaching?: Attaching, textRequests = true) {
    const posts: PostCall[] = [];
    const attached: AttachCall[] = [];
    let written = 0;
    const posted = (threadId: string): RawMessage<unknown> => {
      written += 1;
      return {
        id: `spaces/AAAAjuno/messages/morgan.${written}`,
        threadId,
        raw: { createTime: '2026-10-10T17:00:05Z' },
      };
    };
    const adapter = stubAdapter({
      name: 'fixture',
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => threadId,
      postMessage: async (threadId, message) => {
        posts.push({ threadId, message });
        return posted(threadId);
      },
    });
    const attacher: FileAttacher = {
      postWithFiles: async (threadId, message, files) => {
        attached.push({ threadId, message, files });
        if (attaching === 'cannot attach') throw new FilesNotAttachedError('Chat refused checkout.png');
        if (attaching === 'fails') throw new Error('Chat could not be reached');
        return posted(threadId);
      },
    };
    const bridge = createChatSdkBridge({
      adapter: attaching === undefined ? adapter : Object.assign(adapter, attacher),
      supportsThreads: true,
      ...(textRequests
        ? { textRequests: { postedAt: (raw: unknown) => new Date((raw as { createTime: string }).createTime) } }
        : {}),
    });
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction: vi.fn() });
    const { SqliteStateAdapter } = await import('../state-sqlite.js');
    const state = new SqliteStateAdapter();
    await state.connect();
    return {
      bridge,
      posts,
      attached,
      posted: (messageId: string) => readPostedRequest(state, 'fixture', messageId),
    };
  }

  /** The approval request, naming `pictures` when given, with `files` beside it when given. */
  function ask(pictures?: number, files?: OutboundFile[]) {
    return {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-1',
        title: TITLE,
        question: QUESTION,
        options: OPTIONS,
        ...(pictures === undefined ? {} : { pictures }),
      },
      ...(files === undefined ? {} : { files }),
    };
  }

  function words(...lines: string[]): AdapterPostableMessage {
    return { markdown: [`**${TITLE}**`, QUESTION, ...lines, HOW_TO_ANSWER].join('\n\n') };
  }

  it('posts a request with its picture on the one message it is answered on, through an adapter that attaches files', async () => {
    const desk = await pictureBridge('attaches');
    try {
      const id = await desk.bridge.deliver(DM, null, ask(1, [PICTURE]));

      expect(desk.attached).toEqual([{ threadId: DM, message: words(), files: [PICTURE] }]);
      expect(desk.posts).toEqual([]);
      expect(id).toBe('spaces/AAAAjuno/messages/morgan.1');
      expect((await desk.posted(id!))?.questionId).toBe('appr-1');
    } finally {
      await desk.bridge.teardown();
    }
  });

  it('posts the request without its picture, saying so, when the adapter could not attach it', async () => {
    const desk = await pictureBridge('cannot attach');
    try {
      const id = await desk.bridge.deliver(DM, null, ask(1, [PICTURE]));

      expect(desk.attached).toHaveLength(1);
      expect(desk.posts).toEqual([{ threadId: DM, message: words(NO_PICTURE) }]);
      expect((await desk.posted(id!))?.questionId).toBe('appr-1');
    } finally {
      await desk.bridge.teardown();
    }
  });

  it('fails the request as any failed post does when the adapter fails for another reason', async () => {
    const desk = await pictureBridge('fails');
    try {
      await expect(desk.bridge.deliver(DM, null, ask(1, [PICTURE]))).rejects.toThrow(/could not be reached/u);
      expect(desk.posts).toEqual([]);
    } finally {
      await desk.bridge.teardown();
    }
  });

  it('hands an adapter that cannot attach files none, and says the picture is unavailable', async () => {
    const desk = await pictureBridge();
    try {
      await desk.bridge.deliver(DM, null, ask(1, [PICTURE]));

      expect(desk.posts).toEqual([{ threadId: DM, message: words(NO_PICTURE) }]);
    } finally {
      await desk.bridge.teardown();
    }
  });

  it('says so on a card too, where requests post as cards', async () => {
    const desk = await pictureBridge(undefined, false);
    try {
      await desk.bridge.deliver(DM, null, ask(1, [PICTURE]));

      expect(desk.posts).toHaveLength(1);
      const card = desk.posts[0]!.message as {
        card: { children: Array<{ type: string; content?: string }> };
        fallbackText: string;
        files?: unknown;
      };
      expect(card.card.children.map((child) => child.content ?? child.type)).toEqual([QUESTION, NO_PICTURE, 'actions']);
      expect(card.fallbackText).toContain(NO_PICTURE);
      expect(card.files).toBeUndefined();
    } finally {
      await desk.bridge.teardown();
    }
  });

  it.each([
    ['its bytes did not come with it, as on a re-post after a restart', 1, undefined, NO_PICTURE],
    ['only some of them came with it', 2, [PICTURE], "I couldn't attach the pictures that go with this."],
  ] as const)('says the pictures a request names are unavailable when %s', async (_when, pictures, files, line) => {
    const desk = await pictureBridge('attaches');
    try {
      await desk.bridge.deliver(DM, null, ask(pictures, files === undefined ? undefined : [...files]));

      expect(desk.attached).toEqual([]);
      expect(desk.posts).toEqual([{ threadId: DM, message: words(line) }]);
    } finally {
      await desk.bridge.teardown();
    }
  });

  it('posts a request that names no picture as before, attaching no file sent with it', async () => {
    const desk = await pictureBridge('attaches');
    try {
      await desk.bridge.deliver(DM, null, ask(undefined, [PICTURE]));

      expect(desk.attached).toEqual([]);
      expect(desk.posts).toEqual([{ threadId: DM, message: words() }]);
    } finally {
      await desk.bridge.teardown();
    }
  });
});

describe('createChatSdkBridge — answers in words', () => {
  // On a channel whose requests are text, a reply or reaction that answers a
  // request reaches the request's handler through onAction, awaited, instead
  // of the agent. Anything else is routed as any message is. Which words and
  // reactions answer which request is answers.test.ts's to prove; these cases
  // prove what the bridge hands it and does with its verdict.
  const DM = 'fixture:spaces/AAAAjuno';
  const DM_THREAD = `${DM}:dm`;
  const ROOM = 'fixture:spaces/AAAAlaunch';
  const ROOM_THREAD = `${ROOM}:thread-1`;
  const JUNO = { userId: 'users/1001', userName: 'Juno Hale', fullName: 'Juno Hale', isBot: false, isMe: false };
  const T0 = Date.parse('2026-10-10T17:00:00.000Z');
  const APPROVAL_OPTIONS = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
    { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: 'reject_with_reason' },
  ];
  const TIMES = [
    { label: 'Tuesday 3pm', selectedLabel: 'Tuesday 3pm', value: 'tue' },
    { label: 'Wednesday 10am', selectedLabel: 'Wednesday 10am', value: 'wed' },
    { label: 'Thursday 9am', selectedLabel: 'Thursday 9am', value: 'thu' },
  ];
  const YES_NO = [
    { label: 'Yes', selectedLabel: 'Yes', value: 'yes' },
    { label: 'No', selectedLabel: 'No', value: 'no' },
  ];

  type ActionCall = Parameters<ChannelSetup['onAction']>;

  /** An ISO time `seconds` into the scenario, by the platform's clock. */
  function iso(seconds: number): string {
    return new Date(T0 + seconds * 1000).toISOString();
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    const { createAgentGroup } = await import('../db/agent-groups.js');
    const { createSession } = await import('../db/sessions.js');
    await runMigrations(await initTestDb());
    const now = new Date().toISOString();
    await createAgentGroup({ id: 'ag-main', name: 'Main', folder: 'main', agent_provider: null, created_at: now });
    await createSession({
      id: 'sess-main',
      agent_group_id: 'ag-main',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now,
      created_at: now,
    });
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  async function answeringBridge(handle: (...call: ActionCall) => Promise<void> = async () => {}) {
    let chat: import('chat').ChatInstance | undefined;
    let reactionHandler: ((reaction: InboundReaction) => Promise<void>) | undefined;
    const routed: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
    const actions: ActionCall[] = [];
    let posts = 0;
    let postedAt = iso(0);
    const source: ReactionSource = {
      setReactionHandler: (next) => {
        reactionHandler = next;
      },
    };
    const adapter = Object.assign(
      stubAdapter({
        name: 'fixture',
        userName: 'noel',
        initialize: async (instance) => {
          chat = instance;
        },
        channelIdFromThreadId: (threadId: string) => threadId.slice(0, threadId.lastIndexOf(':')),
        isDM: (threadId: string) => threadId.endsWith(':dm'),
        postMessage: async (threadId) => {
          posts += 1;
          return { id: `spaces/AAAA/messages/noel.${posts}`, threadId, raw: { createTime: postedAt } };
        },
      }),
      source,
    );
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      redelivers: true,
      extractReplyContext: (raw) => {
        const quote = raw.quote as { name?: string; text: string } | undefined;
        return quote ? { sender: 'Noel', text: quote.text, ...(quote.name ? { id: quote.name } : {}) } : null;
      },
      textRequests: { postedAt: (raw) => new Date((raw as { createTime: string }).createTime) },
    });
    await bridge.setup({
      onInbound: async (platformId, threadId, message) => {
        routed.push({ platformId, threadId, message });
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: async (...call) => {
        actions.push(call);
        await handle(...call);
      },
    });
    const { SqliteStateAdapter } = await import('../state-sqlite.js');
    const state = new SqliteStateAdapter();
    await state.connect();
    return {
      bridge,
      routed,
      actions,
      state,
      /** The assistant posts a request in a conversation, recorded `seconds` into the scenario. */
      async ask(platformId: string, questionId: string, options: typeof APPROVAL_OPTIONS, seconds: number) {
        postedAt = iso(seconds);
        const messageId = await bridge.deliver(platformId, null, {
          kind: 'chat-sdk',
          content: { type: 'ask_question', questionId, title: 'Request', question: 'Shall I?', options },
        });
        return messageId!;
      },
      /**
       * Someone writes in a thread, `seconds` into the scenario, quoting a message when told to, or
       * forwarding one: a forward quotes text without naming a message it replies to.
       */
      write(
        text: string,
        seconds: number,
        options: { id?: string; thread?: string; quote?: string; forwarded?: string } = {},
      ) {
        const message = new Message({
          id: options.id ?? `spaces/AAAA/messages/juno.${seconds}`,
          threadId: options.thread ?? DM_THREAD,
          text,
          formatted: parseMarkdown(text),
          raw:
            options.quote !== undefined
              ? { quote: { name: options.quote, text: 'Shall I?' } }
              : options.forwarded !== undefined
                ? { quote: { text: options.forwarded } }
                : {},
          author: JUNO,
          metadata: { dateSent: new Date(T0 + seconds * 1000), edited: false },
          attachments: [],
        });
        return chat!.processMessage(adapter, options.thread ?? DM_THREAD, message);
      },
      /** Someone reacts in the DM to the assistant's message; the platform names a reaction the same each delivery. */
      react(messageId: string, emoji: string) {
        return reactionHandler!({
          reactionName: `${messageId}/reactions/${emoji}`,
          emoji: getEmoji(emoji),
          user: JUNO,
          message: new Message({
            id: messageId,
            threadId: DM_THREAD,
            text: 'Shall I?',
            formatted: parseMarkdown('Shall I?'),
            raw: {},
            author: { userId: 'users/9', userName: 'Noel', fullName: 'Noel', isBot: false, isMe: true },
            metadata: { dateSent: new Date(T0), edited: false },
            attachments: [],
          }),
          threadId: DM_THREAD,
          reactedAt: new Date(T0 + 90_000),
        });
      },
    };
  }

  /** An agent's question, open for the next hour. */
  async function askedQuestion(questionId: string, options: typeof YES_NO): Promise<void> {
    const { createPendingQuestion } = await import('../db/sessions.js');
    await createPendingQuestion({
      question_id: questionId,
      session_id: 'sess-main',
      message_out_id: `out-${questionId}`,
      platform_id: DM,
      channel_type: 'fixture',
      thread_id: null,
      title: 'Request',
      question: 'Shall I?',
      options,
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      created_at: new Date().toISOString(),
    });
  }

  async function pendingApproval(approvalId: string, options: typeof APPROVAL_OPTIONS = APPROVAL_OPTIONS) {
    const { createPendingApproval } = await import('../db/sessions.js');
    await createPendingApproval({
      approval_id: approvalId,
      request_id: `request-${approvalId}`,
      action: 'install_packages',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: 'Request',
      question: 'Shall I?',
      options_json: JSON.stringify(options),
    });
  }

  it("takes a plain answer in a DM by the platform's clock, against the questions asked since the person last wrote", async () => {
    await askedQuestion('q-room', YES_NO);
    await askedQuestion('q-projector', YES_NO);
    const desk = await answeringBridge();
    try {
      await desk.ask(DM, 'q-room', YES_NO, 0);
      // Typed as the question arrived: no answer, and the question is now older than Juno's last message.
      await desk.write('yes', 2);
      const projector = await desk.ask(DM, 'q-projector', YES_NO, 10);
      await desk.write('yes', 20);

      expect(desk.actions).toEqual([
        [
          'q-projector',
          'yes',
          'users/1001',
          { instance: 'fixture', messageId: projector, platformId: DM },
          { deferResolution: true },
        ],
      ]);
      expect(desk.routed.map(({ message }) => message.id)).toEqual(['spaces/AAAA/messages/juno.2']);
    } finally {
      await desk.bridge.teardown();
    }
  });

  it('takes quoted answers in a group, past a mention of the assistant and with the reason a no gives, and routes a plain one', async () => {
    await askedQuestion('q-launch', TIMES);
    await pendingApproval('appr-launch');
    const desk = await answeringBridge();
    try {
      const question = await desk.ask(ROOM, 'q-launch', TIMES, 0);
      const approval = await desk.ask(ROOM, 'appr-launch', APPROVAL_OPTIONS, 0);
      await desk.write('2', 20, { thread: ROOM_THREAD });
      await desk.write('2', 30, { thread: ROOM_THREAD, quote: question });
      await desk.write('@noel no, too expensive', 40, { thread: ROOM_THREAD, quote: approval });

      expect(desk.actions).toEqual([
        [
          'q-launch',
          'wed',
          'users/1001',
          { instance: 'fixture', messageId: question, platformId: ROOM },
          { deferResolution: true },
        ],
        [
          'appr-launch',
          'reject',
          'users/1001',
          { instance: 'fixture', messageId: approval, platformId: ROOM },
          { deferResolution: true, reason: 'too expensive' },
        ],
      ]);
      expect(desk.routed.map(({ platformId, message }) => [platformId, message.id])).toEqual([
        [ROOM, 'spaces/AAAA/messages/juno.20'],
      ]);
    } finally {
      await desk.bridge.teardown();
    }
  });

  it('routes a forward with its quote: it names no request, though its words would answer the open question', async () => {
    await askedQuestion('q-room', YES_NO);
    const desk = await answeringBridge();
    try {
      await desk.ask(DM, 'q-room', YES_NO, 0);
      await desk.write('yes', 30, { forwarded: 'Atlas is free on Thursday.' });

      expect(desk.actions).toEqual([]);
      expect(desk.routed.map(({ message }) => message.content)).toEqual([
        expect.objectContaining({ text: 'yes', replyTo: { sender: 'Noel', text: 'Atlas is free on Thursday.' } }),
      ]);
    } finally {
      await desk.bridge.teardown();
    }
  });

  it('hands a 👍 on an approval to its handler once, though delivered again, and routes a 👍 that answers nothing', async () => {
    const channelOptions = [
      { label: 'Choose existing agent', selectedLabel: 'Choose existing agent', value: 'choose_existing' },
      { label: 'Connect new agent', selectedLabel: 'Connect new agent', value: 'new_agent' },
      { label: 'Reject', selectedLabel: 'Reject', value: 'reject' },
    ];
    await pendingApproval('appr-ffmpeg');
    await pendingApproval('mg-launch', channelOptions);
    const desk = await answeringBridge();
    try {
      const request = await desk.ask(DM, 'appr-ffmpeg', APPROVAL_OPTIONS, 0);
      const channel = await desk.ask(DM, 'mg-launch', channelOptions, 0);
      await desk.react(request, 'thumbs_up');
      await desk.react(request, 'thumbs_up');
      await desk.react(channel, 'thumbs_up');

      expect(desk.actions).toEqual([
        [
          'appr-ffmpeg',
          'approve',
          'users/1001',
          { instance: 'fixture', messageId: request, platformId: DM },
          { deferResolution: true },
        ],
      ]);
      expect(desk.routed.map(({ message }) => [message.id, message.reaction])).toEqual([
        [`${channel}/reactions/thumbs_up`, true],
      ]);
    } finally {
      await desk.bridge.teardown();
    }
  });

  it("rejects while an answer's handler fails, then takes the answer delivered again once, routing none of it", async () => {
    await askedQuestion('q-room', YES_NO);
    let failures = 1;
    const desk = await answeringBridge(async () => {
      if (failures-- > 0) throw new Error('database is locked');
    });
    try {
      const request = await desk.ask(DM, 'q-room', YES_NO, 0);
      const id = 'spaces/AAAA/messages/juno.yes';
      // Pub/Sub may deliver a message again for days, and the SDK drops a copy for ten minutes only; the
      // adapter releases that for a message it could not hand on. Each delivery here comes past it.
      const deliver = async () => {
        await desk.state.delete(`dedupe:fixture:${id}`);
        await desk.write('yes', 30, { id, quote: request });
      };

      await expect(deliver()).rejects.toThrow(/database is locked/u);
      await deliver();
      await deliver();

      expect(desk.actions.map(([questionId, value]) => [questionId, value])).toEqual([
        ['q-room', 'yes'],
        ['q-room', 'yes'],
      ]);
      expect(desk.routed).toEqual([]);
    } finally {
      await desk.bridge.teardown();
    }
  });
});
