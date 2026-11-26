import { formatLocalTimeWithZone } from '../../timezone.js';
import { browserCardBudget, cardEventSpan, clampBrowserCardText, fitQuoted, SELLER_TEXT_LIMIT } from './cards.js';
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
  required: 'A watch needs its exact venue, party, windows and financial bounds.',
  parameters: 'parameters are a booking recipe’s named text inputs, for a watch on a site the host reads itself.',
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

interface WatchCardCaps {
  readonly quote: (text: string, limit: number) => string;
  readonly seller: number;
  readonly term: number;
  readonly maxWindows: number;
  readonly maxCommitments: number;
}

const WATCH_CARD_PROFILES: readonly WatchCardCaps[] = [
  { quote: quoted, seller: SELLER_TEXT_LIMIT, term: 1200, maxWindows: Infinity, maxCommitments: Infinity },
  { quote: fitQuoted, seller: 200, term: 360, maxWindows: 4, maxCommitments: 3 },
  { quote: fitQuoted, seller: 100, term: 160, maxWindows: 2, maxCommitments: 2 },
  { quote: fitQuoted, seller: 48, term: 64, maxWindows: 1, maxCommitments: 1 },
];

/**
 * Arrival windows read on the venue's clock; conversions and the deadline on the principal's.
 * to: principal
 */
export function renderWatchCard(watch: WatchRow, venueTimeZone: string, clock: PrincipalClock): string {
  const bounds = boundsOf(watch),
    financial = bounds.financial;
  const budget = browserCardBudget(watchCardTitle());
  let rendered = '';
  for (const caps of WATCH_CARD_PROFILES) {
    const shownWindows = bounds.windows.slice(0, caps.maxWindows);
    const omittedWindows = bounds.windows.length - shownWindows.length;
    const lines = [
      'Approve one reservation across this errand’s watches, within these bounds:',
      `Site: ${caps.quote(watch.site, caps.seller)}`,
      `Venue: ${caps.quote(bounds.venue.name, caps.seller)}`,
      `Party size: ${bounds.partySize}`,
      ...shownWindows.map(
        (window) => `Arrival window: ${cardEventSpan(window.start, window.end, venueTimeZone, clock)}`,
      ),
      ...(omittedWindows > 0
        ? [`More arrival windows: ${omittedWindows} additional ${omittedWindows === 1 ? 'window' : 'windows'}.`]
        : []),
      `Maximum total exposure, all guests and fees: ${formatMoney(financial.maxTotalMinor, financial.currency)} (${financial.currency})`,
    ];
    if (bounds.kind === 'region') {
      lines.push(
        'A booking goes ahead without asking you again only when the site’s own checkout shows this venue, party and arrival window, with its total, amount due now and every fee within that maximum. Any other booking, a recurring charge included, comes to you on its own card.',
      );
    } else {
      const commitments = financial.policy!.commitments;
      const shownCommitments = commitments.slice(0, caps.maxCommitments);
      const omittedCommitments = commitments.length - shownCommitments.length;
      lines.push(
        `Maximum due now: ${formatMoney(financial.maxDueNowMinor, financial.currency)}`,
        ...shownCommitments.map(
          (term) =>
            `Merchant financial terms: ${caps.quote(term.terms, caps.term)}; ${term.kind}; amount ${term.amountMinor === undefined ? 'unreadable' : formatMoney(term.amountMinor, financial.currency)}${term.perPerson ? ` per guest × ${bounds.partySize}` : ' total'}; trigger ${caps.quote(term.trigger ?? '', caps.seller)}; cancellation ${caps.quote(term.cancellationTerms ?? '', caps.seller)}${term.cancellationBeforeMs === undefined ? '' : `; cutoff ${term.cancellationBeforeMs / 60_000} minutes before arrival`}${term.frequency ? `; frequency ${caps.quote(term.frequency, caps.seller)}` : ''}${term.conversionAt ? `; converts ${formatLocalTimeWithZone(term.conversionAt, clock(term.conversionAt))}` : ''}`,
        ),
        ...(omittedCommitments > 0
          ? [
              `More merchant financial terms: ${omittedCommitments} additional ${omittedCommitments === 1 ? 'term' : 'terms'}.`,
            ]
          : []),
      );
    }
    lines.push(`Watch deadline: ${formatLocalTimeWithZone(bounds.until, clock(bounds.until))}`);
    rendered = lines.join('\n');
    if (rendered.length <= budget) return rendered;
  }
  return clampBrowserCardText(rendered, budget);
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
