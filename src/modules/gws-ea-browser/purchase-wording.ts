import { formatLocalTimeWithZone } from '../../timezone.js';
import type { SpendingAuthority } from './authority.js';
import type { IncidentKind } from './incidents.js';

/** to: browser */
const purchaseMessages = {
  live: 'Only a live browser job can request a purchase.',
  noLiveJob: 'The browser job is no longer live.',
  disabled: 'Browser is disabled.',
  principal: 'A purchase requires the principal to confirm the complete merchant facts.',
  iso: 'Use a real ISO date, or a date and time with a UTC offset.',
  unknownField: 'Unknown purchase field.',
  operation: 'Unknown purchase operation.',
  target: 'target needs a current ref and generation.',
  reconcile: 'Reconciliation needs only attempt_id and target; no model verdict is accepted.',
  attempt: 'attempt_id is for reconciliation.',
  window: 'delivery_window needs start and end.',
  windowOrder: 'The delivery window must be ordered.',
  notHeld: 'Purchase confirmation was not held for the principal.',
  cancelled: 'The browser job was cancelled.',
  unreadable: 'The checkout is no longer readable.',
  bookingChanged: 'The booking changed before the host pressed it.',
  authority: 'authority_id required',
  consentFacts: 'A purchase consent pass answers only with its facts',
} as const;

export function purchaseMessage(kind: keyof typeof purchaseMessages): string {
  return purchaseMessages[kind];
}

/**
 * The answer of a checkout that changed after its third changed card: no fourth card; its job stops (R9).
 * to: browser
 */
export function checkoutChanging(change: string): Record<string, unknown> {
  return {
    status: 'checkout_changing',
    reason: change,
    message: `The checkout changed again after three changed cards (${change}), so the host stopped this errand; nothing more went to the principal.`,
    repeat_safe: false,
  };
}

/**
 * Why the host itself stopped a job: its checkout kept changing, or an incident's stop (KTD10).
 * to: browser
 */
function hostStop(
  incident: { kind: IncidentKind; site: string } | undefined,
  data: Record<string, unknown>,
): string | undefined {
  if (data.status === 'checkout_changing' && typeof data.message === 'string') return data.message;
  if (!incident) return undefined;
  switch (incident.kind) {
    case 'unapproved_commit':
      return `An action on ${incident.site} led to a confirmation showing a charge nobody approved, so this errand was stopped.`;
    case 'late_confirmation':
      return `A purchase on ${incident.site} recorded as not placed was reported placed after all, so the host stopped this errand.`;
    default: {
      const unknown: never = incident.kind;
      throw new Error(`Unknown incident kind ${String(unknown)}`);
    }
  }
}

/** Why a checkout reached no card or press, in the words the browser reports to its delegator. */
function unpurchasable(data: Record<string, unknown>): string | undefined {
  switch (data.status) {
    case 'card_needed':
      return 'the site has no payment method saved for this checkout, and card details are never entered';
    case 'facts_incomplete':
      return Array.isArray(data.missing) && data.missing.length
        ? `the host could not read ${data.missing.join(', ')} on the checkout`
        : 'the host could not read every fact the checkout needs';
    case 'terms_unavailable':
      return 'the host could not read the site’s terms';
    case 'terms_over_bounds':
      return 'the site’s terms can charge more than the principal’s maximum';
    default:
      return undefined;
  }
}

/** What the browser hears of an approved purchase that went no further (KTD10): its job's state first, then status. */
interface PurchaseCommitNotice {
  readonly message: string;
  readonly safe_to_rebuild: boolean;
  readonly repeat_safe: boolean;
}
export function purchaseCommitNotice(
  stopped: boolean,
  authority: SpendingAuthority,
  data: Record<string, unknown>,
  facts: {
    readonly incident: { kind: IncidentKind; site: string } | undefined;
    readonly now: string;
    readonly principalTimeZone: string;
  },
): PurchaseCommitNotice {
  const none = 'No purchase was attempted';
  const told = (message: string, rebuild = false, repeatSafe = false): PurchaseCommitNotice => ({
    message,
    safe_to_rebuild: rebuild,
    repeat_safe: repeatSafe,
  });
  if (stopped) {
    const stop = hostStop(facts.incident, data);
    return stop
      ? told(`${none}. ${stop} Report it to the agent that sent this errand.`)
      : told(`${none}: this errand was cancelled, so stop here.`);
  }
  // A changed or expired checkout already went back to the principal as a new card.
  if (data.status === 'awaiting_principal')
    return told(
      `${none}: the principal has a new card with the checkout's current facts. Stay on the checkout and wait for its outcome.`,
    );
  const unspent = authority.state === 'live' && !authority.commit_started_at;
  if (authority.expires_at <= facts.now)
    return told(
      `${none}: the principal's approval expired before the checkout could go through. Report it to the agent that sent this errand.`,
    );
  const holds = (): string =>
    `The principal's approval holds until it expires, ${formatLocalTimeWithZone(authority.expires_at, facts.principalTimeZone)}.`;
  if (
    unspent &&
    (data.status === 'checkout_lapsed' ||
      (data.status === 'stopped' && (data.reason === 'interrupted' || data.reason === 'browser_unavailable')))
  )
    return told(
      `${none}. Rebuild the checkout from a fresh observation and call purchase; the host revalidates the approved facts, bounds and expiry.`,
      true,
    );
  if (data.status === 'waiting_on_earlier')
    return told(
      `${none}: an earlier purchase on this site is waiting for its outcome to be recorded. Browse on; when the host wakes you, rebuild the checkout from a fresh observation and call purchase. ${holds()}`,
    );
  if (data.status === 'site_purchase_blocked' || (data.status === 'stopped' && data.reason === 'site_busy'))
    return told(
      `${none}: another errand holds this site. The host wakes you when it is free; then call purchase again. ${holds()}`,
      false,
      data.repeat_safe === true,
    );
  const reason = unpurchasable(data);
  if (reason) return told(`${none}: ${reason}. Report it to the agent that sent this errand.`);
  const status = typeof data.reason === 'string' ? `${String(data.status)}, ${data.reason}` : String(data.status);
  return told(`${none} (${status}). Handle it as the purchase tool describes.`);
}

/** Host-only invariant failure, never a page's text. */
export function purchaseInvariantMessage(kind: 'checkout' | 'free', unknown: never): string {
  return kind === 'checkout'
    ? `Unknown checkout read ${JSON.stringify(unknown)}`
    : `Unknown free commit ${JSON.stringify(unknown)}`;
}

/** to: principal */
export function purchaseCardTitle(): string {
  return 'Approve this purchase?';
}
/** to: principal */
export function purchaseCardWithdrawal(): string {
  return 'Withdrawn: the checkout changed. A fresh card contains the current facts.';
}
/** to: principal */
export function purchaseApprovalExpired(): string {
  return 'The previous approval expired.';
}
/** to: browser */
export function purchaseAddOnMissing(addOn: string): string {
  return `the charge for ${addOn}`;
}
