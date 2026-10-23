import fs from 'node:fs';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/private/tmp/artifact-runtime-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { resolveSystemSession } from '../../session-manager.js';
import {
  artifactsAccessApplication,
  artifactsEmailPolicy,
  reconcileArtifactsAccessEmails,
  writeArtifactsOperatorConfig,
} from '../../gws-ea/artifacts-cloudflare.js';
import { lookup } from '../../cli/registry.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { parseArtifactShare } from './authority.js';
import { prepareArtifactSource, saveArtifact } from './db.js';
import { ArtifactsRuntime } from './runtime.js';
import type { ArtifactsPolicyFile } from './policy.js';
import type { Session } from '../../types.js';
let runtime: ArtifactsRuntime;
let policy: ArtifactsPolicyFile;
let main: Session;
let publication: Record<string, unknown>;
let httpCalls: Array<{ method: string; path: string }>;
let emails: string[];
let unavailable = false;
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function writePolicy(enabled = true): void {
  fs.writeFileSync(path.join(ROOT, 'policy.json'), JSON.stringify({ ...policy, enabled }), { mode: 0o600 });
}
function get(
  route: string,
  method = 'GET',
  host = policy.hostname,
  identity?: string,
): Promise<{ status: number; cache: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: policy.listenPort,
        path: route,
        method,
        headers: { host, ...(identity ? { 'cf-access-jwt-assertion': identity } : {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cache: res.headers['cache-control'], body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
beforeEach(async () => {
  fs.mkdirSync(path.join(ROOT, 'operator', 'artifacts'), { recursive: true, mode: 0o700 });
  const operatorConfigFile = path.join(ROOT, 'operator', 'artifacts', 'config.json');
  policy = {
    schemaVersion: 1,
    enabled: true,
    hostname: 'views.example.com',
    pathPrefix: '/aya',
    listenPort: await freePort(),
    accessIssuer: 'https://team.cloudflareaccess.com',
    accessAud: 'aud',
    cloudflare: { accountId: 'account', applicationId: 'app', operatorConfigFile },
  };
  writePolicy();
  vi.stubEnv('GWS_EA_ARTIFACTS_POLICY_FILE', path.join(ROOT, 'policy.json'));
  const tokenFile = path.join(ROOT, 'operator', 'artifacts', 'management-token');
  fs.writeFileSync(tokenFile, 'deterministic-fixture-token', { mode: 0o600 });
  const claim = { hostname: policy.hostname, path_prefix: policy.pathPrefix, listen_port: policy.listenPort };
  await writeArtifactsOperatorConfig(operatorConfigFile, {
    schemaVersion: 1,
    accountId: 'account',
    zoneId: 'zone',
    teamName: 'team',
    hostname: policy.hostname,
    credentialFile: tokenFile,
    cloudflaredPath: '/usr/local/bin/cloudflared',
    dns: {},
    tunnelId: 'tunnel',
    pin: { id: 'pin', owned: true },
    assistants: {
      '00000000-0000-4000-8000-000000000001': {
        claim,
        enabled: true,
        applicationId: 'app',
        policyId: 'policy',
        aud: 'aud',
      },
    },
  });
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'canonical', name: 'Aya', folder: 'canonical', created_at: now, agent_provider: null });
  await getDb().run(
    "UPDATE gws_ea_profile SET main_agent_group_id='canonical',assistant_first_name='Aya',principal_first_name='Morgan' WHERE singleton=1",
  );
  await getDb().run('INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)', 'principal@example.com', now);
  main = (await resolveSystemSession('canonical', 'system:runtime')).session;
  await upsertUser({ id: 'gchat:principal', kind: 'gchat', display_name: 'Principal', created_at: now });
  await bindVerifiedPrincipalUser('gchat:principal', now);
  await createMessagingGroup({
    id: 'chat',
    channel_type: 'gchat',
    platform_id: 'chat',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO gws_ea_principal_messages(message_id,messaging_group_id,user_id,timestamp,text) VALUES('mark','chat','gchat:principal',?,'Publish the report')",
    now,
  );
  const source = prepareArtifactSource(Buffer.from('<p>Public source</p>'));
  const saved = await saveArtifact(
    { agentGroupId: 'canonical', sessionId: main.id, isMain: true },
    { requestId: 'save', action: 'save', fingerprint: 'save' },
    { create_key: 'report', title: 'Report' },
    source,
  );
  publication = { artifact_id: saved.artifact_id, revision: 1, expected_hash: source.source_hash };
  httpCalls = [];
  emails = ['principal@example.com'];
  unavailable = false;
  const fetcher: typeof fetch = async (url, options) => {
    const parsed = new URL(String(url));
    httpCalls.push({ method: options?.method ?? 'GET', path: parsed.pathname });
    if (unavailable) return Response.json({ success: false }, { status: 403 });
    const appPath = '/client/v4/accounts/account/access/apps/app';
    let result: unknown;
    if (parsed.pathname === appPath) result = { ...artifactsAccessApplication(claim, 'pin'), id: 'app', aud: 'aud' };
    else if (parsed.pathname === `${appPath}/policies`) result = [{ id: 'policy', ...artifactsEmailPolicy(emails) }];
    else if (parsed.pathname === `${appPath}/policies/policy`) {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body)) as {
          decision: string;
          include: Array<{ email?: { email: string } }>;
        };
        emails = body.decision === 'deny' ? [] : body.include.flatMap((rule) => (rule.email ? [rule.email.email] : []));
      }
      result = { id: 'policy', ...artifactsEmailPolicy(emails) };
    } else if (parsed.pathname === `${appPath}/revoke_tokens`) result = {};
    else throw new Error(`Unexpected fixture request: ${parsed.pathname}`);
    return Response.json({ success: true, result });
  };
  runtime = new ArtifactsRuntime({
    reconcileAccess: (input) => reconcileArtifactsAccessEmails(input, { fetch: fetcher }),
  });
});
afterEach(async () => {
  await runtime?.stop();
  await closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
it('verifies Access before a real loopback origin becomes healthy, and keeps save/view/unchanged ticks free of management calls', async () => {
  const key = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'current', alg: 'RS256' };
  const keys = vi.fn(async () => Response.json({ keys: [jwk] }));
  vi.stubGlobal('fetch', keys);
  const identity = await new SignJWT({ email: 'principal@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'current' })
    .setIssuer(policy.accessIssuer)
    .setAudience(policy.accessAud)
    .setExpirationTime('1h')
    .sign(key.privateKey);
  expect(await runtime.health()).toMatchObject({
    enabled: true,
    availability: 'unavailable',
    listener: { state: 'stopped' },
  });
  await runtime.sharing.submit(
    main,
    'before-listener',
    parseArtifactShare({
      ...publication,
      operation: 'public_publish',
      principal_message: { id: 'mark', messaging_group_id: 'chat' },
    }),
  );
  expect(await getDb().get("SELECT state FROM gws_ea_artifact_requests WHERE request_id='before-listener'")).toEqual({
    state: 'pending',
  });
  await runtime.reconcile();
  expect(await getDb().get("SELECT state FROM gws_ea_artifact_requests WHERE request_id='before-listener'")).toEqual({
    state: 'pending',
  });
  await runtime.reconcile();
  expect(await getDb().get("SELECT state FROM gws_ea_artifact_requests WHERE request_id='before-listener'")).toEqual({
    state: 'settled',
  });
  expect(await runtime.health()).toMatchObject({
    availability: 'available',
    listener: { state: 'listening', port: policy.listenPort },
  });
  expect(httpCalls.length).toBe(3);
  const share = await getDb().get<{ share_id: string }>('SELECT share_id FROM gws_ea_artifact_shares');
  if (!share) throw new Error('No applied publication');
  for (const method of ['GET', 'HEAD']) {
    const page = await get(`/aya/public/${share.share_id}`, method);
    expect(page.status).toBe(200);
    expect(page.cache).toBe('no-store');
    expect(method === 'HEAD' ? page.body === '' : page.body.includes('Report')).toBe(true);
  }
  expect((await get(`/aya/${String(publication.artifact_id)}`)).status).toBe(404);
  expect((await get(`/aya/${String(publication.artifact_id)}`, 'GET', policy.hostname, identity)).status).toBe(200);
  expect((await get(`/aya/${String(publication.artifact_id)}`, 'HEAD', policy.hostname, identity)).status).toBe(200);
  expect(keys).toHaveBeenCalledTimes(1);
  expect((await get(`/aya/public/${share.share_id}`, 'GET', 'wrong.example.com')).status).toBe(404);
  await runtime.reconcile();
  expect(httpCalls.length).toBe(3);
  writePolicy(false);
  expect(await runtime.health()).toMatchObject({ availability: 'disabled', listener: { state: 'stopped' } });
  expect((await get(`/aya/public/${share.share_id}`, 'HEAD')).status).toBe(404);
  await runtime.reconcile();
  await expect(get(`/aya/public/${share.share_id}`)).rejects.toThrow();
});
it('fails optional readiness closed, retries safely, and checks local coordinates without an ingress/connector cycle', async () => {
  await runtime.sharing.submit(
    main,
    'unavailable-origin',
    parseArtifactShare({
      ...publication,
      operation: 'public_publish',
      principal_message: { id: 'mark', messaging_group_id: 'chat' },
    }),
  );
  unavailable = true;
  await runtime.reconcile();
  await runtime.reconcile();
  expect(await runtime.health()).toMatchObject({ availability: 'unavailable', listener: { state: 'stopped' } });
  expect(await getDb().get("SELECT state FROM gws_ea_artifact_requests WHERE request_id='unavailable-origin'")).toEqual(
    { state: 'pending' },
  );
  expect(httpCalls).toHaveLength(1);
  unavailable = false;
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16000);
  await runtime.reconcile();
  clock.mockRestore();
  expect(await runtime.health()).toMatchObject({ availability: 'available' });
  fs.writeFileSync(path.join(ROOT, 'policy.json'), JSON.stringify({ ...policy, accessAud: 'wrong' }), { mode: 0o600 });
  expect(await runtime.health()).toMatchObject({ availability: 'unavailable' });
  await runtime.reconcile();
  await expect(get('/aya/public/00000000-0000-4000-8000-000000000002')).rejects.toThrow();
});
it('reconciles principal reductions locally first, updates exact email policy and revokes sessions without repeated writes', async () => {
  await runtime.reconcile();
  await getDb().run("DELETE FROM gws_ea_principal_addresses WHERE email='principal@example.com'");
  await runtime.reconcile();
  expect(emails).toEqual([]);
  expect(httpCalls.filter(({ method }) => method === 'PUT')).toHaveLength(1);
  expect(httpCalls.filter(({ path: pathname }) => pathname.endsWith('/revoke_tokens'))).toHaveLength(1);
  const count = httpCalls.length;
  await runtime.reconcile();
  expect(httpCalls).toHaveLength(count);
  expect(lookup('gws-ea-artifacts-health')).toMatchObject({ hostOnly: true, access: 'hidden' });
  expect(lookup('gws-ea-artifacts-admission-emails')).toMatchObject({ hostOnly: true, access: 'hidden' });
});
