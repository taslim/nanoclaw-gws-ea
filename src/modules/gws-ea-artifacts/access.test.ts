import fs from 'node:fs';
import path from 'node:path';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const ROOT = await vi.hoisted(async () => {
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(realpathSync(tmpdir()), `artifact-access-${process.pid}`);
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import { closeDb, createAgentGroup, createSession, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createWebIdentity, createWebIdentityVerifier, isPrincipalWebIdentity } from '../gws-ea-web/access.js';
import type { WebPolicyFile } from '../gws-ea-web/policy.js';
import { createArtifactViewResolver } from './access.js';
import { prepareArtifactSource, saveArtifact } from './db.js';

const config: WebPolicyFile = {
  schemaVersion: 1,
  enabled: true,
  hostname: 'aya.example.com',
  listenPort: 9123,
  accessIssuer: 'https://team.cloudflareaccess.com',
  accessAud: 'aya-aud',
  cloudflare: { accountId: 'account', applicationId: 'aya', operatorConfigFile: '/private/tmp/operator.json' },
};
const named = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const published = '33333333-3333-4333-8333-333333333333';
let artifactId: string;
let otherArtifactId: string;
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof vi.fn<typeof fetch>>;
let resolve: ReturnType<typeof createArtifactViewResolver>;
async function view(id: string, audience: 'private' | 'share' | 'public', email?: string, aud = 'aya-aud') {
  const request = new IncomingMessage(new Socket());
  if (email)
    request.headers['cf-access-jwt-assertion'] = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'current' })
      .setIssuer(config.accessIssuer)
      .setAudience(aud)
      .setExpirationTime('1h')
      .sign(key.privateKey);
  return resolve(request, { id, audience, viewPath: `/artifacts/${id}` });
}
beforeEach(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'policy.json'), JSON.stringify(config), { mode: 0o600 });
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', path.join(ROOT, 'policy.json'));
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'main', name: 'Aya', folder: 'main', agent_provider: null, created_at: now });
  await createSession({
    id: 'session',
    agent_group_id: 'main',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: now,
    created_at: now,
  });
  await getDb().run('INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)', 'principal@example.com', now);
  const source = prepareArtifactSource(Buffer.from('<p>Exact selected report</p>'));
  const saved = await saveArtifact(
    { agentGroupId: 'main', sessionId: 'session', isMain: true },
    { requestId: 'save', action: 'save', fingerprint: 'save' },
    { create_key: 'report', title: 'Report' },
    source,
  );
  artifactId = saved.artifact_id;
  otherArtifactId = (
    await saveArtifact(
      { agentGroupId: 'main', sessionId: 'session', isMain: true },
      { requestId: 'save-other', action: 'save', fingerprint: 'save-other' },
      { create_key: 'other', title: 'Other report' },
      source,
    )
  ).artifact_id;
  for (const [id, kind] of [
    [named, 'named'],
    [other, 'named'],
    [published, 'public'],
  ])
    await getDb().run(
      "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,scope_hash,created_at,updated_at) VALUES(?,?,?,1,?,1,'active','scope',?,?)",
      id,
      artifactId,
      kind,
      source.source_hash,
      now,
      now,
    );
  await getDb().run(
    'INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)',
    named,
    'remy@example.com',
  );
  await getDb().run(
    'INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)',
    other,
    'other@example.com',
  );
  key = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'current', alg: 'RS256' };
  keys = vi.fn(async () => Response.json({ keys: [jwk] }));
  resolve = createArtifactViewResolver(
    config,
    createWebIdentity(config, createWebIdentityVerifier(config.accessIssuer, config.accessAud, keys)),
  );
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
it('checks the exact artifact audience after a real Access JWT, including a peer application token', async () => {
  expect(await view(named, 'share', 'remy@example.com')).toMatchObject({ html: '<p>Exact selected report</p>' });
  expect(await view(artifactId, 'private', 'remy@example.com')).toBeUndefined();
  expect(await view(otherArtifactId, 'private', 'remy@example.com')).toBeUndefined();
  expect(await view(other, 'share', 'remy@example.com')).toBeUndefined();
  expect(await view(artifactId, 'private', 'principal@example.com', 'juno-aud')).toBeUndefined();
  expect(await view(artifactId, 'private', 'principal@example.com')).toBeDefined();
});
it('distinguishes a verified named-share reader from the current principal for shared web features', async () => {
  const request = new IncomingMessage(new Socket());
  const identity = createWebIdentity(config, createWebIdentityVerifier(config.accessIssuer, config.accessAud, keys));
  for (const [email, principal] of [
    ['remy@example.com', false],
    ['principal@example.com', true],
  ] as const) {
    request.headers['cf-access-jwt-assertion'] = await new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'current' })
      .setIssuer(config.accessIssuer)
      .setAudience(config.accessAud)
      .setExpirationTime('1h')
      .sign(key.privateKey);
    const verified = await identity(request);
    expect(verified).toBe(email);
    expect(await isPrincipalWebIdentity(verified)).toBe(principal);
  }
  await getDb().run("DELETE FROM gws_ea_principal_addresses WHERE email='principal@example.com'");
  expect(await isPrincipalWebIdentity(await identity(request))).toBe(false);
  expect(await isPrincipalWebIdentity(undefined)).toBe(false);
});
it('serves a live public publication without identity verification and denies revocation or policy disable immediately', async () => {
  expect(await view(published, 'public')).toMatchObject({ html: '<p>Exact selected report</p>' });
  expect(keys).not.toHaveBeenCalled();
  await getDb().run("UPDATE gws_ea_artifact_shares SET state='revoked' WHERE share_id=?", published);
  expect(await view(published, 'public')).toBeUndefined();
  await getDb().run("UPDATE gws_ea_artifact_shares SET state='active' WHERE share_id=?", published);
  fs.writeFileSync(path.join(ROOT, 'policy.json'), JSON.stringify({ ...config, enabled: false }));
  expect(await view(published, 'public')).toBeUndefined();
  expect(keys).not.toHaveBeenCalled();
});
