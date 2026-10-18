import type { ElementHandle, Page } from 'playwright-core';
import { getDomain } from 'tldts';
import { merchantSignatures } from './merchant-signatures.js';
import { SiteLeaseStore } from './leases.js';
import { documentGate } from './document-gate.js';
import { ensurePageTargets, onUncoveredPageTarget, pageTargetsReady } from './page-targets.js';
import type { BrowserExecutionContext } from './queue.js';
import {
  inspectAuthenticationControl,
  submitAuthenticationForm,
  type AuthenticationFormSignature,
  type CredentialKind,
  httpsOrigin,
} from './authentication-signatures.js';
import { moneyTerms, readPageControlFacts, type ControlFacts } from './control-facts.js';

export type { ControlFacts, ControlRegion } from './control-facts.js';

/** What the open rule decides for every control and navigation (KTD1). */
export type ActionClass =
  | 'ordinary'
  | 'purchase_control'
  | 'speaks_as_principal'
  | 'account_security'
  | 'blocked_address';
/**
 * An activation's outcome. `unsupported_merchant` is never a classification: it is a reviewed flow's exact
 * check failing, or an ordinary control the host cannot carry out natively yet.
 */
export type ActivationClass = ActionClass | 'unsupported_merchant';
/** A credential operation's own strict outcome: anything outside its vocabulary is an unsupported control. */
export type CredentialActivationClass = ActionClass | 'unsupported_control';
export interface ReviewedMerchantFlow {
  readonly id: string;
  matches(url: URL): boolean;
  /** The flow's exact reading of a control on its pages; undefined leaves the control to the open rule. */
  classifyControl(page: Page, element: ElementHandle, facts: ControlFacts): Promise<ActionClass | undefined>;
  /** The flow's exact reading of a route on its origins; undefined leaves the route to the open rule. */
  classifyNavigation(url: URL): ActionClass | undefined;
  verifyPurchaseControl?(page: Page, element: ElementHandle): Promise<boolean>;
}
const merchantFlows: ReviewedMerchantFlow[] = [...merchantSignatures];

/** Trusted source registrations only. Neither page prose nor stored recipes can register support. */
export function registerReviewedMerchantFlow(flow: ReviewedMerchantFlow): void {
  if (merchantFlows.some((existing) => existing.id === flow.id)) throw new Error('Merchant flow already registered');
  merchantFlows.push(flow);
}

// Vocabulary is data: widen or narrow it here, never by bypassing the classification order.
const purchase =
  /\b(?:buy(?:\s+now)?|pay(?:\s+now)?|place\s+(?:your\s+)?order|order\s+now|purchase(?!\s+(?:history|details|summary|records?|protection|options?))|confirm\s+(?:purchase|order|reservation|booking)|complete\s+(?:purchase|order|booking|reservation)|reserve\s+now|book\s+now|subscribe|start\s+(?:free\s+)?trial|donate|accept\s+(?:fee|charge)|upgrade|renew|place\s+(?:a\s+|your\s+)?bid|bid\s+now)\b/iu;
/** Registration is a purchase only when it is paid. */
const registration = /\bregister\b/iu;
/** Cancelling or changing a booking or an order, a purchase on a page that shows a fee (R14). */
const cancellation =
  /\b(?:cancel|change|modify|reschedule|amend)\s+(?:(?:my|this|your|the)\s+)?(?:reservation|booking|order|appointment|table|stay|trip|tickets?|subscription|membership|plan|visit|class)s?\b|^yes,?\s+cancel\b/iu;
/** A bare Cancel cancels the booking on its page; in a dialog it closes the dialog. */
const bareCancel = /^cancel$/iu;
const security =
  /\b(?:change|reset|delete|remove|update|manage)\s+(?:password|security|account|payment\s+method|credit\s+card)|\b(?:sign\s*out|log\s*out|delete\s+account)\b/iu;
const speaking =
  /\b(?:send\s+(?:message|email)|publish|post\s+(?:review|comment)|submit\s+(?:review|comment)|agree\s+on\s+behalf)\b/iu;
/** Speaking a control's label names: reviews, comments, ratings, tips and messages to people (R4). */
const speakingName =
  /\b(?:write|leave|add|post|submit)\s+(?:a\s+|your\s+)?(?:review|comment|rating|reply|answer|question|tip)\b|\b(?:send|post|submit)\s+(?:a\s+|your\s+)?(?:message|reply|note|inquiry|enquiry|feedback)\b|\b(?:give|send)\s+(?:a\s+)?tip\b|\brate\s+(?:this|us|it|your)\b|\bmessage\s+(?:the\s+|a\s+)?(?:restaurant|seller|host|owner|store|shop|business|venue|organi[sz]er|support)\b/iu;
/** A press named only for speaking. On a field the same word names its content, not an action. */
const speakingPress = /^(?:post|reply|comment|publish|tweet)$/iu;
const unrelatedSecurity =
  /\b(?:change|update|add|remove|manage)\s+(?:sign.in email|email address|phone|two.factor|2fa|payment methods?)\b/iu;
const securityRoute =
  /\b(?:security|secure|auth|account)\s+(?:lock|report|reset|revoke)\b|\b(?:reset|revoke|lock)\s+(?:password|account|access|sessions?|tokens?)\b/iu;
const purchaseRoute =
  /\b(?:oneclick|one click|charge|checkout submit|confirmbooking|placeorder|purchase|subscribe|starttrial)\b/iu;
/**
 * Named preparation on a checkout: never a commit, even where the page is a transaction page (R2). Each of a
 * control's names must be preparation.
 */
const preparation =
  /^(?:[+−–-]|plus|minus|(?:(?:increase|decrease|reduce|raise|lower|update|change|edit|set|select|choose)\s+(?:the\s+)?)?(?:quantity|qty)\b.*|remove\b.*|delete(?:\s+(?:item|this\s+item|from\s+.+))?|apply(?:\s+(?:code|coupon|promo(?:\s+code)?|discount(?:\s+code)?|gift\s+card|voucher|credit))?|(?:add|enter|use|have\s+an?)\s+(?:a\s+)?(?:coupon|promo(?:\s+code)?|discount(?:\s+code)?|gift\s+card|voucher)\b.*|(?:coupon|promo(?:\s+code)?|discount(?:\s+code)?|gift\s+card|voucher)\b.*|edit\b.*|change(?:\s+(?:address|delivery|shipping|date|time|quantity|size|colou?r|items?))?|(?:use|add|edit|change|select|choose|save|enter)\s+(?:(?:a|this|new|another|the)\s+)?(?:(?:shipping|delivery|billing)\s+)?address(?:es)?\b.*|(?:select|choose|change)\s+(?:a\s+|the\s+)?(?:delivery|shipping)\s+(?:option|method|speed|date|time)|(?:standard|express|next.day|same.day|economy|priority|free)\s+(?:delivery|shipping)\b.*|back|go\s+back|previous|return\s+to\s+(?:cart|bag|basket|shop|store|shipping|information|details)|continue\s+(?:shopping|browsing)|keep\s+shopping|(?:show|hide|view|see|open|close)\s+(?:the\s+)?(?:order\s+)?(?:summary|details)|order\s+summary|add\s+to\s+(?:cart|bag|basket)|(?:view|go\s+to|open)\s+(?:cart|bag|basket)|(?:proceed|continue|go)\s+to\s+(?:checkout|shipping|delivery|payment|billing|information|details)|check\s*out|close|dismiss|cancel|not\s+now|no,?\s+thanks)$/iu;
/** Roles and tags that choose or hold a value: activating one never presses anything. */
const choiceRole =
  /^(?:checkbox|radio|switch|option|menuitemcheckbox|menuitemradio|tab|slider|spinbutton|combobox|listbox|textbox|searchbox)$/iu;

/**
 * Whether the action presses the control: a button, a scripted link or click handler, or an Enter or host
 * submit. Choosing, typing into or focusing a field presses nothing; a link with an address is a navigation,
 * decided by its route.
 */
function presses(facts: ControlFacts, kind: ActivationIntent['kind']): boolean {
  if (kind === 'submit') return true;
  if (choiceRole.test(facts.role) || ['select', 'textarea', 'option', 'label'].includes(facts.tag)) return false;
  if (facts.tag === 'input') return ['submit', 'image', 'button', 'reset'].includes(facts.type);
  if (facts.href && !facts.scripted) return false;
  return (
    facts.tag === 'button' ||
    facts.tag === 'a' ||
    facts.scripted === true ||
    /^(?:button|link|menuitem)$/iu.test(facts.role)
  );
}

/**
 * The open rule (KTD1). Every control is decided fresh, in this order: blocked address, account security,
 * speaking, consent-class controls, purchase vocabulary, a commit on a transaction page, then ordinary.
 * `kind` is the action: an Enter or a host submit presses the control it is aimed at.
 */
export function classifyControlFacts(facts: ControlFacts, kind: ActivationIntent['kind'] = 'click'): ActionClass {
  const names = [facts.name, facts.visibleLabel ?? ''].map((name) => name.trim()).filter(Boolean);
  const evidence = names.join(' ');
  const pressed = presses(facts, kind);
  const region = facts.region;
  const routes = [facts.href, facts.formAction].flatMap((raw) => (raw ? [classifyNavigationUrl(raw)] : []));
  // 1. A blocked address.
  if (routes.includes('blocked_address')) return 'blocked_address';
  // 2. Account security: by label, by route, or a press of an account form on a signed-in account page.
  if (
    security.test(evidence) ||
    unrelatedSecurity.test(evidence) ||
    routes.includes('account_security') ||
    (pressed && facts.accountPage === true && region?.accountFields === true)
  )
    return 'account_security';
  // 3. Speaking: by label, by route, in a chat widget, or a press that sends free text outside a booking or order,
  // where the text would be that transaction's note.
  if (
    speaking.test(evidence) ||
    speakingName.test(evidence) ||
    (pressed && names.some((name) => speakingPress.test(name))) ||
    routes.includes('speaks_as_principal') ||
    (pressed && (facts.chatFrame === true || (region?.freeText === true && !region.commits)))
  )
    return 'speaks_as_principal';
  // 4. Consent-class controls (KTD11) are decided here, before any purchase.
  // 5. Purchase vocabulary: a label or route naming one, paid registration, or cancelling or changing a booking
  // whose page shows a fee.
  if (
    purchase.test(evidence) ||
    routes.includes('purchase_control') ||
    (pressed && facts.moneyTerms === true && registration.test(evidence)) ||
    (facts.feeTerms === true &&
      names.some((name) => cancellation.test(name) || (bareCancel.test(name) && region?.dialog !== true)))
  )
    return 'purchase_control';
  // 6. A commit on a transaction page: a press in a form or dialog that shows a total or a charge with a payment
  // method, or in a modal speaking of the order on such a page, unless the host names it as preparation.
  if (
    pressed &&
    (region?.transaction === true || (region?.modalOrder === true && facts.transaction)) &&
    !(names.length > 0 && names.every((name) => preparation.test(name)))
  )
    return 'purchase_control';
  return 'ordinary';
}

const ACTION_PARAMETER = /^(?:action|operation|intent|command|do)$/iu;
/** A path segment of this many words or more is prose, such as an article's slug, never a route that acts. */
const PROSE_WORDS = 4;

/** A navigation's path and action parameters as words, for the host's own route signatures. */
function navigationEvidence(url: URL): string | undefined {
  try {
    const actionParameters = [...url.searchParams]
      .map(([name, value]) => (ACTION_PARAMETER.test(name) ? `${name} ${value}` : name))
      .join(' ');
    return decodeURIComponent(`${url.pathname} ${actionParameters}`).replace(/[_/-]+/gu, ' ');
  } catch (_error) {
    return undefined;
  }
}

/** The words of a navigation's route that can act: its path segments and action parameters, without prose. */
function routeWords(url: URL): string | undefined {
  try {
    return [
      ...url.pathname.split('/').map((segment) => decodeURIComponent(segment)),
      ...[...url.searchParams].map(([name, value]) => (ACTION_PARAMETER.test(name) ? `${name} ${value}` : name)),
    ]
      .map((piece) => piece.replace(/[_/-]+/gu, ' ').trim())
      .filter((piece) => piece && piece.split(/\s+/u).length < PROSE_WORDS)
      .join(' ');
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return undefined;
  }
}

/**
 * The open rule for a navigation: any public page loads, except a blocked address, an account-security,
 * speaking or purchase route. A reviewed flow keeps its exact routes; its other routes take the open rule.
 */
export function classifyNavigationUrl(raw: string): ActionClass {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_error) {
    return 'blocked_address';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'blocked_address';
  const words = routeWords(url);
  if (words === undefined) return 'blocked_address';
  if (security.test(words) || securityRoute.test(words)) return 'account_security';
  if (speaking.test(words)) return 'speaks_as_principal';
  const reviewed = merchantFlows.find((candidate) => candidate.matches(url))?.classifyNavigation(url);
  if (reviewed === 'ordinary' && ![...url.searchParams.keys()].some((name) => ACTION_PARAMETER.test(name)))
    return 'ordinary';
  if (purchase.test(words) || purchaseRoute.test(words)) return 'purchase_control';
  return reviewed && reviewed !== 'ordinary' ? reviewed : 'ordinary';
}

/**
 * The words an authorized password change may use (KTD7, R18). Only within a
 * change's own scope are they set aside before the security checks; every
 * other account-security change stays refused there too.
 */
const passwordChange = /\b(?:change|update|set|save)\s+(?:(?:your|my)\s+)?(?:new\s+)?password\b/giu;
const credentialSecurity =
  /\b(?:change|update|add|remove|manage|edit|replace|reset|delete)\s+(?:(?:your|my|sign.?in|login)\s+)?(?:e-?mail(?:\s+address)?|phone(?:\s+number)?|mobile|two.?factor|2fa|mfa|totp|authenticator|passkeys?|security\s+(?:keys?|questions?)|payment(?:\s+methods?)?|billing|cards?)\b/iu;
/** Inside the widened scope, any money route is refused, not merely the generic commit signatures. */
const credentialFinancial =
  /\b(?:checkout|cart|basket|billing|payments?|orders?|subscriptions?|subscribe|trials?|donate|donations?|purchase|upgrade|plans?|pricing)\b/iu;
const signupActivation =
  'sign\\s*up(?:\\s+with\\s+email)?|create\\s+(?:(?:an|your|my|new)\\s+)?account|register|join(?:\\s+now)?|get\\s+started|continue(?:\\s+with\\s+email)?|next|submit|done|finish|save|create';
const credentialActivation: Record<CredentialKind, RegExp> = {
  signup: new RegExp(`^(?:${signupActivation})$`, 'iu'),
  rotation:
    /^(?:(?:change|update|set|save)\s+(?:(?:your|my)\s+)?(?:new\s+)?password|save(?:\s+changes)?|submit|continue|next|done|confirm|update)$/iu,
};
/**
 * A signup form's own submit control that accepts the site's terms as it
 * creates the account ("Agree and create account", "Agree & Join"). Only the
 * bound form's control may carry it, with no money terms on the page.
 */
const agreeingSignup = new RegExp(`^(?:i\\s+)?(?:agree|accept)\\s*(?:and|&)\\s*(?:${signupActivation})$`, 'iu');
/** The control that submits a signup's emailed verification code. */
const verificationActivation =
  /^(?:verify(?:\s+(?:my\s+)?(?:e-?mail|account|code))?|confirm(?:\s+(?:my\s+)?(?:e-?mail|account|code))?|submit(?:\s+code)?|activate(?:\s+(?:my\s+)?account)?|continue|next|done)$/iu;
/** The site terms a delegated signup accepts with the account, and what never rides along with them. */
const siteTerms =
  /\b(?:terms(?:\s+(?:of\s+(?:service|use)|(?:and|&)\s+conditions))?|user\s+agreement|privacy\s+(?:policy|notice|statement))\b/iu;
const notSiteTerms =
  /\b(?:marketing|newsletters?|news|offers?|promotions?|promotional|partners?|third[\s-]+part(?:y|ies)|shar(?:e|ing)|advertis\w*|sponsors?|surveys?|updates|e-?mails?|sms|texts?|pay(?:ment|ments|ing)?|billing|billed|charges?|fees?|prices?|pricing|purchases?|orders?|sales?|trials?|subscri\w*|renew\w*|recurring|memberships?|plans?|cards?|credit|refunds?)\b|[$€£¥]/iu;

/**
 * Whether a checkbox's label accepts only the site's terms of service, terms
 * and conditions, user agreement or privacy policy, the terms a delegated
 * signup accepts with the account. Marketing, data sharing and every money
 * term keep their own authority.
 */
export function termsConsentLabel(label: string): boolean {
  return siteTerms.test(label) && !notSiteTerms.test(label) && !moneyTerms.test(label);
}

/** Where a credential operation's control sits: the bound form's own control, or the step it submits. */
export interface CredentialControlScope {
  /** The control belongs to the bound form, or both stand outside any form. */
  readonly formControl?: boolean;
  /** `verification` submits a signup's emailed code; otherwise the operation's own fields. */
  readonly step?: 'credentials' | 'verification';
}

function credentialSecurityClass(evidence: string, kind: CredentialKind): ActionClass | undefined {
  const remaining = kind === 'rotation' ? evidence.replace(passwordChange, ' ') : evidence;
  if (
    security.test(remaining) ||
    securityRoute.test(remaining) ||
    unrelatedSecurity.test(remaining) ||
    credentialSecurity.test(remaining)
  )
    return 'account_security';
  if (speaking.test(evidence)) return 'speaks_as_principal';
  return undefined;
}

/**
 * A credential operation's own classification of a document address on its
 * site: HTTPS only, with financial, speaking and every security route other
 * than a change's own password route refused. Another site is left to the
 * generic rules (undefined).
 */
export function classifyCredentialNavigation(raw: string, kind: CredentialKind, site: string): ActionClass | undefined {
  const url = httpsOrigin(raw);
  if (!url) return 'blocked_address';
  if (getDomain(url.hostname, { allowPrivateDomains: true }) !== site) return undefined;
  const decoded = navigationEvidence(url);
  if (decoded === undefined) return 'blocked_address';
  const refused = credentialSecurityClass(decoded, kind);
  if (refused) return refused;
  if (purchase.test(decoded) || purchaseRoute.test(decoded) || credentialFinancial.test(decoded))
    return 'purchase_control';
  return 'ordinary';
}

/**
 * Whether an authorized signup or password change may activate this control.
 * Visible money terms, purchase or subscription wording, unrelated security,
 * speaking and links are refused; so is any name outside the operation's own
 * vocabulary, as ambiguous. The form's destination must stay on the site.
 */
export function classifyCredentialControlFacts(
  facts: ControlFacts,
  kind: CredentialKind,
  site: string,
  scope: CredentialControlScope = {},
): CredentialActivationClass {
  const evidence = `${facts.name} ${facts.visibleLabel ?? ''}`;
  const refused = credentialSecurityClass(evidence, kind);
  if (refused) return refused;
  if (purchase.test(evidence)) return 'purchase_control';
  if (facts.transaction || facts.tag === 'a' || facts.href) return 'unsupported_control';
  if (facts.formAction) {
    const destination = classifyCredentialNavigation(facts.formAction, kind, site);
    if (destination !== 'ordinary') return destination ?? 'unsupported_control';
  }
  const fits = (name: string): boolean => {
    if (scope.step === 'verification') return kind === 'signup' && verificationActivation.test(name);
    if (credentialActivation[kind].test(name)) return true;
    return kind === 'signup' && scope.formControl === true && !facts.moneyTerms && agreeingSignup.test(name);
  };
  const names = [facts.name.trim(), facts.visibleLabel?.trim() ?? ''].filter(Boolean);
  return names.length > 0 && names.every(fits) ? 'ordinary' : 'unsupported_control';
}

export async function classifyCredentialActivation(
  page: Page,
  element: ElementHandle,
  kind: CredentialKind,
  site: string,
  scope: CredentialControlScope = {},
): Promise<CredentialActivationClass> {
  return classifyCredentialControlFacts(await readControlFacts(page, element), kind, site, scope);
}

/** The control's facts and the page's transaction signal, read in isolated worlds across every frame. */
export function readControlFacts(page: Page, element: ElementHandle): Promise<ControlFacts> {
  return readPageControlFacts(page, element);
}

/** The open rule for an action on this control, with any reviewed flow's exact reading of it. */
export async function classifyActivation(
  page: Page,
  element: ElementHandle,
  kind: ActivationIntent['kind'] = 'click',
): Promise<ActionClass> {
  return (await activationDispatch(page, element, kind)).classification;
}

async function activationDispatch(
  page: Page,
  element: ElementHandle,
  kind: ActivationIntent['kind'],
): Promise<{
  classification: ActionClass;
  facts: ControlFacts;
  flow?: ReviewedMerchantFlow;
  authentication?: AuthenticationFormSignature;
}> {
  const facts = await readControlFacts(page, element);
  const generic = classifyControlFacts(facts, kind);
  const flow = merchantFlows.find((candidate) => candidate.matches(new URL(page.url())));
  // Every refusal of the open rule outranks a reviewed flow and a site's sign-in claim.
  if (generic !== 'ordinary') return { classification: generic, facts, flow };
  const reviewed = flow && (await flow.classifyControl(page, element, facts));
  if (reviewed) return { classification: reviewed, facts, flow };
  if (!facts.transaction && facts.formMethod?.toLowerCase() === 'post' && facts.formAction) {
    const authentication = await inspectAuthenticationControl(element);
    if (authentication) return { classification: 'ordinary', facts, authentication };
  }
  return { classification: 'ordinary', facts };
}

export class BrowserActivationError extends Error {
  constructor(readonly reason: Exclude<ActivationClass, 'ordinary'>) {
    super(reason);
  }
}

/** The guard refused to start an operation: a page-target setting cannot reach a live frame, so nothing ran. */
export class BrowserFramesUnreadyError extends BrowserActivationError {
  constructor() {
    super('blocked_address');
  }
}

/** The stable, repeat-safe stop every executor answers when the guard refused to start its operation. */
export function framesUnreadyStop(error: unknown): Record<string, unknown> | undefined {
  return error instanceof BrowserFramesUnreadyError
    ? { status: 'stopped', reason: error.reason, repeat_safe: true }
    : undefined;
}

const approvedPresses = new WeakMap<Page, { origin: string; flow: ReviewedMerchantFlow }>();

/** All recipes, fills, watches and tool activations use this single boundary. */
export interface ActivationIntent {
  kind: 'click' | 'submit' | 'select' | 'download';
  value?: string;
  /** Host-only cancellation/deadline check immediately before a native authentication submit. */
  assertActive?: () => Promise<void>;
}

export async function activateControl(
  page: Page,
  element: ElementHandle,
  operation: () => Promise<void>,
  authority?: { commitStarted(): Promise<void> },
  intent: ActivationIntent = { kind: 'click' },
): Promise<void> {
  const dispatch = await activationDispatch(page, element, intent.kind);
  const { classification, facts } = dispatch;
  if (classification === 'purchase_control' && authority) {
    const source = new URL(page.url());
    const flow = dispatch.flow;
    if (!flow?.verifyPurchaseControl || !(await flow.verifyPurchaseControl(page, element)))
      throw new BrowserActivationError('unsupported_merchant');
    await authority.commitStarted();
    approvedPresses.set(page, { origin: source.origin, flow });
    try {
      return await operation();
    } finally {
      approvedPresses.delete(page);
    }
  }
  if (classification !== 'ordinary') throw new BrowserActivationError(classification);
  if (dispatch.flow) return operation();
  if (dispatch.authentication) {
    const authentication = dispatch.authentication;
    const guard = await ensureBrowserNavigationGuard(page);
    // The open rule decides where the submission lands.
    await guard.runWithPolicy({}, async () => {
      const arrived = page
        .waitForEvent('framenavigated', { predicate: (frame) => frame === authentication.frame, timeout: 2_000 })
        .catch(() => undefined);
      if (!(await submitAuthenticationForm(authentication, intent.assertActive)))
        throw new BrowserActivationError('unsupported_merchant');
      await arrived;
    });
    return;
  }
  // A field is only focused; a submit input is pressed like any button, below.
  if ((facts.tag === 'input' && !presses(facts, 'click')) || facts.tag === 'textarea') {
    await element.focus();
    return;
  }
  let url = facts.href;
  if (!url && facts.formMethod?.toLowerCase() === 'get' && facts.formAction) {
    const controls = await element.evaluate(
      (node, selection) => {
        const target = node as unknown as {
          name?: string;
          form?: {
            elements: ArrayLike<{
              name?: string;
              value?: string;
              type?: string;
              disabled?: boolean;
              checked?: boolean;
              getAttribute(name: string): string | null;
            }>;
          };
        };
        return Array.from(target.form?.elements ?? [])
          .filter(
            (e) =>
              e.name &&
              !e.disabled &&
              !['submit', 'button', 'reset', 'file'].includes(e.type ?? '') &&
              (!['checkbox', 'radio'].includes(e.type ?? '') || e.checked),
          )
          .map((e) => ({
            name: e.name ?? '',
            value: selection.kind === 'select' && e.name === target.name ? (selection.value ?? '') : (e.value ?? ''),
            secret:
              e.type === 'password' ||
              /(?:one-time-code|cc-|token|secret|password|credential|csrf)/iu.test(
                (e.getAttribute('autocomplete') ?? '') + ' ' + (e.name ?? ''),
              ),
          }));
      },
      { kind: intent.kind, value: intent.value },
    );
    if (controls.some((control) => control.secret)) throw new BrowserActivationError('unsupported_merchant');
    const action = new URL(facts.formAction);
    action.search = new URLSearchParams(
      controls.map((control): [string, string] => [control.name, control.value]),
    ).toString();
    url = action.href;
  }
  if (!url || classifyNavigationUrl(url) !== 'ordinary') throw new BrowserActivationError('unsupported_merchant');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!(intent.kind === 'download' && error instanceof Error && /Download is starting/iu.test(error.message)))
      throw error;
  }
}

export interface BrowserNavigationPolicy {
  /**
   * A host-owned operation's own complete classification of a document on its
   * site, replacing the generic one; undefined leaves the generic rules. Only
   * an authorized credential operation installs one, for its activation.
   */
  decide?(url: URL): ActivationClass | undefined;
  /** A host-owned sign-in scope may recognize an otherwise unsupported bearer-link route. */
  classify?(url: URL): ActivationClass;
  stripReferrer?: boolean;
  beforeNavigate?(url: URL): Promise<'ordinary' | 'site_busy' | 'blocked_address'>;
}
export interface BrowserNavigationGuard {
  reason(): ActivationClass | 'site_busy' | undefined;
  clearReason(): void;
  runWithPolicy<T>(policy: BrowserNavigationPolicy, operation: () => Promise<T>): Promise<T>;
}
const navigationGuards = new WeakMap<Page, Promise<BrowserNavigationGuard>>();

/** The page's navigation guard: it decides the page's documents at the browser's document gate until the page closes. */
export function ensureBrowserNavigationGuard(page: Page): Promise<BrowserNavigationGuard> {
  let guard = navigationGuards.get(page);
  if (!guard) {
    guard = installNavigationGuard(page);
    navigationGuards.set(page, guard);
  }
  return guard;
}

/** One paused document's class under the scopes and approved press that were current when it paused. */
async function decideNavigation(
  url: string,
  scopes: readonly BrowserNavigationPolicy[],
  approved: { origin: string; flow: ReviewedMerchantFlow } | undefined,
): Promise<ActivationClass | 'site_busy'> {
  let classification: ActivationClass | 'site_busy' = scopes.length
    ? classifyNavigationUrl(url)
    : 'unsupported_merchant';
  if (
    approved &&
    classification !== 'blocked_address' &&
    classification !== 'account_security' &&
    classification !== 'speaks_as_principal'
  ) {
    const target = new URL(url);
    if (target.origin === approved.origin && approved.flow.matches(target)) {
      // During its approved press a reviewed flow's own route is ordinary; a route it does not know is refused.
      const known = approved.flow.classifyNavigation(target);
      classification = known === 'purchase_control' ? 'ordinary' : (known ?? 'unsupported_merchant');
    }
  }
  for (const policy of scopes) {
    let decided: ActivationClass | undefined;
    try {
      decided = policy.decide?.(new URL(url));
      // eslint-disable-next-line no-catch-all/no-catch-all -- a scope that cannot classify a document blocks it
    } catch (_error) {
      decided = 'blocked_address';
    }
    if (decided) classification = decided;
  }
  for (const policy of scopes) {
    if (policy.classify) {
      let scoped: ActivationClass;
      try {
        scoped = policy.classify(new URL(url));
      } catch (_error) {
        scoped = 'blocked_address';
      }
      if (scoped !== 'ordinary' || classification === 'unsupported_merchant') classification = scoped;
    }
    if (classification === 'ordinary' && policy.beforeNavigate)
      classification = await policy.beforeNavigate(new URL(url));
  }
  return classification;
}

// Every request type but Document: documents are decided, and stripped, at the document gate. These are
// the types Chrome's Fetch filter accepts (it refuses TextTrack, Prefetch, Manifest and others by name);
// Chrome files every other request under one of them, a text track as Media and a prefetch as Fetch.
const SUBRESOURCE_TYPES = [
  'Stylesheet',
  'Image',
  'Media',
  'Font',
  'Script',
  'XHR',
  'Fetch',
  'EventSource',
  'Ping',
  'CSPViolationReport',
  'Other',
] as const;

/**
 * The request's headers with an empty Referer. Chrome keeps a request's referrer apart from its
 * headers and restores the Referer when an override merely leaves it out; only an empty one clears it.
 */
function withoutReferrer(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return [
    ...Object.entries(headers)
      .filter(([name]) => !/^(?:referer|referrer)$/iu.test(name))
      .map(([name, value]) => ({ name, value: String(value) })),
    { name: 'Referer', value: '' },
  ];
}

async function installNavigationGuard(page: Page): Promise<BrowserNavigationGuard> {
  let blocked: ActivationClass | 'site_busy' | undefined;
  const policies: BrowserNavigationPolicy[] = [];
  // Each outermost operation, and each span between them, is its own generation. A decision is
  // reported only to the generation its request paused in; a late one is still enforced, not reported.
  let generation = 0;
  // Any page-target setting that cannot reach a later frame stops the operation in progress.
  onUncoveredPageTarget(page, () => {
    blocked = 'blocked_address';
  });
  const browser = page.context().browser();
  if (!browser) throw new Error('A navigation guard needs its Chrome connection');
  const gate = await documentGate(browser);
  // The gate places a same-process child frame through these sessions' frame trees.
  await ensurePageTargets(page);
  // The gate decides documents. While a sign-in scope asks, this session pauses the page's other
  // requests, never a document, to strip their Referer.
  const pageSession = await page.context().newCDPSession(page);
  pageSession.on('Fetch.requestPaused', (event) => {
    void pageSession
      .send('Fetch.continueRequest', { requestId: event.requestId, headers: withoutReferrer(event.request.headers) })
      .catch(() =>
        pageSession.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }),
      )
      .catch(() => undefined);
  });
  const { targetInfo } = await pageSession.send('Target.getTargetInfo');
  const unregister = gate.register(targetInfo.targetId, {
    capture() {
      const scopes = [...policies];
      const approved = approvedPresses.get(page);
      const pausedIn = generation;
      const record = (classification: Exclude<ActivationClass, 'ordinary'> | 'site_busy'): void => {
        if (pausedIn === generation) blocked = classification;
      };
      return {
        async decide(document) {
          let classification: ActivationClass | 'site_busy';
          try {
            classification = await decideNavigation(document.url, scopes, approved);
            // eslint-disable-next-line no-catch-all/no-catch-all -- A decision that cannot complete refuses its request.
          } catch (_error) {
            classification = 'blocked_address';
          }
          if (classification === 'ordinary' || document.url === 'about:blank')
            return scopes.some((policy) => policy.stripReferrer)
              ? { allow: true, headers: withoutReferrer(document.headers) }
              : { allow: true };
          record(classification);
          return { allow: false };
        },
        refuse: () => record('blocked_address'),
      };
    },
  });
  page.once('close', () => {
    unregister();
    navigationGuards.delete(page);
    void pageSession.detach().catch(() => undefined);
  });
  let stripping = 0;
  return {
    reason: () => blocked,
    clearReason() {
      blocked = undefined;
    },
    async runWithPolicy(scope, operation) {
      const outermost = !policies.length;
      if (outermost) {
        // A new operation starts clean, before readiness can report a frame it could not reach.
        blocked = undefined;
        ++generation;
      }
      policies.push(scope);
      const strips = Boolean(scope.stripReferrer);
      try {
        if (strips && stripping++ === 0)
          await pageSession.send('Fetch.enable', {
            patterns: SUBRESOURCE_TYPES.map((resourceType) => ({ requestStage: 'Request' as const, resourceType })),
          });
        // An operation can act only in frames that exist now, so every page-target setting covers each first.
        if (!(await pageTargetsReady(page))) {
          blocked = 'blocked_address';
          throw new BrowserFramesUnreadyError();
        }
        return await operation();
      } finally {
        const index = policies.lastIndexOf(scope);
        if (index !== -1) policies.splice(index, 1);
        if (strips && --stripping === 0) await pageSession.send('Fetch.disable').catch(() => undefined);
        if (outermost) ++generation;
      }
    },
  };
}

export type BrowserSiteAccess = (url: URL) => Promise<'ordinary' | 'site_busy' | 'blocked_address'>;

/** Use around every host browser executor; nested secret scopes share this same page guard. */
export async function withBrowserJobNavigation<T>(
  context: BrowserExecutionContext,
  page: Page,
  operation: () => Promise<T>,
  siteAccess?: BrowserSiteAccess,
): Promise<T> {
  const guard = await ensureBrowserNavigationGuard(page);
  const leases = new SiteLeaseStore(context.store.db);
  if (/^https?:/u.test(page.url())) {
    const lease = siteAccess
      ? { acquired: (await siteAccess(new URL(page.url()))) === 'ordinary', waitingJobs: [] }
      : await leases.acquire(context.job.id, page.url());
    await context.wakeWaiters(lease.waitingJobs, `${context.request.id}:lease-release`);
    if (!lease.acquired) {
      // A regular activation exception carries the same closed vocabulary as a tool stop.
      throw new BrowserSiteBusyError();
    }
  }
  return guard.runWithPolicy(
    {
      async beforeNavigate(url) {
        await context.assertActive();
        if (siteAccess) return siteAccess(url);
        const lease = await leases.acquire(context.job.id, url.href);
        await context.wakeWaiters(lease.waitingJobs, `${context.request.id}:redirect-release`);
        return lease.acquired ? 'ordinary' : 'site_busy';
      },
    },
    operation,
  );
}

export class BrowserSiteBusyError extends Error {
  readonly reason = 'site_busy';
  constructor() {
    super('site_busy');
  }
}
