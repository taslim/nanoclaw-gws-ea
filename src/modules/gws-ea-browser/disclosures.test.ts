import { configureBrowserAccess } from './testing/browser-access.js';
import { useAvailableBrowser } from './testing/browser-runtime.js';
/** Personal-data disclosures against the real privacy store, central DB and delivery path. */
import fs from 'node:fs';
import type { Frame } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return `${tmpdir()}/browser-disclosures-tests`;
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { resolveSystemSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { BrowserStore, type BrowserJob } from './db.js';
import { personalDataStop, type FieldFrames } from './disclosures.js';
import type { BrowserAction } from './actions.js';
import { deliverAction, refusal } from './testing/delivery-answer.js';

const MOBILE = '+1 415 555 0134';
const HOME = '123 Main Street, Springfield';
const OSTERIA = 'https://www.osteria.example/reserve';
const WINNER = 'https://winner.example/claim';

let main: Session;
let browser: Session;
let job: BrowserJob;
let mobile: string;
let home: string;

/** Send one request as main's record_disclosure tool would, and read the host's one answer. */
const send = (from: Session, fields: Record<string, unknown>) => deliverAction(from, 'record_disclosure', fields);

const type = (text: string, ref = 'e1'): BrowserAction => ({ kind: 'type', ref, generation: 1, text });
const fill = (...values: string[]): BrowserAction => ({
  kind: 'form_input',
  fields: values.map((value, index) => ({ ref: `e${index + 1}`, generation: 1, value })),
});
const navigate = (url: string): BrowserAction => ({ kind: 'navigate', url });
/** Fields e1 to e3 as pinned on a page at `url`: each in the page's own frame, unless `frames` names another. */
const fieldsOn = (url: string, frames: Readonly<Record<string, string>> = {}): FieldFrames =>
  new Map(['e1', 'e2', 'e3'].map((ref) => [ref, { frame: { url: () => frames[ref] ?? url } as unknown as Frame }]));
const stop = (url: string, actions: BrowserAction[], of: BrowserJob = job) =>
  personalDataStop(getDb(), of.id, actions, fieldsOn(url));

beforeEach(async () => {
  useAvailableBrowser();
  await runMigrations(await initTestDb());
  for (const id of ['main', 'browser', 'research', 'other'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1`,
    'main',
    'browser',
  );
  await addPrincipalAddress('morgan@example.test');
  mobile = (await addPrivateValue({ label: 'Mobile', kind: 'phone', value: MOBILE })).id;
  home = (await addPrivateValue({ label: 'Home', kind: 'address', value: HOME })).id;
  fs.mkdirSync(`${root}/browser`, { recursive: true, mode: 0o700 });
  await configureBrowserAccess(`${root}/browser`);
  process.env.GWS_EA_BROWSER_ROOT = `${root}/browser`;
  main = (await resolveSystemSession('main', 'system:test:main')).session;
  browser = (await resolveSystemSession('browser', 'system:a2a:main:dinner')).session;
  job = (await new BrowserStore().jobForSession(browser))!;
});
afterEach(async () => {
  delete process.env.GWS_EA_BROWSER_ROOT;
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('record_disclosure', () => {
  it('records one site and one stored value for the errand, by reference and never as a copy of the value', async () => {
    const recorded = {
      ok: true,
      data: {
        status: 'recorded',
        thread: browser.thread_id,
        site: 'osteria.example',
        value_id: mobile,
        kind: 'phone',
        label: 'Mobile',
      },
    };
    expect(await send(main, { thread: browser.thread_id, site: OSTERIA, value_id: mobile })).toMatchObject(recorded);
    // A repeat, the site named as a bare domain, changes nothing.
    expect(await send(main, { thread: browser.thread_id, site: 'Osteria.example', value_id: mobile })).toMatchObject(
      recorded,
    );
    expect(await getDb().all('SELECT job_id, site, value_id FROM gws_ea_browser_disclosures')).toEqual([
      { job_id: job.id, site: 'osteria.example', value_id: mobile },
    ]);
    // The value itself stays in the privacy store alone: no table holds the number however it is written. A
    // timestamp's milliseconds may read 555, so the check is the whole number.
    const tables = await getDb().all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'gws_ea_private_values'",
    );
    for (const { name } of tables)
      expect(JSON.stringify(await getDb().all(`SELECT * FROM "${name}"`)), name).not.toMatch(/415\D{0,2}555\D?0134/u);
  });

  it("refuses a value the store does not hold, one of the principal's addresses, a site that is not public, and an unknown field", async () => {
    const theirs = (await addPrivateValue({ label: 'Personal', kind: 'email', value: 'Morgan+home@example.test' })).id;
    const thread = browser.thread_id;
    expect(refusal(await send(main, { thread, site: OSTERIA, value_id: 'pv-000000000000' }))).toMatch(
      /No stored private value/u,
    );
    expect(refusal(await send(main, { thread, site: OSTERIA, value_id: theirs }))).toMatch(/sign/u);
    for (const site of ['localhost', 'http://127.0.0.1/reserve', 'not a site', 'mailto:host@osteria.example'])
      expect(refusal(await send(main, { thread, site, value_id: mobile })), site).toMatch(/public website/u);
    expect(refusal(await send(main, { thread, site: OSTERIA, value_id: mobile, value: MOBILE }))).toMatch(
      /Unknown record_disclosure field/u,
    );
    expect(await getDb().all('SELECT * FROM gws_ea_browser_disclosures')).toEqual([]);
  });

  it("refuses an errand that is not the caller's own or no longer live, and any group without browser access", async () => {
    expect(refusal(await send(main, { thread: 'system:a2a:main:unknown', site: OSTERIA, value_id: mobile }))).toBe(
      'No live browser job of yours exists for that thread.',
    );
    const other = (await resolveSystemSession('other', 'system:test:other')).session;
    expect(refusal(await send(other, { thread: browser.thread_id, site: OSTERIA, value_id: mobile }))).toBe(
      'Only an agent with browser access may manage browser jobs.',
    );
    await getDb().run('UPDATE gws_ea_browser_jobs SET cancelled = 1 WHERE id = ?', job.id);
    expect(refusal(await send(main, { thread: browser.thread_id, site: OSTERIA, value_id: mobile }))).toBe(
      'No live browser job of yours exists for that thread.',
    );
    expect(await getDb().all('SELECT * FROM gws_ea_browser_disclosures')).toEqual([]);
  });
});

describe('what a batch gives each site', () => {
  beforeEach(async () => {
    expect(await send(main, { thread: browser.thread_id, site: OSTERIA, value_id: mobile })).toMatchObject({
      ok: true,
    });
  });

  it('lets the disclosed value go to its site, however it is written or split', async () => {
    const batches: BrowserAction[][] = [
      [fill('Morgan Ellery', '(415) 555-0134')],
      [type('+14155550134'), { kind: 'select', ref: 'e2', generation: 1, value: '2' }],
      [fill('415', '555', '0134')],
      [navigate('https://osteria.example/reserve?party=2&tel=415-555-0134')],
      [fill('Table for two')],
    ];
    for (const actions of batches) expect(await stop(OSTERIA, actions), JSON.stringify(actions)).toBeUndefined();
  });

  it('refuses the disclosed value on any other site, and a value main never disclosed on every site: typed, split, carried in an address, or typed after opening one', async () => {
    const refusals: Array<readonly [string, BrowserAction[]]> = [
      // The disclosed mobile number anywhere but its site.
      [WINNER, [type('415 555 0134')]],
      [OSTERIA, [navigate('https://winner.example/claim?mobile=%2B1%20415%20555%200134')]],
      [OSTERIA, [navigate(WINNER), type('(415) 555-0134')]],
      // Split across area-code and number fields, or across the batch's actions.
      [WINNER, [fill('415', '5550134')]],
      [WINNER, [fill('415', '555', '0134')]],
      [WINNER, [type('415', 'e1'), type('555', 'e2'), type('0134', 'e3')]],
      // The home address main never disclosed, on the site it disclosed the mobile number to as well.
      [OSTERIA, [type('Please deliver to 123 Main St.')]],
      [WINNER, [type('Please deliver to 123 Main St.')]],
      [OSTERIA, [navigate('https://maps.example/directions?from=123%20Main%20Street&to=Osteria')]],
      [OSTERIA, [navigate('https://maps.example/directions/123-main-st/osteria')]],
    ];
    for (const [url, actions] of refusals)
      expect(await stop(url, actions), `${url} ${JSON.stringify(actions)}`).toBe('personal_data');
    // A subdomain is its site: the disclosure names the registrable domain.
    expect(await stop('https://book.osteria.example/', [type('415.555.0134')])).toBeUndefined();
  });

  it("gives a field in another site's frame to that site, and one in a frame with no address of its own to none", async () => {
    const offers = 'https://offers.example/sms';
    const inFrame = (frame: string): FieldFrames => fieldsOn(OSTERIA, { e2: frame });
    const typed = (actions: BrowserAction[], frames: FieldFrames) => personalDataStop(getDb(), job.id, actions, frames);
    expect(await typed([type('(415) 555-0134', 'e2')], inFrame(offers))).toBe('personal_data');
    expect(await typed([fill('Morgan Ellery', '(415) 555-0134')], inFrame(offers))).toBe('personal_data');
    // The page's own field takes it, as does a frame on the disclosed site itself.
    expect(await typed([type('(415) 555-0134', 'e1')], inFrame(offers))).toBeUndefined();
    expect(await typed([type('(415) 555-0134', 'e2')], inFrame('https://book.osteria.example/widget'))).toBeUndefined();
    for (const frame of ['about:blank', 'about:srcdoc', 'data:text/html,<input>'])
      expect(await typed([type('(415) 555-0134', 'e2')], inFrame(frame)), frame).toBe('personal_data');
  });

  it("refuses the principal's address on every site, in any spelling that reaches their mailbox, split or encoded", async () => {
    const batches: BrowserAction[][] = [
      [type('morgan@example.test')],
      [type('Morgan+Offers@Example.test')],
      [fill('morgan', 'example.test')],
      [navigate('https://winner.example/newsletter?email=morgan%2Boffers%40example.test')],
    ];
    for (const actions of batches) {
      expect(await stop(WINNER, actions), JSON.stringify(actions)).toBe('personal_data');
      expect(await stop(OSTERIA, actions), JSON.stringify(actions)).toBe('personal_data');
    }
    expect(await stop(WINNER, [type('onuj@assistant.example')])).toBeUndefined();
  });
});

describe('a disclosure stays with the group whose errand it was recorded for', () => {
  it("lets no other group's errand use main's disclosure, nor record one against main's errand", async () => {
    await configureBrowserAccess(`${root}/browser`, ['research']);
    const research = (await resolveSystemSession('research', 'system:test:research')).session;
    const errand = (await resolveSystemSession('browser', 'system:a2a:research:dinner')).session;
    const theirs = (await new BrowserStore().jobForSession(errand))!;
    expect(await send(main, { thread: browser.thread_id, site: OSTERIA, value_id: mobile })).toMatchObject({
      ok: true,
    });
    expect(await stop(OSTERIA, [type(MOBILE)], job)).toBeUndefined();
    expect(await stop(OSTERIA, [type(MOBILE)], theirs)).toBe('personal_data');
    expect(refusal(await send(research, { thread: browser.thread_id, site: OSTERIA, value_id: home }))).toBe(
      'No live browser job of yours exists for that thread.',
    );
    expect(await send(research, { thread: errand.thread_id, site: OSTERIA, value_id: mobile })).toMatchObject({
      ok: true,
      data: { status: 'recorded', thread: errand.thread_id },
    });
    expect(await stop(OSTERIA, [type(MOBILE)], theirs)).toBeUndefined();
    expect(await stop(OSTERIA, [type(HOME)], job)).toBe('personal_data');
  });
});
