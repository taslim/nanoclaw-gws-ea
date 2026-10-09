/**
 * Connecting the assistant to Google (KTD2, KTD5, KTD6): the resources of
 * the `connect_google` step, which `gws-ea connect-google` also runs on an
 * existing assistant. In order: the Workspace APIs in the assistant's
 * project, the OAuth client the operator downloads, the assistant's own
 * sign-in, agents' Google access, and a live check that the sign-in reaches
 * the assistant's own calendar. Each observes before it changes anything, so
 * running them again changes nothing.
 *
 * This step writes only the grant file. The running host's refresher is the
 * only writer of the gateway's Google secrets: it publishes them from a new
 * sign-in on its next tick, and this step waits until it has, reading
 * OneCLI's secret metadata and never its values.
 *
 * The live check runs from here rather than an agent's container: the
 * gateway's injection is OneCLI's fixed behavior, proven live once (U1),
 * while what varies per assistant is the grant, its scopes, and the secrets.
 */
import { setTimeout as delay } from 'node:timers/promises';

import {
  AGENT_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SERVICES,
  missingGoogleScopes,
  type GoogleGrant,
} from '../modules/gws-ea-google/grant.js';
import { readGoogleGrantFile } from '../modules/gws-ea-google/grant-file.js';
import { GoogleGrantRevokedError, mintServiceToken, type TokenOptions } from '../modules/gws-ea-google/tokens.js';
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

/** The resume flag that supplies the downloaded OAuth client. */
export const GOOGLE_CLIENT_FILE_FLAG = '--google-client-file';

/** Where the assistant's own primary calendar is read to prove the connection. */
export const PRIMARY_CALENDAR_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary';

export interface GoogleConnectionInput {
  readonly runtime: InstanceRuntimeConfig;
  /** The declared Workspace address the sign-in must be. */
  readonly assistantWorkspaceEmail: string;
  /** `--google-client-file`, when the operator supplied it on this run. */
  readonly clientFile?: string;
  /** The assistant's sign-in through the operator's browser; pauses when no one is at a terminal. */
  readonly signIn: (request: AssistantGoogleSignInRequest) => Promise<GoogleGrant>;
  /** The command that continues this run. */
  readonly resumeCommand: string;
}

export interface GoogleConnectionContext extends GcpProjectContext {
  readonly input: GcpProjectContext['input'] & { readonly google: GoogleConnectionInput };
}

export interface GoogleConnectionDependencies {
  readonly gcloud?: GcloudDependencies;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** How the step waits between looks at the gateway while the host publishes. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** How often, and for how long, the step looks for the secrets the host publishes. */
const PUBLISH_POLL_MS = 5_000;
const PUBLISH_ATTEMPTS = 36;

/** Gmail's API host, which any secret able to carry `gmail.modify` must be injected on. */
const GMAIL_HOST = 'gmail.googleapis.com';

function consoleUrl(projectId: string): string {
  const url = new URL('https://console.cloud.google.com/auth/overview');
  url.searchParams.set('project', projectId);
  return url.href;
}

function clientPause(context: GoogleConnectionContext): ProvisionHumanPause {
  return {
    kind: 'human-action',
    phase: 'connect_google',
    code: 'google_client_required',
    message: "Create the assistant's Google sign-in client, then continue with its file.",
    details: [
      'Choose Get started: name the app after the assistant, pick your email for support, choose Internal, add a contact email, and create it.',
      'Under Clients, create a client of type Desktop app, and download its JSON.',
    ],
    actionUrl: consoleUrl(context.input.gcp.projectId),
    resumeFlag: `${GOOGLE_CLIENT_FILE_FLAG} <file>`,
  };
}

/** One OneCLI secret's metadata. Values never come back from this read. */
interface VaultSecret {
  readonly name: string;
  readonly hostPattern: string;
}

/**
 * Every secret OneCLI holds for this instance, by name and host, read with
 * the instance's admin key. Not observing the vault is no finding about it:
 * status reports a failed read as unknown.
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

/** Whether a OneCLI host pattern injects on `host`: the host itself, or a wildcard covering it. */
function injectsOn(pattern: string, host: string): boolean {
  if (pattern === '*' || pattern === host) return true;
  return pattern.startsWith('*.') && host.endsWith(pattern.slice(1));
}

/** Whether `grant` is the declared account's, with every scope this release asks for; else why not. */
export function grantProblem(grant: GoogleGrant | undefined, account: string): string | undefined {
  if (!grant) return 'the assistant has not signed in to Google yet';
  if (grant.account !== account.toLowerCase()) {
    return `Google is signed in as ${grant.account}, not the assistant's account ${account}`;
  }
  const missing = missingGoogleScopes(grant.scopes);
  return missing.length > 0 ? `the sign-in lacks ${missing.join(', ')}` : undefined;
}

function listed(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' or ');
  return `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;
}

/**
 * Why the secrets the host publishes do not each inject exactly one token on
 * their service's host, or undefined when they do. Secrets the host has not
 * published yet are named together.
 */
function publishedAccessProblem(secrets: readonly VaultSecret[]): string | undefined {
  const missing: string[] = [];
  for (const id of EXPOSED_GOOGLE_SERVICES) {
    const service = AGENT_GOOGLE_SERVICES[id];
    const named = secrets.filter((secret) => secret.name === service.secretName);
    if (named.length === 0) missing.push(service.secretName);
    else if (named.length > 1) return `OneCLI holds ${named.length} secrets named ${service.secretName}`;
    else if (named[0]!.hostPattern !== service.hostPattern) {
      return `OneCLI's ${service.secretName} secret is on ${named[0]!.hostPattern}`;
    }
  }
  return missing.length > 0 ? `OneCLI has no ${listed(missing)} secret yet` : undefined;
}

/**
 * A secret an agent could use to do more in Gmail than read it: any secret
 * injected on Gmail's host other than the read-only one the host publishes.
 * The stale `google-gmail` secret carries `gmail.modify`; any other cannot be
 * told apart from it by metadata, so it is flagged alike.
 */
function gmailModifyProblem(secrets: readonly VaultSecret[]): string | undefined {
  const readOnly = AGENT_GOOGLE_SERVICES['gmail-read'];
  const broader = secrets.find(
    (secret) =>
      injectsOn(secret.hostPattern, GMAIL_HOST) &&
      !(secret.name === readOnly.secretName && secret.hostPattern === readOnly.hostPattern),
  );
  return broader
    ? `OneCLI holds ${broader.name} on ${broader.hostPattern}, which an agent could use to reach Gmail beyond ` +
        "reading it (gmail.modify); remove it from the assistant's OneCLI"
    : undefined;
}

/** Whether Google still honors `grant`: a revoked or expired sign-in is absent, so applying signs in again. */
async function grantAccepted(grant: GoogleGrant, tokenOptions: TokenOptions): Promise<boolean> {
  try {
    await mintServiceToken(grant, 'calendar', tokenOptions);
    return true;
  } catch (error) {
    if (error instanceof GoogleGrantRevokedError) return false;
    throw error;
  }
}

async function requireGrant(context: GoogleConnectionContext): Promise<GoogleGrant> {
  const google = context.input.google;
  const grant = await readGoogleGrantFile(googleGrantFile(google.runtime));
  const problem = grantProblem(grant, google.assistantWorkspaceEmail);
  if (problem || !grant) throw new GwsEaError('google_not_signed_in', `Cannot reach Google: ${problem}`);
  return grant;
}

export function googleConnectionResources(
  dependencies: GoogleConnectionDependencies = {},
): readonly StepResource<GoogleConnectionContext>[] {
  const fetchImpl = dependencies.fetch;
  const sleep = dependencies.sleep ?? ((ms: number) => delay(ms));
  const tokenOptions: TokenOptions = {
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
  const accessProblem = async (context: GoogleConnectionContext): Promise<string | undefined> =>
    publishedAccessProblem(await listVaultSecrets(context.input.google.runtime, fetchImpl));
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
        return (await grantAccepted(grant, tokenOptions))
          ? PRESENT
          : { status: 'absent', reason: 'Google no longer accepts the sign-in' };
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
      name: "the assistant's own calendar",
      observe: async (context): Promise<Observation> => {
        const grant = await requireGrant(context);
        const token = await mintServiceToken(grant, 'calendar', tokenOptions);
        const response = await (fetchImpl ?? globalThis.fetch)(PRIMARY_CALENDAR_URL, {
          headers: { authorization: `Bearer ${token.accessToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        const body = await readJson(response);
        if (!response.ok) return { status: 'absent', reason: `Google Calendar answered HTTP ${response.status}` };
        const id = isRecord(body) ? body.id : undefined;
        return id === grant.account
          ? PRESENT
          : { status: 'absent', reason: "Google Calendar did not return the assistant's own calendar" };
      },
      // Nothing to change: a Calendar API that was just enabled can take a minute to answer.
      apply: async () => undefined,
    },
  ];
}

/** The assistant's Google connection as `status` reports it. */
export type GoogleConnectionReport =
  | { readonly status: 'connected'; readonly account: string }
  | { readonly status: 'degraded'; readonly account: string | null; readonly reason: string };

/**
 * Observe the connection without changing it: the grant is the declared
 * account's with every scope, Google still accepts it, no secret lets an
 * agent modify Gmail, and OneCLI holds each secret the host publishes for
 * agents. Each problem names what repairs it.
 */
export async function observeGoogleConnection(
  runtime: InstanceRuntimeConfig,
  declaredEmail: string,
  dependencies: { readonly fetch?: typeof globalThis.fetch } = {},
): Promise<GoogleConnectionReport> {
  const repair = `connect it with gws-ea connect-google --id ${runtime.instance_id}`;
  const grant = await readGoogleGrantFile(googleGrantFile(runtime));
  const problem = grantProblem(grant, declaredEmail);
  if (problem || !grant)
    return { status: 'degraded', account: grant?.account ?? null, reason: `${problem}; ${repair}` };
  if (!(await grantAccepted(grant, dependencies.fetch ? { fetch: dependencies.fetch } : {}))) {
    return { status: 'degraded', account: grant.account, reason: `Google no longer accepts the sign-in; ${repair}` };
  }
  const secrets = await listVaultSecrets(runtime, dependencies.fetch);
  const modify = gmailModifyProblem(secrets);
  if (modify) return { status: 'degraded', account: grant.account, reason: modify };
  const access = publishedAccessProblem(secrets);
  if (access) {
    return { status: 'degraded', account: grant.account, reason: `agents have no Google access: ${access}; ${repair}` };
  }
  return { status: 'connected', account: grant.account };
}
