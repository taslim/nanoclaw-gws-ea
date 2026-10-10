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
 * A Google service agents reach (KTD6): its capability decides which agent
 * groups are taught to use it, with its skill and gog's commands for it.
 * Its token reaches agents through the credential of the host it is served
 * on (`AGENT_GOOGLE_CREDENTIALS`).
 */
export interface AgentGoogleService extends GoogleServiceScopes {
  /** The capability key (src/capabilities.ts) that grants the service. */
  readonly capability: string;
  /** The container skill (`container/skills/<skill>/`) that teaches agents to use it. */
  readonly skill: string;
}

/** Drive, Docs, Sheets, Slides and Forms are one capability, taught by one skill. */
const WORKSPACE = { capability: 'google-workspace', skill: 'gworkspace' } as const;

export const AGENT_GOOGLE_SERVICES = {
  calendar: {
    capability: 'google-calendar',
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ],
    skill: 'gcalendar',
  },
  'gmail-read': {
    capability: 'google-mail-read',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    skill: 'gmail',
  },
  directory: {
    capability: 'google-directory',
    scopes: ['https://www.googleapis.com/auth/directory.readonly'],
    skill: 'gpeople',
  },
  drive: { ...WORKSPACE, scopes: ['https://www.googleapis.com/auth/drive'] },
  docs: { ...WORKSPACE, scopes: ['https://www.googleapis.com/auth/documents'] },
  sheets: { ...WORKSPACE, scopes: ['https://www.googleapis.com/auth/spreadsheets'] },
  slides: { ...WORKSPACE, scopes: ['https://www.googleapis.com/auth/presentations'] },
  forms: {
    ...WORKSPACE,
    scopes: ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'],
  },
} as const satisfies Record<string, AgentGoogleService>;

export type AgentGoogleServiceId = keyof typeof AGENT_GOOGLE_SERVICES;

/**
 * One gateway credential the host publishes for agents (KTD1): a token
 * injected on exactly one host, since the gateway matches a credential by
 * exact host (`src/gateway-providers/credential-connection.ts`), carrying the
 * scopes of every service served there.
 */
export interface AgentGoogleCredential {
  /** The one host the gateway injects it on. */
  readonly host: string;
  /** The gateway credential its access token is published as. */
  readonly secretName: string;
  /** The services served on the host. The first is the one it keeps when Google refuses the rest. */
  readonly services: readonly AgentGoogleServiceId[];
}

/**
 * One credential per Google host. Drive v3 has no host of its own, so it
 * rides with Calendar on `www.googleapis.com`, whose credential keeps the
 * vault name it had before: renaming it would need removal logic the
 * credential seam does not have, and would break a rollback.
 */
export const AGENT_GOOGLE_CREDENTIALS: readonly AgentGoogleCredential[] = [
  { host: 'www.googleapis.com', secretName: 'google-calendar', services: ['calendar', 'drive'] },
  { host: 'gmail.googleapis.com', secretName: 'google-gmail-read', services: ['gmail-read'] },
  { host: 'people.googleapis.com', secretName: 'google-directory', services: ['directory'] },
  { host: 'docs.googleapis.com', secretName: 'google-docs', services: ['docs'] },
  { host: 'sheets.googleapis.com', secretName: 'google-sheets', services: ['sheets'] },
  { host: 'slides.googleapis.com', secretName: 'google-slides', services: ['slides'] },
  { host: 'forms.googleapis.com', secretName: 'google-forms', services: ['forms'] },
];

/** Every host where the gateway injects a Google token for agents. */
export const AGENT_GOOGLE_HOSTS: readonly string[] = AGENT_GOOGLE_CREDENTIALS.map((credential) => credential.host);

/** The credential serving `service`. */
export function googleCredentialFor(service: AgentGoogleServiceId): AgentGoogleCredential {
  const credential = AGENT_GOOGLE_CREDENTIALS.find((candidate) => candidate.services.includes(service));
  if (!credential) throw new Error(`No Google credential serves ${service}`);
  return credential;
}

/**
 * Google services only the host uses (KTD6): their tokens are minted on
 * demand, held in host memory, and never become a gateway credential. Gmail's
 * modify scope reads and sends the assistant's own inbox. The host's Calendar
 * token, with the same scopes agents' Calendar token has, turns on the
 * principal's calendar notifications and runs the host's calendar actions.
 * The host's Drive token keeps the home folder, checks links, and enriches
 * activity notices; it has the scope agents' `www.googleapis.com` token
 * carries, so it keeps a token out of the gateway but is no privilege
 * boundary.
 */
export const HOST_GOOGLE_SERVICES = {
  gmail: { scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
  'calendar-host': { scopes: AGENT_GOOGLE_SERVICES.calendar.scopes },
  'drive-host': { scopes: AGENT_GOOGLE_SERVICES.drive.scopes },
} as const satisfies Record<string, GoogleServiceScopes>;

export type HostGoogleServiceId = keyof typeof HOST_GOOGLE_SERVICES;
export type GoogleServiceId = AgentGoogleServiceId | HostGoogleServiceId;

export const GOOGLE_SERVICES: Readonly<Record<GoogleServiceId, GoogleServiceScopes>> = {
  ...AGENT_GOOGLE_SERVICES,
  ...HOST_GOOGLE_SERVICES,
};

/**
 * The services agents reach. Each credential carries the scopes of its
 * exposed services that the grant holds, so a scope reaches agents only once
 * its service is listed here and the operator has granted it. Each service
 * also brings its capability, its skill, and gog's commands for it to the
 * groups holding the capability.
 */
export const EXPOSED_GOOGLE_SERVICES: readonly AgentGoogleServiceId[] = [
  'calendar',
  'gmail-read',
  'directory',
  'drive',
  'docs',
  'sheets',
  'slides',
  'forms',
];

/** The capability key of a Google service agents reach. */
export type GoogleCapability = (typeof AGENT_GOOGLE_SERVICES)[AgentGoogleServiceId]['capability'];

/**
 * The exposed services' skills, each once, since Drive, Docs, Sheets, Slides
 * and Forms share one. Each reaches only a group holding its capability.
 */
export const EXPOSED_GOOGLE_SKILLS: readonly string[] = [
  ...new Set(EXPOSED_GOOGLE_SERVICES.map((id) => AGENT_GOOGLE_SERVICES[id].skill)),
];

/** The scopes of `wanted` that `granted` holds, each once, in `wanted`'s order. */
export function grantedScopes(wanted: readonly string[], granted: readonly string[]): string[] {
  const held = new Set(granted);
  return [...new Set(wanted)].filter((scope) => held.has(scope));
}

/**
 * What a credential's token asks for (KTD1): the scopes of its exposed
 * services that `granted` holds. Empty means the host publishes nothing for it.
 */
export function credentialScopes(credential: AgentGoogleCredential, granted: readonly string[]): string[] {
  const wanted = credential.services
    .filter((id) => EXPOSED_GOOGLE_SERVICES.includes(id))
    .flatMap((id) => AGENT_GOOGLE_SERVICES[id].scopes);
  return grantedScopes(wanted, granted);
}

/**
 * What the sign-in asks for beyond its services' scopes. The grant never
 * leaves the host and is the assistant's own account, so the sign-in holds
 * every supported product's broadest scopes and the read-only variants a
 * narrower token can be cut to. A new capability then needs no new sign-in,
 * and each token still carries only what its services want. The read-only
 * variants are asked for by name because minting asks Google for an exact
 * subset of the granted scopes: a token wanting `drive.readonly` gets it only
 * from a grant that lists it.
 */
const SIGN_IN_CEILING: readonly string[] = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.activity.readonly',
  'https://www.googleapis.com/auth/drive.labels.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
  'https://www.googleapis.com/auth/forms.body.readonly',
];

/**
 * What the sign-in asks for, each once: the account's identity, every
 * service's scopes (agent-facing and host-only), and the ceiling beyond them.
 * A grant lacking any of them needs a new sign-in.
 */
export const GOOGLE_SIGN_IN_SCOPES: readonly string[] = [
  ...new Set([
    'openid',
    'email',
    ...Object.values(GOOGLE_SERVICES).flatMap((service) => service.scopes),
    ...SIGN_IN_CEILING,
  ]),
];

/** The scopes a grant must hold: the identity scopes Google reports in full form, and the rest of the sign-in's. */
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

/** A sign-in's identity: a new sign-in, even of the same account, is a new identity. */
export function googleGrantIdentity(grant: GoogleGrant): string {
  return `${grant.account}\0${grant.granted_at}`;
}

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
