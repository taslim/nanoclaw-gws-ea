import fs from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import Ajv from 'ajv';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import type { McpToolDefinition } from './types.js';
// The barrel loads every tool module under its key, as the container does.
import './index.js';
import { addApp, appToolAsk, deleteApp } from './gws-ea-connections.js';

beforeEach(initTestSessionDb);
afterEach(closeSessionDb);

async function call(tool: McpToolDefinition, args: Record<string, unknown>, data: Record<string, unknown>) {
  const waiting = tool.handler(args);
  while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  getInboundDb()
    .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({ type: 'action_response', requestId: row.id, frame: { id: row.id, ok: true, data } }),
    );
  expect(await waiting).toEqual({ content: [{ type: 'text', text: JSON.stringify(data) }] });
  return { request: JSON.parse(row.content) as unknown, id: row.id };
}

it('asks the host to add one app by address and name, and sends no other field', async () => {
  const validate = new Ajv().compile(addApp.tool.inputSchema);
  expect(validate({ url: 'https://app.ledgerly.example.test/mcp', name: 'Ledgerly' })).toBe(true);
  for (const fields of [
    {},
    { url: 'https://app.ledgerly.example.test/mcp' },
    { name: 'Ledgerly' },
    { url: 'https://app.ledgerly.example.test/mcp', name: 'Ledgerly', token: 'secret' },
    { url: 'https://app.ledgerly.example.test/mcp', name: 'Ledgerly', client_secret: 'secret' },
  ])
    expect(validate(fields)).toBe(false);
  const { request, id } = await call(
    addApp,
    { url: 'https://app.ledgerly.example.test/mcp', name: 'Ledgerly', token: 'secret' },
    { status: 'awaiting_principal' },
  );
  expect(request).toEqual({
    action: 'add_app',
    requestId: id,
    url: 'https://app.ledgerly.example.test/mcp',
    name: 'Ledgerly',
  });
});

it('asks the host to delete one app by its key alone', async () => {
  const validate = new Ajv().compile(deleteApp.tool.inputSchema);
  expect(validate({ app: 'app_0a1b2c3d4e5f' })).toBe(true);
  for (const fields of [{}, { app: 'app_0a1b2c3d4e5f', id: 'stored-id' }]) expect(validate(fields)).toBe(false);
  const { request, id } = await call(deleteApp, { app: 'app_0a1b2c3d4e5f' }, { status: 'awaiting_principal' });
  expect(request).toEqual({ action: 'delete_app', requestId: id, app: 'app_0a1b2c3d4e5f' });
});

it('keeps credentials out of chat and sends the Connections link only when a sign-in is needed', () => {
  for (const meaning of [
    'awaiting_principal',
    'added Not connected',
    'Connections link from principal_page',
    'Never put a token, key or client secret in the address or ask for one in chat',
  ])
    expect(addApp.tool.description).toContain(meaning);
  expect(deleteApp.tool.description).toContain("An operator's server cannot be deleted here");
});

it('asks the host to change a tool approval label by app key, tool name, and ask_first flag', async () => {
  const validate = new Ajv().compile(appToolAsk.tool.inputSchema);
  expect(validate({ app: 'app_0a1b2c3d4e5f', tool: 'confirm_checkout', ask_first: false })).toBe(true);
  expect(validate({ app: 'app_0a1b2c3d4e5f', tool: 'search_menu', ask_first: true, reason: 'User prefers review' })).toBe(
    true,
  );
  for (const fields of [
    {},
    { app: 'app_0a1b2c3d4e5f', tool: 'confirm_checkout' },
    { app: 'app_0a1b2c3d4e5f', tool: 'confirm_checkout', ask_first: 'never' },
    { app: 'app_0a1b2c3d4e5f', tool: 'confirm_checkout', ask_first: false, extra: 'x' },
  ])
    expect(validate(fields)).toBe(false);
  const { request, id } = await call(
    appToolAsk,
    { app: 'app_0a1b2c3d4e5f', tool: 'confirm_checkout', ask_first: false, reason: 'Principal asked' },
    { status: 'awaiting_principal' },
  );
  expect(request).toEqual({
    action: 'app_tool_ask',
    requestId: id,
    app: 'app_0a1b2c3d4e5f',
    tool: 'confirm_checkout',
    ask_first: false,
    reason: 'Principal asked',
  });
});

it('teaches that held/setup app answers are normal and when the Connections link is sent', () => {
  const instructions = fs.readFileSync(new URL('./gws-ea-connections.instructions.md', import.meta.url), 'utf8');
  for (const rule of [
    'principal was asked',
    'still being set up',
    'wait for the note rather than treating it as a failure',
    '`principal_page` connections facts',
    'disconnected app without a link',
    'Connections link once',
    'never ask for tokens or client secrets in chat',
  ])
    expect(instructions).toContain(rule);
  expect(instructions).not.toMatch(/authenticate/iu);
});

it('tells the principal once when an app asks them itself, then checks the outcome without asking again', () => {
  const instructions = fs.readFileSync(new URL('./gws-ea-connections.instructions.md', import.meta.url), 'utf8');
  for (const rule of [
    'confirmed by the app',
    'Tell the principal once',
    'when they say they approved or the window passes',
    'asking a second time',
    'approval of your own',
  ])
    expect(instructions).toContain(rule);
});
