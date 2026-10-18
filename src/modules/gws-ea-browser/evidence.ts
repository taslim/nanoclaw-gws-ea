import { getDb } from '../../db/connection.js';
import type { MailboxSession } from '../../mailbox/types.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { errandSource, hasBrowserAccess } from './access.js';

/** Metadata only. This boundary deliberately does not expose browser or mailbox content. */
export interface BrowserEvidence {
  schemaVersion: 1;
  capturedAt: string;
  job: {
    id: string;
    browserSessionId: string;
    createdAt: string;
    cancelled: boolean;
    cancelRequested: boolean;
    firstInboundAt: string | null;
    lastDeliveredReportAt: string | null;
  };
  requests: Array<{
    id: string;
    requestId: string;
    action: string;
    emittedAt: string | null;
    acceptedAt: string;
    startedAt: string | null;
    commitStartedAt: string | null;
    answeredAt: string | null;
    deliveredAt: string | null;
    status: string | null;
    reason: string | null;
  }>;
  downloads: Array<{ id: string; filename: string; bytes: number; handedOffAt: string | null }>;
  purchase: { openCards: number; committedAttempts: number; unresolvedAttempts: number };
  watchNextCheckAt: string | null;
  watchChecks: Array<{
    id: string;
    scheduledAt: string;
    startedAt: string;
    finishedAt: string | null;
    outcome: string | null;
    nextCheckAt: string | null;
  }>;
}

interface EvidenceJob {
  id: string;
  thread_id: string;
  browser_session_id: string;
  browser_agent_group_id: string;
  source_agent_group_id: string;
  created_at: string;
  cancelled: number;
  cancel_requested: number;
}
interface EvidenceRequest {
  id: string;
  request_id: string;
  action: string;
  accepted_at: string;
  started_at: string | null;
  commit_started_at: string | null;
  answered_at: string | null;
  delivered_at: string | null;
  answer_json: string | null;
}
interface EvidenceDownload {
  id: string;
  filename: string;
  bytes: number;
  handed_off_at: string | null;
}
interface EvidenceWatchCheck {
  id: string;
  scheduled_at: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  next_check_at: string | null;
}

const HISTORY_LIMIT = 2_000;
const RECORD_LIMIT = 25_000;
const ACTIONS = new Set([
  'browser',
  'fill_secret',
  'credential_form',
  'sign_in_code',
  'save_recipe',
  'run_recipe',
  'purchase',
  'watch',
  'list_watches',
  'cancel_watch',
  'request_consent',
  'browser_watch_book',
  'browser_purchase_commit',
  'browser_relay_sign_in',
]);
const OPERATIONAL_CODES = new Set([
  'completed',
  'stopped',
  'not_executed',
  'error',
  'stale_ref',
  'not_actionable',
  'timeout',
  'navigated',
  'purchase_control',
  'speaks_as_principal',
  'account_security',
  'consent_control',
  'consent_required',
  'unknown_stop',
  'stop_used',
  'secret_field',
  'card_field',
  'read_only',
  'unapproved_commit',
  'blocked_address',
  'challenge',
  'sign_in_wall',
  'site_busy',
  'unsupported_merchant',
  'window_closed',
  'browser_unavailable',
  'alias_unavailable',
  'personal_data',
  'interrupted',
  'outcome_unknown',
  'awaiting_principal',
  'withdrawn',
  'approved',
  'rejected',
  'expired',
  'superseded',
  'terms_unavailable',
  'checkout_lapsed',
  'not_a_purchase',
  'site_purchase_blocked',
  'outside_bounds',
  'authority_unavailable',
  'changed',
  'purchase_blocked',
  'inconclusive',
  'committed',
  'not_committed',
  'placed',
  'booked',
  'submitted',
  'cleared_after_submit',
  'origin_mismatch',
  'no_item_for_site',
  'vault_unavailable',
  'rate_limited',
  'awaiting_code',
  'nothing_arrived',
  'ambiguous',
  'link_opened',
  'code_filled',
  'no_wait',
  'saved',
  'checkpoint_failed',
  'reached_commit_point',
  'armed',
  'checking',
  'preparing',
  'booking',
  'blocked',
  'cancelled',
  'in_progress',
  'calendar_conflict',
  'calendar_unavailable',
  'available',
  'ready',
  'failed',
  'unavailable',
  'continued',
  'account_created',
  'password_changed',
  'account_exists',
  'password_rejected',
  'current_password_rejected',
  'verification_requested',
  'not_owned',
  'refused',
  'no_authority',
  'unsupported_form',
  'form_changed',
  'unsupported_control',
  'login_changed',
  'unsupported_flow',
  'no_secret_fields',
  'invalid_request',
  'not_configured',
  'unknown-command',
  'invalid-args',
  'forbidden',
  'approval-pending',
  'handler-error',
  'transport-error',
]);
const CHECK_OUTCOMES = new Set(['ready', 'blocked', 'failed', 'site_busy', 'interrupted']);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function code(value: unknown): string | null {
  return typeof value === 'string' && OPERATIONAL_CODES.has(value) ? value : null;
}
function resultCodes(raw: string | null): { status: string | null; reason: string | null } {
  const absent = { status: null, reason: null };
  if (!raw) return absent;
  let frame: Record<string, unknown> | undefined;
  try {
    frame = record(JSON.parse(raw));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return absent;
  }
  if (frame?.ok === false) return { status: 'error', reason: code(record(frame.error)?.code) };
  const data = frame?.ok === true ? record(frame.data) : undefined;
  return { status: code(data?.status), reason: code(data?.reason) };
}

function mailboxMetadata(mailbox: MailboxSession, job: EvidenceJob, requests: EvidenceRequest[]) {
  const inbound = mailbox.getInboundHistory(HISTORY_LIMIT);
  const outbound = mailbox.getOutboundHistory(HISTORY_LIMIT);
  const emitted = new Map<string, string | null>();
  const timestamps = new Map<string, Map<string, string | null>>();
  if (outbound.length < HISTORY_LIMIT)
    for (const message of outbound) {
      const contents = timestamps.get(message.kind) ?? new Map<string, string | null>();
      contents.set(message.content, contents.has(message.content) ? null : message.timestamp);
      timestamps.set(message.kind, contents);
    }
  // The native by-id read binds content to the immutable request. History has no ids;
  // ambiguity or truncation therefore leaves timing unavailable instead of estimating it.
  if (outbound.length < HISTORY_LIMIT)
    for (const request of requests) {
      const own = mailbox.getOutboundMessage(request.request_id);
      emitted.set(request.id, own ? (timestamps.get(own.kind)?.get(own.content) ?? null) : null);
    }
  return {
    emitted,
    firstInboundAt: inbound.length < HISTORY_LIMIT ? (inbound.at(-1)?.timestamp ?? null) : null,
    lastDeliveredReportAt: mailbox.getLatestDeliveredAgentReport(job.source_agent_group_id)?.timestamp ?? null,
  };
}

/** Inspect only an existing canonical, active job; this path never creates jobs or mailboxes. */
export async function readBrowserEvidence(thread: string): Promise<BrowserEvidence> {
  const db = getDb();
  const job = await db.get<EvidenceJob>(
    `SELECT j.id,j.thread_id,j.browser_session_id,j.source_agent_group_id,j.created_at,j.cancelled,j.cancel_requested,
            s.agent_group_id AS browser_agent_group_id
       FROM gws_ea_browser_jobs j
       JOIN sessions s ON s.id=j.browser_session_id AND s.thread_id=j.thread_id
       JOIN gws_ea_profile p ON p.singleton=1 AND p.browser_agent_group_id=s.agent_group_id
      WHERE j.id=? AND j.id=j.thread_id AND s.status='active' AND s.messaging_group_id IS NULL`,
    thread,
  );
  if (
    !job ||
    errandSource(job.thread_id) !== job.source_agent_group_id ||
    !(await hasBrowserAccess(job.source_agent_group_id))
  )
    throw new Error('Browser job not found');
  const [requests, downloads, watchChecks, openCards, attempts, nextWatch] = await Promise.all([
    db.all<EvidenceRequest>(
      `SELECT id,request_id,action,accepted_at,started_at,commit_started_at,answered_at,delivered_at,answer_json
         FROM gws_ea_browser_requests WHERE job_id=? AND session_id=? ORDER BY accepted_at,id LIMIT ?`,
      job.id,
      job.browser_session_id,
      RECORD_LIMIT + 1,
    ),
    db.all<EvidenceDownload>(
      'SELECT id,filename,bytes,handed_off_at FROM gws_ea_browser_downloads WHERE job_id=? ORDER BY id LIMIT ?',
      job.id,
      RECORD_LIMIT + 1,
    ),
    db.all<EvidenceWatchCheck>(
      `SELECT DISTINCT c.id,c.scheduled_at,c.started_at,c.finished_at,c.outcome,c.next_check_at
         FROM gws_ea_browser_watch_checks c
         JOIN gws_ea_browser_watch_check_members m ON m.check_id=c.id
         JOIN gws_ea_browser_watches w ON w.id=m.watch_id
        WHERE w.job_id=? ORDER BY c.started_at,c.id LIMIT ?`,
      job.id,
      RECORD_LIMIT + 1,
    ),
    db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM gws_ea_browser_purchase_cards WHERE job_id=? AND status='open'",
      job.id,
    ),
    db.get<{ committed: number | null; unresolved: number | null }>(
      "SELECT SUM(CASE WHEN resolution='committed' THEN 1 ELSE 0 END) AS committed,SUM(CASE WHEN resolution IS NULL THEN 1 ELSE 0 END) AS unresolved FROM gws_ea_browser_purchase_attempts WHERE job_id=?",
      job.id,
    ),
    db.get<{ due: string | null }>(
      "SELECT MIN(next_check_at) AS due FROM gws_ea_browser_watches WHERE job_id=? AND status IN ('armed','checking')",
      job.id,
    ),
  ]);
  if ([requests, downloads, watchChecks].some((rows) => rows.length > RECORD_LIMIT))
    throw new Error('Browser evidence exceeds the supported inspection size');
  const mailbox = await withExistingMailboxSession(job.browser_agent_group_id, job.browser_session_id, (messages) =>
    mailboxMetadata(messages, job, requests),
  );
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    job: {
      id: job.id,
      browserSessionId: job.browser_session_id,
      createdAt: job.created_at,
      cancelled: Boolean(job.cancelled),
      cancelRequested: Boolean(job.cancel_requested),
      firstInboundAt: mailbox?.firstInboundAt ?? null,
      lastDeliveredReportAt: mailbox?.lastDeliveredReportAt ?? null,
    },
    requests: requests.map((request) => ({
      id: request.id,
      requestId: request.request_id,
      action: ACTIONS.has(request.action) ? request.action : 'unknown',
      emittedAt: mailbox?.emitted.get(request.id) ?? null,
      acceptedAt: request.accepted_at,
      startedAt: request.started_at,
      commitStartedAt: request.commit_started_at,
      answeredAt: request.answered_at,
      deliveredAt: request.delivered_at,
      ...resultCodes(request.answer_json),
    })),
    downloads: downloads.map((download) => ({
      id: download.id,
      filename: download.filename,
      bytes: download.bytes,
      handedOffAt: download.handed_off_at,
    })),
    purchase: {
      openCards: openCards?.count ?? 0,
      committedAttempts: attempts?.committed ?? 0,
      unresolvedAttempts: attempts?.unresolved ?? 0,
    },
    watchNextCheckAt: nextWatch?.due ?? null,
    watchChecks: watchChecks.map((check) => ({
      id: check.id,
      scheduledAt: check.scheduled_at,
      startedAt: check.started_at,
      finishedAt: check.finished_at,
      outcome: check.outcome && CHECK_OUTCOMES.has(check.outcome) ? check.outcome : null,
      nextCheckAt: check.next_check_at,
    })),
  };
}
