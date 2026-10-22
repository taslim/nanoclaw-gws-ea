import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, registerTools, registerToolVariant } from './server.js';
import type { McpToolDefinition } from './types.js';

function definition(label: string): McpToolDefinition {
  return {
    tool: {
      name: 'conversation_variant_fixture',
      description: label,
      inputSchema: { type: 'object', properties: { [label]: { type: 'string' } } },
    },
    handler: async () => ({ content: [{ type: 'text', text: label }] }),
  };
}

describe('capability-specific versions of one MCP tool', () => {
  it('serves each conversation capability its own schema and wire handler without exposing the other', async () => {
    registerTools([definition('email')], 'variant-email');
    registerToolVariant(definition('chat'), 'variant-chat');
    for (const [grants, expected] of [
      [['variant-email'], 'email'],
      [['variant-chat'], 'chat'],
      [['variant-email', 'variant-chat'], 'email'],
      [[], undefined],
    ] as const) {
      const server = createMcpServer(async (action) => action(), new Set<string>(grants));
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'tool-variant-fixture', version: '1' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const tools = (await client.listTools()).tools.filter((tool) => tool.name === 'conversation_variant_fixture');
        if (expected === undefined) {
          expect(tools).toHaveLength(0);
          expect(await client.callTool({ name: 'conversation_variant_fixture', arguments: {} })).toMatchObject({
            content: [{ type: 'text', text: 'Unknown tool: conversation_variant_fixture' }],
          });
        } else {
          expect(tools).toHaveLength(1);
          expect(tools[0]?.description).toBe(expected);
          expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual([expected]);
          expect(await client.callTool({ name: 'conversation_variant_fixture', arguments: {} })).toMatchObject({
            content: [{ type: 'text', text: expected }],
          });
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  });
});
