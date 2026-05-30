/**
 * Tests for the `send_email` MCP tool — explicit two-mode contract (reply / compose).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { clearCurrentInReplyTo } from '../current-batch.js';
import { sendEmail } from './email.js';

beforeEach(() => {
  initTestSessionDb();
  const db = getInboundDb();
  db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('email-external', 'Email', 'channel', 'email', 'email:external:assistant@example.com', NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
  ).run();
  db.prepare(
    `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
     VALUES (1, 'email', 'email:external:assistant@example.com', 'thread-abc')`,
  ).run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('send_email — reply mode', () => {
  it('writes the agent-supplied thread_id to messages_out', async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'reply',
      thread_id: 'gmail-thread-xyz',
      text: 'thanks!',
    });
    expect('isError' in result && result.isError).toBeFalsy();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('gmail-thread-xyz');
  });

  it('preserves overrides (cc/recipients/subject) on the reply', async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'reply',
      thread_id: 'gmail-thread-xyz',
      text: 'override addressing but stay in thread',
      recipients: ['someone-new@example.com'],
      subject: 'Re: existing thread',
      cc: ['lawyer@x.com'],
    });
    expect('isError' in result && result.isError).toBeFalsy();

    const out = getUndeliveredMessages();
    expect(out[0].thread_id).toBe('gmail-thread-xyz');
    const content = JSON.parse(out[0].content) as { to?: string[]; subject?: string; cc?: string[] };
    expect(content.to).toEqual(['someone-new@example.com']);
    expect(content.subject).toBe('Re: existing thread');
    expect(content.cc).toEqual(['lawyer@x.com']);
  });

  it("ignores the session's bound thread — only the agent's thread_id matters", async () => {
    // session_routing.thread_id is 'thread-abc' but the agent passes 'override-thread'
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'reply',
      thread_id: 'override-thread',
      text: 'reply on the explicit thread',
    });
    expect('isError' in result && result.isError).toBeFalsy();
    expect(getUndeliveredMessages()[0].thread_id).toBe('override-thread');
  });

  it('rejects reply without thread_id with the procedural reminder', async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'reply',
      text: 'oops, forgot thread_id',
    });
    expect('isError' in result && result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/thread_id/);
    expect(text).toMatch(/email-triage/);
    expect(text).toMatch(/get_gmail_thread_content/);
    expect(text).toMatch(/matter/);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects reply with empty thread_id', async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'reply',
      thread_id: '',
      text: 'oops',
    });
    expect('isError' in result && result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('send_email — compose mode', () => {
  it('writes thread_id null when composing a new thread', async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'compose',
      text: 'starting fresh',
      recipients: ['fresh@example.com'],
      subject: 'New topic',
    });
    expect('isError' in result && result.isError).toBeFalsy();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBeNull();
  });

  it('ignores the session thread when composing', async () => {
    // session_routing.thread_id is 'thread-abc' but compose must always start fresh
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'compose',
      text: 'fresh',
      recipients: ['fresh@example.com'],
      subject: 'New topic',
    });
    expect('isError' in result && result.isError).toBeFalsy();
    expect(getUndeliveredMessages()[0].thread_id).toBeNull();
  });

  it('rejects compose without recipients', async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'compose',
      text: 'missing recipients',
      subject: 'Hello',
    });
    expect('isError' in result && result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/recipients/);
    expect(text).toMatch(/subject/);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects compose without subject', async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'compose',
      text: 'missing subject',
      recipients: ['x@y.com'],
    });
    expect('isError' in result && result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it("rejects compose with thread_id and points at 'reply'", async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'compose',
      thread_id: 'thread-abc',
      text: 'confused',
      recipients: ['x@y.com'],
      subject: 'huh',
    });
    expect('isError' in result && result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/intent: 'reply'/);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('send_email — schema validation', () => {
  it('rejects missing intent', async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      text: 'no intent',
    });
    expect('isError' in result && result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/intent/);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it("rejects invalid intent values like 'forward'", async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'forward',
      text: 'huh',
    });
    expect('isError' in result && result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/'reply'/);
    expect(text).toMatch(/'compose'/);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects non-email destinations', async () => {
    const result = await sendEmail.handler({
      to: 'peer',
      intent: 'compose',
      text: 'wrong tool',
      recipients: ['x@y.com'],
      subject: 's',
    });
    expect('isError' in result && result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/send_message/);
  });

  it('rejects missing text', async () => {
    const result = await sendEmail.handler({
      to: 'email-external',
      intent: 'compose',
      recipients: ['x@y.com'],
      subject: 's',
    });
    expect('isError' in result && result.isError).toBe(true);
  });
});
