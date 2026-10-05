/**
 * `external-email`'s agent group (KTD3): created once by the host from the
 * release's template, then never written by host-start code again (R35).
 * What the host stamped is the only shape it may start in; anything else is
 * drift, which the session admission refuses and status reports.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseStoredCapabilities, registerCapability, resolveCapabilities } from '../../capabilities.js';
import { GROUPS_DIR } from '../../config.js';
import { parseSkillSelection } from '../../container-config.js';
import { credentialScopeFor } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import type { GatewayCredentialScope } from '../../gateway-providers/index.js';
import { log } from '../../log.js';
import { getProviderHostContract } from '../../provider-contracts/index.js';
import { resolveProviderName } from '../../providers/provider-name.js';
import { createAgentFromTemplate, groupSkillsOverlayDir } from '../../templates/create-agent.js';
import type { ContainerConfigRow } from '../../types.js';
import { getExternalEmailAgentGroupId, recordExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { REMINDERS_CAPABILITY } from '../gws-ea-reminders/index.js';

/**
 * The email channel's tool keys, one for each part (KTD4), registered
 * together so each tool's grant is found in one place. The actions they send
 * belong to the modules that answer them: the bridge (`email_handoff`,
 * `tell_main`), the inbox (`email_send`, by each caller's own rules) and the
 * meetings module (the five scheduling tools). Each key brings its tools'
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
    "email_send, tell_main, free_time, hold, book, change_booking, cancel_booking: external-email's email and scheduling in its own thread, and word to main",
  default: 'off',
  instructions: [EXTERNAL_EMAIL_TOOLS_CAPABILITY],
});

/** The release template the host stamps the group from, and the plugin that stamp leaves in its folder. */
export const EXTERNAL_EMAIL_TEMPLATE = 'gws-ea/external-email';
export const EXTERNAL_EMAIL_PLUGIN = 'gws-ea-external-email';
export const EXTERNAL_EMAIL_NAME = 'external-email';

/**
 * Exactly what the group holds: its thread's tools, its reminders,
 * `request_status` for a request the host was slow to answer, the `time_*`
 * calculators, which compute over the container's clock and reveal nothing,
 * and `files-read`, for the files that reached its thread (KTD9). No write
 * tools, shell, web, subagents, MCP servers, messages to destinations, or
 * `conversation-context`: each of its sessions is sealed from every other,
 * and nothing of one thread lands in the folder its sessions share.
 */
export const EXTERNAL_EMAIL_CAPABILITIES: readonly string[] = [
  'files-read',
  'time',
  'request-status',
  REMINDERS_CAPABILITY,
  EXTERNAL_EMAIL_TOOLS_CAPABILITY,
];

/**
 * Create the group when the profile names none, and return its ID. The
 * group, its configuration, and the pointer are written in one transaction,
 * so a host stopped part-way leaves no group the pointer misses; files the
 * template stamped before such a stop stay in a folder the next attempt does
 * not reuse. Once the pointer is recorded this changes nothing.
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
    log.info('Created external-email', { agentGroupId: group.id, folder: group.folder });
    return group.id;
  });
}

/** What a drift check judges beside the stored group: the session's own provider and its gateway scope, when known. */
export interface DriftContext {
  readonly sessionProvider?: string | null;
  readonly credentialScope?: GatewayCredentialScope;
}

/**
 * Why `external-email`, as it is stored now, may not start: one clause per
 * difference from what the host stamped. Empty when there is none.
 */
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

  const scope =
    context.credentialScope ?? (await credentialScopeFor(group, { agent_provider: context.sessionProvider ?? null }));
  const gateway = gatewayDrift(scope);
  if (gateway) problems.push(gateway);
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

/**
 * Its folder holds its own template's plugin and no other, and no plugin
 * stamped a skill into the group's template-skill store.
 */
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

function gatewayDrift(scope: GatewayCredentialScope): string | undefined {
  if (scope.kind === 'all') {
    return "its gateway identity would keep the gateway's own policy, not only the model provider's secret";
  }
  if (scope.credentials.length > 0) {
    return `its gateway identity would be granted ${scope.credentials.join(', ')} beside the model provider's secret`;
  }
  if (scope.modelDomains.length === 0) return "its gateway identity would be granted no model provider's secret";
  return undefined;
}

/** The directories (and links) directly under `dir`; a missing directory holds none. */
function directoryEntries(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

/** A stored JSON column; one that does not parse is its own text, which counts as carrying something. */
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
