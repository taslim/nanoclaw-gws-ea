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
        content: [{ type: 'text', text: 'The app tool call was cancelled.' }],
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
