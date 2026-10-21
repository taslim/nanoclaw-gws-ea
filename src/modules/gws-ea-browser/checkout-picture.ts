/**
 * The picture a purchase card carries (KTD6): one PNG clipped to the checkout's total and its commit control, never
 * the whole page. The host takes none on a page that may show a secret, and a picture it cannot take only leaves
 * the card saying so: it never holds the card back. Its bytes live in memory for the card's one posting.
 */
import { log } from '../../log.js';
import type { RequestPicture } from '../approvals/index.js';
import type { CheckoutBox } from './control-facts.js';
import type { PurchaseFacts } from './fingerprint.js';
import { union } from './generic-signature.js';
import { readMerchantPurchase, type MerchantPurchaseRead } from './merchant-signatures.js';
import { pageMayShowSecret } from './observe.js';
import type { BrowserExecutionContext } from './actions.js';

const PICTURE_TIMEOUT_MS = 10_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's width and height, as its header states them. */
function pngSize(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('latin1', 12, 16) !== 'IHDR')
    return undefined;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/**
 * The card's picture of the checkout `facts` names on the job's page, read afresh: its total and commit control,
 * the control brought into view as a press would bring it. `null` when the checkout no longer reads with both,
 * when the page may show a secret, or when the capture fails or would be cut short at the viewport's edge.
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
    if (read.status !== 'ready' || !read.regions?.total) return null;
    const { control, total } = read.regions;
    await read.element.scrollIntoViewIfNeeded({ timeout: timeout() });
    // The total moves with its control: both sit in the checkout around it.
    const moved = await read.element.boundingBox();
    if (!moved) return null;
    const shift = (box: CheckoutBox): CheckoutBox => ({
      ...box,
      x: box.x + moved.x - control.x,
      y: box.y + moved.y - control.y,
    });
    const clip = union([moved, shift(total)], { wholePixels: true });
    // Immediately before the capture: nothing on the page may hold a secret, whoever put it there.
    if (await pageMayShowSecret(page)) return null;
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
    if (!size || size.width < clip.width || size.height < clip.height) return null;
    return { filename: 'checkout.png', mimeType: 'image/png', data };
    // eslint-disable-next-line no-catch-all/no-catch-all -- a picture that cannot be taken never holds back its card
  } catch (error) {
    log.warn('A purchase card goes out without its picture', { site: facts.site, err: error });
    return null;
  } finally {
    if (read && 'element' in read) await read.element.dispose().catch(() => undefined);
  }
}
