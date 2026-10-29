/**
 * `external-email`'s agent group: created once by the host from the
 * release's template, then never written by host-start code again. What the
 * host stamped is the only shape it may start in; anything else is drift,
 * which the session admission refuses and status reports.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseStoredCapabilities, registerCapability, resolveCapabilities } from '../../capabilities.js';
import { GROUPS_DIR } from '../../config.js';
import { parseSkillSelection } from '../../container-config.js';
import { registerContainerEnv } from '../../container-env.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import { log } from '../../log.js';
import { getProviderHostContract } from '../../provider-contracts/index.js';
import { resolveProviderName } from '../../providers/provider-name.js';
import { createAgentFromTemplate, groupSkillsOverlayDir } from '../../templates/create-agent.js';
import type { ContainerConfigRow } from '../../types.js';
import {
  getExternalEmailAgentGroupId,
  nameAssistantAgent,
  recordExternalEmailAgentGroupId,
} from '../gws-ea-profile/db.js';

/**
 * The email channel's tool keys, one for each part, registered together so
 * each tool's grant is found in one place. The actions they send belong to
 * the modules that answer them, not to this one. Each key brings its tools'
 * instructions, in the runner's `<key>.instructions.md`.
 */
export const MAIN_EMAIL_CAPABILITY = 'gws-ea-email';
export const EXTERNAL_EMAIL_TOOLS_CAPABILITY = 'gws-ea-email-external';

registerCapability(MAIN_EMAIL_CAPABILITY, {
  description:
    'email_handoff, email_principal: hand external-email work in an email thread, and email the principal in one of theirs',
  default: 'on',
  instructions: [MAIN_EMAIL_CAPABILITY],
});
registerCapability(EXTERNAL_EMAIL_TOOLS_CAPABILITY, {
  description:
    "email_send, tell_main, free_time, book, change_booking, cancel_booking, sign_in_reply: external-email's email and scheduling in its own thread, word to main, and host sign-in answers",
  default: 'off',
  instructions: [EXTERNAL_EMAIL_TOOLS_CAPABILITY],
});
// Main's shorter system prompt, for the same character.
registerContainerEnv(
  'gws-ea-external-email:system-prompt',
  ({ capabilities }): Record<string, string> =>
    capabilities.has(EXTERNAL_EMAIL_TOOLS_CAPABILITY) ? { CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '1' } : {},
);

/** The release template the host stamps the group from, and the plugin that stamp leaves in its folder. */
export const EXTERNAL_EMAIL_TEMPLATE = 'gws-ea/external-email';
export const EXTERNAL_EMAIL_PLUGIN = 'gws-ea-external-email';
export const EXTERNAL_EMAIL_NAME = 'external-email';

/**
 * Exactly what the group holds; the `time_*` calculators compute over the
 * container's clock and reveal nothing. No timers: main nudges a thread when
 * its matter comes due. No write tools, shell, web, subagents, MCP servers,
 * messages to destinations, or `conversation-context`: each of its sessions
 * is sealed from every other, and nothing of one thread lands in the folder
 * its sessions share.
 */
export const EXTERNAL_EMAIL_CAPABILITIES: readonly string[] = [
  'files-read',
  'time',
  'request-status',
  EXTERNAL_EMAIL_TOOLS_CAPABILITY,
];

/**
 * The group, its configuration, and the pointer are written in one
 * transaction, so a host stopped part-way leaves no group the pointer misses;
 * files the template stamped before such a stop stay in a folder the next
 * attempt does not reuse.
 */
export async function ensureExternalEmailGroup(): Promise<string> {
  const existing = await getExternalEmailAgentGroupId();
  if (existing !== null) return existing;
  return getDb().transaction(async () => {
    const { group } = await createAgentFromTemplate(EXTERNAL_EMAIL_TEMPLATE, { name: EXTERNAL_EMAIL_NAME });
    await updateContainerConfigScalars(group.id, { cli_scope: 'disabled' });
    await updateContainerConfigJson(group.id, 'capabilities', [...EXTERNAL_EMAIL_CAPABILITIES]);
    await updateContainerConfigJson(group.id, 'skills', []);
    await recordExternalEmailAgentGroupId(group.id);
    await nameAssistantAgent(group.id);
    log.info('Created external-email', { agentGroupId: group.id, folder: group.folder });
    return group.id;
  });
}

/** The session's pinned provider, when known, which spawn prefers to the group's. */
export interface DriftContext {
  readonly sessionProvider?: string | null;
}

export async function externalEmailDrift(agentGroupId: string, context: DriftContext = {}): Promise<string[]> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) return [`its agent group ${agentGroupId} no longer exists`];
  const row = await getContainerConfig(agentGroupId);
  if (!row) return ['it has no container configuration'];
  const problems = configurationDrift(row, group.name);
  problems.push(...stampedPluginDrift(agentGroupId, group.folder));

  const provider = resolveProviderName(context.sessionProvider, row.provider);
  const contract = getProviderHostContract(provider);
  if (
    !contract ||
    contract.stateVolumes.some((volume) => volume.scope === 'group' && volume.sealedScope !== 'session')
  ) {
    problems.push(`its provider ${provider} does not give each session its own state`);
  }
  return problems;
}

function configurationDrift(row: ContainerConfigRow, groupName: string): string[] {
  const problems: string[] = [];
  const held = resolveCapabilities(parseStoredCapabilities(row.capabilities, groupName), groupName);
  if (
    held.length !== EXTERNAL_EMAIL_CAPABILITIES.length ||
    held.some((key) => !EXTERNAL_EMAIL_CAPABILITIES.includes(key))
  ) {
    problems.push(
      `its capabilities are ${held.join(', ') || 'none'}, not exactly ${EXTERNAL_EMAIL_CAPABILITIES.join(' and ')}`,
    );
  }
  if (row.cli_scope !== 'disabled') problems.push(`its CLI scope is ${row.cli_scope}, not disabled`);
  const servers = Object.keys(jsonRecord(row.mcp_servers));
  if (servers.length > 0) problems.push(`its configuration carries MCP servers (${servers.join(', ')})`);
  const packages = [...jsonList(row.packages_apt), ...jsonList(row.packages_npm)];
  if (packages.length > 0) problems.push(`its configuration carries packages (${packages.join(', ')})`);
  if (jsonList(row.additional_mounts).length > 0) problems.push('its configuration carries extra mounts');
  const skills = parseSkillSelection(row.skills, groupName);
  if (skills === 'all') problems.push('it is handed every shared skill');
  else if (skills.length > 0) problems.push(`it is handed shared skills (${skills.join(', ')})`);
  return problems;
}

function stampedPluginDrift(agentGroupId: string, folder: string): string[] {
  const problems: string[] = [];
  const others = directoryEntries(path.join(GROUPS_DIR, folder, 'plugins')).filter(
    (name) => name !== EXTERNAL_EMAIL_PLUGIN,
  );
  if (others.length > 0) problems.push(`its folder carries other stamped plugins (${others.join(', ')})`);
  const skills = directoryEntries(groupSkillsOverlayDir(agentGroupId));
  if (skills.length > 0) problems.push(`its stamped plugins brought template skills (${skills.join(', ')})`);
  return problems;
}

function directoryEntries(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

/** Text that does not parse is returned as is, so it counts as carrying something. */
function storedJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (err instanceof SyntaxError) return raw;
    throw err;
  }
}

/** A stored JSON object column; anything else counts as carrying something. */
function jsonRecord(raw: string): Record<string, unknown> {
  const parsed = storedJson(raw);
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  return { [raw]: parsed };
}

/** A stored JSON list column; anything else counts as carrying something. */
function jsonList(raw: string): unknown[] {
  const parsed = storedJson(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}
