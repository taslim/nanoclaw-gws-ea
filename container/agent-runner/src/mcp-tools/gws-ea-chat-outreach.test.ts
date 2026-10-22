import { afterEach, beforeEach, expect, it } from 'bun:test';
import Ajv from 'ajv';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { chatReachOut } from './gws-ea-chat-outreach.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

it('requires people, words and the principal citation in a closed outreach schema', () => {
  const valid = new Ajv().compile(chatReachOut.tool.inputSchema);
  const args = {
    people: [{ name: 'Morgan', number: '+15551112222', person: 'p-morgan' }],
    message: 'Arrange coffee.',
    principal_message: 'principal-own',
  };
  expect(valid(args)).toBe(true);
  expect(valid({ ...args, group: 'Coffee' })).toBe(true);
  expect(valid({ ...args, principal_message: undefined })).toBe(false);
  expect(valid({ ...args, chat: 'forged-target' })).toBe(false);
});

it('lets the durable tool row identify the operation while carrying the citation separately', async () => {
  const args = {
    people: [{ name: 'Morgan', number: '+15551112222' }],
    message: 'Arrange coffee.',
    principal_message: 'principal-own',
    group: 'Coffee',
  };
  const waiting = chatReachOut.handler({ ...args, requestId: 'forged-id', agent: 'forged' });
  while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
  const row = getUndeliveredMessages()[0];
  expect(JSON.parse(row.content)).toEqual({ ...args, action: 'chat_reach_out', requestId: row.id });
  getInboundDb()
    .prepare('INSERT INTO messages_in(id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId: row.id,
        frame: { id: row.id, ok: true, data: { chat: 'chat-new', message: 'The request was handed over.' } },
      }),
    );
  expect(await waiting).toMatchObject({ content: [{ type: 'text', text: 'The request was handed over.' }] });
});
