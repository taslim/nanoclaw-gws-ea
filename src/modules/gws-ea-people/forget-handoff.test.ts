/**
 * A forget survives a snapshot rollback (R5, KTD8). gws-ea hands over the
 * fingerprints the restored database lacks; the host records them, forgets
 * again whoever holds one, tells main, and deletes the handoff, all before
 * any inbound event routes.
 *
 * Drives the people store, the forget hooks, the router and main's session
 * against a real central DB and real session DBs. Only the wake is mocked.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-people-forget-handoff';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-people-forget-handoff/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-people-forget-handoff/groups',
  };
});

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import type { InboundEvent } from '../../channels/adapter.js';
import { DATA_DIR } from '../../config.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { startHostModules } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { requestWake } from '../../request-wake.js';
import { registerMessageInterceptor, routeInbound } from '../../router.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import { addPerson, getPerson, registerPersonForgetHook, updatePerson, type ForgottenPerson } from './db.js';
import { createFingerprintKey, FINGERPRINT_KEY_FILE_NAME, identityFingerprint } from './fingerprint.js';
import {
  peopleForgetHandoffFile,
  readPeopleForgetHandoff,
  writePeopleForgetHandoff,
  type ForgottenFingerprint,
  type PeopleForgetHandoff,
} from './forget-handoff.js';
import { sweepForgetHandoff } from './forget-sweep.js';
import './index.js';

const NOW = '2026-10-09T09:00:00.000Z';
/** When the replaced state forgot someone: after the snapshot the rollback restored. */
const FORGOTTEN_AT = '2026-10-08T14:30:00.000Z';
const PRINCIPAL_USER = 'gchat:users/principal';
const SECRETS_DIR = path.join(TEST_DIR, 'secrets');
const HANDOFF = peopleForgetHandoffFile(DATA_DIR);

/** Each person the forget hook was called for, in call order. */
const forgotten: ForgottenPerson[] = [];
/** What the handoff held as each of those forgets began. */
const handoffsAtForget: Array<PeopleForgetHandoff | undefined> = [];
/** While set, the forget hook waits on it: a sweep held mid-forget. */
let holdForget: Promise<void> | undefined;
registerPersonForgetHook('test-purge:forget-again', async (person) => {
  forgotten.push(person);
  handoffsAtForget.push(await readPeopleForgetHandoff(HANDOFF));
  if (holdForget) await holdForget;
});

let key: Buffer;

async function keep(name: string, identities: readonly [string, ...string[]]): Promise<string> {
  const [first, ...more] = identities;
  const { id } = await addPerson({ name, level: 'close', source: 'principal', basis: 'Said so.', identity: first });
  for (const identity of more) await updatePerson({ id, source: 'principal', addIdentity: identity });
  for (const handle of identities) {
    await upsertUser({ id: handle, kind: handle.slice(0, handle.indexOf(':')), display_name: null, created_at: NOW });
  }
  return id;
}

/** The rows the replaced state's forget of `handles` wrote. */
function forgottenIn(handles: readonly string[]): ForgottenFingerprint[] {
  return handles.map((handle) => ({ fingerprint: identityFingerprint(key, handle), forgotten_at: FORGOTTEN_AT }));
}

async function recordedFingerprints(): Promise<ForgottenFingerprint[]> {
  return getDb().all<ForgottenFingerprint>(
    'SELECT fingerprint, forgotten_at FROM gws_ea_people_fingerprints ORDER BY fingerprint',
  );
}

async function userIds(): Promise<string[]> {
  return (await getDb().all<{ id: string }>('SELECT id FROM users ORDER BY id')).map((user) => user.id);
}

/** What the host wrote in main's sessions, oldest first. */
async function notesForMain(): Promise<Array<{ id: string; text: string }>> {
  const notes: Array<{ id: string; text: string }> = [];
  for (const session of await getSessionsByAgentGroup('ag-main')) {
    const inbound = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
    try {
      const rows = inbound.prepare('SELECT id, content FROM messages_in ORDER BY seq').all() as Array<{
        id: string;
        content: string;
      }>;
      for (const row of rows) {
        const content = JSON.parse(row.content) as { text: string; sender: string };
        if (content.sender === 'system') notes.push({ id: row.id, text: content.text });
      }
    } finally {
      inbound.close();
    }
  }
  return notes;
}

function learned(identity: string) {
  return {
    name: 'Someone',
    level: 'known',
    source: 'learned',
    basis: 'On an invitation.',
    identity,
    identitySource: 'calendar',
  } as const;
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, 'gws-ea'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(SECRETS_DIR, { mode: 0o700 });
  vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(SECRETS_DIR, 'google-grant.json'));
  forgotten.length = 0;
  handoffsAtForget.length = 0;
  holdForget = undefined;
  vi.mocked(requestWake).mockClear();

  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-main', name: 'main', folder: 'main', agent_provider: null, created_at: NOW });
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Juno',
    assistantWorkspaceEmail: 'juno@example.test',
    principalDisplayName: 'Morgan',
    principalTimezone: 'Africa/Lagos',
    mainAgentGroupId: 'ag-main',
    principalEmails: ['morgan@example.test'],
  });
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: 'gchat',
    platform_id: 'spaces/dm',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  });
  await upsertUser({ id: PRINCIPAL_USER, kind: 'gchat', display_name: 'Morgan', created_at: NOW });
  await bindVerifiedPrincipalUser(PRINCIPAL_USER, NOW);
  await upsertUserDm({ user_id: PRINCIPAL_USER, channel_type: 'gchat', messaging_group_id: 'mg-dm', resolved_at: NOW });
  // The instance's key, which the replaced state's forget created; it lives outside the restored state.
  key = await createFingerprintKey(path.join(SECRETS_DIR, FINGERPRINT_KEY_FILE_NAME));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('the forget handoff gws-ea writes', () => {
  it('sits in the data directory and is written owner-only, exactly as the host reads it', async () => {
    expect(peopleForgetHandoffFile('/srv/instance/state/data')).toBe(
      '/srv/instance/state/data/gws-ea/people-forget-handoff.json',
    );
    const handoff = { fingerprints: forgottenIn(['email:noel@example.test']) };

    await writePeopleForgetHandoff(HANDOFF, handoff);

    expect(fs.statSync(HANDOFF).mode & 0o777).toBe(0o600);
    expect(await readPeopleForgetHandoff(HANDOFF)).toEqual(handoff);
    await expect(
      writePeopleForgetHandoff(HANDOFF, {
        fingerprints: [{ fingerprint: 'email:noel@example.test', forgotten_at: NOW }],
      }),
    ).rejects.toThrow(/fingerprint/);
    expect(await readPeopleForgetHandoff(HANDOFF)).toEqual(handoff);
  });
});

describe('forgetting again after a snapshot restore', () => {
  it('forgets again a person forgotten after the snapshot, hooks and all, and tells main once to clear them from its memory', async () => {
    const handles = ['email:noel@example.test', 'gchat:users/noel'] as const;
    const noel = await keep('Noel Archer', handles);
    await writePeopleForgetHandoff(HANDOFF, { fingerprints: forgottenIn(handles) });

    await sweepForgetHandoff(HANDOFF);

    expect(await getPerson(noel)).toBeUndefined();
    expect(await getDb().get('SELECT 1 AS held FROM gws_ea_people_identities')).toBeUndefined();
    expect(await userIds()).not.toContain('email:noel@example.test');
    expect(forgotten).toEqual([{ id: noel, handles: [...handles] }]);
    // Their name was kept before the forget began, so a host stopped mid-forget still tells main.
    expect(handoffsAtForget).toEqual([{ fingerprints: forgottenIn(handles), pending_note: ['Noel Archer'] }]);
    // The forget's own time is kept: the restore did not make it a new forget.
    expect(await recordedFingerprints()).toEqual(
      forgottenIn(handles).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    );
    const notes = await notesForMain();
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('Noel Archer');
    expect(notes[0].text).toContain('`memory/people/`');
    expect(vi.mocked(requestWake)).toHaveBeenCalledOnce();
    expect(fs.existsSync(HANDOFF)).toBe(false);
    await expect(addPerson(learned('email:noel@example.test'))).rejects.toThrow(/forgotten/i);
  });

  it('keeps a person the principal added back after their forget: the handoff holds no fingerprint of theirs', async () => {
    const noel = await keep('Noel Archer', ['email:noel@example.test']);
    const before = await getPerson(noel);
    const lena = await keep('Lena Ford', ['email:lena@example.test']);
    await writePeopleForgetHandoff(HANDOFF, { fingerprints: forgottenIn(['email:lena@example.test']) });

    await sweepForgetHandoff(HANDOFF);

    expect(await getPerson(noel)).toEqual(before);
    expect(await getPerson(lena)).toBeUndefined();
    const notes = await notesForMain();
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('Lena Ford');
    expect(notes[0].text).not.toContain('Noel Archer');
  });

  it('logs and skips a person it cannot forget, whose fingerprint still refuses learning', async () => {
    const remy = await keep('Remy Vance', ['email:remy@example.test']);
    await getDb().run(
      'INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)',
      'email:remy@example.test',
      'ag-main',
      NOW,
    );
    const before = await getPerson(remy);
    const lena = await keep('Lena Ford', ['email:lena@example.test']);
    await writePeopleForgetHandoff(HANDOFF, {
      fingerprints: forgottenIn(['email:remy@example.test', 'email:lena@example.test']),
    });
    const warn = vi.spyOn(log, 'warn');

    await sweepForgetHandoff(HANDOFF);

    expect(await getPerson(remy)).toEqual(before);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be forgotten again/i), {
      personId: remy,
      err: expect.objectContaining({ message: expect.stringMatching(/email:remy@example.test.*access/i) }),
    });
    expect(await getPerson(lena)).toBeUndefined();
    await expect(addPerson(learned('email:remy@example.test'))).rejects.toThrow(/forgotten/i);
    await expect(addPerson(learned('email:Remy+news@example.test'))).rejects.toThrow(/forgotten/i);
    const notes = await notesForMain();
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('Lena Ford');
    expect(notes[0].text).not.toContain('Remy Vance');
    expect(fs.existsSync(HANDOFF)).toBe(false);
  });

  it('does nothing without a handoff, or with one that hands over nothing', async () => {
    const noel = await keep('Noel Archer', ['email:noel@example.test']);
    const before = await getPerson(noel);

    await sweepForgetHandoff(HANDOFF);
    await writePeopleForgetHandoff(HANDOFF, { fingerprints: [] });
    await sweepForgetHandoff(HANDOFF);

    expect(await getPerson(noel)).toEqual(before);
    expect(await recordedFingerprints()).toEqual([]);
    expect(forgotten).toEqual([]);
    expect(await notesForMain()).toEqual([]);
  });

  it('tells main on restart when the host stopped after forgetting and before the note, and only once when it stopped after the note', async () => {
    // The host stopped after recording the fingerprints and forgetting Noel Archer, before telling main.
    const fingerprints = forgottenIn(['email:noel@example.test']);
    for (const row of fingerprints) {
      await getDb().run(
        'INSERT INTO gws_ea_people_fingerprints (fingerprint, forgotten_at) VALUES (?, ?)',
        row.fingerprint,
        row.forgotten_at,
      );
    }
    const stopped = { fingerprints, pending_note: ['Noel Archer'] };
    await writePeopleForgetHandoff(HANDOFF, stopped);

    await sweepForgetHandoff(HANDOFF);

    const notes = await notesForMain();
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain('Noel Archer');
    expect(forgotten).toEqual([]);
    expect(fs.existsSync(HANDOFF)).toBe(false);

    // Stopped after the note and before deleting the handoff: the note is not written twice.
    await writePeopleForgetHandoff(HANDOFF, stopped);
    await sweepForgetHandoff(HANDOFF);

    expect(await notesForMain()).toEqual(notes);
    expect(fs.existsSync(HANDOFF)).toBe(false);
  });

  it('leaves a malformed or unsafe handoff in place and applies none of it', async () => {
    const noel = await keep('Noel Archer', ['email:noel@example.test']);
    const before = await getPerson(noel);
    const [row] = forgottenIn(['email:noel@example.test']);
    const error = vi.spyOn(log, 'error');
    const malformed: ReadonlyArray<readonly [string, string, number?]> = [
      ['not JSON', '{"fingerprints": ['],
      ['no fingerprints', '{}'],
      [
        'one bad row among good ones',
        JSON.stringify({ fingerprints: [row, { fingerprint: 'abc', forgotten_at: NOW }] }),
      ],
      [
        'an uppercase fingerprint',
        JSON.stringify({ fingerprints: [{ ...row, fingerprint: row.fingerprint.toUpperCase() }] }),
      ],
      ['a local timestamp', JSON.stringify({ fingerprints: [{ ...row, forgotten_at: '2026-10-08 14:30:00' }] })],
      ['a note that is not a list', JSON.stringify({ fingerprints: [row], pending_note: 'Noel Archer' })],
      ['a blank name', JSON.stringify({ fingerprints: [row], pending_note: [''] })],
      ['readable by others', JSON.stringify({ fingerprints: [row] }), 0o644],
    ];

    for (const [what, contents, mode = 0o600] of malformed) {
      fs.writeFileSync(HANDOFF, contents);
      fs.chmodSync(HANDOFF, mode);
      error.mockClear();

      await sweepForgetHandoff(HANDOFF);

      expect(fs.readFileSync(HANDOFF, 'utf8'), what).toBe(contents);
      expect(error, what).toHaveBeenCalledOnce();
      expect(await recordedFingerprints(), what).toEqual([]);
    }
    expect(await getPerson(noel)).toEqual(before);
    expect(forgotten).toEqual([]);
    expect(await notesForMain()).toEqual([]);
  });
});

describe('before routing', () => {
  function event(id: string): InboundEvent {
    return {
      channelType: 'gchat',
      platformId: 'spaces/dm',
      threadId: null,
      message: { id, kind: 'chat', content: JSON.stringify({ text: 'Hello' }), timestamp: NOW },
    };
  }

  it('holds every inbound event until the sweep has finished, then declines it', async () => {
    const noel = await keep('Noel Archer', ['email:noel@example.test']);
    await writePeopleForgetHandoff(HANDOFF, { fingerprints: forgottenIn(['email:noel@example.test']) });
    let release!: () => void;
    holdForget = new Promise((resolve) => {
      release = resolve;
    });
    // Registered last, so it sees what the people module let through, and as it was then.
    const routed: Array<{ id: string; noelBack: boolean; handoffLeft: boolean }> = [];
    registerMessageInterceptor(async (inbound) => {
      routed.push({
        id: inbound.message.id,
        noelBack: (await getPerson(noel)) !== undefined,
        handoffLeft: fs.existsSync(HANDOFF),
      });
      return true;
    });

    // An event that arrives before host modules start: routing opens first.
    const first = routeInbound(event('m-before-start'));
    await vi.waitFor(() => expect(routed.length + forgotten.length).toBeGreaterThan(0));
    expect(routed).toEqual([]);
    expect(forgotten).toHaveLength(1);

    const hostStart = startHostModules({
      db: getDb(),
      deliveryAdapter: { deliver: async () => undefined },
      signal: new AbortController().signal,
    });
    const second = routeInbound(event('m-during-sweep'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(routed).toEqual([]);

    release();
    await Promise.all([first, second, hostStart]);

    expect([...routed].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'm-before-start', noelBack: false, handoffLeft: false },
      { id: 'm-during-sweep', noelBack: false, handoffLeft: false },
    ]);
    // Host start waited on the same sweep instead of running another.
    expect(forgotten).toHaveLength(1);
    expect(await notesForMain()).toHaveLength(1);
  });
});
