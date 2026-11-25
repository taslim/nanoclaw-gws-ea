import fs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { root } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: join(tmpdir(), 'nanoclaw-open-web-purchases-flow-tests') };
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
import { withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { readBrowserJob } from './cancel.js';
import { ensureBrowserNavigationGuard } from './commit-classifier.js';
import { currentFreeDialog, freePressInProgress } from './free-press.js';
import type { BrowserAction } from './actions.js';
import {
  GENERIC,
  GUEST_BOOKING,
  PROCESSOR,
  checkoutPage,
  guestBookingPage,
  htmlPage,
  placedPage,
  refIn,
} from './open-web-native-fixture.js';
import { observePage, type BrowserSnapshotObservation } from './observe.js';
import type { BrowserQueue } from './queue.js';
import { deliverAction } from './testing/delivery-answer.js';
import {
  ALIAS,
  PRINCIPAL,
  answerOf,
  errandRequest,
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

describe.skipIf(!chromePath)(
  'purchases on unreviewed sites in native Chrome: multi-step and booking flows',
  { timeout: 60_000 },
  () => {
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

    it('prepares a multi-step venue booking without approval at entry, refuses a sneaky link POST without a purchase target, and stops recipe replay at a free final booking', async () => {
      const entry = 'https://salon.example/book-now/cedar-studio-9x2k/all-offer';
      const provider = 'https://salon.example/providers/cedar-studio-9x2k';
      const services = 'https://salon.example/providers/cedar-studio-9x2k/services';
      const confirm = 'https://salon.example/providers/cedar-studio-9x2k/confirm';
      const booked = 'https://salon.example/providers/cedar-studio-9x2k/booked';
      fixture.serve(entry, () => ({ status: 302, headers: { location: provider } }));
      fixture.serve(
        provider,
        htmlPage(
          'Cedar Studio',
          `<h1>Cedar Studio</h1><a href="/providers/cedar-studio-9x2k/services">Book now</a><a id="sneaky-fetch" href="/providers/cedar-studio-9x2k/services">Check availability</a><a id="sneaky-redirect" href="/providers/cedar-studio-9x2k/services">Instant book</a>`,
          `document.getElementById('sneaky-fetch').addEventListener('click', (event) => { event.preventDefault(); fetch('/api/checkout/charge', { method: 'POST', body: 'card=1' }).catch(() => undefined); });
document.getElementById('sneaky-redirect').addEventListener('click', (event) => { event.preventDefault(); location.assign('/checkout/placeorder'); });`,
        ),
      );
      fixture.serve(
        services,
        htmlPage(
          'Select a service',
          `<h1>Select a service</h1><button type="button" id="pick">Cut &amp; finish</button><button type="button" id="prelim" disabled>Book now</button><button type="button" id="continue-step" disabled>Continue</button>`,
          `document.getElementById('pick').addEventListener('click', () => { document.getElementById('prelim').disabled = false; document.getElementById('continue-step').disabled = false; });
document.getElementById('continue-step').addEventListener('click', () => { location.assign('/providers/cedar-studio-9x2k/confirm'); });`,
        ),
      );
      fixture.serve(
        confirm,
        htmlPage(
          'Confirm appointment',
          `<h1>Cedar Studio</h1><form method="post" action="/providers/cedar-studio-9x2k/booked"><label>Party size <select name="party"><option selected>1</option></select></label><p>Cut &amp; finish on <time datetime="2026-10-24T11:00:00-07:00">Saturday, October 24, 11:00 AM</time></p><p>No payment is needed to reserve.</p><button type="submit">Complete reservation</button></form>`,
        ),
      );
      fixture.serve(booked, placedPage('CS-1100', '$0.00'));

      // A sneaky script POST on an ordinary link is aborted, while a sneaky redirect to a commit route stops with continuation refused and no target.
      expect(await open(entry)).toMatchObject({ status: 'stopped', reason: 'navigated' });
      expect(page.url()).toBe(provider);
      expect(
        await run('sneaky-fetch', [{ kind: 'click', ...refIn(await observePage(page), 'Check availability') }]),
      ).toMatchObject({ status: 'completed' });
      expect(posts()).toEqual([]);
      const sneaky = await run('sneaky-redirect', [
        { kind: 'click', ...refIn(await observePage(page), 'Instant book') },
      ]);
      expect(sneaky).toMatchObject({
        status: 'stopped',
        reason: 'purchase_control',
        continuation: { status: 'refused' },
      });
      expect(sneaky.continuation).not.toHaveProperty('target');
      expect(posts()).toEqual([]);

      // A preliminary "Book now" button with no identifiable booking/item stops without acquiring free-press state.
      await open(services);
      await run('enable-prelim', [{ kind: 'click', ...refIn(await observePage(page), 'Cut & finish') }]);
      const prelimStop = await run('prelim-button', [{ kind: 'click', ...refIn(await observePage(page), 'Book now') }]);
      expect(prelimStop).toMatchObject({
        status: 'stopped',
        reason: 'purchase_control',
        continuation: { status: 'ready', target: { ref: expect.any(String) } },
      });
      expect(freePressInProgress(session.thread_id!)).toBe(false);
      expect(currentFreeDialog(page)).toBeUndefined();
      expect(await purchase('Book now')).toEqual({
        status: 'facts_incomplete',
        missing: ['the items'],
        repeat_safe: true,
      });

      // Re-open the provider entry; ordinary entry links, service selection and Continue steps proceed cleanly.
      expect(await open(entry)).toMatchObject({ status: 'stopped', reason: 'navigated' });
      expect(await run('entry-link', [{ kind: 'click', ...refIn(await observePage(page), 'Book now') }])).toMatchObject(
        {
          status: 'stopped',
          reason: 'navigated',
        },
      );
      expect(page.url()).toBe(services);
      expect(
        await run('pick-service', [{ kind: 'click', ...refIn(await observePage(page), 'Cut & finish') }]),
      ).toMatchObject({
        status: 'completed',
      });
      expect(
        await run('continue-step', [{ kind: 'click', ...refIn(await observePage(page), 'Continue') }]),
      ).toMatchObject({
        status: 'stopped',
        reason: 'navigated',
      });
      expect(page.url()).toBe(confirm);
      expect(await approvals()).toEqual([]);
      expect(freePressInProgress(session.thread_id!)).toBe(false);
      expect(currentFreeDialog(page)).toBeUndefined();

      // Pressing the genuinely free final booking commits once; saving and replaying the path stops at Complete reservation without pressing it.
      const freePress = await run('free-commit', [
        { kind: 'click', ...refIn(await observePage(page), 'Complete reservation') },
      ]);
      expect(freePress).toMatchObject({ status: 'stopped', reason: 'pressed' });
      expect(posts()).toEqual([booked]);
      const { last } = (await getDb().get<{ last: number }>(
        'SELECT MAX(action_index) AS last FROM gws_ea_browser_action_trace',
      ))!;
      const saved = await errandRequest(host, 'save-salon', 'save_recipe', {
        name: 'Cedar booking',
        first_action: last - 3,
        last_action: last,
        parameters: [],
      });
      expect(saved).toMatchObject({ status: 'saved' });
      await open(provider);
      const replayed = await errandRequest(host, 'replay-salon', 'run_recipe', {
        recipe_id: saved.recipe_id,
        parameters: {},
      });
      expect(replayed).toMatchObject({
        status: 'reached_commit_point',
        step: 3,
        target: {
          generation: (replayed.observation as BrowserSnapshotObservation).generation,
          ref: expect.any(String),
        },
      });
      expect(posts()).toEqual([booked]);
    });

    it('returns an observed commit continuation for click, Enter, Space and form_input, reports changed targets, and enforces purchase bounds', async () => {
      await open(GENERIC.review);
      const seen = await observePage(page);
      const byClick = await run('stop-click', [{ kind: 'click', ...refIn(seen, 'Place order') }]);
      expect(byClick).toMatchObject({
        status: 'stopped',
        reason: 'purchase_control',
        continuation: {
          status: 'ready',
          target: { generation: (byClick.observation as { generation: number }).generation, ref: expect.any(String) },
        },
      });

      const persisted = await getDb().get<{ answer_json: string }>(
        'SELECT answer_json FROM gws_ea_browser_requests WHERE session_id = ? AND request_id = ?',
        session.id,
        'stop-click',
      );
      expect(JSON.parse(persisted!.answer_json)).toMatchObject({
        ok: true,
        data: { continuation: byClick.continuation },
      });
      expect(persisted!.answer_json).not.toMatch(/locator|framePath|element/u);

      const byEnter = await run('stop-enter', [
        { kind: 'key', ...refIn(await observePage(page), 'Email'), key: 'Enter' },
      ]);
      expect(byEnter).toMatchObject({
        status: 'stopped',
        reason: 'purchase_control',
        continuation: {
          status: 'ready',
          target: { generation: (byEnter.observation as { generation: number }).generation, ref: expect.any(String) },
        },
      });
      expect(await page.getByRef((byEnter.continuation as { target: { ref: string } }).target.ref).textContent()).toBe(
        'Place order',
      );

      const bySpace = await run('stop-space', [
        { kind: 'key', ...refIn(await observePage(page), 'Place order'), key: 'Space' },
      ]);
      expect(bySpace).toMatchObject({
        status: 'stopped',
        reason: 'purchase_control',
        continuation: {
          status: 'ready',
          target: { generation: (bySpace.observation as { generation: number }).generation, ref: expect.any(String) },
        },
      });

      const formSeen = await observePage(page);
      const byForm = await run('stop-form', [
        {
          kind: 'form_input',
          fields: [{ ...refIn(formSeen, 'Delivery instructions'), value: 'Ring bell' }],
          submit: refIn(formSeen, 'Place order'),
        },
      ]);
      expect(byForm).toMatchObject({
        status: 'stopped',
        reason: 'purchase_control',
        continuation: {
          status: 'ready',
          target: { generation: (byForm.observation as { generation: number }).generation, ref: expect.any(String) },
        },
      });
      expect(posts()).toEqual([]);

      // purchase distinguishes preparation controls from lapsed checkouts, and preserves delivery_window bounds on continuation.target.
      const handler = getDeliveryAction('purchase')!;
      const withPrep = 'https://pottery.example/checkout/with-prep';
      fixture.serve(
        withPrep,
        checkoutPage({
          action: '/checkout/placed',
          commit: 'Place order',
          items: ['Celadon mug × 2'],
          total: '$42.00',
          payment: 'Visa ending in 4242',
          email: ALIAS,
          outside:
            '<button type="button" id="summary">Show order summary</button><div id="cookie" role="dialog" aria-label="Cookie preferences" hidden><button type="button" id="reject-cookies">Reject all</button></div><script>document.getElementById("reject-cookies").addEventListener("click", () => { document.getElementById("cookie").remove(); document.getElementById("commit").remove(); });</script>',
        }),
      );
      await open(withPrep);
      await handler(
        { action: 'purchase', requestId: 'prep-target', target: refIn(await observePage(page), 'Show order summary') },
        session,
      );
      await queue.idle();
      expect(await answer('prep-target')).toEqual({
        status: 'not_a_purchase',
        reason: 'preparing',
        repeat_safe: true,
      });

      const stopOnPrep = await run('stop-prep-commit', [
        { kind: 'click', ...refIn(await observePage(page), 'Place order') },
      ]);
      const commitTarget = (stopOnPrep.continuation as { target: { ref: string; generation: number } }).target;
      await handler(
        {
          action: 'purchase',
          requestId: 'bounded-purchase',
          target: commitTarget,
          delivery_window: { start: '2026-10-23', end: '2026-10-25' },
        },
        session,
      );
      await queue.idle();
      expect(await answer('bounded-purchase')).toMatchObject({ status: 'awaiting_principal' });
      const storedCard = await getDb().get<{ bounds_json: string }>(
        "SELECT bounds_json FROM gws_ea_browser_purchase_cards WHERE status = 'open'",
      );
      expect(JSON.parse(storedCard!.bounds_json)).toEqual({
        deliveryWindow: { start: '2026-10-23', end: '2026-10-25' },
      });
      const [boundedCard] = await approvals();
      await approve(boundedCard);
      expect(posts()).toEqual([GENERIC.placed]);

      // If a cookie-banner settle removes the commit target before observation completes, continuation reports changed with no target.
      await open(withPrep);
      await page.evaluate(`document.getElementById('cookie').hidden = false`);
      const vanished = await run('stop-vanished', [
        { kind: 'click', ...refIn(await observePage(page), 'Place order') },
      ]);
      expect(vanished).toMatchObject({
        status: 'stopped',
        reason: 'purchase_control',
        continuation: { status: 'changed' },
      });
      expect(vanished.continuation).not.toHaveProperty('target');

      // If an observed commit control hides before purchase reads its checkout box, purchase reports reason: 'changed'.
      await open(withPrep);
      const vanishedCommit = refIn(await observePage(page), 'Place order');
      await page.evaluate(`document.getElementById('commit').style.display = 'none'`);
      await handler({ action: 'purchase', requestId: 'lapsed-checkout', target: vanishedCommit }, session);
      await queue.idle();
      expect(await answer('lapsed-checkout')).toEqual({
        status: 'not_a_purchase',
        reason: 'changed',
        repeat_safe: true,
      });
    });

    it('sends a screenshot-backed review card for an unreadable venue fee (locking text against mutation), and cards a readable pay-at-venue fee booking', async () => {
      const unreadable = 'https://salon.example/book/unreadable-fee';
      const payAtVenue = 'https://salon.example/book/venue-terms';
      const salonBooked = 'https://salon.example/book/confirmed';
      fixture.serve(
        unreadable,
        htmlPage(
          'Confirm appointment',
          `<h1>Atelier Salon</h1><form method="post" action="/book/confirmed"><p>Cut &amp; finish on <time datetime="2026-10-24T14:00:00-07:00">Saturday, October 24, 2:00 PM</time></p><p id="fee-line">A cancellation fee applies to late cancellations.</p><label>Email <input type="email" name="email" value="${ALIAS}"></label><button type="submit">Confirm appointment</button></form>`,
        ),
      );
      fixture.serve(
        payAtVenue,
        htmlPage(
          'Confirm appointment',
          `<h1>Atelier Salon</h1><form method="post" action="/book/confirmed"><label>Party size <select name="party"><option selected>1</option></select></label><p>Cut &amp; finish on <time datetime="2026-10-24T14:00:00-07:00">Saturday, October 24, 2:00 PM</time></p><p>No-show fee: $25.00 if you miss your appointment.</p><p id="pay-terms">No card required — pay at the salon.</p><label>Email <input type="email" name="email" value="${ALIAS}"></label><button type="submit">Confirm appointment</button></form>`,
        ),
      );
      fixture.serve(
        salonBooked,
        htmlPage('Appointment booked', '<h1>Thank you for your booking!</h1><p>Booking reference: AS-204</p>'),
      );

      expect(await open(unreadable)).toMatchObject({ status: 'stopped', reason: 'navigated' });
      // Direct browser click stays blocked as purchase_control; purchase routes it to a screenshot-backed review card.
      expect(
        await run('still-blocked', [{ kind: 'click', ...refIn(await observePage(page), 'Confirm appointment') }]),
      ).toMatchObject({ status: 'stopped', reason: 'purchase_control' });
      expect(await purchase('Confirm appointment')).toMatchObject({
        status: 'awaiting_principal',
        card_id: expect.any(String),
        repeat_safe: false,
      });
      const [reviewCard] = await approvals();
      expect(reviewCard.question).toContain("couldn't read every detail automatically");
      expect(reviewCard.question).toContain(
        'Could not verify automatically: the fee amount, the total, the payment terms.',
      );
      expect(cards().at(-1)).toMatchObject({
        pictures: 1,
        files: [{ filename: 'checkout.png', mimeType: 'image/png' }],
      });
      // Mutating the fee line on a screenshot-reviewed checkout before approval triggers a fresh card instead of clicking.
      await page.locator('#fee-line').evaluate((node) => {
        node.textContent = 'A strict cancellation fee applies to any cancellation.';
      });
      await approve(reviewCard);
      expect(posts()).toEqual([]);
      const [revalidatedReview] = await approvals();
      expect(revalidatedReview.approval_id).not.toBe(reviewCard.approval_id);
      await approve(revalidatedReview);
      expect(posts()).toEqual([salonBooked]);
      expect(await attempts()).toMatchObject([
        { site: 'salon.example', resolution: 'committed', merchant_record_id: 'AS-204' },
      ]);

      fixture.serve(
        salonBooked,
        htmlPage('Appointment booked', '<h1>Thank you for your booking!</h1><p>Booking reference: AS-205</p>'),
      );
      expect(await open(payAtVenue)).toMatchObject({ status: 'stopped', reason: 'navigated' });
      const payAtVenueAnswer = await purchase('Confirm appointment');
      expect(payAtVenueAnswer).toEqual({
        status: 'awaiting_principal',
        card_id: expect.any(String),
        repeat_safe: false,
      });
      const [card] = await approvals();
      expect(card.question).toContain(
        'Financial commitment: conditional_fee; "No-show fee: $25.00 if you miss your appointment."',
      );
      expect(card.question).toContain('Amount due later/exposure: $25.00 total');
      expect(card.question).toContain('Payment: "No card required — pay at the salon."');

      // Mutating the payment arrangement before approval triggers a revalidation card rather than committing under changed terms.
      await page.locator('#pay-terms').evaluate((node) => {
        node.textContent = 'Card on file: Visa ending in 4242';
      });
      await approve(card);
      expect(posts()).toEqual([salonBooked]);
      const [changedCard] = await approvals();
      expect(changedCard.question).toContain('Visa ending in 4242');
      await approve(changedCard);
      expect(posts()).toEqual([salonBooked, salonBooked]);
      expect(await attempts()).toMatchObject([
        { site: 'salon.example', resolution: 'committed', merchant_record_id: 'AS-204' },
        { site: 'salon.example', resolution: 'committed', merchant_record_id: 'AS-205' },
      ]);
    });

    it('loads a hotel checkout payment-methods iframe cleanly and completes a pay-at-property booking via screenshot-backed principal approval', async () => {
      const step3 = 'https://booking.example/book.html';
      const paymentFrame = 'https://payments.booking.example/pay/methods?token=1';
      const confirmed = 'https://booking.example/book/confirmed';
      fixture.serve(paymentFrame, htmlPage('Payment methods', '<p>Pay with the property selected</p>'));
      fixture.serve(
        step3,
        htmlPage(
          'Finish booking',
          `<h1>Monty Suites Calabar</h1>
         <form method="post" action="/book/confirmed">
           <section>
             <p>Total US$86.13</p>
             <p>Includes taxes and fees</p>
             <h2>Price information</h2>
             <p>Includes $12.30 in taxes and fees</p>
             <p>Pay with the property</p>
             <p>The property will handle payment. The date they charge you will depend on your booking conditions.</p>
             <iframe id="pay-frame" src="${paymentFrame}" title="Payment options" width="320" height="80"></iframe>
           </section>
           <div style="height: 900px"></div>
           <label><input type="checkbox" id="marketing" name="marketing" checked> Send me marketing emails and deals</label>
           <button type="submit">Complete booking</button>
         </form>`,
        ),
      );
      fixture.serve(
        confirmed,
        htmlPage(
          'Booking confirmed',
          '<h1>Your booking is confirmed!</h1><p>Booking reference: BK-9021</p><p>Total: US$86.13</p>',
        ),
      );

      // Loading a GET payment-methods iframe under /pay/ does not trigger a purchase_control document refusal.
      expect(await open(step3)).toMatchObject({ status: 'stopped', reason: 'navigated' });
      await page.frameLocator('#pay-frame').locator('p').waitFor();

      // Tall checkout without contact email or "No prepayment needed": unticks marketing, captures full-page
      // screenshot, and asks the principal without false fee warnings.
      expect(await purchase('Complete booking')).toMatchObject({ status: 'awaiting_principal', repeat_safe: false });
      expect(await page.locator('#marketing').isChecked()).toBe(false);
      const [card] = await approvals();
      expect(card.question).toContain('Site: booking.example');
      expect(card.question).toContain('Button I\'ll press: "Complete booking"');
      expect(card.question).toContain('Total: $86.13 (USD)');
      expect(card.question).toContain('Payment: "Pay with the property"');
      expect(card.question).not.toContain('the fee amount');
      expect(card.question).not.toContain('Due now:');
      expect(cards().at(-1)).toMatchObject({
        pictures: 1,
        files: [{ filename: 'checkout.png', mimeType: 'image/png' }],
      });

      const jobView = await readBrowserJob(session.thread_id!);
      expect(jobView).toMatchObject({
        state: 'awaiting_principal',
        open_card: { site: 'booking.example', total: '$86.13' },
      });
      expect(jobView?.open_card?.due_now).toBeUndefined();

      await approve(card);
      expect(posts()).toEqual([confirmed]);
      expect(await attempts()).toMatchObject([
        { site: 'booking.example', resolution: 'committed', merchant_record_id: 'BK-9021' },
      ]);
      const [bookedAuthority] = await authorities();
      expect(JSON.parse(bookedAuthority.outcome_json!)).toMatchObject({ status: 'booked', order_number: 'BK-9021' });
    });

    it('fails closed on oversized or mid-capture mutated review screenshots, re-cards on ambiguous email edits, and refuses unbound guest reconciliation', async () => {
      const reviewUrl = 'https://booking.example/review-hardening';
      const confirmedUrl = 'https://booking.example/review-hardening/confirmed';
      const pendingUrl = 'https://booking.example/review-hardening/pending';
      fixture.serve(
        reviewUrl,
        htmlPage(
          'Finish booking',
          `<h1>Monty Suites Calabar</h1>
         <form method="post" action="/review-hardening/confirmed">
           <p id="total-line">Total US$86.13</p>
           <p>Pay with the property</p>
           <label>Guest email <input id="email-a" name="email" type="email" value="${ALIAS}"></label>
           <label>Receipt email <input id="email-b" name="receipt_email" type="email" value="morgan@example.test"></label>
           <button type="submit">Complete booking</button>
         </form>`,
        ),
      );
      fixture.serve(
        pendingUrl,
        htmlPage('Processing', '<h1>Working on your booking</h1><p>We will email you shortly.</p>'),
      );
      fixture.serve(
        confirmedUrl,
        htmlPage(
          'Booking confirmed',
          '<h1>Your booking is confirmed!</h1><p>Booking reference: BK-9099</p><p>Total: US$86.13</p><a href="/review-hardening">Back</a>',
        ),
      );
      expect(await open(reviewUrl)).toMatchObject({ status: 'stopped', reason: 'navigated' });

      // Finding 2: a review checkout never falls back to a viewport screenshot when full-page capture exceeds 4 MiB.
      const realScreenshot = page.screenshot.bind(page);
      const oversizedPng = Buffer.alloc(4 * 1024 * 1024 + 64);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedPng, 0);
      oversizedPng.write('IHDR', 12, 'latin1');
      oversizedPng.writeUInt32BE(800, 16);
      oversizedPng.writeUInt32BE(4000, 20);
      const oversizedSpy = vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
        if (options?.fullPage) return oversizedPng;
        return realScreenshot(options);
      });
      try {
        const oversized = await purchase('Complete booking', 'oversized-review');
        expect(oversized).toMatchObject({ status: 'facts_incomplete', repeat_safe: true });
        expect(oversizedSpy).toHaveBeenCalledTimes(1);
        expect(await approvals()).toEqual([]);
      } finally {
        oversizedSpy.mockRestore();
      }

      // Finding 3: mutating the live checkout DOM during capture fails closed instead of pairing stale facts with a new image.
      const driftSpy = vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
        const shot = await realScreenshot(options);
        await page.locator('#total-line').evaluate((node) => {
          node.textContent = 'Total US$186.13';
        });
        return shot;
      });
      try {
        const drifted = await purchase('Complete booking', 'drifted-review');
        expect(drifted).toMatchObject({ status: 'facts_incomplete', repeat_safe: true });
        expect(await approvals()).toEqual([]);
      } finally {
        driftSpy.mockRestore();
      }
      await page.locator('#total-line').evaluate((node) => {
        node.textContent = 'Total US$86.13';
      });

      // Finding 5: ambiguous email inputs are bound to the review card; editing one post-approval opens a fresh card.
      expect(await purchase('Complete booking', 'ambiguous-emails')).toMatchObject({
        status: 'awaiting_principal',
        repeat_safe: false,
      });
      const [firstCard] = await approvals();
      expect(firstCard.question).toContain('Contact emails shown: your assistant\'s email, "morgan@example.test"');
      await page.locator('#email-b').fill('other@example.test');
      await approve(firstCard);
      expect(posts()).toEqual([]);
      const [revalidatedCard] = await approvals();
      expect(revalidatedCard.approval_id).not.toBe(firstCard.approval_id);
      expect(revalidatedCard.question).toContain('The contact email changed.');
      expect(revalidatedCard.question).toContain('other@example.test');

      // Finding 4: when an unbound guest review checkout ends unconfirmed, late reconcile stays inconclusive even on a confirmation page.
      await page.locator('form').evaluate((form) => {
        form.setAttribute('action', '/review-hardening/pending');
      });
      await approve(revalidatedCard);
      expect(posts()).toEqual([pendingUrl]);
      const [unconfirmedAttempt] = await getDb().all<{ id: string; resolution: string | null }>(
        'SELECT id, resolution FROM gws_ea_browser_purchase_attempts ORDER BY attempted_at',
      );
      expect(unconfirmedAttempt.resolution).toBeNull();
      expect(await open(confirmedUrl)).toMatchObject({ status: 'stopped', reason: 'navigated' });
      const handler = getDeliveryAction('purchase')!;
      await handler(
        {
          action: 'purchase',
          requestId: 'reconcile-guest',
          operation: 'reconcile',
          attempt_id: unconfirmedAttempt.id,
          target: refIn(await observePage(page), 'Back'),
        },
        session,
      );
      await queue.idle();
      expect(await answer('reconcile-guest')).toEqual({
        status: 'inconclusive',
        attempt_id: unconfirmedAttempt.id,
        purchase_blocked: true,
        repeat_safe: true,
      });
      expect(await attempts()).toMatchObject([{ site: 'booking.example', resolution: null, merchant_record_id: null }]);
    });

    it('retires a stale approval and releases its purchase lease when replacement capture fails, and ignores pre-press confirmations on bound checkouts', async () => {
      const reviewUrl = 'https://booking.example/replacement-capture';
      fixture.serve(
        reviewUrl,
        htmlPage(
          'Finish booking',
          `<h1>Monty Suites Calabar</h1>
         <form method="post" action="/replacement-capture/confirmed">
           <p id="total-line">Total US$86.13</p>
           <p>Pay with the property</p>
           <button type="submit">Complete booking</button>
         </form>`,
        ),
      );
      expect(await open(reviewUrl)).toMatchObject({ status: 'stopped', reason: 'navigated' });
      expect(await purchase('Complete booking', 'initial-review')).toMatchObject({ status: 'awaiting_principal' });
      const [initialCard] = await approvals();

      // Mutate the checkout so approving requires a replacement card, then fail replacement screenshot capture.
      await page.locator('#total-line').evaluate((node) => {
        node.textContent = 'Total US$120.00';
      });
      const realScreenshot = page.screenshot.bind(page);
      const oversizedPng = Buffer.alloc(4 * 1024 * 1024 + 64);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedPng, 0);
      oversizedPng.write('IHDR', 12, 'latin1');
      oversizedPng.writeUInt32BE(800, 16);
      oversizedPng.writeUInt32BE(4000, 20);
      const oversizedSpy = vi.spyOn(page, 'screenshot').mockImplementation(async (options) => {
        if (options?.fullPage) return oversizedPng;
        return realScreenshot(options);
      });
      try {
        await approve(initialCard);
        expect(posts()).toEqual([]);
        expect(await approvals()).toEqual([]);
        expect(await authorities()).toMatchObject([{ state: 'revoked' }]);
        expect(await getDb().all('SELECT * FROM gws_ea_browser_pending_commits')).toEqual([]);
        expect(await getDb().all('SELECT * FROM gws_ea_browser_site_leases WHERE site = ?', 'booking.example')).toEqual(
          [],
        );
      } finally {
        oversizedSpy.mockRestore();
      }

      // Even on an email-bound generic checkout, a pre-existing confirmation reference visible before pressing cannot resolve the new attempt.
      const staleBannerUrl = 'https://pottery.example/stale-banner-checkout';
      fixture.serve(
        staleBannerUrl,
        htmlPage(
          'Checkout',
          `<div id="banner">Thank you for your previous order! Order number: OLD-1001</div>
         <form method="post" action="/stale-banner-checkout">
           <p>Your order</p>
           <p>Celadon mug × 1</p>
           <p>Visa ending in 4242</p>
           <p>Order total $42.00</p>
           <label>Email <input name="email" type="email" value="${ALIAS}"></label>
           <button type="submit">Place order</button>
         </form>`,
        ),
      );
      expect(await open(staleBannerUrl)).toMatchObject({ status: 'stopped', reason: 'navigated' });
      expect(await purchase('Place order', 'stale-banner')).toMatchObject({ status: 'awaiting_principal' });
      const [boundCard] = await approvals();
      await approve(boundCard);
      expect(posts()).toEqual([staleBannerUrl]);
      expect(await attempts()).toMatchObject([{ site: 'pottery.example', resolution: null, merchant_record_id: null }]);
    });

    describe('a guest booking that verifies the guest after Complete reservation', () => {
      const MOBILE = '+1 415 555 0134';
      const presses = async (): Promise<string | null> => page.locator('body').getAttribute('data-presses');
      const processorRequests = (): string[] =>
        fixture.requests.filter((request) => new URL(request.url).hostname === 'api.stripe.com').map(({ url }) => url);
      /** Main's disclosure of the principal's mobile number to the booking site, for this errand. */
      async function discloseMobile(): Promise<void> {
        const value = (await addPrivateValue({ label: 'Mobile', kind: 'phone', value: MOBILE })).id;
        const frame = await deliverAction(main, 'record_disclosure', {
          thread: session.thread_id,
          site: 'tablehop.example',
          value_id: value,
        });
        if (!frame.ok) throw new Error(frame.error.message);
      }
      /** The agent's click on the control named `name`, aimed from a fresh observation. */
      const click = async (name: string, id = `click-${randomUUID()}`): Promise<Record<string, unknown>> =>
        run(id, [{ kind: 'click', ...refIn(await observePage(page), name) }]);

      it('presses Complete reservation as an ordinary press, verifies the texted code and books, leaving main nothing to record', async () => {
        await discloseMobile();
        await open(GUEST_BOOKING.details);
        const pressed = await click('Complete reservation');
        expect(pressed).toMatchObject({
          status: 'stopped',
          reason: 'pressed',
          press: { site: 'tablehop.example', pressed_at: expect.stringMatching(/ Los Angeles time$/u) },
          observation: { snapshot: expect.stringContaining('Verify your phone number') },
          repeat_safe: false,
        });
        expect(await presses()).toBe('1');
        const dialog = pressed.observation as BrowserSnapshotObservation;
        expect(
          await run('send-code', [
            { kind: 'type', ...refIn(dialog, 'Phone number'), text: '(415) 555-0134' },
            { kind: 'click', ...refIn(dialog, 'Send code') },
          ]),
        ).toMatchObject({ status: 'completed' });
        const sentCode = await observePage(page);
        expect(
          await run('verify', [
            { kind: 'type', ...refIn(sentCode, 'Verification code'), text: GUEST_BOOKING.code },
            { kind: 'click', ...refIn(sentCode, 'Verify') },
          ]),
        ).toMatchObject({ status: 'stopped', reason: 'navigated' });
        expect(page.url()).toBe(GUEST_BOOKING.confirmed);
        // The site's own booking POST, on a purchase route, went through from inside the dialog the free press opened.
        expect(posts()).toEqual([GUEST_BOOKING.sendCode, GUEST_BOOKING.verify, GUEST_BOOKING.book]);
        expect(fixture.requests.find((request) => request.url === GUEST_BOOKING.sendCode)?.body).toBe('(415) 555-0134');
        expect(await approvals()).toEqual([]);
        expect(await attempts()).toEqual([]);
        expect(await blocks()).toEqual([]);
        expect(await unconfirmedNotes()).toEqual([]);
        expect((await readBrowserJob(session.thread_id!))?.unconfirmed).toBeUndefined();
      });

      it('answers already_pressed for a repeat press of the same booking in the errand, without pressing it again', async () => {
        await open(GUEST_BOOKING.details);
        const first = await click('Complete reservation');
        expect(first).toMatchObject({ status: 'stopped', reason: 'pressed' });
        const { pressed_at } = first.press as { pressed_at: string };
        expect(await click('Complete reservation')).toMatchObject({
          status: 'stopped',
          reason: 'already_pressed',
          press: { site: 'tablehop.example', pressed_at },
        });
        expect(await presses()).toBe('1');
      });

      it('records no press and leaves a region watch unspent when a cover kept the free press from reaching the page', async () => {
        await open(GUEST_BOOKING.details);
        const at = new Date().toISOString();
        // A watch for the very table the page offers, its venue as the generic reader takes it from the heading.
        const bounds = {
          kind: 'region',
          site: 'tablehop.example',
          venue: { id: 'tablehop', name: 'Complete your reservation' },
          partySize: 2,
          windows: [{ start: '2026-11-10T02:00:00.000Z', end: '2026-11-10T04:00:00.000Z' }],
          financial: { freeOnly: true, currency: 'USD', maxTotalMinor: 0, maxDueNowMinor: 0 },
          until: '2099-01-01T00:00:00.000Z',
        };
        await getDb().run(
          `INSERT INTO gws_ea_browser_watches(id,job_id,site,address,bounds_json,region_json,region_baseline,region_marked_at,status,created_at,updated_at,next_check_at)
         VALUES('hale-tables',?,'tablehop.example',?,?,'{}','No tables',?,'armed',?,?,?)`,
          session.thread_id,
          GUEST_BOOKING.details,
          JSON.stringify(bounds),
          at,
          at,
          at,
          at,
        );
        await getDb().run(
          "INSERT INTO gws_ea_browser_watch_job_claims(job_id,state) VALUES(?,'available')",
          session.thread_id,
        );
        const watch = () =>
          Promise.all([
            getDb().get('SELECT status FROM gws_ea_browser_watches WHERE id = ?', 'hale-tables'),
            getDb().get('SELECT state FROM gws_ea_browser_watch_job_claims WHERE job_id = ?', session.thread_id),
          ]);
        await page.evaluate(
          `document.body.insertAdjacentHTML('beforeend', '<div id="cookie-cover" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.4)"></div>')`,
        );
        expect(await click('Complete reservation')).toMatchObject({ status: 'stopped', reason: 'not_actionable' });
        expect(await presses()).toBe('0');
        expect(await watch()).toEqual([{ status: 'armed' }, { state: 'available' }]);
        await page.evaluate(`document.getElementById('cookie-cover').remove()`);
        expect(await click('Complete reservation')).toMatchObject({ status: 'stopped', reason: 'pressed' });
        expect(await presses()).toBe('1');
        // The press that reached the page spends the job's one booking and ends the watch.
        expect(await watch()).toEqual([{ status: 'outcome_unknown' }, { state: 'unknown' }]);
      });

      describe('the dialog a free press opened', () => {
        /** The agent's verification inside the dialog: its code, then Verify, whose success books the table. */
        async function verify(): Promise<Record<string, unknown>> {
          const dialog = await observePage(page);
          return run('verify', [
            { kind: 'type', ...refIn(dialog, 'Verification code'), text: GUEST_BOOKING.code },
            { kind: 'click', ...refIn(dialog, 'Verify') },
          ]);
        }
        const inProgress = () => freePressInProgress(session.thread_id!);
        /** The free press of Complete reservation, once its own window, which admits its routes, has closed. */
        async function pressComplete(): Promise<void> {
          await open(GUEST_BOOKING.details);
          expect(await click('Complete reservation')).toMatchObject({ reason: 'pressed' });
          await (await ensureBrowserNavigationGuard(page)).actionsSettled();
        }

        it('keeps admitting the checkout’s booking route across a same-document route change', async () => {
          await pressComplete();
          expect(inProgress()).toBe(true);
          await page.evaluate(`history.pushState({}, '', '/booking/details/verify')`);
          await verify();
          expect(posts()).toEqual([GUEST_BOOKING.verify, GUEST_BOOKING.book]);
          // The booking's confirmation is a new document, which ends the dialog.
          await expect.poll(inProgress).toBe(false);
        });

        it('ends at a new main document, refusing the checkout’s booking route from there', async () => {
          const hold = 'https://tablehop.example/booking/hold';
          fixture.serve(
            hold,
            htmlPage(
              'Hold your table',
              '<button type="button" id="hold">Hold my table</button>',
              `document.getElementById('hold').addEventListener('click', () =>
  fetch('/api/confirmbooking', { method: 'POST', body: 'party=2' }).catch(() => undefined));`,
            ),
          );
          await pressComplete();
          await open(hold);
          await expect.poll(inProgress).toBe(false);
          expect(await click('Hold my table')).toMatchObject({ status: 'completed' });
          expect(posts()).toEqual([]);
        });

        it('ends once its time has passed, refusing the booking route a verification inside it sends', async () => {
          await pressComplete();
          // Past the dialog's fifteen minutes, with the host's clock running on from there.
          vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
          try {
            vi.setSystemTime(Date.now() + 16 * 60_000);
            expect(inProgress()).toBe(false);
            expect(await verify()).toMatchObject({ status: 'completed' });
          } finally {
            vi.useRealTimers();
          }
          expect(posts()).toEqual([GUEST_BOOKING.verify]);
        });
      });

      it('refuses a payment processor request from a press inside the dialog, while the site’s own requests go', async () => {
        fixture.serve(GUEST_BOOKING.details, guestBookingPage({ sendAlsoPosts: PROCESSOR.confirm }));
        await open(GUEST_BOOKING.details);
        expect(await click('Complete reservation')).toMatchObject({ reason: 'pressed' });
        expect(await click('Send code')).toMatchObject({ status: 'completed' });
        expect(posts()).toEqual([GUEST_BOOKING.sendCode]);
        expect(processorRequests()).toEqual([]);
      });

      it('stops with purchase_control at a dialog that saves a card for a no-show fee, sending nothing to the processor', async () => {
        fixture.serve(GUEST_BOOKING.details, guestBookingPage({ dialog: 'card' }));
        await open(GUEST_BOOKING.details);
        expect(await click('Complete reservation')).toMatchObject({ reason: 'pressed' });
        expect(await click('Confirm reservation')).toMatchObject({ status: 'stopped', reason: 'purchase_control' });
        expect(processorRequests()).toEqual([]);
        expect(posts()).toEqual([]);
      });

      it('stops a free booking at an agreement only the principal can grant, pressing nothing', async () => {
        fixture.serve(
          GUEST_BOOKING.details,
          guestBookingPage({
            inForm: '<label><input type="checkbox" name="marketing" required> I agree to receive marketing</label>',
          }),
        );
        await open(GUEST_BOOKING.details);
        expect(await click('Complete reservation')).toMatchObject({ status: 'stopped', reason: 'consent_required' });
        expect(await presses()).toBe('0');
      });

      it('presses a free booking while an earlier paid attempt on the merchant is unresolved, and names that attempt', async () => {
        await open(GUEST_BOOKING.details);
        const at = new Date().toISOString();
        const facts = JSON.stringify({
          site: 'tablehop.example',
          totalMinor: 2000,
          dueNowMinor: 2000,
          currency: 'USD',
        });
        await getDb().run(
          `INSERT INTO gws_ea_browser_authorities (id,job_id,kind,state,facts_json,bounds_json,exception_ids_json,attempt_id,expires_at,created_at)
         VALUES('authority-deposit',?,'checkout','unknown',?,'{}','[]','attempt-deposit',?,?)`,
          session.thread_id,
          facts,
          at,
          at,
        );
        await getDb().run(
          `INSERT INTO gws_ea_browser_purchase_attempts(id,authority_id,job_id,site,facts_json,attempted_at,unconfirmed_at)
         VALUES('attempt-deposit','authority-deposit',?,'tablehop.example',?,?,?)`,
          session.thread_id,
          facts,
          at,
          at,
        );
        await getDb().run(
          'INSERT INTO gws_ea_browser_purchase_blocks(site,created_at) VALUES(?,?)',
          'tablehop.example',
          at,
        );
        expect(await click('Complete reservation')).toMatchObject({
          status: 'stopped',
          reason: 'pressed',
          press: { site: 'tablehop.example', unresolved_attempts: ['attempt-deposit'] },
        });
        expect(await presses()).toBe('1');
      });

      it('still answers purchase_control for a commit on a checkout with a total and a saved payment method', async () => {
        await open(GENERIC.review);
        expect(await click('Place order')).toMatchObject({ status: 'stopped', reason: 'purchase_control' });
        expect(posts()).toEqual([]);
      });

      it('runs a press after an approved paid press as an ordinary action, refusing the checkout’s purchase route', async () => {
        const deposit = 'https://tablehop.example/booking/deposit';
        fixture.serve(
          deposit,
          checkoutPage({
            action: '/booking/deposit/paid',
            commit: 'Pay deposit',
            items: ['Gift card × 1'],
            total: '$20.00',
            payment: 'Visa ending in 4242',
            email: ALIAS,
            outside: `<div id="after" hidden><button type="button" id="hold-table">Hold my table</button></div><script>
document.getElementById('checkout').addEventListener('submit', (event) => { event.preventDefault(); document.getElementById('after').hidden = false; });
document.getElementById('hold-table').addEventListener('click', () => fetch('/api/confirmbooking', { method: 'POST', body: 'party=2' }).catch(() => undefined));
</script>`,
          }),
        );
        await open(deposit);
        expect(await purchase('Pay deposit')).toMatchObject({ status: 'awaiting_principal' });
        await approve((await approvals())[0]);
        expect(page.url()).toBe(deposit);
        expect(await click('Hold my table')).toMatchObject({ status: 'completed' });
        expect(posts()).toEqual([]);
      });
    });
  },
);
