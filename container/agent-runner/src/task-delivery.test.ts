/**
 * One-door delivery in task sessions, and a task that comes back as a turn of
 * a conversation.
 *
 * Every outbound tool call names its destination. In a task run, final output
 * is inert delivery-wise and becomes the automatic run summary instead. A task
 * created to come back to its conversation is a turn of it: its blocks deliver
 * and nothing is logged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { sendFile, sendMessage } from './mcp-tools/core.js';
import {
  autoAppendTaskLog,
  buildTaskBlockNudge,
  dispatchResultText,
  processQuery,
  runPollLoop,
  shouldNudgeTaskBlocks,
} from './poll-loop.js';
import { extractRouting, type RoutingContext } from './formatter.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import { seedSessionRouting } from './test-utils/session-routing.js';

function seedDestination(name = 'family', channelType = 'telegram', platformId = 'telegram:99'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

const taskRouting: RoutingContext = {
  platformId: 'ag-1',
  channelType: 'agent',
  threadId: 'system:tasks:daily-digest-a1b2',
  inReplyTo: 'run-1',
  taskRun: true,
};

beforeEach(() => {
  initTestSessionDb();
  seedDestination();
});

afterEach(() => {
  closeSessionDb();
});

describe('explicit outbound destinations', () => {
  it('derives task mode from the canonical per-series thread without a DB migration', () => {
    seedSessionRouting(null, null, 'system:tasks:daily-digest-a1b2');
    expect(getTaskSeriesId()).toBe('daily-digest-a1b2');

    seedSessionRouting('telegram', 'telegram:99', 'chat-thread');
    expect(getTaskSeriesId()).toBeNull();
  });

  it('requires `to` in both outbound tool schemas', () => {
    expect(sendMessage.tool.inputSchema.required).toContain('to');
    expect(sendFile.tool.inputSchema.required).toContain('to');
  });

  it('never infers the only destination when `to` is omitted', async () => {
    const messageResult = (await sendMessage.handler({ text: 'hello' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const fileResult = (await sendFile.handler({ path: 'report.txt' })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    for (const result of [messageResult, fileResult]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('to is required');
      expect(result.content[0].text).toContain('family');
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects an unknown explicit destination without falling back', async () => {
    const messageResult = (await sendMessage.handler({ to: 'missing', text: 'hello' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const fileResult = (await sendFile.handler({ to: 'missing', path: 'report.txt' })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    for (const result of [messageResult, fileResult]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown destination "missing"');
      expect(result.content[0].text).toContain('Known: family');
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('delivers to the explicitly named destination', async () => {
    seedSessionRouting(null, null, 'system:tasks:daily-digest-a1b2');

    await sendMessage.handler({ to: 'family', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('telegram:99');
  });
});

describe('final-output blocks in a task run', () => {
  it('keeps them inert and returns their destination and content for correction', async () => {
    const { sent, hasUnwrapped, taskBlocks } = await dispatchResultText(
      '<message to="family">digest is ready</message>',
      taskRouting,
    );

    expect(sent).toBe(0);
    expect(hasUnwrapped).toBe(false);
    expect(taskBlocks).toEqual([{ to: 'family', body: 'digest is ready' }]);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('still delivers final-output blocks in chat sessions', async () => {
    const { sent, taskBlocks } = await dispatchResultText('<message to="family">hi</message>', {
      ...taskRouting,
      taskRun: false,
    });

    expect(sent).toBe(1);
    expect(taskBlocks).toEqual([]);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it("threads a chat-session block from the batch being answered, not the channel's latest row", async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
         VALUES ('in-2', 4, 'chat', ?, 'completed', 'telegram:99', 'telegram', 'T-later', '{}')`,
      )
      .run(new Date().toISOString());

    await dispatchResultText('<message to="family">hi</message>', {
      platformId: 'telegram:99',
      channelType: 'telegram',
      threadId: 'T-batch',
      inReplyTo: 'in-1',
      taskRun: false,
    });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('T-batch');
    expect(out[0].in_reply_to).toBe('in-1');
  });

  it('nudges at most once and only when a task result contains inert blocks', () => {
    const blocks = [{ to: 'family', body: 'digest' }];
    expect(shouldNudgeTaskBlocks(true, blocks, false)).toBe(true);
    expect(shouldNudgeTaskBlocks(true, blocks, true)).toBe(false);
    expect(shouldNudgeTaskBlocks(true, [], false)).toBe(false);
    expect(shouldNudgeTaskBlocks(false, blocks, false)).toBe(false);
  });

  it('shows the exact content and makes re-send conditional', () => {
    const nudge = buildTaskBlockNudge([{ to: 'family', body: '3 <new> posts & a warning' }], 'family, ops');

    expect(nudge).toContain('to="family"');
    expect(nudge).toContain('3 &lt;new&gt; posts &amp; a warning');
    expect(nudge).toContain('If and only if');
    expect(nudge).toContain('do not send it again');
    expect(nudge).not.toContain('Re-send now');
  });

  it('records the original task result once, not the correction retry', async () => {
    let nudged = false;
    const original = '<message to="family">digest</message>';
    const first = await dispatchResultText(original, taskRouting);
    if (!nudged) await autoAppendTaskLog(original);
    nudged = shouldNudgeTaskBlocks(true, first.taskBlocks, nudged);

    const retry = await dispatchResultText('Delivery decision handled.', taskRouting);
    if (!nudged) await autoAppendTaskLog('Delivery decision handled.');
    expect(shouldNudgeTaskBlocks(true, retry.taskBlocks, nudged)).toBe(false);

    const rows = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as {
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toContain('[undelivered → family] digest');
  });
});

describe('automatic task run summary', () => {
  it('writes a task_log row from final text', async () => {
    await autoAppendTaskLog('Checked  the\nfeeds — nothing new.');

    const rows = getOutboundDb().prepare("SELECT kind, content FROM messages_out WHERE kind = 'task_log'").all() as {
      kind: string;
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Checked the feeds — nothing new.');
  });

  it('marks legacy final-output blocks undelivered and never stores raw XML', async () => {
    await autoAppendTaskLog('Digest done. <message to="family">3 new posts today</message> See you tomorrow.');

    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").get() as {
      content: string;
    };
    const line = JSON.parse(row.content).text as string;
    expect(line).not.toContain('<message');
    expect(line).toContain('[undelivered → family] 3 new posts today');
    expect(line).toContain('Digest done.');
  });

  it('is additive to an explicit append-log request', async () => {
    await writeMessageOut({
      id: 'cli-progress',
      kind: 'system',
      content: JSON.stringify({
        action: 'cli_request',
        requestId: 'cli-progress',
        command: 'tasks-append-log',
        args: { msg: 'progress note' },
      }),
    });

    await autoAppendTaskLog('final summary');

    expect(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'task_log'").all()).toHaveLength(1);
  });
});

describe('a scheduled task in a conversation', () => {
  const LOOK = '<message to="principal">Juno Hale confirmed the venue for Thursday.</message>';
  /** A task's content as the host writes it for `ncl tasks create --in-conversation`. */
  const COMES_BACK = { prompt: 'Check whether the venue confirmed', inConversation: true };

  /** The conversation the agent has with the principal, as the host binds it on a wake. */
  function seedConversation(): void {
    seedSessionRouting('gchat', 'gchat:spaces/dm', null);
    seedDestination('principal', 'gchat', 'gchat:spaces/dm');
  }

  /** A task row as the host writes it: no route of its own, unless v1 migration ported it with its chat's. */
  function insertTask(
    id: string,
    content: object | string,
    row: { seq?: number; channelType?: string; platformId?: string } = {},
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, series_id, platform_id, channel_type, content)
         VALUES (?, ?, 'task', ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.seq ?? 2,
        new Date().toISOString(),
        id,
        row.platformId ?? null,
        row.channelType ?? null,
        typeof content === 'string' ? content : JSON.stringify(content),
      );
  }

  function taskLogRows(): Array<{ text: string }> {
    return (
      getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as Array<{
        content: string;
      }>
    ).map((row) => JSON.parse(row.content) as { text: string });
  }

  function ackStatus(id: string): string | undefined {
    return (
      getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
        | { status: string }
        | undefined
    )?.status;
  }

  /** Run the real poll loop until `done` holds, then stop it. */
  async function runLoopUntil(provider: MockProvider, done: () => boolean): Promise<void> {
    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal }).catch(
      () => {},
    );
    const deadline = Date.now() + 5000;
    while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await loop;
  }

  function resultQuery(result: ProviderEvent): AgentQuery {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'look-session' };
      yield result;
    }
    return { push: () => {}, end: () => {}, abort: () => {}, events: events() };
  }

  it('is a turn only when every task in the batch was created to come back to the conversation', () => {
    seedConversation();
    insertTask('look-a1b2', COMES_BACK);
    expect(extractRouting(getPendingMessages())).toMatchObject({ taskRun: false, tasksOnly: true });

    insertTask('digest-c3d4', { prompt: 'Send the daily digest' }, { seq: 4 });
    expect(extractRouting(getPendingMessages())).toMatchObject({ taskRun: true, tasksOnly: true });
  });

  it('runs a task whose content predates the JSON envelope in isolation', () => {
    seedConversation();
    insertTask('digest-c3d4', 'Send the daily digest');

    expect(extractRouting(getPendingMessages())).toMatchObject({ taskRun: true, tasksOnly: true });
  });

  it("delivers its <message> blocks to the conversation's route and writes no task_log", async () => {
    seedConversation();
    insertTask('look-a1b2', COMES_BACK);

    await runLoopUntil(new MockProvider({}, () => LOOK), () => getUndeliveredMessages().length > 0);

    const out = getUndeliveredMessages();
    expect(out.map((row) => [row.kind, row.channel_type, row.platform_id, JSON.parse(row.content).text])).toEqual([
      ['chat', 'gchat', 'gchat:spaces/dm', 'Juno Hale confirmed the venue for Thursday.'],
    ]);
    expect(out[0].in_reply_to).toBe('look-a1b2');
    expect(taskLogRows()).toEqual([]);
  });

  it('reports a failed turn for the host to place, and logs nothing', async () => {
    seedConversation();
    insertTask('look-a1b2', COMES_BACK);
    const rows = getPendingMessages();

    await processQuery(
      resultQuery({ type: 'result', text: '', isError: true, error: 'Incorrect API key' }),
      extractRouting(rows),
      rows.map((row) => row.id),
      'mock',
      undefined,
      'prompt',
      undefined,
    );

    expect(getUndeliveredMessages().map((row) => [row.kind, JSON.parse(row.content)])).toEqual([
      [
        'system',
        {
          action: 'turn_failed',
          channelType: null,
          platformId: null,
          threadId: null,
          error: 'Incorrect API key',
          batch: ['look-a1b2'],
        },
      ],
    ]);
    expect(taskLogRows()).toEqual([]);
  });

  it('in a task session of its own a task is still an isolated run: one-door delivery and a task_log', async () => {
    seedSessionRouting(null, null, 'system:tasks:look-a1b2');
    seedDestination('principal', 'gchat', 'gchat:spaces/dm');
    insertTask('look-a1b2', { prompt: 'Check whether the venue confirmed' });

    await runLoopUntil(new MockProvider({}, () => LOOK), () => taskLogRows().length > 0);

    expect(getUndeliveredMessages().filter((row) => row.kind === 'chat')).toEqual([]);
    expect(taskLogRows()).toEqual([{ text: '[undelivered → principal] Juno Hale confirmed the venue for Thursday.' }]);
  });

  it('completes without a turn when its pre-task script answers wakeAgent false', async () => {
    seedConversation();
    insertTask('look-a1b2', { ...COMES_BACK, script: `echo '{"wakeAgent": false}'` });
    const prompts: string[] = [];

    await runLoopUntil(
      new MockProvider({}, (prompt) => {
        prompts.push(prompt);
        return LOOK;
      }),
      () => ackStatus('look-a1b2') === 'completed',
    );

    expect(ackStatus('look-a1b2')).toBe('completed');
    expect(prompts).toEqual([]);
    expect(getUndeliveredMessages()).toEqual([]);
  });

  /**
   * v1 migration ports each task into its chat's shared session (no thread),
   * with the chat's route on the row. It never asked to come back as a turn,
   * so it runs in isolation there, as every task did before.
   */
  describe("in the chat's shared session a v1 task was ported to", () => {
    const DIGEST = '<message to="team">Three new posts today.</message>';
    const TEAM = { channelType: 'discord', platformId: 'discord:chan-1' };
    const PORTED = {
      prompt: 'Post the daily digest',
      script: null,
      migrated_from_v1: { original_id: 'digest', context_mode: 'group' },
    };

    beforeEach(() => {
      seedSessionRouting(TEAM.channelType, TEAM.platformId, null);
      seedDestination('team', TEAM.channelType, TEAM.platformId);
    });

    it('a ported task is still an isolated run: its blocks stay inert and its final text is logged', async () => {
      insertTask('digest', PORTED, TEAM);

      await runLoopUntil(new MockProvider({}, () => DIGEST), () => taskLogRows().length > 0);

      expect(getUndeliveredMessages().map((row) => [row.kind, JSON.parse(row.content)])).toEqual([
        ['task_log', { text: '[undelivered → team] Three new posts today.' }],
      ]);
    });

    it('a ported task that fails logs the failure and reports no failed turn', async () => {
      insertTask('digest', PORTED, TEAM);
      const rows = getPendingMessages();

      await processQuery(
        resultQuery({ type: 'result', text: 'The feed did not load.', isError: true, error: 'Incorrect API key' }),
        extractRouting(rows),
        rows.map((row) => row.id),
        'mock',
        undefined,
        'prompt',
        undefined,
      );

      expect(getUndeliveredMessages().map((row) => [row.kind, JSON.parse(row.content)])).toEqual([
        ['task_log', { text: 'The feed did not load. Incorrect API key' }],
      ]);
    });

    it('a task created to come back there is a turn: its blocks deliver and nothing is logged', async () => {
      insertTask('digest', { prompt: PORTED.prompt, script: null, inConversation: true });

      await runLoopUntil(new MockProvider({}, () => DIGEST), () => getUndeliveredMessages().length > 0);

      expect(getUndeliveredMessages().map((row) => [row.kind, row.platform_id, JSON.parse(row.content).text])).toEqual([
        ['chat', TEAM.platformId, 'Three new posts today.'],
      ]);
      expect(taskLogRows()).toEqual([]);
    });
  });
});
