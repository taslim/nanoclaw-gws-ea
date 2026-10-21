/**
 * Incidents (KTD10): spending that may have slipped past the host. Each is a row of its own, inserted in the
 * same transaction as its job's stop, and a job records one per kind and evidence. The job's delegating group
 * hears of each at once, and tells the principal; once that group's browser access was removed, main hears.
 *
 * `unapproved_commit` is a confirmation page that showed a charge after an ordinary press. `late_confirmation`
 * is main reporting placed a purchase it had recorded not placed: the merchant's late order email, and possibly
 * a duplicate. Each notice is written after the stop commits; the host's sweep tells of any that did not go out.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { log } from '../../log.js';
import { cancelBrowserJobInTransaction, finishBrowserJobCancellation, type BrowserJobCancellation } from './cancel.js';
import { showsCharge, type ConfirmationEvidence } from './confirmation.js';
import { BrowserStore } from './db.js';
import { formatMoney } from './fingerprint.js';
import { tellOfPurchaseOnce } from './notices.js';
import type { BrowserOperationContext } from './actions.js';

export type IncidentKind = 'unapproved_commit' | 'late_confirmation';

export interface BrowserIncident {
  readonly id: string;
  readonly kind: IncidentKind;
  /** The merchant: the site of the top-level page the job acted on. */
  readonly site: string;
  readonly job_id: string;
  readonly attempt_id: string | null;
  readonly evidence_key: string;
  readonly evidence_json: string;
  readonly created_at: string;
  readonly notified_at: string | null;
}

export interface NewIncident {
  readonly kind: IncidentKind;
  readonly site: string;
  readonly attemptId?: string;
  /** What makes this incident this one: the same evidence for the same job and kind is recorded once. */
  readonly evidenceKey: string;
  readonly evidence: unknown;
}

/**
 * Records `incident` and stops its job (cancels it) in one transaction. Recording the same evidence again stops
 * nothing new. The caller finishes the cancellation and tells of the incident after this commits.
 */
export async function recordIncidentWithStop(
  store: BrowserStore,
  thread: string,
  incident: NewIncident,
): Promise<{ readonly incident: BrowserIncident; readonly stop: BrowserJobCancellation }> {
  return store.db.transaction(async () => {
    const stop = await cancelBrowserJobInTransaction(thread, store);
    await store.db.run(
      `INSERT INTO gws_ea_browser_incidents(id,kind,site,job_id,attempt_id,evidence_key,evidence_json,created_at)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job_id,kind,evidence_key) DO NOTHING`,
      `incident-${randomUUID()}`,
      incident.kind,
      incident.site,
      stop.job.id,
      incident.attemptId ?? null,
      incident.evidenceKey,
      JSON.stringify(incident.evidence),
      new Date().toISOString(),
    );
    const recorded = await store.db.get<BrowserIncident>(
      'SELECT * FROM gws_ea_browser_incidents WHERE job_id = ? AND kind = ? AND evidence_key = ?',
      stop.job.id,
      incident.kind,
      incident.evidenceKey,
    );
    if (!recorded) throw new Error('Incident was not recorded');
    return { incident: recorded, stop };
  });
}

/** What an unapproved commit's notice and the stopped action say of it, all host-read and host-formatted. */
function unapprovedCommitFacts(incident: BrowserIncident): { reference: string; charged?: string } {
  const evidence = JSON.parse(incident.evidence_json) as ConfirmationEvidence;
  return {
    reference: evidence.reference,
    ...(evidence.charged ? { charged: formatMoney(evidence.charged.amountMinor, evidence.charged.currency) } : {}),
  };
}

function noticeText(incident: BrowserIncident, thread: string): string {
  switch (incident.kind) {
    case 'unapproved_commit': {
      const { reference, charged } = unapprovedCommitFacts(incident);
      return (
        `Browser job ${thread} was stopped: an ordinary press on ${incident.site} landed on a confirmation showing ` +
        `${charged ?? 'a charge'}, reference ${reference}. Nobody approved this purchase. Tell the principal now.`
      );
    }
    case 'late_confirmation':
      return (
        `Browser job ${thread} was stopped: the purchase on ${incident.site} recorded as not placed was reported ` +
        'placed after all, so the principal may have bought it twice. Tell the principal now.'
      );
    default: {
      const unknown: never = incident.kind;
      throw new Error(`Unknown incident kind ${String(unknown)}`);
    }
  }
}

/** Tells the incident's delegating group of it, once; a notice that cannot go out yet is retried by the sweep. */
export async function notifyIncident(id: string, db: DbDriver = getDb()): Promise<void> {
  const incident = await db.get<BrowserIncident>('SELECT * FROM gws_ea_browser_incidents WHERE id = ?', id);
  if (!incident || incident.notified_at) return;
  await tellOfPurchaseOnce(db, incident, {
    table: 'gws_ea_browser_incidents',
    noteId: `browser-incident-${incident.id}`,
    text: (job) => noticeText(incident, job.thread_id),
    unsent: { message: 'Nobody to tell of a browser incident yet', kind: 'incident' },
  });
}

/** The host's sweep: every incident whose notice has not gone out yet. */
export async function notifyPendingIncidents(db: DbDriver = getDb()): Promise<void> {
  if (!(await db.hasTable('gws_ea_browser_incidents'))) return;
  for (const { id } of await db.all<{ id: string }>(
    'SELECT id FROM gws_ea_browser_incidents WHERE notified_at IS NULL ORDER BY created_at, id',
  ))
    await notifyIncident(id, db);
}

/** An ordinary press that bought something nobody approved: the confirmation showing its charge, and the merchant. */
export interface UnapprovedCommit {
  readonly site: string;
  readonly evidence: ConfirmationEvidence;
}

/**
 * Stops the job whose ordinary press `commit` came from: the incident and the cancellation in one transaction,
 * then the urgent notice and the cancellation's own work. The request reporting it answers for itself, so it is
 * never interrupted. Returns what the stopped action reports of the incident.
 */
export async function stopForUnapprovedCommit(
  context: BrowserOperationContext,
  commit: UnapprovedCommit,
): Promise<{ readonly site: string; readonly reference: string; readonly charged?: string }> {
  if (!showsCharge(commit.evidence)) throw new Error('A confirmation without a charge is no unapproved commit');
  const { incident, stop } = await recordIncidentWithStop(context.store, context.job.thread_id, {
    kind: 'unapproved_commit',
    site: commit.site,
    evidenceKey: `${commit.evidence.source}#${commit.evidence.reference}`,
    evidence: commit.evidence,
  });
  /* eslint-disable no-catch-all/no-catch-all -- the incident is recorded: the sweep retries a notice that fails here */
  try {
    await notifyIncident(incident.id, context.store.db);
  } catch (error) {
    log.warn('A browser incident notice will be retried', {
      incident: incident.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  /* eslint-enable no-catch-all/no-catch-all */
  await finishBrowserJobCancellation(stop, undefined, context.kind === 'watch_check' ? undefined : context.request.id);
  return { site: incident.site, ...unapprovedCommitFacts(incident) };
}
