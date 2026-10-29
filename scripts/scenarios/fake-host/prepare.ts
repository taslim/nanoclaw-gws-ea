import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SYNTHETIC_IDENTITY, readState } from './state.js';
import type { ScenarioComposition } from '../types.js';

// Import only after cwd points at this run's new synthetic install. Host constants
// resolve from cwd; importing before this would touch the operator's install.
const [tree, output, audience] = process.argv.slice(2);
if (!tree || !output || !['main', 'external-email', 'external-chat'].includes(audience ?? ''))
  throw new Error('prepare <tree> <output> <main|external-email|external-chat>');
const host = path.join(output, 'host');
fs.mkdirSync(host, { recursive: true });
for (const name of ['src', 'container', 'templates']) fs.symlinkSync(path.join(tree, name), path.join(host, name));
process.chdir(host);
process.env.LOG_LEVEL = 'warn';
process.env.NANOCLAW_TEMPLATES_DIR = path.join(tree, 'templates');
process.env.ASSISTANT_NAME = SYNTHETIC_IDENTITY.assistantName.firstName;
const source = (file: string): string => pathToFileURL(path.join(tree, file)).href;
const { installSyntheticGoogle, serveNativeHost } = await import('./native.js');
const google = await installSyntheticGoogle(output);
await import(source('src/modules/index.ts'));
await import(source('src/cli/commands/index.ts'));
const { initTestDb, closeDb } = (await import(
  source('src/db/connection.ts')
)) as typeof import('../../../src/db/connection.js');
const { createAgentFromTemplate } = (await import(
  source('src/templates/create-agent.ts')
)) as typeof import('../../../src/templates/create-agent.js');
const { reconcileGwsEaProfile } = (await import(
  source('src/modules/gws-ea-profile/db.ts')
)) as typeof import('../../../src/modules/gws-ea-profile/db.js');
const { ensureExternalEmailGroup } = (await import(
  source('src/modules/gws-ea-external-email/group.ts')
)) as typeof import('../../../src/modules/gws-ea-external-email/group.js');
const { composeGroupProjectDoc } = (await import(
  source('src/project-doc-compose.ts')
)) as typeof import('../../../src/project-doc-compose.js');
const { getAgentGroup } = (await import(
  source('src/db/agent-groups.ts')
)) as typeof import('../../../src/db/agent-groups.js');
const { updateContainerConfigJson, updateContainerConfigScalars, getContainerConfig } = (await import(
  source('src/db/container-configs.ts')
)) as typeof import('../../../src/db/container-configs.js');
const { mainCapabilitySelection, MAIN_SHARED_SKILLS } = (await import(
  source('src/modules/gws-ea-main/index.ts')
)) as typeof import('../../../src/modules/gws-ea-main/index.js');
const db = await initTestDb();
const { runMigrations } = (await import(
  source('src/db/migrations/index.ts')
)) as typeof import('../../../src/db/migrations/index.js');
await runMigrations(db);
try {
  const { group: main } = await createAgentFromTemplate('gws-ea/main', { name: 'main', provider: 'claude' });
  await reconcileGwsEaProfile({
    assistantName: SYNTHETIC_IDENTITY.assistantName,
    assistantWorkspaceEmail: SYNTHETIC_IDENTITY.assistantEmail,
    principalName: SYNTHETIC_IDENTITY.principalName,
    principalTimezone: 'America/Los_Angeles',
    mainAgentGroupId: main.id,
    principalEmails: [SYNTHETIC_IDENTITY.principalEmail],
  });
  await updateContainerConfigJson(main.id, 'capabilities', mainCapabilitySelection());
  await updateContainerConfigJson(main.id, 'skills', MAIN_SHARED_SKILLS);
  await updateContainerConfigScalars(main.id, { cli_scope: 'global' });
  const outward = await ensureExternalEmailGroup();
  const { ensureExternalChatGroup } = (await import(
    source('src/modules/gws-ea-chat-agents/external-chat.ts')
  )) as typeof import('../../../src/modules/gws-ea-chat-agents/external-chat.js');
  const group =
    audience === 'main'
      ? main
      : await getAgentGroup(audience === 'external-chat' ? await ensureExternalChatGroup() : outward);
  if (!group) throw new Error('Synthetic group was not created.');
  const { createMessagingGroup } = (await import(
    source('src/db/messaging-groups.ts')
  )) as typeof import('../../../src/db/messaging-groups.js');
  const { upsertUser } = (await import(
    source('src/modules/permissions/db/users.ts')
  )) as typeof import('../../../src/modules/permissions/db/users.js');
  const { upsertUserDm } = (await import(
    source('src/modules/permissions/db/user-dms.ts')
  )) as typeof import('../../../src/modules/permissions/db/user-dms.js');
  const { bindVerifiedPrincipalUser } = (await import(
    source('src/modules/gws-ea-profile/db.ts')
  )) as typeof import('../../../src/modules/gws-ea-profile/db.js');
  const { resolveSession } = (await import(
    source('src/session-manager.ts')
  )) as typeof import('../../../src/session-manager.js');
  const now = new Date().toISOString();
  await createMessagingGroup({
    id: 'synthetic-morgan-dm',
    channel_type: 'gchat',
    platform_id: 'synthetic-morgan-dm',
    name: 'Morgan Ellery',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await upsertUser({ id: 'gchat:synthetic-morgan', kind: 'gchat', display_name: 'Morgan Ellery', created_at: now });
  await bindVerifiedPrincipalUser('gchat:synthetic-morgan', now);
  await upsertUserDm({
    user_id: 'gchat:synthetic-morgan',
    channel_type: 'gchat',
    messaging_group_id: 'synthetic-morgan-dm',
    resolved_at: now,
  });
  let messagingGroupId = 'synthetic-morgan-dm';
  let threadId: string | null = null;
  let context: string | undefined;
  if (audience !== 'main') {
    messagingGroupId = audience === 'external-chat' ? 'synthetic-juno-chat' : 'synthetic-email-inbox';
    await createMessagingGroup({
      id: messagingGroupId,
      channel_type: audience === 'external-chat' ? 'whatsapp' : 'email',
      platform_id: audience === 'external-email' ? 'email:inbox' : messagingGroupId,
      name: audience === 'external-chat' ? 'Juno Hale' : 'Synthetic assistant inbox',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    if (audience === 'external-chat') {
      await db.run(
        `INSERT INTO gws_ea_chats
        (messaging_group_id,state,serving_agent_group_id,principal_present,connected_at,created_at,updated_at)
        VALUES (?,'connected',?,0,?,?,?)`,
        messagingGroupId,
        group.id,
        now,
        now,
        now,
      );
      const { refreshChatRoster } = (await import(
        source('src/modules/gws-ea-chats/roster.ts')
      )) as typeof import('../../../src/modules/gws-ea-chats/roster.js');
      await refreshChatRoster(messagingGroupId, [
        { key: 'whatsapp:synthetic-juno', name: 'Juno Hale', isPrincipal: false },
      ]);
      const { renderChatContext } = (await import(
        source('src/modules/gws-ea-chats/context.ts')
      )) as typeof import('../../../src/modules/gws-ea-chats/context.js');
      context = await renderChatContext(messagingGroupId);
    } else {
      const { createThread, placeThread, recordThreadAddresses } = (await import(
        source('src/modules/gws-ea-inbox/thread-map.ts')
      )) as typeof import('../../../src/modules/gws-ea-inbox/thread-map.js');
      const thread = readState(path.join(output, 'fixture.json')).thread;
      threadId = (await createThread(null, now, thread?.key ?? 'mail-synthetic-identity')).threadKey;
      await placeThread(threadId, 'nowhere');
      if (thread) {
        await recordThreadAddresses(threadId, thread.namedPeople, 'main', now);
        if (thread.bookingCalendar) {
          const { setThreadBookingCalendar } = await import('../../../src/modules/gws-ea-meetings/thread-calendar.js');
          await setThreadBookingCalendar(threadId, thread.bookingCalendar);
        }
      }
    }
  }
  const { session } = await resolveSession(
    group.id,
    messagingGroupId,
    threadId,
    audience === 'main' ? 'agent-shared' : 'per-thread',
  );
  const agent = path.join(output, 'agent');
  fs.mkdirSync(agent, { recursive: true });
  const { seedScenarioStores } = await import('./seed.js');
  await seedScenarioStores(readState(path.join(output, 'fixture.json')).scenario, agent);
  await composeGroupProjectDoc(group, agent, { fileName: 'CLAUDE.md' });
  const row = await getContainerConfig(group.id);
  if (!row) throw new Error('Synthetic group lacks a native config.');
  const { materializeContainerJson } = (await import(
    source('src/container-config.ts')
  )) as typeof import('../../../src/container-config.js');
  const { parseStoredCapabilities } = (await import(
    source('src/capabilities.ts')
  )) as typeof import('../../../src/capabilities.js');
  const { composeContainerEnv } = (await import(
    source('src/container-env.ts')
  )) as typeof import('../../../src/container-env.js');
  // This is the spawn's reading, including module grantedTo overlays.
  const config = await materializeContainerJson(group.id);
  if (config.skills === 'all') throw new Error('Synthetic role must name its release skills explicitly.');
  // Native sqlite mailbox supplies no env. HOME/TZ are core-owned; these
  // fixture gateway keys occupy the native provider/gateway contribution lane.
  const reservedEnvironmentKeys = ['HOME', 'TZ', 'ANTHROPIC_BASE_URL'];
  const composition: ScenarioComposition = {
    audience: audience as ScenarioComposition['audience'],
    group,
    storedCapabilities: parseStoredCapabilities(row.capabilities, group.name),
    capabilities: config.capabilities,
    skills: config.skills,
    moduleEnvironment: composeContainerEnv(
      { agentGroupId: group.id, capabilities: new Set(config.capabilities) },
      new Set(reservedEnvironmentKeys),
    ),
    reservedEnvironmentKeys,
    session: { id: session.id, messagingGroupId: session.messaging_group_id },
    ...(context ? { context } : {}),
    db: db.dialect,
  };
  fs.writeFileSync(path.join(output, 'composition.json'), JSON.stringify(composition, null, 2));
  if (readState(path.join(output, 'fixture.json')).scenario.observationOnly)
    fs.writeFileSync(
      path.join(agent, 'role-brief.md'),
      '# Conversation brief\n\nReference: JUNO-CEDAR-27. Juno Hale agreed to arrive Tuesday November 3, 2026 at 18:45 America/Los_Angeles. This brief belongs only to this synthetic conversation.\n',
    );
  // Expose release-authored skills, never an operator skill or a live group tree.
  const skills = path.join(agent, '.claude', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  for (const name of composition.skills) {
    const target = path.join(tree, 'container', 'skills', name);
    if (fs.existsSync(target)) fs.symlinkSync(target, path.join(skills, name));
  }
  const { replacePrincipalCalendars, recordCalendarAccess } = (await import(
    source('src/modules/gws-ea-inbox/db.ts')
  )) as typeof import('../../../src/modules/gws-ea-inbox/db.js');
  await replacePrincipalCalendars([SYNTHETIC_IDENTITY.principalEmail], new Date().toISOString());
  const checkedAt = new Date().toISOString();
  await recordCalendarAccess({
    address: SYNTHETIC_IDENTITY.principalEmail,
    calendarId: SYNTHETIC_IDENTITY.principalEmail,
    access: 'bookable',
    hostAdded: false,
    checkedAt,
    changedAt: checkedAt,
    toldAccess: 'bookable',
  });
  const { startSyntheticDelivery } = await import('./delivery.js');
  const stopDelivery = await startSyntheticDelivery();
  try {
    await serveNativeHost(output, session, google);
  } finally {
    await stopDelivery();
  }
} finally {
  await closeDb();
}
