/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message MCP tool — principal-surface guard (shim mode)', () => {
  beforeEach(() => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES
         ('principal', 'Principal', 'channel', 'gchat', 'gchat:dm:tas', NULL),
         ('heartbeat', 'Heartbeat', 'channel', 'gchat', 'gchat:space:hb', NULL)`,
    ).run();
  });

  it('shims an explicit to="principal" to priority="urgent"', async () => {
    const result = await sendMessage.handler({ to: 'principal', text: 'fyi' });
    expect('isError' in result && result.isError).toBeFalsy();
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe('urgent');
    expect(out[0].platform_id).toBe('gchat:dm:tas');
  });

  it('shims an explicit to="heartbeat" to priority="awareness"', async () => {
    const result = await sendMessage.handler({ to: 'heartbeat', text: 'log line' });
    expect('isError' in result && result.isError).toBeFalsy();
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBe('awareness');
    expect(out[0].platform_id).toBe('gchat:space:hb');
  });

  it('leaves an agent destination untouched (no priority)', async () => {
    const result = await sendMessage.handler({ to: 'peer', text: 'coordinate' });
    expect('isError' in result && result.isError).toBeFalsy();
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].priority).toBeNull();
  });
});

describe('send_message MCP tool — email destinations are blocked', () => {
  beforeEach(() => {
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('email-external', 'Email', 'channel', 'email', 'email:external:assistant@example.com', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'email', 'email:external:assistant@example.com', 'thread-abc')`,
    ).run();
  });

  it('rejects email destinations even when an inbound thread exists', async () => {
    const result = await sendMessage.handler({ to: 'email-external', text: 'thanks!' });
    expect('isError' in result && result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/<message/);
    expect(text).toMatch(/send_email/);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects email destinations when no inbound thread exists', async () => {
    getInboundDb().prepare('UPDATE session_routing SET thread_id = NULL WHERE id = 1').run();

    const result = await sendMessage.handler({ to: 'email-external', text: 'no context' });
    expect('isError' in result && result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
