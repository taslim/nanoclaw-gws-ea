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
 * file is. From the moment this module loads, the host mints its own tokens
 * from the grant and holds them in memory; while it runs, it also publishes
 * one token per agent credential's host through the selected gateway's
 * credential connection.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { registerCapability } from '../../capabilities.js';
import { registerContainerEnv } from '../../container-env.js';
import { getGatewayProvider, withholdGatewayAgentSkills } from '../../gateway-providers/index.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { knownMainAgentGroupId } from '../gws-ea-profile/db.js';
import {
  AGENT_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SERVICES,
  type GoogleCapability,
  type HostGoogleServiceId,
} from './grant.js';
import { googleGrantFilePath, readGoogleGrantFile } from './grant-file.js';
import { createGoogleTokenRefresher, GATEWAY_TOKEN_PLACEHOLDER } from './refresher.js';
import { createHostTokenSource, GoogleNotSignedInError, type HostTokenSource } from './tokens.js';
import { WORKSPACE_GOG_COMMANDS } from './workspace-commands.js';

/** How often the host checks whether a token needs renewing. */
const TICK_MS = 60_000;

const CAPABILITY_DESCRIPTIONS: Readonly<Record<GoogleCapability, string>> = {
  'google-calendar':
    "Google Calendar as the assistant: the gcalendar skill, the assistant's Calendar token, create_event, change_guests and respond_to_event, and the host's find_conflicts and people_stats",
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
 * host's `create_event` and `calendar.create` is off. gog refuses to answer
 * an event the principal organizes, so every answer goes through the host's
 * `respond_to_event` and `calendar.respond` is off. Workspace's are gog's
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
 * No agent here is handed the gateway's own agent skill. The Google skills
 * teach the way to Google, through gog with the host's tokens, and what to do
 * when that connection fails: only the operator reconnects it, and no agent
 * sends anyone a link to sign in. The gateway's skill would teach a second
 * way beside it, connect links included, to every group with a shell,
 * groups main creates among them. The gateway still carries their traffic.
 */
withholdGatewayAgentSkills();

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

/** Where this host finds the assistant's grant, read as the module loads; undefined without a Google sign-in. */
const grantFile = googleGrantFilePath();

/**
 * The host's own tokens (KTD5), built as the module loads from the grant
 * alone: channels start before the host's modules, so Chat has its token
 * before any module's start runs, whatever the gateway stores.
 */
const hostTokens: HostTokenSource | undefined =
  grantFile === undefined ? undefined : createHostTokenSource({ readGrant: () => readGoogleGrantFile(grantFile) });

onHostStart(async ({ signal }) => {
  if (grantFile === undefined) return;
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
  // Started, not awaited: host startup never waits on Google.
  void (async () => {
    while (!signal.aborted) {
      await refresher.tick();
      await delay(TICK_MS, undefined, { signal }).catch(() => undefined);
    }
  })();
});

/**
 * A live token for a host-only Google service (KTD1, KTD5, KTD6), such as the
 * Gmail token for the assistant's own inbox, the Drive token for the home
 * folder, or the Chat token the assistant talks with: minted on demand and
 * held only in this host's memory, never in a gateway or a container. It is
 * served from the moment this module loads, before any module starts. A
 * service whose scopes the grant does not hold fails with
 * `GoogleScopeNotGrantedError` without asking Google.
 */
export function hostGoogleAccessToken(service: HostGoogleServiceId): Promise<string> {
  if (!hostTokens) {
    return Promise.reject(new GoogleNotSignedInError('Google access is off on this host: it has no Google sign-in'));
  }
  return hostTokens.accessToken(service);
}

/** The assistant's Google account, as its sign-in names it. */
export interface AssistantGoogleAccount {
  /** Its Workspace address, lowercased. */
  readonly account: string;
  /** Its Google ID: Chat knows the assistant as `users/{sub}`. */
  readonly sub: string;
}

/**
 * The assistant's account from this host's grant, or undefined on a host
 * without a Google sign-in or before the assistant signs in. A grant the host
 * cannot read is refused, as everywhere else.
 */
export async function assistantGoogleAccount(): Promise<AssistantGoogleAccount | undefined> {
  if (grantFile === undefined) return undefined;
  const grant = await readGoogleGrantFile(grantFile);
  return grant && { account: grant.account, sub: grant.sub };
}
