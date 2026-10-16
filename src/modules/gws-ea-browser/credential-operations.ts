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
 * filled again, so a retry or restart cannot submit a second time. Recovery
 * of `exposed`, `awaiting_verification` and `unknown` attempts after a crash,
 * cancellation or timeout belongs to the queue's startup and cancellation
 * paths; this module only leaves them durable.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { Frame, Page } from 'playwright-core';

import { ActionRefusal, answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { registerDeliveryAction } from '../../delivery.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import type { Session } from '../../types.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import {
  credentialFieldFits,
  httpsOrigin,
  type CredentialFormField,
  type CredentialKind,
} from './authentication-signatures.js';
import {
  activateNativeCredentialControl,
  fillNativeCredentialGroup,
  inspectNativeCredentialControl,
  type CredentialActivationResult,
  type NativeCredentialBinding,
  type NativeCredentialFacts,
  type NativeCredentialGroup,
  type NativeFieldFacts,
} from './authentication-submit.js';
import { browserDelegateGuard, resolveBrowserJob } from './cancel.js';
import {
  BrowserSiteBusyError,
  classifyCredentialActivation,
  classifyCredentialNavigation,
  ensureBrowserNavigationGuard,
  withBrowserJobNavigation,
  type ActivationClass,
} from './commit-classifier.js';
import {
  CredentialAttemptError,
  credentialAttempts,
  type CandidateCredential,
  type CredentialAttempt,
  type CredentialAttempts,
  type CredentialEvidence,
  type CredentialFinalizeResult,
} from './credential-attempts.js';
import { assertBrowserSecretDiagnosticsSafe, settleFilledSecrets } from './fill.js';
import { SiteLeaseStore } from './leases.js';
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
import { registerBrowserQueuedAction, type BrowserExecutionContext } from './queue.js';

export interface CredentialOperationDependencies {
  readonly attempts: CredentialAttempts;
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
]);
const MAX_USERNAME = 256;

const isAccount = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_USERNAME &&
  value.trim() === value &&
  !hasControlCharacters(value);

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
 * Canonical main records the principal's delegation of one signup or one
 * password change for an exact job, site and account. A change binds the
 * Login this host saved for that site and username, checked fresh against
 * its ownership record (R18); any other Login, an edited one, or an account
 * with no saved Login is refused here, before the browser can act. Sign-in
 * email, phone, two-factor and payment-method changes have no operation.
 */
export async function credentialAuthorityRequest(
  content: Record<string, unknown>,
  session: Session,
  dependencies: CredentialOperationDependencies = DEFAULT_DEPENDENCIES,
): Promise<Outcome> {
  if (session.agent_group_id !== (await getMainAgentGroupId()))
    throw forbidden('Only main may delegate an account signup or password change.');
  if (Object.keys(content).some((key) => !AUTHORITY_FIELDS.has(key)))
    throw invalidArgs('Unknown credential_authority field.');
  const { thread, operation, site, username } = content;
  if (
    typeof thread !== 'string' ||
    (operation !== 'signup' && operation !== 'change_password') ||
    typeof site !== 'string' ||
    !isAccount(username)
  )
    throw invalidArgs(
      'credential_authority needs the job thread, signup or change_password, the HTTPS site and the exact account username.',
    );
  const origin = httpsOrigin(site)?.origin;
  const domain = origin && registrableDomain(origin);
  if (!origin || !domain) throw invalidArgs('The site must be a public HTTPS address.');
  const job = await resolveBrowserJob(thread);
  if (!job || job.cancelled) throw forbidden('No live main-owned browser job exists for that thread.');
  const kind: CredentialKind = operation === 'signup' ? 'signup' : 'rotation';
  const { attempts } = dependencies;
  const open = (await attempts.unresolved()).find(
    (attempt) =>
      attempt.job_id === job.id &&
      attempt.kind === kind &&
      attempt.site === domain &&
      attempt.username === username &&
      (attempt.phase === 'preparing' || attempt.phase === 'saved'),
  );
  if (open) return recorded(open, job.thread_id);
  if (kind === 'signup') {
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

export function registerCredentialAuthorityDelivery(): void {
  registerDeliveryAction(
    'credential_authority',
    answeringAction('credential_authority', (content, session) => credentialAuthorityRequest(content, session)),
    answeredGuard(browserDelegateGuard),
  );
}

// ---------------------------------------------------------------- the browser's request

const ROLES: readonly CredentialFormField[] = ['username', 'current_password', 'new_password', 'confirmation'];
const FORM_FIELDS: ReadonlySet<string> = new Set([
  'action',
  'requestId',
  'budget_ms',
  'authority',
  'activate',
  ...ROLES,
]);
const AUTHORITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface CredentialFormPayload extends Record<string, unknown> {
  authority: string;
  username?: BrowserRef;
  current_password?: BrowserRef;
  new_password?: BrowserRef;
  confirmation?: BrowserRef;
  activate: BrowserRef;
}

/** Only an authority and fresh refs: no value, selector or verdict is accepted. */
export function validateCredentialForm(content: Record<string, unknown>): CredentialFormPayload {
  const { authority } = content;
  if (
    Object.keys(content).some((key) => !FORM_FIELDS.has(key)) ||
    typeof authority !== 'string' ||
    !AUTHORITY_ID.test(authority)
  )
    throw invalidArgs('Choose the credential authority main recorded and fields from a fresh observation.');
  const message = 'Choose credential fields and the activation control from a fresh observation.';
  const payload: CredentialFormPayload = { authority, activate: readBrowserRef(content.activate, message) };
  for (const role of ROLES) if (content[role] !== undefined) payload[role] = readBrowserRef(content[role], message);
  const refs = [...ROLES.flatMap((role) => payload[role]?.ref ?? []), payload.activate.ref];
  if (
    refs.length < 2 ||
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

/**
 * A confirmed website change: a change the vault could not take over keeps
 * both credentials, the original Login and the saved candidate; anything not
 * yet finalized is pending.
 */
function websiteOutcome(kind: CredentialKind, vault: VaultState): Outcome {
  const status = kind === 'signup' ? 'account_created' : 'password_changed';
  if (vault === 'finalized') return { status, vault: kind === 'signup' ? 'saved' : 'updated' };
  return { status, vault: vault === 'conflict' && kind === 'rotation' ? 'both_kept' : 'pending' };
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
      return websiteOutcome(attempt.kind, vaultState((await attempts.finalize(attempt.id, assertActive)).status));
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
  if (attempt.kind === 'signup' && payload.current_password)
    throw invalidArgs('A signup has no current password to fill.');
  if (attempt.kind === 'rotation' && (!payload.new_password || payload.username))
    throw invalidArgs('A password change fills the current and new password fields, never a username.');
  const settled = await settledOutcome(attempt, attempts, context.assertActive);
  if (settled) return settled;
  const page = await context.page();
  try {
    return await withBrowserJobNavigation(context, page, () => runStep(context, page, attempt, payload, attempts));
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
  | 'form_changed'
  | 'unsupported_control'
  | Exclude<ActivationClass, 'ordinary' | 'unsupported_merchant'>;
class StepStop extends Error {
  constructor(readonly reason: StepRefusal) {
    super(reason);
  }
}
const stopFor = (classification: Exclude<ActivationClass, 'ordinary'>): StepStop =>
  new StepStop(classification === 'unsupported_merchant' ? 'unsupported_control' : classification);

interface BoundField {
  readonly role: CredentialFormField;
  readonly pinned: PinnedBrowserRef;
  readonly binding: NativeCredentialBinding;
}
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
 * The form the group submits: same-window, on its site, with no payment
 * field. A change form may hold no editable sign-in field at all: an email,
 * phone or code field there would change the account's security.
 */
function checkForm(facts: NativeCredentialFacts, group: Pick<CredentialGroup, 'kind' | 'site'>): void {
  const { form, override } = facts;
  for (const submission of [form, override])
    if (submission) {
      if (submission.target && submission.target !== '_self') throw new StepStop('unsupported_form');
      destination(submission.action, group.kind, group.site);
    }
  if (!form) return;
  if (form.fields.some((field) => FINANCIAL_FIELD.test(`${field.name} ${field.autocomplete}`)))
    throw new StepStop('purchase_control');
  if (form.fields.some((field) => field.type === 'file')) throw new StepStop('unsupported_form');
  if (
    group.kind === 'rotation' &&
    form.fields.some(
      (field) =>
        editable(field) &&
        (['email', 'tel'].includes(field.type) || SECURITY_FIELD.test(`${field.name} ${field.autocomplete}`)),
    )
  )
    throw new StepStop('account_security');
}

async function bindGroup(
  page: Page,
  attempt: CredentialAttempt,
  payload: CredentialFormPayload,
  refs: ReadonlyMap<string, PinnedBrowserRef>,
): Promise<CredentialGroup> {
  const pinned = (ref: BrowserRef): PinnedBrowserRef => {
    const found = refs.get(ref.ref);
    if (!found) throw new StepStop('stale_ref');
    return found;
  };
  const control = pinned(payload.activate);
  const chosen = ROLES.flatMap((role) => {
    const ref = payload[role];
    return ref ? [{ role, pinned: pinned(ref) }] : [];
  });
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
      !credentialFieldFits(role, binding.facts, attempt.kind, currentBound)
    )
      throw new StepStop('unsupported_form');
  if (controlBinding.formBackendNodeId !== null && controlBinding.formBackendNodeId !== form)
    throw new StepStop('unsupported_form');
  const group = { kind: attempt.kind, site: attempt.site, frame, fields };
  checkForm(fields[0].binding.facts, group);
  checkForm(controlBinding.facts, group);
  // The Login is saved under the authority's username: a form that names the account must receive exactly that.
  if (
    !payload.username &&
    fields[0].binding.facts.form?.fields.some(
      (field) => editable(field) && credentialFieldFits('username', { ...field, id: '' }, attempt.kind, currentBound),
    )
  )
    throw new StepStop('unsupported_form');
  const activation = await classifyCredentialActivation(page, control.element, attempt.kind, attempt.site);
  if (activation !== 'ordinary') throw stopFor(activation);
  return { ...group, native: { fields: fields.map((field) => field.binding), control: controlBinding } };
}

/** Nothing the browser chose may move between the binding and the disclosure; enabling a control is not a move. */
const sameBinding = (left: CredentialGroup, right: CredentialGroup): boolean => {
  const shape = (group: CredentialGroup): string =>
    JSON.stringify(group.native, (key: string, value: unknown) =>
      key === 'readonly' || key === 'disabled' ? undefined : value,
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

async function readSite(page: Page, group: CredentialGroup): Promise<SiteState> {
  const lines = new Set<string>();
  let passwordForm = false;
  for (const frame of new Set([group.frame, page.mainFrame()])) {
    if (frame.isDetached() || registrableDomain(frame.url()) !== group.site) continue;
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

/** Only a response that appeared after this step counts; a signal already on the page proves nothing. */
async function awaitWebsite(
  context: BrowserExecutionContext,
  page: Page,
  group: CredentialGroup,
  before: SiteState,
  waitMs: number,
): Promise<WebsiteResult> {
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, context.remaining() - 1_500));
  for (;;) {
    const now = await readSite(page, group);
    const fresh = (signal: Signal): boolean =>
      [...now.lines].some((line) => !before.lines.has(line) && SIGNALS[signal].test(line));
    if (group.kind === 'signup' && fresh('exists')) return 'account_exists';
    if (group.kind === 'rotation' && fresh('rejectedCurrent')) return 'current_password_rejected';
    if (fresh('rejectedPassword') && now.passwordForm) return 'password_rejected';
    if (fresh('verification')) return 'verification_requested';
    if (
      group.kind === 'signup'
        ? fresh('signupSuccess') || (fresh('signedIn') && !now.passwordForm)
        : fresh('changeSuccess')
    )
      return 'confirmed';
    if (Date.now() >= deadline) return 'none';
    await sleep(250);
    await context.assertActive();
  }
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

async function runStep(
  context: BrowserExecutionContext,
  page: Page,
  attempt: CredentialAttempt,
  payload: CredentialFormPayload,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  let refs = new Map<string, PinnedBrowserRef>();
  try {
    await context.assertActive();
    refs = await pinBrowserRefs(page, [
      ...ROLES.flatMap((role) => {
        const ref = payload[role];
        return ref ? [ref] : [];
      }),
      payload.activate,
    ]);
    const group = await bindGroup(page, attempt, payload, refs);
    const lease = await new SiteLeaseStore(context.store.db).acquire(context.job.id, group.frame.url());
    await context.wakeWaiters(lease.waitingJobs, `${context.request.id}:credential-lease`);
    if (!lease.acquired) throw new BrowserSiteBusyError();
    // Only a new password is a disclosure; a username-only step of a multi-step signup reveals nothing.
    return payload.new_password
      ? await disclosingStep(context, page, attempt, payload, refs, group, attempts)
      : await usernameStep(context, page, attempt, group, attempts);
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

async function disclosingStep(
  context: BrowserExecutionContext,
  page: Page,
  prepared: CredentialAttempt,
  payload: CredentialFormPayload,
  refs: ReadonlyMap<string, PinnedBrowserRef>,
  bound: CredentialGroup,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  const ready = await ensureSaved(prepared, attempts, context.assertActive);
  if ('outcome' in ready) return ready.outcome;
  const { saved } = ready;
  // Saving waited on 1Password: anything that moved since the first binding refuses before disclosure.
  const group = await bindGroup(page, saved, payload, refs).catch((error: unknown) => {
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
  await context.assertActive();
  assertBrowserSecretDiagnosticsSafe();
  const disclosed = await disclose(context, saved, origin, attempts);
  if ('outcome' in disclosed) return disclosed.outcome;
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
  page.on('framenavigated', navigation);
  try {
    for (const secret of secrets) {
      registerPageSecret(page, secret);
      await bindPageSecretDocuments(page, secret);
    }
    assertBrowserSecretDiagnosticsSafe();
    const values = valuesFor(group, credential);
    const filled = await fillNativeCredentialGroup(group.frame, group.native, values, context.assertActive);
    if (filled === 'not_inserted') {
      // Proven: nothing reached the page, so no website could have acted on it.
      await settle(() => attempts.markUnknown(saved.id, evidence('none', filled, 'none')));
      await settle(() => attempts.markRejected(saved.id, evidence('none', filled, 'none')));
      return refused('form_changed');
    }
    return await activateWithin(context, page, group, values, secrets, async (activation) => {
      if (activation === 'activated') await attempts.markAwaitingVerification(saved.id);
      const result = await awaitWebsite(context, page, group, before, activation === 'activated' ? 15_000 : 2_000);
      const proof = evidence(result, filled, activation);
      if (activation !== 'activated') {
        await settle(() => attempts.markUnknown(saved.id, proof));
        // The site refused the value itself, before any submission this host made.
        if (result === 'password_rejected') {
          await settle(() => attempts.markRejected(saved.id, proof));
          return { status: 'password_rejected' };
        }
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
          return websiteOutcome(
            saved.kind,
            vaultState((await attempts.finalize(saved.id, context.assertActive)).status),
          );
        case 'none':
          await attempts.markUnknown(saved.id, proof);
          return { status: 'outcome_unknown' };
      }
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- after a disclosure nothing is safe to repeat, and no Playwright, SDK or renderer prose crosses this boundary
  } catch (_error) {
    const current = await attempts.get(saved.id);
    switch (current?.phase) {
      case 'exposed':
      case 'awaiting_verification':
        await settle(() => attempts.markUnknown(saved.id, evidence('interrupted', 'unknown', 'unknown')));
        return { status: 'outcome_unknown' };
      // The website already confirmed the change; only 1Password's update was cut short.
      case 'confirmed':
        return websiteOutcome(saved.kind, 'pending');
      case 'conflict':
      case 'finalized':
        return websiteOutcome(saved.kind, current.phase);
      default:
        return { status: 'outcome_unknown' };
    }
  } finally {
    page.off('framenavigated', navigation);
    await settleFilledSecrets(context, page, secrets);
  }
}

registerBrowserQueuedAction('credential_form', {
  validate: validateCredentialForm,
  execute: (context, payload) => executeCredentialForm(context, payload),
});
