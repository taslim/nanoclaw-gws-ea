import path from 'node:path';
import { errors, type Page, type ElementHandle, type JSHandle } from 'playwright-core';

import { invalidArgs } from '../../cli/delivery-action.js';
import { sessionDir } from '../../session-manager.js';
import { isRecord } from '../../gws-ea/validation.js';
import {
  activateControl,
  BrowserActivationError,
  BrowserSiteBusyError,
  classifyNavigationUrl,
  ensureBrowserNavigationGuard,
  framesUnreadyStop,
  readControlFacts,
  registrableSite,
  withBrowserJobNavigation,
  type ActivationIntent,
  type BrowserNavigationGuard,
} from './commit-classifier.js';
import { isSensitiveField } from './authentication-signatures.js';
import { readConfirmation, showsCharge } from './confirmation.js';
import { BrowserConsentStop, type ConsentStopView } from './consent.js';
import { settleCookieBanners } from './cookie-banners.js';
import { personalDataStop } from './disclosures.js';
import { captureBrowserDownload, stageBrowserUpload, retainBrowserUpload } from './files.js';
import { stopForUnapprovedCommit, type UnapprovedCommit } from './incidents.js';
import { SiteLeaseStore } from './leases.js';
import {
  BrowserRefError,
  disposeBrowserRefs,
  observePage,
  pageHasSecret,
  pageMayShowSecret,
  pinBrowserRefs,
  readBrowserRef,
  hasBrowserChallenge,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import { readBrowserPolicy } from './policy.js';
import { registerBrowserQueuedAction, type BrowserExecutionContext } from './queue.js';
import { beginBrowserActionTrace, isReadOnlyBrowserAction } from './recipes.js';
import { typedAddressStop } from './web-address.js';

export type BrowserStopReason =
  | 'stale_ref'
  | 'not_actionable'
  | 'timeout'
  | 'navigated'
  | 'purchase_control'
  | 'speaks_as_principal'
  | 'account_security'
  | 'consent_control'
  | 'consent_required'
  | 'secret_field'
  | 'card_field'
  | 'read_only'
  | 'unapproved_commit'
  | 'blocked_address'
  | 'challenge'
  | 'sign_in_wall'
  | 'site_busy'
  | 'window_closed'
  | 'browser_unavailable'
  | 'alias_unavailable'
  | 'personal_data'
  | 'interrupted';
export type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'observe' | 'screenshot' }
  | ({ kind: 'click' | 'download' } & BrowserRef)
  | ({ kind: 'type'; text: string } & BrowserRef)
  | ({ kind: 'select'; value: string } & BrowserRef)
  | ({ kind: 'key'; key: string } & BrowserRef)
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }
  | { kind: 'wait_for'; text?: string; timeout_ms?: number }
  | { kind: 'form_input'; fields: Array<BrowserRef & { value: string }>; submit?: BrowserRef }
  | ({ kind: 'upload'; path: string } & BrowserRef);

export interface BrowserBatch {
  actions: BrowserAction[];
}
/** Host callers may replay on a signed-out page; none of these options are model inputs. */
export interface BrowserBatchOptions {
  page?: Page;
  record?: boolean;
  readOnly?: boolean;
  siteAccess?: import('./commit-classifier.js').BrowserSiteAccess;
}
export interface BrowserActionResult {
  index: number;
  status: 'completed' | 'stopped' | 'not_executed';
  reason?: BrowserStopReason;
  [key: string]: unknown;
}

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

export function browserActionRefs(action: BrowserAction): BrowserRef[] {
  if ('ref' in action) return [action];
  return action.kind === 'form_input' ? [...action.fields, ...(action.submit ? [action.submit] : [])] : [];
}

/** The ordinary text an action types into a site. */
function typedText(action: BrowserAction): string[] {
  if (action.kind === 'type') return [action.text];
  return action.kind === 'form_input' ? action.fields.map((field) => field.value) : [];
}

export async function isSecretBrowserField(target: Pick<PinnedBrowserRef, 'element'>): Promise<boolean> {
  const facts = await target.element.evaluate((node) => {
    const e = node as unknown as { getAttribute(name: string): string | null };
    const read = (name: string): string => e.getAttribute(name) ?? '';
    return {
      type: read('type'),
      autocomplete: read('autocomplete'),
      name: read('name'),
      id: read('id'),
      label: read('aria-label'),
      placeholder: read('placeholder'),
    };
  });
  return isSensitiveField(facts);
}

/** Payment details are never entered (R12); passwords and codes only through the host's own fills. */
async function refuseFieldEntry(page: Page, target: PinnedBrowserRef): Promise<void> {
  if ((await readControlFacts(page, target.element)).cardEntry === true) throw new BrowserBatchStop('card_field');
  if (await isSecretBrowserField(target)) throw new BrowserBatchStop('secret_field');
}

async function fieldInput(context: BrowserExecutionContext, target: PinnedBrowserRef, value: string): Promise<void> {
  if (await isSecretBrowserField(target)) throw new BrowserBatchStop('secret_field');
  await context.assertActive();
  await target.element.fill(value, { timeout: context.remaining() });
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
  context: BrowserExecutionContext,
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

/**
 * After an ordinary press: a confirmation showing a charge means it bought something nobody approved (KTD10).
 * `site` is the merchant, the page's site when it was pressed.
 */
async function unapprovedCommit(
  context: BrowserExecutionContext,
  page: Page,
  site: string | undefined,
): Promise<UnapprovedCommit | undefined> {
  if (page.isClosed()) return undefined;
  await page
    .waitForLoadState('domcontentloaded', { timeout: Math.min(CONFIRMATION_LOAD_MS, context.remaining()) })
    .catch(() => undefined);
  const evidence = await readConfirmation(page);
  if (!evidence || !showsCharge(evidence)) return undefined;
  return { site: site ?? registrableSite(evidence.source) ?? new URL(evidence.source).hostname, evidence };
}

/** The keyboard and recipe paths must identify the very same native submit control. */
export function browserKeyboardSubmitTarget(element: ElementHandle): Promise<JSHandle<unknown>> {
  return element.evaluateHandle((node) => {
    const e = node as unknown as { tagName: string; form?: { querySelector(selector: string): unknown } };
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)
      ? (e.form?.querySelector('button[type="submit"],input[type="submit"],button:not([type])') ?? null)
      : node;
  });
}

type GuardReason = ReturnType<BrowserNavigationGuard['reason']>;

function batchErrorReason(
  error: unknown,
  blocked: GuardReason,
  context: BrowserExecutionContext,
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
  if (error instanceof errors.TimeoutError || context.signal.aborted || !context.remaining()) return 'timeout';
  return page.isClosed() ? 'window_closed' : 'not_actionable';
}

export async function executeBrowserBatch(
  context: BrowserExecutionContext,
  payload: Record<string, unknown>,
  options: BrowserBatchOptions = {},
): Promise<Record<string, unknown>> {
  if (options.siteAccess && (!options.page || !options.readOnly))
    throw new Error('Signed-out site access requires an explicit read-only page');
  const { actions } = validateBrowserBatch(payload);
  // Before any action runs: an address the assistant converses from never goes onto a site (KTD14).
  const addressStop = await typedAddressStop(actions.flatMap(typedText));
  if (addressStop) return { status: 'stopped', reason: addressStop, repeat_safe: true };
  const page = options.page ?? (await context.page());
  // Nor does the principal's personal data, except where main disclosed it for this errand (KTD19).
  const dataStop = await personalDataStop(context.store.db, context.job.id, page.url(), actions);
  if (dataStop) return { status: 'stopped', reason: dataStop, repeat_safe: true };
  let ran: { answer: Record<string, unknown>; unapproved?: UnapprovedCommit };
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
  context: BrowserExecutionContext,
  actions: readonly BrowserAction[],
  page: Page,
  options: BrowserBatchOptions,
): Promise<{ answer: Record<string, unknown>; unapproved?: UnapprovedCommit }> {
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
  let navigation = 0;
  const navigated = (frame: ReturnType<Page['mainFrame']>): void => {
    if (frame === page.mainFrame()) ++navigation;
  };
  /** Every activation carries the request's own deadline checks and budget. */
  const intent = (kind: ActivationIntent['kind']): ActivationIntent => ({
    kind,
    assertActive: context.assertActive,
    remaining: context.remaining,
  });
  page.on('framenavigated', navigated);
  try {
    refs = await pinBrowserRefs(page, actions.flatMap(browserActionRefs));
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      const before = navigation;
      // The merchant an ordinary press acts for: the page's site when it is pressed.
      const site = registrableSite(page.url());
      let data: Record<string, unknown> = {};
      let trace: Awaited<ReturnType<typeof beginBrowserActionTrace>> | undefined;
      // Whether an ordinary press ran, whose result the confirmation check reads (KTD10).
      let pressed = false;
      try {
        await context.assertActive();
        if (action.kind !== 'navigate' && /^https?:/u.test(page.url())) {
          const lease = options.siteAccess
            ? { acquired: (await options.siteAccess(new URL(page.url()))) === 'ordinary', waitingJobs: [] }
            : await new SiteLeaseStore(context.store.db).acquire(context.job.id, page.url());
          await context.wakeWaiters(lease.waitingJobs, `${context.request.id}:action-release`);
          if (!lease.acquired) throw new BrowserBatchStop('site_busy');
        }
        if (options.record !== false) {
          trace = await beginBrowserActionTrace(context, page, action, refs);
          data.trace_index = trace.index;
        }
        if (options.readOnly && !(await isReadOnlyBrowserAction(page, action, refs)))
          throw new BrowserBatchStop('read_only');
        await context.assertActive();
        const target = 'ref' in action ? refs.get(action.ref) : undefined;
        if (['click', 'type', 'select', 'key', 'form_input', 'upload', 'download'].includes(action.kind))
          repeatSafe = false;
        switch (action.kind) {
          case 'observe':
            break;
          case 'navigate': {
            const classification = classifyNavigationUrl(action.url);
            if (classification !== 'ordinary') throw new BrowserBatchStop(classification);
            const lease = options.siteAccess
              ? { acquired: (await options.siteAccess(new URL(action.url))) === 'ordinary', waitingJobs: [] }
              : await new SiteLeaseStore(context.store.db).acquire(context.job.id, action.url);
            await context.wakeWaiters(lease.waitingJobs, `${context.request.id}:navigate-release`);
            if (!lease.acquired) throw new BrowserBatchStop('site_busy');
            await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: context.remaining() });
            break;
          }
          case 'click':
            if (target)
              ({ ordinaryPress: pressed } = await activateControl(
                page,
                target.element,
                () => nativeAction(context, (options) => target.element.click(options)),
                undefined,
                intent('click'),
              ));
            break;
          case 'type':
            if (target) {
              await refuseFieldEntry(page, target);
              await fieldInput(context, target, action.text);
            }
            break;
          case 'select':
            if (target) {
              await refuseFieldEntry(page, target);
              await activateControl(
                page,
                target.element,
                () =>
                  nativeAction(context, async (options) => {
                    await target.element.selectOption(action.value, options);
                  }),
                undefined,
                intent('select'),
              );
            }
            break;
          case 'key':
            if (target) {
              if (await isSecretBrowserField(target)) throw new BrowserBatchStop('secret_field');
              const press = (): Promise<void> =>
                nativeAction(context, (options) => target.element.press(action.key, options));
              if (/^(?:Shift\+)?Enter$/u.test(action.key)) {
                const formSubmit = await browserKeyboardSubmitTarget(target.element);
                try {
                  // A field's Enter submits its form through the form's own submit control; a formless field's
                  // Enter is the field's own press.
                  ({ ordinaryPress: pressed } = await activateControl(
                    page,
                    formSubmit.asElement() ?? target.element,
                    press,
                    undefined,
                    intent('submit'),
                  ));
                } finally {
                  await formSubmit.dispose();
                }
              } else if (/^(?:Shift\+)?Space$/u.test(action.key))
                ({ ordinaryPress: pressed } = await activateControl(
                  page,
                  target.element,
                  press,
                  undefined,
                  intent('click'),
                ));
              else await press();
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
              await refuseFieldEntry(page, pinned);
            }
            for (const field of action.fields) await fieldInput(context, refs.get(field.ref)!, field.value);
            if (action.submit) {
              const submit = refs.get(action.submit.ref)!;
              ({ ordinaryPress: pressed } = await activateControl(
                page,
                submit.element,
                () => nativeAction(context, (options) => submit.element.click(options)),
                undefined,
                intent('submit'),
              ));
            }
            break;
          }
          case 'screenshot':
            // The same isolated-world scan as the card's picture, shadow roots included (KTD6).
            if ((await pageHasSecret(page)) || (await pageMayShowSecret(page)))
              throw new BrowserBatchStop('secret_field');
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
              const policy = await readBrowserPolicy();
              if (!policy.enabled) throw new BrowserBatchStop('browser_unavailable');
              const staged = await stageBrowserUpload(
                sessionDir(context.session.agent_group_id, context.session.id),
                path.join(policy.paths.stagingDir, 'uploads'),
                action.path,
              );
              let retained = false;
              try {
                await context.assertActive();
                await target.element.setInputFiles(staged.path, { timeout: context.remaining() });
                retainBrowserUpload(page, staged);
                retained = true;
              } finally {
                if (!retained) await staged.remove();
              }
            }
            break;
          case 'download':
            if (target) {
              const policy = await readBrowserPolicy();
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
                    intent('download'),
                  );
                },
              );
            }
            break;
        }
        const blocked = guard.reason();
        if (blocked) throw new BrowserBatchStop(blocked);
        if (pressed) {
          const commit = await unapprovedCommit(context, page, site);
          if (commit) throw new UnapprovedCommitStop(commit);
        }
        await trace?.finish();
        results[index] = { index, status: 'completed', ...data, ...(trace ? { trace_index: trace.index } : {}) };
        if (navigation !== before) {
          reason = 'navigated';
          break;
        }
      } catch (error) {
        reason = batchErrorReason(error, guard.reason(), context, page);
        if (error instanceof BrowserConsentStop) consent = error.stops;
        if (error instanceof UnapprovedCommitStop) unapproved = error.commit;
        await trace?.finish(reason);
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
    reason = error instanceof BrowserRefError ? error.reason : 'not_actionable';
    results[0] = { index: 0, status: 'stopped', reason };
  } finally {
    page.off('framenavigated', navigated);
    await disposeBrowserRefs(refs);
  }
  let observation;
  if (!page.isClosed()) {
    try {
      // Still inside the job's operation: the host settles a cookie banner before it observes (R18).
      const cookieBanner = await settleCookieBanners(page, context.assertActive);
      observation = await observePage(page, context.assertActive, { cookieBanner });
    } catch (_error) {
      reason ??= 'not_actionable';
    }
  }
  // Playwright waits only for main-frame navigations, so a refusal inside a frame can land after its action.
  const blocked = guard.reason();
  if (!reason && blocked) reason = blocked;
  if (observation && !reason && hasBrowserChallenge(observation.snapshot)) reason = 'challenge';
  if (
    observation &&
    !reason &&
    /(?:sign in to continue|log in to continue|please sign in)/iu.test(observation.snapshot)
  )
    reason = 'sign_in_wall';
  return {
    answer: {
      status: reason ? 'stopped' : 'completed',
      ...(reason ? { reason } : {}),
      ...(consent ? { consent } : {}),
      actions: results,
      ...(images.length ? { images } : {}),
      ...(observation ? { observation } : {}),
      repeat_safe: repeatSafe,
    },
    ...(unapproved ? { unapproved } : {}),
  };
}

registerBrowserQueuedAction('browser', { validate: validateBrowserBatch, execute: executeBrowserBatch });
