import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_GOOGLE_CREDENTIALS,
  AGENT_GOOGLE_SERVICES,
  credentialScopes,
  GOOGLE_SIGN_IN_SCOPES,
  HOST_GOOGLE_SERVICES,
  type GoogleGrant,
} from '../modules/gws-ea-google/grant.js';
import { GOOGLE_TOKEN_ENDPOINT } from '../modules/gws-ea-google/tokens.js';
import type { AssistantGoogleSignInRequest } from './events.js';
import { GOOGLE_WORKSPACE_APIS, type GcpProjectInput } from './gcloud.js';
import { deriveGchatServiceAccountEmail } from './gcp-identity.js';
import {
  DRIVE_ABOUT_URL,
  GOOGLE_CLIENT_FILE_FLAG,
  googleConnectionResources,
  observeGoogleConnection,
  PRIMARY_CALENDAR_URL,
  type GoogleConnectionContext,
} from './google-connection.js';
import type { Observation, ProvisionHumanPause, StepResource } from './phases.js';
import type { SanitizedCommand, SanitizedCommandOutcome } from './process.js';
import type { InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';

const ROOT = '/tmp/nanoclaw-gws-ea-google-connection-test';
const SECRETS = path.join(ROOT, 'secrets');
const ACCOUNT = 'juno@example.test';
const CLIENT = { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-desktop-secret' };
const DRIVE = 'https://www.googleapis.com/auth/drive';
/** The scopes this release adds to the sign-in, in the order it asks for them: Workspace's, then the ceiling. */
const THIS_RELEASE_SCOPES = [
  DRIVE,
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.events.owned.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.events.public.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.calendars',
  'https://www.googleapis.com/auth/calendar.calendars.readonly',
  'https://www.googleapis.com/auth/calendar.acls',
  'https://www.googleapis.com/auth/calendar.acls.readonly',
  'https://www.googleapis.com/auth/calendar.settings.readonly',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.metadata',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.insert',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.activity',
  'https://www.googleapis.com/auth/drive.activity.readonly',
  'https://www.googleapis.com/auth/drive.labels',
  'https://www.googleapis.com/auth/drive.labels.readonly',
  'https://www.googleapis.com/auth/drive.meet.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
  'https://www.googleapis.com/auth/forms.body.readonly',
];
/** The scopes an assistant signed in before Drive, Docs, Sheets, Slides and Forms holds. */
const BEFORE_WORKSPACE = [
  'openid',
  'email',
  ...AGENT_GOOGLE_SERVICES.calendar.scopes,
  ...AGENT_GOOGLE_SERVICES['gmail-read'].scopes,
  ...AGENT_GOOGLE_SERVICES.directory.scopes,
  ...HOST_GOOGLE_SERVICES.gmail.scopes,
];

function runtime(): InstanceRuntimeConfig {
  return {
    schema_version: 2,
    instance_id: '11111111-1111-4111-8111-111111111111',
    install_id: '11111111111141118111111111111111',
    instance_root: ROOT,
    checkout_root: path.join(ROOT, 'nanoclaw'),
    state_root: path.join(ROOT, 'state'),
    node_path: '/usr/bin/node',
    home_directory: ROOT,
    allocated_ports: { nanoclaw_webhook: 31_001, onecli_app: 31_002, onecli_gateway: 31_003 },
    agent_egress_network: 'gws-ea-x-agent-egress',
    onecli_project: 'gws-ea-x',
    onecli_app_url: 'http://127.0.0.1:31002',
    onecli_gateway_url: 'http://127.0.0.1:31003',
    onecli_gateway_container: 'gws-ea-x-gateway-1',
    selected_provider: 'claude',
    endpoint_url: 'https://juno.example.test/webhook/gchat',
    docker_endpoint: 'unix:///var/run/docker.sock',
    secret_files: {
      gchat_credentials: path.join(SECRETS, 'gchat-service-account.json'),
      onecli_runtime_api_key: path.join(SECRETS, 'onecli-runtime-api-key'),
      onecli_admin_api_key: path.join(SECRETS, 'onecli-admin-api-key'),
    },
  };
}

const GCP: GcpProjectInput = {
  instanceId: '11111111-1111-4111-8111-111111111111',
  projectId: 'gws-ea-juno-test',
  account: 'operator@example.test',
  serviceAccountEmail: deriveGchatServiceAccountEmail('gws-ea-juno-test'),
  credentialFile: path.join(SECRETS, 'gchat-service-account.json'),
  cwd: ROOT,
};

/**
 * Google Cloud, Google's OAuth, Calendar and Drive endpoints, and OneCLI's
 * secrets API, in memory. The vault is read-only to this step: only the
 * host's refresher publishes, which `publish()` stands in for.
 */
class World {
  enabledApis = new Set<string>(['chat.googleapis.com']);
  secrets: { id: string; name: string; hostPattern: string }[] = [];
  calendarStatus = 200;
  calendarId = ACCOUNT;
  driveStatus = 200;
  driveAccount = ACCOUNT;
  /** The OAuth error Google answers a token request asking for Drive with, though the grant lists it. */
  driveRefusal: string | undefined;
  minted = 0;
  /** The scopes of each access token Google minted. */
  readonly tokenScopes = new Map<string, readonly string[]>();
  readonly gcloudCalls: string[] = [];
  /** Every request to OneCLI other than a read of its secret metadata. */
  readonly vaultWrites: string[] = [];

  revoked = false;

  /** What the host's refresher does once it sees a sign-in: one secret per credential the grant holds scopes for. */
  publish(granted: readonly string[] = GOOGLE_SIGN_IN_SCOPES): void {
    for (const credential of AGENT_GOOGLE_CREDENTIALS) {
      if (credentialScopes(credential, granted).length === 0) continue;
      if (this.secrets.some((secret) => secret.name === credential.secretName)) continue;
      this.secrets.push({ id: `sec-${credential.host}`, name: credential.secretName, hostPattern: credential.host });
    }
  }

  /** Whether the request carries a token Google minted with `scope`. */
  private carries(init: RequestInit | undefined, scope: string): boolean {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    return auth.startsWith('Bearer ') && (this.tokenScopes.get(auth.slice('Bearer '.length))?.includes(scope) ?? false);
  }

  readonly runCommand = vi.fn(async (command: SanitizedCommand): Promise<SanitizedCommandOutcome> => {
    const args = command.args.filter((arg) => !arg.startsWith('--account=') && arg !== '--quiet');
    this.gcloudCalls.push(args.join(' '));
    if (args[0] === 'services' && args[1] === 'list') {
      return { stdout: [...this.enabledApis].join('\n'), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'services' && args[1] === 'enable') {
      for (const api of args.slice(2).filter((arg) => !arg.startsWith('--'))) this.enabledApis.add(api);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected ${args.join(' ')}`, exitCode: 1 };
  });

  readonly fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      if (this.revoked) return json({ error: 'invalid_grant' }, 400);
      const scope = new URLSearchParams(String(init?.body)).get('scope') ?? '';
      if (this.driveRefusal && scope.split(' ').includes(DRIVE)) return json({ error: this.driveRefusal }, 400);
      this.minted += 1;
      const token = `ya29.token-${this.minted}`;
      this.tokenScopes.set(token, scope.split(' '));
      return json({ access_token: token, expires_in: 3599, scope });
    }
    if (url === PRIMARY_CALENDAR_URL) {
      if (!this.carries(init, 'https://www.googleapis.com/auth/calendar.calendarlist')) return json({}, 403);
      return json({ id: this.calendarId, accessRole: 'owner' }, this.calendarStatus);
    }
    if (url === DRIVE_ABOUT_URL) {
      if (!this.carries(init, DRIVE)) return json({}, 403);
      return json({ user: { emailAddress: this.driveAccount } }, this.driveStatus);
    }
    const route = new URL(url).pathname;
    if (new Headers(init?.headers).get('authorization') !== 'Bearer oc_admin_key') return json({}, 401);
    if (route === '/v1/secrets' && (init?.method ?? 'GET') === 'GET') {
      expect(init?.redirect).toBe('error');
      return json(this.secrets);
    }
    this.vaultWrites.push(`${init?.method ?? 'GET'} ${route}`);
    return json({}, 404);
  }) as unknown as typeof globalThis.fetch;
}

function grant(overrides: Partial<GoogleGrant> = {}): GoogleGrant {
  return {
    schema_version: 1,
    account: ACCOUNT,
    ...CLIENT,
    refresh_token: '1//refresh-token',
    scopes: GOOGLE_SIGN_IN_SCOPES.map((scope) =>
      scope === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : scope,
    ),
    granted_at: '2026-09-30T12:00:00.000Z',
    ...overrides,
  };
}

function context(
  signIn: (request: AssistantGoogleSignInRequest) => Promise<GoogleGrant>,
  clientFile?: string,
): GoogleConnectionContext {
  return {
    input: {
      gcp: GCP,
      google: {
        runtime: runtime(),
        assistantWorkspaceEmail: ACCOUNT,
        ...(clientFile ? { clientFile } : {}),
        signIn,
        resumeCommand: 'gws-ea resume --id 11111111-1111-4111-8111-111111111111',
      },
    },
  };
}

/** Run each resource as the step engine does: observe, apply only when absent, observe again. */
async function connect(
  resources: readonly StepResource<GoogleConnectionContext>[],
  value: GoogleConnectionContext,
): Promise<ProvisionHumanPause | undefined> {
  for (const resource of resources) {
    const before: Observation = await resource.observe(value);
    if (before.status === 'pause') return before.pause;
    if (before.status === 'present') continue;
    const pause = await resource.apply(value);
    if (pause) return pause;
    const after = await resource.observe(value);
    if (after.status !== 'present') throw new Error(`${resource.name} still not present: ${JSON.stringify(after)}`);
  }
  return undefined;
}

/** The step's resources against `world`, where the host publishes once the step has waited `afterWaits` times. */
function resourcesFor(world: World, afterWaits = 1): readonly StepResource<GoogleConnectionContext>[] {
  let waits = 0;
  return googleConnectionResources({
    gcloud: { runCommand: world.runCommand },
    fetch: world.fetch,
    sleep: async () => {
      waits += 1;
      if (waits >= afterWaits) world.publish();
    },
  });
}

function writeDownloadedClient(mode = 0o600): string {
  const file = path.join(ROOT, 'downloads', 'client.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ installed: CLIENT }), { mode });
  fs.chmodSync(file, mode);
  return file;
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(SECRETS, 'onecli-admin-api-key'), 'oc_admin_key\n', { mode: 0o600 });
});

afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("connecting the assistant's Google account", () => {
  it('enables the APIs, then pauses for the OAuth client with Console instructions', async () => {
    const world = new World();
    const signIn = vi.fn(async () => grant());
    const resources = resourcesFor(world);

    const pause = await connect(resources, context(signIn));

    expect(GOOGLE_WORKSPACE_APIS).toEqual([
      'calendar-json.googleapis.com',
      'gmail.googleapis.com',
      'people.googleapis.com',
      'drive.googleapis.com',
      'driveactivity.googleapis.com',
      'drivelabels.googleapis.com',
      'docs.googleapis.com',
      'sheets.googleapis.com',
      'slides.googleapis.com',
      'forms.googleapis.com',
    ]);
    for (const api of GOOGLE_WORKSPACE_APIS) expect(world.enabledApis.has(api)).toBe(true);
    expect(pause).toMatchObject({
      phase: 'connect_google',
      code: 'google_client_required',
      resumeFlag: `${GOOGLE_CLIENT_FILE_FLAG} <file>`,
      actionUrl: `https://console.cloud.google.com/auth/overview?project=${GCP.projectId}`,
    });
    expect(pause?.details?.join('\n')).toMatch(/Get started.*Internal.*\n.*Clients.*Desktop app.*download/su);
    expect(pause?.details?.join('\n')).not.toContain('chmod');
    expect(signIn).not.toHaveBeenCalled();
  });

  it('signs in with the supplied client and keeps the grant, writing nothing into OneCLI', async () => {
    const world = new World();
    const signIn = vi.fn(async (request: AssistantGoogleSignInRequest) => {
      expect(request).toMatchObject({ client: CLIENT, account: ACCOUNT });
      return grant();
    });
    const resources = resourcesFor(world);

    await expect(connect(resources, context(signIn, writeDownloadedClient()))).resolves.toBeUndefined();

    const grantFile = path.join(SECRETS, 'google-grant.json');
    expect(fs.statSync(grantFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(grantFile, 'utf8'))).toMatchObject({ account: ACCOUNT, ...CLIENT });
    expect(fs.existsSync(path.join(SECRETS, 'google-oauth-client.json'))).toBe(false);
    expect(world.vaultWrites).toEqual([]);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("waits for the host to publish each credential's secret before the step is done", async () => {
    const world = new World();
    const resources = resourcesFor(world, 3);
    await connect(
      resources.slice(0, 3),
      context(async () => grant(), writeDownloadedClient()),
    );
    const access = resources[3]!;

    expect(await access.observe(context(async () => grant()))).toEqual({
      status: 'absent',
      reason:
        'OneCLI has no google-calendar, google-gmail-read, google-directory, google-docs, google-sheets, ' +
        'google-slides, or google-forms secret yet',
    });
    await expect(access.apply(context(async () => grant()))).resolves.toBeUndefined();

    expect(await access.observe(context(async () => grant()))).toEqual({ status: 'present' });
    expect(world.vaultWrites).toEqual([]);
  });

  it('gives up waiting with the reason, when the host never publishes', async () => {
    const world = new World();
    const resources = resourcesFor(world, Number.POSITIVE_INFINITY);
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant()), { mode: 0o600 });

    const error = await resources[3]!.apply(context(async () => grant())).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GwsEaError);
    expect(error).toMatchObject({ code: 'google_access_unpublished' });
    expect(String(error)).toMatch(/host has not published.*google-calendar.*host's log/su);
    expect(world.vaultWrites).toEqual([]);
  });

  it('changes nothing when run again on a connected assistant', async () => {
    const world = new World();
    const signIn = vi.fn(async () => grant());
    const resources = resourcesFor(world);
    await connect(resources, context(signIn, writeDownloadedClient()));
    const enables = world.gcloudCalls.filter((call) => call.startsWith('services enable')).length;

    await expect(connect(resources, context(signIn))).resolves.toBeUndefined();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(world.gcloudCalls.filter((call) => call.startsWith('services enable'))).toHaveLength(enables);
    expect(world.vaultWrites).toEqual([]);
  });

  it('signs in again, with the client it already has, when the grant is for another account', async () => {
    const world = new World();
    const signIn = vi.fn(async () => grant());
    const resources = resourcesFor(world);
    fs.writeFileSync(
      path.join(SECRETS, 'google-grant.json'),
      JSON.stringify(grant({ account: 'morgan@example.test' })),
      { mode: 0o600 },
    );

    const observed = await resources[2]!.observe(context(signIn));
    expect(observed).toEqual({
      status: 'absent',
      reason: `Google is signed in as morgan@example.test, not the assistant's account ${ACCOUNT}`,
    });
    await expect(connect(resources, context(signIn))).resolves.toBeUndefined();
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ client: CLIENT }));
  });

  it('signs in again when Google no longer accepts the grant on disk', async () => {
    const world = new World();
    const signIn = vi.fn(async () => {
      world.revoked = false;
      return grant({ granted_at: '2026-10-01T09:00:00.000Z' });
    });
    const resources = resourcesFor(world);
    await connect(
      resources,
      context(async () => grant(), writeDownloadedClient()),
    );
    world.revoked = true;

    expect(await resources[2]!.observe(context(signIn))).toEqual({
      status: 'absent',
      reason: 'Google no longer accepts the sign-in',
    });
    await expect(connect(resources, context(signIn))).resolves.toBeUndefined();

    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ client: CLIENT, account: ACCOUNT }));
    expect(JSON.parse(fs.readFileSync(path.join(SECRETS, 'google-grant.json'), 'utf8'))).toMatchObject({
      granted_at: '2026-10-01T09:00:00.000Z',
    });
  });

  it('reports two secrets with one name rather than choosing or deleting either', async () => {
    const world = new World();
    const resources = resourcesFor(world);
    await connect(
      resources,
      context(async () => grant(), writeDownloadedClient()),
    );
    world.secrets.push({ id: 'sec-duplicate', name: 'google-calendar', hostPattern: 'www.googleapis.com' });

    expect(await resources[3]!.observe(context(async () => grant()))).toEqual({
      status: 'absent',
      reason: 'OneCLI holds 2 secrets named google-calendar',
    });
    expect(world.vaultWrites).toEqual([]);
  });

  it("signs in again when the grant on disk lacks this release's scopes", async () => {
    const world = new World();
    const signIn = vi.fn(async () => grant({ granted_at: '2026-10-09T18:00:00.000Z' }));
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant({ scopes: BEFORE_WORKSPACE })), {
      mode: 0o600,
    });
    const resources = resourcesFor(world);

    expect(await resources[2]!.observe(context(signIn))).toEqual({
      status: 'absent',
      reason: `the sign-in lacks ${THIS_RELEASE_SCOPES.join(', ')}`,
    });
    await expect(connect(resources, context(signIn))).resolves.toBeUndefined();

    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ client: CLIENT, account: ACCOUNT }));
    expect(JSON.parse(fs.readFileSync(path.join(SECRETS, 'google-grant.json'), 'utf8'))).toMatchObject({
      scopes: expect.arrayContaining(THIS_RELEASE_SCOPES) as unknown,
    });
  });

  it('takes the download as the browser saved it, and keeps only a private copy', async () => {
    const world = new World();
    const resources = resourcesFor(world);
    const download = writeDownloadedClient(0o644);

    await expect(resources[1]!.apply(context(async () => grant(), download))).resolves.toBeUndefined();

    expect(fs.statSync(path.join(SECRETS, 'google-oauth-client.json')).mode & 0o777).toBe(0o600);
  });

  it("reports the calendar check's reason when Google does not return the assistant's own calendar", async () => {
    const world = new World();
    world.calendarId = 'someone-else@example.test';
    const resources = resourcesFor(world);

    await expect(
      connect(
        resources,
        context(async () => grant(), writeDownloadedClient()),
      ),
    ).rejects.toThrow(/did not return the assistant's own calendar/);
  });

  it("reads the assistant's own Drive with the token agents get on www.googleapis.com", async () => {
    const world = new World();
    await connect(
      resourcesFor(world),
      context(async () => grant(), writeDownloadedClient()),
    );

    const driveReads = vi.mocked(world.fetch).mock.calls.filter(([url]) => String(url) === DRIVE_ABOUT_URL);
    expect(driveReads.length).toBeGreaterThan(0);
    const auth = new Headers(driveReads[0]![1]?.headers).get('authorization') ?? '';
    expect(world.tokenScopes.get(auth.replace('Bearer ', ''))).toEqual([
      ...AGENT_GOOGLE_SERVICES.calendar.scopes,
      DRIVE,
    ]);
  });

  it.each([
    [
      'answers as someone else',
      (world: World) => (world.driveAccount = 'someone-else@example.test'),
      'Google Drive did not answer as the assistant',
    ],
    ['refuses the read', (world: World) => (world.driveStatus = 403), 'Google Drive answered HTTP 403'],
    [
      'refuses Drive at the token endpoint',
      (world: World) => (world.driveRefusal = 'invalid_scope'),
      `Google refuses ${DRIVE} for the assistant's sign-in (invalid_scope)`,
    ],
  ])("reports the Drive check's reason when Google %s", async (_label, arrange, reason) => {
    const world = new World();
    const resources = resourcesFor(world);
    await connect(
      resources,
      context(async () => grant(), writeDownloadedClient()),
    );
    arrange(world);

    const observed = await resources[4]!.observe(context(async () => grant()));
    expect(observed).toMatchObject({ status: 'absent' });
    expect(observed.status === 'absent' ? observed.reason : undefined).toContain(reason);
  });
});

describe('observing the Google connection for status', () => {
  const repair = 'connect it with gws-ea connect-google --id 11111111-1111-4111-8111-111111111111';

  it('reports a connected assistant by its account', async () => {
    const world = new World();
    const resources = resourcesFor(world);
    await connect(
      resources,
      context(async () => grant(), writeDownloadedClient()),
    );

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'connected',
      account: ACCOUNT,
    });
  });

  it('names the command that connects an assistant that has not signed in, as one created before this', async () => {
    const world = new World();
    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: null,
      reason: `the assistant has not signed in to Google yet; ${repair}`,
    });
  });

  it("reports a sign-in Google no longer accepts, and agents' missing Google access", async () => {
    const world = new World();
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant()), { mode: 0o600 });

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toMatchObject({
      status: 'degraded',
      reason:
        'agents have no Google access: OneCLI has no google-calendar, google-gmail-read, google-directory, ' +
        `google-docs, google-sheets, google-slides, or google-forms secret yet; ${repair}`,
    });
    world.revoked = true;
    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: ACCOUNT,
      reason: `Google no longer accepts the sign-in; ${repair}`,
    });
  });

  it("names this release's missing scopes and the connect-google repair for an assistant signed in before them", async () => {
    const world = new World();
    world.publish(BEFORE_WORKSPACE);
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant({ scopes: BEFORE_WORKSPACE })), {
      mode: 0o600,
    });

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: ACCOUNT,
      reason: `the sign-in lacks ${THIS_RELEASE_SCOPES.join(', ')}; ${repair}`,
    });
  });

  it('reports a revoked sign-in as revoked, not as missing scopes, even from before the Workspace scopes', async () => {
    const world = new World();
    world.revoked = true;
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant({ scopes: BEFORE_WORKSPACE })), {
      mode: 0o600,
    });

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: ACCOUNT,
      reason: `Google no longer accepts the sign-in; ${repair}`,
    });
  });

  it('names Drive when Google refuses it while the sign-in lists it, and agents keep Calendar', async () => {
    const world = new World();
    world.publish();
    world.driveRefusal = 'invalid_scope';
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant()), { mode: 0o600 });

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: ACCOUNT,
      reason:
        `Google refuses ${DRIVE} for the assistant's sign-in (invalid_scope), so agents have Calendar without it; ` +
        `check that the Workspace admin allows the app, then ${repair}`,
    });
  });

  it("reports agents' access as partial, naming the one secret the host has not published", async () => {
    const world = new World();
    world.publish();
    world.secrets = world.secrets.filter((secret) => secret.name !== 'google-docs');
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant()), { mode: 0o600 });

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: ACCOUNT,
      reason: `agents have only part of their Google access: OneCLI has no google-docs secret yet; ${repair}`,
    });
  });

  it.each([
    ['a google-gmail secret', { name: 'google-gmail', hostPattern: 'gmail.googleapis.com' }],
    ['any other secret Gmail would accept', { name: 'mail-helper', hostPattern: '*.googleapis.com' }],
  ])('flags %s, which can carry gmail.modify, ahead of everything else', async (_label, secret) => {
    const world = new World();
    world.publish();
    world.secrets.push({ id: 'sec-modify', ...secret });
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant()), { mode: 0o600 });

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: ACCOUNT,
      reason:
        `OneCLI holds ${secret.name} on ${secret.hostPattern}, which an agent could use to reach Gmail beyond ` +
        "reading it (gmail.modify); remove it from the assistant's OneCLI",
    });
  });

  it('does not mistake the read-only Gmail secret or unrelated Google secrets for gmail.modify', async () => {
    const world = new World();
    world.publish();
    world.secrets.push({ id: 'sec-other', name: 'drive', hostPattern: 'www.googleapis.com' });
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant()), { mode: 0o600 });

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'connected',
      account: ACCOUNT,
    });
  });
});
