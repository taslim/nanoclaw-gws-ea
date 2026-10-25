import type { ElementHandle, Page } from 'playwright-core';
import type { PurchaseFacts } from './fingerprint.js';
import { genericCheckoutSignature } from './generic-signature.js';
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
