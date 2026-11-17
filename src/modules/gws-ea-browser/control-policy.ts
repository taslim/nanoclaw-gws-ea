import type { ElementHandle, Page } from 'playwright-core';
import { getDomain } from 'tldts';
import { httpsOrigin, type CredentialKind } from './authentication-signatures.js';
import { consentClassChoice } from './consent.js';
import type { ControlFacts } from './control-facts.js';
import { merchantSignatures } from './merchant-signatures.js';

/** `submit` is an Enter or a host submit, which presses the control it is aimed at. */
export type ActivationKind = 'click' | 'submit' | 'select' | 'download';

/** What the open rule decides for every control and navigation. */
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
/** The reviewed flow owning this page, from trusted host code only. */
export function reviewedMerchantFlow(url: URL): ReviewedMerchantFlow | undefined {
  return merchantSignatures.find((candidate) => candidate.matches(url));
}

/** Whether the host is opening a document or judging a submission/script endpoint. */
export type NavigationUrlPurpose = 'document' | 'submission';

// Vocabulary is data: widen or narrow it here, never by bypassing the classification order.
const commitPurchase =
  /\b(?:buy(?:\s+now)?|pay(?:\s+now)?|place\s+(?:your\s+)?order|order\s+now|purchase(?!\s+(?:history|details|summary|records?|protection|options?))|confirm\s+(?:purchase|order|reservation|booking|appointment)|complete\s+(?:purchase|order|booking|reservation|appointment)|subscribe|start\s+(?:free\s+)?trial|donate|accept\s+(?:fee|charge)|upgrade|renew|place\s+(?:a\s+|your\s+)?bid|bid\s+now)\b/iu;
const entryBooking = /\b(?:reserve|book)\s+now\b/iu;
const purchase = new RegExp(`${commitPurchase.source}|${entryBooking.source}`, 'iu');
const registration = /\bregister\b/iu;
const cancellation =
  /\b(?:cancel|change|modify|reschedule|amend)\s+(?:(?:my|this|your|the)\s+)?(?:reservation|booking|order|appointment|table|stay|trip|tickets?|subscription|membership|plan|visit|class)s?\b|^yes,?\s+cancel\b/iu;
const bareCancel = /^cancel$/iu;
const security =
  /\b(?:change|reset|delete|remove|update|manage)\s+(?:password|security|account|payment\s+method|credit\s+card)|\b(?:sign\s*out|log\s*out|delete\s+account)\b/iu;
const speaking =
  /\b(?:send\s+(?:message|email)|publish|post\s+(?:review|comment)|submit\s+(?:review|comment)|agree\s+on\s+behalf)\b/iu;
const speakingName =
  /\b(?:write|leave|add|post|submit)\s+(?:a\s+|your\s+)?(?:review|comment|rating|reply|answer|question|tip)\b|\b(?:send|post|submit)\s+(?:a\s+|your\s+)?(?:message|reply|note|inquiry|enquiry|feedback)\b|\b(?:give|send)\s+(?:a\s+)?tip\b|\brate\s+(?:this|us|it|your)\b|\bmessage\s+(?:the\s+|a\s+)?(?:restaurant|seller|host|owner|store|shop|business|venue|organi[sz]er|support)\b/iu;
const speakingPress = /^(?:post|reply|comment|publish|tweet)$/iu;
const unrelatedSecurity =
  /\b(?:change|update|add|remove|manage)\s+(?:sign.in email|email address|phone|two.factor|2fa|payment methods?)\b/iu;
const securityRoute =
  /\b(?:security|secure|auth|account)\s+(?:lock|report|reset|revoke)\b|\b(?:reset|revoke|lock)\s+(?:password|account|access|sessions?|tokens?)\b/iu;
const purchaseRoute =
  /\b(?:oneclick|one click|charge|checkout submit|confirmbooking|placeorder|purchase|subscribe|starttrial)\b/iu;
const preparation =
  /^(?:add\s+to\s+(?:(?:my|your)\s+)?calendar|(?:view|see|show|print|download)\s+(?:(?:my|your|the)\s+)?(?:receipt|invoice|order|booking|reservation|tickets?)(?:\s+details)?|track\s+(?:(?:my|your|the)\s+)?(?:order|package|parcel|delivery|shipment)|manage\s+(?:(?:my|your|the)\s+)?(?:booking|reservation|order|tickets?)|[+−–-]|plus|minus|(?:(?:increase|decrease|reduce|raise|lower|update|change|edit|set|select|choose)\s+(?:the\s+)?)?(?:quantity|qty)\b.*|remove\b.*|delete(?:\s+(?:item|this\s+item|from\s+.+))?|apply(?:\s+(?:code|coupon|promo(?:\s+code)?|discount(?:\s+code)?|gift\s+card|voucher|credit))?|(?:add|enter|use|have\s+an?)\s+(?:a\s+)?(?:coupon|promo(?:\s+code)?|discount(?:\s+code)?|gift\s+card|voucher)\b.*|(?:coupon|promo(?:\s+code)?|discount(?:\s+code)?|gift\s+card|voucher)\b.*|edit\b.*|change(?:\s+(?:address|delivery|shipping|date|time|quantity|size|colou?r|items?))?|(?:use|add|edit|change|select|choose|save|enter)\s+(?:(?:a|this|new|another|the)\s+)?(?:(?:shipping|delivery|billing)\s+)?address(?:es)?\b.*|(?:select|choose|change)\s+(?:a\s+|the\s+)?(?:delivery|shipping)\s+(?:option|method|speed|date|time)|(?:standard|express|next.day|same.day|economy|priority|free)\s+(?:delivery|shipping)\b.*|back|go\s+back|previous|return\s+to\s+(?:cart|bag|basket|shop|store|shipping|information|details)|continue\s+(?:shopping|browsing)|keep\s+shopping|(?:show|hide|view|see|open|close)\s+(?:the\s+)?(?:order\s+)?(?:summary|details)|order\s+summary|add\s+to\s+(?:cart|bag|basket)|(?:view|go\s+to|open)\s+(?:cart|bag|basket)|(?:proceed|continue|go)\s+to\s+(?:checkout|shipping|delivery|payment|billing|information|details)|check\s*out|close|dismiss|cancel|not\s+now|no,?\s+thanks)$/iu;
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
 * The open rule. Every control is decided fresh, in this order: blocked address, account security, speaking,
 * consent-class controls, purchase vocabulary, a commit on a transaction page, then ordinary.
 */
export function classifyControlFacts(facts: ControlFacts, kind: ActivationKind = 'click'): ActionClass {
  const names = [facts.name, facts.visibleLabel ?? ''].map((name) => name.trim()).filter(Boolean);
  const evidence = names.join(' ');
  const pressed = pressesControl(facts, kind);
  const region = facts.region;
  const submitsForm = kind === 'submit' || (pressed && (facts.type === 'submit' || facts.type === 'image'));
  const routes: ActionClass[] = [];
  if (facts.href) routes.push(classifyNavigationUrl(facts.href, facts.scripted ? 'submission' : 'document'));
  if (facts.formAction)
    routes.push(
      classifyNavigationUrl(
        facts.formAction,
        submitsForm && facts.formMethod?.toLowerCase() !== 'get' ? 'submission' : 'document',
      ),
    );
  if (routes.includes('blocked_address')) return 'blocked_address';
  if (
    security.test(evidence) ||
    unrelatedSecurity.test(evidence) ||
    routes.includes('account_security') ||
    (pressed && facts.accountPage === true && region?.accountFields === true)
  )
    return 'account_security';
  if (
    speaking.test(evidence) ||
    speakingName.test(evidence) ||
    (pressed && names.some((name) => speakingPress.test(name))) ||
    routes.includes('speaks_as_principal') ||
    (pressed && (facts.chatFrame === true || (region?.freeText === true && !region.commits)))
  )
    return 'speaks_as_principal';
  if (facts.toggles && consentClassChoice(facts.toggles)) return 'consent_control';
  const inTransaction = region?.transaction === true || (region?.modalOrder === true && facts.transaction);
  const ordinaryEntryLink = Boolean(facts.href) && !facts.scripted && !inTransaction;
  const labelCommits =
    !pressed && !facts.href ? false : ordinaryEntryLink ? commitPurchase.test(evidence) : purchase.test(evidence);
  if (
    labelCommits ||
    routes.includes('purchase_control') ||
    (pressed && facts.moneyTerms === true && registration.test(evidence)) ||
    (facts.feeTerms === true &&
      names.some((name) => cancellation.test(name) || (bareCancel.test(name) && region?.dialog !== true)))
  )
    return 'purchase_control';
  if (pressed && inTransaction && !(names.length > 0 && names.every((name) => preparation.test(name))))
    return 'purchase_control';
  return 'ordinary';
}

const ACTION_PARAMETER = /^(?:action|operation|intent|command|do)$/iu;
const PROSE_WORDS = 4;
const submissionBooking = /\b(?:book(?:ings?)?|reserv(?:e|ations?)|appointments?)\b/iu;
const submissionLookup =
  /\b(?:search|availability|available|lookup|slots?|times?|quote|estimate|preview|check|cart)\b/iu;

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

const terminalBookingVerb = /\b(?:book|reserve|schedule)\b/iu;

function decodedPathSegments(url: URL): string[] | undefined {
  try {
    return url.pathname
      .split('/')
      .map((segment) =>
        decodeURIComponent(segment)
          .replace(/[_/-]+/gu, ' ')
          .trim(),
      )
      .filter(Boolean);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return undefined;
  }
}

function queryDecodes(url: URL): boolean {
  try {
    decodeURIComponent(url.search);
    return true;
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return false;
  }
}

function pathnameWords(segments: readonly string[]): string {
  return segments.filter((piece) => piece.split(/\s+/u).length < PROSE_WORDS).join(' ');
}

function routeWords(url: URL, pathOnly: string): string {
  const paramKeys = [...url.searchParams]
    .filter(([name]) => !ACTION_PARAMETER.test(name))
    .map(([name]) => name.replace(/[_/-]+/gu, ' ').trim())
    .filter((piece) => piece && piece.split(/\s+/u).length < PROSE_WORDS);
  return [pathOnly, ...paramKeys].filter(Boolean).join(' ');
}

function actionParameterWords(url: URL): string {
  return [...url.searchParams]
    .filter(([name]) => ACTION_PARAMETER.test(name))
    .map(([name, value]) => `${name} ${value}`.replace(/[_/-]+/gu, ' ').trim())
    .join(' ');
}

function terminalSegmentIsLookup(lastSegment: string | undefined): boolean {
  return Boolean(lastSegment && submissionLookup.test(lastSegment) && !terminalBookingVerb.test(lastSegment));
}

function submissionCommits(words: string, pathOnly: string, lastSegment: string | undefined): boolean {
  return (
    commitPurchase.test(words) ||
    purchaseRoute.test(words) ||
    purchase.test(words) ||
    (submissionBooking.test(pathOnly) && !terminalSegmentIsLookup(lastSegment))
  );
}

/**
 * Whether a non-GET script or form submission targets a purchase or booking commit endpoint, independent of
 * whether query parameters also carry security or speaking terms.
 */
export function isPurchaseSubmissionUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_error) {
    return true;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return true;
  const segments = decodedPathSegments(url);
  if (!segments) return true;
  const pathOnly = pathnameWords(segments);
  const words = routeWords(url, pathOnly);
  const actions = actionParameterWords(url);
  const reviewed = reviewedMerchantFlow(url)?.classifyNavigation(url);
  if (reviewed === 'ordinary' && !actions) return false;
  if (reviewed === 'purchase_control') return true;
  return (
    submissionCommits(words, pathOnly, segments.at(-1)) ||
    Boolean(actions && (purchase.test(actions) || purchaseRoute.test(actions) || submissionBooking.test(actions)))
  );
}

/**
 * The open rule for a navigation or submission address: any document loads, except a blocked address or an
 * account-security, speaking or commit route. Entry booking paths (`book-now`, `reserve-now`) load as documents
 * unless carried as an action parameter or submitted to a non-GET/script endpoint. A reviewed flow keeps its
 * exact routes; its other routes take the open rule.
 */
export function classifyNavigationUrl(raw: string, purpose: NavigationUrlPurpose): ActionClass {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_error) {
    return 'blocked_address';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'blocked_address';
  const segments = decodedPathSegments(url);
  if (!segments || !queryDecodes(url)) return 'blocked_address';
  const pathOnly = pathnameWords(segments);
  const words = routeWords(url, pathOnly);
  const actions = actionParameterWords(url);
  if (security.test(words) || securityRoute.test(words)) return 'account_security';
  if (speaking.test(words)) return 'speaks_as_principal';
  const reviewed = reviewedMerchantFlow(url)?.classifyNavigation(url);
  if (reviewed === 'ordinary' && !actions) return 'ordinary';
  if (commitPurchase.test(words) || purchaseRoute.test(words)) return 'purchase_control';
  if (purpose === 'submission' && purchase.test(words)) return 'purchase_control';
  if (actions) {
    if (security.test(actions) || securityRoute.test(actions)) return 'account_security';
    if (speaking.test(actions)) return 'speaks_as_principal';
    if (purchase.test(actions) || purchaseRoute.test(actions)) return 'purchase_control';
  }
  return reviewed && reviewed !== 'ordinary' ? reviewed : 'ordinary';
}

const passwordChange = /\b(?:change|update|set|save)\s+(?:(?:your|my)\s+)?(?:new\s+)?password\b/giu;
const credentialSecurity =
  /\b(?:change|update|add|remove|manage|edit|replace|reset|delete)\s+(?:(?:your|my|sign.?in|login)\s+)?(?:e-?mail(?:\s+address)?|phone(?:\s+number)?|mobile|two.?factor|2fa|mfa|totp|authenticator|passkeys?|security\s+(?:keys?|questions?)|payment(?:\s+methods?)?|billing|cards?)\b/iu;
const credentialFinancial =
  /\b(?:checkout|cart|basket|billing|payments?|orders?|subscriptions?|subscribe|trials?|donate|donations?|purchase|upgrade|plans?|pricing)\b/iu;
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
 * A credential operation's own classification of a document address on its site: HTTPS only, with financial,
 * speaking and every security route other than a change's own password route refused. Another site is left to
 * the generic rules (undefined).
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
 * Whether an authorized signup or password change may activate this control: its name is never matched to a
 * vocabulary of its own, only refused for a transaction on the page, purchase or subscription wording, unrelated
 * security, speaking or a link. The form's destination must stay on the site.
 */
export function classifyCredentialControlFacts(
  facts: ControlFacts,
  kind: CredentialKind,
  site: string,
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
  return 'ordinary';
}
