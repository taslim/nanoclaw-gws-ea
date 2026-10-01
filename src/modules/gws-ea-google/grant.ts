/**
 * The assistant's one Google sign-in (KTD2), shared by the control plane,
 * which writes it at setup, and the host, which refreshes it. The grant file
 * holds the OAuth client, the refresh token, the scopes Google granted, and
 * the account; it lives in the instance's owner-only `secrets/` directory and
 * never in a container.
 */

/** A Google service the release can expose to agents, each through its own OneCLI secret. */
export interface GoogleService {
  /** The OneCLI secret its access token is injected from. */
  readonly secretName: string;
  /** The host OneCLI injects it on. */
  readonly hostPattern: string;
  /** What its access token is limited to. */
  readonly scopes: readonly string[];
}

export const GOOGLE_SERVICES = {
  calendar: {
    secretName: 'google-calendar',
    hostPattern: 'www.googleapis.com',
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist',
      'https://www.googleapis.com/auth/calendar.freebusy',
    ],
  },
  gmail: {
    secretName: 'google-gmail',
    hostPattern: 'gmail.googleapis.com',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  },
} as const satisfies Record<string, GoogleService>;

export type GoogleServiceId = keyof typeof GOOGLE_SERVICES;

/** The services whose tokens reach agents in this release. Gmail is consented but not exposed until Checkpoint 4. */
export const EXPOSED_GOOGLE_SERVICES: readonly GoogleServiceId[] = ['calendar'];

/** What the sign-in asks for: the account's identity, and every service the slice uses. */
export const GOOGLE_SIGN_IN_SCOPES: readonly string[] = [
  'openid',
  'email',
  ...GOOGLE_SERVICES.calendar.scopes,
  ...GOOGLE_SERVICES.gmail.scopes,
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
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\p{Cc}]/u.test(value)) {
    throw new Error(`Google grant ${label} is invalid`);
  }
  return value;
}

/** Parse a grant file's content; any other shape is refused rather than used. */
export function parseGoogleGrant(value: unknown): GoogleGrant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Google grant is invalid');
  const record = value as Record<string, unknown>;
  if (record.schema_version !== GOOGLE_GRANT_SCHEMA_VERSION) throw new Error('Google grant schema is unsupported');
  const scopes = record.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('Google grant scopes are invalid');
  const grantedAt = requireText(record.granted_at, 'time', 64);
  if (Number.isNaN(Date.parse(grantedAt)) || new Date(grantedAt).toISOString() !== grantedAt) {
    throw new Error('Google grant time is invalid');
  }
  return {
    schema_version: GOOGLE_GRANT_SCHEMA_VERSION,
    account: requireText(record.account, 'account', 254).toLowerCase(),
    client_id: requireText(record.client_id, 'client ID', 512),
    client_secret: requireText(record.client_secret, 'client secret', 512),
    refresh_token: requireText(record.refresh_token, 'refresh token'),
    scopes: scopes.map((scope, index) => requireText(scope, `scope ${index + 1}`, 512)),
    granted_at: grantedAt,
  };
}
