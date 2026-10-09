/**
 * NanoClaw's tool server serves only the tools of the capability keys its
 * group holds, and each agent its own key's version of a tool two keys
 * register. The real barrel is loaded (without starting its stdio server),
 * so these assertions cover the module-to-key wiring the container runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { sessionsSealed } from '../memory/sealed.js';
import { allowsBuiltinTool, resolveClaudeCapabilityPolicy } from '../providers/claude-config.js';
// The barrel loads every tool module under its key; a tool module imported
// ahead of it would register its tools without one.
import './index.js';
import { createMcpServer, loadToolModule, registerTools } from './server.js';

const TIME_TOOLS = ['time_convert', 'time_diff', 'time_now', 'time_resolve'];

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
  'request-status',
  'gws-ea-email',
  'gws-ea-reminders',
  'google-calendar',
  'google-mail-read',
  'google-directory',
];

/** Exactly the keys the host stamps external-email with (src/modules/gws-ea-external-email/group.ts). */
const EXTERNAL_EMAIL = ['files-read', 'time', 'request-status', 'gws-ea-reminders', 'gws-ea-email-external'];

/** external-email's thread tools, which `gws-ea-email-external` grants. */
const EXTERNAL_EMAIL_TOOLS = ['book', 'cancel_booking', 'change_booking', 'email_send', 'free_time', 'tell_main'];

/** main's email tools, which `gws-ea-email` grants. */
const MAIN_EMAIL_TOOLS = ['email_handoff', 'email_principal'];
const REMINDER_TOOLS = ['clear_reminder', 'remind_me'];
/** main's calendar tools through the host, which Google Calendar's key grants with gog's calendar commands. */
const CALENDAR_TOOLS = ['change_guests', 'create_event', 'find_conflicts', 'people_stats'];

/** Every tool of the default-on keys. */
const DEFAULT_ON_TOOLS = [
  'add_mcp_server',
  'add_reaction',
  'ask_user_question',
  'create_agent',
  'edit_message',
  'install_packages',
  'request_status',
  'send_card',
  'send_file',
  'send_message',
  ...MAIN_EMAIL_TOOLS,
  ...REMINDER_TOOLS,
  ...CALENDAR_TOOLS,
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
  it.each<[string, readonly string[], readonly string[]]>([
    ['every default-on key', ALL, DEFAULT_ON_TOOLS],
    ['reply and time', ['reply', 'time'], ['send_message', ...TIME_TOOLS].sort()],
    ['files-send', ['files-send'], ['add_reaction', 'edit_message', 'send_file']],
    ['request-status', ['request-status'], ['request_status']],
    ['gws-ea-email', ['gws-ea-email'], MAIN_EMAIL_TOOLS],
    ['gws-ea-email-external', ['gws-ea-email-external'], EXTERNAL_EMAIL_TOOLS],
    ['gws-ea-reminders', ['gws-ea-reminders'], REMINDER_TOOLS],
    ['google-calendar', ['google-calendar'], CALENDAR_TOOLS],
    [
      "external-email's keys",
      EXTERNAL_EMAIL,
      [...EXTERNAL_EMAIL_TOOLS, ...REMINDER_TOOLS, 'request_status', ...TIME_TOOLS].sort(),
    ],
    ['no keys', [], []],
  ])('serves a group holding %s exactly the tools of its keys', async (_holding, grants, tools) => {
    expect(await served(grants)).toEqual(tools);
  });

  it('gives main neither tell_main nor the scheduling tools', async () => {
    const tools = await served(ALL);
    for (const tool of ['tell_main', 'free_time', 'book', 'change_booking', 'cancel_booking']) {
      expect(tools).not.toContain(tool);
    }
  });

  it('serves no hold tool to any group: nothing reserves the principal’s time before someone agrees', async () => {
    for (const grants of [ALL, EXTERNAL_EMAIL]) expect(await served(grants)).not.toContain('hold');
  });

  it("serves main email_principal for the principal's threads, and external-email email_send for its own", async () => {
    async function fieldsOf(grants: readonly string[], name: string): Promise<string[] | undefined> {
      const { client, close } = await connect(grants);
      try {
        const { tools } = await client.listTools();
        const tool = tools.find((candidate) => candidate.name === name);
        return tool === undefined ? undefined : Object.keys(tool.inputSchema.properties ?? {}).sort();
      } finally {
        await close();
      }
    }
    expect(await fieldsOf(ALL, 'email_principal')).toEqual(['files', 'text', 'thread_key']);
    expect(await fieldsOf(ALL, 'email_send')).toBeUndefined();
    expect(await fieldsOf(EXTERNAL_EMAIL, 'email_send')).toEqual(['cc', 'files', 'subject', 'text', 'to']);
    expect(await fieldsOf(EXTERNAL_EMAIL, 'email_principal')).toBeUndefined();
  });

  it('keeps external-email sealed: no memory, shell, web, subagents, other MCP servers, or write tools; it can read its files', () => {
    const grants = new Set(EXTERNAL_EMAIL);
    expect(sessionsSealed(grants)).toBe(true);
    const policy = resolveClaudeCapabilityPolicy(grants);
    expect(policy.externalMcpServers).toBe(false);
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash', 'WebSearch', 'WebFetch', 'Task', 'Agent']) {
      expect(allowsBuiltinTool(policy, tool), tool).toBe(false);
    }
    for (const tool of ['Read', 'Glob', 'Grep']) expect(allowsBuiltinTool(policy, tool), tool).toBe(true);
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
