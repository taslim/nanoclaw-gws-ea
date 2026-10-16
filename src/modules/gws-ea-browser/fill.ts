import type { ElementHandle, Page } from 'playwright-core';
import { forbidden } from '../../cli/delivery-action.js';
import {
  authenticationFieldKind,
  browserDiagnosticsUnsafe,
  httpsOrigin,
  inspectAuthenticationControl,
  type AuthenticationFormSignature,
  type BrowserSecretField,
} from './authentication-signatures.js';
import { activateControl, classifyActivation } from './commit-classifier.js';
import {
  fillNativeAuthenticationField,
  inspectNativeAuthenticationControl,
  type NativeAuthenticationBinding,
} from './authentication-submit.js';
import { registerPageSecret, bindPageSecretDocuments, releasePageSecret, type PinnedBrowserRef } from './observe.js';
import type { BrowserExecutionContext } from './queue.js';

export interface BoundBrowserSecretField {
  readonly page: Page;
  readonly target: PinnedBrowserRef;
  readonly submit: PinnedBrowserRef;
  readonly origin: string;
  readonly field: BrowserSecretField;
  readonly authentication: AuthenticationFormSignature;
  readonly nativeField: NativeAuthenticationBinding;
}
export type BrowserSecretFillResult = { status: 'submitted' | 'cleared_after_submit' | 'origin_mismatch' };

/** The bound field's frame no longer shows the exact HTTPS origin it was bound on. */
export class BrowserOriginMismatchError extends Error {
  constructor() {
    super('origin_mismatch');
  }
}

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
    throw new BrowserOriginMismatchError();
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
  const nativeField = authentication && (await inspectNativeAuthenticationControl(target.element, target.frame));
  if (
    !authentication ||
    !nativeField ||
    nativeField.facts.control.tag !== 'INPUT' ||
    authenticationFieldKind(nativeField.facts.control) !== field ||
    nativeField.frameId !== authentication.native.frameId ||
    nativeField.loaderId !== authentication.native.loaderId ||
    nativeField.formBackendNodeId !== authentication.native.formBackendNodeId ||
    (await classifyActivation(page, submit.element)) !== 'ordinary'
  )
    throw forbidden(
      'This sign-in flow is unsupported. Take a fresh observation or use another supported sign-in method.',
    );
  return { page, target, submit, origin: origin.origin, field, authentication, nativeField };
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
    if (
      JSON.stringify(rebound.nativeField) !== JSON.stringify(binding.nativeField) ||
      JSON.stringify(rebound.authentication.native) !== JSON.stringify(binding.authentication.native)
    )
      return { status: 'origin_mismatch' };
    await context.assertActive();
    assertBrowserSecretDiagnosticsSafe();
    value = await resolve();
    await context.assertActive();
    if (!value) throw forbidden('No sign-in value is available.');
    registerPageSecret(page, value);
    await bindPageSecretDocuments(page, value);
    if (!(await originMatches(binding, permitsOrigin))) return { status: 'origin_mismatch' };
    assertBrowserSecretDiagnosticsSafe();
    if (
      !(await fillNativeAuthenticationField(
        target.frame,
        rebound.nativeField,
        rebound.authentication.native,
        value,
        async () => {
          await context.assertActive();
          assertBrowserSecretDiagnosticsSafe();
        },
      ))
    )
      return { status: 'origin_mismatch' };
    await context.assertActive();
    if ((await target.element.inputValue()) !== value)
      throw forbidden('The sign-in field changed. Take a fresh observation.');
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
    if (error instanceof BrowserOriginMismatchError) return { status: 'origin_mismatch' };
    // Playwright exceptions may carry values or page text; only constant host prose crosses this boundary.
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
