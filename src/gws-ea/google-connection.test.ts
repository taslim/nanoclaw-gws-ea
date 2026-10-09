import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SERVICES,
  GOOGLE_SIGN_IN_SCOPES,
  HOST_GOOGLE_SERVICES,
  type GoogleGrant,
} from '../modules/gws-ea-google/grant.js';
import { GOOGLE_TOKEN_ENDPOINT } from '../modules/gws-ea-google/tokens.js';
import type { AssistantGoogleSignInRequest } from './events.js';
import { GOOGLE_WORKSPACE_APIS, type GcpProjectInput } from './gcloud.js';
import { deriveGchatServiceAccountEmail } from './gcp-identity.js';
import {
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

function runtime(): InstanceRuntimeConfig {
  return {
    schema_version: 1,
    instance_id: '11111111-1111-4111-8111-111111111111',
    install_id: '11111111111141118111111111111111',
    deployed_commit: 'a'.repeat(40),
    checkout_realpath: path.join(ROOT, 'nanoclaw'),
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
 * Google Cloud, Google's OAuth and Calendar endpoints, and OneCLI's secrets
 * API, in memory. The vault is read-only to this step: only the host's
 * refresher publishes, which `publish()` stands in for.
 */
class World {
  enabledApis = new Set<string>(['chat.googleapis.com']);
  secrets: { id: string; name: string; hostPattern: string }[] = [];
  calendarStatus = 200;
  calendarId = ACCOUNT;
  minted = 0;
  readonly gcloudCalls: string[] = [];
  /** Every request to OneCLI other than a read of its secret metadata. */
  readonly vaultWrites: string[] = [];

  revoked = false;

  /** What the host's refresher does once it sees a sign-in: one secret per agent-facing service. */
  publish(): void {
    for (const id of EXPOSED_GOOGLE_SERVICES) {
      const service = AGENT_GOOGLE_SERVICES[id];
      if (this.secrets.some((secret) => secret.name === service.secretName)) continue;
      this.secrets.push({ id: `sec-${id}`, name: service.secretName, hostPattern: service.hostPattern });
    }
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
      this.minted += 1;
      const scope = new URLSearchParams(String(init?.body)).get('scope') ?? '';
      return json({ access_token: `ya29.calendar-${this.minted}`, expires_in: 3599, scope });
    }
    if (url === PRIMARY_CALENDAR_URL) {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (!auth.startsWith('Bearer ya29.calendar-')) return json({}, 401);
      return json({ id: this.calendarId, accessRole: 'owner' }, this.calendarStatus);
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

    for (const api of GOOGLE_WORKSPACE_APIS) expect(world.enabledApis.has(api)).toBe(true);
    expect(GOOGLE_WORKSPACE_APIS).toContain('people.googleapis.com');
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

  it("waits for the host to publish each service's secret before the step is done", async () => {
    const world = new World();
    const resources = resourcesFor(world, 3);
    await connect(
      resources.slice(0, 3),
      context(async () => grant(), writeDownloadedClient()),
    );
    const access = resources[3]!;

    expect(await access.observe(context(async () => grant()))).toEqual({
      status: 'absent',
      reason: 'OneCLI has no google-calendar, google-gmail-read, or google-directory secret yet',
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

  it('signs in again when a release asks for a scope the grant lacks', async () => {
    const world = new World();
    const signIn = vi.fn(async () => grant());
    fs.writeFileSync(
      path.join(SECRETS, 'google-grant.json'),
      JSON.stringify(
        grant({
          scopes: ['openid', 'email', ...AGENT_GOOGLE_SERVICES.calendar.scopes, ...HOST_GOOGLE_SERVICES.gmail.scopes],
        }),
      ),
      { mode: 0o600 },
    );
    const resources = resourcesFor(world);

    expect(await resources[2]!.observe(context(signIn))).toEqual({
      status: 'absent',
      reason:
        'the sign-in lacks https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/directory.readonly',
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
      reason: `agents have no Google access: OneCLI has no google-calendar, google-gmail-read, or google-directory secret yet; ${repair}`,
    });
    world.revoked = true;
    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: ACCOUNT,
      reason: `Google no longer accepts the sign-in; ${repair}`,
    });
  });

  it('names the missing scopes and the connect-google repair for an assistant signed in before this release', async () => {
    const world = new World();
    world.publish();
    fs.writeFileSync(
      path.join(SECRETS, 'google-grant.json'),
      JSON.stringify(
        grant({
          scopes: ['openid', 'email', ...AGENT_GOOGLE_SERVICES.calendar.scopes, ...HOST_GOOGLE_SERVICES.gmail.scopes],
        }),
      ),
      { mode: 0o600 },
    );

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: ACCOUNT,
      reason: `the sign-in lacks https://www.googleapis.com/auth/gmail.readonly, https://www.googleapis.com/auth/directory.readonly; ${repair}`,
    });
  });

  it.each([
    ['the stale google-gmail secret', { name: 'google-gmail', hostPattern: 'gmail.googleapis.com' }],
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
