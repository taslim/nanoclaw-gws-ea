/**
 * Per-agent capabilities: one allowlist per agent group that decides every
 * agent's tools and reach. A key nobody granted stays off.
 *
 * This is the host-side source of truth. A group stores `all` or a list of
 * keys in `container_configs.capabilities`; `all` means every registered key
 * whose registry default is `on`. At spawn the host resolves the stored value
 * to an explicit list and writes it into the read-only container.json, where
 * the runner builds the agent's tools from it alone and treats a missing or
 * malformed list as no capabilities at all.
 *
 * Each key declares what it brings on the host — the tool-module instructions
 * the project document inlines and the shared skills that need it — and core
 * code keyed by the exported constants applies its host effects (MCP servers,
 * cross-session context, the gateway skill, read-only surfaces). The runner
 * maps the same keys to its own tools: Claude's built-ins in
 * container/agent-runner/src/providers/claude-config.ts and NanoClaw's tool
 * modules in container/agent-runner/src/mcp-tools/index.ts. Modules add keys
 * with `registerCapability`.
 *
 * `cli_scope` stays the only authority for `ncl`.
 */
import { getContainerConfig } from './db/container-configs.js';
import { log } from './log.js';

export type CapabilityDefault = 'on' | 'off';

export interface CapabilityDef {
  /** What the key grants, for `ncl groups config` and its errors. */
  description: string;
  /** Whether a group stored as `all` holds it. */
  default: CapabilityDefault;
  /** Tool-module instruction documents (`<name>.instructions.md`) the key brings into the project document. */
  instructions?: readonly string[];
  /** Shared container skills that need the key. A skill no key names needs `shell`. */
  skills?: readonly string[];
}

/** Keys whose host effects core applies directly. */
export const SHELL_CAPABILITY = 'shell';
export const MCP_SERVERS_CAPABILITY = 'mcp-servers';
export const CONVERSATION_CONTEXT_CAPABILITY = 'conversation-context';

/** A group's stored capabilities: every default key, or an explicit list. */
export type CapabilitySelection = 'all' | readonly string[];

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const registry = new Map<string, CapabilityDef>();

/** Register a capability key. Keys are permanent identities; a duplicate or malformed key throws. */
export function registerCapability(key: string, def: CapabilityDef): void {
  if (!KEY_RE.test(key) || key === 'all') {
    throw new Error(`Capability key "${key}" must be lowercase letters, digits and "-", and not "all"`);
  }
  if (registry.has(key)) throw new Error(`Capability "${key}" already registered`);
  registry.set(key, def);
}

/** Every registered key in registration order. */
export function listCapabilityKeys(): string[] {
  return [...registry.keys()];
}

registerCapability('reply', {
  description: 'send_message: reply in the conversation and message its destinations',
  default: 'on',
  instructions: ['core'],
  skills: ['welcome'],
});
registerCapability('files-send', {
  description: 'send_file, edit_message, add_reaction',
  default: 'on',
  instructions: ['files-send'],
});
registerCapability('files-read', { description: 'Read, Glob, Grep', default: 'on' });
registerCapability('files-write', { description: 'Write, Edit, NotebookEdit', default: 'on' });
registerCapability(SHELL_CAPABILITY, {
  description: 'Bash, and with it ncl and every command-line skill',
  default: 'on',
  // `cli` and `scheduling` teach `ncl`, which the agent runs through the
  // shell; `connect` teaches connecting an account through the gateway, whose
  // credentials reach the agent only through commands it runs.
  instructions: ['cli', 'scheduling', 'connect'],
  skills: ['agent-browser', 'frontend-engineer', 'self-customize'],
});
registerCapability('web', { description: 'WebSearch, WebFetch', default: 'on' });
registerCapability('subagents', {
  description: 'Task, Agent, TaskStop, TeamCreate, TeamDelete',
  default: 'on',
});
registerCapability(CONVERSATION_CONTEXT_CAPABILITY, {
  description:
    "context from the conversation's other sessions, by fan-out and backfill, and one provider state (such as Claude's home) shared by all the group's sessions",
  default: 'on',
  // Group memory and the conversation archive are shared by every session;
  // a group without the key keeps neither (the runner's memory/sealed.ts).
  instructions: ['memory'],
});
registerCapability(MCP_SERVERS_CAPABILITY, {
  description: 'configured, plugin, and claude.ai connector MCP servers',
  default: 'on',
});
registerCapability('interactive', {
  description: 'ask_user_question, send_card',
  default: 'on',
  instructions: ['interactive'],
});
registerCapability('agents', { description: 'create_agent', default: 'on', instructions: ['agents'] });
registerCapability('self-mod', {
  description: 'install_packages, add_mcp_server',
  default: 'on',
  instructions: ['self-mod'],
});
registerCapability('time', { description: 'the time_* tools', default: 'on', instructions: ['time'] });
registerCapability('request-status', {
  description: 'request_status: the answer to a request the host was slow to answer, from the session’s own mailbox',
  default: 'on',
});

// Durable bad state (a stale key in the DB) would otherwise log on every
// spawn; warn once per distinct problem per host process instead.
const warned = new Set<string>();
function warnOnce(signature: string, message: string, data: Record<string, unknown>): void {
  if (warned.has(signature)) return;
  warned.add(signature);
  log.warn(message, data);
}

/**
 * Read the stored column. An absent column (the module migration has not run)
 * is `all`, as every group was before capabilities. An unreadable value is an
 * empty list: an isolation control fails closed, never open.
 */
export function parseStoredCapabilities(raw: string | undefined, groupName: string): CapabilitySelection {
  if (raw === undefined) return 'all';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    parsed = undefined;
  }
  if (parsed === 'all') return 'all';
  if (Array.isArray(parsed) && parsed.every((key): key is string => typeof key === 'string')) return parsed;
  log.error('Stored capabilities are not "all" or a list of keys; granting none', { group: groupName, raw });
  return [];
}

/**
 * The explicit list a selection grants, in registry order. An unknown stored
 * key is ignored with a warning and never granted.
 */
export function resolveCapabilities(selection: CapabilitySelection, groupName: string): string[] {
  if (selection === 'all') return [...registry].filter(([, def]) => def.default === 'on').map(([key]) => key);
  for (const key of selection) {
    if (!registry.has(key)) {
      warnOnce(`${groupName}:${key}`, 'Ignoring unknown stored capability', { group: groupName, key });
    }
  }
  return listCapabilityKeys().filter((key) => selection.includes(key));
}

/**
 * Parse the `ncl groups config update --capabilities` value: `all`, or
 * comma-separated keys. Unknown keys are refused here, at the only write path.
 */
export function parseCapabilitiesArg(input: string): CapabilitySelection {
  const value = input.trim();
  if (value === 'all') return 'all';
  const keys = value
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (keys.length === 0) {
    throw new Error(`--capabilities takes "all" or comma-separated keys: ${listCapabilityKeys().join(', ')}`);
  }
  for (const key of keys) {
    if (!registry.has(key)) {
      throw new Error(`unknown capability "${key}" — keys: ${listCapabilityKeys().join(', ')}`);
    }
  }
  return listCapabilityKeys().filter((key) => keys.includes(key));
}

/** The capabilities an agent group holds now, read the way a spawn reads them. */
export async function getGroupCapabilities(agentGroupId: string): Promise<ReadonlySet<string>> {
  const stored = (await getContainerConfig(agentGroupId))?.capabilities;
  return new Set(resolveCapabilities(parseStoredCapabilities(stored, agentGroupId), agentGroupId));
}

/**
 * Whether a tool-module instruction document belongs in the project document.
 * A document no registered key names is left out and logged once: its tools
 * have no key, so no agent can call them.
 */
export function grantsInstructions(moduleName: string, grants: ReadonlySet<string>): boolean {
  let named = false;
  for (const [key, def] of registry) {
    if (!def.instructions?.includes(moduleName)) continue;
    named = true;
    if (grants.has(key)) return true;
  }
  if (!named) {
    warnOnce(`instructions:${moduleName}`, 'Tool-module instructions no capability names are left out', {
      module: moduleName,
    });
  }
  return false;
}

/**
 * Bound a skill selection by capabilities. A skill is kept when the group
 * holds every key that names it; a skill no key names needs `shell`, because a
 * skill's commands run through the shell.
 */
export function skillsWithinCapabilities(skills: readonly string[], grants: ReadonlySet<string>): string[] {
  return skills.filter((skill) => {
    const needs = [...registry].filter(([, def]) => def.skills?.includes(skill)).map(([key]) => key);
    return (needs.length > 0 ? needs : [SHELL_CAPABILITY]).every((key) => grants.has(key));
  });
}

/** Whether the agent is taught the selected gateway: credentials reach it only through commands it runs. */
export function teachesGateway(grants: ReadonlySet<string>): boolean {
  return grants.has(SHELL_CAPABILITY);
}

/**
 * A group without a shell gets read-only instructions, settings, MCP config
 * and skills. With a shell an agent can reach anything writable, so the
 * read-only mounts would add nothing.
 */
export function isRestricted(grants: ReadonlySet<string>): boolean {
  return !grants.has(SHELL_CAPABILITY);
}
