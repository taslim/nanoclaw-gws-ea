/**
 * main's two calendar writes, through the host: `create_event` and
 * `change_guests` send a typed request the host answers once, carrying the
 * fields exactly as the agent gave them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { CALENDAR_REQUEST_TIMEOUT_MS, changeGuests, createEvent } from './calendar-write.js';
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

describe("main's calendar writes", () => {
  it('create an event with every field given, and return the host’s answer', async () => {
    const args = {
      calendar: 'morgan@northwind.example',
      title: 'Weekly sync',
      start: '2026-10-08T09:00:00-07:00',
      end: '2026-10-08T09:30:00-07:00',
      guests: ['remy@northwind.example'],
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
      video_call: true,
    };
    const [result, request] = await Promise.all([
      createEvent.handler(args),
      answerNext({ event: 'abc123', message: 'Added "Weekly sync" to morgan@northwind.example.' }),
    ]);
    expect(request).toMatchObject({ action: 'create_event', ...args });
    expect(text(result)).toBe('Added "Weekly sync" to morgan@northwind.example.');
  });

  it('change who an event invites', async () => {
    const args = { calendar: 'morgan@northwind.example', event: 'abc123', add: ['noel@friends.example'] };
    const [result, request] = await Promise.all([
      changeGuests.handler(args),
      answerNext({ guests: ['noel@friends.example'], message: 'Its guests now: noel@friends.example.' }),
    ]);
    expect(request).toMatchObject({ action: 'change_guests', ...args });
    expect(text(result)).toBe('Its guests now: noel@friends.example.');
  });

  it('refuse a call missing what it needs, sending nothing', async () => {
    for (const [tool, args, problem] of [
      [createEvent, { title: 'Focus', start: '2026-10-08', end: '2026-10-08' }, /calendar is required/],
      [
        createEvent,
        { calendar: 'morgan@northwind.example', start: '2026-10-08', end: '2026-10-08' },
        /title is required/,
      ],
      [changeGuests, { calendar: 'morgan@northwind.example' }, /event is required/],
    ] as const) {
      expect(text(await tool.handler(args)), tool.tool.name).toMatch(problem);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('say an event that timed out must not be created again, and a guest change may be repeated', async () => {
    async function timedOut(tool: McpToolDefinition, args: Record<string, unknown>) {
      const realNow = Date.now;
      const start = realNow();
      let calls = 0;
      Date.now = () => start + calls++ * CALENDAR_REQUEST_TIMEOUT_MS;
      try {
        return await tool.handler(args);
      } finally {
        Date.now = realNow;
      }
    }
    expect(
      text(
        await timedOut(createEvent, {
          calendar: 'morgan@northwind.example',
          title: 'Focus',
          start: '2026-10-08T09:00:00-07:00',
          end: '2026-10-08T10:00:00-07:00',
        }),
      ),
    ).toMatch(/do not send it again/);
    expect(
      text(
        await timedOut(changeGuests, { calendar: 'morgan@northwind.example', event: 'abc123', add: ['a@b.example'] }),
      ),
    ).toMatch(/a repeat changes nothing twice/);
  });

  it('tell the agent the principal stays on every event, accepted, and that Google emails no one', () => {
    for (const tool of [createEvent, changeGuests]) {
      expect(tool.tool.description, tool.tool.name).toMatch(/the principal (?:is always|stays) on/iu);
      expect(tool.tool.description, tool.tool.name).toContain('Google emails no one');
      const words = (tool.tool.description ?? '').split(/\s+/u).filter(Boolean).length;
      expect(words, tool.tool.name).toBeLessThan(60);
    }
  });
});
