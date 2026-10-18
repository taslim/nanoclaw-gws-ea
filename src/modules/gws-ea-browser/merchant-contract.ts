import type { ElementHandle, Page } from 'playwright-core';
import type { ReviewedMerchantFlow } from './commit-classifier.js';
import type { CheckoutBox } from './control-facts.js';
import type { FinancialCommitment, FreeCommitFacts, PurchaseFacts, ReservationFacts } from './fingerprint.js';

/**
 * Where a checkout's total and its commit control sit on the page, on the main frame's viewport as read: the
 * picture the card carries shows exactly these.
 */
export interface CheckoutRegions {
  readonly total?: CheckoutBox;
  readonly control: CheckoutBox;
}
/** What a paid checkout with no saved payment method reports (R12): never anything typed into it. */
export interface CardNeeded {
  readonly site: string;
  readonly account?: string;
  readonly items?: readonly string[];
  readonly total?: string;
}

/**
 * A checkout as a signature reads it. `free` and `card_needed` are the generic signature's (KTD3, KTD5);
 * `facts_incomplete` names what could not be read, as does a reviewed flow whose page no longer matches it.
 */
export type MerchantCheckoutRead =
  | { status: 'ready'; facts: PurchaseFacts; element: ElementHandle; regions?: CheckoutRegions }
  | { status: 'free'; facts: FreeCommitFacts; element: ElementHandle }
  | { status: 'card_needed'; needed: CardNeeded }
  | { status: 'facts_incomplete'; missing: readonly string[] }
  | { status: 'terms_unavailable' | 'checkout_lapsed' };

/** What a reviewed flow answers for a page it no longer matches: it fails closed, naming its checkout. */
export const REVIEWED_CHECKOUT_MISSING: MerchantCheckoutRead = {
  status: 'facts_incomplete',
  missing: ["the site's reviewed checkout"],
};

export interface MerchantPurchaseEvidence {
  flowId: string;
  source: string;
  recordId: string;
  orderedAt: string;
  resolution: 'committed' | 'not_committed';
  account: string;
  items: PurchaseFacts['items'];
  totalMinor: number;
  currency: string;
  cardEnding: string | null;
  address: string | null;
  checkoutReference?: string;
  reservation?: ReservationFacts;
}

export interface ReservationAvailabilitySlot {
  /** One-way identity of native inventory. Never a reusable booking token. */
  id: string;
  reservation: ReservationFacts;
}
export type ReservationAvailability =
  | {
      status: 'ready';
      site: string;
      venue: { id: string; name: string };
      partySize: number;
      currency: string;
      timeZone: string;
      slots: ReservationAvailabilitySlot[];
    }
  | { status: 'blocked' | 'unavailable' };

export interface ReservationPolicy {
  currency: string;
  dueNowMinor: number;
  commitments: Array<Omit<FinancialCommitment, 'cancellationDeadline'> & { cancellationBeforeMs?: number }>;
  noCommitmentTerms?: string;
}

/** Trusted source code supplies signatures. Pages, model recipes and tools cannot register one. */
export interface MerchantSignature extends ReviewedMerchantFlow {
  readonly evidenceOrigins: readonly string[];
  preparePage?(page: Page): Promise<void>;
  /**
   * Reads the checkout `target` commits, or the page's own commit control. `expected` names the approved
   * checkout a commit re-reads, which a generic signature re-finds by its locator.
   */
  readPurchase(page: Page, target?: ElementHandle, expected?: PurchaseFacts): Promise<MerchantCheckoutRead>;
  /** Starts listening before the sole authorized press. It must settle within timeoutMs. */
  waitForResult(page: Page, timeoutMs: number): Promise<void>;
  readEvidence(page: Page): Promise<MerchantPurchaseEvidence | undefined>;
  readAvailability?(page: Page, expected: { venueId: string; partySize: number }): Promise<ReservationAvailability>;
  readReservationPolicy?(page: Page, venueId: string): Promise<ReservationPolicy | undefined>;
}
