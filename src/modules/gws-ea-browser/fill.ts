import type { ElementHandle, Page } from 'playwright-core';
import { setTimeout as sleep } from 'node:timers/promises';
import { ActionRefusal, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import {
  authenticationFieldKind,
  browserDiagnosticsUnsafe,
  httpsOrigin,
  type BrowserSecretField,
} from './authentication-signatures.js';
import { classifyActivation, ensureBrowserNavigationGuard, withBrowserJobNavigation } from './commit-classifier.js';
import { classifyNavigationUrl } from './control-policy.js';
import { readPageControlFacts } from './control-facts.js';
import { BrowserConsentStop, runConsentPass } from './consent.js';
import {
  activateNativeCredentialControl,
  fillNativeCredentialGroup,
  inspectNativeCredentialControl,
  readNativeDocumentFields,
  type NativeCredentialGroup,
  type NativeFieldFacts,
} from './authentication-submit.js';
import { getLoginStore, LoginStoreError } from './login-store.js';
import { credentialAttempts } from './credential-attempts.js';
import { SiteLeaseStore } from './leases.js';
import {
  disposeBrowserRefs,
  pinBrowserRefs,
  readBrowserRef,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import { registerPageSecret, bindPageSecretDocuments, releasePageSecret } from './page-privacy.js';
import { browserOperationId, type BrowserExecutionContext, type BrowserQueuedAction } from './actions.js';

export interface BrowserSignInField {
  readonly field: BrowserSecretField;
  readonly target: PinnedBrowserRef;
}
export interface BoundBrowserSecretFields {
  readonly page: Page;
  readonly fields: readonly BrowserSignInField[];
  readonly submit: PinnedBrowserRef;
  readonly origin: string;
  readonly native: NativeCredentialGroup;
}
export type BrowserSecretFillResult = {
  status:
    | 'submitted'
    | 'cleared_after_submit'
    | 'origin_mismatch'
    | 'no_item_for_site'
    | 'vault_unavailable'
    | 'site_busy';
};

export class BrowserOriginMismatchError extends Error {
  constructor() {
    super('origin_mismatch');
  }
}

export function assertBrowserSecretDiagnosticsSafe(): void {
  if (browserDiagnosticsUnsafe())
    throw forbidden(
      'Signing in is unavailable while browser diagnostics could expose credentials. Stop here and tell the agent that sent this errand that sign-in is unavailable.',
    );
}

const unsupported = (): ActionRefusal =>
  forbidden('The sign-in controls changed or include another action. Take a fresh observation.');
const editable = (field: NativeFieldFacts): boolean => field.type !== 'hidden' && !field.readonly && !field.disabled;
const otherSecret = (field: NativeFieldFacts): boolean =>
  /(?:cc-|credit.?card|payment|checkout|order|new-password|security.?question)/iu.test(
    `${field.name} ${field.autocomplete}`,
  ) || ['file', 'image'].includes(field.type);

async function checkSignInControl(page: Page, submit: PinnedBrowserRef): Promise<void> {
  const facts = await readPageControlFacts(page, submit.element);
  if (facts.transaction || (await classifyActivation(page, submit.element)) !== 'ordinary') throw unsupported();
}

async function signInConsent(context: BrowserExecutionContext, binding: BoundBrowserSecretFields): Promise<void> {
  const consent = await runConsentPass(binding.page, binding.submit.element, {
    scope: { jobId: context.job.id, db: context.store.db },
    assertActive: context.assertActive,
  });
  if (consent.status === 'consent_required') throw new BrowserConsentStop(consent.stops);
  if (consent.status !== 'ready') throw unsupported();
}

/** Bind the agent's current fields as one group, including JS-controlled and formless pages. */
export async function bindBrowserSecretFields(
  page: Page,
  fields: readonly BrowserSignInField[],
  submit: PinnedBrowserRef,
): Promise<BoundBrowserSecretFields> {
  const origin = httpsOrigin(submit.frame.url());
  if (
    !origin ||
    !fields.length ||
    fields.some(
      ({ target }) => target.frame !== submit.frame || httpsOrigin(target.frame.url())?.origin !== origin.origin,
    )
  )
    throw new BrowserOriginMismatchError();
  if (
    new Set(fields.map(({ field }) => field)).size !== fields.length ||
    new Set(fields.map(({ target }) => target.element)).size !== fields.length
  )
    throw unsupported();
  const control = await inspectNativeCredentialControl(submit.element, submit.frame);
  if (!control || (await submit.element.ownerFrame()) !== submit.frame) throw unsupported();
  const bound = [];
  for (const { field, target } of fields) {
    if ((await target.element.ownerFrame()) !== submit.frame) throw new BrowserOriginMismatchError();
    const node = await inspectNativeCredentialControl(target.element, target.frame);
    if (
      !node ||
      node.facts.tag !== 'INPUT' ||
      authenticationFieldKind(node.facts) !== field ||
      node.frameId !== control.frameId ||
      node.loaderId !== control.loaderId ||
      node.facts.origin !== origin.origin
    )
      throw unsupported();
    bound.push(node);
  }
  const form = bound[0].formBackendNodeId;
  if (
    bound.some((node) => node.formBackendNodeId !== form) ||
    (control.formBackendNodeId !== null && control.formBackendNodeId !== form)
  )
    throw unsupported();
  for (const node of [control, ...bound]) {
    for (const submission of [node.facts.form, node.facts.override]) {
      if (!submission) continue;
      if (httpsOrigin(submission.action)?.origin !== origin.origin) throw new BrowserOriginMismatchError();
      if (
        (submission.target && submission.target !== '_self') ||
        classifyNavigationUrl(submission.action) !== 'ordinary'
      )
        throw unsupported();
    }
  }
  const native = { control, fields: bound };
  const members = bound[0].facts.form?.fields;
  if (members) {
    if (members.some(otherSecret)) throw unsupported();
    const expected = members
      .filter(editable)
      .map(authenticationFieldKind)
      .filter((kind) => kind !== undefined)
      .sort();
    if (JSON.stringify(expected) !== JSON.stringify(fields.map(({ field }) => field).sort())) throw unsupported();
  } else {
    const others = await readNativeDocumentFields(submit.frame, native, '');
    if (!others || others.some((node) => otherSecret(node) || (editable(node) && authenticationFieldKind(node))))
      throw unsupported();
  }
  await checkSignInControl(page, submit);
  return { page, fields, submit, origin: origin.origin, native };
}

async function originMatches(
  binding: BoundBrowserSecretFields,
  permitsOrigin?: (origin: URL) => boolean,
): Promise<boolean> {
  const origin = httpsOrigin(binding.submit.frame.url());
  return Boolean(
    origin &&
    origin.origin === binding.origin &&
    (!permitsOrigin || permitsOrigin(origin)) &&
    (await binding.submit.element.ownerFrame()) === binding.submit.frame &&
    (
      await Promise.all(
        binding.fields.map(async ({ target }) => (await target.element.ownerFrame()) === binding.submit.frame),
      )
    ).every(Boolean),
  );
}

/** No secret is ever passed to a Playwright evaluate expression, locator fill, logger or response. */
async function clearValueEverywhere(page: Page, value: string): Promise<boolean> {
  let complete = true;
  for (const frame of page.frames()) {
    let elements: ElementHandle[] = [];
    try {
      elements = await frame.locator('input,textarea').elementHandles();
      for (const element of elements) {
        if ((await element.inputValue()) !== value) continue;
        await element.evaluate((node) => {
          (node as unknown as { value: string }).value = '';
        });
        if ((await element.inputValue()) === value) complete = false;
      }
    } catch (_error) {
      complete = false;
    } finally {
      await Promise.all(elements.map((element) => element.dispose().catch(() => undefined)));
    }
  }
  return complete;
}

/**
 * After a host fill: clear every field still holding one of the values, then
 * release their active taint. Redaction and document taint stay for the
 * page's lifetime. A page that cannot be cleared is closed instead.
 */
export async function settleFilledSecrets(
  context: BrowserExecutionContext,
  page: Page,
  values: readonly string[],
): Promise<void> {
  let cleared = true;
  for (const value of values) if (!(await clearValueEverywhere(page, value))) cleared = false;
  if (!cleared && !page.isClosed()) await context.runtime.closeJob(context.job.id).catch(() => undefined);
  if (cleared || page.isClosed()) for (const value of values) releasePageSecret(page, value);
}

/** Activate only within the caller's guarded action window, with current policy and consent. */
export async function activateBoundBrowserSignIn(
  context: BrowserExecutionContext,
  binding: BoundBrowserSecretFields,
  values: readonly string[],
): Promise<void> {
  const { page, submit } = binding;
  const until = Date.now() + Math.min(3000, Math.max(0, context.remaining() - 2000));
  for (;;) {
    await checkSignInControl(page, submit);
    await signInConsent(context, binding);
    assertBrowserSecretDiagnosticsSafe();
    const activated = await activateNativeCredentialControl(submit.frame, binding.native, values, context.assertActive);
    if (activated === 'activated' || activated === 'uncertain') return;
    if (activated !== 'disabled' || Date.now() >= until) throw unsupported();
    await sleep(100);
  }
}

/** Resolve only after the destination, current controls, consent and site lease are checked. */
export async function fillBoundBrowserSecrets(
  context: BrowserExecutionContext,
  binding: BoundBrowserSecretFields,
  resolve: () => Promise<readonly string[]>,
  permitsOrigin?: (origin: URL) => boolean,
): Promise<BrowserSecretFillResult> {
  assertBrowserSecretDiagnosticsSafe();
  const { page, fields, submit } = binding;
  let values: readonly string[] = [];
  let navigated = false;
  const navigation = (frame: ReturnType<Page['mainFrame']>): void => {
    if (frame === submit.frame) navigated = true;
  };
  page.on('framenavigated', navigation);
  try {
    await context.assertActive();
    if (!(await originMatches(binding, permitsOrigin))) return { status: 'origin_mismatch' };
    const rebound = await bindBrowserSecretFields(page, fields, submit);
    if (JSON.stringify(rebound.native) !== JSON.stringify(binding.native)) return { status: 'origin_mismatch' };
    const lease = await new SiteLeaseStore(context.store.db).acquire(context.job.id, binding.origin);
    await context.wakeWaiters(lease.waitingJobs, `${browserOperationId(context)}:sign-in-lease`);
    if (!lease.acquired) return { status: 'site_busy' };
    await signInConsent(context, binding);
    assertBrowserSecretDiagnosticsSafe();
    values = await resolve();
    await context.assertActive();
    if (values.length !== fields.length || values.some((value) => !value)) throw unsupported();
    if (!(await originMatches(binding, permitsOrigin))) return { status: 'origin_mismatch' };
    let current: BoundBrowserSecretFields;
    try {
      current = await bindBrowserSecretFields(page, fields, submit);
      // eslint-disable-next-line no-catch-all/no-catch-all -- A changed or vanished renderer binding refuses without exposing page prose.
    } catch {
      return { status: 'origin_mismatch' };
    }
    if (JSON.stringify(current.native) !== JSON.stringify(rebound.native)) return { status: 'origin_mismatch' };
    for (const value of values) {
      registerPageSecret(page, value);
      await bindPageSecretDocuments(page, value);
    }
    const guard = await ensureBrowserNavigationGuard(page);
    await guard.runWithPolicy(
      {
        classify(url) {
          return !httpsOrigin(url.href) ||
            values.some(
              (value) =>
                url.href.includes(value) ||
                url.href.includes(encodeURIComponent(value)) ||
                [...url.searchParams.values()].some((part) => part.includes(value)),
            )
            ? 'blocked_address'
            : classifyNavigationUrl(url.href);
        },
      },
      () =>
        guard.duringAction(context.remaining(), async () => {
          assertBrowserSecretDiagnosticsSafe();
          const filled = await fillNativeCredentialGroup(submit.frame, current.native, values, context.assertActive);
          if (filled !== 'filled') throw unsupported();
          await activateBoundBrowserSignIn(context, current, values);
        }),
    );
    await context.assertActive();
    return { status: navigated ? 'submitted' : 'cleared_after_submit' };
  } catch (error) {
    if (error instanceof BrowserOriginMismatchError) return { status: 'origin_mismatch' };
    if (error instanceof LoginStoreError) return { status: error.reason };
    if (error instanceof BrowserConsentStop) throw error;
    throw forbidden('The host could not safely complete this sign-in. Take a fresh observation.');
  } finally {
    page.off('framenavigated', navigation);
    if (values.length) await settleFilledSecrets(context, page, values);
  }
}

/** A same-origin email-to-code transition can replace only the previous page's single field. */
export async function discoverAuthenticationCodeField(
  page: Page,
  previous: BoundBrowserSecretFields,
): Promise<BoundBrowserSecretFields | undefined> {
  const frame = previous.submit.frame;
  if (previous.page !== page || !page.frames().includes(frame) || httpsOrigin(frame.url())?.origin !== previous.origin)
    return undefined;
  const fields = frame.locator('input[autocomplete="one-time-code"]');
  if ((await fields.count()) !== 1) return undefined;
  const element = await fields.elementHandle();
  if (!element) return undefined;
  const control = await element.evaluateHandle(
    (node) =>
      (node as unknown as { form?: { querySelector(selector: string): unknown } }).form?.querySelector(
        'button[type="submit"],input[type="submit"],button:not([type])',
      ) ?? null,
  );
  const submit = control.asElement();
  if (!submit) {
    await element.dispose();
    await control.dispose();
    return undefined;
  }
  try {
    return await bindBrowserSecretFields(page, [{ field: 'otp', target: { ...previous.fields[0].target, element } }], {
      ...previous.submit,
      element: submit,
    });
  } catch (_error) {
    await element.dispose();
    await control.dispose();
    return undefined;
  }
}

interface FillSecretPayload extends Record<string, unknown> {
  item_handle: string;
  username?: BrowserRef;
  password?: BrowserRef;
  submit: BrowserRef;
}
export function validateFillSecret(content: Record<string, unknown>): FillSecretPayload {
  const handle = content.item_handle;
  if (
    Object.keys(content).some(
      (key) => !['action', 'requestId', 'budget_ms', 'item_handle', 'username', 'password', 'submit'].includes(key),
    ) ||
    typeof handle !== 'string' ||
    !/^vault_[a-z\d_-]{1,100}$/iu.test(handle) ||
    (content.username === undefined && content.password === undefined)
  )
    throw invalidArgs('Choose a listed saved login and its current username and/or password fields.');
  const message = 'Choose the current sign-in fields and submit control from a fresh observation.';
  return {
    item_handle: handle,
    ...(content.username === undefined ? {} : { username: readBrowserRef(content.username, message) }),
    ...(content.password === undefined ? {} : { password: readBrowserRef(content.password, message) }),
    submit: readBrowserRef(content.submit, message),
  };
}
export async function executeFillSecret(
  context: BrowserExecutionContext,
  content: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = validateFillSecret(content);
  const page = await context.page();
  return withBrowserJobNavigation(context, page, async () => {
    let refs = new Map<string, PinnedBrowserRef>();
    try {
      await context.assertActive();
      const chosen = (['username', 'password'] as const).flatMap((field) =>
        payload[field] ? [{ field, ref: payload[field] }] : [],
      );
      refs = await pinBrowserRefs(page, [...chosen.map(({ ref }) => ref), payload.submit]);
      const binding = await bindBrowserSecretFields(
        page,
        chosen.map(({ field, ref }) => ({ field, target: refs.get(ref.ref)! })),
        refs.get(payload.submit.ref)!,
      );
      return await fillBoundBrowserSecrets(context, binding, async () => {
        const store = await getLoginStore();
        const login = await store.get(payload.item_handle);
        const values: string[] = [];
        for (const { field } of chosen) {
          await context.assertActive();
          values.push(await store.secret(payload.item_handle, field, binding.origin));
        }
        if ((await store.get(payload.item_handle)).version !== login.version)
          throw new LoginStoreError('origin_mismatch');
        return values;
      });
    } catch (error) {
      if (error instanceof BrowserOriginMismatchError) return { status: 'origin_mismatch' };
      if (error instanceof LoginStoreError) return { status: error.reason };
      if (error instanceof ActionRefusal || error instanceof BrowserConsentStop) throw error;
      throw forbidden('Choose current sign-in fields and their submit control from a fresh observation.');
    } finally {
      await disposeBrowserRefs(refs);
    }
  });
}
export const fillSecretAction: BrowserQueuedAction = { validate: validateFillSecret, execute: executeFillSecret };

export async function readVaultSiteInfo(
  origins: readonly string[],
  assertActive: () => Promise<void>,
): Promise<Record<string, unknown>> {
  try {
    const items = new Map<string, { item_handle: string; title: string; account: 'assistant' | 'principal' }>();
    const store = await getLoginStore();
    for (const frameOrigin of origins) {
      await assertActive();
      const choices = await store.forOrigin(frameOrigin);
      for (const item of choices) {
        if (items.has(item.id)) continue;
        await assertActive();
        items.set(item.id, {
          item_handle: item.id,
          title: item.title,
          account: await credentialAttempts.accountForLogin(item),
        });
      }
    }
    return { vault_items: [...items.values()] };
    // eslint-disable-next-line no-catch-all/no-catch-all -- optional login metadata becomes a constant status, never a failed observation
  } catch (_error) {
    return { vault_status: 'vault_unavailable' };
  }
}
