/**
 * main's three calendar writes, through the host: `create_event`,
 * `change_guests` and `respond_to_event` send a typed request the host
 * answers once, carrying the fields exactly as the agent gave them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { CALENDAR_REQUEST_TIMEOUT_MS, changeGuests, createEvent, respondToEvent } from './calendar-write.js';
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
      matter: 'm-1a2b3c4d5e6f',
    };
    const [result, request] = await Promise.all([
      createEvent.handler(args),
      answerNext({ event: 'abc123', message: 'Added "Weekly sync" to morgan@northwind.example.' }),
    ]);
    expect(request).toMatchObject({ action: 'create_event', ...args });
    expect(text(result)).toBe('Added "Weekly sync" to morgan@northwind.example.');
  });

  it('change who an event invites', async () => {
    const args = {
      calendar: 'morgan@northwind.example',
      event: 'abc123',
      add: ['noel@friends.example'],
      matter: 'm-1a2b3c4d5e6f',
    };
    const [result, request] = await Promise.all([
      changeGuests.handler(args),
      answerNext({ guests: ['noel@friends.example'], message: 'Its guests now: noel@friends.example.' }),
    ]);
    expect(request).toMatchObject({ action: 'change_guests', ...args });
    expect(text(result)).toBe('Its guests now: noel@friends.example.');
  });

  it("set the principal's answer on an event", async () => {
    const args = {
      calendar: 'morgan@northwind.example',
      event: 'abc123_20261012T160000Z',
      response: 'accepted',
      matter: 'm-1a2b3c4d5e6f',
    };
    const [result, request] = await Promise.all([
      respondToEvent.handler(args),
      answerNext({ response: 'accepted', message: 'Google now shows the principal as going (accepted).' }),
    ]);
    expect(request).toMatchObject({ action: 'respond_to_event', ...args });
    expect(text(result)).toBe('Google now shows the principal as going (accepted).');
  });

  it("offer main only the principal's three answers, for both an invitation and their own event a move reset", () => {
    expect(respondToEvent.tool.inputSchema.properties?.response).toMatchObject({
      enum: ['accepted', 'tentative', 'declined'],
    });
    // Main learns from the description alone that the tool also restores an answer a move reset.
    expect(respondToEvent.tool.description).toContain(
      'an event they organize after someone else moved it and Google reset their answer',
    );
  });

  it('tell main it may write on its own calendar, where the principal is a guest only when invited and others may see its details', () => {
    const create = createEvent.tool.description ?? '';
    expect(create).toStartWith("Put an event on one of the principal's calendars or on your own.");
    expect(create).toContain(
      'the principal is a guest, and the event takes their time, only if you name them in guests',
    );
    expect(create).toContain(
      'anyone your calendar is shared with, colleagues in a company Workspace among them, sees its details unless it is private',
    );
    expect(createEvent.tool.inputSchema.properties?.calendar).toMatchObject({
      description: expect.stringContaining('or your own address for yours'),
    });
    expect(changeGuests.tool.description).toStartWith(
      'Invite people to an event the principal organizes or one you organize on your own calendar',
    );
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
      [respondToEvent, { event: 'abc123', response: 'accepted' }, /calendar is required/],
      [respondToEvent, { calendar: 'morgan@northwind.example', response: 'accepted' }, /event is required/],
      [respondToEvent, { calendar: 'morgan@northwind.example', event: 'abc123' }, /response is required/],
    ] as const) {
      expect(text(await tool.handler(args)), tool.tool.name).toMatch(problem);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('say an event that timed out must not be created again, and a guest change or an answer may be repeated', async () => {
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
    expect(
      text(
        await timedOut(respondToEvent, {
          calendar: 'morgan@northwind.example',
          event: 'abc123',
          response: 'declined',
        }),
      ),
    ).toMatch(/a repeat changes nothing twice/);
  });
});
