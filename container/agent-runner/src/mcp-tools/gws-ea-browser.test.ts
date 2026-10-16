import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import {
  browser,
  BROWSER_REQUEST_TIMEOUT_MS,
  cancelWatch,
  listWatches,
  purchase,
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
  [signInCode, { from: 'principal', target, send: { ref: 'e2', generation: 1 } }],
  [purchase, { target }],
  [purchase, { operation: 'reconcile', attempt_id: 'attempt-1', target }],
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
      financial: {
        currency: 'USD',
        max_total: '50.00',
        terms: 'Conditional no-show fee only; nothing due at booking.',
      },
      until: '2026-10-16T18:00:00-07:00',
    },
  ],
  [listWatches, {}],
  [cancelWatch, { watch_id: 'watch-1' }],
];

describe('the browser tools', () => {
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
    expect(signInCode.tool.inputSchema.properties).not.toHaveProperty('code');
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
