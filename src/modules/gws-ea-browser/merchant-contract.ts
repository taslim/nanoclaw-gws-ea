import type { ElementHandle, Page } from 'playwright-core';
import type { ReviewedMerchantFlow } from './commit-classifier.js';
import type { FinancialCommitment, PurchaseFacts, ReservationFacts } from './fingerprint.js';

export type MerchantCheckoutRead =
  | { status: 'ready'; facts: PurchaseFacts; element: ElementHandle }
  | { status: 'unsupported_merchant' | 'terms_unavailable' | 'checkout_lapsed' };

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
  readPurchase(page: Page, target?: ElementHandle): Promise<MerchantCheckoutRead>;
  /** Starts listening before the sole authorized press. It must settle within timeoutMs. */
  waitForResult(page: Page, timeoutMs: number): Promise<void>;
  readEvidence(page: Page): Promise<MerchantPurchaseEvidence | undefined>;
  readAvailability?(page: Page, expected: { venueId: string; partySize: number }): Promise<ReservationAvailability>;
  readReservationPolicy?(page: Page, venueId: string): Promise<ReservationPolicy | undefined>;
}
