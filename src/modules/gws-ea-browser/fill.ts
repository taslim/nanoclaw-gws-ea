import type { ElementHandle, Frame, Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ActionRefusal, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import {
  browserDiagnosticsUnsafe,
  codeFieldFits,
  credentialFieldFits,
  httpsOrigin,
  type BrowserSecretField,
} from './authentication-signatures.js';
import { classifyActivation, ensureBrowserNavigationGuard, withBrowserJobNavigation } from './commit-classifier.js';
import { classifyNavigationUrl } from './control-policy.js';
import { BrowserConsentStop, consentStopsForAgent, runConsentPass } from './consent.js';
import {
  activateNativeCredentialControl,
  fillNativeCredentialGroup,
  inspectNativeCredentialControl,
  type NativeCredentialBinding,
  type NativeCredentialFacts,
  type NativeCredentialGroup,
} from './authentication-submit.js';
import { getLoginStore, LoginStoreError, registrableDomain } from './login-store.js';
import { credentialAttempts } from './credential-attempts.js';
import { SiteLeaseStore } from './leases.js';
import {
  disposeBrowserRefs,
  pinBrowserRefs,
  readBrowserRef,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import {
  bindPageSecretDocuments,
  registerPageRedaction,
  registerPageSecret,
  releasePageSecret,
} from './page-privacy.js';
import { browserOperationId, type BrowserExecutionContext, type BrowserQueuedAction } from './actions.js';

export interface BrowserSignInField {
  readonly field: BrowserSecretField;
  readonly target: PinnedBrowserRef;
}
export interface BoundBrowserSecretFields {
  readonly page: Page;
  readonly frame: Frame;
  readonly fields: readonly BrowserSignInField[];
  /** The control the host presses after filling; absent only for an account name the agent submits itself. */
  readonly submit?: PinnedBrowserRef;
  readonly origin: string;
  /** The registrable domain every filled value stays on. */
  readonly site: string;
  readonly native: NativeCredentialGroup;
}
export type BrowserSecretFillResult = {
  status:
    | 'filled'
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
const unfit: Record<BrowserSecretField, string> = {
  username: 'A saved username goes only into an editable text, email or phone field. Take a fresh observation.',
  password: 'A saved password goes only into a masked password field. Take a fresh observation.',
  code: 'An emailed code goes only into a text field, never a card or password field. Take a fresh observation.',
};
const fits = (field: BrowserSecretField, facts: NativeCredentialFacts): boolean =>
  field === 'code'
    ? codeFieldFits(facts)
    : credentialFieldFits(field === 'username' ? 'username' : 'current_password', facts, 'rotation');

/** Why a saved login stays off this page, in words the agent can pass on. */
export function siteMismatchReason(loginSite: string, pageSite: string | undefined): string {
  return `This saved login is for ${loginSite}, but this sign-in page is on ${pageSite ?? 'no public HTTPS site'}. The host fills a login only on its own site.`;
}

async function checkSignInControl(page: Page, submit: PinnedBrowserRef): Promise<void> {
  if ((await classifyActivation(page, submit.element)) !== 'ordinary') throw unsupported();
}

const sameSignInBinding = (left: NativeCredentialGroup, right: NativeCredentialGroup): boolean => {
  const shape = (group: NativeCredentialGroup): string =>
    JSON.stringify(group, (key: string, value: unknown) =>
      key === 'readonly' || key === 'disabled' || key === 'required' ? undefined : value,
    );
  return shape(left) === shape(right);
};

async function signInConsent(context: BrowserExecutionContext, page: Page, submit: PinnedBrowserRef): Promise<void> {
  const consent = await runConsentPass(page, submit.element, {
    scope: { jobId: context.job.id, db: context.store.db },
    assertActive: context.assertActive,
  });
  if (consent.status === 'consent_required') throw new BrowserConsentStop(consent.stops);
  if (consent.status !== 'ready') throw unsupported();
}

/**
 * Bind the agent's fields as one group on `site`, its registrable domain: each field by its type, never by the
 * form around it, so JavaScript-controlled and formless pages bind like native forms. Where the values may go
 * once filled is decided at the submission, not here.
 */
export async function bindBrowserSecretFields(
  page: Page,
  fields: readonly BrowserSignInField[],
  submit: PinnedBrowserRef | undefined,
  site: string,
): Promise<BoundBrowserSecretFields> {
  const frame = fields[0]?.target.frame;
  const origin = frame && httpsOrigin(frame.url());
  if (
    !frame ||
    !origin ||
    registrableDomain(origin.origin) !== site ||
    fields.some(({ target }) => target.frame !== frame) ||
    (submit && submit.frame !== frame)
  )
    throw new BrowserOriginMismatchError();
  const elements = [...fields.map(({ target }) => target.element), ...(submit ? [submit.element] : [])];
  if (new Set(fields.map(({ field }) => field)).size !== fields.length || new Set(elements).size !== elements.length)
    throw unsupported();
  for (const element of elements) if ((await element.ownerFrame()) !== frame) throw new BrowserOriginMismatchError();
  const bound: NativeCredentialBinding[] = [];
  for (const { field, target } of fields) {
    const node = await inspectNativeCredentialControl(target.element, frame);
    if (!node || node.facts.tag !== 'INPUT' || node.facts.origin !== origin.origin) throw unsupported();
    // A read-only or disabled field only displays what the account already is; its value is not the host's to set.
    if (node.facts.readonly || node.facts.disabled) throw new BrowserOriginMismatchError();
    if (!fits(field, node.facts)) throw forbidden(unfit[field]);
    bound.push(node);
  }
  // A fill the agent submits itself anchors its document on its own field.
  const control = submit ? await inspectNativeCredentialControl(submit.element, frame) : bound[0];
  if (
    !control ||
    control.facts.origin !== origin.origin ||
    bound.some(
      (node) =>
        node.frameId !== control.frameId ||
        node.loaderId !== control.loaderId ||
        node.formBackendNodeId !== bound[0].formBackendNodeId,
    ) ||
    (control.formBackendNodeId !== null && control.formBackendNodeId !== bound[0].formBackendNodeId)
  )
    throw unsupported();
  if (submit) await checkSignInControl(page, submit);
  return {
    page,
    frame,
    fields,
    ...(submit ? { submit } : {}),
    origin: origin.origin,
    site,
    native: { control, fields: bound },
  };
}

async function originMatches(binding: BoundBrowserSecretFields): Promise<boolean> {
  const origin = httpsOrigin(binding.frame.url());
  const elements = [
    ...binding.fields.map(({ target }) => target.element),
    ...(binding.submit ? [binding.submit.element] : []),
  ];
  return Boolean(
    origin &&
    origin.origin === binding.origin &&
    (await Promise.all(elements.map(async (element) => (await element.ownerFrame()) === binding.frame))).every(Boolean),
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
async function activateBoundBrowserSignIn(
  context: BrowserExecutionContext,
  binding: BoundBrowserSecretFields,
  submit: PinnedBrowserRef,
  values: readonly string[],
): Promise<void> {
  const until = Date.now() + Math.min(3000, Math.max(0, context.remaining() - 2000));
  for (;;) {
    await signInConsent(context, binding.page, submit);
    await checkSignInControl(binding.page, submit);
    assertBrowserSecretDiagnosticsSafe();
    const activated = await activateNativeCredentialControl(
      binding.frame,
      binding.native,
      values,
      context.assertActive,
    );
    if (activated === 'activated' || activated === 'uncertain') return;
    if (activated !== 'disabled' || Date.now() >= until) throw unsupported();
    await sleep(100);
  }
}

const carriesValue = (url: URL, values: readonly string[]): boolean =>
  values.some(
    (value) =>
      url.href.includes(value) ||
      url.href.includes(encodeURIComponent(value)) ||
      [...url.searchParams.values()].some((part) => part.includes(value)),
  );

/**
 * Resolve only after the destination, current controls, consent and site lease are checked. A password or code
 * is filled, submitted and cleared in this one call; while it is on the page, no document request may carry it in
 * its address, no document but a GET may leave its site, which answers `origin_mismatch`, and no other request may
 * carry it to another site. That refusal is only recorded: the page's captcha and telemetry go to other sites as it
 * submits, and its sign-in still succeeds. An account name the agent submits itself stays in its field, redacted, for
 * the agent's own press.
 */
export async function fillBoundBrowserSecrets(
  context: BrowserExecutionContext,
  binding: BoundBrowserSecretFields,
  resolve: () => Promise<readonly string[]>,
): Promise<BrowserSecretFillResult> {
  assertBrowserSecretDiagnosticsSafe();
  const { page, fields, submit } = binding;
  if (!submit && fields.some(({ field }) => field !== 'username')) throw unsupported();
  let values: readonly string[] = [];
  let navigated = false;
  let nativeFilled = false;
  let fillCompleted = false;
  let activationCompleted = false;
  let departed = false;
  let releaseHold: (() => void) | undefined;
  const navigation = (frame: Frame): void => {
    if (frame === binding.frame) navigated = true;
  };
  page.on('framenavigated', navigation);
  try {
    await context.assertActive();
    if (!(await originMatches(binding))) return { status: 'origin_mismatch' };
    const rebound = await bindBrowserSecretFields(page, fields, submit, binding.site);
    if (!sameSignInBinding(rebound.native, binding.native)) return { status: 'origin_mismatch' };
    const lease = await new SiteLeaseStore(context.store.db).acquire(context.job.id, binding.origin);
    await context.wakeWaiters(lease.waitingJobs, `${browserOperationId(context)}:sign-in-lease`);
    if (!lease.acquired) return { status: 'site_busy' };
    if (submit) await signInConsent(context, page, submit);
    assertBrowserSecretDiagnosticsSafe();
    values = await resolve();
    await context.assertActive();
    if (values.length !== fields.length || values.some((value) => !value)) throw unsupported();
    if (!(await originMatches(binding))) return { status: 'origin_mismatch' };
    let current: BoundBrowserSecretFields;
    try {
      current = await bindBrowserSecretFields(page, fields, submit, binding.site);
      // eslint-disable-next-line no-catch-all/no-catch-all -- A changed or vanished renderer binding refuses without exposing page prose.
    } catch {
      return { status: 'origin_mismatch' };
    }
    if (!sameSignInBinding(current.native, rebound.native)) return { status: 'origin_mismatch' };
    for (const [index, value] of values.entries()) {
      // An account name is no secret the page must hide: only redacted, it leaves the agent's own presses free.
      if (fields[index].field === 'username') registerPageRedaction(page, value);
      else {
        registerPageSecret(page, value);
        await bindPageSecretDocuments(page, value);
      }
    }
    const guard = await ensureBrowserNavigationGuard(page);
    const fill = async (): Promise<void> => {
      assertBrowserSecretDiagnosticsSafe();
      const filled = await fillNativeCredentialGroup(binding.frame, current.native, values, context.assertActive);
      nativeFilled = filled !== 'not_inserted';
      if (filled !== 'filled') throw unsupported();
      fillCompleted = true;
    };
    if (!submit) {
      await guard.duringAction(context.remaining(), fill);
      return { status: 'filled' };
    }
    const secrets = values.filter((_value, index) => fields[index].field !== 'username');
    // From the first input callback until the values are cleared, page script cannot send them to another site.
    const hold = `fill:${randomUUID()}`;
    guard.holdSubmissions(hold, {
      site: binding.site,
      values: secrets,
      departed: () => {
        departed = true;
      },
    });
    releaseHold = () => guard.allowSubmissions(hold);
    await guard.runWithPolicy(
      {
        classify(url) {
          if (!httpsOrigin(url.href) || carriesValue(url, secrets)) {
            departed = true;
            return 'blocked_address';
          }
          return classifyNavigationUrl(url.href);
        },
      },
      () =>
        guard.duringAction(
          context.remaining(),
          async () => {
            await fill();
            await activateBoundBrowserSignIn(context, current, submit, values);
            activationCompleted = true;
          },
          { waitForRequests: true },
        ),
    );
    await context.assertActive();
    if (departed) return { status: 'origin_mismatch' };
    return { status: navigated ? 'submitted' : 'cleared_after_submit' };
  } catch (error) {
    if (error instanceof BrowserOriginMismatchError) return { status: 'origin_mismatch' };
    if (error instanceof LoginStoreError) return { status: error.reason };
    if (error instanceof BrowserConsentStop) throw error;
    if (error instanceof ActionRefusal && !nativeFilled) throw error;
    throw forbidden('The host could not safely complete this sign-in. Take a fresh observation.');
  } finally {
    page.off('framenavigated', navigation);
    // Keep a carried account name after activation or navigation, or in its field for the agent's own press;
    // a refused fill has no next step to preserve.
    const clearUsername = nativeFilled && (submit ? !activationCompleted && !navigated : !fillCompleted);
    const secrets = values.filter((_value, index) => fields[index]?.field !== 'username' || clearUsername);
    if (secrets.length) await settleFilledSecrets(context, page, secrets);
    releaseHold?.();
  }
}

interface FillSecretPayload extends Record<string, unknown> {
  item_handle: string;
  username?: BrowserRef;
  password?: BrowserRef;
  submit?: BrowserRef;
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
  // The host submits a password in the same call it fills it, so a password always needs its control.
  if (content.password !== undefined && content.submit === undefined)
    throw invalidArgs('Choose the control that submits the password field.');
  const message = 'Choose the current sign-in fields and submit control from a fresh observation.';
  return {
    item_handle: handle,
    ...(content.username === undefined ? {} : { username: readBrowserRef(content.username, message) }),
    ...(content.password === undefined ? {} : { password: readBrowserRef(content.password, message) }),
    ...(content.submit === undefined ? {} : { submit: readBrowserRef(content.submit, message) }),
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
      refs = await pinBrowserRefs(page, [...chosen.map(({ ref }) => ref), ...(payload.submit ? [payload.submit] : [])]);
      const store = await getLoginStore();
      const login = await store.get(payload.item_handle);
      const pageSite = registrableDomain(refs.get(chosen[0].ref.ref)!.frame.url());
      if (pageSite !== login.domain)
        return { status: 'origin_mismatch', reason: siteMismatchReason(login.domain, pageSite) };
      const binding = await bindBrowserSecretFields(
        page,
        chosen.map(({ field, ref }) => ({ field, target: refs.get(ref.ref)! })),
        payload.submit && refs.get(payload.submit.ref),
        login.domain,
      );
      return await fillBoundBrowserSecrets(context, binding, async () => {
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
      if (error instanceof BrowserConsentStop)
        return { status: 'stopped', reason: error.reason, consent: consentStopsForAgent(error.stops) };
      if (error instanceof ActionRefusal) throw error;
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
