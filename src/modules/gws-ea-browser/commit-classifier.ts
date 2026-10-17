import type { ElementHandle, Page } from 'playwright-core';
import { merchantSignatures } from './merchant-signatures.js';
import { SiteLeaseStore } from './leases.js';
import { coverPageTargets, onUncoveredPageTarget, pageTargetsReady } from './page-targets.js';
import type { BrowserExecutionContext } from './queue.js';
import {
  authenticationEndpoint,
  inspectAuthenticationControl,
  submitAuthenticationForm,
  type AuthenticationFormSignature,
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
const ordinaryName =
  /^(?:search|find(?:\s+(?:a\s+)?(?:table|restaurant|time|availability))?|check\s+availability|view(?:\s+(?:details|menu|availability|more|results|cart|basket))?|show\s+more|load\s+more|learn\s+more|details|next|previous|back|close|cancel|dismiss|continue\s+(?:shopping|browsing)|add\s+to\s+(?:cart|basket)|sign\s*in|log\s*in|continue\s+with\s+email|send\s+(?:(?:sign.?in|verification|login|one.?time)\s+)?(?:code|link)|verify\s+(?:code|email)|submit\s+code|accept\s+(?:all\s+)?cookies|reject\s+(?:all\s+)?cookies|(?:cookie\s+)?preferences)$/iu;

export function classifyControlFacts(facts: ControlFacts): ActivationClass {
  const evidence = `${facts.name} ${facts.visibleLabel ?? ''}`;
  if (
    security.test(evidence) ||
    /\b(?:change|update|add|remove|manage)\s+(?:sign.in email|email address|phone|two.factor|2fa|payment methods?)\b/iu.test(
      evidence,
    )
  )
    return 'account_security';
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

export function classifyNavigationUrl(raw: string): ActivationClass {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_error) {
    return 'blocked_address';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'blocked_address';
  let decoded: string;
  try {
    const actionParameters = [...url.searchParams]
      .map(([name, value]) => (/^(?:action|operation|intent|command|do)$/iu.test(name) ? `${name} ${value}` : name))
      .join(' ');
    decoded = decodeURIComponent(`${url.pathname} ${actionParameters}`).replace(/[_/-]+/gu, ' ');
  } catch (_error) {
    return 'blocked_address';
  }
  if (
    security.test(decoded) ||
    /\b(?:security|secure|auth|account)\s+(?:lock|report|reset|revoke)\b|\b(?:reset|revoke|lock)\s+(?:password|account|access|sessions?|tokens?)\b/iu.test(
      decoded,
    )
  )
    return 'account_security';
  if (speaking.test(decoded)) return 'speaks_as_principal';
  const reviewed = merchantFlows.find((candidate) => candidate.matches(url));
  if (
    reviewed &&
    reviewed.classifyNavigation(url) === 'ordinary' &&
    ![...url.searchParams.keys()].some((name) => /^(?:action|operation|intent|command|do)$/iu.test(name))
  )
    return 'ordinary';
  if (
    purchase.test(decoded) ||
    /\b(?:oneclick|one click|charge|checkout submit|confirmbooking|placeorder|purchase|subscribe|starttrial)\b/iu.test(
      decoded,
    )
  )
    return 'purchase_control';
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
  return { ...facts, href: facts.href ? new URL(facts.href, frame?.url() ?? page.url()).href : null, transaction };
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

/** The sole Fetch owner for a page and its out-of-process frames, kept installed until the page closes. */
export function ensureBrowserNavigationGuard(page: Page): Promise<BrowserNavigationGuard> {
  let guard = navigationGuards.get(page);
  if (!guard) {
    guard = installNavigationGuard(page);
    navigationGuards.set(page, guard);
  }
  return guard;
}

/** One paused request's class under the operation scopes that were current when it paused. */
async function decideNavigation(
  page: Page,
  url: string,
  resourceType: string,
  scopes: readonly BrowserNavigationPolicy[],
): Promise<ActivationClass | 'site_busy'> {
  let classification: ActivationClass | 'site_busy' =
    resourceType !== 'Document' ? 'ordinary' : scopes.length ? classifyNavigationUrl(url) : 'unsupported_merchant';
  const approved = approvedPresses.get(page);
  if (
    resourceType === 'Document' &&
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
  if (resourceType === 'Document')
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
  // Every covered target shares this handler, its policy stack and its block record.
  await coverPageTargets(page, async (session, target) => {
    session.on('Fetch.requestPaused', (event) => {
      const scopes = [...policies];
      const pausedIn = generation;
      void (async () => {
        let classification: ActivationClass | 'site_busy';
        try {
          classification = await decideNavigation(page, event.request.url, event.resourceType, scopes);
          // eslint-disable-next-line no-catch-all/no-catch-all -- A decision that cannot complete refuses its request.
        } catch (_error) {
          classification = 'blocked_address';
        }
        if (classification === 'ordinary' || event.request.url === 'about:blank') {
          const headers = scopes.some((policy) => policy.stripReferrer)
            ? Object.entries(event.request.headers)
                .filter(([name]) => !/^(?:referer|referrer)$/iu.test(name))
                .map(([name, value]) => ({ name, value: String(value) }))
            : undefined;
          await session
            .send('Fetch.continueRequest', { requestId: event.requestId, ...(headers ? { headers } : {}) })
            .catch(() =>
              session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }),
            );
        } else {
          if (pausedIn === generation) blocked = classification;
          await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
        }
      })().catch(() => {
        // Only a send fails here, once its request or its target is gone: nothing was let through.
      });
    });
    // The page session pauses every request, so a sign-in scope can strip any Referer. A frame session
    // pauses documents only: every other request is let through unchanged, and pausing each one would
    // cost the host a round trip per request from busy cross-site frames.
    await session.send('Fetch.enable', {
      patterns: [
        target === 'page' ? { requestStage: 'Request' } : { requestStage: 'Request', resourceType: 'Document' },
      ],
    });
  });
  page.once('close', () => {
    navigationGuards.delete(page);
  });
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
      try {
        // An operation can act only in frames that exist now, so every page-target setting covers each first.
        if (!(await pageTargetsReady(page))) {
          blocked = 'blocked_address';
          throw new BrowserFramesUnreadyError();
        }
        return await operation();
      } finally {
        const index = policies.lastIndexOf(scope);
        if (index !== -1) policies.splice(index, 1);
        if (outermost) ++generation;
      }
    },
  };
}

export type BrowserSiteAccess = (url: URL) => Promise<'ordinary' | 'site_busy' | 'blocked_address'>;

/** Use around every host browser executor; nested secret scopes share this same Fetch owner. */
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
