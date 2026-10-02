import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_SERVICES, GOOGLE_SIGN_IN_SCOPES, type GoogleGrant } from '../modules/gws-ea-google/grant.js';
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

const ROOT = '/tmp/nanoclaw-gws-ea-google-connection-test';
const SECRETS = path.join(ROOT, 'secrets');
const ACCOUNT = 'robin@example.test';
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
    onecli_cli_path: '/opt/onecli',
    selected_provider: 'claude',
    endpoint_url: 'https://robin.example.test/webhook/gchat',
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
  projectId: 'gws-ea-robin-test',
  account: 'operator@example.test',
  serviceAccountEmail: deriveGchatServiceAccountEmail('gws-ea-robin-test'),
  credentialFile: path.join(SECRETS, 'gchat-service-account.json'),
  cwd: ROOT,
};

/** Google Cloud, Google's OAuth and Calendar endpoints, and OneCLI's secrets API, in memory. */
class World {
  enabledApis = new Set<string>(['chat.googleapis.com']);
  secrets = new Map<string, { id: string; hostPattern: string; value: string }>();
  calendarStatus = 200;
  calendarId = ACCOUNT;
  minted = 0;
  readonly gcloudCalls: string[] = [];

  revoked = false;
  /** A second secret by the same name, as a creation race between the refresher and this step leaves. */
  duplicateSecret = false;

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
    if (route === '/v1/secrets' && init?.method === 'GET') {
      const listed = [...this.secrets].map(([name, s]) => ({ id: s.id, name, hostPattern: s.hostPattern }));
      const [first] = listed;
      return json(this.duplicateSecret && first ? [...listed, { ...first, id: 'sec-duplicate' }] : listed);
    }
    if (route === '/v1/secrets/sec-duplicate' && init?.method === 'DELETE') {
      this.duplicateSecret = false;
      return json({});
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string; hostPattern: string; value: string };
    if (route === '/v1/secrets' && init?.method === 'POST') {
      this.secrets.set(String(body.name), { id: 'sec-1', hostPattern: body.hostPattern, value: body.value });
      return json({}, 201);
    }
    if (route === '/v1/secrets/sec-1' && init?.method === 'PATCH') {
      for (const [name, secret] of this.secrets) {
        if (secret.id === 'sec-1')
          this.secrets.set(name, { ...secret, hostPattern: body.hostPattern, value: body.value });
      }
      return json({ success: true });
    }
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
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });

    const pause = await connect(resources, context(signIn));

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

  it('signs in with the supplied client, keeps the grant, and puts a Calendar token in OneCLI', async () => {
    const world = new World();
    const signIn = vi.fn(async (request: AssistantGoogleSignInRequest) => {
      expect(request).toMatchObject({ client: CLIENT, account: ACCOUNT });
      return grant();
    });
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });

    await expect(connect(resources, context(signIn, writeDownloadedClient()))).resolves.toBeUndefined();

    const grantFile = path.join(SECRETS, 'google-grant.json');
    expect(fs.statSync(grantFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(grantFile, 'utf8'))).toMatchObject({ account: ACCOUNT, ...CLIENT });
    expect(fs.existsSync(path.join(SECRETS, 'google-oauth-client.json'))).toBe(false);
    expect(world.secrets.get(GOOGLE_SERVICES.calendar.secretName)).toMatchObject({ hostPattern: 'www.googleapis.com' });
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('changes nothing when run again on a connected assistant', async () => {
    const world = new World();
    const signIn = vi.fn(async () => grant());
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });
    await connect(resources, context(signIn, writeDownloadedClient()));
    const enables = world.gcloudCalls.filter((call) => call.startsWith('services enable')).length;

    await expect(connect(resources, context(signIn))).resolves.toBeUndefined();

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(world.gcloudCalls.filter((call) => call.startsWith('services enable'))).toHaveLength(enables);
    expect([...world.secrets.keys()]).toEqual([GOOGLE_SERVICES.calendar.secretName]);
  });

  it('signs in again, with the client it already has, when the grant is for another account', async () => {
    const world = new World();
    const signIn = vi.fn(async () => grant());
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });
    fs.writeFileSync(
      path.join(SECRETS, 'google-grant.json'),
      JSON.stringify(grant({ account: 'taslim@example.test' })),
      { mode: 0o600 },
    );

    const observed = await resources[2]!.observe(context(signIn));
    expect(observed).toEqual({
      status: 'absent',
      reason: `Google is signed in as taslim@example.test, not the assistant's account ${ACCOUNT}`,
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
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });
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

  it('keeps one Calendar secret when a creation race left two', async () => {
    const world = new World();
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });
    await connect(
      resources,
      context(async () => grant(), writeDownloadedClient()),
    );
    world.duplicateSecret = true;

    expect(await resources[3]!.observe(context(async () => grant()))).toEqual({
      status: 'absent',
      reason: `OneCLI holds 2 secrets named ${GOOGLE_SERVICES.calendar.secretName}`,
    });
    await expect(
      connect(
        resources,
        context(async () => grant()),
      ),
    ).resolves.toBeUndefined();

    expect(world.duplicateSecret).toBe(false);
    expect(world.secrets.get(GOOGLE_SERVICES.calendar.secretName)?.value).toMatch(/^ya29\.calendar-/);
  });

  it('signs in again when a release asks for a scope the grant lacks', async () => {
    const world = new World();
    const signIn = vi.fn(async () => grant());
    fs.writeFileSync(
      path.join(SECRETS, 'google-grant.json'),
      JSON.stringify(grant({ scopes: ['openid', 'email', ...GOOGLE_SERVICES.calendar.scopes] })),
      { mode: 0o600 },
    );
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });

    expect(await resources[2]!.observe(context(signIn))).toEqual({
      status: 'absent',
      reason: `the sign-in lacks ${GOOGLE_SERVICES.gmail.scopes.join(', ')}`,
    });
  });

  it('takes the download as the browser saved it, and keeps only a private copy', async () => {
    const world = new World();
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });
    const download = writeDownloadedClient(0o644);

    await expect(resources[1]!.apply(context(async () => grant(), download))).resolves.toBeUndefined();

    expect(fs.statSync(path.join(SECRETS, 'google-oauth-client.json')).mode & 0o777).toBe(0o600);
  });

  it("reports the calendar check's reason when Google does not return the assistant's own calendar", async () => {
    const world = new World();
    world.calendarId = 'someone-else@example.test';
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });

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
    const resources = googleConnectionResources({ gcloud: { runCommand: world.runCommand }, fetch: world.fetch });
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

  it('reports a sign-in Google no longer accepts, and missing Calendar access for agents', async () => {
    const world = new World();
    fs.writeFileSync(path.join(SECRETS, 'google-grant.json'), JSON.stringify(grant()), { mode: 0o600 });

    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toMatchObject({
      status: 'degraded',
      reason: `agents have no Calendar access: OneCLI has no ${GOOGLE_SERVICES.calendar.secretName} secret; ${repair}`,
    });
    world.revoked = true;
    await expect(observeGoogleConnection(runtime(), ACCOUNT, { fetch: world.fetch })).resolves.toEqual({
      status: 'degraded',
      account: ACCOUNT,
      reason: `Google no longer accepts the sign-in; ${repair}`,
    });
  });
});
