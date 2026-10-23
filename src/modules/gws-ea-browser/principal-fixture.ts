/**
 * Test fixture: an assistant whose main agent ('main-p') serves one principal through their direct message
 * ('mg-principal'), with its browser agent ('browser-p') and another agent ('desk-p'), and the errands and notes
 * the host's purchase and incident suites read. Each suite mocks its own data root; nothing here reaches a
 * platform.
 */
import fs from 'node:fs';

import { createAgentGroup, createMessagingGroup, getDb } from '../../db/index.js';
import { resolveSession, resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { BrowserStore, type BrowserJob } from './db.js';

export const PRINCIPAL = 'gchat:users/principal';

/** Writes the browser-access setting under `root`: every agent group, or only those listed. Returns its path. */
export function writeBrowserPolicy(root: string, agentGroupIds?: readonly string[]): string {
  const file = `${root}/browser/policy.json`;
  fs.mkdirSync(`${root}/browser`, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      agentGroupIds ? { schemaVersion: 2, enabled: true, agentGroupIds } : { schemaVersion: 1, enabled: true },
    ),
    { mode: 0o600 },
  );
  return file;
}

/** The principal's user and direct message, which nothing reaches until `principalReachable`. */
export async function seedPrincipal(): Promise<void> {
  const now = new Date().toISOString();
  await createMessagingGroup({
    id: 'mg-principal',
    channel_type: 'gchat',
    platform_id: 'spaces/principal',
    name: 'principal',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: now });
}

/** The principal's direct message, through which the host's cards and main's notes reach them. */
export async function principalReachable(): Promise<void> {
  await upsertUserDm({
    user_id: PRINCIPAL,
    channel_type: 'gchat',
    messaging_group_id: 'mg-principal',
    resolved_at: new Date().toISOString(),
  });
  await bindVerifiedPrincipalUser(PRINCIPAL, new Date().toISOString());
}

/**
 * main, the browser agent and another agent, the profile naming main and the browser agent, and the principal,
 * whom nothing reaches yet. Resolves to main's conversation with the principal.
 */
export async function seedAssistant(): Promise<Session> {
  for (const id of ['main-p', 'browser-p', 'desk-p'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await seedPrincipal();
  await reconcileGwsEaProfile({
    assistantName: { firstName: 'Aya', lastName: null },
    assistantWorkspaceEmail: 'aya@example.test',
    principalName: { firstName: 'Morgan', lastName: null },
    principalTimezone: 'America/Los_Angeles',
    mainAgentGroupId: 'main-p',
    principalEmails: ['morgan@example.test'],
  });
  await getDb().run(`UPDATE gws_ea_profile SET browser_agent_group_id = ? WHERE singleton = 1`, 'browser-p');
  return (await resolveSession('main-p', 'mg-principal', null, 'agent-shared')).session;
}

/** A live errand that `source` opened, with its lazily created job. */
export async function errand(source: string, name: string): Promise<{ session: Session; job: BrowserJob }> {
  const session = (await resolveSystemSession('browser-p', `system:a2a:${source}:${name}`)).session;
  const job = await new BrowserStore().jobForSession(session);
  if (!job) throw new Error('The errand was not admitted');
  return { session, job };
}

/** The text of each message the host wrote into a session, oldest first. */
export async function notes(session: Session): Promise<string[]> {
  return (
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox
        .getInboundHistory(100)
        .map((message) => (JSON.parse(message.content) as { text?: string }).text ?? '')
        .reverse(),
    )) ?? []
  );
}
