import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { lookup } from '../../cli/registry.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import type { AgentGroup, User } from '../../types.js';
import { registerMigration } from '../../db/migrations/index.js';
import { recordCalendarAccess } from '../gws-ea-inbox/db.js';
import { gwsEaInboxCalendarAccessMigration } from '../gws-ea-inbox/migration.js';
import { emailSignature } from '../gws-ea-inbox/render.js';
import { addPerson, getPerson, updatePerson } from '../gws-ea-people/db.js';
import { gwsEaPeopleMigration, gwsEaPeopleThinRecordMigration } from '../gws-ea-people/migration.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import {
  bindVerifiedPrincipalUser,
  getExternalEmailAgentGroupId,
  getGwsEaProfile,
  listVerifiedPrincipalUsers,
  projectDocAudience,
  reconcileGwsEaProfile,
  recordExternalEmailAgentGroupId,
} from './db.js';
import { MAIN_PRINCIPAL_ADDRESSES_POINTER } from './index.js';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-profile-test';

// The people store's tables alone, so an address made the principal's can be
// seen leaving a person's record; its document section stays out of these tests.
registerMigration(gwsEaPeopleMigration);
registerMigration(gwsEaPeopleThinRecordMigration);

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
      external_email_agent_group_id: null,
      browser_agent_group_id: null,
      updated_at: null,
      principal_emails: [],
    });

    const main = group('ag-main');
    await createGroup(main);
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Morgan',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: main.id,
    });
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya Renamed',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Morgan',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: main.id,
    });

    const users: User[] = [
      { id: 'gchat:users/one', kind: 'gchat', display_name: 'Morgan', created_at: '2026-09-18T01:00:00.000Z' },
      { id: 'slack:U123', kind: 'slack', display_name: 'Morgan', created_at: '2026-09-18T02:00:00.000Z' },
    ];
    for (const user of users) await createUser(user);
    await bindVerifiedPrincipalUser(users[0]!.id, '2026-09-18T03:00:00.000Z');
    await bindVerifiedPrincipalUser(users[0]!.id, '2026-09-18T04:00:00.000Z');
    await bindVerifiedPrincipalUser(users[1]!.id, '2026-09-18T05:00:00.000Z');

    expect(await getGwsEaProfile()).toMatchObject({
      assistant_display_name: 'Aya Renamed',
      assistant_workspace_email: 'aya@example.test',
      principal_display_name: 'Morgan',
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
      principalDisplayName: 'Morgan',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: main.id,
    });

    for (const candidate of [main, laterGroup]) {
      const sections = await getRequiredProjectDocSections(candidate);
      expect(sections).toHaveLength(1);
      expect(sections[0]?.body).toContain('Aya');
      expect(sections[0]?.body).toContain('Morgan');
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
      principalDisplayName: 'Morgan',
      principalTimezone: 'UTC',
      mainAgentGroupId: first.id,
    });

    await expect(
      reconcileGwsEaProfile({
        assistantDisplayName: 'Aya',
        assistantWorkspaceEmail: 'aya@example.test',
        principalDisplayName: 'Morgan',
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
          'principal-display-name': 'Morgan',
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
        principal_display_name: 'Morgan',
        main_agent_group_id: main.id,
      },
    });
  });

  it('binds the principal with the direct message that authenticated them, atomically, through ncl', async () => {
    const user: User = {
      id: 'gchat:users/principal',
      kind: 'gchat',
      display_name: 'Morgan',
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

  it("seeds the principal's name and timezone when the profile publishes main, and derives main's container timezone from it", async () => {
    const main = group('ag-main');
    await createGroup(main);
    const published = {
      'assistant-display-name': 'Aya',
      'assistant-workspace-email': 'aya@example.test',
      'main-agent-group-id': main.id,
    };
    const reconcile = (args: Record<string, unknown>) =>
      dispatch({ id: 'reconcile', command: 'gws-ea-profile-reconcile', args }, { caller: 'host' });

    // A profile that names main names the principal.
    expect(await reconcile(published)).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/name and timezone/u) },
    });
    expect((await getGwsEaProfile()).main_agent_group_id).toBeNull();

    expect(
      await reconcile({
        ...published,
        'principal-display-name': 'Morgan Ellery',
        'principal-timezone': 'Africa/Lagos',
      }),
    ).toMatchObject({
      ok: true,
      data: { principal_display_name: 'Morgan Ellery', principal_timezone: 'Africa/Lagos' },
    });
    const config = await getContainerConfig(main.id);
    expect(config?.timezone).toBe('Africa/Lagos');

    // A reconcile after publication names no principal: the profile keeps theirs, and main's config is left as it was.
    expect(await reconcile(published)).toMatchObject({
      ok: true,
      data: { principal_display_name: 'Morgan Ellery', principal_timezone: 'Africa/Lagos' },
    });
    expect(await getContainerConfig(main.id)).toEqual(config);
  });

  it("seeds the principal's timezone in the zone's own spelling, and refuses an offset, since main's container runs in it", async () => {
    const main = group('ag-main');
    await createGroup(main);
    const reconcile = (timezone: string) =>
      dispatch(
        {
          id: 'reconcile',
          command: 'gws-ea-profile-reconcile',
          args: {
            'assistant-display-name': 'Aya',
            'assistant-workspace-email': 'aya@example.test',
            'principal-display-name': 'Morgan Ellery',
            'principal-timezone': timezone,
            'main-agent-group-id': main.id,
          },
        },
        { caller: 'host' },
      );

    // A container's TZ reads an offset with its sign flipped, so it is no seed.
    expect(await reconcile('+05:30')).toMatchObject({
      ok: false,
      error: { message: 'Principal timezone is invalid' },
    });
    expect(await getGwsEaProfile()).toMatchObject({ main_agent_group_id: null, principal_timezone: null });
    expect((await getContainerConfig(main.id))?.timezone).toBeNull();

    // It reads a miscased name as UTC, so the profile and main's container hold the zone's own spelling.
    expect(await reconcile('europe/london')).toMatchObject({
      ok: true,
      data: { principal_timezone: 'Europe/London' },
    });
    expect((await getContainerConfig(main.id))?.timezone).toBe('Europe/London');
  });

  it('accepts only canonical UTC timestamps for verified principal bindings', async () => {
    const user: User = {
      id: 'gchat:users/canonical-time',
      kind: 'gchat',
      display_name: 'Morgan',
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
    'principal-display-name': 'Morgan',
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
      principalDisplayName: 'Morgan',
      principalTimezone: 'Africa/Lagos',
      mainAgentGroupId: main.id,
      principalEmails: ['morgan@example.test', 'morgan@work.example.test'],
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
    expect(await addresses()).toEqual(['morgan@example.test', 'morgan@work.example.test', 'third@example.test']);
  });

  it.each([
    ['a malformed address', ['morgan@example.test', 'not-an-email'], /email address is invalid/i],
    ['no address', [], /at least one/i],
    ["the assistant's own address", ['Aya@Example.test'], /assistant's own/i],
    ["a plus-addressed spelling of the assistant's own", ['Aya+x@Example.test'], /assistant's own/i],
    [
      'two spellings of one Gmail address',
      ['morganellery@gmail.com', 'Morgan.Ellery@googlemail.com'],
      /morgan\.ellery@googlemail\.com is another spelling of morganellery@gmail\.com/i,
    ],
  ])('refuses a reconcile that declares %s, changing nothing', async (_case, principalEmails, message) => {
    const response = await run('gws-ea-profile-reconcile', {
      ...identity,
      'principal-display-name': 'Changed',
      'principal-emails': JSON.stringify(principalEmails),
    });

    expect(response).toMatchObject({ ok: false, error: { message: expect.stringMatching(message) } });
    expect(await getGwsEaProfile()).toMatchObject({
      principal_display_name: 'Morgan',
      principal_emails: ['morgan@example.test', 'morgan@work.example.test'],
    });
  });

  it('holds each address in one row', async () => {
    await expect(
      getDb().run(
        'INSERT INTO gws_ea_principal_addresses (email, added_at) VALUES (?, ?)',
        'morgan@example.test',
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
      'morgan@example.test',
      'morgan@work.example.test',
      'third@example.test',
    ]);
  });

  it("lists each address with its calendar access as the inbox's calendar poll last read it, unchecked until then", async () => {
    // Before the inbox's store exists, no calendar has been checked.
    const before = await run('principal-addresses-list');
    expect(before).toMatchObject({
      ok: true,
      data: [
        { email: 'morgan@example.test', calendar_access: 'unchecked', calendar_checked_at: null },
        { email: 'morgan@work.example.test', calendar_access: 'unchecked', calendar_checked_at: null },
      ],
    });

    await runMigrations(getDb(), [gwsEaInboxCalendarAccessMigration]);
    const checkedAt = '2026-10-10T09:00:00.000Z';
    await recordCalendarAccess({
      address: 'morgan@work.example.test',
      calendarId: 'morgan@work.example.test',
      access: 'free-busy',
      hostAdded: true,
      checkedAt,
      changedAt: checkedAt,
      toldAccess: 'free-busy',
    });
    await run('principal-addresses-add', { email: 'third@example.test' });

    const listed = await run('principal-addresses-list', {}, agent(main.id));
    expect(listed).toEqual({
      id: 'principal-addresses-list',
      ok: true,
      data: [
        {
          email: 'morgan@example.test',
          added_at: expect.any(String),
          calendar_access: 'unchecked',
          calendar_checked_at: null,
        },
        {
          email: 'morgan@work.example.test',
          added_at: expect.any(String),
          calendar_access: 'free-busy',
          calendar_checked_at: checkedAt,
        },
        {
          email: 'third@example.test',
          added_at: expect.any(String),
          calendar_access: 'unchecked',
          calendar_checked_at: null,
        },
      ],
    });
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
      principalDisplayName: 'Morgan',
      principalTimezone: 'Africa/Lagos',
      mainAgentGroupId: main.id,
      principalEmails: ['morgan@example.test', 'sam@shared.example.test'],
    });
    expect(await getPerson(sam.id)).toMatchObject({ name: 'Sam O', identities: [] });
  });

  it('refuses to add a malformed address or the assistant’s own, in any spelling that reaches it', async () => {
    for (const email of ['not-an-email', 'AYA@example.test', 'aya+x@example.test']) {
      expect(await run('principal-addresses-add', { email }), email).toMatchObject({ ok: false });
    }
    expect(await addresses()).toEqual(['morgan@example.test', 'morgan@work.example.test']);
  });

  it("refuses a dotted spelling of an assistant's Gmail address", async () => {
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'ayaassistant@gmail.com',
      principalDisplayName: 'Morgan',
      principalTimezone: 'Africa/Lagos',
      mainAgentGroupId: main.id,
    });

    expect(await run('principal-addresses-add', { email: 'Aya.Assistant@gmail.com' })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/assistant's own/i) },
    });
    expect(await addresses()).toEqual(['morgan@example.test', 'morgan@work.example.test']);
  });

  it('refuses another spelling of a listed address, naming the listed one, and holds the same spelling once', async () => {
    expect(await run('principal-addresses-add', { email: 'morganellery@gmail.com' })).toMatchObject({ ok: true });

    for (const email of ['Morgan.Ellery@gmail.com', 'morganellery+news@googlemail.com']) {
      expect(await run('principal-addresses-add', { email }, agent(main.id)), email).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining(
            "another spelling of morganellery@gmail.com, already one of the principal's",
          ),
        },
      });
    }
    expect(await run('principal-addresses-add', { email: 'MorganEllery@gmail.com' })).toMatchObject({
      ok: true,
      data: { email: 'morganellery@gmail.com', added: false },
    });
    // Another domain matches by case alone, so a +tag there is an address of its own.
    expect(await run('principal-addresses-add', { email: 'morgan+news@example.test' })).toMatchObject({
      ok: true,
      data: { added: true },
    });
    expect(await addresses()).toEqual([
      'morgan+news@example.test',
      'morgan@example.test',
      'morgan@work.example.test',
      'morganellery@gmail.com',
    ]);
  });

  it('reports an address it does not hold on remove, and refuses to remove the last one', async () => {
    expect(await run('principal-addresses-remove', { email: 'nobody@example.test' })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('nobody@example.test') },
    });

    expect(await run('principal-addresses-remove', { email: 'Morgan@Work.example.test' })).toMatchObject({
      ok: true,
      data: { email: 'morgan@work.example.test', removed: true },
    });
    expect(await run('principal-addresses-remove', { email: 'morgan@example.test' })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/last/i) },
    });
    expect(await addresses()).toEqual(['morgan@example.test']);
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
      ['principal-addresses-remove', 'morgan@work.example.test'],
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
    expect(await addresses()).toEqual(['morgan@example.test', 'morgan@work.example.test']);
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
    expect(section?.body).not.toMatch(/morgan@(work\.)?example\.test/u);
  });

  it('names the field of the live list that carries each calendar’s access (R9)', async () => {
    const listed = await run('principal-addresses-list', {}, agent(main.id));
    const [row] = listed.ok ? (listed.data as Array<Record<string, unknown>>) : [];

    expect(Object.keys(row ?? {})).toContain('calendar_access');
    expect(MAIN_PRINCIPAL_ADDRESSES_POINTER).toContain('`calendar_access`');
  });

  it("lists every current address in another group's identity section", async () => {
    await run('principal-addresses-add', { email: 'first_last@example.test' });
    await run('principal-addresses-remove', { email: 'morgan@work.example.test' });

    const [section] = await getRequiredProjectDocSections(research);
    expect(section?.body).toContain(
      "Morgan's email addresses are `first_last@example.test` and `morgan@example.test`.",
    );
    expect(section?.body).not.toContain('morgan@work.example.test');
    expect(section?.body).not.toContain('ncl principal-addresses');

    await run('principal-addresses-remove', { email: 'first_last@example.test' });
    const [single] = await getRequiredProjectDocSections(research);
    expect(single?.body).toContain("Morgan's email address is `morgan@example.test`.");
  });

  it("names the assistant's own Google address, so the principal knows where to share calendars", async () => {
    const [section] = await getRequiredProjectDocSections(main);
    expect(section?.body).toContain("Aya's own Google Workspace address is `aya@example.test`.");
  });
});

describe("external-email's pointer and audience", () => {
  const main = group('ag-main');
  const research = group('ag-research', 'research');
  const ee = group('ag-external-email', 'external-email');

  beforeEach(async () => {
    for (const candidate of [main, research, ee]) await createGroup(candidate);
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Morgan',
      principalTimezone: 'Africa/Lagos',
      mainAgentGroupId: main.id,
      principalEmails: ['morgan@example.test'],
    });
  });

  it('records the pointer beside main, once, and never moves it', async () => {
    expect(await getExternalEmailAgentGroupId()).toBeNull();
    await expect(recordExternalEmailAgentGroupId('ag-missing')).rejects.toThrow(/FOREIGN KEY/i);
    expect(await getExternalEmailAgentGroupId()).toBeNull();
    await recordExternalEmailAgentGroupId(ee.id);
    await recordExternalEmailAgentGroupId(ee.id);

    expect(await getGwsEaProfile()).toMatchObject({
      main_agent_group_id: main.id,
      external_email_agent_group_id: ee.id,
    });
    await expect(recordExternalEmailAgentGroupId(research.id)).rejects.toThrow(/already bound/);
  });

  it('writes each document for its audience: external-email gets the two names and no address', async () => {
    await recordExternalEmailAgentGroupId(ee.id);

    expect(await projectDocAudience(main.id)).toBe('main');
    expect(await projectDocAudience(ee.id)).toBe('external-email');
    expect(await projectDocAudience(research.id)).toBe('other');

    const [section] = await getRequiredProjectDocSections(ee);
    expect(section).toEqual({
      name: 'Assistant Identity',
      body: 'Aya is the assistant. Morgan is the principal. They are separate people: act and communicate as Aya, support Morgan, and never present the assistant as the principal.',
    });
    const [other] = await getRequiredProjectDocSections(research);
    expect(other?.body).toContain('`morgan@example.test`');
    expect(other?.body).toContain('`aya@example.test`');
  });
});

describe("the principal's name and timezone (R16, KTD9)", () => {
  const main = group('ag-main');
  const research = group('ag-research', 'research');
  const HOST: CallerContext = { caller: 'host' };
  const PRINCIPAL = 'gchat:users/principal';
  const DM = { channelType: 'gchat', platformId: 'gchat:spaces/dm' } as const;
  const published = {
    'assistant-display-name': 'Aya',
    'assistant-workspace-email': 'aya@example.test',
    'main-agent-group-id': main.id,
  };

  /** What the principal's direct message received. */
  let sent: string[];

  function agent(agentGroupId: string): CallerContext {
    return { caller: 'agent', sessionId: `session-${agentGroupId}`, agentGroupId, messagingGroupId: 'mg-dm' };
  }

  function run(command: string, args: Record<string, unknown> = {}, ctx: CallerContext = HOST) {
    return dispatch({ id: command, command, args }, ctx);
  }

  async function nameAndTimezone(): Promise<unknown> {
    const profile = await getGwsEaProfile();
    return { name: profile.principal_display_name, timezone: profile.principal_timezone };
  }

  async function mainTimezone(): Promise<string | null | undefined> {
    return (await getContainerConfig(main.id))?.timezone;
  }

  beforeEach(async () => {
    sent = [];
    for (const candidate of [main, research]) {
      await createGroup(candidate);
      // Binding the principal grants main global CLI scope (init-first-agent's owner grant).
      await updateContainerConfigScalars(candidate.id, { cli_scope: 'global' });
    }
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Aya',
      assistantWorkspaceEmail: 'aya@example.test',
      principalDisplayName: 'Morgan Ellery',
      principalTimezone: 'America/Los_Angeles',
      mainAgentGroupId: main.id,
      principalEmails: ['morgan@example.test'],
    });
    await createMessagingGroup({
      id: 'mg-dm',
      channel_type: DM.channelType,
      platform_id: DM.platformId,
      instance: 'gchat',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: '2026-10-10T08:00:00.000Z',
    });
    await createUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: '2026-10-10T08:00:00.000Z' });
    await bindVerifiedPrincipalUser(PRINCIPAL, '2026-10-10T08:00:00.000Z');
    await upsertUserDm({
      user_id: PRINCIPAL,
      channel_type: 'gchat',
      messaging_group_id: 'mg-dm',
      resolved_at: '2026-10-10T08:00:00.000Z',
    });
    setDeliveryAdapter({
      async deliver(channelType, platformId, _threadId, _kind, content) {
        expect({ channelType, platformId }).toEqual(DM);
        sent.push((JSON.parse(content) as { text: string }).text);
        return 'platform-message';
      },
    });
  });

  it('registers get and set for main and the operator, beside the hidden control-plane commands', () => {
    for (const verb of ['get', 'set']) {
      const command = lookup(`principal-profile-${verb}`);
      expect(command, verb).toMatchObject({ access: 'open', resource: 'principal-profile' });
      expect(command?.hostOnly, verb).toBeFalsy();
    }
    expect(lookup('gws-ea-profile-get')).toMatchObject({ access: 'hidden', hostOnly: true });
    expect(lookup('gws-ea-profile-reconcile')).toMatchObject({ access: 'hidden', hostOnly: true });
  });

  it('gives main the name and timezone only', async () => {
    expect(await run('principal-profile-get', {}, agent(main.id))).toEqual({
      id: 'principal-profile-get',
      ok: true,
      data: { name: 'Morgan Ellery', timezone: 'America/Los_Angeles' },
    });
  });

  it("changes the name on main's word: live readers use it at once, and the principal gets one receipt", async () => {
    const response = await run('principal-profile-set', { name: 'Juno Hale' }, agent(main.id));

    expect(response).toMatchObject({
      ok: true,
      data: {
        name: 'Juno Hale',
        timezone: 'America/Los_Angeles',
        changed: ['name'],
        message: expect.stringMatching(/next start/u),
      },
    });
    expect(await nameAndTimezone()).toEqual({ name: 'Juno Hale', timezone: 'America/Los_Angeles' });
    // The signature reads the profile at each send.
    expect(emailSignature(await getGwsEaProfile())).toBe('Aya | EA to Juno Hale');
    // main's identity text is composed at its next start, from the profile.
    const [section] = await getRequiredProjectDocSections(main);
    expect(section?.body).toContain('Juno Hale is the principal.');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Morgan Ellery');
    expect(sent[0]).toContain('Juno Hale');
    expect(await mainTimezone()).toBe('America/Los_Angeles');
  });

  it("changes the timezone in the profile and main's container config together, with one receipt", async () => {
    const response = await run('principal-profile-set', { timezone: 'Europe/London' }, agent(main.id));

    expect(response).toMatchObject({
      ok: true,
      data: { name: 'Morgan Ellery', timezone: 'Europe/London', changed: ['timezone'] },
    });
    // free_time and the other host-side labels read the profile's timezone at each call.
    expect((await getGwsEaProfile()).principal_timezone).toBe('Europe/London');
    expect(await mainTimezone()).toBe('Europe/London');
    expect((await getContainerConfig(research.id))?.timezone).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('America/Los_Angeles');
    expect(sent[0]).toContain('Europe/London');
  });

  it('changes both in one receipt, and a set that changes nothing writes nothing and sends nothing', async () => {
    expect(
      await run('principal-profile-set', { name: 'Juno Hale', timezone: 'Africa/Lagos' }, agent(main.id)),
    ).toMatchObject({ ok: true, data: { changed: ['name', 'timezone'] } });
    expect(sent).toHaveLength(1);
    for (const value of ['Morgan Ellery', 'Juno Hale', 'America/Los_Angeles', 'Africa/Lagos']) {
      expect(sent[0]).toContain(value);
    }
    const { updated_at: updatedAt } = await getGwsEaProfile();

    expect(
      await run('principal-profile-set', { name: 'Juno Hale', timezone: 'Africa/Lagos' }, agent(main.id)),
    ).toMatchObject({ ok: true, data: { changed: [], message: expect.stringMatching(/nothing changed/iu) } });
    expect(sent).toHaveLength(1);
    expect((await getGwsEaProfile()).updated_at).toBe(updatedAt);
  });

  it('tells main to tell the principal itself when the receipt cannot reach them', async () => {
    await getDb().run('DELETE FROM user_dms');

    expect(await run('principal-profile-set', { name: 'Juno Hale' }, agent(main.id))).toMatchObject({
      ok: true,
      data: { changed: ['name'], message: expect.stringMatching(/could not reach the principal/u) },
    });
    expect(sent).toEqual([]);
  });

  it.each([
    ['an address', 'Juno Hale juno@example.com'],
    ['a link', 'Juno https://pay.example'],
    ['a link without a scheme', 'Juno www.pay'],
    ['a path', 'Juno/Hale'],
    ['a bare domain', 'Juno Hale pay-juno.example'],
    ['markup', 'Juno <b>Hale</b>'],
    ['a code span', 'Juno `Hale`'],
    ['too many characters', `Juno ${'Hale'.repeat(20)}`],
    ['nothing', '   '],
    ['a line break', 'Juno\nHale'],
  ])('refuses a name holding %s and changes nothing', async (_case, name) => {
    const response = await run('principal-profile-set', { name, timezone: 'Europe/London' }, agent(main.id));

    expect(response).toMatchObject({ ok: false, error: { message: expect.stringMatching(/person's name/u) } });
    expect(await nameAndTimezone()).toEqual({ name: 'Morgan Ellery', timezone: 'America/Los_Angeles' });
    expect(await mainTimezone()).toBe('America/Los_Angeles');
    expect(sent).toEqual([]);
  });

  it.each(['J.R. Hale', 'Dr. Juno Hale', 'Noël Archer-Ford', "Lena O'Ford Jr."])('accepts %s', async (name) => {
    expect(await run('principal-profile-set', { name }, agent(main.id))).toMatchObject({ ok: true, data: { name } });
  });

  it('refuses a timezone that is not an IANA zone, and a set that names nothing', async () => {
    expect(await run('principal-profile-set', { timezone: 'Not/A-Timezone' }, agent(main.id))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/timezone/iu) },
    });
    expect(await run('principal-profile-set', {}, agent(main.id))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/--name.*--timezone/u) },
    });
    expect(await nameAndTimezone()).toEqual({ name: 'Morgan Ellery', timezone: 'America/Los_Angeles' });
    expect(sent).toEqual([]);
  });

  it("refuses a UTC offset, which a container's TZ reads with its sign flipped, and keeps a zone in its own spelling", async () => {
    expect(await run('principal-profile-set', { timezone: '+05:30' }, agent(main.id))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/timezone/iu) },
    });
    expect(sent).toEqual([]);

    // A miscased name reads as UTC in a container's TZ, so the profile holds the zone's own spelling.
    expect(await run('principal-profile-set', { timezone: 'europe/london' }, agent(main.id))).toMatchObject({
      ok: true,
      data: { timezone: 'Europe/London' },
    });
    expect(await nameAndTimezone()).toEqual({ name: 'Morgan Ellery', timezone: 'Europe/London' });

    // A zone's other name, cased as the zone database writes it, stays the principal's own words.
    expect(await run('principal-profile-set', { timezone: 'Asia/Kolkata' }, agent(main.id))).toMatchObject({
      ok: true,
      data: { timezone: 'Asia/Kolkata' },
    });

    // Another name for a zone in capitals is miscased too, and takes the zone's own spelling.
    for (const [given, held] of [
      ['US/PACIFIC', 'America/Los_Angeles'],
      ['Asia/KOLKATA', 'Asia/Calcutta'],
      ['Europe/KYIV', 'Europe/Kiev'],
    ] as const) {
      expect(await run('principal-profile-set', { timezone: given }, agent(main.id)), given).toMatchObject({
        ok: true,
        data: { timezone: held },
      });
    }
  });

  it("refuses every caller but main and the operator, and leaves the control plane's profile read as it was", async () => {
    for (const [command, args] of [
      ['principal-profile-get', {}],
      ['principal-profile-set', { name: 'Juno Hale' }],
    ] as const) {
      expect(await run(command, args, agent(research.id)), command).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/only to main/u) },
      });
    }
    expect(await run('principal-profile-set', { timezone: 'Europe/London' }, HOST)).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);

    expect(await run('gws-ea-profile-get', {}, agent(main.id))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    const read = await run('gws-ea-profile-get');
    expect(read).toMatchObject({ ok: true, data: { principal_display_name: 'Morgan Ellery' } });
    expect(read.ok && Object.keys(read.data as object).sort()).toEqual(
      [
        'assistant_display_name',
        'assistant_workspace_email',
        'browser_agent_group_id',
        'external_email_agent_group_id',
        'main_agent_group_id',
        'principal_display_name',
        'principal_emails',
        'principal_timezone',
        'updated_at',
      ].sort(),
    );
  });

  it('keeps what main set through a control-plane reconcile, which derives main’s container timezone from the profile', async () => {
    await run('principal-profile-set', { name: 'Juno Hale', timezone: 'Europe/London' }, agent(main.id));
    // Drift from elsewhere: the reconcile puts main back in the principal's timezone.
    await updateContainerConfigScalars(main.id, { timezone: 'Asia/Tokyo' });

    expect(await run('gws-ea-profile-reconcile', published)).toMatchObject({
      ok: true,
      data: { principal_display_name: 'Juno Hale', principal_timezone: 'Europe/London' },
    });
    expect(await nameAndTimezone()).toEqual({ name: 'Juno Hale', timezone: 'Europe/London' });
    expect(await mainTimezone()).toBe('Europe/London');
  });
});
