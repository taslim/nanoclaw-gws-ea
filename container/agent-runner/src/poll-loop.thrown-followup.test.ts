import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getCurrentReplyRoute, getContinuation, setContinuation } from './db/session-state.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, ProviderEvent, ProviderExchange } from './providers/types.js';

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;
const DIAGNOSTIC = 'Private native provider diagnostic';

function insertMessage(id: string, threadId: string, kind = 'chat', text = id): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, ?, 'pending', 1, 'channel-1', 'slack', ?, ?)`,
    )
    .run(id, kind, new Date().toISOString(), threadId, JSON.stringify({ text, prompt: text }));
}

function visibleRows() {
  return getUndeliveredMessages().filter((row) => row.kind === 'chat');
}

/** The thread of each failed turn the runner reported to the host, in order. */
function failedTurnThreads(): Array<string | null> {
  return getUndeliveredMessages()
    .filter((row) => row.kind === 'system')
    .map((row) => {
      const report = JSON.parse(row.content) as {
        action: string;
        channelType: string;
        platformId: string;
        threadId: string | null;
      };
      expect(report).toMatchObject({ action: 'turn_failed', channelType: 'slack', platformId: 'channel-1' });
      return report.threadId;
    });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for provider progress');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
     VALUES ('main', 'Main', 'channel', 'slack', 'channel-1')`,
  );
});
afterEach(() => closeSessionDb());

async function runFailure(
  events: (pushes: string[], controller: AbortController) => AsyncGenerator<ProviderEvent>,
  initialKind = 'chat',
) {
  insertMessage('request-a', 'thread-a', initialKind);
  setContinuation('mock', 'previous-session');
  const controller = new AbortController();
  const pushes: string[] = [];
  const exchanges: ProviderExchange[] = [];
  let recovered: unknown;
  const provider: AgentProvider = {
    registerMemorySessionHook: () => {},
    isSessionInvalid: (error) => {
      recovered = error;
      return true;
    },
    onExchangeComplete: (exchange) => {
      exchanges.push(exchange);
      if (exchange.status === 'error') controller.abort();
    },
    query: () => ({
      events: events(pushes, controller),
      push: (prompt) => pushes.push(prompt),
      end: () => {},
      abort: () => {},
    }),
  };
  await runPollLoop({
    provider,
    providerContract: CONTRACT,
    providerName: 'mock',
    cwd: '/workspace/agent',
    signal: controller.signal,
  });
  expect(recovered).toBeInstanceOf(Error);
  expect((recovered as Error).message).toBe(DIAGNOSTIC);
  expect(getContinuation('mock')).toBeUndefined();
  expect(exchanges.at(-1)?.status).toBe('error');
  expect(exchanges.at(-1)?.result).toContain(DIAGNOSTIC);
  expect(getPendingMessages()).toEqual([]);
  expect(
    visibleRows()
      .map((row) => row.content)
      .join('\n'),
  ).not.toContain(DIAGNOSTIC);
  return recovered;
}

describe('provider throws with active or queued turns', () => {
  it('reports the unfinished follow-up at its own route, leaving the completed opening turn alone', async () => {
    await runFailure(async function* (pushes) {
      yield { type: 'text', text: '<message to="main">Answered A</message>' };
      yield { type: 'result', text: '' };
      insertMessage('request-b', 'thread-b');
      await waitFor(() => pushes.length === 1);
      expect(getCurrentReplyRoute()?.inReplyTo).toBe('request-b');
      throw new Error(DIAGNOSTIC);
    });
    expect(visibleRows().map((row) => [JSON.parse(row.content).text, row.thread_id, row.in_reply_to])).toEqual([
      ['Answered A', 'thread-a', 'request-a'],
    ]);
    expect(failedTurnThreads()).toEqual(['thread-b']);
  });

  it('preserves a partial answer and reports every abandoned route once, including still-queued turns', async () => {
    await runFailure(async function* (pushes) {
      yield { type: 'text', text: '<message to="main">Partial A</message>' };
      for (const [index, [id, thread]] of [
        ['request-b', 'thread-b'],
        ['request-c', 'thread-b'],
        ['request-d', 'thread-d'],
      ].entries()) {
        insertMessage(id, thread);
        await waitFor(() => pushes.length === index + 1);
      }
      expect(getCurrentReplyRoute()?.inReplyTo).toBe('request-a');
      throw new Error(DIAGNOSTIC);
    });
    expect(visibleRows().map((row) => [JSON.parse(row.content).text, row.thread_id])).toEqual([
      ['Partial A', 'thread-a'],
    ]);
    expect(failedTurnThreads()).toEqual(['thread-a', 'thread-b', 'thread-d']);
  });

  it('reports no failed turn after both turns completed', async () => {
    await runFailure(async function* (pushes) {
      yield { type: 'text', text: '<message to="main">Answered A</message>' };
      yield { type: 'result', text: '' };
      insertMessage('request-b', 'thread-b');
      await waitFor(() => pushes.length === 1);
      yield { type: 'text', text: '<message to="main">Answered B</message>' };
      yield { type: 'result', text: '' };
      throw new Error(DIAGNOSTIC);
    });
    expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Answered A', 'Answered B']);
    expect(failedTurnThreads()).toEqual([]);
  });

  it('masks an initial provider throw before any result', async () => {
    await runFailure(async function* () {
      throw new Error(DIAGNOSTIC);
    });
    expect(visibleRows()).toEqual([]);
    expect(failedTurnThreads()).toEqual(['thread-a']);
  });

  it('does not turn a task-session throw into unsolicited chat', async () => {
    await runFailure(async function* () {
      throw new Error(DIAGNOSTIC);
    }, 'task');
    expect(visibleRows()).toEqual([]);
    expect(failedTurnThreads()).toEqual([]);
  });

  it('reports no failed turn when the active query was explicitly cancelled', async () => {
    await runFailure(async function* (_pushes, controller) {
      controller.abort();
      throw new Error(DIAGNOSTIC);
    });
    expect(visibleRows()).toEqual([]);
    expect(failedTurnThreads()).toEqual([]);
  });
});

it('does not report slash-command cancellation as a provider failure', async () => {
  insertMessage('request-a', 'thread-a');
  const controller = new AbortController();
  let release: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exchanges: ProviderExchange[] = [];
  const provider: AgentProvider = {
    registerMemorySessionHook: () => {},
    isSessionInvalid: () => false,
    onExchangeComplete: (exchange) => exchanges.push(exchange),
    query: () => ({
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'cancel-session' };
        insertMessage('clear-command', 'thread-b', 'chat', '/clear');
        await aborted;
        throw new Error(DIAGNOSTIC);
      })(),
      push: () => {},
      end: () => {},
      abort: release,
    }),
  };
  const loop = runPollLoop({
    provider,
    providerContract: CONTRACT,
    providerName: 'mock',
    cwd: '/workspace/agent',
    signal: controller.signal,
  });
  try {
    await waitFor(() => visibleRows().some((row) => JSON.parse(row.content).text === 'Session cleared.'));
  } finally {
    controller.abort();
    await loop;
  }
  expect(exchanges.at(-1)?.result).toContain(DIAGNOSTIC);
  expect(visibleRows().map((row) => [JSON.parse(row.content).text, row.thread_id])).toEqual([
    ['Session cleared.', 'thread-b'],
  ]);
  expect(failedTurnThreads()).toEqual([]);
});

it('preserves the provider error for recovery when one report write rejects, and still reports the next route', async () => {
  const failure = new Error(DIAGNOSTIC);
  const write = spyOn(getAgentMailbox().operations, 'writeMessageOut').mockRejectedValueOnce(
    new Error('Mailbox report write rejected'),
  );
  try {
    const recovered = await runFailure(async function* (pushes) {
      insertMessage('request-b', 'thread-b');
      await waitFor(() => pushes.length === 1);
      throw failure;
    });
    expect(recovered).toBe(failure);
    expect(write).toHaveBeenCalledTimes(2);
    expect(visibleRows()).toEqual([]);
    expect(failedTurnThreads()).toEqual(['thread-b']);
  } finally {
    write.mockRestore();
  }
});
