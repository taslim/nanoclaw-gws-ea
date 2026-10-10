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
import * as messagesOut from '../db/messages-out.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import {
  book,
  cancelBooking,
  changeBooking,
  EMAIL_REQUEST_TIMEOUT_MS,
  emailHandoff,
  emailSend,
  emailToPrincipal,
  freeTime,
  tellMain,
} from './gws-ea-email.js';
import { requestStatus } from './request-status.js';
import type { McpToolDefinition } from './types.js';

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
          people: ['remy@friend.example'],
          message: 'Remy is a close friend of Morgan’s from university. Find 30 minutes this week.',
          calendar: 'morgan@principal.example',
        },
      ],
      [emailHandoff, 'email_handoff', { thread_key: 'mail-inbound-1', message: 'Avoid Friday.' }],
      [
        emailHandoff,
        'email_handoff',
        { thread_key: 'mail-inbound-1', people: ['jane@acme.example'], message: 'Morgan asked to copy Jane in.' },
      ],
      [
        emailHandoff,
        'email_handoff',
        {
          people: ['sales@acme.example', 'ops@acme.example'],
          message: 'Ask sales for their quote, copying ops.',
        },
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
          timezone: 'Europe/Berlin',
        },
      ],
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
      [
        changeBooking,
        'change_booking',
        {
          booking: 'a'.repeat(64),
          start: '2026-10-14T09:30:00-07:00',
          minutes: 45,
          title: 'Morgan / Remy',
          location: 'Cafe Rosa',
          notes: 'Moved to Wednesday.',
          video_call: true,
        },
      ],
      [changeBooking, 'change_booking', { booking: 'a'.repeat(64), title: 'Morgan / Remy: catching up' }],
      [cancelBooking, 'cancel_booking', { booking: 'a'.repeat(64) }],
    ];
    for (const [tool, action, args] of cases) {
      const { result, request } = await call(tool, args);
      const fields = Object.fromEntries(
        Object.entries(request).filter(([key]) => !['action', 'requestId', 'delivers', 'messageId'].includes(key)),
      );
      expect(request.action, tool.tool.name).toBe(action);
      expect(request.requestId, tool.tool.name).toBe(request.messageId);
      // Only a sent email is the turn's reply, so only email_send's requests are marked as delivering.
      expect(request.delivers, tool.tool.name).toBe(action === 'email_send' ? true : undefined);
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
      delivers: true,
      messageId: request.messageId,
    });

    closeSessionDb();
    initTestSessionDb();
    const toMain = await call(tellMain, { message: 'Looped in.', to: ['someone@else.example'], delivers: true });
    expect(Object.keys(toMain.request).sort()).toEqual(['action', 'message', 'messageId', 'requestId']);

    // main names people; who each email goes to and who is copied is external-email's to place.
    closeSessionDb();
    initTestSessionDb();
    const handoff = await call(emailHandoff, {
      people: ['dana@acme.example'],
      to: ['dana@acme.example'],
      cc: ['jane@acme.example'],
      message: 'Find Dana 30 minutes.',
    });
    expect(Object.keys(handoff.request).sort()).toEqual(['action', 'message', 'messageId', 'people', 'requestId']);
  });

  it('leave a handoff that names no thread and no one for the host to judge', async () => {
    await emailHandoff.handler({ message: 'Find Remy 30 minutes.' }, { signal: AbortSignal.timeout(50) });
    expect(getUndeliveredMessages().map((row) => JSON.parse(row.content) as unknown)).toMatchObject([
      { action: 'email_handoff', message: 'Find Remy 30 minutes.' },
    ]);
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
      [emailHandoff, { people: ['remy@friend.example'] }, /message is required/],
      [emailToPrincipal, { text: 'Booked.' }, /thread_key is required/],
      [emailSend, { subject: 'Hello' }, /text is required/],
      [tellMain, {}, /message is required/],
      [freeTime, { from: '2026-10-12T09:00:00-07:00', to: '2026-10-16T17:00:00-07:00' }, /minutes is required/],
      [book, { start: '2026-10-13T12:30:00-07:00', minutes: 30 }, /title is required/],
      [changeBooking, { start: '2026-10-14T09:30:00-07:00' }, /booking is required/],
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
});

describe('files that go with a request', () => {
  // The outbox is /workspace/outbox, which only exists in a container, so the
  // writes there are recorded, and the files named are real ones.
  let dir: string;
  let copies: Array<[string, string]>;
  /** How many requests had been sent as each file was copied. */
  let sentAtCopy: number[];
  let made: string[];
  let removed: string[];
  let spies: Array<{ mockRestore(): void }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-email-files-'));
    fs.writeFileSync(path.join(dir, 'deck.pdf'), 'deck');
    fs.mkdirSync(path.join(dir, 'other'));
    fs.writeFileSync(path.join(dir, 'other', 'deck.pdf'), 'another deck');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'notes');
    copies = [];
    sentAtCopy = [];
    made = [];
    removed = [];
    spies = [
      spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike) => {
        made.push(String(target));
        return undefined;
      }) as typeof fs.mkdirSync),
      spyOn(fs, 'rmSync').mockImplementation((target) => {
        removed.push(String(target));
      }),
      spyOn(fs, 'copyFileSync').mockImplementation((src, dest) => {
        // A file the container may see but not read, so copying it fails part way through staging.
        if (path.basename(String(src)) === 'unreadable.pdf') throw new Error('EACCES: permission denied, copyfile');
        copies.push([String(src), String(dest)]);
        sentAtCopy.push(getUndeliveredMessages().length);
      }),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("are staged in the outbox under the request's own id before it is sent, and named by their file names", async () => {
    const { request } = await call(emailHandoff, {
      people: ['dana@acme.example'],
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
    expect(sentAtCopy).toEqual([0, 0]);

    closeSessionDb();
    initTestSessionDb();
    copies = [];
    sentAtCopy = [];
    const sent = await call(emailSend, { text: 'Here is the deck.', files: [path.join(dir, 'deck.pdf')] });
    expect(sent.request.files).toEqual(['deck.pdf']);
    expect(copies).toEqual([
      [path.join(dir, 'deck.pdf'), path.join('/workspace/outbox', String(sent.request.requestId), 'deck.pdf')],
    ]);
    expect(sentAtCopy).toEqual([0]);

    closeSessionDb();
    initTestSessionDb();
    copies = [];
    sentAtCopy = [];
    const toPrincipal = await call(emailToPrincipal, {
      thread_key: 'mail-inbound-2',
      text: 'The signed contract is attached.',
      files: [path.join(dir, 'notes.txt')],
    });
    expect(toPrincipal.request.files).toEqual(['notes.txt']);
    expect(copies).toEqual([
      [path.join(dir, 'notes.txt'), path.join('/workspace/outbox', String(toPrincipal.request.requestId), 'notes.txt')],
    ]);
    expect(sentAtCopy).toEqual([0]);
  });

  it('send nothing, say why, and clear what was staged when staging fails part way', async () => {
    fs.writeFileSync(path.join(dir, 'unreadable.pdf'), 'locked');
    const result = await emailSend.handler(
      { text: 'Both attached.', files: [path.join(dir, 'deck.pdf'), path.join(dir, 'unreadable.pdf')] },
      { signal: AbortSignal.timeout(100) },
    );
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'Error: The request could not be made ready: EACCES: permission denied, copyfile' },
      ],
      isError: true,
    });
    expect(copies.map(([source]) => path.basename(source))).toEqual(['deck.pdf']);
    expect(made).toHaveLength(1);
    expect(removed).toEqual(made);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('send nothing, say why, and clear what was staged when the request cannot be written for the host', async () => {
    // The outbound mailbox refuses the write, so the request never reaches the host.
    spies.push(spyOn(messagesOut, 'writeMessageOut').mockRejectedValue(new Error('disk full')));
    const result = await emailSend.handler(
      { text: 'Here is the deck.', files: [path.join(dir, 'deck.pdf')] },
      { signal: AbortSignal.timeout(100) },
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: The request could not be sent: disk full' }],
      isError: true,
    });
    expect(made).toHaveLength(1);
    expect(removed).toEqual(made);
  });

  it('named by a relative path are found under /workspace/agent', async () => {
    // /workspace/agent too exists only in a container, so its files are looked up in dir.
    const statSync = fs.statSync;
    const workspace = '/workspace/agent/';
    spies.push(
      spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike) => {
        const file = String(target);
        const local = file.startsWith(workspace) ? path.join(dir, file.slice(workspace.length)) : file;
        return statSync(local, { throwIfNoEntry: false });
      }) as typeof fs.statSync),
    );

    await emailSend.handler({ text: 'Here is the deck.', files: ['deck.pdf'] }, { signal: AbortSignal.timeout(100) });
    expect(copies.map(([source]) => source)).toEqual(['/workspace/agent/deck.pdf']);
    expect(getUndeliveredMessages()).toHaveLength(1);
  });

  it('stage nothing and send nothing when there are over 10 files, or a file is missing, is not a file, or shares another’s name', async () => {
    // Eleven real files, so only their number can refuse them.
    const eleven = Array.from({ length: 11 }, (_, index) => path.join(dir, `page-${index + 1}.pdf`));
    for (const file of eleven) fs.writeFileSync(file, 'page');
    const cases: Array<[McpToolDefinition, Record<string, unknown>, RegExp]> = [
      [emailSend, { text: 'Pages attached.', files: eleven }, /files must list up to 10 file paths/],
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

  describe('to main', () => {
    // The session's own folders, /workspace/inbox and /workspace/agent, exist
    // only in a container, so their files are looked up under a local copy.
    let workspace: string;
    // Taken before each test records the outbox's folders in its place.
    const mkdirSync = fs.mkdirSync;

    beforeEach(() => {
      workspace = path.join(dir, 'workspace');
      for (const [file, contents] of [
        ['inbox/mail-1/invoice.pdf', 'invoice'],
        ['inbox/handoff-act-1/terms.txt', 'terms'],
        ['agent/notes.txt', 'notes'],
      ] as const) {
        mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
        fs.writeFileSync(path.join(workspace, file), contents);
      }
      // A link in the inbox to a file elsewhere in the session.
      fs.symlinkSync(path.join(workspace, 'agent', 'notes.txt'), path.join(workspace, 'inbox', 'mail-1', 'linked.txt'));

      const statSync = fs.statSync;
      const realpathSync = fs.realpathSync;
      const realWorkspace = realpathSync(workspace);
      const local = (target: fs.PathLike): string => {
        const file = String(target);
        return file.startsWith('/workspace/') ? path.join(workspace, file.slice('/workspace/'.length)) : file;
      };
      spies.push(
        spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike) =>
          statSync(local(target), { throwIfNoEntry: false })) as typeof fs.statSync),
        spyOn(fs, 'realpathSync').mockImplementation(((target: fs.PathLike) => {
          const real = realpathSync(local(target));
          const relative = path.relative(realWorkspace, real);
          return relative.startsWith('..') || path.isAbsolute(relative) ? real : path.join('/workspace', relative);
        }) as typeof fs.realpathSync),
      );
    });

    it("are files that came in this thread, staged from its inbox under the request's own id by their file names", async () => {
      const { request } = await call(tellMain, {
        message: 'Acme sent its invoice for the pilot, with its terms.',
        files: ['/workspace/inbox/mail-1/invoice.pdf', '/workspace/inbox/handoff-act-1/terms.txt'],
      });
      expect(request.files).toEqual(['invoice.pdf', 'terms.txt']);
      const outbox = path.join('/workspace/outbox', String(request.requestId));
      expect(made).toEqual([outbox]);
      expect(copies).toEqual([
        ['/workspace/inbox/mail-1/invoice.pdf', path.join(outbox, 'invoice.pdf')],
        ['/workspace/inbox/handoff-act-1/terms.txt', path.join(outbox, 'terms.txt')],
      ]);
      expect(sentAtCopy).toEqual([0, 0]);
    });

    it('refuse any file that did not come in this thread, staging nothing and sending nothing', async () => {
      const elsewhere = path.join(dir, 'deck.pdf');
      for (const files of [
        ['/workspace/agent/notes.txt'],
        // Relative to /workspace/agent, as every file path is.
        ['notes.txt'],
        ['/workspace/inbox/../agent/notes.txt'],
        ['/workspace/inbox/mail-1/linked.txt'],
        [elsewhere],
        ['/workspace/inbox/mail-1/invoice.pdf', '/workspace/agent/notes.txt'],
      ]) {
        const result = await tellMain.handler(
          { message: 'Acme sent its invoice.', files },
          { signal: AbortSignal.timeout(100) },
        );
        const label = JSON.stringify(files);
        expect(result.isError, label).toBe(true);
        expect(text(result), label).toMatch(
          /did not come in this thread: only files under \/workspace\/inbox\/ can go to main/,
        );
      }
      expect(made).toEqual([]);
      expect(copies).toEqual([]);
      expect(getUndeliveredMessages()).toHaveLength(0);
    });

    it('refuse a file missing from the inbox as any tool does', async () => {
      const result = await tellMain.handler(
        { message: 'Acme sent its invoice.', files: ['/workspace/inbox/mail-1/missing.pdf'] },
        { signal: AbortSignal.timeout(100) },
      );
      expect(text(result)).toMatch(/No file at \/workspace\/inbox\/mail-1\/missing\.pdf/);
      expect(copies).toEqual([]);
      expect(getUndeliveredMessages()).toHaveLength(0);
    });
  });

  it('stage nothing and send nothing for a call cancelled before it starts', async () => {
    const result = await emailSend.handler(
      { text: 'Here is the deck.', files: [path.join(dir, 'deck.pdf')] },
      { signal: AbortSignal.abort() },
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: The request was cancelled before the host answered.' }],
      isError: true,
    });
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
      [changeBooking, { booking: 'a'.repeat(64), start: '2026-10-14T09:30:00-07:00' }],
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
