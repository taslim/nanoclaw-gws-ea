import { classifyControlFacts, classifyNavigationUrl } from './control-policy.js';
import { beginBrowserDiagnosticAction, captureBrowserDiagnosticRefusal } from './diagnostics.js';
import path from 'node:path';
import { errors, type Page } from 'playwright-core';

import { invalidArgs } from '../../cli/delivery-action.js';
import { sessionDir } from '../../session-manager.js';
import { isRecord } from '../../gws-ea/validation.js';
import {
  activateControl,
  BrowserActivationError,
  BrowserSiteBusyError,
  ensureBrowserNavigationGuard,
  framesUnreadyStop,
  registrableSite,
  withBrowserJobNavigation,
  type ActivationIntent,
  type BrowserNavigationGuard,
} from './commit-classifier.js';
import { readConfirmations, showsCharge, type ConfirmationEvidence } from './confirmation.js';
import { BrowserConsentStop, consentStopsForAgent, type ConsentStopView } from './consent.js';
import { settleCookieBanners } from './cookie-banners.js';
import { addressFields, personalDataStop } from './disclosures.js';
import { captureBrowserDownload, stageBrowserUpload, retainBrowserUpload } from './files.js';
import type { PurchaseFacts } from './fingerprint.js';
import { stopForUnapprovedCommit, type UnapprovedCommit } from './incidents.js';
import { SiteLeaseStore } from './leases.js';
import {
  BrowserRefError,
  browserStructureFacts,
  disposeBrowserRefs,
  observePage,
  pinBrowserRefs,
  readBrowserRef,
  hasBrowserChallenge,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import { pageMayShowSecret } from './page-privacy.js';
import { readHostBrowserPolicy } from './access.js';
import { browserOperationId, type BrowserOperationContext, type BrowserQueuedAction } from './actions.js';
import {
  reserveBrowserActionTrace,
  withinBrowserRecordingBudget,
  type BrowserActionTrace,
  type BrowserRecipeStep,
} from './recording.js';
import {
  isReadOnlyBrowserAction,
  browserKeyboardSubmitTarget,
  prepareBrowserActionFacts,
  enrichBrowserActionFacts,
  type BrowserActionControl,
} from './action-targets.js';
import {
  BrowserExecutionError,
  browserActionRefs,
  type BrowserAction,
  type BrowserActionData,
  type BrowserStopReason,
  type BrowserActionResult,
  type BrowserBatchResult,
  type BrowserBatchOptions,
  type BrowserBatch,
} from './actions.js';
import { ControlFactsUnavailableError, readPageControlFacts, type ControlFacts } from './control-facts.js';
import { givenAddressStop } from './web-address.js';
import { BrowserLocatorError, resolveLocator } from './locators.js';

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidArgs('Each browser action must be an object.');
  return value;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidArgs('Unknown browser action field.');
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw invalidArgs(`${name} must be text.`);
  return value;
}
function ref(value: Record<string, unknown>): BrowserRef {
  return readBrowserRef(
    { ref: value.ref, generation: value.generation },
    'A browser ref needs ref and its snapshot generation.',
  );
}
function safeKey(value: unknown): string {
  const key = text(value, 'key');
  if (
    !/^(?:(?:Shift\+)?(?:Enter|Space|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)|(?:Control|Meta)\+[aA])$/u.test(
      key,
    )
  )
    throw invalidArgs('This keyboard action is not allowed; clipboard shortcuts are refused.');
  return key;
}

export function validateBrowserBatch(content: Record<string, unknown>): BrowserBatch & Record<string, unknown> {
  keys(content, ['action', 'requestId', 'actions', 'budget_ms']);
  if (!Array.isArray(content.actions) || content.actions.length === 0)
    throw invalidArgs('actions must be a nonempty ordered list.');
  const actions = content.actions.map((raw): BrowserAction => {
    const value = record(raw);
    const kind = text(value.kind, 'kind');
    switch (kind) {
      case 'navigate':
        keys(value, ['kind', 'url']);
        return { kind, url: text(value.url, 'url') };
      case 'observe':
      case 'screenshot':
        keys(value, ['kind']);
        return { kind };
      case 'click':
      case 'download':
        keys(value, ['kind', 'ref', 'generation']);
        return { kind, ...ref(value) };
      case 'type':
        keys(value, ['kind', 'ref', 'generation', 'text']);
        return { kind, ...ref(value), text: text(value.text, 'text') };
      case 'select':
        keys(value, ['kind', 'ref', 'generation', 'value']);
        return { kind, ...ref(value), value: text(value.value, 'value') };
      case 'key':
        keys(value, ['kind', 'ref', 'generation', 'key']);
        return { kind, ...ref(value), key: safeKey(value.key) };
      case 'upload':
        keys(value, ['kind', 'ref', 'generation', 'path']);
        return { kind, ...ref(value), path: text(value.path, 'path') };
      case 'scroll': {
        keys(value, ['kind', 'direction', 'amount']);
        if (
          typeof value.direction !== 'string' ||
          !['up', 'down', 'left', 'right'].includes(value.direction) ||
          (value.amount !== undefined &&
            (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount <= 0))
        )
          throw invalidArgs('scroll needs a direction and a positive amount.');
        return {
          kind,
          direction: value.direction as 'up' | 'down' | 'left' | 'right',
          ...(value.amount !== undefined ? { amount: Number(value.amount) } : {}),
        };
      }
      case 'wait_for': {
        keys(value, ['kind', 'text', 'timeout_ms']);
        if (value.text !== undefined && typeof value.text !== 'string')
          throw invalidArgs('wait_for text must be text.');
        if (
          value.timeout_ms !== undefined &&
          (typeof value.timeout_ms !== 'number' || !Number.isInteger(value.timeout_ms) || value.timeout_ms < 1)
        )
          throw invalidArgs('wait_for timeout_ms must be positive.');
        return {
          kind,
          ...(value.text !== undefined ? { text: String(value.text) } : {}),
          ...(value.timeout_ms !== undefined ? { timeout_ms: Number(value.timeout_ms) } : {}),
        };
      }
      case 'form_input': {
        keys(value, ['kind', 'fields', 'submit']);
        if (!Array.isArray(value.fields) || !value.fields.length)
          throw invalidArgs('form_input fields must be nonempty.');
        const fields = value.fields.map((rawField) => {
          const field = record(rawField);
          keys(field, ['ref', 'generation', 'value']);
          return { ...ref(field), value: text(field.value, 'value') };
        });
        let submit: BrowserRef | undefined;
        if (value.submit !== undefined) {
          const target = record(value.submit);
          keys(target, ['ref', 'generation']);
          submit = ref(target);
        }
        return { kind, fields, ...(submit ? { submit } : {}) };
      }
      default:
        throw invalidArgs('Unknown browser action kind. JavaScript and field reads are unavailable.');
    }
  });
  return { actions };
}

/** The ordinary text an action gives a site: what it types or selects, and an address it opens, query decoded. */
function givenText(action: BrowserAction): string[] {
  if (action.kind === 'type') return [action.text];
  if (action.kind === 'select') return [action.value];
  if (action.kind === 'navigate') return addressFields(action.url);
  return action.kind === 'form_input' ? action.fields.map((field) => field.value) : [];
}

/** Payment details are never entered (R12); passwords and codes only through the host's own fills. */
async function refuseFieldEntry(page: Page, target: PinnedBrowserRef): Promise<ControlFacts> {
  const facts = await readPageControlFacts(page, target.element);
  if (facts.cardEntry === true) throw new BrowserBatchStop('card_field');
  if (facts.secretEntry) throw new BrowserBatchStop('secret_field');
  return facts;
}

/**
 * Types each value into its field, in order. Page script may submit or post as a field changes, so the fills run
 * inside one script-request window, as a press does (KTD2). Typing presses nothing: no confirmation check follows.
 */
async function fieldInput(
  context: BrowserOperationContext,
  guard: BrowserNavigationGuard,
  fields: ReadonlyArray<{ readonly target: PinnedBrowserRef; readonly value: string }>,
): Promise<void> {
  await context.assertActive();
  await guard.duringAction(context.remaining(), async () => {
    for (const { target, value } of fields) {
      await context.assertActive();
      await target.element.fill(value, { timeout: context.remaining() });
    }
  });
}

class BrowserBatchStop extends Error {
  constructor(readonly reason: BrowserStopReason) {
    super(reason);
  }
}

/** An ordinary press landed on a confirmation that shows a charge: it bought something nobody approved (KTD10). */
class UnapprovedCommitStop extends BrowserBatchStop {
  constructor(readonly commit: UnapprovedCommit) {
    super('unapproved_commit');
  }
}

/** How long Playwright retries an action's checks, the hit-target check included, before the control is not actionable. */
const ACTIONABLE_WAIT_MS = 5_000;
/** How long a press's resulting document may take to parse before its confirmation check reads it. */
const CONFIRMATION_LOAD_MS = 5_000;

/**
 * A native action on its element (KTD1): never forced or dispatched, so a control another element covers is
 * not pressed through its cover. It never waits on a navigation it starts; the action's window does.
 */
async function nativeAction(
  context: BrowserOperationContext,
  act: (options: { timeout: number; noWaitAfter: true }) => Promise<void>,
): Promise<void> {
  await context.assertActive();
  try {
    await act({ timeout: Math.min(ACTIONABLE_WAIT_MS, context.remaining()), noWaitAfter: true });
  } catch (error) {
    // With no wait after it, an action that timed out never ran: its control stayed covered, hidden or disabled.
    if (error instanceof errors.TimeoutError && context.remaining() > 0 && !context.signal.aborted)
      throw new BrowserBatchStop('not_actionable');
    throw error;
  }
}

/** A field's Enter submits its form; Space presses the control it is on. */
const ENTER_KEY = /^(?:Shift\+)?Enter$/u;
const SPACE_KEY = /^(?:Shift\+)?Space$/u;

/** Whether an action may run an ordinary press, whose result the confirmation check reads (KTD10). */
function mayPress(action: BrowserAction): boolean {
  if (action.kind === 'click') return true;
  if (action.kind === 'key') return ENTER_KEY.test(action.key) || SPACE_KEY.test(action.key);
  return action.kind === 'form_input' && action.submit !== undefined;
}

/**
 * The same order confirmed for the same charge, whichever document or path shows it: an order's page and its
 * receipt or tracking page show one order.
 */
function sameConfirmation(left: ConfirmationEvidence, right: ConfirmationEvidence): boolean {
  return (
    left.reference === right.reference &&
    left.charged?.amountMinor === right.charged?.amountMinor &&
    left.charged?.currency === right.charged?.currency
  );
}

/**
 * Whether `evidence` is the merchant's record of a purchase this job placed under an approval, confirmed for no
 * more than the approved total (KTD8): the same order number for more is something added to that order. A free
 * commit was approved for nothing, so a charge on its record is never its own.
 */
async function placedByJob(context: BrowserOperationContext, evidence: ConfirmationEvidence): Promise<boolean> {
  const { charged } = evidence;
  if (!charged) return false;
  const approved = await context.store.db.all<{ facts_json: string }>(
    `SELECT authority.facts_json FROM gws_ea_browser_purchase_attempts attempt
     JOIN gws_ea_browser_authorities authority ON authority.id = attempt.authority_id
     WHERE attempt.job_id = ? AND attempt.resolution = 'committed' AND attempt.merchant_record_id = ?`,
    context.job.id,
    evidence.reference,
  );
  return approved.some(({ facts_json }) => {
    const facts = JSON.parse(facts_json) as Pick<PurchaseFacts, 'currency' | 'totalMinor'>;
    return facts.currency === charged.currency && charged.amountMinor <= facts.totalMinor;
  });
}

/**
 * After an ordinary press: a new confirmation showing a charge means it bought something nobody approved (KTD10).
 * `site` is the merchant, the page's site when it was pressed. An order the page showed for the same charge before
 * the press (`before`) bought nothing, wherever the press shows it again: a press on a thank-you page, or its
 * receipt or tracking. Nor did the order this job's own approved purchase placed, for up to its approved total.
 */
async function unapprovedCommit(
  context: BrowserOperationContext,
  page: Page,
  site: string | undefined,
  before: readonly ConfirmationEvidence[],
): Promise<UnapprovedCommit | undefined> {
  if (page.isClosed()) return undefined;
  await page
    .waitForLoadState('domcontentloaded', { timeout: Math.min(CONFIRMATION_LOAD_MS, context.remaining()) })
    .catch(() => undefined);
  // Every document counts, not only the first that shows a charge: a frame beside an old confirmation can show a
  // new one.
  for (const evidence of await readConfirmations(page)) {
    if (!showsCharge(evidence) || before.some((shown) => sameConfirmation(shown, evidence))) continue;
    if (await placedByJob(context, evidence)) continue;
    return { site: site ?? registrableSite(evidence.source) ?? new URL(evidence.source).hostname, evidence };
  }
  return undefined;
}

type GuardReason = ReturnType<BrowserNavigationGuard['reason']>;

function batchErrorReason(
  error: unknown,
  blocked: GuardReason,
  context: BrowserOperationContext,
  page: Page,
): BrowserStopReason {
  if (
    error instanceof BrowserBatchStop ||
    error instanceof BrowserActivationError ||
    error instanceof BrowserRefError ||
    error instanceof BrowserConsentStop
  )
    return error.reason;
  if (blocked) return blocked;
  if (error instanceof BrowserLocatorError) return 'stale_ref';
  if (error instanceof ControlFactsUnavailableError) return 'not_actionable';
  if (error instanceof errors.TimeoutError || context.signal.aborted || !context.remaining()) return 'timeout';
  if (page.isClosed()) return 'window_closed';
  if (
    error instanceof Error &&
    !(error instanceof TypeError) &&
    /(?:Execution context was destroyed|Cannot find context with specified id|Frame was detached)/u.test(error.message)
  )
    return 'stale_ref';
  if (error instanceof Error && /(?:element is not attached|element was detached)/iu.test(error.message))
    return 'not_actionable';
  throw new BrowserExecutionError();
}

export async function executeBrowserBatch(
  context: BrowserOperationContext,
  payload: Record<string, unknown>,
  options: BrowserBatchOptions = {},
): Promise<BrowserBatchResult> {
  if (options.siteAccess && (!options.page || !options.readOnly))
    throw new Error('Signed-out site access requires an explicit read-only page');
  const { actions } = validateBrowserBatch(payload);
  // Before any action runs: an address the assistant converses from never goes onto a site (KTD14).
  const addressStop = await givenAddressStop(actions.flatMap(givenText));
  if (addressStop) return { status: 'stopped', reason: addressStop, repeat_safe: true };
  const page = options.page ?? (await context.page());
  let ran: { answer: BrowserBatchResult; unapproved?: UnapprovedCommit };
  try {
    ran = await withBrowserJobNavigation(context, page, () => executeBatch(context, actions, page, options), {
      ...(options.siteAccess ? { siteAccess: options.siteAccess } : {}),
      ...(options.readOnly ? { readOnly: true } : {}),
    });
  } catch (error) {
    if (error instanceof BrowserSiteBusyError) return { status: 'stopped', reason: 'site_busy', repeat_safe: true };
    const refused = framesUnreadyStop(error);
    if (refused) return refused;
    throw error;
  }
  // Spending nobody approved stops the job, once its operation has ended (KTD10).
  return ran.unapproved
    ? { ...ran.answer, incident: await stopForUnapprovedCommit(context, ran.unapproved) }
    : ran.answer;
}

async function executeBatch(
  context: BrowserOperationContext,
  actions: readonly BrowserAction[],
  page: Page,
  options: BrowserBatchOptions,
): Promise<{ answer: BrowserBatchResult; unapproved?: UnapprovedCommit }> {
  const results: BrowserActionResult[] = actions.map((_action, index) => ({ index, status: 'not_executed' }));
  const images: Array<{ mime_type: 'image/png'; data: string }> = [];
  // The guard starts each operation clean, before its readiness pass.
  const guard = await ensureBrowserNavigationGuard(page);
  let reason: BrowserStopReason | undefined;
  /** The wordings a consent stop names, with the stop ids the job asks the principal with. */
  let consent: readonly ConsentStopView[] | undefined;
  let unapproved: UnapprovedCommit | undefined;
  let repeatSafe = true;
  let refs = new Map<string, PinnedBrowserRef>();
  const recordings: Array<{
    trace: BrowserActionTrace | undefined;
    prepared: BrowserRecipeStep | undefined;
    facts: BrowserRecipeStep | undefined;
    index: number;
  }> = [];
  let navigation = 0;
  const navigated = (frame: ReturnType<Page['mainFrame']>): void => {
    if (frame === page.mainFrame()) ++navigation;
  };
  /** Every activation carries the request's own deadline checks and budget. */
  let controls = new Map<string, BrowserActionControl>();
  const recordField = (
    target: PinnedBrowserRef,
    facts: ControlFacts,
    kind: ActivationIntent['kind'] = 'click',
  ): void => {
    controls.set(target.ref, { facts, classification: classifyControlFacts(facts, kind) });
  };
  const intent = (kind: ActivationIntent['kind'], target?: PinnedBrowserRef): ActivationIntent => ({
    ...(target ? { onFacts: (facts, classification) => controls.set(target.ref, { facts, classification }) } : {}),
    kind,
    scope: { jobId: context.job.id, db: context.store.db },
    assertActive: context.assertActive,
    remaining: context.remaining,
  });
  page.on('framenavigated', navigated);
  try {
    beginBrowserDiagnosticAction(page, 0);
    const requestedRefs = actions.flatMap(browserActionRefs);
    if (options.targets) {
      if (options.targets.length !== requestedRefs.length) throw new BrowserRefError('stale_ref');
      for (const [index, ref] of requestedRefs.entries()) {
        if (refs.has(ref.ref)) continue;
        const element = await resolveLocator(page, options.targets[index]);
        try {
          const frame = await element.ownerFrame();
          if (!frame) throw new BrowserRefError('stale_ref');
          refs.set(ref.ref, { ...ref, element, frame });
        } catch (error) {
          await element.dispose();
          throw error;
        }
      }
    } else refs = await pinBrowserRefs(page, requestedRefs);
    // Before any action runs, the principal's personal data goes onto no site but where main disclosed it for this
    // errand: each field's value goes to the site of the frame the field is in (KTD19).
    const dataStop = await personalDataStop(context.store.db, context.job.id, actions, refs);
    if (dataStop) return { answer: { status: 'stopped', reason: dataStop, repeat_safe: true } };
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      controls = new Map();
      beginBrowserDiagnosticAction(page, index);
      const before = navigation;
      // The merchant an ordinary press acts for: the page's site when it is pressed.
      const site = registrableSite(page.url());
      let data: BrowserActionData = {};
      let trace: BrowserActionTrace | undefined;
      // Whether an ordinary press ran, whose result the confirmation check reads (KTD10).
      let pressed = false;
      try {
        await context.assertActive();
        if (action.kind !== 'navigate' && options.siteAccess && /^https?:/u.test(page.url())) {
          if ((await options.siteAccess(new URL(page.url()))) !== 'ordinary') throw new BrowserBatchStop('site_busy');
        }
        if (options.record !== false && context.kind !== 'watch_check') {
          const { db } = context.store;
          const jobId = context.job.id;
          const requestId = context.request.id;
          trace = await withinBrowserRecordingBudget(context.remaining(), () =>
            reserveBrowserActionTrace(db, jobId, requestId),
          );
          let facts: BrowserRecipeStep | undefined;
          if (trace && index === 0) {
            try {
              facts = prepareBrowserActionFacts(page, action, refs, options.targets);
            } catch {
              /* Optional projection cannot alter execution. */
            }
          }
          recordings.push({ trace, prepared: facts, facts: undefined, index });
          if (trace) data.trace_index = trace.index;
        }
        if (options.readOnly && !(await isReadOnlyBrowserAction(page, action, refs)))
          throw new BrowserBatchStop('read_only');
        await context.assertActive();
        // What the page already confirmed: a press that leaves it in place bought nothing (KTD10).
        const confirmedBefore = mayPress(action) ? await readConfirmations(page) : [];
        const target = 'ref' in action ? refs.get(action.ref) : undefined;
        if (['click', 'type', 'select', 'key', 'form_input', 'upload', 'download'].includes(action.kind))
          repeatSafe = false;
        switch (action.kind) {
          case 'observe':
            break;
          case 'navigate': {
            const classification = classifyNavigationUrl(action.url);
            if (classification !== 'ordinary') {
              captureBrowserDiagnosticRefusal(page)(
                'address',
                { url: action.url, method: 'GET', resource: 'document' },
                classification,
              );
              throw new BrowserBatchStop(classification);
            }
            const lease = options.siteAccess
              ? { acquired: (await options.siteAccess(new URL(action.url))) === 'ordinary', waitingJobs: [] }
              : await new SiteLeaseStore(context.store.db).acquire(context.job.id, action.url);
            await context.wakeWaiters(lease.waitingJobs, `${browserOperationId(context)}:navigate-release`);
            if (!lease.acquired) throw new BrowserBatchStop('site_busy');
            const documentWait = new AbortController();
            const committed = page
              .waitForEvent('framenavigated', {
                predicate: (frame) => frame === page.mainFrame(),
                timeout: context.remaining(),
                signal: AbortSignal.any([context.signal, documentWait.signal]),
              })
              .catch(() => undefined);
            try {
              await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: context.remaining() });
            } catch (error) {
              if (
                !guard.reason() &&
                error instanceof Error &&
                /^page.goto: net::ERR_[A-Z0-9_]+\b/u.test(error.message)
              ) {
                // Failed DNS/TLS/connection navigation can reject before Chrome commits its error document.
                // That document belongs to this navigation; let it settle before another action can navigate.
                if (!/^page.goto: net::ERR_ABORTED\b/u.test(error.message)) {
                  const document = await committed;
                  if (document && !page.isClosed())
                    await page.waitForLoadState('domcontentloaded', { timeout: context.remaining() });
                  await context.assertActive();
                }
                throw new BrowserBatchStop('navigation_failed');
              }
              throw error;
            } finally {
              documentWait.abort();
            }
            break;
          }
          case 'click':
            if (target)
              ({ ordinaryPress: pressed } = await activateControl(
                page,
                target.element,
                () => nativeAction(context, (options) => target.element.click(options)),
                undefined,
                intent('click', target),
              ));
            break;
          case 'type':
            if (target) {
              recordField(target, await refuseFieldEntry(page, target));
              await fieldInput(context, guard, [{ target, value: action.text }]);
            }
            break;
          case 'select':
            if (target) {
              recordField(target, await refuseFieldEntry(page, target));
              await activateControl(
                page,
                target.element,
                () =>
                  nativeAction(context, async (options) => {
                    await target.element.selectOption(action.value, options);
                  }),
                undefined,
                intent('select', target),
              );
            }
            break;
          case 'key':
            if (target) {
              const facts = await readPageControlFacts(page, target.element);
              if (facts.secretEntry) throw new BrowserBatchStop('secret_field');
              recordField(target, facts, ENTER_KEY.test(action.key) ? 'submit' : 'click');
              const press = (): Promise<void> =>
                nativeAction(context, (options) => target.element.press(action.key, options));
              if (ENTER_KEY.test(action.key)) {
                const formSubmit = await browserKeyboardSubmitTarget(target.element);
                try {
                  // A field's Enter submits its form through the form's own submit control; a formless field's
                  // Enter is the field's own press.
                  ({ ordinaryPress: pressed } = await activateControl(
                    page,
                    formSubmit.asElement() ?? target.element,
                    press,
                    undefined,
                    intent('submit', target),
                  ));
                } finally {
                  await formSubmit.dispose();
                }
              } else if (SPACE_KEY.test(action.key))
                ({ ordinaryPress: pressed } = await activateControl(
                  page,
                  target.element,
                  press,
                  undefined,
                  intent('click', target),
                ));
              // Any other key edits or moves within the field: typing, inside the same window as a fill.
              else await guard.duringAction(context.remaining(), press);
            }
            break;
          case 'scroll': {
            const amount = action.amount ?? 600;
            await page.mouse.wheel(
              action.direction === 'left' ? -amount : action.direction === 'right' ? amount : 0,
              action.direction === 'up' ? -amount : action.direction === 'down' ? amount : 0,
            );
            break;
          }
          case 'wait_for': {
            const timeout = Math.min(context.remaining(), action.timeout_ms ?? context.remaining());
            if (action.text)
              await page.getByText(action.text, { exact: false }).first().waitFor({ state: 'visible', timeout });
            else await page.waitForLoadState('domcontentloaded', { timeout });
            break;
          }
          case 'form_input': {
            for (const field of action.fields) {
              const pinned = refs.get(field.ref);
              if (!pinned) throw new BrowserBatchStop('stale_ref');
              recordField(pinned, await refuseFieldEntry(page, pinned));
            }
            await fieldInput(
              context,
              guard,
              action.fields.map((field) => ({ target: refs.get(field.ref)!, value: field.value })),
            );
            if (action.submit) {
              const submit = refs.get(action.submit.ref)!;
              ({ ordinaryPress: pressed } = await activateControl(
                page,
                submit.element,
                () => nativeAction(context, (options) => submit.element.click(options)),
                undefined,
                intent('submit', submit),
              ));
            }
            break;
          }
          case 'screenshot':
            // The same isolated-world scan as the card's picture, shadow roots included (KTD6).
            if (await pageMayShowSecret(page)) throw new BrowserBatchStop('secret_field');
            else {
              const image = {
                mime_type: 'image/png',
                data: (await page.screenshot({ type: 'png', timeout: Math.min(10_000, context.remaining()) })).toString(
                  'base64',
                ),
              } as const;
              data = { image_index: images.length };
              images.push(image);
            }
            break;
          case 'upload':
            if (target) {
              const policy = await readHostBrowserPolicy();
              if (!policy.enabled) throw new BrowserBatchStop('browser_unavailable');
              const staged = await stageBrowserUpload(
                sessionDir(context.session.agent_group_id, context.session.id),
                path.join(policy.paths.stagingDir, 'uploads'),
                action.path,
              );
              let retained = false;
              try {
                await context.assertActive();
                // Choosing a file fills a field: page script reacting to it runs inside the same window as typing.
                await guard.duringAction(context.remaining(), () =>
                  target.element.setInputFiles(staged.path, { timeout: context.remaining() }),
                );
                retainBrowserUpload(page, staged);
                retained = true;
              } finally {
                if (!retained) await staged.remove();
              }
            }
            break;
          case 'download':
            if (context.kind === 'watch_check') throw new BrowserBatchStop('read_only');
            if (target) {
              const policy = await readHostBrowserPolicy();
              if (!policy.enabled) throw new BrowserBatchStop('browser_unavailable');
              data = await captureBrowserDownload(
                context,
                page,
                path.join(policy.paths.stagingDir, 'downloads'),
                index,
                async () => {
                  await activateControl(
                    page,
                    target.element,
                    () => nativeAction(context, (options) => target.element.click(options)),
                    undefined,
                    intent('download', target),
                  );
                },
              );
            }
            break;
        }
        const recording = recordings.at(-1);
        if (recording?.index === index) recording.facts = enrichBrowserActionFacts(page, recording.prepared, controls);
        const blocked = guard.reason();
        if (blocked) throw new BrowserBatchStop(blocked);
        if (pressed) {
          const commit = await unapprovedCommit(context, page, site, confirmedBefore);
          if (commit) throw new UnapprovedCommitStop(commit);
        }
        results[index] = { index, status: 'completed', ...data, ...(trace ? { trace_index: trace.index } : {}) };
        if (navigation !== before) {
          reason = 'navigated';
          break;
        }
      } catch (error) {
        const recording = recordings.at(-1);
        if (recording?.index === index) recording.facts = enrichBrowserActionFacts(page, recording.prepared, controls);
        if (
          error instanceof BrowserBatchStop ||
          error instanceof BrowserRefError ||
          error instanceof BrowserConsentStop
        )
          captureBrowserDiagnosticRefusal(page)('action', undefined, error.reason);
        reason = batchErrorReason(error, guard.reason(), context, page);
        if (error instanceof BrowserConsentStop) consent = consentStopsForAgent(error.stops);
        if (error instanceof UnapprovedCommitStop) unapproved = error.commit;
        results[index] = {
          index,
          status: 'stopped',
          reason,
          ...(consent ? { consent } : {}),
          ...(trace ? { trace_index: trace.index } : {}),
        };
        break;
      }
    }
  } catch (error) {
    if (error instanceof BrowserRefError || error instanceof BrowserLocatorError)
      captureBrowserDiagnosticRefusal(page)('target', undefined, 'stale_ref');
    reason = batchErrorReason(error, guard.reason(), context, page);
    results[0] = { index: 0, status: 'stopped', reason };
  } finally {
    page.off('framenavigated', navigated);
    await disposeBrowserRefs(refs);
  }
  let observation;
  if (!page.isClosed()) {
    try {
      // Still inside the job's operation: the host settles a cookie banner before it observes (R18).
      const cookieBanner = await settleCookieBanners(page, {
        scope: { jobId: context.job.id, db: context.store.db },
        assertActive: context.assertActive,
        remaining: context.remaining,
      });
      observation = await observePage(page, context.assertActive, {
        cookieBanner,
        remaining: context.remaining,
        signal: context.signal,
      });
    } catch (error) {
      if (!unapproved) {
        const failure = batchErrorReason(error, guard.reason(), context, page);
        if (!reason || reason === 'navigated') reason = failure;
      }
    }
  }
  // Playwright waits only for main-frame navigations, so a refusal inside a frame can land after its action.
  const blocked = guard.reason();
  if ((!reason || reason === 'navigated') && blocked) reason = blocked;
  if (observation && (!reason || reason === 'navigated') && hasBrowserChallenge(observation.snapshot))
    reason = 'challenge';
  if (
    observation &&
    (!reason || reason === 'navigated') &&
    /(?:sign in to continue|log in to continue|please sign in)/iu.test(observation.snapshot)
  )
    reason = 'sign_in_wall';
  let recording: { status: 'complete' | 'unavailable'; trace_indices: number[] } | undefined;
  if (options.record !== false && context.kind !== 'watch_check') {
    let complete = true;
    for (const [ordinal, entry] of recordings.entries()) {
      const after = ordinal === recordings.length - 1 ? browserStructureFacts(page) : undefined;
      const trace = entry.trace;
      const facts = entry.facts;
      const actionResult = results[entry.index];
      const stopReason = actionResult.status === 'stopped' ? actionResult.reason : undefined;
      if (
        !trace ||
        !(await withinBrowserRecordingBudget(context.remaining(), () => trace.finish(facts, after, stopReason)))
      )
        complete = false;
    }
    recording = {
      status: complete && recordings.length > 0 ? 'complete' : 'unavailable',
      trace_indices: recordings.flatMap(({ trace }) => (trace ? [trace.index] : [])),
    };
  }
  return {
    answer: {
      ...(reason ? { status: 'stopped' as const, reason } : { status: 'completed' as const }),
      ...(consent ? { consent } : {}),
      actions: results,
      ...(recording ? { recording } : {}),
      ...(images.length ? { images } : {}),
      ...(observation ? { observation } : {}),
      repeat_safe: repeatSafe,
    },
    ...(unapproved ? { unapproved } : {}),
  };
}

export const browserAction: BrowserQueuedAction = { validate: validateBrowserBatch, execute: executeBrowserBatch };
