import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type Server } from 'node:http';
import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { closeDb, initDb } from '../../db/connection.js';
import { BrowserStore } from './db.js';
import { browserRecipesMigration, browserSiteLeasesMigration } from './migration.js';
import { executeBrowserBatch } from './executor.js';
import { observePage, registerPageSecret, type BrowserRef } from './observe.js';
import type { BrowserExecutionContext } from './queue.js';
import {
  executeRecipe,
  loadRecipe,
  recipeCheckKey,
  saveBrowserRecipe,
  validateRunRecipe,
  validateSaveRecipe,
} from './recipes.js';

it('accepts closed recipe inputs and refuses ambiguous or executable bindings', () => {
  expect(
    validateSaveRecipe({
      name: 'Find tables',
      first_action: 0,
      last_action: 3,
      parameters: [{ name: 'party', action_index: 1 }],
    }),
  ).toEqual({ name: 'Find tables', first_action: 0, last_action: 3, parameters: [{ name: 'party', action_index: 1 }] });
  for (const change of [
    { first_action: -1 },
    { last_action: 0, first_action: 1 },
    { script: 'return true' },
    { parameters: [{ name: 'party', action_index: 9 }] },
    {
      parameters: [
        { name: 'party', action_index: 1 },
        { name: 'party', action_index: 2 },
      ],
    },
  ])
    expect(() =>
      validateSaveRecipe({ name: 'Find tables', first_action: 0, last_action: 3, parameters: [], ...change }),
    ).toThrow();
  expect(validateRunRecipe({ recipe_id: 'recipe-1', parameters: { party: '3' } })).toEqual({
    recipe_id: 'recipe-1',
    parameters: { party: '3' },
  });
  expect(() => validateRunRecipe({ recipe_id: 'recipe-1', parameters: { party: 3 } })).toThrow();
});

it('pins immutable recipe versions and keys checks by every named value', async () => {
  const db = await initDb(':memory:', { role: 'tool' });
  try {
    await db.exec(
      "CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('job-store');",
    );
    await browserRecipesMigration.up(db);
    const step = {
      action: { kind: 'type', ref: 'e1', generation: 1, text: '2' },
      targets: [
        {
          role: 'textbox',
          name: 'Party size',
          ordinal: 0,
          count: 1,
          framePath: [],
          frameUrls: ['https://fixture.example/search'],
        },
      ],
      before: { url: 'https://fixture.example/search', heading: 'Find tables' },
      after: { url: 'https://fixture.example/search', heading: 'Find tables' },
      readOnly: true,
    };
    await db.run(
      'INSERT INTO gws_ea_browser_action_trace VALUES(?,?,?,?,?)',
      'job-store',
      0,
      'request-store',
      JSON.stringify(step),
      new Date().toISOString(),
    );
    const context = { job: { id: 'job-store' }, store: new BrowserStore(db) } as unknown as BrowserExecutionContext;
    const input = {
      name: 'Find tables',
      first_action: 0,
      last_action: 0,
      parameters: [{ name: 'party', action_index: 0 }],
    };
    const first = await saveBrowserRecipe(context, input);
    const second = await saveBrowserRecipe(context, input);
    const old = await loadRecipe(String(first.recipe_id), db);
    expect(old).toMatchObject({ version: 1, readOnly: true, parameters: [{ name: 'party', step: 0 }] });
    expect(await loadRecipe(String(second.recipe_id), db)).toMatchObject({ version: 2 });
    const page = {
      url: () => 'https://fixture.example/search',
      frames: () => [],
      locator: () => ({ ariaSnapshot: async () => '- heading "Find tables"' }),
    } as unknown as Page;
    expect((await observePage(page)).site?.recipes).toEqual([
      { recipe_id: second.recipe_id, name: 'Find tables', version: 2, parameters: ['party'], read_only: true },
    ]);
    expect((await observePage(page)).site).toBeUndefined();
    expect(recipeCheckKey(old!, { party: '2', date: '2026-10-15' })).toBe(
      recipeCheckKey(old!, { date: '2026-10-15', party: '2' }),
    );
    expect(recipeCheckKey(old!, { party: '3', date: '2026-10-15' })).not.toBe(
      recipeCheckKey(old!, { party: '2', date: '2026-10-15' }),
    );
    expect(recipeCheckKey(old!, { party: '2', date: '2026-10-16' })).not.toBe(
      recipeCheckKey(old!, { party: '2', date: '2026-10-15' }),
    );
    expect(recipeCheckKey({ ...old!, version: 2 }, { party: '2' })).not.toBe(recipeCheckKey(old!, { party: '2' }));
    await expect(saveBrowserRecipe(context, { ...input, last_action: 1 })).rejects.toThrow();
    const navigation = {
      action: { kind: 'navigate', url: 'https://fixture.example/search' },
      targets: [],
      before: { url: 'nullblank' },
      after: { url: 'https://fixture.example/search', heading: 'Find tables' },
      readOnly: true,
    };
    await db.run(
      'INSERT INTO gws_ea_browser_action_trace VALUES(?,?,?,?,?)',
      'job-store',
      1,
      'request-store',
      JSON.stringify(navigation),
      new Date().toISOString(),
    );
    const fromBlank = await saveBrowserRecipe(context, {
      name: 'Public navigation',
      first_action: 1,
      last_action: 1,
      parameters: [],
    });
    expect((await loadRecipe(String(fromBlank.recipe_id), db))?.readOnly).toBe(true);
  } finally {
    await closeDb();
  }
});

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
describe.skipIf(!chromePath)('recorded recipes in native Chrome', () => {
  let db: SqliteDriver;
  let browser: Browser;
  let server: Server;
  let page: Page;
  let context: BrowserExecutionContext;
  const html = (heading = 'Find tables', drift = false): string => `<body><h1>${heading}</h1>
    <form method="get" action="http://fixture.example/search"><label>Party size<input name="party" value="2" ${drift ? 'oninput="this.value=4"' : ''}></label><input type="hidden" name="venue" value="venue-A"><button>Search</button></form>
    <button onclick="window.commits=(window.commits||0)+1">Confirm reservation</button>
    <input type="password" aria-label="Password"></body>`;
  beforeEach(async () => {
    db = new SqliteDriver(new Database(':memory:'));
    await db.exec(
      "CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('job-1');",
    );
    await browserSiteLeasesMigration.up(db);
    await browserRecipesMigration.up(db);
    server = createServer((req, res) => {
      if (!req.url?.startsWith('http://fixture.example/')) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(html());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string' || !chromePath) throw new Error('Native fixture unavailable');
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      proxy: { server: `http://127.0.0.1:${address.port}` },
      args: ['--disable-quic', '--proxy-bypass-list=<-loopback>'],
    });
    page = await browser.newPage();
    await page.goto('http://fixture.example/search');
    context = {
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
  });
  afterEach(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await db?.close();
  });
  async function target(name: string, ordinal = 0): Promise<BrowserRef> {
    const observation = await observePage(page);
    const line = observation.snapshot
      .split('\n')
      .filter((value) => value.includes(JSON.stringify(name)) && value.includes('[ref='))[ordinal];
    const ref = line && /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1];
    if (!ref) throw new Error(`Missing ${name} in ${observation.snapshot}`);
    return { ref, generation: observation.generation };
  }
  it('pins every batch target before checkpoints and replays a real GET search', async () => {
    await page.goto('http://fixture.example/search?venue=venue-A');
    const observation = await observePage(page);
    const find = (name: string): BrowserRef => {
      const line = observation.snapshot
        .split('\n')
        .find((value) => value.includes(JSON.stringify(name)) && value.includes('[ref='));
      const ref = line && /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1];
      if (!ref) throw new Error('Missing fixture ref');
      return { ref, generation: observation.generation };
    };
    const result = await executeBrowserBatch(context, {
      actions: [
        { kind: 'type', ...find('Party size'), text: '2' },
        { kind: 'click', ...find('Search') },
      ],
    });
    expect(result).toMatchObject({
      reason: 'navigated',
      actions: [
        { status: 'completed', trace_index: 0 },
        { status: 'completed', trace_index: 1 },
      ],
    });
    const saved = await saveBrowserRecipe(context, {
      name: 'GET search',
      first_action: 0,
      last_action: 1,
      parameters: [{ name: 'party', action_index: 0 }],
    });
    await executeBrowserBatch(
      context,
      { actions: [{ kind: 'navigate', url: 'http://fixture.example/search?venue=venue-A' }] },
      { record: false },
    );
    expect(
      await executeRecipe(
        context,
        { recipe_id: saved.recipe_id, parameters: { party: '3' } },
        { page, readOnly: true, record: false },
      ),
    ).toMatchObject({ status: 'completed' });
    expect(page.url()).toBe('http://fixture.example/search?party=3&venue=venue-A');
    await executeBrowserBatch(
      context,
      { actions: [{ kind: 'navigate', url: 'http://fixture.example/search?venue=foreign' }] },
      { record: false },
    );
    expect(
      await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: { party: '4' } }, { record: false }),
    ).toMatchObject({
      status: 'checkpoint_failed',
      step: 0,
      expected: { url: 'http://fixture.example/search?venue=venue-A' },
      found: { url: 'http://fixture.example/search?venue=foreign' },
    });
  });
  it('stores the exact accessible name, duplicate ordinal and nested frame path', async () => {
    await page.setContent(
      '<body><h1>Frame page</h1><iframe srcdoc="<input aria-label=Guest><input aria-label=Guest>"></iframe></body>',
    );
    await page.frames()[1].getByRole('textbox', { name: 'Guest', exact: true }).nth(1).waitFor();
    await executeBrowserBatch(context, { actions: [{ kind: 'type', ...(await target('Guest', 1)), text: '7' }] });
    const saved = await saveBrowserRecipe(context, {
      name: 'Frame input',
      first_action: 0,
      last_action: 0,
      parameters: [{ name: 'guest', action_index: 0 }],
    });
    expect((await loadRecipe(String(saved.recipe_id), db))?.steps[0].targets[0]).toMatchObject({
      role: 'textbox',
      name: 'Guest',
      ordinal: 1,
      count: 2,
      framePath: [0],
    });
    expect(await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: { guest: '8' } })).toMatchObject({
      status: 'completed',
    });
    expect(await page.frames()[1].getByRole('textbox', { name: 'Guest', exact: true }).nth(1).inputValue()).toBe('8');
    expect(await page.frames()[1].getByRole('textbox', { name: 'Guest', exact: true }).nth(0).inputValue()).toBe('');
  });
  it('records global indices across batches, replays parameters and stops before the purchase press', async () => {
    const first = await executeBrowserBatch(context, {
      actions: [{ kind: 'type', ...(await target('Party size')), text: '2' }],
    });
    expect(first.actions).toMatchObject([{ trace_index: 0, status: 'completed' }]);
    const stopped = await executeBrowserBatch(context, {
      actions: [{ kind: 'click', ...(await target('Confirm reservation')) }],
    });
    expect(stopped.actions).toMatchObject([{ trace_index: 1, status: 'stopped', reason: 'purchase_control' }]);
    const saved = await saveBrowserRecipe(context, {
      name: 'Reserve',
      first_action: 0,
      last_action: 1,
      parameters: [{ name: 'party', action_index: 0 }],
    });
    expect(saved).toMatchObject({ status: 'saved', version: 1, parameters: ['party'] });
    const id = String(saved.recipe_id);
    const recipe = await loadRecipe(id, db);
    expect(recipe?.steps[0].targets[0]).toMatchObject({
      role: 'textbox',
      name: 'Party size',
      ordinal: 0,
      framePath: [],
    });
    const result = await executeRecipe(context, { recipe_id: id, parameters: { party: '3' } });
    expect(result).toMatchObject({
      status: 'reached_commit_point',
      target: { generation: expect.any(Number), ref: expect.any(String) },
    });
    expect(await page.getByRole('textbox', { name: 'Party size', exact: true }).inputValue()).toBe('3');
    expect(await page.evaluate('window.commits||0')).toBe(0);
    expect(recipeCheckKey(recipe!, { party: '3' })).not.toBe(recipeCheckKey(recipe!, { party: '4' }));
    const replacement = await saveBrowserRecipe(context, {
      name: 'Reserve',
      first_action: 0,
      last_action: 1,
      parameters: [{ name: 'party', action_index: 0 }],
    });
    expect(replacement).toMatchObject({ version: 2 });
    expect((await loadRecipe(id, db))?.version).toBe(1);
  });
  it('returns the actual commit button when a recorded Enter would submit a purchase form', async () => {
    await page.setContent(
      '<body><h1>Reservation review</h1><form method="post" action="/confirmbooking"><input aria-label="Guest" name="guest"><button>Confirm reservation</button></form></body>',
    );
    expect(
      await executeBrowserBatch(context, { actions: [{ kind: 'key', ...(await target('Guest')), key: 'Enter' }] }),
    ).toMatchObject({ reason: 'purchase_control' });
    const saved = await saveBrowserRecipe(context, {
      name: 'Enter reservation',
      first_action: 0,
      last_action: 0,
      parameters: [],
    });
    const replay = await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: {} });
    expect(replay).toMatchObject({ status: 'reached_commit_point' });
    const current = replay.target as BrowserRef;
    expect(await page.getByRef(current.ref).evaluate((node) => node.tagName)).toBe('BUTTON');
  });
  it('binds an exact accessible slot name and the actual selected link href', async () => {
    const slots =
      '<body><h1>Slots</h1><a href="/r/slots?slot=7&venue=venue-A">7:00 PM</a><a href="/r/slots?slot=8&venue=venue-A">8:00 PM</a></body>';
    await page.setContent(slots);
    await executeBrowserBatch(context, { actions: [{ kind: 'click', ...(await target('7:00 PM')) }] });
    const saved = await saveBrowserRecipe(context, {
      name: 'Selected slot',
      first_action: 0,
      last_action: 0,
      parameters: [{ name: 'slot', action_index: 0 }],
    });
    expect(await loadRecipe(String(saved.recipe_id), db)).toMatchObject({
      sourceJobId: 'job-1',
      firstAction: 0,
      lastAction: 0,
      parameters: [{ name: 'slot', kind: 'target_name', recordedValue: '7:00 PM' }],
    });
    await executeBrowserBatch(
      context,
      { actions: [{ kind: 'navigate', url: 'http://fixture.example/search' }] },
      { record: false },
    );
    await page.setContent(slots);
    expect(
      await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: { slot: '8:00 PM' } }, { record: false }),
    ).toMatchObject({ status: 'completed' });
    expect(page.url()).toBe('http://fixture.example/r/slots?slot=8&venue=venue-A');
    await executeBrowserBatch(
      context,
      { actions: [{ kind: 'navigate', url: 'http://fixture.example/search' }] },
      { record: false },
    );
    await page.setContent(slots.replace('slot=8&venue=venue-A', 'slot=8&venue=venue-A&unexpected=1'));
    expect(
      await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: { slot: '8:00 PM' } }, { record: false }),
    ).toMatchObject({ status: 'checkpoint_failed', found: { target_url: 'origin, path or query keys changed' } });
    expect(page.url()).toBe('http://fixture.example/search');
  });
  it('reports heading drift and filled-value drift with the current observation', async () => {
    await executeBrowserBatch(context, { actions: [{ kind: 'type', ...(await target('Party size')), text: '2' }] });
    const saved = await saveBrowserRecipe(context, {
      name: 'Find',
      first_action: 0,
      last_action: 0,
      parameters: [{ name: 'party', action_index: 0 }],
    });
    await page.setContent(html('Different page'));
    expect(await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: { party: '3' } })).toMatchObject({
      status: 'checkpoint_failed',
      step: 0,
      expected: expect.anything(),
      found: expect.anything(),
      observation: { snapshot: expect.stringContaining('Different page') },
    });
    await page.setContent(html('Find tables', true));
    expect(await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: { party: '3' } })).toMatchObject({
      status: 'checkpoint_failed',
      step: 0,
      expected: { input_values: ['3'] },
      found: { input_values: ['4'] },
    });
    await page.setContent(
      html('Find tables').replace('name="party"', 'name="party" oninput="this.value=\'host-secret-fixture\'"'),
    );
    registerPageSecret(page, 'host-secret-fixture');
    const secretEcho = await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: { party: '3' } });
    expect(secretEcho).toMatchObject({ status: 'checkpoint_failed', found: { input_values: ['[redacted]'] } });
    expect(JSON.stringify(secretEcho)).not.toContain('host-secret-fixture');
  });
  it('does not save secret-field contents and distinguishes read-only completion from an actual commit point', async () => {
    await executeBrowserBatch(context, {
      actions: [{ kind: 'type', ...(await target('Password')), text: 'must-not-persist' }],
    });
    await expect(
      saveBrowserRecipe(context, { name: 'Secret', first_action: 0, last_action: 0, parameters: [] }),
    ).rejects.toThrow();
    expect(JSON.stringify(await db.all('SELECT * FROM gws_ea_browser_action_trace'))).not.toContain('must-not-persist');
    await executeBrowserBatch(context, { actions: [{ kind: 'type', ...(await target('Party size')), text: '2' }] });
    const saved = await saveBrowserRecipe(context, {
      name: 'Availability',
      first_action: 1,
      last_action: 1,
      parameters: [{ name: 'party', action_index: 1 }],
    });
    expect((await loadRecipe(String(saved.recipe_id), db))?.readOnly).toBe(true);
    expect(
      await executeRecipe(
        context,
        { recipe_id: saved.recipe_id, parameters: { party: '3' } },
        { page, readOnly: true, record: false },
      ),
    ).toMatchObject({ status: 'completed' });
    await page.locator('form').evaluate((form) => {
      (form as unknown as { method: string }).method = 'post';
    });
    expect(
      await executeRecipe(
        context,
        { recipe_id: saved.recipe_id, parameters: { party: '4' } },
        { page, readOnly: true, record: false },
      ),
    ).toMatchObject({ status: 'checkpoint_failed', found: { reason: 'unsupported_merchant' } });
    await page
      .getByRole('textbox', { name: 'Party size', exact: true })
      .evaluate((input) => input.setAttribute('type', 'password'));
    expect(
      await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: { party: 'never-fill' } }),
    ).toMatchObject({ status: 'checkpoint_failed' });
    expect(await page.locator('input[name=party]').inputValue()).toBe('3');
  });
  it('measures a five-action native batch and its checked replay on the same fixture', async () => {
    const ref = await target('Party size');
    const started = performance.now();
    expect(
      await executeBrowserBatch(context, {
        actions: [
          { kind: 'type', ...ref, text: '2' },
          { kind: 'key', ...ref, key: 'Tab' },
          { kind: 'scroll', direction: 'down', amount: 1 },
          { kind: 'wait_for', text: 'Find tables' },
          { kind: 'observe' },
        ],
      }),
    ).toMatchObject({ status: 'completed' });
    const batchMs = performance.now() - started;
    const saved = await saveBrowserRecipe(context, {
      name: 'Five actions',
      first_action: 0,
      last_action: 4,
      parameters: [{ name: 'party', action_index: 0 }],
    });
    const replayStarted = performance.now();
    expect(await executeRecipe(context, { recipe_id: saved.recipe_id, parameters: { party: '3' } })).toMatchObject({
      status: 'completed',
    });
    console.info(
      'Native recipe fixture timing',
      JSON.stringify({
        batch_with_trace_ms: Math.round(batchMs),
        checked_replay_ms: Math.round(performance.now() - replayStarted),
        actions: 5,
      }),
    );
  });
});
