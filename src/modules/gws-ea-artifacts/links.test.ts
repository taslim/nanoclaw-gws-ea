import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const ROOT = await vi.hoisted(async () => {
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(realpathSync(tmpdir()), `artifact-links-${process.pid}`);
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import { closeDb, createAgentGroup, createPendingApproval, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { HELD_APP_CALL_ACTION, type HeldAppCallPayload } from '../gws-ea-connections/held-calls.js';
import { saveArtifact, prepareArtifactSource } from './db.js';
import { checkArtifactLinksOpenable } from './links.js';
import { checkLinksOpenable } from '../gws-ea-workspace/link-access.js';
import { DENY, defineGuardedAction } from '../../guard/index.js';
import { principalPages, registerWebMount } from '../gws-ea-web/mounts.js';
// The check reads principal pages from the registry; this one stands in when no module serves connections.
if (!principalPages().some(({ name }) => name === 'connections'))
  registerWebMount({
    name: 'connections',
    audience: 'principal',
    path: '/connections',
    methods: ['GET', 'POST'],
    title: 'Connections',
    status: async () => '',
    linkGuard: defineGuardedAction({ action: 'test.artifact-links-connections', decide: () => DENY('test') }),
    handler: () => (_request, response) => response.end(),
  });
let artifactId: string;
let sourceHash: string;
const shareId = '11111111-1111-4111-8111-111111111111';
const publicId = '22222222-2222-4222-8222-222222222222';
const base = 'https://aya.example.com/artifacts';
function policy(enabled = true) {
  fs.writeFileSync(
    path.join(ROOT, 'policy.json'),
    JSON.stringify({
      schemaVersion: 1,
      enabled,
      hostname: 'aya.example.com',
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
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', path.join(ROOT, 'policy.json'));
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
it('allows the exact logins link only toward the principal while web policy is enabled', async () => {
  const url = 'https://aya.example.com/logins';
  expect((await check(url, ['principal@example.com'])).allowed).toBe(true);
  expect((await check(url)).allowed).toBe(false);
  expect((await check(url, [])).allowed).toBe(false);
  for (const audience of [{ unknownRecipients: true }, { nonPrincipalChatMembers: true }])
    expect(
      (await checkArtifactLinksOpenable({ texts: [url], recipients: ['principal@example.com'], ...audience })).allowed,
    ).toBe(false);
  for (const suffix of ['/', '?next=other', '#password'])
    expect((await check(`${url}${suffix}`, ['principal@example.com'])).allowed).toBe(false);
  policy(false);
  expect((await check(url, ['principal@example.com'])).allowed).toBe(false);
});
it('allows each registered principal page at its exact address toward the principal alone, and nothing below it', async () => {
  for (const url of ['https://aya.example.com/', 'https://aya.example.com/connections']) {
    expect((await check(url, ['principal@example.com'])).allowed, url).toBe(true);
    expect((await check(url)).allowed, url).toBe(false);
    expect((await check(url, ['principal@example.com', 'juno@example.com'])).allowed, url).toBe(false);
  }
  for (const url of [
    'https://aya.example.com/connections/callback/app2.ledgerly.example.test',
    'https://aya.example.com/connections/callback/app2.ledgerly.example.test?code=sentinel&state=sentinel',
    'https://aya.example.com/connections/',
    'https://aya.example.com/logins/edit',
  ])
    for (const recipients of [['principal@example.com'], ['juno@example.com']])
      expect((await check(url, recipients)).allowed, url).toBe(false);
  // Refused as below a principal page, naming the page's own address, not as an unknown artifact path.
  expect(await check('https://aya.example.com/connections/callback/app2.ledgerly.example.test')).toEqual({
    allowed: false,
    reason: expect.stringContaining('Connections page address, https://aya.example.com/connections,'),
  });
});

it('allows a canonical live held-call link only toward the principal, and refuses expired, resolved, unknown, non-principal, or non-canonical links', async () => {
  const now = new Date().toISOString();
  const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
  const pastExpiry = new Date(Date.now() - 60_000).toISOString();
  const principalUser = 'gchat:users/principal-1';
  await upsertUser({ id: principalUser, kind: 'human', display_name: 'Principal', created_at: now });
  await bindVerifiedPrincipalUser(principalUser, now);

  const insertHeld = async (opts: {
    approvalId: string;
    viewId: string;
    status?: 'pending' | 'approved';
    expiresAt?: string;
    approverUserId?: string;
  }) => {
    const payload: HeldAppCallPayload = {
      viewId: opts.viewId,
      invocationId: `session:req-${opts.viewId}`,
      appId: '11111111-1111-4111-8111-111111111111',
      appName: 'Bistro',
      appHost: 'mcp.bistro.example.test',
      grantGeneration: 1,
      toolName: 'confirm_checkout',
      definitionHash: 'defhash-1',
      canonicalArgs: '{"checkout_id":"chk_1"}',
      argsHash: 'argshash-1',
      summary: 'Confirm order',
      appContext: null,
      expiresAt: opts.expiresAt ?? futureExpiry,
    };
    await createPendingApproval({
      approval_id: opts.approvalId,
      session_id: 'session',
      request_id: `req-${opts.viewId}`,
      action: HELD_APP_CALL_ACTION,
      payload: JSON.stringify(payload),
      title: 'Allow Bistro to run confirm_checkout?',
      question: 'Confirm order',
      options_json: JSON.stringify([{ value: 'approve', label: 'Approve' }]),
      status: opts.status ?? 'pending',
      created_at: now,
      expires_at: opts.expiresAt ?? futureExpiry,
      approver_user_id: opts.approverUserId ?? principalUser,
    });
  };

  await insertHeld({ approvalId: 'appr-live-1', viewId: 'held-live-1' });
  await insertHeld({ approvalId: 'appr-expired-1', viewId: 'held-expired-1', expiresAt: pastExpiry });
  await insertHeld({ approvalId: 'appr-approved-1', viewId: 'held-approved-1', status: 'approved' });
  await insertHeld({
    approvalId: 'appr-other-1',
    viewId: 'held-other-1',
    approverUserId: 'gchat:users/not-principal',
  });

  const liveUrl = 'https://aya.example.com/connections/held/held-live-1';
  expect((await check(liveUrl, ['principal@example.com'])).allowed).toBe(true);
  // Non-principal, mixed audience, unknown, disabled policy, or non-canonical URL variants are all refused.
  expect((await check(liveUrl, ['juno@example.com'])).allowed).toBe(false);
  expect((await check(liveUrl, ['principal@example.com', 'juno@example.com'])).allowed).toBe(false);
  expect(
    (
      await checkArtifactLinksOpenable({
        texts: [liveUrl],
        recipients: ['principal@example.com'],
        unknownRecipients: true,
      })
    ).allowed,
  ).toBe(false);
  expect(
    (
      await checkArtifactLinksOpenable({
        texts: [liveUrl],
        recipients: ['principal@example.com'],
        nonPrincipalChatMembers: true,
      })
    ).allowed,
  ).toBe(false);
  for (const variant of [
    `${liveUrl}/`,
    `${liveUrl}?foo=bar`,
    `${liveUrl}#section`,
    'https://aya.example.com/connections/held/held%2dlive-1',
    'https://aya.example.com/connections/held/appr-live-1',
    'https://aya.example.com/connections/held/held-expired-1',
    'https://aya.example.com/connections/held/held-approved-1',
    'https://aya.example.com/connections/held/held-other-1',
    'https://aya.example.com/connections/held/held-unknown-1',
  ]) {
    expect((await check(variant, ['principal@example.com'])).allowed, variant).toBe(false);
  }
  policy(false);
  expect((await check(liveUrl, ['principal@example.com'])).allowed).toBe(false);
  policy(true);

  // Terminal approval-card edit toward the principal's DM allows canonical /connections/held/<id> even after deletion,
  // while still refusing callbacks and non-principal targets.
  const { createMessagingGroup } = await import('../../db/messaging-groups.js');
  const { upsertUserDm } = await import('../permissions/db/user-dms.js');
  const { setDeliveryAdapter, OutboundRefusedError } = await import('../../delivery.js');
  await createMessagingGroup({
    id: 'mg-principal-dm',
    channel_type: 'gchat',
    platform_id: 'spaces/dm-principal',
    name: 'Principal DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await upsertUserDm({
    user_id: principalUser,
    channel_type: 'gchat',
    messaging_group_id: 'mg-principal-dm',
    resolved_at: now,
  });
  const deliver = vi.fn(async () => undefined);
  const channel = setDeliveryAdapter({ deliver });
  const deletedViewUrl = 'https://aya.example.com/connections/held/held-already-deleted';
  const terminalEditPayload = (url: string) =>
    JSON.stringify({
      operation: 'edit',
      questionId: 'appr-deleted',
      messageId: 'msg-1',
      text: `Allow Bistro?\n\nReview: ${url}\n\n❌ Rejected`,
      terminalCard: { title: 'Allow Bistro?', question: `Review: ${url}`, resolution: '❌ Rejected' },
    });
  await channel.deliver('gchat', 'spaces/dm-principal', null, 'chat-sdk', terminalEditPayload(deletedViewUrl));
  expect(deliver).toHaveBeenCalledTimes(1);
  // A container-originated send carrying sourceSessionId can never claim terminal approval-card edit authority.
  await expect(
    channel.deliver(
      'gchat',
      'spaces/dm-principal',
      null,
      'chat-sdk',
      terminalEditPayload(deletedViewUrl),
      undefined,
      undefined,
      'session:forged-edit',
      now,
      'session',
    ),
  ).rejects.toBeInstanceOf(OutboundRefusedError);
  // Callback path is still refused even in a terminal card edit to the principal.
  await expect(
    channel.deliver(
      'gchat',
      'spaces/dm-principal',
      null,
      'chat-sdk',
      terminalEditPayload('https://aya.example.com/connections/callback/mcp.bistro.example.test'),
    ),
  ).rejects.toBeInstanceOf(OutboundRefusedError);
  // Non-principal room is still refused even in a terminal card edit.
  await expect(
    channel.deliver('gchat', 'spaces/other-room', null, 'chat-sdk', terminalEditPayload(deletedViewUrl)),
  ).rejects.toBeInstanceOf(OutboundRefusedError);
  expect(deliver).toHaveBeenCalledTimes(1);
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
  await getDb().run("UPDATE gws_ea_chat_members SET email='principal@example.com' WHERE member_key='known'");
  await expect(
    channel.deliver(
      'gchat',
      'room',
      null,
      'chat',
      JSON.stringify({ text: `${base}/${artifactId}` }),
      undefined,
      'second',
    ),
  ).rejects.toBeInstanceOf(OutboundRefusedError);
  expect(deliver).toHaveBeenCalledTimes(2);
  await channel.deliver(
    'gchat',
    'room',
    null,
    'chat',
    JSON.stringify({ text: `${base}/share/${shareId}` }),
    undefined,
    'second',
  );
  expect(deliver).toHaveBeenCalledTimes(3);
  await getDb().run("UPDATE gws_ea_chat_members SET is_principal=1 WHERE member_key='known'");
  await channel.deliver(
    'gchat',
    'room',
    null,
    'chat',
    JSON.stringify({ text: `${base}/${artifactId}` }),
    undefined,
    'second',
  );
  expect(deliver).toHaveBeenCalledTimes(4);
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
  expect(deliver).toHaveBeenCalledTimes(4);
});

it.each(['private', 'named', 'public'] as const)(
  'checks a %s artifact URL in an attachment containing invalid UTF-8 at the final delivery boundary',
  async (kind) => {
    const { setDeliveryAdapter, OutboundRefusedError } = await import('../../delivery.js');
    const url =
      kind === 'private'
        ? `${base}/${artifactId}`
        : kind === 'named'
          ? `${base}/share/${shareId}`
          : `${base}/public/${publicId}`;
    const files = [{ filename: 'report.bin', data: Buffer.concat([Buffer.from([0xff]), Buffer.from(`\n${url}\n`)]) }];
    const deliver = vi.fn(async () => undefined);
    const channel = setDeliveryAdapter({ deliver });
    const sent = channel.deliver('gchat', 'unknown-room', null, 'chat', '{"text":"Report attached"}', files);
    if (kind === 'public') {
      await expect(sent).resolves.toBeUndefined();
      expect(deliver).toHaveBeenCalledTimes(1);
    } else {
      await expect(sent).rejects.toBeInstanceOf(OutboundRefusedError);
      expect(deliver).not.toHaveBeenCalled();
    }
  },
);

it.each(['/', '/other', '/artifact', '/artifactsx', '/%61rtifacts/public/22222222-2222-4222-8222-222222222222'])(
  'refuses every noncanonical address on the assistant host: %s',
  async (route) => {
    const { setDeliveryAdapter, OutboundRefusedError } = await import('../../delivery.js');
    const deliver = vi.fn(async () => undefined);
    const channel = setDeliveryAdapter({ deliver });
    await expect(
      channel.deliver(
        'gchat',
        'unknown-room',
        null,
        'chat',
        JSON.stringify({ text: `https://aya.example.com${route}` }),
      ),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(deliver).not.toHaveBeenCalled();
  },
);
