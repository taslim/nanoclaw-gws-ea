import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { isRecord } from '../../gws-ea/validation.js';
import { requestWake } from '../../request-wake.js';
import { writeSessionMessage } from '../../session-manager.js';
import { markBrowserRequestCommitStarted } from './db.js';
import {
  completePurchaseFacts,
  materialPurchaseChange,
  type PurchaseBounds,
  type PurchaseFacts,
} from './fingerprint.js';
import { readBrowserPolicy } from './policy.js';
import type { BrowserExecutionContext } from './queue.js';
import type { WatchBounds } from './watches.js';

export interface SpendingAuthority {
  id: string;
  job_id: string;
  approval_id: string | null;
  card_id: string | null;
  kind: 'checkout' | 'watch' | 'reservation_guarantee';
  state: 'live' | 'committing' | 'committed' | 'unknown' | 'revoked';
  facts_json: string;
  bounds_json: string;
  exception_ids_json: string;
  guarantee_id: string | null;
  watch_id: string | null;
  attempt_id: string;
  expires_at: string;
  created_at: string;
  commit_started_at: string | null;
  commit_request_id: string | null;
  outcome_json: string | null;
  notified_at: string | null;
}
interface NewSpendingAuthorityFacts {
  id: string;
  jobId: string;
  facts: PurchaseFacts;
  bounds: PurchaseBounds;
  attemptId: string;
  expiresAt: string;
  exceptionIds?: string[];
}
export type NewSpendingAuthority = NewSpendingAuthorityFacts &
  (
    | { kind: 'checkout'; approvalId: string; cardId: string; guaranteeId?: never }
    | { kind: 'watch'; watchId: string; approvalId?: string; cardId?: never; guaranteeId?: never }
    | { kind: 'reservation_guarantee'; guaranteeId: string; approvalId?: never; cardId?: never }
  );
export class PurchaseAuthorityError extends Error {
  constructor(
    readonly reason: 'authority_unavailable' | 'purchase_blocked' | 'changed' | 'expired' | 'cancelled',
    message: string = reason,
  ) {
    super(message);
  }
}
export class PurchaseAuthorityStore {
  constructor(readonly db: DbDriver = getDb()) {}
  get(id: string): Promise<SpendingAuthority | undefined> {
    return this.db.get('SELECT * FROM gws_ea_browser_authorities WHERE id = ?', id);
  }
  liveForJob(jobId: string): Promise<SpendingAuthority | undefined> {
    return this.db.get(
      "SELECT * FROM gws_ea_browser_authorities WHERE job_id = ? AND state = 'live' ORDER BY created_at DESC LIMIT 1",
      jobId,
    );
  }
  async unresolved(site: string): Promise<string[]> {
    return (
      await this.db.all<{ id: string }>(
        'SELECT id FROM gws_ea_browser_purchase_attempts WHERE site = ? AND resolution IS NULL ORDER BY id',
        site,
      )
    ).map((row) => row.id);
  }
  async create(input: NewSpendingAuthority): Promise<SpendingAuthority> {
    if (!completePurchaseFacts(input.facts)) throw new Error('Complete host-read purchase facts are required');
    return this.db.transaction(async () => {
      const existing = await this.get(input.id);
      if (existing) return existing;
      const job = await this.db.get<{ cancelled: number; cancel_requested: number }>(
        'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
        input.jobId,
      );
      if (!job || job.cancelled || job.cancel_requested) throw new PurchaseAuthorityError('cancelled');
      if (input.kind === 'checkout') {
        const card = await this.db.get<{
          job_id: string;
          facts_json: string;
          bounds_json: string;
          expires_at: string;
          status: string;
        }>(
          'SELECT job_id,facts_json,bounds_json,expires_at,status FROM gws_ea_browser_purchase_cards WHERE id = ?',
          input.cardId,
        );
        const grant = await this.db.get<{ payload: string; action: string }>(
          'SELECT payload,action FROM pending_approvals WHERE approval_id = ?',
          input.approvalId,
        );
        const payload: unknown = grant ? JSON.parse(grant.payload) : undefined;
        if (
          !card ||
          card.job_id !== input.jobId ||
          !['open', 'approved'].includes(card.status) ||
          card.facts_json !== JSON.stringify(input.facts) ||
          card.bounds_json !== JSON.stringify(input.bounds) ||
          card.expires_at !== input.expiresAt ||
          grant?.action !== 'browser_purchase' ||
          !isRecord(payload) ||
          payload.cardId !== input.cardId ||
          payload.jobId !== input.jobId
        )
          throw new PurchaseAuthorityError('authority_unavailable');
      } else if (input.kind === 'watch') {
        const { getBrowserWatch, compareWatchBounds } = await import('./watches.js');
        const watch = await getBrowserWatch(input.watchId, this.db);
        const bounds: unknown = watch ? JSON.parse(watch.bounds_json) : undefined;
        if (
          !watch ||
          watch.job_id !== input.jobId ||
          !['armed', 'preparing'].includes(watch.status) ||
          !input.bounds.reservation ||
          watch.approval_id !== (input.approvalId ?? null) ||
          compareWatchBounds(JSON.parse(watch.bounds_json) as WatchBounds, input.facts, new Date().toISOString())
            .status !== 'within_bounds'
        )
          throw new PurchaseAuthorityError('authority_unavailable');
        if (input.approvalId) {
          const approval: unknown = watch.approval_json ? JSON.parse(watch.approval_json) : undefined;
          if (
            !isRecord(approval) ||
            approval.approval_id !== input.approvalId ||
            approval.action !== 'browser_watch_setup' ||
            typeof approval.payload !== 'string'
          )
            throw new PurchaseAuthorityError('authority_unavailable');
          const payload: unknown = JSON.parse(approval.payload);
          if (
            !isRecord(payload) ||
            payload.watchId !== watch.id ||
            payload.jobId !== input.jobId ||
            JSON.stringify(payload.bounds) !== JSON.stringify(bounds)
          )
            throw new PurchaseAuthorityError('authority_unavailable');
        } else {
          const { isFreeReservation } = await import('./fingerprint.js');
          if (
            !isFreeReservation(input.facts) ||
            !isRecord(bounds) ||
            !isRecord(bounds.financial) ||
            bounds.financial.freeOnly !== true
          )
            throw new PurchaseAuthorityError('authority_unavailable');
        }
      } else {
        const grant = await this.db.get<{ revoked_at: string | null }>(
          'SELECT revoked_at FROM gws_ea_browser_reservation_guarantees WHERE id = ?',
          input.guaranteeId,
        );
        if (!grant || grant.revoked_at) throw new PurchaseAuthorityError('authority_unavailable');
      }
      const at = new Date().toISOString();
      if (input.expiresAt <= at) throw new PurchaseAuthorityError('expired');
      await this.db.run(
        `INSERT INTO gws_ea_browser_authorities
        (id,job_id,approval_id,card_id,kind,state,facts_json,bounds_json,exception_ids_json,guarantee_id,watch_id,attempt_id,expires_at,created_at)
        VALUES(?,?,?,?,?,'live',?,?,?,?,?,?,?,?)`,
        input.id,
        input.jobId,
        input.approvalId ?? null,
        input.cardId ?? null,
        input.kind,
        JSON.stringify(input.facts),
        JSON.stringify(input.bounds),
        JSON.stringify([...(input.exceptionIds ?? [])].sort()),
        input.guaranteeId ?? null,
        input.kind === 'watch' ? input.watchId : null,
        input.attemptId,
        input.expiresAt,
        at,
      );
      const row = await this.get(input.id);
      if (!row) throw new Error('Authority was not persisted');
      return row;
    });
  }
  /** Common purchase/watch boundary. Caller already owns the job worker lock; never lock it again. */
  async begin(
    context: BrowserExecutionContext,
    authorityId: string,
    current: PurchaseFacts,
    claim?: (db: DbDriver, authority: SpendingAuthority, immediatelyRereadFacts: PurchaseFacts) => Promise<void>,
  ): Promise<SpendingAuthority> {
    await context.assertActive();
    if (!(await readBrowserPolicy()).enabled) throw new PurchaseAuthorityError('authority_unavailable');
    return this.db.transaction(async () => {
      const authority = await this.get(authorityId);
      const at = new Date().toISOString();
      if (!authority || authority.state !== 'live' || authority.job_id !== context.job.id)
        throw new PurchaseAuthorityError('authority_unavailable');
      const job = await this.db.get<{ cancelled: number; cancel_requested: number }>(
        'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
        context.job.id,
      );
      if (!job || job.cancelled || job.cancel_requested) throw new PurchaseAuthorityError('cancelled');
      if (authority.expires_at <= at) throw new PurchaseAuthorityError('expired');
      const change = materialPurchaseChange(
        JSON.parse(authority.facts_json) as PurchaseFacts,
        current,
        JSON.parse(authority.bounds_json) as PurchaseBounds,
      );
      if (change) throw new PurchaseAuthorityError('changed', change);
      if (!completePurchaseFacts(current))
        throw new PurchaseAuthorityError('changed', 'The financial terms are unavailable.');
      if (authority.guarantee_id) {
        const grant = await this.db.get<{ revoked_at: string | null }>(
          'SELECT revoked_at FROM gws_ea_browser_reservation_guarantees WHERE id = ?',
          authority.guarantee_id,
        );
        if (!grant || grant.revoked_at) throw new PurchaseAuthorityError('authority_unavailable');
      }
      const unresolved = await this.unresolved(current.site);
      const exceptions = JSON.parse(authority.exception_ids_json) as string[];
      const block = await this.db.get('SELECT site FROM gws_ea_browser_purchase_blocks WHERE site = ?', current.site);
      if ((block && !unresolved.length) || unresolved.some((id) => !exceptions.includes(id)))
        throw new PurchaseAuthorityError('purchase_blocked');
      const lease = await this.db.get<{ job_id: string }>(
        'SELECT job_id FROM gws_ea_browser_site_leases WHERE site = ?',
        current.site,
      );
      if (lease?.job_id !== context.job.id) throw new PurchaseAuthorityError('authority_unavailable');
      const request = await context.store.request(context.request.id);
      if (
        !request ||
        request.answered_at ||
        request.commit_started_at ||
        context.signal.aborted ||
        !context.remaining()
      )
        throw new PurchaseAuthorityError('authority_unavailable');
      if (claim) await claim(this.db, authority, current);
      const changed = await this.db.run(
        "UPDATE gws_ea_browser_authorities SET state = 'committing',commit_started_at = ?,commit_request_id = ? WHERE id = ? AND state = 'live'",
        at,
        context.request.id,
        authority.id,
      );
      if (!changed.changes) throw new PurchaseAuthorityError('authority_unavailable');
      await markBrowserRequestCommitStarted(this.db, context.request.id, at);
      // The attempted facts include a lower actual retail total, rather than the card's ceiling.
      await this.db.run(
        `INSERT INTO gws_ea_browser_purchase_attempts(id,authority_id,job_id,site,facts_json,attempted_at)
        VALUES(?,?,?,?,?,?)`,
        authority.attempt_id,
        authority.id,
        authority.job_id,
        current.site,
        JSON.stringify(current),
        at,
      );
      return { ...authority, state: 'committing', commit_started_at: at, commit_request_id: context.request.id };
    });
  }
  async conclude(id: string, outcome: Record<string, unknown>, certain: boolean): Promise<void> {
    await this.db.transaction(async () => {
      const authority = await this.get(id);
      if (!authority || !['committing', 'unknown'].includes(authority.state)) return;
      const at = new Date().toISOString();
      await this.db.run(
        'UPDATE gws_ea_browser_authorities SET state = ?,outcome_json = ?,notified_at = NULL WHERE id = ?',
        certain ? 'committed' : 'unknown',
        JSON.stringify(outcome),
        id,
      );
      if (certain) {
        const record = isRecord(outcome.evidence) ? outcome.evidence : undefined;
        if (typeof record?.recordId !== 'string' || typeof record.account !== 'string')
          throw new Error('A verified merchant record is required.');
        await this.db.run(
          "UPDATE gws_ea_browser_purchase_attempts SET resolution = 'committed',evidence_json = ?,reconciled_at = ?,merchant_record_id = ?,merchant_account = ? WHERE authority_id = ?",
          JSON.stringify(outcome),
          at,
          record.recordId,
          record.account,
          id,
        );
        const facts = JSON.parse(authority.facts_json) as PurchaseFacts;
        if (!(await this.unresolved(facts.site)).length)
          await this.db.run('DELETE FROM gws_ea_browser_purchase_blocks WHERE site = ?', facts.site);
      } else {
        const facts = JSON.parse(authority.facts_json) as PurchaseFacts;
        await this.db.run(
          'INSERT INTO gws_ea_browser_purchase_blocks(site,created_at) VALUES(?,?) ON CONFLICT(site) DO NOTHING',
          facts.site,
          at,
        );
      }
      if (authority.watch_id) {
        const { finishWatchPurchase } = await import('./watches.js');
        await finishWatchPurchase(this.db, authority.watch_id, authority.attempt_id, outcome);
      }
      await this.db.run('DELETE FROM gws_ea_browser_pending_commits WHERE authority_id = ?', id);
      const committing = await this.db.get(
        "SELECT 1 FROM gws_ea_browser_authorities WHERE job_id = ? AND state = 'committing' LIMIT 1",
        authority.job_id,
      );
      if (!committing)
        await this.db.run(
          'UPDATE gws_ea_browser_jobs SET cancelled = CASE WHEN cancel_requested = 1 THEN 1 ELSE cancelled END,updated_at = ? WHERE id = ?',
          at,
          authority.job_id,
        );
    });
  }
}

/** Deterministic mailbox ids make a crash between insertion and notified_at harmless. */
export async function notifyPurchaseOutcome(authorityId: string, store = new PurchaseAuthorityStore()): Promise<void> {
  const authority = await store.get(authorityId);
  if (!authority?.outcome_json || authority.notified_at) return;
  const job = await store.db.get<{ browser_session_id: string }>(
    'SELECT browser_session_id FROM gws_ea_browser_jobs WHERE id = ?',
    authority.job_id,
  );
  const session = job ? await getSession(job.browser_session_id) : undefined;
  if (!session) return;
  const outcome = JSON.parse(authority.outcome_json) as Record<string, unknown>;
  const status =
    authority.watch_id && outcome.status === 'placed'
      ? 'booked'
      : typeof outcome.status === 'string'
        ? outcome.status
        : 'outcome_unknown';
  const facts = JSON.parse(authority.facts_json) as PurchaseFacts;
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `browser-purchase-${authority.id}-${status}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      trigger: true,
      content: JSON.stringify({
        type: 'browser_purchase_outcome',
        job: authority.job_id,
        attempt_id: authority.attempt_id,
        ...outcome,
        status,
        ...(authority.watch_id
          ? {
              type: 'browser_watch_outcome',
              watch_id: authority.watch_id,
              reservation: facts.reservation,
              commitments: facts.commitments,
            }
          : {}),
      }),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  await store.db.run(
    'UPDATE gws_ea_browser_authorities SET notified_at = ? WHERE id = ? AND outcome_json = ?',
    new Date().toISOString(),
    authority.id,
    authority.outcome_json,
  );
  void requestWake(session, 'browser-purchase-outcome').catch(() => undefined);
}
