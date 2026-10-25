/**
 * Connecting the assistant to Google, in two steps. `sign_in_google` runs
 * before the host starts, since the host talks in Chat as the assistant from
 * its first moment: the Workspace APIs, the OAuth client the operator
 * downloads, and the assistant's own sign-in. `connect_google` runs once the
 * host is up: agents' Google access, which the host publishes, and a live
 * check that the sign-in reaches the assistant's own calendar and Drive.
 *
 * Neither step writes the gateway's Google secrets. The running host's
 * refresher is their only writer, publishing them from a new sign-in on its
 * next tick; `connect_google` waits until it has, reading OneCLI's secret
 * metadata and never its values.
 *
 * The live check runs from here rather than an agent's container: the
 * gateway's injection is OneCLI's fixed behavior, while what varies per
 * assistant is the grant, its scopes, and the secrets.
 */
import { setTimeout as delay } from 'node:timers/promises';

import {
  AGENT_GOOGLE_CREDENTIALS,
  googleCredentialFor,
  missingGoogleScopes,
  scopesOfGrant,
  type GoogleGrant,
} from '../modules/gws-ea-google/grant.js';
import { readGoogleGrantFile } from '../modules/gws-ea-google/grant-file.js';
import {
  GoogleGrantRevokedError,
  mintCredentialToken,
  type CredentialFallback,
  type TokenOptions,
} from '../modules/gws-ea-google/tokens.js';
import type { AssistantGoogleSignInRequest } from './events.js';
import { googleWorkspaceApisResource, type GcloudDependencies, type GcpProjectContext } from './gcloud.js';
import {
  readGoogleOAuthClientFile,
  readJson,
  readStoredGoogleOAuthClient,
  storeGoogleOAuthClient,
  writeGoogleGrant,
  type GoogleOAuthClient,
} from './google-oauth.js';
import { ABSENT, PRESENT, type Observation, type ProvisionHumanPause, type StepResource } from './phases.js';
import { removePrivateFile } from './secrets.js';
import { googleGrantFile, googleOAuthClientFile, instanceOnecliAdmin, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

export const GOOGLE_CLIENT_FILE_FLAG = '--google-client-file';

export const PRIMARY_CALENDAR_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary';

export const DRIVE_ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)';

export interface GoogleConnectionInput {
  readonly runtime: InstanceRuntimeConfig;
  /** The declared Workspace address the sign-in must be. */
  readonly assistantWorkspaceEmail: string;
  /** Names the sign-in client's app; undefined when this run does not know it. */
  readonly assistantName?: string;
  /** `--google-client-file`, when the operator supplied it on this run. */
  readonly clientFile?: string;
  /** The assistant's sign-in through the operator's browser; pauses when no one is at a terminal. */
  readonly signIn: (request: AssistantGoogleSignInRequest) => Promise<GoogleGrant>;
  readonly resumeCommand: string;
}

export interface GoogleConnectionContext extends GcpProjectContext {
  readonly input: GcpProjectContext['input'] & { readonly google: GoogleConnectionInput };
}

export interface GoogleConnectionDependencies {
  readonly gcloud?: GcloudDependencies;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const PUBLISH_POLL_MS = 5_000;
const PUBLISH_ATTEMPTS = 36;

/** Gmail's API host, which any secret able to carry `gmail.modify` must be injected on. */
const GMAIL_HOST = 'gmail.googleapis.com';

export function googleClientConsoleUrl(projectId: string): string {
  const url = new URL('https://console.cloud.google.com/auth/overview');
  url.searchParams.set('project', projectId);
  return url.href;
}

/**
 * The operator does this by hand because Google has no API for it. The app is
 * named after the assistant so the consent page names the operator's own
 * assistant, not a vendor.
 */
export function googleClientSteps(gcp: { projectId: string; account: string }, assistantName?: string): string[] {
  return [
    googleClientConsoleUrl(gcp.projectId),
    'Get started:',
    `  App name: ${assistantName ?? "the assistant's name"}`,
    `  User support email: ${gcp.account}`,
    '  Audience: Internal',
    `  Contact email: ${gcp.account}`,
    '  Agree to the Google API Services: User Data Policy, then Create',
    'Clients, then Create client:',
    '  Application type: Desktop app',
    '  Name: leave the default',
    '  Create, then Download JSON',
  ];
}

export async function googleClientNeeded(google: GoogleConnectionInput): Promise<boolean> {
  if (google.clientFile) return false;
  if (await readGoogleGrantFile(googleGrantFile(google.runtime))) return false;
  return (await readStoredGoogleOAuthClient(googleOAuthClientFile(google.runtime))) === undefined;
}

function clientPause(context: GoogleConnectionContext): ProvisionHumanPause {
  return {
    kind: 'human-action',
    phase: 'sign_in_google',
    code: 'google_client_required',
    message: "Create the assistant's Google sign-in client, then continue with its file.",
    details: googleClientSteps(context.input.gcp, context.input.google.assistantName),
    resumeFlag: `${GOOGLE_CLIENT_FILE_FLAG} <file>`,
  };
}

interface VaultSecret {
  readonly name: string;
  readonly hostPattern: string;
}

/**
 * Not observing the vault is no finding about it, so an unreadable answer is a
 * plain Error, which status reports as unknown.
 */
async function listVaultSecrets(
  runtime: InstanceRuntimeConfig,
  fetchImpl?: typeof globalThis.fetch,
): Promise<VaultSecret[]> {
  const admin = await instanceOnecliAdmin(runtime, fetchImpl ? { fetch: fetchImpl } : {});
  return (await admin.listSecrets()).map((entry) => {
    if (typeof entry.name !== 'string' || typeof entry.hostPattern !== 'string') {
      throw new Error('OneCLI returned an unreadable secret');
    }
    return { name: entry.name, hostPattern: entry.hostPattern };
  });
}

function injectsOn(pattern: string, host: string): boolean {
  if (pattern === '*' || pattern === host) return true;
  return pattern.startsWith('*.') && host.endsWith(pattern.slice(1));
}

function signInProblem(grant: GoogleGrant | undefined, account: string): string | undefined {
  if (!grant) return 'the assistant has not signed in to Google yet';
  return grant.account === account.toLowerCase()
    ? undefined
    : `Google is signed in as ${grant.account}, not the assistant's account ${account}`;
}

function scopeProblem(grant: GoogleGrant): string | undefined {
  const missing = missingGoogleScopes(scopesOfGrant(grant));
  return missing.length > 0 ? `the sign-in lacks ${missing.join(', ')}` : undefined;
}

export function grantProblem(grant: GoogleGrant | undefined, account: string): string | undefined {
  return signInProblem(grant, account) ?? (grant && scopeProblem(grant));
}

function listed(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' or ');
  return `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;
}

/** `partial`: agents hold the rest of their Google access. */
type AccessProblem = { readonly reason: string; readonly partial: boolean };

/**
 * Each credential needs exactly one secret, on its own host. Asked only of a
 * grant holding every scope this release asks for, from which the host
 * publishes every credential.
 */
function publishedAccessProblem(secrets: readonly VaultSecret[]): AccessProblem | undefined {
  const missing: string[] = [];
  for (const credential of AGENT_GOOGLE_CREDENTIALS) {
    const named = secrets.filter((secret) => secret.name === credential.secretName);
    if (named.length === 0) missing.push(credential.secretName);
    else if (named.length > 1) {
      return { reason: `OneCLI holds ${named.length} secrets named ${credential.secretName}`, partial: false };
    } else if (named[0]!.hostPattern !== credential.host) {
      return { reason: `OneCLI's ${credential.secretName} secret is on ${named[0]!.hostPattern}`, partial: false };
    }
  }
  if (missing.length === 0) return undefined;
  return {
    reason: `OneCLI has no ${listed(missing)} secret yet`,
    partial: missing.length < AGENT_GOOGLE_CREDENTIALS.length,
  };
}

/**
 * A secret an agent could use to do more in Gmail than read it: any secret
 * injected on Gmail's host other than the read-only one the host publishes.
 * Metadata cannot tell whether such a secret carries `gmail.modify`, so each
 * one is flagged.
 */
function gmailModifyProblem(secrets: readonly VaultSecret[]): string | undefined {
  const readOnly = googleCredentialFor('gmail-read');
  const broader = secrets.find(
    (secret) =>
      injectsOn(secret.hostPattern, GMAIL_HOST) &&
      !(secret.name === readOnly.secretName && secret.hostPattern === readOnly.host),
  );
  return broader
    ? `OneCLI holds ${broader.name} on ${broader.hostPattern}, which an agent could use to reach Gmail beyond ` +
        "reading it (gmail.modify); remove it from the assistant's OneCLI"
    : undefined;
}

type CalendarCredentialAnswer =
  | { readonly revoked: true }
  | { readonly revoked: false; readonly fallback?: CredentialFallback };

/**
 * Asks Google by minting the credential agents' Calendar rides on: a revoked or
 * expired sign-in is refused, and a Drive refusal leaves Calendar alone in the
 * token the host publishes.
 */
async function calendarCredentialAnswer(
  grant: GoogleGrant,
  tokenOptions: TokenOptions,
): Promise<CalendarCredentialAnswer> {
  try {
    const token = await mintCredentialToken(grant, googleCredentialFor('calendar'), tokenOptions);
    return token?.fallback ? { revoked: false, fallback: token.fallback } : { revoked: false };
  } catch (error) {
    if (error instanceof GoogleGrantRevokedError) return { revoked: true };
    throw error;
  }
}

function refusedBesideCalendar(fallback: CredentialFallback): string {
  return (
    `Google refuses ${fallback.refused.join(', ')} for the assistant's sign-in (${fallback.reason}), ` +
    'so agents have Calendar without it'
  );
}

async function requireGrant(context: GoogleConnectionContext): Promise<GoogleGrant> {
  const google = context.input.google;
  const grant = await readGoogleGrantFile(googleGrantFile(google.runtime));
  const problem = grantProblem(grant, google.assistantWorkspaceEmail);
  if (problem || !grant) throw new GwsEaError('google_not_signed_in', `Cannot reach Google: ${problem}`);
  return grant;
}

function tokenOptionsOf(dependencies: GoogleConnectionDependencies): TokenOptions {
  return {
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
}

export function googleSignInResources(
  dependencies: GoogleConnectionDependencies = {},
): readonly StepResource<GoogleConnectionContext>[] {
  const tokenOptions = tokenOptionsOf(dependencies);
  return [
    googleWorkspaceApisResource(dependencies.gcloud),
    {
      name: "the assistant's Google sign-in client",
      observe: async (context): Promise<Observation> => {
        const { runtime, clientFile } = context.input.google;
        if (await readGoogleGrantFile(googleGrantFile(runtime))) return PRESENT;
        if (await readStoredGoogleOAuthClient(googleOAuthClientFile(runtime))) return PRESENT;
        return clientFile ? ABSENT : { status: 'pause', pause: clientPause(context) };
      },
      apply: async (context) => {
        const { runtime, clientFile } = context.input.google;
        if (!clientFile) return clientPause(context);
        await storeGoogleOAuthClient(googleOAuthClientFile(runtime), await readGoogleOAuthClientFile(clientFile));
        return undefined;
      },
    },
    {
      name: "the assistant's Google sign-in",
      observe: async (context): Promise<Observation> => {
        const google = context.input.google;
        const grant = await readGoogleGrantFile(googleGrantFile(google.runtime));
        const problem = grantProblem(grant, google.assistantWorkspaceEmail);
        if (problem || !grant) return { status: 'absent', reason: problem };
        // A grant on disk proves nothing once Google revokes it; the host's
        // refresher picks up a new sign-in on its next tick.
        return (await calendarCredentialAnswer(grant, tokenOptions)).revoked
          ? { status: 'absent', reason: 'Google no longer accepts the sign-in' }
          : PRESENT;
      },
      apply: async (context) => {
        const google = context.input.google;
        const grantFile = googleGrantFile(google.runtime);
        const clientFile = googleOAuthClientFile(google.runtime);
        const previous = await readGoogleGrantFile(grantFile);
        const client: GoogleOAuthClient | undefined =
          (await readStoredGoogleOAuthClient(clientFile)) ??
          (previous ? { client_id: previous.client_id, client_secret: previous.client_secret } : undefined);
        if (!client) return clientPause(context);
        const grant = await google.signIn({
          client,
          account: google.assistantWorkspaceEmail,
          resumeCommand: google.resumeCommand,
        });
        await writeGoogleGrant(grantFile, grant);
        // The grant now carries the client.
        await removePrivateFile(clientFile);
        return undefined;
      },
    },
  ];
}

export function googleAccessResources(
  dependencies: GoogleConnectionDependencies = {},
): readonly StepResource<GoogleConnectionContext>[] {
  const fetchImpl = dependencies.fetch;
  const sleep = dependencies.sleep ?? ((ms: number) => delay(ms));
  const tokenOptions = tokenOptionsOf(dependencies);
  const accessProblem = async (context: GoogleConnectionContext): Promise<string | undefined> => {
    const secrets = await listVaultSecrets(context.input.google.runtime, fetchImpl);
    await requireGrant(context);
    return publishedAccessProblem(secrets)?.reason;
  };
  return [
    {
      name: "agents' Google access",
      observe: async (context): Promise<Observation> => {
        const problem = await accessProblem(context);
        return problem ? { status: 'absent', reason: problem } : PRESENT;
      },
      // The host publishes; this only waits for it, writing nothing.
      apply: async (context) => {
        await requireGrant(context);
        let problem = await accessProblem(context);
        for (let attempt = 0; problem && attempt < PUBLISH_ATTEMPTS; attempt += 1) {
          await sleep(PUBLISH_POLL_MS);
          problem = await accessProblem(context);
        }
        if (problem) {
          throw new GwsEaError(
            'google_access_unpublished',
            `The assistant's host has not published agents' Google access: ${problem}. ` +
              "Check that the assistant is running, and the host's log for why.",
          );
        }
        return undefined;
      },
    },
    {
      name: "the assistant's own calendar and Drive",
      observe: async (context): Promise<Observation> => {
        const grant = await requireGrant(context);
        // The token agents get on www.googleapis.com, which carries Calendar and Drive together.
        // `requireGrant` holds every scope, so the grant always yields one.
        const token = await mintCredentialToken(grant, googleCredentialFor('calendar'), tokenOptions);
        if (!token) throw new GwsEaError('google_not_signed_in', 'Cannot reach Google: the sign-in grants no Calendar');
        if (token.fallback) return { status: 'absent', reason: refusedBesideCalendar(token.fallback) };
        const read = async (url: string): Promise<{ readonly response: Response; readonly body: unknown }> => {
          const response = await (fetchImpl ?? globalThis.fetch)(url, {
            headers: { authorization: `Bearer ${token.accessToken}` },
            signal: AbortSignal.timeout(15_000),
          });
          return { response, body: await readJson(response) };
        };
        const calendar = await read(PRIMARY_CALENDAR_URL);
        if (!calendar.response.ok) {
          return { status: 'absent', reason: `Google Calendar answered HTTP ${calendar.response.status}` };
        }
        if (!isRecord(calendar.body) || calendar.body.id !== grant.account) {
          return { status: 'absent', reason: "Google Calendar did not return the assistant's own calendar" };
        }
        const drive = await read(DRIVE_ABOUT_URL);
        if (!drive.response.ok) {
          return { status: 'absent', reason: `Google Drive answered HTTP ${drive.response.status}` };
        }
        const user = isRecord(drive.body) ? drive.body.user : undefined;
        const email = isRecord(user) && typeof user.emailAddress === 'string' ? user.emailAddress.toLowerCase() : '';
        return email === grant.account
          ? PRESENT
          : { status: 'absent', reason: 'Google Drive did not answer as the assistant' };
      },
      // Nothing to change: an API that was just enabled can take a minute to answer.
      apply: async () => undefined,
    },
  ];
}

/** For `gws-ea connect-google`, which repairs an existing assistant's connection. */
export function googleConnectionResources(
  dependencies: GoogleConnectionDependencies = {},
): readonly StepResource<GoogleConnectionContext>[] {
  return [...googleSignInResources(dependencies), ...googleAccessResources(dependencies)];
}

export type GoogleConnectionReport =
  | { readonly status: 'connected'; readonly account: string }
  | { readonly status: 'degraded'; readonly account: string | null; readonly reason: string };

/**
 * Changes nothing. Agents' Calendar credential counts as connected only when
 * Google grants it in full, not Calendar alone; each degraded reason names its
 * repair.
 */
export async function observeGoogleConnection(
  runtime: InstanceRuntimeConfig,
  declaredEmail: string,
  dependencies: { readonly fetch?: typeof globalThis.fetch } = {},
): Promise<GoogleConnectionReport> {
  const repair = `connect it with gws-ea connect-google --id ${runtime.instance_id}`;
  const grant = await readGoogleGrantFile(googleGrantFile(runtime));
  const problem = signInProblem(grant, declaredEmail);
  if (problem || !grant) {
    return { status: 'degraded', account: grant?.account ?? null, reason: `${problem}; ${repair}` };
  }
  const degraded = (reason: string): GoogleConnectionReport => ({ status: 'degraded', account: grant.account, reason });
  // Revocation first, so a revoked grant reads as revoked even when it also lacks this release's scopes.
  const calendar = await calendarCredentialAnswer(grant, dependencies.fetch ? { fetch: dependencies.fetch } : {});
  if (calendar.revoked) return degraded(`Google no longer accepts the sign-in; ${repair}`);
  const scopes = scopeProblem(grant);
  if (scopes) return degraded(`${scopes}; ${repair}`);
  const secrets = await listVaultSecrets(runtime, dependencies.fetch);
  const modify = gmailModifyProblem(secrets);
  if (modify) return degraded(modify);
  const access = publishedAccessProblem(secrets);
  if (access) {
    const held = access.partial ? 'only part of their' : 'no';
    return degraded(`agents have ${held} Google access: ${access.reason}; ${repair}`);
  }
  if (calendar.fallback) {
    return degraded(
      `${refusedBesideCalendar(calendar.fallback)}; check that the Workspace admin allows the app, then ${repair}`,
    );
  }
  return { status: 'connected', account: grant.account };
}
