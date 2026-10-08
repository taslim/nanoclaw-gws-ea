/**
 * The reply stamp names every message the current turn answers. The host
 * reads those ids from outbound.db to learn whose words started the turn
 * (principal provenance, src/modules/gws-ea-profile/provenance.ts), so the
 * stamp must follow each turn: the opening batch, a follow-up pushed into the
 * open query, one queued behind it, and a retry of an earlier turn.
 */
import { afterEach, beforeEach, expect, it } from 'bun:test';

import type { RoutingContext } from './formatter.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery, runPollLoop } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('dm', 'DM', 'channel', 'gchat', 'spaces/dm', NULL)`,
    )
    .run();
});
afterEach(closeSessionDb);

function insert(id: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 'spaces/dm', 'gchat', NULL, ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify({ text: `message ${id}` }));
}

/** The ids the stamp names, read as the host reads them: the raw row in outbound.db. */
function stampedIds(): unknown {
  const row = getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'current_reply_route'").get() as
    | { value: string }
    | undefined;
  return row === undefined ? undefined : (JSON.parse(row.value) as { messageIds?: unknown }).messageIds;
}

async function waitFor(test: () => boolean): Promise<void> {
  const until = Date.now() + 2500;
  while (!test()) {
    if (Date.now() > until) throw new Error('waitFor timeout');
    await Bun.sleep(10);
  }
}

const route = (id: string): RoutingContext => ({
  platformId: 'spaces/dm',
  channelType: 'gchat',
  threadId: null,
  inReplyTo: id,
  taskRun: false,
});
const block = (text: string) => `<message to="dm">${text}</message>`;

/** One answered turn, streamed then finished, as the provider emits it. */
function* answer(text: string): Generator<ProviderEvent> {
  yield { type: 'text', text: block(text) };
  yield { type: 'result', text: block(text) };
}

it('names every message of the opening batch', async () => {
  insert('m-1');
  insert('m-2');
  const seen: unknown[] = [];
  const provider = new MockProvider({}, () => {
    seen.push(stampedIds());
    return block('answer');
  });
  const controller = new AbortController();
  const loop = runPollLoop({
    provider,
    providerContract: CONTRACT,
    providerName: 'mock',
    cwd: '/tmp',
    signal: controller.signal,
  });
  await waitFor(() => seen.length === 1);
  controller.abort();
  await loop.catch(() => {});

  expect(seen).toEqual([['m-1', 'm-2']]);
});

it('names a follow-up when its turn starts, and the follow-up queued behind it when that turn starts', async () => {
  const pushed: string[] = [];
  const seen: unknown[] = [];
  const query: AgentQuery = {
    push: (prompt) => {
      pushed.push(prompt);
    },
    end() {},
    abort() {},
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        // The principal writes while the opening turn is still answering.
        insert('m-principal');
        await waitFor(() => pushed.length === 1);
        yield* answer('answer opening');
        seen.push(stampedIds());
        // A host note queues behind the principal's turn.
        insert('m-note');
        await waitFor(() => pushed.length === 2);
        seen.push(stampedIds());
        yield* answer('answer principal');
        seen.push(stampedIds());
        yield* answer('answer note');
      },
    },
  };
  await processQuery(query, route('m-opening'), ['m-opening'], 'mock', undefined, 'opening', undefined, true);

  expect(seen).toEqual([['m-principal'], ['m-principal'], ['m-note']]);
});

it('names a follow-up at once when the open query is idle', async () => {
  const pushed: string[] = [];
  let seen: unknown;
  const query: AgentQuery = {
    push: (prompt) => {
      pushed.push(prompt);
    },
    end() {},
    abort() {},
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        yield* answer('answer opening');
        insert('m-later');
        await waitFor(() => pushed.length === 1);
        seen = stampedIds();
        yield* answer('answer later');
      },
    },
  };
  await processQuery(query, route('m-opening'), ['m-opening'], 'mock', undefined, 'opening', undefined, true);

  expect(seen).toEqual(['m-later']);
});

it('names the retried turn’s messages while its retry is answered', async () => {
  const pushed: string[] = [];
  let seen: unknown;
  const query: AgentQuery = {
    push: (prompt) => {
      pushed.push(prompt);
    },
    end() {},
    abort() {},
    events: {
      async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
        yield { type: 'result', text: 'an answer without its message block' };
        expect(pushed).toHaveLength(1);
        seen = stampedIds();
        yield* answer('answer opening');
      },
    },
  };
  await processQuery(query, route('m-1'), ['m-1', 'm-2'], 'mock', undefined, 'opening', undefined, true);

  expect(seen).toEqual(['m-1', 'm-2']);
});
