/**
 * The home folder (R2, AE1, KTD3): one folder in the assistant's Drive,
 * shared with every one of the principal's addresses, kept by a host tick
 * that heals what changed and leaves alone what people chose. Runs against
 * the real central DB and an in-memory Drive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { GOOGLE_SIGN_IN_SCOPES, type GoogleGrant } from '../gws-ea-google/grant.js';
import { GoogleGrantRevokedError, GoogleScopeNotGrantedError } from '../gws-ea-google/tokens.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { addPrincipalAddress, reconcileGwsEaProfile, removePrincipalAddress } from '../gws-ea-profile/db.js';
import type { NoteForMain } from '../gws-ea-profile/main-note.js';
import { FOLDER_MIME_TYPE } from './drive-api.js';
import { createHomeFolder, type HomeFolder } from './home-folder.js';
import { FakeDrive } from './testing/fake-drive.js';
import '../index.js';

const AT = '2026-10-09T09:00:00.000Z';
const ASSISTANT = 'juno@northwind.example';
const GMAIL = 'morgan.fixture@gmail.com';
const GMAIL_ALIAS = 'morganfixture@gmail.com';
const WORK = 'morgan@ellery.example';
const WORK_ALIAS = 'm@ellery.example';
const NO_ACCOUNT = 'morgan@nowhere.example';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

const GRANT: GoogleGrant = {
  schema_version: 1,
  account: ASSISTANT,
  client_id: 'client-id',
  client_secret: 'client-secret',
  refresh_token: 'refresh-token',
  scopes: [...GOOGLE_SIGN_IN_SCOPES],
  granted_at: AT,
};

/** A sign-in from before Workspace: every scope but Drive's. */
const OLD_GRANT: GoogleGrant = {
  ...GRANT,
  scopes: GOOGLE_SIGN_IN_SCOPES.filter((scope) => scope !== DRIVE_SCOPE),
  granted_at: '2026-10-01T09:00:00.000Z',
};

type Logged = readonly [level: 'info' | 'warn', message: string, fields?: Record<string, unknown>];

interface World {
  readonly drive: FakeDrive;
  readonly home: HomeFolder;
  readonly notes: NoteForMain[];
  readonly logs: Logged[];
  grant: GoogleGrant | undefined;
}

let world: World;

function setUp(): World {
  const drive = new FakeDrive(ASSISTANT);
  drive.addAccount(GMAIL, GMAIL_ALIAS);
  drive.addAccount(WORK, WORK_ALIAS);
  drive.addAccount('remy@acme.example');
  const notes: NoteForMain[] = [];
  const logs: Logged[] = [];
  const state = { grant: GRANT as GoogleGrant | undefined };
  const home = createHomeFolder({
    drive,
    readGrant: async () => state.grant,
    writeNote: async (note) => {
      notes.push(note);
      return 'written';
    },
    log: {
      info: (message, fields) => logs.push(['info', message, fields]),
      warn: (message, fields) => logs.push(['warn', message, fields]),
    },
    now: () => new Date(AT),
  });
  return {
    drive,
    home,
    notes,
    logs,
    get grant() {
      return state.grant;
    },
    set grant(value) {
      state.grant = value;
    },
  };
}

async function setUpProfile(emails: readonly string[] = [GMAIL, WORK]): Promise<void> {
  await createAgentGroup({ id: 'ag-main', name: 'main', folder: 'main', agent_provider: null, created_at: AT });
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Juno',
    assistantWorkspaceEmail: ASSISTANT,
    principalDisplayName: 'Morgan Ellery',
    principalTimezone: 'Europe/London',
    mainAgentGroupId: 'ag-main',
    principalEmails: emails,
  });
}

function folderId(): string {
  const id = world.home.folderId();
  if (id === undefined) throw new Error('No home folder yet');
  return id;
}

/** Who has access to the folder of their own, as Drive holds it, the assistant aside. */
function sharedWith(fileId = folderId()): { readonly email?: string; readonly type: string; readonly role: string }[] {
  return (world.drive.file(fileId)?.permissions ?? [])
    .filter((permission) => permission.role !== 'owner')
    .map((permission) => ({
      type: permission.type,
      role: permission.role,
      ...(permission.emailAddress === undefined ? {} : { email: permission.emailAddress }),
    }));
}

async function grants(): Promise<unknown[]> {
  return getDb().all('SELECT email, permission_id, state, host_made FROM gws_ea_workspace_grants ORDER BY email');
}

async function recordedFolderId(): Promise<string | null> {
  const row = await getDb().get<{ folder_id: string | null }>(
    'SELECT folder_id FROM gws_ea_workspace_folder WHERE singleton = 1',
  );
  return row?.folder_id ?? null;
}

function shares(): unknown[] {
  return world.drive.calls.filter((call) => call.op === 'createPermission').map((call) => call.input);
}

/** A tick's calls from here on. */
function since(mark: number) {
  return world.drive.calls.slice(mark);
}

function writesSince(mark: number) {
  return since(mark).filter((call) =>
    ['createFile', 'updateFile', 'createPermission', 'deletePermission'].includes(call.op),
  );
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  world = setUp();
});

afterEach(async () => {
  await closeDb();
});

describe('the home folder', () => {
  it('is made on the first tick, named for the principal and the assistant, and shared with every principal address so a Doc made in it opens from each (AE1)', async () => {
    await setUpProfile();
    await world.home.tick();

    const id = folderId();
    expect(world.drive.file(id)).toMatchObject({
      name: 'Morgan Ellery · Juno',
      mimeType: FOLDER_MIME_TYPE,
      trashed: false,
      parents: [],
    });
    expect(await recordedFolderId()).toBe(id);
    // Writer access for each address; the client never asks Google to email anyone (drive-api.test.ts).
    expect(shares()).toEqual([
      { emailAddress: GMAIL, role: 'writer' },
      { emailAddress: WORK, role: 'writer' },
    ]);
    expect(sharedWith()).toEqual([
      { type: 'user', role: 'writer', email: GMAIL },
      { type: 'user', role: 'writer', email: WORK },
    ]);

    const doc = await world.drive.createFile({
      name: 'Lisbon trip plan',
      mimeType: 'application/vnd.google-apps.document',
      parents: [id],
    });
    const access = await world.drive.listPermissions(doc.id);
    expect(access.filter((permission) => permission.emailAddress !== ASSISTANT)).toEqual([
      expect.objectContaining({
        emailAddress: GMAIL,
        role: 'writer',
        permissionDetails: [expect.objectContaining({ inherited: true, inheritedFrom: id })],
      }),
      expect.objectContaining({
        emailAddress: WORK,
        role: 'writer',
        permissionDetails: [expect.objectContaining({ inherited: true, inheritedFrom: id })],
      }),
    ]);
  });

  it('tells main where the new folder is, once, without waking it', async () => {
    await setUpProfile();
    await world.home.tick();
    await world.home.tick();

    expect(world.notes).toEqual([
      {
        id: `gws-ea-workspace-home-folder-${folderId()}`,
        timestamp: AT,
        text: expect.stringContaining(`\`${folderId()}\``),
        wake: false,
      },
    ]);
  });

  it('makes no Drive writes on a tick where nothing changed', async () => {
    await setUpProfile();
    await world.home.tick();
    const mark = world.drive.calls.length;

    await world.home.tick();

    expect(writesSince(mark)).toEqual([]);
    expect(since(mark).map((call) => call.op)).toEqual(['getFile', 'listPermissions']);
  });

  it('records an alias whose permission id already holds access, and never shares with it', async () => {
    await setUpProfile([GMAIL]);
    await world.home.tick();
    const [primary] = world.drive.file(folderId())?.permissions.filter((p) => p.emailAddress === GMAIL) ?? [];

    await addPrincipalAddress(GMAIL_ALIAS);
    const mark = world.drive.calls.length;
    await world.home.tick();
    await world.home.tick();

    expect(writesSince(mark)).toEqual([]);
    expect(await grants()).toEqual([
      { email: GMAIL, permission_id: primary.id, state: 'granted', host_made: 1 },
      { email: GMAIL_ALIAS, permission_id: primary.id, state: 'granted', host_made: 1 },
    ]);

    // The account stays shared while one of its addresses is still the principal's.
    await removePrincipalAddress(GMAIL_ALIAS);
    await world.home.tick();
    expect(sharedWith()).toEqual([{ type: 'user', role: 'writer', email: GMAIL }]);
    expect(await grants()).toEqual([{ email: GMAIL, permission_id: primary.id, state: 'granted', host_made: 1 }]);
  });

  it('records an address Google refuses once, and asks again only when the addresses change', async () => {
    await setUpProfile([GMAIL, NO_ACCOUNT]);
    await world.home.tick();
    await world.home.tick();

    expect(shares()).toEqual([
      { emailAddress: GMAIL, role: 'writer' },
      { emailAddress: NO_ACCOUNT, role: 'writer' },
    ]);
    expect(await grants()).toEqual([
      expect.objectContaining({ email: GMAIL, state: 'granted' }),
      { email: NO_ACCOUNT, permission_id: `${NO_ACCOUNT}k`, state: 'refused', host_made: 0 },
    ]);
    expect(world.logs.filter(([, message]) => /refused/u.test(message))).toEqual([
      ['warn', expect.any(String), expect.objectContaining({ email: NO_ACCOUNT, reason: expect.any(String) })],
    ]);

    await addPrincipalAddress(WORK);
    await world.home.tick();
    expect(shares().slice(2)).toEqual([
      { emailAddress: WORK, role: 'writer' },
      { emailAddress: NO_ACCOUNT, role: 'writer' },
    ]);
  });

  it("records an organization's sharing policy as a refusal, and waits out a rate limit", async () => {
    await setUpProfile([GMAIL, WORK]);
    world.drive.failNext(
      'createPermission',
      new GoogleApiError(403, 'Google refused: Sharing outside the organization is not allowed.', {
        reason: 'shareOutNotPermitted',
      }),
    );
    world.drive.failNext(
      'createPermission',
      new GoogleApiError(403, 'Google refused: Rate limit exceeded.', { reason: 'sharingRateLimitExceeded' }),
    );
    await world.home.tick();

    expect(await grants()).toEqual([{ email: GMAIL, permission_id: '0802', state: 'refused', host_made: 0 }]);
    expect(world.logs).toContainEqual(['warn', expect.stringMatching(/next tick/u), expect.anything()]);

    await world.home.tick();
    expect(sharedWith()).toEqual([{ type: 'user', role: 'writer', email: WORK }]);
    expect(await grants()).toEqual([
      expect.objectContaining({ email: GMAIL, state: 'refused' }),
      expect.objectContaining({ email: WORK, state: 'granted', host_made: 1 }),
    ]);
  });

  it('leaves a grant the principal removed by hand removed, until the addresses change', async () => {
    await setUpProfile();
    await world.home.tick();
    const work = world.drive.file(folderId())?.permissions.find((p) => p.emailAddress === WORK);
    world.drive.removeAccess(folderId(), work?.id ?? '');

    await world.home.tick();
    await world.home.tick();
    expect(sharedWith()).toEqual([{ type: 'user', role: 'writer', email: GMAIL }]);
    expect(await grants()).toEqual([
      expect.objectContaining({ email: GMAIL, state: 'granted' }),
      { email: WORK, permission_id: work?.id, state: 'removed', host_made: 1 },
    ]);
    expect(shares()).toHaveLength(2);

    await addPrincipalAddress(GMAIL_ALIAS);
    await world.home.tick();
    expect(sharedWith()).toEqual([
      { type: 'user', role: 'writer', email: GMAIL },
      { type: 'user', role: 'writer', email: WORK },
    ]);
  });

  it("revokes the host's grant for an address no longer the principal's, and touches no other access", async () => {
    await setUpProfile([GMAIL, WORK]);
    await world.home.tick();
    world.drive.share(folderId(), { id: '0899', type: 'user', role: 'reader', emailAddress: 'remy@acme.example' });
    world.drive.share(folderId(), { id: '0900', type: 'group', role: 'reader', emailAddress: 'team@ellery.example' });
    world.drive.share(folderId(), { id: 'anyoneWithLink', type: 'anyone', role: 'reader' });

    await removePrincipalAddress(WORK);
    await world.home.tick();

    expect(world.drive.calls.filter((call) => call.op === 'deletePermission')).toEqual([
      { op: 'deletePermission', fileId: folderId(), input: { permissionId: '0803' } },
    ]);
    expect(sharedWith()).toEqual([
      { type: 'user', role: 'writer', email: GMAIL },
      { type: 'user', role: 'reader', email: 'remy@acme.example' },
      { type: 'group', role: 'reader', email: 'team@ellery.example' },
      { type: 'anyone', role: 'reader' },
    ]);
    expect(await grants()).toEqual([expect.objectContaining({ email: GMAIL })]);
  });

  it('records access a principal address already had as not the host’s, and never revokes it', async () => {
    await setUpProfile([GMAIL]);
    await world.home.tick();
    // Someone shared the folder with the work account by hand, before it was one of the principal's addresses.
    world.drive.share(folderId(), { id: '0803', type: 'user', role: 'writer', emailAddress: WORK });

    await addPrincipalAddress(WORK_ALIAS);
    await world.home.tick();
    expect(await grants()).toEqual([
      { email: WORK_ALIAS, permission_id: '0803', state: 'granted', host_made: 0 },
      expect.objectContaining({ email: GMAIL }),
    ]);

    await removePrincipalAddress(WORK_ALIAS);
    await world.home.tick();
    expect(world.drive.calls.filter((call) => call.op === 'deletePermission')).toEqual([]);
    expect(sharedWith()).toContainEqual({ type: 'user', role: 'writer', email: WORK });
  });

  it('restores a trashed folder in place', async () => {
    await setUpProfile();
    await world.home.tick();
    const id = folderId();
    world.drive.trash(id);

    await world.home.tick();

    expect(world.drive.file(id)?.trashed).toBe(false);
    expect(folderId()).toBe(id);
    expect(world.notes).toHaveLength(1);
    expect(sharedWith()).toHaveLength(2);
  });

  it('makes a new folder when the old one was deleted for good, records it, shares it, and tells main', async () => {
    await setUpProfile();
    await world.home.tick();
    const old = folderId();
    world.drive.deleteForever(old);

    await world.home.tick();

    const id = folderId();
    expect(id).not.toBe(old);
    expect(await recordedFolderId()).toBe(id);
    expect(sharedWith(id)).toEqual([
      { type: 'user', role: 'writer', email: GMAIL },
      { type: 'user', role: 'writer', email: WORK },
    ]);
    expect(world.notes.map((note) => note.id)).toEqual([
      `gws-ea-workspace-home-folder-${old}`,
      `gws-ea-workspace-home-folder-${id}`,
    ]);
    expect(world.notes[1].text).toContain(`\`${id}\``);
    expect(world.notes[1].text).toMatch(/deleted/u);
  });

  it('reads the recorded folder at load, as the host starts', async () => {
    await setUpProfile();
    await world.home.tick();
    const id = folderId();

    const restarted = createHomeFolder({
      drive: world.drive,
      readGrant: async () => GRANT,
      writeNote: async () => 'written',
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(restarted.folderId()).toBeUndefined();
    await restarted.load();
    expect(restarted.folderId()).toBe(id);
  });
});

describe('the home folder tick', () => {
  it('stays quiet while the sign-in lacks Drive: one log per sign-in, and no Drive calls', async () => {
    await setUpProfile();
    world.grant = OLD_GRANT;
    await world.home.tick();
    await world.home.tick();

    expect(world.drive.calls).toEqual([]);
    expect(world.logs).toEqual([['info', expect.stringMatching(/Drive/u), { account: ASSISTANT }]]);

    // Another sign-in without Drive is reported again.
    world.grant = { ...OLD_GRANT, granted_at: '2026-10-02T09:00:00.000Z' };
    await world.home.tick();
    expect(world.logs).toHaveLength(2);

    world.grant = GRANT;
    await world.home.tick();
    expect(world.home.folderId()).toBeDefined();
  });

  it('does nothing before the assistant signs in, or before the profile names the principal and the assistant', async () => {
    world.grant = undefined;
    await setUpProfile();
    await world.home.tick();
    world.grant = GRANT;
    await getDb().run('UPDATE gws_ea_profile SET principal_display_name = NULL WHERE singleton = 1');
    await world.home.tick();

    expect(world.drive.calls).toEqual([]);
    expect(world.logs).toEqual([]);
  });

  it('stays quiet once per sign-in when Google says Drive is not granted or the sign-in was revoked', async () => {
    await setUpProfile();
    world.drive.failNext('createFile', new GoogleScopeNotGrantedError('drive-host'));
    world.drive.failNext('createFile', new GoogleScopeNotGrantedError('drive-host'));
    await world.home.tick();
    await world.home.tick();
    expect(world.logs).toEqual([['info', expect.any(String), { account: ASSISTANT }]]);

    world.grant = { ...GRANT, granted_at: '2026-10-09T10:00:00.000Z' };
    world.drive.failNext('createFile', new GoogleGrantRevokedError('revoked'));
    world.drive.failNext('createFile', new GoogleGrantRevokedError('revoked'));
    await world.home.tick();
    await world.home.tick();
    expect(world.logs).toHaveLength(2);
    expect(world.home.folderId()).toBeUndefined();
  });

  it.each([
    ['a Drive server error', new GoogleApiError(503, 'Google refused /drive/v3/files: Backend Error')],
    [
      'a Drive 403',
      new GoogleApiError(403, 'Google refused /drive/v3/files: Drive API has not been used', {
        reason: 'accessNotConfigured',
      }),
    ],
    ['Drive out of reach', new GoogleApiError(0, 'Google could not be reached (/drive/v3/files)')],
  ])('logs %s, ends the tick without throwing, and heals on the next', async (_case, error) => {
    await setUpProfile();
    world.drive.failNext('createFile', error);

    await expect(world.home.tick()).resolves.toBeUndefined();
    expect(world.home.folderId()).toBeUndefined();
    expect(world.logs).toEqual([['warn', expect.stringMatching(/next tick/u), { error: error.message }]]);

    await world.home.tick();
    expect(sharedWith()).toHaveLength(2);
  });

  it('keeps what a failed tick already did, and finishes it on the next', async () => {
    await setUpProfile();
    world.drive.failNext('listPermissions', new GoogleApiError(500, 'Google refused: Internal Error'));
    await world.home.tick();
    const id = folderId();
    expect(await recordedFolderId()).toBe(id);
    expect(shares()).toEqual([]);

    await world.home.tick();
    expect(world.drive.calls.filter((call) => call.op === 'createFile')).toHaveLength(1);
    expect(sharedWith()).toHaveLength(2);
  });

  it('logs a sign-in it cannot read, and carries on next tick', async () => {
    await setUpProfile();
    const failing = createHomeFolder({
      drive: world.drive,
      readGrant: async () => {
        throw new Error('Google grant must be owner-only');
      },
      writeNote: async () => 'written',
      log: { info: () => undefined, warn: (message, fields) => world.logs.push(['warn', message, fields]) },
    });
    await expect(failing.tick()).resolves.toBeUndefined();
    expect(world.logs).toEqual([['warn', expect.any(String), { error: 'Google grant must be owner-only' }]]);
    expect(world.drive.calls).toEqual([]);
  });
});
