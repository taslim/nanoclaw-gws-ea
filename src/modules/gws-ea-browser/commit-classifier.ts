import { captureBrowserDiagnosticRefusal } from './diagnostics.js';
import type { CDPSession, ElementHandle, Frame, Page, Request } from 'playwright-core';
import { getDomain } from 'tldts';
import { SiteLeaseStore } from './leases.js';
import { documentGate, type CapturedHold, type HeldRequest, type PausedDocument } from './document-gate.js';
import { coverPageTargets, ensurePageTargets, onUncoveredPageTarget, pageTargetsReady } from './page-targets.js';
import { browserOperationId, type BrowserOperationContext } from './actions.js';
import {
  approvedPress,
  approvedPressOn,
  BrowserActivationError,
  consentBeforeSubmission,
  DEFAULT_ACTION_BUDGET_MS,
  withApprovedPress,
  type ApprovedPress,
} from './activation.js';
import { paymentProcessorHost, readPageControlFacts, type ControlFacts } from './control-facts.js';
import {
  classifyControlFacts,
  classifyNavigationUrl,
  pressesControl,
  reviewedMerchantFlow,
  type ActionClass,
  type ActivationKind,
  type ReviewedMerchantFlow,
} from './control-policy.js';
import type { ConsentScope } from './consent.js';
import {
  closeFreeDialog,
  currentFreeDialog,
  pressFreeCheckout,
  type FreePressAnswer,
  type FreePressScope,
} from './free-press.js';
import { readFreeCheckout } from './merchant-read.js';
import { pageFieldHoldsHostSecret } from './page-privacy.js';
import {
  holdRefusesDocument,
  holdRefusesRequest,
  readTexts,
  sentForms,
  type PlacedHold,
  type SubmissionSite,
} from './submission-hold.js';

/** `site_busy`: another job holds the site; `read_only`: a read-only replay's non-GET document. */
export type NavigationRefusal = Exclude<ActionClass, 'ordinary'> | 'site_busy' | 'read_only';
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
}> {
  const facts = await readPageControlFacts(page, element);
  const generic = classifyControlFacts(facts, kind);
  const flow = reviewedMerchantFlow(new URL(page.url()));
  // Every refusal of the open rule outranks a reviewed flow and a site's sign-in claim.
  if (generic !== 'ordinary') return { classification: generic, facts, flow };
  const reviewed = flow && (await flow.classifyControl(page, element, facts));
  if (reviewed) return { classification: reviewed, facts, flow };
  return { classification: 'ordinary', facts };
}

/** The guard refused to start an operation: a page-target setting cannot reach a live frame, so nothing ran. */
export class BrowserFramesUnreadyError extends BrowserActivationError {
  constructor() {
    super('blocked_address');
  }
}

/** An executor's stop when the guard refused to start its operation: repeat-safe, since nothing ran. */
export function framesUnreadyStop(error: unknown): import('./actions.js').BrowserBatchResult | undefined {
  return error instanceof BrowserFramesUnreadyError
    ? { status: 'stopped', reason: error.reason, repeat_safe: true }
    : undefined;
}

export interface PurchaseAuthorityPress {
  /** Runs immediately before the press: the last re-read and the commit marker. */
  commitStarted(): Promise<void>;
  /**
   * A generic checkout's origin, for a page no reviewed flow reads: its control must sit in a document of this
   * origin, and the press loads its own routes there.
   */
  readonly checkout?: { readonly origin: string };
}

export interface ActivationIntent {
  kind: ActivationKind;
  /** Consent stops and grants belong to this operation's job, never ambient page state. */
  scope?: ConsentScope;
  /** Facts and final policy decision already required for this activation; recording never re-reads the control. */
  onFacts?: (facts: ControlFacts, classification: ActionClass) => void;
  /** Host-only cancellation/deadline check, run by the consent pass and before a native authentication submit. */
  assertActive?: () => Promise<void>;
  /** Milliseconds left in the action's budget: its script-request window never outlasts it. */
  remaining?: () => number;
  /** A job that may press a free checkout itself; without one, every commit-class press is refused. */
  freePress?: FreePressScope;
}

export interface ActivationResult {
  /** An ordinary press ran, which may have bought something nobody approved. */
  readonly ordinaryPress: boolean;
  /** The commit-class press was a free checkout's, or a repeat of the one this job already pressed. */
  readonly freePress?: FreePressAnswer;
}

/**
 * The one boundary every activation passes. A fresh classification decides it: an approved purchase's press
 * runs only on a control its approval covers, a commit-class press on a checkout that charges nothing is pressed as
 * a free one, anything else commit-class is refused, and anything ordinary runs as `operation`, the native action
 * on the element, with Playwright's hit-target check kept. Before anything that can submit a form, the consent pass
 * makes every choice the consent engine owns; during an ordinary action, the page's non-GET script requests to
 * payment processors and purchase routes are refused.
 */
export async function activateControl(
  page: Page,
  element: ElementHandle,
  operation: () => Promise<void>,
  authority?: PurchaseAuthorityPress,
  intent: ActivationIntent = { kind: 'click' },
): Promise<ActivationResult> {
  // An approved press makes the very payment requests an ordinary action's window refuses: it is read and
  // pressed only once every such window on the page has closed.
  if (authority) await (await ensureBrowserNavigationGuard(page)).actionsSettled();
  const recordRefusal = captureBrowserDiagnosticRefusal(page);
  const dispatch = await activationDispatch(page, element, intent.kind);
  const { classification, facts } = dispatch;
  try {
    intent.onFacts?.(structuredClone(facts), classification);
  } catch {
    // An optional evidence projection cannot veto this required policy decision or operation.
  }
  if (authority) {
    // An approval covers a commit's press: a control that no longer reads as one, or that its approval does not
    // cover, is refused before the commit marker, never pressed another way.
    if (classification !== 'purchase_control')
      throw new BrowserActivationError(classification === 'ordinary' ? 'purchase_control' : classification);
    const approved = await approvedPress(page, element, dispatch.flow, authority.checkout);
    if (!approved) throw new BrowserActivationError('purchase_control');
    await authority.commitStarted();
    // A press after an approved one is ordinary: no free dialog's admission carries past it.
    closeFreeDialog(page);
    await withApprovedPress(page, approved, operation);
    return { ordinaryPress: false };
  }
  const pressed = pressesControl(facts, intent.kind);
  // A commit-class press on a checkout that charges nothing is the host's own ordinary press of it.
  if (classification === 'purchase_control' && pressed && intent.freePress) {
    const checkout = await readFreeCheckout(page, element);
    if (checkout) {
      const freePress = await pressFreeCheckout(
        page,
        await ensureBrowserNavigationGuard(page),
        element,
        operation,
        checkout,
        {
          ...intent,
          freePress: intent.freePress,
        },
      );
      return { ordinaryPress: freePress.status === 'pressed', freePress };
    }
  }
  if (classification !== 'ordinary') {
    recordRefusal('action', undefined, classification);
    throw new BrowserActivationError(classification);
  }
  // Anything that can submit a form: a press, or a choice inside one, which page script may submit on change.
  if (pressed || (facts.formAction !== undefined && (intent.kind === 'select' || facts.toggles !== undefined))) {
    // A script-driven group submits without a form, so a held value refuses every press, not only its own form's.
    if (await pageFieldHoldsHostSecret(page)) throw new BrowserActivationError('secret_field');
    await consentBeforeSubmission(page, element, intent);
  }
  const guard = await ensureBrowserNavigationGuard(page);
  await guard.duringAction(intent.remaining?.() ?? DEFAULT_ACTION_BUDGET_MS, operation);
  return { ordinaryPress: pressed };
}

export type NavigationDocument = Pick<PausedDocument, 'method' | 'topLevel'>;

export interface BrowserNavigationPolicy {
  /**
   * A complete classification that replaces the generic one, even where that refuses; undefined leaves the
   * generic rules. Only an authorized credential operation installs one, for its activation.
   */
  decide?(url: URL): ActionClass | undefined;
  /**
   * A refusal here replaces the generic class; `ordinary` replaces only an approved press's refusal of a route its
   * flow does not know.
   */
  classify?(url: URL): ActionClass;
  stripReferrer?: boolean;
  /** Every document the scope loads must be a GET, or it is refused as `read_only`. */
  readOnly?: boolean;
  /** The site the scope's job leased for the page's current document as the scope began. */
  leasedSite?: string;
  /** Runs for each document the rules call ordinary, the page's own top-level one or a frame's. */
  beforeNavigate?(url: URL, document: NavigationDocument): Promise<'ordinary' | 'site_busy' | 'blocked_address'>;
}
export interface BrowserNavigationGuard {
  reason(): NavigationRefusal | undefined;
  clearReason(): void;
  /**
   * Refuses the page's HTTP requests and documents, its frames' and windows' included, until this authority allows
   * them, so a page's input handlers cannot submit a filled credential. With `onSite`, the hold refuses only a
   * document that is not a GET and leaves that site, and any other request to another site whose address or body
   * carries a filled value, so the site's own sign-in, its captcha, its reads and its telemetry go ahead.
   */
  holdSubmissions(authority: string, onSite?: SubmissionSite): void;
  /** Lifts only this authority's hold; another authority's keeps refusing. */
  allowSubmissions(authority: string): void;
  runWithPolicy<T>(policy: BrowserNavigationPolicy, operation: () => Promise<T>): Promise<T>;
  /**
   * Runs one ordinary action inside its script-request window: from the action's start, through a short settle,
   * until any navigation it started commits, capped by `budgetMs`. Inside the window, the page's and every
   * out-of-process frame's non-GET fetch, XHR and beacon requests to payment processors and purchase routes are
   * refused; outside it nothing is paused. The caller goes on once every navigation the action started has
   * committed and, unless the page's own document was replaced, its requests have gone quiet or the settle has
   * ended; the rest of the window runs on in the background. `waitForRequests` lets credential callers wait
   * for pending requests past that short settle, still bounded by the action deadline. `purchaseAdmission` admits
   * the purchase routes of its own checkout, as a free checkout's press and the dialog it opened do; a payment
   * processor stays refused.
   */
  duringAction<T>(
    budgetMs: number,
    action: () => Promise<T>,
    options?: { readonly waitForRequests?: boolean; readonly purchaseAdmission?: ApprovedPress },
  ): Promise<T>;
  /** Resolves once every ordinary action's script-request window on the page has closed. */
  actionsSettled(): Promise<void>;
}
const navigationGuards = new WeakMap<Page, Promise<BrowserNavigationGuard>>();

/** One guard per page, deciding its documents at the browser's document gate until the page closes. */
export function ensureBrowserNavigationGuard(page: Page): Promise<BrowserNavigationGuard> {
  let guard = navigationGuards.get(page);
  if (!guard) {
    guard = installNavigationGuard(page);
    navigationGuards.set(page, guard);
  }
  return guard;
}

/** The registrable domain an address belongs to, or undefined for anything but a public HTTP(S) address. */
export function registrableSite(raw: string): string | undefined {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) return undefined;
  return getDomain(url.hostname, { allowPrivateDomains: true }) ?? undefined;
}

/**
 * A document no operation asked for: page script acting between operations. It loads only when it is a GET the
 * open rule calls ordinary, on the site the job's lease admitted the page to; a frame's document, or a window's,
 * is judged by its page's site. Anything else is refused, and the next operation navigates again.
 */
function decideIdleDocument(
  url: string,
  document: NavigationDocument,
  pageUrl: string,
  leasedSite: string | undefined,
): ActionClass {
  const classification = classifyNavigationUrl(url);
  if (classification !== 'ordinary') return classification;
  const site = registrableSite(document.topLevel ? url : pageUrl);
  return document.method === 'GET' && site !== undefined && site === leasedSite ? 'ordinary' : 'blocked_address';
}

/**
 * One paused document's class under the scopes and approved press that were current when it paused. A
 * document no operation and no approved press asked for takes the `idle` rule.
 */
async function decideNavigation(
  url: string,
  document: NavigationDocument,
  scopes: readonly BrowserNavigationPolicy[],
  approved: ApprovedPress | undefined,
  idle: () => ActionClass,
): Promise<ActionClass | 'site_busy' | 'read_only'> {
  let classification: ActionClass = classifyNavigationUrl(url);
  const target = URL.canParse(url) ? new URL(url) : undefined;
  // Whether the approved press refused a route its flow does not know: a sign-in scope's own reading replaces it.
  let pressRefused = false;
  if (
    approved &&
    target &&
    classification !== 'blocked_address' &&
    classification !== 'account_security' &&
    classification !== 'speaks_as_principal' &&
    target.origin === approved.origin &&
    approved.matches(target)
  ) {
    // During its approved press the flow's own purchase route is ordinary; a route it does not know is refused.
    const known = approved.classify(target);
    classification = known === 'purchase_control' ? 'ordinary' : (known ?? 'purchase_control');
    pressRefused = known === undefined;
  } else if (!scopes.length) classification = idle();
  for (const policy of scopes) {
    let decided: ActionClass | undefined;
    try {
      decided = policy.decide?.(new URL(url));
      // eslint-disable-next-line no-catch-all/no-catch-all -- a scope that cannot classify a document blocks it
    } catch (_error) {
      decided = 'blocked_address';
    }
    if (decided) classification = decided;
  }
  for (const policy of scopes) {
    if (!policy.classify) continue;
    let scoped: ActionClass;
    try {
      scoped = policy.classify(new URL(url));
    } catch (_error) {
      scoped = 'blocked_address';
    }
    if (scoped !== 'ordinary' || pressRefused) classification = scoped;
  }
  if (classification !== 'ordinary') return classification;
  if (document.method !== 'GET' && scopes.some((policy) => policy.readOnly)) return 'read_only';
  let admitted: 'ordinary' | 'site_busy' | 'blocked_address' = 'ordinary';
  for (const policy of scopes)
    if (admitted === 'ordinary' && policy.beforeNavigate)
      admitted = await policy.beforeNavigate(new URL(url), document);
  return admitted;
}

/** The site a held value may go to by this address: its registrable domain over HTTPS, else none. */
function heldSiteOf(url: string): string | undefined {
  return URL.canParse(url) && new URL(url).protocol === 'https:' ? registrableSite(url) : undefined;
}

/** What page script sends, a beacon (`Ping`) included. */
const SCRIPT_REQUEST_TYPES = ['XHR', 'Fetch', 'Ping'] as const;
/** How long an action's window stays open after it: enough for a handler that awaits one round trip, then posts. */
const ACTION_SETTLE_MS = 1_000;
/**
 * How long the page must stay quiet before the action's caller goes on: after the action, and after each request
 * the action set off. A native submit or a link navigates at once, and page script that submits by fetch navigates
 * as its response returns. A page that keeps sending holds the caller only until the settle ends; a navigation
 * that begins after the caller went on is still inside the window.
 */
const NAVIGATION_START_MS = 250;
const NAVIGATION_POLL_MS = 50;

/** A payment processor is always refused; a purchase route only where no admission covers it as its own. */
export function refusedScriptRequest(
  request: { method: string; url: string },
  admissions: Iterable<ApprovedPress> = [],
): boolean {
  if (request.method.toUpperCase() === 'GET') return false;
  if (!URL.canParse(request.url)) return true;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (paymentProcessorHost(host)) return true;
  if (classifyNavigationUrl(url.href) !== 'purchase_control') return false;
  for (const admission of admissions)
    if (admission.matches(url) && admission.classify(url) === 'purchase_control') return false;
  return true;
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
  let blocked: NavigationRefusal | undefined;
  const policies: BrowserNavigationPolicy[] = [];
  const submissionHolds = new Map<string, PlacedHold | undefined>();
  // Each outermost operation, and each span between them, is its own generation. A decision is
  // reported only to the generation its request paused in; a late one is still enforced, not reported.
  let generation = 0;
  // The site the job's lease admitted the page's top-level document to: what a document between operations is judged by.
  let leasedSite: string | undefined;
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
      const recordRefusal = captureBrowserDiagnosticRefusal(page);
      const scopes = [...policies];
      const holds = [...submissionHolds.values()];
      // Inside an operation, a free press's dialog admits its checkout origin's routes as the press did.
      const approved = approvedPressOn(page) ?? (scopes.length ? currentFreeDialog(page)?.admission : undefined);
      const pausedIn = generation;
      // A document between operations is judged by the page as it stood when the document paused.
      const pageUrl = page.url();
      const leased = leasedSite;
      const record = (classification: NavigationRefusal): void => {
        if (pausedIn === generation) blocked = classification;
      };
      // A hold without a site refuses everything quietly; one with a site records what tried to leave it. The gate
      // asks about one request more than once, so each request's verdict is reached once.
      const verdicts = new WeakMap<HeldRequest, { readonly refused: boolean; readonly sited: boolean }>();
      const verdict = (request: HeldRequest): { readonly refused: boolean; readonly sited: boolean } => {
        let known = verdicts.get(request);
        if (!known) {
          const site = heldSiteOf(request.url);
          let read: readonly string[] | undefined;
          const texts = (): readonly string[] => (read ??= readTexts([request.url, request.body ?? '']));
          const refusing = holds.filter((held) => holdRefusesRequest(held, request, site, texts));
          known = { refused: refusing.length > 0, sited: refusing.some((held) => held !== undefined) };
          verdicts.set(request, known);
        }
        return known;
      };
      const hold: CapturedHold | undefined = holds.length
        ? {
            refuses: (request) => verdict(request).refused,
            refused(request, resource) {
              if (!verdict(request).sited) return;
              recordRefusal('action', { url: request.url, method: request.method, resource }, 'origin_mismatch');
            },
          }
        : undefined;
      return {
        ...(hold ? { hold } : {}),
        async decide(document) {
          const site = heldSiteOf(document.url);
          const refusing = holds.filter((held) => holdRefusesDocument(held, document, site));
          if (refusing.length) {
            const sited = refusing.filter((held): held is PlacedHold => held !== undefined);
            if (sited.length) {
              for (const held of sited) held.onSite.departed?.();
              record('blocked_address');
              recordRefusal(
                'document',
                { url: document.url, method: document.method, resource: 'document' },
                'origin_mismatch',
              );
            }
            return { allow: false };
          }
          let classification: ActionClass | 'site_busy' | 'read_only';
          try {
            classification = await decideNavigation(document.url, document, scopes, approved, () =>
              decideIdleDocument(document.url, document, pageUrl, leased),
            );
            // eslint-disable-next-line no-catch-all/no-catch-all -- A decision that cannot complete refuses its request.
          } catch (_error) {
            classification = 'blocked_address';
          }
          if (classification === 'ordinary' || document.url === 'about:blank') {
            // An operation's top-level document was admitted by its job's lease.
            if (classification === 'ordinary' && scopes.length && document.topLevel)
              leasedSite = registrableSite(document.url) ?? leasedSite;
            return scopes.some((policy) => policy.stripReferrer)
              ? { allow: true, headers: withoutReferrer(document.headers) }
              : { allow: true };
          }
          record(classification);
          recordRefusal(
            'document',
            { url: document.url, method: document.method, resource: 'document' },
            classification,
          );
          return { allow: false };
        },
        refuse: () => {
          record('blocked_address');
          recordRefusal('document', undefined, 'blocked_address');
        },
      };
    },
  });
  // Script requests during an ordinary action, on the page and on every out-of-process frame, since a payment
  // frame sends its own. Their sessions are set up on the first action; outside every action's window nothing
  // pauses. Credential holds instead use the browser-level gate, which covers a new target's first request.
  const scriptSessions = new Set<CDPSession>();
  let actions = 0;
  // The checkouts whose own purchase routes the open windows admit, each counted by the windows admitting it.
  const admissions = new Map<ApprovedPress, number>();
  let covering: Promise<void> | undefined;
  // Each window that outlasts its action's return: the rest of its settle, then its cleanup.
  const settling = new Set<Promise<void>>();
  /** A closed page ends every wait. */
  const waitWhile = async (open: () => boolean, until: number): Promise<void> => {
    while (open() && !page.isClosed() && Date.now() < until)
      await sleep(Math.min(NAVIGATION_POLL_MS, until - Date.now()));
  };
  const pauseScripts = (session: CDPSession): Promise<unknown> =>
    session.send('Fetch.enable', {
      patterns: SCRIPT_REQUEST_TYPES.map((resourceType) => ({ requestStage: 'Request' as const, resourceType })),
    });
  const coverScripts = (): Promise<void> => {
    covering ??= coverPageTargets(page, async (session) => {
      session.on('Fetch.requestPaused', (event) => {
        const refused = refusedScriptRequest(event.request, admissions.keys());
        if (refused)
          captureBrowserDiagnosticRefusal(page)(
            'action',
            { url: event.request.url, method: event.request.method, resource: event.resourceType.toLowerCase() },
            'purchase_control',
          );
        const answered = refused
          ? session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
          : session.send('Fetch.continueRequest', { requestId: event.requestId });
        void answered.catch(() => undefined);
      });
      session.once('close', () => scriptSessions.delete(session));
      scriptSessions.add(session);
      // A frame that appears during an action is checked from its setup on.
      if (actions > 0) await pauseScripts(session);
    }).catch((error: unknown) => {
      covering = undefined;
      throw error;
    });
    return covering;
  };
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
    holdSubmissions(authority, onSite) {
      submissionHolds.set(authority, onSite && { onSite, forms: sentForms(onSite.values) });
    },
    allowSubmissions(authority) {
      submissionHolds.delete(authority);
    },
    async runWithPolicy(scope, operation) {
      const outermost = !policies.length;
      if (outermost) {
        // A new operation starts clean, before readiness can report a frame it could not reach.
        blocked = undefined;
        ++generation;
      }
      if (scope.leasedSite !== undefined) leasedSite = scope.leasedSite;
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
    async duringAction(budgetMs, action, options) {
      const deadline = Date.now() + budgetMs;
      await coverScripts();
      const admission = options?.purchaseAdmission ?? currentFreeDialog(page)?.admission;
      if (admission) admissions.set(admission, (admissions.get(admission) ?? 0) + 1);
      const unadmit = (): void => {
        if (!admission) return;
        const count = (admissions.get(admission) ?? 1) - 1;
        if (count > 0) admissions.set(admission, count);
        else admissions.delete(admission);
      };
      // The navigations the action starts, until each commits or ends.
      const navigations = new Set<Request>();
      // Every request it sets off, a frame's included, until each finishes or fails; and when the last one did.
      const requests = new Set<Request>();
      let lastEnded = 0;
      // Whether a navigation it started replaced the page's own document.
      let replaced = false;
      const started = (request: Request): void => {
        requests.add(request);
        if (request.isNavigationRequest()) navigations.add(request);
      };
      const ended = (request: Request): void => {
        navigations.delete(request);
        if (requests.delete(request)) lastEnded = Date.now();
      };
      const committed = (frame: Frame): void => {
        for (const request of navigations)
          if (request.frame() === frame) {
            navigations.delete(request);
            if (frame === page.mainFrame()) replaced = true;
          }
      };
      page.on('request', started);
      page.on('requestfailed', ended);
      page.on('requestfinished', ended);
      page.on('framenavigated', committed);
      // A session that cannot take the setting is closing with its target.
      if (actions++ === 0)
        await Promise.all([...scriptSessions].map((session) => pauseScripts(session).catch(() => undefined)));
      const close = async (): Promise<void> => {
        unadmit();
        page.off('request', started);
        page.off('requestfailed', ended);
        page.off('requestfinished', ended);
        page.off('framenavigated', committed);
        if (--actions === 0)
          await Promise.all([...scriptSessions].map((session) => session.send('Fetch.disable').catch(() => undefined)));
      };
      let result: Awaited<ReturnType<typeof action>>;
      try {
        result = await action();
      } catch (error) {
        await close();
        throw error;
      }
      const done = Date.now();
      // Credential cleanup waits for a handler's pending token requests, bounded by this action's deadline.
      const pending = (): boolean => options?.waitForRequests === true && !replaced && requests.size > 0;
      // The caller goes on once every navigation the action started has committed or ended, and the page's
      // document was replaced or the action's requests have stayed quiet for a moment, at most until the settle ends.
      const busy = (): boolean =>
        !replaced &&
        (pending() ||
          (Date.now() < done + ACTION_SETTLE_MS &&
            (requests.size > 0 || Date.now() < Math.max(done, lastEnded) + NAVIGATION_START_MS)));
      await waitWhile(() => navigations.size > 0 || busy(), deadline);
      // The window itself stays open through the settle and until each navigation it saw commits or ends; an
      // action that starts meanwhile keeps the requests paused without a gap.
      const rest: Promise<void> = waitWhile(
        () => navigations.size > 0 || pending() || Date.now() < done + ACTION_SETTLE_MS,
        deadline,
      )
        .then(close)
        .catch(() => undefined)
        .finally(() => settling.delete(rest));
      settling.add(rest);
      return result;
    },
    async actionsSettled() {
      while (settling.size) await Promise.all(settling);
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type BrowserSiteAccess = (url: URL) => Promise<'ordinary' | 'site_busy' | 'blocked_address'>;

export interface BrowserJobAccess {
  /** A signed-out replay's own site access, in place of the job's site leases. */
  readonly siteAccess?: BrowserSiteAccess;
  readonly readOnly?: boolean;
}

/**
 * Use around every host browser executor; nested secret scopes share this same page guard. The job leases each
 * top-level document's site; a frame's document is classified, but never takes or waits on a lease.
 */
export async function withBrowserJobNavigation<T>(
  context: BrowserOperationContext,
  page: Page,
  operation: () => Promise<T>,
  access: BrowserJobAccess = {},
): Promise<T> {
  const { siteAccess, readOnly } = access;
  const guard = await ensureBrowserNavigationGuard(page);
  const leases = new SiteLeaseStore(context.store.db);
  let leasedSite: string | undefined;
  if (/^https?:/u.test(page.url())) {
    const lease = siteAccess
      ? { acquired: (await siteAccess(new URL(page.url()))) === 'ordinary', waitingJobs: [] }
      : await leases.acquire(context.job.id, page.url());
    await context.wakeWaiters(lease.waitingJobs, `${browserOperationId(context)}:lease-release`);
    if (!lease.acquired) {
      // A regular activation exception carries the same closed vocabulary as a tool stop.
      throw new BrowserSiteBusyError();
    }
    leasedSite = registrableSite(page.url());
  }
  return guard.runWithPolicy(
    {
      ...(readOnly ? { readOnly } : {}),
      ...(leasedSite !== undefined ? { leasedSite } : {}),
      async beforeNavigate(url, document) {
        await context.assertActive();
        if (!document.topLevel) return 'ordinary';
        if (siteAccess) return siteAccess(url);
        const lease = await leases.acquire(context.job.id, url.href);
        await context.wakeWaiters(lease.waitingJobs, `${browserOperationId(context)}:redirect-release`);
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
