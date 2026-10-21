/** Shared control and route policy. Checkout readers consume it without importing the action executor. */
import type { ElementHandle, Page } from 'playwright-core';
import { getDomain } from 'tldts';
import { httpsOrigin, type CredentialKind } from './authentication-signatures.js';
import { consentClassChoice } from './consent.js';
import type { ControlFacts } from './control-facts.js';
import { merchantSignatures } from './merchant-signatures.js';

/** What the open rule decides for every control and navigation (KTD1). */
export type ActivationKind = 'click' | 'submit' | 'select' | 'download';

export type ActionClass =
  | 'ordinary'
  | 'purchase_control'
  | 'speaks_as_principal'
  | 'account_security'
  | 'consent_control'
  | 'blocked_address';
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

/** The reviewed flow owning this page, from trusted host code only. */
export function reviewedMerchantFlow(url: URL): ReviewedMerchantFlow | undefined {
  return merchantFlows.find((candidate) => candidate.matches(url));
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
 * Named preparation on a checkout, and the view controls of an order or booking's own page beside its charge and
 * card (a calendar entry, a receipt, tracking, managing the booking): never a commit, even where the page is a
 * transaction page (R2). Each of a control's names must be one. Changing or cancelling a booking is none of these:
 * R14 decides it.
 */
const preparation =
  /^(?:add\s+to\s+(?:(?:my|your)\s+)?calendar|(?:view|see|show|print|download)\s+(?:(?:my|your|the)\s+)?(?:receipt|invoice|order|booking|reservation|tickets?)(?:\s+details)?|track\s+(?:(?:my|your|the)\s+)?(?:order|package|parcel|delivery|shipment)|manage\s+(?:(?:my|your|the)\s+)?(?:booking|reservation|order|tickets?)|[+−–-]|plus|minus|(?:(?:increase|decrease|reduce|raise|lower|update|change|edit|set|select|choose)\s+(?:the\s+)?)?(?:quantity|qty)\b.*|remove\b.*|delete(?:\s+(?:item|this\s+item|from\s+.+))?|apply(?:\s+(?:code|coupon|promo(?:\s+code)?|discount(?:\s+code)?|gift\s+card|voucher|credit))?|(?:add|enter|use|have\s+an?)\s+(?:a\s+)?(?:coupon|promo(?:\s+code)?|discount(?:\s+code)?|gift\s+card|voucher)\b.*|(?:coupon|promo(?:\s+code)?|discount(?:\s+code)?|gift\s+card|voucher)\b.*|edit\b.*|change(?:\s+(?:address|delivery|shipping|date|time|quantity|size|colou?r|items?))?|(?:use|add|edit|change|select|choose|save|enter)\s+(?:(?:a|this|new|another|the)\s+)?(?:(?:shipping|delivery|billing)\s+)?address(?:es)?\b.*|(?:select|choose|change)\s+(?:a\s+|the\s+)?(?:delivery|shipping)\s+(?:option|method|speed|date|time)|(?:standard|express|next.day|same.day|economy|priority|free)\s+(?:delivery|shipping)\b.*|back|go\s+back|previous|return\s+to\s+(?:cart|bag|basket|shop|store|shipping|information|details)|continue\s+(?:shopping|browsing)|keep\s+shopping|(?:show|hide|view|see|open|close)\s+(?:the\s+)?(?:order\s+)?(?:summary|details)|order\s+summary|add\s+to\s+(?:cart|bag|basket)|(?:view|go\s+to|open)\s+(?:cart|bag|basket)|(?:proceed|continue|go)\s+to\s+(?:checkout|shipping|delivery|payment|billing|information|details)|check\s*out|close|dismiss|cancel|not\s+now|no,?\s+thanks)$/iu;
/** Roles and tags that choose or hold a value: activating one never presses anything. */
const choiceRole =
  /^(?:checkbox|radio|switch|option|menuitemcheckbox|menuitemradio|tab|slider|spinbutton|combobox|listbox|textbox|searchbox)$/iu;

/**
 * Whether the action presses the control: a button, a scripted link or click handler, or an Enter or host
 * submit. Choosing, typing into or focusing a field presses nothing; a link with an address is a navigation,
 * decided by its route.
 */
export function pressesControl(facts: ControlFacts, kind: ActivationKind): boolean {
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
export function classifyControlFacts(facts: ControlFacts, kind: ActivationKind = 'click'): ActionClass {
  const names = [facts.name, facts.visibleLabel ?? ''].map((name) => name.trim()).filter(Boolean);
  const evidence = names.join(' ');
  const pressed = pressesControl(facts, kind);
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
  // 4. A choice the consent engine owns (KTD11), by the choice the action would toggle: the agent never makes it.
  if (facts.toggles && consentClassChoice(facts.toggles)) return 'consent_control';
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
  const reviewed = reviewedMerchantFlow(url)?.classifyNavigation(url);
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
