/**
 * GWS-EA's Google access. Each Google service agents reach is a capability:
 * a group holding the key is handed the service's skill and gog's commands
 * for it, and a group without it gets neither. The keys are on by default,
 * so a group on `all`, `main` among them, holds every one. Nothing here
 * rewrites a group's configuration.
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

const TICK_MS = 60_000;

const CAPABILITY_DESCRIPTIONS: Readonly<Record<GoogleCapability, string>> = {
  'google-calendar':
    "Google Calendar as the assistant: the gcalendar skill, the assistant's Calendar token, days, check, create_event, change_event, cancel_event, change_guests, respond_to_event and people_stats through main’s host tools",
  'google-mail-read': "the assistant's Gmail, read-only: the gmail skill and a gmail.readonly token",
  'google-directory': 'the Workspace directory, read-only: the gpeople skill and a directory.readonly token',
  'google-workspace':
    "Drive, Docs, Sheets, Slides and Forms as the assistant: the gworkspace skill, the assistant's tokens for them, and, for the profile's main alone, gog's whole surface for them",
};

/**
 * gog v0.43.0's exact command paths (`GOG_ENABLE_COMMANDS_EXACT`, where a
 * parent does not enable its children); each key's skill teaches only these.
 * Events are read and written only through main's host calendar tools, which
 * keep the principal on their own events, check invitations for private
 * details, log each write and add the day's findings, so gog keeps just the
 * calendar list and its subscriptions.
 */
export const GOG_COMMANDS: Readonly<Record<GoogleCapability, readonly string[]>> = {
  'google-calendar': ['calendar.calendars', 'calendar.subscribe', 'calendar.unsubscribe'],
  'google-mail-read': ['gmail.search', 'gmail.messages.search', 'gmail.thread.get', 'gmail.get'],
  'google-directory': ['people.search'],
  'google-workspace': WORKSPACE_GOG_COMMANDS,
};

const GOOGLE_KEYS: ReadonlyMap<GoogleCapability, string> = new Map(
  EXPOSED_GOOGLE_SERVICES.map((id) => [AGENT_GOOGLE_SERVICES[id].capability, AGENT_GOOGLE_SERVICES[id].skill]),
);

/**
 * Keys whose gog commands only the profile's `main` is given, since a new
 * group stores `all` and so holds every key. The skill still follows the key,
 * as every Google skill does.
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
 * The image sets no gog settings, so in a group holding no Google key gog has
 * no token and reaches no account. `main` is the profile's as this host last
 * read or named it. An agent with a shell could change these settings, so
 * each token's scope stays the real boundary; the command list keeps gog to
 * what the group's skills teach.
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

const grantFile = googleGrantFilePath();

/**
 * Built as the module loads from the grant alone: channels start before the
 * host's modules, so Chat has its token before any module's start runs,
 * whatever the gateway stores.
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
 * Held only in this host's memory, never in a gateway or a container, and
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

export interface AssistantGoogleAccount {
  /** Its Workspace address, lowercased. */
  readonly account: string;
  /** Its Google ID: Chat knows the assistant as `users/{sub}`. */
  readonly sub: string;
}

/**
 * Undefined on a host without a Google sign-in or before the assistant signs
 * in; a grant the host cannot read throws, as everywhere else.
 */
export async function assistantGoogleAccount(): Promise<AssistantGoogleAccount | undefined> {
  if (grantFile === undefined) return undefined;
  const grant = await readGoogleGrantFile(grantFile);
  return grant && { account: grant.account, sub: grant.sub };
}
