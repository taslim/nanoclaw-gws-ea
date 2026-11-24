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
export const FALLBACK_ASSISTANT_SUMMARY_PREFIX = 'nanoclaw_assistant_summary';
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

const MAX_SCHEMA_WALK_DEPTH = 8;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function resolveLocalRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return isRecord(current) ? current : undefined;
}

function patternMatchesField(pattern: string, field: string): boolean {
  try {
    return new RegExp(pattern).test(field);
  } catch {
    return true;
  }
}

function collectRootObjectConstraints(root: Record<string, unknown>): {
  readonly declaredNames: Set<string>;
  readonly patterns: string[];
} {
  const declaredNames = new Set<string>();
  const patterns: string[] = [];
  const seen = new Set<object>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_SCHEMA_WALK_DEPTH || !isRecord(node) || seen.has(node)) return;
    seen.add(node);
    if (isRecord(node.properties)) {
      for (const key of Object.keys(node.properties)) declaredNames.add(key);
    }
    if (Array.isArray(node.required)) {
      for (const entry of node.required) {
        if (typeof entry === 'string') declaredNames.add(entry);
      }
    }
    if (isRecord(node.patternProperties)) {
      for (const pattern of Object.keys(node.patternProperties)) patterns.push(pattern);
    }
    if (typeof node.$ref === 'string') {
      const target = resolveLocalRef(root, node.$ref);
      if (target) visit(target, depth + 1);
    }
    for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = node[combiner];
      if (Array.isArray(branches)) {
        for (const branch of branches) visit(branch, depth + 1);
      }
    }
    for (const key of ['if', 'then', 'else'] as const) {
      if (isRecord(node[key])) visit(node[key], depth + 1);
    }
    if (isRecord(node.dependentSchemas)) {
      for (const dep of Object.values(node.dependentSchemas)) visit(dep, depth + 1);
    }
  };

  visit(root, 0);
  return { declaredNames, patterns };
}

function summaryFieldCandidates(): string[] {
  const candidates = [ASSISTANT_SUMMARY_FIELD, FALLBACK_ASSISTANT_SUMMARY_PREFIX];
  for (let suffix = 2; suffix <= 32; suffix += 1) {
    candidates.push(`${FALLBACK_ASSISTANT_SUMMARY_PREFIX}_${suffix}`);
  }
  candidates.push('nanoclaw-assistant-summary', '$nanoclaw_assistant_summary', '$nanoclaw-assistant-summary');
  return candidates;
}

export function pickAssistantSummaryField(schemaOrProperties: Record<string, unknown>): string {
  const looksLikeSchema =
    schemaOrProperties.type === 'object' ||
    isRecord(schemaOrProperties.properties) ||
    isRecord(schemaOrProperties.patternProperties) ||
    Array.isArray(schemaOrProperties.required) ||
    Array.isArray(schemaOrProperties.allOf) ||
    Array.isArray(schemaOrProperties.anyOf) ||
    Array.isArray(schemaOrProperties.oneOf) ||
    typeof schemaOrProperties.$ref === 'string' ||
    isRecord(schemaOrProperties.dependentSchemas) ||
    isRecord(schemaOrProperties.if) ||
    isRecord(schemaOrProperties.then) ||
    isRecord(schemaOrProperties.else);
  const { declaredNames, patterns } = looksLikeSchema
    ? collectRootObjectConstraints(schemaOrProperties)
    : { declaredNames: new Set(Object.keys(schemaOrProperties)), patterns: [] };

  const candidates = summaryFieldCandidates();
  for (const candidate of candidates) {
    if (declaredNames.has(candidate)) continue;
    if (patterns.some((pattern) => patternMatchesField(pattern, candidate))) continue;
    return candidate;
  }
  for (const candidate of candidates) {
    if (!declaredNames.has(candidate)) return candidate;
  }
  for (let suffix = 33; ; suffix += 1) {
    const candidate = `${FALLBACK_ASSISTANT_SUMMARY_PREFIX}_${suffix}`;
    if (!declaredNames.has(candidate)) return candidate;
  }
}

function excludeSummaryFromPatternProperties(
  patternProperties: Record<string, unknown>,
  summaryField: string,
): { readonly updated: Record<string, unknown>; readonly changed: boolean } {
  let changed = false;
  const updated: Record<string, unknown> = {};
  const escaped = escapeRegExp(summaryField);
  for (const [pattern, subschema] of Object.entries(patternProperties)) {
    let matches = false;
    let compilable = true;
    try {
      matches = new RegExp(pattern).test(summaryField);
    } catch {
      compilable = false;
    }
    if (compilable && matches) {
      updated[`^(?!${escaped}$)(?:[\\s\\S]*?(?:${pattern}))`] = subschema;
      changed = true;
    } else {
      updated[pattern] = subschema;
    }
  }
  return { updated, changed };
}

function allowSummaryInPropertyNames(propertyNames: unknown, summaryField: string): unknown {
  if (propertyNames === undefined || propertyNames === true) return propertyNames;
  if (propertyNames === false) return { const: summaryField };
  if (isRecord(propertyNames)) {
    return { anyOf: [propertyNames, { const: summaryField }] };
  }
  return propertyNames;
}

function branchHasBlockingConstraint(node: Record<string, unknown>, summaryField: string): boolean {
  if (node.additionalProperties === false || node.unevaluatedProperties === false) return true;
  if (Object.prototype.hasOwnProperty.call(node, 'propertyNames')) return true;
  if (typeof node.maxProperties === 'number' || typeof node.minProperties === 'number') return true;
  if (isRecord(node.patternProperties)) {
    for (const pattern of Object.keys(node.patternProperties)) {
      if (patternMatchesField(pattern, summaryField)) return true;
    }
  }
  return false;
}

function allowAssistantSummaryInBranch(
  subschema: unknown,
  summaryField: string,
  root: Record<string, unknown>,
  depth: number,
  seenRefs: ReadonlySet<string> = new Set(),
): unknown {
  if (depth > MAX_SCHEMA_WALK_DEPTH || !isRecord(subschema)) return subschema;
  let working: Record<string, unknown> = subschema;
  let changed = false;

  if (typeof subschema.$ref === 'string' && !seenRefs.has(subschema.$ref)) {
    const resolved = resolveLocalRef(root, subschema.$ref);
    if (resolved && branchHasBlockingConstraint(resolved, summaryField)) {
      const nextSeen = new Set(seenRefs);
      nextSeen.add(subschema.$ref);
      const { $ref: _removedRef, ...siblings } = subschema;
      const inlined = { ...resolved, ...siblings };
      return allowAssistantSummaryInBranch(inlined, summaryField, root, depth + 1, nextSeen);
    }
  }

  const next: Record<string, unknown> = { ...working };
  const subProps = isRecord(working.properties) ? working.properties : undefined;
  const hasSummary = subProps !== undefined && Object.prototype.hasOwnProperty.call(subProps, summaryField);

  if (!hasSummary && (working.additionalProperties === false || working.unevaluatedProperties === false)) {
    next.properties = {
      ...(subProps ?? {}),
      [summaryField]: ASSISTANT_SUMMARY_PROPERTY,
    };
    changed = true;
  }
  if (!hasSummary && Object.prototype.hasOwnProperty.call(working, 'propertyNames')) {
    const updatedNames = allowSummaryInPropertyNames(working.propertyNames, summaryField);
    if (updatedNames !== working.propertyNames) {
      next.propertyNames = updatedNames;
      changed = true;
    }
  }
  if (!hasSummary && isRecord(working.patternProperties)) {
    const rewritten = excludeSummaryFromPatternProperties(working.patternProperties, summaryField);
    if (rewritten.changed) {
      next.patternProperties = rewritten.updated;
      changed = true;
    }
  }
  if (!hasSummary && typeof working.maxProperties === 'number' && Number.isFinite(working.maxProperties)) {
    next.maxProperties = working.maxProperties + 1;
    changed = true;
  }
  if (!hasSummary && typeof working.minProperties === 'number' && Number.isFinite(working.minProperties)) {
    next.minProperties = working.minProperties + 1;
    changed = true;
  }
  for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = working[combiner];
    if (Array.isArray(branches)) {
      const updated = branches.map((branch) =>
        allowAssistantSummaryInBranch(branch, summaryField, root, depth + 1, seenRefs),
      );
      if (updated.some((entry, index) => entry !== branches[index])) {
        next[combiner] = updated;
        changed = true;
      }
    }
  }
  for (const key of ['if', 'then', 'else'] as const) {
    if (isRecord(working[key])) {
      const updated = allowAssistantSummaryInBranch(working[key], summaryField, root, depth + 1, seenRefs);
      if (updated !== working[key]) {
        next[key] = updated;
        changed = true;
      }
    }
  }
  if (isRecord(working.dependentSchemas)) {
    let depChanged = false;
    const nextDeps: Record<string, unknown> = {};
    for (const [depKey, depSchema] of Object.entries(working.dependentSchemas)) {
      const updated = allowAssistantSummaryInBranch(depSchema, summaryField, root, depth + 1, seenRefs);
      if (updated !== depSchema) depChanged = true;
      nextDeps[depKey] = updated;
    }
    if (depChanged) {
      next.dependentSchemas = nextDeps;
      changed = true;
    }
  }
  return changed ? next : subschema;
}

export function withAssistantSummarySchema(
  schema: Record<string, unknown>,
  summaryField?: string,
): Tool['inputSchema'] {
  const existingProperties = isRecord(schema.properties) ? schema.properties : {};
  const field = summaryField ?? pickAssistantSummaryField(schema);
  const alreadyPresent = Object.prototype.hasOwnProperty.call(existingProperties, field);
  const existingRequired = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const required = existingRequired.includes(field) ? [...existingRequired] : [...existingRequired, field];

  let base: Record<string, unknown> = { ...schema };
  if (!alreadyPresent) {
    if (typeof base.$ref === 'string') {
      const resolved = resolveLocalRef(schema, base.$ref);
      if (resolved && branchHasBlockingConstraint(resolved, field)) {
        const { $ref: _removedRef, ...siblings } = base;
        base = { ...resolved, ...siblings };
      }
    }
    if (Object.prototype.hasOwnProperty.call(base, 'propertyNames')) {
      base.propertyNames = allowSummaryInPropertyNames(base.propertyNames, field);
    }
    if (isRecord(base.patternProperties)) {
      const rewritten = excludeSummaryFromPatternProperties(base.patternProperties, field);
      if (rewritten.changed) base.patternProperties = rewritten.updated;
    }
    if (typeof base.maxProperties === 'number' && Number.isFinite(base.maxProperties)) {
      base.maxProperties = base.maxProperties + 1;
    }
    if (typeof base.minProperties === 'number' && Number.isFinite(base.minProperties)) {
      base.minProperties = base.minProperties + 1;
    }
    for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = base[combiner];
      if (Array.isArray(branches)) {
        base[combiner] = branches.map((branch) => allowAssistantSummaryInBranch(branch, field, schema, 0));
      }
    }
    for (const key of ['if', 'then', 'else'] as const) {
      if (isRecord(base[key])) {
        base[key] = allowAssistantSummaryInBranch(base[key], field, schema, 0);
      }
    }
    if (isRecord(base.dependentSchemas)) {
      const nextDeps: Record<string, unknown> = {};
      for (const [depKey, depSchema] of Object.entries(base.dependentSchemas)) {
        nextDeps[depKey] = allowAssistantSummaryInBranch(depSchema, field, schema, 0);
      }
      base.dependentSchemas = nextDeps;
    }
  }

  const baseProperties = isRecord(base.properties) ? base.properties : existingProperties;
  const properties: Record<string, object | boolean> = {};
  for (const [key, value] of Object.entries(baseProperties)) {
    if (isRecord(value) || typeof value === 'boolean') properties[key] = value;
  }
  properties[field] = ASSISTANT_SUMMARY_PROPERTY;

  return {
    ...base,
    type: 'object',
    properties: properties as Tool['inputSchema']['properties'],
    required,
  };
}

export function extractSummaryAndArgs(
  rawArgs: Record<string, unknown> | undefined,
  summaryField: string | null = ASSISTANT_SUMMARY_FIELD,
): {
  readonly args: Record<string, unknown>;
  readonly summary?: string;
} {
  if (!rawArgs) return { args: {} };
  if (summaryField === null || !Object.prototype.hasOwnProperty.call(rawArgs, summaryField)) {
    return { args: { ...rawArgs } };
  }
  const { [summaryField]: rawSummary, ...args } = rawArgs;
  const summary = typeof rawSummary === 'string' && rawSummary.trim().length > 0 ? rawSummary.trim() : undefined;
  return summary === undefined ? { args } : { args, summary };
}

function formatRelayedTool(raw: unknown): { readonly tool: Tool; readonly summaryField: string | null } | undefined {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !isRecord(raw.inputSchema)) return undefined;
  const label = raw.label === 'ask_first' || raw.label === 'just_do' ? raw.label : null;
  const summaryField = label === 'ask_first' ? pickAssistantSummaryField(raw.inputSchema) : null;
  const inputSchema =
    summaryField !== null
      ? withAssistantSummarySchema(raw.inputSchema, summaryField)
      : ({ ...raw.inputSchema, type: 'object' } as Tool['inputSchema']);
  const tool: Tool = {
    name: raw.name,
    inputSchema,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(isRecord(raw.annotations) ? { annotations: raw.annotations as Tool['annotations'] } : {}),
  };
  return { tool, summaryField };
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
      return errorToolResult(
        'Waiting for this app tool call was cancelled; the call may still complete on the host — check before retrying.',
      );
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
  let hasListed = false;
  const toolSummaryFields = new Map<string, string | null>();
  const previousSummaryFields = new Map<string, string | null>();

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
    const nextSummaryFields = new Map<string, string | null>();
    const tools: Tool[] = [];
    for (const entry of rawTools) {
      const formatted = formatRelayedTool(entry);
      if (!formatted) continue;
      nextSummaryFields.set(formatted.tool.name, formatted.summaryField);
      tools.push(formatted.tool);
    }
    for (const [name, prevField] of toolSummaryFields) {
      if (nextSummaryFields.has(name) && nextSummaryFields.get(name) !== prevField) {
        previousSummaryFields.set(name, prevField);
      } else {
        previousSummaryFields.delete(name);
      }
    }
    toolSummaryFields.clear();
    for (const [name, field] of nextSummaryFields) toolSummaryFields.set(name, field);
    hasListed = true;
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    const rawArgs = request.params.arguments;
    const toolName = request.params.name;
    let summaryField: string | null;
    if (toolSummaryFields.has(toolName)) {
      const currentField = toolSummaryFields.get(toolName)!;
      const prevField = previousSummaryFields.get(toolName);
      if (
        prevField !== undefined &&
        prevField !== null &&
        prevField !== currentField &&
        rawArgs &&
        Object.prototype.hasOwnProperty.call(rawArgs, prevField)
      ) {
        const missingCurrent = currentField !== null && !Object.prototype.hasOwnProperty.call(rawArgs, currentField);
        const carriesPriorFallback = prevField !== ASSISTANT_SUMMARY_FIELD;
        if (missingCurrent || carriesPriorFallback) {
          return errorToolResult('This tool schema changed since it was listed; refresh the tool list and retry.');
        }
      }
      summaryField = currentField;
    } else if (hasListed) {
      // Do not guess and strip assistant_summary for a tool absent from the latest listing.
      summaryField = null;
    } else {
      summaryField = ASSISTANT_SUMMARY_FIELD;
    }
    const { args, summary } = extractSummaryAndArgs(rawArgs, summaryField);
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
