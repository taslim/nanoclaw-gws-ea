/** Reviewed Resy diner flow. Grounding: widgets.resy.com app.6cd2eae9cf1252db3fe7.js
 * and its embed.js; public /4/find responses supply explicit slot intervals.
 * Source identifiers describe a narrow contract: missing/drifted terms are never zero.
 */
import { createHash } from 'node:crypto';
import type { ElementHandle, Frame, Page, Request, Response } from 'playwright-core';
import { isRecord } from '../../gws-ea/validation.js';
import type { ActionClass } from './control-policy.js';
import type { ControlFacts } from './control-facts.js';
import { amountMinor, currencyExponent, type PurchaseFacts, type ReservationFacts } from './fingerprint.js';
import {
  REVIEWED_CHECKOUT_MISSING,
  type MerchantPurchaseEvidence,
  type MerchantSignature,
  type ReservationAvailability,
  type ReservationPolicy,
} from './merchant-contract.js';
import {
  bindPageSecretDocuments,
  registerPageRedaction,
  registerPageSecret,
  releasePageSecret,
} from './page-privacy.js';

const ORIGINS = ['https://resy.com', 'https://widgets.resy.com'] as const;
const API = 'https://api.resy.com';
const FLOW = 'resy-diner-reservation-v1';
const COMMIT = '[data-test-id="order_summary_page-button-book"]';
const CARD_COMMIT = '[data-test-id="select_credit_card_page-button-book"]';
const MAX_AGE = 120_000;
const MAX_BODY = 4 * 1024 * 1024;
const BODY_TIMEOUT = 5000;
const METHODS = new Map([
  ['/4/find', 'POST'],
  ['/3/venue', 'GET'],
  ['/3/details', 'POST'],
  ['/2/user', 'GET'],
  ['/3/book', 'POST'],
  ['/3/user/reservations', 'GET'],
]);
interface Capture {
  frame: Frame;
  frameDocument: string;
  generation: number;
  at: number;
  sequence: number;
  data: Record<string, unknown>;
  request: Record<string, unknown>;
}
interface NativeSlot {
  token: string;
  id: string;
  type: string;
  reservation: ReservationFacts;
  payment: Record<string, unknown>;
  hasAddOns: boolean;
}
interface Inventory {
  capture: Capture;
  venueId: string;
  venueName: string;
  partySize: number;
  currency: string;
  timeZone: string;
  slots: NativeSlot[];
}
interface Checkout {
  capture: Capture;
  facts: PurchaseFacts;
  paymentId?: string;
  bookToken: string;
  readSequence: number;
}
interface PageState {
  captures: Map<string, Capture>;
  latestSequence: Map<string, number>;
  requests: WeakMap<Request, { frame: Frame; frameDocument: string; generation: number }>;
  pending: Map<Promise<void>, { frame: Frame; path: string; cancel: () => void }>;
  sequence: number;
  blockedAt: number;
  changed: Set<() => void>;
  checkout?: Checkout;
}
const states = new WeakMap<Page, PageState>();
const documentGenerations = new WeakMap<Frame, number>();
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const normal = (value: string): string => value.replace(/\s+/gu, ' ').trim();
const object = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= 20_000 ? value : undefined;
const id = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === 'string' && /^[1-9]\d{0,19}$/u.test(value)
      ? value
      : undefined;
function trusted(url: string): boolean {
  try {
    return ORIGINS.some((origin) => new URL(url).origin === origin);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
}
function route(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.hash.startsWith('#/') ? u.hash.slice(1).split('?')[0] : u.pathname;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
}
function frameDocument(frame: Frame): string {
  const url = new URL(frame.url());
  return `${url.origin}${url.pathname}`;
}
function fresh(capture: Capture | undefined): capture is Capture {
  return (
    capture !== undefined &&
    Date.now() - capture.at >= 0 &&
    Date.now() - capture.at < MAX_AGE &&
    trusted(capture.frame.url()) &&
    !capture.frame.isDetached() &&
    capture.generation === (documentGenerations.get(capture.frame) ?? 0) &&
    capture.frameDocument === frameDocument(capture.frame)
  );
}
function nativeId(value: unknown): string | undefined {
  return id(value) ?? id(object(value)?.resy);
}
function canonicalZone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 80) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return undefined;
  }
}
/** Ambiguous/nonexistent DST wall times refuse; the venue's timezone is never guessed. */
function instant(value: unknown, zone: string): string | undefined {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return undefined;
  const fields = value.split(/[- :]/u).map(Number);
  const base = Date.UTC(fields[0], fields[1] - 1, ...(fields.slice(2) as [number, number, number, number]));
  if (new Date(base).toISOString().slice(0, 19).replace('T', ' ') !== value) return undefined;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const partsAt = (at: number): number[] => {
    const parts = formatter.formatToParts(at);
    return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((type) =>
      Number(parts.find((part) => part.type === type)?.value),
    );
  };
  const matches = new Set<number>();
  for (const delta of [-86_400_000, 0, 86_400_000]) {
    const sample = base + delta;
    const p = partsAt(sample);
    const offset = Date.UTC(p[0], p[1] - 1, ...(p.slice(2) as [number, number, number, number])) - sample;
    const candidate = base - offset;
    if (partsAt(candidate).every((part, index) => part === fields[index])) matches.add(candidate);
  }
  return matches.size === 1 ? new Date([...matches][0]).toISOString() : undefined;
}
function inventory(capture: Capture | undefined, venueId: string, partySize: number): Inventory | undefined {
  if (!fresh(capture)) return undefined;
  const query = object(capture.data.query);
  const venues = object(capture.data.results)?.venues;
  if (
    !query ||
    query.party_size !== partySize ||
    capture.request.party_size !== partySize ||
    !Array.isArray(venues) ||
    venues.length > 100
  )
    return undefined;
  const requested = String(capture.request.venue_id ?? '').split(',');
  if (!requested.includes(venueId) || requested.some((part) => !id(part))) return undefined;
  const matches = venues.filter((entry) => nativeId(object(object(entry)?.venue)?.id) === venueId);
  if (matches.length !== 1) return undefined;
  const entry = object(matches[0]);
  const venue = object(entry?.venue);
  const venueName = text(venue?.name);
  const currency = text(object(venue?.currency)?.code);
  const timeZone = canonicalZone(object(venue?.location)?.time_zone);
  const rawSlots = entry?.slots;
  if (
    !venueName ||
    !currency ||
    currencyExponent(currency) === undefined ||
    !timeZone ||
    !Array.isArray(rawSlots) ||
    rawSlots.length > 5000
  )
    return undefined;
  const slots: NativeSlot[] = [];
  for (const raw of rawSlots) {
    const slot = object(raw),
      config = object(slot?.config),
      date = object(slot?.date),
      size = object(slot?.size),
      payment = object(slot?.payment);
    const token = text(config?.token),
      type = text(config?.type);
    const at = instant(date?.start, timeZone),
      endAt = instant(date?.end, timeZone);
    if (
      !slot ||
      !token ||
      token.length > 4096 ||
      !type ||
      !at ||
      !endAt ||
      at >= endAt ||
      !payment ||
      typeof slot.has_add_ons !== 'boolean' ||
      typeof size?.min !== 'number' ||
      typeof size.max !== 'number' ||
      partySize < size.min ||
      partySize > size.max ||
      !String(date?.start).startsWith(`${query.day} `)
    )
      return undefined;
    slots.push({
      token,
      type,
      id: hash(JSON.stringify([venueId, partySize, token, at, endAt])),
      reservation: { venueId, venueName, partySize, at, endAt, timeZone },
      payment,
      hasAddOns: slot.has_add_ons,
    });
  }
  return { capture, venueId, venueName, partySize, currency, timeZone, slots };
}
function requestBody(response: Response): Record<string, unknown> | undefined {
  const request = response.request();
  const raw = request.postData();
  if (raw !== null && Buffer.byteLength(raw) > 65_536) return undefined;
  try {
    if (request.method() === 'GET') return Object.fromEntries(new URL(response.url()).searchParams);
    if (new URL(response.url()).pathname === '/3/book') return Object.fromEntries(new URLSearchParams(raw ?? ''));
    return object(JSON.parse(raw ?? '{}') as unknown);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    return undefined;
  }
}
function registerBearer(page: Page, value: string): void {
  registerPageSecret(page, value);
  void bindPageSecretDocuments(page, value)
    .then(() => releasePageSecret(page, value))
    .catch(() => undefined);
}
function redactUrl(page: Page, frame: Frame): void {
  const raw = frame.url();
  if (!trusted(raw)) return;
  const url = new URL(raw);
  const queries = [url.searchParams];
  const question = url.hash.indexOf('?');
  if (question !== -1) queries.push(new URLSearchParams(url.hash.slice(question + 1)));
  for (const params of queries)
    for (const [key, value] of params) {
      if (/token/iu.test(key) && value) {
        registerPageRedaction(page, raw);
        registerBearer(page, value);
      }
      if (key === 'reservation') {
        registerPageRedaction(page, raw);
        registerPageRedaction(page, value);
      }
    }
  const token = /\/account\/reservations-and-notify\/([^/?#]+)/u.exec(url.hash)?.[1];
  if (token) {
    registerPageRedaction(page, raw);
    registerBearer(page, token);
  }
}
async function captureResponse(
  page: Page,
  state: PageState,
  response: Response,
  sequence: number,
  cancelled: Promise<undefined>,
): Promise<void> {
  const url = new URL(response.url());
  const path = url.pathname;
  if (url.origin !== API || METHODS.get(path) !== response.request().method()) return;
  const source = state.requests.get(response.request());
  if (!source) return;
  const { frame } = source;
  const current = (): boolean => source.generation === (documentGenerations.get(frame) ?? 0);
  // A bound commit response remains evidence when its own success navigates the frame.
  const boundBook = (): boolean =>
    path === '/3/book' &&
    state.checkout?.capture.frame === frame &&
    state.checkout.capture.generation === source.generation &&
    requestBody(response)?.book_token === state.checkout.bookToken;
  if (!current() && !boundBook()) return;
  state.latestSequence.set(path, sequence);
  state.captures.delete(path);
  if ([401, 403, 429].includes(response.status())) {
    state.blockedAt = Date.now();
    state.captures.delete(path);
    return;
  }
  if (response.status() !== 200) {
    state.captures.delete(path);
    return;
  }
  const headers = response.headers();
  if (
    !/^application\/json(?:;|$)/iu.test(headers['content-type'] ?? '') ||
    Number(headers['content-length'] ?? 0) > MAX_BODY
  ) {
    state.captures.delete(path);
    return;
  }
  const request = requestBody(response);
  if (!request) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bytes: Buffer | undefined;
  try {
    bytes = await Promise.race([
      response.body(),
      cancelled,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), BODY_TIMEOUT);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!bytes || (!current() && !boundBook())) return;
  if (bytes.byteLength > MAX_BODY) {
    state.captures.delete(path);
    return;
  }
  const data = object(JSON.parse(bytes.toString('utf8')) as unknown);
  if (!data || sequence !== state.latestSequence.get(path)) return;
  if (path === '/3/details') {
    const token = text(object(data.book_token)?.value);
    if (token) registerBearer(page, token);
  }
  if (path === '/3/book') {
    const token = text(data.resy_token);
    if (token) registerBearer(page, token);
  }
  state.captures.set(path, { ...source, sequence, at: Date.now(), data, request });
}
async function preparePage(page: Page): Promise<void> {
  if (states.has(page)) return;
  const state: PageState = {
    captures: new Map(),
    latestSequence: new Map(),
    requests: new WeakMap(),
    pending: new Map(),
    sequence: 0,
    blockedAt: 0,
    changed: new Set(),
  };
  states.set(page, state);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!request.isNavigationRequest() && (url.origin !== API || METHODS.get(url.pathname) !== request.method()))
      return;
    let frame: Frame;
    try {
      frame = request.frame();
    } catch (error) {
      if (!(error instanceof Error) || !/Service Worker|Frame for this request is not available/iu.test(error.message))
        throw error;
      // Service-worker requests lack a document frame and cannot ground this signature.
      return;
    }
    if (request.isNavigationRequest()) {
      documentGenerations.set(frame, (documentGenerations.get(frame) ?? 0) + 1);
      for (const [path, capture] of state.captures)
        if (capture.frame === frame && path !== '/3/book') state.captures.delete(path);
      for (const [work, pending] of state.pending)
        if (pending.frame === frame && pending.path !== '/3/book') {
          pending.cancel();
          state.pending.delete(work);
        }
      return;
    }
    if (url.origin === API && METHODS.get(url.pathname) === request.method() && trusted(frame.url()))
      state.requests.set(request, {
        frame,
        frameDocument: frameDocument(frame),
        generation: documentGenerations.get(frame) ?? 0,
      });
  });
  page.on('framenavigated', (frame) => redactUrl(page, frame));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== API || METHODS.get(url.pathname) !== response.request().method()) return;
    const source = state.requests.get(response.request());
    if (!source) return;
    if (state.pending.size >= 16) {
      const barrier = ++state.sequence;
      for (const path of METHODS.keys()) state.latestSequence.set(path, barrier);
      state.captures.clear();
      return;
    }
    const sequence = ++state.sequence;
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
    });
    const work = captureResponse(page, state, response, sequence, cancelled)
      .catch(() => undefined)
      .finally(() => {
        state.pending.delete(work);
        for (const notify of state.changed) notify();
      });
    state.pending.set(work, { frame: source.frame, path: url.pathname, cancel });
  });
  page.once('close', () => {
    for (const pending of state.pending.values()) pending.cancel();
    for (const notify of state.changed) notify();
    states.delete(page);
  });
  for (const frame of page.frames()) redactUrl(page, frame);
}
async function settled(page: Page): Promise<PageState> {
  await preparePage(page);
  const state = states.get(page);
  if (!state) throw new Error('Resy page closed');
  await Promise.all([...state.pending.keys()]);
  return state;
}
function checkoutInventory(state: PageState, details: Capture): { inventory: Inventory; slot: NativeSlot } | undefined {
  const partySize = details.request.party_size,
    token = text(details.request.config_id);
  const venueId = nativeId(object(details.data.venue)?.id);
  if (typeof partySize !== 'number' || !Number.isSafeInteger(partySize) || partySize < 1 || !token || !venueId)
    return undefined;
  const inv = inventory(state.captures.get('/4/find'), venueId, partySize);
  const slots = inv?.slots.filter((slot) => slot.token === token);
  return inv && slots?.length === 1 && details.request.day === object(inv.capture.data.query)?.day
    ? { inventory: inv, slot: slots[0] }
    : undefined;
}
/** Entire reviewed financial sentence, never a matching fragment among unknown clauses. */
function feePolicy(
  policy: string[],
  amount: number,
  currency: string,
): { beforeMs: number; terms: string } | undefined {
  if (policy.length !== 1 || currency !== 'USD') return undefined;
  const terms = normal(policy[0]);
  const match =
    /^We have a ([1-9]\d{0,2})-hour cancellation\/no-show policy of \$([0-9]+(?:\.[0-9]{2})?) per person for guests booking with us\.$/u.exec(
      terms,
    ) ??
    /^A cancellation fee of up to \$([0-9]+(?:\.[0-9]{2})?) per person may be charged for no-shows or cancellations made within ([1-9]\d{0,2}) hours of the reservation time\.$/u
      .exec(terms)
      ?.map((value, index, values) => (index === 1 ? values[2] : index === 2 ? values[1] : value));
  if (!match || amountMinor(match[2], currency) !== amount) return undefined;
  return { beforeMs: Number(match[1]) * 3_600_000, terms };
}
function onlyReviewedFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.entries(value).every(([key, field]) => allowed.includes(key) || field === null);
}
function noServiceCharge(value: unknown): boolean {
  if (value === undefined || value === null || value === 0) return true;
  const charge = object(value);
  return Boolean(
    charge &&
    onlyReviewedFields(charge, ['amount', 'value']) &&
    charge.amount === 0 &&
    (charge.value === undefined || charge.value === null || charge.value === '0' || charge.value === '0%'),
  );
}
function reviewedZeroPayment(payment: Record<string, unknown>, amounts: Record<string, unknown>): boolean {
  const config = object(payment.config);
  if (
    !onlyReviewedFields(payment, ['amounts', 'options', 'config']) ||
    !onlyReviewedFields(amounts, [
      'add_ons',
      'items',
      'price_per_unit',
      'quantity',
      'reservation_charge',
      'resy_fee',
      'service_fee',
      'service_charge',
      'subtotal',
      'surcharge',
      'tax',
      'total',
    ]) ||
    (payment.options !== undefined &&
      payment.options !== null &&
      (!Array.isArray(payment.options) || payment.options.length !== 0)) ||
    (payment.config !== undefined &&
      payment.config !== null &&
      (!config || !onlyReviewedFields(config, ['type']) || config.type !== 'free')) ||
    !noServiceCharge(amounts.service_charge)
  )
    return false;
  return [
    'add_ons',
    'price_per_unit',
    'reservation_charge',
    'resy_fee',
    'service_fee',
    'subtotal',
    'surcharge',
    'tax',
  ].every((key) => amounts[key] === undefined || amounts[key] === null || amounts[key] === 0);
}
function policyFor(details: Capture, slot: NativeSlot, currency: string): ReservationPolicy | undefined {
  const payment = object(details.data.payment),
    amounts = object(payment?.amounts),
    cancellation = object(details.data.cancellation),
    display = object(cancellation?.display),
    config = object(details.data.config);
  const policy = display?.policy;
  if (
    !payment ||
    !amounts ||
    !cancellation ||
    !config ||
    !reviewedZeroPayment(payment, amounts) ||
    !onlyReviewedFields(cancellation, ['fee', 'display']) ||
    !noServiceCharge(slot.payment.service_charge) ||
    (slot.payment.payment_structure !== undefined && slot.payment.payment_structure !== null) ||
    (slot.payment.service_charge_options !== undefined &&
      (!Array.isArray(slot.payment.service_charge_options) || slot.payment.service_charge_options.length !== 0)) ||
    config.double_confirmation ||
    !Array.isArray(policy) ||
    policy.length > 10 ||
    !policy.every((item) => typeof item === 'string' && item.length <= 10_000) ||
    amounts.total !== 0 ||
    !Array.isArray(amounts.items) ||
    amounts.items.length ||
    slot.hasAddOns ||
    slot.payment.is_add_on_required !== false ||
    slot.payment.deposit_fee !== null ||
    (Array.isArray(details.request.struct_items)
      ? details.request.struct_items.length > 0
      : details.request.struct_items !== undefined) ||
    (config.add_ons !== undefined && (!Array.isArray(config.add_ons) || config.add_ons.length))
  )
    return undefined;
  if (cancellation.fee === null) {
    if (slot.payment.cancellation_fee !== null || policy.length !== 0) return undefined;
    return {
      currency,
      dueNowMinor: 0,
      commitments: [],
      noCommitmentTerms: 'No payment due at booking and no cancellation or no-show fee.',
    };
  }
  const fee = object(cancellation.fee),
    amount = typeof fee?.amount === 'number' ? amountMinor(fee.amount, currency) : undefined;
  if (
    !fee ||
    !onlyReviewedFields(fee, ['amount', 'display']) ||
    amount === undefined ||
    amount <= 0 ||
    amountMinor(String(slot.payment.cancellation_fee), currency) !== amount
  )
    return undefined;
  const parsed = feePolicy(policy as string[], amount, currency);
  if (!parsed) return undefined;
  // Calendar-day cutoffs are a distinct native variant; a relative-hours grammar cannot explain them.
  if (
    (slot.payment.time_cancel_cut_off !== undefined && slot.payment.time_cancel_cut_off !== null) ||
    (slot.payment.secs_cancel_cut_off !== undefined &&
      slot.payment.secs_cancel_cut_off !== null &&
      slot.payment.secs_cancel_cut_off !== parsed.beforeMs / 1000)
  )
    return undefined;
  const total = amount * slot.reservation.partySize;
  if (!Number.isSafeInteger(total)) return undefined;
  return {
    currency,
    dueNowMinor: 0,
    commitments: [
      {
        kind: 'conditional_fee',
        amountMinor: amount,
        perPerson: true,
        terms: parsed.terms,
        trigger: 'Cancellation within the stated notice period or no-show',
        conditionalTrigger: 'cancellation',
        cancellationTerms: parsed.terms,
        cancellationBeforeMs: parsed.beforeMs,
      },
    ],
  };
}
async function oneText(frame: Frame, selector: string): Promise<string | undefined> {
  const locator = frame.locator(selector);
  return (await locator.count()) === 1 && (await locator.isVisible())
    ? normal(await locator.innerText({ timeout: 2000 }))
    : undefined;
}
async function summaryMatches(frame: Frame, slot: NativeSlot, policies: string[]): Promise<boolean> {
  const title = await oneText(frame, '.SummaryPage__ScrollView .ReservationSummary__title');
  const at = new Date(slot.reservation.at);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: slot.reservation.timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(at);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: slot.reservation.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
  if (
    title !== slot.reservation.venueName ||
    (await oneText(frame, '.SummaryPage__ScrollView .ReservationSummary__time-slot')) !== normal(`${date} ${time}`)
  )
    return false;
  const rows = await frame.locator('.SummaryPage__ScrollView .ReservationSummary__row-text').allTextContents();
  if (rows.map(normal).filter((row) => row === `${slot.reservation.partySize} Guests, ${slot.type}`).length !== 1)
    return false;
  let remaining = await oneText(frame, '.SummaryPage__ScrollView');
  if (remaining === undefined) return false;
  for (const policy of policies) remaining = remaining.replace(normal(policy), '');
  // A source-reviewed standard checkout cannot silently acquire another commitment in venue prose.
  return !/\$\s*\d|\b(?:deposit|pre[\s-]?pay(?:ment|ments|paid)?|minimum\s+(?:spend|purchase)|subscription|membership|recurring|trial|dollars?|charge[ds]?|non-refundable|cancellation\s+fee)\b/iu.test(
    remaining,
  );
}
async function matchingElement(element: ElementHandle, selector: string): Promise<boolean> {
  const frame = await element.ownerFrame();
  if (!frame || !(await element.isEnabled()) || !(await element.isVisible())) return false;
  const candidates = await frame.locator(selector).elementHandles();
  try {
    return await element.evaluate((node, matches) => {
      for (let index = 0; index < matches.length; index++) if (node === matches[index]) return true;
      return false;
    }, candidates);
  } finally {
    await Promise.all(candidates.map((candidate) => candidate.dispose()));
  }
}
async function commitFrame(page: Page, element: ElementHandle): Promise<Frame | undefined> {
  const frame = await element.ownerFrame();
  return frame &&
    frame.page() === page &&
    trusted(frame.url()) &&
    ['/reservation-details', '/credit-card-confirmed'].includes(route(frame.url()) ?? '') &&
    (await matchingElement(element, `button${COMMIT},button${CARD_COMMIT}`))
    ? frame
    : undefined;
}
async function readPurchase(
  page: Page,
  target?: ElementHandle,
): Promise<Awaited<ReturnType<MerchantSignature['readPurchase']>>> {
  const state = await settled(page);
  delete state.checkout;
  const candidates = target
    ? [target]
    : (
        await Promise.all(
          page
            .frames()
            .filter((frame) => trusted(frame.url()))
            .map((frame) => frame.locator(`${COMMIT},${CARD_COMMIT}`).elementHandles()),
        )
      ).flat();
  if (candidates.length !== 1) return { status: 'checkout_lapsed' };
  const element = candidates[0],
    frame = await commitFrame(page, element);
  if (!frame) return REVIEWED_CHECKOUT_MISSING;
  const details = state.captures.get('/3/details');
  if (!fresh(details) || details.frame !== frame || details.request.commit !== 1)
    return { status: 'terms_unavailable' };
  const selected = checkoutInventory(state, details);
  if (!selected) return { status: 'terms_unavailable' };
  const { inventory: inv, slot } = selected;
  registerPageRedaction(page, slot.token);
  const policy = policyFor(details, slot, inv.currency);
  const label = normal(await element.innerText());
  if (!policy || !['Reserve Now', 'Complete Reservation'].includes(label)) return { status: 'terms_unavailable' };
  const nativeUser = object(details.data.user),
    userCapture = state.captures.get('/2/user');
  const frameUser = fresh(userCapture) && userCapture.frame === frame ? userCapture : undefined;
  const accountId = id(nativeUser?.id) ?? (frameUser ? id(frameUser.data.id) : undefined);
  if (!accountId || (frameUser && id(frameUser.data.id) !== accountId)) return { status: 'terms_unavailable' };
  const bookToken = text(object(details.data.book_token)?.value);
  if (!bookToken) return { status: 'terms_unavailable' };
  const renderedPolicy = await frame
    .locator('.SummaryPage__cancellation li,.SelectCreditCardPage__cancellation li')
    .allTextContents();
  const expectedPolicy = object(object(details.data.cancellation)?.display)?.policy;
  if (
    !Array.isArray(expectedPolicy) ||
    JSON.stringify(renderedPolicy.map(normal)) !==
      JSON.stringify(expectedPolicy.map((item) => (typeof item === 'string' ? normal(item) : undefined)))
  )
    return { status: 'terms_unavailable' };
  const card = frame.locator('select[name="payment_method"]');
  let cardEnding: string | null = null,
    paymentId: string | undefined;
  if ((await card.count()) === 1) {
    paymentId = await card.inputValue();
    const methods = nativeUser?.payment_methods;
    const selectedCard = Array.isArray(methods)
      ? methods.map(object).filter((method) => id(method?.id) === paymentId)
      : [];
    if (selectedCard.length !== 1) return { status: 'terms_unavailable' };
    const display = text(selectedCard[0]?.display);
    cardEnding = display ? (/(?:^|\D)(\d{4})$/u.exec(display)?.[1] ?? null) : null;
    const renderedCard = normal(await card.locator('option:checked').innerText());
    if (!display || normal(`Credit card ending in ${display}`) !== renderedCard) return { status: 'terms_unavailable' };
  }
  if (policy.commitments.length && (!cardEnding || !paymentId)) return { status: 'terms_unavailable' };
  if (label === 'Reserve Now' && !(await summaryMatches(frame, slot, renderedPolicy)))
    return { status: 'terms_unavailable' };
  const commitments = policy.commitments.map(({ cancellationBeforeMs, ...term }) => ({
    ...term,
    ...(cancellationBeforeMs === undefined
      ? {}
      : { cancellationDeadline: new Date(Date.parse(slot.reservation.at) - cancellationBeforeMs).toISOString() }),
  }));
  const facts: PurchaseFacts = {
    flowId: FLOW,
    site: 'resy.com',
    origin: new URL(frame.url()).origin,
    control: { selector: label === 'Complete Reservation' ? CARD_COMMIT : COMMIT, label, formAction: `${API}/3/book` },
    account: `resy:${accountId}`,
    items: [
      { id: `resy:${inv.venueId}:${slot.type}`, title: `${inv.venueName} — ${slot.type}`, quantity: inv.partySize },
    ],
    currency: inv.currency,
    totalMinor: commitments.reduce(
      (sum, term) => sum + (term.amountMinor ?? 0) * (term.perPerson ? inv.partySize : 1),
      0,
    ),
    dueNowMinor: 0,
    cardEnding: commitments.length ? cardEnding : null,
    address: null,
    commitments,
    checkoutReference: hash(JSON.stringify([bookToken, slot.id, accountId, paymentId ?? null])),
    reservation: slot.reservation,
    ...(policy.noCommitmentTerms ? { noCommitmentTerms: policy.noCommitmentTerms } : {}),
  };
  state.checkout = {
    capture: details,
    facts,
    paymentId,
    bookToken,
    readSequence: state.sequence,
  };
  // No picture regions: this document holds the booking bearer the host tracks as a secret, so no picture of it
  // is ever taken, and its card says the picture is unavailable.
  return { status: 'ready', facts, element };
}
function parsedPayment(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return object(JSON.parse(value) as unknown);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}
function bookEvidence(state: PageState): MerchantPurchaseEvidence | undefined {
  const expected = state.checkout,
    book = state.captures.get('/3/book');
  if (
    !expected ||
    !book ||
    Date.now() - book.at < 0 ||
    Date.now() - book.at >= MAX_AGE ||
    book.sequence <= expected.readSequence ||
    book.frame !== expected.capture.frame ||
    book.generation !== expected.capture.generation ||
    book.request.book_token !== expected.bookToken ||
    book.request.replace !== undefined ||
    book.request.resy_token !== undefined ||
    Object.keys(book.request).some(
      (key) =>
        ![
          'book_token',
          'struct_payment_method',
          'venue_marketing_opt_in',
          'affiliate_id',
          'offer_id',
          'source_id',
          'struct_reference',
          'rwg_token',
          'merchant_changed',
        ].includes(key),
    ) ||
    (book.request.venue_marketing_opt_in !== undefined && book.request.venue_marketing_opt_in !== '0')
  )
    return undefined;
  const payment = parsedPayment(book.request.struct_payment_method);
  if (
    expected.paymentId
      ? id(payment?.id) !== expected.paymentId || Object.keys(payment ?? {}).some((key) => key !== 'id')
      : payment !== undefined
  )
    return undefined;
  const recordId = id(book.data.reservation_id);
  if (!recordId || !text(book.data.resy_token)) return undefined;
  return {
    flowId: FLOW,
    source: `${API}/3/book`,
    recordId,
    orderedAt: new Date(book.at).toISOString(),
    resolution: 'committed',
    account: expected.facts.account,
    items: expected.facts.items,
    totalMinor: expected.facts.totalMinor,
    currency: expected.facts.currency,
    cardEnding: expected.facts.cardEnding,
    address: null,
    checkoutReference: expected.facts.checkoutReference,
    reservation: expected.facts.reservation,
  };
}
export const resyReservationSignature: MerchantSignature = {
  id: FLOW,
  evidenceOrigins: [API, ...ORIGINS],
  matches(url) {
    return url.origin === API || ORIGINS.some((origin) => origin === url.origin);
  },
  preparePage,
  async verifyPurchaseControl(page, element) {
    return Boolean(await commitFrame(page, element));
  },
  async classifyControl(page, element, facts: ControlFacts): Promise<ActionClass | undefined> {
    if (await commitFrame(page, element)) return 'purchase_control';
    const frame = await element.ownerFrame();
    if (!frame || !trusted(frame.url())) return undefined;
    if (facts.tag === 'a' && facts.href) return this.classifyNavigation(new URL(facts.href));
    const state = await settled(page),
      find = state.captures.get('/4/find');
    if (fresh(find) && find.frame === frame) {
      const token = await element.getAttribute('data-testid');
      if (token?.startsWith('reservation-button-')) {
        const venues = object(find.data.results)?.venues;
        if (Array.isArray(venues))
          for (const entry of venues) {
            const slots = object(entry)?.slots;
            if (
              Array.isArray(slots) &&
              slots.some((slot) => `reservation-button-${object(object(slot)?.config)?.token}` === token) &&
              (await matchingElement(element, 'button'))
            ) {
              registerPageRedaction(page, token.slice('reservation-button-'.length));
              return 'ordinary';
            }
          }
      }
    }
    if (
      (await matchingElement(element, 'select[name="payment_method"]')) &&
      route(frame.url()) === '/reservation-details'
    )
      return 'ordinary';
    if (
      (await matchingElement(element, 'button[data-test-id="ReservationButtonList-button-view-more"]')) &&
      /^\/cities\/[^/]+\/venues\/[^/]+$/u.test(route(frame.url()) ?? '')
    )
      return 'ordinary';
    return undefined;
  },
  classifyNavigation(url) {
    if (url.origin === API) {
      if (url.pathname === '/3/book') return 'purchase_control';
      return (METHODS.has(url.pathname) && url.pathname !== '/3/book') || url.pathname === '/2/config'
        ? 'ordinary'
        : undefined;
    }
    if (!ORIGINS.some((origin) => origin === url.origin)) return undefined;
    const path = route(url.href) ?? '';
    if (/\/(?:cancel|change|payment-methods|profile|security|add-payment)(?:\/|$)/iu.test(path))
      return 'account_security';
    if (
      path === '/' ||
      /^\/cities(?:\/[^/]+(?:\/search|\/venues\/[^/]+)?)?\/?$/u.test(path) ||
      /^\/venues\/[1-9]\d*$/u.test(path) ||
      [
        '/reservation-details',
        '/confirmation',
        '/credit-card-confirmed',
        '/account/reservations-and-notify',
        '/login',
      ].includes(path) ||
      /^\/account\/reservations-and-notify\/[^/]+$/u.test(path)
    )
      return 'ordinary';
    return undefined;
  },
  readPurchase,
  async readAvailability(page, expected): Promise<ReservationAvailability> {
    const state = await settled(page),
      find = state.captures.get('/4/find');
    if (state.blockedAt && (!find || state.blockedAt >= find.at)) return { status: 'blocked' };
    const inv = inventory(find, expected.venueId, expected.partySize);
    return inv
      ? {
          status: 'ready',
          site: 'resy.com',
          venue: { id: inv.venueId, name: inv.venueName },
          partySize: inv.partySize,
          currency: inv.currency,
          timeZone: inv.timeZone,
          slots: inv.slots.map((slot) => ({ id: slot.id, reservation: slot.reservation })),
        }
      : { status: 'unavailable' };
  },
  async readReservationPolicy(page, venueId) {
    const state = await settled(page),
      details = state.captures.get('/3/details');
    if (!fresh(details)) return undefined;
    const selected = checkoutInventory(state, details);
    return selected?.inventory.venueId === venueId
      ? policyFor(details, selected.slot, selected.inventory.currency)
      : undefined;
  },
  async waitForResult(page, timeoutMs) {
    const state = states.get(page);
    if (!state || !state.checkout) throw new Error('Resy checkout was not read before the commit');
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        state.changed.delete(check);
      };
      const check = (): void => {
        if (bookEvidence(state)) {
          done();
          resolve();
        } else if (page.isClosed()) {
          done();
          reject(new Error('Resy closed before booking evidence'));
        }
      };
      const timer = setTimeout(
        () => {
          done();
          reject(new Error('Resy booking result is unavailable'));
        },
        Math.max(1, timeoutMs),
      );
      state.changed.add(check);
      check();
    });
  },
  async readEvidence(page) {
    return bookEvidence(await settled(page));
  },
};
