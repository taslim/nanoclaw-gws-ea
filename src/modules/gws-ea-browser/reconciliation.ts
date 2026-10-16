import type { Page } from 'playwright-core';
import { PurchaseAuthorityStore } from './authority.js';
import type { PurchaseFacts } from './fingerprint.js';
import {
  readMerchantPurchaseEvidence,
  merchantSignatures,
  type MerchantPurchaseEvidence,
} from './merchant-signatures.js';

export interface PurchaseAttempt {
  id: string;
  authority_id: string;
  job_id: string;
  site: string;
  facts_json: string;
  attempted_at: string;
  resolution: 'committed' | 'not_committed' | null;
  evidence_json: string | null;
  reconciled_at: string | null;
}
/** Evidence is parsed by the host's merchant signature. A model verdict never enters this comparison. */
export function evidenceMatchesAttempt(evidence: MerchantPurchaseEvidence, attempt: PurchaseAttempt): boolean {
  const facts = JSON.parse(attempt.facts_json) as PurchaseFacts;
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

export async function reconcilePurchaseAttempt(
  attemptId: string,
  page: Page,
  store = new PurchaseAuthorityStore(),
): Promise<Record<string, unknown>> {
  const attempt = await store.db.get<PurchaseAttempt>(
    'SELECT * FROM gws_ea_browser_purchase_attempts WHERE id = ?',
    attemptId,
  );
  if (!attempt) return { status: 'inconclusive', attempt_id: attemptId, repeat_safe: true };
  if (attempt.resolution)
    return {
      status: attempt.resolution === 'committed' ? 'confirmed_placed' : 'confirmed_not_placed',
      attempt_id: attemptId,
      evidence: JSON.parse(attempt.evidence_json ?? '{}') as unknown,
      repeat_safe: true,
    };
  const evidence = await readMerchantPurchaseEvidence(page);
  if (!evidence || !evidenceMatchesAttempt(evidence, attempt))
    return { status: 'inconclusive', attempt_id: attemptId, purchase_blocked: true, repeat_safe: true };
  const applied = await store.db.transaction(async () => {
    const current = await store.db.get<PurchaseAttempt>(
      'SELECT * FROM gws_ea_browser_purchase_attempts WHERE id = ?',
      attemptId,
    );
    if (!current || current.resolution) return false;
    const alreadyUsed = await store.db.get(
      'SELECT id FROM gws_ea_browser_purchase_attempts WHERE site = ? AND merchant_account = ? AND merchant_record_id = ? AND id <> ?',
      attempt.site,
      evidence.account,
      evidence.recordId,
      attempt.id,
    );
    if (alreadyUsed) return false;
    await store.db.run(
      'UPDATE gws_ea_browser_purchase_attempts SET resolution = ?,evidence_json = ?,reconciled_at = ?,merchant_record_id = ?,merchant_account = ? WHERE id = ? AND resolution IS NULL',
      evidence.resolution,
      JSON.stringify(evidence),
      new Date().toISOString(),
      evidence.recordId,
      evidence.account,
      attempt.id,
    );
    // The old authority stays consumed even when the merchant proves there was no order.
    if (!(await store.unresolved(attempt.site)).length)
      await store.db.run('DELETE FROM gws_ea_browser_purchase_blocks WHERE site = ?', attempt.site);
    return true;
  });
  if (!applied) return { status: 'inconclusive', attempt_id: attemptId, purchase_blocked: true, repeat_safe: true };
  return {
    status: evidence.resolution === 'committed' ? 'confirmed_placed' : 'confirmed_not_placed',
    attempt_id: attempt.id,
    order_number: evidence.recordId,
    evidence,
    repeat_safe: true,
  };
}
