import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const ROOT = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return `${tmpdir()}/browser-guarantee-tests`;
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { finalizeReject } from '../approvals/finalize.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import './index.js';
import { guaranteeCoversReservation } from './fingerprint.js';
import { reservationGuaranteeRequest } from './reservation-guarantee.js';
import type { PurchaseBounds, PurchaseFacts } from './fingerprint.js';
const bounds: PurchaseBounds = {
  reservation: {
    venueId: 'bistro-123',
    partySize: 4,
    windowStart: '2026-10-20T18:00:00.000Z',
    windowEnd: '2026-10-20T21:00:00.000Z',
  },
};
const facts: PurchaseFacts = {
  flowId: 'reviewed-reservation',
  site: 'restaurant.example',
  origin: 'https://restaurant.example',
  control: { selector: '#confirm', label: 'Confirm reservation', formAction: 'https://restaurant.example/confirm' },
  account: 'Morgan',
  items: [{ id: 'bistro-123', title: 'Dinner for four', quantity: 1 }],
  currency: 'USD',
  totalMinor: 7500,
  dueNowMinor: 0,
  cardEnding: '4242',
  address: 'Morgan',
  reservation: {
    venueId: 'bistro-123',
    venueName: 'Bistro',
    partySize: 4,
    at: '2026-10-20T19:30:00.000Z',
    endAt: '2026-10-20T21:00:00.000Z',
    timeZone: 'UTC',
  },
  commitments: [
    {
      kind: 'conditional_fee',
      amountMinor: 7500,
      trigger: 'No-show',
      conditionalTrigger: 'no_show',
      cancellationDeadline: '2026-10-19T19:30:00.000Z',
      cancellationTerms: 'Cancel before the deadline for no fee',
      terms: '$75 total if you do not attend',
    },
  ],
};
describe('standing reservation guarantee coverage', () => {
  it('covers only an explicit total ceiling and delegated reservation bounds', () => {
    expect(
      guaranteeCoversReservation({ currency: 'USD', max_total_minor: 10000, revoked_at: null }, facts, bounds),
    ).toBe(true);
    expect(guaranteeCoversReservation(undefined, facts, bounds)).toBe(false);
    expect(guaranteeCoversReservation({ currency: 'USD', max_total_minor: 10000, revoked_at: null }, facts, {})).toBe(
      false,
    );
  });
  it.each(['hold', 'deposit', 'prepayment', 'trial', 'subscription'] as const)(
    'requires separate approval for %s',
    (kind) => {
      expect(
        guaranteeCoversReservation(
          { currency: 'USD', max_total_minor: 10000, revoked_at: null },
          { ...facts, commitments: [{ ...facts.commitments[0], kind }] },
          bounds,
        ),
      ).toBe(false);
    },
  );
  it('does not cover another conditional trigger merely because seller prose mentions no-shows', () => {
    expect(
      guaranteeCoversReservation(
        { currency: 'USD', max_total_minor: 10000, revoked_at: null },
        {
          ...facts,
          commitments: [
            { ...facts.commitments[0], trigger: 'Damage, cancellation or no-show', conditionalTrigger: undefined },
          ],
        },
        bounds,
      ),
    ).toBe(false);
  });
  it('multiplies a per-person fee and rejects currency, unreadable terms, immediate payment and revoked permission', () => {
    const grant = { currency: 'USD', max_total_minor: 10000, revoked_at: null };
    expect(
      guaranteeCoversReservation(
        grant,
        { ...facts, commitments: [{ ...facts.commitments[0], amountMinor: 5000, perPerson: true }] },
        bounds,
      ),
    ).toBe(false);
    expect(guaranteeCoversReservation(grant, { ...facts, currency: 'EUR' }, bounds)).toBe(false);
    expect(guaranteeCoversReservation(grant, { ...facts, dueNowMinor: 1 }, bounds)).toBe(false);
    expect(
      guaranteeCoversReservation(
        grant,
        { ...facts, commitments: [{ ...facts.commitments[0], cancellationDeadline: undefined }] },
        bounds,
      ),
    ).toBe(false);
    expect(guaranteeCoversReservation({ ...grant, revoked_at: '2026-10-19T00:00:00.000Z' }, facts, bounds)).toBe(false);
  });
});

describe('a standing guarantee the principal declines', () => {
  const PRINCIPAL = 'gchat:users/morgan';
  let main: Session;

  beforeEach(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${ROOT}/browser/policy.json`, JSON.stringify({ schemaVersion: 1, enabled: true }), {
      mode: 0o600,
    });
    process.env.GWS_EA_BROWSER_POLICY_FILE = `${ROOT}/browser/policy.json`;
    await runMigrations(await initTestDb());
    const at = new Date().toISOString();
    for (const id of ['rg-main', 'rg-browser'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: at });
    await getDb().run(
      'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
      'rg-main',
      'rg-browser',
    );
    await createMessagingGroup({
      id: 'rg-dm',
      channel_type: 'gchat',
      platform_id: 'spaces/morgan',
      name: 'Morgan',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: at,
    });
    await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: at });
    await upsertUserDm({ user_id: PRINCIPAL, channel_type: 'gchat', messaging_group_id: 'rg-dm', resolved_at: at });
    await bindVerifiedPrincipalUser(PRINCIPAL, at);
    setDeliveryAdapter({ deliver: async () => 'guarantee-card' });
    main = (await resolveSession('rg-main', 'rg-dm', null, 'agent-shared')).session;
  });
  afterEach(async () => {
    delete process.env.GWS_EA_BROWSER_POLICY_FILE;
    await closeDb();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  /** Main proposes a standing guarantee, and the principal's card waits. */
  async function propose(requestId: string, maxTotal: string): Promise<PendingApproval> {
    const proposed = await reservationGuaranteeRequest(
      { action: 'reservation_guarantee', requestId, operation: 'propose', currency: 'USD', max_total: maxTotal },
      main,
      requestId,
    );
    expect(proposed).toEqual({ status: 'awaiting_principal' });
    const [approval] = await getDb().all<PendingApproval>('SELECT * FROM pending_approvals');
    return approval;
  }
  async function answer(approval: PendingApproval, value: 'approve' | 'reject'): Promise<void> {
    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value,
      userId: PRINCIPAL,
      channelType: 'gchat',
      platformId: 'spaces/morgan',
      threadId: null,
    });
  }
  /** What the host told main as a system note. */
  function notes(): string[] {
    const db = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
    try {
      return (db.prepare('SELECT content FROM messages_in ORDER BY seq').all() as Array<{ content: string }>)
        .map((row) => JSON.parse(row.content) as { sender?: string; text?: string })
        .filter((content) => content.sender === 'system')
        .map((content) => content.text ?? '');
    } finally {
      db.close();
    }
  }

  it('tells main the principal declined, and that a reservation with a fee still comes to them on its own card', async () => {
    await answer(await propose('first', '100.00'), 'reject');
    const note = notes().at(-1) ?? '';
    expect(note).toBe(
      'The principal declined to allow reservation guarantees of up to $100.00 (USD). A reservation with a cancellation or no-show fee still goes to them on its own card.',
    );
    expect(note).not.toMatch(/admin|browser_reservation_guarantee|guarantee-[0-9a-f]|appr-/u);
    expect(await getDb().all('SELECT * FROM gws_ea_browser_reservation_guarantees')).toEqual([]);
  });

  it('carries the reason the principal gave, and keeps the guarantee they already allow', async () => {
    await answer(await propose('first', '50.00'), 'approve');
    await finalizeReject(await propose('raise', '200.00'), PRINCIPAL, 'keep it at fifty');
    expect(notes().at(-1)).toBe(
      'The principal declined to allow reservation guarantees of up to $200.00 (USD): "keep it at fifty". The guarantee they already allow, up to $50.00 (USD), stays as it is.',
    );
    expect(await getDb().all('SELECT max_total_minor FROM gws_ea_browser_reservation_guarantees')).toEqual([
      { max_total_minor: 5000 },
    ]);
  });
});
