import type { ElementHandle, Page } from 'playwright-core';
import { ActionRefusal, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import {
  authenticationFieldKind,
  inspectAuthenticationControl,
  type AuthenticationFormSignature,
} from './authentication-signatures.js';
import { activateControl, classifyActivation, withBrowserJobNavigation } from './commit-classifier.js';
import {
  browserDiagnosticsUnsafe,
  browserVault,
  BrowserVaultError,
  httpsOrigin,
  type BrowserSecretField,
} from './onepassword.js';
import {
  disposeBrowserRefs,
  pinBrowserRefs,
  readBrowserRef,
  registerPageSecret,
  bindPageSecretDocuments,
  releasePageSecret,
  registerBrowserSiteInfoProvider,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import { registerBrowserQueuedAction, type BrowserExecutionContext } from './queue.js';

export interface BoundBrowserSecretField {
  readonly page: Page;
  readonly target: PinnedBrowserRef;
  readonly submit: PinnedBrowserRef;
  readonly origin: string;
  readonly field: BrowserSecretField;
  readonly authentication: AuthenticationFormSignature;
}
export type BrowserSecretFillResult = {
  status:
    | 'submitted'
    | 'cleared_after_submit'
    | 'origin_mismatch'
    | 'no_item_for_site'
    | 'vault_unavailable'
    | 'rate_limited';
};

export function assertBrowserSecretDiagnosticsSafe(): void {
  if (browserDiagnosticsUnsafe())
    throw forbidden('Disable Playwright debug logging before signing in with the host browser.');
}

async function fieldKind(element: ElementHandle): Promise<BrowserSecretField | undefined> {
  const facts = await element.evaluate((node) => {
    const e = node as unknown as { tagName: string; getAttribute(name: string): string | null };
    return {
      tag: e.tagName,
      name: e.getAttribute('name') ?? '',
      type: e.getAttribute('type') ?? 'text',
      autocomplete: e.getAttribute('autocomplete') ?? '',
    };
  });
  return facts.tag === 'INPUT' ? authenticationFieldKind(facts) : undefined;
}

/** The binding is host-only. Retain its pinned handles for a relay; never serialize it into a tool result. */
export async function bindBrowserSecretField(
  page: Page,
  target: PinnedBrowserRef,
  submit: PinnedBrowserRef,
  field: BrowserSecretField,
): Promise<BoundBrowserSecretField> {
  const origin = httpsOrigin(target.frame.url());
  if (!origin || target.frame !== submit.frame || httpsOrigin(submit.frame.url())?.origin !== origin.origin)
    throw new BrowserVaultError('origin_mismatch');
  if (
    (await target.element.ownerFrame()) !== target.frame ||
    (await submit.element.ownerFrame()) !== target.frame ||
    (await fieldKind(target.element)) !== field
  )
    throw forbidden('Choose a current username, password or one-time-code field from a fresh observation.');
  const sameForm = await target.element.evaluate((node, control) => {
    const input = node as unknown as { form?: unknown; isConnected: boolean };
    const submit = control as unknown as { form?: unknown; isConnected: boolean };
    return input.isConnected && submit.isConnected && Boolean(input.form) && input.form === submit.form;
  }, submit.element);
  const authentication = sameForm && (await inspectAuthenticationControl(submit.element));
  if (!authentication || (await classifyActivation(page, submit.element)) !== 'ordinary')
    throw forbidden(
      'This sign-in flow is unsupported. Take a fresh observation or use another supported sign-in method.',
    );
  return { page, target, submit, origin: origin.origin, field, authentication };
}

async function originMatches(
  binding: BoundBrowserSecretField,
  permitsOrigin?: (origin: URL) => boolean,
): Promise<boolean> {
  const origin = httpsOrigin(binding.target.frame.url());
  return Boolean(
    origin &&
    origin.origin === binding.origin &&
    (!permitsOrigin || permitsOrigin(origin)) &&
    (await binding.target.element.ownerFrame()) === binding.target.frame &&
    (await binding.submit.element.ownerFrame()) === binding.target.frame,
  );
}
async function focused(binding: BoundBrowserSecretField): Promise<boolean> {
  if ((await fieldKind(binding.target.element)) !== binding.field) return false;
  return binding.target.element.evaluate((node) => {
    const e = node as unknown as {
      isConnected: boolean;
      disabled: boolean;
      readOnly: boolean;
      ownerDocument: { activeElement: unknown };
    };
    return e.isConnected && !e.disabled && !e.readOnly && e.ownerDocument.activeElement === node;
  });
}

/** No secret is ever passed to an evaluate expression, locator fill, a logger or a response. */
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

/** Caller owns the queue's exclusive job lock; resolve remains lazy until the pinned HTTPS checks pass. */
export async function fillBoundBrowserSecret(
  context: BrowserExecutionContext,
  binding: BoundBrowserSecretField,
  resolve: () => Promise<string>,
  permitsOrigin?: (origin: URL) => boolean,
): Promise<BrowserSecretFillResult> {
  assertBrowserSecretDiagnosticsSafe();
  const { page, target, submit } = binding;
  let value: string | undefined;
  let navigated = false;
  const navigation = (frame: ReturnType<Page['mainFrame']>): void => {
    if (frame === target.frame) navigated = true;
  };
  page.on('framenavigated', navigation);
  try {
    await context.assertActive();
    if (!(await originMatches(binding, permitsOrigin))) return { status: 'origin_mismatch' };
    // A previously bound field/control may have been replaced or changed during an email wait.
    const rebound = await bindBrowserSecretField(page, target, submit, binding.field);
    if (rebound.authentication.action !== binding.authentication.action) return { status: 'origin_mismatch' };
    await context.assertActive();
    assertBrowserSecretDiagnosticsSafe();
    value = await resolve();
    await context.assertActive();
    if (!value) throw forbidden('No sign-in value is available.');
    registerPageSecret(page, value);
    await bindPageSecretDocuments(page, value);
    if (!(await originMatches(binding, permitsOrigin))) return { status: 'origin_mismatch' };
    await target.element.focus();
    if (!(await focused(binding))) throw forbidden('The sign-in field changed focus. Take a fresh observation.');
    await target.element.evaluate((node) => {
      (node as unknown as { value: string }).value = '';
    });
    await context.assertActive();
    if (!(await originMatches(binding, permitsOrigin))) return { status: 'origin_mismatch' };
    if (!(await focused(binding))) throw forbidden('The sign-in field changed focus. Take a fresh observation.');
    // Recheck after the final asynchronous liveness check, immediately before native insertion.
    await context.assertActive();
    if (!(await originMatches(binding, permitsOrigin)) || !(await focused(binding)))
      return { status: 'origin_mismatch' };
    assertBrowserSecretDiagnosticsSafe();
    await page.keyboard.insertText(value);
    await context.assertActive();
    if (!(await focused(binding)) || (await target.element.inputValue()) !== value)
      throw forbidden('The sign-in field changed focus. Take a fresh observation.');
    if (!(await originMatches(binding, permitsOrigin))) return { status: 'origin_mismatch' };
    await context.assertActive();
    await activateControl(
      page,
      submit.element,
      async () => {
        throw forbidden('This sign-in flow requires native form submission.');
      },
      undefined,
      { kind: 'submit', assertActive: context.assertActive },
    );
    await context.assertActive();
    return { status: navigated ? 'submitted' : 'cleared_after_submit' };
  } catch (error) {
    if (error instanceof BrowserVaultError) return { status: error.reason };
    // SDK and Playwright exceptions may carry values or page text; only constant host prose crosses this boundary.
    throw forbidden('The host could not safely complete this sign-in. Take a fresh observation.');
  } finally {
    page.off('framenavigated', navigation);
    if (value) {
      const cleared = await clearValueEverywhere(page, value);
      if (!cleared && !page.isClosed()) await context.runtime.closeJob(context.job.id).catch(() => undefined);
      if (cleared || page.isClosed()) releasePageSecret(page, value);
    }
  }
}

/** Only a host-reviewed email->OTP form transition on the recorded origin can replace a waiting field. */
export async function discoverAuthenticationCodeField(
  page: Page,
  previous: BoundBrowserSecretField,
): Promise<BoundBrowserSecretField | undefined> {
  // Email submission commonly replaces the entire document. The recorded frame and exact origin
  // survive that navigation; the old element handles deliberately need not survive it.
  if (
    previous.page !== page ||
    !page.frames().includes(previous.target.frame) ||
    httpsOrigin(previous.target.frame.url())?.origin !== previous.origin
  )
    return undefined;
  const fields = previous.target.frame.locator('input[autocomplete="one-time-code"]');
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
    const target = { ...previous.target, element };
    const bound = await bindBrowserSecretField(page, target, { ...previous.submit, element: submit }, 'otp');
    return bound;
  } catch (_error) {
    await element.dispose();
    await control.dispose();
    return undefined;
  }
}

interface FillSecretPayload extends Record<string, unknown> {
  item_handle: string;
  field: BrowserSecretField;
  target: BrowserRef;
  submit: BrowserRef;
}
export function validateFillSecret(content: Record<string, unknown>): FillSecretPayload {
  if (
    Object.keys(content).some(
      (key) => !['action', 'requestId', 'budget_ms', 'item_handle', 'field', 'target', 'submit'].includes(key),
    ) ||
    typeof content.item_handle !== 'string' ||
    !/^vault_[a-z\d_-]{1,100}$/iu.test(content.item_handle) ||
    !['username', 'password', 'otp'].includes(String(content.field))
  )
    throw invalidArgs('Choose a listed vault item and a username, password or one-time-code field.');
  const message = 'Choose a field and submit control from a fresh observation.';
  return {
    item_handle: content.item_handle,
    field: content.field as BrowserSecretField,
    target: readBrowserRef(content.target, message),
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
      refs = await pinBrowserRefs(page, [payload.target, payload.submit]);
      const binding = await bindBrowserSecretField(
        page,
        refs.get(payload.target.ref)!,
        refs.get(payload.submit.ref)!,
        payload.field,
      );
      return await fillBoundBrowserSecret(context, binding, () =>
        browserVault.resolve(payload.item_handle, payload.field, binding.origin, context.assertActive),
      );
    } catch (error) {
      if (error instanceof BrowserVaultError) return { status: error.reason };
      if (error instanceof ActionRefusal) throw error;
      throw forbidden('Choose a supported sign-in field and submit control from a fresh observation.');
    } finally {
      await disposeBrowserRefs(refs);
    }
  });
}

registerBrowserQueuedAction('fill_secret', { validate: validateFillSecret, execute: executeFillSecret });
registerBrowserSiteInfoProvider(async (page, origin, assertActive) => {
  try {
    const origins = new Set([
      origin,
      ...page.frames().flatMap((frame) => {
        const url = httpsOrigin(frame.url());
        return url ? [url.origin] : [];
      }),
    ]);
    const items = new Map<string, { item_handle: string; title: string }>();
    for (const frameOrigin of origins)
      for (const item of await browserVault.itemsForOrigin(frameOrigin, assertActive))
        items.set(item.item_handle, item);
    return { vault_items: [...items.values()] };
  } catch (error) {
    return { vault_status: error instanceof BrowserVaultError ? error.reason : 'vault_unavailable' };
  }
});
