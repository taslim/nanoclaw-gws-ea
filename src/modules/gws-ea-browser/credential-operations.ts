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
 * from `confirmed` or `conflict` it re-runs the vault's finalize.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { Frame, Page } from 'playwright-core';

import { ActionRefusal, answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { hasControlCharacters, isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
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
  readControlFacts,
  termsConsentLabel,
  withBrowserJobNavigation,
  type ActivationClass,
} from './commit-classifier.js';
import type { BrowserRequest } from './db.js';
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
import { registerBrowserQueuedAction, type BrowserExecutionContext } from './queue.js';
import {
  finishSignupVerification,
  openSignupVerification,
  openVerificationLink,
  takeSignupVerification,
} from './sign-in-mail.js';

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
  const cancelling =
    job &&
    (await getDb().get<{ cancel_requested: number }>(
      'SELECT cancel_requested FROM gws_ea_browser_jobs WHERE id = ?',
      job.id,
    ));
  if (!job || job.cancelled || cancelling?.cancel_requested)
    throw forbidden('No live main-owned browser job exists for that thread.');
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

export function registerCredentialAuthorityDelivery(): void {
  registerDeliveryAction(
    'credential_authority',
    answeringAction('credential_authority', (content, session) => credentialAuthorityRequest(content, session)),
    answeredGuard(browserDelegateGuard),
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
  | 'unsupported_control'
  | Exclude<ActivationClass, 'ordinary' | 'unsupported_merchant'>;
class StepStop extends Error {
  constructor(readonly reason: StepRefusal) {
    super(reason);
  }
}
const stopFor = (classification: Exclude<ActivationClass, 'ordinary'>): StepStop =>
  new StepStop(classification === 'unsupported_merchant' ? 'unsupported_control' : classification);

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
  // The Login is saved under the authority's username: a form that names the account must receive exactly that.
  if (
    scope.step === 'credentials' &&
    !fields.some((field) => field.role === 'username') &&
    fields[0].binding.facts.form?.fields.some(
      (field) => editable(field) && credentialFieldFits('username', { ...field, id: '' }, attempt.kind, currentBound),
    )
  )
    throw new StepStop('unsupported_form');
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

/** The website's own response to one submission, from the lines it showed after it. */
function websiteResult(kind: CredentialKind, before: SiteState, now: SiteState): WebsiteResult {
  const fresh = (signal: Signal): boolean => freshSignal(before, now, signal);
  if (kind === 'signup' && fresh('exists')) return 'account_exists';
  if (kind === 'rotation' && fresh('rejectedCurrent')) return 'current_password_rejected';
  if (fresh('rejectedPassword') && now.passwordForm) return 'password_rejected';
  if (fresh('verification')) return 'verification_requested';
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
    watchedResponses.set(saved.id, {
      page,
      frame: group.frame,
      site: group.site,
      kind: group.kind,
      before,
      requestId: context.request.id,
      at: new Date().toISOString(),
    });
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
        // The site refused the value itself, before any submission this host made.
        if (result === 'password_rejected') {
          await settle(() => attempts.markUnknown(saved.id, proof));
          await settle(() => attempts.markRejected(saved.id, proof));
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
          return websiteOutcome(
            saved.kind,
            vaultState((await attempts.finalize(saved.id, context.assertActive)).status),
          );
        case 'none':
          return unknownAfterActivation(proof);
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
 * unknown, in host memory only: the document, the site, and the lines it
 * showed before the activation. A restart forgets it, and so can only leave
 * the attempt unknown.
 */
interface WatchedResponse extends SiteScope {
  readonly page: Page;
  readonly kind: CredentialKind;
  readonly before: SiteState;
  readonly requestId: string;
  readonly at: string;
}
const watchedResponses = new Map<string, WatchedResponse>();

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
 * rejection, a request to verify the email, or success. Otherwise it stays
 * unknown, and its site stays held. From confirmed or a conflict, the vault's
 * finalize runs again, reading everything fresh.
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
    case 'conflict':
      return websiteOutcome(
        attempt.kind,
        vaultState((await attempts.finalize(attempt.id, context.assertActive)).status),
      );
    case 'unknown': {
      const watched = watchedResponses.get(attempt.id);
      if (!watched || !(await attributable(context, watched))) return { status: 'inconclusive' };
      return onSitePage(context, (page) => reconcileResponse(context, page, attempt, watched, attempts));
    }
    default:
      return (await settledOutcome(attempt, attempts, context.assertActive)) ?? refused('not_disclosed');
  }
}

async function reconcileResponse(
  context: BrowserExecutionContext,
  page: Page,
  attempt: CredentialAttempt,
  watched: WatchedResponse,
  attempts: CredentialAttempts,
): Promise<Outcome> {
  if (page !== watched.page) return { status: 'inconclusive' };
  const result = websiteResult(watched.kind, watched.before, await readSite(page, watched));
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
      return websiteOutcome(
        attempt.kind,
        vaultState((await attempts.finalize(attempt.id, context.assertActive)).status),
      );
  }
}

// ---------------------------------------------------------------- email verification

/** Time kept for the host's own work after the verification email's answer arrives. */
const VERIFY_MARGIN_MS = 15_000;

/**
 * Completes a signup the site asked to confirm by email. Only the answer the
 * isolated interpreter returned for this signup's own claim is used, and only
 * by the host: a link is opened on the site, a code goes into the field the
 * browser named. Success needs the site's own fresh confirmation.
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
  if (arrived.status === 'nothing_arrived') return { status: 'nothing_arrived' };
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
        throw error;
      }
      if (typeof opened !== 'string') return refused('origin_mismatch');
      await finishSignupVerification(attempt.id);
      return opened === 'verified'
        ? confirmVerified(context, attempt, attempts, 'link')
        : { status: 'verification_requested' };
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
  try {
    await bindPageSecretDocuments(page, code);
    const filled = await fillNativeCredentialGroup(group.frame, group.native, [code], context.assertActive);
    if (filled === 'not_inserted') return refused('form_changed');
    await finishSignupVerification(attempt.id);
    return await activateWithin(context, page, group, [code], [code], async (activation) => {
      if (activation !== 'activated') return { status: 'verification_requested' };
      const result = await awaitSite(context, 15_000, async () =>
        verificationResult(before, await readSite(page, group), true),
      );
      return result === 'verified'
        ? confirmVerified(context, attempt, attempts, 'code')
        : { status: 'verification_requested' };
    });
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
  return websiteOutcome(attempt.kind, vaultState((await attempts.finalize(attempt.id, context.assertActive)).status));
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
