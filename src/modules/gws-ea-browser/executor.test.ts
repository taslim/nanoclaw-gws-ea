import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { closeDb, createAgentGroup, createSession, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import '../gws-ea-profile/index.js';
import { recordWebAlias } from '../gws-ea-profile/testing/web-alias.js';
import './index.js';
import { BrowserStore } from './db.js';
import { executeBrowserBatch, isSecretBrowserField, validateBrowserBatch } from './executor.js';
import type { PinnedBrowserRef } from './observe.js';
import type { BrowserExecutionContext } from './queue.js';
import { registerPageSecret } from './observe.js';

// A fake page has no isolated worlds, so its scan for secret values would fail closed; native suites cover the
// scan. The host's own secret on a page still refuses a screenshot here.
vi.mock('./observe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./observe.js')>()),
  pageMayShowSecret: vi.fn(async () => false),
}));

it('rejects unknown actions and clipboard shortcuts without running a partial batch', () => {
  expect(() =>
    validateBrowserBatch({ actions: [{ kind: 'observe' }, { kind: 'evaluate', expression: 'alert(1)' }] }),
  ).toThrow();
  for (const key of ['Control+Shift+V', 'Meta+Shift+V', 'Meta+C', 'Control+X', 'Shift+Insert'])
    expect(() => validateBrowserBatch({ actions: [{ kind: 'key', ref: 'e1', generation: 1, key }] })).toThrow();
  expect(() => validateBrowserBatch({ actions: [{ kind: 'key', ref: 'e1', generation: 1, key: 'Meta+V' }] })).toThrow();
  expect(() =>
    validateBrowserBatch({ actions: [{ kind: 'type', ref: 'e1', generation: 1, text: 'hello', selector: 'body' }] }),
  ).toThrow();
  expect(
    validateBrowserBatch({ actions: [{ kind: 'navigate', url: 'https://example.com/' }, { kind: 'observe' }] }),
  ).toEqual({ actions: [{ kind: 'navigate', url: 'https://example.com/' }, { kind: 'observe' }] });
});

it('returns screenshots in a top-level image envelope linked to their action, while retaining secret refusal', async () => {
  let screenshots = 0;
  const page = {
    url: () => 'about:blank',
    context: () => ({
      newCDPSession: async () => ({ on() {}, send: async () => ({ targetInfo: { targetId: 'page' } }) }),
      browser: () => ({ once() {}, newBrowserCDPSession: async () => ({ on() {}, send: async () => undefined }) }),
    }),
    on() {},
    off() {},
    once() {},
    frames: () => [],
    mainFrame: () => ({}),
    isClosed: () => false,
    locator: () => ({ ariaSnapshot: async () => '- document' }),
    screenshot: async () => {
      screenshots++;
      return Buffer.from('screenshot');
    },
  } as unknown as Page;
  const context = {
    job: { id: 'job' },
    page: async () => page,
    assertActive: async () => undefined,
    remaining: () => 90_000,
    signal: new AbortController().signal,
    store: { db: {} },
  } as unknown as BrowserExecutionContext;
  const result = await executeBrowserBatch(
    context,
    {
      actions: [{ kind: 'screenshot' }, { kind: 'observe' }, { kind: 'screenshot' }],
    },
    { record: false },
  );
  expect(result).toMatchObject({
    status: 'completed',
    actions: [
      { index: 0, status: 'completed', image_index: 0 },
      { index: 1, status: 'completed' },
      { index: 2, status: 'completed', image_index: 1 },
    ],
    images: [
      { mime_type: 'image/png', data: 'c2NyZWVuc2hvdA==' },
      { mime_type: 'image/png', data: 'c2NyZWVuc2hvdA==' },
    ],
  });
  expect(JSON.stringify(result.actions)).not.toContain('c2NyZWVuc2hvdA==');
  registerPageSecret(page, 'password');
  const refused = await executeBrowserBatch(context, { actions: [{ kind: 'screenshot' }] }, { record: false });
  expect(refused).toMatchObject({ status: 'stopped', reason: 'secret_field' });
  expect(refused.images).toBeUndefined();
  expect(screenshots).toBe(2);
});

it('refuses ordinary typing into new, confirming and show-password-toggled credential fields', async () => {
  const field = (attributes: Record<string, string>) =>
    ({
      element: {
        evaluate: async (read: (node: unknown) => unknown) =>
          read({ getAttribute: (name: string) => attributes[name] ?? null }),
      },
    }) as unknown as Pick<PinnedBrowserRef, 'element'>;
  const secret: ReadonlyArray<Record<string, string>> = [
    { type: 'text', name: 'password', autocomplete: 'new-password' },
    { type: 'text', name: 'confirm_password' },
    { type: 'text', id: 'currentPassword', autocomplete: 'current-password' },
    { type: 'text', 'aria-label': 'Repeat password' },
    { type: 'password', name: 'pin' },
  ];
  const ordinary: ReadonlyArray<Record<string, string>> = [
    { type: 'email', name: 'email', autocomplete: 'email' },
    { type: 'text', name: 'passenger_name' },
  ];
  for (const attributes of secret) expect(await isSecretBrowserField(field(attributes))).toBe(true);
  for (const attributes of ordinary) expect(await isSecretBrowserField(field(attributes))).toBe(false);
});

describe("the assistant's own address in a site field (KTD14, R23)", () => {
  const opened = new Error('The batch opened its page');
  const context = {
    page: async () => {
      throw opened;
    },
  } as unknown as BrowserExecutionContext;
  const typing = (text: string) => ({
    actions: [{ kind: 'observe' }, { kind: 'type', ref: 'e1', generation: 1, text }],
  });

  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await getDb().run(
      'UPDATE gws_ea_profile SET assistant_display_name = ?, assistant_workspace_email = ? WHERE singleton = 1',
      'Juno',
      'juno@corp.example',
    );
  });

  afterEach(async () => {
    await closeDb();
  });

  it('stops a batch that would give it to a site with alias_unavailable while no alias is recorded, before any action runs', async () => {
    for (const payload of [
      typing('Juno@corp.example'),
      typing('Reach me at juno+orders@corp.example.'),
      {
        actions: [
          {
            kind: 'form_input',
            fields: [
              { ref: 'e1', generation: 1, value: 'Juno' },
              { ref: 'e2', generation: 1, value: 'juno@corp.example' },
            ],
          },
        ],
      },
    ])
      expect(await executeBrowserBatch(context, payload)).toEqual({
        status: 'stopped',
        reason: 'alias_unavailable',
        repeat_safe: true,
      });
  });

  it('refuses it once an alias is recorded, naming the alias to give instead', async () => {
    await recordWebAlias('onuj@corp.example');
    await expect(executeBrowserBatch(context, typing('juno@corp.example'))).rejects.toMatchObject({
      code: 'invalid-args',
      message: expect.stringContaining('onuj@corp.example'),
    });
  });

  it('runs a batch that types the alias in any spelling, another address or none', async () => {
    await expect(executeBrowserBatch(context, typing('Table for four'))).rejects.toBe(opened);
    await recordWebAlias('onuj@corp.example');
    for (const text of ['onuj@corp.example', 'Onuj+Orders@corp.example', 'morgan@principal.example'])
      await expect(executeBrowserBatch(context, typing(text)), text).rejects.toBe(opened);
  });
});

describe("the principal's personal data in a batch (KTD19, R34)", () => {
  const opened = new Error('The batch reached its page');
  /** A page on `url` the check may read the address of; anything else the batch does with it fails as `opened`. */
  const pageOn = (url: string): Page =>
    new Proxy({} as Page, {
      get: (_page, key) => {
        if (key === 'url') return () => url;
        if (key === 'then') return undefined;
        throw opened;
      },
    });
  const context = (url: string) =>
    ({
      job: { id: 'job-dinner' },
      store: new BrowserStore(),
      page: async () => pageOn(url),
    }) as unknown as BrowserExecutionContext;
  const booking = {
    actions: [
      { kind: 'observe' },
      {
        kind: 'form_input',
        fields: [
          { ref: 'e1', generation: 1, value: 'Morgan Ellery' },
          { ref: 'e2', generation: 1, value: '(415) 555-0134' },
        ],
      },
    ],
  };

  beforeEach(async () => {
    await runMigrations(await initTestDb());
    const now = new Date().toISOString();
    for (const id of ['main', 'browser'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
    await createSession({
      id: 'browser-session',
      agent_group_id: 'browser',
      messaging_group_id: null,
      thread_id: 'system:a2a:main:dinner',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now,
    });
    await getDb().run(
      "INSERT INTO gws_ea_browser_jobs(id,thread_id,browser_session_id,source_agent_group_id,created_at,updated_at) VALUES('job-dinner','system:a2a:main:dinner','browser-session','main',?,?)",
      now,
      now,
    );
  });

  afterEach(async () => {
    await closeDb();
  });

  it('stops a batch that would give a site a stored value no disclosure covers, before any action runs', async () => {
    const mobile = await addPrivateValue({ label: 'Mobile', kind: 'phone', value: '+1 415 555 0134' });
    expect(await executeBrowserBatch(context('https://winner.example/claim'), booking)).toEqual({
      status: 'stopped',
      reason: 'personal_data',
      repeat_safe: true,
    });
    await getDb().run(
      "INSERT INTO gws_ea_browser_disclosures(job_id,site,value_id,created_at) VALUES('job-dinner','osteria.example',?,?)",
      mobile.id,
      new Date().toISOString(),
    );
    await expect(executeBrowserBatch(context('https://osteria.example/reserve'), booking)).rejects.toBe(opened);
    expect(await executeBrowserBatch(context('https://winner.example/claim'), booking)).toMatchObject({
      reason: 'personal_data',
    });
  });

  it('runs a batch that gives no stored value away', async () => {
    await addPrivateValue({ label: 'Mobile', kind: 'phone', value: '+1 415 555 0134' });
    await expect(
      executeBrowserBatch(context('https://winner.example/claim'), {
        actions: [{ kind: 'type', ref: 'e1', generation: 1, text: 'Table for two at 7pm' }],
      }),
    ).rejects.toBe(opened);
  });
});
