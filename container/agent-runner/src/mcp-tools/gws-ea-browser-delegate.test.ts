import { afterEach, beforeEach, expect, it } from 'bun:test';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import Ajv from 'ajv';
import {
  cancelJob,
  consentGrants,
  credentialAuthority,
  recordDisclosure,
  recordPurchaseOutcome,
  relayCode,
  reservationGuarantee,
  reservationBounds,
  vaultAccess,
} from './gws-ea-browser-delegate.js';
import type { McpToolDefinition } from './types.js';

beforeEach(initTestSessionDb);
afterEach(closeSessionDb);

/**
 * Call `tool`, answer its host request with `data`, and check that it sent
 * exactly that one request and returned the host's answer as written.
 */
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
  expect(getUndeliveredMessages()).toHaveLength(1);
  return { kind: row.kind, request: JSON.parse(row.content) as unknown, id: row.id };
}

it('passes an exact thread to host cancellation and never models cancellation as an agent message', async () => {
  const { kind, request, id } = await call(
    cancelJob,
    { thread: 'system:a2a:main:1', code: 'unrelated' },
    { status: 'cancelled' },
  );
  expect(kind).toBe('system');
  expect(request).toEqual({ action: 'cancel_job', requestId: id, thread: 'system:a2a:main:1' });
});

it('keeps relay_code in its host request and requires both thread and code before sending', async () => {
  expect((await relayCode.handler({ code: '123456' })).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);
  // The answer is the host's alone: the code never comes back to the agent.
  const { request, id } = await call(relayCode, { thread: 'system:a2a:main:1', code: '123456' }, { status: 'no_wait' });
  expect(request).toEqual({ action: 'relay_code', requestId: id, thread: 'system:a2a:main:1', code: '123456' });
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
  const { request, id } = await call(reservationBounds, fields, { status: 'recorded' });
  expect(request).toEqual({ action: 'reservation_bounds', requestId: id, ...fields });
});

it('sends only the explicit guarantee proposal fields through the native request and reports its principal hold', async () => {
  const { request, id } = await call(
    reservationGuarantee,
    { operation: 'propose', currency: 'USD', max_total: '100.00', principal_approved: true },
    { status: 'awaiting_principal' },
  );
  expect(request).toEqual({
    action: 'reservation_guarantee',
    requestId: id,
    operation: 'propose',
    currency: 'USD',
    max_total: '100.00',
  });
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

  // main reads the status beside the message it forwards as written.
  const message = 'Could you give morgan@example.test view and edit access to the 1Password vault my assistant keeps?';
  const { request, id } = await call(
    vaultAccess,
    {
      operation: 'share',
      email: 'morgan@example.test',
      vault_id: 'remyvancevault000000000002',
      permissions: ['allow_managing'],
    },
    { status: 'operator_needed', email: 'morgan@example.test', reason: 'not_a_member', operator_message: message },
  );
  expect(request).toEqual({ action: 'vault_access', requestId: id, operation: 'share', email: 'morgan@example.test' });
  // main's guidance branches on the reason, so the tool names each one it can receive.
  for (const reason of ['not_a_member', 'not_confirmed', 'refused', 'host_cannot_share', 'unconfirmed'])
    expect(vaultAccess.tool.description).toContain(reason);
  // On shared, main gives the principal the host's link and the vault's name.
  for (const field of ['link', 'vault_name']) expect(vaultAccess.tool.description).toContain(field);
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
  const { request, id } = await call(
    credentialAuthority,
    { ...fields, password: 'chosen-by-main' },
    { status: 'not_owned', reason: 'no_record' },
  );
  expect(request).toEqual({ action: 'credential_authority', requestId: id, ...fields });
  for (const outcome of ['recorded', 'authority', 'not_owned', 'busy', 'vault_unavailable', 'rate_limited'])
    expect(credentialAuthority.tool.description).toContain(outcome);
});

it("asks for the principal's release of an unresolved credential attempt by its job and authority alone", async () => {
  const validate = new Ajv().compile(credentialAuthority.tool.inputSchema);
  const fields = {
    thread: 'system:a2a:main:join',
    operation: 'release',
    authority: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
  };
  expect(validate(fields)).toBe(true);
  for (const changed of [
    { thread: fields.thread, operation: 'release' },
    { ...fields, site: 'https://accounts.shop.example' },
    { ...fields, username: 'morgan.ellery@example.com' },
    { ...fields, approved: true },
    {
      thread: fields.thread,
      operation: 'signup',
      site: 'https://accounts.shop.example',
      username: 'morgan.ellery@example.com',
      authority: fields.authority,
    },
  ])
    expect(validate(changed)).toBe(false);
  expect((await credentialAuthority.handler({ thread: fields.thread, operation: 'release' })).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);
  const { request, id } = await call(
    credentialAuthority,
    { ...fields, approved: true },
    { status: 'awaiting_principal' },
  );
  expect(request).toEqual({ action: 'credential_authority', requestId: id, ...fields });
  for (const outcome of ['release', 'awaiting_principal', 'not_releasable'])
    expect(credentialAuthority.tool.description).toContain(outcome);
});

it("lists or withdraws the principal's standing consent grants by id alone", async () => {
  const validate = new Ajv().compile(consentGrants.tool.inputSchema);
  for (const fields of [
    { operation: 'list' },
    { operation: 'list', site: 'shop.example' },
    { operation: 'withdraw', grant_id: 'consent-1' },
  ])
    expect(validate(fields)).toBe(true);
  for (const fields of [
    {},
    { operation: 'grant', grant_id: 'consent-1' },
    { operation: 'withdraw' },
    { operation: 'withdraw', grant_id: 'consent-1', site: 'shop.example' },
    { operation: 'list', grant_id: 'consent-1' },
    { operation: 'list', wording: 'I agree' },
  ])
    expect(validate(fields)).toBe(false);
  expect((await consentGrants.handler({ operation: 'withdraw' })).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);
  const { request, id } = await call(
    consentGrants,
    { operation: 'withdraw', grant_id: 'consent-1', approved: true },
    { status: 'withdrawn', grant_id: 'consent-1' },
  );
  expect(request).toEqual({ action: 'consent_grants', requestId: id, operation: 'withdraw', grant_id: 'consent-1' });
  for (const outcome of ['listed', 'withdrawn', 'not_found', 'grant_id', 'wording'])
    expect(consentGrants.tool.description).toContain(outcome);
});

it("records a disclosure of one stored value to one site for a job, by the value's id alone", async () => {
  const validate = new Ajv().compile(recordDisclosure.tool.inputSchema);
  const fields = { thread: 'system:a2a:main:dinner', site: 'https://osteria.example', value_id: 'pv-1a2b3c4d5e6f' };
  expect(validate(fields)).toBe(true);
  for (const changed of [
    { thread: fields.thread, site: fields.site },
    { thread: fields.thread, value_id: fields.value_id },
    { site: fields.site, value_id: fields.value_id },
    { ...fields, value: '+1 415 555 0134' },
    { ...fields, approved: true },
  ])
    expect(validate(changed)).toBe(false);
  expect((await recordDisclosure.handler({ thread: fields.thread, site: fields.site })).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);
  const { request, id } = await call(
    recordDisclosure,
    { ...fields, value: '+1 415 555 0134' },
    { status: 'recorded', site: 'osteria.example', value_id: fields.value_id, kind: 'phone' },
  );
  expect(request).toEqual({ action: 'record_disclosure', requestId: id, ...fields });
  for (const word of ['recorded', 'personal_data', 'private-values', 'value_id'])
    expect(recordDisclosure.tool.description).toContain(word);
});

it("records an unconfirmed purchase's outcome by the job's attempt id, with its source and no merchant facts", async () => {
  const validate = new Ajv().compile(recordPurchaseOutcome.tool.inputSchema);
  const fields = {
    thread: 'system:a2a:main:mugs',
    attempt_id: 'attempt-1a2b3c',
    outcome: 'not_placed',
    source: 'principal',
  };
  expect(validate(fields)).toBe(true);
  expect(validate({ ...fields, outcome: 'placed', source: 'email' })).toBe(true);
  for (const changed of [
    { ...fields, outcome: 'unknown' },
    { ...fields, source: 'browser' },
    { ...fields, order_number: 'HP-1042' },
    { thread: fields.thread, outcome: fields.outcome, source: fields.source },
    { attempt_id: fields.attempt_id, outcome: fields.outcome, source: fields.source },
  ])
    expect(validate(changed)).toBe(false);
  expect((await recordPurchaseOutcome.handler({ thread: fields.thread, outcome: 'placed' })).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);
  const { request, id } = await call(recordPurchaseOutcome, fields, {
    status: 'recorded',
    outcome: 'not_placed',
    source: 'principal',
  });
  expect(request).toEqual({ action: 'record_purchase_outcome', requestId: id, ...fields });
  for (const word of ['recorded', 'already_recorded', 'possible_duplicate', 'in_progress', 'email', 'principal'])
    expect(recordPurchaseOutcome.tool.description).toContain(word);
});
