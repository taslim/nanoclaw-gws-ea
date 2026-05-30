/**
 * Init the Email channel — wire principal email to `main`, external email
 * to its own agent group, and register a `principal` destination on
 * email-external pointing at the owner's DM so that group can surface
 * heads-ups to the principal directly (rather than emitting plain text on
 * the inbound thread, which would land in the third party's inbox).
 *
 * Idempotent. Looks up the existing `main` agent group (created by
 * /init-first-agent at migrate-time) and wires `email:principal:<addr>` to it
 * with sender_scope='known'. Creates `email-external` agent group + wires
 * `email:external:<addr>` to it with sender_scope='all' — kept separate
 * for filesystem isolation from main's principal-private state. Seeds each
 * principal email address as a member of `main` so v2 recognizes the
 * principal as `known` across all their addresses.
 *
 * Usage: pnpm exec tsx scripts/init-email.ts
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  findUniqueDmOnAgentGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { readEnvFile } from '../src/env.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { log } from '../src/log.js';
import {
  createDestination,
  getDestinationByName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { getUser, upsertUser } from '../src/modules/permissions/db/users.js';
import type { AgentGroup, SenderScope } from '../src/types.js';

const MAIN_FOLDER = 'main';
const EXTERNAL_FOLDER = 'email-external';
const PRINCIPAL_DEST = 'principal';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const env = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_EMAIL', 'PRINCIPAL_EMAILS', 'PRINCIPAL_NAME']);
  if (!env.ASSISTANT_NAME || !env.ASSISTANT_EMAIL || !env.PRINCIPAL_EMAILS || !env.PRINCIPAL_NAME) {
    throw new Error('ASSISTANT_NAME, ASSISTANT_EMAIL, PRINCIPAL_EMAILS, and PRINCIPAL_NAME must be set in .env');
  }
  const principalEmails = env.PRINCIPAL_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (principalEmails.length === 0) throw new Error('PRINCIPAL_EMAILS must contain at least one address');

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();
  const assistantLower = env.ASSISTANT_EMAIL.toLowerCase();

  const mainAg = getAgentGroupByFolder(MAIN_FOLDER);
  if (!mainAg) {
    throw new Error(
      `Agent group "${MAIN_FOLDER}" not found. Run /init-first-agent (gchat) before init-email so the trusted EA group exists.`,
    );
  }
  initGroupFilesystem(mainAg);

  const externalAg = ensureExternalAgentGroup(env.ASSISTANT_NAME, now);

  const principalPlatformId = `email:principal:${assistantLower}`;
  const externalPlatformId = `email:external:${assistantLower}`;

  ensureMessagingGroup(principalPlatformId, 'Email (Principal)', 'strict', now);
  ensureMessagingGroup(externalPlatformId, 'Email (External)', 'public', now);

  ensureWiring(principalPlatformId, mainAg.id, 'known', now);
  ensureWiring(externalPlatformId, externalAg.id, 'all', now);

  const ownerDm = findUniqueDmOnAgentGroup(mainAg.id, 'gchat');
  if (!ownerDm) {
    throw new Error(
      `Could not find a unique GChat DM wired to "${MAIN_FOLDER}". Run /init-first-agent (gchat) before init-email.`,
    );
  }
  ensurePrincipalDestination(externalAg.id, ownerDm.id, now);

  for (const addr of principalEmails) {
    const userId = `email:${addr}`;
    if (!getUser(userId)) {
      upsertUser({ id: userId, kind: 'email', display_name: env.PRINCIPAL_NAME, created_at: now });
    }
    try {
      addMember({ user_id: userId, agent_group_id: mainAg.id, added_by: null, added_at: now });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    }
  }

  console.log('');
  console.log('Email init complete.');
  console.log(`  main (principal): ${mainAg.id} @ groups/${MAIN_FOLDER}  (${principalPlatformId})`);
  console.log(`  email-external:   ${externalAg.id} @ groups/${EXTERNAL_FOLDER}  (${externalPlatformId})`);
  console.log(`  principal users:  ${principalEmails.map((a) => `email:${a}`).join(', ')}`);
}

function ensureExternalAgentGroup(assistantName: string, now: string): AgentGroup {
  const existing = getAgentGroupByFolder(EXTERNAL_FOLDER);
  if (existing) {
    initGroupFilesystem(existing);
    return existing;
  }
  const id = generateId('ag');
  const ag: AgentGroup = { id, name: assistantName, folder: EXTERNAL_FOLDER, agent_provider: null, created_at: now };
  createAgentGroup(ag);
  initGroupFilesystem(ag);
  log.info('Created agent group', { id, folder: EXTERNAL_FOLDER });
  return ag;
}

function ensureMessagingGroup(
  platformId: string,
  name: string,
  policy: 'strict' | 'public',
  now: string,
): void {
  if (getMessagingGroupByPlatform('email', platformId)) return;
  createMessagingGroup({
    id: generateId('mg'),
    channel_type: 'email',
    platform_id: platformId,
    name,
    is_group: 0,
    unknown_sender_policy: policy,
    created_at: now,
  });
  log.info('Created messaging group', { platformId, policy });
}

function ensurePrincipalDestination(agentGroupId: string, ownerDmMgId: string, now: string): void {
  if (getDestinationByName(agentGroupId, PRINCIPAL_DEST)) return;
  createDestination({
    agent_group_id: agentGroupId,
    local_name: PRINCIPAL_DEST,
    target_type: 'channel',
    target_id: ownerDmMgId,
    created_at: now,
  });
  log.info(`Registered destination "${PRINCIPAL_DEST}" → ${ownerDmMgId}`, { agentGroupId });
}

function ensureWiring(platformId: string, agentGroupId: string, senderScope: SenderScope, now: string): void {
  const mg = getMessagingGroupByPlatform('email', platformId);
  if (!mg) return;
  if (getMessagingGroupAgentByPair(mg.id, agentGroupId)) return;
  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: senderScope,
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now,
  });
  log.info('Wired email mg → agent group', { platformId, agentGroupId, senderScope });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
