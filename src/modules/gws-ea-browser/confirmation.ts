/**
 * What a page confirms was bought, booked or paid (KTD8, KTD10), read document by document in Playwright's
 * utility world, so page script cannot rewrite what the reader sees. One set of evidence rules serves the check
 * after every ordinary press and an approved purchase's proof from its page:
 *
 *   - an order, booking or confirmation number, with thank-you or confirmation wording beside it;
 *   - what the document says was charged: a total, a payment or a deposit with its amount;
 *   - schema.org Order or Reservation data, when the document carries it, which stands for both.
 *
 * A charge is only ever what a document states: a waitlist number or a $0.00 registration charged nothing.
 */
import type { Frame, Page } from 'playwright-core';

import { isRecord } from '../../gws-ea/validation.js';
import { amountMinor } from './fingerprint.js';

/** An amount a document says was charged, in minor units of its currency. */
export interface ConfirmationCharge {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface ConfirmationEvidence {
  /** The document's origin and path; its query and fragment can carry tokens, so they are left out. */
  readonly source: string;
  /** The order, booking or confirmation number it shows. */
  readonly reference: string;
  /** The largest amount it says was charged, paid or put down; absent when it states none. */
  readonly charged?: ConfirmationCharge;
  /** It carried schema.org Order or Reservation data. */
  readonly structured: boolean;
}

/** How long one document's read may take. */
const READ_TIMEOUT_MS = 2_000;
/** A label alone on its line, whose amount stands on the next: "Order total", then "$42.00". */
const LABEL_WORDS = 4;

/** What the reader recognizes in a document's words. Vocabulary is data: widen or narrow it here. */
const CONFIRMATION_VOCABULARY = {
  confirmed:
    /\bthank(?:s|\s+you)\b|\b(?:order|booking|reservation|appointment|registration|purchase|payment|subscription)\s+(?:(?:is|has\s+been|was)\s+)?(?:confirmed|placed|received|completed?|successful)\b|\byou(?:'re|’re|\s+are)\s+(?:all\s+set|booked|confirmed|registered)\b|\bconfirmation\b/iu,
  /** A labelled number: the label, then a token of letters, digits and dashes that holds a digit. */
  reference:
    /\b(?:order|confirmation|booking|reservation|reference|receipt|transaction|ticket|registration)\s*(?:number|no\.?|num|#|id|code)?\s*[:#]?\s*#?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{2,39})\b/iu,
  /** What was charged: a total, a payment, or what was paid, charged or put down as a deposit. A subtotal is none. */
  charge: /(?<!\bsub[\s-]?)\btotal\b|\b(?:paid|charged|payment|deposit)\b/iu,
} as const satisfies Record<string, RegExp>;

const SYMBOLS: Readonly<Record<string, string>> = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };
const CODES = 'USD|EUR|GBP|CAD|AUD|NZD|JPY|CHF|INR|MXN|SGD|HKD';
/** An amount with its currency before it ("$42.00", "USD 42") or after it ("42,00 €", "42.00 EUR"). */
const AMOUNT = new RegExp(
  `(?:([$€£¥₹])|\\b(${CODES})\\s?)(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?|(\\d{1,3}(?:[.,\\s]\\d{3})+|\\d+)(?:[.,](\\d{2}))?\\s?(?:(€|£)|(${CODES})\\b)`,
  'giu',
);

function charge(currency: string, whole: string, fraction = ''): ConfirmationCharge | undefined {
  const minor = amountMinor(`${whole.replace(/[,.\s]/gu, '')}${fraction ? `.${fraction}` : ''}`, currency);
  return minor === undefined ? undefined : { amountMinor: minor, currency };
}

/** Every amount a line states, with its currency. */
export function statedAmounts(line: string): ConfirmationCharge[] {
  const found: ConfirmationCharge[] = [];
  for (const match of line.matchAll(AMOUNT)) {
    const [, symbol, code, whole, fraction, trailingWhole, trailingFraction, trailingSymbol, trailingCode] = match;
    const parsed = whole
      ? charge(symbol ? SYMBOLS[symbol] : (code ?? '').toUpperCase(), whole, fraction)
      : charge(
          trailingSymbol ? SYMBOLS[trailingSymbol] : (trailingCode ?? '').toUpperCase(),
          trailingWhole,
          trailingFraction,
        );
    if (parsed) found.push(parsed);
  }
  return found;
}

/** The amounts a document's lines say were charged: on a charge line, or alone on the line after a short label. */
function textCharges(lines: readonly string[]): ConfirmationCharge[] {
  const found: ConfirmationCharge[] = [];
  lines.forEach((line, index) => {
    if (!CONFIRMATION_VOCABULARY.charge.test(line)) return;
    const own = statedAmounts(line);
    if (own.length) {
      found.push(...own);
      return;
    }
    const next = lines[index + 1];
    if (line.split(/\s+/u).length <= LABEL_WORDS && next !== undefined) {
      const following = statedAmounts(next);
      if (following.length === 1 && next.replace(AMOUNT, '').trim() === '') found.push(following[0]);
    }
  });
  return found;
}

const REFERENCE_SHAPE = /^(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{2,39}$/iu;
const STRUCTURED_TYPE = /^(?:https?:\/\/schema\.org\/)?(?:Order|\w*Reservation)$/u;

/** Every object a JSON-LD document holds, arrays and graphs unwrapped. */
function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isRecord(value)) return [];
  return [value, ...nodes(value['@graph'])];
}

/** A schema.org price: a number or numeric text, with its own currency or its holder's. */
function priceCharges(value: unknown, currency: unknown): ConfirmationCharge[] {
  if (Array.isArray(value)) return value.flatMap((item) => priceCharges(item, currency));
  if (isRecord(value))
    return [
      ...priceCharges(value.price, value.priceCurrency ?? currency),
      ...priceCharges(value.priceSpecification, value.priceCurrency ?? currency),
      ...priceCharges(value.totalPaymentDue, value.priceCurrency ?? currency),
    ];
  if ((typeof value !== 'number' && typeof value !== 'string') || typeof currency !== 'string') return [];
  const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(String(value).trim());
  const parsed = match ? charge(currency.toUpperCase(), match[1], match[2]) : undefined;
  return parsed ? [parsed] : [];
}

/** The reference and charges of a document's schema.org Order or Reservation data; undefined when it has none. */
function structuredEvidence(
  sources: readonly string[],
): { reference?: string; charges: ConfirmationCharge[] } | undefined {
  let found: { reference?: string; charges: ConfirmationCharge[] } | undefined;
  for (const source of sources) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    for (const node of nodes(parsed)) {
      const types = (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).filter(
        (type): type is string => typeof type === 'string',
      );
      if (!types.some((type) => STRUCTURED_TYPE.test(type))) continue;
      found ??= { charges: [] };
      const reference = [node.orderNumber, node.confirmationNumber, node.reservationNumber, node.reservationId].find(
        (value): value is string => typeof value === 'string' && REFERENCE_SHAPE.test(value.trim()),
      );
      if (reference && !found.reference) found.reference = reference.trim();
      found.charges.push(
        ...priceCharges(node.totalPaymentDue, node.priceCurrency),
        ...priceCharges(node.totalPrice, node.priceCurrency),
        ...priceCharges(node.price, node.priceCurrency),
        ...priceCharges(node.acceptedOffer, node.priceCurrency),
      );
    }
  }
  return found;
}

/** The largest charge, if any amount was stated. */
function largest(charges: readonly ConfirmationCharge[]): ConfirmationCharge | undefined {
  return charges.reduce<ConfirmationCharge | undefined>(
    (best, candidate) => (!best || candidate.amountMinor > best.amountMinor ? candidate : best),
    undefined,
  );
}

/** One document's evidence, from its visible words and its structured data. */
export function confirmationEvidence(
  address: string,
  text: string,
  structuredSources: readonly string[],
): ConfirmationEvidence | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const structured = structuredEvidence(structuredSources);
  const worded = lines.some((line) => CONFIRMATION_VOCABULARY.confirmed.test(line));
  const textReference = lines
    .map((line) => CONFIRMATION_VOCABULARY.reference.exec(line)?.[1])
    .find((reference) => reference !== undefined);
  const reference = structured?.reference ?? (worded ? textReference : undefined);
  if (!reference || !URL.canParse(address)) return undefined;
  const url = new URL(address);
  const charged = largest([...(structured?.charges ?? []), ...textCharges(lines)]);
  return {
    source: `${url.origin}${url.pathname}`,
    reference,
    ...(charged ? { charged } : {}),
    structured: structured !== undefined,
  };
}

/** One document's evidence; a document that went away, navigated or never answered within its bound has none. */
async function readFrame(frame: Frame): Promise<ConfirmationEvidence | undefined> {
  /* eslint-disable no-catch-all/no-catch-all -- what was pressed already ran: a document that cannot be read confirms nothing */
  try {
    const [text, structured] = await Promise.all([
      frame.locator('body').innerText({ timeout: READ_TIMEOUT_MS }),
      frame.locator('script[type="application/ld+json" i]').allTextContents(),
    ]);
    return confirmationEvidence(frame.url(), text, structured);
  } catch (_error) {
    return undefined;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** The visible lines of every document on the page, the main document first; a document that cannot be read has none. */
export async function readPageLines(page: Page): Promise<string[]> {
  const read = async (frame: Frame): Promise<string[]> => {
    /* eslint-disable no-catch-all/no-catch-all -- a document that went away or never answered within its bound shows nothing */
    try {
      return (await frame.locator('body').innerText({ timeout: READ_TIMEOUT_MS }))
        .split('\n')
        .map((line) => line.replace(/\s+/gu, ' ').trim())
        .filter(Boolean);
    } catch (_error) {
      return [];
    }
    /* eslint-enable no-catch-all/no-catch-all */
  };
  return (await Promise.all(page.frames().map(read))).flat();
}

/** Whether evidence shows a charge: a nonzero total, payment or deposit. */
export function showsCharge(evidence: ConfirmationEvidence): boolean {
  return (evidence.charged?.amountMinor ?? 0) > 0;
}

/**
 * What the page's documents confirm, the main document first: the first that shows a charge, else the first
 * confirmation at all; undefined when no document confirms anything.
 */
export async function readConfirmation(page: Page): Promise<ConfirmationEvidence | undefined> {
  const found = (await Promise.all(page.frames().map(readFrame))).filter(
    (evidence): evidence is ConfirmationEvidence => evidence !== undefined,
  );
  return found.find(showsCharge) ?? found[0];
}
