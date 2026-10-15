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
  withBrowserJobNavigation,
  type BrowserNavigationGuard,
} from './commit-classifier.js';
import { captureBrowserDownload, stageBrowserUpload } from './files.js';
import { SiteLeaseStore } from './leases.js';
import {
  BrowserRefError,
  disposeBrowserRefs,
  observePage,
  pageHasSecret,
  pinBrowserRefs,
  readBrowserRef,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import { readBrowserPolicy } from './policy.js';
import { registerBrowserQueuedAction, type BrowserExecutionContext } from './queue.js';
import { beginBrowserActionTrace, isReadOnlyBrowserAction } from './recipes.js';

export type BrowserStopReason =
  | 'stale_ref'
  | 'not_actionable'
  | 'timeout'
  | 'navigated'
  | 'purchase_control'
  | 'speaks_as_principal'
  | 'account_security'
  | 'secret_field'
  | 'blocked_address'
  | 'challenge'
  | 'sign_in_wall'
  | 'site_busy'
  | 'unsupported_merchant'
  | 'window_closed'
  | 'browser_unavailable'
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

export async function isSecretBrowserField(target: Pick<PinnedBrowserRef, 'element'>): Promise<boolean> {
  return target.element.evaluate((node) => {
    const e = node as unknown as { getAttribute(name: string): string | null };
    const type = e.getAttribute('type') ?? '';
    const description = ['autocomplete', 'name', 'id', 'aria-label', 'placeholder']
      .map((key) => e.getAttribute(key) ?? '')
      .join(' ');
    return (
      type === 'password' ||
      /(?:one-time-code|(?:^|\s)cc-|credit.?card|card.?number|cvc|cvv|otp|one.?time|verification.?code|security.?code)/iu.test(
        description,
      )
    );
  });
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

/** The keyboard and recipe paths must identify the very same native submit control. */
export function browserKeyboardSubmitTarget(element: ElementHandle): Promise<JSHandle<unknown>> {
  return element.evaluateHandle((node) => {
    const e = node as unknown as { tagName: string; form?: { querySelector(selector: string): unknown } };
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)
      ? (e.form?.querySelector('button[type="submit"],input[type="submit"],button:not([type])') ?? null)
      : node;
  });
}

function batchErrorReason(
  error: unknown,
  blocked: ReturnType<BrowserNavigationGuard['reason']>,
  context: BrowserExecutionContext,
  page: Page,
): BrowserStopReason {
  if (error instanceof BrowserBatchStop || error instanceof BrowserActivationError || error instanceof BrowserRefError)
    return error.reason;
  if (blocked && blocked !== 'ordinary') return blocked;
  if (error instanceof errors.TimeoutError || context.signal.aborted || !context.remaining()) return 'timeout';
  return page.isClosed() ? 'window_closed' : 'not_actionable';
}

export async function executeBrowserBatch(
  context: BrowserExecutionContext,
  payload: Record<string, unknown>,
  options: BrowserBatchOptions = {},
): Promise<Record<string, unknown>> {
  const page = options.page ?? (await context.page());
  try {
    return await withBrowserJobNavigation(context, page, () => executeBatch(context, payload, page, options));
  } catch (error) {
    if (error instanceof BrowserSiteBusyError) return { status: 'stopped', reason: 'site_busy', repeat_safe: true };
    throw error;
  }
}

async function executeBatch(
  context: BrowserExecutionContext,
  payload: Record<string, unknown>,
  page: Page,
  options: BrowserBatchOptions,
): Promise<Record<string, unknown>> {
  const { actions } = validateBrowserBatch(payload);
  const results: BrowserActionResult[] = actions.map((_action, index) => ({ index, status: 'not_executed' }));
  const images: Array<{ mime_type: 'image/png'; data: string }> = [];
  const guard = await ensureBrowserNavigationGuard(page);
  guard.clearReason();
  let reason: BrowserStopReason | undefined;
  let repeatSafe = true;
  let refs = new Map<string, PinnedBrowserRef>();
  let navigation = 0;
  const navigated = (frame: ReturnType<Page['mainFrame']>): void => {
    if (frame === page.mainFrame()) ++navigation;
  };
  page.on('framenavigated', navigated);
  try {
    refs = await pinBrowserRefs(page, actions.flatMap(browserActionRefs));
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      const before = navigation;
      let data: Record<string, unknown> = {};
      let trace: Awaited<ReturnType<typeof beginBrowserActionTrace>> | undefined;
      try {
        await context.assertActive();
        if (action.kind !== 'navigate' && /^https?:/u.test(page.url())) {
          const lease = await new SiteLeaseStore(context.store.db).acquire(context.job.id, page.url());
          await context.wakeWaiters(lease.waitingJobs, `${context.request.id}:action-release`);
          if (!lease.acquired) throw new BrowserBatchStop('site_busy');
        }
        if (options.record !== false) {
          trace = await beginBrowserActionTrace(context, page, action, refs);
          data.trace_index = trace.index;
        }
        if (options.readOnly && !(await isReadOnlyBrowserAction(page, action, refs)))
          throw new BrowserBatchStop('unsupported_merchant');
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
            const lease = await new SiteLeaseStore(context.store.db).acquire(context.job.id, action.url);
            await context.wakeWaiters(lease.waitingJobs, `${context.request.id}:navigate-release`);
            if (!lease.acquired) throw new BrowserBatchStop('site_busy');
            await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: context.remaining() });
            break;
          }
          case 'click':
            if (target)
              await activateControl(
                page,
                target.element,
                async () => {
                  await context.assertActive();
                  await target.element.click({ timeout: context.remaining() });
                },
                undefined,
                { kind: 'click', assertActive: context.assertActive },
              );
            break;
          case 'type':
            if (target) await fieldInput(context, target, action.text);
            break;
          case 'select':
            if (target)
              await activateControl(
                page,
                target.element,
                async () => {
                  await context.assertActive();
                  await target.element.selectOption(action.value, { timeout: context.remaining() });
                },
                undefined,
                { kind: 'select', value: action.value, assertActive: context.assertActive },
              );
            break;
          case 'key':
            if (target) {
              if (await isSecretBrowserField(target)) throw new BrowserBatchStop('secret_field');
              const press = async (): Promise<void> => {
                await context.assertActive();
                await target.element.press(action.key, { timeout: context.remaining() });
              };
              if (/^(?:Shift\+)?Enter$/u.test(action.key)) {
                const formSubmit = await browserKeyboardSubmitTarget(target.element);
                try {
                  const submit = formSubmit.asElement();
                  if (!submit) throw new BrowserBatchStop('unsupported_merchant');
                  await activateControl(page, submit, press, undefined, {
                    kind: 'submit',
                    assertActive: context.assertActive,
                  });
                } finally {
                  await formSubmit.dispose();
                }
              } else if (/^(?:Shift\+)?Space$/u.test(action.key))
                await activateControl(page, target.element, press, undefined, {
                  kind: 'click',
                  assertActive: context.assertActive,
                });
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
              if (await isSecretBrowserField(pinned)) throw new BrowserBatchStop('secret_field');
            }
            for (const field of action.fields) await fieldInput(context, refs.get(field.ref)!, field.value);
            if (action.submit) {
              const submit = refs.get(action.submit.ref)!;
              await activateControl(
                page,
                submit.element,
                async () => {
                  await context.assertActive();
                  await submit.element.click({ timeout: context.remaining() });
                },
                undefined,
                { kind: 'submit', assertActive: context.assertActive },
              );
            }
            break;
          }
          case 'screenshot':
            if (await pageHasSecret(page)) throw new BrowserBatchStop('secret_field');
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
              try {
                await context.assertActive();
                await target.element.setInputFiles(staged.path, { timeout: context.remaining() });
              } finally {
                await staged.remove();
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
                () =>
                  activateControl(
                    page,
                    target.element,
                    async () => {
                      await context.assertActive();
                      await target.element.click({ timeout: context.remaining() });
                    },
                    undefined,
                    { kind: 'download', assertActive: context.assertActive },
                  ),
              );
            }
            break;
        }
        const blocked = guard.reason();
        if (blocked && blocked !== 'ordinary') throw new BrowserBatchStop(blocked);
        await trace?.finish();
        results[index] = { index, status: 'completed', ...data, ...(trace ? { trace_index: trace.index } : {}) };
        if (navigation !== before) {
          reason = 'navigated';
          break;
        }
      } catch (error) {
        reason = batchErrorReason(error, guard.reason(), context, page);
        await trace?.finish(reason);
        results[index] = { index, status: 'stopped', reason, ...(trace ? { trace_index: trace.index } : {}) };
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
      observation = await observePage(page, context.assertActive);
    } catch (_error) {
      reason ??= 'not_actionable';
    }
  }
  if (
    observation &&
    !reason &&
    /(?:captcha|verify (?:that )?you are human|access denied|unusual traffic|checking your browser)/iu.test(
      observation.snapshot,
    )
  )
    reason = 'challenge';
  if (
    observation &&
    !reason &&
    /(?:sign in to continue|log in to continue|please sign in)/iu.test(observation.snapshot)
  )
    reason = 'sign_in_wall';
  return {
    status: reason ? 'stopped' : 'completed',
    ...(reason ? { reason } : {}),
    actions: results,
    ...(images.length ? { images } : {}),
    ...(observation ? { observation } : {}),
    repeat_safe: repeatSafe,
  };
}

registerBrowserQueuedAction('browser', { validate: validateBrowserBatch, execute: executeBrowserBatch });
