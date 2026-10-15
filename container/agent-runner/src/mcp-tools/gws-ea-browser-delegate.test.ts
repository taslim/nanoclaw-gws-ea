import { afterEach, beforeEach, expect, it } from 'bun:test';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { cancelJob, relayCode } from './gws-ea-browser-delegate.js';

beforeEach(initTestSessionDb);
afterEach(closeSessionDb);

it('passes an exact thread to host cancellation and never models cancellation as an agent message', async () => {
  const waiting = cancelJob.handler({ thread: 'system:a2a:main:1', code: 'unrelated' });
  while (!getUndeliveredMessages().length) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  expect(row.kind).toBe('system');
  expect(JSON.parse(row.content)).toEqual({ action: 'cancel_job', requestId: row.id, thread: 'system:a2a:main:1' });
  getInboundDb()
    .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId: row.id,
        frame: { id: row.id, ok: true, data: { status: 'cancelled' } },
      }),
    );
  expect((await waiting).isError).not.toBe(true);
});

it('keeps relay_code in its host request and requires both thread and code before sending', async () => {
  expect((await relayCode.handler({ code: '123456' })).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);
  const waiting = relayCode.handler({ thread: 'system:a2a:main:1', code: '123456' });
  while (!getUndeliveredMessages().length) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  expect(JSON.parse(row.content)).toEqual({
    action: 'relay_code',
    requestId: row.id,
    thread: 'system:a2a:main:1',
    code: '123456',
  });
  getInboundDb()
    .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId: row.id,
        frame: { id: row.id, ok: true, data: { status: 'no_wait' } },
      }),
    );
  expect(JSON.stringify(await waiting)).not.toContain('123456');
});
