import { classifyNavigationUrl } from './control-policy.js';
import { BrowserConsentStop, consentStopsForAgent } from './consent.js';
import type { Frame, Page } from 'playwright-core';
import { getDomain } from 'tldts';
import { ActionRefusal, answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { getSession } from '../../db/sessions.js';
import { registerDeliveryAction } from '../../delivery.js';
import type { Session } from '../../types.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-external-email/index.js';
import {
  cleanupSignInClaims,
  createSignInClaim,
  finishSignInClaim,
  getSignInClaim,
  recoverSignInClaims,
  type SignInClaim,
} from '../gws-ea-inbox/claims.js';
import { activeInbox, assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { ensureBrowserNavigationGuard, framesUnreadyStop, withBrowserJobNavigation } from './commit-classifier.js';
import {
  assertBrowserSecretDiagnosticsSafe,
  bindBrowserSecretFields,
  fillBoundBrowserSecrets,
  BrowserOriginMismatchError,
  type BrowserSecretFillResult,
} from './fill.js';
import { httpsOrigin } from './authentication-signatures.js';
import { registrableDomain } from './login-store.js';
import {
  disposeBrowserRefs,
  pinBrowserRefs,
  readBrowserRef,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import { bindPageSecretDocuments, registerPageSecret, releasePageSecret } from './page-privacy.js';
import type { BrowserExecutionContext, BrowserQueuedAction } from './actions.js';
import { signInAddress } from './web-address.js';

/** Starts a sign-in by filling the alias into `email_field`, or finishes it with the emailed answer. */
type SignInPayload =
  | { readonly email_field: BrowserRef }
  | { readonly code_field?: BrowserRef; readonly submit?: BrowserRef };
function browserRef(raw: unknown): BrowserRef {
  return readBrowserRef(raw, 'Choose the field and control from a fresh observation.');
}
export function validateSignInCode(content: Record<string, unknown>): SignInPayload {
  if (
    Object.keys(content).some(
      (key) => !['action', 'requestId', 'budget_ms', 'email_field', 'code_field', 'submit'].includes(key),
    )
  )
    throw invalidArgs('Choose current field and control references.');
  if (content.email_field !== undefined) {
    if (content.code_field !== undefined || content.submit !== undefined)
      throw invalidArgs('Fill the email field first; name the code field and its control after the code is sent.');
    return { email_field: browserRef(content.email_field) };
  }
  if ((content.code_field === undefined) !== (content.submit === undefined))
    throw invalidArgs('Name the code field together with the control that submits it, or neither.');
  if (content.code_field === undefined) return {};
  const codeField = browserRef(content.code_field);
  const submit = browserRef(content.submit);
  if (codeField.ref === submit.ref)
    throw invalidArgs('Name the code field together with the control that submits it, or neither.');
  return { code_field: codeField, submit };
}

export type SignInReply = { readonly kind: 'code' | 'link'; readonly value: string } | { readonly kind: 'unavailable' };
export type SignInCredential = Extract<SignInReply, { readonly value: string }>;
/**
 * An answer the assistant's own mail may bring for one job: a new account's verification, or a sign-in's code or
 * link. The host opens the wait before the site can send its email, so the email cannot outrun it, and binds its
 * claim to that site and account: only mail from that site, to that account, reaches the isolated interpreter for
 * it. The interpreter's one answer is held in host memory alone, never a record, until the step that uses it ends
 * the wait or the claim expires; a step that cannot use it yet leaves it for the next.
 */
interface MailWait {
  readonly claimId: string;
  readonly jobId: string;
  /** A signup's attempt id, or the job's sign-in. */
  readonly key: string;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
  readonly listeners: Set<() => void>;
  reply?: SignInReply;
}
const mailWaits = new Map<string, MailWait>();
const signInKey = (jobId: string): string => `sign-in:${jobId}`;

function dropMailWait(wait: MailWait): void {
  if (mailWaits.get(wait.claimId) !== wait) return;
  mailWaits.delete(wait.claimId);
  clearTimeout(wait.timer);
  for (const listener of [...wait.listeners]) listener();
}

async function finishMailWait(key: string): Promise<void> {
  for (const wait of [...mailWaits.values()])
    if (wait.key === key) {
      dropMailWait(wait);
      await finishSignInClaim(wait.claimId);
    }
}

/** Replaces any earlier wait under the same key; a new claim also ends the job's earlier sign-in claim. */
async function openMailWait(input: {
  readonly jobId: string;
  readonly claimId: string;
  readonly key: string;
  readonly origin: string;
  readonly binding: Readonly<Record<string, unknown>>;
}): Promise<void> {
  await finishMailWait(input.key);
  const claim = await createSignInClaim({
    id: input.claimId,
    jobId: input.jobId,
    origin: input.origin,
    binding: input.binding,
  });
  for (const wait of [...mailWaits.values()])
    if (wait.jobId === input.jobId && (await getSignInClaim(wait.claimId))?.state !== 'waiting') dropMailWait(wait);
  const expiresAt = Date.parse(claim.expires_at);
  const wait: MailWait = {
    claimId: claim.id,
    jobId: input.jobId,
    key: input.key,
    expiresAt,
    listeners: new Set(),
    timer: setTimeout(() => dropMailWait(wait), Math.max(0, expiresAt - Date.now())),
  };
  wait.timer.unref();
  mailWaits.set(claim.id, wait);
}

export type MailWaitReply =
  | { readonly status: 'arrived'; readonly reply: SignInCredential; readonly claim: SignInClaim }
  | { readonly status: 'unavailable' }
  | { readonly status: 'nothing_arrived' }
  | { readonly status: 'not_watched' };

/**
 * The held answer for this job's wait under `key`, waiting at most `waitMs` and the claim's life for it. Reading it
 * does not spend it. `not_watched` means no wait exists, or it ended: the claim expired, was finished or was
 * forgotten by a restart. Nothing later can arrive for it.
 */
async function takeMailWait(
  context: Pick<BrowserExecutionContext, 'job' | 'signal' | 'remaining'>,
  key: string,
  waitMs: number,
): Promise<MailWaitReply> {
  const wait = [...mailWaits.values()].find((candidate) => candidate.key === key && candidate.jobId === context.job.id);
  if (!wait) return { status: 'not_watched' };
  if (wait.reply === undefined) {
    const duration = Math.max(0, Math.min(90_000, waitMs, wait.expiresAt - Date.now()));
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', done);
        wait.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, duration);
      context.signal.addEventListener('abort', done, { once: true });
      wait.listeners.add(done);
      if (context.signal.aborted) done();
    });
  }
  const { reply } = wait;
  if (mailWaits.get(wait.claimId) !== wait) return { status: 'not_watched' };
  if (reply === undefined) return { status: 'nothing_arrived' };
  if (reply.kind === 'unavailable') return { status: 'unavailable' };
  const claim = await getSignInClaim(wait.claimId);
  return claim ? { status: 'arrived', reply, claim } : { status: 'not_watched' };
}

/** Whether this account's mail reaches the assistant's own mailbox, a +tag on one of its addresses included. */
async function assistantMailbox(account: string): Promise<boolean> {
  const address = account.toLowerCase();
  const tagged = /^([^@+]+)\+[^@]*(@.+)$/u.exec(address);
  const addresses = await assistantAddresses();
  return addresses.has(address) || (tagged !== null && addresses.has(`${tagged[1]}${tagged[2]}`));
}

/**
 * Opens a signup's verification wait, replacing any earlier one for it.
 * False when no inbox is active or the account's mail does not reach the
 * assistant's own inbox.
 */
export async function openSignupVerification(input: {
  readonly jobId: string;
  readonly claimId: string;
  readonly attemptId: string;
  readonly origin: string;
  readonly username: string;
}): Promise<boolean> {
  if (!activeInbox() || !(await assistantMailbox(input.username))) return false;
  await openMailWait({
    jobId: input.jobId,
    claimId: input.claimId,
    key: input.attemptId,
    origin: input.origin,
    binding: { attempt: input.attemptId, username: input.username },
  });
  return true;
}

export type SignupVerificationReply = MailWaitReply;

/**
 * The verification email's answer for this job's signup, waiting at most `waitMs` and the claim's life for it.
 * `not_watched` also means the account's mail does not reach the assistant's inbox, so nothing can arrive.
 */
export function takeSignupVerification(
  context: Pick<BrowserExecutionContext, 'job' | 'signal' | 'remaining'>,
  attemptId: string,
  waitMs = context.remaining(),
): Promise<SignupVerificationReply> {
  return takeMailWait(context, attemptId, waitMs);
}

export function finishSignupVerification(attemptId: string): Promise<void> {
  return finishMailWait(attemptId);
}

function signInReply(content: Record<string, unknown>): SignInReply {
  if (Object.keys(content).some((key) => !['action', 'requestId', 'kind', 'value'].includes(key)))
    throw invalidArgs('Return one sign-in code, one link, or unavailable.');
  if (content.kind === 'unavailable' && content.value === undefined) return { kind: 'unavailable' };
  if (
    (content.kind === 'code' || content.kind === 'link') &&
    typeof content.value === 'string' &&
    content.value.trim().length > 0 &&
    content.value.length <= 8_192 &&
    !hasControlCharacters(content.value)
  )
    return { kind: content.kind, value: content.value.trim() };
  throw invalidArgs('Return one sign-in code, one link, or unavailable.');
}

/** The session selects the claim; the answer is held for the browser step that uses it, never written down. */
export async function answerSignInReply(
  content: Record<string, unknown>,
  session: Session,
): Promise<{ status: 'accepted' | 'no_wait' }> {
  if (session.agent_group_id !== (await getExternalEmailAgentGroupId()))
    throw forbidden('Only the host sign-in interpreter may answer.');
  const reply = signInReply(content);
  const prefix = 'system:browser-sign-in:';
  const claimId =
    session.messaging_group_id === null && session.thread_id?.startsWith(prefix)
      ? session.thread_id.slice(prefix.length)
      : undefined;
  const wait = claimId ? mailWaits.get(claimId) : undefined;
  const claim = claimId ? await getSignInClaim(claimId) : undefined;
  const current = await getSession(session.id);
  if (
    !wait ||
    !claim ||
    claim.state !== 'waiting' ||
    claim.gmail_message_id === null ||
    claim.job_id !== wait.jobId ||
    Date.parse(claim.expires_at) <= Date.now() ||
    current?.status !== 'active' ||
    current.agent_group_id !== session.agent_group_id ||
    current.messaging_group_id !== null ||
    current.thread_id !== session.thread_id
  )
    return { status: 'no_wait' };
  // The answer waits for the step that uses it; only the first answer is kept.
  if (wait.reply !== undefined || mailWaits.get(claim.id) !== wait) return { status: 'no_wait' };
  wait.reply = reply;
  for (const listener of [...wait.listeners]) listener();
  return { status: 'accepted' };
}

const signInReplyGuard = defineGuardedAction({
  action: 'gws_ea_browser.sign_in_reply',
  async decide({ actor }) {
    return actor.kind === 'agent' && actor.agentGroupId === (await getExternalEmailAgentGroupId())
      ? ALLOW('The sealed external-email interpreter answers its own host sign-in task.')
      : DENY('Only the host sign-in interpreter may answer.');
  },
});

/**
 * Opens an emailed sign-in or verification link on its claim's site, from the job's main document there, reading
 * the landing page through `landing` before the bearer document is cleared. Bearer navigation has no observation
 * boundary until a fresh root document and empty history exist. An insecure, off-site or account-security link is
 * `refused` before anything opens it; a failure once opening began throws, and the site may have taken the link by
 * then.
 */
export async function openVerificationLink<T>(
  context: BrowserExecutionContext,
  page: Page,
  claim: SignInClaim,
  link: string,
  landing: () => Promise<T>,
): Promise<T | { readonly status: 'origin_mismatch' | 'refused' }> {
  const url = httpsOrigin(link);
  if (
    !url ||
    getDomain(url.hostname, { allowPrivateDomains: true }) !== claim.domain ||
    classifyNavigationUrl(url.href) === 'account_security'
  )
    return { status: 'refused' };
  const origin = httpsOrigin(page.mainFrame().url());
  if (!origin || getDomain(origin.hostname, { allowPrivateDomains: true }) !== claim.domain)
    return { status: 'origin_mismatch' };
  return openBearerLink(
    context,
    { page, frame: page.mainFrame(), origin: origin.origin },
    claim,
    link,
    landing,
    'The host could not safely open this verification link.',
  );
}

async function openBearerLink<T>(
  context: BrowserExecutionContext,
  site: { readonly page: Page; readonly frame: Frame; readonly origin: string },
  claim: SignInClaim,
  link: string,
  landing: () => Promise<T>,
  failure: string,
): Promise<T | { readonly status: 'origin_mismatch' }> {
  const { page } = site;
  if (httpsOrigin(site.frame.url())?.origin !== site.origin || site.frame !== page.mainFrame())
    return { status: 'origin_mismatch' };
  assertBrowserSecretDiagnosticsSafe();
  const secrets = new Set<string>();
  /** Every part of a bearer address is secret from the moment it is known, before any traffic. */
  const taint = (raw: string): void => {
    const url = new URL(raw);
    const values = [
      raw,
      ...url.searchParams.values(),
      url.hash.slice(1),
      ...url.pathname.split('/').filter((part) => part.length >= 4),
    ];
    for (const value of values)
      if (value) {
        secrets.add(value);
        registerPageSecret(page, value);
      }
  };
  // Chrome answers no frame-tree read while a document request waits in the guard, so documents are
  // bound only between navigations: before the first, and as each one commits.
  const bindSecrets = async (): Promise<void> => {
    for (const value of secrets) await bindPageSecretDocuments(page, value);
  };
  let sanitized = false;
  let sanitizing = false;
  const documents = new Set<Promise<void>>();
  const navigation = (): void => {
    if (sanitizing) return;
    const work = bindSecrets();
    documents.add(work);
    void work.catch(() => undefined);
  };
  page.on('framenavigated', navigation);
  try {
    const guard = await ensureBrowserNavigationGuard(page);
    guard.clearReason();
    taint(link);
    await bindSecrets();
    const landed = await guard.runWithPolicy(
      {
        stripReferrer: true,
        classify(url) {
          if (!httpsOrigin(url.href) || getDomain(url.hostname, { allowPrivateDomains: true }) !== claim.domain)
            return 'blocked_address';
          return classifyNavigationUrl(url.href);
        },
        async beforeNavigate(url) {
          await context.assertActive();
          if (!sanitizing) taint(url.href);
          return 'ordinary';
        },
      },
      async () => {
        await context.assertActive();
        assertBrowserSecretDiagnosticsSafe();
        await page.goto(link, { waitUntil: 'domcontentloaded', referer: '' });
        await Promise.all(documents);
        await bindSecrets();
        if (guard.reason()) throw forbidden('The sign-in link left its permitted site.');
        await context.assertActive();
        const read = await landing();
        await context.assertActive();
        sanitizing = true;
        await page.goto(`${claim.origin}/`, { waitUntil: 'domcontentloaded', referer: '' });
        await context.assertActive();
        if (guard.reason() || page.url() !== `${claim.origin}/`)
          throw forbidden('The sign-in link could not be cleared safely.');
        const session = await page.context().newCDPSession(page);
        try {
          await session.send('Page.resetNavigationHistory');
        } finally {
          await session.detach();
        }
        sanitized = true;
        return read;
      },
    );
    return landed;
  } catch (_error) {
    await context.runtime.closeJob(context.job.id).catch(() => undefined);
    throw forbidden(failure);
  } finally {
    page.off('framenavigated', navigation);
    if (sanitized || page.isClosed()) for (const value of secrets) releasePageSecret(page, value);
  }
}

/** Time kept for the host's own fill and submission after the emailed answer arrives. */
const SIGN_IN_MARGIN_MS = 10_000;

/**
 * Fills the web alias into the field the agent named, as a redaction rather than a host-held secret, so the agent's
 * own press of the site's send control goes ahead; the claim opens first, so the site's email cannot outrun it.
 */
async function startSignIn(
  context: BrowserExecutionContext,
  page: Page,
  emailField: BrowserRef,
): Promise<Record<string, unknown>> {
  let refs = new Map<string, PinnedBrowserRef>();
  try {
    refs = await pinBrowserRefs(page, [emailField]);
    const target = refs.get(emailField.ref)!;
    // The assistant signs in with its web address, never one it converses from.
    const email = await signInAddress(await target.element.inputValue());
    if (email === undefined) return { status: 'alias_unavailable' };
    const site = registrableDomain(target.frame.url());
    if (!site) return { status: 'origin_mismatch' };
    const binding = await bindBrowserSecretFields(page, [{ field: 'username', target }], undefined, site);
    await openMailWait({
      jobId: context.job.id,
      claimId: `signin-${context.request.id}`,
      key: signInKey(context.job.id),
      origin: binding.origin,
      binding: { username: email },
    });
    const filled = await fillBoundBrowserSecrets(context, binding, async () => [email]).catch(
      async (error: unknown) => {
        await finishMailWait(signInKey(context.job.id));
        throw error;
      },
    );
    if (filled.status !== 'filled') await finishMailWait(signInKey(context.job.id));
    return filled;
  } finally {
    await disposeBrowserRefs(refs);
  }
}

/**
 * Uses the answer the job's sign-in mail brought: a link is opened on the claim's site; a code goes into the field
 * the agent named on that site and is submitted with its control in this one call. The answer stays for the next
 * step until it may have reached the site.
 */
async function finishSignIn(
  context: BrowserExecutionContext,
  page: Page,
  payload: { readonly code_field?: BrowserRef; readonly submit?: BrowserRef },
): Promise<Record<string, unknown>> {
  const key = signInKey(context.job.id);
  const arrived = await takeMailWait(context, key, context.remaining() - SIGN_IN_MARGIN_MS);
  await context.assertActive();
  if (arrived.status === 'nothing_arrived' || arrived.status === 'not_watched') return { status: arrived.status };
  if (arrived.status === 'unavailable') {
    await finishMailWait(key);
    return { status: 'ambiguous' };
  }
  const { reply, claim } = arrived;
  if (reply.kind === 'link') {
    let opened: Awaited<ReturnType<typeof openVerificationLink<{ readonly status: 'link_opened' }>>>;
    try {
      opened = await openVerificationLink(context, page, claim, reply.value, async () => ({
        status: 'link_opened' as const,
      }));
    } catch (error) {
      await finishMailWait(key);
      throw error;
    }
    // Off the claim's site, the link waits for a step on it.
    if (opened.status === 'origin_mismatch') return opened;
    await finishMailWait(key);
    if (opened.status === 'refused') throw forbidden('The host refused an insecure or off-site sign-in link.');
    return opened;
  }
  const { code_field: codeField, submit } = payload;
  // The code waits for a step that names its field.
  if (!codeField || !submit) return { status: 'code_field_needed' };
  let refs = new Map<string, PinnedBrowserRef>();
  try {
    refs = await pinBrowserRefs(page, [codeField, submit]);
    const target = refs.get(codeField.ref)!;
    if (registrableDomain(target.frame.url()) !== claim.domain) return { status: 'origin_mismatch' };
    const binding = await bindBrowserSecretFields(
      page,
      [{ field: 'code', target }],
      refs.get(submit.ref)!,
      claim.domain,
    );
    let filled: BrowserSecretFillResult;
    try {
      filled = await fillBoundBrowserSecrets(context, binding, async () => [reply.value]);
    } catch (error) {
      // A consent stop submitted nothing; any other failure may have left the code with the site.
      if (!(error instanceof BrowserConsentStop)) await finishMailWait(key);
      throw error;
    }
    if (filled.status === 'submitted' || filled.status === 'cleared_after_submit') {
      await finishMailWait(key);
      return { status: 'code_filled' };
    }
    return filled;
  } finally {
    await disposeBrowserRefs(refs);
  }
}

export async function executeSignInCode(
  context: BrowserExecutionContext,
  content: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = validateSignInCode(content);
  const starting = 'email_field' in payload;
  if (starting && !activeInbox()) throw forbidden('The assistant inbox is unavailable.');
  assertBrowserSecretDiagnosticsSafe();
  const page = await context.page();
  return withBrowserJobNavigation(context, page, async () => {
    try {
      await context.assertActive();
      return 'email_field' in payload
        ? await startSignIn(context, page, payload.email_field)
        : await finishSignIn(context, page, payload);
    } catch (error) {
      if (error instanceof BrowserOriginMismatchError) return { status: 'origin_mismatch' };
      if (error instanceof BrowserConsentStop)
        return { status: 'stopped', reason: error.reason, consent: consentStopsForAgent(error.stops) };
      if (error instanceof ActionRefusal) throw error;
      throw forbidden('The host could not safely complete this sign-in. Take a fresh observation.');
    }
  }).catch((error: unknown) => {
    const refused = framesUnreadyStop(error);
    if (refused) return refused;
    throw error;
  });
}

export function registerSignInMailDelivery(): void {
  registerDeliveryAction(
    'sign_in_reply',
    answeringAction('sign_in_reply', answerSignInReply),
    answeredGuard(signInReplyGuard),
  );
}

export async function recoverBrowserSignInMail(): Promise<void> {
  for (const wait of [...mailWaits.values()]) dropMailWait(wait);
  await recoverSignInClaims();
}
export async function cleanupBrowserSignInMail(jobId?: string): Promise<void> {
  if (jobId && (await getDb().hasTable('gws_ea_browser_sign_in_claims'))) {
    await getDb().run('UPDATE gws_ea_browser_sign_in_claims SET state = ? WHERE job_id = ?', 'finished', jobId);
  }
  for (const wait of [...mailWaits.values()]) {
    const claim = await getSignInClaim(wait.claimId);
    if (!claim || claim.state !== 'waiting' || wait.expiresAt <= Date.now() || wait.jobId === jobId) dropMailWait(wait);
  }
  await cleanupSignInClaims();
}

export const signInCodeAction: BrowserQueuedAction = { validate: validateSignInCode, execute: executeSignInCode };
