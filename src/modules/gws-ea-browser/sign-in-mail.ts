import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { getDomain } from 'tldts';
import {
  ANSWER_LATER,
  ActionRefusal,
  answeredGuard,
  answeringAction,
  forbidden,
  invalidArgs,
  writeActionResponse,
} from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { isRecord } from '../../gws-ea/validation.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { getSession } from '../../db/sessions.js';
import { registerDeliveryAction } from '../../delivery.js';
import { clearOutbox, withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import {
  claimSignInMail,
  cleanupSignInClaims,
  createSignInClaim,
  finishSignInClaim,
  getSignInClaim,
  recoverSignInClaims,
  waitingSignInClaim,
  type SignInClaim,
} from '../gws-ea-inbox/claims.js';
import { htmlToText, parseGmailMessage, type ParsedMail } from '../gws-ea-inbox/mime.js';
import { activeInbox, assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { authenticationFieldKind } from './authentication-signatures.js';
import { browserDelegateGuard } from './cancel.js';
import type { BrowserJob, BrowserRequest } from './db.js';
import {
  activateControl,
  classifyNavigationUrl,
  ensureBrowserNavigationGuard,
  withBrowserJobNavigation,
} from './commit-classifier.js';
import {
  assertBrowserSecretDiagnosticsSafe,
  bindBrowserSecretField,
  discoverAuthenticationCodeField,
  fillBoundBrowserSecret,
  type BoundBrowserSecretField,
} from './fill.js';
import { BrowserVaultError, httpsOrigin } from './onepassword.js';
import {
  bindPageSecretDocuments,
  disposeBrowserRefs,
  pinBrowserRefs,
  readBrowserRef,
  registerPageSecret,
  releasePageSecret,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import { registerBrowserQueuedAction, type BrowserExecutionContext, type BrowserQueue } from './queue.js';

interface SignInPayload extends Record<string, unknown> {
  from: 'assistant' | 'principal';
  target: BrowserRef;
  send: BrowserRef;
  submit?: BrowserRef;
}
function browserRef(raw: unknown): BrowserRef {
  return readBrowserRef(raw, 'Choose a field and send control from a fresh observation.');
}
export function validateSignInCode(content: Record<string, unknown>): SignInPayload {
  if (
    Object.keys(content).some(
      (key) => !['action', 'requestId', 'budget_ms', 'from', 'target', 'send', 'submit'].includes(key),
    ) ||
    (content.from !== undefined && content.from !== 'assistant' && content.from !== 'principal')
  )
    throw invalidArgs('Choose assistant or principal sign-in and current field/control references.');
  return {
    from: content.from === 'principal' ? 'principal' : 'assistant',
    target: browserRef(content.target),
    send: browserRef(content.send),
    ...(content.submit === undefined ? {} : { submit: browserRef(content.submit) }),
  };
}

interface LiveClaim {
  readonly binding: BoundBrowserSecretField;
  readonly refs: Map<string, PinnedBrowserRef>;
}
const bindings = new Map<string, LiveClaim>();

function sameOrigin(binding: BoundBrowserSecretField): boolean {
  return httpsOrigin(binding.target.frame.url())?.origin === binding.origin;
}
async function releaseBinding(id: string): Promise<void> {
  const live = bindings.get(id);
  bindings.delete(id);
  if (live) await disposeBrowserRefs(live.refs);
}
async function codeBinding(page: Page, binding: BoundBrowserSecretField): Promise<BoundBrowserSecretField | undefined> {
  if (!sameOrigin(binding)) return undefined;
  return binding.field === 'otp' ? binding : discoverAuthenticationCodeField(page, binding);
}

type MailSecret =
  | { kind: 'code'; value: string }
  | { kind: 'link'; value: string }
  | { kind: 'ambiguous' }
  | { kind: 'link_refused' };

function labelledMailCodes(text: string): Set<string> {
  const codes = new Set<string>();
  const add = (value: string): void => {
    if (/^[A-Z\d]{4,12}$/iu.test(value) && (/\d/u.test(value) || /^[A-Z]+$/u.test(value))) codes.add(value);
  };
  for (const match of text.matchAll(
    /\b(?:codes?|otp|passcode)\s*(?:(?:(?:is|are)\s+)?(?:shown\s+)?below(?:\s+to\s+(?:sign|log)\s+in)?\s*[:=.]?\s*|(?:is|are)\s*[:=]?\s*|[:=]\s*|to\s+(?:sign|log)\s+in\s*:?\s*)?([A-Z\d]{4,12})\b((?:\s*(?:,|and|or)\s+[A-Z\d]{4,12}\b)*)/giu,
  )) {
    if (/\b(?:zip|postal|area|country|promo|discount)\s+$/iu.test(text.slice(0, match.index))) continue;
    add(match[1]);
    for (const alternative of match[2].matchAll(/(?:,|and|or)\s+([A-Z\d]{4,12})\b/giu)) add(alternative[1]);
    // Adjacent standalone codes under one label are alternatives, not footer numbers.
    for (const line of text.slice(match.index + match[0].length).split('\n')) {
      if (line.trim() === '') continue;
      if (!/^[A-Z\d]{4,12}$/u.test(line.trim())) break;
      add(line.trim());
    }
  }
  for (const match of text.matchAll(
    /\b([A-Z\d]{4,12})[ \t]+is[ \t]+(?:your[ \t]+)?((?:[\p{L}][\p{L}\d'’.-]{0,39}[ \t]+){0,4})(?:code|otp|passcode)\b((?:\s*(?:,|and|or)\s+[A-Z\d]{4,12}\b)*)/giu,
  )) {
    if (/\b(?:zip|postal|area|country|promo|discount)\b/iu.test(match[2])) continue;
    add(match[1]);
    for (const alternative of match[3].matchAll(/(?:,|and|or)\s+([A-Z\d]{4,12})\b/giu)) add(alternative[1]);
  }
  return codes;
}

const SIGN_IN_LINK_LABEL =
  /\b(?:sign[\s-]?in|log[\s-]?in|authenticate|verify\s+(?:your\s+)?(?:email|account)|magic[\s-]?link)\b/iu;

function authenticationMailLink(raw: string, label: string): boolean {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (
    /\b(?:didn['’]t|did\s+not|wasn['’]t|was\s+not|not\s+you|secure|lock|report|suspicious|reset|revoke)\b/iu.test(label)
  )
    return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (
    /(?:^|[/_.-])(?:privacy|unsubscribe|preferences|terms|assets?|images?|security|secure|lock|report|reset|revoke)(?:[/_.-]|$)/iu.test(
      pathname,
    ) ||
    /\.(?:png|jpe?g|gif|svg|webp|ico|css|js)$/iu.test(pathname)
  )
    return false;
  return (
    SIGN_IN_LINK_LABEL.test(label) ||
    /(?:^|[/_.-])(?:sign[-_]?in|log[-_]?in|login|auth(?:enticate|entication)?|verify|verification|magic[-_]?link)(?:$|[/_.-])/iu.test(
      pathname,
    )
  );
}

function messageSecret(mail: ParsedMail, domain: string): MailSecret {
  const urls = new Set<string>();
  for (const match of mail.text.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const raw = match[0].replace(/[),.;]+$/u, '');
    const prefix = (mail.text.slice(0, match.index).trimEnd().split('\n').at(-1) ?? '').replace(
      /https?:\/\/[^\s<>"']+/giu,
      '',
    );
    if (authenticationMailLink(raw, prefix)) urls.add(raw);
  }
  for (const match of (mail.html ?? '').matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a\s*>/giu)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/iu.exec(match[1]);
    if (!href) continue;
    const raw = htmlToText(href[1]);
    if (authenticationMailLink(raw, htmlToText(match[2]))) urls.add(raw);
  }
  const text = `${mail.subject}\n${mail.text}`.replace(/https?:\/\/[^\s<>"']+/giu, '');
  const codes = labelledMailCodes(text);
  if (codes.size > 1) return { kind: 'ambiguous' };
  if (codes.size === 1) return { kind: 'code', value: [...codes][0] };
  if (urls.size !== 1) return { kind: 'ambiguous' };
  const url = httpsOrigin([...urls][0]);
  return url && getDomain(url.hostname, { allowPrivateDomains: true }) === domain
    ? { kind: 'link', value: url.href }
    : { kind: 'link_refused' };
}

/** The poll and reader reserve through one DB decision; mail contents never leave this host function. */
async function readClaimedMail(context: BrowserExecutionContext, claim: SignInClaim): Promise<ParsedMail | undefined> {
  const inbox = activeInbox();
  if (!inbox) throw forbidden('The assistant inbox is unavailable.');
  const waitUntil = Date.now() + Math.max(0, Math.min(90_000, context.remaining() - 1_000));
  do {
    await context.assertActive();
    const current = await getSignInClaim(claim.id);
    if (!current || current.state !== 'waiting' || Date.now() >= Date.parse(current.expires_at)) return undefined;
    const references = current.gmail_message_id
      ? [{ id: current.gmail_message_id }]
      : await inbox.gmail.listMessages({
          q: `in:anywhere after:${Math.floor(Date.parse(claim.since_at) / 1_000)}`,
          includeSpamTrash: true,
          maxResults: 500,
        });
    await context.assertActive();
    const messages: ParsedMail[] = [];
    for (const reference of references) {
      const raw = await inbox.gmail.getMessage(reference.id);
      await context.assertActive();
      if (raw) messages.push(parseGmailMessage(raw));
    }
    messages.sort(
      (left, right) =>
        (left.receivedAt?.getTime() ?? 0) - (right.receivedAt?.getTime() ?? 0) || left.id.localeCompare(right.id),
    );
    for (const mail of messages) {
      if (await claimSignInMail(mail, new Date(), claim.id)) return mail;
    }
    if (Date.now() >= waitUntil) return undefined;
    await pause(Math.min(1_000, waitUntil - Date.now()), undefined, { signal: context.signal });
  } while (Date.now() <= waitUntil);
  return undefined;
}

/** Bearer navigation has no observation boundary until a fresh root document and empty history exist. */
async function consumeMagicLink(
  context: BrowserExecutionContext,
  binding: BoundBrowserSecretField,
  claim: SignInClaim,
  link: string,
): Promise<Record<string, unknown>> {
  const { page } = binding;
  if (!sameOrigin(binding) || binding.target.frame !== page.mainFrame()) return { status: 'origin_mismatch' };
  assertBrowserSecretDiagnosticsSafe();
  const secrets = new Set<string>();
  const taint = async (raw: string): Promise<void> => {
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
        await bindPageSecretDocuments(page, value);
      }
  };
  let sanitized = false;
  let sanitizing = false;
  const documents = new Set<Promise<void>>();
  const navigation = (): void => {
    if (sanitizing) return;
    const work = bindPageSecretDocuments(page, link);
    documents.add(work);
    void work.catch(() => undefined);
  };
  page.on('framenavigated', navigation);
  try {
    const guard = await ensureBrowserNavigationGuard(page);
    guard.clearReason();
    await taint(link);
    await guard.runWithPolicy(
      {
        stripReferrer: true,
        classify(url) {
          if (!httpsOrigin(url.href) || getDomain(url.hostname, { allowPrivateDomains: true }) !== claim.domain)
            return 'blocked_address';
          const classification = classifyNavigationUrl(url.href);
          return classification === 'unsupported_merchant' ? 'ordinary' : classification;
        },
        async beforeNavigate(url) {
          await context.assertActive();
          if (!sanitizing) await taint(url.href);
          return 'ordinary';
        },
      },
      async () => {
        await context.assertActive();
        assertBrowserSecretDiagnosticsSafe();
        await page.goto(link, { waitUntil: 'domcontentloaded', referer: '' });
        await Promise.all(documents);
        await bindPageSecretDocuments(page, link);
        if (guard.reason()) throw forbidden('The sign-in link left its permitted site.');
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
      },
    );
    return { status: 'link_opened' };
  } catch (_error) {
    await context.runtime.closeJob(context.job.id).catch(() => undefined);
    throw forbidden('The host could not safely consume this sign-in link.');
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
  assertBrowserSecretDiagnosticsSafe();
  const page = await context.page();
  return withBrowserJobNavigation(context, page, async () => {
    let refs = new Map<string, PinnedBrowserRef>();
    let discovered: BoundBrowserSecretField | undefined;
    let claim: SignInClaim | undefined;
    let retained = false;
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
      if (payload.from === 'principal' && kind !== 'otp')
        throw invalidArgs('Choose the principal code field after requesting their code.');
      const binding = await bindBrowserSecretField(
        page,
        target,
        kind === 'username' ? send : refs.get((payload.submit ?? payload.send).ref)!,
        kind,
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
        source: payload.from,
        origin: binding.origin,
        binding: {
          frame: page.frames().indexOf(target.frame),
          target: payload.target,
          send: payload.send,
          submit: payload.submit ?? payload.send,
        },
      });
      await context.assertActive();
      if (kind === 'username') {
        const inbox = activeInbox();
        if (!inbox) throw forbidden('The assistant inbox is unavailable.');
        await inbox.gmailAddress();
        await context.assertActive();
        const addresses = await assistantAddresses();
        const current = (await target.element.inputValue()).trim().toLowerCase();
        const email = addresses.has(current) ? current : [...addresses][0];
        if (!email) throw forbidden('The assistant inbox address is unavailable.');
        const sent = await fillBoundBrowserSecret(context, binding, async () => email);
        if (sent.status === 'origin_mismatch') return sent;
        if (sent.status !== 'submitted' && sent.status !== 'cleared_after_submit')
          throw forbidden('The host could not safely request this sign-in.');
      } else {
        await activateControl(
          page,
          send.element,
          async () => {
            throw forbidden('This sign-in flow requires native submission.');
          },
          undefined,
          { kind: 'submit', assertActive: context.assertActive },
        );
      }
      await context.assertActive();
      if (!sameOrigin(binding)) return { status: 'origin_mismatch' };
      if (payload.from === 'principal') {
        bindings.set(claim.id, { binding, refs });
        retained = true;
        return { status: 'awaiting_code', site: claim.domain, origin: claim.origin };
      }
      const mail = await readClaimedMail(context, claim);
      if (!mail) return { status: 'nothing_arrived' };
      const secret = messageSecret(mail, claim.domain);
      if (secret.kind === 'ambiguous') return { status: secret.kind };
      if (secret.kind === 'link_refused') throw forbidden('The host refused an insecure or off-site sign-in link.');
      if (!sameOrigin(binding)) return { status: 'origin_mismatch' };
      if (secret.kind === 'link') return await consumeMagicLink(context, binding, claim, secret.value);
      discovered = await codeBinding(page, binding);
      if (!discovered || !sameOrigin(discovered)) return { status: 'origin_mismatch' };
      const filled = await fillBoundBrowserSecret(context, discovered, async () => secret.value);
      if (filled.status === 'origin_mismatch') return filled;
      if (filled.status !== 'submitted' && filled.status !== 'cleared_after_submit')
        throw forbidden('The host could not safely complete this sign-in.');
      return { status: 'code_filled' };
    } catch (error) {
      if (error instanceof BrowserVaultError && error.reason === 'origin_mismatch') return { status: error.reason };
      if (error instanceof ActionRefusal) throw error;
      throw forbidden('The host could not safely complete this sign-in. Take a fresh observation.');
    } finally {
      if (claim && !retained) await finishSignInClaim(claim.id);
      if (!retained) await disposeBrowserRefs(refs);
      if (discovered && ![...refs.values()].some((ref) => ref.element === discovered!.target.element)) {
        await disposeBrowserRefs(
          new Map([
            ['field', discovered.target],
            ['submit', discovered.submit],
          ]),
        );
      }
    }
  });
}

interface RelayPayload extends Record<string, unknown> {
  source_session_id: string;
  source_request_id: string;
  claim_id: string;
}
function validateRelayPayload(content: Record<string, unknown>): RelayPayload {
  if (
    Object.keys(content).some((key) => !['source_session_id', 'source_request_id', 'claim_id'].includes(key)) ||
    typeof content.source_session_id !== 'string' ||
    typeof content.source_request_id !== 'string' ||
    typeof content.claim_id !== 'string'
  )
    throw invalidArgs('The principal relay reference is invalid.');
  return {
    source_session_id: content.source_session_id,
    source_request_id: content.source_request_id,
    claim_id: content.claim_id,
  };
}
function relayCode(content: Record<string, unknown>): { thread: string; code: string } {
  if (
    Object.keys(content).some((key) => !['action', 'requestId', 'thread', 'code'].includes(key)) ||
    typeof content.thread !== 'string' ||
    !content.thread ||
    typeof content.code !== 'string' ||
    !/^[A-Za-z\d][A-Za-z\d -]{2,63}$/u.test(content.code)
  )
    throw invalidArgs('Choose the waiting browser thread and the principal’s code.');
  return { thread: content.thread, code: content.code };
}

export async function answerRelayCode(
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
  queue: BrowserQueue,
): Promise<Record<string, unknown> | typeof ANSWER_LATER> {
  if (session.agent_group_id !== (await getMainAgentGroupId()))
    throw forbidden('Only main may relay the principal’s code.');
  const payload = relayCode(content);
  const claim = await waitingSignInClaim(payload.thread, 'principal');
  if (!claim || !bindings.has(claim.id)) return { status: 'no_wait' };
  const id = createHash('sha256').update(`${session.id}\0${requestId}`).digest('hex');
  await queue.enqueueInternal(
    claim.job_id,
    'browser_relay_sign_in',
    { source_session_id: session.id, source_request_id: requestId, claim_id: claim.id },
    `relay-${id}`,
  );
  return ANSWER_LATER;
}
async function executeRelayCode(
  context: BrowserExecutionContext,
  content: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = validateRelayPayload(content);
  let result: Record<string, unknown> = { status: 'no_wait' };
  const source = await getSession(payload.source_session_id);
  if (!source || source.agent_group_id !== (await getMainAgentGroupId())) return result;
  const claim = await getSignInClaim(payload.claim_id);
  const live = bindings.get(payload.claim_id);
  try {
    await context.assertActive();
    if (
      !claim ||
      claim.source !== 'principal' ||
      claim.state !== 'waiting' ||
      claim.job_id !== context.job.id ||
      Date.parse(claim.expires_at) <= Date.now() ||
      !live
    )
      return result;
    result = { status: 'origin_mismatch' };
    if (!sameOrigin(live.binding)) return result;
    const message = await withExistingMailboxSession(source.agent_group_id, source.id, (mailbox) =>
      mailbox.getOutboundMessage(payload.source_request_id),
    );
    let original: unknown;
    try {
      original = message?.kind === 'system' ? (JSON.parse(message.content) as unknown) : undefined;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      original = undefined;
    }
    if (!isRecord(original)) return result;
    const request = original;
    const relayed = relayCode(request);
    if (
      request.action !== 'relay_code' ||
      request.requestId !== payload.source_request_id ||
      relayed.thread !== claim.job_id
    )
      return result;
    result = await withBrowserJobNavigation(context, live.binding.page, async () => {
      const filled = await fillBoundBrowserSecret(context, live.binding, async () => relayed.code);
      return {
        status:
          filled.status === 'submitted' || filled.status === 'cleared_after_submit' ? 'code_filled' : 'origin_mismatch',
      };
    });
    return result;
    // eslint-disable-next-line no-catch-all/no-catch-all -- main's code and any native exception stay host-only; the fixed result is answered to both callers
  } catch (_error) {
    return result;
  } finally {
    await finishSignInClaim(payload.claim_id);
    await releaseBinding(payload.claim_id);
  }
}

/** Every main delivery only accepts durable references; the queue reads the original code under the job lock. */
export function registerSignInMailDelivery(queue: () => BrowserQueue): void {
  registerDeliveryAction(
    'relay_code',
    answeringAction('relay_code', (content, session, requestId) =>
      answerRelayCode(content, session, requestId, queue()),
    ),
    answeredGuard(browserDelegateGuard),
  );
}

/** Main can name the host-recorded site without ever reading the waiting field or a credential. */
export async function readPendingSignInSite(
  jobId: string,
): Promise<{ site: string; origin: string; expires_at: string } | undefined> {
  if (!(await getDb().hasTable('gws_ea_browser_sign_in_claims'))) return undefined;
  const claim = await waitingSignInClaim(jobId, 'principal');
  return claim ? { site: claim.domain, origin: claim.origin, expires_at: claim.expires_at } : undefined;
}

/** Native queue delivery owns this side answer for success, pre-start expiry, interruption and restart alike. */
async function deliverRelayAnswer(request: BrowserRequest, frame: ResponseFrame): Promise<void> {
  const payload = validateRelayPayload(JSON.parse(request.payload_json) as Record<string, unknown>);
  const source = await getSession(payload.source_session_id);
  const job = await getDb().get<BrowserJob>('SELECT * FROM gws_ea_browser_jobs WHERE id = ?', request.job_id);
  const main = await getMainAgentGroupId();
  if (
    !source ||
    !job ||
    source.agent_group_id !== main ||
    job.source_agent_group_id !== main ||
    job.browser_session_id !== request.session_id
  )
    throw forbidden('The principal relay is no longer attached to its main-owned job.');
  const claim = await getSignInClaim(payload.claim_id);
  if (claim && claim.job_id !== job.id) throw forbidden('The principal relay belongs to another browser job.');
  const data = frame.ok && isRecord(frame.data) ? frame.data : undefined;
  const status = data && (data.status === 'code_filled' || data.status === 'no_wait') ? data.status : 'origin_mismatch';
  await writeActionResponse(source, payload.source_request_id, {
    id: payload.source_request_id,
    ok: true,
    data: { status },
  });
  clearOutbox(source.agent_group_id, source.id, payload.source_request_id);
}
export async function recoverBrowserSignInMail(): Promise<void> {
  for (const id of bindings.keys()) await releaseBinding(id);
  await recoverSignInClaims();
}
export async function cleanupBrowserSignInMail(jobId?: string): Promise<void> {
  if (jobId && (await getDb().hasTable('gws_ea_browser_sign_in_claims'))) {
    await getDb().run('UPDATE gws_ea_browser_sign_in_claims SET state = ? WHERE job_id = ?', 'finished', jobId);
  }
  for (const [id] of bindings) {
    const claim = await getSignInClaim(id);
    const job = claim
      ? await getDb().get<{ cancelled: number }>('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', claim.job_id)
      : undefined;
    if (
      !claim ||
      claim.state !== 'waiting' ||
      Date.parse(claim.expires_at) <= Date.now() ||
      job?.cancelled ||
      claim.job_id === jobId
    ) {
      await releaseBinding(id);
      if (claim) await finishSignInClaim(id);
    }
  }
  await cleanupSignInClaims();
}

registerBrowserQueuedAction('sign_in_code', { validate: validateSignInCode, execute: executeSignInCode });
registerBrowserQueuedAction('browser_relay_sign_in', {
  validate: validateRelayPayload,
  execute: executeRelayCode,
  deliverAnswer: deliverRelayAnswer,
});
