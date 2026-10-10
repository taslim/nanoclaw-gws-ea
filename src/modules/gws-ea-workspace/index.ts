/**
 * GWS-EA's work in Google Workspace (KTD2, KTD3). The host keeps the home
 * folder: one folder in the assistant's Drive, shared with every one of the
 * principal's addresses, where `main` keeps what it makes
 * (`./home-folder.ts`).
 *
 * - The host keeps it on a timer it starts without waiting on Google. The
 *   start reads only the database and the grant file, after checking both
 *   are there, and seeds the folder id spawns read; a spawn that comes
 *   first reads it the same way before its environment is composed.
 * - Only the profile's `main` is told where it is, through its container's
 *   environment; `external-email` and every other group get nothing. A
 *   `main` named after the host started is told on its next spawn, and a
 *   running one by a note when the folder changes.
 * - Drive is reached with the host's own Drive token, which never reaches a
 *   gateway or a container.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { registerContainerEnv } from '../../container-env.js';
import { registerSessionAdmissionPolicy } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { googleGrantFilePath, readGoogleGrantFile } from '../gws-ea-google/grant-file.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { knownMainAgentGroupId } from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { createDriveApi } from './drive-api.js';
import { createHomeFolder, type HomeFolder } from './home-folder.js';
import { gwsEaWorkspaceHomeFolderMigration } from './migration.js';

registerMigration(gwsEaWorkspaceHomeFolderMigration);

/** The container environment variable that tells `main` its home folder's Drive id. */
export const HOME_FOLDER_ENV = 'GWS_EA_HOME_FOLDER_ID';

/** How often the host reconciles the home folder. */
const TICK_MS = 60_000;

/**
 * The home folder spawns read, as the host starts and by any spawn that
 * comes first: null on a host that keeps none, and undefined until this host
 * reads it. A stopped host forgets what its start read.
 */
let home: HomeFolder | null | undefined;

/** The folder as recorded, read from the database alone; null without a Google sign-in or the tables. */
async function loadHomeFolder(): Promise<HomeFolder | null> {
  const grantFile = googleGrantFilePath();
  if (!grantFile) return null;
  const db = getDb();
  if (!(await db.hasTable('gws_ea_profile')) || !(await db.hasTable('gws_ea_workspace_folder'))) return null;
  const folder = createHomeFolder({
    drive: createDriveApi({ token: () => hostGoogleAccessToken('drive-host') }),
    readGrant: () => readGoogleGrantFile(grantFile),
    writeNote: writeNoteForMain,
    log,
  });
  await folder.load();
  return folder;
}

registerContainerEnv('gws-ea-workspace:home-folder', ({ agentGroupId }): Record<string, string> => {
  const folderId = home?.folderId();
  if (folderId === undefined || agentGroupId !== knownMainAgentGroupId()) return {};
  return { [HOME_FOLDER_ENV]: folderId };
});

// The host releases the messages its channels held before it starts its
// modules, so a spawn can come first: it reads the folder itself before its
// environment is composed. An adopted container keeps the environment it has.
registerSessionAdmissionPolicy('gws-ea-workspace:home-folder', async ({ disposition }) => {
  if (disposition !== 'create' || home !== undefined) return;
  const folder = await loadHomeFolder();
  // A start that read it meanwhile stands: its copy is the one the timer keeps.
  home ??= folder;
});

onHostStart(async ({ signal }) => {
  const folder = await loadHomeFolder();
  home = folder;
  signal.addEventListener(
    'abort',
    () => {
      if (home === folder) home = undefined;
    },
    { once: true },
  );
  if (folder === null) return;
  // Started, not awaited: host startup never waits on Google.
  void (async () => {
    while (!signal.aborted) {
      await folder.tick();
      await delay(TICK_MS, undefined, { signal }).catch(() => undefined);
    }
  })();
});
