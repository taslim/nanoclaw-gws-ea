/** Host-stamped browser identity and the composition every job must retain. */
import fs from 'node:fs';
import path from 'node:path';

import { registerProtectedGroupPolicy } from '../../cli/guard.js';
import { registerSessionAdmissionPolicy } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { browserAvailability } from './availability.js';
import { errandSource, hasBrowserAccess } from './access.js';
import './capability.js';
import '../capabilities/index.js';

import { parseStoredCapabilities, resolveCapabilities } from '../../capabilities.js';
import { GROUPS_DIR } from '../../config.js';
import { parseSkillSelection } from '../../container-config.js';
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
import { getBrowserAgentGroupId, nameAssistantAgent, setBrowserAgentGroupId } from '../gws-ea-profile/db.js';

/** The release template the host stamps the group from, and the plugin that stamp leaves in its folder. */
export const BROWSER_TEMPLATE = 'gws-ea/browser';
export const BROWSER_PLUGIN = 'gws-ea-browser';
export const BROWSER_NAME = 'browser';
export const BROWSER_MODEL = 'claude-sonnet-5-5';

let admissionReady = false;
/** Recovery and destination projection must finish before a sealed session may wake. */
export function browserAdmissionReady(): boolean {
  return admissionReady;
}
/** Only the host browser lifecycle opens admission; a failed sweep closes it again. */
export function setBrowserAdmissionReady(ready: boolean): void {
  admissionReady = ready;
}

/** Exact capabilities; every errand has isolated provider state and no shared memory. */
export const BROWSER_CAPABILITIES: readonly string[] = [
  'browser',
  'reply',
  'files-send',
  'files-read',
  'time',
  'request-status',
];

/**
 * The group, its configuration and the profile's pointer are written in one transaction, so a host stopped
 * part-way leaves no group the pointer misses; files the template stamped before such a stop stay in a folder the
 * next attempt does not reuse. Once the profile names the assistant, the group carries that name from creation.
 */
export async function ensureBrowserGroup(): Promise<string> {
  const existing = await getBrowserAgentGroupId();
  if (existing !== null) return existing;
  return getDb().transaction(async () => {
    const { group } = await createAgentFromTemplate(BROWSER_TEMPLATE, { name: BROWSER_NAME });
    await updateContainerConfigScalars(group.id, { cli_scope: 'disabled', model: BROWSER_MODEL });
    await updateContainerConfigJson(group.id, 'capabilities', [...BROWSER_CAPABILITIES]);
    await updateContainerConfigJson(group.id, 'skills', []);
    await setBrowserAgentGroupId(group.id);
    await nameAssistantAgent(group.id);
    log.info('Created browser', { agentGroupId: group.id, folder: group.folder });
    return group.id;
  });
}

export interface DriftContext {
  readonly sessionProvider?: string | null;
}

/** Why `browser`, as stored now, may not start: one clause per difference from what the host stamped. */
export async function browserGroupDrift(agentGroupId: string, context: DriftContext = {}): Promise<string[]> {
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
  if (held.length !== BROWSER_CAPABILITIES.length || held.some((key) => !BROWSER_CAPABILITIES.includes(key))) {
    problems.push(
      `its capabilities are ${held.join(', ') || 'none'}, not exactly ${BROWSER_CAPABILITIES.join(' and ')}`,
    );
  }
  if (row.model !== BROWSER_MODEL) problems.push(`its model is ${row.model ?? 'unset'}, not ${BROWSER_MODEL}`);
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
  const others = directoryEntries(path.join(GROUPS_DIR, folder, 'plugins')).filter((name) => name !== BROWSER_PLUGIN);
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

/** A column that does not parse is its own text, which counts as carrying something. */
function storedJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    if (err instanceof SyntaxError) return raw;
    throw err;
  }
}

/** Anything but an object counts as carrying something. */
function jsonRecord(raw: string): Record<string, unknown> {
  const parsed = storedJson(raw);
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  return { [raw]: parsed };
}

/** Anything but a list counts as carrying something. */
function jsonList(raw: string): unknown[] {
  const parsed = storedJson(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

registerProtectedGroupPolicy('gws-ea-browser:host-owned', async (agentGroupId) =>
  (await getDb().hasTable('gws_ea_profile')) && agentGroupId === (await getBrowserAgentGroupId())
    ? 'browser is configured only by the host'
    : undefined,
);

registerSessionAdmissionPolicy('gws-ea-browser:stamped-reach', async ({ key }) => {
  if (!(await getDb().hasTable('gws_ea_profile')) || key.agentGroupId !== (await getBrowserAgentGroupId())) return;
  const policy = await browserAvailability();
  if (!policy.available)
    throw new Error('browser may not start: Chrome or browser state is unavailable; ask your operator');
  if (!browserAdmissionReady()) throw new Error('browser may not start: host browser recovery is unavailable');
  const session = await getSession(key.sessionId);
  if (!session || session.messaging_group_id !== null || !(await hasBrowserAccess(errandSource(session.thread_id))))
    throw new Error('browser may not start outside an errand delegated by an agent with browser access');
  const problems = await browserGroupDrift(key.agentGroupId, { sessionProvider: session?.agent_provider ?? null });
  if (problems.length > 0) throw new Error(`browser may not start: ${problems.join('; ')}`);
});
