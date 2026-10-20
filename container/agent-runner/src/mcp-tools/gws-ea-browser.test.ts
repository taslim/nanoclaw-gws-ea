import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import Ajv from 'ajv';

import { OPERATIONAL_CODES } from '../../../../src/modules/gws-ea-browser/operational-codes.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import {
  browser,
  BROWSER_REQUEST_TIMEOUT_MS,
  cancelWatch,
  credentialForm,
  fillSecret,
  listWatches,
  purchase,
  requestConsent,
  runRecipe,
  saveRecipe,
  signInCode,
  watch,
} from './gws-ea-browser.js';
import { requestStatus } from './request-status.js';
import type { McpToolDefinition } from './types.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

function answer(requestId: string, data: unknown): void {
  getInboundDb()
    .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
    .run(
      `action-resp-${requestId}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId,
        frame: { id: requestId, ok: true, data },
      }),
    );
}

async function call(tool: McpToolDefinition, args: Record<string, unknown>, data: unknown) {
  const waiting = tool.handler(args);
  while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  answer(row.id, data);
  return { result: await waiting, request: JSON.parse(row.content) as Record<string, unknown>, id: row.id };
}

const target = { ref: 'e1', generation: 1 };
const cases: ReadonlyArray<readonly [McpToolDefinition, Record<string, unknown>]> = [
  [browser, { actions: [{ kind: 'observe' }], budget_ms: 90_000 }],
  [fillSecret, { item_handle: 'login-1', field: 'password', target, submit: { ref: 'e2', generation: 1 } }],
  [signInCode, { from: 'principal', target, send: { ref: 'e2', generation: 1 } }],
  [
    credentialForm,
    {
      authority: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
      username: target,
      new_password: { ref: 'e2', generation: 1 },
      confirmation: { ref: 'e3', generation: 1 },
      activate: { ref: 'e4', generation: 1 },
    },
  ],
  [
    credentialForm,
    {
      authority: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
      operation: 'verify',
      code_field: target,
      activate: { ref: 'e2', generation: 1 },
    },
  ],
  [credentialForm, { authority: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', operation: 'reconcile' }],
  [purchase, { target }],
  [purchase, { operation: 'reconcile', attempt_id: 'attempt-1', target }],
  [requestConsent, { stop_id: '0b5c3a52-8f4e-4c1d-9a7b-2e6f1d3c4b5a' }],
  [
    saveRecipe,
    { name: 'Find a table', first_action: 0, last_action: 4, parameters: [{ name: 'party', action_index: 2 }] },
  ],
  [runRecipe, { recipe_id: 'recipe-1', parameters: { party: '4' } }],
  [
    watch,
    {
      site: 'https://restaurant.example/',
      recipe_id: 'recipe-1',
      parameters: { party: '4' },
      venue: { id: 'bistro-123', name: 'Bistro' },
      party_size: 4,
      windows: [{ start: '2026-10-16T19:00:00-07:00', end: '2026-10-16T21:00:00-07:00' }],
      financial: { currency: 'USD', max_total: '50.00' },
      until: '2026-10-16T18:00:00-07:00',
      release: {
        wording: 'Tables are released 30 days ahead at 10:00',
        days_ahead: 30,
        time: '10:00',
        time_zone: 'America/Los_Angeles',
      },
    },
  ],
  [listWatches, {}],
  [cancelWatch, { watch_id: 'watch-1' }],
];

const BROWSER_TOOLS = [
  browser,
  fillSecret,
  credentialForm,
  signInCode,
  purchase,
  requestConsent,
  saveRecipe,
  runRecipe,
  watch,
  listWatches,
  cancelWatch,
];
/** Names the descriptions use that are no answer’s status or reason. */
const NOT_CODES = new Set([
  // An action’s screenshot, by its index among the images.
  'image_index',
  // The observation’s report of what the host did about a cookie banner.
  'cookie_banner',
  // credential_form’s vault state beside its status.
  'left_as_edited',
]);
/** Codes the host records that no browser tool names: the agent never meets them, or reads them for themselves. */
const UNNAMED_CODES = new Set([
  // An error frame, which the agent reads as the tool’s error.
  'error',
  'unknown-command',
  'invalid-args',
  'forbidden',
  'approval-pending',
  'handler-error',
  'transport-error',
  // An action a stop left unrun.
  'not_executed',
  // The host’s own commit and booking requests, and its watch checks and states.
  'committed',
  'not_committed',
  'superseded',
  'authority_unavailable',
  'purchase_blocked',
  'checking',
  'preparing',
  'booking',
  'region_read',
  'ready',
  'failed',
  'unavailable',
  // An answer to main’s relay of a sign-in code.
  'no_wait',
  // Reasons a refusal names, which explain themselves.
  'no_authority',
  'not_disclosed',
  'unsupported_form',
  'form_changed',
  'unsupported_control',
  'login_changed',
  'invalid_request',
  'not_configured',
  'bounds_changed',
  'principal_unavailable',
  'region_not_found',
  'route_changed',
]);
/** Everything the browser agent or a delegating agent reads about the browser, relative to this file. */
const AGENT_FACING_FILES = [
  './gws-ea-browser.ts',
  './gws-ea-browser.instructions.md',
  './gws-ea-browser-delegate.ts',
  '../../../../templates/gws-ea/browser/instructions.md',
  '../../../../templates/gws-ea/browser/README.md',
  '../../../../src/modules/gws-ea-browser/main-guidance.md',
];
/** Every name a schema gives: its property keys, and its const and enum values. */
function schemaNames(schema: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const item of schema) schemaNames(item, names);
  else if (schema && typeof schema === 'object')
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value && typeof value === 'object')
        for (const name of Object.keys(value)) names.add(name);
      if (key === 'const' && typeof value === 'string') names.add(value);
      if (key === 'enum' && Array.isArray(value))
        for (const option of value) if (typeof option === 'string') names.add(option);
      schemaNames(value, names);
    }
  return names;
}

describe('the browser tools', () => {
  it('keeps native error provenance readable through request_status after the original request ends', async () => {
    const metadata = {
      diagnostics: { events: [{ source: 'runtime_error', category: 'execution' }], request_id: 'host-request' },
    };
    getInboundDb()
      .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
      .run(
        'action-resp-act-failed-browser',
        'system',
        new Date().toISOString(),
        JSON.stringify({
          type: 'action_response',
          requestId: 'act-failed-browser',
          frame: {
            id: 'act-failed-browser',
            ok: false,
            error: { code: 'handler-error', message: 'The browser action failed unexpectedly.', metadata },
          },
        }),
      );
    const result = await requestStatus.handler({ request_id: 'act-failed-browser' });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Error: The browser action failed unexpectedly.\n${JSON.stringify({ code: 'handler-error', metadata })}`,
      },
    ]);
  });

  it('sends exactly one native host request with its own action name and returns its answer', async () => {
    for (const [tool, fields] of cases) {
      const data = { status: 'completed', detail: `${tool.tool.name} answered` };
      const { request, result, id } = await call(
        tool,
        { ...fields, action: 'forged', requestId: 'forged', code: 'secret' },
        data,
      );
      expect(getUndeliveredMessages()).toHaveLength(1);
      expect(request).toEqual({ ...fields, action: tool.tool.name, requestId: id });
      expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(data) }] });
      closeSessionDb();
      initTestSessionDb();
    }
  });

  it('returns immediate screenshot images as MCP content with action metadata and no encoded bytes in text', async () => {
    const { result } = await call(
      browser,
      { actions: [{ kind: 'screenshot' }] },
      {
        status: 'completed',
        actions: [{ index: 0, status: 'completed', image_index: 0 }],
        images: [{ mime_type: 'image/png', data: 'c2NyZWVuc2hvdA==' }],
      },
    );
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ status: 'completed', actions: [{ index: 0, status: 'completed', image_index: 0 }] }),
      },
      { type: 'image', mimeType: 'image/png', data: 'c2NyZWVuc2hvdA==' },
    ]);
  });

  it('describes concrete actions, generation refs, outcomes and next moves', () => {
    const actions = browser.tool.inputSchema.properties?.actions as {
      items: { oneOf: Array<{ properties: { kind: { const: string } }; additionalProperties: boolean }> };
    };
    expect(actions.items.oneOf.map((action) => action.properties.kind.const).sort()).toEqual([
      'click',
      'download',
      'form_input',
      'key',
      'navigate',
      'observe',
      'screenshot',
      'scroll',
      'select',
      'type',
      'upload',
      'wait_for',
    ]);
    expect(actions.items.oneOf.every((action) => action.additionalProperties === false)).toBe(true);
    for (const [tool] of cases) {
      expect(tool.tool.description).toContain('request_status');
      expect(tool.tool.description).toMatch(/repeat/iu);
    }
    expect(purchase.tool.description).toContain('confirmed_not_placed');
    expect(fillSecret.tool.inputSchema.properties).not.toHaveProperty('password');
    for (const value of ['password', 'value', 'text', 'item_handle', 'code'])
      expect(credentialForm.tool.inputSchema.properties).not.toHaveProperty(value);
    for (const outcome of [
      'continued',
      'account_created',
      'password_changed',
      'left_as_edited',
      'pending',
      'account_exists',
      'password_rejected',
      'current_password_rejected',
      'verification_requested',
      'outcome_unknown',
      'not_owned',
      'verify',
      'reconcile',
      'inconclusive',
      'nothing_arrived',
      'not_watched',
      'ambiguous',
      'consent_required',
      'request_consent',
    ])
      expect(credentialForm.tool.description).toContain(outcome);
    for (const outcome of ['consent_control', 'consent_required', 'stop_id', 'request_consent', 'personal_data'])
      expect(browser.tool.description).toContain(outcome);
    for (const outcome of ['awaiting_principal', 'approved', 'withdrawn', 'unknown_stop', 'stop_used'])
      expect(requestConsent.tool.description).toContain(outcome);
    expect(signInCode.tool.inputSchema.properties).not.toHaveProperty('code');
  });

  it('lets credential_form submit again only after a consent stop, which submitted nothing', () => {
    const description = credentialForm.tool.description;
    expect(description).toContain(
      'The authority covers one submission: never submit it again, except after consent_required, which submitted nothing:',
    );
    expect(description).toMatch(/approved, submit the form again from a fresh observation with the same authority/u);
  });

  it('takes a watch’s maximum as its only financial bound, and names a fee above it', () => {
    const accepts = new Ajv({ formats: { uri: true, 'date-time': true } }).compile(watch.tool.inputSchema);
    const [, fields] = cases.find(([tool]) => tool === watch)!;
    expect(accepts(fields)).toBe(true);
    // The host reads a paid venue's terms itself, so the browser's own wording of them is no bound.
    expect(accepts({ ...fields, financial: { currency: 'USD', max_total: '50.00', terms: 'No-show fee only' } })).toBe(
      false,
    );
    expect(watch.tool.description).toContain('terms_over_bounds');
  });

  it('refuses a credential_form step the host would refuse, before sending anything', async () => {
    const authority = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
    const ref = (n: number) => ({ ref: `e${n}`, generation: 1 });
    for (const args of [
      { authority, new_password: ref(1) },
      { authority, activate: ref(2) },
      { authority, confirmation: ref(1), activate: ref(2) },
      { authority, new_password: ref(1), code_field: ref(3), activate: ref(2) },
      { authority, operation: 'verify', code_field: ref(3) },
      { authority, operation: 'verify', new_password: ref(1), activate: ref(2) },
      { authority, operation: 'reconcile', activate: ref(2) },
      { authority, operation: 'reconcile', username: ref(1) },
    ]) {
      const result = await credentialForm.handler(args);
      expect(result.isError).toBe(true);
      expect(getUndeliveredMessages()).toEqual([]);
    }
  });

  it('rejects a terms box named by the agent, and asks for consent only by a stop id', () => {
    const credential = new Ajv().compile(credentialForm.tool.inputSchema);
    const ref = (n: number) => ({ ref: `e${n}`, generation: 1 });
    const signup = {
      authority: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
      username: ref(1),
      new_password: ref(2),
      activate: ref(3),
    };
    expect(credential(signup)).toBe(true);
    expect(credential({ ...signup, accept_terms: ref(4) })).toBe(false);
    const consent = new Ajv().compile(requestConsent.tool.inputSchema);
    expect(consent({ stop_id: '0b5c3a52-8f4e-4c1d-9a7b-2e6f1d3c4b5a' })).toBe(true);
    for (const fields of [{}, { stop_id: 'stop-1', approved: true }, { stop_id: 'stop-1', wording: 'I agree' }])
      expect(consent(fields)).toBe(false);
  });

  it('names as outcomes only codes the host records, and every code the agent meets by name', () => {
    const descriptions = BROWSER_TOOLS.map((tool) => tool.tool.description).join('\n');
    const tools = new Set([...BROWSER_TOOLS, requestStatus].map((tool) => tool.tool.name));
    const fields = schemaNames(BROWSER_TOOLS.map((tool) => tool.tool.inputSchema));
    const named = new Set(descriptions.match(/\b[a-z]+(?:_[a-z]+)+\b/gu));
    expect(
      [...named].filter(
        (name) => !OPERATIONAL_CODES.has(name) && !tools.has(name) && !fields.has(name) && !NOT_CODES.has(name),
      ),
    ).toEqual([]);
    for (const code of UNNAMED_CODES) expect(OPERATIONAL_CODES.has(code)).toBe(true);
    expect(
      [...OPERATIONAL_CODES].filter(
        (code) => !UNNAMED_CODES.has(code) && !new RegExp(`(?<![\\w-])${code}(?![\\w-])`, 'u').test(descriptions),
      ),
    ).toEqual([]);
  });

  it('describes the open design with no deny-by-default wording in anything either agent reads', () => {
    for (const file of AGENT_FACING_FILES) {
      const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
      expect({ file, denied: text.match(/unsupported_merchant|supported merchant|reviewed flows only/giu) }).toEqual({
        file,
        denied: null,
      });
    }
    // An unproven purchase or watch booking is unconfirmed now; outcome_unknown stays a credential outcome.
    for (const tool of [purchase, watch, browser]) expect(tool.tool.description).not.toContain('outcome_unknown');
    expect(purchase.tool.description).toContain('unconfirmed');
    expect(watch.tool.description).toContain('unconfirmed');
  });

  it('takes needed_by as a date or a date and time with an offset, as the host reads it', () => {
    const validate = new Ajv({ validateFormats: false }).compile(purchase.tool.inputSchema);
    for (const needed_by of ['2026-10-23', '2026-10-23T17:00:00-07:00', '2026-10-23T17:00:00.000Z'])
      expect(validate({ target, needed_by })).toBe(true);
    for (const needed_by of ['2026-10-23T17:00:00', 'October 23', '23/10/2026'])
      expect(validate({ target, needed_by })).toBe(false);
    expect(purchase.tool.inputSchema.properties?.needed_by).not.toHaveProperty('format');
  });

  it('reads main as whichever agent sent the errand, in its guidance, its tools and the host’s answers and notices', () => {
    const guidance = fs.readFileSync(
      new URL('../../../../templates/gws-ea/browser/instructions.md', import.meta.url),
      'utf8',
    );
    expect(guidance.split('\n')[0]).toContain(
      "When another of the assistant's agents delegated this errand, read main as that agent wherever it appears: in this guidance, in your tools' descriptions, and in the host's answers and notices.",
    );
  });

  it('names only real tools in its mechanics instructions', async () => {
    const instructions = fs.readFileSync(new URL('./gws-ea-browser.instructions.md', import.meta.url), 'utf8');
    const cwd = process.cwd();
    try {
      process.chdir(fileURLToPath(new URL('../../../../', import.meta.url)));
      const { unknownToolNames } = await import('../../../../src/test-utils/runner-tools.js');
      expect(unknownToolNames(instructions, [])).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('a browser request that times out', () => {
  async function timedOut(tool: McpToolDefinition, args: Record<string, unknown>) {
    const realNow = Date.now;
    const start = realNow();
    let calls = 0;
    Date.now = () => start + calls++ * BROWSER_REQUEST_TIMEOUT_MS;
    try {
      return await tool.handler(args);
    } finally {
      Date.now = realNow;
    }
  }

  it('tells mutating callers not to repeat, gives the request id, and renders a late screenshot through request_status', async () => {
    for (const [tool, args] of cases.filter(([tool]) => tool !== listWatches)) {
      const result = await timedOut(tool, args);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('request_status before you do anything else, and do not send it again');
      expect(text).toContain(getUndeliveredMessages().at(-1)!.id);
    }
    const request = getUndeliveredMessages()[0];
    answer(request.id, {
      status: 'completed',
      actions: [{ index: 0, image_index: 0 }],
      images: [{ mime_type: 'image/png', data: 'c2NyZWVuc2hvdA==' }],
    });
    const result = await requestStatus.handler({ request_id: request.id });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ status: 'completed', actions: [{ index: 0, image_index: 0 }] }) },
      { type: 'image', mimeType: 'image/png', data: 'c2NyZWVuc2hvdA==' },
    ]);
    expect(await requestStatus.handler({ request_id: request.id })).toEqual(result);
  });

  it('allows repeating the read-only watch list request', async () => {
    const result = await timedOut(listWatches, {});
    expect((result.content[0] as { text: string }).text).toContain(
      'or make the same call again: a repeat changes nothing twice',
    );
  });
});
