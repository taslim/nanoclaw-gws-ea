import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { recordWebAlias } from '../gws-ea-profile/testing/web-alias.js';
import './index.js';
import { executeBrowserBatch, validateBrowserBatch } from './executor.js';
import type { BrowserExecutionContext } from './actions.js';
import { registerPageSecret } from './page-privacy.js';

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
    locator: () => ({ ariaSnapshotJSON: async () => [{ role: 'document' }] }),
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
  const opening = (url: string) => ({ actions: [{ kind: 'navigate', url }] });
  const choosing = (value: string) => ({ actions: [{ kind: 'select', ref: 'e1', generation: 1, value }] });
  const inputs = (...values: string[]) => ({
    actions: [
      { kind: 'form_input', fields: values.map((value, index) => ({ ref: `e${index + 1}`, generation: 1, value })) },
    ],
  });

  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await getDb().run(
      `UPDATE gws_ea_profile SET assistant_first_name = ?, assistant_workspace_email = ? WHERE singleton = 1`,
      'Juno',
      'juno@corp.example',
    );
  });

  afterEach(async () => {
    await closeDb();
  });

  it('stops a batch that types, selects or opens it in any spelling: alias_unavailable without an alias, then a refusal naming the alias', async () => {
    const giving = [
      typing('Juno@corp.example'),
      typing('Reach me at juno+orders@corp.example.'),
      inputs('Juno', 'juno@corp.example'),
      opening('https://offers.example/join?email=Juno%2Borders%40corp.example&list=weekly'),
      opening('https://offers.example/join/juno@corp.example'),
      choosing('juno@corp.example'),
    ];
    // Before any action runs: the context's page is never opened.
    for (const payload of giving)
      expect(await executeBrowserBatch(context, payload), JSON.stringify(payload)).toEqual({
        status: 'stopped',
        reason: 'alias_unavailable',
        repeat_safe: true,
      });
    await recordWebAlias('onuj@corp.example');
    for (const payload of giving)
      await expect(executeBrowserBatch(context, payload), JSON.stringify(payload)).rejects.toMatchObject({
        code: 'invalid-args',
        message: expect.stringContaining('onuj@corp.example'),
      });
  });

  it('runs a batch that gives the alias in any spelling, another address or none', async () => {
    await expect(executeBrowserBatch(context, typing('Table for four'))).rejects.toBe(opened);
    await recordWebAlias('onuj@corp.example');
    for (const payload of [
      typing('onuj@corp.example'),
      typing('Onuj+Orders@corp.example'),
      typing('morgan@principal.example'),
      opening('https://offers.example/join?email=onuj%40corp.example'),
      choosing('Weekly'),
    ])
      await expect(executeBrowserBatch(context, payload), JSON.stringify(payload)).rejects.toBe(opened);
  });
});

// These fake pages have no native DOM; Chrome suites exercise collection. Keep actual taint and redaction.
vi.mock('./control-facts.js', async (original) => ({
  ...(await original<typeof import('./control-facts.js')>()),
  readPageSecretValues: vi.fn(async () => []),
}));
