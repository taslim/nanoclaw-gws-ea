import fs from 'node:fs';
import path from 'node:path';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const ROOT = await vi.hoisted(async () => {
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(realpathSync(tmpdir()), `artifact-sharing-${process.pid}`);
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: async () => false }));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  getMessagingGroup,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { createPendingApproval, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { expireApproval } from '../approvals/lifecycle.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { runGuarded } from '../../delivery-guard.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSystemSession } from '../../session-manager.js';
import type { ResponseFrame } from '../../cli/frame.js';
import type { Session } from '../../types.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { preparePrincipalMessageContent } from '../gws-ea-profile/marks.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import { getApprovalHandler, getApprovalRejectionFinalizer } from '../approvals/primitive.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { createArtifactViewResolver } from './access.js';
import { ARTIFACT_SHARE_APPROVAL, authorizeArtifactShare, parseArtifactShare } from './authority.js';
import { artifactDigest, deleteArtifact, prepareArtifactSource, saveArtifact } from './db.js';
import { artifactAdmissionEmails, artifactShares, ArtifactSharing } from './sharing.js';
import type { ArtifactsPolicyFile } from './policy.js';

let main: Session;
let input: Record<string, unknown>;
let sharing: ArtifactSharing;
let remote = vi.fn(async (_config: ArtifactsPolicyFile): Promise<void> => {});
const policy: ArtifactsPolicyFile = {
  schemaVersion: 1,
  enabled: true,
  hostname: 'views.example.com',
  pathPrefix: '/aya',
  listenPort: 9123,
  accessIssuer: 'https://team.cloudflareaccess.com',
  accessAud: 'aud',
  cloudflare: { accountId: 'a', applicationId: 'b', operatorConfigFile: '/private/tmp/cf.json' },
};
function writePolicy(enabled = true): void {
  fs.writeFileSync(path.join(ROOT, 'policy.json'), JSON.stringify({ ...policy, enabled }), { mode: 0o600 });
}
function response(id: string): ResponseFrame | undefined {
  if (!fs.existsSync(inboundDbPath(main.agent_group_id, main.id))) return undefined;
  const db = new Database(inboundDbPath(main.agent_group_id, main.id), { readonly: true });
  try {
    const row = db.prepare('SELECT content FROM messages_in WHERE id=?').get(`action-resp-${id}`) as
      | { content: string }
      | undefined;
    return row ? (JSON.parse(row.content) as { frame: ResponseFrame }).frame : undefined;
  } finally {
    db.close();
  }
}
function data(id: string): Record<string, unknown> {
  const frame = response(id);
  if (!frame?.ok) throw new Error(frame && !frame.ok ? frame.error.message : 'No native response');
  if (!frame.data || typeof frame.data !== 'object' || Array.isArray(frame.data)) throw new Error('No result object');
  return frame.data as Record<string, unknown>;
}
async function send(id: string, value = input): Promise<void> {
  await runGuarded(
    'artifact_share',
    sharing.deliveryGuard,
    sharing.handler,
    { action: 'artifact_share', requestId: id, ...value },
    main,
    null,
  );
}
function request(email?: string): IncomingMessage {
  const message = new IncomingMessage(new Socket());
  if (email) message.headers['cf-access-jwt-assertion'] = email;
  return message;
}
async function view(id: string, audience: 'private' | 'share' | 'public', email?: string) {
  const resolver = createArtifactViewResolver(policy, async (identity) => identity);
  return resolver(request(email), { id, audience, viewPath: '/' });
}
beforeEach(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  writePolicy();
  vi.stubEnv('GWS_EA_ARTIFACTS_POLICY_FILE', path.join(ROOT, 'policy.json'));
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'canonical', name: 'Aya', folder: 'canonical', agent_provider: null, created_at: now });
  await getDb().run(
    "UPDATE gws_ea_profile SET main_agent_group_id='canonical',assistant_first_name='Aya',principal_first_name='Morgan' WHERE singleton=1",
  );
  main = (await resolveSystemSession('canonical', 'system:sharing')).session;
  await upsertUser({ id: 'gchat:principal', kind: 'gchat', display_name: 'Principal', created_at: now });
  await bindVerifiedPrincipalUser('gchat:principal', now);
  await getDb().run('INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)', 'principal@example.com', now);
  await createMessagingGroup({
    id: 'chat',
    channel_type: 'gchat',
    platform_id: 'chat',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await upsertUserDm({
    user_id: 'gchat:principal',
    channel_type: 'gchat',
    messaging_group_id: 'chat',
    resolved_at: now,
  });
  await getDb().run(
    'INSERT INTO gws_ea_principal_messages(message_id,messaging_group_id,user_id,timestamp,text) VALUES(?,?,?,?,?)',
    'mark',
    'chat',
    'gchat:principal',
    now,
    'Share the report with Juno or publish it.',
  );
  const source = prepareArtifactSource(Buffer.from('<p>Shared report</p>'));
  const saved = await saveArtifact(
    { agentGroupId: 'canonical', sessionId: main.id, isMain: true },
    { requestId: 'create', action: 'save', fingerprint: 'create' },
    { create_key: 'report', title: 'Original report' },
    source,
  );
  input = {
    operation: 'named_publish',
    artifact_id: saved.artifact_id,
    revision: 1,
    expected_hash: saved.source_hash,
    recipients: [{ email: 'juno@example.com' }],
    principal_message: { id: 'mark', messaging_group_id: 'chat' },
  };
  remote = vi.fn(async (_config: ArtifactsPolicyFile): Promise<void> => {});
  sharing = new ArtifactSharing({ verifyAdmission: remote, publicationReady: () => true });
  sharing.registerApprovals();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
it('publishes and revokes using the exact native Google Chat principal message ID', async () => {
  const messageId = 'spaces/AAAAjuno/messages/remy.1';
  const messagingGroup = await getMessagingGroup('chat');
  if (!messagingGroup) throw new Error('No principal chat');
  const prepared = await preparePrincipalMessageContent({
    content: JSON.stringify({ text: 'Publish this exact report, then withdraw it.' }),
    channelType: 'gchat',
    instance: 'gchat',
    platformId: 'spaces/AAAAjuno',
    messageId,
    timestamp: new Date().toISOString(),
    authenticatedSender: { userId: 'gchat:principal', kind: 'human' },
    session: main,
    messagingGroup,
  });
  expect(JSON.parse(prepared)).toMatchObject({ principalMessage: { id: messageId, messagingGroupId: 'chat' } });
  const { recipients: _recipients, ...publication } = input;
  const principal_message = { id: messageId, messaging_group_id: 'chat' };
  await send('native-publish', { ...publication, operation: 'public_publish', principal_message });
  const applied = data('native-publish');
  expect(applied).toMatchObject({ state: 'active', revision: 1 });
  expect(await view(String(applied.share_id), 'public')).toMatchObject({ html: '<p>Shared report</p>' });
  await send('native-revoke', {
    operation: 'revoke',
    artifact_id: input.artifact_id,
    share_id: applied.share_id,
    expected_generation: applied.generation,
    principal_message,
  });
  expect(data('native-revoke')).toMatchObject({ state: 'revoked' });
  expect(await view(String(applied.share_id), 'public')).toBeUndefined();
});
it('applies exact named snapshots through native guard/mailbox; a guest cannot open the private head or another grant', async () => {
  await send('named');
  const applied = data('named');
  expect(applied).toMatchObject({ state: 'active', generation: 1, title: 'Original report', revision: 1 });
  expect(remote).toHaveBeenCalledTimes(1);
  expect(await view(String(applied.share_id), 'share', 'juno@example.com')).toMatchObject({
    title: 'Original report',
    html: '<p>Shared report</p>',
  });
  expect(await view(String(input.artifact_id), 'private', 'juno@example.com')).toBeUndefined();
  expect(await view(String(applied.share_id), 'share', 'stranger@example.com')).toBeUndefined();
  expect(await view(String(input.artifact_id), 'private')).toBeUndefined();
  expect(await view(String(input.artifact_id), 'private', 'principal@example.com')).toBeDefined();
  await send('other', { ...input, recipients: [{ email: 'other@example.com' }] });
  expect(await view(String(data('other').share_id), 'share', 'juno@example.com')).toBeUndefined();
  await saveArtifact(
    { agentGroupId: 'canonical', sessionId: main.id, isMain: true },
    { requestId: 'edit', action: 'save', fingerprint: 'edit' },
    { artifact_id: String(input.artifact_id), expected_revision: 1, title: 'Private new title' },
    prepareArtifactSource(Buffer.from('<p>Private new body</p>')),
  );
  expect(await view(String(applied.share_id), 'share', 'juno@example.com')).toMatchObject({
    title: 'Original report',
    html: '<p>Shared report</p>',
  });
  expect(await view(String(input.artifact_id), 'private', 'principal@example.com')).toMatchObject({
    title: 'Private new title',
  });
  const first = await artifactShares(String(input.artifact_id), policy);
  const second = first.shares_next_cursor
    ? await artifactShares(String(input.artifact_id), policy, first.shares_next_cursor)
    : { shares: [] };
  expect([...first.shares, ...second.shares]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        share_id: applied.share_id,
        title: 'Original report',
        generation: 1,
        recipients: ['juno@example.com'],
      }),
    ]),
  );
});
it('publishes anonymously in its public namespace only, requires explicit generation replacement and never changes the stable slot', async () => {
  const { recipients: _recipients, ...publication } = input;
  const published = { ...publication, operation: 'public_publish' };
  await send('public', published);
  const applied = data('public');
  expect(remote).not.toHaveBeenCalled();
  expect(await view(String(applied.share_id), 'public')).toMatchObject({ title: 'Original report' });
  expect(await view(String(input.artifact_id), 'public')).toBeUndefined();
  expect(await view(String(applied.share_id), 'private')).toBeUndefined();
  await send('duplicate', published);
  expect(response('duplicate')).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('explicitly replace') },
  });
  await send('replace', {
    ...published,
    operation: 'public_replace',
    share_id: applied.share_id,
    expected_generation: 1,
  });
  expect(data('replace')).toMatchObject({ share_id: applied.share_id, generation: 2, state: 'active' });
  await send('stale', {
    ...published,
    operation: 'public_replace',
    share_id: applied.share_id,
    expected_generation: 1,
  });
  expect(response('stale')).toMatchObject({ ok: false });
  await send('unpublish', {
    operation: 'revoke',
    artifact_id: input.artifact_id,
    share_id: applied.share_id,
    expected_generation: 2,
    principal_message: input.principal_message,
  });
  expect(await view(String(applied.share_id), 'public')).toBeUndefined();
  await send('republish', {
    ...published,
    operation: 'public_replace',
    share_id: applied.share_id,
    expected_generation: 3,
  });
  expect(data('republish')).toMatchObject({ share_id: applied.share_id, generation: 4, state: 'active' });
  expect(await view(String(applied.share_id), 'public')).toBeDefined();
});
it.each(['revoke', 'delete', 'disable', 'edit', 'profile'] as const)(
  'cannot activate a delayed named admission after %s changes its authority',
  async (change) => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    remote.mockImplementation(async () => {
      started?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const pending = send('delayed');
    await reached;
    expect(response('delayed')).toBeUndefined();
    const row = await getDb().get<{ share_id: string }>('SELECT share_id FROM gws_ea_artifact_shares');
    if (!row) throw new Error('No reservation');
    if (change === 'revoke')
      await send('revoke', {
        operation: 'revoke',
        artifact_id: input.artifact_id,
        share_id: row.share_id,
        expected_generation: 1,
        principal_message: input.principal_message,
      });
    if (change === 'delete')
      await deleteArtifact(
        { agentGroupId: 'canonical', sessionId: main.id, isMain: true },
        { requestId: 'delete', action: 'delete', fingerprint: 'delete' },
        String(input.artifact_id),
        1,
      );
    if (change === 'disable') writePolicy(false);
    if (change === 'edit')
      await saveArtifact(
        { agentGroupId: 'canonical', sessionId: main.id, isMain: true },
        { requestId: 'edit', action: 'save', fingerprint: 'edit' },
        { artifact_id: String(input.artifact_id), expected_revision: 1, title: 'Changed' },
        prepareArtifactSource(Buffer.from('Changed')),
      );
    if (change === 'profile') await getDb().run('DELETE FROM gws_ea_principal_users');
    release?.();
    await pending;
    expect(response('delayed')).toMatchObject({ ok: false });
    expect(await getDb().get('SELECT state FROM gws_ea_artifact_shares WHERE share_id=?', row.share_id)).toEqual({
      state: 'revoked',
    });
    expect(await view(row.share_id, 'share', 'juno@example.com')).toBeUndefined();
  },
);
it('keeps explicit named invitations independent of the current principal list and denies removed principals using old identity', async () => {
  await send('separate', { ...input, recipients: [{ email: 'principal@example.com' }] });
  const shareId = String(data('separate').share_id);
  await getDb().run('DELETE FROM gws_ea_principal_addresses');
  expect(await view(String(input.artifact_id), 'private', 'principal@example.com')).toBeUndefined();
  expect(await view(shareId, 'share', 'principal@example.com')).toBeDefined();
  expect(await artifactAdmissionEmails()).toEqual(['principal@example.com']);
  writePolicy(false);
  expect(await artifactAdmissionEmails()).toEqual(['principal@example.com']);
  expect(await view(shareId, 'share', 'principal@example.com')).toBeUndefined();
});
it('settles failed admission honestly and replays a lost mailbox response without remote work or resurrection', async () => {
  remote.mockRejectedValue(new Error('Access unavailable'));
  await send('failed');
  expect(response('failed')).toMatchObject({ ok: false, error: { code: 'handler-error' } });
  expect(await getDb().get("SELECT state FROM gws_ea_artifact_requests WHERE request_id='failed'")).toEqual({
    state: 'settled',
  });
  remote.mockResolvedValue();
  await send('success');
  const applied = data('success');
  const calls = remote.mock.calls.length;
  const mailbox = new Database(inboundDbPath(main.agent_group_id, main.id));
  mailbox.prepare("DELETE FROM messages_in WHERE id='action-resp-success'").run();
  mailbox.close();
  const restarted = new ArtifactSharing({ verifyAdmission: remote, publicationReady: () => true });
  await restarted.recover();
  expect(data('success')).toMatchObject({ share_id: applied.share_id, state: 'active' });
  expect(remote).toHaveBeenCalledTimes(calls);
  await send('revoke', {
    operation: 'revoke',
    artifact_id: input.artifact_id,
    share_id: applied.share_id,
    expected_generation: 1,
    principal_message: input.principal_message,
  });
  await send('success');
  expect(await view(String(applied.share_id), 'share', 'juno@example.com')).toBeUndefined();
  expect(remote).toHaveBeenCalledTimes(calls);
});
it('rejects changed request input and oversized exact payload before any audience effects', async () => {
  await send('same');
  const calls = remote.mock.calls.length;
  await sharing.submit(
    main,
    'same',
    parseArtifactShare({ ...input, recipients: [{ email: 'different@example.com' }] }),
  );
  expect(remote).toHaveBeenCalledTimes(calls);
  expect(await getDb().all('SELECT email FROM gws_ea_artifact_share_recipients')).toEqual([
    { email: 'juno@example.com' },
  ]);
  const recipients = Array.from({ length: 100 }, (_, index) => ({
    email: `guest${index}@example.com`,
    name: 'A'.repeat(256),
  }));
  await send('large', { ...input, recipients });
  expect(response('large')).toMatchObject({ ok: false, error: { message: expect.stringContaining('16 KiB') } });
  expect(await getDb().all('SELECT share_id FROM gws_ea_artifact_shares')).toHaveLength(1);
});
it('returns every recipient in a complete bounded page for a large legal audience', async () => {
  const recipients = Array.from({ length: 100 }, (_, index) => ({
    email: `guest${String(index).padStart(3, '0')}@${'a'.repeat(55)}.${'b'.repeat(55)}.example.com`,
  }));
  await send('large-legal', { ...input, recipients });
  expect(data('large-legal').state).toBe('active');
  const page = await artifactShares(String(input.artifact_id), policy);
  expect(page.shares).toHaveLength(1);
  expect(page.shares[0].recipients).toEqual(recipients.map(({ email }) => email));
  expect(page.shares_next_cursor).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16 * 1024);
});
it('pins expiry at publication; later private extensions cannot extend the grant and reductions deny immediately', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  await getDb().run('UPDATE gws_ea_artifacts SET expires_at=?', expires);
  await send('expiry');
  const applied = data('expiry');
  expect(applied.expires_at).toBe(expires);
  await getDb().run('UPDATE gws_ea_artifacts SET expires_at=?', new Date(Date.now() + 3600000).toISOString());
  expect((await artifactShares(String(input.artifact_id), policy)).shares[0].expires_at).toBe(expires);
  await getDb().run('UPDATE gws_ea_artifact_shares SET expires_at=?', new Date(Date.now() - 1).toISOString());
  expect(await view(String(applied.share_id), 'share', 'juno@example.com')).toBeUndefined();
  expect(await artifactAdmissionEmails()).toEqual(['principal@example.com']);
});
async function seedApproval(requestId: string, text: string) {
  const source = prepareArtifactSource(Buffer.from(`<p>${text}</p>`));
  await saveArtifact(
    { agentGroupId: 'canonical', sessionId: main.id, isMain: true },
    { requestId: 'private-edit', action: 'save', fingerprint: 'private-edit' },
    { artifact_id: String(input.artifact_id), expected_revision: 1, title: 'Sensitive' },
    source,
  );
  await addPrivateValue({ kind: 'other', label: 'Secret', value: text });
  input = { ...input, revision: 2, expected_hash: source.source_hash };
  const canonical = parseArtifactShare(input);
  const authority = await authorizeArtifactShare(main, canonical);
  expect(authority.needsConfirmation).toBe(true);
  const shareId = '00000000-0000-4000-8000-000000000001';
  const payload = {
    input: canonical,
    scope_hash: authority.scopeHash,
    share_id: shareId,
    generation: 1,
    policy_hash: artifactDigest(policy),
  };
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    await getDb().run(
      "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,expires_at,principal_messaging_group_id,principal_message_id,scope_hash,created_at,updated_at) VALUES(?,?,'named',2,?,1,'pending',NULL,'chat','mark',?,?,?)",
      shareId,
      input.artifact_id as string,
      source.source_hash,
      authority.scopeHash,
      now,
      now,
    );
    await getDb().run(
      'INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)',
      shareId,
      'juno@example.com',
    );
    await getDb().run(
      "INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,source_hash,state,payload_json,created_at) VALUES(?,?,'canonical','share',?,?,'pending',?,?)",
      main.id,
      requestId,
      artifactDigest(canonical),
      source.source_hash,
      JSON.stringify(payload),
      now,
    );
  });
  await createPendingApproval({
    approval_id: 'approval',
    session_id: main.id,
    request_id: requestId,
    action: ARTIFACT_SHARE_APPROVAL,
    payload: JSON.stringify({ input: canonical, scope_hash: authority.scopeHash, reservation_request_id: requestId }),
    created_at: now,
    approver_user_id: 'gchat:principal',
    status: 'approved',
    title: 'Share',
    question: 'Exact source',
    options_json: '[]',
  });
  const approval = (await getPendingApprovalsByAction(ARTIFACT_SHARE_APPROVAL))[0];
  return { approval, payload: JSON.parse(approval.payload) as Record<string, unknown>, shareId };
}
it.each(['approve', 'wrong-principal', 'wrong-scope', 'reject'] as const)(
  'uses the live exact native approval grant and terminal response for %s',
  async (mode) => {
    const { approval, payload, shareId } = await seedApproval('confirmed', 'secret-raven-572');
    if (mode === 'reject') {
      const finalize = getApprovalRejectionFinalizer(ARTIFACT_SHARE_APPROVAL);
      if (!finalize) throw new Error('Missing rejection finalizer');
      await finalize({ approval, session: main, outcome: 'reject', userId: 'gchat:principal', reason: 'No' });
    } else {
      const handler = getApprovalHandler(ARTIFACT_SHARE_APPROVAL);
      if (!handler) throw new Error('Missing native handler');
      if (mode === 'wrong-scope') approval.payload = JSON.stringify({ ...payload, scope_hash: 'wrong' });
      await handler({
        session: main,
        payload,
        approval,
        userId: mode === 'wrong-principal' ? 'gchat:other' : 'gchat:principal',
        notify: async () => {},
      });
    }
    expect(response('confirmed'), JSON.stringify(response('confirmed'))).toMatchObject({ ok: mode === 'approve' });
    expect(await view(shareId, 'share', 'juno@example.com')).toEqual(
      mode === 'approve' ? expect.objectContaining({ title: 'Sensitive' }) : undefined,
    );
  },
);

it.each(['approve', 'reject', 'expiry'] as const)(
  'delivers a real native confirmation card and advances the native tool mailbox after %s',
  async (mode) => {
    const deliver = vi.fn(async () => 'posted-card');
    setDeliveryAdapter({ deliver });
    const secret = await addPrivateValue({ kind: 'other', label: 'Private fact', value: 'orchid-secret-481' });
    const source = prepareArtifactSource(Buffer.from('<p>orchid-secret-481</p>'));
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    await saveArtifact(
      { agentGroupId: 'canonical', sessionId: main.id, isMain: true },
      { requestId: 'sensitive', action: 'save', fingerprint: 'sensitive' },
      { artifact_id: String(input.artifact_id), expected_revision: 1, title: 'Sensitive' },
      source,
    );
    await send('native-held', { ...input, revision: 2, expected_hash: source.source_hash, expires_at: expiresAt });
    expect(response('native-held')).toBeUndefined();
    const approval = (await getPendingApprovalsByAction(ARTIFACT_SHARE_APPROVAL))[0];
    expect(approval).toMatchObject({ status: 'pending', approver_user_id: 'gchat:principal', expires_at: expiresAt });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(approval.question).toContain('Sensitive');
    expect(approval.question).toContain('saved version 2');
    expect(approval.question).toContain('private detail');
    expect(approval.question).not.toContain(secret.id);
    expect(approval.question).not.toContain(source.source_hash);
    expect(JSON.parse(approval.payload)).toMatchObject({ input: { expected_hash: source.source_hash } });
    expect(approval.question).toContain('juno@example.com');
    if (mode === 'expiry') await expireApproval(approval.approval_id, new Date(Date.now() + 120000).toISOString());
    else
      await handleApprovalsResponse({
        questionId: approval.approval_id,
        value: mode,
        userId: 'principal',
        channelType: 'gchat',
        platformId: 'chat',
        threadId: null,
      });
    expect(response('native-held')).toMatchObject({ ok: mode === 'approve' });
    expect(await getPendingApprovalsByAction(ARTIFACT_SHARE_APPROVAL)).toEqual([]);
    expect(await getDb().get("SELECT state FROM gws_ea_artifact_requests WHERE request_id='native-held'")).toEqual({
      state: 'settled',
    });
  },
);

it('advances bounded recovery past more than 32 held requests and resumes a later pending request', async () => {
  const seeded = await seedApproval('held-00', 'hidden-saffron-319');
  await getDb().run("UPDATE pending_approvals SET status='pending' WHERE approval_id='approval'");
  const original = await getDb().get<{ payload_json: string }>(
    "SELECT payload_json FROM gws_ea_artifact_requests WHERE request_id='held-00'",
  );
  if (!original) throw new Error('Missing pending fixture');
  const payload = JSON.parse(original.payload_json) as Record<string, unknown>;
  const now = new Date().toISOString();
  for (let index = 1; index <= 33; index++) {
    const id = `held-${String(index).padStart(2, '0')}`;
    const shareId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    await getDb().run(
      "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,scope_hash,created_at,updated_at) SELECT ?,artifact_id,kind,revision,source_hash,1,'pending',scope_hash,?,? FROM gws_ea_artifact_shares WHERE share_id=?",
      shareId,
      now,
      now,
      seeded.shareId,
    );
    await getDb().run(
      'INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)',
      shareId,
      'juno@example.com',
    );
    await getDb().run(
      "INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,source_hash,state,payload_json,created_at) SELECT session_id,?,actor_group_id,action,fingerprint,source_hash,'pending',?,created_at FROM gws_ea_artifact_requests WHERE request_id='held-00'",
      id,
      JSON.stringify({ ...payload, share_id: shareId }),
    );
    await createPendingApproval({
      ...seeded.approval,
      approval_id: `approval-${index}`,
      request_id: id,
      status: 'pending',
      payload: JSON.stringify({ ...seeded.payload, reservation_request_id: id }),
    });
  }
  const explicit = parseArtifactShare({
    ...input,
    private_value_ids: (await authorizeArtifactShare(main, parseArtifactShare(input))).privateValues.map(
      ({ id }) => id,
    ),
  });
  const authority = await authorizeArtifactShare(main, explicit);
  const shareId = '00000000-0000-4000-8000-999999999999';
  await getDb().run(
    "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,scope_hash,created_at,updated_at) VALUES(?,?,'named',2,?,1,'pending',?,?,?)",
    shareId,
    explicit.artifact_id,
    String(input.expected_hash),
    authority.scopeHash,
    now,
    now,
  );
  await getDb().run(
    'INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)',
    shareId,
    'juno@example.com',
  );
  await getDb().run(
    "INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,source_hash,state,payload_json,created_at) VALUES(?,'zz-resumable','canonical','share',?,?,'pending',?,?)",
    main.id,
    artifactDigest(explicit),
    String(input.expected_hash),
    JSON.stringify({
      input: explicit,
      scope_hash: authority.scopeHash,
      share_id: shareId,
      generation: 1,
      policy_hash: artifactDigest(policy),
    }),
    now,
  );
  const restarted = new ArtifactSharing({ verifyAdmission: remote, publicationReady: () => true });
  await restarted.recover();
  expect(response('zz-resumable')).toBeUndefined();
  await restarted.reconcile();
  expect(data('zz-resumable')).toMatchObject({ state: 'active', share_id: shareId });
  expect(remote).toHaveBeenCalledTimes(1);
});

it('keeps publication pending until the verified origin is listening and applies it on reconciliation', async () => {
  let ready = false;
  const delayed = new ArtifactSharing({ verifyAdmission: remote, publicationReady: () => ready });
  const { recipients: _recipients, ...base } = input;
  const publication = parseArtifactShare({ ...base, operation: 'public_publish' });
  await delayed.submit(main, 'waiting-origin', publication);
  expect(response('waiting-origin')).toBeUndefined();
  expect(await getDb().get('SELECT state FROM gws_ea_artifact_shares')).toEqual({ state: 'pending' });
  ready = true;
  await delayed.reconcile();
  expect(data('waiting-origin')).toMatchObject({ state: 'active' });
  expect(remote).not.toHaveBeenCalled();
});

it('settles an approved request honestly when its origin is unavailable instead of consuming a grant and leaving pending work', async () => {
  const { approval, payload, shareId } = await seedApproval('approved-unavailable', 'private-cedar-280');
  const unavailable = new ArtifactSharing({ verifyAdmission: remote, publicationReady: () => false });
  unavailable.registerApprovals();
  const handler = getApprovalHandler(ARTIFACT_SHARE_APPROVAL);
  if (!handler) throw new Error('Missing approval handler');
  await handler({ session: main, payload, approval, userId: 'gchat:principal', notify: async () => {} });
  expect(response('approved-unavailable')).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('origin is unavailable') },
  });
  expect(await getDb().get('SELECT state FROM gws_ea_artifact_shares WHERE share_id=?', shareId)).toEqual({
    state: 'revoked',
  });
  expect(
    await getDb().get("SELECT state FROM gws_ea_artifact_requests WHERE request_id='approved-unavailable'"),
  ).toEqual({ state: 'settled' });
  expect(remote).not.toHaveBeenCalled();
});

it('recovers missing historical mailbox answers in bounded advancing pages and preserves the original receipt after revocation', async () => {
  await send('zz-original');
  const original = data('zz-original');
  const stored = await getDb().get<{ result_json: string }>(
    "SELECT result_json FROM gws_ea_artifact_requests WHERE request_id='zz-original'",
  );
  if (!stored) throw new Error('Missing receipt');
  for (let index = 0; index < 35; index++) {
    const id = `aa-${String(index).padStart(2, '0')}`;
    const frame = { ...JSON.parse(stored.result_json), id };
    await getDb().run(
      "INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,state,result_json,created_at) VALUES(?,?,'canonical','share',?,'settled',?,?)",
      main.id,
      id,
      id,
      JSON.stringify(frame),
      new Date().toISOString(),
    );
  }
  await send('revoke-current', {
    operation: 'revoke',
    artifact_id: input.artifact_id,
    share_id: original.share_id,
    expected_generation: 1,
    principal_message: input.principal_message,
  });
  const mailbox = new Database(inboundDbPath(main.agent_group_id, main.id));
  mailbox.prepare("DELETE FROM messages_in WHERE id='action-resp-zz-original'").run();
  mailbox.close();
  const restarted = new ArtifactSharing({ verifyAdmission: remote, publicationReady: () => true });
  await restarted.recover();
  expect(response('zz-original')).toBeUndefined();
  expect(response('aa-31')).toMatchObject({ ok: true });
  expect(response('aa-32')).toBeUndefined();
  await restarted.reconcile();
  expect(data('zz-original')).toMatchObject({
    state: 'active',
    current_access: { state: 'revoked', generation: 2, usable: false },
  });
  expect(await getDb().get("SELECT result_json FROM gws_ea_artifact_requests WHERE request_id='zz-original'")).toEqual(
    stored,
  );
});
