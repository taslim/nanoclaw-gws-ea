/**
 * The assistant's one Google sign-in (KTD2), shared by the control plane,
 * which writes it at setup, and the host, which refreshes it. The grant file
 * holds the OAuth client, the refresh token, the scopes Google granted, and
 * the account; it lives in the instance's owner-only `secrets/` directory and
 * never in a container.
 */
import { canonicalTimestamp, hasControlCharacters, isRecord } from '../../gws-ea/validation.js';

/** What a Google service's access token is limited to. */
export interface GoogleServiceScopes {
  readonly scopes: readonly string[];
}

/**
 * A Google service whose token reaches agents (KTD6): the host publishes it
 * as one gateway credential, which only the agent groups holding the
 * service's capability may use.
 */
export interface AgentGoogleService extends GoogleServiceScopes {
  /** The capability key (src/capabilities.ts) that grants the service. */
  readonly capability: string;
  /** The gateway credential its access token is published as. */
  readonly secretName: string;
  /** The one host the gateway injects it on. */
  readonly hostPattern: string;
  /** The container skill (`container/skills/<skill>/`) that teaches agents to use it. */
  readonly skill: string;
}

export const AGENT_GOOGLE_SERVICES = {
  calendar: {
    capability: 'google-calendar',
    secretName: 'google-calendar',
    hostPattern: 'www.googleapis.com',
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ],
    skill: 'gcalendar',
  },
  'gmail-read': {
    capability: 'google-mail-read',
    secretName: 'google-gmail-read',
    hostPattern: 'gmail.googleapis.com',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    skill: 'gmail',
  },
  directory: {
    capability: 'google-directory',
    secretName: 'google-directory',
    hostPattern: 'people.googleapis.com',
    scopes: ['https://www.googleapis.com/auth/directory.readonly'],
    skill: 'gpeople',
  },
} as const satisfies Record<string, AgentGoogleService>;

/**
 * Google services only the host uses (KTD6): their tokens are minted on
 * demand, held in host memory, and never become a gateway credential. Gmail's
 * modify scope reads and sends the assistant's own inbox. The host's Calendar
 * token, with the same scopes agents' Calendar token has, turns on the
 * principal's calendar notifications and runs the host's calendar actions.
 */
export const HOST_GOOGLE_SERVICES = {
  gmail: { scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  'calendar-host': { scopes: AGENT_GOOGLE_SERVICES.calendar.scopes },
} as const satisfies Record<string, GoogleServiceScopes>;

export type AgentGoogleServiceId = keyof typeof AGENT_GOOGLE_SERVICES;
export type HostGoogleServiceId = keyof typeof HOST_GOOGLE_SERVICES;
export type GoogleServiceId = AgentGoogleServiceId | HostGoogleServiceId;

export const GOOGLE_SERVICES: Readonly<Record<GoogleServiceId, GoogleServiceScopes>> = {
  ...AGENT_GOOGLE_SERVICES,
  ...HOST_GOOGLE_SERVICES,
};

/** The services whose tokens reach agents, each to the groups holding its capability. */
export const EXPOSED_GOOGLE_SERVICES: readonly AgentGoogleServiceId[] = ['calendar', 'gmail-read', 'directory'];

/** The skills of the exposed services; each reaches only a group holding its service's capability. */
export const EXPOSED_GOOGLE_SKILLS: readonly string[] = EXPOSED_GOOGLE_SERVICES.map(
  (id) => AGENT_GOOGLE_SERVICES[id].skill,
);

/** What the sign-in asks for, each once: the account's identity, and every service, agent-facing and host-only. */
export const GOOGLE_SIGN_IN_SCOPES: readonly string[] = [
  ...new Set(['openid', 'email', ...Object.values(GOOGLE_SERVICES).flatMap((service) => service.scopes)]),
];

/** The scopes a grant must hold: the identity scopes Google reports in full form, and every service's. */
const IDENTITY_SCOPE_FORMS: Readonly<Record<string, readonly string[]>> = {
  openid: ['openid'],
  email: ['email', 'https://www.googleapis.com/auth/userinfo.email'],
};

/** The required scopes a granted set lacks; Google may report `email` in its long form. */
export function missingGoogleScopes(granted: readonly string[]): string[] {
  const held = new Set(granted);
  return GOOGLE_SIGN_IN_SCOPES.filter((scope) => !(IDENTITY_SCOPE_FORMS[scope] ?? [scope]).some((f) => held.has(f)));
}

export const GOOGLE_GRANT_SCHEMA_VERSION = 1 as const;

export interface GoogleGrant {
  readonly schema_version: typeof GOOGLE_GRANT_SCHEMA_VERSION;
  /** The signed-in account, lowercased: the assistant's own Workspace address. */
  readonly account: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
  /** The scopes Google reported granting. */
  readonly scopes: readonly string[];
  readonly granted_at: string;
}

/** The grant file's name in the instance's `secrets/` directory. */
export const GOOGLE_GRANT_FILE_NAME = 'google-grant.json';

/** The host's environment key naming the grant file. */
export const GOOGLE_GRANT_FILE_ENV = 'GWS_EA_GOOGLE_GRANT_FILE';

function requireText(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || hasControlCharacters(value)) {
    throw new Error(`Google grant ${label} is invalid`);
  }
  return value;
}

/** Parse a grant file's content; any other shape is refused rather than used. */
export function parseGoogleGrant(value: unknown): GoogleGrant {
  if (!isRecord(value)) throw new Error('Google grant is invalid');
  if (value.schema_version !== GOOGLE_GRANT_SCHEMA_VERSION) throw new Error('Google grant schema is unsupported');
  const scopes = value.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('Google grant scopes are invalid');
  const grantedAt = requireText(value.granted_at, 'time', 64);
  if (canonicalTimestamp(grantedAt) === undefined) throw new Error('Google grant time is invalid');
  return {
    schema_version: GOOGLE_GRANT_SCHEMA_VERSION,
    account: requireText(value.account, 'account', 254).toLowerCase(),
    client_id: requireText(value.client_id, 'client ID', 512),
    client_secret: requireText(value.client_secret, 'client secret', 512),
    refresh_token: requireText(value.refresh_token, 'refresh token'),
    scopes: scopes.map((scope, index) => requireText(scope, `scope ${index + 1}`, 512)),
    granted_at: grantedAt,
  };
}
