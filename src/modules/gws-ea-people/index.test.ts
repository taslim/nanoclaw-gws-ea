import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-gws-ea-people-ncl' };
});

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { lookup } from '../../cli/registry.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import type { AgentGroup } from '../../types.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { answering, fromPrincipal, principalDmSession } from '../gws-ea-profile/testing/principal-turn.js';
import { addPerson, addPersonInstruction, getPerson, getPersonLevel, listPeople, type Person } from './db.js';
import { FINGERPRINT_KEY_FILE_NAME } from './fingerprint.js';
import { MAIN_PEOPLE_POINTER } from './index.js';

const VERBS = ['find', 'get', 'list', 'add', 'update', 'set-level', 'instruct', 'unsay', 'forget'] as const;

function group(id: string, name: string): AgentGroup {
  return { id, name, folder: id, agent_provider: null, created_at: '2026-10-02T00:00:00.000Z' };
}

const main = group('ag-main', 'main');
const other = group('ag-other', 'external-email');

function agent(agentGroupId: string): CallerContext {
  return { caller: 'agent', sessionId: `sess-${agentGroupId}`, agentGroupId, messagingGroupId: 'mg-dm' };
}

const HOST: CallerContext = { caller: 'host' };
const DATA_DIR = '/tmp/nanoclaw-test-gws-ea-people-ncl';
/** main, in a turn answering the principal's message, so its principal-sourced writes count. */
let mainCaller: CallerContext;

function run(command: string, args: Record<string, unknown>, ctx: CallerContext = mainCaller) {
  return dispatch({ id: command, command, args }, ctx);
}

async function data<T>(response: Promise<{ ok: boolean; data?: unknown; error?: unknown }>): Promise<T> {
  const settled = await response;
  if (!settled.ok) throw new Error(`Command failed: ${JSON.stringify(settled.error)}`);
  return settled.data as T;
}

let root: string;

beforeEach(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-people-ncl-'));
  fs.chmodSync(root, 0o700);
  vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(root, 'google-grant.json'));
  await runMigrations(await initTestDb());
  for (const candidate of [main, other]) {
    await createAgentGroup(candidate);
    await ensureContainerConfig(candidate.id);
    await updateContainerConfigScalars(candidate.id, { cli_scope: 'global' });
  }
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Juno',
    assistantWorkspaceEmail: 'juno@example.test',
    principalDisplayName: 'Morgan',
    principalTimezone: 'Africa/Lagos',
    mainAgentGroupId: main.id,
    principalEmails: ['morgan@example.test'],
  });
  mainCaller = await answering(await principalDmSession(main.id), fromPrincipal('m-principal'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('GWS-EA people ncl resource', () => {
  it('registers no generic people-create or people-delete, so every write goes through its own verb', () => {
    for (const generic of ['create', 'delete']) expect(lookup(`people-${generic}`), generic).toBeUndefined();
  });

  it('lets main keep a person through ncl, from add to forget', async () => {
    const added = await data<Person>(
      run('people-add', {
        name: 'Pat Doe',
        level: 'close',
        source: 'principal',
        basis: 'Said Pat is a close friend.',
        organization: 'Acme',
        identity: 'pat@example.test',
        'remembered-name': 'Patty',
      }),
    );
    expect(added).toMatchObject({
      name: 'Pat Doe',
      level: 'close',
      level_source: 'principal',
      identities: [{ handle: 'email:pat@example.test', source: 'principal' }],
      remembered_names: ['Patty'],
    });

    expect(await data(run('people-find', { query: 'patty' }))).toEqual({
      matched_by: 'remembered-name',
      people: [
        { id: added.id, name: 'Pat Doe', organization: 'Acme', level: 'close', identities: ['email:pat@example.test'] },
      ],
    });
    // `ncl people find <query>` and `ncl people get <id>` arrive dash-joined with the argument as the tail.
    expect(await data(run('people-find-Pat Doe', {}))).toMatchObject({ matched_by: 'name' });
    expect(await data(run(`people-get-${added.id}`, {}))).toEqual(await getPerson(added.id));
    expect(await data(run('people-list', { level: 'close' }))).toEqual(await listPeople('close'));

    expect(
      await data(
        run('people-update', {
          id: added.id,
          source: 'learned',
          'add-identity': 'email:pat@work.example.test',
          'identity-source': 'directory',
          notes: 'Runs the Lagos office.',
        }),
      ),
    ).toMatchObject({ notes: 'Runs the Lagos office.', identities: [{}, { source: 'directory' }] });
    expect(
      await data(
        run('people-update', {
          id: added.id,
          source: 'principal',
          'remove-remembered-name': 'Patty',
          'add-remembered-name': 'Trish',
        }),
      ),
    ).toMatchObject({ remembered_names: ['Trish'] });
    expect(
      await data(
        run('people-set-level', { id: added.id, level: 'inner-circle', source: 'principal', basis: 'Pat is family.' }),
      ),
    ).toMatchObject({ level: 'inner-circle', level_basis: 'Pat is family.' });

    const instruction = await data<{ id: string }>(
      run('people-instruct', { id: added.id, text: 'Always make room for Pat.', source: 'principal' }),
    );
    expect((await getPerson(added.id))?.instructions).toMatchObject([{ text: 'Always make room for Pat.' }]);
    expect(await data(run(`people-unsay-${instruction.id}`, { source: 'principal' }))).toEqual({
      id: instruction.id,
      person_id: added.id,
    });

    expect(await data(run('people-forget', { id: added.id, source: 'principal' }))).toEqual({
      forgotten: added.id,
      identities: 2,
    });
    expect(await getPersonLevel('email:pat@example.test')).toBe('unknown');
    expect(await run('people-get', { id: added.id })).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/no person/i) },
    });
  });

  it('refuses a learned level over the principal’s, a learned instruction, and a learned forget', async () => {
    const pat = await addPerson({
      name: 'Pat Doe',
      level: 'close',
      source: 'principal',
      basis: 'Said so.',
      identity: 'email:pat@example.test',
    });

    for (const [command, args, message] of [
      [
        'people-set-level',
        { id: pat.id, level: 'known', source: 'learned', basis: 'Quiet month.' },
        /set by the principal/i,
      ],
      ['people-instruct', { id: pat.id, text: 'Decline Pat.', source: 'learned' }, /only the principal/i],
      ['people-forget', { id: pat.id, source: 'learned' }, /only the principal/i],
      ['people-add', { name: 'Sam', level: 'close', source: 'learned', basis: 'Weekly.' }, /only the principal/i],
      ['people-add', { name: 'Sam', level: 'friend', source: 'principal', basis: 'b' }, /--level must be one of/],
      ['people-add', { name: 'Sam', level: 'known', basis: 'b' }, /--source is required/],
    ] as const) {
      expect(await run(command, args), command).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(message) },
      });
    }
    expect(await getPerson(pat.id)).toMatchObject({ level: 'close', instructions: [] });
  });

  it('refuses every agent but main every verb, even with global CLI scope, and group-scoped agents at the guard', async () => {
    const pat = await addPerson({ name: 'Pat Doe', level: 'close', source: 'principal', basis: 'Said so.' });
    const instruction = await addPersonInstruction({ id: pat.id, text: 'Always make room.', source: 'principal' });
    const attempts: ReadonlyArray<readonly [(typeof VERBS)[number], Record<string, unknown>]> = [
      ['find', { query: 'Pat' }],
      ['get', { id: pat.id }],
      ['list', {}],
      ['add', { name: 'Sam', level: 'known', source: 'learned', basis: 'b' }],
      ['update', { id: pat.id, source: 'learned', notes: 'x' }],
      ['set-level', { id: pat.id, level: 'known', source: 'principal', basis: 'b' }],
      ['instruct', { id: pat.id, text: 'Decline.', source: 'principal' }],
      ['unsay', { id: instruction.id, source: 'principal' }],
      ['forget', { id: pat.id, source: 'principal' }],
    ];
    expect(attempts.map(([verb]) => verb)).toEqual([...VERBS]);

    for (const [verb, args] of attempts) {
      expect(await run(`people-${verb}`, args, agent(other.id)), verb).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/only to main/i) },
      });
    }
    await updateContainerConfigScalars(other.id, { cli_scope: 'group' });
    for (const [verb, args] of attempts) {
      expect(await run(`people-${verb}`, args, agent(other.id)), verb).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    }
    expect(await listPeople()).toHaveLength(1);
    expect(await getPerson(pat.id)).toMatchObject({ level: 'close', notes: null, instructions: [{}] });
  });

  it('lets the operator use the same verbs as the host caller', async () => {
    expect(
      await run('people-add', { name: 'Sam Lee', level: 'active', source: 'principal', basis: 'Weekly.' }, HOST),
    ).toMatchObject({ ok: true, data: { name: 'Sam Lee' } });
    expect(await run('people-list', {}, HOST)).toMatchObject({ ok: true, data: [{ name: 'Sam Lee' }] });
  });

  it('refuses every verb while the store is stopped for want of its key', async () => {
    const pat = await addPerson({
      name: 'Pat Doe',
      level: 'close',
      source: 'principal',
      basis: 'Said so.',
      identity: 'email:pat@example.test',
    });
    const sam = await addPerson({ name: 'Sam Lee', level: 'active', source: 'principal', basis: 'Weekly.' });
    expect(await run('people-forget', { id: pat.id, source: 'principal' })).toMatchObject({ ok: true });
    fs.rmSync(path.join(root, FINGERPRINT_KEY_FILE_NAME));

    for (const [verb, args] of [
      ['find', { query: 'Sam' }],
      ['get', { id: sam.id }],
      ['list', {}],
      ['add', { name: 'Quinn', level: 'known', source: 'principal', basis: 'b' }],
      ['set-level', { id: sam.id, level: 'known', source: 'principal', basis: 'b' }],
      ['forget', { id: sam.id, source: 'principal' }],
    ] as const) {
      expect(await run(`people-${verb}`, args), verb).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/stopped/i) },
      });
    }
    expect(fs.existsSync(path.join(root, FINGERPRINT_KEY_FILE_NAME))).toBe(false);
  });
});

describe('GWS-EA people project-doc section', () => {
  it('points main at the live store and copies no record into any document', async () => {
    const pat = await addPerson({
      name: 'Pat Doe',
      level: 'close',
      source: 'principal',
      basis: 'Said Pat is a close friend.',
      organization: 'Acme',
      notes: 'Allergic to shellfish.',
      identity: 'email:pat@example.test',
      rememberedName: 'Patty',
    });
    await addPersonInstruction({ id: pat.id, text: 'Always make room for Pat.', source: 'principal' });

    const pointer = { name: 'People', body: MAIN_PEOPLE_POINTER };
    expect(await getRequiredProjectDocSections(main)).toContainEqual(pointer);
    expect(MAIN_PEOPLE_POINTER).toContain('`ncl people find`');
    expect((await getRequiredProjectDocSections(other)).map((section) => section.name)).not.toContain('People');

    for (const candidate of [main, other]) {
      const groupDir = path.join(root, candidate.folder);
      await composeGroupProjectDoc(candidate, groupDir, { fileName: 'CLAUDE.md' });
      const document = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
      for (const secret of ['Pat Doe', 'Patty', 'pat@example.test', 'shellfish', 'Always make room', 'Acme']) {
        expect(document, `${candidate.name}: ${secret}`).not.toContain(secret);
      }
      expect(document.includes('# People'), candidate.name).toBe(candidate === main);
    }
  });
});
