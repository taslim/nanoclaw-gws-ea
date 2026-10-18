import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { writeBrowserNotice } from './notices.js';
import type { RecordedNotPlaced } from './cards.js';
import { agreementsGranted } from './consent.js';
import { markBrowserRequestCommitStarted } from './db.js';
import { heldCredentialSites } from './leases.js';
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
/** Where an attempt's outcome came from (KTD8): its page, a later step of its checkout, the merchant's email or the principal. */
export type ResolutionSource = 'page' | 'email' | 'principal' | 'step';

/** A purchase attempt, paid under an authority or free (KTD3), as the resolve function reads either. */
export interface PurchaseAttemptRow {
  readonly id: string;
  readonly kind: 'paid' | 'free';
  /** The paid attempt's authority; a free attempt has none. */
  readonly authority_id: string | null;
  readonly job_id: string;
  /** The merchant (KTD7). */
  readonly site: string;
  /** The contact email that keys a generic checkout's order numbers (KTD5). */
  readonly account_key: string | null;
  readonly facts_json: string;
  readonly attempted_at: string;
  readonly resolution: 'committed' | 'not_committed' | null;
  readonly resolution_source: ResolutionSource | null;
  readonly evidence_json: string | null;
  /** When it ended with no page proof either way: from then on main settles it (KTD8). */
  readonly unconfirmed_at: string | null;
  /** When its delegating group heard that it is unconfirmed. */
  readonly notified_at: string | null;
  /** The card that showed the principal main's recorded "not placed" for it (KTD9). */
  readonly answer_card_id: string | null;
}
const ATTEMPT_COLUMNS =
  'site,account_key,facts_json,attempted_at,resolution,resolution_source,evidence_json,unconfirmed_at,notified_at,answer_card_id';
const ATTEMPTS = `SELECT id,'paid' AS kind,authority_id,job_id,${ATTEMPT_COLUMNS} FROM gws_ea_browser_purchase_attempts
  UNION ALL SELECT id,'free' AS kind,NULL AS authority_id,job_id,${ATTEMPT_COLUMNS} FROM gws_ea_browser_free_attempts`;
const ATTEMPT_TABLES = {
  paid: 'gws_ea_browser_purchase_attempts',
  free: 'gws_ea_browser_free_attempts',
} as const satisfies Record<PurchaseAttemptRow['kind'], string>;

/** An attempt's outcome, as one source learned it. */
export interface AttemptResolution {
  readonly placed: boolean;
  readonly source: ResolutionSource;
  /** What showed it: the page's evidence, the step's, or whose answer main recorded. */
  readonly evidence: Record<string, unknown>;
  /**
   * The merchant's own record of it, under its account key: a page always names one for a placed purchase, while
   * an outcome from the merchant's email or the principal may name none (KTD8).
   */
  readonly record?: { readonly id: string; readonly account: string | null };
  /** What a paid attempt's job hears of it, as its authority's outcome; by default, the outcome and its source. */
  readonly outcome?: Record<string, unknown>;
}

/**
 * What resolving did: `resolved` this time; `already_resolved` when another source recorded it first, which
 * never changes; `record_used` when the merchant record already proves another attempt under the same account
 * key, so it proves nothing of this one.
 */
export type AttemptResolved =
  | { readonly status: 'resolved' | 'already_resolved' | 'record_used'; readonly attempt: PurchaseAttemptRow }
  | { readonly status: 'no_attempt' };

/** What a paid attempt with no page proof answers its job (KTD8). */
export function unconfirmedOutcome(attemptId: string): Record<string, unknown> {
  return { status: 'unconfirmed', attempt_id: attemptId, repeat_safe: false };
}

/** Telling of a committed outcome: what fails here is logged and the host's sweep tells it, never undoing the outcome. */
async function afterCommit(what: string, tell: () => Promise<void>): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- the outcome is committed: the sweep retries a notice that fails here */
  try {
    await tell();
  } catch (error) {
    log.warn(`${what} notice will be retried`, { error: error instanceof Error ? error.message : String(error) });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

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
  /** The attempts on `site`, paid or free, with no recorded outcome. */
  async unresolved(site: string): Promise<string[]> {
    return (
      await this.db.all<{ id: string }>(
        `SELECT id FROM gws_ea_browser_purchase_attempts WHERE site = ? AND resolution IS NULL
         UNION ALL SELECT id FROM gws_ea_browser_free_attempts WHERE site = ? AND resolution IS NULL ORDER BY id`,
        site,
        site,
      )
    ).map((row) => row.id);
  }
  attempt(id: string): Promise<PurchaseAttemptRow | undefined> {
    return this.db.get(`SELECT * FROM (${ATTEMPTS}) WHERE id = ?`, id);
  }
  /** A job's unconfirmed attempts, paid or free, oldest first: what main records outcomes against (KTD9). */
  unconfirmedOf(jobId: string): Promise<PurchaseAttemptRow[]> {
    return this.db.all(
      `SELECT * FROM (${ATTEMPTS}) WHERE job_id = ? AND resolution IS NULL AND unconfirmed_at IS NOT NULL ORDER BY attempted_at,id`,
      jobId,
    );
  }
  /** Attempts with no recorded outcome that were never marked unconfirmed: presses a stop cut off. */
  async unsettled(): Promise<string[]> {
    return (
      await this.db.all<{ id: string }>(
        `SELECT id FROM (${ATTEMPTS}) WHERE resolution IS NULL AND unconfirmed_at IS NULL ORDER BY attempted_at,id`,
      )
    ).map((row) => row.id);
  }
  /** The attempts on `site` main recorded as not placed that no card has shown the principal yet (KTD9). */
  async recordedNotPlaced(site: string): Promise<Array<RecordedNotPlaced & { readonly id: string }>> {
    return this.db.all(
      `SELECT id,attempted_at AS attemptedAt,resolution_source AS source FROM (${ATTEMPTS})
       WHERE site = ? AND resolution = 'not_committed' AND resolution_source IN ('email','principal') AND answer_card_id IS NULL
       ORDER BY attempted_at,id`,
      site,
    );
  }
  /** Marks main's recorded answers as shown on `cardId`, so the next card on the site does not repeat them. */
  async markRecordedShown(recorded: ReadonlyArray<{ readonly id: string }>, cardId: string): Promise<void> {
    for (const { id } of recorded) {
      const attempt = await this.attempt(id);
      if (attempt)
        await this.db.run(
          `UPDATE ${ATTEMPT_TABLES[attempt.kind]} SET answer_card_id = ? WHERE id = ? AND answer_card_id IS NULL`,
          cardId,
          id,
        );
    }
  }
  /**
   * Whether a purchase on `site` waits on an earlier one (KTD9): an attempt there with no recorded outcome that
   * the card's one-attempt exception does not name, or a site block no such attempt explains.
   */
  async waitsOnEarlier(site: string, exceptions: readonly string[] = []): Promise<boolean> {
    const unresolved = await this.unresolved(site);
    if (unresolved.length) return unresolved.some((id) => !exceptions.includes(id));
    return (await this.db.get('SELECT 1 FROM gws_ea_browser_purchase_blocks WHERE site = ?', site)) !== undefined;
  }
  /**
   * When a purchase on `site` waits on an earlier one, `jobId` waits for it: the host wakes it once no attempt
   * there is unresolved. Checked and recorded in one transaction, so no resolution slips between them.
   */
  async waitOnEarlier(jobId: string, site: string, exceptions: readonly string[] = []): Promise<boolean> {
    return this.db.transaction(async () => {
      if (!(await this.waitsOnEarlier(site, exceptions))) return false;
      await this.db.run(
        `INSERT INTO gws_ea_browser_purchase_waiters(site,job_id,requested_at) VALUES(?,?,?)
         ON CONFLICT(site,job_id) DO UPDATE SET requested_at = excluded.requested_at,released_at = NULL`,
        site,
        jobId,
        new Date().toISOString(),
      );
      return true;
    });
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
        const { guaranteeCoversReservation, readDelegatedReservationBounds } =
          await import('./reservation-guarantee.js');
        const grant = await this.db.get<{ currency: string; max_total_minor: number; revoked_at: string | null }>(
          'SELECT currency,max_total_minor,revoked_at FROM gws_ea_browser_reservation_guarantees WHERE id = ?',
          input.guaranteeId,
        );
        const reservation = await readDelegatedReservationBounds(input.jobId, this.db);
        const checkout = await this.db.get(
          'SELECT 1 FROM gws_ea_browser_purchase_cards WHERE job_id = ? LIMIT 1',
          input.jobId,
        );
        const prior = await this.db.get(
          "SELECT 1 FROM gws_ea_browser_authorities WHERE job_id = ? AND kind = 'reservation_guarantee' AND (state <> 'revoked' OR commit_started_at IS NOT NULL) LIMIT 1",
          input.jobId,
        );
        if (
          prior ||
          checkout ||
          !reservation ||
          JSON.stringify(input.bounds.reservation) !== JSON.stringify(reservation) ||
          !guaranteeCoversReservation(grant, input.facts, { ...input.bounds, reservation })
        )
          throw new PurchaseAuthorityError('authority_unavailable');
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
      await this.checkCurrentFacts(authority, current, context.job.id);
      // Another purchase on the merchant needs the principal's answer on its earlier ones, or the card's
      // one-attempt exception for them (KTD9).
      if (await this.waitsOnEarlier(current.site, JSON.parse(authority.exception_ids_json) as string[]))
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
      else if (current.reservation || current.generic?.booking) {
        // A booking a card or the standing guarantee covers on a region watch's site spends its one booking (KTD20).
        const { claimRegionWatchCommit } = await import('./watches.js');
        await claimRegionWatchCommit(this.db, {
          jobId: authority.job_id,
          site: current.site,
          attemptId: authority.attempt_id,
          requestId: context.request.id,
          at,
        });
      }
      const changed = await this.db.run(
        "UPDATE gws_ea_browser_authorities SET state = 'committing',commit_started_at = ?,commit_request_id = ? WHERE id = ? AND state = 'live'",
        at,
        context.request.id,
        authority.id,
      );
      if (!changed.changes) throw new PurchaseAuthorityError('authority_unavailable');
      await markBrowserRequestCommitStarted(this.db, context.request.id, at);
      // The attempted facts include a lower actual retail total, rather than the card's ceiling. A generic
      // checkout's attempt names its payment platform, and its contact email keys its order numbers (KTD5, KTD7).
      await this.db.run(
        `INSERT INTO gws_ea_browser_purchase_attempts(id,authority_id,job_id,site,facts_json,attempted_at,platform,account_key)
        VALUES(?,?,?,?,?,?,?,?)`,
        authority.attempt_id,
        authority.id,
        authority.job_id,
        current.site,
        JSON.stringify(current),
        at,
        current.generic?.platform ?? null,
        current.generic?.contactEmail ?? null,
      );
      return { ...authority, state: 'committing', commit_started_at: at, commit_request_id: context.request.id };
    });
  }
  /**
   * The facts a press carries against its authority: nothing material changed, the facts complete, every
   * agreement still granted (KTD11), and a standing guarantee still covering them.
   */
  private async checkCurrentFacts(authority: SpendingAuthority, current: PurchaseFacts, jobId: string): Promise<void> {
    const change = materialPurchaseChange(
      JSON.parse(authority.facts_json) as PurchaseFacts,
      current,
      JSON.parse(authority.bounds_json) as PurchaseBounds,
    );
    if (change) throw new PurchaseAuthorityError('changed', change);
    if (!completePurchaseFacts(current))
      throw new PurchaseAuthorityError('changed', 'The financial terms are unavailable.');
    // Every agreement the press carries stands approved, none withdrawn since the card (KTD11).
    if (current.agreements?.length && !(await agreementsGranted(this.db, current.site, current.agreements)))
      throw new PurchaseAuthorityError('changed', 'An agreement on this checkout is no longer approved.');
    if (authority.guarantee_id) {
      const { guaranteeCoversReservation, readDelegatedReservationBounds } = await import('./reservation-guarantee.js');
      const grant = await this.db.get<{ currency: string; max_total_minor: number; revoked_at: string | null }>(
        'SELECT currency,max_total_minor,revoked_at FROM gws_ea_browser_reservation_guarantees WHERE id = ?',
        authority.guarantee_id,
      );
      const reservation = await readDelegatedReservationBounds(jobId, this.db);
      const bounds = JSON.parse(authority.bounds_json) as PurchaseBounds;
      if (
        !reservation ||
        JSON.stringify(bounds.reservation) !== JSON.stringify(reservation) ||
        !guaranteeCoversReservation(grant, current, { ...bounds, reservation })
      )
        throw new PurchaseAuthorityError('authority_unavailable');
    }
  }
  /**
   * A further press of the same checkout under its approval, after the one `begin()` marked moved it to another
   * step (KTD3): the same request, nothing material changed. The attempt stays one, holding the latest facts.
   */
  async continueCommit(context: BrowserExecutionContext, authorityId: string, current: PurchaseFacts): Promise<void> {
    await context.assertActive();
    await this.db.transaction(async () => {
      const authority = await this.get(authorityId);
      if (
        !authority ||
        authority.state !== 'committing' ||
        authority.job_id !== context.job.id ||
        authority.commit_request_id !== context.request.id
      )
        throw new PurchaseAuthorityError('authority_unavailable');
      const job = await this.db.get<{ cancelled: number; cancel_requested: number }>(
        'SELECT cancelled,cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
        context.job.id,
      );
      if (!job || job.cancelled || job.cancel_requested) throw new PurchaseAuthorityError('cancelled');
      await this.checkCurrentFacts(authority, current, context.job.id);
      await this.db.run(
        'UPDATE gws_ea_browser_purchase_attempts SET facts_json = ? WHERE authority_id = ? AND resolution IS NULL',
        JSON.stringify(current),
        authority.id,
      );
    });
  }
  /**
   * The one resolve function (KTD8): a compare-and-set on an unresolved attempt, paid or free, that records its
   * outcome and its source. In the same transaction it settles the attempt's authority, its watch's claim and
   * status, the site's block and the jobs waiting on the site; a resolved attempt's pending unconfirmed notice
   * is never sent. After commit, the attempt's job hears what its page or its step showed (main's own answers
   * are main's), and each waiting job is woken.
   */
  async resolve(attemptId: string, resolution: AttemptResolution): Promise<AttemptResolved> {
    const at = new Date().toISOString();
    // Main's answers are its own to act on; the job hears only what its pages showed.
    const mainsAnswer = resolution.source === 'email' || resolution.source === 'principal';
    const result = await this.db.transaction(async (): Promise<AttemptResolved> => {
      const attempt = await this.attempt(attemptId);
      if (!attempt) return { status: 'no_attempt' };
      if (attempt.resolution) return { status: 'already_resolved', attempt };
      if (resolution.record && (await this.recordUsed(attempt, resolution.record)))
        return { status: 'record_used', attempt };
      const outcome = resolution.placed ? 'committed' : 'not_committed';
      const record = resolution.record?.id ?? null;
      const changed =
        attempt.kind === 'paid'
          ? await this.db.run(
              `UPDATE gws_ea_browser_purchase_attempts SET resolution = ?,resolution_source = ?,evidence_json = ?,reconciled_at = ?,
               merchant_record_id = ?,merchant_account = ? WHERE id = ? AND resolution IS NULL`,
              outcome,
              resolution.source,
              JSON.stringify(resolution.evidence),
              at,
              record,
              resolution.record?.account ?? null,
              attempt.id,
            )
          : await this.db.run(
              `UPDATE gws_ea_browser_free_attempts SET resolution = ?,resolution_source = ?,evidence_json = ?,reconciled_at = ?,
               merchant_record_id = ? WHERE id = ? AND resolution IS NULL`,
              outcome,
              resolution.source,
              JSON.stringify(resolution.evidence),
              at,
              record,
              attempt.id,
            );
      if (!changed.changes) return { status: 'already_resolved', attempt: (await this.attempt(attempt.id)) ?? attempt };
      const authority = attempt.authority_id ? await this.get(attempt.authority_id) : undefined;
      if (authority) {
        await this.db.run(
          "UPDATE gws_ea_browser_authorities SET state = ?,outcome_json = ?,notified_at = ? WHERE id = ? AND state IN ('committing','unknown')",
          resolution.placed ? 'committed' : 'revoked',
          JSON.stringify(
            resolution.outcome ?? {
              status: resolution.placed ? 'placed' : 'not_placed',
              source: resolution.source,
              attempt_id: attempt.id,
              repeat_safe: false,
            },
          ),
          mainsAnswer ? at : null,
          authority.id,
        );
        await this.db.run('DELETE FROM gws_ea_browser_pending_commits WHERE authority_id = ?', authority.id);
        await this.settleRequestedCancellation(authority.job_id, at);
      }
      // The watch whose one booking this attempt claimed, by a watch's own authority, a card or guarantee booking
      // on a region watch's site, or a free table there (KTD20), ends with it.
      const { finishWatchCommit } = await import('./watches.js');
      await finishWatchCommit(this.db, attempt.job_id, attempt.id, resolution.placed, resolution.source);
      if (!(await this.unresolved(attempt.site)).length) {
        await this.db.run('DELETE FROM gws_ea_browser_purchase_blocks WHERE site = ?', attempt.site);
        await this.db.run(
          'UPDATE gws_ea_browser_purchase_waiters SET released_at = ? WHERE site = ? AND released_at IS NULL',
          at,
          attempt.site,
        );
      }
      return { status: 'resolved', attempt };
    });
    if (result.status === 'resolved') {
      const authorityId = result.attempt.authority_id;
      if (authorityId && !mainsAnswer)
        await afterCommit('A purchase outcome', () => notifyPurchaseOutcome(authorityId, this));
      await afterCommit('A purchase wait', () => notifyPurchaseWaiters(this.db));
    }
    return result;
  }
  /**
   * A merchant record already proving another attempt on the site under the same account key: the contact email
   * a generic checkout keys its order numbers by, or a reviewed merchant's account (KTD5).
   */
  private async recordUsed(
    attempt: PurchaseAttemptRow,
    record: NonNullable<AttemptResolution['record']>,
  ): Promise<boolean> {
    const account = record.account ?? '';
    return (
      (await this.db.get(
        `SELECT 1 FROM gws_ea_browser_purchase_attempts WHERE site = ? AND COALESCE(merchant_account,'') = ? AND merchant_record_id = ? AND id <> ?
         UNION ALL SELECT 1 FROM gws_ea_browser_free_attempts WHERE site = ? AND COALESCE(account_key,'') = ? AND merchant_record_id = ? AND id <> ?`,
        attempt.site,
        account,
        record.id,
        attempt.id,
        attempt.site,
        account,
        record.id,
        attempt.id,
      )) !== undefined
    );
  }
  /**
   * An attempt that ended with no page proof either way (KTD8): unconfirmed, until its page, the merchant's
   * email or the principal settles it. Its site's next purchase waits on it, and its delegating group hears of
   * it once, after commit. A paid attempt's authority is spent, and its job hears `unconfirmed`. Returns what
   * the attempt's job answers.
   */
  async unconfirm(attemptId: string): Promise<Record<string, unknown>> {
    const outcome = unconfirmedOutcome(attemptId);
    const changed = await this.db.transaction(async () => {
      const attempt = await this.attempt(attemptId);
      if (!attempt || attempt.resolution || attempt.unconfirmed_at) return false;
      const at = new Date().toISOString();
      await this.db.run(
        `UPDATE ${ATTEMPT_TABLES[attempt.kind]} SET unconfirmed_at = ? WHERE id = ? AND resolution IS NULL AND unconfirmed_at IS NULL`,
        at,
        attempt.id,
      );
      await this.db.run(
        'INSERT INTO gws_ea_browser_purchase_blocks(site,created_at) VALUES(?,?) ON CONFLICT(site) DO NOTHING',
        attempt.site,
        at,
      );
      const authority = attempt.authority_id ? await this.get(attempt.authority_id) : undefined;
      if (authority) {
        await this.db.run(
          "UPDATE gws_ea_browser_authorities SET state = 'unknown',outcome_json = ?,notified_at = NULL WHERE id = ? AND state = 'committing'",
          JSON.stringify(outcome),
          authority.id,
        );
        await this.db.run('DELETE FROM gws_ea_browser_pending_commits WHERE authority_id = ?', authority.id);
        await this.settleRequestedCancellation(authority.job_id, at);
      }
      // A watch whose booking it claimed waits on its outcome too.
      const { finishWatchCommit } = await import('./watches.js');
      await finishWatchCommit(this.db, attempt.job_id, attempt.id, undefined);
      return true;
    });
    if (changed) {
      const { notifyUnconfirmedPurchase } = await import('./purchase-outcome.js');
      await afterCommit('An unconfirmed purchase', () => notifyUnconfirmedPurchase(attemptId, this.db));
    }
    return outcome;
  }
  /** A cancellation that waited for the job's commits completes once none is in progress. Caller's transaction. */
  private async settleRequestedCancellation(jobId: string, at: string): Promise<void> {
    const committing = await this.db.get(
      "SELECT 1 FROM gws_ea_browser_authorities WHERE job_id = ? AND state = 'committing' LIMIT 1",
      jobId,
    );
    // An unresolved credential attempt keeps a requested cancellation waiting too.
    if (!committing && (await heldCredentialSites(this.db, jobId)).size === 0)
      await this.db.run(
        'UPDATE gws_ea_browser_jobs SET cancelled = CASE WHEN cancel_requested = 1 THEN 1 ELSE cancelled END,updated_at = ? WHERE id = ?',
        at,
        jobId,
      );
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
        : 'unconfirmed';
  const facts = JSON.parse(authority.facts_json) as PurchaseFacts;
  try {
    await writeBrowserNotice(
      session,
      `browser-purchase-${authority.id}-${status}`,
      JSON.stringify({
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
    );
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

/**
 * Wakes each job whose purchase waited on an earlier one now settled, once: a notice in its own session, then the
 * row goes. A crash in between leaves the row for the next sweep, and the notice's id makes it one.
 */
export async function notifyPurchaseWaiters(db: DbDriver = getDb()): Promise<void> {
  if (!(await db.hasTable('gws_ea_browser_purchase_waiters'))) return;
  for (const waiter of await db.all<{ site: string; job_id: string; released_at: string }>(
    'SELECT site,job_id,released_at FROM gws_ea_browser_purchase_waiters WHERE released_at IS NOT NULL ORDER BY released_at',
  )) {
    const job = await db.get<{ browser_session_id: string; cancelled: number }>(
      'SELECT browser_session_id,cancelled FROM gws_ea_browser_jobs WHERE id = ?',
      waiter.job_id,
    );
    const session = job && !job.cancelled ? await getSession(job.browser_session_id) : undefined;
    if (session?.status === 'active') {
      try {
        await writeBrowserNotice(
          session,
          `browser-purchase-wait-${Buffer.from(`${waiter.site}\0${waiter.job_id}\0${waiter.released_at}`).toString('base64url')}`,
          JSON.stringify({
            type: 'browser_site_available',
            job: waiter.job_id,
            site: waiter.site,
            message:
              'The earlier purchase on this site now has a recorded outcome, so a purchase there no longer waits. Continue the errand from a fresh observation.',
          }),
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      void requestWake(session, 'browser-purchase-outcome').catch(() => undefined);
    }
    await db.run(
      'DELETE FROM gws_ea_browser_purchase_waiters WHERE site = ? AND job_id = ? AND released_at = ?',
      waiter.site,
      waiter.job_id,
      waiter.released_at,
    );
  }
}
