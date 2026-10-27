import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const ROOT = await vi.hoisted(async () => {
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(realpathSync(tmpdir()), `artifact-authority-${process.pid}`);
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingApproval, getPendingApproval, createSession } from '../../db/sessions.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { guard } from '../../guard/index.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { recordChatClearances } from '../gws-ea-privacy/clearance.js';
import { upsertUser } from '../permissions/db/users.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { artifactShareAction, authorizeArtifactShare, parseArtifactShare } from './authority.js';
import { artifactDigest, prepareArtifactSource, saveArtifact } from './db.js';
import type { Session } from '../../types.js';
let main: Session;
let input: Record<string, unknown>;
beforeEach(async () => {
  fs.mkdirSync(ROOT, { recursive: true });
  const policy = path.join(ROOT, 'policy.json');
  fs.writeFileSync(
    policy,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      hostname: 'aya.example.com',
      listenPort: 9123,
      accessIssuer: 'https://team.cloudflareaccess.com',
      accessAud: 'aud',
      cloudflare: { accountId: 'a', applicationId: 'b', operatorConfigFile: '/private/tmp/cf.json' },
    }),
    { mode: 0o600 },
  );
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', policy);
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  for (const id of ['canonical', 'worker']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
    await ensureContainerConfig(id);
    await updateContainerConfigJson(id, 'capabilities', ['artifacts']);
  }
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name='Aya',principal_first_name='Morgan',main_agent_group_id='canonical' WHERE singleton=1",
  );
  main = {
    id: 'main-session',
    agent_group_id: 'canonical',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    created_at: now,
    last_active: now,
  };
  await createSession(main);
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
    'INSERT INTO gws_ea_principal_messages(message_id,messaging_group_id,user_id,timestamp,text) VALUES(?,?,?,?,?)',
    'mark',
    'chat',
    'gchat:principal',
    now,
    'Share this report with Juno.',
  );
  await upsertUserDm({
    user_id: 'gchat:principal',
    channel_type: 'gchat',
    messaging_group_id: 'chat',
    resolved_at: now,
  });
  const source = prepareArtifactSource(Buffer.from('<p>Public facts</p>'));
  const saved = await saveArtifact(
    { agentGroupId: 'canonical', sessionId: main.id, isMain: true },
    { requestId: 'create', action: 'save', fingerprint: 'create' },
    { create_key: 'report', title: 'Report' },
    source,
  );
  input = {
    operation: 'named_publish',
    artifact_id: saved.artifact_id,
    revision: 1,
    expected_hash: source.source_hash,
    recipients: [{ email: 'Juno@Example.com', name: 'Juno' }],
    principal_message: { id: 'mark', messaging_group_id: 'chat' },
  };
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
it('accepts main’s explicit scoped instruction, canonicalizes exact emails and binds every scope field', async () => {
  const first = await authorizeArtifactShare(main, parseArtifactShare(input));
  expect(first.needsConfirmation).toBe(false);
  expect(first.input).toMatchObject({ recipients: [{ email: 'juno@example.com', name: 'Juno' }] });
  for (const change of [
    { recipients: [{ email: 'other@example.com', name: 'Juno' }] },
    { recipients: [{ email: 'juno@example.com', name: 'Someone' }] },
    { expires_at: '2099-01-01T00:00:00.000Z' },
    { private_value_ids: ['value-id'] },
  ]) {
    const changed = await authorizeArtifactShare(main, parseArtifactShare({ ...input, ...change }));
    expect(changed.scopeHash).not.toBe(first.scopeHash);
  }
});
it('refuses spoofed fields, stale or foreign marks, wrong source hashes, and non-main sessions', async () => {
  for (const id of ['', ' ', 'x'.repeat(1025), 'message\nforged', 'message\u009b'])
    expect(() => parseArtifactShare({ ...input, principal_message: { id, messaging_group_id: 'chat' } })).toThrow(
      'principal message ID',
    );
  expect(() => parseArtifactShare({ ...input, author_group_id: 'canonical' })).toThrow('Unexpected');
  await expect(
    authorizeArtifactShare(main, parseArtifactShare({ ...input, expected_hash: 'f'.repeat(64) })),
  ).rejects.toThrow('hash');
  await expect(
    authorizeArtifactShare(
      main,
      parseArtifactShare({ ...input, principal_message: { id: 'mark', messaging_group_id: 'elsewhere' } }),
    ),
  ).rejects.toThrow('principal');
  await getDb().run('UPDATE gws_ea_principal_messages SET timestamp=?', '2000-01-01T00:00:00.000Z');
  await expect(authorizeArtifactShare(main, parseArtifactShare(input))).rejects.toThrow('principal');
  await expect(
    authorizeArtifactShare({ ...main, agent_group_id: 'worker' }, parseArtifactShare(input)),
  ).rejects.toThrow('main');
});
it('checks full HTML and immutable title without inheriting chat clearance; exact explicit private-value instruction avoids a second card', async () => {
  const value = await addPrivateValue({ kind: 'address', label: 'Home', value: '12 Elm Road' });
  const now = new Date().toISOString();
  await getDb().run(
    "INSERT INTO gws_ea_chats(messaging_group_id,state,serving_agent_group_id,principal_present,created_at,updated_at) VALUES('chat','connected','canonical',1,?,?)",
    now,
    now,
  );
  await recordChatClearances({ messagingGroupId: 'chat', principalMessageId: 'mark', values: [value] });
  const source = prepareArtifactSource(Buffer.from('<div data-location="12 Elm R&#111;ad"></div>'));
  const saved = await saveArtifact(
    { agentGroupId: 'canonical', sessionId: main.id, isMain: true },
    { requestId: 'revision', action: 'save', fingerprint: 'revision' },
    { artifact_id: String(input.artifact_id), expected_revision: 1, title: 'Report' },
    source,
  );
  const share = parseArtifactShare({ ...input, revision: saved.revision, expected_hash: source.source_hash });
  const held = await authorizeArtifactShare(main, share);
  expect(held.privateValues).toEqual([{ id: value.id, kind: 'address' }]);
  const actor = { kind: 'agent' as const, agentGroupId: main.agent_group_id, sessionId: main.id };
  expect(
    (await guard(artifactShareAction, { actor, payload: { input: share, scope_hash: held.scopeHash } })).effect,
  ).toBe('hold');
  const explicit = parseArtifactShare({ ...share, private_value_ids: [value.id] });
  const authorized = await authorizeArtifactShare(main, explicit);
  expect(
    (await guard(artifactShareAction, { actor, payload: { input: explicit, scope_hash: authorized.scopeHash } }))
      .effect,
  ).toBe('allow');
  expect(
    (await guard(artifactShareAction, { actor, payload: { input: explicit, scope_hash: held.scopeHash } })).effect,
  ).toBe('deny');
});
it('reauthorizes only its own journaled pending replacement and refuses revoke or a foreign generation', async () => {
  const shareId = 'prior-share';
  const now = new Date().toISOString();
  await getDb().run(
    "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,scope_hash,created_at,updated_at) VALUES(?,?,'named',1,?,1,'active','prior',?,?)",
    shareId,
    String(input.artifact_id),
    String(input.expected_hash),
    now,
    now,
  );
  const replacement = parseArtifactShare({
    ...input,
    operation: 'named_replace',
    share_id: shareId,
    expected_generation: 1,
  });
  const authorized = await authorizeArtifactShare(main, replacement);
  await getDb().run(
    "UPDATE gws_ea_artifact_shares SET generation=2,state='pending',scope_hash=? WHERE share_id=?",
    authorized.scopeHash,
    shareId,
  );
  await getDb().run(
    'INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)',
    shareId,
    'juno@example.com',
  );
  const payload = { input: replacement, scope_hash: authorized.scopeHash, share_id: shareId, generation: 2 };
  await getDb().run(
    "INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,source_hash,state,payload_json,created_at) VALUES(?,?,?,'share',?,?,'pending',?,?)",
    main.id,
    'reserved',
    'canonical',
    artifactDigest(replacement),
    String(input.expected_hash),
    JSON.stringify(payload),
    now,
  );
  expect((await authorizeArtifactShare(main, replacement, { requestId: 'reserved' })).scopeHash).toBe(
    authorized.scopeHash,
  );
  const actor = { kind: 'agent' as const, agentGroupId: 'canonical', sessionId: main.id };
  expect(
    (
      await guard(artifactShareAction, {
        actor,
        payload: { input: replacement, scope_hash: authorized.scopeHash, reservation_request_id: 'reserved' },
      })
    ).effect,
  ).toBe('allow');
  await getDb().run('UPDATE gws_ea_artifact_shares SET generation=3 WHERE share_id=?', shareId);
  await expect(authorizeArtifactShare(main, replacement, { requestId: 'reserved' })).rejects.toThrow('changed');
  await getDb().run("UPDATE gws_ea_artifact_shares SET generation=2,state='revoked' WHERE share_id=?", shareId);
  await expect(authorizeArtifactShare(main, replacement, { requestId: 'reserved' })).rejects.toThrow('revoked');
});
it('binds native private-value approval grants to the exact scope and current mark', async () => {
  await addPrivateValue({ kind: 'other', label: 'Confidential', value: 'Public facts' });
  const share = parseArtifactShare(input);
  const authorized = await authorizeArtifactShare(main, share);
  const actor = { kind: 'agent' as const, agentGroupId: 'canonical', sessionId: main.id };
  await createPendingApproval({
    approval_id: 'approval',
    session_id: main.id,
    request_id: 'share-request',
    action: 'artifact_share_private_values',
    payload: JSON.stringify({ scope_hash: authorized.scopeHash }),
    created_at: new Date().toISOString(),
    title: 'Share details?',
    options_json: '[]',
  });
  const grant = await getPendingApproval('approval');
  expect(
    (await guard(artifactShareAction, { actor, payload: { input: share, scope_hash: authorized.scopeHash }, grant }))
      .effect,
  ).toBe('allow');
  const other = parseArtifactShare({ ...input, recipients: [{ email: 'other@example.com' }] });
  const changed = await authorizeArtifactShare(main, other);
  expect(
    (await guard(artifactShareAction, { actor, payload: { input: other, scope_hash: changed.scopeHash }, grant }))
      .effect,
  ).toBe('deny');
  await getDb().run("DELETE FROM gws_ea_principal_messages WHERE message_id='mark'");
  expect(
    (await guard(artifactShareAction, { actor, payload: { input: share, scope_hash: authorized.scopeHash }, grant }))
      .effect,
  ).toBe('deny');
});
it('reads the selected revision title and exempts only exact current principal recipients', async () => {
  const value = await addPrivateValue({ kind: 'address', label: 'Home', value: '12 Elm Road' });
  const actor = { agentGroupId: 'canonical', sessionId: main.id, isMain: true };
  const source = prepareArtifactSource(Buffer.from('<p>Ordinary facts</p>'));
  await saveArtifact(
    actor,
    { requestId: 'private-title', action: 'save', fingerprint: 'private-title' },
    { artifact_id: String(input.artifact_id), expected_revision: 1, title: '12 Elm Road' },
    source,
  );
  await saveArtifact(
    actor,
    { requestId: 'new-title', action: 'save', fingerprint: 'new-title' },
    { artifact_id: String(input.artifact_id), expected_revision: 2, title: 'New title' },
    source,
  );
  const named = parseArtifactShare({ ...input, revision: 2, expected_hash: source.source_hash });
  expect((await authorizeArtifactShare(main, named)).privateValues).toEqual([{ id: value.id, kind: 'address' }]);
  const now = new Date().toISOString();
  await getDb().run('INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)', 'principal@example.com', now);
  expect(
    (
      await authorizeArtifactShare(
        main,
        parseArtifactShare({ ...named, recipients: [{ email: 'principal@example.com' }] }),
      )
    ).privateValues,
  ).toEqual([]);
  expect(
    (
      await authorizeArtifactShare(
        main,
        parseArtifactShare({ ...named, recipients: [{ email: 'principal+tag@example.com' }] }),
      )
    ).needsConfirmation,
  ).toBe(true);
  const { recipients: _recipients, ...publication } =
    named.operation === 'named_publish' ? named : { recipients: [], ...named };
  expect(
    (await authorizeArtifactShare(main, parseArtifactShare({ ...publication, operation: 'public_publish' })))
      .needsConfirmation,
  ).toBe(true);
});

it('permits a fresh explicit public replacement of the stable revoked slot while refusing reserved resurrection', async () => {
  const now = new Date().toISOString();
  await getDb().run(
    "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,scope_hash,created_at,updated_at) VALUES('stable-public',?,'public',1,?,2,'revoked','old',?,?)",
    String(input.artifact_id),
    String(input.expected_hash),
    now,
    now,
  );
  const { recipients: _recipients, ...base } = input;
  const replacement = parseArtifactShare({
    ...base,
    operation: 'public_replace',
    share_id: 'stable-public',
    expected_generation: 2,
  });
  expect((await authorizeArtifactShare(main, replacement)).revision?.revision).toBe(1);
  await expect(authorizeArtifactShare(main, replacement, { requestId: 'missing' })).rejects.toThrow('not pending');
});
