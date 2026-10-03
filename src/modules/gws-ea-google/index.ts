/**
 * GWS-EA's Google access for agents (KTD1, KTD2, KTD6). Each agent-facing
 * Google service is a capability: a group holding the key is handed the
 * service's skill, gog's commands for it, and its gateway credential, and a
 * group without it gets none of them. The keys are on by default, so a group
 * on `all`, `main` among them, holds every one. Nothing here rewrites a
 * group's configuration.
 *
 * On a GWS-EA instance the host is also told where the assistant's grant
 * file is; while the host runs it publishes the agent-facing tokens through
 * the selected gateway's credential connection, and holds host-only tokens
 * in memory.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { registerCapability } from '../../capabilities.js';
import { registerContainerEnv } from '../../container-env.js';
import { getGatewayProvider } from '../../gateway-providers/index.js';
import { readEnvFile } from '../../env.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import {
  AGENT_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SERVICES,
  GOOGLE_GRANT_FILE_ENV,
  type AgentGoogleServiceId,
  type HostGoogleServiceId,
} from './grant.js';
import { readGoogleGrantFile } from './grant-file.js';
import { createGoogleTokenRefresher, type GoogleTokenRefresher } from './refresher.js';

/** How often the host checks whether a token needs renewing. */
const TICK_MS = 60_000;

const CAPABILITY_DESCRIPTIONS: Readonly<Record<AgentGoogleServiceId, string>> = {
  calendar: "Google Calendar as the assistant: the gcalendar skill and the assistant's Calendar token",
  'gmail-read': "the assistant's Gmail, read-only: the gmail skill and a gmail.readonly token",
  directory: 'the Workspace directory, read-only: the gpeople skill and a directory.readonly token',
};

/**
 * The gog commands each service's key enables, as gog v0.43.0's exact
 * command paths (`GOG_ENABLE_COMMANDS_EXACT`, where a parent does not enable
 * its children). Its skill teaches these and nothing else. `main` writes the
 * principal's calendars and answers their invitations itself (Key
 * Decisions), reads mail without changing it, and only searches the
 * directory. Overlaps go through `find_conflicts`, so `calendar.conflicts` is
 * off.
 */
const GOG_COMMANDS: Readonly<Record<AgentGoogleServiceId, readonly string[]>> = {
  calendar: [
    'calendar.calendars',
    'calendar.subscribe',
    'calendar.unsubscribe',
    'calendar.events',
    'calendar.event',
    'calendar.freebusy',
    'calendar.create',
    'calendar.update',
    'calendar.delete',
    'calendar.respond',
  ],
  'gmail-read': ['gmail.search', 'gmail.messages.search', 'gmail.thread.get', 'gmail.get'],
  directory: ['people.search'],
};

for (const id of EXPOSED_GOOGLE_SERVICES) {
  const service = AGENT_GOOGLE_SERVICES[id];
  registerCapability(service.capability, {
    description: CAPABILITY_DESCRIPTIONS[id],
    default: 'on',
    skills: [service.skill],
    credentials: [service.secretName],
  });
}

/**
 * gog's settings for a group, from the Google keys it holds (KTD1). The image
 * sets none, so a group holding no key gets nothing and gog there has no
 * token and reaches no account. A group holding any key gets a placeholder
 * token the gateway replaces with the matching Google token, exactly its
 * keys' commands, Gmail sending off, and JSON output with other people's
 * text inside untrusted-content markers. An agent with a shell could change
 * these, so each token's scope stays the real boundary; the command list keeps
 * gog to what the group's skills teach.
 */
registerContainerEnv('gws-ea-google:gog', ({ capabilities }): Record<string, string> => {
  const commands = EXPOSED_GOOGLE_SERVICES.filter((id) =>
    capabilities.has(AGENT_GOOGLE_SERVICES[id].capability),
  ).flatMap((id) => GOG_COMMANDS[id]);
  if (commands.length === 0) return {};
  return {
    GOG_ACCESS_TOKEN: 'gateway-managed',
    GOG_ENABLE_COMMANDS_EXACT: commands.join(','),
    GOG_GMAIL_NO_SEND: '1',
    GOG_JSON: '1',
    GOG_WRAP_UNTRUSTED: '1',
  };
});

let active: GoogleTokenRefresher | undefined;

onHostStart(async ({ signal }) => {
  const env = readEnvFile([GOOGLE_GRANT_FILE_ENV]);
  const grantFile = process.env[GOOGLE_GRANT_FILE_ENV] || env[GOOGLE_GRANT_FILE_ENV];
  if (!grantFile) return;
  const gateway = getGatewayProvider();
  const credentials = gateway.credentials;
  if (!credentials) {
    log.error('Google access for agents is off: the gateway stores no runtime credentials', {
      gateway: gateway.kind,
    });
    return;
  }
  const refresher = createGoogleTokenRefresher({
    readGrant: () => readGoogleGrantFile(grantFile),
    connection: (target) => credentials.connection(target),
    log,
  });
  active = refresher;
  signal.addEventListener(
    'abort',
    () => {
      if (active === refresher) active = undefined;
    },
    { once: true },
  );
  // Started, not awaited: host startup never waits on Google.
  void (async () => {
    while (!signal.aborted) {
      await refresher.tick();
      await delay(TICK_MS, undefined, { signal }).catch(() => undefined);
    }
  })();
});

/**
 * A live token for a host-only Google service (KTD6), such as the Gmail
 * token for the assistant's own inbox: minted on demand and held only in
 * this host's memory, never in a gateway or a container.
 */
export function hostGoogleAccessToken(service: HostGoogleServiceId): Promise<string> {
  if (!active) return Promise.reject(new Error('Google access is off on this host: it has no Google sign-in'));
  return active.hostAccessToken(service);
}
