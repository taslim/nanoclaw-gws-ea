import fs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { root } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: join(tmpdir(), 'nanoclaw-open-web-purchases-tests') };
});
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: root,
  GROUPS_DIR: `${root}/groups`,
}));
vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  registerSessionAdmissionPolicy: vi.fn(),
  setAutoGroupImageRefresh: vi.fn(),
  wakeContainer: vi.fn(async () => true),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { useFakeGateway } from '../gws-ea-sealed-gateway/testing/fake-gateway.js';
import * as loginStoreModule from './login-store.js';
import { openWebFixture, type OpenWebFixture } from './open-web-native-fixture.js';
import { useAvailableBrowser } from './testing/browser-runtime.js';
import { testLoginStore } from './testing/login-store.js';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { OutboundFile } from '../../channels/adapter.js';
import { getDb } from '../../db/index.js';
import { getDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { BrowserLocatorError, resolveLocator } from './locators.js';
import { classifyNavigationUrl } from './control-policy.js';
import type { BrowserAction } from './actions.js';
import { readMerchantPurchase } from './merchant-read.js';
import {
  CONSENT,
  GENERIC,
  checkoutPage,
  feeTablePage,
  htmlPage,
  placedPage,
  refIn,
} from './open-web-native-fixture.js';
import { observePage } from './observe.js';
import type { BrowserQueue } from './queue.js';
import {
  ALIAS,
  PRINCIPAL,
  answerOf,
  errandRequest,
  pngSize,
  startErrandHost,
  stopErrandHost,
  type ErrandHost,
} from './testing/open-web-native-helpers.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;

/** The one fixture every suite here drives: each test starts from its shared pages, with no request seen. */
let fixture: OpenWebFixture;
let defaultLogins: ReturnType<typeof testLoginStore>;
beforeAll(async () => {
  if (chromePath) fixture = await openWebFixture(chromePath);
}, 30_000);
afterAll(async () => {
  await fixture?.close();
});
beforeEach(() => {
  // Each job's queue reconciles the browser group's gateway identity.
  useFakeGateway();
  useAvailableBrowser();
  fixture?.reset();
  fs.rmSync(`${root}/browser`, { recursive: true, force: true });
  defaultLogins = testLoginStore(`${root}/browser`);
  vi.spyOn(loginStoreModule, 'getLoginStore').mockResolvedValue(defaultLogins.store);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.skipIf(!chromePath)('purchases on unreviewed sites in native Chrome', { timeout: 60_000 }, () => {
  let host: ErrandHost;
  let page: Page;
  let queue: BrowserQueue;
  let session: Session;
  let main: Session;
  let sent: string[];
  /** The files each delivery carried, beside its content in `sent`. */
  let attached: ErrandHost['attached'];
  const posts = (): string[] =>
    fixture.requests.filter((request) => request.method !== 'GET').map((request) => request.url);
  /** Each card posted: how many pictures it names, and the files that went with it. */
  const cards = (): Array<{ pictures: unknown; files: readonly OutboundFile[] | undefined }> =>
    sent.flatMap((content, index) => {
      const card = JSON.parse(content) as { type?: string; pictures?: unknown };
      return card.type === 'ask_question' ? [{ pictures: card.pictures, files: attached[index] }] : [];
    });

  beforeEach(async () => {
    host = await startErrandHost(root, fixture, 'system:a2a:main-p:checkout');
    ({ page, queue, main, errand: session, sent, attached } = host);
  });
  afterEach(() => stopErrandHost(root, host));

  const answer = (id: string): Promise<Record<string, unknown>> => answerOf(host, id);
  /** One browser request through the queue, as the browser agent sends it; its answer's data. */
  const run = (id: string, actions: BrowserAction[]) => errandRequest(host, id, 'browser', { actions });
  const open = (url: string): Promise<Record<string, unknown>> =>
    run(`open-${randomUUID()}`, [{ kind: 'navigate', url }]);
  /** The agent's purchase of the control named `name`, aimed from a fresh observation. */
  async function purchase(name: string, id = `purchase-${randomUUID()}`): Promise<Record<string, unknown>> {
    const handler = getDeliveryAction('purchase');
    if (!handler) throw new Error('purchase delivery missing');
    await handler({ action: 'purchase', requestId: id, target: refIn(await observePage(page), name) }, session);
    await queue.idle();
    return answer(id);
  }
  const approvals = (): Promise<PendingApproval[]> =>
    getDb().all<PendingApproval>('SELECT * FROM pending_approvals ORDER BY created_at');
  async function approve(approval: PendingApproval): Promise<void> {
    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value: 'approve',
      userId: PRINCIPAL,
      channelType: 'gchat',
      platformId: 'spaces/principal',
      threadId: null,
    });
    await queue.idle();
  }
  const authorities = () =>
    getDb().all<{ state: string; facts_json: string; outcome_json: string | null }>(
      'SELECT state,facts_json,outcome_json FROM gws_ea_browser_authorities ORDER BY created_at',
    );
  const attempts = () =>
    getDb().all<{
      site: string;
      platform: string | null;
      account_key: string | null;
      resolution: string | null;
      merchant_record_id: string | null;
    }>(
      'SELECT site,platform,account_key,resolution,merchant_record_id FROM gws_ea_browser_purchase_attempts ORDER BY attempted_at',
    );
  const blocks = () => getDb().all<{ site: string }>('SELECT site FROM gws_ea_browser_purchase_blocks ORDER BY site');
  /** What the host wrote into a session's conversation, oldest first. */
  async function texts(into: Session): Promise<string[]> {
    return (
      (await withExistingMailboxSession(into.agent_group_id, into.id, (mailbox) =>
        mailbox
          .getInboundHistory(100)
          .map((message) => (JSON.parse(message.content) as { text?: string }).text ?? '')
          .reverse(),
      )) ?? []
    );
  }
  /** Main's notes that an attempt is unconfirmed. */
  const unconfirmedNotes = async (): Promise<string[]> =>
    (await texts(main)).filter((text) => text.includes('so it is unconfirmed'));
  /** Main's recorded bounds for this errand's table, and the principal's standing guarantee up to $100. */
  async function standingGuarantee(): Promise<void> {
    const bounds = getDeliveryAction('reservation_bounds');
    if (!bounds) throw new Error('reservation_bounds delivery missing');
    await bounds(
      {
        action: 'reservation_bounds',
        requestId: 'bounds',
        thread: session.thread_id!,
        venue_id: 'Trattoria Remy',
        party_size: 2,
        window_start: '2026-10-24T18:00:00-07:00',
        window_end: '2026-10-24T21:00:00-07:00',
      },
      main,
    );
    await getDb().run(
      'INSERT INTO gws_ea_browser_reservation_guarantees(id,approval_id,principal_user_id,currency,max_total_minor,created_at) VALUES(?,?,?,?,?,?)',
      'standing',
      'principal-approved',
      PRINCIPAL,
      'USD',
      10_000,
      new Date().toISOString(),
    );
  }
  const read = async (selector: string, frame?: string) => {
    const scope = frame ? page.frameLocator(frame) : page;
    const element = await scope.locator(selector).elementHandle();
    if (!element) throw new Error(`Fixture control missing: ${selector}`);
    const result = await readMerchantPurchase(page, element);
    if ('element' in result) await result.element.dispose();
    return result;
  };

  it('reads an unreviewed shop’s checkout into one card, and after approval re-reads, presses and reports placed without recipe storage', async () => {
    await open(GENERIC.review);
    await getDb().exec('DROP TABLE gws_ea_browser_action_trace; DROP TABLE gws_ea_browser_recipes;');
    await run('note', [
      { kind: 'type', ...refIn(await observePage(page), 'Delivery instructions'), text: 'Leave it with the porter' },
    ]);
    expect(await purchase('Place order', 'ae3')).toMatchObject({ status: 'awaiting_principal' });
    expect(posts()).toEqual([]);
    const [approval] = await approvals();
    expect(sent).toHaveLength(1);
    // One picture goes with it: the clip of the total and the commit control, and nothing else of the page.
    const [card] = cards();
    expect(card.pictures).toBe(1);
    expect(card.files).toHaveLength(1);
    expect(card.files![0]).toMatchObject({ filename: 'checkout.png', mimeType: 'image/png' });
    const boxes = await Promise.all(
      [page.locator('#checkout p').filter({ hasText: /^Order total/u }), page.locator('#commit')].map(
        async (target) => {
          const box = await target.boundingBox();
          if (!box) throw new Error('Fixture checkout box missing');
          return box;
        },
      ),
    );
    const left = Math.floor(Math.min(...boxes.map((box) => box.x)));
    const top = Math.floor(Math.min(...boxes.map((box) => box.y)));
    expect(pngSize(card.files![0].data)).toEqual({
      width: Math.ceil(Math.max(...boxes.map((box) => box.x + box.width))) - left,
      height: Math.ceil(Math.max(...boxes.map((box) => box.y + box.height))) - top,
    });
    for (const line of [
      'Site: pottery.example',
      'Account: guest checkout',
      "Contact email: your assistant's email",
      'Item: "Celadon mug × 2"',
      'Item: "Ash glaze bowl × 1"',
      'Total: $42.00 (USD)',
      'Due now: $42.00',
      'Payment: "Visa ending in 4242"',
      'Note: "Leave it with the porter"',
    ])
      expect(approval.question).toContain(line);
    expect(approval.question).not.toContain(ALIAS);
    expect(approval.question).not.toMatch(/attempt-|card-|authority-/u);
    await approve(approval);
    expect(posts()).toEqual([GENERIC.placed]);
    const [authority] = await authorities();
    expect(authority.state).toBe('committed');
    expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'placed', order_number: 'HP-1042' });
    expect(await attempts()).toEqual([
      {
        site: 'pottery.example',
        platform: null,
        account_key: ALIAS,
        resolution: 'committed',
        merchant_record_id: 'HP-1042',
      },
    ]);
    // The confirmation page resolved it, from the page, with no block and nothing for main to settle.
    expect(await getDb().get('SELECT resolution_source FROM gws_ea_browser_purchase_attempts')).toEqual({
      resolution_source: 'page',
    });
    expect(await blocks()).toEqual([]);
    expect(await unconfirmedNotes()).toEqual([]);
  });

  it('never resolves a second attempt from an order number its contact email already used', async () => {
    await open(GENERIC.review);
    await purchase('Place order');
    await approve((await approvals())[0]);
    // The merchant shows the same order number again after a second order.
    await open(GENERIC.review);
    expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
    await approve((await approvals())[0]);
    expect(posts()).toEqual([GENERIC.placed, GENERIC.placed]);
    const [first, second] = await authorities();
    expect(JSON.parse(first.outcome_json!)).toMatchObject({ status: 'placed', order_number: 'HP-1042' });
    expect(JSON.parse(second.outcome_json!)).toMatchObject({ status: 'unconfirmed' });
    expect(second.state).toBe('unknown');
    expect(await attempts()).toMatchObject([
      { resolution: 'committed', merchant_record_id: 'HP-1042' },
      { resolution: null, merchant_record_id: null },
    ]);
    expect(await blocks()).toEqual([{ site: 'pottery.example' }]);
  });

  it('raises nothing when a press shows the approved order again for its total, and stops the job when it shows more', async () => {
    fixture.serve(
      'https://pottery.example/orders',
      htmlPage(
        'Your orders',
        '<h1>Your orders</h1><button type="button" id="view">View order</button> <button type="button" id="updated">View updated order</button>',
        `document.getElementById('view').addEventListener('click', () => location.assign('/orders/HP-1042'));
document.getElementById('updated').addEventListener('click', () => location.assign('/orders/HP-1042/updated'));`,
      ),
    );
    fixture.serve('https://pottery.example/orders/HP-1042', placedPage('HP-1042', '$42.00'));
    // A gift box added to the same order: its number again, for more than the principal approved.
    fixture.serve('https://pottery.example/orders/HP-1042/updated', placedPage('HP-1042', '$61.00'));
    await open(GENERIC.review);
    await purchase('Place order');
    await approve((await approvals())[0]);
    expect(page.url()).toBe(GENERIC.placed);
    const view = async (name: string): Promise<Record<string, unknown>> => {
      await open('https://pottery.example/orders');
      return run(`view-${name}`, [{ kind: 'click', ...refIn(await observePage(page), name) }]);
    };
    expect(await view('View order')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(await getDb().all('SELECT kind FROM gws_ea_browser_incidents')).toEqual([]);
    expect(await view('View updated order')).toMatchObject({
      status: 'stopped',
      reason: 'unapproved_commit',
      incident: { site: 'pottery.example', reference: 'HP-1042', charged: '$61.00' },
    });
    expect(await getDb().all('SELECT kind FROM gws_ea_browser_incidents')).toEqual([{ kind: 'unapproved_commit' }]);
  });

  it("keeps the picture's bytes out of the card's rows, the approval row, the databases and the logs", async () => {
    const logged: unknown[][] = [];
    const levels = (['debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) =>
      vi.spyOn(log, level).mockImplementation((...args) => {
        logged.push(args);
      }),
    );
    try {
      await open(GENERIC.review);
      expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
    } finally {
      for (const spy of levels) spy.mockRestore();
    }
    const picture = cards()[0]?.files?.[0]?.data;
    if (!picture) throw new Error('The card carried no picture');
    const written = [
      picture.toString('base64'),
      picture.toString('base64url'),
      picture.toString('hex'),
      picture.toString('latin1'),
    ];
    const seen = new WeakSet<object>();
    /** Whether a value holds the picture: in any written form, or as bytes. */
    const holds = (value: unknown): boolean => {
      if (typeof value === 'string') return written.some((form) => value.includes(form));
      if (typeof value !== 'object' || value === null || seen.has(value)) return false;
      seen.add(value);
      if (value instanceof Uint8Array) return Buffer.from(value).includes(picture.subarray(8, 64));
      return Object.values(value).some(holds);
    };
    expect(await getDb().all('SELECT * FROM gws_ea_browser_purchase_cards')).toHaveLength(1);
    expect(await approvals()).toHaveLength(1);
    for (const { name } of await getDb().all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'"))
      expect(holds(await getDb().all(`SELECT * FROM "${name}"`)), name).toBe(false);
    for (const held of [session, main])
      expect(
        holds(
          await withExistingMailboxSession(held.agent_group_id, held.id, (mailbox) => mailbox.getInboundHistory(100)),
        ),
      ).toBe(false);
    expect(logged.length).toBeGreaterThan(0);
    expect(holds(logged)).toBe(false);
  });

  it('refuses the picture when a field in an open or a closed shadow root holds a secret, and only then', async () => {
    const shadowed = (mode: 'open' | 'closed', field: string, value: string): string =>
      checkoutPage({
        action: '/checkout/placed',
        commit: 'Place order',
        items: ['Celadon mug × 2'],
        total: '$42.00',
        payment: 'Visa ending in 4242',
        email: ALIAS,
        outside: `<account-panel></account-panel><script>const root = document.querySelector('account-panel').attachShadow({ mode: '${mode}' }); root.innerHTML = '${field}'; root.querySelector('input').value = '${value}';</script>`,
      });
    const password = '<label>Password <input type="password" name="pw"></label>';
    const code = '<label>Code <input type="text" autocomplete="one-time-code"></label>';
    for (const [index, [mode, field, value, pictured]] of (
      [
        ['open', password, 'fixture-pass-7731', false],
        // A code is ordinary text: it never withholds the picture.
        ['closed', code, '552913', true],
        ['open', password, '', true],
      ] as const
    ).entries()) {
      const address = `https://pottery.example/checkout/account-${index}`;
      fixture.serve(address, shadowed(mode, field, value));
      await open(address);
      expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
      expect(cards().at(-1), `${mode} root, ${value ? 'filled' : 'empty'}`).toMatchObject(
        pictured ? { pictures: 1, files: [{ mimeType: 'image/png' }] } : { pictures: 1, files: undefined },
      );
      // The agent's own screenshot meets the same scan: a secret in a shadow root never reaches it either.
      const shot = await run(`shot-${index}`, [{ kind: 'screenshot' }]);
      expect(shot, `${mode} root screenshot`).toMatchObject(
        pictured ? { status: 'completed' } : { status: 'stopped', reason: 'secret_field' },
      );
    }
  });

  it('posts the card when the capture fails, naming the picture it lacks', async () => {
    await open(GENERIC.review);
    const capture = vi.spyOn(page, 'screenshot').mockRejectedValueOnce(new Error('The capture failed'));
    try {
      expect(await purchase('Place order')).toMatchObject({ status: 'awaiting_principal' });
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      capture.mockRestore();
    }
    expect(cards()).toEqual([{ pictures: 1, files: undefined }]);
    expect(await approvals()).toHaveLength(1);
  });

  it('presses a free table itself with no card, unticking the offers box, and records nothing for main to settle', async () => {
    fixture.serve('https://table.example/book/r-7/confirm', placedPage('T-7731', '$0.00'));
    await open(CONSENT.offers);
    expect(await purchase('Reserve now')).toMatchObject({
      status: 'pressed',
      site: 'table.example',
      pressed_at: expect.stringMatching(/ Los Angeles time$/u),
      repeat_safe: false,
    });
    expect(await approvals()).toEqual([]);
    expect(sent).toEqual([]);
    const booking = fixture.requests.find((request) => request.method === 'POST');
    expect(new URLSearchParams(booking?.body)).toEqual(new URLSearchParams({ party: '2' }));
    expect(await attempts()).toEqual([]);
    expect(await blocks()).toEqual([]);
  });

  it('keeps a free press the site answers only after the click’s wait, so a repeat on the same checkout presses nothing', async () => {
    // Answered after the press's 10-second click window by showing the checkout again.
    fixture.serve('https://table.example/book/r-7/confirm', () => ({
      status: 303,
      headers: { location: CONSENT.offers },
      delayMs: 12_000,
    }));
    await open(CONSENT.offers);
    const shownAgain = page.waitForEvent('framenavigated', {
      predicate: (frame) => frame === page.mainFrame() && frame.url() === CONSENT.offers,
      timeout: 30_000,
    });
    const first = await purchase('Reserve now');
    expect(first).toMatchObject({ status: 'pressed', site: 'table.example', repeat_safe: false });
    // The repeat comes on the checkout the site's late answer showed again.
    await shownAgain;
    expect(await purchase('Reserve now')).toMatchObject({
      status: 'already_pressed',
      pressed_at: first.pressed_at,
      repeat_safe: true,
    });
    expect(posts()).toEqual(['https://table.example/book/r-7/confirm']);
  }, 60_000);

  it('answers already_pressed for a repeat of an earlier free booking after the errand pressed another', async () => {
    fixture.serve('https://table.example/book/r-7/confirm', () => ({
      status: 303,
      headers: { location: CONSENT.offers },
    }));
    const party = async (size: string): Promise<void> => {
      await open(CONSENT.offers);
      expect(
        await run(`party-${randomUUID()}`, [
          { kind: 'select', ...refIn(await observePage(page), 'Party size'), value: size },
        ]),
      ).toMatchObject({ status: 'completed' });
    };
    await party('2');
    const forTwo = await purchase('Reserve now');
    expect(forTwo).toMatchObject({ status: 'pressed' });
    await party('4');
    expect(await purchase('Reserve now')).toMatchObject({ status: 'pressed' });
    await party('2');
    expect(await purchase('Reserve now')).toMatchObject({ status: 'already_pressed', pressed_at: forTwo.pressed_at });
    expect(posts()).toHaveLength(2);
  }, 60_000);

  it.each(['purchase', 'click'] as const)(
    'stops the job with an incident when a free booking’s confirmation shows a charge, pressed by %s',
    async (pressedBy) => {
      fixture.serve(GENERIC.booked, placedPage('T-2210', '$25.00'));
      await open(GENERIC.freeTable);
      const result =
        pressedBy === 'purchase'
          ? await purchase('Reserve now')
          : await run('reserve', [{ kind: 'click', ...refIn(await observePage(page), 'Reserve now') }]);
      expect(result).toMatchObject({
        status: 'stopped',
        reason: 'unapproved_commit',
        incident: { site: 'table.example', reference: 'T-2210', charged: '$25.00' },
        repeat_safe: false,
      });
      expect(posts()).toEqual([GENERIC.booked]);
      expect(await getDb().all('SELECT kind,site,job_id FROM gws_ea_browser_incidents')).toEqual([
        { kind: 'unapproved_commit', site: 'table.example', job_id: session.thread_id },
      ]);
    },
  );

  it('keeps a booking free past "No credit card required" and a Gift cards link outside its form, but not beside Google Pay or a saved card', async () => {
    await open(GENERIC.freeTable);
    expect(await read('#reserve')).toMatchObject({ status: 'free' });
    await open(GENERIC.walletTable);
    expect(await read('#reserve')).toMatchObject({ status: 'card_needed' });
    await open(GENERIC.cardTable);
    // The saved card beside the form is the payment: the booking is never free and falls back to screenshot review.
    const cardTableRead = await read('#reserve');
    expect(cardTableRead).toMatchObject({
      status: 'ready',
      facts: {
        cardEnding: '4242',
        generic: {
          payment: expect.stringContaining('Visa ending in 4242'),
          review: { missing: ['the total', 'the contact email'] },
        },
      },
    });
    expect(posts()).toEqual([]);
  });

  it('answers card_needed with the site, account, items and total when no payment method is saved', async () => {
    await open(GENERIC.guest);
    const seen = await observePage(page);
    const handler = getDeliveryAction('purchase');
    if (!handler) throw new Error('purchase delivery missing');
    await handler({ action: 'purchase', requestId: 'card-needed', target: refIn(seen, 'Place order') }, session);
    await queue.idle();
    expect(await answer('card-needed')).toMatchObject({
      status: 'card_needed',
      site: 'pottery.example',
      account: 'guest checkout',
      items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
      total: '$42.00',
      repeat_safe: true,
    });
    expect(await approvals()).toEqual([]);
    expect(posts()).toEqual([]);
    const edit = await run('edit-after-card-needed', [
      { kind: 'type', ...refIn(seen, 'Email'), text: 'other@example.com' },
    ]);
    expect(edit.reason).toBeUndefined();
    expect(edit).toMatchObject({
      status: 'completed',
      actions: [{ status: 'completed' }],
    });
    expect(await page.locator('[name="email"]').inputValue()).toBe('other@example.com');
  });

  it('keeps a generic control locator exact across duplicate labels and refuses unnamed controls', async () => {
    await open(GENERIC.review);
    await observePage(page);
    await page.locator('#commit').evaluate((button) => {
      const duplicate = button.cloneNode(true) as typeof button;
      duplicate.id = 'duplicate-commit';
      button.parentElement!.append(duplicate);
    });
    const element = await page.locator('#commit').elementHandle();
    if (!element) throw new Error('Fixture commit control missing');
    const result = await readMerchantPurchase(page, element);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready' || !result.facts.control.locator) throw new Error('No generic locator');
    const locator = result.facts.control.locator;
    expect(locator).toMatchObject({ name: 'Place order', ordinal: 0, count: 2 });
    const resolved = await resolveLocator(page, locator);
    expect(await resolved.getAttribute('id')).toBe('commit');
    await resolved.dispose();
    await page.locator('#duplicate-commit').evaluate((button) => button.remove());
    await expect(resolveLocator(page, locator)).rejects.toBeInstanceOf(BrowserLocatorError);
    await result.element.dispose();
    await page.locator('#commit').evaluate((button) => {
      button.textContent = '';
    });
    expect(await read('#commit')).toMatchObject({
      status: 'facts_incomplete',
      missing: ["the checkout's place-order button"],
    });
    expect(posts()).toEqual([]);
  });

  it('puts readable recurring terms on the card, sends a screenshot-backed review card when frequency is unread, and fails closed without a safe screenshot', async () => {
    await open(GENERIC.club);
    await page
      .locator('#checkout p:not(.item)')
      .filter({ hasText: 'Membership' })
      .evaluate((node) => {
        (node as unknown as { textContent: string }).textContent =
          'Membership: $12.00, renews automatically until you cancel.';
      });
    // When a filled secret prevents safe screenshot capture, a review checkout refuses to post a blind card.
    await page.evaluate(`(() => {
      const pw = document.createElement('input');
      pw.type = 'password';
      pw.id = 'secret-blocker';
      pw.value = 'fixture-secret-123';
      document.body.append(pw);
    })()`);
    expect(await purchase('Subscribe')).toMatchObject({
      status: 'facts_incomplete',
      missing: ['the recurring frequency'],
      repeat_safe: true,
    });
    expect(await approvals()).toEqual([]);

    // Reload into a fresh untainted document: without a secret hiding the screenshot, the principal gets a review card.
    await open(GENERIC.club);
    await page
      .locator('#checkout p:not(.item)')
      .filter({ hasText: 'Membership' })
      .evaluate((node) => {
        (node as unknown as { textContent: string }).textContent =
          'Membership: $12.00, renews automatically until you cancel.';
      });
    expect(await purchase('Subscribe')).toMatchObject({ status: 'awaiting_principal' });
    const [reviewCard] = await approvals();
    expect(reviewCard.question).toContain("couldn't read every detail automatically");
    expect(reviewCard.question).toContain('Could not verify automatically: the recurring frequency.');
    expect(cards().at(-1)).toMatchObject({ pictures: 1, files: [{ filename: 'checkout.png', mimeType: 'image/png' }] });

    // The page as the site serves it again: its readable terms reach the principal's card directly.
    await open(GENERIC.club);
    expect(await purchase('Subscribe')).toMatchObject({ status: 'awaiting_principal' });
    const [approval] = await approvals();
    for (const line of [
      'Financial commitment: subscription; "Membership: $12.00/month, renews automatically until you cancel."',
      'Recurring frequency: "monthly"',
    ])
      expect(approval.question).toContain(line);
    expect(approval.question).not.toContain('Could not verify automatically:');
  });

  it('presses Continue then Place order under one card, as one attempt', async () => {
    expect(classifyNavigationUrl(GENERIC.placeOrder, 'document')).toBe('purchase_control');
    await open(GENERIC.steps);
    expect(await purchase('Continue')).toMatchObject({ status: 'awaiting_principal' });
    await approve((await approvals())[0]);
    // The approved press loads its own checkout's purchase route, which the open rule refuses otherwise.
    expect(posts()).toEqual([GENERIC.stepsNext, GENERIC.placeOrder]);
    expect(sent).toHaveLength(1);
    expect(await attempts()).toMatchObject([{ resolution: 'committed', merchant_record_id: 'HP-1043' }]);
  });

  it('presses at most three steps under one approval, and leaves a checkout that keeps asking unconfirmed', async () => {
    // Each step names a new commit and posts to the next, with the same items, total and card: nothing to ask again.
    // From the fifth on, the same step comes back, so a press past the cap shows as a post rather than a hang.
    let step = 1;
    fixture.serve(GENERIC.stepsNext, () => {
      step += 1;
      return {
        body: checkoutPage({
          title: 'Review your order',
          action: `/checkout/steps/next?step=${step + 1}`,
          commit: `Continue to step ${Math.min(step, 5)}`,
          items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
          total: '$42.00',
          payment: 'Visa ending in 4242',
          email: ALIAS,
        }),
      };
    });
    await open(GENERIC.steps);
    expect(await purchase('Continue')).toMatchObject({ status: 'awaiting_principal' });
    await approve((await approvals())[0]);
    expect(posts()).toEqual([GENERIC.stepsNext, `${GENERIC.stepsNext}?step=3`, `${GENERIC.stepsNext}?step=4`]);
    expect(sent).toHaveLength(1);
    const [authority] = await authorities();
    expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'unconfirmed' });
    expect(await attempts()).toMatchObject([{ resolution: null }]);
    expect(await blocks()).toEqual([{ site: 'pottery.example' }]);
  });

  it('sends a new card when the total rises between steps, and stops the job at the fourth change', async () => {
    // Each step posts to the next one's own address and names its own commit, and each shows a higher total.
    let total = 42;
    fixture.serve(GENERIC.stepsNext, () => {
      total += 1;
      return {
        body: checkoutPage({
          title: 'Review your order',
          action: `/checkout/steps/next?step=${total - 41}`,
          commit: `Continue to step ${total - 41}`,
          items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
          total: `$${total}.00`,
          payment: 'Visa ending in 4242',
          email: ALIAS,
        }),
      };
    });
    await open(GENERIC.steps);
    expect(await purchase('Continue')).toMatchObject({ status: 'awaiting_principal' });
    for (let change = 1; change <= 3; change++) {
      await approve((await approvals())[0]);
      const [card] = await approvals();
      expect(card.question).toContain(`The total rose to $${42 + change}.00`);
    }
    await approve((await approvals())[0]);
    expect(await approvals()).toEqual([]);
    expect(sent).toHaveLength(4);
    const notices = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.getInboundHistory(100).map((message) => message.content),
    );
    const changing = notices
      ?.map((content) => JSON.parse(content) as { text?: string })
      .filter((content) => content.text?.includes('"browser_purchase_outcome"'))
      .map((content) => JSON.parse(content.text ?? '') as Record<string, unknown>)
      .find((notice) => notice.status === 'checkout_changing');
    // The browser reads what changed in the sentence it reports from.
    expect(changing?.message).toContain(
      'The checkout changed again after three changed cards (The total rose to $46.00, from $45.00.), so the host stopped this errand',
    );
    expect(await attempts()).toMatchObject(Array(4).fill({ resolution: 'not_committed' }));
    expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', session.thread_id)).toEqual({
      cancelled: 1,
    });
  });

  it('presses Place order once when the same step comes back, and leaves the attempt unconfirmed', async () => {
    fixture.serve(GENERIC.placed, () => ({
      body: checkoutPage({
        action: '/checkout/placed',
        commit: 'Place order',
        items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
        total: '$42.00',
        payment: 'Visa ending in 4242',
        email: ALIAS,
      }),
    }));
    await open(GENERIC.review);
    await purchase('Place order');
    await approve((await approvals())[0]);
    expect(posts()).toEqual([GENERIC.placed]);
    const [authority] = await authorities();
    expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'unconfirmed' });
    expect(await attempts()).toMatchObject([{ resolution: null }]);
    expect(await blocks()).toEqual([{ site: 'pottery.example' }]);
  });

  it('resolves a press the merchant declines as not placed, from its step, with nothing left to wait on', async () => {
    fixture.serve(
      GENERIC.placed,
      checkoutPage({
        action: '/checkout/placed',
        commit: 'Place order',
        items: ['Celadon mug × 2', 'Ash glaze bowl × 1'],
        total: '$42.00',
        payment: 'Visa ending in 4242',
        email: ALIAS,
        lines: ['Your card was declined. Try another card.'],
      }),
    );
    await open(GENERIC.review);
    await purchase('Place order');
    await approve((await approvals())[0]);
    expect(posts()).toEqual([GENERIC.placed]);
    const [authority] = await authorities();
    expect(authority.state).toBe('revoked');
    expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'not_placed', reason: 'declined' });
    expect(
      await getDb().all('SELECT resolution,resolution_source,evidence_json FROM gws_ea_browser_purchase_attempts'),
    ).toEqual([
      {
        resolution: 'not_committed',
        resolution_source: 'step',
        evidence_json: expect.stringContaining('Your card was declined'),
      },
    ]);
    expect(await blocks()).toEqual([]);
    expect(await unconfirmedNotes()).toEqual([]);
  });

  it('keeps the merchant’s lease and block through a payment platform’s own page, binding the platform origin', async () => {
    await open(GENERIC.toPlatform);
    expect(page.url()).toBe(GENERIC.platform);
    expect(await purchase('Pay $42.00')).toMatchObject({ status: 'awaiting_principal' });
    const [approval] = await approvals();
    expect(approval.question).toContain('Site: pottery.example');
    expect(approval.question).toContain('Checkout on: pay.example');
    expect(
      await getDb().all('SELECT site,state FROM gws_ea_browser_site_leases WHERE job_id = ?', session.thread_id),
    ).toEqual([{ site: 'pottery.example', state: 'purchase' }]);
    await approve(approval);
    const [authority] = await authorities();
    expect(JSON.parse(authority.facts_json)).toMatchObject({ site: 'pottery.example', origin: 'https://pay.example' });
    expect(JSON.parse(authority.outcome_json!)).toMatchObject({ status: 'placed', order_number: 'PX-77' });
    expect(await attempts()).toMatchObject([{ site: 'pottery.example', platform: 'pay.example' }]);
  });

  it('blocks the merchant, not the payment platform, when a platform press has no page proof', async () => {
    fixture.serve(GENERIC.platformPaid, '<!doctype html><title>Processing</title><p>Processing your payment</p>');
    await open(GENERIC.toPlatform);
    await purchase('Pay $42.00');
    await approve((await approvals())[0]);
    expect(posts()).toEqual([GENERIC.platformPaid]);
    expect(await attempts()).toMatchObject([{ site: 'pottery.example', platform: 'pay.example', resolution: null }]);
    expect(await getDb().all('SELECT site FROM gws_ea_browser_purchase_blocks')).toEqual([{ site: 'pottery.example' }]);
  });

  it('reads a per-person no-show fee as a commitment, and books under the standing guarantee with no card when every booking fact is read', async () => {
    await open(GENERIC.feeTable);
    const fee = await read('#reserve');
    expect(fee).toMatchObject({
      status: 'ready',
      facts: {
        totalMinor: 0,
        dueNowMinor: 0,
        commitments: [{ kind: 'conditional_fee', conditionalTrigger: 'no_show', amountMinor: 2500, perPerson: true }],
      },
    });
    await standingGuarantee();
    expect(await purchase('Reserve now')).toMatchObject({ status: 'booked', order_number: 'TR-5531' });
    expect(await approvals()).toEqual([]);
    expect(await authorities()).toMatchObject([{ state: 'committed' }]);
  });

  it('sends a card for a fee booking whose party size it cannot read, whatever the guarantee covers', async () => {
    fixture.serve(GENERIC.feeTable, feeTablePage(false));
    await open(GENERIC.feeTable);
    await standingGuarantee();
    expect(await purchase('Reserve now')).toMatchObject({ status: 'awaiting_principal' });
    const [approval] = await approvals();
    expect(approval.question).toContain('No-show fee: $25 per person');
    expect(posts()).toEqual([]);
  });

  it('records an embedded booking frame’s domain as the attempt’s platform for a deposit', async () => {
    await open(GENERIC.depositHost);
    await page.frameLocator('#booking').locator('#book-now').waitFor();
    expect(await read('#book-now', '#booking')).toMatchObject({
      status: 'ready',
      facts: { site: 'osteria.example', origin: 'https://tables.example', dueNowMinor: 5000 },
    });
    expect(await purchase('Book now')).toMatchObject({ status: 'awaiting_principal' });
    await approve((await approvals())[0]);
    expect(await attempts()).toMatchObject([
      { site: 'osteria.example', platform: 'tables.example', resolution: 'committed', merchant_record_id: 'OJ-818' },
    ]);
  });
});
