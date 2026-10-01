/**
 * GWS-EA's definition of `main` (KTD12, KTD13): how a GWS-EA assistant
 * works, as a required project-doc section only `main` receives, and the
 * NanoClaw shared skills `main` loads. Both ship with the release, and
 * neither lives in a file the agent can edit, so the principal's own
 * standing instructions (the persona file) never collide with a product
 * update.
 */
import fs from 'node:fs';
import path from 'node:path';

import { register } from '../../cli/registry.js';
import { parseSkillSelection } from '../../container-config.js';
import { getDb } from '../../db/connection.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import type { AgentGroup } from '../../types.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';

/** The guidance, relative to the checkout the host runs from, as NanoClaw reads its other instruction files. */
export const GUIDANCE_PATH = path.join('src', 'modules', 'gws-ea-main', 'guidance.md');

/**
 * The shared skills (`container/skills/`) `main` loads: web research and the
 * Google tool's rules and commands. NanoClaw adds the gateway's own skill, and
 * the template supplies `welcome`.
 */
export const MAIN_SHARED_SKILLS: readonly string[] = ['agent-browser', 'google-workspace'];

async function mainAgentGroupId(): Promise<string | null> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return null;
  return (await getGwsEaProfile()).main_agent_group_id;
}

async function guidanceSection(group: AgentGroup): Promise<{ name: string; body: string } | undefined> {
  if (group.id !== (await mainAgentGroupId())) return undefined;
  const file = path.resolve(process.cwd(), GUIDANCE_PATH);
  if (!fs.existsSync(file)) {
    // Tolerated but never silent, like a missing base document
    // (src/project-doc-compose.ts): throwing here would fail every spawn.
    // The release preflight refuses a release without this file.
    log.error('GWS-EA guidance is missing; main starts without it', { file });
    return undefined;
  }
  const body = fs.readFileSync(file, 'utf8');
  if (!body.trim()) {
    log.error('GWS-EA guidance is empty; main starts without it', { file });
    return undefined;
  }
  return { name: 'Executive Assistant', body };
}

registerRequiredProjectDocSection('gws-ea-main:guidance', guidanceSection);

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

// A release can change main's list, so every start applies the running
// release's list to the main an earlier release created.
onHostStart(async () => {
  const main = await mainAgentGroupId();
  if (main === null) return;
  if (!(await getContainerConfig(main))) {
    log.warn('Canonical main has no container config; its skills were not reconciled', { agentGroupId: main });
    return;
  }
  const { skills } = await reconcileMainSkills(main);
  log.info("Reconciled canonical main's skills", { agentGroupId: main, skills });
});
