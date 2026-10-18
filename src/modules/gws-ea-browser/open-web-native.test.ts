/** The open rule against native Chrome: unreviewed sites, cross-site frames, dialogs and hostile page script. */
import Database from 'better-sqlite3';
import type { Locator, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SqliteDriver } from '../../db/drivers/sqlite.js';
import {
  classifyActivation,
  classifyNavigationUrl,
  readControlFacts,
  type ActivationIntent,
} from './commit-classifier.js';
import { BrowserStore } from './db.js';
import { executeBrowserBatch } from './executor.js';
import { browserSiteLeasesMigration } from './migration.js';
import { OPEN_WEB, openWebFixture, type OpenWebFixture } from './open-web-native-fixture.js';
import { observePage } from './observe.js';
import type { BrowserExecutionContext } from './queue.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;

describe.skipIf(!chromePath)('open-web classification in native Chrome', { timeout: 30_000 }, () => {
  let fixture: OpenWebFixture;
  let page: Page;

  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    page = await fixture.newPage();
  });
  afterEach(async () => {
    await page?.context().close();
  });

  async function visit(url: string): Promise<void> {
    await page.goto(url, { waitUntil: 'load' });
  }
  async function classify(target: Locator, kind?: ActivationIntent['kind']): Promise<string> {
    const element = await target.elementHandle();
    if (!element) throw new Error('Fixture control missing');
    try {
      return await classifyActivation(page, element, kind);
    } finally {
      await element.dispose();
    }
  }
  async function facts(target: Locator) {
    const element = await target.elementHandle();
    if (!element) throw new Error('Fixture control missing');
    try {
      return await readControlFacts(page, element);
    } finally {
      await element.dispose();
    }
  }

  it('reads a dated article, an about page and a booking step as ordinary', async () => {
    for (const url of [OPEN_WEB.article, OPEN_WEB.about, OPEN_WEB.restaurant])
      expect(classifyNavigationUrl(url)).toBe('ordinary');
    await visit(OPEN_WEB.article);
    expect(await classify(page.locator('#about'))).toBe('ordinary');
    expect(await classify(page.locator('#more'))).toBe('ordinary');
    expect(await classify(page.locator('#share'))).toBe('ordinary');
    await visit(OPEN_WEB.restaurant);
    const widget = page.frameLocator('#booking');
    expect(await classify(widget.locator('#slot-1900'))).toBe('ordinary');
    expect(await classify(widget.locator('#party'), 'select')).toBe('ordinary');
  });

  it('keeps preparation on a transaction page ordinary and refuses its commits', async () => {
    await visit(OPEN_WEB.payment);
    expect(await facts(page.locator('#continue'))).toMatchObject({ transaction: true, region: { transaction: true } });
    // AE1: a coupon and a quantity change on a checkout with a total and a saved card run as ordinary clicks.
    await page.locator('#coupon').fill('AUTUMN10');
    for (const id of ['#apply', '#decrease', '#increase', '#remove', '#summary', '#edit', '#back'])
      expect(await classify(page.locator(id))).toBe('ordinary');
    expect(await classify(page.locator('#coupon'))).toBe('ordinary');
    expect(await classify(page.locator('#place'))).toBe('purchase_control');
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
    // A delivery note rides with the order: the commit stays a purchase, never speaking.
    await page.locator('#note').fill('Leave it with the porter');
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
    expect(await classify(page.locator('#note'), 'submit')).toBe('purchase_control');
  });

  it('leaves Continue ordinary where there is no payment, or the total and card sit in different forms', async () => {
    await visit(OPEN_WEB.shipping);
    expect(await facts(page.locator('#continue'))).toMatchObject({ transaction: false });
    expect(await classify(page.locator('#continue'))).toBe('ordinary');
    expect(await classify(page.locator('input[value="express"]'))).toBe('ordinary');
    await visit(OPEN_WEB.split);
    expect(await facts(page.locator('#wallet-continue'))).toMatchObject({ transaction: false });
    expect(await classify(page.locator('#totals-continue'))).toBe('ordinary');
    expect(await classify(page.locator('#wallet-continue'))).toBe('ordinary');
    await visit(OPEN_WEB.cart);
    expect(await classify(page.locator('#proceed'))).toBe('ordinary');
    expect(await classify(page.locator('button[name="apply"]'))).toBe('ordinary');
  });

  it('treats Confirm in a modal on a transaction page, and a nested confirmation, as purchases', async () => {
    await visit(OPEN_WEB.confirm);
    await page.locator('#review').click();
    await expect
      .poll(() => page.locator('#confirm').evaluate((dialog) => (dialog as unknown as { open: boolean }).open))
      .toBe(true);
    expect(await facts(page.locator('#confirm-yes'))).toMatchObject({
      transaction: true,
      region: { dialog: true, modalOrder: true },
    });
    expect(await classify(page.locator('#confirm-yes'))).toBe('purchase_control');
    expect(await classify(page.locator('#confirm-no'))).toBe('ordinary');
    await page.locator('#details').click();
    expect(await classify(page.locator('#nested-yes'))).toBe('purchase_control');
  });

  it('classifies in an isolated world, whatever the page rewrites in its own', async () => {
    await visit(OPEN_WEB.rewritten);
    // The page's own world now reports every control as a search outside any form.
    expect(await page.locator('#place').evaluate((node) => node.textContent)).toBe('Search');
    expect(await facts(page.locator('#place'))).toMatchObject({
      name: 'Place order',
      formAction: 'https://shop.example/checkout/complete',
      transaction: true,
      region: { transaction: true },
    });
    expect(await classify(page.locator('#place'))).toBe('purchase_control');
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
  });

  it('follows a payment platform redirect and refuses the platform’s own commits', async () => {
    expect(classifyNavigationUrl(OPEN_WEB.redirect)).toBe('ordinary');
    expect(classifyNavigationUrl(OPEN_WEB.platform)).toBe('ordinary');
    await visit(OPEN_WEB.redirect);
    expect(page.url()).toBe(OPEN_WEB.platform);
    expect(await classify(page.locator('#pay'))).toBe('purchase_control');
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
    expect(await classify(page.locator('#back'))).toBe('ordinary');
  });

  it('counts a visible hosted card frame as the payment method, and refuses Pay inside a payment frame', async () => {
    await visit(OPEN_WEB.hostedCard);
    await page.frameLocator('#card-frame').locator('input[name="cardnumber"]').waitFor();
    expect(await facts(page.locator('#continue'))).toMatchObject({ transaction: true, region: { transaction: true } });
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
    expect(await classify(page.locator('#apply'))).toBe('ordinary');
    await visit(OPEN_WEB.embeddedPay);
    const frame = page.frameLocator('#pay-frame');
    expect(await classify(frame.locator('#pay'))).toBe('purchase_control');
    // A card frame no processor list names is known by the card fields it holds.
    await visit(OPEN_WEB.ownCardFrame);
    await page.frameLocator('#card-frame').locator('input[name="cardnumber"]').waitFor();
    expect(await classify(page.locator('#continue'))).toBe('purchase_control');
  });

  it('counts no hidden processor frame or Pay Later message as a payment method beside a total', async () => {
    await visit(OPEN_WEB.pending);
    await page.frameLocator('#pay-later').locator('text=Pay in 4').waitFor();
    expect(page.frames().filter((frame) => frame.url().includes('elements-inner-card'))).toHaveLength(1);
    expect(await facts(page.locator('#continue'))).toMatchObject({
      transaction: false,
      region: { transaction: false },
    });
    expect(await classify(page.locator('#continue'))).toBe('ordinary');
  });

  it('keeps Add to cart, a size and Continue ordinary beside hidden processor frames, Pay Later and express pay', async () => {
    await visit(OPEN_WEB.product);
    await page.frameLocator('#pay-later').locator('text=Pay in 4').waitFor();
    expect(page.frames().map((frame) => new URL(frame.url()).host)).toEqual(
      expect.arrayContaining(['js.stripe.com', 'www.paypal.com']),
    );
    expect(await facts(page.locator('#continue'))).toMatchObject({ transaction: false });
    expect(await classify(page.locator('#add-to-cart'))).toBe('ordinary');
    expect(await classify(page.locator('#size'), 'select')).toBe('ordinary');
    expect(await classify(page.locator('#continue'))).toBe('ordinary');
  });

  it('lets a booking note ride along, and refuses a reservation that a card guarantees for a fee', async () => {
    await visit(OPEN_WEB.restaurant);
    const free = page.frameLocator('#booking');
    await free.locator('#requests').fill('One guest is allergic to peanuts');
    expect(await classify(free.locator('#reserve'))).toBe('ordinary');
    expect(await classify(free.locator('#slot-1830'))).toBe('ordinary');
    await visit(OPEN_WEB.feeRestaurant);
    expect(await classify(page.frameLocator('#booking').locator('#reserve'))).toBe('purchase_control');
  });

  it('treats cancelling or changing a booking whose page shows a fee as a purchase', async () => {
    await visit(OPEN_WEB.reservation);
    expect(await classify(page.locator('#cancel'))).toBe('purchase_control');
    expect(await classify(page.locator('#modify'))).toBe('purchase_control');
    expect(await classify(page.locator('#venue'))).toBe('ordinary');
  });

  it('refuses speaking: contact forms, a review, a comment box, a formless chat and a chat widget frame', async () => {
    for (const url of [OPEN_WEB.contact, OPEN_WEB.support]) {
      await visit(url);
      await page.locator('input[name="name"]').fill('Morgan Ellery');
      await page.locator('input[name="email"]').fill('morgan.ellery@example.test');
      expect(await classify(page.locator('#send'))).toBe('ordinary');
      await page.locator('#message').fill('Do you ship to Canada?');
      expect(await classify(page.locator('#send'))).toBe('speaks_as_principal');
    }
    await visit(OPEN_WEB.review);
    await page.locator('#review-text').fill('Lovely apron, sturdy pockets.');
    expect(await classify(page.locator('#post'))).toBe('speaks_as_principal');
    await visit(OPEN_WEB.article);
    await page.locator('#comment-box').fill('Cannot wait to try the new menu.');
    expect(await classify(page.locator('#comment-box'))).toBe('ordinary');
    expect(await classify(page.locator('#comment-box'), 'submit')).toBe('speaks_as_principal');
    await visit(OPEN_WEB.help);
    await page.locator('#help-search').fill('returns');
    await page.locator('#chat-input').fill('Where is my order?');
    expect(await classify(page.locator('#help-search'), 'submit')).toBe('ordinary');
    expect(await classify(page.locator('#help-search-go'))).toBe('ordinary');
    expect(await classify(page.locator('#chat-input'), 'submit')).toBe('speaks_as_principal');
    expect(await classify(page.locator('#chat-send'))).toBe('speaks_as_principal');
    const chat = page.frameLocator('#chat-frame');
    await chat.locator('#chat-message').fill('Hello');
    expect(await facts(chat.locator('#chat-message'))).toMatchObject({ chatFrame: true });
    expect(await classify(chat.locator('#chat-message'), 'submit')).toBe('speaks_as_principal');
    expect(await classify(chat.locator('#chat-submit'))).toBe('speaks_as_principal');
  });

  it('refuses saving contact or password fields on a signed-in account page, but not a display preference', async () => {
    await visit(OPEN_WEB.account);
    expect(await facts(page.locator('#save-contact'))).toMatchObject({
      accountPage: true,
      region: { accountFields: true },
    });
    expect(await classify(page.locator('#save-contact'))).toBe('account_security');
    expect(await classify(page.locator('#update-password'))).toBe('account_security');
    expect(await classify(page.locator('input[name="phone"]'), 'submit')).toBe('account_security');
    expect(await classify(page.locator('#theme'), 'select')).toBe('ordinary');
    expect(await classify(page.locator('#save-display'))).toBe('ordinary');
  });

  it('stops a formless chat Enter as speaking through the executor', async () => {
    const db = new SqliteDriver(new Database(':memory:'));
    try {
      await db.exec(
        "CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('job-1');",
      );
      await browserSiteLeasesMigration.up(db);
      const context = {
        job: { id: 'job-1' },
        request: { id: 'request-1' },
        session: {},
        store: new BrowserStore(db),
        page: async () => page,
        assertActive: async () => undefined,
        wakeWaiters: async () => undefined,
        remaining: () => 15_000,
        signal: new AbortController().signal,
      } as unknown as BrowserExecutionContext;
      // The page loads before the job's navigation guard, which refuses documents between operations.
      await visit(OPEN_WEB.help);
      await page.locator('#chat-input').fill('Where is my order?');
      const observation = await observePage(page);
      const line = observation.snapshot.split('\n').find((candidate) => candidate.includes('Type a message'));
      const ref = line && /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1];
      if (!ref) throw new Error(`Missing chat input in ${observation.snapshot}`);
      const result = await executeBrowserBatch(
        context,
        { actions: [{ kind: 'key', ref, generation: observation.generation, key: 'Enter' }] },
        { record: false },
      );
      expect(result).toMatchObject({
        status: 'stopped',
        reason: 'speaks_as_principal',
        actions: [{ status: 'stopped', reason: 'speaks_as_principal' }],
      });
      expect(fixture.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('reads the control under an overlay by its own facts', async () => {
    await visit(OPEN_WEB.overlay);
    const covered = await page.locator('#search').evaluate((button) => {
      const node = button as unknown as {
        getBoundingClientRect(): { x: number; y: number; width: number; height: number };
        ownerDocument: { elementFromPoint(x: number, y: number): { id: string } | null };
      };
      const box = node.getBoundingClientRect();
      return node.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.id;
    });
    // The trick is live: the layer, not the search, sits under the pointer.
    expect(covered).toBe('overlay');
    expect(await classify(page.locator('#search'))).toBe('ordinary');
  });
});
