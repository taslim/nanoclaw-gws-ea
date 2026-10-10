/**
 * The home folder's place in the host (KTD2, KTD3): the host starts keeping
 * it without waiting on Google, and only the profile's `main` is told where
 * it is, a `main` named after the host started included. Google itself is
 * out of reach here: the host's Drive token is a stub that refuses.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('../gws-ea-google/index.js', () => ({
  hostGoogleAccessToken: vi.fn(async () => {
    throw new Error('No Google token in these tests');
  }),
}));

import { dispatch } from '../../cli/dispatch.js';
import type { ContainerConfig } from '../../container-config.js';
import { composeSessionSpec } from '../../container-runner.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getRegisteredMigrations } from '../../db/migrations/index.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import type { AgentGroup, Session } from '../../types.js';
import { GOOGLE_GRANT_FILE_ENV, GOOGLE_SIGN_IN_SCOPES } from '../gws-ea-google/grant.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { knownMainAgentGroupId, reconcileGwsEaProfile, recordExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { recordHomeFolder } from './db.js';
import { HOME_FOLDER_ENV } from './index.js';

const ROOT = '/tmp/nanoclaw-gws-ea-workspace-test';
const GRANT_FILE = path.join(ROOT, 'secrets', 'google-grant.json');
const AT = '2026-10-09T09:00:00.000Z';
const FOLDER = 'folder-recorded';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

const PROFILE = {
  'assistant-display-name': 'Juno',
  'assistant-workspace-email': 'juno@northwind.example',
  'principal-display-name': 'Morgan Ellery',
  'principal-timezone': 'Europe/London',
  'main-agent-group-id': 'ag-main',
  'principal-emails': JSON.stringify(['morgan.fixture@gmail.com']),
};

let host: AbortController | undefined;

function group(id: string): AgentGroup {
  return { id, name: id, folder: id, agent_provider: null, created_at: AT };
}

function writeGrant(scopes: readonly string[]): void {
  fs.writeFileSync(
    GRANT_FILE,
    JSON.stringify({
      schema_version: 1,
      account: 'juno@northwind.example',
      client_id: 'client.apps.googleusercontent.com',
      client_secret: 'client-secret',
      refresh_token: 'refresh-token',
      scopes,
      granted_at: AT,
    }),
    { mode: 0o600 },
  );
}

async function startHost(): Promise<void> {
  host = new AbortController();
  const deliveryAdapter = { deliver: async () => undefined };
  for (const start of getHostStartCallbacks()) await start({ db: getDb(), deliveryAdapter, signal: host.signal });
}

/** The folder a spawn of this group is told about, from the real composition. */
function folderAtSpawn(agentGroupId: string, compose = composeSessionSpec): string | undefined {
  const [agent] = compose({
    agentGroup: group(agentGroupId),
    session: { id: 'session-1', agent_group_id: agentGroupId } as Session,
    containerName: `nanoclaw-v2-${agentGroupId}-1700000000000`,
    mounts: [],
    containerConfig: { capabilities: ['shell', 'google-calendar'] } as unknown as ContainerConfig,
    mailboxEnvironment: {},
    contribution: {},
    gateway: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } },
  }).containers;
  return { ...agent.env, ...agent.contributedEnv }[HOME_FOLDER_ENV];
}

async function createGroups(): Promise<void> {
  for (const id of ['ag-main', 'ag-external', 'ag-research']) await createAgentGroup(group(id));
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(GRANT_FILE), { recursive: true, mode: 0o700 });
  process.env[GOOGLE_GRANT_FILE_ENV] = GRANT_FILE;
  vi.mocked(hostGoogleAccessToken).mockClear();
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  host?.abort();
  host = undefined;
  delete process.env[GOOGLE_GRANT_FILE_ENV];
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("the home folder's environment", () => {
  it("is given to the profile's main alone: external-email and every other group get nothing", async () => {
    await createGroups();
    await dispatch({ id: 'reconcile', command: 'gws-ea-profile-reconcile', args: PROFILE }, { caller: 'host' });
    await recordExternalEmailAgentGroupId('ag-external');
    await recordHomeFolder(FOLDER, AT);

    await startHost();

    expect(folderAtSpawn('ag-main')).toBe(FOLDER);
    expect(folderAtSpawn('ag-external')).toBeUndefined();
    expect(folderAtSpawn('ag-research')).toBeUndefined();
  });

  it('finds main in the database as the host starts, as after a restart', async () => {
    await createGroups();
    await createAgentGroup(group('ag-main-restarted'));
    // The profile an earlier host process wrote: nothing in this one named main.
    await getDb().run(
      `UPDATE gws_ea_profile
          SET assistant_display_name = 'Juno', principal_display_name = 'Morgan Ellery',
              main_agent_group_id = 'ag-main-restarted'
        WHERE singleton = 1`,
    );
    await recordHomeFolder(FOLDER, AT);

    await startHost();

    expect(knownMainAgentGroupId()).toBe('ag-main-restarted');
    expect(folderAtSpawn('ag-main-restarted')).toBe(FOLDER);
    expect(folderAtSpawn('ag-main')).toBeUndefined();
  });

  it("reaches a main spawned before the host's start reads the folder, as a restart releases held messages first", async () => {
    // A restarted host: modules loaded afresh, and this module's start not run yet.
    vi.resetModules();
    const db = await import('../../db/index.js');
    const { loadMainAgentGroupId } = await import('../gws-ea-profile/db.js');
    const { recordHomeFolder: recordFolder } = await import('./db.js');
    await import('../gws-ea-profile/index.js');
    await import('./index.js');
    const runner = await import('../../container-runner.js');
    await db.runMigrations(await db.initTestDb());
    onTestFinished(() => db.closeDb());
    await db.createAgentGroup(group('ag-main'));
    // The profile and the folder an earlier host process wrote.
    await db.getDb().run("UPDATE gws_ea_profile SET main_agent_group_id = 'ag-main' WHERE singleton = 1");
    await recordFolder(FOLDER, AT);
    // main as the profile's start reads it, which runs before this module's;
    // a spawn reading it first is the profile's own test.
    await loadMainAgentGroupId();
    const admit = (disposition: 'create' | 'adopt') =>
      runner.assertSessionAdmitted({
        disposition,
        key: { installSlug: 'install', agentGroupId: 'ag-main', sessionId: 'session-1' },
      });

    // An adopted container keeps the environment it started with, so adoption reads nothing.
    await admit('adopt');
    expect(folderAtSpawn('ag-main', runner.composeSessionSpec)).toBeUndefined();

    await admit('create');
    expect(folderAtSpawn('ag-main', runner.composeSessionSpec)).toBe(FOLDER);
  });

  it('reaches a main named after the host started, on its next spawn', async () => {
    await createGroups();
    await recordHomeFolder(FOLDER, AT);
    await startHost();
    expect(knownMainAgentGroupId()).toBeNull();
    expect(folderAtSpawn('ag-main')).toBeUndefined();

    const result = await dispatch(
      { id: 'reconcile', command: 'gws-ea-profile-reconcile', args: PROFILE },
      { caller: 'host' },
    );

    expect(result).toMatchObject({ ok: true });
    expect(knownMainAgentGroupId()).toBe('ag-main');
    expect(folderAtSpawn('ag-main')).toBe(FOLDER);
    expect(folderAtSpawn('ag-research')).toBeUndefined();
  });

  it('is nothing before the host has made a folder', async () => {
    await createGroups();
    await reconcileGwsEaProfile({
      assistantDisplayName: 'Juno',
      assistantWorkspaceEmail: 'juno@northwind.example',
      principalDisplayName: 'Morgan Ellery',
      principalTimezone: 'Europe/London',
      mainAgentGroupId: 'ag-main',
    });
    await startHost();
    expect(folderAtSpawn('ag-main')).toBeUndefined();
  });

  it('is nothing on a host with no Google sign-in configured', async () => {
    delete process.env[GOOGLE_GRANT_FILE_ENV];
    await createGroups();
    await dispatch({ id: 'reconcile', command: 'gws-ea-profile-reconcile', args: PROFILE }, { caller: 'host' });
    await recordHomeFolder(FOLDER, AT);

    await startHost();

    expect(folderAtSpawn('ag-main')).toBeUndefined();
  });
});

describe('the host starting the home folder', () => {
  it('starts untouched by a missing grant file, and makes no Drive call', async () => {
    await createGroups();
    await dispatch({ id: 'reconcile', command: 'gws-ea-profile-reconcile', args: PROFILE }, { caller: 'host' });
    await expect(startHost()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hostGoogleAccessToken).not.toHaveBeenCalled();
  });

  it('never waits on Google: a Drive token that never comes leaves start untouched', async () => {
    vi.mocked(hostGoogleAccessToken).mockImplementationOnce(() => new Promise<string>(() => undefined));
    await createGroups();
    await dispatch({ id: 'reconcile', command: 'gws-ea-profile-reconcile', args: PROFILE }, { caller: 'host' });
    writeGrant(GOOGLE_SIGN_IN_SCOPES);

    await startHost();

    await vi.waitFor(() => expect(hostGoogleAccessToken).toHaveBeenCalledWith('drive-host'));
  });

  it('starts untouched without the profile and the folder tables', async () => {
    await closeDb();
    const db = await initTestDb();
    await runMigrations(
      db,
      getRegisteredMigrations().filter((migration) => !migration.name.startsWith('module:')),
    );
    writeGrant(GOOGLE_SIGN_IN_SCOPES);

    await expect(startHost()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hostGoogleAccessToken).not.toHaveBeenCalled();
    expect(knownMainAgentGroupId()).toBeNull();
  });

  it('keeps the folder on a timer it starts: quiet while the sign-in lacks Drive', async () => {
    const info = vi.spyOn(log, 'info');
    await createGroups();
    await dispatch({ id: 'reconcile', command: 'gws-ea-profile-reconcile', args: PROFILE }, { caller: 'host' });
    writeGrant(GOOGLE_SIGN_IN_SCOPES.filter((scope) => scope !== DRIVE_SCOPE));

    await startHost();

    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/includes Drive/u), {
        account: 'juno@northwind.example',
      }),
    );
    expect(hostGoogleAccessToken).not.toHaveBeenCalled();
  });

  it("reaches Drive with the host's own Drive token once the sign-in holds Drive, and survives its failure", async () => {
    const warn = vi.spyOn(log, 'warn');
    await createGroups();
    await dispatch({ id: 'reconcile', command: 'gws-ea-profile-reconcile', args: PROFILE }, { caller: 'host' });
    writeGrant(GOOGLE_SIGN_IN_SCOPES);

    await startHost();

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/home folder/u), {
        error: 'No Google token in these tests',
      }),
    );
    expect(vi.mocked(hostGoogleAccessToken).mock.calls).toEqual([['drive-host']]);
  });
});
