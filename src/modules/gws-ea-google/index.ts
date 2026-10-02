/**
 * GWS-EA's Google access for agents (KTD2). Every agent group gets the skill
 * of each Google service the release exposes, because every group's container
 * carries the tool and reaches the service through the gateway. On a GWS-EA
 * instance the host is also told where the assistant's grant file is; while
 * the host runs it keeps OneCLI's Google secrets holding live tokens.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { parseSkillSelection } from '../../container-config.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { readEnvFile } from '../../env.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { EXPOSED_GOOGLE_SKILLS, GOOGLE_GRANT_FILE_ENV } from './grant.js';
import { readGoogleGrantFile } from './grant-file.js';
import { createGoogleTokenRefresher } from './refresher.js';

/** How often the host checks whether a token needs renewing. */
const TICK_MS = 60_000;

/**
 * Add the exposed services' skills to every agent group that lists its skills,
 * keeping everything a group already has; a group on `all` has them already.
 * A group created with its own list while the host runs gets them at the next
 * start.
 */
async function reconcileGoogleSkills(): Promise<void> {
  for (const group of await getAllAgentGroups()) {
    const row = await getContainerConfig(group.id);
    if (!row) continue;
    const skills = parseSkillSelection(row.skills, group.name);
    if (skills === 'all') continue;
    const missing = EXPOSED_GOOGLE_SKILLS.filter((skill) => !skills.includes(skill));
    if (missing.length === 0) continue;
    await updateContainerConfigJson(group.id, 'skills', [...skills, ...missing]);
    log.info("Added Google services' skills to an agent group", { agentGroupId: group.id, skills: missing });
  }
}

onHostStart(async ({ signal }) => {
  await reconcileGoogleSkills();
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
