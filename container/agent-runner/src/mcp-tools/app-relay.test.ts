import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';

import type { ActionRequestOptions, ActionRequestResult } from '../action-request.js';
import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { getAgentMailbox } from '../mailbox/index.js';
import {
  ASSISTANT_SUMMARY_FIELD,
  createAppRelayServer,
  FALLBACK_ASSISTANT_SUMMARY_PREFIX,
  withAssistantSummarySchema,
  type AppRelayRequestFn,
} from './app-relay.js';

const SERVER_KEY = 'app_0123456789ab';

interface RecordedRequest {
  readonly action: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly options: ActionRequestOptions;
}

async function connectRelay(
  request: AppRelayRequestFn,
  options: { readonly initTimeoutMs?: number; readonly pollMs?: number } = {},
) {
  const server = await createAppRelayServer(SERVER_KEY, {
    request,
    initTimeoutMs: options.initTimeoutMs ?? 200,
    listTimeoutMs: 500,
    callTimeoutMs: 500,
    pollMs: options.pollMs ?? 10,
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'relay-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('app-relay stdio MCP server', () => {
  it('answers initialize with the host-pinned instructions', async () => {
    const seen: RecordedRequest[] = [];
    const { client, close } = await connectRelay(async (action, fields, options) => {
      seen.push({ action, fields, options });
      return {
        status: 'answered',
        frame: { id: 'req-1', ok: true, data: { instructions: 'Always confirm addresses before checkout.' } },
      };
    });
    try {
      expect(client.getInstructions()).toBe('Always confirm addresses before checkout.');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        action: 'app_relay',
        fields: { op: 'initialize', serverKey: SERVER_KEY },
      });
    } finally {
      await close();
    }
  });

  it('still completes initialize without instructions when the host does not answer within the bound', async () => {
    const { client, close } = await connectRelay(async () => ({ status: 'timeout', requestId: 'req-slow' }), {
      initTimeoutMs: 25,
    });
    try {
      expect(client.getInstructions()).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('adds required assistant_summary only to ask_first tools and hides internal labels', async () => {
    const { client, close } = await connectRelay(async (_action, fields) => {
      if (fields.op === 'initialize') {
        return { status: 'answered', frame: { id: 'r1', ok: true, data: { instructions: null } } };
      }
      return {
        status: 'answered',
        frame: {
          id: 'r2',
          ok: true,
          data: {
            instructions: null,
            tools: [
              {
                name: 'search_menu',
                description: 'Search restaurants.',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
                label: 'just_do',
              },
              {
                name: 'confirm_checkout',
                description: 'Place the order.\n\nAsks the principal first.',
                inputSchema: {
                  type: 'object',
                  properties: { checkout_id: { type: 'string' } },
                  required: ['checkout_id'],
                },
                label: 'ask_first',
              },
              {
                name: 'new_tool',
                description: 'Pending sort.',
                inputSchema: { type: 'object', properties: {} },
                label: null,
              },
            ],
          },
        },
      };
    });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['search_menu', 'confirm_checkout', 'new_tool']);
      const search = tools.find((t) => t.name === 'search_menu')!;
      const confirm = tools.find((t) => t.name === 'confirm_checkout')!;
      const pending = tools.find((t) => t.name === 'new_tool')!;

      expect('label' in search).toBe(false);
      expect(search.inputSchema.properties).toEqual({ query: { type: 'string' } });
      expect(search.inputSchema.required).toEqual(['query']);

      expect('label' in confirm).toBe(false);
      expect(confirm.inputSchema.properties).toEqual({
        checkout_id: { type: 'string' },
        [ASSISTANT_SUMMARY_FIELD]: { type: 'string', description: 'What this will do, in one line.' },
      });
      expect(confirm.inputSchema.required).toEqual(['checkout_id', ASSISTANT_SUMMARY_FIELD]);

      expect(pending.inputSchema.properties).toEqual({});
      expect(pending.inputSchema.required).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('forwards tools/call verbatim on completion and strips assistant_summary before forwarding', async () => {
    const calls: RecordedRequest[] = [];
    const upstreamResult = {
      content: [
        { type: 'text', text: 'Order #42 placed' },
        { type: 'text', text: 'ETA 25 mins' },
      ],
      structuredContent: { orderId: '42' },
    };
    const { client, close } = await connectRelay(async (action, fields, options) => {
      if (fields.op === 'initialize') {
        return { status: 'answered', frame: { id: 'r1', ok: true, data: { instructions: null } } };
      }
      calls.push({ action, fields, options });
      return {
        status: 'answered',
        frame: { id: 'r2', ok: true, data: { status: 'completed', result: upstreamResult } },
      };
    });
    try {
      const result = await client.callTool({
        name: 'confirm_checkout',
        arguments: {
          checkout_id: 'chk_99',
          tip: 200,
          [ASSISTANT_SUMMARY_FIELD]: 'Place Jollof order for NGN 4,500',
        },
      });

      expect(result).toEqual(upstreamResult);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.action).toBe('app_relay');
      expect(calls[0]!.fields).toEqual({
        op: 'tools/call',
        serverKey: SERVER_KEY,
        tool: 'confirm_checkout',
        arguments: { checkout_id: 'chk_99', tip: 200 },
        summary: 'Place Jollof order for NGN 4,500',
      });
      expect(JSON.stringify(calls[0]!.fields.arguments)).not.toContain(ASSISTANT_SUMMARY_FIELD);
    } finally {
      await close();
    }
  });

  it('returns held and unsorted answers as plain non-error text, and failure outcomes as tool errors', async () => {
    const outcomes: ActionRequestResult[] = [
      {
        status: 'answered',
        frame: {
          id: 'r2',
          ok: true,
          data: { status: 'held', text: "I've asked the principal; the result will arrive as a note." },
        },
      },
      {
        status: 'answered',
        frame: {
          id: 'r3',
          ok: true,
          data: { status: 'unsorted', text: 'This tool is still being set up, try again shortly.' },
        },
      },
      {
        status: 'answered',
        frame: {
          id: 'r4',
          ok: true,
          data: { status: 'unsent', text: 'The app could not be reached, so nothing was sent.' },
        },
      },
      {
        status: 'answered',
        frame: {
          id: 'r5',
          ok: true,
          data: { status: 'too_large', text: 'The app answered, but the result was too large to read.' },
        },
      },
      {
        status: 'answered',
        frame: { id: 'r6', ok: false, error: { code: 'forbidden', message: 'That app is not connected.' } },
      },
      { status: 'timeout', requestId: 'r7' },
    ];
    let index = 0;
    const { client, close } = await connectRelay(async (_action, fields) => {
      if (fields.op === 'initialize') {
        return { status: 'answered', frame: { id: 'r1', ok: true, data: { instructions: null } } };
      }
      return outcomes[index++]!;
    });
    try {
      const held = await client.callTool({ name: 'confirm_checkout', arguments: {} });
      expect(held).toEqual({
        content: [{ type: 'text', text: "I've asked the principal; the result will arrive as a note." }],
      });

      const unsorted = await client.callTool({ name: 'new_tool', arguments: {} });
      expect(unsorted).toEqual({
        content: [{ type: 'text', text: 'This tool is still being set up, try again shortly.' }],
      });

      const unsent = await client.callTool({ name: 'search_menu', arguments: {} });
      expect(unsent).toEqual({
        content: [{ type: 'text', text: 'The app could not be reached, so nothing was sent.' }],
        isError: true,
      });

      const tooLarge = await client.callTool({ name: 'search_menu', arguments: {} });
      expect(tooLarge).toEqual({
        content: [{ type: 'text', text: 'The app answered, but the result was too large to read.' }],
        isError: true,
      });

      const forbidden = await client.callTool({ name: 'search_menu', arguments: {} });
      expect(forbidden).toEqual({
        content: [{ type: 'text', text: 'That app is not connected.' }],
        isError: true,
      });

      const timedOut = await client.callTool({ name: 'search_menu', arguments: {} });
      expect(timedOut.isError).toBe(true);
      expect(timedOut.content).toEqual([{ type: 'text', text: expect.stringContaining('check before retrying') }]);
    } finally {
      await close();
    }
  });

  it('maps unknown, not-sent, cancelled, and unreadable completed outcomes to errors, fails tools/list errors, and emits tools/list_changed when toolsVersion shifts', async () => {
    let listChangedCount = 0;
    const outcomes: ActionRequestResult[] = [
      { status: 'answered', frame: { id: 'u1', ok: true, data: { status: 'unknown', text: 'Outcome unknown.' } } },
      { status: 'not-sent', reason: 'Mailbox closed' },
      { status: 'cancelled' },
      { status: 'answered', frame: { id: 'u4', ok: true, data: { status: 'completed', result: 'not-an-object' } } },
      {
        status: 'answered',
        frame: {
          id: 'u5',
          ok: true,
          data: { status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] }, toolsVersion: 'v2' },
        },
      },
    ];
    let callIdx = 0;
    let failList = false;
    const { client, close } = await connectRelay(async (_action, fields) => {
      if (fields.op === 'initialize') {
        return { status: 'answered', frame: { id: 'i1', ok: true, data: { instructions: null } } };
      }
      if (fields.op === 'tools/list') {
        if (failList)
          return {
            status: 'answered',
            frame: { id: 'l2', ok: false, error: { code: 'forbidden', message: 'Not connected' } },
          };
        return {
          status: 'answered',
          frame: {
            id: 'l1',
            ok: true,
            data: {
              toolsVersion: 'v1',
              tools: [{ name: 'search_menu', inputSchema: { type: 'object', properties: {} }, label: 'just_do' }],
            },
          },
        };
      }
      return outcomes[callIdx++]!;
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChangedCount += 1;
    });
    try {
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
      await client.listTools();

      expect(await client.callTool({ name: 'search_menu', arguments: {} })).toEqual({
        content: [{ type: 'text', text: 'Outcome unknown.' }],
        isError: true,
      });
      expect(await client.callTool({ name: 'search_menu', arguments: {} })).toEqual({
        content: [{ type: 'text', text: 'Mailbox closed' }],
        isError: true,
      });
      expect(await client.callTool({ name: 'search_menu', arguments: {} })).toEqual({
        content: [
          {
            type: 'text',
            text: 'Waiting for this app tool call was cancelled; the call may still complete on the host — check before retrying.',
          },
        ],
        isError: true,
      });
      expect(await client.callTool({ name: 'search_menu', arguments: {} })).toEqual({
        content: [{ type: 'text', text: 'The app returned an unreadable tool result.' }],
        isError: true,
      });

      const shifted = await client.callTool({ name: 'search_menu', arguments: {} });
      expect(shifted).toEqual({ content: [{ type: 'text', text: 'ok' }] });
      await new Promise((r) => setTimeout(r, 20));
      expect(listChangedCount).toBe(1);

      failList = true;
      await expect(client.listTools()).rejects.toThrow('Not connected');
    } finally {
      await close();
    }
  });

  it('omits upstream outputSchema and keeps restrictive ask_first inputSchema satisfiable', async () => {
    const augmented = withAssistantSummarySchema({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
      allOf: [
        {
          type: 'object',
          properties: { id: { type: 'string' } },
          additionalProperties: false,
          maxProperties: 1,
        },
      ],
    });
    expect(augmented.maxProperties).toBe(2);
    expect(augmented.minProperties).toBe(2);
    expect(augmented.required).toEqual(['id', ASSISTANT_SUMMARY_FIELD]);
    const branch = (augmented.allOf as Record<string, unknown>[])[0]!;
    expect(branch.maxProperties).toBe(2);
    expect((branch.properties as Record<string, unknown>)[ASSISTANT_SUMMARY_FIELD]).toBeDefined();

    const { client, close } = await connectRelay(async (_action, fields) => {
      if (fields.op === 'initialize') {
        return { status: 'answered', frame: { id: 'req-init', ok: true, data: { instructions: null } } };
      }
      if (fields.op === 'tools/list') {
        return {
          status: 'answered',
          frame: {
            id: 'req-list',
            ok: true,
            data: {
              toolsVersion: 'v-out',
              tools: [
                {
                  name: 'confirm_order',
                  description: 'Confirm order',
                  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, maxProperties: 1 },
                  outputSchema: {
                    type: 'object',
                    properties: { orderId: { type: 'string' } },
                    required: ['orderId'],
                  },
                  label: 'ask_first',
                },
              ],
            },
          },
        };
      }
      return {
        status: 'answered',
        frame: { id: 'req-call', ok: true, data: { status: 'held', text: 'Asked principal.' } },
      };
    });
    try {
      const listed = await client.listTools();
      const tool = listed.tools[0]!;
      expect(tool.outputSchema).toBeUndefined();
      expect(tool.inputSchema.maxProperties).toBe(2);
      const held = await client.callTool({
        name: 'confirm_order',
        arguments: { id: 'o-1', [ASSISTANT_SUMMARY_FIELD]: 'Confirm order o-1' },
      });
      expect(held).toEqual({ content: [{ type: 'text', text: 'Asked principal.' }] });
    } finally {
      await close();
    }
  });

  it('keeps propertyNames compatible with summary, preserves colliding upstream assistant_summary args, and reports cancelled calls as uncertain', async () => {
    // 1) propertyNames permits the relay summary field at top level and inside branches.
    const propNamesSchema = withAssistantSummarySchema({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      propertyNames: { enum: ['id'] },
      allOf: [{ propertyNames: { enum: ['id'] } }],
    });
    expect(propNamesSchema.propertyNames).toEqual({
      anyOf: [{ enum: ['id'] }, { const: ASSISTANT_SUMMARY_FIELD }],
    });
    expect(((propNamesSchema.allOf as Record<string, unknown>[])[0] as Record<string, unknown>).propertyNames).toEqual({
      anyOf: [{ enum: ['id'] }, { const: ASSISTANT_SUMMARY_FIELD }],
    });

    // 2) A tool whose upstream schema declares assistant_summary uses a collision-safe relay summary field
    //    and forwards the upstream assistant_summary argument unchanged.
    const calls: RecordedRequest[] = [];
    const { client, close } = await connectRelay(async (action, fields, options) => {
      calls.push({ action, fields, options });
      if (fields.op === 'initialize') {
        return { status: 'answered', frame: { id: 'req-init', ok: true, data: { instructions: null } } };
      }
      if (fields.op === 'tools/list') {
        return {
          status: 'answered',
          frame: {
            id: 'req-list',
            ok: true,
            data: {
              toolsVersion: 'v-col',
              tools: [
                {
                  name: 'colliding_tool',
                  description: 'Upstream tool with its own assistant_summary parameter',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      [ASSISTANT_SUMMARY_FIELD]: { type: 'string', description: 'Upstream note' },
                      id: { type: 'string' },
                    },
                    required: [ASSISTANT_SUMMARY_FIELD, 'id'],
                    propertyNames: { enum: [ASSISTANT_SUMMARY_FIELD, 'id'] },
                  },
                  label: 'ask_first',
                },
                {
                  name: 'cancel_tool',
                  description: 'Tool whose wait gets cancelled',
                  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
                  label: 'just_do',
                },
              ],
            },
          },
        };
      }
      if (fields.tool === 'cancel_tool') {
        return { status: 'cancelled' };
      }
      return {
        status: 'answered',
        frame: { id: 'req-call', ok: true, data: { status: 'held', text: 'Asked principal.' } },
      };
    });
    try {
      const listed = await client.listTools();
      const colliding = listed.tools.find((t) => t.name === 'colliding_tool')!;
      const props = colliding.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(props[ASSISTANT_SUMMARY_FIELD]).toEqual({ type: 'string', description: 'Upstream note' });
      expect(props[FALLBACK_ASSISTANT_SUMMARY_PREFIX]).toEqual({
        type: 'string',
        description: 'What this will do, in one line.',
      });
      expect(colliding.inputSchema.required).toEqual([
        ASSISTANT_SUMMARY_FIELD,
        'id',
        FALLBACK_ASSISTANT_SUMMARY_PREFIX,
      ]);
      expect(colliding.inputSchema.propertyNames).toEqual({
        anyOf: [{ enum: [ASSISTANT_SUMMARY_FIELD, 'id'] }, { const: FALLBACK_ASSISTANT_SUMMARY_PREFIX }],
      });

      await client.callTool({
        name: 'colliding_tool',
        arguments: {
          id: 'item-9',
          [ASSISTANT_SUMMARY_FIELD]: 'upstream value must survive',
          [FALLBACK_ASSISTANT_SUMMARY_PREFIX]: 'Confirm item 9',
        },
      });
      const callReq = calls.find((c) => c.fields.op === 'tools/call' && c.fields.tool === 'colliding_tool')!;
      expect(callReq.fields.arguments).toEqual({
        id: 'item-9',
        [ASSISTANT_SUMMARY_FIELD]: 'upstream value must survive',
      });
      expect(callReq.fields.summary).toBe('Confirm item 9');

      // 3) Cancelled wait warns that execution may still complete on the host.
      const cancelled = await client.callTool({ name: 'cancel_tool', arguments: { id: 'c-1' } });
      expect(cancelled.isError).toBe(true);
      const cancelledText = (cancelled.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(cancelledText).toContain('Waiting');
      expect(cancelledText).toContain('may still complete');
      expect(cancelledText).toContain('check before retrying');
    } finally {
      await close();
    }
  });

  it('accounts for patternProperties, boolean property schemas, composed allOf summary declarations, stale listing migrations, and unlisted tools', async () => {
    // 1) patternProperties matching assistant_summary picks a non-matching fallback summary field.
    const patternTargeted = withAssistantSummarySchema({
      type: 'object',
      properties: { id: true, forbidden: false },
      required: ['id'],
      additionalProperties: false,
      patternProperties: { '^assistant_summary$': { type: 'integer' } },
    });
    const targetedProps = patternTargeted.properties as Record<string, unknown>;
    expect(targetedProps.id).toBe(true);
    expect(targetedProps.forbidden).toBe(false);
    expect(targetedProps[FALLBACK_ASSISTANT_SUMMARY_PREFIX]).toEqual({
      type: 'string',
      description: 'What this will do, in one line.',
    });
    expect(patternTargeted.required).toEqual(['id', FALLBACK_ASSISTANT_SUMMARY_PREFIX]);

    // 2) Universal catch-all patternProperties excludes the chosen summary field so a string value remains valid.
    const catchAll = withAssistantSummarySchema({
      type: 'object',
      patternProperties: { '.*': { type: 'integer' } },
    });
    const rewrittenPatterns = Object.keys(catchAll.patternProperties as Record<string, unknown>);
    expect(rewrittenPatterns).toHaveLength(1);
    const rewrittenRe = new RegExp(rewrittenPatterns[0]!);
    expect(rewrittenRe.test(ASSISTANT_SUMMARY_FIELD)).toBe(false);
    expect(rewrittenRe.test('count')).toBe(true);

    // 3) Composed allOf declaration of assistant_summary selects a non-colliding summary field.
    const composed = withAssistantSummarySchema({
      type: 'object',
      allOf: [
        {
          properties: { [ASSISTANT_SUMMARY_FIELD]: { type: 'string' } },
          required: [ASSISTANT_SUMMARY_FIELD],
        },
      ],
    });
    expect(composed.required).toEqual([FALLBACK_ASSISTANT_SUMMARY_PREFIX]);

    // 4) Stale call formed against an earlier listing is rejected when summary field shifts,
    //    and unlisted tools after tools/list preserve assistant_summary untouched.
    let listingRound = 0;
    const forwarded: RecordedRequest[] = [];
    const { client, close } = await connectRelay(async (action, fields, options) => {
      if (fields.op === 'initialize') {
        return { status: 'answered', frame: { id: 'i1', ok: true, data: { instructions: null } } };
      }
      if (fields.op === 'tools/list') {
        listingRound += 1;
        const inputSchema =
          listingRound === 1
            ? { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
            : {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  [ASSISTANT_SUMMARY_FIELD]: { type: 'string' },
                },
                required: ['id', ASSISTANT_SUMMARY_FIELD],
              };
        return {
          status: 'answered',
          frame: {
            id: `l-${listingRound}`,
            ok: true,
            data: {
              toolsVersion: `v${listingRound}`,
              tools: [{ name: 'shift_tool', inputSchema, label: 'ask_first' }],
            },
          },
        };
      }
      forwarded.push({ action, fields, options });
      return {
        status: 'answered',
        frame: { id: 'c1', ok: true, data: { status: 'held', text: 'Asked principal.' } },
      };
    });
    try {
      await client.listTools();
      await client.listTools();
      // Call formed against listing 1 (carries assistant_summary, omits nanoclaw_assistant_summary) is rejected.
      const staleRes = await client.callTool({
        name: 'shift_tool',
        arguments: { id: '1', [ASSISTANT_SUMMARY_FIELD]: 'old summary' },
      });
      expect(staleRes.isError).toBe(true);
      expect(forwarded).toHaveLength(0);

      // Unlisted tool after tools/list preserves assistant_summary in forwarded arguments instead of stripping it.
      await client.callTool({
        name: 'removed_tool',
        arguments: { id: '2', [ASSISTANT_SUMMARY_FIELD]: 'preserve me' },
      });
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]!.fields.arguments).toEqual({ id: '2', [ASSISTANT_SUMMARY_FIELD]: 'preserve me' });
      expect(forwarded[0]!.fields.summary).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('handles schema-valued additionalProperties in branches, root $ref required preservation, __proto__ keys, declared prior fallback args, percent-encoded $ref, and ReDoS patterns', async () => {
    // 1) Schema-valued additionalProperties in an allOf branch and referenced $defs branch exempts summary while preserving the branch constraint.
    const branchAdditional = withAssistantSummarySchema({
      type: 'object',
      $defs: {
        refIntMap: {
          properties: { count: { type: 'integer' } },
          additionalProperties: { type: 'integer' },
        },
      },
      properties: { id: { type: 'string' } },
      allOf: [
        { properties: { id: { type: 'string' } }, additionalProperties: { type: 'integer' } },
        { $ref: '#/$defs/refIntMap' },
      ],
    });
    const branches = branchAdditional.allOf as Array<Record<string, unknown>>;
    expect((branches[0]!.properties as Record<string, unknown>)[ASSISTANT_SUMMARY_FIELD]).toEqual({
      type: 'string',
      description: 'What this will do, in one line.',
    });
    expect(branches[0]!.additionalProperties).toEqual({ type: 'integer' });
    expect((branches[1]!.properties as Record<string, unknown>)[ASSISTANT_SUMMARY_FIELD]).toEqual({
      type: 'string',
      description: 'What this will do, in one line.',
    });
    expect((branches[1]!.properties as Record<string, unknown>).count).toEqual({ type: 'integer' });
    expect(branches[1]!.additionalProperties).toEqual({ type: 'integer' });

    // 2) Root $ref preserves required fields from both referenced schema and root siblings when inlined.
    const rootRefSchema = withAssistantSummarySchema({
      $ref: '#/$defs/order',
      required: ['extra'],
      properties: { extra: { type: 'string' } },
      $defs: {
        order: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    });
    expect(rootRefSchema.required).toEqual(['id', 'extra', ASSISTANT_SUMMARY_FIELD]);
    expect((rootRefSchema.properties as Record<string, unknown>).id).toEqual({ type: 'string' });
    expect((rootRefSchema.properties as Record<string, unknown>).extra).toEqual({ type: 'string' });

    // 3) Own __proto__ keys survive in properties, patternProperties, and dependentSchemas without mutating prototypes.
    const protoInput = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"id":{"type":"string"}},"patternProperties":{"__proto__":{"type":"string"}},"dependentSchemas":{"__proto__":{"additionalProperties":false}}}',
    ) as Record<string, unknown>;
    const protoAdapted = withAssistantSummarySchema(protoInput);
    const protoProps = protoAdapted.properties as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(protoProps, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(protoProps)).toBe(Object.prototype);
    const protoPatterns = protoAdapted.patternProperties as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(protoPatterns, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(protoPatterns)).toBe(Object.prototype);
    const protoDeps = protoAdapted.dependentSchemas as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(protoDeps, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(protoDeps)).toBe(Object.prototype);

    // 4) Percent-encoded $ref and catastrophic ReDoS patternProperties keys resolve safely in bounded time.
    const encodedRef = withAssistantSummarySchema({
      type: 'object',
      $defs: {
        'summary args': { properties: { [ASSISTANT_SUMMARY_FIELD]: { type: 'string' } } },
      },
      allOf: [{ $ref: '#/$defs/summary%20args' }],
    });
    expect(encodedRef.required).toEqual([FALLBACK_ASSISTANT_SUMMARY_PREFIX]);

    const started = performance.now();
    const redosSchema = withAssistantSummarySchema({
      type: 'object',
      patternProperties: { '^(.*){100}Z$': { type: 'integer' }, '^(a+)+$': { type: 'integer' } },
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(redosSchema.required).toContain(ASSISTANT_SUMMARY_FIELD);

    // 5) When a prior fallback field becomes a declared app arg in the new listing, a fresh call carrying both
    //    the current summary field and the declared arg succeeds, while a stale call missing the current field fails.
    let listNum = 0;
    const forwarded: RecordedRequest[] = [];
    const { client, close } = await connectRelay(async (action, fields, options) => {
      if (fields.op === 'initialize') {
        return { status: 'answered', frame: { id: 'i-fb', ok: true, data: { instructions: null } } };
      }
      if (fields.op === 'tools/list') {
        listNum += 1;
        const inputSchema =
          listNum === 1
            ? {
                type: 'object',
                properties: { id: { type: 'string' }, [ASSISTANT_SUMMARY_FIELD]: { type: 'string' } },
                required: ['id', ASSISTANT_SUMMARY_FIELD],
              }
            : {
                type: 'object',
                properties: { id: { type: 'string' }, [FALLBACK_ASSISTANT_SUMMARY_PREFIX]: { type: 'string' } },
                required: ['id', FALLBACK_ASSISTANT_SUMMARY_PREFIX],
              };
        return {
          status: 'answered',
          frame: {
            id: `l-fb-${listNum}`,
            ok: true,
            data: {
              toolsVersion: `vfb-${listNum}`,
              tools: [{ name: 'swap_tool', inputSchema, label: 'ask_first' }],
            },
          },
        };
      }
      forwarded.push({ action, fields, options });
      return {
        status: 'answered',
        frame: { id: 'c-fb', ok: true, data: { status: 'held', text: 'Asked principal.' } },
      };
    });
    try {
      await client.listTools();
      await client.listTools();

      // Stale call (carries prior fallback, omits new current assistant_summary) is still rejected.
      const stale = await client.callTool({
        name: 'swap_tool',
        arguments: { id: '1', [FALLBACK_ASSISTANT_SUMMARY_PREFIX]: 'stale summary' },
      });
      expect(stale.isError).toBe(true);
      expect(forwarded).toHaveLength(0);

      // Fresh call (carries current assistant_summary AND declared nanoclaw_assistant_summary arg) succeeds.
      const fresh = await client.callTool({
        name: 'swap_tool',
        arguments: {
          id: '1',
          [ASSISTANT_SUMMARY_FIELD]: 'Run swap tool',
          [FALLBACK_ASSISTANT_SUMMARY_PREFIX]: 'real upstream param',
        },
      });
      expect(fresh.isError).not.toBe(true);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]!.fields.summary).toBe('Run swap tool');
      expect(forwarded[0]!.fields.arguments).toEqual({
        id: '1',
        [FALLBACK_ASSISTANT_SUMMARY_PREFIX]: 'real upstream param',
      });
    } finally {
      await close();
    }
  });

  describe('over the session mailbox', () => {
    beforeEach(() => {
      initTestSessionDb();
    });

    afterEach(() => {
      closeSessionDb();
    });

    it('writes an app_relay system message to the outbound mailbox', async () => {
      const server = await createAppRelayServer(SERVER_KEY, {
        initTimeoutMs: 25,
        callTimeoutMs: 40,
        pollMs: 10,
        run: (action) => getAgentMailbox().run(action),
      });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'mailbox-test', version: '1.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        await client.callTool({ name: 'ping', arguments: { hello: 'world' } });
        const outbound = getUndeliveredMessages();
        const payloads = outbound.map((row) => JSON.parse(row.content) as Record<string, unknown>);
        expect(payloads).toContainEqual(
          expect.objectContaining({
            action: 'app_relay',
            op: 'tools/call',
            serverKey: SERVER_KEY,
            tool: 'ping',
            arguments: { hello: 'world' },
          }),
        );
      } finally {
        await client.close();
        await server.close();
      }
    });

    it('registers the session mailbox when imported in a standalone process', () => {
      const relayPath = path.resolve(import.meta.dir, 'app-relay.ts');
      const mailboxPath = path.resolve(import.meta.dir, '../mailbox/index.ts');
      const proc = Bun.spawnSync(
        [
          process.execPath,
          '-e',
          `await import(${JSON.stringify(relayPath)}); const { getAgentMailbox } = await import(${JSON.stringify(mailboxPath)}); getAgentMailbox();`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    });
  });
});
