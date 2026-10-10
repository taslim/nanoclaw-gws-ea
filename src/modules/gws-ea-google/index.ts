/**
 * GWS-EA's Google access for agents (KTD1, KTD2, KTD6). Each Google service
 * agents reach is a capability: a group holding the key is handed the
 * service's skill and gog's commands for it, and a group without it gets
 * neither. Drive, Docs, Sheets, Slides and Forms are one key, Workspace,
 * whose commands only the profile's `main` is given. The keys are on by
 * default, so a group on `all`, `main` among them, holds every one. Nothing
 * here rewrites a group's configuration.
 *
 * On a GWS-EA instance the host is also told where the assistant's grant
 * file is; while the host runs it publishes one token per agent credential's
 * host through the selected gateway's credential connection, and holds
 * host-only tokens in memory.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { registerCapability } from '../../capabilities.js';
import { registerContainerEnv } from '../../container-env.js';
import { getGatewayProvider } from '../../gateway-providers/index.js';
import { readEnvFile } from '../../env.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { knownMainAgentGroupId } from '../gws-ea-profile/db.js';
import {
  AGENT_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SERVICES,
  GOOGLE_GRANT_FILE_ENV,
  type GoogleCapability,
  type HostGoogleServiceId,
} from './grant.js';
import { readGoogleGrantFile } from './grant-file.js';
import { createGoogleTokenRefresher, GATEWAY_TOKEN_PLACEHOLDER, type GoogleTokenRefresher } from './refresher.js';
import { WORKSPACE_GOG_COMMANDS } from './workspace-commands.js';

/** How often the host checks whether a token needs renewing. */
const TICK_MS = 60_000;

const CAPABILITY_DESCRIPTIONS: Readonly<Record<GoogleCapability, string>> = {
  'google-calendar':
    "Google Calendar as the assistant: the gcalendar skill, the assistant's Calendar token, create_event and change_guests, and the host's find_conflicts and people_stats",
  'google-mail-read': "the assistant's Gmail, read-only: the gmail skill and a gmail.readonly token",
  'google-directory': 'the Workspace directory, read-only: the gpeople skill and a directory.readonly token',
  'google-workspace':
    "Drive, Docs, Sheets, Slides and Forms as the assistant: the gworkspace skill, the assistant's tokens for them, and, for the profile's main alone, gog's whole surface for them",
};

/**
 * The gog commands each key enables, as gog v0.43.0's exact command paths
 * (`GOG_ENABLE_COMMANDS_EXACT`, where a parent does not enable its children).
 * Its skill teaches only these. `main` writes the principal's calendars and
 * answers their invitations itself (Key Decisions), reads mail without
 * changing it, and only searches the directory. Overlaps go through the
 * host's `find_conflicts`, so `calendar.conflicts` is off. gog cannot list
 * the principal as an accepted guest, so events are created through the
 * host's `create_event` and `calendar.create` is off. Workspace's are gog's
 * whole surface for its five products, generated (`./workspace-commands.ts`).
 */
const GOG_COMMANDS: Readonly<Record<GoogleCapability, readonly string[]>> = {
  'google-calendar': [
    'calendar.calendars',
    'calendar.subscribe',
    'calendar.unsubscribe',
    'calendar.events',
    'calendar.event',
    'calendar.freebusy',
    'calendar.update',
    'calendar.delete',
    'calendar.respond',
  ],
  'google-mail-read': ['gmail.search', 'gmail.messages.search', 'gmail.thread.get', 'gmail.get'],
  'google-directory': ['people.search'],
  'google-workspace': WORKSPACE_GOG_COMMANDS,
};

/** Each exposed service's key with its skill, each key once and in order: Workspace's five services share one. */
const GOOGLE_KEYS: ReadonlyMap<GoogleCapability, string> = new Map(
  EXPOSED_GOOGLE_SERVICES.map((id) => [AGENT_GOOGLE_SERVICES[id].capability, AGENT_GOOGLE_SERVICES[id].skill]),
);

/**
 * Keys whose commands only the profile's `main` is given (KTD2). A new group
 * stores `all`, so it holds every key; Workspace is main's alone in this
 * slice. Its skill still follows the key, as every Google skill does.
 */
const MAIN_ONLY_KEYS: ReadonlySet<GoogleCapability> = new Set(['google-workspace']);

for (const [capability, skill] of GOOGLE_KEYS) {
  registerCapability(capability, {
    description: CAPABILITY_DESCRIPTIONS[capability],
    default: 'on',
    skills: [skill],
  });
}

/**
 * gog's settings for a group, from the Google keys it holds (KTD1, KTD2). The
 * image sets none, so a group holding no key gets nothing and gog there has
 * no token and reaches no account. A group holding any key gets a placeholder
 * token the gateway replaces with the matching Google token, exactly its
 * keys' commands (Workspace's only when it is the profile's `main`, as this
 * host last read or named it), Gmail sending off, and JSON output with other
 * people's text inside untrusted-content markers. An agent with a shell could
 * change these, so each token's scope stays the real boundary; the command
 * list keeps gog to what the group's skills teach.
 */
registerContainerEnv('gws-ea-google:gog', ({ agentGroupId, capabilities }): Record<string, string> => {
  const main = agentGroupId === knownMainAgentGroupId();
  const commands = [...GOOGLE_KEYS.keys()]
    .filter((key) => capabilities.has(key) && (main || !MAIN_ONLY_KEYS.has(key)))
    .flatMap((key) => GOG_COMMANDS[key]);
  if (commands.length === 0) return {};
  return {
    GOG_ACCESS_TOKEN: GATEWAY_TOKEN_PLACEHOLDER,
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
 * A live token for a host-only Google service (KTD1, KTD6), such as the
 * Gmail token for the assistant's own inbox or the Drive token for the home
 * folder: minted on demand and held only in this host's memory, never in a
 * gateway or a container. A service whose scopes the grant does not hold
 * fails with `GoogleScopeNotGrantedError` without asking Google.
 */
export function hostGoogleAccessToken(service: HostGoogleServiceId): Promise<string> {
  if (!active) return Promise.reject(new Error('Google access is off on this host: it has no Google sign-in'));
  return active.hostAccessToken(service);
}
