import fs from 'node:fs';
import path from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const ROOT = await vi.hoisted(async () => {
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(realpathSync(tmpdir()), `artifact-runtime-${process.pid}`);
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import '../../cli/resources/groups.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { initDb } from '../../db/connection.js';
import {
  fence,
  instanceLayout,
  operationName,
  releaseName,
  restoreSnapshot,
  takeSnapshot,
} from '../../gws-ea/release-layout.js';
import { resolveSystemSession } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import {
  webAccessApplication,
  webEmailPolicy,
  readWebOperatorConfig,
  reconcileWebAccessEmails,
  writeWebOperatorConfig,
} from '../../gws-ea/web-cloudflare.js';
import { lookup } from '../../cli/registry.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { parseArtifactShare } from './authority.js';
import { getArtifactRevision, listArtifacts, prepareArtifactSource, saveArtifact } from './db.js';
import { artifactActor, hasArtifactsAccess } from './policy.js';
import { ArtifactsRuntime } from './runtime.js';
import type { WebPolicyFile } from '../gws-ea-web/policy.js';
import type { Session } from '../../types.js';
let runtime: ArtifactsRuntime;
let policy: WebPolicyFile;
let main: Session;
let publication: Record<string, unknown>;
let httpCalls: Array<{ method: string; path: string }>;
let emails: string[];
let unavailable = false;
let fetcher: typeof fetch;
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
  fs.mkdirSync(path.join(ROOT, 'operator', 'web'), { recursive: true, mode: 0o700 });
  const operatorConfigFile = path.join(ROOT, 'operator', 'web', 'config.json');
  policy = {
    schemaVersion: 1,
    enabled: true,
    hostname: 'views.example.com',
    pathPrefix: '/artifacts',
    listenPort: await freePort(),
    accessIssuer: 'https://team.cloudflareaccess.com',
    accessAud: 'aud',
    cloudflare: { accountId: 'account', applicationId: 'app', operatorConfigFile },
  };
  writePolicy();
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', path.join(ROOT, 'policy.json'));
  const tokenFile = path.join(ROOT, 'operator', 'web', 'management-token');
  fs.writeFileSync(tokenFile, 'deterministic-fixture-token', { mode: 0o600 });
  const claim = { hostname: policy.hostname, listen_port: policy.listenPort };
  await writeWebOperatorConfig(operatorConfigFile, {
    schemaVersion: 1,
    accountId: 'account',
    zoneId: 'zone',
    teamName: 'team',
    zoneApex: 'example.com',
    credentialFile: tokenFile,
    cloudflaredPath: '/usr/local/bin/cloudflared',
    dns: {},
    tunnelId: 'tunnel',
    pin: { id: 'pin', owned: true },
    assistants: {
      '00000000-0000-4000-8000-000000000001': {
        claim,
        enabled: true,
        publicationReady: true,
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
  fetcher = async (url, options) => {
    const parsed = new URL(String(url));
    httpCalls.push({ method: options?.method ?? 'GET', path: parsed.pathname });
    if (unavailable) return Response.json({ success: false }, { status: 403 });
    const appPath = '/client/v4/accounts/account/access/apps/app';
    let result: unknown;
    if (parsed.pathname === appPath) result = { ...webAccessApplication(claim, 'pin'), id: 'app', aud: 'aud' };
    else if (parsed.pathname === `${appPath}/policies`) result = [{ id: 'policy', ...webEmailPolicy(emails) }];
    else if (parsed.pathname === `${appPath}/policies/policy`) {
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body)) as {
          decision: string;
          include: Array<{ email?: { email: string } }>;
        };
        emails = body.decision === 'deny' ? [] : body.include.flatMap((rule) => (rule.email ? [rule.email.email] : []));
      }
      result = { id: 'policy', ...webEmailPolicy(emails) };
    } else if (parsed.pathname === `${appPath}/revoke_tokens`) result = {};
    else throw new Error(`Unexpected fixture request: ${parsed.pathname}`);
    return Response.json({ success: true, result });
  };
  runtime = new ArtifactsRuntime({
    reconcileAccess: (input) => reconcileWebAccessEmails(input, { fetch: fetcher }),
  });
});
afterEach(async () => {
  await runtime?.stop();
  await closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
it('replays a historical success as currently unusable when operator state cannot be read', async () => {
  await runtime.reconcile();
  const input = parseArtifactShare({
    ...publication,
    operation: 'public_publish',
    principal_message: { id: 'mark', messaging_group_id: 'chat' },
  });
  await runtime.sharing.submit(main, 'receipt', input);
  const stored = await getDb().get<{ result_json: string }>(
    "SELECT result_json FROM gws_ea_artifact_requests WHERE request_id='receipt'",
  );
  if (!stored) throw new Error('No historical publication');
  expect(JSON.parse(stored.result_json)).toMatchObject({ ok: true, data: { state: 'active' } });
  const consumed = new Database(inboundDbPath(main.agent_group_id, main.id));
  try {
    consumed.prepare('DELETE FROM messages_in WHERE id=?').run('action-resp-receipt');
  } finally {
    consumed.close();
  }
  fs.writeFileSync(policy.cloudflare.operatorConfigFile, '{');
  await expect(runtime.sharing.submit(main, 'receipt', input)).resolves.toBeUndefined();
  const inbox = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
  try {
    const row = inbox.prepare('SELECT content FROM messages_in WHERE id=?').get('action-resp-receipt') as
      | { content: string }
      | undefined;
    if (!row) throw new Error('No replay answer');
    expect(JSON.parse(row.content)).toMatchObject({
      frame: { ok: true, data: { state: 'active', current_access: { usable: false } } },
    });
  } finally {
    inbox.close();
  }
  expect(await getDb().get("SELECT result_json FROM gws_ea_artifact_requests WHERE request_id='receipt'")).toEqual(
    stored,
  );
});
it.each(['failed', 'verified'] as const)(
  'keeps publication pending while external provisioning is %s',
  async (outcome) => {
    const file = policy.cloudflare.operatorConfigFile;
    const config = await readWebOperatorConfig(file);
    if (!config) throw new Error('Missing owned operator configuration');
    const instanceId = '00000000-0000-4000-8000-000000000001';
    await writeWebOperatorConfig(file, {
      ...config,
      assistants: {
        ...config.assistants,
        [instanceId]: { ...config.assistants[instanceId], publicationReady: false },
      },
    });
    await runtime.reconcile();
    expect(await runtime.health()).toMatchObject({ listener: { state: 'listening' } });
    await runtime.sharing.submit(
      main,
      'during-enable',
      parseArtifactShare({
        ...publication,
        operation: 'public_publish',
        principal_message: { id: 'mark', messaging_group_id: 'chat' },
      }),
    );
    await runtime.reconcile();
    expect(await getDb().get("SELECT state FROM gws_ea_artifact_requests WHERE request_id='during-enable'")).toEqual({
      state: 'pending',
    });
    expect(await getDb().get('SELECT state FROM gws_ea_artifact_shares')).toEqual({ state: 'pending' });
    if (outcome === 'failed') writePolicy(false);
    else
      await writeWebOperatorConfig(file, {
        ...config,
        assistants: {
          ...config.assistants,
          [instanceId]: { ...config.assistants[instanceId], publicationReady: true },
        },
      });
    await runtime.reconcile();
    const row = await getDb().get<{ result_json: string }>(
      "SELECT result_json FROM gws_ea_artifact_requests WHERE request_id='during-enable'",
    );
    if (!row) throw new Error('No publication receipt');
    expect(JSON.parse(row.result_json)).toMatchObject({ ok: outcome === 'verified' });
    expect(await getDb().get('SELECT state FROM gws_ea_artifact_shares')).toEqual({
      state: outcome === 'verified' ? 'active' : 'revoked',
    });
  },
);
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
    const page = await get(`/artifacts/public/${share.share_id}`, method);
    expect(page.status).toBe(200);
    expect(page.cache).toBe('no-store');
    expect(method === 'HEAD' ? page.body === '' : page.body.includes('Report')).toBe(true);
  }
  expect((await get(`/artifacts/${String(publication.artifact_id)}`)).status).toBe(404);
  expect((await get(`/artifacts/${String(publication.artifact_id)}`, 'GET', policy.hostname, identity)).status).toBe(
    200,
  );
  expect((await get(`/artifacts/${String(publication.artifact_id)}`, 'HEAD', policy.hostname, identity)).status).toBe(
    200,
  );
  expect(keys).toHaveBeenCalledTimes(1);
  expect((await get(`/artifacts/public/${share.share_id}`, 'GET', 'wrong.example.com')).status).toBe(404);
  await runtime.reconcile();
  expect(httpCalls.length).toBe(3);
  writePolicy(false);
  expect(await runtime.health()).toMatchObject({ availability: 'disabled', listener: { state: 'stopped' } });
  expect((await get(`/artifacts/public/${share.share_id}`, 'HEAD')).status).toBe(404);
  await runtime.reconcile();
  await expect(get(`/artifacts/public/${share.share_id}`)).rejects.toThrow();
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
  await expect(get('/artifacts/public/00000000-0000-4000-8000-000000000002')).rejects.toThrow();
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
  expect(lookup('gws-ea-web-health')).toMatchObject({ hostOnly: true, access: 'hidden' });
  expect(lookup('gws-ea-web-admission-emails')).toMatchObject({ hostOnly: true, access: 'hidden' });
});

it('keeps disabled and unsupported optional policy local, with read-only health and central authoring data intact', async () => {
  const before = await getDb().get('SELECT html,source_hash FROM gws_ea_artifact_revisions');
  writePolicy(false);
  await runtime.reconcile();
  expect(await runtime.health()).toMatchObject({ enabled: false, availability: 'disabled' });
  fs.writeFileSync(path.join(ROOT, 'policy.json'), JSON.stringify({ ...policy, schemaVersion: 2 }), { mode: 0o600 });
  await runtime.reconcile();
  const original = fs.readFileSync(path.join(ROOT, 'policy.json'));
  expect(await runtime.health()).toMatchObject({
    enabled: false,
    availability: 'unavailable',
    reason: 'invalid-web-policy',
  });
  expect(fs.readFileSync(path.join(ROOT, 'policy.json'))).toEqual(original);
  expect(httpCalls).toEqual([]);
  expect(await getDb().get('SELECT html,source_hash FROM gws_ea_artifact_revisions')).toEqual(before);
  writePolicy();
  await runtime.reconcile();
  expect(await runtime.health()).toMatchObject({ availability: 'available' });
});

it('retains assistant-owned source for main after author access revocation and removal, while stale sessions lose authority', async () => {
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'author', name: 'Author', folder: 'author', created_at: now, agent_provider: null });
  await getDb().run(
    "INSERT INTO container_configs(agent_group_id,capabilities,updated_at) VALUES('author','[\"artifacts\"]',?)",
    now,
  );
  const author = (await resolveSystemSession('author', 'system:author')).session;
  expect(await hasArtifactsAccess('author')).toBe(true);
  const saved = await saveArtifact(
    { agentGroupId: 'author', sessionId: author.id, isMain: false },
    { requestId: 'author-save', action: 'save', fingerprint: 'author-save' },
    { create_key: 'owned-report', title: 'Author report' },
    prepareArtifactSource(Buffer.from('<p>Assistant-owned source</p>')),
  );
  await getDb().run("UPDATE container_configs SET capabilities='[]' WHERE agent_group_id='author'");
  expect(await artifactActor(author)).toBeUndefined();
  const deletion = lookup('groups-delete');
  if (!deletion) throw new Error('Missing native group deletion');
  await deletion.handler(deletion.parseArgs({ id: 'author' }), { caller: 'host' });
  expect(await artifactActor(author)).toBeUndefined();
  const owned = await listArtifacts({ agentGroupId: 'canonical', sessionId: main.id, isMain: true });
  expect(owned.artifacts.some((artifact) => artifact.artifact_id === saved.artifact_id)).toBe(true);
  expect(await getArtifactRevision(String(saved.artifact_id), 1)).toMatchObject({
    html: '<p>Assistant-owned source</p>',
  });
});

it('does not bind after shutdown interrupts real Access verification, and leaves the port reusable', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  runtime = new ArtifactsRuntime({
    reconcileAccess: (input) =>
      reconcileWebAccessEmails(input, {
        fetch: async (url, options) => {
          entered?.();
          await gate;
          return fetcher(url, options);
        },
      }),
  });
  const controller = new AbortController();
  runtime.start(controller.signal);
  await observed;
  controller.abort();
  const stopped = runtime.stop();
  release?.();
  await stopped;
  expect(await runtime.health()).toMatchObject({ availability: 'unavailable', listener: { state: 'stopped' } });
  await runtime.reconcile();
  await expect(get('/artifacts/public/absent')).rejects.toThrow();
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(policy.listenPort, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it('refuses a late startup verification after disable and restores unexpired saved publication intent on re-enable', async () => {
  await runtime.reconcile();
  await runtime.sharing.submit(
    main,
    'lifecycle-publication',
    parseArtifactShare({
      ...publication,
      operation: 'public_publish',
      principal_message: { id: 'mark', messaging_group_id: 'chat' },
    }),
  );
  const share = await getDb().get<{ share_id: string }>('SELECT share_id FROM gws_ea_artifact_shares');
  if (!share) throw new Error('Missing publication');
  await runtime.stop();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  runtime = new ArtifactsRuntime({
    reconcileAccess: (input) =>
      reconcileWebAccessEmails(input, {
        fetch: async (url, options) => {
          entered?.();
          await gate;
          return fetcher(url, options);
        },
      }),
  });
  const starting = runtime.reconcile();
  await observed;
  writePolicy(false);
  release?.();
  await starting;
  expect(await runtime.health()).toMatchObject({ availability: 'disabled', listener: { state: 'stopped' } });
  await expect(get(`/artifacts/public/${share.share_id}`)).rejects.toThrow();
  writePolicy();
  await runtime.reconcile();
  expect((await get(`/artifacts/public/${share.share_id}`)).status).toBe(200);
});

it('denies a publication that expires during downtime on the first restarted origin request', async () => {
  await runtime.reconcile();
  const expiry = new Date(Date.now() + 60000).toISOString();
  await runtime.sharing.submit(
    main,
    'expiring-publication',
    parseArtifactShare({
      ...publication,
      operation: 'public_publish',
      expires_at: expiry,
      principal_message: { id: 'mark', messaging_group_id: 'chat' },
    }),
  );
  const share = await getDb().get<{ share_id: string }>('SELECT share_id FROM gws_ea_artifact_shares');
  if (!share) throw new Error('Missing publication');
  expect((await get(`/artifacts/public/${share.share_id}`)).status).toBe(200);
  await runtime.stop();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(expiry) + 1000);
  runtime = new ArtifactsRuntime({
    reconcileAccess: (input) => reconcileWebAccessEmails(input, { fetch: fetcher }),
  });
  await runtime.reconcile();
  expect((await get(`/artifacts/public/${share.share_id}`)).status).toBe(404);
  expect(await getDb().get('SELECT html FROM gws_ea_artifact_revisions')).toEqual({ html: '<p>Public source</p>' });
});

it('restores central HTML and pointers through the native snapshot roots, then reconciles changed Access before serving', async () => {
  await runtime.reconcile();
  await runtime.sharing.submit(
    main,
    'snapshot-publication',
    parseArtifactShare({
      ...publication,
      operation: 'public_publish',
      principal_message: { id: 'mark', messaging_group_id: 'chat' },
    }),
  );
  const share = await getDb().get<{ share_id: string }>('SELECT share_id FROM gws_ea_artifact_shares');
  if (!share) throw new Error('Missing publication');
  await runtime.stop();
  const layout = instanceLayout(path.join(ROOT, 'instance'));
  fs.mkdirSync(path.join(layout.state, 'data'), { recursive: true, mode: 0o700 });
  const central = path.join(layout.state, 'data', 'v2.db');
  await getDb().run('VACUUM INTO ?', central);
  await closeDb();
  await fence(layout);
  const update = operationName('2026-10-22T00:00:00.000Z');
  const rollback = operationName('2026-10-23T00:00:00.000Z');
  const snapshot = await takeSnapshot(layout, update, releaseName('a'.repeat(40)));
  expect(fs.existsSync(path.join(snapshot, 'data', 'v2.db'))).toBe(true);
  expect(fs.existsSync(path.join(snapshot, 'artifacts'))).toBe(false);
  await initDb(central, { role: 'test' });
  await getDb().run("UPDATE gws_ea_artifact_shares SET state='revoked'");
  await closeDb();
  emails = ['outside@example.com'];
  await restoreSnapshot(layout, update, rollback);
  await initDb(central, { role: 'test' });
  expect(await getDb().get('SELECT html FROM gws_ea_artifact_revisions')).toEqual({ html: '<p>Public source</p>' });
  expect(await getDb().get('SELECT state FROM gws_ea_artifact_shares')).toEqual({ state: 'active' });
  runtime = new ArtifactsRuntime({
    reconcileAccess: (input) => reconcileWebAccessEmails(input, { fetch: fetcher }),
  });
  expect(await runtime.health()).toMatchObject({ availability: 'unavailable' });
  await expect(get(`/artifacts/public/${share.share_id}`)).rejects.toThrow();
  await runtime.reconcile();
  expect(emails).toEqual(['principal@example.com']);
  expect(httpCalls.filter(({ method }) => method === 'PUT')).toHaveLength(1);
  expect((await get(`/artifacts/public/${share.share_id}`)).status).toBe(200);
});
