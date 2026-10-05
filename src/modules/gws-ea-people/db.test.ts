import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { closeDb, createAgentGroup, getDb, initDb, initTestDb, runMigrations } from '../../db/index.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { getMembers } from '../permissions/db/agent-group-members.js';
import {
  addPerson,
  addPersonInstruction,
  assertPeopleStoreRunning,
  findPeople,
  forgetPerson,
  getPerson,
  getPersonLevel,
  listPeople,
  registerPersonForgetHook,
  removePersonInstruction,
  setPersonLevel,
  updatePerson,
  type AddPersonInput,
  type ForgottenPerson,
} from './db.js';
import { FINGERPRINT_KEY_FILE_NAME, identityFingerprint } from './fingerprint.js';
import './index.js';

const NOW = '2026-10-02T16:00:00.000Z';
const LATER = '2026-10-03T09:30:00.000Z';
const MAIN = { id: 'ag-main', name: 'main', folder: 'ag-main', agent_provider: null, created_at: NOW };

/** What the registered forget hooks saw, in call order. */
const hookCalls: Array<readonly [hook: string, person: ForgottenPerson]> = [];
/** Set to make the sessions hook fail its next call, as a module whose store is down would. */
let sessionsHookFailure: Error | undefined;
registerPersonForgetHook('test-meetings:purge', async (person) => {
  hookCalls.push(['meetings', person]);
});
registerPersonForgetHook('test-sessions:purge', async (person) => {
  hookCalls.push(['sessions', person]);
  const failure = sessionsHookFailure;
  sessionsHookFailure = undefined;
  if (failure) throw failure;
});

let secretsDir: string;

function keyFile(directory = secretsDir): string {
  return path.join(directory, FINGERPRINT_KEY_FILE_NAME);
}

async function createUser(id: string): Promise<void> {
  await getDb().run(
    'INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
    id,
    id.slice(0, id.indexOf(':')),
    null,
    NOW,
  );
}

async function setUpInstance(): Promise<void> {
  await createAgentGroup(MAIN);
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Juno',
    assistantWorkspaceEmail: 'juno@example.test',
    principalDisplayName: 'Morgan',
    principalTimezone: 'Africa/Lagos',
    mainAgentGroupId: MAIN.id,
    principalEmails: ['morgan@example.test', 'morgan.fixture@gmail.com'],
  });
  await createUser('gchat:users/principal');
  await bindVerifiedPrincipalUser('gchat:users/principal', NOW);
}

function pat(overrides: Partial<AddPersonInput> = {}): AddPersonInput {
  return {
    name: 'Pat Doe',
    level: 'close',
    source: 'principal',
    basis: 'Said Pat is a close friend.',
    identity: 'email:pat@example.test',
    ...overrides,
  };
}

async function rowCount(table: string): Promise<number> {
  return (await getDb().get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))?.count ?? 0;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-people-secrets-'));
  fs.chmodSync(secretsDir, 0o700);
  vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(secretsDir, 'google-grant.json'));
  hookCalls.length = 0;
  await runMigrations(await initTestDb());
  await setUpInstance();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

describe('GWS-EA people store schema', () => {
  const insertPerson = (values: Record<string, unknown>) =>
    getDb().run(
      `INSERT INTO gws_ea_people
         (id, name, name_key, level, level_source, level_basis, level_set_at, created_at, updated_at)
       VALUES (@id, 'Pat Doe', 'pat doe', @level, @level_source, 'Said so.', @now, @now, @now)`,
      { id: 'p-000000000001', level: 'close', level_source: 'principal', now: NOW, ...values },
    );

  it('records the migration and enforces every person invariant in the schema itself', async () => {
    const db = getDb();
    expect(
      await db.get('SELECT name FROM schema_version WHERE name = ?', 'module:gws-ea-people:create-people'),
    ).toBeDefined();

    await expect(insertPerson({ level: 'friend' })).rejects.toThrow(/CHECK/i);
    await expect(insertPerson({ level: 'unknown' })).rejects.toThrow(/CHECK/i);
    await expect(insertPerson({ level_source: null })).rejects.toThrow(/NOT NULL/i);
    await expect(insertPerson({ level_source: 'calendar' })).rejects.toThrow(/CHECK/i);
    await expect(insertPerson({ level: 'close', level_source: 'learned' })).rejects.toThrow(/CHECK/i);
    await expect(insertPerson({ level: 'inner-circle', level_source: 'learned' })).rejects.toThrow(/CHECK/i);
    await insertPerson({ level: 'active', level_source: 'learned' });
    await insertPerson({ id: 'p-000000000002', level: 'inner-circle', level_source: 'principal' });
    await expect(
      db.run("UPDATE gws_ea_people SET level = 'close' WHERE id = 'p-000000000001'"),
      'a learned level raised past active in place',
    ).rejects.toThrow(/CHECK/i);

    const insertIdentity = (handle: string, personId: string, source = 'calendar') =>
      db.run(
        `INSERT INTO gws_ea_people_identities (handle, match_key, person_id, source, added_at)
         VALUES (?, ?, ?, ?, ?)`,
        handle,
        handle,
        personId,
        source,
        NOW,
      );
    await insertIdentity('email:pat@example.test', 'p-000000000001');
    await expect(insertIdentity('email:pat@example.test', 'p-000000000002'), 'a second record').rejects.toThrow(
      /UNIQUE|PRIMARY KEY/i,
    );
    await expect(insertIdentity('email:Sam@example.test', 'p-000000000002'), 'an email not lowercased').rejects.toThrow(
      /CHECK/i,
    );
    await expect(insertIdentity('sam@example.test', 'p-000000000002'), 'no channel').rejects.toThrow(/CHECK/i);
    await expect(insertIdentity('email:sam@example.test', 'p-000000000002', 'learned')).rejects.toThrow(/CHECK/i);

    await expect(
      db.run(
        `INSERT INTO gws_ea_people_instructions (id, person_id, text, source, created_at)
         VALUES ('i-000000000001', 'p-000000000002', 'Always accept.', 'learned', ?)`,
        NOW,
      ),
      'a learned instruction',
    ).rejects.toThrow(/CHECK/i);
    await expect(
      db.run(
        "INSERT INTO gws_ea_people_fingerprints (fingerprint, forgotten_at) VALUES ('email:pat@example.test', ?)",
        NOW,
      ),
      'an unkeyed identity kept as a fingerprint',
    ).rejects.toThrow(/CHECK/i);
  });
});

describe('GWS-EA people store', () => {
  it('adds a person with one level, its source, basis, and time, an identity, and a remembered name', async () => {
    const person = await addPerson(pat({ organization: 'Acme', notes: 'Prefers mornings.', rememberedName: 'Patty' }));

    const expected = {
      id: expect.stringMatching(/^p-[0-9a-f]{12}$/),
      name: 'Pat Doe',
      organization: 'Acme',
      notes: 'Prefers mornings.',
      level: 'close',
      level_source: 'principal',
      level_basis: 'Said Pat is a close friend.',
      level_set_at: NOW,
      identities: [{ handle: 'email:pat@example.test', source: 'principal', added_at: NOW }],
      remembered_names: ['Patty'],
      instructions: [],
      created_at: NOW,
      updated_at: NOW,
    };
    expect(person).toEqual(expected);
    expect(await getPerson(person.id)).toEqual(expected);
  });

  it("keeps the principal's address and name with a level that stays the assistant's judgment", async () => {
    const sam = await addPerson({
      name: 'Sam Lee',
      level: 'known',
      source: 'principal',
      levelSource: 'learned',
      basis: 'The principal gave their address; no meetings yet.',
      identity: 'sam@example.test',
      rememberedName: 'Sam',
    });

    expect(sam.level_source).toBe('learned');
    expect(sam.identities).toEqual([{ handle: 'email:sam@example.test', source: 'principal', added_at: NOW }]);
    expect(sam.remembered_names).toEqual(['Sam']);
    // Learning may revise a level that was its own judgment, up to active.
    expect(
      (await setPersonLevel({ id: sam.id, level: 'active', source: 'learned', basis: '3 one-on-ones.' })).level,
    ).toBe('active');
    // A learned add cannot claim the principal chose the level, and a judged level still stops at active.
    await expect(
      addPerson(pat({ name: 'Ann', identity: undefined, source: 'learned', levelSource: 'principal', level: 'known' })),
    ).rejects.toThrow(/only the principal/i);
    await expect(
      addPerson(pat({ name: 'Ann', identity: undefined, levelSource: 'learned', level: 'close' })),
    ).rejects.toThrow(/learned level stops at active/i);
  });

  it('stores an identity as a channel-qualified handle, qualifying a bare address and lowercasing email', async () => {
    const { id } = await addPerson(pat({ identity: 'Pat@Example.TEST' }));
    const updated = await updatePerson({ id, source: 'principal', addIdentity: 'gchat:users/1234' });

    expect(updated.identities.map((identity) => identity.handle)).toEqual([
      'email:pat@example.test',
      'gchat:users/1234',
    ]);
    for (const identity of ['email:not-an-address', 'pat', 'email:pat doe@example.test', ':pat', 'gchat:']) {
      await expect(addPerson(pat({ name: 'Other', identity })), identity).rejects.toThrow(/identity/i);
    }
  });

  it('refuses a learned level over one the principal set, and a learned inner circle or close', async () => {
    const { id } = await addPerson(pat());

    await expect(
      setPersonLevel({ id, level: 'known', source: 'learned', basis: 'Few meetings lately.' }),
    ).rejects.toThrow(/set by the principal/i);
    await expect(
      addPerson(
        pat({ name: 'Sam Lee', identity: 'email:sam@example.test', source: 'learned', identitySource: 'calendar' }),
      ),
    ).rejects.toThrow(/only the principal/i);

    const sam = await addPerson({
      name: 'Sam Lee',
      level: 'known',
      source: 'learned',
      basis: 'Two meetings this quarter.',
      identity: 'email:sam@example.test',
      identitySource: 'calendar',
    });
    await expect(
      setPersonLevel({ id: sam.id, level: 'close', source: 'learned', basis: 'Weekly one-on-ones.' }),
    ).rejects.toThrow(/only the principal/i);

    vi.setSystemTime(new Date(LATER));
    expect(
      await setPersonLevel({ id: sam.id, level: 'active', source: 'learned', basis: 'Weekly one-on-ones.' }),
    ).toMatchObject({
      level: 'active',
      level_source: 'learned',
      level_basis: 'Weekly one-on-ones.',
      level_set_at: LATER,
    });
    expect(
      await setPersonLevel({ id: sam.id, level: 'inner-circle', source: 'principal', basis: 'Sam is my brother.' }),
    ).toMatchObject({ level: 'inner-circle', level_source: 'principal', level_set_at: LATER });
    expect(await getPerson(id)).toMatchObject({ level: 'close', level_source: 'principal', level_set_at: NOW });
  });

  it("keeps standing instructions the principal's alone: a learned one is refused, and only the principal unsays one", async () => {
    const { id } = await addPerson(pat());

    await expect(addPersonInstruction({ id, text: 'Always accept Pat.', source: 'learned' })).rejects.toThrow(
      /only the principal/i,
    );
    const instruction = await addPersonInstruction({ id, text: 'Always make room for Pat.', source: 'principal' });
    expect(instruction).toEqual({
      id: expect.stringMatching(/^i-[0-9a-f]{12}$/),
      person_id: id,
      text: 'Always make room for Pat.',
      created_at: NOW,
    });
    expect((await getPerson(id))?.instructions).toEqual([
      { id: instruction.id, text: 'Always make room for Pat.', created_at: NOW },
    ]);

    await expect(removePersonInstruction({ id: instruction.id, source: 'learned' })).rejects.toThrow(
      /only the principal/i,
    );
    expect(await removePersonInstruction({ id: instruction.id, source: 'principal' })).toEqual({
      id: instruction.id,
      person_id: id,
    });
    expect((await getPerson(id))?.instructions).toEqual([]);
    await expect(removePersonInstruction({ id: instruction.id, source: 'principal' })).rejects.toThrow(
      /no instruction/i,
    );
  });

  it.each([
    ['a principal address', 'email:Morgan@Example.test', /principal's own/i],
    ['a Gmail spelling of a principal address', 'email:Morgan.Fixture+news@gmail.com', /principal's own/i],
    ['another Gmail spelling', 'm.o.r.g.a.n.fixture@googlemail.com', /principal's own/i],
    ["the principal's verified chat identity", 'gchat:users/principal', /principal's own/i],
    ["the assistant's address", 'email:Juno@example.test', /assistant's own/i],
    ["a plus-addressed form of the assistant's address", 'robin+calendar@example.test', /assistant's own/i],
  ])('refuses %s as a person identity', async (_case, identity, message) => {
    await expect(addPerson(pat({ identity }))).rejects.toThrow(message);
    const { id } = await addPerson(pat({ identity: undefined }));
    await expect(updatePerson({ id, source: 'principal', addIdentity: identity })).rejects.toThrow(message);
    expect(await rowCount('gws_ea_people_identities')).toBe(0);
  });

  it('holds each identity on one person and each remembered name for one person', async () => {
    const first = await addPerson(pat({ rememberedName: 'Patty' }));

    await expect(addPerson(pat({ name: 'Pat Two' }))).rejects.toThrow(
      new RegExp(`email:pat@example.test already belongs to Pat Doe \\(${first.id}\\)`),
    );
    await expect(
      addPerson(pat({ name: 'Pat Three', identity: 'email:pat3@example.test', rememberedName: 'patty' })),
    ).rejects.toThrow(/Patty already means Pat Doe/);
    expect(await listPeople()).toHaveLength(1);
  });

  it('updates the name, organization, notes, identities, and remembered names in one change', async () => {
    const { id } = await addPerson(pat({ organization: 'Acme', notes: 'Prefers mornings.', rememberedName: 'Patty' }));

    vi.setSystemTime(new Date(LATER));
    const updated = await updatePerson({
      id,
      source: 'principal',
      name: 'Patricia Doe',
      organization: '',
      notes: 'Prefers afternoons now.',
      addIdentity: 'email:patricia@example.test',
      removeIdentity: 'email:pat@example.test',
      addRememberedName: 'Trish',
      removeRememberedName: 'patty',
    });

    expect(updated).toMatchObject({
      name: 'Patricia Doe',
      organization: null,
      notes: 'Prefers afternoons now.',
      identities: [{ handle: 'email:patricia@example.test', source: 'principal', added_at: LATER }],
      remembered_names: ['Trish'],
      level_set_at: NOW,
      updated_at: LATER,
    });
    await expect(updatePerson({ id, source: 'principal' })).rejects.toThrow(/nothing to change/i);
    await expect(
      updatePerson({ id, source: 'principal', removeIdentity: 'email:nobody@example.test' }),
    ).rejects.toThrow(/does not hold/i);
    await expect(updatePerson({ id: 'p-000000000000', source: 'principal', notes: 'x' })).rejects.toThrow(/no person/i);
  });

  it('lets learning add what it found and keeps what the principal gave out of its reach', async () => {
    const { id } = await addPerson(pat({ rememberedName: 'Patty' }));

    expect(
      await updatePerson({
        id,
        source: 'learned',
        addIdentity: 'email:pat@work.example.test',
        identitySource: 'directory',
        organization: 'Acme',
      }),
    ).toMatchObject({
      organization: 'Acme',
      identities: [
        { handle: 'email:pat@example.test', source: 'principal' },
        { handle: 'email:pat@work.example.test', source: 'directory' },
      ],
    });

    await expect(
      updatePerson({ id, source: 'learned', addIdentity: 'email:pat@home.example.test' }),
      'a learned identity without where it came from',
    ).rejects.toThrow(/directory or calendar/i);
    await expect(
      updatePerson({ id, source: 'learned', addIdentity: 'email:pat@home.example.test', identitySource: 'principal' }),
    ).rejects.toThrow(/directory or calendar/i);
    await expect(updatePerson({ id, source: 'learned', removeIdentity: 'email:pat@example.test' })).rejects.toThrow(
      /given by the principal/i,
    );
    await expect(updatePerson({ id, source: 'learned', addRememberedName: 'P' })).rejects.toThrow(
      /only the principal/i,
    );
    await expect(updatePerson({ id, source: 'learned', removeRememberedName: 'Patty' })).rejects.toThrow(
      /only the principal/i,
    );
    expect(await updatePerson({ id, source: 'learned', removeIdentity: 'email:pat@work.example.test' })).toMatchObject({
      identities: [{ handle: 'email:pat@example.test' }],
    });
  });

  it('finds by identity, then exact remembered name, then exact name, then token prefix', async () => {
    const patDoe = await addPerson(pat({ organization: 'Acme' }));
    const samLee = await addPerson({
      name: 'Sam Lee',
      level: 'active',
      source: 'principal',
      basis: 'Weekly one-on-ones.',
      identity: 'email:sam.lee@acme.test',
      rememberedName: 'Pat',
    });
    const patSmith = await addPerson({
      name: 'Pat Smith',
      level: 'known',
      source: 'principal',
      basis: 'Met once.',
      identity: 'email:pat.smith@example.test',
    });
    const jose = await addPerson({ name: 'José Ángel Núñez', level: 'known', source: 'principal', basis: 'Met once.' });
    const summary = (person: typeof patDoe) => ({
      id: person.id,
      name: person.name,
      organization: person.organization,
      level: person.level,
      identities: person.identities.map((identity) => identity.handle),
    });

    expect(await findPeople('Sam.Lee@ACME.test')).toEqual({ matched_by: 'identity', people: [summary(samLee)] });
    expect(await findPeople('email:pat@example.test')).toEqual({ matched_by: 'identity', people: [summary(patDoe)] });
    expect(await findPeople('pat')).toEqual({ matched_by: 'remembered-name', people: [summary(samLee)] });
    expect(await findPeople('  PAT   doe ')).toEqual({ matched_by: 'name', people: [summary(patDoe)] });
    expect(await findPeople('pa s')).toEqual({ matched_by: 'name-prefix', people: [summary(patSmith)] });
    expect(await findPeople('jose nun')).toEqual({ matched_by: 'name-prefix', people: [summary(jose)] });
    expect(await findPeople('Pa')).toEqual({
      matched_by: 'name-prefix',
      people: [summary(patDoe), summary(patSmith), summary(samLee)],
    });
    expect(await findPeople('nobody@example.test')).toEqual({ matched_by: null, people: [] });
    expect(await findPeople('Quinn')).toEqual({ matched_by: null, people: [] });
    await expect(findPeople('   ')).rejects.toThrow(/query/i);
  });

  it('lists everyone by level, then name, or only one level', async () => {
    const known = await addPerson({ name: 'Ann Known', level: 'known', source: 'principal', basis: 'Met once.' });
    const close = await addPerson(pat());
    const inner = await addPerson({ name: 'Zed Inner', level: 'inner-circle', source: 'principal', basis: 'Family.' });
    const active = await addPerson({ name: 'Bo Active', level: 'active', source: 'principal', basis: 'Weekly.' });

    expect((await listPeople()).map((person) => person.id)).toEqual([inner.id, close.id, active.id, known.id]);
    expect(await listPeople('close')).toEqual([
      { id: close.id, name: 'Pat Doe', organization: null, level: 'close', identities: ['email:pat@example.test'] },
    ]);
    await expect(listPeople('unknown')).rejects.toThrow(/level/i);
  });

  it('returns only a level, or unknown, for an identity', async () => {
    await addPerson(pat({ notes: 'Private note.', rememberedName: 'Patty' }));
    await addPersonInstruction({
      id: (await findPeople('Pat Doe')).people[0].id,
      text: 'Always make room.',
      source: 'principal',
    });

    expect(await getPersonLevel('email:pat@example.test')).toBe('close');
    expect(await getPersonLevel('email:PAT@Example.test')).toBe('close');
    expect(await getPersonLevel('pat@example.test')).toBe('close');
    expect(await getPersonLevel('email:nobody@example.test')).toBe('unknown');
    expect(await getPersonLevel('gchat:users/pat')).toBe('unknown');
    expect(await getPersonLevel('not a handle')).toBe('unknown');
    expect(await getPersonLevel('')).toBe('unknown');
  });
});

describe('forgetting a person', () => {
  async function seedPat(): Promise<string> {
    const { id } = await addPerson(pat({ rememberedName: 'Patty', notes: 'Met at the conference.' }));
    await updatePerson({ id, source: 'principal', addIdentity: 'gchat:users/pat' });
    await addPersonInstruction({ id, text: 'Always make room for Pat.', source: 'principal' });
    for (const user of ['email:pat@example.test', 'gchat:users/pat', 'email:other@example.test'])
      await createUser(user);
    await createMessagingGroup({
      id: 'mg-pat-email',
      channel_type: 'email',
      platform_id: 'pat@example.test',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: NOW,
    });
    await getDb().run(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, 'email', ?, ?)`,
      'email:pat@example.test',
      'mg-pat-email',
      NOW,
    );
    for (const [userId, platformId] of [
      ['email:pat@example.test', 'pat@example.test'],
      ['email:other@example.test', 'other@example.test'],
    ]) {
      await recordDroppedMessage({
        channel_type: 'email',
        platform_id: platformId,
        user_id: userId,
        sender_name: null,
        reason: 'no_agent_wired',
        messaging_group_id: null,
        agent_group_id: null,
      });
    }
    return id;
  }

  it('deletes the record with its identities, names, and instructions, purges its email users and dropped messages, calls every hook, and keeps only keyed fingerprints (AE9)', async () => {
    const id = await seedPat();

    expect(await forgetPerson({ id, source: 'principal' })).toEqual({ forgotten: id, identities: 2 });

    for (const table of [
      'gws_ea_people',
      'gws_ea_people_identities',
      'gws_ea_people_names',
      'gws_ea_people_instructions',
    ]) {
      expect(await rowCount(table), table).toBe(0);
    }
    const users = (await getDb().all<{ id: string }>('SELECT id FROM users ORDER BY id')).map((user) => user.id);
    // The principal's own email identities stay: they are main's members, never a person's.
    expect(users).toEqual([
      'email:other@example.test',
      'email:morgan.fixture@gmail.com',
      'email:morgan@example.test',
      'gchat:users/pat',
      'gchat:users/principal',
    ]);
    expect((await getMembers(MAIN.id)).map((member) => member.user_id).sort()).toEqual([
      'email:morgan.fixture@gmail.com',
      'email:morgan@example.test',
    ]);
    expect(await getDb().all('SELECT user_id FROM unregistered_senders')).toEqual([
      { user_id: 'email:other@example.test' },
    ]);
    expect(await rowCount('user_dms')).toBe(0);

    const handles = ['email:pat@example.test', 'gchat:users/pat'];
    expect(hookCalls).toEqual([
      ['meetings', { id, handles }],
      ['sessions', { id, handles }],
    ]);

    const fingerprints = await getDb().all<{ fingerprint: string; forgotten_at: string }>(
      'SELECT fingerprint, forgotten_at FROM gws_ea_people_fingerprints ORDER BY fingerprint',
    );
    expect(fingerprints).toHaveLength(2);
    const unkeyed = handles.map((handle) => createHash('sha256').update(handle).digest('hex'));
    for (const { fingerprint, forgotten_at } of fingerprints) {
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(unkeyed).not.toContain(fingerprint);
      expect(forgotten_at).toBe(NOW);
    }
    expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(await getPersonLevel('email:pat@example.test')).toBe('unknown');
  });

  it('refuses to forget on anything but the principal’s word, or someone who is not there', async () => {
    const { id } = await addPerson(pat());

    await expect(forgetPerson({ id, source: 'learned' })).rejects.toThrow(/only the principal/i);
    await expect(forgetPerson({ id: 'p-000000000000', source: 'principal' })).rejects.toThrow(/no person/i);
    expect(await getPersonLevel('email:pat@example.test')).toBe('close');
    expect(hookCalls).toEqual([]);
  });

  it('keeps the record when a hook fails, so forgetting again finishes the job', async () => {
    const id = await seedPat();
    sessionsHookFailure = new Error('session store down');

    await expect(forgetPerson({ id, source: 'principal' })).rejects.toThrow(/session store down/);
    expect(await getPersonLevel('email:pat@example.test')).toBe('close');
    expect(await rowCount('gws_ea_people_identities')).toBe(2);
    expect(await rowCount('gws_ea_people_fingerprints')).toBe(0);

    await forgetPerson({ id, source: 'principal' });
    expect(hookCalls.map(([hook]) => hook)).toEqual(['meetings', 'sessions', 'meetings', 'sessions']);
    expect(await getPersonLevel('email:pat@example.test')).toBe('unknown');
  });

  it('refuses to forget someone whose email identity holds a NanoClaw role or membership, changing nothing', async () => {
    const { id } = await addPerson(pat());
    await createUser('email:pat@example.test');
    await getDb().run(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
      'email:pat@example.test',
      MAIN.id,
      NOW,
    );

    await expect(forgetPerson({ id, source: 'principal' })).rejects.toThrow(/email:pat@example.test.*access/i);
    expect(await getPersonLevel('email:pat@example.test')).toBe('close');
    expect(hookCalls).toEqual([]);
  });

  it('refuses a learned add of a forgotten identity in any spelling; the principal adding it back clears the fingerprint', async () => {
    const { id } = await addPerson(pat({ identity: 'email:pat.doe@gmail.com' }));
    await forgetPerson({ id, source: 'principal' });

    const learned = {
      name: 'Pat Doe',
      level: 'known',
      source: 'learned',
      basis: '6 months to 2 Oct: 3 meetings.',
      identitySource: 'calendar',
    } as const;
    for (const identity of ['email:pat.doe@gmail.com', 'PatDoe+invites@gmail.com', 'p.a.t.doe@googlemail.com']) {
      await expect(addPerson({ ...learned, identity }), identity).rejects.toThrow(/forgotten/i);
    }
    const other = await addPerson({ ...learned, name: 'Someone Else', identity: 'email:else@example.test' });
    await expect(
      updatePerson({
        id: other.id,
        source: 'learned',
        addIdentity: 'email:patdoe@gmail.com',
        identitySource: 'calendar',
      }),
    ).rejects.toThrow(/forgotten/i);

    const back = await addPerson(pat({ identity: 'email:pat.doe@gmail.com' }));
    expect(back.identities).toMatchObject([{ handle: 'email:pat.doe@gmail.com', source: 'principal' }]);
    expect(await rowCount('gws_ea_people_fingerprints')).toBe(0);
    expect(await getPersonLevel('email:pat.doe@gmail.com')).toBe('close');
  });

  it('lets the principal re-add a forgotten identity to an existing person, clearing its fingerprint', async () => {
    const { id } = await addPerson(pat());
    await forgetPerson({ id, source: 'principal' });
    const sam = await addPerson({ name: 'Sam Lee', level: 'active', source: 'principal', basis: 'Weekly.' });

    await updatePerson({ id: sam.id, source: 'principal', addIdentity: 'email:Pat+old@example.test' });
    expect(await rowCount('gws_ea_people_fingerprints')).toBe(0);
  });

  it('creates no key until the first forget, and a key it finds is never replaced', async () => {
    await addPerson(pat());
    expect(fs.existsSync(keyFile())).toBe(false);

    const first = await addPerson({
      name: 'Sam Lee',
      level: 'known',
      source: 'principal',
      basis: 'Met once.',
      identity: 'email:sam@example.test',
    });
    await forgetPerson({ id: first.id, source: 'principal' });
    const key = fs.readFileSync(keyFile(), 'utf8');

    await forgetPerson({ id: (await findPeople('Pat Doe')).people[0].id, source: 'principal' });
    expect(fs.readFileSync(keyFile(), 'utf8')).toBe(key);
  });

  it('stops instead of issuing a new key when the key is missing and fingerprints are present', async () => {
    const { id } = await addPerson(pat());
    await forgetPerson({ id, source: 'principal' });
    fs.rmSync(keyFile());

    await expect(assertPeopleStoreRunning()).rejects.toThrow(/stopped/i);
    await expect(addPerson(pat({ identity: 'email:sam@example.test', name: 'Sam Lee' }))).rejects.toThrow(/stopped/i);
    const named = await getDb().run(
      `INSERT INTO gws_ea_people (id, name, name_key, level, level_source, level_basis, level_set_at, created_at, updated_at)
       VALUES ('p-000000000009', 'Quinn', 'quinn', 'known', 'principal', 'Met once.', ?, ?, ?)`,
      NOW,
      NOW,
      NOW,
    );
    expect(named.changes).toBe(1);
    await expect(forgetPerson({ id: 'p-000000000009', source: 'principal' })).rejects.toThrow(/stopped/i);
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it('refuses a key that is not owner-only', async () => {
    const { id } = await addPerson(pat());
    await forgetPerson({ id, source: 'principal' });
    fs.chmodSync(keyFile(), 0o644);

    await expect(assertPeopleStoreRunning()).rejects.toThrow(/0600/);
  });

  it('refuses to forget where the instance has no secrets directory to keep a key in', async () => {
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, '');
    const { id } = await addPerson(pat());

    await expect(forgetPerson({ id, source: 'principal' })).rejects.toThrow(/secrets directory/i);
    expect(await getPersonLevel('email:pat@example.test')).toBe('close');
  });

  it('still refuses a forgotten identity after a host restart and after a restore of the instance', async () => {
    const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-people-instance-'));
    const databaseFile = path.join(instanceDir, 'v2.db');
    const learned = {
      name: 'Pat Doe',
      level: 'known',
      source: 'learned',
      basis: 'On an invitation.',
      identity: 'email:pat@example.test',
      identitySource: 'calendar',
    } as const;
    try {
      await closeDb();
      await runMigrations(await initDb(databaseFile, { role: 'test' }));
      await setUpInstance();
      const { id } = await addPerson(pat());
      await forgetPerson({ id, source: 'principal' });
      await closeDb();

      await runMigrations(await initDb(databaseFile, { role: 'test' }));
      await expect(addPerson(learned), 'after a restart').rejects.toThrow(/forgotten/i);
      await closeDb();

      const restoredDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-people-restored-'));
      fs.chmodSync(restoredDir, 0o700);
      const restoredDatabase = path.join(restoredDir, 'v2.db');
      fs.copyFileSync(databaseFile, restoredDatabase);
      fs.copyFileSync(keyFile(), keyFile(restoredDir));
      fs.chmodSync(keyFile(restoredDir), 0o600);
      vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(restoredDir, 'google-grant.json'));
      try {
        await runMigrations(await initDb(restoredDatabase, { role: 'test' }));
        await expect(addPerson(learned), 'after a restore').rejects.toThrow(/forgotten/i);
      } finally {
        await closeDb();
        fs.rmSync(restoredDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(instanceDir, { recursive: true, force: true });
      await initTestDb();
    }
  });
});

describe('identity fingerprints', () => {
  const KEY_A = Buffer.alloc(32, 1);
  const KEY_B = Buffer.alloc(32, 2);

  it('normalizes case, Gmail dots, and plus-addressing before a keyed hash', () => {
    const canonical = identityFingerprint(KEY_A, 'email:samlee@gmail.com');
    for (const spelling of [
      'email:Sam.Lee@Gmail.com',
      'email:samlee+news@gmail.com',
      'email:s.a.m.lee@googlemail.com',
    ]) {
      expect(identityFingerprint(KEY_A, spelling), spelling).toBe(canonical);
    }
    expect(identityFingerprint(KEY_A, 'email:sam+x@acme.test')).toBe(identityFingerprint(KEY_A, 'email:sam@acme.test'));
    expect(identityFingerprint(KEY_A, 'email:sam.lee@acme.test')).not.toBe(
      identityFingerprint(KEY_A, 'email:samlee@acme.test'),
    );
    expect(identityFingerprint(KEY_B, 'email:samlee@gmail.com')).not.toBe(canonical);
    expect(canonical).not.toBe(createHash('sha256').update('email:samlee@gmail.com').digest('hex'));
    expect(canonical).toMatch(/^[0-9a-f]{64}$/);
  });
});
