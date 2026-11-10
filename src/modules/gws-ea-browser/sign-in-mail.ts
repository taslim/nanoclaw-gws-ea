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
import { authenticationFieldKind } from './authentication-signatures.js';
import { ensureBrowserNavigationGuard, framesUnreadyStop, withBrowserJobNavigation } from './commit-classifier.js';
import {
  assertBrowserSecretDiagnosticsSafe,
  activateBoundBrowserSignIn,
  bindBrowserSecretFields,
  discoverAuthenticationCodeField,
  fillBoundBrowserSecrets,
  BrowserOriginMismatchError,
  type BoundBrowserSecretFields,
} from './fill.js';
import { httpsOrigin } from './authentication-signatures.js';
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

interface SignInPayload extends Record<string, unknown> {
  target: BrowserRef;
  send: BrowserRef;
  submit?: BrowserRef;
}
function browserRef(raw: unknown): BrowserRef {
  return readBrowserRef(raw, 'Choose a field and send control from a fresh observation.');
}
export function validateSignInCode(content: Record<string, unknown>): SignInPayload {
  if (
    Object.keys(content).some((key) => !['action', 'requestId', 'budget_ms', 'target', 'send', 'submit'].includes(key))
  )
    throw invalidArgs('Choose current field and control references.');
  return {
    target: browserRef(content.target),
    send: browserRef(content.send),
    ...(content.submit === undefined ? {} : { submit: browserRef(content.submit) }),
  };
}

function sameOrigin(binding: BoundBrowserSecretFields): boolean {
  return httpsOrigin(binding.fields[0].target.frame.url())?.origin === binding.origin;
}
async function codeBinding(
  page: Page,
  binding: BoundBrowserSecretFields,
): Promise<BoundBrowserSecretFields | undefined> {
  if (!sameOrigin(binding)) return undefined;
  return binding.fields[0].field === 'otp' ? binding : discoverAuthenticationCodeField(page, binding);
}

export type SignInReply = { readonly kind: 'code' | 'link'; readonly value: string } | { readonly kind: 'unavailable' };
export type SignInCredential = Extract<SignInReply, { readonly value: string }>;
interface AssistantWait {
  readonly jobId: string;
  readonly assertActive: () => Promise<void>;
  complete(reply?: SignInReply): void;
}
const assistantWaits = new Map<string, AssistantWait>();

/** Installed before sending the request, so an immediately arriving email cannot outrun the waiter. */
function awaitAssistantReply(
  context: BrowserExecutionContext,
  claim: SignInClaim,
): {
  answer: Promise<SignInReply | undefined>;
  dispose(): void;
} {
  let finish!: (reply?: SignInReply) => void;
  const answer = new Promise<SignInReply | undefined>((resolve) => {
    finish = resolve;
  });
  const aborted = (): void => complete();
  const duration = Math.max(
    0,
    Math.min(90_000, context.remaining() - 1_000, Date.parse(claim.expires_at) - Date.now()),
  );
  const timer = setTimeout(aborted, duration);
  function complete(reply?: SignInReply): void {
    if (assistantWaits.get(claim.id) !== wait) return;
    assistantWaits.delete(claim.id);
    clearTimeout(timer);
    context.signal.removeEventListener('abort', aborted);
    finish(reply);
  }
  const wait: AssistantWait = { jobId: context.job.id, assertActive: context.assertActive, complete };
  assistantWaits.set(claim.id, wait);
  context.signal.addEventListener('abort', aborted, { once: true });
  if (context.signal.aborted || duration === 0) complete();
  return { answer, dispose: complete };
}

/**
 * A new account waiting for its verification email. The host opens the wait
 * before the signup's activation, so the site's email cannot outrun it, and
 * binds its claim to that signup's site, origin and account: only mail from
 * that site, to that account, reaches the isolated interpreter for it. The
 * interpreter's one answer is held in host memory alone, never a record,
 * until that signup's own verify step uses it or the claim expires.
 */
interface SignupVerification {
  readonly claimId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
  readonly listeners: Set<() => void>;
  reply?: SignInReply;
}
const signupVerifications = new Map<string, SignupVerification>();

function dropSignupVerification(verification: SignupVerification): void {
  if (signupVerifications.get(verification.claimId) !== verification) return;
  signupVerifications.delete(verification.claimId);
  clearTimeout(verification.timer);
  for (const listener of [...verification.listeners]) listener();
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
  await finishSignupVerification(input.attemptId);
  const claim = await createSignInClaim({
    id: input.claimId,
    jobId: input.jobId,
    origin: input.origin,
    binding: { attempt: input.attemptId, username: input.username },
  });
  const expiresAt = Date.parse(claim.expires_at);
  const verification: SignupVerification = {
    claimId: claim.id,
    jobId: input.jobId,
    attemptId: input.attemptId,
    expiresAt,
    listeners: new Set(),
    timer: setTimeout(() => dropSignupVerification(verification), Math.max(0, expiresAt - Date.now())),
  };
  verification.timer.unref();
  signupVerifications.set(claim.id, verification);
  return true;
}

export type SignupVerificationReply =
  | { readonly status: 'arrived'; readonly reply: SignInCredential; readonly claim: SignInClaim }
  | { readonly status: 'unavailable' }
  | { readonly status: 'nothing_arrived' }
  | { readonly status: 'not_watched' };

/**
 * The verification email's answer for this job's signup, waiting at most
 * `waitMs` and the claim's life for it. Reading it does not spend it: a step
 * that cannot use it yet leaves it for the next, and `finishSignupVerification`
 * ends the wait once it is used. `not_watched` means no wait exists, or it
 * ended: the account's mail does not reach the assistant's inbox, or the
 * claim expired, was finished or was forgotten by a restart. Nothing later
 * can arrive for it.
 */
export async function takeSignupVerification(
  context: Pick<BrowserExecutionContext, 'job' | 'signal' | 'remaining'>,
  attemptId: string,
  waitMs = context.remaining(),
): Promise<SignupVerificationReply> {
  const verification = [...signupVerifications.values()].find(
    (candidate) => candidate.attemptId === attemptId && candidate.jobId === context.job.id,
  );
  if (!verification) return { status: 'not_watched' };
  if (verification.reply === undefined) {
    const duration = Math.max(0, Math.min(90_000, waitMs, verification.expiresAt - Date.now()));
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', done);
        verification.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, duration);
      context.signal.addEventListener('abort', done, { once: true });
      verification.listeners.add(done);
      if (context.signal.aborted) done();
    });
  }
  const { reply } = verification;
  if (signupVerifications.get(verification.claimId) !== verification) return { status: 'not_watched' };
  if (reply === undefined) return { status: 'nothing_arrived' };
  if (reply.kind === 'unavailable') return { status: 'unavailable' };
  const claim = await getSignInClaim(verification.claimId);
  return claim ? { status: 'arrived', reply, claim } : { status: 'not_watched' };
}

export async function finishSignupVerification(attemptId: string): Promise<void> {
  for (const verification of [...signupVerifications.values()])
    if (verification.attemptId === attemptId) {
      dropSignupVerification(verification);
      await finishSignInClaim(verification.claimId);
    }
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

/** The session selects the claim. Delivery completes the original worker without acquiring its held job lock. */
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
  const wait = claimId ? assistantWaits.get(claimId) : undefined;
  const verification = claimId ? signupVerifications.get(claimId) : undefined;
  const jobId = verification?.jobId ?? wait?.jobId;
  const claim = claimId ? await getSignInClaim(claimId) : undefined;
  const current = await getSession(session.id);
  if (
    !claim ||
    jobId === undefined ||
    claim.state !== 'waiting' ||
    claim.gmail_message_id === null ||
    claim.job_id !== jobId ||
    Date.parse(claim.expires_at) <= Date.now() ||
    current?.status !== 'active' ||
    current.agent_group_id !== session.agent_group_id ||
    current.messaging_group_id !== null ||
    current.thread_id !== session.thread_id
  )
    return { status: 'no_wait' };
  if (verification) {
    // A signup's answer waits for that signup's own verify step; only the first answer is kept.
    if (verification.reply !== undefined || signupVerifications.get(claim.id) !== verification)
      return { status: 'no_wait' };
    verification.reply = reply;
    for (const listener of [...verification.listeners]) listener();
    return { status: 'accepted' };
  }
  if (!wait) return { status: 'no_wait' };
  // A cancelled or timed-out browser request must never accept a late credential; errors carry no credential.
  /* eslint-disable no-catch-all/no-catch-all -- inactive requests discard credentials and return only a constant outcome */
  try {
    await wait.assertActive();
  } catch (_error) {
    wait.complete();
    return { status: 'no_wait' };
  }
  /* eslint-enable no-catch-all/no-catch-all */
  if (assistantWaits.get(claim.id) !== wait) return { status: 'no_wait' };
  wait.complete(reply);
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

/** Bearer navigation has no observation boundary until a fresh root document and empty history exist. */
async function consumeMagicLink(
  context: BrowserExecutionContext,
  binding: BoundBrowserSecretFields,
  claim: SignInClaim,
  link: string,
): Promise<Record<string, unknown>> {
  if (!sameOrigin(binding)) return { status: 'origin_mismatch' };
  return openBearerLink(
    context,
    { page: binding.page, frame: binding.fields[0].target.frame, origin: binding.origin },
    claim,
    link,
    async () => ({ status: 'link_opened' }),
    'The host could not safely consume this sign-in link.',
  );
}

/**
 * Opens a signup's emailed verification link the same way: on its claim's
 * site, from the job's main document there, reading the landing page through
 * `landing` before the bearer document is cleared. An insecure, off-site or
 * account-security link is `refused` before anything opens it; a failure
 * once opening began throws, and the site may have taken the link by then.
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

export async function executeSignInCode(
  context: BrowserExecutionContext,
  content: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = validateSignInCode(content);
  if (!activeInbox()) throw forbidden('The assistant inbox is unavailable.');
  assertBrowserSecretDiagnosticsSafe();
  const page = await context.page();
  return withBrowserJobNavigation(context, page, async () => {
    let refs = new Map<string, PinnedBrowserRef>();
    let discovered: BoundBrowserSecretFields | undefined;
    let claim: SignInClaim | undefined;
    let assistantWait: ReturnType<typeof awaitAssistantReply> | undefined;
    try {
      await context.assertActive();
      refs = await pinBrowserRefs(page, [payload.target, payload.send, ...(payload.submit ? [payload.submit] : [])]);
      const target = refs.get(payload.target.ref)!;
      const send = refs.get(payload.send.ref)!;
      const field = await target.element.evaluate((node) => {
        const input = node as unknown as { tagName: string; getAttribute(name: string): string | null };
        return {
          tag: input.tagName,
          name: input.getAttribute('name') ?? '',
          type: input.getAttribute('type') ?? '',
          autocomplete: input.getAttribute('autocomplete') ?? '',
        };
      });
      const kind = field.tag === 'INPUT' ? authenticationFieldKind(field) : undefined;
      if (kind !== 'username' && kind !== 'otp')
        throw invalidArgs('Choose the email or one-time-code field in a supported sign-in form.');
      // The assistant signs in with its web address, never one it converses from.
      const email = kind === 'username' ? await signInAddress(await target.element.inputValue()) : undefined;
      if (kind === 'username' && email === undefined) return { status: 'alias_unavailable' };
      const binding = await bindBrowserSecretFields(
        page,
        [{ field: kind, target }],
        kind === 'username' ? send : refs.get((payload.submit ?? payload.send).ref)!,
      );
      if (
        !sameOrigin(binding) ||
        httpsOrigin(send.frame.url())?.origin !== binding.origin ||
        send.frame !== target.frame
      )
        return { status: 'origin_mismatch' };
      claim = await createSignInClaim({
        id: `signin-${context.request.id}`,
        jobId: context.job.id,
        origin: binding.origin,
        binding: {
          frame: page.frames().indexOf(target.frame),
          target: payload.target,
          send: payload.send,
          submit: payload.submit ?? payload.send,
        },
      });
      assistantWait = awaitAssistantReply(context, claim);
      await context.assertActive();
      if (kind === 'username' && email !== undefined) {
        if (!activeInbox()) throw forbidden('The assistant inbox is unavailable.');
        const sent = await fillBoundBrowserSecrets(context, binding, async () => [email]);
        if (sent.status === 'origin_mismatch' || sent.status === 'site_busy') return sent;
        if (sent.status !== 'submitted' && sent.status !== 'cleared_after_submit')
          throw forbidden('The host could not safely request this sign-in.');
      } else {
        const sending = await bindBrowserSecretFields(page, [{ field: 'otp', target }], send);
        const guard = await ensureBrowserNavigationGuard(page);
        await guard.duringAction(context.remaining(), () => activateBoundBrowserSignIn(context, sending, ['']));
      }
      await context.assertActive();
      if (!sameOrigin(binding)) return { status: 'origin_mismatch' };
      const secret = await assistantWait.answer;
      await context.assertActive();
      if (!secret) return { status: 'nothing_arrived' };
      if (secret.kind === 'unavailable') return { status: 'ambiguous' };
      if (!sameOrigin(binding)) return { status: 'origin_mismatch' };
      if (secret.kind === 'link') {
        const url = httpsOrigin(secret.value);
        if (
          !url ||
          getDomain(url.hostname, { allowPrivateDomains: true }) !== claim.domain ||
          classifyNavigationUrl(url.href) === 'account_security'
        )
          throw forbidden('The host refused an insecure or off-site sign-in link.');
        return await consumeMagicLink(context, binding, claim, secret.value);
      }
      discovered = await codeBinding(page, binding);
      if (!discovered || !sameOrigin(discovered)) return { status: 'origin_mismatch' };
      const filled = await fillBoundBrowserSecrets(context, discovered, async () => [secret.value]);
      if (filled.status === 'origin_mismatch' || filled.status === 'site_busy') return filled;
      if (filled.status !== 'submitted' && filled.status !== 'cleared_after_submit')
        throw forbidden('The host could not safely complete this sign-in.');
      return { status: 'code_filled' };
    } catch (error) {
      if (error instanceof BrowserOriginMismatchError) return { status: 'origin_mismatch' };
      if (error instanceof BrowserConsentStop)
        return { status: 'stopped', reason: error.reason, consent: consentStopsForAgent(error.stops) };
      if (error instanceof ActionRefusal) throw error;
      throw forbidden('The host could not safely complete this sign-in. Take a fresh observation.');
    } finally {
      assistantWait?.dispose();
      if (claim) await finishSignInClaim(claim.id);
      await disposeBrowserRefs(refs);
      if (discovered && ![...refs.values()].some((ref) => ref.element === discovered!.fields[0].target.element)) {
        await disposeBrowserRefs(
          new Map([
            ['field', discovered.fields[0].target],
            ['submit', discovered.submit],
          ]),
        );
      }
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
  for (const wait of assistantWaits.values()) wait.complete();
  for (const verification of [...signupVerifications.values()]) dropSignupVerification(verification);
  await recoverSignInClaims();
}
export async function cleanupBrowserSignInMail(jobId?: string): Promise<void> {
  if (jobId && (await getDb().hasTable('gws_ea_browser_sign_in_claims'))) {
    await getDb().run('UPDATE gws_ea_browser_sign_in_claims SET state = ? WHERE job_id = ?', 'finished', jobId);
  }
  for (const [id, wait] of assistantWaits) {
    const claim = await getSignInClaim(id);
    if (!claim || claim.state !== 'waiting' || Date.parse(claim.expires_at) <= Date.now() || claim.job_id === jobId)
      wait.complete();
  }
  for (const verification of [...signupVerifications.values()]) {
    const claim = await getSignInClaim(verification.claimId);
    if (!claim || claim.state !== 'waiting' || verification.expiresAt <= Date.now() || verification.jobId === jobId)
      dropSignupVerification(verification);
  }
  await cleanupSignInClaims();
}

export const signInCodeAction: BrowserQueuedAction = { validate: validateSignInCode, execute: executeSignInCode };
