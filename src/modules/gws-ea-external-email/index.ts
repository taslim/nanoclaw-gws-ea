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
 *     stamped plugins, or provider differ from what the host stamped.
 *   - A destination admission policy keeps it apart from main and from every
 *     other group (`./destination-policy.ts`). The two work together only
 *     through the host: main's `email_handoff` and its own `tell_main`
 *     (`./bridge.ts`).
 *   - When an email it wrote cannot be sent, what arrived in its thread cannot
 *     be processed, or its work on a thread fails, main hears of it
 *     (`./failures.ts`).
 *   - Its project document holds its guidance, read from the release, the
 *     two display names, and the principal's time zone, read from the profile
 *     at each spawn so that no email it reads repeats them; the profile and
 *     preferences sections leave it everything else out.
 *   - Status reads all of this through a hidden host-only command.
 */
import path from 'node:path';

// Their migrations add the columns this module writes: each group's
// capabilities, and the profile's pointer to this group.
import '../capabilities/index.js';
import '../gws-ea-profile/index.js';

import { registerProtectedGroupPolicy } from '../../cli/guard.js';
import { register } from '../../cli/registry.js';
import { TIMEZONE } from '../../config.js';
import { registerSessionAdmissionPolicy } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { registerDeliveryAction } from '../../delivery.js';
import { onHostStart } from '../../host-lifecycle.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import { resolveTimezone } from '../../timezone.js';
import { getGwsEaProfile, getExternalEmailAgentGroupId as readExternalEmailPointer } from '../gws-ea-profile/db.js';
import { registerGuidance } from '../gws-ea-profile/guidance.js';
import { BRIDGE_ACTIONS } from './bridge.js';
import { destinationViolations } from './destination-policy.js';
import { ensureExternalEmailGroup, externalEmailDrift } from './group.js';
import './failures.js';

export {
  EXTERNAL_EMAIL_CAPABILITIES,
  EXTERNAL_EMAIL_NAME,
  EXTERNAL_EMAIL_PLUGIN,
  EXTERNAL_EMAIL_TEMPLATE,
} from './group.js';

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

for (const [action, handler, guard] of BRIDGE_ACTIONS) registerDeliveryAction(action, handler, guard);

registerProtectedGroupPolicy('gws-ea-external-email:host-owned', async (agentGroupId) =>
  agentGroupId === (await getExternalEmailAgentGroupId()) ? 'external-email is configured only by the host' : undefined,
);

registerSessionAdmissionPolicy('gws-ea-external-email:stamped-reach', async ({ key }) => {
  const agentGroupId = await getExternalEmailAgentGroupId();
  if (agentGroupId === null || key.agentGroupId !== agentGroupId) return;
  const session = await getSession(key.sessionId);
  const problems = await externalEmailDrift(agentGroupId, { sessionProvider: session?.agent_provider ?? null });
  if (problems.length > 0) throw new Error(`external-email may not start: ${problems.join('; ')}`);
});

// Whom it works for, once, rather than on every email it reads: the
// principal's name and time zone, never their addresses.
registerRequiredProjectDocSection('gws-ea-external-email:principal', async (group) => {
  if (group.id !== (await getExternalEmailAgentGroupId())) return undefined;
  const profile = await getGwsEaProfile();
  const timezone = resolveTimezone(profile.principal_timezone ?? TIMEZONE);
  return {
    name: 'Principal',
    body: `You work for ${profile.principal_display_name ?? 'the principal'}, whose time zone is ${timezone}.`,
  };
});

/** The guidance, relative to the checkout the host runs from, as NanoClaw reads its other instruction files. */
export const GUIDANCE_PATH = path.join('src', 'modules', 'gws-ea-external-email', 'guidance.md');

registerGuidance('gws-ea-external-email:guidance', {
  agent: 'external-email',
  heading: 'External Email',
  file: GUIDANCE_PATH,
  agentGroupId: readExternalEmailPointer,
});

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
