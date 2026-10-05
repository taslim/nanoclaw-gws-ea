/**
 * The reminder tools: each agent comes back to its own conversation at a
 * time it chooses, through a typed request the host answers once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { clearReminder, REMINDER_REQUEST_TIMEOUT_MS, remindMe } from './reminders.js';
import type { McpToolDefinition } from './types.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

async function answerNext(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  const request = JSON.parse(row.content) as Record<string, unknown>;
  const requestId = String(request.requestId);
  getInboundDb()
    .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
    .run(
      `action-resp-${requestId}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({ type: 'action_response', requestId, frame: { id: requestId, ok: true, data } }),
    );
  return request;
}

function text(result: { readonly content: readonly unknown[] }): string {
  return (result.content[0] as { readonly text: string }).text;
}

describe('the reminder tools', () => {
  it('set a reminder with its time and note, and return the host’s answer', async () => {
    const args = { at: '2026-10-09T09:00:00-07:00', note: 'Remy has not picked a time: nudge once, kindly.' };
    const [result, request] = await Promise.all([
      remindMe.handler(args),
      answerNext({ reminder_id: 'reminder-act-1', message: 'Reminder reminder-act-1 is set for Friday at 9am.' }),
    ]);
    expect(request).toMatchObject({ action: 'remind_me', ...args });
    expect(text(result)).toBe('Reminder reminder-act-1 is set for Friday at 9am.');
  });

  it('clear one by its id', async () => {
    const [result, request] = await Promise.all([
      clearReminder.handler({ reminder_id: 'reminder-act-1' }),
      answerNext({ reminder_id: 'reminder-act-1', message: 'Reminder reminder-act-1 is cleared.' }),
    ]);
    expect(request).toMatchObject({ action: 'clear_reminder', reminder_id: 'reminder-act-1' });
    expect(text(result)).toBe('Reminder reminder-act-1 is cleared.');
  });

  it('refuse a call missing what it needs, sending nothing', async () => {
    for (const [tool, args, problem] of [
      [remindMe, { note: 'Nudge.' }, /at is required/],
      [remindMe, { at: '2026-10-09T09:00:00-07:00' }, /note is required/],
      [clearReminder, {}, /reminder_id is required/],
    ] as const) {
      expect(text(await tool.handler(args)), tool.tool.name).toMatch(problem);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('say a reminder that timed out must not be set again, and a clear may be repeated', async () => {
    async function timedOut(tool: McpToolDefinition, args: Record<string, unknown>) {
      const realNow = Date.now;
      const start = realNow();
      let calls = 0;
      Date.now = () => start + calls++ * REMINDER_REQUEST_TIMEOUT_MS;
      try {
        return await tool.handler(args);
      } finally {
        Date.now = realNow;
      }
    }
    expect(text(await timedOut(remindMe, { at: '2026-10-09T09:00:00-07:00', note: 'Nudge.' }))).toMatch(
      /do not send it again/,
    );
    expect(text(await timedOut(clearReminder, { reminder_id: 'reminder-act-1' }))).toMatch(
      /a repeat changes nothing twice/,
    );
  });

  it('describe each tool in under 60 words', () => {
    for (const tool of [remindMe, clearReminder]) {
      const words = (tool.tool.description ?? '').split(/\s+/u).filter(Boolean).length;
      expect(words, tool.tool.name).toBeLessThan(60);
    }
  });

  it('tell the agent how far ahead a reminder may be: a year, as the host allows', () => {
    expect(remindMe.tool.description).toContain('up to a year ahead');
  });
});
