import type { ElementHandle, Page } from 'playwright-core';
import type { ActivationIntent } from './commit-classifier.js';
import { BrowserConsentStop, runConsentPass } from './consent.js';
import { classifyNavigationUrl, type ActionClass, type ReviewedMerchantFlow } from './control-policy.js';
import { genericCheckoutSignature } from './generic-signature.js';

/**
 * `secret_field`: a press while a field holds a password or code the host filled, which only the host's own sign-in
 * and credential paths submit.
 */
export type ActivationRefusal = Exclude<ActionClass, 'ordinary'> | 'secret_field';

export class BrowserActivationError extends Error {
  constructor(readonly reason: ActivationRefusal) {
    super(reason);
  }
}

/**
 * The consent engine's one check before a submission outside a purchase: every choice in the control's form
 * made, or a stop. An extra the press would still buy makes it a purchase.
 */
export async function consentBeforeSubmission(
  page: Page,
  element: ElementHandle,
  intent: ActivationIntent,
): Promise<void> {
  const consent = await runConsentPass(page, element, { scope: intent.scope, assertActive: intent.assertActive });
  if (consent.status === 'consent_required') throw new BrowserConsentStop(consent.stops);
  if (consent.status === 'add_on') throw new BrowserActivationError('purchase_control');
}

/**
 * An approved purchase's own press, or a free checkout's: the documents and script requests it may send while it
 * runs, beyond the open rule.
 */
export interface ApprovedPress {
  /** The origin of the document the approved control commits from. */
  readonly origin: string;
  matches(url: URL): boolean;
  /** The flow's reading of its own route; undefined for a route it does not know, which stays refused. */
  classify(url: URL): ActionClass | undefined;
}
const approvedPresses = new WeakMap<Page, ApprovedPress>();

/** The page's documents take `admission`'s reading only while `run` presses. */
export async function withApprovedPress<T>(page: Page, admission: ApprovedPress, run: () => Promise<T>): Promise<T> {
  approvedPresses.set(page, admission);
  try {
    return await run();
  } finally {
    approvedPresses.delete(page);
  }
}

export function approvedPressOn(page: Page): ApprovedPress | undefined {
  return approvedPresses.get(page);
}

/**
 * The press an approval, or a free checkout, admits: a reviewed flow's exact control on its page, or a generic
 * checkout's control in its checkout origin. A reviewed flow's page never takes the generic verifier: that flow
 * fails closed.
 */
export async function approvedPress(
  page: Page,
  element: ElementHandle,
  flow: ReviewedMerchantFlow | undefined,
  checkout: { readonly origin: string } | undefined,
): Promise<ApprovedPress | undefined> {
  if (flow) {
    if (!flow.verifyPurchaseControl || !(await flow.verifyPurchaseControl(page, element))) return undefined;
    return {
      origin: new URL(page.url()).origin,
      matches: (url) => flow.matches(url),
      classify: (url) => flow.classifyNavigation(url),
    };
  }
  const frame = await element.ownerFrame();
  if (
    !checkout ||
    !frame ||
    !URL.canParse(frame.url()) ||
    new URL(frame.url()).origin !== checkout.origin ||
    !(await genericCheckoutSignature.verifyPurchaseControl?.(page, element))
  )
    return undefined;
  return {
    origin: checkout.origin,
    matches: (url) => url.origin === checkout.origin,
    classify: (url) => classifyNavigationUrl(url.href),
  };
}

export const DEFAULT_ACTION_BUDGET_MS = 10_000;
