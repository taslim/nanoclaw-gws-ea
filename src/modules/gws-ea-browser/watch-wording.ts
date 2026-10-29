import { formatLocalTimeWithZone } from '../../timezone.js';
import { cardEventSpan, SELLER_TEXT_LIMIT } from './cards.js';
import { quoted } from '../approvals/request-text.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import { boundsOf, type WatchRow } from './watch-state.js';
import { formatMoney } from './fingerprint.js';
import type { ReservationPolicy } from './merchant-contract.js';
import type { PrincipalClock } from './watch-policy.js';

/** to: browser */
const watchMessages = {
  times: 'Watch times need real ISO dates and times with explicit UTC offsets.',
  release:
    'A release rule needs the venue’s own wording, a time as HH:MM on its clock, and days_ahead, or day_of_month with months_ahead.',
  releaseZone: 'A release time_zone must be an IANA zone, such as Asia/Tokyo.',
  unknownField: 'Unknown watch field.',
  required: 'A watch needs its recipe, exact venue, party, windows and financial bounds.',
  financial: 'Financial bounds need a currency and an exact nonnegative maximum.',
  https: 'HTTPS required',
  site: 'Watch site must be a public HTTPS URL.',
  window: 'Each watch window needs start and end.',
  windowOrder: 'Watch window end must not precede its start.',
  deadline: 'Watch deadline has already passed.',
  region: 'region needs a ref and generation from the latest observation.',
  mark: 'Marking a watch again needs its watch_id and a region.',
  live: 'Only a live browser watch can request its setup approval.',
  unavailable: 'This watch is no longer available.',
  principalBounds: 'The principal must authorize these exact reservation bounds.',
  cannotArm: 'This job cannot arm another booking watch.',
  belongs: 'This watch does not belong to the job.',
  watchId: 'watch_id is required',
} as const;

export function watchMessage(kind: keyof typeof watchMessages): string {
  return watchMessages[kind];
}

/**
 * Arrival windows read on the venue's clock; conversions and the deadline on the principal's.
 * to: principal
 */
export function renderWatchCard(watch: WatchRow, venueTimeZone: string, clock: PrincipalClock): string {
  const bounds = boundsOf(watch),
    financial = bounds.financial;
  const lines = [
    'Approve one reservation across this errand’s watches, within these bounds:',
    `Site: ${quoted(watch.site, SELLER_TEXT_LIMIT)}`,
    `Venue: ${quoted(bounds.venue.name, SELLER_TEXT_LIMIT)}`,
    `Party size: ${bounds.partySize}`,
    ...bounds.windows.map(
      (window) => `Arrival window: ${cardEventSpan(window.start, window.end, venueTimeZone, clock)}`,
    ),
    `Maximum total exposure, all guests and fees: ${formatMoney(financial.maxTotalMinor, financial.currency)} (${financial.currency})`,
  ];
  if (bounds.kind === 'region')
    lines.push(
      'A booking goes ahead without asking you again only when the site’s own checkout shows this venue, party and arrival window, with its total, amount due now and every fee within that maximum. Any other booking, a recurring charge included, comes to you on its own card.',
    );
  else
    lines.push(
      `Maximum due now: ${formatMoney(financial.maxDueNowMinor, financial.currency)}`,
      ...financial.policy!.commitments.map(
        (term) =>
          `Merchant financial terms: ${quoted(term.terms, 1200)}; ${term.kind}; amount ${term.amountMinor === undefined ? 'unreadable' : formatMoney(term.amountMinor, financial.currency)}${term.perPerson ? ` per guest × ${bounds.partySize}` : ' total'}; trigger ${quoted(term.trigger ?? '', SELLER_TEXT_LIMIT)}; cancellation ${quoted(term.cancellationTerms ?? '', SELLER_TEXT_LIMIT)}${term.cancellationBeforeMs === undefined ? '' : `; cutoff ${term.cancellationBeforeMs / 60_000} minutes before arrival`}${term.frequency ? `; frequency ${quoted(term.frequency, SELLER_TEXT_LIMIT)}` : ''}${term.conversionAt ? `; converts ${formatLocalTimeWithZone(term.conversionAt, clock(term.conversionAt))}` : ''}`,
      ),
    );
  lines.push(`Watch deadline: ${formatLocalTimeWithZone(bounds.until, clock(bounds.until))}`);
  return lines.join('\n');
}

/** to: browser */
export function termsOverBounds(
  site: string,
  policy: ReservationPolicy,
  exposureMinor: number,
  maxTotalMinor: number,
  partySize: number,
): { status: 'refused'; reason: string; exposure: string; max_total: string; message: string } {
  const exposure = formatMoney(exposureMinor, policy.currency);
  const maximum = formatMoney(maxTotalMinor, policy.currency);
  return {
    status: 'refused',
    reason: 'terms_over_bounds',
    exposure,
    max_total: maximum,
    message:
      `No watch was set: the venue's terms can charge up to ${exposure} for a party of ${partySize}, above the ` +
      `maximum of ${maximum}. Report these terms to the agent that sent this errand, so they can ask the ` +
      `principal for a higher maximum:\n${untrusted(policy.commitments.map((term) => term.terms).join('\n'), 1200, site)}`,
  };
}

/** to: browser */
export function rejectedWatchMessage(delegator: string | undefined, reason: string | undefined): string {
  return `The principal declined this watch${reason ? `: "${reason}"` : ''}. It is cancelled and books nothing; report this to ${delegator ?? 'the agent that sent this errand'}.`;
}

/** to: principal */
export function watchCardTitle(): string {
  return 'Approve this reservation watch?';
}
/** to: principal */
export function watchCardWithdrawal(): string {
  return 'Withdrawn: this watch was cancelled.';
}
