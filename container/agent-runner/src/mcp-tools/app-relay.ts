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

const ASSISTANT_SUMMARY_PROPERTY = {
  type: 'string',
  description: ASSISTANT_SUMMARY_DESCRIPTION,
} as const;

function allowAssistantSummaryInBranch(subschema: unknown, depth: number): unknown {
  if (depth > 4 || !isRecord(subschema)) return subschema;
  let changed = false;
  const next: Record<string, unknown> = { ...subschema };

  const subProps = isRecord(subschema.properties) ? subschema.properties : undefined;
  const hasSummary = subProps !== undefined && Object.prototype.hasOwnProperty.call(subProps, ASSISTANT_SUMMARY_FIELD);

  if (!hasSummary && (subschema.additionalProperties === false || subschema.unevaluatedProperties === false)) {
    next.properties = {
      ...(subProps ?? {}),
      [ASSISTANT_SUMMARY_FIELD]: ASSISTANT_SUMMARY_PROPERTY,
    };
    changed = true;
  }
  if (!hasSummary && typeof subschema.maxProperties === 'number' && Number.isFinite(subschema.maxProperties)) {
    next.maxProperties = subschema.maxProperties + 1;
    changed = true;
  }
  if (!hasSummary && typeof subschema.minProperties === 'number' && Number.isFinite(subschema.minProperties)) {
    next.minProperties = subschema.minProperties + 1;
    changed = true;
  }
  for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = subschema[combiner];
    if (Array.isArray(branches)) {
      const updated = branches.map((branch) => allowAssistantSummaryInBranch(branch, depth + 1));
      if (updated.some((entry, index) => entry !== branches[index])) {
        next[combiner] = updated;
        changed = true;
      }
    }
  }
  return changed ? next : subschema;
}

export function withAssistantSummarySchema(schema: Record<string, unknown>): Tool['inputSchema'] {
  const existingProperties = isRecord(schema.properties) ? schema.properties : {};
  const alreadyPresent = Object.prototype.hasOwnProperty.call(existingProperties, ASSISTANT_SUMMARY_FIELD);
  const existingRequired = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const required = existingRequired.includes(ASSISTANT_SUMMARY_FIELD)
    ? [...existingRequired]
    : [...existingRequired, ASSISTANT_SUMMARY_FIELD];

  const base: Record<string, unknown> = { ...schema };
  if (!alreadyPresent) {
    if (typeof schema.maxProperties === 'number' && Number.isFinite(schema.maxProperties)) {
      base.maxProperties = schema.maxProperties + 1;
    }
    if (typeof schema.minProperties === 'number' && Number.isFinite(schema.minProperties)) {
      base.minProperties = schema.minProperties + 1;
    }
    for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = schema[combiner];
      if (Array.isArray(branches)) {
        base[combiner] = branches.map((branch) => allowAssistantSummaryInBranch(branch, 0));
      }
    }
  }

  return {
    ...base,
    type: 'object',
    properties: {
      ...existingProperties,
      [ASSISTANT_SUMMARY_FIELD]: ASSISTANT_SUMMARY_PROPERTY,
    },
    required,
  };
}

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

function mapAnsweredData(data: unknown): CallToolResult {
  if (!isRecord(data) || typeof data.status !== 'string') {
    return errorToolResult('The host returned an unreadable app relay response.');
  }
  switch (data.status) {
    case 'completed':
      return isRecord(data.result)
        ? (data.result as CallToolResult)
        : errorToolResult('The app returned an unreadable tool result.');
    case 'held':
    case 'unsorted':
      return plainToolResult(typeof data.text === 'string' ? data.text : '');
    case 'too_large':
    case 'unsent':
    case 'unknown':
      return errorToolResult(typeof data.text === 'string' ? data.text : 'The app tool call did not complete.');
    default:
      return errorToolResult('The host returned an unexpected app relay status.');
  }
}

function mapCallOutcome(result: ActionRequestResult): CallToolResult {
  switch (result.status) {
    case 'not-sent':
      return errorToolResult(result.reason);
    case 'cancelled':
      return errorToolResult('The app tool call was cancelled.');
    case 'timeout':
      return errorToolResult('The host did not answer this app tool call in time; check before retrying.');
    case 'answered':
      return result.frame.ok ? mapAnsweredData(result.frame.data) : errorToolResult(result.frame.error.message);
    default: {
      const unreachable: never = result;
      throw new Error(`Unknown relay request result: ${JSON.stringify(unreachable)}`);
    }
  }
}

export async function createAppRelayServer(serverKey: string, overrides: Partial<AppRelayDeps> = {}): Promise<Server> {
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
      capabilities: { tools: { listChanged: true } },
      ...(instructions === undefined ? {} : { instructions }),
    },
  );
  let lastToolsVersion: string | undefined;

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
    if (isRecord(result.frame.data) && typeof result.frame.data.toolsVersion === 'string') {
      lastToolsVersion = result.frame.data.toolsVersion;
    }
    const rawTools =
      isRecord(result.frame.data) && Array.isArray(result.frame.data.tools) ? result.frame.data.tools : [];
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
    if (
      result.status === 'answered' &&
      result.frame.ok &&
      isRecord(result.frame.data) &&
      typeof result.frame.data.toolsVersion === 'string' &&
      lastToolsVersion !== undefined &&
      result.frame.data.toolsVersion !== lastToolsVersion
    ) {
      lastToolsVersion = result.frame.data.toolsVersion;
      void server.sendToolListChanged().catch(() => undefined);
    }
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
