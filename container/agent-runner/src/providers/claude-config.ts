/**
 * Pure configuration derivations for the Claude provider. These are the
 * provider-runtime implementations the runtime contract declares for the
 * executionPolicy / inference / mcpServers / memory capabilities — and the
 * exact functions the live query path consumes, so the contract's probe
 * exercises the real wiring, not a parallel description of it.
 */

import type { RuntimeInferenceInput } from '../provider-contracts/registry.js';
import { shimCwd } from './cwd-shim.js';
import type { McpServerConfig } from './types.js';

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via `ncl tasks`.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - SendMessage: addresses Claude Code's own in-session subagents, which are
//   unrelated to NanoClaw agent groups — but the name reads as the obvious
//   way to message another agent, so an agent that just called
//   mcp__nanoclaw__create_agent reaches for it and gets "No agent named 'x'
//   is currently addressable". mcp__nanoclaw__send_message is the real
//   agent-to-agent path (it resolves the destination map in inbound.db).
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
// - DesignSync: desktop design-tool integration — nothing to sync with in a
//   headless container (~9.3KB/turn schema).
// - ReportFindings: code-review-reporting UI affordance with no headless
//   host surface to receive it (~1.9KB/turn schema).
export const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'SendMessage',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'ReportFindings',
];

// The built-in half of the SDK's `allowedTools`; `resolveClaudeMcpServers`
// appends one `mcp__<server>__*` pattern per registered MCP server. These are
// permission allow rules: they pre-approve calls, which `bypassPermissions`
// approves anyway, so a built-in missing here (such as the `subagents` key's
// Agent, ListAgents and Workflow) is still offered. What an agent is offered
// comes from `tools` and `disallowedTools`, which `resolveClaudeToolOptions`
// sets from its capabilities. Two entries do widen the pinned Claude Code's
// default set: Glob or Grep adds both, and TodoWrite adds TaskCreate,
// TaskGet, TaskList and TaskUpdate.
export const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

/**
 * The runner half of the capability contract for Claude: which built-in tools
 * each capability key grants. The host owns the keys and resolves a group's
 * list; tool names are a Claude concept, so the mapping lives here. A tool
 * listed under several keys is granted by any of them (Claude Code adds
 * TaskStop beside Bash, to stop a background shell).
 */
export const CAPABILITY_BUILTIN_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'files-read': ['Read', 'Glob', 'Grep'],
  'files-write': ['Write', 'Edit', 'NotebookEdit'],
  shell: ['Bash', 'TaskStop'],
  web: ['WebSearch', 'WebFetch'],
  subagents: ['Task', 'Agent', 'TaskStop', 'TeamCreate', 'TeamDelete', 'ListAgents', 'Workflow'],
};

/** Built-ins every agent holding any key keeps: loading its selected skills and keeping its own task list. */
export const BASE_BUILTIN_TOOLS: readonly string[] = [
  'Skill',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
];

/** The key that grants MCP servers other than NanoClaw's own: configured, plugin, and claude.ai connectors. */
export const MCP_SERVERS_CAPABILITY = 'mcp-servers';

/** NanoClaw's own tool server, which serves only the tool modules the group holds. */
export const NANOCLAW_MCP_SERVER = 'nanoclaw';

/**
 * What a group's capabilities allow of Claude's own surfaces.
 *
 * `tools` is undefined when every built-in key is held: the SDK then offers
 * its full default set, exactly as before capabilities existed. Otherwise it
 * is the explicit allowlist, and a built-in no held key names is never offered.
 */
export interface ClaudeCapabilityPolicy {
  tools?: readonly string[];
  /** Built-ins of keys the group does not hold, disallowed outright. */
  withheldTools: readonly string[];
  /** Whether MCP servers other than NanoClaw's own are reachable. */
  externalMcpServers: boolean;
}

export function resolveClaudeCapabilityPolicy(grants: ReadonlySet<string>): ClaudeCapabilityPolicy {
  const granted = new Set<string>();
  const named = new Set<string>();
  for (const [key, tools] of Object.entries(CAPABILITY_BUILTIN_TOOLS)) {
    for (const tool of tools) {
      named.add(tool);
      if (grants.has(key)) granted.add(tool);
    }
  }
  const withheldTools = [...named].filter((tool) => !granted.has(tool));
  // An agent that holds no key at all (a missing or corrupt list) is offered nothing.
  const base = grants.size === 0 ? [] : BASE_BUILTIN_TOOLS;
  return {
    tools: withheldTools.length === 0 ? undefined : [...base, ...granted],
    withheldTools,
    externalMcpServers: grants.has(MCP_SERVERS_CAPABILITY),
  };
}

/** Whether a policy lets the agent call a built-in (non-MCP) tool. */
export function allowsBuiltinTool(policy: ClaudeCapabilityPolicy, toolName: string): boolean {
  if (policy.withheldTools.includes(toolName)) return false;
  return policy.tools === undefined || policy.tools.includes(toolName);
}

/** Whether a policy lets the agent call an `mcp__<server>__<tool>` tool. */
export function allowsMcpTool(policy: ClaudeCapabilityPolicy, toolName: string): boolean {
  return policy.externalMcpServers || toolName.startsWith(`mcp__${NANOCLAW_MCP_SERVER}__`);
}

/** The tool-shaping query options a policy produces. */
export interface ClaudeToolOptions {
  tools?: string[];
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  /** Ignore every MCP config file, so only the servers passed here can start. */
  strictMcpConfig?: true;
  env: Record<string, string>;
}

/**
 * Shape the SDK query's tool options to a policy. A policy that withholds
 * nothing returns today's options unchanged. Without `mcp-servers` only
 * NanoClaw's own server is passed, MCP config files are ignored, and claude.ai
 * connectors are switched off, so no other server's command ever starts.
 */
export function resolveClaudeToolOptions(
  policy: ClaudeCapabilityPolicy,
  mcp: { mcpServers: Record<string, McpServerConfig>; allowedTools: readonly string[] },
  disallowedTools: readonly string[],
): ClaudeToolOptions {
  const mcpServers = policy.externalMcpServers
    ? mcp.mcpServers
    : Object.fromEntries(Object.entries(mcp.mcpServers).filter(([name]) => name === NANOCLAW_MCP_SERVER));
  const allowedTools = mcp.allowedTools.filter((tool) =>
    tool.startsWith('mcp__') ? allowsMcpTool(policy, tool) : allowsBuiltinTool(policy, tool),
  );
  return {
    ...(policy.tools ? { tools: [...policy.tools] } : {}),
    allowedTools,
    disallowedTools: [...disallowedTools, ...policy.withheldTools],
    mcpServers,
    ...(policy.externalMcpServers ? {} : { strictMcpConfig: true as const }),
    // The pinned CLI reads this switch beside its disableClaudeAiConnectors setting.
    env: policy.externalMcpServers ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  };
}

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
export function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

/**
 * Claude runs unrestricted inside the container: NanoClaw's container
 * isolation and the OneCLI allow-list are the security boundary, not the
 * SDK's own permission prompts. The disallowed builtins are policy too —
 * they are the SDK surfaces that would bypass nanoclaw's scheduling or hang
 * a headless session.
 *
 * `settings` rides the SDK's flag-level settings, which outrank the group's
 * own settings files, so it holds for every group, existing ones included.
 * Since 2.1.275 Claude Code syncs the skills and plugins enabled on the
 * signed-in claude.ai account into terminal sessions; the sync keys opt out,
 * so an agent gets the skills nanoclaw mounts, not the operator's own.
 */
export function resolveClaudeExecutionPolicy(): {
  permissionMode: 'bypassPermissions';
  allowDangerouslySkipPermissions: true;
  disallowedTools: string[];
  settings: { syncClaudeAiSkills: false; syncClaudeAiPlugins: false };
} {
  return {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // A copy: the contract value is deep-frozen on registration, and the
    // exported constant must stay a plain mutable array.
    disallowedTools: [...SDK_DISALLOWED_TOOLS],
    settings: { syncClaudeAiSkills: false, syncClaudeAiPlugins: false },
  };
}

/**
 * Model and reasoning effort pass to the SDK verbatim; the SDK owns defaults.
 * `speed: 'fast'` maps to the SDK's `fastMode` settings key (the `/fast`
 * toggle); `standard` keeps the SDK default. Unknown values are ignored.
 */
export function resolveClaudeInference(
  input: RuntimeInferenceInput,
  _environment: NodeJS.ProcessEnv,
): { model?: string; effort?: string; settings?: { fastMode: boolean } } {
  return {
    model: input.model,
    effort: input.effort,
    ...(input.speed === 'fast' ? { settings: { fastMode: true } } : {}),
  };
}

/**
 * The SDK's stdio server config has no cwd field, so stdio servers with a
 * cwd are wrapped through the shell shim; the allowlist gains one pattern
 * per server so the SDK's tool filter doesn't drop their namespaces.
 */
export function resolveClaudeMcpServers(
  input: Record<string, McpServerConfig>,
  _environment: NodeJS.ProcessEnv,
): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
  const mcpServers = Object.fromEntries(Object.entries(input).map(([name, server]) => [name, shimCwd(server)]));
  return {
    mcpServers,
    allowedTools: [...TOOL_ALLOWLIST, ...Object.keys(mcpServers).map(mcpAllowPattern)],
  };
}

/**
 * NanoClaw owns persistent memory across providers: the session hook injects
 * the shared memory tree, and the SDK's own auto-memory stays disabled so the
 * two never diverge. The hook itself is file-carried (settings.json); this is
 * the runtime half of the same capability.
 */
export function resolveClaudeMemoryRuntime(): { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } {
  return { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}
