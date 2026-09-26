import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureContainerConfig } from '../../db/container-configs.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../../cli/dispatch.js';
import { lookup } from '../../cli/registry.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import type { AgentGroup, User } from '../../types.js';
import { bindVerifiedPrincipalUser, getGwsEaProfile, listVerifiedPrincipalUsers, reconcileGwsEaProfile } from './db.js';
import './index.js';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-profile-test';

function group(id: string, name = 'main'): AgentGroup {
  return { id, name, folder: id, agent_provider: null, created_at: '2026-09-18T00:00:00.000Z' };
}

async function createGroup(value: AgentGroup): Promise<void> {
  await createAgentGroup(value);
  await ensureContainerConfig(value.id);
}

async function createUser(value: User): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at)
     VALUES (@id, @kind, @display_name, @created_at)`,
    value,
  );
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('GWS-EA profile module', () => {
  it('migrates one empty profile and reconciles metadata, canonical main, and distinct verified users', async () => {
    expect(await getGwsEaProfile()).toEqual({
      assistant_display_name: null,
      assistant_workspace_email: null,
      principal_display_name: null,
      principal_timezone: null,
      main_agent_group_id: null,
      updated_at: null,
    });

    const main = group('ag-main');
    await createGroup(main);
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Taslim',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: main.id,
    });
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya Renamed',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Taslim',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: main.id,
    });

    const users: User[] = [
      { id: 'gchat:users/one', kind: 'gchat', display_name: 'Taslim', created_at: '2026-09-18T01:00:00.000Z' },
      { id: 'slack:U123', kind: 'slack', display_name: 'Taslim', created_at: '2026-09-18T02:00:00.000Z' },
    ];
    for (const user of users) await createUser(user);
    await bindVerifiedPrincipalUser(users[0]!.id, '2026-09-18T03:00:00.000Z');
    await bindVerifiedPrincipalUser(users[0]!.id, '2026-09-18T04:00:00.000Z');
    await bindVerifiedPrincipalUser(users[1]!.id, '2026-09-18T05:00:00.000Z');

    expect(await getGwsEaProfile()).toMatchObject({
      assistant_display_name: 'Aya Renamed',
      assistant_workspace_email: 'aya@example.test',
      principal_display_name: 'Taslim',
      principal_timezone: 'America/Los_Angeles',
      main_agent_group_id: main.id,
    });
    expect(await listVerifiedPrincipalUsers()).toEqual([
      { user_id: 'gchat:users/one', verified_at: '2026-09-18T04:00:00.000Z' },
      { user_id: 'slack:U123', verified_at: '2026-09-18T05:00:00.000Z' },
    ]);
    expect(await getDb().get<{ count: number }>('SELECT COUNT(*) AS count FROM gws_ea_profile')).toEqual({ count: 1 });
  });

  it('projects the assistant and principal as separate actors for every group without deployment provenance', async () => {
    const main = group('ag-main');
    const laterGroup = group('ag-research', 'research');
    await createGroup(main);
    await createGroup(laterGroup);
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Taslim',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: main.id,
    });

    for (const candidate of [main, laterGroup]) {
      const sections = await getRequiredProjectDocSections(candidate);
      expect(sections).toHaveLength(1);
      expect(sections[0]?.body).toContain('Aya');
      expect(sections[0]?.body).toContain('Taslim');
      expect(sections[0]?.body).toContain('separate people');
      expect(sections[0]?.body).not.toMatch(
        /google chat|slack|credential|oauth|provider|book|chapter|source material/i,
      );
    }

    const groupDir = path.join(TEST_ROOT, main.folder);
    await composeGroupProjectDoc(main, groupDir, { fileName: 'CLAUDE.md' });
    const document = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
    expect(document).toContain('# Assistant Identity');
    expect(document.indexOf('# Assistant Identity')).toBeLessThan(document.indexOf('# NanoClaw Runtime Contract'));
  });

  it('refuses to repoint canonical main while allowing display metadata changes', async () => {
    const first = group('ag-first');
    const second = group('ag-second');
    await createGroup(first);
    await createGroup(second);
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Taslim',
      principalTimezone: 'UTC',
      mainAgentGroupId: first.id,
    });

    await expect(
      reconcileGwsEaProfile({
        assistantDisplayName: 'Aya',
        assistantWorkspaceEmail: 'aya@example.test',
        principalDisplayName: 'Taslim',
        principalTimezone: 'UTC',
        mainAgentGroupId: second.id,
      }),
    ).rejects.toThrow(/canonical main/i);
  });

  it('registers one hidden host-only ncl command that reconciles through the module DB boundary', async () => {
    const main = group('ag-cli-main');
    await createGroup(main);
    const command = lookup('gws-ea-profile-reconcile');
    expect(command).toMatchObject({ access: 'hidden', hostOnly: true });

    const response = await dispatch(
      {
        id: 'profile-command',
        command: 'gws-ea-profile-reconcile',
        args: {
          'assistant-display-name': 'Aya',
          'assistant-workspace-email': 'aya@example.test',
          'principal-display-name': 'Taslim',
          'principal-timezone': 'America/Los_Angeles',
          'main-agent-group-id': main.id,
        },
      },
      { caller: 'host' },
    );

    expect(response).toMatchObject({
      ok: true,
      data: {
        assistant_display_name: 'Aya',
        principal_display_name: 'Taslim',
        main_agent_group_id: main.id,
      },
    });
  });

  it('binds the principal with the direct message that authenticated them, atomically, through ncl', async () => {
    const user: User = {
      id: 'gchat:users/principal',
      kind: 'gchat',
      display_name: 'Taslim',
      created_at: '2026-09-18T01:00:00.000Z',
    };
    await createUser(user);
    for (const [id, isGroup] of [
      ['mg-dm', 0],
      ['mg-space', 1],
    ] as const) {
      await createMessagingGroup({
        id,
        channel_type: 'gchat',
        platform_id: `gchat:spaces/${id}`,
        instance: 'gchat',
        name: null,
        is_group: isGroup,
        unknown_sender_policy: 'strict',
        created_at: '2026-09-18T01:00:00.000Z',
      });
    }
    const bind = (messagingGroupId?: string) =>
      dispatch(
        {
          id: 'bind',
          command: 'gws-ea-profile-bind-principal',
          args: {
            'user-id': user.id,
            'verified-at': '2026-09-18T02:00:00.000Z',
            ...(messagingGroupId === undefined ? {} : { 'messaging-group-id': messagingGroupId }),
          },
        },
        { caller: 'host' },
      );
    const dms = () => getDb().all('SELECT user_id, channel_type, messaging_group_id, resolved_at FROM user_dms');

    expect(await bind()).toMatchObject({ ok: false, error: { message: '--messaging-group-id is required' } });
    expect(await bind('mg-space')).toMatchObject({ ok: false, error: { message: /direct conversation/ } });
    expect(await bind('mg-missing')).toMatchObject({ ok: false, error: { message: /not found/ } });
    expect(await listVerifiedPrincipalUsers()).toEqual([]);
    expect(await dms()).toEqual([]);

    for (const attempt of [1, 2]) {
      expect(await bind('mg-dm'), `attempt ${attempt}`).toEqual({
        id: 'bind',
        ok: true,
        data: { user_id: user.id, verified_at: '2026-09-18T02:00:00.000Z', messaging_group_id: 'mg-dm' },
      });
    }
    expect(await listVerifiedPrincipalUsers()).toEqual([{ user_id: user.id, verified_at: '2026-09-18T02:00:00.000Z' }]);
    expect(await dms()).toEqual([
      {
        user_id: user.id,
        channel_type: 'gchat',
        messaging_group_id: 'mg-dm',
        resolved_at: '2026-09-18T02:00:00.000Z',
      },
    ]);
  });

  it('accepts only canonical UTC timestamps for verified principal bindings', async () => {
    const user: User = {
      id: 'gchat:users/canonical-time',
      kind: 'gchat',
      display_name: 'Taslim',
      created_at: '2026-09-18T01:00:00.000Z',
    };
    await createUser(user);

    await expect(bindVerifiedPrincipalUser(user.id, '2026-09-18T01:02:03Z')).rejects.toThrow(/timestamp/i);
    await expect(bindVerifiedPrincipalUser(user.id, '2026-09-18T01:02:03.000Z')).resolves.toBeUndefined();
  });
});
