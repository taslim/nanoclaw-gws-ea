import { errors, type ElementHandle, type Page } from 'playwright-core';
import {
  approvedPress,
  BrowserActivationError,
  consentBeforeSubmission,
  DEFAULT_ACTION_BUDGET_MS,
  withApprovedPress,
  type ApprovedPress,
} from './activation.js';
import type { ActivationIntent, BrowserNavigationGuard } from './commit-classifier.js';
import { reviewedMerchantFlow } from './control-policy.js';
import { genericCheckoutSignature } from './generic-signature.js';
import { readFreeCheckout, type FreeCheckout } from './merchant-read.js';
import { mainDocumentLoader, pageFieldHoldsHostSecret } from './page-privacy.js';

/** The job a free checkout's press belongs to, and what the press spends. */
export interface FreePressScope {
  readonly jobId: string;
  /** Runs once every check has passed, immediately before the press: claims what a booking spends in the job. */
  pressStarting(checkout: FreeCheckout, at: string): Promise<FreePressStart>;
}

/** A free press about to run, and how what it claimed settles. */
export interface FreePressStart {
  /** The merchant's paid attempts whose outcome nobody has recorded, which the press does not wait on. */
  readonly unresolved: readonly string[];
  /** When the press ran, as the agent reads it: on the principal's clock. */
  readonly pressedAt: string;
  /** The press may have reached the site: what it claimed is spent. */
  reached(): Promise<void>;
  /** The press proved it never reached the page: what it claimed goes back as it was. */
  neverReached(): Promise<void>;
}

/** A free checkout's press: the merchant, when, and the merchant's paid attempts nobody has recorded an outcome for. */
export interface FreePressFacts {
  readonly site: string;
  readonly pressed_at: string;
  readonly unresolved_attempts?: readonly string[];
}
/** What a free checkout's press answers: pressed now, or the earlier press a repeat would have repeated. */
export type FreePressAnswer = FreePressFacts & { readonly status: 'pressed' | 'already_pressed' };

/** A job's last free press: a repeat with the same facts would book the same table twice. */
interface FreePress {
  readonly site: string;
  readonly facts: string;
  readonly at: string;
  /** `at` as the agent reads it. */
  readonly pressedAt: string;
  readonly page: WeakRef<Page>;
}
const freePresses = new Map<string, FreePress>();

/**
 * The dialog a free press opened over its own document: until that document changes, the agent's steps in it load
 * the checkout origin's own purchase routes, as the press did, so a verification step can book. A site's hold on a
 * table lasts minutes, and a code relayed through main may take several.
 */
interface FreeDialog {
  readonly admission: ApprovedPress;
  readonly document: string;
  readonly until: number;
}
const freeDialogs = new WeakMap<Page, FreeDialog>();
const FREE_DIALOG_MS = 15 * 60_000;
const watchedDocuments = new WeakSet<Page>();

export function currentFreeDialog(page: Page): FreeDialog | undefined {
  const dialog = freeDialogs.get(page);
  if (dialog && dialog.until <= Date.now()) freeDialogs.delete(page);
  return freeDialogs.get(page);
}

export function closeFreeDialog(page: Page): void {
  freeDialogs.delete(page);
}

function openFreeDialog(page: Page, dialog: FreeDialog): void {
  freeDialogs.set(page, dialog);
  if (watchedDocuments.has(page)) return;
  watchedDocuments.add(page);
  // A same-document navigation keeps the dialog; a new main document ends it.
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || !freeDialogs.has(page)) return;
    void mainDocumentLoader(page)
      .then((loader) => loader !== freeDialogs.get(page)?.document)
      .catch(() => true)
      .then((changed) => {
        if (changed) freeDialogs.delete(page);
      });
  });
}

/** When job `jobId` last pressed a free checkout, which counts as a step toward a booking. */
export function lastFreePress(jobId: string): { readonly site: string; readonly at: string } | undefined {
  const press = freePresses.get(jobId);
  return press && { site: press.site, at: press.at };
}

/** Whether job `jobId`'s page still shows the dialog its free press opened, where a texted code may still land. */
export function freePressInProgress(jobId: string): boolean {
  const page = freePresses.get(jobId)?.page.deref();
  return Boolean(page && !page.isClosed() && currentFreeDialog(page));
}

/**
 * A free checkout's press, as the host presses an approved one: the consent pass, a fresh read immediately before
 * that finds it still free and unchanged, and the press under the checkout origin's admission. Its script requests
 * to payment processors stay refused. A repeat of the job's last free press with the same facts presses nothing.
 */
export async function pressFreeCheckout(
  page: Page,
  guard: BrowserNavigationGuard,
  element: ElementHandle,
  operation: () => Promise<void>,
  checkout: FreeCheckout,
  intent: ActivationIntent & { readonly freePress: FreePressScope },
): Promise<FreePressAnswer> {
  const scope = intent.freePress;
  const facts = JSON.stringify(checkout.facts);
  // Only on the page it was pressed in: a page the job lost with its dialog leaves a checkout to rebuild and press.
  const earlier = freePresses.get(scope.jobId);
  if (earlier && earlier.page.deref() === page && earlier.site === checkout.site && earlier.facts === facts)
    return { status: 'already_pressed', site: earlier.site, pressed_at: earlier.pressedAt };
  await guard.actionsSettled();
  if (await pageFieldHoldsHostSecret(page)) throw new BrowserActivationError('secret_field');
  await consentBeforeSubmission(page, element, intent);
  const admission = await approvedPress(
    page,
    element,
    reviewedMerchantFlow(new URL(page.url())),
    checkout.facts.flowId === genericCheckoutSignature.id ? { origin: checkout.origin } : undefined,
  );
  if (!admission) throw new BrowserActivationError('purchase_control');
  await intent.assertActive?.();
  // The consent pass may have changed the form: the booking must still read as the same free one.
  const latest = await readFreeCheckout(page, element);
  if (!latest || latest.site !== checkout.site || JSON.stringify(latest.facts) !== facts)
    throw new BrowserActivationError('purchase_control');
  const document = await mainDocumentLoader(page).catch(() => undefined);
  const at = new Date().toISOString();
  const start = await scope.pressStarting(checkout, at);
  freePresses.set(scope.jobId, { site: checkout.site, facts, at, pressedAt: start.pressedAt, page: new WeakRef(page) });
  // Until the click runs, and again when it fails before dispatching, nothing reached the site.
  let reached = false;
  const press = async (): Promise<void> => {
    reached = true;
    try {
      await operation();
    } catch (error) {
      if (neverDispatched(error)) reached = false;
      throw error;
    }
  };
  try {
    await withApprovedPress(page, admission, () =>
      guard.duringAction(intent.remaining?.() ?? DEFAULT_ACTION_BUDGET_MS, press, {
        purchaseAdmission: admission,
      }),
    );
  } finally {
    // A press that may have landed is never repeated, and an earlier dialog's admission never outlives it; one that
    // never ran leaves the job as it was.
    if (reached) {
      freeDialogs.delete(page);
      await start.reached();
    } else {
      if (earlier) freePresses.set(scope.jobId, earlier);
      else freePresses.delete(scope.jobId);
      await start.neverReached();
    }
  }
  // A press that loaded a new document opened no dialog over the checkout: later steps are ordinary.
  if (document && !page.isClosed() && (await mainDocumentLoader(page).catch(() => undefined)) === document)
    openFreeDialog(page, { admission, document, until: Date.now() + FREE_DIALOG_MS });
  return {
    status: 'pressed',
    site: checkout.site,
    pressed_at: start.pressedAt,
    ...(start.unresolved.length ? { unresolved_attempts: [...start.unresolved] } : {}),
  };
}

/**
 * Whether a press's own failure proves its click never reached the page. Playwright's click waits for nothing after
 * it dispatches, so its timeout means the actionability checks never passed: the control stayed covered, hidden or
 * disabled. The executor answers that timeout as `not_actionable`.
 */
function neverDispatched(error: unknown): boolean {
  return (
    error instanceof errors.TimeoutError ||
    (error instanceof Error && 'reason' in error && error.reason === 'not_actionable')
  );
}
