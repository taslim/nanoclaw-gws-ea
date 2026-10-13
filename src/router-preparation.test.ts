import fs from 'node:fs';
import Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR, requestWake, fanInboundMessage } = vi.hoisted(() => ({
  TEST_DIR: `/tmp/nanoclaw-router-preparation-${process.pid}`,
  requestWake: vi.fn(async () => true),
  fanInboundMessage: vi.fn(async (_args: { content: string; timestamp: string }) => 0),
}));
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DIR,
}));
vi.mock('./request-wake.js', () => ({ requestWake }));
vi.mock('./modules/typing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modules/typing/index.js')>()),
  startTypingRefresh: vi.fn(),
}));
vi.mock('./modules/cross-session-context/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modules/cross-session-context/index.js')>()),
  fanInboundMessage,
}));

import type { InboundEvent } from './channels/adapter.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, getDb, initSqliteTestDb } from './db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import { runMigrations } from './db/migrations/index.js';
import { registerInboundPreparer, type InboundPreparationRequest } from './inbound-preparation.js';
import {
  registerSessionCreatedHook,
  routeInbound,
  setAccessGate,
  setSenderScopeGate,
  type SessionCreatedEvent,
} from './router.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import * as sessionManager from './session-manager.js';

const prepare = vi.fn<(request: InboundPreparationRequest) => Promise<string>>();
registerInboundPreparer((request) => prepare(request));
let refused = false;
let scopedOut = false;
setAccessGate(() => (refused ? { allowed: false, reason: 'refused' } : { allowed: true }));
setSenderScopeGate(() => (scopedOut ? { allowed: false, reason: 'scope' } : { allowed: true }));
const createdEvents: SessionCreatedEvent[] = [];
registerSessionCreatedHook((event) => {
  createdEvents.push(event);
});

const timestamp = '2026-10-12T18:30:00.000Z';

function event(id: string, platformId = 'dm-1', text = ''): InboundEvent {
  return {
    channelType: 'testchat',
    instance: 'testchat',
    platformId,
    threadId: null,
    message: {
      id,
      kind: 'chat-sdk',
      timestamp,
      isMention: true,
      isGroup: false,
      deduplicate: true,
      authenticatedSender: { userId: 'testchat:principal', displayName: 'Alex', kind: 'human' },
      content: JSON.stringify({
        text,
        sender: 'Alex',
        senderId: 'testchat:principal',
        attachments: [{ type: 'audio', filename: 'voice.ogg', audioSource: { kind: 'voice-note' } }],
      }),
    },
  };
}

async function seed(platformId: string, ids: readonly string[] = ['ag-1']): Promise<void> {
  const mg = `mg-${platformId}`;
  await createMessagingGroup({
    id: mg,
    channel_type: 'testchat',
    instance: 'testchat',
    platform_id: platformId,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: timestamp,
  });
  for (const id of ids) {
    await createMessagingGroupAgent({
      id: `${mg}-${id}`,
      messaging_group_id: mg,
      agent_group_id: id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: timestamp,
    });
  }
}

async function rows(
  agentGroupId: string,
  platformId = 'dm-1',
): Promise<Array<{ id: string; content: string; timestamp: string }>> {
  const session = await getDb().get<{ id: string }>(
    'SELECT s.id FROM sessions s JOIN messaging_groups mg ON mg.id=s.messaging_group_id WHERE s.agent_group_id=? AND mg.platform_id=?',
    agentGroupId,
    platformId,
  );
  if (!session) return [];
  const db = new Database(inboundDbPath(agentGroupId, session.id), { readonly: true });
  try {
    return db.prepare('SELECT id, content, timestamp FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      content: string;
      timestamp: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initSqliteTestDb());
  for (const id of ['ag-1', 'ag-2']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: timestamp });
  }
  refused = false;
  scopedOut = false;
  createdEvents.length = 0;
  requestWake.mockClear();
  fanInboundMessage.mockClear();
  prepare.mockReset();
  prepare.mockImplementation(async (request) => {
    const content = JSON.parse(request.content) as { attachments: Array<Record<string, unknown>> };
    content.attachments[0].speech = { status: 'recognized', text: 'Friday, if Sarah confirms.', language: 'en' };
    return JSON.stringify(content);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('admitted inbound preparation', () => {
  it('prepares one source once and writes the same faithful content into each target and created-session hook', async () => {
    await seed('dm-1', ['ag-1', 'ag-2']);
    const original = event('voice-1');
    const raw = original.message.content;
    await routeInbound(original);

    expect(prepare).toHaveBeenCalledTimes(1);
    const first = (await rows('ag-1'))[0];
    const second = (await rows('ag-2'))[0];
    expect(first.id).toBe('voice-1:ag-1');
    expect(second.id).toBe('voice-1:ag-2');
    expect(first.content).toBe(second.content);
    expect(JSON.parse(first.content)).toMatchObject({
      text: '',
      senderId: 'testchat:principal',
      attachments: [{ speech: { status: 'recognized', text: 'Friday, if Sarah confirms.', language: 'en' } }],
    });
    expect(createdEvents.map(({ message }) => message)).toEqual([
      { id: 'voice-1', kind: 'chat-sdk', content: first.content, timestamp },
      { id: 'voice-1', kind: 'chat-sdk', content: first.content, timestamp },
    ]);
    expect(fanInboundMessage.mock.calls.map(([args]) => args)).toEqual([
      expect.objectContaining({ content: first.content, timestamp }),
      expect.objectContaining({ content: first.content, timestamp }),
    ]);
    expect(original.message.content).toBe(raw);
    expect(prepare.mock.calls[0][0].authenticatedSender).toEqual(original.message.authenticatedSender);
  });

  it('performs no preparation for unwired, quiet, refused, scoped-out, filtered or denied command events', async () => {
    await routeInbound(event('unwired', 'unknown'));
    await seed('dm-1');
    const quiet = event('quiet');
    quiet.message.quiet = true;
    await routeInbound(quiet);
    refused = true;
    await routeInbound(event('refused'));
    refused = false;
    scopedOut = true;
    await routeInbound(event('scoped-out'));
    scopedOut = false;
    await routeInbound(event('filtered', 'dm-1', '/help'));
    await routeInbound(event('denied', 'dm-1', '/clear'));
    await getDb().run("UPDATE messaging_group_agents SET engage_pattern='^wake$' WHERE messaging_group_id='mg-dm-1'");
    await routeInbound(event('nonengaging'));
    expect(prepare).not.toHaveBeenCalled();
    expect(await rows('ag-1')).toEqual([]);
  });

  it('preserves same-conversation order through slow preparation while another conversation proceeds', async () => {
    await seed('dm-1');
    await seed('dm-2');
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let start: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    prepare.mockImplementation(async (request) => {
      if (request.messageId === 'slow') {
        start();
        await released;
      }
      return request.content;
    });
    const slow = routeInbound(event('slow'));
    // Wait for admission, not an arbitrary timer, before the following events.
    await started;
    const cancel = routeInbound(event('cancel', 'dm-1', 'Cancel that.'));
    try {
      await routeInbound(event('unrelated', 'dm-2', 'Hello.'));
      expect((await rows('ag-1', 'dm-2')).map(({ id }) => id)).toEqual(['unrelated:ag-1']);
      expect(await rows('ag-1')).toEqual([]);
    } finally {
      release();
      await Promise.all([slow, cancel]);
    }
    expect((await rows('ag-1')).map(({ id }) => id)).toEqual(['slow:ag-1', 'cancel:ag-1']);
  });

  it('lets the next message proceed after preparation rejects instead of poisoning the conversation queue', async () => {
    await seed('dm-1');
    prepare.mockRejectedValueOnce(new Error('module failed'));
    await expect(routeInbound(event('failed'))).rejects.toThrow('module failed');
    await routeInbound(event('next'));
    expect((await rows('ag-1')).map(({ id }) => id)).toEqual(['next:ag-1']);
  });

  it('uses only typed caption for admin commands when recognized speech starts with a slash', async () => {
    await seed('dm-1');
    prepare.mockImplementation(async ({ content }) => {
      const parsed = JSON.parse(content) as { attachments: Array<Record<string, unknown>> };
      parsed.attachments[0].speech = { status: 'recognized', text: '/clear', language: 'en' };
      return JSON.stringify(parsed);
    });
    await routeInbound(event('spoken-command'));
    expect(await rows('ag-1')).toHaveLength(1);
    expect(requestWake).toHaveBeenCalledTimes(1);
  });

  it('rejects a partial fan-out storage failure and retries only the target that has no source row', async () => {
    await seed('dm-1', ['ag-1', 'ag-2']);
    const write = sessionManager.writeSessionMessage;
    let failSecond = true;
    vi.spyOn(sessionManager, 'writeSessionMessage').mockImplementation(async (...args) => {
      if (args[0] === 'ag-2' && failSecond) {
        failSecond = false;
        throw new Error('mailbox unavailable');
      }
      return write(...args);
    });
    const source = event('partial');
    await expect(routeInbound(source)).rejects.toThrow('mailbox unavailable');
    expect((await rows('ag-1')).map(({ id }) => id)).toEqual(['partial:ag-1']);
    await routeInbound(source);
    expect((await rows('ag-1')).map(({ id }) => id)).toEqual(['partial:ag-1']);
    expect((await rows('ag-2')).map(({ id }) => id)).toEqual(['partial:ag-2']);
    expect(requestWake).toHaveBeenCalledTimes(2);
    expect(fanInboundMessage).toHaveBeenCalledTimes(2);
  });
});
