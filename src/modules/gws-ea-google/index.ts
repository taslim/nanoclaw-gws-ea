/**
 * GWS-EA's Google access for agents (KTD2). On a GWS-EA instance the host is
 * told where the assistant's grant file is; while the host runs it keeps
 * OneCLI's Google secrets holding live tokens. Anywhere else this module does
 * nothing.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from '../../community-portal/errors.js';
import { readEnvFile } from '../../env.js';
import { readOwnerOnlyJson } from '../../gws-ea/secrets.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { GOOGLE_GRANT_FILE_ENV, parseGoogleGrant, type GoogleGrant } from './grant.js';
import { createGoogleTokenRefresher } from './refresher.js';

/** How often the host checks whether a token needs renewing. */
const TICK_MS = 60_000;

/** The grant, or undefined before the assistant has signed in. */
export async function readGoogleGrantFile(file: string): Promise<GoogleGrant | undefined> {
  try {
    return parseGoogleGrant(await readOwnerOnlyJson(file, 'Google grant', 'invalid_google_grant'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

onHostStart(({ signal }) => {
  const env = readEnvFile([GOOGLE_GRANT_FILE_ENV, 'ONECLI_URL', 'ONECLI_API_KEY']);
  const grantFile = process.env[GOOGLE_GRANT_FILE_ENV] || env[GOOGLE_GRANT_FILE_ENV];
  if (!grantFile) return;
  const url = process.env.ONECLI_URL || env.ONECLI_URL;
  const apiKey = process.env.ONECLI_API_KEY || env.ONECLI_API_KEY;
  if (!url || !apiKey) {
    log.error('Google access for agents is off: the host has no OneCLI URL or key');
    return;
  }
  const refresher = createGoogleTokenRefresher({
    readGrant: () => readGoogleGrantFile(grantFile),
    onecli: { url, apiKey },
    log,
  });
  // Started, not awaited: host startup never waits on Google.
  void (async () => {
    while (!signal.aborted) {
      await refresher.tick();
      await delay(TICK_MS, undefined, { signal }).catch(() => undefined);
    }
  })();
});
