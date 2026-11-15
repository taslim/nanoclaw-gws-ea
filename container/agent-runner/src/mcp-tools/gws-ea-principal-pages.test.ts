import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import Ajv from 'ajv';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
// The barrel loads every tool module under its key, as the container does.
import './index.js';
import { principalPage } from './gws-ea-principal-pages.js';

beforeEach(initTestSessionDb);
afterEach(closeSessionDb);

async function call(args: Record<string, unknown>, data: Record<string, unknown>) {
  const waiting = principalPage.handler(args);
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

it('asks the host for one named page and sends no other field', async () => {
  const validate = new Ajv().compile(principalPage.tool.inputSchema);
  for (const page of ['home', 'logins', 'connections']) expect(validate({ page })).toBe(true);
  for (const fields of [
    {},
    { page: 'settings' },
    { page: 'connections/callback/app2.ledgerly.example.test' },
    { page: 'logins', url: 'https://foreign.example/logins' },
    { page: 'connections', token: 'secret' },
  ])
    expect(validate(fields)).toBe(false);
  const answer = { status: 'available', url: 'https://juno.example.test/connections', facts: { apps: [] } };
  const { request, id } = await call({ page: 'connections', url: 'https://foreign.example/', token: 'secret' }, answer);
  expect(request).toEqual({ action: 'principal_page', requestId: id, page: 'connections' });
});

it("says what each of the host's answers means and that the link goes only to the principal", () => {
  for (const meaning of [
    'operator_needed',
    'ask their operator',
    'unavailable',
    'try again later',
    'send that exact link to the principal',
    'Only main gets home and connections',
    'Never ask for passwords, tokens or client secrets in chat',
  ])
    expect(principalPage.tool.description).toContain(meaning);
});

it('replaces the logins-only link tool in every tool module', () => {
  const modules = fileURLToPath(new URL('.', import.meta.url));
  for (const file of fs.readdirSync(modules).filter((name) => /\.(?:ts|md)$/u.test(name) && !name.endsWith('.test.ts')))
    expect(fs.readFileSync(`${modules}/${file}`, 'utf8'), file).not.toContain('logins_page');
});
