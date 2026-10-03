import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { lookup } from '../../cli/registry.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import type { AgentGroup, User } from '../../types.js';
import { registerMigration } from '../../db/migrations/index.js';
import { addPerson, getPerson, updatePerson } from '../gws-ea-people/db.js';
import { gwsEaPeopleMigration } from '../gws-ea-people/migration.js';
import { bindVerifiedPrincipalUser, getGwsEaProfile, listVerifiedPrincipalUsers, reconcileGwsEaProfile } from './db.js';
import { MAIN_PRINCIPAL_ADDRESSES_POINTER } from './index.js';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-profile-test';

// The people store's tables alone, so an address made the principal's can be
// seen leaving a person's record; its document section stays out of these tests.
registerMigration(gwsEaPeopleMigration);

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
      principal_emails: [],
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

describe("the principal's email addresses", () => {
  const main = group('ag-main');
  const research = group('ag-research', 'research');
  const HOST: CallerContext = { caller: 'host' };
  const identity = {
    'assistant-display-name': 'Aya',
    'assistant-workspace-email': 'aya@example.test',
    'principal-display-name': 'Taslim',
    'principal-timezone': 'Africa/Lagos',
    'main-agent-group-id': main.id,
  };

  function agent(agentGroupId: string): CallerContext {
    return { caller: 'agent', sessionId: `session-${agentGroupId}`, agentGroupId, messagingGroupId: 'mg-dm' };
  }

  function run(command: string, args: Record<string, unknown> = {}, ctx: CallerContext = HOST) {
    return dispatch({ id: command, command, args }, ctx);
  }

  async function addresses(): Promise<readonly string[]> {
    return (await getGwsEaProfile()).principal_emails;
  }

  beforeEach(async () => {
    for (const candidate of [main, research]) {
      await createGroup(candidate);
      // Binding the principal grants main global CLI scope (init-first-agent's owner grant).
      await updateContainerConfigScalars(candidate.id, { cli_scope: 'global' });
    }
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Taslim',
      principalTimezone: 'Africa/Lagos',
      mainAgentGroupId: main.id,
      principalEmails: ['taslim@example.test', 'taslim@work.example.test'],
    });
  });

  it('reconciles the declared addresses through the hidden command, lowercased and held once', async () => {
    const response = await run('gws-ea-profile-reconcile', {
      ...identity,
      'principal-emails': JSON.stringify(['Ada@Example.TEST', 'ada@example.test', 'Second@Example.test']),
    });

    expect(response).toMatchObject({
      ok: true,
      data: { main_agent_group_id: main.id, principal_emails: ['ada@example.test', 'second@example.test'] },
    });
    expect(await addresses()).toEqual(['ada@example.test', 'second@example.test']);
  });

  it('leaves the addresses to the principal and operator when a reconcile declares none', async () => {
    expect(await run('principal-addresses-add', { email: 'third@example.test' })).toMatchObject({ ok: true });

    expect(await run('gws-ea-profile-reconcile', identity)).toMatchObject({ ok: true });
    expect(await addresses()).toEqual(['taslim@example.test', 'taslim@work.example.test', 'third@example.test']);
  });

  it.each([
    ['a malformed address', ['taslim@example.test', 'not-an-email'], /email address is invalid/i],
    ['no address', [], /at least one/i],
    ["the assistant's own address", ['Aya@Example.test'], /assistant's own/i],
  ])('refuses a reconcile that declares %s, changing nothing', async (_case, principalEmails, message) => {
    const response = await run('gws-ea-profile-reconcile', {
      ...identity,
      'principal-display-name': 'Changed',
      'principal-emails': JSON.stringify(principalEmails),
    });

    expect(response).toMatchObject({ ok: false, error: { message: expect.stringMatching(message) } });
    expect(await getGwsEaProfile()).toMatchObject({
      principal_display_name: 'Taslim',
      principal_emails: ['taslim@example.test', 'taslim@work.example.test'],
    });
  });

  it('holds each address in one row', async () => {
    await expect(
      getDb().run(
        'INSERT INTO gws_ea_principal_addresses (email, added_at) VALUES (?, ?)',
        'taslim@example.test',
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/unique|primary key/i);
  });

  it('adds an address once: adding it again is a no-op', async () => {
    expect(await run('principal-addresses-add', { email: 'Third@Example.test' })).toMatchObject({
      ok: true,
      data: { email: 'third@example.test', added: true },
    });
    expect(await run('principal-addresses-add', { email: 'third@example.test' })).toMatchObject({
      ok: true,
      data: { email: 'third@example.test', added: false },
    });

    const listed = await run('principal-addresses-list');
    expect(listed).toMatchObject({ ok: true });
    expect(listed.ok && (listed.data as Array<{ email: string }>).map((row) => row.email)).toEqual([
      'taslim@example.test',
      'taslim@work.example.test',
      'third@example.test',
    ]);
  });

  it("releases a person's identity that matches an address made the principal's, and keeps the person", async () => {
    const sam = await addPerson({
      name: 'Sam O',
      level: 'known',
      source: 'learned',
      basis: 'On two invitations.',
      identity: 'email:sam.o@gmail.com',
      identitySource: 'calendar',
    });
    await updatePerson({ id: sam.id, source: 'principal', addIdentity: 'email:sam@shared.example.test' });

    expect(await run('principal-addresses-add', { email: 'SamO+home@gmail.com' }, agent(main.id))).toMatchObject({
      ok: true,
      data: { email: 'samo+home@gmail.com', added: true },
    });
    expect((await getPerson(sam.id))?.identities.map((identity) => identity.handle)).toEqual([
      'email:sam@shared.example.test',
    ]);

    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Taslim',
      principalTimezone: 'Africa/Lagos',
      mainAgentGroupId: main.id,
      principalEmails: ['taslim@example.test', 'sam@shared.example.test'],
    });
    expect(await getPerson(sam.id)).toMatchObject({ name: 'Sam O', identities: [] });
  });

  it('refuses to add a malformed address or the assistant’s own', async () => {
    for (const email of ['not-an-email', 'AYA@example.test']) {
      expect(await run('principal-addresses-add', { email }), email).toMatchObject({ ok: false });
    }
    expect(await addresses()).toEqual(['taslim@example.test', 'taslim@work.example.test']);
  });

  it('reports an address it does not hold on remove, and refuses to remove the last one', async () => {
    expect(await run('principal-addresses-remove', { email: 'nobody@example.test' })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('nobody@example.test') },
    });

    expect(await run('principal-addresses-remove', { email: 'Taslim@Work.example.test' })).toMatchObject({
      ok: true,
      data: { email: 'taslim@work.example.test', removed: true },
    });
    expect(await run('principal-addresses-remove', { email: 'taslim@example.test' })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/last/i) },
    });
    expect(await addresses()).toEqual(['taslim@example.test']);
  });

  it("lets canonical main change the addresses on the principal's word, and refuses a group without the principal wiring", async () => {
    expect(await run('principal-addresses-add', { email: 'third@example.test' }, agent(main.id))).toMatchObject({
      ok: true,
      data: { added: true },
    });
    expect(await run('principal-addresses-remove', { email: 'third@example.test' }, agent(main.id))).toMatchObject({
      ok: true,
      data: { removed: true },
    });

    for (const [command, email] of [
      ['principal-addresses-add', 'fourth@example.test'],
      ['principal-addresses-remove', 'taslim@work.example.test'],
    ] as const) {
      expect(await run(command, { email }, agent(research.id)), command).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/only main/i) },
      });
    }
    expect(await run('principal-addresses-list', {}, agent(research.id))).toMatchObject({ ok: true });

    await updateContainerConfigScalars(research.id, { cli_scope: 'group' });
    expect(await run('principal-addresses-add', { email: 'fourth@example.test' }, agent(research.id))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await addresses()).toEqual(['taslim@example.test', 'taslim@work.example.test']);
  });

  it('registers the principal-addresses resource for main and the operator, beside the hidden control-plane commands', () => {
    for (const verb of ['list', 'add', 'remove']) {
      const command = lookup(`principal-addresses-${verb}`);
      expect(command, verb).toMatchObject({ access: 'open', resource: 'principal-addresses' });
      expect(command?.hostOnly, verb).toBeFalsy();
    }
    expect(lookup('gws-ea-profile-reconcile')).toMatchObject({ access: 'hidden', hostOnly: true });
  });

  it('points main at the live address list, which it changes mid-conversation, and copies none', async () => {
    const [section] = await getRequiredProjectDocSections(main);

    expect(section?.body).toContain(MAIN_PRINCIPAL_ADDRESSES_POINTER);
    expect(section?.body).not.toMatch(/taslim@(work\.)?example\.test/u);
  });

  it("lists every current address in another group's identity section", async () => {
    await run('principal-addresses-add', { email: 'first_last@example.test' });
    await run('principal-addresses-remove', { email: 'taslim@work.example.test' });

    const [section] = await getRequiredProjectDocSections(research);
    expect(section?.body).toContain(
      "Taslim's email addresses are `first_last@example.test` and `taslim@example.test`.",
    );
    expect(section?.body).not.toContain('taslim@work.example.test');
    expect(section?.body).not.toContain('ncl principal-addresses');

    await run('principal-addresses-remove', { email: 'first_last@example.test' });
    const [single] = await getRequiredProjectDocSections(research);
    expect(single?.body).toContain("Taslim's email address is `taslim@example.test`.");
  });

  it("names the assistant's own Google address, so the principal knows where to share calendars", async () => {
    const [section] = await getRequiredProjectDocSections(main);
    expect(section?.body).toContain("Aya's own Google Workspace address is `aya@example.test`.");
  });
});
