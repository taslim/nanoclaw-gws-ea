import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { parseIsoTimestamp } from '../model.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from './index.js';

describe('SQLite mailbox canonical serialization', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('round-trips full lifecycle records through the SQLite adapter', async () => {
    const inboundDb = new Database(':memory:');
    const outboundDb = new Database(':memory:');
    databases.push(inboundDb, outboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    outboundDb.exec(OUTBOUND_SCHEMA);
    let sequence = 0;
    const nextSequence = () => (sequence += 2);
    const inbound = wrapSqliteInbound(inboundDb, nextSequence);
    const outbound = wrapSqliteOutbound(
      () => outboundDb,
      () => outboundDb,
      nextSequence,
    );

    await inbound.insertMessage({
      id: 'in-1',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:00.000Z',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{"text":"hello"}',
      processAfter: '2026-01-01T00:00:01.000Z',
      recurrence: '0 * * * *',
      trigger: false,
      sourceSessionId: 'source-session',
      onWake: true,
    });
    expect(inboundDb.prepare('SELECT * FROM messages_in WHERE id = ?').get('in-1')).toMatchObject({
      id: 'in-1',
      seq: 2,
      kind: 'chat',
      timestamp: '2026-01-01T00:00:00.000Z',
      status: 'pending',
      process_after: '2026-01-01T00:00:01.000Z',
      recurrence: '0 * * * *',
      series_id: 'in-1',
      tries: 0,
      trigger: 0,
      platform_id: 'room',
      channel_type: 'test',
      thread_id: 'thread',
      content: '{"text":"hello"}',
      source_session_id: 'source-session',
      on_wake: 1,
    });

    await inbound.insertTask({
      id: 'task-1',
      seriesId: 'series-1',
      processAfter: '2999-01-01T00:00:00.000Z',
      recurrence: null,
      content: '{"prompt":"later"}',
      status: 'paused',
    });
    inboundDb
      .prepare('UPDATE messages_in SET timestamp = ?, process_after = ? WHERE id = ?')
      .run('2026-01-01 00:00:00', '2999-01-01 00:00:00', 'task-1');
    expect(inbound.getTask('task-1')).toMatchObject({
      id: 'task-1',
      seriesId: 'series-1',
      status: 'paused',
      processAfter: '2999-01-01T00:00:00.000Z',
      recurrence: null,
      content: '{"prompt":"later"}',
      timestamp: '2026-01-01T00:00:00.000Z',
      tries: 0,
      sequence: 4,
    });

    outboundDb
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('in-1', 'completed', '2026-01-01 00:00:00');
    expect(outbound.getTerminalProcessingAcks()).toEqual([
      {
        messageId: 'in-1',
        status: 'completed',
        statusChanged: '2026-01-01T00:00:00.000Z',
      },
    ]);

    outboundDb
      .prepare(
        `INSERT INTO container_state
           (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
         VALUES (1, ?, ?, ?, ?)`,
      )
      .run('Bash', 30_000, '2026-01-01 00:00:00', '2026-01-01 00:00:01');
    expect(outbound.getContainerState()).toEqual({
      currentTool: 'Bash',
      toolDeclaredTimeoutMs: 30_000,
      toolStartedAt: '2026-01-01T00:00:00.000Z',
    });

    await outbound.writeDirect({
      id: 'out-1',
      kind: 'chat',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{"text":"reply"}',
    });
    expect(outbound.getDueMessages()).toEqual([
      {
        id: 'out-1',
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"reply"}',
        inReplyTo: null,
      },
    ]);
  });

  it('returns only the conversation root and top-level outbound timeline', () => {
    const inboundDb = new Database(':memory:');
    const outboundDb = new Database(':memory:');
    databases.push(inboundDb, outboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    outboundDb.exec(OUTBOUND_SCHEMA);
    inboundDb
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, kind, channel_type, content, trigger)
         VALUES (?, ?, ?, 'chat', ?, ?, 1)`,
      )
      .run('echo', 2, '2026-01-01T00:00:00.000Z', 'session-echo', '{"text":"ambient"}');
    inboundDb
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, kind, channel_type, content, trigger)
         VALUES (?, ?, ?, 'chat', ?, ?, 1)`,
      )
      .run('root', 4, '2026-01-01T00:00:01.000Z', 'slack', '{"text":"root"}');
    outboundDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, channel_type, thread_id, content)
         VALUES (?, ?, ?, ?, 'slack', ?, ?)`,
      )
      .run('system', 1, '2026-01-01T00:00:02.000Z', 'system', null, '{"text":"hidden"}');
    outboundDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, channel_type, thread_id, content)
         VALUES (?, ?, ?, 'chat', 'slack', ?, ?)`,
      )
      .run('reply', 3, '2026-01-01T00:00:03.000Z', 'thread:reply', '{"text":"thread reply"}');
    outboundDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, channel_type, thread_id, content)
         VALUES (?, ?, ?, 'chat', 'slack', NULL, ?)`,
      )
      .run('top', 5, '2026-01-01T00:00:04.000Z', '{"text":"top level"}');

    expect(wrapSqliteInbound(inboundDb).getConversationRoot()).toEqual({
      timestamp: '2026-01-01T00:00:01.000Z',
      content: '{"text":"root"}',
    });
    expect(wrapSqliteOutbound(outboundDb).getTopLevelOutbound(10)).toEqual([
      { timestamp: '2026-01-01T00:00:04.000Z', content: '{"text":"top level"}' },
    ]);
  });

  it("reads the runner's turn stamp: the ids of every message the current turn answers", () => {
    const outboundDb = new Database(':memory:');
    databases.push(outboundDb);
    outboundDb.exec(OUTBOUND_SCHEMA);
    const outbound = wrapSqliteOutbound(outboundDb);
    const stamp = (value: string) =>
      outboundDb
        .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run('current_reply_route', value, '2026-01-01T00:00:00.000Z');

    expect(outbound.getTurnStamp()).toBeNull();
    // As container/agent-runner/src/db/session-state.ts publishes it.
    stamp(
      JSON.stringify({
        inReplyTo: 'in-1',
        channelType: 'gchat',
        platformId: 'spaces/dm',
        threadId: null,
        messageIds: ['in-1', 'in-2'],
      }),
    );
    expect(outbound.getTurnStamp()).toEqual({ messageIds: ['in-1', 'in-2'] });

    // A stamp without its ids names no message.
    for (const value of [
      JSON.stringify({ inReplyTo: 'in-1', channelType: 'gchat', platformId: 'spaces/dm', threadId: null }),
      JSON.stringify({ inReplyTo: 'in-1', messageIds: ['in-1', 7] }),
      'not json',
    ]) {
      stamp(value);
      expect(outbound.getTurnStamp(), value).toBeNull();
    }
  });

  it('reads where one inbound message came from, by its id', async () => {
    const inboundDb = new Database(':memory:');
    databases.push(inboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    const inbound = wrapSqliteInbound(inboundDb);
    await inbound.insertMessage({
      id: 'in-1',
      kind: 'chat-sdk',
      timestamp: '2026-01-01T00:00:00.000Z',
      platformId: 'spaces/dm',
      channelType: 'gchat',
      threadId: null,
      content: '{"senderId":"users/1","text":"hello"}',
      processAfter: null,
      recurrence: null,
    });

    expect(inbound.getInboundOrigin('in-1')).toEqual({
      kind: 'chat-sdk',
      channelType: 'gchat',
      platformId: 'spaces/dm',
      content: '{"senderId":"users/1","text":"hello"}',
    });
    expect(inbound.getInboundOrigin('in-missing')).toBeUndefined();
  });

  it('lists the pending messages still waiting for their time, soonest first, with their tries', async () => {
    const inboundDb = new Database(':memory:');
    databases.push(inboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    const inbound = wrapSqliteInbound(inboundDb);
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const write = (id: string, processAfter: string | null = null) =>
      inbound.insertMessage({
        id,
        kind: 'chat',
        timestamp: at(0),
        platformId: null,
        channelType: null,
        threadId: null,
        content: '{}',
        processAfter,
        recurrence: null,
      });
    const later = at(2 * 60 * 60 * 1000);
    const soon = at(5 * 60 * 1000);
    await write('now');
    await write('due', at(-1000));
    await write('later', later);
    await write('soon', soon);
    await write('handled', at(60 * 60 * 1000));
    inbound.applyProcessingAcks([
      { messageId: 'handled', status: 'completed', statusChanged: parseIsoTimestamp(at(0)) },
    ]);
    await write('retried');
    inbound.retryWithBackoff('retried', 30);

    expect(inbound.getWaitingMessages()).toEqual([
      { id: 'retried', tries: 1, processAfter: expect.any(String) },
      { id: 'soon', tries: 0, processAfter: soon },
      { id: 'later', tries: 0, processAfter: later },
    ]);
  });
});
