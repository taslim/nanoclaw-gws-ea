/**
 * Authorized account creation and password changes in the host browser (F3,
 * F4, KTD7). Main records the authority for one browser job, site and
 * account: a signup, or a change on a Login this host saved (R18). That
 * record is the credential attempt itself (KTD6), so the browser can neither
 * create nor widen it.
 *
 * The browser then names fresh element refs for the account's fields and the
 * control that activates them. The host binds every field and the control to
 * one document, node and HTTPS origin on the attempt's site, saves the
 * generated password durably, and records possible exposure before inserting
 * anything. It fills the whole group atomically through the native setter,
 * lets controlled (JS) forms see the values, activates the exact control
 * once, and reads the website's own response for the outcome. Success needs
 * host-read evidence from the site, never a model verdict, an HTTP status or
 * a URL change alone (KTD8). Values never leave host memory and 1Password.
 *
 * Phases are the attempt's: an attempt past its one disclosure is never
 * filled again, so a retry or restart cannot submit a second time. A request
 * cut off after its disclosure leaves the attempt `unknown` (KTD8), with its
 * site held for its job; nothing about it becomes a purchase record.
 *
 * Two later steps settle an attempt without submitting it again. `verify`
 * completes a signup the site asked to confirm by email: its claim, opened
 * before the activation, binds the site, origin and account, and only the
 * host inserts the code or opens the link the isolated interpreter returned.
 * `reconcile` is read-only: it reads the site's late response, which counts
 * only in the same document the host was watching with no interaction since;
 * from `confirmed` it re-runs the vault's finalize.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { Frame, Page } from 'playwright-core';

import { ActionRefusal, answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { DENY, HOLD, defineGuardedAction, guard, type GuardActor } from '../../guard/index.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import type { ApprovalHandlerContext } from '../approvals/primitive.js';
import { isVerifiedPrincipalUser, principalApproverUserId } from '../gws-ea-profile/db.js';
import { hasBrowserAccess } from './access.js';
import {
  credentialFieldFits,
  httpsOrigin,
  verificationCodeFits,
  type CredentialFormField,
  type CredentialKind,
} from './authentication-signatures.js';
import {
  activateNativeCredentialControl,
  fillNativeCredentialGroup,
  inspectNativeCredentialControl,
  readNativeDocumentFields,
  type CredentialActivationResult,
  type NativeCredentialBinding,
  type NativeCredentialFacts,
  type NativeCredentialGroup,
  type NativeDocumentField,
  type NativeFieldFacts,
} from './authentication-submit.js';
import { browserDelegateGuard, finishRequestedCancellation, resolveBrowserJob } from './cancel.js';
import { quotePurchaseText } from './cards.js';
import {
  BrowserSiteBusyError,
  classifyCredentialActivation,
  classifyCredentialNavigation,
  ensureBrowserNavigationGuard,
  readControlFacts,
  termsConsentLabel,
  withBrowserJobNavigation,
  type CredentialActivationClass,
} from './commit-classifier.js';
import type { BrowserRequest } from './db.js';
import {
  CredentialAttemptError,
  RELEASABLE_PHASES,
  credentialAttempts,
  line,
  MAX_USERNAME,
  type CandidateCredential,
  type CredentialAttempt,
  type CredentialAttemptPhase,
  type CredentialAttempts,
  type CredentialEvidence,
  type CredentialFinalizeResult,
  type CredentialReleaseResult,
} from './credential-attempts.js';
import { assertBrowserSecretDiagnosticsSafe, settleFilledSecrets } from './fill.js';
import { HELD_CREDENTIAL_PHASES, SiteLeaseStore } from './leases.js';
import {
  BrowserRefError,
  bindPageSecretDocuments,
  disposeBrowserRefs,
  pinBrowserRefs,
  readBrowserRef,
  registerPageSecret,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import { registrableDomain, type BrowserVaultReason } from './onepassword.js';
import { registerBrowserQueuedAction, type BrowserExecutionContext, type BrowserQueue } from './queue.js';
import {
  finishSignupVerification,
  openSignupVerification,
  openVerificationLink,
  takeSignupVerification,
} from './sign-in-mail.js';

export interface CredentialOperationDependencies {
  readonly attempts: CredentialAttempts;
  /** Frees the site of an attempt main's release request finds 1Password can now settle. */
  readonly queue?: () => BrowserQueue;
}
const DEFAULT_DEPENDENCIES: CredentialOperationDependencies = { attempts: credentialAttempts };

type Outcome = Record<string, unknown>;
const refused = (reason: string): Outcome => ({ status: 'refused', reason });

// ---------------------------------------------------------------- main's authority

const AUTHORITY_FIELDS: ReadonlySet<string> = new Set([
  'action',
  'requestId',
  'thread',
  'operation',
  'site',
  'username',
  'authority',
]);

function recorded(attempt: CredentialAttempt, thread: string): Outcome {
  return {
    status: 'recorded',
    authority: attempt.id,
    operation: attempt.kind === 'signup' ? 'signup' : 'change_password',
    thread,
    site: attempt.site,
    username: attempt.username,
  };
}

/** Main hears only whether the vault can be used now; the host keeps its reasons. */
function vaultOutcome(reason: BrowserVaultReason): Outcome {
  if (reason === 'rate_limited') return { status: 'rate_limited' };
  return reason === 'no_item_for_site' ? { status: 'not_owned', reason: 'no_record' } : { status: 'vault_unavailable' };
}

/**
 * An agent with browser access records the principal's delegation of one
 * signup or one password change for an exact job of its own, site and
 * account. A change binds the Login this host saved for that site and
 * username, checked fresh against its ownership record (R18); any other
 * Login, an edited one, or an account with no saved Login is refused here,
 * before the browser can act. Sign-in email, phone, two-factor and
 * payment-method changes have no operation.
 */
export async function credentialAuthorityRequest(
  content: Record<string, unknown>,
  session: Session,
  dependencies: CredentialOperationDependencies = DEFAULT_DEPENDENCIES,
): Promise<Outcome> {
  if (!(await hasBrowserAccess(session.agent_group_id)))
    throw forbidden('Only an agent with browser access may delegate an account signup or password change.');
  if (Object.keys(content).some((key) => !AUTHORITY_FIELDS.has(key)))
    throw invalidArgs('Unknown credential_authority field.');
  if (content.operation === 'release') return credentialReleaseRequest(content, session, dependencies);
  const { thread, operation, site, username } = content;
  if (
    content.authority !== undefined ||
    typeof thread !== 'string' ||
    (operation !== 'signup' && operation !== 'change_password') ||
    typeof site !== 'string' ||
    !line(username, MAX_USERNAME)
  )
    throw invalidArgs(
      'credential_authority needs the job thread, signup or change_password, the HTTPS site and the exact account username.',
    );
  const origin = httpsOrigin(site)?.origin;
  const domain = origin && registrableDomain(origin);
  if (!origin || !domain) throw invalidArgs('The site must be a public HTTPS address.');
  const job = await resolveBrowserJob(thread, undefined, session.agent_group_id);
  const cancelling =
    job &&
    (await getDb().get<{ cancel_requested: number }>(
      'SELECT cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
      job.id,
    ));
  if (!job || job.cancelled || cancelling?.cancel_requested)
    throw forbidden('No live browser job of yours exists for that thread.');
  const kind: CredentialKind = operation === 'signup' ? 'signup' : 'rotation';
  const { attempts } = dependencies;
  const unresolved = await attempts.unresolved();
  const open = unresolved.find(
    (attempt) =>
      attempt.job_id === job.id &&
      attempt.kind === kind &&
      attempt.site === domain &&
      attempt.username === username &&
      (attempt.phase === 'preparing' || attempt.phase === 'saved'),
  );
  if (open) return recorded(open, job.thread_id);
  if (kind === 'signup') {
    // A signup that may have reached the site is settled through its own job, never retried (KTD8).
    if (
      unresolved.some(
        (attempt) =>
          attempt.kind === 'signup' &&
          attempt.site === domain &&
          attempt.username === username &&
          HELD_CREDENTIAL_PHASES.some((phase) => phase === attempt.phase),
      )
    )
      return { status: 'busy' };
    const prepared = await attempts.prepareSignup({ jobId: job.id, origin, username });
    return prepared.status === 'prepared' ? recorded(prepared.attempt, job.thread_id) : { status: prepared.status };
  }
  const found = await attempts.ownedHandle(origin, username);
  if (found.status === 'not_owned') return { status: 'not_owned', reason: 'no_record' };
  if (found.status !== 'found') return { status: found.status };
  const owned = await attempts.ownership(found.itemHandle, origin);
  if (owned.status === 'not_owned') return { status: 'not_owned', reason: owned.reason };
  if (owned.status !== 'owned') return vaultOutcome(owned.status);
  const prepared = await attempts.prepareRotation({ jobId: job.id, origin, itemHandle: found.itemHandle });
  if (prepared.status === 'prepared') return recorded(prepared.attempt, job.thread_id);
  if (prepared.status === 'not_owned') return { status: 'not_owned', reason: 'no_record' };
  return prepared.status === 'busy' ? { status: 'busy' } : vaultOutcome(prepared.status);
}

// ---------------------------------------------------------------- the principal's release

/** The `pending_approvals.action` a principal's release resolves through. */
export const CREDENTIAL_RELEASE_APPROVAL = 'browser_credential_release';

const agentActor = (session: Session): GuardActor => ({
  kind: 'agent',
  agentGroupId: session.agent_group_id,
  sessionId: session.id,
});

/**
 * An attempt the host cannot settle ends only on the principal's informed
 * decision, as an inconclusive purchase does: main asks, and the principal
 * confirms on their own card, knowing what may have happened (KTD8).
 */
export const credentialReleaseGuard = defineGuardedAction({
  action: 'gws_ea_browser.credential_release',
  grantActionName: CREDENTIAL_RELEASE_APPROVAL,
  grantCoversRequest: (grant, input) => grant.payload === JSON.stringify(input.payload),
  async decide({ actor, payload }) {
    if (actor.kind !== 'agent' || !(await hasBrowserAccess(actor.agentGroupId)))
      return DENY('Only an agent with browser access may ask the principal to release a credential attempt.');
    const attempt = typeof payload.attemptId === 'string' ? await credentialAttempts.get(payload.attemptId) : undefined;
    if (!attempt || attempt.job_id !== payload.jobId || !RELEASABLE_PHASES.includes(attempt.phase))
      return DENY('That credential attempt is settled, or its own step settles it.');
    const principal = await principalApproverUserId();
    return principal
      ? HOLD('Only the principal may end an attempt whose outcome the host cannot establish.', principal)
      : DENY('No verified principal can decide this.');
  },
});

/**
 * What 1Password holds for an attempt the host could not finish, in the
 * principal's words on the card (`mine`) and in main's note (`theirs`). A
 * confirmed one says which item holds the password the site took, and
 * whether the original login may still hold the old one, from its recorded
 * settlement.
 */
function vaultLeft(
  attempt: Pick<CredentialAttempt, 'kind' | 'site' | 'settlement'>,
  phase: CredentialAttemptPhase,
): { readonly mine: string | undefined; readonly theirs: string } {
  const item = `"New password for ${attempt.site}"`;
  if (attempt.kind === 'signup')
    switch (phase) {
      case 'conflict':
        return {
          mine: undefined,
          theirs: 'Its login was changed in 1Password before the host finished saving it, and stays as it was changed.',
        };
      case 'confirmed':
        return {
          mine: `Its password is in my 1Password vault, in the login "${attempt.site}" that I couldn't finish saving.`,
          theirs: `Its password stays in the assistant's 1Password vault, in the login "${attempt.site}" the host could not finish saving.`,
        };
      default:
        return {
          mine: 'The password I generated for it is kept in my 1Password vault.',
          theirs: "The password generated for it stays in the assistant's 1Password vault, not saved as its login.",
        };
    }
  if (phase === 'conflict')
    return {
      mine: `The new password is in my 1Password vault as its own item, ${item}.`,
      theirs: `The new password stays in the assistant's 1Password vault as its own item, ${item}; the login stays as it was changed.`,
    };
  if (phase !== 'confirmed')
    return {
      mine: 'Both the original and the new password are kept in my 1Password vault.',
      theirs:
        "Both the original and the new password stay in the assistant's 1Password vault; the login was not updated.",
    };
  switch (attempt.settlement) {
    case 'promoted':
      return {
        mine: `The item ${item} may still hold a copy of it and of the old password.`,
        theirs: `The login holds the new password; the item ${item} may still hold a copy of it and of the old password.`,
      };
    case 'kept':
      return {
        mine: `The new password is in my 1Password vault as its own item, ${item}, which may still hold the old password too.`,
        theirs: `The new password stays in the assistant's 1Password vault as its own item, ${item}, which may still hold the old password too; the login stays as it was changed.`,
      };
    case null:
      return {
        mine: `The new password is in my 1Password vault as its own item, ${item}, and the login may still have the old one.`,
        theirs: `The new password stays in the assistant's 1Password vault as its own item, ${item}; the login may still have the old one.`,
      };
  }
}

/** What happened, as the principal reads it first on the card. */
function situation(attempt: CredentialAttempt, account: string): string {
  if (attempt.kind === 'signup')
    switch (attempt.phase) {
      case 'conflict':
        return `The site created the account ${account}, but its login in my 1Password vault was changed or removed before I finished saving it, so I left it as it is.`;
      case 'confirmed':
        return `The site created the account ${account}, but I can't reach 1Password to finish saving its login.`;
      case 'awaiting_verification':
        return `I tried to create the account ${account}. The site asked to confirm it by email, which never completed, so I can't tell whether the account was created.`;
      default: {
        const evidence: unknown = attempt.evidence_json === null ? undefined : JSON.parse(attempt.evidence_json);
        const via = isRecord(evidence) ? evidence.via : undefined;
        return via === 'link' || via === 'code'
          ? `The site asked to confirm the account ${account} by email, and I used the ${via} it sent, but I can't tell whether the site accepted it.`
          : `I tried to create the account ${account}, but I can't tell whether the account was created.`;
      }
    }
  if (attempt.phase === 'conflict' || (attempt.phase === 'confirmed' && attempt.settlement === 'kept'))
    return `The site took a new password for ${account}, but its login in my 1Password vault was changed or removed while I was changing it, so I left the login as it is.`;
  if (attempt.phase === 'confirmed')
    return attempt.settlement === 'promoted'
      ? `The site took a new password for ${account}, and the login in my 1Password vault has it, but I can't reach 1Password to delete the separate item that held it.`
      : `The site took a new password for ${account}, but I can't reach 1Password to put it into the login.`;
  return `I tried to change the password of ${account}, but I can't tell whether the password changed.`;
}

/** What the principal reads on the card: what happened, what 1Password keeps, and what releasing means. */
function releaseQuestion(attempt: CredentialAttempt): string {
  const account = `${quotePurchaseText(attempt.username, 256)} on ${attempt.site}`;
  const uncertain = attempt.phase === 'unknown' || attempt.phase === 'awaiting_verification';
  const consequence =
    attempt.kind === 'signup'
      ? `If you release it, I stop waiting on it and free the site, and I change nothing more in 1Password.${uncertain ? ' Trying again could create a second account.' : ''}`
      : `If you release it, I stop waiting on it and free the site and the login, and I change nothing more in 1Password.${uncertain ? ' Trying again could change the password a second time.' : ''}`;
  return [situation(attempt, account), vaultLeft(attempt, attempt.phase).mine, consequence]
    .filter((sentence) => sentence !== undefined)
    .join('\n');
}

/** A confirmed attempt is settled when 1Password can still finish it: a release is only for one it cannot. */
async function settledFirst(attempts: CredentialAttempts, attempt: CredentialAttempt): Promise<Outcome | undefined> {
  if (attempt.phase !== 'confirmed') return undefined;
  let result: CredentialFinalizeResult;
  try {
    result = await attempts.finalize(attempt.id);
  } catch (error) {
    // Another step moved it first; its current phase decides what follows.
    if (!(error instanceof CredentialAttemptError)) throw error;
    return undefined;
  }
  return result.status === 'finalized' || result.status === 'conflict'
    ? websiteOutcome(attempt.kind, result.status)
    : undefined;
}

/** Main asks for the principal's decision on an attempt only they can now end; never a release by itself. */
async function credentialReleaseRequest(
  content: Record<string, unknown>,
  session: Session,
  { attempts, queue }: CredentialOperationDependencies,
): Promise<Outcome> {
  const { thread, authority } = content;
  if (
    typeof thread !== 'string' ||
    typeof authority !== 'string' ||
    !AUTHORITY_ID.test(authority) ||
    content.site !== undefined ||
    content.username !== undefined
  )
    throw invalidArgs('release needs only the job thread and the credential authority it recorded.');
  const job = await resolveBrowserJob(thread, undefined, session.agent_group_id);
  if (!job) throw forbidden('No browser job of yours exists for that thread.');
  const found = await attempts.get(authority);
  if (!found || found.job_id !== job.id || !RELEASABLE_PHASES.includes(found.phase))
    return { status: 'not_releasable' };
  const settled = await settledFirst(attempts, found);
  if (settled) {
    if (queue) await freeSite(queue(), found, `credential-settled-${found.id}`);
    return settled;
  }
  const attempt = await attempts.get(found.id);
  if (!attempt || !RELEASABLE_PHASES.includes(attempt.phase)) return { status: 'not_releasable' };
  const payload = { attemptId: attempt.id, jobId: job.id };
  const decision = await guard(credentialReleaseGuard, { actor: agentActor(session), payload });
  if (decision.effect !== 'hold') throw forbidden(decision.reason);
  const open = await getDb().get<{ present: number }>(
    'SELECT 1 AS present FROM pending_approvals WHERE action = ? AND payload = ? LIMIT 1',
    CREDENTIAL_RELEASE_APPROVAL,
    JSON.stringify(payload),
  );
  if (open) return { status: 'awaiting_principal' };
  const approvalId = await requestApproval({
    session,
    agentName: 'main',
    action: CREDENTIAL_RELEASE_APPROVAL,
    payload,
    title: attempt.kind === 'signup' ? 'Stop waiting on this account signup?' : 'Stop waiting on this password change?',
    question: releaseQuestion(attempt),
    approverUserId: decision.approverUserId,
    details: { facts: { site: attempt.site, account: attempt.username } },
  });
  if (approvalId === null) throw forbidden('The principal could not be asked right now.');
  return { status: 'awaiting_principal' };
}

/** The release evidence: this approval's, and the phase it released, as a resumed approval finds it. */
function releasedFrom(attempt: CredentialAttempt, approvalId: string): CredentialAttemptPhase | undefined {
  const evidence: unknown = attempt.evidence_json === null ? undefined : JSON.parse(attempt.evidence_json);
  if (attempt.phase !== 'rejected' || !isRecord(evidence) || evidence.approval !== approvalId) return undefined;
  const from = evidence.released_from;
  return RELEASABLE_PHASES.find((phase) => phase === from) ?? 'unknown';
}

/**
 * An attempt that no longer holds its site, settled or released: the site
 * goes to its waiters now, unless its job is mid-request, whose end releases
 * it, and a cancellation waiting on it completes.
 */
async function freeSite(
  queue: BrowserQueue,
  attempt: Pick<CredentialAttempt, 'job_id' | 'site'>,
  eventId: string,
): Promise<void> {
  const running = await queue.store.db.get<{ present: number }>(
    'SELECT 1 AS present FROM gws_ea_browser_requests WHERE job_id = ? AND started_at IS NOT NULL AND answered_at IS NULL LIMIT 1',
    attempt.job_id,
  );
  if (!running) await queue.wakeWaiters(await queue.leases.release(attempt.job_id, attempt.site), eventId);
  await finishRequestedCancellation(attempt.job_id, queue);
}

/**
 * The principal's approval: re-checked live with the card as its grant, then
 * the attempt ends and everything held for it lifts, unless 1Password could
 * finish a confirmed one after all. Releasing touches nothing in 1Password,
 * and nothing is finalized, published, promoted or owned.
 */
async function applyCredentialRelease(
  { session, payload, approval, userId, notify }: ApprovalHandlerContext,
  queue: BrowserQueue,
  attempts: CredentialAttempts,
): Promise<void> {
  if (!(await isVerifiedPrincipalUser(userId)) || approval.approver_user_id !== userId) {
    await notify('The credential attempt was not released: only the principal can decide that.');
    return;
  }
  let current = typeof payload.attemptId === 'string' ? await attempts.get(payload.attemptId) : undefined;
  let from = current && releasedFrom(current, approval.approval_id);
  if (!current || !from) {
    const decision = await guard(credentialReleaseGuard, { actor: agentActor(session), payload, grant: approval });
    if (decision.effect !== 'allow' || !current) {
      await notify(`The credential attempt was not released: ${decision.reason}`);
      return;
    }
    let result: CredentialReleaseResult;
    try {
      result = await attempts.release(current.id, approval.approval_id);
    } catch (error) {
      if (!(error instanceof CredentialAttemptError)) throw error;
      await notify('The credential attempt was not released: another step settled it first.');
      return;
    }
    if (result.status === 'settled') {
      await freeSite(queue, result.result.attempt, `credential-settled-${current.id}`);
      const outcome = websiteOutcome(current.kind, result.result.status);
      await notify(
        `The ${current.kind === 'signup' ? 'signup' : 'password change'} for ${current.username} on ${current.site} was not released: 1Password could be reached again, and the host finished it (${String(outcome.status)}, vault ${String(outcome.vault)}).`,
      );
      return;
    }
    current = result.attempt;
    from = result.from;
  }
  watchedResponses.delete(current.id);
  await finishSignupVerification(current.id);
  await freeSite(queue, current, `credential-release-${current.id}`);
  await notify(
    `The principal released the ${current.kind === 'signup' ? 'signup' : 'password change'} for ${current.username} on ${current.site}. ${vaultLeft(current, from).theirs} The site is free again, and nothing in 1Password changed.`,
  );
}

/**
 * Finishes saving confirmed attempts that wait only on 1Password, with no job
 * to drive them: when the browser starts, and when a job is refused a site
 * one of them holds (`sites`). Each that settles frees its site. A vault out
 * of reach, or a spent request limit, ends the pass: the rest would only
 * spend more.
 */
export async function settleConfirmedAttempts(
  queue: BrowserQueue,
  sites?: ReadonlySet<string>,
  attempts: CredentialAttempts = credentialAttempts,
): Promise<void> {
  for (const attempt of await attempts.unresolved()) {
    if (attempt.phase !== 'confirmed' || (sites && !sites.has(attempt.site))) continue;
    let result: CredentialFinalizeResult;
    try {
      result = await attempts.finalize(attempt.id);
    } catch (error) {
      if (!(error instanceof CredentialAttemptError)) throw error;
      continue;
    }
    if (result.status === 'finalized' || result.status === 'conflict')
      await freeSite(queue, attempt, `credential-settled-${attempt.id}`);
    else if (result.status === 'vault_unavailable' || result.status === 'rate_limited') return;
  }
}

/**
 * After a job's request: the sites it was refused that another job holds
 * only for a confirmed credential attempt settle now, without that job.
 */
export async function settleRefusedSites(
  queue: BrowserQueue,
  jobId: string,
  attempts: CredentialAttempts = credentialAttempts,
): Promise<void> {
  const { db } = queue.store;
  if (!(await db.hasTable('gws_ea_browser_credential_attempts'))) return;
  const held = await db.all<{ site: string }>(
    `SELECT DISTINCT w.site FROM gws_ea_browser_site_waiters w
       JOIN gws_ea_browser_site_leases l ON l.site = w.site AND l.job_id <> w.job_id
       JOIN gws_ea_browser_credential_attempts a ON a.job_id = l.job_id AND a.site = w.site AND a.phase = 'confirmed'
      WHERE w.job_id = ?`,
    jobId,
  );
  if (held.length) await settleConfirmedAttempts(queue, new Set(held.map((row) => row.site)), attempts);
}

export function registerCredentialAuthorityDelivery(
  queue: () => BrowserQueue,
  dependencies: CredentialOperationDependencies = DEFAULT_DEPENDENCIES,
): void {
  registerDeliveryAction(
    'credential_authority',
    answeringAction('credential_authority', (content, session) =>
      credentialAuthorityRequest(content, session, { ...dependencies, queue }),
    ),
    answeredGuard(browserDelegateGuard),
  );
  // Releasing is idempotent and re-checked live, so an approved row resumes safely after a restart.
  registerApprovalHandler(
    CREDENTIAL_RELEASE_APPROVAL,
    (context) => applyCredentialRelease(context, queue(), dependencies.attempts),
    { restartSafe: true },
  );
}

// ---------------------------------------------------------------- the browser's request

const ROLES: readonly CredentialFormField[] = ['username', 'current_password', 'new_password', 'confirmation'];
const REQUEST_FIELDS = ['action', 'requestId', 'budget_ms', 'authority', 'operation'];
const FORM_FIELDS: ReadonlySet<string> = new Set([...REQUEST_FIELDS, 'activate', 'accept_terms', ...ROLES]);
const VERIFY_FIELDS: ReadonlySet<string> = new Set([...REQUEST_FIELDS, 'code_field', 'activate']);
const RECONCILE_FIELDS: ReadonlySet<string> = new Set(REQUEST_FIELDS);
const AUTHORITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** One submission of the form's fields: the operation itself. */
export interface CredentialSubmitPayload extends Record<string, unknown> {
  authority: string;
  operation?: never;
  username?: BrowserRef;
  current_password?: BrowserRef;
  new_password?: BrowserRef;
  confirmation?: BrowserRef;
  /** A signup's required terms-of-service checkbox in the same form. */
  accept_terms?: BrowserRef;
  activate: BrowserRef;
}
/** A signup's email verification: the code field and its control when the site asks for a code. */
export interface CredentialVerifyPayload extends Record<string, unknown> {
  authority: string;
  operation: 'verify';
  code_field?: BrowserRef;
  activate?: BrowserRef;
}
/** Read-only settlement of an attempt whose outcome is not established. */
export interface CredentialReconcilePayload extends Record<string, unknown> {
  authority: string;
  operation: 'reconcile';
}
export type CredentialFormPayload = CredentialSubmitPayload | CredentialVerifyPayload | CredentialReconcilePayload;

const REF_MESSAGE = 'Choose credential fields and the activation control from a fresh observation.';

/** Only an authority and fresh refs: no value, selector or verdict is accepted. */
export function validateCredentialForm(content: Record<string, unknown>): CredentialFormPayload {
  const { authority, operation } = content;
  const fields =
    operation === 'reconcile'
      ? RECONCILE_FIELDS
      : operation === 'verify'
        ? VERIFY_FIELDS
        : operation === undefined || operation === 'submit'
          ? FORM_FIELDS
          : undefined;
  if (
    !fields ||
    Object.keys(content).some((key) => !fields.has(key)) ||
    typeof authority !== 'string' ||
    !AUTHORITY_ID.test(authority)
  )
    throw invalidArgs(
      'Choose the credential authority main recorded, submit, verify or reconcile, and fields from a fresh observation.',
    );
  if (operation === 'reconcile') return { authority, operation };
  if (operation === 'verify') {
    if ((content.code_field === undefined) !== (content.activate === undefined))
      throw invalidArgs('Name the verification code field together with the control that submits it, or neither.');
    if (content.code_field === undefined) return { authority, operation };
    const codeField = readBrowserRef(content.code_field, REF_MESSAGE);
    const activate = readBrowserRef(content.activate, REF_MESSAGE);
    if (codeField.ref === activate.ref)
      throw invalidArgs('Name the verification code field together with the control that submits it, or neither.');
    return { authority, operation, code_field: codeField, activate };
  }
  const payload: CredentialSubmitPayload = { authority, activate: readBrowserRef(content.activate, REF_MESSAGE) };
  for (const role of ROLES) if (content[role] !== undefined) payload[role] = readBrowserRef(content[role], REF_MESSAGE);
  if (content.accept_terms !== undefined) payload.accept_terms = readBrowserRef(content.accept_terms, REF_MESSAGE);
  const named = ROLES.flatMap((role) => payload[role]?.ref ?? []);
  const refs = [...named, ...(payload.accept_terms ? [payload.accept_terms.ref] : []), payload.activate.ref];
  if (
    named.length < 1 ||
    new Set(refs).size !== refs.length ||
    ((payload.confirmation || payload.current_password) && !payload.new_password)
  )
    throw invalidArgs(
      'Name each field once, with the new password beside any confirmation or current password, and the control that submits them.',
    );
  return payload;
}

/** Where 1Password stands after a confirmed website change. */
type VaultState = 'finalized' | 'conflict' | 'pending';
const vaultState = (status: CredentialFinalizeResult['status']): VaultState =>
  status === 'finalized' || status === 'conflict' ? status : 'pending';

/** Finalize a confirmed attempt and report its website outcome with the vault's resulting state. */
async function finalizedOutcome(
  attempt: Pick<CredentialAttempt, 'id' | 'kind'>,
  attempts: CredentialAttempts,
  assertActive: () => Promise<void>,
): Promise<Outcome> {
  return websiteOutcome(attempt.kind, vaultState((await attempts.finalize(attempt.id, assertActive)).status));
}

/**
 * A confirmed website change: the login holds the new password (`saved`,
 * `updated`); it was changed in 1Password meanwhile and stays as it was made
 * (`left_as_edited`); or 1Password is not updated yet (`pending`), which the
 * next reconcile finishes.
 */
function websiteOutcome(kind: CredentialKind, vault: VaultState): Outcome {
  const status = kind === 'signup' ? 'account_created' : 'password_changed';
  switch (vault) {
    case 'finalized':
      return { status, vault: kind === 'signup' ? 'saved' : 'updated' };
    case 'conflict':
      return { status, vault: 'left_as_edited' };
    case 'pending':
      return { status, vault: 'pending' };
  }
}

/** An attempt past its one disclosure is reported, never filled again. */
async function settledOutcome(
  attempt: CredentialAttempt,
  attempts: CredentialAttempts,
  assertActive: () => Promise<void>,
): Promise<Outcome | undefined> {
  switch (attempt.phase) {
    case 'preparing':
    case 'saved':
      return undefined;
    case 'exposed':
    case 'unknown':
      return { status: 'outcome_unknown' };
    case 'awaiting_verification':
      return { status: 'verification_requested' };
    case 'rejected':
      return refused('no_authority');
    case 'confirmed':
      return await finalizedOutcome(attempt, attempts, assertActive);
    case 'conflict':
    case 'finalized':
      return websiteOutcome(attempt.kind, attempt.phase);
  }
}

export async function executeCredentialForm(
  context: BrowserExecutionContext,
  content: Record<string, unknown>,
  dependencies: CredentialOperationDependencies = DEFAULT_DEPENDENCIES,
): Promise<Outcome> {
  const payload = validateCredentialForm(content);
  const { attempts } = dependencies;
  const attempt = await attempts.get(payload.authority);
  if (!attempt || attempt.job_id !== context.job.id) return refused('no_authority');
  if (payload.operation === 'reconcile') return reconcile(context, attempt, attempts);
  if (payload.operation === 'verify') {
    if (attempt.kind !== 'signup') throw invalidArgs('Only a new account verifies its email.');
    return verify(context, attempt, payload, attempts);
  }
  if (attempt.kind === 'signup' && payload.current_password)
    throw invalidArgs('A signup has no current password to fill.');
  if (attempt.kind === 'rotation' && (!payload.new_password || payload.username || payload.accept_terms))
    throw invalidArgs('A password change fills the current and new password fields, never a username or terms.');
  const settled = await settledOutcome(attempt, attempts, context.assertActive);
  if (settled) return settled;
  return onSitePage(context, (page) => runStep(context, page, attempt, payload, attempts));
}

/** Every page step runs in the job's navigation scope; another job's site is a stop, safe to repeat. */
async function onSitePage(context: BrowserExecutionContext, step: (page: Page) => Promise<Outcome>): Promise<Outcome> {
  const page = await context.page();
  try {
    return await withBrowserJobNavigation(context, page, () => step(page));
  } catch (error) {
    if (error instanceof BrowserSiteBusyError) return { status: 'stopped', reason: 'site_busy', repeat_safe: true };
    throw error;
  }
}

// ---------------------------------------------------------------- binding, before any disclosure

type StepRefusal =
  | 'stale_ref'
  | 'not_actionable'
  | 'origin_mismatch'
  | 'unsupported_form'
  | 'unsupported_terms'
  | 'form_changed'
  | Exclude<CredentialActivationClass, 'ordinary'>;
class StepStop extends Error {
  constructor(readonly reason: StepRefusal) {
    super(reason);
  }
}
const stopFor = (classification: Exclude<CredentialActivationClass, 'ordinary'>): StepStop =>
  new StepStop(classification);

/** A field the host fills: one of the account's, or the code a signup's verification email carried. */
type FieldRole = CredentialFormField | 'code';
interface ChosenField {
  readonly role: FieldRole;
  readonly ref: BrowserRef;
}
interface BoundField {
  readonly role: FieldRole;
  readonly pinned: PinnedBrowserRef;
  readonly binding: NativeCredentialBinding;
}
/** What else a binding covers: the step it submits, and a signup's terms checkbox. */
interface BindingScope {
  readonly step: 'credentials' | 'verification';
  readonly terms?: BrowserRef;
}
const fieldsOf = (payload: CredentialSubmitPayload): ChosenField[] =>
  ROLES.flatMap((role) => {
    const ref = payload[role];
    return ref ? [{ role, ref }] : [];
  });
interface CredentialGroup {
  readonly kind: CredentialKind;
  readonly site: string;
  readonly frame: Frame;
  readonly fields: readonly BoundField[];
  readonly native: NativeCredentialGroup;
}

const FINANCIAL_FIELD = /(?:cc-|credit.?card|card.?number|cvc|cvv|iban|routing)/iu;
const SECURITY_FIELD =
  /(?:e-?mail|phone|mobile|(?:^|[^a-z])tel(?:[^a-z]|$)|2fa|two.?factor|totp|mfa|otp|one-time-code)/iu;

/** A destination this operation may submit to: its own site over HTTPS, outside every financial and other security route. */
function destination(action: string, kind: CredentialKind, site: string): void {
  const classification = classifyCredentialNavigation(action, kind, site);
  if (classification === undefined) throw new StepStop('unsupported_form');
  if (classification !== 'ordinary') throw stopFor(classification);
}

/** A field a fill or the browser could change; a read-only, disabled or hidden one only carries what the account is. */
const editable = (field: NativeFieldFacts): boolean => field.type !== 'hidden' && !field.readonly && !field.disabled;

/**
 * The fields that may travel with the group: no payment or file field, and
 * for a change no editable sign-in field at all, since an email, phone or
 * code field there would change the account's security.
 */
function checkFields(fields: readonly NativeFieldFacts[], kind: CredentialKind): void {
  if (fields.some((field) => FINANCIAL_FIELD.test(`${field.name} ${field.autocomplete}`)))
    throw new StepStop('purchase_control');
  if (fields.some((field) => field.type === 'file')) throw new StepStop('unsupported_form');
  if (
    kind === 'rotation' &&
    fields.some(
      (field) =>
        editable(field) &&
        (['email', 'tel'].includes(field.type) || SECURITY_FIELD.test(`${field.name} ${field.autocomplete}`)),
    )
  )
    throw new StepStop('account_security');
}

/** The form the group submits: same-window, on its site, with only fields `checkFields` allows. */
function checkForm(facts: NativeCredentialFacts, group: Pick<CredentialGroup, 'kind' | 'site'>): void {
  const { form, override } = facts;
  for (const submission of [form, override])
    if (submission) {
      if (submission.target && submission.target !== '_self') throw new StepStop('unsupported_form');
      destination(submission.action, group.kind, group.site);
    }
  if (form) checkFields(form.fields, group.kind);
}

/**
 * A formless group has no form to bound what the site's handler sends: the
 * document stands in for one. Its address must be an ordinary page of the
 * operation's site, and every other field in it must pass `checkFields`.
 */
async function checkDocument(
  frame: Frame,
  group: Pick<CredentialGroup, 'kind' | 'site'>,
  native: Pick<NativeCredentialGroup, 'fields' | 'control'>,
  account: string,
): Promise<NativeDocumentField[]> {
  destination(frame.url(), group.kind, group.site);
  const others = await readNativeDocumentFields(frame, native, account);
  if (!others) throw new StepStop('unsupported_form');
  checkFields(others, group.kind);
  return others;
}

async function bindGroup(
  page: Page,
  attempt: CredentialAttempt,
  chosenFields: readonly ChosenField[],
  activate: BrowserRef,
  refs: ReadonlyMap<string, PinnedBrowserRef>,
  scope: BindingScope,
): Promise<CredentialGroup> {
  const pinned = (ref: BrowserRef): PinnedBrowserRef => {
    const found = refs.get(ref.ref);
    if (!found) throw new StepStop('stale_ref');
    return found;
  };
  const control = pinned(activate);
  const chosen = chosenFields.map(({ role, ref }) => ({ role, pinned: pinned(ref) }));
  const { frame } = control;
  const origin = httpsOrigin(frame.url());
  if (
    !origin ||
    registrableDomain(origin.origin) !== attempt.site ||
    chosen.some((field) => field.pinned.frame !== frame)
  )
    throw new StepStop('origin_mismatch');
  for (const element of [control.element, ...chosen.map((field) => field.pinned.element)])
    if ((await element.ownerFrame()) !== frame) throw new StepStop('origin_mismatch');
  const controlBinding = await inspectNativeCredentialControl(control.element, frame);
  if (!controlBinding || controlBinding.facts.origin !== origin.origin) throw new StepStop('unsupported_form');
  const fields: BoundField[] = [];
  for (const field of chosen) {
    const binding = await inspectNativeCredentialControl(field.pinned.element, frame);
    if (!binding) throw new StepStop('unsupported_form');
    fields.push({ ...field, binding });
  }
  const currentBound = fields.some((field) => field.role === 'current_password');
  const form = fields[0].binding.formBackendNodeId;
  for (const { role, binding } of fields)
    if (
      binding.frameId !== controlBinding.frameId ||
      binding.loaderId !== controlBinding.loaderId ||
      binding.facts.origin !== origin.origin ||
      binding.facts.tag !== 'INPUT' ||
      binding.formBackendNodeId !== form ||
      !(role === 'code'
        ? verificationCodeFits(binding.facts)
        : credentialFieldFits(role, binding.facts, attempt.kind, currentBound))
    )
      throw new StepStop('unsupported_form');
  if (controlBinding.formBackendNodeId !== null && controlBinding.formBackendNodeId !== form)
    throw new StepStop('unsupported_form');
  const group = { kind: attempt.kind, site: attempt.site, frame, fields };
  checkForm(fields[0].binding.facts, group);
  checkForm(controlBinding.facts, group);
  const others =
    form === null
      ? await checkDocument(
          frame,
          group,
          { control: controlBinding, fields: fields.map((field) => field.binding) },
          attempt.username,
        )
      : undefined;
  if (scope.step === 'credentials') {
    const namesAccount = (field: NativeFieldFacts): boolean =>
      editable(field) && credentialFieldFits('username', { ...field, id: '' }, attempt.kind, currentBound);
    // The Login is saved under the authority's username: a form that names the account must receive exactly that,
    if (!fields.some((field) => field.role === 'username') && fields[0].binding.facts.form?.fields.some(namesAccount))
      throw new StepStop('unsupported_form');
    // and a formless signup page, whose handler may send any field on it, must name no other account.
    if (attempt.kind === 'signup' && others?.some((field) => namesAccount(field) && field.holds === 'other'))
      throw new StepStop('unsupported_form');
  }
  const terms =
    scope.terms && (await bindTerms(page, attempt, pinned(scope.terms), controlBinding, form, origin.origin));
  const activation = await classifyCredentialActivation(page, control.element, attempt.kind, attempt.site, {
    formControl: controlBinding.formBackendNodeId === form,
    step: scope.step,
  });
  if (activation !== 'ordinary') throw stopFor(activation);
  return {
    ...group,
    native: { fields: fields.map((field) => field.binding), control: controlBinding, ...(terms ? { terms } : {}) },
  };
}

/**
 * A signup's terms checkbox, which the host alone checks just before the
 * activation: a required box in the same form, frame and document, named for
 * the site's terms of service, terms and conditions, user agreement or
 * privacy policy alone. Marketing, data sharing and money terms are refused.
 */
async function bindTerms(
  page: Page,
  attempt: CredentialAttempt,
  box: PinnedBrowserRef,
  control: NativeCredentialBinding,
  form: number | null,
  origin: string,
): Promise<NativeCredentialBinding> {
  if (attempt.kind !== 'signup' || (await box.element.ownerFrame()) !== box.frame)
    throw new StepStop('unsupported_terms');
  const binding = await inspectNativeCredentialControl(box.element, box.frame);
  if (
    !binding ||
    binding.frameId !== control.frameId ||
    binding.loaderId !== control.loaderId ||
    binding.formBackendNodeId !== form ||
    binding.facts.origin !== origin ||
    binding.facts.tag !== 'INPUT' ||
    binding.facts.type !== 'checkbox' ||
    !binding.facts.required ||
    !termsConsentLabel((await readControlFacts(page, box.element)).name)
  )
    throw new StepStop('unsupported_terms');
  return binding;
}

/** Nothing the browser chose may move between the binding and the disclosure; enabling a control is not a move. */
const sameBinding = (left: CredentialGroup, right: CredentialGroup): boolean => {
  const shape = (group: CredentialGroup): string =>
    JSON.stringify(group.native, (key: string, value: unknown) =>
      key === 'readonly' || key === 'disabled' || key === 'required' ? undefined : value,
    );
  return shape(left) === shape(right);
};

// ---------------------------------------------------------------- the website's response

/** Host signatures for the website's own response, never a model reading of the page. */
const SIGNALS = {
  exists:
    /\b(?:already (?:have an account|registered|exists?|in use|taken|associated)|account (?:already )?exists|(?:e-?mail|username)(?: address)? (?:is )?(?:already )?(?:registered|in use|taken))\b/iu,
  rejectedCurrent:
    /\b(?:(?:current|old|existing) password (?:is |was )?(?:incorrect|wrong|invalid|not correct)|incorrect (?:current )?password|wrong password)\b/iu,
  rejectedPassword:
    /\b(?:password (?:is )?(?:too (?:short|long|weak|common|simple)|must|should|needs? to|cannot|can't|does(?: not|n't) meet|not (?:strong|secure) enough|requirements?)|(?:weak|invalid|insecure) password|choose a (?:stronger|different) password|passwords? (?:do(?: not|n't) match|must match))\b/iu,
  verification:
    /\b(?:verify your (?:e-?mail|account|address)|check your (?:e-?mail|inbox)|we(?:'ve| have)? sent (?:you )?(?:an? )?(?:e-?mail|link|code|verification)|confirm your (?:e-?mail|account)|(?:verification|confirmation) (?:e-?mail|link|code) (?:has been |was )?sent)\b/iu,
  signupSuccess:
    /\b(?:account (?:has been |was )?(?:created|registered)|thanks for (?:signing up|registering|joining)|registration (?:is )?(?:complete|successful)|welcome to)\b/iu,
  changeSuccess:
    /\b(?:password (?:has been |was |is )?(?:successfully )?(?:changed|updated|saved)|(?:changed|updated|saved) your password|new password (?:has been |was )?saved)\b/iu,
  verified:
    /\b(?:(?:e-?mail|account)(?: address)? (?:has been |is |was )?(?:now )?(?:successfully )?(?:verified|confirmed|activated)|thanks?(?: you)? for (?:verifying|confirming)|verification (?:is |was )?(?:complete|successful))\b/iu,
  signedIn: /\b(?:sign|log)\s?out\b/iu,
} as const;
type Signal = keyof typeof SIGNALS;
/**
 * The site's text lines, so a new message is told apart from a hint already
 * on the page, and whether a password form is still, or again, on the site's
 * page, as a re-rendered rejection leaves it.
 */
interface SiteState {
  readonly lines: ReadonlySet<string>;
  readonly passwordForm: boolean;
}
const PASSWORD_INPUTS =
  'input[type="password"], input[autocomplete~="new-password"], input[autocomplete~="current-password"]';

/** Where a response is read: the bound frame and the page's main document, on the attempt's site. */
interface SiteScope {
  readonly frame: Frame;
  readonly site: string;
}

async function readSite(page: Page, scope: SiteScope): Promise<SiteState> {
  const lines = new Set<string>();
  let passwordForm = false;
  for (const frame of new Set([scope.frame, page.mainFrame()])) {
    if (frame.isDetached() || registrableDomain(frame.url()) !== scope.site) continue;
    try {
      const text = await frame.locator('body').innerText({ timeout: 1_000 });
      for (const line of text.split(/\n+/u)) if (line.trim()) lines.add(line.trim().toLowerCase());
      passwordForm ||= (await frame.locator(PASSWORD_INPUTS).count()) > 0;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a document mid-navigation simply has no text yet
    } catch (_error) {
      continue;
    }
  }
  return { lines, passwordForm };
}

type WebsiteResult =
  | 'account_exists'
  | 'current_password_rejected'
  | 'password_rejected'
  | 'verification_requested'
  | 'confirmed'
  | 'none';

/** Whether a signal is in a line that appeared since `before`: a signal already on the page proves nothing. */
const freshSignal = (before: SiteState, now: SiteState, signal: Signal): boolean =>
  [...now.lines].some((line) => !before.lines.has(line) && SIGNALS[signal].test(line));

/**
 * The website's own response to one submission, from the lines it showed
 * after it. Only a signup is ever verified by email: a change's notice that
 * the site emailed the account says nothing about whether it took.
 */
function websiteResult(kind: CredentialKind, before: SiteState, now: SiteState): WebsiteResult {
  const fresh = (signal: Signal): boolean => freshSignal(before, now, signal);
  if (kind === 'signup' && fresh('exists')) return 'account_exists';
  if (kind === 'rotation' && fresh('rejectedCurrent')) return 'current_password_rejected';
  if (fresh('rejectedPassword') && now.passwordForm) return 'password_rejected';
  if (kind === 'signup' && fresh('verification')) return 'verification_requested';
  if (kind === 'signup' ? fresh('signupSuccess') || (fresh('signedIn') && !now.passwordForm) : fresh('changeSuccess'))
    return 'confirmed';
  return 'none';
}

/** Polls the site for its response until it answers or the wait, bounded by the request's budget, ends. */
async function awaitSite<Result extends string>(
  context: BrowserExecutionContext,
  waitMs: number,
  read: () => Promise<Result | 'none'>,
): Promise<Result | 'none'> {
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, context.remaining() - 1_500));
  for (;;) {
    const result = await read();
    if (result !== 'none' || Date.now() >= deadline) return result;
    await sleep(250);
    await context.assertActive();
  }
}

const awaitWebsite = (
  context: BrowserExecutionContext,
  page: Page,
  group: CredentialGroup,
  before: SiteState,
  waitMs: number,
): Promise<WebsiteResult> =>
  awaitSite(context, waitMs, async () => websiteResult(group.kind, before, await readSite(page, group)));

/** A new account's own confirmation that its email is verified. Signed-in state counts only within the same document. */
function verificationResult(before: SiteState, now: SiteState, sameDocument: boolean): 'verified' | 'none' {
  return freshSignal(before, now, 'verified') ||
    freshSignal(before, now, 'signupSuccess') ||
    (sameDocument && freshSignal(before, now, 'signedIn') && !now.passwordForm)
    ? 'verified'
    : 'none';
}

/** A credential must never travel in an address: a GET submission or redirect carrying one is stopped in the browser. */
function carriesSecret(url: URL, secrets: readonly string[]): boolean {
  const values = [...url.searchParams.values(), url.hash];
  return secrets.some(
    (secret) =>
      url.href.includes(secret) ||
      url.href.includes(encodeURIComponent(secret)) ||
      values.some((value) => value.includes(secret)),
  );
}

// ---------------------------------------------------------------- one step

/** Binding and lease refusals become the step's own outcome; other errors cross as constant host prose. */
async function boundStep(
  page: Page,
  chosen: readonly BrowserRef[],
  step: (refs: ReadonlyMap<string, PinnedBrowserRef>) => Promise<Outcome>,
): Promise<Outcome> {
  let refs = new Map<string, PinnedBrowserRef>();
  try {
    refs = await pinBrowserRefs(page, chosen);
    return await step(refs);
  } catch (error) {
    if (error instanceof StepStop) return refused(error.reason);
    if (error instanceof BrowserRefError) return refused(error.reason);
    if (error instanceof BrowserSiteBusyError || error instanceof ActionRefusal) throw error;
    // Playwright and protocol errors may carry page prose; only constant host prose crosses this boundary.
    throw forbidden('The host could not safely bind this form. Take a fresh observation.');
  } finally {
    await disposeBrowserRefs(refs);
  }
}

/** The bound group's site, leased to this job before anything is filled. */
async function leaseSite(context: BrowserExecutionContext, group: CredentialGroup): Promise<void> {
  const lease = await new SiteLeaseStore(context.store.db).acquire(context.job.id, group.frame.url());
  await context.wakeWaiters(lease.waitingJobs, `${context.request.id}:credential-lease`);
  if (!lease.acquired) throw new BrowserSiteBusyError();
}

async function runStep(
  context: BrowserExecutionContext,
  page: Page,
  attempt: CredentialAttempt,
  payload: CredentialSubmitPayload,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  await context.assertActive();
  const fields = fieldsOf(payload);
  const scope: BindingScope = { step: 'credentials', ...(payload.accept_terms ? { terms: payload.accept_terms } : {}) };
  const chosen = [...fields.map((field) => field.ref), ...(scope.terms ? [scope.terms] : []), payload.activate];
  return boundStep(page, chosen, async (refs) => {
    const bind = (current: CredentialAttempt): Promise<CredentialGroup> =>
      bindGroup(page, current, fields, payload.activate, refs, scope);
    const group = await bind(attempt);
    await leaseSite(context, group);
    // Only a new password is a disclosure; a username-only step of a multi-step signup reveals nothing.
    return payload.new_password
      ? await disclosingStep(context, page, attempt, bind, group, attempts)
      : await usernameStep(context, page, attempt, group, attempts);
  });
}

/** The values the browser's chosen fields receive, in the group's order. */
function valuesFor(group: CredentialGroup, credential: CandidateCredential): string[] {
  return group.fields.map(({ role }) => {
    if (role === 'username') return credential.username;
    if (role === 'current_password') return credential.currentPassword ?? '';
    return credential.password;
  });
}

/** The credential scope for this activation and the response that follows it, removed afterwards. */
async function activateWithin(
  context: BrowserExecutionContext,
  page: Page,
  group: CredentialGroup,
  values: readonly string[],
  secrets: readonly string[],
  run: (activation: CredentialActivationResult) => Promise<Outcome>,
): Promise<Outcome> {
  const guard = await ensureBrowserNavigationGuard(page);
  guard.clearReason();
  return guard.runWithPolicy(
    {
      decide: (url) =>
        carriesSecret(url, secrets)
          ? 'blocked_address'
          : classifyCredentialNavigation(url.href, group.kind, group.site),
    },
    async () => {
      let activation: CredentialActivationResult = 'disabled';
      // A controlled form commonly enables its submit control only after its own state has the values.
      const until = Date.now() + Math.min(3_000, Math.max(0, context.remaining() - 2_000));
      for (;;) {
        activation = await activateNativeCredentialControl(group.frame, group.native, values, context.assertActive);
        if (activation !== 'disabled' || Date.now() >= until) break;
        await sleep(100);
      }
      return run(activation);
    },
  );
}

async function usernameStep(
  context: BrowserExecutionContext,
  page: Page,
  attempt: CredentialAttempt,
  group: CredentialGroup,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  const before = await readSite(page, group);
  const values = [attempt.username];
  await context.assertActive();
  const filled = await fillNativeCredentialGroup(group.frame, group.native, values, context.assertActive);
  if (filled === 'not_inserted') return refused('form_changed');
  return activateWithin(context, page, group, values, [], async (activation) => {
    if (activation === 'uncertain') return { status: 'outcome_unknown' };
    if (activation !== 'activated') return refused('form_changed');
    if ((await awaitWebsite(context, page, group, before, 3_000)) !== 'account_exists') return { status: 'continued' };
    // Nothing was disclosed: the account already exists, and this authority ends here.
    await attempts.abandon(attempt.id, context.assertActive);
    return { status: 'account_exists' };
  });
}

type Stopped = { readonly outcome: Outcome };

async function ensureSaved(
  attempt: CredentialAttempt,
  attempts: CredentialAttempts,
  assertActive: () => Promise<void>,
): Promise<{ readonly saved: CredentialAttempt } | Stopped> {
  if (attempt.phase === 'saved') return { saved: attempt };
  const saved =
    attempt.save_started_at === null
      ? await attempts.save(attempt.id, assertActive)
      : await attempts.reconcileSave(attempt.id, assertActive);
  switch (saved.status) {
    case 'saved':
      return { saved: saved.attempt };
    case 'not_owned':
      await attempts.abandon(attempt.id, assertActive);
      return { outcome: { status: 'not_owned' } };
    case 'rate_limited':
      return { outcome: { status: 'rate_limited' } };
    case 'absent':
      // The one create this attempt could send left nothing: the authority ends, and nothing reached a page.
      await attempts.abandon(attempt.id, assertActive);
      return { outcome: { status: 'vault_unavailable' } };
    default:
      return { outcome: { status: 'vault_unavailable' } };
  }
}

async function disclose(
  context: BrowserExecutionContext,
  attempt: CredentialAttempt,
  origin: string,
  attempts: CredentialAttempts,
): Promise<{ readonly credential: CandidateCredential } | Stopped> {
  const disclosed = await attempts.disclose(attempt.id, { jobId: context.job.id, origin }, context.assertActive);
  if (disclosed.status === 'disclosed') return { credential: disclosed.credential };
  if (disclosed.status !== 'refused') return { outcome: { status: disclosed.status } };
  switch (disclosed.reason) {
    case 'not_owned':
      await attempts.abandon(attempt.id, context.assertActive);
      return { outcome: { status: 'not_owned' } };
    case 'source_changed':
      await attempts.abandon(attempt.id, context.assertActive);
      return { outcome: refused('login_changed') };
    case 'origin_mismatch':
      return { outcome: refused('origin_mismatch') };
    case 'candidate_mismatch':
      return { outcome: { status: 'vault_unavailable' } };
    default:
      return { outcome: refused('no_authority') };
  }
}

/** Moves an exposed attempt without ever throwing past the step; a concurrent move already settled it. */
async function settle(move: () => Promise<unknown>): Promise<void> {
  try {
    await move();
  } catch (error) {
    if (!(error instanceof CredentialAttemptError)) throw error;
  }
}

/** An exposed attempt rejects only through unknown: a disclosure never moves straight to rejected. */
async function rejectExposed(attempts: CredentialAttempts, id: string, proof: CredentialEvidence): Promise<void> {
  await settle(() => attempts.markUnknown(id, proof));
  await settle(() => attempts.markRejected(id, proof));
}

/**
 * An error, or an activation the host cannot see through, after a value
 * reached the page, when nothing is safe to repeat: an attempt still in
 * flight becomes unknown, `watch` keeping the site's response for
 * reconciliation, and the answer is whatever the attempt recorded.
 */
async function interruptedOutcome(
  attempts: CredentialAttempts,
  attempt: Pick<CredentialAttempt, 'id' | 'kind'>,
  proof: CredentialEvidence,
  watch?: () => void,
): Promise<Outcome> {
  const current = await attempts.get(attempt.id);
  switch (current?.phase) {
    case 'exposed':
    case 'awaiting_verification':
      await settle(() => attempts.markUnknown(attempt.id, proof));
      watch?.();
      return { status: 'outcome_unknown' };
    // The website already confirmed it; only 1Password's update was cut short.
    case 'confirmed':
      return websiteOutcome(attempt.kind, 'pending');
    case 'conflict':
    case 'finalized':
      return websiteOutcome(attempt.kind, current.phase);
    default:
      return { status: 'outcome_unknown' };
  }
}

async function disclosingStep(
  context: BrowserExecutionContext,
  page: Page,
  prepared: CredentialAttempt,
  bind: (attempt: CredentialAttempt) => Promise<CredentialGroup>,
  bound: CredentialGroup,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  const ready = await ensureSaved(prepared, attempts, context.assertActive);
  if ('outcome' in ready) return ready.outcome;
  const { saved } = ready;
  // Saving waited on 1Password: anything that moved since the first binding refuses before disclosure.
  const group = await bind(saved).catch((error: unknown) => {
    throw error instanceof StepStop ? new StepStop('form_changed') : error;
  });
  if (!sameBinding(bound, group)) throw new StepStop('form_changed');
  const origin = httpsOrigin(group.frame.url())?.origin;
  if (!origin) throw new StepStop('origin_mismatch');
  let navigated = false;
  const navigation = (frame: Frame): void => {
    if (frame === group.frame) navigated = true;
  };
  const before = await readSite(page, group);
  // The site's verification email must not outrun its wait: it opens before anything is disclosed.
  const verifying =
    saved.kind === 'signup' &&
    (await openSignupVerification({
      jobId: context.job.id,
      claimId: `signup-${context.request.id}`,
      attemptId: saved.id,
      origin,
      username: saved.username,
    }));
  await context.assertActive();
  assertBrowserSecretDiagnosticsSafe();
  const disclosed = await disclose(context, saved, origin, attempts);
  if ('outcome' in disclosed) {
    if (verifying) await finishSignupVerification(saved.id);
    return disclosed.outcome;
  }
  const { credential } = disclosed;
  // From here the attempt is `exposed`: any failure leaves it for reconciliation, never for another fill.
  const secrets = [
    credential.password,
    ...(credential.currentPassword === undefined ? [] : [credential.currentPassword]),
  ];
  const evidence = (signal: string, fill: string, activation: string): CredentialEvidence => ({
    signal,
    fill,
    activation,
    navigated,
    form: group.native.fields[0].formBackendNodeId === null ? 'formless' : 'form',
  });
  /** An outcome left unknown after the control may have run: the response is watched for reconciliation. */
  const unknownAfterActivation = async (proof: CredentialEvidence): Promise<Outcome> => {
    await settle(() => attempts.markUnknown(saved.id, proof));
    watchResponse(saved.id, context, page, group, { step: 'credentials', before });
    return { status: 'outcome_unknown' };
  };
  page.on('framenavigated', navigation);
  try {
    for (const secret of secrets) {
      registerPageSecret(page, secret);
      await bindPageSecretDocuments(page, secret);
    }
    assertBrowserSecretDiagnosticsSafe();
    const values = valuesFor(group, credential);
    // A disable the operator published since the disclosure stops the insertion: nothing has reached the page yet.
    if (!(await attempts.usable(saved))) {
      await rejectExposed(attempts, saved.id, evidence('none', 'not_inserted', 'none'));
      return { status: 'vault_unavailable' };
    }
    const filled = await fillNativeCredentialGroup(group.frame, group.native, values, context.assertActive);
    if (filled === 'not_inserted') {
      // Proven: nothing reached the page, so no website could have acted on it.
      await rejectExposed(attempts, saved.id, evidence('none', filled, 'none'));
      return refused('form_changed');
    }
    return await activateWithin(context, page, group, values, secrets, async (activation) => {
      if (activation === 'activated') await attempts.markAwaitingVerification(saved.id);
      const result = await awaitWebsite(context, page, group, before, activation === 'activated' ? 15_000 : 2_000);
      const proof = evidence(result, filled, activation);
      if (activation !== 'activated') {
        // The site refused the value itself, before any submission this host made.
        if (result === 'password_rejected') {
          await rejectExposed(attempts, saved.id, proof);
          return { status: 'password_rejected' };
        }
        if (activation === 'uncertain') return unknownAfterActivation(proof);
        await settle(() => attempts.markUnknown(saved.id, proof));
        return { status: 'outcome_unknown' };
      }
      switch (result) {
        case 'account_exists':
        case 'current_password_rejected':
        case 'password_rejected':
          await attempts.markRejected(saved.id, proof);
          return { status: result };
        case 'verification_requested':
          return { status: 'verification_requested' };
        case 'confirmed':
          await attempts.markConfirmed(saved.id, proof);
          return await finalizedOutcome(saved, attempts, context.assertActive);
        case 'none':
          return unknownAfterActivation(proof);
      }
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- after a disclosure nothing is safe to repeat, and no Playwright, SDK or renderer prose crosses this boundary
  } catch (_error) {
    return await interruptedOutcome(attempts, saved, evidence('interrupted', 'unknown', 'unknown'));
  } finally {
    page.off('framenavigated', navigation);
    await settleFilledSecrets(context, page, secrets);
    // The wait stays open while the site may still send its verification email: asked for, or unknown.
    if (verifying) {
      const phase = (await attempts.get(saved.id))?.phase;
      if (phase !== 'awaiting_verification' && phase !== 'unknown') await finishSignupVerification(saved.id);
    }
  }
}

// ---------------------------------------------------------------- read-only reconciliation

/**
 * The response this host was watching when an activation's outcome stayed
 * unknown, in host memory only: the document, the site, the step it
 * submitted, and the lines it showed before the activation. A restart
 * forgets it, and so can only leave the attempt unknown.
 */
interface WatchedResponse extends SiteScope {
  readonly page: Page;
  readonly kind: CredentialKind;
  readonly step: BindingScope['step'];
  readonly before: SiteState;
  readonly requestId: string;
  readonly at: string;
}
const watchedResponses = new Map<string, WatchedResponse>();

/** Keeps the response to an activation whose outcome stayed unknown, for `reconcile` to read. */
function watchResponse(
  id: string,
  context: BrowserExecutionContext,
  page: Page,
  { frame, site, kind }: CredentialGroup,
  submitted: Pick<WatchedResponse, 'step' | 'before'>,
): void {
  watchedResponses.set(id, {
    page,
    frame,
    site,
    kind,
    ...submitted,
    requestId: context.request.id,
    at: new Date().toISOString(),
  });
}

/** Browser actions that cannot change what a site shows: anything else since the activation makes its response unattributable. */
const READ_ONLY_ACTIONS: ReadonlySet<unknown> = new Set(['observe', 'screenshot', 'wait_for']);
function readOnlyRequest(request: Pick<BrowserRequest, 'action' | 'payload_json'>): boolean {
  const payload: unknown = JSON.parse(request.payload_json);
  if (!isRecord(payload)) return false;
  if (request.action === 'credential_form') return payload.operation === 'reconcile';
  return (
    request.action === 'browser' &&
    Array.isArray(payload.actions) &&
    payload.actions.every((action: unknown) => isRecord(action) && READ_ONLY_ACTIONS.has(action.kind))
  );
}

/** The site's response is the activation's only if nothing since could have navigated or interacted. */
async function attributable(context: BrowserExecutionContext, watched: WatchedResponse): Promise<boolean> {
  const { db } = context.store;
  if (watched.page.isClosed() || !(await db.hasTable('gws_ea_browser_requests'))) return !watched.page.isClosed();
  const later = await db.all<Pick<BrowserRequest, 'action' | 'payload_json'>>(
    'SELECT action, payload_json FROM gws_ea_browser_requests WHERE job_id = ? AND id <> ? AND id <> ? AND started_at >= ?',
    context.job.id,
    watched.requestId,
    context.request.id,
    watched.at,
  );
  return later.every(readOnlyRequest);
}

/**
 * Settles an attempt without submitting anything (KTD8). From unknown, only
 * the website's own late response to the watched activation counts: a
 * rejection, a request to verify the email, or success; after a verification
 * code, only the account's confirmation. Otherwise it stays unknown, and its
 * site stays held. From confirmed, the vault's finalize runs again, reading
 * everything fresh.
 */
async function reconcile(
  context: BrowserExecutionContext,
  attempt: CredentialAttempt,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  switch (attempt.phase) {
    case 'preparing':
    case 'saved':
      return refused('not_disclosed');
    case 'confirmed':
      return await finalizedOutcome(attempt, attempts, context.assertActive);
    case 'unknown': {
      const watched = watchedResponses.get(attempt.id);
      if (!watched || !(await attributable(context, watched))) return { status: 'inconclusive' };
      return onSitePage(context, (page) => reconcileResponse(context, page, attempt, watched, attempts));
    }
    default:
      return (await settledOutcome(attempt, attempts, context.assertActive)) ?? refused('not_disclosed');
  }
}

/** The site's late response as `enterCode` would read it for a code, or as the submission would. */
function lateResult(watched: WatchedResponse, now: SiteState): WebsiteResult {
  if (watched.step === 'credentials') return websiteResult(watched.kind, watched.before, now);
  return verificationResult(watched.before, now, true) === 'verified' ? 'confirmed' : 'none';
}

async function reconcileResponse(
  context: BrowserExecutionContext,
  page: Page,
  attempt: CredentialAttempt,
  watched: WatchedResponse,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  if (page !== watched.page) return { status: 'inconclusive' };
  const result = lateResult(watched, await readSite(page, watched));
  if (result === 'none') return { status: 'inconclusive' };
  watchedResponses.delete(attempt.id);
  const proof: CredentialEvidence = { signal: result, reconciled: true };
  switch (result) {
    case 'account_exists':
    case 'current_password_rejected':
    case 'password_rejected':
      await attempts.markRejected(attempt.id, proof);
      return { status: result };
    case 'verification_requested':
      await attempts.markVerificationRequested(attempt.id, proof);
      return { status: 'verification_requested' };
    case 'confirmed':
      await attempts.markConfirmed(attempt.id, proof);
      return await finalizedOutcome(attempt, attempts, context.assertActive);
  }
}

// ---------------------------------------------------------------- email verification

/** Time kept for the host's own work after the verification email's answer arrives. */
const VERIFY_MARGIN_MS = 15_000;

/**
 * Completes a signup the site asked to confirm by email. Only the answer the
 * isolated interpreter returned for this signup's own claim is used, and only
 * by the host: a link is opened on the site, a code goes into the field the
 * browser named. Success needs the site's own fresh confirmation. The answer
 * stays for the next verify until the site may have it: once a link was
 * opened or a code entered, the wait ends, and without the site's
 * confirmation the signup is unknown, for reconcile to read the site's late
 * response or for the principal's release. With no wait for this signup's
 * mail, `not_watched`: the host cannot complete it, and the attempt stays for
 * the principal's release.
 */
async function verify(
  context: BrowserExecutionContext,
  attempt: CredentialAttempt,
  payload: CredentialVerifyPayload,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  if (attempt.phase !== 'awaiting_verification')
    return (await settledOutcome(attempt, attempts, context.assertActive)) ?? refused('not_disclosed');
  const arrived = await takeSignupVerification(context, attempt.id, context.remaining() - VERIFY_MARGIN_MS);
  if (arrived.status === 'nothing_arrived' || arrived.status === 'not_watched') return { status: arrived.status };
  if (arrived.status === 'unavailable') {
    await finishSignupVerification(attempt.id);
    return { status: 'ambiguous' };
  }
  const { reply, claim } = arrived;
  if (reply.kind === 'link')
    return onSitePage(context, async (page) => {
      const scope = { frame: page.mainFrame(), site: attempt.site };
      const before = await readSite(page, scope);
      let opened: Awaited<ReturnType<typeof openVerificationLink<'verified' | 'none'>>>;
      try {
        opened = await openVerificationLink(context, page, claim, reply.value, async () =>
          verificationResult(before, await readSite(page, scope), false),
        );
      } catch (error) {
        await finishSignupVerification(attempt.id);
        if (!(error instanceof ActionRefusal)) throw error;
        // Opening began, so the site may have taken the link; its window is closed, leaving nothing to watch.
        return interruptedOutcome(attempts, attempt, { signal: 'interrupted', via: 'link' });
      }
      if (typeof opened !== 'string') {
        // Off the site, the link waits for a step on it.
        if (opened.status === 'origin_mismatch') return refused('origin_mismatch');
        await finishSignupVerification(attempt.id);
        throw forbidden('The host refused an insecure or off-site verification link.');
      }
      await finishSignupVerification(attempt.id);
      // The link is spent: a landing without the site's confirmation leaves the signup unknown, the bearer page cleared.
      return opened === 'verified'
        ? confirmVerified(context, attempt, attempts, 'link')
        : interruptedOutcome(attempts, attempt, { signal: 'none', via: 'link' });
    });
  const { code_field: codeField, activate } = payload;
  // The code waits for a step that names its field.
  if (!codeField || !activate) return refused('code_field_needed');
  return onSitePage(context, (page) =>
    boundStep(page, [codeField, activate], async (refs) => {
      const group = await bindGroup(page, attempt, [{ role: 'code', ref: codeField }], activate, refs, {
        step: 'verification',
      });
      await leaseSite(context, group);
      return enterCode(context, page, attempt, group, reply.value, attempts);
    }),
  );
}

async function enterCode(
  context: BrowserExecutionContext,
  page: Page,
  attempt: CredentialAttempt,
  group: CredentialGroup,
  code: string,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  const before = await readSite(page, group);
  await context.assertActive();
  assertBrowserSecretDiagnosticsSafe();
  registerPageSecret(page, code);
  // Once the code is in the page the site may have taken it: only its late response can settle the signup.
  const unknownAfterCode = (proof: CredentialEvidence): Promise<Outcome> =>
    interruptedOutcome(attempts, attempt, proof, () =>
      watchResponse(attempt.id, context, page, group, { step: 'verification', before }),
    );
  let inserted = false;
  try {
    await bindPageSecretDocuments(page, code);
    const filled = await fillNativeCredentialGroup(group.frame, group.native, [code], context.assertActive);
    // Nothing reached the page: the answer stays for the next verify.
    if (filled === 'not_inserted') return refused('form_changed');
    inserted = true;
    return await activateWithin(context, page, group, [code], [code], async (activation) => {
      await finishSignupVerification(attempt.id);
      if (activation === 'uncertain') return unknownAfterCode({ signal: 'none', activation, via: 'code' });
      // A control that never ran can still leave a code its field submits by itself, so the site is read either way.
      const result = await awaitSite(context, activation === 'activated' ? 15_000 : 2_000, async () =>
        verificationResult(before, await readSite(page, group), true),
      );
      return result === 'verified'
        ? confirmVerified(context, attempt, attempts, 'code')
        : unknownAfterCode({ signal: 'none', activation, via: 'code' });
    });
  } catch (error) {
    if (!inserted) throw error;
    await finishSignupVerification(attempt.id);
    return await unknownAfterCode({ signal: 'interrupted', via: 'code' });
  } finally {
    await settleFilledSecrets(context, page, [code]);
  }
}

async function confirmVerified(
  context: BrowserExecutionContext,
  attempt: CredentialAttempt,
  attempts: CredentialAttempts,
  via: 'code' | 'link',
): Promise<Outcome> {
  await attempts.markConfirmed(attempt.id, { signal: 'verified', via });
  return await finalizedOutcome(attempt, attempts, context.assertActive);
}

// ---------------------------------------------------------------- recovery

/**
 * A credential_form its worker could not answer itself: a crash, cut-off or
 * failure (KTD8). An attempt this request disclosed and left in flight
 * becomes unknown; the answer reports the attempt's recorded outcome. It is
 * never a purchase and never a reason to fill again.
 */
export async function recoverCredentialRequest(
  request: BrowserRequest,
  attempts: CredentialAttempts = credentialAttempts,
): Promise<Outcome | undefined> {
  const payload: unknown = JSON.parse(request.payload_json);
  const authority = isRecord(payload) && typeof payload.authority === 'string' ? payload.authority : undefined;
  const attempt = authority === undefined ? undefined : await attempts.get(authority);
  if (!attempt || attempt.job_id !== request.job_id || attempt.exposed_at === null || request.started_at === null)
    return undefined;
  // Only this request's own disclosure: an attempt another step disclosed keeps its state.
  if (attempt.exposed_at < request.started_at) return undefined;
  switch (attempt.phase) {
    case 'exposed':
    case 'awaiting_verification':
      await settle(() => attempts.markUnknown(attempt.id, { signal: 'interrupted' }));
      return { status: 'outcome_unknown' };
    case 'unknown':
      return { status: 'outcome_unknown' };
    case 'confirmed':
      return websiteOutcome(attempt.kind, 'pending');
    case 'conflict':
    case 'finalized':
      return websiteOutcome(attempt.kind, attempt.phase);
    default:
      return undefined;
  }
}

/**
 * Startup, after interrupted requests were answered, DB-only: an attempt
 * still shown exposed had no answer to settle it and becomes unknown. A save
 * whose one create may have reached 1Password is left to the attempt's next
 * step, which reconciles it by its marker and never creates again; no
 * provider call can hold up the browser's admission.
 */
export async function recoverCredentialAttempts(attempts: CredentialAttempts = credentialAttempts): Promise<void> {
  for (const attempt of await attempts.unresolved())
    if (attempt.phase === 'exposed') {
      await settle(() => attempts.markUnknown(attempt.id, { signal: 'interrupted' }));
      log.warn('Credential attempt left exposed by a stopped host is now unknown', { attemptId: attempt.id });
    }
}

registerBrowserQueuedAction('credential_form', {
  validate: validateCredentialForm,
  execute: (context, payload) => executeCredentialForm(context, payload),
  recover: (request) => recoverCredentialRequest(request),
});
