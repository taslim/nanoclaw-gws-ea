import type { Page } from 'playwright-core';
import { PurchaseAuthorityStore, type PurchaseAttemptRow } from './authority.js';
import { GENERIC_FLOW_ID, type PurchaseFacts } from './fingerprint.js';
import { readMerchantPurchaseEvidence } from './merchant-read.js';
import { merchantSignatures } from './merchant-signatures.js';
import type { MerchantPurchaseEvidence } from './merchant-contract.js';

/**
 * Evidence is parsed by the host's merchant signature. A model verdict never enters this comparison. A generic
 * checkout's evidence is its confirmation page, which its signature already read against the attempt; its
 * contact email keys the order number.
 */
export function evidenceMatchesAttempt(
  evidence: MerchantPurchaseEvidence,
  attempt: Pick<PurchaseAttemptRow, 'facts_json' | 'attempted_at'>,
): boolean {
  const facts = JSON.parse(attempt.facts_json) as PurchaseFacts;
  if (facts.generic)
    return (
      facts.flowId === GENERIC_FLOW_ID &&
      evidence.flowId === GENERIC_FLOW_ID &&
      evidence.resolution === 'committed' &&
      evidence.account === facts.generic.contactEmail
    );
  const ordered = Date.parse(evidence.orderedAt);
  const attempted = Date.parse(attempt.attempted_at);
  // A native purchase id, when the merchant exposes it, is stronger than a time window.
  const signature = merchantSignatures.find((candidate) => candidate.id === facts.flowId);
  if (!signature || evidence.flowId !== facts.flowId || !Number.isFinite(ordered) || !Number.isFinite(attempted))
    return false;
  try {
    if (!signature.evidenceOrigins.includes(new URL(evidence.source).origin)) return false;
  } catch {
    return false;
  }
  if (JSON.stringify(evidence.reservation) !== JSON.stringify(facts.reservation)) return false;
  if (facts.checkoutReference && evidence.checkoutReference !== facts.checkoutReference) return false;
  if (ordered < attempted - 60_000 || ordered > attempted + 10 * 60_000) return false;
  return (
    evidence.account === facts.account &&
    evidence.currency === facts.currency &&
    evidence.totalMinor === facts.totalMinor &&
    evidence.cardEnding === facts.cardEnding &&
    evidence.address === facts.address &&
    JSON.stringify(evidence.items) === JSON.stringify(facts.items)
  );
}

/** What reconciliation answers for an attempt whose outcome is recorded, by whichever source recorded it. */
function recorded(attempt: PurchaseAttemptRow): Record<string, unknown> {
  return {
    status: attempt.resolution === 'committed' ? 'confirmed_placed' : 'confirmed_not_placed',
    attempt_id: attempt.id,
    evidence: JSON.parse(attempt.evidence_json ?? '{}') as unknown,
    repeat_safe: true,
  };
}

/**
 * The job's read-only check of a paid attempt against the merchant's evidence on the page: a reviewed merchant's
 * order record, or a generic checkout's confirmation. Matching evidence resolves the attempt from the page; a
 * record that already proves another attempt under the same account key proves nothing of this one.
 */
export async function reconcilePurchaseAttempt(
  attemptId: string,
  page: Page,
  store = new PurchaseAuthorityStore(),
): Promise<Record<string, unknown>> {
  const inconclusive = { status: 'inconclusive', attempt_id: attemptId, purchase_blocked: true, repeat_safe: true };
  const attempt = await store.attempt(attemptId);
  if (!attempt || attempt.kind !== 'paid') return inconclusive;
  if (attempt.resolution) return recorded(attempt);
  const facts = JSON.parse(attempt.facts_json) as PurchaseFacts;
  const evidence = await readMerchantPurchaseEvidence(page, facts);
  if (!evidence || !evidenceMatchesAttempt(evidence, attempt)) return inconclusive;
  const placed = evidence.resolution === 'committed';
  const status = placed ? (evidence.reservation || facts.generic?.booking ? 'booked' : 'placed') : 'not_placed';
  const result = await store.resolve(attempt.id, {
    placed,
    source: 'page',
    evidence: { ...evidence },
    record: { id: evidence.recordId, account: evidence.account },
    outcome: { status, order_number: evidence.recordId, attempt_id: attempt.id, repeat_safe: false },
  });
  switch (result.status) {
    case 'resolved':
      return {
        status: placed ? 'confirmed_placed' : 'confirmed_not_placed',
        attempt_id: attempt.id,
        order_number: evidence.recordId,
        evidence,
        repeat_safe: true,
      };
    case 'already_resolved':
      return recorded(result.attempt);
    case 'record_used':
    case 'no_attempt':
      return inconclusive;
    default: {
      const unknown: never = result;
      throw new Error(`Unknown resolution ${JSON.stringify(unknown)}`);
    }
  }
}
