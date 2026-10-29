import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SYNTHETIC_IDENTITY } from './state.js';

// Import only after cwd points at this run's new synthetic install. Host constants
// resolve from cwd; importing before this would touch the operator's install.
const [tree, output, audience] = process.argv.slice(2);
if (!tree || !output || !['main', 'external-email'].includes(audience ?? ''))
  throw new Error('prepare <tree> <output> <main|external-email>');
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
  const group = audience === 'main' ? main : await getAgentGroup(outward);
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
  const { session } = await resolveSession(group.id, 'synthetic-morgan-dm', null, 'agent-shared');
  const agent = path.join(output, 'agent');
  fs.mkdirSync(agent, { recursive: true });
  await composeGroupProjectDoc(group, agent, { fileName: 'CLAUDE.md' });
  const row = await getContainerConfig(group.id);
  if (!row) throw new Error('Synthetic group lacks a native config.');
  fs.writeFileSync(
    path.join(output, 'composition.json'),
    JSON.stringify(
      {
        audience,
        group,
        capabilities: JSON.parse(row.capabilities ?? '[]'),
        skills: JSON.parse(row.skills ?? '[]'),
        db: db.dialect,
      },
      null,
      2,
    ),
  );
  // Expose release-authored skills, never an operator skill or a live group tree.
  const skills = path.join(agent, '.claude', 'skills');
  fs.mkdirSync(skills, { recursive: true });
  for (const name of MAIN_SHARED_SKILLS) {
    const target = path.join(tree, 'container', 'skills', name);
    if (fs.existsSync(target)) fs.symlinkSync(target, path.join(skills, name));
  }
  const { replacePrincipalCalendars, recordCalendarAccess } = (await import(
    source('src/modules/gws-ea-inbox/db.ts')
  )) as typeof import('../../../src/modules/gws-ea-inbox/db.js');
  await replacePrincipalCalendars(['morgan.ellery@example.test'], new Date().toISOString());
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
  await serveNativeHost(output, session, google.calendar, google.mail);
} finally {
  await closeDb();
}
