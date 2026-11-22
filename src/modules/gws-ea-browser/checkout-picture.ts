/**
 * The picture a purchase card carries: one PNG clipped to the checkout's total and its commit control, never the
 * whole page. The host takes none on a page that may show a secret, and a picture it cannot take only leaves the
 * card saying so: it never holds the card back. Its bytes live in memory for the card's one posting.
 */
import { log } from '../../log.js';
import type { RequestPicture } from '../approvals/index.js';
import type { CheckoutBox } from './control-facts.js';
import { materialPurchaseChange, type PurchaseFacts } from './fingerprint.js';
import { union } from './generic-signature.js';
import { readMerchantPurchase, type MerchantPurchaseRead } from './merchant-read.js';
import { pageMayShowSecret } from './page-privacy.js';
import type { BrowserExecutionContext } from './actions.js';

const PICTURE_TIMEOUT_MS = 10_000;
const MAX_FULL_PAGE_PICTURE_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('latin1', 12, 16) !== 'IHDR')
    return undefined;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Verifies the live checkout still matches the card's recorded facts (ignoring consent-attached fields). */
function reviewFactsMatch(recorded: PurchaseFacts, live: PurchaseFacts): boolean {
  const { agreements: _agreements, addOns: _addOns, ...comparable } = recorded;
  return (
    comparable.control.label === live.control.label &&
    comparable.totalMinor === live.totalMinor &&
    comparable.dueNowMinor === live.dueNowMinor &&
    materialPurchaseChange(comparable, live, {}) === undefined
  );
}

/**
 * The card's picture of the checkout `facts` names on the job's page, read afresh: clipped tightly to its total
 * and commit control when both read and fit in the viewport, or a full-page capture for generic checkouts whose
 * total and commit control span past one viewport or whose card relies on screenshot-backed principal review.
 * For screenshot-reviewed checkouts, the live DOM is verified against `facts` both before and after capture and
 * fails closed (`null`) rather than falling back to a cropped viewport picture.
 */
export async function checkoutPicture(
  context: BrowserExecutionContext,
  facts: PurchaseFacts,
): Promise<RequestPicture | null> {
  // Never Playwright's zero, which waits without end.
  const timeout = (): number => Math.max(1, Math.min(PICTURE_TIMEOUT_MS, context.remaining()));
  let read: MerchantPurchaseRead | undefined;
  try {
    const page = await context.page();
    read = await readMerchantPurchase(page, undefined, facts);
    if (read.status !== 'ready') return null;
    const review = Boolean(facts.generic?.review);
    if (!review && !facts.generic && !read.regions?.total) return null;
    if (review && !reviewFactsMatch(facts, read.facts)) return null;
    await read.element.scrollIntoViewIfNeeded({ timeout: timeout() });
    // Immediately before the capture: nothing on the page may hold a secret, whoever put it there.
    if (await pageMayShowSecret(page)) return null;
    if (!review && read.regions?.total) {
      const { control, total } = read.regions;
      // The total moves with its control: both sit in the checkout around it.
      const moved = await read.element.boundingBox();
      if (!moved) return null;
      const shift = (box: CheckoutBox): CheckoutBox => ({
        ...box,
        x: box.x + moved.x - control.x,
        y: box.y + moved.y - control.y,
      });
      const clip = union([moved, shift(total)], { wholePixels: true });
      const viewport = page.viewportSize();
      const fitsViewport =
        clip.x >= 0 &&
        clip.y >= 0 &&
        (!viewport || (clip.x + clip.width <= viewport.width && clip.y + clip.height <= viewport.height));
      if (fitsViewport) {
        const data = await page.screenshot({
          type: 'png',
          clip,
          scale: 'css',
          // The capture leaves the merchant's page exactly as it was: no caret style is put on it.
          caret: 'initial',
          timeout: timeout(),
        });
        const size = pngSize(data);
        // A clip past the viewport's edge comes back cut short, without all of what it shows.
        if (size && size.width >= clip.width && size.height >= clip.height)
          return { filename: 'checkout.png', mimeType: 'image/png', data };
        if (!facts.generic) return null;
      } else if (!facts.generic) return null;
    }
    if (!facts.generic) return null;
    const full = await page.screenshot({
      type: 'png',
      fullPage: true,
      scale: 'css',
      caret: 'initial',
      timeout: timeout(),
    });
    if (full.length <= MAX_FULL_PAGE_PICTURE_BYTES && pngSize(full)) {
      if (review) {
        if (await pageMayShowSecret(page)) return null;
        const after = await readMerchantPurchase(page, read.element, facts);
        if ('element' in after && after.element !== read.element) await after.element.dispose().catch(() => undefined);
        if (after.status !== 'ready' || !reviewFactsMatch(facts, after.facts)) return null;
      }
      return { filename: 'checkout.png', mimeType: 'image/png', data: full };
    }
    // A screenshot-reviewed checkout relies on the full page to show unread terms; fail closed instead of cropping.
    if (review) return null;
    const viewportShot = await page.screenshot({
      type: 'png',
      scale: 'css',
      caret: 'initial',
      timeout: timeout(),
    });
    return pngSize(viewportShot) ? { filename: 'checkout.png', mimeType: 'image/png', data: viewportShot } : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a picture that cannot be taken never holds back its card
  } catch (error) {
    log.warn('A purchase card goes out without its picture', { site: facts.site, err: error });
    return null;
  } finally {
    if (read && 'element' in read) await read.element.dispose().catch(() => undefined);
  }
}
