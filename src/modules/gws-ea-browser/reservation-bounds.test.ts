import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return `${tmpdir()}/browser-reservation-bounds-tests`;
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDeliveryAction } from '../../delivery.js';
import { resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import type { ResponseFrame } from '../../cli/frame.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore } from './db.js';
import { PurchaseAuthorityStore } from './authority.js';
import type { PurchaseFacts } from './fingerprint.js';
import { deriveReservationGuaranteeAuthority } from './reservation-guarantee.js';

let main: Session;
let browser: Session;
let requestNumber = 0;
const reservation = {
  venueId: '25973',
  partySize: 2,
  windowStart: '2030-10-17T18:00:00.000Z',
  windowEnd: '2030-10-17T21:00:00.000Z',
};
const facts: PurchaseFacts = {
  flowId: 'resy-diner-v1',
  site: 'resy.com',
  origin: 'https://resy.com',
  control: { selector: '#reserve', label: 'Reserve Now', formAction: 'https://resy.com/reservation-details' },
  account: 'Morgan',
  items: [{ id: '25973', title: 'Dinner', quantity: 1 }],
  currency: 'USD',
  totalMinor: 7500,
  dueNowMinor: 0,
  cardEnding: '4242',
  address: null,
  reservation: {
    venueId: '25973',
    venueName: "L'Artusi",
    partySize: 2,
    at: '2030-10-17T19:00:00.000Z',
    endAt: '2030-10-17T20:00:00.000Z',
    timeZone: 'America/New_York',
  },
  commitments: [
    {
      kind: 'conditional_fee',
      amountMinor: 7500,
      terms: '$75 total for a no-show',
      trigger: 'No-show',
      conditionalTrigger: 'no_show',
      cancellationDeadline: '2030-10-16T19:00:00.000Z',
      cancellationTerms: 'Cancel before the deadline for no fee',
    },
  ],
};

async function recordBounds(changes: Record<string, unknown> = {}, caller = main): Promise<ResponseFrame> {
  const handler = getDeliveryAction('reservation_bounds');
  expect(handler).toBeDefined();
  const requestId = `bounds-${++requestNumber}`;
  await handler!(
    {
      action: 'reservation_bounds',
      requestId,
      thread: browser.thread_id!,
      venue_id: reservation.venueId,
      party_size: reservation.partySize,
      window_start: reservation.windowStart,
      window_end: reservation.windowEnd,
      ...changes,
    },
    caller,
  );
  const row = await withExistingMailboxSession(
    caller.agent_group_id,
    caller.id,
    (mailbox) => mailbox.getInboundMessages([`action-resp-${requestId}`])[0],
  );
  if (!row) throw new Error('No host response');
  return (JSON.parse(row.content) as { frame: ResponseFrame }).frame;
}
beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const id of ['bounds-main', 'bounds-browser'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id=?,browser_agent_group_id=? WHERE singleton=1',
    'bounds-main',
    'bounds-browser',
  );
  main = (await resolveSystemSession('bounds-main', 'system:bounds-source')).session;
  browser = (await resolveSystemSession('bounds-browser', 'system:a2a:bounds-main:reservation')).session;
  await new BrowserStore().jobForSession(browser);
  fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });
  const policy = `${root}/browser/policy.json`;
  fs.writeFileSync(policy, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }), {
    mode: 0o600,
  });
  process.env.GWS_EA_BROWSER_POLICY_FILE = policy;
  await getDb().run(
    'INSERT INTO gws_ea_browser_reservation_guarantees(id,approval_id,principal_user_id,currency,max_total_minor,created_at) VALUES(?,?,?,?,?,?)',
    'standing',
    'principal-approval',
    'principal',
    'USD',
    10000,
    new Date().toISOString(),
  );
});
afterEach(async () => {
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

it('never treats browser/page-supplied bounds as delegation when the host has no main-recorded scope', async () => {
  expect(
    await deriveReservationGuaranteeAuthority(browser.thread_id!, 'attempt', facts, { reservation }),
  ).toBeUndefined();
  expect(await getDb().all('SELECT * FROM gws_ea_browser_authorities')).toHaveLength(0);
});
it('uses only main-recorded bounds and refuses a different venue, party or time', async () => {
  expect(await recordBounds()).toMatchObject({ ok: true });
  for (const change of [{ venueId: 'other' }, { partySize: 4 }, { at: '2030-10-18T19:00:00.000Z' }]) {
    const outside = { ...facts, reservation: { ...facts.reservation!, ...change } };
    const forged = { reservation: { ...reservation, ...change, windowEnd: '2031-01-01T00:00:00.000Z' } };
    expect(await deriveReservationGuaranteeAuthority(browser.thread_id!, 'outside', outside, forged)).toBeUndefined();
  }
  const authority = await deriveReservationGuaranteeAuthority(browser.thread_id!, 'inside', facts, {});
  expect(authority).toMatchObject({ job_id: browser.thread_id!, kind: 'reservation_guarantee', state: 'live' });
  expect(JSON.parse(authority!.bounds_json)).toEqual({ reservation });
});
it('binds one guarantee-backed booking to the job, even across request ids and renewed standing grants', async () => {
  expect(await recordBounds()).toMatchObject({ ok: true });
  const first = await deriveReservationGuaranteeAuthority(browser.thread_id!, 'first', facts, {});
  expect(first).toBeDefined();
  expect((await deriveReservationGuaranteeAuthority(browser.thread_id!, 'retry', facts, {}))?.id).toBe(first!.id);
  await getDb().run("UPDATE gws_ea_browser_authorities SET state='committed' WHERE id=?", first!.id);
  await getDb().run(
    "UPDATE gws_ea_browser_reservation_guarantees SET revoked_at=? WHERE id='standing'",
    new Date().toISOString(),
  );
  await getDb().run(
    'INSERT INTO gws_ea_browser_reservation_guarantees(id,approval_id,principal_user_id,currency,max_total_minor,created_at) VALUES(?,?,?,?,?,?)',
    'renewed',
    'new-principal-approval',
    'principal',
    'USD',
    10000,
    new Date().toISOString(),
  );
  expect(await deriveReservationGuaranteeAuthority(browser.thread_id!, 'second', facts, {})).toBeUndefined();
  expect(await getDb().all('SELECT * FROM gws_ea_browser_authorities')).toHaveLength(1);
});
it.each(['open', 'rejected', 'expired'] as const)(
  'keeps a checkout decision authoritative when main records scope later (%s)',
  async (status) => {
    await getDb().run(
      'INSERT INTO gws_ea_browser_purchase_cards(id,job_id,request_id,status,facts_json,bounds_json,exception_ids_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      'checkout-card',
      browser.thread_id!,
      'before-bounds',
      status,
      JSON.stringify(facts),
      '{}',
      '[]',
      new Date(Date.now() + 60_000).toISOString(),
      new Date().toISOString(),
    );
    expect(await recordBounds()).toMatchObject({ ok: true });
    expect(await deriveReservationGuaranteeAuthority(browser.thread_id!, 'retry', facts, {})).toBeUndefined();
    await expect(
      new PurchaseAuthorityStore().create({
        id: 'direct-child',
        jobId: browser.thread_id!,
        kind: 'reservation_guarantee',
        guaranteeId: 'standing',
        facts,
        bounds: { reservation },
        attemptId: 'direct-attempt',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ reason: 'authority_unavailable' });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_authorities')).toHaveLength(0);
    expect(await getDb().get('SELECT status FROM gws_ea_browser_purchase_cards')).toEqual({ status });
  },
);
it('keeps identical scope idempotent and refuses changes once reservation authority exists', async () => {
  expect(await recordBounds()).toMatchObject({ ok: true });
  expect(await deriveReservationGuaranteeAuthority(browser.thread_id!, 'first', facts, {})).toBeDefined();
  expect(await recordBounds()).toMatchObject({ ok: true });
  expect(await recordBounds({ party_size: 4 })).toMatchObject({ ok: false });
  expect(await getDb().get('SELECT bounds_json FROM gws_ea_browser_reservation_bounds')).toEqual({
    bounds_json: JSON.stringify(reservation),
  });
});
it('retains the one-booking boundary after a started authority is revoked', async () => {
  expect(await recordBounds()).toMatchObject({ ok: true });
  const first = await deriveReservationGuaranteeAuthority(browser.thread_id!, 'first', facts, {});
  expect(first).toBeDefined();
  await getDb().run(
    "UPDATE gws_ea_browser_authorities SET state='revoked',commit_started_at=? WHERE id=?",
    new Date().toISOString(),
    first!.id,
  );
  expect(await deriveReservationGuaranteeAuthority(browser.thread_id!, 'second', facts, {})).toBeUndefined();
  expect(await recordBounds({ party_size: 4 })).toMatchObject({ ok: false });
  expect(await getDb().all('SELECT * FROM gws_ea_browser_authorities')).toHaveLength(1);
});
it('refuses the browser, foreign threads and malformed bounds without recording scope', async () => {
  expect(await recordBounds({}, browser)).toMatchObject({ ok: false });
  expect(await recordBounds({ thread: 'system:a2a:someone:foreign' })).toMatchObject({ ok: false });
  for (const change of [
    { party_size: 0 },
    { venue_id: '' },
    { window_end: reservation.windowStart },
    { window_start: 'tomorrow' },
    { extra: true },
  ])
    expect(await recordBounds(change)).toMatchObject({ ok: false });
  expect(await getDb().all('SELECT * FROM gws_ea_browser_reservation_bounds')).toHaveLength(0);
});
