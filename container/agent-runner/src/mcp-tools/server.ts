/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 *
 * Every tool is granted by one capability key: `registerTools` takes it, and
 * `loadToolModule` attributes a whole module's tools to one key while it
 * loads. The runner's server serves only the tools of the keys its group
 * holds; a tool registered without a key is never served to a group.
 *
 * Installed feature modules can additively extend an already-registered
 * tool via `extendTool()` instead of editing the base tool's source —
 * see the doc comment on `extendTool` below. With no extensions
 * registered, tool definitions and behavior are byte-identical to the
 * base modules.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { withOutboundPassthrough } from '../db/messages-out.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();
/** Tool name → the capability key that grants it. */
const toolCapabilities = new Map<string, string>();
/** The key `loadToolModule` is attributing registrations to, while one loads. */
let loadingCapability: string | undefined;

export function registerTools(tools: McpToolDefinition[], capability: string | undefined = loadingCapability): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
    if (capability !== undefined) toolCapabilities.set(t.tool.name, capability);
  }
}

/**
 * Import a tool module whose tools one capability key grants. Every tool the
 * module registers while it loads is attributed to `capability`, so a module
 * needs no knowledge of capabilities. Loads must not overlap: attribution is
 * by load window, and a second load inside the first would mislabel tools.
 */
export async function loadToolModule(capability: string, load: () => Promise<unknown>): Promise<void> {
  if (loadingCapability !== undefined) {
    throw new Error(`loadToolModule("${capability}") overlaps the load of "${loadingCapability}"`);
  }
  loadingCapability = capability;
  try {
    await load();
  } finally {
    loadingCapability = undefined;
  }
}

/**
 * The tools a group's capability keys grant. Without `grants` every
 * registered tool is served — a test exercising a tool directly; the runner's
 * server always passes its group's keys.
 */
function isServed(name: string, grants: ReadonlySet<string> | undefined): boolean {
  if (!grants) return true;
  const capability = toolCapabilities.get(name);
  return capability !== undefined && grants.has(capability);
}

/** Additive extension of an already-registered tool. All fields optional. */
export interface ToolExtension {
  /**
   * Extra `inputSchema.properties` merged into the base tool's schema.
   * Keys must not collide with base properties or earlier extensions —
   * a collision throws so a bad install fails loudly and deterministically.
   */
  properties?: Record<string, unknown>;
  /**
   * Arg keys copied verbatim from the call args into any system-action
   * JSON payload the base handler writes via `writeMessageOut` during the
   * call (see `withOutboundPassthrough` in ../db/messages-out.ts). Keys the
   * handler already set in its payload are never overwritten.
   */
  passthroughKeys?: string[];
  /** Text appended (space-separated) to the base tool's description. */
  descriptionSuffix?: string;
}

const passthroughKeysByTool = new Map<string, Set<string>>();

/**
 * Extend a registered tool's input schema, description, and outbound
 * payload additively — the mechanism feature modules use instead of
 * editing base tool files. The base tool's source stays channel-neutral;
 * an installed module (e.g. dropped in by an /add-<channel> skill) calls
 * `extendTool` at import time to enrich it.
 *
 * Extensions are additive and deterministic: description suffixes append
 * in call order, schema properties merge (collisions throw), and
 * passthrough key sets union. Calling `extendTool` twice for the same
 * tool never stacks handler wrappers.
 *
 * Must be called after the base tool's module has registered it (the
 * barrel imports base tool modules before extension modules).
 */
export function extendTool(name: string, extension: ToolExtension): void {
  const def = toolMap.get(name);
  if (!def) {
    throw new Error(`extendTool: unknown tool "${name}" — the base tool must be registered before it can be extended`);
  }

  const { properties, passthroughKeys, descriptionSuffix } = extension;

  if (properties) {
    const schema = def.tool.inputSchema as { type: 'object'; properties?: Record<string, unknown> };
    const existing = (schema.properties ??= {});
    for (const [key, value] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(existing, key)) {
        throw new Error(`extendTool: property "${key}" already exists on tool "${name}"`);
      }
      existing[key] = value;
    }
  }

  if (descriptionSuffix) {
    def.tool.description = def.tool.description ? `${def.tool.description} ${descriptionSuffix}` : descriptionSuffix;
  }

  if (passthroughKeys && passthroughKeys.length > 0) {
    const known = passthroughKeysByTool.get(name);
    if (known) {
      // Already wrapped — the wrapper reads the live key set, so a second
      // extension only needs to add its keys (no wrapper stacking).
      for (const key of passthroughKeys) known.add(key);
      return;
    }
    passthroughKeysByTool.set(name, new Set(passthroughKeys));

    const base = def.handler;
    def.handler = (args, context) => {
      const entries: Record<string, unknown> = {};
      for (const key of passthroughKeysByTool.get(name) ?? []) {
        if (Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined) {
          entries[key] = args[key];
        }
      }
      if (Object.keys(entries).length === 0) return base(args, context);
      return withOutboundPassthrough(entries, () => base(args, context));
    };
  }
}

export function createMcpServer(
  run: <T>(action: () => T | Promise<T>) => Promise<T> = async (action) => action(),
  grants?: ReadonlySet<string>,
): Server {
  const server = new Server({ name: 'nanoclaw', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.filter((t) => isServed(t.tool.name, grants)).map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool || !isServed(name, grants)) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    return run(() => tool.handler(args ?? {}, { signal: context.signal }));
  });
  return server;
}

export async function startMcpServer(
  run: <T>(action: () => T | Promise<T>) => Promise<T>,
  grants: ReadonlySet<string>,
): Promise<void> {
  const server = createMcpServer(run, grants);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const served = allTools.filter((t) => isServed(t.tool.name, grants)).map((t) => t.tool.name);
  log(`MCP server started with ${served.length} tools: ${served.join(', ')}`);
  const unattributed = allTools.map((t) => t.tool.name).filter((name) => !toolCapabilities.has(name));
  if (unattributed.length > 0) {
    log(`Warning: tools registered without a capability key are never served: ${unattributed.join(', ')}`);
  }
}
