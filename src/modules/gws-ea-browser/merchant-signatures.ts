/** Reviewed host data for Amazon's standard US, one-time retail review flow.
 * Deliberately excludes one-click, Prime/trial enrolment, Subscribe & Save,
 * digital delivery, marketplace financing and every unreadable/drifted layout.
 */
import type { ElementHandle, Locator, Page } from 'playwright-core';
import type { ActionClass, ControlFacts, ReviewedMerchantFlow } from './commit-classifier.js';
import { completePurchaseFacts, moneyMinor, type PurchaseFacts } from './fingerprint.js';
import {
  REVIEWED_CHECKOUT_MISSING,
  type MerchantCheckoutRead,
  type MerchantPurchaseEvidence,
  type MerchantSignature,
} from './merchant-contract.js';
import { genericCheckoutSignature } from './generic-signature.js';
import { resyReservationSignature } from './resy-signature.js';
export type { MerchantPurchaseEvidence } from './merchant-contract.js';

export const AMAZON_RETAIL = Object.freeze({
  id: 'amazon-us-retail-v1',
  origin: 'https://www.amazon.com',
  reviewPath: '/gp/buy/spc/handlers/display.html',
  submitPath: '/gp/buy/spc/handlers/static-submit-decoupled.html',
  confirmationPath: '/gp/buy/thankyou/handlers/display.html',
  historyPath: '/gp/your-account/order-history',
  detailPaths: ['/gp/css/summary/print.html', '/gp/your-account/order-details'],
  addToCartControl: '#add-to-cart-button[name="submit.add-to-cart"][type="submit"]',
  checkoutEntryControl: 'input[name="proceedToRetailCheckout"][type="submit"]',
  productQuantity: 'select#quantity[name="quantity"]',
  form: '#spc-form',
  control: '#placeYourOrder input[name="placeYourOrder1"]',
  total: '#subtotals-marketplace-table tr',
  payment: '#payment-information',
  address: '#displayAddressDiv',
  account: '#nav-link-accountList .nav-line-1',
  items: '#spc-form .shipment .item-row',
  itemId: '[data-asin]',
  itemTitle: '.a-link-normal[href*="/dp/"]',
  quantity: '.quantity',
  delivery: '.delivery-promise',
  terms: '#purchase-legal-text',
  orderNumber: '#orderDetails .order-number',
  orderedAt: '#orderDetails .order-date',
  recordItems: '#orderDetails .shipment .item-row',
  recordTotal: '#orderDetails .grand-total',
  recordPayment: '#orderDetails .payment-method',
  recordAddress: '#orderDetails .shipping-address',
  recordStatus: '#orderDetails .order-status',
});

function sameOrigin(url: URL): boolean {
  return url.origin === AMAZON_RETAIL.origin;
}
function review(url: URL): boolean {
  return sameOrigin(url) && url.pathname === AMAZON_RETAIL.reviewPath;
}
function normal(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
async function oneText(locator: Locator): Promise<string | undefined> {
  if ((await locator.count()) !== 1 || !(await locator.isVisible())) return undefined;
  return normal(await locator.innerText({ timeout: 2_000 }));
}
async function optionalAttribute(page: Page, selector: string, name: string): Promise<string | null> {
  const locator = page.locator(selector);
  return (await locator.count()) === 1 ? locator.getAttribute(name, { timeout: 2_000 }) : null;
}
function deliveryDate(text: string): string | undefined {
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/u.exec(text)?.[1];
  if (iso && Number.isFinite(Date.parse(iso))) return iso;
  const date =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/u.exec(
      text,
    );
  if (!date) return undefined;
  const parsed = Date.parse(`${date[1]} ${date[2]}, ${date[3]} 12:00:00 GMT`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : undefined;
}
async function itemFacts(page: Page, selector: string): Promise<PurchaseFacts['items'] | undefined> {
  const rows = page.locator(selector);
  const items: PurchaseFacts['items'] = [];
  const count = await rows.count();
  if (!count || count > 100) return undefined;
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const idNode = row.locator(AMAZON_RETAIL.itemId);
    const id =
      (await row.getAttribute('data-asin')) ??
      ((await idNode.count()) === 1 ? await idNode.getAttribute('data-asin') : null);
    const title = await oneText(row.locator(AMAZON_RETAIL.itemTitle));
    const quantityText = await oneText(row.locator(AMAZON_RETAIL.quantity));
    const quantity = quantityText ? /^(?:Qty:?[ \t]*)?(\d+)$/iu.exec(quantityText)?.[1] : undefined;
    if (!id || !/^[A-Z0-9]{10}$/u.test(id) || !title || !quantity || Number(quantity) < 1) return undefined;
    items.push({ id, title, quantity: Number(quantity) });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export async function isAmazonRetailCommit(page: Page, element: ElementHandle): Promise<boolean> {
  const frame = await element.ownerFrame();
  if (!frame || frame !== page.mainFrame() || !review(new URL(frame.url()))) return false;
  return element.evaluate(
    (node, signature) => {
      const e = node as unknown as {
        isConnected: boolean;
        disabled: boolean;
        matches(selector: string): boolean;
        form?: { id: string; method: string; action: string };
      };
      return (
        e.isConnected &&
        !e.disabled &&
        e.matches(signature.control) &&
        e.form?.id === 'spc-form' &&
        e.form.method.toLowerCase() === 'post' &&
        e.form.action === signature.action
      );
    },
    { control: AMAZON_RETAIL.control, action: `${AMAZON_RETAIL.origin}${AMAZON_RETAIL.submitPath}` },
  );
}

function productAsin(url: URL): string | undefined {
  return sameOrigin(url)
    ? /^(?:\/[^/]+)?\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/u.exec(url.pathname)?.[1]
    : undefined;
}
function preparationEndpoint(url: URL): boolean {
  return (
    sameOrigin(url) &&
    /^\/gp\/(?:product\/handle-buy-box|cart\/desktop\/go-to-checkout\.html)(?:\/ref=[A-Za-z0-9_-]+)?\/?$/u.test(
      url.pathname,
    ) &&
    [...url.searchParams.keys()].every((name) => ['ie', 'ref', 'ref_'].includes(name))
  );
}
function cartRead(url: URL): boolean {
  return (
    sameOrigin(url) &&
    ['/gp/cart/view.html', '/cart', '/cart/smart-wagon'].includes(url.pathname) &&
    [...url.searchParams.keys()].every((name) => ['ie', 'ref', 'ref_', 'newItems'].includes(name))
  );
}
/** Exact native noncommitting form shape, never a button label or hostname alone. */
async function amazonPreparationControl(page: Page, element: ElementHandle): Promise<boolean> {
  const frame = await element.ownerFrame();
  if (!frame || frame !== page.mainFrame()) return false;
  const url = new URL(frame.url());
  const asin = productAsin(url);
  if (!asin && !cartRead(url)) return false;
  return element.evaluate(
    (node, signature) => {
      const e = node as unknown as {
        isConnected: boolean;
        disabled: boolean;
        name: string;
        value: string;
        matches(selector: string): boolean;
        form?: {
          id: string;
          method: string;
          action: string;
          target: string;
          elements: ArrayLike<{ name: string; value: string; type: string; options?: ArrayLike<{ value: string }> }>;
        };
      };
      const form = e.form;
      if (
        !e.isConnected ||
        e.disabled ||
        !form ||
        form.method.toLowerCase() !== 'post' ||
        !['', '_self'].includes(form.target)
      )
        return false;
      const action = new URL(form.action);
      if (
        action.origin !== signature.origin ||
        [...action.searchParams.keys()].some((name) => !['ie', 'ref', 'ref_'].includes(name))
      )
        return false;
      const fields = Array.from(form.elements);
      if (
        fields.some(
          (field) =>
            field.type === 'hidden' &&
            /(?:one.?click|buy.?now|isSNS|subscribe|subscription|place.*order)/iu.test(field.name) &&
            !['', '0', 'false'].includes(field.value),
        )
      )
        return false;
      if (signature.asin) {
        if (
          form.id !== 'addToCart' ||
          !/^\/gp\/product\/handle-buy-box(?:\/ref=[A-Za-z0-9_-]+)?\/?$/u.test(action.pathname)
        )
          return false;
        const asins = fields.filter((field) => field.name === 'ASIN');
        if (asins.length !== 1 || asins[0].value !== signature.asin) return false;
        const quantity = fields.find((field) => field.name === 'quantity');
        if (
          quantity &&
          (!/^\d+$/u.test(quantity.value) ||
            !Number.isSafeInteger(Number(quantity.value)) ||
            Number(quantity.value) < 1)
        )
          return false;
        if (e.matches(signature.addControl)) return e.value === 'Add to Cart';
        if (e.matches(signature.quantityControl))
          return Array.from(quantity?.options ?? []).every(
            (option) =>
              /^\d+$/u.test(option.value) && Number.isSafeInteger(Number(option.value)) && Number(option.value) > 0,
          );
        return false;
      }
      return (
        form.id === 'activeCartViewForm' &&
        /^\/gp\/cart\/desktop\/go-to-checkout\.html(?:\/ref=[A-Za-z0-9_-]+)?\/?$/u.test(action.pathname) &&
        e.matches(signature.checkoutControl) &&
        e.value === 'Proceed to checkout'
      );
    },
    {
      asin,
      origin: AMAZON_RETAIL.origin,
      addControl: AMAZON_RETAIL.addToCartControl,
      quantityControl: AMAZON_RETAIL.productQuantity,
      checkoutControl: AMAZON_RETAIL.checkoutEntryControl,
    },
  );
}

export const amazonRetailFlow: ReviewedMerchantFlow = {
  id: AMAZON_RETAIL.id,
  matches: sameOrigin,
  async classifyControl(page, element, facts: ControlFacts): Promise<ActionClass | undefined> {
    if (await isAmazonRetailCommit(page, element)) return 'purchase_control';
    if (await amazonPreparationControl(page, element)) return 'ordinary';
    // Reviewed preparation is native form/endpoint bound; every other control is left to the open rule.
    if (facts.tag === 'a' && facts.href) {
      const url = new URL(facts.href);
      return this.classifyNavigation(url);
    }
    if (
      facts.formMethod?.toLowerCase() === 'get' &&
      facts.formAction &&
      sameOrigin(new URL(facts.formAction)) &&
      new URL(facts.formAction).pathname === '/s' &&
      /^(?:search|search amazon)$/iu.test(facts.name.trim())
    )
      return 'ordinary';
    return undefined;
  },
  verifyPurchaseControl: isAmazonRetailCommit,
  classifyNavigation(url) {
    if (!sameOrigin(url)) return undefined;
    if (url.pathname === AMAZON_RETAIL.submitPath) return 'purchase_control';
    if (
      review(url) &&
      [...url.searchParams.keys()].some((name) => !['purchaseId', 'ie', 'pipelineType', 'from', 'ref_'].includes(name))
    )
      return undefined;
    if (
      review(url) ||
      url.pathname === AMAZON_RETAIL.confirmationPath ||
      url.pathname === AMAZON_RETAIL.historyPath ||
      AMAZON_RETAIL.detailPaths.includes(url.pathname) ||
      Boolean(productAsin(url)) ||
      cartRead(url) ||
      preparationEndpoint(url) ||
      url.pathname === '/s' ||
      url.pathname === '/'
    )
      return 'ordinary';
    return undefined;
  },
};

export type MerchantPurchaseRead =
  | (Extract<MerchantCheckoutRead, { status: 'ready' }> & { signature: MerchantSignature })
  | Exclude<MerchantCheckoutRead, { status: 'ready' }>;

/** Every value comes from visible host-selected DOM, and the activating element must match the signature. */
async function readAmazonPurchase(page: Page, target?: ElementHandle): Promise<MerchantCheckoutRead> {
  const url = new URL(page.url());
  if (!sameOrigin(url)) return REVIEWED_CHECKOUT_MISSING;
  if (!review(url)) return { status: 'checkout_lapsed' };
  if (
    (await page.locator(AMAZON_RETAIL.form).count()) !== 1 ||
    (await page.locator(AMAZON_RETAIL.control).count()) !== 1
  )
    return REVIEWED_CHECKOUT_MISSING;
  const element = target ?? (await page.locator(AMAZON_RETAIL.control).elementHandle());
  if (!element || !(await isAmazonRetailCommit(page, element))) {
    if (!target) await element?.dispose();
    return REVIEWED_CHECKOUT_MISSING;
  }
  const refuse = async (status: 'terms_unavailable'): Promise<MerchantCheckoutRead> => {
    if (!target) await element.dispose();
    return { status };
  };
  const label = normal((await element.getAttribute('aria-label')) ?? (await element.getAttribute('value')) ?? '');
  if (label !== 'Place your order') return refuse('terms_unavailable');
  const body = await page.locator('body').innerText({ timeout: 2_000 });
  if (
    /\b(?:subscribe\s*(?:&|and)\s*save|free trial|membership|recurring|installments?|deposit|no.show|cancellation fee|authorization hold|prepayment|pay later|monthly payment)\b/iu.test(
      body,
    )
  )
    return refuse('terms_unavailable');
  const totals = (await page.locator(AMAZON_RETAIL.total).allTextContents()).map(normal);
  const totalRows = totals.filter((text) => /^Order total:/u.test(text));
  const totalMinor = totalRows.length === 1 ? moneyMinor(totalRows[0].replace(/^Order total:\s*/u, '')) : undefined;
  const payment = await oneText(page.locator(AMAZON_RETAIL.payment));
  const cards = payment ? [...payment.matchAll(/(?:ending in|ending|\*{4})\s*(\d{4})\b/giu)] : [];
  const address = await oneText(page.locator(AMAZON_RETAIL.address));
  const account = await oneText(page.locator(AMAZON_RETAIL.account));
  const items = await itemFacts(page, AMAZON_RETAIL.items);
  const terms = await oneText(page.locator(AMAZON_RETAIL.terms));
  const promises = (await page.locator(`${AMAZON_RETAIL.form} ${AMAZON_RETAIL.delivery}`).allTextContents()).map(
    normal,
  );
  const dates = promises.map(deliveryDate);
  const date = dates.every((value) => value !== undefined) ? dates.sort().at(-1) : undefined;
  if (
    totalMinor === undefined ||
    cards.length !== 1 ||
    !address ||
    !account ||
    /sign in/iu.test(account) ||
    !items ||
    !terms ||
    !/By placing your order/u.test(terms) ||
    !date
  )
    return refuse('terms_unavailable');
  const reference = await optionalAttribute(page, `${AMAZON_RETAIL.form} input[name="purchaseId"]`, 'value');
  const facts: PurchaseFacts = {
    flowId: AMAZON_RETAIL.id,
    site: 'amazon.com',
    origin: url.origin,
    control: { selector: AMAZON_RETAIL.control, label, formAction: `${url.origin}${AMAZON_RETAIL.submitPath}` },
    account,
    items,
    currency: 'USD',
    totalMinor,
    dueNowMinor: totalMinor,
    cardEnding: cards[0][1],
    address,
    delivery: { date, text: promises.join('; ') },
    commitments: [{ kind: 'retail', terms }],
    ...(reference ? { checkoutReference: reference } : {}),
  };
  if (!completePurchaseFacts(facts)) return refuse('terms_unavailable');
  // The card's picture shows the order total's row and the commit control, on the main frame's viewport. A row
  // gone meanwhile leaves the picture without it, never the read without its facts.
  const [total, control] = await Promise.all([
    page
      .locator(AMAZON_RETAIL.total)
      .nth(totals.findIndex((text) => /^Order total:/u.test(text)))
      .boundingBox({ timeout: 2_000 })
      .catch(() => null),
    element.boundingBox(),
  ]);
  return { status: 'ready', facts, element, ...(control ? { regions: { control, ...(total ? { total } : {}) } } : {}) };
}

/** Empty/stale history is never proof of absence. Only a complete merchant order-detail record is evidence. */
async function readAmazonEvidence(page: Page): Promise<MerchantPurchaseEvidence | undefined> {
  const url = new URL(page.url());
  if (!sameOrigin(url) || !AMAZON_RETAIL.detailPaths.includes(url.pathname)) return undefined;
  const record = await oneText(page.locator(AMAZON_RETAIL.orderNumber));
  const recordId = record ? /\b\d{3}-\d{7}-\d{7}\b/u.exec(record)?.[0] : undefined;
  const when = await optionalAttribute(page, AMAZON_RETAIL.orderedAt, 'datetime');
  const total = await oneText(page.locator(AMAZON_RETAIL.recordTotal));
  const totalMinor = total ? moneyMinor(total.replace(/^Grand total:\s*/iu, '')) : undefined;
  const account = await oneText(page.locator(AMAZON_RETAIL.account));
  const payment = await oneText(page.locator(AMAZON_RETAIL.recordPayment));
  const cardEnding = payment ? /ending(?: in)?\s*(\d{4})\b/iu.exec(payment)?.[1] : undefined;
  const address = await oneText(page.locator(AMAZON_RETAIL.recordAddress));
  const items = await itemFacts(page, AMAZON_RETAIL.recordItems);
  const status = await oneText(page.locator(AMAZON_RETAIL.recordStatus));
  if (
    !recordId ||
    !when ||
    !Number.isFinite(Date.parse(when)) ||
    totalMinor === undefined ||
    !account ||
    !cardEnding ||
    !address ||
    !items ||
    !status
  )
    return undefined;
  // A cancelled/refunded existing order still committed. This signature has no authoritative negative-history evidence; absence remains inconclusive.
  const resolution = /^(?:Order placed|Not yet shipped|Shipped|Delivered|Cancelled|Refunded)$/iu.test(status)
    ? 'committed'
    : undefined;
  if (!resolution) return undefined;
  const checkoutReference = await optionalAttribute(page, '#orderDetails input[name="purchaseId"]', 'value');
  return {
    flowId: AMAZON_RETAIL.id,
    source: url.href,
    recordId,
    orderedAt: new Date(when).toISOString(),
    resolution,
    account,
    items,
    totalMinor,
    currency: 'USD',
    cardEnding,
    address,
    ...(checkoutReference ? { checkoutReference } : {}),
  };
}

export const amazonRetailSignature: MerchantSignature = {
  ...amazonRetailFlow,
  evidenceOrigins: [AMAZON_RETAIL.origin],
  readPurchase: readAmazonPurchase,
  async waitForResult(page, timeoutMs) {
    await page
      .waitForURL(
        (url) =>
          url.origin === AMAZON_RETAIL.origin &&
          (url.pathname === AMAZON_RETAIL.confirmationPath || AMAZON_RETAIL.detailPaths.includes(url.pathname)),
        { waitUntil: 'domcontentloaded', timeout: timeoutMs },
      )
      .catch(() => undefined);
    const url = new URL(page.url());
    if (url.origin !== AMAZON_RETAIL.origin || url.pathname !== AMAZON_RETAIL.confirmationPath) return;
    const links = page.locator('a[href*="/gp/your-account/order-details"]');
    if ((await links.count()) !== 1) return;
    const href = await links.getAttribute('href');
    if (!href) return;
    const detail = new URL(href, url);
    if (detail.origin === AMAZON_RETAIL.origin && AMAZON_RETAIL.detailPaths.includes(detail.pathname))
      await page.goto(detail.href, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 5000) });
  },
  readEvidence: readAmazonEvidence,
};
/**
 * This closed list is host-reviewed code, never model or recipe registration. The generic signature is never
 * one of them: a flow that matched every page would press any control directly (KTD4).
 */
export const merchantSignatures: readonly MerchantSignature[] = [amazonRetailSignature, resyReservationSignature];
/** The page's reviewed signature, which keeps precedence on its site, else the generic one for any web page. */
export function merchantSignatureFor(page: Page): MerchantSignature | undefined {
  try {
    const url = new URL(page.url());
    return (
      merchantSignatures.find((signature) => signature.matches(url)) ??
      (genericCheckoutSignature.matches(url) ? genericCheckoutSignature : undefined)
    );
  } catch {
    return undefined;
  }
}
export async function prepareMerchantPage(page: Page): Promise<void> {
  for (const signature of [...merchantSignatures, genericCheckoutSignature]) await signature.preparePage?.(page);
}
/**
 * Reads the page's checkout with its signature. A reviewed flow that no longer matches its page fails closed
 * for that flow; it never falls back to the generic one.
 */
export async function readMerchantPurchase(
  page: Page,
  target?: ElementHandle,
  expected?: PurchaseFacts,
): Promise<MerchantPurchaseRead> {
  const signature = merchantSignatureFor(page);
  if (!signature) return { status: 'checkout_lapsed' };
  const read = await signature.readPurchase(page, target, expected);
  return read.status === 'ready' ? { ...read, signature } : read;
}
export async function readMerchantPurchaseEvidence(page: Page): Promise<MerchantPurchaseEvidence | undefined> {
  return merchantSignatureFor(page)?.readEvidence(page);
}
