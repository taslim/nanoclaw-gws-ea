/**
 * A stand-in for the pinned Link CLI's MCP mode, offering the same four meta-tools over the commands recorded from
 * the real CLI. Node runs it directly by stripping types, so it imports only packages and builtins.
 *
 * It reads `fake-app.json` from its working directory for per-test behavior and appends what it saw to
 * `fake-app.jsonl` there.
 */
import fs from 'node:fs';
import path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Tests import only this module's types: a value import would start a server in the test process.
const FAKE_APP_CONTROL_FILE = 'fake-app.json';
const FAKE_APP_LOG_FILE = 'fake-app.jsonl';

export interface FakeAppControl {
  /** Inner commands whose details carry `readOnlyHint: true`. */
  readonly readOnly?: readonly string[];
  /** Inner commands that never answer. */
  readonly hang?: readonly string[];
  /** Inner command answered with a text of `largeResultBytes` characters. */
  readonly largeResult?: string;
  readonly largeResultBytes?: number;
  /** Written to stderr at start. */
  readonly stderrText?: string;
}

export type FakeAppRecord =
  | {
      readonly kind: 'start';
      readonly pid: number;
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly stderrIsNull: boolean;
    }
  | { readonly kind: 'call'; readonly pid: number; readonly meta: string; readonly arguments: unknown };

interface RecordedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

const META_TOOLS = [
  {
    name: 'search_tools',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer' }, offset: { type: 'integer' }, query: { type: 'string' } },
    },
  },
  { name: 'get_tool_details', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  {
    name: 'call_read_tool',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } } },
  },
  {
    name: 'call_write_tool',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } } },
  },
];

function readControl(): FakeAppControl {
  const file = path.join(process.cwd(), FAKE_APP_CONTROL_FILE);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as FakeAppControl) : {};
}

function record(entry: FakeAppRecord): void {
  fs.appendFileSync(path.join(process.cwd(), FAKE_APP_LOG_FILE), `${JSON.stringify(entry)}\n`);
}

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError } : {}) };
}

function stderrIsNull(): boolean {
  const stderr = fs.fstatSync(2);
  const nul = fs.statSync('/dev/null');
  return stderr.rdev === nul.rdev && stderr.ino === nul.ino;
}

const control = readControl();
const listing = JSON.parse(fs.readFileSync(new URL('./link-1.6.0-tools.json', import.meta.url), 'utf8')) as {
  readonly tools: readonly RecordedTool[];
};
const tools = listing.tools.map((tool) =>
  control.readOnly?.includes(tool.name) ? { ...tool, annotations: { ...tool.annotations, readOnlyHint: true } } : tool,
);

record({
  kind: 'start',
  pid: process.pid,
  cwd: process.cwd(),
  env: Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  ),
  stderrIsNull: stderrIsNull(),
});
if (control.stderrText) process.stderr.write(control.stderrText);

const server = new Server({ name: 'fake-link-cli', version: '1.6.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: META_TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const args = request.params.arguments ?? {};
  record({ kind: 'call', pid: process.pid, meta: request.params.name, arguments: args });
  switch (request.params.name) {
    case 'search_tools': {
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const page = tools.slice(offset, offset + limit).map(({ name, description }) => ({ name, description }));
      const next = offset + limit < tools.length ? { nextOffset: offset + limit } : {};
      return text({ tools: page, ...next });
    }
    case 'get_tool_details': {
      const found = tools.find((tool) => tool.name === args.name);
      return found ? text(found) : text({ error: `Unknown tool: ${String(args.name)}` }, true);
    }
    case 'call_read_tool':
    case 'call_write_tool': {
      const name = String(args.name);
      if (!tools.some((tool) => tool.name === name)) return text({ error: `Unknown tool: ${name}` }, true);
      if (control.hang?.includes(name)) return new Promise<CallToolResult>(() => undefined);
      if (control.largeResult === name) {
        return { content: [{ type: 'text', text: 'x'.repeat(control.largeResultBytes ?? 0) }] };
      }
      return text({ ok: true, tool: name, arguments: args.arguments ?? {} });
    }
    default:
      return text({ error: `Unknown tool: ${request.params.name}` }, true);
  }
});
await server.connect(new StdioServerTransport());
