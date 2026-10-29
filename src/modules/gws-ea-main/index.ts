/**
 * GWS-EA's definition of `main`: how a GWS-EA assistant works, as a required
 * project-doc section only `main` receives, and the shared skills `main`
 * loads. Both ship with the release, and neither lives in a file the agent can
 * edit, so the principal's own standing instructions (the persona file) never
 * collide with a product update.
 */
import path from 'node:path';

import {
  parseStoredCapabilities,
  registerCapability,
  resolveCapabilities,
  SHELL_CAPABILITY,
  withholdCapabilityInstructions,
  type CapabilitySelection,
} from '../../capabilities.js';
import { register } from '../../cli/registry.js';
import { parseSkillSelection } from '../../container-config.js';
import { registerContainerEnv } from '../../container-env.js';
import { getDb } from '../../db/connection.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { EXPOSED_GOOGLE_SKILLS } from '../gws-ea-google/grant.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { registerGuidance } from '../gws-ea-profile/guidance.js';

/** Relative to the checkout the host runs from, as NanoClaw reads its other instruction files. */
export const GUIDANCE_PATH = path.join('src', 'modules', 'gws-ea-main', 'guidance.md');

export const MAIN_CHAT_CAPABILITY = 'gws-ea-chat';
export const MAIN_CONTEXT_CAPABILITY = 'gws-ea-main-context';
registerCapability(MAIN_CONTEXT_CAPABILITY, {
  description: 'live coming-days context and planning runtime for canonical main',
  default: 'off',
  grantedTo: async (agentGroupId) => agentGroupId === (await mainAgentGroupId()),
});
registerContainerEnv(
  'gws-ea-main:planning',
  ({ capabilities }): Record<string, string> =>
    capabilities.has(MAIN_CONTEXT_CAPABILITY) ? { GWS_EA_PLANNING_AGENTS: '1' } : {},
);
registerCapability(MAIN_CHAT_CAPABILITY, {
  description: 'whatsapp_link and chat-addressed host actions for canonical main',
  default: 'off',
  instructions: [MAIN_CHAT_CAPABILITY, 'gws-ea-chat-outreach'],
  // Canonical main's alone: a group that stores `all` must not learn main's chat commands.
  grantedTo: async (agentGroupId) => agentGroupId === (await mainAgentGroupId()),
});

/**
 * Main's capabilities bound the list: it receives each skill only while it
 * holds that skill's capability. The template supplies `welcome`, and
 * `gws-ea-google` withholds the gateway's own skill from every agent.
 */
export const MAIN_SHARED_SKILLS: readonly string[] = [
  'agent-browser',
  ...EXPOSED_GOOGLE_SKILLS,
  'whatsapp-formatting',
  'artifact-designer',
  'days-and-weeks',
  'travel',
  'errands',
  'meetings',
];

async function mainAgentGroupId(): Promise<string | null> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return null;
  return getMainAgentGroupId();
}

// Main keeps the shell's tools; its own guidance teaches the commands it uses.
withholdCapabilityInstructions(SHELL_CAPABILITY, async (agentGroupId) => agentGroupId === (await mainAgentGroupId()));

export function mainCapabilitySelection(): string[] {
  return resolveCapabilities('all', 'main').filter((key) => key !== 'agents' && key !== 'self-mod');
}

registerGuidance('gws-ea-main:guidance', {
  agent: 'main',
  heading: 'Executive Assistant',
  file: GUIDANCE_PATH,
  agentGroupId: mainAgentGroupId,
});

interface MainConfiguration {
  readonly agent_group_id: string;
  readonly skills: string[] | 'all';
  readonly capabilities: CapabilitySelection;
}

async function reconcileMainConfiguration(agentGroupId: string): Promise<MainConfiguration> {
  const row = await getContainerConfig(agentGroupId);
  if (!row) throw new Error(`No container config for group: ${agentGroupId}`);
  const current = parseSkillSelection(row.skills, agentGroupId);
  const wanted = [...MAIN_SHARED_SKILLS];
  if (current === 'all' || current.length !== wanted.length || current.some((skill, i) => skill !== wanted[i])) {
    await updateContainerConfigJson(agentGroupId, 'skills', wanted);
  }
  const currentCapabilities = parseStoredCapabilities(row.capabilities, agentGroupId);
  const capabilities = mainCapabilitySelection();
  if (
    currentCapabilities === 'all' ||
    currentCapabilities.length !== capabilities.length ||
    currentCapabilities.some((key, i) => key !== capabilities[i])
  ) {
    await updateContainerConfigJson(agentGroupId, 'capabilities', capabilities);
  }
  const updated = await getContainerConfig(agentGroupId);
  return {
    agent_group_id: agentGroupId,
    skills: parseSkillSelection(updated?.skills, agentGroupId),
    capabilities: parseStoredCapabilities(updated?.capabilities, agentGroupId),
  };
}

register({
  name: 'gws-ea-main-reconcile',
  description: "Set canonical main's NanoClaw shared skills and capabilities to the release's selection.",
  access: 'hidden',
  hostOnly: true,
  // Dispatch hands over canonical keys (src/cli/args.ts): `--agent-group-id` arrives as `agent_group_id`.
  parseArgs(raw) {
    const unknown = Object.keys(raw).filter((key) => key !== 'agent_group_id');
    if (unknown.length > 0) throw new Error(`Unknown main field: --${unknown[0].replace(/_/g, '-')}`);
    const agentGroupId = raw.agent_group_id;
    if (typeof agentGroupId !== 'string' || agentGroupId.length === 0) throw new Error('--agent-group-id is required');
    return agentGroupId;
  },
  handler: async (agentGroupId) => reconcileMainConfiguration(agentGroupId),
});
