import { EventEmitter } from 'node:events';
import type { Frame, Page, Response } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resyReservationSignature } from './resy-signature.js';
import { ensureBrowserNavigationGuard } from './commit-classifier.js';

const TOKEN = 'opaque-native-slot-token';
function availability(): Record<string, unknown> {
  return {
    query: { day: '2026-10-17', party_size: 2 },
    results: {
      venues: [
        {
          venue: {
            id: { resy: 25973 },
            name: "L'Artusi",
            currency: { code: 'USD' },
            location: { time_zone: 'EST5EDT' },
          },
          slots: [
            {
              config: { id: 1442725, token: TOKEN, type: 'Bar Counter' },
              date: { start: '2026-10-17 11:00:00', end: '2026-10-17 12:00:00' },
              size: { min: 2, max: 2 },
              template: { id: 3996233 },
              time: { turn: { actual: 3600, estimated: 3600 } },
              payment: { is_paid: true, cancellation_fee: 25, deposit_fee: null, is_add_on_required: false },
              has_add_ons: false,
            },
          ],
        },
      ],
    },
  };
}
function fixturePage(origin = 'https://resy.com'): {
  page: Page;
  emit: (path: string, data: unknown, body?: unknown, method?: string, readBody?: () => Promise<Buffer>) => void;
  navigate: () => void;
} {
  const events = new EventEmitter();
  const frame = { url: () => `${origin}/cities/new-york-ny/venues/lartusi-ny`, isDetached: () => false } as Frame;
  const page = Object.assign(events, {
    url: frame.url,
    mainFrame: () => frame,
    frames: () => [frame],
    isClosed: () => false,
  }) as unknown as Page;
  return {
    page,
    navigate() {
      events.emit('request', { url: frame.url, isNavigationRequest: () => true, frame: () => frame });
      events.emit('framenavigated', frame);
    },
    emit(path, data, body = { venue_id: 25973, day: '2026-10-17', party_size: 2 }, method = 'POST', readBody) {
      const raw = Buffer.from(JSON.stringify(data));
      const request = {
        method: () => method,
        url: () => `https://api.resy.com${path}`,
        frame: () => frame,
        isNavigationRequest: () => false,
        postData: () => JSON.stringify(body),
        postDataJSON: () => body,
      };
      const response = {
        url: () => `https://api.resy.com${path}`,
        status: () => 200,
        request: () => request,
        frame: () => frame,
        headers: () => ({ 'content-type': 'application/json', 'content-length': String(raw.length) }),
        body: readBody ?? (async () => raw),
        json: async () => data,
      } as unknown as Response;
      events.emit('request', request);
      events.emit('response', response);
    },
  };
}

afterEach(() => vi.useRealTimers());
describe('reviewed Resy native inventory', () => {
  it('reads explicit native slot interval and identity without exposing inventory tokens', async () => {
    const { page, emit } = fixturePage();
    await resyReservationSignature.preparePage?.(page);
    emit('/4/find', availability());
    const answer = await resyReservationSignature.readAvailability?.(page, { venueId: '25973', partySize: 2 });
    expect(answer).toMatchObject({
      status: 'ready',
      site: 'resy.com',
      venue: { id: '25973', name: "L'Artusi" },
      partySize: 2,
      currency: 'USD',
      timeZone: 'America/New_York',
      slots: [
        {
          reservation: {
            venueId: '25973',
            venueName: "L'Artusi",
            partySize: 2,
            at: '2026-10-17T15:00:00.000Z',
            endAt: '2026-10-17T16:00:00.000Z',
            timeZone: 'America/New_York',
          },
        },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    if (answer?.status === 'ready') expect(answer.slots[0].id).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('does not substitute an assumed interval when the native end is missing', async () => {
    const { page, emit } = fixturePage();
    const raw = availability();
    const data = JSON.parse(JSON.stringify(raw), (key: string, value: unknown) =>
      key === 'end' ? undefined : value,
    ) as unknown;
    await resyReservationSignature.preparePage?.(page);
    emit('/4/find', data);
    const result = await resyReservationSignature.readAvailability?.(page, { venueId: '25973', partySize: 2 });
    expect(result).toMatchObject({ status: 'unavailable' });
  });
  it('rejects foreign frames, changed party sizes and stale inventory', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const origin of ['https://attacker.example', 'https://resy.com']) {
      const { page, emit } = fixturePage(origin);
      await resyReservationSignature.preparePage?.(page);
      emit('/4/find', availability());
      expect(await resyReservationSignature.readAvailability?.(page, { venueId: '25973', partySize: 2 })).toMatchObject(
        { status: origin === 'https://resy.com' ? 'ready' : 'unavailable' },
      );
      expect(await resyReservationSignature.readAvailability?.(page, { venueId: '25973', partySize: 3 })).toMatchObject(
        { status: 'unavailable' },
      );
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect(await resyReservationSignature.readAvailability?.(page, { venueId: '25973', partySize: 2 })).toMatchObject(
        { status: 'unavailable' },
      );
    }
  });
  it('invalidates a previous valid response when the next native response is malformed', async () => {
    const { page, emit } = fixturePage();
    await resyReservationSignature.preparePage?.(page);
    emit('/4/find', availability());
    expect(await resyReservationSignature.readAvailability?.(page, { venueId: '25973', partySize: 2 })).toMatchObject({
      status: 'ready',
    });
    emit('/4/find', { results: {} });
    expect(await resyReservationSignature.readAvailability?.(page, { venueId: '25973', partySize: 2 })).toMatchObject({
      status: 'unavailable',
    });
  });
  it('invalidates native facts when a new document navigates to the same URL', async () => {
    const { page, emit, navigate } = fixturePage();
    await resyReservationSignature.preparePage?.(page);
    emit('/4/find', availability());
    expect(await resyReservationSignature.readAvailability?.(page, { venueId: '25973', partySize: 2 })).toMatchObject({
      status: 'ready',
    });
    navigate();
    expect(await resyReservationSignature.readAvailability?.(page, { venueId: '25973', partySize: 2 })).toMatchObject({
      status: 'unavailable',
    });
  });
  it('bounds a native response body that never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { page, emit } = fixturePage();
    await resyReservationSignature.preparePage?.(page);
    emit('/4/find', availability(), undefined, undefined, () => new Promise<Buffer>(() => undefined));
    let completed = false;
    const reading = resyReservationSignature
      .readAvailability?.(page, { venueId: '25973', partySize: 2 })
      .then((result) => {
        completed = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(6000);
    expect(completed).toBe(true);
    expect(await reading).toMatchObject({ status: 'unavailable' });
  });
});

describe('Resy route boundary', () => {
  it('does not treat booking or account changes as research navigation', () => {
    expect(resyReservationSignature.classifyNavigation(new URL('https://api.resy.com/3/book'))).toBe(
      'purchase_control',
    );
    expect(resyReservationSignature.classifyNavigation(new URL('https://widgets.resy.com/#/add-payment'))).toBe(
      'account_security',
    );
    expect(
      resyReservationSignature.classifyNavigation(new URL('https://resy.com/cities/new-york-ny/venues/lartusi-ny')),
    ).toBe('ordinary');
    expect(resyReservationSignature.classifyNavigation(new URL('https://resy.com/unknown-submit'))).toBe(
      'unsupported_merchant',
    );
  });
});

import { resyFixture, type ResyFixtureState } from './resy-native-fixture.js';
import { redactPageText } from './observe.js';
const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
function checkoutFixture(policy: string[] = []): ResyFixtureState {
  const inv = availability();
  const fee = policy.length ? 25 : null;
  const slot = (inv.results as { venues: Array<{ slots: Array<{ payment: Record<string, unknown> }> }> }).venues[0]
    .slots[0];
  slot.payment.cancellation_fee = fee;
  return {
    inventory: inv,
    policy,
    details: {
      venue: { id: 25973 },
      user: { id: 72, payment_methods: [{ id: 101, display: '4242' }] },
      config: { double_confirmation: false, add_ons: [] },
      payment: { amounts: { total: 0, items: [] } },
      cancellation: { fee: fee === null ? null : { amount: fee }, display: { policy } },
      book_token: { value: 'secret-book-token' },
    },
  };
}
async function loadFixture(state: ResyFixtureState): Promise<Awaited<ReturnType<typeof resyFixture>>> {
  if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the owned TLS fixture');
  const fixture = await resyFixture(chromePath, state);
  await resyReservationSignature.preparePage?.(fixture.page);
  await fixture.page.goto('https://resy.com/reservation-details');
  await fixture.page.locator('body[data-ready="yes"]').waitFor();
  return fixture;
}
// Each test generates a TLS key and launches a real Chrome, like the other native suites' 30-second budget.
describe.skipIf(!chromePath)('source-backed Resy checkout in owned native Chrome', { timeout: 30_000 }, () => {
  it('settles fresh checkout captures after a second guarded navigation to the same document', async () => {
    const fixture = await loadFixture(checkoutFixture());
    try {
      expect((await resyReservationSignature.readPurchase(fixture.page)).status).toBe('ready');
      const guard = await ensureBrowserNavigationGuard(fixture.page);
      await guard.runWithPolicy({ classify: () => 'ordinary' }, async () => {
        await fixture.page.goto('https://resy.com/reservation-details');
        await fixture.page.locator('body[data-ready="yes"]').waitFor();
        expect((await resyReservationSignature.readPurchase(fixture.page)).status).toBe('ready');
      });
    } finally {
      await fixture.close();
    }
  });
  it('reads explicit free facts and binds native commit result to the exact book token/card', async () => {
    const fixture = await loadFixture(checkoutFixture());
    try {
      const checkout = await resyReservationSignature.readPurchase(fixture.page);
      expect(checkout.status).toBe('ready');
      if (checkout.status !== 'ready') throw new Error(checkout.status);
      expect(checkout.facts).toMatchObject({
        totalMinor: 0,
        dueNowMinor: 0,
        commitments: [],
        cardEnding: null,
        noCommitmentTerms: expect.any(String),
        account: 'resy:72',
        reservation: { partySize: 2, venueId: '25973' },
      });
      expect(JSON.stringify(checkout.facts)).not.toContain('secret-book-token');
      const waiting = resyReservationSignature.waitForResult(fixture.page, 3000);
      await checkout.element.click();
      await waiting;
      // A full confirmation navigation cannot erase the already bound native receipt.
      await fixture.page.goto('https://resy.com/confirmation');
      await fixture.page.locator('body[data-ready="yes"]').waitFor();
      expect(fixture.submitted()).toBe(1);
      expect(await resyReservationSignature.readEvidence(fixture.page)).toMatchObject({
        resolution: 'committed',
        recordId: '90123',
        account: 'resy:72',
        source: 'https://api.resy.com/3/book',
        checkoutReference: checkout.facts.checkoutReference,
      });
      expect(redactPageText(fixture.page, 'secret-reservation-bearer')).toBe('[redacted]');
      // Reading a new checkout cannot reuse the previous commit's expected binding.
      await resyReservationSignature.readPurchase(fixture.page);
      expect(await resyReservationSignature.readEvidence(fixture.page)).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
  it('reads a complete per-person policy and multiplies maximum exposure once', async () => {
    const fixture = await loadFixture(
      checkoutFixture(['We have a 24-hour cancellation/no-show policy of $25 per person for guests booking with us.']),
    );
    try {
      const checkout = await resyReservationSignature.readPurchase(fixture.page);
      expect(checkout).toMatchObject({
        status: 'ready',
        facts: {
          totalMinor: 5000,
          dueNowMinor: 0,
          cardEnding: '4242',
          commitments: [{ amountMinor: 2500, perPerson: true, cancellationDeadline: '2026-10-16T15:00:00.000Z' }],
        },
      });
      expect(await resyReservationSignature.readReservationPolicy?.(fixture.page, '25973')).toMatchObject({
        commitments: [{ amountMinor: 2500, perPerson: true, cancellationBeforeMs: 86_400_000 }],
      });
    } finally {
      await fixture.close();
    }
  });
  it('uses the published upper-bound fee grammar and refuses a calendar-day cutoff variant', async () => {
    const state = checkoutFixture([
      'A cancellation fee of up to $50 per person may be charged for no-shows or cancellations made within 24 hours of the reservation time.',
    ]);
    const slot = (state.inventory.results as { venues: Array<{ slots: Array<{ payment: Record<string, unknown> }> }> })
      .venues[0].slots[0];
    slot.payment.cancellation_fee = 50;
    (state.details.cancellation as { fee: { amount: number } }).fee.amount = 50;
    const fixture = await loadFixture(state);
    try {
      expect(await resyReservationSignature.readPurchase(fixture.page)).toMatchObject({
        status: 'ready',
        facts: { totalMinor: 10_000, commitments: [{ amountMinor: 5000, perPerson: true }] },
      });
      slot.payment.secs_cancel_cut_off = 86400;
      slot.payment.time_cancel_cut_off = '17:00:00';
      await fixture.page.reload();
      await fixture.page.locator('body[data-ready="yes"]').waitFor();
      expect(await resyReservationSignature.readPurchase(fixture.page)).toMatchObject({ status: 'terms_unavailable' });
      expect(fixture.submitted()).toBe(0);
    } finally {
      await fixture.close();
    }
  });
  it('binds the actual native commit node even when page code overrides matches', async () => {
    const fixture = await loadFixture(checkoutFixture());
    try {
      const unknown = await fixture.page.locator('#unknown').elementHandle();
      if (!unknown) throw new Error('Fixture control missing');
      await unknown.evaluate((node) => {
        node.textContent = 'Reserve Now';
        node.matches = () => true;
      });
      expect(await resyReservationSignature.readPurchase(fixture.page, unknown)).toMatchObject({
        status: 'unsupported_merchant',
      });
      expect(fixture.submitted()).toBe(0);
    } finally {
      await fixture.close();
    }
  });
  it.each([
    'double-confirm',
    'missing-total',
    'unknown-policy',
    'party-drift',
    'time-drift',
    'hidden-deposit',
    'structured-hold',
  ])('refuses %s before a native commit', async (scenario) => {
    const state = checkoutFixture();
    if (scenario === 'double-confirm')
      (state.details.config as Record<string, unknown>).double_confirmation = ['A further confirmation is needed'];
    if (scenario === 'missing-total')
      delete (state.details.payment as { amounts: Record<string, unknown> }).amounts.total;
    if (scenario === 'unknown-policy') {
      state.policy.push('Your card will be charged a monthly membership fee.');
      (state.details.cancellation as { display: { policy: string[] } }).display.policy = state.policy;
    }
    if (scenario === 'party-drift') state.partyLabel = '4 Guests, Bar Counter';
    if (scenario === 'time-drift') state.dateLabel = 'Sat, Oct 17, 2026 1:00 PM';
    if (scenario === 'hidden-deposit') state.extraTerms = '<p>A $100 deposit will be charged later.</p>';
    if (scenario === 'structured-hold') (state.details.payment as Record<string, unknown>).hold_amount = 100;
    const fixture = await loadFixture(state);
    try {
      expect(await resyReservationSignature.readPurchase(fixture.page)).toMatchObject({
        status: 'terms_unavailable',
      });
      expect(fixture.submitted()).toBe(0);
    } finally {
      await fixture.close();
    }
  });
  it('does not accept a different book token as the approved result', async () => {
    const state = checkoutFixture();
    state.bookToken = 'different-book-token';
    const fixture = await loadFixture(state);
    try {
      const checkout = await resyReservationSignature.readPurchase(fixture.page);
      if (checkout.status !== 'ready') throw new Error(checkout.status);
      const result = expect(resyReservationSignature.waitForResult(fixture.page, 250)).rejects.toThrow(
        'result is unavailable',
      );
      await checkout.element.click();
      await result;
      expect(await resyReservationSignature.readEvidence(fixture.page)).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
