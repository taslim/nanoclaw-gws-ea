/**
 * GWS-EA's email tools: main's handoff and email to the principal, and
 * external-email's email, word to main, and scheduling, each a typed request
 * the host answers with an `action_response`. A file goes with a request
 * staged in the outbox under the request's own id.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { requestAction } from '../action-request.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import {
  book,
  cancelBooking,
  EMAIL_REQUEST_TIMEOUT_MS,
  emailHandoff,
  emailSend,
  emailToPrincipal,
  freeTime,
  hold,
  moveBooking,
  tellMain,
} from './gws-ea-email.js';
import { requestStatus } from './request-status.js';
import type { McpToolDefinition } from './types.js';

const ALL_TOOLS = [
  emailHandoff,
  emailToPrincipal,
  emailSend,
  tellMain,
  freeTime,
  hold,
  book,
  moveBooking,
  cancelBooking,
];

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

/** The host's answer, written the way delivery writes it, to a request already sent. */
function answer(requestId: string, frame: unknown): void {
  getInboundDb()
    .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
    .run(
      `action-resp-${requestId}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({ type: 'action_response', requestId, frame }),
    );
}

/** The host's side: wait for the request, then answer it. */
async function answerNext(frame: (requestId: string) => unknown): Promise<Record<string, unknown>> {
  while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  const request = JSON.parse(row.content) as Record<string, unknown>;
  const requestId = String(request.requestId);
  answer(requestId, frame(requestId));
  return { ...request, messageId: row.id };
}

async function call(tool: McpToolDefinition, args: Record<string, unknown>) {
  const [result, request] = await Promise.all([
    tool.handler(args),
    answerNext((id) => ({ id, ok: true, data: { message: `${tool.tool.name} done` } })),
  ]);
  return { result, request };
}

function text(result: { readonly content: readonly unknown[] }): string {
  return (result.content[0] as { readonly text: string }).text;
}

describe('the email tools', () => {
  it('send each call as its host action, carried by its own outbound message, with exactly its fields', async () => {
    const cases: Array<[McpToolDefinition, string, Record<string, unknown>]> = [
      [
        emailHandoff,
        'email_handoff',
        {
          to: ['remy@friend.example'],
          message: 'Remy is a close friend of Morgan’s from university. Find 30 minutes this week.',
          calendar: 'morgan@principal.example',
        },
      ],
      [emailHandoff, 'email_handoff', { thread_key: 'mail-inbound-1', message: 'Avoid Friday.' }],
      [
        emailHandoff,
        'email_handoff',
        { thread_key: 'mail-inbound-1', cc: ['jane@acme.example'], message: 'Morgan asked to loop Jane in.' },
      ],
      [
        emailHandoff,
        'email_handoff',
        { thread_key: 'mail-inbound-1', to: ['pat@acme.example'], message: 'Pat takes over from Dana.' },
      ],
      [
        emailHandoff,
        'email_handoff',
        { to: ['sales@acme.example'], cc: ['ops@acme.example'], message: 'Ask for their quote.' },
      ],
      [emailToPrincipal, 'email_send', { thread_key: 'mail-inbound-2', text: 'Booked: Tuesday at 12:30.' }],
      [emailSend, 'email_send', { text: 'Hi Remy, …', subject: 'Morgan and Remy — 30 minutes this week?' }],
      [emailSend, 'email_send', { text: 'Looping Jane in.', to: ['dana@acme.example'], cc: ['jane@acme.example'] }],
      [tellMain, 'tell_main', { message: 'Acme quoted $5,000 for the pilot and asks for a yes this week.' }],
      [
        freeTime,
        'free_time',
        {
          from: '2026-10-12T09:00:00-07:00',
          to: '2026-10-16T17:00:00-07:00',
          minutes: 30,
          timezone: 'Africa/Lagos',
        },
      ],
      [hold, 'hold', { starts: ['2026-10-12T11:00:00-07:00', '2026-10-13T12:30:00-07:00'], minutes: 30 }],
      [hold, 'hold', { starts: [] }],
      [
        book,
        'book',
        {
          start: '2026-10-13T12:30:00-07:00',
          minutes: 30,
          title: 'Morgan / Remy',
          notes: 'Catching up.',
          location: 'Remy’s own link',
          video_call: true,
          invitees: ['remy@friend.example'],
        },
      ],
      [moveBooking, 'move_booking', { booking: 'a'.repeat(64), start: '2026-10-14T09:30:00-07:00' }],
      [cancelBooking, 'cancel_booking', { booking: 'a'.repeat(64) }],
    ];
    for (const [tool, action, args] of cases) {
      const { result, request } = await call(tool, args);
      const fields = Object.fromEntries(
        Object.entries(request).filter(([key]) => !['action', 'requestId', 'messageId'].includes(key)),
      );
      expect(request.action, tool.tool.name).toBe(action);
      expect(request.requestId, tool.tool.name).toBe(request.messageId);
      expect(fields, tool.tool.name).toEqual(args);
      expect(result.isError, tool.tool.name).not.toBe(true);
      expect(text(result)).toBe(`${tool.tool.name} done`);
      closeSessionDb();
      initTestSessionDb();
    }
  });

  it('send no field a tool does not take', async () => {
    const { request } = await call(emailSend, {
      text: 'Hello',
      thread_key: 'mail-other-thread',
      action: 'email_handoff',
      requestId: 'forged',
    });
    expect(request).toEqual({
      text: 'Hello',
      action: 'email_send',
      requestId: request.messageId,
      messageId: request.messageId,
    });

    closeSessionDb();
    initTestSessionDb();
    const toMain = await call(tellMain, { message: 'Looped in.', to: ['someone@else.example'] });
    expect(Object.keys(toMain.request).sort()).toEqual(['action', 'message', 'messageId', 'requestId']);
  });

  it('return a refusal as an error the agent can read', async () => {
    const [result] = await Promise.all([
      book.handler({ start: '2026-10-13T12:30:00-07:00', minutes: 30, title: 'Catch up' }),
      answerNext((id) => ({
        id,
        ok: false,
        error: {
          code: 'forbidden',
          message: 'That time is no longer free. Call free_time for times to offer instead.',
        },
      })),
    ]);
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'Error: That time is no longer free. Call free_time for times to offer instead.' },
      ],
      isError: true,
    });
  });

  it('refuse a call missing what it needs without sending anything, saying what is missing', async () => {
    const cases: Array<[McpToolDefinition, Record<string, unknown>, RegExp]> = [
      [emailHandoff, { to: ['remy@friend.example'] }, /message is required/],
      [emailHandoff, { message: 'Find time.' }, /Name the thread by thread_key, or start one with to/],
      [emailHandoff, { cc: ['x@y.example'], message: 'Hi' }, /Name the thread by thread_key, or start one with to/],
      [emailToPrincipal, { text: 'Booked.' }, /thread_key is required/],
      [emailSend, { subject: 'Hello' }, /text is required/],
      [tellMain, {}, /message is required/],
      [freeTime, { from: '2026-10-12T09:00:00-07:00', to: '2026-10-16T17:00:00-07:00' }, /minutes is required/],
      [hold, {}, /starts is required/],
      [book, { start: '2026-10-13T12:30:00-07:00', minutes: 30 }, /title is required/],
      [moveBooking, { booking: 'a'.repeat(64) }, /start is required/],
      [cancelBooking, {}, /booking is required/],
    ];
    for (const [tool, args, problem] of cases) {
      const result = await tool.handler(args, { signal: AbortSignal.timeout(100) });
      const label = `${tool.tool.name} ${JSON.stringify(args)}`;
      expect(result.isError, label).toBe(true);
      expect(text(result), label).toMatch(problem);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('describe each tool in under 60 words', () => {
    for (const tool of ALL_TOOLS) {
      const words = (tool.tool.description ?? '').split(/\s+/u).filter(Boolean).length;
      expect(words, tool.tool.name).toBeGreaterThan(0);
      expect(words, tool.tool.name).toBeLessThan(60);
    }
  });

  it("gives main email_principal, which names the principal's thread, and external-email email_send for its own", () => {
    expect(emailToPrincipal.tool.name).toBe('email_principal');
    expect(emailSend.tool.name).toBe('email_send');
    expect(Object.keys(emailToPrincipal.tool.inputSchema.properties ?? {}).sort()).toEqual(['text', 'thread_key']);
    expect(Object.keys(emailSend.tool.inputSchema.properties ?? {}).sort()).toEqual([
      'cc',
      'files',
      'subject',
      'text',
      'to',
    ]);
  });
});

describe('files that go with a request', () => {
  // The outbox is /workspace/outbox, which only exists in a container, so the
  // writes there are recorded, and the files named are real ones.
  let dir: string;
  let copies: Array<[string, string]>;
  let made: string[];
  let spies: Array<{ mockRestore(): void }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-email-files-'));
    fs.writeFileSync(path.join(dir, 'deck.pdf'), 'deck');
    fs.mkdirSync(path.join(dir, 'other'));
    fs.writeFileSync(path.join(dir, 'other', 'deck.pdf'), 'another deck');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'notes');
    copies = [];
    made = [];
    spies = [
      spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike) => {
        made.push(String(target));
        return undefined;
      }) as typeof fs.mkdirSync),
      spyOn(fs, 'copyFileSync').mockImplementation((src, dest) => {
        copies.push([String(src), String(dest)]);
      }),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("are staged in the outbox under the request's own id before it is sent, and named by their file names", async () => {
    const { request } = await call(emailHandoff, {
      to: ['dana@acme.example'],
      message: 'Send Dana the deck.',
      files: [path.join(dir, 'deck.pdf'), path.join(dir, 'notes.txt')],
    });
    expect(request.files).toEqual(['deck.pdf', 'notes.txt']);
    const outbox = path.join('/workspace/outbox', String(request.requestId));
    expect(made).toEqual([outbox]);
    expect(copies).toEqual([
      [path.join(dir, 'deck.pdf'), path.join(outbox, 'deck.pdf')],
      [path.join(dir, 'notes.txt'), path.join(outbox, 'notes.txt')],
    ]);

    closeSessionDb();
    initTestSessionDb();
    copies = [];
    const sent = await call(emailSend, { text: 'Here is the deck.', files: [path.join(dir, 'deck.pdf')] });
    expect(sent.request.files).toEqual(['deck.pdf']);
    expect(copies).toEqual([
      [path.join(dir, 'deck.pdf'), path.join('/workspace/outbox', String(sent.request.requestId), 'deck.pdf')],
    ]);
  });

  it('stage nothing and send nothing when a file is missing, is not a file, or shares another’s name', async () => {
    const cases: Array<[McpToolDefinition, Record<string, unknown>, RegExp]> = [
      [emailSend, { text: 'Deck attached.', files: [path.join(dir, 'missing.pdf')] }, /No file at .*missing\.pdf/],
      [emailSend, { text: 'Deck attached.', files: [path.join(dir, 'other')] }, /No file at .*other/],
      [
        emailHandoff,
        {
          thread_key: 'mail-inbound-1',
          message: 'Both decks.',
          files: [path.join(dir, 'deck.pdf'), path.join(dir, 'other', 'deck.pdf')],
        },
        /Two of the files are named deck\.pdf/,
      ],
      [emailSend, { text: 'Deck attached.', files: 'deck.pdf' }, /files must list up to 10 file paths/],
      [emailSend, { text: 'Deck attached.', files: [7] }, /files must list up to 10 file paths/],
    ];
    for (const [tool, args, problem] of cases) {
      const result = await tool.handler(args, { signal: AbortSignal.timeout(100) });
      const label = `${tool.tool.name} ${JSON.stringify(args)}`;
      expect(result.isError, label).toBe(true);
      expect(text(result), label).toMatch(problem);
    }
    expect(made).toEqual([]);
    expect(copies).toEqual([]);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('a request the host is slow to answer', () => {
  /** Run `tool` with each reading of the clock a whole timeout later, so it stops waiting at once. */
  async function timedOut(tool: McpToolDefinition, args: Record<string, unknown>) {
    const realNow = Date.now;
    const start = realNow();
    let calls = 0;
    Date.now = () => start + calls++ * EMAIL_REQUEST_TIMEOUT_MS;
    try {
      return await tool.handler(args);
    } finally {
      Date.now = realNow;
    }
  }

  it('says not to repeat a request that would send, write or book twice, and request_status reads the late answer', async () => {
    for (const [tool, args] of [
      [emailHandoff, { thread_key: 'mail-inbound-1', message: 'Avoid Friday.' }],
      [emailToPrincipal, { thread_key: 'mail-inbound-1', text: 'Done.' }],
      [emailSend, { text: 'Hello' }],
      [tellMain, { message: 'Looped in.' }],
      [book, { start: '2026-10-13T12:30:00-07:00', minutes: 30, title: 'Catch up' }],
    ] as const) {
      const result = await timedOut(tool, args);
      expect(result.isError, tool.tool.name).toBe(true);
      expect(text(result), tool.tool.name).toMatch(
        /request_status before you do anything else, and do not send it again/,
      );
    }
    const [row] = getUndeliveredMessages();
    answer(row.id, { id: row.id, ok: true, data: { message: 'Handed to the thread.' } });
    expect((await requestStatus.handler({ request_id: row.id })).content).toEqual([
      { type: 'text', text: 'Handed to the thread.' },
    ]);
  });

  it('says a request that changes nothing twice may be made again', async () => {
    for (const [tool, args] of [
      [freeTime, { from: '2026-10-12T09:00:00-07:00', to: '2026-10-16T17:00:00-07:00', minutes: 30 }],
      [hold, { starts: [] }],
      [moveBooking, { booking: 'a'.repeat(64), start: '2026-10-14T09:30:00-07:00' }],
      [cancelBooking, { booking: 'a'.repeat(64) }],
    ] as const) {
      expect(text(await timedOut(tool, args)), tool.tool.name).toMatch(
        /or make the same call again: a repeat changes nothing twice/,
      );
    }
  });
});

describe('requestAction', () => {
  it('sends a request under the id its caller chose', async () => {
    const waiting = requestAction('tell_main', { message: 'Looped in.' }, { timeoutMs: 20, requestId: 'act-chosen-1' });
    const result = await waiting;
    expect(result).toEqual({ status: 'timeout', requestId: 'act-chosen-1' });
    const [row] = getUndeliveredMessages();
    expect(row.id).toBe('act-chosen-1');
    expect(JSON.parse(row.content)).toMatchObject({ action: 'tell_main', requestId: 'act-chosen-1' });
  });

  it('gives up after its timeout, and stops at once when cancelled', async () => {
    const timedOut = await requestAction('tell_main', { message: 'x' }, { timeoutMs: 20, pollMs: 5 });
    expect(timedOut).toEqual({ status: 'timeout', requestId: getUndeliveredMessages()[0].id });
    const controller = new AbortController();
    const waiting = requestAction('tell_main', { message: 'x' }, { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    expect(await waiting).toEqual({ status: 'cancelled' });
  });

  it('never lets a field overwrite the action or its request id', async () => {
    const waiting = requestAction('tell_main', { action: 'cli_request', requestId: 'forged' }, { timeoutMs: 20 });
    while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
    const [row] = getUndeliveredMessages();
    expect(JSON.parse(row.content)).toMatchObject({ action: 'tell_main', requestId: row.id });
    await waiting;
  });
});
