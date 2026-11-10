import type { ElementHandle, Page } from 'playwright-core';
import { ControlFactsUnavailableError, readCheckoutRegion } from './control-facts.js';
import {
  freeCommitBooks,
  isFreeReservation,
  type FreeCommitFacts,
  type GenericBookingFacts,
  type PurchaseFacts,
} from './fingerprint.js';
import { genericCheckoutSignature, offersPayment } from './generic-signature.js';
import type { MerchantCheckoutRead, MerchantPurchaseEvidence, MerchantSignature } from './merchant-contract.js';
import { merchantSignatures } from './merchant-signatures.js';

export type MerchantPurchaseRead =
  | (Extract<MerchantCheckoutRead, { status: 'ready' }> & { signature: MerchantSignature })
  | Exclude<MerchantCheckoutRead, { status: 'ready' }>;

/** A reviewed signature takes precedence on its site; the generic one covers any other web page. */
export function merchantSignatureFor(page: Page): MerchantSignature | undefined {
  try {
    const url = new URL(page.url());
    return (
      merchantSignatures.find((signature) => signature.matches(url)) ??
      (genericCheckoutSignature.matches(url) ? genericCheckoutSignature : undefined)
    );
  } catch {
    return undefined;
  }
}
export async function prepareMerchantPage(page: Page): Promise<void> {
  for (const signature of [...merchantSignatures, genericCheckoutSignature]) await signature.preparePage?.(page);
}
/** A reviewed flow that no longer matches its page fails closed; it never falls back to the generic signature. */
export async function readMerchantPurchase(
  page: Page,
  target?: ElementHandle,
  expected?: PurchaseFacts,
): Promise<MerchantPurchaseRead> {
  const signature = merchantSignatureFor(page);
  if (!signature) return { status: 'checkout_lapsed' };
  const read = await signature.readPurchase(page, target, expected);
  return read.status === 'ready' ? { ...read, signature } : read;
}
export async function readMerchantPurchaseEvidence(
  page: Page,
  attempted: PurchaseFacts,
): Promise<MerchantPurchaseEvidence | undefined> {
  return merchantSignatureFor(page)?.readEvidence(page, attempted);
}

/**
 * A checkout the host presses as an ordinary press: free by the generic test, or a reviewed reservation free by the
 * same test. Its facts are what a repeat press in the same errand compares.
 */
export interface FreeCheckout {
  /** The merchant. */
  readonly site: string;
  /** The checkout origin, whose own routes the press may load. */
  readonly origin: string;
  readonly facts: FreeCommitFacts | PurchaseFacts;
  /** Whether it books rather than buys, which spends a region watch's one booking. */
  readonly books: boolean;
  /** The booking as the page states it, which decides the region watch it spends. */
  readonly booking?: GenericBookingFacts;
}

/**
 * Whether a reviewed reservation is free by the test any site's booking takes: its reviewed facts state no money and
 * no terms, and nothing on the page offers or holds a way to pay. An unreadable page is not.
 */
export async function freeReservation(page: Page, facts: PurchaseFacts, element: ElementHandle): Promise<boolean> {
  if (!isFreeReservation(facts)) return false;
  try {
    return !offersPayment(await readCheckoutRegion(page, element));
  } catch (error) {
    if (error instanceof ControlFactsUnavailableError) return false;
    throw error;
  }
}

/** A read of `element`'s checkout as a free one; undefined for anything paid, unreadable or not a checkout. */
export async function freeCheckoutOf(
  page: Page,
  read: MerchantPurchaseRead,
  element: ElementHandle,
): Promise<FreeCheckout | undefined> {
  if (read.status === 'free')
    return {
      site: read.facts.site,
      origin: read.facts.origin,
      facts: read.facts,
      books: freeCommitBooks(read.facts),
      ...(read.facts.booking ? { booking: read.facts.booking } : {}),
    };
  if (read.status === 'ready' && (await freeReservation(page, read.facts, element)))
    return { site: read.facts.site, origin: read.facts.origin, facts: read.facts, books: true };
  return undefined;
}

/** The free checkout `target` commits, read fresh; the read's own handle goes when it is not `target`. */
export async function readFreeCheckout(page: Page, target: ElementHandle): Promise<FreeCheckout | undefined> {
  const read = await readMerchantPurchase(page, target);
  try {
    return await freeCheckoutOf(page, read, target);
  } finally {
    if ('element' in read && read.element !== target) await read.element.dispose().catch(() => undefined);
  }
}
