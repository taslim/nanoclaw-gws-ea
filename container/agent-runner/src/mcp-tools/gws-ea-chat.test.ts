import { afterEach, beforeEach, expect, it } from 'bun:test';
import Ajv from 'ajv';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { whatsappLink } from './gws-ea-chat.js';

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
