import { TIMEZONE } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { requestWake } from '../../request-wake.js';
import { formatLocalTime } from '../../timezone.js';
import { detachApproval, finishApprovalWithdrawal } from '../approvals/index.js';
import type { PendingApproval } from '../../types.js';
import { formatMoney, type PurchaseBounds, type PurchaseFacts } from './fingerprint.js';

export interface PurchaseCard {
  id: string;
  job_id: string;
  request_id: string;
  approval_id: string | null;
  approval_json: string | null;
  status: 'open' | 'approved' | 'rejected' | 'expired' | 'withdrawn' | 'superseded';
  facts_json: string;
  bounds_json: string;
  exception_ids_json: string;
  expires_at: string;
  created_at: string;
  notified_at: string | null;
}
/** Seller-controlled strings are visibly quoted and bounded individually. */
export function quotePurchaseText(text: string, limit = 360): string {
  const clean = Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
  return JSON.stringify(clean.length > limit ? `${clean.slice(0, limit)}…` : clean);
}
export function renderPurchaseCard(
  facts: PurchaseFacts,
  bounds: PurchaseBounds,
  exceptions: readonly string[],
  change?: string,
): string {
  const money = (amount: number): string => formatMoney(amount, facts.currency);
  const lines = [
    "I'd like to place this purchase using the facts I read from the merchant's review page.",
    ...(change ? [change] : []),
    ...(exceptions.length
      ? [
          `Possible duplicate: the earlier attempt${exceptions.length > 1 ? 's' : ''} ${exceptions.map((id) => quotePurchaseText(id)).join(', ')} remain unresolved. Approving permits exactly one new attempt and may buy the same thing twice.`,
        ]
      : []),
    `Site: ${quotePurchaseText(facts.origin)}`,
    `Account: ${quotePurchaseText(facts.account)}`,
    `Commit control: ${quotePurchaseText(facts.control.label)}`,
    ...facts.items.map(
      (item) =>
        `Item: ${quotePurchaseText(item.title)}; quantity ${item.quantity}; merchant id ${quotePurchaseText(item.id)}`,
    ),
    `Total: ${money(facts.totalMinor)} (${facts.currency})`,
    `Due now: ${money(facts.dueNowMinor)}`,
    `Card ending: ${facts.cardEnding}`,
    `Address: ${quotePurchaseText(facts.address)}`,
    `Delivery: ${facts.delivery ? quotePurchaseText(facts.delivery.text) : 'Not applicable'}`,
    ...(bounds.deliveryWindow
      ? [
          `Approved delivery window: ${quotePurchaseText(bounds.deliveryWindow.start)} through ${quotePurchaseText(bounds.deliveryWindow.end)}`,
        ]
      : []),
    ...(bounds.neededBy ? [`Needed by: ${formatLocalTime(bounds.neededBy, TIMEZONE)}`] : []),
  ];
  for (const term of facts.commitments) {
    lines.push(`Financial commitment: ${term.kind}; ${quotePurchaseText(term.terms, 700)}`);
    if (term.amountMinor !== undefined)
      lines.push(
        `Amount due later/exposure: ${money(term.amountMinor)}${term.perPerson ? ` per person × ${facts.reservation?.partySize ?? 'unknown party size'}` : ' total'}`,
      );
    if (term.trigger) lines.push(`Trigger: ${quotePurchaseText(term.trigger)}`);
    if (term.cancellationDeadline)
      lines.push(`Cancellation deadline: ${formatLocalTime(term.cancellationDeadline, TIMEZONE)}`);
    if (term.cancellationTerms) lines.push(`Cancellation terms: ${quotePurchaseText(term.cancellationTerms, 700)}`);
    if (term.conversionAt) lines.push(`Trial conversion: ${formatLocalTime(term.conversionAt, TIMEZONE)}`);
    if (term.frequency) lines.push(`Recurring frequency: ${quotePurchaseText(term.frequency)}`);
  }
  if (facts.commitments.every((term) => term.kind === 'retail'))
    lines.push('Due later: none. One-time retail purchase; no hold, deposit, conditional fee, trial or subscription.');
  return lines.join('\n');
}

/** DB-only half. Includes cards whose approval id is still being returned by delivery. */
export async function detachPurchaseCards(jobId: string, reason: PurchaseCard['status']): Promise<PendingApproval[]> {
  const db = getDb();
  const cards = await db.all<PurchaseCard>(
    "SELECT * FROM gws_ea_browser_purchase_cards WHERE job_id = ? AND (status = 'open' OR (status = 'approved' AND EXISTS (SELECT 1 FROM gws_ea_browser_authorities WHERE card_id = gws_ea_browser_purchase_cards.id AND state = 'live')))",
    jobId,
  );
  const detached: PendingApproval[] = [];
  for (const card of cards) {
    // During adapter.deliver the late approval_id link can still be null. Payload identifies this pre-existing card.
    const approvals = await db.all<PendingApproval>(
      "SELECT * FROM pending_approvals WHERE action = 'browser_purchase' AND session_id = (SELECT browser_session_id FROM gws_ea_browser_jobs WHERE id = ?)",
      jobId,
    );
    let found = false;
    for (const approval of approvals) {
      const payload = JSON.parse(approval.payload) as { cardId?: string };
      if (payload.cardId === card.id) {
        const row = await detachApproval(approval.approval_id);
        if (row) {
          detached.push(row);
          found = true;
        }
      }
    }
    if (!found && card.approval_json) detached.push(JSON.parse(card.approval_json) as PendingApproval);
    await db.run('UPDATE gws_ea_browser_purchase_cards SET status = ? WHERE id = ?', reason, card.id);
  }
  await db.run("UPDATE gws_ea_browser_authorities SET state = 'revoked' WHERE job_id = ? AND state = 'live'", jobId);
  await db.run(
    "DELETE FROM gws_ea_browser_pending_commits WHERE authority_id IN (SELECT id FROM gws_ea_browser_authorities WHERE job_id = ? AND state = 'revoked')",
    jobId,
  );
  return detached;
}
export async function finishPurchaseCardWithdrawals(cards: readonly PendingApproval[], message: string): Promise<void> {
  for (const card of cards) await finishApprovalWithdrawal(card, message);
}
export async function notifyPurchaseCard(cardId: string, outcome: string): Promise<void> {
  const db = getDb();
  const card = await db.get<PurchaseCard>('SELECT * FROM gws_ea_browser_purchase_cards WHERE id = ?', cardId);
  if (!card || card.notified_at) return;
  const job = await db.get<{ browser_session_id: string }>(
    'SELECT browser_session_id FROM gws_ea_browser_jobs WHERE id = ?',
    card.job_id,
  );
  const session = job ? await getSession(job.browser_session_id) : undefined;
  if (!session) return;
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `browser-card-${card.id}-${outcome}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      trigger: true,
      content: JSON.stringify({
        type: 'browser_purchase_outcome',
        job: card.job_id,
        card_id: card.id,
        status: outcome,
        ...(outcome === 'rejected'
          ? { message: 'The principal declined. Remove the cart items you added; do not try another purchase path.' }
          : {}),
      }),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  await db.run(
    'UPDATE gws_ea_browser_purchase_cards SET notified_at = ? WHERE id = ?',
    new Date().toISOString(),
    card.id,
  );
  void requestWake(session, 'browser-purchase-card').catch(() => undefined);
}
