/** Selects a concrete reviewed reader, or the generic reader for an unreviewed site. */
import type { ElementHandle, Page } from 'playwright-core';
import type { PurchaseFacts } from './fingerprint.js';
import { genericCheckoutSignature } from './generic-signature.js';
import type { MerchantCheckoutRead, MerchantPurchaseEvidence, MerchantSignature } from './merchant-contract.js';
import { merchantSignatures } from './merchant-signatures.js';

export type MerchantPurchaseRead =
  | (Extract<MerchantCheckoutRead, { status: 'ready' }> & { signature: MerchantSignature })
  | Exclude<MerchantCheckoutRead, { status: 'ready' }>;

/** The page's reviewed signature, which keeps precedence on its site, else the generic one for any web page. */
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
/**
 * Reads the page's checkout with its signature. A reviewed flow that no longer matches its page fails closed
 * for that flow; it never falls back to the generic one.
 */
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
/** The page's signature's evidence of the purchase `attempted` made. */
export async function readMerchantPurchaseEvidence(
  page: Page,
  attempted: PurchaseFacts,
): Promise<MerchantPurchaseEvidence | undefined> {
  return merchantSignatureFor(page)?.readEvidence(page, attempted);
}
