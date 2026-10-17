import type { ElementHandle, Page } from 'playwright-core';
import { getDomain } from 'tldts';
import { merchantSignatures } from './merchant-signatures.js';
import { SiteLeaseStore } from './leases.js';
import { documentGate } from './document-gate.js';
import { ensurePageTargets, onUncoveredPageTarget, pageTargetsReady } from './page-targets.js';
import type { BrowserExecutionContext } from './queue.js';
import {
  authenticationEndpoint,
  inspectAuthenticationControl,
  submitAuthenticationForm,
  type AuthenticationFormSignature,
  type CredentialKind,
  httpsOrigin,
} from './authentication-signatures.js';

export type ActivationClass =
  | 'ordinary'
  | 'purchase_control'
  | 'unsupported_merchant'
  | 'speaks_as_principal'
  | 'account_security'
  | 'blocked_address';
export interface ControlFacts {
  name: string;
  visibleLabel?: string;
  formMethod?: string;
  formAction?: string;
  authenticationForm?: boolean;
  role: string;
  tag: string;
  type: string;
  href: string | null;
  transaction: boolean;
  /** Prices, recurring charges, trials or billing anywhere on the page, read by the host. */
  moneyTerms?: boolean;
}
export interface ReviewedMerchantFlow {
  readonly id: string;
  matches(url: URL): boolean;
  classifyControl(page: Page, element: ElementHandle, facts: ControlFacts): Promise<ActivationClass>;
  classifyNavigation(url: URL): ActivationClass;
  verifyPurchaseControl?(page: Page, element: ElementHandle): Promise<boolean>;
}
const merchantFlows: ReviewedMerchantFlow[] = [...merchantSignatures];

/** Trusted source registrations only. Neither page prose nor stored recipes can register support. */
export function registerReviewedMerchantFlow(flow: ReviewedMerchantFlow): void {
  if (merchantFlows.some((existing) => existing.id === flow.id)) throw new Error('Merchant flow already registered');
  merchantFlows.push(flow);
}

const purchase =
  /\b(?:buy(?:\s+now)?|pay(?:\s+now)?|place\s+(?:your\s+)?order|confirm\s+(?:purchase|order|reservation|booking)|complete\s+(?:purchase|order|booking)|reserve\s+now|book\s+now|subscribe|start\s+(?:free\s+)?trial|donate|accept\s+(?:fee|charge))\b/iu;
const security =
  /\b(?:change|reset|delete|remove|update|manage)\s+(?:password|security|account|payment\s+method|credit\s+card)|\b(?:sign\s*out|log\s*out|delete\s+account)\b/iu;
const speaking =
  /\b(?:send\s+(?:message|email)|publish|post\s+(?:review|comment)|submit\s+(?:review|comment)|agree\s+on\s+behalf)\b/iu;
const unrelatedSecurity =
  /\b(?:change|update|add|remove|manage)\s+(?:sign.in email|email address|phone|two.factor|2fa|payment methods?)\b/iu;
const securityRoute =
  /\b(?:security|secure|auth|account)\s+(?:lock|report|reset|revoke)\b|\b(?:reset|revoke|lock)\s+(?:password|account|access|sessions?|tokens?)\b/iu;
const purchaseRoute =
  /\b(?:oneclick|one click|charge|checkout submit|confirmbooking|placeorder|purchase|subscribe|starttrial)\b/iu;
const ordinaryName =
  /^(?:search|find(?:\s+(?:a\s+)?(?:table|restaurant|time|availability))?|check\s+availability|view(?:\s+(?:details|menu|availability|more|results|cart|basket))?|show\s+more|load\s+more|learn\s+more|details|next|previous|back|close|cancel|dismiss|continue\s+(?:shopping|browsing)|add\s+to\s+(?:cart|basket)|sign\s*in|log\s*in|continue\s+with\s+email|send\s+(?:(?:sign.?in|verification|login|one.?time)\s+)?(?:code|link)|verify\s+(?:code|email)|submit\s+code|accept\s+(?:all\s+)?cookies|reject\s+(?:all\s+)?cookies|(?:cookie\s+)?preferences)$/iu;

export function classifyControlFacts(facts: ControlFacts): ActivationClass {
  const evidence = `${facts.name} ${facts.visibleLabel ?? ''}`;
  if (security.test(evidence) || unrelatedSecurity.test(evidence)) return 'account_security';
  if (
    speaking.test(evidence) ||
    /\b(?:write a review|message (?:the |a )?(?:restaurant|seller|host))\b/iu.test(evidence)
  )
    return 'speaks_as_principal';
  if (purchase.test(evidence)) return 'purchase_control';
  // Money/payment clues can stop work; their absence never proves an unknown control safe.
  if (facts.transaction) return 'unsupported_merchant';
  if (
    ['input', 'textarea'].includes(facts.tag) &&
    ['text', 'search', 'email', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', ''].includes(facts.type)
  )
    return 'ordinary';
  const readOnlyForm =
    facts.formMethod?.toLowerCase() === 'get' &&
    facts.formAction !== undefined &&
    /^https?:\/\/[^/]+\/(?:search|s|find|browse|availability)(?:[/?#]|$)/iu.test(facts.formAction) &&
    classifyNavigationUrl(facts.formAction) === 'ordinary';
  if (
    facts.tag === 'select' &&
    readOnlyForm &&
    /^(?:search|filter|sort|party(?: size)?|date|time|guests?|people|location|language|country|quantity)$/iu.test(
      facts.name.trim(),
    )
  )
    return 'ordinary';
  if (
    readOnlyForm &&
    ordinaryName.test(facts.name.trim()) &&
    (!facts.visibleLabel?.trim() || ordinaryName.test(facts.visibleLabel.trim()))
  )
    return 'ordinary';
  if (facts.tag === 'a' && facts.href) return classifyNavigationUrl(facts.href);
  return 'unsupported_merchant';
}

/** A navigation's path and action parameters as words, for the host's own route signatures. */
function navigationEvidence(url: URL): string | undefined {
  try {
    const actionParameters = [...url.searchParams]
      .map(([name, value]) => (/^(?:action|operation|intent|command|do)$/iu.test(name) ? `${name} ${value}` : name))
      .join(' ');
    return decodeURIComponent(`${url.pathname} ${actionParameters}`).replace(/[_/-]+/gu, ' ');
  } catch (_error) {
    return undefined;
  }
}

export function classifyNavigationUrl(raw: string): ActivationClass {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_error) {
    return 'blocked_address';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'blocked_address';
  const decoded = navigationEvidence(url);
  if (decoded === undefined) return 'blocked_address';
  if (security.test(decoded) || securityRoute.test(decoded)) return 'account_security';
  if (speaking.test(decoded)) return 'speaks_as_principal';
  const reviewed = merchantFlows.find((candidate) => candidate.matches(url));
  if (
    reviewed &&
    reviewed.classifyNavigation(url) === 'ordinary' &&
    ![...url.searchParams.keys()].some((name) => /^(?:action|operation|intent|command|do)$/iu.test(name))
  )
    return 'ordinary';
  if (purchase.test(decoded) || purchaseRoute.test(decoded)) return 'purchase_control';
  if (authenticationEndpoint(url)) return 'ordinary';
  const flow = merchantFlows.find((candidate) => candidate.matches(url));
  if (flow) return flow.classifyNavigation(url);
  if (
    url.pathname === '/' ||
    /^\/(?:search|s|find|browse|products?|items?|dp|gp\/product|restaurants?|r|venues?|availability|menu|articles?|news|blog|docs?|help|support|login|signin|sign-in|auth\/login|account\/login)(?:\/|$)/iu.test(
      url.pathname,
    )
  )
    return 'ordinary';
  return 'unsupported_merchant';
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
const moneyTerms =
  /(?:[$€£¥]\s?\d|\b\d+(?:[.,]\d{1,2})?\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b|\bper\s+(?:month|year|week|day)\b|\/\s?(?:mo|month|yr|year)\b|\b(?:subscriptions?|free\s+trial|trial\s+period|billing|billed|recurring|auto-?renew\w*|membership\s+fees?)\b)/iu;

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

function credentialSecurityClass(evidence: string, kind: CredentialKind): ActivationClass | undefined {
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
export function classifyCredentialNavigation(
  raw: string,
  kind: CredentialKind,
  site: string,
): ActivationClass | undefined {
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
): ActivationClass {
  const evidence = `${facts.name} ${facts.visibleLabel ?? ''}`;
  const refused = credentialSecurityClass(evidence, kind);
  if (refused) return refused;
  if (purchase.test(evidence)) return 'purchase_control';
  if (facts.transaction || facts.tag === 'a' || facts.href) return 'unsupported_merchant';
  if (facts.formAction) {
    const destination = classifyCredentialNavigation(facts.formAction, kind, site);
    if (destination !== 'ordinary') return destination ?? 'unsupported_merchant';
  }
  const fits = (name: string): boolean => {
    if (scope.step === 'verification') return kind === 'signup' && verificationActivation.test(name);
    if (credentialActivation[kind].test(name)) return true;
    return kind === 'signup' && scope.formControl === true && !facts.moneyTerms && agreeingSignup.test(name);
  };
  const names = [facts.name.trim(), facts.visibleLabel?.trim() ?? ''].filter(Boolean);
  return names.length > 0 && names.every(fits) ? 'ordinary' : 'unsupported_merchant';
}

export async function classifyCredentialActivation(
  page: Page,
  element: ElementHandle,
  kind: CredentialKind,
  site: string,
  scope: CredentialControlScope = {},
): Promise<ActivationClass> {
  return classifyCredentialControlFacts(await readControlFacts(page, element), kind, site, scope);
}

export async function readControlFacts(page: Page, element: ElementHandle): Promise<ControlFacts> {
  const facts = await element.evaluate((node): Omit<ControlFacts, 'transaction'> => {
    const e = node as unknown as {
      tagName: string;
      textContent: string | null;
      getAttribute(name: string): string | null;
      value?: string;
      labels?: ArrayLike<{ textContent: string | null }>;
      form?: { method: string; action: string; querySelector(selector: string): unknown };
    };
    return {
      name:
        e.getAttribute('aria-label') ||
        e.getAttribute('title') ||
        Array.from(e.labels ?? [])
          .map((label) => label.textContent ?? '')
          .join(' ') ||
        e.textContent?.trim() ||
        e.value ||
        '',
      visibleLabel: e.textContent?.trim() || '',
      formMethod: e.form?.method,
      formAction: e.form?.action,
      authenticationForm: Boolean(
        e.form &&
        e.form.method.toLowerCase() === 'post' &&
        /^(?:https:\/\/[^/]+)\/(?:login|signin|sign-in|auth|session|sessions|account\/login)(?:[/?#]|$)/iu.test(
          e.form.action,
        ) &&
        e.form.querySelector(
          'input[type="password"],input[autocomplete="one-time-code"],input[autocomplete="username"],input[type="email"]',
        ) &&
        !e.form.querySelector('input[autocomplete^="cc-"]'),
      ),
      role: e.getAttribute('role') || '',
      tag: e.tagName.toLowerCase(),
      type: e.getAttribute('type') || '',
      href: e.getAttribute('href'),
    };
  });
  const text = await page.locator('body').innerText({ timeout: 2_000 });
  const transaction =
    /(?:order\s+total|total\s+due|due\s+(?:now|today)|cancellation\s+fee|no.show\s+fee|per\s+month|subscription|free\s+trial)/iu.test(
      text,
    ) &&
    /(?:visa|mastercard|amex|payment\s+method|card\s+ending|credit\s+card|debit\s+card|charge|fee|deposit)/iu.test(
      text,
    );
  const frame = await element.ownerFrame();
  return {
    ...facts,
    href: facts.href ? new URL(facts.href, frame?.url() ?? page.url()).href : null,
    transaction,
    moneyTerms: moneyTerms.test(text),
  };
}

export async function classifyActivation(page: Page, element: ElementHandle): Promise<ActivationClass> {
  return (await activationDispatch(page, element)).classification;
}

async function activationDispatch(
  page: Page,
  element: ElementHandle,
): Promise<{
  classification: ActivationClass;
  flow?: ReviewedMerchantFlow;
  authentication?: AuthenticationFormSignature;
}> {
  const facts = await readControlFacts(page, element);
  const generic = classifyControlFacts(facts);
  const flow = merchantFlows.find((candidate) => candidate.matches(new URL(page.url())));
  // Explicit financial, speaking and security denials always outrank a site's sign-in claim.
  if (['purchase_control', 'account_security', 'speaks_as_principal', 'blocked_address'].includes(generic))
    return { classification: generic, flow };
  if (facts.formAction) {
    const destination = classifyNavigationUrl(facts.formAction);
    if (['purchase_control', 'account_security', 'speaks_as_principal', 'blocked_address'].includes(destination))
      return { classification: destination, flow };
  }
  if (flow) {
    const classification = await flow.classifyControl(page, element, facts);
    if (classification !== 'unsupported_merchant') return { classification, flow };
  }
  if (!facts.transaction && facts.formMethod?.toLowerCase() === 'post' && facts.formAction) {
    const authentication = await inspectAuthenticationControl(element);
    if (authentication) return { classification: 'ordinary', authentication };
  }
  return { classification: generic };
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
  const dispatch = await activationDispatch(page, element);
  const { classification } = dispatch;
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
    await guard.runWithPolicy(
      {
        classify(url) {
          const classification = classifyNavigationUrl(url.href);
          return classification === 'unsupported_merchant' &&
            url.origin === authentication.origin &&
            authenticationEndpoint(url)
            ? 'ordinary'
            : classification;
        },
      },
      async () => {
        const arrived = page
          .waitForEvent('framenavigated', { predicate: (frame) => frame === authentication.frame, timeout: 2_000 })
          .catch(() => undefined);
        if (!(await submitAuthenticationForm(authentication, intent.assertActive)))
          throw new BrowserActivationError('unsupported_merchant');
        await arrived;
      },
    );
    return;
  }
  const facts = await readControlFacts(page, element);
  if (facts.tag === 'input' || facts.tag === 'textarea') {
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
      const known = approved.flow.classifyNavigation(target);
      classification = known === 'purchase_control' ? 'ordinary' : known;
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
