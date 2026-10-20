/**
 * The generic signature (KTD4, KTD5): the fallback reader for any checkout no reviewed signature reads. It reads
 * the checkout around its commit control across frames and dialogs, in isolated worlds, into the generic fact
 * floor, and decides what the checkout is: a free commit (KTD3), a paid one with no saved payment method (R12),
 * one whose facts it cannot read (R13), or a card's facts. It is never a reviewed flow: it classifies no control
 * or route, so it never joins the classifier's flows and nothing is ever pressed directly because of it.
 *
 * Every fact comes from what the page shows; the vocabulary below is data, widened or narrowed here.
 */
import type { ElementHandle, Page, Request } from 'playwright-core';
import { getDomain } from 'tldts';

import {
  readConfirmation,
  statedAmounts,
  TOTAL_WORD,
  type ConfirmationCharge,
  type ConfirmationEvidence,
} from './confirmation.js';
import {
  ControlFactsUnavailableError,
  PAYMENT_VOCABULARY,
  paymentProcessorHost,
  readCheckoutRegion,
  readPageControlFacts,
  type CheckoutBox,
  type CheckoutField,
  type CheckoutRead,
} from './control-facts.js';
import {
  GENERIC_FLOW_ID,
  BOOKING_CONTROL,
  currencyExponent,
  formatMoney,
  type FinancialCommitment,
  type FreeCommitFacts,
  type GenericBookingFacts,
  type PurchaseFacts,
} from './fingerprint.js';
import type {
  CardNeeded,
  CheckoutRegions,
  MerchantCheckoutRead,
  MerchantPurchaseEvidence,
  MerchantSignature,
} from './merchant-contract.js';
import {
  ariaNodes,
  flatten,
  captureElementLocator,
  resolveLocator,
  type StructuredBrowserLocator,
} from './locators.js';
import { browserStructureFacts } from './observe.js';
import { classifyControlFacts } from './control-policy.js';

const VOCABULARY = {
  /** A total, an amount due or what will be paid; a subtotal is none. */
  total: new RegExp(
    String.raw`${TOTAL_WORD}|\bamount\s+(?:due|to\s+pay|payable)\b|\bbalance\s+due\b|\byou(?:'ll|’ll|\s+will)\s+pay\b`,
    'iu',
  ),
  /** A total that is not the whole: before tax, or the items' alone. */
  partialTotal: /\b(?:before|excl(?:uding|\.)?|pre-?)\s*tax(?:es)?\b|\bitems?\s+total\b/iu,
  /** What is charged now, as opposed to later. */
  dueNow:
    /\b(?:due|payable|to\s+pay|charged|paid)\s+(?:now|today|at\s+(?:booking|checkout)|when\s+you\s+book)\b|\bpay(?:ing)?\s+(?:now|today)\b|\bcharged\s+(?:on|at)\s+booking\b/iu,
  /** Nothing is charged now. */
  nothingNow:
    /\bnothing\s+(?:is\s+)?(?:due|charged|to\s+pay)\b|\bno\s+(?:payment|charge)\s+(?:is\s+)?(?:due\s+)?(?:now|today|until)\b|\b(?:won'?t|will\s+not)\s+be\s+charged\b/iu,
  /** A summary line beside the items: subtotals, shipping, taxes, discounts. */
  summary:
    /\b(?:sub[\s-]?total|total|shipping|delivery\s+(?:fee|charge)|tax(?:es)?|vat|discount|coupon|promo|tip|gratuity|savings|balance|amount\s+due|due\s+(?:now|today))\b/iu,
  /** An item row's quantity: "× 2", "Qty: 2", "2 x". */
  quantity: /(?:^|\s)[×x]\s?\d{1,3}\b|\b(?:qty|quantity)\.?:?\s*\d{1,3}\b|^\d{1,3}\s?[×x]\s/iu,
  /** A heading over the items. */
  itemsHeading:
    /^(?:items?|your\s+(?:order|items|bag|cart|basket|booking|reservation)|order\s+(?:summary|details)|in\s+your\s+(?:bag|cart|basket)|summary)$/iu,
  /** A booking described in words: "Table for 2", "Party of 4", "4 guests". */
  bookingLine:
    /\btable\s+for\s+(\d{1,2})\b|\bparty\s+of\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:guests?|people|persons|adults|diners|covers)\b/iu,
  partyField: /\b(?:party|guests?|people|persons?|covers|diners|adults|group\s+size)\b/iu,
  /** A commit that books rather than buys. */
  bookingControl: BOOKING_CONTROL,
  venueLine: /^(?:venue|restaurant|location|where)\s*:\s*(.{2,120})$/iu,
  emailField: /e-?mail/iu,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu,
  noteField: /\b(?:notes?|instructions?|requests?|comments?|allerg\w*|occasion|special)\b/iu,
  signedInAs: /\b(?:signed|logged)\s+in\s+as:?\s+(.{1,120}?)\.?$/iu,
  greeting: /^(?:hello|hi|welcome(?:\s+back)?),?\s+([^!.,]{1,80})[!.]?$/iu,
  /** Money, fee, hold, deposit, payment or trial wording that keeps a booking from being free (KTD3). */
  freeBlocker:
    /\b(?:fees?|charges?|charged|deposits?|pre-?pa(?:y|id|yment)|payments?|pay|billing|billed|trial|subscriptions?|membership\s+fees?|credit\s+card|debit\s+card)\b|\b(?:card|payment|authori[sz]ation)\s+hold\b/iu,
  /** Wording that denies a charge: "No payment is needed", "No credit card required". A no-show is no denial. */
  negated:
    /\b(?:no|without|zero)\s+(?!show\b)(?:\w+\s+){0,2}(?:fees?|charges?|deposits?|payments?|pre-?payment|credit\s+card|debit\s+card|card|billing)\b|\b(?:payments?|cards?|credit\s+cards?|deposits?|fees?)\s+(?:is\s+|are\s+)?not\s+(?:needed|required|charged)\b|\b(?:won'?t|will\s+not)\s+be\s+charged\b|\bfree\s+of\s+charge\b/iu,
  conditionalFee:
    /\b(?:cancell?ation|no[\s-]?shows?|late[\s-]?cancell?ation)\b.{0,60}?\b(?:fees?|charges?|penalt(?:y|ies))\b|\b(?:fees?|charges?|penalt(?:y|ies))\b.{0,60}?\b(?:cancel\w*|no[\s-]?shows?)\b|\bcharged\s+if\s+you\s+(?:miss|cancel|do\s+not\s+show|don'?t\s+show)\b/iu,
  noShow: /\bno[\s-]?shows?\b|\bmiss\s+your\b|\bdo(?:n'?t|\s+not)\s+show\b/iu,
  deposit: /\bdeposits?\b/iu,
  prepayment: /\bpre-?pa(?:id|y(?:ment)?)\b/iu,
  hold: /\b(?:card|payment|authori[sz]ation)\s+hold\b|\bhold\s+(?:of\s+)?[$€£¥₹]|\bhold\s+on\s+your\s+card\b|\bpre-?authori[sz]ation\b|\bauthori[sz]ation\s+(?:of|for)\b/iu,
  trial: /\btrial\b/iu,
  /** A charge that renews, whether or not it names its price. */
  renewal:
    /\bauto-?renew\w*|\brenew(?:s|ed|al)?\b|\brecurring\b|\bbilled\s+(?:every|each|monthly|annually|yearly|weekly|quarterly)\b/iu,
  /** A period or a subscription named beside a price: "$12.00/month", "Membership $40". Alone, it is no term. */
  period:
    /\b(?:monthly|annually|yearly|weekly|quarterly)\b|(?:\bper|\/|\bevery|\beach)\s*(?:\d+\s*)?(?:month|mo|year|yr|annum|week|wk|quarter)s?\b|\b(?:subscriptions?|memberships?)\b/iu,
  frequency:
    /(?:\bper\s*|\/\s*|\bevery\s+|\beach\s+|\ba\s+)(?:(\d+)\s*)?(month|mo|year|yr|annum|week|wk|day|quarter)s?\b|\b(monthly|annually|yearly|weekly|daily|quarterly)\b/iu,
  perPerson: /\bper\s+(?:person|guest|diner|cover|head|adult|seat|ticket)\b|\beach\s+(?:person|guest)\b|\bpp\b/iu,
  within: /\bwithin\s+(\d{1,3})\s*(hours?|hrs?|days?)\b/iu,
  /** A hold countdown and its like: text that changes on its own, never a fact. */
  countdown:
    /\b\d{1,2}:\d{2}(?::\d{2})?\b(?!\s*[ap]\.?m\b)|\b\d+\s*(?:minutes?|mins?|seconds?|secs?)\s+(?:left|remaining)\b/iu,
  timer: /\b(?:hold(?:ing)?|held|reserved|expires?|expiring|remaining|left|timer|countdown)\b/iu,
  /** A press the merchant refused: a decline. */
  decline:
    /\b(?:card|payment)\s+(?:was\s+|has\s+been\s+)?(?:declined|refused|rejected)\b|\binsufficient\s+funds\b|\bpayment\s+(?:failed|unsuccessful|could\s+not\s+be\s+(?:processed|completed))\b|\btransaction\s+(?:was\s+)?(?:failed|declined)\b/iu,
  /** A press that failed some other way. */
  failure:
    /\bsomething\s+went\s+wrong\b|\ban?\s+error\s+(?:has\s+)?occurred\b|\bthere\s+(?:was|is)\s+(?:a|an)\s+(?:problem|error)\b|\b(?:could\s+not|couldn'?t|unable\s+to)\s+(?:process|complete|place)\b/iu,
  /** A press's name that can commit, for finding a checkout's next commit control. */
  commitWords:
    /\b(?:buy|pay|purchase|order|checkout|check\s*out|reserve|book|subscribe|donate|bid|register|rsvp|join|confirm|complete|continue|next|submit|place|proceed|review|finish|start)\b/iu,
  /** A route that enters a checkout: what a redirect to a payment platform leaves from (KTD7). */
  checkoutPath:
    /(?:^|[/_.-])(?:checkout|cart|basket|bag|pay(?:ments?)?|orders?|book(?:ings?)?|reserv\w*|purchase)(?:[/_.-]|$)/iu,
} as const satisfies Record<string, RegExp>;

const CANDIDATES = 'button, input[type="submit" i], input[type="button" i], input[type="image" i], [role="button" i]';
const VENUE_TYPE =
  /^(?:https?:\/\/schema\.org\/)?(?:Restaurant|FoodEstablishment|LocalBusiness|BarOrPub|CafeOrCoffeeShop|Bakery|Winery|Brewery|Hotel|LodgingBusiness|EventVenue|TouristAttraction)$/u;
const RESERVATION_TYPE = /^(?:https?:\/\/schema\.org\/)?\w*Reservation$/u;
const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const ITEM_LIMIT = 30;
const TEXT_LIMIT = 300;
/** How long the page must be still after the press, with no document loading, before its result is read. */
const RESULT_QUIET_MS = 500;
/** How long a press that loads no document is given to change its page. */
const RESULT_SETTLE_MS = 2_000;
const RESULT_POLL_MS = 100;

interface Line {
  readonly text: string;
  readonly box: CheckoutBox;
  /** The amounts above zero it states. */
  readonly money: readonly ConfirmationCharge[];
}

/** What the generic signature makes of one read. */
export type GenericDecision =
  | { status: 'free'; facts: FreeCommitFacts }
  | { status: 'card_needed'; needed: CardNeeded }
  | { status: 'facts_incomplete'; missing: string[] }
  | { status: 'ready'; facts: PurchaseFacts; regions: CheckoutRegions };

export interface GenericReadContext {
  /** The merchant: the registrable domain of the top-level page the job entered checkout from (KTD7). */
  readonly merchant: string;
  readonly locator: StructuredBrowserLocator;
  /** The commit control's box on the main frame's viewport. */
  readonly controlBox: CheckoutBox;
}

const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const bounded = (text: string): string => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text);
const positive = (text: string): ConfirmationCharge[] => statedAmounts(text).filter((amount) => amount.amountMinor > 0);
const distinct = <T>(values: readonly T[]): T[] => [
  ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
];
/** The smallest box around every box given; with `wholePixels`, the smallest whole-pixel one. */
export function union(boxes: readonly CheckoutBox[], { wholePixels = false } = {}): CheckoutBox {
  const same = (edge: number): number => edge;
  // Whole pixels widen the box: its left and top edges round down, its right and bottom edges up.
  const [down, up] = wholePixels ? [Math.floor, Math.ceil] : [same, same];
  const left = down(Math.min(...boxes.map((box) => box.x)));
  const top = down(Math.min(...boxes.map((box) => box.y)));
  return {
    x: left,
    y: top,
    width: up(Math.max(...boxes.map((box) => box.x + box.width))) - left,
    height: up(Math.max(...boxes.map((box) => box.y + box.height))) - top,
  };
}

/** The registrable domain of a web address, or undefined for anything but HTTP(S). */
function siteOf(raw: string): string | undefined {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  return getDomain(url.hostname, { allowPrivateDomains: true }) ?? undefined;
}

/** Text that changes on its own, as a hold countdown does: never a fact, never material. */
function volatileText(text: string): boolean {
  return VOCABULARY.countdown.test(text) && VOCABULARY.timer.test(text) && !positive(text).length;
}

const DENIALS = new RegExp(VOCABULARY.negated.source, 'giu');
/** The text without what it denies: "No deposit needed; a no-show fee applies" still names its fee. */
function undenied(text: string): string {
  return text.replace(DENIALS, ' ');
}

/** Whether the text names money, a fee, a hold, a deposit, a payment or a trial that it does not deny. */
function chargeWording(text: string): boolean {
  return VOCABULARY.freeBlocker.test(undenied(text));
}

/** The amounts a line labels: its own, or those alone on the line after a short label ("Order total", "$42.00"). */
function labelled(
  lines: readonly Line[],
  index: number,
): { money: readonly ConfirmationCharge[]; boxes: CheckoutBox[] } {
  const line = lines[index];
  if (line.money.length) return { money: line.money, boxes: [line.box] };
  const next = lines[index + 1];
  if (line.text.split(/\s+/u).length <= 4 && next?.money.length && next.text.split(/\s+/u).length <= 3)
    return { money: next.money, boxes: [line.box, next.box] };
  return { money: [], boxes: [] };
}

/** The period a frequency's unit names, the first that matches; any other unit it reads is a quarter. */
const FREQUENCY_UNITS: ReadonlyArray<readonly [RegExp, 'month' | 'year' | 'week' | 'day']> = [
  [/^(?:month|mo|monthly)$/u, 'month'],
  [/^(?:year|yr|annum|annually|yearly)$/u, 'year'],
  [/^(?:week|wk|weekly)$/u, 'week'],
  [/^(?:day|daily)$/u, 'day'],
];

/** A recurring frequency as people say it, or undefined when the words name none. */
function frequencyOf(text: string): string | undefined {
  const match = VOCABULARY.frequency.exec(text);
  if (!match) return undefined;
  const unit = (match[2] ?? match[3] ?? '').toLowerCase();
  const word = FREQUENCY_UNITS.find(([pattern]) => pattern.test(unit))?.[1] ?? 'quarter';
  const every = match[1] ? Number(match[1]) : 1;
  if (every > 1) return `every ${every} ${word}s`;
  return { month: 'monthly', year: 'yearly', week: 'weekly', day: 'daily', quarter: 'quarterly' }[word];
}

/** A calendar date the text states, as noon UTC on that day; undefined when it states none it can read. */
function stateDate(text: string, now: number): string | undefined {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/u.exec(text);
  const written =
    new RegExp(
      `\\b(${MONTHS}|${MONTHS.replace(/(\w{3})\w*/gu, '$1')})\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`,
      'iu',
    ).exec(text) ?? new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\s+(20\\d{2})\\b`, 'iu').exec(text);
  const days = /\b(\d{1,3})[-\s]day\s+(?:free\s+)?trial\b|\btrial\s+(?:ends|lasts)\s+in\s+(\d{1,3})\s+days?\b/iu.exec(
    text,
  );
  let parsed = Number.NaN;
  if (iso) parsed = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00.000Z`);
  else if (written)
    parsed = /^\d/u.test(written[1])
      ? Date.parse(`${written[2]} ${written[1]}, ${written[3]} 12:00:00 GMT`)
      : Date.parse(`${written[1]} ${written[2]}, ${written[3]} 12:00:00 GMT`);
  else if (days) parsed = now + Number(days[1] ?? days[2]) * 24 * 60 * 60 * 1000;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** Every object a JSON-LD document holds, arrays and graphs unwrapped. */
function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== 'object' || value === null) return [];
  const node = value as Record<string, unknown>;
  return [node, ...nodes(node['@graph'])];
}
function types(node: Record<string, unknown>): string[] {
  return (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).filter(
    (type): type is string => typeof type === 'string',
  );
}

/** A schema.org venue's name and a reservation's start, from every frame's structured data. */
function structuredBooking(read: CheckoutRead): { venue?: string; at?: string } {
  const found: { venue?: string; at?: string } = {};
  for (const source of read.frames.flatMap((frame) => frame.structured)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    for (const node of nodes(parsed)) {
      const kinds = types(node);
      if (kinds.some((kind) => RESERVATION_TYPE.test(kind))) {
        const venue = node.reservationFor;
        if (typeof venue === 'object' && venue !== null && typeof (venue as { name?: unknown }).name === 'string')
          found.venue ??= squash((venue as { name: string }).name);
        if (typeof node.startTime === 'string' && OFFSET_TIME.test(node.startTime)) found.at ??= node.startTime;
      } else if (kinds.some((kind) => VENUE_TYPE.test(kind)) && typeof node.name === 'string')
        found.venue ??= squash(node.name);
    }
  }
  return found;
}

/** The booking the checkout describes (KTD21): venue, party size and time, each only when read. */
function readBooking(read: CheckoutRead, lines: readonly Line[], label: string): GenericBookingFacts | undefined {
  const fields = read.region.fields.filter(
    (field) => field.value !== null && VOCABULARY.partyField.test(`${field.name} ${field.label}`),
  );
  const parties = distinct([
    ...fields.flatMap((field) => {
      const party = /^\s*(\d{1,2})\b/u.exec(field.value ?? '');
      return party ? [Number(party[1])] : [];
    }),
    ...lines.flatMap((line) => {
      const party = VOCABULARY.bookingLine.exec(line.text);
      return party ? [Number(party[1] ?? party[2] ?? party[3])] : [];
    }),
  ]);
  if (!parties.length && !VOCABULARY.bookingControl.test(label)) return undefined;
  const structured = structuredBooking(read);
  const times = distinct(
    [...read.region.times.map((time) => time.datetime), ...(structured.at ? [structured.at] : [])]
      .filter((value) => OFFSET_TIME.test(value))
      .map((value) => new Date(value).toISOString()),
  );
  const zone = read.region.times.find((time) => OFFSET_TIME.test(time.datetime));
  const offset = zone ? OFFSET_TIME.exec(zone.datetime)?.[1] : undefined;
  const venueLine = lines.map((line) => VOCABULARY.venueLine.exec(line.text)?.[1]).find(Boolean);
  const venue = structured.venue ?? venueLine ?? read.frames.find((frame) => frame.top)?.heading ?? undefined;
  const timeText = read.region.times.find((time) => time.text)?.text;
  return {
    ...(venue ? { venue: bounded(squash(venue)) } : {}),
    ...(parties.length === 1 ? { partySize: parties[0] } : {}),
    ...(times.length === 1 && offset ? { at: times[0], timeZone: offset === 'Z' ? 'UTC' : offset } : {}),
    ...(timeText ? { timeText: bounded(timeText) } : {}),
  };
}

/**
 * A term's kind: the first whose wording its line shows, undenied. A period ("per month") names a subscription
 * only beside a price.
 */
const TERM_KINDS: ReadonlyArray<{
  readonly wording: RegExp;
  readonly kind: FinancialCommitment['kind'];
  readonly priced?: true;
}> = [
  { wording: VOCABULARY.trial, kind: 'trial' },
  { wording: VOCABULARY.renewal, kind: 'subscription' },
  { wording: VOCABULARY.period, kind: 'subscription', priced: true },
  { wording: VOCABULARY.hold, kind: 'hold' },
  { wording: VOCABULARY.deposit, kind: 'deposit' },
  { wording: VOCABULARY.prepayment, kind: 'prepayment' },
  { wording: VOCABULARY.conditionalFee, kind: 'conditional_fee' },
];

/** The terms a checkout states (R13): each with its amount, or what about it cannot be read. */
function readTerms(
  lines: readonly Line[],
  booking: GenericBookingFacts | undefined,
  now: number,
): { terms: FinancialCommitment[]; missing: string[]; boxes: CheckoutBox[]; currencies: string[] } {
  const terms: FinancialCommitment[] = [];
  const missing: string[] = [];
  const boxes: CheckoutBox[] = [];
  const currencies: string[] = [];
  const recurringTerms: FinancialCommitment[] = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    const words = undenied(line.text);
    const kind = TERM_KINDS.find((term) => term.wording.test(words) && (!term.priced || line.money.length > 0))?.kind;
    if (!kind) continue;
    // A label alone on its line, whose terms stand on the next: "Cancellation fee", then "$25 per person…".
    const next = lines[index + 1];
    if (!line.money.length && next?.money.length && !VOCABULARY.total.test(next.text)) {
      line = { text: `${line.text}: ${next.text}`, box: union([line.box, next.box]), money: next.money };
      index++;
    }
    const charge = line.money.at(0);
    if (charge) {
      boxes.push(line.box);
      currencies.push(charge.currency);
    }
    const perPerson = VOCABULARY.perPerson.test(line.text);
    const base = { terms: bounded(line.text), ...(charge ? { amountMinor: charge.amountMinor } : {}) };
    if (kind === 'subscription') {
      const frequency = frequencyOf(line.text);
      if (!frequency) missing.push('the recurring frequency');
      if (!charge) missing.push('the recurring price');
      const term: FinancialCommitment = { kind, ...base, ...(frequency ? { frequency } : {}) };
      recurringTerms.push(term);
      terms.push(term);
    } else if (kind === 'trial') {
      const conversionAt = stateDate(line.text, now);
      const frequency = frequencyOf(line.text);
      if (!conversionAt) missing.push('the date the trial ends');
      terms.push({
        kind,
        ...base,
        ...(conversionAt ? { conversionAt } : {}),
        ...(frequency ? { frequency } : {}),
      });
    } else if (kind === 'conditional_fee') {
      if (!charge) missing.push('the fee amount');
      const within = VOCABULARY.within.exec(line.text);
      const before = within ? Number(within[1]) * (/^d/iu.test(within[2]) ? 24 : 1) * 60 * 60 * 1000 : undefined;
      const deadline = before !== undefined && booking?.at ? Date.parse(booking.at) - before : undefined;
      terms.push({
        kind,
        ...base,
        trigger: bounded(line.text),
        conditionalTrigger: VOCABULARY.noShow.test(line.text) ? 'no_show' : 'cancellation',
        cancellationTerms: bounded(line.text),
        ...(deadline !== undefined && Number.isFinite(deadline)
          ? { cancellationDeadline: new Date(deadline).toISOString() }
          : {}),
        ...(perPerson ? { perPerson } : {}),
      });
    } else {
      if (!charge) missing.push(`the ${kind} amount`);
      if (perPerson && booking?.partySize === undefined) missing.push('the party size');
      terms.push({ kind, ...base, ...(perPerson ? { perPerson } : {}) });
    }
  }
  // A trial converts to the recurring price the checkout states, beside it or on its own line.
  for (const term of terms)
    if (term.kind === 'trial') {
      const recurring = recurringTerms[0];
      if (!term.frequency && recurring?.frequency) term.frequency = recurring.frequency;
      if (term.amountMinor === undefined && recurring?.amountMinor !== undefined)
        term.amountMinor = recurring.amountMinor;
      if (!term.frequency) missing.push('the recurring frequency');
      if (term.amountMinor === undefined) missing.push('the price after the trial');
    }
  return { terms, missing: distinct(missing), boxes, currencies: distinct(currencies) };
}

/**
 * The items as the page shows them: quantity rows, the rows under an items heading, or a booking's own words,
 * else what the page shows of the booking itself.
 */
function readItems(
  lines: readonly Line[],
  fields: readonly CheckoutField[],
  booking: GenericBookingFacts | undefined,
): string[] {
  const usable = (line: Line): boolean => !VOCABULARY.summary.test(line.text) && !VOCABULARY.total.test(line.text);
  const rows = lines.filter((line) => VOCABULARY.quantity.test(line.text) && usable(line));
  if (rows.length) return rows.slice(0, ITEM_LIMIT).map((line) => bounded(line.text));
  const heading = lines.findIndex((line) => VOCABULARY.itemsHeading.test(line.text));
  if (heading >= 0) {
    const under: string[] = [];
    for (const line of lines.slice(heading + 1)) {
      if (!usable(line) || VOCABULARY.itemsHeading.test(line.text) || line.text.split(/\s+/u).length < 2) break;
      under.push(bounded(line.text));
    }
    if (under.length) return under.slice(0, ITEM_LIMIT);
  }
  const booked = lines.filter((line) => VOCABULARY.bookingLine.test(line.text));
  if (booked.length) return booked.slice(0, ITEM_LIMIT).map((line) => bounded(line.text));
  const party = fields
    .filter((field) => field.value && VOCABULARY.partyField.test(`${field.name} ${field.label}`))
    .map((field) => bounded(`${field.label || field.name} ${field.value ?? ''}`.trim()));
  if (party.length) return party;
  const shown = [booking?.venue, booking?.timeText].filter((part): part is string => Boolean(part));
  return shown.length ? [bounded(shown.join(', '))] : [];
}

/** The contact email (KTD5), lowercased; ambiguous when the checkout shows two. */
function readContactEmail(lines: readonly Line[], fields: readonly CheckoutField[]): string | 'ambiguous' | undefined {
  const fieldValues = distinct(
    fields
      .filter(
        (field) =>
          !field.secret &&
          field.value &&
          (field.type === 'email' ||
            VOCABULARY.emailField.test(field.autocomplete) ||
            VOCABULARY.emailField.test(`${field.name} ${field.label}`)),
      )
      .map((field) => (field.value ?? '').trim().toLowerCase())
      .filter((value) => new RegExp(`^${VOCABULARY.email.source}$`, 'u').test(value)),
  );
  const shown = fieldValues.length
    ? fieldValues
    : distinct(lines.flatMap((line) => line.text.match(VOCABULARY.email) ?? []).map((value) => value.toLowerCase()));
  return shown.length === 1 ? shown[0] : shown.length > 1 ? 'ambiguous' : undefined;
}

/** A note that rides along with the order or booking (R4): what was written in its free-text fields. */
function readNote(fields: readonly CheckoutField[]): string | undefined {
  const notes = fields
    .filter((field) => {
      if (field.secret || field.card || !field.value?.trim() || field.tag === 'select') return false;
      // A textarea or a written-in element holds free text; a text input only under a note's name.
      return (
        field.tag !== 'input' || (field.type === 'text' && VOCABULARY.noteField.test(`${field.name} ${field.label}`))
      );
    })
    .map((field) => squash(field.value ?? ''));
  return notes.length ? bounded(notes.join(' / ')) : undefined;
}

/** The account the checkout signs in with, as the page names it; guest when nothing is signed in. */
function readAccount(read: CheckoutRead, contact: string | undefined): { account?: string; guest: boolean } {
  const frames = read.frames.filter((frame) => frame.top || frame.url === read.frameUrl);
  const named = frames
    .flatMap((frame) => frame.lines)
    .map((line) => (VOCABULARY.signedInAs.exec(line) ?? VOCABULARY.greeting.exec(line))?.[1])
    .find((name): name is string => Boolean(name?.trim()));
  if (named) return { account: bounded(squash(named)), guest: false };
  if (frames.some((frame) => frame.signedIn)) return { ...(contact ? { account: contact } : {}), guest: false };
  return { account: 'guest checkout', guest: true };
}

/** The saved payment method the checkout shows, its card ending, or that it shows several and picks none. */
function readPayment(
  read: CheckoutRead,
  lines: readonly Line[],
): { payment?: string; cardEnding: string | null; ambiguous: boolean } {
  const saved = (text: string): string | undefined => PAYMENT_VOCABULARY.savedCard.exec(text)?.[0];
  const ending = (text: string): string | null => /(\d{4})$/u.exec(text)?.[1] ?? null;
  const own = distinct(lines.map((line) => saved(line.text)).filter((text): text is string => Boolean(text)));
  const shown = own.length
    ? own
    : distinct(read.frames.flatMap((frame) => frame.lines.map(saved)).filter((text): text is string => Boolean(text)));
  if (!shown.length) return { cardEnding: null, ambiguous: false };
  if (distinct(shown.map(ending)).length === 1)
    return { payment: bounded(shown[0]), cardEnding: ending(shown[0]), ambiguous: false };
  const chosen = read.region.fields.find((field) => field.checked && saved(field.label));
  const label = chosen ? saved(chosen.label) : undefined;
  return label
    ? { payment: bounded(label), cardEnding: ending(label), ambiguous: false }
    : { cardEnding: null, ambiguous: true };
}

/**
 * Whether the page offers or holds a way to pay (KTD3): a card field in the checkout, or a saved payment method,
 * an express-pay button or payment entry in any frame. A booking beside one is never free, reviewed or not.
 */
export function offersPayment(read: CheckoutRead): boolean {
  return (
    read.region.fields.some((field) => field.card) ||
    read.frames.some(
      (frame) =>
        frame.expressPay.length > 0 ||
        frame.paymentEntry ||
        frame.lines.some((line) => PAYMENT_VOCABULARY.savedCard.test(line)),
    )
  );
}

/**
 * What one read of an unreviewed checkout is (KTD3, KTD5), decided in order: free, needing a card, incomplete,
 * or a card's facts. Pure: the host's isolated-world read and the job's merchant are its only inputs.
 */
export function decideGenericCheckout(
  read: CheckoutRead,
  context: GenericReadContext,
  now = Date.now(),
): GenericDecision {
  const lines: Line[] = read.region.lines
    .filter((line) => !volatileText(line.text))
    .map((line) => ({ text: line.text, box: line.box, money: positive(line.text) }));
  const label = squash(read.region.label);
  const origin = new URL(read.frameUrl).origin;
  const checkoutSite = siteOf(read.frameUrl);
  const platform = checkoutSite && checkoutSite !== context.merchant ? checkoutSite : undefined;
  const contact = readContactEmail(lines, read.region.fields);
  const contactEmail = contact === 'ambiguous' ? undefined : contact;
  const { account, guest } = readAccount(read, contactEmail);
  const booking = readBooking(read, lines, label);
  const items = readItems(lines, read.region.fields, booking);
  const note = readNote(read.region.fields);
  const payment = readPayment(read, lines);

  // KTD3: free only when the booking's own form or dialog states no money and no charge wording, and nothing on
  // the page offers or holds a way to pay.
  const free =
    !lines.some((line) => line.money.length || chargeWording(line.text)) &&
    !positive(label).length &&
    !offersPayment(read);
  if (free)
    return {
      status: 'free',
      facts: {
        flowId: GENERIC_FLOW_ID,
        site: context.merchant,
        origin,
        ...(platform ? { platform } : {}),
        control: { label, locator: context.locator },
        account: account ?? 'the signed-in account',
        guest,
        items,
        ...(contactEmail ? { contactEmail } : {}),
        ...(note ? { note } : {}),
        ...(booking ? { booking } : {}),
      },
    };

  const { terms, missing, boxes: termBoxes, currencies } = readTerms(lines, booking, now);
  const totals: Array<{ money: ConfirmationCharge; boxes: CheckoutBox[] }> = [];
  const dues: ConfirmationCharge[] = [];
  let nothingNow = false;
  lines.forEach((line, index) => {
    if (VOCABULARY.nothingNow.test(line.text)) nothingNow = true;
    const due = VOCABULARY.dueNow.test(line.text);
    if (!due && !(VOCABULARY.total.test(line.text) && !VOCABULARY.partialTotal.test(line.text))) return;
    const { money, boxes } = labelled(lines, index);
    if (due) dues.push(...money);
    else for (const amount of money) totals.push({ money: amount, boxes });
  });
  const totalValues = distinct(totals.map((total) => total.money));
  const partySize = booking?.partySize ?? 1;
  // What a term charges, beyond a fee that applies only on its condition.
  const charges = (kinds: ReadonlyArray<FinancialCommitment['kind']>): number =>
    terms
      .filter((term) => kinds.includes(term.kind))
      .reduce((sum, term) => sum + (term.amountMinor ?? 0) * (term.perPerson ? partySize : 1), 0);
  let total: ConfirmationCharge | undefined;
  if (totalValues.length === 1) total = totalValues[0];
  else if (!totalValues.length && terms.length && currencies.length === 1)
    // A booking that states only its terms charges its deposits, prepayments and holds; a fee only on its condition.
    total = { currency: currencies[0], amountMinor: charges(['deposit', 'prepayment', 'hold']) };
  const dueValues = distinct(dues);
  let dueNow: number | undefined;
  if (dueValues.length === 1) dueNow = dueValues[0].amountMinor;
  else if (dueValues.length) dueNow = undefined;
  else if (nothingNow) dueNow = 0;
  else if (totalValues.length === 1) dueNow = total?.amountMinor;
  else if (total) dueNow = charges(['deposit', 'prepayment']);
  const totalText =
    total && currencyExponent(total.currency) !== undefined
      ? formatMoney(total.amountMinor, total.currency)
      : undefined;

  if (!payment.payment && !payment.ambiguous)
    return {
      status: 'card_needed',
      needed: {
        site: context.merchant,
        ...(account ? { account } : {}),
        ...(items.length ? { items } : {}),
        ...(totalText ? { total: totalText } : {}),
      },
    };

  if (!items.length) missing.unshift('the items');
  if (!total) missing.push('the total');
  else if (dueNow === undefined) missing.push('the amount due now');
  if (!contactEmail) missing.push('the contact email');
  if (!account) missing.push('the account the purchase signs in with');
  if (payment.ambiguous) missing.push('which saved payment method pays');
  if (missing.length || !total || dueNow === undefined || !contactEmail || !account || !payment.payment)
    return { status: 'facts_incomplete', missing: distinct(missing) };

  // The card's picture shows the total and the commit control, placed on the main frame's viewport.
  const offset = {
    x: context.controlBox.x - read.region.controlBox.x,
    y: context.controlBox.y - read.region.controlBox.y,
  };
  const totalBoxes = totals.find((candidate) => candidate.money === total)?.boxes ?? termBoxes.slice(0, 1);
  const totalRegion = totalBoxes.length ? union(totalBoxes) : undefined;
  return {
    status: 'ready',
    facts: {
      flowId: GENERIC_FLOW_ID,
      site: context.merchant,
      origin,
      control: { label, locator: context.locator },
      account,
      items: [],
      currency: total.currency,
      totalMinor: total.amountMinor,
      dueNowMinor: dueNow,
      cardEnding: payment.cardEnding,
      address: null,
      commitments: terms,
      generic: {
        ...(platform ? { platform } : {}),
        guest,
        contactEmail,
        items,
        payment: payment.payment,
        ...(note ? { note } : {}),
        ...(booking ? { booking } : {}),
      },
    },
    regions: {
      control: context.controlBox,
      ...(totalRegion ? { total: { ...totalRegion, x: totalRegion.x + offset.x, y: totalRegion.y + offset.y } } : {}),
    },
  };
}

// ---------------------------------------------------------------- where the job entered checkout (KTD7)

interface CheckoutEntry {
  /** The site of the page's current top-level document. */
  site?: string;
  /** The merchant it was entered from, when it is a payment platform's page; else the site is its own merchant. */
  merchant?: string;
  /** The page's latest top-level navigation requests. */
  readonly requests: Request[];
}
const entries = new WeakMap<Page, CheckoutEntry>();

/**
 * Follows the page's top-level documents, so a payment platform's own page keeps the merchant whose checkout
 * sent the page there: a redirect leaving a checkout route, a form post, or a load of a payment processor's page
 * from another site. Any other new site is its own merchant.
 */
async function prepareGenericPage(page: Page): Promise<void> {
  if (entries.has(page)) return;
  // A job page is prepared before its first document; a page prepared later starts tracking from its next one.
  const entry: CheckoutEntry = { requests: [] };
  entries.set(page, entry);
  page.on('request', (request) => {
    if (!request.isNavigationRequest()) return;
    try {
      if (request.frame() !== page.mainFrame()) return;
    } catch (error) {
      // A service worker's request has no document frame: it is no top-level navigation.
      if (!(error instanceof Error) || !/Service Worker|Frame for this request is not available/iu.test(error.message))
        throw error;
      return;
    }
    entry.requests.push(request);
    if (entry.requests.length > 20) entry.requests.shift();
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const site = siteOf(frame.url());
    const previous = entry.site;
    const from = entry.merchant ?? previous;
    entry.site = site;
    if (site === previous) return;
    const address = frame.url().replace(/#.*$/u, '');
    const request = [...entry.requests].reverse().find((candidate) => candidate.url().replace(/#.*$/u, '') === address);
    let root = request;
    for (let hop = root?.redirectedFrom(); hop; hop = hop.redirectedFrom()) root = hop;
    const rootSite = root ? siteOf(root.url()) : undefined;
    let merchant: string | undefined;
    if (
      root &&
      rootSite &&
      rootSite !== site &&
      (root.method() !== 'GET' || VOCABULARY.checkoutPath.test(new URL(root.url()).pathname))
    )
      merchant = rootSite === previous ? from : rootSite;
    else if (previous && request && (request.method() !== 'GET' || paymentProcessorHost(new URL(frame.url()).hostname)))
      merchant = from;
    entry.merchant = merchant === site ? undefined : merchant;
  });
}

/** The merchant a page's checkout belongs to (KTD7): where the job entered checkout from, else the page's site. */
function checkoutMerchant(page: Page): string | undefined {
  const site = siteOf(page.url());
  const entry = entries.get(page);
  return entry?.site === site && entry?.merchant ? entry.merchant : site;
}

// ---------------------------------------------------------------- reading and pressing

/** Re-finds an approved control by its locator, or undefined when the page no longer shows it there. */
async function locate(page: Page, locator: StructuredBrowserLocator): Promise<ElementHandle | undefined> {
  return resolveLocator(page, locator).catch(() => undefined);
}

/**
 * The page's one commit control: the visible, enabled presses the classifier calls a purchase, which must all
 * carry the same name. Two different ones leave no next step to press.
 */
async function findGenericCommit(page: Page): Promise<ElementHandle | undefined> {
  const found: Array<{ element: ElementHandle; name: string }> = [];
  const discard = async (element: ElementHandle): Promise<void> => {
    await element.dispose().catch(() => undefined);
  };
  for (const frame of page.frames()) {
    const handles = await frame
      .locator(CANDIDATES)
      .elementHandles()
      .catch(() => []);
    for (const handle of handles) {
      // A cheap first cut in the page's own world; the classification reads the control in an isolated one.
      const said = await handle
        .evaluate((node) => {
          const e = node as unknown as {
            getAttribute(name: string): string | null;
            value?: string;
            textContent: string | null;
          };
          return [e.getAttribute('aria-label'), e.value, e.textContent].filter(Boolean).join(' ');
        })
        .catch(() => '');
      if (!VOCABULARY.commitWords.test(said) || !(await handle.isVisible()) || !(await handle.isEnabled())) {
        await discard(handle);
        continue;
      }
      const facts = await readPageControlFacts(page, handle).catch(() => undefined);
      if (facts && classifyControlFacts(facts) === 'purchase_control')
        found.push({ element: handle, name: squash(facts.name) });
      else await discard(handle);
    }
  }
  if (distinct(found.map((candidate) => candidate.name)).length === 1) {
    for (const candidate of found.slice(1)) await discard(candidate.element);
    return found[0].element;
  }
  for (const candidate of found) await discard(candidate.element);
  return undefined;
}

/** Reads the checkout `target` commits, the approved one `expected` names, or the page's one commit control. */
async function readGenericPurchase(
  page: Page,
  target?: ElementHandle,
  expected?: PurchaseFacts,
): Promise<MerchantCheckoutRead> {
  const element =
    target ??
    (expected?.control.locator ? await locate(page, expected.control.locator) : await findGenericCommit(page));
  if (!element) return { status: 'checkout_lapsed' };
  let kept = false;
  try {
    const frame = await element.ownerFrame();
    const merchant = checkoutMerchant(page);
    if (!frame || frame.page() !== page || !merchant) return { status: 'checkout_lapsed' };
    const [read, controlBox] = await Promise.all([readCheckoutRegion(page, element), element.boundingBox()]);
    if (!controlBox) return { status: 'checkout_lapsed' };
    let locator: StructuredBrowserLocator;
    try {
      locator = await captureElementLocator(
        element,
        flatten(ariaNodes(browserStructureFacts(page)?.tree)),
        read.facts.name,
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { status: 'facts_incomplete', missing: ["the checkout's place-order button"] };
    }
    const decision = decideGenericCheckout(read, { merchant, locator, controlBox });
    switch (decision.status) {
      case 'free':
        kept = true;
        return { status: 'free', facts: decision.facts, element };
      case 'ready':
        kept = true;
        return { status: 'ready', facts: decision.facts, element, regions: decision.regions };
      case 'card_needed':
        return { status: 'card_needed', needed: decision.needed };
      case 'facts_incomplete':
        return { status: 'facts_incomplete', missing: decision.missing };
      default: {
        const unknown: never = decision;
        throw new Error(`Unknown checkout decision ${JSON.stringify(unknown)}`);
      }
    }
  } catch (error) {
    // A page that moved on mid-read has no checkout left to read.
    if (error instanceof ControlFactsUnavailableError) return { status: 'checkout_lapsed' };
    throw error;
  } finally {
    if (!kept && !target) await element.dispose().catch(() => undefined);
  }
}

/**
 * Waits for a press's result (KTD4): every document it loads, in any frame, through its redirects, until the
 * page is still; a press that loads nothing is given a short settle. Starts listening before the press.
 */
async function waitForGenericResult(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let navigated = false;
  let loading = 0;
  let last = Date.now();
  const started = (request: Request): void => {
    if (!request.isNavigationRequest()) return;
    navigated = true;
    loading++;
    last = Date.now();
  };
  const ended = (request: Request): void => {
    if (!request.isNavigationRequest()) return;
    loading = Math.max(0, loading - 1);
    last = Date.now();
  };
  const committed = (): void => {
    navigated = true;
    last = Date.now();
  };
  page.on('request', started);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  page.on('framenavigated', committed);
  try {
    while (Date.now() < deadline && !page.isClosed()) {
      await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_MS));
      const quiet = Date.now() - last;
      if (navigated ? loading === 0 && quiet >= RESULT_QUIET_MS : quiet >= RESULT_SETTLE_MS) break;
    }
    if (navigated && !page.isClosed())
      await page
        .waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) })
        .catch(() => undefined);
  } finally {
    page.off('request', started);
    page.off('requestfinished', ended);
    page.off('requestfailed', ended);
    page.off('framenavigated', committed);
  }
}

/** What a page shows after a press: a decline, or another failure. */
export function pressRefusal(lines: readonly string[]): 'declined' | 'failed' | undefined {
  if (lines.some((line) => VOCABULARY.decline.test(line))) return 'declined';
  return lines.some((line) => VOCABULARY.failure.test(line)) ? 'failed' : undefined;
}

/** Whether a confirmation is the merchant's own, or its payment platform's: a document on another site proves nothing of its attempt. */
export function confirmsOnSite(confirmation: ConfirmationEvidence, site: string, platform?: string): boolean {
  const at = siteOf(confirmation.source);
  return at !== undefined && (at === site || at === platform);
}

/**
 * What a confirmation page proves of a paid attempt on an unreviewed site (KTD8): an order number on a document
 * of its merchant or payment platform, and any charge it states in the attempt's currency at its total or its
 * amount due now. The attempt's contact email keys the order number (KTD5).
 */
async function readGenericEvidence(
  page: Page,
  attempted?: PurchaseFacts,
): Promise<MerchantPurchaseEvidence | undefined> {
  const generic = attempted?.generic;
  if (!attempted || !generic) return undefined;
  const confirmation = await readConfirmation(page);
  if (!confirmation || !confirmsOnSite(confirmation, attempted.site, generic.platform)) return undefined;
  const { charged } = confirmation;
  if (
    charged &&
    (charged.currency !== attempted.currency ||
      (charged.amountMinor !== attempted.totalMinor && charged.amountMinor !== attempted.dueNowMinor))
  )
    return undefined;
  return {
    flowId: GENERIC_FLOW_ID,
    source: confirmation.source,
    recordId: confirmation.reference,
    orderedAt: new Date().toISOString(),
    resolution: 'committed',
    account: generic.contactEmail,
    items: [],
    totalMinor: charged?.amountMinor ?? attempted.totalMinor,
    currency: attempted.currency,
    cardEnding: attempted.cardEnding,
    address: null,
  };
}

/**
 * The generic signature: any web page no reviewed signature matches. It has no reviewed routes or controls, and
 * no merchant records of its own: a confirmation page proves what it placed.
 */
export const genericCheckoutSignature: MerchantSignature = {
  id: GENERIC_FLOW_ID,
  evidenceOrigins: [],
  matches: (url) => url.protocol === 'https:' || url.protocol === 'http:',
  classifyControl: () => Promise.resolve(undefined),
  classifyNavigation: () => undefined,
  /** The generic verifier (KTD4): a connected, visible, enabled control on this page. */
  async verifyPurchaseControl(page, element) {
    const frame = await element.ownerFrame();
    return Boolean(frame && frame.page() === page && (await element.isVisible()) && (await element.isEnabled()));
  },
  preparePage: prepareGenericPage,
  readPurchase: readGenericPurchase,
  waitForResult: waitForGenericResult,
  readEvidence: readGenericEvidence,
};
