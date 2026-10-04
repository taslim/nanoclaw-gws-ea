/**
 * GWS-EA's `external-email` agent (KTD3, KTD5, KTD14): the part of the
 * assistant that writes every email to someone other than the principal.
 *
 *   - The host creates its agent group once, at start, from the release's
 *     template, and records it in the profile beside main (`./group.ts`).
 *   - It cannot drift into more reach. It is a protected group: every agent
 *     caller's `ncl` command that names it is denied, `main` included and
 *     whatever an admin approves, and so is any self-modification request
 *     from it. Before any session of it starts or is adopted, a session
 *     admission policy refuses one whose capabilities, configuration,
 *     stamped plugins, provider, or gateway scope differ from what the host
 *     stamped.
 *   - A destination admission policy keeps it apart from main and from every
 *     other group (`./destination-policy.ts`).
 *   - Its project document holds its guidance, read from the release, and the
 *     two display names: the profile and preferences sections leave it
 *     everything else out.
 *   - Status reads all of this through a hidden host-only command.
 */
import fs from 'node:fs';
import path from 'node:path';

// Their migrations add the columns this module writes: each group's
// capabilities, and the profile's pointer to this group.
import '../capabilities/index.js';
import '../gws-ea-profile/index.js';

import { registerCapability } from '../../capabilities.js';
import { registerProtectedGroupPolicy } from '../../cli/guard.js';
import { register } from '../../cli/registry.js';
import { registerSessionAdmissionPolicy } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import type { AgentGroup } from '../../types.js';
import { getExternalEmailAgentGroupId as readExternalEmailPointer } from '../gws-ea-profile/db.js';
import { destinationViolations } from './destination-policy.js';
import { EXTERNAL_EMAIL_MEETINGS_CAPABILITY, ensureExternalEmailGroup, externalEmailDrift } from './group.js';

export {
  EXTERNAL_EMAIL_CAPABILITIES,
  EXTERNAL_EMAIL_MEETINGS_CAPABILITY,
  EXTERNAL_EMAIL_NAME,
  EXTERNAL_EMAIL_PLUGIN,
  EXTERNAL_EMAIL_TEMPLATE,
} from './group.js';

registerCapability(EXTERNAL_EMAIL_MEETINGS_CAPABILITY, {
  description:
    "meeting_free_time, meeting_hold, meeting_book, meeting_ask_main, email_recipients, meeting_outcome: external-email's meeting tools: the principal's free time, holds, and bookings through the host, a question for main it then waits on, who its replies go to among the people on its thread, and the meeting's outcome",
  default: 'off',
  instructions: [EXTERNAL_EMAIL_MEETINGS_CAPABILITY],
});

/** `external-email`'s agent group, as the profile records it, or null until the host creates it. */
export async function getExternalEmailAgentGroupId(): Promise<string | null> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return null;
  return readExternalEmailPointer();
}

// Runs before any module whose start needs the group, such as the inbox's
// wiring to it: start callbacks run in module import order.
onHostStart(async () => {
  if (!(await getDb().hasTable('gws_ea_profile'))) return;
  await ensureExternalEmailGroup();
});

registerProtectedGroupPolicy('gws-ea-external-email:host-owned', async (agentGroupId) =>
  agentGroupId === (await getExternalEmailAgentGroupId()) ? 'external-email is configured only by the host' : undefined,
);

registerSessionAdmissionPolicy('gws-ea-external-email:stamped-reach', async ({ key, credentialScope }) => {
  const agentGroupId = await getExternalEmailAgentGroupId();
  if (agentGroupId === null || key.agentGroupId !== agentGroupId) return;
  const session = await getSession(key.sessionId);
  const problems = await externalEmailDrift(agentGroupId, {
    sessionProvider: session?.agent_provider ?? null,
    credentialScope,
  });
  if (problems.length > 0) throw new Error(`external-email may not start: ${problems.join('; ')}`);
});

/** The guidance, relative to the checkout the host runs from, as NanoClaw reads its other instruction files. */
export const GUIDANCE_PATH = path.join('src', 'modules', 'gws-ea-external-email', 'guidance.md');

async function guidanceSection(group: AgentGroup): Promise<{ name: string; body: string } | undefined> {
  if (group.id !== (await getExternalEmailAgentGroupId())) return undefined;
  const file = path.resolve(process.cwd(), GUIDANCE_PATH);
  if (!fs.existsSync(file)) {
    // Tolerated but never silent, like main's guidance: throwing here would
    // fail every spawn. The release preflight refuses a release without it.
    log.error('external-email guidance is missing; it starts without it', { file });
    return undefined;
  }
  const body = fs.readFileSync(file, 'utf8');
  if (!body.trim()) {
    log.error('external-email guidance is empty; it starts without it', { file });
    return undefined;
  }
  return { name: 'External Email', body };
}

registerRequiredProjectDocSection('gws-ea-external-email:guidance', guidanceSection);

export interface ExternalEmailHealth {
  /** The group the profile records, or null when the host has not created it. */
  readonly agent_group_id: string | null;
  /** Each reason it may not start, and each destination that breaks its separation; empty when healthy. */
  readonly problems: readonly string[];
}

/** What status reports: whether external-email is as the host stamped it, and the stored destinations around it. */
export async function externalEmailHealth(): Promise<ExternalEmailHealth> {
  const agentGroupId = await getExternalEmailAgentGroupId();
  const destinations = await destinationViolations();
  if (agentGroupId === null) {
    return {
      agent_group_id: null,
      problems: ['external-email has not been created; the host creates it when it starts', ...destinations],
    };
  }
  return { agent_group_id: agentGroupId, problems: [...(await externalEmailDrift(agentGroupId)), ...destinations] };
}

register({
  name: 'gws-ea-external-email-health',
  description:
    'Report whether external-email is as the host stamped it, and any destination that breaks its separation.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const unknown = Object.keys(raw);
    if (unknown.length > 0) throw new Error(`Unknown external-email field: --${unknown[0]}`);
    return undefined;
  },
  handler: async () => externalEmailHealth(),
});
