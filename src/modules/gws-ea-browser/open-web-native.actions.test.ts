import fs from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { root } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: join(tmpdir(), 'nanoclaw-open-web-actions-tests') };
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
import type { Page } from 'playwright-core';
import type { SqliteDriver } from '../../db/drivers/sqlite.js';
import { getDb } from '../../db/index.js';
import type { Session } from '../../types.js';
import { readCheckoutRegion } from './control-facts.js';
import { activateControl, ensureBrowserNavigationGuard, withBrowserJobNavigation } from './commit-classifier.js';
import { BrowserDiagnosticAttempt } from './diagnostics.js';
import * as actionTargets from './action-targets.js';
import * as nativeControlFacts from './control-facts.js';
import { executeBrowserBatch } from './executor.js';
import type { BrowserAction, BrowserExecutionContext, BrowserWatchExecutionContext } from './actions.js';
import { OPEN_WEB, PROCESSOR, htmlPage, orderConfirmationPage, refIn } from './open-web-native-fixture.js';
import { observePage, type BrowserSnapshotObservation } from './observe.js';
import { registerPageSecret, releasePageSecret } from './page-privacy.js';
import { executeRecipe, saveBrowserRecipe } from './recipes.js';
import {
  ALIAS,
  errandRequest,
  jobContext,
  jobDb,
  startErrandHost,
  stopErrandHost,
  withElement,
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

describe.skipIf(!chromePath)('ordinary actions in native Chrome', { timeout: 60_000 }, () => {
  let db: SqliteDriver;
  let pages: Page[];

  beforeEach(async () => {
    pages = [];
    db = await jobDb('job-a', 'job-b');
  });
  afterEach(async () => {
    for (const page of pages) await page.context().close();
    await db?.close();
  });

  const open = async (): Promise<Page> => {
    const page = await fixture.newPage();
    pages.push(page);
    return page;
  };
  const context = (page: Page, job = 'job-a'): BrowserExecutionContext => jobContext(db, page, job);
  const batch = (page: Page, actions: BrowserAction[], job = 'job-a'): Promise<Record<string, unknown>> =>
    executeBrowserBatch(context(page, job), { actions }, { record: false });
  const go = (page: Page, url: string, job = 'job-a'): Promise<Record<string, unknown>> =>
    batch(page, [{ kind: 'navigate', url }], job);
  /** A click on each named control, in one batch, aimed from one fresh observation. */
  const click = async (page: Page, ...names: string[]): Promise<Record<string, unknown>> => {
    const observation = await observePage(page);
    return batch(
      page,
      names.map((name) => ({ kind: 'click', ...refIn(observation, name) })),
    );
  };
  const posts = (): string[] =>
    fixture.requests.filter((request) => request.method !== 'GET').map((request) => request.url);

  it('leaves a secret-query page even when its recording checkpoint is unavailable', async () => {
    const page = await open();
    await page.goto(`${OPEN_WEB.article}?token=fixture-private-bearer`);
    expect((await observePage(page)).url).toBe('[redacted URL]');
    const result = await executeBrowserBatch(context(page), { actions: [{ kind: 'navigate', url: OPEN_WEB.faq }] });
    expect(result).toMatchObject({
      reason: 'navigated',
      actions: [{ status: 'completed' }],
      recording: { status: 'unavailable' },
    });
    expect(page.url()).toBe(OPEN_WEB.faq);
    expect(JSON.stringify(result)).not.toContain('fixture-private-bearer');
    const traces = await db.all('SELECT step_json FROM gws_ea_browser_action_trace');
    expect(JSON.stringify(traces)).not.toContain('fixture-private-bearer');
    expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
    expect(await page.locator('#times').isVisible()).toBe(true);
  });

  it.each([403, 200])(
    'reports a fixture HTTP %i denial ahead of the navigation boundary, then permits another action',
    async (status) => {
      const denied = 'https://news.example/denied';
      fixture.serve(denied, () => ({
        status,
        body: htmlPage('Denied', '<h1>Access Denied</h1><p>Request refused.</p>'),
      }));
      const page = await open();
      const diagnostic = new BrowserDiagnosticAttempt({ jobId: 'job-a', requestId: 'denial', action: 'browser' });
      diagnostic.observe(page);
      expect(await go(page, denied)).toMatchObject({
        reason: 'challenge',
        actions: [{ status: 'completed' }],
        observation: { url: denied, snapshot: expect.stringContaining('Access Denied') },
      });
      expect(diagnostic.finish().events).toContainEqual(
        expect.objectContaining({ source: 'http_response', status, resource: 'document', action_index: 0 }),
      );
      expect(page.url()).toBe(denied);
      expect(await go(page, OPEN_WEB.faq)).toMatchObject({ reason: 'navigated', actions: [{ status: 'completed' }] });
      expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
      expect(await page.locator('#times').isVisible()).toBe(true);
    },
  );

  it('reports a host-blocked destination without borrowing the previous page response', async () => {
    const page = await open();
    await go(page, OPEN_WEB.faq);
    const diagnostic = new BrowserDiagnosticAttempt({ jobId: 'job-a', requestId: 'blocked', action: 'browser' });
    diagnostic.observe(page);
    const result = await go(page, 'file:///private-fixture');
    expect(result).toMatchObject({ reason: 'blocked_address', observation: { url: OPEN_WEB.faq } });
    const events = diagnostic.finish().events;
    expect(events).toContainEqual(
      expect.objectContaining({
        source: 'host_refusal',
        category: 'address',
        rule: 'blocked_address',
        action_index: 0,
      }),
    );
    expect(events.some((event) => event.source === 'http_response')).toBe(false);
    expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
  });

  it('reports a failed transport without inventing an HTTP response and permits a later navigation', async () => {
    const page = await open();
    await page.route('https://news.example/transport-failure', (route) => route.abort('namenotresolved'));
    const diagnostic = new BrowserDiagnosticAttempt({ jobId: 'job-a', requestId: 'transport', action: 'browser' });
    diagnostic.observe(page);
    expect(await go(page, 'https://news.example/transport-failure')).toMatchObject({ reason: 'navigation_failed' });
    const events = diagnostic.finish().events;
    expect(events).toContainEqual(
      expect.objectContaining({ source: 'transport_failure', category: 'dns', action_index: 0 }),
    );
    expect(events.some((event) => event.source === 'http_response')).toBe(false);
    expect(await go(page, OPEN_WEB.faq)).toMatchObject({ reason: 'navigated' });
    expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
  });

  it.each(['reservation', 'preparation', 'completion'] as const)(
    'runs an action once when recording %s fails',
    async (phase) => {
      const url = 'https://news.example/recording-failure';
      fixture.serve(
        url,
        htmlPage(
          'Details',
          '<h1>Details</h1><button type="button" onclick="window.presses=(window.presses||0)+1">Show details</button>',
        ),
      );
      const page = await open();
      await go(page, url);
      const target = refIn(await observePage(page), 'Show details');
      const get = db.get.bind(db);
      const reservation = vi.spyOn(db, 'get').mockImplementation(async (sql, ...parameters) => {
        if (phase === 'reservation' && sql.startsWith('INSERT INTO gws_ea_browser_action_trace'))
          throw new Error('private-storage-sentinel');
        return get(sql, ...parameters);
      });
      const run = db.run.bind(db);
      const storage = vi.spyOn(db, 'run').mockImplementation(async (sql, ...parameters) => {
        if (phase === 'completion' && sql.startsWith('UPDATE gws_ea_browser_action_trace'))
          throw new Error('private-storage-sentinel');
        return run(sql, ...parameters);
      });
      const preparation =
        phase === 'preparation'
          ? vi.spyOn(actionTargets, 'prepareBrowserActionFacts').mockImplementation(() => {
              throw new TypeError('private-preparation-sentinel');
            })
          : undefined;
      try {
        const result = await executeBrowserBatch(context(page), { actions: [{ kind: 'click', ...target }] });
        expect(result).toMatchObject({
          status: 'completed',
          actions: [{ status: 'completed' }],
          recording: { status: 'unavailable' },
        });
        expect(await page.evaluate('window.presses')).toBe(1);
        expect(JSON.stringify(result)).not.toContain('sentinel');
        const rows = await db.all<{ step_json: string }>('SELECT step_json FROM gws_ea_browser_action_trace');
        expect(rows).toHaveLength(phase === 'reservation' ? 0 : 1);
        for (const row of rows) expect(JSON.parse(row.step_json)).toMatchObject({ saveError: 'Recording incomplete.' });
        expect((result.actions as Array<{ trace_index?: number }>)[0].trace_index).toBe(
          phase === 'reservation' ? undefined : 0,
        );
      } finally {
        storage.mockRestore();
        reservation.mockRestore();
        preparation?.mockRestore();
      }
      expect(await click(page, 'Show details')).toMatchObject({ status: 'completed' });
      expect(await page.evaluate('window.presses')).toBe(2);
    },
  );

  it('records existing native control facts without another control inspection or snapshot generation', async () => {
    const page = await open();
    await go(page, OPEN_WEB.faq);
    const before = await observePage(page);
    const read = vi.spyOn(nativeControlFacts, 'readPageControlFacts');
    try {
      const result = await executeBrowserBatch(context(page), {
        actions: [{ kind: 'click', ...refIn(before, 'Show delivery times') }],
      });
      expect(result).toMatchObject({
        status: 'completed',
        recording: { status: 'complete' },
        observation: { generation: before.generation + 1 },
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(await page.locator('#times').isVisible()).toBe(true);
    } finally {
      read.mockRestore();
    }
  });

  it.each(['reservation', 'completion'] as const)(
    'answers a completed action before a stalled recording %s finishes',
    async (phase) => {
      const page = await open();
      await go(page, OPEN_WEB.faq);
      const target = refIn(await observePage(page), 'Show delivery times');
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending: Promise<unknown>[] = [];
      const get = db.get.bind(db);
      const reservation = vi.spyOn(db, 'get').mockImplementation((sql, ...parameters) => {
        if (phase === 'reservation' && sql.startsWith('INSERT INTO gws_ea_browser_action_trace')) {
          const work = held.then(() => get(sql, ...parameters));
          pending.push(work);
          return work;
        }
        return get(sql, ...parameters);
      });
      const run = db.run.bind(db);
      const storage = vi.spyOn(db, 'run').mockImplementation((sql, ...parameters) => {
        if (phase === 'completion' && sql.startsWith('UPDATE gws_ea_browser_action_trace')) {
          const work = held.then(() => run(sql, ...parameters));
          pending.push(work);
          return work;
        }
        return run(sql, ...parameters);
      });
      try {
        const result = await executeBrowserBatch(context(page), { actions: [{ kind: 'click', ...target }] });
        expect(result).toMatchObject({
          status: 'completed',
          recording: { status: 'unavailable' },
          actions: [{ status: 'completed' }],
        });
        expect(await page.locator('#times').isVisible()).toBe(true);
        expect((result.actions as Array<{ trace_index?: number }>)[0].trace_index).toBe(
          phase === 'reservation' ? undefined : 0,
        );
      } finally {
        release?.();
        await Promise.all(pending);
        storage.mockRestore();
        reservation.mockRestore();
      }
      const rows = await db.all<{ step_json: string }>('SELECT step_json FROM gws_ea_browser_action_trace');
      expect(rows).toHaveLength(1);
      if (phase === 'reservation')
        expect(JSON.parse(rows[0].step_json)).toMatchObject({ saveError: 'Recording incomplete.' });
    },
  );

  it('runs a script button, a box, a radio choice and a select as real actions', async () => {
    const page = await open();
    expect(await go(page, OPEN_WEB.faq)).toMatchObject({ status: 'stopped', reason: 'navigated' });
    const observation = await observePage(page);
    expect(
      await batch(page, [
        { kind: 'click', ...refIn(observation, 'Show delivery times') },
        { kind: 'click', ...refIn(observation, 'This is a gift') },
        { kind: 'click', ...refIn(observation, 'Cloth') },
        { kind: 'select', ...refIn(observation, 'Country'), value: 'Canada' },
      ]),
    ).toMatchObject({ status: 'completed' });
    expect(await page.locator('#times').isVisible()).toBe(true);
    expect(await page.locator('#toggle').getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#gift').isChecked()).toBe(true);
    expect(await page.locator('#cloth').isChecked()).toBe(true);
    expect(await page.locator('#country').inputValue()).toBe('Canada');
    expect(posts()).toEqual([]);
  });

  it('fails a click on a control an overlay covers, instead of pressing the overlay', async () => {
    const page = await open();
    await go(page, OPEN_WEB.overlay);
    expect(await click(page, 'Search')).toMatchObject({
      status: 'stopped',
      reason: 'not_actionable',
      actions: [{ status: 'stopped', reason: 'not_actionable' }],
    });
    expect(posts()).toEqual([]);
    expect(page.url()).toBe(OPEN_WEB.overlay);
  });

  it('ends a batch on a same-URL reload and invalidates targets from the replaced document', async () => {
    const url = 'https://news.example/reload';
    fixture.serve(
      url,
      htmlPage(
        'Reload',
        '<h1>Reload</h1><button type="button" onclick="location.reload()">Reload page</button><input aria-label="Search term">',
      ),
    );
    const page = await open();
    await go(page, url);
    const observation = await observePage(page);
    const old = refIn(observation, 'Search term');
    const result = await batch(page, [
      { kind: 'click', ...refIn(observation, 'Reload page') },
      { kind: 'type', ...old, text: 'must not run' },
    ]);
    expect(result).toMatchObject({
      reason: 'navigated',
      actions: [{ status: 'completed' }, { status: 'not_executed' }],
    });
    expect(page.url()).toBe(url);
    expect(await page.getByRole('textbox', { name: 'Search term' }).inputValue()).toBe('');
    expect(await batch(page, [{ kind: 'type', ...old, text: 'stale' }])).toMatchObject({ reason: 'stale_ref' });
    const fresh = refIn(await observePage(page), 'Search term');
    expect(await batch(page, [{ kind: 'type', ...fresh, text: 'current' }])).toMatchObject({ status: 'completed' });
    expect(await page.getByRole('textbox', { name: 'Search term' }).inputValue()).toBe('current');
  });

  it('keeps refs through an ad frame’s navigation and a same-document route, and makes them stale when their own frame or the page’s document changes', async () => {
    const url = 'https://news.example/frames';
    const ad = 'https://ads.example/slot';
    const login = 'https://accounts.example/embedded';
    const page = htmlPage(
      'Frames',
      `<h1>Frames</h1><input aria-label="Search term"><iframe id="ad" title="Advertisement" src="${ad}"></iframe><iframe id="login" title="Sign in" src="${login}"></iframe>`,
    );
    fixture.serve(url, page);
    fixture.serve(`${url}/results`, page);
    fixture.serve(ad, htmlPage('Ad', '<button type="button">First offer</button>'));
    fixture.serve(`${ad}-2`, htmlPage('Ad', '<button type="button">Second offer</button>'));
    fixture.serve(login, htmlPage('Sign in', '<input aria-label="Account email">'));
    fixture.serve(`${login}/next`, htmlPage('Sign in', '<input aria-label="Account email">'));
    const tab = await open();
    await go(tab, url);
    const frame = tab.frameLocator('#login');
    await frame.getByRole('textbox', { name: 'Account email' }).waitFor();
    await tab.frameLocator('#ad').getByRole('button', { name: 'First offer' }).waitFor();
    const search = tab.getByRole('textbox', { name: 'Search term' });

    let observation = await observePage(tab);
    await tab.evaluate(`document.getElementById('ad').src = '${ad}-2'`);
    await tab.frameLocator('#ad').getByRole('button', { name: 'Second offer' }).waitFor();
    expect(await batch(tab, [{ kind: 'type', ...refIn(observation, 'Search term'), text: 'tapas' }])).toMatchObject({
      status: 'completed',
    });
    expect(await search.inputValue()).toBe('tapas');

    observation = await observePage(tab);
    await tab.evaluate(`history.pushState({}, '', '/frames/results')`);
    expect(await batch(tab, [{ kind: 'type', ...refIn(observation, 'Search term'), text: 'mezze' }])).toMatchObject({
      status: 'completed',
    });
    expect(await search.inputValue()).toBe('mezze');

    observation = await observePage(tab);
    const email = refIn(observation, 'Account email');
    const frameOf = (ref: string): string => ref.replace(/e\d+$/u, '');
    expect(frameOf(email.ref)).not.toBe(frameOf(refIn(observation, 'Search term').ref));
    await tab.evaluate(`document.getElementById('login').src = '${login}/next'`);
    await frame.getByRole('textbox', { name: 'Account email' }).waitFor();
    await expect.poll(() => tab.frames().some((candidate) => candidate.url() === `${login}/next`)).toBe(true);
    expect(await batch(tab, [{ kind: 'type', ...email, text: 'morgan' }])).toMatchObject({ reason: 'stale_ref' });
    expect(await frame.getByRole('textbox', { name: 'Account email' }).inputValue()).toBe('');

    observation = await observePage(tab);
    const old = refIn(observation, 'Search term');
    await tab.reload();
    await search.waitFor();
    expect(await batch(tab, [{ kind: 'type', ...old, text: 'stale' }])).toMatchObject({ reason: 'stale_ref' });
    expect(await search.inputValue()).toBe('');
  });

  it('does not turn an internal TypeError into an actionability refusal', async () => {
    const page = await open();
    await go(page, OPEN_WEB.faq);
    const wheel = vi.spyOn(page.mouse, 'wheel').mockRejectedValue(new TypeError('private-runtime-sentinel'));
    try {
      await expect(batch(page, [{ kind: 'scroll', direction: 'down' }])).rejects.toThrow(
        'The browser action failed unexpectedly.',
      );
    } finally {
      wheel.mockRestore();
    }
    expect(await click(page, 'Show delivery times')).toMatchObject({ status: 'completed' });
  });

  it('reports a pinned target detached by an earlier action without pressing a replacement', async () => {
    const url = 'https://news.example/detached';
    fixture.serve(
      url,
      htmlPage(
        'Controls',
        '<h1>Controls</h1><button type="button" onclick="document.getElementById(\'old\').remove()">Remove old control</button><button type="button" id="old" onclick="window.oldPresses=(window.oldPresses||0)+1">Old control</button>',
      ),
    );
    const page = await open();
    await go(page, url);
    const before = await observePage(page);
    expect(
      await batch(page, [
        { kind: 'click', ...refIn(before, 'Remove old control') },
        { kind: 'click', ...refIn(before, 'Old control') },
      ]),
    ).toMatchObject({
      reason: 'not_actionable',
      actions: [{ status: 'completed' }, { status: 'stopped', reason: 'not_actionable' }],
    });
    expect(await page.evaluate('window.oldPresses || 0')).toBe(0);
    expect(await page.getByRole('button', { name: 'Old control', exact: true }).count()).toBe(0);
    expect(await batch(page, [{ kind: 'observe' }])).toMatchObject({ status: 'completed' });
  });

  it('refuses a page timer that posts after the batch, follows its GET on the leased site, and refuses one to another site', async () => {
    const page = await open();
    const guard = await ensureBrowserNavigationGuard(page);
    /** A refused load ends on Chrome's own error page. */
    const refused = async (): Promise<void> => {
      await expect.poll(() => guard.reason(), { timeout: 10_000 }).toBe('blocked_address');
      await expect.poll(() => page.url(), { timeout: 10_000 }).toMatch(/^chrome-error:/u);
    };
    await go(page, OPEN_WEB.timers);
    expect(await click(page, 'Save for later')).toMatchObject({ status: 'completed' });
    await refused();
    expect(posts()).toEqual([]);
    // The next operation navigates again.
    expect(await go(page, OPEN_WEB.timers)).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(await click(page, 'Refresh deals')).toMatchObject({ status: 'completed' });
    await page.waitForURL('https://shop.example/deals/today', { timeout: 10_000 });
    expect(guard.reason()).toBeUndefined();
    await go(page, OPEN_WEB.timers);
    expect(await click(page, 'See partner offer')).toMatchObject({ status: 'completed' });
    await refused();
    expect(fixture.requests.filter((request) => request.url.startsWith('https://partner.example'))).toEqual([]);
    expect(await go(page, OPEN_WEB.timers)).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(page.url()).toBe(OPEN_WEB.timers);
  });

  it('refuses script posts to a payment processor or a checkout route during an ordinary click, from the page and its payment frame', async () => {
    const page = await open();
    await go(page, OPEN_WEB.scripted);
    const frame = page.frames().find((candidate) => candidate.url() === PROCESSOR.frame);
    if (!frame) throw new Error('The payment frame did not load');
    // The payment frame runs out of process: its requests leave from its own target.
    await (await page.context().newCDPSession(frame)).detach();
    for (const name of ['Show delivery estimate', 'Check stock', 'Update cart', 'Show wallet options'])
      expect(await click(page, name)).toMatchObject({ status: 'completed' });
    expect(posts()).toEqual([]);
    // The awaited GET went out; only the post after it was refused.
    expect(fixture.requests.map((request) => request.url)).toContain('https://shop.example/api/stock');
    expect(await page.locator('#status').textContent()).toBe('refused');
    // Once the last action's window has closed nothing is paused: the page's own post reaches the processor.
    await (await ensureBrowserNavigationGuard(page)).actionsSettled();
    await page.evaluate(`fetch('${PROCESSOR.confirm}', { method: 'POST', mode: 'no-cors', body: 'outside' })`);
    await expect.poll(posts).toEqual([PROCESSOR.confirm]);
  });

  it('returns an ordinary click well before its window closes, and still refuses the payment post its page sends later', async () => {
    const page = await open();
    await go(page, OPEN_WEB.scripted);
    // Page script that posts to the payment processor 700 ms after the click, inside the old one-second hold.
    await page.evaluate(`(() => {
  const later = document.createElement('button');
  later.type = 'button';
  later.textContent = 'Show estimate later';
  later.addEventListener('click', () => {
    window.clickedAt = performance.now();
    setTimeout(() => { window.posted = true; void post('${PROCESSOR.confirm}', 'after=delay'); }, 700);
  });
  document.body.append(later);
})()`);
    const element = await page.getByRole('button', { name: 'Show estimate later' }).elementHandle();
    if (!element) throw new Error('Fixture control missing');
    try {
      // The activation boundary alone, inside the job's operation: a batch goes on to observe the page.
      const pressed = await withBrowserJobNavigation(context(page), page, () =>
        activateControl(page, element, () => element.click({ noWaitAfter: true }), undefined, {
          kind: 'click',
          scope: { jobId: context(page).job.id, db },
          assertActive: context(page).assertActive,
          remaining: context(page).remaining,
        }),
      );
      expect(pressed).toEqual({ ordinaryPress: true });
    } finally {
      await element.dispose();
    }
    const returned = (await page.evaluate(
      '({ elapsed: performance.now() - window.clickedAt, posted: window.posted === true })',
    )) as { elapsed: number; posted: boolean };
    // The click returned before its page posted, not a second after it.
    expect(returned.posted).toBe(false);
    expect(returned.elapsed).toBeLessThan(700);
    // The post still fell inside the click's window.
    await expect.poll(() => page.locator('#status').textContent()).toBe('refused');
    expect(posts()).toEqual([]);
  });

  it('refuses the payment post and the checkout submit that page script sends as a field is typed into', async () => {
    const page = await open();
    await go(page, OPEN_WEB.typedPosts);
    const guard = await ensureBrowserNavigationGuard(page);
    /** Types as `actions` says, aimed from a fresh observation, once every earlier window has closed. */
    const typed = async (actions: (observation: BrowserSnapshotObservation) => BrowserAction[]): Promise<void> => {
      await guard.actionsSettled();
      await page.evaluate(`document.getElementById('status').textContent = 'Ready'`);
      expect(await batch(page, actions(await observePage(page)))).toMatchObject({ status: 'completed' });
      await expect.poll(() => page.locator('#status').textContent()).toBe('refused');
    };
    await typed((seen) => [{ kind: 'type', ...refIn(seen, 'Gift message'), text: 'Happy birthday' }]);
    await typed((seen) => [
      { kind: 'form_input', fields: [{ ...refIn(seen, 'Delivery notes'), value: 'Leave it with the porter' }] },
    ]);
    // A key that edits the field is typing too.
    await typed((seen) => [
      { kind: 'key', ...refIn(seen, 'Gift message'), key: 'End' },
      { kind: 'key', ...refIn(seen, 'Gift message'), key: 'Backspace' },
    ]);
    // The typing itself went through.
    expect(await page.locator('input[name="gift"]').inputValue()).toBe('Happy birthda');
    expect(await page.locator('input[name="notes"]').inputValue()).toBe('Leave it with the porter');
    expect(posts()).toEqual([]);
  });

  it('never slows a widget polling with GETs, during an action or after it', async () => {
    const page = await open();
    await go(page, OPEN_WEB.live);
    const clock = (): Promise<number> => page.evaluate(() => performance.now());
    const started = await clock();
    expect(await click(page, 'Show more')).toMatchObject({ status: 'completed' });
    const ended = await clock();
    await page.waitForTimeout(1_000);
    const polls = (await page.evaluate('window.polls')) as Array<{ at: number; ok: boolean; ms: number }>;
    expect(polls.every((poll) => poll.ok)).toBe(true);
    expect(Math.max(...polls.map((poll) => poll.ms))).toBeLessThan(250);
    // The widget kept its pace through the action's window and after it.
    expect(polls.filter((poll) => poll.at >= started && poll.at <= ended).length).toBeGreaterThanOrEqual(
      Math.floor((ended - started) / 200),
    );
    expect(polls.filter((poll) => poll.at > ended).length).toBeGreaterThanOrEqual(5);
    expect(await page.locator('#extra').isVisible()).toBe(true);
  });

  it('replays a read-only recipe along GET links on an unreviewed site, and refuses its POST', async () => {
    const page = await open();
    const recording = context(page);
    const record = (actions: BrowserAction[]) => executeBrowserBatch(recording, { actions });
    await record([{ kind: 'navigate', url: OPEN_WEB.article }]);
    await record([{ kind: 'click', ...refIn(await observePage(page), 'About us') }]);
    const about = await saveBrowserRecipe(recording, {
      name: 'About',
      first_action: 0,
      last_action: 1,
      parameters: [],
    });
    expect(about).toMatchObject({ status: 'saved', read_only: true });
    expect(
      await executeRecipe(
        context(page),
        { recipe_id: about.recipe_id, parameters: {} },
        { page, readOnly: true, record: false },
      ),
    ).toMatchObject({ status: 'completed' });
    expect(page.url()).toBe(OPEN_WEB.about);
    await record([{ kind: 'navigate', url: OPEN_WEB.availability }]);
    await record([{ kind: 'click', ...refIn(await observePage(page), 'Refresh availability') }]);
    expect(posts()).toEqual(['https://bistro.example/availability/hold']);
    const hold = await saveBrowserRecipe(recording, {
      name: 'Tables',
      first_action: 2,
      last_action: 3,
      parameters: [],
    });
    expect(hold).toMatchObject({ status: 'saved', read_only: true });
    expect(
      await executeRecipe(
        context(page),
        { recipe_id: hold.recipe_id, parameters: {} },
        { page, readOnly: true, record: false },
      ),
    ).toMatchObject({ status: 'checkpoint_failed', step: 1, found: { reason: 'read_only' } });
    expect(posts()).toEqual(['https://bistro.example/availability/hold']);
  });

  it.each(['new-password', 'current-password'])(
    'refuses ordinary typing and editing of a field marked %s even when page script hides its attributes',
    async (autocomplete) => {
      const page = await open();
      const url = `https://shop.example/secret-entry-${autocomplete}`;
      const label = 'Display value';
      fixture.serve(
        url,
        htmlPage(
          'Profile',
          `<form method="post" action="${url}/submitted"><label>${label} <input id="entry" name="value" type="text" autocomplete="${autocomplete}"></label><button>Continue</button></form>`,
          `
      const read = HTMLInputElement.prototype.getAttribute;
      HTMLInputElement.prototype.getAttribute = function(name) {
        return this.id === 'entry' && ['type', 'autocomplete'].includes(name) ? null : read.call(this, name);
      };
    `,
        ),
      );
      await page.goto(url);
      const secret = 'Synthetic-"credential\\U3-42';
      await page.locator('#entry').fill(secret);
      const checkout = await withElement(page.locator('button'), (element) => readCheckoutRegion(page, element));
      expect.soft(checkout.region.fields).toMatchObject([{ secret: true, value: null }]);
      const observation = await observePage(page);
      for (const text of [observation.snapshot, JSON.stringify(observation)])
        for (const encoded of [secret, JSON.stringify(secret).slice(1, -1)]) expect(text).not.toContain(encoded);
      await page.locator('#entry').fill('');
      for (const kind of ['type', 'key', 'form_input'] as const) {
        const field = refIn(await observePage(page), label);
        // A code-shaped value too: only the host fills a credential field.
        const action: BrowserAction =
          kind === 'type'
            ? { kind, ...field, text: '552913' }
            : kind === 'key'
              ? { kind, ...field, key: 'Backspace' }
              : { kind, fields: [{ ...field, value: 'ordinary-text' }] };
        const result = await batch(page, [action]);
        expect(result).toMatchObject({ status: 'stopped', reason: 'secret_field' });
        expect(await page.locator('#entry').inputValue()).toBe('');
      }
    },
  );

  describe('codes the agent types', () => {
    const CODE = '552913';
    const verify = (url: string, fields: string): string =>
      htmlPage(
        'Verify',
        `<h1>Enter the code we sent</h1><form method="post" action="${url}/verified">${fields}<button type="submit">Verify</button></form>`,
      );
    const serve = (name: string, fields: string): string => {
      const url = `https://shop.example/verify-${name}`;
      fixture.serve(url, verify(url, fields));
      fixture.serve(`${url}/verified`, htmlPage('Verified', '<h1>You are signed in</h1>'));
      return url;
    };

    it('types a code into a one-time-code field, shows it as typed, and leaves screenshots available', async () => {
      const page = await open();
      await page.goto(
        serve(
          'otp',
          '<label>Verification code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label>',
        ),
      );
      const typed = await batch(page, [
        { kind: 'type', ...refIn(await observePage(page), 'Verification code'), text: CODE },
      ]);
      expect(typed).toMatchObject({ status: 'completed' });
      expect(await page.locator('[name=code]').inputValue()).toBe(CODE);
      expect((await observePage(page)).snapshot).toContain(CODE);
      expect(await batch(page, [{ kind: 'screenshot' }])).toMatchObject({
        status: 'completed',
        images: [{ mime_type: 'image/png' }],
      });
    });

    it('types one digit into each of six single-digit boxes', async () => {
      const page = await open();
      const boxes = Array.from(
        { length: 6 },
        (_value, index) =>
          `<input aria-label="Digit ${index + 1}" name="d${index + 1}" maxlength="1" inputmode="numeric"${index === 0 ? ' autocomplete="one-time-code"' : ''}>`,
      ).join('');
      await page.goto(serve('boxes', boxes));
      const observation = await observePage(page);
      const typed = await batch(page, [
        {
          kind: 'form_input',
          fields: [...CODE].map((digit, index) => ({ ...refIn(observation, `Digit ${index + 1}`), value: digit })),
        },
      ]);
      expect(typed).toMatchObject({ status: 'completed' });
      expect(await Promise.all((await page.locator('input').all()).map((input) => input.inputValue()))).toEqual([
        ...CODE,
      ]);
    });

    it('types a code into a masked PIN field, then presses Verify, with screenshots still available', async () => {
      const page = await open();
      const url = serve('pin', '<label>PIN <input name="pin" type="password" inputmode="numeric"></label>');
      await page.goto(url);
      const typed = await batch(page, [{ kind: 'type', ...refIn(await observePage(page), 'PIN'), text: CODE }]);
      expect(typed).toMatchObject({ status: 'completed' });
      expect(await batch(page, [{ kind: 'screenshot' }])).toMatchObject({ status: 'completed' });
      expect(await click(page, 'Verify')).toMatchObject({ status: 'stopped', reason: 'navigated' });
      expect(page.url()).toBe(`${url}/verified`);
      expect(posts()).toContain(`${url}/verified`);
    });

    it('keeps a code-shaped password out of an unmarked password field, while a masked code box takes a letter code', async () => {
      const page = await open();
      const signup = serve(
        'unmarked-signup',
        '<label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label>',
      );
      await page.goto(signup);
      const typed: BrowserAction = { kind: 'type', ...refIn(await observePage(page), 'Password'), text: 'Summer2026' };
      expect(await batch(page, [typed])).toMatchObject({ status: 'stopped', reason: 'secret_field' });
      const observation = await observePage(page);
      const filled = await batch(page, [
        {
          kind: 'form_input',
          fields: [{ ...refIn(observation, 'Password'), value: 'Summer2026' }],
          submit: refIn(observation, 'Verify'),
        },
      ]);
      expect(filled).toMatchObject({ status: 'stopped', reason: 'secret_field' });
      expect(await page.locator('[name=password]').inputValue()).toBe('');
      expect(posts()).not.toContain(`${signup}/verified`);

      const box = serve('masked-letters', '<label>Code <input name="code" type="password" maxlength="6"></label>');
      await page.goto(box);
      const code = await batch(page, [{ kind: 'type', ...refIn(await observePage(page), 'Code'), text: 'A7KX29' }]);
      expect(code).toMatchObject({ status: 'completed' });
      expect(await click(page, 'Verify')).toMatchObject({ status: 'stopped', reason: 'navigated' });
      expect(posts()).toContain(`${box}/verified`);
    });

    it('refuses a password-shaped value in a masked field, and a model-chosen signup password never submits', async () => {
      const page = await open();
      const url = serve(
        'signup',
        '<label>Username <input name="username"></label><label>Password <input name="password" type="password"></label>',
      );
      await page.goto(url);
      for (const text of ['Tr0ub4dor&3', 'longerthanten1', '5529 13']) {
        const typed = await batch(page, [{ kind: 'type', ...refIn(await observePage(page), 'Password'), text }]);
        expect(typed).toMatchObject({ status: 'stopped', reason: 'secret_field' });
      }
      const observation = await observePage(page);
      const signup = await batch(page, [
        {
          kind: 'form_input',
          fields: [
            { ...refIn(observation, 'Username'), value: 'fixture-member' },
            { ...refIn(observation, 'Password'), value: 'Model-chosen-passphrase-9' },
          ],
          submit: refIn(observation, 'Verify'),
        },
      ]);
      expect(signup).toMatchObject({ status: 'stopped', reason: 'secret_field' });
      expect(await page.locator('[name=password]').inputValue()).toBe('');
      expect(posts()).not.toContain(`${url}/verified`);
    });

    it.each(['form', 'formless'] as const)(
      'refuses an agent press while a %s group holds a value the host filled',
      async (shape) => {
        const page = await open();
        const url = `https://shop.example/host-held-${shape}`;
        const fields =
          '<label>Email <input name="email" type="email"></label><label>Password <input id="pw" name="password" type="password" autocomplete="current-password"></label>';
        fixture.serve(
          url,
          htmlPage(
            'Sign in',
            shape === 'form'
              ? `<form method="post" action="${url}/session">${fields}<button type="submit">Sign in</button></form>`
              : `<div>${fields}<div role="button" tabindex="0" id="go">Sign in</div></div>`,
            shape === 'form'
              ? ''
              : `document.getElementById('go').addEventListener('click', () => fetch('${url}/session', { method: 'POST', body: document.getElementById('pw').value }));`,
          ),
        );
        fixture.serve(`${url}/session`, htmlPage('Signed in', '<h1>Signed in</h1>'));
        await page.goto(url);
        // A host fill whose clearing failed leaves its value in the field; only the host submits it.
        const held = 'host-held-fixture-7731';
        await page.locator('#pw').fill(held);
        registerPageSecret(page, held);
        try {
          expect(await click(page, 'Sign in')).toMatchObject({ status: 'stopped', reason: 'secret_field' });
          const email = refIn(await observePage(page), 'Email');
          expect(await batch(page, [{ kind: 'key', ...email, key: 'Enter' }])).toMatchObject({
            status: 'stopped',
            reason: 'secret_field',
          });
          expect(posts()).not.toContain(`${url}/session`);
        } finally {
          releasePageSecret(page, held);
        }
      },
    );
  });

  it('stops a watch batch at a download without running later actions', async () => {
    const page = await open();
    const url = 'https://shop.example/watch-download';
    fixture.serve(
      url,
      htmlPage(
        'Receipt',
        '<a href="/receipt.txt" download>Download receipt</a><button onclick="this.textContent=\'Ran later action\'">Continue</button>',
      ),
    );
    await page.goto(url);
    const observation = await observePage(page);
    const watch: BrowserWatchExecutionContext = {
      ...context(page),
      kind: 'watch_check',
      check: { id: 'check-download' },
    };
    const result = await executeBrowserBatch(
      watch,
      {
        actions: [
          { kind: 'download', ...refIn(observation, 'Download receipt') },
          { kind: 'click', ...refIn(observation, 'Continue') },
        ],
      },
      { record: false },
    );
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'read_only',
      actions: [
        { index: 0, status: 'stopped', reason: 'read_only' },
        { index: 1, status: 'not_executed' },
      ],
    });
    expect(await page.locator('button').textContent()).toBe('Continue');
    expect(fixture.requests.some((request) => request.url === 'https://shop.example/receipt.txt')).toBe(false);
  });

  it('stops typing into a card field with card_field, on the page and inside a processor frame', async () => {
    const page = await open();
    await go(page, OPEN_WEB.platform);
    const typed = async (name: string): Promise<unknown> =>
      batch(page, [{ kind: 'type', ...refIn(await observePage(page), name), text: '4242 4242 4242 4242' }]);
    expect(await typed('Card number')).toMatchObject({ status: 'stopped', reason: 'card_field' });
    expect(await typed('Expiry')).toMatchObject({ status: 'stopped', reason: 'card_field' });
    expect(await page.locator('input[name="cardnumber"]').inputValue()).toBe('');
    // A gift card's number is no card entry: it is ordinary text, like a coupon.
    expect(await typed('Gift card number')).toMatchObject({ status: 'completed' });
    await go(page, OPEN_WEB.hostedCard);
    await page.frameLocator('#card-frame').locator('input[name="cardnumber"]').waitFor();
    for (const name of ['Card number', 'CVC']) expect(await typed(name)).toMatchObject({ reason: 'card_field' });
    expect(await page.frameLocator('#card-frame').locator('input[name="cardnumber"]').inputValue()).toBe('');
  });

  it('lets two jobs whose pages embed the same third-party frame each load it: a frame takes no lease', async () => {
    const [first, second] = [await open(), await open()];
    expect(await go(first, OPEN_WEB.product, 'job-a')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    await first.frameLocator('#pay-later').locator('text=Pay in 4').waitFor();
    expect(await go(second, OPEN_WEB.giftCards, 'job-b')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    await second.frameLocator('#pay-later').locator('text=Pay in 4').waitFor();
    expect(await db.all('SELECT site, job_id FROM gws_ea_browser_site_leases ORDER BY site')).toEqual([
      { site: 'bistro.example', job_id: 'job-b' },
      { site: 'shop.example', job_id: 'job-a' },
    ]);
  });
});

describe.skipIf(!chromePath)('ordinary presses that buy, in native Chrome', { timeout: 60_000 }, () => {
  let host: ErrandHost;
  let page: Page;
  let session: Session;
  const posts = (): string[] =>
    fixture.requests.filter((request) => request.method !== 'GET').map((request) => request.url);

  beforeEach(async () => {
    host = await startErrandHost(root, fixture, 'system:a2a:main-p:reorder');
    ({ page, errand: session } = host);
  });
  afterEach(() => stopErrandHost(root, host));

  /** One browser request through the queue, as the browser agent sends it; its answer's data. */
  const run = (id: string, actions: BrowserAction[]) => errandRequest(host, id, 'browser', { actions });
  /** Opens `url`, then presses the control named `name` from the observation the navigation answered with. */
  async function press(url: string, name: string): Promise<Record<string, unknown>> {
    const opened = await run(`open-${name}`, [{ kind: 'navigate', url }]);
    const observation = opened.observation as { snapshot: string; generation: number };
    return run(`press-${name}`, [{ kind: 'click', ...refIn(observation, name) }]);
  }
  const incidents = () =>
    getDb().all<{ kind: string; site: string; job_id: string }>(
      'SELECT kind, site, job_id FROM gws_ea_browser_incidents',
    );

  it('presents each saved login account owner without reading the key', async () => {
    const logins = testLoginStore(`${root}/browser`);
    const assistant = await logins.store.create({
      site: OPEN_WEB.faq,
      username: ALIAS,
      title: 'Assistant login',
      password: 'native-assistant-secret',
    });
    const principal = await logins.store.create({
      site: OPEN_WEB.faq,
      username: 'morgan@example.test',
      title: 'Principal login',
      password: 'native-principal-secret',
    });
    logins.setUnavailable(true);
    const reads = logins.keyReads();
    const store = vi.spyOn(loginStoreModule, 'getLoginStore').mockResolvedValue(logins.store);
    try {
      const opened = await run('inventory-labels', [{ kind: 'navigate', url: OPEN_WEB.faq }]);
      expect((opened.observation as BrowserSnapshotObservation).site?.vault_items).toEqual([
        { item_handle: assistant.id, title: 'Assistant login', account: 'assistant' },
        { item_handle: principal.id, title: 'Principal login', account: 'principal' },
      ]);
      expect(logins.keyReads()).toBe(reads);
      expect(JSON.stringify(opened)).not.toMatch(/native-assistant-secret|native-principal-secret|morgan@/u);
    } finally {
      store.mockResolvedValue(defaultLogins.store);
    }
  });

  it.each(['catalog', 'vault'] as const)(
    'keeps completed navigation and the next action usable when %s metadata does not answer',
    async (source) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const all = getDb().all.bind(getDb());
      const catalog = vi.spyOn(getDb(), 'all').mockImplementation(async (sql, ...parameters) => {
        if (source === 'catalog' && sql.includes('SELECT r.* FROM gws_ea_browser_recipes')) await held;
        return all(sql, ...parameters);
      });
      const logins = testLoginStore(`${root}/browser`);
      const item = await logins.store.create({
        site: OPEN_WEB.faq,
        username: 'morgan@example.test',
        title: 'Fixture login',
        password: 'native-metadata-secret',
      });
      const store = vi.spyOn(loginStoreModule, 'getLoginStore').mockResolvedValue(logins.store);
      const vault = vi.spyOn(logins.store, 'forOrigin').mockImplementation(async () => {
        if (source === 'vault') await held;
        // A useful first inventory may take longer than the recorder's allowance.
        else await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return [item];
      });
      // Release even on the old implementation, whose queue must settle its timed-out operation before answering.
      const timer = setTimeout(release, 5_000);
      try {
        const result = await errandRequest(host, 'held-catalog', 'browser', {
          actions: [{ kind: 'navigate', url: OPEN_WEB.faq }],
          budget_ms: 3_000,
        });
        expect(result).toMatchObject({ reason: 'navigated', actions: [{ status: 'completed' }] });
        expect((result.observation as BrowserSnapshotObservation).site).toMatchObject(
          source === 'catalog'
            ? { recipes_status: 'unavailable', vault_items: [{ item_handle: item.id }] }
            : { recipes: [], vault_status: 'vault_unavailable' },
        );
        release();
        catalog.mockRestore();
        const retried = await observePage(page);
        expect(retried.site).toMatchObject({ recipes: [], vault_items: [{ item_handle: item.id }] });
        expect(
          await run('after-held-catalog', [
            { kind: 'click', ...refIn(await observePage(page), 'Show delivery times') },
          ]),
        ).toMatchObject({ status: 'completed' });
      } finally {
        release();
        clearTimeout(timer);
        catalog.mockRestore();
        vault.mockRestore();
        store.mockResolvedValue(defaultLogins.store);
      }
    },
  );

  it('stops the job with an incident when an ordinary Submit lands on a paid order confirmation', async () => {
    const answer = await press(OPEN_WEB.reorder, 'Submit');
    expect(answer).toMatchObject({
      status: 'stopped',
      reason: 'unapproved_commit',
      incident: { site: 'shop.example', reference: 'SO-48213', charged: '$42.00' },
      actions: [{ status: 'stopped', reason: 'unapproved_commit' }],
      repeat_safe: false,
    });
    expect(posts()).toEqual(['https://shop.example/reorder/submit']);
    expect(await incidents()).toEqual([{ kind: 'unapproved_commit', site: 'shop.example', job_id: session.thread_id }]);
    expect(host.closed).toBeGreaterThan(0);
    // The job is over: its next request is refused before it runs.
    await expect(run('after', [{ kind: 'observe' }])).rejects.toThrow();
  });

  it('waits out a press whose script posts to the merchant’s own API and then loads a paid confirmation, and stops the job', async () => {
    const quick = 'https://shop.example/quick-reorder';
    fixture.serve(
      quick,
      `<!doctype html><html><head><title>Quick reorder</title></head><body><h1>Reorder your last items</h1>
<button type="button" id="reorder">Reorder</button>
<script>document.getElementById('reorder').addEventListener('click', async () => {
  await fetch('/api/quick-reorder', { method: 'POST', body: 'item=apron' });
  location.assign('/orders/placed');
});</script></body></html>`,
    );
    fixture.serve('https://shop.example/api/quick-reorder', () => ({
      headers: { 'content-type': 'application/json' },
      body: '{"status":"accepted"}',
    }));
    fixture.serve('https://shop.example/orders/placed', orderConfirmationPage());
    // The merchant's API answers 400 ms after the press, as a server charging a saved card might: the fetch is held
    // at the network layer, so the page navigates only once it returns.
    const slow = await page.context().newCDPSession(page);
    slow.on('Fetch.requestPaused', (event) => {
      setTimeout(() => {
        void slow.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined);
      }, 400);
    });
    await slow.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/quick-reorder', requestStage: 'Request' }] });
    try {
      const answer = await press(quick, 'Reorder');
      expect(answer).toMatchObject({
        status: 'stopped',
        reason: 'unapproved_commit',
        incident: { site: 'shop.example', reference: 'SO-48213', charged: '$42.00' },
        actions: [{ status: 'stopped', reason: 'unapproved_commit' }],
      });
      // The press waited for the navigation its script started, and read the confirmation on the new page.
      expect(page.url()).toBe('https://shop.example/orders/placed');
      expect(posts()).toEqual(['https://shop.example/api/quick-reorder']);
      expect(await incidents()).toMatchObject([{ kind: 'unapproved_commit', site: 'shop.example' }]);
    } finally {
      await slow.detach().catch(() => undefined);
    }
  });

  it('runs Add to calendar on an order page showing its confirmation, charge and card, and raises nothing', async () => {
    expect(await press(OPEN_WEB.thanks, 'Add to calendar')).toMatchObject({
      status: 'completed',
      actions: [{ status: 'completed' }],
    });
    expect(await page.locator('#added').isVisible()).toBe(true);
    expect(await incidents()).toEqual([]);
  });

  it('raises nothing when Track order opens another page showing the same order and charge', async () => {
    expect(await press(OPEN_WEB.thanks, 'Track order')).toMatchObject({ status: 'stopped', reason: 'navigated' });
    expect(page.url()).toBe(OPEN_WEB.tracking);
    expect(await incidents()).toEqual([]);
  });

  it('stops the job when a press on that order page confirms a new charge in a frame beside the old confirmation', async () => {
    await run('open-thanks', [{ kind: 'navigate', url: OPEN_WEB.thanks }]);
    await page.frameLocator('#perks').locator('#accept').waitFor();
    expect(await run('accept', [{ kind: 'click', ...refIn(await observePage(page), 'Yes, add it') }])).toMatchObject({
      status: 'stopped',
      reason: 'unapproved_commit',
      incident: { site: 'shop.example', reference: 'PK-7731', charged: '$19.00' },
    });
    expect(await incidents()).toMatchObject([{ kind: 'unapproved_commit', site: 'shop.example' }]);
  });
});
