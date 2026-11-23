/**
 * Per-app stdio MCP relay inside main's container.
 *
 * Spawned by Claude Code for each principal-connected app (`bun run /app/src/mcp-tools/app-relay.ts <serverKey>`).
 * Answers `initialize` itself using host-pinned server instructions (or without them if the short bound elapses),
 * and forwards `tools/list` and `tools/call` to the host's guarded `app_relay` delivery action over the session
 * mailbox. No principal-app credentials exist inside the container.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { requestAction, type ActionRequestOptions, type ActionRequestResult } from '../action-request.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
// Registers the session mailbox before `getAgentMailbox()` runs in standalone entry mode.
import '../modules/index.js';

export const APP_RELAY_ACTION = 'app_relay';
export const ASSISTANT_SUMMARY_FIELD = 'assistant_summary';
export const ASSISTANT_SUMMARY_DESCRIPTION = 'What this will do, in one line.';

export const DEFAULT_INIT_TIMEOUT_MS = 3_000;
export const DEFAULT_LIST_TIMEOUT_MS = 30_000;
export const DEFAULT_CALL_TIMEOUT_MS = 90_000;
export const DEFAULT_POLL_MS = 100;

export type AppRelayRequestFn = (
  action: string,
  fields: Readonly<Record<string, unknown>>,
  options: ActionRequestOptions,
) => Promise<ActionRequestResult>;

export interface AppRelayDeps {
  readonly request: AppRelayRequestFn;
  readonly run: <T>(action: () => T | Promise<T>) => Promise<T>;
  readonly initTimeoutMs: number;
  readonly listTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly pollMs: number;
}

function log(message: string): void {
  console.error(`[app-relay] ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorToolResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function plainToolResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * Adds the reserved required `assistant_summary` string property to an ask-first tool's input schema without
 * mutating the host-returned schema object.
 */
export function withAssistantSummarySchema(schema: Record<string, unknown>): Tool['inputSchema'] {
  const existingProperties = isRecord(schema.properties) ? schema.properties : {};
  const existingRequired = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const required = existingRequired.includes(ASSISTANT_SUMMARY_FIELD)
    ? [...existingRequired]
    : [...existingRequired, ASSISTANT_SUMMARY_FIELD];
  return {
    ...schema,
    type: 'object',
    properties: {
      ...existingProperties,
      [ASSISTANT_SUMMARY_FIELD]: {
        type: 'string',
        description: ASSISTANT_SUMMARY_DESCRIPTION,
      },
    },
    required,
  };
}

/**
 * Strips the reserved `assistant_summary` field from tool arguments before forwarding to the host so it is never
 * hashed, canonicalized or sent to the upstream app.
 */
export function extractSummaryAndArgs(rawArgs: Record<string, unknown> | undefined): {
  readonly args: Record<string, unknown>;
  readonly summary?: string;
} {
  if (!rawArgs) return { args: {} };
  const args: Record<string, unknown> = {};
  let summary: string | undefined;
  for (const [key, value] of Object.entries(rawArgs)) {
    if (key === ASSISTANT_SUMMARY_FIELD) {
      if (typeof value === 'string' && value.trim().length > 0) summary = value.trim();
      continue;
    }
    args[key] = value;
  }
  return summary === undefined ? { args } : { args, summary };
}

function formatRelayedTool(raw: unknown): Tool | undefined {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !isRecord(raw.inputSchema)) return undefined;
  const label = raw.label === 'ask_first' || raw.label === 'just_do' ? raw.label : null;
  const inputSchema =
    label === 'ask_first'
      ? withAssistantSummarySchema(raw.inputSchema)
      : ({ ...raw.inputSchema, type: 'object' } as Tool['inputSchema']);
  const tool: Tool = {
    name: raw.name,
    inputSchema,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(isRecord(raw.outputSchema) ? { outputSchema: raw.outputSchema as Tool['outputSchema'] } : {}),
    ...(isRecord(raw.annotations) ? { annotations: raw.annotations as Tool['annotations'] } : {}),
  };
  return tool;
}

export async function fetchAppInstructions(serverKey: string, deps: AppRelayDeps): Promise<string | undefined> {
  const result = await deps.run(() =>
    deps.request(
      APP_RELAY_ACTION,
      { op: 'initialize', serverKey },
      { timeoutMs: deps.initTimeoutMs, pollMs: deps.pollMs },
    ),
  );
  if (result.status !== 'answered' || !result.frame.ok || !isRecord(result.frame.data)) return undefined;
  const instructions = result.frame.data.instructions;
  return typeof instructions === 'string' && instructions.length > 0 ? instructions : undefined;
}

function mapCallOutcome(result: ActionRequestResult): CallToolResult {
  switch (result.status) {
    case 'not-sent':
      return errorToolResult(result.reason);
    case 'cancelled':
      return errorToolResult('The app tool call was cancelled.');
    case 'timeout':
      return errorToolResult('The host did not answer this app tool call in time; check before retrying.');
    case 'answered': {
      if (!result.frame.ok) return errorToolResult(result.frame.error.message);
      const data = result.frame.data;
      if (!isRecord(data) || typeof data.status !== 'string') {
        return errorToolResult('The host returned an unreadable app relay response.');
      }
      switch (data.status) {
        case 'completed':
          if (isRecord(data.result)) return data.result as CallToolResult;
          return errorToolResult('The app returned an unreadable tool result.');
        case 'held':
        case 'unsorted':
          return plainToolResult(typeof data.text === 'string' ? data.text : '');
        case 'too_large':
        case 'unsent':
        case 'unknown':
          return errorToolResult(
            typeof data.text === 'string' ? data.text : 'The app tool call did not complete.',
          );
        default:
          return errorToolResult('The host returned an unexpected app relay status.');
      }
    }
    default: {
      const unreachable: never = result;
      throw new Error(`Unknown relay request result: ${JSON.stringify(unreachable)}`);
    }
  }
}

export async function createAppRelayServer(
  serverKey: string,
  overrides: Partial<AppRelayDeps> = {},
): Promise<Server> {
  const deps: AppRelayDeps = {
    request: overrides.request ?? requestAction,
    run: overrides.run ?? (async (action) => action()),
    initTimeoutMs: overrides.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
    listTimeoutMs: overrides.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS,
    callTimeoutMs: overrides.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    pollMs: overrides.pollMs ?? DEFAULT_POLL_MS,
  };

  const instructions = await fetchAppInstructions(serverKey, deps);
  const server = new Server(
    { name: serverKey, version: '1.0.0' },
    {
      capabilities: { tools: {} },
      ...(instructions === undefined ? {} : { instructions }),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, context) => {
    const result = await deps.run(() =>
      deps.request(
        APP_RELAY_ACTION,
        { op: 'tools/list', serverKey },
        { timeoutMs: deps.listTimeoutMs, pollMs: deps.pollMs, signal: context.signal },
      ),
    );
    if (result.status !== 'answered') {
      throw new Error('The host did not answer tools/list in time.');
    }
    if (!result.frame.ok) {
      throw new Error(result.frame.error.message);
    }
    const rawTools = isRecord(result.frame.data) && Array.isArray(result.frame.data.tools) ? result.frame.data.tools : [];
    const tools = rawTools.flatMap((entry) => {
      const formatted = formatRelayedTool(entry);
      return formatted ? [formatted] : [];
    });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    const { args, summary } = extractSummaryAndArgs(request.params.arguments);
    const result = await deps.run(() =>
      deps.request(
        APP_RELAY_ACTION,
        {
          op: 'tools/call',
          serverKey,
          tool: request.params.name,
          arguments: args,
          ...(summary === undefined ? {} : { summary }),
        },
        { timeoutMs: deps.callTimeoutMs, pollMs: deps.pollMs, signal: context.signal },
      ),
    );
    return mapCallOutcome(result);
  });

  return server;
}

async function main(): Promise<void> {
  const serverKey = process.argv[2]?.trim();
  if (!serverKey) {
    log('Usage: app-relay.ts <serverKey>');
    process.exit(1);
  }
  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());
  const server = await createAppRelayServer(serverKey, {
    run: (action) => mailbox.run(action),
  });
  const transport = new StdioServerTransport();
  let stopped = false;
  const stopMailbox = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await mailbox.stop();
  };
  transport.onclose = () => {
    void stopMailbox();
  };
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((error) => {
    log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
