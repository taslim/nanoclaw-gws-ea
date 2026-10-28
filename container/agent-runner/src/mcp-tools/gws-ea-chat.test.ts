import { afterEach, beforeEach, expect, it } from 'bun:test';
import Ajv from 'ajv';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import {
  whatsappLink,
  chatHandoff,
  chatAdmit,
  chatDecline,
  chatLeave,
  chatTellMain,
  expectReply,
  remind,
  chatFreeTime,
  chatBook,
  chatChangeBooking,
  chatCancelBooking,
} from './gws-ea-chat.js';
import type { McpToolDefinition } from './types.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

it('requires both numbers or a citation-only re-link', () => {
  const valid = new Ajv().compile(whatsappLink.tool.inputSchema);
  expect(valid({ principal_messages: ['marked-dm'] })).toBe(true);
  expect(valid({ number: '+15550000000', principal_number: '+447700900123', principal_messages: ['marked-dm'] })).toBe(
    true,
  );
  expect(valid({ number: '+15550000000', principal_messages: ['marked-dm'] })).toBe(false);
  expect(valid({ number: '+15550000000', principal_number: '+447700900123', principal_messages: [] })).toBe(false);
});

it('carries the principal citations to the host and returns its pairing result through the real mailbox', async () => {
  const args = {
    number: '+15550000000',
    principal_number: '+447700900123',
    principal_messages: ['first-mark', 'second-mark'],
  };
  const waiting = whatsappLink.handler(args);
  while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
  const row = getUndeliveredMessages()[0];
  expect(JSON.parse(row.content)).toMatchObject({ action: 'whatsapp_link', requestId: row.id, ...args });
  getInboundDb()
    .prepare('INSERT INTO messages_in(id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId: row.id,
        frame: { id: row.id, ok: true, data: { state: 'linking', pairingCode: '87654321' } },
      }),
    );
  const result = await waiting;
  expect(result.isError).not.toBe(true);
  const response = result.content.find((content) => content.type === 'text');
  expect(response?.type === 'text' ? JSON.parse(response.text) : undefined).toEqual({
    state: 'linking',
    pairingCode: '87654321',
  });
});

it.each<[McpToolDefinition, Record<string, unknown>, string]>([
  [
    chatHandoff,
    {
      chat: 'chat-trip',
      message: 'Find a venue.',
      matter: 'nowhere',
      job: true,
      people: [{ member: 'whatsapp:22', email: 'mira@example.com' }],
      principal_message: 'principal-share',
    },
    'chat_handoff',
  ],
  [chatAdmit, { chat: 'chat-trip', principal_message: 'principal-yes' }, 'chat_admit'],
  [chatDecline, { chat: 'chat-trip' }, 'chat_decline'],
  [chatLeave, { chat: 'chat-trip' }, 'chat_leave'],
  [expectReply, { people: ['whatsapp:22'], until: '2026-10-19T12:00:00Z' }, 'expect_reply'],
  [remind, { at: '2026-10-19T12:00:00Z', note: 'Choose the venue.' }, 'remind'],
  [chatFreeTime, { from: '2026-10-19T12:00:00Z', to: '2026-10-20T12:00:00Z', minutes: 30 }, 'free_time'],
  [
    chatBook,
    { start: '2026-10-19T12:00:00Z', minutes: 30, title: 'Venue visit', invitees: ['mira@example.com'] },
    'book',
  ],
  [chatChangeBooking, { booking: 'booked-here', location: 'Venue' }, 'change_booking'],
  [chatCancelBooking, { booking: 'booked-here' }, 'cancel_booking'],
  [
    chatTellMain,
    { account: 'Mira can meet Friday.', matter: 'm-123456abcdef', wake: true, cite: ['principal-friday'] },
    'chat_tell_main',
  ],
])(
  'carries %s through its own host action without an agent or cross-chat routing field',
  async (tool, args, action) => {
    const waiting = tool.handler({ ...args, agent: 'forged', target_chat: 'another' });
    while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
    const row = getUndeliveredMessages()[0];
    expect(JSON.parse(row.content)).toEqual({ ...args, action, requestId: row.id });
    getInboundDb()
      .prepare('INSERT INTO messages_in(id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)')
      .run(
        `action-resp-${row.id}`,
        'system',
        new Date().toISOString(),
        JSON.stringify({
          type: 'action_response',
          requestId: row.id,
          frame: { id: row.id, ok: true, data: { message: 'Kept.' } },
        }),
      );
    expect(await waiting).toMatchObject({ content: [{ type: 'text', text: 'Kept.' }] });
  },
);
it('uses closed chat schemas and requires the consent citation for admission', () => {
  const valid = new Ajv().compile(chatAdmit.tool.inputSchema);
  expect(valid({ chat: 'chat-trip' })).toBe(false);
  expect(valid({ chat: 'chat-trip', principal_message: 'yes' })).toBe(true);
  const report = new Ajv().compile(chatTellMain.tool.inputSchema);
  expect(report({ account: 'Update.', chat: 'another' })).toBe(false);
  expect(report({ account: 'Update.', cite: ['own'] })).toBe(true);
});

it('exposes closed session-only scheduling schemas with required fields', () => {
  for (const tool of [expectReply, remind, chatFreeTime, chatBook, chatChangeBooking, chatCancelBooking]) {
    const validate = new Ajv().compile(tool.tool.inputSchema);
    expect(validate({ chat: 'another' })).toBe(false);
  }
  const validate = new Ajv().compile(chatBook.tool.inputSchema);
  expect(validate({ start: '2026-10-19T12:00:00Z', minutes: 30, title: 'Venue visit' })).toBe(true);
  expect(validate({ start: '2026-10-19T12:00:00Z', minutes: 1, title: 'Venue visit' })).toBe(false);
});

it.each<[string, McpToolDefinition, Record<string, unknown>]>([
  ['book', chatBook, { start: '2026-10-19T12:00:00Z', minutes: 30, title: 'Venue visit' }],
  ['change_booking', chatChangeBooking, { booking: 'booked-here', location: 'Venue' }],
  ['cancel_booking', chatCancelBooking, { booking: 'booked-here' }],
])('keeps a timed-out %s waiting for its host answer without inviting another write', async (name, tool, args) => {
  const realNow = Date.now;
  const start = realNow();
  let calls = 0;
  Date.now = () => start + calls++ * 120_000;
  try {
    const result = await tool.handler(args);
    const [row] = getUndeliveredMessages();
    expect(result.isError).toBe(true);
    const response = result.content.find((content) => content.type === 'text');
    const text = response?.type === 'text' ? response.text : undefined;
    expect(text, name).toContain(`request ${row.id}`);
    expect(text, name).toContain('The answer will arrive in a host message.');
    expect(text, name).toContain('Do not send this request again.');
    expect(text, name).not.toContain('make the same call again');
  } finally {
    Date.now = realNow;
  }
});

it('allows another free_time call after its wait expires', async () => {
  const realNow = Date.now;
  const start = realNow();
  let calls = 0;
  Date.now = () => start + calls++ * 120_000;
  try {
    const result = await chatFreeTime.handler({
      from: '2026-10-19T12:00:00Z',
      to: '2026-10-20T12:00:00Z',
      minutes: 30,
    });
    const [row] = getUndeliveredMessages();
    const response = result.content.find((content) => content.type === 'text');
    const text = response?.type === 'text' ? response.text : undefined;
    expect(result.isError).toBe(true);
    expect(text).toContain(`request ${row.id}`);
    expect(text).toContain('or make the same call again: a repeat changes nothing twice');
    expect(text).not.toContain('The answer will arrive in a host message.');
  } finally {
    Date.now = realNow;
  }
});
