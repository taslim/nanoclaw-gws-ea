/**
 * GWS-EA's definition of `main` (KTD12, KTD13): how a GWS-EA assistant
 * works, as a required project-doc section only `main` receives, and the
 * NanoClaw shared skills `main` loads. Both ship with the release, and
 * neither lives in a file the agent can edit, so the principal's own
 * standing instructions (the persona file) never collide with a product
 * update.
 */
import path from 'node:path';

import { register } from '../../cli/registry.js';
import { parseSkillSelection } from '../../container-config.js';
import { getDb } from '../../db/connection.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { EXPOSED_GOOGLE_SKILLS } from '../gws-ea-google/grant.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { registerGuidance } from '../gws-ea-profile/guidance.js';

/** The guidance, relative to the checkout the host runs from, as NanoClaw reads its other instruction files. */
export const GUIDANCE_PATH = path.join('src', 'modules', 'gws-ea-main', 'guidance.md');

/**
 * The shared skills (`container/skills/`) `main` loads: web research and the
 * skill of every Google capability (`gws-ea-google`). Main's capabilities
 * bound the list, so it is handed a Google skill only while it holds that
 * service's key. NanoClaw adds the gateway's own skill, and the template
 * supplies `welcome`.
 */
export const MAIN_SHARED_SKILLS: readonly string[] = ['agent-browser', ...EXPOSED_GOOGLE_SKILLS];

async function mainAgentGroupId(): Promise<string | null> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return null;
  return getMainAgentGroupId();
}

registerGuidance('gws-ea-main:guidance', {
  agent: 'main',
  heading: 'Executive Assistant',
  file: GUIDANCE_PATH,
  agentGroupId: mainAgentGroupId,
});

interface MainSkills {
  readonly agent_group_id: string;
  readonly skills: string[] | 'all';
}

/** Set a group's shared skills to `main`'s, writing only when they differ. */
async function reconcileMainSkills(agentGroupId: string): Promise<MainSkills> {
  const row = await getContainerConfig(agentGroupId);
  if (!row) throw new Error(`No container config for group: ${agentGroupId}`);
  const current = parseSkillSelection(row.skills, agentGroupId);
  const wanted = [...MAIN_SHARED_SKILLS];
  if (current === 'all' || current.length !== wanted.length || current.some((skill, i) => skill !== wanted[i])) {
    await updateContainerConfigJson(agentGroupId, 'skills', wanted);
  }
  const updated = await getContainerConfig(agentGroupId);
  return { agent_group_id: agentGroupId, skills: parseSkillSelection(updated?.skills, agentGroupId) };
}

// The lifecycle commands (create, update) set the list through this command;
// the host never rewrites it at start.
register({
  name: 'gws-ea-main-reconcile',
  description: "Set canonical main's NanoClaw shared skills to the release's list.",
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const unknown = Object.keys(raw).filter((key) => key !== 'agent-group-id');
    if (unknown.length > 0) throw new Error(`Unknown main field: --${unknown[0]}`);
    const agentGroupId = raw['agent-group-id'];
    if (typeof agentGroupId !== 'string' || agentGroupId.length === 0) throw new Error('--agent-group-id is required');
    return agentGroupId;
  },
  handler: async (agentGroupId) => reconcileMainSkills(agentGroupId),
});
