import fs from 'node:fs';
import path from 'node:path';
import { getGroupCapabilities, parseStoredCapabilities } from '../../capabilities.js';
import { GROUPS_DIR } from '../../config.js';
import { parseSkillSelection } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getProviderHostContract } from '../../provider-contracts/index.js';
import { resolveProviderName } from '../../providers/provider-name.js';
import { groupSkillsOverlayDir } from '../../templates/create-agent.js';
import { hasBrowserAccess } from '../gws-ea-browser/access.js';
import { chatGatewayDrift } from './gateway.js';
import {
  CHAT_SHARED_SKILLS,
  EXTERNAL_CHAT_CAPABILITIES,
  EXTERNAL_CHAT_PLUGIN,
  JOB_CHAT_CAPABILITIES,
  JOB_CHAT_PLUGIN,
} from './shape.js';

function sameKeys(held: readonly string[], wanted: readonly string[]): boolean {
  return (
    held.length === wanted.length && new Set(held).size === held.length && held.every((key) => wanted.includes(key))
  );
}

function carries(raw: string, empty: 'array' | 'object'): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return empty === 'array'
      ? !Array.isArray(value) || value.length !== 0
      : typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 0;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return true;
  }
}

function directories(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

/** Both stored shape and effective policy grants constrain a chat container. */
export async function chatAgentDrift(
  groupId: string,
  kind: 'external-chat' | 'job',
  sessionProvider?: string | null,
): Promise<string[]> {
  const group = await getAgentGroup(groupId);
  const config = await getContainerConfig(groupId);
  if (!group || !config) return ['its agent group or container configuration is missing'];
  const baseline = kind === 'external-chat' ? EXTERNAL_CHAT_CAPABILITIES : JOB_CHAT_CAPABILITIES;
  const problems: string[] = [];
  const stored = parseStoredCapabilities(config.capabilities, group.name);
  const granted = kind === 'job' && stored !== 'all' && stored.includes('browser-delegate');
  const storedBaseline = [...baseline, ...(granted ? ['browser-delegate'] : [])];
  if (stored === 'all' || !sameKeys(stored, storedBaseline))
    problems.push('its stored capabilities differ from the release');
  const expected = [
    ...baseline,
    ...(kind === 'job' && (await hasBrowserAccess(groupId)) ? ['browser-delegate', 'browser-purchase-outcome'] : []),
  ];
  if (!sameKeys([...(await getGroupCapabilities(groupId))], expected))
    problems.push('its effective capabilities differ from its authorized grants');
  if (config.cli_scope !== 'disabled') problems.push('its CLI is not disabled');
  if (carries(config.mcp_servers, 'object')) problems.push('it carries MCP servers');
  if (carries(config.packages_apt, 'array') || carries(config.packages_npm, 'array'))
    problems.push('it carries extra packages');
  if (carries(config.additional_mounts, 'array')) problems.push('it carries extra mounts');
  const skills = parseSkillSelection(config.skills, group.name);
  if (skills === 'all' || !sameKeys(skills, CHAT_SHARED_SKILLS)) problems.push('it carries unapproved shared skills');
  const plugin = kind === 'external-chat' ? EXTERNAL_CHAT_PLUGIN : JOB_CHAT_PLUGIN;
  if (directories(path.join(GROUPS_DIR, group.folder, 'plugins')).some((name) => name !== plugin))
    problems.push('it carries another stamped plugin');
  if (directories(groupSkillsOverlayDir(groupId)).length > 0) problems.push('its stamped plugins carry skills');
  if (kind === 'external-chat') {
    const provider = resolveProviderName(sessionProvider, config.provider);
    const contract = getProviderHostContract(provider);
    if (
      !contract ||
      contract.stateVolumes.some((volume) => volume.scope === 'group' && volume.sealedScope !== 'session')
    )
      problems.push(`its provider ${provider} does not isolate session state`);
  }
  problems.push(...(await chatGatewayDrift(groupId)));
  return problems;
}
