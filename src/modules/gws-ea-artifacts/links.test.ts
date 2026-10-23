import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/private/tmp/artifact-links-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { saveArtifact, prepareArtifactSource } from './db.js';
import { checkArtifactLinksOpenable } from './links.js';
import { checkLinksOpenable } from '../gws-ea-workspace/link-access.js';
let artifactId: string;
let sourceHash: string;
const shareId = '11111111-1111-4111-8111-111111111111';
const publicId = '22222222-2222-4222-8222-222222222222';
const base = 'https://views.example.com/aya';
function policy(enabled = true) {
  fs.writeFileSync(
    path.join(ROOT, 'policy.json'),
    JSON.stringify({
      schemaVersion: 1,
      enabled,
      hostname: 'views.example.com',
      pathPrefix: '/aya',
      listenPort: 9123,
      accessIssuer: 'https://team.cloudflareaccess.com',
      accessAud: 'aud',
      cloudflare: { accountId: 'a', applicationId: 'b', operatorConfigFile: '/private/tmp/cf.json' },
    }),
    { mode: 0o600 },
  );
}
async function check(url: string, recipients = ['juno@example.com']) {
  return checkArtifactLinksOpenable({ texts: [url], recipients });
}
beforeEach(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  policy();
  vi.stubEnv('GWS_EA_ARTIFACTS_POLICY_FILE', path.join(ROOT, 'policy.json'));
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'main', name: 'Main', folder: 'main', agent_provider: null, created_at: now });
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
  const source = prepareArtifactSource(Buffer.from('<p>Report</p>'));
  sourceHash = source.source_hash;
  artifactId = (
    await saveArtifact(
      { agentGroupId: 'main', sessionId: 'session', isMain: true },
      { requestId: 'create', action: 'save', fingerprint: 'save' },
      { title: 'Report', create_key: 'report' },
      source,
    )
  ).artifact_id;
  for (const [id, kind] of [
    [shareId, 'named'],
    [publicId, 'public'],
  ])
    await getDb().run(
      "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,scope_hash,created_at,updated_at) VALUES(?,?,?,1,?,1,'active','scope',?,?)",
      id,
      artifactId,
      kind,
      sourceHash,
      now,
      now,
    );
  await getDb().run(
    'INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)',
    shareId,
    'juno@example.com',
  );
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
it('checks exact applied named/public/private audiences locally and refuses unknown named identities', async () => {
  expect((await check(`${base}/${artifactId}`, ['principal@example.com'])).allowed).toBe(true);
  expect((await check(`${base}/${artifactId}`)).allowed).toBe(false);
  expect((await check(`${base}/share/${shareId}`)).allowed).toBe(true);
  expect((await check(`${base}/share/${shareId}`, ['unknown-person'])).allowed).toBe(false);
  expect((await check(`${base}/share/${shareId}`, ['other@example.com'])).allowed).toBe(false);
  expect((await check(`${base}/public/${publicId}`, ['unknown-person'])).allowed).toBe(true);
});
it('denies stale hash, pending/revoked state, expiry, disable and deleted content even for the principal', async () => {
  const url = `${base}/share/${shareId}`;
  await getDb().run('UPDATE gws_ea_artifact_shares SET source_hash=? WHERE share_id=?', 'f'.repeat(64), shareId);
  expect((await check(url)).allowed).toBe(false);
  await getDb().run(
    "UPDATE gws_ea_artifact_shares SET source_hash=?,state='pending' WHERE share_id=?",
    sourceHash,
    shareId,
  );
  expect((await check(url)).allowed).toBe(false);
  await getDb().run(
    "UPDATE gws_ea_artifact_shares SET state='active',expires_at=? WHERE share_id=?",
    '2000-01-01T00:00:00.000Z',
    shareId,
  );
  expect((await check(url)).allowed).toBe(false);
  policy(false);
  expect((await check(`${base}/${artifactId}`, ['principal@example.com'])).allowed).toBe(false);
});
it('runs at the existing final outgoing wrapper even when there is no Google link or only a principal recipient', async () => {
  const request = {
    texts: [`${base}/share/${shareId}`],
    recipients: ['principal@example.com'],
    writer: 'main' as const,
  };
  expect((await checkLinksOpenable(request)).allowed).toBe(true);
  await getDb().run("UPDATE gws_ea_artifact_shares SET state='revoked' WHERE share_id=?", shareId);
  expect((await checkLinksOpenable(request)).allowed).toBe(false);
});
it('refuses a final channel delivery after revocation and never drops a member with unknown identity', async () => {
  const { createMessagingGroup } = await import('../../db/messaging-groups.js');
  const { setDeliveryAdapter, OutboundRefusedError } = await import('../../delivery.js');
  const now = new Date().toISOString();
  await createMessagingGroup({
    id: 'chat',
    channel_type: 'gchat',
    platform_id: 'room',
    instance: 'second',
    name: 'Room',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO gws_ea_chats(messaging_group_id,state,serving_agent_group_id,principal_present,created_at,updated_at) VALUES('chat','connected','main',0,?,?)",
    now,
    now,
  );
  for (const [member, email, source] of [
    ['known', 'juno@example.com', 'main'],
    ['unknown', null, null],
  ])
    await getDb().run(
      "INSERT INTO gws_ea_chat_members(messaging_group_id,member_key,is_principal,email,email_source,updated_at) VALUES('chat',?,0,?,?,?)",
      member,
      email,
      source,
      now,
    );
  const deliver = vi.fn(async () => undefined);
  const channel = setDeliveryAdapter({ deliver });
  await expect(
    channel.deliver(
      'gchat',
      'room',
      null,
      'chat',
      JSON.stringify({ text: `${base}/share/${shareId}` }),
      undefined,
      'second',
    ),
  ).rejects.toBeInstanceOf(OutboundRefusedError);
  expect(deliver).not.toHaveBeenCalled();
  await channel.deliver(
    'gchat',
    'room',
    null,
    'chat',
    JSON.stringify({ text: `${base}/public/${publicId}` }),
    undefined,
    'second',
  );
  expect(deliver).toHaveBeenCalledTimes(1);
  await getDb().run("DELETE FROM gws_ea_chat_members WHERE member_key='unknown'");
  await channel.deliver(
    'gchat',
    'room',
    null,
    'chat',
    JSON.stringify({ text: `${base}/share/${shareId}` }),
    undefined,
    'second',
  );
  expect(deliver).toHaveBeenCalledTimes(2);
  await getDb().run("UPDATE gws_ea_artifact_shares SET state='revoked' WHERE share_id=?", shareId);
  await expect(
    channel.deliver(
      'gchat',
      'room',
      null,
      'chat',
      JSON.stringify({ text: `${base}/share/${shareId}` }),
      undefined,
      'second',
    ),
  ).rejects.toBeInstanceOf(OutboundRefusedError);
  expect(deliver).toHaveBeenCalledTimes(2);
});
