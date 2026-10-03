/**
 * NanoClaw's tool server serves only the tools of the capability keys its
 * group holds. The real barrel is loaded (without starting its stdio server),
 * so these assertions cover the module-to-key wiring the container runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import './index.js';
import { createMcpServer, loadToolModule, registerTools } from './server.js';

const TIME_TOOLS = ['time_convert', 'time_diff', 'time_now', 'time_range', 'time_resolve'];

/** Every key a host grants a group stored as `all`. */
const ALL = [
  'reply',
  'files-send',
  'files-read',
  'files-write',
  'shell',
  'web',
  'subagents',
  'conversation-context',
  'mcp-servers',
  'interactive',
  'agents',
  'self-mod',
  'time',
  'schedule-stats',
];

/** What NanoClaw's server served before capabilities existed. */
const TODAY = [
  'add_mcp_server',
  'add_reaction',
  'ask_user_question',
  'create_agent',
  'edit_message',
  'install_packages',
  'schedule_stats',
  'send_card',
  'send_file',
  'send_message',
  ...TIME_TOOLS,
].sort();

async function connect(grants: readonly string[]): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(async (action) => action(), new Set(grants));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'capabilities-fixture', version: '1' });
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

async function served(grants: readonly string[]): Promise<string[]> {
  const { client, close } = await connect(grants);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await close();
  }
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('NanoClaw tool server capabilities', () => {
  it('serves a group holding every key the tools it served before capabilities', async () => {
    expect(await served(ALL)).toEqual(TODAY);
  });

  it('serves a group holding reply and time only send_message and the time tools', async () => {
    expect(await served(['reply', 'time'])).toEqual(['send_message', ...TIME_TOOLS].sort());
  });

  it('keeps files-send apart from reply', async () => {
    expect(await served(['files-send'])).toEqual(['add_reaction', 'edit_message', 'send_file']);
  });

  it('serves nothing to a group holding no keys', async () => {
    expect(await served([])).toEqual([]);
  });

  it('refuses a call to a tool outside the held keys as unknown', async () => {
    const { client, close } = await connect(['reply']);
    try {
      const result = await client.callTool({ name: 'create_agent', arguments: { name: 'x', instructions: 'y' } });
      expect(result.content).toEqual([{ type: 'text', text: 'Unknown tool: create_agent' }]);
    } finally {
      await close();
    }
  });

  it('never serves a tool registered without a key', async () => {
    registerTools([
      {
        tool: { name: 'unkeyed_fixture', inputSchema: { type: 'object' } },
        handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
    ]);

    expect(await served(ALL)).not.toContain('unkeyed_fixture');
  });

  it('attributes a module registered under a key that modules add', async () => {
    await loadToolModule('fixture-module', async () => {
      registerTools([
        {
          tool: { name: 'fixture_module_tool', inputSchema: { type: 'object' } },
          handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        },
      ]);
    });

    expect(await served(['fixture-module'])).toEqual(['fixture_module_tool']);
    expect(await served(ALL)).not.toContain('fixture_module_tool');
  });

  it('refuses overlapping module loads, which would mislabel tools', async () => {
    let release!: () => void;
    const first = loadToolModule('first-fixture', () => new Promise<void>((resolve) => (release = resolve)));

    await expect(loadToolModule('second-fixture', async () => undefined)).rejects.toThrow(/overlaps/);
    release();
    await first;
  });
});
