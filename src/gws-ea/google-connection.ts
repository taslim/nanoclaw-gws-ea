/**
 * Connecting the assistant to Google (KTD2, KTD5): the resources of the
 * `connect_google` step, which `gws-ea google connect` also runs on an
 * existing assistant. In order: the Workspace APIs in the assistant's
 * project, the OAuth client the operator downloads, the assistant's own
 * sign-in, the Calendar token in OneCLI, and a live check that the token
 * reaches the assistant's own calendar. Each observes before it changes
 * anything, so running them again changes nothing.
 *
 * The live check runs from here rather than an agent's container: the
 * gateway's injection is OneCLI's fixed behavior, proven live once (U1),
 * while what varies per assistant is the grant, its scopes, and the secret.
 */
import { GOOGLE_SERVICES, missingGoogleScopes, type GoogleGrant } from '../modules/gws-ea-google/grant.js';
import { readGoogleGrantFile } from '../modules/gws-ea-google/grant-file.js';
import { findInjectedSecret, upsertBearerSecret, type OnecliApi } from '../modules/gws-ea-google/onecli-secrets.js';
import { GoogleGrantRevokedError, mintServiceToken } from '../modules/gws-ea-google/tokens.js';
import type { AssistantGoogleSignInRequest } from './events.js';
import { googleWorkspaceApisResource, type GcloudDependencies, type GcpProjectContext } from './gcloud.js';
import {
  readGoogleOAuthClientFile,
  readStoredGoogleOAuthClient,
  storeGoogleOAuthClient,
  writeGoogleGrant,
  type GoogleOAuthClient,
} from './google-oauth.js';
import { ABSENT, PRESENT, type Observation, type ProvisionHumanPause, type StepResource } from './phases.js';
import { readOwnerOnlyFile, removePrivateFile } from './secrets.js';
import { googleGrantFile, googleOAuthClientFile, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';

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
}

function consoleUrl(projectId: string): string {
  const url = new URL('https://console.cloud.google.com/auth/clients');
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
      'In Google Auth platform, set the audience to Internal.',
      'Under Clients, create an OAuth client of type Desktop app and download its JSON.',
      'Make the file readable only by you: chmod 600 <file>',
    ],
    actionUrl: consoleUrl(context.input.gcp.projectId),
    resumeFlag: `${GOOGLE_CLIENT_FILE_FLAG} <file>`,
  };
}

async function onecliApi(runtime: InstanceRuntimeConfig, fetchImpl?: typeof globalThis.fetch): Promise<OnecliApi> {
  const apiKey = (await readOwnerOnlyFile(runtime.secret_files.onecli_admin_api_key)).trim();
  if (!apiKey) throw new GwsEaError('invalid_secret', 'The OneCLI administrative credential is empty');
  return { url: runtime.onecli_app_url, apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
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
  const tokenOptions = {
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
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
        return problem ? { status: 'absent', reason: problem } : PRESENT;
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
      name: "the assistant's Calendar access for agents",
      observe: async (context): Promise<Observation> => {
        const service = GOOGLE_SERVICES.calendar;
        const secret = await findInjectedSecret(
          await onecliApi(context.input.google.runtime, fetchImpl),
          service.secretName,
        );
        if (!secret) return { status: 'absent', reason: `OneCLI has no ${service.secretName} secret` };
        return secret.hostPattern === service.hostPattern
          ? PRESENT
          : { status: 'absent', reason: `OneCLI's ${service.secretName} secret is on ${secret.hostPattern}` };
      },
      apply: async (context) => {
        const service = GOOGLE_SERVICES.calendar;
        const token = await mintServiceToken(await requireGrant(context), service, tokenOptions);
        await upsertBearerSecret(await onecliApi(context.input.google.runtime, fetchImpl), {
          name: service.secretName,
          hostPattern: service.hostPattern,
          value: token.accessToken,
        });
        return undefined;
      },
    },
    {
      name: "the assistant's own calendar",
      observe: async (context): Promise<Observation> => {
        const grant = await requireGrant(context);
        const token = await mintServiceToken(grant, GOOGLE_SERVICES.calendar, tokenOptions);
        const response = await (fetchImpl ?? globalThis.fetch)(PRIMARY_CALENDAR_URL, {
          headers: { authorization: `Bearer ${token.accessToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        const body: unknown = await response.json().catch(() => undefined);
        if (!response.ok) return { status: 'absent', reason: `Google Calendar answered HTTP ${response.status}` };
        const id = typeof body === 'object' && body !== null && 'id' in body ? body.id : undefined;
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
 * account's with every scope, Google still accepts it, and OneCLI holds the
 * Calendar secret agents use. Each problem names the command that repairs it.
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
  try {
    await mintServiceToken(grant, GOOGLE_SERVICES.calendar, dependencies.fetch ? { fetch: dependencies.fetch } : {});
  } catch (error) {
    if (!(error instanceof GoogleGrantRevokedError)) throw error;
    return { status: 'degraded', account: grant.account, reason: `Google no longer accepts the sign-in; ${repair}` };
  }
  const service = GOOGLE_SERVICES.calendar;
  const secret = await findInjectedSecret(await onecliApi(runtime, dependencies.fetch), service.secretName);
  if (!secret || secret.hostPattern !== service.hostPattern) {
    return {
      status: 'degraded',
      account: grant.account,
      reason: `agents have no Calendar access in OneCLI; ${repair}`,
    };
  }
  return { status: 'connected', account: grant.account };
}
