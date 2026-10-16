import { afterEach, beforeEach, expect, it } from 'bun:test';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import Ajv from 'ajv';
import {
  cancelJob,
  credentialAuthority,
  relayCode,
  reservationGuarantee,
  reservationBounds,
  vaultAccess,
} from './gws-ea-browser-delegate.js';

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

it('keeps reservation guarantees main-only at the host and exposes a closed explicit-amount schema', () => {
  const validate = new Ajv().compile(reservationGuarantee.tool.inputSchema);
  for (const fields of [
    { operation: 'read' },
    { operation: 'revoke' },
    { operation: 'propose', currency: 'USD', max_total: '100.00' },
  ])
    expect(validate(fields)).toBe(true);
  for (const fields of [
    {},
    { operation: 'propose' },
    { operation: 'propose', currency: 'USD' },
    { operation: 'propose', max_total: '100.00' },
    { operation: 'read', max_total: '100.00' },
    { operation: 'approve', currency: 'USD', max_total: '100.00' },
    { operation: 'propose', currency: 'USD', max_total: 100 },
    { operation: 'propose', currency: 'USD', max_total: '100.00', approved: true },
  ])
    expect(validate(fields)).toBe(false);
});

it('records delegated reservation bounds through the native host request with no model approval field', async () => {
  const fields = {
    thread: 'system:a2a:main:dinner',
    venue_id: '25973',
    party_size: 2,
    window_start: '2030-10-17T18:00:00.000Z',
    window_end: '2030-10-17T21:00:00.000Z',
  };
  const validate = new Ajv().compile(reservationBounds.tool.inputSchema);
  expect(validate(fields)).toBe(true);
  expect(validate({ ...fields, party_size: 0 })).toBe(false);
  expect(validate({ ...fields, approved: true })).toBe(false);
  const waiting = reservationBounds.handler(fields);
  while (!getUndeliveredMessages().length) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  expect(JSON.parse(row.content)).toEqual({ action: 'reservation_bounds', requestId: row.id, ...fields });
  getInboundDb()
    .prepare('INSERT INTO messages_in (id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId: row.id,
        frame: { id: row.id, ok: true, data: { status: 'recorded' } },
      }),
    );
  expect((await waiting).isError).not.toBe(true);
});

it('sends only the explicit guarantee proposal fields through the native request and reports its principal hold', async () => {
  const waiting = reservationGuarantee.handler({
    operation: 'propose',
    currency: 'USD',
    max_total: '100.00',
    principal_approved: true,
  });
  while (!getUndeliveredMessages().length) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  expect(JSON.parse(row.content)).toEqual({
    action: 'reservation_guarantee',
    requestId: row.id,
    operation: 'propose',
    currency: 'USD',
    max_total: '100.00',
  });
  getInboundDb()
    .prepare('INSERT INTO messages_in (id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId: row.id,
        frame: { id: row.id, ok: true, data: { status: 'awaiting_principal' } },
      }),
    );
  expect(JSON.stringify(await waiting)).toContain('awaiting_principal');
});

it('shares or refreshes the 1Password vault through the native host request, never with a chosen vault, account or permission', async () => {
  const validate = new Ajv().compile(vaultAccess.tool.inputSchema);
  for (const fields of [
    { operation: 'share' },
    { operation: 'share', email: 'morgan@example.test' },
    { operation: 'refresh' },
  ])
    expect(validate(fields)).toBe(true);
  for (const fields of [
    {},
    { operation: 'grant' },
    { operation: 'refresh', email: 'morgan@example.test' },
    { operation: 'share', vault_id: 'remyvancevault000000000002' },
    { operation: 'share', account_id: 'REMYVANCEACCOUNT0000000002' },
    { operation: 'share', permissions: ['allow_managing'] },
    { operation: 'share', email: 'morgan@example.test', principal_confirmed: true },
  ])
    expect(validate(fields)).toBe(false);

  expect((await vaultAccess.handler({ operation: 'refresh', email: 'morgan@example.test' })).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);

  const message = 'Could you give morgan@example.test view and edit access to the 1Password vault my assistant keeps?';
  const waiting = vaultAccess.handler({
    operation: 'share',
    email: 'morgan@example.test',
    vault_id: 'remyvancevault000000000002',
    permissions: ['allow_managing'],
  });
  while (!getUndeliveredMessages().length) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  expect(JSON.parse(row.content)).toEqual({
    action: 'vault_access',
    requestId: row.id,
    operation: 'share',
    email: 'morgan@example.test',
  });
  getInboundDb()
    .prepare('INSERT INTO messages_in (id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId: row.id,
        frame: {
          id: row.id,
          ok: true,
          data: {
            status: 'operator_needed',
            email: 'morgan@example.test',
            reason: 'not_a_member',
            operator_message: message,
          },
        },
      }),
    );
  const result = await waiting;
  expect(result.isError).not.toBe(true);
  // main reads the status beside the message it forwards as written.
  expect(JSON.stringify(result)).toContain('operator_needed');
  expect(JSON.stringify(result)).toContain(message);
});

it('records signup or password-change authority through the native host request, never another security change or a value', async () => {
  const validate = new Ajv().compile(credentialAuthority.tool.inputSchema);
  const fields = {
    thread: 'system:a2a:main:join',
    operation: 'signup',
    site: 'https://accounts.shop.example/join',
    username: 'morgan.ellery@example.com',
  };
  expect(validate(fields)).toBe(true);
  expect(validate({ ...fields, operation: 'change_password' })).toBe(true);
  for (const changed of [
    { ...fields, operation: 'change_email' },
    { ...fields, operation: 'disable_two_factor' },
    { ...fields, password: 'chosen-by-main' },
    { ...fields, approved: true },
    { thread: fields.thread, operation: 'signup', site: fields.site },
  ])
    expect(validate(changed)).toBe(false);
  const waiting = credentialAuthority.handler({ ...fields, password: 'chosen-by-main' });
  while (!getUndeliveredMessages().length) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  expect(JSON.parse(row.content)).toEqual({ action: 'credential_authority', requestId: row.id, ...fields });
  getInboundDb()
    .prepare('INSERT INTO messages_in (id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId: row.id,
        frame: { id: row.id, ok: true, data: { status: 'not_owned', reason: 'no_record' } },
      }),
    );
  expect(JSON.stringify(await waiting)).toContain('not_owned');
  for (const outcome of ['recorded', 'authority', 'not_owned', 'busy', 'vault_unavailable', 'rate_limited'])
    expect(credentialAuthority.tool.description).toContain(outcome);
});
