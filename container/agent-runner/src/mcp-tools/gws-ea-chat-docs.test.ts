import { afterEach, beforeEach, expect, it } from 'bun:test';
import Ajv from 'ajv';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { docCreate, docRead, docEdit, docShare } from './gws-ea-chat-docs.js';
import type { McpToolDefinition } from './types.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());
it.each<[McpToolDefinition, Record<string, unknown>, string]>([
  [docCreate, { title: 'Trip itinerary', text: 'Day one' }, 'doc_create'],
  [docRead, { file: 'document-1' }, 'doc_read'],
  [docEdit, { file: 'document-1', find: 'Day one', replace: 'Day two' }, 'doc_edit'],
  [docShare, { file: 'document-1', role: 'reader' }, 'doc_share'],
])(
  'sends %s to its host action without credentials or caller-chosen sharing recipients',
  async (tool, fields, action) => {
    const validate = new Ajv().compile(tool.tool.inputSchema);
    expect(validate(fields)).toBe(true);
    expect(validate({ ...fields, email: 'forged@example.com' })).toBe(false);
    expect(validate({ ...fields, anyone: true })).toBe(false);
    const waiting = tool.handler({ ...fields, chat: 'foreign', token: 'forged', email: 'forged@example.com' });
    while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
    const row = getUndeliveredMessages()[0];
    expect(JSON.parse(row.content)).toEqual({ ...fields, action, requestId: row.id });
    getInboundDb()
      .prepare('INSERT INTO messages_in(id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)')
      .run(
        `action-resp-${row.id}`,
        'system',
        new Date().toISOString(),
        JSON.stringify({
          type: 'action_response',
          requestId: row.id,
          frame: { id: row.id, ok: true, data: { message: 'Done.' } },
        }),
      );
    expect(await waiting).toMatchObject({ content: [{ type: 'text', text: 'Done.' }] });
  },
);
it('requires an exact text edit and permits deletion without offering a link-sharing schema', () => {
  const edit = new Ajv().compile(docEdit.tool.inputSchema);
  expect(edit({ file: 'document-1', find: 'remove this', replace: '' })).toBe(true);
  expect(edit({ file: 'document-1', requests: [] })).toBe(false);
  const share = new Ajv().compile(docShare.tool.inputSchema);
  expect(share({ file: 'document-1' })).toBe(true);
  expect(share({ file: 'document-1', role: 'owner' })).toBe(false);
  expect(share({ file: 'document-1', type: 'anyone' })).toBe(false);
});
